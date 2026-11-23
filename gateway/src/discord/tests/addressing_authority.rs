use super::{
    *,
    addressing_recovery_tests::{assert_checkpoint, journal},
    addressing_tests::{bot_message, mention, owner, parent, reply, respond, start},
};

const REPLY_LOOKUP: &str = "/channels/88/messages/111";
const HISTORY: &str = "/channels/88/messages?after=199&limit=100";
const EDIT: &str = "2026-11-21T01:02:03.456000+00:00";

#[tokio::test]
async fn restart_cannot_promote_unresolved_thread_to_owner_after_policy_changes() {
    let ordinary = json!({"discord":{"requireAddressing":true,"allowedChannelIds":["88","89"]}});
    for old_policy in [
        json!({"discord":{"requireAddressing":true,"allowedChannelIds":["88","89"]},
            "groupRooms":[{"platform":"discord","guildId":"77","channelId":"89",
                "userIds":["42"],"mode":"work","revision":"live","dailyLimit":1}]}),
        json!({"discord":{"requireAddressing":true,"allowedChannelIds":["88"]}}),
    ] {
        let temporary = Temp::new();
        let store = Arc::new(Store::open(&temporary.0).unwrap());
        let (hub, ws, mut observed, _, server, responses, _) =
            discord_fixture_with_store(old_policy, &store).await;
        let mut socket = start(&hub, &ws, false).await;
        respond(&responses, REPLY_LOOKUP, StatusCode::TOO_MANY_REQUESTS, json!({"retry_after":300}));
        dispatch(&mut socket, 3, "MESSAGE_CREATE", reply("202", "verified after restart")).await;
        received(&mut observed, REPLY_LOOKUP).await;
        let unresolved = message("203", Some("77"), "92", "42", "/restart");
        dispatch(&mut socket, 4, "MESSAGE_CREATE", unresolved.clone()).await;
        assert_checkpoint(&mut socket, 4).await;
        assert_eq!(journal(&temporary).len(), 2);
        hub.stop().await.unwrap();
        server.abort();
        drop(hub);
        drop(store);

        let store = Arc::new(Store::open(&temporary.0).unwrap());
        let (hub, ws, _, _, server, responses, _) =
            discord_fixture_with_store(ordinary.clone(), &store).await;
        respond(&responses, REPLY_LOOKUP, StatusCode::OK, bot_message());
        respond(&responses, "/channels/92", StatusCode::OK,
            json!({"id":"92","type":11,"guild_id":"77","parent_id":"89","owner_id":"71"}));
        respond(&responses, "/channels/92/messages/203", StatusCode::OK, unresolved);
        let mut socket = start(&hub, &ws, false).await;
        dispatch(&mut socket, 3, "MESSAGE_CREATE", mention("204", "<@71> allowed work")).await;
        assert_eq!(event(&hub, &store).await["input"]["messageId"], "202");
        assert_eq!(event(&hub, &store).await["input"]["messageId"], "204");
        assert!(journal(&temporary).is_empty());
        hub.stop().await.unwrap();
        server.abort();
    }
}

#[tokio::test]
async fn content_only_updates_outside_addressing_hydrate_without_journaling_unverified_text() {
    for (addressing, guild, channel) in [(false, Some("77"), "88"), (true, None, "99")] {
        let temporary = Temp::new();
        let store = Arc::new(Store::open(&temporary.0).unwrap());
        let (hub, ws, mut observed, _, server, responses, _) =
            discord_fixture_with_store(json!({"discord":{"requireAddressing":addressing}}), &store).await;
        let mut socket = start(&hub, &ws, false).await;
        let resource = format!("/channels/{channel}/messages/231");
        respond(&responses, &resource, StatusCode::SERVICE_UNAVAILABLE, Value::Null);
        dispatch(&mut socket, 3, "MESSAGE_UPDATE",
            json!({"id":"231","channel_id":channel,"content":"sparse owner edit"})).await;
        received(&mut observed, &resource).await;
        let rows = journal(&temporary);
        assert_eq!(rows.len(), 1);
        assert!(!rows[0].contains("sparse owner edit"));
        let mut hydrated = message("231", guild, channel, "42", "sparse owner edit");
        hydrated["edited_timestamp"] = json!(EDIT);
        respond(&responses, &resource, StatusCode::OK, hydrated);
        let input = event(&hub, &store).await["input"].clone();
        assert_eq!(input["messageId"], "231");
        assert_eq!(input["text"], "sparse owner edit");
        assert_eq!(input["receivedAt"], 1_795_222_923_456_i64);
        assert!(journal(&temporary).is_empty());
        hub.stop().await.unwrap();
        server.abort();
    }
}

