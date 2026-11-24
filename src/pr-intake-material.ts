import { Type, type Static } from "@sinclair/typebox/type";
import { parsePrRef } from "./pr-github";
import { loginSchema, parseWire, PrReadError, sha40 as sha } from "./pr-github-schema";
import { openIntakeGitHubSession, type IntakeRepositoryIdentity } from "./pr-intake-github";
import { openIntakeTree, readIntakeBlob } from "./pr-intake-tree";

const maxFiles = 32;
const maxPatchBytes = 16 * 1024;
const maxMaterialBytes = 64 * 1024;
const maxReviewBlobBytes = 96 * 1024;
export const intakeEvidenceDeadlineMs = 90_000;
const count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const id = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const login = loginSchema.properties.login;
const actor = Type.Object({ id, login, type: Type.Literal("User") });
const repo = Type.Object({ id, full_name: Type.String({ minLength: 3, maxLength: 140 }), owner: Type.Object({ id, login }) });
const ref = Type.Object({ ref: Type.String({ minLength: 1, maxLength: 255, pattern: "^[^\\x00-\\x20\\x7f]+$" }), sha });
const pullSchema = Type.Object({
  number: id, state: Type.Literal("open"), merged: Type.Literal(false), draft: Type.Boolean(),
  title: Type.String({ maxLength: 1024 }),
  user: Type.Object({ id, login: Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9-]*(\\[bot\\])?$", maxLength: 100 }) }),
  changed_files: count, additions: count, deletions: count,
  base: Type.Composite([ref, Type.Object({ repo })]),
  head: Type.Composite([ref, Type.Object({ repo })]),
});
const fileSchema = Type.Object({
  filename: Type.String({ minLength: 1, maxLength: 1024 }),
  previous_filename: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
  status: Type.String(), sha, additions: count, deletions: count, changes: count,
  patch: Type.Optional(Type.String()),
});
const filePage = Type.Array(fileSchema, { maxItems: maxFiles });
const commit = Type.Object({ sha });
const comparison = Type.Object({
  status: Type.Union([Type.Literal("ahead"), Type.Literal("diverged")]),
  base_commit: commit, merge_base_commit: commit, total_commits: count, commits: Type.Array(commit),
  files: Type.Optional(filePage),
});

export class IntakeMaterialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntakeMaterialError";
  }
}

type Session = Awaited<ReturnType<typeof openIntakeGitHubSession>>;
export type IntakeMaterialTarget = {
  readonly number: number;
  readonly head: string;
  readonly identity: IntakeRepositoryIdentity;
};
type Pull = Static<typeof pullSchema>;
type FileRow = Static<typeof fileSchema>;
type ReviewedFile = Readonly<Omit<FileRow, "patch"> & { patch: string }>;

export async function readIntakePullIdentity(session: Session, target: IntakeMaterialTarget): Promise<Pull> {
  parsePrRef(`${session.repository}#${target.number}`);
  parseWire(sha, JSON.stringify(target.head));
  const [self] = await session.get("user", Type.Tuple([actor]));
  if (self.login.toLowerCase() !== session.owner || self.id !== target.identity.ownerId)
    throw new IntakeMaterialError("GitHub authenticated user does not match the enrolled owner.");
  const [repository] = await session.get(session.root, Type.Tuple([repo]));
  const [pull] = await session.get(`${session.root}/pulls/${target.number}`, Type.Tuple([pullSchema]));
  const matchesEnrollment = (candidate: Static<typeof repo>) =>
    candidate.id === target.identity.repositoryId && candidate.full_name.toLowerCase() === session.repository
    && candidate.owner.id === self.id && candidate.owner.login.toLowerCase() === session.owner;
  if (pull.number !== target.number || !matchesEnrollment(repository) || !matchesEnrollment(pull.base.repo))
    throw new IntakeMaterialError("GitHub repository or pull request does not match enrollment.");
  if (pull.user.id === self.id || pull.user.login.toLowerCase() === session.owner)
    throw new IntakeMaterialError("GitHub does not establish independent pull request authorship.");
  return pull;
}

