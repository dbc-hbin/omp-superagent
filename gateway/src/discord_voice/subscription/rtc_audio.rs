use anyhow::{Context as _, Result, anyhow, ensure};
use opus2::{Application, Channels, Decoder, Encoder};
use std::{
    collections::VecDeque,
    mem::size_of,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    sync::{mpsc, oneshot, watch},
    time::Instant,
};
use webrtc::{
    api::media_engine::MIME_TYPE_OPUS,
    media::Sample,
    peer_connection::RTCPeerConnection,
    rtcp::goodbye::Goodbye,
    rtp::packet::Packet,
    rtp_transceiver::{
        rtp_codec::{RTCRtpCodecCapability, RTCRtpCodecParameters, RTPCodecType},
        rtp_receiver::RTCRtpReceiver,
        rtp_sender::RTCRtpSender,
    },
    track::{
        track_local::track_local_static_sample::TrackLocalStaticSample, track_remote::TrackRemote,
    },
};

#[path = "rtc_clock.rs"]
mod clock;
#[path = "rtc_reorder.rs"]
mod reorder;

use crate::discord::voice::provider::{FRAME, MAX_INPUT};

use super::Status;
use clock::FrameClock;
use reorder::RtpOrder;

pub(super) const PCM_RATE: u32 = 24_000;
pub(super) const FRAME_SAMPLES: usize = FRAME / size_of::<i16>();
pub(super) const FRAME_DURATION: Duration = Duration::from_millis(20);
const RTP_CLOCK_RATE: u32 = 48_000;
const MAX_PENDING_SAMPLES: usize = MAX_INPUT / size_of::<i16>();
const READ_MTU: usize = 1460;

pub(super) fn opus_codec() -> RTCRtpCodecParameters {
    RTCRtpCodecParameters {
        capability: RTCRtpCodecCapability {
            mime_type: MIME_TYPE_OPUS.to_owned(),
            clock_rate: RTP_CLOCK_RATE,
            // RFC 7587 advertises two RTP channels even when encoding mono.
            channels: 2,
            sdp_fmtp_line: "minptime=10;useinbandfec=1".to_owned(),
            ..Default::default()
        },
        payload_type: 111,
        ..Default::default()
    }
}

pub(super) fn is_opus(track: &TrackRemote) -> bool {
    track.kind() == RTPCodecType::Audio && is_opus_codec(&track.codec().capability)
}

pub(super) fn is_opus_codec(codec: &RTCRtpCodecCapability) -> bool {
    codec.mime_type.eq_ignore_ascii_case(MIME_TYPE_OPUS)
        && codec.clock_rate == RTP_CLOCK_RATE
        && codec.channels == 2
}

#[derive(Clone, Default)]
pub(super) struct PendingPcm(Arc<Mutex<VecDeque<i16>>>);

impl PendingPcm {
    pub(super) fn append(&self, pcm: &[u8]) -> Result<()> {
        let mut pending = self
            .0
            .lock()
            .map_err(|_| anyhow!("Codex voice input queue failed"))?;
        ensure!(
            !pcm.is_empty()
                && pcm.len().is_multiple_of(2)
                && pcm.len() / 2 <= MAX_PENDING_SAMPLES - pending.len(),
            "Invalid or congested Codex voice PCM input"
        );
        pending.extend(
            pcm.chunks_exact(2)
                .map(|pair| i16::from_le_bytes([pair[0], pair[1]])),
        );
        Ok(())
    }

    fn frame(&self) -> Result<[i16; FRAME_SAMPLES]> {
        let mut pending = self
            .0
            .lock()
            .map_err(|_| anyhow!("Codex voice input queue failed"))?;
        let mut frame = [0; FRAME_SAMPLES];
        let available = pending.len().min(FRAME_SAMPLES);
        for (dst, sample) in frame.iter_mut().zip(pending.drain(..available)) {
            *dst = sample;
        }
        Ok(frame)
    }
}

pub(super) struct LocalAudio {
    pub(super) track: Arc<TrackLocalStaticSample>,
    sender: Arc<RTCRtpSender>,
}

impl LocalAudio {
    pub(super) async fn add_to(peer: &RTCPeerConnection) -> Result<Self> {
        let track = Arc::new(TrackLocalStaticSample::new(
            opus_codec().capability,
            "audio".to_owned(),
            "codex-voice".to_owned(),
        ));
        let sender = peer
            .add_track(track.clone())
            .await
            .map_err(|_| anyhow!("Codex voice could not attach its audio track"))?;
        Ok(Self { track, sender })
    }

