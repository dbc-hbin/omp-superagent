/**
 * Markdown table rendering for the Discord transport.
 *
 * Discord has no pipe-table support: a table sent verbatim arrives as literal
 * `| a | b |` rows. Labeled lists preserve inline Markdown and wrap on
 * narrow screens without requiring horizontal scrolling.
 */

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t\r]*$/;
const BLOCK_START = /^ {0,3}(?:>|#{1,6}(?:[ \t]|$)|(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$))/;
const INDENTED_CODE = /^(?: {4}| {0,3}\t)/;
const DELIMITER_CELL = /^:?-+:?$/;
const LIST_MARKER = /^ {0,3}(?:[-+*]|\d{1,9}[.)])(?=[ \t]|$)/;
const THEMATIC_BREAK = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,})\r?$/;

function opensFence(line: string): string | undefined {
  const match = FENCE_OPEN.exec(line);
  const marker = match?.[1];
  // An info string containing backticks makes a backtick opener inline code.
  if (match && marker?.startsWith("`") && line.slice(match[0].length).includes("`")) return undefined;
  return marker;
}

function relativeLine(line: string | undefined, margin: number): string | undefined {
  const indent = line?.match(/^ */)?.[0].length ?? 0;
  return indent >= margin ? line?.slice(margin) : undefined;
}

function listMargin(line: string): number | undefined {
  const marker = LIST_MARKER.exec(line)?.[0];
  if (!marker || THEMATIC_BREAK.test(line)) return undefined;
  const spaces = line.slice(marker.length).match(/^ */)?.[0].length ?? 0;
  return marker.length + (spaces >= 1 && spaces <= 4 ? spaces : 1);
}

function indentColumns(line: string): number {
  let columns = 0;
  for (const char of line) {
    if (char === " ") columns++;
    else if (char === "\t") columns += 4 - columns % 4;
    else break;
  }
  return columns;
}

/**
 * Split on structural pipes only. Inside inline code a table's pipe escape
 * becomes a literal pipe; outside code Discord still interprets the escape.
 */
function splitRow(line: string | undefined): string[] | null {
  if (line === undefined || !line.includes("|") || INDENTED_CODE.test(line)) return null;
  // Unmatched backtick runs are literal prose and must not hide separators.
  const lastTicks = new Map<number, number>();
  for (const match of line.matchAll(/`+/g)) lastTicks.set(match[0].length, match.index);
  const cells: string[] = [];
  let start = 0;
  let pipe = false;
  let decoded = "";
  let ticks = 0;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    const following = line[index + 1];
    if (ticks === 0 && char === "\\" && (following === "|" || following === "`" || following === "\\")) {
      index++;
    } else if (ticks !== 0 && char === "\\" && following === "|") {
      decoded += line.slice(start, index) + "|";
      index++;
      start = index + 1;
    } else if (char === "`") {
      const first = index;
      while (line[index + 1] === "`") index++;
      const run = index - first + 1;
      if (ticks === run) ticks = 0;
      else if (ticks === 0) {
        if ((lastTicks.get(run) ?? first) > first) ticks = run;
        else {
          decoded += line.slice(start, first) + "\\`".repeat(run);
          start = index + 1;
        }
      }
    } else if (char === "|" && ticks === 0) {
      const cell = (decoded + line.slice(start, index)).trim();
      if (pipe || cell !== "") cells.push(cell);
      pipe = true;
      decoded = "";
      start = index + 1;
    }
  }
  if (!pipe) return null;
  const tail = (decoded + line.slice(start)).trim();
  if (tail !== "") cells.push(tail);
  return cells.length > 0 ? cells : null;
}

/**
 * Rewrite Markdown pipe tables as one labeled list item per row.
 *
 * Everything else passes through byte for byte. If the complete message would
 * exceed the byte budget, return the original text for the existing delivery path.
 */
export function renderDiscordMarkdown(text: string, maxBytes: number): string {
  if (!text.includes("|") || Buffer.byteLength(text, "utf8") > maxBytes) return text;
  const lines = text.split("\n");
  const out: string[] = [];
  let remaining = maxBytes;
  const append = (line: string): boolean => {
    const bytes = Buffer.byteLength(line, "utf8") + (out.length === 0 ? 0 : 1);
    if (bytes > remaining) return false;
    remaining -= bytes;
    out.push(line);
    return true;
  };
  const margins: number[] = [];
  let fence: { readonly marker: string; readonly margin: number } | undefined;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (fence) {
      const columns = indentColumns(line);
      if (columns < fence.margin && line.trim()) {
        fence = undefined; // The containing list item ended.
      } else {
        const close = columns >= fence.margin && columns < fence.margin + 4
          ? FENCE_CLOSE.exec(line.replace(/^[ \t]*/, ""))?.[1]
          : undefined;
        if (close && close[0] === fence.marker[0] && close.length >= fence.marker.length) fence = undefined;
        if (!append(line)) return text;
        continue;
      }
    }
    if (line.trim()) {
      let margin = margins.at(-1);
      while (margin !== undefined && relativeLine(line, margin) === undefined) {
        margins.pop();
        margin = margins.at(-1);
      }
    }
    const margin = margins.at(-1) ?? 0;
    const scoped = relativeLine(line, margin) ?? line;
    const marker = opensFence(scoped);
    const indent = listMargin(scoped);
    if (marker) {
      fence = { marker, margin };
    } else if (indent !== undefined) {
      const itemMargin = margin + indent;
      margins.push(itemMargin);
      const itemFence = opensFence(scoped.slice(indent));
      if (itemFence) fence = { marker: itemFence, margin: itemMargin };
    }
    const delimiter = !marker && indent === undefined && scoped.includes("|") && !BLOCK_START.test(scoped)
      ? splitRow(relativeLine(lines[index + 1], margin))
      : null;
    const header = delimiter?.every(cell => DELIMITER_CELL.test(cell)) ? splitRow(scoped) : null;
    if (!header || header.length !== delimiter?.length) {
      if (!append(line)) return text;
      continue;
    }
    if (out.at(-1)?.trim() && !append("")) return text;
    const indentation = line.slice(0, line.length - scoped.length);
    const first = index + 2;
    const bodyRow = (at: number) => {
      const row = relativeLine(lines[at], margin);
      return row === undefined || BLOCK_START.test(row) || opensFence(row) ? null : splitRow(row);
    };
    let next = first;
    let row = bodyRow(next);
    do {
      if (next !== first && !append("")) return text;
      const columns = Math.max(header.length, row?.length ?? 0);
      for (let column = 0; column < columns; column++) {
        const prefix = column === 0 ? "- " : "  - ";
        const label = header[column] || `Column ${column + 1}`;
        const value = row?.[column];
        if (!append(`${indentation}${prefix}${label}:${value ? ` ${value}` : ""}`)) return text;
      }
      if (row) row = bodyRow(++next);
    } while (row);
    let following = next;
    while (following < lines.length && !lines[following]?.trim()) following++;
    const firstFollowing = lines[following];
    if (firstFollowing !== undefined && indentColumns(firstFollowing) >= margin + 4
      && (!append("") || !append(`${indentation}---`))) return text;
    if (lines[next]?.trim() && !append("")) return text;
    index = next - 1;
  }
  return out.join("\n");
}
