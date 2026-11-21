use std::{path::{Path, PathBuf}, time::Duration};

use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::time::{Instant, sleep};
use uuid::Uuid;

use crate::store::{HEAD_ROTATION, HEAD_SESSION_FILE, Store};

use super::{
    Lifecycle, LifecycleConfig, Phase,
    fs::{self, EXIT_TIMEOUT, WAIT_SLICE, alive},
    host_rpc::{Head, ShutdownRefused, confirmed_exit},
    restart_record::{HEAD, STOP, meta},
};

const MIN_IDLE_MS: u64 = 30 * 60 * 1000;
const PROBE_INTERVAL: Duration = Duration::from_secs(15);

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(super) enum Stage {
    Stopping,
    Starting,
    Launching,
    Complete,
    Refused,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Rotation {
    pub id: String,
    pub stage: Stage,
    pub original: Head,
    pub session_file: PathBuf,
    pub config_hash: String,
    pub stop_boundary: Option<String>,
    pub attestation: Attestation,
    pub replacement_session_id: Option<String>,
    pub replacement_owner_pid: Option<u32>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Attestation {
    pub generation: u64,
    idle_ms: u64,
    context_percent: f64,
    native_run: u64,
    pub selection: Selection,
    // Opaque to Gateway. Only the runtime may use these source-bound
    // admissions, after verifying the unchanged lane processes and journals.
    residents: Vec<Value>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Selection {
    provider: String,
    model_id: String,
    reasoning: bool,
    thinking_level: Option<String>,
    configured_thinking_level: Option<String>,
    pub model_settings: Value,
}

impl Selection {
    pub fn matches(&self, state: &Value) -> bool {
        let model = &state["model"];
        let level = state["thinkingLevel"].as_str();
        let configured = state["configuredThinkingLevel"].as_str();
        model["provider"].as_str() == Some(&self.provider)
            && model["id"].as_str() == Some(&self.model_id)
            && model["reasoning"].as_bool() == Some(self.reasoning)
            && state.get("configuredThinkingLevel").is_some()
            && (self.configured_thinking_level.as_deref() == Some("auto")
                || self.effort_matches(self.thinking_level.as_deref(), level))
            && self.effort_matches(self.configured_thinking_level.as_deref(), configured)
            && state["modelSettings"] == self.model_settings
    }

    fn effort_matches(&self, before: Option<&str>, current: Option<&str>) -> bool {
        before == current || (!self.reasoning
            && matches!((before, current), (None, Some("off")) | (Some("off"), None)))
    }
}

pub(super) fn valid_session_file(config: &LifecycleConfig, path: &Path) -> bool {
    if path == config.head_session {
        return true;
    }
    let Some(parent) = path.parent() else { return false };
    let Some(generation) = parent.file_name().and_then(|id| id.to_str()) else { return false };
    Uuid::parse_str(generation).is_ok()
        && path == config.state_dir.join("sessions/main/rotated").join(generation).join("session.jsonl")
}

pub(super) fn session_file(config: &LifecycleConfig, store: &Store) -> Result<PathBuf> {
    session_file_from_meta(config, store.get_meta(HEAD_SESSION_FILE)?)
}

pub(super) fn session_file_from_meta(config: &LifecycleConfig, value: Option<String>) -> Result<PathBuf> {
    let path = value.map_or_else(|| config.head_session.clone(), PathBuf::from);
    ensure!(valid_session_file(config, &path), "Invalid durable HEAD session file");
    Ok(path)
}

impl Lifecycle {
    pub(super) fn rotation(&self) -> Result<Option<Rotation>> {
        let config = &self.0.config;
        let plan: Option<Rotation> = meta(self.0.store.get_meta(HEAD_ROTATION)?)?;
        if let Some(plan) = &plan {
            let target = config.state_dir.join("sessions/main/rotated").join(&plan.id).join("session.jsonl");
            ensure!(Uuid::parse_str(&plan.id).is_ok() && plan.session_file == target && plan.original.session_file != target
                && valid_session_file(config, &plan.original.session_file),
                "Invalid durable HEAD rotation paths");
        }
        Ok(plan)
    }

    pub(super) async fn monitor_rotation(&self, controller_ready: bool) -> Result<()> {
        let _supervising = self.0.supervision.lock().await;
        if let Some(mut plan) = self.rotation()? && plan.stage == Stage::Stopping {
            // A crash/timeout after sending shutdown is never authorization to
            // send it again. Only an exact clean exit can resume the rotation.
            if !alive(plan.original.pid)? {
                self.finish_rotation_exit(&mut plan).await?;
            } else {
                self.state()?.head_error =
                    Some("HEAD rotation is waiting for verified exit; no shutdown was repeated");
            }
            return Ok(());
        }
        let head = {
            let mut state = self.state()?;
            if state.phase != Phase::Running || !controller_ready || *self.0.closing.borrow()
                || state.next_rotation_probe.is_some_and(|next| next > Instant::now())
            {
                return Ok(());
            }
            state.next_rotation_probe = Some(Instant::now() + PROBE_INTERVAL);
            state.head.clone()
        };
        let Some(head) = head else { return Ok(()) };
        let mut probe = match self.probe().await {
            Ok(probe) if probe.head.same(&head) => probe,
            _ => return Ok(()), // Ordinary ownership supervision handles outages.
        };
        if !probe.idle_for_restart() || !known_context(&probe.state) {
            return Ok(());
        }
        let Some(attestation) = probe.rotation_attestation().await? else { return Ok(()) };
        if attestation.idle_ms < MIN_IDLE_MS || attestation.context_percent < 50.0
            || !attestation.selection.matches(&probe.state) {
            return Ok(());
        }
        let store = &self.0.store;
        let id = Uuid::new_v4().to_string();
        let mut plan = Rotation {
            session_file: self.0.config.state_dir.join("sessions/main/rotated").join(&id).join("session.jsonl"),
            id, stage: Stage::Stopping, original: head,
            config_hash: self.0.config.config_hash()?,
            stop_boundary: store.get_meta(STOP)?,
            attestation, replacement_session_id: None, replacement_owner_pid: None,
        };
        {
            let mut state = self.state()?;
            let recorded = store.get_meta(HEAD_ROTATION)?;
            let generation = store.get_meta("main:generation")?.as_deref().unwrap_or("0").parse::<u64>()?;
            if state.phase != Phase::Running || *self.0.closing.borrow()
                || generation != plan.attestation.generation
                || self.0.config_hash.get() != Some(&plan.config_hash)
                || !store.begin_rotation(recorded.as_deref(), plan.stop_boundary.as_deref(), &serde_json::to_string(&plan)?)?
            {
                return Ok(());
            }
            state.phase = Phase::Rotating;
        }
        if let Err(error) = probe.shutdown_rotation(&plan.id).await {
            if error.downcast_ref::<ShutdownRefused>().is_some() {
                self.refuse_rotation(&mut plan)?;
                return Ok(());
            }
            // Marker remains stopping: do not reissue shutdown or launch
            // until the exact persistence/exit receipt can be read.
            return Err(error);
        }
        drop(probe);
        self.finish_rotation_exit(&mut plan).await
    }

    async fn finish_rotation_exit(&self, plan: &mut Rotation) -> Result<()> {
        let config = &self.0.config;
        confirmed_exit(&config.head_socket, &plan.original).await?;
        let deadline = Instant::now() + EXIT_TIMEOUT;
        while alive(plan.original.owner_pid)? {
            ensure!(Instant::now() < deadline, "Rotating HEAD pipe owner has not exited");
            sleep(WAIT_SLICE).await;
        }
        ensure!(fs::metadata(&config.head_socket)?.is_none(), "Rotating HEAD socket ownership changed");
        let mut state = self.state()?;
        let store = &self.0.store;
        if state.phase == Phase::OperatorStopping || *self.0.closing.borrow()
            || store.get_meta(STOP)? != plan.stop_boundary
        {
            return Ok(());
        }
        let generation = plan.attestation.generation.checked_add(1).context("HEAD generation exhausted")?;
        ensure!(generation <= 9_007_199_254_740_991, "HEAD generation exhausted");
        ensure!(config.config_hash()? == plan.config_hash, "Gateway configuration changed during HEAD rotation");
        let current: Head = meta(store.get_meta(HEAD)?)?.context("Missing rotating HEAD")?;
        ensure!(plan.original.same(&current), "Rotating HEAD ownership changed");
        plan.stage = Stage::Starting;
        store.advance_rotation(generation, plan.session_file.to_str().context("Non-UTF8 HEAD session path")?,
            &serde_json::to_string(plan)?)?;
        state.head = None;
        state.phase = Phase::Running;
        Ok(())
    }

    pub(super) fn refuse_rotation(&self, plan: &mut Rotation) -> Result<()> {
        let mut state = self.state()?;
        plan.stage = Stage::Refused;
        self.0.store.set_meta(HEAD_ROTATION, &serde_json::to_string(plan)?)?;
        if state.phase == Phase::Rotating {
            state.phase = Phase::Running;
        }
        if let Some(changed) = self.0.notify.get() {
            changed.notify_one();
        }
        Ok(())
    }

    pub(super) fn publish_rotation(&self, plan: &mut Rotation, head: &Head, snapshot: &Value) -> Result<()> {
        ensure!(plan.stage == Stage::Launching
            && head.pid != plan.original.pid && head.owner_pid != plan.original.owner_pid
            && alive(head.pid)? && alive(head.owner_pid)?
            && head.session_id != plan.original.session_id && head.session_file == plan.session_file
            && plan.replacement_owner_pid == Some(head.owner_pid)
            && plan.replacement_session_id.as_deref() == Some(head.session_id.as_str())
            && plan.attestation.selection.matches(snapshot),
            "Rotated HEAD identity/model/effort is not confirmed");
        plan.stage = Stage::Complete;
        self.0.store.finish_rotation(&json!(head), &serde_json::to_string(plan)?)?;
        if let Some(changed) = self.0.notify.get() {
            changed.notify_one();
        }
        Ok(())
    }
}

fn known_context(state: &Value) -> bool {
    let usage = &state["contextUsage"];
    usage["tokens"].as_u64().is_some()
        && usage["contextWindow"].as_u64().is_some_and(|size| size > 0)
        && usage["percent"].as_f64().is_some_and(|percent| percent >= 50.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rotation_requires_known_stock_context_at_or_above_half() {
        for (context, qualifies) in [
            (json!(null), false),
            (json!({"tokens":null,"contextWindow":100,"percent":50}), false),
            (json!({"tokens":50,"contextWindow":0,"percent":50}), false),
            (json!({"tokens":49,"contextWindow":100,"percent":49.99}), false),
            (json!({"tokens":50,"contextWindow":100,"percent":50}), true),
        ] {
            assert_eq!(known_context(&json!({"contextUsage": context})), qualifies);
        }
    }
}
