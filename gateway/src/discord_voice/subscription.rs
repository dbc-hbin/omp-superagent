#[path = "subscription/auth.rs"]
mod auth;
#[path = "subscription/control.rs"]
mod control;
#[path = "subscription/rtc.rs"]
mod rtc;

use anyhow::{Result, bail, ensure};
use std::time::Duration;
use tokio::time::Instant;

use super::Event;
use control::{Control, ControlEvent, DraftResult};
use rtc::MediaPeer;

const SPEECH_GAP: Duration = Duration::from_millis(200);
const RECENT_SPEECH: Duration = Duration::from_secs(20);

pub(super) struct Subscription {
    media: MediaPeer,
    control: Control,
    drafts: SpeechGate,
}

impl Subscription {
    pub(super) async fn open(voice: &str) -> Result<Self> {
        ensure!(
            control::validated_voice(voice),
            "Unsupported Codex subscription voice"
        );
        let login = auth::read_login().await?;
        let (media, offer) = MediaPeer::offer().await?;
        let (control, answer) = Control::open(&offer, voice, &login).await?;
        drop(login);
        Self::connect(media, control, answer).await
    }

    async fn connect(mut media: MediaPeer, mut control: Control, answer: String) -> Result<Self> {
        let setup = async {
            media.apply_answer(answer).await?;
            let mut started = false;
            let mut connected = false;
            while !started || !connected {
                tokio::select! {
                    result = async {
                        if connected { media.closed().await } else { media.ready().await }
                    } => { result?; connected = true; }
                    event = control.recv() => match event? {
                        ControlEvent::Started => started = true,
                        ControlEvent::Draft { id, .. } => control.draft_result(&id, DraftResult::NoText).await?,
                        ControlEvent::Other => {}
                    }
                }
            }
            media.activate()
        };
        if let Err(error) = setup.await {
            tokio::join!(media.close(), control.close());
            return Err(error);
        }
        Ok(Self {
            media,
            control,
            drafts: SpeechGate::default(),
        })
    }

    pub(super) fn input(&mut self, pcm: &[u8]) -> Result<()> {
        self.media.input(pcm)?;
        if energetic(pcm) {
            self.drafts.speech(Instant::now());
        }
        Ok(())
    }

    pub(super) async fn recv(&mut self) -> Result<Event> {
        tokio::select! {
            audio = self.media.recv() => audio.map(Event::Audio),
            event = self.control.recv() => match event? {
                ControlEvent::Started | ControlEvent::Other => Ok(Event::None),
                ControlEvent::Draft { id, text } => Ok(self.drafts.offer(id, text, Instant::now())),
            }
        }
    }

    pub(super) async fn draft_result(&mut self, id: &str, posted: bool) -> Result<()> {
        let result = self.drafts.result(id, posted)?;
        self.control.draft_result(id, result).await
    }

    pub(super) async fn close(&mut self) {
        tokio::join!(self.media.close(), self.control.close());
    }
}

#[derive(Default)]
struct SpeechGate {
    last_speech: Option<Instant>,
    fresh: bool,
    publishing: Option<String>,
    // media.rs answers a rejected draft before receiving the next event. It may
    // do so while a different draft is still being published on Discord.
    rejected: Option<(String, DraftResult)>,
}

impl SpeechGate {
    fn speech(&mut self, now: Instant) {
        if self
            .last_speech
            .is_none_or(|last| now.duration_since(last) >= SPEECH_GAP)
        {
            self.fresh = true;
        }
        self.last_speech = Some(now);
    }

    fn offer(&mut self, id: String, text: Option<String>, now: Instant) -> Event {
        let rejection = match text {
            None => DraftResult::NoText,
            Some(text)
                if self.fresh
                    && self.publishing.is_none()
                    && self
                        .last_speech
                        .is_some_and(|last| now.duration_since(last) <= RECENT_SPEECH) =>
            {
                self.fresh = false;
                self.publishing = Some(id.clone());
                return Event::Draft {
                    id,
                    text: Some(text),
                };
            }
            Some(_) => DraftResult::NotPosted,
        };
        self.rejected = Some((id.clone(), rejection));
        Event::Reject(id)
    }

    fn result(&mut self, id: &str, posted: bool) -> Result<DraftResult> {
        if self.publishing.as_deref() == Some(id) {
            self.publishing = None;
            return Ok(if posted {
                DraftResult::Posted
            } else {
                DraftResult::NotPosted
            });
        }
        if !posted && let Some((_, result)) = self.rejected.take_if(|(rejected, _)| rejected == id)
        {
            return Ok(result);
        }
        bail!("Uncorrelated Codex voice draft result")
    }
}

fn energetic(pcm: &[u8]) -> bool {
    let samples = pcm.chunks_exact(2);
    let count = u64::try_from(samples.len()).unwrap_or(u64::MAX);
    let energy: u64 = samples
        .map(|s| {
            i64::from(i16::from_le_bytes([s[0], s[1]]))
                .unsigned_abs()
                .pow(2)
        })
        .sum();
    count > 0 && energy >= count.saturating_mul(256 * 256)
}

#[cfg(test)]
#[path = "subscription/tests.rs"]
mod tests;
