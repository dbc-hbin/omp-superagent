use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{adapter::EffectError, commands::accepts_text, picker::PREFIX, store::js_trim};

use super::{
    Core,
    files::{Attachment, Media, MediaKind},
    model::{Chat, Identity, Policy, Route, SAFE_INTEGER, Sender},
};

#[derive(Deserialize)]
pub(super) struct Update {
    pub message: Option<Message>,
    pub edited_message: Option<Message>,
    pub callback_query: Option<Callback>,
}

#[derive(Deserialize)]
pub(super) struct Callback {
    pub id: String,
    pub from: Sender,
    pub data: Option<String>,
    pub message: Option<Message>,
}

#[derive(Deserialize)]
pub(super) struct Message {
    pub message_id: u64,
    pub date: u64,
    pub edit_date: Option<u64>,
    pub from: Option<Sender>,
    pub chat: Chat,
    pub message_thread_id: Option<u64>,
    pub text: Option<String>,
    pub caption: Option<String>,
    pub reply_to_message: Option<Box<Message>>,
    pub reply_markup: Option<Markup>,
    quote: Option<Quote>,
    sender_chat: Option<Value>,
    forward_origin: Option<Value>,
    forward_from: Option<Value>,
    forward_sender_name: Option<String>,
    forward_from_chat: Option<Value>,
    #[serde(default)]
    is_automatic_forward: bool,
    via_bot: Option<Value>,
    business_connection_id: Option<String>,
    #[serde(default)]
    entities: Vec<Entity>,
    #[serde(default)]
    caption_entities: Vec<Entity>,
    #[serde(default)]
    photo: Vec<Media>,
    document: Option<Media>,
    audio: Option<Media>,
    video: Option<Media>,
    voice: Option<Media>,
    video_note: Option<Media>,
}

#[derive(Deserialize)]
pub(super) struct Markup {
    pub inline_keyboard: Vec<Vec<RemoteButton>>,
}

#[derive(Deserialize)]
pub(super) struct RemoteButton {
    pub callback_data: Option<String>,
}

#[derive(Deserialize)]
struct Quote {
    text: String,
}

