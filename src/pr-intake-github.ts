import { execFile } from "node:child_process";
import { Type, type Static, type TSchema } from "@sinclair/typebox/type";
import { parsePrRef, readGitHubApi } from "./pr-github";
import { PrReadError, checkPageSchema, loginSchema, pages, parseWire, sha40 as sha, statusSchema } from "./pr-github-schema";

// allow: SIZE_OK — One wire adapter; preflight and the single mutation share the authenticated session.
const id = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const nodeId = Type.String({ pattern: "^[A-Za-z0-9_+/=-]{1,256}$" });
const utcTimestamp = Type.String({ pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{3})?Z$" });
const actor = Type.Object({ id, login: loginSchema.properties.login, type: Type.Literal("User") });
const repoIdentity = Type.Object({ id, full_name: Type.String(), owner: actor });
const repositorySchema = Type.Composite([repoIdentity, Type.Object({
  archived: Type.Boolean(), disabled: Type.Boolean(), allow_merge_commit: Type.Optional(Type.Boolean()),
  default_branch: Type.String({ minLength: 1 }), permissions: Type.Optional(Type.Object({ push: Type.Boolean() })),
})]);
const pullIdentity = Type.Object({
  number: id, head: Type.Object({ sha }),
  base: Type.Object({ repo: repoIdentity, ref: Type.String({ minLength: 1 }), sha }),
  user: Type.Union([Type.Object({
    id, login: Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9-]*(\\[bot\\])?$", maxLength: 100 }),
  }), Type.Null()]),
});
const pullSchema = Type.Composite([pullIdentity, Type.Object({
  state: Type.Union([Type.Literal("open"), Type.Literal("closed")]), created_at: utcTimestamp,
})]);
const sourceRepo = Type.Object({ id, full_name: Type.String(), owner: Type.Omit(actor, ["type"]) });
const detailSchema = Type.Composite([Type.Omit(pullSchema, ["head"]), Type.Object({
  head: Type.Object({
    sha, ref: Type.Optional(Type.String({ minLength: 1 })),
    repo: Type.Optional(Type.Union([sourceRepo, Type.Null()])),
  }),
  node_id: nodeId,
  merged: Type.Boolean(), merge_commit_sha: Type.Union([sha, Type.Null()]), draft: Type.Boolean(),
  mergeable: Type.Union([Type.Boolean(), Type.Null()]), mergeable_state: Type.String(),
})]);
const rulesetSummary = Type.Object({
  id, target: Type.Optional(Type.String()), source: Type.String(), source_type: Type.String(), enforcement: Type.String(),
});
const ruleSchema = Type.Object({ type: Type.String(), parameters: Type.Optional(Type.Unknown()) });
const rulesetSchema = Type.Composite([rulesetSummary, Type.Object({
  bypass_actors: Type.Optional(Type.Array(Type.Unknown())),
  conditions: Type.Optional(Type.Object({ ref_name: Type.Optional(Type.Object({
    include: Type.Array(Type.String()), exclude: Type.Array(Type.String()),
  }, { additionalProperties: false })) }, { additionalProperties: false })),
  rules: Type.Array(ruleSchema),
})]);
const effectiveRuleSchema = Type.Composite([ruleSchema, Type.Object({
  ruleset_id: id, ruleset_source: Type.String({ minLength: 1 }),
  ruleset_source_type: Type.Union([Type.Literal("Repository"), Type.Literal("Organization"), Type.Literal("Enterprise")]),
})]);
const branchSchema = Type.Object({
  name: Type.String(), commit: Type.Object({ sha }), protected: Type.Boolean(),
  protection: Type.Object({
    enabled: Type.Boolean(),
    required_status_checks: Type.Object({ enforcement_level: Type.String(), contexts: Type.Array(Type.String()) }),
  }),
});
const reviewRule = Type.Object({
  required_approving_review_count: Type.Integer({ minimum: 1, maximum: 10 }),
  dismiss_stale_reviews_on_push: Type.Literal(true), require_last_push_approval: Type.Literal(true),
  allowed_merge_methods: Type.Optional(Type.Array(Type.String())),
});
const statusRule = Type.Object({
  strict_required_status_checks_policy: Type.Boolean(),
  required_status_checks: Type.Array(Type.Object({ context: Type.String({ minLength: 1 }), integration_id: id }), { minItems: 1 }),
});
const reviewSchema = Type.Object({
  id, user: Type.Union([Type.Object({ id }), Type.Null()]), submitted_at: Type.Union([Type.String(), Type.Null()]),
  commit_id: Type.Union([sha, Type.Null()]), state: Type.Union(
    (["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"] as const).map(value => Type.Literal(value))),
});
const checksSchema = Type.Object({
  total_count: checkPageSchema.properties.total_count,
  check_runs: Type.Array(Type.Intersect([checkPageSchema.properties.check_runs.items, Type.Object({
    app: Type.Union([Type.Object({ id }), Type.Null()]),
  })])),
});
const statusesSchema = Type.Object({
  sha, state: statusSchema.properties.state, total_count: Type.Integer({ minimum: 0 }),
  statuses: Type.Array(statusSchema),
});
const receiptSchema = Type.Object({
  errors: Type.Optional(Type.Array(Type.Unknown(), { maxItems: 0 })),
  data: Type.Object({ mergePullRequest: Type.Object({ pullRequest: Type.Object({
    id: nodeId, headRefOid: sha, baseRefName: Type.String(), merged: Type.Literal(true), state: Type.Literal("MERGED"),
    headRefName: Type.Optional(Type.String()),
    headRepository: Type.Optional(Type.Union([Type.Object({ databaseId: id }), Type.Null()])),
    mergeCommit: Type.Object({ oid: sha, parents: Type.Object({
      totalCount: Type.Literal(2), nodes: Type.Array(Type.Object({ oid: sha }), { minItems: 2, maxItems: 2 }),
    }) }),
  }) }) }),
});
const commitSchema = Type.Object({ sha, parents: Type.Array(Type.Object({ sha })) });
const mergeMutation = `mutation MergeIntakePull($input: MergePullRequestInput!) {
  mergePullRequest(input: $input) {
    pullRequest {
      id headRefOid headRefName headRepository { databaseId } baseRefName merged state
      mergeCommit { oid parents(first: 2) { totalCount nodes { oid } } }
    }
  }
}`;

