use std::sync::Arc;

use axum::response::Response;
use serde_json::{Map, Value, json};
use tokio::sync::watch;
use uuid::{Uuid, Variant};

use super::{
    Hub,
    protocol::{WireResult, rejected, uncertain},
    transport::OnFinish,
};
use crate::store::js_trim;

pub(super) struct RestartCall {
    input_id: String,
    ack_id: String,
    result: watch::Receiver<Option<AttemptResult>>,
}

#[derive(Clone)]
enum AttemptResult {
    Finished(Value),
    Rejected,
    Uncertain,
}

struct RestartRequest<'a> {
    id: &'a str,
    input_id: &'a str,
    ack_id: &'a str,
}

impl RestartRequest<'_> {
    fn matches(&self, record: &Value) -> bool {
        record["requestId"] == self.id
            && record["inputId"] == self.input_id
            && record["ackOutputId"] == self.ack_id
    }
}

impl Hub {
    pub(super) fn can_restart(&self, revision: u64) -> WireResult<()> {
        let mut state = self.state()?;
        let client = state.controller(revision)?;
        // Native approvals reconcile to the authorized controller, not the
        // lifetime of one NDJSON stream. Quarantine can close that stream
        // while its priority restart is being checkpointed.
        if !self.admission_ready() || !client.reconciled || client.reconciliation.is_some() {
            return Err(rejected("Gateway head is not ready for restart"));
        }
        Ok(())
    }

    pub(super) async fn restart(
        self: &Arc<Self>,
        data: &Map<String, Value>,
        finish: OnFinish,
    ) -> WireResult<Response> {
        let request = parse(data).ok_or_else(|| rejected("Invalid Gateway restart request"))?;
        let result = self.accept_restart(&request).await?;
        let persisted = self
            .store
            .get_restart(Some(request.id))?
            .filter(|persisted| request.matches(persisted) && request.matches(&result))
            .ok_or_else(|| uncertain("Gateway restart acceptance was not persisted"))?;
        let receipt = json!({"ok": true, "value": persisted});
        if receipt["value"]["state"] == "accepted" {
            let hub = self.clone();
            let id = request.id.to_owned();
            return finish.json(&receipt, move || {
                if hub.run_restart(&id).is_err() {
                    eprintln!("Gateway restart execution failed");
                }
            });
        }
        Ok(axum::response::IntoResponse::into_response(axum::Json(
            receipt,
        )))
    }

    async fn accept_restart(self: &Arc<Self>, request: &RestartRequest<'_>) -> WireResult<Value> {
        let mut result = {
            let mut restarts = self
                .restarts
                .lock()
                .map_err(|_| anyhow::anyhow!("Gateway restart lock was poisoned"))?;
            let prior = self.store.get_restart(Some(request.id))?;
            if prior
                .as_ref()
                .is_some_and(|record| !request.matches(record))
                || self
                    .store
                    .get_meta(&format!("gateway:restart-source:{}", request.input_id))?
                    .is_some_and(|source| source != request.id)
                || restarts.pending.iter().any(|(id, pending)| {
                    if id == request.id {
                        pending.input_id != request.input_id || pending.ack_id != request.ack_id
                    } else {
                        pending.input_id == request.input_id
                    }
                })
            {
                return Err(rejected("Gateway restart identity conflict"));
            }
            if let Some(record) = prior {
                return Ok(record);
            }
            if let Some(pending) = restarts.pending.get(request.id) {
                pending.result.clone()
            } else {
                let value = json!({"requestId": request.id, "inputId": request.input_id, "ackOutputId": request.ack_id});
                let input = self.store.validate_restart(&value).map_err(|error| {
                    if error
                        .downcast_ref::<crate::store::AuthorityError>()
                        .is_some()
                    {
                        rejected("Gateway restart request failed")
                    } else {
                        uncertain("Gateway restart request failed")
                    }
                })?;
                self.adapters.rooms.owner_route(&input["route"])?;
                let (send, result) = watch::channel(None);
                restarts.pending.insert(
                    request.id.to_owned(),
                    RestartCall {
                        input_id: request.input_id.to_owned(),
                        ack_id: request.ack_id.to_owned(),
                        result: result.clone(),
                    },
                );
                let hub = self.clone();
                let id = request.id.to_owned();
                drop(self.effects.spawn(async move {
                    let outcome = match hub.service.restart(value).await {
                        Ok(result) => AttemptResult::Finished(result),
                        Err(error) if error.certainty == "rejected" => AttemptResult::Rejected,
                        Err(_) => AttemptResult::Uncertain,
                    };
                    // The operation outlives an aborted requester, but only a
                    // receipt successfully written to a socket can run it.
                    if let Ok(mut restarts) = hub.restarts.lock() {
                        restarts.pending.remove(&id);
                    }
                    send.send_replace(Some(outcome));
                }));
                result
            }
        };
        let result = result
            .wait_for(Option::is_some)
            .await
            .map_err(|_| uncertain("Gateway restart request failed"))?;
        match result.as_ref() {
            Some(AttemptResult::Finished(result)) => Ok(result.clone()),
            Some(AttemptResult::Rejected) => Err(rejected("Gateway restart request failed")),
            Some(AttemptResult::Uncertain) | None => {
                Err(uncertain("Gateway restart request failed"))
            }
        }
    }

    fn run_restart(&self, id: &str) -> anyhow::Result<()> {
        {
            let mut restarts = self
                .restarts
                .lock()
                .map_err(|_| anyhow::anyhow!("Gateway restart lock was poisoned"))?;
            if !self
                .store
                .get_restart(Some(id))?
                .is_some_and(|record| record["state"] == "accepted")
                || !restarts.started.insert(id.to_owned())
            {
                return Ok(());
            }
        }
        self.service.run_restart(id)
    }
}

fn parse(data: &Map<String, Value>) -> Option<RestartRequest<'_>> {
    let id = data.get("requestId")?.as_str()?;
    let uuid = Uuid::try_parse(id).ok()?;
    if id.len() != 36
        || !(1..=8).contains(&uuid.get_version_num())
        || uuid.get_variant() != Variant::RFC4122
    {
        return None;
    }
    let checked_id = |field| {
        data.get(field)?
            .as_str()
            .filter(|id| !js_trim(id).is_empty() && id.encode_utf16().count() <= 1024)
    };
    Some(RestartRequest {
        id,
        input_id: checked_id("inputId")?,
        ack_id: checked_id("ackOutputId")?,
    })
}
