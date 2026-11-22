use anyhow::{Context, Result};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{AuthorityError, PHYSICAL_ROUTE_FIELDS, Store, json_equal};

pub(crate) const OPERATION: &str = "messengerPresence";

const SOURCE: AuthorityError =
    AuthorityError("Messenger presence requires an original received owner source");
const ROUTE: AuthorityError =
    AuthorityError("Messenger presence requires the exact original owner route");
const ORIGIN: AuthorityError =
    AuthorityError("Messenger presence requires an original Discord message or application command");
const CONFLICT: AuthorityError = AuthorityError("Messenger presence request identity conflict");
const STALE: AuthorityError =
    AuthorityError("Messenger presence request is older than the current intent");

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Action {
    Start,
    Status,
    Stop,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Intent {
    Online,
    Invisible,
}

impl Intent {
    pub(crate) const fn status(self) -> &'static str {
        match self {
            Self::Online => "online",
            Self::Invisible => "invisible",
        }
    }
}

pub(crate) struct Attempt<'a> {
    pub id: &'a str,
    pub source_id: &'a str,
    pub account_id: &'a str,
    pub action: Action,
    pub request: &'a Value,
}

pub(crate) struct Snapshot {
    pub desired: Option<Intent>,
    pub replayed: bool,
}

pub(crate) struct PresenceStore<'a>(pub(crate) &'a Store);

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct Snowflake(u64);

impl Snowflake {
    fn parse(value: &str) -> Option<Self> {
        if !(1..=20).contains(&value.len())
            || value.starts_with('0')
            || !value.bytes().all(|digit| digit.is_ascii_digit())
        {
            return None;
        }
        value.parse::<u64>().ok().map(Self)
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Origin {
    Message(Snowflake),
    Interaction(Snowflake),
}

impl Origin {
    fn read(input: &Value) -> Option<Self> {
        if input.get("pickerSelection").is_some() || input.get("invocationId").is_some() {
            return None;
        }
        let account = input["route"]["accountId"].as_str()?;
        let id = input["id"].as_str()?;
        match (input.get("messageId")?, input.get("interactionId")) {
            (Value::String(message), None)
                if id == format!("discord:{account}:{message}:original") =>
            {
                Snowflake::parse(message).map(Self::Message)
            }
            (Value::Null, Some(Value::String(interaction)))
                if id == format!("discord:{account}:interaction:{interaction}") =>
            {
                Snowflake::parse(interaction).map(Self::Interaction)
            }
            _ => None,
        }
    }

    fn snowflake(self) -> Snowflake {
        match self {
            Self::Message(id) | Self::Interaction(id) => id,
        }
    }
}

pub(super) fn create(db: &Connection) -> Result<()> {
    // SQLite INTEGER is signed; the canonical text is compared as u64 in Rust.
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS discord_presence_intent (
           account_id TEXT PRIMARY KEY, source_snowflake TEXT NOT NULL,
           desired TEXT NOT NULL CHECK(desired IN ('online','invisible'))
         );
         CREATE TABLE IF NOT EXISTS discord_presence_requests (
           source_id TEXT PRIMARY KEY, arguments TEXT NOT NULL
         );",
    )?;
    Ok(())
}

impl PresenceStore<'_> {
    pub(crate) fn has_discord_presence(&self) -> Result<bool> {
        Ok(self.0.db()?.query_row(
            "SELECT EXISTS(SELECT 1 FROM discord_presence_intent)",
            [],
            |row| row.get(0),
        )?)
    }

    pub(crate) fn discord_presence(&self, account_id: &str) -> Result<Option<Intent>> {
        let db = self.0.db()?;
        Ok(current(&db, account_id)?.map(|(_, desired)| desired))
    }

