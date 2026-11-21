//! Only configured transports are constructed. OMP is not linked into the gateway.
use std::{
    collections::HashMap,
    fmt,
    sync::{
        Arc, Mutex, OnceLock, Weak,
        atomic::{AtomicBool, Ordering},
    },
};

use anyhow::{Result, ensure};
use async_trait::async_trait;
use serde_json::{Value, json};
use tokio::sync::{Mutex as AsyncMutex, Notify, watch};
use tokio_util::task::TaskTracker;

use crate::{
    discord::Discord,
    group::{Candidate, Request as GroupRequest, Room, Rooms},
    picker::{Pickers, Selection},
    slack::Slack,
    store::Store,
    telegram::Telegram,
};

#[derive(Debug)]
pub struct EffectError {
    pub message: String,
    pub certainty: &'static str,
    pub retry_after_ms: Option<u64>,
}

impl EffectError {
    pub fn rejected(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            certainty: "rejected",
            retry_after_ms: None,
        }
    }
    pub fn uncertain(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            certainty: "uncertain",
            retry_after_ms: None,
        }
    }
}

impl fmt::Display for EffectError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for EffectError {}

#[async_trait]
pub trait Adapter: Send + Sync {
    async fn start(&self) -> Result<()>;
    async fn stop(&self) -> Result<()>;
    async fn effect(&self, operation: &str, args: &[Value]) -> Result<Value, EffectError>;
    async fn attachment(
        &self,
        route: &Value,
        file: &Value,
    ) -> Result<reqwest::Response, EffectError>;
}

#[derive(Clone)]
pub struct Context {
    pub http: reqwest::Client,
    pub(crate) pickers: Pickers,
    platform: &'static str,
    store: Arc<Store>,
    owner: Arc<OnceLock<Weak<Hub>>>,
    ready: watch::Receiver<bool>,
    token_names: Arc<[String]>,
    rooms: Arc<Rooms>,
}

impl Context {
    pub(crate) fn group_room(&self, guild: Option<&str>, channel: &str) -> Option<&Room> {
        self.rooms.get(self.platform, guild, channel)
    }

    pub(crate) fn has_group_guild(&self, guild: Option<&str>) -> bool {
        self.rooms.has_guild(self.platform, guild)
    }

    pub(crate) fn has_group_actor(&self, guild: Option<&str>, user: &str) -> bool {
        self.rooms.has_actor(self.platform, guild, user)
    }

    pub(crate) fn admit_group(&self, route: Value, source: Candidate<'_>) -> Result<()> {
        ensure!(
            route["platform"].as_str() == Some(self.platform),
            "Group event crossed platform boundary"
        );
        let Some(room) = self.rooms.for_route(&route) else {
            return Ok(());
        };
        let Some(request) = GroupRequest::new(room, route, source)? else {
            return Ok(());
        };
        if !*self.ready.borrow() {
            return Ok(());
        }
        if self.store.admit_group(&request, room.daily_limit)? {
            self.hub()?.changed.notify_one();
        }
        Ok(())
    }

    fn hub(&self) -> Result<Arc<Hub>> {
        self.owner
            .get()
            .and_then(Weak::upgrade)
            .ok_or_else(|| anyhow::anyhow!("Gateway not available"))
    }

    pub(crate) async fn admit_picker(&self, selection: &Selection) -> Result<(), EffectError> {
        let ctx = self.clone();
        let event = selection.event.clone();
        let failure = || EffectError::uncertain("Selector admission could not be confirmed");
        tokio::task::spawn_blocking(move || ctx.admit(event))
            .await.map_err(|_| failure())?.map_err(|_| failure())?;
        self.pickers.admitted(selection)
    }

