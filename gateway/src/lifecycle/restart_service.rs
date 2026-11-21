use anyhow::{Context, Result, ensure};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{os::unix::fs::MetadataExt, process};
use tokio::time::{Instant, sleep};

use crate::{adapter::EffectError, store::AuthorityError};

use super::{
    Lifecycle, LifecycleConfig, Phase,
    fs::{EXIT_TIMEOUT, Endpoint, WAIT_SLICE, alive, socket_stat},
    handoff::spawn_runner,
    host_rpc::Head,
    restart_record::{
        self as restart, ACTIVE, FENCE, Fence, Plan, Record, Request, SOCKET, STOP, Stage, plan_key,
    },
    supervision::is_refusal,
};

const OWNERSHIP_PROBE: &str =
    "Native idle or ownership probe was unavailable; no shutdown was requested.";
const STOP_SUPERSEDED: &str = "An explicit operator stop superseded this original restart intent; no successor is authorized.";
const CONFIG_INVALID: &str =
    "The current Gateway configuration could not be validated; no process was stopped.";
const CONFIG_INCOMPATIBLE: &str =
    "Gateway configuration changed the instance, native HEAD profile, or messenger authorization; no process was stopped.";
const CONFIG_CHANGED: &str =
    "Gateway configuration changed after restart acceptance; no process was stopped.";
const RUNNER_REJECTED: &str =
    "Successor configuration, credentials, native profile, or ownership could not be prepared; no process was stopped.";

impl Lifecycle {
    pub(super) async fn validate_replacement(&self, id: &str) -> Result<()> {
        let store = &self.0.store;
        let record = restart::record(store, Some(id))?.context("Missing durable restart record")?;
        let plan = restart::plan(store, id)?.context("Missing durable restart plan")?;
        let session_file = super::rotation::session_file(&self.0.config, store)?;
        restart::validate_plan(&self.0.config, &record, &plan, &session_file).await?;
        let pid = Some(process::id());
        ensure!(
            record.state == Stage::HeadStopped
                && plan.launch_pid == pid
                && record.successor_pid == pid
                && store.get_meta(ACTIVE)?.as_deref() == Some(id)
                && !alive(record.gateway_pid)?
                && !alive(record.head_pid)?
                && !alive(plan.head.owner_pid)?,
            "Replacement Gateway has no exact durable launch authority"
        );
        Ok(())
    }

    pub(super) async fn accept_restart(
        &self,
        value: Value,
    ) -> std::result::Result<Value, EffectError> {
        let request = Request::deserialize(&value)
            .map_err(|_| EffectError::rejected("Invalid Gateway restart request"))?;
        self.0.store.validate_restart(&value).map_err(wire_error)?;
        let (record, head, generation) = {
            let store = &self.0.store;
            let mut state = self.state().map_err(wire_error)?;
            if let Some(existing) =
                restart::record(store, Some(&request.request_id)).map_err(wire_error)?
            {
                if !existing.request.same(&request) {
                    return Err(EffectError::rejected("Restart request identity conflict"));
                }
                return serde_json::to_value(existing)
                    .map_err(|_| EffectError::uncertain("Restart record is unavailable"));
            }
            let head = state.head.clone().ok_or_else(|| {
                EffectError::rejected("Owned HEAD is unavailable; restart was not authorized")
            })?;
            let record = Record::accept(request, &head);
            if *self.0.closing.borrow()
                || state.phase != Phase::Running
                || restart::active_record(store)
                    .map_err(wire_error)?
                    .is_some_and(|active| active.state.blocks_start())
            {
                return self.outcome(record, Stage::Refused,
                    "Gateway already has an active or unresolved lifecycle operation; no process was stopped.")
                    .map_err(wire_error);
            }
            state.phase = Phase::Accepting;
            (record, head, state.stop_generation)
        };
        let probe = self.inspect_restart(&record, &head).await;
        let store = &self.0.store;
        let mut state = self.state().map_err(wire_error)?;
        let decision = (|| -> Result<Value> {
            let (plan, fence) = match probe {
                Ok(pair) => pair,
                Err(error) => {
                    let reason = error
                        .downcast_ref::<Refusal>()
                        .map_or(OWNERSHIP_PROBE, |refusal| refusal.0);
                    return self.outcome(record, Stage::Refused, reason);
                }
            };
            let current: Option<Fence> = restart::meta(store.get_meta(FENCE)?)?;
            if generation != state.stop_generation
                || state.phase != Phase::Accepting
                || store.get_meta(STOP)? != fence.stop_boundary
                || !current.is_some_and(|current| {
                    current.matches(&record.request, &head)
                        && current.stop_boundary == fence.stop_boundary
                })
            {
                return self.outcome(record, Stage::Refused,
                    "An explicit operator stop superseded restart acceptance; no successor was authorized.");
            }
            if !self.0.config.matches_config_hash(&plan.config_hash) {
                return self.outcome(record, Stage::Refused, CONFIG_CHANGED);
            }
            // A partially persisted acceptance cannot later be retried.
            store.set_meta(
                &plan_key(&record.request.request_id),
                &serde_json::to_string(&plan)?,
            )?;
            let value = restart::save(store, &record)?;
            state.phase = Phase::Held;
            store.set_meta(ACTIVE, &record.request.request_id)?;
            state.phase = Phase::Accepted;
            Ok(value)
        })();
        if state.phase == Phase::Accepting && state.stop_generation == generation {
            state.phase = Phase::Running;
        }
        decision.map_err(wire_error)
    }

