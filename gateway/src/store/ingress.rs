use anyhow::{Context, Result, bail};
use rusqlite::{OptionalExtension, Row, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use url::Url;
use uuid::Uuid;

use super::{PHYSICAL_ROUTE_FIELDS, Store, json_equal, now, string};

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum GatewayReceipt {
    Accepted,
    Rejected,
    Unresolved,
}

#[derive(Serialize)]
pub struct QueuedEvent {
    pub sequence: i64,
    pub event: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reconciliation: Option<bool>,
}

struct EventRow {
    sequence: i64,
    data: String,
    attempted_at: Option<i64>,
    delivery_error: Option<String>,
}

impl EventRow {
    fn read(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            sequence: row.get(0)?,
            data: row.get(1)?,
            attempted_at: row.get(2)?,
            delivery_error: row.get(3)?,
        })
    }
}

impl Store {
    pub fn admit(&self, event: &Value) -> Result<bool> {
        let kind = string(event, "kind")?;
        let key = match kind {
            "message" => format!("message:{}", string(&event["input"], "id")?),
            "answer" => format!("answer:{}", string(event, "approvalId")?),
            "restart" => format!(
                "restart:{}:{}",
                string(event, "requestId")?,
                string(event, "outcome")?
            ),
            "reconnect" => format!("reconnect:{}", Uuid::new_v4()),
            _ => bail!("Unknown Gateway event kind"),
        };
        let serialized = serde_json::to_string(event)?;
        let mut db = self.db()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if kind == "reconnect" {
            let duplicate: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM gateway_events WHERE delivered_at IS NULL AND data=?)",
                [&serialized],
                |row| row.get(0),
            )?;
            if duplicate {
                return Ok(false);
            }
        }
        let existing = tx
            .query_row(
                "SELECT data FROM gateway_events WHERE identity=?",
                [&key],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        if let Some(existing) = existing {
            if !json_equal(
                &identity(serde_json::from_str(&existing)?)?,
                &identity(event.clone())?,
                false,
            ) {
                bail!("Gateway ingress identity conflict");
            }
            return Ok(false);
        }
        tx.execute(
            "INSERT INTO gateway_events(identity,data,received_at) VALUES (?,?,?)",
            params![key, serialized, now()?],
        )?;
        tx.commit()?;
        Ok(true)
    }

    pub fn next(&self, sequence: Option<i64>) -> Result<Option<QueuedEvent>> {
        let db = self.db()?;
        if sequence.is_none() {
            let held: bool = db.query_row(
                "SELECT EXISTS(SELECT 1 FROM metadata WHERE key = ? AND
                    json_extract(value,'$.stage') IN ('stopping','starting','launching'))",
                [super::HEAD_ROTATION],
                |row| row.get(0),
            )?;
            if held {
                return Ok(None);
            }
        }
        let mut row = db
            .query_row(
                "SELECT sequence,data,attempted_at,delivery_error FROM gateway_events
             WHERE delivered_at IS NULL AND (?1 IS NULL OR sequence=?1) ORDER BY sequence LIMIT 1",
                [sequence],
                EventRow::read,
            )
            .optional()?;
        if sequence.is_none()
            && row.as_ref().and_then(|row| row.delivery_error.as_deref()) == Some("unresolved")
        {
            // Quarantine blocks ordinary intake, not its reconciliation barrier
            // or source-bound operator recovery controls.
            let control = db.query_row(
                "SELECT sequence,data,attempted_at,delivery_error FROM gateway_events
                 WHERE delivered_at IS NULL AND (
                   (json_extract(data,'$.kind')='reconnect' AND json_extract(data,'$.barrier') IS NOT NULL)
                   OR (json_extract(data,'$.kind')='message' AND trim(json_extract(data,'$.input.text')) IN ('/restart','/stop','/stop head')))
                 ORDER BY CASE WHEN json_extract(data,'$.kind')='reconnect' THEN 0 ELSE 1 END,sequence LIMIT 1",
                [],
                EventRow::read,
            ).optional()?;
            if control.is_some() {
                row = control;
            }
        }
        row.map(|row| {
            let event: Value = serde_json::from_str(&row.data)?;
            let reconciliation =
                (event["kind"] == "answer" && row.attempted_at.is_some()).then_some(true);
            Ok(QueuedEvent {
                sequence: row.sequence,
                event,
                reconciliation,
            })
        })
        .transpose()
    }

    pub fn attempt(&self, sequence: i64) -> Result<()> {
        self.db()?.execute(
            "UPDATE gateway_events SET attempted_at=COALESCE(attempted_at,?) WHERE sequence=? AND delivered_at IS NULL",
            params![now()?, sequence],
        )?;
        Ok(())
    }

    pub fn receipt(&self, sequence: i64, outcome: GatewayReceipt) -> Result<()> {
        let (delivered_at, error) = match outcome {
            GatewayReceipt::Accepted => (Some(now()?), None),
            GatewayReceipt::Rejected => (Some(now()?), Some("rejected")),
            GatewayReceipt::Unresolved => (None, Some("unresolved")),
        };
        self.db()?.execute(
            "UPDATE gateway_events SET delivered_at=?,delivery_error=? WHERE sequence=? AND delivered_at IS NULL",
            params![delivered_at, error, sequence],
        )?;
        Ok(())
    }

    pub fn has_pending_answer(&self, approval_id: &str, route: &Value) -> Result<bool> {
        Ok(self.answer_for_route(approval_id, route, true)?.is_some())
    }

    /// Proves admission of this exact response, not successful HEAD delivery.
    /// A completed receipt or rejection does not erase the committed event.
    pub fn has_durable_answer(&self, id: &str, route: &Value, response_hash: &str) -> Result<bool> {
        let Some(event) = self.answer_for_route(id, route, false)? else {
            return Ok(false);
        };
        let Some(response) = event
            .get("response")
            .filter(|response| response.is_object())
        else {
            return Ok(false);
        };
        Ok(answer_digest(response)? == response_hash)
    }

    fn answer_for_route(
        &self,
        id: &str,
        route: &Value,
        pending_only: bool,
    ) -> Result<Option<Value>> {
        let data = self.db()?.query_row(
            "SELECT data FROM gateway_events WHERE identity=?1 AND (?2=0 OR delivered_at IS NULL)",
            params![format!("answer:{id}"), pending_only],
            |row| row.get::<_, String>(0),
        ).optional()?;
        let Some(data) = data else { return Ok(None) };
        let event: Value = serde_json::from_str(&data)?;
        let event_route = &event["route"];
        if event["kind"] != "answer"
            || event["approvalId"] != id
            || !event_route.is_object()
            || !route.is_object()
            || PHYSICAL_ROUTE_FIELDS
                .iter()
                .any(|field| event_route.get(*field) != route.get(*field))
            || event_route.get("topicId") != route.get("topicId")
        {
            return Ok(None);
        }
        Ok(Some(event))
    }

    pub fn pending(&self) -> Result<u64> {
        Ok(self.db()?.query_row(
            "SELECT COUNT(*) FROM gateway_events WHERE delivered_at IS NULL",
            [],
            |row| row.get(0),
        )?)
    }

    pub(crate) fn pending_barrier(&self) -> Result<Option<String>> {
        Ok(self
            .db()?
            .query_row(
                "SELECT json_extract(data,'$.barrier') FROM gateway_events
             WHERE delivered_at IS NULL AND json_extract(data,'$.kind')='reconnect'
               AND json_type(data,'$.barrier')='text'
             ORDER BY sequence LIMIT 1",
                [],
                |row| row.get(0),
            )
            .optional()?)
    }

    pub fn unresolved(&self) -> Result<u64> {
        Ok(self.db()?.query_row(
            "SELECT COUNT(*) FROM gateway_events WHERE delivered_at IS NULL AND delivery_error='unresolved'",
            [],
            |row| row.get(0),
        )?)
    }
}