function normalizePull(pull: Pull) {
  const branch = ({ repo, ref, sha }: Pull["base"]) => ({
    name: repo.full_name.toLowerCase(), repositoryId: repo.id, owner: repo.owner.login.toLowerCase(),
    ownerId: repo.owner.id, ref, sha,
  });
  return {
    number: pull.number, author: { id: pull.user.id, login: pull.user.login.toLowerCase() },
    title: pull.title, draft: pull.draft, changedFiles: pull.changed_files,
    additions: pull.additions, deletions: pull.deletions, base: branch(pull.base), head: branch(pull.head),
  };
}

/** Prove the patch describes the entire change between the immutable Git blobs. */
function completePatch(row: ReviewedFile, before: string, after: string): boolean {
  const source = before.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const result = after.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const patch = row.patch.replace(/\n$/, "").split("\n");
  let added = 0, removed = 0, oldLines = 0, newLines = 0, hunks = 0;
  let oldPosition = 0, newPosition = 0;
  let previousWasLine = false;
  for (const [index, line] of patch.entries()) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(line);
    if (header) {
      if (oldLines !== 0 || newLines !== 0) return false;
      oldLines = Number(header[2] ?? 1);
      newLines = Number(header[4] ?? 1);
      const oldOffset = Number(header[1]) - Number(oldLines > 0);
      const newOffset = Number(header[3]) - Number(newLines > 0);
      if (oldOffset < oldPosition || newOffset < newPosition || oldOffset + oldLines > source.length
        || newOffset + newLines > result.length || (oldLines === 0 && newLines === 0)
        || source.slice(oldPosition, oldOffset).join("") !== result.slice(newPosition, newOffset).join("")) return false;
      oldPosition = oldOffset;
      newPosition = newOffset;
      hunks++;
      previousWasLine = false;
      continue;
    }
    if (line === "\\ No newline at end of file" && previousWasLine) {
      previousWasLine = false;
      continue;
    }
    const sign = line[0];
    if (hunks === 0 || (sign !== " " && sign !== "+" && sign !== "-")) return false;
    const payload = line.slice(1) + (patch[index + 1] === "\\ No newline at end of file" ? "" : "\n");
    if (sign !== "+") {
      if (--oldLines < 0 || source[oldPosition++] !== payload) return false;
    }
    if (sign !== "-") {
      if (--newLines < 0 || result[newPosition++] !== payload) return false;
    }
    if (sign === "+") added++;
    if (sign === "-") removed++;
    previousWasLine = true;
  }
  return hunks > 0 && oldLines === 0 && newLines === 0 && added + removed > 0
    && added === row.additions && removed === row.deletions && added + removed === row.changes
    && source.slice(oldPosition).join("") === result.slice(newPosition).join("");
}

function parseFiles(rows: readonly FileRow[], pull: Pull): readonly ReviewedFile[] {
  if (rows.length !== pull.changed_files || new Set(rows.map(row => row.filename)).size !== rows.length
    || rows.reduce((sum, row) => sum + row.additions, 0) !== pull.additions
    || rows.reduce((sum, row) => sum + row.deletions, 0) !== pull.deletions)
    throw new IntakeMaterialError("GitHub returned an incomplete or inconsistent changed-file list.");
  return rows.map(({ filename, previous_filename, status, sha, additions, deletions, changes, patch }) => {
    if (!["added", "modified", "removed", "renamed"].includes(status)
      || (status === "renamed") !== (previous_filename !== undefined))
      throw new IntakeMaterialError("GitHub reported an unsupported file change.");
    if (patch === undefined)
      throw new IntakeMaterialError("GitHub omitted a file patch (binary, unsupported or too large).");
    if (Buffer.byteLength(patch) > maxPatchBytes)
      throw new IntakeMaterialError("A GitHub file patch exceeds the review size limit.");
    return { filename, previous_filename, status, sha, additions, deletions, changes, patch };
  }).sort((a, b) => a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0);
}

