use super::*;

fn worker_identity() -> OnceLock<Identity> {
    OnceLock::from(Identity {
        session_id: "worker-session".into(),
        session_file: "/worker-session.jsonl".into(),
        generation: None,
        instance_key: None,
        worker_attempt: Some("worker-attempt".into()),
        journal_cursor: true,
    })
}

async fn expect_refusal(peer: &mut Wire, frame: Value) {
    let refused = json!({
        "type": "response",
        "command": frame["type"],
        "id": frame["id"],
        "success": false,
        "code": "worker_rpc_forbidden",
        "error": "Command or arguments are not allowed on a remote worker Host",
    });
    peer.send(frame).await;
    assert_eq!(peer.frame().await, refused);
}

#[tokio::test]
async fn worker_peer_refuses_non_head_rpc_before_native_dispatch() {
    let mut fixture = Fixture::with_identity(worker_identity()).await;
    fixture
        .peer
        .send(json!({
            "type": "negotiate_protocol", "id": "protocol", "protocolVersion": 2,
        }))
        .await;
    assert_eq!(fixture.peer.frame().await["data"]["protocolVersion"], 2);
    fixture
        .peer
        .send(json!({
            "type": "get_host_admission", "id": "capability", "messageUpdateCapability": true,
        }))
        .await;
    assert_eq!(
        fixture.peer.frame().await["data"]["messageUpdates"],
        "activity-v1"
    );
    fixture
        .peer
        .send(json!({
            "type": "set_host_message_updates", "id": "projection", "messageUpdates": "activity-v1",
        }))
        .await;
    assert_eq!(fixture.peer.frame().await["success"], true);

    for frame in [
        json!({"type": "get_future_path_lookup"}),
        json!({"type": "get_subagent_messages", "sessionFile": "/another-session.jsonl"}),
        json!({"type": "open_session", "sessionDir": "/another-session"}),
        json!({"type": "switch_session", "sessionPath": "/another-session.jsonl"}),
        json!({"type": "export_html", "outputPath": "/another-folder/export.html"}),
        json!({"type": "bash", "command": "echo fixture"}),
        json!({"type": "set_event_filter", "events": []}),
        json!({"type": "set_host_tools", "tools": []}),
        json!({"type": "goal", "op": "create", "objective": "Do work"}),
        json!({"type": "abort_and_prompt", "message": "Start something else"}),
        json!({"type": "prompt", "message": "Do work", "cwd": "/another-checkout"}),
        json!({"type": "get_entries", "since": "leaf", "sessionFile": "/another-session.jsonl"}),
        json!({"type": "set_model_preset", "name": "code", "preset": {"modelRoles": {}}, "preserveActiveModel": true}),
        json!({"type": "set_model_preset", "name": "code", "preset": {"modelRoles": {}, "configPath": "/another-config"}}),
        json!({"type": "shutdown_host", "headRotation": "inapplicable-head-receipt"}),
        json!({"type": "prompt", "message": "\u{feff}\n  /reload"}),
        json!({"type": "prompt", "message": "Start with /skill:some-skill then continue"}),
        json!({"type": "prompt", "message": "Read this image", "images": [
            {"type": "image", "data": "AA==", "mimeType": "image/png"}
        ]}),
    ] {
        let mut frame = frame;
        frame["id"] = json!("refused");
        expect_refusal(&mut fixture.peer, frame).await;
    }

    let message = "```superagent-runtime-context\nRequest ID: request\n```\n\nExplain /reload.";
    fixture
        .peer
        .send(json!({
            "type": "prompt", "id": "admitted", "message": message, "streamingBehavior": "steer",
        }))
        .await;
    let native = fixture.native.frame().await;
    assert_eq!(native["type"], "prompt");
    assert_eq!(native["message"], message);
    assert_eq!(native["streamingBehavior"], "steer");
    fixture
        .native
        .reply(&native, json!({"success": true}))
        .await;
    assert_eq!(
        fixture.peer.frame().await,
        json!({"type": "response", "command": "prompt", "id": "admitted", "success": true})
    );
}

