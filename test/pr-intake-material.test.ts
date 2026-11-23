import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { intakeFixDigest, parseIntakeFix } from "../src/pr-intake-fix";

const root = "repos/owner/repo";
const pr = `${root}/pulls/7`;
const path = "src/subject.ts";
const head = "a".repeat(40), base = "b".repeat(40), mergeBase = "c".repeat(40), applied = "d".repeat(40);
const headRef = "changes/source";
const owner = { id: 17, login: "Owner", type: "User" };
const repo = { id: 23, full_name: "Owner/Repo", owner };
const fork = { id: 24, full_name: "Author/Repo", owner: { id: 18, login: "Author" } };
const identity = { repositoryId: repo.id, ownerId: owner.id };
const pull = {
  state: "open", number: 7, merged: false, draft: false, title: "Independent source edit",
  changed_files: 1, additions: 1, deletions: 1, user: { id: 18, login: "Author" },
  head: { ref: headRef, repo, sha: head }, base: { ref: "main", repo, sha: base },
};
const oldText = "export const answer = 0;\nconst keep = 'context';\n";
const headText = "export const answer = 1;\nconst keep = 'context';\n";
const fixedText = "export const answer = 2;\nconst keep = 'context';\n";
const proposal = { path, old: "export const answer = 1;", replacement: "export const answer = 2;" };
const patch = "@@ -1,2 +1,2 @@\n-export const answer = 0;\n+export const answer = 1;\n const keep = 'context';";
const branchId = "REF_original";
const repositoryId = "REP_original";
const branchEndpoint = `${root}/branches/${encodeURIComponent(headRef)}`;
const rulesEndpoint = `${root}/rules/branches/${encodeURIComponent(headRef)}`;
const compareEndpoint = `${root}/compare/${base}...${head}?per_page=100`;
const fileList = `${pr}/files?per_page=100`;
const ledger: string[] = [];
afterEach(async () => {
  for (const directory of ledger.splice(0)) await rm(directory, { recursive: true, force: true });
});

function blob(text: string) {
  const data = Buffer.from(text);
  return {
    sha: createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex"),
    encoding: "base64", size: data.length, content: data.toString("base64"),
  };
}
const oldBlob = blob(oldText), headBlob = blob(headText), newBlob = blob(fixedText), wrongBlob = blob("not the approved fix\n");
const row = { filename: path, sha: headBlob.sha, status: "modified", additions: 1, deletions: 1, changes: 2, patch };
const compare = { status: "diverged", base_commit: { sha: base }, merge_base_commit: { sha: mergeBase }, total_commits: 1,
  commits: [{ sha: head }], files: [row] };

function wireObjects(revision: string, digits: string, object: ReturnType<typeof blob>) {
  const tree = digits[0].repeat(40), nested = digits[1].repeat(40);
  return {
    [`${root}/git/commits/${revision}`]: [{ sha: revision, tree: { sha: tree } }],
    [`${root}/git/trees/${tree}`]: [{ sha: tree, truncated: false, tree: [{ path: "src", sha: nested, mode: "040000", type: "tree" }] }],
    [`${root}/git/trees/${nested}`]: [{ sha: nested, truncated: false,
      tree: [{ path: "subject.ts", sha: object.sha, mode: "100644", type: "blob" }] }],
    [`${root}/git/blobs/${object.sha}`]: [object],
  };
}

