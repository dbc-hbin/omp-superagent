import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { IntakeMergeIdentity } from "../src/pr-intake-github";

const head = "a".repeat(40);
const otherHead = "b".repeat(40);
const baseSha = "c".repeat(40);
const mergeSha = "d".repeat(40);
const prNode = "PR_kwDOBT_93r4A";
const replacementNode = "PR_kwDOPGX81r5B";
const root = "repos/owner/repo";
const endpoint = `${root}/pulls/7`;
const list = `${root}/pulls?state=open&per_page=100`;
const rulesets = `${root}/rulesets?per_page=100`;
const rule = `${root}/rulesets/12`;
const branch = `${root}/branches/main`;
const branchRules = `${root}/rules/branches/main?per_page=100`;
const reviews = `${endpoint}/reviews?per_page=100`;
const checks = `${root}/commits/${head}/check-runs?per_page=100&filter=latest`;
const statuses = `${root}/commits/${head}/status?per_page=100`;
const commit = `${root}/git/commits/${mergeSha}`;
const owner = { id: 123, login: "OwNeR", type: "User" };
const author = { id: 124, login: "Someone" };
const repo = { id: 987, full_name: "OWNER/Repo", owner };
const identity = { repositoryId: repo.id, ownerId: owner.id };
const reviewedIdentity = { ...identity, baseRef: "main", baseSha };
const writableRepo = { ...repo, archived: false, disabled: false, default_branch: "main",
  allow_merge_commit: true, permissions: { push: true } };
const created = "2026-11-17T00:00:00Z";
const pull = {
  number: 7, node_id: prNode, state: "open", user: author, head: { sha: head }, base: { repo, ref: "main", sha: baseSha },
  created_at: created, merged: false, merge_commit_sha: null, draft: false, mergeable: true, mergeable_state: "clean",
};
const feature = "feature/exact";
const localPull = { ...pull, head: { sha: head, ref: feature, repo } };
const activeRuleset = { id: 12, source: "owner/repo", source_type: "Repository", target: "branch", enforcement: "active" };
const policy = {
  ...activeRuleset, bypass_actors: [], conditions: { ref_name: { include: ["~ALL"], exclude: [] } },
  rules: [
    { type: "pull_request", parameters: { required_approving_review_count: 1,
      dismiss_stale_reviews_on_push: true, require_last_push_approval: true, allowed_merge_methods: ["merge"] } },
    { type: "required_status_checks", parameters: { strict_required_status_checks_policy: true,
      required_status_checks: [{ context: "build", integration_id: 19 }] } },
  ],
};
const headExcluded = (exclude: string[]) => ({ ...policy, conditions: { ref_name: { include: ["~ALL"], exclude } } });
const exactPolicy = headExcluded([`refs/heads/${feature}`]);
const protectedBranch = { name: "main", commit: { sha: baseSha }, protected: true, protection: {
  enabled: false, required_status_checks: { enforcement_level: "off", contexts: [] },
} };
const effectiveRules = policy.rules.map(row => ({
  ...row, ruleset_id: activeRuleset.id, ruleset_source: activeRuleset.source, ruleset_source_type: activeRuleset.source_type,
}));
const inheritedCiRule = {
  type: "required_status_checks", ruleset_id: 13, ruleset_source: "parent", ruleset_source_type: "Organization",
  parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: "security", integration_id: 20 }] },
};
const approval = { id: 30, user: { id: 125 }, submitted_at: created, commit_id: head, state: "APPROVED" };
const run = () => ({
  id: 100, name: "build", head_sha: head, html_url: null, status: "completed", conclusion: "success", app: { id: 19 },
  started_at: new Date(Date.now() - 60_000).toISOString(), completed_at: new Date(Date.now() - 30_000).toISOString(),
});
const checkPages = (...check_runs: readonly ReturnType<typeof run>[]) => [{ total_count: check_runs.length, check_runs }];
const securityRun = () => ({ ...run(), id: 101, name: "security", app: { id: 20 } });

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

