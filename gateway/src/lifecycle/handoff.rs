use anyhow::{Context, Result, bail, ensure};
use rusqlite::{Connection, ErrorCode, OpenFlags, OptionalExtension, TransactionBehavior, params};
use serde_json::Value;
use std::{os::unix::fs::MetadataExt, path::Path, time::Duration};
use tokio::{
    process::{Child, Command},
    time::{Instant, sleep},
};

use crate::store::Store;

use super::{
    LifecycleConfig,
    fs::{EXIT_TIMEOUT, Endpoint, WAIT_SLICE, alive, log, metadata, socket_stat},
    process::{ChildKind, detached},
    restart_record::{self as restart, ACTIVE, HEAD, Plan, Record, SOCKET, Stage, plan_key},
};

const RUNNER_TIMEOUT: Duration = Duration::from_secs(90);
const GATEWAY_TIMEOUT: Duration = Duration::from_secs(45);
const STATUS_POLL: Duration = Duration::from_millis(50);
const FAILURE: &str = "One-shot restart handoff failed or timed out; no retry or forced kill was attempted. Inspect the exact durable request before recovery.";

fn database(dir: &Path, writable: bool) -> Result<Connection> {
    let flags = if writable {
        OpenFlags::SQLITE_OPEN_READ_WRITE
    } else {
        OpenFlags::SQLITE_OPEN_READ_ONLY
    };
    let db = Connection::open_with_flags(dir.join("coordination.sqlite"), flags)?;
    db.busy_timeout(Duration::from_secs(5))?;
    Ok(db)
}

fn get_meta(db: &Connection, key: &str) -> Result<Option<String>> {
    Ok(db
        .query_row("SELECT value FROM metadata WHERE key=?1", [key], |row| {
            row.get(0)
        })
        .optional()?)
}

fn read_pair(db: &Connection, id: &str) -> Result<(Record, Plan)> {
    let record: Record = restart::meta(get_meta(db, &format!("gateway:restart:{id}"))?)?
        .context("Missing durable restart record")?;
    let plan =
        restart::meta(get_meta(db, &plan_key(id))?)?.context("Missing durable restart plan")?;
    ensure!(
        record.request.request_id == id,
        "Restart metadata has conflicting request identity"
    );
    Ok((record, plan))
}

fn lock_busy(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        matches!(
            cause.downcast_ref::<rusqlite::Error>(),
            Some(rusqlite::Error::SqliteFailure(error, _)) if error.code == ErrorCode::DatabaseBusy
        )
    })
}

pub(super) async fn wait_launch_receipt(config: &LifecycleConfig, id: &str) -> Result<Store> {
    let deadline = Instant::now() + EXIT_TIMEOUT;
    let db = database(&config.state_dir, false)?;
    let pid = std::process::id();
    loop {
        let (record, plan) = read_pair(&db, id)?;
        ensure!(
            record.state == Stage::HeadStopped
                && get_meta(&db, ACTIVE)?.as_deref() == Some(id)
                && plan.launch_pid.is_none_or(|owner| owner == pid)
                && record.successor_pid.is_none_or(|owner| owner == pid),
            "Replacement launch receipt was cancelled or belongs to another process"
        );
        if plan.launch_pid == Some(pid) && record.successor_pid == Some(pid) {
            match Store::open(&config.state_dir) {
                Ok(store) => return Ok(store),
                Err(error) if lock_busy(&error) => {}
                Err(error) => return Err(error),
            }
        }
        ensure!(
            Instant::now() < deadline,
            "Exact restart launch receipt/lifetime lock was not released"
        );
        sleep(WAIT_SLICE).await;
    }
}

pub fn record_runner_failure(dir: &Path, id: &str) -> Result<()> {
    let mut db = database(dir, true)?;
    let transaction = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let key = format!("gateway:restart:{id}");
    let Some(mut record) = restart::meta::<Record>(get_meta(&transaction, &key)?)? else {
        return Ok(());
    };
    let plan = restart::meta::<Plan>(get_meta(&transaction, &plan_key(id))?)?;
    if record.request.request_id != id
        || !record.state.pending()
        || plan.and_then(|plan| plan.runner_pid) != Some(std::process::id())
    {
        return Ok(());
    }
    record.state = Stage::Failed;
    record.reason = Some(FAILURE.into());
    let encoded = serde_json::to_string(&record)?;
    transaction.execute(
        "UPDATE metadata SET value=?1 WHERE key=?2",
        params![&encoded, key],
    )?;
    if restart::meta::<Record>(get_meta(&transaction, "gateway:restart")?)?
        .is_some_and(|latest| latest.request.request_id == id)
    {
        transaction.execute(
            "UPDATE metadata SET value=?1 WHERE key='gateway:restart'",
            [&encoded],
        )?;
    }
    transaction.commit()?;
    Ok(())
}

