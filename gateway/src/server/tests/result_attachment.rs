use std::os::unix::fs::PermissionsExt;

use anyhow::Context as _;
use rusqlite::{Connection, params};
use sha2::{Digest, Sha256};

use super::*;

fn outbox(root: &SocketDir) -> Result<Connection> {
    let db = Connection::open(root.0.join("coordination.sqlite"))?;
    db.execute_batch(
        "CREATE TABLE inputs(id TEXT PRIMARY KEY);
         CREATE TABLE outputs(id TEXT PRIMARY KEY, source_id TEXT, route TEXT, reply_to TEXT,
           text TEXT, result_attachment TEXT, state TEXT, picker TEXT, edit_of TEXT, status INTEGER);",
    )?;
    Ok(db)
}

fn claim(db: &Connection, source: &str, payload: &Value) -> Result<Value> {
    let output_id = format!("result-attachment:{source}");
    let route = json!({"platform":"telegram","accountId":"bot","authorityId":"owner",
        "guildId":null,"channelId":"chat","threadId":null});
    db.execute("INSERT OR IGNORE INTO inputs VALUES (?)", [source])?;
    db.execute(
        "INSERT INTO outputs (id,source_id,route,text,result_attachment,state,status) VALUES (?,?,?,'',?,'sending',0)
         ON CONFLICT(id) DO UPDATE SET result_attachment=excluded.result_attachment",
        params![output_id, source, route.to_string(), json!({"sourceId": source, "inputId": source,
            "requestId":"native-request","generation":0,"sessionId":"native-session",
            "sessionFile":"/private/session.jsonl","toolCallId":"attach","payload":payload}).to_string()],
    )?;
    let hash = hex::encode(Sha256::digest(serde_json::to_vec(&["result-attachment", &output_id])?));
    let id = Uuid::parse_str(&hash[..32])?.hyphenated().to_string();
    Ok(json!({"id":id,"operation":"send","args":[{"id":output_id,"route":route,"text":"","resultAttachment":payload}]}))
}

fn snapshot(root: &SocketDir, workspace: &SocketDir, name: &str) -> Result<Value> {
    let snapshot = crate::result_attachment::stage(
        &root.0.canonicalize()?, &workspace.0.canonicalize()?, name, &[root.0.canonicalize()?],
    ).map_err(|error| anyhow::anyhow!("{error}"))?;
    Ok(serde_json::to_value(snapshot)?)
}

fn blob(root: &SocketDir, payload: &Value) -> Result<PathBuf> {
    Ok(root.0.join("result-attachments").join(payload["snapshotId"].as_str().context("snapshot ID")?))
}

#[tokio::test]
async fn result_attachment_attempt_ledger_retains_only_fingerprint_and_rejects_changed_bytes() -> Result<()> {
    let root = SocketDir::new()?;
    let workspace = SocketDir::new()?;
    let fixture = GatewayClient::connect(&root, String::new()).await?;
    let db = outbox(&root)?;
    let name = "結果 １２.bin";
    fs::write(workspace.0.join(name), b"\0BC\n")?;
    let payload = snapshot(&root, &workspace, name)?;
    let request = claim(&db, "attachment-effect", &payload)?;
    let mut wrong_route = request.clone();
    wrong_route["args"][0]["route"]["threadId"] = json!("wrong-topic");
    assert_eq!(fixture.call("/effect", &wrong_route).await?["certainty"], "rejected");
    fs::write(workspace.0.join(name), "modified after staging")?;
    let first = fixture.call("/effect", &request).await?;
    assert_eq!(first["value"], "fixture-file-receipt", "{first}");
    fs::remove_file(blob(&root, &payload)?)?;
    assert_eq!(fixture.call("/effect", &request).await?, first, "a replay must not open the snapshot again");
    let replacement = snapshot(&root, &workspace, name)?;
    let changed = claim(&db, "attachment-effect", &replacement)?;
    assert_eq!(fixture.call("/effect", &changed).await?["certainty"], "uncertain", "no second attempt with a different snapshot");
    let saved: String = db.query_row(
        "SELECT arguments FROM gateway_effects WHERE id = ?",
        [request["id"].as_str().context("effect ID")?],
        |row| row.get(0),
    )?;
    let saved: Value = serde_json::from_str(&saved)?;
    let argument = saved[0].as_object().context("Gateway effect fingerprint")?;
    assert_eq!(argument.len(), 1, "the Gateway need not retain the attachment payload");
    assert_eq!(argument["resultAttachmentEffectSha256"].as_str().map(str::len), Some(64));
    fixture.server.close().await
}

#[tokio::test]
async fn missing_changed_or_replaced_snapshots_never_reach_the_transport() -> Result<()> {
    let root = SocketDir::new()?;
    let workspace = SocketDir::new()?;
    let fixture = GatewayClient::connect(&root, String::new()).await?;
    let db = outbox(&root)?;
    fs::write(workspace.0.join("result.bin"), b"\0BC\n")?;
    for failure in ["missing", "tampered", "identity"] {
        let payload = snapshot(&root, &workspace, "result.bin")?;
        let path = blob(&root, &payload)?;
        match failure {
            "missing" => fs::remove_file(&path)?,
            "tampered" => {
                fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
                fs::write(&path, b"abcd")?;
                fs::set_permissions(&path, fs::Permissions::from_mode(0o400))?;
            }
            "identity" => {
                fs::rename(&path, path.with_extension("old"))?;
                fs::write(&path, b"\0BC\n")?;
                fs::set_permissions(&path, fs::Permissions::from_mode(0o400))?;
            }
            _ => unreachable!(),
        }
        let result = fixture.call("/effect", &claim(&db, failure, &payload)?).await?;
        assert_eq!(result["certainty"], "rejected", "{failure}: {result}");
        assert_eq!(result["error"], "Result attachment snapshot is missing or does not match its receipt");
    }
    fixture.server.close().await
}

#[tokio::test]
async fn legacy_rows_upload_without_a_base64_frame_and_keep_original_attempt_receipts() -> Result<()> {
    let root = SocketDir::new()?;
    let fixture = GatewayClient::connect(&root, String::new()).await?;
    let db = outbox(&root)?;
    let legacy = json!({"name":"result.bin","data":"AEJDCg=="});
    for (source, receipt) in [("unattempted", None), ("ambiguous", None), ("complete", Some(r#"{"ok":true,"value":"old-file-receipt"}"#))] {
        let mut request = claim(&db, source, &legacy)?;
        if source != "unattempted" {
            let mut original = request["args"].clone();
            original.sort_all_objects();
            let fingerprint = json!([{"resultAttachmentEffectSha256":
                hex::encode(Sha256::digest(serde_json::to_vec(&original)?))}]);
            db.execute("INSERT INTO gateway_effects VALUES (?,'send',?,?,?)",
                params![request["id"].as_str(), fingerprint.to_string(),
                    if receipt.is_some() { "complete" } else { "attempted" }, receipt])?;
        }
        assert_eq!(fixture.call("/effect", &request).await?["certainty"], "rejected", "raw legacy wire data no longer accepted");
        request["args"][0]["resultAttachment"] = json!({"name":"result.bin","legacy":true});
        let result = fixture.call("/effect", &request).await?;
        match source {
            "unattempted" => assert_eq!(result["value"], "fixture-file-receipt", "{result}"),
            "ambiguous" => assert_eq!(result["error"], "Gateway effect outcome uncertain", "{result}"),
            "complete" => assert_eq!(result["value"], "old-file-receipt", "{result}"),
            _ => unreachable!(),
        }
    }
    fixture.server.close().await
}
