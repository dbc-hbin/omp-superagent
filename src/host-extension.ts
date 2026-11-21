import * as fs from "node:fs/promises";
import { realpathSync } from "node:fs";
import * as net from "node:net";
import { isDeepStrictEqual } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { UnitScope } from "@oh-my-pi/pi-coding-agent/daemon/protocol";
import { cfgDefaultThinkingLevel } from "@oh-my-pi/pi-coding-agent/session/settings";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { lookup as lookupSetting } from "@oh-my-pi/pi-coding-agent/config/registry";
import { pickDefaultAvailableModel, resolveModelRoleValue } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { resolveThinkingLevelForModel } from "@oh-my-pi/pi-tui/thinking";
import { parseSessionEntries, readSessionHeaderId } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { HostChannel, indexServiceCompletions, serviceGenerationKey, type Frame, type ServiceUnit } from "./host-protocol";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { fitAbortAndRestoreQueueResponse } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import type { RpcAbortAndRestoreQueueResult, RpcSessionState } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { calculateTokensPerSecond } from "@oh-my-pi/pi-coding-agent/utils/token-rate";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import type { LanePresetSnapshot } from "./contracts";
import { HEAD_ROTATION_GUARD, HEAD_ROTATION_PROBE, type RotationGuardEvent,
  type RotationNative, type RotationProbeEvent } from "./head-rotation";

const terminalService = (state: ServiceUnit["state"]) => state === "exited" || state === "failed";
const serviceGeneration = ({ owner, id, generation, startedAt, restartCount }: ServiceUnit) =>
  ({ owner, id, generation, startedAt, restartCount });
const serviceName = (value: unknown) => typeof value === "string" ? value.trim() || undefined : undefined;
const serviceOwner = ({ agent, sessionManager }: ExtensionContext) => {
  const id = sessionManager.getSessionId();
  return agent.kind === "sub" && agent.id === "advisor" ? `${id}-advisor` : id;
};

/** Match the running CLI's own RPC settlement predicate (old and new SDK surface). */
function pendingNativeWake(session: { readonly wakeSources?: unknown; readonly hasPendingAsyncWork?: () => boolean }): boolean {
  if ("wakeSources" in session) return session.wakeSources !== undefined;
  if (typeof session.hasPendingAsyncWork === "function") return session.hasPendingAsyncWork();
  throw new Error("Installed OMP cannot observe pending native async work");
}

// Root and subagent extension factories in one native process share this pipe owner.
let ownerChannel: HostChannel | undefined;
const serviceReservations = new Set<string>();
async function observeServices(scope?: UnitScope, name?: string): Promise<ServiceUnit[]> {
  if (!ownerChannel || scope && scope.kind !== "project") throw new Error("No native service observation channel");
  const response = await ownerChannel.request({ type: "list_service_units", projectDir: scope?.dir, serviceName: name });
  const data = response.data as { units?: ServiceUnit[] } | undefined;
  if (!response.success || !Array.isArray(data?.units)) throw new Error("Native service ownership is unavailable");
  return data.units;
}

