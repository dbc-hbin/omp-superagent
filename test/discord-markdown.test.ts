import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractDiscordCards, renderDiscordMarkdown, type DiscordEmbed } from "../src/discord-markdown.ts";

describe("Discord markdown table rendering", () => {
  test("converts a pipe table into one aligned fenced block", () => {
    expect(renderDiscordMarkdown([
      "Before text.",
      "| Name | Count |",
      "| --- | ---: |",
      "| a | 12 |",
      "| longer | 3 |",
      "After text.",
    ].join("\n"), Infinity)).toBe([
      "Before text.",
      "```",
      "| Name   | Count |",
      "| ------ | ----- |",
      "| a      |    12 |",
      "| longer |     3 |",
      "```",
      "After text.",
    ].join("\n"));
  });

  test("pads every column to its widest cell and honours alignment markers", () => {
    expect(renderDiscordMarkdown([
      "| left | center | right |",
      "| :--- | :----: | ----: |",
      "| a | b | c |",
      "| wide cell | mid | d |",
    ].join("\n"), Infinity)).toBe([
      "```",
      "| left      | center | right |",
      "| --------- | ------ | ----- |",
      "| a         |   b    |     c |",
      "| wide cell |  mid   |     d |",
      "```",
    ].join("\n"));
  });

  test("pads by display width so CJK columns align with ASCII", () => {
    const rendered = renderDiscordMarkdown([
      "| 이름 | 값 |",
      "| --- | --- |",
      "| 한글 | 1 |",
      "| ab | 22 |",
    ].join("\n"), Infinity);
    const lines = rendered.split("\n");
    expect(lines[0]).toBe("```");
    expect(lines.at(-1)).toBe("```");
    // Every fenced line occupies the same number of display columns, which is
    // only true when padding counts CJK glyphs as two cells rather than one unit.
    expect(new Set(lines.slice(1, -1).map(line => Bun.stringWidth(line))).size).toBe(1);
    expect(lines).toEqual([
      "```",
      "| 이름 | 값  |",
      "| ---- | --- |",
      "| 한글 | 1   |",
      "| ab   | 22  |",
      "```",
    ]);
  });

  test("leaves a pipe table without a delimiter row untouched", () => {
    const source = ["| a | b |", "| just text |", "| c | d |"].join("\n");
    expect(renderDiscordMarkdown(source, Infinity)).toBe(source);
  });

  test("leaves a delimiter row whose cell count differs from the header untouched", () => {
    const source = ["| a | b |", "| --- |", "| c | d |"].join("\n");
    expect(renderDiscordMarkdown(source, Infinity)).toBe(source);
  });

  test("never treats pipes inside an existing fenced block as a table", () => {
    const source = ["```", "| a | b |", "| --- | --- |", "| c | d |", "```"].join("\n");
    expect(renderDiscordMarkdown(source, Infinity)).toBe(source);
    const tilde = ["~~~~", "| a | b |", "|---|---|", "~~~~"].join("\n");
    expect(renderDiscordMarkdown(tilde, Infinity)).toBe(tilde);
  });

  test("passes prose, lists, headings, links, blockquotes, and inline code through untouched", () => {
    const source = [
      "# Heading | with pipe",
      "",
      "- list item | pipe",
      "1. ordered | pipe",
      "",
      "> quote | pipe",
      "",
      "[link](https://example.invalid/a|b) and `inline | code`",
      "",
      "plain prose",
    ].join("\n");
    expect(renderDiscordMarkdown(source, Infinity)).toBe(source);
  });

  test("does not split a row on an escaped pipe or a pipe inside inline code", () => {
    const lines = renderDiscordMarkdown([
      "| expr | note |",
      "| --- | --- |",
      "| a \\| b | `x | y` |",
    ].join("\n"), Infinity).split("\n");
    // Two source cells stay two cells: the escaped pipe and the fenced-looking
    // pipe are content, so the separator row never grows past two columns.
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe("```");
    expect(lines[2]).toBe("| ----- | ------- |");
    expect(lines[4]).toBe("```");
  });

  test("is idempotent: an already converted table is not converted again", () => {
    const once = renderDiscordMarkdown(["| a | b |", "| --- | --- |", "| 1 | 2 |"].join("\n"), Infinity);
    expect(renderDiscordMarkdown(once, Infinity)).toBe(once);
  });

  test("always emits a closed fence", () => {
    const rendered = renderDiscordMarkdown(["| a | b |", "|---|---|", "| 1 | 2 |"].join("\n"), Infinity);
    expect(rendered.startsWith("```\n")).toBe(true);
    expect(rendered.endsWith("\n```")).toBe(true);
    expect(rendered.split("```")).toHaveLength(3);
  });

  test.each([
    "> next | quote",
    "   > next | quote",
    "- next | item",
    "+ next | item",
    "* next | item",
    "1. next | item",
    "2) next | item",
    "# next | heading",
    "###### next | heading",
  ])("ends a table before the next block: %s", block => {
    const source = ["| a | b |", "|---|---|", "| 1 | 2 |", block, "following text"].join("\n");
    const table = renderDiscordMarkdown("| a | b |\n|---|---|\n| 1 | 2 |", Infinity);
    expect(renderDiscordMarkdown(source, Infinity)).toBe(`${table}\n${block}\nfollowing text`);
    const nonTable = `${block}\n|---|---|`;
    expect(renderDiscordMarkdown(nonTable, Infinity)).toBe(nonTable);
  });

  test.each(["```js", "   ```` trailing text", "~~~text", "``", "~~~~"])("does not close a backtick fence at %s", line => {
    const source = ["```markdown", line, "| a | b |", "|---|---|", "| 1 | 2 |", "```"].join("\n");
    expect(renderDiscordMarkdown(source, Infinity)).toBe(source);
  });

  test("requires whitespace after a closing tilde fence and resumes after a valid close", () => {
    const code = ["~~~markdown", "~~~~text", "| a | b |", "|---|---|", "| 1 | 2 |", "   ~~~~ \t"].join("\n");
    const table = "| c | d |\n|---|---|\n| 3 | 4 |";
    expect(renderDiscordMarkdown(`${code}\n${table}`, Infinity)).toBe(`${code}\n${renderDiscordMarkdown(table, Infinity)}`);
  });

  test("counts UTF-8 bytes, surrounding prose, and multiple tables against one budget", () => {
    const table = "| 이름 | 값 |\n|---|---|\n| 한글 | 1 |";
    const source = `앞 문장\n${table}\n\n${table}\n뒤 문장`;
    const rendered = renderDiscordMarkdown(source, Infinity);
    const bytes = Buffer.byteLength(rendered, "utf8");
    expect(rendered).not.toBe(source);
    expect(renderDiscordMarkdown(source, bytes)).toBe(rendered);
    expect(renderDiscordMarkdown(source, bytes - 1)).toBe(source);
  });

  test("keeps sparse tables original before allocating disproportionate padding", () => {
    const source = ["| a | b |", "|---|---|", `| ${"x".repeat(10_000)} | y |`, ...Array(1000).fill("| 1 | 2 |")].join("\n");
    expect(renderDiscordMarkdown(source, Buffer.byteLength(source, "utf8"))).toBe(source);
  });

  test("handles many short rows without spreading them into function arguments", () => {
    const source = ["| a | b |", "|---|---|", ...Array(150_000).fill("| 1 | 2 |")].join("\n");
    expect(renderDiscordMarkdown(source, Buffer.byteLength(source, "utf8"))).toBe(source);
  });
});

describe("Discord card fences", () => {
  // The Rust Gateway's embeds.rs test reads this same fixture.
  const cases = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "discord-cards.json"), "utf8")) as
    Array<{ name: string; text: string; content: string; embeds: DiscordEmbed[] }>;

  for (const fixture of cases) {
    test(fixture.name, () => {
      expect(extractDiscordCards(fixture.text)).toEqual({ text: fixture.content, embeds: fixture.embeds });
    });
  }

  test("more than ten valid cards keep the overflow as text", () => {
    const card = (index: number) => ["```card", JSON.stringify({ root: "c", elements: { c: { type: "Card", props: { title: `#${index}` } } } }), "```"].join("\n");
    const source = Array.from({ length: 11 }, (_, index) => card(index)).join("\n");
    const result = extractDiscordCards(source);
    expect(result.embeds.map(embed => embed.title)).toEqual(Array.from({ length: 10 }, (_, index) => `#${index}`));
    expect(result.text).toBe(card(10));
  });
});
