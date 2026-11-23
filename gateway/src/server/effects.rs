use std::sync::Arc;

use serde::Deserialize;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::oneshot;

use super::{
    Hub,
    protocol::{Fault, WireResult, effect_id, object, rejected},
};
use crate::{
    group::Reply as GroupReply,
    store::{EffectStart, PHYSICAL_ROUTE_FIELDS, discord_presence::OPERATION as PRESENCE, js_trim},
};

impl Hub {
    pub(super) async fn effect(
        self: &Arc<Self>,
        mut data: Map<String, Value>,
    ) -> WireResult<Value> {
        let (id, operation, mut args) = match (
            data.remove("id"),
            data.remove("operation"),
            data.remove("args"),
        ) {
            (Some(Value::String(id)), Some(Value::String(operation)), Some(Value::Array(args)))
                if effect_id(&id) =>
            {
                (id, operation, args)
            }
            _ => return Err(rejected("Invalid Gateway effect")),
        };
        let allowed = match operation.as_str() {
            "send"
            | "sendGroup"
            | "showApproval"
            | "dismissApproval"
            | "inspectThread"
            | "inspectDiscordContext"
            | "discordPurpose"
            | PRESENCE => args.len() == 1,
            "setActivity" | "updateThread" | "fetchAfter" => args.len() == 2,
            "canCreateThread" => (1..=2).contains(&args.len()),
            "createThread" => (2..=4).contains(&args.len()),
            _ => false,
        };
        if !allowed {
            return Err(rejected("Unknown Gateway effect"));
        }
        let presence = operation == PRESENCE;
        if presence && !data.is_empty() {
            return Err(rejected("Invalid messenger presence effect"));
        }
        let group_output = if operation == "sendGroup" {
            let reply = GroupReply::deserialize(&args[0]).map_err(|_| rejected("Invalid group reply"))?;
            let request = self.store.group_request(&reply.source_id)?
                .filter(|request| self.adapters.rooms.current_request(request))
                .ok_or_else(|| rejected("Group reply source is unavailable or no longer authorized"))?;
            let text = request.reply_text(&reply)?;
            Some(json!({
                "id": id, "route": request.route, "messageId": request.message_id, "text": text
            }))
        } else {
            self.adapters.authorize_effect(&operation, &args)?;
            None
        };
        // The controller outbox owns the immutable staged file. The Gateway
        // needs only an exact attempt fingerprint and receipt, not another
        // durable copy of the disclosed bytes.
        let digest = if matches!((operation.as_str(), args.as_slice()),
            ("send", [output]) if output.get("resultAttachment").is_some())
        {
            for arg in &mut args {
                arg.sort_all_objects();
            }
            let encoded = serde_json::to_vec(&args).map_err(anyhow::Error::from)?;
            Some([json!({ "resultAttachmentEffectSha256": hex::encode(Sha256::digest(encoded)) })])
        } else {
            None
        };
        let ledger_args = digest.as_ref().map_or(args.as_slice(), |value| value.as_slice());
        if !presence
            && let EffectStart::Previous(result) = self.store.begin_effect(&id, &operation, ledger_args)?
        {
            return Ok(result);
        }
        let (send, result) = oneshot::channel();
        let hub = Arc::clone(self);
        // An HTTP cancellation is not permission to cancel a remote mutation
        // after its attempt has been journaled. Shutdown drains this task too.
        drop(self.effects.spawn(async move {
            let dispatched = match group_output {
                Some(output) => hub.adapters.send_group(output).await.map_err(Fault::from),
                None if presence => hub
                    .adapters
                    .messenger_presence(&id, &args[0])
                    .await
                    .map_err(Fault::from),
                None => hub.dispatch_effect(&operation, &args).await,
            };
            let result = match dispatched {
                Ok(value)
                    if value.is_null()
                        && matches!(operation.as_str(), "setActivity" | "dismissApproval") =>
                {
                    json!({"ok": true})
                }
                Ok(value) => json!({"ok": true, "value": value}),
                Err(fault) => fault.into_json(),
            };
            let receipt = if presence {
                Ok(result)
            } else {
                hub.store.finish_effect(&id, &result).map(|()| result)
            };
            drop(send.send(receipt));
        }));
        Ok(result.await.map_err(anyhow::Error::from)??)
    }

