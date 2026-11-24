use super::*;

pub(super) async fn upload(
    State(state): State<SlackFixture>,
    headers: HeaderMap,
    body: Bytes,
) -> StatusCode {
    assert!(!headers.contains_key("authorization"), "signed upload URL must not receive the bot token");
    assert_eq!(body.as_ref(), b"\0BC\n");
    state.traces.send(("upload".to_owned(), Value::Null)).expect("upload trace");
    StatusCode::OK
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn result_attachment_is_published_in_the_original_slack_thread() {
    let mut fixture = Fixture::new().await;
    let (_peer, started) = fixture.start("ALOCAL").await;
    started.expect("authenticated Slack workspace");
    let route = json!({
        "platform":"slack","accountId":"TLOCAL:UBOT","authorityId":"UOWNER","guildId":"TLOCAL",
        "channelId":"CALLOWED","threadId":"1000.000001"
    });
    let file = crate::result_attachment::VerifiedResultAttachment {
        name: "result.bin".to_owned(), bytes: b"\0BC\n".to_vec(),
    };
    let result = fixture.hub.send_result_attachment(&json!({
        "id":"result-file","route":route,"text":""
    }), file).await.expect("native Slack upload and publication");
    assert_eq!(result, "file:FRESULT");
    let ticket = fixture.called("files.getUploadURLExternal").await;
    assert_eq!(ticket["filename"], "result.bin");
    assert_eq!(ticket["length"], "4");
    fixture.called("upload").await;
    let completed = fixture.called("files.completeUploadExternal").await;
    assert_eq!(completed["channel_id"], "CALLOWED");
    assert_eq!(completed["thread_ts"], "1000.000001");
    assert_eq!(completed["files"], json!([{"id":"FRESULT","title":"result.bin"}]));
}
