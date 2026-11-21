use std::collections::HashSet;

use anyhow::{anyhow, ensure};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::adapter::EffectError;

pub(super) const SAFE_INTEGER: u64 = 9_007_199_254_740_991;

pub(super) fn unsigned_id(raw: &str) -> Option<u64> {
    if raw.is_empty()
        || !raw.bytes().all(|byte| byte.is_ascii_digit())
        || (raw.len() > 1 && raw.starts_with('0'))
    {
        return None;
    }
    raw.parse::<u64>().ok().filter(|id| *id <= SAFE_INTEGER)
}

pub(super) fn positive_id(raw: &str) -> Option<u64> {
    unsigned_id(raw).filter(|id| *id > 0)
}

pub(super) fn file_id(raw: &str) -> bool {
    !raw.is_empty()
        && raw
            .bytes()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, b'_' | b'-'))
}

pub(super) fn hash(text: &str) -> String {
    hex::encode(&Sha256::digest(text.as_bytes())[..12])
}

pub(super) fn decode<'de, T: Deserialize<'de>>(value: &'de Value) -> Result<T, EffectError> {
    T::deserialize(value).map_err(|_| EffectError::rejected("Malformed Telegram effect arguments"))
}

fn optional_topic<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<String>, D::Error> {
    let topic = String::deserialize(deserializer)?;
    if topic.is_empty() || topic.encode_utf16().count() > 128 {
        return Err(serde::de::Error::custom("Invalid Telegram logical topic"));
    }
    Ok(Some(topic))
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Route {
    pub platform: String,
    pub account_id: String,
    pub authority_id: String,
    // These nullable route fields must still be present on the wire.
    #[serde(deserialize_with = "Option::deserialize")]
    pub guild_id: Option<String>,
    pub channel_id: String,
    #[serde(deserialize_with = "Option::deserialize")]
    pub thread_id: Option<String>,
    #[serde(
        default,
        deserialize_with = "optional_topic",
        skip_serializing_if = "Option::is_none"
    )]
    pub topic_id: Option<String>,
}

impl Route {
    pub fn physical_key(&self) -> String {
        json!([
            self.platform,
            self.account_id,
            self.authority_id,
            self.guild_id,
            self.channel_id,
            self.thread_id
        ])
        .to_string()
    }

    pub fn key(&self) -> String {
        let Some(topic) = &self.topic_id else {
            return self.physical_key();
        };
        json!([
            self.platform,
            self.account_id,
            self.authority_id,
            self.guild_id,
            self.channel_id,
            self.thread_id,
            topic
        ])
        .to_string()
    }

    pub fn same_physical(&self, other: &Self) -> bool {
        self.platform == other.platform
            && self.account_id == other.account_id
            && self.authority_id == other.authority_id
            && self.guild_id == other.guild_id
            && self.channel_id == other.channel_id
            && self.thread_id == other.thread_id
    }
}

#[derive(Clone, Deserialize)]
pub(super) struct Identity {
    pub id: u64,
    pub is_bot: bool,
    pub username: Option<String>,
    #[serde(default)]
    pub has_topics_enabled: bool,
}

#[derive(Clone, Copy, Deserialize)]
pub(super) struct Sender {
    pub id: u64,
    pub is_bot: bool,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum ChatKind {
    Private,
    Group,
    Supergroup,
    #[serde(other)]
    Other,
}

#[derive(Clone, Deserialize)]
pub(super) struct Chat {
    pub id: i64,
    #[serde(rename = "type")]
    pub kind: ChatKind,
    #[serde(default)]
    pub is_forum: bool,
}

pub(super) struct Policy {
    owner: String,
    owner_id: u64,
    chats: HashSet<String>,
}

impl Policy {
    pub fn new(owner: &str, chats: &[String]) -> anyhow::Result<Self> {
        let invalid =
            || anyhow!("Telegram requires a positive owner ID and negative allowed chat IDs");
        let owner_id = positive_id(owner).ok_or_else(invalid)?;
        ensure!(
            chats
                .iter()
                .all(|id| id.strip_prefix('-').and_then(positive_id).is_some()),
            invalid()
        );
        Ok(Self {
            owner: owner.to_owned(),
            owner_id,
            chats: chats.iter().cloned().collect(),
        })
    }

    pub fn owner(&self, sender: Sender) -> bool {
        !sender.is_bot && sender.id == self.owner_id
    }

    pub fn route(&self, me: &Identity, chat: &Chat, thread: Option<u64>) -> Option<Route> {
        if !valid_thread(thread) || chat.id.unsigned_abs() > SAFE_INTEGER {
            return None;
        }
        let channel_id = chat.id.to_string();
        let guild_id = match chat.kind {
            ChatKind::Private if channel_id == self.owner => {
                if thread.is_some() && !me.has_topics_enabled {
                    return None;
                }
                None
            }
            ChatKind::Supergroup if chat.id < 0 && self.chats.contains(&channel_id) => {
                if thread.is_some() && !chat.is_forum {
                    return None;
                }
                Some(channel_id.clone())
            }
            ChatKind::Group
                if thread.is_none() && chat.id < 0 && self.chats.contains(&channel_id) =>
            {
                Some(channel_id.clone())
            }
            ChatKind::Private | ChatKind::Group | ChatKind::Supergroup | ChatKind::Other => {
                return None;
            }
        };
        Some(Route {
            platform: "telegram".into(),
            account_id: me.id.to_string(),
            authority_id: self.owner.clone(),
            guild_id,
            channel_id,
            thread_id: thread.map(|id| id.to_string()),
            topic_id: None,
        })
    }

    pub fn authorize(&self, me: &Identity, route: &Route) -> Result<(), EffectError> {
        let chat = match &route.guild_id {
            None => route.channel_id == self.owner,
            Some(guild) => guild == &route.channel_id && self.chats.contains(&route.channel_id),
        };
        if route.platform != "telegram"
            || route.account_id != me.id.to_string()
            || route.authority_id != self.owner
            || !chat
            || (route.topic_id.is_some() && route.thread_id.is_some())
            || route
                .thread_id
                .as_deref()
                .is_some_and(|id| positive_id(id).is_none())
        {
            return Err(EffectError::rejected(
                "Telegram route is not authorized for this bot and owner",
            ));
        }
        Ok(())
    }
}

const fn valid_thread(thread: Option<u64>) -> bool {
    match thread {
        None => true,
        Some(id) => id > 0 && id <= SAFE_INTEGER,
    }
}
