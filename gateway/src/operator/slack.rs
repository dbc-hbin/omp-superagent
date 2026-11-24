mod api;
mod manifest;

use serde::Deserialize;
use serde_json::{Value, json};

use self::api::{CommandsGrant, Method, Slack};
use self::manifest::Manifest;
use super::{Api, catalog, redact};

const INSPECTION: &str = "Slack command inspection failed: configured workspace, bot/app identity, Socket Mode, or manifest export could not be verified. No mutation was attempted; raw API details suppressed. No automatic retry was attempted.";
const VALIDATION: &str = "Slack manifest validation failed. No mutation was attempted; raw API details suppressed. The explicit configuration credential needs app_configurations:write. No automatic retry was attempted.";
const UPDATE: &str = "Slack manifest update outcome is uncertain; the app may have changed. Inspect its authoritative manifest before another apply. Raw API details suppressed; no automatic retry was attempted.";
const READBACK: &str = "Slack manifest update may have succeeded, but authoritative readback failed or differed from the intended commands or unrelated configuration. Outcome uncertain; inspect the app before another apply. Raw API details suppressed; no automatic retry was attempted.";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    team_id: String,
    apply: bool,
}

fn slack_id<'a>(value: Option<&'a str>, prefixes: &[u8]) -> Option<&'a str> {
    let id = value?;
    let (&prefix, rest) = id.as_bytes().split_first()?;
    (prefixes.contains(&prefix)
        && !rest.is_empty()
        && rest
            .iter()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit()))
    .then_some(id)
}

fn redact_report(value: &mut Value, secrets: &[&str]) {
    match value {
        Value::String(text) => *text = redact(text, secrets, true),
        Value::Array(items) => {
            for item in items {
                redact_report(item, secrets);
            }
        }
        Value::Object(object) => {
            for item in object.values_mut() {
                redact_report(item, secrets);
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

pub(super) async fn run(op: &str, req: &Value, api: &Api) -> Result<Value, &'static str> {
    if op != "slack-commands" {
        return Err("Unsupported Slack operator operation");
    }
    let Request { team_id, apply } =
        Request::deserialize(req).map_err(|_| "Invalid Slack command registration request")?;
    let team =
        slack_id(Some(&team_id), b"T").ok_or("Invalid Slack bot credential name or workspace policy")?;
    let configuration_token = api
        .manifest
        .as_deref()
        .filter(|token| !token.is_empty() && !token.contains(['\r', '\n']) && *token != api.bot.as_str())
        .ok_or("A distinct explicit Slack app configuration credential is required")?;
    let slack = Slack {
        api,
        configuration_token,
    };

    let identity = slack
        .call(Method::Auth { team })
        .await
        .map_err(|()| INSPECTION)?;
    if identity.body["team_id"].as_str() != Some(team) {
        return Err(INSPECTION);
    }
    let bot = slack_id(identity.body["bot_id"].as_str(), b"B").ok_or(INSPECTION)?;
    let user = slack_id(identity.body["user_id"].as_str(), b"UW").ok_or(INSPECTION)?;
    let details = slack
        .call(Method::Bot { team, bot })
        .await
        .map_err(|()| INSPECTION)?;
    let binding = &details.body["bot"];
    let app = slack_id(binding["app_id"].as_str(), b"A").ok_or(INSPECTION)?;
    if binding["id"].as_str() != Some(bot)
        || binding["user_id"].as_str() != Some(user)
        || binding["deleted"].as_bool() == Some(true)
        || identity
            .body
            .get("app_id")
            .is_some_and(|id| id.as_str() != Some(app))
    {
        return Err(INSPECTION);
    }
    let grant = identity
        .commands_grant
        .or(details.commands_grant)
        .unwrap_or(CommandsGrant::Unknown);
    let current = slack.export(app).await.map_err(|()| INSPECTION)?;
    let planned_commands: Vec<Value> = catalog()
        .iter()
        .map(|command| {
            let mut value = json!({
                "command": format!("/superagent-{}", command.name),
                "description": command.description,
                "should_escape": false,
            });
            if let Some(text) = command.text {
                value["usage_hint"] = json!(text);
            }
            value
        })
        .collect();
    let intended = current.with_commands(&planned_commands).map_err(|()| INSPECTION)?;
    let changed = !current.matches(&intended).map_err(|()| INSPECTION)?;
    let (permissions_updated, matched) = if apply && changed {
        let validation = slack
            .call(Method::Validate {
                app,
                manifest: intended.get(),
            })
            .await
            .map_err(|()| VALIDATION)?;
        if validation
            .body
            .get("errors")
            .is_some_and(|errors| !errors.as_array().is_some_and(Vec::is_empty))
        {
            return Err(VALIDATION);
        }
        let update = slack
            .call(Method::Update {
                app,
                manifest: intended.get(),
            })
            .await
            .map_err(|()| UPDATE)?;
        if update.body["app_id"].as_str() != Some(app) {
            return Err(UPDATE);
        }
        let permissions = update.body["permissions_updated"].as_bool().ok_or(UPDATE)?;
        let readback = slack.export(app).await.map_err(|()| READBACK)?;
        if !readback.matches(&intended).map_err(|()| READBACK)? {
            return Err(READBACK);
        }
        (Some(permissions), true)
    } else {
        (None, !changed)
    };
    let requires_reinstall = match (permissions_updated, grant) {
        (Some(true), _) | (_, CommandsGrant::Missing) => Some(true),
        (_, CommandsGrant::Granted) => Some(false),
        (_, CommandsGrant::Unknown) => None,
    };
    let current_commands: Vec<&str> = current.commands().collect();
    let obsolete_commands: Vec<&str> = current_commands
        .iter()
        .copied()
        .filter(|name| {
            !planned_commands
                .iter()
                .any(|command| command["command"].as_str() == Some(*name))
        })
        .collect();
    let note = [
            if apply { "The exported app configuration matches the supported commands." } else {
                "Dry-run: API reads and local comparison only; apply replaces this exact app's slash command list, including obsolete Hermes commands."
            },
            "All unrelated manifest fields and existing scopes are preserved. Socket Mode must already be enabled; no HTTP request URLs are invented.",
            match requires_reinstall {
                Some(true) => "Reinstall or reauthorize the app in the configured workspace to grant the required permissions; registration does not establish active command delivery.",
                None => "Installed commands scope could not be confirmed; check grants and reinstall or reauthorize if needed. Active command delivery is not verified.",
                Some(false) => "The configured bot reports the commands grant; active Socket Mode command delivery is not verified.",
            },
            "Configuration credentials require app_configurations:read, plus app_configurations:write for apply. Bot identity inspection requires users:read. No socket or runtime was started.",
        ].join(" ");
    let mut report = json!({
        "status": if apply { "applied" } else { "dry-run" },
        "teamId": team, "botId": bot, "botUserId": user, "appId": app,
        "currentCommands": current_commands, "obsoleteCommands": obsolete_commands,
        "plannedCommands": planned_commands, "changed": changed,
        "updated": permissions_updated.is_some(), "manifestReadbackMatched": matched,
        "commandsGrant": grant, "requiresReinstall": requires_reinstall, "permissionsUpdated": permissions_updated,
        "note": note,
    });
    redact_report(&mut report, &[&api.bot, configuration_token]);
    Ok(report)
}
