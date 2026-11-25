//! KakaoTalk transport through an operator-run local Kakao bridge.
//!
//! KakaoTalk has no bot API. A separate bridge that the operator runs owns the
//! logged-in Kakao session; this adapter never logs in and never contacts Kakao.
//! It reads owner messages that the bridge has already routed to Superagent from
//! a loopback inbox and writes replies through a bridge endpoint fixed to the
//! owner's one-to-one chat. The wire contract is docs/kakao-bridge-protocol.md.
#[cfg(test)]
mod tests;

use std::{
    net::{Ipv4Addr, Ipv6Addr},
    sync::Arc,
    time::Duration,
};

use anyhow::{Context as _, ensure};
use async_trait::async_trait;
use reqwest::{Response, StatusCode, header::HeaderValue};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::{
    sync::{Mutex, watch},
    time::sleep,
};
use tokio_util::task::AbortOnDropHandle;
use url::{Host, Url};

use crate::adapter::{Adapter, Context, EffectError};

const PLATFORM: &str = "kakao";
const TOKEN_HEADER: &str = "X-Superagent-Token";
/// Kakao folds long messages behind "more"; keep each chunk readable.
pub(crate) const CHUNK_CHARS: usize = 1500;
const MAX_CHUNKS: usize = 20;
/// Inbound text limit in characters; longer rows are dropped and logged by row ID.
const MAX_INPUT_CHARS: usize = 4_000;
/// Rows requested per inbox page; a larger page violates the contract.
const PAGE_LIMIT: usize = 50;
/// 50 rows of 4000 characters stay below this even with JSON escaping.
const MAX_INBOX_BYTES: usize = 4 * 1024 * 1024;
const MAX_RECEIPT_BYTES: usize = 64 * 1024;
const POLL_INTERVAL: Duration = Duration::from_secs(1);
const ERROR_BACKOFF: Duration = Duration::from_secs(5);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const UNSUPPORTED_APPROVAL: &str =
    "카카오톡에서는 확인 버튼을 띄울 수 없어 이 확인 요청은 취소됐어요. 필요하면 텍스트로 다시 말해 주세요.";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Config {
    bridge_url: String,
    token_env: String,
    bot_user_id: String,
    owner_id: String,
    chat_id: String,
}

fn kakao_id(raw: &str) -> bool {
    !raw.is_empty()
        && raw.len() <= 20
        && raw.bytes().all(|byte| byte.is_ascii_digit())
        && !raw.starts_with('0')
}

/// Only a literal loopback address: a host name could resolve elsewhere later.
pub(crate) fn loopback_url(url: &Url) -> bool {
    let loopback = match url.host() {
        Some(Host::Ipv4(ip)) => ip == Ipv4Addr::LOCALHOST,
        Some(Host::Ipv6(ip)) => ip == Ipv6Addr::LOCALHOST,
        _ => false,
    };
    loopback
        && url.scheme() == "http"
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Route {
    pub platform: String,
    pub account_id: String,
    pub authority_id: String,
    #[serde(deserialize_with = "Option::deserialize")]
    pub guild_id: Option<String>,
    pub channel_id: String,
    #[serde(deserialize_with = "Option::deserialize")]
    pub thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub topic_id: Option<String>,
}

pub(crate) struct Policy {
    bot: String,
    owner: String,
    chat: String,
}

impl Policy {
    pub fn new(bot: &str, owner: &str, chat: &str) -> anyhow::Result<Self> {
        ensure!(
            kakao_id(bot) && kakao_id(owner) && kakao_id(chat),
            "Kakao requires numeric botUserId, ownerId and chatId"
        );
        ensure!(bot != owner, "Kakao botUserId and ownerId must differ");
        Ok(Self {
            bot: bot.to_owned(),
            owner: owner.to_owned(),
            chat: chat.to_owned(),
        })
    }

    pub fn route(&self) -> Route {
        Route {
            platform: PLATFORM.into(),
            account_id: self.bot.clone(),
            authority_id: self.owner.clone(),
            guild_id: None,
            channel_id: self.chat.clone(),
            thread_id: None,
            topic_id: None,
        }
    }

    pub fn authorize(&self, route: &Route) -> Result<(), EffectError> {
        if route.platform != PLATFORM
            || route.account_id != self.bot
            || route.authority_id != self.owner
            || route.guild_id.is_some()
            || route.channel_id != self.chat
            || route.thread_id.is_some()
            || route
                .topic_id
                .as_deref()
                .is_some_and(|topic| topic.is_empty() || topic.encode_utf16().count() > 128)
        {
            return Err(EffectError::rejected(
                "Kakao route is not the configured owner conversation",
            ));
        }
        Ok(())
    }
}

/// One owner message the bridge already diverted from its own bot.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InboxItem {
    pub id: u64,
    pub log_id: String,
    pub chat_id: String,
    pub sender_id: String,
    pub text: String,
    pub received_at_ms: u64,
    #[serde(default)]
    pub stale: bool,
}

