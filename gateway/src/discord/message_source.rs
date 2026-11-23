use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use crate::store::discord_attachment_identity_url;

use super::{
    Effect, State,
    addressing::{addressed_text, has_inline_mention},
    ingress::{authorized_message, reply_id},
    model::{Channel, Message, Reference, RemoteAttachment, Route},
    rest::broken,
};

fn timestamp(stamp: &str) -> Option<OffsetDateTime> {
    OffsetDateTime::parse(stamp, &Rfc3339).ok()
}

#[derive(Deserialize, Serialize)]
pub(super) struct Revision {
    edited_at_nanos: Option<i128>,
    content_digest: Option<String>,
    attachment_digest: Option<String>,
    reference_digest: Option<String>,
    kind: Option<u64>,
}

fn digest(value: &Value) -> String {
    hex::encode(Sha256::digest(value.to_string().as_bytes()))
}

fn attachment_digest(files: &[RemoteAttachment]) -> String {
    let mut files: Vec<_> = files.iter().map(|file| {
        let location = discord_attachment_identity_url(&file.url);
        json!([file.id, file.filename, location, file.size, file.content_type, file.duration_secs])
    }).collect();
    files.sort_by(|left, right| left[0].as_str().cmp(&right[0].as_str()));
    digest(&json!(files))
}

impl Revision {
    pub(super) fn from_wire(raw: &Value, create: bool) -> Option<Self> {
        let edited_at_nanos = match raw.get("edited_timestamp") {
            None | Some(Value::Null) => None,
            Some(value) => Some(timestamp(value.as_str()?)?.unix_timestamp_nanos()),
        };
        let content_digest = match raw.get("content") {
            None => None,
            Some(value) => Some(digest(&json!(value.as_str()?))),
        };
        let attachment_digest = match raw.get("attachments") {
            None => None,
            Some(value) => Some(attachment_digest(&Vec::<RemoteAttachment>::deserialize(value).ok()?)),
        };
        let reference_digest = match raw.get("message_reference") {
            None => None,
            Some(value) => Some(digest(&json!(Option::<Reference>::deserialize(value).ok()?))),
        };
        if create && content_digest.is_none()
            || !create && edited_at_nanos.is_none()
                && content_digest.is_none() && attachment_digest.is_none()
        {
            return None;
        }
        Some(Self {
            edited_at_nanos,
            content_digest,
            attachment_digest,
            reference_digest,
            kind: raw["type"].as_u64(),
        })
    }

    fn identifies_edit(&self) -> bool {
        self.edited_at_nanos.is_some() || self.content_digest.is_some() && self.attachment_digest.is_some()
    }

    fn matches(&self, message: &Message, create: bool) -> Effect<bool> {
        let observed = message.edited_timestamp.as_deref().map(|stamp| {
            timestamp(stamp).map(OffsetDateTime::unix_timestamp_nanos)
                .ok_or_else(|| broken("Discord source edit timestamp could not be verified"))
        }).transpose()?;
        if self.edited_at_nanos.is_some_and(|expected| observed.is_none_or(|value| value < expected)) {
            return Err(broken("Discord source lookup has not observed the candidate revision yet"));
        }
        let exact = match self.edited_at_nanos {
            Some(expected) => observed == Some(expected),
            None if create => observed.is_none(),
            None => observed.is_some(),
        };
        Ok(exact
            && self.content_digest.as_ref().is_none_or(|hash| *hash == digest(&json!(message.content)))
            && self.attachment_digest.as_ref().is_none_or(|hash| *hash == attachment_digest(&message.attachments))
            && self.reference_digest.as_ref().is_none_or(|hash| *hash == digest(&json!(message.message_reference)))
            && self.kind.is_none_or(|kind| kind == u64::from(message.kind)))
    }
}

fn edit_has_addressing_metadata(raw: &Value, message: &Message, route: &Route, channel: &Channel) -> bool {
    if message.mentions.is_none() && has_inline_mention(&message.content, &route.account_id) {
        return false;
    }
    reply_id(message, route).is_some_and(|(_, reference)| reference.kind == 0)
        || addressed_text(message, &route.account_id).is_some()
        || channel.is_thread_owned_by(&route.account_id)
        || message.kind != 19
        || raw.get("message_reference").is_some()
}

impl State {
    pub(super) async fn hydrate_source(
        &self,
        id: &str,
        route: &Route,
        create: bool,
        revision: &Revision,
        addressing: bool,
    ) -> Effect<Option<Message>> {
        // An addressed edit needs a specific revision; outside addressing,
        // keep accepting sparse owner edits after authenticated REST hydration.
        if addressing && !create && !revision.identifies_edit() {
            return Ok(None);
        }
        let found = self.rest.evidence::<Message>(&format!("channels/{}/messages/{id}", route.destination())).await?;
        let Some(found) = found else { return Ok(None) };
        if found.id != id || found.channel_id != route.destination() {
            return Err(broken("Discord message lookup did not match its requested source"));
        }
        if authorized_message(&found, route) && revision.matches(&found, create)? {
            return Ok(Some(found));
        }
        // Valid REST source at these coordinates, but ownership or the exact
        // revision was disproved. Never replace it with a newer edit.
        Ok(None)
    }

    pub(super) async fn verify_wire(
        &self,
        raw: &Value,
        create: bool,
        route: &Route,
        channel: &Channel,
        addressing: bool,
    ) -> Effect<Option<Message>> {
        let Some(id) = raw["id"].as_str() else { return Ok(None) };
        let received = Message::deserialize(raw).ok();
        if let Some(message) = received.as_ref()
            && !authorized_message(message, route)
        {
            return Ok(None);
        }
        if received.as_ref().is_some_and(|message| {
            create || message.edited_timestamp.as_deref().and_then(timestamp).is_some()
                && raw.get("attachments").is_some()
                && (!addressing || edit_has_addressing_metadata(raw, message, route, channel))
        }) {
            return Ok(received);
        }
        if create {
            return Ok(None);
        }
        let Some(revision) = Revision::from_wire(raw, create) else { return Ok(None) };
        let Some(found) = self.hydrate_source(id, route, create, &revision, addressing).await? else { return Ok(None) };
        if let Some(mut message) = received.filter(|_| raw.get("attachments").is_some()) {
            message.edited_timestamp = found.edited_timestamp;
            if message.mentions.is_none() {
                message.mentions = found.mentions;
            }
            if raw.get("message_reference").is_none() {
                message.message_reference = found.message_reference;
                message.referenced_message = found.referenced_message;
            }
            return Ok(Some(message));
        }
        Ok(Some(found))
    }
}
