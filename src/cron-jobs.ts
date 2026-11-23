// allow: SIZE_OK — prompt and PR intake jobs share one atomic schedule/control ledger.
import { createHash, randomUUID } from "node:crypto";
import { authorizeRoute, type Config } from "./config";
import { routeKey, type Inbound, type InputRecord, type Route, type StorePort } from "./contracts";
import { describePrIntake, normalizeIntakeRepository } from "./cron-pr-intake";
import { describeCronSchedule, nextCronTime, parseCronSchedule, type CronSchedule } from "./cron-schedule";
import { compareMessageIds } from "./message-order";
import { parsePrModeControl, prModeArgument, prModeEffects, type PrIntakeMode } from "./pr-intake-mode";

const jobsKey = "cron:jobs";
export const CRON_SHELL_SILENT = "[SILENT]";
const shellKey = (runId: string) => `cron-shell:${runId}`;
const shellOutputHashKey = (outputId: string) => `cron-shell-hash:${outputId}`;
export const CRON_RUN_PREFIX = "cron-run:";
const manualPrEffects = "manual: discovery only; use the explicit owner commands for review, fix, or merge when the native checks allow";
const approvalFallback = "Work above the selected mode still needs an explicit owner command and must pass the native checks.";
const stalePrOrder = "This PR intake command predates a newer control. No PR intake settings were changed.";
const unverifiedPrOrder = "PR intake control order could not be verified. Send /cron show JOB_ID and reply to its confirmed status with a new explicit command.";
const usage = [
  '/cron add "every 2h" Check the build', '/cron add "in 30m" Remind me',
  '/cron add "TZ=Asia/Seoul 0 9 * * 1-5" Summarize CI',
  '/cron add shell "every 1h" df -h   (runs the command alone, no model turn; posts stdout)',
  '/cron list | show ID | pause ID | resume ID | run ID | remove ID',
  '/cron edit ID "schedule" [prompt] | /cron edit ID prompt NEW_PROMPT',
  '/cron pr-add "every 5m" OWNER/REPO | /cron show ID [PR_NUMBER]',
  "/cron pr-mode JOB_OR_OWNER/REPO review|fix|merge",
  "With one enrolled repository in this parent, you can also say: 무인으로 리뷰만 | 무인으로 리뷰 후 수정커밋까지 | 무인으로 수정커밋후 머지까지",
  `New PR enrollments default to review; existing enrollments without a selected mode remain ${manualPrEffects}.`,
  ...Object.entries(prModeEffects).map(([mode, effects]) => `${mode}: ${effects}`),
  approvalFallback,
].join("\n");

interface JobTiming {
  readonly id: string;
  readonly sourceId: string;
  readonly nextAt: number | null;
  readonly paused: boolean;
  readonly stopBoundary: string | null;
  readonly lastRunId: string | null;
}

interface PromptJob extends JobTiming {
  readonly kind?: "prompt"; // Older prompt jobs have no discriminant.
  readonly schedule: CronSchedule;
  readonly prompt: string;
  /** The prompt is a shell command run alone; its stdout is posted verbatim. */
  readonly shell?: true;
  /** Command revision tied to outputHash so stale in-flight runs cannot restore an edited command's hash. */
  readonly commandRevision?: string;
  /** SHA-256 of the last posted shell output; the only output state kept. */
  readonly outputHash?: string;
}

export interface CronPrJob extends JobTiming {
  readonly kind: "pr-intake";
  readonly repository: string;
  readonly schedule: Exclude<CronSchedule, { kind: "once" }>;
  readonly eligibleAfter: number;
  readonly epoch: string;
  readonly removed: boolean;
  readonly prMode?: PrModeSelection;
}

type CronJob = PromptJob | CronPrJob;
type PrEnrollment = { readonly job: CronPrJob; readonly source: InputRecord };
type PrModeSelection = { readonly mode: PrIntakeMode; readonly sourceId: string };
type PrPolicy = PrModeSelection & { readonly revision: string };

interface PrOrder {
  readonly membership: string | null;
  readonly control: string | null;
  readonly mode: string | null;
}

class CronPrScopeError extends Error {}

interface CronState {
  readonly jobs: readonly CronJob[];
  readonly registrations: Readonly<Record<string, { readonly fingerprint: string; readonly jobId: string }>>;
}

export interface CronCreate {
  readonly sourceId: string;
  readonly schedule: string;
  readonly prompt: string;
}

export interface CronShellResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: string;
}

export interface CronShellOutcome {
  /** Text to post, or null to stay silent. */
  readonly text: string | null;
  /** Hash to persist after a successful post; null leaves the stored hash unchanged. */
  readonly hash: string | null;
}

export interface CronUpdate {
  readonly text: string;
  readonly state?: "cancelled";
  readonly metadata?: Readonly<Record<string, string>>;
  readonly run?: Inbound;
  readonly cancelPending?: string;
}

function jobMetadata(state: CronState, changed: CronJob, remove = false) {
  const next = state.jobs.filter(job => job.id !== changed.id);
  if (!remove) next.push(changed);
  return { [jobsKey]: JSON.stringify({ ...state, jobs: next }) };
}

const outputHash = (text: string) => createHash("sha256").update(text).digest("hex");

function shellRevision(job: PromptJob): string { return job.commandRevision ?? job.sourceId; }

