use anyhow::{Context as _, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::{
    adapter::EffectError,
    store::{PHYSICAL_ROUTE_FIELDS, js_trim, now},
};

const INPUT_BYTES: usize = 4000;
const OUTPUT_UTF16: usize = 1500;
const FRESH_MS: i64 = 5 * 60 * 1000;

#[derive(Clone, Copy, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Mode {
    Request,
    Chat,
    Work,
}

impl Mode {
    pub(crate) const fn command(self) -> &'static str {
        match self {
            Self::Request => "request",
            Self::Chat => "ask",
            Self::Work => "work",
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Room {
    platform: String,
    guild_id: String,
    channel_id: String,
    user_ids: Vec<String>,
    pub(crate) mode: Mode,
    pub(crate) revision: String,
    pub(crate) daily_limit: u64,
}

impl Room {
    pub(crate) fn permits(&self, user: &str) -> bool {
        self.user_ids.iter().any(|id| id == user)
    }

    fn allowed_by(&self, config: &Value) -> bool {
        let section = &config[&self.platform];
        let includes = |key: &str, expected: &str| {
            section[key].as_array().is_some_and(|ids| ids.iter().any(|id| id == expected))
        };
        match self.platform.as_str() {
            "discord" => includes("allowedGuildIds", &self.guild_id)
                && includes("allowedChannelIds", &self.channel_id)
                && ["channelId", "textChannelId"].iter().all(|key| {
                    section["voice"][*key].as_str() != Some(&self.channel_id)
                }),
            "telegram" => self.guild_id == self.channel_id
                && self.guild_id.starts_with('-')
                && includes("allowedChatIds", &self.channel_id),
            "slack" => section["teamId"] == self.guild_id
                && !self.channel_id.starts_with('D')
                && includes("allowedChannelIds", &self.channel_id),
            _ => false,
        }
    }
}

#[derive(Default)]
pub(crate) struct Rooms(Vec<Room>);

impl Rooms {
    pub(crate) fn parse(config: &Value) -> Result<Self> {
        let Some(rooms) = config.get("groupRooms") else {
            return Ok(Self::default());
        };
        let rooms = Vec::<Room>::deserialize(rooms).context("Invalid Gateway group rooms")?;
        let mut keys = std::collections::HashSet::new();
        for room in &rooms {
            ensure!(
                !room.guild_id.is_empty()
                    && !room.channel_id.is_empty()
                    && !room.revision.is_empty()
                    && room.daily_limit > 0
                    && !room.user_ids.is_empty()
                    && room.user_ids.iter().all(|user| !user.is_empty())
                    && room.allowed_by(config)
                    && keys.insert((&room.platform, &room.guild_id, &room.channel_id)),
                "Gateway group room must have a unique allowed destination and valid policy"
            );
        }
        Ok(Self(rooms))
    }

    pub(crate) fn get(&self, platform: &str, guild: Option<&str>, channel: &str) -> Option<&Room> {
        let guild = guild?;
        self.0.iter().find(|room| {
            room.platform == platform && room.guild_id == guild && room.channel_id == channel
        })
    }

    pub(crate) fn has_guild(&self, platform: &str, guild: Option<&str>) -> bool {
        self.0.iter().any(|room| room.platform == platform && Some(room.guild_id.as_str()) == guild)
    }

    pub(crate) fn has_actor(&self, platform: &str, guild: Option<&str>, user: &str) -> bool {
        self.0.iter().any(|room| {
            room.platform == platform && Some(room.guild_id.as_str()) == guild && room.permits(user)
        })
    }

    pub(crate) fn for_route(&self, route: &Value) -> Option<&Room> {
        self.get(route["platform"].as_str()?, route["guildId"].as_str(), route["channelId"].as_str()?)
    }

    pub(crate) fn owner_route(&self, route: &Value) -> Result<(), EffectError> {
        // Parent channel IDs are unique per platform. A caller cannot make a
        // known restricted channel ordinary by claiming the wrong guild or
        // placing its parent ID in the thread field.
        if self.0.iter().any(|room| {
            route["platform"] == room.platform
                && (route["channelId"] == room.channel_id || route["threadId"] == room.channel_id)
        }) {
            return Err(EffectError::rejected("Owner operations are disabled in restricted group rooms"));
        }
        Ok(())
    }

    pub(crate) fn allows_event(&self, event: &Value) -> bool {
        match event["kind"].as_str() {
            Some("message") => self.owner_route(&event["input"]["route"]).is_ok(),
            Some("answer") => self.owner_route(&event["route"]).is_ok(),
            Some("group") => Request::deserialize(&event["request"])
                .is_ok_and(|request| self.current_request(&request)),
            _ => true,
        }
    }

    pub(crate) fn current_request(&self, request: &Request) -> bool {
        self.for_route(&request.route).is_some_and(|room| {
            room.mode == request.mode && room.revision == request.revision
                && room.permits(&request.user_id) && request.id == request.source_id()
        })
    }
}

pub(crate) struct Candidate<'a> {
    pub(crate) message_id: &'a str,
    pub(crate) user_id: &'a str,
    pub(crate) text: &'a str,
    pub(crate) sent_ms: i64,
    // Only Telegram can supply this, after authenticating the username and command entity.
    pub(crate) qualified_command: Option<&'a str>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Request {
    pub(crate) id: String,
    pub(crate) route: Value,
    pub(crate) message_id: String,
    user_id: String,
    mode: Mode,
    revision: String,
    text: String,
}

impl Request {
    pub(crate) fn new(room: &Room, route: Value, source: Candidate<'_>) -> Result<Option<Self>> {
        if !room.permits(source.user_id) || !fresh(source.sent_ms, now()?) {
            return Ok(None);
        }
        let command = room.mode.command();
        let rest = source.qualified_command.map_or_else(
            || source.text.strip_prefix('!').and_then(|text| text.strip_prefix(command)),
            |token| source.text.strip_prefix(token),
        );
        let Some(rest) = rest.filter(|rest| {
            rest.chars().next().is_some_and(|ch| js_trim(&rest[..ch.len_utf8()]).is_empty())
        }) else {
            return Ok(None);
        };
        let text = js_trim(rest);
        if text.is_empty() || text.len() > INPUT_BYTES {
            return Ok(None);
        }
        let mut request = Self {
            id: String::new(),
            route,
            message_id: source.message_id.to_owned(),
            user_id: source.user_id.to_owned(),
            mode: room.mode,
            revision: room.revision.clone(),
            text: text.to_owned(),
        };
        request.id = request.source_id();
        Ok(Some(request))
    }

