use std::{
    collections::{HashMap, HashSet},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use base64::{Engine, engine::general_purpose::STANDARD};
use reqwest::{
    Method, RequestBuilder, Response,
    header::{AUTHORIZATION, CONTENT_TYPE, HeaderMap, HeaderValue, USER_AGENT},
};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::{Api, redact};
use crate::commands::discord_catalog as catalog;

const CURRENT_USER: &str = "/users/%40me";
const AGENT: &str = concat!(
    "DiscordBot (",
    env!("OMP_SUPERAGENT_HOMEPAGE"),
    ", ",
    env!("OMP_SUPERAGENT_VERSION"),
    ")"
);
const INSPECTION: &str = "Discord command inspection failed: identity, permissions, or response could not be verified. No mutation was attempted; raw SDK details suppressed. No automatic retry was attempted.";
const WRITE: &str = "Discord global command overwrite is unresolved: the request failed and may have reached Discord. No automatic retry was attempted; raw SDK details suppressed. Inspect with discord-commands (without --apply) before deciding any further mutation.";
const READBACK: &str = "Discord global command overwrite is unresolved: authoritative GET did not verify the exact supported definitions. No automatic retry was attempted; raw SDK details suppressed. Inspect with discord-commands (without --apply) before deciding any further mutation.";
const PROFILE_INSPECTION: &str = "Profile inspection failed; no Discord profile update was attempted. Credential/API details suppressed.";
const PROFILE_UNRESOLVED: &str = "Profile update is unresolved; it may have reached Discord. No automatic retry was attempted; API details suppressed.";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommandRequest<'a> {
    apply: bool,
    #[serde(borrow)]
    allowed_guild_ids: Vec<&'a str>,
}

#[derive(Deserialize)]
struct Registration {
    id: String,
    application_id: String,
    #[serde(rename = "type")]
    kind: u8,
    name: String,
    description: String,
    #[serde(flatten)]
    fields: Map<String, Value>,
}

