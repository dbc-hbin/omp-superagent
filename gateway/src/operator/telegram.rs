use std::collections::HashSet;

use reqwest::{RequestBuilder, Url, multipart};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};

use super::{Api, catalog, redact};

const INSPECTION: &str = "Telegram command inspection failed: bot identity, owner DM, allowed-group membership, or menu response could not be verified. No mutation was attempted; raw API details suppressed. No automatic retry was attempted.";
const WRITE: &str = "Telegram command menu update is unresolved: the request failed and may have reached Telegram; earlier scopes may already have changed. No automatic retry was attempted; raw API details suppressed. Inspect with telegram-commands without --apply before deciding any further mutation.";
const READBACK: &str = "Telegram command menu update is unresolved: authoritative getMyCommands did not verify the exact supported names, descriptions, and order; earlier scopes may already have changed. No automatic retry was attempted; raw API details suppressed. Inspect with telegram-commands without --apply before deciding any further mutation.";
const PROFILE_INSPECTION: &str = "Profile inspection failed; no Telegram profile update was attempted. Credential/API details suppressed.";
const PROFILE_UNRESOLVED: &str = "Profile update is unresolved; it may have reached Telegram. No automatic retry was attempted; API details suppressed.";
const IDS: &str = "Telegram command menus require a positive owner ID and negative allowed group IDs";
const LANGUAGE: &str = "Telegram command language must be an empty string or a two-letter lowercase ISO 639-1 code";
const MAX_SAFE_ID: i64 = 9_007_199_254_740_991;
const LANGUAGE_CODES: &str = include_str!("../../../src/telegram-command-languages.json");

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommandRequest<'a> {
    apply: bool,
    owner_id: &'a str,
    #[serde(borrow)]
    allowed_chat_ids: Vec<&'a str>,
    language_code: Option<&'a str>,
}

#[derive(Deserialize)]
struct User {
    id: i64,
    is_bot: bool,
}

#[derive(Deserialize)]
struct Chat {
    id: i64,
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    is_direct_messages: bool,
}

#[derive(Deserialize)]
struct Membership {
    user: User,
    status: String,
    #[serde(default)]
    is_member: bool,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Scope<'a> {
    Chat { chat_id: &'a str },
    ChatMember { chat_id: &'a str, user_id: i64 },
}

#[derive(Serialize)]
struct Selection<'a> {
    scope: Scope<'a>,
    #[serde(skip_serializing_if = "Option::is_none")]
    language_code: Option<&'a str>,
}

#[derive(Deserialize, PartialEq, Serialize)]
struct MenuCommand {
    command: String,
    description: String,
}

#[derive(Serialize)]
struct WriteMenu<'a> {
    commands: &'a [MenuCommand],
    #[serde(flatten)]
    selection: &'a Selection<'a>,
}

fn safe_id(value: &str) -> Option<i64> {
    let id: i64 = value.parse().ok()?;
    ((-MAX_SAFE_ID..=MAX_SAFE_ID).contains(&id) && id.to_string() == value).then_some(id)
}

struct BotApi<'a> {
    api: &'a Api,
    endpoint: Url,
}

impl<'a> BotApi<'a> {
    fn new(api: &'a Api) -> Option<Self> {
        let mut endpoint = Url::parse(&api.telegram).ok()?;
        endpoint.path_segments_mut().ok()?.pop_if_empty().push(&format!("bot{}", api.bot));
        Some(Self { api, endpoint })
    }

    fn post(&self, method: &str) -> Option<RequestBuilder> {
        let mut endpoint = self.endpoint.clone();
        endpoint.path_segments_mut().ok()?.push(method);
        Some(self.api.client.post(endpoint))
    }

    async fn call<T: DeserializeOwned>(&self, method: &str, payload: &impl Serialize) -> Option<T> {
        receive(self.api, self.post(method)?.json(payload)).await
    }

    async fn bot_id(&self, owner: &str) -> Option<i64> {
        let bot: User = self.call("getMe", &json!({})).await?;
        (bot.is_bot && (1..=MAX_SAFE_ID).contains(&bot.id) && bot.id.to_string() != owner).then_some(bot.id)
    }

    async fn menu(&self, selection: &Selection<'_>) -> Option<Vec<MenuCommand>> {
        let rows: Vec<MenuCommand> = self.call("getMyCommands", selection).await?;
        (rows.len() <= 100 && rows.iter().all(|row| {
            (1..=32).contains(&row.command.len())
                && row.command.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
                && (1..=256).contains(&row.description.encode_utf16().count())
        })).then_some(rows)
    }
}

async fn receive<T: DeserializeOwned>(api: &Api, request: RequestBuilder) -> Option<T> {
    #[derive(Deserialize)]
    struct Envelope<T> {
        ok: bool,
        result: T,
    }
    let response = api.send(request).await?;
    if !response.status().is_success() {
        return None;
    }
    let envelope: Envelope<T> = response.json().await.ok()?;
    envelope.ok.then_some(envelope.result)
}

async fn owner_scopes<'a>(
    api: &BotApi<'_>,
    request: &CommandRequest<'a>,
    owner: i64,
) -> Option<Vec<Scope<'a>>> {
    let chat: Chat = api.call("getChat", &json!({ "chat_id": request.owner_id })).await?;
    if chat.id != owner || chat.kind != "private" {
        return None;
    }
    let mut targets = vec![Scope::Chat { chat_id: request.owner_id }];
    let mut seen = HashSet::new();
    for &chat_id in &request.allowed_chat_ids {
        if !seen.insert(chat_id) {
            continue;
        }
        let chat: Chat = api.call("getChat", &json!({ "chat_id": chat_id })).await?;
        if chat.id.to_string() != chat_id || !matches!(chat.kind.as_str(), "group" | "supergroup") || chat.is_direct_messages {
            return None;
        }
        let member: Membership = api.call("getChatMember", &json!({ "chat_id": chat_id, "user_id": owner })).await?;
        let present = match member.status.as_str() {
            "creator" | "administrator" | "member" => true,
            "restricted" => member.is_member,
            _ => false,
        };
        if member.user.id != owner || member.user.is_bot || !present {
            return None;
        }
        targets.push(Scope::ChatMember { chat_id, user_id: owner });
    }
    Some(targets)
}

