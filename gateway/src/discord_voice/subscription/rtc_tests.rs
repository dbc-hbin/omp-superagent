use std::{
    io::ErrorKind,
    net::SocketAddr,
    sync::{Arc, Mutex},
    time::Duration,
};

use futures_util::FutureExt as _;
use opus2::{Application, Channels, Decoder, Encoder};
use tokio::{net::UdpSocket, time::timeout};
use webrtc::{
    ice::network_type::NetworkType, media::Sample,
    peer_connection::sdp::session_description::RTCSessionDescription,
    track::track_remote::TrackRemote,
};

use super::{
    audio::{FRAME_DURATION, FRAME_SAMPLES, PCM_RATE},
    *,
};

const DEADLINE: Duration = Duration::from_secs(10);

pub(super) fn loopback_settings() -> SettingEngine {
    let mut settings = SettingEngine::default();
    settings.set_include_loopback_candidate(true);
    settings.set_ip_filter(Box::new(|ip| ip.is_loopback()));
    settings.set_network_types(vec![NetworkType::Udp4]);
    settings
}

pub(in super::super) struct AnswerPeer {
    peer: RTCPeerConnection,
    link: MediaLink,
    local: LocalAudio,
    encoder: Mutex<Encoder>,
}

impl AnswerPeer {
    pub(in super::super) async fn answer(sdp: String) -> Result<(Self, String)> {
        let encoder = Mutex::new(Encoder::new(PCM_RATE, Channels::Mono, Application::Voip)?);
        let peer = connection(loopback_settings()).await?;
        let link = MediaLink::register(&peer);
        let prepare = async {
            let local = LocalAudio::add_to(&peer).await?;
            peer.set_remote_description(RTCSessionDescription::offer(sdp)?)
                .await?;
            let offer = peer.create_answer(None).await?;
            let mut gathered = peer.gathering_complete_promise().await;
            peer.set_local_description(offer).await?;
            gathered.recv().await;
            let answer = peer
                .local_description()
                .await
                .context("Loopback peer did not produce a local answer")?
                .sdp;
            Ok::<_, anyhow::Error>((local, answer))
        };
        match prepare.await {
            Ok((local, answer)) => Ok((
                Self {
                    peer,
                    link,
                    local,
                    encoder,
                },
                answer,
            )),
            Err(error) => {
                peer.close().await?;
                Err(error)
            }
        }
    }

    pub(in super::super) async fn wait_connected(&self) -> Result<()> {
        self.link.wait_connected(&self.peer).await
    }

    pub(in super::super) async fn send_tone(&self) -> Result<()> {
        self.wait_connected().await?;
        let tone: [i16; FRAME_SAMPLES] = std::array::from_fn(|i| square_wave(i, 12));
        let mut encoded = [0; 1275];
        let count = self
            .encoder
            .lock()
            .map_err(|_| anyhow!("Loopback encoder lock failed"))?
            .encode(&tone, &mut encoded)?;
        self.send_audio_packet(encoded[..count].to_vec()).await
    }

    pub(in super::super) async fn send_invalid_audio(&self) -> Result<()> {
        self.wait_connected().await?;
        // Opus TOC code 3 without the required frame count.
        self.send_audio_packet(vec![0x03]).await
    }

    async fn send_audio_packet(&self, payload: Vec<u8>) -> Result<()> {
        self.local
            .track
            .write_sample(&Sample {
                data: payload.into(),
                duration: FRAME_DURATION,
                ..Default::default()
            })
            .await?;
        Ok(())
    }

    pub(in super::super) async fn track(&mut self) -> Result<Arc<TrackRemote>> {
        Ok((&mut self.link.track).await?.track)
    }

    pub(in super::super) async fn close(self) -> Result<()> {
        self.peer.close().await?;
        Ok(())
    }
}

fn square_wave(index: usize, half_period: usize) -> i16 {
    if index % (half_period * 2) < half_period {
        9_000
    } else {
        -9_000
    }
}

fn candidate_address(sdp: &str) -> Result<SocketAddr> {
    let candidate = sdp
        .lines()
        .find(|line| line.starts_with("a=candidate:"))
        .context("Loopback SDP has no candidate")?;
    let mut fields = candidate.split_ascii_whitespace().skip(4);
    let ip = fields
        .next()
        .context("Loopback candidate has no IP")?
        .parse()?;
    let port = fields
        .next()
        .context("Loopback candidate has no port")?
        .parse()?;
    let socket = SocketAddr::new(ip, port);
    ensure!(
        socket.ip().is_loopback(),
        "Fixture must be entirely offline"
    );
    Ok(socket)
}

async fn await_released(socket: SocketAddr) -> Result<()> {
    loop {
        match UdpSocket::bind(socket).await {
            Ok(_) => return Ok(()),
            Err(error) if error.kind() == ErrorKind::AddrInUse => tokio::task::yield_now().await,
            Err(error) => return Err(error.into()),
        }
    }
}