fn snowflake(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn parse_registrations(
    value: Value,
    application: &str,
    guild: Option<&str>,
) -> Option<Vec<Registration>> {
    let rows: Vec<Registration> = serde_json::from_value(value).ok()?;
    let mut ids = HashSet::new();
    let mut keys = HashSet::new();
    for row in &rows {
        if !snowflake(&row.id)
            || row.application_id != application
            || match guild {
                Some(id) => row.fields.get("guild_id").and_then(Value::as_str) != Some(id),
                None => row.fields.contains_key("guild_id"),
            }
            || !(1..=4).contains(&row.kind)
            || row.name.is_empty()
            || row.name.encode_utf16().count() > 32
            || !row.fields.get("options").is_none_or(Value::is_array)
            || !ids.insert(&row.id)
            || !keys.insert((row.kind, &row.name))
        {
            return None;
        }
    }
    Some(rows)
}

fn supported(row: &Registration) -> bool {
    row.kind == 1 && catalog().iter().any(|command| command.name == row.name)
}

fn summary(row: &Registration, token: &str) -> Value {
    json!({ "id": row.id, "type": row.kind, "name": redact(&row.name, &[token], false) })
}

fn text_option(description: &str) -> Value {
    json!({ "type": 3, "name": "text", "description": description, "required": false })
}

fn definitions() -> Vec<Value> {
    catalog()
        .iter()
        .map(|command| {
            let mut row = json!({
                "type": 1, "name": command.name, "description": command.description,
                "contexts": [0, 1], "integration_types": [0],
            });
            if let Some(text) = command.text {
                row["options"] = json!([text_option(text)]);
            }
            row
        })
        .collect()
}

fn empty_localizations(value: &Value) -> bool {
    value.is_null() || value.as_object().is_some_and(Map::is_empty)
}

fn exact_text_option(value: &Value, description: &str) -> bool {
    let Some(row) = value.as_object() else {
        return false;
    };
    row.get("type").and_then(Value::as_u64) == Some(3)
        && row.get("name").and_then(Value::as_str) == Some("text")
        && row.get("description").and_then(Value::as_str) == Some(description)
        && row.iter().all(|(key, value)| match key.as_str() {
            "type" | "name" | "description" => true,
            "required" | "autocomplete" => value.as_bool() == Some(false),
            "name_localizations" | "description_localizations" => empty_localizations(value),
            "options" | "choices" | "channel_types" => value.as_array().is_some_and(Vec::is_empty),
            _ => false,
        })
}

fn exact_definitions(rows: &[Registration]) -> bool {
    // Inspection already established uniqueness by (type, name).
    rows.len() == catalog().len()
        && rows.iter().all(|row| {
            let Some(command) = catalog().iter().find(|command| command.name == row.name) else {
                return false;
            };
            let fields = &row.fields;
            let options = fields.get("options").and_then(Value::as_array);
            row.kind == 1
                && row.description == command.description
                && match command.text {
                    None => options.is_none_or(Vec::is_empty),
                    Some(description) => options.is_some_and(|items| {
                        matches!(items.as_slice(), [option] if exact_text_option(option, description))
                    }),
                }
                && fields.get("contexts").and_then(Value::as_array).is_some_and(|items| {
                    matches!(items.as_slice(), [a, b]
                        if matches!((a.as_u64(), b.as_u64()), (Some(0), Some(1)) | (Some(1), Some(0))))
                })
                && fields.get("integration_types").is_none_or(|value| {
                    matches!(value.as_array().map(Vec::as_slice), Some([item]) if item.as_u64() == Some(0))
                })
                && fields.get("name_localizations").is_none_or(empty_localizations)
                && fields.get("description_localizations").is_none_or(empty_localizations)
                && fields.get("default_member_permissions").is_none_or(Value::is_null)
                && fields.get("default_permission").is_none_or(|v| v.is_null() || v.as_bool() == Some(true))
                && fields.get("nsfw").is_none_or(|v| v.is_null() || v.as_bool() == Some(false))
        })
}

#[derive(Clone, Copy, Eq, Hash, PartialEq)]
enum Route {
    CurrentUser,
    CurrentApplication,
    GlobalCommands,
    // /applications/.../guilds/.../commands has no top-level guild parameter.
    GuildCommands,
}

type RouteKey = (Method, Route);

#[derive(Eq, Hash, PartialEq)]
enum Bucket {
    Route(RouteKey),
    Shared(HeaderValue),
}

struct Discord<'a> {
    api: &'a Api,
    aliases: HashMap<RouteKey, HeaderValue>,
    // An exhausted bucket with no usable reset remains blocked for this invocation.
    exhausted: HashMap<Bucket, Option<Instant>>,
}

impl<'a> Discord<'a> {
    fn new(api: &'a Api) -> Self {
        Self { api, aliases: HashMap::new(), exhausted: HashMap::new() }
    }

    fn bucket(&self, key: &RouteKey) -> Bucket {
        self.aliases.get(key).map_or_else(
            || Bucket::Route(key.clone()),
            |bucket| Bucket::Shared(bucket.clone()),
        )
    }

    fn limited(&self, method: Method, route: Route) -> bool {
        self.exhausted.get(&self.bucket(&(method, route))).is_some_and(|reset| {
            reset.is_none_or(|reset| reset > Instant::now())
        })
    }

