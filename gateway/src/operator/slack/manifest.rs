use std::collections::BTreeMap;

use serde::Deserialize;
use serde_json::value::{RawValue, to_raw_value};
use serde_json::{Map, Value};

// Parse only the fields needed to validate Socket Mode and replace the picker.
// Keep the original values raw for publication, including nested JSON numbers.
pub(super) struct Manifest {
    raw: Box<RawValue>,
    commands: Vec<String>,
    bot_scopes: Vec<String>,
}

type Object<'a> = BTreeMap<String, &'a RawValue>;

fn object(value: Option<&RawValue>) -> Result<Object<'_>, ()> {
    match value {
        Some(value) => serde_json::from_str(value.get()).map_err(|_| ()),
        None => Ok(Object::new()),
    }
}

fn field<'a, T: Deserialize<'a>>(object: &Object<'a>, key: &str) -> Result<Option<T>, ()> {
    object
        .get(key)
        .map(|raw| serde_json::from_str(raw.get()).map_err(|_| ()))
        .transpose()
}

impl Manifest {
    pub(super) fn parse(raw: Box<RawValue>) -> Result<Self, ()> {
        let root = object(Some(&raw))?;
        let display = object(root.get("display_information").copied())?;
        let settings = object(root.get("settings").copied())?;
        if !field::<String>(&display, "name")?.is_some_and(|name| !name.is_empty())
            || field::<bool>(&settings, "socket_mode_enabled")? != Some(true)
        {
            return Err(());
        }
        let features = object(root.get("features").copied())?;
        let entries: Vec<Object<'_>> = field(&features, "slash_commands")?.unwrap_or_default();
        let mut commands = Vec::with_capacity(entries.len());
        for entry in entries {
            let command: String = field(&entry, "command")?.ok_or(())?;
            if !entry
                .get("description")
                .is_some_and(|description| description.get().starts_with('"'))
                || !command.strip_prefix('/').is_some_and(|name| {
                    (1..=31).contains(&name.len())
                        && name.bytes().all(|byte| {
                            byte.is_ascii_lowercase()
                                || byte.is_ascii_digit()
                                || matches!(byte, b'_' | b'-')
                        })
                })
            {
                return Err(());
            }
            commands.push(command);
        }
        let oauth = object(root.get("oauth_config").copied())?;
        let scopes = object(oauth.get("scopes").copied())?;
        let bot_scopes = field(&scopes, "bot")?.unwrap_or_default();
        Ok(Self {
            raw,
            commands,
            bot_scopes,
        })
    }

    pub(super) fn commands(&self) -> impl Iterator<Item = &str> {
        self.commands.iter().map(String::as_str)
    }

    pub(super) fn with_commands(&self, commands: &[Value]) -> Result<Box<RawValue>, ()> {
        let mut root = object(Some(&self.raw))?;
        let mut features = object(root.get("features").copied())?;
        let commands = to_raw_value(commands).map_err(|_| ())?;
        features.insert("slash_commands".into(), &commands);
        let features = to_raw_value(&features).map_err(|_| ())?;
        root.insert("features".into(), &features);

        let mut oauth = object(root.get("oauth_config").copied())?;
        let mut scopes = object(oauth.get("scopes").copied())?;
        let mut bot = Vec::new();
        for scope in self
            .bot_scopes
            .iter()
            .map(String::as_str)
            .chain(["commands"])
        {
            if !bot.contains(&scope) {
                bot.push(scope);
            }
        }
        let bot = to_raw_value(&bot).map_err(|_| ())?;
        scopes.insert("bot".into(), &bot);
        let scopes = to_raw_value(&scopes).map_err(|_| ())?;
        oauth.insert("scopes".into(), &scopes);
        let oauth = to_raw_value(&oauth).map_err(|_| ())?;
        root.insert("oauth_config".into(), &oauth);
        to_raw_value(&root).map_err(|_| ())
    }

    pub(super) fn matches(&self, other: &RawValue) -> Result<bool, ()> {
        Ok(normalized(&self.raw, Path::default())? == normalized(other, Path::default())?)
    }
}

