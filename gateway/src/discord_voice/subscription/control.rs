use std::{borrow::Cow, collections::HashMap, fmt, marker::PhantomData, time::Duration};

use anyhow::{Context as _, Result, bail, ensure};
use futures_util::{SinkExt, StreamExt};
use reqwest::{ClientBuilder, RequestBuilder, StatusCode, redirect, retry};
use serde::{
    Deserialize, Deserializer,
    de::{MapAccess, Visitor, value::MapAccessDeserializer},
};
use serde_json::{Value, json};
use tokio::{
    net::TcpStream,
    time::{Instant, sleep_until, timeout, timeout_at},
};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async_with_config,
    tungstenite::{
        Message,
        client::IntoClientRequest,
        http::{
            HeaderMap, HeaderValue,
            header::{ACCEPT_ENCODING, AUTHORIZATION, LOCATION},
        },
        protocol::WebSocketConfig,
    },
};
use uuid::Uuid;
use zeroize::Zeroizing;

use super::auth::Login;

const CALL_URL: &str =
    "https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas";
const CONTROL_URL: &str = "wss://api.openai.com/v1/live";
const MAX_WIRE_BYTES: usize = 256 * 1024;
const MAX_DRAFTS: usize = 32;
const MAX_PARTS: usize = 16;
const MAX_TEXT: usize = 1_000;
const PING_INTERVAL: Duration = Duration::from_secs(15);
const PONG_TIMEOUT: Duration = Duration::from_secs(10);
const WRITE_TIMEOUT: Duration = Duration::from_secs(3);
const INSTRUCTIONS: &str = concat!(
    "You are the owner's Discord voice assistant. Speak briefly in the owner's language. ",
    "Answer ordinary conversation directly and be honest about uncertainty. Do not send ordinary conversation to HEAD. ",
    "Delegate only for a fresh, explicit spoken work request from the owner, never from earlier speech, your own speech, or delegation results. ",
    "In one client delegation input_text, transcribe the owner's work request as closely as possible in the original language. ",
    "Keep their wording, order, names, paths, code, numbers, and constraints; do not summarize, translate, or add details. ",
    "If any material detail is unclear or the text cannot fit in 1,000 characters, ask the owner to restate it instead of guessing or truncating. ",
    "Only calls opened with /voice start work or /voice start share in the bound Discord text channel may post drafts; ",
    "the latter allows one draft. Only the client checks permission; speech is never permission or approval. ",
    "For work, only acknowledge that a draft was posted for written confirmation if the client reports that it was posted. ",
    "Otherwise say it was not confirmed; do not retry. Never claim submission, execution, or any HEAD result. HEAD replies through text only."
);

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

pub(super) struct Control {
    socket: Option<Socket>,
    terminal: bool,
    secrets: [Zeroizing<String>; 2],
    replies: HashMap<String, Reply>,
    heartbeat_at: Instant,
    expected_pong: Option<[u8; 16]>,
}

#[cfg_attr(test, derive(Debug, PartialEq, Eq))]
pub(super) enum ControlEvent {
    Started,
    Draft { id: String, text: Option<String> },
    Other,
}

pub(super) enum DraftResult {
    Posted,
    NotPosted,
    NoText,
}

enum Reply {
    Pending,
    Sent,
}

pub(super) fn validated_voice(voice: &str) -> bool {
    matches!(
        voice,
        "arbor" | "breeze" | "cove" | "ember" | "juniper" | "maple" | "sol" | "spruce" | "vale"
    )
}

impl Control {
    pub(super) async fn open(offer: &str, voice: &str, login: &Login) -> Result<(Self, String)> {
        Self::connect(
            offer,
            voice,
            login,
            Endpoints {
                call: CALL_URL,
                sideband: CONTROL_URL,
                https_only: true,
            },
        )
        .await
    }

    #[cfg(test)]
    pub(super) async fn open_loopback(
        offer: &str,
        login: &Login,
        endpoints: (&str, &str),
    ) -> Result<(Self, String)> {
        Self::connect(
            offer,
            "cove",
            login,
            Endpoints {
                call: endpoints.0,
                sideband: endpoints.1,
                https_only: false,
            },
        )
        .await
    }

