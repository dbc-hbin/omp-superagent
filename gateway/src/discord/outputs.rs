use std::time::Duration;

use reqwest::{Method, RequestBuilder, Response, Url, multipart};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::time::{Instant, timeout_at};

use crate::picker::Picker;
use crate::result_attachment::ResultAttachment;

use super::picker::components as picker_components;
use super::rest::{FILE_LIMIT, Rest, broken, no_mentions};
use super::{
    Effect, EffectError, State, markdown,
    model::{RemoteAttachment, RemoteMessage, Route, hash, snowflake, utf16},
};

const MESSAGE_LIMIT: usize = 2_000;
/// More parts than this are sent as one text attachment instead.
const MESSAGE_PARTS: usize = 5;
// Leave time to persist and return the receipt before the head's 30 s IPC timeout.
const OUTPUT_SEND_BUDGET: Duration = Duration::from_secs(25);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Output {
    id: String,
    route: Route,
    text: String,
    reply_to: Option<MessageReference>,
    picker: Option<Picker>,
    result_attachment: Option<ResultAttachment>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct MessageReference {
    route: Route,
    message_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum Activity {
    Received,
    Thinking,
    Idle,
}

#[derive(Deserialize)]
pub(super) struct Attachment {
    id: String,
    url: String,
    size: u64,
}

pub(super) fn nonce(id: &str, route: &Route, part: usize) -> String {
    hash(&json!([id, route.key(), part]))
}

pub(super) fn attachment_url(value: &str) -> Option<Url> {
    let url = Url::parse(value).ok()?;
    if url.scheme() != "https"
        || !matches!(
            url.host_str(),
            Some("cdn.discordapp.com" | "media.discordapp.net")
        )
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
        || url.path().to_ascii_lowercase().contains("%2f")
        || url.path().to_ascii_lowercase().contains("%5c")
    {
        return None;
    }
    let path = url.path_segments()?.collect::<Vec<_>>();
    matches!(path.as_slice(), ["attachments", channel, id, name]
        if snowflake(channel) && snowflake(id) && !name.is_empty())
    .then_some(url)
}

pub(super) struct Payload {
    pub body: Value,
    file: Option<(String, Vec<u8>)>,
}

impl Payload {
    fn text(content: String) -> Self {
        Self {
            body: json!({ "content": content, "allowed_mentions": no_mentions() }),
            file: None,
        }
    }

    /// One payload per Discord message, in order: up to `parts` text messages,
    /// or one text attachment named after `nonce` when the text needs more.
    fn split(text: &str, nonce: &str, parts: usize) -> Effect<Vec<Self>> {
        let rendered = markdown::render(text, FILE_LIMIT);
        if rendered.len() > FILE_LIMIT {
            return Err(EffectError::rejected(
                "Discord text attachment exceeds the safe 8 MiB upload limit",
            ));
        }
        if rendered.is_empty() {
            return Ok(vec![Self::text("(empty output)".to_owned())]);
        }
        if utf16(&rendered) <= MESSAGE_LIMIT {
            return Ok(vec![Self::text(rendered.into_owned())]);
        }
        if let Some(chunks) = markdown::split(&rendered, MESSAGE_LIMIT, parts) {
            return Ok(chunks.into_iter().map(Self::text).collect());
        }
        let name = format!("omp-{nonce}.txt");
        Ok(vec![Self::attachment(
            "Full text is attached (exceeds Discord's message limit).",
            name,
            rendered.into_owned().into_bytes(),
        )])
    }

    fn attachment(content: &str, name: String, bytes: Vec<u8>) -> Self {
        let mut payload = Self::text(content.to_owned());
        payload.body["attachments"] = json!([{ "id": 0, "filename": name }]);
        payload.file = Some((name, bytes));
        payload
    }

    pub fn new(text: &str, nonce: &str, components: Option<Value>) -> Effect<Self> {
        let mut payload = Self::split(text, nonce, 1)?.remove(0);
        if let Some(components) = components {
            payload.body["components"] = components;
        }
        Ok(payload)
    }

    pub fn create(&mut self, nonce: &str) {
        self.body["nonce"] = json!(nonce);
        self.body["enforce_nonce"] = json!(true);
    }

    pub fn edit(&mut self) {
        if self.file.is_none() {
            self.body["attachments"] = json!([]);
        }
    }

    pub fn apply(self, request: RequestBuilder) -> RequestBuilder {
        match self.file {
            None => request.json(&self.body),
            Some((name, bytes)) => request.multipart(
                multipart::Form::new()
                    .text("payload_json", self.body.to_string())
                    .part(
                        "files[0]",
                        multipart::Part::bytes(bytes).file_name(name),
                    ),
            ),
        }
    }
}

impl State {
    pub(super) async fn send(&self, output: &Output) -> Effect<String> {
        let deadline = Instant::now() + OUTPUT_SEND_BUDGET;
        if let Some(reply) = &output.reply_to
            && (!snowflake(&reply.message_id) || reply.route.physical() != output.route.physical())
        {
            return Err(EffectError::rejected(
                "Discord reply requires a real message in the exact destination conversation",
            ));
        }
        let attachment = if let Some(file) = &output.result_attachment {
            if output.route.authority_id != self.config.owner_id || output.picker.is_some() || !output.text.is_empty() {
                return Err(EffectError::rejected("Discord result attachments require owner authority and a standalone file"));
            }
            Some((file, file.bytes()?))
        } else {
            None
        };
        let not_started =
            || EffectError::rejected("Discord output deadline expired before sending");
        let channel = timeout_at(deadline, self.destination(&output.route))
            .await
            .map_err(|_| not_started())??;
        let first_nonce = nonce(&output.id, &output.route, 0);
        if let Some((file, bytes)) = attachment {
            #[derive(Deserialize)]
            struct Receipt {
                #[serde(flatten)]
                message: RemoteMessage,
                attachments: Vec<RemoteAttachment>,
            }
            let size = bytes.len();
            let mut payload = Payload::attachment("", file.name.clone(), bytes);
            payload.create(&first_nonce);
            if let Some(reply) = &output.reply_to {
                payload.body["message_reference"] =
                    json!({"message_id": reply.message_id, "fail_if_not_exists": false});
            }
            let request = payload.apply(self.rest.request(
                Method::POST, &format!("channels/{}/messages", channel.id),
            ));
            if Instant::now() >= deadline {
                return Err(not_started());
            }
            let sent: Receipt = Rest::response_before(request, deadline).await?;
            if !sent.message.belongs(&output.route) || !snowflake(&sent.message.id)
                || !matches!(sent.attachments.as_slice(), [item] if snowflake(&item.id)
                    && item.filename == file.name && usize::try_from(item.size) == Ok(size)) {
                return Err(broken("Discord result attachment receipt could not be verified"));
            }
            return Ok(sent.message.id);
        }
        let _delivery = match &output.picker {
            Some(_) => Some(self.ctx.pickers.delivery().await),
            None => None,
        };
        let opening = match &output.picker {
            Some(spec) => self.ctx.pickers.open(&output.id, json!(output.route), &output.text, spec)?,
            None => None,
        };
        let payloads = match &opening {
            Some(card) => vec![Payload::new(
                &card.menu.text, &first_nonce, Some(picker_components(&card.menu)),
            )?],
            None => Payload::split(&output.text, &first_nonce, MESSAGE_PARTS)?,
        };
        let mut sent_ids = Vec::with_capacity(payloads.len());
        for (part, mut payload) in payloads.into_iter().enumerate() {
            payload.create(&nonce(&output.id, &output.route, part));
            if part == 0
                && let Some(reply) = &output.reply_to
            {
                payload.body["message_reference"] =
                    json!({"message_id": reply.message_id, "fail_if_not_exists": false});
            }
            let request = payload.apply(
                self.rest
                    .request(Method::POST, &format!("channels/{}/messages", channel.id)),
            );
            if Instant::now() >= deadline {
                return Err(if !sent_ids.is_empty() {
                    broken("Discord output deadline expired after partial delivery")
                } else {
                    not_started()
                });
            }
            let sent = match Rest::response_before::<RemoteMessage>(request, deadline).await {
                Ok(sent)
                    if sent.belongs(&output.route)
                        && snowflake(&sent.id)
                        && !sent_ids.contains(&sent.id) =>
                {
                    sent
                }
                Ok(_) => {
                    return Err(broken(
                        "Discord message receipt identity could not be verified",
                    ));
                }
                // Earlier parts are already visible: never report a definite
                // rejection that would invite sending the whole output again.
                Err(_) if !sent_ids.is_empty() => {
                    return Err(broken("Discord delivered only part of a split message"));
                }
                Err(error) => return Err(error),
            };
            if let Some(card) = &opening {
                let mut controls = sent.components.iter().flat_map(|row| &row.components)
                    .filter_map(|component| component.custom_id.as_deref());
                if controls.next() != Some(card.menu.select_id.as_str())
                    || !controls.eq(card.menu.buttons.iter().map(|item| item.control.as_str()))
                {
                    // Discord can return an older message for an enforced nonce.
                    // Do not register controls that were not actually posted.
                    return Err(broken("Discord picker send did not confirm these controls"));
                }
            }
            sent_ids.push(sent.id);
        }
        let mut sent_ids = sent_ids.into_iter();
        let first = sent_ids
            .next()
            .ok_or_else(|| broken("Discord message was not sent"))?;
        if let Some(card) = opening {
            self.ctx.pickers.posted(card, first.clone())?;
        }
        // Later receipts only identify an output after the entire split is verified.
        if !sent_ids.as_slice().is_empty() {
            let keys = sent_ids.map(|id| format!("discord:output-part:{id}"));
            self.ctx
                .insert_meta_if_absent(keys, &output.id)
                .map_err(|_| broken("Discord output part receipts could not be saved"))?;
        }
        Ok(first)
    }

    pub(super) async fn activity(
        &self,
        source: &MessageReference,
        activity: Activity,
    ) -> Effect<()> {
        if !snowflake(&source.message_id) {
            return Err(EffectError::rejected(
                "Activity requires a Discord message snowflake",
            ));
        }
        let channel = self.destination(&source.route).await?;
        let (method, emoji) = match activity {
            Activity::Received => (Method::PUT, "%F0%9F%91%80"),
            Activity::Thinking => (Method::PUT, "%F0%9F%92%AD"),
            Activity::Idle => (Method::DELETE, "%F0%9F%92%AD"),
        };
        Rest::empty(self.rest.request(
            method,
            &format!(
                "channels/{}/messages/{}/reactions/{emoji}/@me",
                channel.id, source.message_id
            ),
        ))
        .await
    }

    pub(super) async fn download(&self, route: &Route, file: &Attachment) -> Effect<Response> {
        self.assert_route(route)?;
        let url = attachment_url(&file.url).ok_or_else(|| {
            EffectError::rejected("Attachment is not an authorized Discord CDN attachment")
        })?;
        let mut segments = url.path_segments().into_iter().flatten().skip(1);
        if file.size > 9_007_199_254_740_991
            || segments.next() != Some(route.destination())
            || segments.next() != Some(file.id.as_str())
        {
            return Err(EffectError::rejected(
                "Discord attachment does not belong to this destination and resource",
            ));
        }
        self.destination(route).await?;
        let response = self
            .rest
            .client
            .get(url)
            .timeout(Duration::from_secs(60))
            .send()
            .await
            .map_err(|_| EffectError::rejected("Discord attachment download failed"))?;
        if !response.status().is_success() {
            return Err(EffectError::rejected(
                "Discord attachment download was rejected",
            ));
        }
        Ok(response)
    }
}
