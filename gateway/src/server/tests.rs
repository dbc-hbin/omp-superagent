use std::{fs, os::unix::fs::DirBuilderExt, path::PathBuf, sync::Arc, time::Duration};

use anyhow::{Context as _, Result, ensure};
use async_trait::async_trait;
use reqwest::{Response, StatusCode};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::oneshot,
    task::JoinHandle,
    time::timeout,
};
use uuid::Uuid;

use super::{Hub, Server, Service};
use crate::{
    adapter::{Adapter, EffectError, Hub as AdapterHub},
    store::Store,
};

mod group;
mod restart;

pub(crate) struct SocketDir(pub(crate) PathBuf);

impl SocketDir {
    pub(crate) fn new() -> Result<Self> {
        // macOS temporary directories may exceed the Unix socket address cap.
        let path = PathBuf::from("/tmp").join(format!("ogw-{}", Uuid::new_v4()));
        fs::DirBuilder::new().mode(0o700).create(&path)?;
        Ok(Self(path))
    }
}

impl Drop for SocketDir {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_dir_all(&self.0) {
            eprintln!("Could not remove Gateway IPC test directory: {error}");
        }
    }
}

struct LocalAttachment {
    http: reqwest::Client,
    local_url: String,
}

#[async_trait]
impl Adapter for LocalAttachment {
    async fn start(&self) -> Result<()> {
        Ok(())
    }
    async fn stop(&self) -> Result<()> {
        Ok(())
    }
    async fn effect(&self, _: &str, _: &[Value]) -> Result<Value, EffectError> {
        Err(EffectError::rejected("Fixture accepts attachments only"))
    }
    async fn attachment(&self, _: &Value, _: &Value) -> Result<Response, EffectError> {
        self.http
            .get(&self.local_url)
            .send()
            .await
            .map_err(|_| EffectError::uncertain("Local fixture failed"))
    }
}

pub(crate) struct LifecycleFixture;

#[async_trait]
impl Service for LifecycleFixture {
    fn status(&self, _: bool, _: bool, _: bool) -> Result<Value> {
        Ok(json!({"gateway":{}}))
    }
    async fn authorize_head(&self, pid: u32) -> Result<()> {
        ensure!(pid == std::process::id(), "Unexpected controller");
        Ok(())
    }
    async fn stop(&self) -> Result<()> {
        Ok(())
    }
    fn finish_stop(&self) {}
    async fn restart(&self, _: Value) -> Result<Value, EffectError> {
        Err(EffectError::rejected("Fixture accepts attachments only"))
    }
    fn run_restart(&self, _: &str) -> Result<()> {
        Ok(())
    }
}

pub(crate) struct GatewayClient {
    pub(crate) server: Server,
    client: reqwest::Client,
    headers: reqwest::header::HeaderMap,
}

impl GatewayClient {
    async fn connect(root: &SocketDir, url: String) -> Result<Self> {
        let store = Arc::new(Store::open(&root.0)?);
        Self::with_service(root, url, store, Arc::new(LifecycleFixture)).await
    }

    async fn with_service(
        root: &SocketDir,
        url: String,
        store: Arc<Store>,
        service: Arc<dyn Service>,
    ) -> Result<Self> {
        let adapters =
            AdapterHub::with_factory(&json!({"telegram":{}}), store.clone(), |_, _, _| {
                // Loopback is the whole external surface of the fixture.
                let http = reqwest::Client::builder()
                    .no_proxy()
                    .timeout(Duration::from_secs(3))
                    .build()?;
                Ok(Box::new(LocalAttachment {
                    http,
                    local_url: url.clone(),
                }))
            })?;
        Self::with_adapters(root, store, service, adapters).await
    }

    pub(crate) async fn with_adapters(
        root: &SocketDir,
        store: Arc<Store>,
        service: Arc<dyn Service>,
        adapters: Arc<AdapterHub>,
    ) -> Result<Self> {
        let hub = Arc::new(Hub::new(store.clone(), service, adapters));
        let socket = root.0.join("g.sock");
        let server = Server::listen(&socket, hub).await?;
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            reqwest::header::AUTHORIZATION,
            format!("Bearer {}", store.token()?).parse()?,
        );
        headers.insert("x-gateway-client", Uuid::new_v4().to_string().parse()?);
        let client = reqwest::Client::builder()
            .unix_socket(socket)
            .timeout(Duration::from_secs(3))
            .build()?;
        let attached: Value = client
            .post("http://localhost/attach")
            .headers(headers.clone())
            .json(&json!({"pid":std::process::id()}))
            .send()
            .await?
            .json()
            .await?;
        assert_eq!(attached["ok"], true);
        Ok(Self {
            server,
            client,
            headers,
        })
    }

    pub(crate) async fn call(&self, endpoint: &str, body: &Value) -> Result<Value> {
        Ok(self
            .client
            .post(format!("http://localhost{endpoint}"))
            .headers(self.headers.clone())
            .json(body)
            .send()
            .await?
            .json()
            .await?)
    }

    pub(crate) async fn events(&self, root: &SocketDir) -> Result<Response> {
        // The event stream has no total lifetime deadline; its consumer
        // bounds each read rather than expiring the active controller.
        let request = reqwest::Client::builder()
            .unix_socket(root.0.join("g.sock"))
            .build()?
            .get("http://localhost/events")
            .headers(self.headers.clone());
        Ok(timeout(Duration::from_secs(3), request.send()).await??.error_for_status()?)
    }

    async fn download(&self) -> Result<Response> {
        let response = self.client.post("http://localhost/attachment").headers(self.headers.clone()).json(&json!({
            "route":{"platform":"telegram","accountId":"bot","authorityId":"owner","guildId":null,"channelId":"chat","threadId":null},
            "attachment":{"id":"file","url":"fixture","name":"file.txt","size":5}
        })).send().await?;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response
                .headers()
                .get("x-gateway-attachment-protocol")
                .context("Missing framed transfer header")?,
            "1"
        );
        Ok(response)
    }
}

