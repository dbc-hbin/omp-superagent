use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Result, ensure};
use futures_util::{SinkExt, StreamExt};
use reqwest::Url;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::{
    net::TcpStream,
    sync::{mpsc, oneshot},
    time,
};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream,
    tungstenite::{
        Message,
        protocol::{CloseFrame, frame::coding::CloseCode},
    },
};
use tokio_util::sync::CancellationToken;

use super::dispatch::{Connection, Dispatcher, Ready};
use super::login::{IdentifyLimiter, gateway_url};

pub(super) type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

#[derive(Deserialize)]
struct Frame {
    op: u8,
    s: Option<u64>,
    t: Option<String>,
    #[serde(default)]
    d: Value,
}

#[derive(Default)]
pub(super) struct Session {
    pub resume: Option<Resume>,
    presence_account: Option<String>,
    presence_allowed: Option<time::Instant>,
}

impl Session {
    pub fn new(presence_account: Option<String>) -> Self {
        Self {
            presence_account,
            ..Self::default()
        }
    }
}

pub(super) struct Resume {
    pub url: Url,
    id: String,
    sequence: u64,
}

pub(super) enum End {
    Resume,
    Identify,
    InvalidSession(bool),
    Fatal(u16),
    Shutdown,
}

fn close_code(code: u16) -> End {
    match code {
        4004 | 4010..=4014 => End::Fatal(code),
        1000 | 1001 | 4003 | 4005 | 4007 | 4009 => End::Identify,
        _ => End::Resume,
    }
}

pub(super) fn jitter(bound: u64) -> Duration {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| u64::from(d.subsec_nanos()));
    Duration::from_millis(nanos % bound.max(1))
}

pub(super) async fn text(socket: &mut Socket, value: Value) -> Result<()> {
    time::timeout(
        Duration::from_secs(5),
        socket.send(Message::Text(value.to_string().into())),
    )
    .await
    .map_err(|_| anyhow::anyhow!("Discord Gateway send timed out"))?
    .map_err(|_| anyhow::anyhow!("Discord Gateway send failed"))
}

async fn next(socket: &mut Socket) -> Result<std::result::Result<Frame, End>> {
    loop {
        match socket.next().await {
            Some(Ok(Message::Text(raw))) => {
                return serde_json::from_str(&raw)
                    .map(Ok)
                    .map_err(|_| anyhow::anyhow!("Discord Gateway sent an invalid JSON envelope"));
            }
            Some(Ok(Message::Close(frame))) => {
                return Ok(Err(
                    frame.map_or(End::Resume, |frame| close_code(frame.code.into()))
                ));
            }
            Some(Ok(Message::Ping(_))) => time::timeout(Duration::from_secs(5), socket.flush())
                .await
                .map_err(|_| anyhow::anyhow!("Discord Gateway ping response timed out"))?
                .map_err(|_| anyhow::anyhow!("Discord Gateway ping response failed"))?,
            Some(Ok(Message::Pong(_) | Message::Frame(_))) => (),
            Some(Ok(Message::Binary(_))) => {
                anyhow::bail!("Discord Gateway sent an unsupported binary frame")
            }
            Some(Err(_)) | None => return Ok(Err(End::Resume)),
        }
    }
}

pub(super) struct Link<'a> {
    pub socket: Socket,
    pub dispatcher: &'a Dispatcher,
    pub session: &'a mut Session,
    pub startup: &'a mut Option<oneshot::Sender<Result<()>>>,
    pub admission: &'a mut oneshot::Receiver<()>,
    pub admitted: &'a mut bool,
    pub authenticated: bool,
    pub limiter: &'a mut IdentifyLimiter,
    pub cancel: &'a CancellationToken,
}