#[derive(Deserialize)]
struct InboxPage {
    generation: String,
    latest: u64,
    messages: Vec<InboxItem>,
}

/// Bridge inbox position. A new generation (rebuilt inbox) or a missing cursor
/// starts at the bridge's latest row instead of replaying old commands.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
pub(crate) struct Cursor {
    pub generation: String,
    pub after: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Inbound<'a> {
    id: String,
    route: Route,
    message_id: &'a str,
    text: &'a str,
    received_at: u64,
    attachments: [Value; 0],
}

impl Policy {
    /// Untrusted bridge rows become owner input only when every identity matches.
    pub fn inbound(&self, item: &InboxItem) -> Option<Value> {
        let text = item.text.trim();
        if item.chat_id != self.chat
            || item.sender_id != self.owner
            || !kakao_id(&item.log_id)
            || text.is_empty()
            || text.chars().count() > MAX_INPUT_CHARS
            || item.received_at_ms == 0
            || item.received_at_ms > 9_007_199_254_740_991
        {
            return None;
        }
        let input = Inbound {
            id: format!("kakao:{}:{}:{}", self.bot, self.chat, item.log_id),
            route: self.route(),
            message_id: &item.log_id,
            text,
            received_at: item.received_at_ms,
            attachments: [],
        };
        Some(json!({"kind":"message","input":input}))
    }
}

/// Split by characters, preferring line breaks, never producing empty chunks.
pub(crate) fn chunks(text: &str, limit: usize) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = text.trim();
    while !rest.is_empty() {
        let end = rest
            .char_indices()
            .nth(limit)
            .map_or(rest.len(), |(index, _)| index);
        let cut = if end == rest.len() {
            end
        } else {
            rest[..end]
                .rfind('\n')
                .filter(|index| *index > end / 2)
                .map_or(end, |index| index + 1)
        };
        let piece = rest[..cut].trim_end();
        if !piece.is_empty() {
            out.push(piece.to_owned());
        }
        rest = rest[cut..].trim_start();
    }
    out
}

