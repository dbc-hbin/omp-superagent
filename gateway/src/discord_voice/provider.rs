#[path = "api.rs"]
mod api;
#[path = "delegation.rs"]
mod delegation;
#[path = "subscription.rs"]
mod subscription;

use anyhow::{Result, ensure};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::Value;
use std::time::Duration;
use tokio::time::timeout;

use self::{api::Api, subscription::Subscription};
use super::{
    Service,
    policy::{Auth, Settings},
};

pub(super) const FRAME: usize = 960; // 20 ms of 24 kHz mono signed PCM16LE
const MAX_INPUT: usize = FRAME * 25;
const IO_TIMEOUT: Duration = Duration::from_secs(2);

pub(super) enum Event {
    None,
    Audio(Vec<u8>),
    Draft { id: String, text: Option<String> },
    Reject(String),
}

pub(super) struct Provider(Backend);

enum Backend {
    Api(Box<Api>),
    Subscription(Box<Subscription>),
}

pub(super) struct Setup<'a>(Authorization<'a>);

enum Authorization<'a> {
    Api { settings: &'a Settings, key: String },
    Subscription { voice: &'a str },
}

impl<'a> Setup<'a> {
    pub(super) fn authorize(service: &'a Service) -> Option<Self> {
        let settings = &service.config.voice;
        match service.config.auth {
            Auth::Api => {
                let voice = serde_json::json!({"apiKeyEnv":settings.api_key_env});
                let key = service.ctx.voice_api_key(&voice)?;
                Some(Self(Authorization::Api { settings, key }))
            }
            Auth::Subscription => Some(Self(Authorization::Subscription {
                voice: &settings.voice,
            })),
        }
    }

    pub(super) async fn open(self) -> Result<Provider> {
        match self.0 {
            Authorization::Api { settings, key } => {
                let api = timeout(Duration::from_secs(15), Api::open(settings, &key)).await??;
                Ok(Provider(Backend::Api(Box::new(api))))
            }
            Authorization::Subscription { voice } => {
                let subscription =
                    timeout(Duration::from_secs(45), Subscription::open(voice)).await??;
                Ok(Provider(Backend::Subscription(Box::new(subscription))))
            }
        }
    }
}

impl Provider {
    pub(super) fn input(&mut self, pcm: &[u8]) -> Result<()> {
        ensure!(
            pcm.len() <= MAX_INPUT && pcm.len() % 2 == 0,
            "Invalid provider PCM input"
        );
        match &mut self.0 {
            Backend::Api(api) => api.input(pcm),
            Backend::Subscription(subscription) => subscription.input(pcm),
        }
    }

    pub(super) async fn tick(&mut self) -> Result<()> {
        match &mut self.0 {
            Backend::Api(api) => timeout(IO_TIMEOUT, api.tick()).await?,
            Backend::Subscription(_) => Ok(()),
        }
    }

    pub(super) async fn recv(&mut self) -> Result<Event> {
        match &mut self.0 {
            Backend::Api(api) => api.recv().await,
            Backend::Subscription(subscription) => subscription.recv().await,
        }
    }

    pub(super) async fn draft_result(&mut self, id: &str, posted: bool) -> Result<()> {
        timeout(IO_TIMEOUT, async {
            match &mut self.0 {
                Backend::Api(api) => api.draft_result(id, posted).await,
                Backend::Subscription(subscription) => subscription.draft_result(id, posted).await,
            }
        })
        .await?
    }

    pub(super) async fn close(&mut self) {
        let _ = timeout(IO_TIMEOUT, async {
            match &mut self.0 {
                Backend::Api(api) => api.close().await,
                Backend::Subscription(subscription) => subscription.close().await,
            }
        })
        .await;
    }
}

fn pcm(value: &Value, max_bytes: usize) -> Result<Vec<u8>> {
    let encoded = value
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Invalid provider audio"))?;
    let samples = STANDARD
        .decode(encoded)
        .map_err(|_| anyhow::anyhow!("Invalid provider PCM encoding"))?;
    ensure!(
        samples.len() <= max_bytes && samples.len() % 2 == 0,
        "Invalid provider PCM frame size"
    );
    Ok(samples)
}