    pub async fn ready(&self) -> Result<()> {
        self.ready.clone().wait_for(|v| *v).await?;
        Ok(())
    }
    pub fn get_meta(&self, key: &str) -> Result<Option<String>> {
        self.store.get_meta(key)
    }
    pub fn set_meta(&self, key: &str, value: &str) -> Result<()> {
        self.store.set_meta(key, value)
    }
    pub fn has_pending_answer(&self, id: &str, route: &Value) -> Result<bool> {
        self.rooms.owner_route(route)?;
        self.store.has_pending_answer(id, route)
    }
    pub fn has_durable_answer(&self, id: &str, route: &Value, response_hash: &str) -> Result<bool> {
        ensure!(
            route["platform"].as_str() == Some(self.platform),
            "Approval crossed platform boundary"
        );
        self.rooms.owner_route(route)?;
        self.store.has_durable_answer(id, route, response_hash)
    }
    /// The authenticated head can restore a card before the initial barrier.
    /// If its dialog cannot be represented safely, the adapter may cancel it
    /// after the original route receives the cancellation notice, never accept.
    pub fn cancel_unsupported_approval(&self, id: &str, route: &Value) -> Result<bool> {
        ensure!(
            route["platform"].as_str() == Some(self.platform),
            "Approval crossed platform boundary"
        );
        self.rooms.owner_route(route)?;
        let hub = self.hub()?;
        let fresh = self.store.admit(&json!({
            "kind":"answer","approvalId":id,"response":{"cancelled":true},"route":route
        }))?;
        hub.changed.notify_one();
        Ok(fresh)
    }
    pub fn voice_api_key(&self, voice: &Value) -> Option<String> {
        let key = std::env::var(voice["apiKeyEnv"].as_str()?).ok()?;
        (!key.is_empty()
            && !self
                .token_names
                .iter()
                .any(|n| std::env::var(n).as_ref() == Ok(&key)))
        .then_some(key)
    }
    pub fn admit(&self, event: Value) -> Result<bool> {
        let hub = self.hub()?;
        let (route, message_id) = match event["kind"].as_str() {
            Some("message") => (
                &event["input"]["route"],
                event["input"]["messageId"].as_str(),
            ),
            Some("answer") => (&event["route"], None),
            Some("reconnect") => {
                if !hub.started.load(Ordering::Acquire) {
                    return Ok(false);
                }
                ensure!(
                    event.get("barrier").is_none(),
                    "Adapter cannot open the native readiness barrier"
                );
                let fresh = self.store.admit(&event)?;
                hub.changed.notify_one();
                return Ok(fresh);
            }
            _ => anyhow::bail!("Unknown adapter event"),
        };
        ensure!(*self.ready.borrow(), "Gateway admission not ready");
        ensure!(
            route["platform"].as_str() == Some(self.platform),
            "Adapter event crossed platform boundary"
        );
        self.rooms.owner_route(route)?;
        let fresh = self.store.admit(&event)?;
        if fresh && let Some(id) = message_id {
            let target = json!({"route":route, "messageId":id});
            let owner = Arc::clone(&hub);
            hub.reactions.spawn(async move {
                if owner.activity(&target, "received").await.is_err() {
                    eprintln!("Gateway message receipt reaction failed");
                }
            });
        }
        hub.changed.notify_one();
        Ok(fresh)
    }
}

