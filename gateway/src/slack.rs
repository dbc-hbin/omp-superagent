//! Slack Socket Mode transport and Web API messenger.

mod api;
mod cards;
mod history;
mod ingress;
mod media;
mod picker;
mod socket;
mod wire;

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use anyhow::{Context as _, ensure};
use async_trait::async_trait;
use futures_util::future::{BoxFuture, Shared};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::{Mutex, RwLock};

use crate::adapter::{Adapter, Context, EffectError};

use self::api::{Api, ApiError, Credentials, Identity};
use self::cards::{Approval, Cards};
use self::socket::SocketTask;
use self::wire::{Route, decode, slack_id};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Config {
    bot_token_env: String,
    app_token_env: String,
    owner_id: String,
    team_id: String,
    allowed_channel_ids: HashSet<String>,
}

pub struct Slack {
    inner: Arc<Inner>,
    socket: Mutex<Option<SocketTask>>,
}

type DestinationFlight = Shared<BoxFuture<'static, Result<api::Channel, ApiError>>>;

struct Inner {
    ctx: Context,
    api: Api,
    team: String,
    owner: String,
    channels: HashSet<String>,
    identity: RwLock<Option<Arc<Identity>>>,
    destinations: Mutex<HashMap<Route, DestinationFlight>>,
    cards: Cards,
}

impl Inner {
    async fn ledger<T: Send + 'static>(
        &self,
        run: impl FnOnce(Context) -> anyhow::Result<T> + Send + 'static,
    ) -> Result<T, EffectError> {
        let context = self.ctx.clone();
        // SQLite may wait on another writer. Keep the WebSocket timer and ACK
        // writer responsive while respecting durable admission ordering.
        tokio::task::spawn_blocking(move || run(context))
            .await
            .map_err(|_| EffectError::uncertain("Slack durable store worker failed"))?
            .map_err(|_| EffectError::uncertain("Slack durable store operation failed"))
    }

    async fn admit(&self, event: Value) -> Result<bool, EffectError> {
        self.ledger(move |context| context.admit(event)).await
    }
}

impl Slack {
    pub fn new(config: &Value, ctx: Context) -> anyhow::Result<Self> {
        let config = Config::deserialize(config).context("invalid Slack configuration")?;
        ensure!(
            slack_id(&config.team_id) && config.team_id.starts_with('T'),
            "invalid Slack workspace ID"
        );
        ensure!(
            slack_id(&config.owner_id) && config.owner_id.starts_with(['U', 'W']),
            "invalid Slack owner ID"
        );
        ensure!(
            config
                .allowed_channel_ids
                .iter()
                .all(|id| slack_id(id) && id.starts_with(['C', 'G'])),
            "invalid Slack allowed channel ID"
        );
        let bot = std::env::var(&config.bot_token_env)
            .context("Slack bot token environment variable is unavailable")?;
        let app = std::env::var(&config.app_token_env)
            .context("Slack app token environment variable is unavailable")?;
        ensure!(
            bot.starts_with("xoxb-") && bot.len() > 5,
            "Slack requires a bot token"
        );
        ensure!(
            app.starts_with("xapp-") && app.len() > 5,
            "Slack requires a Socket Mode app token"
        );
        let api = Api::new(
            ctx.http.clone(),
            Credentials {
                bot,
                app,
                team: config.team_id.clone(),
            },
        );
        Ok(Self::with_api(config, ctx, api))
    }

    fn with_api(config: Config, ctx: Context, api: Api) -> Self {
        Self {
            inner: Arc::new(Inner {
                api,
                ctx,
                team: config.team_id,
                owner: config.owner_id,
                channels: config.allowed_channel_ids,
                identity: RwLock::new(None),
                destinations: Mutex::new(HashMap::new()),
                cards: Cards::default(),
            }),
            socket: Mutex::new(None),
        }
    }
}

#[async_trait]
impl Adapter for Slack {
    async fn start(&self) -> anyhow::Result<()> {
        let mut task = self.socket.lock().await;
        ensure!(task.is_none(), "Slack adapter is already started");
        let identity = Arc::new(self.inner.authenticate().await?);
        let connection = self.inner.connect(&identity).await?;
        *self.inner.identity.write().await = Some(identity.clone());
        *task = Some(self.inner.clone().spawn_socket(connection, identity));
        Ok(())
    }

    async fn stop(&self) -> anyhow::Result<()> {
        let mut task = self.socket.lock().await;
        let result = match task.take() {
            Some(task) => task.stop().await,
            None => Ok(()),
        };
        *self.inner.identity.write().await = None;
        self.inner.destinations.lock().await.clear();
        self.inner.cards.clear().await;
        result
    }

    async fn effect(&self, operation: &str, args: &[Value]) -> Result<Value, EffectError> {
        match (operation, args) {
            ("assertRoute", [route]) => {
                self.inner.assert_route(&decode(route)?).await?;
                Ok(Value::Null)
            }
            ("send", [output]) => {
                if output.get("replyTo").is_some() {
                    return Err(EffectError::rejected(
                        "Slack does not support a Discord reply reference",
                    ));
                }
                self.inner.send(decode(output)?).await.map(Value::String)
            }
            ("setActivity", [message, activity]) => {
                self.inner
                    .activity(decode(message)?, decode(activity)?)
                    .await?;
                Ok(Value::Null)
            }
            ("showApproval", [approval]) => self
                .inner
                .show_card(decode::<Approval>(approval)?)
                .await
                .map(Value::String),
            ("dismissApproval", [approval]) => {
                self.inner.dismiss_card(decode(approval)?).await?;
                Ok(Value::Null)
            }
            ("canCreateThread", [route] | [route, _]) => {
                let route: Route = decode(route)?;
                self.inner.assert_route(&route).await?;
                if route.thread_id.is_some() {
                    return Ok(Value::Bool(false));
                }
                self.inner.destination(&route).await?;
                Ok(Value::Bool(true))
            }
            ("createThread", [route, title] | [route, title, ..]) if args.len() <= 4 => {
                let source = args
                    .get(2)
                    .map(decode::<Option<wire::Ts>>)
                    .transpose()?
                    .flatten();
                let route = self
                    .inner
                    .create_thread(decode(route)?, wire::text(title)?, source)
                    .await?;
                Ok(json!(route))
            }
            ("fetchAfter", [route, timestamp]) => Ok(json!(
                self.inner
                    .fetch_after(decode(route)?, decode(timestamp)?)
                    .await?
            )),
            ("inspectThread" | "updateThread", _) => Err(EffectError::rejected(
                "Thread management is unsupported on this transport",
            )),
            ("inspectDiscordContext" | "discordPurpose", _) => Err(EffectError::rejected(
                "Discord effects are unsupported on Slack",
            )),
            _ => Err(EffectError::rejected(
                "Unknown Slack effect or invalid arguments",
            )),
        }
    }

    async fn attachment(
        &self,
        route: &Value,
        file: &Value,
    ) -> Result<reqwest::Response, EffectError> {
        self.inner.download(decode(route)?, decode(file)?).await
    }
}
