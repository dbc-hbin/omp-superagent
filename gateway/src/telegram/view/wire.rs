use serde::Serialize;

use crate::{
    picker::{Item, Menu},
    telegram::effects::TEXT_LIMIT,
};

#[derive(Serialize)]
pub(super) struct Button {
    pub text: String,
    pub callback_data: String,
}

#[derive(Default, Serialize)]
pub(in crate::telegram) struct Keyboard {
    pub(super) inline_keyboard: Vec<Vec<Button>>,
}

pub(in crate::telegram) struct View {
    pub text: String,
    pub keyboard: Keyboard,
}

impl View {
    pub(in crate::telegram) fn from_picker(menu: &Menu) -> Self {
        let button = |item: &Item| Button {
            text: truncate(&item.label, 64),
            callback_data: item.control.clone(),
        };
        let inline_keyboard = menu
            .options
            .iter()
            .map(|item| vec![button(item)])
            .chain(std::iter::once(menu.buttons.iter().map(button).collect()))
            .collect();
        Self {
            text: truncate(&menu.text, TEXT_LIMIT),
            keyboard: Keyboard { inline_keyboard },
        }
    }
}

pub(super) fn truncate(text: &str, units: usize) -> String {
    if text.encode_utf16().count() <= units {
        return text.to_owned();
    }
    let mut remaining = units - 1;
    let mut prefix = String::new();
    for ch in text.chars() {
        let Some(next) = remaining.checked_sub(ch.len_utf16()) else {
            break;
        };
        prefix.push(ch);
        remaining = next;
    }
    prefix.push('…');
    prefix
}