/** Runs inside the installed native host. All native objects come from injected pi.pi. */
export default function hostExtension(pi: ExtensionAPI): void {
  const socketPath = process.env.OMP_SUPERAGENT_NATIVE_SOCKET;
  const configPath = process.env.OMP_SUPERAGENT_HOST_CONFIG;
  if (!socketPath || !configPath) return;
  const goalEnabled = lookupSetting("goal.enabled");
  if (!goalEnabled) throw new Error("Installed OMP lacks the public goal.enabled setting");
  let context: ExtensionContext | undefined;
  let server: net.Server | undefined;
  let mutationHeld = false;
  let observationHeld = false;
  let runOrdinal = 0;
  let instanceKey: string | undefined;
  type ServiceStart = {
    readonly name: string; readonly scope: UnitScope; readonly owner: string;
    readonly sessionId: string; readonly toolCallId: string;
    readonly previousIds: ReadonlySet<string>; readonly reservation: string;
  };
  const serviceStarts = new Map<string, ServiceStart>();
  const interrupts = new Map<string, Promise<PromiseSettledResult<void>[]>>();
  const rootSession = () => {
    const root = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID)?.session;
    if (!(root instanceof pi.pi.AgentSession)) throw new Error("Native root session is unavailable");
    return root;
  };
  const serviceObservation = (data: Frame) => {
    const root = rootSession();
    root.sessionManager.appendCustomEntry("superagent_service_generation", {
      rootSessionId: root.sessionManager.getSessionId(), ...data,
    });
    root.sessionManager.flushSync();
  };
  const releaseServiceStart = (key: string, start: ServiceStart) => {
    if (serviceStarts.get(key) !== start) return;
    serviceStarts.delete(key);
    serviceReservations.delete(start.reservation);
  };
  const finishWithoutServiceResult = (key: string, noLaunch?: "approval_denied" | "not_dispatched") => {
    const start = serviceStarts.get(key);
    if (!start) return;
    try {
      // An unclassified terminal result ends the in-process reservation but
      // remains durably unknown, never "not launched".
      serviceObservation({ phase: "result", toolCallId: start.toolCallId, owner: start.owner, name: start.name,
        ...(noLaunch ? { notLaunched: noLaunch } : { uncertain: true }) });
    } finally { releaseServiceStart(key, start); }
  };
  // Registry slots differ between the standalone executable and npm SDK.
  // Mirror native layers into this SDK before using any imported setting handle.
  const readOnly = (settings: Settings): Settings => {
    const parent = settings.overlayParent();
    return Settings.mirror({
      write() { throw new Error("Native settings observation is read-only"); },
      refresh() { throw new Error("Native settings observation is read-only"); },
      cloneForCwd() { throw new Error("Native settings observation is read-only"); },
    }, settings.mirrorState(), parent ? readOnly(parent) : undefined);
  };
  const exact = () => {
    const ref = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID);
    const session = ref?.session;
    if (!ref || !context || !(session instanceof pi.pi.AgentSession)
      || session.sessionManager.getSessionId() !== context.sessionManager.getSessionId()
      || session.sessionManager.getSessionFile() !== context.sessionManager.getSessionFile())
      throw new Error("Exact native session ownership is unavailable");
    if (typeof session.hasAdmittedSubmission !== "boolean" || typeof session.hasPostPromptWork !== "boolean"
      || typeof session.isBusyForSnapshot !== "boolean" || typeof session.isStreaming !== "boolean"
      || typeof session.isCompacting !== "boolean" || typeof session.isDisposed !== "boolean"
      || !Number.isSafeInteger(session.queuedMessageCount) || session.queuedMessageCount < 0
      || typeof session.instanceKey !== "string" || !session.instanceKey
      || typeof session.getAsyncJobTree !== "function"
      || typeof session.getAsyncJobSnapshot !== "function" || typeof session.beginDispose !== "function"
      || typeof session.abortCompaction !== "function" || typeof session.goalRuntime.pauseGoal !== "function"
      || typeof session.waitForIdle !== "function" || typeof session.yieldQueue?.has !== "function"
      || typeof session.sessionManager.ensureOnDisk !== "function" || typeof session.sessionManager.flushSync !== "function"
      || typeof session.sessionManager.getLeafId !== "function"
      || typeof session.settings.reloadFromDisk !== "function" || typeof session.settings.mirrorState !== "function"
      || typeof session.settings.getModelRoles !== "function")
      throw new Error("Installed OMP lacks required public native lifecycle capabilities");
    if (instanceKey !== undefined && session.instanceKey !== instanceKey)
      throw new Error("Native session instance changed within this managed Host");
    instanceKey ??= session.instanceKey;
    return { ref, session, id: session.sessionManager.getSessionId(), file: session.sessionManager.getSessionFile() };
  };
  const ownerIdentity = ({ id, file, ref, session }: ReturnType<typeof exact>) => ({
    hostPid: process.pid, sessionId: id, sessionFile: file, generation: ref.generation, instanceKey: session.instanceKey,
  });
  const snapshot = () => {
    const { session } = exact();
    return { modelRoles: session.settings.getModelRoles(),
      defaultThinkingLevel: cfgDefaultThinkingLevel.get(readOnly(session.settings)) };
  };
  type NativeSession = InstanceType<typeof pi.pi.AgentSession>;
  // The view is live: callers only inspect it synchronously, before appending
  // or yielding. Older supported CLIs may expose only the copying API.
  const entries = (manager: NativeSession["sessionManager"]) =>
    typeof manager.getEntriesView === "function" ? manager.getEntriesView() : manager.getEntries();
  const observation = (customType: string, data: Frame) => {
    const { session, id, file } = exact();
    try {
      pi.appendEntry(customType, { ...data, sessionId: id, sessionFile: file, instanceKey: session.instanceKey });
      session.sessionManager.flushSync();
      const entry = entries(session.sessionManager).at(-1);
      if (entry?.type !== "custom" || entry.customType !== customType)
        throw new Error("Native observation entry identity is unavailable");
      return entry.id;
    } catch (error) { observationHeld = true; throw error; }
  };
  const owned = async (drain = false) => {
    const identity = exact();
    const registry = pi.pi.AgentRegistry.global();
    const refs = registry.list();
    const refEpoch = refs.map(ref => [ref.id, ref.generation, ref.parentId, ref.session?.instanceKey, ref.sessionFile]);
    const lineage: { readonly agentId: string; readonly sessionId: string; readonly sessionFile: unknown }[] = [];
    const recordedAgents = new Set<string>();
    const children = new Map<string, string[]>();
    const link = (parent: string, child: string) => {
      const siblings = children.get(parent);
      if (siblings) siblings.push(child);
      else children.set(parent, [child]);
    };
    for (const ref of refs) if (ref.parentId) link(ref.parentId, ref.id);
    const attempts: Frame[] = [];
    const results = new Map<unknown, Set<unknown>>();
    const previousGenerations: (readonly unknown[])[] = [];
    const tracked = new Map<string, Frame>();
    const trackedOwners = new Set<string>();
    let trackingSeen = false;
    let journalUnknown = false;
    for (const entry of entries(identity.session.sessionManager)) {
      if (entry.type !== "custom") continue;
      const data = entry.data as Frame | undefined;
      if (data?.rootSessionId !== identity.id) continue;
      if (entry.customType === "superagent_native_descendant") {
        const { agentId, parentId, sessionId, sessionFile } = data;
        if (typeof agentId !== "string" || typeof parentId !== "string" || typeof sessionId !== "string") continue;
        lineage.push({ agentId, sessionId, sessionFile });
        recordedAgents.add(agentId);
        link(parentId, agentId);
      } else if (entry.customType === "superagent_service_tracking") {
        trackingSeen = true;
        if (data.known !== true) journalUnknown = true;
      } else if (entry.customType === "superagent_service_generation") {
        if (data.uncertain === true) journalUnknown = true;
        if (data.phase === "attempt") attempts.push(data);
        if (data.phase === "result" && !Number.isNaN(data.owner) && !Number.isNaN(data.toolCallId)) {
          const calls = results.get(data.owner);
          if (calls) calls.add(data.toolCallId);
          else results.set(data.owner, new Set([data.toolCallId]));
        }
        if (Array.isArray(data.previous)) previousGenerations.push(data.previous);
        if (data.daemon && typeof data.daemon === "object") {
          const daemon = data.daemon as Frame;
          const key = serviceGenerationKey(daemon);
          if (tracked.has(key)) journalUnknown = true;
          tracked.set(key, daemon);
          if (typeof daemon.owner === "string") trackedOwners.add(daemon.owner);
        }
      }
    }
    const agents = new Set([pi.pi.MAIN_AGENT_ID]);
    // Sets visit entries added during iteration, so each reachable agent is expanded once.
    for (const id of agents) for (const child of children.get(id) ?? []) agents.add(child);
    const owners = new Set<string>([identity.id]);
    const ownerFiles = new Map<string, string>();
    if (identity.file) ownerFiles.set(identity.id, identity.file);
    for (const ref of refs) if (agents.has(ref.id) && ref.session) {
      const id = ref.session.sessionManager.getSessionId();
      owners.add(id);
      const file = ref.session.sessionManager.getSessionFile();
      if (file) ownerFiles.set(id, file);
    }
    for (const row of lineage) if (agents.has(row.agentId)) {
      owners.add(row.sessionId);
      if (typeof row.sessionFile === "string") ownerFiles.set(row.sessionId, row.sessionFile);
    }
    for (const ref of refs) if (agents.has(ref.id) && !ref.session
      && !recordedAgents.has(ref.id)) {
      if (!ref.sessionFile) throw new Error("Detached descendant service ownership cannot be established");
      const id = await readSessionHeaderId(ref.sessionFile);
      if (!id) throw new Error("Detached descendant session identity is unavailable");
      owners.add(id);
      ownerFiles.set(id, ref.sessionFile);
    }
    // Native advisor tools use the same transcript but an owner derived from its session ID.
    for (const id of [...owners]) {
      const advisor = `${id}-advisor`;
      owners.add(advisor);
      const file = ownerFiles.get(id);
      if (file) ownerFiles.set(advisor, file);
    }
    const scopedServices = async () => (await observeServices()).filter(unit => unit.owner && owners.has(unit.owner));
    const services = await scopedServices();
    const currentRefs = registry.list();
    if (exact().ref !== identity.ref || currentRefs.length !== refs.length
      || refs.some((ref, index) => currentRefs[index] !== ref))
      throw new Error("Native ownership tree changed during service observation");
    const deliveriesPending = (session: NativeSession) => {
      const delivery = session.getAsyncJobSnapshot({ recentLimit: 0 })?.delivery;
      return !!delivery && (delivery.delivering || delivery.queued > 0 || delivery.pendingJobIds.length > 0);
    };
    const descendantsUnknown = () => refs.some(ref => agents.has(ref.id) && ref.session !== null
      && !(ref.session instanceof pi.pi.AgentSession));
    const descendantsBusy = () => refs.some(ref => agents.has(ref.id) && ref.id !== pi.pi.MAIN_AGENT_ID
      && (registry.isRunning(ref) || ref.session instanceof pi.pi.AgentSession
        && (pendingNativeWake(ref.session) || ref.session.hasAdmittedSubmission || ref.session.hasPostPromptWork
          || ref.session.isBusyForSnapshot || ref.session.yieldQueue.has() || deliveriesPending(ref.session))));
    const serviceOwners = new Set<string>();
    const liveGenerations = new Set<string>();
    let servicesUnknown = false;
    for (const unit of services) {
      if (unit.owner) serviceOwners.add(unit.owner);
      if (!terminalService(unit.state)) {
        liveGenerations.add(serviceGenerationKey(unit));
        // Offline/unsupervised live rows are not authoritative; terminal rows
        // still need exact durable completion.
        if (!unit.supervised) servicesUnknown = true;
      }
    }
    for (const owner of trackedOwners) serviceOwners.add(owner);
    const liveByOwner = new Map<string, NativeSession | undefined>();
    if (serviceOwners.size > 0) {
      for (const { session } of refs) {
        if (!session) continue;
        const id = session.sessionManager.getSessionId();
        const live = session instanceof pi.pi.AgentSession ? session : undefined;
        if (!liveByOwner.has(id)) liveByOwner.set(id, live);
        const advisor = `${id}-advisor`;
        if (!liveByOwner.has(advisor)) liveByOwner.set(advisor, live);
      }
    }
    // Primary and advisor IDs can share a transcript. Reuse only within this
    // observation, and do not reuse the earlier root tracking scan: native
    // completions may have arrived while waiting on service observation.
    const sources = new Map<NativeSession | string, {
      readonly owners: string[]; readonly flush: Set<NativeSession>;
    }>();
    for (const owner of serviceOwners) {
      const file = ownerFiles.get(owner);
      if (!file) continue;
      const live = liveByOwner.get(owner);
      const source = !drain && live ? live : file;
      let use = sources.get(source);
      if (!use) {
        use = { owners: [], flush: new Set() };
        sources.set(source, use);
      }
      use.owners.push(owner);
      if (drain && live) use.flush.add(live);
    }
    const byOwner = new Map<string, ReturnType<typeof indexServiceCompletions>>();
    for (const [source, use] of sources) {
      for (const live of use.flush) {
        await live.waitForIdle();
        await live.sessionManager.ensureOnDisk();
        live.sessionManager.flushSync();
      }
      const proof = indexServiceCompletions(typeof source === "string"
        ? parseSessionEntries(await fs.readFile(source, "utf8")) : entries(source.sessionManager));
      for (const owner of use.owners) byOwner.set(owner, proof);
    }
    let serviceDeliveryUnknown = !trackingSeen || journalUnknown
      || attempts.some(row => !results.get(row.owner)?.has(row.toolCallId))
      || previousGenerations.some(values => values.some(value => {
        const previous = value as Frame;
        return owners.has(String(previous.owner)) && !tracked.has(serviceGenerationKey(previous));
      }));
    if (!serviceDeliveryUnknown) {
      // A recorded terminal completion supplies the final snapshot even when
      // the broker now exposes a replacement generation under the same name.
      for (const [key, daemon] of tracked) {
        if (!liveGenerations.has(key) && !byOwner.get(String(daemon.owner))?.hasGeneration(key)) {
          serviceDeliveryUnknown = true;
          break;
        }
      }
    }
    serviceDeliveryUnknown ||= services.some(unit => !tracked.has(serviceGenerationKey(unit))
      || terminalService(unit.state) && !byOwner.get(String(unit.owner))?.hasCompletion(unit));
    if (drain) {
      const refreshed = await scopedServices();
      if (!isDeepStrictEqual(services, refreshed))
        throw new Error("Native services changed while their durable completion evidence was drained");
    }
    if (!isDeepStrictEqual(refEpoch, registry.list().map(ref =>
      [ref.id, ref.generation, ref.parentId, ref.session?.instanceKey, ref.sessionFile])))
      throw new Error("Native descendant identity changed during completion readback");
    const tree = identity.session.getAsyncJobTree({ recentLimit: 0 });
    return { identity, tree, unknown: servicesUnknown || serviceDeliveryUnknown || descendantsUnknown(),
      busy: liveGenerations.size > 0 || descendantsBusy() || deliveriesPending(identity.session) || !!tree?.running.length };
  };
  const localIdle = () => {
    const { session } = exact();
    return !mutationHeld && !observationHeld && !session.isDisposed && !session.isBusyForSnapshot && !session.isStreaming
      && !session.isCompacting && !session.hasAdmittedSubmission && !session.hasPostPromptWork
      && session.queuedMessageCount === 0 && !pendingNativeWake(session)
      && !session.yieldQueue.has()
      && !session.getGoalModeState()?.enabled;
  };
  const rotationState = (): RotationNative | null => {
    if (process.env.OMP_SUPERAGENT_ROLE !== "head" || !localIdle()) return null;
    const { id, file, session } = exact();
    const usage = session.getContextUsage();
    const model = session.model;
    if (!file || !usage || typeof usage.tokens !== "number" || !Number.isFinite(usage.tokens)
      || typeof usage.percent !== "number" || !Number.isFinite(usage.percent) || usage.percent < 50
      || !Number.isFinite(usage.contextWindow) || usage.contextWindow <= 0
      || !model || typeof model.reasoning !== "boolean" || typeof session.configuredThinkingLevel !== "function") return null;
    const { modelRoles, defaultThinkingLevel } = snapshot();
    const roles = Object.fromEntries(Object.entries(modelRoles).filter((entry): entry is [string, string] =>
      typeof entry[1] === "string"));
    return { hostPid: process.pid, sessionId: id, sessionFile: file, nativeRun: runOrdinal,
      contextPercent: usage.percent,
      selection: { provider: model.provider, modelId: model.id, reasoning: model.reasoning,
        thinkingLevel: session.thinkingLevel ?? null, configuredThinkingLevel: session.configuredThinkingLevel() ?? null,
        modelSettings: { modelRoles: roles, ...(defaultThinkingLevel !== undefined ? { defaultThinkingLevel } : {}) } } };
  };
  const handle = async (command: Frame): Promise<unknown> => {
    if (command.type === "get_head_rotation") {
      const state = rotationState();
      if (!state) return null;
      let attestation: Parameters<RotationProbeEvent["respond"]>[0] | undefined;
      pi.events.emit(HEAD_ROTATION_PROBE, { state, respond: value => { attestation = value; } } satisfies RotationProbeEvent);
      return attestation ?? null;
    }
    if (command.type === "get_session_stats") return exact().session.getSessionStats();
    if (command.type === "get_state") {
      const { session } = exact();
      const queued = session.getQueuedMessages();
      // Adapted from oh-my-pi v18.22.0 rpc-mode.ts (MIT; THIRD_PARTY_NOTICES.md).
      // Copyright (c) 2025 Mario Zechner; 2025-2026 Can Bölük; 2026 Stencil Labs, Inc.
      // This is a live observation while an owner command is pending, never an
      // idle receipt. Disposal still requires the stock RPC settlement check.
      return {
        model: session.model, thinkingLevel: session.thinkingLevel,
        isStreaming: session.isStreaming, isCompacting: session.isCompacting,
        steeringMode: session.steeringMode, followUpMode: session.followUpMode,
        interruptMode: session.interruptMode, sessionFile: session.sessionFile,
        sessionId: session.sessionId, sessionName: session.sessionName,
        autoCompactionEnabled: session.autoCompactionEnabled,
        queuedMessageCount: session.queuedMessageCount, hasPendingAsyncWork: pendingNativeWake(session),
        isSettled: false,
        queuedMessages: { steering: [...queued.steering], followUp: [...queued.followUp], liveSteered: queued.liveSteered },
        todoPhases: session.getTodoPhases(), fastModeEnabled: session.isFastModeEnabled(),
        tokensPerSecond: calculateTokensPerSecond(session.messages, session.isStreaming),
        fastModeActive: session.isFastModeActive(), slowModeSupported: session.isSlowModeSupported(),
        slowModeEnabled: session.isSlowModeEnabled(), slowModeScope: session.getSlowModeScope(),
        usageLimit: session.getUsageLimitState(), messageCount: session.messages.length,
        systemPrompt: session.systemPrompt,
        dumpTools: session.agent.state.tools.map(tool => ({
          name: tool.name, description: tool.description, parameters: toolWireSchema(tool), examples: tool.examples,
        })),
        contextUsage: session.getContextUsage(), goal: session.getGoalModeState() ?? null,
      } satisfies RpcSessionState;
    }
    if (command.type === "interrupt_maintenance") {
      const { session } = exact();
      const restored = command.restoreQueue === true ? session.clearQueue({ forInterrupt: true }) : undefined;
      // abort() raises its barrier and withdraws marked internal context before
      // its first await. Do not await its compaction cleanup until the owner has
      // cancelled native UI; the pending compact may itself be awaiting that UI.
      interrupts.set(String(command.id), Promise.allSettled([session.abort({ reason: USER_INTERRUPT_LABEL })]));
      if (session.getGoalModeState()?.enabled) await session.goalRuntime.pauseGoal();
      return restored ?? {};
    }
    if (command.type === "finish_interrupt") {
      const token = String(command.token);
      const pending = interrupts.get(token);
      if (!pending) throw new Error("Native interrupt completion is unavailable");
      try {
        const [result] = await pending;
        if (result!.status === "rejected") throw result!.reason;
      } finally { interrupts.delete(token); }
      return {};
    }
    if (command.type === "activate") {
      const identity = exact();
      // Native's default tool selection omits the goal tool. Add it only for
      // that default, never widen an explicit --tools or --no-tools selection.
      if (command.toolsExplicitlySelected === false && command.noTools === false
        && goalEnabled.get(readOnly(identity.session.settings)) === true)
        await pi.setActiveTools([...new Set([...pi.getActiveTools(), "goal"])]);
      pi.events.emit("superagent:host-ready", { sessionId: identity.id, sessionFile: identity.file, pid: process.pid });
      return {};
    }
    if (command.type === "observe") {
      if (command.customType !== "rpc_prompt_result") throw new Error("Unsupported native observation");
      return { entryId: observation("rpc_prompt_result", {
        frame: command.frame, runOrdinal: command.runOrdinal, hostPid: command.hostPid,
      }) };
    }
    if (command.type === "get_journal_cursor") {
      const identity = exact();
      if (observationHeld) throw new Error("Durable native observations are unavailable");
      return { ...ownerIdentity(identity), leafId: identity.session.sessionManager.getLeafId() };
    }
    if (command.type === "snapshot") {
      const ownership = await owned();
      // Only an owner that implements the cursor command can advertise it to peers.
      return { ...ownerIdentity(ownership.identity), settingsScope: "session", modelSettings: snapshot(),
        journalCursorControlVersion: 1,
        hasOwnedRunningWork: ownership.unknown ? undefined : ownership.busy, mutationHeld, observationHeld,
        admitted: ownership.identity.session.hasAdmittedSubmission,
        postPromptWork: ownership.identity.session.hasPostPromptWork,
        ...(typeof ownership.identity.session.configuredThinkingLevel === "function"
          ? { configuredThinkingLevel: ownership.identity.session.configuredThinkingLevel() ?? null } : {}) };
    }
    if (command.type === "set_model_preset") {
      if (!localIdle()) throw new Error("Native session is busy or has an unresolved mutation");
      const ownership = await owned(true);
      if (ownership.unknown || ownership.busy || !localIdle()) throw new Error("Native owned work is not authoritatively drained");
      const preset = command.preset as LanePresetSnapshot;
      if (!preset || typeof preset.modelRoles !== "object"
        || Object.values(preset.modelRoles).some(value => typeof value !== "string"))
        throw new Error("A complete frozen model preset is required");
      mutationHeld = true;
      const settings = ownership.identity.session.settings;
      await settings.reloadFromDisk();
      const config = JSON.parse(await fs.readFile(configPath, "utf8"));
      const previous = settings.getModelRoles();
      const omitted = new Set([...Object.keys(previous), ...Object.keys(config.modelRoles ?? {})]);
      config.modelRoles = { ...Object.fromEntries([...omitted].map(role => [role, null])), ...preset.modelRoles };
      if (preset.defaultThinkingLevel !== undefined) config.defaultThinkingLevel = preset.defaultThinkingLevel;
      const temporary = `${configPath}.${crypto.randomUUID()}`;
      await fs.writeFile(temporary, JSON.stringify(config), { mode: 0o600, flag: "wx" });
      await fs.rename(temporary, configPath);
      await settings.reloadFromDisk();
      if (exact().ref !== ownership.identity.ref || !isDeepStrictEqual(snapshot(), preset))
        throw new Error("Native settings readback differs; mutation remains held");
      const candidates = ownership.identity.session.getAvailableModels();
      const selected = preset.modelRoles.default
        ? resolveModelRoleValue(preset.modelRoles.default, candidates, { settings: readOnly(settings) })
        : { model: pickDefaultAvailableModel(candidates.filter(model => context!.modelRegistry.hasConfiguredAuth(model)),
          provider => context!.modelRegistry.hasConcreteAuth(provider)) };
      const model = selected.model;
      if (!model) throw new Error("Native model resolution failed; mutation remains held");
      const expectedLevel = "thinkingLevel" in selected && selected.thinkingLevel !== undefined
        ? selected.thinkingLevel : preset.defaultThinkingLevel;
      const effectiveLevel = expectedLevel === "auto" ? "auto"
        : expectedLevel === undefined ? undefined : resolveThinkingLevelForModel(model, expectedLevel);
      if (!command.preserveActiveModel) {
        await ownership.identity.session.setModelTemporary(model, expectedLevel);
      }
      if (exact().ref !== ownership.identity.ref || !isDeepStrictEqual(snapshot(), preset)
        || !command.preserveActiveModel && (ownership.identity.session.model?.provider !== model.provider
          || ownership.identity.session.model?.id !== model.id
          || expectedLevel !== undefined && ownership.identity.session.configuredThinkingLevel() !== effectiveLevel))
        throw new Error("Native model/effort readback differs; mutation remains held");
      mutationHeld = false;
      return { name: command.name, settingsScope: "session", preset: snapshot(), model: ownership.identity.session.model };
    }
    if (command.type === "shutdown_host") {
      if (!localIdle()) throw new Error("session_busy");
      const ownership = await owned(true);
      await ownership.identity.session.waitForIdle();
      await ownership.identity.session.sessionManager.ensureOnDisk();
      const finalOwnership = await owned(true);
      if (exact().ref !== ownership.identity.ref || !localIdle() || ownership.unknown || finalOwnership.unknown
        || ownership.busy || finalOwnership.busy) throw new Error("session_busy");
      if (typeof command.headRotation === "string") {
        const state = rotationState();
        if (!state) throw new Error("session_busy");
        let allowed = false;
        pi.events.emit(HEAD_ROTATION_GUARD, { id: command.headRotation, state,
          respond: value => { allowed = value; } } satisfies RotationGuardEvent);
        if (!allowed) throw new Error("session_busy");
      }
      // The owner has fenced its inputs and revalidated stock state/UI. Nothing
      // awaits between this final native guard, disposal fence and shutdown.
      ownership.identity.session.sessionManager.flushSync();
      ownership.identity.session.beginDispose();
      context!.shutdown();
      return { shutdown: true, sessionId: ownership.identity.id, sessionFile: ownership.identity.file };
    }
    throw new Error("Unsupported private native control");
  };
  pi.on("agent_start", () => {
    if (context?.agent.kind === "main") observation("rpc_agent_start", { runOrdinal: ++runOrdinal, hostPid: process.pid });
  });
  pi.on("tool_call", async (event, ctx) => {
    const input = event.input as Frame;
    if (event.toolName !== "bash") return;
    const name = serviceName(input.name);
    if (!name) return;
    const owner = serviceOwner(ctx);
    let dir: string;
    try { dir = realpathSync(ctx.cwd); }
    catch { return { block: true, reason: "The named service's project scope could not be established" }; }
    const scope = { kind: "project", dir } as const;
    const reservation = JSON.stringify([socketPath, dir, name]);
    const key = JSON.stringify([owner, event.toolCallId]);
    if (serviceReservations.has(reservation) || serviceStarts.has(key))
      return { block: true, reason: "A named service launch for this project and name is already in progress" };
    serviceReservations.add(reservation);
    let admitted = false;
    try {
      const previous = await observeServices(scope, name);
      if (previous.some(unit => !unit.supervised && (!terminalService(unit.state) || unit.exitedAt === undefined)))
        return { block: true, reason: "The existing named service's live state could not be established" };
      if (previous.some(unit => !terminalService(unit.state) && unit.owner !== owner))
        return { block: true, reason: "A live named service in this project belongs to another session" };
      serviceObservation({ phase: "attempt", toolCallId: event.toolCallId, name, cwd: dir, owner,
        previous: previous.map(serviceGeneration) });
      serviceStarts.set(key, { name, scope, owner, reservation, sessionId: ctx.sessionManager.getSessionId(),
        toolCallId: event.toolCallId, previousIds: new Set(previous.map(unit => unit.id)) });
      admitted = true;
    } catch {
      return { block: true, reason: "Named service ownership could not be established before launch" };
    } finally {
      if (!admitted) serviceReservations.delete(reservation);
    }
  });
  pi.on("tool_approval_resolved", (event, ctx) => {
    if (event.toolName !== "bash" || event.approved !== false) return;
    const sessionId = ctx.sessionManager.getSessionId();
    if (event.sessionId && event.sessionId !== sessionId) return;
    // Advisor calls share the primary runner for approval, which does not
    // carry the advisor identity on this event. Require one exact session/call.
    let matched: string | undefined;
    for (const [key, start] of serviceStarts) {
      if (start.sessionId !== sessionId || start.toolCallId !== event.toolCallId) continue;
      if (matched !== undefined) return;
      matched = key;
    }
    if (matched !== undefined) finishWithoutServiceResult(matched, "approval_denied");
  });
  pi.on("message_end", (event, ctx) => {
    const message = event.message;
    if (message.role !== "toolResult" || message.toolName !== "bash") return;
    const details = message.details as Frame | undefined;
    const notDispatched = message.isError && details?.__synthetic === true && details.executed === false;
    finishWithoutServiceResult(JSON.stringify([serviceOwner(ctx), message.toolCallId]),
      notDispatched ? "not_dispatched" : undefined);
  });
  pi.on("tool_result", async (event, ctx) => {
    const owner = serviceOwner(ctx);
    const key = JSON.stringify([owner, event.toolCallId]);
    const start = serviceStarts.get(key);
    if (!start) return;
    const details = event.details as { service?: { name?: string; pid?: number } } | undefined;
    // An exited proc has no PID on the new board. A fresh unit can be tracked
    // without that PID, but still needs its exact durable launch completion.
    try {
      const unit = details?.service?.name === start.name
        ? (await observeServices(start.scope, start.name)).find(unit => unit.supervised && unit.key === start.name
          && unit.owner === start.owner && unit.restartCount === 0 && !start.previousIds.has(unit.id)
          && (terminalService(unit.state) || unit.pids[0] !== undefined && unit.pids[0] === details.service?.pid))
        : undefined;
      if (serviceStarts.get(key) !== start) return;
      serviceObservation({ phase: "result", toolCallId: event.toolCallId, owner,
        name: start.name, uncertain: event.isError || !unit, ...(unit ? { daemon: serviceGeneration(unit) } : {}) });
    } finally { releaseServiceStart(key, start); }
  });
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.agent.kind !== "main") {
      const root = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID)?.session;
      if (!(root instanceof pi.pi.AgentSession) || !ctx.agent.parentId)
        throw new Error("Native descendant root ownership is unavailable");
      root.sessionManager.appendCustomEntry("superagent_native_descendant", {
        rootSessionId: root.sessionManager.getSessionId(), agentId: ctx.agent.id, parentId: ctx.agent.parentId,
        sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile(),
      });
      root.sessionManager.flushSync();
      return;
    }
    if (server) return;
    context = ctx;
    const identity = exact();
    pendingNativeWake(identity.session);
    await ctx.sessionManager.ensureOnDisk();
    if (exact().ref !== identity.ref) throw new Error("Native session changed during materialization");
    identity.session.sessionManager.flushSync();
    const journal = entries(identity.session.sessionManager);
    if (!journal.some(entry => entry.type === "custom" && entry.customType === "superagent_service_tracking")) {
      identity.session.sessionManager.appendCustomEntry("superagent_service_tracking", {
        rootSessionId: identity.id, known: !journal.some(entry =>
          entry.type === "custom_message" && entry.customType === "launch-completion"
          || entry.type === "message" && entry.message.role === "assistant" && Array.isArray(entry.message.content)
            && entry.message.content.some(part => part.type === "toolCall" && part.name === "bash"
              && serviceName((part.arguments as Frame).name) !== undefined)),
      });
      identity.session.sessionManager.flushSync();
    }
    server = net.createServer(socket => {
      if (ownerChannel) { socket.destroy(); return; }
      const channel = new HostChannel(socket, socket, true);
      ownerChannel = channel;
      void channel.exited.then(() => { if (ownerChannel === channel) ownerChannel = undefined; });
      channel.encoder.setProtocolVersion(2);
      channel.on("frame", (command: Frame) => {
        if (command.type === "response" || typeof command.id !== "string") return;
        void handle(command).then(data => {
          channel.send(command.type === "interrupt_maintenance" && command.restoreQueue === true
            ? fitAbortAndRestoreQueueResponse(command.id as string, data as RpcAbortAndRestoreQueueResult, channel.encoder.maxResponseBytes)
            : { type: "response", command: command.type, id: command.id, success: true, data });
        }, error => {
          channel.send({ type: "response", command: command.type, id: command.id, success: false,
            error: error instanceof Error ? error.message : String(error) });
        });
      });
      channel.send({ type: "ready" });
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(socketPath, () => { void fs.chmod(socketPath, 0o600).then(resolve, reject); });
    });
  });
  pi.on("session_shutdown", async () => {
    if (!context || context.agent.kind !== "main") return;
    server?.close();
    await fs.unlink(socketPath).catch(error => { if (error.code !== "ENOENT") throw error; });
  });
}
