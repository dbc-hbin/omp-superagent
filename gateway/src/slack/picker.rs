use serde_json::{Value, json};

use crate::adapter::EffectError;
use crate::picker::{ACCEPTED, CANCELLED, Change, EXPIRED, Menu};

use super::Inner;
use super::api::Identity;
use super::media::{message_payload, plain, sections};
use super::socket::Ack;
use super::wire::{Route, Ts, decode, same_optional, slack_id};

pub(super) fn menu_blocks(menu: &Menu) -> Vec<Value> {
    let select = (!menu.options.is_empty()).then(|| {
        let options: Vec<_> = menu
            .options
            .iter()
            .map(|item| json!({ "text": plain(&item.label), "value": item.value }))
            .collect();
        json!({
            "type": "static_select", "action_id": menu.select_id,
            "placeholder": plain("Choose an option"), "options": options,
        })
    });
    let elements: Vec<_> = select
        .into_iter()
        .chain(menu.buttons.iter().map(|item| {
            json!({
                "type": "button", "action_id": item.control,
                "text": plain(&item.label), "value": item.value,
            })
        }))
        .collect();
    let mut blocks = sections(&menu.text);
    blocks.push(json!({
        "type": "actions", "block_id": menu.select_id, "elements": elements,
    }));
    blocks
}

// Serialize the card's updates across all revisions, independently of approval tokens.
pub(super) fn picker_key(body: &Value) -> Option<String> {
    let channel = body["channel"]["id"].as_str().filter(|id| slack_id(id))?;
    let ts = Ts::parse(body["container"]["message_ts"].as_str()?)?;
    Some(format!("picker:{channel}:{}", ts.as_str()))
}

struct Click<'a> {
    route: Route,
    ts: Ts,
    control: &'a str,
    value: Option<&'a str>,
}

impl<'a> Click<'a> {
    fn parse(inner: &Inner, identity: &Identity, body: &'a Value, action: &'a Value) -> Option<Self> {
        let channel = body["channel"]["id"].as_str().filter(|id| slack_id(id))?;
        let container = &body["container"];
        let message = &body["message"];
        let ts = Ts::parse(container["message_ts"].as_str()?)?;
        let thread = match message.get("thread_ts") {
            Some(root) => Some(Ts::parse(root.as_str()?)?),
            None => None,
        };
        let kind = action["type"].as_str()?;
        let control = action["action_id"].as_str()?;
        let value = match kind {
            "static_select" => Some(action["selected_option"]["value"].as_str()?),
            "button" => None,
            _ => return None,
        };
        let block_id = action["block_id"].as_str()?;
        if container["type"] != "message"
            || container["channel_id"] != channel
            || !matches!(container.get("is_ephemeral"), None | Some(Value::Bool(false)))
            || message["ts"] != ts.as_str()
            || message["user"] != identity.bot_user
            || message["bot_id"] != identity.bot_id
            || !same_optional(message, "channel", channel)
            || !same_optional(message, "team", &inner.team)
            || !same_optional(message, "app_id", &identity.app_id)
            || !same_optional(
                container,
                "thread_ts",
                thread.as_ref().unwrap_or(&ts).as_str(),
            )
            || !message["blocks"].as_array()?.iter().any(|block| {
                block["type"] == "actions"
                    && block["block_id"] == block_id
                    && block["elements"].as_array().is_some_and(|elements| {
                        elements.iter().any(|element| {
                            element["type"] == kind && element["action_id"] == control
                        })
                    })
            })
        {
            return None;
        }
        Some(Self {
            route: Route {
                platform: "slack".into(),
                account_id: identity.account.clone(),
                authority_id: inner.owner.clone(),
                guild_id: (!channel.starts_with('D')).then(|| inner.team.clone()),
                channel_id: channel.to_owned(),
                thread_id: thread.filter(|thread| thread != &ts),
                topic_id: None,
            },
            ts,
            control,
            value,
        })
    }
}

impl Inner {
    pub(super) async fn interact_picker(
        &self,
        identity: &Identity,
        body: &Value,
        action: &Value,
        ack: Ack,
    ) -> Result<(), EffectError> {
        let Some(click) = Click::parse(self, identity, body, action) else {
            return ack.send(None).await;
        };
        if self.ctx.group_room(click.route.guild_id.as_deref(), &click.route.channel_id).is_some() {
            return ack.send(None).await;
        }
        self.destination(&click.route).await?;
        let change = {
            let _delivery = self.ctx.pickers.delivery().await;
            self.ctx.pickers.choose(click.control, click.value, |route, ts| {
                ts == click.ts.as_str()
                    && decode::<Route>(route).is_ok_and(|route| route.physical() == click.route)
            })?
        };
        let text = match change {
            None => {
                let notice = json!({ "response_type": "ephemeral", "text": EXPIRED });
                return ack.send(Some(notice)).await;
            }
            Some(Change::Show(navigation)) => {
                let menu = &navigation.menu;
                let acknowledged = ack.send(None).await;
                let updated = self.update_picker(&click, &menu.text, menu_blocks(menu)).await;
                self.ctx.pickers.navigated(&navigation, &updated)?;
                return acknowledged.and(updated);
            }
            Some(Change::Cancel) => CANCELLED,
            Some(Change::Select(selection)) => {
                self.ctx.admit_picker(&selection).await?;
                ACCEPTED
            }
        };
        // The control is consumed after durable admission, even if the connection
        // drops while sending the ACK. Still attempt to reflect that on the card.
        let acknowledged = ack.send(None).await;
        let updated = self.update_picker(&click, text, sections(text)).await;
        acknowledged.and(updated)
    }

    async fn update_picker(
        &self,
        click: &Click<'_>,
        text: &str,
        blocks: Vec<Value>,
    ) -> Result<(), EffectError> {
        let mut args = message_payload(text, blocks)?;
        args["channel"] = json!(click.route.channel_id);
        args["ts"] = json!(click.ts);
        args["as_user"] = json!(true);
        let receipt: Value = self.api.call("chat.update", args).await?;
        if receipt["channel"] != click.route.channel_id || receipt["ts"] != click.ts.as_str() {
            return Err(EffectError::uncertain(
                "Slack picker update has no authoritative destination receipt",
            ));
        }
        Ok(())
    }
}
