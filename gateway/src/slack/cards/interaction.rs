use serde_json::{Value, json};

use crate::adapter::EffectError;
use crate::picker::PREFIX;

use super::super::Inner;
use super::super::picker::picker_key;
use super::super::socket::Ack;
use super::super::wire::{Ts, same_optional};
use super::dialog::{modal_input, selection};
use super::{Answer, Claim, Closure, Dialog, Pending, Response};

enum Callback<'a> {
    Block(&'a Value),
    Submit(&'a Value),
    Close(&'a Value),
}

enum Step {
    Ignore,
    CloseModal,
    OpenModal(String),
    Refresh,
    Finish(Response),
}

impl<'a> Callback<'a> {
    fn parse(body: &'a Value) -> Option<Self> {
        match body["type"].as_str()? {
            "block_actions" => {
                let [action] = body["actions"].as_array()?.as_slice() else {
                    return None;
                };
                action.is_object().then_some(Self::Block(action))
            }
            "view_submission" => body["view"]
                .is_object()
                .then_some(Self::Submit(&body["view"])),
            "view_closed" => body["view"]
                .is_object()
                .then_some(Self::Close(&body["view"])),
            _ => None,
        }
    }

    fn control(&self) -> Option<&'a str> {
        match self {
            Self::Block(action) => action["action_id"].as_str(),
            Self::Submit(view) | Self::Close(view) => view["callback_id"].as_str(),
        }
    }

    fn identity(&self, control: &str, envelope: &str) -> String {
        match self {
            Self::Block(action) => action["action_ts"]
                .as_str()
                .and_then(Ts::parse)
                .map_or_else(
                    || format!("envelope:{envelope}"),
                    |ts| format!("action:{control}:{}", ts.as_str()),
                ),
            Self::Submit(view) => format!("view:view_submission:{}", view["id"]),
            Self::Close(view) => format!("view:view_closed:{}", view["id"]),
        }
    }
}

impl Inner {
    pub(in crate::slack) async fn interaction_key(&self, body: &Value) -> Option<String> {
        let callback = Callback::parse(body)?;
        let control = callback.control()?;
        if matches!(callback, Callback::Block(_)) && control.starts_with(PREFIX) {
            return picker_key(body);
        }
        let (token, _) = parse_control(control)?;
        self.cards.lookup(token).await.map(|_| token.to_owned())
    }

    pub(in crate::slack) async fn interact(
        &self,
        body: &Value,
        ack: Ack,
    ) -> Result<(), EffectError> {
        let identity = self.identity().await?;
        if body["team"]["id"] != self.team
            || body["user"]["id"] != self.owner
            || !same_optional(&body["user"], "team_id", &self.team)
            || !same_optional(body, "api_app_id", &identity.app_id)
            || !same_optional(body, "app_id", &identity.app_id)
            || body["channel"]["id"].as_str().is_some_and(|channel| {
                self.ctx.group_room(Some(&self.team), channel).is_some()
            })
        {
            return ack.send(None).await;
        }
        let Some(callback) = Callback::parse(body) else {
            return ack.send(None).await;
        };
        let Some(control) = callback.control() else {
            return ack.send(None).await;
        };
        if let Callback::Block(action) = callback
            && control.starts_with(PREFIX)
        {
            return self.interact_picker(&identity, body, action, ack).await;
        }
        let Some((token, action)) = parse_control(control) else {
            return ack.send(None).await;
        };
        let Some(slot) = self.cards.lookup(token).await else {
            return ack.send(None).await;
        };
        let mut pending_slot = slot.lock().await;
        let Some(pending) = pending_slot
            .as_mut()
            .filter(|pending| pending.token == token)
        else {
            return ack.send(None).await;
        };
        let route = &pending.approval.route;
        if self.ctx.group_room(route.guild_id.as_deref(), &route.channel_id).is_some() {
            return ack.send(None).await;
        }
        let identity = callback.identity(control, &ack.id);
        if matches!(&pending.claimed, Some(Claim::Failed(original)) if original == &identity) {
            return Err(EffectError::uncertain(
                "Slack original answer admission remains unresolved",
            ));
        }
        if !pending.active
            || pending.receipts.contains(&identity)
            || !self.linked_callback(pending, &callback, body, action).await
        {
            return ack.send(None).await;
        }
        self.assert_route(&pending.approval.route).await?;
        let step = pending.step(callback, action)?;
        if !matches!(step, Step::Ignore | Step::Finish(_)) {
            pending.receipts.insert(identity.clone());
        }
        match step {
            Step::Ignore => ack.send(None).await,
            Step::CloseModal => {
                pending.modal = None;
                ack.send(None).await
            }
            Step::OpenModal(action) => {
                ack.send(None).await?;
                self.open_modal(pending, &action, &body["trigger_id"]).await
            }
            Step::Refresh => {
                ack.send(None).await?;
                self.update_card(pending, None).await?;
                Ok(())
            }
            Step::Finish(response) => {
                let result = self.finish_card(pending, identity, response).await;
                if result.is_ok() {
                    self.cards.unregister(token).await;
                    *pending_slot = None;
                    ack.send(None).await?;
                }
                result
            }
        }
    }

    async fn linked_callback(
        &self,
        pending: &Pending,
        callback: &Callback<'_>,
        body: &Value,
        action: &str,
    ) -> bool {
        match callback {
            Callback::Submit(view) | Callback::Close(view) => {
                pending.modal.as_ref().is_some_and(|modal| {
                    view["id"] == modal.id
                        && view["private_metadata"] == modal.metadata
                        && action == modal.action
                })
            }
            Callback::Block(value) => {
                let Some(ts) = pending.message.as_ref() else {
                    return false;
                };
                let channel = &pending.approval.route.channel_id;
                let container = &body["container"];
                let expected = pending.action_type(action);
                container["type"] == "message"
                    && container["channel_id"] == *channel
                    && container["message_ts"] == ts.as_str()
                    && body["channel"]["id"] == *channel
                    && value["type"] == expected
                    && self.assert_card(&body["message"], pending).await.is_ok()
            }
        }
    }

    async fn finish_card(
        &self,
        pending: &mut Pending,
        identity: String,
        response: Response,
    ) -> Result<(), EffectError> {
        let closure = match (&pending.dialog, &response) {
            (Dialog::Ask { .. }, Response::Cancelled { .. }) => Closure::Cancelled,
            (Dialog::Ask { .. }, Response::Answers { .. }) => Closure::Submitted,
            _ => Closure::Closed,
        };
        pending.active = false;
        pending.modal = None;
        let event = json!({
            "kind": "answer", "approvalId": pending.approval.id, "response": response, "route": pending.approval.route,
        });
        if self.admit(event).await.is_err() {
            // Do not turn an ambiguous admission into success or a different answer.
            pending.claimed = Some(Claim::Failed(identity));
            self.close_card(pending, Closure::Closed).await?;
            return Err(EffectError::uncertain("Slack answer admission failed"));
        }
        pending.claimed = Some(Claim::Admitted(closure));
        self.close_card(pending, closure).await
    }
}

fn parse_control(control: &str) -> Option<(&str, &str)> {
    let (token, action) = control.strip_prefix("omp:")?.split_once(':')?;
    let (name, suffix) = action
        .split_once('-')
        .map_or((action, None), |(name, index)| (name, Some(index)));
    (token.len() == 24
        && token
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        && !name.is_empty()
        && name.bytes().all(|byte| byte.is_ascii_lowercase())
        && suffix.is_none_or(|index| {
            !index.is_empty() && index.bytes().all(|byte| byte.is_ascii_digit())
        }))
    .then_some((token, action))
}

impl Pending {
    fn action_type(&self, action: &str) -> &'static str {
        if action == "select" {
            return "static_select";
        }
        if action.starts_with("choose-") {
            if let Dialog::Ask { questions } = &self.dialog
                && questions
                    .get(self.question)
                    .is_some_and(|question| question.multi)
            {
                return "multi_static_select";
            }
            return "static_select";
        }
        "button"
    }

    fn step(&mut self, callback: Callback<'_>, action: &str) -> Result<Step, EffectError> {
        match (&self.dialog, callback, action) {
            (_, Callback::Close(_), _) => Ok(Step::CloseModal),
            (_, Callback::Block(_), "cancel") => Ok(Step::Finish(Response::CANCELLED)),
            (Dialog::Confirm { .. }, Callback::Block(_), "yes" | "no") => {
                Ok(Step::Finish(Response::Confirmed {
                    confirmed: action == "yes",
                }))
            }
            (Dialog::Select(select), Callback::Block(value), "select") => {
                let options = selection(
                    value,
                    select.options.iter().map(String::as_str).collect(),
                    false,
                )?;
                let [value] = options.as_slice() else {
                    return Err(EffectError::rejected(
                        "Slack select requires one original option",
                    ));
                };
                Ok(Step::Finish(Response::Value {
                    value: value.clone(),
                }))
            }
            (Dialog::Input(_) | Dialog::Editor(_), Callback::Block(_), "open") => {
                Ok(Step::OpenModal("value".into()))
            }
            (Dialog::Input(_) | Dialog::Editor(_), Callback::Submit(view), "value") => {
                Ok(Step::Finish(Response::Value {
                    value: modal_input(view)?,
                }))
            }
            (Dialog::Ask { .. }, callback, action) => self.ask_step(callback, action),
            (
                Dialog::Confirm { .. } | Dialog::Select(_) | Dialog::Input(_) | Dialog::Editor(_),
                _,
                _,
            ) => Ok(Step::Ignore),
        }
    }

    fn ask_step(&mut self, callback: Callback<'_>, action: &str) -> Result<Step, EffectError> {
        let Dialog::Ask { questions } = &self.dialog else {
            return Err(EffectError::rejected(
                "Slack card does not contain a question",
            ));
        };
        let question = questions
            .get(self.question)
            .ok_or_else(|| EffectError::rejected("Slack card no longer contains this question"))?;
        let Some((name, index)) = action.split_once('-') else {
            return Ok(Step::Ignore);
        };
        if index != self.question.to_string() {
            return Ok(Step::Ignore);
        }
        match (callback, name) {
            (Callback::Block(_), "other") => {
                return Ok(Step::OpenModal(format!("custom-{}", self.question)));
            }
            (Callback::Block(value), "choose") => {
                self.selected = selection(
                    value,
                    question
                        .options
                        .iter()
                        .map(|choice| choice.label.as_str())
                        .collect(),
                    question.multi,
                )?;
                if !question.multi && !self.selected.is_empty() {
                    self.custom_input = None;
                }
            }
            (Callback::Submit(view), "custom") => {
                let value = modal_input(view)?;
                self.custom_input = (!value.is_empty()).then_some(value);
                self.modal = None;
                if !question.multi && self.custom_input.is_some() {
                    self.selected.clear();
                }
            }
            (Callback::Block(_), "next") => {
                let answer = Answer {
                    id: question.id.clone(),
                    selected_options: self.selected.clone(),
                    custom_input: self.custom_input.clone(),
                };
                if self.approval.decision.is_some() {
                    question.validate_answer(&answer)?;
                }
                self.answers.push(answer);
                if self.question + 1 == questions.len() {
                    return Ok(Step::Finish(Response::Answers {
                        answers: std::mem::take(&mut self.answers),
                    }));
                }
                self.question += 1;
                self.selected.clear();
                self.custom_input = None;
                self.modal = None;
            }
            (Callback::Block(_) | Callback::Submit(_) | Callback::Close(_), _) => {
                return Ok(Step::Ignore);
            }
        }
        Ok(Step::Refresh)
    }
}
