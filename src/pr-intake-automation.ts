import { createHash } from "node:crypto";
import { Type, type Static } from "@sinclair/typebox/type";
import type { StorePort } from "./contracts";
import { PrReadError, parseWire } from "./pr-github-schema";
import { inspectIntakeComment, publishIntakeComment } from "./pr-intake-comment";
import { applyIntakeFix, parseIntakeFix, reconcileIntakeFix } from "./pr-intake-fix";
import { inspectIntakeMerge, mergeIntakePull } from "./pr-intake-github";
import { IntakeMaterialError, readIntakeMaterial, readIntakeMaterialTarget } from "./pr-intake-material";
import type { PrIntakeMode } from "./pr-intake-mode";
import type { ReviewRound } from "./pr-intake-review";

// allow: SIZE_OK - This state machine owns the PR-wide ledger and its single write fence.
const maxHeads = 3;
const rank = { review: 0, fix: 1, merge: 2 } as const;
const sha = Type.String({ pattern: "^[a-f0-9]{40}$" });
const hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
const nonempty = Type.String({ minLength: 1 });
const materialSchema = Type.Object({ digest: hash, baseRef: nonempty, baseSha: sha, headRef: nonempty });
const proof = {
  head: sha, inputId: nonempty, answerDigest: hash, material: materialSchema,
};
const receipt = Type.Union([
  Type.Object({ ...proof, state: Type.Literal("pending") }),
  Type.Object({ ...proof, state: Type.Literal("unknown") }),
  Type.Object({ ...proof, state: Type.Literal("refused"), reason: nonempty }),
  Type.Object({ ...proof, state: Type.Literal("confirmed"), id: nonempty }),
]);
const ledger = Type.Object({
  ownerId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  lineage: Type.Object({ revision: nonempty, heads: Type.Array(sha, { maxItems: maxHeads, uniqueItems: true }) }),
  nextHead: Type.Optional(sha),
  comments: Type.Array(receipt),
  fix: Type.Optional(receipt),
  merge: Type.Optional(receipt),
});
const verdictSchema = Type.Object({
  verdict: Type.Union([Type.Literal("approve"), Type.Literal("blocked"), Type.Literal("fix")]),
  summary: Type.String({ minLength: 1, maxLength: 2048 }),
});
const key = (r: Scope) => `pr-intake-automation:${r.repositoryId}:${r.number}`;
const digest = (s: string) => createHash("sha256").update(s).digest("hex");

export const prIntakeAutomationApis = {
  inspectIntakeComment, publishIntakeComment, applyIntakeFix, reconcileIntakeFix,
  inspectIntakeMerge, mergeIntakePull, readIntakeMaterial,
};
type Scope = Pick<ReviewRound, "repositoryId" | "number">;
type Ledger = Readonly<Static<typeof ledger>>;
type Receipt = Readonly<Static<typeof receipt>>;
type CommitReceipt = Exclude<Receipt, { state: "confirmed" }>
  | (Extract<Receipt, { state: "confirmed" }> & { readonly sha: string });
type Effect = "comment" | "fix" | "merge";
type Submission =
  | { readonly status: "confirmed"; readonly id: string }
  | { readonly status: "blocked" | "unknown"; readonly reason: string };
export type PrIntakeAutomationState = Omit<Ledger, "fix" | "merge"> & {
  readonly comment?: Receipt;
  readonly fix?: CommitReceipt;
  readonly merge?: CommitReceipt;
};
export type PrIntakeAutomationEvidence = { readonly answer: string; readonly material: Readonly<Static<typeof materialSchema>> };
export type PrIntakeAutomationDeps = {
  readonly store: Pick<StorePort, "getMeta" | "setMeta">;
  readonly mode: PrIntakeMode;
  readonly observedHead: string | null;
  readonly evidence: PrIntakeAutomationEvidence | null;
  readonly verify: (stage: PrIntakeMode) => void;
  readonly signal: AbortSignal;
  readonly reconcileOnly?: boolean;
  readonly api?: Partial<typeof prIntakeAutomationApis>;
};
export type PrIntakeAutomationProgress = {
  readonly status: "waiting" | "held" | "unknown" | "commented" | "fixed" | "merged";
  readonly message: string;
  readonly nextHead?: string;
};

export class PrIntakeAutomationError extends Error {}
class ReviewedMaterialChanged extends PrIntakeAutomationError {}

