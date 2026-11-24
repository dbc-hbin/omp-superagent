mod dialog;
mod interaction;
mod presentation;
mod remote;

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::adapter::{EffectError, approval_token};

use self::dialog::{Answer, Dialog, Response};
use super::Inner;
use super::wire::{Route, Ts};

const UNSUPPORTED: &str = "Request cancelled: this dialog cannot be represented safely in Slack. Use the local OMP interface; secret input is never collected here.";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Approval {
    id: String,
    target: String,
    generation: u64,
    request_id: String,
    route: Route,
    request: Value,
    state: ApprovalState,
    remote_id: Option<Ts>,
    decision: Option<Decision>,
    owner_context: Option<String>,
}

#[derive(Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ApprovalState {
    Pending,
    Answered,
    Cancelled,
}

#[derive(Deserialize)]
struct Decision {
    id: String,
}

impl Approval {
    fn token(&self) -> String {
        approval_token(
            &self.id,
            self.generation,
            &self.target,
            &self.request_id,
            &self.route.key(),
        )
    }
}

#[derive(Default)]
pub(super) struct Cards {
    registry: Mutex<Registry>,
}

type Slot = Arc<Mutex<Option<Pending>>>;

#[derive(Default)]
struct Registry {
    approvals: HashMap<String, Slot>,
    tokens: HashMap<String, Slot>,
}

impl Cards {
    async fn slot(&self, id: &str) -> Slot {
        let mut registry = self.registry.lock().await;
        // Unlinked empty slots remain only while another effect has claimed them.
        registry.approvals.retain(|_, slot| {
            Arc::strong_count(slot) > 1 || slot.try_lock().map_or(true, |pending| pending.is_some())
        });
        registry.approvals.entry(id.to_owned()).or_default().clone()
    }

    async fn lookup(&self, token: &str) -> Option<Slot> {
        self.registry.lock().await.tokens.get(token).cloned()
    }

    async fn register(&self, token: &str, slot: Slot) {
        self.registry
            .lock()
            .await
            .tokens
            .insert(token.to_owned(), slot);
    }

    async fn unregister(&self, token: &str) {
        self.registry.lock().await.tokens.remove(token);
    }

    pub(super) async fn clear(&self) {
        *self.registry.lock().await = Registry::default();
    }
}

struct Pending {
    approval: Approval,
    token: String,
    dialog: Dialog,
    message: Option<Ts>,
    active: bool,
    claimed: Option<Claim>,
    receipts: HashSet<String>,
    question: usize,
    answers: Vec<Answer>,
    selected: Vec<String>,
    custom_input: Option<String>,
    modal: Option<Modal>,
}

struct Modal {
    id: String,
    metadata: String,
    action: String,
}

enum Claim {
    Failed(String),
    Admitted(Closure),
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Closure {
    Closed,
    Submitted,
    Cancelled,
}

impl Closure {
    fn control(self) -> &'static str {
        match self {
            Self::Closed => "status-closed",
            Self::Submitted => "status-submitted",
            Self::Cancelled => "status-cancelled",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Closed => "Request closed.",
            Self::Submitted => "Answers submitted.",
            Self::Cancelled => "Request cancelled.",
        }
    }
}

impl Pending {
    fn new(approval: Approval, token: String, dialog: Dialog) -> Self {
        Self {
            message: approval.remote_id.clone(),
            approval,
            token,
            dialog,
            active: false,
            claimed: None,
            question: 0,
            receipts: HashSet::new(),
            answers: Vec::new(),
            selected: Vec::new(),
            custom_input: None,
            modal: None,
        }
    }
}