/// Convert Markdown to KakaoTalk plain text: no emphasis, code marks, headings,
/// fences or tables; bullets become "• "; links become "text url".
pub(crate) fn plain_text(text: &str) -> String {
    let mut lines: Vec<String> = Vec::new();
    for raw in text.lines() {
        let trimmed = raw.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            continue;
        }
        // Table separator rows (|---|:--:|) carry no content.
        if trimmed.starts_with('|')
            && trimmed.chars().all(|ch| matches!(ch, '|' | '-' | ':' | ' ' | '\t'))
        {
            continue;
        }
        let indent = raw.len() - trimmed.len();
        let mut line = trimmed.to_owned();
        // Headings and quotes.
        let hashes = line.chars().take_while(|ch| *ch == '#').count();
        if hashes > 0 && hashes <= 6 && line[hashes..].starts_with(' ') {
            line = line[hashes + 1..].to_owned();
        }
        if let Some(rest) = line.strip_prefix("> ") {
            line = rest.to_owned();
        } else if line == ">" {
            line.clear();
        }
        // Horizontal rules.
        if line.len() >= 3 && line.chars().all(|ch| matches!(ch, '-' | '*' | '_' | ' ')) {
            continue;
        }
        // Bullets and task boxes.
        for bullet in ["- [ ] ", "- [x] ", "* [ ] ", "* [x] ", "- ", "* ", "+ "] {
            if let Some(rest) = line.strip_prefix(bullet) {
                line = format!("• {rest}");
                break;
            }
        }
        // Table rows become " / "-joined cells.
        if line.starts_with('|') && line.ends_with('|') && line.len() > 1 {
            line = line[1..line.len() - 1]
                .split('|')
                .map(str::trim)
                .filter(|cell| !cell.is_empty())
                .collect::<Vec<_>>()
                .join(" / ");
        }
        let line = inline_plain(&line);
        let pad = if indent >= 2 && line.starts_with('•') { "  " } else { "" };
        lines.push(format!("{pad}{line}"));
    }
    // Collapse 3+ blank lines into one blank line.
    let mut out = String::new();
    let mut blanks = 0;
    for line in lines {
        if line.trim().is_empty() {
            blanks += 1;
            if blanks > 1 {
                continue;
            }
        } else {
            blanks = 0;
        }
        out.push_str(line.trim_end());
        out.push('\n');
    }
    out.trim().to_owned()
}

fn inline_plain(line: &str) -> String {
    let chars: Vec<char> = line.chars().collect();
    let mut out = String::with_capacity(line.len());
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        // [text](url) and ![alt](url)
        if ch == '[' || (ch == '!' && chars.get(i + 1) == Some(&'[')) {
            let start = if ch == '!' { i + 1 } else { i };
            if let Some(close) = chars[start + 1..].iter().position(|c| *c == ']').map(|p| start + 1 + p)
                && chars.get(close + 1) == Some(&'(')
                && let Some(end) = chars[close + 2..].iter().position(|c| *c == ')').map(|p| close + 2 + p)
            {
                let label: String = chars[start + 1..close].iter().collect();
                let url: String = chars[close + 2..end].iter().collect();
                let label = inline_plain(&label);
                if label.is_empty() || label == url {
                    out.push_str(&url);
                } else {
                    out.push_str(&format!("{label} {url}"));
                }
                i = end + 1;
                continue;
            }
        }
        // Emphasis/code markers. A single "~" is a range ("3~4잔"), not strikethrough; only "~~" is dropped.
        if matches!(ch, '*' | '`') {
            i += 1;
            continue;
        }
        if ch == '~' {
            if chars.get(i + 1) == Some(&'~') {
                i += 2;
                continue;
            }
            out.push('∼');
            i += 1;
            continue;
        }
        if ch == '_' {
            let prev = i.checked_sub(1).and_then(|p| chars.get(p)).copied();
            let next = chars.get(i + 1).copied();
            let wordy = |c: Option<char>| c.is_some_and(|c| c.is_alphanumeric());
            // Keep snake_case; drop _emphasis_ markers at word edges.
            if !(wordy(prev) && wordy(next)) {
                i += 1;
                continue;
            }
        }
        out.push(ch);
        i += 1;
    }
    out
}

