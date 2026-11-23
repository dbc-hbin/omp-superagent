import { createHash } from "node:crypto";
import { Type, type Static, type TSchema } from "@sinclair/typebox/type";
import { parsePrRef } from "./pr-github";
import { loginSchema, parseWire, PrReadError } from "./pr-github-schema";
import { openIntakeGitHubSession, queryIntakeGitHub, type IntakeMergeIdentity } from "./pr-intake-github";
import { intakeEvidenceDeadlineMs } from "./pr-intake-material";

const id = Type.String({ pattern: "^[A-Za-z0-9_+/=-]{1,256}$" });
const sha = Type.String({ pattern: "^[0-9a-f]{40}$" });
const databaseId = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const user = Type.Object({ login: loginSchema.properties.login, databaseId });
const actor = Type.Object({ login: Type.String(), databaseId: Type.Optional(Type.Union([databaseId, Type.Null()])) });
const actorFields = "login ... on User { databaseId }";
const pull = Type.Object({
  id, number: databaseId, state: Type.Union([Type.Literal("OPEN"), Type.Literal("CLOSED"), Type.Literal("MERGED")]), author: actor, headRefOid: sha,
  baseRefOid: sha, baseRefName: Type.String(),
  repository: Type.Object({
    id, databaseId, nameWithOwner: Type.String(), owner: user,
    isArchived: Type.Literal(false), isDisabled: Type.Literal(false),
  }),
});
const pullFields = `
  id number state author { ${actorFields} } headRefOid baseRefOid baseRefName
  repository { id databaseId nameWithOwner owner { ${actorFields} } isArchived isDisabled }
`;
const review = Type.Object({
  id, body: Type.String(), state: Type.String(), submittedAt: Type.Union([Type.String(), Type.Null()]),
  commit: Type.Union([Type.Object({ oid: sha }), Type.Null()]),
  author: Type.Union([actor, Type.Null()]),
});
const reviewFields = `id body state submittedAt commit { oid } author { ${actorFields} }`;
const graph = <T extends TSchema>(data: T) => Type.Object({
  data, errors: Type.Optional(Type.Array(Type.Unknown(), { maxItems: 0 })),
});
const targetSchema = graph(Type.Object({ viewer: user, repository: Type.Object({ pullRequest: pull }) }));
const targetQuery = `query IntakeCommentTarget($owner: String!, $repo: String!, $number: Int!) {
  viewer { login databaseId }
  repository(owner: $owner, name: $repo) { pullRequest(number: $number) { ${pullFields} } }
}`;
const pageSchema = graph(Type.Object({
  node: Type.Intersect([pull, Type.Object({
    reviews: Type.Object({
      totalCount: Type.Integer({ minimum: 0 }),
      nodes: Type.Array(review, { maxItems: 30 }),
      pageInfo: Type.Object({
        hasNextPage: Type.Boolean(), endCursor: Type.Union([Type.String({ minLength: 1, maxLength: 4096 }), Type.Null()]),
      }),
    }),
  })]),
}));
const pageQuery = `query IntakeCommentHistory($pullId: ID!, $cursor: String) {
  node(id: $pullId) {
    ... on PullRequest {
      ${pullFields}
      reviews(first: 30, after: $cursor) {
        totalCount nodes { ${reviewFields} } pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;
const submitSchema = graph(Type.Object({ addPullRequestReview: Type.Object({
  clientMutationId: Type.String(), pullRequestReview: Type.Object({ id }),
}) }));
const submitMutation = `mutation IntakeCommentSubmit($input: AddPullRequestReviewInput!) {
  addPullRequestReview(input: $input) { clientMutationId pullRequestReview { id } }
}`;
const reviewSchema = graph(Type.Object({ node: Type.Intersect([review, Type.Object({ pullRequest: pull })]) }));
const reviewQuery = `query IntakeCommentReceipt($reviewId: ID!) {
  node(id: $reviewId) {
    ... on PullRequestReview { ${reviewFields} pullRequest { ${pullFields} } }
  }
}`;

type Request = IntakeMergeIdentity & { readonly number: number; readonly head: string; readonly summary: string };
type Target = {
  readonly session: Awaited<ReturnType<typeof openIntakeGitHubSession>>;
  readonly request: Request;
  readonly pullId: string;
  readonly repoId: string;
  readonly digest: string;
  readonly marker: string;
  readonly body: string;
  readonly historical: boolean;
};
export type IntakeCommentResult =
  | { readonly status: "posted"; readonly id: string }
  | { readonly status: "blocked" | "unknown"; readonly reason: string };

function matchesPull(row: Static<typeof pull>, session: Target["session"], request: Request, historical = false): boolean {
  return row.number === request.number && (historical || row.state === "OPEN" && row.headRefOid === request.head
    && row.baseRefName === request.baseRef && row.baseRefOid === request.baseSha)
    && row.repository.databaseId === request.repositoryId && row.repository.nameWithOwner.toLowerCase() === session.repository
    && row.repository.owner.databaseId === request.ownerId && row.repository.owner.login.toLowerCase() === session.owner
    && row.author.databaseId !== request.ownerId && row.author.login.toLowerCase() !== session.owner;
}

function signedReview(row: Static<typeof review>, target: Target): boolean {
  return row.author?.databaseId === target.request.ownerId && row.author.login.toLowerCase() === target.session.owner;
}

function confirmsReview(row: Static<typeof review>, target: Target): boolean {
  return signedReview(row, target) && row.body === target.body && row.commit?.oid === target.request.head
    && row.state === "COMMENTED" && row.submittedAt !== null && Number.isFinite(Date.parse(row.submittedAt));
}

async function prepare(repository: string, request: Request, signal: AbortSignal, historical = false): Promise<Target> {
  const { owner, repo, number } = parsePrRef(`${repository}#${request.number}`);
  parseWire(sha, JSON.stringify(request.head));
  parseWire(sha, JSON.stringify(request.baseSha));
  // Only the provided summary is rendered, never the surrounding verdict or replacement.
  // One literal line cannot close the fenced block or introduce slash commands. Neutralize
  // mentions even for consumers which inspect the review's raw Markdown.
  const summary = request.summary.toWellFormed().replace(/[\s\p{Cc}\p{Cf}]+/gu, " ").trim().replaceAll("@", "＠");
  if (!summary) throw new PrReadError("reference");
  const clipped = [...summary].slice(0, 400).join("");
  const session = await openIntakeGitHubSession(repository, signal);
  const { data } = await queryIntakeGitHub(session, signal, {
    query: targetQuery, schema: targetSchema, variables: { owner, repo, number },
  });
  const row = data.repository.pullRequest;
  if (data.viewer.login.toLowerCase() !== session.owner || data.viewer.databaseId !== request.ownerId
    || !matchesPull(row, session, request, historical)) throw new PrReadError("changed");
  const digest = createHash("sha256").update(JSON.stringify([
    "omp-superagent:intake-comment:v1", request.ownerId, request.repositoryId, row.id, number,
    request.baseRef, request.baseSha, request.head, request.summary,
  ])).digest("hex");
  const marker = `<!-- omp-superagent:intake-comment:v1:${digest} -->`;
  const body = `Static review of commit ${request.head} (comment only)\n\n~~~text\nSummary: ${clipped}${clipped === summary ? "" : "…"}\n~~~\n\n${marker}`;
  return { session, request, pullId: row.id, repoId: row.repository.id, digest, marker, body, historical };
}

