use super::*;
use crate::server::tests::SocketDir;

#[path = "presence_harness.rs"]
mod harness;

use harness::{Controller, call, effect, head, login, packet, persist, presence_packet, request, snapshot, start};

#[tokio::test]
async fn discord_presence_restart_retains_stop_and_fences_old_starts() {
    let root = SocketDir::new().unwrap();
    let store = Arc::new(Store::open(&root.0).unwrap());
    let owner = head(&root);
    let (hub, listener, _, _, rest, _, _) =
        discord_fixture_with_store(json!({"discord":{}}), &store).await;
    let (mut socket, identify) = start(&hub, &listener, "71").await;
    let mut client = Controller::attach(&root, &store, &hub).await;
    assert!(identify["d"].get("presence").is_none());
    let mut go = client.original(&mut socket, 2, "start presence").await;
    go.source["route"]["topicId"] = json!("logical-dm-topic");
    client.admit(&owner, &go).await;
    let old = client.original(&mut socket, 3, "older unprocessed start").await;
    client.admit(&owner, &old).await;
    let stop = client.original(&mut socket, 4, "stop presence").await;
    client.admit(&owner, &stop).await;
    let status_call = effect("status", &go);
    assert_eq!(call(&client, &status_call).await, snapshot("default", "connected", None, false));
    let start_call = effect("start", &go);
    assert_eq!(call(&client, &start_call).await, snapshot("online", "connected", None, false));
    presence_packet(&mut socket, "online").await;
    assert_eq!(call(&client, &status_call).await, snapshot("online", "connected", Some("online"), true));
    let stop_call = effect("stop", &stop);
    assert_eq!(call(&client, &stop_call).await, snapshot("invisible", "connected", Some("online"), false));
    presence_packet(&mut socket, "invisible").await;
    let incoming = client.original(&mut socket, 5, "ordinary DM while invisible").await;
    client.admit(&owner, &incoming).await;
    client.close().await;
    hub.stop().await.unwrap();
    rest.abort();
    drop(hub);
    drop(store);

    let store = Arc::new(Store::open(&root.0).unwrap());
    let (hub, listener, _, _, rest, _, _) =
        discord_fixture_with_store(json!({"discord":{}}), &store).await;
    let (mut socket, identify) = start(&hub, &listener, "71").await;
    let mut client = Controller::attach(&root, &store, &hub).await;
    assert_eq!(identify["d"]["presence"], json!({
        "status":"invisible","since":null,"activities":[],"afk":false,
    }));
    let invisible = snapshot("invisible", "connected", Some("invisible"), true);
    assert_eq!(call(&client, &status_call).await, invisible);
    assert_eq!(call(&client, &start_call).await, invisible);
    assert_eq!(call(&client, &effect("start", &go)).await, invisible);
    assert_eq!(call(&client, &stop_call).await, invisible);
    let stale = call(&client, &effect("start", &old)).await;
    assert_eq!(stale["error"], "Messenger presence request is older than the current intent");
    assert_eq!(stale["certainty"], "rejected");
    let conflict = call(&client, &effect("start", &stop)).await;
    assert_eq!(conflict["error"], "Messenger presence request identity conflict");
    let mut wire_conflict = stop_call.clone();
    wire_conflict["args"][0]["action"] = json!("status");
    assert_eq!(call(&client, &wire_conflict).await["error"],
        "Messenger presence request identity conflict");
    let incoming = client.original(&mut socket, 6, "ordinary DM after restart").await;
    client.admit(&owner, &incoming).await;
    client.close().await;
    hub.stop().await.unwrap();
    rest.abort();
    drop(hub);

    let (other, listener, _, _, rest, responses, _) =
        discord_fixture_with_store(json!({"discord":{}}), &store).await;
    addressing_tests::respond(&responses, "/users/@me", StatusCode::OK, json!({"id":"73","bot":true}));
    let (mut socket, identify) = start(&other, &listener, "73").await;
    let mut client = Controller::attach(&root, &store, &other).await;
    assert!(identify["d"].get("presence").is_none(), "a saved stop belongs to one bot");
    let input = client.original(&mut socket, 7, "other bot status").await;
    client.admit(&owner, &input).await;
    assert_eq!(call(&client, &effect("status", &input)).await,
        snapshot("default", "connected", None, false));
    client.close().await;
    other.stop().await.unwrap();
    rest.abort();
}