async fn commands(req: &Value, api: &Api) -> Result<Value, &'static str> {
    let request = CommandRequest::deserialize(req).map_err(|_| INSPECTION)?;
    let owner = safe_id(request.owner_id).filter(|&id| id > 0).ok_or(IDS)?;
    if request.allowed_chat_ids.iter().any(|id| !safe_id(id).is_some_and(|id| id < 0)) {
        return Err(IDS);
    }
    let language_code = request.language_code.filter(|language| !language.is_empty());
    if let Some(code) = language_code {
        let supported: Vec<&str> = serde_json::from_str(LANGUAGE_CODES).map_err(|_| LANGUAGE)?;
        if !supported.contains(&code) {
            return Err(LANGUAGE);
        }
    }
    let bot = BotApi::new(api).ok_or(INSPECTION)?;
    let bot_id = bot.bot_id(request.owner_id).await.ok_or(INSPECTION)?;
    let scopes = owner_scopes(&bot, &request, owner).await.ok_or(INSPECTION)?;
    let planned: Vec<MenuCommand> = catalog().iter().map(|command| MenuCommand {
        command: command.name.to_owned(),
        description: command.description.to_owned(),
    }).collect();
    // Finish every ownership and menu read before attempting any mutation.
    let mut before = Vec::with_capacity(scopes.len());
    for scope in scopes {
        let selection = Selection { scope, language_code };
        let current = bot.menu(&selection).await.ok_or(INSPECTION)?;
        let changed = current != planned;
        before.push((selection, current, changed));
    }
    if request.apply {
        for (selection, _, changed) in &before {
            if !changed {
                continue;
            }
            let write = WriteMenu { commands: &planned, selection };
            if bot.call::<bool>("setMyCommands", &write).await != Some(true) {
                return Err(WRITE);
            }
            if bot.menu(selection).await.as_deref() != Some(planned.as_slice()) {
                return Err(READBACK);
            }
        }
    }
    let scopes: Vec<Value> = before.into_iter().map(|(selection, mut current, changed)| {
        for command in &mut current {
            command.description = redact(&command.description, &[&api.bot], false);
        }
        json!({ "scope": selection.scope, "current": current, "changed": changed })
    }).collect();
    let (status, summary) = if request.apply {
        ("applied", "Owner-scoped command menus verified by getMyCommands, including exact supported names, descriptions, and order.")
    } else {
        ("dry-run", "Read-only plan; no mutation was attempted. --apply replaces only these owner-scoped command lists.")
    };
    let note = format!("{summary} Only the selected language list is inspected or changed. Other scopes and bot configuration are untouched. Language-specific menus not selected here are unknown and untouched: Telegram cannot enumerate them, and they may override the default-language menu. No polling, webhooks, or native runtime was started.");
    Ok(json!({
        "status": status, "botId": bot_id.to_string(), "languageCode": request.language_code,
        "plannedCommands": planned, "scopes": scopes, "note": note,
    }))
}

async fn avatar(req: &Value, api: &Api) -> Result<Value, &'static str> {
    let owner = req["ownerId"].as_str().ok_or(PROFILE_INSPECTION)?;
    let bot = BotApi::new(api).ok_or(PROFILE_INSPECTION)?;
    let id = bot.bot_id(owner).await.ok_or(PROFILE_INSPECTION)?;
    let image: &[u8] = include_bytes!("../../../assets/superagent-avatar.jpg");
    let image = multipart::Part::bytes(image)
        .file_name("superagent-avatar.jpg")
        .mime_str("image/jpeg")
        .map_err(|_| PROFILE_INSPECTION)?;
    let form = multipart::Form::new()
        .text("photo", r#"{"type":"static","photo":"attach://avatar"}"#)
        .part("avatar", image);
    let request = bot.post("setMyProfilePhoto").ok_or(PROFILE_INSPECTION)?;
    if receive::<bool>(api, request.multipart(form)).await != Some(true) {
        return Err(PROFILE_UNRESOLVED);
    }
    let photos: Value = bot.call("getUserProfilePhotos", &json!({ "user_id": id, "limit": 1 }))
        .await.ok_or(PROFILE_UNRESOLVED)?;
    if !photos["total_count"].as_u64().is_some_and(|count| count > 0)
        || !photos["photos"][0].as_array().is_some_and(|sizes| sizes.iter().any(|photo| {
            ["file_id", "file_unique_id"].iter().all(|key| {
                photo.get(*key).and_then(Value::as_str).is_some_and(|id| !id.is_empty())
            })
        }))
    {
        return Err(PROFILE_UNRESOLVED);
    }
    Ok(json!({
        "platform": "telegram", "status": "applied",
        "message": "Mascot upload accepted by Telegram; current profile photo confirmed by getUserProfilePhotos.",
    }))
}

pub(super) async fn run(op: &str, req: &Value, api: &Api) -> Result<Value, &'static str> {
    match op {
        "telegram-commands" => commands(req, api).await,
        "telegram-avatar" => avatar(req, api).await,
        _ => Err("Unsupported Telegram operator operation"),
    }
}
