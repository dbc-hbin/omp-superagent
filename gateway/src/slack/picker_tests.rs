use super::*;

fn actions(card: &Value) -> &Value {
    card["blocks"]
        .as_array()
        .expect("posted Block Kit message")
        .iter()
        .find(|block| block["type"] == "actions")
        .expect("picker controls")
}

fn picker_action(envelope: &str, card: &Value, action: Value) -> Value {
    json!({
        "type": "interactive", "envelope_id": envelope,
        "payload": {
            "type": "block_actions", "api_app_id": "ALOCAL",
            "team": {"id": "TLOCAL"}, "user": {"id": "UOWNER"},
            "channel": {"id": card["channel"]},
            "container": {
                "type": "message", "channel_id": card["channel"],
                "message_ts": card["ts"], "is_ephemeral": false,
            },
            "message": card,
            "actions": [action],
        },
    })
}

fn selection(envelope: &str, card: &Value, option: usize) -> Value {
    let actions = actions(card);
    let select = actions["elements"]
        .as_array()
        .expect("picker elements")
        .iter()
        .find(|element| element["type"] == "static_select")
        .expect("native picker dropdown");
    picker_action(envelope, card, json!({
        "type": "static_select", "block_id": actions["block_id"],
        "action_id": select["action_id"], "selected_option": select["options"][option],
    }))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn slack_picker_admits_only_the_linked_owner_selection_before_ack() {
    let mut fixture = Fixture::new().await;
    let (mut peer, result) = fixture.start("ALOCAL").await;
    result.expect("authenticated Slack workspace");
    fixture.hub.ready.send(true).expect("open native readiness");
    let route = json!({
        "platform": "slack", "accountId": "TLOCAL:UBOT", "authorityId": "UOWNER",
        "guildId": null, "channelId": "DOWNER", "threadId": "1000.000001",
        "topicId": "original-logical-topic",
    });
    let remote = fixture
        .hub
        .effect(
            "send",
            &[json!({
                "id": "selector-output", "route": route, "text": "Current model",
                "picker": {
                    "kind": "model", "expiresAt": crate::store::now().unwrap() + 300_000,
                    "current": "first-internal-model-id",
                    "groups": [{
                        "label": "Provider",
                        "options": ["first-internal-model-id", "second-internal-model-id"],
                    }],
                },
            })],
        )
        .await
        .expect("post Slack picker");
    let posted = fixture.called("chat.postMessage").await;
    assert_eq!(posted["thread_ts"], route["threadId"]);
    let mut card = fixture.state.card.lock().await.clone();
    send(&mut peer, selection("provider", &card, 0)).await;
    assert_eq!(ack(&mut peer).await, json!({"envelope_id": "provider"}));
    let refreshed = fixture.called("chat.update").await;
    assert_eq!(refreshed["ts"], remote);
    assert_eq!(refreshed["channel"], route["channelId"]);
    assert!(
        refreshed["blocks"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|block| block["elements"].as_array())
            .flatten()
            .any(|element| element["type"] == "button" && element["text"]["text"] == "Back")
    );
    card["blocks"] = refreshed["blocks"].clone();
    let selected = selection("selected", &card, 1);
    assert_ne!(
        selected["payload"]["actions"][0]["selected_option"]["value"],
        "second-internal-model-id"
    );

    for (id, invalid_fields) in [
        ("wrong-owner", vec![("/payload/user/id", "UOTHER")]),
        ("wrong-workspace", vec![("/payload/team/id", "TOUTSIDE")]),
        ("other-author", vec![("/payload/message/bot_id", "BOTHER")]),
        ("wrong-container", vec![("/payload/container/channel_id", "CALLOWED")]),
        ("wrong-message", vec![("/payload/message/ts", "2000.000002")]),
        ("wrong-thread", vec![("/payload/message/thread_ts", "1000.000002")]),
        (
            "other-card",
            vec![
                ("/payload/container/message_ts", "2000.000002"),
                ("/payload/message/ts", "2000.000002"),
            ],
        ),
    ] {
        let mut forged = selected.clone();
        forged["envelope_id"] = json!(id);
        for (field, replacement) in invalid_fields {
            *forged.pointer_mut(field).expect("callback field") = json!(replacement);
        }
        send(&mut peer, forged).await;
        assert_eq!(ack(&mut peer).await, json!({"envelope_id": id}));
        assert_eq!(
            fixture.store.pending().expect("read native ingress"),
            0,
            "{id}"
        );
    }

    // Those ACKs follow any workspace lookup they triggered; discard those traces.
    while fixture.traces.try_recv().is_ok() {}
    let mut writer = Connection::open(fixture.root.join("coordination.sqlite"))
        .expect("independent SQLite writer");
    let transaction = writer
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .expect("block durable admission");
    send(&mut peer, selected.clone()).await;
    fixture.called("conversations.info").await;
    assert!(
        timeout(Duration::from_millis(200), peer.next()).await.is_err(),
        "Slack acknowledged selection before durable admission"
    );
    transaction.rollback().expect("allow durable admission");
    assert_eq!(ack(&mut peer).await, json!({"envelope_id": "selected"}));
    let row = fixture.store.next(None).unwrap().expect("admitted picker input");
    assert_eq!(row.event["kind"], "message");
    assert_eq!(row.event["input"]["route"], route);
    assert!(row.event["input"]["messageId"].is_null());
    assert_eq!(row.event["input"]["text"], "");
    assert_eq!(
        row.event["input"]["pickerSelection"],
        json!({"outputId": "selector-output", "cardId": remote, "group": 0, "option": 1})
    );
    let closed = fixture.called("chat.update").await;
    assert_eq!(closed["ts"], remote);
    assert!(
        closed["blocks"]
            .as_array()
            .unwrap()
            .iter()
            .all(|block| block["type"] != "actions")
    );
    let mut duplicate = selected;
    duplicate["envelope_id"] = json!("duplicate");
    duplicate["accepts_response_payload"] = json!(true);
    send(&mut peer, duplicate).await;
    let expired = ack(&mut peer).await;
    assert_eq!(expired["envelope_id"], "duplicate");
    assert_eq!(expired["payload"]["response_type"], "ephemeral");
    assert_eq!(fixture.store.pending().unwrap(), 1);
    fixture.hub.stop().await.expect("stop Slack adapter");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn slack_usage_reset_admits_only_one_confirm_on_the_linked_owner_card() {
    let mut fixture = Fixture::new().await;
    let (mut peer, result) = fixture.start("ALOCAL").await;
    result.expect("authenticated Slack workspace");
    fixture.hub.ready.send(true).expect("open native readiness");
    let route = json!({
        "platform": "slack", "accountId": "TLOCAL:UBOT", "authorityId": "UOWNER",
        "guildId": null, "channelId": "DOWNER", "threadId": "1000.000001",
        "topicId": "original-logical-topic",
    });
    let target = "Account lab-research-with-a-long-display-label-for-token-usage: 23 saved requests";
    let remote = fixture
        .hub
        .effect(
            "send",
            &[json!({
                "id": "reset-output", "route": route, "text": "Saved usage",
                "picker": {
                    "kind": "usage-reset", "expiresAt": crate::store::now().unwrap() + 300_000,
                    "groups": [{"label": "Accounts", "options": ["Account staging: 2 saved requests", target]}],
                },
            })],
        )
        .await
        .expect("post Slack picker");
    fixture.called("chat.postMessage").await;
    let mut card = fixture.state.card.lock().await.clone();
    send(&mut peer, selection("choose-account", &card, 1)).await;
    assert_eq!(ack(&mut peer).await, json!({"envelope_id": "choose-account"}));
    let review = fixture.called("chat.update").await;
    assert_eq!(review["ts"], remote);
    assert_eq!(fixture.store.pending().unwrap(), 0);
    assert!(review["blocks"].as_array().unwrap().iter().any(|block| {
        block["type"] == "section"
            && block["text"]["text"].as_str().is_some_and(|text| text.contains(target))
    }));
    card["blocks"] = review["blocks"].clone();
    let controls = actions(&card);
    let elements = controls["elements"].as_array().unwrap();
    assert!(elements.iter().all(|element| element["type"] == "button"));
    let confirm = elements
        .iter()
        .find(|element| element["text"]["text"] == "Confirm")
        .expect("visible confirmation button");
    let click = picker_action("confirmed", &card, json!({
        "type": "button", "block_id": controls["block_id"], "action_id": confirm["action_id"],
    }));

    for (envelope, invalid_fields) in [
        ("other-owner", vec![("/payload/user/id", "UOTHER")]),
        ("other-thread", vec![("/payload/message/thread_ts", "1000.000002")]),
        ("other-card", vec![
            ("/payload/container/message_ts", "2000.000002"),
            ("/payload/message/ts", "2000.000002"),
        ]),
    ] {
        let mut forged = click.clone();
        forged["envelope_id"] = json!(envelope);
        for (field, wrong) in invalid_fields {
            *forged.pointer_mut(field).expect("callback field") = json!(wrong);
        }
        send(&mut peer, forged).await;
        assert_eq!(ack(&mut peer).await, json!({"envelope_id": envelope}));
        assert_eq!(fixture.store.pending().unwrap(), 0, "{envelope}");
    }

    send(&mut peer, click.clone()).await;
    assert_eq!(ack(&mut peer).await, json!({"envelope_id": "confirmed"}));
    let row = fixture.store.next(None).unwrap().expect("durable reset input");
    assert_eq!(row.event["input"]["route"], route);
    assert_eq!(
        row.event["input"]["pickerSelection"],
        json!({"outputId": "reset-output", "cardId": remote, "group": 0, "option": 1, "confirmed": true})
    );
    let closed = fixture.called("chat.update").await;
    assert!(closed["blocks"].as_array().unwrap().iter().all(|block| block["type"] != "actions"));
    let mut duplicate = click;
    duplicate["envelope_id"] = json!("duplicate-confirm");
    duplicate["accepts_response_payload"] = json!(true);
    send(&mut peer, duplicate).await;
    let expired = ack(&mut peer).await;
    assert_eq!(expired["envelope_id"], "duplicate-confirm");
    assert_eq!(expired["payload"]["response_type"], "ephemeral");
    assert_eq!(fixture.store.pending().unwrap(), 1);
    fixture.hub.stop().await.expect("stop Slack adapter");
}