export type IntakeRepositoryIdentity = { readonly repositoryId: number; readonly ownerId: number };
type ReviewedBase = { readonly baseRef: string; readonly baseSha: string };
export type IntakeMergeIdentity = IntakeRepositoryIdentity & ReviewedBase;
export type IntakePull = {
  readonly number: number; readonly head: string; readonly author: string; readonly createdAt: number;
};
type Blocked = { readonly status: "blocked"; readonly reason: string };
type Merged = { readonly status: "merged"; readonly sha: string };
type MergeTarget = { readonly status: "ready"; readonly nodeId: string; readonly excludedHead: string | null };
export type IntakeMergeStatus = Blocked | Merged | { readonly status: "ready" };
export type IntakeMergeResult = Blocked | Merged | { readonly status: "unknown"; readonly reason: string };

type Session = {
  readonly repository: string; readonly root: string; readonly owner: string;
  readonly env: NodeJS.ProcessEnv;
  readonly get: <T extends TSchema>(endpoint: string, schema: T) => Promise<Static<T>>;
};
type IntakeTarget = {
  readonly number: number; readonly head: string; readonly identity: IntakeRepositoryIdentity;
  readonly base?: ReviewedBase;
};
type WireRepo = Static<typeof repositorySchema>;
type Pull = Static<typeof detailSchema>;
type RequiredCheck = { readonly context: string; readonly app: number };
type GatePolicy = {
  readonly rulesetId: number; readonly approvals: number; readonly required: readonly RequiredCheck[];
  readonly excludedHead: string | null;
};
const blocked = (reason: string): Blocked => ({ status: "blocked", reason });

