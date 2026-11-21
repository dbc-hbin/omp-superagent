use super::{auth::Login, control::Control, rtc::MediaPeer, rtc::tests::AnswerPeer, *};
use axum::{Json, Router, routing::post};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::{net::TcpListener, time};
use tokio_tungstenite::{WebSocketStream, accept_async, tungstenite::Message};

#[test]
fn drafts_require_recent_distinct_owner_speech_and_the_original_receipt() {
    let mut gate = SpeechGate::default();
    let now = Instant::now();
    let spoken = || Some("keep MyPath.ts unchanged".to_owned());
    assert!(matches!(
        gate.offer("silent".into(), spoken(), now),
        Event::Reject(_)
    ));
    assert!(gate.result("silent", true).is_err());
    assert!(matches!(
        gate.result("silent", false),
        Ok(DraftResult::NotPosted)
    ));
    gate.speech(now);
    assert!(matches!(
        gate.offer("first".into(), spoken(), now),
        Event::Draft { .. }
    ));
    gate.speech(now + SPEECH_GAP);
    assert!(matches!(
        gate.offer("overlap".into(), spoken(), now + SPEECH_GAP),
        Event::Reject(_)
    ));
    assert!(matches!(
        gate.result("overlap", false),
        Ok(DraftResult::NotPosted)
    ));
    assert!(gate.result("wrong", true).is_err());
    assert!(matches!(
        gate.result("first", true),
        Ok(DraftResult::Posted)
    ));
    assert!(matches!(
        gate.offer("second".into(), spoken(), now + SPEECH_GAP),
        Event::Draft { .. }
    ));
    assert!(matches!(
        gate.result("second", false),
        Ok(DraftResult::NotPosted)
    ));
    assert!(matches!(
        gate.offer("repeat".into(), spoken(), now + SPEECH_GAP),
        Event::Reject(_)
    ));
    assert!(matches!(
        gate.result("repeat", false),
        Ok(DraftResult::NotPosted)
    ));
    gate.speech(now + 2 * SPEECH_GAP);
    assert!(matches!(
        gate.offer("stale".into(), spoken(), now + 2 * RECENT_SPEECH),
        Event::Reject(_)
    ));
}

type LocalSocket = WebSocketStream<tokio::net::TcpStream>;

async fn send(socket: &mut LocalSocket, value: Value) -> Result<()> {
    socket.send(Message::Text(value.to_string().into())).await?;
    Ok(())
}

async fn next_message(socket: &mut LocalSocket) -> Result<Value> {
    while let Some(message) = socket.next().await {
        if let Message::Text(text) = message? {
            return Ok(serde_json::from_str(&text)?);
        }
    }
    bail!("test sideband closed before the receipt")
}

fn delegation(id: &str, text: &str) -> Value {
    json!({"type":"delegation.created","item":{"id":id,"type":"delegation","target":"client",
        "content":[{"type":"input_text","text":text}]}})
}

async fn play(peer: &AnswerPeer) -> Result<()> {
    let mut clock = time::interval(Duration::from_millis(20));
    clock.set_missed_tick_behavior(time::MissedTickBehavior::Skip);
    loop {
        clock.tick().await;
        peer.send_tone().await?;
    }
}

