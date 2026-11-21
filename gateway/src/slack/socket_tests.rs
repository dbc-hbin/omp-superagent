use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Json, Response};
use axum::{Router, routing::post};
use rusqlite::Connection;
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio::sync::{Mutex, Semaphore, mpsc};
use tokio::task::JoinHandle;
use tokio_tungstenite::accept_async;

use crate::adapter::Hub;
use crate::store::Store;

use super::*;
use crate::slack::{Config, Slack, api::Api};

#[path = "card_tests.rs"]
mod cards;
#[path = "picker_tests.rs"]
mod picker;

const LIMIT: Duration = Duration::from_secs(5);
type Peer = WebSocketStream<TcpStream>;

#[derive(Clone)]
struct SlackFixture {
    websocket: SocketAddr,
    traces: mpsc::UnboundedSender<(String, Value)>,
    card: Arc<Mutex<Value>>,
    hold_channel: Arc<Semaphore>,
}

async fn api(
    State(state): State<SlackFixture>,
    Path(method): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let authorization = if method == "apps.connections.open" {
        "Bearer xapp-fixture"
    } else {
        "Bearer xoxb-fixture"
    };
    if headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        != Some(authorization)
    {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({"ok": false, "error": "invalid_auth"})),
        )
            .into_response();
    }
    let args = Value::Object(
        url::form_urlencoded::parse(&body)
            .map(|(key, value)| {
                let parsed = match key.as_ref() {
                    "blocks" | "view" | "files" => {
                        serde_json::from_str(&value).expect("structured Slack form argument")
                    }
                    _ => Value::String(value.into_owned()),
                };
                (key.into_owned(), parsed)
            })
            .collect(),
    );
    if method != "apps.connections.open" && args["team_id"] != "TLOCAL" {
        return Json(json!({"ok":false,"error":"team_not_found"})).into_response();
    }
    state
        .traces
        .send((method.clone(), args.clone()))
        .expect("fixture trace receiver");
    let mut reply = match method.as_str() {
        "auth.test" => json!({"team_id":"TLOCAL","user_id":"UBOT","bot_id":"BBOT"}),
        "bots.info" if args["bot"] == "BBOT" => {
            json!({"bot":{"id":"BBOT","app_id":"ALOCAL","user_id":"UBOT"}})
        }
        "users.info" if args["user"] == "UOWNER" => {
            json!({"user":{"id":"UOWNER","is_bot":false,"team_id":"TLOCAL"}})
        }
        "apps.connections.open" => {
            json!({"url":format!("ws://{}/socket?ticket=fixture",state.websocket)})
        }
        "conversations.info" if args["channel"] == "CWAIT" => {
            state
                .hold_channel
                .acquire()
                .await
                .expect("fixture channel permit")
                .forget();
            json!({"channel":{"id":"CWAIT","is_member":true,"context_team_id":"TLOCAL"}})
        }
        "conversations.info" if args["channel"] == "CALLOWED" => {
            json!({"channel":{"id":"CALLOWED","is_member":true,"context_team_id":"TLOCAL"}})
        }
        "conversations.info" if args["channel"] == "DOWNER" => {
            json!({"channel":{"id":"DOWNER","is_im":true,"user":"UOWNER","context_team_id":"TLOCAL"}})
        }
        "reactions.add" => json!({}),
        "chat.postMessage" => {
            let mut card = args;
            card["ts"] = json!("2000.000001");
            card["type"] = json!("message");
            card["user"] = json!("UBOT");
            card["bot_id"] = json!("BBOT");
            card["team"] = json!("TLOCAL");
            let result = json!({"channel":card["channel"],"ts":card["ts"]});
            *state.card.lock().await = card;
            result
        }
        "conversations.replies" if args["ts"] == "1000.000001" => {
            json!({"messages":[state.card.lock().await.clone()]})
        }
        "chat.update" => {
            let mut card = state.card.lock().await;
            card["blocks"] = args["blocks"].clone();
            card["text"] = args["text"].clone();
            json!({"channel":args["channel"],"ts":args["ts"]})
        }
        "views.open" => json!({"view":{"id":"VMODAL"}}),
        _ => return Json(json!({"ok":false,"error":"invalid_arguments"})).into_response(),
    };
    reply["ok"] = json!(true);
    Json(reply).into_response()
}

struct Fixture {
    root: PathBuf,
    store: Arc<Store>,
    hub: Arc<Hub>,
    websocket: TcpListener,
    traces: mpsc::UnboundedReceiver<(String, Value)>,
    state: SlackFixture,
    server: JoinHandle<()>,
}

