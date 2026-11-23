import { createHash, randomUUID } from "node:crypto";
import { authorizeRoute, type Config } from "./config";
import { routeKey, type Inbound, type InputRecord, type StorePort } from "./contracts";
import { describeCronSchedule, nextCronTime, parseCronSchedule, type CronSchedule } from "./cron-schedule";

const jobsKey = "cron:jobs";
export const CRON_SHELL_SILENT = "[SILENT]";
const shellKey = (runId: string) => `cron-shell:${runId}`;
export const CRON_RUN_PREFIX = "cron-run:";
const usage = [
  '/cron add "every 2h" Check the build', '/cron add "in 30m" Remind me',
  '/cron add "TZ=Asia/Seoul 0 9 * * 1-5" Summarize CI',
  '/cron add shell "every 1h" df -h   (runs the command alone, no model turn; posts stdout)',
  '/cron list | show ID | pause ID | resume ID | run ID | remove ID',
  '/cron edit ID "schedule" [prompt] | /cron edit ID prompt NEW_PROMPT',
].join("\n");

interface CronJob {
  readonly id: string;
  readonly sourceId: string;
  readonly schedule: CronSchedule;
  readonly prompt: string;
  readonly nextAt: number | null;
  readonly paused: boolean;
  readonly stopBoundary: string | null;
  readonly lastRunId: string | null;
  /** The prompt is a shell command run alone; its stdout is posted verbatim. */
  readonly shell?: true;
  /** SHA-256 of the last posted shell output; the only output state kept. */
  readonly outputHash?: string;
}

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

