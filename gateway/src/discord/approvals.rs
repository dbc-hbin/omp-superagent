use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use reqwest::Method;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::{Mutex, RwLock};

use crate::adapter::approval_token;

use super::model::{RemoteMessage, Route, snowflake};
use super::outputs::{OUTPUT_SEND_BUDGET, nonce};
use super::rest::{Lookup, Rest, broken, no_mentions};
use super::{Effect, EffectError, State, cards, dialogs::Dialog};

#[derive(Default)]
pub(super) struct Cards {
    pub pending: RwLock<HashMap<String, Arc<Mutex<Pending>>>>,
    operations: Mutex<()>,
}

impl Cards {
    pub async fn clear(&self) {
        let _operation = self.operations.lock().await;
        let cards = std::mem::take(&mut *self.pending.write().await);
        for pending in cards.into_values() {
            pending.lock().await.active = false;
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Approval {
    pub id: String,
    target: String,
    generation: u64,
    request_id: String,
    pub route: Route,
    request: Value,
    state: String,
    remote_id: Option<String>,
    pub decision: Option<Value>,
    pub owner_context: Option<String>,
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
pub(super) struct Draft {
    pub question: usize,
    pub answers: Vec<Value>,
    pub selected: Vec<String>,
    pub custom_input: Option<String>,
}

pub(super) struct Pending {
    pub approval: Approval,
    pub token: String,
    pub dialog: Dialog,
    pub message_id: String,
    pub active: bool,
    pub page: Option<usize>,
    pub draft: Draft,
}

pub(super) fn valid_card(remote: &RemoteMessage, route: &Route, id: &str, token: &str) -> bool {
    remote.id == id
        && remote.belongs(route)
        && remote
            .components
            .iter()
            .flat_map(|row| &row.components)
            .filter_map(|component| component.custom_id.as_deref())
            .all(|custom| cards::split_control(custom).is_some_and(|(actual, _)| actual == token))
}

fn remote_path(route: &Route, id: &str) -> Effect<String> {
    if !snowflake(id) {
        return Err(EffectError::rejected("Invalid Discord approval card ID"));
    }
    Ok(format!("channels/{}/messages/{id}", route.destination()))
}

impl State {
    pub(super) async fn show_approval(&self, approval: Approval) -> Effect<String> {
        self.assert_route(&approval.route)?;
        if approval.state != "pending" {
            return Err(EffectError::rejected(
                "Discord approval is no longer pending",
            ));
        }
        let token = approval.token();
        let _operation = self.cards.operations.lock().await;
        let matches: Vec<_> = self.cards.pending.read().await.values().cloned().collect();
        for card in matches {
            let mut pending = card.lock().await;
            if pending.approval.id != approval.id {
                continue;
            }
            if pending.token == token && pending.active {
                if approval
                    .remote_id
                    .as_ref()
                    .is_some_and(|id| id != &pending.message_id)
                {
                    return Err(EffectError::rejected(
                        "Discord approval receipt does not match its active control",
                    ));
                }
                return Ok(pending.message_id.clone());
            }
            pending.active = false;
            self.clear_approval_card(&pending.approval.route, &pending.message_id, &pending.token)
                .await?;
            self.cards.pending.write().await.remove(&pending.token);
        }
        let has_answer = self
            .ctx
            .has_pending_answer(&approval.id, &json!(approval.route))
            .map_err(|_| broken("Discord approval recovery state is unavailable"))?;
        if has_answer {
            let id = approval.remote_id.as_deref().ok_or_else(|| {
                EffectError::rejected("Discord approval already has a durable answer")
            })?;
            self.clear_approval_card(&approval.route, id, &token)
                .await?;
            return Ok(id.to_owned());
        }
        let dialog = match Dialog::parse(&approval.request) {
            Ok(dialog) => dialog,
            Err(reason) => {
                let delivery_id = nonce(&format!("approval-cancel:{token}"), &approval.route, 0);
                let notice = format!("Request cancelled: {reason}");
                let card = self
                    .write_card(
                        &approval.route,
                        approval.remote_id.as_deref(),
                        &token,
                        &notice, json!([]),
                        &delivery_id,
                    )
                    .await?;
                self.ctx
                    .cancel_unsupported_approval(&approval.id, &json!(approval.route))
                    .map_err(|_| {
                        broken("Discord unsupported approval cancellation could not be confirmed")
                    })?;
                return Ok(card);
            }
        };
        let remote = approval.remote_id.clone();
        let mut pending = Pending {
            approval,
            token,
            dialog,
            message_id: String::new(),
            active: false,
            page: None,
            draft: Draft::default(),
        };
        let delivery_id = nonce(
            &format!("approval:{}", pending.token),
            &pending.approval.route,
            0,
        );
        let (text, controls) =
            cards::view(&pending).ok_or_else(|| broken("Discord approval view is unavailable"))?;
        let message = self
            .write_card(
                &pending.approval.route,
                remote.as_deref(),
                &pending.token,
                &text, controls,
                &delivery_id,
            )
            .await?;
        pending.message_id = message.clone();
        pending.active = true;
        self.cards
            .pending
            .write()
            .await
            .insert(pending.token.clone(), Arc::new(Mutex::new(pending)));
        Ok(message)
    }

    async fn write_card(
        &self,
        route: &Route,
        remote: Option<&str>,
        token: &str,
        text: &str,
        controls: Value,
        nonce: &str,
    ) -> Effect<String> {
        let channel = self.destination(route).await?;
        let mut payload = self.control_payload(
            route, text, nonce, controls, tokio::time::Instant::now() + OUTPUT_SEND_BUDGET,
        ).await?;
        if let Some(id) = remote {
            let path = remote_path(route, id)?;
            let message: RemoteMessage = self.rest.get(&path).await?;
            if !valid_card(&message, route, id, token) {
                return Err(EffectError::rejected(
                    "Discord approval message does not belong to this bot, identity and destination",
                ));
            }
            payload.edit();
            let result: RemoteMessage =
                Rest::response(payload.apply(self.rest.request(Method::PATCH, &path))).await?;
            if !valid_card(&result, route, id, token) {
                return Err(broken(
                    "Discord edited approval card identity could not be verified",
                ));
            }
            return Ok(id.to_owned());
        }
        payload.create(nonce);
        let message: RemoteMessage = Rest::response(
            payload.apply(
                self.rest
                    .request(Method::POST, &format!("channels/{}/messages", channel.id)),
            ),
        )
        .await?;
        if !snowflake(&message.id) || !valid_card(&message, route, &message.id, token) {
            return Err(broken(
                "Discord approval receipt identity could not be verified",
            ));
        }
        Ok(message.id)
    }

    pub(super) async fn refresh_card(&self, pending: &Pending) -> Effect<()> {
        let (text, controls) =
            cards::view(pending).ok_or_else(|| broken("Discord approval view is unavailable"))?;
        let nonce = nonce(
            &format!("approval:{}", pending.token),
            &pending.approval.route,
            0,
        );
        self.write_card(
            &pending.approval.route,
            Some(&pending.message_id),
            &pending.token,
            &text, controls,
            &nonce,
        )
        .await
        .map(|_| ())
    }

    pub(super) async fn clear_approval_card(
        &self,
        route: &Route,
        id: &str,
        token: &str,
    ) -> Effect<()> {
        self.assert_route(route)?;
        let found = self.channel(route, false).await;
        match found {
            Err(error) if error.certainty != "rejected" => return Err(error),
            Ok(channel) => {
                channel.sendable()?;
            }
            // The exact authorized route may already have been deleted; the
            // sufficiently scoped message lookup below distinguishes that case.
            Err(_) => {
                let endpoint = format!("channels/{}", route.destination());
                return match self.rest.lookup::<super::Channel>(&endpoint).await? {
                    Lookup::Missing => Ok(()),
                    Lookup::Found(_) => Err(EffectError::rejected(
                        "Discord approval destination could not be verified",
                    )),
                };
            }
        }
        let path = remote_path(route, id)?;
        match self.rest.lookup::<RemoteMessage>(&path).await? {
            Lookup::Missing => Ok(()),
            Lookup::Found(remote) => {
                if !valid_card(&remote, route, id, token) {
                    return Err(EffectError::rejected(
                        "Discord approval message does not belong to its original card",
                    ));
                }
                if remote.components.is_empty() {
                    return Ok(());
                }
                Rest::empty(
                    self.rest
                        .request(Method::PATCH, &path)
                        .json(&json!({ "components": [], "allowed_mentions": no_mentions() })),
                )
                .await
            }
        }
    }

    pub(super) async fn dismiss_approval(&self, approval: &Approval) -> Effect<()> {
        self.assert_route(&approval.route)?;
        let _operation = self.cards.operations.lock().await;
        let token = approval.token();
        let mut ids: HashSet<_> = approval.remote_id.iter().cloned().collect();
        let card = self.cards.pending.read().await.get(&token).cloned();
        if let Some(card) = card {
            let mut pending = card.lock().await;
            pending.active = false;
            ids.insert(pending.message_id.clone());
        }
        for id in ids {
            self.clear_approval_card(&approval.route, &id, &token)
                .await?;
        }
        self.cards.pending.write().await.remove(&token);
        Ok(())
    }
}