    async fn inspect_restart(&self, record: &Record, head: &Head) -> Result<(Plan, Fence)> {
        let _supervising = self.0.supervision.lock().await;
        let config = &self.0.config;
        let store = &self.0.store;
        let fence: Fence = restart::meta(store.get_meta(FENCE)?)?.context(Refusal(
            "HEAD restart fence does not match the owned request; no process was stopped.",
        ))?;
        ensure!(
            fence.matches(&record.request, head),
            Refusal("HEAD restart fence does not match the owned request; no process was stopped.")
        );
        ensure!(
            store.get_meta(STOP)? == fence.stop_boundary,
            Refusal(STOP_SUPERSEDED)
        );
        let actual = self.probe().await?;
        ensure!(
            actual.head.same(head),
            Refusal("Native HEAD ownership changed; no process was stopped.")
        );
        ensure!(
            actual.idle_for_restart(),
            Refusal(
                "Native HEAD is busy or its idle ownership state is incomplete; no process was stopped."
            )
        );
        let socket: Endpoint = restart::meta(store.get_meta(SOCKET)?)?.context(Refusal(
            "Gateway endpoint ownership could not be verified; no process was stopped.",
        ))?;
        let stat = socket_stat(&config.gateway_socket, false)?;
        ensure!(
            socket.pid == process::id() && socket.dev == stat.dev() && socket.ino == stat.ino(),
            Refusal("Gateway endpoint ownership could not be verified; no process was stopped.")
        );
        let (_, candidate) = LifecycleConfig::load(&config.path)
            .await
            .map_err(|_| Refusal(CONFIG_INVALID))?;
        ensure!(
            config.restart_compatible(&candidate),
            Refusal(CONFIG_INCOMPATIBLE)
        );
        Ok((
            Plan {
                config_path: config.path.clone(),
                state_dir: config.state_dir.clone(),
                config_hash: candidate.source_hash,
                normalized_config_hash: candidate.normalized_hash,
                socket,
                head: head.clone(),
                runner_pid: None,
                runner_ready: None,
                launch_pid: None,
            },
            fence,
        ))
    }

    fn outcome(&self, mut record: Record, stage: Stage, reason: &str) -> Result<Value> {
        let store = &self.0.store;
        record.state = stage;
        record.reason = Some(reason.into());
        let value = restart::save(store, &record)?;
        store.admit(
            &json!({"kind": "restart", "requestId": record.request.request_id,
            "outcome": stage, "reason": reason}),
        )?;
        if let Some(notify) = self.0.notify.get() {
            notify.notify_one();
        }
        Ok(value)
    }

    pub(super) fn schedule_restart(&self, id: &str) -> Result<()> {
        let mut state = self.state()?;
        if state.restarting || state.phase != Phase::Accepted || *self.0.closing.borrow() {
            return Ok(());
        }
        let Some(record) = restart::record(&self.0.store, Some(id))? else {
            return Ok(());
        };
        if record.state != Stage::Accepted
            || record.gateway_pid != process::id()
            || self.0.store.get_meta(ACTIVE)?.as_deref() != Some(id)
        {
            return Ok(());
        }
        state.restarting = true;
        let service = self.clone();
        tokio::spawn(async move {
            if let Err(error) = service.execute_restart(&record).await
                && service.failed_restart(&record, &error).is_err()
            {
                eprintln!("Gateway could not persist its restart outcome");
            }
            match service.state() {
                Ok(mut state) => state.restarting = false,
                Err(error) => eprintln!("{error}"),
            }
        });
        Ok(())
    }

