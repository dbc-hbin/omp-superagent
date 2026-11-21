use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

use crate::store::Store;

use super::{
    LifecycleConfig, config::same_path, fs::Endpoint, host_rpc::Head, stock_ops::session_id,
};

pub(super) const ACTIVE: &str = "gateway:restart-active";
pub(super) const HEAD: &str = "gateway:head";
pub(super) const SOCKET: &str = "gateway:socket";
pub(super) const STOP: &str = "gateway:operator-stop";
pub(super) const FENCE: &str = "head:restart-fence";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(super) enum Stage {
    Accepted,
    HeadStopped,
    Started,
    Refused,
    Uncertain,
    Failed,
}

impl Stage {
    pub fn pending(self) -> bool {
        matches!(self, Self::Accepted | Self::HeadStopped)
    }

    pub fn blocks_start(self) -> bool {
        self.pending() || self == Self::Uncertain
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Request {
    pub request_id: String,
    pub input_id: String,
    pub ack_output_id: String,
}

impl Request {
    pub fn same(&self, other: &Self) -> bool {
        self.request_id == other.request_id
            && self.input_id == other.input_id
            && self.ack_output_id == other.ack_output_id
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Record {
    #[serde(flatten)]
    pub request: Request,
    pub gateway_pid: u32,
    pub head_pid: u32,
    pub session_id: String,
    pub session_file: PathBuf,
    pub state: Stage,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub successor_pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replacement_pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl Record {
    pub fn accept(request: Request, head: &Head) -> Self {
        Self {
            request,
            gateway_pid: std::process::id(),
            head_pid: head.pid,
            session_id: head.session_id.clone(),
            session_file: head.session_file.clone(),
            state: Stage::Accepted,
            successor_pid: None,
            replacement_pid: None,
            reason: None,
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Plan {
    pub config_path: PathBuf,
    pub state_dir: PathBuf,
    pub config_hash: String,
    pub normalized_config_hash: String,
    pub socket: Endpoint,
    pub head: Head,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runner_pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runner_ready: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub launch_pid: Option<u32>,
}

pub(super) fn plan_key(id: &str) -> String {
    format!("gateway:restart-plan:{id}")
}

impl Plan {
    pub fn matches_preparation(&self, prepared: &Self) -> bool {
        self.runner_pid == prepared.runner_pid
            && self.head.same(&prepared.head)
            && self.socket == prepared.socket
            && self.config_path == prepared.config_path
            && self.state_dir == prepared.state_dir
            && self.config_hash == prepared.config_hash
            && self.normalized_config_hash == prepared.normalized_config_hash
    }
}

pub(super) fn meta<T: serde::de::DeserializeOwned>(value: Option<String>) -> Result<Option<T>> {
    match value {
        Some(value) => Ok(serde_json::from_str::<Option<T>>(&value)?),
        None => Ok(None),
    }
}

pub(super) fn plan(store: &Store, id: &str) -> Result<Option<Plan>> {
    meta(store.get_meta(&plan_key(id))?)
}

pub(super) fn record(store: &Store, id: Option<&str>) -> Result<Option<Record>> {
    store
        .get_restart(id)?
        .map(serde_json::from_value)
        .transpose()
        .context("Invalid durable restart record")
}

pub(super) fn active_record(store: &Store) -> Result<Option<Record>> {
    let id = store.get_meta(ACTIVE)?;
    record(store, id.as_deref().filter(|id| !id.is_empty()))
}

pub(super) async fn validate_plan(
    config: &LifecycleConfig,
    record: &Record,
    plan: &Plan,
    session_file: &Path,
) -> Result<()> {
    validate_identity(config, record, plan, session_file)?;
    validate_config(config, plan)?;
    ensure!(
        session_id(config, &record.session_file).await?.as_deref()
            == Some(record.session_id.as_str()),
        "Restart session identity changed; no replacement is authorized"
    );
    validate_config(config, plan)
}

pub(super) fn validate_identity(
    config: &LifecycleConfig,
    record: &Record,
    plan: &Plan,
    session_file: &Path,
) -> Result<()> {
    ensure!(
        same_path(&plan.config_path, &config.path)
            && same_path(&plan.state_dir, &config.state_dir)
            && record.gateway_pid == plan.socket.pid
            && record.head_pid == plan.head.pid
            && plan.head.owner_pid > 0
            && plan.head.pid > 0
            && plan.socket.pid > 0
            && record.session_id == plan.head.session_id
            && !record.session_id.is_empty()
            && same_path(&record.session_file, &plan.head.session_file)
            && same_path(&record.session_file, session_file),
        "Restart durable ownership does not match the original configuration and session"
    );
    Ok(())
}

pub(super) fn validate_config(config: &LifecycleConfig, plan: &Plan) -> Result<()> {
    ensure!(
        config.source_hash == plan.config_hash
            && config.normalized_hash == plan.normalized_config_hash
            && config.matches_config_hash(&plan.config_hash),
        "Restart configuration changed; no replacement is authorized"
    );
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Fence {
    #[serde(flatten)]
    pub request: Request,
    pub owner_pid: u32,
    pub session_id: String,
    pub session_file: PathBuf,
    pub stop_boundary: Option<String>,
}

impl Fence {
    pub fn matches(&self, request: &Request, head: &Head) -> bool {
        self.request.same(request)
            && self.owner_pid == head.pid
            && self.session_id == head.session_id
            && same_path(&self.session_file, &head.session_file)
    }
}

pub(super) fn save(store: &Store, record: &Record) -> Result<Value> {
    let value = serde_json::to_value(record)?;
    store.set_restart(&value)?;
    Ok(value)
}
