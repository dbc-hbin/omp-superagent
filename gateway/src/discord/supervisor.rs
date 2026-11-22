use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use tokio::{
    sync::{mpsc, oneshot},
    task::JoinHandle,
    time,
};
use tokio_tungstenite::connect_async;
use tokio_util::{sync::CancellationToken, task::TaskTracker};

use super::State;
use super::dispatch::{Dispatcher, ordered_intake};
use super::login::Login;
use super::socket::{End, Link, Session, jitter};

pub(super) struct Task {
    cancel: CancellationToken,
    handle: JoinHandle<()>,
}

impl Drop for Task {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

impl Task {
    pub async fn start(state: Arc<State>) -> Result<Self> {
        let login = Login::discover(&state).await?;
        let presence_account = state.restore_presence().await?;
        let backlog = state.ctx.discord_intake().last()?;
        let (started, startup) = oneshot::channel();
        let cancel = CancellationToken::new();
        let child = cancel.clone();
        let handle = tokio::spawn(async move {
            let interactions = TaskTracker::new();
            let (ready, admission) = oneshot::channel();
            // Owner markers point at committed rows. Only live effects still
            // require the volatile queue; the socket never waits for REST.
            let (incoming, receiver) = mpsc::channel(1024);
            let intake_state = Arc::clone(&state);
            let intake_cancel = child.clone();
            let intake = tokio::spawn(async move {
                tokio::select! {
                    biased;
                    () = intake_cancel.cancelled() => (),
                    () = ordered_intake(intake_state, receiver, ready, backlog) => (),
                }
            });
            let dispatcher = Dispatcher::new(state, incoming, interactions.clone(), child.clone());
            let session = Session::new(presence_account);
            supervise(dispatcher, (login, session), Some(started), admission, &child).await;
            child.cancel();
            if intake.await.is_err() {
                eprintln!("Discord ordered intake stopped unexpectedly");
            }
            interactions.close();
            interactions.wait().await;
        });
        let task = Self { cancel, handle };
        match time::timeout(Duration::from_secs(45), startup).await {
            Ok(Ok(Ok(()))) => Ok(task),
            Ok(Ok(Err(error))) => {
                task.stop().await;
                Err(error)
            }
            Ok(Err(_)) => {
                task.stop().await;
                anyhow::bail!("Discord Gateway closed before authentication")
            }
            Err(_) => {
                task.stop().await;
                anyhow::bail!("Discord Gateway authentication timed out")
            }
        }
    }

    pub async fn stop(mut self) {
        self.cancel.cancel();
        if (&mut self.handle).await.is_err() {
            eprintln!("Discord socket task stopped unexpectedly");
        }
    }
}

async fn supervise(
    dispatcher: Dispatcher,
    (mut login, mut session): (Login, Session),
    mut startup: Option<oneshot::Sender<Result<()>>>,
    mut admission: oneshot::Receiver<()>,
    cancel: &CancellationToken,
) {
    let mut admitted = false;
    let mut delay = Duration::from_secs(1);
    loop {
        if session.resume.is_none() {
            tokio::select! {
                biased;
                () = cancel.cancelled() => break,
                () = login.limiter.wait() => (),
            }
        }
        let target = session
            .resume
            .as_ref()
            .map_or(&login.target, |resume| &resume.url);
        let connected = tokio::select! {
            biased;
            () = cancel.cancelled() => break,
            result = time::timeout(Duration::from_secs(12), connect_async(target.as_str())) => result,
        };
        let ended = match connected {
            Ok(Ok((socket, _))) => {
                let mut link = Link {
                    socket,
                    dispatcher: &dispatcher,
                    session: &mut session,
                    startup: &mut startup,
                    admission: &mut admission,
                    admitted: &mut admitted,
                    authenticated: false,
                    limiter: &mut login.limiter,
                    cancel,
                };
                let end = link.run().await;
                if link.authenticated {
                    delay = Duration::from_secs(1);
                }
                drop(link);
                if let Some(voice) = &dispatcher.state().voice {
                    voice.on_disconnect().await;
                }
                match end {
                    Ok(end) => end,
                    Err(error) => {
                        // All errors produced inside the link are sanitized protocol state.
                        eprintln!("Discord Gateway link ended: {error}");
                        End::Resume
                    }
                }
            }
            Ok(Err(_)) | Err(_) => {
                eprintln!("Discord Gateway websocket could not connect");
                End::Resume
            }
        };
        let wait = match ended {
            End::Shutdown => break,
            End::Fatal(code) => {
                let explanation = if code == 4011 {
                    "Discord requires sharding; this adapter uses the original single-shard policy"
                } else {
                    "Discord Gateway rejected authentication or intents"
                };
                if let Some(waiting) = startup.take() {
                    if waiting
                        .send(Err(anyhow::anyhow!("{explanation} ({code})")))
                        .is_err()
                    {
                        eprintln!("Discord startup receiver closed");
                    }
                } else {
                    eprintln!("Discord Gateway refused reconnect permanently (close code {code})");
                }
                break;
            }
            End::Identify => {
                session.resume = None;
                delay
            }
            End::Resume => delay,
            End::InvalidSession(resume) => {
                if !resume {
                    session.resume = None;
                }
                Duration::from_secs(1) + jitter(4_000)
            }
        };
        tokio::select! {
            biased;
            () = cancel.cancelled() => break,
            () = time::sleep(wait) => (),
        }
        delay = (delay * 2).min(Duration::from_secs(30));
    }
}
