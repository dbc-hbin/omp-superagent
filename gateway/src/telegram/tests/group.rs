use anyhow::{Context as _, Result};
use serde_json::json;

use crate::store::{GatewayReceipt, now};

use super::{Fixture, group, route};

#[tokio::test]
async fn group_poll_accepts_authenticated_command_entity_and_never_hydrates_quote_or_edit() -> Result<()> {
    let mut fixture = Fixture::start_with(&json!({
        "telegram":{"allowedChatIds":["-100"]},
        "groupRooms":[{"platform":"telegram","guildId":"-100","channelId":"-100",
            "userIds":["42","43"],"mode":"chat","revision":"active","dailyLimit":3}]
    })).await?;
    fixture.hub.ready.send_replace(true);
    let (_, poll) = fixture.poll().await?;
    let date = now()? / 1_000;
    let message = |id, user, text: &str| json!({
        "message_id":id,"date":date,"chat":group(),"message_thread_id":7,
        "from":{"id":user,"is_bot":false},"text":text
    });
    let addressed = |id, user, username: &str, text| {
        let command = format!("/ask@{username}");
        let mut message = message(id, user, &format!("{command} {text}"));
        message["entities"] = json!([{"type":"bot_command","offset":0,"length":command.len()}]);
        message
    };
    let mut old = message(1, 43, "!ask stale");
    old["date"] = json!(date - 360);
    let mut bot = message(2, 43, "!ask robot");
    bot["from"]["is_bot"] = json!(true);
    let mut anonymous = message(3, 43, "!ask anonymous admin");
    anonymous["sender_chat"] = group();
    let mut attachment = message(4, 43, "!ask text and file");
    attachment["sticker"] = json!({"file_id":"file"});
    let mut forwarded = message(5, 43, "!ask forwarded");
    forwarded["forward_origin"] = json!({"type":"hidden_user"});
    let mut admitted = addressed(10, 43, "ROOM_BOT", "draft in my own words");
    admitted["reply_to_message"] = message(20, 42, "/restart secret");
    admitted["quote"] = json!({"text":"secret excerpt"});
    poll.send(json!([
        {"update_id":1,"message":old},
        {"update_id":2,"message":bot},
        {"update_id":3,"message":anonymous},
        {"update_id":4,"message":attachment},
        {"update_id":5,"message":forwarded},
        {"update_id":6,"message":message(6,42,"/restart")},
        {"update_id":7,"message":message(7,44,"!ask stranger")},
        {"update_id":8,"message":message(8,43,"/ask@room_bot no command entity")},
        {"update_id":9,"message":addressed(9,43,"other_bot","wrong bot")},
        {"update_id":10,"message":admitted.clone()},
        {"update_id":11,"message":admitted.clone()},
        {"update_id":12,"edited_message":message(11,43,"!ask edited event")},
        {"update_id":13,"callback_query":{"id":"legacy","from":{"id":42,"is_bot":false},
            "data":"legacy","message":admitted}},
        {"update_id":14,"message":addressed(12,44,"ROOM_BOT","valid command from a nonmember")},
    ])).expect("Telegram fixture update response");

    let (ack, _next_poll) = fixture.poll().await?;
    assert_eq!(ack["offset"], 15);
    assert_eq!(fixture.store.pending()?, 1);
    let group = fixture.store.next(None)?.context("Group update missing after poll ACK")?;
    assert_eq!(group.event["kind"], "group");
    let record = &group.event["request"];
    assert_eq!(record["route"], route());
    assert_eq!(record["messageId"], "10");
    assert_eq!(record["text"], "draft in my own words");
    assert_eq!(record["userId"], "43");
    assert_eq!(record.as_object().map(|fields| fields.len()), Some(7));
    fixture.store.receipt(group.sequence, GatewayReceipt::Accepted)?;
    assert!(fixture.hub.effect("showApproval", &[json!({"route":route()})]).await.is_err());

    assert_eq!(fixture.hub.send_group(json!({
        "id":"group-effect", "route":route(),"messageId":"10","text":"A safe reply."
    })).await?, "123");
    let payload = fixture.remote.group_reply.lock().expect("group reply payload").clone()
        .context("No Telegram reply was sent")?;
    assert_eq!(payload["chat_id"], "-100");
    assert_eq!(payload["message_thread_id"], 7);
    assert_eq!(payload["reply_parameters"], json!({"message_id":10,"allow_sending_without_reply":false}));
    assert_eq!(payload["link_preview_options"], json!({"is_disabled":true}));
    assert_eq!(payload["text"], "A safe reply.");
    assert_eq!(payload.get("reply_markup"), None);
    assert_eq!(payload.get("parse_mode"), None);
    assert_eq!(fixture.remote.card_writes.load(std::sync::atomic::Ordering::Relaxed), 1);
    fixture.hub.stop().await
}
