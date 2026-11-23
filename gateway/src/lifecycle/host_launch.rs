use anyhow::{Context, Result, ensure};
use nix::{
    sys::signal::{Signal, kill},
    unistd::Pid,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    env,
    ffi::OsString,
    fs::{self, DirBuilder, File},
    os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt},
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::{Child, ChildStdin, ChildStdout, Command},
    task::JoinHandle,
    time::{Instant, sleep, timeout, timeout_at},
};
use uuid::Uuid;

use super::{
    LifecycleConfig, config::RESTART_CONFIG_ENV, fs as owned,
    host_rpc::Probe,
    process::{ChildKind, detached, host_owner_executable},
    rotation::{self, Rotation},
    stock_ops::{OUTPUT_LIMIT, bun, inspect_omp, session_id},
    ulw::Ulw,
};
use crate::store::Store;

const START_TIMEOUT: Duration = Duration::from_secs(30);
const START_POLL: Duration = Duration::from_millis(50);

pub(super) struct PreparedHost {
    environment: BTreeMap<OsString, OsString>,
    files: LaunchFiles,
    log: File,
    deadline: Instant,
    session_id: Option<String>,
}

pub(super) struct LaunchedHost {
    files: LaunchFiles,
    child: Child,
    pub pid: u32,
    deadline: Instant,
    session_id: Option<String>,
}

struct LaunchFiles {
    directory: PathBuf,
    owned_by_child: bool,
}

impl LaunchFiles {
    fn cleanup(&self) {
        if let Err(error) = fs::remove_dir_all(&self.directory) {
            eprintln!("HEAD launch directory cleanup failed: {}", error.kind());
        }
    }
}

