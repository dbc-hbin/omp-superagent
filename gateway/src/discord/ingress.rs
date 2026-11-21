use std::borrow::Cow;

use serde::Deserialize;
use serde_json::{Value, json};
use reqwest::Method;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::sync::mpsc;

use crate::group::{Candidate, Output as GroupOutput};

use super::outputs::{attachment_url, nonce};
use super::rest::{Rest, broken, no_mentions};
use super::voice::Command;
use super::{
    Effect, EffectError, State,
    model::{
        Channel, Message, ReferencedMessage, RemoteMessage, Route, User, actual_guild, hash, snowflake,
        snowflake_time,
    },
};

const VOICE_DRAFT_HEADER: &str = "Proposed work from the live voice session (not yet submitted).\n";

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

fn authorized_message(message: &Message, route: &Route) -> bool {
    message.author.id == route.authority_id
        && !message.author.bot
        && message.webhook_id.is_none()
        && matches!(message.kind, 0 | 19)
        && message.matches(route)
}

fn inline_bot_mentions<'a>(text: &'a str, account: &'a str) -> impl Iterator<Item = (usize, usize)> + 'a {
    let bytes = text.as_bytes();
    let mut cursor = 0;
    let mut code_ticks = 0;
    std::iter::from_fn(move || {
        while let Some(&byte) = bytes.get(cursor) {
            match byte {
                b'\\' if code_ticks == 0
                    && bytes.get(cursor + 1).is_some_and(u8::is_ascii_punctuation) =>
                {
                    cursor += 2;
                }
                b'`' => {
                    let run = bytes[cursor..].iter().take_while(|&&b| b == b'`').count();
                    if code_ticks == 0 {
                        code_ticks = run;
                    } else if run == code_ticks {
                        code_ticks = 0;
                    }
                    cursor += run;
                }
                b'<' if code_ticks == 0 => {
                    let tail = &text[cursor + 1..];
                    let mention = tail.strip_prefix('@').and_then(|user| {
                        user.strip_prefix('!')
                            .unwrap_or(user)
                            .strip_prefix(account)?
                            .strip_prefix('>')
                    });
                    if let Some(after) = mention {
                        let end = text.len() - after.len();
                        let start = std::mem::replace(&mut cursor, end);
                        return Some((start, end));
                    }
                    cursor += 1;
                }
                _ => cursor += 1,
            }
        }
        None
    })
}

fn remove_bot_mentions<'a>(message: &'a Message, account: &str) -> Option<Cow<'a, str>> {
    // Discord can include the replied-to user in mentions without an inline mention.
    if !message.mentions.iter().any(|user| user.id == account) {
        return None;
    }
    let text = message.content.as_str();
    let mut mentions = inline_bot_mentions(text, account).peekable();
    let (start, end) = mentions.next()?;
    if mentions.peek().is_none() {
        if text[..start].trim().is_empty() {
            return Some(Cow::Borrowed(&text[end..]));
        }
        if text[end..].trim().is_empty() {
            return Some(Cow::Borrowed(&text[..start]));
        }
    }
    let mut result = String::with_capacity(text.len() - (end - start) + 1);
    let mut copied = 0;
    for (start, end) in std::iter::once((start, end)).chain(mentions) {
        result.push_str(&text[copied..start]);
        // Removing a tag must not join fragments into a new command.
        if result.ends_with(|ch: char| !ch.is_whitespace())
            && text[end..].starts_with(|ch: char| !ch.is_whitespace())
        {
            result.push(' ');
        }
        copied = end;
    }
    result.push_str(&text[copied..]);
    Some(Cow::Owned(result))
}

fn message_input(message: &Message, route: &Route, text: &str) -> Option<Value> {
    let attachments = attachment_values(message);
    if text.trim().is_empty() && attachments.is_empty() {
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
        "route": route, "messageId": message.id, "text": text,
        "receivedAt": received_at, "attachments": attachments
    }))
}

struct Reply<'a> {
    id: &'a str,
    source: Option<Cow<'a, ReferencedMessage>>,
}

impl Reply<'_> {
    fn addresses_bot(&self, route: &Route) -> bool {
        self.source
            .as_deref()
            .is_some_and(|source| source.author.bot && source.author.id == route.account_id)
    }

    fn snapshot(&self, route: &Route) -> Value {
        let source = self.source.as_deref();
        let author = source.map(|value| &value.author.id);
        let text = source
            .filter(|source| {
                source.author.id != route.account_id
                    || !source.content.starts_with(VOICE_DRAFT_HEADER)
            })
            .map(|source| &source.content);
        json!({ "messageId": self.id, "authorId": author, "text": text })
    }
}

