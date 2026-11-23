use std::borrow::Cow;
use std::collections::HashMap;
use std::ops::Range;

use super::model::utf16;

fn finish_cell<'a>(decoded: &mut String, tail: &'a str) -> Cow<'a, str> {
    if decoded.is_empty() {
        Cow::Borrowed(tail.trim())
    } else {
        decoded.push_str(tail);
        Cow::Owned(std::mem::take(decoded).trim().to_owned())
    }
}

fn split_row(line: &str) -> Option<Vec<Cow<'_, str>>> {
    let line = unindent(line)?;
    if !line.contains('|') {
        return None;
    }
    // A run without a same-length closer is literal prose, not a code span.
    // Index the last raw run of each length so checking closers stays linear.
    let mut last_ticks = HashMap::new();
    if line.contains('`') {
        let mut bytes = line.bytes().enumerate().peekable();
        while let Some((at, _)) = bytes.find(|&(_, byte)| byte == b'`') {
            let mut run = 1;
            while bytes.next_if(|&(_, byte)| byte == b'`').is_some() {
                run += 1;
            }
            last_ticks.insert(run, at);
        }
    }
    let mut cells = Vec::new();
    let mut start = 0;
    let mut decoded = String::new();
    let mut input = line.char_indices().peekable();
    let mut ticks = 0;
    while let Some((at, ch)) = input.next() {
        match ch {
            '\\' if ticks == 0 => {
                // Skip structural meaning, not the original Markdown bytes.
                input.next_if(|&(_, next)| matches!(next, '\\' | '|' | '`'));
            }
            '\\' if input.next_if(|&(_, next)| next == '|').is_some() => {
                // The table escape is not part of the inline code value.
                decoded.push_str(&line[start..at]);
                decoded.push('|');
                start = at + 2;
            }
            '`' => {
                let mut run = 1;
                while input.next_if(|&(_, next)| next == '`').is_some() {
                    run += 1;
                }
                if ticks == run {
                    ticks = 0;
                } else if ticks == 0 {
                    if last_ticks.get(&run).is_some_and(|&last| last > at) {
                        ticks = run;
                    } else {
                        // A literal run must not pair with another cell's run
                        // once the label and value are on the same line.
                        decoded.push_str(&line[start..at]);
                        for _ in 0..run {
                            decoded.push_str("\\`");
                        }
                        start = at + run;
                    }
                }
            }
            '|' if ticks == 0 => {
                cells.push(finish_cell(&mut decoded, &line[start..at]));
                start = at + 1;
            }
            _ => {}
        }
    }
    if cells.is_empty() {
        return None;
    }
    if cells.first().is_some_and(|cell| cell.is_empty()) {
        cells.remove(0);
    }
    let cell = finish_cell(&mut decoded, &line[start..]);
    if !cell.is_empty() {
        cells.push(cell);
    }
    (!cells.is_empty()).then_some(cells)
}

fn delimiter_columns(line: &str) -> Option<usize> {
    let cells = split_row(line)?;
    cells
        .iter()
        .all(|cell| {
            let middle = cell.strip_prefix(':').unwrap_or(cell.as_ref());
            let middle = middle.strip_suffix(':').unwrap_or(middle);
            !middle.is_empty() && middle.bytes().all(|b| b == b'-')
        })
        .then_some(cells.len())
}

