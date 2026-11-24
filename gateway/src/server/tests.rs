use std::{fs, os::unix::fs::DirBuilderExt, path::PathBuf, sync::Arc, time::Duration};

use anyhow::{Result, ensure};
use async_trait::async_trait;
use reqwest::Response;
use serde_json::{Value, json};
use tokio::time::timeout;
use uuid::Uuid;

use super::{Hub, Server, Service};
use crate::{
    adapter::{Adapter, EffectError, Hub as AdapterHub},
    store::Store,
};

mod attachment_recovery;
mod attachments;
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
    async fn send_result_attachment(
        &self,
        _: &Value,
        file: crate::result_attachment::VerifiedResultAttachment,
    ) -> Result<Value, EffectError> {
        assert_eq!(file.bytes.as_slice(), b"\0BC\n");
        Ok(json!("fixture-file-receipt"))
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
}

mod result_attachment;