async function openSession(repository: string, signal: AbortSignal): Promise<Session> {
  const { owner, repo } = parsePrRef(`${repository}#1`);
  if (signal.aborted) throw new PrReadError("aborted");
  const env = { ...process.env, GH_PROMPT_DISABLED: "1", GH_PAGER: "cat", GH_DEBUG: "" };
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || await new Promise<string>((resolve, reject) => {
    execFile("gh", ["auth", "token", "--hostname", "github.com"],
      { env, signal, encoding: "utf8", timeout: 30_000, maxBuffer: 4096 }, (error, stdout) => {
        if (error) reject(new PrReadError(signal.aborted ? "aborted" : "request"));
        else resolve(stdout.trimEnd());
      });
  });
  if (!/^[\x21-\x7e]+$/.test(token)) throw new PrReadError("response");
  const pinned = { ...env, GH_TOKEN: token };
  return {
    repository: `${owner}/${repo}`, owner, root: `repos/${owner}/${repo}`, env: pinned,
    get: (endpoint, schema) => readGitHubApi(endpoint, schema, signal, pinned),
  };
}

export { openSession as openIntakeGitHubSession };

export function queryIntakeGitHub<T extends TSchema>(
  session: Session, signal: AbortSignal, request: { readonly query: string; readonly variables: object; readonly schema: T },
): Promise<Static<T>> {
  if (signal.aborted) return Promise.reject(new PrReadError("aborted"));
  return new Promise<string>((resolve, reject) => {
    const child = execFile("gh", ["api", "--hostname", "github.com", "--method", "POST",
      "--header", "Accept: application/vnd.github+json", "--header", "Content-Type: application/json",
      "--input", "-", "graphql"],
    { env: session.env, signal, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error || signal.aborted) reject(new PrReadError(signal.aborted ? "aborted" : "request"));
      else resolve(stdout);
    });
    child.stdin?.once("error", () => reject(new PrReadError("request")));
    child.stdin?.end(JSON.stringify({ query: request.query, variables: request.variables }));
  }).then(text => parseWire(request.schema, text));
}

async function one<T extends TSchema>(session: Session, endpoint: string, schema: T): Promise<Static<T>> {
  const result = await session.get(endpoint, Type.Array(schema, { minItems: 1, maxItems: 1 }));
  return result[0];
}

async function readOwnedRepo(session: Session): Promise<WireRepo> {
  const self = await one(session, "user", actor);
  if (self.login.toLowerCase() !== session.owner) throw new PrReadError("reference");
  const repo = await one(session, session.root, repositorySchema);
  if (repo.full_name.toLowerCase() !== session.repository || repo.owner.login.toLowerCase() !== session.owner
    || repo.owner.id !== self.id) throw new PrReadError("response");
  return repo;
}

function sameRepo(repo: Static<typeof sourceRepo>, expected: WireRepo): boolean {
  return repo.id === expected.id && repo.full_name.toLowerCase() === expected.full_name.toLowerCase()
    && repo.owner.id === expected.owner.id && repo.owner.login.toLowerCase() === expected.owner.login.toLowerCase();
}

function ownedAuthor(user: NonNullable<Pull["user"]>, repo: WireRepo): boolean {
  return user.id === repo.owner.id || user.login.toLowerCase() === repo.owner.login.toLowerCase();
}

export async function readIntakePulls(repository: string, signal: AbortSignal): Promise<IntakeRepositoryIdentity & {
  readonly self: string; readonly pulls: readonly IntakePull[];
}> {
  const session = await openSession(repository, signal);
  const repo = await readOwnedRepo(session);
  const rows = (await session.get(`${session.root}/pulls?state=open&per_page=100`, pages(Type.Array(pullSchema)))).flat();
  const numbers = new Set<number>();
  const pulls: IntakePull[] = [];
  for (const row of rows) {
    const createdAt = Date.parse(row.created_at);
    const timestamp = row.created_at.includes(".") ? row.created_at : row.created_at.replace(/Z$/, ".000Z");
    if (row.state !== "open" || !sameRepo(row.base.repo, repo) || numbers.has(row.number)
      || !Number.isFinite(createdAt) || new Date(createdAt).toISOString() !== timestamp)
      throw new PrReadError("response");
    numbers.add(row.number);
    if (row.user && !ownedAuthor(row.user, repo))
      pulls.push({ number: row.number, head: row.head.sha, author: row.user.login.toLowerCase(), createdAt });
  }
  if (!sameRepo(await readOwnedRepo(session), repo)) throw new PrReadError("changed");
  return { repositoryId: repo.id, ownerId: repo.owner.id, self: session.owner, pulls };
}