impl Inner {
    pub(super) async fn show_card(&self, approval: Approval) -> Result<String, EffectError> {
        self.destination(&approval.route).await?;
        if approval.state != ApprovalState::Pending {
            return Err(EffectError::rejected(
                "Slack approval is not pending on a started adapter",
            ));
        }
        let token = approval.token();
        let slot = self.cards.slot(&approval.id).await;
        let mut entry = slot.lock().await;
        if let Some(pending) = entry.as_mut() {
            if pending.token == token {
                if let Some(ts) = pending.message.as_ref() {
                    if approval
                        .remote_id
                        .as_ref()
                        .is_some_and(|remote| remote != ts)
                    {
                        return Err(EffectError::rejected(
                            "Slack approval receipt does not match its original card",
                        ));
                    }
                    return Ok(ts.as_str().to_owned());
                }
            } else {
                // HEAD derives the ID from target, generation and native request.
                // An inconsistent reuse must not close the legitimate active card.
                return Err(EffectError::rejected(
                    "Slack approval identity does not match its original card",
                ));
            }
        }
        let id = approval.id.clone();
        let route = json!(approval.route);
        let queued = self
            .ledger(move |context| context.has_pending_answer(&id, &route))
            .await?;
        if queued {
            let receipt = approval.remote_id.clone().ok_or_else(|| {
                EffectError::rejected("Slack queued answer has no original approval card receipt")
            })?;
            let pending = Pending::new(approval, token, fallback_dialog());
            let message = self
                .history_message(&pending.approval.route, &receipt)
                .await?;
            self.assert_card(&message, &pending).await?;
            return Ok(receipt.as_str().to_owned());
        }
        let dialog = Dialog::parse(&approval.request).and_then(|dialog| {
            if let Some(decision) = &approval.decision {
                let valid = matches!(&dialog, Dialog::Ask { questions } if questions.iter().enumerate()
                    .all(|(index, question)| question.id == format!("{}:{index}", decision.id)));
                if !valid {
                    return Err(EffectError::rejected("Slack decision does not match its original questions"));
                }
            }
            Ok(dialog)
        });
        let (dialog, supported) = match dialog {
            Ok(dialog) => (dialog, true),
            Err(_) => (fallback_dialog(), false),
        };
        let mut pending = Pending::new(approval, token, dialog);
        let initial = pending.view(None);
        if !supported || initial.is_err() {
            if let Some(receipt) = &pending.message {
                pending.dialog = fallback_dialog();
                if self.update_card(&pending, Some(Closure::Closed)).await? {
                    self.cancel_unsupported(&pending).await?;
                }
                return Ok(receipt.as_str().to_owned());
            }
            let notice = json!({ "type": "section", "block_id": pending.control("card"), "text": super::media::plain(UNSUPPORTED) });
            let receipt = self
                .post(&pending.approval.route, UNSUPPORTED, Some(vec![notice]))
                .await?;
            self.cancel_unsupported(&pending).await?;
            return Ok(receipt.as_str().to_owned());
        }
        let initial = initial?;
        let receipt = if let Some(ts) = &pending.message {
            pending.active = self.update_card(&pending, None).await?;
            ts.clone()
        } else {
            let ts = self
                .post(&pending.approval.route, &initial.text, Some(initial.blocks))
                .await?;
            pending.message = Some(ts.clone());
            pending.active = true;
            ts
        };
        if pending.active {
            self.cards.register(&pending.token, slot.clone()).await;
            *entry = Some(pending);
        }
        Ok(receipt.as_str().to_owned())
    }

    async fn cancel_unsupported(&self, pending: &Pending) -> Result<(), EffectError> {
        let id = pending.approval.id.clone();
        let route = json!(pending.approval.route);
        self.ledger(move |context| context.cancel_unsupported_approval(&id, &route))
            .await?;
        Ok(())
    }

    pub(super) async fn dismiss_card(&self, approval: Approval) -> Result<(), EffectError> {
        self.assert_route(&approval.route).await?;
        let token = approval.token();
        let slot = self.cards.slot(&approval.id).await;
        let mut entry = slot.lock().await;
        if let Some(pending) = entry.as_mut().filter(|pending| pending.token == token) {
            if approval
                .remote_id
                .as_ref()
                .is_some_and(|remote| pending.message.as_ref() != Some(remote))
            {
                return Err(EffectError::rejected(
                    "Slack approval receipt does not match its original card",
                ));
            }
            let closure = match pending.claimed {
                Some(Claim::Admitted(closure)) => closure,
                Some(Claim::Failed(_)) | None => Closure::Closed,
            };
            self.close_card(pending, closure).await?;
            self.cards.unregister(&token).await;
            *entry = None;
        } else if approval.remote_id.is_some() {
            let dialog = Dialog::parse(&approval.request).unwrap_or_else(|_| fallback_dialog());
            let mut original = Pending::new(approval, token, dialog);
            self.close_card(&mut original, Closure::Closed).await?;
        }
        Ok(())
    }
}

fn fallback_dialog() -> Dialog {
    Dialog::Confirm {
        title: "Request cancelled".into(),
        message: UNSUPPORTED.into(),
    }
}
