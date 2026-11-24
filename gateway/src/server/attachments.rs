use std::{io, time::Duration};

use axum::http::header;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use tokio::{io::AsyncWriteExt, time::timeout};

use super::{
    Hub,
    events::safe_integer,
    protocol::{Fault, WireResult, object, rejected},
};

mod spool;
use spool::Spool;
pub(super) use spool::recover;

const MAX_ATTACHMENT: u64 = 20 * 1024 * 1024;
const MAX_REQUEST: u64 = 40 * 1024 * 1024;
const MAX_ATTACHMENTS: usize = 10;
pub(super) const ATTACHMENT_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    input_id: String,
    route: Value,
    attachments: Vec<Value>,
}

#[derive(Serialize)]
pub(super) struct Receipt {
    receipt: String,
    files: Vec<SpooledFile>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SpooledFile {
    path: std::path::PathBuf,
    size: u64,
    mime_type: &'static str,
    sha256: String,
}

struct Download {
    size: u64,
    mime_type: &'static str,
    digest: [u8; 32],
}

impl Hub {
    pub(super) async fn attachment(
        &self,
        revision: u64,
        data: Map<String, Value>,
    ) -> WireResult<Receipt> {
        let request: Request = serde_json::from_value(Value::Object(data))
            .map_err(|_| rejected("Invalid attachment request"))?;
        if request.input_id.is_empty() || request.attachments.is_empty() {
            return Err(rejected("Invalid attachment request"));
        }
        if request.attachments.len() > MAX_ATTACHMENTS {
            return Err(rejected("Too many attachments"));
        }
        let sizes = request
            .attachments
            .iter()
            .map(attachment_size)
            .collect::<WireResult<Vec<_>>>()?;
        if sizes.iter().flatten().sum::<u64>() > MAX_REQUEST {
            return Err(rejected("Attachment request exceeds the size limit"));
        }

        let mut spool = Spool::new(self.store.state_dir()).map_err(spool_error)?;
        let mut remaining = MAX_REQUEST;
        let mut digest = Sha256::new();
        digest.update(Sha256::digest(request.input_id));
        let mut downloads = Vec::with_capacity(sizes.len());
        for (attachment, size) in request.attachments.iter().zip(sizes) {
            let download = timeout(ATTACHMENT_TIMEOUT, async {
                let upstream = self
                    .adapters
                    .attachment(&request.route, attachment)
                    .await
                    .map_err(Fault::from)?;
                download(upstream, size, remaining, &mut spool).await
            })
            .await
            .map_err(|_| rejected("Attachment download timed out"))??;
            remaining -= download.size;
            digest.update(download.digest);
            downloads.push(download);
        }

        let receipt = hex::encode(digest.finalize());
        let existing = spool
            .check_replay(&receipt, &downloads)
            .await
            .map_err(spool_error)?;
        // Recheck authority at the commit point. There is no await between
        // publishing the batch and returning its receipt to the dispatcher.
        let mut state = self.state()?;
        state.controller(revision)?;
        if let Some(existing) = existing {
            spool
                .verify_replay(&receipt, &existing)
                .map_err(spool_error)?;
        } else {
            spool.publish(&receipt).map_err(spool_error)?;
        }
        let directory = spool.path().join(&receipt);
        let files = downloads
            .into_iter()
            .enumerate()
            .map(|(index, file)| SpooledFile {
                path: directory.join(index.to_string()),
                size: file.size,
                mime_type: file.mime_type,
                sha256: hex::encode(file.digest),
            })
            .collect();
        Ok(Receipt { receipt, files })
    }
}

fn attachment_size(attachment: &Value) -> WireResult<Option<u64>> {
    match object(attachment)?.get("size") {
        Some(Value::Null) => Ok(None),
        Some(value) => safe_integer(value)
            .and_then(|size| u64::try_from(size).ok())
            .filter(|size| *size <= MAX_ATTACHMENT)
            .map(Some)
            .ok_or_else(|| rejected("Invalid attachment size")),
        None => Err(rejected("Invalid attachment size")),
    }
}

async fn download(
    mut upstream: reqwest::Response,
    size: Option<u64>,
    remaining: u64,
    spool: &mut Spool,
) -> WireResult<Download> {
    let status = upstream.status();
    if !status.is_success() {
        return Err(rejected("Attachment download was rejected"));
    }
    if matches!(status.as_u16(), 204 | 205) {
        return Err(rejected("Attachment response has no body"));
    }
    let limit = remaining.min(size.unwrap_or(MAX_ATTACHMENT));
    let length = upstream
        .headers()
        .get(header::CONTENT_LENGTH)
        .map(|length| {
            length
                .to_str()
                .ok()
                .filter(|text| !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit()))
                .and_then(|text| text.parse::<u64>().ok())
                .filter(|length| *length <= limit)
                .ok_or_else(|| rejected("Attachment response exceeds the size limit"))
        })
        .transpose()?;
    let expected = size.or(length);
    if size.zip(length).is_some_and(|(size, length)| size != length) {
        return Err(rejected("Attachment response differs from declared size"));
    }

    let mut file = spool.create_file().map_err(spool_error)?;
    let mut bytes = 0_u64;
    let mut prefix = [0; 12];
    let mut prefix_len = 0;
    let mut digest = Sha256::new();
    while let Some(chunk) = upstream
        .chunk()
        .await
        .map_err(|_| rejected("Attachment transfer interrupted"))?
    {
        let len = u64::try_from(chunk.len()).map_err(|_| rejected("Attachment size overflow"))?;
        bytes = bytes
            .checked_add(len)
            .ok_or_else(|| rejected("Attachment size overflow"))?;
        if bytes > limit {
            return Err(rejected("Attachment stream exceeds the size limit"));
        }
        let count = chunk.len().min(prefix.len() - prefix_len);
        prefix[prefix_len..prefix_len + count].copy_from_slice(&chunk[..count]);
        prefix_len += count;
        digest.update(&chunk);
        file.write_all(&chunk).await.map_err(spool_error)?;
    }
    if expected.is_some_and(|expected| expected != bytes) {
        return Err(rejected("Attachment stream differs from declared size"));
    }
    file.sync_all().await.map_err(spool_error)?;
    Ok(Download {
        size: bytes,
        mime_type: image_mime_type(&prefix[..prefix_len]),
        digest: digest.finalize().into(),
    })
}

fn image_mime_type(prefix: &[u8]) -> &'static str {
    if prefix.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if prefix.starts_with(b"\xff\xd8\xff") {
        "image/jpeg"
    } else if prefix.starts_with(b"GIF87a") || prefix.starts_with(b"GIF89a") {
        "image/gif"
    } else if prefix.starts_with(b"RIFF") && prefix.get(8..12) == Some(b"WEBP") {
        "image/webp"
    } else {
        "application/octet-stream"
    }
}

fn spool_error(error: io::Error) -> Fault {
    Fault::from(anyhow::Error::from(error))
}