fn mark_ready(db: &mut Connection, id: &str) -> Result<()> {
    let transaction = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let (record, mut plan) = read_pair(&transaction, id)?;
    ensure!(
        record.state.pending()
            && get_meta(&transaction, ACTIVE)?.as_deref() == Some(id)
            && plan.runner_pid == Some(std::process::id()),
        "Successor preparation lost request ownership"
    );
    plan.runner_ready = Some(true);
    transaction.execute(
        "UPDATE metadata SET value=?1 WHERE key=?2",
        params![serde_json::to_string(&plan)?, plan_key(id)],
    )?;
    transaction.commit()?;
    Ok(())
}

pub async fn restart_runner(config: &LifecycleConfig, id: &str) -> Result<()> {
    config.require_credentials()?;
    let mut db = database(&config.state_dir, true)?;
    let deadline = Instant::now() + RUNNER_TIMEOUT;
    let store = loop {
        let (record, plan) = read_pair(&db, id)?;
        if !record.state.pending() {
            return Ok(());
        }
        let session_file = super::rotation::session_file_from_meta(
            config, get_meta(&db, crate::store::HEAD_SESSION_FILE)?,
        )?;
        restart::validate_identity(config, &record, &plan, &session_file)?;
        ensure!(
            get_meta(&db, ACTIVE)?.as_deref() == Some(id),
            "Restart is not the active owned intent"
        );
        ensure!(
            plan.runner_pid
                .is_none_or(|owner| owner == std::process::id()),
            "Restart runner identity changed"
        );
        if plan.runner_pid == Some(std::process::id()) && plan.runner_ready != Some(true) {
            restart::validate_plan(config, &record, &plan, &session_file).await?;
            let socket = socket_stat(&config.gateway_socket, false)?;
            ensure!(
                plan.socket.matches(&socket),
                "Predecessor Gateway endpoint changed before successor preparation"
            );
            mark_ready(&mut db, id)?;
        }
        if record.state == Stage::HeadStopped {
            ensure!(
                !alive(record.head_pid)?,
                "Predecessor HEAD shutdown is not confirmed"
            );
            if plan.runner_pid == Some(std::process::id())
                && plan.runner_ready == Some(true)
                && !alive(record.gateway_pid)?
                && !alive(plan.head.owner_pid)?
            {
                match Store::open(&config.state_dir) {
                    Ok(store) => break store,
                    Err(error) if lock_busy(&error) => {}
                    Err(error) => return Err(error),
                }
            }
        }
        ensure!(
            Instant::now() < deadline,
            "Predecessor did not exit and release its lifetime lock"
        );
        sleep(WAIT_SLICE).await;
    };
    let record = restart::record(&store, Some(id))?.context("Missing durable restart record")?;
    let plan = restart::plan(&store, id)?.context("Missing durable restart plan")?;
    let session_file = super::rotation::session_file(config, &store)?;
    restart::validate_plan(config, &record, &plan, &session_file).await?;
    if record.state != Stage::HeadStopped
        || plan.runner_pid != Some(std::process::id())
        || store.get_meta(ACTIVE)?.as_deref() != Some(id)
        || plan.launch_pid.is_some()
        || alive(record.gateway_pid)?
        || alive(record.head_pid)?
        || alive(plan.head.owner_pid)?
    {
        return Ok(());
    }
    let socket: Option<Endpoint> = restart::meta(store.get_meta(SOCKET)?)?;
    ensure!(
        socket == Some(plan.socket) && store.get_meta(HEAD)?.as_deref() == Some("null"),
        "Predecessor endpoint ownership changed"
    );
    // Hold the same lifetime lock through launch and exact PID receipt, so an
    // ordinary start can never claim the gap or substitute another endpoint.
    let mut child = spawn_successor(config, &store, record, plan).await?;
    drop(store);
    let status = wait_start(config, &mut child, Some(id)).await?;
    let (result, _) = read_pair(&db, id)?;
    ensure!(
        result.state == Stage::Started
            && result.successor_pid == Some(child.id().context("Gateway PID lost")?)
            && result.replacement_pid.map(u64::from) == status["head"]["pid"].as_u64()
            && result.successor_pid != Some(result.gateway_pid)
            && result.replacement_pid != Some(result.head_pid),
        "Replacement ownership/readiness was not confirmed"
    );
    Ok(())
}

