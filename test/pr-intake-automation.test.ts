import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  advancePrIntakeAutomation, prIntakeManualHold, readPrIntakeAutomation,
  type PrIntakeAutomationDeps,
} from "../src/pr-intake-automation";
import type { PrIntakeMode } from "../src/pr-intake-mode";
import type { ReviewRound } from "../src/pr-intake-review";
import { Store } from "../src/store";

const original = "a".repeat(40), base = "b".repeat(40), fixed = "c".repeat(40);
const external = "d".repeat(40), merged = "e".repeat(40), another = "f".repeat(40);
const old = "export const total = 1;", replacement = "export const total = 2;";
const approve = JSON.stringify({ verdict: "approve", summary: "The change is correct." });
const blocked = JSON.stringify({ verdict: "blocked", summary: "The change needs owner review." });
const fix = JSON.stringify({ verdict: "fix", summary: `Correct the value (${replacement}).`, path: "src/example.ts", old, replacement });

const openStores: Store[] = [];
afterEach(() => {
  for (const store of openStores.splice(0)) store.close();
});

function round(head = original, revision = "policy-1"): ReviewRound {
  return {
    job: "enrollment", repository: "owner/repo", repositoryId: 23, ownerId: 17, number: 7,
    laneId: "lane", opener: "opener", source: `source:${revision}:${head}`, inputId: `input:${revision}:${head}`,
    head, epoch: "epoch", automation: { revision, anchor: "thread" },
  };
}

const materialFor = (head: string, baseSha = base) => JSON.stringify({
  pull: { head: { sha: head, ref: "changes" }, base: { sha: baseSha, ref: "main" } },
});
const noProof = new Error("Original scope is no longer active");
const interrupted = new Error("Send interrupted after crossing the fence");

function scenario(mode: PrIntakeMode) {
  const store = new Store(":memory:");
  openStores.push(store);
  const git = {
    openHead: original as string | null, base,
    ciReady: true, mergeRefusedBeforeSend: false,
    loseResponse: null as "comment" | "fix" | "merge" | null,
    reconcile: true,
    beforeSend: (_effect: "comment" | "fix" | "merge") => {},
    comments: new Map<string, string>(),
    commentSends: [] as string[], fixes: [] as string[], merges: [] as string[],
    observations: 0,
  };
  const api: NonNullable<PrIntakeAutomationDeps["api"]> = {
    readIntakeMaterial: async (_repo, _number, head) => {
      git.observations++;
      return materialFor(head, git.base);
    },
    publishIntakeComment: async (_repo, _number, head, summary, _signal, send) => {
      if (git.reconcile && git.comments.get(head) === summary) return { status: "posted", id: `comment:${head}` };
      git.beforeSend("comment");
      send();
      git.commentSends.push(head);
      git.comments.set(head, summary);
      if (git.loseResponse === "comment") throw interrupted;
      return { status: "posted", id: `comment:${head}` };
    },
    inspectIntakeComment: async (_repo, _number, head, summary) => {
      git.observations++;
      return git.reconcile && git.openHead === head && git.comments.get(head) === summary
        ? { status: "posted", id: `comment:${head}` } : { status: "unknown", reason: "No exact comment" };
    },
    applyIntakeFix: async (_repo, _number, head, _proposal, _signal, send) => {
      git.beforeSend("fix");
      send(materialFor(head, git.base));
      git.fixes.push(head);
      git.openHead = fixed;
      return git.loseResponse === "fix" ? { status: "unknown", reason: "Fix response lost" } : { status: "applied", sha: fixed };
    },
    reconcileIntakeFix: async (_repo, _number, head, _proposal, _signal, branch) => {
      git.observations++;
      return git.reconcile && git.fixes.includes(head) && git.openHead === fixed && branch === "changes"
        ? { status: "applied", sha: fixed } : { status: "unknown", reason: "No exact fix" };
    },
    inspectIntakeMerge: async (_repo, _number, head) => {
      git.observations++;
      if (git.reconcile && git.merges.includes(head)) return { status: "merged", sha: merged };
      return git.ciReady ? { status: "ready" } : { status: "blocked", reason: "CI pending" };
    },
    mergeIntakePull: async (_repo, _number, head, _signal, send) => {
      if (git.mergeRefusedBeforeSend) return { status: "blocked", reason: "CI changed during preflight" };
      git.beforeSend("merge");
      send();
      git.merges.push(head);
      git.openHead = null;
      return git.loseResponse === "merge" ? { status: "unknown", reason: "Merge response lost" } : { status: "merged", sha: merged };
    },
  };
  function tick(r: ReviewRound, answer: string | null, override: Partial<PrIntakeAutomationDeps> = {}) {
    return advancePrIntakeAutomation(r, {
      store, mode, observedHead: git.openHead, signal: new AbortController().signal, verify: () => {},
      evidence: answer === null ? null : {
        answer, material: { digest: createHash("sha256").update(materialFor(r.head)).digest("hex"), baseRef: "main", baseSha: base, headRef: "changes" },
      },
      ...override, api: { ...api, ...override.api },
    });
  }
  return { git, store, tick };
}

