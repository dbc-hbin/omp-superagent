use std::collections::HashSet;

use serde::Deserialize;
use serde_json::{Value, json};

use crate::picker::PREFIX;

use super::dialogs::{Dialog, PAGE, Question};
use super::model::{ComponentRow, Interaction, utf16};
use super::rest::broken;
use super::{
    Effect, EffectError, State,
    approvals::{Draft, Pending, valid_card},
    cards,
};

#[derive(Deserialize)]
pub(super) struct Callback {
    pub custom_id: String,
    pub component_type: Option<u8>,
    #[serde(default)]
    pub values: Vec<String>,
    #[serde(default)]
    components: Vec<ComponentRow>,
}

enum Action {
    Reply(Value),
    ShowModal(Value),
    Page(usize),
    Choices(Vec<String>),
    Custom(Option<String>),
    Next(Value),
}

fn invalid() -> EffectError {
    EffectError::rejected("Discord control action does not match the original question")
}

fn index(value: &str) -> Option<usize> {
    if value.is_empty()
        || (value.len() > 1 && value.starts_with('0'))
        || !value.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    value.parse().ok()
}

impl Callback {
    fn text(&self) -> Effect<String> {
        let mut fields = self
            .components
            .iter()
            .flat_map(|row| &row.components)
            .filter(|field| field.custom_id.as_deref() == Some("value"));
        let text = fields
            .next()
            .and_then(|field| field.value.as_ref())
            .ok_or_else(invalid)?;
        if fields.next().is_some() || utf16(text) > 4000 {
            return Err(invalid());
        }
        Ok(text.clone())
    }
}

fn selected_labels(question: &Question, values: &[String]) -> Effect<Vec<String>> {
    if (!question.multi.unwrap_or_default() && values.len() > 1)
        || values.iter().collect::<HashSet<_>>().len() != values.len()
    {
        return Err(invalid());
    }
    values
        .iter()
        .map(|value| {
            index(value)
                .and_then(|position| question.options.get(position))
                .map(|option| option.label.clone())
                .ok_or_else(invalid)
        })
        .collect()
}

fn answer(question: &Question, draft: &Draft, decision: bool) -> Effect<Value> {
    if decision
        && !question.multi.unwrap_or_default()
        && (draft.selected.len() + usize::from(draft.custom_input.is_some()) != 1)
    {
        return Err(invalid());
    }
    let mut value = json!({ "id": question.id, "selectedOptions": draft.selected });
    if let Some(input) = &draft.custom_input {
        value["customInput"] = json!(input);
    }
    Ok(value)
}

fn requested(pending: &Pending, action: &str, callback: &Callback, kind: u8) -> Effect<Action> {
    let button = kind == 3 && callback.component_type == Some(2);
    let menu = kind == 3 && callback.component_type == Some(3);
    let modal = kind == 5;
    if button && action == "cancel" {
        return Ok(Action::Reply(json!({"cancelled": true})));
    }
    match &pending.dialog {
        Dialog::Confirm { .. } => {
            if button && matches!(action, "yes" | "no") {
                return Ok(Action::Reply(json!({"confirmed": action == "yes"})));
            }
        }
        Dialog::Input(_) | Dialog::Editor(_) => {
            if button && action == "open" {
                return cards::modal(pending, "value")
                    .map(Action::ShowModal)
                    .ok_or_else(invalid);
            }
            if modal && action == "value" {
                return Ok(Action::Reply(json!({"value": callback.text()?})));
            }
        }
        Dialog::Select(select) => {
            if button
                && let Some(page) = action.strip_prefix("page-").and_then(index)
                && page < select.options.len().div_ceil(PAGE)
            {
                return Ok(Action::Page(page));
            }
            if menu && (action == "select" || action.starts_with("select-")) {
                let Some(page) = (if action == "select" {
                    Some(0)
                } else {
                    action.strip_prefix("select-").and_then(index)
                }) else {
                    return Err(invalid());
                };
                let [value] = callback.values.as_slice() else {
                    return Err(invalid());
                };
                let position = index(value)
                    .filter(|position| position / PAGE == page)
                    .ok_or_else(invalid)?;
                let label = select.options.get(position).ok_or_else(invalid)?;
                return Ok(Action::Reply(json!({"value": label})));
            }
        }
        Dialog::Ask { questions } => {
            let current = pending.draft.question;
            let question = questions.get(current).ok_or_else(invalid)?;
            if button && action == format!("other-{current}") {
                return cards::modal(pending, &format!("custom-{current}"))
                    .map(Action::ShowModal)
                    .ok_or_else(invalid);
            }
            if menu && action == format!("choose-{current}") {
                return selected_labels(question, &callback.values).map(Action::Choices);
            }
            if modal && action == format!("custom-{current}") {
                let text = callback.text()?;
                return Ok(Action::Custom(
                    (!text.trim().is_empty()).then(|| text.trim().to_owned()),
                ));
            }
            if button && action == format!("next-{current}") {
                let answer = answer(
                    question,
                    &pending.draft,
                    pending.approval.decision.is_some(),
                )?;
                return if current + 1 == questions.len() {
                    let mut answers = pending.draft.answers.clone();
                    answers.push(answer);
                    Ok(Action::Reply(json!({"answers": answers})))
                } else {
                    Ok(Action::Next(answer))
                };
            }
        }
    }
    Err(invalid())
}

