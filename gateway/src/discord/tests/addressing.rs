use super::*;
use ::time::{OffsetDateTime, format_description::well_known::Rfc3339};
use rusqlite::{Connection, params};

pub(super) fn parent() -> Value {
    json!({"platform":"discord","accountId":"71","authorityId":"42",
        "guildId":"77","channelId":"88","threadId":null})
}

pub(super) fn owner(id: &str, text: &str) -> Value {
    message(id, Some("77"), "88", "42", text)
}

pub(super) fn mention(id: &str, text: &str) -> Value {
    let mut raw = owner(id, text);
    raw["mentions"] = json!([{"id":"71","bot":true}]);
    raw
}

pub(super) fn reply(id: &str, text: &str) -> Value {
    let mut raw = owner(id, text);
    raw["type"] = json!(19);
    raw["message_reference"] = json!({"message_id":"111","channel_id":"88","guild_id":"77"});
    raw
}

pub(super) fn bot_message() -> Value {
    json!({"id":"111","channel_id":"88","guild_id":"77",
        "author":{"id":"71","bot":true},"content":"previous bot response"})
}

const HISTORY: &str = "/channels/88/messages?after=199&limit=100";

pub(super) fn respond(responses: &Responses, path: &str, status: StatusCode, value: Value) {
    responses.lock().unwrap().insert(path.to_owned(), (status, value));
}

pub(super) async fn start(hub: &Hub, ws: &TcpListener, voice: bool) -> FixtureSocket {
    let (started, mut socket) = time::timeout(Duration::from_secs(5), async {
        tokio::join!(hub.start(), identify(ws, voice))
    }).await.unwrap();
    started.unwrap();
    hub.ready.send_replace(true);
    dispatch(&mut socket, 2, "GUILD_CREATE", json!({
        "id":"77","channels":[{"id":"88","type":0,"topic":null},{"id":"89","type":0}],
        "threads":[{"id":"90","type":11,"parent_id":"88","owner_id":"71"},{"id":"91","type":11,"parent_id":"89"},
            {"id":"93","type":11,"parent_id":"88","owner_id":"73"}],
        "voice_states":[]
    })).await;
    socket
}

