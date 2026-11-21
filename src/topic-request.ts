import { realpathSync, statSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import type { Lane } from "./contracts";

export const TOPIC_CHOICE_WAIT_MS = 5 * 60_000;

/** Only owner text, never a quote, attachment path, or channel description. */
export function topicRequest(text: string) {
  const request = text.replace(/^\s*\/new(?:\s+|$)/, "");
  const header = /^cwd:[ \t]*([^\n]*)(?:\n|$)/i.exec(request.trimStart());
  if (!header) return { text: request, cwd: null };
  return { text: request.trimStart().slice(header[0].length), cwd: header[1].trim() };
}

/** Parse only the original Discord owner request body. An empty result asks for a task. */
export function discordThreadSplit(text: string): string | null {
  const line = text.trim();
  if (/[\r\n\u2028\u2029]/u.test(line)) return null;
  const directive = /^(?:이건\s+따로\s+빼\s*줘|(?:please\s+)?split\s+this\s+into\s+a\s+new\s+thread)(?:[.!]|\s*:\s*(.*))?$/iu.exec(line);
  if (directive) return directive[1]?.trim() ?? "";

  // Without a colon, accept a plain task label, not an embedded sentence or quotation.
  const korean = /^([\p{L}\p{M}\p{N}_ -]+?)(?:은|는|을|를)\s+새\s+스레드에서\s+해\s*줘[.!]?$/u.exec(line);
  const english = /^(?:please\s+)?do\s+([\p{L}\p{M}\p{N}_ -]+?)\s+in\s+a\s+new\s+thread[.!]?$/iu.exec(line);
  const task = (korean?.[1] ?? english?.[1])?.trim();
  // Keep hyphenated task words, but not punctuation standing in for a word or clause boundary.
  if (!task || /(?:^| )-|-(?: |$)|--|(?:^| )_+(?: |$)/u.test(task)) return null;
  // The closing thread phrase can be an excluded alternative, not a destination.
  if (/\b(?:no|not|never|instead|(?:rather|other)[ -]+than|as[ -]+opposed[ -]+to|but|or|nor|except|unless|without|versus|vs)\b|말고|대신|아니라|아닌/iu.test(task)) return null;
  if (/\b(?:for +example|the +phrase|the +words)\b|예를\s*들어|예시로|라고\s/iu.test(task)) return null;
  // “Do we ...” and similar questions need not end in a question mark.
  if (english && /^(?:i|you|we|they)\b/iu.test(task)) return null;
  return /^(?:this(?: task)?|it|이거|이것)$/iu.test(task) ? "" : task;
}

/** An edit can revise the task, not create a new placement or confirm a different one. */
export function editsTopicPlacement(before: string, after: string): boolean {
  const boundary = /^\/(?:new|main)(?:\s|$)/;
  const coordinates = /^\/head(?:\s|$)/;
  if (boundary.test(before.trimStart()) || boundary.test(after.trimStart()) ||
    coordinates.test(before.trimStart()) !== coordinates.test(after.trimStart())) return true;
  const old = topicRequest(before), next = topicRequest(after);
  return old.cwd !== next.cwd || old.cwd !== null && (!old.text.trim() || !next.text.trim());
}

export function existingWorkspace(path: string): string | null {
  if (!isAbsolute(path)) return null;
  try {
    const canonical = realpathSync(path);
    return statSync(canonical).isDirectory() ? canonical : null;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return null;
  }
}

/** Match names of placed workspaces, not substrings of paths, filenames or longer repo names. */
export function namedWorkspaces(text: string, lanes: readonly Lane[], nameOnly = false): Set<string> {
  const matches = new Set<string>();
  for (const lane of lanes) {
    for (const path of [lane.cwd, lane.repoRoot]) {
      if (!path) continue;
      const name = basename(path);
      if (!name) continue;
      const literal = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = nameOnly ? `^${literal}$`
        : `(?<![\\p{L}\\p{N}_./\\\\-])${literal}(?:에서|으로|로|에|이랑|랑|하고|와|과|부터|까지|의)?(?:만|도|은|는|이|가|을|를)?(?![\\p{L}\\p{N}_/\\\\-]|\\.[\\p{L}\\p{N}])`;
      if (new RegExp(pattern, "iu").test(text)) matches.add(lane.cwd);
    }
  }
  return matches;
}

/** Choose a single existing directory; conflicting evidence or explicit exclusions need clarification. */
export function inferredWorkspace(text: string, lanes: readonly Lane[], replied: string | null, threadWorkspace: string | null): string | null {
  if (/\b(?:not|avoid|except|instead of|rather than|other than)\b|n['’]t\b|말고|대신|제외|빼고|아니라|아닌|(?:쓰|사용하)지\s*마/iu.test(text)) return null;
  const candidates = namedWorkspaces(text, lanes);
  const lineEnd = text.indexOf("\n");
  const path = lineEnd > 0 ? existingWorkspace(text.slice(0, lineEnd).trim()) : null;
  if (path) candidates.add(path);
  if (replied) candidates.add(replied);
  if (!candidates.size && threadWorkspace) candidates.add(threadWorkspace);
  if (!candidates.size && /^(?:(?:in|use) the same (?:repo(?:sitory)?|project|workspace)\b|(?:같은|이전|아까|기존|그)\s*(?:저장소|레포|프로젝트)에서\s)/iu.test(text)) {
    for (const lane of lanes) candidates.add(lane.cwd);
  }
  const [selected] = candidates;
  return candidates.size === 1 && selected && existingWorkspace(selected) === selected ? selected : null;
}