#[tokio::test]
async fn authorless_attachment_revisions_ignore_only_discord_cdn_signatures() {
    let temporary = Temp::new();
    let store = Arc::new(Store::open(&temporary.0).unwrap());
    let (hub, ws, _, _, server, responses, _) =
        discord_fixture_with_store(json!({"discord":{"requireAddressing":true}}), &store).await;
    let mut socket = start(&hub, &ws, false).await;
    for (sequence, id, observed_url) in [
        (3, "241", "https://cdn.discordapp.com/attachments/88/131/file.txt?format=png&ex=new&width=20&hm=signature"),
        (4, "242", "https://cdn.discordapp.com/attachments/88/131/file.txt?format=png&ex=new&width=30"),
        (5, "243", "https://cdn.discordapp.com/attachments/88/131/file.txt?format=png&ex=new&width=20#changed"),
        (6, "244", "https://media.discordapp.net/attachments/88/131/file.txt?format=png&ex=new&width=20"),
        (7, "245", "https://cdn.discordapp.com/attachments/88/131/different.txt?format=png&ex=new&width=20"),
    ] {
        let mut found = mention(id, "<@71> exact attachment");
        found["edited_timestamp"] = json!(EDIT);
        found["attachments"] = json!([{"id":"131","filename":"file.txt","size":7,"url":observed_url}]);
        let mut wire = found.clone();
        wire["attachments"][0]["url"] = json!("https://cdn.discordapp.com/attachments/88/131/file.txt?width=20&is=before&hm=old&format=png");
        wire.as_object_mut().unwrap().remove("author");
        respond(&responses, &format!("/channels/88/messages/{id}"), StatusCode::OK, found);
        dispatch(&mut socket, sequence, "MESSAGE_UPDATE", wire).await;
    }
    dispatch(&mut socket, 8, "MESSAGE_CREATE", mention("246", "<@71> sentinel")).await;
    let accepted = event(&hub, &store).await["input"].clone();
    assert_eq!(accepted["messageId"], "241");
    assert_eq!(accepted["attachments"][0]["url"],
        "https://cdn.discordapp.com/attachments/88/131/file.txt?format=png&ex=new&width=20&hm=signature");
    assert_eq!(event(&hub, &store).await["input"]["messageId"], "246");
    hub.stop().await.unwrap();
    server.abort();
}

#[tokio::test]
async fn legacy_voice_confirmation_is_excluded_after_voice_is_disabled_or_moved() {
    for moved in [false, true] {
        let temporary = Temp::new();
        let store = Arc::new(Store::open(&temporary.0).unwrap());
        let mut config = json!({"discord":{"allowedChannelIds":["88","89"]}});
        if moved {
            config["discord"]["voice"] = json!({"channelId":"150","textChannelId":"89",
                "voice":"alloy","maxSessionSeconds":60,"auth":"subscription"});
        }
        store.admit(&json!({"kind":"message","input":{
            "id":"discord:71:251:original","messageId":"251","route":parent(),
            "attachments":[],"receivedAt":1_420_070_400_000_i64,
            "text":format!("{CONFIRMED_VOICE_DRAFT_PREFIX}legacy draft body")
        }})).unwrap();
        let receipt = store.next(None).unwrap().unwrap();
        store.receipt(receipt.sequence, GatewayReceipt::Accepted).unwrap();
        let (hub, ws, observed, _, server, responses, _) =
            discord_fixture_with_store(config, &store).await;
        let mut socket = start(&hub, &ws, moved).await;
        let confirm = reply("251", "/voice confirm");
        let sentinel = owner("252", "ordinary work after legacy control");
        respond(&responses, HISTORY, StatusCode::OK, json!([confirm, sentinel]));
        let args = [parent(), json!("199")];
        let caught_up = hub.effect("fetchAfter", &args).await.unwrap();
        assert_eq!(caught_up.as_array().unwrap().len(), 1);
        assert_eq!(caught_up[0]["messageId"], "252");
        dispatch(&mut socket, 3, "MESSAGE_CREATE", confirm).await;
        dispatch(&mut socket, 4, "MESSAGE_CREATE", sentinel).await;
        assert_eq!(event(&hub, &store).await["input"]["messageId"], "252");
        assert!(observed.is_empty());

        // No provenance exception for a non-reply at the same physical ID.
        respond(&responses, HISTORY, StatusCode::OK, json!([owner("251", "/voice confirm")]));
        assert!(hub.effect("fetchAfter", &args).await.is_err());
        hub.stop().await.unwrap();
        server.abort();
    }
}

#[tokio::test]
async fn discord_history_returns_null_only_for_definitive_destination_absence() {
    let temporary = Temp::new();
    let store = Arc::new(Store::open(&temporary.0).unwrap());
    let (hub, ws, _, _, server, responses, _) =
        discord_fixture_with_store(json!({"discord":{"requireAddressing":true}}), &store).await;
    let _socket = start(&hub, &ws, false).await;
    let args = [parent(), json!("199")];
    respond(&responses, HISTORY, StatusCode::NOT_FOUND, json!({"code":10008}));
    assert!(hub.effect("fetchAfter", &args).await.is_err());
    respond(&responses, HISTORY, StatusCode::OK, json!([
        reply("202", "first work"), mention("203", "<@71> later work")
    ]));
    respond(&responses, REPLY_LOOKUP, StatusCode::SERVICE_UNAVAILABLE, Value::Null);
    assert!(hub.effect("fetchAfter", &args).await.is_err());
    respond(&responses, REPLY_LOOKUP, StatusCode::NOT_FOUND, json!({"code":10003}));
    let reply_absence = hub.effect("fetchAfter", &args).await.unwrap();
    assert_eq!(reply_absence.as_array().unwrap().len(), 1);
    assert_eq!(reply_absence[0]["messageId"], "203");

    respond(&responses, HISTORY, StatusCode::NOT_FOUND, json!({"code":10003}));
    assert!(hub.effect("fetchAfter", &args).await.unwrap().is_null());
    let mut uncached_thread = parent();
    uncached_thread["threadId"] = json!("92");
    respond(&responses, "/channels/92", StatusCode::NOT_FOUND, json!({"code":10003}));
    assert!(hub.effect("fetchAfter", &[uncached_thread, json!("199")]).await.unwrap().is_null());
    hub.stop().await.unwrap();
    server.abort();
}
