use std::time::Duration;

use reqwest::{Method, RequestBuilder, Response, Url, multipart};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::time::{Instant, timeout_at};

use crate::picker::Picker;
use crate::result_attachment::VerifiedResultAttachment;

use super::picker::components as picker_components;
use super::rest::{FILE_LIMIT, Rest, broken, no_mentions};
use super::{
    Effect, EffectError, State, embeds, markdown,
    model::{RemoteAttachment, RemoteMessage, Route, hash, snowflake, utf16},
};

const MESSAGE_LIMIT: usize = 2_000;
/// More parts than this are sent as one text attachment instead.
const MESSAGE_PARTS: usize = 5;
// Leave time to persist and return the receipt before the head's 30 s IPC timeout.
pub(super) const OUTPUT_SEND_BUDGET: Duration = Duration::from_secs(25);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Output {
    id: String,
    route: Route,
    text: String,
    reply_to: Option<MessageReference>,
    /// A durable status message this output replaces in place.
    edit_of: Option<MessageReference>,
    /// Initial status message; falls back to one attachment instead of splitting.
    #[serde(default)]
    status: bool,
    picker: Option<Picker>,
}

impl Output {
    fn validate_reply(&self) -> Effect<()> {
        if let Some(reply) = &self.reply_to
            && (!snowflake(&reply.message_id) || reply.route.physical() != self.route.physical())
        {
            return Err(EffectError::rejected(
                "Discord reply requires a real message in the exact destination conversation",
            ));
        }
        Ok(())
    }
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
    /// Valid ```card fences become embeds on the last payload.
    fn split(text: &str, cards: Vec<Value>, nonce: &str, parts: usize) -> Effect<Vec<Self>> {
        let rendered = markdown::render(text, FILE_LIMIT);
        if rendered.text.len() > FILE_LIMIT {
            return Err(EffectError::rejected(
                "Discord text attachment exceeds the safe 8 MiB upload limit",
            ));
        }
        let mut payloads = if rendered.text.is_empty() {
            vec![Self::text(if cards.is_empty() { "(empty output)".to_owned() } else { String::new() })]
        } else if utf16(&rendered.text) <= MESSAGE_LIMIT {
            vec![Self::text(rendered.text.into_owned())]
        } else if let Some(chunks) = markdown::split(&rendered, MESSAGE_LIMIT, parts) {
            chunks.into_iter().map(Self::text).collect()
        } else {
            let name = format!("omp-{nonce}.txt");
            vec![Self::attachment(
                "Full text is attached (exceeds Discord's message limit).",
                name,
                rendered.text.into_owned().into_bytes(),
            )]
        };
        if !cards.is_empty()
            && let Some(last) = payloads.last_mut()
        {
            last.body["embeds"] = Value::Array(cards);
        }
        Ok(payloads)
    }

    fn attachment(content: &str, name: String, bytes: Vec<u8>) -> Self {
        let mut payload = Self::text(content.to_owned());
        payload.body["attachments"] = json!([{ "id": 0, "filename": name }]);
        payload.file = Some((name, bytes));
        payload
    }

    pub fn create(&mut self, nonce: &str) {
        self.body["nonce"] = json!(nonce);
        self.body["enforce_nonce"] = json!(true);
    }