#[tokio::test]
async fn worker_can_apply_a_frozen_preset_through_the_owned_maintenance_path() {
    let mut fixture = Fixture::with_identity(worker_identity()).await;
    let preset = json!({
        "modelRoles": {"default": "test-offline/coding", "review": "test-offline/reviewer"},
        "defaultThinkingLevel": "auto",
    });
    fixture
        .peer
        .send(json!({"type": "set_model_preset", "id": "preset", "name": "coding", "preset": preset}))
        .await;

    for _ in 0..2 {
        let native = fixture.native.frame().await;
        assert_eq!(native["type"], "get_state");
        fixture
            .native
            .reply(
                &native,
                json!({"success": true, "data": {
                    "sessionId": "worker-session", "sessionFile": "/worker-session.jsonl",
                    "isSettled": true, "isStreaming": false, "isCompacting": false,
                    "hasPendingAsyncWork": false, "queuedMessageCount": 0,
                }}),
            )
            .await;
        let snapshot = fixture.control.frame().await;
        assert_eq!(snapshot["type"], "snapshot");
        fixture
            .control
            .reply(
                &snapshot,
                json!({"success": true, "data": {
                    "sessionId": "worker-session", "sessionFile": "/worker-session.jsonl",
                    "hostPid": 1, "workerAttempt": "worker-attempt", "hasOwnedRunningWork": false,
                    "admitted": false, "postPromptWork": false, "mutationHeld": false,
                }}),
            )
            .await;
    }
    let private = fixture.control.frame().await;
    assert_eq!(private["type"], "set_model_preset");
    assert_eq!(private["name"], "coding");
    assert_eq!(private["preset"], preset);
    fixture
        .control
        .reply(&private, json!({"success": true}))
        .await;
    assert_eq!(
        fixture.peer.frame().await,
        json!({"type": "response", "command": "set_model_preset", "id": "preset", "success": true})
    );
}

#[tokio::test]
async fn worker_ui_receipts_only_settle_the_exact_outstanding_native_question() {
    let mut fixture = Fixture::with_identity(worker_identity()).await;
    let question = json!({
        "type": "extension_ui_request",
        "id": "native-ask",
        "method": "ask",
        "questions": [{"id": "native-question", "options": [{"label": "Use A"}, {"label": "Use B"}]}],
    });
    fixture.native.send(question.clone()).await;
    assert_eq!(fixture.peer.frame().await, question);
    fixture
        .peer
        .send(json!({
            "type": "extension_ui_response", "id": "other-dialog", "cancelled": true,
        }))
        .await;
    for response in [
        json!({"confirmed": true}),
        json!({"cancelled": true, "confirmed": true}),
        json!({"answers": [{"id": "other-question", "selectedOptions": ["Use B"]}]}),
        json!({"answers": [{"id": "native-question", "selectedOptions": ["Not an option"]}]}),
        json!({"answers": [{"id": "native-question", "selectedOptions": [], "path": "/other"}]}),
    ] {
        let mut response = response;
        response["type"] = json!("extension_ui_response");
        response["id"] = json!("native-ask");
        expect_refusal(&mut fixture.peer, response).await;
    }
    let valid = json!({
        "type": "extension_ui_response", "id": "native-ask",
        "answers": [{"id": "native-question", "selectedOptions": ["Use B"]}],
    });
    fixture.peer.send(valid.clone()).await;
    fixture.peer.send(valid.clone()).await;
    assert_eq!(fixture.native.frame().await, valid);

    fixture
        .peer
        .send(json!({"type": "get_entries", "id": "inspect", "since": "leaf"}))
        .await;
    let native = fixture.native.frame().await;
    assert_eq!(native["type"], "get_entries");
    assert_eq!(native["since"], "leaf");
    fixture
        .native
        .reply(&native, json!({"success": true, "data": {"entries": []}}))
        .await;
    assert_eq!(fixture.peer.frame().await["id"], "inspect");
}

#[tokio::test]
async fn local_peer_retains_stock_command_dispatch() {
    let mut fixture = Fixture::new().await;
    fixture
        .peer
        .send(json!({"type": "set_event_filter", "id": "local", "events": []}))
        .await;
    let native = fixture.native.frame().await;
    assert_eq!(native["type"], "set_event_filter");
    assert_eq!(native["events"], json!([]));
    fixture
        .native
        .reply(&native, json!({"success": true}))
        .await;
    assert_eq!(fixture.peer.frame().await["success"], true);
}
