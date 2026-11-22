use std::sync::Arc;

use serde::{Deserialize as _, Serialize};
use serde_json::{Value, json};
use tokio::sync::{OwnedSemaphorePermit, watch};

use crate::{
    owner::{Barrier, GoalResume, Operation, Owner, data},
    projection::MessageUpdates,
    transport::{Channel, Error, LONG_TIMEOUT, Result, new_id},
    worker_rpc,
};

struct Command {
    frame: Value,
    id: String,
    name: String,
}

impl Command {
    fn read_only(&self) -> bool {
        self.name.starts_with("get_")
    }

    fn interrupt(&self) -> bool {
        matches!(
            self.name.as_str(),
            "abort" | "abort_and_restore_queue" | "abort_and_prompt"
        )
    }

    fn input(&self) -> bool {
        matches!(
            self.name.as_str(),
            "prompt"
                | "steer"
                | "follow_up"
                | "abort_and_prompt"
                | "steer_subagent"
                | "dictation_start"
        )
    }

    fn background(&self) -> bool {
        matches!(self.name.as_str(), "bash" | "predict_word")
    }

    fn priority_query(&self) -> bool {
        matches!(self.name.as_str(), "get_state" | "get_session_stats" | "get_head_rotation")
    }

    fn goal_stop(&self) -> bool {
        self.name == "goal" && matches!(self.frame["op"].as_str(), Some("pause" | "drop"))
    }

    fn stop(&self) -> bool {
        matches!(self.name.as_str(), "abort" | "abort_and_restore_queue") || self.goal_stop()
    }

    fn goal_resume(&self) -> bool {
        self.name == "goal" && self.frame["op"] == "resume"
    }

    fn respond(&self, peer: &Channel, response: Value) -> Result<()> {
        if peer.is_closed() {
            return Ok(());
        }
        let Value::Object(mut response) = response else {
            return Err(Error::Unavailable("Native response is unavailable"));
        };
        response.insert("type".to_owned(), json!("response"));
        response.insert("command".to_owned(), json!(self.name));
        response.insert("id".to_owned(), json!(self.id));
        peer.send(Value::Object(response))
    }

    fn worker_refusal(&self, peer: &Channel) -> Result<()> {
        self.respond(
            peer,
            json!({
                "success": false, "code": "worker_rpc_forbidden",
                "error": "Command or arguments are not allowed on a remote worker Host",
            }),
        )
    }
}

