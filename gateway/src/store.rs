use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::Path,
    sync::{Mutex, MutexGuard},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result, bail};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

mod ingress;
mod restart;
mod rotation;
#[cfg(test)]
mod tests;

pub use ingress::{GatewayReceipt, QueuedEvent, answer_digest};
pub(crate) use restart::{AuthorityError, js_trim};
pub(crate) use rotation::{HEAD_ROTATION, HEAD_SESSION_FILE};

pub struct Store {
    db: Mutex<Connection>,
    // Independent lifetime lock shared with the old Gateway and native runner.
    // This connection retains its exclusive transaction until it is dropped.
    _lock: Mutex<Connection>,
}

impl Store {
    pub fn open(state_dir: &Path) -> Result<Self> {
        let path = state_dir.join("coordination.sqlite");
        let lock_path = state_dir.join("coordination.sqlite.gateway-lock");
        let lock = Connection::open(&lock_path)?;
        lock.busy_timeout(Duration::from_millis(100))?;
        lock.execute_batch("BEGIN EXCLUSIVE")
            .context("Acquiring Gateway ownership lock")?;
        let mut db = Connection::open(&path)?;
        db.busy_timeout(Duration::from_secs(5))?;
        db.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = FULL;
             CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS gateway_events (
               sequence INTEGER PRIMARY KEY AUTOINCREMENT, identity TEXT NOT NULL UNIQUE,
               data TEXT NOT NULL, received_at INTEGER NOT NULL,
               delivered_at INTEGER, delivery_error TEXT, attempted_at INTEGER
             );
             CREATE INDEX IF NOT EXISTS gateway_events_pending ON gateway_events(delivered_at, sequence);
             CREATE TABLE IF NOT EXISTS gateway_effects (
               id TEXT PRIMARY KEY, operation TEXT NOT NULL, arguments TEXT NOT NULL,
               state TEXT NOT NULL CHECK(state IN ('attempted','complete')),
               result TEXT
             );",
        )?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let attempted: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('gateway_events') WHERE name='attempted_at')",
            [],
            |row| row.get(0),
        )?;
        if !attempted {
            tx.execute_batch(
                "ALTER TABLE gateway_events ADD COLUMN attempted_at INTEGER;
                 UPDATE gateway_events SET attempted_at=received_at
                 WHERE delivered_at IS NULL AND identity LIKE 'answer:%';",
            )?;
        }
        tx.execute(
            "UPDATE gateway_events SET attempted_at=COALESCE(attempted_at,delivered_at,received_at),
             delivered_at=NULL,delivery_error='unresolved' WHERE delivery_error='Head rejected admitted event'",
            [],
        )?;
        tx.commit()?;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
        fs::set_permissions(lock_path, fs::Permissions::from_mode(0o600))?;
        Ok(Self {
            db: Mutex::new(db),
            _lock: Mutex::new(lock),
        })
    }

    pub fn get_meta(&self, key: &str) -> Result<Option<String>> {
        let db = self.db()?;
        get_meta(&db, key)
    }

    pub fn set_meta(&self, key: &str, value: &str) -> Result<()> {
        let db = self.db()?;
        set_meta(&db, key, value)
    }

    pub(crate) fn insert_meta_if_absent(
        &self,
        keys: impl IntoIterator<Item = String>,
        value: &str,
    ) -> Result<()> {
        let mut db = self.db()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        {
            let mut insert = tx.prepare(
                "INSERT INTO metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING",
            )?;
            for key in keys {
                if insert.execute(params![key, value])? == 0 {
                    anyhow::ensure!(
                        get_meta(&tx, &key)?.as_deref() == Some(value),
                        "Conflicting immutable metadata receipt"
                    );
                }
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn begin_effect(&self, id: &str, operation: &str, args: &[Value]) -> Result<EffectStart> {
        let mut db = self.db()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let previous = tx
            .query_row(
                "SELECT operation,arguments,result FROM gateway_effects WHERE id=?",
                [id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                },
            )
            .optional()?;
        let start = if let Some((saved_operation, saved_args, result)) = previous {
            let saved: Vec<Value> = serde_json::from_str(&saved_args)?;
            if saved_operation != operation
                || !saved.iter().zip(args).all(|(a, b)| json_equal(a, b, true))
                || saved.len() != args.len()
            {
                bail!("Gateway effect identity conflict");
            }
            EffectStart::Previous(match result {
                Some(value) => serde_json::from_str(&value)?,
                None => {
                    json!({"ok": false, "error": "Gateway effect outcome uncertain", "certainty": "uncertain"})
                }
            })
        } else {
            tx.execute(
                "INSERT INTO gateway_effects(id,operation,arguments,state) VALUES (?,?,?,'attempted')",
                params![id, operation, serde_json::to_string(args)?],
            )?;
            EffectStart::Fresh
        };
        tx.commit()?;
        Ok(start)
    }

    pub fn finish_effect(&self, id: &str, result: &Value) -> Result<()> {
        self.db()?.execute(
            "UPDATE gateway_effects SET state='complete',result=? WHERE id=?",
            params![serde_json::to_string(result)?, id],
        )?;
        Ok(())
    }

    pub fn token(&self) -> Result<String> {
        let mut db = self.db()?;
        if let Some(token) = get_meta(&db, "gateway:token")?.filter(|token| !token.is_empty()) {
            return Ok(token);
        }
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let token = match get_meta(&tx, "gateway:token")? {
            Some(value) if !value.is_empty() => value,
            _ => {
                let mut hash = Sha256::new();
                hash.update(Uuid::new_v4().to_string());
                hash.update(Uuid::new_v4().to_string());
                let generated = hex::encode(hash.finalize());
                set_meta(&tx, "gateway:token", &generated)?;
                generated
            }
        };
        tx.commit()?;
        Ok(token)
    }

    fn db(&self) -> Result<MutexGuard<'_, Connection>> {
        self.db
            .lock()
            .map_err(|_| anyhow::anyhow!("Gateway coordination database lock was poisoned"))
    }
}

pub enum EffectStart {
    Fresh,
    Previous(Value),
}

fn get_meta(db: &Connection, key: &str) -> Result<Option<String>> {
    Ok(db
        .query_row("SELECT value FROM metadata WHERE key=?", [key], |row| {
            row.get(0)
        })
        .optional()?)
}

fn set_meta(db: &Connection, key: &str, value: &str) -> Result<()> {
    db.execute(
        "INSERT INTO metadata VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![key, value],
    )?;
    Ok(())
}

pub(crate) fn now() -> Result<i64> {
    Ok(i64::try_from(
        SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis(),
    )?)
}

fn string<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .with_context(|| format!("Missing Gateway identity field {key}"))
}

