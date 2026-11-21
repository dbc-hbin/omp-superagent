use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use anyhow::{Context as _, Result, ensure};
use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::post,
};
use serde_json::{Value, json};
use tokio::{
    net::TcpListener,
    sync::{mpsc, oneshot},
    task::JoinSet,
    time::timeout,
};
use uuid::Uuid;

use crate::{adapter::Hub, store::Store};

use super::Telegram;

mod contract;
mod faults;
mod picker;

const WAIT: Duration = Duration::from_secs(5);

struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Result<Self> {
        let path = std::env::temp_dir().join(format!("omp-telegram-{}", Uuid::new_v4()));
        std::fs::create_dir(&path)?;
        Ok(Self(path))
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        if let Err(error) = std::fs::remove_dir_all(&self.0) {
            eprintln!("Telegram test directory cleanup failed: {error}");
        }
    }
}

enum Call {
    Poll(Value, oneshot::Sender<Value>),
    Feedback(Value, oneshot::Sender<Value>),
}

#[derive(Clone)]
struct Remote {
    calls: mpsc::Sender<Call>,
    card: Arc<Mutex<Option<Value>>>,
    card_writes: Arc<AtomicUsize>,
    card_fault: Arc<Mutex<Option<CardFault>>>,
}

struct CardFault {
    status: StatusCode,
    body: &'static str,
    apply: bool,
}

async fn telegram_http(
    State(remote): State<Remote>,
    Path(method): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    let result = match method.as_str() {
        "getMe" => json!({"id":900,"is_bot":true,"username":"room_bot","has_topics_enabled":true}),
        "getWebhookInfo" => json!({"url":""}),
        "getChat" => chat(&body["chat_id"]),
        "getUpdates" | "answerCallbackQuery" => {
            let (tx, rx) = oneshot::channel();
            let call = if method == "getUpdates" {
                Call::Poll(body, tx)
            } else {
                Call::Feedback(body, tx)
            };
            assert!(
                remote.calls.send(call).await.is_ok(),
                "test observer dropped"
            );
            match rx.await {
                Ok(value) => value,
                Err(_) => {
                    return (
                        StatusCode::SERVICE_UNAVAILABLE,
                        Json(json!({"ok":false,"error_code":503})),
                    )
                        .into_response();
                }
            }
        }
        "sendMessage" | "editMessageText" => {
            remote.card_writes.fetch_add(1, Ordering::Relaxed);
            let fault = remote.card_fault.lock().expect("card fault").take();
            let mut card = remote.card.lock().expect("card state");
            let destination = chat(&body["chat_id"]);
            let mut result = if method == "sendMessage" {
                json!({
                    "message_id":123,"date":100,"chat":destination,
                    "message_thread_id":body["message_thread_id"],
                    "from":{"id":900,"is_bot":true}
                })
            } else {
                let original = card.as_ref().expect("original card exists");
                assert_eq!(original["chat"], destination);
                assert_eq!(original["message_id"], body["message_id"]);
                original.clone()
            };
            result["text"] = body["text"].clone();
            result["reply_markup"] = body["reply_markup"].clone();
            if fault.as_ref().is_none_or(|fault| fault.apply) {
                *card = Some(result.clone());
            }
            if let Some(fault) = fault {
                return (fault.status, fault.body).into_response();
            }
            result
        }
        "editMessageReplyMarkup" => {
            let mut card = remote.card.lock().expect("card state");
            let card = card.as_mut().expect("original card exists");
            card["reply_markup"] = body["reply_markup"].clone();
            card.clone()
        }
        "setMessageReaction" => json!(true),
        _ => panic!("Unexpected Telegram request: {method}"),
    };
    Json(json!({"ok":true,"result":result})).into_response()
}

struct Fixture {
    hub: Arc<Hub>,
    store: Arc<Store>,
    calls: mpsc::Receiver<Call>,
    remote: Remote,
    base: String,
    _server: JoinSet<()>,
    _scratch: Scratch,
}

impl Fixture {
    async fn start() -> Result<Self> {
        let scratch = Scratch::new()?;
        let store = Arc::new(Store::open(&scratch.0)?);
        let (tx, calls) = mpsc::channel(4);
        let remote = Remote {
            calls: tx,
            card: Arc::default(),
            card_writes: Arc::default(),
            card_fault: Arc::default(),
        };
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let base = format!("http://{}", listener.local_addr()?);
        let service = Router::new()
            .route("/bot900:LOCAL_TEST_ONLY/{method}", post(telegram_http))
            .with_state(remote.clone());
        let mut server = JoinSet::new();
        server.spawn(async move {
            axum::serve(listener, service)
                .await
                .expect("Telegram fixture HTTP server");
        });
        let hub = test_hub(&store, &base).await?;
        Ok(Self {
            hub,
            store,
            calls,
            remote,
            base,
            _server: server,
            _scratch: scratch,
        })
    }

    async fn call(&mut self) -> Result<Call> {
        timeout(WAIT, self.calls.recv())
            .await?
            .context("Telegram fixture disconnected")
    }

    async fn poll(&mut self) -> Result<(Value, oneshot::Sender<Value>)> {
        match self.call().await? {
            Call::Poll(payload, result) => Ok((payload, result)),
            Call::Feedback(payload, _) => anyhow::bail!("Unexpected callback feedback: {payload}"),
        }
    }

    async fn callback_feedback(
        &mut self,
        query: &str,
        expired: bool,
    ) -> Result<oneshot::Sender<Value>> {
        let Call::Feedback(payload, result) = self.call().await? else {
            anyhow::bail!("Telegram polled again before callback feedback");
        };
        assert_eq!(payload["callback_query_id"], query);
        assert_eq!(payload.get("text").is_some(), expired);
        Ok(result)
    }

    async fn feedback(&mut self, query: &str, expired: bool) -> Result<()> {
        let result = self.callback_feedback(query, expired).await?;
        if expired {
            assert!(self.store.next(None)?.is_none());
        } else {
            let event = self
                .store
                .next(None)?
                .context("Callback ACK preceded durable answer")?;
            assert_eq!(
                event.event,
                json!({
                    "kind":"answer","approvalId":"a-original","response":{"confirmed":true},"route":route()
                })
            );
        }
        result.send(json!(true)).expect("response receiver");
        Ok(())
    }
}

async fn test_hub(store: &Arc<Store>, base: &str) -> Result<Arc<Hub>> {
    let hub = Hub::with_factory(
        &json!({"telegram":{}}),
        store.clone(),
        |platform, _, ctx| {
            ensure!(platform == "telegram");
            Ok(Box::new(Telegram::test_instance(ctx, base)?))
        },
    )?;
    hub.start().await?;
    Ok(hub)
}

fn group() -> Value {
    json!({"id":-100,"type":"supergroup","is_forum":true})
}

fn chat(id: &Value) -> Value {
    match id.as_str() {
        Some("42") => json!({"id":42,"type":"private"}),
        Some("-100") => group(),
        _ => panic!("Unexpected Telegram chat: {id}"),
    }
}

fn route() -> Value {
    json!({"platform":"telegram","accountId":"900","authorityId":"42",
        "guildId":"-100","channelId":"-100","threadId":"7"})
}
