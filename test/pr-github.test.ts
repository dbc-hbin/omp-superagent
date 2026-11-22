import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parsePrRef, prKey } from "../src/pr-github";

const head = "a".repeat(40);
const old = "b".repeat(40);
const root = "repos/owner/repo";
const pr = `${root}/pulls/7`;
const issueComments = `${root}/issues/7/comments?per_page=100`;
const reviewComments = `${pr}/comments?per_page=100`;
const reviewEndpoint = `${pr}/reviews?per_page=100`;
const timelineEndpoint = `${root}/issues/7/timeline?per_page=100`;
const checkEndpoint = `${root}/commits/${head}/check-runs?per_page=100&filter=latest`;
const statusEndpoint = `${root}/commits/${head}/statuses?per_page=100`;
const compareEndpoint = `${root}/compare/${old}...${head}?per_page=100`;
const metadata = { head: { sha: head }, state: "open", merged: false, merge_commit_sha: null };
const roots: string[] = [];
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }); });

type Reply = { readonly body?: unknown; readonly raw?: string; readonly exit?: number; readonly stall?: boolean; readonly after?: string };
async function fixture(overrides: Readonly<Record<string, readonly Reply[]>> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "superagent-pr-"));
  roots.push(directory);
  const checkReplies = overrides[checkEndpoint] ?? [{ body: [{ total_count: 0, check_runs: [] }] }];
  const [firstCheck] = checkReplies;
  const plan = {
    [pr]: [{ body: [metadata] }, { body: [metadata] }], user: [{ body: [{ login: "Me" }] }],
    [issueComments]: [{ body: [[]] }], [reviewComments]: [{ body: [[]] }],
    [reviewEndpoint]: [{ body: [[]] }], [timelineEndpoint]: [{ body: [[]] }],
    [statusEndpoint]: [{ body: [[]] }],
    ...overrides,
    [checkEndpoint]: firstCheck && checkReplies.length === 1 ? [firstCheck, firstCheck] : checkReplies,
  };
  await writeFile(join(directory, "plan.json"), JSON.stringify(plan));
  const executable = join(directory, "gh");
  await writeFile(executable, `#!${process.execPath}
import { readFileSync, appendFileSync, writeFileSync } from "node:fs";
const directory = ${JSON.stringify(directory)};
const args = process.argv.slice(2);
if (args[0] !== "api" || args[args.indexOf("--hostname") + 1] !== "github.com"
  || args[args.indexOf("--method") + 1] !== "GET" || !args.includes("--paginate") || !args.includes("--slurp")) process.exit(91);
const endpoint = args.at(-1);
const plan = JSON.parse(readFileSync(directory + "/plan.json", "utf8"));
let calls = [];
try { calls = readFileSync(directory + "/calls", "utf8").trim().split("\\n"); }
catch (error) { if (error.code !== "ENOENT") throw error; }
const index = calls.filter(call => call === endpoint).length;
appendFileSync(directory + "/calls", endpoint + "\\n");
const reply = plan[endpoint]?.[index];
if (!reply) { console.error("Unexpected API request"); process.exit(92); }
if (reply.after && !calls.includes(reply.after)) process.exit(93);
if (reply.exit) { console.error("ghp_private_token private@example.invalid private response body"); process.exit(reply.exit); }
if (reply.stall) { writeFileSync(directory + "/ready", ""); setInterval(() => {}, 1000); }
else process.stdout.write(reply.raw ?? JSON.stringify(reply.body));
`);
  await chmod(executable, 0o700);
  const runner = join(directory, "read.ts");
  await writeFile(runner, `
import { watch } from "node:fs";
import { readPrSnapshot } from ${JSON.stringify(resolve(import.meta.dir, "../src/pr-github.ts"))};
const controller = new AbortController();
const cancel = process.argv[3] === "cancel";
const observer = cancel ? watch(${JSON.stringify(directory)}, (_event, name) => {
  if (name === "ready") controller.abort();
}) : undefined;
if (process.argv[3] === "preabort") controller.abort();
try {
  const snapshot = await readPrSnapshot({ owner: "owner", repo: "repo", number: 7 }, {
    signal: controller.signal, ...(process.argv[2] === "-" ? {} : { previousHead: process.argv[2] }),
  });
  console.log(JSON.stringify({ snapshot }));
} catch (error) {
  if (!(error instanceof Error)) throw error;
  console.log(JSON.stringify({ error: { name: error.name, message: error.message }, keys: Object.keys(error) }));
} finally { observer?.close(); }
`);
  return async (previousHead = "-", cancellation = ""): Promise<unknown> => {
    const child = Bun.spawn([process.execPath, "--no-env-file", runner, previousHead, cancellation], {
      env: { ...process.env, PATH: directory }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      signal: AbortSignal.timeout(15_000),
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    const value: unknown = JSON.parse(stdout);
    return value;
  };
}

const comment = (id: number, body = "Please fix this") => ({
  id, user: { login: "Reviewer" }, body, html_url: `https://github.com/owner/repo/pull/7#issuecomment-${id}`, updated_at: "2026-11-17T00:00:00Z",
});
const commit = (sha: string, author: string | null = "me", committer: string | null = author) => ({
  sha, author: author === null ? null : { login: author }, committer: committer === null ? null : { login: committer },
});
const comparison = (commits: readonly unknown[], status = "ahead", mergeBase = old, total = commits.length) => ({
  status, total_commits: total, base_commit: { sha: old }, merge_base_commit: { sha: mergeBase }, commits,
});
const check = (id: number, conclusion = "failure") => ({
  id, name: "build", html_url: `https://github.com/owner/repo/actions/runs/${id}`, head_sha: head,
  status: "completed", conclusion, started_at: "2026-11-17T00:00:00Z", completed_at: `2026-11-17T00:00:${id}Z`,
});
const status = (id: number, state = "failure", context = "deploy") => ({
  id, state, context, target_url: "https://ci.example.invalid/result?token=private", created_at: "2026-11-17T00:00:00Z",
});

test.each(["OWNER/Repo#7", "https://github.com/OWNER/Repo/pull/7"])("normalizes accepted PR reference %s", value => {
  expect(parsePrRef(value)).toEqual({ owner: "owner", repo: "repo", number: 7 });
  expect(prKey(parsePrRef(value))).toBe("owner/repo#7");
});
test.each([
  "--help", " owner/repo#7", "owner/repo#7\n", "owner/repo#0", "owner/repo#01", "owner/repo#9007199254740992",
  "owner/../#7", "owner/..#7", "owner/repo#7 --help", "https://user:pass@github.com/owner/repo/pull/7",
  "https://github.com/owner/repo/pull/7/files", "https://github.com/owner/repo/pull/7/",
  "https://github.com/owner/repo/pull/7?x=1", "https://github.com/owner/repo/pull/7#comment",
  "https://github.com:443/owner/repo/pull/7", "https://github.com/owner/%72epo/pull/7",
])("rejects noncanonical or unsafe PR reference %s", value => {
  expect(() => parsePrRef(value)).toThrow("Invalid GitHub PR reference");
});

test("collects every feedback page, deduplicates deterministically, and observes review dismissals", async () => {
  const responses = {
    [issueComments]: [{ body: [[comment(2)], [comment(1), comment(2)]] }],
    [reviewComments]: [{ body: [[comment(3, "Inline feedback")]] }],
    [reviewEndpoint]: [{ body: [[{
      id: 4, user: { login: "Reviewer" }, body: "Changes needed", state: "DISMISSED",
      html_url: "https://github.com/owner/repo/pull/7#pullrequestreview-4", submitted_at: "2026-11-17T00:00:00Z",
    }]] }],
    [timelineEndpoint]: [{ body: [[{ event: "labeled" }], [{
      event: "review_dismissed", id: 5, actor: { login: "Maintainer" }, created_at: "2026-11-17T00:01:00Z",
      dismissed_review: { review_id: 4, dismissal_message: "Obsolete review" },
    }]] }],
  };
  const result = await (await fixture(responses))();
  expect(result).toMatchObject({ snapshot: { head, state: "open", self: "me", mergedSha: null, feedback: [
    expect.objectContaining({ kind: "review_dismissed", actor: "maintainer", text: "Obsolete review" }),
    expect.objectContaining({ kind: "issue_comment", text: "Please fix this" }),
    expect.objectContaining({ kind: "issue_comment", text: "Please fix this" }),
    expect.objectContaining({ kind: "review_dismissed", actor: "reviewer", text: "Changes needed" }),
    expect.objectContaining({ kind: "review_comment", text: "Inline feedback" }),
  ] } });
  expect(await (await fixture(responses))()).toEqual(result);
});

test("normalizes untrusted feedback, names, URLs and never projects email identities", async () => {
  const run = await fixture({
    [issueComments]: [{ body: [[comment(1, "A\u001b\u202eB private@example.invalid \uD55C\uBE48@example.invalid\n" + "x".repeat(5000))]] }],
    [checkEndpoint]: [{ body: [{ total_count: 1, check_runs: [{
      ...check(1), name: "build\u202e private@example.invalid", html_url: "https://user:secret@ci.example.invalid/result",
    }] }] }],
  });
  expect(await run()).toMatchObject({ snapshot: {
    feedback: [expect.objectContaining({ text: ("A  B [email] [email]\n" + "x".repeat(5000)).slice(0, 4096) })],
    failures: [expect.objectContaining({ name: "build  [email]", url: "" })],
  } });
});

test.each([
  { label: "malformed second comment page", endpoint: issueComments, reply: { body: [[], [{}]] } },
  { label: "invalid JSON", endpoint: reviewComments, reply: { raw: "private body not JSON" } },
  { label: "missing slurp page", endpoint: reviewEndpoint, reply: { body: [] } },
  { label: "malformed dismissal", endpoint: timelineEndpoint, reply: { body: [[{ event: "review_dismissed" }]] } },
  { label: "incomplete checks", endpoint: checkEndpoint, reply: { body: [{ total_count: 2, check_runs: [check(1)] }] } },
  { label: "a successful check for another head", endpoint: checkEndpoint,
    reply: { body: [{ total_count: 1, check_runs: [{ ...check(1, "success"), head_sha: old }] }] } },
  { label: "unavailable endpoint", endpoint: statusEndpoint, reply: { exit: 1 } },
])("rejects $label instead of committing an empty observation", async ({ endpoint, reply }) => {
  const result = await (await fixture({ [endpoint]: [reply] }))();
  expect(result).toMatchObject({ error: { name: "PrReadError", message: expect.stringMatching(/^GitHub PR observation (response was invalid or incomplete|request failed)$/) } });
  expect(JSON.stringify(result)).not.toMatch(/ghp_private_token|private@example|private body|private response/);
});

test.each([
  { ...metadata, head: { sha: old } }, { ...metadata, state: "closed" },
  { ...metadata, state: "closed", merged: true, merge_commit_sha: old },
])("rejects metadata movement during the read", async end => {
  const run = await fixture({ [pr]: [{ body: [metadata] }, { body: [end] }] });
  expect(await run()).toMatchObject({ error: { message: "GitHub PR changed during observation" } });
});

test.each([
  { state: "closed", merged: false, merge_commit_sha: null, expected: "closed" },
  { state: "closed", merged: true, merge_commit_sha: old, expected: "merged" },
])("projects terminal PR state $expected", async row => {
  const terminal = { ...metadata, state: row.state, merged: row.merged, merge_commit_sha: row.merge_commit_sha };
  const run = await fixture({ [pr]: [{ body: [terminal] }, { body: [terminal] }] });
  expect(await run()).toMatchObject({ snapshot: { state: row.expected, mergedSha: row.merge_commit_sha } });
});

test.each([
  { commits: [commit(head)], expected: "self" },
  { commits: [commit("c".repeat(40)), commit(head, "other")], expected: "external" },
  { commits: [commit(head, "me", "other")], expected: "external" },
  { commits: [commit(head, null)], expected: "unknown" },
  { commits: [commit(head)], expected: "rewritten", status: "diverged", mergeBase: "d".repeat(40) },
])("classifies head movement conservatively: $expected", async row => {
  const run = await fixture({ [compareEndpoint]: [{ body: [comparison(row.commits, row.status, row.mergeBase)] }] });
  expect(await run(old)).toMatchObject({ snapshot: { headChange: row.expected } });
});

test("considers all compare pages rather than treating the first 250 commits as self-authored", async () => {
  const commits = Array.from({ length: 250 }, (_, i) => commit((i + 1).toString(16).padStart(40, "0")));
  const run = await fixture({ [compareEndpoint]: [{ body: [
    comparison(commits, "ahead", old, 251), comparison([commit(head, "other")], "ahead", old, 251),
  ] }] });
  expect(await run(old)).toMatchObject({ snapshot: { headChange: "external" } });
});

test("rejects incomplete compare pagination instead of suppressing an unknown external head", async () => {
  const run = await fixture({ [compareEndpoint]: [{ body: [comparison([commit(head)], "ahead", old, 251)] }] });
  expect(await run(old)).toMatchObject({ error: { message: "GitHub PR observation response was invalid or incomplete" } });
});

test("keeps inaccessible old heads unknown", async () => {
  const run = await fixture({ [compareEndpoint]: [{ exit: 1 }] });
  expect(await run(old)).toMatchObject({ snapshot: { headChange: "unknown" } });
});

test("projects current CI failures with distinct rerun identities and drops superseded statuses", async () => {
  const responses = {
    [checkEndpoint]: [{ body: [{ total_count: 2, check_runs: [check(11)] }, { total_count: 2, check_runs: [check(12, "cancelled")] }] }],
    [statusEndpoint]: [{ body: [[status(21), status(22, "success")], [status(23, "failure", "lint")]] }],
  };
  const result = await (await fixture(responses))();
  expect(result).toMatchObject({ snapshot: { ci: { outcome: "failed" }, failures: [
    expect.objectContaining({ key: expect.stringMatching(/^check:11:/), conclusion: "failure" }),
    expect.objectContaining({ key: expect.stringMatching(/^check:12:/), conclusion: "cancelled" }),
    { key: "status:23", name: "lint", url: "https://ci.example.invalid/result", conclusion: "failure" },
  ] } });
});

test.each([
  { label: "no checks or statuses", runs: [], statuses: [], outcome: "missing" },
  { label: "only skipped checks", runs: [check(11, "skipped")], statuses: [], outcome: "skipped" },
  { label: "only neutral checks", runs: [check(11, "neutral")], statuses: [], outcome: "skipped" },
  { label: "substantive success alongside optional skips", runs: [check(11, "neutral"), check(12, "success"), check(13, "skipped")],
    statuses: [], outcome: "passed_with_skips", skipped: 2 },
  { label: "a new pending status that superseded a success", runs: [check(11, "success")],
    statuses: [status(21, "success"), status(22, "pending")], outcome: "pending" },
  { label: "checks still running", runs: [{ ...check(11, "success"), status: "in_progress", conclusion: null, completed_at: null }],
    statuses: [status(21, "success")], outcome: "pending" },
  { label: "a purported success without a completion time", runs: [{ ...check(11, "success"), completed_at: null }],
    statuses: [], outcome: "pending" },
  { label: "a completed check and status rerun replacing an old failure", runs: [check(11, "success")],
    statuses: [status(22, "success"), status(21, "failure")], outcome: "passed", skipped: 0 },
])("classifies current-head CI with $label as $outcome", async ({ runs, statuses, outcome, skipped }) => {
  const run = await fixture({
    [checkEndpoint]: [{ body: [{ total_count: runs.length, check_runs: runs }] }],
    [statusEndpoint]: [{ body: [statuses] }],
  });
  const ci = outcome === "passed" || outcome === "passed_with_skips"
    ? { outcome, skipped, key: expect.stringMatching(new RegExp(`^ci-pass:${head}:[0-9a-f]{24}$`)) }
    : { outcome };
  expect(await run()).toMatchObject({ snapshot: { head, ci, failures: [] } });
});

test("pass identity ignores API row order but changes for a distinct successful attempt", async () => {
  async function observe(runs: readonly unknown[], statuses: readonly unknown[]) {
    const result = await (await fixture({
      [checkEndpoint]: [{ body: [{ total_count: runs.length, check_runs: runs }] }],
      [statusEndpoint]: [{ body: [statuses] }],
    }))();
    if (!result || typeof result !== "object" || !("snapshot" in result)
      || !result.snapshot || typeof result.snapshot !== "object" || !("ci" in result.snapshot))
      throw new Error(`Expected snapshot CI evidence: ${JSON.stringify(result)}`);
    const ci = result.snapshot.ci;
    if (!ci || typeof ci !== "object" || !("outcome" in ci) || ci.outcome !== "passed" || !("key" in ci) || typeof ci.key !== "string")
      throw new Error(`Expected a completed CI identity: ${JSON.stringify(ci)}`);
    return ci.key;
  }
  const checks = [check(11, "success"), check(12, "success")];
  const statuses = [status(21, "success"), status(22, "success", "docs")];
  const result = await observe(checks, statuses);
  expect(await observe(checks.toReversed(), statuses.toReversed())).toEqual(result);
  expect(await observe(checks, [status(23, "success"), status(22, "success", "docs")])).not.toEqual(result);
  expect(await observe([{ ...check(11, "success"), completed_at: "2026-11-17T01:00:11Z" }, check(12, "success")],
    statuses)).not.toEqual(result);
});

test.each([
  { label: "the same check moves to pending", before: [check(11, "success")],
    after: [{ ...check(11, "success"), status: "in_progress", conclusion: null, completed_at: null }] },
  { label: "a new check appears after a status-only success", before: [],
    after: [{ ...check(12, "success"), status: "queued", conclusion: null, started_at: null, completed_at: null }] },
  { label: "a replacement attempt has already completed", before: [check(11, "success")], after: [check(12, "success")] },
])("withholds a CI pass on the same PR head if $label across the status read", async ({ before, after }) => {
  const run = await fixture({
    [checkEndpoint]: [
      { body: [{ total_count: before.length, check_runs: before }] },
      { body: [{ total_count: after.length, check_runs: after }], after: statusEndpoint },
    ],
    [statusEndpoint]: [{ body: [[status(21, "success")]] }],
  });
  expect(await run()).toMatchObject({ error: { message: "GitHub PR check attempts changed during observation" } });
});

test.each(["cancel", "preabort"])("cancels %s reads without leaking subprocess diagnostics", async cancellation => {
  const run = await fixture({ [pr]: [{ stall: true }] });
  expect(await run("-", cancellation)).toMatchObject({ error: { name: "PrReadError", message: "GitHub PR observation was cancelled" } });
});