pub(crate) const PHYSICAL_ROUTE_FIELDS: [&str; 6] = [
    "platform",
    "accountId",
    "authorityId",
    "guildId",
    "channelId",
    "threadId",
];

// JS stores JSON.stringify(args) as effect identity (object property order is
// significant), but uses deep equality for ingress and authorization records.
fn json_equal(left: &Value, right: &Value, ordered: bool) -> bool {
    match (left, right) {
        (Value::Number(a), Value::Number(b)) => {
            let bits = |number: &serde_json::Number| {
                number.as_f64().map(|value| {
                    let normalized = if ordered { value + 0.0 } else { value };
                    normalized.to_bits()
                })
            };
            bits(a) == bits(b)
        }
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(x, y)| json_equal(x, y, ordered))
        }
        (Value::Object(a), Value::Object(b)) if ordered => {
            if a.len() != b.len() {
                return false;
            }
            let [left_keys, right_keys] = [a, b].map(|map| {
                let mut keys: Vec<_> = map.keys().map(String::as_str).collect();
                keys.sort_by_key(|key| js_array_index(key));
                keys
            });
            left_keys == right_keys
                && a.iter()
                    .all(|(key, x)| b.get(key).is_some_and(|y| json_equal(x, y, ordered)))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(key, x)| b.get(key).is_some_and(|y| json_equal(x, y, ordered)))
        }
        _ => left == right,
    }
}

fn js_array_index(key: &str) -> u32 {
    // ECMAScript visits canonical array indices before ordinary properties,
    // which otherwise remain in original insertion order.
    match key.parse::<u32>() {
        Ok(index)
            if key.bytes().all(|byte| byte.is_ascii_digit())
                && (key == "0" || !key.starts_with('0')) =>
        {
            index
        }
        _ => u32::MAX,
    }
}