impl Drop for LaunchFiles {
    fn drop(&mut self) {
        if !self.owned_by_child {
            self.cleanup();
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedSettings {
    settings: Value,
    cleared_roles: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Discovery {
    extension_paths: Vec<PathBuf>,
    no_extensions: bool,
    memory_write_dir: Option<PathBuf>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Preparation {
    tools_explicitly_selected: bool,
    no_tools: bool,
    inventory: Option<Value>,
}

struct HeadLaunch {
    package: PathBuf,
    extensions: [PathBuf; 5],
    environment: BTreeMap<OsString, OsString>,
}

struct LaunchHelper {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: ChildStdout,
    stderr_drain: JoinHandle<()>,
    leftover: Vec<u8>,
    phase1_deadline: Instant,
    discovery: Discovery,
}

impl Drop for LaunchHelper {
    fn drop(&mut self) {
        self.stderr_drain.abort();
    }
}

async fn kill_wait(child: &mut Child, stderr_drain: &mut JoinHandle<()>) {
    let _ = child.kill().await;
    let _ = child.wait().await;
    let _ = stderr_drain.await;
}

impl LaunchHelper {
    async fn start(
        mut command: Command,
        input: &Value,
        phase1_timeout: Duration,
    ) -> Result<Self> {
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .context("Could not start Host SDK launch helper")?;
        let mut stdin = child
            .stdin
            .take()
            .context("Host SDK launch input was not piped")?;
        let mut stdout = child
            .stdout
            .take()
            .context("Host SDK launch output was not piped")?;
        let stderr = child
            .stderr
            .take()
            .context("Host SDK launch stderr was not piped")?;
        // Drain stderr concurrently up to OUTPUT_LIMIT so private child output
        // never stalls the helper pipe or enters logs.
        let mut stderr_drain = tokio::spawn(async move {
            let _ = tokio::io::copy(&mut stderr.take(OUTPUT_LIMIT), &mut tokio::io::sink()).await;
        });

        let phase1_deadline = Instant::now() + phase1_timeout;
        let mut discovery_line = serde_json::to_vec(input)?;
        discovery_line.push(b'\n');

        let outcome = timeout_at(phase1_deadline, async {
            stdin.write_all(&discovery_line).await?;
            stdin.flush().await?;
            let mut buffer = Vec::new();
            let mut scan_from = 0usize;
            let mut chunk = [0u8; 4096];
            loop {
                while let Some(rel_nl) = buffer[scan_from..].iter().position(|&byte| byte == b'\n') {
                    let line_end = scan_from + rel_nl;
                    let line = buffer[scan_from..line_end]
                        .strip_suffix(b"\r")
                        .unwrap_or(&buffer[scan_from..line_end]);
                    if let Some(payload) = line.strip_prefix(b"MANAGED_ULW_LAUNCH ") {
                        let discovery: Discovery = serde_json::from_slice(payload)?;
                        let leftover = buffer.split_off(line_end + 1);
                        return Ok::<_, anyhow::Error>(Ok((discovery, leftover)));
                    }
                    if let Some(payload) = line.strip_prefix(b"MANAGED_ULW_LAUNCH_ERROR ") {
                        let message: String = serde_json::from_slice(payload)?;
                        return Ok(Err(anyhow::anyhow!(message)));
                    }
                    scan_from = line_end + 1;
                }
                let read = stdout.read(&mut chunk).await?;
                if read == 0 {
                    return Ok(Err(anyhow::anyhow!(
                        "Stock OMP discovery did not return a launch composition"
                    )));
                }
                let next_len = buffer.len().saturating_add(read);
                ensure!(
                    u64::try_from(next_len)? <= OUTPUT_LIMIT,
                    "Stock OMP discovery output exceeded its bound"
                );
                buffer.extend_from_slice(&chunk[..read]);
            }
        })
        .await;

        match outcome {
            Err(_) => {
                drop(stdin);
                kill_wait(&mut child, &mut stderr_drain).await;
                anyhow::bail!("Native launch discovery timed out");
            }
            Ok(Err(error)) => {
                drop(stdin);
                kill_wait(&mut child, &mut stderr_drain).await;
                Err(error)
            }
            Ok(Ok(Err(error))) => {
                drop(stdin);
                if timeout(Duration::from_secs(1), child.wait()).await.is_err() {
                    let _ = child.kill().await;
                    let _ = child.wait().await;
                }
                let _ = (&mut stderr_drain).await;
                Err(error)
            }
            Ok(Ok(Ok((discovery, leftover)))) => Ok(Self {
                child,
                stdin: Some(stdin),
                stdout,
                stderr_drain,
                leftover,
                phase1_deadline,
                discovery,
            }),
        }
    }

    async fn finish_discovery(mut self) -> Result<Discovery> {
        // Closing stdin without writing a manifest selects discovery-only EOF mode.
        drop(self.stdin.take());
        match timeout_at(self.phase1_deadline, self.child.wait()).await {
            Err(_) => {
                kill_wait(&mut self.child, &mut self.stderr_drain).await;
                anyhow::bail!("Native launch discovery timed out");
            }
            Ok(Err(error)) => {
                kill_wait(&mut self.child, &mut self.stderr_drain).await;
                Err(error.into())
            }
            Ok(Ok(status)) => {
                let _ = (&mut self.stderr_drain).await;
                ensure!(
                    status.success(),
                    "Stock OMP operation failed; private diagnostics suppressed"
                );
                Ok(std::mem::replace(
                    &mut self.discovery,
                    Discovery {
                        extension_paths: Vec::new(),
                        no_extensions: false,
                        memory_write_dir: None,
                    },
                ))
            }
        }
    }

    async fn prepare(mut self, payload: &[u8], phase2_timeout: Duration) -> Result<(Instant, Preparation)> {
        let deadline = Instant::now() + phase2_timeout;
        let outcome = timeout_at(deadline, async {
            let mut stdin = self
                .stdin
                .take()
                .context("Host SDK launch input was already closed")?;
            stdin.write_all(payload).await?;
            stdin.flush().await?;
            drop(stdin);

            let mut chunk = [0u8; 4096];
            loop {
                let read = self.stdout.read(&mut chunk).await?;
                if read == 0 {
                    break;
                }
                let next_len = self.leftover.len().saturating_add(read);
                ensure!(
                    u64::try_from(next_len)? <= OUTPUT_LIMIT,
                    "Stock OMP output exceeded its bound"
                );
                self.leftover.extend_from_slice(&chunk[..read]);
            }
            let status = self.child.wait().await?;
            let _ = (&mut self.stderr_drain).await;
            ensure!(
                status.success(),
                "Stock OMP operation failed; private diagnostics suppressed"
            );
            Ok::<_, anyhow::Error>(())
        })
        .await;

        match outcome {
            Err(_) => {
                kill_wait(&mut self.child, &mut self.stderr_drain).await;
                anyhow::bail!("Native session preparation timed out");
            }
            Ok(Err(error)) => {
                kill_wait(&mut self.child, &mut self.stderr_drain).await;
                Err(error)
            }
            Ok(Ok(())) => {
                let flags: Preparation = serde_json::from_slice(&self.leftover)
                    .context("Native session preparation did not confirm tool selection")?;
                Ok((deadline, flags))
            }
        }
    }
}

impl HeadLaunch {
    fn new(config: &LifecycleConfig, ulw: &Ulw) -> Result<Self> {
        let package = ulw.package()?;
        let source = config.root.join("src");
        let extension = match env::var_os("OMP_SUPERAGENT_TEST_EXTENSION_PATH") {
            Some(path) if ulw.fixture() => PathBuf::from(path),
            _ => source.join("extension.ts"),
        };
        ensure!(
            extension.is_absolute(),
            "Host extension must have an explicit absolute path"
        );
        let extensions = [
            config.root.clone(),
            package.clone(),
            extension,
            source.join("board-extension.ts"),
            source.join("host-extension.ts"),
        ];
        host_owner_executable(&config.root)?;
        let mut environment = config.head_environment();
        environment.insert(
            "OMP_SUPERAGENT_CONFIG".into(),
            config.path.as_os_str().to_os_string(),
        );
        environment.insert("OMP_SUPERAGENT_ROLE".into(), "head".into());
        environment.insert(
            "OMP_SUPERAGENT_MANAGED_ULW_PATH".into(),
            package.as_os_str().to_os_string(),
        );
        Ok(Self { package, extensions, environment })
    }

    async fn start_launch(&self, config: &LifecycleConfig, files: (Option<&Path>, &Path)) -> Result<LaunchHelper> {
        let default_args = host_args(config, files, &self.extensions, false);
        let (_, prefix) = config.command.split_first().context("No OMP executable provided")?;
        let input = json!({
            "cwd": config.cwd, "managedUlwPath": self.package, "extensionPaths": self.extensions,
            "commandArgs": prefix, "launchArgs": prefix.iter().chain(default_args.iter()).collect::<Vec<_>>(),
        });
        let mut launch = bun(config, &self.environment);
        launch.arg(config.root.join("src/host-sdk-helper.ts")).arg("launch");
        LaunchHelper::start(launch, &input, START_TIMEOUT).await
    }

    async fn discover(&self, config: &LifecycleConfig, files: (Option<&Path>, &Path)) -> Result<Discovery> {
        self.start_launch(config, files).await?.finish_discovery().await
    }
}

/// On the fallback path, validate the same operator flags and extension roots as the
/// real HEAD launch. Its generated overlay carries model/task/goal settings only.
pub(super) async fn ensure_launchable_memory(config: &LifecycleConfig, ulw: &Ulw) -> Result<()> {
    if !config.memory_enabled().await? {
        HeadLaunch::new(config, ulw)?.discover(config, (None, &config.head_session)).await?;
    }
    Ok(())
}

impl PreparedHost {
    pub async fn prepare(config: &LifecycleConfig, store: &Store, ulw: &Ulw, rotation: Option<&Rotation>) -> Result<Self> {
        let launch = HeadLaunch::new(config, ulw)?;
        let source = config.root.join("src");
        let session_file = rotation::session_file(config, store)?;
        if session_file != config.head_session {
            // Rotated sessions live under a unique trusted directory, never
            // under a reused journal pathname or a symlink.
            owned::private_directory(config.head_session.parent().context("HEAD session directory missing")?)?;
            owned::private_directory(&config.state_dir.join("sessions/main/rotated"))?;
        }
        owned::private_directory(session_file.parent().context("HEAD session directory missing")?)?;
        let restoring = owned::metadata(&session_file)?.is_some();
        let mut expected_id = if restoring { session_id(config, &session_file).await? } else { None };
        if let Some(expected) = store
            .get_meta("main:sessionId")?
            .filter(|id| !id.is_empty())
        {
            ensure!(
                expected_id.as_deref() == Some(expected.as_str()),
                "Stored head settings belong to a different native session; refusing startup"
            );
        }
        let settings_key = rotation.map(|plan| &plan.original.session_id).or(expected_id.as_ref());
        let mut settings = match settings_key {
            Some(id) => store
                .get_meta(&format!("head:model-settings:{id}"))?
                .map(|value| serde_json::from_str::<SavedSettings>(&value))
                .transpose()?,
            None => None,
        };
        if let Some(plan) = rotation {
            settings = Some(SavedSettings {
                settings: plan.attestation.selection.model_settings.clone(),
                cleared_roles: settings.map_or_else(Vec::new, |previous| previous.cleared_roles),
            });
        }
        ensure!(
            owned::metadata(&config.head_socket)?.is_none(),
            "Existing HEAD endpoint requires explicit adoption"
        );
        let (command, backend) = inspect_omp(config, &launch.environment).await?;
        let run_dir = config
            .head_socket
            .parent()
            .context("Host run directory missing")?;
        let launch_dir = run_dir.join(format!(".launch-{}", Uuid::new_v4()));
        DirBuilder::new().mode(0o700).create(&launch_dir)?;
        let files = LaunchFiles {
            directory: launch_dir,
            owned_by_child: false,
        };
        let config_path = files.directory.join("config.json");
        let log = owned::log(&config.head_log)?;
        let config_data = settings_config(config, settings.as_ref(), restoring)?;
        owned::private_json(&config_path, &config_data)?;
        let launch_helper = launch.start_launch(config, (Some(&config_path), &session_file)).await?;
        let HeadLaunch { package, mut environment, .. } = launch;
        let args = host_args(
            config,
            (Some(&config_path), &session_file),
            &launch_helper.discovery.extension_paths,
            launch_helper.discovery.no_extensions,
        );
        let socket_id = Uuid::new_v4().simple().to_string();
        let native_socket = run_dir.join(format!(".n-{}.sock", &socket_id[..8]));
        let helper = source.join("host-sdk-helper.ts");
        let mut manifest = json!({
            "options": { "command": command, "cwd": config.cwd, "sessionFile": session_file, "managedUlwPath": package,
                "socketPath": config.head_socket, "modelSettings": settings.as_ref().map(|saved| &saved.settings) },
            "args": args, "configPath": config_path, "memoryWriteDir": launch_helper.discovery.memory_write_dir, "processBackend": backend,
            "helperPath": helper, "nativeSocket": native_socket,
        });
        if let Some(plan) = rotation {
            manifest["headRotationSelection"] = serde_json::to_value(&plan.attestation.selection)?;
        }
        let payload = serde_json::to_vec(&manifest)?;
        let (deadline, flags) = launch_helper.prepare(&payload, START_TIMEOUT).await?;
        manifest["toolsExplicitlySelected"] = json!(flags.tools_explicitly_selected);
        manifest["noTools"] = json!(flags.no_tools);
        manifest["inventory"] = json!(flags.inventory);
        if let Some(plan) = rotation {
            expected_id = session_id(config, &session_file).await?;
            ensure!(expected_id.as_ref().is_some_and(|id| id != &plan.original.session_id),
                "Fresh native HEAD identity was not prepared");
        }
        owned::private_json(&files.directory.join("owner.json"), &manifest)?;
        let token = store.token()?;
        environment.insert("OMP_SUPERAGENT_GATEWAY_TOKEN".into(), token.into());
        Ok(Self {
            environment,
            files,
            log,
            deadline,
            session_id: expected_id,
        })
    }

    pub fn expected_session_id(&self) -> Option<&str> {
        self.session_id.as_deref()
    }

    pub fn spawn(
        mut self,
        config: &LifecycleConfig,
        restart_config_hash: Option<&str>,
    ) -> Result<LaunchedHost> {
        ensure!(
            Instant::now() < self.deadline,
            "Native Host startup timed out before launch"
        );
        if let Some(hash) = restart_config_hash {
            self.environment.insert(RESTART_CONFIG_ENV.into(), hash.into());
        }
        let mut command = detached(ChildKind::HeadOwner, &self.log)?;
        command
            .arg(self.files.directory.join("owner.json"))
            .current_dir(&config.cwd)
            .env_clear()
            .envs(self.environment);
        let child = Command::from(command)
            .spawn()
            .context("Could not spawn owned Host process")?;
        // The owner needs the manifest for an exit proof even if the Gateway
        // disappears. After spawn only a confirmed owner exit may clean it.
        self.files.owned_by_child = true;
        let pid = child
            .id()
            .context("Launched Host has no process identity")?;
        Ok(LaunchedHost {
            files: self.files,
            child,
            pid,
            deadline: self.deadline,
            session_id: self.session_id,
        })
    }
}

impl LaunchedHost {
    pub async fn identify(&mut self, config: &LifecycleConfig, session_file: &Path) -> Result<Probe> {
        let mut observed_socket = None;
        while Instant::now() < self.deadline {
            ensure!(
                self.child.try_wait()?.is_none(),
                "Owned OMP host exited during startup; inspect private log"
            );
            if let Some(stat) = owned::metadata(&config.head_socket)? {
                ensure!(
                    stat.file_type().is_socket() && stat.uid() == nix::unistd::getuid().as_raw(),
                    "Launched RPC endpoint is not an owned socket"
                );
                let inode = (stat.dev(), stat.ino());
                ensure!(
                    *observed_socket.get_or_insert(inode) == inode,
                    "Launched RPC socket changed"
                );
                if stat.mode() & 0o777 == 0o600 {
                    let probe = Probe::open(
                        &config.head_socket,
                        session_file,
                        self.deadline.saturating_duration_since(Instant::now()),
                    )
                    .await?;
                    let head = &probe.head;
                    ensure!(
                        (head.dev, head.ino) == inode && head.owner_pid == self.pid,
                        "Endpoint does not belong to the launched pipe owner"
                    );
                    ensure!(
                        self.session_id
                            .as_ref()
                            .is_none_or(|id| id == &head.session_id),
                        "Launched host resumed a different session identity"
                    );
                    ensure!(
                        self.child.try_wait()?.is_none(),
                        "Owned OMP host exited during startup; inspect private log"
                    );
                    return Ok(probe);
                }
            } else {
                ensure!(
                    observed_socket.is_none(),
                    "Launched RPC socket disappeared during startup"
                );
            }
            sleep(START_POLL).await;
        }
        anyhow::bail!("OMP host startup timed out; inspect private log")
    }

    pub fn reap(self) {
        let Self {
            files, mut child, ..
        } = self;
        tokio::spawn(async move {
            if child.wait().await.is_ok() {
                files.cleanup();
            } else {
                eprintln!("Could not reap the owned HEAD pipe process");
            }
        });
    }

    pub async fn abandon(self) -> Result<()> {
        let Self {
            files,
            mut child,
            pid,
            ..
        } = self;
        if child.try_wait()?.is_none() {
            let result = kill(Pid::from_raw(i32::try_from(pid)?), Signal::SIGTERM);
            if let Err(error) = result {
                if error != nix::errno::Errno::ESRCH {
                    return Err(error.into());
                }
            }
            match timeout(Duration::from_secs(1), child.wait()).await {
                Ok(exit) => {
                    exit?;
                }
                Err(_) => child.kill().await?,
            }
        }
        files.cleanup();
        Ok(())
    }
}

fn settings_config(
    config: &LifecycleConfig,
    settings: Option<&SavedSettings>,
    restoring: bool,
) -> Result<Value> {
    let mut output = json!({"task": {"maxConcurrency": config.concurrency}, "goal": {"continuationModes": ["rpc"]}});
    if let Some(saved) = settings {
        let roles = saved.settings["modelRoles"]
            .as_object()
            .context("Saved model settings have no model roles")?;
        let mut merged: serde_json::Map<_, _> = saved
            .cleared_roles
            .iter()
            .cloned()
            .map(|key| (key, Value::Null))
            .collect();
        merged.extend(roles.clone());
        output["modelRoles"] = Value::Object(merged);
        if let Some(thinking) = saved.settings.get("defaultThinkingLevel") {
            output["defaultThinkingLevel"] = thinking.clone();
        }
    } else if !restoring && let Some(model) = &config.model {
        output["modelRoles"] = json!({ "default": model });
    }
    Ok(output)
}

fn host_args(
    config: &LifecycleConfig,
    files: (Option<&Path>, &Path),
    extensions: &[PathBuf],
    no_extensions: bool,
) -> Vec<String> {
    let mut args = vec![
        "--mode".into(),
        "rpc-ui".into(),
        "--session".into(),
        files.1.to_string_lossy().into_owned(),
        "--cwd".into(),
        config.cwd.to_string_lossy().into_owned(),
    ];
    if no_extensions {
        args.push("--no-extensions".into());
    }
    for extension in extensions {
        args.extend(["-e".into(), extension.to_string_lossy().into_owned()]);
    }
    if let Some(overlay) = files.0 {
        args.extend(["--config".into(), overlay.to_string_lossy().into_owned()]);
    }
    args
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use tempfile::tempdir;

    fn mock_launch_command(script: &Path) -> Command {
        Command::new(script)
    }

    fn write_script(dir: &Path, name: &str, body: &str) -> PathBuf {
        let path = dir.join(name);
        fs::write(&path, format!("#!/bin/sh\nset -eu\n{body}\n")).unwrap();
        let mut perms = fs::metadata(&path).unwrap().permissions();
        perms.set_mode(0o700);
        fs::set_permissions(&path, perms).unwrap();
        path
    }

    #[tokio::test]
    async fn launch_helper_supports_discovery_only_prepare_errors_and_phase_timeout() {
        let tmp = tempdir().unwrap();

        let discovery_only = write_script(
            tmp.path(),
            "discovery-only.sh",
            r#"
IFS= read -r _input
printf '\nMANAGED_ULW_LAUNCH {"extensionPaths":["/ext/a"],"noExtensions":true,"memoryWriteDir":"/mem"}\n'
rest=$(cat)
if [ -n "$rest" ]; then exit 9; fi
"#,
        );
        let helper = LaunchHelper::start(mock_launch_command(&discovery_only), &json!({"ok":true}), Duration::from_secs(5))
            .await
            .unwrap();
        let discovery = helper.finish_discovery().await.unwrap();
        assert_eq!(discovery.extension_paths, vec![PathBuf::from("/ext/a")]);
        assert!(discovery.no_extensions);
        assert_eq!(discovery.memory_write_dir, Some(PathBuf::from("/mem")));

        let full_prepare = write_script(
            tmp.path(),
            "full-prepare.sh",
            r#"
IFS= read -r _input
printf '\nMANAGED_ULW_LAUNCH {"extensionPaths":[],"noExtensions":false,"memoryWriteDir":null}\n{"toolsExplicitlySelected":true,'
rest=$(cat)
case "$rest" in
  *'"phase":"two"'*) printf '"noTools":false}\n' ;;
  *) exit 8 ;;
esac
"#,
        );
        let helper = LaunchHelper::start(mock_launch_command(&full_prepare), &json!({"phase":"one"}), Duration::from_secs(5))
            .await
            .unwrap();
        let (_deadline, prep) = helper.prepare(br#"{"phase":"two"}"#, Duration::from_secs(5)).await.unwrap();
        assert!(prep.tools_explicitly_selected);
        assert!(!prep.no_tools);

        let refused = write_script(
            tmp.path(),
            "refused.sh",
            r#"
IFS= read -r _input
printf '\nMANAGED_ULW_LAUNCH_ERROR "custom discovery refusal"\n'
exit 1
"#,
        );
        let err = LaunchHelper::start(mock_launch_command(&refused), &json!({}), Duration::from_secs(5))
            .await
            .err()
            .unwrap();
        assert!(err.to_string().contains("custom discovery refusal"), "{err}");

        let slow = write_script(
            tmp.path(),
            "slow.sh",
            r#"
IFS= read -r _input
sleep 5
"#,
        );
        let err = LaunchHelper::start(mock_launch_command(&slow), &json!({}), Duration::from_millis(50))
            .await
            .err()
            .unwrap();
        assert!(err.to_string().contains("Native launch discovery timed out"), "{err}");
    }
}