function decode(raw: string): Ledger {
  try { return parseWire(ledger, raw); }
  catch (error) {
    if (error instanceof PrReadError) throw new PrIntakeAutomationError("Invalid durable PR automation state.", { cause: error });
    throw error;
  }
}

export function readPrIntakeAutomation(store: Pick<StorePort, "getMeta">, scope: Scope): PrIntakeAutomationState | null {
  const raw = store.getMeta(key(scope));
  if (raw === null) return null;
  const saved = decode(raw);
  const commitReceipt = (entry: Receipt | undefined): CommitReceipt | undefined =>
    entry?.state === "confirmed" ? { ...entry, sha: entry.id } : entry;
  return { ...saved, comment: saved.comments.at(-1), fix: commitReceipt(saved.fix), merge: commitReceipt(saved.merge) };
}

function unresolved(receipt: Receipt | undefined): receipt is Extract<Receipt, { state: "pending" | "unknown" }> {
  return receipt?.state === "pending" || receipt?.state === "unknown";
}

export function prIntakeManualHold(
  store: Pick<StorePort, "getMeta">, scope: Scope, action: "pr-review" | "pr-fix" | "pr-merge", head?: string,
): string | null {
  const state = readPrIntakeAutomation(store, scope);
  if (!state) return null;
  if (state.comments.some(unresolved) || unresolved(state.fix) || unresolved(state.merge))
    return "An automatic GitHub write is unresolved for this PR. Reconcile it read-only before any new review or write.";
  if (state.merge?.state === "confirmed") return `GitHub already confirmed merge ${state.merge.id}.`;
  if (state.fix?.state === "confirmed" && state.fix.head === head)
    return `GitHub already confirmed fix ${state.fix.id}. Review the current head instead.`;
  if (action !== "pr-review" && state.nextHead && head === state.lineage.heads.at(-1))
    return `The PR moved to ${state.nextHead}. Review the current head instead.`;
  return null;
}

function parseVerdict(answer: string) {
  if (Buffer.byteLength(answer) > 64 * 1024) return null;
  try {
    const value = parseWire(verdictSchema, answer);
    if (!value.summary.trim()) return null;
    if (value.verdict === "fix") {
      const proposal = parseIntakeFix(answer);
      if (!proposal) return null;
      // A model may echo the proposed source inside its prose, not just in the fix fields.
      const snippets = [proposal.old, proposal.replacement].sort((a, b) => b.length - a.length);
      const summary = snippets.reduce((text, snippet) => snippet ? text.replaceAll(snippet, "[source omitted]") : text, value.summary);
      return { verdict: "fix" as const, summary, proposal };
    }
    const keys = [...answer.matchAll(/"(?:[^"\\]|\\[\s\S])*"/g)]
      .filter(token => /^\s*:/.test(answer.slice(token.index + token[0].length)));
    return keys.length === 2 && Object.keys(value).length === 2 ? { ...value, verdict: value.verdict } : null;
  } catch (error) {
    if (error instanceof PrReadError) return null;
    throw error;
  }
}

const waiting = (message: string): PrIntakeAutomationProgress => ({ status: "waiting", message });
const held = (message: string): PrIntakeAutomationProgress => ({ status: "held", message });

