use super::*;
use axum::{
    Json, Router,
    routing::{get, post},
};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tokio::{net::TcpListener, task::JoinSet};
use tokio_tungstenite::accept_async;

const SDP: &str = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
const TOKEN: &str = "offline.jwt.fixture";
const ACCOUNT: &str = "fixture-account";

type Peer = WebSocketStream<TcpStream>;

async fn bounded<T>(operation: impl Future<Output = T>) -> T {
    timeout(Duration::from_secs(3), operation)
        .await
        .expect("loopback operation timed out")
}

#[tokio::test]
async fn redirected_offer_does_not_contact_alternate_origin() {
    let source = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let alternate = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}/calls", source.local_addr().unwrap());
    let destination = format!("http://{}/redirected", alternate.local_addr().unwrap());
    let app = Router::new().route(
        "/calls",
        post(
            move |headers: HeaderMap, Json(data): Json<Value>| async move {
                assert_eq!(headers[AUTHORIZATION], format!("Bearer {TOKEN}"));
                assert_eq!(headers["chatgpt-account-id"], ACCOUNT);
                assert_eq!(headers["openai-alpha"], "quicksilver=v2");
                assert_eq!(headers[ACCEPT_ENCODING], "identity");
                assert_eq!(data["sdp"], SDP);
                assert_eq!(data["session"]["model"], "gpt-live-1-codex");
                assert_eq!(data["session"]["audio"]["output"]["voice"], "cove");
                assert_eq!(data["session"]["delegation"], json!({"type":"client"}));
                (StatusCode::TEMPORARY_REDIRECT, [(LOCATION, destination)])
            },
        ),
    );
    let mut server = JoinSet::new();
    server.spawn(async { axum::serve(source, app).await.unwrap() });
    let login = Login::fixture(TOKEN, ACCOUNT);
    let control = format!("ws://{}/v1/live", alternate.local_addr().unwrap());
    let result = bounded(async {
        tokio::select! {
            biased;
            accepted = alternate.accept() => panic!("alternate origin was contacted: {accepted:?}"),
            result = Control::open_loopback(SDP, &login, (&origin, &control)) => result,
        }
    })
    .await;
    let Err(error) = result else {
        panic!("redirected offer was accepted");
    };
    assert!(error.to_string().contains("redirect was refused"));
}

#[tokio::test]
async fn invalid_or_reflective_answers_never_open_sideband() {
    for (answer, error_fragment) in [
        (
            format!("{SDP}m=video 9 UDP/TLS/RTP/SAVPF 99\r\n"),
            "voice answer",
        ),
        (format!("{SDP}a=reflected:{TOKEN}\r\n"), "voice answer"),
        (format!("{SDP}a=reflected:{ACCOUNT}\r\n"), "voice answer"),
        (
            format!("{SDP}a={}\r\n", "x".repeat(MAX_WIRE_BYTES)),
            "size limit",
        ),
    ] {
        let source = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let sideband = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}/calls", source.local_addr().unwrap());
        let control = format!("ws://{}/v1/live", sideband.local_addr().unwrap());
        let app = Router::new().route(
            "/calls",
            post(move || async move { ([("openai-session-id", "rtc_safe")], answer) }),
        );
        let mut server = JoinSet::new();
        server.spawn(async { axum::serve(source, app).await.unwrap() });
        let login = Login::fixture(TOKEN, ACCOUNT);
        let result = bounded(async {
            tokio::select! {
                biased;
                accepted = sideband.accept() => panic!("invalid answer reached sideband: {accepted:?}"),
                result = Control::open_loopback(SDP, &login, (&origin, &control)) => result,
            }
        }).await;
        let Err(error) = result else {
            panic!("invalid SDP answer was accepted");
        };
        let error = format!("{error:#}");
        assert!(
            error.contains(error_fragment) && !error.contains(TOKEN) && !error.contains(ACCOUNT)
        );
    }
}

