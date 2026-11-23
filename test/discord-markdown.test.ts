import { describe, expect, test } from "bun:test";
import { renderDiscordMarkdown } from "../src/discord-markdown.ts";

describe("Discord markdown table rendering", () => {
  test("renders labeled rows with blank boundaries next to prose", () => {
    expect(renderDiscordMarkdown([
      "Before text.",
      "| Name | Count |",
      "| --- | ---: |",
      "| a | 12 |",
      "| longer | 3 |",
      "After text.",
    ].join("\n"), Infinity)).toBe([
      "Before text.",
      "",
      "- Name: a",
      "  - Count: 12",
      "",
      "- Name: longer",
      "  - Count: 3",
      "",
      "After text.",
    ].join("\n"));
  });

  test("accepts alignment markers and rows without outer pipes", () => {
    expect(renderDiscordMarkdown([
      "   left | center | right",
      "   :--- | :----: | ----:",
      "   a | b | c",
    ].join("\n"), Infinity)).toBe([
      "- left: a",
      "  - center: b",
      "  - right: c",
    ].join("\n"));
  });

  test("preserves links and emphasis in Korean Markdown cells", () => {
    expect(renderDiscordMarkdown([
      "| 이름 | 설명 |",
      "| --- | --- |",
      "| [한글](https://example.invalid/korean) | **중요**한 *설명* |",
    ].join("\n"), Infinity)).toBe("- 이름: [한글](https://example.invalid/korean)\n  - 설명: **중요**한 *설명*");
  });

  test("uses positional labels and empty values for ragged rows", () => {
    expect(renderDiscordMarkdown([
      "| Name |   | Status |",
      "| --- | --- | --- |",
      "| One | | Ready | extra |",
      "| Two | note |",
    ].join("\n"), Infinity)).toBe([
      "- Name: One",
      "  - Column 2:",
      "  - Status: Ready",
      "  - Column 4: extra",
      "",
      "- Name: Two",
      "  - Column 2: note",
      "  - Status:",
    ].join("\n"));
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

  test("only splits structural pipes and preserves the displayed inline code", () => {
    expect(renderDiscordMarkdown([
      "| expr | note |",
      "| --- | --- |",
      "| a \\| b | `x \\| y` |",
      "| \\`literal | backslash \\\\|",
      "| `x\\` | tail |",
      "| ``a `b | c` `` | end |",
      "| `` 미완료 `ok` 로그 | 정상 |",
    ].join("\n"), Infinity)).toBe([
      "- expr: a \\| b",
      "  - note: `x | y`",
      "",
      "- expr: \\`literal",
      "  - note: backslash \\\\",
      "",
      "- expr: `x\\`",
      "  - note: tail",
      "",
      "- expr: ``a `b | c` ``",
      "  - note: end",
      "",
      "- expr: \\`\\` 미완료 `ok` 로그",
      "  - note: 정상",
    ].join("\n"));
  });

  test("is idempotent: an already converted table is not converted again", () => {
    const once = renderDiscordMarkdown(["| a | b |", "| --- | --- |", "| 1 | 2 |"].join("\n"), Infinity);
    expect(renderDiscordMarkdown(once, Infinity)).toBe(once);
  });

  test("emits one item with empty values for header-only tables and preserves existing blank lines", () => {
    const source = "Before\n\n \t\n| | Name |\n|---|---|\n\n\nAfter\n";
    expect(renderDiscordMarkdown(source, Infinity)).toBe("Before\n\n \t\n- Column 1:\n  - Name:\n\n\nAfter\n");
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
    expect(renderDiscordMarkdown(source, Infinity)).toBe(`- a: 1\n  - b: 2\n\n${block}\nfollowing text`);
    const nonTable = `${block}\n|---|---|`;
    expect(renderDiscordMarkdown(nonTable, Infinity)).toBe(nonTable);
  });

  test.each(["    ", "\t", "  \t"])("preserves indented code and does not use indented delimiters (%j)", indent => {
    const table = "| a | b |\n|---|---|\n| 1 | 2 |";
    const code = `${indent}| code | sample |\n${indent}|---|---|`;
    const invalid = `| c | d |\n${indent}|---|---|`;
    expect(renderDiscordMarkdown(`${table}\n${code}\n\n${invalid}`, Infinity)).toBe(`- a: 1\n  - b: 2\n\n---\n\n${code}\n\n${invalid}`);
  });

  test("renders list-relative tables without changing nearby code blocks", () => {
    const code = "10. ```markdown\n    A | B\n    --- | ---\n    x | y\n    ```";
    const indented = "        A | B\n        --- | ---\n        x | y";
    const source = `${code}\n\n11. Results\n\n    Name | Status\n    - | -\n    build | pass\n\n${indented}`;
    const rendered = `${code}\n\n11. Results\n\n    - Name: build\n      - Status: pass\n\n    ---\n\n${indented}`;
    expect(renderDiscordMarkdown(source, Infinity)).toBe(rendered);
    expect(renderDiscordMarkdown(rendered, Infinity)).toBe(rendered);
    const breakAndCode = "- - -\n\n    A | B\n    --- | ---\n    x | y";
    expect(renderDiscordMarkdown(breakAndCode, Infinity)).toBe(breakAndCode);
  });

  test("keeps fences open across tab-indented lines at a list margin", () => {
    const code = "- Example\n\n  ~~~md\n\tintro\n  A | B\n  --- | ---\n  x | y\n\t~~~";
    expect(renderDiscordMarkdown(`${code}\n\n| A | B |\n|-|-|\n| 1 | 2 |`, Infinity)).toBe(`${code}\n\n- A: 1\n  - B: 2`);
  });

  test("does not pair literal backticks around a cell link", () => {
    const source = "| `Tag |\n| --- |\n| [release](https://example.invalid/)` |";
    expect(renderDiscordMarkdown(source, Infinity)).toBe("- \\`Tag: [release](https://example.invalid/)\\`");
  });

  test("keeps inline backticks in a row and stops at an actual fence opener", () => {
    const code = "```js | file\n| c | d |\n|---|---|\n```";
    const source = `| a | b |\n|---|---|\n\`\`\`x | y\`\`\` | z\n${code}\n| e | f |\n|---|---|\n| 3 | 4 |`;
    expect(renderDiscordMarkdown(source, Infinity)).toBe(`- a: \`\`\`x | y\`\`\`\n  - b: z\n\n${code}\n\n- e: 3\n  - f: 4`);
  });

  test.each(["```js", "   ```` trailing text", "~~~text", "``", "~~~~"])("does not close a backtick fence at %s", line => {
    const source = ["```markdown", line, "| a | b |", "|---|---|", "| 1 | 2 |", "```"].join("\n");
    expect(renderDiscordMarkdown(source, Infinity)).toBe(source);
  });

  test("requires whitespace after a closing tilde fence and resumes after a valid close", () => {
    const code = ["~~~markdown", "~~~~text", "| a | b |", "|---|---|", "| 1 | 2 |", "   ~~~~ \t"].join("\n");
    const table = "| c | d |\n|---|---|\n| 3 | 4 |";
    expect(renderDiscordMarkdown(`${code}\n${table}`, Infinity)).toBe(`${code}\n\n- c: 3\n  - d: 4`);
  });

  test("counts UTF-8 bytes, surrounding prose, and table boundaries against one budget", () => {
    const table = "| 이름 | 상세 설명 |\n|---|---|\n| 한글 | 1 |\n| 두 번째 | 2 |";
    const list = "- 이름: 한글\n  - 상세 설명: 1\n\n- 이름: 두 번째\n  - 상세 설명: 2";
    const source = `앞 문장\n${table}\n\n${table}\n뒤 문장`;
    const rendered = `앞 문장\n\n${list}\n\n${list}\n\n뒤 문장`;
    const bytes = Buffer.byteLength(rendered, "utf8");
    expect(renderDiscordMarkdown(source, bytes)).toBe(rendered);
    expect(renderDiscordMarkdown(source, bytes - 1)).toBe(source);
  });

  test("handles many short rows without spreading them into function arguments", () => {
    const source = `| a | b |\n|---|---|${"\n| 1 | 2 |".repeat(150_000)}`;
    const rendered = `${"- a: 1\n  - b: 2\n\n".repeat(149_999)}- a: 1\n  - b: 2`;
    expect(renderDiscordMarkdown(source, Buffer.byteLength(rendered, "utf8"))).toBe(rendered);
  });
});
