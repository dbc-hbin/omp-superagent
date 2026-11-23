/**
 * Markdown table rendering for the Discord transport.
 *
 * Discord has no pipe-table support: a table sent verbatim arrives as literal
 * `| a | b |` rows. Discord does render fenced blocks in a monospaced font, so a
 * table is converted into an aligned fenced block before it leaves this package.
 *
 * Column padding uses display width, not string length, so CJK and other wide
 * characters line up. Bun.stringWidth supplies the display width directly;
 * no OMP source checkout or private module is needed.
 *
 * A ```card fence holding a json-render spec becomes a Discord embed instead.
 * The Rust Gateway (gateway/src/discord/embeds.rs) implements the same contract;
 * test/fixtures/discord-cards.json pins both to identical results.
 */

type Align = "left" | "center" | "right";

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t\r]*$/;
const BLOCK_START = /^ {0,3}(?:>|#{1,6}(?:[ \t]|$)|(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$))/;
const DELIMITER_CELL = /^:?-+:?$/;

/**
 * Split one table row into trimmed cells.
 * Returns null when the line carries no unescaped pipe, so callers can end a
 * table body. `\|` and pipes inside backtick spans never split a cell, matching
 * how GFM reads a row.
 */
function splitRow(line: string): string[] | null {
  const cells: string[] = [];
  let cell = "";
  let pipe = false;
  let leading = false;
  let tick = 0;
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!;
    if (char === "\\" && line[index + 1] === "|") {
      // A GFM escaped pipe is cell content, not a separator: inside the fence
      // it stays the literal `|` the author asked to display.
      cell += "|";
      index++;
      continue;
    }
    if (char === "`") {
      let run = 1;
      while (line[index + run] === "`") run++;
      tick = tick === run ? 0 : tick === 0 ? run : tick;
      cell += "`".repeat(run);
      index += run - 1;
      continue;
    }
    if (char === "|" && tick === 0) {
      if (!pipe) leading = cell.trim() === "";
      pipe = true;
      cells.push(cell);
      cell = "";
      continue;
    }
    cell += char;
  }
  if (!pipe) return null;
  cells.push(cell);
  if (leading) cells.shift();
  if (cells.length > 0 && cells[cells.length - 1]!.trim() === "") cells.pop();
  return cells.length > 0 ? cells.map(value => value.trim()) : null;
}

/** The delimiter row must have the same cell count as the header, as in GFM. */
function parseDelimiter(line: string): Align[] | null {
  const cells = splitRow(line);
  if (!cells) return null;
  const aligns: Align[] = [];
  for (const cell of cells) {
    if (!DELIMITER_CELL.test(cell)) return null;
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    aligns.push(left && right ? "center" : right ? "right" : "left");
  }
  return aligns;
}

function pad(value: string, width: number, align: Align): string {
  const missing = width - Bun.stringWidth(value);
  if (missing <= 0) return value;
  if (align === "right") return " ".repeat(missing) + value;
  if (align === "center") {
    const left = Math.floor(missing / 2);
    return " ".repeat(left) + value + " ".repeat(missing - left);
  }
  return value + " ".repeat(missing);
}

/** Check the byte budget before allocating any padded cells or separators. */
function formatTable(rows: string[][], aligns: Align[], maxBytes: number): { lines: string[]; bytes: number } | null {
  const widths = aligns.map(() => 3);
  for (const row of rows) {
    for (let column = 0; column < row.length; column++) {
      widths[column] = Math.max(widths[column] ?? 3, Bun.stringWidth(row[column]!));
    }
  }
  const alignOf = (column: number): Align => aligns[column] ?? "left";
  const fence = "```";
  // Each row has a frame, display-width cells, and one newline. UTF-8 cell
  // bytes may exceed their display width; the separator contains only ASCII.
  const rowWidth = 3 * widths.length + 1 + widths.reduce((sum, width) => sum + width, 0);
  let bytes = 2 * fence.length + rows.length + 2 + (rows.length + 1) * rowWidth;
  for (const row of rows) {
    for (const cell of row) bytes += Buffer.byteLength(cell, "utf8") - Bun.stringWidth(cell);
  }
  if (bytes > maxBytes) return null;
  const line = (cells: string[]) =>
    `| ${widths.map((width, column) => pad(cells[column] ?? "", width, alignOf(column))).join(" | ")} |`;
  // Pure dashes keep the grid exact; alignment is already visible in the padded
  // cells, and `:` markers would only shift every following column by one.
  const separator = `| ${widths.map(width => "-".repeat(width)).join(" | ")} |`;
  const lines = [fence, line(rows[0]!), separator];
  for (let index = 1; index < rows.length; index++) lines.push(line(rows[index]!));
  lines.push(fence);
  return { lines, bytes };
}