    async fn dispatch_effect(&self, operation: &str, args: &[Value]) -> WireResult<Value> {
        match (operation, args) {
            ("send", [output]) => validate_reply(output)?,
            ("setActivity", [message, state]) => {
                if !matches!(state.as_str(), Some("received" | "thinking" | "idle")) {
                    return Err(rejected("Invalid message activity"));
                }
                if !object(message)?
                    .get("messageId")
                    .and_then(Value::as_str)
                    .is_some_and(|id| !id.is_empty())
                {
                    return Err(rejected("Message activity requires a real message ID"));
                }
            }
            ("canCreateThread", [_, tags]) | ("createThread", [_, _, _, tags]) => {
                thread_tags(tags)?
            }
            ("updateThread", [_, update]) => validate_thread_update(update)?,
            ("discordPurpose", [request]) => {
                validate_purpose(request)?;
                self.store.validate_discord_purpose(request)?;
            }
            _ => {}
        }
        self.adapters
            .effect(operation, args)
            .await
            .map_err(Fault::from)
    }
}

/// A reply or an in-place status edit names a real Discord message in the
/// output's exact physical conversation; other platforms accept neither.
fn validate_reply(output: &Value) -> WireResult<()> {
    let output = object(output)?;
    for reply in ["replyTo", "editOf"].into_iter().filter_map(|key| output.get(key)) {
        let reply = object(reply)?;
        let source = object(reply.get("route").unwrap_or(&Value::Null))?;
        let destination = object(output.get("route").unwrap_or(&Value::Null))?;
        if destination.get("platform").and_then(Value::as_str) != Some("discord")
            || !reply
                .get("messageId")
                .and_then(Value::as_str)
                .is_some_and(|id| {
                    (1..=20).contains(&id.len()) && id.bytes().all(|byte| byte.is_ascii_digit())
                })
            || PHYSICAL_ROUTE_FIELDS
                .iter()
                .any(|field| source.get(*field) != destination.get(*field))
        {
            return Err(rejected(
                "Discord reply requires a real message in the exact destination conversation",
            ));
        }
    }
    Ok(())
}

fn thread_tags(value: &Value) -> WireResult<()> {
    if !value
        .as_array()
        .is_some_and(|tags| tags.iter().all(Value::is_string))
    {
        return Err(rejected("Invalid thread tags"));
    }
    Ok(())
}

fn validate_thread_update(value: &Value) -> WireResult<()> {
    let update = object(value)?;
    if update.is_empty()
        || update
            .keys()
            .any(|key| !matches!(key.as_str(), "title" | "appliedTags" | "archived"))
        || update.get("title").is_some_and(|title| !title.is_string())
        || update
            .get("archived")
            .is_some_and(|archived| !archived.is_boolean())
    {
        return Err(rejected("Invalid thread update"));
    }
    if let Some(tags) = update.get("appliedTags") {
        thread_tags(tags)?;
    }
    Ok(())
}

fn validate_purpose(value: &Value) -> WireResult<()> {
    let reject = || rejected("Invalid Discord purpose request");
    let data = value.as_object().ok_or_else(reject)?;
    let route = data
        .get("route")
        .and_then(Value::as_object)
        .ok_or_else(reject)?;
    let bounded = |value: Option<&Value>, max| {
        value
            .and_then(Value::as_str)
            .is_some_and(|text| !js_trim(text).is_empty() && text.encode_utf16().count() <= max)
    };
    if !bounded(data.get("sourceId"), 1000)
        || data
            .keys()
            .any(|key| !matches!(key.as_str(), "sourceId" | "route" | "action" | "purpose"))
        || route.get("platform").and_then(Value::as_str) != Some("discord")
        || ["accountId", "authorityId", "channelId"]
            .iter()
            .any(|field| {
                route
                    .get(*field)
                    .and_then(Value::as_str)
                    .is_none_or(str::is_empty)
            })
        || ["guildId", "threadId"].iter().any(|field| {
            !route.get(*field).is_some_and(|value| {
                value.is_null() || value.as_str().is_some_and(|id| !id.is_empty())
            })
        })
        || route.get("guildId").is_some_and(Value::is_null)
            && !route.get("threadId").is_some_and(Value::is_null)
        || route
            .keys()
            .any(|key| !PHYSICAL_ROUTE_FIELDS.contains(&key.as_str()))
    {
        return Err(reject());
    }
    match data.get("action").and_then(Value::as_str) {
        Some("list" | "clear") if !data.contains_key("purpose") => Ok(()),
        Some("set") if bounded(data.get("purpose"), 4000) => Ok(()),
        _ => Err(reject()),
    }
}