    async fn execute_restart(&self, record: &Record) -> Result<()> {
        let config = &self.0.config;
        let store = &self.0.store;
        let id = &record.request.request_id;
        let actual = self.probe().await?.head;
        let Some(mut plan) = restart::plan(store, id)? else {
            return Err(EffectError::rejected(
                "Native HEAD ownership changed; restart was refused without a shutdown",
            )
            .into());
        };
        ensure!(
            actual.same(&plan.head),
            EffectError::rejected(
                "Native HEAD ownership changed; restart was refused without a shutdown"
            )
        );
        let mut runner = {
            let state = self.state()?;
            if state.phase != Phase::Accepted || !self.is_accepted(id)? {
                return Ok(());
            }
            self.check_accepted_config(&plan)?;
            let runner = spawn_runner(config, id, &plan.config_hash).map_err(|_| {
                EffectError::rejected(
                    "Successor could not be spawned; native shutdown was not requested",
                )
            })?;
            let pid = runner
                .id()
                .context("Successor runner has no process identity")?;
            plan.runner_pid = Some(pid);
            store.set_meta(&plan_key(id), &serde_json::to_string(&plan)?)?;
            runner
        };
        let deadline = Instant::now() + EXIT_TIMEOUT;
        loop {
            let saved =
                restart::record(store, Some(id))?.context("Successor lost its durable request")?;
            if saved.state == Stage::Refused {
                return Ok(());
            }
            self.check_accepted_config(&plan)?;
            if saved.state == Stage::Failed {
                return Err(Refusal(RUNNER_REJECTED).into());
            }
            ensure!(
                saved.state == Stage::Accepted,
                "Successor preparation failed or lost its durable request"
            );
            let prepared =
                restart::plan(store, id)?.context("Successor preparation plan was lost")?;
            ensure!(
                plan.matches_preparation(&prepared),
                "Successor preparation authority changed"
            );
            ensure!(runner.try_wait()?.is_none(), Refusal(RUNNER_REJECTED));
            if prepared.runner_ready == Some(true) {
                let session_file = super::rotation::session_file(config, store)?;
                restart::validate_identity(config, &saved, &prepared, &session_file)?;
                break;
            }
            ensure!(
                Instant::now() < deadline,
                "Successor preparation outcome is unresolved"
            );
            sleep(WAIT_SLICE).await;
        }
        self.shutdown_owned_head(Some((&plan, record))).await?;
        let state = self.state()?;
        if state.phase != Phase::Accepted || !self.is_accepted(id)? {
            return Ok(());
        }
        let mut saved = restart::record(store, Some(id))?.context("Restart acceptance was lost")?;
        saved.state = Stage::HeadStopped;
        restart::save(store, &saved)?;
        self.request_shutdown();
        Ok(())
    }

    pub(super) fn is_accepted(&self, id: &str) -> Result<bool> {
        let store = &self.0.store;
        Ok(store.get_meta(ACTIVE)?.as_deref() == Some(id)
            && restart::record(store, Some(id))?.is_some_and(|record| {
                record.state == Stage::Accepted && record.gateway_pid == process::id()
            }))
    }

    pub(super) fn check_accepted_config(&self, plan: &Plan) -> Result<()> {
        ensure!(
            self.0.config.matches_config_hash(&plan.config_hash),
            Refusal(CONFIG_CHANGED)
        );
        Ok(())
    }

    pub(super) fn check_runner_rejection(&self, record: &Record) -> Result<()> {
        ensure!(
            !restart::record(&self.0.store, Some(&record.request.request_id))?
                .is_some_and(|record| record.state == Stage::Failed),
            Refusal(RUNNER_REJECTED)
        );
        Ok(())
    }

    fn failed_restart(&self, original: &Record, error: &anyhow::Error) -> Result<()> {
        let mut state = self.state()?;
        if *self.0.closing.borrow() {
            return Ok(());
        }
        let store = &self.0.store;
        let Some(saved) = restart::record(store, Some(&original.request.request_id))? else {
            return Ok(());
        };
        if saved.state == Stage::Refused {
            return Ok(());
        }
        let refusal = error.downcast_ref::<Refusal>().map(|refusal| refusal.0);
        if refusal.is_some() || is_refusal(error) {
            self.outcome(
                saved,
                Stage::Refused,
                refusal.unwrap_or(
                    "Restart preparation or native shutdown was refused; no replacement Gateway was launched.",
                ),
            )?;
            store.set_meta(ACTIVE, "")?;
            if state.phase == Phase::Accepted {
                state.phase = Phase::Running;
            }
        } else {
            self.outcome(saved, Stage::Uncertain,
                "Restart shutdown or successor spawn outcome is uncertain; no automatic retry or forced kill is authorized.")?;
            if state.phase == Phase::Accepted {
                state.phase = Phase::Held;
            }
        }
        Ok(())
    }
}

#[derive(Debug)]
struct Refusal(&'static str);

impl std::fmt::Display for Refusal {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.0)
    }
}
impl std::error::Error for Refusal {}

fn wire_error(error: anyhow::Error) -> EffectError {
    if let Some(authority) = error.downcast_ref::<AuthorityError>() {
        EffectError::rejected(authority.0)
    } else {
        EffectError::uncertain("Gateway restart request failed")
    }
}
