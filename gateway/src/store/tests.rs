use std::{fs, path::PathBuf};

use anyhow::{Context, Result};
use rusqlite::{Connection, params};
use serde_json::json;
use uuid::Uuid;

use super::{GatewayReceipt, Store, answer_digest};

struct StateDir(PathBuf);

impl StateDir {
    fn new() -> Result<Self> {
        let path = std::env::temp_dir().join(format!("gateway-store-{}", Uuid::new_v4()));
        fs::create_dir(&path)?;
        Ok(Self(path))
    }
}

impl Drop for StateDir {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_dir_all(&self.0) {
            eprintln!("Could not remove Gateway store test directory: {error}");
        }
    }
}

#[test]
fn rotation_keeps_later_input_durable_without_redelivering_preceding_input() -> Result<()> {
    let root = StateDir::new()?;
    let route = json!({"platform":"telegram","accountId":"bot","authorityId":"owner",
        "guildId":null,"channelId":"chat","threadId":null,"topicId":"original"});
    let answer = |id| json!({"kind":"answer","approvalId":id,"route":route,"response":{"confirmed":true}});
    let stopping = json!({"stage":"stopping"}).to_string();
    {
        let store = Store::open(&root.0)?;
        assert!(store.admit(&answer("old"))?);
        assert!(!store.begin_rotation(None, None, &stopping)?);
        let event = store.next(None)?.context("Prior event not delivered")?;
        store.receipt(event.sequence, GatewayReceipt::Accepted)?;
        assert!(store.begin_rotation(None, None, &stopping)?);
        assert!(store.admit(&answer("during-rotation"))?);
        assert!(store.next(None)?.is_none());
    }
    let store = Store::open(&root.0)?;
    assert_eq!(store.pending()?, 1);
    assert!(store.next(None)?.is_none());
    store.finish_rotation(
        &json!({"sessionId":"new"}),
        &json!({"stage":"complete","original":{"sessionId":"old"},
            "attestation":{"selection":{"modelSettings":{}}}}).to_string(),
    )?;
    let event = store.next(None)?.context("Durable rotation input was lost")?;
    assert_eq!(event.event["approvalId"], "during-rotation");
    store.receipt(event.sequence, GatewayReceipt::Accepted)?;
    assert!(store.next(None)?.is_none());
    Ok(())
}

#[test]
fn rotation_shutdown_authority_is_refused_after_an_operator_lifecycle_fence() -> Result<()> {
    let root = StateDir::new()?;
    let store = Store::open(&root.0)?;
    let stopping = json!({"stage":"stopping"}).to_string();
    store.set_meta("gateway:operator-stop", "explicit-stop")?;
    assert!(!store.begin_rotation(None, None, &stopping)?);
    store.set_meta("head:restart-fence", "{}")?;
    assert!(!store.begin_rotation(None, Some("explicit-stop"), &stopping)?);
    assert!(store.get_meta(super::HEAD_ROTATION)?.is_none());
    Ok(())
}

#[test]
fn legacy_pending_and_generic_error_callbacks_require_original_state_reconciliation() -> Result<()>
{
    let root = StateDir::new()?;
    let legacy = Connection::open(root.0.join("coordination.sqlite"))?;
    legacy.execute_batch(
        "CREATE TABLE gateway_events (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT, identity TEXT NOT NULL UNIQUE,
            data TEXT NOT NULL, received_at INTEGER NOT NULL, delivered_at INTEGER, delivery_error TEXT
         );",
    )?;
    let route = json!({"platform":"telegram","accountId":"bot","authorityId":"owner",
        "guildId":null,"channelId":"chat","threadId":null});
    for (id, delivered, error) in [
        ("pending", None, None),
        (
            "generic-error",
            Some(2),
            Some("Head rejected admitted event"),
        ),
    ] {
        let event =
            json!({"kind":"answer","approvalId":id,"route":route,"response":{"confirmed":true}});
        legacy.execute(
            "INSERT INTO gateway_events(identity,data,received_at,delivered_at,delivery_error)
             VALUES(?,?,1,?,?)",
            params![format!("answer:{id}"), event.to_string(), delivered, error],
        )?;
    }
    drop(legacy);

    {
        let store = Store::open(&root.0)?;
        let first = store
            .next(None)?
            .context("Original pending callback missing")?;
        assert_eq!(first.event["approvalId"], "pending");
        assert_eq!(first.reconciliation, Some(true));
        store.receipt(first.sequence, GatewayReceipt::Rejected)?;
    }
    let store = Store::open(&root.0)?;
    let old_error = store
        .next(None)?
        .context("Legacy failure was not recovered")?;
    assert_eq!(old_error.event["approvalId"], "generic-error");
    assert_eq!(old_error.reconciliation, Some(true));
    assert_eq!(store.unresolved()?, 1);
    Ok(())
}

