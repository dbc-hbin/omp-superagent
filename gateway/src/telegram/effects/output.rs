use reqwest::multipart::{Form, Part};
use serde::Deserialize;
use serde_json::json;

use crate::{
    adapter::EffectError,
    picker::Picker,
    result_attachment::VerifiedResultAttachment,
    telegram::{
        Core,
        files::Media,
        ingress::Message,
        model::{Identity, Route, hash},
        view::View,
    },
};

use super::{TEXT_LIMIT, topic_payload};

const UPLOAD_LIMIT: usize = 50 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Output<'a> {
    id: &'a str,
    route: Route,
    text: &'a str,
    picker: Option<Picker>,
}

#[derive(Deserialize)]
struct AttachedMessage {
    #[serde(flatten)]
    message: Message,
    document: Media,
}

fn document_form(route: &Route, document: Part) -> Form {
    let mut body = Form::new()
        .text("chat_id", route.channel_id.clone())
        .text("allow_paid_broadcast", "false")
        .part("document", document);
    if let Some(thread) = &route.thread_id {
        body = body.text("message_thread_id", thread.clone());
    }
    body
}

impl Core {
    pub(super) async fn send_result_attachment(
        &self, me: &Identity, output: Output<'_>, file: VerifiedResultAttachment,
    ) -> Result<String, EffectError> {
        if output.picker.is_some() || !output.text.is_empty() {
            return Err(EffectError::rejected("A Telegram result attachment must be a standalone document"));
        }
        let route = &output.route;
        self.destination(me, route).await?;
        let size = file.bytes.len();
        let document = Part::bytes(file.bytes).file_name(file.name.clone());
        let sent: AttachedMessage = self.api.send_document(document_form(route, document)).await?;
        if sent.document.file_name.as_deref() != Some(file.name.as_str())
            || sent.document.file_size.is_some_and(|actual| usize::try_from(actual) != Ok(size))
            || sent.document.file_id.is_empty() {
            return Err(EffectError::uncertain("Telegram result document receipt could not be verified"));
        }
        self.receipt(me, route, &sent.message)
    }

    pub(super) async fn send_output(
        &self,
        me: &Identity,
        output: Output<'_>,
    ) -> Result<String, EffectError> {
        let route = &output.route;
        self.destination(me, route).await?;
        if output.text.len() > UPLOAD_LIMIT {
            return Err(EffectError::rejected(
                "Telegram text document exceeds the 50 MiB upload limit",
            ));
        }
        if let Some(picker) = &output.picker {
            // A click can arrive before sendMessage returns its verified receipt.
            let _delivery = self.ctx.pickers.delivery().await;
            if let Some(opening) =
                self.ctx
                    .pickers
                    .open(output.id, json!(route), output.text, picker)?
            {
                let view = View::from_picker(&opening.menu);
                let message = self.write_card(route, None, &view).await?;
                let receipt = self.receipt(me, route, &message)?;
                self.ctx.pickers.posted(opening, receipt.clone())?;
                return Ok(receipt);
            }
        }
        let message = if output.text.encode_utf16().count() <= TEXT_LIMIT {
            let mut body = topic_payload(route);
            body["text"] = json!(if output.text.is_empty() {
                "(empty output)"
            } else {
                output.text
            });
            body["link_preview_options"] = json!({"is_disabled":true});
            body["allow_paid_broadcast"] = json!(false);
            self.api.call("sendMessage", &body).await?
        } else {
            let document = Part::bytes(output.text.as_bytes().to_vec())
                .file_name(format!("omp-{}.txt", hash(output.id)));
            self.api.send_document(document_form(route, document).text("caption", "Full output is attached.")).await?
        };
        self.receipt(me, route, &message)
    }
}