const applicableRuleset = (row: Static<typeof rulesetSummary>, session: Session): boolean =>
  row.target === "branch" && row.enforcement === "active" && row.source_type === "Repository"
  && row.source.toLowerCase() === session.repository;

function requiredChecks(ci: Static<typeof statusRule>): RequiredCheck[] {
  return ci.required_status_checks.map(check => ({ context: check.context, app: check.integration_id }))
    .sort((a, b) => a.context.localeCompare(b.context) || a.app - b.app);
}

async function readPolicy(session: Session, rulesetId: number, sourceRef: string | null): Promise<GatePolicy | null> {
  const policy = await one(session, `${session.root}/rulesets/${rulesetId}`, rulesetSchema);
  const refs = policy.conditions?.ref_name;
  // mergePullRequest compares the head OID, not the base ref/OID. A base-scoped
  // rule leaves a retarget race to an unprotected branch. The only safe exclusion
  // is the same-repo PR's immutable source ref: it cannot merge into itself.
  if (policy.id !== rulesetId || !applicableRuleset(policy, session) || policy.bypass_actors?.length !== 0
    || refs?.include.length !== 1 || refs.include[0] !== "~ALL") return null;
  const excludedHead = refs.exclude.length === 1 && sourceRef && refs.exclude[0] === `refs/heads/${sourceRef}` ? sourceRef : null;
  if (refs.exclude.length !== 0 && excludedHead === null) return null;
  const reviews = policy.rules.filter(rule => rule.type === "pull_request");
  const statuses = policy.rules.filter(rule => rule.type === "required_status_checks");
  if (reviews.length !== 1 || statuses.length !== 1) return null;
  const review = parseWire(reviewRule, JSON.stringify(reviews[0].parameters ?? null));
  const ci = parseWire(statusRule, JSON.stringify(statuses[0].parameters ?? null));
  if (!ci.strict_required_status_checks_policy || (review.allowed_merge_methods && !review.allowed_merge_methods.includes("merge")))
    return null;
  const required = requiredChecks(ci);
  if (new Set(required.map(check => check.context)).size !== required.length) return null;
  return { rulesetId, approvals: review.required_approving_review_count, required, excludedHead };
}

const nonCiRules = new Set([
  "creation", "update", "deletion", "required_linear_history", "required_signatures", "pull_request",
  "non_fast_forward", "commit_message_pattern", "commit_author_email_pattern", "committer_email_pattern", "branch_name_pattern",
]);

async function readEffectiveChecks(session: Session, base: Pull["base"], gate: GatePolicy): Promise<RequiredCheck[] | null> {
  const branchName = encodeURIComponent(base.ref);
  const branch = await one(session, `${session.root}/branches/${branchName}`, branchSchema);
  const classic = branch.protection.required_status_checks;
  // The effective rules endpoint returns rulesets, not independent classic status-check requirements.
  if (branch.name !== base.ref || branch.commit.sha !== base.sha || !branch.protected
    || classic.enforcement_level !== "off" || classic.contexts.length !== 0) return null;
  const effective = (await session.get(`${session.root}/rules/branches/${branchName}?per_page=100`, pages(Type.Array(effectiveRuleSchema)))).flat();
  const statusRules = new Set<number>();
  const required = new Map<string, RequiredCheck>();
  let gateReview: boolean | null = null;
  let gateCi = false;
  for (const rule of effective) {
    const isGate = rule.ruleset_id === gate.rulesetId;
    if (isGate && (rule.ruleset_source_type !== "Repository" || rule.ruleset_source.toLowerCase() !== session.repository))
      return null;
    if (rule.type === "required_status_checks") {
      if (statusRules.has(rule.ruleset_id)) return null;
      statusRules.add(rule.ruleset_id);
      const ci = parseWire(statusRule, JSON.stringify(rule.parameters ?? null));
      const checks = requiredChecks(ci);
      if (isGate) gateCi = ci.strict_required_status_checks_policy && JSON.stringify(checks) === JSON.stringify(gate.required);
      for (const check of checks) required.set(JSON.stringify([check.context, check.app]), check);
    } else if (!nonCiRules.has(rule.type)) return null;
    else if (isGate && rule.type === "pull_request") {
      if (gateReview !== null) return null;
      const review = parseWire(reviewRule, JSON.stringify(rule.parameters ?? null));
      gateReview = review.required_approving_review_count === gate.approvals
        && (!review.allowed_merge_methods || review.allowed_merge_methods.includes("merge"));
    }
  }
  if (!gateReview || !gateCi) return null;
  return [...required.values()].sort((a, b) => a.context.localeCompare(b.context) || a.app - b.app);
}