    fn observe_limits(&mut self, key: RouteKey, headers: &HeaderMap) {
        if let Some(bucket) = headers.get("x-ratelimit-bucket").filter(|value| !value.is_empty()) {
            self.exhausted.remove(&Bucket::Route(key.clone()));
            self.aliases.insert(key.clone(), bucket.clone());
        }
        let Some(remaining) = headers.get("x-ratelimit-remaining")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok())
        else {
            return;
        };
        let bucket = self.bucket(&key);
        if remaining == 0 {
            let reset_after = header_seconds(headers, "x-ratelimit-reset-after").or_else(|| {
                let reset = header_seconds(headers, "x-ratelimit-reset")?;
                let epoch_now = SystemTime::now().duration_since(UNIX_EPOCH).ok()?;
                Some(reset.saturating_sub(epoch_now))
            });
            let reset = reset_after.and_then(|duration| Instant::now().checked_add(duration));
            self.exhausted.insert(bucket, reset);
        } else {
            self.exhausted.remove(&bucket);
        }
    }

    fn request(&self, method: Method, path: &str) -> RequestBuilder {
        self.api.client.request(method, format!("{}{path}", self.api.discord))
            .header(AUTHORIZATION, format!("Bot {}", self.api.bot))
            .header(USER_AGENT, AGENT)
    }

    async fn send(&mut self, key: RouteKey, request: RequestBuilder) -> Option<Response> {
        if self.limited(key.0.clone(), key.1) {
            return None;
        }
        let response = self.api.send(request).await?;
        self.observe_limits(key, response.headers());
        response.status().is_success().then_some(response)
    }

    async fn get(&mut self, route: Route, path: &str) -> Option<Value> {
        let request = self.request(Method::GET, path);
        json_response(self.send((Method::GET, route), request).await?).await
    }
}

fn header_seconds(headers: &HeaderMap, key: &str) -> Option<Duration> {
    let seconds = headers.get(key)?.to_str().ok()?.parse().ok()?;
    Duration::try_from_secs_f64(seconds).ok()
}

fn has_json(response: &Response) -> bool {
    response.headers().get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("application/json"))
}

async fn json_response(response: Response) -> Option<Value> {
    if !has_json(&response) {
        return None;
    }
    response.json().await.ok()
}

fn bot_id(value: &Value) -> Option<&str> {
    if value["bot"].as_bool() != Some(true) {
        return None;
    }
    value["id"].as_str().filter(|id| snowflake(id))
}

async fn commands(req: &Value, api: &Api) -> Result<Value, &'static str> {
    let request = CommandRequest::deserialize(req).map_err(|_| INSPECTION)?;
    if request.allowed_guild_ids.iter().any(|id| !snowflake(id)) {
        return Err(INSPECTION);
    }
    let mut discord = Discord::new(api);
    let bot = discord.get(Route::CurrentUser, CURRENT_USER).await.ok_or(INSPECTION)?;
    let id = bot_id(&bot).ok_or(INSPECTION)?;
    let application = discord.get(Route::CurrentApplication, "/oauth2/applications/@me").await.ok_or(INSPECTION)?;
    if application["id"].as_str() != Some(id)
        || application.get("bot").is_some_and(|bot| bot["id"].as_str() != Some(id))
    {
        return Err(INSPECTION);
    }
    let global_path = format!("/applications/{id}/commands");
    let current = discord.get(Route::GlobalCommands, &global_path).await
        .and_then(|value| parse_registrations(value, id, None))
        .ok_or(INSPECTION)?;
    let mut guilds = Vec::with_capacity(request.allowed_guild_ids.len());
    let mut shadowed = false;
    for guild in request.allowed_guild_ids {
        let path = format!("/applications/{id}/guilds/{guild}/commands");
        let rows = discord.get(Route::GuildCommands, &path).await
            .and_then(|value| parse_registrations(value, id, Some(guild)))
            .ok_or(INSPECTION)?;
        let shadowing: Vec<_> = rows.iter().filter(|row| supported(row)).map(|row| summary(row, &api.bot)).collect();
        shadowed |= !shadowing.is_empty();
        guilds.push(json!({
            "guildId": guild, "registrations": rows.iter().map(|row| summary(row, &api.bot)).collect::<Vec<_>>(),
            "shadowing": shadowing,
        }));
    }
    let planned = definitions();
    let (status, note) = if !request.apply {
        ("dry-run", "Read-only plan. --apply takes exclusive ownership of this dedicated bot's GLOBAL command list, replacing it with supported Superagent definitions and deleting all other global registrations (including Hermes). Guild registrations are preserved; supported-name guild shadows block apply. No Gateway or native runtime was started.")
    } else if shadowed {
        ("blocked", "Apply refused: allowed-guild registrations shadow supported global commands. No mutation was attempted; all guild registrations are preserved. Resolve guild conflicts explicitly before applying.")
    } else {
        // Do not mutate if the mandatory readback is already known to be unavailable.
        if discord.limited(Method::GET, Route::GlobalCommands) {
            return Err(INSPECTION);
        }
        let request = discord.request(Method::PUT, &global_path).json(&planned);
        let response = discord.send((Method::PUT, Route::GlobalCommands), request).await.ok_or(WRITE)?;
        let json_receipt = has_json(&response);
        // Check that the receipt arrived intact; only the GET verifies definitions.
        let receipt = response.bytes().await.map_err(|_| WRITE)?;
        if json_receipt {
            serde_json::from_slice::<Value>(&receipt).map_err(|_| WRITE)?;
        }
        let readback = discord.get(Route::GlobalCommands, &global_path).await
            .and_then(|value| parse_registrations(value, id, None))
            .ok_or(READBACK)?;
        if !exact_definitions(&readback) {
            return Err(READBACK);
        }
        ("applied", "Global command overwrite verified by authoritative GET: exact supported Superagent names, types, descriptions, options, contexts, and guild-only installation. Obsolete global registrations were removed; guild registrations were not changed. No Gateway or native runtime was started.")
    };
    Ok(json!({
        "status": status, "applicationId": id, "botId": id, "plannedGlobal": planned,
        "currentGlobal": current.iter().map(|row| summary(row, &api.bot)).collect::<Vec<_>>(),
        "obsoleteGlobal": current.iter().filter(|row| !supported(row)).map(|row| summary(row, &api.bot)).collect::<Vec<_>>(),
        "guilds": guilds, "note": note,
    }))
}

