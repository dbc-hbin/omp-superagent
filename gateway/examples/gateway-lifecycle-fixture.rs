//! Runs the real Gateway daemon and lifecycle without a remote messenger.
use std::{
    env, fs as std_fs,
    io::ErrorKind,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    time::Duration,
};

use anyhow::{Context as _, Result, bail, ensure};
use async_trait::async_trait;
use omp_gateway::{
    adapter::{self, Adapter, Context, EffectError},
    daemon,
    lifecycle::{self, LifecycleConfig},
};
use serde_json::{Value, json};
use tokio::{fs, io::AsyncWriteExt, sync::Mutex, task::JoinHandle, time};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const SHUTDOWN: &str = "stop-test-gateways";
const HISTORY_CHANNEL: &str = "5";
const HISTORY_STARTER: &str = "90312";

struct OfflineMessenger {
    root: PathBuf,
    ingress: Context,
    stop: CancellationToken,
    task: Mutex<Option<JoinHandle<Result<()>>>>,
    journal: Mutex<()>,
}

fn authorized(route: &Value) -> bool {
    let thread = &route["threadId"];
    let channel = &route["channelId"];
    let allowed = match channel.as_str() {
        Some("4") => thread.is_null() || matches!(thread.as_str(), Some("50" | "51" | "52")),
        Some(HISTORY_CHANNEL) => thread.is_null() || thread.as_str() == Some(HISTORY_STARTER),
        _ => false,
    };
    allowed
        && route == &json!({
            "platform": "discord", "accountId": "2", "authorityId": "1",
            "guildId": "3", "channelId": channel, "threadId": thread
        })
}

#[async_trait]
impl Adapter for OfflineMessenger {
    async fn start(&self) -> Result<()> {
        let inbox = self.root.join("adapter-inbox.json");
        let ingress = self.ingress.clone();
        let stop = self.stop.clone();
        *self.task.lock().await = Some(tokio::spawn(async move {
            tokio::select! {
                biased;
                () = stop.cancelled() => return Ok(()),
                ready = ingress.ready() => ready?,
            }
            let mut tick = time::interval(Duration::from_millis(25));
            tick.set_missed_tick_behavior(time::MissedTickBehavior::Skip);
            loop {
                tokio::select! {
                    biased;
                    () = stop.cancelled() => return Ok(()),
                    _ = tick.tick() => (),
                }
                // The test atomically publishes one complete delivery at a time.
                let bytes = match fs::read(&inbox).await {
                    Ok(bytes) => bytes,
                    Err(error) if error.kind() == ErrorKind::NotFound => continue,
                    Err(error) => return Err(error.into()),
                };
                let input: Value = serde_json::from_slice(&bytes)?;
                ensure!(
                    authorized(&input["route"]),
                    "Fixture intake route did not match"
                );
                let _fresh = ingress.admit(json!({"kind": "message", "input": input}))?;
                fs::remove_file(&inbox).await?;
            }
        }));
        Ok(())
    }

    async fn stop(&self) -> Result<()> {
        self.stop.cancel();
        let task = self.task.lock().await.take();
        if let Some(task) = task {
            task.await??;
        }
        Ok(())
    }

    async fn effect(&self, operation: &str, args: &[Value]) -> Result<Value, EffectError> {
        let argument = args
            .first()
            .ok_or_else(|| EffectError::rejected("Missing fixture messenger argument"))?;
        let route = match operation {
            "assertRoute" | "fetchAfter" | "inspectThread" | "canCreateThread" | "createThread" => {
                argument
            }
            "send" | "setActivity" => &argument["route"],
            _ => {
                return Err(EffectError::rejected(
                    "Unexpected fixture messenger operation",
                ));
            }
        };
        if !authorized(route) {
            return Err(EffectError::rejected(
                "Fixture messenger route did not match",
            ));
        }
        let history_parent = route["channelId"].as_str() == Some(HISTORY_CHANNEL)
            && route["threadId"].is_null();
        match (operation, args) {
            ("assertRoute" | "setActivity", _) => Ok(Value::Null),
            ("fetchAfter", _) => Ok(json!([])),
            ("canCreateThread", [_]) => Ok(Value::Bool(history_parent)),
            ("createThread", [_, title, source])
                if history_parent
                    && title
                        .as_str()
                        .is_some_and(|name| (1..=100).contains(&name.chars().count()))
                    && source.as_str() == Some(HISTORY_STARTER) =>
            {
                // A Discord thread opened from a message uses that message's snowflake.
                let mut thread = route.clone();
                thread["threadId"] = source.clone();
                Ok(thread)
            }
            ("inspectThread", _) => {
                let id = route["threadId"]
                    .as_str()
                    .ok_or_else(|| EffectError::rejected("Fixture route is not a thread"))?;
                // Fixture work threads already have an open-state title.
                Ok(json!({
                    "route": route, "title": format!("⏳ Fixture topic {id}"),
                    "archived": false, "requiresTag": false, "availableTags": [], "appliedTags": []
                }))
            }
            ("send", _) => {
                let id = argument["id"]
                    .as_str()
                    .ok_or_else(|| EffectError::rejected("Missing fixture output ID"))?;
                let remote_id = format!("fixture:{id}");
                let receipt = json!({"remoteId": remote_id, "output": argument});
                let write = async {
                    let mut row = serde_json::to_vec(&receipt)?;
                    row.push(b'\n');
                    let _append = self.journal.lock().await;
                    let mut file = fs::OpenOptions::new()
                        .append(true)
                        .create(true)
                        .mode(0o600)
                        .open(self.root.join("adapter-output.jsonl"))
                        .await?;
                    file.write_all(&row).await?;
                    file.flush().await?;
                    Ok::<_, anyhow::Error>(())
                };
                write
                    .await
                    .map_err(|error| EffectError::uncertain(error.to_string()))?;
                Ok(json!(remote_id))
            }
            _ => Err(EffectError::rejected(
                "Unexpected fixture messenger operation",
            )),
        }
    }