async function hasReviews(session: Session, item: { readonly endpoint: string; readonly pull: Pull }, count: number) {
  const { endpoint, pull } = item;
  const reviews = (await session.get(`${endpoint}/reviews?per_page=100`, pages(Type.Array(reviewSchema)))).flat();
  if (new Set(reviews.map(review => review.id)).size !== reviews.length) throw new PrReadError("response");
  const latest = new Map<number, { review: (typeof reviews)[number]; at: number }>();
  for (const review of reviews) {
    if (review.state === "PENDING" || review.state === "COMMENTED") continue;
    if (!review.user || !review.submitted_at) return false;
    const at = Date.parse(review.submitted_at);
    if (!Number.isFinite(at)) return false;
    const previous = latest.get(review.user.id);
    // REST lists reviews in chronological order; a later dismissal must never count as an approval.
    if (previous && at < previous.at) return false;
    latest.set(review.user.id, { review, at });
  }
  const votes = [...latest.values()].map(vote => vote.review);
  return !votes.some(review => review.state === "CHANGES_REQUESTED")
    && votes.filter(review => review.state === "APPROVED" && review.commit_id === pull.head.sha
      && review.user?.id !== pull.user?.id).length >= count;
}

async function hasCurrentCi(session: Session, head: string, required: readonly RequiredCheck[]): Promise<boolean> {
  const commit = `${session.root}/commits/${head}`;
  const checks = await session.get(`${commit}/check-runs?per_page=100&filter=latest`, pages(checksSchema));
  const statuses = await session.get(`${commit}/status?per_page=100`, pages(statusesSchema));
  const runs = checks.flatMap(page => page.check_runs);
  const contexts = statuses.flatMap(page => page.statuses);
  if (checks.some(page => page.total_count !== runs.length)
    || new Set(runs.map(run => run.id)).size !== runs.length || runs.some(run => run.head_sha !== head)
    || statuses.some(page => page.sha !== head || page.total_count !== contexts.length
      || (contexts.length > 0 && page.state !== "success"))
    || new Set(contexts.map(status => status.context)).size !== contexts.length
    || contexts.some(status => status.state !== "success")) return false;
  if (runs.some(run => run.status !== "completed" || run.conclusion !== "success")) return false;
  const now = Date.now();
  return required.every(check => {
    const matches = runs.filter(run => run.name === check.context && run.app?.id === check.app);
    const run = matches[0];
    if (matches.length !== 1 || run?.conclusion !== "success" || run.completed_at === null) return false;
    const finished = Date.parse(run.completed_at);
    return finished <= now && now - finished <= 7 * 24 * 60 * 60 * 1000;
  });
}

function readyPull(pull: Pull, repo: WireRepo): boolean {
  return pull.state === "open" && !pull.merged && !pull.draft && !!pull.user && !ownedAuthor(pull.user, repo)
    && pull.base.ref === repo.default_branch
    && pull.mergeable === true && pull.mergeable_state === "clean";
}

function allowsMerge(repo: WireRepo): boolean {
  return !repo.archived && !repo.disabled && repo.permissions?.push === true && repo.allow_merge_commit === true;
}

function literalSameRepoHead(pull: Pull, repo: WireRepo): string | null {
  const { ref, repo: headRepo } = pull.head;
  // No fnmatch syntax, escaping, special tokens, or a fork's like-named branch.
  return ref && headRepo && ref !== pull.base.ref && /^[A-Za-z0-9][A-Za-z0-9/_.-]{0,149}$/.test(ref)
    && sameRepo(headRepo, repo) ? ref : null;
}