type Mode = "read" | "apply" | "loss" | "wrong-blob" | "head-race" | "fence" | "default-branch";
type WireOptions = {
  readonly mode?: Mode; readonly rows?: readonly unknown[]; readonly comparisonRows?: readonly unknown[];
  readonly snapshots?: readonly unknown[]; readonly protected?: boolean; readonly rules?: readonly unknown[];
  readonly viewerOverride?: number;
};
async function fixture(options: WireOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), "superagent-review-material-"));
  ledger.push(directory);
  const mode = options.mode ?? "read";
  await writeFile(join(directory, "plan.json"), JSON.stringify({
    options, mode, pr, path, head, applied, headRef, branchId, repositoryId, root, base, owner, repo, pull,
    branchEndpoint, fixedText, newBlob, wrongBlob,
    replies: {
      user: [owner], [root]: [repo], [pr]: [pull],
      [fileList]: [options.rows ?? [row]],
      [compareEndpoint]: [{ ...compare, files: options.comparisonRows ?? options.rows ?? [row] }],
      [branchEndpoint]: [{ name: headRef, protected: options.protected ?? false, commit: { sha: head } }],
      [rulesEndpoint]: [options.rules ?? []],
      ...wireObjects(mergeBase, "12", oldBlob), ...wireObjects(head, "34", headBlob),
      ...wireObjects(applied, "56", mode === "wrong-blob" ? wrongBlob : newBlob),
    },
  }));
  const gh = join(directory, "gh");
  await writeFile(gh, `#!${process.execPath}\n` + String.raw`
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const dir = process.env.INTAKE_WIRE_FIXTURE;
const f = JSON.parse(readFileSync(dir + "/plan.json", "utf8"));
const a = process.argv.slice(2);
const send = value => process.stdout.write(JSON.stringify(value));
if (a.join(" ") === "auth token --hostname github.com") {
  process.stdout.write("offline-intake-token\n");
  process.exit(0);
}
if (a[0] !== "api" || a[a.indexOf("--hostname") + 1] !== "github.com" || process.env.GH_TOKEN !== "offline-intake-token")
  process.exit(91);
const endpoint = a.at(-1), method = a[a.indexOf("--method") + 1];
const log = dir + "/calls", state = dir + "/commit";
const current = existsSync(state) ? JSON.parse(readFileSync(state, "utf8")) : null;
const prior = existsSync(log) ? readFileSync(log, "utf8").trimEnd().split("\n") : [];
if (method === "GET" && a.includes("--paginate") && a.includes("--slurp")) {
  appendFileSync(log, endpoint + "\n");
  const fallback = f.replies[endpoint];
  if (endpoint === f.pr) {
    if (current) send([{ ...f.pull, head: { ...f.pull.head, sha: f.applied } }]);
    else {
      const index = prior.filter(value => value === endpoint).length;
      const snapshots = f.options.snapshots;
      send(snapshots ? [snapshots[index] ?? snapshots.at(-1)] : fallback);
    }
  } else if (current && endpoint === f.branchEndpoint) {
    send([{ ...fallback[0], commit: { sha: f.applied } }]);
  } else if (current && endpoint === f.root + "/commits/" + f.applied + "?per_page=100") {
    send([current]);
  } else if (fallback !== undefined) send(fallback);
  else process.exit(92);
} else if (method === "POST" && endpoint === "graphql" && a[a.indexOf("--input") + 1] === "-") {
  const { query, variables } = JSON.parse(readFileSync(0, "utf8"));
  if (query.startsWith("query IntakeFixBranch")) {
    if (variables.ref !== "refs/heads/" + f.headRef || variables.number !== 7) process.exit(93);
    send({ data: { viewer: { login: f.owner.login, databaseId: f.options.viewerOverride ?? f.owner.id }, repository: {
      id: f.repositoryId, databaseId: f.repo.id, nameWithOwner: f.repo.full_name, isArchived: false, isDisabled: false,
      defaultBranchRef: { name: f.mode === "default-branch" ? f.headRef : f.pull.base.ref },
      ref: { id: f.branchId, name: f.headRef, target: { oid: f.head } },
      pullRequest: { state: "OPEN", isDraft: false, baseRefName: f.pull.base.ref, baseRefOid: f.base,
        headRefName: f.headRef, headRefOid: f.head, headRepository: { id: f.repositoryId } },
    } } });
  } else if (query.startsWith("mutation IntakeFixCommit")) {
    appendFileSync(log, "write\n");
    if (!existsSync(dir + "/fence")) process.exit(94);
    const { input } = variables;
    const currentHead = f.mode === "head-race" ? f.applied : f.head;
    if (input.expectedHeadOid !== currentHead || input.branch.id !== f.branchId || current) process.exit(95);
    const { additions } = input.fileChanges;
    if (Object.keys(input.fileChanges).length !== 1 || additions.length !== 1 || additions[0].path !== f.path
      || Buffer.from(additions[0].contents, "base64").toString() !== f.fixedText) process.exit(96);
    const newBlob = f.mode === "wrong-blob" ? f.wrongBlob : f.newBlob;
    writeFileSync(state, JSON.stringify({ sha: f.applied, parents: [{ sha: currentHead }],
      files: [{ sha: newBlob.sha, filename: f.path, status: "modified" }],
      commit: { message: input.message.headline },
    }));
    if (f.mode === "loss" || f.mode === "wrong-blob") process.exit(97);
    send({ data: { createCommitOnBranch: { clientMutationId: input.clientMutationId, ref: { id: f.branchId },
      commit: { oid: f.applied, parents: { totalCount: 1, nodes: [{ oid: currentHead }] } },
    } } });
  } else process.exit(98);
} else process.exit(99);
`);
  await chmod(gh, 0o700);
  const runner = join(directory, "run.ts");
  await writeFile(runner, `
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { readIntakeMaterial } from ${JSON.stringify(resolve(import.meta.dir, "../src/pr-intake-material.ts"))};
import { applyIntakeFix, reconcileIntakeFix } from ${JSON.stringify(resolve(import.meta.dir, "../src/pr-intake-fix.ts"))};
const dir = ${JSON.stringify(directory)};
const mode = ${JSON.stringify(mode)};
const signal = new AbortController().signal;
const proposal = ${JSON.stringify(proposal)};
const identity = ${JSON.stringify(identity)};
const [repository, number, head, branch] = ${JSON.stringify(["owner/repo", 7, head, headRef])};
let result, material, reconcile;
try {
  if (mode === "read") material = JSON.parse(await readIntakeMaterial(repository, number, head, signal, identity));
  else {
    result = await applyIntakeFix(repository, number, head, proposal, signal, observed => {
      if (mode === "fence" || JSON.parse(observed).pull.head.ref !== branch) throw Error("fence refused");
      writeFileSync(dir + "/fence", observed);
    }, identity);
    if (mode === "loss" || mode === "wrong-blob" || mode === "head-race")
      reconcile = await reconcileIntakeFix(repository, number, head, proposal, signal, branch, identity);
  }
} catch (error) { result = { status: "threw", reason: error.message }; }
const log = dir + "/calls";
console.log(JSON.stringify({ result, material, reconcile, committed: existsSync(dir + "/commit"),
  writes: existsSync(log) ? readFileSync(log, "utf8").trimEnd().split("\\n").filter(line => line === "write").length : 0,
}));
`);
  const child = Bun.spawn([process.execPath, "--no-env-file", runner], {
    env: { ...process.env, GH_TOKEN: "", GITHUB_TOKEN: "", INTAKE_WIRE_FIXTURE: directory, PATH: `${directory}:${process.env.PATH ?? ""}` },
    stdout: "pipe", stderr: "pipe",
  });
  const [status, output, diagnostics] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (status !== 0) throw new Error(diagnostics);
  return JSON.parse(output);
}

