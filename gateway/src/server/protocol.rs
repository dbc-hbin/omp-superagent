use std::sync::Arc;

use axum::{
    Json,
    body::{Body, to_bytes},
    extract::{Extension, Request, State},
    http::{HeaderMap, Method, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde_json::{Map, Value, json};
use tokio::sync::oneshot;

use super::{Hub, Service, transport::OnFinish};
use crate::{
    adapter::EffectError,
    store::{AuthorityError, PHYSICAL_ROUTE_FIELDS},
};

const MAX_FRAME: usize = 16 * 1024 * 1024;

pub(super) type WireResult<T> = Result<T, Fault>;

pub(super) struct Fault {
    message: String,
    certainty: &'static str,
    retry_after_ms: Option<u64>,
}

impl Fault {
    pub(super) fn is_rejected(&self) -> bool {
        self.certainty == "rejected"
    }

    pub(super) fn into_json(self) -> Value {
        let mut result = json!({"ok": false, "error": self.message, "certainty": self.certainty});
        if let Some(retry_after) = self.retry_after_ms {
            result["retryAfterMs"] = json!(retry_after);
        }
        result
    }
}

impl From<EffectError> for Fault {
    fn from(error: EffectError) -> Self {
        Self {
            message: error.message,
            certainty: error.certainty,
            retry_after_ms: error.retry_after_ms,
        }
    }
}

impl From<anyhow::Error> for Fault {
    fn from(error: anyhow::Error) -> Self {
        if let Some(error) = error.downcast_ref::<AuthorityError>() {
            return rejected(error.0);
        }
        if let Some(error) = error.downcast_ref::<EffectError>() {
            return Self {
                message: error.message.clone(),
                certainty: error.certainty,
                retry_after_ms: error.retry_after_ms,
            };
        }
        // Do not return native/SQLite/transport error details from a generic
        // failure. These may contain paths or private provider data.
        eprintln!("Gateway operation failed; inspect private service state");
        uncertain("Gateway operation failed")
    }
}

pub(super) fn rejected(message: impl Into<String>) -> Fault {
    Fault {
        message: message.into(),
        certainty: "rejected",
        retry_after_ms: None,
    }
}

pub(super) fn uncertain(message: impl Into<String>) -> Fault {
    Fault {
        message: message.into(),
        certainty: "uncertain",
        retry_after_ms: None,
    }
}

pub(super) fn object(value: &Value) -> WireResult<&Map<String, Value>> {
    value
        .as_object()
        .ok_or_else(|| rejected("Invalid Gateway request"))
}

pub(super) fn ok() -> Response {
    Json(json!({"ok": true})).into_response()
}

pub(super) fn effect_id(value: &str) -> bool {
    value.len() == 36
        && value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f' | b'-'))
}

pub(super) async fn handle(
    State(hub): State<Arc<Hub>>,
    Extension(finish): Extension<OnFinish>,
    request: Request,
) -> Response {
    match dispatch(&hub, finish, request).await {
        Ok(response) => response,
        Err(fault) => (StatusCode::BAD_REQUEST, Json(fault.into_json())).into_response(),
    }
}

async fn dispatch(hub: &Arc<Hub>, finish: OnFinish, request: Request) -> WireResult<Response> {
    let (parts, body) = request.into_parts();
    let endpoint = parts
        .uri
        .path_and_query()
        .map(axum::http::uri::PathAndQuery::as_str)
        .unwrap_or_default();
    let method = parts.method;
    if endpoint == "/status" && method == Method::GET {
        let mut status =
            hub.service
                .status(hub.connected(), hub.head_ready(), hub.admission_ready())?;
        status["gateway"]["unresolvedEvents"] = json!(hub.store.unresolved()?);
        if let Some(mut restart) = hub.store.get_restart(None)? {
            if let Some(fields) = restart.as_object_mut() {
                fields.remove("sessionFile");
            }
            status["restart"] = restart;
        }
        return Ok(Json(json!({"ok": true, "value": status})).into_response());
    }
    if endpoint == "/stop" && method == Method::POST {
        read_json(body).await?;
        let service = Arc::clone(&hub.service);
        let (send, stopped) = oneshot::channel();
        drop(hub.effects.spawn(async move {
            let result = service.stop().await.map(|()| StopReceipt(service));
            drop(send.send(result));
        }));
        let receipt = stopped.await.map_err(anyhow::Error::from)??;
        return finish.json(&json!({"ok": true}), move || drop(receipt));
    }
    if hub.state()?.closing {
        return Err(rejected("Gateway is stopping"));
    }
    let id = authenticate(hub, &parts.headers)?;
    if endpoint == "/attach" && method == Method::POST {
        let data = read_json(body).await?;
        hub.attach(id, object(&data)?).await?;
        return Ok(ok());
    }
    let (revision, pid) = {
        let state = hub.state()?;
        let client = state
            .client
            .as_ref()
            .filter(|client| client.id == id)
            .ok_or_else(|| rejected("Gateway client is detached"))?;
        (client.revision, client.pid)
    };
    if endpoint == "/events" && method == Method::GET {
        return hub.open_events(revision);
    }
    if method != Method::POST {
        return Err(rejected("Unknown Gateway operation"));
    }
    if endpoint == "/restart" {
        // Recheck native owner authorization before waiting for any body.
        hub.service
            .authorize_head(pid)
            .await
            .map_err(|_| rejected("Gateway head authorization rejected"))?;
        hub.can_restart(revision)?;
        let data = read_json(body).await?;
        hub.can_restart(revision)?;
        return hub.restart(object(&data)?, finish).await;
    }
    let Value::Object(data) = read_json(body).await? else {
        return Err(rejected("Invalid Gateway request"));
    };
    match endpoint {
        "/ready" => hub.mark_ready(revision)?,
        "/receipt" => hub.receipt(revision, &data)?,
        "/detach" => hub.detach(revision)?,
        "/route" | "/history/route" => {
            hub.assert_route(revision, &data, endpoint == "/route").await?;
        }
        "/effect" => {
            hub.state()?.controller(revision)?;
            return Ok(Json(hub.effect(data).await?).into_response());
        }
        "/attachment" => {
            hub.state()?.controller(revision)?;
            return hub.attachment(&data).await;
        }
        _ => return Err(rejected("Unknown Gateway operation")),
    }
    Ok(ok())
}

struct StopReceipt(Arc<dyn Service>);

impl Drop for StopReceipt {
    fn drop(&mut self) {
        // Stop is already committed. Wait for successful flush when possible,
        // but abandonment of the operator's socket cannot undo that stop.
        self.0.finish_stop();
    }
}

fn authenticate(hub: &Hub, headers: &HeaderMap) -> WireResult<String> {
    let authorization = format!("Bearer {}", hub.store.token()?);
    if headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        != Some(authorization.as_str())
    {
        return Err(rejected("Gateway head authorization required"));
    }
    let mut ids = headers.get_all("x-gateway-client").iter();
    let id = ids
        .next()
        .and_then(|value| value.to_str().ok())
        .filter(|value| effect_id(value))
        .ok_or_else(|| rejected("Invalid Gateway client"))?;
    if ids.next().is_some() {
        return Err(rejected("Invalid Gateway client"));
    }
    Ok(id.to_owned())
}

async fn read_json(body: Body) -> WireResult<Value> {
    let bytes = to_bytes(body, MAX_FRAME).await.map_err(|error| {
        // The body limiter reports its concrete error through the chain; a
        // broken Unix peer remains uncertain rather than a known rejection.
        let mut cause: &dyn std::error::Error = &error;
        loop {
            if cause.to_string() == "length limit exceeded" {
                break rejected("Gateway frame exceeds size limit");
            }
            match cause.source() {
                Some(source) => cause = source,
                None => break Fault::from(anyhow::Error::new(error)),
            }
        }
    })?;
    // Node decodes socket bytes via Buffer.toString("utf8") before JSON.parse.
    serde_json::from_str(&String::from_utf8_lossy(&bytes))
        .map_err(|error| Fault::from(anyhow::Error::new(error)))
}

impl Hub {
    async fn assert_route(
        &self,
        revision: u64,
        data: &Map<String, Value>,
        require_drained_intake: bool,
    ) -> WireResult<()> {
        {
            let mut state = self.state()?;
            let client = state.controller(revision)?;
            if !self.admission_ready()
                || !client.ready
                || !client.reconciled
                || client.reconciliation.is_some()
            {
                return Err(rejected("Authenticated messenger route is not ready"));
            }
            // Scheduled dispatch needs the stronger idle-intake fence. Read-only
            // history runs inside an ingress handler, before that handler's ACK.
            if require_drained_intake && self.store.pending()? != 0 {
                return Err(rejected("Gateway intake is still pending"));
            }
        }
        let route = object(data.get("route").unwrap_or(&Value::Null))?;
        if !matches!(
            route.get("platform").and_then(Value::as_str),
            Some("discord" | "telegram" | "slack")
        ) || ["accountId", "authorityId", "channelId"]
            .iter()
            .any(|field| !route.get(*field).is_some_and(Value::is_string))
            || ["guildId", "threadId"].iter().any(|field| {
                !route
                    .get(*field)
                    .is_some_and(|value| value.is_null() || value.is_string())
            })
            || route.get("topicId").is_some_and(|topic| !topic.is_string())
        {
            return Err(rejected("Invalid messenger route"));
        }
        let selector = PHYSICAL_ROUTE_FIELDS
            .into_iter()
            .chain(["topicId"])
            .filter_map(|field| {
                route
                    .get(field)
                    .map(|value| (field.to_owned(), value.clone()))
            })
            .collect();
        self.adapters
            .effect("assertRoute", &[Value::Object(selector)])
            .await?;
        let mut state = self.state()?;
        if state.closing {
            return Err(rejected("Gateway is stopping"));
        }
        state.controller(revision)?;
        Ok(())
    }
}
