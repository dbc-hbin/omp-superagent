/** Read the runtime-authored fenced header, not Request ID prose in task data. */
export function nativeRequestEnvelope(text: string): { requestId: string; sourceId: string; envelope: string } | undefined {
  const headers = /(?:^|\n)(`{3,})superagent-runtime-context\r?\nRequest ID: ([^\r\n]+)\r?\n\r?\nOriginal source ID: ([^\r\n]+)\r?\n\r?\nOriginal authorized conversation: (\[[^\r\n]*\])\r?\n/g;
  let selected: { requestId: string; sourceId: string; envelope: string; fenceLength: number } | undefined;
  for (const header of text.matchAll(headers)) {
    const closing = new RegExp(`(?:^|\\n)${header[1]}\\r?(?:\\n|$)`, "g");
    closing.lastIndex = header.index! + header[0].length;
    const end = closing.exec(text);
    if (!end || selected && selected.fenceLength >= header[1]!.length) continue;
    let route: unknown;
    try { route = JSON.parse(header[4]!); }
    catch { continue; }
    if (!Array.isArray(route) || route.length < 6 || !route.every(value => value === null || typeof value === "string")) continue;
    selected = { requestId: header[2]!, sourceId: header[3]!, envelope: text.slice(header.index, end.index), fenceLength: header[1]!.length };
  }
  return selected;
}