impl State {
    pub(super) async fn intake_candidate(&self, raw: &Value, create: bool) -> bool {
        let Some(channel_id) = raw["channel_id"].as_str().filter(|id| snowflake(id)) else {
            return false;
        };
        let raw_guild = raw["guild_id"].as_str();
        if !raw["id"].as_str().is_some_and(snowflake)
            || !self.allowed_guild(raw_guild)
            || raw["webhook_id"].is_string()
        {
            return false;
        }
        let author = match raw.get("author") {
            Some(raw) => {
                let Ok(user) = User::deserialize(raw) else { return false };
                if user.bot || (user.id != self.config.owner_id
                    && !(create && self.ctx.has_group_actor(raw_guild, &user.id)))
                {
                    return false;
                }
                Some(user.id)
            }
            None if create => return false,
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
            return false;
        }
        self.channels
            .read()
            .await
            .get(channel_id)
            .is_none_or(|channel| {
                let known_guild = raw["guild_id"].as_str();
                let exact = create || raw.get("guild_id").is_some();
                (!exact || channel.guild_id.as_deref() == known_guild)
                    && self.route_for(channel).is_ok_and(|route| {
                        match self.ctx.group_room(route.guild_id.as_deref(), &route.channel_id) {
                            Some(room) => create && author.as_deref().is_some_and(|id| room.permits(id)),
                            None => author.as_deref().is_none_or(|id| id == self.config.owner_id),
                        }
                    })
            })
    }

    async fn incoming_channel(
        &self,
        channel_id: &str,
        guild_id: Option<&str>,
        exact: bool,
    ) -> Effect<Channel> {
        if !self.allowed_guild(guild_id) {
            return Err(EffectError::rejected("Discord guild is not authorized"));
        }
        let channel = self.channel_by_id(channel_id, false).await?;
        if exact && channel.guild_id.as_deref() != guild_id {
            return Err(EffectError::rejected(
                "Discord event channel identity changed",
            ));
        }
        Ok(channel)
    }

    fn addressing_enabled(&self, route: &Route) -> bool {
        self.config.require_addressing && route.guild_id.is_some()
    }

    fn has_edit_addressing_metadata(&self, raw: &Value, message: &Message, route: &Route) -> bool {
        if !self.addressing_enabled(route) {
            return true;
        }
        let has_mentions = raw.get("mentions").is_some();
        if route.thread_id.is_none() {
            return has_mentions && (message.kind != 19 || message.message_reference.is_some());
        }
        // A thread does not need addressing, but an inline tag can only be stripped
        // after Discord confirms the mention. Bare edits need no mention lookup.
        has_mentions
            || inline_bot_mentions(&message.content, &route.account_id)
                .next()
                .is_none()
    }

