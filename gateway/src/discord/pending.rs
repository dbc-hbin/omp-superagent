use std::{future::{Future, ready}, time::Duration};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::{
    Effect, State,
    addressing::addressed_text,
    ingress::{LiveWire, authorized_message},
    message_source::Revision,
    model::{Channel, Message, Route, hash},
    rest::broken,
};

#[derive(Deserialize, Serialize)]
enum Evidence {
    Coordinates(Revision),
    Wire { route: Route, source: Value },
    Verified { route: Route, message: Box<Message> },
}

#[derive(Deserialize, Serialize)]
enum RouteAuthority {
    Bound(Route),
    Policy(String),
}

#[derive(Deserialize, Serialize)]
pub(super) struct Pending {
    account_id: String,
    owner_id: String,
    id: String,
    channel_id: String,
    guild_id: Option<String>,
    exact_guild: bool,
    create: bool,
    require_addressing: bool,
    evidence: Evidence,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    coordinate_authority: Option<RouteAuthority>,
}

struct Verified {
    route: Route,
    channel: Channel,
    message: Box<Message>,
    needs_pin: bool,
}

enum Resolution {
    Refused,
    LiveGroup(Route),
    Owner(Box<Verified>),
}

fn project(value: &Value, fields: &[&str]) -> Value {
    if value.is_null() {
        return Value::Null;
    }
    Value::Object(fields.iter().filter_map(|key| {
        value.get(*key).map(|value| ((*key).to_owned(), value.clone()))
    }).collect())
}

fn project_owner_source(raw: &Value) -> Value {
    let mut source = project(raw, &[
        "id", "channel_id", "guild_id", "author", "type", "webhook_id", "content",
        "mentions", "edited_timestamp", "attachments", "flags", "message_reference",
        "referenced_message",
    ]);
    const USER: &[&str] = &["id", "bot"];
    for (key, fields) in [
        ("author", USER),
        ("message_reference", &["type", "message_id", "channel_id", "guild_id"]),
        ("referenced_message", &["id", "channel_id", "guild_id", "author", "webhook_id", "content"]),
    ] {
        if let Some(value) = source.get_mut(key) {
            *value = project(value, fields);
        }
    }
    if let Some(author) = source.get_mut("referenced_message").and_then(|value| value.get_mut("author")) {
        *author = project(author, USER);
    }
    for (key, fields) in [
        ("mentions", USER),
        ("attachments", &["id", "filename", "url", "size", "content_type", "duration_secs"]),
    ] {
        if let Some(items) = source.get_mut(key).and_then(Value::as_array_mut) {
            for item in items {
                *item = project(item, fields);
            }
        }
    }
    source
}

impl Pending {
    pub(super) fn from_dispatch(state: &State, raw: &Value, create: bool, route: Option<Route>) -> Option<Self> {
        let identity = state.identity.get()?;
        let (evidence, coordinate_authority) = match route {
            Some(route) if raw["author"]["id"] == state.config.owner_id => {
                (Evidence::Wire { route, source: project_owner_source(raw) }, None)
            }
            route => (
                Evidence::Coordinates(Revision::from_wire(raw, create)?),
                Some(route.map_or_else(
                    || RouteAuthority::Policy(state.owner_policy_digest()),
                    RouteAuthority::Bound,
                )),
            ),
        };
        Some(Self {
            account_id: identity.account.clone(),
            owner_id: state.config.owner_id.clone(),
            id: raw["id"].as_str()?.to_owned(),
            channel_id: raw["channel_id"].as_str()?.to_owned(),
            guild_id: raw["guild_id"].as_str().map(str::to_owned),
            exact_guild: create || raw.get("guild_id").is_some(),
            require_addressing: state.config.require_addressing,
            create,
            evidence,
            coordinate_authority,
        })
    }

    pub(super) fn record(&self, state: &State) -> anyhow::Result<i64> {
        state.ctx.discord_intake().push(
            (&self.account_id, &self.owner_id, &self.channel_id),
            &serde_json::to_string(self)?,
        )
    }

    fn addressing(&self, state: &State, route: &Route) -> bool {
        // Policy changes never weaken a still-unadmitted candidate's proof.
        route.guild_id.is_some() && (self.require_addressing || state.config.require_addressing)
    }

