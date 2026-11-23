use anyhow::{Context as _, Result};
use serde_json::{Value, json};

use crate::{picker::ACCEPTED, store::now};

use super::{Fixture, group};

#[tokio::test]
async fn picker_poll_admits_only_the_owner_selection_on_the_exact_card() -> Result<()> {
    let mut fixture = Fixture::start().await?;
    let route = json!({
        "platform":"telegram","accountId":"900","authorityId":"42",
        "guildId":null,"channelId":"42","threadId":null,"topicId":"logical-topic"
    });
    let output = json!({
        "id":"model-status","route":route,"text":"Native HEAD model status",
        "picker":{
            "kind":"model","sessionId":"head-session","generation":1,
            "expiresAt":now()?.saturating_add(60_000),
            "groups":[{"label":"Provider","options":["provider/model-a","provider/model-b"]}]
        }
    });
    assert_eq!(fixture.hub.effect("send", &[output]).await?, "123");
    let card = current_card(&fixture)?;
    let provider = button(&card, "Provider")?;

    let mut wrong_bot = card.clone();
    wrong_bot["from"]["id"] = json!(901);
    let mut wrong_chat = card.clone();
    wrong_chat["chat"] = group();
    let mut wrong_topic = card.clone();
    wrong_topic["message_thread_id"] = json!(7);
    let mut wrong_message = card.clone();
    wrong_message["message_id"] = json!(124);

    fixture.hub.ready.send_replace(true);
    let (first, poll) = fixture.poll().await?;
    assert!(first.get("offset").is_none());
    poll.send(json!([
        callback(4, "not-owner", 43, provider, &card),
        callback(5, "wrong-bot", 42, provider, &wrong_bot),
        callback(6, "wrong-chat", 42, provider, &wrong_chat),
        callback(7, "wrong-topic", 42, provider, &wrong_topic),
        callback(8, "wrong-message", 42, provider, &wrong_message),
        callback(9, "open-provider", 42, provider, &card)
    ]))
    .expect("poll receiver");
    for query in [
        "not-owner",
        "wrong-bot",
        "wrong-chat",
        "wrong-topic",
        "wrong-message",
    ] {
        fixture.feedback(query, true).await?;
    }
    let navigation_ack = fixture.callback_feedback("open-provider", false).await?;
    assert!(button(&current_card(&fixture)?, "Provider").is_ok(), "callback must not wait for the page edit");
    navigation_ack.send(json!(true)).expect("navigation feedback receiver");
    let (next, poll) = fixture.poll().await?;
    assert_eq!(next["offset"], 10);
    assert_eq!(fixture.store.pending()?, 0);
    let models = current_card(&fixture)?;
    let selection = button(&models, "provider/model-b")?;
    assert_ne!(selection, provider);
    poll.send(json!([
        callback(10, "old-page", 42, provider, &card),
        callback(11, "select-model", 42, selection, &models),
        callback(12, "select-model-again", 42, selection, &models)
    ]))
    .expect("poll receiver");
    fixture.feedback("old-page", true).await?;
    let ack = fixture.callback_feedback("select-model", false).await?;
    let admitted = fixture
        .store
        .next(None)?
        .context("Picker ACK preceded durable HEAD input")?;
    assert_eq!(admitted.event["kind"], "message");
    let input = &admitted.event["input"];
    assert_eq!(input["route"], route);
    assert_eq!(input["text"], "");
    assert_eq!(
        input["pickerSelection"],
        json!({"outputId":"model-status","cardId":"123","group":0,"option":1})
    );
    assert!(button(&current_card(&fixture)?, "provider/model-b").is_ok(), "callback must not wait for the card closure");
    ack.send(json!(true)).expect("selection feedback receiver");
    fixture
        .callback_feedback("select-model-again", true)
        .await?
        .send(json!(true))
        .expect("duplicate feedback receiver");
    let (last, _outstanding) = fixture.poll().await?;
    assert_eq!(last["offset"], 13);
    assert_eq!(
        fixture.store.get_meta("telegram:900:offset")?,
        Some("13".into())
    );
    assert_eq!(fixture.store.pending()?, 1);
    let closed = current_card(&fixture)?;
    assert_eq!(closed["reply_markup"]["inline_keyboard"], json!([]));
    assert_eq!(closed["text"], ACCEPTED);
    fixture.hub.stop().await?;
    Ok(())
}

