//! ```card fences holding a json-render spec become Discord embeds.
//!
//! The Bun reference renderer (`extractDiscordCards` in
//! `test/oracles/bun-gateway/discord-markdown.ts`) and this renderer use the same
//! fixture (`test/fixtures/discord-cards.json`).
//! An invalid spec, or one that would exceed the message's embed limits, stays
//! verbatim as its original code block.

use std::borrow::Cow;
use std::collections::HashSet;

use serde_json::{Map, Value, json};

use unicode_width::UnicodeWidthStr;

use super::markdown::{closes, indent_columns, list_margin, opens, relative_line};
use super::model::utf16;

// Discord's documented embed limits, counted in UTF-16 units like message text.
const EMBEDS_PER_MESSAGE: usize = 10;
const EMBED_TOTAL: usize = 6_000;
const EMBED_TITLE: usize = 256;
const EMBED_DESCRIPTION: usize = 4_096;
const EMBED_FIELDS: usize = 25;
const FIELD_NAME: usize = 256;
const FIELD_VALUE: usize = 1_024;
const IMAGE_URL: usize = 2_048;
const CARD_DEPTH: usize = 16;

/// Budget the final UTF-16 length before padding the grid.
fn table_utf16(rows: &[Vec<String>], budget: usize) -> Option<String> {
    let mut widths = vec![3usize; rows.first()?.len()];
    let mut extra = 0usize;
    let mut less = 0usize;
    for row in rows {
        for (width, cell) in widths.iter_mut().zip(row) {
            let columns = cell.width();
            *width = (*width).max(columns);
            let units = utf16(cell);
            if units >= columns {
                extra = extra.checked_add(units - columns)?;
            } else {
                less = less.checked_add(columns - units)?;
            }
        }
    }
    let sum = widths.iter().try_fold(0usize, |sum, &width| sum.checked_add(width))?;
    let row_len = widths.len().checked_mul(3)?.checked_add(2)?.checked_add(sum)?;
    // A line per row plus the separator, surrounded by fenced code markers.
    let planned = rows.len().checked_add(1)?.checked_mul(row_len)?.checked_add(7)?
        .checked_sub(less)?.checked_add(extra)?;
    if planned > budget {
        return None;
    }
    let mut out = String::with_capacity(planned);
    out.push_str("```\n");
    for (index, row) in rows.iter().enumerate() {
        out.push('|');
        for (&width, cell) in widths.iter().zip(row) {
            out.push(' ');
            out.push_str(cell);
            out.extend(std::iter::repeat_n(' ', width - cell.width() + 1));
            out.push('|');
        }
        out.push('\n');
        if index == 0 {
            out.push('|');
            for &width in &widths {
                out.push(' ');
                out.extend(std::iter::repeat_n('-', width));
                out.push_str(" |");
            }
            out.push('\n');
        }
    }
    out.push_str("```");
    Some(out)
}

struct Invalid;
type Card<T> = Result<T, Invalid>;

#[derive(Default)]
struct Embed {
    title: Option<String>,
    color: Option<u64>,
    parts: Vec<String>,
    fields: Vec<(String, String, bool)>,
    image: Option<String>,
}

impl Embed {
    fn description(&self) -> Option<String> {
        (!self.parts.is_empty()).then(|| self.parts.join("\n"))
    }

    fn size(&self) -> usize {
        self.title.as_deref().map_or(0, utf16)
            + self.description().as_deref().map_or(0, utf16)
            + self
                .fields
                .iter()
                .map(|(name, value, _)| utf16(name) + utf16(value))
                .sum::<usize>()
    }

    fn json(&self) -> Value {
        let mut embed = Map::new();
        if let Some(title) = &self.title {
            embed.insert("title".into(), json!(title));
        }
        if let Some(description) = self.description() {
            embed.insert("description".into(), json!(description));
        }
        if let Some(color) = self.color {
            embed.insert("color".into(), json!(color));
        }
        if !self.fields.is_empty() {
            let fields = self.fields.iter().map(|(name, value, inline)| {
                json!({ "name": name, "value": value, "inline": inline })
            });
            embed.insert("fields".into(), Value::Array(fields.collect()));
        }
        if let Some(url) = &self.image {
            embed.insert("image".into(), json!({ "url": url }));
        }
        Value::Object(embed)
    }
}

fn text(props: &Map<String, Value>, key: &str, required: bool) -> Card<Option<String>> {
    match props.get(key) {
        None if !required => Ok(None),
        Some(Value::String(value)) if !value.trim().is_empty() => Ok(Some(value.clone())),
        _ => Err(Invalid),
    }
}