    async fn attachment(
        &self,
        _route: &Value,
        _file: &Value,
    ) -> Result<reqwest::Response, EffectError> {
        Err(EffectError::rejected(
            "Fixture messenger has no attachments",
        ))
    }
}

enum Invocation {
    Initial,
    Runner(String),
    Successor(String),
}

fn fixture_root() -> Result<PathBuf> {
    let root = PathBuf::from(
        env::var_os("OMP_TEST_HOST_FIXTURE_ROOT").context("Missing private fixture root")?,
    );
    let marker = root.join(".native-rust-gateway");
    let dir_info = std_fs::symlink_metadata(&root)?;
    let marker_info = std_fs::symlink_metadata(&marker)?;
    let uid = nix::unistd::getuid().as_raw();
    ensure!(
        root.is_absolute()
            && root.canonicalize()? == root
            && dir_info.is_dir()
            && dir_info.uid() == uid
            && dir_info.mode() & 0o777 == 0o700
            && marker_info.is_file()
            && marker_info.uid() == uid
            && marker_info.mode() & 0o777 == 0o600
            && std_fs::read(marker)? == b"offline-native-rust-gateway\n",
        "The offline example requires its owned, private fixture root"
    );
    Ok(root)
}

fn main() -> Result<()> {
    let root = fixture_root()?;
    let file = root.join("superagent.json");
    let args: Vec<_> = env::args().skip(1).collect();
    let invocation = match args.as_slice() {
        [command, tail @ ..] if command == "__detach" => {
            return lifecycle::exec_detached(tail.iter().cloned());
        }
        [arg] if Path::new(arg) == file => Invocation::Initial,
        [command, cfg, path, request, id]
            if command == "serve"
                && cfg == "--config"
                && Path::new(path) == file
                && request == "--restart-request" =>
        {
            Uuid::parse_str(id).context("Invalid fixture successor request")?;
            Invocation::Successor(id.clone())
        }
        [command, cfg, path, request, id, state, directory]
            if command == "restart-runner"
                && cfg == "--config"
                && Path::new(path) == file
                && request == "--restart-request"
                && state == "--state-dir"
                && Path::new(directory) == root =>
        {
            Uuid::parse_str(id).context("Invalid fixture runner request")?;
            Invocation::Runner(id.clone())
        }
        _ => bail!("Invalid offline Gateway fixture arguments"),
    };
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?
        .block_on(run(&root, &file, invocation))
}

async fn run(root: &Path, file: &Path, invocation: Invocation) -> Result<()> {
    let info = fs::symlink_metadata(file).await?;
    ensure!(
        info.is_file()
            && info.uid() == nix::unistd::getuid().as_raw()
            && info.mode() & 0o777 == 0o600,
        "The offline example requires a private regular config file"
    );
    let config: Value = serde_json::from_slice(&fs::read(file).await?)?;
    let lifecycle = LifecycleConfig::new(&config)?;
    ensure!(
        lifecycle.path == file
            && lifecycle.state_dir == root
            && config["discord"]["tokenEnv"] == "ISOLATED_GATEWAY_DISCORD_TOKEN"
            && env::var("ISOLATED_GATEWAY_DISCORD_TOKEN").as_deref() == Ok("offline-fixture-only")
            && config.get("telegram").is_none()
            && config.get("slack").is_none(),
        "The offline example requires its isolated fixture configuration"
    );
    let quit = root.join(SHUTDOWN);
    let do_work = async {
        match invocation {
            Invocation::Initial => serve(&config, lifecycle, None).await,
            Invocation::Successor(id) => {
                record_process(root, "successor").await?;
                // Production verifies the exact owned ID and successor PID.
                serve(&config, lifecycle, Some(&id)).await
            }
            Invocation::Runner(id) => {
                record_process(root, "runner").await?;
                let result = lifecycle::restart_runner(&lifecycle, &id).await;
                if result.is_err() {
                    lifecycle::record_runner_failure(root, &id)?;
                }
                result
            }
        }
    };
    tokio::select! {
        biased;
        quit = wait_for_test_cleanup(&quit) => quit,
        result = do_work => result,
    }
}

async fn record_process(root: &Path, role: &str) -> Result<()> {
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(root.join(format!("gateway-fixture-{role}.{}", std::process::id())))
        .await?;
    Ok(())
}

async fn wait_for_test_cleanup(quit: &Path) -> Result<()> {
    loop {
        match fs::symlink_metadata(quit).await {
            Ok(info) => {
                ensure!(
                    info.is_file()
                        && info.uid() == nix::unistd::getuid().as_raw()
                        && info.mode() & 0o777 == 0o600,
                    "Untrusted fixture cleanup marker"
                );
                return Ok(());
            }
            Err(error) if error.kind() == ErrorKind::NotFound => {
                time::sleep(Duration::from_millis(25)).await
            }
            Err(error) => return Err(error.into()),
        }
    }
}

async fn serve(config: &Value, lifecycle: LifecycleConfig, request: Option<&str>) -> Result<()> {
    let root = lifecycle.state_dir.clone();
    daemon::serve(config, lifecycle, request, |config, store| {
        adapter::Hub::with_factory(config, store, |_, _, ingress| {
            Ok(Box::new(OfflineMessenger {
                root: root.clone(),
                ingress,
                stop: CancellationToken::new(),
                task: Mutex::new(None),
                journal: Mutex::new(()),
            }))
        })
    })
    .await
}