#[test]
fn answer_requires_one_audio_media_section_and_at_most_one_declared_source() {
    let audio = concat!(
        "v=0\r\n",
        "o=- 1 1 IN IP4 127.0.0.1\r\n",
        "s=-\r\n",
        "t=0 0\r\n",
        "a=sendrecv\r\n",
        "m=audio 9 UDP/TLS/RTP/SAVPF 111\r\n",
        "c=IN IP4 127.0.0.1\r\n",
        "a=rtpmap:111 opus/48000/2\r\n",
        "a=ssrc:1 cname:first\r\n",
    );
    assert!(parse_answer(audio.to_owned()).is_ok());
    for suffix in [
        "a=ssrc:2 cname:second\r\n",
        "m=video 9 UDP/TLS/RTP/SAVPF 96\r\nc=IN IP4 127.0.0.1\r\na=rtpmap:96 VP8/90000\r\n",
    ] {
        let answer = format!("{audio}{suffix}");
        assert!(RTCSessionDescription::answer(answer.clone()).is_ok());
        assert!(parse_answer(answer).is_err());
    }
}

#[tokio::test]
async fn silent_answerer_is_ready_then_real_srtp_carries_opus_duplex_and_releases_ice() {
    timeout(DEADLINE, async {
        let (mut gateway, offer) = MediaPeer::loopback_offer().await?;
        let gateway_socket = candidate_address(&offer)?;
        let (mut remote, answer) = AnswerPeer::answer(offer).await?;
        let remote_socket = candidate_address(&answer)?;
        // RFC 3264 defaults to sendrecv when neither level declares a direction.
        gateway
            .apply_answer(answer.replace("a=sendrecv\r\n", ""))
            .await?;

        // The remote does not send any RTP until this returns.
        gateway.ready().await?;
        gateway.ready().await?;
        let track = remote.track().await?;
        let mut decoder = Decoder::new(PCM_RATE, Channels::Mono)?;
        let mut decoded = [0; FRAME_SAMPLES];
        let (first, _) = track.read_rtp().await?;
        let (second, _) = track.read_rtp().await?;
        assert_eq!(
            second.header.timestamp.wrapping_sub(first.header.timestamp),
            960
        );
        assert_eq!(
            second
                .header
                .sequence_number
                .wrapping_sub(first.header.sequence_number),
            1
        );
        assert_eq!(
            decoder.decode(&second.payload, &mut decoded, false)?,
            FRAME_SAMPLES
        );
        assert!(decoded.iter().all(|sample| sample.unsigned_abs() < 64));
        let pre_activation = async {
            for _ in 0..6 {
                track.read_rtp().await?;
                remote.send_tone().await?;
            }
            Ok::<_, anyhow::Error>(())
        };
        tokio::select! {
            biased;
            _ = gateway.recv() => panic!("remote audio escaped before activation"),
            result = pre_activation => result?,
        }

        gateway.activate()?;
        let owner: Vec<u8> = (0..FRAME_SAMPLES * 4)
            .flat_map(|i| square_wave(i, 24).to_le_bytes())
            .collect();
        gateway.input(&owner[..222])?;
        gateway.input(&owner[222..])?;

        let mut owner_audible = false;
        for _ in 0..8 {
            let (packet, _) = track.read_rtp().await?;
            remote.send_tone().await?;
            let count = decoder.decode(&packet.payload, &mut decoded, false)?;
            owner_audible |= decoded[..count]
                .iter()
                .any(|sample| sample.unsigned_abs() > 2_000);
        }
        assert!(
            owner_audible,
            "remote did not receive audible operator audio"
        );
        loop {
            let pcm = gateway.recv().await?;
            assert_eq!(pcm.len(), FRAME_SAMPLES * 2);
            if pcm
                .chunks_exact(2)
                .any(|s| i16::from_le_bytes([s[0], s[1]]).unsigned_abs() > 2_000)
            {
                break;
            }
        }

        // A truncated Opus packet still crosses real SRTP but must end the driver.
        remote.send_invalid_audio().await?;
        while gateway.recv().await.is_ok() {}
        gateway.close().await;
        assert!(gateway.recv().await.is_err());
        assert!(gateway.activate().is_err());
        remote.close().await?;
        drop(track);
        tokio::try_join!(
            await_released(gateway_socket),
            await_released(remote_socket)
        )?;
        Ok::<_, anyhow::Error>(())
    })
    .await
    .expect("real offline WebRTC duplex or ICE teardown stalled")
    .unwrap();
}

#[tokio::test]
async fn dropping_an_offer_during_open_cancels_the_driver_and_releases_ice() {
    timeout(DEADLINE, async {
        // Poll the real offer once, then cancel before a return value can be received.
        assert!(MediaPeer::loopback_offer().now_or_never().is_none());

        // Also cancel at the other end of setup: the caller still owns only a
        // pending offer, but the driver's recorded ICE candidate is already bound.
        let (mut opening, offer) = MediaPeer::start(loopback_settings());
        let socket = candidate_address(&offer.await?)?;
        let error = UdpSocket::bind(socket).await.unwrap_err();
        assert_eq!(error.kind(), ErrorKind::AddrInUse);
        let driver = opening.driver.take().unwrap();
        // Isolate explicit RAII cancellation from the answer channel's EOF.
        let unanswered = opening.answer.take().unwrap();
        drop(opening);
        driver.await?;
        drop(unanswered);
        await_released(socket).await
    })
    .await
    .expect("dropped offer left its driver or ICE socket alive")
    .unwrap();
}
