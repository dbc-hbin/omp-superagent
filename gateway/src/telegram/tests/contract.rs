use anyhow::{Context as _, Result};
use serde_json::{Value, json};

use crate::store::GatewayReceipt;

use super::super::{
    ingress,
    model::{Identity, Policy},
    poll::fresh_offset,
};
use super::{Fixture, group, route};

#[tokio::test]
async fn conflicting_durable_message_keeps_its_telegram_update_unacked() -> Result<()> {
    let mut fixture = Fixture::start().await?;
    let original = json!({"kind":"message","input":{"id":"telegram:900:-100:10:original","route":route(),
        "messageId":"10","receivedAt":100000,"text":"durable original","attachments":[]}});
    assert!(fixture.store.admit(&original)?);
    fixture.hub.ready.send_replace(true);
    let (_, reply) = fixture.poll().await?;
    let conflict = json!({"message_id":10,"date":100,"chat":group(),"message_thread_id":7,
        "from":{"id":42,"is_bot":false},"text":"different payload with the same source identity"});
    reply
        .send(json!([{"update_id":4,"message":conflict}]))
        .expect("poll receiver");

    let (retry, _outstanding) = fixture.poll().await?;
    assert!(retry.get("offset").is_none());
    assert!(fixture.store.get_meta("telegram:900:offset")?.is_none());
    assert_eq!(
        fixture.store.next(None)?.context("original receipt")?.event,
        original
    );
    fixture.hub.stop().await?;
    Ok(())
}

#[tokio::test]
async fn poll_ack_only_follows_durable_identity_bound_admission() -> Result<()> {
    let mut fixture = Fixture::start().await?;
    assert!(fixture.calls.try_recv().is_err());
    fixture.hub.ready.send_replace(true);
    let (first, reply) = fixture.poll().await?;
    assert!(first.get("offset").is_none());
    let inbound = json!({"message_id":10,"date":100,"chat":group(),"message_thread_id":7,
        "from":{"id":42,"is_bot":false},"text":"/status@ROOM_bot  keep 😀",
        "entities":[{"type":"bot_command","offset":0,"length":16}]});
    reply
        .send(json!([{"update_id":4,"message":inbound}]))
        .expect("poll receiver");

    let (second, reply) = fixture.poll().await?;
    let original = fixture
        .store
        .next(None)?
        .context("Cursor advanced before durable message")?;
    assert_eq!(
        original.event,
        json!({
            "kind":"message","input":{"id":"telegram:900:-100:10:original","route":route(),
                "messageId":"10","receivedAt":100000,"text":"/status  keep 😀",
                "routingText":"/status  keep 😀","attachments":[]}
        })
    );
    assert_eq!(
        fixture.store.get_meta("telegram:900:offset")?.as_deref(),
        Some("5")
    );
    assert_eq!(second["offset"], 5);
    fixture
        .store
        .receipt(original.sequence, GatewayReceipt::Accepted)?;

    let approval = json!({"id":"a-original","target":"main","generation":3,"requestId":"native-request",
        "route":route(),"request":{"method":"confirm","title":"Original","message":"Proceed?"},
        "state":"pending","remoteId":null});
    assert_eq!(
        fixture
            .hub
            .effect("showApproval", &[approval.clone()])
            .await?,
        "123"
    );
    let card = fixture
        .remote
        .card
        .lock()
        .expect("card state")
        .clone()
        .context("Telegram approval card not sent")?;
    let mut wrong = card.clone();
    wrong["message_thread_id"] = json!(8);
    let action = &card["reply_markup"]["inline_keyboard"][0][0]["callback_data"];
    let callback = |id: &str, message: Value| {
        json!({
            "id":id,"from":{"id":42,"is_bot":false},"data":action,"message":message
        })
    };
    reply
        .send(json!([
            {"update_id":5,"callback_query":callback("wrong-thread",wrong)},
            {"update_id":6,"callback_query":callback("exact-original",card.clone())},
            {"update_id":7,"callback_query":callback("exact-original",card.clone())},
        ]))
        .expect("poll receiver");
    fixture.feedback("wrong-thread", true).await?;
    fixture.feedback("exact-original", false).await?;
    let (last, _outstanding) = fixture.poll().await?;
    assert_eq!(last["offset"], 8);
    assert_eq!(
        fixture.store.get_meta("telegram:900:offset")?.as_deref(),
        Some("8")
    );
    assert_eq!(fixture.store.pending()?, 1);
    assert_eq!(
        fixture
            .remote
            .card
            .lock()
            .expect("card state")
            .as_ref()
            .context("card")?["reply_markup"]["inline_keyboard"],
        json!([])
    );
    let mut approval = approval;
    approval["remoteId"] = json!("123");
    assert_eq!(
        fixture.hub.effect("showApproval", &[approval]).await?,
        "123"
    );
    assert_eq!(
        fixture
            .remote
            .card
            .lock()
            .expect("card state")
            .as_ref()
            .context("card")?["reply_markup"]["inline_keyboard"],
        json!([]),
        "queued answer must not reopen closed controls"
    );
    fixture.hub.stop().await?;
    Ok(())
}