#[tokio::test]
async fn redirected_sideband_never_contacts_alternate_origin() {
    let source = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let alternate = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = source.local_addr().unwrap();
    let origin = format!("http://{address}/calls");
    let control = format!("ws://{address}/v1/live");
    let destination = format!("ws://{}/redirected", alternate.local_addr().unwrap());
    let redirect_issued = Arc::new(AtomicBool::new(false));
    let observed = Arc::clone(&redirect_issued);
    let app = Router::new()
        .route(
            "/calls",
            post(|| async { ([("openai-session-id", "rtc_safe")], SDP) }),
        )
        .route(
            "/v1/live/rtc_safe",
            get(move |headers: HeaderMap| async move {
                assert_eq!(headers[AUTHORIZATION], format!("Bearer {TOKEN}"));
                assert_eq!(headers["chatgpt-account-id"], ACCOUNT);
                observed.store(true, Ordering::Relaxed);
                (StatusCode::TEMPORARY_REDIRECT, [(LOCATION, destination)])
            }),
        );
    let mut server = JoinSet::new();
    server.spawn(async { axum::serve(source, app).await.unwrap() });
    let login = Login::fixture(TOKEN, ACCOUNT);
    let result = bounded(async {
        tokio::select! {
            biased;
            accepted = alternate.accept() => panic!("alternate sideband was contacted: {accepted:?}"),
            result = Control::open_loopback(SDP, &login, (&origin, &control)) => result,
        }
    }).await;
    let Err(error) = result else {
        panic!("redirected sideband was accepted");
    };
    assert!(redirect_issued.load(Ordering::Relaxed));
    assert!(error.to_string().contains("sideband connection failed"));
}

#[test]
fn call_location_binds_header_and_rejects_untrusted_or_ambiguous_authorities() {
    for (location, header, accept) in [
        ("/calls/rtc_safe", "rtc_safe", true),
        ("https://chatgpt.com/calls/rtc_safe/", "rtc_safe", true),
        ("https://api.openai.com/calls/rtc_safe", "rtc_safe", true),
        (
            "https://elsewhere.invalid/calls/rtc_safe",
            "rtc_safe",
            false,
        ),
        (
            "https://chatgpt.com@elsewhere.invalid/calls/rtc_safe",
            "rtc_safe",
            false,
        ),
        ("https://chatgpt.com:443/calls/rtc_safe", "rtc_safe", false),
        ("http://chatgpt.com/calls/rtc_safe", "rtc_safe", false),
        ("//elsewhere.invalid/calls/rtc_safe", "rtc_safe", false),
        ("/calls/rtc_safe?mode=reroute", "rtc_safe", false),
        ("/calls/rtc_safe#ref", "rtc_safe", false),
        ("/calls/rtc_safe", "rtc_different", false),
        ("/calls/rtc_bad%2Fid", "rtc_bad%2Fid", false),
    ] {
        let mut headers = HeaderMap::new();
        headers.insert(LOCATION, HeaderValue::from_static(location));
        headers.insert("openai-session-id", HeaderValue::from_static(header));
        let result = call_id(&headers);
        if accept {
            assert_eq!(result.unwrap(), "rtc_safe", "{location}");
        } else {
            assert!(result.is_err(), "{location}");
        }
    }
}

async fn socket_pair() -> (Socket, Peer) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}", listener.local_addr().unwrap());
    bounded(async {
        let (client, server) = tokio::join!(
            connect_async_with_config(url.as_str(), Some(sideband_config()), true),
            async { accept_async(listener.accept().await.unwrap().0).await },
        );
        (client.unwrap().0, server.unwrap())
    })
    .await
}

fn control(socket: Socket) -> Control {
    Control::new(socket, TOKEN, ACCOUNT)
}

async fn send(peer: &mut Peer, event: Value) {
    bounded(peer.send(Message::text(event.to_string())))
        .await
        .unwrap();
}

fn delegation(id: &str, content: Value) -> Value {
    json!({"type":"delegation.created","item":{
        "id":id,"target":"client","type":"delegation","content":content
    }})
}