fn color(value: &Value) -> Card<u64> {
    let number = match value {
        Value::Number(number) => number
            .as_u64()
            .or_else(|| number.as_f64().filter(|f| f.fract() == 0.0 && *f >= 0.0).map(|f| f as u64)),
        Value::String(hex) if hex.len() == 7 && hex.starts_with('#') => hex[1..]
            .bytes()
            .all(|b| b.is_ascii_hexdigit())
            .then(|| u64::from_str_radix(&hex[1..], 16).ok())
            .flatten(),
        _ => None,
    };
    number.filter(|value| *value <= 0xff_ffff).ok_or(Invalid)
}

fn strings(value: Option<&Value>) -> Card<Vec<String>> {
    value
        .and_then(Value::as_array)
        .ok_or(Invalid)?
        .iter()
        .map(|cell| cell.as_str().map(str::to_owned).ok_or(Invalid))
        .collect()
}

struct Walk<'a> {
    elements: &'a Map<String, Value>,
    seen: HashSet<&'a str>,
    embed: Embed,
}

impl<'a> Walk<'a> {
    fn visit(&mut self, id: &'a Value, depth: usize, parent: &str) -> Card<()> {
        let id = id.as_str().ok_or(Invalid)?;
        if depth > CARD_DEPTH || !self.seen.insert(id) {
            return Err(Invalid);
        }
        let element = self.elements.get(id).and_then(Value::as_object).ok_or(Invalid)?;
        let empty = Map::new();
        let props = match element.get("props") {
            None => &empty,
            Some(value) => value.as_object().ok_or(Invalid)?,
        };
        let children: &[Value] = match element.get("children") {
            None => &[],
            Some(value) => value.as_array().ok_or(Invalid)?,
        };
        let kind = element.get("type").and_then(Value::as_str).ok_or(Invalid)?;
        if (depth == 0 && kind != "Card") || (parent == "Fields" && kind != "Field") {
            return Err(Invalid);
        }
        match kind {
            "Card" | "Section" => {
                let title = text(props, "title", false)?;
                if depth == 0 {
                    self.embed.title = title;
                    if let Some(value) = props.get("color") {
                        self.embed.color = Some(color(value)?);
                    }
                } else if let Some(title) = title {
                    self.embed.parts.push(format!("**{title}**"));
                }
                if kind == "Card"
                    && let Some(description) = text(props, "description", false)?
                {
                    self.embed.parts.push(description);
                }
            }
            "Text" => self.embed.parts.extend(text(props, "text", true)?),
            "Fields" => {}
            "Field" => {
                let inline = match props.get("inline") {
                    None => false,
                    Some(value) => value.as_bool().ok_or(Invalid)?,
                };
                let name = text(props, "label", true)?.ok_or(Invalid)?;
                let value = text(props, "value", true)?.ok_or(Invalid)?;
                self.embed.fields.push((name, value, inline));
            }
            "Table" => {
                let columns = strings(props.get("columns"))?;
                let rows = props.get("rows").and_then(Value::as_array).ok_or(Invalid)?;
                if columns.is_empty() {
                    return Err(Invalid);
                }
                let mut grid = vec![columns];
                for row in rows {
                    let row = strings(Some(row))?;
                    if row.len() != grid[0].len() {
                        return Err(Invalid);
                    }
                    grid.push(row);
                }
                let used = self
                    .embed
                    .parts
                    .iter()
                    .map(|part| utf16(part))
                    .sum::<usize>()
                    .saturating_add(self.embed.parts.len());
                let remaining = EMBED_DESCRIPTION.saturating_sub(used);
                self.embed
                    .parts
                    .push(table_utf16(&grid, remaining).ok_or(Invalid)?);
            }
            "Divider" => self.embed.parts.push("\u{2500}".repeat(16)),
            "Image" => {
                let url = text(props, "url", true)?.ok_or(Invalid)?;
                if self.embed.image.is_some()
                    || !url.starts_with("https://")
                    || url.chars().any(char::is_whitespace)
                    || utf16(&url) > IMAGE_URL
                    || reqwest::Url::parse(&url).is_err()
                {
                    return Err(Invalid);
                }
                self.embed.image = Some(url);
            }
            _ => return Err(Invalid),
        }
        if !children.is_empty() && !matches!(kind, "Card" | "Section" | "Fields") {
            return Err(Invalid);
        }
        for child in children {
            self.visit(child, depth + 1, kind)?;
        }
        Ok(())
    }
}

fn card(source: &str) -> Card<Embed> {
    let spec: Value = serde_json::from_str(source).map_err(|_| Invalid)?;
    let spec = spec.as_object().ok_or(Invalid)?;
    let elements = spec.get("elements").and_then(Value::as_object).ok_or(Invalid)?;
    let root = spec.get("root").filter(|root| root.is_string()).ok_or(Invalid)?;
    let mut walk = Walk { elements, seen: HashSet::new(), embed: Embed::default() };
    walk.visit(root, 0, "")?;
    let embed = walk.embed;
    let description = embed.description();
    if embed.title.as_deref().map_or(0, utf16) > EMBED_TITLE
        || description.as_deref().map_or(0, utf16) > EMBED_DESCRIPTION
        || embed.fields.len() > EMBED_FIELDS
        || embed
            .fields
            .iter()
            .any(|(name, value, _)| utf16(name) > FIELD_NAME || utf16(value) > FIELD_VALUE)
        || embed.size() > EMBED_TOTAL
        || (embed.title.is_none() && description.is_none() && embed.fields.is_empty() && embed.image.is_none())
    {
        return Err(Invalid);
    }
    Ok(embed)
}

