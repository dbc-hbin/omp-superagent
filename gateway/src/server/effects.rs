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
    result_attachment::{LegacyPayload, Reference, Snapshot, VerifiedResultAttachment},
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
        let attachment = if let ("send", [output]) = (operation.as_str(), args.as_mut_slice())
            && output.get("resultAttachment").is_some()
        {
            Some(self.claim_result_attachment(&id, output)?)
        } else {
            None
        };
        let ledger_args = attachment.as_ref().map_or(args.as_slice(), |attempt| attempt.fingerprint.as_slice());
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
                None => match attachment {
                    Some(attempt) => hub.dispatch_result_attachment(&args[0], attempt.payload).await,
                    None => hub.dispatch_effect(&operation, &args).await,
                },
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

    fn claim_result_attachment(&self, effect_id: &str, output: &mut Value) -> WireResult<AttachmentAttempt> {
        validate_reply(output)?;
        let invalid = || rejected("Result attachment does not match the claimed outbox receipt");
        let wire = output.get("resultAttachment").ok_or_else(invalid)?;
        let reference = Reference::deserialize(wire).map_err(|_| invalid())?;
        let output_id = output["id"].as_str().ok_or_else(invalid)?;
        let key = serde_json::to_vec(&["result-attachment", output_id]).map_err(anyhow::Error::from)?;
        let hash = Sha256::digest(key);
        let mut uuid = [0; 16];
        uuid.copy_from_slice(&hash[..16]);
        if uuid::Uuid::from_bytes(uuid).hyphenated().to_string() != effect_id {
            return Err(invalid());
        }
        let (mut saved_output, stored) = self.store.claimed_result_output(output_id)?.ok_or_else(invalid)?;
        saved_output["resultAttachment"] = wire.clone();
        saved_output.sort_all_objects();
        output.sort_all_objects();
        if *output != saved_output {
            return Err(invalid());
        }
        let payload = match reference {
            Reference::Snapshot(snapshot) if stored == output["resultAttachment"] => {
                AttachmentPayload::Snapshot(snapshot)
            }
            Reference::Snapshot(_) => return Err(invalid()),
            Reference::Legacy(reference) => {
                let payload = LegacyPayload::deserialize(&stored).map_err(|_| invalid())?;
                if !reference.legacy || reference.name != payload.name {
                    return Err(invalid());
                }
                // Reconstruct exactly the sorted argument the pre-spool
                // Gateway hashed. A previously attempted upload stays closed.
                saved_output["resultAttachment"] = stored;
                saved_output.sort_all_objects();
                AttachmentPayload::Legacy(payload)
            }
        };
        let encoded = serde_json::to_vec(&[saved_output]).map_err(anyhow::Error::from)?;
        let fingerprint = [json!({"resultAttachmentEffectSha256":hex::encode(Sha256::digest(encoded))})];
        Ok(AttachmentAttempt { fingerprint, payload })
    }

    async fn dispatch_result_attachment(&self, output: &Value, payload: AttachmentPayload) -> WireResult<Value> {
        let state_dir = self.store.state_dir().to_path_buf();
        let file = tokio::task::spawn_blocking(move || -> Result<VerifiedResultAttachment, _> {
            match payload {
                AttachmentPayload::Snapshot(snapshot) => snapshot.load(&state_dir),
                AttachmentPayload::Legacy(payload) => payload.verify(),
            }
        }).await.map_err(anyhow::Error::from)??;
        self.adapters.send_result_attachment(output, file).await.map_err(Fault::from)
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

struct AttachmentAttempt {
    fingerprint: [Value; 1],
    payload: AttachmentPayload,
}

enum AttachmentPayload {
    Snapshot(Snapshot),
    Legacy(LegacyPayload),
}

/// A reply, status message, or in-place status edit belongs to a plain Discord
/// route in the exact physical conversation; other platforms reject them.
fn validate_reply(output: &Value) -> WireResult<()> {
    let output = object(output)?;
    let destination = object(output.get("route").unwrap_or(&Value::Null))?;
    if let Some(status) = output.get("status") {
        let Some(enabled) = status.as_bool() else {
            return Err(rejected("Discord status flag must be a boolean"));
        };
        if enabled && destination.get("platform").and_then(Value::as_str) != Some("discord") {
            return Err(rejected("Discord status delivery requires a Discord route"));
        }
    }
    for reply in ["replyTo", "editOf"].into_iter().filter_map(|key| output.get(key)) {
        let reply = object(reply)?;
        let source = object(reply.get("route").unwrap_or(&Value::Null))?;
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
