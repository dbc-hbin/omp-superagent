mod output;

use futures_util::FutureExt;
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{adapter::EffectError, store::js_trim};

use super::{
    Core,
    ingress::Message,
    model::{Chat, ChatKind, Identity, Route, SAFE_INTEGER, Sender, decode, positive_id},
};

pub(super) const TEXT_LIMIT: usize = 4096;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Reference {
    route: Route,
    message_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Activity {
    Received,
    Thinking,
    Idle,
}

pub(super) fn message_id(value: &str) -> Result<u64, EffectError> {
    positive_id(value).ok_or_else(|| EffectError::rejected("Invalid Telegram message ID"))
}

pub(super) fn topic_payload(route: &Route) -> Value {
    let mut payload = json!({"chat_id":route.channel_id});
    if let Some(id) = route.thread_id.as_deref().and_then(positive_id) {
        payload["message_thread_id"] = json!(id);
    }
    payload
}

impl Core {
    pub(super) async fn effect(
        &self,
        operation: &str,
        args: &[Value],
    ) -> Result<Value, EffectError> {
        let me = self.identity().await?;
        match (operation, args) {
            ("assertRoute", [route]) | ("fetchAfter", [route, _]) => {
                self.policy.authorize(&me, &decode(route)?)?;
                Ok(Value::Null)
            }
            ("send", [output]) => {
                if output.get("replyTo").is_some() {
                    return Err(EffectError::rejected(
                        "Telegram output does not support Discord reply references",
                    ));
                }
                self.send_output(&me, decode(output)?)
                    .await
                    .map(Value::String)
            }
            ("setActivity", [message, activity]) => {
                self.set_activity(&me, decode(message)?, decode(activity)?)
                    .await?;
                Ok(Value::Null)
            }
            ("showApproval", [approval]) => self
                .show_approval(&me, decode(approval)?)
                .await
                .map(Value::String),
            ("dismissApproval", [approval]) => {
                self.dismiss_approval(&me, decode(approval)?).await?;
                Ok(Value::Null)
            }
            ("canCreateThread", [route]) => self
                .can_create_thread(&me, &decode(route)?)
                .await
                .map(Value::Bool),
            ("createThread", [route, title] | [route, title, _]) => Ok(json!(
                self.create_thread(&me, decode(route)?, decode(title)?)
                    .await?
            )),
            ("canCreateThread", [_, _]) | ("createThread", [_, _, _, _]) => Err(
                EffectError::rejected("Forum tags are only supported on Discord"),
            ),
            ("inspectThread" | "updateThread", _) => Err(EffectError::rejected(
                "Thread management is unsupported on Telegram",
            )),
            _ => Err(EffectError::rejected("Unsupported Telegram effect")),
        }
    }

    pub(super) async fn destination(
        &self,
        me: &Identity,
        route: &Route,
    ) -> Result<Chat, EffectError> {
        self.policy.authorize(me, route)?;
        let key = route.physical_key();
        let (id, pending) = {
            let mut flights = self.destinations.lock().await;
            flights
                .entry(key.clone())
                .or_insert_with(|| {
                    let api = self.api.clone();
                    let body = json!({"chat_id":route.channel_id});
                    let pending = async move { api.call("getChat", &body).await }
                        .boxed()
                        .shared();
                    (Uuid::new_v4(), pending)
                })
                .clone()
        };
        let chat = pending.await;
        {
            let mut flights = self.destinations.lock().await;
            if flights.get(&key).is_some_and(|(current, _)| current == &id) {
                flights.remove(&key);
            }
        }
        let chat = chat?;
        if !self
            .policy
            .route(me, &chat, route.thread_id.as_deref().and_then(positive_id))
            .is_some_and(|actual| actual.same_physical(route))
        {
            return Err(EffectError::rejected("Telegram destination identity changed"));
        }
        Ok(chat)
    }

    pub(super) fn receipt(
        &self,
        me: &Identity,
        route: &Route,
        message: &Message,
    ) -> Result<String, EffectError> {
        if self
            .policy
            .route(me, &message.chat, message.message_thread_id)
            .is_some_and(|actual| actual.same_physical(route))
            && message
                .from
                .is_some_and(|from| from.id == me.id && from.is_bot)
            && (1..=SAFE_INTEGER).contains(&message.message_id)
            && message.date != 0
        {
            return Ok(message.message_id.to_string());
        }
        Err(EffectError::uncertain(
            "Telegram mutation returned an unexpected message identity",
        ))
    }

    async fn set_activity(
        &self,
        me: &Identity,
        source: Reference,
        activity: Activity,
    ) -> Result<(), EffectError> {
        self.policy.authorize(me, &source.route)?;
        let id = message_id(&source.message_id)?;
        // Hub serializes transitions and keeps a new edit's receipt from
        // replacing the current thinking reaction on this physical message.
        let emoji = match activity {
            Activity::Thinking => "🤔",
            Activity::Idle | Activity::Received => "👀",
        };
        self.destination(me, &source.route).await?;
        self.api.call::<bool>("setMessageReaction", &json!({
            "chat_id":source.route.channel_id,"message_id":id,"reaction":[{"type":"emoji","emoji":emoji}]
        })).await?;
        Ok(())
    }

    async fn can_create_thread(&self, me: &Identity, route: &Route) -> Result<bool, EffectError> {
        self.policy.authorize(me, route)?;
        if route.thread_id.is_some() {
            return Ok(false);
        }
        let chat = self.destination(me, route).await?;
        match chat.kind {
            ChatKind::Private => {
                let current = self.api.bot_user().await?;
                if current.id != me.id {
                    return Err(EffectError::rejected("Telegram bot identity changed"));
                }
                let enabled = current.has_topics_enabled;
                *self.identity.write().await = Some(current);
                Ok(enabled)
            }
            ChatKind::Supergroup if chat.is_forum => {
                #[derive(Deserialize)]
                struct Member {
                    user: Sender,
                    status: String,
                    #[serde(default)]
                    can_manage_topics: bool,
                }
                let member: Member = self
                    .api
                    .call(
                        "getChatMember",
                        &json!({
                            "chat_id":route.channel_id,"user_id":me.id
                        }),
                    )
                    .await?;
                if !member.user.is_bot || member.user.id != me.id {
                    return Err(EffectError::rejected(
                        "Telegram topic administrator identity changed",
                    ));
                }
                Ok(member.status == "administrator" && member.can_manage_topics)
            }
            ChatKind::Group | ChatKind::Supergroup | ChatKind::Other => Ok(false),
        }
    }

    async fn create_thread(
        &self,
        me: &Identity,
        mut route: Route,
        title: &str,
    ) -> Result<Route, EffectError> {
        self.policy.authorize(me, &route)?;
        if route.thread_id.is_some() {
            return Err(EffectError::rejected("Telegram cannot nest forum topics"));
        }
        if js_trim(title).is_empty() || title.chars().count() > 128 {
            return Err(EffectError::rejected(
                "Telegram forum topic title must contain 1–128 characters",
            ));
        }
        let chat = self.destination(me, &route).await?;
        let eligible = match chat.kind {
            ChatKind::Private => me.has_topics_enabled,
            ChatKind::Supergroup => chat.is_forum,
            ChatKind::Group | ChatKind::Other => false,
        };
        if !eligible {
            return Err(EffectError::rejected(
                "Telegram destination does not support forum topics",
            ));
        }
        #[derive(Deserialize)]
        struct Topic {
            message_thread_id: u64,
        }
        let topic: Topic = self
            .api
            .call(
                "createForumTopic",
                &json!({
                    "chat_id":route.channel_id,"name":title
                }),
            )
            .await?;
        if !(1..=SAFE_INTEGER).contains(&topic.message_thread_id) {
            return Err(EffectError::uncertain(
                "Telegram created an invalid forum topic identity",
            ));
        }
        route.thread_id = Some(topic.message_thread_id.to_string());
        route.topic_id = None;
        Ok(route)
    }
}
