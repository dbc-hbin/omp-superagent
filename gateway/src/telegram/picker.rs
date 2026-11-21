use crate::{
    adapter::EffectError,
    picker::{ACCEPTED, CANCELLED, Change, EXPIRED},
};

use super::{
    Core,
    ingress::Callback,
    model::{Identity, Route, decode},
    view::{Keyboard, View},
};

impl Core {
    pub(super) async fn handle_picker(
        &self,
        me: &Identity,
        query: &Callback,
        control: &str,
    ) -> Result<(), EffectError> {
        let Some(message) = query.message.as_ref().filter(|message| {
            self.policy.owner(query.from)
                && message.reply_markup.as_ref().is_some_and(|markup| {
                    markup
                        .inline_keyboard
                        .iter()
                        .flatten()
                        .any(|button| button.callback_data.as_deref() == Some(control))
                })
        }) else {
            self.ack_callback(&query.id, Some(EXPIRED)).await;
            return Ok(());
        };
        let Some(route) = self
            .policy
            .route(me, &message.chat, message.message_thread_id)
        else {
            self.ack_callback(&query.id, Some(EXPIRED)).await;
            return Ok(());
        };
        let Ok(receipt) = self.receipt(me, &route, message) else {
            self.ack_callback(&query.id, Some(EXPIRED)).await;
            return Ok(());
        };
        let change = {
            let _delivery = self.ctx.pickers.delivery().await;
            self.ctx.pickers.choose(control, None, |original, id| {
                id == receipt.as_str()
                    && decode::<Route>(original).is_ok_and(|original| original.same_physical(&route))
            })?
        };
        let text = match change {
            Some(Change::Show(navigation)) => {
                let view = View::from_picker(&navigation.menu);
                self.ack_callback(&query.id, None).await;
                let result = match self.write_card(&route, Some(message.message_id), &view).await {
                    Ok(edited) if self.receipt(me, &route, &edited).is_ok_and(|id| id == receipt) => Ok(()),
                    Ok(_) => Err(EffectError::uncertain("Telegram picker update receipt mismatch")),
                    Err(error) if error.unchanged() => Ok(()),
                    Err(error) => Err(error.into()),
                };
                self.ctx.pickers.navigated(&navigation, &result)?;
                if result.is_err() {
                    eprintln!("Telegram selection card update did not complete");
                }
                return Ok(());
            }
            Some(Change::Cancel) => CANCELLED,
            Some(Change::Select(selection)) => {
                self.ctx.admit_picker(&selection).await?;
                ACCEPTED
            }
            None => {
                self.ack_callback(&query.id, Some(EXPIRED)).await;
                return Ok(());
            }
        };
        self.ack_callback(&query.id, None).await;
        if let Err(error) = self.write_card(&route, Some(message.message_id), &closed(text)).await
            && !error.unchanged()
        {
            eprintln!("Telegram selection card closure did not complete");
        }
        Ok(())
    }
}

fn closed(text: &str) -> View {
    View {
        text: text.to_owned(),
        keyboard: Keyboard::default(),
    }
}
