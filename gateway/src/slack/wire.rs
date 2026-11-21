use std::borrow::Cow;
use std::cmp::Ordering;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::de::{DeserializeOwned, Error as _};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::adapter::EffectError;

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Route {
    pub(super) platform: String,
    pub(super) account_id: String,
    pub(super) authority_id: String,
    // These nullable route fields must still be present on the wire.
    #[serde(deserialize_with = "Option::deserialize")]
    pub(super) guild_id: Option<String>,
    pub(super) channel_id: String,
    #[serde(deserialize_with = "Option::deserialize")]
    pub(super) thread_id: Option<Ts>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) topic_id: Option<String>,
}

impl Route {
    pub(super) fn physical(&self) -> Self {
        Self {
            topic_id: None,
            ..self.clone()
        }
    }

    pub(super) fn key(&self) -> String {
        // JSON array with an optional seventh value, matching the durable TS key.
        let mut key = vec![
            json!(self.platform),
            json!(self.account_id),
            json!(self.authority_id),
            json!(self.guild_id),
            json!(self.channel_id),
            json!(self.thread_id),
        ];
        if let Some(topic) = &self.topic_id {
            key.push(json!(topic));
        }
        Value::Array(key).to_string()
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq, Serialize)]
#[serde(transparent)]
pub(super) struct Ts(String);

impl Ts {
    pub(super) fn parse(raw: &str) -> Option<Self> {
        let (seconds, micros) = raw.split_once('.')?;
        (!seconds.is_empty()
            && seconds.len() <= 20
            && micros.len() == 6
            && seconds.bytes().all(|byte| byte.is_ascii_digit())
            && micros.bytes().all(|byte| byte.is_ascii_digit()))
        .then(|| Self(raw.to_owned()))
    }

    pub(super) fn as_str(&self) -> &str {
        &self.0
    }

    pub(super) fn compare(&self, other: &Self) -> Ordering {
        let left = self.0.trim_start_matches('0');
        let right = other.0.trim_start_matches('0');
        left.len().cmp(&right.len()).then_with(|| left.cmp(right))
    }

    pub(super) fn millis(&self) -> f64 {
        // Lossy presentation time only; source IDs and pagination use the exact decimal.
        self.0.parse::<f64>().unwrap_or_default() * 1_000.0
    }

    pub(super) fn whole_millis(&self) -> Option<i64> {
        let (seconds, micros) = self.0.split_once('.')?;
        let millis = micros.get(..3)?.parse::<i64>().ok()?;
        seconds.parse::<i64>().ok()?.checked_mul(1000)?.checked_add(millis)
    }
}

impl<'de> Deserialize<'de> for Ts {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let raw = Cow::<str>::deserialize(d)?;
        Self::parse(&raw).ok_or_else(|| D::Error::custom("invalid Slack timestamp"))
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Attachment {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) url: String,
    pub(super) size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) content_type: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Inbound {
    pub(super) id: String,
    pub(super) route: Route,
    pub(super) message_id: Option<Ts>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) invocation_id: Option<String>,
    pub(super) text: String,
    pub(super) received_at: Value,
    pub(super) attachments: Vec<Attachment>,
}

pub(super) fn decode<T: DeserializeOwned>(value: &Value) -> Result<T, EffectError> {
    T::deserialize(value).map_err(|_| EffectError::rejected("Invalid Slack effect arguments"))
}

pub(super) fn text(value: &Value) -> Result<&str, EffectError> {
    value
        .as_str()
        .ok_or_else(|| EffectError::rejected("Slack effect requires a string"))
}

pub(super) fn slack_id(raw: &str) -> bool {
    let mut bytes = raw.bytes();
    raw.len() >= 2
        && bytes.next().is_some_and(|byte| byte.is_ascii_uppercase())
        && bytes.all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit())
}

pub(super) fn file_id(raw: &str) -> bool {
    raw.starts_with('F') && slack_id(raw)
}

pub(super) fn digest(value: &Value) -> String {
    hex::encode(Sha256::digest(value.to_string().as_bytes()))
}

pub(super) fn short_hash(value: &Value) -> String {
    hex::encode(&Sha256::digest(value.to_string().as_bytes())[..12])
}

pub(super) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
        })
}

pub(super) fn same_optional(value: &Value, key: &str, expected: &str) -> bool {
    value
        .get(key)
        .is_none_or(|value| value.as_str() == Some(expected))
}

pub(super) fn js_len(text: &str) -> usize {
    text.encode_utf16().count()
}
