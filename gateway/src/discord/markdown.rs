use std::borrow::Cow;

use unicode_width::UnicodeWidthStr;

use super::model::utf16;

#[derive(Clone, Copy)]
pub(super) enum Align {
    Left,
    Center,
    Right,
}

fn split_row(line: &str) -> Option<Vec<String>> {
    let mut cells = Vec::new();
    let mut cell = String::new();
    let mut input = line.chars().peekable();
    let mut ticks = 0;
    while let Some(ch) = input.next() {
        match ch {
            '\\' if input.next_if_eq(&'|').is_some() => cell.push('|'),
            '`' => {
                let mut run = 1;
                cell.push('`');
                while input.next_if_eq(&'`').is_some() {
                    cell.push('`');
                    run += 1;
                }
                if ticks == run {
                    ticks = 0;
                } else if ticks == 0 {
                    ticks = run;
                }
            }
            '|' if ticks == 0 => cells.push(std::mem::take(&mut cell)),
            _ => cell.push(ch),
        }
    }
    if cells.is_empty() {
        return None;
    }
    if cells.first().is_some_and(|s| s.trim().is_empty()) {
        cells.remove(0);
    }
    if !cell.trim().is_empty() {
        cells.push(cell);
    }
    (!cells.is_empty()).then(|| cells.into_iter().map(|s| s.trim().to_owned()).collect())
}

fn delimiters(line: &str) -> Option<Vec<Align>> {
    split_row(line)?
        .iter()
        .map(|cell| {
            let middle = cell.strip_prefix(':').unwrap_or(cell);
            let middle = middle.strip_suffix(':').unwrap_or(middle);
            if middle.is_empty() || !middle.bytes().all(|b| b == b'-') {
                return None;
            }
            Some(match (cell.starts_with(':'), cell.ends_with(':')) {
                (true, true) => Align::Center,
                (false, true) => Align::Right,
                (_, false) => Align::Left,
            })
        })
        .collect()
}

fn unindent(line: &str) -> Option<&str> {
    let trimmed = line.trim_start_matches(' ');
    (line.len() - trimmed.len() <= 3).then_some(trimmed)
}

fn fence(line: &str) -> Option<(u8, usize, &str)> {
    let line = unindent(line)?;
    let ch = *line.as_bytes().first()?;
    if !matches!(ch, b'`' | b'~') {
        return None;
    }
    let count = line.bytes().take_while(|b| *b == ch).count();
    (count >= 3).then(|| (ch, count, &line[count..]))
}

pub(super) fn opens(line: &str) -> Option<(u8, usize, &str)> {
    // A backtick fence's info string cannot contain backticks. In particular,
    // a line that starts and ends with the same backtick run is inline code.
    fence(line).filter(|(ch, _, rest)| *ch != b'`' || !rest.contains('`'))
}

pub(super) fn closes(line: &str, ch: u8, length: usize) -> bool {
    fence(line).is_some_and(|(kind, count, rest)| {
        kind == ch && count >= length && rest.trim_matches([' ', '\t', '\r']).is_empty()
    })
}

fn block_start(line: &str) -> bool {
    let Some(line) = unindent(line) else {
        return false;
    };
    let Some(first) = line.as_bytes().first() else {
        return false;
    };
    let marker = match first {
        b'>' => return true,
        b'#' => {
            let length = line.bytes().take_while(|b| *b == b'#').count();
            if length > 6 {
                return false;
            }
            length
        }
        b'-' | b'+' | b'*' => 1,
        b'0'..=b'9' => {
            let length = line.bytes().take_while(u8::is_ascii_digit).count();
            if length > 9 || !matches!(line.as_bytes().get(length), Some(b'.' | b')')) {
                return false;
            }
            length + 1
        }
        _ => return false,
    };
    matches!(line.as_bytes().get(marker), None | Some(b' ' | b'\t'))
}

