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

export interface DiscordEmbedField { name: string; value: string; inline: boolean }
export interface DiscordEmbed {
  title?: string;
  description?: string;
  color?: number;
  fields?: DiscordEmbedField[];
  image?: { url: string };
}

/** Discord's documented embed limits, counted in UTF-16 units like message text. */
const EMBEDS_PER_MESSAGE = 10;
const EMBED_TOTAL = 6000;
const EMBED_TITLE = 256;
const EMBED_DESCRIPTION = 4096;
const EMBED_FIELDS = 25;
const FIELD_NAME = 256;
const FIELD_VALUE = 1024;
const IMAGE_URL = 2048;
const CARD_DEPTH = 16;
const DIVIDER = "\u2500".repeat(16);
const CARD_OPEN = /^ {0,3}(`{3,}|~{3,})[ \t]*card[ \t\r]*$/;

class InvalidCard extends Error {}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(props: Record<string, unknown>, key: string, required: boolean): string | undefined {
  const value = props[key];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new InvalidCard();
  return value;
}

function embedSize(embed: DiscordEmbed): number {
  return (embed.title?.length ?? 0) + (embed.description?.length ?? 0)
    + (embed.fields ?? []).reduce((sum, field) => sum + field.name.length + field.value.length, 0);
}

/**
 * Convert one json-render spec (`{ root, elements }`) whose root is a Card.
 * Any structural error, unknown component, reuse/cycle or Discord limit makes
 * the whole spec invalid; the caller then keeps the original fence as text.
 */
function cardEmbed(source: string): DiscordEmbed {
  let spec: unknown;
  try { spec = JSON.parse(source); } catch { throw new InvalidCard(); }
  const root = object(spec);
  const elements = root && object(root.elements);
  if (!root || !elements || typeof root.root !== "string") throw new InvalidCard();
  const parts: string[] = [];
  const fields: DiscordEmbedField[] = [];
  const embed: DiscordEmbed = {};
  const seen = new Set<string>();
  const visit = (id: unknown, depth: number, parent: string): void => {
    if (typeof id !== "string" || depth > CARD_DEPTH || seen.has(id) || !Object.hasOwn(elements, id)) throw new InvalidCard();
    seen.add(id);
    const element = object(elements[id]);
    if (!element) throw new InvalidCard();
    const props = element.props === undefined ? {} : object(element.props);
    const children = element.children === undefined ? [] : element.children;
    if (!props || !Array.isArray(children)) throw new InvalidCard();
    const type = element.type;
    if (depth === 0 ? type !== "Card" : parent === "Fields" ? type !== "Field" : false) throw new InvalidCard();
    switch (type) {
      case "Card":
      case "Section": {
        const title = text(props, "title", false);
        if (depth === 0) {
          if (title !== undefined) embed.title = title;
          const color = props.color;
          if (typeof color === "number" && Number.isSafeInteger(color) && color >= 0 && color <= 0xffffff) embed.color = color;
          else if (typeof color === "string" && /^#[0-9a-fA-F]{6}$/.test(color)) embed.color = Number.parseInt(color.slice(1), 16);
          else if (color !== undefined) throw new InvalidCard();
        } else if (title !== undefined) parts.push(`**${title}**`);
        const description = type === "Card" ? text(props, "description", false) : undefined;
        if (description !== undefined) parts.push(description);
        break;
      }
      case "Text": parts.push(text(props, "text", true)!); break;
      case "Fields": break;
      case "Field": {
        const inline = props.inline === undefined ? false : props.inline;
        if (typeof inline !== "boolean") throw new InvalidCard();
        fields.push({ name: text(props, "label", true)!, value: text(props, "value", true)!, inline });
        break;
      }
      case "Table": {
        const columns = props.columns;
        const rows = props.rows;
        if (!Array.isArray(columns) || columns.length === 0 || !columns.every(cell => typeof cell === "string")
          || !Array.isArray(rows) || !rows.every(row => Array.isArray(row) && row.length === columns.length
            && row.every(cell => typeof cell === "string"))) throw new InvalidCard();
        const used = parts.reduce((sum, part) => sum + part.length, 0) + parts.length;
        const table = cardTable([columns as string[], ...rows as string[][]], EMBED_DESCRIPTION - used);
        if (!table) throw new InvalidCard();
        parts.push(table);
        break;
      }
      case "Divider": parts.push(DIVIDER); break;
      case "Image": {
        const url = text(props, "url", true)!;
        if (embed.image || !url.startsWith("https://") || /\s/.test(url) || url.length > IMAGE_URL || !URL.canParse(url)) throw new InvalidCard();
        embed.image = { url };
        break;
      }
      default: throw new InvalidCard();
    }
    if (children.length > 0 && !["Card", "Section", "Fields"].includes(type)) throw new InvalidCard();
    for (const child of children) visit(child, depth + 1, type);
  };
  visit(root.root, 0, "");
  if (parts.length > 0) embed.description = parts.join("\n");
  if (fields.length > 0) embed.fields = fields;
  if ((embed.title?.length ?? 0) > EMBED_TITLE || (embed.description?.length ?? 0) > EMBED_DESCRIPTION
    || fields.length > EMBED_FIELDS || fields.some(field => field.name.length > FIELD_NAME || field.value.length > FIELD_VALUE)
    || embedSize(embed) > EMBED_TOTAL || !embed.title && !embed.description && !embed.fields && !embed.image) throw new InvalidCard();
  return embed;
}

function cardTable(rows: string[][], budget: number): string | null {
  const widths = rows[0]!.map(() => 3);
  let delta = 0;
  for (const row of rows) {
    for (const [i, cell] of row.entries()) {
      const columns = Bun.stringWidth(cell);
      widths[i] = Math.max(widths[i]!, columns);
      delta += cell.length - columns;
    }
  }
  const rowLength = 2 + 3 * widths.length + widths.reduce((sum, width) => sum + width, 0);
  if (7 + (rows.length + 1) * rowLength + delta > budget) return null;
  const lines = ["```"];
  for (const [i, row] of rows.entries()) {
    lines.push("| " + row.map((cell, column) => cell + " ".repeat(widths[column]! - Bun.stringWidth(cell))).join(" | ") + " |");
    if (i === 0) lines.push("| " + widths.map(width => "-".repeat(width)).join(" | ") + " |");
  }
  lines.push("```");
  return lines.join("\n");
}

