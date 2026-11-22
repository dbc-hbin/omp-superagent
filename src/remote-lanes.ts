import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { authorizeRoute, type Config } from "./config";
import { routeKey, type InputRecord, type Lane, type Route, type StorePort, type WorkerPlacement } from "./contracts";
import { isLaneModel } from "./lane-models";
import { assistantText, record } from "./native-values";
import type { RuntimeState } from "./runtime";
import { activeManagedUlwRevision, MANAGED_ULW_FIXTURE_ROOT_ENV, packManagedUlwRevision } from "./managed-ulw";
import type { remoteCapability, remoteProvision } from "./remote-worker";
import { workerPackage, type WorkerCapability } from "./remote-worker-wire";
import { laneModelArgument } from "./lane-models";
import type { LaneModel } from "./contracts";

export interface RemoteContext {
  readonly config: Config;
  readonly store: StorePort;
}
export interface RemoteJournalOwner {
  readonly cursor: string | null;
  readonly leaf: string | null;
  readonly promptHash: string;
}
/** The part of a resident lane that admission recovery rebuilds; the runtime owns the rest. */
export interface RemoteRecoveryTarget {
  readonly id: string;
  input?: InputRecord;
  remoteRecovery?: Map<string, RemoteJournalOwner>;
  readonly admitted: Map<string, { input: InputRecord }>;
}

export function workerInstance(store: Pick<StorePort, "getMeta" | "setMeta">): string {
  const saved = store.getMeta("worker:instance");
  if (saved) return saved;
  const id = randomUUID();
  store.setMeta("worker:instance", id);
  return id;
}

export function placement(config: Config, worker?: string): WorkerPlacement | undefined {
  if (worker === undefined) return undefined;
  const workers = config.workers;
  if (!workers || !Object.hasOwn(workers, worker)) throw new Error("Worker is not configured on this HEAD");
  const { destination, workerId } = workers[worker]!;
  return { worker, destination, workerId };
}

export function requireWorkerSource(store: StorePort, source: InputRecord): void {
  if (store.getMeta(`user-source:${source.id}`) !== "true" || source.state === "uncertain" || source.state === "cancelled")
    throw new Error("Dispatch to a worker requires the original authorized user input, not an internal report or unresolved source");
}

export function pinned(config: Config, lanePlacement: WorkerPlacement): WorkerPlacement {
  if (!isDeepStrictEqual(placement(config, lanePlacement.worker), lanePlacement))
    throw new Error("Configured worker no longer matches the lane's original placement");
  return lanePlacement;
}

export function mayBeResident(lane: Lane): boolean {
  return lane.pid !== null || (lane.placement
    ? lane.generation > 0 && lane.runtimeState !== "unloaded" : existsSync(lane.socketPath));
}

export function remoteAdmissionIdentity(lane: Lane, state: RuntimeState) {
  return {
    placement: lane.placement, generation: lane.generation, sessionId: state.sessionId,
    sessionFile: state.sessionFile ?? null, hostPid: state.hostPid ?? null, instanceKey: record(state).instanceKey ?? null,
    nativeGeneration: record(state).generation ?? null, settingsScope: state.settingsScope ?? null,
    model: isLaneModel(state.model) ? { provider: state.model.provider, id: state.model.id } : null,
    thinkingLevel: state.thinkingLevel ?? null, modelSettings: state.modelSettings ?? null,
  };
}

export function remoteAdmissionRoute(store: StorePort, source: InputRecord, route: Route) {
  return {
    route: routeKey(route), sourceId: source.id, sourceRoute: routeKey(source.route),
    delivery: store.getMeta(`head-delivery:${source.id}`),
  };
}

function readRemoteBinding(store: StorePort, inputId: string, kind: "journal" | "goal"): Record<string, unknown> | null {
  const saved = store.getMeta(`remote-${kind}-owner:${inputId}`);
  if (saved === null) return null;
  try { return record(JSON.parse(saved)); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return {}; // Invalid binding is distinct from a pre-binding admission.
  }
}

function remoteAdmissionOwner(ctx: RemoteContext, input: InputRecord, identity: ReturnType<typeof remoteAdmissionIdentity>, kind: "journal" | "goal") {
  const owner = readRemoteBinding(ctx.store, input.id, kind);
  if (!owner || !input.requestId || input.generation !== identity.generation) return null;
  const source = ctx.store.input(ctx.store.getMeta(`handoff-source:${input.id}`) ?? input.id);
  if (owner.requestId !== input.requestId || !source || source.state === "cancelled"
    || source.id !== input.id && source.state === "uncertain"
    || !authorizeRoute(ctx.config, input.route) || !authorizeRoute(ctx.config, source.route)
    || kind === "goal" && ctx.store.getMeta(`user-source:${source.id}`) !== "true"
    || !isDeepStrictEqual(owner.identity, identity)) return null;
  const route = remoteAdmissionRoute(ctx.store, source, input.route);
  if (owner.route !== route.route || owner.sourceId !== route.sourceId
    || owner.sourceRoute !== route.sourceRoute || owner.delivery !== route.delivery) return null;
  return owner;
}