async function verifyPatches(
  session: Session, revision: { readonly base: string; readonly head: string }, files: readonly ReviewedFile[],
) {
  if (files.reduce((sum, file) => sum + Buffer.byteLength(file.patch), 0) > maxMaterialBytes)
    throw new IntakeMaterialError("GitHub review material exceeds the total size limit.");
  const oldTree = await openIntakeTree(session, revision.base);
  const newTree = await openIntakeTree(session, revision.head);
  const verified = [];
  for (const row of files) {
    const before = await oldTree(row.previous_filename ?? row.filename);
    const after = await newTree(row.filename);
    if ((before === null) !== (row.status === "added") || (after === null) !== (row.status === "removed")
      || (after ?? before)?.sha !== row.sha)
      throw new IntakeMaterialError("GitHub file identities do not match the immutable comparison trees.");
    const oldText = before ? await readIntakeBlob(session, before.sha, maxReviewBlobBytes) : "";
    const newText = after ? await readIntakeBlob(session, after.sha, maxReviewBlobBytes) : "";
    if (!completePatch(row, oldText, newText))
      throw new IntakeMaterialError("GitHub returned an unsupported, incomplete or truncated file patch.");
    verified.push({ ...row, beforeMode: before?.mode ?? null, afterMode: after?.mode ?? null });
  }
  return verified;
}

export async function readIntakeDiff(session: Session, target: IntakeMaterialTarget) {
  try {
    const start = await readIntakePullIdentity(session, target);
    if (start.head.sha !== target.head) throw new IntakeMaterialError("GitHub PR head does not match the requested SHA.");
    if (start.changed_files < 1 || start.changed_files > maxFiles)
      throw new IntakeMaterialError(`Static review requires 1–${maxFiles} changed files.`);
    // Verify the mutable PR files view against the immutable base/head comparison.
    const [pullFiles] = await session.get(`${session.root}/pulls/${target.number}/files?per_page=100`, Type.Tuple([filePage]));
    const [first, ...later] = await session.get(`${session.root}/compare/${start.base.sha}...${target.head}?per_page=100`,
      Type.Array(comparison, { minItems: 1 }));
    if (!first?.files) throw new IntakeMaterialError("GitHub did not supply the immutable comparison file list.");
    const comparisons = [first, ...later];
    const commits = comparisons.flatMap(page => page.commits);
    if (later.some(page => page.files?.length) || comparisons.some(page =>
      page.base_commit.sha !== start.base.sha || page.merge_base_commit.sha !== first.merge_base_commit.sha
      || page.status !== first.status || page.total_commits !== first.total_commits)
      || commits.length !== first.total_commits || new Set(commits.map(row => row.sha)).size !== commits.length
      || !commits.some(row => row.sha === target.head))
      throw new IntakeMaterialError("GitHub comparison does not establish the exact base and head.");
    const files = parseFiles(pullFiles, start);
    if (JSON.stringify(files) !== JSON.stringify(parseFiles(first.files, start)))
      throw new IntakeMaterialError("GitHub PR patches differ from the immutable base/head comparison.");
    const verified = await verifyPatches(session, { base: first.merge_base_commit.sha, head: target.head }, files);
    const pull = normalizePull(start);
    if (JSON.stringify(pull) !== JSON.stringify(normalizePull(await readIntakePullIdentity(session, target))))
      throw new IntakeMaterialError("GitHub PR identity, branch or revision changed while reading the patches.");
    return { pull, mergeBase: first.merge_base_commit.sha, files: verified };
  } catch (error) {
    if (error instanceof PrReadError)
      throw new IntakeMaterialError(`Static review unavailable: ${error.message}.`);
    throw error;
  }
}

export function serializeIntakeDiff(snapshot: Awaited<ReturnType<typeof readIntakeDiff>>): string {
  // Preserve the exact data while keeping invisible direction/line controls out of the serialized prompt.
  const material = JSON.stringify(snapshot).replace(/[\x7f-\x9f\p{Cf}\p{Zl}\p{Zp}]/gu, char =>
    char.split("").map(unit => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`).join(""));
  if (Buffer.byteLength(material) > maxMaterialBytes)
    throw new IntakeMaterialError("GitHub review material exceeds the total size limit.");
  return material;
}

export function readIntakeMaterialTarget(material: string) {
  const branch = Type.Object({ ref: ref.properties.ref, sha });
  const { pull } = parseWire(Type.Object({ pull: Type.Object({ base: branch, head: branch }) }), material);
  return { baseRef: pull.base.ref, baseSha: pull.base.sha, headRef: pull.head.ref };
}

export async function readIntakeMaterial(
  repository: string, number: number, head: string, signal: AbortSignal, identity: IntakeRepositoryIdentity,
): Promise<string> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(intakeEvidenceDeadlineMs)]);
  const session = await openIntakeGitHubSession(repository, deadline);
  return serializeIntakeDiff(await readIntakeDiff(session, { number, head, identity }));
}
