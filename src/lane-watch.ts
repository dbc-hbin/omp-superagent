// allow: SIZE_OK — the cursor, notice, and redacted readback use one versioned watch ledger.
import { createHash, randomUUID } from "node:crypto";
import { Type, type Static } from "@sinclair/typebox/type";
import { Value } from "@sinclair/typebox/value";
import { authorizeRoute, type Config } from "./config";
import { routeKey, type InputRecord, type Lane, type OutputRecord, type Route, type StorePort } from "./contracts";

const stateKey = "lane-watch:v1";
const noticePrefix = "lane-watch-notice:";
const outputSuffix = ":notice";
const stopKey = "head:stop-boundary";
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const laneIdSchema = Type.String({ pattern: "^[a-zA-Z0-9_-]{1,128}$" });
const commandSchema = Type.Object({
  action: Type.Union([Type.Literal("track"), Type.Literal("status"), Type.Literal("untrack")]),
  sourceId: Type.String({ minLength: 1 }),
  laneId: Type.Optional(laneIdSchema),
}, { additionalProperties: false });
export type LaneWatchCommand = Static<typeof commandSchema>;

const nullableString = Type.Union([Type.String(), Type.Null()]);
const blocked = Type.Union([Type.Literal("execution-uncertain"), Type.Literal("runtime-interrupted"), Type.Literal("kickoff-held")]);
const eventText = {
  progress: "New structured progress evidence was recorded. This is not verified acceptance.",
  waiting: "A matching native admission reported a wait. The underlying dependency's state is not independently verified.",
  completed: "The lane was recorded as completed by explicit closure.",
  failed: "A matching native execution reported an error. The lane was not marked complete; external effects may still be uncertain.",
  paused: "The lane is recorded as paused. This does not confirm its processes or services stopped.",
  reopened: "The lane was reopened. No execution or successful resume is implied.",
  cancelled: "The lane was recorded as cancelled.",
  "execution-uncertain": "Work is stalled by a submitted request with an uncertain outcome. No work was replayed.",
  "runtime-interrupted": "Work is stalled because the runtime is recorded as interrupted. Native ownership or execution may be unresolved.",
  "kickoff-held": "Work is stalled because kickoff delivery is missing, failed or uncertain.",
} as const;
const eventKind = Type.Union([
  Type.Literal("progress"), Type.Literal("waiting"), Type.Literal("completed"), Type.Literal("failed"),
  Type.Literal("paused"), Type.Literal("reopened"), Type.Literal("cancelled"), blocked,
]);
const snapshot = Type.Object({
  workState: Type.Union([Type.Literal("open"), Type.Literal("paused"), Type.Literal("completed"), Type.Literal("cancelled")]),
  runtimeState: Type.Union([Type.Literal("unloaded"), Type.Literal("starting"), Type.Literal("running"), Type.Literal("idle"), Type.Literal("interrupted")]),
  evidence: nullableString, waiting: nullableString, failure: nullableString,
  block: Type.Union([Type.Object({ kind: blocked, key: Type.String() }), Type.Null()]),
});
const held = Type.Union([Type.Literal("untracked"), Type.Literal("head-stopped"), Type.Literal("source-unavailable"), Type.Literal("target-unavailable"), Type.Null()]);
const view = Type.Object({
  laneId: laneIdSchema, sourceId: Type.String(), tracking: Type.Boolean(), held,
  workState: Type.Union([snapshot.properties.workState, Type.Null()]),
  runtimeState: Type.Union([snapshot.properties.runtimeState, Type.Null()]),
  blocked: Type.Union([blocked, Type.Null()]), events: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  lastEvents: Type.Union([Type.Array(eventKind), Type.Null()]),
});
const watchSchema = Type.Object({
  laneId: laneIdSchema, sourceId: Type.String(), routeKey: Type.String(), targetRouteKey: Type.String(),
  epoch: Type.String(), enabled: Type.Boolean(), stopBoundary: nullableString, snapshot,
  targetRejected: Type.Optional(Type.Literal(true)),
  events: Type.Integer({ minimum: 0 }), lastEvents: Type.Array(eventKind),
});
const stateSchema = Type.Object({ watches: Type.Array(watchSchema), receipts: Type.Record(Type.String(), Type.Union([view, Type.Null()])) });
const noticeSchema = Type.Object({ epoch: Type.String(), sourceId: Type.String(), events: Type.Array(eventKind, { minItems: 1 }) });
const failureSchema = Type.Object({ id: Type.String(), requestId: Type.String(), generation: Type.Integer({ minimum: 0 }) });
type Snapshot = Static<typeof snapshot>;
type EventKind = Static<typeof eventKind>;
type Watch = Static<typeof watchSchema>;
type State = Static<typeof stateSchema>;
type View = Static<typeof view>;
type ObservationScope = { readonly source: InputRecord; readonly lane: Lane };
type CrossPlatformProof = {
  readonly open: () => boolean;
  readonly check: (source: Route, target: Route) => Promise<boolean>;
};

