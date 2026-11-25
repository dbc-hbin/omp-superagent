use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

use anyhow::{Result, ensure};
use axum::{
    Json, Router,
    extract::{RawQuery, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde_json::{Value, json};
use tokio::{net::TcpListener, task::JoinSet, time::timeout};
use uuid::Uuid;

use crate::{adapter::Hub, store::Store};

use super::{CHUNK_CHARS, InboxItem, Kakao, MAX_INBOX_BYTES, PAGE_LIMIT, Policy, chunks, loopback_url, plain_text};

struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Result<Self> {
        let path = std::env::temp_dir().join(format!("omp-kakao-{}", Uuid::new_v4()));
        std::fs::create_dir(&path)?;
        Ok(Self(path))
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[derive(Clone, Default)]
struct Bridge {
    html: Arc<Mutex<bool>>,
    /// Replace the inbox body with this many filler bytes (contract violation).
    oversized: Arc<Mutex<Option<usize>>>,
    /// Ignore the requested limit and return every row (contract violation).
    ignore_limit: Arc<Mutex<bool>>,
    /// Answer the inbox with a redirect to another local path.
    redirect: Arc<Mutex<bool>>,
    redirected: Arc<Mutex<bool>>,
    generation: Arc<Mutex<String>>,
    inbox: Arc<Mutex<Vec<Value>>>,
    pushes: Arc<Mutex<Vec<Value>>>,
    seen_push_ids: Arc<Mutex<Vec<String>>>,
    quiet: Arc<Mutex<bool>>,
    /// Refuse every push with 400 (a final rejection).
    refuse: Arc<Mutex<bool>>,
}

fn authorized(headers: &HeaderMap) -> bool {
    headers
        .get("X-Superagent-Token")
        .is_some_and(|value| value == "test-token")
}

async fn inbox(
    State(bridge): State<Bridge>,
    headers: HeaderMap,
    RawQuery(query): RawQuery,
) -> Response {
    if !authorized(&headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let query: std::collections::HashMap<String, String> =
        url::form_urlencoded::parse(query.unwrap_or_default().as_bytes()).into_owned().collect();
    let after: u64 = query.get("after").and_then(|v| v.parse::<u64>().ok()).unwrap_or(0);
    let generation = bridge.generation.lock().expect("generation").clone();
    let inbox = bridge.inbox.lock().expect("inbox");
    let latest = inbox.iter().filter_map(|row| row["id"].as_u64()).max().unwrap_or(0);
    let current = query.get("generation").is_some_and(|value| *value == generation);
    let limit: usize = query.get("limit").and_then(|v| v.parse().ok()).unwrap_or(PAGE_LIMIT);
    let limit = if *bridge.ignore_limit.lock().expect("limit") { usize::MAX } else { limit };
    let rows: Vec<Value> = if current {
        inbox.iter().filter(|row| row["id"].as_u64().is_some_and(|id| id > after)).take(limit).cloned().collect()
    } else {
        Vec::new()
    };
    if *bridge.redirect.lock().expect("redirect") {
        return (StatusCode::TEMPORARY_REDIRECT, [("location", "/elsewhere")]).into_response();
    }
    if let Some(size) = *bridge.oversized.lock().expect("oversized") {
        // A valid page padded with whitespace: only the byte limit can refuse it.
        let page = json!({"generation":generation,"latest":latest,"messages": rows}).to_string();
        let filler = " ".repeat(size.saturating_sub(page.len()));
        return ([("content-type", "application/json")], format!("{filler}{page}")).into_response();
    }
    if *bridge.html.lock().expect("html") {
        return (StatusCode::OK, "<html>old bridge</html>").into_response();
    }
    Json(json!({"generation":generation,"latest":latest,"messages": rows})).into_response()
}

async fn push(State(bridge): State<Bridge>, headers: HeaderMap, Json(body): Json<Value>) -> Response {
    if !authorized(&headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if *bridge.refuse.lock().expect("refuse") {
        return StatusCode::BAD_REQUEST.into_response();
    }
    if *bridge.quiet.lock().expect("quiet") {
        return (StatusCode::CONFLICT, Json(json!({"ok":false,"suppressed":true}))).into_response();
    }
    let id = body["pushId"].as_str().unwrap_or_default().to_owned();
    let mut seen = bridge.seen_push_ids.lock().expect("seen");
    let duplicate = seen.contains(&id);
    if !duplicate {
        seen.push(id);
        bridge.pushes.lock().expect("pushes").push(body);
    }
    Json(json!({"ok":true,"state": if duplicate {"delivered"} else {"queued"}})).into_response()
}

async fn elsewhere(State(bridge): State<Bridge>) -> Response {
    *bridge.redirected.lock().expect("redirected") = true;
    StatusCode::NOT_FOUND.into_response()
}

struct Fixture {
    hub: Arc<Hub>,
    store: Arc<Store>,
    bridge: Bridge,
    _server: JoinSet<()>,
    _scratch: Scratch,
}

impl Fixture {
    async fn start() -> Result<Self> {
        let scratch = Scratch::new()?;
        let store = Arc::new(Store::open(&scratch.0)?);
        let bridge = Bridge::default();
        *bridge.generation.lock().expect("generation") = "gen-1".into();
        // A row that predates the adapter must never be replayed as new work.
        bridge.inbox.lock().expect("inbox").push(owner_row(1, "10", "old command"));
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let base = format!("http://{}", listener.local_addr()?);
        let service = Router::new()
            .route("/superagent/inbox", get(inbox))
            .route("/superagent/send", post(push))
            .route("/elsewhere", get(elsewhere))
            .with_state(bridge.clone());
        let mut server = JoinSet::new();
        server.spawn(async move {
            axum::serve(listener, service).await.expect("Kakao fixture HTTP server");
        });
        let hub = Hub::with_factory(&json!({"kakao":{}}), store.clone(), |platform, _, ctx| {
            ensure!(platform == "kakao");
            Ok(Box::new(Kakao::test_instance(ctx, &base)?))
        })?;
        hub.start().await?;
        hub.ready.send_replace(true);
        Ok(Self { hub, store, bridge, _server: server, _scratch: scratch })
    }

    fn add(&self, row: Value) {
        self.bridge.inbox.lock().expect("inbox").push(row);
    }

    async fn baseline(&self) -> Result<()> {
        timeout(Duration::from_secs(5), async {
            while self.store.get_meta(CURSOR)?.is_none() {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            Ok::<_, anyhow::Error>(())
        })
        .await?
    }

    async fn next_event(&self) -> Result<Value> {
        timeout(Duration::from_secs(5), async {
            loop {
                if let Some(event) = self.store.next(None)? {
                    self.store.receipt(event.sequence, crate::store::GatewayReceipt::Accepted)?;
                    return Ok(event.event);
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await?
    }
}

const CURSOR: &str = "kakao:900:777:inbox-cursor";

fn owner_row(id: u64, log: &str, text: &str) -> Value {
    json!({"id":id,"logId":log,"chatId":"777","senderId":"42","text":text,"receivedAtMs":1_700_000_000_000u64})
}

fn route() -> Value {
    json!({"platform":"kakao","accountId":"900","authorityId":"42","guildId":null,"channelId":"777","threadId":null})
}

#[tokio::test]
async fn admits_owner_messages_once_and_ignores_others() -> Result<()> {
    let fixture = Fixture::start().await?;
    fixture.baseline().await?;
    fixture.add(json!({"id":2,"logId":"11","chatId":"777","senderId":"5","text":"not owner","receivedAtMs":1}));
    fixture.add(json!({"id":3,"logId":"12","chatId":"999","senderId":"42","text":"other room","receivedAtMs":1}));
    fixture.add(owner_row(4, "13", "  상태 알려줘  "));
    let event = fixture.next_event().await?;
    assert_eq!(event["kind"], "message");
    assert_eq!(event["input"]["id"], "kakao:900:777:13");
    assert_eq!(event["input"]["text"], "상태 알려줘");
    assert_eq!(event["input"]["messageId"], "13");
    assert_eq!(event["input"]["route"], route());
    // A replayed bridge row (cursor loss) is the same durable identity, not new work.
    fixture.add(owner_row(5, "13", "상태 알려줘"));
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert!(fixture.store.next(None)?.is_none());
    assert_eq!(
        fixture.store.get_meta(CURSOR)?.as_deref(),
        Some(r#"{"generation":"gen-1","after":5}"#)
    );
    fixture.hub.stop().await
}

#[tokio::test]
async fn send_is_chunked_prefixed_and_idempotent() -> Result<()> {
    let fixture = Fixture::start().await?;
    let long = "가".repeat(CHUNK_CHARS + 10);
    let output = json!({"id":"out-1","route":route(),"text":long});
    let first = fixture.hub.effect("send", &[output.clone()]).await.map_err(|e| anyhow::anyhow!(e.message))?;
    let again = fixture.hub.effect("send", &[output]).await.map_err(|e| anyhow::anyhow!(e.message))?;
    assert_eq!(first, again);
    let pushes = fixture.bridge.pushes.lock().expect("pushes").clone();
    assert_eq!(pushes.len(), 2, "retry must not deliver twice");
    assert!(pushes[0]["message"].as_str().is_some_and(|m| m.starts_with("가")), "no marker");
    assert!(pushes[0].get("room").is_none(), "the bridge, not the adapter, fixes the room");
    fixture.hub.stop().await
}

#[tokio::test]
async fn rejects_foreign_routes_and_threads() -> Result<()> {
    let fixture = Fixture::start().await?;
    let mut group = route();
    group["guildId"] = json!("777");
    let error = fixture
        .hub
        .effect("send", &[json!({"id":"x","route":group,"text":"hi"})])
        .await
        .expect_err("group route must be refused");
    assert_eq!(error.certainty, "rejected");
    let mut other = route();
    other["channelId"] = json!("778");
    assert!(fixture.hub.effect("assertRoute", &[other]).await.is_err());
    assert_eq!(fixture.hub.effect("canCreateThread", &[route()]).await.ok(), Some(json!(false)));
    assert!(fixture.bridge.pushes.lock().expect("pushes").is_empty());
    fixture.hub.stop().await
}

#[tokio::test]
async fn quiet_room_is_a_rejected_retryable_send() -> Result<()> {
    let fixture = Fixture::start().await?;
    *fixture.bridge.quiet.lock().expect("quiet") = true;
    let error = fixture
        .hub
        .effect("send", &[json!({"id":"q","route":route(),"text":"hi"})])
        .await
        .expect_err("quiet room");
    assert_eq!(error.certainty, "rejected");
    assert_eq!(error.retry_after_ms, Some(60_000));
    fixture.hub.stop().await
}

#[tokio::test]
async fn approval_is_cancelled_never_accepted() -> Result<()> {
    let fixture = Fixture::start().await?;
    let approval = json!({"id":"a-1","route":route(),"request":{"method":"confirm"}});
    fixture.hub.effect("showApproval", &[approval]).await.map_err(|e| anyhow::anyhow!(e.message))?;
    let event = fixture.next_event().await?;
    assert_eq!(event["kind"], "answer");
    assert_eq!(event["response"], json!({"cancelled":true}));
    assert_eq!(fixture.bridge.pushes.lock().expect("pushes").len(), 1);
    fixture.hub.stop().await
}

#[test]
fn inbound_requires_exact_owner_identity() -> Result<()> {
    let policy = Policy::new("900", "42", "777")?;
    let item = |chat: &str, sender: &str, log: &str, text: &str| InboxItem {
        id: 1,
        stale: false,
        log_id: log.into(),
        chat_id: chat.into(),
        sender_id: sender.into(),
        text: text.into(),
        received_at_ms: 1,
    };
    assert!(policy.inbound(&item("777", "42", "5", "hi")).is_some());
    assert!(policy.inbound(&item("777", "43", "5", "hi")).is_none());
    assert!(policy.inbound(&item("777", "42", "05", "hi")).is_none());
    assert!(policy.inbound(&item("777", "42", "5", "   ")).is_none());
    assert!(Policy::new("42", "42", "777").is_err());
    Ok(())
}

#[test]
fn chunks_prefer_line_breaks_and_drop_nothing() {
    let text = format!("{}\n{}", "a".repeat(8), "b".repeat(8));
    assert_eq!(chunks(&text, 10), vec!["a".repeat(8), "b".repeat(8)]);
    let joined: String = chunks(&"가".repeat(25), 10).concat();
    assert_eq!(joined, "가".repeat(25));
    assert!(chunks("   ", 10).is_empty());
}

#[tokio::test]
async fn baseline_skips_history_and_new_generation_resets() -> Result<()> {
    let fixture = Fixture::start().await?;
    fixture.baseline().await?;
    // The pre-existing row 1 was not admitted.
    assert!(fixture.store.next(None)?.is_none());
    // Inbox rebuilt: lower IDs under a new generation must still be seen after re-baselining.
    *fixture.bridge.generation.lock().expect("generation") = "gen-2".into();
    fixture.bridge.inbox.lock().expect("inbox").clear();
    timeout(Duration::from_secs(5), async {
        while fixture.store.get_meta(CURSOR)?.as_deref() != Some(r#"{"generation":"gen-2","after":0}"#) {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        Ok::<_, anyhow::Error>(())
    })
    .await??;
    fixture.add(owner_row(1, "20", "새 세대 첫 질문"));
    let event = fixture.next_event().await?;
    assert_eq!(event["input"]["id"], "kakao:900:777:20");
    fixture.hub.stop().await
}

#[tokio::test]
async fn stale_rows_are_reported_not_executed() -> Result<()> {
    let fixture = Fixture::start().await?;
    fixture.baseline().await?;
    let mut row = owner_row(2, "30", "어제 밀린 명령");
    row["stale"] = json!(true);
    fixture.add(row);
    timeout(Duration::from_secs(5), async {
        while fixture.bridge.pushes.lock().expect("pushes").is_empty() {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await?;
    assert!(fixture.store.next(None)?.is_none());
    fixture.hub.stop().await
}

#[tokio::test]
async fn refused_stale_notice_does_not_stall_intake() -> Result<()> {
    let fixture = Fixture::start().await?;
    fixture.baseline().await?;
    *fixture.bridge.refuse.lock().expect("refuse") = true;
    let mut row = owner_row(2, "31", "old");
    row["stale"] = json!(true);
    fixture.add(row);
    fixture.add(owner_row(3, "32", "fresh"));
    let event = fixture.next_event().await?;
    assert_eq!(event["input"]["id"], "kakao:900:777:32");
    fixture.hub.stop().await
}

#[tokio::test]
async fn long_markdown_reply_is_plain_and_unmarked_in_every_chunk() -> Result<()> {
    let fixture = Fixture::start().await?;
    let long = format!("## 제목\n\n- **굵게** 항목\n{}\n끝 질문?", "가".repeat(CHUNK_CHARS));
    fixture.hub.effect("send", &[json!({"id":"m","route":route(),"text":long})]).await
        .map_err(|e| anyhow::anyhow!(e.message))?;
    let pushes = fixture.bridge.pushes.lock().expect("pushes").clone();
    assert!(pushes.len() >= 2);
    assert!(pushes[0]["message"].as_str().is_some_and(|m| m.starts_with("제목\n\n• 굵게 항목")));
    for push in &pushes {
        let message = push["message"].as_str().unwrap_or_default();
        assert!(!message.contains("[헤드]") && !message.contains("**") && !message.contains("##"), "{message}");
        assert!(message.chars().count() <= CHUNK_CHARS);
    }
    fixture.hub.stop().await
}

#[test]
fn markdown_becomes_kakao_plain_text() {
    let input = "# 날씨\n\n**지금(15시)**: 기온 `2도`\n- 첫째\n  * 둘째\n1. 번호는 유지\n\n| 시간 | 기온 |\n|---|---:|\n| 15시 | 2도 |\n\n```bash\nls -la\n```\n[기상청](https://www.weather.go.kr) 참고\n> 인용\n---\nsnake_case_name 과 _강조_";
    let expected = "날씨\n\n지금(15시): 기온 2도\n• 첫째\n  • 둘째\n1. 번호는 유지\n\n시간 / 기온\n15시 / 2도\n\nls -la\n기상청 https://www.weather.go.kr 참고\n인용\nsnake_case_name 과 강조";
    assert_eq!(plain_text(input), expected);
    assert_eq!(plain_text("   "), "");
    assert_eq!(plain_text("하루 3~4잔, ~~취소~~"), "하루 3∼4잔, 취소");
}

#[tokio::test]
async fn rollback_behind_cursor_rebaselines_without_losing_new_rows() -> Result<()> {
    let fixture = Fixture::start().await?;
    fixture.baseline().await?;
    fixture.add(owner_row(2, "40", "첫째"));
    fixture.next_event().await?;
    // Inbox restored from an older backup under a new generation: ids restart below the cursor.
    {
        *fixture.bridge.generation.lock().expect("generation") = "gen-3".into();
        let mut inbox = fixture.bridge.inbox.lock().expect("inbox");
        inbox.clear();
        inbox.push(owner_row(1, "41", "복구 뒤 새 질문"));
    }
    let event = fixture.next_event().await?;
    assert_eq!(event["input"]["id"], "kakao:900:777:41");
    fixture.hub.stop().await
}

#[tokio::test]
async fn html_from_an_old_bridge_is_reported_without_moving_the_cursor() -> Result<()> {
    let fixture = Fixture::start().await?;
    fixture.baseline().await?;
    let before = fixture.store.get_meta(CURSOR)?;
    *fixture.bridge.html.lock().expect("html") = true;
    fixture.add(owner_row(2, "50", "html 동안 온 글"));
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert_eq!(fixture.store.get_meta(CURSOR)?, before);
    *fixture.bridge.html.lock().expect("html") = false;
    let event = fixture.next_event().await?;
    assert_eq!(event["input"]["id"], "kakao:900:777:50");
    fixture.hub.stop().await
}

#[test]
fn bridge_url_must_be_literal_loopback() {
    let ok = |raw: &str| loopback_url(&url::Url::parse(raw).expect("url"));
    assert!(ok("http://127.0.0.1:8080"));
    assert!(ok("http://127.0.0.1:8080/kakao/"));
    assert!(ok("http://[::1]:8080"));
    assert!(ok("http://127.0.0.1"));
    for bad in [
        "http://localhost:8080",
        "http://0.0.0.0:8080",
        "http://[::]:8080",
        "http://127.0.0.2:8080",
        "http://[::ffff:127.0.0.1]:8080",
        "https://127.0.0.1:8080",
        "http://user:pass@127.0.0.1:8080",
        "http://127.0.0.1:8080/?token=x",
        "http://127.0.0.1:8080/#x",
        "http://bridge.example:8080",
    ] {
        assert!(!ok(bad), "{bad} must be refused");
    }
}

async fn cursor_holds_while(fixture: &Fixture, violation: impl FnOnce(&Bridge), undo: impl FnOnce(&Bridge)) -> Result<()> {
    fixture.baseline().await?;
    let before = fixture.store.get_meta(CURSOR)?;
    violation(&fixture.bridge);
    fixture.add(owner_row(200, "60", "during violation"));
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert_eq!(fixture.store.get_meta(CURSOR)?, before, "a violating page must not move the cursor");
    assert!(fixture.store.next(None)?.is_none(), "a violating page must not admit rows");
    undo(&fixture.bridge);
    let event = fixture.next_event().await?;
    assert_eq!(event["input"]["id"], "kakao:900:777:60");
    Ok(())
}

#[tokio::test]
async fn oversized_inbox_body_is_refused_without_moving_the_cursor() -> Result<()> {
    let fixture = Fixture::start().await?;
    cursor_holds_while(
        &fixture,
        |bridge| *bridge.oversized.lock().expect("oversized") = Some(MAX_INBOX_BYTES + 1),
        |bridge| *bridge.oversized.lock().expect("oversized") = None,
    )
    .await?;
    fixture.hub.stop().await
}

#[tokio::test]
async fn page_above_the_requested_limit_is_refused() -> Result<()> {
    let fixture = Fixture::start().await?;
    fixture.baseline().await?;
    let before = fixture.store.get_meta(CURSOR)?;
    *fixture.bridge.ignore_limit.lock().expect("limit") = true;
    {
        let mut inbox = fixture.bridge.inbox.lock().expect("inbox");
        for id in 0..=PAGE_LIMIT as u64 {
            inbox.push(owner_row(2 + id, &(1000 + id).to_string(), "x"));
        }
    }
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert_eq!(fixture.store.get_meta(CURSOR)?, before, "an over-limit page must not move the cursor");
    assert!(fixture.store.next(None)?.is_none(), "an over-limit page must not admit rows");
    *fixture.bridge.ignore_limit.lock().expect("limit") = false;
    let event = fixture.next_event().await?;
    assert_eq!(event["input"]["id"], "kakao:900:777:1000");
    fixture.hub.stop().await
}

#[tokio::test]
async fn bridge_redirects_are_not_followed() -> Result<()> {
    let fixture = Fixture::start().await?;
    fixture.baseline().await?;
    *fixture.bridge.redirect.lock().expect("redirect") = true;
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert!(!*fixture.bridge.redirected.lock().expect("redirected"), "the token must not follow a redirect");
    fixture.hub.stop().await
}

/// Protocol interop: drive this adapter against the TypeScript reference bridge
/// (scripts/kakao-reference-bridge.ts) as a separate process. Needs Bun on PATH;
/// run with `KAKAO_REFERENCE_BRIDGE=1 cargo test kakao::tests::reference_bridge`.
#[tokio::test]
async fn reference_bridge_round_trip() -> Result<()> {
    if std::env::var_os("KAKAO_REFERENCE_BRIDGE").is_none() {
        return Ok(());
    }
    use tokio::io::{AsyncBufReadExt, BufReader};
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/kakao-reference-bridge.ts");
    let mut child = tokio::process::Command::new("bun")
        .arg(&script)
        .env("KAKAO_SUPERAGENT_TOKEN", "reference-demo-token-0123456789")
        .env("KAKAO_OWNER_CHAT_ID", "777")
        .env("KAKAO_OWNER_ID", "42")
        .stdout(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    let mut lines = BufReader::new(child.stdout.take().expect("stdout")).lines();
    let base = timeout(Duration::from_secs(10), lines.next_line()).await??.expect("bridge URL");
    let scratch = Scratch::new()?;
    let store = Arc::new(Store::open(&scratch.0)?);
    let url = base.clone();
    let hub = Hub::with_factory(&json!({"kakao":{}}), store.clone(), move |_, _, ctx| {
        Ok(Box::new(Kakao::test_instance_with_token(ctx, &url, "reference-demo-token-0123456789")?))
    })?;
    hub.start().await?;
    hub.ready.send_replace(true);
    // Wait for the baseline, then inject an owner message through the demo endpoint.
    timeout(Duration::from_secs(10), async {
        while store.get_meta(CURSOR)?.is_none() {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        Ok::<_, anyhow::Error>(())
    })
    .await??;
    let client = reqwest::Client::builder().no_proxy().build()?;
    let injected = client
        .post(format!("{base}/demo/owner-message"))
        .header("X-Superagent-Token", "reference-demo-token-0123456789")
        .json(&json!({"logId":"5001","text":"ping from the owner"}))
        .send()
        .await?;
    ensure!(injected.status().is_success());
    let event = timeout(Duration::from_secs(10), async {
        loop {
            if let Some(event) = store.next(None)? {
                return Ok::<_, anyhow::Error>(event.event);
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await??;
    assert_eq!(event["input"]["id"], "kakao:900:777:5001");
    assert_eq!(event["input"]["text"], "ping from the owner");
    let output = json!({"id":"reply-1","route":route(),"text":"**pong** from HEAD"});
    let first = hub.effect("send", &[output.clone()]).await.map_err(|e| anyhow::anyhow!(e.message))?;
    let again = hub.effect("send", &[output]).await.map_err(|e| anyhow::anyhow!(e.message))?;
    assert_eq!(first, again);
    let reply = timeout(Duration::from_secs(10), lines.next_line()).await??.expect("reply line");
    assert!(reply.ends_with("] pong from HEAD"), "{reply}");
    // The duplicate send must not print a second reply.
    assert!(timeout(Duration::from_millis(1200), lines.next_line()).await.is_err());
    hub.stop().await?;
    child.kill().await?;
    Ok(())
}