function cronRun(job: CronJob, source: InputRecord, trigger: string, now: number): Inbound {
  return {
    id: `${CRON_RUN_PREFIX}${job.id}:${trigger}`, route: source.route, messageId: source.messageId,
    ...(source.interactionId === undefined ? {} : { interactionId: source.interactionId }),
    ...(source.invocationId === undefined ? {} : { invocationId: source.invocationId }),
    receivedAt: now, attachments: [],
    text: job.shell ? job.prompt : `Scheduled job ${job.id}. Execute only the stored owner prompt below. No interactive follow-up, delegation authority, standing approval or new schedule is implied.\n\n${job.prompt}`,
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
    return source && this.store.getMeta(`user-source:${source.id}`) === "true"
      && authorizeRoute(this.config, source.route) ? source : null;
  }

  private originalMessage(input: InputRecord): boolean {
    return input.messageId === null || !/:edit:\d+[:.]\S+$/.test(input.id)
      && this.store.firstAdmittedMessage(input.route, input.messageId)?.id === input.id;
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
    const job: CronJob = { id: randomUUID(), sourceId: input.id, schedule, prompt, nextAt,
      paused: false, stopBoundary: this.store.getMeta("head:stop-boundary"), lastRunId: null };
    // The receipt lives in the same write and survives removal of the job.
    const next = { ...state, registrations: { ...state.registrations, [sourceKey]: { jobId: job.id, fingerprint } } };
    this.store.setMeta(jobsKey, jobMetadata(next, job)[jobsKey]);
    return { id: job.id, status: "created", schedule: describeCronSchedule(schedule), nextAt: new Date(nextAt).toISOString() };
  }

  private status(job: CronJob): string {
    const last = job.lastRunId ? this.store.input(job.lastRunId)?.state ?? "missing" : "none";
    const state = last === "uncertain" || last === "missing" ? "held (reconcile the original HEAD input)"
      : job.paused ? "paused" : job.stopBoundary !== this.store.getMeta("head:stop-boundary") ? "held by HEAD stop"
      : job.nextAt === null ? "no next run" : "scheduled";
    return `${job.id} — ${state}${job.shell ? "; shell" : ""}; ${describeCronSchedule(job.schedule)}; next: ${job.nextAt === null ? "none" : new Date(job.nextAt).toISOString()}; last: ${last}${job.lastRunId ? ` (${job.lastRunId})` : ""}`;
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
      return { text: scoped.length ? scoped.map(({ job }) => this.status(job)).join("\n") : "No cron jobs in this conversation." };
    }
    const [, id, details = ""] = /^(\S+)(?:\s+([\s\S]*))?$/.exec(tail) ?? [];
    const found = scoped.find(({ job }) => job.id === id);
    if (action === "show" && found && !details) {
      return { text: `${this.status(found.job)}\n\nPrompt:\n${found.job.prompt}` };
    }
    if (this.store.getMeta("head:restart-fence")) return reject("Gateway and HEAD restart is held. No cron job was changed.");
    if (!this.originalMessage(input)) {
      return reject("Send a new owner message to change a cron job; edits do not authorize changes.");
    }
    const boundary = this.store.getMeta("head:stop-boundary");
    if (action === "add" || action === "create" || action === "edit") {
      if (action === "edit" && !found) return reject("No cron job with that ID in this conversation.");
      const previous = action === "edit" ? found?.job : undefined;
      const shellAdd = !previous && /^shell\s+/.test(tail);
      const body = previous ? details : shellAdd ? tail.replace(/^shell\s+/, "") : tail;
      const pair = /^"([^"\r\n]+)"(?:\s+([\s\S]+))?$/.exec(body);
      const schedule = pair ? parseCronSchedule((pair[1] ?? "").trim(), now) : previous?.schedule;
      const prompt = pair ? (pair[2] ? promptText(pair[2]) : previous?.prompt)
        : previous && /^prompt\s+/.test(body) ? promptText(body.replace(/^prompt\s+/, "")) : undefined;
      if (!schedule || !prompt) return reject(`Invalid schedule or missing prompt. Recurring intervals must be at least one minute.\n${usage}`);
      const shell = shellAdd || previous?.shell === true;
      // A changed command is new output territory: its first run always posts.
      const keepHash = previous?.outputHash !== undefined && prompt === previous.prompt;
      const job: CronJob = { id: previous?.id ?? randomUUID(), sourceId: previous?.sourceId ?? input.id,
        schedule, prompt, nextAt: pair ? nextCronTime(schedule, now) : previous?.nextAt ?? null,
        paused: previous?.paused ?? false, stopBoundary: previous ? previous.stopBoundary : boundary,
        lastRunId: previous?.lastRunId ?? null, ...(shell ? { shell: true as const } : {}),
        ...(keepHash ? { outputHash: previous.outputHash } : {}) };
      return { text: `${previous ? "Updated" : "Created"} cron job. ${this.status(job)}`, metadata: jobMetadata(state, job) };
    }
    if (!["show", "pause", "resume", "run", "remove", "delete"].includes(action) || !id || details) return reject(usage);
    if (!found) return reject("No cron job with that ID in this conversation.");
    const { job, source } = found;
    const last = job.lastRunId ? this.store.input(job.lastRunId) : null;
    const cancelPending = last?.state === "pending" ? { cancelPending: last.id } : {};
    if (action === "remove" || action === "delete" || action === "pause") {
      const remove = action !== "pause";
      const cancellation = cancelPending.cancelPending ? " Its queued run was cancelled." : "";
      const active = last?.state === "submitted" || last?.state === "uncertain" ? " Its submitted or uncertain run was not interrupted." : "";
      return { text: `${remove ? "Removed" : "Paused"} cron job ${job.id}.${cancellation}${active}`,
        metadata: jobMetadata(state, { ...job, paused: true }, remove), ...cancelPending };
    }
    if (last?.state === "uncertain" || job.lastRunId && !last) {
      return reject(`The previous cron run ${job.lastRunId} is uncertain. Inspect it and use /resolve before running again.`);
    }
    if (action === "resume") {
      if (job.nextAt === null) return reject("This one-shot has no next run. Edit the schedule or use /cron run.");
      const nextAt = job.paused || job.stopBoundary !== boundary ? nextCronTime(job.schedule, now) : job.nextAt;
      const next = { ...job, paused: false, stopBoundary: boundary, nextAt };
      return { text: `Resumed cron job. ${this.status(next)}`, metadata: jobMetadata(state, next) };
    }
    if (last?.state === "pending" || last?.state === "submitted") return reject(`Cron run ${last.id} is already queued or running.`);
    const run = cronRun(job, source, input.id, now);
    return { text: `Queued cron run ${run.id}. The schedule is unchanged; queued is not completed.`,
      metadata: { ...jobMetadata(state, { ...job, lastRunId: run.id }), ...(job.shell ? { [shellKey(run.id)]: job.id } : {}) }, run };
  }

  /** The verbatim shell job a cron run input belongs to, if any. */
  shellRun(input: InputRecord): { readonly jobId: string; readonly command: string } | null {
    if (!input.id.startsWith(CRON_RUN_PREFIX)) return null;
    const jobId = this.store.getMeta(shellKey(input.id));
    return jobId ? { jobId, command: input.text } : null;
  }

  /**
   * Decide what a finished shell run posts. Failures are always reported and
   * never touch the stored hash; empty/[SILENT]/unchanged output stays quiet.
   */
  shellOutcome(jobId: string, run: CronShellResult): CronShellOutcome {
    if (run.error !== undefined || run.exitCode !== 0) {
      const detail = run.error ?? `exit code ${run.exitCode}`;
      const output = [run.stdout, run.stderr].filter(part => part.trim()).join("\n");
      return { text: `Cron shell job ${jobId} failed (${detail}).${output ? `\n${output}` : ""}`, hash: null };
    }
    if (!run.stdout.trim() || run.stdout.includes(CRON_SHELL_SILENT)) return { text: null, hash: null };
    const hash = outputHash(run.stdout);
    const job = this.state().jobs.find(job => job.id === jobId);
    return job?.outputHash === hash ? { text: null, hash: null } : { text: run.stdout, hash };
  }

  /** Persist the hash of an output that was queued for posting. */
  recordShellHash(jobId: string, hash: string): void {
    const state = this.state();
    const job = state.jobs.find(job => job.id === jobId);
    if (job) this.store.setMeta(jobsKey, jobMetadata(state, { ...job, outputHash: hash })[jobsKey]);
  }

  poll(now: number): void {
    let state = this.state();
    const boundary = this.store.getMeta("head:stop-boundary");
    for (const job of state.jobs.filter(job => job.nextAt !== null && job.nextAt <= now)
      .sort((left, right) => (left.nextAt ?? 0) - (right.nextAt ?? 0))) {
      if (job.nextAt === null || job.paused || job.stopBoundary !== boundary) continue;
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
      if (run) this.store.receive(run, "main", { [jobsKey]: committed, ...(job.shell ? { [shellKey(run.id)]: job.id } : {}) });
      else this.store.setMeta(jobsKey, committed);
    }
  }
}