pub(crate) fn admit(owner: &Arc<Owner>, frame: Value, peer: &Channel) -> Result<()> {
    let name = frame["type"]
        .as_str()
        .ok_or(Error::Unavailable("Invalid Host command"))?
        .to_owned();
    let id = frame["id"].as_str().map_or_else(new_id, str::to_owned);
    let mut command = Command { frame, id, name };
    let worker = owner.is_worker();
    if worker && !worker_rpc::allows(&command.name, &command.frame) {
        return command.worker_refusal(peer);
    }
    let mut state = owner.state()?;
    match command.name.as_str() {
        "extension_ui_response" => {
            if let Some(index) = state
                .ui
                .iter()
                .position(|frame| frame["id"].as_str() == Some(&command.id))
            {
                if worker && !worker_rpc::allows_answer(&command.frame, &state.ui[index]) {
                    return command.worker_refusal(peer);
                }
                owner.native.send(command.frame)?;
                state.ui.remove(index);
            }
            return Ok(());
        }
        "negotiate_protocol" => {
            if command.frame["protocolVersion"].as_u64() != Some(2) {
                return command.respond(
                    peer,
                    json!({"success": false, "error": "Unsupported adapter protocol"}),
                );
            }
            peer.set_v2()?;
            return command.respond(
                peer,
                json!({"success": true, "data": {"protocolVersion": 2}}),
            );
        }
        "set_host_message_updates" => {
            let Ok(mode) = MessageUpdates::deserialize(&command.frame["messageUpdates"]) else {
                return command.respond(
                    peer,
                    json!({"success": false, "error": "Unsupported owned Host message update mode"}),
                );
            };
            // The state lock also guards fanout: the new projection cannot
            // enter this peer's write queue ahead of its acknowledgement.
            command.respond(
                peer,
                json!({"success": true, "data": {"messageUpdates": mode}}),
            )?;
            return peer.set_message_updates(mode);
        }
        "get_host_admission" => {
            let pending: Vec<_> = state
                .goal_resumes
                .iter()
                .map(|resume| {
                    json!({
                        "id": resume.id,
                        "generation": resume.generation,
                        "current": resume.generation == state.generation,
                    })
                })
                .collect();
            let mut data = json!({
                "fenced": state.fenced(), "generation": state.generation, "pendingGoalResumes": pending,
            });
            if command.frame["messageUpdateCapability"] == true {
                data["messageUpdates"] = json!(MessageUpdates::Activity);
            }
            return command.respond(peer, json!({"success": true, "data": data}));
        }
        _ => {}
    }
    if state.fenced()
        && !matches!(command.name.as_str(), "get_state" | "shutdown_host")
        && !command.stop()
    {
        return command.respond(
            peer,
            json!({"success": false, "error": "Host admission is fenced"}),
        );
    }
    // An explicit stock set_event_filter falls through to normal native
    // dispatch, keeping the installed CLI's global behavior.
    let capacity = peer.admit_command()?;
    if command.interrupt() || command.goal_stop() {
        state.generation = state.generation.checked_add(1).ok_or(Error::Unavailable(
            "Host admission generation is unavailable",
        ))?;
    }
    if matches!(command.name.as_str(), "shutdown_host" | "set_model_preset") {
        if state.maintenance_active || state.active_commands != 0 || !state.requests.is_empty() {
            return command.respond(peer, busy("Host is busy (session_busy)"));
        }
        state.maintenance_active = true;
        drop(state);
        let owner = Arc::clone(owner);
        let peer = peer.clone();
        tokio::spawn(async move {
            let _capacity = capacity;
            let result = maintenance(&owner, &mut command, &peer).await;
            if let Ok(mut state) = owner.state() {
                state.maintenance_active = false;
                if result.is_err() {
                    state.unresolved_effect = true;
                }
            }
            if result.is_err() {
                peer.close();
            }
        });
        return Ok(());
    }

    let generation = state.generation;
    let read_only = command.read_only();
    if !read_only {
        state.active_commands = state
            .active_commands
            .checked_add(1)
            .ok_or(Error::Unavailable("Host command count is unavailable"))?;
    }
    let resume_token = command.goal_resume().then(new_id);
    if let Some(token) = &resume_token {
        state.goal_resumes.push(GoalResume {
            token: token.clone(),
            id: command.id.clone(),
            generation,
        });
    }
    let predecessor = state.serial.clone();
    let previous_interrupt = state.interrupts.clone();
    let (previous_dispatch, dispatch_done) =
        if !command.interrupt() && !command.background() && !command.priority_query() {
            let (done, next) = Barrier::slot();
            (state.dispatch.replace(next), Some(done))
        } else {
            (None, None)
        };
    let serial_done = if command.interrupt()
        || (!command.input() && !command.background() && !command.priority_query())
    {
        let (done, next) = Barrier::slot();
        state.serial = Some(next);
        if command.interrupt() {
            // An interrupt can run beside the serial tail, but its place in
            // that tail cannot release later input before both have settled.
            let (interrupt_serial_done, interrupt_serial) = Barrier::slot();
            let earlier = predecessor.clone();
            tokio::spawn(async move {
                let _done = done;
                wait(earlier).await;
                interrupt_serial.wait().await;
            });
            Some(interrupt_serial_done)
        } else {
            Some(done)
        }
    } else {
        None
    };
    let interrupt_done = if command.interrupt() {
        let (done, next) = Barrier::slot();
        state.interrupts = Some(next);
        Some(done)
    } else {
        None
    };
    drop(state);
    let admitted = Admitted {
        owner: Arc::clone(owner),
        read_only,
        resume_token,
        _capacity: capacity,
        _serial_done: serial_done,
        _interrupt_done: interrupt_done,
    };
    let order = Dispatch {
        generation,
        predecessor,
        previous_interrupt,
        dispatch_done,
    };
    let peer = peer.clone();
    tokio::spawn(async move {
        wait(previous_dispatch).await;
        let result = execute(&admitted, &mut command, &peer, order).await;
        let response = match result {
            Ok(value) => value,
            Err(error) if error.ambiguous() && !read_only => {
                hold(&admitted.owner, &peer);
                return;
            }
            Err(error) => json!({"success": false, "error": error.to_string()}),
        };
        if command.respond(&peer, response).is_err() {
            peer.close();
        }
    });
    Ok(())
}