test("static material pins both revisions, complete text and mode even for an external fork", async () => {
  const forkPull = { ...pull, head: { ...pull.head, repo: fork } };
  const result = await fixture({ snapshots: [forkPull] });
  expect(result.material).toMatchObject({
    mergeBase, pull: { base: { ref: "main", sha: base }, head: { ref: headRef, sha: head, name: "author/repo", repositoryId: fork.id } },
    files: [{ filename: path, sha: headBlob.sha, patch, beforeMode: "100644", afterMode: "100644" }],
  });
  expect(result.writes).toBe(0);
});

test.each([
  { label: "missing changed file", rows: [], reason: /incomplete or inconsistent changed-file list/i },
  { label: "omitted patch", rows: [{ ...row, patch: undefined }], reason: /omitted a file patch/i },
  { label: "oversized patch", rows: [{ ...row, patch: "x".repeat(17 * 1024) }], reason: /patch exceeds/i },
  { label: "matching patch counts but truncated line bytes", rows: [{ ...row, patch: patch.slice(0, -3) }], reason: /truncated file patch/i },
  { label: "changed comparison head material", comparisonRows: [{ ...row, patch: patch + "\n different" }], reason: /differ from the immutable/i },
  { label: "moved base with stable head", snapshots: [pull, { ...pull, base: { ...pull.base, sha: applied } }], reason: /changed while reading/i },
  { label: "owner as PR author", snapshots: [{ ...pull, user: owner }], reason: /independent pull request authorship/i },
])("withholds review material for $label", async ({ reason, ...options }) => {
  const result = await fixture(options);
  expect(result.result).toMatchObject({ status: "threw", reason: expect.stringMatching(reason) });
  expect(result.material).toBeUndefined();
});

