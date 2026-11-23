import { createHash } from "node:crypto";
import { Type, type Static } from "@sinclair/typebox/type";
import { parseWire, PrReadError } from "./pr-github-schema";
import { openIntakeGitHubSession, queryIntakeGitHub, type IntakeRepositoryIdentity } from "./pr-intake-github";
import {
  intakeEvidenceDeadlineMs, IntakeMaterialError, readIntakeDiff, readIntakePullIdentity, serializeIntakeDiff,
  type IntakeMaterialTarget,
} from "./pr-intake-material";
import { openIntakeTree, readIntakeBlob } from "./pr-intake-tree";

const maxSnippet = 8 * 1024;
const maxSource = 96 * 1024;
const oid = Type.String({ pattern: "^[0-9a-f]{40}$" });
const id = Type.String({ minLength: 1, maxLength: 256, pattern: "^[A-Za-z0-9_+=/-]+$" });
const fix = Type.Object({
  path: Type.String({ minLength: 1, maxLength: 256 }),
  old: Type.String({ minLength: 1, maxLength: maxSnippet }),
  replacement: Type.String({ maxLength: maxSnippet }),
});
const verdict = Type.Object({
  ...fix.properties, verdict: Type.Literal("fix"), summary: Type.String({ minLength: 1, maxLength: 2048 }),
}, { additionalProperties: false });
const branchSchema = Type.Object({ name: Type.String(), protected: Type.Boolean(), commit: Type.Object({ sha: oid }) });
const branchRead = Type.Object({ data: Type.Object({
  viewer: Type.Object({ login: Type.String(), databaseId: Type.Integer() }),
  repository: Type.Object({
    id, databaseId: Type.Integer(), isArchived: Type.Literal(false), isDisabled: Type.Literal(false),
    nameWithOwner: Type.String(), defaultBranchRef: Type.Object({ name: Type.String() }),
    ref: Type.Object({ id, name: Type.String(), target: Type.Object({ oid }) }),
    pullRequest: Type.Object({
      state: Type.Literal("OPEN"), isDraft: Type.Literal(false), baseRefName: Type.String(), baseRefOid: oid,
      headRefName: Type.String(), headRefOid: oid, headRepository: Type.Object({ id }),
    }),
  }),
}), errors: Type.Optional(Type.Array(Type.Unknown(), { maxItems: 0 })) });
const branchQuery = `query IntakeFixBranch($owner: String!, $repo: String!, $ref: String!, $number: Int!) {
  viewer { login databaseId }
  repository(owner: $owner, name: $repo) {
    id databaseId isArchived isDisabled nameWithOwner defaultBranchRef { name }
    ref(qualifiedName: $ref) { id name target { oid } }
    pullRequest(number: $number) {
      state isDraft baseRefName baseRefOid headRefName headRefOid headRepository { id }
    }
  }
}`;
const mutation = `mutation IntakeFixCommit($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) {
    clientMutationId ref { id } commit { oid parents(first: 2) { totalCount nodes { oid } } }
  }
}`;
const receipt = Type.Object({ data: Type.Object({
  createCommitOnBranch: Type.Object({
    clientMutationId: Type.String(), ref: Type.Object({ id }),
    commit: Type.Object({ oid, parents: Type.Object({
      totalCount: Type.Literal(1), nodes: Type.Tuple([Type.Object({ oid })]),
    }) }),
  }),
}), errors: Type.Optional(Type.Array(Type.Unknown(), { maxItems: 0 })) });
const commitSchema = Type.Object({
  sha: oid, parents: Type.Tuple([Type.Object({ sha: oid })]),
  commit: Type.Object({ message: Type.String() }),
  files: Type.Tuple([Type.Object({ filename: Type.String(), status: Type.Literal("modified"), sha: oid })]),
});

type Target = IntakeMaterialTarget;
type Session = Awaited<ReturnType<typeof openIntakeGitHubSession>>;
export type IntakeFixProposal = Readonly<Static<typeof fix>>;
export type IntakeFixResult =
  | { readonly status: "applied"; readonly sha: string }
  | { readonly status: "blocked" | "unknown"; readonly reason: string };

function safePath(path: string): boolean {
  return /^(?:src|lib|test|tests)\/(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:[cm]?[jt]sx?|py|go|rs|java|cs|c|cc|cpp|h|hpp|rb|php|swift|kt)$/.test(path)
    && !/(?:^|[./_-])(?:config|configs|settings|metadata|ci|workflows?|scripts?|build|setup|conftest)(?=$|[./_-])/i.test(path);
}

function safeSnippet(value: string): boolean {
  return Buffer.byteLength(value) <= maxSnippet && value.isWellFormed()
    && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\p{Cf}]|\r(?!\n)/u.test(value);
}

