use super::{Entry, Item, Kind, Menu, PAGE, PREFIX, Screen, Stage};

const LABEL_LIMIT: usize = 68; // Slack plain_text has a 75-character limit.
const TEXT_LIMIT: usize = 2_000; // Discord component-message content limit.

impl Entry {
    pub(super) fn view(&self, screen: Screen) -> Option<Menu> {
        let control =
            |action: &str| format!("{PREFIX}{}:{}:{action}", self.token.simple(), screen.revision);
        let button = |action: &str, label: &str| Item {
            label: label.to_owned(),
            control: control(action),
            value: action.to_owned(),
        };
        let (group, page) = match screen.stage {
            Stage::Browse { group, page } => (group, page),
            Stage::ConfirmUsageReset { option } => {
                let label = self.picker.groups.first()?.options.get(option)?;
                let footer = format!("\n\nUse one currently available OMP usage reset credit for:\n{label}");
                return Some(Menu {
                    text: self.with_footer(&footer)?,
                    select_id: control("s"),
                    options: Vec::new(),
                    buttons: vec![
                        button("c", "Confirm"),
                        button("b", "Back"),
                        button("x", "Cancel"),
                    ],
                });
            }
        };
        let count = self.count(group)?;
        if count == 0 {
            return None;
        }
        let group = group.and_then(|index| self.picker.groups.get(index));
        let title = match (self.picker.kind, group) {
            (Kind::Effort, _) => "Choose thinking effort".to_owned(),
            (Kind::UsageReset, _) => "Choose an account for a usage reset".to_owned(),
            (Kind::Model, Some(group)) => {
                format!("Choose a model from {}", shorten(&group.label, LABEL_LIMIT))
            }
            (Kind::Model, None) => "Choose a model provider".to_owned(),
        };
        let first = page.saturating_mul(PAGE);
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
        if page > 0 {
            buttons.push(button("p", "Previous"));
        }
        if page < pages.saturating_sub(1) {
            buttons.push(button("n", "Next"));
        }
        if self.picker.kind == Kind::Model && group.is_some() {
            buttons.push(button("b", "Back"));
        }
        buttons.push(button("x", "Cancel"));
        let footer = format!("\n\n{title} · page {}/{pages}", page + 1);
        Some(Menu {
            text: self.with_footer(&footer)?,
            select_id: control("s"),
            options,
            buttons,
        })
    }

    fn with_footer(&self, footer: &str) -> Option<String> {
        let remaining = TEXT_LIMIT.checked_sub(footer.encode_utf16().count())?;
        if remaining == 0 {
            return Some(footer.to_owned());
        }
        let status = shorten(&self.text, remaining);
        Some(format!("{status}{footer}"))
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