pub(super) fn table(rows: &[Vec<String>], aligns: &[Align], budget: usize) -> Option<String> {
    let mut widths = vec![3; aligns.len()];
    let mut extra_bytes = 0;
    for row in rows {
        for (column, cell) in row.iter().enumerate() {
            let width = cell.width();
            if let Some(previous) = widths.get_mut(column) {
                *previous = width.max(*previous);
            } else {
                widths.push(width.max(3));
            }
            extra_bytes += cell.len().saturating_sub(width);
        }
    }
    let row_width = 3 * widths.len() + 1 + widths.iter().sum::<usize>();
    let bytes = 8 + rows.len() + (rows.len() + 1) * row_width + extra_bytes;
    if bytes > budget {
        return None;
    }
    let mut out = String::with_capacity(bytes);
    out.push_str("```\n");
    for (index, row) in rows.iter().enumerate() {
        out.push('|');
        for (column, width) in widths.iter().copied().enumerate() {
            let cell = row.get(column).map_or("", String::as_str);
            let missing = width.saturating_sub(cell.width());
            let left = match aligns.get(column).copied().unwrap_or(Align::Left) {
                Align::Left => 0,
                Align::Center => missing / 2,
                Align::Right => missing,
            };
            out.extend(std::iter::repeat_n(' ', left + 1));
            out.push_str(cell);
            out.extend(std::iter::repeat_n(' ', missing - left + 1));
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

pub(super) fn render(text: &str, budget: usize) -> Cow<'_, str> {
    if !text.contains('|') || text.len() > budget {
        return Cow::Borrowed(text);
    }
    let mut lines = text.split('\n').peekable();
    let mut pieces = Vec::new();
    let mut bytes = text.len();
    let mut fenced = None;
    while let Some(line) = lines.next() {
        if let Some((ch, length)) = fenced {
            if closes(line, ch, length) {
                fenced = None;
            }
        } else if let Some((ch, length, _)) = opens(line) {
            fenced = Some((ch, length));
        } else if !block_start(line)
            && let Some(delimiter) = lines.peek().copied()
            && let Some(aligns) = delimiters(delimiter)
            && let Some(header) = split_row(line)
            && aligns.len() == header.len()
        {
            lines.next();
            let mut rows = vec![header];
            let mut old_bytes = line.len() + 1 + delimiter.len();
            while let Some(next) = lines.peek().copied() {
                if block_start(next) || fence(next).is_some() {
                    break;
                }
                let Some(row) = split_row(next) else {
                    break;
                };
                lines.next();
                rows.push(row);
                old_bytes += 1 + next.len();
            }
            let Some(rendered) = table(&rows, &aligns, budget - bytes + old_bytes) else {
                return Cow::Borrowed(text);
            };
            bytes = bytes - old_bytes + rendered.len();
            pieces.push(Cow::Owned(rendered));
            continue;
        }
        pieces.push(Cow::Borrowed(line));
    }
    if pieces.iter().all(|piece| matches!(piece, Cow::Borrowed(_))) {
        Cow::Borrowed(text)
    } else {
        Cow::Owned(pieces.join("\n"))
    }
}

/// An open code fence: marker byte, marker length and the original opening line.
type Open<'a> = Option<(u8, usize, &'a str)>;

fn open_fence<'a>(text: &'a str, mut open: Open<'a>) -> Open<'a> {
    for line in text.split('\n') {
        if let Some((ch, length, _)) = open {
            if closes(line, ch, length) {
                open = None;
            }
        } else if let Some((ch, length, _)) = opens(line) {
            let opener = unindent(line).unwrap_or(line).trim_end_matches('\r');
            open = Some((ch, length, opener));
        }
    }
    open
}

/// Cuts at most `budget` UTF-16 units from `text`, preferring the last paragraph,
/// line, then space or tab boundary. One newline of a line boundary is dropped,
/// so a blank line inside a reopened code fence survives.
fn cut(text: &str, budget: usize) -> (&str, &str) {
    let mut units = 0;
    let Some(end) = text.char_indices().find_map(|(index, ch)| {
        units += ch.len_utf16();
        (units > budget).then_some(index)
    }) else {
        return (text, "");
    };
    let boundary = |at: &usize| !text[..*at].trim().is_empty();
    for separator in ["\n\n", "\n"] {
        let window = text.get(..end + separator.len()).unwrap_or(&text[..end]);
        if let Some(at) = window.rfind(separator).filter(boundary) {
            return (&text[..at], &text[at + 1..]);
        }
    }
    let window = text.get(..=end).unwrap_or(&text[..end]);
    if let Some(at) = window.rfind([' ', '\t']).filter(boundary) {
        return (&text[..at], &text[at + 1..]);
    }
    text.split_at(end)
}

/// Splits rendered Markdown into at most `parts` messages of at most `limit`
/// UTF-16 units. A code fence crossing a boundary is closed at the end of one
/// part and reopened with its original opening line (and language) in the next.
/// Returns `None` when the text needs more parts or cannot be split cleanly.
pub(super) fn split(text: &str, limit: usize, parts: usize) -> Option<Vec<String>> {
    let mut chunks = Vec::new();
    let mut rest = text;
    let mut open: Open<'_> = None;
    while !rest.trim().is_empty() {
        if chunks.len() == parts {
            return None;
        }
        let prefix = open.map_or(0, |(_, _, opener)| utf16(opener) + 1);
        let mut reserve = 0;
        let (body, next, state) = loop {
            let budget = limit
                .checked_sub(prefix + reserve)
                .filter(|units| *units > 0)?;
            let (body, next) = cut(rest, budget);
            if !next.is_empty() && !rest[body.len()..].starts_with('\n') {
                let line_start = body.rfind('\n').map_or(0, |at| at + 1);
                let original = rest[line_start..].split('\n').next().unwrap_or_default();
                let tail = next.split('\n').next().unwrap_or_default();
                let head = &body[line_start..];
                // A cut within a line can turn inline backticks into a fence
                // by removing their closing run or moving them to column zero.
                let changes_fence = match open_fence(&body[..line_start], open) {
                    Some((ch, length, _)) => [original, head, tail]
                        .into_iter()
                        .any(|line| closes(line, ch, length)),
                    None => [original, head, tail]
                        .into_iter()
                        .any(|line| opens(line).is_some()),
                };
                if changes_fence {
                    return None;
                }
            }
            let state = open_fence(body, open);
            let closer = state.map_or(0, |(_, length, _)| length + 1);
            if closer <= reserve {
                break (body, next, state);
            }
            reserve = closer;
        };
        if body.trim().is_empty() {
            return None;
        }
        let mut chunk = String::with_capacity(body.len() + 2 * prefix);
        if let Some((_, _, opener)) = open {
            chunk.push_str(opener);
            chunk.push('\n');
        }
        chunk.push_str(body);
        if let Some((ch, length, _)) = state {
            chunk.push('\n');
            chunk.extend(std::iter::repeat_n(char::from(ch), length));
        }
        chunks.push(chunk);
        open = state;
        // A paragraph or line boundary needs no leading blank line in the next
        // message; inside a reopened fence the lines are content.
        rest = if state.is_some() {
            next
        } else {
            next.trim_start_matches(['\n', '\r'])
        };
    }
    (!chunks.is_empty()).then_some(chunks)
}

#[cfg(test)]
#[path = "markdown_tests.rs"]
mod tests;