/// Read at most `limit` bytes of a bridge body; a larger body is a contract violation.
async fn bounded_body(mut response: Response, limit: usize) -> Result<Vec<u8>, EffectError> {
    if response.content_length().is_some_and(|length| length > limit as u64) {
        return Err(EffectError::uncertain("Kakao bridge response is too large"));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| EffectError::uncertain("Kakao bridge response was interrupted"))?
    {
        if body.len() + chunk.len() > limit {
            return Err(EffectError::uncertain("Kakao bridge response is too large"));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn json_response(response: &Response) -> bool {
    response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("application/json"))
}

fn push_id(output: &str, index: usize, count: usize) -> String {
    let digest = hex::encode(&Sha256::digest(output.as_bytes())[..12]);
    format!("sa-{digest}-{index}-{count}")
}

struct Core {
    ctx: Context,
    /// A Kakao-only client: no redirects, retries or environment/system proxies,
    /// so the bridge token is only ever sent to the configured loopback socket.
    http: reqwest::Client,
    policy: Policy,
    base: Url,
    /// Marked sensitive so client debug output never prints it.
    token: HeaderValue,
    cursor_key: String,
}

fn uncertain(_: reqwest::Error) -> EffectError {
    EffectError::uncertain("Kakao bridge request outcome is unknown")
}

impl Core {
    fn endpoint(&self, path: &str) -> Result<Url, EffectError> {
        self.base
            .join(path)
            .map_err(|_| EffectError::rejected("Invalid Kakao bridge URL"))
    }

    async fn inbox(&self, cursor: &Cursor) -> Result<InboxPage, EffectError> {
        let mut url = self.endpoint("superagent/inbox")?;
        url.query_pairs_mut()
            .append_pair("after", &cursor.after.to_string())
            .append_pair("generation", &cursor.generation)
            .append_pair("limit", &PAGE_LIMIT.to_string());
        let response = self
            .http
            .get(url)
            .header(TOKEN_HEADER, self.token.clone())
            .timeout(REQUEST_TIMEOUT)
            .send()
            .await
            .map_err(uncertain)?;
        if !response.status().is_success() {
            return Err(EffectError::uncertain(format!(
                "Kakao bridge inbox returned HTTP {}",
                response.status().as_u16()
            )));
        }
        // A bridge without this endpoint may answer 200 with an HTML page.
        if !json_response(&response) {
            return Err(EffectError::uncertain(
                "Kakao bridge has no Superagent inbox endpoint (non-JSON response); update or restart the bridge",
            ));
        }
        let body = bounded_body(response, MAX_INBOX_BYTES).await?;
        let page: InboxPage = serde_json::from_slice(&body)
            .map_err(|_| EffectError::uncertain("Kakao bridge inbox returned invalid JSON"))?;
        if page.messages.len() > PAGE_LIMIT {
            return Err(EffectError::uncertain("Kakao bridge inbox page exceeds the requested limit"));
        }
        Ok(page)
    }

    async fn push(&self, output_id: &str, id: &str, message: &str) -> Result<(), EffectError> {
        let response = self
            .http
            .post(self.endpoint("superagent/send")?)
            .header(TOKEN_HEADER, self.token.clone())
            .timeout(REQUEST_TIMEOUT)
            .json(&json!({"message":message, "pushId":id, "outputId":output_id}))
            .send()
            .await
            .map_err(uncertain)?;
        let status = response.status();
        if status.is_success() {
            let body = bounded_body(response, MAX_RECEIPT_BYTES).await?;
            let body: Value = serde_json::from_slice(&body)
                .map_err(|_| EffectError::uncertain("Kakao push receipt was not JSON"))?;
            if body["ok"] == true && matches!(body["state"].as_str(), Some("queued" | "delivered")) {
                return Ok(());
            }
            return Err(EffectError::uncertain("Kakao push receipt was not confirmed"));
        }
        if status == StatusCode::CONFLICT {
            return Err(EffectError {
                message: "Kakao room is temporarily quiet".into(),
                certainty: "rejected",
                retry_after_ms: Some(60_000),
            });
        }
        if status.is_client_error() {
            return Err(EffectError::rejected(format!(
                "Kakao bridge refused the message (HTTP {})",
                status.as_u16()
            )));
        }
        Err(EffectError::uncertain(format!(
            "Kakao bridge push returned HTTP {}",
            status.as_u16()
        )))
    }

    /// Push IDs derive from the durable output ID, so a retried send is
    /// deduplicated by the bridge instead of being delivered twice.
    async fn send_text(&self, output_id: &str, text: &str) -> Result<String, EffectError> {
        // KakaoTalk renders no Markdown; send plain text.
        let plain = plain_text(text);
        let body = if plain.is_empty() { "(빈 응답)".to_owned() } else { plain };
        let parts = chunks(&body, CHUNK_CHARS);
        if parts.len() > MAX_CHUNKS {
            return Err(EffectError::rejected(
                "Kakao output is too long; summarize or attach it elsewhere",
            ));
        }
        let first = push_id(output_id, 0, parts.len());
        for (index, part) in parts.iter().enumerate() {
            self.push(output_id, &push_id(output_id, index, parts.len()), part).await?;
        }
        Ok(first)
    }

    async fn effect(&self, operation: &str, args: &[Value]) -> Result<Value, EffectError> {
        let route = |value: &Value| -> Result<Route, EffectError> {
            let route = Route::deserialize(value)
                .map_err(|_| EffectError::rejected("Malformed Kakao route"))?;
            self.policy.authorize(&route)?;
            Ok(route)
        };
        match (operation, args) {
            ("assertRoute", [value]) => {
                route(value)?;
                Ok(Value::Null)
            }
            ("fetchAfter", [value, _]) => {
                route(value)?;
                Ok(Value::Null)
            }
            ("send", [output]) => {
                route(&output["route"])?;
                if output.get("resultAttachment").is_some_and(|value| !value.is_null()) {
                    return Err(EffectError::rejected(
                        "Kakao does not support result attachments",
                    ));
                }
                let id = output["id"]
                    .as_str()
                    .filter(|id| !id.is_empty())
                    .ok_or_else(|| EffectError::rejected("Kakao output requires an ID"))?;
                let text = output["text"].as_str().unwrap_or_default();
                self.send_text(id, text).await.map(Value::String)
            }
            ("setActivity", [message, _]) => {
                route(&message["route"])?;
                Ok(Value::Null)
            }
            ("showApproval", [approval]) => {
                let approval_route = route(&approval["route"])?;
                let id = approval["id"]
                    .as_str()
                    .filter(|id| !id.is_empty())
                    .ok_or_else(|| EffectError::rejected("Kakao approval requires an ID"))?;
                let receipt = self
                    .send_text(&format!("approval:{id}"), UNSUPPORTED_APPROVAL)
                    .await?;
                // Cancel only after the notice is queued; never accept on the owner's behalf.
                self.ctx
                    .cancel_unsupported_approval(id, &json!(approval_route))
                    .map_err(|_| EffectError::uncertain("Kakao approval cancellation was not recorded"))?;
                Ok(Value::String(receipt))
            }
            ("dismissApproval", [approval]) => {
                route(&approval["route"])?;
                Ok(Value::Null)
            }
            ("canCreateThread", [value] | [value, _]) => {
                route(value)?;
                Ok(Value::Bool(false))
            }
            ("createThread" | "inspectThread" | "updateThread", _) => Err(
                EffectError::rejected("Kakao has no threads"),
            ),
            _ => Err(EffectError::rejected("Unsupported Kakao effect")),
        }
    }

    fn cursor(&self) -> anyhow::Result<Cursor> {
        self.ctx
            .get_meta(&self.cursor_key)?
            .map(|raw| serde_json::from_str(&raw).context("Kakao inbox cursor is invalid"))
            .transpose()
            .map(Option::unwrap_or_default)
    }

    fn save_cursor(&self, cursor: &Cursor) -> Result<(), EffectError> {
        let raw = serde_json::to_string(cursor)
            .map_err(|_| EffectError::uncertain("Kakao cursor encoding failed"))?;
        self.ctx
            .set_meta(&self.cursor_key, &raw)
            .map_err(|_| EffectError::uncertain("Kakao cursor write failed"))
    }

    /// Admit every row durably before advancing the cursor; a crash re-reads
    /// rows whose admission is idempotent by message identity.
    async fn poll_once(&self, mut cursor: Cursor) -> Result<Cursor, EffectError> {
        let page = self.inbox(&cursor).await?;
        if page.generation.is_empty() {
            return Err(EffectError::uncertain("Kakao bridge inbox has no generation"));
        }
        if page.generation != cursor.generation {
            // First contact: skip rows written before this adapter ever ran.
            // A later generation change (inbox rebuilt or rolled back) starts
            // from 0; admission is idempotent by message ID and old rows are stale.
            let after = if cursor.generation.is_empty() { page.latest } else { 0 };
            cursor = Cursor { generation: page.generation, after };
            self.save_cursor(&cursor)?;
            return Ok(cursor);
        }
        for item in page.messages {
            if item.id <= cursor.after {
                continue;
            }
            if item.stale {
                // Too old to act on safely; tell the owner once instead of executing it.
                if let Some(event) = self.policy.inbound(&item) {
                    let id = event["input"]["id"].as_str().unwrap_or_default().to_owned();
                    let notice = self
                        .send_text(
                            &format!("stale:{id}"),
                            "오래 밀린 요청이라 실행하지 않았어요. 필요하면 다시 보내 주세요.",
                        )
                        .await;
                    // An uncertain notice holds the cursor and is retried with the same
                    // push ID. A refused notice is final: skip it rather than stall intake.
                    match notice {
                        Ok(_) => {}
                        Err(error) if error.certainty == "rejected" && error.retry_after_ms.is_none() => {
                            eprintln!("{} Kakao stale notice for row {} was refused", log_time(), item.id);
                        }
                        Err(error) => return Err(error),
                    }
                }
            } else if let Some(event) = self.policy.inbound(&item) {
                self.ctx
                    .admit(event)
                    .map_err(|_| EffectError::uncertain("Kakao durable admission failed"))?;
            } else {
                // Row ID only: never log message text, sender or chat identifiers.
                eprintln!("{} Kakao inbox row {} rejected by policy (identity or size)", log_time(), item.id);
            }
            cursor.after = item.id;
            self.save_cursor(&cursor)?;
        }
        Ok(cursor)
    }
}

async fn run(core: Arc<Core>, mut stop: watch::Receiver<bool>) {
    let ready = tokio::select! {
        biased;
        _ = stop.changed() => return,
        ready = core.ctx.ready() => ready,
    };
    if ready.is_err() {
        eprintln!("Kakao startup reconciliation failed; intake remains stopped");
        return;
    }
    let mut cursor = match core.cursor() {
        Ok(cursor) => cursor,
        Err(_) => {
            eprintln!("Kakao inbox cursor is unreadable; intake remains stopped");
            return;
        }
    };
    // Report a failure when it starts, then once per minute while it repeats.
    let mut last_error: Option<(String, std::time::Instant)> = None;
    while !*stop.borrow() {
        let delay = match core.poll_once(cursor.clone()).await {
            Ok(next) => {
                if last_error.take().is_some() {
                    eprintln!("{} Kakao inbox poll recovered", log_time());
                }
                cursor = next;
                POLL_INTERVAL
            }
            Err(error) => {
                let message = error.to_string();
                let repeat = last_error.as_ref().is_some_and(|(previous, at)| {
                    *previous == message && at.elapsed() < Duration::from_secs(60)
                });
                if !repeat {
                    eprintln!("{} Kakao inbox poll failed: {message}", log_time());
                    last_error = Some((message, std::time::Instant::now()));
                }
                ERROR_BACKOFF
            }
        };
        tokio::select! {
            biased;
            _ = stop.changed() => return,
            () = sleep(delay) => {}
        }
    }
}

fn log_time() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs());
    time::OffsetDateTime::from_unix_timestamp(i64::try_from(now).unwrap_or_default())
        .ok()
        .and_then(|at| at.format(&time::format_description::well_known::Rfc3339).ok())
        .unwrap_or_else(|| now.to_string())
}

