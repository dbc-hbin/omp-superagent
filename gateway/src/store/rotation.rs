use anyhow::Result;
use rusqlite::TransactionBehavior;
use serde_json::{Value, json};

use super::{Store, get_meta, set_meta};

pub(crate) const HEAD_ROTATION: &str = "gateway:head-rotation";
pub(crate) const HEAD_SESSION_FILE: &str = "main:sessionFile";

impl Store {
    /// Linearize shutdown authorization with ingress and the operator stop
    /// fence. Events arriving after this commit are durable but not dispatched.
    pub(crate) fn begin_rotation(
        &self,
        preceding: Option<&str>,
        stop_boundary: Option<&str>,
        plan: &str,
    ) -> Result<bool> {
        let mut db = self.db()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let pending: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM gateway_events WHERE delivered_at IS NULL)
                OR EXISTS(SELECT 1 FROM gateway_effects WHERE state='attempted'
                    AND operation IN ('send','presentApproval','dismissApproval','createThread','updateThread'))",
            [],
            |row| row.get(0),
        )?;
        if pending
            || get_meta(&tx, HEAD_ROTATION)?.as_deref() != preceding
            || get_meta(&tx, "gateway:operator-stop")?.as_deref() != stop_boundary
            || get_meta(&tx, "head:restart-fence")?.is_some_and(|value| !value.is_empty())
        {
            return Ok(false);
        }
        set_meta(&tx, HEAD_ROTATION, plan)?;
        tx.commit()?;
        Ok(true)
    }

    /// Publish the new logical head generation only after native exit proof.
    /// No input, lane, approval, route, or outbox record is transferred.
    pub(crate) fn advance_rotation(&self, generation: u64, session_file: &str, plan: &str) -> Result<()> {
        let mut db = self.db()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        set_meta(&tx, HEAD_ROTATION, plan)?;
        set_meta(&tx, HEAD_SESSION_FILE, session_file)?;
        set_meta(&tx, "main:generation", &generation.to_string())?;
        tx.execute("DELETE FROM metadata WHERE key='main:sessionId'", [])?;
        set_meta(&tx, "gateway:head", "null")?;
        tx.commit()?;
        Ok(())
    }

    pub(crate) fn finish_rotation(&self, head: &Value, plan: &str) -> Result<()> {
        let mut db = self.db()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let record: Value = serde_json::from_str(plan)?;
        let original_id = super::string(&record["original"], "sessionId")?;
        let new_id = super::string(head, "sessionId")?;
        let cleared_roles = get_meta(&tx, &format!("head:model-settings:{original_id}"))?
            .map(|saved| serde_json::from_str::<Value>(&saved)).transpose()?
            .and_then(|saved| saved.get("clearedRoles").cloned()).unwrap_or_else(|| json!([]));
        let settings = &record["attestation"]["selection"]["modelSettings"];
        set_meta(&tx, &format!("head:model-settings:{new_id}"),
            &json!({ "settings": settings, "clearedRoles": cleared_roles }).to_string())?;
        set_meta(&tx, &format!("head:rotation-residents:{new_id}"), &json!({
            "generation": get_meta(&tx, "main:generation")?,
            "sessionFile": get_meta(&tx, HEAD_SESSION_FILE)?,
            "residents": record["attestation"]["residents"],
        }).to_string())?;
        set_meta(&tx, HEAD_ROTATION, plan)?;
        set_meta(&tx, "gateway:head", &serde_json::to_string(head)?)?;
        set_meta(&tx, "main:sessionId", new_id)?;
        tx.commit()?;
        Ok(())
    }
}
