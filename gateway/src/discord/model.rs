use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::{Effect, EffectError};

pub(super) fn read<'de, T: Deserialize<'de>>(value: &'de Value) -> Effect<T> {
    T::deserialize(value).map_err(|_| EffectError::rejected("Invalid Discord effect arguments"))
}

pub(super) fn snowflake(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 20
        && id.bytes().all(|b| b.is_ascii_digit())
        && id.parse::<u64>().is_ok()
}

pub(super) fn snowflake_time(id: &str) -> Option<u64> {
    let value = id.parse::<u64>().ok()?;
    snowflake(id).then_some((value >> 22) + 1_420_070_400_000)
}

pub(super) fn utf16(value: &str) -> usize {
    value.encode_utf16().count()
}

pub(super) fn hash(value: &Value) -> String {
    hex::encode(&Sha256::digest(value.to_string().as_bytes())[..12])
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Route {
    pub platform: String,
    pub account_id: String,
    pub authority_id: String,
    pub guild_id: Option<String>,
    pub channel_id: String,
    pub thread_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub topic_id: Option<String>,
}

impl Route {
    pub fn destination(&self) -> &str {
        self.thread_id.as_deref().unwrap_or(&self.channel_id)
    }

    pub fn physical(&self) -> Self {
        Self {
            topic_id: None,
            ..self.clone()
        }
    }

    pub fn parent(&self) -> Self {
        Self {
            thread_id: None,
            ..self.physical()
        }
    }

    pub fn key(&self) -> String {
        let mut fields = vec![
            json!(self.platform),
            json!(self.account_id),
            json!(self.authority_id),
            json!(self.guild_id),
            json!(self.channel_id),
            json!(self.thread_id),
        ];
        if let Some(topic) = &self.topic_id {
            fields.push(json!(topic));
        }
        Value::Array(fields).to_string()
    }
}

#[derive(Clone, Debug, Deserialize)]
pub(super) struct User {
    pub id: String,
    #[serde(default)]
    pub bot: bool,
}

#[derive(Clone, Deserialize)]
pub(super) struct Channel {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: u8,
    pub guild_id: Option<String>,
    pub parent_id: Option<String>,
    pub name: Option<String>,
    #[serde(default)]
    pub topic: Topic,
    #[serde(default)]
    pub recipients: Vec<User>,
    #[serde(default)]
    pub permission_overwrites: Vec<Overwrite>,
    #[serde(default)]
    pub available_tags: Vec<ForumTag>,
    #[serde(default)]
    pub applied_tags: Vec<String>,
    #[serde(default)]
    pub flags: u64,
    pub thread_metadata: Option<ThreadMetadata>,
}

#[derive(Clone, Default)]
pub(super) enum Topic {
    #[default]
    Missing,
    Observed(Option<String>),
}

impl<'de> Deserialize<'de> for Topic {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Option::<String>::deserialize(deserializer).map(Self::Observed)
    }
}

#[derive(Clone, Deserialize)]
pub(super) struct ThreadMetadata {
    pub archived: bool,
}

#[derive(Clone, Deserialize, Serialize)]
pub(super) struct ForumTag {
    pub id: String,
    pub name: String,
    pub moderated: bool,
}

#[derive(Clone, Deserialize)]
pub(super) struct Overwrite {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: u8,
    pub allow: String,
    pub deny: String,
}

impl Channel {
    pub fn is_thread(&self) -> bool {
        matches!(self.kind, 10..=12)
    }
    pub fn is_forum(&self) -> bool {
        matches!(self.kind, 15 | 16)
    }
    pub fn is_thread_parent(&self) -> bool {
        matches!(self.kind, 0 | 5 | 15 | 16)
    }
    pub fn requires_tag(&self) -> bool {
        self.is_forum() && self.flags & (1 << 4) != 0
    }