test("requires one exact structured lane verdict and binds every executable proposal field to its digest", () => {
  const correct = { verdict: "fix", summary: "Correct the value", ...proposal };
  expect(parseIntakeFix(JSON.stringify(correct))).toEqual(proposal);
  for (const bad of [
    `\`\`\`json\n${JSON.stringify(correct)}\n\`\`\``, JSON.stringify({ ...correct, approve: true }),
    `{"verdict":"approve",${JSON.stringify(correct).slice(1)}`,
    JSON.stringify({ ...correct, path: "src/../subject.ts" }), JSON.stringify({ ...correct, path: "src/tool.config.ts" }),
  ]) expect(parseIntakeFix(bad)).toBeNull();
  const digest = intakeFixDigest("owner/repo", 7, head, proposal);
  expect(digest).toMatch(/^[0-9a-f]{64}$/);
  expect(new Set([
    digest, intakeFixDigest("owner/clone", 7, head, proposal), intakeFixDigest("owner/repo", 8, head, proposal),
    intakeFixDigest("owner/repo", 7, applied, proposal), intakeFixDigest("owner/repo", 7, head, { ...proposal, path: "src/other.ts" }),
    intakeFixDigest("owner/repo", 7, head, { ...proposal, old: "answer" }),
    intakeFixDigest("owner/repo", 7, head, { ...proposal, replacement: "different" }),
  ]).size).toBe(7);
});

test.each([
  { label: "fork head", mode: "apply", snapshots: [{ ...pull, head: { ...pull.head, repo: fork } }] },
  { label: "default branch", mode: "default-branch" },
  { label: "protected branch", mode: "apply", protected: true },
  { label: "effective rules", mode: "apply", rules: [{ type: "required_status_checks" }] },
  { label: "changed authenticated numeric identity", mode: "apply", viewerOverride: 9000 },
] satisfies readonly (WireOptions & { readonly label: string })[])("never sends a fix mutation for $label", async options => {
  const result = await fixture(options);
  expect(result.result.status).toBe("blocked");
  expect(result.writes).toBe(0);
});

test("propagates a refused owner fence without sending a fix mutation", async () => {
  const result = await fixture({ mode: "fence" });
  expect(result.result).toEqual({ status: "threw", reason: "fence refused" });
  expect(result.writes).toBe(0);
});

test.each([
  { mode: "apply", status: "applied", reconciled: undefined, committed: true },
  { mode: "loss", status: "unknown", reconciled: { status: "applied", sha: applied }, committed: true },
  { mode: "wrong-blob", status: "unknown", reconciled: { status: "unknown" }, committed: true },
  { mode: "head-race", status: "unknown", reconciled: { status: "unknown" }, committed: false },
] as const)("observes exact fix effect without a second write ($mode)", async ({ mode, status, reconciled, committed }) => {
  const result = await fixture({ mode });
  expect(result.result).toMatchObject(status === "applied" ? { status, sha: applied } : { status });
  if (reconciled) expect(result.reconcile).toMatchObject(reconciled);
  else expect(result.reconcile).toBeUndefined();
  expect(result.committed).toBe(committed);
  expect(result.writes).toBe(1);
});