#[tokio::test]
async fn result_attachment_attempt_ledger_retains_only_fingerprint_and_rejects_changed_bytes() -> Result<()> {
    let root = SocketDir::new()?;
    let fixture = GatewayClient::connect(&root, String::new()).await?;
    let id = Uuid::new_v4().to_string();
    let route = json!({"platform":"telegram","accountId":"bot","authorityId":"owner",
        "guildId":null,"channelId":"chat","threadId":null});
    let request = |data: &str| json!({"id":id,"operation":"send","args":[{
        "id":"attachment-effect","route":route,"text":"",
        "resultAttachment":{"name":"result.bin","data":data},
    }]});
    let bytes = "AEJDCg==";
    let first = fixture.call("/effect", &request(bytes)).await?;
    assert_eq!(first["error"], "Fixture accepts attachments only");
    assert_eq!(fixture.call("/effect", &request(bytes)).await?, first);
    let changed = fixture.call("/effect", &request("AQID")).await?;
    assert_eq!(changed["certainty"], "uncertain", "the same effect ID cannot change its bytes");
    let db = rusqlite::Connection::open(root.0.join("coordination.sqlite"))?;
    let saved: String = db.query_row(
        "SELECT arguments FROM gateway_effects WHERE id = ?",
        [&id],
        |row| row.get(0),
    )?;
    let saved: Value = serde_json::from_str(&saved)?;
    let argument = saved[0].as_object().context("Gateway effect fingerprint")?;
    assert_eq!(argument.len(), 1, "the Gateway need not retain the attachment payload");
    assert_eq!(argument["resultAttachmentEffectSha256"].as_str().map(str::len), Some(64));
    fixture.server.close().await
}

#[tokio::test]
async fn attachment_ipc_streams_before_eof_and_only_receipts_all_declared_bytes() -> Result<()> {
    let (local_url, release, served) = gated_download(b"2\r\nde\r\n0\r\n\r\n").await?;
    let root = SocketDir::new()?;
    let fixture = GatewayClient::connect(&root, local_url).await?;
    let mut response = fixture.download().await?;
    assert!(
        !response
            .headers()
            .contains_key("x-gateway-attachment-length")
    );
    let mut wire = Vec::new();
    loop {
        let chunk = response
            .chunk()
            .await?
            .context("Gateway buffered the attachment until EOF")?;
        wire.extend_from_slice(&chunk);
        let (data, complete) = frames(&wire)?;
        assert!(
            !complete,
            "Gateway sent a completion receipt before upstream EOF"
        );
        if data == b"abc" {
            break;
        }
    }
    release
        .send(())
        .map_err(|()| anyhow::anyhow!("Local fixture exited before release"))?;
    while let Some(chunk) = response.chunk().await? {
        wire.extend_from_slice(&chunk);
    }
    assert_eq!(frames(&wire)?, (b"abcde".to_vec(), true));
    timeout(Duration::from_secs(3), served).await???;
    fixture.server.close().await
}

#[tokio::test]
async fn attachment_ipc_never_receipts_a_truncated_declared_size() -> Result<()> {
    let (local_url, release, served) = gated_download(b"0\r\n\r\n").await?;
    let root = SocketDir::new()?;
    let fixture = GatewayClient::connect(&root, local_url).await?;
    let mut response = fixture.download().await?;
    let transmitted = response
        .chunk()
        .await?
        .context("Expected bytes before upstream EOF")?;
    assert!(!transmitted.is_empty());
    release
        .send(())
        .map_err(|()| anyhow::anyhow!("Local fixture exited before release"))?;
    assert!(response.bytes().await.is_err());
    timeout(Duration::from_secs(3), served).await???;
    fixture.server.close().await
}

async fn gated_download(
    tail: &'static [u8],
) -> Result<(String, oneshot::Sender<()>, JoinHandle<Result<()>>)> {
    let upstream = TcpListener::bind("127.0.0.1:0").await?;
    let local_url = format!("http://{}/", upstream.local_addr()?);
    let (release, gated) = oneshot::channel();
    let served = tokio::spawn(async move {
        let (mut peer, _) = upstream.accept().await?;
        let mut request = Vec::new();
        let mut buffer = [0; 1024];
        while !request.ends_with(b"\r\n\r\n") {
            let read = peer.read(&mut buffer).await?;
            ensure!(read != 0, "Local attachment requester disconnected");
            request.extend_from_slice(&buffer[..read]);
        }
        peer.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n3\r\nabc\r\n").await?;
        gated.await?;
        peer.write_all(tail).await?;
        Ok::<_, anyhow::Error>(())
    });
    Ok((local_url, release, served))
}

fn frames(mut wire: &[u8]) -> Result<(Vec<u8>, bool)> {
    let mut data = Vec::new();
    while let Some((len, rest)) = wire.split_first_chunk::<4>() {
        let size = usize::try_from(u32::from_be_bytes(*len))?;
        if size == 0 {
            ensure!(rest.is_empty(), "Bytes after the terminal receipt");
            return Ok((data, true));
        }
        let Some((payload, rest)) = rest.split_at_checked(size) else {
            break;
        };
        data.extend_from_slice(payload);
        wire = rest;
    }
    Ok((data, false))
}