export function remoteJournalOwner(ctx: RemoteContext, input: InputRecord, lane: Lane, state: RuntimeState): RemoteJournalOwner | null {
  const owner = remoteAdmissionOwner(ctx, input, remoteAdmissionIdentity(lane, state), "journal");
  if (!owner || owner.cursor !== null && (typeof owner.cursor !== "string" || !owner.cursor)
    || owner.leaf !== null && (typeof owner.leaf !== "string" || !owner.leaf)
    || typeof owner.promptHash !== "string" || !/^[a-f0-9]{64}$/.test(owner.promptHash)) return null;
  return { cursor: owner.cursor, leaf: owner.leaf, promptHash: owner.promptHash };
}

export function isRemoteGoalResume(store: StorePort, input: InputRecord, laneId: string): boolean {
  const sourceId = store.getMeta(`handoff-source:${input.id}`);
  return store.getMeta(`remote-goal-owner:${input.id}`) !== null
    || !!sourceId && input.id === `resume:${sourceId}:${laneId}`;
}

export function remoteGoalOwner(ctx: RemoteContext, input: InputRecord, lane: Lane, state: RuntimeState): boolean {
  const owner = remoteAdmissionOwner(ctx, input, remoteAdmissionIdentity(lane, state), "goal");
  return lane.workState === "paused" && routeKey(input.route) === routeKey(lane.route)
    && typeof owner?.goalId === "string" && owner.goalId === state.goal?.goal?.id;
}

export function restoreRemoteAdmissions(ctx: RemoteContext, live: RemoteRecoveryTarget, lane: Lane, state: RuntimeState): void {
  if (!lane.placement) return;
  if (lane.workState !== "open") {
    // A paused attachment exists only to interrupt native work. Preserve
    // submitted ownership for that readback, never reclassify old uncertainty.
    live.remoteRecovery = undefined;
    live.input = undefined;
    live.admitted.clear();
    for (const input of ctx.store.inputs(live.id, "submitted")) {
      if (isRemoteGoalResume(ctx.store, input, live.id)) {
        if (input.requestId && remoteGoalOwner(ctx, input, lane, state)) live.admitted.set(input.requestId, { input });
        else uncertainRemoteAdmission(ctx, input);
      } else if (input.requestId && remoteJournalOwner(ctx, input, lane, state)) live.admitted.set(input.requestId, { input });
    }
    return;
  }
  const active = ctx.store.inputs(live.id).filter(input => input.state === "submitted" || input.state === "uncertain");
  const first = active[0];
  if (first) {
    const rootId = ctx.store.getMeta(`steering-owner:${first.id}`);
    const root = rootId ? ctx.store.input(rootId) : null;
    const savedMembers = root ? ctx.store.getMeta(`remote-journal-members:${root.id}`) : null;
    const members: unknown = savedMembers ? JSON.parse(savedMembers) : [];
    const inputs = [...active];
    if (Array.isArray(members)) for (const member of members) {
      if (typeof member !== "string" || inputs.some(input => input.id === member)) continue;
      const finished = ctx.store.input(member);
      if (finished?.requestId && finished.target === live.id) inputs.push(finished);
    }
    // The root bounds the entire run even if a completed steer was recorded
    // immediately before the head stopped.
    inputs.sort((a, b) => a.id === rootId ? -1 : b.id === rootId ? 1 : 0);
    const owners = new Map<string, RemoteJournalOwner>();
    for (const input of inputs) {
      const owner = remoteJournalOwner(ctx, input, lane, state);
      if (!owner || !input.requestId || owners.has(input.requestId)
        || ctx.store.getMeta(`steering-owner:${input.id}`) !== root?.id) break;
      owners.set(input.requestId, owner);
    }
    if (root && (root.state === "submitted" || root.state === "uncertain") && owners.size === inputs.length) {
      live.input = root;
      live.remoteRecovery = owners;
      live.admitted.clear();
      for (const input of inputs) if (input.requestId) live.admitted.set(input.requestId, { input: input.id === root.id ? root : input });
      return;
    }
  }
  for (const input of active) uncertainRemoteAdmission(ctx, input);
  if (active.length) {
    live.remoteRecovery = undefined;
    live.input = undefined;
    live.admitted.clear();
  }
}

