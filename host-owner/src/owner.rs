use std::{
    collections::HashMap,
    env,
    ffi::OsString,
    fs::Metadata,
    future::{pending, ready},
    os::unix::{
        fs::{MetadataExt, PermissionsExt},
        process::ExitStatusExt,
    },
    path::{Path, PathBuf},
    pin::pin,
    process::{ExitCode, ExitStatus, Stdio},
    sync::{Arc, Mutex, MutexGuard, OnceLock},
    time::Duration,
};

use anyhow::{Context as _, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::{
    fs,
    io::{AsyncRead, AsyncReadExt as _, AsyncWrite, AsyncWriteExt as _},
    net::{UnixListener, UnixStream},
    process::Command,
    sync::{OwnedSemaphorePermit, Semaphore, mpsc, watch},
    task::JoinHandle,
    time::timeout,
};

use crate::{
    commands,
    inventory::InventoryConfig,
    projection::EventFanout,
    transport::{Channel, Error, Link, Packet, Pump, REQUEST_TIMEOUT, Result, new_id},
    wire,
};

const OBSERVATION_BYTES: usize = wire::MAX_REASSEMBLED_BYTES * 2;
const OBSERVATION_FRAMES: usize = 1024;
const INVENTORY_QUERIES: usize = 64;
const INVENTORY_CONCURRENCY: usize = 8;
const PEER_LIMIT: usize = 64;
const OBSERVATION_ERROR: &str = "A durable native observation failed; residency remains held";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    options: Options,
    args: Vec<String>,
    config_path: PathBuf,
    native_socket: PathBuf,
    helper_path: PathBuf,
    tools_explicitly_selected: bool,
    no_tools: bool,
    inventory: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Options {
    command: Vec<String>,
    cwd: PathBuf,
    managed_ulw_path: PathBuf,
    session_file: String,
    socket_path: PathBuf,
    model_preset: Option<Preset>,
    model_settings: Option<Value>,
}

#[derive(Deserialize)]
struct Preset {
    name: String,
    preset: Value,
}

pub(crate) struct Owner {
    pub(crate) native: Channel,
    pub(crate) helper: Helper,
    control: OnceLock<Channel>,
    identity: OnceLock<Identity>,
    native_pid: u32,
    state: Mutex<State>,
    observations: mpsc::Sender<Observation>,
    observation_bytes: Arc<Semaphore>,
    observed: watch::Receiver<u64>,
    inventory_slots: Semaphore,
}

struct Identity {
    session_id: String,
    session_file: String,
    generation: Option<Value>,
    instance_key: Option<Value>,
    worker_attempt: Option<String>,
    journal_cursor: bool,
}

#[derive(Default)]
pub(crate) struct State {
    peers: HashMap<String, Channel>,
    pub(crate) ui: Vec<Arc<Value>>,
    pub(crate) requests: HashMap<String, String>,
    prompt_receipts: HashMap<String, u64>,
    pub(crate) goal_resumes: Vec<GoalResume>,
    pub(crate) generation: u64,
    pub(crate) active_commands: usize,
    stock_thinking_levels: bool,
    pub(crate) serial: Option<Barrier>,
    pub(crate) dispatch: Option<Barrier>,
    pub(crate) interrupts: Option<Barrier>,
    pub(crate) maintenance_active: bool,
    pub(crate) unresolved_effect: bool,
    child_exited: bool,
    pub(crate) observation_failed: bool,
    queued_observations: u64,
    run_ordinal: u64,
    expected_observations: HashMap<String, Arc<Value>>,
    inventory: HashMap<InventoryKey, Vec<String>>,
    inventory_waiters: usize,
}

impl State {
    pub(crate) const fn fenced(&self) -> bool {
        self.maintenance_active
            || self.unresolved_effect
            || self.child_exited
            || self.observation_failed
    }
}

#[derive(Clone)]
pub(crate) struct Barrier(pub(crate) watch::Receiver<()>);

impl Barrier {
    pub(crate) fn slot() -> (watch::Sender<()>, Self) {
        let (done, wait) = watch::channel(());
        (done, Self(wait))
    }

    pub(crate) async fn wait(mut self) {
        // The ticket's sender never writes; dropping it marks completion.
        while self.0.changed().await.is_ok() {}
    }
}

pub(crate) struct GoalResume {
    pub(crate) token: String,
    pub(crate) id: String,
    pub(crate) generation: u64,
}

struct Observation {
    packet: Packet,
    sequence: u64,
    run: u64,
    kind: ObservationKind,
    _bytes: OwnedSemaphorePermit,
}

struct ObservationSlot<'a> {
    frame: mpsc::Permit<'a, Observation>,
    bytes: OwnedSemaphorePermit,
}

enum ObservationKind {
    Event,
    PromptResult,
    NoAgentPrompt,
}

#[derive(Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
struct InventoryKey {
    #[serde(skip_serializing_if = "Option::is_none")]
    project_dir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    service_name: Option<String>,
}