#[derive(Deserialize)]
struct Entity {
    #[serde(rename = "type")]
    kind: String,
    offset: u64,
    length: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Inbound {
    pub id: String,
    pub route: Route,
    message_id: String,
    text: String,
    received_at: u64,
    attachments: Vec<Attachment>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reply: Option<Reply>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Reply {
    message_id: String,
    author_id: Option<String>,
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    quote: Option<String>,
}

pub(super) fn normalize(policy: &Policy, me: &Identity, message: &Message) -> Option<Inbound> {
    if !message.from.is_some_and(|sender| policy.owner(sender))
        || message.sender_chat.is_some()
        || message.forward_origin.is_some()
        || message.forward_from.is_some()
        || message
            .forward_sender_name
            .as_deref()
            .is_some_and(|name| !name.is_empty())
        || message.forward_from_chat.is_some()
        || message.is_automatic_forward
        || message.via_bot.is_some()
        || message
            .business_connection_id
            .as_deref()
            .is_some_and(|id| !id.is_empty())
        || message.message_id == 0
        || message.message_id > SAFE_INTEGER
    {
        return None;
    }
    let route = policy.route(me, &message.chat, message.message_thread_id)?;
    let original = message
        .text
        .as_deref()
        .or(message.caption.as_deref())
        .unwrap_or("");
    let entities = if message.text.is_some() {
        &message.entities
    } else {
        &message.caption_entities
    };
    let text = command(original, entities, me.username.as_deref())?;
    let photo = message.photo.iter().reduce(|largest, candidate| {
        let area = |media: &Media| u128::from(media.width) * u128::from(media.height);
        if area(candidate) > area(largest) {
            candidate
        } else {
            largest
        }
    });
    let attachments: Vec<_> = [
        (photo, MediaKind::Photo),
        (message.document.as_ref(), MediaKind::Document),
        (message.audio.as_ref(), MediaKind::Audio),
        (message.video.as_ref(), MediaKind::Video),
        (message.voice.as_ref(), MediaKind::Voice),
        (message.video_note.as_ref(), MediaKind::VideoNote),
    ]
    .into_iter()
    .filter_map(|(media, kind)| Attachment::from_media(media?, kind))
    .collect();
    if text.is_empty() && attachments.is_empty() {
        return None;
    }
    let revision = match message.edit_date {
        Some(edited) => format!(
            "edit:{edited}:{}",
            Attachment::revision(original, &attachments)
        ),
        None => "original".to_owned(),
    };
    let id = format!(
        "telegram:{}:{}:{}:{revision}",
        route.account_id, route.channel_id, message.message_id
    );
    let received_at = message
        .edit_date
        .unwrap_or(message.date)
        .checked_mul(1000)?;
    if received_at > SAFE_INTEGER {
        return None;
    }
    let reply = message.reply_to_message.as_deref().and_then(|source| {
        let from = policy.route(me, &source.chat, source.message_thread_id)?;
        if source.message_id == 0 || source.message_id > SAFE_INTEGER || !route.same_physical(&from)
        {
            return None;
        }
        Some(Reply {
            message_id: source.message_id.to_string(),
            author_id: (source.date != 0)
                .then_some(source.from)
                .flatten()
                .map(|sender| sender.id.to_string()),
            text: if source.date == 0 {
                None
            } else {
                source.text.clone().or_else(|| source.caption.clone())
            },
            quote: message.quote.as_ref().map(|quote| quote.text.clone()),
        })
    });
    Some(Inbound {
        id,
        route,
        message_id: message.message_id.to_string(),
        text,
        received_at,
        attachments,
        reply,
    })
}

fn command(text: &str, entities: &[Entity], bot: Option<&str>) -> Option<String> {
    let Some(entity) = entities
        .iter()
        .find(|entity| entity.kind == "bot_command" && entity.offset == 0)
    else {
        return Some(text.to_owned());
    };
    // A qualified command is ASCII. The UTF-16 offset is therefore also its
    // byte offset; if it splits multibyte content it cannot be a command.
    let Some(head) = text.get(..entity.length) else {
        return Some(text.to_owned());
    };
    let rest = &text[head.len()..];
    let Some((name, username)) = head.strip_prefix('/').and_then(|head| head.split_once('@'))
    else {
        return Some(text.to_owned());
    };
    let word = |value: &str| {
        !value.is_empty()
            && value
                .bytes()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == b'_')
    };
    if name.len() > 32
        || !word(name)
        || !word(username)
        || rest
            .chars()
            .next()
            .is_some_and(|ch| !js_trim(&rest[..ch.len_utf8()]).is_empty())
    {
        return Some(text.to_owned());
    }
    if !bot.is_some_and(|bot| username.eq_ignore_ascii_case(bot)) {
        return None;
    }
    if accepts_text(name).is_some() {
        return Some(format!("/{name}{rest}"));
    }
    Some(text.to_owned())
}

impl Core {
    pub(super) async fn process(&self, update: Update) -> Result<(), EffectError> {
        let me = self.identity().await?;
        if let Some(callback) = update.callback_query {
            if let Some(control) = callback
                .data
                .as_deref()
                .filter(|data| data.starts_with(PREFIX))
            {
                return self.handle_picker(&me, &callback, control).await;
            }
            return self.handle_callback(&me, &callback).await;
        }
        let Some(message) = update.message.or(update.edited_message) else {
            return Ok(());
        };
        let Some(input) = normalize(&self.policy, &me, &message) else {
            return Ok(());
        };
        if message.reply_to_message.is_some() && self.handle_reply(&me, &message, &input).await? {
            return Ok(());
        }
        for attachment in &input.attachments {
            attachment.save(self, &input.route)?;
        }
        self.admit(json!({"kind":"message","input":input}))
    }
}