class LaneWatchError extends Error {}

export function isLaneWatchNotice(id: string): boolean {
  return id.startsWith(noticePrefix);
}

function readNotice(store: Pick<StorePort, "getMeta">, id: string) {
  const raw = store.getMeta(id);
  if (raw === null) return null;
  const value: unknown = JSON.parse(raw);
  if (!Value.Check(noticeSchema, value)) throw new LaneWatchError("Damaged lane watch notice");
  return value;
}

/** Reply provenance only. Never use this as input ownership or action authority. */
export function laneWatchReplySource(store: Pick<StorePort, "input" | "getMeta">,
  input: InputRecord | null, outputId: string): InputRecord | null {
  if (!input || !isLaneWatchNotice(input.id) || input.target !== "main" || outputId !== `${input.id}${outputSuffix}`
    || store.getMeta(`user-source:${input.id}`) === "true") return null;
  const notice = readNotice(store, input.id);
  const original = notice && store.input(notice.sourceId);
  if (!original || isLaneWatchNotice(original.id) || store.getMeta(`user-source:${original.id}`) !== "true"
    || original.state === "cancelled" || original.state === "uncertain" || routeKey(original.route) !== routeKey(input.route)
    || original.messageId !== input.messageId || original.interactionId !== input.interactionId
    || original.invocationId !== input.invocationId) return null;
  return original;
}

function changes(before: Snapshot, after: Snapshot): EventKind[] {
  const events: EventKind[] = [];
  if (before.workState !== after.workState) {
    events.push(after.workState === "open" ? "reopened" : after.workState);
  }
  if (after.failure && before.failure !== after.failure) events.push("failed");
  if (after.workState === "open") {
    if (after.evidence && before.evidence !== after.evidence) events.push("progress");
    if (after.waiting && before.waiting !== after.waiting) events.push("waiting");
    if (after.block && before.block?.key !== after.block.key) events.push(after.block.kind);
  }
  return events;
}

/** Observe the coordination ledger without connecting to Hosts, changing lane queues, or reading transcripts. */
export class LaneWatcher {
  constructor(private readonly store: StorePort, private readonly config: Config) {}

  change(command: LaneWatchCommand): View | readonly View[] | null {
    if (!Value.Check(commandSchema, command)) throw new LaneWatchError("Invalid lane watch command");
    const source = this.source(command.sourceId);
    if (!source) throw new LaneWatchError("Lane watch requires an original authorized owner source");
    const scope = routeKey(source.route);
    const state = this.state();
    const visible = state.watches.filter(watch => watch.routeKey === scope
      && (command.laneId === undefined || watch.laneId === command.laneId));
    if (command.action === "status") {
      return command.laneId ? (visible[0] ? this.view(visible[0]) : null) : visible.map(watch => this.view(watch));
    }
    if (!command.laneId) throw new LaneWatchError("Track and untrack require a managed laneId");
    const receipt = JSON.stringify([source.id, command.action, command.laneId]);
    const previous = visible[0];
    const previousHold = previous && this.held(previous);
    if (Object.hasOwn(state.receipts, receipt)) {
      const saved = state.receipts[receipt];
      if (previous && previousHold === "target-unavailable") return this.view(previous);
      return saved && command.action === "untrack" ? this.redact(saved) : saved ?? null;
    }
    let watch: Watch | undefined;
    if (command.action === "track") {
      const lane = this.store.lane(command.laneId);
      if (!lane || !this.targetAllowed(source.route, lane.route)) throw new LaneWatchError("Lane watch requires an authorized managed lane");
      watch = previous && previousHold === null ? previous : {
        laneId: lane.id, sourceId: source.id, routeKey: scope, targetRouteKey: routeKey(lane.route),
        epoch: randomUUID(), enabled: true, stopBoundary: this.store.getMeta(stopKey), snapshot: this.snapshot(lane),
        events: previousHold === "target-unavailable" ? 0 : previous?.events ?? 0,
        lastEvents: previousHold === "target-unavailable" ? [] : previous?.lastEvents ?? [],
      };
    } else if (previous) {
      watch = { ...previous, enabled: false };
    }
    const result = watch ? this.view(watch) : null;
    this.save({
      watches: [...state.watches.filter(item => item !== previous), ...(watch ? [watch] : [])],
      receipts: { ...state.receipts, [receipt]: result },
    });
    return result;
  }