struct Admitted {
    owner: Arc<Owner>,
    read_only: bool,
    resume_token: Option<String>,
    _capacity: OwnedSemaphorePermit,
    _serial_done: Option<watch::Sender<()>>,
    _interrupt_done: Option<watch::Sender<()>>,
}

struct Dispatch {
    generation: u64,
    predecessor: Option<Barrier>,
    previous_interrupt: Option<Barrier>,
    dispatch_done: Option<watch::Sender<()>>,
}

impl Drop for Admitted {
    fn drop(&mut self) {
        if let Ok(mut state) = self.owner.state() {
            if let Some(token) = &self.resume_token {
                state.goal_resumes.retain(|resume| resume.token != *token);
            }
            if !self.read_only {
                state.active_commands = state.active_commands.saturating_sub(1);
            }
        }
    }
}

async fn wait(barrier: Option<Barrier>) {
    if let Some(barrier) = barrier {
        barrier.wait().await;
    }
}

fn busy(error: &str) -> Value {
    json!({"success": false, "code": "session_busy", "error": error})
}

async fn idle(owner: &Owner) -> Result<()> {
    {
        let state = owner.state()?;
        if state.active_commands != 0 || !state.requests.is_empty() {
            return Err(Error::Unavailable("Host is busy (session_busy)"));
        }
    }
    let value = owner.snapshot().await?;
    let state = owner.state()?;
    if state.active_commands == 0
        && state.requests.is_empty()
        && state.ui.is_empty()
        && owner.observations_known(&state)
        && value["isSettled"] == true
        && value["isStreaming"] == false
        && value["isCompacting"] == false
        && value["hasPendingAsyncWork"] == false
        && value["queuedMessageCount"].as_u64() == Some(0)
        && value["hasOwnedRunningWork"] == false
        && value["admitted"] == false
        && value["postPromptWork"] == false
        && value["mutationHeld"] == false
        && (value["goal"]["enabled"].is_null() || value["goal"]["enabled"] == false)
    {
        Ok(())
    } else {
        Err(Error::Unavailable("Host is busy (session_busy)"))
    }
}

async fn maintenance(owner: &Owner, command: &mut Command, peer: &Channel) -> Result<()> {
    let confirmed = async {
        idle(owner).await?;
        idle(owner).await
    }
    .await;
    if let Err(error) = confirmed {
        if command.respond(peer, busy(&error.to_string())).is_err() {
            peer.close();
        }
        return Ok(());
    }
    let control = owner.control()?;
    let mut response = control.request(std::mem::take(&mut command.frame)).await?;
    let success = response["success"].as_bool().ok_or(Error::Disconnected)?;
    if !success {
        let snapshot = data(control.request(json!({"type": "snapshot"})).await?)?;
        if snapshot["mutationHeld"] == true {
            owner.state()?.unresolved_effect = true;
        }
        sanitize_private_error(&mut response);
    }
    if command.respond(peer, response).is_err() {
        peer.close();
    }
    if success && command.name == "shutdown_host" {
        // This remains fenced even while a native shutdown ACK is awaiting
        // process exit; only the exit receipt can release the owner.
        owner.state()?.unresolved_effect = true;
        owner.native.end_input().await?;
    }
    Ok(())
}

fn hold(owner: &Owner, peer: &Channel) {
    if let Ok(mut state) = owner.state() {
        state.unresolved_effect = true;
    }
    peer.close();
}

fn sanitize_private_error(response: &mut Value) {
    if response["success"] == false {
        let message = match response["error"].as_str() {
            Some("session_busy") => "session_busy",
            Some("Host is busy") => "Host is busy",
            _ => "Native request failed",
        };
        response["error"] = json!(message);
    }
}