    async fn resolve(&self, state: &State, live: Option<&LiveWire>) -> Effect<Resolution> {
        if state.identity.get().map(|identity| &identity.account) != Some(&self.account_id)
            || state.config.owner_id != self.owner_id
            || !state.allowed_guild(self.guild_id.as_deref())
            || matches!(&self.evidence, Evidence::Coordinates(_)) && self.coordinate_authority.is_none()
        {
            return Ok(Resolution::Refused);
        }
        let channel = state.channels.read().await.get(&self.channel_id).cloned();
        let channel = match channel {
            Some(channel) => channel,
            None => {
                let Some(channel) = state.rest.evidence::<Channel>(&format!("channels/{}", self.channel_id)).await?
                else { return Ok(Resolution::Refused) };
                if channel.id != self.channel_id {
                    return Err(broken("Discord channel lookup did not match its requested source"));
                }
                state.remember_channel(channel.clone()).await;
                channel
            }
        };
        if self.exact_guild && self.guild_id != channel.guild_id {
            return Ok(Resolution::Refused);
        }
        let Ok(route) = state.route_for(&channel) else { return Ok(Resolution::Refused) };
        if state.group_route(&route) {
            // The durable record is never a basis for a group effect.
            return Ok(if live.is_some_and(|wire| wire.group) {
                Resolution::LiveGroup(route)
            } else {
                Resolution::Refused
            });
        }
        let addressing = self.addressing(state, &route);
        let mut needs_pin = true;
        let message = match &self.evidence {
            Evidence::Coordinates(revision) => {
                let originally_allowed = match &self.coordinate_authority {
                    Some(RouteAuthority::Bound(expected)) => *expected == route,
                    // An unseen guild channel's parent was not established
                    // at receipt. A new allowlist cannot prove old authority.
                    Some(RouteAuthority::Policy(digest)) => route.guild_id.is_none()
                        || *digest == state.owner_policy_digest(),
                    None => false,
                };
                if !originally_allowed {
                    return Ok(Resolution::Refused);
                }
                match live {
                    Some(wire) if wire.data.get("author").is_some() => {
                        state.verify_wire(&wire.data, self.create, &route, &channel, addressing).await?
                    }
                    _ => state.hydrate_source(&self.id, &route, self.create, revision, addressing).await?,
                }
            }
            Evidence::Wire { route: expected, source } if *expected == route => {
                state.verify_wire(source, self.create, &route, &channel, addressing).await?
            }
            Evidence::Verified { route: expected, message } if *expected == route => {
                // Earlier Gateways pinned some thread reply edits without their
                // reference. Preserve an admission receipt; otherwise recover
                // the missing proof from this revision only, then pin it.
                if !self.create && addressing && channel.is_thread()
                    && !channel.is_thread_owned_by(&route.account_id)
                    && message.kind == 19 && message.message_reference.is_none()
                    && addressed_text(message, &route.account_id).is_none()
                    && state.with_context(message, &route, &channel, addressing).await?.is_none()
                {
                    let Value::Object(mut wire) = json!(message) else {
                        return Err(broken("Discord pinned message could not be projected"));
                    };
                    wire.remove("message_reference");
                    state.verify_wire(&Value::Object(wire), false, &route, &channel, addressing).await?
                } else {
                    needs_pin = false;
                    Some(message.as_ref().clone())
                }
            }
            Evidence::Wire { .. } | Evidence::Verified { .. } => return Ok(Resolution::Refused),
        };
        let Some(message) = message.filter(|message| message.id == self.id && authorized_message(message, &route))
        else { return Ok(Resolution::Refused) };
        Ok(Resolution::Owner(Box::new(Verified { route, channel, message: Box::new(message), needs_pin })))
    }
}

impl State {
    fn owner_policy_digest(&self) -> String {
        let mut guilds: Vec<_> = self.config.allowed_guild_ids.iter().collect();
        let mut parents: Vec<_> = self.config.allowed_channel_ids.iter().collect();
        let mut groups: Vec<_> = self.ctx.group_destinations().collect();
        guilds.sort_unstable();
        parents.sort_unstable();
        groups.sort_unstable();
        hash(&json!([guilds, parents, groups]))
    }

    pub(super) fn assert_live_intake_drained(&self, route: &Route) -> Effect<()> {
        if self.ctx.discord_intake().contains((&route.account_id, &route.authority_id, route.destination()))
            .map_err(|_| broken("Discord pending intake is unavailable"))?
        {
            return Err(broken("Discord history is held for ordered live address verification"));
        }
        Ok(())
    }

    pub(super) async fn drain_owner_intake(&self, through: i64, live: Option<&LiveWire>) {
        let journal = self.ctx.discord_intake();
        while let Some((sequence, mut pending)) = retry(|| ready(
            journal.next(through)
                .and_then(|row| row.map(|(id, data)| Ok((id, serde_json::from_str::<Pending>(&data)?))).transpose())
                .map_err(|_| broken("Discord pending intake could not be read")),
        )).await {
            let wire = live.filter(|_| sequence == through);
            let group = match retry(|| pending.resolve(self, wire)).await {
                Resolution::Refused => None,
                Resolution::LiveGroup(route) => Some(route),
                Resolution::Owner(owner) => {
                    let Verified { route, channel, message, needs_pin } = *owner;
                    // Pin immediately after source/authority verification.
                    // A second, independent reply read may fail and must never
                    // cause us to hydrate a now-superseded message revision.
                    if needs_pin {
                        pending.evidence = Evidence::Verified { route: route.clone(), message: message.clone() };
                        pending.coordinate_authority = None;
                        retry(|| ready(
                            serde_json::to_string(&pending)
                                .map_err(Into::into)
                                .and_then(|data| journal.pin(sequence, &data))
                                .map_err(|_| broken("Discord verified source could not be recorded")),
                        )).await;
                    }
                    let addressing = pending.addressing(self, &route);
                    if let Some(input) = retry(|| self.with_context(&message, &route, &channel, addressing)).await {
                        let event = json!({"kind":"message","input":input});
                        // Local admission is idempotent. If its receipt was
                        // committed before interruption, no reaction re-runs.
                        retry(|| ready(self.admit(event.clone()))).await;
                    }
                    None
                }
            };
            retry(|| ready(journal.retire(sequence)
                .map_err(|_| broken("Discord pending intake could not be retired")))).await;
            if let (Some(route), Some(wire)) = (group, wire)
                && self.group_message(&route, &wire.data).is_err()
            {
                eprintln!("Discord live group intake was not confirmed; not retrying");
            }
        }
    }
}

async fn retry<T, F: Future<Output = Effect<T>>>(mut read: impl FnMut() -> F) -> T {
    let mut delay = Duration::from_millis(250);
    loop {
        match read().await {
            Ok(value) => return value,
            Err(error) => {
                if delay == Duration::from_millis(250) {
                    eprintln!("Discord owner intake held pending verification: {error}");
                }
                let wait = error.retry_after_ms.map(Duration::from_millis)
                    .map_or(delay, |advised| delay.max(advised));
                // The supervisor cancels the worker, including a read or wait.
                // Its journal row survives cancellation.
                tokio::time::sleep(wait).await;
                delay = delay.saturating_mul(2).min(Duration::from_secs(30));
            }
        }
    }
}
