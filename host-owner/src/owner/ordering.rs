use std::future::ready;

use super::*;
use tokio::io::{BufReader, ReadHalf, WriteHalf, split};

pub(super) struct Wire {
    input: BufReader<ReadHalf<UnixStream>>,
    output: WriteHalf<UnixStream>,
    decoder: wire::Decoder,
}

impl Wire {
    pub(super) fn new(stream: UnixStream) -> Self {
        let (input, output) = split(stream);
        Self {
            input: BufReader::new(input),
            output,
            decoder: wire::Decoder::default(),
        }
    }

    async fn read(&mut self) -> Option<Value> {
        timeout(
            Duration::from_secs(5),
            wire::read_frame(&mut self.input, &mut self.decoder),
        )
        .await
        .expect("timed out reading an RPC frame or EOF")
        .expect("invalid RPC frame")
    }

    pub(super) async fn frame(&mut self) -> Value {
        self.read().await.expect("unexpected RPC disconnect")
    }

    pub(super) async fn send(&mut self, frame: Value) {
        wire::write_frame(&mut self.output, &frame, 1)
            .await
            .unwrap();
    }

    pub(super) async fn reply(&mut self, command: &Value, response: Value) {
        let mut response = response;
        response["type"] = json!("response");
        response["command"] = command["type"].clone();
        response["id"] = command["id"].clone();
        self.send(response).await;
    }
}

struct Fixture {
    owner: Arc<Owner>,
    native: Wire,
    control: Wire,
    peer: Wire,
}

impl Fixture {
    async fn new() -> Self {
        let (native, pump) = Channel::new(Link::Stdio);
        let (control, control_pump) = Channel::new(Link::Control);
        let (observations, queue) = mpsc::channel(OBSERVATION_FRAMES);
        let (progress, observed) = watch::channel(0);
        let owner = Arc::new(Owner {
            native,
            helper: Helper {
                bun: OsString::new(),
                script: PathBuf::new(),
                manifest: PathBuf::new(),
                cwd: PathBuf::new(),
                inventory: None,
            },
            control: OnceLock::from(control.clone()),
            identity: OnceLock::new(),
            native_pid: 1,
            state: Mutex::default(),
            observations,
            observation_bytes: Arc::new(Semaphore::new(OBSERVATION_BYTES)),
            observed,
            inventory_slots: Semaphore::new(INVENTORY_CONCURRENCY),
        });
        let (stock, fake_native) = UnixStream::pair().unwrap();
        let (input, output) = stock.into_split();
        let _native_reader = owner.start_native(pump, input, output);
        let (lifecycle, fake_control) = UnixStream::pair().unwrap();
        let (input, output) = lifecycle.into_split();
        let _control_reader = control.start(control_pump, input, output, |_, _| ready(()), ready);
        let worker = Arc::clone(&owner);
        tokio::spawn(async move { worker.observe(queue, progress).await });
        let peer = Self::connect(&owner).await;
        Self {
            owner,
            native: Wire::new(fake_native),
            control: Wire::new(fake_control),
            peer,
        }
    }

    async fn connect(owner: &Arc<Owner>) -> Wire {
        let (host, client) = UnixStream::pair().unwrap();
        owner.connect(host).unwrap();
        let mut peer = Wire::new(client);
        assert_eq!(peer.frame().await["type"], "ready");
        peer
    }

    fn admit(&self, frame: Value) {
        let peer = self
            .owner
            .state()
            .unwrap()
            .peers
            .values()
            .next()
            .unwrap()
            .clone();
        commands::admit(&self.owner, frame, &peer).unwrap();
    }

    async fn expect_maintenance_refused_without_fencing(&mut self) {
        // Observe the admission state in the same turn as both refusals, so a
        // transient fence cannot pass by disappearing before the readback.
        for kind in ["shutdown_host", "set_model_preset", "get_host_admission"] {
            self.admit(json!({"type": kind, "id": kind}));
        }
        for kind in ["shutdown_host", "set_model_preset"] {
            let refused = self.peer.frame().await;
            assert_eq!(refused["id"], kind);
            assert_eq!(refused["command"], kind);
            assert_eq!(refused["success"], false);
            assert_eq!(refused["code"], "session_busy");
        }
        let admission = self.peer.frame().await;
        assert_eq!(admission["id"], "get_host_admission");
        assert_eq!(admission["data"]["fenced"], false);
    }
}

