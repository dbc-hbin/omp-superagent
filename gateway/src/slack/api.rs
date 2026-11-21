use std::sync::Arc;
use std::time::Duration;

use futures_util::FutureExt;
use reqwest::{Client, StatusCode, Url};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use crate::adapter::EffectError;

use super::Inner;
use super::wire::{Route, slack_id};

#[derive(Clone)]
pub(super) struct Api {
    client: Client,
    credentials: Arc<Credentials>,
    #[cfg(test)]
    local: Option<Url>,
}

pub(super) struct Credentials {
    pub(super) bot: String,
    pub(super) app: String,
    pub(super) team: String,
}

#[derive(Clone)]
pub(super) enum ApiError {
    Status(StatusCode),
    RateLimited(Option<u64>),
    Platform(String),
    InvalidReply,
    Transport,
    Truncated,
}

impl ApiError {
    pub(super) fn is_code(&self, code: &str) -> bool {
        matches!(self, Self::Platform(actual) if actual == code)
    }
}

impl From<ApiError> for EffectError {
    fn from(error: ApiError) -> Self {
        match error {
            ApiError::Status(status)
                if status.is_client_error() && status != StatusCode::REQUEST_TIMEOUT =>
            {
                Self::rejected(format!("Slack rejected request (HTTP {})", status.as_u16()))
            }
            ApiError::RateLimited(retry) => {
                let mut error = Self::rejected("Slack request rate limited");
                error.retry_after_ms = retry;
                error
            }
            ApiError::Platform(code) => {
                let message = format!("Slack API rejected request: {code}");
                if matches!(
                    code.as_str(),
                    "internal_error" | "fatal_error" | "request_timeout" | "service_unavailable"
                ) {
                    Self::uncertain(message)
                } else {
                    Self::rejected(message)
                }
            }
            ApiError::InvalidReply => Self::uncertain("Slack returned no authoritative API result"),
            ApiError::Truncated => {
                Self::uncertain("Slack reports that published content was truncated")
            }
            ApiError::Status(_) | ApiError::Transport => Self::uncertain("Slack transport failed"),
        }
    }
}

#[derive(Deserialize)]
struct Reply {
    ok: bool,
    error: Option<String>,
    response_metadata: Option<ReplyMetadata>,
}

#[derive(Deserialize)]
struct ReplyMetadata {
    #[serde(default)]
    warnings: Vec<String>,
}

#[derive(Deserialize)]
struct SocketUrl {
    url: String,
}

impl Api {
    pub(super) fn new(client: Client, credentials: Credentials) -> Self {
        Self {
            client,
            credentials: Arc::new(credentials),
            #[cfg(test)]
            local: None,
        }
    }

    #[cfg(test)]
    pub(super) fn local(client: Client, addr: std::net::SocketAddr) -> Self {
        assert!(addr.ip().is_loopback());
        Self {
            local: Some(Url::parse(&format!("http://{addr}/api/")).expect("fixture API URL")),
            ..Self::new(
                client,
                Credentials {
                    bot: "xoxb-fixture".into(),
                    app: "xapp-fixture".into(),
                    team: "TLOCAL".into(),
                },
            )
        }
    }

    pub(super) async fn call<T: DeserializeOwned>(
        &self,
        method: &'static str,
        mut args: Value,
    ) -> Result<T, ApiError> {
        args["team_id"] = json!(self.credentials.team);
        self.request(method, &self.credentials.bot, args).await
    }

