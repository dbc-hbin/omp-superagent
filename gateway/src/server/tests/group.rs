use anyhow::{Context as _, Result};
use async_trait::async_trait;
use serde_json::{Value, json};
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::{
    adapter::{Adapter, Context, EffectError, Hub as AdapterHub},
    group::Candidate,
    store::{Store, now},
};

use super::{GatewayClient, LifecycleFixture, SocketDir};
use std::sync::Arc;

struct Recorder(mpsc::UnboundedSender<(String, Value)>);

#[async_trait]
impl Adapter for Recorder {
    async fn start(&self) -> Result<()> { Ok(()) }
    async fn stop(&self) -> Result<()> { Ok(()) }
    async fn effect(&self, operation: &str, args: &[Value]) -> Result<Value, EffectError> {
        self.0.send((operation.to_owned(), json!(args)))
            .map_err(|_| EffectError::uncertain("Fixture transport disconnected"))?;
        if operation == "assertRoute" && args.first().is_none_or(|route| route["accountId"] != "900") {
            return Err(EffectError::rejected("Fixture bot account does not match"));
        }
        Ok(json!("sent"))
    }
    async fn attachment(&self, route: &Value, file: &Value) -> Result<reqwest::Response, EffectError> {
        self.0.send(("attachment".to_owned(), json!([route, file])))
            .map_err(|_| EffectError::uncertain("Fixture transport disconnected"))?;
        Err(EffectError::uncertain("Unexpected attachment transport invocation"))
    }
}

fn configured(revision: &str) -> Value {
    json!({
        "telegram":{"allowedChatIds":["-100","-200"]},
        "groupRooms":[{"platform":"telegram","guildId":"-100","channelId":"-100","userIds":["43"],
            "mode":"work","revision":revision,"dailyLimit":5},
          {"platform":"telegram","guildId":"-200","channelId":"-200","userIds":["43"],
            "mode":"chat","revision":"chat","dailyLimit":5}]
    })
}

fn make_adapters(
    store: &Arc<Store>,
    revision: &str,
    calls: &mpsc::UnboundedSender<(String, Value)>,
) -> Result<(Arc<AdapterHub>, Context)> {
    let mut captured = None;
    let adapters = AdapterHub::with_factory(&configured(revision), store.clone(), |_, _, ctx| {
        captured = Some(ctx);
        Ok(Box::new(Recorder(calls.clone())))
    })?;
    Ok((adapters, captured.context("Missing adapter context")?))
}

fn route(channel: &str) -> Value {
    json!({"platform":"telegram","guildId":channel,"channelId":channel,
        "authorityId":"42","accountId":"900","threadId":"5"})
}

fn admit(ctx: &Context, route: Value, text: &str) -> Result<()> {
    ctx.admit_group(route, Candidate {
        message_id: "17", user_id: "43", text, sent_ms: now()?, qualified_command: None,
    })
}

fn rpc(operation: &str, args: Value) -> Value {
    json!({"id":Uuid::new_v4().to_string(),"operation":operation,"args":args})
}

#[tokio::test]
async fn history_route_verifies_the_live_account_without_draining_pending_intake() -> Result<()> {
    let root = SocketDir::new()?;
    let store = Arc::new(Store::open(&root.0)?);
    let (calls, mut observed) = mpsc::unbounded_channel();
    let (adapters, _) = make_adapters(&store, "history", &calls)?;
    adapters.start().await?;
    let fixture = GatewayClient::with_adapters(&root, store.clone(), Arc::new(LifecycleFixture), adapters).await?;
    let owner = json!({
        "platform":"telegram","guildId":null,"channelId":"42","authorityId":"42","accountId":"900","threadId":null
    });
    let lookup = json!({"route":owner});
    assert_eq!(fixture.call("/history/route", &lookup).await?["certainty"], "rejected");
    assert_eq!(fixture.call("/ready", &json!({})).await?["ok"], true);
    assert!(store.admit(&json!({"kind":"message","input":{
        "id":"history-request","route":owner,"text":"Resume the earlier work","messageId":"17","attachments":[]
    }}))?);

    assert_eq!(fixture.call("/route", &lookup).await?["error"], "Gateway intake is still pending");
    assert_eq!(fixture.call("/history/route", &lookup).await?["ok"], true);
    assert_eq!(observed.try_recv()?, ("assertRoute".to_owned(), json!([owner])));
    let mut wrong_account = lookup.clone();
    wrong_account["route"]["accountId"] = json!("other-bot");
    assert_eq!(fixture.call("/history/route", &wrong_account).await?["certainty"], "rejected");
    assert_eq!(observed.try_recv()?.1, json!([wrong_account["route"]]));
    assert_eq!(fixture.call("/history/route", &json!({"route":route("-100")})).await?["certainty"], "rejected");

    let mut foreign = fixture.headers.clone();
    foreign.insert("x-gateway-client", Uuid::new_v4().to_string().parse()?);
    let denied: Value = fixture.client.post("http://localhost/history/route")
        .headers(foreign).json(&lookup).send().await?.json().await?;
    assert_eq!(denied["certainty"], "rejected");
    assert_eq!(fixture.call("/detach", &json!({})).await?["ok"], true);
    assert_eq!(fixture.call("/history/route", &lookup).await?["certainty"], "rejected");
    assert!(observed.try_recv().is_err());
    assert_eq!(store.pending()?, 1);
    fixture.server.close().await
}