function prRunKey(id: string): string { return `cron-pr:run:${id}`; }

function prRunIdentity(job: CronPrJob): string { return JSON.stringify([job.id, job.epoch]); }

function prModeKey(sourceId: string): string { return `cron-pr:mode:${sourceId}`; }

function prOrderKey(jobId: string): string { return `cron-pr:order:${jobId}`; }

function prStatusKey(sourceId: string): string { return `cron-pr:status:${sourceId}`; }

function isDiscordSnowflake(id: unknown): id is string {
  return typeof id === "string" && /^[1-9]\d{0,19}$/.test(id) && BigInt(id) <= (1n << 64n) - 1n;
}

function afterDiscordOrder(order: string, boundary: string | null): boolean {
  return isDiscordSnowflake(boundary) && compareMessageIds("discord", order, boundary) === 1;
}

function originalCronArgument(input: InputRecord): string | undefined {
  return /^\/cron\s+([\s\S]+)$/u.exec(input.text.trim())?.[1];
}

function prModeReceipt(job: CronPrJob, mode: PrIntakeMode): string {
  // Keep the resolved target of a targetless instruction even if the parent
  // later enrolls another repository.
  return JSON.stringify([job.id, job.repository, mode]);
}

function prAddRequest(tail: string) {
  const pair = /^"([^"\r\n]+)"[ \t]+([^ \t\r\n]+)$/u.exec(tail);
  if (!pair?.[1] || !pair[2]) return null;
  const repository = normalizeIntakeRepository(pair[2]);
  return repository ? { schedule: pair[1].trim(), repository } : null;
}

function originalPrAdd(text: string) {
  const tail = /^\/cron[ \t]+pr-add[ \t]+(.+)$/u.exec(text.trim())?.[1];
  return tail ? prAddRequest(tail) : null;
}

function runMetadata(job: CronJob, run: Inbound): Readonly<Record<string, string>> {
  return job.kind === "pr-intake" ? { [prRunKey(run.id)]: prRunIdentity(job) }
    : job.shell ? { [shellKey(run.id)]: JSON.stringify({ jobId: job.id, revision: shellRevision(job) }) } : {};
}

function cronRun(job: CronJob, source: InputRecord, trigger: string, now: number): Inbound {
  return {
    id: `${CRON_RUN_PREFIX}${job.id}:${trigger}`, route: source.route, messageId: source.messageId,
    ...(source.interactionId === undefined ? {} : { interactionId: source.interactionId }),
    ...(source.invocationId === undefined ? {} : { invocationId: source.invocationId }),
    receivedAt: now, attachments: [],
    text: job.kind === "pr-intake" ? `Repository PR intake scan for scheduled job ${job.id}.`
      : job.shell ? job.prompt
      : `Scheduled job ${job.id}. Execute only the stored owner prompt below. No interactive follow-up, delegation authority, standing approval or new schedule is implied.\n\n${job.prompt}`,
  };
}

function promptText(text: string): string {
  if (!/^"(?:\\.|[^"\\])*"$/s.test(text)) return text;
  try {
    const decoded: unknown = JSON.parse(text);
    return typeof decoded === "string" ? decoded.trim() : text;
  } catch (error) {
    if (error instanceof SyntaxError) return text;
    throw error;
  }
}

export class CronJobs {
  constructor(private readonly store: StorePort, private readonly config: Config) {}

  private state(): CronState {
    return JSON.parse(this.store.getMeta(jobsKey) ?? '{"jobs":[],"registrations":{}}');
  }

  private source(job: CronJob): InputRecord | null {
    const source = this.store.input(job.sourceId);
    if (job.kind === "pr-intake") {
      return source && source.route.threadId === null && this.originalPrSource(source) ? source : null;
    }
    return source && this.store.getMeta(`user-source:${source.id}`) === "true"
      && authorizeRoute(this.config, source.route) ? source : null;
  }

  private originalMessage(input: InputRecord): boolean {
    return input.messageId === null || !/:edit:\d+[:.]\S+$/.test(input.id)
      && this.store.firstAdmittedMessage(input.route, input.messageId)?.id === input.id;
  }

  private discordOrder(input: InputRecord): string | null {
    if (input.route.platform !== "discord" || input.pickerSelection || input.invocationId !== undefined
      || this.store.getMeta(`user-source:${input.id}`) !== "true") return null;
    const id = input.messageId ?? input.interactionId;
    if (!isDiscordSnowflake(id)) return null;
    if (input.messageId === null) return input.id === `discord:${input.route.accountId}:interaction:${id}` ? id : null;
    return input.interactionId === undefined && this.originalMessage(input) ? id : null;
  }

  /** Keep the newest physical stop even if catch-up admits an older stop later. */
  prStopOrder(previousBoundary: string | null, newStop: InputRecord): string | null {
    const order = authorizeRoute(this.config, newStop.route) ? this.discordOrder(newStop) : null;
    if (order === null || previousBoundary === null) return order;
    const previous = this.stopOrder(previousBoundary);
    if (previous === null) return null; // An incomparable stop always requires causal recovery.
    return afterDiscordOrder(order, previous) ? order : previous;
  }

