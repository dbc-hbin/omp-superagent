use std::borrow::Cow;

use reqwest::Method;
use serde::Deserialize;
use serde_json::{Value, json};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::sync::mpsc;

use crate::group::{Candidate, Output as GroupOutput};
use crate::store::DiscordSourceReceipt;

use super::addressing::addressed_text;
use super::outputs::{attachment_url, nonce};
use super::rest::{Rest, broken, no_mentions};
use super::voice::{Command, Voice};
use super::{
    Effect, EffectError, State,
    model::{
        Channel, Message, Reference, ReferencedMessage, RemoteMessage, Route, User, actual_guild,
        hash, snowflake, snowflake_time,
    },
};

const VOICE_DRAFT_HEADER: &str = "Proposed work from the live voice session (not yet submitted).\n";

pub(super) enum CandidateKind {
    Owner(Option<Route>),
    Group,
}

pub(super) struct LiveWire {
    pub data: Value,
    pub group: bool,
}

fn edit_time(text: &str) -> Option<i64> {
    let epoch = OffsetDateTime::parse(text, &Rfc3339)
        .ok()?
        .unix_timestamp_nanos();
    i64::try_from(epoch / 1_000_000).ok()
}

fn attachment_values(message: &Message) -> Vec<Value> {
    message
        .attachments
        .iter()
        .filter_map(|file| {
            let url = attachment_url(&file.url)?;
            let mut segments = url.path_segments()?.skip(1);
            if file.size > 9_007_199_254_740_991
                || segments.next() != Some(message.channel_id.as_str())
                || segments.next() != Some(file.id.as_str())
            {
                return None;
            }
            let mut value =
                json!({ "id": file.id, "name": file.filename, "url": file.url, "size": file.size });
            if let Some(content) = file.content_type.as_ref().filter(|s| !s.is_empty()) {
                value["contentType"] = json!(content);
            }
            if message.flags & (1 << 13) != 0 {
                value["voice"] = Value::Bool(true);
            }
            if let Some(seconds) = file
                .duration_secs
                .filter(|seconds| seconds.is_finite() && *seconds >= 0.0)
            {
                value["durationSeconds"] = json!(seconds);
            }
            Some(value)
        })
        .collect()
}

pub(super) fn authorized_message(message: &Message, route: &Route) -> bool {
    message.author.id == route.authority_id
        && !message.author.bot
        && message.webhook_id.is_none()
        && matches!(message.kind, 0 | 19)
        && message.matches(route)
}

fn message_input(message: &Message, route: &Route) -> Option<Value> {
    let attachments = attachment_values(message);
    if message.content.trim().is_empty() && attachments.is_empty() {
        return None;
    }
    let (received_at, revision) = match &message.edited_timestamp {
        None => (json!(snowflake_time(&message.id)?), "original".to_owned()),
        Some(stamp) => {
            let timestamp = edit_time(stamp)?;
            let mut metadata: Vec<_> = attachments
                .iter()
                .map(|file| json!([file["id"], file["name"], file["size"], file["contentType"]]))
                .collect();
            metadata.sort_by(|a, b| a[0].as_str().cmp(&b[0].as_str()));
            let digest = hash(&json!([message.content, metadata]));
            (json!(timestamp), format!("edit:{timestamp}:{digest}"))
        }
    };
    Some(json!({
        "id": format!("discord:{}:{}:{revision}", route.account_id, message.id),
        "route": route, "messageId": message.id, "text": message.content,
        "receivedAt": received_at, "attachments": attachments
    }))
}

pub(super) fn reply_id<'a>(message: &'a Message, route: &Route) -> Option<(&'a str, &'a Reference)> {
    let reference = message.message_reference.as_ref()?;
    let id = reference.message_id.as_deref()?;
    (message.kind == 19
        && snowflake(id)
        && id != message.id
        && reference.channel_id.as_deref() == Some(route.destination())
        && actual_guild(reference.guild_id.as_deref(), route))
    .then_some((id, reference))
}

