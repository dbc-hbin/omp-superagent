use std::ops::Range;

use serde::{Deserialize, Deserializer};
use serde_json::Value;

#[derive(Deserialize)]
pub(super) struct Entity {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default, deserialize_with = "utf16_index")]
    pub offset: Option<usize>,
    #[serde(default, deserialize_with = "utf16_index")]
    pub length: Option<usize>,
}

// An unrecognized bound invalidates the routing view, not the owner message.
fn utf16_index<'de, D: Deserializer<'de>>(value: D) -> Result<Option<usize>, D::Error> {
    Ok(Value::deserialize(value)?
        .as_u64()
        .and_then(|value| usize::try_from(value).ok()))
}

pub(super) fn routing_text(
    original: &str,
    normalized: &str,
    entities: &[Entity],
    command_suffix: Range<usize>,
) -> Option<String> {
    let mut excluded = entities
        .iter()
        .filter(|entity| {
            matches!(
                entity.kind.as_str(),
                "blockquote" | "expandable_blockquote" | "pre" | "code"
            )
        })
        .peekable();
    if excluded.peek().is_none() {
        return Some(normalized.to_owned());
    }

    // Only Unicode scalar boundaries are valid. A UTF-16 offset in the middle
    // of a surrogate pair has no corresponding UTF-8 index.
    let mut boundaries = Vec::with_capacity(original.len() + 1);
    for (byte, ch) in original.char_indices() {
        boundaries.push(Some(byte));
        if ch.len_utf16() == 2 {
            boundaries.push(None);
        }
    }
    boundaries.push(Some(original.len()));
    let after_command =
        |byte: usize| byte - byte.saturating_sub(command_suffix.start).min(command_suffix.len());
    let mut spans = Vec::new();
    for entity in excluded {
        let offset = entity.offset?;
        let length = entity.length.filter(|length| *length > 0)?;
        let start = after_command((*boundaries.get(offset)?)?);
        let end = after_command((*boundaries.get(offset.checked_add(length)?)?)?);
        if start < end {
            spans.push(start..end);
        }
    }
    spans.sort_unstable_by_key(|span| span.start);

    let mut view = String::with_capacity(normalized.len());
    let mut cursor = 0;
    for span in spans {
        if span.end <= cursor {
            continue;
        }
        if span.start > cursor {
            view.push_str(normalized.get(cursor..span.start)?);
        }
        let masked = normalized.get(span.start.max(cursor)..span.end)?;
        // A redaction is a separator, not a concatenation of neighboring
        // words. Keep line boundaries without carrying any quoted prose.
        if masked.contains(['\r', '\n']) {
            view.extend(masked.chars().filter(|ch| *ch == '\r' || *ch == '\n'));
        } else if !view.is_empty() && !view.ends_with(char::is_whitespace) {
            view.push(' ');
        }
        cursor = span.end;
    }
    view.push_str(normalized.get(cursor..)?);
    if view.trim().is_empty() {
        view.clear();
    }
    Some(view)
}