    pub fn edit(&mut self) {
        if self.file.is_none() {
            self.body["attachments"] = json!([]);
        }
        // An edit replaces the whole message: drop embeds the new text lacks.
        if self.body.get("embeds").is_none() {
            self.body["embeds"] = json!([]);
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
    async fn output_payloads(
        &self, route: &Route, text: &str, nonce: &str, parts: usize, deadline: Instant,
    ) -> Effect<Vec<Payload>> {
        let (content, cards) = embeds::extract(text);
        if !cards.is_empty() && route.guild_id.is_some() {
            // Thread permissions come from its parent. Unverified permission keeps
            // the original text; never try a second post after an external send.
            let permission = async {
                let parent = self.channel_by_id(&route.channel_id, true).await?;
                if parent.guild_id != route.guild_id || parent.is_thread() { return Ok(false); }
                self.permissions(&parent).await.map(|bits| super::permissions::has(bits, super::permissions::EMBED_LINKS))
            };
            // Reserve time for the text send even if permission lookup stalls.
            let lookup_budget = deadline.saturating_duration_since(Instant::now()) / 2;
            if !matches!(tokio::time::timeout(lookup_budget, permission).await, Ok(Ok(true))) {
                return Payload::split(text, Vec::new(), nonce, parts);
            }
        }
        Payload::split(&content, cards, nonce, parts)
    }

    pub(super) async fn control_payload(
        &self, route: &Route, text: &str, nonce: &str, components: Value, deadline: Instant,
    ) -> Effect<Payload> {
        let mut payload = self.output_payloads(route, text, nonce, 1, deadline).await?.remove(0);
        payload.body["components"] = components;
        Ok(payload)
    }

    pub(super) async fn send_result_attachment(&self, output: &Output, file: VerifiedResultAttachment) -> Effect<String> {
        let deadline = Instant::now() + OUTPUT_SEND_BUDGET;
        if output.route.authority_id != self.config.owner_id || output.picker.is_some()
            || output.status || output.edit_of.is_some() || !output.text.is_empty()
        {
            return Err(EffectError::rejected("Discord result attachments require owner authority and a standalone file"));
        }
        output.validate_reply()?;
        let not_started = || EffectError::rejected("Discord output deadline expired before sending");
        let channel = timeout_at(deadline, self.destination(&output.route))
            .await
            .map_err(|_| not_started())??;
        #[derive(Deserialize)]
        struct Receipt {
            #[serde(flatten)]
            message: RemoteMessage,
            attachments: Vec<RemoteAttachment>,
        }
        let size = file.bytes.len();
        let mut payload = Payload::attachment("", file.name.clone(), file.bytes);
        payload.create(&nonce(&output.id, &output.route, 0));
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
        Ok(sent.message.id)
    }

    pub(super) async fn send(&self, output: &Output) -> Effect<String> {
        let deadline = Instant::now() + OUTPUT_SEND_BUDGET;
        if let Some(target) = &output.edit_of {
            return self.edit_status(output, target, deadline).await;
        }
        if output.status && output.picker.is_some() {
            return Err(EffectError::rejected(
                "Discord status requires a plain message",
            ));
        }
        output.validate_reply()?;
        let not_started =
            || EffectError::rejected("Discord output deadline expired before sending");
        let channel = timeout_at(deadline, self.destination(&output.route))
            .await
            .map_err(|_| not_started())??;
        let first_nonce = nonce(&output.id, &output.route, 0);
        let _delivery = match &output.picker {
            Some(_) => Some(self.ctx.pickers.delivery().await),
            None => None,
        };
        let opening = match &output.picker {
            Some(spec) => self.ctx.pickers.open(&output.id, json!(output.route), &output.text, spec)?,
            None => None,
        };
        let payloads = match &opening {
            Some(card) => vec![self.control_payload(
                &output.route, &card.menu.text, &first_nonce, picker_components(&card.menu), deadline,
            ).await?],
            None => self.output_payloads(
                &output.route, &output.text, &first_nonce,
                if output.status { 1 } else { MESSAGE_PARTS }, deadline,
            ).await?,
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

    /// Replace a status message in place. A rejected edit fails this output;
    /// it is never turned into a new post, and an ambiguous edit stays uncertain.
    async fn edit_status(
        &self,
        output: &Output,
        target: &MessageReference,
        deadline: Instant,
    ) -> Effect<String> {
        if !snowflake(&target.message_id)
            || target.route.physical() != output.route.physical()
            || output.picker.is_some()
        {
            return Err(EffectError::rejected(
                "Discord status edit requires a plain message in the exact destination conversation",
            ));
        }
        let not_started =
            || EffectError::rejected("Discord output deadline expired before sending");
        let channel = timeout_at(deadline, self.destination(&output.route))
            .await
            .map_err(|_| not_started())??;
        let mut payload = self.output_payloads(
            &output.route, &output.text, &nonce(&output.id, &output.route, 0), 1, deadline,
        ).await?.remove(0);
        payload.edit();
        let request = payload.apply(self.rest.request(
            Method::PATCH,
            &format!("channels/{}/messages/{}", channel.id, target.message_id),
        ));
        if Instant::now() >= deadline {
            return Err(not_started());
        }
        let edited: RemoteMessage = Rest::response_before(request, deadline).await?;
        if !edited.belongs(&output.route) || edited.id != target.message_id {
            return Err(broken("Discord status edit receipt could not be verified"));
        }
        Ok(edited.id)
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
