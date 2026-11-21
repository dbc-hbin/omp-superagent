use std::{
    io,
    sync::{Arc, Weak},
};

use anyhow::Result;
use axum::{
    body::{Body, Bytes},
    http::{HeaderValue, header},
    response::Response,
};
use futures_util::stream;
use serde_json::{Map, Value, json};
use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;

use super::{
    Client, Clients, EventStream, Hub,
    protocol::{Fault, WireResult, rejected},
};
use crate::store::GatewayReceipt;

const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

impl Hub {
    pub(super) async fn attach(&self, id: String, data: &Map<String, Value>) -> WireResult<()> {
        let pid = data
            .get("pid")
            .and_then(safe_integer)
            .and_then(|pid| u32::try_from(pid).ok())
            .filter(|pid| *pid > 0)
            .ok_or_else(|| rejected("Invalid head PID"))?;
        self.service.authorize_head(pid).await.map_err(|error| {
            let fault = Fault::from(error);
            if fault.is_rejected() {
                fault
            } else {
                rejected("Gateway head authorization rejected")
            }
        })?;
        let mut state = self.state()?;
        if state.closing {
            return Err(rejected("Gateway is stopping"));
        }
        if state
            .client
            .as_ref()
            .is_some_and(|client| client.id != id && client.connected())
        {
            return Err(rejected("A head client is already attached"));
        }
        let revision = state.next_revision()?;
        let reconciled = state.client.take().is_some_and(|client| {
            let reconciled = client.id == id && client.pid == pid && client.reconciled;
            client.close();
            reconciled
        });
        state.client = Some(Client {
            revision,
            id,
            pid,
            ready: false,
            resumed: data.get("resumed") == Some(&Value::Bool(true)),
            reconciled,
            reconciliation: None,
            stream: None,
        });
        Ok(())
    }

