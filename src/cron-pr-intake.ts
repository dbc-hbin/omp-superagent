import { Type, type Static } from "@sinclair/typebox/type";
import { Value } from "@sinclair/typebox/value";
import { routeKey, type InputRecord, type OutputRecord, type StorePort } from "./contracts";
import type { CronJobs, CronPrJob } from "./cron-jobs";
import { parsePrRef } from "./pr-github";
import { PrReadError } from "./pr-github-schema";
import { intakeStatusKey } from "./pr-intake-work";

const offerPrefix = "cron-pr:offer:";
const githubId = Type.Readonly(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }));
const identitySchema = Type.Object({ repositoryId: githubId, ownerId: githubId });
const pullSchema = Type.Object({
  number: Type.Readonly(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
  head: Type.Readonly(Type.String({ pattern: "^[0-9a-fA-F]{40}$" })),
  author: Type.Readonly(Type.String({ minLength: 1 })),
  createdAt: Type.Readonly(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
});
const candidateSchema = Type.Object({
  ...pullSchema.properties,
  ...identitySchema.properties,
  jobId: Type.Readonly(Type.String()),
  outputId: Type.Readonly(Type.String()),
  epoch: Type.Readonly(Type.String()),
  policyRevision: Type.Optional(Type.Readonly(Type.String())),
});
const offerSchema = Type.Object({
  ...candidateSchema.properties,
  claimedBy: Type.Readonly(Type.Union([Type.String(), Type.Null()])),
});
const ledgerSchema = Type.Object({ identity: identitySchema, candidates: Type.Array(offerSchema) });
const resultSchema = Type.Object({
  ...identitySchema.properties, self: Type.String({ minLength: 1 }), pulls: Type.Array(pullSchema),
});

type RepositoryIdentity = Static<typeof identitySchema>;
type Offer = Static<typeof offerSchema>;
export type CronPrCandidate = Static<typeof candidateSchema>;
export interface IntakeScan {
  readonly job: CronPrJob;
  readonly entries: readonly { candidate: CronPrCandidate; head: string | null }[];
}
export type ReadIntakePulls = (repository: string, signal: AbortSignal) => Promise<RepositoryIdentity & {
  readonly self: string;
  readonly pulls: readonly Static<typeof pullSchema>[];
}>;

class CronPrIntakeError extends Error {}

export function normalizeIntakeRepository(input: string): string | null {
  try {
    const { owner, repo } = parsePrRef(`${input}#1`);
    return `${owner}/${repo}`;
  } catch (error) {
    if (error instanceof PrReadError && error.reason === "reference") return null;
    throw error;
  }
}

export function isPrIntakeOffer(outputId: string): boolean {
  return outputId.startsWith(offerPrefix);
}

function ledgerKey(repository: string): string { return `cron-pr:ledger:${repository}`; }
function outcomeKey(runId: string): string { return `cron-pr:outcome:${runId}`; }

function ledger(store: StorePort, repository: string): Static<typeof ledgerSchema> | null {
  const raw = store.getMeta(ledgerKey(repository));
  if (raw === null) return null;
  const parsed: unknown = JSON.parse(raw);
  if (!Value.Check(ledgerSchema, parsed)) throw new CronPrIntakeError("Damaged PR intake offer ledger.");
  return parsed;
}

function sameIdentity(left: RepositoryIdentity, right: RepositoryIdentity): boolean {
  return left.repositoryId === right.repositoryId && left.ownerId === right.ownerId;
}

function action(candidate: CronPrCandidate): string {
  return `/cron pr-review ${candidate.jobId} ${candidate.number} ${candidate.head}`;
}

function offerText(repository: string, candidate: CronPrCandidate): string {
  if (candidate.policyRevision) return `${repository}#${candidate.number} — 새 외부 PR (${candidate.head}). 등록한 단계에 따라 이 메시지에 전용 검토 스레드를 엽니다. 상태: /cron show ${candidate.jobId} ${candidate.number}\n수동 검토:\n${action(candidate)}`;
  return `New external pull request: ${repository}#${candidate.number}. `
    + `The following owner command starts a read-only review; it does not merge or change the pull request.\n\n${action(candidate)}`;
}

export function describePrIntake(store: StorePort, job: CronPrJob, number: number | null): string {
  const candidates = ledger(store, job.repository)?.candidates.filter(candidate => candidate.jobId === job.id) ?? [];
  const summary = job.lastRunId ? store.getMeta(outcomeKey(job.lastRunId)) : null;
  const newest = [...candidates].reverse();
  const selected = number === null ? newest.slice(0, 10) : newest.filter(candidate => candidate.number === number);
  const open = !job.paused && !job.removed && job.stopBoundary === store.getMeta("head:stop-boundary");
  const lines = selected.map(candidate => {
    const status = candidate.claimedBy !== null
      ? store.output(candidate.outputId)?.state ?? "not queued; no automatic replay"
      : candidate.epoch === job.epoch && open
        ? "deferred; up to one offer per scan" : "deferred offer suppressed; manual review only";
    const progress = store.getMeta(intakeStatusKey(job.id, candidate.number));
    return `${action(candidate)} (${status})${progress ? ` — ${progress}` : ""}`;
  });
  return [
    summary,
    lines.length ? `Recorded PR offers:\n${lines.join("\n")}` : "No matching PR offers recorded.",
    number === null && newest.length > selected.length ? `Showing the latest ${selected.length} of ${newest.length}; use /cron show ${job.id} PR_NUMBER for an older offer.` : null,
  ].filter(Boolean).join("\n");
}

/** Read-only controller: no native prompts, synthetic owner inputs, or PR actions. */
export class CronPrIntake {
  private readonly fetching = new Map<string, { readonly input: InputRecord; readonly abort: AbortController }>();

  constructor(
    private readonly store: StorePort,
    private readonly jobs: CronJobs,
    private readonly readIntakePulls: ReadIntakePulls,
  ) {}

  cancelInactive(): void {
    for (const { input, abort } of this.fetching.values()) {
      if (!this.jobs.pendingPrRun(input)) abort.abort();
    }
  }

  candidate(job: CronPrJob, number: number): CronPrCandidate | null {
    const saved = ledger(this.store, job.repository);
    if (!saved) return null;
    return saved.candidates.find(candidate => candidate.jobId === job.id && candidate.number === number
      && sameIdentity(saved.identity, candidate)) ?? null;
  }

  canDeliver(output: OutputRecord): boolean {
    if (!isPrIntakeOffer(output.id)) return false;
    const [repository, number, extra] = output.id.slice(offerPrefix.length).split(":");
    if (!repository || normalizeIntakeRepository(repository) !== repository || !number || extra !== undefined) return false;
    const saved = ledger(this.store, repository);
    if (!saved) return false;
    const candidate = saved.candidates.find(item => item.outputId === output.id && item.claimedBy !== null && sameIdentity(saved.identity, item));
    if (!candidate) return false;
    const active = this.jobs.activePrEnrollment(candidate.jobId);
    return active !== null && active.job.repository === repository && candidate.epoch === active.job.epoch
      && output.sourceId === active.source.id && routeKey(output.route) === routeKey(active.source.route)
      && output.text === offerText(repository, candidate);
  }

  async consume(input: InputRecord, signal: AbortSignal): Promise<IntakeScan | undefined> {
    if (signal.aborted || this.fetching.has(input.id) || input.state !== "pending" || !this.jobs.isPrIntakeRun(input)) return;
    const enrollment = this.jobs.pendingPrRun(input);
    if (!enrollment) {
      if (!this.store.getMeta("head:restart-fence")) this.store.settle(input.id, "cancelled");
      return;
    }
    const abort = new AbortController();
    const workSignal = AbortSignal.any([signal, abort.signal]);
    this.fetching.set(input.id, { input, abort });
    try {
      const result = await this.read(enrollment.job.repository, workSignal);
      // In-flight work is not authority: pause/removal, stop, replacement, or
      // the loss of the original authenticated source can all revoke this receipt.
      if (workSignal.aborted) return;
      const current = this.jobs.pendingPrRun(input);
      if (!current || current.job.epoch !== enrollment.job.epoch) {
        if (!this.store.getMeta("head:restart-fence")) this.store.settle(input.id, "cancelled");
        return;
      }
      if (result === null) {
        this.finish(input.id, "GitHub lookup failed; no new offers were made.", "cancelled");
        return;
      }
      const self = result.self.toLowerCase();
      if (!current.job.repository.startsWith(`${self}/`)) {
        this.finish(input.id, "Authenticated GitHub account does not match the repository owner; no new offers were made.", "cancelled");
        return;
      }
      const saved = ledger(this.store, current.job.repository);
      if (saved && !sameIdentity(saved.identity, result)) {
        this.finish(input.id, "GitHub repository or owner identity changed; no new offers were made.", "cancelled");
        return;
      }
      const identity = { repositoryId: result.repositoryId, ownerId: result.ownerId };
      const policy = this.jobs.prPolicy(current.job.id);
      const prior = saved?.candidates ?? [];
      const seen = new Set(prior.map(candidate => candidate.number));
      const observed = new Map<number, string>();
      const added: Offer[] = [];
      for (const pull of result.pulls) {
        if (pull.author.toLowerCase() === self || pull.createdAt <= current.job.eligibleAfter || observed.has(pull.number)) continue;
        const head = pull.head.toLowerCase();
        observed.set(pull.number, head);
        if (seen.has(pull.number)) continue;
        added.push({
          number: pull.number, head, author: pull.author, createdAt: pull.createdAt, claimedBy: null,
          ...identity, jobId: current.job.id, epoch: current.job.epoch,
          ...(policy ? { policyRevision: policy.revision } : {}),
          outputId: `${offerPrefix}${current.job.repository}:${pull.number}`,
        });
      }
      const candidates = [...prior, ...added];
      let chosen: Offer | undefined;
      let chosenIndex = -1;
      // The run's claim consumes its one slot even if the process died before
      // queueing. Old-epoch/closed candidates remain inspectable. An unclaimed
      // offer gets its currently observed SHA, so pushes during the backlog
      // do not make an otherwise eligible PR permanently unannouncable.
      if (!prior.some(candidate => candidate.claimedBy === input.id)) {
        for (const [index, candidate] of candidates.entries()) {
          const head = observed.get(candidate.number);
          if (candidate.claimedBy !== null || candidate.jobId !== current.job.id || candidate.epoch !== current.job.epoch
            || head === undefined) continue;
          if (!chosen || candidate.createdAt < chosen.createdAt
            || candidate.createdAt === chosen.createdAt && candidate.number < chosen.number) {
            chosenIndex = index;
            chosen = { ...candidate, head };
          }
        }
      }
      if (chosen) candidates[chosenIndex] = { ...chosen, claimedBy: input.id };
      if (!saved || added.length || chosen) {
        // Commit discovery and claim together before touching the outbox. A
        // non-retryable claim is distinct from deferred discovery.
        this.store.setMeta(ledgerKey(current.job.repository), JSON.stringify({ identity, candidates }));
      }
      if (chosen) {
        try {
          this.store.queueOutput({
            id: chosen.outputId, sourceId: current.source.id, route: current.source.route,
            text: offerText(current.job.repository, chosen),
          });
        } catch (error) {
          this.finish(input.id, "The PR offer was claimed but outbox creation was interrupted; inspect the recorded status.", "cancelled");
          throw error;
        }
      }
      this.finish(input.id, `GitHub lookup recorded ${added.length} new PR candidates; ${chosen ? "one offer queued" : "no offer queued"}.`, "done");
      return { job: current.job, entries: candidates.flatMap(candidate =>
        candidate.jobId === current.job.id && candidate.epoch === current.job.epoch && candidate.claimedBy !== null
          && candidate.policyRevision ? [{ candidate, head: observed.get(candidate.number) ?? null }] : []) };
    } finally {
      this.fetching.delete(input.id);
    }
  }

  private async read(repository: string, signal: AbortSignal) {
    try {
      const snapshot: unknown = await this.readIntakePulls(repository, signal);
      return Value.Check(resultSchema, snapshot) ? snapshot : null;
    } catch (error) {
      if (error instanceof Error) return null;
      throw error;
    }
  }

  private finish(runId: string, note: string, state: "done" | "cancelled"): void {
    this.store.setMeta(outcomeKey(runId), note);
    this.store.settle(runId, state);
  }
}
