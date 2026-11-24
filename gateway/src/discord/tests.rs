use std::path::PathBuf;
use std::sync::{Arc, Mutex as SyncMutex};
use std::time::Duration;

use axum::{
    Json, Router,
    body::to_bytes,
    extract::{Request, State as AxumState},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::{
    net::{TcpListener, TcpStream},
    sync::mpsc,
    task::JoinHandle,
    time,
};
use tokio_tungstenite::{WebSocketStream, accept_async, tungstenite::Message};

use super::*;
use crate::{
    adapter::Hub,
    store::{GatewayReceipt, Store},
};

#[path = "tests/addressing.rs"]
mod addressing_tests;
#[path = "tests/addressing_authority.rs"]
mod addressing_authority_tests;
#[path = "tests/addressing_recovery.rs"]
mod addressing_recovery_tests;
#[path = "tests/presence.rs"]
mod presence_tests;

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("omp-discord-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path).expect("create isolated Gateway state");
        Self(path)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        if let Err(error) = std::fs::remove_dir_all(&self.0) {
            eprintln!("Could not remove Discord test state: {error}");
        }
    }
}

#[derive(Clone)]
struct RestFixture {
    socket: String,
    emitted: mpsc::UnboundedSender<(String, Value)>,
    last_card: Arc<SyncMutex<Value>>,
    responses: Responses,
}

type Responses = Arc<SyncMutex<HashMap<String, (StatusCode, Value)>>>;

async fn rest(AxumState(fixture): AxumState<RestFixture>, request: Request) -> Response {
    let path = request.uri().path().to_owned();
    let target = request.uri().to_string();
    let method = request.method().as_str().to_owned();
    let authorized = request
        .headers()
        .get("authorization")
        .is_some_and(|value| value == "Bot offline-token");
    let bytes = to_bytes(request.into_body(), 64 * 1024).await.unwrap();
    // A multipart upload is recorded as raw text so its payload_json stays observable.
    let body: Value = serde_json::from_slice(&bytes)
        .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into_owned()));
    if path.starts_with("/interactions/") {
        assert!(
            !authorized,
            "the interaction token does not authorize sending a bot credential"
        );
        fixture.emitted.send((path, body)).unwrap();
        return StatusCode::NO_CONTENT.into_response();
    }
    if !authorized {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if let Some((status, value)) = fixture.responses.lock().unwrap().get(&target) {
        if method == "GET" && (status.is_server_error() || *status == StatusCode::TOO_MANY_REQUESTS) {
            drop(fixture.emitted.send((path, Value::Null)));
        }
        return (*status, Json(value.clone())).into_response();
    }
    let result = match (method.as_str(), path.as_str()) {
        ("GET", "/gateway/bot") => json!({"url": fixture.socket, "shards": 1,
            "session_start_limit":{"total":1000,"remaining":1000,"reset_after":86_400_000_u64,"max_concurrency":1}}),
        ("GET", "/users/@me") => json!({"id":"71","bot":true}),
        ("GET", "/channels/90") => {
            json!({"id":"90", "guild_id":"77", "type":11, "parent_id":"88", "name":"task thread"})
        }
        ("GET", "/channels/90/messages/206") => {
            json!({"id":"206","channel_id":"90","author":{"id":"42"},
            "type":0,"content":"edited by owner", "edited_timestamp":"2026-11-21T01:02:03.456000+00:00"})
        }
        ("GET", "/channels/88") => json!({"id":"88", "guild_id":"77", "type":0}),
        ("POST", "/channels/88/messages") => {
            let stamp = ::time::OffsetDateTime::now_utc()
                .format(&::time::format_description::well_known::Rfc3339).unwrap();
            let result = json!({"id":"700","guild_id":"77","channel_id":"88","author":{"id":"71","bot":true},
                "content":body["content"],"timestamp":stamp});
            fixture.emitted.send((path, body)).unwrap();
            result
        }
        ("GET", "/channels/89") => json!({"id":"89", "guild_id":"77", "type":0}),
        ("POST", "/channels/89/messages") => {
            let nonce = body["nonce"].as_str().unwrap();
            let id = u64::from_str_radix(&nonce[..12], 16).unwrap().to_string();
            fixture.emitted.send((path, body)).unwrap();
            json!({"id":id,"guild_id":"77","channel_id":"89","author":{"id":"71","bot":true}})
        }
        ("POST", "/channels/90/messages") => {
            fixture.emitted.send((path, body)).unwrap();
            json!({"id":"701","guild_id":"77","channel_id":"90","author":{"id":"71","bot":true}})
        }
        ("GET", "/channels/99") => json!({"id":"99", "type":1, "recipients":[{"id":"42"}]}),
        ("GET", "/channels/98") => {
            json!({"id":"98", "type":3, "recipients":[{"id":"42"},{"id":"43"}]})
        }
        ("POST", "/channels/99/messages") => {
            fixture.emitted.send((path, body.clone())).unwrap();
            let content = body["content"].as_str().unwrap_or_default();
            if content == "ambiguous" {
                return StatusCode::SERVICE_UNAVAILABLE.into_response();
            }
            if content.starts_with("reject") {
                return (StatusCode::BAD_REQUEST, Json(json!({"code":50035}))).into_response();
            }
            if content.starts_with("deadline first") {
                time::sleep(Duration::from_secs(12)).await;
            } else if content.starts_with("deadline second") {
                time::sleep(Duration::from_secs(14)).await;
            }
            // Split parts get distinct receipts so the stored first ID is observable.
            let id = content
                .strip_prefix("segment ")
                .and_then(|rest| rest.get(..1))
                .map_or_else(|| "700".to_owned(), |part| format!("80{part}"));
            let mut remote = json!({"id":id, "channel_id":"99", "author":{"id":"71","bot":true},
                "components":body.get("components").cloned().unwrap_or_else(|| json!([])) });
            if body.as_str().is_some_and(|body| body.contains("filename=\"result.bin\"")) {
                remote["attachments"] = json!([{"id":"364","filename":"result.bin",
                    "size":4,"url":"https://cdn.discordapp.com/attachments/99/364/result.bin"}]);
            }
            *fixture.last_card.lock().unwrap() = remote.clone();
            remote
        }
        ("GET", "/channels/99/messages/700") => fixture.last_card.lock().unwrap().clone(),
        ("PATCH", "/channels/99/messages/700") => {
            let mut card = fixture.last_card.lock().unwrap();
            if let Some(components) = body.get("components") {
                card["components"] = components.clone();
            }
            fixture.emitted.send((path, body)).unwrap();
            card.clone()
        }
        ("PUT", path) if path.contains("/reactions/") => {
            return StatusCode::NO_CONTENT.into_response();
        }
        _ => return (StatusCode::NOT_FOUND, Json(json!({"code":10003}))).into_response(),
    };
    Json(result).into_response()
}