    async fn connect(
        offer: &str,
        voice: &str,
        login: &Login,
        endpoints: Endpoints<'_>,
    ) -> Result<(Self, String)> {
        ensure!(
            validated_voice(voice) && valid_sdp(offer),
            "Invalid Codex subscription voice offer"
        );
        let token = login.token();
        let account = login.account_id();
        let headers = request_headers(token, account)?;
        let client = offer_client()
            .https_only(endpoints.https_only)
            .build()
            .map_err(|_| anyhow::anyhow!("Could not initialize Codex voice HTTP client"))?;
        let request = client
            .post(endpoints.call)
            .headers(headers.clone())
            .header(ACCEPT_ENCODING, "identity")
            .json(&json!({
                "sdp": offer,
                "session": {
                    "model": "gpt-live-1-codex",
                    "instructions": INSTRUCTIONS,
                    "audio": {"output": {"voice": voice}},
                    "delegation": {"type": "client"}
                }
            }));
        let (answer, identifier) = exchange(request).await?;
        ensure!(
            valid_sdp(&answer) && !answer.contains(token) && !answer.contains(account),
            "Invalid Codex subscription voice answer"
        );
        // Location is metadata only. The connection uses the fixed sideband origin, never Location.
        let url = format!("{}/{identifier}", endpoints.sideband);
        let mut request = url
            .as_str()
            .into_client_request()
            .map_err(|_| anyhow::anyhow!("Invalid Codex voice sideband request"))?;
        request.headers_mut().extend(headers);
        // One direct TCP/TLS WebSocket upgrade; tungstenite does not follow redirects.
        let (socket, _) = timeout(
            Duration::from_secs(8),
            connect_async_with_config(request, Some(sideband_config()), true),
        )
        .await
        .context("Codex voice sideband connection timed out")?
        .map_err(|_| anyhow::anyhow!("Codex voice sideband connection failed"))?;
        Ok((Self::new(socket, token, account), answer))
    }

    fn new(socket: Socket, token: &str, account: &str) -> Self {
        Self {
            socket: Some(socket),
            terminal: false,
            secrets: [
                Zeroizing::new(token.to_owned()),
                Zeroizing::new(account.to_owned()),
            ],
            replies: HashMap::new(),
            heartbeat_at: Instant::now() + PING_INTERVAL,
            expected_pong: None,
        }
    }

    // Both the WebSocket buffers and heartbeat state survive cancellation by the
    // caller's media select. Once a text frame is read, projection is synchronous.
    pub(super) async fn recv(&mut self) -> Result<ControlEvent> {
        ensure!(!self.terminal, "Codex voice sideband closed");
        let frame = match self.read_event_frame().await {
            Ok(frame) => frame,
            Err(error) => {
                // Transport failures and uncertain heartbeat writes must not be retried.
                self.socket = None;
                return Err(error);
            }
        };
        let result = self.project(&frame.into_data());
        if result.is_err() {
            // Invalid application messages end the session, but the still-writable
            // WebSocket is needed to send the bounded session.close.
            self.terminal = true;
        }
        result
    }

    async fn read_event_frame(&mut self) -> Result<Message> {
        let socket = self
            .socket
            .as_mut()
            .context("Codex voice sideband closed")?;
        loop {
            let frame = tokio::select! {
                biased;
                () = sleep_until(self.heartbeat_at) => {
                    ensure!(self.expected_pong.is_none(), "Codex voice sideband heartbeat timed out");
                    let nonce = Uuid::new_v4().into_bytes();
                    // feed queues without awaiting a flush; record the nonce before
                    // the next suspension so a cancelled read cannot send a second ping.
                    timeout_at(
                        self.heartbeat_at + WRITE_TIMEOUT,
                        socket.feed(Message::Ping(nonce.to_vec().into())),
                    )
                    .await
                    .context("Codex voice sideband heartbeat write timed out")?
                    .map_err(|_| anyhow::anyhow!("Codex voice sideband heartbeat write failed"))?;
                    self.expected_pong = Some(nonce);
                    self.heartbeat_at = Instant::now() + PONG_TIMEOUT;
                    continue;
                }
                message = async {
                    socket.flush().await?;
                    socket.next().await.transpose()
                } => message
                    .map_err(|_| anyhow::anyhow!("Codex voice sideband receive failed"))?
                    .context("Codex voice sideband disconnected")?,
            };
            match frame {
                Message::Text(_) | Message::Binary(_) => return Ok(frame),
                Message::Ping(_) => {} // The socket queues the matching Pong for flush.
                Message::Pong(bytes) => {
                    if self
                        .expected_pong
                        .as_ref()
                        .is_some_and(|nonce| bytes.as_ref() == nonce)
                    {
                        self.expected_pong = None;
                        self.heartbeat_at += PING_INTERVAL - PONG_TIMEOUT;
                    }
                }
                Message::Close(_) => bail!("Codex voice sideband closed"),
                Message::Frame(_) => bail!("Unexpected Codex voice sideband frame"),
            }
        }
    }