/// Moves valid ```card fences out of `text` into embed objects. Fences nested
/// in another code block are content, not cards.
pub(super) fn extract(text: &str) -> (Cow<'_, str>, Vec<Value>) {
    if !text.contains("card") {
        return (Cow::Borrowed(text), Vec::new());
    }
    let lines: Vec<&str> = text.split('\n').collect();
    let mut out = Vec::with_capacity(lines.len());
    let mut embeds = Vec::new();
    let mut total = 0;
    let mut fenced = None;
    let mut margins = Vec::new();
    let mut index = 0;
    while index < lines.len() {
        let line = lines[index];
        index += 1;
        let columns = indent_columns(line);
        if fenced.is_some_and(|(_, _, margin)| columns < margin) && !line.trim().is_empty() {
            fenced = None;
        }
        if let Some((ch, length, margin)) = fenced {
            if (margin..margin + 4).contains(&columns)
                && closes(line.trim_start_matches([' ', '\t']), ch, length)
            {
                fenced = None;
            }
            out.push(line);
            continue;
        }
        if !line.trim().is_empty() {
            while margins.last().is_some_and(|&margin| relative_line(line, margin).is_none()) {
                margins.pop();
            }
        }
        let margin = margins.last().copied().unwrap_or(0);
        let scoped = relative_line(line, margin).unwrap_or(line);
        let Some((ch, length, info)) = opens(scoped) else {
            if let Some(indent) = list_margin(scoped) {
                let item_margin = margin + indent;
                margins.push(item_margin);
                if let Some((ch, length, _)) = scoped.get(indent..).and_then(opens) {
                    fenced = Some((ch, length, item_margin));
                }
            }
            out.push(line);
            continue;
        };
        if margin == 0 && info.trim_matches([' ', '\t', '\r']) == "card"
            && embeds.len() < EMBEDS_PER_MESSAGE
            && let Some(end) = (index..lines.len()).find(|at| closes(lines[*at], ch, length))
            && let Ok(embed) = card(&lines[index..end].join("\n"))
            && total + embed.size() <= EMBED_TOTAL
        {
            total += embed.size();
            embeds.push(embed.json());
            index = end + 1;
            continue;
        }
        fenced = Some((ch, length, margin));
        out.push(line);
    }
    if embeds.is_empty() {
        return (Cow::Borrowed(text), embeds);
    }
    let occupied = |line: &&str| !line.trim_matches([' ', '\t', '\r']).is_empty();
    let start = out.iter().position(occupied).unwrap_or(out.len());
    let end = out.iter().rposition(occupied).map_or(start, |index| index + 1);
    (Cow::Owned(out[start..end].join("\n")), embeds)
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;
    use serde_json::Value;

    #[derive(Deserialize)]
    struct Case {
        name: String,
        text: String,
        content: String,
        embeds: Vec<Value>,
    }

    #[test]
    fn shared_card_fixtures_match_the_typescript_renderer() {
        let cases: Vec<Case> =
            serde_json::from_str(include_str!("../../../test/fixtures/discord-cards.json")).unwrap();
        assert!(!cases.is_empty());
        for case in cases {
            let (content, embeds) = super::extract(&case.text);
            assert_eq!(content, case.content, "{}", case.name);
            assert_eq!(embeds, case.embeds, "{}", case.name);
        }
    }

    #[test]
    fn oversized_sparse_table_card_rejects_before_allocating_and_preserves_fence() {
        let mut rows = vec![vec!["x".repeat(10_000), "y".to_owned()]];
        rows.extend(std::iter::repeat_n(vec!["1".to_owned(), "2".to_owned()], 1_000));
        let spec = serde_json::json!({
            "root": "card",
            "elements": {
                "card": { "type": "Card", "children": ["tbl"] },
                "tbl": { "type": "Table", "props": { "columns": ["a", "b"], "rows": rows } },
            },
        });
        let source = format!("```card\n{spec}\n```");
        let (content, embeds) = super::extract(&source);
        assert_eq!(content, source);
        assert!(embeds.is_empty());

        let boundary_rows = vec![vec!["이름".to_owned(), "값".to_owned()], vec!["가".to_owned(), "1".to_owned()]];
        let rendered = super::table_utf16(&boundary_rows, usize::MAX).unwrap();
        let exact = rendered.encode_utf16().count();
        assert!(super::table_utf16(&boundary_rows, exact).is_some());
        assert!(super::table_utf16(&boundary_rows, exact - 1).is_none());
    }
}