type FixtureSocket = WebSocketStream<TcpStream>;

async fn wire(ws: &mut FixtureSocket, value: Value) {
    ws.send(Message::Text(value.to_string().into()))
        .await
        .unwrap();
}

async fn dispatch(ws: &mut FixtureSocket, sequence: u64, event: &str, data: Value) {
    wire(ws, json!({"op":0, "s":sequence, "t":event, "d":data})).await;
}

async fn identify(listener: &TcpListener, voice: bool) -> FixtureSocket {
    let (stream, _) = listener.accept().await.unwrap();
    let mut ws = accept_async(stream).await.unwrap();
    wire(&mut ws, json!({"op":10,"d":{"heartbeat_interval":60_000}})).await;
    let identify: Value =
        serde_json::from_str(ws.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
    assert_eq!(identify["op"], 2);
    let intents = identify["d"]["intents"].as_u64().unwrap();
    assert_eq!(
        intents & (1 << 7),
        u64::from(voice) << 7,
        "voice intent must match whether voice is configured"
    );
    assert_eq!(
        intents & (1 | 1 << 9 | 1 << 12 | 1 << 15),
        1 | 1 << 9 | 1 << 12 | 1 << 15
    );
    dispatch(
        &mut ws,
        1,
        "READY",
        json!({"user":{"id":"71","bot":true},
        "application":{"id":"72"}, "session_id":"test-session",
        "resume_gateway_url": format!("ws://{}/", listener.local_addr().unwrap())}),
    )
    .await;
    ws
}

async fn received(emitted: &mut mpsc::UnboundedReceiver<(String, Value)>, expected: &str) -> Value {
    let (path, body) = time::timeout(Duration::from_secs(5), emitted.recv())
        .await
        .expect("Discord REST operation never arrived")
        .expect("Discord REST recorder closed");
    assert_eq!(path, expected);
    body
}

async fn event(hub: &Hub, store: &Store) -> Value {
    time::timeout(Duration::from_secs(5), async {
        loop {
            let changed = hub.changed.notified();
            if let Some(next) = store.next(None).unwrap() {
                store
                    .receipt(next.sequence, GatewayReceipt::Accepted)
                    .unwrap();
                return next.event;
            }
            changed.await;
        }
    })
    .await
    .expect("Discord event was not admitted")
}

fn message(id: &str, guild: Option<&str>, channel: &str, owner: &str, text: &str) -> Value {
    let mut payload =
        json!({"id":id,"channel_id":channel,"author":{"id":owner},"type":0,"content":text});
    if let Some(guild) = guild {
        payload["guild_id"] = json!(guild);
    }
    payload
}

fn interaction(id: &str, kind: u8, data: Value) -> Value {
    json!({"application_id":"72","user":{"id":"42"},"channel":{"id":"99","type":1},
        "token":"offline-interaction","type":kind,"id":id,"data":data})
}

async fn discord_fixture(config: Value) -> (
    Temp, Arc<Store>, Arc<Hub>, TcpListener, mpsc::UnboundedReceiver<(String, Value)>,
    Arc<SyncMutex<Value>>, JoinHandle<()>,
) {
    let temporary = Temp::new();
    let store = Arc::new(Store::open(&temporary.0).unwrap());
    let (hub, ws, observed, last_card, server, _, _) = discord_fixture_with_store(config, &store).await;
    (temporary, store, hub, ws, observed, last_card, server)
}

async fn discord_fixture_with_store(mut config: Value, store: &Arc<Store>) -> (
    Arc<Hub>, TcpListener, mpsc::UnboundedReceiver<(String, Value)>,
    Arc<SyncMutex<Value>>, JoinHandle<()>, Responses, Arc<State>,
) {
    let policy = config["discord"].as_object_mut().unwrap();
    for (key, value) in [
        ("ownerId", json!("42")),
        ("allowedGuildIds", json!(["77"])),
        ("allowedChannelIds", json!(["88"])),
    ] {
        policy.entry(key).or_insert(value);
    }
    let ws = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let http = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let api = format!("http://{}", http.local_addr().unwrap());
    let (emitted, observed) = mpsc::unbounded_channel();
    let last_card = Arc::new(SyncMutex::new(Value::Null));
    let responses = Responses::default();
    let router = Router::new().fallback(rest).with_state(RestFixture {
        socket: format!("ws://{}/", ws.local_addr().unwrap()),
        emitted,
        last_card: Arc::clone(&last_card),
        responses: Arc::clone(&responses),
    });
    let server: JoinHandle<()> = tokio::spawn(async move {
        axum::serve(http, router).await.unwrap();
    });
    let mut state = None;
    let hub = Hub::with_factory(&config, Arc::clone(store), |_, config, ctx| {
        let mut config = config.clone();
        config["tokenEnv"] = json!("DISCORD_TOKEN");
        let mut rest = Rest::new(ctx.http.clone(), "offline-token".to_owned())?;
        rest.api.clone_from(&api);
        let rest = Arc::new(rest);
        let voice = config.get("voice")
            .map(|_| Voice::new(&config, ctx.clone(), Arc::clone(&rest)))
            .transpose()?;
        let adapter = Discord {
            state: Arc::new(State {
                ctx,
                rest,
                config: Config::deserialize(&config)?,
                stopping: AtomicBool::new(false),
                identity: OnceLock::new(),
                channels: RwLock::default(),
                voice,
                cards: Cards::default(),
                purpose_lock: Mutex::new(()),
                presence: Presence::default(),
            }),
            task: Mutex::new(None),
        };
        state = Some(Arc::clone(&adapter.state));
        Ok(Box::new(adapter))
    })
    .unwrap();
    (hub, ws, observed, last_card, server, responses, state.unwrap())
}

#[tokio::test]
async fn discord_review_table_posts_stacked_markdown_in_order_without_touching_code() {
    let (_temporary, _store, hub, ws, mut observed, _last_card, server) =
        discord_fixture(json!({"discord":{"allowedChannelIds":["89"]}})).await;
    let (started, _socket) = time::timeout(Duration::from_secs(5), async {
        tokio::join!(hub.start(), identify(&ws, false))
    })
    .await
    .unwrap();
    started.unwrap();
    let route = json!({"platform":"discord","accountId":"71","authorityId":"42",
        "guildId":"77","channelId":"89","threadId":null});
    let review = "**확인:** `main | 비교`에서 덮어쓰기 옵션과 진행 상태를 다시 확인했습니다. ".repeat(22);
    let link = |pr: u32| format!("https://github.com/dbc-hbin/omp-superagent/pull/{pr}#pullrequestreview-6016947392");
    let code = "```markdown\n| 예제 | 값 |\n| --- | --- |\n| 그대로 | 유지 |\n```";
    let source = format!(
        "재리뷰 요약\n| PR | 재리뷰 결과 | 상태 |\n| --- | --- | ---: |\n\
        | [#40 · Discord 진행 보고]({}) | {} | 완료 |\n\
        | [#41 · 채널별 병렬 전송]({}) | {} | 보류 \\| 확인 |\n{code}",
        link(40), review.trim_end(), link(41), review.trim_end(),
    );
    assert!(source.encode_utf16().count() > 2_000);
    hub.effect("send", &[json!({"id":"review-table","route":route,"text":source})])
        .await
        .unwrap();

    let first = received(&mut observed, "/channels/89/messages").await;
    let second = received(&mut observed, "/channels/89/messages").await;
    for body in [&first, &second] {
        assert!(body["content"].as_str().unwrap().encode_utf16().count() <= 2_000);
        assert_eq!(body["allowed_mentions"], rest::no_mentions());
    }
    assert_eq!(
        first["content"],
        format!("재리뷰 요약\n\n- PR: [#40 · Discord 진행 보고]({})\n  - 재리뷰 결과: {}\n  - 상태: 완료",
            link(40), review.trim_end())
    );
    assert_eq!(
        second["content"],
        format!("- PR: [#41 · 채널별 병렬 전송]({})\n  - 재리뷰 결과: {}\n  - 상태: 보류 \\| 확인\n\n{code}",
            link(41), review.trim_end())
    );
    assert!(observed.try_recv().is_err());
    hub.stop().await.unwrap();
    server.abort();
}

#[tokio::test]
async fn usage_interactions_and_text_reach_the_original_discord_thread_without_stale_options() {
    let (_temporary, store, hub, ws, mut observed, _, server) =
        discord_fixture(json!({"discord":{}})).await;
    let mut socket = addressing_tests::start(&hub, &ws, false).await;
    for (sequence, id, data, expected) in [
        (3, "501", json!({"type":1,"name":"usage"}), Some("/usage")),
        (4, "502", json!({"type":1,"name":"usage-reset"}), Some("/usage-reset")),
        (5, "503", json!({"type":1,"name":"usage","options":[{"type":3,"name":"text","value":" reset "}]}), None),
        (6, "504", json!({"type":1,"name":"usage-reset","options":[{"type":3,"name":"text","value":"anthropic/9"}]}), None),
    ] {
        let application = json!({"application_id":"72","guild_id":"77","member":{"user":{"id":"42"}},
            "channel":{"id":"90"},"token":"offline-interaction","type":2,"id":id,"data":data});
        dispatch(&mut socket, sequence, "INTERACTION_CREATE", application).await;
        let ack = received(&mut observed, &format!("/interactions/{id}/offline-interaction/callback")).await;
        assert_eq!(ack["data"]["flags"], 64);
        if let Some(expected) = expected {
            let admitted = event(&hub, &store).await;
            let input = &admitted["input"];
            assert_eq!(input["text"], expected);
            assert_eq!(input["messageId"], Value::Null);
            assert_eq!(input["interactionId"], id);
            assert_eq!(input["route"]["channelId"], "88");
            assert_eq!(input["route"]["threadId"], "90");
            assert!(input.get("pickerSelection").is_none());
        } else {
            assert_eq!(store.pending().unwrap(), 0, "stale usage options must never reach HEAD");
        }
    }

    for (sequence, id, text) in [(7, "205", "/usage-reset"), (8, "206", "/usage reset")] {
        dispatch(&mut socket, sequence, "MESSAGE_CREATE", message(id, Some("77"), "90", "42", text)).await;
        let admitted = event(&hub, &store).await;
        assert_eq!(admitted["input"]["text"], text);
        assert_eq!(admitted["input"]["route"]["threadId"], "90");
        assert_eq!(admitted["input"]["messageId"], id);
    }
    hub.stop().await;
    server.abort();
}

#[tokio::test]
async fn websocket_ingress_and_rest_cards_keep_original_discord_identity() {
    let (_temporary, store, hub, ws, mut observed, last_card, server) =
        discord_fixture(json!({"discord":{}})).await;
    let (started, mut socket) = time::timeout(Duration::from_secs(5), async {
        tokio::join!(hub.start(), identify(&ws, false))
    })
    .await
    .unwrap();
    started.unwrap();
    dispatch(
        &mut socket,
        2,
        "GUILD_CREATE",
        json!({"id":"77",
        "channels":[{"id":"88","type":0,"name":"parent","topic":null},{"id":"89","type":0}],
        "threads":[{"id":"90","type":11,"parent_id":"88","name":"task thread"}]}),
    )
    .await;
    for sequence in 3..1203 {
        if sequence % 2 == 0 {
            dispatch(
                &mut socket,
                sequence,
                "MESSAGE_UPDATE",
                json!({"channel_id":"89","id":sequence.to_string(),
                "edited_timestamp":"2026-11-21T01:02:03.456000+00:00"}),
            )
            .await;
        } else {
            dispatch(
                &mut socket,
                sequence,
                "MESSAGE_CREATE",
                message(
                    &sequence.to_string(),
                    Some("77"),
                    "90",
                    "43",
                    "unrelated chatter",
                ),
            )
            .await;
        }
    }
    dispatch(
        &mut socket,
        1203,
        "MESSAGE_CREATE",
        message("201", Some("77"), "90", "42", "owner thread"),
    )
    .await;
    dispatch(
        &mut socket,
        1204,
        "INTERACTION_CREATE",
        interaction("501", 2, json!({"type":1,"name":"status"})),
    )
    .await;
    assert_eq!(
        received(
            &mut observed,
            "/interactions/501/offline-interaction/callback"
        )
        .await["data"]["flags"],
        64
    );
    assert_eq!(
        store.pending().unwrap(),
        0,
        "native approval barrier precedes normal intake"
    );
    hub.ready.send_replace(true);
    let thread = event(&hub, &store).await;
    assert_eq!(thread["input"]["route"]["threadId"], "90");
    assert_eq!(thread["input"]["route"]["channelId"], "88");
    assert_eq!(
        thread["input"]["discordContext"]["thread"]["name"],
        "task thread"
    );
    dispatch(
        &mut socket,
        1205,
        "MESSAGE_CREATE",
        message("202", Some("77"), "90", "43", "wrong owner"),
    )
    .await;
    dispatch(
        &mut socket,
        1206,
        "MESSAGE_CREATE",
        message("203", Some("77"), "89", "42", "wrong parent"),
    )
    .await;
    dispatch(
        &mut socket,
        1207,
        "MESSAGE_UPDATE",
        json!({"channel_id":"90","id":"206",
        "edited_timestamp":"2026-11-21T01:02:03.456000+00:00"}),
    )
    .await;
    let edit = event(&hub, &store).await;
    assert_eq!(edit["input"]["messageId"], "206");
    assert_eq!(edit["input"]["text"], "edited by owner");
    assert_eq!(edit["input"]["route"]["threadId"], "90");
    dispatch(
        &mut socket,
        1208,
        "MESSAGE_CREATE",
        message("204", None, "98", "42", "group DM"),
    )
    .await;
    dispatch(
        &mut socket,
        1209,
        "MESSAGE_CREATE",
        message("205", None, "99", "42", "owner DM"),
    )
    .await;
    let dm = event(&hub, &store).await;
    assert_eq!(
        dm["input"]["messageId"], "205",
        "foreign events never enter ordered durable intake"
    );
    let mut route = dm["input"]["route"].clone();
    route["topicId"] = json!("original");
    dispatch(
        &mut socket,
        1210,
        "INTERACTION_CREATE",
        interaction(
            "502",
            2,
            json!({"type":1,"name":"compact",
        "options":[{"type":3,"name":"text","value":" details "}]}),
        ),
    )
    .await;
    received(
        &mut observed,
        "/interactions/502/offline-interaction/callback",
    )
    .await;
    let command = event(&hub, &store).await;
    assert_eq!(command["input"]["interactionId"], "502");
    assert_eq!(command["input"]["messageId"], Value::Null);
    assert_eq!(command["input"]["text"], "/compact details");
    assert!(!command.to_string().contains("offline-interaction"));

    let mut approval_route = route.clone();
    approval_route["topicId"] = json!(r#"original/"review"\topic"#);
    let approval = json!({"id":"approval","target":"main","generation":1,"requestId":"request",
        "route":approval_route,"state":"pending","remoteId":null,
        "request":{"method":"confirm","title":"Check intent","message":"Allow?"}});
    assert_eq!(
        hub.effect("showApproval", &[approval]).await.unwrap(),
        "700"
    );
    let outgoing = received(&mut observed, "/channels/99/messages").await;
    let button = outgoing["components"][0]["components"][0]["custom_id"].clone();
    // Pre-change SHA-256 of compact JSON with the escaped route key as a string.
    assert_eq!(button, "omp:1f1fb2aa10c035f88cc45f28:yes");
    let body = json!({"custom_id":button,"component_type":2});
    let mut forged = interaction("503", 3, body.clone());
    let card = last_card.lock().unwrap().clone();
    forged["message"] = card.clone();
    forged["message"]["id"] = json!("701");
    dispatch(&mut socket, 1211, "INTERACTION_CREATE", forged).await;
    assert_eq!(
        received(
            &mut observed,
            "/interactions/503/offline-interaction/callback"
        )
        .await["type"],
        4
    );
    assert_eq!(store.pending().unwrap(), 0);
    let mut genuine = interaction("504", 3, body);
    genuine["message"] = card;
    dispatch(&mut socket, 1212, "INTERACTION_CREATE", genuine).await;
    assert_eq!(
        received(
            &mut observed,
            "/interactions/504/offline-interaction/callback"
        )
        .await["type"],
        6
    );
    let answer = event(&hub, &store).await;
    assert_eq!(answer["approvalId"], "approval");
    assert_eq!(answer["route"], approval_route);
    assert_eq!(answer["response"], json!({"confirmed": true}));
    received(&mut observed, "/channels/99/messages/700").await;

    let models = (0..10).map(|index| format!("fixture/model-{index}")).collect::<Vec<_>>();
    let status = format!("HEAD model {}", "🦊".repeat(1_100));
    let picker = json!({"id":"model-card","route":route,"text":status,
        "picker":{"kind":"model","expiresAt":crate::store::now().unwrap()+300_000,
            "groups":[{"label":"fixture","options":models}]}});
    hub.effect("send", &[picker]).await.unwrap();
    let outgoing = received(&mut observed, "/channels/99/messages").await;
    let provider = &outgoing["components"][0]["components"][0];
    let mut choose = interaction("510", 3, json!({
        "custom_id": provider["custom_id"], "component_type":3, "values":["0"]
    }));
    choose["message"] = last_card.lock().unwrap().clone();
    dispatch(&mut socket, 1213, "INTERACTION_CREATE", choose).await;
    let provider_ack = received(&mut observed, "/interactions/510/offline-interaction/callback").await;
    assert_eq!(provider_ack["type"], 7);
    assert!(provider_ack["data"]["content"].as_str().unwrap().encode_utf16().count() <= 2_000);
    assert_eq!(store.pending().unwrap(), 0, "navigation must not admit a command");
    let first_page = &provider_ack["data"]["components"];
    let next = first_page[1]["components"].as_array().unwrap().iter()
        .find(|button| button["label"] == "Next").unwrap();
    let mut navigate = interaction("514", 3, json!({"custom_id":next["custom_id"],"component_type":2}));
    navigate["message"] = last_card.lock().unwrap().clone();
    navigate["message"]["components"] = first_page.clone();
    dispatch(&mut socket, 1214, "INTERACTION_CREATE", navigate).await;
    let page_ack = received(&mut observed, "/interactions/514/offline-interaction/callback").await;
    let model_menu = &page_ack["data"]["components"][0]["components"][0];
    assert_eq!(model_menu["options"][0]["label"], "fixture/model-8");
    let select = json!({"custom_id":model_menu["custom_id"],"component_type":3,"values":["8"]});
    let mut click = interaction("511", 3, select);
    click["message"] = last_card.lock().unwrap().clone();
    click["message"]["components"] = page_ack["data"]["components"].clone();
    let mut other_card = click.clone();
    other_card["id"] = json!("512");
    other_card["message"]["id"] = json!("701");
    dispatch(&mut socket, 1215, "INTERACTION_CREATE", other_card).await;
    assert_eq!(received(&mut observed, "/interactions/512/offline-interaction/callback").await["type"], 4);
    assert_eq!(store.pending().unwrap(), 0);
    dispatch(&mut socket, 1216, "INTERACTION_CREATE", click.clone()).await;
    assert_eq!(received(&mut observed, "/interactions/511/offline-interaction/callback").await["data"]["components"], json!([]));
    let picked = event(&hub, &store).await;
    assert_eq!(picked["kind"], "message");
    assert_eq!(picked["input"]["route"], route);
    assert_eq!(picked["input"]["messageId"], Value::Null);
    assert_eq!(picked["input"]["pickerSelection"], json!({"outputId":"model-card","cardId":"700","group":0,"option":8}));
    click["id"] = json!("513");
    dispatch(&mut socket, 1217, "INTERACTION_CREATE", click).await;
    assert_eq!(received(&mut observed, "/interactions/513/offline-interaction/callback").await["type"], 4);
    assert_eq!(store.pending().unwrap(), 0);

    dispatch(&mut socket, 1218, "INTERACTION_CREATE", interaction("515", 2, json!({
        "type":1,"name":"usage-reset"
    }))).await;
    received(&mut observed, "/interactions/515/offline-interaction/callback").await;
    let reset = event(&hub, &store).await;
    assert_eq!(reset["input"]["text"], "/usage-reset");
    assert_eq!(reset["input"]["messageId"], Value::Null);
    let label = "Codex · 계정 #7 · 사용 가능 2개";
    hub.effect("send", &[json!({
        "id":"reset-card","route":route,"text":"Saved resets",
        "picker":{"kind":"usage-reset","expiresAt":crate::store::now().unwrap()+300_000,
            "groups":[{"label":"Accounts","options":[label]}]}
    })]).await.unwrap();
    let outgoing = received(&mut observed, "/channels/99/messages").await;
    let select = &outgoing["components"][0]["components"][0];
    assert_eq!(select["options"][0]["label"], label);
    let mut choose = interaction("516", 3, json!({
        "custom_id":select["custom_id"],"component_type":3,"values":["0"]
    }));
    choose["message"] = last_card.lock().unwrap().clone();
    dispatch(&mut socket, 1219, "INTERACTION_CREATE", choose).await;
    let review = received(&mut observed, "/interactions/516/offline-interaction/callback").await;
    assert_eq!(review["type"], 7);
    assert!(review["data"]["content"].as_str().unwrap().contains(label));
    assert_eq!(store.pending().unwrap(), 0, "choosing an account must not admit a spend");
    let rows = review["data"]["components"].as_array().unwrap();
    assert_eq!(rows.len(), 1, "confirmation must not send an empty Discord select");
    let buttons = rows[0]["components"].as_array().unwrap();
    let confirm = buttons.iter().find(|button| button["type"] == 2 && button["label"] == "Confirm").unwrap();
    let mut click = interaction("517", 3, json!({"custom_id":confirm["custom_id"],"component_type":2}));
    click["message"] = last_card.lock().unwrap().clone();
    click["message"]["components"] = review["data"]["components"].clone();
    let last_sequence = 1220;
    dispatch(&mut socket, last_sequence, "INTERACTION_CREATE", click).await;
    let closed = received(&mut observed, "/interactions/517/offline-interaction/callback").await;
    assert_eq!(closed["data"]["components"], json!([]));
    let confirmed = event(&hub, &store).await;
    assert_eq!(confirmed["input"]["route"], route);
    assert_eq!(confirmed["input"]["pickerSelection"],
        json!({"outputId":"reset-card","cardId":"700","group":0,"option":0,"confirmed":true}));

    let send = hub
        .effect(
            "send",
            &[json!({"id":"output","route":route,"text":"ambiguous"})],
        )
        .await;
    assert_eq!(send.unwrap_err().certainty, "uncertain");
    received(&mut observed, "/channels/99/messages").await;
    assert!(
        observed.try_recv().is_err(),
        "ambiguous REST effect must not be retried in the adapter"
    );

    let paragraphs = |labels: &[&str]| {
        labels
            .iter()
            .map(|label| format!("{label} {}", "x".repeat(1_500)))
            .collect::<Vec<_>>()
            .join("\n\n")
    };
    let reply = json!({"route":route,"messageId":"205"});
    store
        .set_meta("discord:output-part:803", "split")
        .unwrap();
    let split = hub
        .effect(
            "send",
            &[json!({"id":"split","route":route,"replyTo":reply,
                "text":paragraphs(&["segment 1", "segment 2", "segment 3", "segment 4"])})],
        )
        .await
        .unwrap();
    assert_eq!(
        split, "801",
        "the first message is the stored remote receipt"
    );
    for (id, expected) in [
        ("801", None),
        ("802", Some("split")),
        ("803", Some("split")),
        ("804", Some("split")),
    ] {
        assert_eq!(
            store
                .get_meta(&format!("discord:output-part:{id}"))
                .unwrap()
                .as_deref(),
            expected,
            "unexpected part mapping for Discord message {id}"
        );
    }
    let physical: model::Route = serde_json::from_value(route.clone()).unwrap();
    let mut nonces = HashSet::new();
    for part in 0..4 {
        let body = received(&mut observed, "/channels/99/messages").await;
        let content = body["content"].as_str().unwrap();
        assert!(content.starts_with(&format!("segment {}", part + 1)));
        assert!(content.encode_utf16().count() <= 2_000);
        assert_eq!(body["nonce"], outputs::nonce("split", &physical, part));
        assert_eq!(body["enforce_nonce"], true);
        assert!(nonces.insert(body["nonce"].as_str().unwrap().to_owned()));
        assert_eq!(body["allowed_mentions"], rest::no_mentions());
        assert_eq!(
            body["message_reference"],
            if part == 0 {
                json!({"message_id":"205","fail_if_not_exists":false})
            } else {
                Value::Null
            },
            "only the first part replies to the original message"
        );
    }
    assert!(observed.try_recv().is_err());

    let conflict = hub
        .effect(
            "send",
            &[json!({"id":"conflict","route":route,
                "text":paragraphs(&["segment 5", "segment 6", "segment 2"])})],
        )
        .await
        .unwrap_err();
    assert_eq!(conflict.certainty, "uncertain");
    for _ in 0..3 {
        received(&mut observed, "/channels/99/messages").await;
    }
    assert_eq!(
        store.get_meta("discord:output-part:802").unwrap().as_deref(),
        Some("split")
    );
    assert_eq!(store.get_meta("discord:output-part:806").unwrap(), None);

    let partial = hub
        .effect(
            "send",
            &[json!({"id":"partial","route":route,
                "text":paragraphs(&["segment 5", "segment 6", "reject", "segment 7"])})],
        )
        .await
        .unwrap_err();
    assert_eq!(
        partial.certainty, "uncertain",
        "a visible earlier part makes a later rejection ambiguous for the whole output"
    );
    received(&mut observed, "/channels/99/messages").await;
    received(&mut observed, "/channels/99/messages").await;
    received(&mut observed, "/channels/99/messages").await;
    assert_eq!(
        store.get_meta("discord:output-part:806").unwrap(),
        None,
        "a verified later part does not identify an incomplete output"
    );
    assert!(
        observed.try_recv().is_err(),
        "later parts are not sent and nothing is retried after a partial failure"
    );
    let duplicate = hub
        .effect(
            "send",
            &[json!({"id":"duplicate","route":route,
                "text":paragraphs(&["segment 7", "segment 8", "segment 8"])})],
        )
        .await
        .unwrap_err();
    assert_eq!(duplicate.certainty, "uncertain");
    for _ in 0..3 {
        received(&mut observed, "/channels/99/messages").await;
    }
    assert_eq!(
        store.get_meta("discord:output-part:808").unwrap(),
        None,
        "a duplicate snowflake cannot confirm delivery of a distinct part"
    );
    let rejected = hub
        .effect(
            "send",
            &[json!({"id":"rejected","route":route,
                "text":paragraphs(&["reject", "segment 2"])})],
        )
        .await
        .unwrap_err();
    assert_eq!(rejected.certainty, "rejected", "nothing was delivered");
    received(&mut observed, "/channels/99/messages").await;
    assert!(observed.try_recv().is_err());

    let output = [json!({"id":"deadline","route":route,
        "text":paragraphs(&["deadline first", "deadline second", "deadline third"])})];
    let (expired, ()) = tokio::join!(hub.effect("send", &output), async {
        for (part, delay) in [("first", 12), ("second", 14)] {
            let body = received(&mut observed, "/channels/99/messages").await;
            assert!(
                body["content"]
                    .as_str()
                    .unwrap()
                    .starts_with(&format!("deadline {part}"))
            );
            // Advance only while the fixture holds a reply; resume for real TCP I/O.
            time::pause();
            time::advance(Duration::from_secs(delay)).await;
            time::resume();
        }
    });
    assert_eq!(expired.unwrap_err().certainty, "uncertain");
    assert!(
        observed.try_recv().is_err(),
        "the total deadline must prevent the third POST even if each REST request fits its own timeout"
    );

    let labels = ["segment 1"; 6];
    assert_eq!(
        hub.effect(
            "send",
            &[json!({"id":"overflow","route":route,"replyTo":reply,"text":paragraphs(&labels)})],
        )
        .await
        .unwrap(),
        "700"
    );
    let upload = received(&mut observed, "/channels/99/messages").await;
    let upload = upload
        .as_str()
        .expect("more than five parts fall back to one upload");
    let payload: Value = upload
        .lines()
        .find_map(|line| serde_json::from_str(line).ok())
        .expect("multipart payload_json part");
    assert_eq!(
        payload["content"],
        "Full text is attached (exceeds Discord's message limit)."
    );
    let name = format!("omp-{}.txt", outputs::nonce("overflow", &physical, 0));
    assert_eq!(payload["attachments"][0]["filename"], name);
    assert_eq!(payload["nonce"], outputs::nonce("overflow", &physical, 0));
    assert_eq!(payload["allowed_mentions"], rest::no_mentions());
    assert_eq!(payload["message_reference"]["message_id"], "205");
    assert!(upload.contains(&format!("filename=\"{name}\"")));
    assert!(observed.try_recv().is_err());

    let result = json!({"id":"result-file","route":route,"replyTo":reply,"text":""});
    let file = |name: &str| crate::result_attachment::VerifiedResultAttachment {
        name: name.to_owned(), bytes: b"\0BC\n".to_vec(),
    };
    assert_eq!(hub.send_result_attachment(&result, file("result.bin")).await.unwrap(), "700");
    let posted = received(&mut observed, "/channels/99/messages").await;
    let multipart = posted.as_str().expect("Discord native binary multipart");
    let payload: Value = multipart
        .lines()
        .find_map(|line| serde_json::from_str(line).ok())
        .expect("result file payload");
    assert_eq!(payload["attachments"][0]["filename"], "result.bin");
    assert_eq!(payload["message_reference"]["message_id"], "205");
    assert!(multipart.contains("filename=\"result.bin\"\r\n\r\n\0BC\n"));
    assert_eq!(
        hub.send_result_attachment(&result, file("unconfirmed.bin")).await.unwrap_err().certainty,
        "uncertain",
        "a message without the requested file is not an attachment receipt"
    );
    received(&mut observed, "/channels/99/messages").await;
    assert!(observed.try_recv().is_err());

    wire(&mut socket, json!({"op":7})).await;
    let (stream, _) = time::timeout(Duration::from_secs(5), ws.accept())
        .await
        .unwrap()
        .unwrap();
    let mut resumed = accept_async(stream).await.unwrap();
    wire(
        &mut resumed,
        json!({"op":10,"d":{"heartbeat_interval":60_000}}),
    )
    .await;
    let frame = time::timeout(Duration::from_secs(5), resumed.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let resume: Value = serde_json::from_str(frame.to_text().unwrap()).unwrap();
    assert_eq!(resume["op"], 6);
    assert_eq!(resume["d"]["session_id"], "test-session");
    assert_eq!(resume["d"]["seq"], last_sequence);
    dispatch(
        &mut resumed,
        last_sequence + 1,
        "MESSAGE_CREATE",
        message("205", None, "99", "42", "owner DM"),
    )
    .await;
    dispatch(
        &mut resumed,
        last_sequence + 2,
        "MESSAGE_CREATE",
        message("207", None, "99", "42", "while offline"),
    )
    .await;
    dispatch(&mut resumed, last_sequence + 3, "RESUMED", json!({"trace":[]})).await;
    assert_eq!(event(&hub, &store).await["input"]["messageId"], "207");
    assert_eq!(event(&hub, &store).await["kind"], "reconnect");
    hub.stop().await.unwrap();
    server.abort();
}

#[tokio::test]
async fn group_thread_accepts_only_live_member_text_and_replies_without_owner_effects() {
    let (_temporary, store, hub, ws, mut observed, _, server) = discord_fixture(json!({
        "discord":{"allowedGuildIds":["77"],"allowedChannelIds":["88"],"requireAddressing":true},
        "groupRooms":[{"platform":"discord","guildId":"77","channelId":"88",
            "userIds":["42","43"],"mode":"work","revision":"live","dailyLimit":1}]
    })).await;
    let (started, mut socket) = time::timeout(Duration::from_secs(5), async {
        tokio::join!(hub.start(), identify(&ws, false))
    }).await.unwrap();
    started.unwrap();
    hub.ready.send_replace(true);
    dispatch(&mut socket, 2, "MESSAGE_CREATE", message("501", None, "99", "42", "owner DM")).await;
    assert_eq!(event(&hub, &store).await["input"]["text"], "owner DM");

    let now = u64::try_from(crate::store::now().unwrap()).unwrap();
    let at = |age: u64, sequence: u64| (((now - 1_420_070_400_000 - age) << 22) | sequence).to_string();
    let group_message = |sequence, user: &str, text: &str| {
        message(&at(0, sequence), Some("77"), "90", user, text)
    };
    let mut edited = group_message(3_u64, "43", "!work edited");
    edited["edited_timestamp"] = json!("2026-11-21T01:02:03.456000+00:00");
    let mut forwarded = group_message(4_u64, "43", "!work forwarded");
    forwarded["message_snapshots"] = json!([{"message":{"content":"forwarded secret"}}]);
    let mut attachment = group_message(5_u64, "43", "!work attached");
    attachment["attachments"] = json!([{"id":"1","filename":"secret.txt","size":4,"url":"https://example.test/secret.txt"}]);
    for (index, (kind, msg)) in [
        ("MESSAGE_CREATE", group_message(1, "42", "/restart")),
        ("MESSAGE_CREATE", group_message(2, "44", "!work stranger")),
        ("MESSAGE_UPDATE", edited),
        ("MESSAGE_CREATE", forwarded),
        ("MESSAGE_CREATE", attachment),
        ("MESSAGE_CREATE", message(&at(360_000, 6), Some("77"), "90", "43", "!work stale")),
        ("MESSAGE_CREATE", group_message(7, "43", "!workbench wrong token")),
        ("MESSAGE_CREATE", group_message(8, "43", &format!("!work {}", "🙂".repeat(1001)))),
    ].into_iter().enumerate() {
        dispatch(&mut socket, 3 + u64::try_from(index).unwrap(), kind, msg).await;
    }
    for (sequence, id, channel, user) in [(11, "888", "90", "42"), (12, "889", "88", "43"), (13, "890", "90", "44")] {
        let mut slash = interaction(id, 2, json!({"type":1,"name":"status"}));
        slash["guild_id"] = json!("77");
        slash["channel"]["id"] = json!(channel);
        slash["member"] = json!({"user":{"id":user}});
        dispatch(&mut socket, sequence, "INTERACTION_CREATE", slash).await;
    }
    let mut accepted = group_message(9, "43", "!work outline");
    accepted["type"] = json!(19);
    accepted["message_reference"] = json!({"message_id":"798","channel_id":"90","guild_id":"77"});
    accepted["referenced_message"] = json!({"id":"798","channel_id":"90","author":{"id":"42"},"content":"private quote"});
    dispatch(&mut socket, 14, "MESSAGE_CREATE", accepted.clone()).await;
    dispatch(&mut socket, 15, "MESSAGE_CREATE", accepted).await;
    dispatch(&mut socket, 16, "MESSAGE_CREATE", group_message(10, "43", "!work over budget")).await;
    dispatch(&mut socket, 17, "MESSAGE_CREATE", message("502", None, "99", "42", "end marker")).await;

    let group = event(&hub, &store).await;
    assert_eq!(group["kind"], "group");
    let route = group["request"]["route"].clone();
    assert_eq!(route["authorityId"], "42");
    assert_eq!(route["channelId"], "88");
    assert_eq!(route["threadId"], "90");
    assert_eq!(group["request"]["messageId"], at(0, 9));
    assert_eq!(group["request"]["userId"], "43");
    assert_eq!(group["request"]["mode"], "work");
    assert_eq!(group["request"]["revision"], "live");
    assert_eq!(group["request"]["text"], "outline");
    assert_eq!(group["request"].as_object().unwrap().len(), 7);
    assert_eq!(event(&hub, &store).await["input"]["text"], "end marker");
    assert!(hub.effect("fetchAfter", &[route.clone(), json!("798")]).await.is_err());
    assert!(hub.effect("assertRoute", &[route.clone()]).await.is_err());
    assert!(hub.effect("send", &[json!({"route":route,"text":"owner data","id":"ordinary"})]).await.is_err());
    assert_eq!(hub.send_group(json!({"route":route,"messageId":at(0, 9),
        "text":"Request finished.","id":"group-effect"})).await.unwrap(), "701");
    let posted = received(&mut observed, "/channels/90/messages").await;
    assert_eq!(posted["message_reference"], json!({"message_id":at(0, 9),"fail_if_not_exists":true}));
    assert_eq!(posted["content"], "Request finished.");
    assert_eq!(posted["allowed_mentions"]["parse"], json!([]));
    assert!(posted.get("attachments").is_none());
    assert!(posted.get("components").is_none());

    hub.stop().await.unwrap();
    server.abort();
}

#[tokio::test]
async fn guild_thread_cards_fall_back_to_text_without_verified_embed_links() {
    let temporary = Temp::new();
    let store = Arc::new(Store::open(&temporary.0).unwrap());
    let (hub, ws, mut observed, _, server, responses, _) =
        discord_fixture_with_store(json!({"discord":{}}), &store).await;
    let (started, _socket) = time::timeout(Duration::from_secs(5), async {
        tokio::join!(hub.start(), identify(&ws, false))
    }).await.unwrap();
    started.unwrap();
    hub.ready.send_replace(true);

    let card = "~~~card\n{\"root\":\"c\",\"elements\":{\"c\":{\"type\":\"Card\",\"props\":{\"title\":\"Status\"}}}}\n~~~";
    let source = format!("| Check | Result |\n| --- | --- |\n| Unit | Pass |\n\n{card}");
    let stacked = "- Check: Unit\n  - Result: Pass";
    let route = json!({"platform":"discord","accountId":"71","authorityId":"42",
        "guildId":"77","channelId":"88","threadId":"90"});
    responses.lock().unwrap().extend([
        ("/guilds/77".into(), (StatusCode::OK, json!({"id":"77","owner_id":"42"}))),
        ("/guilds/77/members/71".into(), (StatusCode::OK, json!({"user":{"id":"71"},"roles":[]}))),
        ("/guilds/77/roles".into(), (StatusCode::OK, json!([{"id":"77","permissions":permissions::EMBED_LINKS.to_string()}]))),
    ]);
    // Parent channel denies the permission, then allows it; unresolved permissions
    // must also use the plain-text path before sending.
    for (i, allowed) in [false, true, false].into_iter().enumerate() {
        if i == 0 {
            responses.lock().unwrap().insert("/channels/88".into(), (StatusCode::OK,
                json!({"id":"88","guild_id":"77","type":0,"permission_overwrites":[
                    {"type":0,"id":"77","allow":"0","deny":permissions::EMBED_LINKS.to_string()}]})));
        } else if i == 1 {
            responses.lock().unwrap().remove("/channels/88");
        } else {
            responses.lock().unwrap().remove("/guilds/77/roles");
        }
        hub.effect("send", &[json!({"id":format!("card-{i}"),"route":route,"text":source})]).await.unwrap();
        let sent = received(&mut observed, "/channels/90/messages").await;
        if allowed {
            assert_eq!(sent["embeds"], json!([{"title":"Status"}]));
            assert_eq!(sent["content"], stacked);
        } else {
            assert!(sent.get("embeds").is_none());
            assert_eq!(sent["content"], format!("{stacked}\n\n{card}"));
        }
        assert!(observed.try_recv().is_err(), "one external message, never retry a send");
    }
    hub.stop().await.unwrap();
    server.abort();
}

#[tokio::test]
async fn status_edits_replace_their_message_and_cards_become_embeds() {
    let (_temporary, store, hub, ws, mut observed, _, server) =
        discord_fixture(json!({"discord":{}})).await;
    let (started, mut socket) = time::timeout(Duration::from_secs(5), async {
        tokio::join!(hub.start(), identify(&ws, false))
    })
    .await
    .unwrap();
    started.unwrap();
    hub.ready.send_replace(true);
    dispatch(&mut socket, 2, "MESSAGE_CREATE", message("501", None, "99", "42", "owner DM")).await;
    let route = event(&hub, &store).await["input"]["route"].clone();

    let card = r#"{"root":"c","elements":{"c":{"type":"Card","props":{"title":"Status"}}}}"#;
    let created = hub
        .effect("send", &[json!({"id":"status-1","route":route,
            "text":format!("⏳ working\n```card\n{card}\n```")})])
        .await
        .unwrap();
    assert_eq!(created, "700");
    let posted = received(&mut observed, "/channels/99/messages").await;
    assert_eq!(posted["content"], "⏳ working");
    assert_eq!(posted["embeds"], json!([{"title":"Status"}]));

    let target = json!({"route":route,"messageId":"700"});
    let edited = hub
        .effect("send", &[json!({"id":"status-2","route":route,"text":"⏳ still working",
            "editOf":target})])
        .await
        .unwrap();
    assert_eq!(edited, "700", "an edit keeps the physical message identity");
    let patch = received(&mut observed, "/channels/99/messages/700").await;
    assert_eq!(patch["content"], "⏳ still working");
    assert_eq!(patch["embeds"], json!([]), "an edit clears embeds the new text lacks");
    assert_eq!(patch["attachments"], json!([]));
    assert!(patch.get("nonce").is_none());
    assert!(observed.try_recv().is_err());

    // Discord no longer has the message: the edit fails and is never reposted.
    let missing = hub
        .effect("send", &[json!({"id":"status-3","route":route,"text":"⏳ gone",
            "editOf":{"route":route,"messageId":"702"}})])
        .await
        .unwrap_err();
    assert_eq!(missing.certainty, "rejected");
    let mut elsewhere = route.clone();
    elsewhere["channelId"] = json!("98");
    let foreign = hub
        .effect("send", &[json!({"id":"status-4","route":route,"text":"⏳ moved",
            "editOf":{"route":elsewhere,"messageId":"700"}})])
        .await
        .unwrap_err();
    assert_eq!(foreign.certainty, "rejected");
    assert!(observed.try_recv().is_err(), "no rejected edit becomes a new post");

    hub.stop().await.unwrap();
    server.abort();
}

#[tokio::test]
async fn card_only_progress_and_long_initial_status_edit_in_one_message() {
    let (_temporary, store, hub, ws, mut observed, _, server) =
        discord_fixture(json!({"discord":{}})).await;
    let (started, mut socket) = time::timeout(Duration::from_secs(5), async {
        tokio::join!(hub.start(), identify(&ws, false))
    })
    .await
    .unwrap();
    started.unwrap();
    hub.ready.send_replace(true);
    dispatch(&mut socket, 2, "MESSAGE_CREATE", message("501", None, "99", "42", "owner DM")).await;
    let route = event(&hub, &store).await["input"]["route"].clone();

    let card = r#"{"root":"c","elements":{"c":{"type":"Card","props":{"title":"Progress"}}}}"#;
    let card_status = hub
        .effect("send", &[json!({"id":"card-only-1","route":route,"status":true,
            "text":format!("⏳\n```card\n{card}\n```")})])
        .await
        .unwrap();
    assert_eq!(card_status, "700");
    let card_posted = received(&mut observed, "/channels/99/messages").await;
    assert_eq!(card_posted["content"], "⏳");
    assert_eq!(card_posted["embeds"], json!([{"title":"Progress"}]));

    // Preserving four-space fence indentation after the ⏳ newline keeps a following card visible.
    let indented_status = hub
        .effect("send", &[json!({"id":"indented-fence-1","route":route,"status":true,
            "text":format!("⏳\n    ```not-a-fence\n```card\n{card}\n```")})])
        .await
        .unwrap();
    assert_eq!(indented_status, "700");
    let indented_posted = received(&mut observed, "/channels/99/messages").await;
    assert_eq!(indented_posted["content"], "⏳\n    ```not-a-fence");
    assert_eq!(indented_posted["embeds"], json!([{"title":"Progress"}]));

    // A >2000 char initial status falls back to a single text attachment so a
    // subsequent short edit replaces the entire status in place with zero chunks left.
    let long_status = format!("⏳ {}", "a".repeat(2500));
    let long_id = hub
        .effect("send", &[json!({"id":"long-status-1","route":route,"text":long_status,"status":true})])
        .await
        .unwrap();
    assert_eq!(long_id, "700");
    let long_posted = received(&mut observed, "/channels/99/messages").await;
    let raw = long_posted.as_str().expect("multipart upload for long initial status");
    assert!(raw.contains("Full text is attached (exceeds Discord's message limit)."));
    assert!(observed.try_recv().is_err(), "long initial status must use one post, never split chunks");

    let short_edit = hub
        .effect("send", &[json!({"id":"long-status-2","route":route,"text":"⏳ done",
            "editOf":{"route":route,"messageId":"700"}})])
        .await
        .unwrap();
    assert_eq!(short_edit, "700");
    let patch = received(&mut observed, "/channels/99/messages/700").await;
    assert_eq!(patch["content"], "⏳ done");
    assert_eq!(patch["embeds"], json!([]));
    assert_eq!(patch["attachments"], json!([]));
    assert!(observed.try_recv().is_err());

    // Non-Discord routes and rich payloads cannot claim status=true.
    let telegram_route = json!({"platform":"telegram","accountId":"bot","authorityId":"42",
        "guildId":null,"channelId":"-100","threadId":null});
    let non_discord = hub
        .effect("send", &[json!({"id":"bad-status-tg","route":telegram_route,"text":"⏳ x","status":true})])
        .await
        .unwrap_err();
    assert_eq!(non_discord.certainty, "rejected");
    let with_picker = hub
        .effect("send", &[json!({"id":"bad-status-picker","route":route,"text":"Pick","status":true,
            "picker":{"kind":"model","sessionId":"s","generation":0,"expiresAt":2,"groups":[{"label":"M","options":["fixture/a"]}]}})])
        .await
        .unwrap_err();
    assert_eq!(with_picker.certainty, "rejected");
    assert!(observed.try_recv().is_err());

    hub.stop().await.unwrap();
    server.abort();
}