#[tokio::test]
async fn live_addressing_requires_exact_bot_proof_only_in_authorized_parents() {
    let temporary = Temp::new();
    let store = Arc::new(Store::open(&temporary.0).unwrap());
    let (hub, ws, mut observed, _, server, responses, _) =
        discord_fixture_with_store(json!({"discord":{"requireAddressing":true}}), &store).await;
    let mut socket = start(&hub, &ws, false).await;

    let mut checked_reply = reply("220", "first edit, with a verified reply");
    checked_reply["referenced_message"] = bot_message();
    checked_reply["attachments"] = json!([]);
    checked_reply["edited_timestamp"] = json!("2026-11-21T01:02:03.456000+00:00");
    respond(&responses, "/channels/88/messages/220", StatusCode::OK, json!({
        "id":"220","channel_id":"88","author":{"id":"42"},"type":0,
        "content":"newer REST revision","edited_timestamp":"2026-11-21T01:02:04.456000+00:00"
    }));
    let mut foreign_reply = reply("207", "unsupported author");
    foreign_reply["referenced_message"] = bot_message();
    foreign_reply["referenced_message"]["author"]["id"] = json!("73");
    let mut crossed_reply = reply("208", "wrong channel");
    crossed_reply["referenced_message"] = bot_message();
    crossed_reply["referenced_message"]["channel_id"] = json!("90");
    let mut wrong_kind = reply("209", "forwarded, not replied");
    wrong_kind["referenced_message"] = bot_message();
    wrong_kind["message_reference"]["type"] = json!(1);
    let mut webhook_reply = reply("210", "webhook author");
    webhook_reply["referenced_message"] = bot_message();
    webhook_reply["referenced_message"]["webhook_id"] = json!("111");
    let unauthorized = message("211", Some("77"), "91", "42", "private unauthorized thread");
    let mut stranger = mention("212", "<@71> stray user");
    stranger["author"]["id"] = json!("43");
    let mut dm = mention("225", "DM keeps <@71> text");
    dm["channel_id"] = json!("99");
    dm.as_object_mut().unwrap().remove("guild_id");
    let mut file = mention("224", " <@71> ");
    file["attachments"] = json!([{"id":"131","filename":"file.txt","size":7,
        "url":"https://cdn.discordapp.com/attachments/88/131/file.txt"}]);
    let mut thread = mention("223", "<@71> addressed thread");
    thread["channel_id"] = json!("90");
    let mut foreign_thread = mention("227", "<@71> addressed foreign thread");
    foreign_thread["channel_id"] = json!("93");

    for (index, (kind, raw)) in [
        ("MESSAGE_CREATE", owner("201", "plain parent chat")),
        ("MESSAGE_CREATE", owner("202", "<@71> tag lacking metadata")),
        ("MESSAGE_CREATE", mention("203", "mention metadata with no token")),
        ("MESSAGE_CREATE", mention("204", r"ignore `<@71>` and \<@71>")),
        ("MESSAGE_CREATE", mention("205", "``code `<@71>` code``\n` unmatched\n```\n` <@71>\n````")),
        ("MESSAGE_CREATE", mention("206", "<@71>")),
        ("MESSAGE_CREATE", foreign_reply),
        ("MESSAGE_CREATE", crossed_reply),
        ("MESSAGE_CREATE", wrong_kind),
        ("MESSAGE_CREATE", webhook_reply),
        ("MESSAGE_CREATE", unauthorized),
        ("MESSAGE_CREATE", stranger),
        ("MESSAGE_CREATE", mention("213", "<@71> /voice confirm")),
        ("MESSAGE_CREATE", mention("218", r"unfinished ` code? <@!71> review \<@71>")),
        ("MESSAGE_CREATE", mention("219", "/sta<@71>tus `<@71>`")),
        ("MESSAGE_UPDATE", checked_reply),
        ("MESSAGE_CREATE", message("222", Some("77"), "90", "42", "unaddressed thread")),
        ("MESSAGE_CREATE", thread),
        ("MESSAGE_CREATE", message("226", Some("77"), "93", "42", "unaddressed foreign thread")),
        ("MESSAGE_CREATE", foreign_thread),
        ("MESSAGE_CREATE", file),
        ("MESSAGE_CREATE", dm),
    ].into_iter().enumerate() {
        dispatch(&mut socket, 3 + u64::try_from(index).unwrap(), kind, raw).await;
    }
    let unconfigured_voice = event(&hub, &store).await["input"].clone();
    assert_eq!(unconfigured_voice["messageId"], "213");
    assert_eq!(unconfigured_voice["text"], "<@71> /voice confirm");
    assert!(unconfigured_voice.get("discordOriginalText").is_none());
    let first = event(&hub, &store).await["input"].clone();
    assert_eq!(first["messageId"], "218");
    assert_eq!(first["text"], r"unfinished ` code?  review \<@71>");
    assert_eq!(first["discordOriginalText"], r"unfinished ` code? <@!71> review \<@71>");
    let split = event(&hub, &store).await;
    assert_eq!(split["input"]["text"], "/sta tus `<@71>`");
    let edit = event(&hub, &store).await;
    assert_eq!(edit["input"]["messageId"], "220");
    assert_eq!(edit["input"]["receivedAt"], 1_795_222_923_456_i64);
    assert_eq!(edit["input"]["text"], "first edit, with a verified reply");
    assert_eq!(edit["input"]["reply"], json!({"messageId":"111","authorId":"71","text":"previous bot response"}));
    for (id, text) in [("222", "unaddressed thread"), ("223", "addressed thread")] {
        let input = event(&hub, &store).await["input"].clone();
        assert_eq!(input["route"]["channelId"], "88");
        assert_eq!(input["route"]["threadId"], "90");
        assert_eq!(input["messageId"], id);
        assert_eq!(input["text"], text);
    }
    let foreign = event(&hub, &store).await["input"].clone();
    assert_eq!(foreign["route"]["threadId"], "93");
    assert_eq!(foreign["messageId"], "227");
    assert_eq!(foreign["text"], "addressed foreign thread");
    let file = event(&hub, &store).await;
    assert_eq!(file["input"]["text"], "");
    assert_eq!(file["input"]["attachments"][0]["id"], "131");
    let dm = event(&hub, &store).await;
    assert_eq!(dm["input"]["text"], "DM keeps <@71> text");
    assert!(dm["input"].get("discordOriginalText").is_none());

    let mut slash = interaction("550", 2, json!({"type":1,"name":"status"}));
    slash["guild_id"] = json!("77");
    slash["channel"]["id"] = json!("88");
    slash["member"] = json!({"user":{"id":"42"}});
    dispatch(&mut socket, 25, "INTERACTION_CREATE", slash).await;
    received(&mut observed, "/interactions/550/offline-interaction/callback").await;
    let status = event(&hub, &store).await;
    assert_eq!(status["input"]["text"], "/status");
    assert_eq!(status["input"]["interactionId"], "550");
    assert_eq!(store.pending().unwrap(), 0);
    hub.stop().await.unwrap();
    server.abort();
}

