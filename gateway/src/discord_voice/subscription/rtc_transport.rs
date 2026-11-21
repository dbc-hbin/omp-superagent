use anyhow::{Context as _, Result, anyhow, bail, ensure};
use tokio::sync::{oneshot, watch};
use tokio_util::sync::CancellationToken;
use webrtc::{
    api::{
        APIBuilder, interceptor_registry::register_default_interceptors, media_engine::MediaEngine,
        setting_engine::SettingEngine,
    },
    dtls_transport::dtls_transport_state::RTCDtlsTransportState,
    ice::mdns::MulticastDnsMode,
    ice_transport::ice_connection_state::RTCIceConnectionState,
    interceptor::registry::Registry,
    peer_connection::{
        RTCPeerConnection, configuration::RTCConfiguration,
        peer_connection_state::RTCPeerConnectionState,
        sdp::session_description::RTCSessionDescription,
    },
    rtp_transceiver::{
        rtp_codec::RTPCodecType, rtp_transceiver_direction::RTCRtpTransceiverDirection,
    },
    sdp::description::common::Attribute,
};

use super::audio::{RemoteAudio, is_opus, is_opus_codec, opus_codec};

const MAX_SDP: usize = 256 * 1024;

pub(super) struct MediaLink {
    state: watch::Receiver<RTCPeerConnectionState>,
    pub(super) failed: CancellationToken,
    pub(super) invalid_track: CancellationToken,
    pub(super) track: oneshot::Receiver<RemoteAudio>,
}

impl MediaLink {
    pub(super) fn register(peer: &RTCPeerConnection) -> Self {
        use RTCPeerConnectionState::{
            Closed, Connected, Connecting, Disconnected, Failed, New, Unspecified,
        };

        let (state_tx, state) = watch::channel(peer.connection_state());
        let failed = CancellationToken::new();
        let on_failed = failed.clone();
        peer.on_peer_connection_state_change(Box::new(move |state| {
            match state {
                Failed | Closed => on_failed.cancel(),
                Unspecified | New | Connecting | Connected | Disconnected => {}
            }
            state_tx.send_replace(state);
            Box::pin(std::future::ready(()))
        }));
        let (tx, track) = oneshot::channel();
        let mut tx = Some(tx);
        let invalid_track = CancellationToken::new();
        let on_invalid = invalid_track.clone();
        peer.on_track(Box::new(move |track, receiver, _| {
            if let (true, Some(tx)) = (is_opus(&track), tx.take()) {
                // A closed channel means its sole consumer is already shutting down.
                drop(tx.send(RemoteAudio { track, receiver }));
            } else {
                on_invalid.cancel();
            }
            Box::pin(std::future::ready(()))
        }));
        Self {
            state,
            failed,
            invalid_track,
            track,
        }
    }

    pub(super) async fn wait_connected(&self, peer: &RTCPeerConnection) -> Result<()> {
        let mut state = self.state.clone();
        loop {
            ensure!(
                !self.failed.is_cancelled(),
                "Codex voice media connection failed"
            );
            // Disconnected is recoverable. Check actual ICE and DTLS state
            // even after the peer signaled Connected: the callback can lag a flap.
            if *state.borrow_and_update() == RTCPeerConnectionState::Connected
                && matches!(
                    peer.ice_connection_state(),
                    RTCIceConnectionState::Connected | RTCIceConnectionState::Completed
                )
                && peer.dtls_transport().state() == RTCDtlsTransportState::Connected
            {
                return Ok(());
            }
            tokio::select! {
                biased;
                () = self.failed.cancelled() => bail!("Codex voice media connection failed"),
                changed = state.changed() => changed.context("Codex voice connection state stopped")?,
            }
        }
    }
}

