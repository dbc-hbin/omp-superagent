use serde::Deserialize;
use serde_json::{Value, json};

use crate::commands::accepts_text;

use super::{
    Effect, State,
    model::{Interaction, snowflake, snowflake_time},
};

#[derive(Deserialize)]
struct ChatCommand {
    name: String,
    #[serde(rename = "type")]
    kind: u8,
    #[serde(default)]
    options: Vec<OptionValue>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OptionValue {
    name: String,
    #[serde(rename = "type")]
    kind: u8,
    value: String,
}

fn command(data: &Value) -> Option<String> {
    let command = ChatCommand::deserialize(data).ok()?;
    if command.kind != 1 {
        return None;
    }
    let accepts_argument = accepts_text(&command.name)?;
    match command.options.as_slice() {
        [] => Some(format!("/{}", command.name)),
        [option] if accepts_argument && option.kind == 3 && option.name == "text" => {
            let text = option.value.trim();
            if text.is_empty() {
                Some(format!("/{}", command.name))
            } else {
                Some(format!("/{} {text}", command.name))
            }
        }
        _ => None,
    }
}

impl State {
    pub(super) async fn command_interaction(
        &self,
        interaction: &Interaction,
        ready: bool,
    ) -> Effect<()> {
        let deny = |message| self.rest.ephemeral(interaction, message);
        let Some(identity) = self
            .identity
            .get()
            .filter(|identity| identity.application == interaction.application_id)
        else {
            return deny("This command does not belong to the connected Superagent application.")
                .await;
        };
        if interaction
            .user()
            .is_none_or(|user| user.id != self.config.owner_id || user.bot)
        {
            return deny("Only the configured owner can use Superagent commands.").await;
        }
        let Some(text) = interaction.data.as_ref().and_then(command) else {
            return deny("This Superagent command or its options are unsupported or stale; nothing was admitted.").await;
        };
        if !ready {
            return deny("Superagent is not ready to accept commands; nothing was admitted.").await;
        }
        let Some(channel_id) = interaction.channel_id().filter(|id| snowflake(id)) else {
            return deny("This conversation is not authorized for Superagent commands.").await;
        };
        let Some(received_at) = snowflake_time(&interaction.id) else {
            return deny("This conversation is not authorized for Superagent commands.").await;
        };
        if !self.allowed_guild(interaction.guild_id.as_deref()) {
            return deny("This conversation is not authorized for Superagent commands.").await;
        }
        let channel = match self
            .channel_by_id(channel_id, false)
            .await
            .and_then(|channel| channel.sendable())
        {
            Ok(channel) => channel,
            Err(_) => {
                return deny(
                    "Superagent could not verify this conversation; nothing was admitted.",
                )
                .await;
            }
        };
        let Ok(route) = self.route_for(&channel) else {
            return deny("This conversation is not authorized for Superagent commands.").await;
        };
        if self.group_route(&route) {
            return Ok(());
        }
        if route.guild_id != interaction.guild_id {
            return deny("This conversation is not authorized for Superagent commands.").await;
        }
        let context = self.context_snapshot(&route, Some(&channel)).await;
        let event = json!({"kind": "message", "input": {
            "id": format!("discord:{}:interaction:{}", identity.account, interaction.id),
            "route": route, "messageId": null, "interactionId": interaction.id, "text": text,
            "receivedAt": received_at, "attachments": [], "discordContext": context
        }});
        if self.admit(event).is_err() {
            return deny("Superagent could not confirm acceptance. This command may already have been recorded; no automatic retry was made. Check this conversation and service status before taking further action.").await;
        }
        deny("Superagent accepted this command. Its result will be sent to this conversation.")
            .await
    }
}
