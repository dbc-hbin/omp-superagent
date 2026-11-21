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
    time::Duration,
};
use tokio::{
    process::{Child, Command},
    time::{Instant, sleep, timeout},
};
use uuid::Uuid;

use super::{
    LifecycleConfig, fs as owned,
    host_rpc::Probe,
    process::{ChildKind, detached, host_owner_executable},
    rotation::{self, Rotation},
    stock_ops::{bun, capture, inspect_omp, session_id, tagged_output},
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
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Preparation {
    tools_explicitly_selected: bool,
    no_tools: bool,
    inventory: Option<Value>,
}

impl PreparedHost {
    pub async fn prepare(config: &LifecycleConfig, store: &Store, ulw: &Ulw, rotation: Option<&Rotation>) -> Result<Self> {
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
        let (command, backend) = inspect_omp(config, &environment).await?;
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
        let default_args = host_args(config, (&config_path, &session_file), &extensions, false);
        let (_, prefix) = command
            .split_first()
            .context("No OMP executable provided")?;
        let discover_input = json!({ "cwd": config.cwd, "managedUlwPath": package, "extensionPaths": extensions,
            "configPath": config_path, "commandArgs": prefix,
            "launchArgs": prefix.iter().chain(default_args.iter()).collect::<Vec<_>>() });
        let mut discover = bun(config, &environment);
        discover
            .arg(source.join("managed-ulw.ts"))
            .arg("--launch-extensions")
            .arg(discover_input.to_string());
        let discovery: Discovery = tagged_output(
            &capture(discover, None, START_TIMEOUT).await?,
            "MANAGED_ULW_LAUNCH ",
        )?;
        let args = host_args(
            config,
            (&config_path, &session_file),
            &discovery.extension_paths,
            discovery.no_extensions,
        );
        let socket_id = Uuid::new_v4().simple().to_string();
        let native_socket = run_dir.join(format!(".n-{}.sock", &socket_id[..8]));
        let helper = source.join("host-sdk-helper.ts");
        let mut manifest = json!({
            "options": { "command": command, "cwd": config.cwd, "sessionFile": session_file, "managedUlwPath": package,
                "socketPath": config.head_socket, "modelSettings": settings.as_ref().map(|saved| &saved.settings) },
            "args": args, "configPath": config_path, "processBackend": backend,
            "helperPath": helper, "nativeSocket": native_socket,
        });
        if let Some(plan) = rotation {
            manifest["headRotationSelection"] = serde_json::to_value(&plan.attestation.selection)?;
        }
        let deadline = Instant::now() + START_TIMEOUT;
        let mut prepare = bun(config, &environment);
        prepare.arg(helper).arg("prepare");
        let payload = serde_json::to_vec(&manifest)?;
        let flags: Preparation =
            serde_json::from_slice(&capture(prepare, Some(&payload), START_TIMEOUT).await?)
                .context("Native session preparation did not confirm tool selection")?;
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

    pub fn spawn(mut self, config: &LifecycleConfig) -> Result<LaunchedHost> {
        ensure!(
            Instant::now() < self.deadline,
            "Native Host startup timed out before launch"
        );
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
    files: (&Path, &Path),
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
    args.extend(["--config".into(), files.0.to_string_lossy().into_owned()]);
    args
}