async function findReview(target: Target, signal: AbortSignal): Promise<IntakeCommentResult | null> {
  const { session, request, pullId } = target;
  const seen = new Set<string>();
  const cursors = new Set<string>();
  const matching: Static<typeof review>[] = [];
  let cursor: string | null = null;
  let total: number | undefined;
  for (let i = 0; i < 10; i++) {
    const response: Static<typeof pageSchema> = await queryIntakeGitHub(session, signal, {
      query: pageQuery, schema: pageSchema, variables: { pullId, cursor },
    });
    const row: Static<typeof pageSchema>["data"]["node"] = response.data.node;
    if (row.id !== pullId || row.repository.id !== target.repoId || !matchesPull(row, session, request, target.historical))
      throw new PrReadError("changed");
    const { nodes, pageInfo, totalCount }: typeof row.reviews = row.reviews;
    total ??= totalCount;
    if (total !== totalCount || total > 300) throw new PrReadError("response");
    for (const item of nodes) {
      if (seen.has(item.id)) throw new PrReadError("response");
      seen.add(item.id);
      if (signedReview(item, target) && item.body.split(/\r?\n/).includes(target.marker)) matching.push(item);
    }
    if (!pageInfo.hasNextPage) {
      if (seen.size !== total) throw new PrReadError("response");
      if (matching.length === 0) return null;
      const [item] = matching;
      return matching.length === 1 && confirmsReview(item, target)
        ? { status: "posted", id: item.id }
        : { status: "unknown", reason: "GitHub has a matching review marker but not one exact verified comment. Do not resubmit." };
    }
    cursor = pageInfo.endCursor;
    if (!cursor || cursors.has(cursor) || nodes.length === 0 || seen.size >= total) throw new PrReadError("response");
    cursors.add(cursor);
  }
  throw new PrReadError("response");
}