#[tokio::test]
async fn discord_presence_resume_coalesces_intents_and_keeps_inbound_routing() {
    let root = SocketDir::new().unwrap();
    let store = Arc::new(Store::open(&root.0).unwrap());
    let owner = head(&root);
    let (hub, listener, _, _, rest, _, _) =
        discord_fixture_with_store(json!({"discord":{}}), &store).await;
    let (mut socket, _) = start(&hub, &listener, "71").await;
    let mut client = Controller::attach(&root, &store, &hub).await;
    let start = client.original(&mut socket, 2, "start").await;
    client.admit(&owner, &start).await;
    let stop = client.original(&mut socket, 3, "stop").await;
    client.admit(&owner, &stop).await;
    let toggle = client.original(&mut socket, 4, "start again").await;
    client.admit(&owner, &toggle).await;
    let finish = client.original(&mut socket, 5, "stop again").await;
    client.admit(&owner, &finish).await;
    assert_eq!(call(&client, &effect("start", &start)).await["ok"], true);
    presence_packet(&mut socket, "online").await;
    wire(&mut socket, json!({"op":7,"d":null})).await;
    let (mut resumed, resume) = time::timeout(Duration::from_secs(5), login(&listener)).await.unwrap();
    assert_eq!(resume["op"], 6);
    assert_eq!(resume["d"]["seq"], 5);
    assert!(resume["d"].get("presence").is_none());
    let status = effect("status", &finish);
    assert_eq!(call(&client, &status).await, snapshot("online", "disconnected", None, false));
    assert_eq!(call(&client, &effect("stop", &stop)).await, snapshot("invisible", "disconnected", None, false));
    assert_eq!(call(&client, &effect("start", &toggle)).await, snapshot("online", "disconnected", None, false));
    assert_eq!(call(&client, &effect("stop", &finish)).await, snapshot("invisible", "disconnected", None, false));

    wire(&mut resumed, json!({"op":1,"d":null})).await;
    assert_eq!(packet(&mut resumed).await["op"], 1, "RESUME has not authenticated yet");
    wire(&mut resumed, json!({"op":11,"d":null})).await;
    let replayed = client.original(&mut resumed, 6, "ordinary replayed DM").await;
    client.admit(&owner, &replayed).await;
    dispatch(&mut resumed, 7, "RESUMED", json!({})).await;
    client.reconnect().await;
    presence_packet(&mut resumed, "invisible").await;
    assert_eq!(call(&client, &status).await, snapshot("invisible", "connected", Some("invisible"), true));
    let incoming = client.original(&mut resumed, 8, "ordinary live DM after resume").await;
    client.admit(&owner, &incoming).await;
    client.close().await;
    hub.stop().await.unwrap();
    rest.abort();
}

#[tokio::test]
async fn discord_presence_requires_original_owner_route_and_strict_arguments() {
    let root = SocketDir::new().unwrap();
    let store = Arc::new(Store::open(&root.0).unwrap());
    let owner = head(&root);
    let (hub, listener, _, _, rest, _, _) = discord_fixture_with_store(json!({
        "discord":{"allowedChannelIds":["88","89"]},
        "groupRooms":[{"platform":"discord","guildId":"77","channelId":"89",
            "userIds":["42"],"mode":"chat","revision":"fixture","dailyLimit":1}],
    }), &store).await;
    let (mut socket, _) = start(&hub, &listener, "71").await;
    let mut client = Controller::attach(&root, &store, &hub).await;
    let input = client.original(&mut socket, 2, "check presence").await;
    let unauthorized = call(&client, &effect("start", &input)).await;
    assert_eq!(unauthorized["error"], "Messenger presence requires an original received owner source");
    client.admit(&owner, &input).await;
    let mut changed_topic = effect("start", &input);
    changed_topic["args"][0]["route"]["topicId"] = json!("unrelated-topic");
    assert_eq!(call(&client, &changed_topic).await["error"],
        "Messenger presence requires the exact original owner route");

    let mut wrong_account = effect("start", &input);
    wrong_account["args"][0]["route"]["accountId"] = json!("73");
    assert_eq!(call(&client, &wrong_account).await["error"],
        "Discord route is not authorized for this bot and owner");
    let mut restricted = effect("start", &input);
    restricted["args"][0]["route"]["guildId"] = json!("77");
    restricted["args"][0]["route"]["channelId"] = json!("89");
    assert_eq!(call(&client, &restricted).await["error"],
        "Owner operations are disabled in restricted group rooms");
    let mut unsupported = effect("start", &input);
    unsupported["args"][0]["route"]["platform"] = json!("slack");
    assert_eq!(call(&client, &unsupported).await["error"],
        "Messenger presence is only supported on Discord");
    let mut malformed = effect("start", &input);
    malformed["args"][0]["token"] = json!("not-accepted");
    assert_eq!(call(&client, &malformed).await["certainty"], "rejected");
    malformed["args"][0].as_object_mut().unwrap().remove("token");
    malformed["args"][0]["route"].as_object_mut().unwrap().remove("guildId");
    assert_eq!(call(&client, &malformed).await["certainty"], "rejected");

    // HEAD-only records are possible after catch-up, but must still carry
    // one canonical source kind; an interaction always has a Gateway receipt.
    for (id, message_id, interaction_id) in [
        ("discord:71:001:original", json!("001"), None),
        ("discord:71:221:original", json!("221"), Some("222")),
        ("discord:71:interaction:223", Value::Null, Some("223")),
    ] {
        let mut ambiguous = input.source.clone();
        ambiguous["id"] = json!(id);
        ambiguous["messageId"] = message_id;
        if let Some(interaction_id) = interaction_id {
            ambiguous["interactionId"] = json!(interaction_id);
        }
        persist(&owner, &ambiguous);
        assert_eq!(call(&client, &request("start", &ambiguous)).await["error"],
            "Messenger presence requires an original Discord message or application command");
    }
    assert_eq!(call(&client, &effect("status", &input)).await,
        snapshot("default", "connected", None, false));
    client.close().await;
    hub.stop().await.unwrap();
    rest.abort();
}