async function preflight(session: Session, ref: IntakeTarget): Promise<MergeTarget | Blocked | Merged> {
  const endpoint = `${session.root}/pulls/${ref.number}`;
  const repo = await readOwnedRepo(session);
  if (repo.id !== ref.identity.repositoryId || repo.owner.id !== ref.identity.ownerId)
    return blocked("GitHub repository or owner does not match enrollment.");
  const start = await one(session, endpoint, detailSchema);
  if (start.number !== ref.number || !sameRepo(start.base.repo, repo) || start.head.sha !== ref.head)
    return blocked("GitHub PR identity or reviewed head does not match.");
  if (!start.user || ownedAuthor(start.user, repo)) return blocked("GitHub does not establish independent PR authorship.");
  if (start.merged && start.state === "closed" && start.merge_commit_sha) {
    if (start.base.ref !== (ref.base?.baseRef ?? repo.default_branch))
      return blocked("GitHub merged PR does not match the expected base branch.");
    const commit = await one(session, `${session.root}/git/commits/${start.merge_commit_sha}`, commitSchema);
    return commit.sha === start.merge_commit_sha && commit.parents.length === 2 && commit.parents[1]?.sha === ref.head
      && (!ref.base || commit.parents[0]?.sha === ref.base.baseSha)
      ? { status: "merged", sha: commit.sha }
      : blocked("GitHub does not establish an ordinary merge commit for the reviewed target.");
  }
  if (!readyPull(start, repo)) return blocked("GitHub does not report a clean, open PR targeting the default branch.");
  if (ref.base && (start.base.ref !== ref.base.baseRef || start.base.sha !== ref.base.baseSha))
    return blocked("GitHub base branch or tip does not match the reviewed base.");
  if (!allowsMerge(repo)) return blocked("Repository does not establish permission for an ordinary merge commit.");

  const candidates = (await session.get(`${session.root}/rulesets?per_page=100`, pages(Type.Array(rulesetSummary)))).flat()
    .filter(row => applicableRuleset(row, session));
  if (new Set(candidates.map(row => row.id)).size !== candidates.length) throw new PrReadError("response");
  // A wildcard classic branch reading or a boolean `protected` flag cannot prove the retargeted branch is protected.
  let policy: GatePolicy | null = null;
  const sourceRef = literalSameRepoHead(start, repo);
  for (const candidate of candidates) {
    policy = await readPolicy(session, candidate.id, sourceRef);
    if (policy) break;
  }
  if (!policy) return blocked("No non-bypassable review and CI ruleset protects every possible merge destination. "
    + "GitHub's merge API cannot pin the base; only the exact same-repository source branch may be excluded.");
  const required = await readEffectiveChecks(session, start.base, policy);
  if (!required) return blocked("Complete effective GitHub CI rules could not be established.");
  if (!await hasReviews(session, { endpoint, pull: start }, policy.approvals))
    return blocked("Required independent reviews are not established for the reviewed head.");
  if (!await hasCurrentCi(session, ref.head, required))
    return blocked("Complete, current, successful CI from the required sources is not established for the reviewed head.");
  const confirmedPolicy = await readPolicy(session, policy.rulesetId, sourceRef);
  if (JSON.stringify(confirmedPolicy) !== JSON.stringify(policy)) return blocked("GitHub protection changed during preflight.");
  const confirmedRequired = await readEffectiveChecks(session, start.base, policy);
  if (JSON.stringify(confirmedRequired) !== JSON.stringify(required)) return blocked("GitHub effective CI rules changed during preflight.");
  if (!await hasCurrentCi(session, ref.head, required)) return blocked("GitHub CI changed during preflight.");
  const confirmedRepo = await one(session, session.root, repositorySchema);
  if (!sameRepo(confirmedRepo, repo) || confirmedRepo.default_branch !== repo.default_branch || !allowsMerge(confirmedRepo))
    return blocked("GitHub repository identity or merge permission changed during preflight.");
  const end = await one(session, endpoint, detailSchema);
  if (end.number !== ref.number || !sameRepo(end.base.repo, repo) || end.head.sha !== ref.head
    || end.node_id !== start.node_id || end.user?.id !== start.user?.id
    || end.base.ref !== start.base.ref || end.base.sha !== start.base.sha
    || (policy.excludedHead !== null && literalSameRepoHead(end, repo) !== policy.excludedHead)
    || !readyPull(end, repo)) return blocked("GitHub PR changed during preflight.");
  return { status: "ready", nodeId: end.node_id, excludedHead: policy.excludedHead };
}

