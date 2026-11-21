import { realpathSync, statSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import type { Lane } from "./contracts";

/** Only owner text, never a quote, attachment path, or channel description. */
export function topicRequest(text: string) {
  const request = text.replace(/^\s*\/new(?:\s+|$)/, "");
  const header = /^cwd:[ \t]*([^\n]*)(?:\n|$)/i.exec(request.trimStart());
  if (!header) return { text: request, cwd: null };
  return { text: request.trimStart().slice(header[0].length), cwd: header[1].trim() };
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