    fn project(&mut self, raw: &[u8]) -> Result<ControlEvent> {
        let Named(envelope): Named<Envelope<'_>> = serde_json::from_slice(raw)
            .map_err(|_| anyhow::anyhow!("Malformed Codex voice sideband event"))?;
        let compact = match envelope.kind.as_ref() {
            "session.started" => return Ok(ControlEvent::Started),
            "error" | "session.closed" => bail!("Codex voice sideband ended or was rejected"),
            "delegation.created" => false,
            "session.delegation.created" => true,
            _ => return Ok(ControlEvent::Other),
        };
        let Named(event): Named<DraftEnvelope> = serde_json::from_slice(raw)
            .map_err(|_| anyhow::anyhow!("Malformed Codex voice delegation"))?;
        let Some(Named(draft)) = (if compact {
            event.delegation
        } else {
            event.item
        }) else {
            return Ok(ControlEvent::Other);
        };
        if draft.kind != "delegation" || draft.target != "client" {
            return Ok(ControlEvent::Other);
        }
        ensure!(
            valid_id(&draft.id) && !self.reflects_secret(&draft.id),
            "Malformed Codex voice draft identifier"
        );
        let text = draft_text(draft.content)?;
        let safe_text = match text {
            DraftText::Empty if compact => return Ok(ControlEvent::Other),
            DraftText::Malformed if compact => bail!("Malformed compact Codex voice draft text"),
            DraftText::Empty | DraftText::Malformed | DraftText::TooLong => None,
            DraftText::Candidate(text) if self.reflects_secret(&text) => None,
            DraftText::Candidate(text) => Some(text),
        };
        if self.replies.contains_key(&draft.id) {
            return Ok(ControlEvent::Other);
        }
        ensure!(
            self.replies.len() < MAX_DRAFTS,
            "Codex voice draft budget reached"
        );
        self.replies.insert(draft.id.clone(), Reply::Pending);
        Ok(ControlEvent::Draft {
            id: draft.id,
            text: safe_text,
        })
    }

    fn reflects_secret(&self, text: &str) -> bool {
        self.secrets
            .iter()
            .any(|secret| text.contains(secret.as_str()))
    }

    pub(super) async fn draft_result(&mut self, id: &str, result: DraftResult) -> Result<()> {
        ensure!(!self.terminal, "Codex voice sideband closed");
        let Some(reply @ Reply::Pending) = self.replies.get_mut(id) else {
            bail!("Uncorrelated Codex voice draft result");
        };
        let text = match result {
            DraftResult::Posted => {
                "A draft was posted for written confirmation. Nothing was submitted or executed."
            }
            DraftResult::NotPosted => {
                "The client did not confirm posting a draft. Do not retry; check the text channel. Nothing was submitted or executed."
            }
            DraftResult::NoText => {
                "No clear draft text was provided. If the owner explicitly requested a draft, ask them to restate it."
            }
        };
        let payload = json!({
            "type": "delegation.context.append",
            "delegation_item_id": id,
            "channel": "speakable",
            "content": [{"type": "input_text", "text": text}],
        });
        // A cancelled write may already have sent bytes. Drop its socket rather
        // than retry or restore a partially-written connection.
        let mut socket = self.socket.take().context("Codex voice sideband closed")?;
        *reply = Reply::Sent;
        timeout(
            WRITE_TIMEOUT,
            socket.send(Message::text(payload.to_string())),
        )
        .await
        .context("Codex voice sideband result send timed out")?
        .map_err(|_| anyhow::anyhow!("Codex voice sideband result send failed"))?;
        self.socket = Some(socket);
        Ok(())
    }