async fn spawn_successor(
    config: &LifecycleConfig,
    store: &Store,
    mut record: Record,
    mut plan: Plan,
) -> Result<Child> {
    ensure!(
        status_or_recorded_stale(config).await?.is_none(),
        "Restart cannot adopt an existing Gateway endpoint"
    );
    let child = spawn_gateway(config, Some(&record.request.request_id))?;
    let pid = child.id().context("Restart successor PID is unavailable")?;
    plan.launch_pid = Some(pid);
    store.set_meta(
        &plan_key(&record.request.request_id),
        &serde_json::to_string(&plan)?,
    )?;
    record.successor_pid = Some(pid);
    restart::save(store, &record)?;
    Ok(child)
}

pub async fn launch(config: &LifecycleConfig) -> Result<Value> {
    if let Some(status) = status_or_recorded_stale(config).await? {
        return Ok(status);
    }
    config.require_credentials()?;
    config.prepare_directories()?;
    let mut child = spawn_gateway(config, None)?;
    wait_start(config, &mut child, None).await
}

fn spawn_gateway(config: &LifecycleConfig, request: Option<&str>) -> Result<Child> {
    let mut command = detached(ChildKind::Gateway, &log(&config.gateway_log)?)?;
    command
        .arg("--config")
        .arg(&config.path)
        .current_dir(&config.cwd);
    if let Some(id) = request {
        command.arg("--restart-request").arg(id);
    }
    Ok(Command::from(command).spawn()?)
}

pub(super) fn spawn_runner(config: &LifecycleConfig, request: &str) -> Result<Child> {
    let mut command = detached(ChildKind::RestartRunner, &log(&config.gateway_log)?)?;
    command
        .arg("--config")
        .arg(&config.path)
        .arg("--restart-request")
        .arg(request)
        .arg("--state-dir")
        .arg(&config.state_dir)
        .current_dir(&config.cwd);
    Ok(Command::from(command).spawn()?)
}

async fn status_or_recorded_stale(config: &LifecycleConfig) -> Result<Option<Value>> {
    match gateway_status(config).await {
        Ok(value) => Ok(value),
        Err(error) => {
            let db = database(&config.state_dir, false)?;
            let previous: Option<Endpoint> = restart::meta(get_meta(&db, SOCKET)?)?;
            let stat = metadata(&config.gateway_socket)?;
            if let (Some(previous), Some(stat)) = (previous, stat)
                && !alive(previous.pid)?
                && previous.matches(&stat)
            {
                return Ok(None);
            }
            Err(error)
        }
    }
}

async fn gateway_status(config: &LifecycleConfig) -> Result<Option<Value>> {
    if metadata(&config.gateway_socket)?.is_none() {
        return Ok(None);
    }
    let before = socket_stat(&config.gateway_socket, false)?;
    let client = reqwest::Client::builder()
        .unix_socket(config.gateway_socket.clone())
        .timeout(Duration::from_secs(2))
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
    let payload: Value = client
        .get("http://localhost/status")
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let after = socket_stat(&config.gateway_socket, false)?;
    ensure!(
        (before.dev(), before.ino()) == (after.dev(), after.ino()),
        "Gateway socket changed during request"
    );
    ensure!(
        payload["ok"] == true && payload["value"].is_object(),
        "Gateway rejected status"
    );
    Ok(payload.get("value").cloned())
}

async fn wait_start(
    config: &LifecycleConfig,
    child: &mut Child,
    restart_id: Option<&str>,
) -> Result<Value> {
    let deadline = Instant::now() + GATEWAY_TIMEOUT;
    let pid = child.id().context("New Gateway PID is unavailable")?;
    while Instant::now() < deadline {
        ensure!(
            child.try_wait()?.is_none(),
            "Gateway exited during startup; inspect private service log"
        );
        if let Ok(Some(status)) = gateway_status(config).await
            && status["gateway"]["pid"].as_u64() == Some(u64::from(pid))
            && status["gateway"]["ready"] == true
            && status["head"]["pid"].as_u64().is_some_and(|pid| pid > 0)
            && restart_id.is_none_or(|id| {
                status["restart"]["requestId"].as_str() == Some(id)
                    && status["restart"]["state"] == "started"
            })
        {
            return Ok(status);
        }
        sleep(STATUS_POLL).await;
    }
    // A live service might already own HEAD; a lost readiness receipt never kills it.
    bail!("Gateway startup outcome unresolved; inspect status and private log before retrying")
}