/// Lowercase SHA-256 of compact JSON after recursively sorting object keys.
/// Array order and scalar types/values remain part of the response identity.
pub fn answer_digest(response: &Value) -> Result<String> {
    let mut canonical = response.clone();
    canonical.sort_all_objects();
    Ok(hex::encode(Sha256::digest(serde_json::to_vec(&canonical)?)))
}

fn identity(mut event: Value) -> Result<Value> {
    if event["kind"] != "message" {
        return Ok(event);
    }
    let input = event
        .get_mut("input")
        .and_then(Value::as_object_mut)
        .context("Invalid Gateway input")?;
    for key in ["receivedAt", "reply", "discordContext"] {
        input.remove(key);
    }
    let discord = input
        .get("route")
        .and_then(|route| route.get("platform"))
        .and_then(Value::as_str)
        == Some("discord");
    let files = input
        .get_mut("attachments")
        .and_then(Value::as_array_mut)
        .context("Invalid Gateway attachments")?;
    for file in &mut *files {
        let file = file.as_object_mut().context("Invalid Gateway attachment")?;
        file.remove("voice");
        file.remove("durationSeconds");
        if discord
            && let Some(location) = file.get_mut("url")
            && let Some(mut url) = location.as_str().and_then(|raw| Url::parse(raw).ok())
            && url.scheme() == "https"
            && matches!(
                url.host_str(),
                Some("cdn.discordapp.com" | "media.discordapp.net")
            )
        {
            let mut params: Vec<_> = url
                .query_pairs()
                .filter(|(key, _)| !matches!(key.as_ref(), "ex" | "is" | "hm"))
                .map(|(key, value)| (key.into_owned(), value.into_owned()))
                .collect();
            params.sort_by(|(left, _), (right, _)| left.encode_utf16().cmp(right.encode_utf16()));
            if params.is_empty() {
                url.set_query(None);
            } else {
                url.query_pairs_mut().clear().extend_pairs(params);
            }
            *location = Value::String(url.into());
        }
    }
    files.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    Ok(event)
}
