mod wire;

use std::fmt::Write as _;

use super::{
    approval::Progress,
    dialog::{Dialog, Marker, Question},
    effects::TEXT_LIMIT,
};

pub(super) const UNSUPPORTED: &str = "Request cancelled: this dialog cannot safely be represented in Telegram. Use the local OMP interface.";

pub(super) use wire::{Keyboard, View};
use wire::{Button, truncate};

pub(super) struct Renderer<'a> {
    pub token: &'a str,
    pub stamp: &'a str,
    pub owner_context: Option<&'a str>,
}

impl Renderer<'_> {
    pub fn draw(&self, dialog: &Dialog, progress: &Progress) -> Option<View> {
        let mut keyboard = Keyboard::default();
        let text = match dialog {
            Dialog::Confirm { title, message } => {
                keyboard.inline_keyboard.push(vec![
                    self.button("yes", "Confirm".into()),
                    self.button("no", "Decline".into()),
                ]);
                format!("{title}\n\n{message}")
            }
            Dialog::Input(input) | Dialog::Editor(input) => {
                let mut text = format!(
                    "{}\nReply directly to THIS card with your complete response (not secret).",
                    input.title
                );
                if let Some(placeholder) =
                    input.placeholder.as_deref().filter(|text| !text.is_empty())
                {
                    write!(text, "\n{placeholder}").ok()?;
                }
                if let Some(prefill) = &input.prefill {
                    write!(text, "\nCurrent content:\n{prefill}").ok()?;
                }
                text
            }
            Dialog::Select(selection) => {
                let mut text = format!(
                    "{}\nChoose one row; marked selections are OMP's current state.\n",
                    selection.title
                );
                for (index, label) in selection.options.iter().enumerate() {
                    let marker = match selection
                        .selection_marker
                        .as_ref()
                        .filter(|_| index < selection.markable_count())
                    {
                        Some(Marker::Checkbox)
                            if selection
                                .checked_indices
                                .as_ref()
                                .is_some_and(|checked| checked.contains(&index)) =>
                        {
                            "[x] "
                        }
                        Some(Marker::Checkbox) => "[ ] ",
                        Some(Marker::Radio) => "( ) ",
                        None => "",
                    };
                    let line = format!("{}. {marker}{label}", index + 1);
                    keyboard
                        .inline_keyboard
                        .push(vec![self.button(&format!("pick-{index}"), line.clone())]);
                    if index > 0 {
                        text.push('\n');
                    }
                    text.push_str(&line);
                    if selection.initial_index == Some(index) {
                        text.push_str(" (initial focus)");
                    }
                    if let Some(description) = selection
                        .option_details
                        .get(index)
                        .and_then(|detail| detail.description.as_deref())
                        .filter(|text| !text.is_empty())
                    {
                        write!(text, " — {description}").ok()?;
                    }
                }
                text
            }
            Dialog::Ask { questions } => {
                let question = questions.get(progress.question)?;
                let page = Page::from_progress(progress, questions.len());
                self.ask(question, &page, &mut keyboard)?
            }
        };
        self.complete(text, keyboard, matches!(dialog, Dialog::Ask { .. }))
    }

    pub fn future_questions_fit(&self, dialog: &Dialog, progress: &Progress) -> bool {
        let Dialog::Ask { questions } = dialog else {
            return true;
        };
        questions
            .iter()
            .enumerate()
            .skip(progress.question)
            .all(|(index, question)| {
                let page = Page {
                    index,
                    count: questions.len(),
                    selection: Selection::All,
                    input_length: Some(TEXT_LIMIT),
                };
                let mut keyboard = Keyboard::default();
                self.ask(question, &page, &mut keyboard)
                    .and_then(|text| self.complete(text, keyboard, true))
                    .is_some()
            })
    }

    fn button(&self, action: &str, text: String) -> Button {
        Button {
            text,
            callback_data: format!("omp:{}:{action}", self.token),
        }
    }

    fn complete(&self, mut text: String, mut keyboard: Keyboard, ask: bool) -> Option<View> {
        keyboard
            .inline_keyboard
            .push(vec![self.button("cancel", "Cancel".into())]);
        write!(text, "\n\nOMP card {}", self.stamp).ok()?;
        let units = text.encode_utf16().count();
        if units > TEXT_LIMIT
            || keyboard.inline_keyboard.len() > 100
            || keyboard.inline_keyboard.iter().flatten().any(|button| {
                button.text.encode_utf16().count() > 64 || button.callback_data.len() > 64
            })
        {
            return None;
        }
        const PREFIX: &str = "Why your decision is needed: ";
        let remaining = TEXT_LIMIT.saturating_sub(units + PREFIX.len() + 2);
        if let Some(context) = self
            .owner_context
            .filter(|value| !value.is_empty() && ask && remaining > 0)
        {
            text = format!("{PREFIX}{}\n\n{text}", truncate(context, remaining));
        }
        Some(View { text, keyboard })
    }

    fn ask(&self, question: &Question, page: &Page<'_>, keyboard: &mut Keyboard) -> Option<String> {
        let index = page.index;
        let mut text = format!("Question {}/{}", index + 1, page.count);
        if let Some(header) = question.header.as_deref().filter(|value| !value.is_empty()) {
            write!(text, " — {header}").ok()?;
        }
        let instructions = if question.multi {
            "Toggle multiple choices and/or reply directly to THIS card with free text."
        } else {
            "Choose one option OR reply directly to THIS card with free text."
        };
        write!(text, "\n{}\n{instructions}\n", question.question).ok()?;
        for (choice, option) in question.options.iter().enumerate() {
            let marker = if page.selection.includes(&option.label) {
                "[x] "
            } else {
                ""
            };
            keyboard.inline_keyboard.push(vec![self.button(
                &format!("q{index}-{choice}"),
                format!("{marker}{}. {}", choice + 1, option.label),
            )]);
            if choice > 0 {
                text.push('\n');
            }
            write!(text, "{}. {}", choice + 1, option.label).ok()?;
            if question.recommended == Some(choice) {
                text.push_str(" (recommended, not preselected)");
            }
            if let Some(description) = option
                .description
                .as_deref()
                .filter(|value| !value.is_empty())
            {
                write!(text, " — {description}").ok()?;
            }
            if let Some(preview) = option.preview.as_deref().filter(|value| !value.is_empty()) {
                write!(text, "\n{preview}").ok()?;
            }
        }
        if let Some(units) = page.input_length {
            write!(
                text,
                "\nFree text received: {units} characters (stored in full)."
            )
            .ok()?;
        }
        let next = if index + 1 == page.count {
            "Submit all answers"
        } else {
            "Next question"
        };
        keyboard
            .inline_keyboard
            .push(vec![self.button(&format!("next-{index}"), next.to_owned())]);
        Some(text)
    }
}

struct Page<'a> {
    index: usize,
    count: usize,
    selection: Selection<'a>,
    input_length: Option<usize>,
}

impl<'a> Page<'a> {
    fn from_progress(progress: &'a Progress, count: usize) -> Self {
        Self {
            index: progress.question,
            count,
            selection: Selection::Saved(&progress.selected),
            input_length: progress
                .custom_input
                .as_deref()
                .map(|text| text.encode_utf16().count()),
        }
    }
}

enum Selection<'a> {
    Saved(&'a [String]),
    All,
}

impl Selection<'_> {
    fn includes(&self, label: &str) -> bool {
        match self {
            Self::Saved(labels) => labels.iter().any(|value| value == label),
            Self::All => true,
        }
    }
}