    pub(super) async fn close(&mut self) {
        if let Some(mut socket) = self.socket.take() {
            // The owned socket is dropped even if the close request fails, times out,
            // or is itself cancelled. There is no background reader to outlive it.
            drop(
                timeout(Duration::from_secs(1), async {
                    socket
                        .send(Message::text(r#"{"type":"session.close"}"#))
                        .await?;
                    SinkExt::close(&mut socket).await
                })
                .await,
            );
        }
    }
}

struct Endpoints<'a> {
    call: &'a str,
    sideband: &'a str,
    https_only: bool,
}

fn request_headers(token: &str, account: &str) -> Result<HeaderMap> {
    let mut bearer = HeaderValue::from_str(&Zeroizing::new(format!("Bearer {token}")))
        .map_err(|_| anyhow::anyhow!("Invalid Codex voice authorization header"))?;
    let mut account = HeaderValue::from_str(account)
        .map_err(|_| anyhow::anyhow!("Invalid Codex voice account header"))?;
    bearer.set_sensitive(true);
    account.set_sensitive(true);
    let mut headers = HeaderMap::new();
    headers.insert(AUTHORIZATION, bearer);
    headers.insert("chatgpt-account-id", account);
    // Protocol selector only. Never synthesize a user agent or a client identity.
    headers.insert("openai-alpha", HeaderValue::from_static("quicksilver=v2"));
    let mut buffer = Uuid::encode_buffer();
    for name in ["session-id", "thread-id", "x-session-id"] {
        let value = HeaderValue::from_str(Uuid::new_v4().hyphenated().encode_lower(&mut buffer))
            .map_err(|_| anyhow::anyhow!("Invalid Codex voice correlation header"))?;
        headers.insert(name, value);
    }
    Ok(headers)
}

fn offer_client() -> ClientBuilder {
    reqwest::Client::builder()
        .redirect(redirect::Policy::none())
        .retry(retry::never())
        .no_proxy()
        .no_gzip()
        .no_brotli()
        .no_zstd()
        .no_deflate()
        .pool_max_idle_per_host(0)
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(24))
}

fn sideband_config() -> WebSocketConfig {
    WebSocketConfig::default()
        .read_buffer_size(8 * 1024)
        .write_buffer_size(0)
        .max_write_buffer_size(8 * 1024)
        .max_message_size(Some(MAX_WIRE_BYTES))
        .max_frame_size(Some(MAX_WIRE_BYTES))
}

async fn exchange(request: RequestBuilder) -> Result<(String, String)> {
    let mut response = request
        .send()
        .await
        .map_err(|_| anyhow::anyhow!("Codex subscription voice offer failed"))?;
    let status = response.status();
    ensure!(
        !status.is_redirection(),
        "Codex subscription voice offer redirect was refused"
    );
    ensure!(
        matches!(status, StatusCode::OK | StatusCode::CREATED),
        "OpenAI declined subscription voice access"
    );
    let identifier = call_id(response.headers())?;
    let mut data = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| anyhow::anyhow!("Codex voice answer read failed"))?
    {
        ensure!(
            chunk.len() <= MAX_WIRE_BYTES - data.len(),
            "Codex voice answer exceeded its size limit"
        );
        data.extend_from_slice(&chunk);
    }
    let answer = String::from_utf8(data)
        .map_err(|_| anyhow::anyhow!("Invalid Codex voice answer encoding"))?;
    Ok((answer, identifier))
}

fn valid_sdp(sdp: &str) -> bool {
    let mut lines = sdp.lines();
    if sdp.len() > MAX_WIRE_BYTES || sdp.contains('\0') || lines.next() != Some("v=0") {
        return false;
    }
    let mut media = lines.filter(|line| line.starts_with("m="));
    media
        .next()
        .is_some_and(|line| line.starts_with("m=audio "))
        && media.next().is_none()
}