test("review ceiling waits for delivered evidence and posts a summary without the proposed source", async () => {
  const { git, tick } = scenario("review");
  const r = round();
  expect((await tick(r, null)).status).toBe("waiting");
  expect(git.comments.size).toBe(0);
  expect((await tick(r, fix)).status).toBe("commented");
  expect((await tick(r, fix)).status).toBe("commented");
  expect([...git.comments]).toEqual([[original, "Correct the value ([source omitted])."]]);
  expect(git.fixes).toEqual([]);
  expect(git.merges).toEqual([]);
});

test("existing exact comment readback can satisfy the first stage without a second send", async () => {
  const { git, tick, store } = scenario("review");
  git.comments.set(original, "The change is correct.");
  git.beforeSend = () => { throw new Error("Duplicate mutation"); };
  expect((await tick(round(), approve)).status).toBe("commented");
  expect(readPrIntakeAutomation(store, round())?.comment).toMatchObject({ state: "confirmed", head: original });
});

test("mismatched reviewed material and malformed verdicts do not leave eligible GitHub writes", async () => {
  const { git, tick, store } = scenario("merge");
  const r = round();
  const invalid = [
    '{"verdict":"blocked","verdict":"approve","summary":"Conflicting duplicate verdict"}',
    '{"verdict":"approve","summary":"Review with invalid extra key","command":"merge"}',
    '{"verdict":"fix","summary":"Change configuration","path":"src/config.ts","old":"x","replacement":"y"}',
  ];
  for (const answer of invalid) expect((await tick(r, answer)).status).toBe("held");
  git.base = another;
  expect((await tick(r, approve)).message).toContain("does not match");
  expect([...git.comments]).toEqual([]);
  expect(git.merges).toEqual([]);
  expect(readPrIntakeAutomation(store, r)?.comment).toBeUndefined();
});

test.each([
  ["comment", "review", approve], ["fix", "fix", fix], ["merge", "merge", approve],
] as const)("%s fence sees revocation during remote preflight, not the prior verification", async (effect, mode, verdict) => {
  const { git, tick, store } = scenario(mode);
  let active = true;
  git.beforeSend = step => { if (step === effect) active = false; };
  const r = round();
  await expect(tick(r, verdict, { verify: stage => {
    if (!active && stage === mode) throw noProof;
  } })).rejects.toThrow(noProof.message);
  const state = readPrIntakeAutomation(store, r);
  expect(state?.[effect]).toBeUndefined();
  expect(prIntakeManualHold(store, r, "pr-review", original)).toBeNull();
  expect(git.comments.size).toBe(effect === "comment" ? 0 : 1);
  expect(git.fixes).toEqual([]);
  expect(git.merges).toEqual([]);
});

test("a stopped controller refuses to send even if remote preflight completes", async () => {
  const { git, tick, store } = scenario("review");
  const stop = new AbortController();
  git.beforeSend = () => stop.abort();
  const r = round();
  await expect(tick(r, approve, { signal: stop.signal })).rejects.toThrow("no longer permitted");
  expect(git.commentSends).toEqual([]);
  expect(readPrIntakeAutomation(store, r)?.comment).toBeUndefined();
});

test("interrupted comment blocks manual control by absolute PR identity and reconciles without replay under a revoked grant", async () => {
  const { git, tick, store } = scenario("merge");
  const r = round();
  git.loseResponse = "comment";
  await expect(tick(r, approve)).rejects.toThrow(interrupted.message);
  expect(readPrIntakeAutomation(store, r)?.comment).toMatchObject({ state: "pending", head: original });
  const otherRound = { ...round(external, "replacement-policy"), job: "replacement-enrollment" };
  expect(prIntakeManualHold(store, otherRound, "pr-review", external)).not.toBeNull();
  expect(prIntakeManualHold(store, otherRound, "pr-merge", external)).not.toBeNull();
  expect(prIntakeManualHold(store, { ...otherRound, number: 8 }, "pr-merge", external)).toBeNull();
  git.openHead = external;
  git.reconcile = false;
  expect((await tick(r, approve)).status).toBe("unknown");
  expect((await tick(otherRound, approve)).status).toBe("unknown");
  git.reconcile = true;
  git.openHead = original;
  git.beforeSend = () => { throw new Error("Ambiguous send repeated"); };
  const readOnly = { reconcileOnly: true, mode: "review", verify: () => { throw noProof; } } as const;
  expect((await tick(r, approve, readOnly)).status).toBe("commented");
  git.openHead = external;
  expect((await tick(r, approve, readOnly)).nextHead).toBeUndefined();
  expect(prIntakeManualHold(store, otherRound, "pr-review", external)).toBeNull();
  expect(git.commentSends).toEqual([original]);
  expect(git.merges).toEqual([]);
});

