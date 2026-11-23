use rusqlite::Connection;

use super::{
    *,
    addressing_tests::{bot_message, mention, owner, parent, reply, respond, start},
};

const REFERENCE: &str = "/channels/88/messages/111";
const FIRST_EDIT: &str = "2026-11-21T01:02:03.456000+00:00";
const FIRST_EDIT_MS: i64 = 1_795_222_923_456;

pub(super) fn journal(temporary: &Temp) -> Vec<String> {
    let db = Connection::open(temporary.0.join("coordination.sqlite")).unwrap();
    let mut read = db.prepare("SELECT data FROM discord_owner_intake ORDER BY sequence").unwrap();
    read.query_map([], |row| row.get(0)).unwrap().collect::<Result<_, _>>().unwrap()
}

pub(super) async fn assert_checkpoint(socket: &mut FixtureSocket, sequence: u64) {
    wire(socket, json!({"op":1,"d":null})).await;
    time::timeout(Duration::from_secs(5), async {
        loop {
            let frame = socket.next().await.expect("socket ended").unwrap();
            let packet: Value = serde_json::from_str(frame.to_text().unwrap()).unwrap();
            assert_eq!(packet["op"], 1);
            wire(socket, json!({"op":11,"d":null})).await;
            if packet["d"] == sequence {
                break;
            }
        }
    }).await.expect("heartbeat did not acknowledge the queued dispatch");
}

#[tokio::test]
async fn sustained_rest_outage_recovers_without_reconnecting_or_skipping_queued_input() {
    let temporary = Temp::new();
    let store = Arc::new(Store::open(&temporary.0).unwrap());
    let (hub, ws, mut observed, _, server, responses, _) =
        discord_fixture_with_store(json!({"discord":{"requireAddressing":true}}), &store).await;
    let mut socket = start(&hub, &ws, false).await;
    respond(&responses, REFERENCE, StatusCode::SERVICE_UNAVAILABLE, Value::Null);
    dispatch(&mut socket, 3, "MESSAGE_CREATE", reply("202", "held work")).await;
    received(&mut observed, REFERENCE).await;
    dispatch(&mut socket, 4, "MESSAGE_CREATE", mention("203", "<@71> next work")).await;
    for attempt in 2..=7 {
        let (path, _) = time::timeout(Duration::from_secs(15), observed.recv())
            .await.unwrap_or_else(|_| panic!("REST lookup stopped retrying at attempt {attempt}"))
            .unwrap();
        assert_eq!(path, REFERENCE);
    }
    assert_checkpoint(&mut socket, 4).await;
    assert_eq!(store.pending().unwrap(), 0);
    respond(&responses, REFERENCE, StatusCode::OK, bot_message());
    time::timeout(Duration::from_secs(25), hub.changed.notified()).await.unwrap();
    assert_eq!(event(&hub, &store).await["input"]["messageId"], "202");
    assert_eq!(event(&hub, &store).await["input"]["messageId"], "203");
    assert!(journal(&temporary).is_empty());
    hub.stop().await.unwrap();
    server.abort();
}