async function prepare(repository: string, ref: IntakeTarget, signal: AbortSignal): Promise<
  (MergeTarget & { readonly session: Session }) | Blocked | Merged
> {
  try {
    parsePrRef(`${repository}#${ref.number}`);
    parseWire(sha, JSON.stringify(ref.head));
    if (ref.base) parseWire(sha, JSON.stringify(ref.base.baseSha));
    const session = await openSession(repository, signal);
    const status = await preflight(session, ref);
    return status.status === "ready" ? { ...status, session } : status;
  } catch (error) {
    if (!(error instanceof PrReadError)) throw error;
    return blocked(error.reason === "aborted" ? "GitHub preflight was cancelled."
      : "GitHub repository ownership or merge preflight evidence could not be established.");
  }
}

/** Also reconciles an ambiguous write: only an observed merge of this exact head is a receipt. */
export async function inspectIntakeMerge(
  repository: string, number: number, head: string, signal: AbortSignal,
  identity: IntakeRepositoryIdentity | IntakeMergeIdentity,
): Promise<IntakeMergeStatus> {
  const status = await prepare(repository, { number, head, identity, ...("baseRef" in identity ? { base: identity } : {}) }, signal);
  return status.status === "ready" ? { status: "ready" } : status;
}

/** An ordinary, SHA-conditional merge; callers must fence once and never resubmit an unknown outcome. */
export async function mergeIntakePull(
  repository: string, number: number, head: string, signal: AbortSignal, beforeWrite: () => void, identity: IntakeMergeIdentity,
): Promise<IntakeMergeResult> {
  const base = { baseRef: identity.baseRef, baseSha: identity.baseSha };
  const result = await prepare(repository, { number, head, identity, base }, signal);
  if (result.status !== "ready") return result;
  if (signal.aborted) return blocked("GitHub merge was cancelled before writing.");
  const { env } = result.session;
  const body = JSON.stringify({
    query: mergeMutation,
    variables: { input: { pullRequestId: result.nodeId, expectedHeadOid: head, mergeMethod: "MERGE" } },
  });
  beforeWrite();
  // The immutable PR node cannot be replaced by reassigning the slug. GitHub compares the head
  // and enforces current rules, but the API cannot compare-and-set those rules or the base ref.
  const response = await new Promise<{ readonly failed: boolean; readonly stdout: string }>(resolve => {
    let inputFailed = false;
    const child = execFile("gh", ["api", "--hostname", "github.com", "--method", "POST", "--include",
      "--header", "Accept: application/vnd.github+json", "--header", "Content-Type: application/json",
      "--input", "-", "graphql"],
    { env, signal, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 },
    (error, stdout) => resolve({ failed: error !== null || inputFailed, stdout }));
    child.stdin?.once("error", () => { inputFailed = true; });
    child.stdin?.end(body);
  });
  const status = /^HTTP\/[0-9.]+ ([0-9]{3})[^\r\n]*\r?\n/.exec(response.stdout)?.[1];
  if (!signal.aborted && response.failed && status && ["401", "403", "404", "405", "409", "422"].includes(status))
    return blocked("GitHub refused the conditional merge.");
  if (!signal.aborted && !response.failed && status === "200") {
    const separator = /\r?\n\r?\n/.exec(response.stdout);
    if (separator) {
      try {
        const receipt = parseWire(receiptSchema, response.stdout.slice(separator.index + separator[0].length));
        const pull = receipt.data.mergePullRequest.pullRequest;
        const parents = pull.mergeCommit.parents.nodes;
        if (pull.id === result.nodeId && pull.headRefOid === head && pull.baseRefName === base.baseRef
          && (result.excludedHead === null
            || (pull.headRefName === result.excludedHead && pull.headRepository?.databaseId === identity.repositoryId))
          && parents[0]?.oid === base.baseSha && parents[1]?.oid === head)
          return { status: "merged", sha: pull.mergeCommit.oid };
      } catch (error) {
        if (!(error instanceof PrReadError)) throw error;
      }
    }
  }
  return { status: "unknown", reason: "GitHub merge outcome is unconfirmed; reconcile without resubmitting." };
}