impl State {
    pub(super) async fn intake_candidate(&self, raw: &Value, create: bool) -> Option<CandidateKind> {
        let channel_id = raw["channel_id"].as_str().filter(|id| snowflake(id))?;
        let raw_guild = raw["guild_id"].as_str();
        if !raw["id"].as_str().is_some_and(snowflake)
            || !self.allowed_guild(raw_guild)
            || raw["webhook_id"].is_string()
        {
            return None;
        }
        let author = match raw.get("author") {
            Some(raw) => {
                let user = User::deserialize(raw).ok()?;
                if user.bot || (user.id != self.config.owner_id
                    && !(create && self.ctx.has_group_actor(raw_guild, &user.id)))
                {
                    return None;
                }
                Some(user.id)
            }
            None if create => return None,
            None => None,
        };
        // Most message updates are its system-owned renders or pin changes.
        // Keep only candidates that actually report editing user content/files,
        // including partial edit events with no author or message payload.
        if !create
            && raw["edited_timestamp"].is_null()
            && raw.get("content").is_none()
            && raw.get("attachments").is_none()
        {
            return None;
        }
        let owner_possible = author.as_deref().is_none_or(|id| id == self.config.owner_id);
        let channels = self.channels.read().await;
        let Some(channel) = channels.get(channel_id) else {
            return Some(if owner_possible { CandidateKind::Owner(None) } else { CandidateKind::Group });
        };
        let exact = create || raw.get("guild_id").is_some();
        if exact && channel.guild_id.as_deref() != raw_guild {
            return None;
        }
        let route = self.route_for(channel).ok()?;
        if let Some(room) = self.ctx.group_room(route.guild_id.as_deref(), &route.channel_id) {
            return (create && author.as_deref().is_some_and(|id| room.permits(id)))
                .then_some(CandidateKind::Group);
        }
        owner_possible.then_some(CandidateKind::Owner(Some(route)))
    }