  recordFailure(input: InputRecord): void {
    if (!input.target || input.target === "main" || input.state !== "submitted" || !input.requestId || input.generation === null) return;
    this.store.setMeta(`lane-watch-failure:${input.target}`, JSON.stringify({
      id: input.id, requestId: input.requestId, generation: input.generation,
    }));
  }

  poll(now: number): void {
    for (const watch of this.state().watches) {
      const scope = this.scope(watch);
      if (scope && scope.source.route.platform === scope.lane.route.platform) this.advance(watch.epoch, now);
    }
  }

  /** Cross-platform accounts must be authenticated before the durable cursor advances. */
  async pollCrossPlatform(now: number, proof: CrossPlatformProof): Promise<boolean> {
    let notified = false;
    for (const watch of this.state().watches) {
      if (!proof.open()) break;
      const scope = this.scope(watch);
      if (!scope || scope.source.route.platform === scope.lane.route.platform
        || JSON.stringify(this.snapshot(scope.lane)) === JSON.stringify(watch.snapshot)) continue;
      let allowed: boolean;
      try { allowed = await proof.check(scope.source.route, scope.lane.route); }
      catch (error) {
        if (error instanceof Error) continue; // No trustworthy proof: leave the cursor untouched.
        throw error;
      }
      if (!proof.open()) break;
      if (!allowed) this.holdRejectedTarget(watch.sourceId, watch.laneId);
      else notified = this.advance(watch.epoch, now) || notified;
    }
    return notified;
  }

  private advance(epoch: string, now: number): boolean {
    const state = this.state();
    const watch = state.watches.find(item => item.epoch === epoch);
    const scope = watch && this.scope(watch);
    if (!watch || !scope) return false;
    const { source, lane } = scope;
    const snapshot = this.snapshot(lane);
    if (JSON.stringify(snapshot) === JSON.stringify(watch.snapshot)) return false;
    const events = changes(watch.snapshot, snapshot);
    const next = { ...watch, snapshot, events: watch.events + Number(events.length > 0),
      lastEvents: events.length ? events : watch.lastEvents };
    const updated = { ...state, watches: state.watches.map(item => item.epoch === epoch ? next : item) };
    if (!events.length) { this.save(updated); return false; }
    const id = `${noticePrefix}${watch.epoch}:${next.events}`;
    // Advance the baseline in the same transaction as durable HEAD intake.
    return this.store.receive({ id, route: source.route, messageId: source.messageId, attachments: [], receivedAt: now,
      ...(source.interactionId !== undefined ? { interactionId: source.interactionId } : {}),
      ...(source.invocationId !== undefined ? { invocationId: source.invocationId } : {}),
      text: this.noticeText(watch, events) }, "main", {
      [id]: JSON.stringify({ epoch, sourceId: source.id, events }), [stateKey]: JSON.stringify(updated),
    });
  }

  /** Settle only HEAD's informational receipt; no prompt, tool, or lane command is submitted. */
  consume(input: InputRecord): void {
    if (this.store.input(input.id)?.state !== "pending") return;
    const notice = this.notice(input);
    if (!notice) { this.store.settle(input.id, "cancelled"); return; }
    this.store.settle(input.id, "done", { id: `${input.id}${outputSuffix}`, text: this.noticeText(notice.watch, notice.events) });
  }

  deliveryScope(output: OutputRecord) {
    if (!isLaneWatchNotice(output.sourceId) || output.id !== `${output.sourceId}${outputSuffix}`) return null;
    const input = this.store.input(output.sourceId);
    const notice = input?.state === "done" ? this.notice(input) : null;
    const target = notice && this.store.lane(notice.watch.laneId);
    return notice && target && routeKey(notice.source.route) === routeKey(output.route)
      ? { source: notice.source, target } : null;
  }

  holdRejectedTarget(sourceId: string, laneId: string): void {
    const state = this.state();
    const watch = state.watches.find(item => item.sourceId === sourceId && item.laneId === laneId);
    if (watch && !watch.targetRejected) {
      this.save({ ...state, watches: state.watches.map(item => item === watch ? { ...item, targetRejected: true } : item) });
    }
  }

  private notice(input: InputRecord) {
    if (!isLaneWatchNotice(input.id) || input.target !== "main" || this.store.getMeta(`user-source:${input.id}`) === "true") return null;
    const notice = readNotice(this.store, input.id);
    if (!notice) return null;
    const watch = this.state().watches.find(item => item.epoch === notice.epoch);
    const source = watch && this.source(watch.sourceId);
    return watch && source && source.id === notice.sourceId && watch.routeKey === routeKey(input.route) && this.held(watch) === null
      ? { watch, source, events: notice.events } : null;
  }