    pub fn sendable(self) -> Effect<Self> {
        if matches!(self.kind, 0..=3 | 5 | 10..=13) {
            return Ok(self);
        }
        Err(EffectError::rejected(
            "Discord destination cannot receive messages",
        ))
    }
}

#[derive(Clone, Deserialize)]
pub(super) struct Message {
    pub id: String,
    pub channel_id: String,
    pub guild_id: Option<String>,
    pub author: User,
    #[serde(rename = "type")]
    pub kind: u8,
    pub webhook_id: Option<String>,
    pub content: String,
    pub edited_timestamp: Option<String>,
    #[serde(default)]
    pub mentions: Vec<User>,
    #[serde(default)]
    pub attachments: Vec<RemoteAttachment>,
    #[serde(default)]
    pub flags: u64,
    pub message_reference: Option<Reference>,
    pub referenced_message: Option<Box<ReferencedMessage>>,
}

impl Message {
    pub fn matches(&self, route: &Route) -> bool {
        self.channel_id == route.destination() && actual_guild(self.guild_id.as_deref(), route)
    }
}

/// Discord REST message resources omit guild_id; the verified enclosing channel
/// establishes it in that case, but a contradictory explicit ID is never accepted.
pub(super) fn actual_guild(actual: Option<&str>, route: &Route) -> bool {
    actual.is_none_or(|id| Some(id) == route.guild_id.as_deref())
}

#[derive(Clone, Deserialize)]
pub(super) struct ReferencedMessage {
    pub id: String,
    pub channel_id: String,
    pub guild_id: Option<String>,
    pub author: User,
    pub content: String,
}

#[derive(Clone, Deserialize)]
pub(super) struct Reference {
    pub message_id: Option<String>,
    pub channel_id: Option<String>,
    pub guild_id: Option<String>,
    #[serde(rename = "type", default)]
    pub kind: u8,
}

#[derive(Clone, Deserialize)]
pub(super) struct RemoteAttachment {
    pub id: String,
    pub filename: String,
    pub url: String,
    pub size: u64,
    pub content_type: Option<String>,
    pub duration_secs: Option<f64>,
}

#[derive(Deserialize)]
pub(super) struct RemoteMessage {
    pub id: String,
    pub channel_id: String,
    pub guild_id: Option<String>,
    pub author: User,
    #[serde(default)]
    pub components: Vec<ComponentRow>,
}

impl RemoteMessage {
    pub fn belongs(&self, route: &Route) -> bool {
        self.author.id == route.account_id
            && self.channel_id == route.destination()
            && actual_guild(self.guild_id.as_deref(), route)
    }
}

#[derive(Deserialize)]
pub(super) struct ComponentRow {
    #[serde(default)]
    pub components: Vec<Component>,
}

#[derive(Deserialize)]
pub(super) struct Component {
    pub custom_id: Option<String>,
    pub value: Option<String>,
}

#[derive(Deserialize)]
pub(super) struct Interaction {
    pub id: String,
    pub application_id: String,
    #[serde(rename = "type")]
    pub kind: u8,
    pub token: String,
    channel: Option<InteractionChannel>,
    channel_id: Option<String>,
    pub guild_id: Option<String>,
    pub member: Option<InteractionMember>,
    pub user: Option<User>,
    pub message: Option<RemoteMessage>,
    pub data: Option<Value>,
}

impl Interaction {
    pub fn channel_id(&self) -> Option<&str> {
        let modern = self.channel.as_ref().map(|channel| channel.id.as_str());
        let legacy = self.channel_id.as_deref();
        match (modern, legacy) {
            (Some(left), Some(right)) if left != right => None,
            _ => modern.or(legacy),
        }
    }

    pub fn user(&self) -> Option<&User> {
        match self.guild_id {
            Some(_) => self.member.as_ref().map(|member| &member.user),
            None => self.user.as_ref(),
        }
    }
}

#[derive(Deserialize)]
pub(super) struct InteractionMember {
    pub user: User,
}

#[derive(Deserialize)]
struct InteractionChannel {
    id: String,
}