    pub(super) fn voice_control<'a>(&self, raw: &'a Value, voice: &Voice) -> Option<Cow<'a, str>> {
        let original = raw["content"].as_str()?;
        let channel = raw["channel_id"].as_str()?;
        if self.config.require_addressing && raw["guild_id"].is_string()
            && let Some(account) = self.identity.get()
            && let Ok(message) = Message::deserialize(raw)
            && let Some(text) = addressed_text(&message, &account.account)
            && voice.is_control_text(channel, &text)
        {
            return Some(Cow::Owned(text));
        }
        voice.is_control_text(channel, original).then_some(Cow::Borrowed(original))
    }

    fn addressing_enabled(&self, route: &Route) -> bool {
        self.config.require_addressing && route.guild_id.is_some()
    }

    async fn snapshot_reply(&self, message: &Message, route: &Route, proof: bool) -> Effect<Option<Value>> {
        let Some((id, reference)) = reply_id(message, route) else {
            return Ok(None);
        };
        if proof && reference.kind != 0 {
            return Ok(None);
        }
        let matches = |source: &ReferencedMessage| {
            source.id == id
                && source.channel_id == route.destination()
                && actual_guild(source.guild_id.as_deref(), route)
        };
        let source = match message.referenced_message.as_deref() {
            Some(source) if matches(source) => Some(Cow::Borrowed(source)),
            Some(_) if proof => return Ok(None),
            _ => match self.rest.evidence::<ReferencedMessage>(&format!(
                "channels/{}/messages/{id}",
                route.destination()
            )).await {
                Ok(Some(source)) if matches(&source) => Some(Cow::Owned(source)),
                Ok(Some(_)) if proof => {
                    return Err(broken("Discord reply lookup did not match its requested source"));
                }
                Ok(Some(_) | None) => None,
                // If address proof is required, an unavailable lookup cannot
                // become a denial: catch-up must not return any later inputs.
                Err(error) if proof => return Err(error),
                Err(_) => None,
            }
        };
        let source = source.as_deref();
        if proof && !source.is_some_and(|value| {
            value.author.bot && value.author.id == route.account_id && value.webhook_id.is_none()
        }) {
            return Ok(None);
        }
        let author = source.map(|value| &value.author.id);
        let text = source
            .filter(|source| {
                source.author.id != route.account_id
                    || !source.content.starts_with(VOICE_DRAFT_HEADER)
            })
            .map(|source| &source.content);
        Ok(Some(json!({ "messageId": id, "authorId": author, "text": text })))
    }

    pub(super) async fn voice_message(
        &self,
        raw: &Value,
        text: &str,
        outbound: &mpsc::Sender<Value>,
    ) -> Effect<()> {
        let Some(voice) = &self.voice else {
            return Ok(());
        };
        if outbound.is_closed() {
            return Ok(());
        }
        let Ok(message) = serde_json::from_value::<Message>(raw.clone()) else {
            return Ok(());
        };
        // Voice control must never block heartbeat or urgent revocation on a
        // REST lookup. A live guild snapshot proves the configured text route.
        let Some(channel) = self.channels.read().await.get(&message.channel_id).cloned() else {
            return Ok(());
        };
        let route = self.route_for(&channel)?;
        if self.group_route(&route) {
            return Ok(());
        }
        if !authorized_message(&message, &route)
            || route.guild_id.is_none()
            || route.guild_id != message.guild_id
            || route.thread_id.is_some()
            || outbound.is_closed()
            || self.stopping.load(std::sync::atomic::Ordering::Acquire)
        {
            return Ok(());
        }
        let Some(mut input) = message_input(&message, &route) else {
            return Ok(());
        };
        // Pass only the canonical command to parsing. Its original physical
        // text and exact reply identity remain available for the draft receipt.
        let mut command = raw.clone();
        command["content"] = json!(text);
        match voice
            .command(&command, outbound)
            .await
            .map_err(|_| broken("Discord voice command failed"))?
        {
            Command::Ignore | Command::Consumed => (),
            Command::Confirmed(text) => {
                let original = std::mem::replace(&mut input["text"], json!(text));
                input["discordOriginalText"] = original;
                input["attachments"] = json!([]);
                input["discordContext"] = self.context_snapshot(&route, Some(&channel)).await;
                self.admit(json!({"kind": "message", "input": input}))?;
            }
        }
        Ok(())
    }

    pub(super) async fn group_dispatch(&self, raw: &Value) -> Effect<()> {
        let Some(channel_id) = raw["channel_id"].as_str() else {
            return Ok(());
        };
        let channel = self.channel_by_id(channel_id, false).await?;
        let Ok(route) = self.route_for(&channel) else {
            return Ok(());
        };
        if self.group_route(&route)
            && route.guild_id.as_deref() == raw["guild_id"].as_str()
        {
            self.group_message(&route, raw)?;
        }
        Ok(())
    }

    pub(super) fn group_message(&self, route: &Route, raw: &Value) -> Effect<()> {
        let Ok(message) = Message::deserialize(raw) else { return Ok(()) };
        if message.author.bot
            || raw["author"]["system"] == true
            || !snowflake(&message.author.id)
            || message.author.id == route.account_id
            || message.webhook_id.is_some()
            || !matches!(message.kind, 0 | 19)
            || message.edited_timestamp.is_some()
            || !message.attachments.is_empty()
            || message.flags & (1 << 13) != 0
            || !message.matches(route)
            || ["message_snapshots", "sticker_items", "stickers", "poll", "application_id", "interaction_metadata"]
                .iter().any(|key| raw.get(*key).is_some_and(|value| {
                    !value.is_null() && !value.as_array().is_some_and(Vec::is_empty)
                }))
        {
            return Ok(());
        }
        let Some(sent_ms) = snowflake_time(&message.id).and_then(|ms| i64::try_from(ms).ok()) else {
            return Ok(());
        };
        self.ctx.admit_group(json!(route), Candidate {
            message_id: &message.id,
            user_id: &message.author.id,
            text: &message.content,
            sent_ms,
            qualified_command: None,
        }).map_err(|_| broken("Discord group admission could not be confirmed"))
    }

    pub(super) async fn send_group(&self, output: GroupOutput<Route>) -> Effect<String> {
        let channel = self.destination(&output.route).await?;
        let nonce = nonce(&output.id, &output.route, 0);
        let request = self.rest.request(Method::POST, &format!("channels/{}/messages", channel.id))
            .json(&json!({
                "content": output.text, "allowed_mentions": no_mentions(), "flags": 4,
                "nonce": nonce, "enforce_nonce": true,
                "message_reference": {"message_id": output.message_id, "fail_if_not_exists": true},
            }));
        let receipt: RemoteMessage = Rest::response(request).await?;
        if !receipt.belongs(&output.route) || !snowflake(&receipt.id) {
            return Err(broken("Discord group reply receipt could not be verified"));
        }
        Ok(receipt.id)
    }

    pub(super) async fn with_context(
        &self,
        message: &Message,
        route: &Route,
        channel: &Channel,
        addressing: bool,
    ) -> Effect<Option<Value>> {
        if !authorized_message(message, route) {
            return Ok(None);
        }
        let text = addressing
            .then(|| addressed_text(message, &route.account_id))
            .flatten();
        // Edits, catch-up and stale dispatches can never run voice commands
        // or submit a voice control to the ordinary head.
        let voice_control = self.voice.as_ref().is_some_and(|voice| {
            voice.is_control_text(&message.channel_id, &message.content)
                || text.as_deref().is_some_and(|text| voice.is_control_text(&message.channel_id, text))
        });
        let Some(mut input) = message_input(message, route) else {
            return Ok(None);
        };
        if route.guild_id.is_some() {
            // Before source provenance was stored, this exact original reply
            // could have been projected into an already-admitted voice draft.
            let confirmation = route.thread_id.is_none()
                && message.content == "/voice confirm"
                && message.edited_timestamp.is_none()
                && message.attachments.is_empty()
                && reply_id(message, route).is_some_and(|(_, reference)| reference.kind == 0);
            match self.ctx.discord_admitted_input(&input, confirmation)
                .map_err(|_| broken("Discord admitted source could not be verified"))?
            {
                DiscordSourceReceipt::Admitted(saved) => return Ok(Some(saved)),
                DiscordSourceReceipt::LegacyVoiceConfirmation => return Ok(None),
                DiscordSourceReceipt::Absent => (),
            }
        }
        if voice_control {
            return Ok(None);
        }
        // Only threads this bot created continue without addressing; a thread
        // another bot or person started is a shared conversation like its parent.
        let own_thread = route.thread_id.is_some()
            && channel.owner_id.as_deref() == Some(route.account_id.as_str());
        let proof = addressing && !own_thread && text.is_none();
        if let Some(text) = text.filter(|text| !Voice::matches_control(text)) {
            if text.is_empty() && input["attachments"].as_array().is_some_and(Vec::is_empty) {
                return Ok(None);
            }
            let original = std::mem::replace(&mut input["text"], json!(text));
            input["discordOriginalText"] = original;
        }
        if let Some(reply) = self.snapshot_reply(message, route, proof).await? {
            input["reply"] = reply;
        } else if proof {
            return Ok(None);
        }
        input["discordContext"] = self.context_snapshot(route, Some(channel)).await;
        Ok(Some(input))
    }

    pub(super) async fn fetch_after(&self, route: &Route, cursor: &str) -> Effect<Value> {
        if !snowflake(cursor) {
            return Err(EffectError::rejected(
                "Catchup requires a stored Discord message snowflake",
            ));
        }
        let route = route.physical();
        self.assert_route(&route)?;
        if self.group_route(&route) {
            return Err(EffectError::rejected("Discord group rooms do not allow history recovery"));
        }
        self.assert_live_intake_drained(&route)?;
        let cached = self.channels.read().await.get(route.destination()).cloned();
        let channel = match cached {
            Some(channel) => channel,
            None => {
                let Some(channel) = self.rest.history_lookup::<Channel>(
                    &format!("channels/{}", route.destination()),
                ).await? else { return Ok(Value::Null) };
                if channel.id != route.destination() {
                    return Err(broken("Discord history channel did not match its requested destination"));
                }
                self.remember_channel(channel.clone()).await;
                channel
            }
        };
        if self.route_for(&channel)? != route {
            return Err(EffectError::rejected("Discord destination identity changed"));
        }
        let channel = channel.sendable()?;
        let mut after = cursor.to_owned();
        let mut inputs = Vec::new();
        loop {
            let page: Option<Vec<Value>> = self
                .rest
                .history_lookup(&format!(
                    "channels/{}/messages?after={after}&limit=100",
                    channel.id
                ))
                .await?;
            let Some(page) = page else { return Ok(Value::Null) };
            let count = page.len();
            let mut messages =
                page.into_iter()
                    .map(|raw| {
                        let message = Message::deserialize(&raw)
                            .map_err(|_| broken("Discord history contained an invalid message"))?;
                        let id = message.id.parse::<u64>().map_err(|_| {
                            broken("Discord history contained an invalid message ID")
                        })?;
                        if !message.matches(&route) {
                            return Err(broken(
                                "Discord history destination did not match its request",
                            ));
                        }
                        Ok((id, message))
                    })
                    .collect::<Effect<Vec<_>>>()?;
            messages.sort_unstable_by_key(|(id, _)| *id);
            let previous = after
                .parse::<u64>()
                .map_err(|_| broken("Discord history cursor could not be verified"))?;
            for (id, message) in messages {
                if id <= previous {
                    return Err(broken("Discord history cursor did not advance"));
                }
                after = message.id.clone();
                if let Some(input) = self.with_context(&message, &route, &channel, self.addressing_enabled(&route)).await? {
                    inputs.push(input);
                }
            }
            if count < 100 {
                break;
            }
        }
        self.assert_live_intake_drained(&route)?;
        Ok(Value::Array(inputs))
    }
}