impl Fixture {
    async fn new() -> Self {
        let root = std::env::temp_dir().join(format!("omp-slack-rust-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).expect("fixture state directory");
        let store = Arc::new(Store::open(&root).expect("fixture durable store"));
        let websocket = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("fixture WebSocket port");
        let api_listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("fixture API port");
        let api_addr = api_listener.local_addr().expect("fixture API address");
        let (trace_tx, traces) = mpsc::unbounded_channel();
        let state = SlackFixture {
            websocket: websocket.local_addr().expect("fixture websocket address"),
            traces: trace_tx,
            card: Arc::new(Mutex::new(Value::Null)),
            hold_channel: Arc::new(Semaphore::new(0)),
        };
        let app = Router::new()
            .route("/api/{method}", post(api))
            .with_state(state.clone());
        let server = tokio::spawn(async move {
            axum::serve(api_listener, app)
                .await
                .expect("fixture API server")
        });
        let hub = Hub::with_factory(&json!({"slack":{}}), store.clone(), |name, _, ctx| {
            assert_eq!(name, "slack");
            let config = Config {
                bot_token_env: String::new(),
                app_token_env: String::new(),
                owner_id: "UOWNER".into(),
                team_id: "TLOCAL".into(),
                allowed_channel_ids: ["CALLOWED".into(), "CWAIT".into()].into_iter().collect(),
            };
            let api = Api::local(ctx.http.clone(), api_addr);
            Ok(Box::new(Slack::with_api(config, ctx, api)))
        })
        .expect("fixture hub");
        Self {
            root,
            store,
            hub,
            websocket,
            traces,
            state,
            server,
        }
    }

    async fn start(&self, app: &str) -> (Peer, anyhow::Result<()>) {
        let client = self.hub.start();
        let server = self.accept(app);
        timeout(LIMIT, async {
            let (result, peer) = tokio::join!(client, server);
            (peer, result)
        })
        .await
        .expect("fixture app handshake")
    }

    async fn accept(&self, app: &str) -> Peer {
        let (stream, _) = self
            .websocket
            .accept()
            .await
            .expect("Slack adapter connects");
        let mut peer = accept_async(stream).await.expect("upgrade Slack adapter");
        send(
            &mut peer,
            json!({"type":"hello","connection_info":{"app_id":app}}),
        )
        .await;
        peer
    }

    async fn called(&mut self, name: &str) -> Value {
        timeout(LIMIT, async {
            while let Some((method, args)) = self.traces.recv().await {
                if method == name {
                    return args;
                }
            }
            panic!("fixture trace stream closed");
        })
        .await
        .expect("expected Slack API request")
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.abort();
        if let Err(error) = std::fs::remove_dir_all(&self.root) {
            eprintln!("Could not remove Slack fixture directory: {error}");
        }
    }
}

async fn send(peer: &mut Peer, body: Value) {
    peer.send(Message::Text(body.to_string().into()))
        .await
        .expect("send Slack envelope");
}

async fn ack(peer: &mut Peer) -> Value {
    timeout(LIMIT, async {
        loop {
            match peer
                .next()
                .await
                .expect("active Slack connection")
                .expect("Slack WebSocket frame")
            {
                Message::Text(text) => {
                    return serde_json::from_str(&text).expect("Slack wire ACK JSON");
                }
                Message::Ping(_) => peer.flush().await.expect("pong"),
                frame => panic!("unexpected Slack wire frame: {frame:?}"),
            }
        }
    })
    .await
    .expect("Slack envelope ACK")
}

fn message(envelope: &str, channel: &str, text: &str) -> Value {
    json!({
        "type":"events_api", "envelope_id":envelope, "accepts_response_payload":false,
        "payload": {"type":"event_callback","team_id":"TLOCAL","api_app_id":"ALOCAL",
            "event":{"type":"message","channel":channel,"user":"UOWNER","ts":"1000.000001","text":text}},
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn real_socket_waits_for_ready_and_sqlite_then_acks_exact_delivery() {
    let mut fixture = Fixture::new().await;
    let (mut peer, started) = fixture.start("ALOCAL").await;
    started.expect("authenticated Slack adapter");
    send(&mut peer, message("first", "CWAIT", "!help")).await;
    peer.send(Message::Ping(vec![41].into()))
        .await
        .expect("server ping");
    let frame = timeout(LIMIT, peer.next())
        .await
        .expect("peer heartbeat")
        .expect("pong frame")
        .expect("pong response");
    assert_eq!(frame, Message::Pong(vec![41].into()));
    assert!(
        fixture
            .store
            .next(None)
            .expect("read durable queue")
            .is_none()
    );
    fixture.hub.ready.send(true).expect("open native readiness");
    fixture.called("conversations.info").await;
    let mut writer = Connection::open(fixture.root.join("coordination.sqlite"))
        .expect("independent SQLite writer");
    let transaction = writer
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .expect("block admission");
    fixture.state.hold_channel.add_permits(1);
    assert!(
        timeout(Duration::from_millis(200), peer.next())
            .await
            .is_err(),
        "ACK arrived before SQLite commit"
    );
    transaction
        .rollback()
        .expect("let durable admission commit");
    assert_eq!(ack(&mut peer).await, json!({"envelope_id":"first"}));
    let row = fixture
        .store
        .next(None)
        .expect("read admitted event")
        .expect("durable input");
    assert_eq!(
        row.event["input"]["id"],
        "slack:TLOCAL:UBOT:CWAIT:1000.000001:original"
    );
    assert_eq!(row.event["input"]["messageId"], "1000.000001");
    assert_eq!(row.event["input"]["text"], "/help");
    fixture.state.hold_channel.add_permits(2);
    send(&mut peer, message("retry", "CWAIT", "!help")).await;
    assert_eq!(ack(&mut peer).await, json!({"envelope_id":"retry"}));
    assert_eq!(fixture.store.pending().expect("read pending count"), 1);
    let mut command = json!({
        "type":"slash_commands", "envelope_id":"slash", "accepts_response_payload":true,
        "payload":{
            "api_app_id":"ALOCAL", "team_id":"TLOCAL", "channel_id":"CALLOWED", "user_id":"UOWNER",
            "command":"/superagent-model", "text":" inspect preset ", "trigger_id":"opaque-private-trigger",
            "response_url":"https://hooks.slack.com/private-response", "token":"legacy-private-token",
        },
    });
    send(&mut peer, command.clone()).await;
    let response = ack(&mut peer).await;
    assert_eq!(response["envelope_id"], "slash");
    assert_eq!(response["payload"]["response_type"], "ephemeral");
    let slash = fixture
        .store
        .next(Some(row.sequence + 1))
        .expect("look for command")
        .expect("durable slash command");
    let input = &slash.event["input"];
    assert_eq!(
        input["id"],
        "slack:TLOCAL:UBOT:CALLOWED:invocation:4be65ca744d2fd22157216f5fc34a722497147182acdce731a5c598496d83a57"
    );
    assert!(input["messageId"].is_null());
    assert_eq!(input["text"], "/model inspect preset");
    assert!(!input.to_string().contains("private-"));
    command["envelope_id"] = json!("slash-retry");
    command["accepts_response_payload"] = json!(false);
    send(&mut peer, command).await;
    assert_eq!(ack(&mut peer).await, json!({"envelope_id":"slash-retry"}));
    assert_eq!(fixture.store.pending().expect("deduped slash command"), 2);
    fixture.hub.stop().await.expect("stop Slack adapter");
}

#[tokio::test]
async fn startup_and_reconnect_require_fresh_matching_slack_hello() {
    let bad = Fixture::new().await;
    let (_peer, result) = bad.start("AOTHER").await;
    assert!(
        result
            .expect_err("foreign application must not start")
            .to_string()
            .contains("does not match")
    );

    let fixture = Fixture::new().await;
    let (mut peer, result) = fixture.start("ALOCAL").await;
    result.expect("matching app starts");
    fixture.hub.ready.send(true).expect("open native readiness");
    peer.close(None)
        .await
        .expect("drop old Socket Mode transport");
    let mut replacement = timeout(LIMIT, fixture.accept("AOTHER"))
        .await
        .expect("replacement socket");
    assert!(
        timeout(LIMIT, replacement.next())
            .await
            .expect("foreign connection closed")
            .is_none_or(|frame| !matches!(frame, Ok(Message::Text(_))))
    );
    assert!(fixture.store.next(None).expect("inspect ingress").is_none());
    let mut restored = timeout(LIMIT, fixture.accept("ALOCAL"))
        .await
        .expect("matching replacement socket");
    send(&mut restored, message("restored", "CALLOWED", "authorized")).await;
    assert_eq!(ack(&mut restored).await, json!({"envelope_id":"restored"}));
    let row = fixture
        .store
        .next(None)
        .expect("inspect ingress")
        .expect("reconnect marker");
    assert_eq!(row.event["kind"], "reconnect");
    assert_eq!(fixture.store.pending().expect("inspect pending ingress"), 2);
    fixture.hub.stop().await.expect("stop Slack adapter");
}
