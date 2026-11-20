use std::borrow::Cow;
use std::time::Duration;

use reqwest::{Method, RequestBuilder, Response, Url, multipart};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::time;

use super::rest::{FILE_LIMIT, Rest, broken, no_mentions};
use super::{
    Effect, EffectError, State, markdown,
    model::{RemoteMessage, Route, hash, snowflake, utf16},
};

const MESSAGE_LIMIT: usize = 2_000;
/// Past this many messages one text attachment reads better than a channel
/// flood, and the burst would exceed Discord's per-channel send rate limit.
const MAX_CHUNKS: usize = 10;
/// Total wait for a definite 429 between chunks of one output; the head's
/// Gateway effect call times out after 30 s.
const RATE_LIMIT_WAIT: Duration = Duration::from_secs(10);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Output {
    id: String,
    route: Route,
    text: String,
    reply_to: Option<MessageReference>,
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

pub(super) fn nonce(id: &str, route: &Route) -> String {
    chunk_nonce(id, route, 0)
}

fn chunk_nonce(id: &str, route: &Route, index: usize) -> String {
    hash(&json!([id, route.key(), index]))
}

fn rendered(text: &str) -> Effect<Cow<'_, str>> {
    let rendered = markdown::render(text, FILE_LIMIT);
    if rendered.len() > FILE_LIMIT {
        return Err(EffectError::rejected(
            "Discord text attachment exceeds the safe 8 MiB upload limit",
        ));
    }
    Ok(rendered)
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

#[derive(Clone)]
pub(super) struct Payload {
    pub body: Value,
    file: Option<(String, String)>,
}

impl Payload {
    /// One message that may be edited later, so overflow becomes an attachment.
    pub fn new(text: &str, nonce: &str, components: Option<Value>) -> Effect<Self> {
        Ok(Self::build(rendered(text)?, nonce, components))
    }

    /// An ordinary output as ordered messages with per-chunk nonces, or one
    /// attachment when it needs more than `MAX_CHUNKS` messages.
    fn messages(output: &Output) -> Effect<Vec<(String, Self)>> {
        let rendered = rendered(&output.text)?;
        let chunks = if utf16(&rendered) > MESSAGE_LIMIT {
            markdown::split(&rendered, MESSAGE_LIMIT, MAX_CHUNKS)
        } else {
            None
        };
        let Some(chunks) = chunks else {
            let nonce = nonce(&output.id, &output.route);
            let payload = Self::build(rendered, &nonce, None);
            return Ok(vec![(nonce, payload)]);
        };
        Ok(chunks
            .into_iter()
            .enumerate()
            .map(|(index, chunk)| {
                let nonce = chunk_nonce(&output.id, &output.route, index);
                let payload = Self::build(Cow::Owned(chunk), &nonce, None);
                (nonce, payload)
            })
            .collect())
    }

    fn build(rendered: Cow<'_, str>, nonce: &str, components: Option<Value>) -> Self {
        let (content, file) = if utf16(&rendered) > MESSAGE_LIMIT {
            (
                "Full text is attached (exceeds Discord's message limit).".to_owned(),
                Some((format!("omp-{nonce}.txt"), rendered.into_owned())),
            )
        } else if rendered.is_empty() {
            ("(empty output)".to_owned(), None)
        } else {
            (rendered.into_owned(), None)
        };
        let mut body = json!({ "content": content, "allowed_mentions": no_mentions() });
        if let Some(components) = components {
            body["components"] = components;
        }
        if let Some((name, _)) = &file {
            body["attachments"] = json!([{ "id": 0, "filename": name }]);
        }
        Self { body, file }
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
            Some((name, text)) => request.multipart(
                multipart::Form::new()
                    .text("payload_json", self.body.to_string())
                    .part(
                        "files[0]",
                        multipart::Part::bytes(text.into_bytes()).file_name(name),
                    ),
            ),
        }
    }
}

impl State {
    pub(super) async fn send(&self, output: &Output) -> Effect<String> {
        if let Some(reply) = &output.reply_to
            && (!snowflake(&reply.message_id) || reply.route.physical() != output.route.physical())
        {
            return Err(EffectError::rejected(
                "Discord reply requires a real message in the exact destination conversation",
            ));
        }
        let channel = self.destination(&output.route).await?;
        let messages = Payload::messages(output)?;
        let total = messages.len();
        let path = format!("channels/{}/messages", channel.id);
        let mut receipt = None;
        let mut waited = Duration::ZERO;
        for (index, (nonce, mut payload)) in messages.into_iter().enumerate() {
            payload.create(&nonce);
            if index == 0
                && let Some(reply) = &output.reply_to
            {
                payload.body["message_reference"] =
                    json!({"message_id": reply.message_id, "fail_if_not_exists": false});
            }
            let sent = loop {
                let request = self.rest.request(Method::POST, &path);
                let sent = Rest::response::<RemoteMessage>(payload.clone().apply(request)).await;
                // A 429 is a definite rejection, so the same chunk and nonce
                // can be resent once the burst of earlier chunks has drained.
                let delay = match &sent {
                    Err(error) if index > 0 && error.certainty == "rejected" => {
                        error.retry_after_ms.map(Duration::from_millis)
                    }
                    _ => None,
                };
                match delay {
                    Some(delay) if waited + delay <= RATE_LIMIT_WAIT => {
                        waited += delay;
                        time::sleep(delay).await;
                    }
                    _ => break sent,
                }
            };
            let sent = sent.and_then(|sent| {
                if sent.belongs(&output.route) && snowflake(&sent.id) {
                    Ok(sent.id)
                } else {
                    Err(broken(
                        "Discord message receipt identity could not be verified",
                    ))
                }
            });
            match sent {
                // The first message carries the reply and anchors the output.
                Ok(id) => {
                    receipt.get_or_insert(id);
                }
                Err(error) if index == 0 => return Err(error),
                // Earlier chunks are visible, so even a definite rejection
                // of a later one leaves the output partially delivered.
                Err(error) => {
                    return Err(EffectError::uncertain(format!(
                        "Discord delivered {index} of {total} message chunks: {}",
                        error.message
                    )));
                }
            }
        }
        receipt.ok_or_else(|| broken("Discord output produced no message"))
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