struct Run {
    stop: watch::Sender<bool>,
    poll: AbortOnDropHandle<()>,
}

pub struct Kakao {
    core: Arc<Core>,
    run: Mutex<Option<Run>>,
}

impl Kakao {
    pub fn new(config: &Value, ctx: Context) -> anyhow::Result<Self> {
        let config = Config::deserialize(config).context("Invalid Kakao configuration")?;
        let token = std::env::var(&config.token_env)
            .map_err(|_| anyhow::anyhow!("Missing Kakao bridge credential"))?;
        ensure!(
            !token.is_empty()
                && token
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
                && token.len() >= 24,
            "Invalid Kakao bridge credential format"
        );
        Self::build(config, ctx, token)
    }

    fn build(config: Config, ctx: Context, token: String) -> anyhow::Result<Self> {
        let mut base = Url::parse(&config.bridge_url).context("Invalid Kakao bridgeUrl")?;
        ensure!(
            loopback_url(&base),
            "Kakao bridgeUrl must be a plain http://127.0.0.1:PORT or http://[::1]:PORT URL"
        );
        if !base.path().ends_with('/') {
            let path = format!("{}/", base.path());
            base.set_path(&path);
        }
        let policy = Policy::new(&config.bot_user_id, &config.owner_id, &config.chat_id)?;
        let http = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .connect_timeout(CONNECT_TIMEOUT)
            .build()?;
        let mut token = HeaderValue::from_str(&token).context("Invalid Kakao bridge credential format")?;
        token.set_sensitive(true);
        let cursor_key = format!("kakao:{}:{}:inbox-cursor", config.bot_user_id, config.chat_id);
        Ok(Self {
            core: Arc::new(Core {
                ctx,
                http,
                policy,
                base,
                token,
                cursor_key,
            }),
            run: Mutex::new(None),
        })
    }