#[tokio::test]
async fn restart_keeps_checkpointed_owner_candidates_in_order_even_on_unseen_thread_and_dm() {
    let temporary = Temp::new();
    let store = Arc::new(Store::open(&temporary.0).unwrap());
    let (hub, ws, mut observed, _, server, responses, _) =
        discord_fixture_with_store(json!({"discord":{"requireAddressing":true}}), &store).await;
    let mut socket = start(&hub, &ws, false).await;
    respond(&responses, REFERENCE, StatusCode::TOO_MANY_REQUESTS, json!({"retry_after":300.0}));
    let mut held = reply("202", "first source without a history cursor");
    held["unrelated_payload"] = json!({"token":"do not record unrelated wire fields"});
    dispatch(&mut socket, 3, "MESSAGE_CREATE", held).await;
    received(&mut observed, REFERENCE).await;
    let thread = message("203", Some("77"), "92", "42", "first work in unseen thread");
    let dm = message("204", None, "99", "42", "first work in unseen DM");
    dispatch(&mut socket, 4, "MESSAGE_CREATE", thread.clone()).await;
    dispatch(&mut socket, 5, "MESSAGE_CREATE", dm.clone()).await;
    assert_checkpoint(&mut socket, 5).await;
    assert_eq!(store.pending().unwrap(), 0);
    let pending = journal(&temporary);
    assert_eq!(pending.len(), 3);
    assert!(!pending[0].contains("do not record unrelated wire fields"));
    assert!(!pending[1].contains("first work in unseen thread"));
    assert!(!pending[2].contains("first work in unseen DM"));
    hub.stop().await.unwrap();
    server.abort();
    drop(hub);
    drop(store);

    // Disabling addressing must not authorize the still-unadmitted reply.
    let store = Arc::new(Store::open(&temporary.0).unwrap());
    let (hub, ws, _, _, server, responses, _) =
        discord_fixture_with_store(json!({"discord":{"requireAddressing":false}}), &store).await;
    respond(&responses, REFERENCE, StatusCode::OK, bot_message());
    respond(&responses, "/channels/92", StatusCode::OK,
        json!({"id":"92","guild_id":"77","type":11,"parent_id":"88","owner_id":"71"}));
    respond(&responses, "/channels/92/messages/203", StatusCode::OK, thread);
    respond(&responses, "/channels/99/messages/204", StatusCode::OK, dm);
    let mut socket = start(&hub, &ws, false).await;
    dispatch(&mut socket, 3, "MESSAGE_CREATE", owner("205", "post-restart work")).await;
    let first = event(&hub, &store).await;
    assert_eq!(first["input"]["messageId"], "202");
    assert_eq!(first["input"]["reply"]["authorId"], "71");
    let thread = event(&hub, &store).await;
    assert_eq!(thread["input"]["messageId"], "203");
    assert_eq!(thread["input"]["route"]["threadId"], "92");
    let dm = event(&hub, &store).await;
    assert_eq!(dm["input"]["messageId"], "204");
    assert_eq!(dm["input"]["route"]["channelId"], "99");
    assert!(dm["input"]["route"]["guildId"].is_null());
    assert_eq!(event(&hub, &store).await["input"]["messageId"], "205");
    assert!(journal(&temporary).is_empty());
    hub.stop().await.unwrap();
    server.abort();
}

#[tokio::test]
async fn a_verified_partial_edit_survives_supersession_after_an_independent_reply_read_fails() {
    let temporary = Temp::new();
    let store = Arc::new(Store::open(&temporary.0).unwrap());
    let config = json!({"discord":{"requireAddressing":true}});
    let (hub, ws, mut observed, _, server, responses, _) =
        discord_fixture_with_store(config.clone(), &store).await;
    let mut socket = start(&hub, &ws, false).await;
    let mut edit = reply("251", "verified first revision");
    edit["attachments"] = json!([]);
    edit["edited_timestamp"] = json!(FIRST_EDIT);
    let resource = "/channels/88/messages/251";
    respond(&responses, resource, StatusCode::OK, edit.clone());
    respond(&responses, REFERENCE, StatusCode::TOO_MANY_REQUESTS, json!({"retry_after":300.0}));
    edit.as_object_mut().unwrap().remove("message_reference");
    dispatch(&mut socket, 3, "MESSAGE_UPDATE", edit.clone()).await;
    received(&mut observed, REFERENCE).await;
    hub.stop().await.unwrap();
    server.abort();
    drop(hub);
    drop(store);

    let store = Arc::new(Store::open(&temporary.0).unwrap());
    let (hub, ws, _, _, server, responses, _) =
        discord_fixture_with_store(config, &store).await;
    edit["edited_timestamp"] = json!("2026-11-21T01:02:04.456000+00:00");
    edit["content"] = json!("must not substitute the latest revision");
    respond(&responses, resource, StatusCode::OK, edit);
    respond(&responses, REFERENCE, StatusCode::OK, bot_message());
    let mut socket = start(&hub, &ws, false).await;
    dispatch(&mut socket, 3, "MESSAGE_CREATE", mention("252", "<@71> after held edit")).await;
    let edit = event(&hub, &store).await["input"].clone();
    assert_eq!(edit["messageId"], "251");
    assert_eq!(edit["text"], "verified first revision");
    assert_eq!(edit["receivedAt"], FIRST_EDIT_MS);
    assert_eq!(edit["reply"]["authorId"], "71");
    assert_eq!(event(&hub, &store).await["input"]["messageId"], "252");
    assert!(journal(&temporary).is_empty());
    hub.stop().await.unwrap();
    server.abort();
}

