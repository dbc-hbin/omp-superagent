//! Native Gateway lifecycle and exact-identity ownership of the main Host.
mod config;
mod fs;
mod handoff;
mod host_launch;
mod host_rpc;
mod maintenance;
mod process;
mod restart_record;
mod restart_service;
mod rotation;
mod rpc_wire;
mod stock_ops;
mod supervision;
mod ulw;

pub use config::LifecycleConfig;
pub use handoff::{launch, record_runner_failure, restart_runner};
pub use process::exec_detached;

use anyhow::{Context, Result, ensure};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::{
    process as os_process,
    sync::{Arc, Mutex, MutexGuard, OnceLock},
    time::Duration,
};
use tokio::sync::{Mutex as AsyncMutex, Notify, watch};
use tokio::time::Instant;

use crate::{adapter::EffectError, server::Service, store::Store};

use self::{
    fs::{Endpoint, alive, remove_dead_socket},
    host_rpc::Head,
    maintenance::Maintenance,
    restart_record::{ACTIVE, HEAD, SOCKET, Stage},
    ulw::Ulw,
};

#[derive(Clone)]
pub struct Lifecycle(Arc<Owner>);

struct Owner {
    config: LifecycleConfig,
    store: Arc<Store>,
    state: Mutex<State>,
    /// Serializes native reconciliation/launch against stop and replacement.
    supervision: AsyncMutex<()>,
    /// A distinct stop operation must wait for the preceding shutdown outcome.
    shutdown_head: AsyncMutex<()>,
    config_hash: OnceLock<String>,
    ulw: OnceLock<Ulw>,
    maintenance: Mutex<Maintenance>,
    closing: watch::Sender<bool>,
    notify: OnceLock<Arc<Notify>>,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum Phase {
    Running,
    Accepting,
    Accepted,
    Rotating,
    OperatorStopping,
    Held,
}

struct State {
    head: Option<Head>,
    launching_owner: Option<u32>,
    transport_ready: bool,
    phase: Phase,
    stop_generation: u64,
    shutdown_attempt: u64,
    shutdown_result: Option<supervision::ShutdownOutcome>,
    restarting: bool,
    head_error: Option<&'static str>,
    next_rotation_probe: Option<Instant>,
}

impl Lifecycle {
    pub async fn open(config: LifecycleConfig, request: Option<&str>) -> Result<Self> {
        let store = if let Some(id) = request {
            handoff::wait_launch_receipt(&config, id).await?
        } else {
            config.prepare_directories()?;
            Store::open(&config.state_dir)?
        };
        let head: Option<Head> = restart_record::meta(store.get_meta(HEAD)?)?;
        let state = State {
            head,
            launching_owner: None,
            transport_ready: false,
            phase: Phase::Running,
            stop_generation: 0,
            shutdown_attempt: 0,
            shutdown_result: None,
            restarting: false,
            head_error: None,
            next_rotation_probe: None,
        };
        Ok(Self(Arc::new(Owner {
            config,
            store: Arc::new(store),
            state: Mutex::new(state),
            supervision: AsyncMutex::new(()),
            shutdown_head: AsyncMutex::new(()),
            config_hash: OnceLock::new(),
            ulw: OnceLock::new(),
            maintenance: Mutex::default(),
            closing: watch::channel(false).0,
            notify: OnceLock::new(),
        })))
    }

    pub fn store(&self) -> Arc<Store> {
        Arc::clone(&self.0.store)
    }

    pub fn set_event_notifier(&self, notifier: Arc<Notify>) {
        self.0.notify.get_or_init(|| notifier);
    }

    fn state(&self) -> Result<MutexGuard<'_, State>> {
        self.0
            .state
            .lock()
            .map_err(|_| anyhow::anyhow!("Gateway lifecycle state is unavailable"))
    }

    pub fn set_transports_ready(&self, ready: bool) {
        match self.state() {
            Ok(mut state) => state.transport_ready = ready,
            Err(error) => eprintln!("{error}"),
        }
    }

    pub fn request_shutdown(&self) {
        self.0.closing.send_replace(true);
    }

    pub async fn shutdown_requested(&self) {
        let mut closing = self.0.closing.subscribe();
        let _received = closing.wait_for(|closing| *closing).await;
    }

    pub async fn prepare(&self, request: Option<&str>) -> Result<()> {
        let store = &self.0.store;
        let config = &self.0.config;
        let hash = config.config_hash()?;
        if let Some(id) = request {
            self.validate_replacement(id).await?;
        } else {
            ensure!(
                !restart_record::active_record(store)?
                    .is_some_and(|record| record.state.blocks_start()),
                "An owned restart handoff is pending; ordinary startup cannot adopt it"
            );
        }
        let ulw = Ulw::load(config)?;
        ulw.package()?;
        let status = ulw.status()?;
        ensure!(
            self.0.ulw.set(ulw).is_ok() && self.0.config_hash.set(hash).is_ok(),
            "Gateway lifecycle was already prepared"
        );
        self.0
            .maintenance
            .lock()
            .map_err(|_| anyhow::anyhow!("ULW status is unavailable"))?
            .status = Some(status);
        let old: Option<Endpoint> = restart_record::meta(store.get_meta(SOCKET)?)?;
        remove_dead_socket(&config.gateway_socket, old, None).await?;
        self.schedule_maintenance()?;
        Ok(())
    }