pub struct Hub {
    adapters: Vec<(&'static str, Box<dyn Adapter>)>,
    pub ready: watch::Sender<bool>,
    pub changed: Arc<Notify>,
    started: AtomicBool,
    activity: Mutex<HashMap<String, Arc<AsyncMutex<bool>>>>,
    reactions: TaskTracker,
    pub(crate) rooms: Arc<Rooms>,
}

impl Hub {
    pub fn new(config: &Value, store: Arc<Store>) -> Result<Arc<Self>> {
        Self::with_factory(config, store, |name, section, ctx| {
            Ok(match name {
                "discord" => Box::new(Discord::new(section, ctx)?),
                "telegram" => Box::new(Telegram::new(section, ctx)?),
                "slack" => Box::new(Slack::new(section, ctx)?),
                _ => anyhow::bail!("Unknown messenger"),
            })
        })
    }
    pub fn with_factory(
        config: &Value,
        store: Arc<Store>,
        mut build: impl FnMut(&'static str, &Value, Context) -> Result<Box<dyn Adapter>>,
    ) -> Result<Arc<Self>> {
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .build()?;
        let token_names: Arc<[String]> = [
            ("discord", "tokenEnv"),
            ("telegram", "tokenEnv"),
            ("slack", "botTokenEnv"),
            ("slack", "appTokenEnv"),
        ]
        .into_iter()
        .filter_map(|(p, k)| config[p][k].as_str().map(str::to_owned))
        .collect();
        for name in token_names.iter() {
            ensure!(
                std::env::var_os(name).is_some_and(|v| !v.is_empty()),
                "Missing messenger credential environment variable {name}"
            );
        }
        let (ready, rx) = watch::channel(false);
        let owner = Arc::new(OnceLock::new());
        let rooms = Arc::new(Rooms::parse(config)?);
        let ctx = |platform| Context {
            http: http.clone(),
            pickers: Pickers::default(),
            store: store.clone(),
            ready: rx.clone(),
            platform,
            owner: owner.clone(),
            token_names: token_names.clone(),
            rooms: rooms.clone(),
        };
        let mut adapters: Vec<(&'static str, Box<dyn Adapter>)> = Vec::new();
        for name in ["discord", "telegram", "slack"] {
            if let Some(section) = config.get(name) {
                adapters.push((name, build(name, section, ctx(name))?));
            }
        }
        ensure!(!adapters.is_empty(), "At least one messenger is required");
        let hub = Arc::new(Self {
            adapters,
            ready,
            changed: Arc::new(Notify::new()),
            started: AtomicBool::new(false),
            activity: Mutex::default(),
            reactions: TaskTracker::new(),
            rooms,
        });
        owner
            .set(Arc::downgrade(&hub))
            .map_err(|_| anyhow::anyhow!("Gateway already bound"))?;
        Ok(hub)
    }
    pub async fn start(&self) -> Result<()> {
        for (index, (_, adapter)) in self.adapters.iter().enumerate() {
            if let Err(err) = adapter.start().await {
                for (_, prior) in self.adapters[..=index].iter().rev() {
                    if prior.stop().await.is_err() {
                        eprintln!("Gateway adapter cleanup failed");
                    }
                }
                return Err(err);
            }
        }
        self.started.store(true, Ordering::Release);
        Ok(())
    }
    pub async fn stop(&self) -> Result<()> {
        self.started.store(false, Ordering::Release);
        self.reactions.close();
        self.reactions.wait().await;
        let mut errors = Vec::new();
        for (name, adapter) in self.adapters.iter().rev() {
            if adapter.stop().await.is_err() {
                errors.push(*name);
            }
        }
        ensure!(
            errors.is_empty(),
            "Error closing adapters: {}",
            errors.join(", ")
        );
        Ok(())
    }
    fn for_route(&self, route: &Value) -> Result<&dyn Adapter, EffectError> {
        self.adapters
            .iter()
            .find(|(name, _)| Some(*name) == route["platform"].as_str())
            .map(|(_, a)| a.as_ref())
            .ok_or_else(|| EffectError::rejected("Messenger not configured for this route"))
    }
    async fn activity(&self, message: &Value, state: &str) -> Result<Value, EffectError> {
        let route = &message["route"];
        self.rooms.owner_route(route)?;
        let adapter = self.for_route(route)?;
        let key = serde_json::to_string(&[
            &route["platform"],
            &route["accountId"],
            &route["authorityId"],
            &route["guildId"],
            &route["channelId"],
            &route["threadId"],
            &message["messageId"],
        ])
        .map_err(|_| EffectError::rejected("Invalid message identity"))?;
        let entry = self
            .activity
            .lock()
            .map_err(|_| EffectError::uncertain("Reaction queue unavailable"))?
            .entry(key.clone())
            .or_default()
            .clone();
        let mut thinking = entry.lock().await;
        if state == "received" && *thinking {
            return Ok(Value::Null);
        }
        match state {
            "thinking" => *thinking = true,
            "idle" => *thinking = false,
            "received" => (),
            _ => return Err(EffectError::rejected("Unknown activity")),
        }
        let result = adapter
            .effect("setActivity", &[message.clone(), json!(state)])
            .await;
        if !*thinking {
            let mut queues = self
                .activity
                .lock()
                .map_err(|_| EffectError::uncertain("Reaction queue unavailable"))?;
            if Arc::strong_count(&entry) == 2 {
                queues.remove(&key);
            }
        }
        result
    }

    pub(crate) fn authorize_effect<'a>(&self, op: &str, args: &'a [Value]) -> Result<&'a Value, EffectError> {
        let arg = args
            .first()
            .ok_or_else(|| EffectError::rejected("Missing messenger arguments"))?;
        let route = match op {
            "send" | "showApproval" | "dismissApproval" | "discordPurpose" | "setActivity" => &arg["route"],
            "assertRoute" | "canCreateThread" | "createThread" | "inspectThread" | "updateThread"
            | "inspectDiscordContext" | "fetchAfter" => arg,
            _ => return Err(EffectError::rejected("Unknown messenger operation")),
        };
        self.rooms.owner_route(route)?;
        Ok(route)
    }

    pub(crate) async fn send_group(&self, output: Value) -> Result<Value, EffectError> {
        let adapter = self.for_route(&output["route"])?;
        adapter.effect("sendGroup", &[output]).await
    }

    pub async fn effect(&self, op: &str, args: &[Value]) -> Result<Value, EffectError> {
        let route = self.authorize_effect(op, args)?;
        match op {
            "setActivity" => {
                return self
                    .activity(&args[0], args.get(1).and_then(Value::as_str).unwrap_or(""))
                    .await;
            }
            "assertRoute" if !self.started.load(Ordering::Acquire) => {
                return Err(EffectError::rejected("Messenger not ready"));
            }
            _ => {}
        }
        if route["platform"] != "discord"
            && ((op == "canCreateThread" && args.len() > 1)
                || (op == "createThread" && args.len() > 3))
        {
            return Err(EffectError::rejected(
                "Forum tags are only supported on Discord",
            ));
        }
        self.for_route(route)?.effect(op, args).await
    }
    pub async fn attachment(
        &self,
        route: &Value,
        file: &Value,
    ) -> Result<reqwest::Response, EffectError> {
        self.rooms.owner_route(route)?;
        self.for_route(route)?.attachment(route, file).await
    }
}