async fn local_call() -> Result<(MediaPeer, Control, String, AnswerPeer, LocalSocket)> {
    let login = Login::fixture("offline-secret-token", "fixture-account");
    let (media, offer) = MediaPeer::loopback_offer().await?;
    let (remote, answer) = AnswerPeer::answer(offer.clone()).await?;
    let http = TcpListener::bind("127.0.0.1:0").await?;
    let call_url = format!("http://{}/calls", http.local_addr()?);
    let ws = TcpListener::bind("127.0.0.1:0").await?;
    let control_url = format!("ws://{}/live", ws.local_addr()?);
    let expected_offer = offer.clone();
    let app = Router::new().route(
        "/calls",
        post(move |Json(body): Json<Value>| {
            let answer = answer.clone();
            let offer = expected_offer.clone();
            async move {
                assert_eq!(body["sdp"], offer);
                assert_eq!(body["session"]["delegation"]["type"], "client");
                ([("openai-session-id", "rtc_fixture")], answer)
            }
        }),
    );
    let serving = tokio::spawn(async move { axum::serve(http, app).await });
    let accept = async {
        let (stream, _) = ws.accept().await?;
        Ok::<_, anyhow::Error>(accept_async(stream).await?)
    };
    let ((control, answer), socket) = tokio::try_join!(
        Control::open_loopback(&offer, &login, (&call_url, &control_url)),
        accept
    )?;
    serving.abort();
    Ok((media, control, answer, remote, socket))
}

#[tokio::test]
async fn lost_media_does_not_wait_for_a_delayed_session_start() -> Result<()> {
    time::timeout(Duration::from_secs(5), async {
        let (media, control, answer, mut remote, mut socket) = local_call().await?;
        let opening = Subscription::connect(media, control, answer);
        let listening = async {
            // Outbound RTP proves the transport connected. Keep the sideband
            // responsive, but never send session.started.
            let _owner_track = remote.track().await?;
            send(&mut socket, delegation("before_loss", "not authorized")).await?;
            assert_eq!(
                next_message(&mut socket).await?["delegation_item_id"],
                "before_loss"
            );
            remote.send_invalid_audio().await?;
            assert_eq!(next_message(&mut socket).await?["type"], "session.close");
            Ok::<_, anyhow::Error>(())
        };
        let (opened, received) = tokio::join!(opening, listening);
        received?;
        assert!(opened.is_err(), "call became ready without session.started");
        remote.close().await?;
        Ok::<_, anyhow::Error>(())
    })
    .await?
}

#[tokio::test]
async fn native_subscription_negotiates_audio_and_confirms_only_the_correlated_draft() -> Result<()>
{
    time::timeout(Duration::from_secs(20), async {
        let (media, control, answer, remote, mut socket) = local_call().await?;
        let opening = Subscription::connect(media, control, answer);
        tokio::pin!(opening);
        let early = async {
            send(&mut socket, delegation("early", "before readiness")).await?;
            let rejected = next_message(&mut socket).await?;
            assert_eq!(rejected["delegation_item_id"], "early");
            assert!(!rejected.to_string().contains("before readiness"));
            send(&mut socket, json!({"type":"session.started"})).await
        };
        tokio::select! {
            result = &mut opening => bail!("ready before sideband start: {}", result.is_ok()),
            result = early => result?,
        }
        // A listening provider need not send RTP before the owner speaks.
        let mut sub = opening.await?;
        {
            let playback = play(&remote);
            tokio::pin!(playback);
            loop {
                tokio::select! {
                    result = sub.recv() => if let Event::Audio(pcm) = result? && energetic(&pcm) { break; },
                    result = &mut playback => { result?; bail!("remote sender ended before audible media") },
                }
            }
        }
        let pcm = [0x10, 0x10].repeat(480);
        sub.input(&pcm)?;
        let text = "Check MyPath.ts unchanged.\n테스트 두 개만.";
        send(&mut socket, delegation("work_1", text)).await?;
        loop {
            if let Event::Draft { id, text: draft } = sub.recv().await? {
                assert_eq!(id, "work_1");
                assert_eq!(draft.as_deref(), Some(text));
                sub.draft_result(&id, true).await?;
                break;
            }
        }
        let receipt = next_message(&mut socket).await?;
        assert_eq!(receipt["type"], "delegation.context.append");
        assert_eq!(receipt["delegation_item_id"], "work_1");
        assert!(receipt["content"][0]["text"].as_str().unwrap().contains("written confirmation"));
        sub.close().await;
        remote.close().await?;
        Ok::<_, anyhow::Error>(())
    }).await?
}