  private stopOrder(boundary: string): string | null {
    let receipt: unknown;
    try { receipt = JSON.parse(boundary); }
    catch (error) {
      if (error instanceof SyntaxError) return null;
      throw error;
    }
    if (!receipt || typeof receipt !== "object") return null;
    if ("prDiscordOrder" in receipt) return isDiscordSnowflake(receipt.prDiscordOrder) ? receipt.prDiscordOrder : null;
    if (!("inputId" in receipt) || typeof receipt.inputId !== "string") return null;
    const input = this.store.input(receipt.inputId);
    return input && authorizeRoute(this.config, input.route) ? this.discordOrder(input) : null;
  }

  private originalPrSource(input: InputRecord): boolean {
    const { route } = input;
    const stored = this.store.input(input.id);
    // A voice confirmation can have projected draft text in `text`. It is
    // not a physical owner instruction to open a lane or publish to GitHub.
    const written = stored?.discordOriginalText?.trim().replace(/^<@!?(\d+)>\s*/, (mention, id) =>
      id === route.accountId ? "" : mention).trim();
    return stored !== null && (stored.state === "pending" || stored.state === "done")
      && (written === undefined || written === stored.text.trim())
      && routeKey(stored.route) === routeKey(route) && stored.messageId === input.messageId
      && stored.interactionId === input.interactionId && !stored.pickerSelection
      && (stored.messageId === null ? stored.interactionId !== undefined
        : !stored.id.startsWith(`discord:${route.accountId}:${stored.messageId}:edit:`))
      && route.platform === "discord" && route.guildId !== null && route.topicId === undefined
      && this.store.getMeta(`user-source:${input.id}`) === "true"
      && authorizeRoute(this.config, route) && this.originalMessage(stored);
  }

  /** Metadata survives pause, removal and restarts; these receipts must never reach a model. */
  isPrIntakeRun(input: InputRecord): boolean {
    if (!input.id.startsWith(CRON_RUN_PREFIX)) return false;
    const [id] = input.id.slice(CRON_RUN_PREFIX.length).split(":", 1);
    return this.store.getMeta(prRunKey(input.id)) !== null || this.state().jobs.some(job => job.id === id && job.kind === "pr-intake");
  }

  activePrEnrollment(jobId: string): PrEnrollment | null {
    if (this.store.getMeta("head:restart-fence")) return null;
    const job = this.state().jobs.find(job => job.id === jobId);
    if (job?.kind !== "pr-intake" || job.removed || job.paused
      || job.stopBoundary !== this.store.getMeta("head:stop-boundary")) return null;
    const source = this.source(job);
    return source ? { job, source } : null;
  }

  private prControlSource(inputId: string): InputRecord | null {
    const source = this.store.input(inputId);
    return source?.target === "main" && source.route.threadId === null && source.attachments.length === 0
      && this.store.getMeta(`handoff-source:${inputId}`) === null
      && this.store.getMeta(`activity-source:${inputId}`) === null
      && this.originalPrSource(source) ? source : null;
  }

  private savedPrMode(job: CronPrJob, parent: Route): PrModeSelection | null {
    const selection = job.prMode;
    if (!selection || typeof selection.sourceId !== "string"
      || this.store.getMeta(prModeKey(selection.sourceId)) !== prModeReceipt(job, selection.mode)) return null;
    const action = this.prControlSource(selection.sourceId);
    if (action?.state !== "done" || routeKey(action.route) !== routeKey(parent)) return null;
    const argument = prModeArgument(action.text);
    if (!argument) {
      return selection.mode === "review" && originalPrAdd(action.text)?.repository === job.repository ? selection : null;
    }
    const command = parsePrModeControl(argument);
    return command && command.mode === selection.mode
      && (command.target === null || command.target === job.id || command.target === job.repository) ? selection : null;
  }

  private prOrder(job: CronPrJob, parent: Route): PrOrder {
    const saved = this.store.getMeta(prOrderKey(job.id));
    if (saved !== null) return JSON.parse(saved);
    // An untouched initial enrollment provides a trustworthy legacy baseline.
    // A legacy pause, removal, or later epoch cannot date prior changes in
    // physical send order: old controllers settled controls in arrival order.
    const enrolled = job.epoch === job.sourceId ? this.prControlSource(job.sourceId) : null;
    const order = enrolled?.state === "done" && routeKey(enrolled.route) === routeKey(parent)
      && originalPrAdd(enrolled.text)?.repository === job.repository ? this.discordOrder(enrolled) : null;
    const mode = this.savedPrMode(job, parent);
    const selection = mode && this.prControlSource(mode.sourceId);
    return {
      membership: job.removed ? null : order,
      control: job.removed || job.paused ? null : order,
      mode: selection ? this.discordOrder(selection) : null,
    };
  }

  private prStatusReceipt(job: CronPrJob, boundary: string | null): string {
    return JSON.stringify([job.id, boundary, job.epoch, job.paused, job.removed, job.prMode?.sourceId,
      this.store.getMeta(prOrderKey(job.id))]);
  }

  private repliesToPrStatus(input: InputRecord, job: CronPrJob, order: string): boolean {
    const replied = input.reply?.messageId;
    if (input.messageId === null || !isDiscordSnowflake(replied) || !afterDiscordOrder(order, replied)) return false;
    const output = this.store.sentOutputForMessage(input.route, replied);
    return output !== null && output.remoteId === replied && routeKey(output.route) === routeKey(input.route)
      && output.id === `${output.sourceId}:head-control`
      && this.store.getMeta(prStatusKey(output.sourceId)) === this.prStatusReceipt(job, this.store.getMeta("head:stop-boundary"));
  }

