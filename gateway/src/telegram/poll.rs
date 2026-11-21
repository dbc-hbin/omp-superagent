use std::{
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::Context as _;
use serde_json::{Value, json};
use tokio::{sync::watch, time::sleep};

use crate::adapter::{Context, EffectError};

use super::{
    Core,
    api::ApiError,
    ingress::Update,
    model::{SAFE_INTEGER, unsigned_id},
};

const RETENTION_MS: u64 = 24 * 60 * 60 * 1000;

pub(super) struct Cursor {
    offset: Option<u64>,
    offset_key: String,
    observed_at_key: String,
}

impl Cursor {
    pub fn load(ctx: &Context, bot: u64) -> anyhow::Result<Self> {
        let offset_key = format!("telegram:{bot}:offset");
        let offset = ctx
            .get_meta(&offset_key)?
            .map(|raw| unsigned_id(&raw).context("Telegram stored update offset is invalid"))
            .transpose()?;
        Ok(Self {
            offset,
            offset_key,
            observed_at_key: format!("telegram:{bot}:observed-at"),
        })
    }

    fn request(&mut self, core: &Core) -> Result<Value, EffectError> {
        let observed = core.get(&self.observed_at_key)?;
        self.offset = fresh_offset(self.offset, observed.as_deref(), wall_time()?);
        let mut payload = json!({
            "timeout":30,
            "limit":100,
            "allowed_updates":["message","edited_message","callback_query"],
        });
        if let Some(offset) = self.offset {
            payload["offset"] = json!(offset);
        }
        Ok(payload)
    }

    async fn consume(
        &mut self,
        core: &Core,
        update: Value,
        observed_at: u64,
        group_since: u64,
    ) -> Result<(), EffectError> {
        let invalid = || EffectError::rejected("Telegram supplied an invalid update ID or payload");
        let id = update
            .get("update_id")
            .and_then(Value::as_u64)
            .ok_or_else(invalid)?;
        let next = id
            .checked_add(1)
            .filter(|next| *next <= SAFE_INTEGER)
            .ok_or_else(invalid)?;
        if self.offset.is_some_and(|offset| id < offset) {
            return Ok(());
        }
        let update: Update = serde_json::from_value(update).map_err(|_| invalid())?;
        core.process(update, group_since).await?;
        // Remote ACK is the following getUpdates request. Offset first: an
        // interrupted paired write never gives an old high offset a fresh age.
        core.set(&self.offset_key, &next.to_string())?;
        core.set(&self.observed_at_key, &observed_at.to_string())?;
        self.offset = Some(next);
        Ok(())
    }
}

pub(super) fn fresh_offset(offset: Option<u64>, observed: Option<&str>, now: u64) -> Option<u64> {
    let age = now.checked_sub(unsigned_id(observed?)?)?;
    offset.filter(|_| age < RETENTION_MS)
}

fn wall_time() -> Result<u64, EffectError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|time| u64::try_from(time.as_millis()).ok())
        .filter(|time| *time <= SAFE_INTEGER)
        .ok_or_else(|| {
            EffectError::uncertain("Telegram cannot establish the update retention clock")
        })
}

pub(super) async fn run(core: Arc<Core>, mut cursor: Cursor, mut stop: watch::Receiver<bool>) {
    let ready = tokio::select! {
        biased;
        _ = stop.changed() => return,
        ready = core.ctx.ready() => ready,
    };
    if ready.is_err() {
        eprintln!("Telegram startup reconciliation failed; intake remains stopped");
        return;
    }
    let mut recovering = false;
    let mut group_since = u64::MAX;
    while !*stop.borrow() {
        let delay = match cursor.request(&core) {
            Ok(body) => {
                if group_since == u64::MAX || recovering {
                    group_since = wall_time().map_or(u64::MAX, |now| now / 1000);
                }
                let response: Result<Vec<Value>, ApiError> = tokio::select! {
                    biased;
                    _ = stop.changed() => return,
                    response = core.api.call("getUpdates", &body) => response,
                };
                match response {
                    Ok(updates) => {
                        let result =
                            process_batch(&core, &mut cursor, updates, recovering, group_since, &stop).await;
                        if result.is_ok() {
                            recovering = false;
                            continue;
                        }
                        eprintln!(
                            "Telegram update admission did not complete; offset retained for replay"
                        );
                        1000
                    }
                    Err(error) => {
                        if matches!(error.code(), Some(401 | 403 | 409)) {
                            eprintln!(
                                "Telegram polling ownership or authorization was lost; intake stopped"
                            );
                            return;
                        }
                        eprintln!(
                            "Telegram update poll failed; retrying without acknowledging new updates"
                        );
                        let safe: EffectError = error.into();
                        safe.retry_after_ms.unwrap_or(0).max(1000)
                    }
                }
            }
            Err(_) => {
                eprintln!("Telegram update cursor could not be read; polling paused");
                1000
            }
        };
        recovering = true;
        tokio::select! {
            biased;
            _ = stop.changed() => return,
            _ = sleep(Duration::from_millis(delay)) => {}
        }
    }
}

async fn process_batch(
    core: &Core,
    cursor: &mut Cursor,
    updates: Vec<Value>,
    recovering: bool,
    group_since: u64,
    stop: &watch::Receiver<bool>,
) -> Result<(), EffectError> {
    let observed_at = wall_time()?;
    if recovering {
        core.admit(json!({"kind":"reconnect"}))?;
    }
    for update in updates {
        if *stop.borrow() {
            break;
        }
        cursor.consume(core, update, observed_at, group_since).await?;
    }
    Ok(())
}