fn unindent(line: &str) -> Option<&str> {
    let trimmed = line.trim_start_matches(' ');
    (line.len() - trimmed.len() <= 3 && !trimmed.starts_with('\t')).then_some(trimmed)
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

fn list_marker(line: &str) -> Option<usize> {
    let marker = match *line.as_bytes().first()? {
        b'-' | b'+' | b'*' => 1,
        b'0'..=b'9' => {
            let length = line.bytes().take_while(u8::is_ascii_digit).count();
            if length > 9 || !matches!(line.as_bytes().get(length), Some(b'.' | b')')) {
                return None;
            }
            length + 1
        }
        _ => return None,
    };
    matches!(line.as_bytes().get(marker), None | Some(b' ' | b'\t')).then_some(marker)
}

fn block_start(line: &str) -> bool {
    let Some(line) = unindent(line) else {
        return false;
    };
    let hashes = line.bytes().take_while(|b| *b == b'#').count();
    line.starts_with('>')
        || ((1..=6).contains(&hashes)
            && matches!(line.as_bytes().get(hashes), None | Some(b' ' | b'\t')))
        || list_marker(line).is_some()
}

pub(super) fn relative_line(line: &str, margin: usize) -> Option<&str> {
    let indent = line.len() - line.trim_start_matches(' ').len();
    (indent >= margin).then(|| &line[margin..])
}

pub(super) fn indent_columns(line: &str) -> usize {
    line.bytes()
        .take_while(|byte| matches!(byte, b' ' | b'\t'))
        .fold(0, |column, byte| {
            if byte == b'\t' {
                column + (4 - column % 4)
            } else {
                column + 1
            }
        })
}

pub(super) fn list_margin(line: &str) -> Option<usize> {
    let item = unindent(line)?;
    if let Some(&marker @ (b'-' | b'*')) = item.as_bytes().first()
        && item.bytes().filter(|&byte| byte == marker).count() >= 3
        && item.bytes().all(|byte| byte == marker || matches!(byte, b' ' | b'\t' | b'\r'))
    {
        return None; // A thematic break does not open a list.
    }
    let content = &item[list_marker(item)?..];
    let spaces = content.bytes().take_while(|b| *b == b' ').count();
    let padding = if (1..=4).contains(&spaces) { spaces } else { 1 };
    Some(line.len() - content.len() + padding)
}

fn table(
    header: &[Cow<'_, str>],
    rows: &[Vec<Cow<'_, str>>],
    (before, after): (bool, bool),
    indent: &str,
    before_indented_code: bool,
    budget: usize,
) -> Option<String> {
    let mut out = String::new();
    if before {
        out.push('\n');
    }
    // Header-only tables still show their column labels.
    let rows = rows
        .iter()
        .map(Vec::as_slice)
        .chain(rows.is_empty().then_some(&[][..]));
    for (index, row) in rows.enumerate() {
        if index > 0 {
            out.push_str("\n\n");
        }
        for column in 0..header.len().max(row.len()) {
            let prefix = if column == 0 { "- " } else { "  - " };
            if column > 0 {
                out.push('\n');
            }
            let label = match header.get(column).filter(|label| !label.is_empty()) {
                Some(label) => Cow::Borrowed(label.as_ref()),
                None => Cow::Owned(format!("Column {}", column + 1)),
            };
            let value = row.get(column).map_or("", Cow::as_ref);
            let space = if value.is_empty() { "" } else { " " };
            if out.len() + indent.len() + prefix.len() + label.len() + 1 + space.len() + value.len()
                > budget
            {
                return None;
            }
            out.push_str(indent);
            out.push_str(prefix);
            out.push_str(&label);
            out.push(':');
            out.push_str(space);
            out.push_str(value);
        }
    }
    if before_indented_code {
        // Otherwise the next verbatim code block can become a continuation of
        // the generated list. A thematic break closes it without editing code.
        out.push_str("\n\n");
        out.push_str(indent);
        out.push_str("---");
    }
    if after {
        out.push('\n');
    }
    (out.len() <= budget).then_some(out)
}

pub(super) struct Rendered<'a> {
    pub text: Cow<'a, str>,
    tables: Vec<Range<usize>>,
}

impl<'a> Rendered<'a> {
    fn plain(text: &'a str) -> Self {
        Self {
            text: Cow::Borrowed(text),
            tables: Vec::new(),
        }
    }
}

pub(super) fn render(text: &str, budget: usize) -> Rendered<'_> {
    if !text.contains('|') || text.len() > budget {
        return Rendered::plain(text);
    }
    let mut lines = text.split('\n').peekable();
    let mut pieces = Vec::new();
    let mut tables = Vec::new();
    let mut bytes = 0;
    let mut fenced = None;
    let mut margins = Vec::new();
    while let Some(line) = lines.next() {
        let offset = bytes + usize::from(!pieces.is_empty());
        if fenced.is_some_and(|(_, _, margin)| indent_columns(line) < margin)
            && !line.trim().is_empty()
        {
            fenced = None; // The containing list item ended.
        }
        if let Some((ch, length, margin)) = fenced {
            let columns = indent_columns(line);
            if (margin..margin + 4).contains(&columns)
                && closes(line.trim_start_matches([' ', '\t']), ch, length)
            {
                fenced = None;
            }
        } else {
            if !line.trim().is_empty() {
                while margins
                    .last()
                    .is_some_and(|&margin| relative_line(line, margin).is_none())
                {
                    margins.pop();
                }
            }
            // Four spaces may be a list's content margin rather than code.
            let margin = margins.last().copied().unwrap_or(0);
            let scoped = relative_line(line, margin).unwrap_or(line);
            if let Some((ch, length, _)) = opens(scoped) {
                fenced = Some((ch, length, margin));
            } else if let Some(indent) = list_margin(scoped) {
                let item_margin = margin + indent;
                margins.push(item_margin);
                if let Some((ch, length, _)) = scoped.get(indent..).and_then(opens) {
                    fenced = Some((ch, length, item_margin));
                }
            } else if scoped.contains('|')
                && !block_start(scoped)
                && let Some(delimiter) = lines
                    .peek()
                    .copied()
                    .and_then(|line| relative_line(line, margin))
                && let Some(columns) = delimiter_columns(delimiter)
                && let Some(header) = split_row(scoped)
                && columns == header.len()
            {
                lines.next();
                let mut rows = Vec::new();
                while let Some(next) = lines
                    .peek()
                    .copied()
                    .and_then(|line| relative_line(line, margin))
                {
                    if block_start(next) || opens(next).is_some() {
                        break;
                    }
                    let Some(row) = split_row(next) else {
                        break;
                    };
                    lines.next();
                    rows.push(row);
                }
                let boundaries = (
                    pieces
                        .last()
                        .is_some_and(|line: &Cow<'_, str>| !line.trim().is_empty()),
                    lines.peek().is_some_and(|line| !line.trim().is_empty()),
                );
                let Some(remaining) = budget.checked_sub(offset) else {
                    return Rendered::plain(text);
                };
                let indent = &line[..line.len() - scoped.len()];
                let before_indented_code = lines
                    .clone()
                    .find(|line| !line.trim().is_empty())
                    .is_some_and(|line| indent_columns(line) >= margin + 4);
                let Some(rendered) =
                    table(&header, &rows, boundaries, indent, before_indented_code, remaining)
                else {
                    return Rendered::plain(text);
                };
                bytes = offset + rendered.len();
                tables.push(offset..bytes);
                pieces.push(Cow::Owned(rendered));
                continue;
            }
        }
        bytes = offset + line.len();
        if bytes > budget {
            return Rendered::plain(text);
        }
        pieces.push(Cow::Borrowed(line));
    }
    if tables.is_empty() {
        Rendered::plain(text)
    } else {
        Rendered {
            text: Cow::Owned(pieces.join("\n")),
            tables,
        }
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
pub(super) fn split(rendered: &Rendered<'_>, limit: usize, parts: usize) -> Option<Vec<String>> {
    let text = rendered.text.as_ref();
    let mut chunks = Vec::new();
    let mut rest = text;
    let mut open: Open<'_> = None;
    while !rest.trim().is_empty() {
        if chunks.len() == parts {
            return None;
        }
        let offset = text.len() - rest.len();
        // A nested table field at the start of a new message would lose
        // its parent list and become an indented code block.
        if rest.starts_with("    ") && rendered.tables.iter().any(|table| table.contains(&offset))
        {
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
                // Rows can split between labeled fields, but not inside one:
                // a space or hard cut could destroy its link or inline Markdown.
                if rendered.tables.iter().any(|table| table.contains(&(offset + line_start))) {
                    return None;
                }
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