#[tokio::test]
async fn discord_presence_orders_original_snowflakes_across_routes_after_history_catchup() {
    // The stop is above i64::MAX and the old start is below it: the
    // assertion detects both admission order and signed snowflake order.
    const STOP: &str = "9223372041049075712";
    const OLD: &str = "9223372036854775807";
    const NEW: &str = "18446744073709551615";
    let root = SocketDir::new().unwrap();
    let store = Arc::new(Store::open(&root.0).unwrap());
    let owner = head(&root);
    let (hub, listener, mut rest_calls, _, rest, responses, _) =
        discord_fixture_with_store(json!({"discord":{}}), &store).await;
    let (mut socket, _) = start(&hub, &listener, "71").await;
    let mut client = Controller::attach(&root, &store, &hub).await;

    dispatch(&mut socket, 2, "INTERACTION_CREATE", interaction(STOP, 2,
        json!({"type":1,"name":"head","options":[{"type":3,"name":"text","value":"stop presence"}]}),
    )).await;
    let stop = client.next_input().await;
    assert_eq!(stop.source["interactionId"], STOP);
    assert!(stop.source["messageId"].is_null());
    assert_eq!(stop.source["route"]["channelId"], "99");
    client.admit(&owner, &stop).await;
    received(&mut rest_calls, &format!("/interactions/{STOP}/offline-interaction/callback")).await;
    assert_eq!(call(&client, &effect("stop", &stop)).await,
        snapshot("invisible", "connected", None, false));
    presence_packet(&mut socket, "invisible").await;

    addressing_tests::respond(&responses, "/channels/88/messages?after=199&limit=100",
        StatusCode::OK, json!([message(OLD, Some("77"), "88", "42", "old presence start")]));
    let caught_up = call(&client, &json!({
        "id":uuid::Uuid::new_v4().to_string(),"operation":"fetchAfter",
        "args":[addressing_tests::parent(),"199"],
    })).await;
    assert_eq!(caught_up["ok"], true);
    let old = &caught_up["value"][0];
    assert_eq!(old["messageId"], OLD);
    assert_eq!(old["route"]["channelId"], "88");
    persist(&owner, old);
    assert_eq!(call(&client, &request("start", old)).await["error"],
        "Messenger presence request is older than the current intent");

    dispatch(&mut socket, 3, "MESSAGE_CREATE", message(NEW, Some("77"), "88", "42", "new presence start")).await;
    let new = client.next_input().await;
    assert_eq!(new.source["messageId"], NEW);
    assert_eq!(new.source["route"]["channelId"], "88");
    client.admit(&owner, &new).await;
    assert_eq!(call(&client, &effect("start", &new)).await,
        snapshot("online", "connected", Some("invisible"), false));
    presence_packet(&mut socket, "online").await;
    client.close().await;
    hub.stop().await.unwrap();
    rest.abort();
}