function safeProposal({ path, old, replacement }: IntakeFixProposal): boolean {
  return path.length <= 256 && safePath(path) && old.length > 0 && old !== replacement
    && safeSnippet(old) && safeSnippet(replacement);
}

export function parseIntakeFix(text: string): IntakeFixProposal | null {
  if (Buffer.byteLength(text) > 64 * 1024) return null;
  try {
    const { path, old, replacement, summary } = parseWire(verdict, text);
    // JSON.parse alone silently accepts an object that states two different verdicts.
    const keys = [...text.matchAll(/"(?:[^"\\]|\\[\s\S])*"/g)]
      .filter(token => /^\s*:/.test(text.slice(token.index + token[0].length)));
    if (keys.length !== Object.keys(verdict.properties).length) return null;
    const proposal = { path, old, replacement };
    return summary.trim() && safeProposal(proposal) ? proposal : null;
  } catch (error) {
    if (error instanceof PrReadError) return null;
    throw error;
  }
}

export function intakeFixDigest(repository: string, number: number, head: string, proposal: IntakeFixProposal): string {
  return createHash("sha256").update(JSON.stringify([
    "omp-superagent:intake-fix:v1", repository.toLowerCase(), number, head, proposal.path, proposal.old, proposal.replacement,
  ])).digest("hex");
}

type Pull = Awaited<ReturnType<typeof readIntakePullIdentity>>;
function sameRepoHead(session: Session, target: Target, head: Pull["head"]): boolean {
  return head.repo.id === target.identity.repositoryId && head.repo.owner.id === target.identity.ownerId
    && head.repo.full_name.toLowerCase() === session.repository && head.repo.owner.login.toLowerCase() === session.owner;
}

async function prepareContents(session: Session, head: string, proposal: IntakeFixProposal, expectedBlob?: string) {
  const tree = await openIntakeTree(session, head);
  const file = await tree(proposal.path);
  if (file?.mode !== "100644" || (expectedBlob !== undefined && file.sha !== expectedBlob))
    throw new IntakeMaterialError("Fix requires the exact reviewed, non-executable regular source file.");
  const original = await readIntakeBlob(session, file.sha, maxSource);
  const offset = original.indexOf(proposal.old);
  if (offset < 0 || offset !== original.lastIndexOf(proposal.old))
    throw new IntakeMaterialError("The old fix snippet must match the pinned file exactly once.");
  const contents = original.slice(0, offset) + proposal.replacement + original.slice(offset + proposal.old.length);
  if (Buffer.byteLength(contents) > maxSource) throw new IntakeMaterialError("The resulting source file is too large.");
  return contents;
}

async function prepareWrite(session: Session, target: Target, proposal: IntakeFixProposal, signal: AbortSignal) {
  const snapshot = await readIntakeDiff(session, target);
  const material = serializeIntakeDiff(snapshot);
  const { head, base, draft } = snapshot.pull;
  if (draft || head.name !== session.repository || head.repositoryId !== target.identity.repositoryId
    || head.owner !== session.owner || head.ownerId !== target.identity.ownerId)
    throw new IntakeMaterialError("Fixes require an open non-draft PR with a same-repository head branch.");
  if (head.ref === base.ref || !/^[A-Za-z0-9][A-Za-z0-9/_.-]{0,149}$/.test(head.ref))
    throw new IntakeMaterialError("Fixes cannot write the PR base or an unsupported branch name.");
  const file = snapshot.files.find(row => row.filename === proposal.path);
  if (!file || (file.status !== "modified" && file.status !== "added") || file.afterMode !== "100644")
    throw new IntakeMaterialError("Fixes may only replace text in one reviewed added or modified source file.");
  const contents = await prepareContents(session, target.head, proposal, file.sha);
  const encoded = encodeURIComponent(head.ref);
  const [rules] = await session.get(`${session.root}/rules/branches/${encoded}`, Type.Tuple([Type.Array(Type.Unknown())]));
  const [branch] = await session.get(`${session.root}/branches/${encoded}`, Type.Tuple([branchSchema]));
  if (rules.length || branch.protected || branch.name !== head.ref || branch.commit.sha !== target.head)
    throw new IntakeMaterialError("GitHub does not establish an unprotected branch at the approved head.");
  const { data } = await queryIntakeGitHub(session, signal, { query: branchQuery, schema: branchRead, variables: {
    owner: session.owner, repo: session.repository.slice(session.owner.length + 1),
    ref: `refs/heads/${head.ref}`, number: target.number,
  } });
  const { repository, viewer } = data;
  const pr = repository.pullRequest;
  if (viewer.databaseId !== target.identity.ownerId || viewer.login.toLowerCase() !== session.owner
    || repository.databaseId !== target.identity.repositoryId || repository.nameWithOwner.toLowerCase() !== session.repository
    || repository.defaultBranchRef.name === head.ref || repository.ref.name !== head.ref || repository.ref.target.oid !== target.head
    || pr.baseRefName !== base.ref || pr.baseRefOid !== base.sha || pr.headRefName !== head.ref
    || pr.headRefOid !== target.head || pr.headRepository.id !== repository.id)
    throw new IntakeMaterialError("GitHub repository, owner, PR, or write-eligible branch changed during fix preflight.");
  return { branchId: repository.ref.id, material, contents };
}

