use reqwest::multipart::{Form, Part};
use serde::Deserialize;
use serde_json::json;

use crate::{
    adapter::EffectError,
    picker::Picker,
    telegram::{
        Core,
        model::{Identity, Route, hash},
        view::View,
    },
};

use super::{TEXT_LIMIT, topic_payload};

const UPLOAD_LIMIT: usize = 50 * 1024 * 1024;

#[derive(Deserialize)]
pub(super) struct Output<'a> {
    id: &'a str,
    route: Route,
    text: &'a str,
    picker: Option<Picker>,
}

impl Core {
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
            let mut body = Form::new()
                .text("chat_id", route.channel_id.clone())
                .text("caption", "Full output is attached.")
                .text("allow_paid_broadcast", "false")
                .part("document", document);
            if let Some(thread) = &route.thread_id {
                body = body.text("message_thread_id", thread.clone());
            }
            self.api.send_document(body).await?
        };
        self.receipt(me, route, &message)
    }
}