/**
 * Move valid ```card fences out of the text and into Discord embeds.
 *
 * Fences nested in another code block are content, not cards. A spec that is
 * invalid, or would exceed the message's 10 embeds or 6000 embed characters,
 * stays verbatim as its original code block, which is also what Telegram and
 * Slack show because they never call this.
 */
export function extractDiscordCards(source: string): { text: string; embeds: DiscordEmbed[] } {
  if (!source.includes("card")) return { text: source, embeds: [] };
  const lines = source.split("\n");
  const out: string[] = [];
  const embeds: DiscordEmbed[] = [];
  let total = 0;
  const margins: number[] = [];
  let fence: { marker: string; margin: number } | undefined;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const columns = indentColumns(line);
    if (fence && columns < fence.margin && line.trim()) fence = undefined;
    if (fence) {
      const close = columns >= fence.margin && columns < fence.margin + 4
        ? FENCE_CLOSE.exec(line.replace(/^[ \t]*/, ""))?.[1] : undefined;
      if (close && close[0] === fence.marker[0] && close.length >= fence.marker.length) fence = undefined;
      out.push(line);
      continue;
    }
    if (line.trim()) {
      while (margins.length && relativeLine(line, margins.at(-1)!) === undefined) margins.pop();
    }
    const margin = margins.at(-1) ?? 0;
    const scoped = relativeLine(line, margin) ?? line;
    const card = margin === 0 ? CARD_OPEN.exec(scoped)?.[1] : undefined;
    if (card) {
      let end = index + 1;
      for (; end < lines.length; end++) {
        const close = FENCE_CLOSE.exec(lines[end]!)?.[1];
        if (close && close[0] === card[0] && close.length >= card.length) break;
      }
      if (end < lines.length && embeds.length < EMBEDS_PER_MESSAGE) {
        try {
          const embed = cardEmbed(lines.slice(index + 1, end).join("\n"));
          if (total + embedSize(embed) <= EMBED_TOTAL) {
            embeds.push(embed);
            total += embedSize(embed);
            index = end;
            continue;
          }
        } catch (error) { if (!(error instanceof InvalidCard)) throw error; }
      }
    }
    const marker = opensFence(scoped);
    if (marker) fence = { marker, margin };
    else {
      const indent = listMargin(scoped);
      if (indent !== undefined) {
        const itemMargin = margin + indent;
        margins.push(itemMargin);
        const itemFence = opensFence(scoped.slice(indent));
        if (itemFence) fence = { marker: itemFence, margin: itemMargin };
      }
    }
    out.push(line);
  }
  if (embeds.length === 0) return { text: source, embeds };
  const occupied = (line: string) => !/^[ \t\r]*$/.test(line);
  const start = out.findIndex(occupied);
  return { text: start < 0 ? "" : out.slice(start, out.findLastIndex(occupied) + 1).join("\n"), embeds };
}
