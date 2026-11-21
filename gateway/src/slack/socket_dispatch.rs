use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use anyhow::anyhow;
use serde_json::json;
use tokio::sync::mpsc;
use tokio::task::JoinSet;
use tokio::time::timeout;

use super::{CancellationToken, Envelope, Event, Identity, Inner, QUEUE_CAPACITY};

pub(super) struct Dispatchers {
    cancelled: CancellationToken,
    input: mpsc::Sender<Envelope>,
    interactions: mpsc::Sender<Envelope>,
    workers: JoinSet<anyhow::Result<()>>,
}

impl Dispatchers {
    pub(super) fn new(inner: Arc<Inner>, identity: Arc<Identity>, reconnect: bool) -> Self {
        let cancelled = CancellationToken::new();
        let (input, messages) = mpsc::channel(QUEUE_CAPACITY);
        let (interactions, callbacks) = mpsc::channel(QUEUE_CAPACITY);
        let mut workers = JoinSet::new();
        let scope = Worker {
            inner,
            identity,
            cancelled: cancelled.clone(),
        };
        workers.spawn(scope.clone().intake(messages, reconnect));
        workers.spawn(scope.cards(callbacks));
        Self {
            cancelled,
            input,
            interactions,
            workers,
        }
    }

    pub(super) fn send(&self, envelope: Envelope) -> anyhow::Result<()> {
        let queue = if matches!(envelope.event, Event::Interactive(_)) {
            &self.interactions
        } else {
            &self.input
        };
        queue
            .try_send(envelope)
            .map_err(|_| anyhow!("Slack Socket Mode ingress queue is full"))
    }

    pub(super) async fn ended(&mut self) {
        if let Some(Err(_)) | Some(Ok(Err(_))) = self.workers.join_next().await {
            eprintln!("Slack Socket Mode readiness or dispatcher failed");
        }
    }

    pub(super) async fn finish(mut self) {
        self.cancelled.cancel();
        while let Some(ended) = self.workers.join_next().await {
            if !matches!(ended, Ok(Ok(()))) {
                eprintln!("Slack Socket Mode dispatcher stopped unexpectedly");
            }
        }
    }
}

#[derive(Clone)]
struct Worker {
    inner: Arc<Inner>,
    identity: Arc<Identity>,
    cancelled: CancellationToken,
}

impl Worker {
    async fn ready(&self) -> anyhow::Result<bool> {
        tokio::select! {
            biased;
            () = self.cancelled.cancelled() => Ok(false),
            ready = self.inner.ctx.ready() => ready.map(|()| true),
        }
    }

    async fn next(&self, queue: &mut mpsc::Receiver<Envelope>) -> Option<Envelope> {
        tokio::select! {
            biased;
            () = self.cancelled.cancelled() => None,
            item = queue.recv() => item,
        }
    }

    async fn handle(&self, envelope: Envelope) {
        if let Err(error) = self
            .inner
            .handle_event(&self.identity, envelope.ack, envelope.event)
            .await
        {
            eprintln!("Slack Socket Mode envelope handling failed: {error}");
        }
    }

    async fn intake(
        self,
        mut queue: mpsc::Receiver<Envelope>,
        reconnect: bool,
    ) -> anyhow::Result<()> {
        if !self.ready().await? {
            return Ok(());
        }
        if reconnect {
            self.inner.admit(json!({ "kind": "reconnect" })).await?;
        }
        while let Some(envelope) = self.next(&mut queue).await {
            self.handle(envelope).await;
        }
        Ok(())
    }

    async fn cards(self, mut queue: mpsc::Receiver<Envelope>) -> anyhow::Result<()> {
        if !self.ready().await? {
            return Ok(());
        }
        let mut cards: HashMap<String, mpsc::Sender<Envelope>> = HashMap::new();
        let mut workers = JoinSet::new();
        loop {
            tokio::select! {
                biased;
                () = self.cancelled.cancelled() => break,
                Some(ended) = workers.join_next() => {
                    if ended.is_err() {
                        return Err(anyhow!("Slack card dispatcher stopped unexpectedly"));
                    }
                    cards.retain(|_, sender| !sender.is_closed());
                }
                item = queue.recv() => {
                    let Some(envelope) = item else { break };
                    let key = match &envelope.event {
                        Event::Interactive(body) => self.inner.interaction_key(body).await,
                        Event::Events { .. } | Event::Slash(_) | Event::Unknown => None,
                    };
                    let Some(key) = key else {
                        self.handle(envelope).await;
                        continue;
                    };
                    let sender = cards.entry(key).or_insert_with(|| {
                        let (sender, receiver) = mpsc::channel(QUEUE_CAPACITY);
                        workers.spawn(self.clone().card(receiver));
                        sender
                    });
                    if sender.try_send(envelope).is_err() {
                        // Do not ACK a callback whose turn could not be queued.
                        eprintln!("Slack Socket Mode card queue unavailable");
                    }
                }
            }
        }
        while let Some(ended) = workers.join_next().await {
            if ended.is_err() {
                return Err(anyhow!("Slack card dispatcher stopped unexpectedly"));
            }
        }
        Ok(())
    }

    async fn card(self, mut queue: mpsc::Receiver<Envelope>) {
        while let Ok(Some(envelope)) = timeout(Duration::from_secs(60), self.next(&mut queue)).await
        {
            self.handle(envelope).await;
        }
    }
}
