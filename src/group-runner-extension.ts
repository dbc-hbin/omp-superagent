import { randomUUID } from "node:crypto";
import {
  closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync, renameSync, unlinkSync,
  writeFileSync, type Stats,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const maxBytes = 32 * 1024;
const maxCalls = 40;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const pathParameter = Type.String({ minLength: 1, maxLength: 512 });
export const restrictedWorkTools = ["group_list", "group_read", "group_edit"] as const;

class RestrictedPathError extends Error {}

function isVisibleSegment(segment: string): boolean {
  return Buffer.byteLength(segment) <= 255 && /^[^\s.\\/:][^\\/:]*$/u.test(segment) &&
    !/[\p{Cc}\p{Cf}]/u.test(segment) && !/[ .]$/.test(segment);
}

function sameFile(first: Stats, second: Stats): boolean {
  return first.dev === second.dev && first.ino === second.ino;
}

function existingText(path: string): { readonly text: string; readonly mode: number } {
  const expected = lstatSync(path);
  if (!expected.isFile() || expected.nlink !== 1 || expected.size > maxBytes || realpathSync.native(path) !== path)
    throw new RestrictedPathError("Not an eligible regular text file");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const actual = fstatSync(fd);
    if (!sameFile(expected, actual) || !actual.isFile() || actual.nlink !== 1 || actual.size > maxBytes)
      throw new RestrictedPathError("File changed or is not an eligible regular file");
    const buffer = Buffer.alloc(maxBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = readSync(fd, buffer, size, buffer.length - size, size);
      if (count === 0) break;
      size += count;
    }
    const bytes = buffer.subarray(0, size);
    if (size > maxBytes || bytes.includes(0)) throw new RestrictedPathError("Only bounded UTF-8 text is supported");
    return { text: utf8.decode(bytes), mode: actual.mode & 0o777 };
  } finally { closeSync(fd); }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function content(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined };
}

/** Public OMP extension factory; never used unless launched with the parent-owned checkout. */
export default function groupWorktree(pi: ExtensionAPI): void {
  const configured = process.env.OMP_SA_RESTRICTED_WORKTREE;
  if (!configured || !isAbsolute(configured) || realpathSync.native(configured) !== configured || !lstatSync(configured).isDirectory())
    throw new RestrictedPathError("Missing private group worktree");
  const root = configured;
  const rootIdentity = lstatSync(root);
  const permitted = new Set<string>(restrictedWorkTools);
  pi.on("tool_call", event => permitted.has(event.toolName)
    ? undefined : { block: true, reason: "Only the restricted group worktree tools may execute." });
  let calls = 0;
  let remainingBytes = 384 * 1024;
  function location(path: string, kind: "file" | "directory"): string {
    if (!sameFile(rootIdentity, lstatSync(root))) throw new RestrictedPathError("Worktree root changed");
    if (path === "." && kind === "directory") return root;
    const segments = path.split("/");
    if (Buffer.byteLength(path) > 512 || segments.length > 20 || !segments.every(isVisibleSegment))
      throw new RestrictedPathError("Use a visible path relative to the group worktree");
    let current = root;
    for (const segment of kind === "directory" ? segments : segments.slice(0, -1)) {
      current = join(current, segment);
      if (!lstatSync(current).isDirectory() || realpathSync.native(current) !== current)
        throw new RestrictedPathError("Not an eligible directory");
    }
    return kind === "directory" ? current : join(current, segments.at(-1) ?? "");
  }
  function useBudget(signal: AbortSignal | undefined, run: () => string) {
    signal?.throwIfAborted();
    if (++calls > maxCalls || remainingBytes < maxBytes) throw new RestrictedPathError("Group tool budget exhausted");
    try {
      const result = run();
      remainingBytes -= Buffer.byteLength(result);
      return content(result);
    } catch (error) {
      if (error instanceof RestrictedPathError) throw error;
      if (!(error instanceof Error)) throw error;
      // OMP can report the operation failure but must not echo a host path or raw filesystem diagnostic.
      throw new RestrictedPathError("File operation refused inside the group worktree");
    }
  }

  pi.registerTool({
    name: restrictedWorkTools[0], label: "Group list", approval: "read", loadMode: "essential",
    description: "List visible entries in one group worktree directory. Use . for the root.",
    parameters: Type.Object({ path: pathParameter }, { additionalProperties: false }),
    async execute(_id, { path }, signal) {
      return useBudget(signal, () => {
        const directory = location(path, "directory");
        const handle = opendirSync(directory);
        const names: string[] = [];
        try {
          for (let count = 0; count < 8192 && names.length < 120; count++) {
            const entry = handle.readSync();
            if (!entry) break;
            if (!isVisibleSegment(entry.name)) continue;
            const info = lstatSync(join(directory, entry.name));
            if (info.isDirectory()) names.push(`${entry.name}/`);
            else if (info.isFile() && info.nlink === 1 && info.size <= maxBytes) names.push(entry.name);
          }
        } finally { handle.closeSync(); }
        return names.sort().join("\n");
      });
    },
  });
  pi.registerTool({
    name: restrictedWorkTools[1], label: "Group read", approval: "read", loadMode: "essential",
    description: "Read a visible UTF-8 file (at most 32 KiB) in the group worktree.",
    parameters: Type.Object({ path: pathParameter }, { additionalProperties: false }),
    async execute(_id, { path }, signal) {
      return useBudget(signal, () => existingText(location(path, "file")).text);
    },
  });
  pi.registerTool({
    name: restrictedWorkTools[2], label: "Group edit", approval: "write", loadMode: "essential",
    description: "Write a complete UTF-8 file (at most 32 KiB) at a visible path in an existing group worktree directory.",
    parameters: Type.Object({ path: pathParameter, text: Type.String({ maxLength: maxBytes }) }, { additionalProperties: false }),
    async execute(_id, { path, text }, signal) {
      return useBudget(signal, () => {
        const bytes = Buffer.byteLength(text);
        if (bytes > maxBytes || text.includes("\0")) throw new RestrictedPathError("Only bounded UTF-8 text is supported");
        const target = location(path, "file");
        let mode = 0o644;
        try { mode = existingText(target).mode; }
        catch (error) { if (!isMissing(error)) throw error; }
        const temp = join(dirname(target), `.group-edit-${randomUUID()}`);
        writeFileSync(temp, text, { mode, flag: "wx" });
        try { renameSync(temp, target); }
        catch (error) {
          unlinkSync(temp);
          throw error;
        }
        remainingBytes -= bytes;
        return "File written inside the group worktree.";
      });
    },
  });
}