async fn execute(
    admitted: &Admitted,
    command: &mut Command,
    peer: &Channel,
    order: Dispatch,
) -> Result<Value> {
    let owner = &admitted.owner;
    if command.interrupt() {
        wait(order.previous_interrupt).await;
    } else if !command.background() && !command.priority_query() {
        wait(order.predecessor).await;
    }
    if (command.input() || admitted.resume_token.is_some()) && !command.interrupt() {
        let state = owner.state()?;
        if state.generation != order.generation || state.fenced() {
            let error = if admitted.resume_token.is_some() {
                "Goal resume cancelled before admission"
            } else {
                "Input cancelled before native admission"
            };
            return Err(Error::Unavailable(error));
        }
    }
    match command.name.as_str() {
        "get_state" => {
            let mut response = json!({"success": true});
            response["data"] = owner.snapshot().await?;
            return Ok(response);
        }
        "get_session_stats" | "get_head_rotation" => {
            let mut response = owner
                .control()?
                .request(std::mem::take(&mut command.frame))
                .await?;
            sanitize_private_error(&mut response);
            return Ok(response);
        }
        "get_journal_cursor" => {
            return Ok(json!({"success": true, "data": {"leafId": owner.journal_cursor().await?}}));
        }
        "get_entries" => owner
            .observations_flushed()
            .await
            .map_err(|_| Error::Unavailable("Durable native observations are unavailable"))?,
        _ => {}
    }
    let id = new_id();
    let restore_queue = command.name == "abort_and_restore_queue";
    if restore_queue {
        // Resolve the trusted SDK formatter before interrupt_maintenance
        // withdraws any queued input. The real payload is not known yet.
        let empty = json!({"steering": [], "followUp": []});
        fit(owner, peer, &command.id, &empty, &empty).await?;
    }
    let restored = if command.interrupt() {
        let control = owner.control()?;
        let restored = data(
            control
                .request_with(
                    json!({
                        "type": "interrupt_maintenance", "restoreQueue": restore_queue,
                    }),
                    &id,
                    Some(crate::transport::REQUEST_TIMEOUT),
                )
                .await?,
        )
        .map_err(|_| Error::Disconnected)?;
        {
            let mut state = owner.state()?;
            for request in &state.ui {
                owner.native.send(json!({
                    "type": "extension_ui_response", "id": request["id"], "cancelled": true,
                }))?;
            }
            state.ui.clear();
        }
        // Native abort calls share a barrier. Wait for the priority abort
        // to finish before the stock RPC is allowed to lower that barrier.
        data(
            control
                .request_with(
                    json!({
                        "type": "finish_interrupt", "token": id,
                    }),
                    &new_id(),
                    Some(LONG_TIMEOUT),
                )
                .await?,
        )
        .map_err(|_| Error::Disconnected)?;
        Some(restored)
    } else {
        None
    };
    if !admitted.read_only {
        owner
            .state()?
            .requests
            .insert(id.clone(), command.id.clone());
    }
    let wait = (command.name != "compact").then_some(LONG_TIMEOUT);
    let request = owner
        .native
        .begin_request(std::mem::take(&mut command.frame), &id)?;
    // FIFO admission for input sharing a serial predecessor, without waiting
    // for the native response (which would serialize streaming input).
    drop(order.dispatch_done);
    let mut response = request.response(wait).await?;
    if restore_queue && response["success"] == true {
        let fitted = if let Some(restored) = &restored {
            fit(owner, peer, &command.id, restored, &response["data"]).await
        } else {
            Err(Error::Disconnected)
        };
        // A failed fit is not proof that the native interrupt did not
        // remove input. Do not return a partial queue or invite a replay.
        response = fitted.map_err(|_| Error::Disconnected)?;
    }
    if matches!(command.name.as_str(), "prompt" | "abort_and_prompt") {
        if response["success"] != true {
            // Only this continuation receives the first response. A later
            // same-ID error still owes a prompt_result under the caller's ID.
            owner.state()?.requests.remove(&id);
        } else if response["data"]["agentInvoked"] == false {
            // Native already accepted the command. A lost durable observation
            // is not a rejection and must not invite a replay.
            owner
                .prompt_acknowledged(&id)
                .await
                .map_err(|_| Error::Disconnected)?;
        }
    }
    Ok(response)
}

async fn fit(
    owner: &Owner,
    peer: &Channel,
    id: &str,
    restored: &Value,
    remaining: &Value,
) -> Result<Value> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct FitInput<'a> {
        id: &'a str,
        restored: &'a Value,
        remaining: &'a Value,
        max_response_bytes: usize,
    }
    let input = FitInput {
        id,
        restored,
        remaining,
        max_response_bytes: peer.max_response_bytes()?,
    };
    let response = owner.helper.call(Operation::Fit, &input).await?;
    if response["success"] != true {
        return Err(Error::Unavailable(
            "Native restored queue response is unavailable",
        ));
    }
    Ok(response)
}
