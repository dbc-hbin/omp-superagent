use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};

use anyhow::{Context as _, Result};
use async_trait::async_trait;
use reqwest::Response;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::{Mutex, RwLock};

use crate::adapter::{Adapter, Context, EffectError};

mod approvals;
mod cards;
mod commands;
mod dialogs;
mod dispatch;
mod ingress;
mod login;
mod markdown;
mod model;
mod outputs;
mod permissions;
mod picker;
mod purposes;
mod responses;
mod rest;
mod socket;
mod supervisor;
#[cfg(test)]
mod tests;
mod threads;
#[path = "discord_voice.rs"]
mod voice;

use approvals::Cards;
use model::{Channel, Route, read, snowflake};
use rest::{Rest, broken};
use supervisor::Task;
use voice::Voice;

type Effect<T> = std::result::Result<T, EffectError>;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Config {
    token_env: String,
    owner_id: String,
    allowed_guild_ids: HashSet<String>,
    allowed_channel_ids: HashSet<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
struct Identity {
    account: String,
    application: String,
}

struct State {
    ctx: Context,
    config: Config,
    rest: Rest,
    identity: OnceLock<Identity>,
    channels: RwLock<HashMap<String, Channel>>,
    voice: Option<Voice>,
    cards: Cards,
    purpose_lock: Mutex<()>,
    stopping: AtomicBool,
}

pub struct Discord {
    state: Arc<State>,
    task: Mutex<Option<Task>>,
}

impl Discord {
    pub fn new(config: &Value, ctx: Context) -> Result<Self> {
        let policy = Config::deserialize(config).context("Invalid Discord config")?;
        anyhow::ensure!(
            snowflake(&policy.owner_id)
                && policy.allowed_guild_ids.iter().all(|id| snowflake(id))
                && policy.allowed_channel_ids.iter().all(|id| snowflake(id)),
            "Invalid Discord identity or allowlist"
        );
        let token = std::env::var(&policy.token_env)
            .map_err(|_| anyhow::anyhow!("Configured Discord credential is unavailable"))?;
        let rest = Rest::new(ctx.http.clone(), token)?;
        let voice = config
            .get("voice")
            .filter(|value| !value.is_null())
            .map(|_| Voice::new(config, ctx.clone()))
            .transpose()?;
        Ok(Self {
            state: Arc::new(State {
                ctx,
                config: policy,
                rest,
                identity: OnceLock::new(),
                channels: RwLock::new(HashMap::new()),
                voice,
                cards: Cards::default(),
                purpose_lock: Mutex::new(()),
                stopping: AtomicBool::new(false),
            }),
            task: Mutex::new(None),
        })
    }
}

#[async_trait]
impl Adapter for Discord {
    async fn start(&self) -> Result<()> {
        let mut task = self.task.lock().await;
        anyhow::ensure!(task.is_none(), "Discord adapter is already started");
        self.state.stopping.store(false, Ordering::Release);
        let active = Task::start(Arc::clone(&self.state)).await?;
        *task = Some(active);
        Ok(())
    }

    async fn stop(&self) -> Result<()> {
        let mut running = self.task.lock().await;
        self.state.stopping.store(true, Ordering::Release);
        if let Some(voice) = &self.state.voice {
            voice.stop().await;
        }
        if let Some(task) = running.take() {
            task.stop().await;
        }
        self.state.cards.clear().await;
        Ok(())
    }

    async fn effect(&self, operation: &str, args: &[Value]) -> Effect<Value> {
        let state = &self.state;
        match (operation, args) {
            ("assertRoute", [route]) => {
                state.assert_route(&read(route)?)?;
                Ok(Value::Null)
            }
            ("send", [output]) => state.send(&read(output)?).await.map(Value::String),
            ("setActivity", [message, activity]) => {
                state.activity(&read(message)?, read(activity)?).await?;
                Ok(Value::Null)
            }
            ("showApproval", [approval]) => state
                .show_approval(read(approval)?)
                .await
                .map(Value::String),
            ("dismissApproval", [approval]) => {
                state.dismiss_approval(&read(approval)?).await?;
                Ok(Value::Null)
            }
            ("canCreateThread", [route, tags @ ..]) if tags.len() <= 1 => {
                let tags = tags.first().map(read::<Vec<String>>).transpose()?;
                state
                    .can_create_thread(&read(route)?, tags.as_deref())
                    .await
                    .map(Value::Bool)
            }
            ("createThread", [route, title, extra @ ..]) if extra.len() <= 2 => {
                let source = extra
                    .first()
                    .map(read::<Option<&str>>)
                    .transpose()?
                    .flatten();
                let tags = extra.get(1).map(read::<Vec<String>>).transpose()?;
                state
                    .create_thread(&read(route)?, read(title)?, source, tags.as_deref())
                    .await
            }
            ("inspectThread", [route]) => state.inspect_thread(&read(route)?).await,
            ("updateThread", [route, update]) => {
                state.update_thread(&read(route)?, &read(update)?).await
            }
            ("inspectDiscordContext", [route]) => state.inspect_context(&read(route)?).await,
            ("discordPurpose", [request]) => state.purpose(read(request)?).await,
            ("fetchAfter", [route, cursor]) => {
                state.fetch_after(&read(route)?, read(cursor)?).await
            }
            _ => Err(EffectError::rejected(
                "Unsupported Discord operation or arguments",
            )),
        }
    }

    async fn attachment(&self, route: &Value, file: &Value) -> Effect<Response> {
        self.state.download(&read(route)?, &read(file)?).await
    }
}

impl State {
    fn allowed_guild(&self, guild: Option<&str>) -> bool {
        guild.is_none_or(|id| self.config.allowed_guild_ids.contains(id))
    }

    fn assert_route(&self, route: &Route) -> Effect<()> {
        if route.platform != "discord"
            || self.identity.get().map(|identity| &identity.account) != Some(&route.account_id)
            || route.authority_id != self.config.owner_id
            || !snowflake(&route.channel_id)
            || route.thread_id.as_deref().is_some_and(|id| !snowflake(id))
            || route
                .guild_id
                .as_ref()
                .map_or(route.thread_id.is_some(), |guild| {
                    !self.allowed_guild(Some(guild))
                        || !self.config.allowed_channel_ids.contains(&route.channel_id)
                })
        {
            return Err(EffectError::rejected(
                "Discord route is not authorized for this bot and owner",
            ));
        }
        Ok(())
    }

    fn route_for(&self, channel: &Channel) -> Effect<Route> {
        let identity = self
            .identity
            .get()
            .ok_or_else(|| broken("Discord bot has not authenticated"))?;
        let (channel_id, thread_id) = if channel.is_thread() {
            let parent = channel
                .parent_id
                .as_ref()
                .ok_or_else(|| EffectError::rejected("Discord thread parent is unavailable"))?;
            (parent, Some(channel.id.clone()))
        } else {
            (&channel.id, None)
        };
        if channel.guild_id.is_none()
            && (channel.kind != 1
                || channel.recipients.len() != 1
                || channel.recipients.first().map(|user| &user.id) != Some(&self.config.owner_id))
        {
            return Err(EffectError::rejected(
                "Discord DM does not belong to the owner",
            ));
        }
        let route = Route {
            platform: "discord".to_owned(),
            account_id: identity.account.clone(),
            authority_id: self.config.owner_id.clone(),
            guild_id: channel.guild_id.clone(),
            channel_id: channel_id.clone(),
            thread_id,
            topic_id: None,
        };
        self.assert_route(&route)?;
        Ok(route)
    }

    async fn channel_by_id(&self, id: &str, refresh: bool) -> Effect<Channel> {
        if !snowflake(id) {
            return Err(EffectError::rejected("Invalid Discord channel ID"));
        }
        if !refresh && let Some(cached) = self.channels.read().await.get(id) {
            return Ok(cached.clone());
        }
        let channel: Channel = self.rest.get(&format!("channels/{id}")).await?;
        if channel.id != id {
            return Err(EffectError::rejected(
                "Discord destination identity changed",
            ));
        }
        self.remember_channel(channel.clone()).await;
        Ok(channel)
    }

    async fn remember_channel(&self, channel: Channel) {
        // Keep known ineligible channels in the metadata cache too, so they
        // can be denied at event receipt without REST or queueing owner work.
        if snowflake(&channel.id) && self.allowed_guild(channel.guild_id.as_deref()) {
            self.channels
                .write()
                .await
                .insert(channel.id.clone(), channel);
        }
    }

    async fn channel(&self, route: &Route, refresh: bool) -> Effect<Channel> {
        self.assert_route(route)?;
        let channel = self.channel_by_id(route.destination(), refresh).await?;
        if self.route_for(&channel)? != route.physical() {
            return Err(EffectError::rejected(
                "Discord destination identity changed",
            ));
        }
        Ok(channel)
    }

    async fn destination(&self, route: &Route) -> Effect<Channel> {
        self.channel(route, false).await?.sendable()
    }

    fn admit(&self, event: Value) -> Effect<()> {
        if self.stopping.load(Ordering::Acquire) {
            return Err(EffectError::rejected("Discord admission is stopping"));
        }
        self.ctx
            .admit(event)
            .map(|_| ())
            .map_err(|_| broken("Discord durable admission could not be confirmed"))
    }

    fn answer(&self, approval_id: &str, route: &Route, response: Value) -> Effect<()> {
        self.admit(json!({ "kind": "answer", "approvalId": approval_id, "response": response, "route": route }))
    }
}