pub(crate) struct Helper {
    bun: OsString,
    script: PathBuf,
    manifest: PathBuf,
    cwd: PathBuf,
    inventory: Option<InventoryConfig>,
}

#[derive(Clone, Copy)]
pub(crate) enum Operation {
    Inventory,
    Fit,
    Exit,
}

impl Helper {
    pub(crate) async fn call(&self, operation: Operation, input: &impl Serialize) -> Result<Value> {
        let (name, deadline, message) = match operation {
            Operation::Inventory => (
                "inventory",
                Duration::from_secs(8),
                "Native service ownership is unavailable",
            ),
            Operation::Fit => (
                "fit",
                REQUEST_TIMEOUT,
                "Native restored queue response is unavailable",
            ),
            Operation::Exit => (
                "exit",
                Duration::from_secs(60),
                "Native exit persistence is unconfirmed; adapter remains fenced",
            ),
        };
        let unavailable = Error::Unavailable(message);
        let bytes = serde_json::to_vec(input).map_err(|_| unavailable)?;
        let invoke = async {
            let mut child = Command::new(&self.bun)
                .arg("--no-env-file")
                .arg(&self.script)
                .arg(name)
                .arg(&self.manifest)
                // The checkout can be removed while a Host is alive. Exit
                // verification reads only its independent, absolute state paths.
                .current_dir(if matches!(operation, Operation::Exit) {
                    self.manifest.parent().ok_or(unavailable)?
                } else {
                    &self.cwd
                })
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .kill_on_drop(true)
                .spawn()
                .map_err(|_| unavailable)?;
            let mut stdin = child.stdin.take().ok_or(unavailable)?;
            let stdout = child.stdout.take().ok_or(unavailable)?;
            let limit = u64::try_from(wire::MAX_REASSEMBLED_BYTES.saturating_add(1))
                .map_err(|_| unavailable)?;
            let mut stdout = stdout.take(limit);
            let mut output = Vec::new();
            let write = async move {
                stdin.write_all(&bytes).await?;
                stdin.shutdown().await
            };
            tokio::try_join!(write, stdout.read_to_end(&mut output)).map_err(|_| unavailable)?;
            if output.len() > wire::MAX_REASSEMBLED_BYTES
                || !child.wait().await.map_err(|_| unavailable)?.success()
            {
                return Err(unavailable);
            }
            serde_json::from_slice(&output).map_err(|_| unavailable)
        };
        timeout(deadline, invoke).await.map_err(|_| unavailable)?
    }
}

