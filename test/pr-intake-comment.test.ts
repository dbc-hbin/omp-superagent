import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const head = "a".repeat(40);
const base = "b".repeat(40);
const other = "c".repeat(40);
const pullId = "PR_kwDOBT_93r4A";
const reviewId = "PRR_kwDOBT_93r4A";
const owner = { login: "OWNER", databaseId: 42 };
const repository = {
  id: "R_kwDOBT_93r4A", databaseId: 123, nameWithOwner: "OWNER/Repo", owner, isArchived: false, isDisabled: false,
};
const pull = {
  id: pullId, number: 7, state: "OPEN", author: { databaseId: 43, login: "Contributor" },
  headRefOid: head, baseRefName: "main", baseRefOid: base, repository,
};
const identity = { ownerId: owner.databaseId, repositoryId: repository.databaseId, baseRef: "main", baseSha: base };
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

type Mode = "accept" | "lost" | "fake-author" | "wrong-review-id" | "wrong-parent" | "wrong-commit"
  | "wrong-body" | "not-commented" | "head-moved" | "duplicate-marker" | "edited-body" | "foreign-marker" | "paged";
type Action = "publish" | "inspect" | "reconcile" | "replay" | "fenced" | "different-summary";
type Setup = {
  readonly mode?: Mode;
  readonly viewer?: typeof owner;
  readonly target?: Partial<typeof pull>;
  readonly current?: Partial<typeof pull>;
};
type Outcome = {
  readonly result: unknown;
  readonly readback?: unknown;
  readonly fences: number;
  readonly submissions: number;
  readonly saved: readonly { readonly body: string; readonly state: string; readonly commit: { readonly oid: string } }[];
};