fn valid_id(id: &str) -> bool {
    (1..=128).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn call_id(headers: &HeaderMap) -> Result<String> {
    let read_header = |name: &str| -> Result<Option<&str>> {
        let values = headers.get_all(name);
        let mut values = values.iter();
        let first = values.next();
        ensure!(
            values.next().is_none(),
            "Duplicate Codex voice call identifier header"
        );
        first
            .map(|value| {
                value
                    .to_str()
                    .map_err(|_| anyhow::anyhow!("Invalid Codex voice call identifier header"))
            })
            .transpose()
    };
    let header = read_header("openai-session-id")?;
    let id = if let Some(location) = read_header(LOCATION.as_str())? {
        ensure!(
            !location.is_empty()
                && location.len() <= 512
                && !location
                    .bytes()
                    .any(|b| b.is_ascii_whitespace() || b.is_ascii_control())
                && !location.contains(['?', '#', '\\', ',']),
            "Invalid Codex voice call location"
        );
        let path = if let Some(authority) = location
            .strip_prefix("https://")
            .or_else(|| location.strip_prefix("//"))
        {
            let (host, path) = authority
                .split_once('/')
                .context("Invalid Codex voice call location")?;
            ensure!(
                matches!(host, "chatgpt.com" | "api.openai.com"),
                "Invalid Codex voice call location"
            );
            path
        } else {
            ensure!(
                !location
                    .split('/')
                    .next()
                    .is_some_and(|segment| segment.contains(':')),
                "Invalid Codex voice call location"
            );
            location
        };
        let path = path.trim_end_matches('/');
        let id = path.rsplit_once('/').map_or(path, |(_, id)| id);
        ensure!(
            header.is_none_or(|candidate| candidate == id),
            "Conflicting Codex voice call identifiers"
        );
        id
    } else {
        header.context("Missing Codex voice call identifier")?
    };
    ensure!(
        id.strip_prefix("rtc_").is_some_and(valid_id)
            || (id.len() == 36 && Uuid::parse_str(id).is_ok()),
        "Invalid Codex voice call identifier"
    );
    Ok(id.to_owned())
}

// Derived structs also accept positional sequences. Require named JSON
// objects so arrays cannot stand in for protocol headers or draft fields.
struct Named<T>(T);

impl<'de, T: Deserialize<'de>> Deserialize<'de> for Named<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        struct NamedVisitor<T>(PhantomData<T>);

        impl<'de, T: Deserialize<'de>> Visitor<'de> for NamedVisitor<T> {
            type Value = Named<T>;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a named JSON object")
            }

            fn visit_map<M: MapAccess<'de>>(
                self,
                map: M,
            ) -> std::result::Result<Self::Value, M::Error> {
                T::deserialize(MapAccessDeserializer::new(map)).map(Named)
            }
        }

        deserializer.deserialize_map(NamedVisitor(PhantomData))
    }
}

#[derive(Deserialize)]
struct Envelope<'a> {
    #[serde(rename = "type", borrow)]
    kind: Cow<'a, str>,
}

#[derive(Deserialize)]
struct DraftEnvelope {
    item: Option<Named<Delegation>>,
    delegation: Option<Named<Delegation>>,
}

#[derive(Deserialize)]
struct Delegation {
    id: String,
    #[serde(rename = "type")]
    kind: String,
    target: String,
    #[serde(default = "empty_content")]
    content: Value,
}

fn empty_content() -> Value {
    Value::Array(Vec::new())
}

#[derive(Deserialize)]
struct ContentPart {
    #[serde(rename = "type")]
    kind: String,
    text: Option<String>,
}

enum DraftText {
    Empty,
    Malformed,
    TooLong,
    Candidate(String),
}

fn draft_text(content: Value) -> Result<DraftText> {
    let parts = match content {
        Value::Array(parts) => parts,
        _ => return Ok(DraftText::Malformed),
    };
    ensure!(
        parts.len() <= MAX_PARTS,
        "Codex voice draft content limit exceeded"
    );
    let mut text = String::new();
    for part in parts {
        let Ok(Named(part)) = serde_json::from_value::<Named<ContentPart>>(part) else {
            return Ok(DraftText::Malformed);
        };
        if let Some(fragment) = part.text {
            if fragment.chars().count() > MAX_TEXT {
                return Ok(DraftText::TooLong);
            }
            if part.kind == "input_text" {
                text.push_str(&fragment);
            }
        }
    }
    let trimmed = text.trim();
    if trimmed.is_empty() {
        Ok(DraftText::Empty)
    } else if trimmed.encode_utf16().count() > MAX_TEXT {
        Ok(DraftText::TooLong)
    } else if trimmed.len() == text.len() {
        Ok(DraftText::Candidate(text))
    } else {
        Ok(DraftText::Candidate(trimmed.to_owned()))
    }
}

#[cfg(test)]
#[path = "control_tests.rs"]
mod tests;