    #[cfg(test)]
    pub(crate) fn test_instance(ctx: Context, base: &str) -> anyhow::Result<Self> {
        let config = Config::deserialize(&json!({
            "bridgeUrl": base, "tokenEnv": "UNUSED", "botUserId": "900", "ownerId": "42",
            "chatId": "777"
        }))?;
        Self::build(config, ctx, "test-token".into())
    }

    #[cfg(test)]
    pub(crate) fn test_instance_with_token(ctx: Context, base: &str, token: &str) -> anyhow::Result<Self> {
        let config = Config::deserialize(&json!({
            "bridgeUrl": base, "tokenEnv": "UNUSED", "botUserId": "900", "ownerId": "42",
            "chatId": "777"
        }))?;
        Self::build(config, ctx, token.into())
    }
}

#[async_trait]
impl Adapter for Kakao {
    async fn start(&self) -> anyhow::Result<()> {
        let mut run = self.run.lock().await;
        ensure!(run.is_none(), "Kakao adapter is already started");
        let (stop, signal) = watch::channel(false);
        let poll = AbortOnDropHandle::new(tokio::spawn(self::run(self.core.clone(), signal)));
        *run = Some(Run { stop, poll });
        Ok(())
    }

    async fn stop(&self) -> anyhow::Result<()> {
        if let Some(active) = self.run.lock().await.take() {
            active.stop.send_replace(true);
            active.poll.await.context("Kakao poll task failed during shutdown")?;
        }
        Ok(())
    }

    async fn effect(&self, operation: &str, args: &[Value]) -> Result<Value, EffectError> {
        self.core.effect(operation, args).await
    }

    async fn attachment(
        &self,
        _route: &Value,
        _file: &Value,
    ) -> Result<reqwest::Response, EffectError> {
        Err(EffectError::rejected("Kakao attachments are unsupported"))
    }
}
