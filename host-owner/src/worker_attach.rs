use std::{
    os::unix::fs::{FileTypeExt, MetadataExt},
    path::{Path, PathBuf},
    time::Duration,
};

use anyhow::{Context, Result, ensure};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::{
    fs,
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::UnixStream,
    time::timeout,
};

use crate::wire::MAX_FRAME_BYTES;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AttachPermit {
    generation: u64,
    worker_attempt: String,
    socket_path: PathBuf,
    session_file: PathBuf,
    session_id: String,
    pid: u32,
    owner_pid: u32,
    socket: Inode,
    journal: Inode,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Inode {
    dev: String,
    ino: String,
}

impl Inode {
    fn matches(&self, info: &std::fs::Metadata) -> bool {
        self.dev.parse::<u64>() == Ok(info.dev()) && self.ino.parse::<u64>() == Ok(info.ino())
    }
}

pub(crate) struct Attached {
    pub(crate) peer: BufReader<UnixStream>,
    pub(crate) prelude: Vec<u8>,
    pub(crate) reply: Value,
}

impl AttachPermit {
    fn verify_request(&self, policy: &Path, header: &[u8]) -> Result<()> {
        // Match JSON.parse's key selection and TextDecoder's optional leading BOM.
        let request: Value = serde_json::from_slice(header.strip_prefix(b"\xef\xbb\xbf").unwrap_or(header))
            .context("Invalid admitted worker request")?;
        let lane = request["ref"]["laneId"]
            .as_str()
            .and_then(|name| name.strip_prefix("lane-").map(|suffix| (name, suffix)))
            .filter(|(_, suffix)| {
                (1..=48).contains(&suffix.len())
                    && suffix.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
            })
            .map(|(name, _)| name)
            .context("Invalid admitted worker lane")?;
        let state = policy.parent().context("Missing worker state directory")?;
        ensure!(
            request["op"] == "attach"
                && self.generation > 0
                && request["ref"]["generation"].as_f64() == serde_json::Number::from(self.generation).as_f64()
                && self.socket_path == state.join("run").join(format!("{lane}.sock"))
                && self.session_file == state.join("sessions").join(lane).join("session.jsonl")
                && self.pid > 0 && self.owner_pid > 0 && self.pid != self.owner_pid
                && !self.session_id.is_empty() && !self.worker_attempt.is_empty(),
            "Worker permit does not bind the requested endpoint"
        );
        Ok(())
    }

    async fn verify_files(&self) -> Result<()> {
        let socket = fs::symlink_metadata(&self.socket_path).await.context("Worker socket is unavailable")?;
        let journal = fs::symlink_metadata(&self.session_file).await.context("Worker journal is unavailable")?;
        let uid = rustix::process::getuid().as_raw();
        ensure!(
            socket.file_type().is_socket() && socket.uid() == uid && socket.mode() & 0o777 == 0o600
                && self.socket.matches(&socket)
                && journal.is_file() && journal.uid() == uid && journal.mode() & 0o022 == 0
                && self.journal.matches(&journal),
            "Worker socket or journal changed during attach"
        );
        Ok(())
    }

    fn matches_identity(&self, state: &Value) -> bool {
        state["hostPid"] == self.pid
            && state["adapterOwnerPid"] == self.owner_pid
            && state["workerAttempt"].as_str() == Some(self.worker_attempt.as_str())
            && state["sessionId"].as_str() == Some(self.session_id.as_str())
            && state["sessionFile"].as_str().map(Path::new) == Some(self.session_file.as_path())
    }

    pub(crate) async fn connect(&self, policy: &Path, header: &[u8]) -> Result<Attached> {
        self.verify_request(policy, header)?;
        timeout(Duration::from_secs(5), async {
            self.verify_files().await?;
            let stream = UnixStream::connect(&self.socket_path).await.context("Worker socket connection failed")?;
            let credentials = stream.peer_cred().context("Worker socket credentials are unavailable")?;
            ensure!(
                credentials.uid() == rustix::process::getuid().as_raw()
                    && credentials.pid().is_none_or(|pid| u32::try_from(pid) == Ok(self.owner_pid)),
                "Worker socket belongs to a different owner"
            );
            let mut peer = BufReader::new(stream);
            let mut prelude = Vec::new();
            let ready = read_peer_line(&mut peer, &mut prelude).await?;
            ensure!(ready["type"] == "ready", "Worker socket did not identify a native Host");
            if let Some(identity) = ready.get("workerIdentity") {
                ensure!(self.matches_identity(identity), "Worker native identity changed during attach");
            } else {
                self.attest_legacy_peer(&mut peer, &mut prelude).await?;
            }
            self.verify_files().await?;
            Ok(Attached {
                peer,
                prelude,
                reply: json!({"ok": true, "value": {
                    "pid": self.pid, "sessionId": self.session_id, "sessionFile": self.session_file,
                }}),
            })
        })
        .await
        .context("Worker socket attach timed out")?
    }

    // Older resident owners have no compact ready identity. Verify this same
    // connection via their read-only v1 RPC without negotiating for the client.
    async fn attest_legacy_peer(&self, peer: &mut BufReader<UnixStream>, prelude: &mut Vec<u8>) -> Result<()> {
        let id = uuid::Uuid::new_v4().to_string();
        let request = json!({"type": "get_state", "id": id});
        peer.get_mut().write_all(format!("{request}\n").as_bytes()).await?;
        let mut physical = Vec::new();
        loop {
            physical.clear();
            let frame = read_peer_line(peer, &mut physical).await?;
            if frame["type"] == "response" && frame["id"].as_str() == Some(id.as_str()) {
                ensure!(
                    frame["command"] == "get_state" && frame["success"] == true
                        && frame["data"]["adapterProtocol"] == "owned-stock-stdio-v1"
                        && frame["data"].get("prReviewPolicy").is_none()
                        && frame["data"]["loadedSuperkitPath"].as_str().is_some_and(|path| Path::new(path).is_absolute())
                        && self.matches_identity(&frame["data"]),
                    "Worker native identity changed during attach"
                );
                return Ok(());
            }
            ensure!(prelude.len() + physical.len() <= 2 * MAX_FRAME_BYTES, "Worker attach prelude exceeded its limit");
            prelude.extend_from_slice(&physical);
        }
    }
}

async fn read_peer_line(peer: &mut BufReader<UnixStream>, line: &mut Vec<u8>) -> Result<Value> {
    let mut bounded = peer.take(u64::try_from(MAX_FRAME_BYTES)?);
    bounded.read_until(b'\n', line).await?;
    ensure!(line.last() == Some(&b'\n'), "Worker native handshake was incomplete");
    serde_json::from_slice(line).context("Invalid worker native handshake")
}
