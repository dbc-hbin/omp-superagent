//! Telegram Bot API transport and durable update consumer.
mod answer_commit;
mod answers;
mod api;
mod approval;
mod cards;
mod dialog;
mod effects;
mod entities;
mod files;
mod ingress;
mod model;
mod picker;
mod poll;
mod view;

#[cfg(test)]
mod tests;

use std::{collections::HashMap, sync::Arc};

use anyhow::{Context as _, ensure};
use async_trait::async_trait;
use futures_util::{future::BoxFuture, future::Shared};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::{Mutex, RwLock, watch};
use tokio_util::task::AbortOnDropHandle;
use uuid::Uuid;

use crate::adapter::{Adapter, Context, EffectError};

use self::{
    api::{Api, ApiError},
    approval::Cards,
    model::{Chat, Identity, Policy, file_id, positive_id},
    poll::Cursor,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Config {
    token_env: String,
    owner_id: String,
    allowed_chat_ids: Vec<String>,
}

type ChatFlight = (Uuid, Shared<BoxFuture<'static, Result<Chat, ApiError>>>);

struct Core {
    api: Api,
    ctx: Context,
    policy: Policy,
    identity: RwLock<Option<Identity>>,
    destinations: Mutex<HashMap<String, ChatFlight>>,
    cards: Mutex<Cards>,
}

impl Core {
    async fn identity(&self) -> Result<Identity, EffectError> {
        self.identity
            .read()
            .await
            .clone()
            .ok_or_else(|| EffectError::rejected("Telegram is not authenticated"))
    }

    fn get(&self, key: &str) -> Result<Option<String>, EffectError> {
        self.ctx.get_meta(key).map_err(|_| ledger_error())
    }

    fn set(&self, key: &str, value: &str) -> Result<(), EffectError> {
        self.ctx.set_meta(key, value).map_err(|_| ledger_error())
    }

    fn admit(&self, event: Value) -> Result<(), EffectError> {
        self.ctx
            .admit(event)
            .map(|_| ())
            .map_err(|_| ledger_error())
    }
}

fn ledger_error() -> EffectError {
    EffectError::uncertain("Telegram durable ledger operation did not complete")
}

struct Run {
    stop: watch::Sender<bool>,
    poll: AbortOnDropHandle<()>,
}

/// Configured Telegram transport; construction does not contact Telegram.
pub struct Telegram {
    core: Arc<Core>,
    run: Mutex<Option<Run>>,
}

impl Telegram {
    /// Loads only the configured credential and validates the owner/chat policy.
    pub fn new(config: &Value, ctx: Context) -> anyhow::Result<Self> {
        let config = Config::deserialize(config).context("Invalid Telegram configuration")?;
        let policy = Policy::new(&config.owner_id, &config.allowed_chat_ids)?;
        let token = std::env::var(config.token_env)
            .map_err(|_| anyhow::anyhow!("Missing or invalid Telegram credential"))?;
        ensure!(
            token
                .split_once(':')
                .is_some_and(|(id, secret)| positive_id(id).is_some() && file_id(secret)),
            "Invalid Telegram credential format"
        );
        Ok(Self::with_api(
            Api::new(ctx.http.clone(), token),
            ctx,
            policy,
        ))
    }

    fn with_api(api: Api, ctx: Context, policy: Policy) -> Self {
        Self {
            core: Arc::new(Core {
                api,
                ctx,
                policy,
                identity: RwLock::new(None),
                destinations: Mutex::new(HashMap::new()),
                cards: Mutex::new(Cards::default()),
            }),
            run: Mutex::new(None),
        }
    }

    #[cfg(test)]
    pub(crate) fn test_instance(ctx: Context, base: &str) -> anyhow::Result<Self> {
        let policy = Policy::new("42", &["-100".to_owned()])?;
        Ok(Self::with_api(
            Api::test_instance(ctx.http.clone(), base),
            ctx,
            policy,
        ))
    }
}

#[async_trait]
impl Adapter for Telegram {
    async fn start(&self) -> anyhow::Result<()> {
        let mut run = self.run.lock().await;
        ensure!(run.is_none(), "Telegram adapter is already started");
        let me = self
            .core
            .api
            .bot_user()
            .await
            .map_err(ApiError::into_anyhow)?;
        #[derive(Deserialize)]
        struct Webhook {
            url: String,
        }
        let webhook: Webhook = self
            .core
            .api
            .call("getWebhookInfo", &json!({}))
            .await
            .map_err(ApiError::into_anyhow)?;
        ensure!(
            webhook.url.is_empty(),
            "Telegram bot already has a webhook; refusing to remove or replace it"
        );
        let cursor = Cursor::load(&self.core.ctx, me.id)?;
        *self.core.identity.write().await = Some(me);
        let (stop, signal) = watch::channel(false);
        let poll =
            AbortOnDropHandle::new(tokio::spawn(poll::run(self.core.clone(), cursor, signal)));
        *run = Some(Run { stop, poll });
        Ok(())
    }

    async fn stop(&self) -> anyhow::Result<()> {
        let mut run = self.run.lock().await;
        let result = if let Some(active) = run.take() {
            active.stop.send_replace(true);
            active.poll.await
        } else {
            Ok(())
        };
        *self.core.identity.write().await = None;
        self.core.cards.lock().await.clear();
        self.core.destinations.lock().await.clear();
        result.context("Telegram poll task failed during shutdown")?;
        Ok(())
    }

    async fn effect(&self, operation: &str, args: &[Value]) -> Result<Value, EffectError> {
        self.core.effect(operation, args).await
    }

    async fn attachment(
        &self,
        route: &Value,
        file: &Value,
    ) -> Result<reqwest::Response, EffectError> {
        self.core.open_attachment(route, file).await
    }
}