export async function applyIntakeFix(
  repository: string, number: number, head: string, proposal: IntakeFixProposal, signal: AbortSignal,
  beforeWrite: (material: string) => void, identity: IntakeRepositoryIdentity,
): Promise<IntakeFixResult> {
  if (!safeProposal(proposal)) return { status: "blocked", reason: "The exact fix proposal is not a safe source replacement." };
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(intakeEvidenceDeadlineMs)]);
  let session: Session, prepared: Awaited<ReturnType<typeof prepareWrite>>;
  try {
    session = await openIntakeGitHubSession(repository, deadline);
    prepared = await prepareWrite(session, { number, head, identity }, proposal, deadline);
  } catch (error) {
    if (error instanceof IntakeMaterialError) return { status: "blocked", reason: error.message };
    if (error instanceof PrReadError) return { status: "blocked", reason: "GitHub fix preflight evidence could not be established." };
    throw error;
  }
  const digest = intakeFixDigest(session.repository, number, head, proposal);
  const input = {
    branch: { id: prepared.branchId }, expectedHeadOid: head, clientMutationId: digest,
    message: { headline: `Superagent intake fix ${digest}` },
    fileChanges: { additions: [{ path: proposal.path, contents: Buffer.from(prepared.contents).toString("base64") }] },
  };
  if (deadline.aborted) return { status: "blocked", reason: "The fix was cancelled before writing." };
  beforeWrite(prepared.material);
  try {
    const { data } = await queryIntakeGitHub(session, signal, { query: mutation, schema: receipt, variables: { input } });
    const result = data.createCommitOnBranch;
    if (result.clientMutationId === digest && result.ref.id === prepared.branchId
      && result.commit.oid !== head && result.commit.parents.nodes[0].oid === head)
      return { status: "applied", sha: result.commit.oid };
  } catch (error) {
    if (!(error instanceof PrReadError)) throw error;
  }
  return { status: "unknown", reason: "GitHub did not confirm the conditional write. Reconcile without resubmitting." };
}

export async function reconcileIntakeFix(
  repository: string, number: number, head: string, proposal: IntakeFixProposal, signal: AbortSignal,
  expectedBranch: string, identity: IntakeRepositoryIdentity,
): Promise<IntakeFixResult> {
  const unknown = { status: "unknown", reason: "GitHub does not establish the exact approved fix at the current PR head. Do not resubmit." } as const;
  if (!safeProposal(proposal) || !expectedBranch) return unknown;
  try {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(intakeEvidenceDeadlineMs)]);
    const session = await openIntakeGitHubSession(repository, deadline);
    const target = { number, head, identity };
    const current = await readIntakePullIdentity(session, target);
    if (!sameRepoHead(session, target, current.head) || current.head.ref !== expectedBranch || current.head.sha === head
      || current.base.ref === expectedBranch)
      return unknown;
    const observed = current.head.sha;
    const [candidate] = await session.get(`${session.root}/commits/${observed}?per_page=100`, Type.Tuple([commitSchema]));
    const digest = intakeFixDigest(session.repository, number, head, proposal);
    if (candidate.sha !== observed || candidate.parents[0].sha !== head || candidate.files[0].filename !== proposal.path
      || candidate.commit.message.replace(/\n+$/, "") !== `Superagent intake fix ${digest}`) return unknown;
    const tree = await openIntakeTree(session, observed);
    const file = await tree(proposal.path);
    if (file?.mode !== "100644" || file.sha !== candidate.files[0].sha
      || await readIntakeBlob(session, file.sha, maxSource) !== await prepareContents(session, head, proposal))
      return unknown;
    const [branch] = await session.get(`${session.root}/branches/${encodeURIComponent(expectedBranch)}`, Type.Tuple([branchSchema]));
    const confirmed = await readIntakePullIdentity(session, target);
    // This proves the observed effect, not who caused it or whether our response was lost.
    if (branch.name === expectedBranch && branch.commit.sha === observed && confirmed.head.sha === observed
      && confirmed.head.ref === expectedBranch && confirmed.base.ref === current.base.ref
      && confirmed.base.sha === current.base.sha
      && confirmed.user.id === current.user.id && sameRepoHead(session, target, confirmed.head))
      return { status: "applied", sha: observed };
  } catch (error) {
    if (!(error instanceof PrReadError) && !(error instanceof IntakeMaterialError)) throw error;
  }
  return unknown;
}