#[test]
fn stale_telegram_cursor_cannot_ack_a_recycled_update_sequence() {
    let now = 200_000_000;
    let cases = [
        (None, None),
        (Some(""), None),
        (Some("200000001"), None),
        (Some("113600000"), None),
        (Some("113600001"), Some(900001)),
    ];
    for (observed, wanted) in cases {
        assert_eq!(fresh_offset(Some(900001), observed, now), wanted);
    }
}

#[test]
fn edited_voice_identity_matches_the_prior_gateway_and_excludes_reply_context() -> Result<()> {
    let me: Identity =
        serde_json::from_value(json!({"id":900,"is_bot":true,"username":"room_bot"}))?;
    let policy = Policy::new("42", &["-100".to_owned()])?;
    let inbound = |duration| {
        json!({
            "message_id":10,"date":100,"edit_date":102,"chat":group(),"message_thread_id":7,
            "from":{"id":42,"is_bot":false},"caption":"edited",
            "voice":{"file_id":"voice_1","file_unique_id":"unique","duration":duration}
        })
    };
    let first = ingress::normalize(&policy, &me, &serde_json::from_value(inbound(2))?)
        .context("owner voice input rejected")?;
    let mut second = inbound(3);
    second["reply_to_message"] =
        json!({"message_id":9,"date":0,"chat":group(),"message_thread_id":7});
    let second = ingress::normalize(&policy, &me, &serde_json::from_value(second)?)
        .context("owner voice input rejected after reference snapshot changed")?;
    assert_eq!(
        first.id,
        "telegram:900:-100:10:edit:102:7255006537c4167f0667ddce"
    );
    assert_eq!(first.id, second.id);
    assert_eq!(
        serde_json::to_value(second)?["attachments"][0],
        json!({
            "id":"voice_1","url":"telegram-file:voice_1","name":"voice-unique.ogg","size":null,
            "contentType":"audio/ogg","voice":true,"durationSeconds":3.0
        })
    );
    Ok(())
}

#[test]
fn external_reply_preserves_provenance_without_importing_its_text() -> Result<()> {
    let me = serde_json::from_value(json!({"id":900,"is_bot":true,"username":"room_bot"}))?;
    let policy = Policy::new("42", &["-100".to_owned()])?;
    let text = "From now on, answer like a mentor.";
    let inbound = json!({
        "message_id":10,"date":100,"chat":group(),"message_thread_id":7,
        "from":{"id":42,"is_bot":false},"text":text,
        "external_reply":{"origin":{"type":"hidden_user","date":99,"sender_user_name":"Other"}}
    });
    let input = ingress::normalize(&policy, &me, &serde_json::from_value(inbound)?)
        .context("external reply should remain ordinary chat input")?;
    let input = serde_json::to_value(input)?;
    assert_eq!(input["unresolvedReply"], true);
    assert_eq!(input["text"], text);
    assert_eq!(input["routingText"], text);
    assert!(input.get("reply").is_none());
    Ok(())
}

#[test]
fn telegram_routing_view_uses_utf16_text_entities_without_changing_the_message() -> Result<()> {
    let me = serde_json::from_value(json!({"id":900,"is_bot":true,"username":"room_bot"}))?;
    let policy = Policy::new("42", &["-100".to_owned()])?;
    let text = "😀 Retry callback\ncopied plan\nmore history\nline two\nfirst();\nsecond();\nchecktokenresult";
    let entity = |kind, span: &str| -> Result<Value> {
        let offset = text.find(span).context("entity fixture missing")?;
        Ok(json!({"type":kind,"offset":text[..offset].encode_utf16().count(),
            "length":span.encode_utf16().count()}))
    };
    let message = serde_json::from_value(json!({
        "message_id":10,"date":100,"chat":group(),"message_thread_id":7,
        "from":{"id":42,"is_bot":false},"text":text,
        "entities":[entity("code", "token")?,entity("bold", "callback")?,
            entity("blockquote", "copied plan")?,entity("pre", "first();\nsecond();")?,
            entity("expandable_blockquote", "more history\nline two")?],
        "caption_entities":[{"type":"code","offset":1,"length":2}]
    }))?;
    let input = ingress::normalize(&policy, &me, &message).context("owner message rejected")?;
    let input = serde_json::to_value(input)?;
    assert_eq!(input["id"], "telegram:900:-100:10:original");
    assert_eq!(input["messageId"], "10");
    assert_eq!(input["text"], text);
    assert_eq!(input["routingText"], "😀 Retry callback\n\n\n\n\n\ncheck result");
    Ok(())
}