  private noticeText(watch: Watch, events: readonly EventKind[]): string {
    return [`Lane ${watch.laneId} observation:`, ...events.map(event => eventText[event])].join("\n");
  }

  private snapshot(lane: Lane): Snapshot {
    const observation = lane.observation;
    const owner = observation && this.store.input(observation.inputId);
    const observed = owner?.target === lane.id && owner.requestId === observation?.requestId
      && owner.generation === lane.generation && observation?.generation === lane.generation
      && observation.sessionId === lane.sessionId ? observation : null;
    const evidence = observed?.lastEvidence;
    const waiting = owner?.state === "submitted" ? observed?.waiting : null;
    const rawFailure = this.store.getMeta(`lane-watch-failure:${lane.id}`);
    const failure: unknown = rawFailure === null ? null : JSON.parse(rawFailure);
    let failureKey: string | null = null;
    if (Value.Check(failureSchema, failure)) {
      const failed = this.store.input(failure.id);
      if (failed?.target === lane.id && failed.requestId === failure.requestId && failed.generation === failure.generation
        && (failed.state === "uncertain" || failed.state === "cancelled")) failureKey = digest(failure);
    }
    const uncertain = lane.workState === "open" ? this.store.inputs(lane.id, "uncertain")[0] : undefined;
    const kickoff = lane.workState === "open" ? this.store.kickoffHold(lane.id) : null;
    let block: Snapshot["block"] = null;
    if (uncertain) block = { kind: "execution-uncertain", key: digest(["execution-uncertain", uncertain.id]) };
    else if (lane.workState === "open" && lane.runtimeState === "interrupted")
      block = { kind: "runtime-interrupted", key: digest(["runtime-interrupted", lane.generation]) };
    else if (kickoff && (kickoff.state === "failed" || kickoff.state === "uncertain" || kickoff.state === "missing"))
      block = { kind: "kickoff-held", key: digest(["kickoff-held", kickoff.outputId, kickoff.state]) };
    return {
      workState: lane.workState, runtimeState: lane.runtimeState, block,
      evidence: evidence ? digest([observed?.requestId, evidence.at, evidence.kind, evidence.fingerprint]) : null,
      waiting: waiting ? digest([observed?.requestId, waiting.since, waiting.target]) : null,
      failure: failureKey,
    };
  }

  private source(id: string): InputRecord | null {
    const source = this.store.input(id);
    return source && !isLaneWatchNotice(id) && source.state !== "cancelled" && source.state !== "uncertain"
      && this.store.getMeta(`user-source:${id}`) === "true" && authorizeRoute(this.config, source.route) ? source : null;
  }

  private targetAllowed(source: Route, target: Route): boolean {
    return authorizeRoute(this.config, target) && (source.platform !== target.platform || source.accountId === target.accountId);
  }

  private scope(watch: Watch): ObservationScope | null {
    if (this.held(watch) !== null) return null;
    const source = this.source(watch.sourceId);
    const lane = this.store.lane(watch.laneId);
    return source && lane ? { source, lane } : null;
  }

  private held(watch: Watch): View["held"] {
    if (watch.targetRejected) return "target-unavailable";
    const lane = this.store.lane(watch.laneId);
    if (!lane || routeKey(lane.route) !== watch.targetRouteKey || !authorizeRoute(this.config, lane.route)) return "target-unavailable";
    if (!watch.enabled) return "untracked";
    if (watch.stopBoundary !== this.store.getMeta(stopKey)) return "head-stopped";
    const source = this.source(watch.sourceId);
    if (!source || routeKey(source.route) !== watch.routeKey) return "source-unavailable";
    if (!this.targetAllowed(source.route, lane.route)) return "target-unavailable";
    return null;
  }

  private view(watch: Watch): View {
    const held = this.held(watch);
    const view = { laneId: watch.laneId, sourceId: watch.sourceId, tracking: held === null, held,
      workState: watch.snapshot.workState, runtimeState: watch.snapshot.runtimeState, blocked: watch.snapshot.block?.kind ?? null,
      events: watch.events, lastEvents: watch.lastEvents };
    return held === "untracked" || held === "source-unavailable" || held === "target-unavailable" ? this.redact(view) : view;
  }

  private redact(view: View): View {
    return { ...view, workState: null, runtimeState: null, blocked: null, events: null, lastEvents: null };
  }

  private state(): State {
    const raw = this.store.getMeta(stateKey);
    if (raw === null) return { watches: [], receipts: {} };
    const value: unknown = JSON.parse(raw);
    if (!Value.Check(stateSchema, value)) throw new LaneWatchError("Damaged lane watch state");
    return value;
  }

  private save(state: State): void { this.store.setMeta(stateKey, JSON.stringify(state)); }
}