  /** Read at admission and before each unattended effect; an older revision never regains authority. */
  prPolicy(jobId: string): PrPolicy | null {
    const active = this.activePrEnrollment(jobId);
    if (!active) return null;
    const selection = this.savedPrMode(active.job, active.source.route);
    return selection ? {
      mode: selection.mode, sourceId: selection.sourceId, revision: JSON.stringify([active.job.epoch, selection.sourceId]),
    } : null;
  }

  requireActivePrJob(input: InputRecord, jobId: string, parentRoute?: Route): CronPrJob {
    const scope = parentRoute ?? input.route;
    const parentMatches = parentRoute === undefined || routeKey({ ...input.route, threadId: null }) === routeKey(parentRoute);
    const active = this.activePrEnrollment(jobId);
    if (scope.threadId !== null || !parentMatches || !this.originalPrSource(input) || !active
      || routeKey(active.source.route) !== routeKey(scope)) {
      throw new CronPrScopeError("No active PR intake job with that ID in the authorized Discord parent.");
    }
    return active.job;
  }

  pendingPrRun(input: InputRecord): PrEnrollment | null {
    if (!this.isPrIntakeRun(input) || this.store.getMeta(`user-source:${input.id}`) === "true") return null;
    const [jobId] = input.id.slice(CRON_RUN_PREFIX.length).split(":", 1);
    const live = this.store.input(input.id);
    const active = jobId ? this.activePrEnrollment(jobId) : null;
    return active && live?.state === "pending" && live.target === "main" && active.job.lastRunId === live.id
      && this.store.getMeta(prRunKey(live.id)) === prRunIdentity(active.job)
      && routeKey(live.route) === routeKey(active.source.route) && live.messageId === active.source.messageId
      && live.interactionId === active.source.interactionId ? active : null;
  }