type Action = "scan" | "inspect" | "merge" | "reconcile" | "fenced";
type Write = "accept" | "retarget-head" | "deny" | "lost-receipt" | "bad-receipt"
  | "slug-reassigned" | "wrong-node-receipt" | "wrong-head-receipt" | "graphql-errors"
  | "wrong-base-ref-receipt" | "wrong-base-parent-receipt" | "wrong-head-ref-receipt" | "wrong-head-repository-receipt";
type Replies = Readonly<Record<string, readonly unknown[]>>;
async function fixture(overrides: Replies = {}, write: Write = "accept") {
  const directory = await mkdtemp(join(tmpdir(), "superagent-pr-intake-"));
  directories.push(directory);
  await writeFile(join(directory, "plan.json"), JSON.stringify({
    user: [[owner]], [root]: [[writableRepo]], [list]: [[[pull]]], [endpoint]: [[pull]],
    [rulesets]: [[[activeRuleset]]], [rule]: [[policy]], [reviews]: [[[approval]]], [checks]: [checkPages(run())],
    [branch]: [[protectedBranch]], [branchRules]: [[effectiveRules]],
    [statuses]: [[{ sha: head, state: "pending", total_count: 0, statuses: [] }]],
    [commit]: [[{ sha: mergeSha, parents: [{ sha: baseSha }, { sha: head }] }]],
    ...overrides,
  }));
  const executable = join(directory, "gh");
  await writeFile(executable, `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const dir = ${JSON.stringify(directory)};
const args = process.argv.slice(2);
const last = args.at(-1);
const ledger = dir + "/calls";
const expectedToken = "fixture-github-token";
const mergeSHA = ${JSON.stringify(mergeSha)};
const baseSHA = ${JSON.stringify(baseSha)};
const initialHead = ${JSON.stringify(head)};
const changedHead = ${JSON.stringify(otherHead)};
const pr = ${JSON.stringify(endpoint)};
const original = ${JSON.stringify(prNode)};
const replacement = ${JSON.stringify(replacementNode)};
const mode = ${JSON.stringify(write)};
if (args.join(" ") === "auth token --hostname github.com") {
  if (process.env.GH_TOKEN) process.exit(90);
  process.stdout.write(expectedToken + "\\n");
  process.exit(0);
}
if (args[0] !== "api" || args[args.indexOf("--hostname") + 1] !== "github.com" || process.env.GH_TOKEN !== expectedToken)
  process.exit(91);
const method = args[args.indexOf("--method") + 1];
const prior = existsSync(ledger) ? readFileSync(ledger, "utf8").trim().split("\\n") : [];
const call = method + " " + last;
appendFileSync(ledger, call + "\\n");
if (method === "PUT" && last === pr + "/merge" && mode === "slug-reassigned") {
  writeFileSync(dir + "/replacement-merged", "");
  process.stdout.write("HTTP/2.0 200 OK\\r\\n\\r\\n" + JSON.stringify({ merged: true, sha: mergeSHA }));
  process.exit(0);
}
if (method === "POST" && last === "graphql") {
  if (!existsSync(dir + "/fence") || !args.includes("--include")) process.exit(92);
  const { query, variables: { input } } = JSON.parse(readFileSync(0, "utf8"));
  if (!query.includes("mergePullRequest(input: $input)") || Object.keys(input).length !== 3 || input.mergeMethod !== "MERGE")
    process.exit(95);
  const currentHead = mode === "retarget-head" ? changedHead : initialHead;
  if (input.expectedHeadOid !== currentHead) {
    process.stdout.write("HTTP/2.0 409 Conflict\\r\\n\\r\\n{}");
    process.exit(1);
  }
  if (mode === "deny") {
    process.stdout.write("HTTP/2.0 405 Method Not Allowed\\r\\n\\r\\n{}");
    process.exit(1);
  }
  if (input.pullRequestId === original) writeFileSync(dir + "/merged", mergeSHA);
  else if (input.pullRequestId === replacement && mode === "slug-reassigned") writeFileSync(dir + "/replacement-merged", "");
  else process.exit(96);
  if (mode === "lost-receipt") {
    console.error("private gh error must not escape");
    process.exit(1);
  }
  const receipt = { data: { mergePullRequest: { pullRequest: {
    id: mode === "wrong-node-receipt" ? replacement : input.pullRequestId,
    headRefOid: mode === "wrong-head-receipt" ? changedHead : currentHead,
    headRefName: mode === "wrong-head-ref-receipt" ? "other" : ${JSON.stringify(feature)},
    headRepository: { databaseId: mode === "wrong-head-repository-receipt" ? 55 : ${JSON.stringify(repo.id)} },
    baseRefName: mode === "wrong-base-ref-receipt" ? "other" : "main",
    merged: true, state: "MERGED", mergeCommit: {
      oid: mode === "bad-receipt" ? "invalid" : mergeSHA,
      parents: { totalCount: 2, nodes: [{ oid: mode === "wrong-base-parent-receipt" ? changedHead : baseSHA }, { oid: currentHead }] },
    },
  } } } };
  if (mode === "graphql-errors") receipt.errors = [{ message: "unexpected error in return data" }];
  process.stdout.write("HTTP/2.0 200 OK\\r\\n\\r\\n" + JSON.stringify(receipt));
  process.exit(0);
}
if (method !== "GET" || !args.includes("--paginate") || !args.includes("--slurp") || args.includes("--include"))
  process.exit(93);
const plan = JSON.parse(readFileSync(dir + "/plan.json", "utf8"));
const replies = plan[last];
const reply = replies?.[prior.filter(row => row === call).length] ?? replies?.at(-1);
if (reply === undefined) process.exit(94);
if (last === pr && existsSync(dir + "/merged")) {
  process.stdout.write(JSON.stringify([{
    ...reply[0], base: { ...reply[0].base, sha: mergeSHA }, merged: true, state: "closed", merge_commit_sha: mergeSHA,
  }]));
} else process.stdout.write(JSON.stringify(reply));
`);
  await chmod(executable, 0o700);
  const runner = join(directory, "run.ts");
  await writeFile(runner, `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { inspectIntakeMerge, mergeIntakePull, readIntakePulls } from ${JSON.stringify(resolve(import.meta.dir, "../src/pr-intake-github.ts"))};
const dir = ${JSON.stringify(directory)};
const action = process.argv[2];
const repository = process.argv[3];
const reviewed = process.argv[4];
const identity = JSON.parse(process.argv[5]);
const signal = new AbortController().signal;
let result;
try {
  if (action === "scan") result = await readIntakePulls(repository, signal);
  else if (action === "inspect") result = await inspectIntakeMerge(repository, 7, reviewed, signal, identity);
  else {
    const merge = await mergeIntakePull(repository, 7, reviewed, signal, () => {
      if (action === "fenced") throw new Error("Stopped before write");
      writeFileSync(dir + "/fence", "");
    }, identity);
    result = action === "reconcile" ? { merge, observed: await inspectIntakeMerge(repository, 7, reviewed, signal, identity) } : merge;
  }
} catch (error) {
  if (!(error instanceof Error)) throw error;
  result = { error: error.name, message: error.message };
}
const calls = existsSync(dir + "/calls") ? readFileSync(dir + "/calls", "utf8").trim().split("\\n") : [];
console.log(JSON.stringify({
  result, writes: calls.filter(row => /^(POST|PUT) /.test(row)).length, fenced: existsSync(dir + "/fence"),
  merged: existsSync(dir + "/merged"), replacementMerged: existsSync(dir + "/replacement-merged"),
}));
`);
  return async (action: Action, enrolled: IntakeMergeIdentity = reviewedIdentity): Promise<unknown> => {
    const child = Bun.spawn([process.execPath, "--no-env-file", runner, action, "Owner/Repo", head, JSON.stringify(enrolled)], {
      env: { ...process.env, PATH: directory, GH_TOKEN: "", GITHUB_TOKEN: "" },
      stdin: "ignore", stdout: "pipe", stderr: "pipe", signal: AbortSignal.timeout(15_000),
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    const value: unknown = JSON.parse(stdout);
    return value;
  };
}

test("owned repository discovery validates each page and returns normalized identity and epoch milliseconds", async () => {
  const scan = await fixture({ [list]: [[[pull], [{ ...pull, number: 9, user: { id: 126, login: "Automation[bot]" },
    head: { sha: otherHead }, created_at: "2026-11-17T01:00:00Z" }]]] });
  expect(await scan("scan")).toEqual({ result: { ...identity, self: "owner", pulls: [
    { number: 7, head, author: "someone", createdAt: 1794873600000 },
    { number: 9, head: otherHead, author: "automation[bot]", createdAt: 1794877200000 },
  ] }, writes: 0, fenced: false, merged: false, replacementMerged: false });
});

test("discovery excludes own PRs by both account ID and normalized login", async () => {
  const scan = await fixture({ [list]: [[[pull, { ...pull, number: 8, user: { ...owner, login: "OldName" } },
    { ...pull, number: 9, user: { id: 999, login: "owner" } }]]] });
  expect(await scan("scan")).toMatchObject({
    result: { pulls: [{ number: 7, author: "someone" }] }, writes: 0,
  });
});

test("discovery skips an open PR with a deleted author without losing other PRs", async () => {
  const scan = await fixture({ [list]: [[[{ ...pull, number: 8, user: null }], [pull]]] });
  expect(await scan("scan")).toMatchObject({
    result: { pulls: [{ number: 7, author: "someone" }] }, writes: 0,
  });
});

const invalidDiscovery: readonly { readonly what: string; readonly overrides: Replies }[] = [
  { what: "a different signed-in account", overrides: { user: [[{ ...owner, login: "Wrong" }]] } },
  { what: "repository ownership by another identity with the same spelling", overrides: { user: [[{ ...owner, id: 999 }]] } },
  { what: "a different base repo on a later page", overrides: { [list]: [[[pull], [{
    ...pull, number: 8, base: { ...pull.base, repo: { ...repo, id: 24 } },
  }]]] } },
  { what: "a different base repo on a deleted-author PR", overrides: { [list]: [[[pull, {
    ...pull, number: 8, user: null, base: { ...pull.base, repo: { ...repo, id: 24 } },
  }]]] } },
  { what: "a malformed creation timestamp", overrides: { [list]: [[[{ ...pull, created_at: "not-a-date" }]]] } },
  { what: "a duplicate PR across pages", overrides: { [list]: [[[pull], [pull]]] } },
  { what: "a repository replacement while scanning", overrides: { [root]: [[writableRepo], [{ ...writableRepo, id: 99 }]] } },
];
test.each(invalidDiscovery)("discovery refuses $what without returning a partial result", async ({ overrides }) => {
  expect(await (await fixture(overrides))("scan")).toMatchObject({ result: { error: "PrReadError" }, writes: 0 });
});

test("inspect establishes readiness but never reaches the fence or writes", async () => {
  expect(await (await fixture())("inspect")).toMatchObject({ result: { status: "ready" }, writes: 0, fenced: false, merged: false });
});

test("a single literal exclusion for a same-repo PR's own source allows the protected base merge", async () => {
  expect(await (await fixture({ [endpoint]: [[localPull]], [rule]: [[exactPolicy]] }))("merge")).toMatchObject({
    result: { status: "merged", sha: mergeSha }, fenced: true, writes: 1, merged: true,
  });
});

test.each([
  { what: "a default-only ruleset", pr: localPull, protection: {
    ...policy, conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
  } },
  { what: "a glob exclusion", pr: localPull, protection: headExcluded(["refs/heads/feature/*"]) },
  { what: "another feature branch exclusion", pr: localPull, protection: headExcluded(["refs/heads/feature/another"]) },
  { what: "an additional exclusion", pr: localPull, protection: headExcluded([`refs/heads/${feature}`, "refs/heads/another"]) },
  { what: "a fork with the same source ref name", pr: {
    ...localPull, head: { ...localPull.head, repo: { ...repo, id: 24 } },
  }, protection: exactPolicy },
  { what: "an unverified source repository", pr: {
    ...localPull, head: { ...localPull.head, repo: null },
  }, protection: exactPolicy },
])("does not reach the merge fence with $what", async ({ pr, protection }) => {
  expect(await (await fixture({ [endpoint]: [[pr]], [rule]: [[protection]] }))("merge")).toMatchObject({
    result: { status: "blocked" }, fenced: false, writes: 0, merged: false,
  });
});

test.each([
  { what: "source ref", change: { ...localPull.head, ref: "feature/another" } },
  { what: "source repository", change: { ...localPull.head, repo: { ...repo, id: 24 } } },
])("the literal exclusion never authorizes a write after the $what changes", async ({ change }) => {
  const attempt = await fixture({ [endpoint]: [[localPull], [{ ...localPull, head: change }]], [rule]: [[exactPolicy]] });
  expect(await attempt("merge")).toMatchObject({ result: { status: "blocked" }, fenced: false, writes: 0, merged: false });
});

test.each(["wrong-head-ref-receipt", "wrong-head-repository-receipt"] as const)(
  "the literal exclusion cannot confirm a merge without the same-repo source identity (%s)", async mode => {
    const attempt = await fixture({ [endpoint]: [[localPull]], [rule]: [[exactPolicy]] }, mode);
    expect(await attempt("merge")).toMatchObject({ result: { status: "unknown" }, fenced: true, writes: 1 });
  },
);

test.each([
  { ...reviewedIdentity, repositoryId: 555 },
  { ...reviewedIdentity, ownerId: 555 },
  { ...reviewedIdentity, baseRef: "other" },
  { ...reviewedIdentity, baseSha: otherHead },
])("a changed enrollment or reviewed base blocks mutation before the fence (%j)", async enrollment => {
  expect(await (await fixture())("merge", enrollment)).toMatchObject({
    result: { status: "blocked" }, writes: 0, fenced: false,
  });
});

test.each([
  { what: "wrong reviewed SHA", endpoint, response: [{ ...pull, head: { sha: otherHead } }] },
  { what: "the signed-in owner authored the PR", endpoint, response: [{ ...pull, user: { ...owner, login: "OldName" } }] },
  { what: "draft PR", endpoint, response: [{ ...pull, draft: true }] },
  { what: "unproven GitHub mergeability", endpoint, response: [{ ...pull, mergeable: null, mergeable_state: "unknown" }] },
  { what: "no contents write permission", endpoint: root, response: [{ ...writableRepo, permissions: { push: false } }] },
  { what: "no ordinary merge method", endpoint: root, response: [{ ...writableRepo, allow_merge_commit: false }] },
  { what: "no active ruleset", endpoint: rulesets, response: [[]] },
  { what: "admin bypass actor", endpoint: rule, response: [{ ...policy, bypass_actors: [{ actor_type: "OrganizationAdmin" }] }] },
  { what: "hidden bypass permissions", endpoint: rule, response: [{ ...policy, bypass_actors: undefined }] },
  { what: "not all branches are protected", endpoint: rule, response: [{ ...policy, conditions: {
    ref_name: { include: ["refs/heads/main"], exclude: [] },
  } }] },
  { what: "the CI source is not pinned", endpoint: rule, response: [{ ...policy, rules: [
    policy.rules[0], { type: "required_status_checks", parameters: { strict_required_status_checks_policy: true,
      required_status_checks: [{ context: "build" }] } },
  ] }] },
  { what: "the effective rule listing omits the all-branches CI gate", endpoint: branchRules,
    response: [[effectiveRules[0], inheritedCiRule]] },
  { what: "an unsupported effective workflow requirement", endpoint: branchRules,
    response: [[...effectiveRules, { ...inheritedCiRule, type: "workflows" }]] },
  { what: "separate classic branch status requirements", endpoint: branch, response: [{ ...protectedBranch, protection: {
    enabled: true, required_status_checks: { enforcement_level: "everyone", contexts: ["classic"] },
  } }] },
  { what: "stale approval on previous SHA", endpoint: reviews, response: [[{ ...approval, commit_id: otherHead }]] },
  { what: "the PR author approved", endpoint: reviews, response: [[{ ...approval, user: { id: author.id } }]] },
  { what: "a reviewer requested changes after approving", endpoint: reviews, response: [[approval, {
    ...approval, id: 31, state: "CHANGES_REQUESTED",
  }]] },
  { what: "no CI checks", endpoint: checks, response: checkPages() },
  { what: "a pending rerun", endpoint: checks, response: [{ total_count: 1, check_runs: [{
    ...run(), status: "in_progress", conclusion: null, completed_at: null,
  }] }] },
  { what: "a successful check from a different SHA", endpoint: checks, response: checkPages({ ...run(), head_sha: otherHead }) },
  { what: "an expired successful check", endpoint: checks, response: checkPages({
    ...run(), completed_at: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
  }) },
  { what: "a skipped required check", endpoint: checks, response: checkPages({ ...run(), conclusion: "skipped" }) },
  { what: "a skipped optional run", endpoint: checks, response: checkPages(run(), { ...securityRun(), conclusion: "skipped" }) },
  { what: "a neutral optional run", endpoint: checks, response: checkPages(run(), { ...securityRun(), conclusion: "neutral" }) },
  { what: "a context spoofed by another app", endpoint: checks, response: checkPages({ ...run(), app: { id: 99 } }) },
  { what: "an incomplete checks response", endpoint: checks, response: [{ total_count: 2, check_runs: [run()] }] },
  { what: "a pending commit status despite successful checks", endpoint: statuses, response: [{
    sha: head, state: "pending", total_count: 1, statuses: [{
      id: 71, context: "verify", state: "pending", target_url: null, created_at: created,
    }],
  }] },
])("never enters the write fence with $what", async ({ endpoint, response }) => {
  expect(await (await fixture({ [endpoint]: [response] }))("merge")).toMatchObject({
    result: { status: "blocked" }, writes: 0, fenced: false, merged: false,
  });
});

test.each([
  { what: "missing", runs: checkPages(run()) },
  { what: "stale", runs: checkPages(run(), {
    ...securityRun(), completed_at: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
  }) },
  { what: "skipped", runs: checkPages(run(), { ...securityRun(), conclusion: "skipped" }) },
])("never enters the write fence with a $what check required by another applicable ruleset", async ({ runs }) => {
  const merge = await fixture({ [branchRules]: [[effectiveRules, [inheritedCiRule]]], [checks]: [runs] });
  expect(await merge("merge")).toMatchObject({
    result: { status: "blocked" }, writes: 0, fenced: false, merged: false,
  });
});

test("both the parent and default-target rulesets contribute usable required checks", async () => {
  const defaultCi = { ...inheritedCiRule, ruleset_id: 14, ruleset_source: activeRuleset.source, ruleset_source_type: "Repository",
    parameters: { strict_required_status_checks_policy: true,
      required_status_checks: [{ context: "default-branch-check", integration_id: 21 }] } };
  const inspect = await fixture({
    [branchRules]: [[effectiveRules, [inheritedCiRule, defaultCi]]],
    [checks]: [checkPages(run(), securityRun(), { ...run(), id: 102, name: "default-branch-check", app: { id: 21 } })],
  });
  expect(await inspect("inspect")).toMatchObject({ result: { status: "ready" }, writes: 0, fenced: false, merged: false });
});

test.each([
  { what: "head", endpoint, before: [pull], after: [{ ...pull, head: { sha: otherHead } }] },
  { what: "immutable PR ID", endpoint, before: [pull], after: [{ ...pull, node_id: replacementNode }] },
  { what: "base branch", endpoint, before: [pull], after: [{ ...pull, base: { ...pull.base, ref: "other" } }] },
  { what: "default branch tip", endpoint, before: [pull], after: [{ ...pull, base: { ...pull.base, sha: otherHead } }] },
  { what: "ruleset", endpoint: rule, before: [policy], after: [{ ...policy, enforcement: "disabled" }] },
  { what: "effective CI rules", endpoint: branchRules, before: [effectiveRules], after: [[...effectiveRules, inheritedCiRule]] },
  { what: "current CI attempt", endpoint: checks, before: checkPages(run()), after: [{
    total_count: 1, check_runs: [{ ...run(), status: "in_progress", conclusion: null, completed_at: null }],
  }] },
  { what: "permission", endpoint: root, before: [writableRepo], after: [{
    ...writableRepo, permissions: { push: false },
  }] },
])("never enters the write fence if the $what changes during inspection", async ({ endpoint, before, after }) => {
  expect(await (await fixture({ [endpoint]: [before, after] }))("merge")).toMatchObject({
    result: { status: "blocked", reason: expect.stringContaining("changed") }, writes: 0, fenced: false,
  });
});

test("propagates the final fence refusal without submitting any write", async () => {
  expect(await (await fixture())("fenced")).toMatchObject({
    result: { error: "Error", message: "Stopped before write" }, writes: 0, merged: false,
  });
});

test.each(["accept", "slug-reassigned"] as const)("merges only the validated immutable PR node (%s)", async mode => {
  expect(await (await fixture({}, mode))("merge")).toEqual({
    result: { status: "merged", sha: mergeSha }, writes: 1, fenced: true, merged: true, replacementMerged: false,
  });
});

test.each(["deny", "retarget-head"] as const)("never retries a definitive GitHub refusal (%s)", async put => {
  expect(await (await fixture({}, put))("merge")).toMatchObject({
    result: { status: "blocked" }, writes: 1, fenced: true, merged: false,
  });
});

test("an ambiguous accepted mutation is not retried and only GET reconciliation confirms it", async () => {
  expect(await (await fixture({}, "lost-receipt"))("reconcile")).toMatchObject({
    result: { merge: { status: "unknown" }, observed: { status: "merged", sha: mergeSha } },
    writes: 1, fenced: true, merged: true,
  });
});

test("reconciliation does not credit a merged PR authored by the signed-in owner", async () => {
  const inspect = await fixture({ [endpoint]: [[{
    ...pull, state: "closed", merged: true, merge_commit_sha: mergeSha, user: { ...owner, login: "OldName" },
  }]] });
  expect(await inspect("inspect")).toMatchObject({ result: { status: "blocked" }, writes: 0 });
});

test.each([
  { what: "head", parents: [{ sha: baseSha }, { sha: otherHead }] },
  { what: "base", parents: [{ sha: otherHead }, { sha: head }] },
])("reconciliation does not credit a merge commit with a different reviewed $what parent", async ({ parents }) => {
  const inspect = await fixture({
    [endpoint]: [[{ ...pull, state: "closed", merged: true, merge_commit_sha: mergeSha }]],
    [commit]: [[{ sha: mergeSha, parents }]],
  });
  expect(await inspect("inspect")).toMatchObject({ result: { status: "blocked" }, writes: 0 });
});

test.each([
  "bad-receipt", "wrong-node-receipt", "wrong-head-receipt", "wrong-base-ref-receipt", "wrong-base-parent-receipt", "graphql-errors",
] as const)(
  "a success-looking GraphQL response does not confirm an ambiguous effect (%s)", async mode => {
    expect(await (await fixture({}, mode))("merge")).toMatchObject({
      result: { status: "unknown" }, writes: 1, fenced: true, merged: true, replacementMerged: false,
    });
  });