    async fn resolve_reply<'a>(
        &self,
        message: &'a Message,
        route: &Route,
        for_addressing: bool,
    ) -> Option<Reply<'a>> {
        let reference = message.message_reference.as_ref()?;
        let id = reference.message_id.as_deref()?;
        if message.kind != 19
            || (for_addressing && reference.kind != 0)
            || !snowflake(id)
            || reference.channel_id.as_deref() != Some(route.destination())
            || !actual_guild(reference.guild_id.as_deref(), route)
        {
            return None;
        }
        let matches = |source: &ReferencedMessage| {
            source.id == id
                && source.channel_id == route.destination()
                && actual_guild(source.guild_id.as_deref(), route)
        };
        let source = match message.referenced_message.as_deref() {
            Some(source) if matches(source) => Some(Cow::Borrowed(source)),
            Some(_) if for_addressing => return None,
            _ => self
                .rest
                .get::<ReferencedMessage>(&format!(
                    "channels/{}/messages/{id}",
                    route.destination()
                ))
                .await
                .ok()
                .filter(matches)
                .map(Cow::Owned),
        };
        Some(Reply { id, source })
    }

    pub(super) async fn voice_message(
        &self,
        raw: &Value,
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
        let Some(mut input) = message_input(&message, &route, &message.content) else {
            return Ok(());
        };
        // Only the separate, receipt-verified reply to a posted voice draft can
        // produce Confirmed text. Other voice controls never admit model input.
        match voice
            .command(raw, outbound)
            .await
            .map_err(|_| broken("Discord voice command failed"))?
        {
            Command::Ignore | Command::Consumed => (),
            Command::Confirmed(text) => {
                input["text"] = json!(text);
                input["attachments"] = json!([]);
                input["discordContext"] = self.context_snapshot(&route, Some(&channel)).await;
                self.admit(json!({"kind": "message", "input": input}))?;
            }
        }
        Ok(())
    }

    pub(super) async fn message_dispatch(&self, raw: Value, create: bool, live: bool) -> Effect<()> {
        let Some(channel_id) = raw["channel_id"].as_str().filter(|id| snowflake(id)) else {
            return Ok(());
        };
        let Some(id) = raw["id"].as_str().filter(|id| snowflake(id)) else {
            return Ok(());
        };
        let guild = raw["guild_id"].as_str();
        if !self.allowed_guild(guild)
            || raw["webhook_id"].is_string()
        {
            return Ok(());
        }
        let channel = match self
            .incoming_channel(channel_id, guild, create || raw.get("guild_id").is_some())
            .await
        {
            Ok(channel) => channel,
            Err(error) if error.certainty == "rejected" => return Ok(()),
            Err(error) => return Err(error),
        };
        // Check parent and owner policy before a partial update may fetch a message.
        let Ok(route) = self.route_for(&channel) else {
            return Ok(());
        };
        if self.group_route(&route) {
            if create && live {
                self.group_message(&route, &raw)?;
            }
            return Ok(());
        }
        if raw["author"].is_object()
            && !User::deserialize(&raw["author"])
                .is_ok_and(|user| user.id == self.config.owner_id && !user.bot)
        {
            return Ok(());
        }
        let (message, fetched_raw) = match Message::deserialize(&raw) {
            Ok(message)
                if create
                    || (raw.get("edited_timestamp").is_some()
                        && raw.get("attachments").is_some()
                        && self.has_edit_addressing_metadata(&raw, &message, &route)) =>
            {
                (message, None)
            }
            _ if create => return Ok(()),
            _ => {
                let found: Value = self
                    .rest
                    .get(&format!("channels/{channel_id}/messages/{id}"))
                    .await?;
                let message = Message::deserialize(&found)
                    .map_err(|_| broken("Discord edit could not be verified"))?;
                (message, Some(found))
            }
        };
        // Gate controls even on partial edits whose resource omitted a guild ID.
        if let Some(voice) = &self.voice {
            let mut resource = fetched_raw.unwrap_or_else(|| raw.clone());
            resource["guild_id"] = json!(route.guild_id);
            if voice.is_control(&resource) {
                return Ok(());
            }
        }
        if message.id != id || (!create && message.edited_timestamp.is_none()) {
            return Ok(());
        }
        if let Some(input) = self.with_context(&message, &route, &channel).await {
            self.admit(json!({ "kind": "message", "input": input }))?;
        }
        Ok(())
    }

    fn group_message(&self, route: &Route, raw: &Value) -> Effect<()> {
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

    async fn with_context(
        &self,
        message: &Message,
        route: &Route,
        channel: &Channel,
    ) -> Option<Value> {
        if !authorized_message(message, route) {
            return None;
        }
        let addressing_enabled = self.addressing_enabled(route);
        let require_addressing = addressing_enabled && route.thread_id.is_none();
        let addressed_text = if addressing_enabled {
            remove_bot_mentions(message, &route.account_id)
        } else {
            None
        };
        let verified_reply = if require_addressing && addressed_text.is_none() {
            let reply = self.resolve_reply(message, route, true).await?;
            if !reply.addresses_bot(route) {
                return None;
            }
            Some(reply)
        } else {
            None
        };
        let text = addressed_text
            .as_deref()
            .map_or(message.content.as_str(), str::trim);
        let mut input = message_input(message, route, text)?;
        let reply = match verified_reply {
            Some(reply) => Some(reply),
            None => self.resolve_reply(message, route, false).await,
        };
        if let Some(reply) = reply {
            input["reply"] = reply.snapshot(route);
        }
        input["discordContext"] = self.context_snapshot(route, Some(channel)).await;
        Some(input)
    }

    pub(super) async fn fetch_after(&self, route: &Route, cursor: &str) -> Effect<Value> {
        if !snowflake(cursor) {
            return Err(EffectError::rejected(
                "Catchup requires a stored Discord message snowflake",
            ));
        }
        let route = route.physical();
        if self.group_route(&route) {
            return Err(EffectError::rejected("Discord group rooms do not allow history recovery"));
        }
        let channel = self.destination(&route).await?;
        let mut after = cursor.to_owned();
        let mut inputs = Vec::new();
        loop {
            let page: Vec<Value> = self
                .rest
                .get(&format!(
                    "channels/{}/messages?after={after}&limit=100",
                    channel.id
                ))
                .await?;
            let count = page.len();
            let mut messages =
                page.into_iter()
                    .map(|mut raw| {
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
                        raw["guild_id"] = json!(route.guild_id);
                        Ok((id, message, raw))
                    })
                    .collect::<Effect<Vec<_>>>()?;
            messages.sort_unstable_by_key(|(id, _, _)| *id);
            let previous = after
                .parse::<u64>()
                .map_err(|_| broken("Discord history cursor could not be verified"))?;
            for (id, message, raw) in messages {
                if id <= previous {
                    return Err(broken("Discord history cursor did not advance"));
                }
                after = message.id.clone();
                if self.voice.as_ref().is_some_and(|v| v.is_control(&raw)) {
                    continue;
                }
                if let Some(input) = self.with_context(&message, &route, &channel).await {
                    inputs.push(input);
                }
            }
            if count < 100 {
                break;
            }
        }
        Ok(Value::Array(inputs))
    }
}