async function fixture(setup: Setup = {}) {
  const directory = await mkdtemp(join(tmpdir(), "superagent-pr-comment-"));
  directories.push(directory);
  const executable = join(directory, "gh");
  await writeFile(executable, `#!${process.execPath}
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const dir = ${JSON.stringify(directory)};
const setup = ${JSON.stringify(setup)};
const owner = ${JSON.stringify(owner)};
const pull = ${JSON.stringify(pull)};
const reviewId = ${JSON.stringify(reviewId)};
const other = ${JSON.stringify(other)};
const args = process.argv.slice(2);
const source = dir + "/reviews";
const posted = existsSync(source) ? JSON.parse(readFileSync(source, "utf8")) : [];
const result = data => process.stdout.write(JSON.stringify({ data }));
if (args.join(" ") === "auth token --hostname github.com") {
  process.stdout.write("local-fixture-token\\n");
  process.exit(0);
}
if (process.env.GH_TOKEN !== "local-fixture-token" || args[0] !== "api" || args.at(-1) !== "graphql"
  || args[args.indexOf("--hostname") + 1] !== "github.com") process.exit(91);
const { query, variables } = JSON.parse(readFileSync(0, "utf8"));
if (query.includes("query IntakeCommentTarget")) {
  if (variables.owner !== "owner" || variables.repo !== "repo" || variables.number !== pull.number) process.exit(92);
  result({ viewer: setup.viewer ?? owner, repository: { pullRequest: { ...pull, ...setup.target,
    ...(setup.mode === "head-moved" && posted.length ? { state: "CLOSED", headRefOid: other } : {}) } } });
} else if (query.includes("query IntakeCommentHistory")) {
  if (variables.pullId !== pull.id) process.exit(92);
  let reviews;
  if (setup.mode === "paged" && posted.length) {
    if (variables.cursor === null) reviews = {
      totalCount: 2, nodes: [{ ...posted[0], id: reviewId + "2", body: "Another review" }],
      pageInfo: { hasNextPage: true, endCursor: "second-page" },
    };
    else if (variables.cursor === "second-page")
      reviews = { totalCount: 2, nodes: posted, pageInfo: { hasNextPage: false, endCursor: null } };
    else process.exit(92);
  } else {
    if (variables.cursor !== null) process.exit(92);
    reviews = { totalCount: posted.length, nodes: posted, pageInfo: { hasNextPage: false, endCursor: null } };
  }
  result({ node: { ...pull, ...setup.current, ...(setup.mode === "head-moved" && posted.length ? { state: "CLOSED", headRefOid: other } : {}),
    reviews,
  } });
} else if (query.includes("mutation IntakeCommentSubmit")) {
  const ledger = dir + "/submit";
  writeFileSync(ledger, "mutation\\n", { flag: "a" });
  if (!existsSync(dir + "/fence")) process.exit(93);
  const { input } = variables;
  if (input.pullRequestId !== pull.id || input.commitOID !== pull.headRefOid || input.event !== "COMMENT"
    || !/^[a-f0-9]{64}$/.test(input.clientMutationId)) process.exit(94);
  const item = { id: reviewId, author: owner, submittedAt: "2026-11-18T01:00:00Z", state: "COMMENTED",
    commit: { oid: input.commitOID }, body: input.body };
  if (setup.mode === "edited-body")
    posted.push({ ...item, body: item.body + "\\nEdited." });
  else if (setup.mode === "foreign-marker")
    posted.push({ ...item, author: pull.author });
  else if (setup.mode === "duplicate-marker")
    posted.push(item, { ...item, id: reviewId + "2" });
  else posted.push(item);
  writeFileSync(source, JSON.stringify(posted));
  if (["lost", "edited-body", "foreign-marker", "duplicate-marker"].includes(setup.mode)) {
    console.error("private subprocess error");
    process.exit(1);
  }
  result({ addPullRequestReview: { clientMutationId: input.clientMutationId, pullRequestReview: { id: reviewId } } });
} else if (query.includes("query IntakeCommentReceipt")) {
  if (variables.reviewId !== reviewId || !posted.length) process.exit(94);
  const node = { ...posted[0], pullRequest: { ...pull } };
  switch (setup.mode) {
    case "fake-author": node.author = { ...owner, databaseId: 999 }; break;
    case "wrong-review-id": node.id = reviewId + "2"; break;
    case "wrong-parent": node.pullRequest.id += "2"; break;
    case "wrong-commit": node.commit = { oid: other }; break;
    case "wrong-body": node.body = "not the review"; break;
    case "not-commented": node.state = "APPROVED"; break;
    case "head-moved": node.pullRequest.headRefOid = other; break;
  }
  result({ node });
} else process.exit(95);
`);
  await chmod(executable, 0o700);
  const runner = join(directory, "run.ts");
  await writeFile(runner, `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { inspectIntakeComment, publishIntakeComment } from ${JSON.stringify(resolve(import.meta.dir, "../src/pr-intake-comment.ts"))};
const dir = ${JSON.stringify(directory)};
const [action, summary] = process.argv.slice(2);
const args = ["OWNER/Repo", 7, ${JSON.stringify(head)}, summary, new AbortController().signal] as const;
const identity = ${JSON.stringify(identity)};
let fences = 0;
const fence = () => {
  if (action === "fenced") throw new Error("controller refused");
  fences++;
  writeFileSync(dir + "/fence", "");
};
let result, readback;
try {
  result = action === "inspect" ? await inspectIntakeComment(...args, identity) : await publishIntakeComment(...args, fence, identity);
  if (action === "reconcile") readback = await inspectIntakeComment(...args, identity);
  if (action === "replay") readback = await publishIntakeComment(...args, fence, identity);
  if (action === "different-summary") {
    const [repo, number, head, prior, signal] = args;
    readback = await inspectIntakeComment(repo, number, head, prior + "different", signal, identity);
  }
} catch (error) {
  if (!(error instanceof Error)) throw error;
  result = { error: error.message };
}
const saved = existsSync(dir + "/reviews") ? JSON.parse(readFileSync(dir + "/reviews", "utf8")) : [];
const submissions = existsSync(dir + "/submit") ? readFileSync(dir + "/submit", "utf8").trim().split("\\n").length : 0;
console.log(JSON.stringify({ result, readback, fences, submissions, saved }));
`);
  return async (action: Action, summary = "Check error handling."): Promise<Outcome> => {
    const child = Bun.spawn([process.execPath, "--no-env-file", runner, action, summary], {
      env: { ...process.env, PATH: directory, GH_TOKEN: "", GITHUB_TOKEN: "" },
      stdin: "ignore", stdout: "pipe", stderr: "pipe", signal: AbortSignal.timeout(15_000),
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    return JSON.parse(stdout);
  };
}

test("publishes a bounded literal summary as COMMENT on the exact immutable PR head", async () => {
  const outcome = await (await fixture())("publish", "@team\n~~~\n/retest\n<details>\u202e" + "🎉".repeat(500));
  expect(outcome).toMatchObject({
    result: { status: "posted", id: reviewId }, submissions: 1, fences: 1,
    saved: [{ state: "COMMENTED", commit: { oid: head } }],
  });
  const body = outcome.saved[0].body;
  expect(Buffer.byteLength(body)).toBeLessThan(2048);
  expect(body).toMatch(/\n~~~text\n[^\n]*<details>[^\n]*\n~~~\n\n<!-- omp-superagent:intake-comment:v1:[a-f0-9]{64} -->$/);
  expect(body).not.toMatch(/@|\u202e|^\/retest/mu);
});

test.each([
  { what: "the authenticated user changes", setup: { viewer: { ...owner, databaseId: 999 } } },
  { what: "the repository was reassigned", setup: { target: { repository: { ...repository, databaseId: 999 } } } },
  { what: "the authenticated owner wrote the PR", setup: { target: { author: owner } } },
  { what: "the reviewed head changed", setup: { target: { headRefOid: other } } },
  { what: "the reviewed base moved", setup: { current: { baseRefOid: other } } },
  { what: "the PR was retargeted", setup: { current: { baseRefName: "dev" } } },
  { what: "the immutable PR node changed", setup: { current: { id: pullId + "2" } } },
])("blocks before the write fence when $what", async ({ setup }) => {
  expect(await (await fixture(setup))("publish")).toMatchObject({ result: { status: "blocked" }, fences: 0, submissions: 0, saved: [] });
});

test("propagates a caller's durable fence refusal without submitting", async () => {
  expect(await (await fixture())("fenced")).toMatchObject({
    result: { error: "controller refused" }, fences: 0, submissions: 0, saved: [],
  });
});

test.each(["accept", "paged"] as const)(
  "finds an already-published exact comment without running a second fence or mutation (%s)", async mode => {
    expect(await (await fixture({ mode }))("replay")).toMatchObject({
      result: { status: "posted", id: reviewId }, readback: { status: "posted", id: reviewId }, fences: 1, submissions: 1,
    });
  },
);

test("a missing response is reconciled from its exact comment instead of replayed", async () => {
  expect(await (await fixture({ mode: "lost" }))("reconcile")).toMatchObject({
    result: { status: "unknown" }, readback: { status: "posted", id: reviewId }, fences: 1, submissions: 1,
  });
});

test("a closed, updated PR can confirm only the historical commit-pinned comment without rewriting it", async () => {
  expect(await (await fixture({ mode: "head-moved" }))("reconcile")).toMatchObject({
    result: { status: "unknown" }, readback: { status: "posted", id: reviewId }, fences: 1, submissions: 1,
  });
});

test.each(["fake-author", "wrong-review-id", "wrong-parent", "wrong-commit", "wrong-body", "not-commented", "head-moved"] as const)(
  "a mutation receipt alone does not confirm the comment (%s)", async mode => {
    expect(await (await fixture({ mode }))("publish")).toMatchObject({ result: { status: "unknown" }, fences: 1, submissions: 1 });
  },
);

test.each(["edited-body", "foreign-marker", "duplicate-marker"] as const)(
  "an ambiguous created review cannot be confirmed by a marker alone (%s)", async mode => {
    expect(await (await fixture({ mode }))("reconcile")).toMatchObject({
      result: { status: "unknown" }, readback: { status: "unknown" }, fences: 1, submissions: 1,
    });
  },
);

test("the marker binds even the clipped portion of the exact verdict summary", async () => {
  expect(await (await fixture())("different-summary", "text ".repeat(100))).toMatchObject({
    result: { status: "posted", id: reviewId }, readback: { status: "unknown" }, submissions: 1,
  });
});