    async fn request<T: DeserializeOwned>(
        &self,
        method: &'static str,
        token: &str,
        args: Value,
    ) -> Result<T, ApiError> {
        let url = format!("https://slack.com/api/{method}");
        #[cfg(test)]
        let url = self
            .local
            .as_ref()
            .map_or(url, |base| format!("{base}{method}"));
        let Value::Object(mut form) = args else {
            return Err(ApiError::InvalidReply);
        };
        // The Slack Web API expects structured Block Kit and files arguments
        // as JSON strings in the same form as scalar Web API arguments.
        for entry in form
            .values_mut()
            .filter(|entry| entry.is_object() || entry.is_array())
        {
            *entry = Value::String(entry.to_string());
        }
        let response = self
            .client
            .post(url)
            .bearer_auth(token)
            .timeout(Duration::from_secs(15))
            .form(&form)
            .send()
            .await
            .map_err(|_| ApiError::Transport)?;
        let status = response.status();
        if status == StatusCode::TOO_MANY_REQUESTS {
            let delay = response
                .headers()
                .get(reqwest::header::RETRY_AFTER)
                .and_then(|raw| raw.to_str().ok())
                .and_then(|seconds| seconds.parse::<u64>().ok())
                .map(|seconds| seconds.saturating_mul(1_000));
            return Err(ApiError::RateLimited(delay));
        }
        if !status.is_success() {
            return Err(ApiError::Status(status));
        }
        let value: Value = response.json().await.map_err(|_| ApiError::InvalidReply)?;
        let result = Reply::deserialize(&value).map_err(|_| ApiError::InvalidReply)?;
        if !result.ok {
            let code = result.error.filter(|code| {
                !code.is_empty()
                    && code.len() <= 64
                    && code
                        .bytes()
                        .all(|byte| byte.is_ascii_lowercase() || byte == b'_')
            });
            return Err(code.map_or(ApiError::InvalidReply, ApiError::Platform));
        }
        if result.response_metadata.is_some_and(|meta| {
            meta.warnings
                .iter()
                .any(|warning| warning == "message_truncated")
        }) {
            return Err(ApiError::Truncated);
        }
        T::deserialize(value).map_err(|_| ApiError::InvalidReply)
    }

    pub(super) async fn socket_url(&self) -> Result<Url, EffectError> {
        let response: SocketUrl = self
            .request("apps.connections.open", &self.credentials.app, json!({}))
            .await?;
        let url = Url::parse(&response.url)
            .map_err(|_| EffectError::rejected("Slack provided an invalid Socket Mode URL"))?;
        #[cfg(test)]
        if self.local.is_some()
            && url.scheme() == "ws"
            && url.host_str() == Some("127.0.0.1")
            && url.username().is_empty()
            && url.password().is_none()
        {
            return Ok(url);
        }
        if secure_url(&url, "wss")
            && url
                .host_str()
                .is_some_and(|host| host.ends_with(".slack.com"))
            && url.fragment().is_none()
        {
            Ok(url)
        } else {
            Err(EffectError::rejected(
                "Slack provided an unauthorized Socket Mode URL",
            ))
        }
    }

    pub(super) fn private_download(&self, url: Url) -> reqwest::RequestBuilder {
        self.client.get(url).bearer_auth(&self.credentials.bot)
    }

    pub(super) fn file_upload(&self, url: Url) -> reqwest::RequestBuilder {
        #[cfg(test)]
        let url = self.local.as_ref().map_or_else(|| url.clone(), |base| {
            let mut target = base.clone();
            target.set_path(url.path());
            target.set_query(url.query());
            target
        });
        self.client.post(url)
    }
}

pub(super) fn secure_url(url: &Url, scheme: &str) -> bool {
    url.scheme() == scheme
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none_or(|port| port == 443)
}

pub(super) struct Identity {
    pub(super) bot_user: String,
    pub(super) bot_id: String,
    pub(super) app_id: String,
    pub(super) account: String,
}

#[derive(Deserialize)]
struct Auth {
    team_id: String,
    user_id: String,
    bot_id: String,
}

#[derive(Deserialize)]
struct BotResult {
    bot: Bot,
}
#[derive(Deserialize)]
struct Bot {
    id: String,
    user_id: String,
    app_id: String,
    team_id: Option<String>,
}

#[derive(Deserialize)]
struct UserResult {
    user: User,
}
#[derive(Deserialize)]
struct User {
    id: String,
    team_id: String,
    is_bot: bool,
    deleted: Option<bool>,
    is_app_user: Option<bool>,
}

