use std::time::Duration;

use anyhow::Result;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::{
    sync::{Mutex, watch},
    time::Instant,
};

use crate::store::{
    AuthorityError,
    discord_presence::{Action, Attempt, Intent},
    js_trim,
};

use super::{
    Effect, EffectError, State,
    model::{Route, User, read, snowflake, utf16},
    rest::broken,
    socket::{Socket, text},
};

// Discord allows five presence updates per 20 seconds. Use conservative
// spacing and keep the deadline across changes of physical WebSocket.
const SPACING: Duration = Duration::from_secs(5);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    action: Action,
    source_id: String,
    route: Route,
}

#[derive(Clone, Copy, Default)]
enum Connection {
    #[default]
    Disconnected,
    Connected { last_sent: Option<Intent> },
}

#[derive(Default)]
pub(super) struct Presence {
    desired: watch::Sender<Option<Intent>>,
    connection: watch::Sender<Connection>,
    // Linearize an outgoing presence write with the durable intent update.
    // Never enqueue a frame which could outlive the intent it implements.
    order: Mutex<()>,
}

impl Presence {
    pub(super) fn link(&self) -> ConnectionScope<'_> {
        ConnectionScope {
            presence: self,
            desired: self.desired.subscribe(),
        }
    }

    fn last_sent(&self) -> Option<Intent> {
        match *self.connection.borrow() {
            Connection::Disconnected => None,
            Connection::Connected { last_sent } => last_sent,
        }
    }
}

pub(super) struct ConnectionScope<'a> {
    presence: &'a Presence,
    desired: watch::Receiver<Option<Intent>>,
}

impl ConnectionScope<'_> {
    pub(super) fn connected(&self, last_sent: Option<Intent>) {
        self.presence.connection.send_replace(Connection::Connected { last_sent });
    }

    pub(super) async fn identify(
        &mut self,
        socket: &mut Socket,
        mut identify: Value,
    ) -> Result<Option<Intent>> {
        let _order = self.presence.order.lock().await;
        let desired = *self.desired.borrow_and_update();
        if let Some(intent) = desired {
            identify["d"]["presence"] = payload(intent);
        }
        text(socket, identify).await?;
        Ok(desired)
    }

    pub(super) fn pending(&mut self) -> Option<Intent> {
        let desired = *self.desired.borrow_and_update();
        desired.filter(|intent| Some(*intent) != self.presence.last_sent())
    }

    pub(super) async fn changed(&mut self) -> Result<()> {
        Ok(self.desired.changed().await?)
    }

    pub(super) async fn update(
        &mut self,
        socket: &mut Socket,
        allowed: &mut Option<Instant>,
    ) -> Result<()> {
        let _order = self.presence.order.lock().await;
        let latest = *self.desired.borrow_and_update();
        if let Some(intent) = latest.filter(|intent| Some(*intent) != self.presence.last_sent()) {
            // A failed write may have reached the remote socket.
            *allowed = Some(Instant::now() + SPACING);
            text(socket, json!({"op":3,"d":payload(intent)})).await?;
            self.connected(Some(intent));
        }
        Ok(())
    }
}

impl Drop for ConnectionScope<'_> {
    fn drop(&mut self) {
        self.presence.connection.send_replace(Connection::Disconnected);
    }
}

fn payload(intent: Intent) -> Value {
    json!({"since":null,"activities":[],"status":intent.status(),"afk":false})
}

impl State {
    pub(super) async fn restore_presence(&self) -> Result<Option<String>> {
        let store = self.ctx.discord_presence();
        if !store.has_discord_presence()? {
            return Ok(None);
        }
        // IDENTIFY precedes READY. Ask the same authenticated bot REST client
        // which account owns the token before adding any saved presence to it.
        match self.rest.get::<User>("users/@me").await {
            Ok(bot) if bot.bot && snowflake(&bot.id) => {
                self.presence.desired.send_replace(store.discord_presence(&bot.id)?);
                Ok(Some(bot.id))
            }
            _ => {
                eprintln!("Discord presence pre-identification unavailable; waiting for READY");
                Ok(None)
            }
        }
    }

    pub(super) async fn restore_ready_presence(&self) -> Result<()> {
        if let Some(identity) = self.identity.get() {
            let _order = self.presence.order.lock().await;
            let desired = self.ctx.discord_presence().discord_presence(&identity.account)?;
            self.presence.desired.send_replace(desired);
        }
        Ok(())
    }

    pub(super) async fn set_presence(&self, id: &str, raw: &Value) -> Effect<Value> {
        let Request { action, source_id, route } = read(raw)?;
        if js_trim(&source_id).is_empty()
            || utf16(&source_id) > 1000
            || raw["route"].get("guildId").is_none()
            || raw["route"].get("threadId").is_none()
            || raw["route"].get("topicId").is_some_and(|value| {
                value.as_str().is_none_or(|topic| js_trim(topic).is_empty())
            })
        {
            return Err(EffectError::rejected("Invalid messenger presence request"));
        }
        self.channel(&route, false).await?;
        if self.group_route(&route) {
            return Err(EffectError::rejected(
                "Owner operations are disabled in restricted group rooms",
            ));
        }
        let _order = self.presence.order.lock().await;
        let snapshot = self.ctx.discord_presence().apply_discord_presence(Attempt {
            id,
            source_id: &source_id,
            account_id: &route.account_id,
            action,
            request: raw,
        }).map_err(|error| {
            if let Some(authority) = error.downcast_ref::<AuthorityError>() {
                EffectError::rejected(authority.0)
            } else {
                broken("Discord presence state could not be confirmed")
            }
        })?;
        self.presence.desired.send_if_modified(|current| {
            if *current == snapshot.desired {
                return false;
            }
            *current = snapshot.desired;
            true
        });
        let (connection, last_sent) = match *self.presence.connection.borrow() {
            Connection::Disconnected => ("disconnected", None),
            Connection::Connected { last_sent } => ("connected", last_sent),
        };
        Ok(json!({
            "platform": "discord",
            "desired": snapshot.desired.map_or("default", Intent::status),
            "connection": connection,
            "lastSent": last_sent,
            "replayed": snapshot.replayed,
        }))
    }
}