#[tokio::test]
async fn retryable_reply_lookup_prevents_catchup_from_exposing_later_messages() {
    let temporary = Temp::new();
    let store = Arc::new(Store::open(&temporary.0).unwrap());
    let (hub, ws, _, _, server, responses, _) =
        discord_fixture_with_store(json!({"discord":{"requireAddressing":true}}), &store).await;
    let _socket = start(&hub, &ws, false).await;
    let mut deleted = reply("200", "deleted referenced message");
    deleted["message_reference"]["message_id"] = json!("112");
    respond(&responses, "/channels/88/messages/112", StatusCode::NOT_FOUND, json!({"code":10008}));
    respond(&responses, HISTORY, StatusCode::OK, json!([
        mention("203", "<@71> later work"), reply("202", "reply without embedded material"), deleted,
    ]));
    let args = [parent(), json!("199")];
    for status in [StatusCode::TOO_MANY_REQUESTS, StatusCode::SERVICE_UNAVAILABLE] {
        respond(&responses, "/channels/88/messages/111", status, json!({"retry_after":0.1}));
        assert!(hub.effect("fetchAfter", &args).await.is_err());
    }
    let mut crossed_source = bot_message();
    crossed_source["guild_id"] = json!("78");
    respond(&responses, "/channels/88/messages/111", StatusCode::OK, crossed_source);
    assert!(hub.effect("fetchAfter", &args).await.is_err());
    respond(&responses, "/channels/88/messages/111", StatusCode::OK, bot_message());
    let recovered = hub.effect("fetchAfter", &args).await.unwrap();
    assert_eq!(recovered.as_array().unwrap().iter().map(|input| &input["messageId"])
        .collect::<Vec<_>>(), [&json!("202"), &json!("203")]);
    assert_eq!(recovered[0]["reply"]["authorId"], "71");
    assert_eq!(recovered[1]["text"], "later work");
    hub.stop().await.unwrap();
    server.abort();
}