    fn source_id(&self) -> String {
        let route = PHYSICAL_ROUTE_FIELDS.map(|field| &self.route[field]);
        let source = json!([route, self.message_id]);
        format!("group:{}", hex::encode(Sha256::digest(source.to_string().as_bytes())))
    }

    pub(crate) fn reply_text<'a>(&self, reply: &'a Reply) -> Result<&'a str, EffectError> {
        let reject = || EffectError::rejected("Invalid group reply text for this room and outcome");
        match (self.mode, reply.outcome, reply.text.as_deref()) {
            (Mode::Request, Outcome::Finished | Outcome::Failed | Outcome::Interrupted, _) => Err(reject()),
            (Mode::Chat, Outcome::Finished, Some(text))
                if !js_trim(text).is_empty() && text.encode_utf16().count() <= OUTPUT_UTF16 =>
            {
                Ok(text)
            }
            (Mode::Chat, Outcome::Finished, _) | (_, _, Some(_)) => Err(reject()),
            (_, Outcome::Received, None) => Ok("Request received."),
            (_, Outcome::Finished, None) => Ok("Request finished."),
            (_, Outcome::Failed, None) => Ok("Request failed."),
            (_, Outcome::Interrupted, None) => Ok("Request interrupted."),
        }
    }
}

fn fresh(sent: i64, observed: i64) -> bool {
    sent > 0 && (-30_000..=FRESH_MS).contains(&observed.saturating_sub(sent))
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Outcome {
    Received,
    Finished,
    Failed,
    Interrupted,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Reply {
    pub(crate) source_id: String,
    outcome: Outcome,
    #[serde(default, deserialize_with = "reply_text")]
    text: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Output<R> {
    pub(crate) id: String,
    pub(crate) route: R,
    pub(crate) message_id: String,
    pub(crate) text: String,
}

fn reply_text<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    String::deserialize(d).map(Some)
}