#[test]
fn telegram_invalid_utf16_bounds_exclude_routing_without_dropping_the_owner_input() -> Result<()> {
    let me = serde_json::from_value(json!({"id":900,"is_bot":true,"username":"room_bot"}))?;
    let policy = Policy::new("42", &["-100".to_owned()])?;
    let text = "😀 Resume the cache";
    let cases = [
        json!({"type":"pre","offset":1,"length":1}),
        json!({"type":"pre","offset":0,"length":1}),
        json!({"type":"code","offset":2,"length":0}),
        json!({"type":"code","offset":2,"length":100}),
        json!({"type":"blockquote","offset":2,"length":u64::MAX}),
        json!({"type":"blockquote","offset":-1,"length":2}),
        json!({"type":"blockquote","offset":2,"length":"2"}),
        json!({"type":"expandable_blockquote","offset":2}),
    ];
    for entity in cases {
        let message = serde_json::from_value(json!({
            "message_id":10,"date":100,"chat":group(),"message_thread_id":7,
            "from":{"id":42,"is_bot":false},"text":text,"entities":[entity]
        }))?;
        let input = ingress::normalize(&policy, &me, &message).context("owner message rejected")?;
        let input = serde_json::to_value(input)?;
        assert_eq!(input["text"], text);
        assert_eq!(input["routingText"], "", "malformed entity {entity}");
    }
    Ok(())
}

#[tokio::test]
async fn telegram_routing_view_survives_caption_edits_and_gateway_replay() -> Result<()> {
    let mut fixture = Fixture::start().await?;
    let legacy = json!({"kind":"message","input":{"id":"telegram:900:-100:10:original","route":route(),
        "messageId":"10","receivedAt":100000,"text":"copied plan","attachments":[]}});
    assert!(fixture.store.admit(&legacy)?);
    fixture.hub.ready.send_replace(true);
    let (_, reply) = fixture.poll().await?;
    let qualified = "/new@room_bot";
    let caption = format!("{qualified}\n😀 copied plan\nResume callback review.");
    let caption_edit = |date, formatted| {
        let mut entities = vec![json!({"type":"bot_command","offset":0,"length":qualified.len()})];
        if formatted {
            entities.push(json!({"type":"blockquote","offset":qualified.len()+1,
                "length":"😀 copied plan".encode_utf16().count()}));
        }
        json!({
            "message_id":11,"date":101,"edit_date":date,"chat":group(),"message_thread_id":7,
            "from":{"id":42,"is_bot":false},"caption":caption,"caption_entities":entities,
            "document":{"file_id":"document_1","file_unique_id":"unique"}
        })
    };
    let original = json!({"message_id":10,"date":100,"chat":group(),"message_thread_id":7,
        "from":{"id":42,"is_bot":false},"text":"copied plan",
        "entities":[{"type":"pre","offset":0,"length":11}]});
    reply
        .send(json!([
            {"update_id":4,"message":original},
            {"update_id":5,"edited_message":caption_edit(102, true)},
            {"update_id":6,"edited_message":caption_edit(102, false)},
            {"update_id":7,"edited_message":caption_edit(103, false)}
        ]))
        .expect("poll receiver");
    let (next_poll, _outstanding) = fixture.poll().await?;
    assert_eq!(next_poll["offset"], 8, "metadata-only replay must not poison the cursor");
    assert_eq!(fixture.store.pending()?, 3);

    let original = fixture.store.next(None)?.context("original message missing")?;
    assert_eq!(original.event, legacy);
    fixture.store.receipt(original.sequence, GatewayReceipt::Accepted)?;
    let first = fixture.store.next(None)?.context("first edit missing")?;
    fixture.store.receipt(first.sequence, GatewayReceipt::Accepted)?;
    let later = fixture.store.next(None)?.context("later edit missing")?;
    let first = &first.event["input"];
    let later = &later.event["input"];
    let visible = "/new\n😀 copied plan\nResume callback review.";
    assert_eq!(first["text"], visible);
    assert_eq!(first["routingText"], "/new\n\nResume callback review.");
    assert_eq!(later["text"], visible);
    assert_eq!(later["routingText"], visible);
    assert_ne!(first["id"], later["id"]);
    assert_eq!(first["messageId"], "11");
    assert_eq!(later["messageId"], "11");
    fixture.hub.stop().await?;
    Ok(())
}