#[tokio::test]
async fn catchup_preserves_gateway_and_head_only_admissions_across_policy_changes() {
    let temporary = Temp::new();
    let store = Arc::new(Store::open(&temporary.0).unwrap());
    let (hub, ws, _, _, server, _, _) = discord_fixture_with_store(json!({"discord":{}}), &store).await;
    let mut socket = start(&hub, &ws, false).await;
    let legacy = mention("201", "<@71> admitted before opt-in");
    let bare = owner("202", "bare but previously admitted");
    for (sequence, raw) in [(3, legacy.clone()), (4, bare.clone())] {
        dispatch(&mut socket, sequence, "MESSAGE_CREATE", raw).await;
    }
    let old = event(&hub, &store).await["input"].clone();
    assert_eq!(old["text"], "<@71> admitted before opt-in");
    assert_eq!(event(&hub, &store).await["input"]["messageId"], "202");
    hub.stop().await.unwrap();
    server.abort();

    let (hub, ws, _, _, server, responses, _) =
        discord_fixture_with_store(json!({"discord":{"requireAddressing":true}}), &store).await;
    let mut socket = start(&hub, &ws, false).await;
    let mut head_only = mention("203", "<@71> caught up while enabled");
    head_only["attachments"] = json!([{"id":"131","filename":"file.txt","size":7,
        "url":"https://cdn.discordapp.com/attachments/88/131/file.txt?ex=before"}]);
    let live = mention("204", "<@71> live while enabled");
    respond(&responses, HISTORY, StatusCode::OK, json!([legacy, bare, head_only]));
    let args = [parent(), json!("199")];
    let caught_up = hub.effect("fetchAfter", &args).await.unwrap();
    assert_eq!(caught_up[0], old);
    assert_eq!(caught_up[1]["text"], "bare but previously admitted");
    assert_eq!(caught_up[2]["text"], "caught up while enabled");
    assert_eq!(caught_up[2]["discordOriginalText"], "<@71> caught up while enabled");
    // This adapter effect returns directly to the head; the head, not the
    // Gateway, is the durable owner of this catch-up-only admission.
    let head = Connection::open(temporary.0.join("coordination.sqlite")).unwrap();
    head.execute_batch("CREATE TABLE inputs (id TEXT PRIMARY KEY, data TEXT NOT NULL);").unwrap();
    let source_id = caught_up[2]["id"].as_str().unwrap();
    head.execute("INSERT INTO inputs (id,data) VALUES (?,?)",
        params![source_id, caught_up[2].to_string()]).unwrap();
    head.execute("INSERT INTO metadata (key,value) VALUES (?,'true')",
        [format!("user-source:{source_id}")]).unwrap();

    dispatch(&mut socket, 3, "MESSAGE_CREATE", live.clone()).await;
    let saved_live = event(&hub, &store).await["input"].clone();
    assert_eq!(saved_live["text"], "live while enabled");
    hub.stop().await.unwrap();
    server.abort();

    let (hub, ws, _, _, server, responses, _) =
        discord_fixture_with_store(json!({"discord":{"requireAddressing":false}}), &store).await;
    let mut socket = start(&hub, &ws, false).await;
    let location = "https://cdn.discordapp.com/attachments/88/131/file.txt?ex=refreshed";
    head_only["attachments"][0]["url"] = json!(location);
    respond(&responses, HISTORY, StatusCode::OK, json!([head_only, live]));
    let replay = hub.effect("fetchAfter", &args).await.unwrap();
    assert_eq!(replay[0]["text"], "caught up while enabled");
    assert_eq!(replay[0]["discordOriginalText"], "<@71> caught up while enabled");
    assert_eq!(replay[0]["attachments"][0]["url"], location);
    assert_eq!(replay[1], saved_live);
    dispatch(&mut socket, 3, "MESSAGE_CREATE", live).await;
    dispatch(&mut socket, 4, "MESSAGE_CREATE", head_only.clone()).await;
    assert_eq!(event(&hub, &store).await["input"], replay[0]);

    // Text that happens to normalize to the same projection is not the
    // identical source, and cannot cause a catch-up cursor to move.
    head_only["content"] = json!("<@!71> caught up while enabled");
    respond(&responses, HISTORY, StatusCode::OK, json!([head_only]));
    assert!(hub.effect("fetchAfter", &args).await.is_err());
    hub.stop().await.unwrap();
    server.abort();
}