    pub(crate) fn apply_discord_presence(&self, attempt: Attempt<'_>) -> Result<Snapshot> {
        let mut db = self.0.db()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let source = source_origin(&tx, attempt.source_id, &attempt.request["route"])?;
        let previous = current(&tx, attempt.account_id)?;
        let known_effect = tx.query_row(
            "SELECT operation,arguments FROM gateway_effects WHERE id=?",
            [attempt.id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        ).optional()?;
        let args = std::slice::from_ref(attempt.request);
        if let Some((operation, saved)) = &known_effect {
            let saved: Vec<Value> = serde_json::from_str(saved)?;
            if operation != OPERATION || saved.len() != 1 || !json_equal(&saved[0], &args[0], true) {
                return Err(CONFLICT.into());
            }
        }
        let requested = match attempt.action {
            Action::Start => Some(Intent::Online),
            Action::Status => None,
            Action::Stop => Some(Intent::Invisible),
        };
        let mut desired = previous.map(|(_, intent)| intent);
        let mut replayed = known_effect.is_some();
        if let Some(intent) = requested {
            let saved: Option<String> = tx.query_row(
                "SELECT arguments FROM discord_presence_requests WHERE source_id=?",
                [attempt.source_id],
                |row| row.get(0),
            ).optional()?;
            if let Some(saved) = saved {
                let saved: Value = serde_json::from_str(&saved)?;
                if !json_equal(&saved, attempt.request, false) {
                    return Err(CONFLICT.into());
                }
                replayed = true;
            } else {
                let snowflake = source.snowflake();
                if previous.is_some_and(|(last, _)| snowflake <= last) {
                    return Err(STALE.into());
                }
                tx.execute(
                    "INSERT INTO discord_presence_requests(source_id,arguments) VALUES (?,?)",
                    params![attempt.source_id, serde_json::to_string(attempt.request)?],
                )?;
                tx.execute(
                    "INSERT INTO discord_presence_intent(account_id,source_snowflake,desired)
                     VALUES (?,?,?) ON CONFLICT(account_id) DO UPDATE SET
                     source_snowflake=excluded.source_snowflake,desired=excluded.desired",
                    params![attempt.account_id, snowflake.0.to_string(), intent.status()],
                )?;
                desired = Some(intent);
            }
        }
        if known_effect.is_none() {
            // Reserve the shared wire identity without caching a changing live snapshot.
            tx.execute(
                "INSERT INTO gateway_effects(id,operation,arguments,state,result)
                 VALUES (?,?,?,'complete','null')",
                params![attempt.id, OPERATION, serde_json::to_string(args)?],
            )?;
        }
        tx.commit()?;
        Ok(Snapshot { desired, replayed })
    }
}

fn current(db: &Connection, account_id: &str) -> Result<Option<(Snowflake, Intent)>> {
    let entry: Option<(String, String)> = db.query_row(
        "SELECT source_snowflake,desired FROM discord_presence_intent WHERE account_id=?",
        [account_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional()?;
    entry.map(|(source, status)| {
        let snowflake = Snowflake::parse(&source).context("Invalid saved Discord presence source")?;
        let desired = match status.as_str() {
            "online" => Intent::Online,
            "invisible" => Intent::Invisible,
            _ => anyhow::bail!("Invalid saved Discord presence intent"),
        };
        Ok((snowflake, desired))
    }).transpose()
}

fn source_origin(db: &Connection, id: &str, route: &Value) -> Result<Origin> {
    let has_inputs: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='inputs' AND type='table')",
        [],
        |row| row.get(0),
    )?;
    if !has_inputs {
        return Err(SOURCE.into());
    }
    let source: Option<String> = db.query_row(
        "SELECT inputs.data FROM inputs
         JOIN metadata ON metadata.key='user-source:'||inputs.id AND metadata.value='true'
         WHERE inputs.id=? AND inputs.state NOT IN ('cancelled','uncertain')",
        [id],
        |row| row.get(0),
    ).optional()?;
    let input: Value = serde_json::from_str(&source.ok_or(SOURCE)?)?;
    if input["id"] != id || !json_equal(&input["route"], route, false) {
        return Err(ROUTE.into());
    }
    let origin = Origin::read(&input).ok_or(ORIGIN)?;
    // HEAD owns topic assignment and direct history intake. When a Gateway
    // receipt exists, it must agree on the immutable physical destination.
    let event: Option<(String, Option<String>)> = db.query_row(
        "SELECT data,delivery_error FROM gateway_events WHERE identity=?",
        [format!("message:{id}")],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional()?;
    if let Some((data, outcome)) = event {
        let event: Value = serde_json::from_str(&data)?;
        if event["kind"] != "message" || event["input"]["id"] != id
            || outcome.as_deref() == Some("rejected")
            || PHYSICAL_ROUTE_FIELDS
                .iter()
                .any(|field| event["input"]["route"].get(*field) != route.get(*field))
        {
            return Err(ROUTE.into());
        }
        if Origin::read(&event["input"]) != Some(origin) {
            return Err(ORIGIN.into());
        }
    } else if matches!(origin, Origin::Interaction(_)) {
        // Only messages can be recovered by authenticated REST history.
        return Err(ORIGIN.into());
    }
    Ok(origin)
}
