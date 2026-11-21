use anyhow::{Context as _, Result, anyhow, bail, ensure};
use tokio::{
    sync::{mpsc, oneshot, watch},
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;
use webrtc::{api::setting_engine::SettingEngine, peer_connection::RTCPeerConnection};

#[path = "rtc_audio.rs"]
mod audio;
#[cfg(test)]
#[path = "rtc_tests.rs"]
pub(super) mod tests;
#[path = "rtc_transport.rs"]
mod transport;

use audio::{LocalAudio, PendingPcm};
use transport::{MediaLink, connection, ensure_negotiated_audio, parse_answer};

const PCM_QUEUE_FRAMES: usize = 25;

enum Status {
    Opening,
    Answered,
    Ready,
    Active,
    Closed(String),
}

impl Status {
    fn running(&self) -> Result<()> {
        match self {
            Self::Closed(reason) => bail!("{reason}"),
            Self::Opening | Self::Answered | Self::Ready | Self::Active => Ok(()),
        }
    }

    async fn closed_error(mut watch: watch::Receiver<Self>) -> anyhow::Error {
        loop {
            if let Self::Closed(reason) = &*watch.borrow_and_update() {
                return anyhow!("{reason}");
            }
            if watch.changed().await.is_err() {
                return anyhow!("Codex voice media status stopped");
            }
        }
    }
}

pub(super) struct MediaPeer {
    stop: CancellationToken,
    driver: Option<JoinHandle<()>>,
    answer: Option<oneshot::Sender<String>>,
    status: watch::Sender<Status>,
    input: PendingPcm,
    output: mpsc::Receiver<Vec<u8>>,
}

impl MediaPeer {
    pub(super) async fn offer() -> Result<(Self, String)> {
        Self::offer_with(SettingEngine::default()).await
    }

    #[cfg(test)]
    pub(super) async fn loopback_offer() -> Result<(Self, String)> {
        Self::offer_with(tests::loopback_settings()).await
    }

    async fn offer_with(settings: SettingEngine) -> Result<(Self, String)> {
        let (peer, offer) = Self::start(settings);
        match offer.await {
            Ok(sdp) => Ok((peer, sdp)),
            Err(_) => {
                peer.status.borrow().running()?;
                bail!("Codex voice media offer stopped");
            }
        }
    }

    fn start(settings: SettingEngine) -> (Self, oneshot::Receiver<String>) {
        let (offer_tx, offer_rx) = oneshot::channel();
        let (answer_tx, answer_rx) = oneshot::channel();
        let (output_tx, output_rx) = mpsc::channel(PCM_QUEUE_FRAMES);
        let (status, _) = watch::channel(Status::Opening);
        let stop = CancellationToken::new();
        let input = PendingPcm::default();
        let driver = Driver {
            stop: stop.clone(),
            offer: Some(offer_tx),
            answer: answer_rx,
            status: status.clone(),
            input: input.clone(),
            output: output_tx,
        };
        (
            Self {
                stop,
                driver: Some(tokio::spawn(driver.run(settings))),
                answer: Some(answer_tx),
                status,
                input,
                output: output_rx,
            },
            offer_rx,
        )
    }

    pub(super) async fn apply_answer(&mut self, sdp: String) -> Result<()> {
        self.status.borrow().running()?;
        self.answer
            .take()
            .context("Codex voice media answer already supplied")?
            .send(sdp)
            .map_err(|_| anyhow!("Codex voice media stopped before the answer"))?;
        let mut status = self.status.subscribe();
        let state = status
            .wait_for(|state| !matches!(state, Status::Opening))
            .await
            .context("Codex voice media status stopped")?;
        state.running()
    }

    pub(super) async fn ready(&mut self) -> Result<()> {
        let mut status = self.status.subscribe();
        let state = status
            .wait_for(|state| !matches!(state, Status::Opening | Status::Answered))
            .await
            .context("Codex voice media status stopped")?;
        state.running()
    }

    pub(super) async fn closed(&self) -> Result<()> {
        Err(Status::closed_error(self.status.subscribe()).await)
    }

    pub(super) fn activate(&mut self) -> Result<()> {
        let activated = self.status.send_if_modified(|state| match state {
            Status::Ready => {
                *state = Status::Active;
                true
            }
            Status::Opening | Status::Answered | Status::Active | Status::Closed(_) => false,
        });
        if activated {
            return Ok(());
        }
        self.status.borrow().running()?;
        bail!("Codex voice media is not ready for activation");
    }

    pub(super) fn input(&mut self, pcm: &[u8]) -> Result<()> {
        let state = self.status.borrow();
        state.running()?;
        ensure!(
            matches!(*state, Status::Active),
            "Codex voice media is not active"
        );
        self.input.append(pcm)
    }

    pub(super) async fn recv(&mut self) -> Result<Vec<u8>> {
        let status = self.status.subscribe();
        tokio::select! {
            biased;
            error = Status::closed_error(status) => Err(error),
            output = self.output.recv() => {
                self.status.borrow().running()?;
                output.context("Codex voice audio stopped")
            }
        }
    }

    pub(super) async fn close(&mut self) {
        self.stop.cancel();
        if let Some(driver) = &mut self.driver {
            if driver.await.is_err() {
                eprintln!("Codex voice media task failed");
            }
            self.driver = None;
        }
    }
}

impl Drop for MediaPeer {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}

struct Driver {
    stop: CancellationToken,
    offer: Option<oneshot::Sender<String>>,
    answer: oneshot::Receiver<String>,
    status: watch::Sender<Status>,
    input: PendingPcm,
    output: mpsc::Sender<Vec<u8>>,
}

impl Driver {
    async fn run(mut self, settings: SettingEngine) {
        // Own all WebRTC setup and teardown in this task. Dropping even the offer
        // future signals cancellation without interrupting a partial WebRTC close.
        if self.stop.is_cancelled() {
            self.publish_closed(Ok(()));
            return;
        }
        match connection(settings).await {
            Ok(connection) => {
                let result = self.session(&connection).await;
                self.publish_closed(result);
                if connection.close().await.is_err() {
                    eprintln!("Codex voice media cleanup failed");
                }
            }
            Err(error) => self.publish_closed(Err(error)),
        }
    }

    fn publish_closed(&self, result: Result<()>) {
        let reason = match result {
            Ok(()) => "Codex voice media closed".to_owned(),
            Err(error) => error.to_string(),
        };
        self.status.send_replace(Status::Closed(reason));
    }

    async fn session(&mut self, peer: &RTCPeerConnection) -> Result<()> {
        if self.stop.is_cancelled() {
            return Ok(());
        }
        let link = MediaLink::register(peer);
        let local = LocalAudio::add_to(peer).await?;
        let offer = peer
            .create_offer(None)
            .await
            .map_err(|_| anyhow!("Codex voice media offer could not be prepared"))?;
        let mut gathered = peer.gathering_complete_promise().await;
        peer.set_local_description(offer)
            .await
            .map_err(|_| anyhow!("Codex voice local SDP could not be set"))?;
        tokio::select! {
            biased;
            () = self.stop.cancelled() => return Ok(()),
            _ = gathered.recv() => {}
        }
        let local_sdp = peer
            .local_description()
            .await
            .context("Codex voice local SDP is unavailable")?
            .sdp;
        self.offer
            .take()
            .context("Codex voice media offer already delivered")?
            .send(local_sdp)
            .map_err(|_| anyhow!("Codex voice media opening was cancelled"))?;
        let answer = tokio::select! {
            biased;
            () = self.stop.cancelled() => return Ok(()),
            answer = &mut self.answer => answer.context("Codex voice media answer was not supplied")?,
        };
        peer.set_remote_description(parse_answer(answer)?)
            .await
            .map_err(|_| anyhow!("Codex voice media answer was rejected"))?;
        ensure_negotiated_audio(peer).await?;
        self.status.send_replace(Status::Answered);
        tokio::select! {
            biased;
            () = self.stop.cancelled() => return Ok(()),
            () = link.invalid_track.cancelled() => bail!("Codex voice remote media is not a single Opus track"),
            connected = link.wait_connected(peer) => connected?,
        }
        // A silent answerer may not send RTP until the operator speaks. The
        // negotiated receiver and connected transport, not the first packet,
        // determine readiness; on_track still validates the actual media.
        self.status.send_replace(Status::Ready);
        tokio::select! {
            biased;
            () = self.stop.cancelled() => Ok(()),
            () = link.failed.cancelled() => bail!("Codex voice media connection lost"),
            () = link.invalid_track.cancelled() => bail!("Codex voice remote media is not a single Opus track"),
            result = local.send(&self.input) => result,
            result = local.drain_rtcp() => result,
            result = audio::receive(link.track, &self.status, &self.output) => result,
        }
    }
}