impl Link<'_> {
    pub async fn run(&mut self) -> Result<End> {
        let first = tokio::select! {
            biased;
            () = self.cancel.cancelled() => return Ok(End::Shutdown),
            frame = time::timeout(Duration::from_secs(10), next(&mut self.socket)) => frame??,
        };
        let hello = match first {
            Ok(frame) => frame,
            Err(end) => return Ok(end),
        };
        ensure!(hello.op == 10, "Discord Gateway did not send HELLO");
        let interval = hello.d["heartbeat_interval"]
            .as_u64()
            .filter(|ms| (1_000..=120_000).contains(ms))
            .ok_or_else(|| anyhow::anyhow!("Discord Gateway heartbeat interval is invalid"))?;
        let mut heartbeats = time::interval_at(
            time::Instant::now() + jitter(interval),
            Duration::from_millis(interval),
        );
        heartbeats.set_missed_tick_behavior(time::MissedTickBehavior::Delay);
        let state = self.dispatcher.state();
        let mut connection = state.presence.link();
        let mut identified_presence = match &self.session.resume {
            Some(resume) => {
                text(&mut self.socket, json!({ "op": 6, "d": { "token": state.rest.token(),
                    "session_id": resume.id, "seq": resume.sequence } })).await?;
                None
            }
            None => {
                self.limiter.attempted();
                let intents = 1
                    | (1 << 9)
                    | (1 << 12)
                    | (1 << 15)
                    | if state.voice.is_some() { 1 << 7 } else { 0 };
                let identify = json!({ "op": 2, "d": { "token": state.rest.token(), "intents": intents,
                    "properties": { "os": std::env::consts::OS, "browser": "omp-superagent", "device": "omp-superagent" } } });
                connection.identify(&mut self.socket, identify).await?
            }
        };
        let mut heartbeat_ack = true;
        let (outbound, mut packets) = mpsc::channel::<Value>(32);
        let authentication = time::sleep(Duration::from_secs(30));
        tokio::pin!(authentication);
        loop {
            let presence_pending = connection.pending().is_some();
            let presence_allowed = self.session.presence_allowed.unwrap_or_else(time::Instant::now);
            tokio::select! {
                biased;
                () = self.cancel.cancelled() => {
                    // Voice is already stopped; send a queued leave before
                    // closing the physical link and invalidating the session.
                    packets.close();
                    let closed = time::timeout(Duration::from_secs(3), async {
                        while let Some(packet) = packets.recv().await {
                            if packet["op"] == 4 && packet["d"]["channel_id"].is_null() {
                                text(&mut self.socket, packet).await?;
                            }
                        }
                        self.socket.close(Some(CloseFrame {
                            code: CloseCode::Normal, reason: "Gateway shutdown".into(),
                        })).await.map_err(|_| anyhow::anyhow!("Discord websocket could not close"))
                    }).await;
                    if !matches!(closed, Ok(Ok(()))) { eprintln!("Discord Gateway shutdown was not acknowledged"); }
                    return Ok(End::Shutdown);
                }
                () = &mut authentication, if !self.authenticated => {
                    anyhow::bail!("Discord Gateway did not complete identification or session resume");
                }
                admission = &mut *self.admission, if !*self.admitted => {
                    *self.admitted = admission.is_ok();
                    if !*self.admitted { anyhow::bail!("Discord initial approval readiness closed"); }
                }
                _ = heartbeats.tick() => {
                    if !heartbeat_ack { return Ok(End::Resume); }
                    heartbeat_ack = false;
                    self.heartbeat().await?;
                }
                outgoing = packets.recv() => {
                    if let Some(value) = outgoing { text(&mut self.socket, value).await?; }
                }
                () = time::sleep_until(presence_allowed), if self.authenticated && presence_pending => {
                    connection.update(&mut self.socket, &mut self.session.presence_allowed).await?;
                }
                changed = connection.changed() => { changed?; }
                received = next(&mut self.socket) => {
                    let frame = match received? { Ok(frame) => frame, Err(end) => return Ok(end) };
                    match frame.op {
                        0 => {
                            let Some(sequence) = frame.s else { anyhow::bail!("Discord dispatch sequence is missing"); };
                            let Some(event) = frame.t.as_deref() else { anyhow::bail!("Discord dispatch type is missing"); };
                            if self.session.resume.is_none() && event != "READY" {
                                anyhow::bail!("Discord Gateway sent an event before authentication");
                            }
                            if event == "READY" {
                                let ready = Ready::deserialize(&frame.d)
                                    .map_err(|_| anyhow::anyhow!("Discord Gateway READY is invalid"))?;
                                let url = gateway_url(&ready.resume_gateway_url)?;
                                if ready.authenticate(state, self.session.presence_account.as_deref()).is_err()
                                    || ready.session_id.is_empty()
                                {
                                    return Ok(End::Fatal(4004));
                                }
                                if self.session.presence_account.is_none() {
                                    state.restore_ready_presence().await?;
                                }
                                self.session.resume = Some(Resume { url, id: ready.session_id, sequence });
                            }
                            self.dispatcher.event(event, frame.d, &Connection {
                                fresh: self.authenticated, admission_ready: *self.admitted, outbound: &outbound,
                            }).await?;
                            if let Some(resume) = &mut self.session.resume { resume.sequence = resume.sequence.max(sequence); }
                            if matches!(event, "READY" | "RESUMED") {
                                self.authenticated = true;
                                connection.connected(identified_presence.take());
                                if let Some(startup) = self.startup.take() {
                                    if startup.send(Ok(())).is_err() { return Ok(End::Identify); }
                                } else {
                                    self.dispatcher.reconnect()?;
                                }
                            }
                        }
                        1 => self.heartbeat().await?,
                        7 => return Ok(End::Resume),
                        9 => return Ok(End::InvalidSession(frame.d.as_bool() == Some(true))),
                        11 => heartbeat_ack = true,
                        _ => (),
                    }
                }
            }
        }
    }

    async fn heartbeat(&mut self) -> Result<()> {
        text(
            &mut self.socket,
            json!({"op": 1, "d": self.session.resume.as_ref().map(|session| session.sequence)}),
        )
        .await
    }
}