    pub async fn activate(&self, request: Option<&str>) -> Result<()> {
        if request.is_none() && self.rotation()?.is_some_and(|plan| matches!(plan.stage,
            rotation::Stage::Stopping | rotation::Stage::Starting | rotation::Stage::Launching))
        {
            // An interrupted rotation must not stop the independent
            // Gateway while exact native recovery is still being proved.
            if self.reconcile_head(false).await.is_err() {
                eprintln!("Gateway HEAD rotation requires reconciliation");
            }
            return Ok(());
        }
        self.ensure_head().await?;
        if let Some(id) = request {
            let store = &self.0.store;
            let state = self.state()?;
            let head = state
                .head
                .as_ref()
                .context("Replacement native HEAD is unavailable")?;
            let mut record =
                restart_record::record(store, Some(id))?.context("Missing replacement receipt")?;
            ensure!(
                record.state == Stage::HeadStopped
                    && record.successor_pid == Some(os_process::id())
                    && state.phase == Phase::Running
                    && head.pid != record.head_pid
                    && head.session_id == record.session_id
                    && config::same_path(&head.session_file, &record.session_file)
                    && store.get_meta(ACTIVE)?.as_deref() == Some(id),
                "Replacement native head identity did not match the restart request"
            );
            record.state = Stage::Started;
            record.replacement_pid = Some(head.pid);
            restart_record::save(store, &record)?;
            store.set_meta(ACTIVE, "")?;
        }
        Ok(())
    }

    pub async fn monitor(&self, controller_ready: bool) -> Result<()> {
        self.schedule_maintenance()?;
        self.reconcile_head(controller_ready).await
    }

    async fn reconcile_head(&self, controller_ready: bool) -> Result<()> {
        let result = async {
            self.monitor_rotation(controller_ready).await?;
            self.ensure_head().await
        }.await;
        if let Err(error) = result {
            self.state()?.head_error = Some("Head ownership/startup requires reconciliation");
            return Err(error);
        }
        Ok(())
    }

    fn status_value(
        &self,
        connected: bool,
        head_ready: bool,
        admission_ready: bool,
    ) -> Result<Value> {
        let state = self.state()?;
        let rotation = self.rotation()?;
        let closed = *self.0.closing.borrow();
        let live = match &state.head {
            Some(head) => alive(head.pid)?,
            None => false,
        };
        let mut native = json!({"pid": state.head.as_ref().map(|head| head.pid),
            "ready": false, "connected": live && connected, "socketPath": self.0.config.head_socket,
            "error": state.head_error});
        if let Some(head) = &state.head {
            let saved: Option<Value> =
                restart_record::meta(self.0.store.get_meta("head:preset-bootstrap")?)?;
            let initialization = saved.filter(|saved| saved["sessionId"].as_str() == Some(head.session_id.as_str()))
                .unwrap_or_else(|| json!({"sessionId": head.session_id, "state": "checking",
                    "detail": "Waiting for authoritative native HEAD attachment, approval reconciliation and preset inspection."}));
            native["loadedSuperkitPath"] = json!(head.loaded_superkit_path.as_ref().filter(|_| live && connected));
            native["ready"] = json!(live && head_ready && head.loaded_superkit_path.is_some() && initialization["state"] == "complete"
                && !rotation.as_ref().is_some_and(|plan| plan.stage == rotation::Stage::Stopping));
            native["initialization"] = initialization;
        }
        if let Some(rotation) = rotation {
            native["rotation"] = json!({
                "id": rotation.id, "stage": rotation.stage,
                "previousSessionId": rotation.original.session_id,
                "replacementSessionId": rotation.replacement_session_id,
            });
        }
        let mut status = json!({
            "gateway": {"pid": os_process::id(), "ready": state.transport_ready && !closed,
                "admissionReady": admission_ready, "stopping": state.phase != Phase::Running,
                "pendingEvents": if closed { 0 } else { self.0.store.pending()? }},
            "head": native,
        });
        drop(state);
        let maintenance = self
            .0
            .maintenance
            .lock()
            .map_err(|_| anyhow::anyhow!("ULW status is unavailable"))?;
        if let Some(ulw) = &maintenance.status {
            status["ulw"] = ulw.clone();
        }
        Ok(status)
    }
}

#[async_trait]
impl Service for Lifecycle {
    fn status(&self, connected: bool, head_ready: bool, admission_ready: bool) -> Result<Value> {
        self.status_value(connected, head_ready, admission_ready)
    }
    async fn authorize_head(&self, pid: u32) -> Result<()> {
        self.authorize(pid).await
    }
    async fn stop(&self) -> Result<()> {
        self.stop_head().await
    }
    fn finish_stop(&self) {
        // The operator client rechecks endpoint identity after reading the
        // receipt headers. Keep the committed, flushed socket briefly present.
        let service = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(25)).await;
            service.request_shutdown();
        });
    }
    async fn restart(&self, request: Value) -> std::result::Result<Value, EffectError> {
        self.accept_restart(request).await
    }
    fn run_restart(&self, request: &str) -> Result<()> {
        self.schedule_restart(request)
    }
}
