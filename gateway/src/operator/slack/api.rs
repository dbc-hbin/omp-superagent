use reqwest::header::HeaderMap;
use reqwest::{Response, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{Value, value::RawValue};

use super::{Api, Manifest};

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum CommandsGrant {
    Granted,
    Missing,
    Unknown,
}

pub(super) struct Slack<'a> {
    pub(super) api: &'a Api,
    pub(super) configuration_token: &'a str,
}

pub(super) enum Method<'a> {
    Auth { team: &'a str },
    Bot { team: &'a str, bot: &'a str },
    Export { app: &'a str },
    Validate { app: &'a str, manifest: &'a str },
    Update { app: &'a str, manifest: &'a str },
}

pub(super) struct Reply {
    pub(super) body: Value,
    pub(super) commands_grant: Option<CommandsGrant>,
}

#[derive(Deserialize)]
struct Export {
    ok: bool,
    manifest: Box<RawValue>,
}

fn commands_grant(headers: &HeaderMap, body: &Value) -> Option<CommandsGrant> {
    const GRANTS: &str = "x-oauth-scopes";
    if headers.contains_key(GRANTS) {
        let mut has_commands = false;
        for header in headers.get_all(GRANTS).iter() {
            let Ok(scopes) = header.to_str() else {
                return Some(CommandsGrant::Unknown);
            };
            has_commands |= scopes.split(',').any(|scope| scope.trim() == "commands");
        }
        return Some(if has_commands {
            CommandsGrant::Granted
        } else {
            CommandsGrant::Missing
        });
    }
    // Keep the Web API's optional response metadata fallback, never requested or
    // accepted scopes. An explicit header has precedence over the body.
    let scopes = body
        .pointer("/response_metadata/scopes")
        .filter(|value| !value.is_null())?;
    Some(match scopes.as_array() {
        Some(scopes) if scopes.iter().all(Value::is_string) => {
            if scopes.iter().any(|scope| scope.as_str() == Some("commands")) {
                CommandsGrant::Granted
            } else {
                CommandsGrant::Missing
            }
        }
        _ => CommandsGrant::Unknown,
    })
}

impl Slack<'_> {
    async fn request(&self, method: Method<'_>) -> Result<Response, ()> {
        let mut form = [("", ""); 2];
        let (name, token, fields) = match method {
            Method::Auth { team } => {
                form[0] = ("team_id", team);
                ("auth.test", self.api.bot.as_str(), &form[..1])
            }
            Method::Bot { team, bot } => {
                form = [("team_id", team), ("bot", bot)];
                ("bots.info", self.api.bot.as_str(), &form[..])
            }
            Method::Export { app } => {
                form[0] = ("app_id", app);
                ("apps.manifest.export", self.configuration_token, &form[..1])
            }
            Method::Validate { app, manifest } => {
                form = [("app_id", app), ("manifest", manifest)];
                ("apps.manifest.validate", self.configuration_token, &form[..])
            }
            Method::Update { app, manifest } => {
                form = [("app_id", app), ("manifest", manifest)];
                ("apps.manifest.update", self.configuration_token, &form[..])
            }
        };
        let request = self
            .api
            .client
            .post(format!("{}/{name}", self.api.slack))
            .bearer_auth(token)
            .form(fields);
        let response = self.api.send(request).await.ok_or(())?;
        (response.status() == StatusCode::OK)
            .then_some(response)
            .ok_or(())
    }

    pub(super) async fn call(&self, method: Method<'_>) -> Result<Reply, ()> {
        let response = self.request(method).await?;
        let headers = response.headers().clone();
        let body: Value = response.json().await.map_err(|_| ())?;
        if body["ok"].as_bool() != Some(true) {
            return Err(());
        }
        Ok(Reply {
            commands_grant: commands_grant(&headers, &body),
            body,
        })
    }

    pub(super) async fn export(&self, app: &str) -> Result<Manifest, ()> {
        let reply: Export = self
            .request(Method::Export { app })
            .await?
            .json()
            .await
            .map_err(|_| ())?;
        if !reply.ok {
            return Err(());
        }
        Manifest::parse(reply.manifest)
    }
}