impl Owner {
    pub(crate) fn state(&self) -> Result<MutexGuard<'_, State>> {
        self.state
            .lock()
            .map_err(|_| Error::Unavailable("Host residency state is unavailable"))
    }

    pub(crate) fn control(&self) -> Result<&Channel> {
        self.control.get().ok_or(Error::Unavailable(
            "Native lifecycle control is unavailable",
        ))
    }

    pub(crate) fn is_worker(&self) -> bool {
        self.identity
            .get()
            .is_some_and(|identity| identity.worker_attempt.is_some())
    }

    pub(crate) fn observations_known(&self, state: &State) -> bool {
        !state.child_exited && !state.observation_failed
    }

    fn observation_failure(&self) {
        if let Ok(mut state) = self.state() {
            state.observation_failed = true;
        }
    }

    fn observation_enqueue_failure(&self) {
        if let Ok(mut state) = self.state() {
            state.observation_failed = true;
            for peer in state.peers.values() {
                peer.close();
            }
        }
    }

    async fn reserve_observation(&self, packet: &Packet) -> Result<Option<ObservationSlot<'_>>> {
        if self.state()?.observation_failed {
            return Ok(None);
        }
        let unavailable = Error::Unavailable(OBSERVATION_ERROR);
        if packet.bytes() > OBSERVATION_BYTES {
            return Err(unavailable);
        }
        let bytes = u32::try_from(packet.bytes()).map_err(|_| unavailable)?;
        // Only the stdout reader reserves these slots. Leave the lifecycle
        // control reader free to deliver the ACKs that let the worker drain.
        let frame = self.observations.reserve().await.map_err(|_| unavailable)?;
        let bytes = Arc::clone(&self.observation_bytes)
            .acquire_many_owned(bytes)
            .await
            .map_err(|_| unavailable)?;
        Ok(Some(ObservationSlot { frame, bytes }))
    }

    fn enqueue(
        state: &mut State,
        slot: Option<ObservationSlot<'_>>,
        packet: Packet,
        kind: ObservationKind,
    ) -> Result<Option<u64>> {
        let Some(slot) = slot else { return Ok(None) };
        if state.observation_failed {
            return Ok(None);
        }
        let sequence = state
            .queued_observations
            .checked_add(1)
            .ok_or(Error::Unavailable(OBSERVATION_ERROR))?;
        slot.frame.send(Observation {
            packet,
            sequence,
            run: state.run_ordinal,
            kind,
            _bytes: slot.bytes,
        });
        state.queued_observations = sequence;
        Ok(Some(sequence))
    }

    pub(crate) async fn observations_flushed(&self) -> Result<()> {
        let sequence = self.state()?.queued_observations;
        self.wait_observation(sequence).await
    }

    async fn wait_observation(&self, sequence: u64) -> Result<()> {
        let mut observed = self.observed.clone();
        observed
            .wait_for(|completed| *completed >= sequence)
            .await
            .map_err(|_| Error::Unavailable(OBSERVATION_ERROR))?;
        if self.state()?.observation_failed {
            Err(Error::Unavailable(OBSERVATION_ERROR))
        } else {
            Ok(())
        }
    }

    pub(crate) async fn prompt_acknowledged(&self, id: &str) -> Result<()> {
        let (sequence, failed) = {
            let mut state = self.state()?;
            (state.prompt_receipts.remove(id), state.observation_failed)
        };
        if let Some(sequence) = sequence {
            self.wait_observation(sequence).await
        } else if failed {
            Err(Error::Unavailable(OBSERVATION_ERROR))
        } else {
            Ok(())
        }
    }

    async fn record(&self, event: &Observation) -> Result<()> {
        let control = self.control()?;
        let data = data(
            control
                .request(json!({
                    "type": "observe",
                    "customType": "rpc_prompt_result",
                    "frame": event.packet.frame.as_ref(),
                    "runOrdinal": event.run,
                    "hostPid": self.native_pid,
                }))
                .await?,
        )?;
        let id = data["entryId"]
            .as_str()
            .ok_or(Error::Unavailable(OBSERVATION_ERROR))?;
        self.state()?
            .expected_observations
            .insert(id.to_owned(), Arc::clone(&event.packet.frame));
        Ok(())
    }

    async fn observe(&self, mut queue: mpsc::Receiver<Observation>, observed: watch::Sender<u64>) {
        while let Some(event) = queue.recv().await {
            if !self.state().map_or(true, |state| state.observation_failed) {
                let publish = match event.kind {
                    ObservationKind::Event => true,
                    ObservationKind::PromptResult | ObservationKind::NoAgentPrompt => {
                        if self.record(&event).await.is_err() {
                            self.observation_failure();
                            false
                        } else {
                            matches!(event.kind, ObservationKind::PromptResult)
                        }
                    }
                };
                if publish
                    && let Ok(state) = self.state()
                    && !state.observation_failed
                {
                    let fanout = EventFanout::new(&event.packet);
                    for peer in state.peers.values() {
                        if fanout.send(peer).is_err() {
                            peer.close();
                        }
                    }
                }
            }
            observed.send_replace(event.sequence);
        }
    }

    async fn native_response(&self, frame: &Value) -> Result<()> {
        let Some(id) = frame["id"].as_str() else {
            return Ok(());
        };
        let prompt = matches!(
            frame["command"].as_str(),
            Some("prompt" | "abort_and_prompt")
        );
        if !prompt {
            self.state()?.requests.remove(id);
        } else if frame["success"] == true && frame["data"]["agentInvoked"] == false {
            let original = self.state()?.requests.get(id).cloned();
            let Some(original) = original else {
                return Ok(());
            };
            let packet = Packet::new(json!({
                "type": "prompt_result",
                "id": original,
                "agentInvoked": false,
                "status": "completed",
            }))?;
            let slot = self.reserve_observation(&packet).await?;
            let mut state = self.state()?;
            state.requests.remove(id);
            if let Some(sequence) =
                Self::enqueue(&mut state, slot, packet, ObservationKind::NoAgentPrompt)?
            {
                state.prompt_receipts.insert(id.to_owned(), sequence);
            }
        }
        Ok(())
    }

    async fn native_event(&self, mut frame: Value) -> Result<()> {
        if frame["type"] == "extension_ui_request" && frame["method"] == "form" {
            // Managed Hosts have no safe HTML renderer. Answer stock RPC
            // before translating IDs or queuing anything for a socket peer.
            if let Some(id) = frame["id"].as_str() {
                self.native.send(json!({
                    "type": "extension_ui_response", "id": id, "cancelled": true,
                }))?;
            }
            return Ok(());
        }
        if frame["type"] == "extension_error"
            && frame["extensionPath"]
                .as_str()
                .is_some_and(|path| path.ends_with("/host-extension.ts"))
        {
            self.state()?.observation_failed = true;
        }
        let terminal_prompt = frame["type"] == "prompt_result";
        let mut terminal_id = None;
        // The single stdout reader owns terminal retirement. Resolve the
        // public ID before measuring bytes; retire it only with the enqueue.
        if let Some(id) = frame["id"].as_str()
            && let Some(original) = self.state()?.requests.get(id).cloned()
        {
            if terminal_prompt {
                terminal_id = Some(id.to_owned());
            }
            frame["id"] = Value::String(original);
        }
        let packet = Packet::new(frame)?;
        let slot = self.reserve_observation(&packet).await?;
        let frame = packet.frame.as_ref();
        let mut state = self.state()?;
        if frame["type"] == "agent_start" {
            state.run_ordinal = state
                .run_ordinal
                .checked_add(1)
                .ok_or(Error::Unavailable(OBSERVATION_ERROR))?;
        }
        if let Some(id) = terminal_id {
            state.requests.remove(&id);
        }
        if frame["type"] == "extension_ui_request" && frame["id"].is_string() {
            match frame["method"].as_str() {
                Some("cancel") => {
                    state
                        .ui
                        .retain(|request| request["id"] != frame["targetId"]);
                }
                Some("select" | "confirm" | "input" | "editor" | "ask") => {
                    if let Some(request) = state
                        .ui
                        .iter_mut()
                        .find(|request| request["id"] == frame["id"])
                    {
                        *request = Arc::clone(&packet.frame);
                    } else {
                        state.ui.push(Arc::clone(&packet.frame));
                    }
                }
                _ => {}
            }
        }
        let kind = if terminal_prompt {
            ObservationKind::PromptResult
        } else {
            ObservationKind::Event
        };
        Self::enqueue(&mut state, slot, packet, kind)?;
        Ok(())
    }

    fn start_native<R, W>(self: &Arc<Self>, pump: Pump, stdout: R, stdin: W) -> JoinHandle<bool>
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let events = Arc::clone(self);
        let responses = Arc::clone(self);
        self.native.start(
            pump,
            stdout,
            stdin,
            move |frame, _| {
                let owner = Arc::clone(&events);
                async move {
                    if owner.native_event(frame).await.is_err() {
                        owner.observation_enqueue_failure();
                    }
                }
            },
            move |frame| {
                let owner = Arc::clone(&responses);
                async move {
                    if owner.native_response(&frame).await.is_err() {
                        owner.observation_enqueue_failure();
                    }
                    frame
                }
            },
        )
    }

    fn validate_control_identity(&self, owned: &Value) -> Result<&Identity> {
        let identity = self
            .identity
            .get()
            .ok_or(Error::Unavailable("Native launch identity mismatch"))?;
        if owned["sessionId"].as_str() != Some(identity.session_id.as_str())
            || owned["sessionFile"].as_str() != Some(identity.session_file.as_str())
            || owned["hostPid"].as_u64() != Some(u64::from(self.native_pid))
            || owned.get("generation") != identity.generation.as_ref()
            || owned.get("instanceKey") != identity.instance_key.as_ref()
            || owned["workerAttempt"].as_str() != identity.worker_attempt.as_deref()
        {
            return Err(Error::Unavailable("Native identity/generation changed"));
        }
        Ok(identity)
    }

    pub(crate) async fn journal_cursor(&self) -> Result<Option<String>> {
        if !self
            .identity
            .get()
            .is_some_and(|identity| identity.journal_cursor)
        {
            return Err(Error::Unavailable("Native journal cursor is unavailable"));
        }
        self.observations_flushed().await?;
        let mut owned = data(
            self.control()?
                .request(json!({"type": "get_journal_cursor"}))
                .await?,
        )?;
        self.validate_control_identity(&owned)?;
        match owned.get_mut("leafId").map(Value::take) {
            Some(Value::Null) => Ok(None),
            Some(Value::String(leaf)) if !leaf.is_empty() => Ok(Some(leaf)),
            _ => Err(Error::Unavailable("Native journal cursor is unavailable")),
        }
    }

    pub(crate) async fn snapshot(&self) -> Result<Value> {
        self.observations_flushed().await?;
        let control = self.control()?;
        let (active, stock_thinking_levels) = {
            let state = self.state()?;
            (state.active_commands != 0, state.stock_thinking_levels)
        };
        let rpc = if active { control } else { &self.native };
        // The busy bridge should advertise only selectors that this CLI puts
        // into ordinary get_state. Older stock Hosts still use separate discovery.
        let request = if active && stock_thinking_levels {
            json!({"type": "get_state", "thinkingLevels": true})
        } else {
            json!({"type": "get_state"})
        };
        let native = data(rpc.request(request).await?)?;
        let owned = data(control.request(json!({"type": "snapshot"})).await?)?;
        let identity = self.validate_control_identity(&owned)?;
        if owned.get("sessionId") != native.get("sessionId")
            || owned.get("sessionFile") != native.get("sessionFile")
        {
            return Err(Error::Unavailable("Native identity/generation changed"));
        }
        if !owned["hasOwnedRunningWork"].is_boolean() || owned["observationHeld"] == true {
            return Err(Error::Unavailable(
                "Native owned work or durable observations cannot be authoritatively established; residency remains held",
            ));
        }
        let Value::Object(mut native) = native else {
            return Err(Error::Unavailable("Native state is unavailable"));
        };
        let Value::Object(mut owned) = owned else {
            return Err(Error::Unavailable("Native state is unavailable"));
        };
        if native.contains_key("thinkingLevels") {
            // Keep the configured selector paired with the native model and
            // effective level, not a later observation from the ownership probe.
            owned.remove("configuredThinkingLevel");
            native.entry("configuredThinkingLevel").or_insert(Value::Null);
        }
        native.extend(owned);
        // Only publish the capability attested by this owner's private launch control.
        native.remove("journalCursorControlVersion");
        native.remove("journalCursorVersion");
        if identity.worker_attempt.is_none() {
            native.remove("workerAttempt");
        }
        native.insert("adapterOwnerPid".to_owned(), json!(std::process::id()));
        native.insert("adapterProtocol".to_owned(), json!("owned-stock-stdio-v1"));
        if identity.journal_cursor {
            native.insert("journalCursorVersion".to_owned(), json!(1));
        }
        let pending_ui = self
            .state()?
            .ui
            .iter()
            .map(|request| request.as_ref().clone())
            .collect();
        native.insert("pendingUiRequests".to_owned(), Value::Array(pending_ui));
        Ok(Value::Object(native))
    }

    fn inventory_request(self: &Arc<Self>, frame: Value, control: &Channel) -> Result<()> {
        let (Some("list_service_units"), Some(id)) = (frame["type"].as_str(), frame["id"].as_str())
        else {
            return Ok(());
        };
        let key = InventoryKey {
            project_dir: frame["projectDir"].as_str().map(str::to_owned),
            service_name: frame["serviceName"].as_str().map(str::to_owned),
        };
        {
            let mut state = self.state()?;
            if state.inventory_waiters >= INVENTORY_QUERIES {
                return control.send(inventory_response(id, None));
            }
            state.inventory_waiters += 1;
            if let Some(waiters) = state.inventory.get_mut(&key) {
                waiters.push(id.to_owned());
                return Ok(());
            }
            state.inventory.insert(key.clone(), vec![id.to_owned()]);
        }
        let owner = Arc::clone(self);
        let control = control.clone();
        tokio::spawn(async move {
            let result = async {
                let _slot = owner
                    .inventory_slots
                    .acquire()
                    .await
                    .map_err(|_| Error::Disconnected)?;
                if let Some(inventory) = &owner.helper.inventory
                    && let Some(units) = inventory
                        .probe(key.project_dir.as_deref(), key.service_name.as_deref())
                        .await
                {
                    return Ok(units);
                }
                owner.helper.call(Operation::Inventory, &key).await
            };
            let inventory = tokio::select! {
                () = control.closed() => None,
                result = timeout(REQUEST_TIMEOUT, result) => match result {
                    Ok(Ok(value)) if value["units"].is_array() => Some(value),
                    _ => None,
                }
            };
            let waiters = owner.state().map(|mut state| {
                let waiters = state.inventory.remove(&key).unwrap_or_default();
                state.inventory_waiters = state.inventory_waiters.saturating_sub(waiters.len());
                waiters
            });
            match waiters {
                Ok(waiters) => {
                    for id in waiters {
                        if control
                            .send(inventory_response(&id, inventory.as_ref()))
                            .is_err()
                        {
                            control.close();
                            break;
                        }
                    }
                }
                Err(_) => control.close(),
            }
        });
        Ok(())
    }

    fn connect(self: &Arc<Self>, stream: UnixStream) -> Result<()> {
        let (peer, pump) = Channel::new(Link::Peer);
        let peer_id = new_id();
        {
            let mut state = self.state()?;
            if state.peers.len() >= PEER_LIMIT {
                return Err(Error::Disconnected);
            }
            state.peers.insert(peer_id.clone(), peer.clone());
        }
        let (input, output) = stream.into_split();
        let owner = Arc::clone(self);
        let reader = peer.start(
            pump,
            input,
            output,
            move |frame, peer| {
                if commands::admit(&owner, frame, peer).is_err() {
                    peer.close();
                }
                ready(())
            },
            ready,
        );
        if peer.send(json!({
            "type": "ready", "protocolVersion": 1, "supportedProtocolVersions": [1, 2],
            "maxFrameBytes": wire::MAX_FRAME_BYTES, "maxReassembledFrameBytes": wire::MAX_REASSEMBLED_BYTES,
        })).is_err() {
            peer.close();
        }
        let owner = Arc::clone(self);
        tokio::spawn(async move {
            if reader.await.is_err() {
                peer.close();
            }
            if let Ok(mut state) = owner.state() {
                state.peers.remove(&peer_id);
            }
        });
        Ok(())
    }
}