#[tokio::test]
async fn group_effect_ipc_requires_durable_source_and_blocks_legacy_owner_routes() -> Result<()> {
    let root = SocketDir::new()?;
    let store = Arc::new(Store::open(&root.0)?);
    let (calls, mut observed) = mpsc::unbounded_channel();
    let (adapters, ctx) = make_adapters(&store, "original", &calls)?;
    let work = route("-100");
    let chat = route("-200");
    let owner_event = json!({"kind":"message","input":{
        "id":"old-owner","route":work,"text":"/restart","messageId":"17","attachments":[]
    }});
    let old_output = rpc("send", json!([{"id":"old-output","route":work,"text":"old response"}]));
    let old_id = old_output["id"].as_str().context("Old owner effect ID")?;
    store.begin_effect(old_id, "send", old_output["args"].as_array().context("Old owner arguments")?)?;
    store.finish_effect(old_id, &json!({"ok":true,"value":"previously sent"}))?;
    assert!(store.admit(&owner_event)?);
    assert!(store.admit(&json!({"kind":"answer","route":work,
        "approvalId":"old-approval","response":{"confirmed":true}}))?);
    let fixture = GatewayClient::with_adapters(&root, store.clone(), Arc::new(LifecycleFixture), adapters).await?;
    assert_eq!(fixture.call("/ready", &json!({})).await?["ok"], true);
    admit(&ctx, work.clone(), "!work private request")?;
    admit(&ctx, chat.clone(), "!ask public question")?;

    let mut stream = fixture.client.get("http://localhost/events")
        .headers(fixture.headers.clone()).send().await?;
    let first: Value = serde_json::from_slice(&stream.chunk().await?.context("Expected group frame")?)?;
    assert_eq!(first["event"]["kind"], "group");
    let source_id = first["event"]["request"]["id"].as_str().context("Durable source ID missing")?;
    assert_eq!(first["event"]["request"]["route"], work);
    assert_eq!(store.pending()?, 2, "legacy owner messages and answers must not be delivered");

    let call = |arg| rpc("sendGroup", json!([arg]));
    for invalid in [
        call(json!({"sourceId":"old-owner","outcome":"received"})),
        call(json!({"sourceId":"missing","outcome":"received"})),
        call(json!({"sourceId":source_id,"outcome":"received","route":chat})),
        call(json!({"sourceId":source_id,"outcome":"finished","text":"private paths"})),
        call(json!({"sourceId":source_id,"outcome":"received","text":null})),
        call(json!({"sourceId":source_id,"outcome":"received","picker":{}})),
        rpc("send", json!([{"id":"ordinary","route":work,"text":"owner-only text"}])),
        rpc("showApproval", json!([{"id":"legacy","route":work}])),
        rpc("dismissApproval", json!([{"id":"legacy","route":work}])),
        rpc("setActivity", json!([{"route":work,"messageId":"17"},"thinking"])),
        rpc("fetchAfter", json!([work,"1"])),
        rpc("createThread", json!([work,"owner-only thread"])),
        old_output,
    ] {
        let denied = fixture.call("/effect", &invalid).await?;
        assert_eq!(denied["certainty"], "rejected", "{invalid}");
    }
    assert_eq!(fixture.call("/attachment", &json!({"route":work,
        "attachment":{"id":"file","size":5,"name":"private.txt","url":"fixture"}})).await?["certainty"], "rejected");
    assert!(observed.try_recv().is_err());

    let valid = call(json!({"sourceId":source_id,"outcome":"finished"}));
    assert_eq!(fixture.call("/effect", &valid).await?, json!({"ok":true,"value":"sent"}));
    assert_eq!(fixture.call("/effect", &valid).await?, json!({"ok":true,"value":"sent"}));
    let (operation, args) = observed.try_recv()?;
    assert_eq!(operation, "sendGroup");
    assert_eq!(args, json!([{"id":valid["id"],"route":work,"messageId":"17","text":"Request finished."}]));
    assert!(observed.try_recv().is_err());

    assert_eq!(fixture.call("/receipt", &json!({
        "sequence":first["sequence"],"outcome":"accepted"
    })).await?["ok"], true);
    let second: Value = serde_json::from_slice(&stream.chunk().await?.context("Expected chat frame")?)?;
    let chat_source = &second["event"]["request"]["id"];
    assert_ne!(chat_source, source_id, "the physical conversation is part of source identity");
    for text in ["".to_owned(), "😀".repeat(751)] {
        assert_eq!(fixture.call("/effect", &call(json!({
            "sourceId":chat_source,"outcome":"finished","text":text
        }))).await?["certainty"], "rejected");
    }
    assert_eq!(fixture.call("/effect", &call(json!({
        "sourceId":chat_source,"outcome":"finished","text":"😀".repeat(750)
    }))).await?["value"], "sent");
    let (_, args) = observed.try_recv()?;
    assert_eq!(args[0]["route"], chat);
    assert_eq!(args[0]["text"], "😀".repeat(750));
    assert_eq!(fixture.call("/receipt", &json!({
        "sequence":second["sequence"],"outcome":"accepted"
    })).await?["ok"], true);
    assert_eq!(fixture.call("/route", &json!({"route":work})).await?["error"],
        "Owner operations are disabled in restricted group rooms");
    drop(stream);
    fixture.server.close().await?;

    // A duplicate seen under a new revision must retain its original identity,
    // advance intake normally, and not inherit the new policy or old receipt.
    let (adapters, ctx) = make_adapters(&store, "replacement", &calls)?;
    let replacement = GatewayClient::with_adapters(&root, store.clone(), Arc::new(LifecycleFixture), adapters).await?;
    replacement.call("/ready", &json!({})).await?;
    admit(&ctx, work, "!work private request")?;
    assert_eq!(store.pending()?, 0);
    assert_eq!(replacement.call("/effect", &valid).await?["certainty"], "rejected");
    assert!(observed.try_recv().is_err());
    replacement.server.close().await
}