export function uncertainRemoteAdmission(ctx: RemoteContext, input: InputRecord): void {
  const rootId = ctx.store.getMeta(`steering-owner:${input.id}`);
  const source = ctx.store.input(ctx.store.getMeta(`handoff-source:${input.id}`) ?? input.id);
  const owner = readRemoteBinding(ctx.store, input.id, input.target && isRemoteGoalResume(ctx.store, input, input.target) ? "goal" : "journal");
  ctx.store.settle(input.id, "uncertain", (!rootId || rootId === input.id) && source && source.state !== "cancelled"
    && authorizeRoute(ctx.config, source.route) && authorizeRoute(ctx.config, input.route)
    && (!owner || owner.sourceId === source.id && owner.sourceRoute === routeKey(source.route) && owner.route === routeKey(input.route)
      && owner.delivery === ctx.store.getMeta(`head-delivery:${source.id}`)) ? {
    id: `${input.id}:remote-interrupted`,
    text: "원래 원격 세션에서 이 요청의 완료를 확인할 수 없습니다. 실행을 반복하지 않았습니다. 원래 세션을 확인해 주세요.",
  } : undefined);
}

export function remoteTerminal(entries: unknown[], owners: ReadonlyMap<string, RemoteJournalOwner>, state: RuntimeState) {
  const root = owners.values().next().value;
  if (!root) return null;
  const journal = entries.map(record);
  const positions = new Map<string, number>();
  if (root.cursor !== null) positions.set(root.cursor, -1);
  let parent = root.leaf;
  let start: Record<string, unknown> | undefined;
  let startIndex = -1;
  let assistant: Record<string, unknown> | undefined;
  let assistantIndex = -1;
  const requests = new Map([...owners].map(([requestId, owner]) => [owner.promptHash, requestId]));
  const users = new Map<string, number>();
  const receipts = new Map<string, { index: number; status: "completed" | "aborted" | "error"; agentInvoked: boolean; ordinal: number }>();
  let boundary: number | undefined;
  for (const [index, entry] of journal.entries()) {
    if (typeof entry.id !== "string" || !entry.id || positions.has(entry.id) || entry.parentId !== parent) return null;
    positions.set(entry.id, index);
    parent = entry.id;
    if (entry.type === "custom" && (entry.customType === "rpc_agent_start" || entry.customType === "rpc_prompt_result")) {
      const data = record(entry.data);
      if (data.sessionId !== state.sessionId || data.sessionFile !== state.sessionFile
        || data.hostPid !== state.hostPid || data.instanceKey !== record(state).instanceKey
        || typeof data.runOrdinal !== "number" || !Number.isSafeInteger(data.runOrdinal) || data.runOrdinal < 0) return null;
      if (entry.customType === "rpc_agent_start") {
        // Native starts have a run identity, not a request ID. A second run
        // might be a continuation or external work; do not guess which.
        if (start) return null;
        start = data;
        startIndex = index;
      } else {
        const frame = record(data.frame);
        if (typeof frame.id !== "string" || !owners.has(frame.id) || receipts.has(frame.id)
          || typeof frame.agentInvoked !== "boolean"
          || (frame.status !== "completed" && frame.status !== "aborted" && frame.status !== "error")) return null;
        receipts.set(frame.id, { index, status: frame.status, agentInvoked: frame.agentInvoked, ordinal: data.runOrdinal });
        // Native prompt_result can be a yield. Only a receipt that says the
        // session settled can close an invoked run (the owner also journals
        // synchronous no-agent commands, which have no settle flag).
        if (receipts.size === owners.size && (frame.sessionSettled === true || !start && frame.agentInvoked === false)) {
          boundary = index;
          break;
        }
      }
    }
    if (entry.type !== "message") continue;
    const message = record(entry.message);
    if (message.role === "user") {
      const content = typeof message.content === "string" ? message.content : Array.isArray(message.content)
        ? message.content.map(record).filter(part => part.type === "text" && typeof part.text === "string").map(part => part.text).join("")
        : "";
      const matches = [...content.matchAll(/^(`{3,})superagent-runtime-context\nRequest ID: [^\n]+\n[\s\S]*?^\1$/gm)]
        .map(match => requests.get(createHash("sha256").update(match[0]).digest("hex"))).filter(id => id !== undefined);
      const requestId = matches[0];
      if (!requestId || matches.length !== 1 || users.has(requestId)) return null;
      users.set(requestId, index);
    } else if (message.role === "assistant") {
      if (!start) return null;
      assistant = message;
      assistantIndex = index;
    }
  }
  if (boundary === undefined || journal.slice(boundary + 1).some(entry =>
    entry.type === "custom" && entry.customType === "rpc_prompt_result"
    && receipts.has(String(record(record(entry.data).frame).id)))) return null;
  const results = new Map<string, { status: "completed" | "aborted" | "error"; agentInvoked: boolean }>();
  for (const [requestId, owner] of owners) {
    const receipt = receipts.get(requestId);
    const cursor = owner.cursor === null && root.cursor === null ? -1 : owner.cursor === null ? undefined : positions.get(owner.cursor);
    if (!receipt || cursor === undefined || receipt.index <= cursor) return null;
    if (owner.leaf !== (cursor < 0 ? root.leaf : journal[cursor]?.id)) return null;
    const user = users.get(requestId);
    const { status, agentInvoked } = receipt;
    if (agentInvoked && start) {
      if (user === undefined || user <= cursor || user >= receipt.index || receipt.index <= startIndex
        || receipt.ordinal !== start.runOrdinal || assistantIndex >= receipt.index) return null;
    } else if (user !== undefined || agentInvoked && status === "completed") return null;
    if (status === "completed" && agentInvoked && assistant?.stopReason !== "stop" && assistant?.stopReason !== "length") return null;
    results.set(requestId, { status, agentInvoked });
  }
  if (start && !users.size) return null;
  const rootUser = users.get(owners.keys().next().value ?? "");
  return {
    results, text: assistantText(assistant) ?? "",
    observations: start && rootUser !== undefined ? journal.slice(Math.max(startIndex, rootUser) + 1, boundary) : []
  };
}

/** The SDK-matched OMP release this package is tested against; older workers are refused. */
export const MINIMUM_WORKER_OMP: string = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as
  { dependencies: Record<string, string> }).dependencies["@oh-my-pi/pi-coding-agent"]!;
const CLOCK_SKEW_LIMIT_MS = 120_000;

export function requireCompatibleWorker(capability: WorkerCapability, now = Date.now()): void {
  if (capability.platform !== "linux" && capability.platform !== "darwin") {
    throw new Error(`Worker platform ${capability.platform} is not supported; workers run on Linux or macOS`);
  }
  const local = workerPackage();
  if (capability.package.version !== local.version || capability.package.digest !== local.digest) {
    throw new Error(`Worker runs omp-superagent ${capability.package.version} (${capability.package.digest.slice(0, 12)}), `
      + `HEAD runs ${local.version} (${local.digest.slice(0, 12)}); install HEAD's exact release on the worker before launching`);
  }
  if (Bun.semver.order(capability.omp, MINIMUM_WORKER_OMP) < 0) {
    throw new Error(`Worker OMP ${capability.omp} is older than the required ${MINIMUM_WORKER_OMP}`);
  }
  // Remote observation timestamps come from the worker clock.
  if (Math.abs(capability.clock - now) > CLOCK_SKEW_LIMIT_MS) {
    throw new Error("Worker clock differs from HEAD by more than two minutes; fix time synchronization before launching");
  }
}

export function requireWorkerModel(capability: WorkerCapability, model: LaneModel): void {
  if (!capability.models.includes(laneModelArgument(model))) {
    throw new Error(`Selected lane model ${laneModelArgument(model)} is not available from the worker's own OMP configuration and auth`);
  }
}

export interface WorkerPreparation {
  readonly remoteCapability: typeof remoteCapability;
  readonly remoteProvision: typeof remoteProvision;
}

/**
 * Before every remote launch: verify the worker's package, OMP and clock, then
 * pin HEAD's active omp-superkit revision there (shipping HEAD's immutable
 * package when the worker differs). Returns the revision the Host must load,
 * or null for an operator-declared plain worker. Failures refuse the launch.
 */
export async function prepareWorkerLaunch(context: RemoteContext, adapters: WorkerPreparation,
  lanePlacement: WorkerPlacement): Promise<string | null> {
  const instance = workerInstance(context.store);
  const capability = await adapters.remoteCapability(lanePlacement, instance);
  requireCompatibleWorker(capability);
  if (context.config.workers?.[lanePlacement.worker]?.superkit === "none") return null;
  // Same installation a local lane would launch from right now.
  const root = process.env[MANAGED_ULW_FIXTURE_ROOT_ENV];
  const options = root ? { root } : {};
  const { revision } = activeManagedUlwRevision(options);
  if (capability.superkit !== revision) {
    const pack = await packManagedUlwRevision(options);
    if (pack.provenance.revision !== revision) throw new Error("HEAD omp-superkit changed while preparing the worker; retry the launch");
    await adapters.remoteProvision(lanePlacement, instance, pack);
  }
  return revision;
}