fn inventory_response(id: &str, data: Option<&Value>) -> Value {
    if let Some(data) = data {
        json!({"type": "response", "command": "list_service_units", "id": id, "success": true, "data": data})
    } else {
        json!({"type": "response", "command": "list_service_units", "id": id, "success": false,
            "error": "Native service ownership is unavailable"})
    }
}

pub(crate) fn require_success(frame: &Value) -> Result<()> {
    if frame["success"] == true {
        Ok(())
    } else {
        Err(Error::Unavailable("Native request failed"))
    }
}

pub(crate) fn data(mut frame: Value) -> Result<Value> {
    require_success(&frame)?;
    Ok(frame
        .as_object_mut()
        .and_then(|frame| frame.remove("data"))
        .unwrap_or(Value::Null))
}

pub(crate) async fn run(path: PathBuf) -> anyhow::Result<ExitCode> {
    let content = fs::read(&path)
        .await
        .context("Could not read owner manifest")?;
    let mut manifest: Manifest =
        serde_json::from_slice(&content).context("Invalid owner manifest")?;
    let inventory = manifest
        .inventory
        .take()
        .and_then(|value| serde_json::from_value(value).ok());
    let options = &manifest.options;
    ensure!(
        options.cwd.is_absolute()
            && options.managed_ulw_path.is_absolute()
            && Path::new(&options.session_file).is_absolute()
            && options.socket_path.is_absolute()
            && manifest.config_path.is_absolute()
            && manifest.native_socket.is_absolute()
            && manifest.helper_path.is_absolute(),
        "Owner manifest paths must be absolute"
    );
    // For an enrolled worker the stock CLI receives --cwd explicitly. Start
    // its runtime in private state so eager loader inputs aren't taken from
    // the checkout before OMP can apply the worker launch policy.
    let bootstrap_cwd = if env::var_os("OMP_SUPERAGENT_WORKER_ATTEMPT").is_some() {
        manifest
            .config_path
            .parent()
            .context("Missing worker launch directory")?
    } else {
        &options.cwd
    };
    let helper = Helper {
        bun: env::var_os("OMP_SUPERAGENT_BUN")
            .filter(|value| !value.is_empty())
            .context("Bun helper executable is unavailable")?,
        script: manifest.helper_path.clone(),
        manifest: path,
        cwd: bootstrap_cwd.to_path_buf(),
        inventory,
    };
    let (program, prefix) = options
        .command
        .split_first()
        .context("Missing native OMP executable")?;
    let mut child = Command::new(program)
        .args(prefix)
        .args(&manifest.args)
        .current_dir(bootstrap_cwd)
        .env("OMP_SUPERAGENT_HOST_SOCKET", &options.socket_path)
        .env("OMP_SUPERAGENT_NATIVE_SOCKET", &manifest.native_socket)
        .env("OMP_SUPERAGENT_HOST_CONFIG", &manifest.config_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .context("Could not start native OMP")?;
    let native_pid = child
        .id()
        .context("Native process identity is unavailable")?;
    let stdout = child
        .stdout
        .take()
        .context("Native stdout is unavailable")?;
    let stdin = child.stdin.take().context("Native stdin is unavailable")?;
    let (native, pump) = Channel::new(Link::Stdio);
    let (observations, observation_queue) = mpsc::channel(OBSERVATION_FRAMES);
    let (observation_progress, observed) = watch::channel(0);
    let owner = Arc::new(Owner {
        native,
        helper,
        native_pid,
        observations,
        observed,
        state: Mutex::default(),
        control: OnceLock::new(),
        identity: OnceLock::new(),
        observation_bytes: Arc::new(Semaphore::new(OBSERVATION_BYTES)),
        inventory_slots: Semaphore::new(INVENTORY_CONCURRENCY),
    });
    let drain = owner.start_native(pump, stdout, stdin);
    let worker = Arc::clone(&owner);
    tokio::spawn(async move {
        worker
            .observe(observation_queue, observation_progress)
            .await
    });

    initialize(&owner, &manifest).await?;
    let (listener, _socket) = BoundSocket::listen(&options.socket_path).await?;
    let mut connections = pin!(accept(&owner, &listener));
    let mut activation = pin!(activate(&owner, &manifest));
    let mut activating = true;
    let status = loop {
        tokio::select! {
            biased;
            result = child.wait() => break result.context("Could not establish native process exit")?,
            result = &mut activation, if activating => {
                if let Err(error) = result {
                    if let Some(status) = child.try_wait().context("Could not establish native process exit")? {
                        break status;
                    }
                    return Err(error);
                }
                activating = false;
            }
            result = &mut connections => return result,
        }
    };
    owner.state()?.child_exited = true;
    tokio::select! {
        result = &mut connections => result,
        result = exit(&owner, status, drain) => result,
    }
}

async fn activate(owner: &Owner, manifest: &Manifest) -> anyhow::Result<()> {
    let activated = owner
        .control()?
        .request(json!({
            "type": "activate", "toolsExplicitlySelected": manifest.tools_explicitly_selected,
            "noTools": manifest.no_tools,
        }))
        .await
        .context("Native lifecycle activation failed")?;
    require_success(&activated).context("Native lifecycle activation failed")
}

async fn initialize(owner: &Arc<Owner>, manifest: &Manifest) -> anyhow::Result<()> {
    owner
        .native
        .ready()
        .await
        .context("Native RPC did not become ready")?;
    let negotiation = owner
        .native
        .request(json!({"type": "negotiate_protocol", "protocolVersion": 2}))
        .await
        .context("Native RPC protocol negotiation failed")?;
    ensure!(
        negotiation["success"] == true
            && negotiation["command"] == "negotiate_protocol"
            && negotiation["data"]["protocolVersion"].as_u64() == Some(2),
        "Native RPC protocol negotiation failed"
    );
    // Stock commands follow session_start, which opens the lifecycle socket.
    // Keep the native event stream in its full, unfiltered default.
    let state = owner
        .native
        .request(json!({"type": "get_state"}))
        .await
        .context("Native RPC state is unavailable")?;
    require_success(&state).context("Native RPC state is unavailable")?;
    owner.state()?.stock_thinking_levels = state["data"].get("thinkingLevels").is_some();
    let ask = owner
        .native
        .request(json!({"type": "set_ask_dialog", "enabled": true}))
        .await
        .context("Native RPC ask dialogs are unavailable")?;
    require_success(&ask).context("Native RPC ask dialogs are unavailable")?;
    let stream = UnixStream::connect(&manifest.native_socket)
        .await
        .context("Native lifecycle connection failed")?;
    let (input, output) = stream.into_split();
    let (control, pump) = Channel::new(Link::Control);
    let for_control = Arc::clone(owner);
    owner
        .control
        .set(control.clone())
        .map_err(|_| anyhow::anyhow!("Duplicate native lifecycle channel"))?;
    let _control_reader = control.start(
        pump,
        input,
        output,
        move |frame, control| {
            if for_control.inventory_request(frame, control).is_err() {
                control.close();
            }
            ready(())
        },
        ready,
    );
    control
        .ready()
        .await
        .context("Native lifecycle channel did not become ready")?;
    let identity = data(
        control
            .request(json!({"type": "snapshot"}))
            .await
            .context("Native launch identity is unavailable")?,
    )
    .context("Native launch identity or managed omp-superkit load verification failed")?;
    ensure!(
        identity["hostPid"].as_u64() == Some(u64::from(owner.native_pid))
            && identity["sessionFile"].as_str() == Some(&manifest.options.session_file),
        "Native launch identity mismatch"
    );
    ensure!(
        identity["loadedSuperkitPath"].as_str().map(Path::new)
            == Some(manifest.options.managed_ulw_path.as_path()),
        "Native session did not confirm loading the selected omp-superkit package"
    );
    let worker_attempt = env::var("OMP_SUPERAGENT_WORKER_ATTEMPT").ok();
    if worker_attempt.is_some() {
        ensure!(
            identity["workerCwd"].as_str().map(Path::new) == Some(manifest.options.cwd.as_path()),
            "Worker native session did not enter its reserved checkout"
        );
    }
    ensure!(
        identity["workerAttempt"].as_str() == worker_attempt.as_deref(),
        "Native worker launch attempt identity mismatch"
    );
    owner
        .identity
        .set(Identity {
            session_id: identity["sessionId"]
                .as_str()
                .context("Native session identity is unavailable")?
                .to_owned(),
            session_file: manifest.options.session_file.clone(),
            instance_key: identity.get("instanceKey").cloned(),
            generation: identity.get("generation").cloned(),
            worker_attempt,
            journal_cursor: identity["journalCursorControlVersion"].as_u64() == Some(1),
        })
        .map_err(|_| anyhow::anyhow!("Duplicate native launch identity"))?;
    let explicit = manifest.options.model_preset.as_ref();
    let preset = explicit
        .map(|value| &value.preset)
        .or(manifest.options.model_settings.as_ref());
    if let Some(preset) = preset {
        let mut preset = preset
            .as_object()
            .cloned()
            .context("Invalid initial model preset")?;
        if preset
            .get("defaultThinkingLevel")
            .is_none_or(Value::is_null)
        {
            if let Some(level) = identity["modelSettings"].get("defaultThinkingLevel") {
                preset.insert("defaultThinkingLevel".to_owned(), level.clone());
            } else {
                preset.remove("defaultThinkingLevel");
            }
        }
        let mut command = json!({
            "type": "set_model_preset",
            "preset": preset,
            "preserveActiveModel": explicit.is_none(),
        });
        if let Some(explicit) = explicit {
            command["name"] = json!(explicit.name);
        }
        let response = control
            .request(command)
            .await
            .context("Native initial model preset failed")?;
        require_success(&response).context("Native initial model preset failed")?;
    }
    Ok(())
}

async fn accept(owner: &Arc<Owner>, listener: &UnixListener) -> anyhow::Result<ExitCode> {
    loop {
        let (stream, _) = listener
            .accept()
            .await
            .context("Could not accept Host connection")?;
        // A saturated or closed owner drops the stream without tracking it.
        let _rejected_peer = owner.connect(stream).err();
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExitObservation<'a> {
    pid: u32,
    owner_pid: u32,
    session_id: &'a str,
    instance_key: Option<&'a Value>,
    worker_attempt: Option<&'a str>,
    code: Option<i32>,
    signal: Option<&'static str>,
    expected_observations: Vec<(&'a str, &'a Value)>,
    run_ordinal: u64,
    observation_failure: bool,
}

async fn exit(
    owner: &Owner,
    status: ExitStatus,
    drain: JoinHandle<bool>,
) -> anyhow::Result<ExitCode> {
    // Process exit may arrive ahead of pipe EOF. Consume all remaining frames
    // before sampling the journal expectations.
    if !matches!(timeout(REQUEST_TIMEOUT, drain).await, Ok(Ok(true))) {
        owner.native.close();
        owner.observation_failure();
    }
    if owner.observations_flushed().await.is_err() {
        owner.observation_failure();
    }
    let (observations, run_ordinal, observation_failure) = {
        let mut state = owner.state()?;
        (
            std::mem::take(&mut state.expected_observations),
            state.run_ordinal,
            state.observation_failed,
        )
    };
    let identity = owner
        .identity
        .get()
        .context("Native exit identity is unavailable")?;
    let receipt = owner
        .helper
        .call(
            Operation::Exit,
            &ExitObservation {
                pid: owner.native_pid,
                owner_pid: std::process::id(),
                session_id: &identity.session_id,
                instance_key: identity.instance_key.as_ref(),
                worker_attempt: identity.worker_attempt.as_deref(),
                code: status.code(),
                signal: signal(status),
                expected_observations: observations
                    .iter()
                    .map(|(id, frame)| (id.as_str(), frame.as_ref()))
                    .collect(),
                run_ordinal,
                observation_failure,
            },
        )
        .await;
    if !matches!(receipt, Ok(value) if value["persisted"] == true && value["observationsFlushed"] == true)
    {
        eprintln!("Native exit persistence is unconfirmed; adapter remains fenced");
        return pending().await;
    }
    for peer in owner.state()?.peers.values() {
        peer.close();
    }
    owner.control()?.close();
    Ok(if status.success() {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    })
}

fn signal(status: ExitStatus) -> Option<&'static str> {
    let signal = status.signal()?;
    Some(match signal {
        1 => "SIGHUP",
        2 => "SIGINT",
        3 => "SIGQUIT",
        4 => "SIGILL",
        5 => "SIGTRAP",
        6 => "SIGABRT",
        8 => "SIGFPE",
        9 => "SIGKILL",
        11 => "SIGSEGV",
        13 => "SIGPIPE",
        14 => "SIGALRM",
        15 => "SIGTERM",
        other => platform_signal(other),
    })
}

#[cfg(target_os = "macos")]
const fn platform_signal(signal: i32) -> &'static str {
    match signal {
        7 => "SIGEMT",
        10 => "SIGBUS",
        12 => "SIGSYS",
        16 => "SIGURG",
        17 => "SIGSTOP",
        18 => "SIGTSTP",
        19 => "SIGCONT",
        20 => "SIGCHLD",
        21 => "SIGTTIN",
        22 => "SIGTTOU",
        23 => "SIGIO",
        24 => "SIGXCPU",
        25 => "SIGXFSZ",
        26 => "SIGVTALRM",
        27 => "SIGPROF",
        28 => "SIGWINCH",
        29 => "SIGINFO",
        30 => "SIGUSR1",
        31 => "SIGUSR2",
        _ => "SIGUNKNOWN",
    }
}