/**
 * Rewrite markdown pipe tables as aligned fenced blocks.
 *
 * Everything else passes through byte for byte: prose, lists, headings, links,
 * blockquotes, inline code, and existing fenced blocks. Pipes inside a fence are
 * never treated as a table, and an already-converted table stays inside its own
 * fence, so the transform is idempotent. If alignment would exceed the complete
 * message's byte budget, return the original text for the existing delivery path.
 */
export function renderDiscordMarkdown(text: string, maxBytes: number): string {
  if (!text.includes("|")) return text;
  let bytes = Buffer.byteLength(text, "utf8");
  if (bytes > maxBytes) return text;
  const lines = text.split("\n");
  const out: string[] = [];
  let fence: { char: string; length: number } | null = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const marker = FENCE_OPEN.exec(line)?.[1];
    if (fence) {
      out.push(line);
      const close = FENCE_CLOSE.exec(line)?.[1];
      if (close && close[0] === fence.char && close.length >= fence.length) fence = null;
      continue;
    }
    if (marker) {
      fence = { char: marker[0]!, length: marker.length };
      out.push(line);
      continue;
    }
    const delimiter = !BLOCK_START.test(line) && index + 1 < lines.length ? parseDelimiter(lines[index + 1]!) : null;
    const header = delimiter ? splitRow(line) : null;
    if (!delimiter || !header || header.length !== delimiter.length) {
      out.push(line);
      continue;
    }
    const rows = [header];
    let sourceBytes = Buffer.byteLength(line, "utf8") + 1 + Buffer.byteLength(lines[index + 1]!, "utf8");
    let next = index + 2;
    for (; next < lines.length; next++) {
      if (FENCE_OPEN.test(lines[next]!) || BLOCK_START.test(lines[next]!)) break;
      const row = splitRow(lines[next]!);
      if (!row) break;
      rows.push(row);
      sourceBytes += 1 + Buffer.byteLength(lines[next]!, "utf8");
    }
    const table = formatTable(rows, delimiter, maxBytes - bytes + sourceBytes);
    if (!table) return text;
    bytes += table.bytes - sourceBytes;
    for (const rendered of table.lines) out.push(rendered);
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
        const inline = props.inline ?? false;
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
        const table = formatTable([columns as string[], ...rows as string[][]], columns.map(() => "left"), Infinity)!;
        parts.push(table.lines.join("\n"));
        break;
      }
      case "Divider": parts.push(DIVIDER); break;
      case "Image": {
        const url = text(props, "url", true)!;
        if (embed.image || !url.startsWith("https://") || /\s/.test(url) || url.length > IMAGE_URL) throw new InvalidCard();
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

function trimLines(value: string): string {
  return value.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
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
  let fence: { char: string; length: number } | null = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (fence) {
      out.push(line);
      const close = FENCE_CLOSE.exec(line)?.[1];
      if (close && close[0] === fence.char && close.length >= fence.length) fence = null;
      continue;
    }
    const card = CARD_OPEN.exec(line)?.[1];
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
    const marker = FENCE_OPEN.exec(line)?.[1];
    if (marker) fence = { char: marker[0]!, length: marker.length };
    out.push(line);
  }
  return embeds.length === 0 ? { text: source, embeds } : { text: trimLines(out.join("\n")), embeds };
}