async fn avatar(req: &Value, api: &Api) -> Result<Value, &'static str> {
    let owner = req["ownerId"].as_str().ok_or(PROFILE_INSPECTION)?;
    let mut discord = Discord::new(api);
    let bot = discord.get(Route::CurrentUser, CURRENT_USER).await.ok_or(PROFILE_INSPECTION)?;
    let id = bot_id(&bot).filter(|id| *id != owner).ok_or(PROFILE_INSPECTION)?;
    if discord.limited(Method::GET, Route::CurrentUser) {
        return Err(PROFILE_INSPECTION);
    }
    let jpeg = STANDARD.encode(include_bytes!("../../../assets/superagent-avatar.jpg"));
    let request = discord.request(Method::PATCH, CURRENT_USER)
        .json(&json!({ "avatar": format!("data:image/jpeg;base64,{jpeg}") }));
    let response = discord.send((Method::PATCH, Route::CurrentUser), request).await.ok_or(PROFILE_UNRESOLVED)?;
    let updated = json_response(response).await.ok_or(PROFILE_UNRESOLVED)?;
    let receipt = updated["avatar"].as_str().filter(|hash| !hash.is_empty()).ok_or(PROFILE_UNRESOLVED)?;
    if updated["id"].as_str() != Some(id) {
        return Err(PROFILE_UNRESOLVED);
    }
    let current = discord.get(Route::CurrentUser, CURRENT_USER).await.ok_or(PROFILE_UNRESOLVED)?;
    if bot_id(&current) != Some(id) || current["avatar"].as_str() != Some(receipt) {
        return Err(PROFILE_UNRESOLVED);
    }
    Ok(json!({
        "platform": "discord", "status": "applied",
        "message": "Mascot profile picture applied and verified by Discord profile readback.",
    }))
}

pub(super) async fn run(op: &str, req: &Value, api: &Api) -> Result<Value, &'static str> {
    match op {
        "discord-commands" => commands(req, api).await,
        "discord-avatar" => avatar(req, api).await,
        _ => Err("Unsupported Discord operator operation"),
    }
}