/** Read-only reconciliation; absence is not proof that a fenced request never reached GitHub. */
export async function inspectIntakeComment(
  repository: string, number: number, head: string, summary: string, signal: AbortSignal, identity: IntakeMergeIdentity,
): Promise<IntakeCommentResult> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(intakeEvidenceDeadlineMs)]);
  try {
    // A later push/retarget/close does not erase a historical commit-pinned COMMENT.
    // This mode only reads; it never claims the newer head has been reviewed.
    const target = await prepare(repository, { ...identity, number, head, summary }, deadline, true);
    const receipt = await findReview(target, deadline);
    if (receipt) return receipt;
  } catch (error) {
    if (!(error instanceof PrReadError)) throw error;
  }
  return { status: "unknown", reason: "GitHub does not establish the exact submitted review comment. Do not resubmit." };
}

/** The caller must persist the no-replay fence before sending an otherwise non-idempotent mutation. */
export async function publishIntakeComment(
  repository: string, number: number, head: string, summary: string, signal: AbortSignal,
  beforeWrite: () => void, identity: IntakeMergeIdentity,
): Promise<IntakeCommentResult> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(intakeEvidenceDeadlineMs)]);
  let target: Target;
  try {
    target = await prepare(repository, { ...identity, number, head, summary }, deadline);
    const existing = await findReview(target, deadline);
    if (existing) return existing;
  } catch (error) {
    if (!(error instanceof PrReadError)) throw error;
    return { status: "blocked", reason: "GitHub ownership, reviewed base/head or complete comment preflight could not be established." };
  }
  if (deadline.aborted) return { status: "blocked", reason: "The review comment was cancelled before writing." };
  const { session, digest, pullId, body } = target;
  beforeWrite();
  try {
    // GitHub pins the comment's commit, not the live PR base or head. It never casts an approval.
    const { data } = await queryIntakeGitHub(session, deadline, {
      query: submitMutation, schema: submitSchema, variables: {
        input: { pullRequestId: pullId, commitOID: head, clientMutationId: digest, event: "COMMENT", body },
      },
    });
    const receipt = data.addPullRequestReview;
    if (receipt.clientMutationId === digest) {
      const reviewId = receipt.pullRequestReview.id;
      const observed = await queryIntakeGitHub(session, deadline, {
        query: reviewQuery, schema: reviewSchema, variables: { reviewId },
      });
      const row = observed.data.node;
      if (row.id === reviewId && row.pullRequest.id === pullId && row.pullRequest.repository.id === target.repoId
        && matchesPull(row.pullRequest, session, target.request) && confirmsReview(row, target))
        return { status: "posted", id: row.id };
    }
  } catch (error) {
    if (!(error instanceof PrReadError)) throw error;
  }
  return { status: "unknown", reason: "GitHub review comment outcome is unconfirmed; reconcile without resubmitting." };
}