#[tokio::test]
async fn sideband_keeps_verbatim_drafts_and_only_acknowledges_safe_correlations() {
    let (socket, mut peer) = socket_pair().await;
    let mut client = control(socket);
    send(&mut peer, json!({"type":"session.started"})).await;
    assert_eq!(bounded(client.recv()).await.unwrap(), ControlEvent::Started);

    send(
        &mut peer,
        json!({"type":"session.delegation.created","delegation":{
            "id":"draft_one","type":"delegation","target":"client"
        }}),
    )
    .await;
    assert_eq!(bounded(client.recv()).await.unwrap(), ControlEvent::Other);

    let request = r#"src/GPUPath.ts에서 dispatch("keep_case")를 확인해 줘."#;
    let content = json!([
        {"type":"input_text","text":format!("  {request}\n")},
        {"type":"output_text","text":"NOT owner speech"},
        {"type":"input_text","text":"테스트 2개만 추가해.  "},
    ]);
    send(&mut peer, delegation("draft_one", content.clone())).await;
    assert_eq!(
        bounded(client.recv()).await.unwrap(),
        ControlEvent::Draft {
            id: "draft_one".to_owned(),
            text: Some(format!("{request}\n테스트 2개만 추가해.")),
        },
    );
    bounded(client.draft_result("draft_one", DraftResult::Posted))
        .await
        .unwrap();
    let posted = bounded(peer.next()).await.unwrap().unwrap();
    let posted: Value = serde_json::from_str(posted.to_text().unwrap()).unwrap();
    assert_eq!(posted["type"], "delegation.context.append");
    assert_eq!(posted["delegation_item_id"], "draft_one");
    assert_eq!(posted["channel"], "speakable");
    assert_eq!(posted["content"][0]["type"], "input_text");
    assert!(
        posted["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("written confirmation")
    );
    assert!(
        bounded(client.draft_result("draft_one", DraftResult::Posted))
            .await
            .is_err()
    );

    send(&mut peer, delegation("draft_one", content)).await;
    assert_eq!(bounded(client.recv()).await.unwrap(), ControlEvent::Other);

    send(
        &mut peer,
        json!({"type":"session.delegation.created","delegation":{
            "id":"compact_with_text","type":"delegation","target":"client",
            "content":[{"type":"input_text","text":"Read the README"}]
        }}),
    )
    .await;
    assert_eq!(
        bounded(client.recv()).await.unwrap(),
        ControlEvent::Draft {
            id: "compact_with_text".to_owned(),
            text: Some("Read the README".to_owned()),
        }
    );
    bounded(client.draft_result("compact_with_text", DraftResult::NotPosted))
        .await
        .unwrap();
    let rejected = bounded(peer.next()).await.unwrap().unwrap();
    let rejected: Value = serde_json::from_str(rejected.to_text().unwrap()).unwrap();
    assert_eq!(rejected["delegation_item_id"], "compact_with_text");
    assert!(
        rejected["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("did not confirm posting")
    );
    bounded(client.close()).await;
    assert_session_close(&mut peer).await;
}

async fn assert_session_close(peer: &mut Peer) {
    let close = bounded(peer.next()).await.unwrap().unwrap();
    let close: Value = serde_json::from_str(close.to_text().unwrap()).unwrap();
    assert_eq!(close["type"], "session.close");
    assert!(matches!(
        bounded(peer.next()).await.unwrap().unwrap(),
        Message::Close(_)
    ));
}

#[tokio::test]
async fn rich_sideband_drafts_with_unusable_text_receive_no_text_results() {
    let (socket, mut peer) = socket_pair().await;
    let mut client = control(socket);
    for (id, content) in [
        ("bad_text", json!([{"type":"input_text","text":23}])),
        (
            "positional_part",
            json!([["input_text", "Never project this positional text"]]),
        ),
        (
            "token",
            json!([{"type":"input_text","text":format!("echo {TOKEN}")}]),
        ),
        (
            "account",
            json!([{"type":"input_text","text":format!("echo {ACCOUNT}")}]),
        ),
        (
            "too_long",
            json!([{"type":"input_text","text":"😀".repeat(501)}]),
        ),
        ("empty", json!([{"type":"input_text","text":" \t "} ])),
    ] {
        send(&mut peer, delegation(id, content)).await;
        assert_eq!(
            bounded(client.recv()).await.unwrap(),
            ControlEvent::Draft {
                id: id.to_owned(),
                text: None
            },
        );
        bounded(client.draft_result(id, DraftResult::NoText))
            .await
            .unwrap();
        let result = bounded(peer.next()).await.unwrap().unwrap();
        let wire = result.to_text().unwrap();
        let decoded: Value = serde_json::from_str(wire).unwrap();
        assert_eq!(decoded["delegation_item_id"], id);
        assert!(
            decoded["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("ask them to restate")
        );
        assert!(!wire.contains(TOKEN) && !wire.contains(ACCOUNT));
    }
}

#[tokio::test]
async fn sideband_heartbeat_survives_select_cancellation_and_requires_a_pong() {
    let (socket, mut peer) = socket_pair().await;
    tokio::time::pause();
    let mut client = control(socket);

    let mut receive = Box::pin(client.recv());
    let ping = tokio::select! {
        message = peer.next() => message.unwrap().unwrap(),
        result = &mut receive => panic!("sideband terminated before first ping: {result:?}"),
    };
    assert!(matches!(ping, Message::Ping(_)));
    // Tungstenite queues a matching pong on the server when the ping is read.
    // Cancel the in-flight recv before flushing it, as the media select can.
    drop(receive);
    bounded(peer.flush()).await.unwrap();

    let mut receive = Box::pin(client.recv());
    let next_ping = tokio::select! {
        message = peer.next() => message.unwrap().unwrap(),
        result = &mut receive => panic!("matching pong did not renew the sideband: {result:?}"),
    };
    assert!(matches!(next_ping, Message::Ping(_)));
    assert_ne!(ping, next_ping);

    // Do not flush the automatic second pong.
    let error = timeout(PONG_TIMEOUT + Duration::from_secs(1), receive)
        .await
        .expect("missing pong was not detected by the configured deadline")
        .unwrap_err();
    assert!(error.to_string().contains("heartbeat timed out"));
}

#[tokio::test]
async fn oversized_sideband_frame_drops_the_unusable_transport() {
    let (socket, mut peer) = socket_pair().await;
    let mut client = control(socket);
    let event = json!({"type":"ignored", "text":"x".repeat(MAX_WIRE_BYTES)});
    let (result, _network_write) =
        bounded(async { tokio::join!(client.recv(), peer.send(Message::text(event.to_string()))) })
            .await;
    assert!(result.is_err());
    bounded(client.close()).await;
    assert!(!matches!(
        bounded(peer.next()).await,
        Some(Ok(Message::Text(_)))
    ));
}

#[tokio::test]
async fn terminal_application_events_refuse_receipts_but_still_close_the_session() {
    for event in [
        json!({"type":"error", "message":format!("Reflected {TOKEN} for {ACCOUNT}")}),
        json!({"type":"session.closed"}),
        json!({"type":{"session.started":null}}),
        json!(["session.started"]),
        json!({"type":"delegation.created","item":[
            "positional_draft","delegation","client",[{"type":"input_text","text":"Do not post"}]
        ]}),
        json!({"type":"session.delegation.created","delegation":[
            "positional_compact","delegation","client",[]
        ]}),
        json!({"type":"session.delegation.created","delegation":{
            "id":"positional_part","type":"delegation","target":"client",
            "content":[["input_text","Do not post"]]
        }}),
        delegation("../../malformed", json!([])),
        delegation(
            "too_many",
            json!(vec![json!({"type":"input_text","text":"a"}); MAX_PARTS + 1]),
        ),
    ] {
        let (socket, mut peer) = socket_pair().await;
        let mut client = control(socket);
        send(&mut peer, delegation("pending", json!([]))).await;
        assert_eq!(
            bounded(client.recv()).await.unwrap(),
            ControlEvent::Draft {
                id: "pending".to_owned(),
                text: None,
            },
        );
        send(&mut peer, event).await;
        let error = format!("{:#}", bounded(client.recv()).await.unwrap_err());
        assert!(!error.contains(TOKEN) && !error.contains(ACCOUNT));
        assert!(
            bounded(client.recv())
                .await
                .unwrap_err()
                .to_string()
                .contains("sideband closed")
        );
        assert!(
            bounded(client.draft_result("pending", DraftResult::NoText))
                .await
                .is_err()
        );
        bounded(client.close()).await;
        assert_session_close(&mut peer).await;
    }
}

#[tokio::test]
async fn websocket_close_and_tcp_disconnect_are_terminal() {
    for graceful in [true, false] {
        let (socket, mut peer) = socket_pair().await;
        let mut client = control(socket);
        if graceful {
            bounded(peer.send(Message::Close(None))).await.unwrap();
        }
        drop(peer);
        let result = bounded(client.recv()).await;
        assert!(result.is_err());
        assert!(
            bounded(client.recv())
                .await
                .unwrap_err()
                .to_string()
                .contains("sideband closed")
        );
    }
}

#[tokio::test]
async fn sideband_draft_budget_counts_distinct_rich_ids_even_when_text_is_empty() {
    let (socket, mut peer) = socket_pair().await;
    let mut client = control(socket);
    for n in 0..MAX_DRAFTS {
        let id = format!("draft_{n}");
        send(&mut peer, delegation(&id, json!([]))).await;
        assert_eq!(
            bounded(client.recv()).await.unwrap(),
            ControlEvent::Draft { id, text: None }
        );
    }
    send(&mut peer, delegation("draft_0", json!([]))).await;
    assert_eq!(bounded(client.recv()).await.unwrap(), ControlEvent::Other);
    send(&mut peer, delegation("draft_next", json!([]))).await;
    assert!(
        bounded(client.recv())
            .await
            .unwrap_err()
            .to_string()
            .contains("draft budget")
    );
    bounded(client.close()).await;
    assert_session_close(&mut peer).await;
}
