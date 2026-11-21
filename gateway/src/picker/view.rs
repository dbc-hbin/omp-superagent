use super::{Entry, Item, Kind, Menu, PAGE, PREFIX, Screen};

const LABEL_LIMIT: usize = 68; // Slack plain_text has a 75-character limit.
const TEXT_LIMIT: usize = 2_000; // Discord component-message content limit.

impl Entry {
    pub(super) fn view(&self, screen: Screen) -> Option<Menu> {
        let count = self.count(screen)?;
        if count == 0 {
            return None;
        }
        let group = screen.group.and_then(|index| self.picker.groups.get(index));
        let title = match (self.picker.kind, group) {
            (Kind::Effort, _) => "Choose thinking effort".to_owned(),
            (Kind::Model, Some(group)) => {
                format!("Choose a model from {}", shorten(&group.label, LABEL_LIMIT))
            }
            (Kind::Model, None) => "Choose a model provider".to_owned(),
        };
        let control =
            |action: &str| format!("{PREFIX}{}:{}:{action}", self.token.simple(), screen.revision);
        let first = screen.page.saturating_mul(PAGE);
        let mut options = Vec::with_capacity(PAGE);
        for index in first..count.min(first.saturating_add(PAGE)) {
            let current = self.picker.current.as_ref();
            let current_provider = self.picker.current_provider.as_deref();
            let (label, is_current) = match group {
                Some(group) => {
                    let label = group.options.get(index)?;
                    (label, current == Some(label) && current_provider.is_none_or(|p| p == group.label))
                }
                None => {
                    let provider = self.picker.groups.get(index)?;
                    (
                        &provider.label,
                        current_provider.map_or_else(
                            || current.is_some_and(|model| provider.options.contains(model)),
                            |name| name == provider.label,
                        ),
                    )
                }
            };
            let label = shorten(label, LABEL_LIMIT);
            let value = index.to_string();
            options.push(Item {
                label: if is_current { format!("✓ {label}") } else { label },
                control: control(&value),
                value,
            });
        }
        let pages = count.div_ceil(PAGE);
        let mut buttons = Vec::new();
        let mut button = |action: &str, label: &str| {
            buttons.push(Item {
                label: label.to_owned(),
                control: control(action),
                value: action.to_owned(),
            });
        };
        if screen.page > 0 {
            button("p", "Previous");
        }
        if screen.page < pages.saturating_sub(1) {
            button("n", "Next");
        }
        if matches!(self.picker.kind, Kind::Model) && screen.group.is_some() {
            button("b", "Back");
        }
        button("x", "Cancel");
        let footer = format!("\n\n{title} · page {}/{pages}", screen.page + 1);
        let status = shorten(&self.text, TEXT_LIMIT.saturating_sub(footer.encode_utf16().count()));
        let text = format!("{status}{footer}");
        Some(Menu {
            text,
            select_id: control("s"),
            options,
            buttons,
        })
    }
}

fn shorten(label: &str, limit: usize) -> String {
    if label.encode_utf16().count() <= limit {
        return label.to_owned();
    }
    let (front, back) = (limit.saturating_sub(1) / 2, limit / 2);
    let head = label
        .chars()
        .scan(front, |space, ch| {
            *space = space.checked_sub(ch.len_utf16())?;
            Some(ch)
        })
        .collect::<String>();
    let tail = label
        .chars()
        .rev()
        .scan(back, |space, ch| {
            *space = space.checked_sub(ch.len_utf16())?;
            Some(ch)
        })
        .collect::<Vec<_>>();
    head.chars().chain(['…']).chain(tail.into_iter().rev()).collect()
}