pub(super) async fn connection(mut settings: SettingEngine) -> Result<RTCPeerConnection> {
    settings.set_ice_multicast_dns_mode(MulticastDnsMode::Disabled);
    let mut media = MediaEngine::default();
    media
        .register_codec(opus_codec(), RTPCodecType::Audio)
        .map_err(|_| anyhow!("Codex voice Opus registration failed"))?;
    let interceptors = register_default_interceptors(Registry::new(), &mut media)
        .map_err(|_| anyhow!("Codex voice RTP setup failed"))?;
    APIBuilder::new()
        .with_setting_engine(settings)
        .with_media_engine(media)
        .with_interceptor_registry(interceptors)
        .build()
        .new_peer_connection(RTCConfiguration {
            ice_servers: Vec::new(),
            ..Default::default()
        })
        .await
        .map_err(|_| anyhow!("Codex voice WebRTC peer could not be created"))
}

pub(super) fn parse_answer(sdp: String) -> Result<RTCSessionDescription> {
    use RTCRtpTransceiverDirection::Sendrecv;

    ensure!(
        !sdp.is_empty() && sdp.len() <= MAX_SDP && !sdp.contains('\0'),
        "Invalid Codex voice answer size or encoding"
    );
    // Do not include WebRTC parser errors in diagnostics: SDP contains ICE credentials.
    let answer = RTCSessionDescription::answer(sdp)
        .map_err(|_| anyhow!("Invalid Codex voice answer SDP"))?;
    let mut parsed = answer
        .unmarshal()
        .map_err(|_| anyhow!("Invalid Codex voice answer SDP"))?;
    let session_direction = direction(&parsed.attributes)?;
    let [audio] = parsed.media_descriptions.as_mut_slice() else {
        bail!("Codex voice answer must contain only one audio media section");
    };
    let media_direction = direction(&audio.attributes)?;
    ensure!(
        audio.media_name.media == "audio"
            && audio.media_name.port.value != 0
            && media_direction.or(session_direction).unwrap_or(Sendrecv) == Sendrecv
            && !["rid", "simulcast", "ssrc-group"]
                .iter()
                .any(|key| audio.has_attribute(key)),
        "Codex voice answer must provide bidirectional single-track audio"
    );
    let mut source = None;
    for attribute in audio.attributes.iter().filter(|attr| attr.key == "ssrc") {
        let ssrc = attribute
            .value
            .as_deref()
            .and_then(|value| value.split_ascii_whitespace().next())
            .and_then(|value| value.parse::<u32>().ok())
            .filter(|ssrc| *ssrc != 0)
            .context("Invalid Codex voice audio source")?;
        ensure!(
            source.replace(ssrc).is_none_or(|previous| previous == ssrc),
            "Codex voice answer declared multiple audio sources"
        );
    }
    if media_direction.is_none() {
        // webrtc-rs looks at the media section only; materialize the RFC 3264
        // default or inherited session direction before applying the answer.
        audio.attributes.push(Attribute {
            key: "sendrecv".to_owned(),
            value: None,
        });
        return RTCSessionDescription::answer(parsed.marshal())
            .map_err(|_| anyhow!("Invalid Codex voice answer SDP"));
    }
    Ok(answer)
}

fn direction(attributes: &[Attribute]) -> Result<Option<RTCRtpTransceiverDirection>> {
    let mut directions = attributes.iter().filter_map(|attr| {
        let direction = RTCRtpTransceiverDirection::from(attr.key.as_str());
        (direction != RTCRtpTransceiverDirection::Unspecified).then_some(direction)
    });
    let direction = directions.next();
    ensure!(
        directions.next().is_none(),
        "Conflicting Codex voice SDP directions"
    );
    Ok(direction)
}

pub(super) async fn ensure_negotiated_audio(peer: &RTCPeerConnection) -> Result<()> {
    let transceivers = peer.get_transceivers().await;
    let [audio] = transceivers.as_slice() else {
        bail!("Codex voice requires one negotiated RTP transceiver");
    };
    let codecs = audio.receiver().await.get_parameters().await.codecs;
    ensure!(
        audio.kind() == RTPCodecType::Audio
            && audio.current_direction() == RTCRtpTransceiverDirection::Sendrecv
            && matches!(codecs.as_slice(), [opus] if is_opus_codec(&opus.capability)),
        "Codex voice did not negotiate bidirectional Opus audio"
    );
    Ok(())
}