    pub(super) async fn send(&self, input: &PendingPcm) -> Result<()> {
        let mut encoder = Encoder::new(PCM_RATE, Channels::Mono, Application::Voip)
            .context("Codex voice Opus encoder unavailable")?;
        let mut packet = [0; 1275];
        let mut clock = FrameClock::new();
        loop {
            clock.tick().await;
            let count = encoder
                .encode(&input.frame()?, &mut packet)
                .context("Codex voice PCM encoding failed")?;
            self.track
                .write_sample(&Sample {
                    data: packet[..count].to_vec().into(),
                    duration: FRAME_DURATION,
                    ..Default::default()
                })
                .await
                .map_err(|_| anyhow!("Codex voice RTP send failed"))?;
        }
    }

    pub(super) async fn drain_rtcp(&self) -> Result<()> {
        let mut packet = [0; READ_MTU];
        loop {
            self.sender
                .read(&mut packet)
                .await
                .map_err(|_| anyhow!("Codex voice sender RTCP stopped"))?;
        }
    }
}

pub(super) struct RemoteAudio {
    pub(super) track: Arc<TrackRemote>,
    pub(super) receiver: Arc<RTCRtpReceiver>,
}

pub(super) async fn receive(
    track: oneshot::Receiver<RemoteAudio>,
    status: &watch::Sender<Status>,
    output: &mpsc::Sender<Vec<u8>>,
) -> Result<()> {
    let remote = track
        .await
        .context("Codex voice remote track unavailable")?;
    tokio::select! {
        result = remote.decode(status, output) => result,
        result = remote.drain_rtcp() => result,
    }
}

impl RemoteAudio {
    async fn decode(
        &self,
        status: &watch::Sender<Status>,
        output: &mpsc::Sender<Vec<u8>>,
    ) -> Result<()> {
        let mut playout = Playout {
            order: RtpOrder::default(),
            decoder: Decoder::new(PCM_RATE, Channels::Mono)
                .context("Codex voice Opus decoder unavailable")?,
            samples: [0; FRAME_SAMPLES * 6],
            output,
        };
        let mut buffer = [0; READ_MTU];
        loop {
            // TrackRemote::read is not cancel-safe: retain the in-flight read
            // across timer wakes so advancing a gap does not discard another RTP packet.
            let read = self.track.read(&mut buffer);
            tokio::pin!(read);
            let (packet, _) = loop {
                tokio::select! {
                    biased;
                    result = &mut read => break result
                        .map_err(|_| anyhow!("Codex voice remote audio stopped"))?,
                    () = playout.order.wait_for_gap() => playout.flush()?,
                }
            };
            ensure!(
                is_opus(&self.track),
                "Codex voice remote audio codec changed"
            );
            let active = matches!(*status.borrow(), Status::Active);
            if !packet.payload.is_empty() {
                // Reject malformed framing immediately, even if the sequence
                // would otherwise wait behind a missing packet.
                opus2::packet::parse(&packet.payload)
                    .context("Codex voice remote Opus packet is malformed")?;
            }
            if active {
                // Neither the window nor the decoder retains pre-activation audio.
                playout
                    .order
                    .insert(packet.header.sequence_number, Instant::now(), packet);
                playout.flush()?;
            }
        }
    }

    async fn drain_rtcp(&self) -> Result<()> {
        let mut packet = [0; READ_MTU];
        loop {
            let (packets, _) = self
                .receiver
                .read(&mut packet)
                .await
                .map_err(|_| anyhow!("Codex voice receiver RTCP stopped"))?;
            ensure!(
                !packets.iter().any(|packet| packet
                    .as_any()
                    .downcast_ref::<Goodbye>()
                    .is_some_and(|bye| bye.sources.contains(&self.track.ssrc()))),
                "Codex voice remote audio ended"
            );
        }
    }
}

struct Playout<'a> {
    order: RtpOrder<Packet>,
    decoder: Decoder,
    // An Opus packet can carry up to 120 ms, including stereo sources.
    samples: [i16; FRAME_SAMPLES * 6],
    output: &'a mpsc::Sender<Vec<u8>>,
}

impl Playout<'_> {
    fn flush(&mut self) -> Result<()> {
        let now = Instant::now();
        while let Some(packet) = self.order.pop_ready(now) {
            if packet.payload.is_empty() {
                continue;
            }
            let count = self
                .decoder
                .decode(&packet.payload, &mut self.samples, false)
                .context("Codex voice remote Opus packet could not be decoded")?;
            let pcm = self.samples[..count]
                .iter()
                .flat_map(|sample| sample.to_le_bytes())
                .collect();
            self.output
                .try_send(pcm)
                .map_err(|_| anyhow!("Codex voice output queue stopped or is congested"))?;
        }
        Ok(())
    }
}
