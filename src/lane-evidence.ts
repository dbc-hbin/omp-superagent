import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { Type, type Static } from "@sinclair/typebox/type";

/**
 * Bounded, read-only evidence from a lane's own workspace, the same for local
 * and worker lanes: HEAD verifies claims without reading worker paths itself.
 */
export const EVIDENCE_LIMIT = 64 * 1024;
const GIT_TIMEOUT_MS = 15_000;

export const evidenceRequestSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("file"),
    path: Type.String({ minLength: 1, maxLength: 4096, description: "Path relative to the lane cwd (or absolute inside it)" }),
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: EVIDENCE_LIMIT })),
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("git"),
    command: Type.Union([Type.Literal("status"), Type.Literal("log"), Type.Literal("diff-stat")]),
    count: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "log entries" })),
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("artifact"),
    name: Type.Union([Type.Literal("host-log")], { description: "The lane Host's current log (tail)" }),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: EVIDENCE_LIMIT })),
  }, { additionalProperties: false }),
]);
export type EvidenceRequest = Static<typeof evidenceRequestSchema>;
export const evidenceResultSchema = Type.Object({
  kind: Type.String(), cwd: Type.String(), text: Type.String(), bytes: Type.Integer({ minimum: 0 }),
  truncated: Type.Boolean(), path: Type.Optional(Type.String()), exitCode: Type.Optional(Type.Integer()),
}, { additionalProperties: false });
export type EvidenceResult = Static<typeof evidenceResultSchema>;

export class EvidenceError extends Error {
  override readonly name = "EvidenceError";
}

function inside(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix === "" || suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

function readBounded(path: string, offset: number, limit: number, fromEnd = false): { text: string; bytes: number; truncated: boolean } {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new EvidenceError("Evidence path is not a regular file");
    const start = fromEnd ? Math.max(0, stat.size - limit) : Math.min(offset, stat.size);
    const buffer = Buffer.alloc(Math.min(limit, Math.max(0, stat.size - start)));
    const length = buffer.length ? readSync(fd, buffer, 0, buffer.length, start) : 0;
    return { text: buffer.subarray(0, length).toString("utf8"), bytes: stat.size, truncated: start > 0 || start + length < stat.size };
  } finally { closeSync(fd); }
}

/** `hostLog` is the lane Host's current log path on this machine, when known. */
export async function collectEvidence(cwd: string, request: EvidenceRequest, hostLog?: string): Promise<EvidenceResult> {
  const root = realpathSync(cwd);
  if (request.kind === "file") {
    let path: string;
    try { path = realpathSync(isAbsolute(request.path) ? request.path : join(root, request.path)); }
    catch { throw new EvidenceError(`Evidence file does not exist in the lane workspace: ${request.path}`); }
    // Symlinks are resolved first: nothing outside the lane workspace is readable.
    if (!inside(root, path)) throw new EvidenceError("Evidence path is outside the lane workspace");
    return { kind: "file", cwd: root, path, ...readBounded(path, request.offset ?? 0, request.limit ?? EVIDENCE_LIMIT) };
  }
  if (request.kind === "artifact") {
    if (!hostLog) throw new EvidenceError("This lane has no Host log on record");
    return { kind: "artifact", cwd: root, path: hostLog, ...readBounded(hostLog, 0, request.limit ?? EVIDENCE_LIMIT, true) };
  }
  const args = request.command === "status" ? ["status", "--porcelain=v1", "--branch"]
    : request.command === "log" ? ["log", "--oneline", "--decorate", "-n", String(request.count ?? 20)]
      : ["diff", "--stat", "HEAD"];
  // Read-only: no optional index locks, hooks, pager, fsmonitor or external diff.
  const child = Bun.spawn(["git", "--no-pager", "-c", "core.fsmonitor=false", "-c", "diff.external=", "-C", root, ...args], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? root, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
    stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: GIT_TIMEOUT_MS, killSignal: "SIGKILL",
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  const text = exitCode === 0 ? stdout : stderr.trim();
  const bytes = Buffer.byteLength(text);
  return {
    kind: `git ${request.command}`, cwd: root, text: Buffer.from(text).subarray(0, EVIDENCE_LIMIT).toString("utf8"),
    bytes, truncated: bytes > EVIDENCE_LIMIT, exitCode
  };
}
