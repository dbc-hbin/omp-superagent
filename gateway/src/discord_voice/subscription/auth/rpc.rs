use anyhow::{Context as _, Result, anyhow, bail, ensure};
use serde::{Deserialize, Deserializer, de::DeserializeOwned};
use serde_json::value::RawValue;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::{Child, ChildStdin, ChildStdout},
};
use zeroize::{Zeroize, Zeroizing};

const MAX_RPC_BYTES: usize = 256 * 1024;
const MAX_RPC_FRAMES: usize = 64;
const UNEXPECTED: &str = "Unexpected Codex managed-login response";

pub(super) enum Request {
    Initialize,
    Account,
    Status,
    ConfirmAccount,
}

impl Request {
    fn wire(self) -> (u64, &'static [u8]) {
        match self {
            Self::Initialize => (1, b"{\"id\":1,\"method\":\"initialize\",\"params\":{\"clientInfo\":{\"name\":\"omp-superagent-voice\",\"version\":\"1\"}}}\n"),
            Self::Account => (2, b"{\"id\":2,\"method\":\"account/read\",\"params\":{\"refreshToken\":false}}\n"),
            Self::Status => (3, b"{\"id\":3,\"method\":\"getAuthStatus\",\"params\":{\"includeToken\":true,\"refreshToken\":false}}\n"),
            Self::ConfirmAccount => (4, b"{\"id\":4,\"method\":\"account/read\",\"params\":{\"refreshToken\":false}}\n"),
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Notification<'a> {
    #[serde(borrow)]
    method: &'a RawValue,
    #[serde(borrow)]
    params: Option<&'a RawValue>,
    #[serde(default, rename = "jsonrpc", deserialize_with = "jsonrpc_v2")]
    _jsonrpc: (),
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Reply<'a> {
    id: u64,
    #[serde(borrow)]
    result: &'a RawValue,
    #[serde(default, rename = "jsonrpc", deserialize_with = "jsonrpc_v2")]
    _jsonrpc: (),
}

// Codex also supports its original envelope with no version member.
fn jsonrpc_v2<'de, D: Deserializer<'de>>(deserializer: D) -> std::result::Result<(), D::Error> {
    if String::deserialize(deserializer)? == "2.0" {
        return Ok(());
    }
    Err(serde::de::Error::custom("expected JSON-RPC 2.0"))
}

pub(super) struct Rpc {
    input: ChildStdin,
    output: ChildStdout,
    chunk: Zeroizing<[u8; 8192]>,
    pending: std::ops::Range<usize>,
    frame: Zeroizing<Vec<u8>>,
}

impl Rpc {
    pub(super) fn new(child: &mut Child) -> Result<Self> {
        Ok(Self {
            input: child
                .stdin
                .take()
                .context("Codex managed-login stdin unavailable")?,
            output: child
                .stdout
                .take()
                .context("Codex managed-login stdout unavailable")?,
            chunk: Zeroizing::new([0; 8192]),
            pending: 0..0,
            // Reserve the full frame bound so growing a frame never reallocates secret bytes.
            frame: Zeroizing::new(Vec::with_capacity(MAX_RPC_BYTES + 1)),
        })
    }

    pub(super) fn close_input(self) -> ChildStdout {
        self.output
    }

    async fn line(&mut self) -> Result<()> {
        self.frame.as_mut_slice().zeroize();
        self.frame.clear();
        loop {
            if self.pending.is_empty() {
                let count = self
                    .output
                    .read(&mut self.chunk[..])
                    .await
                    .map_err(|_| anyhow!("Could not read Codex managed-login broker"))?;
                ensure!(count != 0, "Codex managed-login broker closed its output");
                self.pending = 0..count;
            }
            let pending = &mut self.chunk[self.pending.clone()];
            let newline = pending.iter().position(|byte| *byte == b'\n');
            let len = newline.map_or(pending.len(), |position| position + 1);
            let limit = MAX_RPC_BYTES + usize::from(newline.is_some());
            ensure!(self.frame.len().saturating_add(len) <= limit, UNEXPECTED);
            self.frame.extend_from_slice(&pending[..len]);
            pending[..len].zeroize();
            self.pending.start += len;
            if newline.is_some() {
                return Ok(());
            }
        }
    }

    pub(super) async fn send(&mut self, request: &[u8]) -> Result<()> {
        self.input
            .write_all(request)
            .await
            .map_err(|_| anyhow!("Could not write to Codex managed-login broker"))
    }

    pub(super) async fn request<T: DeserializeOwned>(&mut self, request: Request) -> Result<T> {
        let (id, wire) = request.wire();
        self.send(wire).await?;
        let result = self.read_reply(id).await;
        self.frame.as_mut_slice().zeroize();
        self.frame.clear();
        result
    }

    async fn read_reply<T: DeserializeOwned>(&mut self, id: u64) -> Result<T> {
        for _ in 0..MAX_RPC_FRAMES {
            self.line().await?;
            let line = std::str::from_utf8(&self.frame).map_err(|_| anyhow!(UNEXPECTED))?;
            let line = line.trim_ascii_start();
            ensure!(line.starts_with('{'), UNEXPECTED);
            if let Ok(notification) = serde_json::from_str::<Notification<'_>>(line) {
                let method = notification.method.get();
                ensure!(method.starts_with('"') && method != "\"\"", UNEXPECTED);
                ensure!(
                    notification
                        .params
                        .is_none_or(|params| params.get().starts_with(['{', '['])),
                    UNEXPECTED
                );
                continue;
            }
            let reply: Reply<'_> = serde_json::from_str(line).map_err(|_| anyhow!(UNEXPECTED))?;
            ensure!(
                reply.id == id && reply.result.get().starts_with('{'),
                UNEXPECTED
            );
            return serde_json::from_str(reply.result.get()).map_err(|_| anyhow!(UNEXPECTED));
        }
        bail!(UNEXPECTED)
    }
}