#[tokio::test]
async fn normalized_voice_controls_are_live_only_and_confirmation_requires_the_draft() {
    let temporary = Temp::new();
    let store = Arc::new(Store::open(&temporary.0).unwrap());
    let (hub, ws, mut observed, _, server, responses, _) = discord_fixture_with_store(json!({
        "discord":{"requireAddressing":true,"voice":{"channelId":"150","textChannelId":"88",
            "voice":"alloy","maxSessionSeconds":60,"auth":"subscription"}}
    }), &store).await;
    let mut socket = start(&hub, &ws, true).await;
    // The voice service checks freshness and monotonic source IDs, not the
    // WebSocket sequence. Use actual current Discord-style snowflakes.
    let now = OffsetDateTime::now_utc();
    let base = (u64::try_from(now.unix_timestamp_nanos() / 1_000_000).unwrap() - 1_420_070_400_000) << 22;
    let stamp = now.format(&Rfc3339).unwrap();
    let mut confirm = reply(&(base + 1).to_string(), "<@71> /voice confirm");
    confirm["mentions"] = json!([{"id":"71","bot":true}]);
    confirm["timestamp"] = json!(stamp);
    confirm["referenced_message"] = bot_message();
    let mut revoke = mention(&(base + 2).to_string(), "/voice work off <@71>");
    revoke["timestamp"] = json!(stamp);
    let mut stop = mention(&(base + 3).to_string(), "/voice stop <@71>");
    stop["timestamp"] = json!(stamp);
    respond(&responses, HISTORY, StatusCode::OK, json!([confirm, stop, mention("205", "<@71> ordinary")]));
    dispatch(&mut socket, 3, "MESSAGE_CREATE", message("155", None, "99", "42", "ready")).await;
    assert_eq!(event(&hub, &store).await["input"]["messageId"], "155");
    let catchup = hub.effect("fetchAfter", &[parent(), json!("199")]).await.unwrap();
    assert_eq!(catchup.as_array().unwrap().len(), 1);
    assert_eq!(catchup[0]["text"], "ordinary");
    dispatch(&mut socket, 4, "MESSAGE_CREATE", confirm).await;
    let refused = received(&mut observed, "/channels/88/messages").await;
    assert!(refused["content"].as_str().unwrap().starts_with("No matching active voice draft"));
    // Position both priority controls behind a held ordinary candidate: they
    // must execute on the socket path, not wait for read-only REST evidence.
    respond(&responses, "/channels/88/messages/111", StatusCode::TOO_MANY_REQUESTS,
        json!({"retry_after":300.0}));
    dispatch(&mut socket, 5, "MESSAGE_CREATE", reply("206", "waiting on evidence")).await;
    received(&mut observed, "/channels/88/messages/111").await;
    dispatch(&mut socket, 6, "MESSAGE_CREATE", revoke).await;
    assert_eq!(received(&mut observed, "/channels/88/messages").await["content"],
        "Voice work drafts are off. Unconfirmed drafts can no longer be submitted.");
    dispatch(&mut socket, 7, "MESSAGE_CREATE", stop).await;
    assert_eq!(received(&mut observed, "/channels/88/messages").await["content"], "Voice is off.");
    assert_eq!(store.pending().unwrap(), 0);
    hub.stop().await.unwrap();
    server.abort();
}

#[tokio::test]
async fn partial_reply_edits_hydrate_only_the_exact_revision_for_missing_mentions() {
    let temporary = Temp::new();
    let store = Arc::new(Store::open(&temporary.0).unwrap());
    let (hub, ws, _, _, server, responses, _) =
        discord_fixture_with_store(json!({"discord":{"requireAddressing":true}}), &store).await;
    let mut socket = start(&hub, &ws, false).await;
    for (raw_id, stamp, content) in [
        ("251", "2026-11-21T01:02:03.456000+00:00", "<@71> check the exact revision"),
        ("252", "2026-11-21T01:02:03.456500+00:00", "<@71> check the exact revision"),
        ("253", "2026-11-21T01:02:03.456000+00:00", "<@71> differs at the same time"),
    ] {
        let mut raw = reply(raw_id, "<@71> check the exact revision");
        raw["attachments"] = json!([]);
        raw["edited_timestamp"] = json!("2026-11-21T01:02:03.456000+00:00");
        raw["referenced_message"] = bot_message();
        raw["referenced_message"]["author"] = json!({"id":"19"});
        let mut rest = raw.clone();
        rest["content"] = json!(content);
        rest["edited_timestamp"] = json!(stamp);
        rest["mentions"] = json!([{"id":"71","bot":true}]);
        // The wire event, not the hydrated resource, supplied reference context.
        rest.as_object_mut().unwrap().remove("referenced_message");
        respond(&responses, &format!("/channels/88/messages/{raw_id}"), StatusCode::OK, rest);
        let sequence = raw_id.parse::<u64>().unwrap() - 248;
        dispatch(&mut socket, sequence, "MESSAGE_UPDATE", raw).await;
    }
    dispatch(&mut socket, 6, "MESSAGE_CREATE", mention("254", "<@71> end")).await;
    let first = event(&hub, &store).await["input"].clone();
    assert_eq!(first["messageId"], "251");
    assert_eq!(first["text"], "check the exact revision");
    assert_eq!(first["reply"]["authorId"], "19");
    assert_eq!(event(&hub, &store).await["input"]["messageId"], "254");
    hub.stop().await.unwrap();
    server.abort();
}