#[tokio::test]
async fn native_forms_are_cancelled_without_a_peer_and_never_forwarded_or_reanswered() {
    let mut fixture = Fixture::new().await;
    fixture.peer.output.shutdown().await.unwrap();
    assert_eq!(fixture.peer.read().await, None);

    for id in ["detached-form", "attached-form"] {
        fixture
            .native
            .send(json!({
                "type": "extension_ui_request",
                "method": "form",
                "id": id,
                "html": "<form><input name=\"secret\"></form>",
            }))
            .await;
        assert_eq!(
            fixture.native.frame().await,
            json!({"type": "extension_ui_response", "id": id, "cancelled": true})
        );
        if id == "detached-form" {
            fixture.peer = Fixture::connect(&fixture.owner).await;
        }
    }
    let next = json!({"type": "extension_ui_request", "method": "notify", "message": "next"});
    fixture.native.send(next.clone()).await;
    assert_eq!(fixture.peer.frame().await, next);

    for id in ["detached-form", "attached-form"] {
        fixture
            .peer
            .send(json!({"type": "extension_ui_response", "id": id, "data": {"secret": "late"}}))
            .await;
    }
    fixture
        .peer
        .send(json!({"type": "get_messages", "id": "still-connected"}))
        .await;
    let query = fixture.native.frame().await;
    assert_eq!(query["type"], "get_messages");
    fixture
        .native
        .reply(&query, json!({"success": true, "data": {"messages": []}}))
        .await;
    assert_eq!(
        fixture.peer.frame().await,
        json!({"type": "response", "command": "get_messages", "id": "still-connected",
            "success": true, "data": {"messages": []}})
    );
}

#[tokio::test]
async fn stock_state_cannot_advertise_an_unattested_journal_cursor() {
    let mut fixture = Fixture::new().await;
    assert!(
        fixture
            .owner
            .identity
            .set(Identity {
                session_id: "session".into(),
                session_file: "/session.jsonl".into(),
                generation: None,
                instance_key: None,
                journal_cursor: false,
            })
            .is_ok()
    );
    fixture.admit(json!({"type": "get_state", "id": "state"}));
    let stock = fixture.native.frame().await;
    fixture
        .native
        .reply(
            &stock,
            json!({"success": true, "data": {"sessionId": "session", "sessionFile": "/session.jsonl",
                "journalCursorControlVersion": 1, "journalCursorVersion": 1}}),
        )
        .await;
    let snapshot = fixture.control.frame().await;
    fixture
        .control
        .reply(
            &snapshot,
            json!({"success": true, "data": {"hostPid": 1, "sessionId": "session", "sessionFile": "/session.jsonl",
                "hasOwnedRunningWork": false}}),
        )
        .await;
    let response = fixture.peer.frame().await;
    assert_eq!(response["success"], true);
    assert!(response["data"].get("journalCursorVersion").is_none());
    assert!(response["data"].get("journalCursorControlVersion").is_none());

    fixture.admit(json!({"type": "get_journal_cursor", "id": "lookup"}));
    let response = fixture.peer.frame().await;
    assert_eq!(response["id"], "lookup");
    assert_eq!(response["success"], false);
}

#[tokio::test]
async fn journal_cursor_waits_for_durable_observations_and_validates_its_owner() {
    let mut fixture = Fixture::new().await;
    let owner = Arc::clone(&fixture.owner);
    assert!(
        owner
            .identity
            .set(Identity {
                session_id: "session".into(),
                session_file: "/session.jsonl".into(),
                generation: Some(json!(2)),
                instance_key: Some(json!("instance")),
                journal_cursor: true,
            })
            .is_ok()
    );
    let identity = json!({
        "hostPid": 1, "sessionId": "session", "sessionFile": "/session.jsonl",
        "generation": 2, "instanceKey": "instance",
    });
    let completion = json!({"type": "prompt_result", "id": "finished", "status": "completed"});
    owner.native_event(completion.clone()).await.unwrap();
    let observation = fixture.control.frame().await;
    assert_eq!(observation["type"], "observe");
    assert_eq!(observation["frame"], completion);

    let mut cursor = std::pin::pin!(owner.journal_cursor());
    tokio::select! {
        biased;
        result = &mut cursor => panic!("cursor finished before observation acknowledgement: {result:?}"),
        () = ready(()) => {}
    }
    // A cursor dispatched before the pending ACK would be ahead of this
    // marker on the control channel. No timer or scheduling assumption.
    owner
        .control()
        .unwrap()
        .send(json!({"type": "marker"}))
        .unwrap();
    assert_eq!(fixture.control.frame().await["type"], "marker");
    fixture
        .control
        .reply(
            &observation,
            json!({"success": true, "data": {"entryId": "receipt"}}),
        )
        .await;
    let (result, ()) = tokio::join!(cursor, async {
        let request = fixture.control.frame().await;
        assert_eq!(request["type"], "get_journal_cursor");
        let mut data = identity.clone();
        data["leafId"] = json!("receipt");
        fixture
            .control
            .reply(&request, json!({"success": true, "data": data}))
            .await;
    });
    assert_eq!(result.unwrap().as_deref(), Some("receipt"));
    assert_eq!(fixture.peer.frame().await, completion);

    for (key, value, ok) in [
        ("leafId", Some(Value::Null), true),
        ("leafId", None, false),
        ("leafId", Some(json!(7)), false),
        ("generation", Some(json!(3)), false),
        ("instanceKey", Some(json!("other-instance")), false),
    ] {
        fixture.admit(json!({"type": "get_journal_cursor", "id": "lookup"}));
        let request = fixture.control.frame().await;
        assert_eq!(request["type"], "get_journal_cursor");
        let mut data = identity.clone();
        if key != "leafId" {
            data["leafId"] = json!("receipt");
        }
        if let Some(value) = value {
            data[key] = value;
        }
        fixture
            .control
            .reply(&request, json!({"success": true, "data": data}))
            .await;
        let reply = fixture.peer.frame().await;
        assert_eq!(reply["success"], ok, "{key}: {reply}");
        if ok {
            assert_eq!(reply["data"], json!({"leafId": null}));
        }
    }
}

