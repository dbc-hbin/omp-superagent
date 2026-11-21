use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context as _, anyhow, bail, ensure};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio::time::{Instant, MissedTickBehavior, interval_at, sleep, timeout};
use tokio_tungstenite::tungstenite::{Message, protocol::WebSocketConfig};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async_with_config};
use tokio_util::sync::CancellationToken;

use crate::adapter::EffectError;

use super::Inner;
use super::api::Identity;

#[path = "socket_dispatch.rs"]
mod dispatch;
use self::dispatch::Dispatchers;

const WS_TIMEOUT: Duration = Duration::from_secs(20);
const PING_INTERVAL: Duration = Duration::from_secs(15);
const PONG_TIMEOUT: Duration = Duration::from_secs(35);
const WS_WRITE_TIMEOUT: Duration = Duration::from_secs(10);
const QUEUE_CAPACITY: usize = 1_024;

pub(super) type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

pub(super) struct SocketTask {
    stop: Option<oneshot::Sender<()>>,
    join: JoinHandle<()>,
}

impl SocketTask {
    pub(super) async fn stop(mut self) -> anyhow::Result<()> {
        if let Some(stop) = self.stop.take() {
            // A completed socket worker no longer needs the cancellation signal.
            if stop.send(()).is_err() && !self.join.is_finished() {
                self.join.abort();
            }
        }
        (&mut self.join)
            .await
            .context("Slack Socket Mode worker stopped unexpectedly")
    }
}

impl Drop for SocketTask {
    fn drop(&mut self) {
        self.join.abort();
    }
}

#[derive(Deserialize)]
struct Frame {
    #[serde(rename = "type")]
    kind: String,
    connection_info: Option<ConnectionInfo>,
    envelope_id: Option<String>,
    accepts_response_payload: Option<bool>,
    retry_attempt: Option<u64>,
    payload: Option<Value>,
}

#[derive(Deserialize)]
struct ConnectionInfo {
    app_id: String,
}

pub(super) enum Event {
    Events { body: Value, replayed: bool },
    Slash(Value),
    Interactive(Value),
    Unknown,
}

struct Envelope {
    ack: Ack,
    event: Event,
}

struct AckRequest {
    frame: Value,
    sent: oneshot::Sender<()>,
}

pub(super) struct Ack {
    pub(super) id: String,
    accepts_payload: bool,
    tx: mpsc::Sender<AckRequest>,
}

impl Ack {
    pub(super) async fn send(self, payload: Option<Value>) -> Result<(), EffectError> {
        let frame = ack_frame(&self.id, payload.filter(|_| self.accepts_payload));
        let (sent, flushed) = oneshot::channel();
        self.tx
            .send(AckRequest { frame, sent })
            .await
            .map_err(|_| EffectError::uncertain("Slack Socket Mode disconnected before ACK"))?;
        flushed
            .await
            .map_err(|_| EffectError::uncertain("Slack Socket Mode ACK was not confirmed"))
    }
}

fn ack_frame(id: &str, payload: Option<Value>) -> Value {
    match payload {
        Some(payload) => json!({ "envelope_id": id, "payload": payload }),
        None => json!({ "envelope_id": id }),
    }
}

impl Inner {
    pub(super) async fn connect(&self, identity: &Identity) -> anyhow::Result<Socket> {
        let url = self.api.socket_url().await?;
        let config = WebSocketConfig::default()
            .max_message_size(Some(2 * 1024 * 1024))
            .max_frame_size(Some(2 * 1024 * 1024));
        let (mut socket, _) = timeout(
            WS_TIMEOUT,
            connect_async_with_config(url.as_str(), Some(config), true),
        )
        .await
        .map_err(|_| anyhow!("Slack Socket Mode connect timed out"))?
        .map_err(|_| anyhow!("Slack Socket Mode transport failed"))?;
        timeout(WS_TIMEOUT, async {
            while let Some(frame) = socket.next().await {
                match frame
                    .map_err(|_| anyhow!("Slack Socket Mode transport failed before hello"))?
                {
                    Message::Text(text) => {
                        let hello: Frame = serde_json::from_str(&text)
                            .map_err(|_| anyhow!("Slack sent an invalid Socket Mode hello"))?;
                        ensure!(
                            hello.kind == "hello"
                                && hello
                                    .connection_info
                                    .is_some_and(|info| info.app_id == identity.app_id),
                            "Slack Socket Mode application does not match the authenticated bot"
                        );
                        return Ok(());
                    }
                    Message::Ping(_) => socket
                        .flush()
                        .await
                        .map_err(|_| anyhow!("Slack Socket Mode heartbeat failed"))?,
                    Message::Close(_) => break,
                    Message::Binary(_) | Message::Pong(_) | Message::Frame(_) => {}
                }
            }
            bail!("Slack Socket Mode closed before hello")
        })
        .await
        .map_err(|_| anyhow!("Slack Socket Mode hello timed out"))??;
        Ok(socket)
    }