#[tokio::test]
async fn authorless_update_journals_no_text_or_urls_and_never_admits_a_foreign_owner() {
    let temporary = Temp::new();
    let store = Arc::new(Store::open(&temporary.0).unwrap());
    let (hub, ws, mut observed, _, server, responses, _) =
        discord_fixture_with_store(json!({"discord":{"requireAddressing":true}}), &store).await;
    let mut socket = start(&hub, &ws, false).await;
    let resource = "/channels/88/messages/261";
    respond(&responses, resource, StatusCode::SERVICE_UNAVAILABLE, Value::Null);
    let secret = "foreign owner text must not appear";
    let url = "https://cdn.discordapp.com/attachments/88/131/foreign.txt?hm=private";
    let mut stranger = mention("261", &format!("<@71> {secret}"));
    stranger["edited_timestamp"] = json!(FIRST_EDIT);
    stranger["attachments"] = json!([{"id":"131","filename":"foreign.txt","size":7,"url":url}]);
    stranger["referenced_message"] = json!({"author":{"id":"43"},"content":"private quote"});
    stranger.as_object_mut().unwrap().remove("author");
    dispatch(&mut socket, 3, "MESSAGE_UPDATE", stranger.clone()).await;
    received(&mut observed, resource).await;
    let pending = journal(&temporary);
    assert_eq!(pending.len(), 1);
    for private in [secret, url, "foreign.txt", "private quote"] {
        assert!(!pending[0].contains(private));
    }
    assert!(hub.effect("fetchAfter", &[parent(), json!("199")]).await.is_err());
    stranger["author"] = json!({"id":"43"});
    stranger.as_object_mut().unwrap().remove("referenced_message");
    respond(&responses, resource, StatusCode::OK, stranger);
    dispatch(&mut socket, 4, "MESSAGE_CREATE", mention("262", "<@71> actual owner")).await;
    assert_eq!(event(&hub, &store).await["input"]["messageId"], "262");
    assert!(journal(&temporary).is_empty());
    hub.stop().await.unwrap();
    server.abort();
}

#[tokio::test]
async fn otherwise_complete_edit_uses_the_verified_rest_timestamp_when_wire_omits_it() {
    let temporary = Temp::new();
    let store = Arc::new(Store::open(&temporary.0).unwrap());
    let (hub, ws, _, _, server, responses, _) =
        discord_fixture_with_store(json!({"discord":{"requireAddressing":true}}), &store).await;
    let mut socket = start(&hub, &ws, false).await;
    let mut edit = mention("271", "<@71> same revision");
    edit["attachments"] = json!([]);
    let mut found = edit.clone();
    found["edited_timestamp"] = json!(FIRST_EDIT);
    respond(&responses, "/channels/88/messages/271", StatusCode::OK, found);
    dispatch(&mut socket, 3, "MESSAGE_UPDATE", edit).await;
    dispatch(&mut socket, 4, "MESSAGE_CREATE", mention("272", "<@71> sentinel")).await;
    let input = event(&hub, &store).await["input"].clone();
    assert_eq!(input["messageId"], "271");
    assert_eq!(input["text"], "same revision");
    assert_eq!(input["receivedAt"], FIRST_EDIT_MS);
    assert!(input["id"].as_str().unwrap().starts_with("discord:71:271:edit:1795222923456:"));
    assert_eq!(event(&hub, &store).await["input"]["messageId"], "272");
    hub.stop().await.unwrap();
    server.abort();
}
