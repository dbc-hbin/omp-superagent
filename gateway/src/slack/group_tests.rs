use serde_json::json;

use crate::store::{GatewayReceipt, now};

use super::{Fixture, ack, message, send};

#[tokio::test]
async fn group_socket_requires_fresh_member_message_and_replies_in_the_source_thread() {
    let mut fixture = Fixture::with_config(json!({
        "slack":{"teamId":"TLOCAL","allowedChannelIds":["CALLOWED","CWAIT"]},
        "groupRooms":[{"platform":"slack","guildId":"TLOCAL","channelId":"CALLOWED",
            "userIds":["UOWNER","UMEMBER"],"mode":"request","revision":"active","dailyLimit":2}]
    })).await;
    let (mut peer, started) = fixture.start("ALOCAL").await;
    started.unwrap();
    fixture.hub.ready.send_replace(true);

    let now = now().unwrap() / 1_000;
    let at = |number| format!("{now}.{number:06}");
    let incoming = |id, number, user, text| {
        let mut frame = message(id, "CALLOWED", text);
        frame["payload"]["event"]["ts"] = json!(at(number));
        frame["payload"]["event"]["user"] = json!(user);
        frame
    };
    let mut replay = incoming("retried", 1, "UMEMBER", "!request replayed");
    replay["retry_attempt"] = json!(1);
    let mut old = incoming("stale", 2, "UMEMBER", "!request old");
    old["payload"]["event"]["ts"] = json!(format!("{}.000002", now - 360));
    let mut edited = incoming("edited", 3, "UMEMBER", "!request edited");
    edited["payload"]["event"]["edited"] = json!({"user":"UMEMBER","ts":at(20)});
    let mut foreign = incoming("foreign", 4, "UMEMBER", "!request external sender");
    foreign["payload"]["event"]["user_team"] = json!("TOTHER");
    let mut bot = incoming("bot", 5, "UMEMBER", "!request app impersonation");
    bot["payload"]["event"]["bot_id"] = json!("BOTHER");
    let mut attachment = incoming("file", 6, "UMEMBER", "!request file");
    attachment["payload"]["event"]["files"] = json!([{"id":"FPRIVATE"}]);

    for frame in [
        replay, old, edited, foreign, bot, attachment,
        incoming("owner", 7, "UOWNER", "!help"),
        incoming("stranger", 8, "UOTHER", "!request outsider"),
        incoming("wrong-command", 9, "UMEMBER", "!requesting not a command"),
        json!({"type":"slash_commands","envelope_id":"slash","accepts_response_payload":true,
            "payload":{"team_id":"TLOCAL","user_id":"UOWNER","channel_id":"CALLOWED",
                "trigger_id":"123","command":"/superagent-status","text":""}}),
        json!({"type":"slash_commands","envelope_id":"member-slash","accepts_response_payload":true,
            "payload":{"team_id":"TLOCAL","user_id":"UMEMBER","channel_id":"CALLOWED",
                "trigger_id":"124","command":"/superagent-status","text":""}}),
        json!({"type":"slash_commands","envelope_id":"outsider-slash","accepts_response_payload":true,
            "payload":{"team_id":"TLOCAL","user_id":"UOTHER","channel_id":"CALLOWED",
                "trigger_id":"125","command":"/superagent-status","text":""}}),
    ] {
        let envelope = frame["envelope_id"].clone();
        send(&mut peer, frame).await;
        assert_eq!(ack(&mut peer).await, json!({"envelope_id":envelope}));
    }
    assert_eq!(fixture.store.pending().unwrap(), 0);

    let mut followup = incoming("thread", 12, "UMEMBER", "!request thread work");
    followup["payload"]["event"]["thread_ts"] = json!(at(10));
    let mut original = incoming("root", 11, "UMEMBER", "!request root work");
    original["payload"]["event"]["blocks"] = json!([{"type":"rich_text","elements":[{"text":"rich content ignored"}]}]);
    for (frame, thread, text, source_ts) in [
        (original, None, "root work", at(11)),
        (followup, Some(at(10)), "thread work", at(12)),
    ] {
        let envelope = frame["envelope_id"].clone();
        send(&mut peer, frame).await;
        assert_eq!(ack(&mut peer).await, json!({"envelope_id":envelope}));
        let row = fixture.store.next(None).unwrap().expect("group ACK needs a durable record");
        assert_eq!(row.event["kind"], "group");
        let record = &row.event["request"];
        let route = &record["route"];
        assert_eq!(route["authorityId"], "UOWNER");
        assert_eq!(route["guildId"], "TLOCAL");
        assert_eq!(route["channelId"], "CALLOWED");
        assert_eq!(route["threadId"], json!(thread));
        assert_eq!(record["messageId"], source_ts);
        assert_eq!(record["text"], text);
        assert_eq!(record["userId"], "UMEMBER");
        assert_eq!(record.as_object().map(|fields| fields.len()), Some(7));
        fixture.store.receipt(row.sequence, GatewayReceipt::Accepted).unwrap();
        assert_eq!(fixture.hub.send_group(json!({"id":"group-effect","route":route,
            "messageId":source_ts,"text":"Request received."})).await.unwrap(), "2000.000001");
        let posted = fixture.called("chat.postMessage").await;
        assert_eq!(posted["channel"], "CALLOWED");
        assert_eq!(posted["thread_ts"], thread.as_ref().unwrap_or(&source_ts).as_str());
        assert_eq!(posted["text"], "Request received.");
        assert_eq!(posted["unfurl_links"], "false");
        assert!(posted["blocks"].as_array().unwrap().iter().all(|block| block["type"] == "section"));
    }
    fixture.hub.stop().await.unwrap();
}