    pub(super) fn spawn_socket(
        self: Arc<Self>,
        initial: Socket,
        identity: Arc<Identity>,
    ) -> SocketTask {
        let (stop, mut cancelled) = oneshot::channel();
        let join = tokio::spawn(async move {
            let mut connection = initial;
            let mut reconnect = false;
            loop {
                let established = self
                    .run_socket(&mut connection, &identity, reconnect, &mut cancelled)
                    .await;
                match established {
                    Ok(()) => return,
                    Err(_) => eprintln!("Slack Socket Mode disconnected; reconnecting"),
                }
                drop(connection);
                reconnect = true;
                let mut delay = Duration::from_secs(1);
                loop {
                    tokio::select! {
                        biased;
                        _ = &mut cancelled => return,
                        () = sleep(delay) => {}
                    }
                    let attempt = tokio::select! {
                        biased;
                        _ = &mut cancelled => return,
                        attempt = self.connect(&identity) => attempt,
                    };
                    match attempt {
                        Ok(socket) => {
                            connection = socket;
                            break;
                        }
                        Err(_) => {
                            eprintln!(
                                "Slack Socket Mode authentication or transport failed during reconnect"
                            );
                            delay = delay.saturating_mul(2).min(Duration::from_secs(60));
                        }
                    }
                }
            }
        });
        SocketTask {
            stop: Some(stop),
            join,
        }
    }

    async fn run_socket(
        self: &Arc<Self>,
        socket: &mut Socket,
        identity: &Arc<Identity>,
        reconnect: bool,
        cancelled: &mut oneshot::Receiver<()>,
    ) -> anyhow::Result<()> {
        let (ack_tx, mut acks) = mpsc::channel::<AckRequest>(QUEUE_CAPACITY);
        let mut dispatch = Dispatchers::new(self.clone(), identity.clone(), reconnect);
        let result = self
            .socket_loop(
                socket,
                &identity.app_id,
                ack_tx,
                &mut acks,
                &mut dispatch,
                cancelled,
            )
            .await;
        // No old connection can ACK on a new socket. In-flight work is allowed to
        // settle (including a chat.update already sent); unread inputs are not admitted.
        drop(acks);
        dispatch.finish().await;
        if result.is_ok() {
            match timeout(WS_WRITE_TIMEOUT, socket.close(None)).await {
                Ok(Ok(())) => {}
                Ok(Err(_)) | Err(_) => eprintln!("Slack Socket Mode shutdown frame failed"),
            }
        }
        result
    }

    async fn socket_loop(
        &self,
        socket: &mut Socket,
        app_id: &str,
        ack_tx: mpsc::Sender<AckRequest>,
        acks: &mut mpsc::Receiver<AckRequest>,
        dispatch: &mut Dispatchers,
        cancelled: &mut oneshot::Receiver<()>,
    ) -> anyhow::Result<()> {
        let mut ping = interval_at(Instant::now() + PING_INTERVAL, PING_INTERVAL);
        ping.set_missed_tick_behavior(MissedTickBehavior::Delay);
        let mut last_pong = Instant::now();
        let mut challenge = 0_u64;
        loop {
            tokio::select! {
                biased;
                _ = &mut *cancelled => return Ok(()),
                () = dispatch.ended() => bail!("Slack Socket Mode worker stopped"),
                Some(ack) = acks.recv() => {
                    write(socket, Message::Text(ack.frame.to_string().into())).await?;
                    // The envelope worker may have been cancelled after durable admission.
                    if ack.sent.send(()).is_err() {
                        eprintln!("Slack Socket Mode ACK consumer stopped");
                    }
                }
                _ = ping.tick() => {
                    ensure!(last_pong.elapsed() < PONG_TIMEOUT, "Slack Socket Mode heartbeat expired");
                    challenge = challenge.wrapping_add(1);
                    write(socket, Message::Ping(challenge.to_be_bytes().to_vec().into())).await?;
                }
                received = socket.next() => match received {
                    Some(Ok(Message::Text(text))) => {
                        let Ok(frame) = serde_json::from_str::<Frame>(&text) else { continue };
                        match frame.kind.as_str() {
                            "disconnect" => bail!("Slack requested Socket Mode reconnect"),
                            "hello" => ensure!(frame.connection_info.is_some_and(|info| info.app_id == app_id),
                                "Slack Socket Mode application identity changed"),
                            _ => {
                                let Some(id) = frame.envelope_id.filter(|id| !id.is_empty()) else { continue };
                                let payload = frame.payload.unwrap_or(Value::Null);
                                let event = match frame.kind.as_str() {
                                    "events_api" => Event::Events {
                                        body: payload,
                                        replayed: frame.retry_attempt.is_some_and(|attempt| attempt > 0),
                                    },
                                    "slash_commands" => Event::Slash(payload),
                                    "interactive" => Event::Interactive(payload),
                                    _ => Event::Unknown,
                                };
                                dispatch.send(Envelope {
                                    ack: Ack { id, accepts_payload: frame.accepts_response_payload == Some(true), tx: ack_tx.clone() },
                                    event,
                                })?;
                            }
                        }
                    }
                    Some(Ok(Message::Ping(_))) => timeout(WS_WRITE_TIMEOUT, socket.flush()).await
                        .map_err(|_| anyhow!("Slack Socket Mode heartbeat timed out"))?
                        .map_err(|_| anyhow!("Slack Socket Mode heartbeat failed"))?,
                    Some(Ok(Message::Pong(data))) => {
                        if data.as_ref() == challenge.to_be_bytes() {
                            last_pong = Instant::now();
                        }
                    }
                    Some(Ok(Message::Binary(_) | Message::Frame(_))) => {}
                    Some(Ok(Message::Close(_)) | Err(_)) | None => bail!("Slack Socket Mode connection ended"),
                }
            }
        }
    }
}

async fn write(socket: &mut Socket, message: Message) -> anyhow::Result<()> {
    timeout(WS_WRITE_TIMEOUT, socket.send(message))
        .await
        .map_err(|_| anyhow!("Slack Socket Mode write timed out"))?
        .map_err(|_| anyhow!("Slack Socket Mode write failed"))
}

#[cfg(test)]
#[path = "socket_tests.rs"]
mod tests;
