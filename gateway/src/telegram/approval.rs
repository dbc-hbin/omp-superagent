use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::adapter::{EffectError, approval_token};

use super::{
    Core,
    api::ApiError,
    dialog::{Answer, Dialog},
    effects::topic_payload,
    ingress::Message,
    model::{Identity, Route, hash},
    view::{Renderer, View},
};

pub(super) type Cards = HashMap<String, Pending>;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Approval {
    pub id: String,
    target: String,
    generation: u64,
    request_id: String,
    pub route: Route,
    pub request: Value,
    pub state: String,
    #[serde(deserialize_with = "Option::deserialize")]
    pub remote_id: Option<String>,
    pub decision: Option<Value>,
    pub owner_context: Option<String>,
}

impl Approval {
    pub fn token(&self) -> String {
        approval_token(
            &self.id,
            self.generation,
            &self.target,
            &self.request_id,
            &self.route.key(),
        )
    }

    pub fn request_hash(&self) -> String {
        hash(&self.request.to_string())
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Progress {
    pub message_id: Option<String>,
    pub attempted: bool,
    pub active: bool,
    pub question: usize,
    pub answers: Vec<Answer>,
    pub selected: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub custom_input: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_update: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub answer_request: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binding: Option<AnswerBinding>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub answer_admitted: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub ack_attempted: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub notice: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub presenting: bool,
}

const fn is_false(value: &bool) -> bool {
    !*value
}

impl Default for Progress {
    fn default() -> Self {
        Self {
            message_id: None,
            attempted: false,
            active: true,
            question: 0,
            answers: Vec::new(),
            selected: Vec::new(),
            custom_input: None,
            last_update: None,
            answer_request: None,
            binding: None,
            answer_admitted: false,
            ack_attempted: false,
            notice: false,
            presenting: false,
        }
    }
}

impl Progress {
    pub fn close(&mut self) {
        self.active = false;
        self.question = 0;
        self.answers.clear();
        self.selected.clear();
        self.custom_input = None;
    }

    pub fn valid_for(&self, dialog: &Dialog) -> bool {
        match dialog {
            Dialog::Ask { questions } => questions.get(self.question).is_some_and(|question| {
                self.answers.len() == self.question
                    && self
                        .answers
                        .iter()
                        .zip(questions)
                        .all(|(answer, question)| answer.id == question.id)
                    && self
                        .selected
                        .iter()
                        .all(|label| question.options.iter().any(|choice| &choice.label == label))
                    && (question.multi || self.selected.len() <= 1)
            }),
            Dialog::Confirm { .. } | Dialog::Select(_) | Dialog::Input(_) | Dialog::Editor(_) => {
                self.question == 0
                    && self.answers.is_empty()
                    && self.selected.is_empty()
                    && self.custom_input.is_none()
            }
        }
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AnswerBinding {
    pub approval_id: String,
    pub route: Route,
    pub response_hash: String,
}

pub(super) struct Pending {
    pub approval: Approval,
    pub token: String,
    pub dialog: Dialog,
    pub stamp: String,
    pub progress: Progress,
}

impl Pending {
    pub fn renderer(&self) -> Renderer<'_> {
        Renderer {
            token: &self.token,
            stamp: &self.stamp,
            owner_context: self.approval.owner_context.as_deref(),
        }
    }

    pub fn matches_controls(&self, message: &Message) -> bool {
        message.reply_markup.as_ref().is_some_and(|markup| {
            let prefix = format!("omp:{}:", self.token);
            let mut buttons = markup.inline_keyboard.iter().flatten().peekable();
            buttons.peek().is_some()
                && buttons.all(|button| {
                    button
                        .callback_data
                        .as_deref()
                        .is_some_and(|data| data.starts_with(&prefix))
                })
        })
    }

    pub fn matches_presentation(&self, message: &Message) -> bool {
        message
            .text
            .as_deref()
            .is_some_and(|text| text.ends_with(&format!("\n\nOMP card {}", self.stamp)))
            && self.matches_controls(message)
    }

    pub fn matches_card(&self, core: &Core, me: &Identity, message: &Message) -> bool {
        message.date != 0
            && core
                .receipt(me, &self.approval.route, message)
                .is_ok_and(|id| self.progress.message_id.as_ref() == Some(&id))
            && self.matches_controls(message)
    }

    pub fn save(&self, core: &Core) -> Result<(), EffectError> {
        core.save_progress(&self.approval.route.account_id, &self.token, &self.progress)
    }
}

pub(super) fn card_key(route: &Route, message_id: &str) -> String {
    let key = hash(&json!([route.physical_key(), message_id]).to_string());
    format!("telegram:{}:card:{key}", route.account_id)
}

impl Core {
    pub(super) fn progress(&self, bot: &str, token: &str) -> Result<Option<Progress>, EffectError> {
        self.get(&format!("telegram:{bot}:approval:{token}"))?
            .map(|raw| {
                serde_json::from_str(&raw)
                    .map_err(|_| EffectError::uncertain("Telegram approval progress is invalid"))
            })
            .transpose()
    }

    pub(super) fn save_progress(
        &self,
        bot: &str,
        token: &str,
        progress: &Progress,
    ) -> Result<(), EffectError> {
        let data = serde_json::to_string(progress).map_err(|_| {
            EffectError::uncertain("Telegram approval progress could not be serialized")
        })?;
        self.set(&format!("telegram:{bot}:approval:{token}"), &data)
    }

    pub(super) fn has_pending_answer(&self, id: &str, route: &Route) -> Result<bool, EffectError> {
        self.ctx
            .has_pending_answer(id, &json!(route))
            .map_err(|_| super::ledger_error())
    }

    pub(super) fn has_bound_answer(&self, binding: &AnswerBinding) -> Result<bool, EffectError> {
        self.ctx
            .has_durable_answer(
                &binding.approval_id,
                &json!(binding.route),
                &binding.response_hash,
            )
            .map_err(|_| super::ledger_error())
    }

    pub(super) async fn write_card(
        &self,
        route: &Route,
        id: Option<u64>,
        view: &View,
    ) -> Result<Message, ApiError> {
        let (method, mut body) = if let Some(id) = id {
            (
                "editMessageText",
                json!({"chat_id":route.channel_id,"message_id":id}),
            )
        } else {
            let mut body = topic_payload(route);
            body["allow_paid_broadcast"] = json!(false);
            ("sendMessage", body)
        };
        body["text"] = json!(view.text);
        body["reply_markup"] = json!(view.keyboard);
        body["link_preview_options"] = json!({"is_disabled":true});
        self.api.call(method, &body).await
    }

    pub(super) async fn clear_controls(
        &self,
        route: &Route,
        receipt: &str,
    ) -> Result<(), EffectError> {
        let id = super::effects::message_id(receipt)?;
        match self
            .api
            .call::<Value>(
                "editMessageReplyMarkup",
                &json!({
                    "chat_id":route.channel_id,"message_id":id,"reply_markup":{"inline_keyboard":[]}
                }),
            )
            .await
        {
            Ok(_) => Ok(()),
            Err(error) if error.unchanged() || error.missing() => Ok(()),
            Err(error) => Err(error.into()),
        }
    }
}