export async function advancePrIntakeAutomation(r: ReviewRound, d: PrIntakeAutomationDeps): Promise<PrIntakeAutomationProgress> {
  if (!r.automation || d.signal.aborted) return held("No live unattended review registration.");
  const { revision } = r.automation;
  const api = { ...prIntakeAutomationApis, ...d.api };
  const { repository, number, head } = r;
  const { signal, evidence } = d;
  const observed = d.observedHead;
  let raw = d.store.getMeta(key(r));
  let state: Ledger = raw === null ? { ownerId: r.ownerId, lineage: { revision, heads: [] }, comments: [] } : decode(raw);
  if (state.ownerId !== r.ownerId) return held("The original automatic PR owner does not match.");
  if (state.merge?.state === "confirmed") return { status: "merged", message: `GitHub confirmed merge ${state.merge.id}.` };
  const check = (stage: PrIntakeMode) => {
    if (signal.aborted || !(rank[d.mode] >= rank[stage])) throw new PrIntakeAutomationError("The unattended stage is no longer permitted.");
    d.verify(stage);
  };
  const save = (next: Ledger) => {
    if (d.store.getMeta(key(r)) !== raw) throw new PrIntakeAutomationError("The durable automatic PR state changed.");
    const value = JSON.stringify(next);
    d.store.setMeta(key(r), value);
    raw = value;
    state = next;
  };
  const saveEffect = (effect: Effect, entry: Receipt) => save(effect === "comment"
    ? { ...state, comments: [...state.comments.filter(item => item.head !== entry.head), entry] }
    : { ...state, [effect]: entry });
  const answerDigest = evidence && digest(evidence.answer);
  const verdict = evidence && parseVerdict(evidence.answer);
  const pendingComment = state.comments.find(unresolved);
  const pending = pendingComment ? { kind: "comment", entry: pendingComment } as const
    : unresolved(state.fix) ? { kind: "fix", entry: state.fix } as const
    : unresolved(state.merge) ? { kind: "merge", entry: state.merge } as const : null;
  if (pending) {
    const { kind, entry } = pending;
    const unknown: PrIntakeAutomationProgress = { status: "unknown", message: `Automatic ${kind} remains unconfirmed. No write was repeated.` };
    if (entry.inputId !== r.inputId || entry.head !== head) return unknown;
    const target = { ...r, ...entry.material };
    switch (kind) {
      case "comment": {
        if (!verdict || entry.answerDigest !== answerDigest) return unknown;
        const result = await api.inspectIntakeComment(repository, number, head, verdict.summary, signal, target);
        if (result.status !== "posted") return unknown;
        saveEffect(kind, { ...entry, state: "confirmed", id: result.id });
        return { status: "commented", message: `GitHub confirmed the review comment for ${head}.` };
      }
      case "fix": {
        if (verdict?.verdict !== "fix" || entry.answerDigest !== answerDigest) return unknown;
        const result = await api.reconcileIntakeFix(repository, number, head, verdict.proposal, signal, target.headRef, r);
        if (result.status !== "applied") return unknown;
        saveEffect(kind, { ...entry, state: "confirmed", id: result.sha });
        return { status: "fixed", message: `GitHub confirmed fix ${result.sha}.` };
      }
      case "merge": {
        const result = await api.inspectIntakeMerge(repository, number, head, signal, target);
        if (result.status !== "merged") return unknown;
        saveEffect(kind, { ...entry, state: "confirmed", id: result.sha });
        return { status: "merged", message: `GitHub confirmed merge ${result.sha}.` };
      }
    }
  }
  if (d.reconcileOnly) return waiting("No unresolved automatic GitHub write for this PR.");

  check("review");
  const fixed = state.fix?.state === "confirmed" ? state.fix : null;
  if (fixed && fixed.head === head && (observed === head || !observed))
    return { status: "fixed", message: `GitHub confirmed fix ${fixed.id}; a review of the current head is required before merge.` };
  if (!observed) return waiting("The current open PR head was not observed. No GitHub write was attempted.");
  const heads = state.lineage.revision === revision ? state.lineage.heads : [];
  if (heads.at(-1) !== head) {
    if (heads.includes(head) || heads.length >= maxHeads) return held("Automatic review head limit reached; use a fresh owner review.");
    const { nextHead, ...rest } = state;
    if (nextHead && state.lineage.revision === revision && nextHead !== head)
      return held("The newly placed review does not match the reserved automatic head.");
    save({ ...rest, lineage: { revision, heads: [...heads, head] } });
  }
  if (observed !== head) {
    if (state.lineage.heads.includes(observed) || state.lineage.heads.length >= maxHeads)
      return held("The head changed to a prior revision or reached the automatic review limit; use a fresh owner review.");
    if (state.nextHead !== observed) save({ ...state, nextHead: observed });
    return { status: "waiting", message: `The head changed; full static review required for ${observed}.`, nextHead: observed };
  }
  // A reservation may have become obsolete before its review started (e.g. a force push).
  if (state.nextHead) {
    const { nextHead: _, ...current } = state;
    save(current);
  }
  if (!evidence || !answerDigest) return waiting("Waiting for the original native review and its confirmed delivery.");
  if (!verdict) return held("The delivered native review is not an exact supported verdict.");
  const savedComment = state.comments.find(item => item.head === head);
  if (savedComment?.state === "refused") return held(savedComment.reason);
  if (savedComment?.state === "confirmed"
    && (savedComment.answerDigest !== answerDigest || savedComment.material.digest !== evidence.material.digest))
    return held("A review comment already exists for this head, but not for the current review evidence.");

  const entry = { head, inputId: r.inputId, answerDigest, material: evidence.material };
  const target = { ...r, ...evidence.material };
  const verifyMaterial = (material: string) => {
    const parsed = readIntakeMaterialTarget(material);
    if (digest(material) !== target.digest || parsed.baseRef !== target.baseRef
      || parsed.baseSha !== target.baseSha || parsed.headRef !== target.headRef)
      throw new ReviewedMaterialChanged("The current PR material does not match the delivered review.");
  };
  const readReviewed = async () => {
    verifyMaterial(await api.readIntakeMaterial(repository, number, head, signal, r));
  };

  const submit = async (kind: Effect, stage: PrIntakeMode, run: (beforeWrite: () => void) => Promise<Submission>) => {
    check(stage);
    let attempted = false;
    const result = await run(() => {
      check(stage);
      if (attempted) throw new PrIntakeAutomationError("An automatic GitHub write cannot be sent a second time.");
      saveEffect(kind, { ...entry, state: "pending" });
      attempted = true;
    });
    switch (result.status) {
      case "confirmed":
        if (kind === "fix" && !attempted) throw new PrIntakeAutomationError("Fix confirmation lacks its durable send fence.");
        saveEffect(kind, { ...entry, state: "confirmed", id: result.id });
        return { ...result, attempted };
      case "unknown":
        saveEffect(kind, { ...entry, state: "unknown" });
        return { ...result, attempted };
      case "blocked":
        if (attempted) saveEffect(kind, { ...entry, state: "refused", reason: result.reason });
        return { ...result, attempted };
    }
  };
  try {
    if (!savedComment) {
      await readReviewed();
      const result = await submit("comment", "review", async beforeWrite => {
        const result = await api.publishIntakeComment(repository, number, head, verdict.summary, signal, beforeWrite, target);
        return result.status === "posted" ? { status: "confirmed", id: result.id } : result;
      });
      if (result.status !== "confirmed") return { status: result.status === "unknown" ? "unknown" : "held", message: result.reason };
    }
    if (d.mode === "review" || verdict.verdict === "blocked")
      return { status: "commented", message: "GitHub review comment confirmed; no higher unattended action." };
    if (verdict.verdict === "fix") {
      if (state.fix || state.lineage.heads.length >= maxHeads)
        return held("No further automatic fix is permitted; a fresh owner decision is required.");
      const result = await submit("fix", "fix", async beforeWrite => {
        const result = await api.applyIntakeFix(repository, number, head, verdict.proposal, signal, material => {
          verifyMaterial(material);
          beforeWrite();
        }, r);
        return result.status === "applied" ? { status: "confirmed", id: result.sha } : result;
      });
      return result.status === "confirmed" ? { status: "fixed", message: `GitHub confirmed fix ${result.id}; waiting for a new review.` }
        : { status: result.status === "unknown" ? "unknown" : "held", message: result.reason };
    }
    if (d.mode !== "merge")
      return { status: "commented", message: "GitHub review comment confirmed; merge requires explicit owner approval." };
    if (state.merge?.state === "refused" && state.merge.head === head) return held(state.merge.reason);
    check("merge");
    // A declined inspection (including pending CI) does not claim a write.
    const observedMerge = await api.inspectIntakeMerge(repository, number, head, signal, target);
    if (observedMerge.status === "blocked") return waiting(observedMerge.reason);
    if (observedMerge.status === "merged") {
      saveEffect("merge", { ...entry, state: "confirmed", id: observedMerge.sha });
      return { status: "merged", message: `GitHub confirmed merge ${observedMerge.sha}.` };
    }
    await readReviewed();
    const result = await submit("merge", "merge", async beforeWrite => {
      const result = await api.mergeIntakePull(repository, number, head, signal, beforeWrite, target);
      return result.status === "merged" ? { status: "confirmed", id: result.sha } : result;
    });
    return result.status === "confirmed" ? { status: "merged", message: `GitHub confirmed merge ${result.id}.` }
      : { status: result.status === "unknown" ? "unknown" : result.attempted ? "held" : "waiting", message: result.reason };
  } catch (error) {
    if (error instanceof IntakeMaterialError || error instanceof PrReadError || error instanceof ReviewedMaterialChanged)
      return held(error.message);
    throw error;
  }
}