  create(input: InputRecord, request: CronCreate, now: number) {
    if (!this.originalMessage(input)) throw new Error("Send a new owner message to create a cron job; edits do not authorize changes.");
    const scheduleText = request.schedule.trim();
    const prompt = request.prompt.trim();
    const state = this.state();
    const sourceKey = createHash("sha256").update(input.id).digest("hex");
    const fingerprint = createHash("sha256").update(JSON.stringify([scheduleText, prompt])).digest("hex");
    const prior = state.registrations[sourceKey];
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new Error("This owner request already registered a different cron job; use /cron edit.");
      const job = state.jobs.find(job => job.id === prior.jobId);
      return job ? { id: job.id, status: "already_registered", current: this.status(job) }
        : { id: prior.jobId, status: "removed" };
    }
    const schedule = parseCronSchedule(scheduleText, now);
    if (!schedule || !prompt) throw new Error(`Invalid schedule or missing prompt.\n${usage}`);
    const nextAt = nextCronTime(schedule, now);
    const job: PromptJob = { id: randomUUID(), sourceId: input.id, schedule, prompt, nextAt,
      paused: false, stopBoundary: this.store.getMeta("head:stop-boundary"), lastRunId: null };
    // The receipt lives in the same write and survives removal of the job.
    const next = { ...state, registrations: { ...state.registrations, [sourceKey]: { jobId: job.id, fingerprint } } };
    this.store.setMeta(jobsKey, jobMetadata(next, job)[jobsKey]);
    return { id: job.id, status: "created", schedule: describeCronSchedule(schedule), nextAt: new Date(nextAt).toISOString() };
  }

  private status(job: CronJob, proposedMode?: PrIntakeMode): string {
    const last = job.lastRunId ? this.store.input(job.lastRunId)?.state ?? "missing" : "none";
    const state = job.kind === "pr-intake" && job.removed ? "removed"
      : last === "uncertain" || last === "missing" ? "held (reconcile the original HEAD input)"
      : job.paused ? "paused" : job.stopBoundary !== this.store.getMeta("head:stop-boundary") ? "held by HEAD stop"
      : job.nextAt === null ? "no next run" : "scheduled";
    const detail = job.kind === "pr-intake" ? `; PR intake ${job.repository}` : job.shell ? "; shell" : "";
    const policy = job.kind === "pr-intake" ? `\n${this.prModeStatus(job, proposedMode)}` : "";
    return `${job.id} — ${state}${detail}; ${describeCronSchedule(job.schedule)}; next: ${job.nextAt === null ? "none" : new Date(job.nextAt).toISOString()}; last: ${last}${job.lastRunId ? ` (${job.lastRunId})` : ""}${policy}`;
  }

  private prModeStatus(job: CronPrJob, proposedMode?: PrIntakeMode): string {
    const source = this.source(job);
    const mode = proposedMode ?? (source ? this.savedPrMode(job, source.route)?.mode : undefined);
    if (!mode) return `PR intake mode: ${manualPrEffects}.`;
    const held = job.paused || job.removed || job.stopBoundary !== this.store.getMeta("head:stop-boundary")
      || Boolean(this.store.getMeta("head:restart-fence"));
    return `PR intake mode: ${mode}${held ? " (inactive)" : ""}; ${prModeEffects[mode]}. ${approvalFallback}`;
  }

  private addPrJob(input: InputRecord, tail: string, now: number): CronUpdate {
    const reject = (text: string): CronUpdate => ({ text, state: "cancelled" });
    const source = this.prControlSource(input.id);
    if (!source || routeKey(source.route) !== routeKey(input.route)) {
      return reject("PR intake requires a new authenticated owner command in a Discord guild parent channel.");
    }
    const request = prAddRequest(tail);
    const written = originalPrAdd(source.text);
    const schedule = request && parseCronSchedule(request.schedule, now);
    if (!request || !written || written.repository !== request.repository || written.schedule !== request.schedule
      || !schedule || schedule.kind === "once") {
      return reject('Use /cron pr-add "every 5m" OWNER/REPO with a recurring schedule.');
    }
    const { repository, schedule: scheduleText } = request;
    const state = this.state();
    const sourceKey = createHash("sha256").update(input.id).digest("hex");
    const fingerprint = createHash("sha256").update(JSON.stringify(["pr-intake", scheduleText, repository])).digest("hex");
    const prior = state.registrations[sourceKey];
    const enrollment = state.jobs.find(job => job.kind === "pr-intake" && job.repository === repository);
    if (prior) {
      return prior.fingerprint === fingerprint && enrollment?.id === prior.jobId ? { text: this.status(enrollment) }
        : reject("This owner request already registered a different cron job.");
    }
    const order = this.discordOrder(source);
    if (source.state !== "pending" || !order) return reject("PR intake requires an original Discord message or application command with a verifiable snowflake.");
    const boundary = this.store.getMeta("head:stop-boundary");
    const stop = boundary === null ? null : this.stopOrder(boundary);
    if (stop !== null && !afterDiscordOrder(order, stop)) return reject(stalePrOrder);
    if (enrollment?.kind === "pr-intake") {
      const enrolledBy = this.source(enrollment);
      if (!enrolledBy || routeKey(enrolledBy.route) !== routeKey(source.route)) {
        return reject("This repository is already reserved by its original Discord parent.");
      }
      if (!enrollment.removed) return reject(`This repository is already enrolled as ${enrollment.id}.`);
      const latest = this.prOrder(enrollment, enrolledBy.route).control;
      if (latest !== null && !afterDiscordOrder(order, latest)) return reject(stalePrOrder);
      if (latest === null && !this.repliesToPrStatus(source, enrollment, order)) return reject(unverifiedPrOrder);
    }
    // A removed enrollment is a tombstone: its original route, job identity and
    // prior per-PR receipts must not be reassigned by a fresh /cron pr-add.
    const job: CronPrJob = {
      kind: "pr-intake", id: enrollment?.id ?? randomUUID(), sourceId: enrollment?.sourceId ?? input.id, repository,
      eligibleAfter: now, epoch: input.id, schedule, nextAt: nextCronTime(schedule, now), paused: false,
      removed: false, stopBoundary: stop === null ? null : boundary, lastRunId: enrollment?.lastRunId ?? null,
      prMode: { mode: "review", sourceId: input.id },
    };
    const next = { ...state, registrations: { ...state.registrations, [sourceKey]: { jobId: job.id, fingerprint } } };
    const orderReceipt: PrOrder = { membership: order, control: order, mode: order };
    const held = boundary !== null && job.stopBoundary !== boundary
      ? `\nTo reopen this job after the HEAD stop, send /cron show ${job.id} and reply to its confirmed status with /cron resume ${job.id}.`
      : "";
    return { text: `${enrollment ? "Re-enrolled" : "Enrolled"} PR intake. ${this.status(job, "review")}${held}`,
      metadata: { ...jobMetadata(next, job), [prModeKey(input.id)]: prModeReceipt(job, "review"), [prOrderKey(job.id)]: JSON.stringify(orderReceipt) } };
  }

  private setPrMode(input: InputRecord, argument: string): CronUpdate {
    const reject = (text: string): CronUpdate => ({ text, state: "cancelled" });
    const source = this.prControlSource(input.id);
    if (source?.state !== "pending" || routeKey(source.route) !== routeKey(input.route)) {
      return reject("Changing PR intake mode requires a new authenticated owner command in its Discord guild parent channel.");
    }
    const command = parsePrModeControl(argument);
    const original = prModeArgument(source.text);
    const written = original && parsePrModeControl(original);
    if (!command || !written || command.mode !== written.mode || command.target !== written.target) {
      return reject("Use a direct /cron pr-mode JOB_OR_OWNER/REPO review|fix|merge command.");
    }
    const order = this.discordOrder(source);
    if (!order) return reject("PR intake mode requires an original Discord message or application command with a verifiable snowflake.");
    const state = this.state();
    const parent = routeKey(source.route);
    // All membership changes survive on their row, including removed jobs.
    // Taking the maximum through strict comparisons prevents catch-up inputs
    // from resolving against a different set than was known at their send.
    if (command.target === null && state.jobs.some(job => {
      if (job.kind !== "pr-intake") return false;
      const enrollment = this.store.input(job.sourceId);
      return !enrollment || routeKey(enrollment.route) === parent && !afterDiscordOrder(order, this.prOrder(job, source.route).membership);
    })) return reject("This targetless PR intake command cannot be ordered after the Discord parent's enrollment changes. Send a new command naming its job ID or OWNER/REPO.");
    const matches = state.jobs.filter(job => {
      if (job.kind !== "pr-intake" || job.removed
        || command.target !== null && command.target !== job.id && command.target !== job.repository) return false;
      const enrollment = this.source(job);
      return enrollment !== null && routeKey(enrollment.route) === parent;
    });
    const [job] = matches;
    if (job?.kind !== "pr-intake" || matches.length !== 1) {
      return reject("No unique enrolled PR intake job matches this Discord parent. Specify its job ID or OWNER/REPO.");
    }
    const latest = this.prOrder(job, source.route);
    const boundary = this.store.getMeta("head:stop-boundary");
    const stop = boundary !== job.stopBoundary && boundary !== null ? this.stopOrder(boundary) : null;
    if ([latest.control, latest.mode, stop].some(previous => previous !== null && !afterDiscordOrder(order, previous))) {
      return reject(stalePrOrder);
    }
    const needsProof = latest.control === null || job.prMode !== undefined && latest.mode === null
      || boundary !== job.stopBoundary && stop === null;
    if (needsProof && !this.repliesToPrStatus(source, job, order)) return reject(unverifiedPrOrder);
    const next = { ...job, prMode: { mode: command.mode, sourceId: source.id } };
    const orderReceipt: PrOrder = { membership: latest.membership ?? (needsProof ? order : null),
      control: latest.control ?? order, mode: order };
    return { text: `Updated PR intake mode. ${this.status(next, command.mode)}`,
      metadata: { ...jobMetadata(state, next), [prModeKey(source.id)]: prModeReceipt(job, command.mode),
        [prOrderKey(job.id)]: JSON.stringify(orderReceipt) } };
  }

  control(input: InputRecord, argument: string, now: number): CronUpdate {
    const [, action = "", tail = ""] = /^(\S+)(?:\s+([\s\S]*))?$/.exec(argument) ?? [];
    const reject = (text: string): CronUpdate => ({ text, state: "cancelled" });
    if (!action || action === "help" && !tail) return { text: usage };
    const state = this.state();
    const scoped = state.jobs.flatMap(job => {
      const source = this.source(job);
      return source && routeKey(source.route) === routeKey(input.route) ? [{ job, source }] : [];
    });
    if (action === "list" && !tail) {
      const current = scoped.filter(({ job }) => job.kind !== "pr-intake" || !job.removed);
      return { text: current.length ? current.map(({ job }) => this.status(job)).join("\n") : "No cron jobs in this conversation." };
    }
    const [, id, details = ""] = /^(\S+)(?:\s+([\s\S]*))?$/.exec(tail) ?? [];
    const found = scoped.find(({ job }) => job.id === id);
    if (action === "show" && found) {
      const { job } = found;
      if (job.kind === "pr-intake") {
        const number = details && /^[1-9]\d*$/.test(details) ? Number(details) : null;
        if (details && (number === null || !Number.isSafeInteger(number))) return reject(usage);
        const summary = `${this.status(job)}\n\n${describePrIntake(this.store, job, number)}`;
        const source = this.prControlSource(input.id);
        if (number !== null || source?.state !== "pending" || !this.discordOrder(source)
          || routeKey(source.route) !== routeKey(found.source.route)
          || originalCronArgument(source)?.split(/\s+/u).join(" ") !== `show ${job.id}`) return { text: summary };
        const boundary = this.store.getMeta("head:stop-boundary");
        const latest = this.prOrder(job, source.route);
        const stopUnordered = boundary !== null && job.stopBoundary !== boundary && this.stopOrder(boundary) === null;
        if (!stopUnordered && latest.control !== null && (!job.prMode || latest.mode !== null)) return { text: summary };
        const next = job.removed ? "the explicit /cron pr-add command for this repository"
          : `/cron resume ${job.id} to reopen it, or another explicit control naming this job`;
        return { text: `To prove this is a new control, reply directly to this status with ${next}.\n\n${summary}`,
          metadata: { [prStatusKey(source.id)]: this.prStatusReceipt(job, boundary) } };
      }
      if (!details) return { text: `${this.status(job)}\n\nPrompt:\n${job.prompt}` };
    }
    if (this.store.getMeta("head:restart-fence")) return reject("Gateway and HEAD restart is held. No cron job was changed.");
    if (!this.originalMessage(input)) {
      return reject("Send a new owner message to change a cron job; edits do not authorize changes.");
    }
    if (action === "pr-add") return this.addPrJob(input, tail, now);
    if (action === "pr-mode") return this.setPrMode(input, argument);
    const boundary = this.store.getMeta("head:stop-boundary");
    if (action === "add" || action === "create" || action === "edit") {
      if (action === "edit" && !found) return reject("No cron job with that ID in this conversation.");
      const previous = action === "edit" ? found?.job : undefined;
      if (previous?.kind === "pr-intake") return reject("PR intake jobs cannot be edited as prompt jobs. To change the schedule, remove and re-enroll it here.");
      const shellAdd = !previous && /^shell\s+/.test(tail);
      const shell = shellAdd || previous?.shell === true;
      const body = previous ? details : shellAdd ? tail.replace(/^shell\s+/, "") : tail;
      const pair = /^"([^"\r\n]+)"(?:\s+([\s\S]+))?$/.exec(body);
      const schedule = pair ? parseCronSchedule((pair[1] ?? "").trim(), now) : previous?.schedule;
      const rawPrompt = pair ? (pair[2] ? pair[2].trim() : previous?.prompt)
        : previous && /^prompt\s+/.test(body) ? body.replace(/^prompt\s+/, "").trim() : undefined;
      const prompt = rawPrompt === undefined ? undefined : shell ? rawPrompt : promptText(rawPrompt);
      if (!schedule || !prompt) return reject(`Invalid schedule or missing prompt. Recurring intervals must be at least one minute.\n${usage}`);
      // A changed command is new output territory: its first run always posts.
      const commandChanged = !previous || prompt !== previous.prompt;
      const commandRevision = shell ? (commandChanged ? input.id : shellRevision(previous)) : undefined;
      const keepHash = previous?.outputHash !== undefined && !commandChanged;
      const job: PromptJob = { id: previous?.id ?? randomUUID(), sourceId: previous?.sourceId ?? input.id,
        schedule, prompt, nextAt: pair ? nextCronTime(schedule, now) : previous?.nextAt ?? null,
        paused: previous?.paused ?? false, stopBoundary: previous ? previous.stopBoundary : boundary,
        lastRunId: previous?.lastRunId ?? null, ...(shell ? { shell: true as const, commandRevision } : {}),
        ...(keepHash ? { outputHash: previous.outputHash } : {}) };
      return { text: `${previous ? "Updated" : "Created"} cron job. ${this.status(job)}`, metadata: jobMetadata(state, job) };
    }
    if (!["show", "pause", "resume", "run", "remove", "delete"].includes(action) || !id || details) return reject(usage);
    if (!found) return reject("No cron job with that ID in this conversation.");
    const { job, source } = found;
    if (job.kind === "pr-intake" && (job.removed || !this.originalPrSource(input))) {
      return reject("No enrolled PR intake job with that ID in this Discord parent.");
    }
    let orderMetadata: Readonly<Record<string, string>> = {};
    if (job.kind === "pr-intake" && action !== "run" && action !== "show") {
      const prControl = this.prControlSource(input.id);
      const order = prControl && this.discordOrder(prControl);
      if (!order || prControl?.state !== "pending"
        || originalCronArgument(prControl)?.split(/\s+/u).join(" ") !== `${action} ${job.id}`) {
        return reject("PR intake changes require the exact original Discord command with a verifiable snowflake.");
      }
      const latest = this.prOrder(job, source.route);
      const heldByStop = action === "resume" && job.stopBoundary !== boundary;
      const stop = heldByStop && boundary !== null ? this.stopOrder(boundary) : null;
      if ([latest.control, stop].some(previous => previous !== null && !afterDiscordOrder(order, previous))) {
        return reject(stalePrOrder);
      }
      if ((latest.control === null || heldByStop && stop === null) && !this.repliesToPrStatus(prControl, job, order)) {
        return reject(unverifiedPrOrder);
      }
      const membership = action === "remove" || action === "delete" ? order : latest.membership ?? order;
      orderMetadata = { [prOrderKey(job.id)]: JSON.stringify({ ...latest, control: order, membership }) };
    }
    const last = job.lastRunId ? this.store.input(job.lastRunId) : null;
    const cancelPending = last?.state === "pending" ? { cancelPending: last.id } : {};
    if (action === "remove" || action === "delete" || action === "pause") {
      const remove = action !== "pause";
      const cancellation = cancelPending.cancelPending ? " Its queued run was cancelled." : "";
      const active = last?.state === "submitted" || last?.state === "uncertain" ? " Its submitted or uncertain run was not interrupted." : "";
      const changed = job.kind === "pr-intake" ? { ...job, paused: true, removed: remove } : { ...job, paused: true };
      return { text: `${remove ? "Removed" : "Paused"} cron job ${job.id}.${cancellation}${active}`,
        metadata: { ...jobMetadata(state, changed, remove && job.kind !== "pr-intake"), ...orderMetadata }, ...cancelPending };
    }
    if (last?.state === "uncertain" || job.lastRunId && !last) {
      return reject(`The previous cron run ${job.lastRunId} is uncertain. Inspect it and use /resolve before running again.`);
    }
    if (action === "resume") {
      if (job.nextAt === null) return reject("This one-shot has no next run. Edit the schedule or use /cron run.");
      const resuming = job.paused || job.stopBoundary !== boundary;
      const nextAt = resuming ? nextCronTime(job.schedule, now) : job.nextAt;
      const next = job.kind === "pr-intake" && resuming
        ? { ...job, paused: false, stopBoundary: boundary, nextAt, eligibleAfter: now, epoch: input.id }
        : { ...job, paused: false, stopBoundary: boundary, nextAt };
      return { text: `Resumed cron job. ${this.status(next)}`, metadata: { ...jobMetadata(state, next), ...orderMetadata } };
    }
    if (job.kind === "pr-intake" && !this.activePrEnrollment(job.id)) return reject("Resume this PR intake job before running it.");
    if (last?.state === "pending" || last?.state === "submitted") return reject(`Cron run ${last.id} is already queued or running.`);
    const run = cronRun(job, source, input.id, now);
    return { text: `Queued cron run ${run.id}. The schedule is unchanged; queued is not completed.`,
      metadata: { ...jobMetadata(state, { ...job, lastRunId: run.id }), ...runMetadata(job, run) }, run };
  }

  /** The verbatim shell job and command revision a cron run input belongs to, if any. */
  shellRun(input: InputRecord): { readonly jobId: string; readonly revision: string | null; readonly command: string } | null {
    if (!input.id.startsWith(CRON_RUN_PREFIX)) return null;
    const raw = this.store.getMeta(shellKey(input.id));
    if (!raw) return null;
    if (raw.startsWith("{")) {
      try {
        const parsed = JSON.parse(raw) as { jobId?: unknown; revision?: unknown };
        if (typeof parsed.jobId === "string") {
          return { jobId: parsed.jobId, revision: typeof parsed.revision === "string" ? parsed.revision : null, command: input.text };
        }
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
    }
    return { jobId: raw, revision: null, command: input.text };
  }

  /**
   * Decide what a finished shell run posts. Failures are always reported and
   * never touch the stored hash; empty/[SILENT]/unchanged output stays quiet.
   */
  shellOutcome(jobId: string, revision: string | null, run: CronShellResult): CronShellOutcome {
    if (run.error !== undefined || run.exitCode !== 0) {
      const detail = run.error ?? `exit code ${run.exitCode}`;
      const output = [run.stdout, run.stderr].filter(part => part.trim()).join("\n");
      return { text: `Cron shell job ${jobId} failed (${detail}).${output ? `\n${output}` : ""}`, hash: null };
    }
    if (!run.stdout.trim() || run.stdout.includes(CRON_SHELL_SILENT)) return { text: null, hash: null };
    const hash = outputHash(run.stdout);
    const job = this.state().jobs.find((job): job is PromptJob => job.id === jobId && job.kind !== "pr-intake" && job.shell === true);
    const matchesRevision = job !== undefined && (revision === null || shellRevision(job) === revision);
    if (!matchesRevision) return { text: run.stdout, hash: null };
    return job.outputHash === hash ? { text: null, hash: null } : { text: run.stdout, hash };
  }

  /** Stage the hash of a shell output pending delivery confirmation. */
  stageShellOutputHash(outputId: string, jobId: string, revision: string | null, hash: string): void {
    this.store.setMeta(shellOutputHashKey(outputId), JSON.stringify({ jobId, revision, hash }));
  }

  /** Persist a staged shell output hash only once delivery is confirmed sent for the same command revision. */
  confirmShellOutputSent(outputId: string): void {
    const raw = this.store.getMeta(shellOutputHashKey(outputId));
    if (!raw) return;
    let receipt: { jobId?: unknown; revision?: unknown; hash?: unknown };
    try { receipt = JSON.parse(raw) as { jobId?: unknown; revision?: unknown; hash?: unknown }; }
    catch (error) {
      if (error instanceof SyntaxError) return;
      throw error;
    }
    if (typeof receipt.jobId !== "string" || typeof receipt.hash !== "string") return;
    const revision = typeof receipt.revision === "string" ? receipt.revision : null;
    const state = this.state();
    const job = state.jobs.find((job): job is PromptJob => job.id === receipt.jobId && job.kind !== "pr-intake" && job.shell === true);
    if (!job || (revision !== null && shellRevision(job) !== revision)) return;
    this.store.setMeta(jobsKey, jobMetadata(state, { ...job, outputHash: receipt.hash })[jobsKey]);
  }

  poll(now: number): void {
    if (this.store.getMeta("head:restart-fence")) return;
    let state = this.state();
    const boundary = this.store.getMeta("head:stop-boundary");
    for (const job of state.jobs.filter(job => job.nextAt !== null && job.nextAt <= now)
      .sort((left, right) => (left.nextAt ?? 0) - (right.nextAt ?? 0))) {
      if (job.nextAt === null || job.paused || job.stopBoundary !== boundary || job.kind === "pr-intake" && job.removed) continue;
      const source = this.source(job);
      if (!source) continue;
      const last = job.lastRunId ? this.store.input(job.lastRunId) : null;
      if (last?.state === "uncertain" || job.lastRunId && !last) continue;
      const active = last?.state === "pending" || last?.state === "submitted";
      if (active && job.schedule.kind === "once") continue;
      const schedule = job.schedule;
      const nextAt = schedule.kind === "once" ? null : schedule.kind === "interval"
        ? job.nextAt + (Math.floor((now - job.nextAt) / schedule.milliseconds) + 1) * schedule.milliseconds
        : nextCronTime(schedule, now);
      // The durable next time advances atomically with this receipt. Use a
      // unique execution identity even if an explicit edit revisits a clock slot.
      const run = active ? null : cronRun(job, source, randomUUID(), now);
      const next = { ...job, nextAt, lastRunId: run?.id ?? job.lastRunId };
      state = { ...state, jobs: state.jobs.map(current => current.id === job.id ? next : current) };
      const committed = JSON.stringify(state);
      if (run) this.store.receive(run, "main", { [jobsKey]: committed, ...runMetadata(job, run) });
      else this.store.setMeta(jobsKey, committed);
    }
  }
}
