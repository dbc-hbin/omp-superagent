use super::*;

pub(super) async fn document(body: Bytes) -> Response {
    let multipart = std::str::from_utf8(&body).expect("fixture multipart including NUL bytes");
    assert!(multipart.contains("name=\"chat_id\"\r\n\r\n-100\r\n"));
    assert!(multipart.contains("name=\"message_thread_id\"\r\n\r\n7\r\n"));
    assert!(multipart.contains("name=\"allow_paid_broadcast\"\r\n\r\nfalse\r\n"));
    assert!(multipart.contains("name=\"document\"; filename=\"result.bin\"\r\n\r\n\0BC\n"));
    Json(json!({"ok":true,"result":{
        "message_id":303, "date":100, "chat":group(), "message_thread_id":7,
        "from":{"id":900,"is_bot":true},
        "document":{"file_name":"result.bin","file_size":4,"file_id":"fixture-document","file_unique_id":"fixture-unique"}
    }})).into_response()
}

#[tokio::test]
async fn result_attachment_is_a_native_document_in_the_original_forum_thread() -> Result<()> {
    let fixture = Fixture::start().await?;
    let output = json!({"id":"result-file","route":route(),"text":""});
    let file = crate::result_attachment::VerifiedResultAttachment {
        name: "result.bin".to_owned(), bytes: b"\0BC\n".to_vec(),
    };
    let remote = fixture.hub.send_result_attachment(&output, file).await.map_err(|error| {
        anyhow::anyhow!("Telegram native output failed: {}", error.message)
    })?;
    assert_eq!(remote, "303");
    fixture.hub.stop().await?;
    Ok(())
}