// Only documented disabled/empty defaults are ignored. Exact path segments
// prevent a future field with a dotted key from matching a known nested field.
fn empty_default(path: &[&str], value: &Value) -> bool {
    match path {
        ["_metadata", "major_version"] => value.as_f64() == Some(1.0),
        ["display_information", "description" | "long_description"]
        | ["features", "slash_commands", "*", "usage_hint" | "url"] => value.as_str() == Some(""),
        ["features", "app_home", "home_tab_enabled" | "messages_tab_enabled" | "messages_tab_read_only_enabled"]
        | ["features", "bot_user", "always_online"]
        | ["features", "slash_commands", "*", "should_escape"]
        | ["settings", "org_deploy_enabled" | "token_rotation_enabled" | "is_hosted"]
        | ["settings", "interactivity", "is_enabled"]
        | ["settings", "incoming_webhooks", "incoming_webhooks_enabled"] => value.as_bool() == Some(false),
        _ => false,
    }
}

fn set_valued(path: &[&str]) -> bool {
    matches!(
        path,
        ["oauth_config", "redirect_urls"]
            | ["oauth_config", "scopes", "bot" | "user" | "bot_optional" | "user_optional"]
            | ["settings", "allowed_ip_address_ranges"]
            | ["settings", "event_subscriptions", "bot_events" | "user_events"]
            | ["features", "unfurl_domains"]
    )
}

fn empty_container(path: &[&str]) -> bool {
    matches!(
        path,
        ["_metadata" | "features" | "oauth_config" | "settings"]
            | ["features", "app_home" | "slash_commands" | "shortcuts" | "workflow_steps"]
            | ["oauth_config", "scopes"]
            | ["settings", "event_subscriptions" | "interactivity" | "incoming_webhooks"]
    )
}

#[derive(Clone, Copy, Default)]
struct Path<'a> {
    // No ignored setting is deeper than four segments.
    keys: [&'a str; 4],
    len: usize,
}

impl<'a> Path<'a> {
    fn child(mut self, key: &'a str) -> Self {
        if let Some(slot) = self.keys.get_mut(self.len) {
            *slot = key;
        }
        self.len += 1;
        self
    }

    fn keys(&self) -> &[&str] {
        self.keys.get(..self.len).unwrap_or_default()
    }
}

fn normalized(value: &RawValue, path: Path<'_>) -> Result<Option<Value>, ()> {
    // RawValue's scanner does not apply Value's recursion cap. Bound the
    // recursive comparison at the former JSON decoder's envelope depth.
    if path.len > 126 {
        return Err(());
    }
    let raw = value.get();
    let keys = path.keys();
    let normalized = match raw.as_bytes().first() {
        Some(b'[') => {
            let items: Vec<&RawValue> = serde_json::from_str(raw).map_err(|_| ())?;
            let unordered = set_valued(keys);
            if items.is_empty() && (unordered || empty_container(keys)) {
                return Ok(None);
            }
            // An omitted value in a position still occupies that array slot.
            let child = path.child("*");
            let mut items: Vec<Value> = items
                .into_iter()
                .map(|item| normalized(item, child).map(|value| value.unwrap_or(Value::Null)))
                .collect::<Result<_, _>>()?;
            if unordered || keys == ["features", "slash_commands"] {
                items.sort_by_cached_key(Value::to_string);
            }
            Value::Array(items)
        }
        Some(b'{') => {
            let mut result = Map::new();
            for (key, item) in object(Some(value))? {
                if let Some(value) = normalized(item, path.child(&key))? {
                    result.insert(key, value);
                }
            }
            if result.is_empty() && empty_container(keys) {
                return Ok(None);
            }
            Value::Object(result)
        }
        Some(b'-' | b'0'..=b'9') => {
            // Comparison keeps JS number semantics without ever serializing
            // these rounded values back to Slack.
            let number = raw.parse::<f64>().map_err(|_| ())?;
            Value::from(if number == 0.0 { 0.0 } else { number })
        }
        _ => serde_json::from_str(raw).map_err(|_| ())?,
    };
    Ok((!empty_default(keys, &normalized)).then_some(normalized))
}
