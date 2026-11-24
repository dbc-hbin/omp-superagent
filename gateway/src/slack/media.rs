use std::time::Duration;

use reqwest::{Response, Url};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::adapter::EffectError;
use crate::picker::Picker;
use crate::result_attachment::VerifiedResultAttachment;

use super::Inner;
use super::api::secure_url;
use super::picker::menu_blocks;
use super::wire::{Attachment, Route, Ts, file_id, js_len, same_optional, short_hash};

const FILE_LIMIT: usize = 8 * 1024 * 1024;
pub(super) const TEXT_LIMIT: usize = 3_000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Output {
    id: String,
    route: Route,
    text: String,
    picker: Option<Picker>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct MessageRef {
    route: Route,
    message_id: Ts,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Activity {
    Received,
    Thinking,
    Idle,
}

#[derive(Deserialize)]
struct Posted {
    channel: String,
    ts: Ts,
}

#[derive(Deserialize)]
struct UploadTicket {
    file_id: String,
    upload_url: String,
}

#[derive(Deserialize)]
struct UploadComplete {
    files: Vec<FileRef>,
}

#[derive(Deserialize)]
struct FileRef {
    id: String,
}

pub(super) fn plain(text: &str) -> Value {
    let text = if text.is_empty() { "(empty)" } else { text };
    json!({ "type": "plain_text", "text": text, "emoji": false })
}

pub(super) fn sections(text: &str) -> Vec<Value> {
    let mut blocks = Vec::new();
    let mut start = 0;
    let mut len = 0;
    for (index, point) in text.char_indices() {
        if len + point.len_utf16() > TEXT_LIMIT {
            blocks.push(json!({ "type": "section", "text": plain(&text[start..index]) }));
            start = index;
            len = 0;
        }
        len += point.len_utf16();
    }
    blocks.push(json!({ "type": "section", "text": plain(&text[start..]) }));
    blocks
}

pub(super) fn message_payload(text: &str, blocks: Vec<Value>) -> Result<Value, EffectError> {
    if blocks.len() > 50 {
        return Err(EffectError::rejected(
            "Slack card exceeds 50 blocks; use the local OMP interface",
        ));
    }
    let text = if text.is_empty() {
        "(empty output)"
    } else {
        text
    };
    let fallback = text
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    let mut args = json!({ "blocks": blocks, "parse": "none", "link_names": false });
    if js_len(&fallback) <= TEXT_LIMIT {
        args["text"] = json!(fallback);
    }
    Ok(args)
}

impl Inner {
    pub(super) async fn post(
        &self,
        route: &Route,
        text: &str,
        blocks: Option<Vec<Value>>,
    ) -> Result<Ts, EffectError> {
        let mut args = message_payload(text, blocks.unwrap_or_else(|| sections(text)))?;
        args["channel"] = json!(route.channel_id);
        if let Some(root) = &route.thread_id {
            args["thread_ts"] = json!(root);
        }
        args["mrkdwn"] = json!(false);
        args["unfurl_links"] = json!(false);
        args["unfurl_media"] = json!(false);
        let receipt: Posted = self.api.call("chat.postMessage", args).await?;
        if receipt.channel != route.channel_id {
            return Err(EffectError::uncertain(
                "Slack send has no authoritative destination receipt",
            ));
        }
        Ok(receipt.ts)
    }

    pub(super) async fn send_result_attachment(
        &self, output: Output, file: VerifiedResultAttachment,
    ) -> Result<String, EffectError> {
        if output.route.authority_id != self.owner || output.picker.is_some() || !output.text.is_empty() {
            return Err(EffectError::rejected("Slack result attachments require owner authority and a standalone file"));
        }
        self.destination(&output.route).await?;
        self.upload(&output.route, file.name, file.bytes).await
    }

    pub(super) async fn send(&self, output: Output) -> Result<String, EffectError> {
        self.destination(&output.route).await?;
        if output.text.len() > FILE_LIMIT {
            return Err(EffectError::rejected(
                "Slack text output exceeds the safe 8 MiB upload limit",
            ));
        }
        if let Some(spec) = &output.picker {
            let _delivery = self.ctx.pickers.delivery().await;
            if let Some(opening) = self.ctx.pickers.open(&output.id, json!(output.route), &output.text, spec)? {
                let receipt = self
                    .post(
                        &output.route,
                        &opening.menu.text,
                        Some(menu_blocks(&opening.menu)),
                    )
                    .await?
                    .as_str()
                    .to_owned();
                self.ctx.pickers.posted(opening, receipt.clone())?;
                return Ok(receipt);
            }
        }
        if js_len(&output.text) <= TEXT_LIMIT {
            return self
                .post(&output.route, &output.text, None)
                .await
                .map(|ts| ts.as_str().to_owned());
        }
        let filename = format!(
            "omp-{}.txt",
            short_hash(&json!([output.id, output.route.key()]))
        );
        self.upload(&output.route, filename, output.text.into_bytes()).await
    }

    async fn upload(&self, route: &Route, filename: String, bytes: Vec<u8>) -> Result<String, EffectError> {
        let ticket: UploadTicket = self
            .api
            .call(
                "files.getUploadURLExternal",
                json!({ "filename": filename, "length": bytes.len() }),
            )
            .await?;
        if !file_id(&ticket.file_id) {
            return Err(EffectError::rejected(
                "Slack returned an invalid upload ticket",
            ));
        }
        let url = authorized_file_url(&ticket.upload_url, "/upload/v1/", false)
            .ok_or_else(|| EffectError::rejected("Slack returned an unauthorized upload URL"))?;
        let response = self
            .api
            .file_upload(url)
            .timeout(Duration::from_secs(60))
            .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
            .body(bytes)
            .send()
            .await
            .map_err(|_| {
                EffectError::rejected("Slack file upload failed before publication was attempted")
            })?;
        if !response.status().is_success() {
            return Err(EffectError::rejected(
                "Slack file bytes were not accepted; publication was not attempted",
            ));
        }
        drop(response);
        let mut args = json!({
            "files": [{ "id": ticket.file_id, "title": filename }], "channel_id": route.channel_id,
        });
        if let Some(root) = &route.thread_id {
            args["thread_ts"] = json!(root);
        }
        let receipt: UploadComplete = self.api.call("files.completeUploadExternal", args).await?;
        if !receipt.files.iter().any(|file| file.id == ticket.file_id) {
            return Err(EffectError::uncertain(
                "Slack file publication has no authoritative receipt",
            ));
        }
        Ok(format!("file:{}", ticket.file_id))
    }

    pub(super) async fn activity(
        &self,
        target: MessageRef,
        activity: Activity,
    ) -> Result<(), EffectError> {
        self.destination(&target.route).await?;
        let (method, reaction, idempotent) = match activity {
            Activity::Received => ("reactions.add", "eyes", "already_reacted"),
            Activity::Thinking => ("reactions.add", "thought_balloon", "already_reacted"),
            Activity::Idle => ("reactions.remove", "thought_balloon", "no_reaction"),
        };
        let result = self.api.call::<Value>(method, json!({
            "channel": target.route.channel_id, "timestamp": target.message_id, "name": reaction,
        })).await;
        match result {
            Ok(_) => Ok(()),
            Err(error) if error.is_code(idempotent) => Ok(()),
            Err(error) => Err(error.into()),
        }
    }

    pub(super) async fn download(
        &self,
        route: Route,
        attachment: Attachment,
    ) -> Result<Response, EffectError> {
        self.destination(&route).await?;
        if !file_id(&attachment.id)
            || attachment.url != format!("slack-file:{}", attachment.id)
            || attachment.size > (1_u64 << 53) - 1
        {
            return Err(EffectError::rejected(
                "Slack attachment reference is not an authorized file ID",
            ));
        }
        let result: Value = self
            .api
            .call("files.info", json!({ "file": attachment.id }))
            .await?;
        let file = &result["file"];
        if file["id"] != attachment.id
            || file["user"] != self.owner
            || file["mode"] != "hosted"
            || file["is_external"] != false
            || file["file_access"] == "check_file_info"
            || !same_optional(file, "team_id", &self.team)
        {
            return Err(EffectError::rejected(
                "Slack file is not an owned hosted workspace attachment",
            ));
        }
        let shares = &file["shares"];
        if !["public", "private"]
            .into_iter()
            .flat_map(|kind| {
                shares[kind][&route.channel_id]
                    .as_array()
                    .into_iter()
                    .flatten()
            })
            .any(|share| {
                share["team_id"] == self.team
                    && share["ts"].as_str().and_then(Ts::parse).is_some_and(|ts| {
                        match &route.thread_id {
                            Some(root) => share["thread_ts"] == root.as_str() || &ts == root,
                            None => share
                                .get("thread_ts")
                                .is_none_or(|thread| thread == ts.as_str()),
                        }
                    })
            })
        {
            return Err(EffectError::rejected(
                "Slack file has no authoritative share in the original destination",
            ));
        }
        let path = format!("/files-pri/{}-{}/", self.team, attachment.id);
        let url = file
            .get("url_private_download")
            .filter(|value| !value.is_null())
            .unwrap_or(&file["url_private"]);
        let url = url
            .as_str()
            .and_then(|raw| authorized_file_url(raw, &path, true))
            .ok_or_else(|| {
                EffectError::rejected(
                    "Slack private file URL is not on the allowed workspace/file path",
                )
            })?;
        let response = self
            .api
            .private_download(url)
            .timeout(Duration::from_secs(60))
            .send()
            .await
            .map_err(|_| EffectError::rejected("Slack private attachment download failed"))?;
        if response.status().is_redirection() {
            return Err(EffectError::rejected(
                "Slack private attachment download failed",
            ));
        }
        Ok(response)
    }
}

fn authorized_file_url(raw: &str, path: &str, reject_encoded_path: bool) -> Option<Url> {
    let url = Url::parse(raw).ok()?;
    let accepted_path = url.path().starts_with(path)
        && (!reject_encoded_path || {
            let path = url.path().to_ascii_lowercase();
            !["%2f", "%5c", "%2e"]
                .iter()
                .any(|sequence| path.contains(sequence))
        });
    (secure_url(&url, "https")
        && url.host_str() == Some("files.slack.com")
        && url.fragment().is_none()
        && accepted_path)
        .then_some(url)
}

#[cfg(test)]
#[path = "media_tests.rs"]
mod tests;
