use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::{
    io::{AsyncWriteExt, BufReader},
    net::UnixStream,
    time::{Instant, sleep, timeout},
};
use uuid::Uuid;

use super::{
    config::same_path,
    fs::{self, EXIT_TIMEOUT, Endpoint, WAIT_SLICE, alive, socket_stat},
    rpc_wire::frame,
    rotation::Attestation,
};

const RPC_TIMEOUT: Duration = Duration::from_secs(30);
pub(super) const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Head {
    pub pid: u32,
    pub owner_pid: u32,
    pub session_id: String,
    pub session_file: PathBuf,
    pub dev: u64,
    pub ino: u64,
    /// A live launch receipt, never recovered from the coordination store.
    #[serde(skip)]
    pub loaded_superkit_path: Option<PathBuf>,
}

impl Head {
    pub fn endpoint(&self) -> Endpoint {
        Endpoint {
            pid: self.pid,
            dev: self.dev,
            ino: self.ino,
        }
    }

    pub fn same(&self, other: &Self) -> bool {
        self.endpoint() == other.endpoint()
            && self.owner_pid == other.owner_pid
            && self.session_id == other.session_id
            && same_path(&self.session_file, &other.session_file)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostState {
    host_pid: u32,
    adapter_owner_pid: u32,
    adapter_protocol: String,
    session_id: String,
    session_file: PathBuf,
    loaded_superkit_path: Option<PathBuf>,
}

pub(super) struct Probe {
    stream: BufReader<UnixStream>,
    pub head: Head,
    pub state: Value,
}

#[derive(Debug)]
pub(super) struct ShutdownRefused(pub String);

impl std::fmt::Display for ShutdownRefused {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for ShutdownRefused {}

impl Probe {
    pub async fn open(path: &Path, session: &Path, limit: Duration) -> Result<Self> {
        timeout(limit, async {
            let before = socket_stat(path, true)?;
            let mut stream = BufReader::new(UnixStream::connect(path).await?);
            let ready = frame(&mut stream).await?;
            ensure!(
                ready["type"] == "ready" && ready["protocolVersion"] == 1,
                "Endpoint did not offer the owned adapter JSONL protocol"
            );
            ensure!(
                ready["supportedProtocolVersions"]
                    .as_array()
                    .is_some_and(|supported| supported
                        .iter()
                        .any(|version| version.as_u64() == Some(2))),
                "Endpoint did not offer bounded v2 responses"
            );
            let negotiation = request(
                &mut stream,
                "negotiate_protocol",
                json!({"protocolVersion": 2}),
            )
            .await?;
            ensure!(
                negotiation["success"] == true && negotiation["data"]["protocolVersion"] == 2,
                "Endpoint rejected owned adapter protocol negotiation"
            );
            let mut response = request(&mut stream, "get_state", Value::Null).await?;
            ensure!(
                response["success"] == true,
                "Owned host state is unavailable"
            );
            let state = response
                .as_object_mut()
                .and_then(|response| response.swap_remove("data"))
                .context("Missing owned host state")?;
            let identity = HostState::deserialize(&state)?;
            let after = socket_stat(path, true)?;
            ensure!(
                after.dev() == before.dev() && after.ino() == before.ino(),
                "Owned HEAD socket changed during its identity probe"
            );
            ensure!(
                identity.host_pid > 0
                    && identity.adapter_owner_pid > 0
                    && identity.adapter_protocol == "owned-stock-stdio-v1"
                    && !identity.session_id.is_empty()
                    && same_path(&identity.session_file, session),
                "Endpoint did not identify the owned stock-stdio adapter and expected session"
            );
            Ok(Self {
                stream,
                state,
                head: Head {
                    pid: identity.host_pid,
                    owner_pid: identity.adapter_owner_pid,
                    session_id: identity.session_id,
                    session_file: identity.session_file,
                    dev: after.dev(),
                    ino: after.ino(),
                    loaded_superkit_path: identity.loaded_superkit_path.filter(|path| path.is_absolute()),
                },
            })
        })
        .await
        .context("Owned HEAD identity probe timed out")?
    }

    pub fn idle_for_restart(&self) -> bool {
        self.state["isSettled"] == true
            && self.state["isStreaming"] == false
            && self.state["isCompacting"] == false
            && self.state["queuedMessageCount"].as_u64() == Some(0)
            && self.state["hasPendingAsyncWork"] == false
            && self.state["hasOwnedRunningWork"] == false
            && self.state["pendingUiRequests"]
                .as_array()
                .is_some_and(Vec::is_empty)
            && self
                .state
                .get("goal")
                .is_some_and(|goal| goal.is_null() || goal["enabled"] == false)
    }

    pub async fn shutdown(&mut self) -> Result<()> {
        self.shutdown_with(Value::Null).await
    }

    pub async fn shutdown_rotation(&mut self, id: &str) -> Result<()> {
        self.shutdown_with(json!({ "headRotation": id })).await
    }

    pub async fn rotation_attestation(&mut self) -> Result<Option<Attestation>> {
        let response = timeout(
            RPC_TIMEOUT,
            request(&mut self.stream, "get_head_rotation", Value::Null),
        ).await.context("HEAD rotation attestation timed out")??;
        if response["success"] != true {
            return Ok(None);
        }
        Ok(Option::<Attestation>::deserialize(&response["data"])?)
    }

    async fn shutdown_with(&mut self, body: Value) -> Result<()> {
        let response = timeout(
            RPC_TIMEOUT,
            request(&mut self.stream, "shutdown_host", body),
        )
        .await
        .context("Owned shutdown request outcome is unresolved")??;
        if response["success"] == false {
            return Err(ShutdownRefused(
                response["error"]
                    .as_str()
                    .unwrap_or("Native head refused busy shutdown")
                    .to_owned(),
            )
            .into());
        }
        Ok(())
    }
}

async fn request(
    stream: &mut BufReader<UnixStream>,
    command: &str,
    mut body: Value,
) -> Result<Value> {
    let id = Uuid::new_v4().to_string();
    body["id"] = json!(id);
    body["type"] = json!(command);
    let mut bytes = serde_json::to_vec(&body)?;
    bytes.push(b'\n');
    stream.write_all(&bytes).await?;
    loop {
        let response = frame(stream).await?;
        if response["type"] != "response" || response["id"] != id {
            continue;
        }
        ensure!(
            response["command"] == command
                && response["success"].is_boolean()
                && (response["success"] == true || response["error"].is_string()),
            "Invalid owned Host response envelope"
        );
        return Ok(response);
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExitReceipt {
    pid: u32,
    owner_pid: u32,
    session_id: String,
    session_file: PathBuf,
    code: i32,
    signal: Value,
    persisted: bool,
    observations_flushed: bool,
}

pub(super) async fn confirmed_exit(path: &Path, head: &Head) -> Result<()> {
    let deadline = Instant::now() + EXIT_TIMEOUT;
    loop {
        if !alive(head.pid)? && fs::metadata(path)?.is_none() {
            break;
        }
        ensure!(
            Instant::now() < deadline,
            "Native head exit/persistence is pending; Gateway supervision remains stopped"
        );
        sleep(WAIT_SLICE).await;
    }
    let mut receipt_path = path.as_os_str().to_os_string();
    receipt_path.push(".exit.json");
    let receipt_path = PathBuf::from(receipt_path);
    let receipt: ExitReceipt = fs::read_private_json(&receipt_path)?;
    ensure!(
        receipt.pid == head.pid
            && receipt.owner_pid == head.owner_pid
            && receipt.session_id == head.session_id
            && receipt.session_file == head.session_file
            && receipt.code == 0
            && receipt.signal.is_null()
            && receipt.persisted
            && receipt.observations_flushed,
        "Native head exit and durable persistence were not confirmed; Gateway supervision remains stopped"
    );
    Ok(())
}