    pub(super) fn open_events(self: &Arc<Self>, revision: u64) -> WireResult<Response> {
        let (sender, receiver) = mpsc::channel(1);
        let (cancel, cancelled) = oneshot::channel();
        let stream_revision = {
            let mut state = self.state()?;
            let stream_revision = state.next_revision()?;
            let client = state.controller(revision)?;
            if client.connected() {
                return Err(rejected("Head event stream already open"));
            }
            client.stream = Some(EventStream {
                revision: stream_revision,
                sender,
                cancel,
                sequence: None,
            });
            stream_revision
        };
        let guard = StreamGuard {
            hub: Arc::downgrade(self),
            stream_revision,
        };
        self.deliver()?;
        let stream = stream::unfold(
            (receiver, cancelled, guard),
            |(mut receiver, mut cancelled, guard)| async move {
                tokio::select! {
                    biased;
                    _ = &mut cancelled => Some((Err(io::Error::new(io::ErrorKind::ConnectionAborted, "Gateway event stream closed")), (receiver, cancelled, guard))),
                    frame = receiver.recv() => frame.map(|frame| (Ok(frame), (receiver, cancelled, guard))),
                }
            },
        );
        let mut response = Response::new(Body::from_stream(stream));
        response.headers_mut().insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/x-ndjson"),
        );
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        Ok(response)
    }

    pub(super) fn mark_ready(&self, revision: u64) -> WireResult<()> {
        let mut state = self.state()?;
        let client = state.controller(revision)?;
        if !client.ready && client.resumed {
            let event = if self.admission_ready() {
                json!({"kind": "reconnect"})
            } else {
                // Reuse the outstanding durable barrier after a lost/rejected
                // receipt, rather than growing an unbounded reconnect queue.
                let barrier = self
                    .store
                    .pending_barrier()?
                    .unwrap_or_else(|| Uuid::new_v4().to_string());
                client.reconciliation = Some(barrier.clone());
                json!({"kind": "reconnect", "barrier": barrier})
            };
            self.store.admit(&event)?;
        } else if !client.resumed {
            self.adapters.ready.send_replace(true);
        }
        client.ready = true;
        if client.reconciliation.is_none() {
            client.reconciled = true;
        }
        drop(state);
        self.deliver()?;
        Ok(())
    }

    pub(super) fn receipt(&self, revision: u64, data: &Map<String, Value>) -> WireResult<()> {
        let mut state = self.state()?;
        let client = state.controller(revision)?;
        let outstanding_sequence = client.stream.as_ref().and_then(|stream| stream.sequence);
        let sequence = data
            .get("sequence")
            .and_then(safe_integer)
            .filter(|sequence| Some(*sequence) == outstanding_sequence)
            .ok_or_else(|| rejected("Gateway receipt is not the outstanding event"))?;
        let frame = self.store.next(Some(sequence))?;
        let barrier = frame
            .as_ref()
            .and_then(|frame| frame.event.get("barrier"))
            .and_then(Value::as_str)
            .filter(|_| {
                frame
                    .as_ref()
                    .is_some_and(|frame| frame.event["kind"] == "reconnect")
            });
        let outcome: GatewayReceipt = data
            .get("outcome")
            .and_then(Value::as_str)
            .and_then(|outcome| match outcome {
                "accepted" => Some(GatewayReceipt::Accepted),
                "rejected" => Some(GatewayReceipt::Rejected),
                "unresolved" => Some(GatewayReceipt::Unresolved),
                _ => None,
            })
            .ok_or_else(|| rejected("Invalid Gateway admission receipt"))?;
        if barrier.is_some() && !self.admission_ready() && outcome != GatewayReceipt::Accepted {
            self.store.receipt(sequence, GatewayReceipt::Unresolved)?;
            client.close_stream();
            return Ok(());
        }
        self.store.receipt(sequence, outcome)?;
        if let Some(stream) = &mut client.stream {
            stream.sequence = None;
        }
        if barrier.is_some()
            && barrier == client.reconciliation.as_deref()
            && outcome == GatewayReceipt::Accepted
        {
            client.reconciliation = None;
            client.reconciled = true;
            self.adapters.ready.send_replace(true);
        }
        if outcome == GatewayReceipt::Unresolved {
            client.close_stream();
            return Ok(());
        }
        drop(state);
        self.deliver()?;
        Ok(())
    }

    pub(super) fn detach(&self, revision: u64) -> WireResult<()> {
        let mut state = self.state()?;
        state.controller(revision)?;
        if let Some(client) = state.client.take() {
            client.close();
        }
        Ok(())
    }

    pub fn deliver(&self) -> Result<()> {
        let mut state = self.state()?;
        let Some(client) = state.client.as_mut().filter(|client| client.ready) else {
            return Ok(());
        };
        let Some(stream) = client
            .stream
            .as_mut()
            .filter(|stream| stream.sequence.is_none())
        else {
            return Ok(());
        };
        if stream.sender.is_closed() {
            client.close_stream();
            return Ok(());
        }
        let frame = loop {
            let Some(frame) = self.store.next(None)? else {
                return Ok(());
            };
            if self.adapters.rooms.allows_event(&frame.event) {
                break frame;
            }
            self.store.receipt(frame.sequence, GatewayReceipt::Rejected)?;
        };
        let mut wire = serde_json::to_vec(&frame)?;
        wire.push(b'\n');
        // Persist attempts before reporting the callback over IPC. An
        // interrupted stream can never confer authority to replay it blindly.
        if frame.event["kind"] == "answer" {
            self.store.attempt(frame.sequence)?;
        }
        match stream.sender.try_send(Bytes::from(wire)) {
            Ok(()) => {
                stream.sequence = Some(frame.sequence);
            }
            Err(mpsc::error::TrySendError::Closed(_)) => client.close_stream(),
            Err(mpsc::error::TrySendError::Full(_)) => {
                anyhow::bail!("Gateway event stream is awaiting its last transfer")
            }
        }
        Ok(())
    }
}

impl Clients {
    pub(super) fn controller(&mut self, revision: u64) -> WireResult<&mut Client> {
        self.client
            .as_mut()
            .filter(|client| client.revision == revision)
            .ok_or_else(|| rejected("Gateway client is detached"))
    }
}

struct StreamGuard {
    hub: Weak<Hub>,
    stream_revision: u64,
}

impl Drop for StreamGuard {
    fn drop(&mut self) {
        if let Some(hub) = self.hub.upgrade()
            && let Ok(mut state) = hub.state()
            && let Some(client) = &mut state.client
            && client
                .stream
                .as_ref()
                .is_some_and(|stream| stream.revision == self.stream_revision)
        {
            client.close_stream();
        }
    }
}

pub(super) fn safe_integer(value: &Value) -> Option<i64> {
    // Normal JS clients send canonical integer numerals. JSON HTTP callers may
    // also send exponent/decimal spellings of an integral safe Number.
    if let Some(integer) = value.as_i64() {
        return (-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER)
            .contains(&integer)
            .then_some(integer);
    }
    let number = value.as_f64()?;
    if number.fract().to_bits() << 1 != 0 {
        return None;
    }
    let integer: i64 = format!("{number:.0}").parse().ok()?;
    (-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER)
        .contains(&integer)
        .then_some(integer)
}