#[tokio::test]
async fn usage_reset_picker_only_admits_the_current_confirm_button() -> Result<()> {
    let mut fixture = Fixture::start().await?;
    let route = json!({
        "platform":"telegram","accountId":"900","authorityId":"42",
        "guildId":null,"channelId":"42","threadId":null
    });
    let label = "Claude · 계정 #9 · 사용 가능 2개";
    let output = json!({
        "id":"usage-reset","route":route,"text":"Saved resets",
        "picker":{
            "kind":"usage-reset","expiresAt":now()?.saturating_add(60_000),
            "groups":[{"label":"Accounts","options":[label]}]
        }
    });
    assert_eq!(fixture.hub.effect("send", &[output]).await?, "123");
    let accounts = current_card(&fixture)?;
    let account = button(&accounts, label)?;

    fixture.hub.ready.send_replace(true);
    let (_, poll) = fixture.poll().await?;
    poll.send(json!([callback(4, "choose-account", 42, account, &accounts)]))
        .expect("poll receiver");
    let choice_ack = fixture.callback_feedback("choose-account", false).await?;
    assert_eq!(fixture.store.pending()?, 0);
    choice_ack.send(json!(true)).expect("choice feedback receiver");
    let (_, poll) = fixture.poll().await?;
    let confirmation = current_card(&fixture)?;
    assert_eq!(fixture.store.pending()?, 0);
    assert!(confirmation["text"].as_str().is_some_and(|text| text.contains(label)));
    let confirm = button(&confirmation, "Confirm")?;
    poll.send(json!([
        callback(5, "old-account-page", 42, account, &accounts),
        callback(6, "confirm-reset", 42, confirm, &confirmation),
        callback(7, "duplicate-confirm", 42, confirm, &confirmation)
    ]))
    .expect("poll receiver");
    fixture.feedback("old-account-page", true).await?;
    let confirm_ack = fixture.callback_feedback("confirm-reset", false).await?;
    assert_eq!(fixture.store.pending()?, 1);
    let event = fixture.store.next(None)?.context("Expected one durable reset confirmation")?.event;
    assert_eq!(event["input"]["route"], route);
    assert_eq!(event["input"]["pickerSelection"],
        json!({"outputId":"usage-reset","cardId":"123","group":0,"option":0,"confirmed":true}));
    confirm_ack.send(json!(true)).expect("confirmation feedback receiver");
    fixture.callback_feedback("duplicate-confirm", true).await?
        .send(json!(true)).expect("duplicate feedback receiver");
    let (_, _outstanding) = fixture.poll().await?;
    assert_eq!(fixture.store.pending()?, 1);
    assert_eq!(current_card(&fixture)?["reply_markup"]["inline_keyboard"], json!([]));
    fixture.hub.stop().await?;
    Ok(())
}

fn current_card(fixture: &Fixture) -> Result<Value> {
    fixture
        .remote
        .card
        .lock()
        .expect("card state")
        .clone()
        .context("Telegram picker card not sent")
}

fn button<'a>(card: &'a Value, label: &str) -> Result<&'a str> {
    let data = card["reply_markup"]["inline_keyboard"]
        .as_array()
        .context("picker keyboard missing")?
        .iter()
        .filter_map(Value::as_array)
        .flatten()
        .find(|button| button["text"] == label)
        .and_then(|button| button["callback_data"].as_str())
        .context("missing picker button")?;
    assert!((1..=64).contains(&data.len()));
    assert!(!data.contains(label));
    Ok(data)
}

fn callback(update: u64, query: &str, sender: u64, data: &str, message: &Value) -> Value {
    json!({"update_id":update,"callback_query":{
        "id":query,"from":{"id":sender,"is_bot":false},"data":data,"message":message
    }})
}
