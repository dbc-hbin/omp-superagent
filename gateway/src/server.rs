use std::{
    collections::{HashMap, HashSet},
    path::Path,
    sync::{Arc, Mutex, MutexGuard},
};

use anyhow::{Context, Result};
use async_trait::async_trait;
use serde_json::Value;
use tokio::{
    net::UnixListener,
    sync::{Notify, mpsc, oneshot},
    task::JoinHandle,
};
use tokio_util::task::TaskTracker;

use crate::{
    adapter::{EffectError, Hub as AdapterHub},
    store::Store,
};

mod attachments;
mod effects;
mod events;
mod protocol;
mod restart;
#[cfg(test)]
pub(crate) mod tests;
pub(crate) mod transport;

use restart::RestartCall;
use transport::SocketIdentity;

#[async_trait]
pub trait Service: Send + Sync {
    fn status(&self, connected: bool, head_ready: bool, admission_ready: bool) -> Result<Value>;
    async fn authorize_head(&self, pid: u32) -> Result<()>;
    async fn stop(&self) -> Result<()>;
    fn finish_stop(&self);
    async fn restart(&self, request: Value) -> std::result::Result<Value, EffectError>;
    fn run_restart(&self, request_id: &str) -> Result<()>;
}

pub struct Hub {
    store: Arc<Store>,
    service: Arc<dyn Service>,
    adapters: Arc<AdapterHub>,
    state: Mutex<Clients>,
    restarts: Mutex<Restarts>,
    effects: TaskTracker,
    stopped: Notify,
}

#[derive(Default)]
struct Clients {
    revision: u64,
    client: Option<Client>,
    closing: bool,
}

struct Client {
    revision: u64,
    id: String,
    pid: u32,
    ready: bool,
    resumed: bool,
    reconciled: bool,
    reconciliation: Option<String>,
    stream: Option<EventStream>,
}

struct EventStream {
    revision: u64,
    sender: mpsc::Sender<axum::body::Bytes>,
    cancel: oneshot::Sender<()>,
    sequence: Option<i64>,
}

#[derive(Default)]
struct Restarts {
    pending: HashMap<String, RestartCall>,
    started: HashSet<String>,
}

impl Hub {
    pub fn new(store: Arc<Store>, service: Arc<dyn Service>, adapters: Arc<AdapterHub>) -> Self {
        Self {
            store,
            service,
            adapters,
            state: Mutex::new(Clients::default()),
            restarts: Mutex::new(Restarts::default()),
            effects: TaskTracker::new(),
            stopped: Notify::new(),
        }
    }

    pub fn admission_ready(&self) -> bool {
        *self.adapters.ready.borrow()
    }

    pub fn connected(&self) -> bool {
        self.state()
            .is_ok_and(|state| state.client.as_ref().is_some_and(Client::connected))
    }

    pub fn head_ready(&self) -> bool {
        self.state()
            .is_ok_and(|state| state.client.as_ref().is_some_and(Client::head_ready))
            && self
                .store
                .unresolved()
                .is_ok_and(|unresolved| unresolved == 0)
    }

    pub async fn ready(&self) -> Result<()> {
        let mut ready = self.adapters.ready.subscribe();
        loop {
            let shutdown = self.stopped.notified();
            tokio::pin!(shutdown);
            shutdown.as_mut().enable();
            if *ready.borrow_and_update() {
                return Ok(());
            }
            anyhow::ensure!(
                !self.state()?.closing,
                "Gateway closed before initial head readiness"
            );
            tokio::select! {
                changed = ready.changed() => { changed?; }
                () = shutdown => {}
            }
        }
    }

    fn state(&self) -> Result<MutexGuard<'_, Clients>> {
        self.state
            .lock()
            .map_err(|_| anyhow::anyhow!("Gateway controller state lock was poisoned"))
    }

    fn closing(&self) -> Result<()> {
        let mut state = self.state()?;
        state.closing = true;
        if let Some(client) = state.client.take() {
            client.close();
        }
        self.stopped.notify_waiters();
        Ok(())
    }
}

impl Clients {
    fn next_revision(&mut self) -> Result<u64> {
        self.revision = self
            .revision
            .checked_add(1)
            .context("Gateway controller revision exhausted")?;
        Ok(self.revision)
    }
}

impl Client {
    fn connected(&self) -> bool {
        self.stream
            .as_ref()
            .is_some_and(|stream| !stream.sender.is_closed())
    }

    fn head_ready(&self) -> bool {
        self.connected() && self.ready && self.reconciliation.is_none()
    }

    fn close_stream(&mut self) {
        if let Some(stream) = self.stream.take() {
            // A disconnected peer may already have dropped the receiver.
            let _peer_was_listening = stream.cancel.send(()).is_ok();
        }
        self.ready = false;
    }

    fn close(mut self) {
        self.close_stream();
    }
}

pub struct Server {
    hub: Arc<Hub>,
    socket: SocketIdentity,
    stop: oneshot::Sender<()>,
    task: JoinHandle<Result<()>>,
}

impl Server {
    pub async fn listen(socket_path: &Path, hub: Arc<Hub>) -> Result<Self> {
        transport::private_directory(socket_path)?;
        let listener = UnixListener::bind(socket_path).context("Binding private Gateway socket")?;
        let socket = SocketIdentity::capture(socket_path)?;
        // The Store holds the lifetime lock, and no attachment handler can
        // enter until the listener task starts. Status-only paths never sweep.
        let startup = attachments::recover(hub.store.state_dir())
            .context("Recovering the private inbound attachment spool")
            .and_then(|()| socket.secure(&hub.store));
        if let Err(error) = startup {
            if socket.unlink().is_err() {
                eprintln!("Gateway socket startup cleanup failed");
            }
            return Err(error);
        }
        let (stop, shutdown) = oneshot::channel();
        let task = tokio::spawn(transport::serve(listener, Arc::clone(&hub), shutdown));
        Ok(Self {
            hub,
            socket,
            stop,
            task,
        })
    }

    pub async fn close(self) -> Result<()> {
        let closing = self.hub.closing();
        let _listener_was_running = self.stop.send(()).is_ok();
        let served = self.task.await;
        self.hub.effects.close();
        self.hub.effects.wait().await;
        let cleanup = self.socket.unlink();
        closing?;
        served??;
        cleanup
    }
}
