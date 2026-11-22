import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { Type, type Static, type TSchema } from "@sinclair/typebox/type";
import {
  PrReadError, checkPageSchema, type ciOutcomeSchema, commentSchema, comparePageSchema, loginSchema, metadataSchema,
  pages, parseWire, reviewSchema, safeText, safeUrl, sha, statusSchema, timelineSchema,
} from "./pr-github-schema";

export type PrRef = { readonly owner: string; readonly repo: string; readonly number: number };
type CiPass = "passed" | "passed_with_skips";
type PrCi =
  | { readonly outcome: Exclude<Static<typeof ciOutcomeSchema>, CiPass> }
  | { readonly outcome: CiPass; readonly key: string; readonly skipped: number };
export type PrSnapshot = {
  readonly head: string;
  readonly state: "open" | "closed" | "merged";
  readonly mergedSha: string | null;
  readonly self: string;
  readonly feedback: readonly {
    readonly key: string; readonly actor: string | null; readonly kind: string; readonly url: string; readonly text: string;
  }[];
  readonly failures: readonly {
    readonly key: string; readonly name: string; readonly url: string; readonly conclusion: string;
  }[];
  readonly ci: PrCi;
  readonly headChange: "self" | "external" | "rewritten" | "unknown";
};

export function parsePrRef(value: string): PrRef {
  if (value.trim() !== value) throw new PrReadError("reference");
  const match = /^(?:([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9_.-]+)#([1-9][0-9]*)|https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*))$/.exec(value);
  if (!match) throw new PrReadError("reference");
  const owner = match[1] ?? match[4];
  const repo = match[2] ?? match[5];
  const number = Number(match[3] ?? match[6]);
  if (!owner || !repo || repo === "." || repo === ".." || repo.length > 100 || !Number.isSafeInteger(number))
    throw new PrReadError("reference");
  return { owner: owner.toLowerCase(), repo: repo.toLowerCase(), number };
}

export function prKey(ref: PrRef): string {
  const parsed = parsePrRef(`${ref.owner}/${ref.repo}#${ref.number}`);
  return `${parsed.owner}/${parsed.repo}#${parsed.number}`;
}

async function api<T extends TSchema>(endpoint: string, schema: T, signal: AbortSignal): Promise<Static<T>> {
  if (signal.aborted) throw new PrReadError("aborted");
  const output = await new Promise<string>((resolve, reject) => {
    execFile("gh", ["api", "--hostname", "github.com", "--method", "GET", "--paginate", "--slurp",
      "--header", "Accept: application/vnd.github+json", endpoint],
    { encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024, signal }, (error, stdout) => {
      if (error) reject(new PrReadError(signal.aborted ? "aborted" : "request"));
      else resolve(stdout);
    });
  });
  if (signal.aborted) throw new PrReadError("aborted");
  return parseWire(schema, output);
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
}

function unique<T extends { readonly key: string }>(rows: readonly T[]): T[] {
  return [...new Map(rows.map(row => [row.key, row])).values()]
    .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

async function readCheckRuns(root: string, head: string, signal: AbortSignal) {
  const checks = await api(`${root}/commits/${head}/check-runs?per_page=100&filter=latest`, pages(checkPageSchema), signal);
  const runs = checks.flatMap(page => page.check_runs);
  const checkCount = checks[0]?.total_count;
  if (checks.some(page => page.total_count !== checkCount) || runs.length !== checkCount
    || new Set(runs.map(run => run.id)).size !== checkCount
    || runs.some(run => run.head_sha !== head)) throw new PrReadError("response");
  return runs.sort((left, right) => left.id - right.id);
}

function checkAttempt(run: Static<typeof checkPageSchema>["check_runs"][number]): string {
  return `check:${run.id}:${fingerprint([run.started_at, run.completed_at, run.conclusion])}`;
}

export async function readPrSnapshot(
  ref: PrRef, options: { readonly previousHead?: string; readonly signal: AbortSignal },
): Promise<PrSnapshot> {
  const parsed = parsePrRef(prKey(ref));
  const root = `repos/${parsed.owner}/${parsed.repo}`;
  const endpoint = `${root}/pulls/${parsed.number}`;
  const { signal } = options;
  const metadataPages = await api(endpoint, pages(metadataSchema), signal);
  const start = metadataPages[0];
  if (!start || metadataPages.length !== 1 || (start.merged && (start.state !== "closed" || start.merge_commit_sha === null)))
    throw new PrReadError("response");
  const head = start.head.sha;
  const users = await api("user", pages(loginSchema), signal);
  if (users.length !== 1 || !users[0]) throw new PrReadError("response");
  const self = users[0].login.toLowerCase();
  const comments = (await api(`${root}/issues/${parsed.number}/comments?per_page=100`, pages(Type.Array(commentSchema)), signal)).flat();
  const reviewComments = (await api(`${endpoint}/comments?per_page=100`, pages(Type.Array(commentSchema)), signal)).flat();
  const reviews = (await api(`${endpoint}/reviews?per_page=100`, pages(Type.Array(reviewSchema)), signal)).flat();
  const timeline = (await api(`${root}/issues/${parsed.number}/timeline?per_page=100`, pages(Type.Array(timelineSchema)), signal)).flat();
  const runs = await readCheckRuns(root, head, signal);
  const statuses = (await api(`${root}/commits/${head}/statuses?per_page=100`, pages(Type.Array(statusSchema)), signal)).flat();

  const feedback: PrSnapshot["feedback"][number][] = [];
  for (const [kind, rows] of [["issue_comment", comments], ["review_comment", reviewComments]] as const) {
    for (const row of rows) {
      const content = { actor: row.user?.login.toLowerCase() ?? null, kind, url: safeUrl(row.html_url), text: safeText(row.body ?? "") };
      feedback.push({ ...content, key: `${kind}:${row.id}:${fingerprint([row.updated_at, row.body, content])}` });
    }
  }
  for (const row of reviews) {
    if (row.state === "PENDING") continue;
    const content = {
      actor: row.user?.login.toLowerCase() ?? null, kind: `review_${row.state.toLowerCase()}`,
      url: safeUrl(row.html_url), text: safeText(row.body ?? ""),
    };
    feedback.push({ ...content, key: `review:${row.id}:${fingerprint([row.state, row.submitted_at, row.body, content])}` });
  }
  for (const row of timeline) {
    if ("dismissed_review" in row) {
      const content = {
        actor: row.actor?.login.toLowerCase() ?? null, kind: "review_dismissed",
        url: `https://github.com/${parsed.owner}/${parsed.repo}/pull/${parsed.number}#pullrequestreview-${row.dismissed_review.review_id}`,
        text: safeText(row.dismissed_review.dismissal_message ?? ""),
      };
      feedback.push({ ...content, key: `dismissal:${row.id}:${fingerprint([row.created_at, row.dismissed_review.dismissal_message, content])}` });
    }
  }
  const failures: PrSnapshot["failures"][number][] = [];
  const successes: string[] = [];
  const skips: string[] = [];
  let ciPending = false;
  for (const run of runs) {
    const key = checkAttempt(run);
    if (run.status !== "completed" || run.conclusion === null) { ciPending = true; continue; }
    switch (run.conclusion) {
      case "success":
        if (run.completed_at) successes.push(key);
        else ciPending = true;
        break;
      case "neutral": case "skipped": skips.push(key); break;
      default:
        failures.push({ key, name: safeText(run.name, 256), url: safeUrl(run.html_url), conclusion: run.conclusion });
        break;
    }
  }
  // Status history includes old failures superseded by a pending/success rerun.
  const latestStatuses = new Map<string, Static<typeof statusSchema>>();
  for (const status of statuses) {
    const previous = latestStatuses.get(status.context);
    if (!previous || status.id > previous.id) latestStatuses.set(status.context, status);
  }
  for (const status of latestStatuses.values()) {
    const key = `status:${status.id}`;
    switch (status.state) {
      case "success": successes.push(key); break;
      case "pending": ciPending = true; break;
      case "error": case "failure":
        failures.push({ key, name: safeText(status.context, 256), url: safeUrl(status.target_url), conclusion: status.state });
        break;
    }
  }
  // This is observed commit CI, not GitHub's required-check or mergeability decision.
  const ci: PrCi = failures.length ? { outcome: "failed" }
    : ciPending ? { outcome: "pending" }
    : successes.length ? {
      outcome: skips.length ? "passed_with_skips" : "passed",
      key: `ci-pass:${head}:${fingerprint([successes.sort(), skips.sort()])}`,
      skipped: skips.length,
    }
    : { outcome: skips.length ? "skipped" : "missing" };

  if ("key" in ci) {
    // A rerun can change checks without moving the PR head. Bracket the
    // status sample with complete check-run reads before claiming a pass.
    const confirmed = await readCheckRuns(root, head, signal);
    if (confirmed.length !== runs.length || confirmed.some((run, index) => {
      const previous = runs[index];
      return !previous || previous.status !== run.status || checkAttempt(previous) !== checkAttempt(run);
    })) throw new PrReadError("ci-changed");
  }

  let headChange: PrSnapshot["headChange"] = "unknown";
  if (options.previousHead && options.previousHead !== head) {
    const previousHead = parseWire(sha, JSON.stringify(options.previousHead));
    try {
      const comparison = await api(`${root}/compare/${previousHead}...${head}?per_page=100`, pages(comparePageSchema), signal);
      const first = comparison[0];
      const commits = comparison.flatMap(page => page.commits);
      if (!first || comparison.some(page => page.total_commits !== first.total_commits
        || page.status !== first.status || page.base_commit.sha !== previousHead
        || page.merge_base_commit.sha !== first.merge_base_commit.sha)
        || new Set(commits.map(commit => commit.sha)).size !== first.total_commits
        || (first.status === "ahead" && (first.total_commits === 0 || commits.at(-1)?.sha !== head)))
        throw new PrReadError("response");
      if (first.status !== "ahead" || first.merge_base_commit.sha !== previousHead) headChange = "rewritten";
      else if (first.total_commits > 0 && commits.some(commit =>
        (commit.author !== null && commit.author.login.toLowerCase() !== self)
        || (commit.committer !== null && commit.committer.login.toLowerCase() !== self))) headChange = "external";
      else if (first.total_commits > 0 && commits.every(commit =>
        commit.author?.login.toLowerCase() === self && commit.committer?.login.toLowerCase() === self)) headChange = "self";
    } catch (error) {
      // An inaccessible old SHA cannot establish self-authored movement.
      if (!(error instanceof PrReadError) || error.reason !== "request") throw error;
    }
  }
  const finalPages = await api(endpoint, pages(metadataSchema), signal);
  const end = finalPages[0];
  if (!end || finalPages.length !== 1) throw new PrReadError("response");
  if (end.head.sha !== head || end.state !== start.state || end.merged !== start.merged
    || end.merge_commit_sha !== start.merge_commit_sha) throw new PrReadError("changed");
  return {
    head, state: start.merged ? "merged" : start.state, mergedSha: start.merged ? start.merge_commit_sha : null,
    self, feedback: unique(feedback), failures: unique(failures), ci, headChange,
  };
}
