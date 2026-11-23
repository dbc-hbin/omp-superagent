use serde_json::{Value, json};

use crate::picker::{ACCEPTED, CANCELLED, Change, EXPIRED, Menu};

use super::model::{Interaction, Route, read, snowflake};
use super::responses::Callback;
use super::rest::no_mentions;
use super::{Effect, State};

pub(super) fn components(menu: &Menu) -> Value {
    let mut rows = Vec::with_capacity(2);
    if !menu.options.is_empty() {
        let options = menu
            .options
            .iter()
            .map(|item| json!({"label": item.label, "value": item.value}))
            .collect::<Vec<_>>();
        rows.push(json!({
            "type": 1,
            "components": [{"type": 3, "custom_id": menu.select_id, "options": options}],
        }));
    }
    let buttons = menu
        .buttons
        .iter()
        .map(|item| json!({"type": 2, "style": 2, "label": item.label, "custom_id": item.control}))
        .collect::<Vec<_>>();
    rows.push(json!({"type": 1, "components": buttons}));
    Value::Array(rows)
}

impl State {
    pub(super) async fn picker_interaction(
        &self,
        interaction: &Interaction,
        callback: &Callback,
        ready: bool,
    ) -> Effect<()> {
        if interaction.kind != 3
            || !ready
            || !snowflake(&interaction.id)
            || interaction.user().is_none_or(|user| user.id != self.config.owner_id || user.bot)
        {
            return self.rest.ephemeral(interaction, EXPIRED).await;
        }
        let value = match (callback.component_type, callback.values.as_slice()) {
            (Some(2), []) => None,
            (Some(3), [value]) => Some(value.as_str()),
            _ => return self.rest.ephemeral(interaction, EXPIRED).await,
        };
        // The next interaction may arrive before the HTTP receipt for either
        // the initial send or a just-displayed page. Check after that receipt.
        let _delivery = self.ctx.pickers.delivery().await;
        let change = self.ctx.pickers.choose(&callback.custom_id, value, |route, id| {
                let Ok(route) = read::<Route>(route) else {
                    return false;
                };
                !self.group_route(&route)
                    && self.assert_route(&route).is_ok()
                    && interaction.guild_id == route.guild_id
                    && interaction.channel_id() == Some(route.destination())
                    && interaction.message.as_ref().is_some_and(|source| {
                        source.id == id
                            && source.belongs(&route)
                            && source.components.iter().flat_map(|row| &row.components).any(|component| {
                                component.custom_id.as_deref() == Some(callback.custom_id.as_str())
                            })
                    })
        })?;
        let Some(change) = change else {
            return self.rest.ephemeral(interaction, EXPIRED).await;
        };
        match change {
            Change::Show(navigation) => {
                let menu = &navigation.menu;
                let result = self.edit_picker(interaction, &menu.text, components(menu)).await;
                self.ctx.pickers.navigated(&navigation, &result)?;
                result
            }
            Change::Cancel => self.edit_picker(interaction, CANCELLED, json!([])).await,
            Change::Select(selection) => {
                self.ctx.admit_picker(&selection).await?;
                self.edit_picker(interaction, ACCEPTED, json!([])).await
            }
        }
    }

    async fn edit_picker(&self, interaction: &Interaction, content: &str, controls: Value) -> Effect<()> {
        self.rest.callback(interaction, json!({
            "type": 7,
            "data": {"content": content, "components": controls, "allowed_mentions": no_mentions()}
        })).await
    }
}
