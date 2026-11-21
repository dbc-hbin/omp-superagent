use anyhow::{Context as _, Result, ensure};
use std::time::Duration;
use tokio::{
    task::JoinSet,
    time::{Instant, MissedTickBehavior, interval},
};

use super::super::{
    draft::{Delivery, Offer},
    provider::Event,
};
use super::{Call, Link, Permission, Provider, Service};

struct Publication {
    offer: Offer,
    grant: Option<Instant>,
}

type Published = (String, Option<Instant>, Delivery);

impl Service {
    pub(super) async fn media(
        &self,
        call: &Call,
        link: &mut Link,
        provider: &mut Provider,
    ) -> Result<()> {
        let mut frame_clock = interval(Duration::from_millis(20));
        frame_clock.set_missed_tick_behavior(MissedTickBehavior::Skip);
        let mut publications = JoinSet::<Published>::new();
        loop {
            tokio::select! {
                transfer = link.poll() => {
                    let pcm = link.handle(transfer?).await?;
                    ensure!(link.encrypted(), "Owner-only Discord media verification was lost");
                    if let Some(pcm) = pcm { provider.input(&pcm)?; }
                }
                _ = frame_clock.tick() => {
                    link.tick().await?;
                    provider.tick().await?;
                }
                event = provider.recv() => match event? {
                    Event::None => {}
                    Event::Audio(audio) => link.play(&audio)?,
                    Event::Reject(id) => provider.draft_result(&id, false).await?,
                    Event::Draft { id, text } => {
                        let offer = if let Some(text) = text { self.offer(call, &text).await } else { None };
                        if let Some(Publication { offer, grant }) = offer {
                            let rest = self.rest.clone();
                            publications.spawn(async move {
                                let budget = Instant::now() + Duration::from_secs(10);
                                let deadline = grant.map_or(budget, |grant| grant.min(budget));
                                (id, grant, offer.publish(&rest, deadline).await)
                            });
                        } else {
                            provider.draft_result(&id, false).await?;
                        }
                    }
                },
                done = publications.join_next(), if !publications.is_empty() => {
                    let (id, grant, delivery) = done.context("Voice draft worker ended unexpectedly")??;
                    let posted = self.record_draft(call, delivery, grant).await;
                    provider.draft_result(&id, posted).await?;
                }
            }
        }
    }

    async fn offer(&self, call: &Call, text: &str) -> Option<Publication> {
        let mut state = self.state.lock().await;
        let active = state
            .call
            .as_mut()
            .filter(|c| c.route == call.route && c.generation == call.generation && c.open())?;
        let grant = match active.permission {
            Permission::Off => return None,
            Permission::Call => None,
            Permission::One => {
                let until = active.share_until.filter(|until| Instant::now() < *until)?;
                active.permission = Permission::Off;
                active.share_until = None;
                Some(until)
            }
        };
        let offer = active.drafts.begin(call.route, text).ok()?;
        Some(Publication { offer, grant })
    }

    async fn record_draft(&self, call: &Call, delivery: Delivery, grant: Option<Instant>) -> bool {
        self.state
            .lock()
            .await
            .call
            .as_mut()
            .filter(|c| c.route == call.route && c.generation == call.generation && c.open())
            .is_some_and(|c| c.drafts.finish(delivery, grant))
    }
}