impl State {
    pub(super) async fn interaction(&self, raw: Value, ready: bool) -> Effect<()> {
        let Ok(interaction) = serde_json::from_value::<Interaction>(raw) else {
            return Ok(());
        };
        if interaction.kind == 2 {
            if interaction
                .data
                .as_ref()
                .is_some_and(|data| data["type"] == 1)
            {
                return self.command_interaction(&interaction, ready).await;
            }
            return Ok(());
        }
        if !matches!(interaction.kind, 3 | 5)
            || !self
                .identity
                .get()
                .is_some_and(|id| id.application == interaction.application_id)
        {
            return Ok(());
        }
        let Some(data) = interaction.data.as_ref() else {
            return Ok(());
        };
        let Ok(callback) = serde_json::from_value::<Callback>(data.clone()) else {
            return Ok(());
        };
        if callback.custom_id.starts_with(PREFIX) {
            return self.picker_interaction(&interaction, &callback, ready).await;
        }
        let Some((token, action)) = cards::split_control(&callback.custom_id) else {
            return Ok(());
        };
        if interaction
            .user()
            .is_none_or(|user| user.id != self.config.owner_id || user.bot)
        {
            return self
                .rest
                .ephemeral(
                    &interaction,
                    "Only the configured owner can answer this request.",
                )
                .await;
        }
        // Restore the exact original card before considering owner responses.
        if !ready {
            self.ctx
                .ready()
                .await
                .map_err(|_| broken("Discord approval startup gate remains closed"))?;
        }
        let card = self.cards.pending.read().await.get(token).cloned();
        let Some(card) = card else {
            return self
                .rest
                .ephemeral(
                    &interaction,
                    "This request is expired or already being handled.",
                )
                .await;
        };
        let Ok(mut pending) = card.try_lock() else {
            return self
                .rest
                .ephemeral(
                    &interaction,
                    "This request is expired or already being handled.",
                )
                .await;
        };
        if !pending.active {
            return self
                .rest
                .ephemeral(
                    &interaction,
                    "This request is expired or already being handled.",
                )
                .await;
        }
        let route = &pending.approval.route;
        if interaction.guild_id != route.guild_id
            || interaction.channel_id() != Some(route.destination())
            || !interaction
                .message
                .as_ref()
                .is_some_and(|source| valid_card(source, route, &pending.message_id, token))
        {
            return self
                .rest
                .ephemeral(
                    &interaction,
                    "This control does not belong to this destination or request.",
                )
                .await;
        }
        self.destination(route).await?;
        let response =
            match requested(&pending, action, &callback, interaction.kind) {
                Ok(response) => response,
                Err(_) => return self
                    .rest
                    .ephemeral(
                        &interaction,
                        "This action does not match the current question; nothing was submitted.",
                    )
                    .await,
            };
        match response {
            Action::Reply(response) => {
                // Freeze only after the answer (or its deduped receipt) is durable.
                self.answer(&pending.approval.id, &pending.approval.route, response)?;
                pending.active = false;
                let acknowledge = self.rest.callback(&interaction, json!({"type": 6})).await;
                let cleanup = self
                    .clear_approval_card(
                        &pending.approval.route,
                        &pending.message_id,
                        &pending.token,
                    )
                    .await;
                acknowledge.and(cleanup)
            }
            Action::ShowModal(body) => self.rest.callback(&interaction, body).await,
            other => {
                // Intermediate UI progress is not a native answer or an ingress event.
                self.rest.callback(&interaction, json!({"type": 6})).await?;
                let single = match &pending.dialog {
                    Dialog::Ask { questions } => questions
                        .get(pending.draft.question)
                        .is_some_and(|q| !q.multi.unwrap_or_default()),
                    Dialog::Confirm { .. }
                    | Dialog::Input(_)
                    | Dialog::Editor(_)
                    | Dialog::Select(_) => false,
                };
                match other {
                    Action::Page(page) => pending.page = Some(page),
                    Action::Choices(labels) => {
                        pending.draft.selected = labels;
                        if single && !pending.draft.selected.is_empty() {
                            pending.draft.custom_input = None;
                        }
                    }
                    Action::Custom(text) => {
                        pending.draft.custom_input = text;
                        if single && pending.draft.custom_input.is_some() {
                            pending.draft.selected.clear();
                        }
                    }
                    Action::Next(answer) => {
                        pending.draft.answers.push(answer);
                        pending.draft.question += 1;
                        pending.draft.selected.clear();
                        pending.draft.custom_input = None;
                    }
                    Action::Reply(_) | Action::ShowModal(_) => return Err(invalid()),
                }
                self.refresh_card(&pending).await
            }
        }
    }
}