#[test]
fn callback_admission_proof_survives_head_receipt_without_proving_foreign_answers() -> Result<()> {
    let root = StateDir::new()?;
    let route = json!({"platform":"telegram","accountId":"bot","authorityId":"owner",
        "guildId":null,"channelId":"chat","threadId":null,"topicId":"original"});
    let response =
        json!({"answers":[{"id":"question","selectedOptions":["one","two"],"customInput":"text"}]});
    {
        let store = Store::open(&root.0)?;
        assert!(store.admit(
            &json!({"kind":"answer","approvalId":"card","route":route,"response":response})
        )?);
        let frame = store.next(None)?.context("Committed answer missing")?;
        store.receipt(frame.sequence, GatewayReceipt::Accepted)?;
    }
    let store = Store::open(&root.0)?;
    assert!(!store.has_pending_answer("card", &route)?);
    let reordered_keys =
        json!({"answers":[{"customInput":"text","selectedOptions":["one","two"],"id":"question"}]});
    let digest = answer_digest(&reordered_keys)?;
    assert!(store.has_durable_answer("card", &route, &digest)?);
    assert!(!store.has_durable_answer("different-card", &route, &digest)?);
    for (field, different) in [
        ("topicId", "different-topic"),
        ("accountId", "different-bot"),
        ("authorityId", "different-owner"),
    ] {
        let mut foreign = route.clone();
        foreign[field] = json!(different);
        assert!(!store.has_durable_answer("card", &foreign, &digest)?);
    }
    let reordered_choices =
        json!({"answers":[{"id":"question","selectedOptions":["two","one"],"customInput":"text"}]});
    assert!(!store.has_durable_answer("card", &route, &answer_digest(&reordered_choices)?)?);
    Ok(())
}

#[test]
fn restart_authority_retains_exact_source_route_and_historical_receipt() -> Result<()> {
    let root = StateDir::new()?;
    let store = Store::open(&root.0)?;
    let head = Connection::open(root.0.join("coordination.sqlite"))?;
    head.execute_batch(
        "CREATE TABLE inputs (id TEXT PRIMARY KEY, data TEXT NOT NULL, target TEXT, state TEXT);
         CREATE TABLE outputs (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, route TEXT NOT NULL, state TEXT, remote_id TEXT);",
    )?;
    for id in ["first", "latest"] {
        let route = json!({"platform":"telegram","accountId":"bot","authorityId":"owner",
            "guildId":null,"channelId":"chat","threadId":null,"topicId":id});
        let input = json!({"id":id,"text":" /restart\n","route":route});
        head.execute(
            "INSERT INTO inputs VALUES(?,?,'main','done')",
            params![id, input.to_string()],
        )?;
        let mut wrong_route = route.clone();
        wrong_route["topicId"] = json!("another-topic");
        let ack = format!("{id}-ack");
        head.execute(
            "INSERT INTO outputs VALUES(?,?,?,'sent','sent-message')",
            params![ack, id, wrong_route.to_string()],
        )?;
        store.set_meta(&format!("user-source:{id}"), "true")?;
        let record = json!({"requestId":id,"inputId":id,"ackOutputId":ack,"gatewayPid":2,
            "headPid":3,"sessionId":"head","sessionFile":"/head.jsonl","state":"accepted"});
        assert!(
            store.set_restart(&record).is_err(),
            "a different topic must not grant restart authority"
        );
        assert!(store.get_restart(Some(id))?.is_none());
        head.execute(
            "UPDATE outputs SET route=? WHERE id=?",
            params![route.to_string(), ack],
        )?;
        store.set_restart(&record)?;
    }
    let mut old = store
        .get_restart(Some("first"))?
        .context("Missing accepted restart")?;
    old["state"] = json!("refused");
    store.set_restart(&old)?;
    drop(store);
    let reopened = Store::open(&root.0)?;
    assert_eq!(
        reopened
            .get_restart(None)?
            .context("Missing latest restart")?["requestId"],
        "latest"
    );
    assert_eq!(reopened.get_restart(Some("first"))?, Some(old));
    Ok(())
}