#[tokio::test]
async fn live_reply_waits_for_read_only_evidence_before_admitting_later_work() {
    let temporary = Temp::new();
    let store = Arc::new(Store::open(&temporary.0).unwrap());
    let (hub, ws, mut observed, _, server, responses, _) =
        discord_fixture_with_store(json!({"discord":{"requireAddressing":true}}), &store).await;
    let mut socket = start(&hub, &ws, false).await;
    respond(&responses, "/channels/88/messages/111", StatusCode::SERVICE_UNAVAILABLE, Value::Null);
    dispatch(&mut socket, 3, "MESSAGE_CREATE", reply("202", "first work")).await;
    received(&mut observed, "/channels/88/messages/111").await;
    dispatch(&mut socket, 4, "MESSAGE_CREATE", mention("203", "<@71> later work")).await;
    respond(&responses, HISTORY, StatusCode::OK, json!([mention("203", "<@71> later work")]));
    assert!(hub.effect("fetchAfter", &[parent(), json!("199")]).await.is_err());
    respond(&responses, "/channels/88/messages/111", StatusCode::OK, bot_message());
    assert_eq!(event(&hub, &store).await["input"]["messageId"], "202");
    assert_eq!(event(&hub, &store).await["input"]["messageId"], "203");
    hub.stop().await.unwrap();
    server.abort();
}

#[tokio::test]
async fn verified_voice_confirmation_replays_immutable_draft_after_addressing_is_disabled() {
    let temporary = Temp::new();
    let store = Arc::new(Store::open(&temporary.0).unwrap());
    let mut config = json!({"discord":{"requireAddressing":true,"voice":{"channelId":"150",
        "textChannelId":"88","voice":"alloy","maxSessionSeconds":60,"auth":"subscription"}}});
    let (hub, ws, mut observed, _, server, _, state) = discord_fixture_with_store(config.clone(), &store).await;
    let mut socket = start(&hub, &ws, true).await;
    dispatch(&mut socket, 3, "MESSAGE_CREATE", message("155", None, "99", "42", "ready")).await;
    assert_eq!(event(&hub, &store).await["input"]["messageId"], "155");

    let mut confirmations = Vec::new();
    let mut admitted = Vec::new();
    for (index, text) in ["<@71> /voice confirm", "/voice confirm <@71>"].into_iter().enumerate() {
        let work = format!("draft proposal {index}");
        state.voice.as_ref().unwrap().fixture_draft(&work).await.unwrap();
        received(&mut observed, "/channels/88/messages").await;
        let now = OffsetDateTime::now_utc();
        let base = (u64::try_from(now.unix_timestamp_nanos() / 1_000_000).unwrap() - 1_420_070_400_000) << 22;
        let sequence = 4 + u64::try_from(index).unwrap();
        let mut confirm = reply(&(base + sequence).to_string(), text);
        confirm["mentions"] = json!([{"id":"71","bot":true}]);
        confirm["timestamp"] = json!(now.format(&Rfc3339).unwrap());
        confirm["message_reference"]["message_id"] = json!("700");
        dispatch(&mut socket, sequence, "MESSAGE_CREATE", confirm.clone()).await;
        let input = event(&hub, &store).await["input"].clone();
        assert_eq!(input["discordOriginalText"], text);
        assert!(input["text"].as_str().unwrap().ends_with(&work));
        confirmations.push(confirm);
        admitted.push(input);
    }
    hub.stop().await.unwrap();
    server.abort();

    config["discord"]["requireAddressing"] = json!(false);
    let (hub, ws, observed, _, server, responses, _) = discord_fixture_with_store(config, &store).await;
    let _socket = start(&hub, &ws, true).await;
    respond(&responses, HISTORY, StatusCode::OK, json!(confirmations));
    let history = hub.effect("fetchAfter", &[parent(), json!("199")]).await.unwrap();
    assert_eq!(history, json!(admitted));
    assert!(observed.is_empty());
    assert_eq!(store.pending().unwrap(), 0);
    hub.stop().await.unwrap();
    server.abort();
}