#[derive(Deserialize)]
struct ChannelResult {
    channel: Channel,
}
#[derive(Clone, Deserialize)]
pub(super) struct Channel {
    id: String,
    is_im: Option<bool>,
    is_mpim: Option<bool>,
    is_archived: Option<bool>,
    is_member: Option<bool>,
    user: Option<String>,
    context_team_id: Option<String>,
}

impl Inner {
    pub(super) async fn authenticate(&self) -> anyhow::Result<Identity> {
        let auth: Auth = self
            .api
            .call("auth.test", json!({}))
            .await
            .map_err(EffectError::from)?;
        anyhow::ensure!(
            auth.team_id == self.team && slack_id(&auth.user_id) && slack_id(&auth.bot_id),
            "Slack bot authentication does not match the configured workspace"
        );
        let BotResult { bot } = self
            .api
            .call("bots.info", json!({ "bot": auth.bot_id }))
            .await
            .map_err(EffectError::from)?;
        anyhow::ensure!(
            bot.id == auth.bot_id
                && bot.user_id == auth.user_id
                && slack_id(&bot.app_id)
                && bot.team_id.as_deref().is_none_or(|team| team == self.team),
            "Slack bot application identity could not be verified"
        );
        let UserResult { user } = self
            .api
            .call("users.info", json!({ "user": self.owner }))
            .await
            .map_err(EffectError::from)?;
        anyhow::ensure!(
            user.id == self.owner
                && user.team_id == self.team
                && !user.is_bot
                && user.deleted != Some(true)
                && user.is_app_user != Some(true),
            "Slack owner must be an active human in the configured workspace"
        );
        Ok(Identity {
            account: format!("{}:{}", self.team, auth.user_id),
            bot_user: auth.user_id,
            bot_id: auth.bot_id,
            app_id: bot.app_id,
        })
    }

    pub(super) async fn identity(&self) -> Result<Arc<Identity>, EffectError> {
        self.identity
            .read()
            .await
            .clone()
            .ok_or_else(|| EffectError::rejected("Slack adapter is not started"))
    }

    pub(super) async fn assert_route(&self, route: &Route) -> Result<(), EffectError> {
        let identity = self.identity().await?;
        if route.platform != "slack"
            || route.account_id != identity.account
            || route.authority_id != self.owner
            || !slack_id(&route.channel_id)
            || route.guild_id.as_ref().is_some_and(|team| {
                team != &self.team || !self.channels.contains(&route.channel_id)
            })
        {
            return Err(EffectError::rejected(
                "Slack route is not authorized for this workspace, bot, and owner",
            ));
        }
        Ok(())
    }

    pub(super) async fn destination(&self, route: &Route) -> Result<(), EffectError> {
        self.assert_route(route).await?;
        let key = route.physical();
        let flight = {
            let mut flights = self.destinations.lock().await;
            flights.retain(|_, flight| flight.peek().is_none());
            flights
                .entry(key)
                .or_insert_with(|| {
                    let api = self.api.clone();
                    let channel_id = route.channel_id.clone();
                    async move {
                        let ChannelResult { channel } = api
                            .call("conversations.info", json!({ "channel": channel_id }))
                            .await?;
                        Ok(channel)
                    }
                    .boxed()
                    .shared()
                })
                .clone()
        };
        let channel = flight.await?;
        if channel.id != route.channel_id
            || channel.is_mpim == Some(true)
            || channel.is_archived == Some(true)
            || channel
                .context_team_id
                .as_deref()
                .is_some_and(|team| team != self.team)
        {
            return Err(EffectError::rejected(
                "Slack destination identity is not authorized",
            ));
        }
        if route.guild_id.is_none() {
            if channel.is_im != Some(true) || channel.user.as_deref() != Some(self.owner.as_str()) {
                return Err(EffectError::rejected(
                    "Slack direct message is not the configured owner's one-to-one DM",
                ));
            }
        } else if channel.is_im == Some(true) || channel.is_member != Some(true) {
            return Err(EffectError::rejected(
                "Slack bot must be a member of the configured channel",
            ));
        }
        Ok(())
    }
}