#[tokio::test]
async fn maintenance_cannot_fence_an_earlier_admitted_prompt() {
    let mut fixture = Fixture::new().await;

    // Before the spawned dispatch has had a chance to run.
    fixture.admit(json!({"type": "prompt", "id": "earlier", "message": "test"}));
    fixture.expect_maintenance_refused_without_fencing().await;
    let prompt = fixture.native.frame().await;
    assert_eq!(prompt["type"], "prompt");
    fixture
        .native
        .reply(&prompt, json!({"success": true}))
        .await;
    let accepted = fixture.peer.frame().await;
    assert_eq!(accepted["id"], "earlier");
    assert_eq!(accepted["success"], true);

    // After the command returns, native still owes its terminal receipt.
    fixture.expect_maintenance_refused_without_fencing().await;
}

#[tokio::test]
async fn late_abort_and_prompt_error_keeps_terminal_caller_id() {
    let mut fixture = Fixture::new().await;
    fixture
        .peer
        .send(json!({"type": "abort_and_prompt", "id": "caller", "message": "test"}))
        .await;
    for kind in ["interrupt_maintenance", "finish_interrupt"] {
        let request = fixture.control.frame().await;
        assert_eq!(request["type"], kind);
        fixture
            .control
            .reply(&request, json!({"success": true, "data": {}}))
            .await;
    }
    let prompt = fixture.native.frame().await;
    assert_eq!(prompt["type"], "abort_and_prompt");
    assert_ne!(prompt["id"], "caller");
    fixture
        .native
        .reply(&prompt, json!({"success": true}))
        .await;
    let accepted = fixture.peer.frame().await;
    assert_eq!(accepted["id"], "caller");
    assert_eq!(accepted["success"], true);

    fixture
        .native
        .reply(&prompt, json!({"success": false, "error": "input failed"}))
        .await;
    let mut terminal = json!({
        "type": "prompt_result", "id": prompt["id"], "status": "error",
        "agentInvoked": false, "sessionSettled": true,
        "error": {"message": "input failed", "retryable": false},
    });
    fixture.native.send(terminal.clone()).await;

    terminal["id"] = json!("caller");
    let observation = fixture.control.frame().await;
    assert_eq!(observation["type"], "observe");
    assert_eq!(observation["frame"], terminal);
    fixture
        .control
        .reply(
            &observation,
            json!({"success": true, "data": {"entryId": "receipt"}}),
        )
        .await;
    assert_eq!(fixture.peer.frame().await, terminal);
}

#[tokio::test]
async fn failed_local_prompt_observation_disconnects_and_fences() {
    let mut fixture = Fixture::new().await;
    fixture
        .peer
        .send(json!({"type": "prompt", "id": "local", "message": "/test"}))
        .await;
    let prompt = fixture.native.frame().await;
    assert_eq!(prompt["type"], "prompt");
    fixture
        .native
        .reply(
            &prompt,
            json!({"success": true, "data": {"agentInvoked": false}}),
        )
        .await;
    let observation = fixture.control.frame().await;
    assert_eq!(observation["type"], "observe");
    assert_eq!(
        observation["frame"],
        json!({"type": "prompt_result", "id": "local", "agentInvoked": false, "status": "completed"}),
    );
    fixture
        .control
        .reply(
            &observation,
            json!({"success": false, "error": "cannot persist"}),
        )
        .await;

    // No success or definite-rejection frame is safe to send now.
    assert_eq!(fixture.peer.read().await, None);
    let mut reconnect = Fixture::connect(&fixture.owner).await;
    reconnect
        .send(json!({"type": "get_host_admission", "id": "reconnect"}))
        .await;
    let admission = reconnect.frame().await;
    assert_eq!(admission["id"], "reconnect");
    assert_eq!(admission["data"]["fenced"], true);
    reconnect
        .send(json!({"type": "prompt", "id": "next", "message": "test"}))
        .await;
    let refused = reconnect.frame().await;
    assert_eq!(refused["id"], "next");
    assert_eq!(refused["success"], false);
}
