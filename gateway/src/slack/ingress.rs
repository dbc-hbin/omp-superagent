use serde::Deserialize;
use serde_json::{Value, json};

use crate::{adapter::EffectError, commands::accepts_text, group::{Candidate, Output as GroupOutput}};

use super::Inner;
use super::api::Identity;
use super::socket::{Ack, Event};
use super::wire::{
    Attachment, Inbound, Route, Ts, digest, file_id, now_ms, same_optional, short_hash, slack_id,
};

const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;
const REFUSED: &str = "Superagent refused this command: use a configured command as the authorized owner in this app's workspace and an allowed channel or owner DM. Slash commands cannot target threads.";
const ADMITTED: &str = "Superagent command admitted. The result will appear in this conversation.";

fn js_whitespace(char: char) -> bool {
    matches!(char, '\u{9}'..='\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}'
        | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

fn control_text(text: String) -> String {
    if let Some(command) = text
        .strip_prefix('!')
        .and_then(|text| text.split(js_whitespace).next())
        && accepts_text(command).is_some()
    {
        return format!("/{}", &text[1..]);
    }
    text
}

fn slash_text(name: &str, text: &str) -> Option<String> {
    let name = name.strip_prefix("/superagent-")?;
    let accepts_argument = accepts_text(name)?;
    let text = text.trim_matches(js_whitespace);
    match (text.is_empty(), accepts_argument) {
        (true, _) => Some(format!("/{name}")),
        (false, true) => Some(format!("/{name} {text}")),
        (false, false) => None,
    }
}

#[derive(Deserialize)]
struct Slash<'a> {
    team_id: &'a str,
    user_id: &'a str,
    channel_id: &'a str,
    trigger_id: &'a str,
    command: &'a str,
    text: &'a str,
}

#[derive(Deserialize)]
struct Message {
    ts: Ts,
    thread_ts: Option<Ts>,
    text: Option<String>,
    edited: Option<Edit>,
}

#[derive(Deserialize)]
struct Edit {
    user: String,
    ts: Ts,
}

#[derive(Deserialize)]
struct File {
    id: String,
    user: String,
    name: String,
    size: u64,
    mimetype: Option<String>,
    is_external: Option<bool>,
}

impl Inner {
    pub(super) async fn send_group(&self, output: GroupOutput<Route>) -> Result<String, EffectError> {
        let mut route = output.route;
        self.destination(&route).await?;
        if route.thread_id.is_none() {
            route.thread_id = Some(Ts::parse(&output.message_id)
                .ok_or_else(|| EffectError::rejected("Invalid Slack source message ID"))?);
        }
        self.post(&route, &output.text, None).await.map(|receipt| receipt.as_str().to_owned())
    }

    pub(super) async fn handle_event(
        &self,
        identity: &Identity,
        ack: Ack,
        event: Event,
    ) -> Result<(), EffectError> {
        match event {
            Event::Events { body, replayed } => self.receive_message(identity, &body, replayed, ack).await,
            Event::Slash(body) => self.receive_slash(identity, &body, ack).await,
            Event::Interactive(body) => self.interact(&body, ack).await,
            Event::Unknown => ack.send(None).await,
        }
    }

    async fn incoming_route(
        &self,
        identity: &Identity,
        channel: &str,
        thread: Option<Ts>,
    ) -> Result<Option<Route>, EffectError> {
        let dm = channel.starts_with('D');
        if !dm && !self.channels.contains(channel) {
            return Ok(None);
        }
        let route = Route {
            platform: "slack".into(),
            account_id: identity.account.clone(),
            authority_id: self.owner.clone(),
            guild_id: (!dm).then(|| self.team.clone()),
            channel_id: channel.to_owned(),
            thread_id: thread,
            topic_id: None,
        };
        self.destination(&route).await?;
        Ok(Some(route))
    }

    async fn receive_message(
        &self,
        identity: &Identity,
        body: &Value,
        replayed: bool,
        ack: Ack,
    ) -> Result<(), EffectError> {
        if body["team_id"] != self.team || !same_optional(body, "api_app_id", &identity.app_id) {
            return ack.send(None).await;
        }
        let event = &body["event"];
        let Some(channel) = event["channel"].as_str().filter(|id| slack_id(id)) else {
            return ack.send(None).await;
        };
        if event["type"] != "message"
            || event
                .get("channel_type")
                .is_some_and(|kind| !matches!(kind.as_str(), Some("im" | "channel" | "group")))
        {
            return ack.send(None).await;
        }
        if self.ctx.group_room(Some(&self.team), channel).is_some() {
            if !replayed {
                self.group_message(identity, channel, event).await?;
            }
            return ack.send(None).await;
        }
        let source = match event.get("subtype") {
            None => event,
            Some(kind) if kind == "file_share" => event,
            Some(kind) if kind == "message_changed" && event["message"]["edited"].is_object() => {
                &event["message"]
            }
            Some(_) => return ack.send(None).await,
        };
        if !same_optional(source, "channel", channel) || !self.owner_message(source) {
            return ack.send(None).await;
        }
        let Ok(message) = Message::deserialize(source) else {
            return ack.send(None).await;
        };
        let thread = message
            .thread_ts
            .as_ref()
            .filter(|root| *root != &message.ts)
            .cloned();
        if let Some(route) = self.incoming_route(identity, channel, thread).await?
            && let Some(input) = self.normalize_parsed(source, route, message)?
        {
            self.admit(json!({ "kind": "message", "input": input }))
                .await?;
        }
        ack.send(None).await
    }

    async fn group_message(&self, identity: &Identity, channel: &str, event: &Value) -> Result<(), EffectError> {
        let Some(user) = event["user"].as_str().filter(|id| id.starts_with(['U', 'W']) && slack_id(id)) else {
            return Ok(());
        };
        if user == identity.bot_user
            || event["is_bot"] == true
            || event["is_app_user"] == true
            || ["subtype", "edited", "bot_id", "bot_profile", "app_id", "files", "attachments"]
                .iter().any(|key| event.get(*key).is_some_and(|value| {
                    !value.is_null() && !value.as_array().is_some_and(Vec::is_empty)
                }))
            || !["team", "user_team", "source_team"].iter().all(|key| same_optional(event, key, &self.team))
            || !self.ctx.group_room(Some(&self.team), channel).is_some_and(|room| room.permits(user))
        {
            return Ok(());
        }
        let Ok(message) = Message::deserialize(event) else { return Ok(()) };
        let Some(text) = message.text.as_deref().filter(|text| text.starts_with('!')) else {
            return Ok(());
        };
        let Some(sent_ms) = message.ts.whole_millis() else { return Ok(()) };
        let thread = message.thread_ts.filter(|root| root != &message.ts);
        if let Some(route) = self.incoming_route(identity, channel, thread).await? {
            self.ctx.admit_group(json!(route), Candidate {
                message_id: message.ts.as_str(),
                user_id: user,
                text,
                sent_ms,
                qualified_command: None,
            }).map_err(|_| EffectError::uncertain("Slack group admission could not be confirmed"))?;
        }
        Ok(())
    }

    fn parse_slash<'a>(&self, identity: &Identity, body: &'a Value) -> Option<(Slash<'a>, String)> {
        let command = Slash::deserialize(body).ok()?;
        if command.team_id != self.team
            || command.user_id != self.owner
            || !same_optional(body, "api_app_id", &identity.app_id)
            || !same_optional(body, "app_id", &identity.app_id)
            || !same_optional(body, "bot_id", &identity.bot_id)
            || !slack_id(command.channel_id)
            || command.trigger_id.is_empty()
            || [
                "ts",
                "message_ts",
                "thread_ts",
                "thread_id",
                "message",
                "container",
            ]
            .iter()
            .any(|name| body.get(name).is_some())
        {
            return None;
        }
        let text = slash_text(command.command, command.text)?;
        Some((command, text))
    }

    async fn receive_slash(
        &self,
        identity: &Identity,
        body: &Value,
        ack: Ack,
    ) -> Result<(), EffectError> {
        let ephemeral = |text| Some(json!({ "response_type": "ephemeral", "text": text }));
        if body["team_id"] == self.team
            && body["channel_id"].as_str().is_some_and(|channel| {
                self.ctx.group_room(Some(&self.team), channel).is_some()
            })
        {
            return ack.send(None).await;
        }
        let Some((command, text)) = self.parse_slash(identity, body) else {
            return ack.send(ephemeral(REFUSED)).await;
        };
        let route = match self
            .incoming_route(identity, command.channel_id, None)
            .await
        {
            Ok(Some(route)) => route,
            Ok(None) | Err(_) => return ack.send(ephemeral(REFUSED)).await,
        };
        let invocation_id = digest(&json!([
            identity.app_id,
            self.team,
            self.owner,
            command.channel_id,
            command.trigger_id
        ]));
        let input = Inbound {
            id: format!(
                "slack:{}:{}:invocation:{invocation_id}",
                identity.account, command.channel_id
            ),
            route,
            message_id: None,
            invocation_id: Some(invocation_id),
            text,
            received_at: json!(now_ms()),
            attachments: Vec::new(),
        };
        self.admit(json!({ "kind": "message", "input": input }))
            .await?;
        ack.send(ephemeral(ADMITTED)).await
    }

    pub(super) fn owner_message(&self, source: &Value) -> bool {
        source["type"] == "message"
            && source["user"] == self.owner
            && ["bot_id", "app_id"].iter().all(|key| {
                matches!(source.get(key), None | Some(Value::Null))
                    || source[*key].as_str().is_some_and(str::is_empty)
            })
            && source
                .get("subtype")
                .is_none_or(|kind| kind == "file_share")
            && ["team", "user_team", "source_team"]
                .iter()
                .all(|key| same_optional(source, key, &self.team))
    }

    pub(super) fn normalize(
        &self,
        source: &Value,
        route: Route,
    ) -> Result<Option<Inbound>, EffectError> {
        if self.ctx.group_room(route.guild_id.as_deref(), &route.channel_id).is_some()
            || !self.owner_message(source)
        {
            return Ok(None);
        }
        let Ok(message) = Message::deserialize(source) else {
            return Ok(None);
        };
        self.normalize_parsed(source, route, message)
    }

    fn normalize_parsed(
        &self,
        source: &Value,
        route: Route,
        message: Message,
    ) -> Result<Option<Inbound>, EffectError> {
        if message
            .edited
            .as_ref()
            .is_some_and(|edit| edit.user != self.owner)
            || ["thread_ts", "text"]
                .iter()
                .any(|field| source.get(field).is_some_and(Value::is_null))
        {
            return Ok(None);
        }
        let route = Route {
            thread_id: message.thread_ts.filter(|root| root != &message.ts),
            ..route
        };
        let mut attachments = Vec::new();
        for value in source["files"].as_array().into_iter().flatten() {
            let unsupported = || {
                EffectError::rejected(
                    "Slack message contains an unsupported or nonowner attachment; use the local OMP interface",
                )
            };
            let file = File::deserialize(value).map_err(|_| unsupported())?;
            if !file_id(&file.id)
                || file.user != self.owner
                || file.is_external == Some(true)
                || file.size > MAX_SAFE_INTEGER
            {
                return Err(unsupported());
            }
            attachments.push(Attachment {
                url: format!("slack-file:{}", file.id),
                id: file.id,
                name: file.name,
                size: file.size,
                content_type: file.mimetype,
            });
        }
        let text = message.text.unwrap_or_default();
        let (revision, age) = if let Some(edit) = message.edited {
            let mut file_identity = attachments
                .iter()
                .map(|file| {
                    let sort = format!(
                        "{},{},{},{}",
                        file.id,
                        file.name,
                        file.size,
                        file.content_type.as_deref().unwrap_or("")
                    );
                    (
                        sort.encode_utf16().collect::<Vec<_>>(),
                        json!([file.id, file.name, file.size, file.content_type]),
                    )
                })
                .collect::<Vec<_>>();
            // JS's default Array.sort compares each array's comma-joined UTF-16 string.
            file_identity.sort_by(|(left, _), (right, _)| left.cmp(right));
            let stable = file_identity
                .into_iter()
                .map(|(_, identity)| identity)
                .collect::<Vec<_>>();
            (
                format!(
                    "edit:{}:{}",
                    edit.ts.as_str(),
                    short_hash(&json!([text, stable]))
                ),
                edit.ts.millis(),
            )
        } else {
            ("original".to_owned(), message.ts.millis())
        };
        Ok(Some(Inbound {
            id: format!(
                "slack:{}:{}:{}:{revision}",
                route.account_id,
                route.channel_id,
                message.ts.as_str()
            ),
            route,
            message_id: Some(message.ts),
            invocation_id: None,
            text: control_text(text),
            received_at: json!(age),
            attachments,
        }))
    }
}

#[cfg(test)]
#[path = "ingress_tests.rs"]
mod tests;