#[cfg(not(target_os = "macos"))]
const fn platform_signal(signal: i32) -> &'static str {
    match signal {
        7 => "SIGBUS",
        10 => "SIGUSR1",
        12 => "SIGUSR2",
        16 => "SIGSTKFLT",
        17 => "SIGCHLD",
        18 => "SIGCONT",
        19 => "SIGSTOP",
        20 => "SIGTSTP",
        21 => "SIGTTIN",
        22 => "SIGTTOU",
        23 => "SIGURG",
        24 => "SIGXCPU",
        25 => "SIGXFSZ",
        26 => "SIGVTALRM",
        27 => "SIGPROF",
        28 => "SIGWINCH",
        29 => "SIGIO",
        30 => "SIGPWR",
        31 => "SIGSYS",
        _ => "SIGUNKNOWN",
    }
}

struct BoundSocket<'a> {
    path: &'a Path,
    identity: Metadata,
}

impl<'a> BoundSocket<'a> {
    async fn listen(path: &'a Path) -> anyhow::Result<(UnixListener, Self)> {
        let listener = UnixListener::bind(path).context("Could not bind Host socket")?;
        let identity = fs::symlink_metadata(path)
            .await
            .context("Host socket identity is unavailable")?;
        let bound = Self { path, identity };
        fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .await
            .context("Could not restrict Host socket permissions")?;
        Ok((listener, bound))
    }
}

impl Drop for BoundSocket<'_> {
    fn drop(&mut self) {
        let current = std::fs::symlink_metadata(self.path);
        if current.is_ok_and(|stat| {
            stat.dev() == self.identity.dev() && stat.ino() == self.identity.ino()
        }) && std::fs::remove_file(self.path).is_err()
        {
            eprintln!("Host socket cleanup failed");
        }
    }
}

#[cfg(test)]
mod observation_flow;
#[cfg(test)]
mod ordering;