test("fix ceiling re-reviews and comments on the resulting commit without merging", async () => {
  const { git, tick, store } = scenario("fix");
  const r = round();
  expect((await tick(r, fix)).status).toBe("fixed");
  const later = await tick(r, fix);
  expect(later.nextHead).toBe(fixed);
  expect(readPrIntakeAutomation(store, r)?.fix).toMatchObject({ state: "confirmed", head: original, sha: fixed });
  expect(prIntakeManualHold(store, r, "pr-merge", original)).toContain(fixed);
  expect(prIntakeManualHold(store, r, "pr-review", fixed)).toBeNull();
  expect((await tick(round(fixed), approve)).status).toBe("commented");
  expect(prIntakeManualHold(store, r, "pr-merge", fixed)).toBeNull();
  expect(git.commentSends).toEqual([original, fixed]);
  expect(git.fixes).toEqual([original]);
  expect(git.merges).toEqual([]);
});

test("protected merge reviews the exact fixed SHA anew, waits on CI, and does not re-read a confirmed merge", async () => {
  const { git, tick, store } = scenario("merge");
  const r = round();
  expect((await tick(r, fix)).status).toBe("fixed");
  expect((await tick(r, fix, { observedHead: original })).nextHead).toBeUndefined();
  expect((await tick(r, fix)).nextHead).toBe(fixed);
  expect(readPrIntakeAutomation(store, r)?.nextHead).toBe(fixed);
  const final = round(fixed);
  expect((await tick(final, null)).status).toBe("waiting");
  git.ciReady = false;
  expect((await tick(final, approve)).message).toBe("CI pending");
  expect(git.merges).toEqual([]);
  git.ciReady = true;
  git.mergeRefusedBeforeSend = true;
  expect((await tick(final, approve)).status).toBe("waiting");
  expect(readPrIntakeAutomation(store, final)?.merge).toBeUndefined();
  git.mergeRefusedBeforeSend = false;
  expect((await tick(final, approve)).status).toBe("merged");
  const observations = git.observations;
  expect((await tick(final, approve)).status).toBe("merged");
  expect(git.observations).toBe(observations);
  expect(git.merges).toEqual([fixed]);
  expect([...git.comments.keys()]).toEqual([original, fixed]);
  expect(prIntakeManualHold(store, r, "pr-review", external)).toContain(merged);
});

test("an external push is re-reviewed instead of borrowing approval and the final review cannot self-fix", async () => {
  const { git, tick } = scenario("merge");
  await tick(round(), fix);
  expect((await tick(round(), fix)).nextHead).toBe(fixed);
  git.openHead = external;
  expect((await tick(round(), approve)).nextHead).toBe(external);
  expect((await tick(round(external), fix)).message).toContain("No further automatic fix");
  expect(git.fixes).toEqual([original]);
  expect(git.merges).toEqual([]);
  expect([...git.comments.keys()]).toEqual([original, external]);
});

test("head admission is bounded per policy revision and prior heads are not reviewed again", async () => {
  const { git, tick } = scenario("review");
  for (const [prior, next] of [[original, external], [external, another]] as const) {
    git.openHead = prior;
    expect((await tick(round(prior), blocked)).status).toBe("commented");
    git.openHead = next;
    expect((await tick(round(prior), blocked)).nextHead).toBe(next);
  }
  await tick(round(another), blocked);
  git.openHead = fixed;
  expect((await tick(round(another), blocked)).status).toBe("held");
  git.openHead = original;
  expect((await tick(round(another), blocked)).nextHead).toBeUndefined();
  expect([...git.comments.keys()]).toEqual([original, external, another]);
});

test("ambiguous fix or merge is reconciled read-only even when the old head is no longer observed", async () => {
  const { git, tick, store } = scenario("merge");
  const start = round();
  git.loseResponse = "fix";
  expect((await tick(start, fix)).status).toBe("unknown");
  git.reconcile = false;
  expect((await tick(start, fix)).status).toBe("unknown");
  expect(prIntakeManualHold(store, start, "pr-review", fixed)).not.toBeNull();
  git.reconcile = true;
  expect((await tick(start, fix)).status).toBe("fixed");
  expect((await tick(start, fix)).nextHead).toBe(fixed);
  const final = round(fixed);
  git.loseResponse = "merge";
  expect((await tick(final, approve)).status).toBe("unknown");
  git.reconcile = false;
  expect((await tick(final, null)).status).toBe("unknown");
  expect(prIntakeManualHold(store, final, "pr-merge", fixed)).not.toBeNull();
  git.reconcile = true;
  expect((await tick(final, null)).status).toBe("merged");
  expect(git.fixes).toEqual([original]);
  expect(git.merges).toEqual([fixed]);
});
