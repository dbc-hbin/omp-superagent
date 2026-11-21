import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Approval, DialogResponse, GatewayRestartRecord, GatewayRestartRequest, Inbound, Lane, LaneModel, LanePresetSnapshot, ResolvedLanePreset, MessageActivity, MessageReference, Messenger, OutputRecord, Route, ThreadInfo, ThreadUpdate } from "../src/contracts";
import { physicalRouteKey, routeKey, WORKFLOW_NAMES } from "../src/contracts";
import { containsMagicKeyword } from "@oh-my-pi/pi-tui/prompt/magic-keywords";
import { type Config, hostPaths } from "../src/config";
import type { HostOptions } from "../src/host";
import { DeliveryError } from "../src/delivery";
import { createGatewayMessenger, type GatewayHeadMessenger } from "../src/gateway-client";
import { gatewayPaths } from "../src/gateway-protocol";
import { GatewayServer } from "./oracles/bun-gateway/gateway-server";
import { GatewayStore } from "./oracles/bun-gateway/gateway-store";
import { compareMessageIds } from "../src/message-order";
import { readOmpUsage } from "../src/omp-usage";
import { Superagent, type RuntimeAdapters, type RuntimeHost, type RuntimeState } from "../src/runtime";
import { Store } from "../src/store";
import type { LaneReport } from "../src/lane-report";
import type { HeadRecoveryAttempt, HeadRecoveryDecision } from "../src/contracts";
import { headRecoveryEvidence } from "../src/head-recovery";
import { decisionId } from "../src/decisions";
import { CronJobs } from "../src/cron-jobs";

test("a delayed durable receipt cannot cancel a later native run", () => {
  const owner = { sessionId: "native-session", sessionFile: "/private/session.jsonl", requestId: "original", cursor: null };
  const entries = [
    { id: "start-1", type: "custom", customType: "rpc_agent_start",
      data: { ...owner, hostPid: 123, runOrdinal: 1 } },
    { id: "start-2", type: "custom", customType: "rpc_agent_start",
      data: { ...owner, hostPid: 123, runOrdinal: 2 } },
    { id: "late-receipt", type: "custom", customType: "rpc_prompt_result",
      data: { ...owner, hostPid: 123, runOrdinal: 1,
        frame: { id: "original", status: "aborted", agentInvoked: true } } },
  ];
  expect(headRecoveryEvidence(entries, owner)?.outcome).toBeNull();
  const data = entries[2]!.data;
  data.runOrdinal = 2;
  expect(headRecoveryEvidence(entries, owner)?.outcome).toBe("cancelled");
});

const executionModel: LaneModel = { provider: "fixture", id: "capable" };
const otherModel: LaneModel = { provider: "fixture", id: "efficient" };
const selection = { model: executionModel, modelReason: "Native judge recommends the capable model for this isolated task." };

interface Prompt { id: string; command: Record<string, unknown> }
class HostTransport implements RuntimeHost {
  readonly listeners = new Set<(frame: Record<string, unknown>) => void>();
  readonly prompts: Prompt[] = [];
  readonly commands: Record<string, unknown>[] = [];
  readonly responses: Array<{ id: string; response: DialogResponse }> = [];
  readonly cancelled: string[] = [];
  readonly exited: Promise<unknown>;
  private readonly exit: () => void;
  private promptWaiters: Array<{ count: number; resolve: () => void }> = [];
  local = false;
  shutdownAllowed = true;
  shutdownDisconnect = false;
  workflowAvailable = true;
  beforeCapabilities?: () => Promise<void> | void;
  uiAcknowledges = true;
  children: Array<{ id: string }> = [];
  abortFails = false;
  models: unknown[] = [executionModel, { ...otherModel, kind: "chat" }, { provider: "fixture", id: "judge", kind: "judge" }];
  catalogSuccess = true;
  beforeCatalog?: () => Promise<void> | void;
  beforeLevels?: () => Promise<void> | void;
  beforeSetModel?: () => Promise<void> | void;
  beforeSetEffort?: () => Promise<void> | void;
  beforeCompact?: () => Promise<void> | void;
  beforeAbort?: () => Promise<void> | void;
  beforeGoalResume?: () => Promise<void> | void;
  beforePrompt?: () => Promise<void> | void;
  beforeState?: () => Promise<void> | void;
  beforeCursor?: () => Promise<void> | void;
  cursorResponse?: unknown;
  beforeEntries?: () => Promise<void> | void;
  afterEntries?: () => Promise<void> | void;
  goalResumeRuns = true;
  compactResult: "success" | "rejected" | "throw-after" = "success";
  compactAbort?: () => void;
  abortCount = 0;
  modelSetResult: "success" | "throw-before" | "throw-after" | "mismatch" | "rejected" = "success";
  effortSetResult: "success" | "throw-after" | "model-mismatch" | "missing-effort" | "rejected" = "success";
  levels: unknown[] = ["off", "minimal", "high"];
  levelsSuccess = true;
  entries: unknown[] = [];
  journalLeaf = false;
  effortClamp?: string;
  modelEffort?: string | null;
  state: RuntimeState;

  constructor(sessionFile: string, sessionId: string, model: LaneModel | null = executionModel) {
    this.state = { sessionFile, sessionId, journalCursorVersion: 1, model, thinkingLevel: "high", isCompacting: false, queuedMessageCount: 0, settingsScope: "session",
      modelSettings: { modelRoles: { default: "fixture/capable", smol: "fixture/efficient" }, defaultThinkingLevel: Effort.High },
      contextUsage: { tokens: 321, contextWindow: 200_000, percent: 0.1605 },
      hostPid: process.pid, isSettled: true, isStreaming: false, hasPendingAsyncWork: false, hasOwnedRunningWork: false, pendingUiRequests: [], goal: null };
    const deferred = Promise.withResolvers<void>();
    this.exited = deferred.promise;
    this.exit = () => deferred.resolve();
  }
  client = {
    getState: async () => { if (this.beforeState) await this.beforeState(); return structuredClone(this.state); },
    abortAndRestoreQueue: async () => {
      this.abortCount++;
      await this.beforeAbort?.();
      if (this.abortFails) throw new Error("native abort failed");
      this.compactAbort?.();
      this.state.isStreaming = false;
      this.state.isSettled = true;
      this.state.isCompacting = false;
      this.state.queuedMessageCount = 0;
      return { steering: [{ text: "withdrawn secret input" }], followUp: [] };
    },
    getSubagents: async () => this.children,
    cancelSubagent: async (id: string) => { this.cancelled.push(id); },
  };
  private leafId(): string | null {
    const leaf = this.entries.at(-1);
    return this.journalLeaf && leaf !== null && typeof leaf === "object"
      && "id" in leaf && typeof leaf.id === "string" ? leaf.id : null;
  }
  async request(command: Record<string, unknown>, id?: string): Promise<unknown> {
    this.commands.push(command);
    if (command.type === "get_available_models") {
      await this.beforeCatalog?.();
      return { success: this.catalogSuccess, data: { models: structuredClone(this.models) } };
    }
    if (command.type === "get_available_thinking_levels") {
      await this.beforeLevels?.();
      return { success: this.levelsSuccess, data: { levels: structuredClone(this.levels) } };
    }
    if (command.type === "get_journal_cursor") {
      await this.beforeCursor?.();
      return this.cursorResponse ?? { success: true, data: { leafId: this.leafId() } };
    }
    if (command.type === "get_entries") {
      if (this.beforeEntries) await this.beforeEntries();
      const since = command.since;
      const index = typeof since === "string" ? this.entries.findIndex(entry =>
        entry !== null && typeof entry === "object" && "id" in entry && entry.id === since) : -1;
      const response = since !== undefined && index < 0
        ? { success: false, code: "unknown_since", error: "Unknown entries cursor" }
        : { success: true, data: { entries: structuredClone(this.entries.slice(index + 1)), leafId: this.leafId() } };
      const after = this.afterEntries?.();
      if (after) await after;
      return response;
    }
    if (command.type === "compact") {
      if (this.compactResult === "rejected") return { success: false, error: "secret rejected compact" };
      this.state.isCompacting = true;
      try { await this.beforeCompact?.(); }
      finally { this.state.isCompacting = false; }
      this.state.contextUsage = { tokens: 123, contextWindow: 200_000, percent: 0.0615 };
      if (this.compactResult === "throw-after") throw new Error("secret lost compact acknowledgement");
      return { success: true, data: { summary: "secret native summary", firstKeptEntryId: "kept-1", tokensBefore: 321 } };
    }
    if (command.type === "set_thinking_level") {
      await this.beforeSetEffort?.();
      if (this.state.settingsScope !== "session" || this.effortSetResult === "rejected") return { success: false, error: "secret endpoint/token native error" };
      this.state.thinkingLevel = this.effortClamp ?? String(command.level);
      if (this.effortSetResult === "model-mismatch") this.state.model = { ...otherModel };
      if (this.effortSetResult === "missing-effort") this.state.thinkingLevel = undefined;
      if (this.effortSetResult === "throw-after") throw new Error("secret endpoint/token lost effort acknowledgement");
      return { success: true };
    }
    if (command.type === "get_available_commands") {
      await this.beforeCapabilities?.();
      return { success: true, data: { commands: this.workflowAvailable ? WORKFLOW_NAMES.filter(name => name !== "jevify").map(name => ({
        name, source: "extension", description: `Run the OMP-adapted ${name} workflow`,
      })) : [] } };
    }
    if (command.type === "set_model" || command.type === "set_model_preset") {
      await this.beforeSetModel?.();
      if (this.modelSetResult === "throw-before") throw new Error("Native model request transport outcome unknown");
      if (this.modelSetResult === "rejected") return { success: false, error: "secret endpoint/token native error" };
      if (this.state.settingsScope !== "session") return { success: false, error: "Session-isolated settings required" };
      if (this.modelSetResult !== "mismatch") {
        if (command.type === "set_model_preset") {
          const preset = structuredClone(command.preset) as LanePresetSnapshot;
          const model = [executionModel, otherModel].find(model => `${model.provider}/${model.id}` === preset.modelRoles.default);
          if (!model) throw new Error("Fixture native preset has no exact available default");
          this.state.model = { ...model };
          this.state.modelSettings = { modelRoles: { ...preset.modelRoles }, defaultThinkingLevel: preset.defaultThinkingLevel ?? this.state.modelSettings?.defaultThinkingLevel };
          this.state.thinkingLevel = this.state.modelSettings.defaultThinkingLevel;
        } else {
          this.state.model = { provider: String(command.provider), id: String(command.modelId) };
          if (this.modelEffort !== undefined) this.state.thinkingLevel = this.modelEffort ?? undefined;
        }
      }
      if (this.modelSetResult === "throw-after") throw new Error("Native model acknowledgement lost");
      return { success: true, data: command.type === "set_model_preset"
        ? { name: command.name, preset: this.state.modelSettings, model: this.state.model, settingsScope: this.state.settingsScope }
        : this.state.model };
    }
    if (command.type === "prompt") {
      if (!id) throw new Error("Missing persisted request identity");
      this.prompts.push({ id, command });
      for (const waiter of this.promptWaiters) if (this.prompts.length >= waiter.count) waiter.resolve();
      if (this.beforePrompt) await this.beforePrompt();
      if (!this.local) {
        if (this.journalLeaf) this.entries.push({
          id: `start-${id}`, type: "custom", customType: "rpc_agent_start",
          data: { sessionId: this.state.sessionId, sessionFile: this.state.sessionFile },
        }, { id: `user-${id}`, type: "message", message: { role: "user", content: command.message } });
        this.state.isSettled = false;
        this.state.isStreaming = true;
        this.emit({ type: "agent_start" });
      }
      return { success: true, data: { agentInvoked: !this.local } };
    }
    if (command.type === "goal") {
      if (this.state.goal?.goal && command.op === "pause") {
        this.state.goal = { enabled: false, mode: "active", goal: { ...this.state.goal.goal, status: "paused" } };
      } else if (this.state.goal?.goal && command.op === "resume") {
        this.state.goal = { enabled: true, mode: "active", goal: { ...this.state.goal.goal, status: "active" } };
        if (this.goalResumeRuns) {
          this.state.isSettled = false;
          this.state.isStreaming = true;
          this.emit({ type: "agent_start" });
        }
        await this.beforeGoalResume?.();
      } else this.state.goal = null;
      return { success: true, data: {} };
    }
    if (command.type === "shutdown_host") {
      if (this.shutdownAllowed && this.shutdownDisconnect) this.exit();
      return { success: this.shutdownAllowed, error: this.shutdownAllowed ? undefined : "services still owned" };
    }
    throw new Error(`Unexpected native command: ${command.type}`);
  }
  uiResponse(id: string, response: DialogResponse): void {
    this.responses.push({ id, response });
    if (!this.uiAcknowledges) return;
    this.state.pendingUiRequests = this.state.pendingUiRequests?.filter(frame => frame.id !== id);
    this.emit({ type: "extension_ui_request", method: "cancel", targetId: id });
  }
  onFrame(listener: (frame: Record<string, unknown>) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  async close(): Promise<void> { this.exit(); }
  emit(frame: Record<string, unknown>): void { for (const listener of this.listeners) listener(frame); }
  complete(text: string, index = this.prompts.length - 1): void {
    const prompt = this.prompts[index]!;
    this.state.isStreaming = false;
    this.state.isSettled = true;
    this.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });
    this.emit({ type: "prompt_result", id: prompt.id, agentInvoked: true, status: "completed", sessionSettled: true });
    this.emit({ type: "session_settled" });
  }
  whenPrompts(count: number): Promise<void> {
    if (this.prompts.length >= count) return Promise.resolve();
    const deferred = Promise.withResolvers<void>();
    this.promptWaiters.push({ count, resolve: () => deferred.resolve() });
    return deferred.promise;
  }
}

type Handlers = Parameters<Messenger["start"]>[0];
class MessengerTransport implements Messenger {
  handlers?: Handlers;
  readonly sent: OutputRecord[] = [];
  readonly attempted: OutputRecord[] = [];
  readonly shown = new Map<string, Approval>();
  readonly dismissed: string[] = [];
  readonly fetched: Array<{ route: Route; cursor: string }> = [];
  readonly activities: Array<{ message: MessageReference; activity: MessageActivity }> = [];
  activityFailure = false;
  private readonly activityWaiters: Array<{ count: number; resolve(): void }> = [];
  readonly backlog = new Map<string, Inbound[] | null>();
  readonly threads: Route[] = [];
  readonly threadSources: Array<string | undefined> = [];
  readonly threadTags: Array<readonly string[] | undefined> = [];
  canCreateThread?: Messenger["canCreateThread"];
  inspectThread?: Messenger["inspectThread"];
  updateThread?: Messenger["updateThread"];
  private sendWaiters: Array<{ count: number; resolve: () => void }> = [];
  private approvalWaiters: Array<() => void> = [];
  threadFails = false;
  sendError?: Error;
  beforeSend?: (output: OutputRecord) => Promise<void>;
  onStart?: (handlers: Handlers) => void;
  assertRoute?: Messenger["assertRoute"];
  openAttachment: Messenger["openAttachment"] = async () => { throw new Error("No test attachment is authorized"); };
  async start(handlers: Handlers): Promise<void> { this.handlers = handlers; this.onStart?.(handlers); }
  async send(output: OutputRecord): Promise<string> {
    if (!this.handlers) throw new Error("Messenger must start before send");
    this.attempted.push(output);
    await this.beforeSend?.(output);
    if (this.sendError) throw this.sendError;
    this.sent.push(output);
    for (const waiter of this.sendWaiters) if (this.sent.length >= waiter.count) waiter.resolve();
    return `remote-${output.id}`;
  }
  async setActivity(message: MessageReference, activity: MessageActivity): Promise<void> {
    if (this.activityFailure) throw new DeliveryError("Reaction rejected", "rejected");
    this.activities.push({ message: { route: message.route, messageId: message.messageId }, activity });
    for (const waiter of this.activityWaiters) if (this.activities.length >= waiter.count) waiter.resolve();
  }
  whenActivities(count: number): Promise<void> {
    if (this.activities.length >= count) return Promise.resolve();
    const ready = Promise.withResolvers<void>();
    this.activityWaiters.push({ count, resolve: () => ready.resolve() });
    return ready.promise;
  }
  async showApproval(approval: Approval): Promise<string> {
    if (!this.handlers) throw new Error("Messenger must start before UI recovery");
    this.shown.set(approval.id, approval);
    for (const resolve of this.approvalWaiters.splice(0)) resolve();
    return approval.remoteId ?? `card-${approval.id}`;
  }
  async dismissApproval(approval: Approval): Promise<void> {
    if (!this.handlers) throw new Error("Messenger must start before dismiss");
    this.dismissed.push(approval.id);
  }
  async createThread(route: Route, _title: string, sourceMessageId?: string, appliedTags?: readonly string[]): Promise<Route> {
    this.threadSources.push(sourceMessageId);
    this.threadTags.push(appliedTags);
    if (this.threadFails) throw new Error("ambiguous remote thread creation");
    const created = { ...route, threadId: String(900 + this.threads.length) };
    this.threads.push(created);
    return created;
  }
  async fetchAfter(route: Route, cursor: string): Promise<Inbound[] | null> {
    this.fetched.push({ route, cursor });
    return this.backlog.has(routeKey(route)) ? this.backlog.get(routeKey(route))! : [];
  }
  async stop(): Promise<void> { this.handlers = undefined; }
  whenSent(count: number): Promise<void> {
    if (this.sent.length >= count) return Promise.resolve();
    const deferred = Promise.withResolvers<void>();
    this.sendWaiters.push({ count, resolve: () => deferred.resolve() });
    return deferred.promise;
  }
  whenApproval(): Promise<void> {
    if (this.shown.size) return Promise.resolve();
    const deferred = Promise.withResolvers<void>();
    this.approvalWaiters.push(() => deferred.resolve());
    return deferred.promise;
  }
}

const fixtures: Array<{ runtime: Superagent; directory: string }> = [];
afterEach(async () => {
  for (const { runtime, directory } of fixtures.splice(0)) {
    await runtime.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
const route = (threadId: string | null = "10", patch: Partial<Route> = {}): Route => ({
  platform: "discord", accountId: "2", authorityId: "1", guildId: "3", channelId: "4", threadId, ...patch,
});
const message = (id: string, destination = route(), text = `task ${id}`): Inbound & MessageReference => ({
  id, route: destination, messageId: id, text, receivedAt: 100, attachments: [],
});
const headMessage = (id: string, destination = route(), task = `task ${id}`): Inbound & MessageReference =>
  message(id, destination, `/head ${task}`);
const applicationCommand = (interactionId: string, destination = route(), text = "/status"): Inbound => ({
  ...message(`interaction:${interactionId}`, destination, text), messageId: null, interactionId,
});
const slackCommand = (identity: string, destination: Route, text = "/status"): Inbound => ({
  ...message(`slack-command:${identity}`, destination, text), messageId: null,
  invocationId: createHash("sha256").update(identity).digest("hex"),
});
const pickerClick = (output: OutputRecord, group: number, option: number): Inbound => ({
  id: `picker:${output.id}`, route: output.route, text: "", messageId: null, receivedAt: 300, attachments: [],
  pickerSelection: { outputId: output.id, cardId: `remote-${output.id}`, group, option },
});
async function admit(runtime: Superagent, input: Inbound): Promise<void> {
  await runtime.receive(input);
  await runtime.kick();
}

// Lane-only lifecycle/model cases simulate the head's explicit accepted decision;
// routing cases below exercise actual head prompt admission separately.
async function delegate(runtime: Superagent, input: Inbound): Promise<void> {
  runtime.store.receive(input, "main");
  runtime.store.settle(input.id, "done");
  const lane = runtime.store.laneForRoute(input.route);
  if (!lane) throw new Error("An explicit test handoff requires a known lane");
  await runtime.messageLane(lane.id, input.text, input.id);
}
function delegated(store: Store, sourceId: string) {
  const original = store.input(sourceId);
  const lane = original && store.laneForRoute(original.route);
  if (!lane) throw new Error("Missing explicit lane handoff");
  return store.input(`handoff:${sourceId}:${lane.id}`);
}

function fixture(maxHosts = 3, openAttachment?: Messenger["openAttachment"], adapters: Partial<Pick<RuntimeAdapters, "inspectPresets" | "resolvePreset" | "requestRestart" | "readPrSnapshot" | "readOmpUsage" | "topicMemory">> = {}) {
  const directory = realpathSync(mkdtempSync("/tmp/sa-runtime-"));
  const config: Config = {
    path: join(directory, "config.json"), stateDir: directory, headCwd: directory,
    command: [process.execPath], maxHosts, maxSubagents: maxHosts * 2, idleMs: 60_000,
    discord: { tokenEnv: "TEST_DISCORD_TOKEN", ownerId: "1", allowedGuildIds: ["3"], allowedChannelIds: ["4"] },
  };
  const store = new Store(join(directory, "coordination.sqlite"));
  const messenger = new MessengerTransport();
  if (openAttachment) messenger.openAttachment = openAttachment;
  const main = new HostTransport(hostPaths(config, "main").sessionFile, "session-main");
  const hosts = new Map<string, HostTransport>([[hostPaths(config, "main").socketPath, main]]);
  const launched: HostOptions[] = [];
  const launchBehavior: { model?: LaneModel | null; pid?: number; goal?: RuntimeState["goal"] } = {};
  const nativePresets = new Map<string, ResolvedLanePreset>([
    ["high", { model: executionModel, preset: "high", snapshot: { modelRoles: { default: "fixture/capable", smol: "fixture/efficient" }, defaultThinkingLevel: Effort.High } }],
    ["middle", { model: executionModel, preset: "middle", snapshot: { modelRoles: { default: "fixture/capable" } } }],
    ["low", { model: otherModel, preset: "low", snapshot: { modelRoles: { default: "fixture/efficient", smol: "fixture/efficient" }, defaultThinkingLevel: Effort.Low } }],
  ]);
  const persistedPresets: ResolvedLanePreset[] = [];
  const presetPersistence: { save?: (selection: ResolvedLanePreset) => Promise<LanePresetSnapshot> } = {};
  const errors: unknown[] = [];
  const runtime = new Superagent(config, store, messenger, join(directory, "extension.ts"), error => errors.push(error), {
    readOmpUsage: async () => "OMP 사용량\n\n설정된 OMP 프로필에서 보고된 계정 한도가 없습니다.",
    resolvePreset: async name => {
      const preset = nativePresets.get(name);
      if (!preset) throw new Error("Native preset is not configured");
      return structuredClone(preset);
    },
    inspectPresets: async () => ({
      settings: structuredClone(main.state.modelSettings!),
      configuredDefault: { available: true, resolvedDefault: { ...executionModel } },
      availableModels: [{ ...executionModel }, { ...otherModel }],
      presets: [...nativePresets].map(([name, value]) => ({ name, status: "valid", globalEntry: true, available: true, resolvedDefault: { ...value.model } })),
      bootstrap: { missing: [], blocked: [] },
    }),
    persistPreset: async selection => {
      persistedPresets.push(structuredClone(selection));
      return presetPersistence.save ? await presetPersistence.save(selection) : structuredClone(selection.snapshot);
    },
    connect: async path => {
      const host = hosts.get(path);
      if (!host) throw new Error("No native host at endpoint");
      return host;
    },
    startHost: async options => {
      launched.push(options);
      const id = basename(options.socketPath, ".sock");
      const selector = options.modelPreset?.preset.modelRoles.default ?? options.model;
      const selected = [executionModel, otherModel].find(model => `${model.provider}/${model.id}` === selector);
      const restored = hosts.get(options.socketPath)?.state.model;
      const host = new HostTransport(options.sessionFile, `session-${id}`,
        launchBehavior.model !== undefined ? launchBehavior.model : selected ?? restored ?? executionModel);
      host.state.hostPid = launchBehavior.pid ?? process.pid;
      if (launchBehavior.goal !== undefined) host.state.goal = structuredClone(launchBehavior.goal);
      if (options.modelPreset) host.state.modelSettings = structuredClone(options.modelPreset.preset);
      hosts.set(options.socketPath, host);
      if (!existsSync(options.sessionFile)) writeFileSync(options.sessionFile, JSON.stringify({ type: "session", version: 3, id: host.state.sessionId, cwd: options.cwd }) + "\n");
      return { pid: launchBehavior.pid ?? process.pid };
    },
    ...adapters,
  });
  fixtures.push({ runtime, directory });
  return { runtime, config, directory, store, messenger, main, hosts, launched, errors, launchBehavior, nativePresets, persistedPresets, presetPersistence };
}

test("cron controls scope job management to the original thread and send one HEAD result after route verification", async () => {
  const { runtime, messenger, main, store, errors, directory } = fixture();
  const origin = route("11");
  const other = route("12");
  let authenticatedAccount = "other-bot";
  messenger.assertRoute = destination => {
    if (destination.accountId !== authenticatedAccount) throw new Error("Gateway socket disconnected before route verification");
  };
  await runtime.start();
  const add = applicationCommand("201", origin, '/cron add "every 2h" "Original text"');
  await admit(runtime, add);
  const id = store.output(`${add.id}:head-control`)?.text.match(/[0-9a-f-]{36}/)?.[0];
  if (!id) throw new Error("Cron registration did not return a job ID");
  await admit(runtime, add);
  await admit(runtime, message("202", other, `/cron remove ${id}`));
  expect(store.input("202")?.state).toBe("cancelled");
  await admit(runtime, message("203", origin, `/cron edit ${id} prompt Updated text\nSecond line`));
  await admit(runtime, message("204", origin, `/cron pause ${id}`));
  await admit(runtime, { ...message("discord:2:204:edit:2040:revision", origin, `/cron resume ${id}`), messageId: "204" });
  expect(store.input("discord:2:204:edit:2040:revision")?.state).toBe("cancelled");
  await admit(runtime, message("205", origin, "/cron list"));
  expect(store.output("205:head-control")?.text).toMatch(new RegExp(`^${id} .+paused`));
  await admit(runtime, message("206", origin, `/cron run ${id}`));
  const run = `cron-run:${id}:206`;
  expect(store.input(run)?.state).toBe("pending");
  expect(main.prompts).toEqual([]);
  await admit(runtime, headMessage("216", other, "Answer this ordinary request while the route probe is unavailable"));
  expect(main.prompts).toHaveLength(1);
  main.complete("Ordinary result");
  await messenger.whenSent(8);
  authenticatedAccount = origin.accountId;
  await runtime.kick();
  expect(main.prompts).toHaveLength(2);
  expect(main.prompts[1]?.command.message).toContain("Updated text\nSecond line");
  await expect(runtime.startLane({ ...selection, sourceId: run, cwd: directory, title: "Unexpected lane", kickoff: "Do not send" }))
    .rejects.toThrow("cannot delegate lane work");
  await expect(runtime.messageLane("other-lane", "Do not dispatch", "216")).rejects.toThrow("cannot delegate lane work");
  const frame = { type: "extension_ui_request", id: "cron-approval", method: "confirm", title: "Proceed?", message: "Owner approval required" };
  main.state.pendingUiRequests = [frame];
  main.emit(frame);
  await messenger.whenApproval();
  const card = [...messenger.shown.values()][0];
  if (!card || !messenger.handlers) throw new Error("Scheduled run did not surface its native approval");
  expect(card.route).toEqual(origin);
  await expect(messenger.handlers.answer(card.id, { confirmed: true }, other)).rejects.toThrow("foreign approval");
  expect(main.responses).toEqual([]);
  await messenger.handlers.answer(card.id, { confirmed: true }, origin);
  expect(main.responses).toEqual([{ id: frame.id, response: { confirmed: true } }]);
  main.complete("Cron result");
  await messenger.whenSent(9);
  expect(store.output(`${run}:answer`)).toMatchObject({ sourceId: run, route: origin, text: "Cron result" });
  expect(store.output(`${run}:answer`)?.replyTo).toBeUndefined();
  await admit(runtime, message("207", origin, `/cron resume ${id}`));
  await admit(runtime, message("208", origin, "/stop head"));
  await admit(runtime, message("209", origin, "/cron list"));
  expect(store.output("209:head-control")?.text).toContain("held by HEAD stop");
  await admit(runtime, message("210", origin, `/cron resume ${id}`));
  await admit(runtime, message("211", origin, `/cron remove ${id}`));
  await admit(runtime, message("212", origin, "/cron list"));
  expect(store.output("212:head-control")?.text).toBe("No cron jobs in this conversation.");
  expect(main.prompts).toHaveLength(2);
  expect(errors).toEqual([]);
});

test("pausing a cron job while HEAD is busy cancels its pending execution without interrupting HEAD", async () => {
  const { runtime, messenger, main, store, errors } = fixture();
  messenger.assertRoute = () => {};
  await runtime.start();
  const origin = route("11");
  await admit(runtime, message("211", origin, '/cron add "every 30m" Check CI'));
  const id = store.output("211:head-control")?.text.match(/[0-9a-f-]{36}/)?.[0];
  if (!id) throw new Error("Cron registration did not return a job ID");
  await admit(runtime, headMessage("212", origin, "Investigate this first"));
  await admit(runtime, message("213", origin, `/cron run ${id}`));
  const runId = `cron-run:${id}:213`;
  expect(store.input(runId)?.state).toBe("pending");
  await admit(runtime, message("214", origin, `/cron pause ${id}`));
  expect(store.input(runId)?.state).toBe("cancelled");
  main.complete("Interactive result");
  await messenger.whenSent(4);
  await runtime.kick();
  expect(main.prompts).toHaveLength(1);
  expect(store.output("212:answer")).toMatchObject({ text: "Interactive result" });
  expect(errors).toEqual([]);
});

test("natural-language cron registration is active-owner-bound and cannot recreate a removed job on replay", async () => {
  const { runtime, messenger, main, store } = fixture();
  await runtime.start();
  const origin = route("11");
  const owner = headMessage("231", origin, "Every day at 09:00 Seoul time, summarize CI here.");
  const request = { sourceId: owner.id, schedule: "TZ=Asia/Seoul 0 9 * * *", prompt: "Summarize CI" };
  expect(() => runtime.createCronJob(request)).toThrow("current HEAD turn");
  await admit(runtime, owner);
  const created = runtime.createCronJob(request);
  expect(created).toMatchObject({ status: "created", schedule: request.schedule });
  expect(runtime.createCronJob(request)).toMatchObject({ id: created.id, status: "already_registered" });
  expect(() => runtime.createCronJob({ ...request, prompt: "Different work" })).toThrow("already registered a different cron job");
  await admit(runtime, message("232", origin, `/cron remove ${created.id}`));
  expect(runtime.createCronJob(request)).toEqual({ id: created.id, status: "removed" });
  main.complete("Registration receipt");
  await messenger.whenSent(2);
  await admit(runtime, message("233", origin, "/cron list"));
  expect(store.output("233:head-control")?.text).toBe("No cron jobs in this conversation.");
  expect(() => runtime.createCronJob(request)).toThrow("current HEAD turn");
});

test.each(["stop", "pause", "remove"] as const)("recovered %s control takes effect before the scheduler can submit a run", async action => {
  const { runtime, store, config, messenger, main } = fixture();
  const origin = route("11");
  messenger.assertRoute = () => {};
  // Crash window: both the registration and the subsequent operator input
  // reached SQLite, but the controller did not apply the latter command.
  const registered = message("221", origin, '/cron add "in 1s" Do not run after stop');
  store.receive(registered, "main", { "user-source:221": "true" });
  const source = store.input(registered.id);
  if (!source) throw new Error("Missing registration input");
  const cron = new CronJobs(store, config);
  const now = Date.now();
  store.settleCronControl(source.id, cron.control(source, 'add "in 1s" Do not run after stop', now - 3000));
  const jobId = store.output("221:head-control")?.text.match(/[0-9a-f-]{36}/)?.[0];
  if (!jobId) throw new Error("Missing cron job ID");
  if (action !== "stop") cron.poll(now - 1000);
  const queued = store.inputs("main").find(input => input.id.startsWith("cron-run:"));
  if (action !== "stop" && !queued) throw new Error("Expected a previously admitted run");
  const control = message("222", origin, action === "stop" ? "/stop head" : `/cron ${action} ${jobId}`);
  store.receive(control, "main", { "user-source:222": "true" });
  await runtime.start();
  expect(store.input(control.id)?.state).toBe(action === "stop" ? "cancelled" : "done");
  if (queued) expect(store.input(queued.id)?.state).toBe("cancelled");
  expect(store.inputs("main")).toEqual([]);
  expect(main.prompts).toEqual([]);
});

test("PR feedback after lane closure reaches only HEAD and its registered conversation", async () => {
  let reads = 0;
  const { runtime, store, main, messenger, launched, directory, hosts } = fixture(3, undefined, {
    readPrSnapshot: async () => {
      reads++;
      return { head: "a".repeat(40), state: "open", mergedSha: null, self: "owner", headChange: "unknown", failures: [],
        feedback: reads === 1 ? [] : [{ key: "review:1", actor: "reviewer", kind: "review",
          url: "https://github.com/example/project/pull/7#review", text: "Please correct the parsing boundary." }] };
    },
  });
  await runtime.start();
  const original = message("pr-owner", route());
  store.receive(original, "main", { "user-source:pr-owner": "true" });
  store.settle(original.id, "done");
  const lane = await runtime.startLane({ ...selection, sourceId: original.id, title: "PR work",
    kickoff: "Implement and verify the requested change.", cwd: directory });
  await runtime.kick();
  const laneHost = hosts.get(lane.socketPath);
  if (!laneHost) throw new Error("Expected managed lane host");
  await laneHost.whenPrompts(1);
  laneHost.complete("PR prepared");
  await main.whenPrompts(1);
  laneHost.shutdownDisconnect = true;
  await runtime.closeLane(lane.id, "completed", "Change checked and PR opened.");
  // Existing lane-report delivery is independent of the new PR observation.
  const beforeResult = messenger.sent.length;
  main.complete("Lane result received");
  await messenger.whenSent(beforeResult + 1);
  await runtime.kick();
  const initialPrompts = main.prompts.length;
  const initialLaunches = launched.length;
  const initialMessages = messenger.sent.length;
  const delivered = main.whenPrompts(initialPrompts + 1);
  runtime.watchPr({ action: "track", ref: "example/project#7", sourceId: original.id, laneId: lane.id, intervalSeconds: 1 });
  await delivered;
  const prompt = main.prompts.at(-1)?.command;
  expect(String(prompt?.message)).toContain("PR_FEEDBACK");
  expect(String(prompt?.message)).toContain("Please correct the parsing boundary.");
  expect(prompt?.streamingBehavior).toBeUndefined();
  expect(launched).toHaveLength(initialLaunches);
  expect(store.lane(lane.id)?.workState).toBe("completed");
  expect(messenger.sent).toHaveLength(initialMessages);
  main.complete("A reviewer requested a parsing correction.");
  await messenger.whenSent(initialMessages + 1);
  expect(messenger.sent.at(-1)?.route).toEqual(original.route);
}, 10_000);

test("runtime shutdown aborts and joins an in-flight PR read without a late observation", async () => {
  const started = Promise.withResolvers<void>();
  let aborted = false;
  const { runtime, store, main } = fixture(3, undefined, {
    readPrSnapshot: async (_ref, { signal }) => {
      started.resolve();
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => { aborted = true; reject(new Error("Read aborted")); }, { once: true });
      });
    },
  });
  await runtime.start();
  store.receive(message("pr-stop"), "main", { "user-source:pr-stop": "true" });
  store.settle("pr-stop", "done");
  runtime.watchPr({ action: "track", ref: "example/project#7", sourceId: "pr-stop", intervalSeconds: 1 });
  await started.promise;
  await runtime.stop();
  expect(aborted).toBe(true);
  expect(main.prompts).toHaveLength(0);
}, 10_000);

describe("source-bound Discord topic management", () => {
  test("selected forum tags reach capability and creation and conflicting source retries never create again", async () => {
    const { runtime, messenger, directory } = fixture();
    messenger.canCreateThread = async (_route, tags) => {
      if (!tags?.includes("101")) throw new DeliveryError("A forum tag is required", "rejected");
      return true;
    };
    await runtime.start();
    const original = headMessage("tagged-topic", route(null));
    await admit(runtime, original);
    const start = { ...selection, sourceId: original.id, title: "Tagged topic", kickoff: "Inspect and verify.", cwd: directory,
      appliedTags: ["101"] };
    const { appliedTags: _tags, ...unselected } = start;
    await expect(runtime.startLane(unselected)).rejects.toThrow("forum tag is required");
    expect(messenger.threads).toEqual([]);
    const lane = await runtime.startLane(start);
    expect(messenger.threadTags).toEqual([["101"]]);
    expect(messenger.threadSources).toEqual([undefined]);
    expect((await runtime.startLane(start)).id).toBe(lane.id);
    await expect(runtime.startLane({ ...start, appliedTags: ["102"] })).rejects.toThrow("intent conflict");
    expect(messenger.threads).toHaveLength(1);
  });

  test("forum tags cannot silently retag an existing bound thread", async () => {
    const { runtime, directory, messenger } = fixture();
    await runtime.start();
    const original = headMessage("existing-topic", route("123"));
    await admit(runtime, original);
    await expect(runtime.startLane({ ...selection, sourceId: original.id, title: "Existing", kickoff: "Inspect.",
      cwd: directory, appliedTags: ["101"] })).rejects.toThrow("lane_thread_update");
    expect(messenger.threads).toEqual([]);
  });

  function managedThread(instance: ReturnType<typeof fixture>) {
    const { store, config, messenger } = instance;
    const lane = savedLane(store, config, "managed-thread", route("123"));
    let current: ThreadInfo = { route: lane.route, title: "Original", archived: false,
      requiresTag: false, availableTags: [{ id: "101", name: "Work", moderated: false }], appliedTags: ["101"] };
    const edits: ThreadUpdate[] = [];
    messenger.inspectThread = async () => structuredClone(current);
    messenger.updateThread = async (destination, changes) => {
      edits.push(changes);
      current = { ...current, route: destination, ...changes };
      return structuredClone(current);
    };
    const source = (id: string) => store.receive(message(id, lane.route), "main", { [`user-source:${id}`]: "true" });
    return { lane, source, edits, current: () => current };
  }

  test("pausing a work thread clears its marker even when the working edit lands late", async () => {
    const instance = fixture();
    const { runtime, messenger } = instance;
    const f = managedThread(instance);
    const apply = messenger.updateThread;
    if (!apply) throw new Error("Missing fixture thread editor");
    const working = Promise.withResolvers<void>();
    const allowWorkingEdit = Promise.withResolvers<void>();
    const cleared = Promise.withResolvers<ThreadInfo>();
    messenger.updateThread = async (destination, changes) => {
      if (changes.title === "⏳ Original") {
        working.resolve();
        await allowWorkingEdit.promise;
      }
      const thread = await apply(destination, changes);
      if (thread.title === "Original") cleared.resolve(thread);
      return thread;
    };
    await runtime.start();
    try {
      await delegate(runtime, message("run-before-pause", f.lane.route));
      await working.promise;
      await runtime.pause(f.lane.id);
    } finally { allowWorkingEdit.resolve(); }
    expect(await cleared.promise).toMatchObject({ route: f.lane.route, title: "Original", archived: false, appliedTags: ["101"] });
  });

  test("rename, retag, archive and reopen leave lane lifecycle intact and old receipts cannot overwrite newer edits", async () => {
    const instance = fixture();
    const { runtime, store } = instance;
    const f = managedThread(instance);
    f.source("archive");
    f.source("reopen");
    const originalLane = store.lane(f.lane.id);
    const archive = { id: f.lane.id, sourceId: "archive", changes: { title: "Done", appliedTags: [], archived: true } };
    expect(await runtime.updateLaneThread(archive)).toMatchObject({ title: "Done", appliedTags: [], archived: true });
    await runtime.updateLaneThread({ id: f.lane.id, sourceId: "reopen", changes: { archived: false } });
    expect(f.current()).toMatchObject({ title: "Done", appliedTags: [], archived: false });
    expect(await runtime.updateLaneThread(archive)).toMatchObject({ archived: true });
    expect(f.current().archived).toBe(false);
    expect(f.edits).toHaveLength(2);
    expect(store.lane(f.lane.id)).toEqual(originalLane);
    expect(await runtime.inspectThread("reopen", f.lane.id)).toMatchObject({ archived: false });
    await expect(runtime.updateLaneThread({ ...archive, changes: { title: "Different" } })).rejects.toThrow("identity conflict");
  });

  test("internal reports, cancelled sources and unauthorized destinations cannot manage threads", async () => {
    const instance = fixture();
    const { runtime, store } = instance;
    const f = managedThread(instance);
    store.receive(message("report", f.lane.route), "main");
    f.source("cancelled");
    store.settle("cancelled", "cancelled");
    store.receive(message("foreign", route("123", { authorityId: "other" })), "main", { "user-source:foreign": "true" });
    for (const sourceId of ["missing", "report", "cancelled", "foreign"])
      await expect(runtime.updateLaneThread({ id: f.lane.id, sourceId, changes: { archived: true } })).rejects.toThrow();
    await expect(runtime.inspectThread("report", f.lane.id)).rejects.toThrow("original received user");
    expect(f.edits).toEqual([]);
  });

  test.each(["rejected", "uncertain", "wrong-route"] as const)("a %s update is retained without replay", async outcome => {
    const instance = fixture();
    const { runtime, messenger, store } = instance;
    const f = managedThread(instance);
    f.source("edit-failure");
    let attempts = 0;
    messenger.updateThread = async () => {
      attempts++;
      if (outcome === "wrong-route") return { ...f.current(), route: route("other") };
      throw new DeliveryError("Update failed", outcome);
    };
    const request = { id: f.lane.id, sourceId: "edit-failure", changes: { archived: true } };
    await expect(runtime.updateLaneThread(request)).rejects.toBeInstanceOf(DeliveryError);
    await expect(runtime.updateLaneThread(request)).rejects.toBeInstanceOf(DeliveryError);
    expect(attempts).toBe(1);
    expect(JSON.parse(store.getMeta(`lane-thread:${f.lane.id}:edit-failure`) ?? "{}").certainty)
      .toBe(outcome === "rejected" ? "rejected" : "uncertain");
  });

  test("an in-flight duplicate cannot issue a second remote edit", async () => {
    const instance = fixture();
    const { runtime, messenger } = instance;
    const f = managedThread(instance);
    f.source("pending-edit");
    const reply = Promise.withResolvers<ThreadInfo>();
    let attempts = 0;
    messenger.updateThread = async () => { attempts++; return reply.promise; };
    const request = { id: f.lane.id, sourceId: "pending-edit", changes: { archived: true } };
    const first = runtime.updateLaneThread(request);
    await expect(runtime.updateLaneThread(request)).rejects.toThrow("pending or uncertain");
    reply.resolve({ ...f.current(), archived: true });
    await first;
    expect(attempts).toBe(1);
  });
});

describe("same-HEAD evidence recovery", () => {
  const nativeEntry = (main: HostTransport, id: string, customType: string, extra: Record<string, unknown> = {}) => ({
    id, type: "custom", customType,
    data: { sessionId: main.state.sessionId, sessionFile: main.state.sessionFile, ...extra },
  });
  function journal(main: HostTransport, requestId: string, outcome = "completed") {
    return [
      nativeEntry(main, "original-start", "rpc_agent_start"),
      { id: "original-user", type: "message", message: { role: "user", content: "Original authorized work" } },
      { id: "original-assistant", type: "message", message: { role: "assistant",
        stopReason: outcome === "completed" ? "stop" : outcome, content: [{ type: "text", text: "Not an acceptance receipt" }] } },
      nativeEntry(main, "original-receipt", "rpc_prompt_result", { frame: { id: requestId, status: outcome, agentInvoked: true } }),
    ];
  }
  function saved(instance: ReturnType<typeof fixture>, id = "held-original") {
    const { store, main } = instance;
    store.receive(message(id, route("original-recovery-route")), "main", { [`user-source:${id}`]: "true" });
    store.submit(id, `native-${id}`, 0);
    store.setMeta(`head-native-owner:${id}`, JSON.stringify({ requestId: `native-${id}`, generation: 0,
      sessionId: main.state.sessionId, sessionFile: main.state.sessionFile, cursor: null }));
    main.entries = journal(main, `native-${id}`);
    main.journalLeaf = true;
    return id;
  }
  function attempt(instance: ReturnType<typeof fixture>, id = "held-original"): HeadRecoveryAttempt {
    return JSON.parse(instance.store.getMeta(`head:recovery:${id}`)!);
  }
  function decision(value: HeadRecoveryAttempt, choice: "release" | "hold" = "release"): HeadRecoveryDecision {
    return { attemptId: value.attemptId, decision: choice, evidenceEntryIds: value.evidenceEntryIds,
      reason: "Exact native receipt and latest attributable run were inspected." };
  }
  function settleControl(instance: ReturnType<typeof fixture>, value: HeadRecoveryAttempt) {
    instance.main.state.isSettled = true;
    instance.main.state.isStreaming = false;
    instance.main.entries.push(nativeEntry(instance.main, `recovery-receipt-${value.attemptId}`, "rpc_prompt_result", {
      frame: { id: value.recoveryRequestId, status: "aborted", agentInvoked: true },
    }));
    instance.main.emit({ type: "prompt_result", id: value.recoveryRequestId, status: "aborted", agentInvoked: true });
    instance.main.emit({ type: "session_settled" });
  }

  test("actual prompt acknowledgement loss uses durable receipts once, fences queued work, and notifies only the original route", async () => {
    const instance = fixture();
    const { runtime, main, store, messenger } = instance;
    main.journalLeaf = true;
    const recoveryStarted = Promise.withResolvers<void>();
    main.onFrame(frame => {
      if (frame.type === "agent_start" && main.prompts.at(-1)?.id.startsWith("sg-recovery-")) recoveryStarted.resolve();
    });
    main.beforePrompt = () => {
      const prompt = main.prompts.at(-1)!;
      if (prompt.id.startsWith("sg-recovery-")) return;
      main.entries = journal(main, prompt.id);
      throw new Error("The original native result was durable before the transport acknowledgement was lost");
    };
    await runtime.start();
    await admit(runtime, headMessage("lost-original", route("original-recovery-route")));
    await recoveryStarted.promise;
    const value = attempt(instance, "lost-original");
    const snapshot = JSON.parse(String(main.prompts[1]!.command.message).split("\n").find(line =>
      line.startsWith("HEAD recovery snapshot: "))!.slice("HEAD recovery snapshot: ".length));
    expect(snapshot).toMatchObject({ attemptId: value.attemptId, inputId: "lost-original",
      evidenceEntryIds: value.evidenceEntryIds, evidence: { outcome: "done", receiptStatus: "completed" } });
    expect(store.input("lost-original")?.state).toBe("uncertain");
    await admit(runtime, headMessage("queued-after-loss", route("later-route")));
    expect(store.input("queued-after-loss")?.state).toBe("pending");
    expect(main.prompts).toHaveLength(2);
    const result = await runtime.decideHeadRecovery(decision(value));
    expect(result.outcome).toBe("done");
    expect(runtime.headRecoveryActive()).toBe(true);
    expect(store.input("lost-original")?.state).toBe("uncertain");
    expect(store.output(`lost-original:recovery:${value.attemptId}`)).toBeNull();
    // Delayed uncorrelated frames cannot overwrite original work with recovery text.
    main.emit({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "INTERNAL RECOVERY ONLY" }] } });
    main.emit({ type: "prompt_result", id: value.requestId, status: "aborted", agentInvoked: true });
    expect(store.input("queued-after-loss")?.state).toBe("pending");
    main.beforePrompt = undefined;
    settleControl(instance, value);
    await main.whenPrompts(3);
    await runtime.kick();
    expect(runtime.headRecoveryActive()).toBe(false);
    expect(store.input("lost-original")?.state).toBe("done");
    expect(store.input("queued-after-loss")?.state).toBe("submitted");
    const recovered = messenger.sent.filter(output => output.id === `lost-original:recovery:${value.attemptId}`);
    expect(recovered).toMatchObject([{ sourceId: "lost-original", route: route("original-recovery-route") }]);
    expect(messenger.sent.map(output => output.text).join("\n")).not.toContain("INTERNAL RECOVERY ONLY");
    main.emit({ type: "session_settled" });
    await runtime.kick();
    expect(main.prompts.filter(prompt => prompt.id.startsWith("sg-recovery-"))).toHaveLength(1);
  });

  test.each(["missing", "wrong-request", "wrong-session", "wrong-file", "latest-error", "foreign-user", "missing-owner"] as const)(
    "%s evidence stays held without model speculation or replay", async scenario => {
      const instance = fixture();
      const id = saved(instance);
      const { main, runtime, store } = instance;
      if (scenario === "missing") main.entries.pop();
      if (scenario === "wrong-request") main.entries = journal(main, "another-native-request");
      if (scenario === "wrong-session" || scenario === "wrong-file") {
        const data = (main.entries.at(-1) as { data: Record<string, unknown> }).data;
        data[scenario === "wrong-session" ? "sessionId" : "sessionFile"] = "other-native-identity";
      }
      if (scenario === "latest-error") main.entries.push(nativeEntry(main, "later-start", "rpc_agent_start"),
        { id: "later-failure", type: "message", message: { role: "assistant", stopReason: "error" } });
      if (scenario === "foreign-user") main.entries.push({ id: "other-user", type: "message", message: { role: "user", content: "Unowned native work" } });
      if (scenario === "missing-owner") store.setMeta(`head-native-owner:${id}`, "");
      await runtime.start();
      await runtime.kick();
      expect(store.input(id)?.state).toBe("uncertain");
      expect(main.prompts).toEqual([]);
      expect(main.abortCount).toBe(0);
      expect(runtime.headRecoveryActive()).toBe(false);
    });

  test.each([
    { isSettled: false, isStreaming: true }, { isCompacting: true }, { queuedMessageCount: 1 },
    { hasPendingAsyncWork: true }, { hasPendingAsyncWork: undefined }, { hasOwnedRunningWork: true },
    { goal: { enabled: true, goal: { id: "other-goal", status: "active" } } },
    { goal: { enabled: false, goal: { id: "paused-goal", status: "paused" } } },
    { pendingUiRequests: [{ id: "native-owner-ui", method: "confirm" }] },
  ] as Partial<RuntimeState>[])("native guard %j prevents any recovery turn", async patch => {
    const instance = fixture();
    const id = saved(instance);
    Object.assign(instance.main.state, patch);
    await instance.runtime.start();
    expect(instance.store.input(id)?.state).toBe("uncertain");
    expect(instance.main.prompts).toEqual([]);
    expect(instance.main.abortCount).toBe(0);
  });

  test("a still-running uncertain original retains its approval route and goal owner", async () => {
    const { runtime, main, store, messenger } = fixture();
    await runtime.start();
    main.beforePrompt = () => {
      main.state.isSettled = false;
      main.state.isStreaming = true;
      main.emit({ type: "agent_start" });
      throw new Error("Original admission acknowledgement was lost while work continued");
    };
    await admit(runtime, headMessage("uncertain-approval-owner", route("original-approval")));
    main.beforePrompt = undefined;
    expect(store.input("uncertain-approval-owner")?.state).toBe("uncertain");
    const request = { type: "extension_ui_request", method: "confirm", id: "original-dialog", title: "Original owner decision" };
    main.state.pendingUiRequests = [request];
    main.emit(request);
    await messenger.whenApproval();
    const approval = [...messenger.shown.values()][0]!;
    expect(approval).toMatchObject({ target: "main", requestId: "original-dialog", route: route("original-approval") });
    expect(main.responses).toEqual([]);
    main.emit({ type: "goal_updated", state: { goal: { id: "original-goal" } } });
    expect(JSON.parse(store.getMeta(`head:goal-source:${main.state.sessionId}:original-goal`)!))
      .toMatchObject({ inputId: "uncertain-approval-owner", requestId: main.prompts[0]!.id });
    await admit(runtime, headMessage("after-uncertain-approval"));
    expect(store.input("after-uncertain-approval")?.state).toBe("pending");
    expect(main.prompts).toHaveLength(1);
    expect(runtime.headRecoveryActive()).toBe(false);
  });

  test.each(["hold", "blocked", "invalid-evidence", "native-abort", "no-decision"] as const)(
    "one isolated %s decision never replays original work", async scenario => {
      const instance = fixture();
      const id = saved(instance);
      if (scenario === "native-abort") instance.main.entries = journal(instance.main, `native-${id}`, "aborted");
      await instance.runtime.start();
      const value = attempt(instance);
      expect(instance.main.prompts).toHaveLength(1);
      if (scenario === "blocked") {
        instance.runtime.blockHeadRecoveryTool();
        await expect(instance.runtime.decideHeadRecovery(decision(value))).rejects.toThrow("unchanged exact native evidence");
      } else if (scenario === "invalid-evidence") {
        await expect(instance.runtime.decideHeadRecovery({ ...decision(value), evidenceEntryIds: ["fabricated"] })).rejects.toThrow("unchanged exact native evidence");
      } else if (scenario !== "no-decision") {
        await instance.runtime.decideHeadRecovery(decision(value, scenario === "hold" ? "hold" : "release"));
      }
      settleControl(instance, value);
      await instance.runtime.kick();
      // Receipt settlement is an event-driven background drain. Joining the
      // original-route outbox send proves its commit without polling.
      await instance.messenger.whenSent(2);
      expect(instance.store.input(id)?.state).toBe(scenario === "native-abort" ? "cancelled" : "uncertain");
      expect(instance.store.output(`${id}:recovery:${value.attemptId}`)).toMatchObject({
        sourceId: id, route: route("original-recovery-route"), state: "sent",
      });
      instance.main.emit({ type: "session_settled" });
      await instance.runtime.kick();
      expect(instance.main.prompts).toHaveLength(1);
    });

  test.each(["resolve", "stop", "changed-run"] as const)("a concurrent %s wins over a stale decision", async race => {
    const instance = fixture();
    const id = saved(instance);
    await instance.runtime.start();
    const value = attempt(instance);
    if (race === "changed-run") {
      instance.main.beforeEntries = () => {
        instance.main.beforeEntries = undefined;
        instance.main.entries.push(nativeEntry(instance.main, "foreign-run", "rpc_agent_start"));
        instance.main.emit({ type: "agent_start" });
      };
    } else {
      await admit(instance.runtime, message(`manual-${race}`, route("control-route"),
        race === "resolve" ? `/resolve ${id}` : "/stop head"));
    }
    await expect(instance.runtime.decideHeadRecovery(decision(value))).rejects.toThrow();
    expect(instance.store.input(id)?.state).toBe(race === "resolve" ? "cancelled" : "uncertain");
    expect(instance.store.output(`${id}:recovery:${value.attemptId}`)).toBeNull();
    expect(instance.main.prompts).toHaveLength(1);
  });

  test.each(["foreign-run", "stop", "effect"] as const)("a %s after the proposal prevents final release", async change => {
    const instance = fixture();
    const id = saved(instance);
    await instance.runtime.start();
    const value = attempt(instance);
    await instance.runtime.decideHeadRecovery(decision(value));
    expect(instance.store.input(id)?.state).toBe("uncertain");
    if (change === "foreign-run") {
      instance.main.entries.push(nativeEntry(instance.main, "later-native-start", "rpc_agent_start"),
        { id: "later-native-error", type: "message", message: { role: "assistant", stopReason: "error" } });
    } else if (change === "stop") {
      await admit(instance.runtime, message("stop-after-proposal", route("owner-control"), "/stop head"));
    } else {
      instance.store.queueOutput({ id: "late-ambiguous-effect", sourceId: id, route: route("original-recovery-route"), text: "Original effect" });
      instance.store.claimOutput("late-ambiguous-effect");
      instance.store.finishOutput("late-ambiguous-effect", "uncertain");
    }
    settleControl(instance, value);
    await instance.messenger.whenSent(change === "stop" ? 3 : 2);
    expect(instance.store.input(id)?.state).toBe("uncertain");
    expect(attempt(instance)).toMatchObject({ state: "settled", decision: { decision: "hold" } });
    expect(instance.runtime.headRecoveryActive()).toBe(false);
    expect(instance.main.prompts).toHaveLength(1);
  });

  test("an interrupted prepared/submitted recovery binding is never resent without its exact receipt", async () => {
    const instance = fixture();
    const id = saved(instance);
    const prepared: HeadRecoveryAttempt = {
      attemptId: "interrupted-attempt", inputId: id, requestId: `native-${id}`, generation: 0,
      sessionId: instance.main.state.sessionId, sessionFile: instance.main.state.sessionFile!,
      hostPid: process.pid, recoveryRequestId: "lost-recovery-rpc", stopBoundary: null, cursor: null,
      promptDigest: "interrupted-prompt-digest",
      boundary: "original-receipt", evidenceEntryIds: ["original-receipt"], evidenceFingerprint: "persisted-before-send",
      state: "prepared",
    };
    instance.store.settle(id, "uncertain");
    expect(instance.store.prepareHeadRecovery(prepared)).toBe(true);
    await instance.runtime.start();
    expect(instance.runtime.headRecoveryActive()).toBe(true);
    expect(instance.main.prompts).toEqual([]);
    instance.main.emit({ type: "prompt_result", id: "not-the-recovery", status: "completed", agentInvoked: true });
    await instance.runtime.kick();
    expect(instance.runtime.headRecoveryActive()).toBe(true);
    settleControl(instance, prepared);
    await instance.runtime.kick();
    expect(instance.main.prompts).toEqual([]);
    expect(instance.store.input(id)?.state).toBe("uncertain");
  });

  test("a newly journaled original receipt triggers recovery, while duplicate unchanged events dispatch only once", async () => {
    const instance = fixture();
    const id = saved(instance);
    const receipt = instance.main.entries.pop();
    await instance.runtime.start();
    expect(instance.main.prompts).toEqual([]);
    instance.main.entries.push(receipt);
    instance.main.emit({ type: "prompt_result", id: `native-${id}`, status: "completed", agentInvoked: true });
    instance.main.emit({ type: "session_settled" });
    await instance.main.whenPrompts(1);
    instance.main.emit({ type: "prompt_result", id: `native-${id}`, status: "completed", agentInvoked: true });
    await instance.runtime.kick();
    expect(instance.main.prompts).toHaveLength(1);
    expect(instance.store.input(id)?.state).toBe("uncertain");
  });

  test("lost recovery transport after decision binding reconciles its exact durable receipt on reconnect without resending", async () => {
    const instance = fixture();
    const id = saved(instance);
    const { runtime, main, store, hosts, config } = instance;
    main.beforePrompt = async () => {
      const prompt = main.prompts.at(-1)!;
      const value = attempt(instance);
      main.entries.push(nativeEntry(main, "recovery-start", "rpc_agent_start"),
        { id: "recovery-user", type: "message", message: { role: "user", content: prompt.command.message } });
      main.state.isSettled = false;
      main.state.isStreaming = true;
      await runtime.decideHeadRecovery(decision(value));
      main.state.isSettled = true;
      main.state.isStreaming = false;
      throw new Error("Recovery decision and native receipt were durable before connection loss");
    };
    await runtime.start();
    expect(store.input(id)?.state).toBe("uncertain");
    expect(runtime.headRecoveryActive()).toBe(true);
    await admit(runtime, headMessage("after-recovery-reconnect"));
    expect(store.input("after-recovery-reconnect")?.state).toBe("pending");
    const replacement = new HostTransport(main.state.sessionFile!, main.state.sessionId);
    replacement.entries = structuredClone(main.entries);
    replacement.entries.push(nativeEntry(main, "recovery-durable-receipt", "rpc_prompt_result", {
      frame: { id: attempt(instance).recoveryRequestId, status: "aborted", agentInvoked: true },
    }));
    replacement.journalLeaf = true;
    hosts.set(hostPaths(config, "main").socketPath, replacement);
    await main.close();
    await replacement.whenPrompts(1);
    expect(runtime.headRecoveryActive()).toBe(false);
    expect(store.input(id)?.state).toBe("done");
    expect(store.input("after-recovery-reconnect")?.state).toBe("submitted");
    expect(main.prompts).toHaveLength(1);
    expect(replacement.prompts.some(prompt => prompt.id.startsWith("sg-recovery-"))).toBe(false);
    expect(attempt(instance).state).toBe("settled");
  });

  test.each(["unadmitted", "proposed"] as const)("owner resolve abandons a receipt-less %s recovery only after native quiescence", async stage => {
    const instance = fixture();
    const id = saved(instance);
    instance.main.beforePrompt = async () => {
      if (stage === "proposed") {
        const prompt = instance.main.prompts.at(-1)!;
        instance.main.entries.push(nativeEntry(instance.main, "recovery-start", "rpc_agent_start"),
          { id: "recovery-user", type: "message", message: { role: "user", content: prompt.command.message } });
        instance.main.state.isSettled = false;
        instance.main.state.isStreaming = true;
        await instance.runtime.decideHeadRecovery(decision(attempt(instance)));
        instance.main.state.isSettled = true;
        instance.main.state.isStreaming = false;
      }
      throw new Error("Recovery control has no observable native receipt");
    };
    await instance.runtime.start();
    const value = attempt(instance);
    expect(instance.runtime.headRecoveryActive()).toBe(true);
    expect(instance.store.input(id)?.state).toBe("uncertain");
    expect(instance.main.entries.some(entry => (entry as { id?: string }).id === `start-${value.recoveryRequestId}`)).toBe(false);
    instance.main.state.hasOwnedRunningWork = true;
    await admit(instance.runtime, message("resolve-receiptless", route("owner-route"), `/resolve ${id}`));
    expect(instance.store.input(id)?.state).toBe("cancelled");
    expect(instance.runtime.headRecoveryActive()).toBe(true);
    instance.main.state.hasOwnedRunningWork = false;
    instance.main.beforePrompt = undefined;
    instance.main.emit({ type: "session_settled" });
    await admit(instance.runtime, headMessage("work-after-abandonment"));
    await instance.main.whenPrompts(2);
    expect(instance.runtime.headRecoveryActive()).toBe(false);
    expect(attempt(instance)).toMatchObject({ attemptId: value.attemptId, state: "held", abandonedByOwner: true });
    expect(instance.store.input("work-after-abandonment")?.state).toBe("submitted");
    expect(instance.main.prompts.filter(prompt => prompt.id.startsWith("sg-recovery-"))).toHaveLength(1);
  });
});

describe("event-driven nonterminal progress", () => {
  test("structured lane observations reach inspect/status without repeated chatter resetting evidence or waiting clocks", async () => {
    const { runtime, config, store, hosts, main, messenger } = fixture();
    const lane = savedLane(store, config, "structured-progress", route("work-topic"));
    await runtime.start();
    await admit(runtime, headMessage("structured-busy-head", route("other-topic")));
    await delegate(runtime, message("structured-source", lane.route));
    const worker = hosts.get(lane.socketPath)!;
    const input = delegated(store, "structured-source")!;
    const emit = (id: string, report: LaneReport, timestamp: number) => {
      const details = { type: "superagent-lane-report", sessionId: worker.state.sessionId, reportId: id, report };
      worker.emit({
        type: "message_end", message: { role: "toolResult", toolName: id === "proof" ? "write" : "lane_report", toolCallId: id, timestamp,
          details: id === "proof" ? { xdev: { tool: "lane_report", mode: "execute", inner: details } } : details },
      });
    };
    const now = Date.now();
    const progress: LaneReport = { status: "progress", summary: "Selected result artifact changed",
      evidence: [{ kind: "file", ref: "/workspace/result", fingerprint: "a".repeat(64) }] };
    emit("proof", progress, now - 1000);
    emit("same-proof", progress, now - 900);
    const waiting: LaneReport = { status: "waiting", summary: "Native verification is running",
      waiting: { kind: "tool", id: "verification", target: "Native verification command" }, evidence: [] };
    emit("wait", waiting, now - 800);
    emit("same-wait", waiting, now - 700);
    worker.emit({ type: "message_end", message: { role: "assistant", stopReason: "toolUse",
      content: [{ type: "text", text: "Still waiting; this is not new proof." }] } });
    await runtime.kick();
    const inspection = await runtime.inspect(lane.id);
    expect(inspection).toMatchObject({ observation: {
      inputId: input.id, requestId: input.requestId, sessionId: worker.state.sessionId,
      lastEvidenceAt: now - 1000, waiting: { since: now - 800, target: waiting.waiting },
    }, observationState: { ownerCurrent: true } });
    expect("observationState" in inspection && inspection.observationState?.waitingAgeMs).toBeGreaterThanOrEqual(800);
    await admit(runtime, message("structured-status", lane.route, "/status"));
    const status = messenger.sent.find(output => output.sourceId === "structured-status")!.text;
    expect(status).toContain("Recorded lane observation (not verified acceptance or live-target proof)");
    expect(status).toContain("Native verification command");
    expect(status).toContain('"ownerCurrent":true');
    worker.emit({ type: "tool_execution_end", toolName: "bash", toolCallId: "other-verification", isError: false });
    expect(store.lane(lane.id)?.observation?.waiting?.since).toBe(now - 800);
    worker.emit({ type: "tool_execution_end", toolName: "bash", toolCallId: "verification", isError: true });
    expect(store.lane(lane.id)?.observation).toMatchObject({ waiting: null, lastEvidenceAt: now - 1000 });
    expect(store.input(input.id)?.state).toBe("submitted");
    expect(worker.prompts).toHaveLength(1);
    expect(main.prompts).toHaveLength(1);
    expect(store.lane(lane.id)?.workState).toBe("open");
  });

  test("native eval reports use exclusive append-order journal suffixes, not printed receipt text", async () => {
    const { runtime, config, store, hosts, errors } = fixture();
    const lane = savedLane(store, config, "eval-observation", route("work-topic"));
    await runtime.start();
    await admit(runtime, headMessage("eval-observation-head", route("other-topic")));
    await delegate(runtime, message("eval-observation-source", lane.route));
    const worker = hosts.get(lane.socketPath)!;
    const report: LaneReport = { status: "waiting", summary: "Native eval owns this dependency",
      waiting: { kind: "dependency", target: "Selected verification artifact" }, evidence: [] };
    const event = { type: "superagent-lane-report", sessionId: worker.state.sessionId, reportId: "js-lane_report-native", report };
    worker.emit({ type: "message_end", message: { role: "toolResult", toolName: "eval", toolCallId: "printed-only",
      content: [{ type: "text", text: JSON.stringify(event) }] } });
    await runtime.kick();
    expect(store.lane(lane.id)?.observation).toBeUndefined();
    worker.entries.push({ id: "native-eval-receipt", type: "custom", customType: "superagent-lane-report",
      timestamp: new Date(1000).toISOString(), data: event });
    worker.emit({ type: "message_end", message: { role: "toolResult", toolName: "eval", toolCallId: "actual-eval",
      timestamp: 2000, content: [{ type: "text", text: "No structured result forwarded by the eval bridge" }] } });
    await runtime.kick();
    expect(store.lane(lane.id)?.observation).toMatchObject({ waiting: { since: 1000, target: report.waiting }, lastEvidenceAt: null });
    worker.entries.push({ id: "native-eval-duplicate", type: "custom", customType: "superagent-lane-report",
      timestamp: new Date(3000).toISOString(), data: { ...event, reportId: "js-lane_report-repeated" } });
    worker.emit({ type: "message_end", message: { role: "toolResult", toolName: "eval", toolCallId: "next-eval", timestamp: 4000 } });
    await runtime.kick();
    expect(store.lane(lane.id)?.observation).toMatchObject({ waiting: { since: 1000 }, lastReportAt: 3000 });
    worker.entries.push(
      { id: "first-appended", type: "custom", customType: "superagent-lane-report",
        timestamp: new Date(4500).toISOString(), data: { ...event, reportId: "first-appended",
          report: { ...report, waiting: { kind: "dependency", target: "First appended target" } } } },
      { id: "last-appended", type: "custom", customType: "superagent-lane-report",
        timestamp: new Date(4100).toISOString(), data: { ...event, reportId: "last-appended",
          report: { ...report, waiting: { kind: "dependency", target: "Last appended target" } } } },
    );
    worker.emit({ type: "message_end", message: { role: "toolResult", toolName: "eval", toolCallId: "append-order", timestamp: 4700 } });
    await runtime.kick();
    expect(store.lane(lane.id)?.observation).toMatchObject({
      waiting: { since: 4100, target: { kind: "dependency", target: "Last appended target" } }, lastReportAt: 4100,
    });
    worker.entries.push({ id: "earlier-hidden-report", type: "custom", customType: "superagent-lane-report",
      timestamp: new Date(5000).toISOString(), data: { ...event, reportId: "earlier-hidden",
        report: { ...report, waiting: { kind: "dependency", target: "Earlier hidden target" } } } });
    worker.emit({ type: "message_end", message: { role: "toolResult", toolName: "lane_report", toolCallId: "later-direct", timestamp: 6000,
      details: { ...event, reportId: "later-direct", report: { ...report, waiting: { kind: "dependency", target: "Latest direct target" } } } } });
    await runtime.kick();
    expect(store.lane(lane.id)?.observation).toMatchObject({
      waiting: { since: 6000, target: { kind: "dependency", target: "Latest direct target" } }, lastReportAt: 6000,
    });
    expect(worker.commands.filter(command => command.type === "get_entries").map(command => command.since)).toEqual([
      undefined, undefined, "native-eval-receipt", "native-eval-duplicate", "last-appended",
    ]);
    expect(worker.prompts).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  test("a missing native lane observation cursor blocks both journal and direct reports", async () => {
    const { runtime, config, store, hosts, errors } = fixture();
    const lane = savedLane(store, config, "missing-observation-cursor", route("work-topic"));
    await runtime.start();
    await admit(runtime, headMessage("missing-observation-head", route("other-topic")));
    await delegate(runtime, message("missing-observation-source", lane.route));
    const worker = hosts.get(lane.socketPath);
    if (!worker) throw new Error("Missing native lane owner");
    const report = (id: string, target: string, timestamp: number) => ({
      role: "toolResult", toolName: "lane_report", toolCallId: id, timestamp,
      details: { type: "superagent-lane-report", sessionId: worker.state.sessionId, reportId: id,
        report: { status: "waiting", summary: "Waiting for native evidence", waiting: { kind: "dependency", target }, evidence: [] } },
    });
    worker.entries.push({ id: "original-cursor", type: "message", message: report("original", "Original target", 1000) });
    worker.emit({ type: "message_end", message: report("original", "Original target", 1000) });
    await runtime.kick();
    const before = store.lane(lane.id)?.observation;
    expect(before?.waiting).toMatchObject({ since: 1000, target: { kind: "dependency", target: "Original target" } });

    worker.entries = [{ id: "unanchored-entry", type: "message", message: report("unanchored", "Unanchored journal target", 2000) }];
    worker.emit({ type: "message_end", message: report("direct", "Unanchored direct target", 3000) });
    await runtime.kick();
    expect(store.lane(lane.id)?.observation).toEqual(before);
    expect(worker.commands.filter(command => command.type === "get_entries").map(command => command.since))
      .toEqual([undefined, "original-cursor"]);
    expect(errors.map(error => error instanceof Error ? error.message : error)).toEqual(["Native observation journal cursor is unavailable"]);
  });

  test("structured report identity/role rejection and pause fences preserve the last recorded observation", async () => {
    const { runtime, config, store, hosts, errors } = fixture();
    const lane = savedLane(store, config, "structured-fence", route("work-topic"));
    await runtime.start();
    await admit(runtime, headMessage("structured-fence-head", route("other-topic")));
    await delegate(runtime, message("structured-fence-source", lane.route));
    const worker = hosts.get(lane.socketPath)!;
    const report: LaneReport = { status: "waiting", summary: "Owner decision pending",
      waiting: { kind: "approval", id: "native-approval", target: "Native tool permission" }, evidence: [] };
    const reportMessage = { role: "toolResult", toolName: "lane_report", toolCallId: "wait", timestamp: 1000,
      details: { type: "superagent-lane-report", sessionId: worker.state.sessionId, reportId: "wait", report } };
    worker.emit({ type: "message_end", message: reportMessage });
    await runtime.kick();
    const before = store.lane(lane.id)?.observation;
    for (const invalid of [
      { ...reportMessage, toolName: "read", toolCallId: "quoted-fake" },
      { ...reportMessage, details: { ...reportMessage.details, sessionId: "foreign-session" } },
      { ...reportMessage, details: { ...reportMessage.details, reportId: "foreign-call" } },
      { ...reportMessage, isError: true },
    ]) worker.emit({ type: "message_end", message: invalid });
    await runtime.kick();
    expect(store.lane(lane.id)?.observation).toEqual(before);
    worker.emit({ type: "tool_execution_start", toolName: "bash", toolCallId: "unrelated-approval" });
    expect(store.lane(lane.id)?.observation?.waiting).not.toBeNull();
    worker.emit({ type: "tool_execution_start", toolName: "bash", toolCallId: "native-approval" });
    expect(store.lane(lane.id)?.observation).toMatchObject({ waiting: null, lastEvidenceAt: null });
    await runtime.pause(lane.id);
    const paused = store.lane(lane.id)?.observation;
    worker.emit({ type: "message_end", message: { ...reportMessage, toolCallId: "late", details: { ...reportMessage.details, reportId: "late" } } });
    expect(store.lane(lane.id)?.observation).toEqual(paused);
    expect(await runtime.inspect(lane.id)).toMatchObject({ observationState: { ownerCurrent: false } });
    store.nextGeneration(lane.id);
    worker.emit({ type: "message_end", message: { ...reportMessage, toolCallId: "obsolete", details: { ...reportMessage.details, reportId: "obsolete" } } });
    expect(store.lane(lane.id)?.observation).toEqual(paused);
    expect(errors).toEqual([]);
  });

  test.each(["toolUse", "commentary"] as const)("HEAD sends %s progress before completion once and never repeats it as final fallback", async kind => {
    const { runtime, main, messenger, store } = fixture();
    await runtime.start();
    const original = headMessage(`head-${kind}-progress`, route("original-topic"));
    await admit(runtime, original);
    const progress = { role: "assistant", stopReason: kind === "toolUse" ? "toolUse" : "stop", content: [
      { type: "thinking", thinking: "Private reasoning" },
      { type: "text", text: "Located the defect; applying the bounded fix.",
        ...(kind === "commentary" ? { textSignature: JSON.stringify({ v: 1, id: "native-progress", phase: "commentary" }) } : {}) },
      ...(kind === "toolUse" ? [{ type: "toolCall", id: "native-tool", name: "read", arguments: {} }] : []),
    ] };
    main.emit({ type: "message_end", message: progress });
    await messenger.whenSent(1);
    expect(store.input(original.id)?.state).toBe("submitted");
    expect(main.state.isSettled).toBe(false);
    expect(messenger.sent).toMatchObject([{ sourceId: original.id, route: original.route,
      text: "Located the defect; applying the bounded fix." }]);
    main.emit({ type: "message_end", message: structuredClone(progress) });
    main.emit({ type: "agent_end", isTerminal: true, messages: [progress, { role: "assistant", stopReason: "stop", content: [] }] });
    main.complete("");
    await runtime.kick();
    expect(store.input(original.id)?.state).toBe("done");
    expect(store.output(`${original.id}:answer`)).toBeNull();
    expect(messenger.attempted).toHaveLength(1);
    expect(main.prompts).toHaveLength(1);
  });

  test("mixed native commentary and final text retain only the independent final answer", async () => {
    const { runtime, main, messenger, store } = fixture();
    await runtime.start();
    const original = headMessage("mixed-native-progress");
    await admit(runtime, original);
    const mixed = { role: "assistant", stopReason: "stop", content: [
      { type: "text", text: "Verification is running.", textSignature: JSON.stringify({ v: 1, id: "comment", phase: "commentary" }) },
      { type: "text", text: "Verified final result.", textSignature: JSON.stringify({ v: 1, id: "answer", phase: "final_answer" }) },
    ] };
    main.emit({ type: "message_end", message: mixed });
    await messenger.whenSent(1);
    main.emit({ type: "agent_end", isTerminal: true, messages: [mixed] });
    main.complete("");
    await messenger.whenSent(2);
    expect(messenger.sent.map(output => output.text)).toEqual(["Verification is running.", "Verified final result."]);
    expect(store.output(`${original.id}:answer`)?.text).toBe("Verified final result.");
  });

  test("lane progress reaches the head-selected work thread before completion and final remains independent", async () => {
    const { runtime, main, messenger, store, directory, hosts } = fixture();
    await runtime.start();
    const original = headMessage("progress-parent-source", route(null));
    await admit(runtime, original);
    const lane = await runtime.startLane({ ...selection, sourceId: original.id, title: "Progress work",
      kickoff: "I will inspect, implement, and verify this work in its own topic.", cwd: directory });
    await runtime.kick();
    main.complete("");
    await runtime.kick();
    const worker = hosts.get(lane.socketPath)!;
    const handoffId = `handoff:${original.id}:lane`;
    const beforeProgress = messenger.sent.length;
    const progress = { role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "Confirmed the root cause; implementation continues." }] };
    worker.emit({ type: "message_end", message: progress });
    await main.whenPrompts(2);
    const receipt = store.inputs("main").find(input => input.id.startsWith(`progress:${handoffId}:`))!;
    expect(receipt).toMatchObject({ route: lane.route, state: "submitted", messageId: original.messageId, workflow: null });
    expect(receipt.text).toContain(`sourceId: ${original.id}`);
    expect(receipt.text).toContain("untrusted");
    expect(receipt.text).toContain("not completion, acceptance, approval, or permission for new dispatch");
    expect(store.input(handoffId)?.state).toBe("submitted");
    expect(worker.state.isSettled).toBe(false);
    expect(messenger.sent).toHaveLength(beforeProgress);
    main.complete("Root cause identified; implementation is still underway.");
    await messenger.whenSent(beforeProgress + 1);
    expect(messenger.sent.at(-1)).toMatchObject({ sourceId: receipt.id, route: lane.route,
      text: "Root cause identified; implementation is still underway." });
    worker.emit({ type: "message_end", message: structuredClone(progress) });
    await runtime.kick();
    expect(main.prompts).toHaveLength(2);
    worker.complete("Independent verified final result.");
    await main.whenPrompts(3);
    const finalId = `report:${handoffId}`;
    expect(store.input(finalId)?.text).toContain("Independent verified final result.");
    expect(store.input(finalId)?.text).not.toContain("Confirmed the root cause");
    main.complete("Verified work is complete.");
    await messenger.whenSent(beforeProgress + 2);
    expect(messenger.sent.at(-1)).toMatchObject({ sourceId: finalId, route: lane.route, text: "Verified work is complete." });
    expect(worker.prompts).toHaveLength(1);
  });

  test("busy HEAD coalesces lane progress to the latest meaningful observation without steering or redispatch", async () => {
    const { runtime, config, store, hosts, main, messenger } = fixture();
    const lane = savedLane(store, config, "busy-progress", route("work-topic"));
    await runtime.start();
    await admit(runtime, headMessage("busy-head-source", route("other-topic")));
    await delegate(runtime, message("busy-lane-source", lane.route));
    const worker = hosts.get(lane.socketPath)!;
    for (const text of ["Initial inspection complete.", "Root cause identified.", "Fix implemented; verification running."]) {
      worker.emit({ type: "message_end", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "text", text }] } });
    }
    await runtime.kick();
    const pending = store.inputs("main").filter(input => input.id.startsWith("progress:"));
    expect(pending).toHaveLength(1);
    expect(pending[0]?.text).toContain("Fix implemented; verification running.");
    expect(main.prompts).toHaveLength(1);
    main.complete("Unrelated head answer.");
    await main.whenPrompts(2);
    expect(main.prompts[1]?.command.message).toContain("Fix implemented; verification running.");
    expect(main.prompts[1]?.command.message).not.toContain("Initial inspection complete.");
    expect(main.prompts[1]?.command.streamingBehavior).toBeUndefined();
    main.complete("Verification is still running.");
    await messenger.whenSent(2);
    expect(messenger.sent[1]).toMatchObject({ route: lane.route, text: "Verification is still running." });
    expect(store.input(`handoff:busy-lane-source:${lane.id}`)?.state).toBe("submitted");
    expect(worker.prompts).toHaveLength(1);
  });

  test("pending progress is superseded by final report while HEAD remains busy", async () => {
    const { runtime, config, store, hosts, main, messenger } = fixture();
    const lane = savedLane(store, config, "final-supersedes", route("work-topic"));
    await runtime.start();
    await admit(runtime, headMessage("busy-final-head", route("other-topic")));
    await delegate(runtime, message("busy-final-lane", lane.route));
    const worker = hosts.get(lane.socketPath)!;
    worker.emit({ type: "message_end", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "Older pending progress." }] } });
    await runtime.kick();
    const receipt = store.inputs("main").find(input => input.id.startsWith("progress:"))!;
    worker.complete("Verified final supersedes older progress.");
    await runtime.kick();
    main.complete("Unrelated answer.");
    await main.whenPrompts(2);
    expect(store.input(receipt.id)?.state).toBe("cancelled");
    expect(main.prompts[1]?.command.message).toContain("Verified final supersedes older progress.");
    expect(main.prompts[1]?.command.message).not.toContain("Older pending progress.");
    main.complete("Final result.");
    await messenger.whenSent(2);
    expect(messenger.sent.some(output => output.text.includes("Older pending progress"))).toBe(false);
    expect(main.prompts).toHaveLength(2);
  });

  test("failed, aborted, empty, thinking, tool results and raw final messages never generate lane progress", async () => {
    const { runtime, config, store, hosts, main, messenger } = fixture();
    const lane = savedLane(store, config, "excluded-progress", route("work-topic"));
    await runtime.start();
    await delegate(runtime, message("excluded-lane-source", lane.route));
    const worker = hosts.get(lane.socketPath)!;
    for (const message of [
      { role: "assistant", stopReason: "error", content: [{ type: "text", text: "Private failed text" }] },
      { role: "assistant", stopReason: "aborted", content: [{ type: "text", text: "Private aborted text" }] },
      { role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: " \n\t" }] },
      { role: "assistant", stopReason: "toolUse", content: [{ type: "thinking", thinking: "Private thought" }] },
      { role: "toolResult", content: [{ type: "text", text: "Untrusted tool result" }] },
      { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Raw final answer" }] },
      { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Malformed signature", textSignature: "{not JSON" }] },
    ]) worker.emit({ type: "message_end", message });
    await runtime.kick();
    expect(main.prompts).toHaveLength(0);
    expect(messenger.sent).toEqual([]);
    expect(store.inputs("main").filter(input => input.id.startsWith("progress:"))).toEqual([]);
    expect(store.input(`handoff:excluded-lane-source:${lane.id}`)?.state).toBe("submitted");
    worker.complete("Independent final answer.");
    await main.whenPrompts(1);
    expect(main.prompts[0]?.command.message).toContain("Independent final answer.");
    main.complete("Head final answer.");
    await messenger.whenSent(1);
    expect(messenger.sent[0]?.text).toBe("Head final answer.");
  });

  test("invalid progress delivery bindings are contained without breaking native frame observers", async () => {
    const { runtime, config, store, hosts, main, messenger, errors } = fixture();
    const lane = savedLane(store, config, "invalid-progress-route", route("work-topic"));
    await runtime.start();
    const original = message("invalid-progress-source", lane.route);
    await delegate(runtime, original);
    store.setMeta(`head-delivery:${original.id}`, JSON.stringify({
      source: original.route, destination: route("unrelated-topic"), laneId: lane.id,
    }));
    const worker = hosts.get(lane.socketPath)!;
    let observed = false;
    worker.onFrame(() => { observed = true; });
    expect(() => worker.emit({ type: "message_end", message: {
      role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "Progress must not escape its source." }],
    } })).not.toThrow();
    expect(observed).toBe(true);
    expect(errors.map(error => String(error))).toEqual([expect.stringContaining("Invalid head-selected delivery binding")]);
    expect(store.inputs("main").filter(input => input.id.startsWith("progress:"))).toEqual([]);
    expect(store.input(`handoff:${original.id}:${lane.id}`)?.state).toBe("submitted");
    expect(main.prompts).toHaveLength(0);
    expect(messenger.sent).toEqual([]);
  });
});

describe("topic-owned lane delivery", () => {
  function placeTopicInput(store: Store, lane: Lane, source: Inbound, selectedDestination = false): string {
    const handoffId = `handoff:${source.id}:${selectedDestination ? "lane" : lane.id}`;
    store.receive(source, null, { [`user-source:${source.id}`]: "true", [`topic-owner:${source.id}`]: lane.id });
    store.receive({ ...source, id: handoffId, route: lane.route }, lane.id, {
      [`handoff-source:${handoffId}`]: source.id,
      ...(selectedDestination ? { [`head-delivery:${source.id}`]: JSON.stringify({
        source: source.route, destination: lane.route, laneId: lane.id,
      }) } : {}),
    });
    store.settle(source.id, "done");
    return handoffId;
  }

  test("a topic sends deduplicated commentary and one consolidated answer while HEAD is busy", async () => {
    const { runtime, config, store, hosts, main, messenger } = fixture();
    const lane = savedLane(store, config, "topic-delivery", route("44"));
    const original = message("topic-original", lane.route, "Check the invoice totals.");
    await runtime.start();
    await admit(runtime, headMessage("busy-head-manager", route(null), "Review coordination work."));
    await admit(runtime, original);
    const handoffId = `handoff:${original.id}:${lane.id}`;
    const worker = hosts.get(lane.socketPath)!;
    const report: LaneReport = { status: "waiting", summary: "Waiting on an internal artifact",
      waiting: { kind: "dependency", target: "Verification artifact" }, evidence: [] };
    worker.emit({ type: "message_end", message: { role: "toolResult", toolName: "lane_report", toolCallId: "wait",
      timestamp: 1000, details: { type: "superagent-lane-report", sessionId: worker.state.sessionId, reportId: "wait", report } } });
    const commentary = { role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "The totals are being checked." }] };
    worker.emit({ type: "message_end", message: commentary });
    worker.emit({ type: "message_end", message: structuredClone(commentary) });
    await messenger.whenSent(1);

    const revision = message("topic-joined", lane.route, "Include the revised bill.");
    await admit(runtime, revision);
    const joinedId = `handoff:${revision.id}:${lane.id}`;
    expect(worker.prompts[1]?.command.streamingBehavior).toBe("steer");
    worker.complete("Both sets of totals match.", 0);
    worker.complete("Both sets of totals match.", 1);
    await messenger.whenSent(2);
    await runtime.kick();

    expect(store.lane(lane.id)?.observation?.waiting?.target).toEqual(report.waiting);
    expect([store.input(handoffId)?.state, store.input(joinedId)?.state]).toEqual(["done", "done"]);
    const replyTo = { route: original.route, messageId: original.messageId };
    expect(messenger.sent).toMatchObject([
      { sourceId: original.id, route: original.route, replyTo, text: "The totals are being checked." },
      { id: `${handoffId}:answer`, sourceId: original.id, route: original.route, replyTo, text: "Both sets of totals match." },
    ]);
    expect(store.inputs("main").map(input => input.id)).toEqual(["busy-head-manager"]);
    expect(main.prompts).toHaveLength(1);
  });

  test("pending topic commentary does not escape a newer milestone or an uncertain settlement", () => {
    const { config, store } = fixture();
    const lane = savedLane(store, config, "topic-held", route("44"), process.pid);
    const original = message("topic-held-original", lane.route);
    const inputId = placeTopicInput(store, lane, original);
    const sessionId = `session-${lane.id}`;
    store.submit(inputId, "native-topic-held", lane.generation);
    store.progress(inputId, lane.generation, sessionId, "older", "Earlier milestone");
    store.progress(inputId, lane.generation, sessionId, "newer", "Later milestone");
    expect(store.claimOutput(`progress:${inputId}:older`)).toBe(false);

    store.settle(inputId, "uncertain", { id: `${inputId}:connection`, text: "The run is held; it was not replayed." });

    expect(store.claimOutput(`progress:${inputId}:newer`)).toBe(false);
    expect(store.outputs()).toMatchObject([{ id: `${inputId}:connection`, sourceId: original.id, route: original.route,
      text: "The run is held; it was not replayed." }]);
    expect(store.input(inputId)?.state).toBe("uncertain");
    expect(store.inputs("main")).toEqual([]);
  });

  test("repeated topic revisions retain the delivery selected in a sibling thread", async () => {
    const { runtime, config, directory, store, hosts, main, messenger } = fixture();
    const originalLane = savedLane(store, config, "revision-origin", route("44"));
    const cwd = join(directory, "sibling-workspace");
    mkdirSync(cwd);
    const original = message("revision-original", originalLane.route, `cwd: ${cwd}\nInvestigate the invoice.`);
    await runtime.start();
    await admit(runtime, original);
    const siblingRoute = messenger.threads[0];
    if (!siblingRoute) throw new Error("Workspace change did not create a sibling thread");
    const sibling = store.laneForRoute(siblingRoute);
    if (!sibling) throw new Error("Missing sibling lane");
    const worker = hosts.get(sibling.socketPath);
    if (!worker) throw new Error("Missing sibling Host");
    const baseline = messenger.sent.length;
    worker.complete("Original invoice inspected.");
    await messenger.whenSent(baseline + 1);

    const revisions = [
      { id: "revision-first", task: "Include the February bill.", answer: "February bill checked." },
      { id: "revision-second", task: "Also include the March bill.", answer: "March bill checked." },
    ];
    for (const [index, revision] of revisions.entries()) {
      await admit(runtime, { ...original, id: revision.id, text: `cwd: ${cwd}\n${revision.task}` });
      await worker.whenPrompts(index + 2);
      worker.complete(revision.answer);
      await messenger.whenSent(baseline + index + 2);
    }
    await runtime.kick();

    expect(messenger.sent.slice(baseline + 1).map(output => ({
      route: output.route, sourceId: store.ownerSource(output.sourceId)?.id, replyTo: output.replyTo, text: output.text,
    }))).toEqual(revisions.map(revision => ({
      route: siblingRoute, sourceId: revision.id, replyTo: undefined, text: revision.answer,
    })));
    expect(messenger.threads).toEqual([siblingRoute]);
    expect(main.prompts).toEqual([]);
  });

  test("a detached topic dialog without a saved card stays native-only instead of guessing the lane route", async () => {
    const { runtime, config, store, hosts, main, messenger } = fixture();
    const lane = savedLane(store, config, "detached-topic-card", route("44"), process.pid);
    const original = message("original-topic-alias", route("45"));
    const handoffId = placeTopicInput(store, lane, original);
    store.submit(handoffId, "topic-native-request", lane.generation);
    const worker = new HostTransport(lane.sessionFile, `session-${lane.id}`);
    const frame = { type: "extension_ui_request", method: "confirm", id: "topic-pending-card", title: "Continue with requested changes?" };
    worker.state.isSettled = false;
    worker.state.pendingUiRequests = [frame];
    hosts.set(lane.socketPath, worker);

    await runtime.start();
    await messenger.handlers!.reconnect!();

    expect(store.input(handoffId)?.state).toBe("uncertain");
    expect(store.approvals(lane.id)).toEqual([]);
    expect(messenger.shown.size).toBe(0);
    expect(worker.state.pendingUiRequests).toEqual([frame]);
    expect(worker.responses).toEqual([]);
    expect(worker.prompts).toEqual([]);
    expect(main.prompts).toEqual([]);
    expect(messenger.sent).toMatchObject([{ sourceId: original.id, route: original.route }]);
  });

  test.each(["original-topic", "selected-work-thread"])("a topic decision uses the exact card and final route for %s", async mode => {
    const { runtime, config, store, hosts, main, messenger } = fixture();
    const selected = mode === "selected-work-thread";
    const lane = savedLane(store, config, "topic-decision", route("44"));
    const original = message("topic-choice-original", selected ? route(null) : lane.route);
    await runtime.start();
    const inputId = placeTopicInput(store, lane, original, selected);
    await runtime.kick();
    const worker = hosts.get(lane.socketPath)!;
    const decision = decisionId(worker.state.sessionId, "topic-choice-call");
    const frame = { type: "extension_ui_request", method: "ask", id: "topic-choice-native",
      questions: [{ id: `${decision}:0`, question: "Which invoice is final?", options: [{ label: "Revised" }] }] };
    const response = { answers: [{ id: `${decision}:0`, selectedOptions: ["Revised"] }] };
    worker.state.pendingUiRequests = [frame];
    worker.emit(frame);
    await messenger.whenApproval();
    await messenger.handlers!.reconnect!();
    const approval = runtime.inspectDecision(decision);
    const destination = selected ? lane.route : original.route;

    expect(approval).toMatchObject({ sourceId: original.id, target: lane.id, route: destination, requestId: frame.id });
    expect(messenger.shown.get(approval.approvalId)).toMatchObject({ route: destination, request: frame });
    await expect(messenger.handlers!.answer(approval.approvalId, response, selected ? original.route : route("45")))
      .rejects.toMatchObject({ certainty: "rejected" });
    expect(worker.responses).toEqual([]);
    await messenger.handlers!.answer(approval.approvalId, response, destination);
    worker.complete("The revised invoice is final.");
    await messenger.whenSent(1);
    await runtime.kick();

    expect(worker.responses).toEqual([{ id: frame.id, response }]);
    expect(runtime.inspectDecision(decision)).toMatchObject({ state: "answered", response });
    expect(messenger.sent).toMatchObject([{ sourceId: selected ? inputId : original.id, route: destination,
      text: "The revised invoice is final." }]);
    expect(messenger.sent[0]?.replyTo).toEqual(selected ? undefined : { route: original.route, messageId: original.messageId });
    expect(main.prompts).toEqual([]);
  });
});

describe("original-message processing reactions", () => {
  test("slash DM requests and their topic replies never react or attempt native DM thread creation", async () => {
    const { runtime, main, messenger, directory, hosts, store } = fixture();
    messenger.canCreateThread = async () => false;
    await runtime.start();
    const dm = route(null, { guildId: null });
    const original = applicationCommand("1750000000000000001", dm, `/new cwd: ${directory}\ninspect this repository`);
    await admit(runtime, original);
    expect(main.prompts).toEqual([]);
    const [lane] = store.lanes();
    if (!lane) throw new Error("Expected a logical lane for slash work");
    expect(store.input(original.id)).toMatchObject({ target: null, state: "done", route: lane.route });
    expect(messenger.threadSources).toEqual([]);
    expect(store.getMeta(`cursor:${physicalRouteKey(dm)}`)).toBeNull();
    const handoffId = `handoff:${original.id}:lane`;
    expect(store.input(handoffId)).toMatchObject({ messageId: null, interactionId: original.interactionId, target: lane.id });
    const worker = hosts.get(lane.socketPath);
    if (!worker) throw new Error("Expected active slash-created lane");
    expect(worker.prompts[0]?.command.message).toContain("inspect this repository");
    expect(worker.prompts[0]?.command.message).not.toContain("/new cwd:");
    worker.complete("verified slash answer");
    await messenger.whenSent(2); // Kickoff and the topic's own answer.
    expect(store.input(handoffId)?.state).toBe("done");
    expect(store.input(`report:${handoffId}`)).toBeNull();
    expect(main.prompts).toEqual([]);
    expect(messenger.sent).toContainEqual(expect.objectContaining({ id: `${handoffId}:answer`,
      sourceId: original.id, route: lane.route, text: "verified slash answer" }));
    expect(messenger.activities).toEqual([]);
  });

  test("native work and joined edits retain thinking through a nonterminal yield, then clear on settlement", async () => {
    const { runtime, main, messenger } = fixture();
    await runtime.start();
    const original = headMessage("activity-original");
    await admit(runtime, original);
    await messenger.whenActivities(1);
    await admit(runtime, { ...original, id: "activity-edit", text: "/head correction" });
    main.emit({ type: "agent_end", isTerminal: false, messages: [] });
    expect(messenger.activities).toEqual([{ message: { route: original.route, messageId: original.messageId }, activity: "thinking" }]);
    const steering = main.prompts[1];
    if (!steering) throw new Error("Expected joined native edit");
    main.emit({ type: "prompt_result", id: steering.id, status: "completed", agentInvoked: true });
    main.complete("consolidated", 0);
    await messenger.whenActivities(2);
    await messenger.whenSent(1);
    expect(messenger.activities.map(value => value.activity)).toEqual(["thinking", "idle"]);
    expect(messenger.sent.map(value => value.text)).toEqual(["consolidated"]);
  });

  test.each(["stop", "disconnect", "error"] as const)("thinking clears on %s without requiring a successful reply", async outcome => {
    const { runtime, main, messenger, hosts, config } = fixture();
    await runtime.start();
    await admit(runtime, headMessage("activity-terminal"));
    await messenger.whenActivities(1);
    if (outcome === "stop") await admit(runtime, message("activity-stop", route(), "/stop head"));
    else if (outcome === "disconnect") {
      hosts.delete(hostPaths(config, "main").socketPath);
      await main.close();
    }
    else {
      main.state.isSettled = true;
      main.state.isStreaming = false;
      main.emit({ type: "prompt_result", id: main.prompts[0]?.id, status: "error", agentInvoked: true });
      main.emit({ type: "session_settled" });
    }
    await messenger.whenActivities(2);
    expect(messenger.activities.map(value => value.activity)).toEqual(["thinking", "idle"]);
  });

  test("native approval waiting clears thinking and its exact answer restores it", async () => {
    const { runtime, main, messenger } = fixture();
    await runtime.start();
    await admit(runtime, headMessage("activity-question"));
    const frame = { type: "extension_ui_request", id: "activity-ui", method: "confirm", title: "Proceed?", message: "Owner decision" };
    main.state.pendingUiRequests = [frame];
    main.emit(frame);
    await messenger.whenApproval();
    await messenger.whenActivities(2);
    const card = [...messenger.shown.values()][0];
    if (!card || !messenger.handlers) throw new Error("Expected native question");
    await messenger.handlers.answer(card.id, { confirmed: true }, card.route);
    await messenger.whenActivities(3);
    expect(messenger.activities.map(value => value.activity)).toEqual(["thinking", "idle", "thinking"]);
  });

  test("head, lane and report synthesis share the original reaction target, not the new thread or report ID", async () => {
    const { runtime, main, messenger, directory, hosts } = fixture();
    await runtime.start();
    const original = headMessage("activity-delegated", route(null));
    await admit(runtime, original);
    const lane = await runtime.startLane({ ...selection, sourceId: original.id, title: "Work", kickoff: "I will inspect the requested workspace, perform the authorized work, and verify the result in this topic.", cwd: directory });
    await runtime.kick();
    const worker = hosts.get(lane.socketPath);
    if (!worker) throw new Error("Expected active lane");
    main.complete("");
    await runtime.kick();
    expect(messenger.activities.map(value => value.activity)).toEqual(["thinking"]);
    worker.complete("lane result");
    await main.whenPrompts(2);
    main.complete("verified answer");
    await messenger.whenSent(1);
    await messenger.whenActivities(4);
    expect(messenger.activities.map(value => value.activity)).toEqual(["thinking", "idle", "thinking", "idle"]);
    expect(messenger.activities.every(value => physicalRouteKey(value.message.route) === physicalRouteKey(original.route)
      && value.message.messageId === original.messageId)).toBe(true);
  });

  test("reaction rejection never blocks native work or its final answer", async () => {
    const { runtime, main, messenger, errors } = fixture();
    messenger.activityFailure = true;
    await runtime.start();
    await admit(runtime, headMessage("activity-permission"));
    main.complete("answer despite missing reaction permissions");
    await messenger.whenSent(1);
    expect(messenger.sent[0]?.text).toBe("answer despite missing reaction permissions");
    expect(errors.some(error => error instanceof Error && error.message === "Message activity reaction failed")).toBe(true);
  });
});

describe("HEAD native journal ownership", () => {
  test.each([
    ["empty", null, true],
    ["resumed", "previous-native-leaf", true],
    ["older owner", "legacy-native-leaf", false],
  ] as const)("records the %s cursor before prompt admission", async (kind, leafId, supportsCursor) => {
    const { runtime, main, store } = fixture();
    if (!supportsCursor) main.state = { ...main.state, journalCursorVersion: undefined };
    main.journalLeaf = true;
    if (leafId !== null) main.entries.push({ id: leafId, type: "custom" });
    await runtime.start();

    const original = headMessage(`native-cursor-${kind}`);
    await admit(runtime, original);

    expect(main.prompts).toHaveLength(1);
    expect(JSON.parse(store.getMeta(`head-native-owner:${original.id}`)!)).toMatchObject({
      cursor: leafId, requestId: main.prompts[0]?.id, sessionId: main.state.sessionId, sessionFile: main.state.sessionFile,
    });
    expect(main.commands.filter(command => command.type === "get_entries")).toHaveLength(supportsCursor ? 0 : 1);
  });

  test.each([
    ["missing", { success: true, data: {} }],
    ["non-string", { success: true, data: { leafId: 7 } }],
    ["blank", { success: true, data: { leafId: "" } }],
    ["unavailable", { success: false, error: "Native request failed" }],
  ] as const)("holds input without a full journal fallback for a %s advertised cursor", async (kind, response) => {
    const { runtime, main, store } = fixture();
    main.cursorResponse = response;
    await runtime.start();

    const original = headMessage(`invalid-native-cursor-${kind}`);
    await admit(runtime, original);

    expect(main.prompts).toEqual([]);
    expect(store.input(original.id)?.state).toBe("pending");
    expect(store.getMeta(`head-native-owner:${original.id}`)).toBeNull();
    expect(main.commands.some(command => command.type === "get_entries")).toBe(false);
  });
});

describe("thread kickoff before execution", () => {
  test("a persisted kickoff fence added during HEAD journal cursor read holds native submission", async () => {
    const { runtime, main, store } = fixture();
    await runtime.start();
    const reading = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    main.beforeCursor = async () => {
      main.beforeCursor = undefined;
      reading.resolve();
      await release.promise;
    };
    const original = headMessage("kickoff-during-head-journal");
    await runtime.receive(original);
    const draining = runtime.kick();
    await reading.promise;
    try {
      // This durable write precedes the outbox receipt, including on restart.
      store.setMeta(`kickoff-output:${original.id}`, `${original.id}:kickoff`);
    } finally { release.resolve(); }
    await draining;
    expect(main.prompts).toEqual([]);
    expect(store.input(original.id)?.state).toBe("pending");
  });

  test("kickoff queued during an existing output drain is actually delivered before admission returns", async () => {
    const { runtime, messenger, store, directory } = fixture();
    await runtime.start();
    const original = headMessage("kickoff-during-send");
    await admit(runtime, original);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const queued = Promise.withResolvers<void>();
    const queueOutput = store.queueOutput.bind(store);
    store.queueOutput = output => {
      const added = queueOutput(output);
      if (output.id === `${original.id}:kickoff`) queued.resolve();
      return added;
    };
    messenger.beforeSend = async output => {
      if (output.id === "earlier-output") { entered.resolve(); await release.promise; }
    };
    store.queueOutput({ id: "earlier-output", sourceId: original.id, route: original.route, text: "Earlier response" });
    const draining = runtime.kick();
    await entered.promise;
    const starting = runtime.startLane({ ...selection, sourceId: original.id, title: "Work", cwd: directory,
      kickoff: "I will trace the queue and verify the fix." });
    try { await queued.promise; }
    finally { release.resolve(); }
    await draining;
    const lane = await starting;
    expect(messenger.sent.map(output => [output.id, output.route])).toEqual([
      ["earlier-output", original.route], [`${original.id}:kickoff`, lane.route],
    ]);
    expect(store.output(`${original.id}:kickoff`)?.state).toBe("sent");
  });

  test("a kickoff added while native dispatch is preparing fences that final submission too", async () => {
    const { runtime, messenger, directory, hosts, main } = fixture();
    await runtime.start();
    const first = headMessage("kickoff-race-first");
    await admit(runtime, first);
    const lane = await runtime.startLane({ ...selection, sourceId: first.id, title: "Work", cwd: directory,
      kickoff: "I will inspect the first request and verify it." });
    await runtime.kick();
    const worker = hosts.get(lane.socketPath);
    if (!worker) throw new Error("Expected resident lane");
    worker.complete("First result");
    await runtime.kick();
    const preparing = Promise.withResolvers<void>();
    const checked = Promise.withResolvers<void>();
    const releasePreparation = Promise.withResolvers<void>();
    let catalogReads = 0;
    main.beforeCatalog = async () => {
      if (++catalogReads === 1) {
        preparing.resolve();
        await releasePreparation.promise;
        checked.resolve();
      }
    };
    const second = headMessage("kickoff-race-second", lane.route);
    await runtime.receive(second);
    const handoff = runtime.messageLane(lane.id, "Continue the work", second.id);
    await preparing.promise;
    const third = headMessage("kickoff-race-third", lane.route);
    await runtime.receive(third);
    const kickoffEntered = Promise.withResolvers<void>();
    const releaseKickoff = Promise.withResolvers<void>();
    messenger.beforeSend = async output => {
      if (output.id === `${third.id}:kickoff`) { kickoffEntered.resolve(); await releaseKickoff.promise; }
    };
    const starting = runtime.startLane({ ...selection, sourceId: third.id, title: "More work", cwd: directory,
      kickoff: "I will inspect the additional requirements before continuing." });
    try {
      await kickoffEntered.promise;
      releasePreparation.resolve();
      await checked.promise;
      const tick = Promise.withResolvers<void>();
      setImmediate(tick.resolve);
      await tick.promise;
      expect(worker.prompts).toHaveLength(1);
    } finally { releasePreparation.resolve(); releaseKickoff.resolve(); }
    await Promise.all([handoff, starting]);
    await runtime.kick();
    expect(worker.prompts).toHaveLength(3);
  });

  test("a work topic receives its concrete kickoff before native dispatch, and identical retry sends nothing twice", async () => {
    const { runtime, messenger, main, hosts, directory, store } = fixture();
    await runtime.start();
    const original = headMessage("kickoff-order", route(null));
    await admit(runtime, original);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const kickoff = "I will inspect the message lifecycle, add reactions, and verify all three adapters.";
    messenger.beforeSend = async output => {
      if (output.id !== `${original.id}:kickoff`) return;
      entered.resolve();
      await release.promise;
    };
    const start = { ...selection, sourceId: original.id, title: "Message reactions", cwd: directory, kickoff };
    const starting = runtime.startLane(start);
    try {
      await entered.promise;
      const lane = store.lanes()[0];
      if (!lane) throw new Error("Expected a durable work-topic binding");
      expect(lane.route.threadId).toBe("900");
      expect(hosts.has(lane.socketPath)).toBe(false);
      const pumping = runtime.kick();
      const tick = Promise.withResolvers<void>();
      setImmediate(tick.resolve);
      await tick.promise;
      expect(hosts.has(lane.socketPath)).toBe(false);
      release.resolve();
      await pumping;
    } finally { release.resolve(); }
    const lane = await starting;
    await runtime.kick();
    expect(hosts.get(lane.socketPath)?.prompts).toHaveLength(1);
    expect(messenger.sent.filter(output => output.id === `${original.id}:kickoff`)).toEqual([
      expect.objectContaining({ route: lane.route, text: kickoff }),
    ]);
    await runtime.startLane(start);
    expect(messenger.sent.filter(output => output.id === `${original.id}:kickoff`)).toHaveLength(1);
    await expect(runtime.startLane({ ...start, kickoff: "Changed report" })).rejects.toThrow("Output identity conflict");
    expect(main.prompts).toHaveLength(1);
  });

  test.each(["rejected", "uncertain"] as const)("a %s kickoff holds the lane and later handoffs without automatically resending", async certainty => {
    const { runtime, messenger, directory, hosts, store } = fixture();
    await runtime.start();
    const original = headMessage(`kickoff-${certainty}`);
    await admit(runtime, original);
    messenger.sendError = new DeliveryError("Kickoff send failed", certainty);
    const start = { ...selection, sourceId: original.id, title: "Held work", cwd: directory, kickoff: "I will inspect the change and run its regression checks." };
    await expect(runtime.startLane(start)).rejects.toThrow("Kickoff delivery is not confirmed");
    const lane = store.lanes()[0];
    if (!lane) throw new Error("Expected held work binding");
    const followup = message(`kickoff-later-${certainty}`, original.route, "Also check duplicates");
    await runtime.receive(followup);
    const kickoff = { outputId: `${original.id}:kickoff`, state: certainty === "rejected" ? "failed" : "uncertain" };
    expect(await runtime.inspect(lane.id)).toMatchObject({ queueHolds: { kickoff } });
    await runtime.kick();
    expect(store.input(followup.id)).toMatchObject({ target: null, state: "done" });
    expect(store.input(`handoff:${followup.id}:${lane.id}`)).toMatchObject({ target: lane.id, state: "pending" });
    await expect(runtime.startLane(start)).rejects.toThrow("Kickoff delivery is not confirmed");
    expect(hosts.has(lane.socketPath)).toBe(false);
    expect(messenger.attempted.map(output => output.id)).toEqual([`${original.id}:kickoff`]);
    expect(store.output(`${original.id}:kickoff`)?.state).toBe(certainty === "rejected" ? "failed" : "uncertain");
  });
});

describe("dedicated HEAD startup preset initialization", () => {
  test("valid preexisting presets use readback only, without a model turn", async () => {
    const { runtime, store, main } = fixture();
    await runtime.start();
    expect(JSON.parse(store.getMeta("head:preset-bootstrap")!)).toMatchObject({ state: "complete", sessionId: "session-main" });
    expect(main.prompts).toEqual([]);
  });

  test("bootstrap holds ordered user input, never delivers its text, and requires actual readback", async () => {
    let created = false;
    const { runtime, store, main, messenger } = fixture(3, undefined, {
      inspectPresets: async () => ({ settings: { modelRoles: { default: "fixture/capable" } },
        configuredDefault: { available: true }, availableModels: [executionModel],
        presets: ["high", "middle", "low"].map(name => ({ name, status: created ? "valid" : "missing", available: created, globalEntry: created })),
        bootstrap: { missing: created ? [] : ["high", "middle", "low"], blocked: [] } }),
    });
    await runtime.start();
    expect(main.prompts).toHaveLength(1);
    expect(main.prompts[0]!.id.startsWith("sg-bootstrap-")).toBe(true);
    expect(store.inputs()).toEqual([]);
    await admit(runtime, headMessage("bootstrap-first"));
    await admit(runtime, headMessage("bootstrap-second", route("other-bootstrap")));
    expect(store.inputs().map(input => [input.id, input.state])).toEqual([["bootstrap-first", "pending"], ["bootstrap-second", "pending"]]);
    expect(main.prompts).toHaveLength(1);
    created = true;
    main.complete("INTERNAL SETUP TEXT MUST NOT BE DELIVERED");
    await main.whenPrompts(2);
    expect(JSON.parse(store.getMeta("head:preset-bootstrap")!).state).toBe("complete");
    expect(String(main.prompts[1]!.command.message)).toContain("Request ID: bootstrap-first");
    expect(messenger.sent).toEqual([]);
    main.complete("first user answer");
    await messenger.whenSent(1);
    expect(messenger.sent[0]!.text).toBe("first user answer");
    expect(store.input("bootstrap-second")?.state).not.toBe("done");
  });

  test("skipped or completed-without-creation initializers never become complete", async () => {
    for (const skipped of [false, true]) {
      const { runtime, main, store, messenger } = fixture(3, undefined, {
        inspectPresets: async () => ({ settings: { modelRoles: {} }, configuredDefault: { available: true },
          availableModels: [executionModel], presets: [], bootstrap: { missing: ["high", "middle", "low"], blocked: [] } }),
      });
      main.local = skipped;
      await runtime.start();
      if (!skipped) main.complete("No presets were saved");
      // Drain the event-driven finish/readback chain, not a guessed time delay.
      const drained = Promise.withResolvers<void>();
      setImmediate(drained.resolve);
      await drained.promise;
      await admit(runtime, message(`bootstrap-status-${skipped}`, route(), "/status"));
      expect(messenger.sent.at(-1)!.text).toContain("Preset initialization: failed");
      expect(JSON.parse(store.getMeta("head:preset-bootstrap")!).state).toBe("failed");
      await admit(runtime, headMessage(`bootstrap-held-${skipped}`));
      expect(store.input(`bootstrap-held-${skipped}`)?.state).toBe("pending");
      expect(main.prompts).toHaveLength(1);
    }
  });

  test("all prior terminal/ambiguous lifecycles fence automatic recreation, including prior no-op complete", async () => {
    for (const prior of ["running", "failed", "blocked", "uncertain", "complete", "checking"] as const) {
      const { runtime, store, main } = fixture(3, undefined, {
        inspectPresets: async () => ({ settings: { modelRoles: {} }, configuredDefault: { available: true },
          availableModels: [executionModel], presets: [], bootstrap: { missing: ["high", "middle", "low"], blocked: [] } }),
      });
      store.setMeta("head:preset-bootstrap", JSON.stringify({ sessionId: "session-main", state: prior,
        ...(prior === "running" ? { requestId: "original-bootstrap" } : {}),
        ...(prior === "checking" ? { replayBlocked: true } : {}), detail: "Earlier lifecycle" }));
      await runtime.start();
      expect(main.prompts).toEqual([]);
      expect(JSON.parse(store.getMeta("head:preset-bootstrap")!).state).not.toBe("complete");
      await admit(runtime, headMessage(`restart-held-${prior}`));
      expect(store.input(`restart-held-${prior}`)?.state).toBe("pending");
    }
  });

  test("native-only bootstrap approval stays pending and owner stop prevents replay", async () => {
    const { runtime, main, store } = fixture(3, undefined, {
      inspectPresets: async () => ({ settings: { modelRoles: {} }, configuredDefault: { available: true },
        availableModels: [executionModel], presets: [], bootstrap: { missing: ["high", "middle", "low"], blocked: [] } }),
    });
    await runtime.start();
    const dialog = { id: "bootstrap-approval", method: "confirm", title: "Native setup permission" };
    main.state.pendingUiRequests = [dialog];
    main.emit({ type: "extension_ui_request", ...dialog });
    expect(main.responses).toEqual([]);
    expect(JSON.parse(store.getMeta("head:preset-bootstrap")!).state).toBe("blocked");
    await admit(runtime, message("stop-bootstrap", route(), "/stop head"));
    expect(main.responses).toContainEqual({ id: dialog.id, response: { cancelled: true } });
    expect(JSON.parse(store.getMeta("head:preset-bootstrap")!).state).toBe("failed");
    await admit(runtime, headMessage("after-bootstrap-stop"));
    expect(store.input("after-bootstrap-stop")?.state).toBe("pending");
    expect(main.prompts).toHaveLength(1);
  });

  test("initial approval inventory is reconciled before inspection and blocks startup model work", async () => {
    const frame = { id: "original-main-approval", method: "confirm", title: "Original owner permission" };
    const id = `a-${createHash("sha256").update(`main:0:${frame.id}`).digest("hex").slice(0, 24)}`;
    const f = fixture(3, undefined, {
      inspectPresets: async () => {
        expect(f.messenger.shown.get(id)?.remoteId).toBe("original-card");
        expect(f.main.responses).toEqual([]);
        return { settings: { modelRoles: {} }, configuredDefault: { available: true },
          availableModels: [executionModel], presets: [], bootstrap: { missing: ["high", "middle", "low"], blocked: [] } };
      },
    });
    f.main.state.pendingUiRequests = [frame];
    f.store.putApproval({ id, target: "main", generation: 0, requestId: frame.id, route: route(),
      request: frame, state: "pending", remoteId: "original-card" });
    await f.runtime.start();
    expect(f.main.prompts).toEqual([]);
    expect(JSON.parse(f.store.getMeta("head:preset-bootstrap")!).state).toBe("blocked");
    expect(f.store.approval(id)?.state).toBe("pending");
    await admit(f.runtime, headMessage("approval-startup-held"));
    expect(f.store.input("approval-startup-held")?.state).toBe("pending");
  });

  test("restart retains a native-only setup dialog and never repeats its original initializer", async () => {
    const { runtime, main, store } = fixture(3, undefined, {
      inspectPresets: async () => ({ settings: { modelRoles: {} }, configuredDefault: { available: true },
        availableModels: [executionModel], presets: [], bootstrap: { missing: ["high", "middle", "low"], blocked: [] } }),
    });
    store.setMeta("head:preset-bootstrap", JSON.stringify({ sessionId: "session-main", state: "running",
      requestId: "original-bootstrap", detail: "Interrupted setup" }));
    main.state.pendingUiRequests = [{ id: "original-setup-dialog", method: "confirm", title: "Native owner permission" }];
    main.state.isSettled = false;
    await runtime.start();
    expect(main.responses).toEqual([]);
    expect(main.prompts).toEqual([]);
    expect(JSON.parse(store.getMeta("head:preset-bootstrap")!)).toMatchObject({ state: "uncertain", requestId: "original-bootstrap" });
  });
});

function savedLane(store: Store, config: Config, id: string, destination: Route, pid: number | null = null): Lane {
  const paths = hostPaths(config, id);
  const source = message(`source-${id}`, destination);
  store.receive(source, null);
  const lane = store.createLane({
    id, route: destination, title: id, cwd: config.headCwd, repoRoot: null, brief: "Isolated task", acceptance: [],
    ...selection,
    modelPreset: null,
    modelPresetSnapshot: null,
    workState: "open", runtimeState: pid ? "running" : "unloaded", sessionFile: paths.sessionFile,
    sessionId: pid ? `session-${id}` : null, socketPath: paths.socketPath,
    generation: 0, pid, createdAt: 100, lastActivityAt: 100, result: null,
  }, source.id);
  store.settle(source.id, "done");
  return lane;
}

function legacyLane(store: Store, config: Config, id: string, destination: Route, pid: number | null = null): Lane {
  const { model: _model, modelReason: _reason, modelPreset: _preset, modelPresetSnapshot: _snapshot, ...old } = savedLane(store, config, id, destination, pid);
  const db = new Database(join(config.stateDir, "coordination.sqlite"));
  try { db.query("UPDATE lanes SET data = ? WHERE id = ?").run(JSON.stringify(old), id); }
  finally { db.close(); }
  return store.lane(id)!;
}

function legacyTranscript(lane: Lane, model: LaneModel): void {
  mkdirSync(dirname(lane.sessionFile), { recursive: true });
  writeFileSync(lane.sessionFile, [
    { type: "session", version: 3, id: `session-${lane.id}`, timestamp: new Date(100).toISOString(), cwd: lane.cwd },
    { type: "model_change", id: "prior-model", parentId: null, timestamp: new Date(101).toISOString(), provider: model.provider, modelId: model.id },
  ].map(entry => JSON.stringify(entry)).join("\n") + "\n");
}

function modelChangeSource(store: Store, id: string): string {
  store.receive(message(id, route(null, { guildId: null })), "main");
  store.settle(id, "done");
  return id;
}

function restartFixture() {
  const requests: GatewayRestartRequest[] = [];
  const handoff: { respond?: (request: GatewayRestartRequest) => Promise<GatewayRestartRecord> } = {};
  let sessionFile = "";
  const instance = fixture(3, undefined, { requestRestart: async request => {
    requests.push(structuredClone(request));
    if (handoff.respond) return handoff.respond(request);
    return { ...request, gatewayPid: process.pid, headPid: process.pid, sessionId: "session-main", sessionFile, state: "accepted" };
  } });
  sessionFile = hostPaths(instance.config, "main").sessionFile;
  return { ...instance, requests, handoff };
}

function savedRestart(instance: Pick<Superagent, "store" | "config">, state: GatewayRestartRecord["state"] = "started", oldOwnerPid = 2_000_000_001) {
  const input = applicationCommand("1750000000000000700", route("original-restart-route"), "/restart");
  instance.store.receive(input, "main", { [`user-source:${input.id}`]: "true" });
  const restart = { requestId: crypto.randomUUID(),
    inputId: input.id, ackOutputId: `${input.id}:restart-ack`, ownerPid: oldOwnerPid,
    sessionId: "session-main", sessionFile: hostPaths(instance.config, "main").sessionFile, state: "accepted" };
  instance.store.settle(input.id, "done", { id: restart.ackOutputId, text: "Original restart ACK" });
  instance.store.claimOutput(restart.ackOutputId);
  instance.store.finishOutput(restart.ackOutputId, "sent", "original-ack-receipt");
  instance.store.setMeta(`head:restart:${input.id}`, JSON.stringify(restart));
  instance.store.setMeta("head:restart-fence", JSON.stringify(restart));
  const receipt: GatewayRestartRecord = { requestId: restart.requestId, inputId: input.id, ackOutputId: restart.ackOutputId,
    headPid: oldOwnerPid, gatewayPid: 2_000_000_002, sessionId: restart.sessionId, sessionFile: restart.sessionFile,
    state, successorPid: process.pid, replacementPid: process.pid };
  instance.store.setMeta(`gateway:restart:${restart.requestId}`, JSON.stringify(receipt));
  instance.store.setMeta("gateway:restart", JSON.stringify(receipt));
  instance.store.setMeta("gateway:head", JSON.stringify({ pid: process.pid, sessionId: restart.sessionId, sessionFile: restart.sessionFile }));
  instance.store.setMeta("gateway:socket", JSON.stringify({ pid: process.pid }));
  return { input, restart, receipt };
}

describe("controlled Gateway AND HEAD restart", () => {
  test("the runtime-generated request crosses authenticated Gateway RPC and persists actual acceptance once", async () => {
    let client: GatewayHeadMessenger;
    const { runtime, config, store, messenger, main } = fixture(3, undefined, {
      requestRestart: request => client.requestRestart(request),
    });
    mkdirSync(join(config.stateDir, "run"), { recursive: true, mode: 0o700 });
    const gatewayStore = new GatewayStore(config.stateDir);
    const accepted: GatewayRestartRequest[] = [];
    const executed: string[] = [];
    const server = new GatewayServer({ socketPath: gatewayPaths(config).socketPath, store: gatewayStore, messenger,
      authorizeHead: async pid => { if (pid !== process.pid) throw new DeliveryError("Foreign head", "rejected"); },
      status: () => ({ gateway: { pid: process.pid, ready: true, admissionReady: true, pendingEvents: 0, stopping: false },
        head: { pid: process.pid, ready: true, connected: true, socketPath: hostPaths(config, "main").socketPath, error: null } }),
      stop: async () => { throw new Error("This acceptance regression must not stop a process"); },
      restart: async request => {
        accepted.push(structuredClone(request));
        const receipt: GatewayRestartRecord = { ...request, gatewayPid: process.pid, headPid: process.pid,
          sessionId: "session-main", sessionFile: hostPaths(config, "main").sessionFile, state: "accepted" };
        gatewayStore.setRestart(receipt);
        return receipt;
      },
      runRestart: requestId => { executed.push(requestId); }, onError: () => {},
    });
    const savedToken = process.env.OMP_SUPERAGENT_GATEWAY_TOKEN;
    process.env.OMP_SUPERAGENT_GATEWAY_TOKEN = gatewayStore.token();
    try { client = createGatewayMessenger(config); }
    finally {
      if (savedToken === undefined) delete process.env.OMP_SUPERAGENT_GATEWAY_TOKEN;
      else process.env.OMP_SUPERAGENT_GATEWAY_TOKEN = savedToken;
    }
    try {
      await server.listen();
      await client.start({ message: async () => {}, answer: async () => {} });
      await server.initialReady.promise;
      await runtime.start();
      const original = applicationCommand("1750000000000000699", route("gateway-rpc-restart"), "/restart");
      await admit(runtime, original);
      const request = accepted[0]!;
      expect(accepted).toHaveLength(1);
      expect(gatewayStore.getRestart(request.requestId)).toMatchObject({ ...request, state: "accepted" });
      expect(store.output(request.ackOutputId)?.state).toBe("sent");
      expect(JSON.parse(store.getMeta(`head:restart:${original.id}`)!)).toMatchObject({ ...request, state: "accepted" });
      expect(gatewayStore.getMeta(`gateway:restart-source:${original.id}`)).toBe(request.requestId);
      expect(executed).toEqual([request.requestId]);
      await admit(runtime, original);
      expect(accepted).toHaveLength(1);
      expect(executed).toEqual([request.requestId]);
      expect(main.prompts).toEqual([]);
      expect(main.commands.some(command => command.type === "shutdown_host")).toBe(false);
    } finally {
      await runtime.stop();
      await client.stop();
      await server.close();
      gatewayStore.close();
    }
  });

  test.each(["discord", "telegram", "slack"] as const)("%s restart acknowledges natively, hands off once and never mistakes acceptance for readiness", async platform => {
    const { runtime, config, main, store, messenger, requests } = restartFixture();
    config.telegram = { tokenEnv: "TEST_TELEGRAM", ownerId: "1", allowedChatIds: ["3"] };
    config.slack = { botTokenEnv: "TEST_SLACK", appTokenEnv: "TEST_SLACK_APP", ownerId: "1", teamId: "TTEAM", allowedChannelIds: ["4"] };
    const destination = route("10", { platform, ...(platform === "telegram" ? { channelId: "3" }
      : platform === "slack" ? { accountId: "TTEAM:UBOT", guildId: "TTEAM" } : {}) });
    const original = { ...message("restart-owner", destination, "/restart"), messageId: platform === "slack" ? "1750000000.000070" : "700" };
    await runtime.start();
    await admit(runtime, original);
    const ack = store.output(`${original.id}:restart-ack`)!;
    expect(ack).toMatchObject({ sourceId: original.id, route: destination, state: "sent" });
    expect(ack.text).toContain("Gateway AND HEAD");
    expect(ack.text).toContain("same native session");
    expect(ack.text).not.toContain("HEAD session only");
    expect(store.input(original.id)).toMatchObject({ state: "done", messageId: original.messageId, route: destination });
    expect(requests).toEqual([{ requestId: expect.any(String), inputId: original.id, ackOutputId: ack.id }]);
    expect(JSON.parse(store.getMeta("head:restart-fence")!).state).toBe("accepted");
    await admit(runtime, original);
    await runtime.kick();
    expect(requests).toHaveLength(1);
    expect(messenger.sent).toHaveLength(1);
    expect(store.output(`${original.id}:restart-result`)).toBeNull();
    expect(main.prompts).toEqual([]);
    expect(main.abortCount).toBe(0);
    expect(main.commands.some(command => command.type === "shutdown_host")).toBe(false);
  });

  test.each(["main", "lane"] as const)("%s native work is checkpointed or preserved, while unsafe HEAD ownership remains held", async target => {
    const cases: Partial<RuntimeState>[] = [
      { isSettled: false }, { isStreaming: true }, { isCompacting: true }, { queuedMessageCount: 1 },
      { hasPendingAsyncWork: true }, { hasOwnedRunningWork: true }, { goal: { enabled: true } },
      { pendingUiRequests: [{ id: "approval-held", method: "confirm", token: "secret-native-token" }] },
      { hasPendingAsyncWork: undefined }, { hostPid: undefined }, { hostPid: 2_000_000_003 }, { sessionId: "wrong-session" },
    ];
    for (const [index, patch] of cases.entries()) {
      const { runtime, main, store, config, hosts, messenger, requests } = restartFixture();
      const lane = savedLane(store, config, `restart-guard-${index}`, route(`guard-${index}`), process.pid);
      const laneHost = new HostTransport(lane.sessionFile, `session-${lane.id}`);
      hosts.set(lane.socketPath, laneHost);
      await runtime.start();
      Object.assign(target === "main" ? main.state : laneHost.state, patch);
      await admit(runtime, message(`restart-guard-owner-${index}`, route(), "/restart"));
      const unsafe = Object.hasOwn(patch, "hostPid") || patch.sessionId !== undefined
        || target === "main" && (patch.hasPendingAsyncWork !== undefined && patch.hasPendingAsyncWork
        || patch.hasOwnedRunningWork === true || Object.hasOwn(patch, "hasPendingAsyncWork") && patch.hasPendingAsyncWork === undefined
        );
      expect(requests).toHaveLength(unsafe ? 0 : 1);
      expect(JSON.parse(store.getMeta("head:restart-fence")!).state).toBe(unsafe ? "failed" : "accepted");
      expect(store.output(`restart-guard-owner-${index}:restart-ack`)?.state).toBe("sent");
      expect(messenger.sent.map(output => output.text).join("\n")).not.toContain("secret-native-token");
      expect(main.prompts).toEqual([]);
      expect(laneHost.prompts).toEqual([]);
      expect(laneHost.abortCount).toBe(0);
      expect([...main.commands, ...laneHost.commands].some(command => command.type === "shutdown_host")).toBe(false);
    }
  });

  test.each(["pending", "submitted", "uncertain"] as const)("durable %s work in either HEAD or a lane survives restart admission without replay", async state => {
    for (const target of ["main", "lane"] as const) {
      const { runtime, store, config, requests } = restartFixture();
      const lane = savedLane(store, config, `durable-${state}`, route(`durable-${state}`));
      await runtime.start();
      const other = message(`unrelated-${state}-${target}`, target === "main" ? route() : lane.route);
      store.receive(other, target === "main" ? "main" : lane.id);
      if (state !== "pending") store.submit(other.id, "original-native-ticket", 0);
      if (state === "uncertain") store.settle(other.id, "uncertain");
      await admit(runtime, message(`restart-durable-${state}-${target}`, route(), "/restart"));
      expect(store.input(other.id)?.state).toBe(state);
      expect(store.input(`restart-durable-${state}-${target}`)?.state).toBe("done");
      expect(requests).toHaveLength(1);
    }
  });

  test("active lane work and its exact approval remain owned while Gateway and HEAD restart", async () => {
    const { runtime, store, config, hosts, main, requests } = restartFixture();
    const lane = savedLane(store, config, "restart-active-lane", route("restart-active-lane"), process.pid);
    const laneHost = new HostTransport(lane.sessionFile, `session-${lane.id}`);
    hosts.set(lane.socketPath, laneHost);
    await runtime.start();
    await delegate(runtime, message("active-lane-request", lane.route));
    store.putApproval({ id: "durable-restart-approval", target: lane.id, generation: 0, requestId: "original-ui", route: lane.route,
      request: { method: "confirm" }, state: "pending", remoteId: "original-card" });
    await admit(runtime, message("restart-with-approval", route(), "/restart"));
    expect(store.approval("durable-restart-approval")?.state).toBe("pending");
    expect(requests).toHaveLength(1);
    expect(laneHost.prompts).toHaveLength(1);
    expect(main.prompts).toEqual([]);
    expect(laneHost.abortCount).toBe(0);
  });

  test.each(["pending", "answered"] as const)("busy HEAD checkpoints its goal and archives the original %s card after confirmed route ACK", async cardState => {
    const { runtime, main, store, messenger, requests } = restartFixture();
    await runtime.start();
    await admit(runtime, headMessage("restart-active-head"));
    main.state.goal = { enabled: true, mode: "active", goal: { id: "original-head-goal", status: "active" } };
    main.emit({ type: "goal_updated", state: main.state.goal });
    main.state.pendingUiRequests = [{ id: "head-question", method: "confirm", title: "Continue?" }];
    main.emit({ type: "extension_ui_request", ...main.state.pendingUiRequests[0] });
    await runtime.kick();
    const card = [...messenger.shown.values()][0]!;
    if (cardState === "answered") store.resolveApproval(card.id, card.generation, "answered");
    main.beforeAbort = () => {
      expect(store.output("restart-busy-head:restart-ack")).toMatchObject({ state: "sent", route: route() });
      expect(card.requestId).toBe("head-question");
      expect(store.approval(card.id)?.state).toBe(cardState === "pending" ? "cancelled" : "answered");
      const ticket = main.prompts[0]!;
      main.emit({ type: "prompt_result", id: ticket.id, status: "aborted", agentInvoked: true });
    };
    const original = message("restart-busy-head", route(), "/restart");
    await admit(runtime, original);
    expect(requests).toHaveLength(1);
    expect(main.abortCount).toBe(1);
    expect(main.state.goal?.enabled).toBe(false);
    expect(main.prompts).toHaveLength(1);
    expect(JSON.parse(store.getMeta("head:restart-fence")!).checkpoint).toMatchObject({
      goalActive: true, goalSourceId: "restart-active-head", model: executionModel, thinkingLevel: "high",
    });
    await messenger.handlers!.answer(card.id, { confirmed: true }, card.route).catch(() => {});
    expect(main.responses).not.toContainEqual({ id: card.requestId, response: { confirmed: true } });
    expect(await messenger.handlers!.reconcileAnswer!(card.id, card.route)).toBe("rejected");
    await admit(runtime, original);
    expect(main.abortCount).toBe(1);
    expect(messenger.sent.filter(output => output.id === "restart-busy-head:restart-ack")).toHaveLength(1);
  });

  test("explicit HEAD stop wins while restart ACK is in flight and never starts a successor", async () => {
    const { runtime, main, store, messenger, requests } = restartFixture();
    const sending = Promise.withResolvers<void>();
    const delivered = Promise.withResolvers<void>();
    messenger.beforeSend = async output => {
      if (output.id === "restart-stop-race:restart-ack") { sending.resolve(); await delivered.promise; }
    };
    await runtime.start();
    await runtime.receive(message("restart-stop-race", route(), "/restart"));
    await sending.promise;
    await runtime.receive(message("stop-wins-restart", route(), "/stop head"));
    delivered.resolve();
    await runtime.kick();
    expect(requests).toEqual([]);
    expect(store.getMeta("head:restart-fence")).toBe("");
    expect(store.input("restart-stop-race")?.state).toBe("done"); // The ACK was already admitted; lifecycle cancellation is separate.
    expect(JSON.parse(store.getMeta("head:restart:restart-stop-race")!).state).toBe("refused");
    expect(main.abortCount).toBe(1);
  });

  test.each(["resident-state", "resident-cursor", "final-state"] as const)("a newer HEAD stop cannot be resurrected across the %s checkpoint await", async boundary => {
    const { runtime, main, store, config, hosts, requests } = restartFixture();
    const lane = savedLane(store, config, `stop-checkpoint-${boundary}`, route(`stop-${boundary}`), process.pid);
    const resident = new HostTransport(lane.sessionFile, `session-${lane.id}`);
    hosts.set(lane.socketPath, resident);
    await runtime.start();
    await admit(runtime, headMessage("checkpoint-running-head"));
    await delegate(runtime, message(`checkpoint-running-lane-${boundary}`, lane.route));
    const entered = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const block = async () => { entered.resolve(); await released.promise; };
    if (boundary === "resident-state") resident.beforeState = async () => { resident.beforeState = undefined; await block(); };
    if (boundary === "resident-cursor") resident.beforeCursor = async () => { resident.beforeCursor = undefined; await block(); };
    if (boundary === "final-state") main.beforeState = async () => {
      if (store.input("checkpoint-running-head")?.state !== "uncertain") return;
      main.beforeState = undefined;
      await block();
    };
    await runtime.receive(message("checkpoint-raced-restart", route(), "/restart"));
    await entered.promise;
    expect(store.output("checkpoint-raced-restart:restart-ack")?.state).toBe("sent");
    await runtime.receive(message("checkpoint-newer-stop", route(), "/stop head"));
    expect(store.getMeta("head:restart-fence")).toBe("");
    released.resolve();
    await runtime.kick();
    expect(store.getMeta("head:restart-fence")).toBe("");
    expect(JSON.parse(store.getMeta("head:restart:checkpoint-raced-restart")!).state).toBe("refused");
    expect(requests).toEqual([]);
    expect(main.abortCount).toBe(boundary === "final-state" ? 2 : 1);
    expect(resident.abortCount).toBe(0);
    expect(resident.prompts).toHaveLength(1);
  });

  test("an operator-stop boundary superseding a pending ACK prevents native checkpoint and handoff", async () => {
    const { runtime, main, store, messenger, requests } = restartFixture();
    const sending = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    messenger.beforeSend = async output => {
      if (output.id === "operator-raced-restart:restart-ack") { sending.resolve(); await released.promise; }
    };
    await runtime.start();
    await admit(runtime, headMessage("operator-running-head"));
    await runtime.receive(message("operator-raced-restart", route(), "/restart"));
    await sending.promise;
    store.setMeta("gateway:operator-stop", "newer-explicit-stop-boundary");
    released.resolve();
    await runtime.kick();
    expect(main.abortCount).toBe(0);
    expect(main.state.isStreaming).toBe(true);
    expect(requests).toEqual([]);
    expect(store.getMeta("head:restart-fence")).toBe("");
    expect(JSON.parse(store.getMeta("head:restart:operator-raced-restart")!).state).toBe("refused");
  });

  test("a settled active HEAD goal retains its original source for restart from another conversation", async () => {
    const instance = restartFixture();
    const { runtime, main, store, messenger, config } = instance;
    const original = headMessage("settled-goal-owner", route("goal-route-A"));
    const control = message("settled-goal-restart", route("restart-route-B"), "/restart");
    await runtime.start();
    await admit(runtime, original);
    main.state.goal = { enabled: true, mode: "active", goal: { id: "settled-native-goal", status: "active" } };
    main.emit({ type: "goal_updated", state: main.state.goal });
    main.complete("First yield without finishing the existing native goal");
    await runtime.kick();
    expect(store.input(original.id)?.state).toBe("done");
    await admit(runtime, control);
    const restart = JSON.parse(store.getMeta(`head:restart:${control.id}`)!);
    expect(restart.checkpoint).toMatchObject({ goalActive: true, goalId: "settled-native-goal", goalSourceId: original.id });
    restart.ownerPid = 2_000_000_001;
    store.setMeta(`head:restart:${control.id}`, JSON.stringify(restart));
    store.setMeta("head:restart-fence", JSON.stringify(restart));
    const receipt: GatewayRestartRecord = { requestId: restart.requestId, inputId: control.id, ackOutputId: restart.ackOutputId,
      gatewayPid: 2_000_000_002, headPid: restart.ownerPid, sessionId: main.state.sessionId,
      sessionFile: hostPaths(config, "main").sessionFile, state: "started", successorPid: process.pid, replacementPid: process.pid };
    store.setMeta(`gateway:restart:${restart.requestId}`, JSON.stringify(receipt));
    store.setMeta("gateway:head", JSON.stringify({ pid: process.pid, sessionId: main.state.sessionId, sessionFile: main.state.sessionFile }));
    store.setMeta("gateway:socket", JSON.stringify({ pid: process.pid }));
    main.beforeGoalResume = () => {
      main.state.pendingUiRequests = [{ id: "resumed-original-card", method: "confirm", title: "Original goal decision" }];
      main.emit({ type: "extension_ui_request", ...main.state.pendingUiRequests[0] });
    };
    await runtime.kick();
    const resumeId = `restart-resume:${restart.requestId}:main`;
    expect(store.input(resumeId)).toMatchObject({ route: original.route, state: "submitted" });
    const card = [...messenger.shown.values()].find(card => card.requestId === "resumed-original-card");
    expect(card?.route).toEqual(original.route);
    main.state.pendingUiRequests = [];
    main.state.goal = null;
    main.state.isSettled = true;
    main.state.isStreaming = false;
    main.emit({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Original goal finished" }] } });
    main.emit({ type: "session_settled" });
    await runtime.kick();
    expect(store.output(`${resumeId}:answer`)).toMatchObject({ route: original.route, text: "Original goal finished" });
    expect(main.prompts).toHaveLength(1);
  });

  test("an unowned native goal holds only automatic resume and never adopts the restart source", async () => {
    const instance = restartFixture();
    const { restart } = savedRestart(instance);
    const checkpoint = { ...restart, checkpoint: { goalActive: true, goalId: "native-only-unowned-goal",
      model: executionModel, thinkingLevel: "high", residents: [] } };
    instance.store.setMeta(`head:restart:${restart.inputId}`, JSON.stringify(checkpoint));
    instance.store.setMeta("head:restart-fence", JSON.stringify(checkpoint));
    instance.main.state.goal = { enabled: false, mode: "active", goal: { id: "native-only-unowned-goal", status: "paused" } };
    await instance.runtime.start();
    expect(instance.store.getMeta("head:restart-fence")).toBe("");
    expect(instance.main.commands.filter(command => command.type === "goal" && command.op === "resume")).toEqual([]);
    expect(instance.store.input(`restart-resume:${restart.requestId}:main`)).toBeNull();
    expect(instance.store.output(`${restart.inputId}:restart-goal-held`)).not.toBeNull();
  });
  test("a delayed ACK holds handoff and fences direct/lane dispatch and every public lane mutation", async () => {
    const { runtime, store, main, config, hosts, messenger, directory, requests } = restartFixture();
    const lane = savedLane(store, config, "restart-fenced-lane", route("restart-fenced-lane"), process.pid);
    const laneHost = new HostTransport(lane.sessionFile, `session-${lane.id}`);
    hosts.set(lane.socketPath, laneHost);
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    messenger.beforeSend = async output => { if (output.id === "restart-delayed:restart-ack") { started.resolve(); await release.promise; } };
    await runtime.start();
    await runtime.receive(message("restart-delayed", route(), "/restart"));
    await started.promise;
    expect(store.output("restart-delayed:restart-ack")?.state).toBe("sending");
    expect(requests).toEqual([]);
    expect(store.getMeta("head:restart-fence")).toBeTruthy();
    await expect(runtime.startLane({ sourceId: `source-${lane.id}`, title: "No new lane", cwd: directory, kickoff: "No kickoff", ...selection })).rejects.toThrow("fenced");
    await expect(runtime.messageLane(lane.id, "No message", `source-${lane.id}`)).rejects.toThrow("fenced");
    await expect(runtime.changeModel({ id: lane.id, sourceId: `source-${lane.id}`, model: otherModel, modelReason: "No switch" })).rejects.toThrow("fenced");
    await expect(runtime.pause(lane.id)).rejects.toThrow("fenced");
    await expect(runtime.resume(lane.id)).rejects.toThrow("fenced");
    await expect(runtime.closeLane(lane.id, "completed", "No close")).rejects.toThrow("fenced");
    release.resolve();
    await runtime.kick();
    expect(requests).toHaveLength(1);
    await runtime.receive(headMessage("later-direct"));
    store.receive(message("later-lane", lane.route), lane.id);
    await runtime.kick();
    expect(store.input("later-direct")?.state).toBe("pending");
    expect(store.input("later-lane")?.state).toBe("pending");
    expect(main.prompts).toEqual([]);
    expect(laneHost.prompts).toEqual([]);
    await admit(runtime, message("restart-fenced-stop", route(), "/stop head"));
    expect(main.abortCount).toBe(0);
    expect(store.input("later-direct")?.state).toBe("pending");
  });

  test.each(["rejected", "uncertain"] as const)("%s ACK delivery never hands off or retries the original restart", async certainty => {
    const { runtime, store, messenger, requests } = restartFixture();
    messenger.sendError = new DeliveryError("secret transport response", certainty);
    await runtime.start();
    const original = message(`restart-ack-${certainty}`, route(), "/restart");
    await admit(runtime, original);
    expect(store.output(`${original.id}:restart-ack`)?.state).toBe(certainty === "rejected" ? "failed" : "uncertain");
    messenger.sendError = undefined;
    await admit(runtime, original);
    await runtime.kick();
    expect(requests).toEqual([]);
    expect(messenger.attempted.filter(output => output.id === `${original.id}:restart-ack`)).toHaveLength(1);
    if (certainty === "uncertain") expect(JSON.parse(store.getMeta("head:restart-fence")!).state).toBe("uncertain");
    else expect(store.getMeta("head:restart-fence")).toBe("");
  });

  test("an ACK queued during another output drain still requires its own durable sent receipt", async () => {
    const { runtime, store, messenger, requests, handoff, config } = restartFixture();
    await runtime.start();
    const sourceId = modelChangeSource(store, "restart-drain-source");
    store.queueOutput({ id: "existing-drain", sourceId, route: store.input(sourceId)!.route, text: "Earlier output" });
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    messenger.beforeSend = async output => { if (output.id === "existing-drain") { started.resolve(); await release.promise; } };
    handoff.respond = async request => {
      expect(store.output(request.ackOutputId)?.state).toBe("sent");
      return { ...request, gatewayPid: process.pid, headPid: process.pid, sessionId: "session-main",
        sessionFile: hostPaths(config, "main").sessionFile, state: "accepted" };
    };
    const draining = runtime.kick();
    await started.promise;
    await runtime.receive(message("restart-shared-drain", route(), "/restart"));
    const admitted = Promise.withResolvers<void>();
    setImmediate(admitted.resolve);
    await admitted.promise;
    expect(store.output("restart-shared-drain:restart-ack")?.state).toBe("pending");
    expect(requests).toEqual([]);
    release.resolve();
    await draining;
    await runtime.kick();
    expect(requests).toHaveLength(1);
    expect(store.output("restart-shared-drain:restart-ack")?.state).toBe("sent");
  });

  test("RPC response loss stays uncertain, holds the whole service and never authorizes retry", async () => {
    const { runtime, main, store, messenger, requests, handoff } = restartFixture();
    handoff.respond = async () => { throw new Error("secret-token lost HTTP response"); };
    await runtime.start();
    const original = applicationCommand("1750000000000000800", route(), "/restart");
    await admit(runtime, original);
    expect(JSON.parse(store.getMeta("head:restart-fence")!).state).toBe("uncertain");
    expect(store.input(original.id)?.state).toBe("done");
    await admit(runtime, original);
    await admit(runtime, message("restart-after-rpc-loss", route(), "/restart"));
    await runtime.receive(headMessage("work-after-rpc-loss"));
    await runtime.kick();
    expect(requests).toHaveLength(1);
    expect(main.prompts).toEqual([]);
    expect(store.input("work-after-rpc-loss")?.state).toBe("pending");
    expect(messenger.sent.map(output => output.text).join("\n")).not.toContain("secret-token");
    expect(messenger.sent.filter(output => output.id === `${original.id}:restart-uncertain`)).toHaveLength(1);
  });

  test("a definitive preacceptance RPC rejection refuses and clears the fence without retrying the original request", async () => {
    const { runtime, store, main, messenger, requests, handoff } = restartFixture();
    handoff.respond = async () => { throw new DeliveryError("secret rejected response", "rejected"); };
    await runtime.start();
    const original = applicationCommand("1750000000000000801", route(), "/restart");
    await admit(runtime, original);
    const request = requests[0]!;
    expect(store.getMeta(`gateway:restart:${request.requestId}`)).toBeNull();
    expect(store.getMeta("head:restart-fence")).toBe("");
    expect(JSON.parse(store.getMeta(`head:restart:${original.id}`)!).state).toBe("refused");
    expect(store.output(`${original.id}:restart-result`)?.text).toContain("No process was stopped");
    expect(store.output(`${original.id}:restart-result`)?.text).not.toContain("secret rejected response");
    await admit(runtime, original);
    await admit(runtime, headMessage("work-after-definitive-rejection"));
    expect(requests).toHaveLength(1);
    expect(main.prompts).toHaveLength(1);
    expect(messenger.sent.filter(output => output.id === `${original.id}:restart-result`)).toHaveLength(1);
  });

  test("a rejection cannot release a restart that already has durable Gateway acceptance", async () => {
    const { runtime, store, requests, handoff, config } = restartFixture();
    handoff.respond = async request => {
      const receipt: GatewayRestartRecord = { ...request, gatewayPid: process.pid, headPid: process.pid,
        sessionId: "session-main", sessionFile: hostPaths(config, "main").sessionFile, state: "accepted" };
      store.setMeta(`gateway:restart:${request.requestId}`, JSON.stringify(receipt));
      throw new DeliveryError("A rejected response is not authority to undo prior acceptance", "rejected");
    };
    await runtime.start();
    const original = applicationCommand("1750000000000000802", route(), "/restart");
    await admit(runtime, original);
    expect(JSON.parse(store.getMeta("head:restart-fence")!).state).toBe("uncertain");
    await admit(runtime, original);
    expect(requests).toHaveLength(1);
    expect(store.output(`${original.id}:restart-result`)).toBeNull();
    expect(store.output(`${original.id}:restart-uncertain`)).not.toBeNull();
  });

  test("owned refusal notices clear only their exact fence and send one result to the original route", async () => {
    const { runtime, store, messenger, requests } = restartFixture();
    await runtime.start();
    const original = applicationCommand("1750000000000000900", route("restart-original"), "/restart");
    await admit(runtime, original);
    const request = requests[0]!;
    const receipt: GatewayRestartRecord = { ...request, gatewayPid: process.pid, headPid: process.pid,
      sessionId: "session-main", sessionFile: hostPaths(runtime.config, "main").sessionFile, state: "refused" };
    store.setMeta(`gateway:restart:${request.requestId}`, JSON.stringify(receipt));
    await messenger.handlers!.restart!({ requestId: "other-request", outcome: "refused", reason: "not this owner" });
    expect(store.getMeta("head:restart-fence")).toBeTruthy();
    const notice = { requestId: request.requestId, outcome: "refused" as const, reason: "secret native refusal" };
    await messenger.handlers!.restart!(notice);
    await messenger.handlers!.restart!(notice);
    expect(store.getMeta("head:restart-fence")).toBe("");
    expect(messenger.sent.filter(output => output.id === `${original.id}:restart-result`)).toMatchObject([{ route: original.route, sourceId: original.id }]);
    expect(store.output(`${original.id}:restart-result`)?.text).not.toContain("secret native refusal");
    expect(requests).toHaveLength(1);
  });

  test("uncertain lifecycle notices remain held and deduplicate their original-route result", async () => {
    const { runtime, store, messenger, requests, main } = restartFixture();
    await runtime.start();
    const original = applicationCommand("1750000000000000901", route("uncertain-original"), "/restart");
    await admit(runtime, original);
    const request = requests[0]!;
    const receipt: GatewayRestartRecord = { ...request, gatewayPid: process.pid, headPid: process.pid,
      sessionId: "session-main", sessionFile: hostPaths(runtime.config, "main").sessionFile, state: "uncertain" };
    store.setMeta(`gateway:restart:${request.requestId}`, JSON.stringify(receipt));
    const notice = { requestId: request.requestId, outcome: "uncertain" as const, reason: "secret shutdown response" };
    await messenger.handlers!.restart!(notice);
    await messenger.handlers!.restart!(notice);
    await runtime.receive(headMessage("held-after-notice"));
    await runtime.kick();
    expect(JSON.parse(store.getMeta("head:restart-fence")!).state).toBe("uncertain");
    expect(messenger.sent.filter(output => output.id === `${original.id}:restart-uncertain`)).toMatchObject([{ route: original.route, sourceId: original.id }]);
    expect(messenger.sent.map(output => output.text).join("\n")).not.toContain("secret shutdown response");
    expect(store.input("held-after-notice")?.state).toBe("pending");
    expect(main.prompts).toEqual([]);
    expect(requests).toHaveLength(1);
  });

  test("replacement startup proves both owners and initialization, restores the original slash route and emits readiness once", async () => {
    const instance = restartFixture();
    const { input, restart } = savedRestart(instance);
    await instance.runtime.start();
    await instance.runtime.kick();
    await admit(instance.runtime, input);
    await instance.messenger.handlers!.restart!({ requestId: restart.requestId, outcome: "uncertain", reason: "late notice" });
    expect(instance.store.getMeta("head:restart-fence")).toBe("");
    expect(instance.messenger.sent).toMatchObject([{ id: `${input.id}:restart-result`, sourceId: input.id, route: input.route }]);
    expect(instance.messenger.sent[0]!.text).toContain("initialized and ready");
    expect(instance.store.input(input.id)).toMatchObject({ interactionId: input.interactionId, messageId: null, state: "done", route: input.route });
    expect(instance.requests).toEqual([]);
    expect(instance.main.prompts).toEqual([]);
  });

  test.each([
    [true, true, "off"], [undefined, false, "off"], [false, undefined, "off"], [false, true, "off"],
    [false, false, "high"],
  ] as const)("restart holds an absent effort when reasoning changes from %s to %s or effort becomes %s", async (before, after, effort) => {
    const instance = restartFixture();
    const { input, restart } = savedRestart(instance);
    const checkpoint = { ...restart, checkpoint: { goalActive: false, residents: [],
      model: { ...executionModel, reasoning: before } } };
    instance.store.setMeta(`head:restart:${input.id}`, JSON.stringify(checkpoint));
    instance.store.setMeta("head:restart-fence", JSON.stringify(checkpoint));
    const resumed = { ...executionModel, reasoning: after };
    instance.main.state.model = resumed;
    instance.main.state.thinkingLevel = effort;
    await instance.runtime.start();
    await instance.runtime.kick();
    expect(JSON.parse(instance.store.getMeta("head:restart-fence")!).state).toBe("failed");
    expect(instance.store.output(`${input.id}:restart-result`)?.text).toContain("differs from its checkpoint");
    expect(instance.main.prompts).toEqual([]);
  });

  test.each(["refused", "failed"] as const)("startup sends one original-route %s lifecycle result without replaying any handoff", async state => {
    const instance = restartFixture();
    const { input } = savedRestart(instance, state);
    await instance.runtime.start();
    await instance.runtime.kick();
    await instance.runtime.kick();
    expect(instance.messenger.sent).toMatchObject([{ id: `${input.id}:restart-result`, sourceId: input.id, route: input.route }]);
    expect(instance.messenger.sent[0]!.text).toContain(state === "refused" ? "restart refused" : "readiness failed");
    if (state === "refused") expect(instance.store.getMeta("head:restart-fence")).toBe("");
    else expect(instance.store.getMeta("head:restart-fence")).toBeTruthy();
    expect(instance.requests).toEqual([]);
    expect(instance.main.prompts).toEqual([]);
  });

  test.each([
    ["journal", ["observation-cursor", undefined]],
    ["buffered", ["observation-cursor", "journal-wait", undefined]],
    ["buffered-at-checkpoint", ["observation-cursor", "observation-cursor", undefined]],
    ["eval-journal", ["observation-source-start", undefined]],
    ["empty-origin", [undefined, undefined]],
  ] as const)("restart restores source-bound lane observations in %s order without resetting clocks or replaying work", async (timing, readCursors) => {
    const instance = restartFixture();
    const { store, config, hosts, main, runtime } = instance;
    const lane = savedLane(store, config, "observation-recovery", route("observation-topic"), process.pid);
    const native = new HostTransport(lane.sessionFile, `session-${lane.id}`);
    native.state.isSettled = false;
    native.state.isStreaming = true;
    hosts.set(lane.socketPath, native);
    main.local = true;
    const original = message("observation-original", lane.route);
    store.receive(original, lane.id);
    store.submit(original.id, "observation-request", lane.generation);
    const { restart } = savedRestart(instance);
    const checkpoint = { ...restart, checkpoint: {
      goalActive: false, model: executionModel, thinkingLevel: "high",
      residents: [{ id: lane.id, generation: lane.generation, pid: process.pid, sessionId: native.state.sessionId,
        inputId: original.id, requestIds: ["observation-request"], ownedRuns: 1, entryId: "observation-cursor" }],
    } };
    store.setMeta(`head:restart:${restart.inputId}`, JSON.stringify(checkpoint));
    store.setMeta("head:restart-fence", JSON.stringify(checkpoint));
    const toolResult = (id: string, target: string, timestamp: number) => ({
      role: "toolResult", toolName: "lane_report", toolCallId: id, timestamp, details: {
        type: "superagent-lane-report", sessionId: native.state.sessionId, reportId: id,
        report: { status: "waiting", summary: `Waiting on ${target}`,
          waiting: { kind: "dependency", target }, evidence: [] },
      },
    });
    const originalWait = toolResult("journal-wait", "original-dependency", 1000);
    native.entries = [
      { type: "message", id: "unowned-before", message: toolResult("old-unowned", "wrong-before-checkpoint", 500) },
      { id: "observation-cursor", type: "custom", customType: "checkpoint" },
      { type: "message", id: "journal-wait", message: originalWait },
    ];
    if (timing === "eval-journal" || timing === "empty-origin") {
      const start = { id: "observation-source-start", type: "custom", customType: "source-start" };
      native.entries = [
        ...(timing === "eval-journal" ? [native.entries[0], start] : []),
        { id: "native-eval-report", type: "custom", customType: "superagent-lane-report",
          timestamp: new Date(1000).toISOString(), data: originalWait.details },
        { id: "observation-cursor", type: "custom", customType: "checkpoint" },
      ];
      store.setMeta(`lane-observation-owner:${original.id}`, JSON.stringify({
        sessionId: native.state.sessionId, sessionFile: lane.sessionFile, generation: lane.generation,
        requestId: "observation-request", cursor: timing === "eval-journal" ? start.id : null,
      }));
    }
    if (timing === "buffered-at-checkpoint") native.entries.pop();
    const buffered = timing === "buffered" || timing === "buffered-at-checkpoint";
    const newer = toolResult("buffered-wait", "newer-dependency", 2000);
    if (buffered) native.afterEntries = () => {
      native.afterEntries = undefined;
      native.entries.push({ type: "message", id: "buffered-wait", message: newer });
      native.emit({ type: "message_end", message: newer });
    };
    await runtime.start();
    await runtime.kick();
    const reads = native.commands.filter(command => command.type === "get_entries");
    expect(reads.map(command => command.since)).toEqual([...readCursors]);
    const expected = buffered ? { target: "newer-dependency", since: 2000 } : { target: "original-dependency", since: 1000 };
    expect(store.lane(lane.id)?.observation).toMatchObject({
      inputId: original.id, requestId: "observation-request", sessionId: native.state.sessionId, lastEvidenceAt: null,
      waiting: { target: { kind: "dependency", target: expected.target }, since: expected.since },
    });
    native.emit({ type: "message_end", message: timing === "buffered-at-checkpoint" ? newer : originalWait });
    await runtime.kick();
    expect(store.lane(lane.id)?.observation?.waiting?.since).toBe(expected.since);
    expect(await runtime.inspect(lane.id)).toMatchObject({ observationState: { ownerCurrent: true } });
    expect(store.input(original.id)?.state).toBe("submitted");
    expect(native.prompts).toEqual([]);
    expect(native.abortCount).toBe(0);
  });

  for (const outcome of ["completed", "error", "aborted"] as const)
  test.each(["before-attachment", "after-attachment", "between-state-and-entries", "entries-snapshot", "publication"] as const)(`surviving lane ${outcome} %s is recovered from authoritative runs without replay`, async timing => {
    const instance = restartFixture();
    const { store, config, hosts, main, runtime, messenger } = instance;
    const lane = savedLane(store, config, "restart-surviving-lane", route("surviving-topic"), process.pid);
    const native = new HostTransport(lane.sessionFile, `session-${lane.id}`);
    hosts.set(lane.socketPath, native);
    main.local = true;
    const window = timing !== "before-attachment" && timing !== "after-attachment";
    const original = message("surviving-original-request", lane.route);
    const source = window ? message("surviving-parent-user", route("original-window-source")) : original;
    if (window) {
      store.receive(source, "main", { [`user-source:${source.id}`]: "true" });
      store.settle(source.id, "done");
    }
    store.receive(original, lane.id, window ? { [`handoff-source:${original.id}`]: source.id } : {});
    store.submit(original.id, "surviving-native-request", lane.generation);
    const { restart } = savedRestart(instance);
    const checkpoint = { ...restart, checkpoint: {
      goalActive: false, model: executionModel, thinkingLevel: "high",
      residents: [{ id: lane.id, generation: lane.generation, pid: process.pid, sessionId: native.state.sessionId,
        inputId: original.id, requestIds: ["surviving-native-request"], ownedRuns: 1, entryId: "snapshot-leaf" }],
    } };
    store.setMeta(`head:restart:${restart.inputId}`, JSON.stringify(checkpoint));
    store.setMeta("head:restart-fence", JSON.stringify(checkpoint));
    native.entries = [{ id: "snapshot-leaf", type: "custom", customType: "checkpoint" }];
    const recordYield = () => {
      const message = { role: "assistant", stopReason: "stop",
        content: [{ type: "text", text: window ? "Earlier successful native yield" : "Recovered original lane result" }] };
      native.entries.push({ type: "message", id: "final-assistant", message }, {
        type: "custom", customType: "rpc_prompt_result", data: {
          sessionId: native.state.sessionId, sessionFile: lane.sessionFile,
          frame: { id: "surviving-native-request", status: "completed", agentInvoked: true },
        },
      });
      return message;
    };
    const start = { type: "custom", customType: "rpc_agent_start", data: {
      sessionId: native.state.sessionId, sessionFile: lane.sessionFile,
    } };
    if (window) { recordYield(); native.entries.push(start); }
    const recordCompletion = () => {
      let message = window
        ? { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Recovered original lane result" }] } : recordYield();
      if (outcome !== "completed" || window) {
        message = { role: "assistant", stopReason: outcome === "completed" ? "stop" : outcome,
          content: [{ type: "text", text: outcome === "completed" ? "Recovered original lane result" : "Private detached continuation diagnostics" }] };
        if (!window) native.entries.push({ type: "custom", customType: "rpc_agent_start", data: {
          sessionId: native.state.sessionId, sessionFile: lane.sessionFile,
        } });
        native.entries.push({ type: "message", id: "continuation-assistant", message });
      }
      native.state.isSettled = true;
      native.state.isStreaming = false;
      return message;
    };
    if (timing === "before-attachment") recordCompletion();
    else { native.state.isSettled = false; native.state.isStreaming = true; }
    const terminal = () => {
      const message = recordCompletion();
      native.emit({ type: "message_end", message });
      native.emit({ type: "agent_end", isTerminal: true, messages: [message] });
      native.emit({ type: "session_settled" });
    };
    if (timing === "between-state-and-entries") native.beforeEntries = async () => {
      native.beforeEntries = undefined;
      const question = { type: "extension_ui_request", method: "confirm", id: "window-question", title: "Confirm original work" };
      native.state.pendingUiRequests = [question];
      native.emit(question);
      await messenger.whenApproval();
      native.state.pendingUiRequests = [];
      native.emit({ type: "extension_ui_request", method: "cancel", targetId: question.id });
      terminal();
    };
    if (timing === "entries-snapshot" || timing === "publication") native.afterEntries = () => {
      native.afterEntries = undefined;
      if (timing === "publication") queueMicrotask(terminal);
      else terminal();
    };
    await runtime.start();
    if (timing === "after-attachment") {
      expect(store.input(original.id)?.state).toBe("submitted");
      if (outcome !== "completed") native.emit({ type: "agent_start" });
      native.emit({ type: "message_end", message: recordCompletion() });
      // prompt_result is deliberately NOT delivered to this replacement client.
      native.emit({ type: "session_settled" });
    }
    await main.whenPrompts(1);
    await runtime.kick();
    expect(store.input(original.id)?.state).toBe(outcome === "completed" ? "done" : outcome === "error" ? "uncertain" : "cancelled");
    expect(store.input(`report:${original.id}`)).toMatchObject({ route: source.route });
    expect(store.getMeta(`activity-source:report:${original.id}`)).toBe(source.id);
    expect(store.input(`report:${original.id}`)?.text).toContain(native.state.sessionId);
    expect(store.input(`report:${original.id}`)?.text).toContain(lane.sessionFile);
    if (timing === "between-state-and-entries") {
      expect([...messenger.shown.values()]).toMatchObject([{ route: original.route, generation: lane.generation, requestId: "window-question" }]);
      expect(messenger.dismissed).toHaveLength(1);
    }
    if (outcome === "completed") expect(store.input(`report:${original.id}`)?.text).toContain("Recovered original lane result");
    else expect(store.input(`report:${original.id}`)?.text).not.toContain("Private detached continuation diagnostics");
    expect(native.prompts).toEqual([]);
    expect(native.abortCount).toBe(0);
    expect(main.prompts).toHaveLength(1);
  });

  test.each(["retained", "before-checkpoint", "error", "aborted", "retry"] as const)("surviving lane empty-tail recovery respects its checkpoint boundary: %s", async scenario => {
    const instance = restartFixture();
    const { store, config, hosts, main, runtime, messenger } = instance;
    const lane = savedLane(store, config, "retention-recovery", route("retention-recovery"), process.pid);
    const native = new HostTransport(lane.sessionFile, `session-${lane.id}`);
    hosts.set(lane.socketPath, native);
    main.local = true;
    const original = message("retention-recovery-original", lane.route);
    store.receive(original, lane.id);
    store.submit(original.id, "retention-recovery-native", lane.generation);
    const { restart } = savedRestart(instance);
    const checkpoint = { ...restart, checkpoint: {
      goalActive: false, model: executionModel, thinkingLevel: "high",
      residents: [{ id: lane.id, generation: lane.generation, pid: process.pid, sessionId: native.state.sessionId,
        inputId: original.id, requestIds: ["retention-recovery-native"], ownedRuns: 1, entryId: "retention-checkpoint" }],
    } };
    store.setMeta(`head:restart:${restart.inputId}`, JSON.stringify(checkpoint));
    store.setMeta("head:restart-fence", JSON.stringify(checkpoint));
    const assistant = (text: string, stopReason = "stop") => ({ type: "message", message: {
      role: "assistant", stopReason, content: [{ type: "text", text }],
    } });
    native.entries = [assistant("Unrelated old session secret"), {
      id: "retention-checkpoint", ...assistant("Unowned pre-checkpoint answer"),
    }];
    if (scenario !== "before-checkpoint") native.entries.push(assistant("Earlier owned answer"));
    native.entries.push({ type: "custom", customType: "rpc_prompt_result", data: {
      sessionId: native.state.sessionId, sessionFile: lane.sessionFile,
      frame: { id: "retention-recovery-native", status: scenario === "retry" ? "error" : "completed", agentInvoked: true },
    } });
    if (scenario === "error" || scenario === "aborted" || scenario === "retry") {
      native.entries.push({ type: "custom", customType: "rpc_agent_start", data: {
        sessionId: native.state.sessionId, sessionFile: lane.sessionFile,
      } }, assistant("Private detached diagnostics", scenario === "retry" ? "error" : scenario));
    }
    if (scenario === "retained" || scenario === "retry") native.entries.push(assistant("Latest owned answer"));
    if (scenario !== "error" && scenario !== "aborted") native.entries.push(
      { type: "message", message: { role: "user", content: "TODO reminder: finish remaining work" } },
      assistant(""), assistant(" \n\t"),
      { type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "thinking", thinking: "Private reasoning" }] } },
    );
    await runtime.start();
    await main.whenPrompts(1);
    await runtime.kick();
    expect(store.input(original.id)?.state).toBe(scenario === "error" ? "uncertain" : scenario === "aborted" ? "cancelled" : "done");
    const report = store.input(`report:${original.id}`);
    expect(report).toMatchObject({ route: original.route });
    expect(report!.text).not.toContain("Unrelated old session secret");
    expect(report!.text).not.toContain("Unowned pre-checkpoint answer");
    expect(report!.text).not.toContain("Private detached diagnostics");
    if (scenario === "retained" || scenario === "retry") expect(report!.text).toContain("Latest owned answer");
    else expect(report!.text).not.toContain("Earlier owned answer");
    expect(native.prompts).toEqual([]);
    expect(native.abortCount).toBe(0);
    expect(main.prompts).toHaveLength(1);
    expect(messenger.sent.map(output => output.sourceId)).toEqual([restart.inputId]);
  });

  test.each(["error", "aborted"] as const)("a recovered older %s cannot settle a newer run started during final journal read", async olderOutcome => {
    const instance = restartFixture();
    const { store, config, hosts, main, runtime } = instance;
    const lane = savedLane(store, config, "recovery-newer-run", route("newer-run"), process.pid);
    const native = new HostTransport(lane.sessionFile, `session-${lane.id}`);
    hosts.set(lane.socketPath, native);
    main.local = true;
    const original = message("newer-run-original", lane.route);
    store.receive(original, lane.id);
    store.submit(original.id, "newer-run-native", lane.generation);
    const { restart } = savedRestart(instance);
    const checkpoint = { ...restart, checkpoint: {
      goalActive: false, model: executionModel, thinkingLevel: "high",
      residents: [{ id: lane.id, generation: lane.generation, pid: process.pid, sessionId: native.state.sessionId,
        inputId: original.id, requestIds: ["newer-run-native"], ownedRuns: 1, entryId: "newer-run-checkpoint" }],
    } };
    store.setMeta(`head:restart:${restart.inputId}`, JSON.stringify(checkpoint));
    store.setMeta("head:restart-fence", JSON.stringify(checkpoint));
    const start = () => ({ type: "custom", customType: "rpc_agent_start", data: {
      sessionId: native.state.sessionId, sessionFile: lane.sessionFile,
    } });
    native.entries = [{ id: "newer-run-checkpoint", type: "custom", customType: "checkpoint" }, {
      type: "custom", customType: "rpc_prompt_result", data: {
        sessionId: native.state.sessionId, sessionFile: lane.sessionFile,
        frame: { id: "newer-run-native", status: "completed", agentInvoked: true },
      },
    }, start(), { type: "message", message: {
      role: "assistant", stopReason: olderOutcome, content: [{ type: "text", text: "Older private failure" }],
    } }];
    let started = false;
    native.afterEntries = () => {
      native.afterEntries = undefined;
      native.beforeEntries = () => {
        native.beforeEntries = undefined;
        native.entries.push(start());
        native.state.isSettled = false;
        native.state.isStreaming = true;
        native.emit({ type: "agent_start" });
        started = true;
      };
    };
    await runtime.start();
    expect(started).toBe(true);
    expect(store.input(original.id)?.state).toBe("submitted");
    expect(store.input(`report:${original.id}`)).toBeNull();
    expect(main.prompts).toEqual([]);
    const finalMessage = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Newer run verified completion" }] };
    native.entries.push({ type: "message", message: finalMessage });
    native.state.isSettled = true;
    native.state.isStreaming = false;
    native.emit({ type: "message_end", message: finalMessage });
    native.emit({ type: "session_settled" });
    await main.whenPrompts(1);
    await runtime.kick();
    expect(store.input(original.id)?.state).toBe("done");
    expect(store.input(`report:${original.id}`)).toMatchObject({ route: original.route });
    expect(store.input(`report:${original.id}`)?.text).toContain("Newer run verified completion");
    expect(store.input(`report:${original.id}`)?.text).not.toContain("Older private failure");
    expect(native.prompts).toEqual([]);
    expect(native.abortCount).toBe(0);
    expect(main.prompts).toHaveLength(1);
  });

  test.each(["accepted", "uncertain", "missing-receipt", "wrong-request", "wrong-replacement", "old-owner-alive"] as const)("startup does not clear a %s fence without exact completed ownership evidence", async scenario => {
    const instance = restartFixture();
    const { restart, receipt, input } = savedRestart(instance,
      scenario === "accepted" || scenario === "uncertain" ? scenario : "started", scenario === "old-owner-alive" ? process.pid : undefined);
    if (scenario === "wrong-request") receipt.inputId = "unrelated-owner";
    if (scenario === "wrong-replacement") receipt.replacementPid = 2_000_000_003;
    instance.store.setMeta(`gateway:restart:${restart.requestId}`, scenario === "missing-receipt" ? "" : JSON.stringify(receipt));
    await instance.runtime.start();
    await instance.runtime.kick();
    expect(instance.store.getMeta("head:restart-fence")).toBeTruthy();
    expect(instance.store.output(`${input.id}:restart-result`)).toBeNull();
    expect(instance.main.prompts).toEqual([]);
    expect(instance.requests).toEqual([]);
  });

  test("replacement initialization failure sends a fixed original-route failure without a model turn or unsafe fence release", async () => {
    const instance = fixture(3, undefined, { inspectPresets: async () => ({ settings: { modelRoles: {} },
      configuredDefault: { available: true }, availableModels: [executionModel], presets: [],
      bootstrap: { missing: ["high", "middle", "low"], blocked: [] } }) });
    const { input } = savedRestart(instance);
    await instance.runtime.start();
    await instance.runtime.kick();
    expect(instance.main.prompts).toEqual([]);
    expect(instance.store.getMeta("head:restart-fence")).toBeTruthy();
    expect(instance.messenger.sent).toMatchObject([{ id: `${input.id}:restart-result`, sourceId: input.id, route: input.route }]);
    expect(instance.messenger.sent[0]!.text).toContain("readiness failed");
  });

  test("invalid restart arguments and command lookalikes never acquire restart authority", async () => {
    const { runtime, main, requests, store, config, hosts } = restartFixture();
    const lane = savedLane(store, config, "restart-lookalike", route());
    await runtime.start();
    await admit(runtime, message("invalid-restart", route(), "/restart force"));
    expect(store.input("invalid-restart")?.state).toBe("cancelled");
    expect(store.getMeta("head:restart-fence")).toBeNull();
    await admit(runtime, message("restart-lookalike", lane.route, "/restarting"));
    expect(hosts.get(lane.socketPath)?.prompts[0]?.command.message).toContain("/restarting");
    expect(main.prompts).toEqual([]);
    expect(requests).toEqual([]);
  });
});

describe("messenger head session controls", () => {
  test("an explicit owner request switches HEAD after settlement and before the next queued turn", async () => {
    const { runtime, main, messenger } = fixture();
    const source = headMessage("head-natural-model", route("original"), "Please switch your own model to fixture/efficient.");
    const next = headMessage("head-next-model", route("other-source"), "Continue on the new model.");
    await runtime.start();
    await admit(runtime, source);
    await admit(runtime, next);
    expect(runtime.requestHeadModel({ sourceId: source.id, model: otherModel })).toMatchObject({ status: "scheduled" });
    runtime.requestHeadModel({ sourceId: source.id, model: otherModel });
    await runtime.kick();
    expect(main.state.model).toEqual(executionModel);
    expect(main.prompts).toHaveLength(1);

    let modelForNextPrompt: RuntimeState["model"];
    main.beforePrompt = () => { modelForNextPrompt = main.state.model; };
    main.complete("I scheduled the model change.");
    await main.whenPrompts(2);
    await messenger.whenSent(2);
    expect(modelForNextPrompt).toEqual(otherModel);
    expect(messenger.sent[1]).toMatchObject({ route: source.route, replyTo: { messageId: source.messageId } });
    expect(messenger.sent[1]?.text).toContain("fixture/efficient");
    await admit(runtime, source);
    expect(main.commands.filter(command => command.type === "set_model")).toHaveLength(1);
  });

  test("an internal report or old owner request cannot authorize a HEAD model change", async () => {
    const { runtime, main, store, messenger } = fixture();
    const old = headMessage("head-stale-model");
    const report = message("report:natural-head-model", route(), "Switch your own model to fixture/efficient.");
    await runtime.start();
    await admit(runtime, old);
    main.complete("Previous request completed.");
    await messenger.whenSent(1);
    store.receive(report, "main", { [`activity-source:${report.id}`]: old.id });
    await runtime.kick();
    expect(main.prompts).toHaveLength(2);
    for (const sourceId of [report.id, old.id]) {
      expect(() => runtime.requestHeadModel({ sourceId, model: otherModel })).toThrow("original owner request");
    }
    expect(main.state.model).toEqual(executionModel);
  });

  test("stopping the originating HEAD turn cancels its scheduled model change", async () => {
    const { runtime, main, store } = fixture();
    const source = headMessage("head-cancel-natural-model", route(), "Switch your own model to fixture/efficient.");
    await runtime.start();
    await admit(runtime, source);
    runtime.requestHeadModel({ sourceId: source.id, model: otherModel });

    await admit(runtime, message("head-stop-natural-model", route(), "/stop head"));
    expect(store.input(source.id)?.state).toBe("cancelled");
    expect(main.state.model).toEqual(executionModel);
    expect(main.commands.filter(command => command.type === "set_model")).toEqual([]);
  });

  test("an unconfirmed scheduled HEAD model change holds later turns without replay", async () => {
    const { runtime, main, messenger } = fixture();
    const source = headMessage("head-uncertain-natural-model", route(), "Switch your own model to fixture/efficient.");
    await runtime.start();
    await admit(runtime, source);
    await admit(runtime, headMessage("head-followup-uncertain-model", route("other-source")));
    runtime.requestHeadModel({ sourceId: source.id, model: otherModel });
    main.modelSetResult = "throw-after";

    main.complete("I scheduled the model change.");
    await messenger.whenSent(2);
    await runtime.kick();
    expect(messenger.sent[1]?.text).toContain("outcome is uncertain");
    expect(main.prompts).toHaveLength(1);
    expect(main.commands.filter(command => command.type === "set_model")).toHaveLength(1);
  });

  test("busy queries bypass prompt dispatch and expose only safe native model identities and effort", async () => {
    const { runtime, main, store, messenger } = fixture();
    main.models.push({ ...otherModel, apiKey: "secret-api-key", baseUrl: "https://private-endpoint", headers: { Authorization: "secret-header" } });
    await runtime.start();
    await admit(runtime, headMessage("head-running"));
    for (const [index, text] of ["/model", "/model list", "/effort"].entries()) {
      await admit(runtime, message(`head-query-${index}`, route("other-source"), text));
      expect(store.input(`head-query-${index}`)?.state).toBe("done");
    }
    expect(main.prompts).toHaveLength(1);
    expect(main.commands.filter(command => command.type === "set_model" || command.type === "set_thinking_level")).toEqual([]);
    const replies = messenger.sent.map(output => output.text).join("\n");
    expect(replies).toContain("HEAD session only");
    expect(replies).toContain("fixture/capable");
    expect(replies).toContain("fixture/efficient");
    expect(replies).toContain("effort: high");
    expect(replies).toContain("off, minimal, high");
    expect(replies).not.toContain("fixture/judge");
    expect(replies).not.toContain("secret");
    expect(replies).not.toContain("private-endpoint");
    expect(store.input("head-running")?.state).toBe("submitted");
  });

  test("scoped model and effort changes persist intent, read back effective effort, and leave bound lanes and native defaults unchanged", async () => {
    const { runtime, store, config, main, messenger, launched } = fixture();
    const lane = savedLane(store, config, "head-bound-reference", route("head-bound-reference"));
    const saved = structuredClone(store.lane(lane.id));
    const settings = structuredClone(main.state.modelSettings);
    main.modelEffort = "minimal";
    main.beforeSetModel = () => {
      expect(store.input("head-model-change")).toMatchObject({ state: "submitted", target: "main", generation: 0 });
      expect(store.input("head-model-change")?.requestId).toBeTruthy();
    };
    main.beforeSetEffort = () => {
      expect(store.input("head-effort-change")?.state).toBe("submitted");
    };
    await runtime.start();
    await admit(runtime, message("head-model-change", lane.route, "/model fixture/efficient"));
    main.effortClamp = "off";
    await admit(runtime, message("head-effort-change", lane.route, "/effort minimal"));
    expect(main.state.model).toEqual(otherModel);
    expect(main.state.thinkingLevel).toBe("off");
    expect(main.state.modelSettings).toEqual(settings);
    expect(store.lane(lane.id)).toEqual(saved);
    expect(launched).toEqual([]);
    expect(main.prompts).toEqual([]);
    expect(messenger.sent).toHaveLength(2);
    expect(messenger.sent[0]).toMatchObject({ route: lane.route });
    expect(messenger.sent[0]!.text).toContain("HEAD session only (not lanes or global defaults)");
    expect(messenger.sent[0]!.text).toContain("effort: minimal");
    expect(messenger.sent[1]!.text).toContain("effort: off");
    expect(messenger.sent[1]!.text).toContain("differs from the requested level");
    expect(store.input("head-model-change")?.state).toBe("done");
    expect(store.input("head-effort-change")?.state).toBe("done");
  });

  test("DM topic commands retain their original route and still change only HEAD", async () => {
    const { runtime, main, store, messenger } = fixture();
    await runtime.start();
    const destination = route(null, { guildId: null });
    await admit(runtime, message("1001", destination, "/new"));
    await admit(runtime, message("1002", destination, "/model fixture/efficient"));
    const original = store.input("1002")!;
    expect(original.route.topicId).toBeTruthy();
    expect(main.state.model).toEqual(otherModel);
    expect(messenger.sent.at(-1)?.route).toEqual(original.route);
    await admit(runtime, message("1003", destination, "/main"));
    await admit(runtime, message("1002", destination, "/model fixture/efficient"));
    expect(store.input("1002")?.route).toEqual(original.route);
    expect(main.commands.filter(command => command.type === "set_model")).toHaveLength(1);
    expect(main.prompts).toEqual([]);
  });

  test("picker selections stay on their opening topic and reject effort for a different model", async () => {
    const { runtime, main, store, messenger } = fixture();
    const destination = route(null, { guildId: null });
    await runtime.start();
    await admit(runtime, message("1001", destination, "/new"));
    await admit(runtime, message("1002", destination, "/effort"));
    await admit(runtime, message("1003", destination, "/model"));
    const effort = messenger.sent.find(output => output.sourceId === "1002");
    const model = messenger.sent.find(output => output.sourceId === "1003");
    if (!effort?.picker || !model?.picker) throw new Error("HEAD did not send both menus");
    expect(model.picker.groups).toEqual([{ label: "fixture", options: ["fixture/capable", "fixture/efficient"] }]);
    expect(effort.picker.groups).toEqual([{ label: "Effort", options: ["off", "minimal", "high"] }]);
    await admit(runtime, message("1004", destination, "/main"));
    const modelSelection = pickerClick(model, 0, 1);
    await expect(runtime.receive({ ...modelSelection, route: destination })).rejects.toThrow("original owner command and card");
    await admit(runtime, modelSelection);
    await admit(runtime, modelSelection);
    expect(main.state.model).toEqual(otherModel);
    expect(main.commands.filter(command => command.type === "set_model")).toHaveLength(1);
    expect(store.input(modelSelection.id)?.route).toEqual(model.route);
    expect(messenger.sent.at(-1)?.route).toEqual(model.route);

    const staleEffort = pickerClick(effort, 0, 1);
    await admit(runtime, staleEffort);
    expect(store.input(staleEffort.id)?.state).toBe("cancelled");
    expect(main.commands.filter(command => command.type === "set_thinking_level")).toEqual([]);
    await admit(runtime, message("1005", destination, "/effort"));
    const freshEffort = messenger.sent.at(-1);
    if (!freshEffort?.picker) throw new Error("HEAD did not refresh the effort menu");
    await admit(runtime, pickerClick(freshEffort, 0, 1));
    expect(main.state.thinkingLevel).toBe("minimal");
    expect(main.prompts).toEqual([]);
  });

  test.each(["unconfirmed", "wrong-card"] as const)("a %s menu receipt cannot authorize a HEAD model change", async receipt => {
    const { runtime, main, store, messenger } = fixture();
    await runtime.start();
    if (receipt === "unconfirmed") messenger.sendError = new DeliveryError("Lost fixture send receipt", "uncertain");
    await admit(runtime, message("701", route(), "/model"));
    messenger.sendError = undefined;
    const output = messenger.attempted.find(candidate => !!candidate.picker);
    if (!output) throw new Error("Expected an attempted menu delivery");
    const click = pickerClick(output, 0, 1);
    const original = click.pickerSelection;
    if (!original) throw new Error("Expected a picker receipt");
    await admit(runtime, receipt === "wrong-card" ? { ...click, pickerSelection: { ...original, cardId: "another-card" } } : click);
    expect(store.input(click.id)?.state).toBe("cancelled");
    expect(main.state.model).toEqual(executionModel);
    expect(main.commands.filter(command => command.type === "set_model")).toEqual([]);
  });

  test("the selected provider disambiguates the full identity and keeps native model IDs with spaces", async () => {
    const { runtime, main, messenger } = fixture();
    const selected = { provider: "local/team", id: "model" };
    const spaced = { provider: "local/team", id: "My Model" };
    main.models.push({ provider: "local", id: "team/model" }, selected, spaced);
    await runtime.start();
    for (const [index, model] of [selected, spaced].entries()) {
      await admit(runtime, message(`picker-exact-${index}`, route(), "/model"));
      const output = messenger.sent.at(-1);
      if (!output?.picker) throw new Error("Expected the native catalogue menu");
      const group = output.picker.groups.findIndex(candidate => candidate.label === model.provider);
      const option = output.picker.groups[group]?.options.indexOf(`${model.provider}/${model.id}`) ?? -1;
      await admit(runtime, pickerClick(output, group, option));
      expect(main.state.model).toEqual(model);
    }
  });

  test("model changes and queries preserve legitimate native model-default effort rather than inventing off", async () => {
    const { runtime, main, store, messenger } = fixture();
    main.state.thinkingLevel = undefined;
    main.modelEffort = null;
    await runtime.start();
    await admit(runtime, message("head-default-effort-query", route(), "/effort"));
    await admit(runtime, message("head-default-effort-model", route(), "/model fixture/efficient"));
    expect(store.input("head-default-effort-model")?.state).toBe("done");
    expect(main.state.model).toEqual(otherModel);
    expect(main.state.thinkingLevel).toBeUndefined();
    expect(messenger.sent[0]!.text).toContain("effort: model default");
    expect(messenger.sent[1]!.text).toContain("effort: model default");
    expect(main.prompts).toEqual([]);
  });

  test("only native advertised effort levels and exact chat model identities are accepted", async () => {
    const { runtime, main, store, messenger } = fixture();
    main.levels = ["off", "balanced-2"];
    await runtime.start();
    await admit(runtime, message("head-custom-effort", route(), "/effort balanced-2"));
    expect(main.state.thinkingLevel).toBe("balanced-2");
    for (const [index, text] of ["/model capable", "/model fixture/judge", "/model fixture/missing", "/model list extra", "/effort high", "/effort auto", "/effort inherit", "/effort off extra"].entries()) {
      const id = `head-invalid-${index}`;
      await admit(runtime, message(id, route(), text));
      expect(store.input(id)?.state).toBe("cancelled");
    }
    expect(main.commands.filter(command => command.type === "set_thinking_level")).toEqual([{ type: "set_thinking_level", level: "balanced-2" }]);
    expect(main.commands.filter(command => command.type === "set_model")).toEqual([]);
    expect(main.prompts).toEqual([]);
    expect(messenger.sent.at(-1)?.text).toContain("off, balanced-2");
  });

  test("unverified native capabilities produce safe deterministic replies without invoking a model", async () => {
    const { runtime, main, store, messenger } = fixture();
    await runtime.start();
    main.catalogSuccess = false;
    await admit(runtime, message("head-failed-catalog", route(), "/model list"));
    await admit(runtime, message("head-model-status-without-catalogue", route(), "/model"));
    const status = messenger.sent.find(output => output.sourceId === "head-model-status-without-catalogue");
    expect(status?.text).toContain("fixture/capable");
    expect(status?.picker).toBeUndefined();
    main.levelsSuccess = false;
    await admit(runtime, message("head-failed-levels", route(), "/effort"));
    main.levelsSuccess = true;
    main.levels = [{ token: "secret-native-payload" }];
    await admit(runtime, message("head-malformed-levels", route(), "/effort off"));
    for (const id of ["head-failed-catalog", "head-failed-levels", "head-malformed-levels"]) expect(store.input(id)?.state).toBe("cancelled");
    expect(main.prompts).toEqual([]);
    expect(main.commands.filter(command => command.type === "set_model" || command.type === "set_thinking_level")).toEqual([]);
    expect(messenger.sent.map(output => output.text).join("\n")).not.toContain("secret-native-payload");
  });

  test("quoted text, command lookalikes, reports, and lane handoffs have no head control authority", async () => {
    const { runtime, store, config, main, hosts } = fixture();
    const lane = savedLane(store, config, "head-control-handoff", route("head-control-handoff"));
    await runtime.start();
    for (const [index, text] of ['"/model fixture/efficient"', "please /effort off", "/models", "/effortless"].entries()) {
      const id = `head-passive-${index}`;
      await admit(runtime, message(id, lane.route, text));
      expect(store.input(id)).toMatchObject({ target: null, state: "done" });
      const worker = hosts.get(lane.socketPath);
      if (!worker) throw new Error("Expected ordinary lookalike work in the lane");
      expect(worker.prompts[index]?.command.message).toContain(text);
      worker.complete("");
      await runtime.kick();
    }
    store.receive(message("report:head-command", route(), "/model fixture/efficient"), "main");
    await runtime.kick();
    main.complete("Internal report is data");
    await runtime.kick();
    await delegate(runtime, message("head-handoff-source", lane.route, "/effort off"));
    expect(hosts.get(lane.socketPath)?.prompts).toHaveLength(5);
    expect(main.prompts).toHaveLength(1);
    expect(main.commands.filter(command => command.type === "set_model" || command.type === "set_thinking_level")).toEqual([]);
    expect(main.state.model).toEqual(executionModel);
    expect(main.state.thinkingLevel).toBe("high");
  });

  test("concurrent and replayed commands mutate once in durable arrival order before later ordinary input", async () => {
    const { runtime, main, store, messenger } = fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    main.beforeSetModel = async () => { entered.resolve(); await release.promise; };
    await runtime.start();
    const first = message("head-concurrent-model", route(), "/model fixture/efficient");
    await runtime.receive(first);
    await entered.promise;
    await runtime.receive(first);
    await runtime.receive(message("head-concurrent-effort", route(), "/effort minimal"));
    await runtime.receive(headMessage("head-concurrent-ordinary"));
    release.resolve();
    await runtime.kick();
    expect(main.commands.filter(command => command.type === "set_model" || command.type === "set_thinking_level" || command.type === "prompt").map(command => command.type)).toEqual(["set_model", "set_thinking_level", "prompt"]);
    expect(store.input(first.id)?.state).toBe("done");
    expect(store.input("head-concurrent-effort")?.state).toBe("done");
    expect(main.prompts).toHaveLength(1);
    expect(main.state.thinkingLevel).toBe("minimal");
    expect(messenger.sent).toHaveLength(2);
    await admit(runtime, first);
    expect(main.commands.filter(command => command.type === "set_model")).toHaveLength(1);
  });

  test("mutations refuse active main input while read-only diagnostics remain available", async () => {
    const { runtime, main, store } = fixture();
    await runtime.start();
    await admit(runtime, headMessage("head-active-original"));
    for (const [index, text] of ["/model fixture/efficient", "/effort off"].entries()) {
      await admit(runtime, message(`head-busy-input-${index}`, route(), text));
      expect(store.input(`head-busy-input-${index}`)?.state).toBe("cancelled");
    }
    await admit(runtime, message("head-busy-diagnostic", route(), "/model"));
    expect(store.input("head-busy-diagnostic")?.state).toBe("done");
    expect(main.commands.filter(command => command.type === "set_model" || command.type === "set_thinking_level")).toEqual([]);
    expect(main.prompts).toHaveLength(1);
  });

  test("mutations refuse every native busy ownership state and unsafe settings scope", async () => {
    const cases: Partial<RuntimeState>[] = [
      { isSettled: false }, { isStreaming: true }, { hasPendingAsyncWork: true }, { hasOwnedRunningWork: true },
      { pendingUiRequests: [{ id: "busy-native-ui", method: "unknown" }] }, { goal: { enabled: true } },
      { isCompacting: true }, { queuedMessageCount: 1 }, { settingsScope: "persistent" }, { settingsScope: undefined },
    ];
    for (const [index, state] of cases.entries()) {
      const { runtime, main, store } = fixture();
      await runtime.start();
      Object.assign(main.state, state);
      await admit(runtime, message(`head-unsafe-${index}`, route(), index % 2 ? "/effort off" : "/model fixture/efficient"));
      expect(store.input(`head-unsafe-${index}`)?.state).toBe("cancelled");
      expect(main.commands.filter(command => command.type === "set_model" || command.type === "set_thinking_level")).toEqual([]);
      expect(main.prompts).toEqual([]);
    }
  });

  test("durable approvals and earlier held or uncertain main inputs cannot be bypassed", async () => {
    for (const hold of ["approval", "pending", "uncertain"] as const) {
      const { runtime, main, store } = fixture();
      await runtime.start();
      if (hold === "approval") store.putApproval({ id: "head-approval-hold", target: "main", generation: 0, requestId: "head-ui", route: route(), request: { method: "confirm" }, state: "pending", remoteId: null });
      else {
        store.receive(message("head-earlier-held"), "main");
        if (hold === "uncertain") {
          store.submit("head-earlier-held", "head-held-receipt", 0);
          store.settle("head-earlier-held", "uncertain");
        } else main.state.pendingUiRequests = [{ id: "hold-ordinary", method: "unknown" }];
      }
      await admit(runtime, message(`head-held-${hold}`, route(), "/model fixture/efficient"));
      expect(store.input(`head-held-${hold}`)?.state).toBe("cancelled");
      await admit(runtime, message(`head-held-query-${hold}`, route(), "/effort"));
      expect(store.input(`head-held-query-${hold}`)?.state).toBe("done");
      expect(main.commands.filter(command => command.type === "set_model")).toEqual([]);
      expect(main.prompts).toEqual([]);
    }
  });

  test("ownership and isolation are rechecked after capability reads before native mutation", async () => {
    for (const changed of [{ hasPendingAsyncWork: true }, { settingsScope: "persistent" as const }]) {
      const { runtime, main, store } = fixture();
      await runtime.start();
      main.beforeCatalog = () => { Object.assign(main.state, changed); };
      await admit(runtime, message("head-capability-race", route(), "/model fixture/efficient"));
      expect(store.input("head-capability-race")?.state).toBe("cancelled");
      expect(main.commands.filter(command => command.type === "set_model")).toEqual([]);
    }
  });

  test("effort mutation refuses a model change during capability discovery", async () => {
    const { runtime, main, store } = fixture();
    await runtime.start();
    main.beforeLevels = () => { main.state.model = { ...otherModel }; };
    await admit(runtime, message("head-effort-model-race", route(), "/effort minimal"));
    expect(store.input("head-effort-model-race")?.state).toBe("cancelled");
    expect(main.commands.filter(command => command.type === "set_thinking_level")).toEqual([]);
    expect(main.prompts).toEqual([]);
  });

  test("lost acknowledgement, raw failure, and mismatched readback fence later work without mutation replay", async () => {
    for (const result of ["throw-before", "throw-after", "mismatch", "rejected"] as const) {
      const { runtime, main, store, messenger } = fixture();
      main.modelSetResult = result;
      await runtime.start();
      const original = message(`head-ambiguous-${result}`, route(), "/model fixture/efficient");
      await admit(runtime, original);
      expect(store.input(original.id)?.state).toBe("uncertain");
      await admit(runtime, original);
      await admit(runtime, headMessage(`head-fenced-${result}`));
      await admit(runtime, message(`head-fenced-mutation-${result}`, route(), "/effort off"));
      await admit(runtime, message(`head-diagnostic-${result}`, route(), "/model"));
      expect(store.input(`head-fenced-${result}`)?.state).toBe("pending");
      expect(store.input(`head-fenced-mutation-${result}`)?.state).toBe("cancelled");
      expect(store.input(`head-diagnostic-${result}`)?.state).toBe("done");
      expect(main.commands.filter(command => command.type === "set_model")).toHaveLength(1);
      expect(main.commands.filter(command => command.type === "set_thinking_level")).toEqual([]);
      expect(main.prompts).toEqual([]);
      const replies = messenger.sent.map(output => output.text).join("\n");
      expect(replies).toContain("uncertain");
      expect(replies).not.toContain("secret");
      expect(replies).not.toContain("endpoint/token");
    }
  });

  test("effort acknowledgement loss and identity drift remain uncertain with safe diagnostics and no replay", async () => {
    for (const result of ["throw-after", "model-mismatch", "missing-effort", "rejected"] as const) {
      const { runtime, main, store, messenger } = fixture();
      main.effortSetResult = result;
      await runtime.start();
      const original = message(`head-effort-ambiguous-${result}`, route(), "/effort minimal");
      await admit(runtime, original);
      await admit(runtime, original);
      await admit(runtime, message(`head-effort-diagnostic-${result}`, route(), "/effort"));
      expect(store.input(original.id)?.state).toBe("uncertain");
      expect(store.input(`head-effort-diagnostic-${result}`)?.state).toBe("done");
      expect(main.commands.filter(command => command.type === "set_thinking_level")).toHaveLength(1);
      expect(messenger.sent.map(output => output.text).join("\n")).not.toContain("secret");
    }
  });

  test("session or settings scope changes during mutation cannot produce a verified success", async () => {
    for (const identity of ["session", "scope"] as const) {
      const { runtime, main, store } = fixture();
      await runtime.start();
      main.beforeSetModel = () => {
        if (identity === "session") main.state.sessionId = "replaced-head-session";
        else main.state.settingsScope = "persistent";
      };
      const original = message(`head-identity-${identity}`, route(), "/model fixture/efficient");
      await admit(runtime, original);
      await admit(runtime, original);
      expect(store.input(original.id)?.state).toBe("uncertain");
      expect(main.commands.filter(command => command.type === "set_model")).toHaveLength(1);
      expect(main.prompts).toEqual([]);
    }
  });

  test("a persisted submitted control recovers as uncertain and is never automatically replayed", async () => {
    const { runtime, store, main } = fixture();
    const original = message("head-crashed-control", route(), "/model fixture/efficient");
    store.receive(original, "main", { [`user-source:${original.id}`]: "true" });
    store.submit(original.id, "persisted-head-control-intent", 0);
    await runtime.start();
    await admit(runtime, original);
    await admit(runtime, message("head-crashed-diagnostic", route(), "/model"));
    await admit(runtime, headMessage("head-crashed-later-work"));
    expect(store.input(original.id)?.state).toBe("uncertain");
    expect(store.input("head-crashed-diagnostic")?.state).toBe("done");
    expect(store.input("head-crashed-later-work")?.state).toBe("pending");
    expect(main.commands.filter(command => command.type === "set_model")).toEqual([]);
    expect(main.prompts).toEqual([]);
  });

  test("an uncertain HEAD input holds later work until /resolve names it, and resolving never replays it", async () => {
    const { runtime, store, main, messenger } = fixture();
    await runtime.start();
    store.receive(message("head-blocking-request"), "main");
    store.submit("head-blocking-request", "head-blocking-receipt", 0);
    store.settle("head-blocking-request", "uncertain");
    await admit(runtime, headMessage("head-blocked-later-work"));
    expect(store.input("head-blocked-later-work")?.state).toBe("pending");
    expect(main.prompts).toEqual([]);
    // The operator must be able to discover the exact held identity from HEAD.
    await admit(runtime, message("head-blocked-status", route(), "/status"));
    expect(messenger.sent.at(-1)!.text).toContain('"head-blocking-request"');
    await runtime.receive(message("head-blocked-resolve", route(), '/resolve head-blocking-request'));
    await main.whenPrompts(1);
    expect(store.input("head-blocked-resolve")?.state).toBe("done");
    expect(store.input("head-blocking-request")?.state).toBe("cancelled");
    // Closure is announced on the original conversation without claiming outcome.
    expect(messenger.sent.some(output => output.sourceId === "head-blocking-request" && /다시 실행되지 않았고/.test(output.text))).toBe(true);
    expect(store.input("head-blocked-later-work")?.state).not.toBe("pending");
    expect(main.prompts).toHaveLength(1);
    expect(String(main.prompts[0]!.command.message)).toContain("Request ID: head-blocked-later-work");
    // The cancelled original is never resubmitted by the resolution itself.
    expect(main.prompts.filter(prompt => String(prompt.command.message).includes("head-blocking-request"))).toEqual([]);
  });

  test.each(["idle", "busy", "unknown"] as const)("resolve releases a lost prompt admission only after native settlement: %s", async state => {
    const { runtime, store, main } = fixture();
    await runtime.start();
    main.beforePrompt = () => {
      if (state === "busy") {
        main.state.isSettled = false;
        main.state.isStreaming = true;
        main.emit({ type: "agent_start" });
      }
      throw new Error("lost native admission response");
    };
    await admit(runtime, headMessage("lost-native-request"));
    main.beforePrompt = undefined;
    expect(store.input("lost-native-request")?.state).toBe("uncertain");
    await admit(runtime, headMessage("after-lost-native-request"));
    if (state === "unknown") main.beforeState = () => { throw new Error("native state unavailable"); };
    await admit(runtime, message("resolve-lost-native-request", route(), "/resolve"));
    expect(store.input("lost-native-request")?.state).toBe("cancelled");
    if (state !== "idle") {
      expect(main.prompts).toHaveLength(1);
      expect(store.input("after-lost-native-request")?.state).toBe("pending");
      main.beforeState = undefined;
      main.state.isSettled = true;
      main.state.isStreaming = false;
      main.emit({ type: "session_settled" });
    }
    await main.whenPrompts(2);
    expect(main.prompts[1]!.command.message).toContain("Request ID: after-lost-native-request");
    main.emit({ type: "prompt_result", id: main.prompts[0]!.id, status: "completed", agentInvoked: true });
    expect(store.input("lost-native-request")?.state).toBe("cancelled");
    expect(store.input("after-lost-native-request")?.state).toBe("submitted");
  });

  test("resolving a failed steering admission does not strand or cancel its running owner", async () => {
    const { runtime, store, main } = fixture();
    await runtime.start();
    await admit(runtime, headMessage("steering-owner"));
    main.beforePrompt = () => { throw new Error("lost steering response"); };
    await admit(runtime, headMessage("lost-steering"));
    main.beforePrompt = undefined;
    expect(store.input("lost-steering")?.state).toBe("uncertain");
    await admit(runtime, message("resolve-steering", route(), "/resolve lost-steering"));
    expect(store.input("steering-owner")?.state).toBe("submitted");
    main.complete("Owner finished", 0);
    await admit(runtime, headMessage("after-steering", route("another-thread")));
    await main.whenPrompts(3);
    expect(store.input("steering-owner")?.state).toBe("done");
    expect(store.input("lost-steering")?.state).toBe("cancelled");
  });

  test.each([false, true])("a recovered bare resolve keeps its original target after cancellation=%s", async cancelled => {
    const { runtime, store, main } = fixture();
    store.receive(message("original-held"), "main");
    store.submit("original-held", "original-receipt", 0);
    store.settle("original-held", "uncertain");
    store.receive(message("another-submitted"), "main");
    store.submit("another-submitted", "another-receipt", 0);
    const control = message("interrupted-resolve", route(), "/resolve");
    store.receive(control, "main", { [`user-source:${control.id}`]: "true" });
    store.setMeta(`head:resolve-target:${control.id}`, "original-held");
    if (cancelled) store.settle("original-held", "cancelled", {
      id: "original-held:resolved", text: "Previously closed by the owner.",
    });
    const settle = store.settle.bind(store);
    store.settle = (id, state, output) => {
      if (id === "original-held" && state === "cancelled") {
        expect(store.getMeta(`head:resolve-target:${control.id}`)).toBe(id);
      }
      return settle(id, state, output);
    };
    await runtime.start();
    await runtime.kick();
    expect(store.input("original-held")?.state).toBe("cancelled");
    expect(store.input("another-submitted")?.state).toBe("uncertain");
    expect(store.input(control.id)?.state).toBe("done");
    await admit(runtime, control);
    expect(store.input("another-submitted")?.state).toBe("uncertain");
    expect(main.prompts).toEqual([]);
  });

  test("ambiguous, unknown, and empty /resolve requests change nothing", async () => {
    const { runtime, store, main } = fixture();
    await runtime.start();
    // Nothing held: an empty resolve is refused rather than cancelling anything.
    await admit(runtime, message("head-resolve-empty", route(), "/resolve"));
    expect(store.input("head-resolve-empty")?.state).toBe("cancelled");
    for (const id of ["head-resolve-first", "head-resolve-second"]) {
      store.receive(message(id), "main");
      store.submit(id, `${id}-receipt`, 0);
      store.settle(id, "uncertain");
    }
    // A bare /resolve with two held uncertainties must not choose for the operator.
    await admit(runtime, message("head-resolve-ambiguous", route(), "/resolve"));
    expect(store.input("head-resolve-ambiguous")?.state).toBe("cancelled");
    expect(store.input("head-resolve-first")?.state).toBe("uncertain");
    expect(store.input("head-resolve-second")?.state).toBe("uncertain");
    // An unknown identity never cancels a held one.
    await admit(runtime, message("head-resolve-unknown", route(), "/resolve head-resolve-missing"));
    expect(store.input("head-resolve-unknown")?.state).toBe("cancelled");
    expect(store.input("head-resolve-first")?.state).toBe("uncertain");
    expect(store.input("head-resolve-second")?.state).toBe("uncertain");
    await admit(runtime, message("head-resolve-exact", route(), "/resolve head-resolve-second"));
    expect(store.input("head-resolve-second")?.state).toBe("cancelled");
    expect(store.input("head-resolve-first")?.state).toBe("uncertain");
    expect(main.prompts).toEqual([]);
  });
});

describe("priority native head commands", () => {
  test("usage shows each provider account's remaining quota and resets only in the requesting thread", async () => {
    const { runtime, config, main, store, messenger, directory } = fixture(3, undefined, { readOmpUsage });
    const executable = join(directory, "omp-usage-fixture");
    config.command = [executable, "--profile", "work", "--model", "fixture/capable"];
    // Opposite ends of the same local day can fall on different UTC dates.
    const generatedAt = new Date(2027, 0, 9, 0, 5).getTime();
    const report = {
      provider: "openai-codex", fetchedAt: 1, metadata: { email: "private@example.test" }, raw: { token: "private-token" },
      limits: [{
        id: "weekly", label: "All models", scope: { provider: "openai-codex", accountId: "private-account-id" },
        amount: { unit: "percent", remainingFraction: 0.625 },
        window: { id: "7d", label: "7 Day", resetsAt: new Date(2027, 0, 9, 23, 34).getTime() },
      }, {
        id: "credits", label: "Credits", scope: { provider: "openai-codex" },
        amount: { unit: "credits", used: 1500, limit: 1500 }, status: "exhausted",
      }],
    };
    const snapshot = {
      generatedAt,
      reports: [report, {
        provider: "openai-codex", fetchedAt: 2, metadata: { email: "private-other@example.test" },
        limits: [{
          id: "five-hour", label: "5 Hour", scope: { provider: "openai-codex" },
          amount: { unit: "percent", usedFraction: 0.09 },
          window: { id: "5h", label: "5 Hour", resetsAt: new Date(2027, 0, 10, 20, 15).getTime() },
        }],
      }, {
        provider: "anthropic", fetchedAt: 3,
        limits: [{
          id: "sonnet", label: "Claude 7 Day (Sonnet)", scope: { provider: "anthropic" },
          amount: { unit: "percent", remaining: 7 },
          window: { id: "7d", label: "7 Day" },
        }],
      }],
      accountsWithoutUsage: [{ provider: "openai-codex", email: "private-unreported@example.test" }],
      disabledCredentials: [{ provider: "openai-codex", email: "private-disabled@example.test" }],
    };
    writeFileSync(executable, `#!/bin/sh
[ "$*" = "--profile=work usage --json --redact --no-extensions" ] || exit 2
cat <<'EOF'
${JSON.stringify(snapshot)}
EOF
`, { mode: 0o700 });
    await runtime.start();
    await admit(runtime, headMessage("usage-active", route("11")));
    const input = applicationCommand("1750000000000000001", route("12"), "/usage");
    await admit(runtime, input);
    expect(store.input(input.id)?.state).toBe("done");
    const output = messenger.sent.find(output => output.sourceId === input.id);
    expect(output?.route).toEqual(input.route);
    expect(output?.text).toContain(`OMP 사용량 · ${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
    expect(output?.text).toContain("Codex · 계정 1\n• 주간 (All models)  62.5% 남음 · 오늘 23:34 초기화");
    expect(output?.text).toContain("0% 남음 · 0 credits 남음 · 한도 도달");
    expect(output?.text).toMatch(/Codex · 계정 2\n• 5시간  91% 남음 · [^\n]*10[^\n]* 20:15 초기화/);
    expect(output?.text).toContain("Codex · 계정 3\n• 남은 한도 미확인");
    expect(output?.text).toContain("Codex · 계정 4\n• 계정 비활성화됨");
    expect(output?.text).toContain("Claude\n• 주간 (Sonnet)  7% 남음");
    expect(output?.text).not.toContain("private");
    expect(main.prompts).toHaveLength(1);
  });

  test.each([0, 1])("usage reports failure without exposing stdout or stderr (CLI exit %i)", async code => {
    const { runtime, config, main, store, messenger, directory } = fixture(3, undefined, { readOmpUsage });
    const executable = join(directory, "omp-usage-failure");
    config.command = [executable];
    writeFileSync(executable, `#!/bin/sh
echo 'private-stdout'
echo 'private-stderr' >&2
exit ${code}
`, { mode: 0o700 });
    await runtime.start();
    const input = message("usage-failed", route(), "/usage");
    await admit(runtime, input);
    expect(store.input(input.id)?.state).toBe("cancelled");
    const output = messenger.sent.find(output => output.sourceId === input.id);
    expect(output?.text).toContain("OMP 사용량을 조회할 수 없습니다");
    expect(output?.text).not.toContain("private");
    expect(main.prompts).toEqual([]);
  });

  for (const platform of ["slack", "discord"] as const) {
    test(`busy ${platform} slash diagnostics and mutation refusals never prompt, react, or advance message cursors`, async () => {
      const { runtime, config, main, store, messenger } = fixture();
      if (platform === "slack") config.slack = { botTokenEnv: "TEST_SLACK", appTokenEnv: "TEST_SLACK_APP", ownerId: "UOWNER", teamId: "TTEAM", allowedChannelIds: ["CCHANNEL"] };
      const destination = platform === "slack"
        ? route(null, { platform, accountId: "TTEAM:UBOT", authorityId: "UOWNER", guildId: "TTEAM", channelId: "CCHANNEL" }) : route();
      const current = platform === "slack"
        ? { ...headMessage("slack-active", destination), messageId: "1750000000.000001" }
        : headMessage("1750000000000000000", destination, "Active owner work");
      const command = platform === "slack" ? slackCommand : applicationCommand;
      await runtime.start();
      await admit(runtime, current);
      const activities = structuredClone(messenger.activities);
      for (const [index, text] of ["/status", "/help", "/context", "/usage"].entries()) {
        const input = command(platform === "slack" ? `busy-${text}` : `175000000000000000${index + 1}`, destination, text);
        await admit(runtime, input);
        expect(store.input(input.id)).toMatchObject({ messageId: null, state: "done",
          ...(platform === "slack" ? { invocationId: input.invocationId } : { interactionId: input.interactionId }) });
        const expected = text === "/usage" ? "OMP 사용량" : "HEAD";
        expect(messenger.sent.some(output => output.sourceId === input.id && output.text.includes(expected))).toBe(true);
      }
      for (const [index, text] of ["/model fixture/efficient", "/effort high", "/compact inspect"].entries()) {
        const input = command(platform === "slack" ? `busy-${text}` : `175000000000000001${index + 1}`, destination, text);
        await admit(runtime, input);
        expect(store.input(input.id)?.state).toBe("cancelled");
      }
      expect(main.prompts).toHaveLength(1);
      expect(main.commands.some(command => ["set_model", "set_thinking_level", "compact"].includes(String(command.type)))).toBe(false);
      expect(messenger.activities).toEqual(activities);
      expect(store.getMeta(`cursor:${physicalRouteKey(destination)}`)).toBe(current.messageId);
    });
  }

  test("unbound slash resume responds honestly while idle, busy, and recovering pending admission", async () => {
    const { runtime, main, store, messenger } = fixture();
    const recovered = applicationCommand("1750000000000000100", route(), "/resume");
    store.receive(recovered, "main", { [`user-source:${recovered.id}`]: "true" });
    await runtime.start();
    await runtime.kick();
    expect(store.input(recovered.id)?.state).toBe("done");
    expect(main.prompts).toEqual([]);
    const idle = applicationCommand("1750000000000000101", route(), "/resume");
    await admit(runtime, idle);
    expect(main.prompts).toEqual([]);
    await admit(runtime, headMessage("1750000000000000102"));
    const busy = applicationCommand("1750000000000000103", route(), "/resume");
    await admit(runtime, busy);
    expect(main.prompts).toHaveLength(1);
    for (const command of [recovered, idle, busy]) {
      expect(store.input(command.id)?.state).toBe("done");
      expect(messenger.sent.find(output => output.sourceId === command.id)?.text).toContain("연결된 레인이 없습니다");
    }
  });

  test("busy help status context usage and preset lists are native read-only safe projections", async () => {
    const { runtime, main, store, messenger, config } = fixture();
    const lane = savedLane(store, config, "query-bound", route("query-bound"));
    main.state.pendingUiRequests = [{ id: "native-ui", method: "unknown", prompt: "secret native prompt", token: "secret-token" }];
    await runtime.start();
    main.state.pendingUiRequests = [];
    await admit(runtime, headMessage("query-active", lane.route));
    main.state.pendingUiRequests = [{ id: "native-ui", method: "unknown", prompt: "secret native prompt" }];
    for (const [index, text] of ["/help", "/status", "/context", "/usage", "/model preset", "/model preset list"].entries()) {
      await admit(runtime, message(`priority-query-${index}`, lane.route, text));
      expect(store.input(`priority-query-${index}`)?.state).toBe("done");
    }
    expect(main.prompts).toHaveLength(1);
    const replies = messenger.sent.map(output => output.text).join("\n");
    for (const value of ["!status", "/stop [head|lane-id]", "session-main", "query-bound", "submitted: 1", "321", "200000", "OMP 사용량", "not proof of task completion"]) expect(replies).toContain(value);
    expect(replies).not.toContain("secret");
    expect(main.commands.some(command => ["compact", "set_model", "set_model_preset", "set_thinking_level"].includes(String(command.type)))).toBe(false);
    main.state.contextUsage = undefined;
    await admit(runtime, message("unknown-context", route(), "/context"));
    expect(messenger.sent.at(-1)?.text).toContain("unknown");
  });

  test("head stop cancels only its durable ordinary boundary and drains native work without revival", async () => {
    const { runtime, main, store, messenger } = fixture();
    await runtime.start();
    await admit(runtime, headMessage("stop-current"));
    await runtime.receive(headMessage("stop-queued"));
    store.receive(message("historical-uncertain"), "main");
    store.submit("historical-uncertain", "historical-request", 0);
    store.settle("historical-uncertain", "uncertain");
    main.state.goal = { enabled: true, mode: "active" };
    main.state.queuedMessageCount = 2;
    main.children = [{ id: "original-child" }];
    store.putApproval({ id: "original-approval", target: "main", generation: 0, requestId: "original-ui", route: route(), request: { method: "confirm" }, state: "pending", remoteId: "card" });
    const stop = message("stop-boundary", route(), "/stop head");
    await runtime.receive(stop);
    await runtime.receive(headMessage("stop-later"));
    await runtime.kick();
    expect(store.input("stop-current")?.state).toBe("cancelled");
    expect(store.input("stop-queued")?.state).toBe("cancelled");
    expect(store.input("historical-uncertain")?.state).toBe("uncertain");
    expect(store.input("stop-later")?.state).toBe("pending"); // Historical ambiguity is not erased by stop.
    expect(store.input(stop.id)?.state).toBe("cancelled");
    expect(main.abortCount).toBe(1);
    expect(main.cancelled).toEqual(["original-child"]);
    expect(main.responses).toContainEqual({ id: "original-ui", response: { cancelled: true } });
    expect(main.state.queuedMessageCount).toBe(0);
    expect(main.state.goal).toBeNull();
    main.complete("late answer must not revive stopped input");
    await admit(runtime, stop);
    expect(main.abortCount).toBe(1);
    expect(messenger.sent.map(output => output.text).join("\n")).not.toContain("late answer");
    expect(messenger.sent.map(output => output.text).join("\n")).not.toContain("withdrawn secret");
  });

  test("unbound stop permits later requests while bound and explicit lane stops stay lane-local", async () => {
    const { runtime, main, store, config, hosts } = fixture();
    const lane = savedLane(store, config, "stop-bound", route("stop-bound"));
    const other = savedLane(store, config, "stop-unrelated", route("stop-unrelated"));
    await runtime.start();
    await admit(runtime, headMessage("ordinary-before-stop", route("unbound")));
    await admit(runtime, message("unbound-stop", route("unbound"), "/stop"));
    expect(main.abortCount).toBe(1);
    await admit(runtime, headMessage("ordinary-after-stop", route("unbound")));
    expect(main.prompts).toHaveLength(2);
    expect(store.input("ordinary-after-stop")?.state).toBe("submitted");
    await admit(runtime, message("bare-bound-stop", lane.route, "/stop"));
    expect(store.lane(lane.id)?.workState).toBe("paused");
    expect(main.abortCount).toBe(1);
    await admit(runtime, message("explicit-lane-stop", route("unbound"), `/stop ${other.id}`));
    expect(store.lane(other.id)?.workState).toBe("paused");
    expect(hosts.size).toBe(1);
    for (const [index, text] of ["/stop head extra", "/stop unknown", "/stop lane-foreign", "/status extra", "/context extra", "/usage extra", "/help extra"].entries()) {
      await admit(runtime, message(`invalid-priority-${index}`, route(), text));
      expect(store.input(`invalid-priority-${index}`)?.state).toBe("cancelled");
    }
    expect(main.abortCount).toBe(1);
    expect(main.prompts).toHaveLength(2);
  });

  test("persisted stop cancellation survives startup without replaying stopped work or uncertain controls", async () => {
    const { runtime, main, store } = fixture();
    store.receive(message("restart-stopped-active"), "main");
    store.submit("restart-stopped-active", "original-active-request", 0);
    store.receive(message("restart-stopped-queued"), "main");
    store.receive(message("restart-stop", route(), "/stop head"), "main", { "user-source:restart-stop": "true" });
    store.submit("restart-stop", "original-stop-request", 0);
    store.setMeta("head:stop-boundary", JSON.stringify({ inputId: "restart-stop", cancelledInputIds: ["restart-stopped-active", "restart-stopped-queued"] }));
    await runtime.start();
    expect(store.input("restart-stopped-active")?.state).toBe("cancelled");
    expect(store.input("restart-stopped-queued")?.state).toBe("cancelled");
    expect(store.input("restart-stop")?.state).toBe("uncertain");
    await admit(runtime, headMessage("restart-after-stop"));
    await admit(runtime, message("restart-stop", route(), "/stop head"));
    expect(store.input("restart-after-stop")?.state).toBe("pending");
    expect(main.abortCount).toBe(0);
    expect(main.prompts).toEqual([]);
  });

  test("priority command lookalikes and quoted tokens remain ordinary user data", async () => {
    const { runtime, main, store, config, hosts } = fixture();
    const lane = savedLane(store, config, "priority-lookalikes", route());
    await runtime.start();
    for (const [index, text] of ["/stopper", "/compactness", "/statuses", "/helpful", "/usageful", "/contextual", '"/stop head"'].entries()) {
      const id = `priority-lookalike-${index}`;
      await admit(runtime, message(id, lane.route, text));
      expect(store.input(id)).toMatchObject({ target: null, state: "done" });
      const worker = hosts.get(lane.socketPath);
      if (!worker) throw new Error("Expected ordinary lookalike work in the lane");
      expect(worker.prompts[index]?.command.message).toContain(text);
      worker.complete("");
      await runtime.kick();
    }
    expect(main.prompts).toEqual([]);
    expect(main.abortCount).toBe(0);
    expect(main.commands.some(command => command.type === "compact")).toBe(false);
  });

  test("overlapping stops serialize native cleanup and a failed stop holds later work", async () => {
    const { runtime, main, store } = fixture();
    await runtime.start();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    main.beforeAbort = async () => { entered.resolve(); await release.promise; };
    await runtime.receive(message("overlap-stop-1", route(), "/stop head"));
    await entered.promise;
    await runtime.receive(message("overlap-stop-2", route(), "/stop head"));
    await runtime.receive(headMessage("after-overlap"));
    expect(main.abortCount).toBe(1);
    expect(main.prompts).toEqual([]);
    release.resolve();
    await runtime.kick();
    expect(main.abortCount).toBe(2);
    expect(store.input("after-overlap")?.state).toBe("submitted");
    main.abortFails = true;
    await admit(runtime, message("failed-stop", route(), "/stop head"));
    await admit(runtime, headMessage("after-failed-stop"));
    expect(store.input("failed-stop")?.state).toBe("uncertain");
    expect(store.input("after-failed-stop")?.state).toBe("pending");
  });

  test("stop bypasses an earlier model capability wait and durably cancels that pending change", async () => {
    const { runtime, main, store, messenger } = fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    main.beforeCatalog = async () => { entered.resolve(); await release.promise; };
    await runtime.start();
    const pendingChange = message("stop-pending-model", route(), "/model fixture/efficient");
    await runtime.receive(pendingChange);
    await entered.promise;
    await runtime.receive(message("stop-before-model-effect", route(), "/stop head"));
    await messenger.whenSent(1);
    expect(store.input(pendingChange.id)?.state).toBe("cancelled");
    expect(main.abortCount).toBe(1);
    expect(main.commands.some(command => command.type === "set_model")).toBe(false);
    release.resolve();
    await runtime.kick();
    await admit(runtime, pendingChange);
    expect(main.commands.some(command => command.type === "set_model")).toBe(false);
    expect(main.state.model).toEqual(executionModel);
  });

  test("compaction preserves multiline instructions and reports native completion plus updated context", async () => {
    const { runtime, main, store, messenger } = fixture();
    await runtime.start();
    const instructions = "Keep decisions\n\nand exact constraints";
    main.beforeCompact = () => { expect(store.input("native-compact")?.state).toBe("submitted"); };
    const input = message("native-compact", route(), `/compact ${instructions}`);
    await admit(runtime, input);
    await messenger.whenSent(1);
    expect(store.input(input.id)?.state).toBe("done");
    expect(main.commands.filter(command => command.type === "compact")).toEqual([{ type: "compact", customInstructions: instructions }]);
    expect(messenger.sent[0]?.text).toContain("123");
    expect(messenger.sent[0]?.text).not.toContain("secret native summary");
    await admit(runtime, input);
    expect(main.commands.filter(command => command.type === "compact")).toHaveLength(1);
    expect(main.prompts).toEqual([]);
  });

  test("pending compact allows read-only commands and stop but fences ordinary work and model mutations", async () => {
    const { runtime, main, store, messenger } = fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    main.beforeCompact = async () => { entered.resolve(); await release.promise; };
    main.compactAbort = () => release.resolve();
    await runtime.start();
    await admit(runtime, message("compact-pending", route(), "/compact"));
    await entered.promise;
    for (const [index, text] of ["/status", "/help", "/context", "/usage", "/model fixture/efficient"].entries()) await admit(runtime, message(`during-compact-${index}`, route(), text));
    await runtime.receive(headMessage("compact-ordinary"));
    expect(store.input("during-compact-0")?.state).toBe("done");
    expect(store.input("during-compact-4")?.state).toBe("cancelled");
    expect(main.prompts).toEqual([]);
    await admit(runtime, message("stop-compact", route(), "/stop head"));
    expect(store.input("compact-pending")?.state).toBe("cancelled");
    expect(store.input("compact-ordinary")?.state).toBe("cancelled");
    expect(store.input("stop-compact")?.state).toBe("cancelled");
    expect(messenger.sent.map(output => output.text).join("\n")).not.toContain("compaction completed");
    await admit(runtime, headMessage("after-compact-stop"));
    expect(main.prompts).toHaveLength(1);
  });

  test("compact rejection is definitive while lost acknowledgement fences without replay", async () => {
    for (const result of ["rejected", "throw-after"] as const) {
      const { runtime, main, store, messenger } = fixture();
      main.compactResult = result;
      await runtime.start();
      const original = message(`compact-${result}`, route(), "/compact");
      await admit(runtime, original);
      await messenger.whenSent(1);
      await admit(runtime, original);
      expect(store.input(original.id)?.state).toBe(result === "rejected" ? "cancelled" : "uncertain");
      await admit(runtime, headMessage(`compact-after-${result}`));
      expect(main.prompts).toHaveLength(result === "rejected" ? 1 : 0);
      expect(main.commands.filter(command => command.type === "compact")).toHaveLength(1);
      expect(messenger.sent[0]?.text).not.toContain("secret");
    }
  });

  test("preset selection freezes full native roles session-only and persists only confirmed effective snapshots", async () => {
    const { runtime, main, store, config, nativePresets, launched, persistedPresets, messenger } = fixture();
    const lane = savedLane(store, config, "preset-unmodified", route("preset-unmodified"));
    const beforeLane = structuredClone(lane);
    main.state.modelSettings!.modelRoles.obsolete = "fixture/capable";
    nativePresets.set("exact-custom", { model: otherModel, preset: "exact-custom", snapshot: {
      modelRoles: { default: "fixture/efficient", smol: "fixture/capable", judge: "fixture/efficient", vision: "fixture/capable" }, defaultThinkingLevel: Effort.Low,
    } });
    const originalPresets = structuredClone([...nativePresets]);
    main.beforeSetModel = () => { expect(store.input("head-preset")?.state).toBe("submitted"); };
    await runtime.start();
    const original = message("head-preset", lane.route, "/model preset exact-custom");
    await admit(runtime, original);
    expect(main.state.modelSettings).toEqual(nativePresets.get("exact-custom")!.snapshot);
    expect(JSON.parse(store.getMeta("head:model-settings:session-main")!)).toEqual({ settings: main.state.modelSettings, clearedRoles: ["obsolete"] });
    expect(store.lane(lane.id)).toEqual(beforeLane);
    expect([...nativePresets]).toEqual(originalPresets);
    expect(launched).toEqual([]);
    await admit(runtime, original);
    expect(main.commands.filter(command => command.type === "set_model_preset")).toHaveLength(1);
    expect(persistedPresets).toEqual([]);
    expect(messenger.sent[0]?.text).toContain('Preset "exact-custom"');
    expect(messenger.sent[0]?.text).toContain('previous model: "fixture/capable"; effort: high -> actual model: "fixture/efficient"; effort: low');
    expect(messenger.sent[0]?.text).toContain("session-only (global defaults not saved)");
    expect(messenger.sent[0]?.text).toContain("Existing lanes unchanged");
    for (const [index, text] of ["/model preset unknown", "/model preset exact-custom extra", "/model preset save", "/model preset reset"].entries()) {
      await admit(runtime, message(`bad-preset-${index}`, route(), text));
      expect(store.input(`bad-preset-${index}`)?.state).toBe("cancelled");
    }
    expect(main.prompts).toEqual([]);
  });

  test("global preset selection saves once only after session readback, using exact frozen roles and inherited thinking", async () => {
    for (const argument of ["exact-global --global", "--global exact-global"]) {
      const { runtime, main, store, config, nativePresets, launched, messenger, persistedPresets, presetPersistence } = fixture();
      const lane = savedLane(store, config, "global-preset-unmodified", route("70"));
      const beforeLane = structuredClone(lane);
      nativePresets.set("exact-global", { model: otherModel, preset: "exact-global", snapshot: {
        modelRoles: { default: "fixture/efficient", smol: "fixture/capable", judge: "fixture/efficient", vision: "fixture/capable" },
      } });
      const expected = { ...structuredClone(nativePresets.get("exact-global")!), snapshot: {
        ...structuredClone(nativePresets.get("exact-global")!.snapshot), defaultThinkingLevel: Effort.High,
      } };
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      main.beforeSetModel = () => {
        nativePresets.set("exact-global", { ...structuredClone(nativePresets.get("high")!), preset: "exact-global" });
      };
      presetPersistence.save = async selection => {
        expect(selection).toEqual(expected);
        expect(main.state.model).toEqual(expected.model);
        expect(main.state.modelSettings).toEqual(expected.snapshot);
        expect(JSON.parse(store.getMeta("head:model-settings:session-main")!).settings).toEqual(expected.snapshot);
        expect(store.input("global-preset-once")?.state).toBe("submitted");
        entered.resolve();
        await release.promise;
        return structuredClone(selection.snapshot);
      };
      await runtime.start();
      const destination = route(null, { guildId: null });
      await admit(runtime, message("3001", destination, "/new"));
      const original = { ...message("global-preset-once", destination, `/model preset ${argument}`), messageId: "3002" };
      await runtime.receive(original);
      const originalRoute = store.input(original.id)!.route;
      await entered.promise;
      await runtime.receive(message("3003", destination, "/main"));
      await runtime.receive(original);
      release.resolve();
      await runtime.kick();
      await admit(runtime, original);
      expect(store.input(original.id)?.state).toBe("done");
      expect(persistedPresets).toEqual([expected]);
      expect(main.commands.filter(command => command.type === "set_model_preset")).toEqual([
        { type: "set_model_preset", name: "exact-global", preset: expected.snapshot },
      ]);
      expect(store.lane(lane.id)).toEqual(beforeLane);
      expect(launched).toEqual([]);
      expect(main.prompts).toEqual([]);
      expect(store.input(original.id)?.route).toEqual(originalRoute);
      expect(originalRoute.topicId).toBeTruthy();
      const notifications = messenger.sent.filter(output => output.id === `${original.id}:head-control`);
      expect(notifications).toHaveLength(1);
      expect(notifications[0]?.route).toEqual(originalRoute);
      const notification = notifications[0]!.text;
      expect(notification).toContain('Preset "exact-global"');
      expect(notification).toContain('previous model: "fixture/capable"; effort: high -> actual model: "fixture/efficient"; effort: high');
      expect(notification).toContain("Session applied; global saved (future/default settings)");
      expect(notification).toContain("Existing lanes unchanged");
      expect(notification).not.toContain("HEAD session only");
    }
  });

  test("failed or mismatched global readback reports session applied honestly and never replays the original save", async () => {
    for (const failure of ["throw", "roles", "missing-role", "thinking", "mutated-selection"] as const) {
      const { runtime, main, store, messenger, persistedPresets, presetPersistence, nativePresets } = fixture();
      const applied = structuredClone(nativePresets.get("low")!);
      presetPersistence.save = async selection => {
        expect(main.state.modelSettings).toEqual(applied.snapshot);
        if (failure === "throw") throw new Error("secret provider credentials https://private-endpoint");
        const readback = structuredClone(selection.snapshot);
        if (failure === "roles") readback.modelRoles.judge = "fixture/capable";
        if (failure === "missing-role") delete readback.modelRoles.smol;
        if (failure === "thinking") readback.defaultThinkingLevel = Effort.High;
        if (failure === "mutated-selection") {
          selection.snapshot.modelRoles.judge = "fixture/capable";
          return selection.snapshot;
        }
        return readback;
      };
      await runtime.start();
      const destination = route(null, { guildId: null });
      await admit(runtime, message("3101", destination, "/new"));
      const original = { ...message(`global-preset-failure-${failure}`, destination, "/model preset low --global"), messageId: "3102" };
      await admit(runtime, original);
      const originalRoute = store.input(original.id)!.route;
      await admit(runtime, message("3103", destination, "/main"));
      await admit(runtime, original);
      await admit(runtime, headMessage(`global-preset-held-${failure}`, route("72")));
      await admit(runtime, message(`global-preset-query-${failure}`, route(), "/model"));
      expect(store.input(original.id)).toMatchObject({ state: "uncertain", route: originalRoute });
      expect(originalRoute.topicId).toBeTruthy();
      expect(store.input(`global-preset-held-${failure}`)?.state).toBe("pending");
      expect(store.input(`global-preset-query-${failure}`)?.state).toBe("done");
      expect(persistedPresets).toEqual([applied]);
      expect(main.commands.filter(command => command.type === "set_model_preset")).toHaveLength(1);
      expect(main.state.model).toEqual(applied.model);
      expect(main.state.modelSettings).toEqual(applied.snapshot);
      expect(JSON.parse(store.getMeta("head:model-settings:session-main")!).settings).toEqual(applied.snapshot);
      expect(main.prompts).toEqual([]);
      const notifications = messenger.sent.filter(output => output.id === `${original.id}:head-control`);
      expect(notifications).toHaveLength(1);
      expect(notifications[0]?.route).toEqual(originalRoute);
      const notification = notifications[0]!.text;
      expect(notification).toContain('Preset "low"');
      expect(notification).toContain('previous model: "fixture/capable"; effort: high -> actual model: "fixture/efficient"; effort: low');
      expect(notification).toContain("Session applied; global save unconfirmed/failed");
      expect(notification).toContain("session change remains applied");
      expect(notification).toContain("Existing lanes unchanged");
      expect(notification).not.toContain("no change");
      expect(notification).not.toContain("global saved");
      expect(notification).not.toContain("HEAD session only");
      expect(notification).not.toContain("secret");
      expect(notification).not.toContain("private-endpoint");
    }
  });

  test("global preset query/list, duplicate and unknown flags reject deterministically even while HEAD is busy", async () => {
    const { runtime, main, store, messenger, persistedPresets } = fixture();
    await runtime.start();
    await admit(runtime, headMessage("global-syntax-busy"));
    for (const [index, text] of [
      "/model preset --global", "/model preset list --global", "/model preset --global list",
      "/model preset low --global --global", "/model preset --global low --global",
      "/model preset low --unknown", "/model preset low --global --unknown", "/model preset --unknown",
      "/model preset low -g", "/model preset low --global extra",
    ].entries()) {
      const id = `invalid-global-preset-${index}`;
      await admit(runtime, message(id, route(), text));
      expect(store.input(id)?.state).toBe("cancelled");
      expect(messenger.sent.at(-1)?.text).toContain("Invalid preset syntax");
    }
    expect(main.prompts).toHaveLength(1);
    expect(persistedPresets).toEqual([]);
    expect(main.commands.some(command => command.type === "set_model_preset")).toBe(false);
    await admit(runtime, message("global-preset-help", route(), "/help"));
    const help = messenger.sent.at(-1)!.text;
    expect(help).toContain("/model preset <exact-name> --global");
    expect(help).toContain("future/default settings");
    expect(help).toContain("Existing lanes remain unchanged");
    expect(help).toContain("failed/unconfirmed global save does not undo the session change");
  });

  test("preset lost acknowledgements and incomplete full-role readbacks remain fenced without reaching global persistence", async () => {
    for (const global of [false, true]) for (const result of ["throw-after", "mismatch", "role-readback"] as const) {
      const { runtime, main, store, persistedPresets } = fixture();
      if (result === "role-readback") {
        const readState = main.client.getState;
        main.client.getState = async () => {
          const state = await readState();
          if (main.commands.some(command => command.type === "set_model_preset")) state.modelSettings!.modelRoles.judge = "fixture/capable";
          return state;
        };
      } else main.modelSetResult = result;
      await runtime.start();
      const original = message(`preset-ambiguous-${result}`, route(), `/model preset low${global ? " --global" : ""}`);
      await admit(runtime, original);
      await admit(runtime, original);
      await admit(runtime, headMessage(`preset-later-${result}`));
      expect(store.input(original.id)?.state).toBe("uncertain");
      expect(store.input(`preset-later-${result}`)?.state).toBe("pending");
      expect(store.getMeta("head:model-settings:session-main")).toBeNull();
      expect(main.commands.filter(command => command.type === "set_model_preset")).toHaveLength(1);
      expect(persistedPresets).toEqual([]);
      expect(main.prompts).toEqual([]);
    }
  });
});

describe("trusted workflow activation", () => {
  test("native jevify reaches head and lane without an ULW command and retains source identity and dedupe", async () => {
    const { runtime, store, main, hosts, directory } = fixture();
    main.workflowAvailable = false;
    await runtime.start();
    const task = "jevify classify these independent diffs";
    const original = headMessage("jevify-source", route("jevify-thread"), task);
    await admit(runtime, original);
    expect(main.prompts[0]!.command.message).toStartWith(`${task}\n\n`);
    expect(main.commands.some(command => command.type === "get_available_commands")).toBe(false);
    expect(store.input(original.id)?.workflow).toMatchObject({ name: "jevify", sourceId: original.id, provenance: "user" });
    const workflow = { name: "jevify" as const, reason: "Independent diff classification reduces context load" };
    const start = { ...selection, sourceId: original.id, title: "Bulk triage", kickoff: "I will classify the diffs and inspect flagged evidence.",
      cwd: directory, brief: "Quoted metadata: orchestrate workflowz", workflow };
    const lane = await runtime.startLane(start);
    await runtime.kick();
    const host = hosts.get(lane.socketPath)!;
    const prompt = String(host.prompts[0]!.command.message);
    expect(containsMagicKeyword(prompt, "jevify")).toBe(true);
    expect(containsMagicKeyword(prompt, "orchestrate")).toBe(false);
    expect(containsMagicKeyword(prompt, "workflowz")).toBe(false);
    expect(host.commands.some(command => command.type === "get_available_commands")).toBe(false);
    expect(store.input(`handoff:${original.id}:lane`)?.workflow).toEqual({ ...workflow, sourceId: original.id, provenance: "head" });
    await runtime.startLane(start);
    await admit(runtime, original);
    expect(host.prompts).toHaveLength(1);
    expect(main.prompts).toHaveLength(1);
    await expect(runtime.startLane({ ...start, workflow: undefined })).rejects.toThrow("Workflow identity conflict");
  });

  test("head-selected jevify follow-up waits for the active lane and cannot gain authority from a report", async () => {
    const { runtime, store, main, hosts, directory } = fixture();
    await runtime.start();
    await admit(runtime, headMessage("jevify-initial", route("jevify-followup"), "Inspect this repository"));
    const lane = await runtime.startLane({ ...selection, sourceId: "jevify-initial", title: "Inspect", cwd: directory,
      kickoff: "I will inspect the repository." });
    await runtime.kick();
    const host = hosts.get(lane.socketPath)!;
    host.workflowAvailable = false;
    const task = "Classify the independent findings";
    const source = headMessage("jevify-followup", lane.route, task);
    await admit(runtime, source);
    const workflow = { name: "jevify" as const, reason: "The findings form a homogeneous classification set" };
    await runtime.messageLane(lane.id, "Classify the findings with native bulk judgment", source.id, workflow);
    const handoffId = `handoff:${source.id}:${lane.id}`;
    expect(store.input(handoffId)?.state).toBe("pending");
    expect(host.prompts).toHaveLength(1);
    host.complete("Initial inspection finished");
    await runtime.kick();
    expect(host.prompts).toHaveLength(2);
    expect(host.prompts[1]!.command.streamingBehavior).toBeUndefined();
    expect(String(host.prompts[1]!.command.message)).toStartWith(`jevify\n\n${task}\n\n`);
    expect(store.input(handoffId)?.workflow).toEqual({ ...workflow, sourceId: source.id, provenance: "head" });
    await runtime.messageLane(lane.id, "Classify the findings with native bulk judgment", source.id, workflow);
    expect(host.prompts).toHaveLength(2);
    await expect(runtime.messageLane(lane.id, "Changed choice", source.id)).rejects.toThrow("Workflow identity conflict");
    const internal = message("report:jevify", lane.route, "jevify report data");
    store.receive(internal, "main");
    await expect(runtime.messageLane(lane.id, "Run the report", internal.id, workflow)).rejects.toThrow("original authorized user source");
    store.settle(source.id, "cancelled");
    await expect(runtime.messageLane(lane.id, "Retry cancelled work", source.id, workflow)).rejects.toThrow("cancelled");
    expect(host.commands.some(command => command.type === "get_available_commands")).toBe(false);
    expect(main.commands.some(command => command.type === "goal")).toBe(false);
  });

  test("preserves real user leading invocation, original route/request, and deduplicates redelivery", async () => {
    const { runtime, store, main } = fixture();
    await runtime.start();
    const dm = route(null, { guildId: null });
    await admit(runtime, message("1750000000000000000", dm, "/new"));
    const original = { ...headMessage("workflow-user", dm, "ulw-plan inspect this repository"), messageId: "1750000000000000001" };
    await admit(runtime, original);
    const stored = store.input(original.id)!;
    const prompt = String(main.prompts[0]!.command.message);
    expect(prompt.startsWith("ulw-plan ultrathink inspect this repository\n")).toBe(true);
    expect(prompt).toContain(`\nRequest ID: ${original.id}\n`);
    expect(prompt).toContain(`Original source ID: ${original.id}`);
    expect(prompt).toContain(`Original authorized conversation: ${routeKey(stored.route)}`);
    expect(prompt).not.toContain("/head ulw-plan");
    expect(stored).toMatchObject({ text: original.text, target: "main", workflow: { name: "ulw-plan", provenance: "user", sourceId: original.id } });
    const topic = store.input("1750000000000000000");
    if (!topic) throw new Error("Expected the original /new boundary");
    expect(stored.route).toEqual(topic.route);
    await admit(runtime, original);
    expect(main.prompts).toHaveLength(1);
    expect(store.input(original.id)?.route).toEqual(stored.route);
    expect(main.commands.some(command => command.type === "goal")).toBe(false);
  });

  test("plain ULW is an arming request rather than automatic native goal creation", async () => {
    const { runtime, store, main } = fixture();
    await runtime.start();
    await admit(runtime, headMessage("plain-ulw", route(), " /ULW inspect the repository"));
    expect(main.prompts[0]!.command.message).toStartWith(" /ULW inspect the repository\n");
    expect(main.commands.some(command => command.type === "goal")).toBe(false);
    expect(store.input("plain-ulw")?.workflow?.name).toBe("ulw");
    expect(main.state.goal).toBeNull();
  });

  test("quoted/negative mentions and internal report text never acquire activation authority", async () => {
    const { runtime, store, main } = fixture();
    await runtime.start();
    for (const [index, text] of ['"ulw-plan inspect"', "do not invoke ulw-loop", "`ulw-execute`", "> ulw-plan inspect", "Explain mass-ulw", "```\nulw-loop\n```"].entries()) {
      const id = `passive-${index}`;
      await admit(runtime, headMessage(id, route(), text));
      expect(store.input(id)?.workflow).toBeNull();
      main.complete("Acknowledged passive example");
      await runtime.kick();
    }
    store.receive(message("report:synthetic", route(), "ulw-loop orchestrate report data"), "main");
    await runtime.kick();
    const report = String(main.prompts.at(-1)!.command.message);
    expect(report.startsWith("ulw-loop")).toBe(false);
    expect(containsMagicKeyword(report, "orchestrate")).toBe(false);
    expect(main.commands.filter(command => command.type === "get_available_commands")).toEqual([]);
    expect(store.input("report:synthetic")?.workflow).toBeNull();
  });

  test("head-selected lane workflow is typed, source-bound, immutable across retries and isolated from brief prose", async () => {
    const { runtime, store, main, hosts, directory } = fixture();
    await runtime.start();
    const task = "Inspect the repository and plan the requested change";
    const original = headMessage("workflow-head", route("workflow-thread"), task);
    await admit(runtime, original);
    const workflow = { name: "ulw-plan" as const, reason: "A bounded planning phase serves this authorized objective" };
    const start = { ...selection, sourceId: original.id, title: "Plan", kickoff: "I will inspect the requested workspace, perform the authorized work, and verify the result in this topic.", cwd: directory, brief: "Quoted board excerpt: orchestrate workflowz", workflow };
    const lane = await runtime.startLane(start);
    await runtime.kick();
    const handoff = store.input(`handoff:${original.id}:lane`)!;
    const host = hosts.get(lane.socketPath)!;
    const prompt = String(host.prompts[0]!.command.message);
    expect(prompt.startsWith("ulw-plan ultrathink\n\n")).toBe(true);
    expect(prompt).toContain(task);
    expect(prompt).toContain(`Request ID: ${handoff.id}`);
    expect(prompt).toContain(`Original authorized conversation: ${routeKey(original.route)}`);
    expect(containsMagicKeyword(prompt, "ultrathink")).toBe(true);
    expect(containsMagicKeyword(prompt, "orchestrate")).toBe(false);
    expect(containsMagicKeyword(prompt, "workflowz")).toBe(false);
    expect(handoff.workflow).toEqual({ ...workflow, sourceId: original.id, provenance: "head" });
    expect(store.input(original.id)).toMatchObject({ text: original.text, route: original.route, target: "main", workflow: null });
    expect(await runtime.startLane(start)).toMatchObject({ id: lane.id });
    await expect(runtime.startLane({ ...start, workflow: undefined })).rejects.toThrow("Workflow identity conflict");
    await expect(runtime.startLane({ ...start, workflow: { ...workflow, name: "ulw-loop" } })).rejects.toThrow("Workflow identity conflict");
    expect(host.prompts).toHaveLength(1);
    expect(main.prompts).toHaveLength(1);
  });

  test("copied original invocations do not select a lane workflow without the typed field", async () => {
    const { runtime, store, directory, hosts } = fixture();
    await runtime.start();
    await admit(runtime, headMessage("workflow-no-inherit", route("copy-thread"), "ulw-loop inspect this repository"));
    const lane = await runtime.startLane({ ...selection, sourceId: "workflow-no-inherit", title: "Bounded copy", kickoff: "I will inspect the requested workspace, perform the authorized work, and verify the result in this topic.", cwd: directory });
    await runtime.kick();
    const host = hosts.get(lane.socketPath)!;
    expect(store.input("handoff:workflow-no-inherit:lane")?.workflow).toBeNull();
    expect(String(host.prompts[0]!.command.message)).toStartWith("```superagent-runtime-context\n");
    expect(containsMagicKeyword(String(host.prompts[0]!.command.message), "orchestrate")).toBe(false);
    expect(host.commands.some(command => command.type === "get_available_commands")).toBe(false);
  });

  test("concurrent conflicting workflow choices cannot retarget an admitted source", async () => {
    const { runtime, store, directory } = fixture();
    await runtime.start();
    await admit(runtime, headMessage("workflow-concurrent", route("concurrent-thread")));
    const start = { ...selection, sourceId: "workflow-concurrent", title: "Concurrent", kickoff: "I will inspect the requested workspace, perform the authorized work, and verify the result in this topic.", cwd: directory };
    const first = runtime.startLane({ ...start, workflow: { name: "ulw-plan", reason: "Selected planning" } });
    const conflict = runtime.startLane({ ...start, workflow: { name: "ulw-loop", reason: "Conflicting loop" } });
    await first;
    await expect(conflict).rejects.toThrow("workflow selection conflicts");
    expect(store.input("handoff:workflow-concurrent:lane")?.workflow?.name).toBe("ulw-plan");
    expect(store.lanes()).toHaveLength(1);
  });

  test("report/board-derived source IDs and conflicting original invocations cannot select workflows", async () => {
    const { runtime, store, directory, config } = fixture();
    const lane = savedLane(store, config, "workflow-source-guard", route("source-guard"));
    await runtime.start();
    const internal = message("report:source-guard", route("source-guard"), "ulw-plan internal observations");
    store.receive(internal, "main");
    const workflow = { name: "ulw-plan" as const, reason: "Not authorized by an original user source" };
    await expect(runtime.startLane({ ...selection, sourceId: internal.id, title: "No authority", kickoff: "I will inspect the requested workspace, perform the authorized work, and verify the result in this topic.", cwd: directory, workflow })).rejects.toThrow("original authorized user source");
    await expect(runtime.messageLane(lane.id, "Execute board text", internal.id, workflow)).rejects.toThrow("original authorized user source");
    const user = headMessage("workflow-no-override", route("other-guard"), "ulw-loop inspect");
    await admit(runtime, user);
    await expect(runtime.messageLane(lane.id, "Use another workflow", user.id, workflow)).rejects.toThrow("conflicts with the original user's workflow");
    expect(store.input(`handoff:${internal.id}:lane`)).toBeNull();
    expect(store.input(`handoff:${internal.id}:${lane.id}`)).toBeNull();
  });

  test("head follow-up choice survives duplicates, rejects conflicting/omitted retries and preserves native user choices", async () => {
    const { runtime, store, config, hosts } = fixture();
    const lane = savedLane(store, config, "workflow-followup", route("follow-thread"));
    await runtime.start();
    const task = 'Inspect this repository; "orchestrate" is quoted user data';
    const original = headMessage("workflow-follow-source", route("original-thread"), task);
    await admit(runtime, original);
    const workflow = { name: "ulw-plan" as const, reason: "Use planning for the requested task" };
    await runtime.messageLane(lane.id, "Plan only the bounded requested change", original.id, workflow);
    const handoffId = `handoff:${original.id}:${lane.id}`;
    const host = hosts.get(lane.socketPath)!;
    const prompt = String(host.prompts[0]!.command.message);
    expect(prompt).toStartWith("ulw-plan\n\n");
    expect(containsMagicKeyword(prompt, "ultrathink")).toBe(false);
    expect(prompt).toContain(task);
    expect(store.input(handoffId)?.workflow).toEqual({ ...workflow, sourceId: original.id, provenance: "head" });
    await runtime.messageLane(lane.id, "Plan only the bounded requested change", original.id, workflow);
    await expect(runtime.messageLane(lane.id, "Plan only the bounded requested change", original.id)).rejects.toThrow("Workflow identity conflict");
    await expect(runtime.messageLane(lane.id, "Plan only the bounded requested change", original.id, { ...workflow, name: "ulw-execute" })).rejects.toThrow("Workflow identity conflict");
    expect(host.prompts).toHaveLength(1);
    expect(store.input(original.id)?.text).toBe(original.text);
  });

  test("unavailable ULW capability cancels explicitly without plain execution or a false activation claim", async () => {
    const { runtime, store, main, messenger } = fixture();
    main.workflowAvailable = false;
    await runtime.start();
    await admit(runtime, headMessage("workflow-missing", route(), "ulw inspect this"));
    expect(main.prompts).toEqual([]);
    expect(store.input("workflow-missing")?.state).toBe("cancelled");
    expect(messenger.sent[0]?.text).toContain("확인할 수 없어 실행하지 않았습니다");
    expect(main.commands.some(command => command.type === "goal")).toBe(false);
  });

  test("cancelled source cannot activate selected handoffs, including cancellation while reading capability", async () => {
    const { runtime, store, directory, hosts } = fixture();
    await runtime.start();
    const original = headMessage("workflow-cancelled", route("cancel-thread"));
    await admit(runtime, original);
    const workflow = { name: "ulw-plan" as const, reason: "Bounded planning" };
    const lane = await runtime.startLane({ ...selection, sourceId: original.id, title: "Cancelled source", kickoff: "I will inspect the requested workspace, perform the authorized work, and verify the result in this topic.", cwd: directory, workflow });
    const host = hosts.get(lane.socketPath);
    if (host) {
      host.complete("First source result");
      await runtime.kick();
    }
    store.settle(original.id, "cancelled");
    await expect(runtime.messageLane(lane.id, "Do not run", original.id, workflow)).rejects.toThrow("cancelled");
    await expect(runtime.startLane({ ...selection, sourceId: original.id, title: "No retry", kickoff: "I will inspect the requested workspace, perform the authorized work, and verify the result in this topic.", cwd: directory, workflow })).rejects.toThrow("cancelled");

    const other = fixture();
    await other.runtime.start();
    other.main.beforeCapabilities = () => { other.store.settle("workflow-cancel-race", "cancelled"); };
    await admit(other.runtime, headMessage("workflow-cancel-race", route(), "ulw inspect"));
    expect(other.main.prompts).toEqual([]);
    expect(other.store.input("workflow-cancel-race")?.state).toBe("cancelled");
  });
});

describe("explicit lane-local model changes", () => {
  test("an unloaded explicit change commits a snapshot and receipt without launching or changing the main default", async () => {
    const { runtime, store, config, launched, main } = fixture();
    const lane = savedLane(store, config, "switch-unloaded", route("40"));
    config.model = "global/preserved-default";
    await runtime.start();
    const sourceId = modelChangeSource(store, "change-unloaded");
    const result = await runtime.changeModel({ id: lane.id, sourceId, model: otherModel, modelReason: "Operator explicitly selected an efficient model for the remaining work." });
    expect(result).toMatchObject({ model: otherModel, modelPreset: null, modelReason: expect.stringContaining("Operator explicitly") });
    expect(launched).toEqual([]);
    expect(config.model).toBe("global/preserved-default");
    expect(main.state.model).toEqual(executionModel);
    expect(main.commands.some(command => command.type === "set_model")).toBe(false);
    expect(JSON.parse(store.getMeta(`lane-model:${lane.id}:receipt:${sourceId}`)!)).toMatchObject({ sourceId, previous: executionModel, model: otherModel, preset: null });
    expect(store.getMeta(`lane-model:${lane.id}:pending`)).toBe("");
  });

  test("an interrupted unloaded commit retries its durable store-only intent without launching a host", async () => {
    const { runtime, store, config, launched } = fixture();
    const lane = legacyLane(store, config, "switch-unloaded-retry", route("53"));
    await runtime.start();
    const sourceId = modelChangeSource(store, "change-unloaded-retry");
    const commit = store.changeLaneModel.bind(store);
    let fail = true;
    store.changeLaneModel = (...args) => { if (fail) { fail = false; throw new Error("Interrupted local transaction"); } return commit(...args); };
    const change = { id: lane.id, sourceId, model: otherModel, modelReason: "An explicit legacy choice, not default adoption." };
    await expect(runtime.changeModel(change)).rejects.toThrow("Interrupted local transaction");
    expect(JSON.parse(store.getMeta(`lane-model:${lane.id}:pending`)!)).toMatchObject({ native: false, previous: null, model: otherModel });
    expect(await runtime.changeModel(change)).toMatchObject({ model: otherModel, modelReason: change.modelReason });
    expect(launched).toEqual([]);
  });

  test("a loaded idle switch writes its durable intent before native selection and reads back before committing", async () => {
    const { runtime, store, config, hosts, main } = fixture();
    const lane = savedLane(store, config, "switch-live", route("41"), process.pid);
    const host = new HostTransport(lane.sessionFile, "session-switch-live");
    hosts.set(lane.socketPath, host);
    await runtime.start();
    const sourceId = modelChangeSource(store, "change-live");
    host.beforeSetModel = () => {
      expect(JSON.parse(store.getMeta(`lane-model:${lane.id}:pending`)!)).toMatchObject({ sourceId, model: otherModel, previous: executionModel });
      expect(store.lane(lane.id)?.model).toEqual(executionModel);
      expect(store.getMeta(`lane-model:${lane.id}:receipt:${sourceId}`)).toBeNull();
    };
    const result = await runtime.changeModel({ id: lane.id, sourceId, model: otherModel, modelReason: "Explicitly switch this idle lane only." });
    expect(result).toMatchObject({ model: otherModel, state: { model: otherModel }, modelCheck: { expected: otherModel, actual: otherModel, error: null } });
    expect(host.commands.filter(command => command.type === "set_model")).toEqual([{ type: "set_model", provider: otherModel.provider, modelId: otherModel.id }]);
    expect(host.prompts).toEqual([]);
    expect(main.state.model).toEqual(executionModel);
    expect(store.lane(lane.id)?.generation).toBe(0);
  });

  test("completed source replay cannot roll back a newer explicit choice or alter its original reason", async () => {
    const { runtime, store, config } = fixture();
    const lane = savedLane(store, config, "switch-replay", route("42"));
    await runtime.start();
    const first = { id: lane.id, sourceId: modelChangeSource(store, "change-first"), model: otherModel, modelReason: "First explicit choice." };
    await runtime.changeModel(first);
    const second = { id: lane.id, sourceId: modelChangeSource(store, "change-second"), model: executionModel, modelReason: "Second explicit choice." };
    await runtime.changeModel(second);
    expect(await runtime.changeModel(first)).toMatchObject({ model: executionModel, modelReason: second.modelReason });
    await expect(runtime.changeModel({ ...first, modelReason: "Rewrite the first authorization" })).rejects.toThrow("identity conflict");
    expect(store.lane(lane.id)?.modelReason).toBe(second.modelReason);
  });

  test("native busy, async, goal, service and UI states refuse switching without interrupting work", async () => {
    for (const patch of [
      { isSettled: false, isStreaming: true }, { hasPendingAsyncWork: true }, { hasOwnedRunningWork: true },
      { pendingUiRequests: [{ id: "still-owned-dialog", method: "confirm" }] }, { goal: { enabled: true } },
    ]) {
      const { runtime, store, config, hosts } = fixture();
      const lane = savedLane(store, config, "switch-busy", route("43"), process.pid);
      const host = new HostTransport(lane.sessionFile, "session-switch-busy");
      hosts.set(lane.socketPath, host);
      await runtime.start();
      Object.assign(host.state, patch);
      const before = structuredClone(host.state);
      const sourceId = modelChangeSource(store, "change-busy");
      await expect(runtime.changeModel({ id: lane.id, sourceId, model: otherModel, modelReason: "Do not interrupt active work." })).rejects.toThrow("not natively idle");
      expect(host.state).toEqual(before);
      expect(host.commands.some(command => command.type === "set_model" || command.type === "goal")).toBe(false);
      expect(host.cancelled).toEqual([]);
      expect(store.getMeta(`lane-model:${lane.id}:pending`)).toBeNull();
    }
  });

  test("submitted and uncertain lane inputs cannot be bypassed by switching models", async () => {
    for (const uncertain of [false, true]) {
      const { runtime, store, config, hosts } = fixture();
      const lane = savedLane(store, config, "switch-held", route("44"), process.pid);
      const host = new HostTransport(lane.sessionFile, "session-switch-held");
      hosts.set(lane.socketPath, host);
      await runtime.start();
      store.receive(message("held-native-input", lane.route), lane.id);
      store.submit("held-native-input", "unresolved-native-prompt", 0);
      if (uncertain) store.settle("held-native-input", "uncertain");
      await expect(runtime.changeModel({ id: lane.id, sourceId: modelChangeSource(store, "change-held"), model: otherModel, modelReason: "No uncertainty bypass." })).rejects.toThrow("submitted, uncertain");
      expect(host.commands.some(command => command.type === "set_model")).toBe(false);
      expect(store.lane(lane.id)?.model).toEqual(executionModel);
    }
  });

  test("pending unsubmitted work uses the new choice only after the paused lane resumes", async () => {
    const { runtime, store, config, hosts } = fixture();
    const lane = savedLane(store, config, "switch-queued", route("45"), process.pid);
    store.updateLane(lane.id, 0, { workState: "paused" });
    const host = new HostTransport(lane.sessionFile, "session-switch-queued");
    hosts.set(lane.socketPath, host);
    await runtime.start();
    store.receive(message("queued-after-switch", lane.route), lane.id);
    await runtime.changeModel({ id: lane.id, sourceId: modelChangeSource(store, "change-queued"), model: otherModel, modelReason: "Use the new choice for queued work." });
    expect(store.lane(lane.id)?.workState).toBe("paused");
    expect(host.prompts).toEqual([]);
    await runtime.resume(lane.id);
    expect(host.state.model).toEqual(otherModel);
    expect(host.prompts).toHaveLength(1);
    expect(store.input("queued-after-switch")?.state).toBe("submitted");
  });

  test("an ambiguous completed native change reconciles by readback without a second mutation", async () => {
    const { runtime, store, config, hosts } = fixture();
    const lane = savedLane(store, config, "switch-ambiguous", route("46"), process.pid);
    const host = new HostTransport(lane.sessionFile, "session-switch-ambiguous");
    hosts.set(lane.socketPath, host);
    await runtime.start();
    const sourceId = modelChangeSource(store, "change-ambiguous");
    host.modelSetResult = "throw-after";
    const change = { id: lane.id, sourceId, model: otherModel, modelReason: "Explicit switch with a lost acknowledgement." };
    await expect(runtime.changeModel(change)).rejects.toThrow("acknowledgement lost");
    expect(store.lane(lane.id)?.model).toEqual(executionModel);
    expect(host.state.model).toEqual(otherModel);
    expect(store.getMeta(`lane-model:${lane.id}:receipt:${sourceId}`)).toBeNull();
    expect(await runtime.changeModel(change)).toMatchObject({ model: otherModel, modelChange: null });
    expect(host.commands.filter(command => command.type === "set_model")).toHaveLength(1);
  });

  test("an ambiguous unapplied change holds work and only an explicit same-source retry may apply it", async () => {
    const { runtime, store, config, hosts } = fixture();
    const lane = savedLane(store, config, "switch-unapplied", route("47"), process.pid);
    const host = new HostTransport(lane.sessionFile, "session-switch-unapplied");
    hosts.set(lane.socketPath, host);
    await runtime.start();
    const sourceId = modelChangeSource(store, "change-unapplied");
    const change = { id: lane.id, sourceId, model: otherModel, modelReason: "Explicit retry requires the same durable intent." };
    host.modelSetResult = "throw-before";
    await expect(runtime.changeModel(change)).rejects.toThrow("outcome unknown");
    await delegate(runtime, message("work-held-for-model", lane.route));
    expect(host.prompts).toEqual([]);
    expect(host.commands.filter(command => command.type === "set_model")).toHaveLength(1);
    expect(await runtime.inspect(lane.id)).toMatchObject({ model: executionModel, modelChange: { sourceId }, modelCheck: { error: expect.stringContaining("durable intent") } });
    await expect(runtime.changeModel({ ...change, sourceId: modelChangeSource(store, "different-change-source") })).rejects.toThrow("unresolved model change");
    host.modelSetResult = "success";
    await runtime.changeModel(change);
    await runtime.kick();
    expect(host.commands.filter(command => command.type === "set_model")).toHaveLength(2);
    expect(host.prompts).toHaveLength(1);
  });

  test("explicit idle authorization may resolve operator drift, preserving the observed native identity on retry", async () => {
    const { runtime, store, config, hosts } = fixture();
    const lane = savedLane(store, config, "switch-drift", route("54"), process.pid);
    const host = new HostTransport(lane.sessionFile, "session-switch-drift");
    hosts.set(lane.socketPath, host);
    await runtime.start();
    host.state.model = otherModel;
    expect(await runtime.inspect(lane.id)).toMatchObject({ modelCheck: { error: expect.stringContaining("model drift") } });
    const sourceId = modelChangeSource(store, "change-resolve-drift");
    const change = { id: lane.id, sourceId, model: executionModel, modelReason: "Operator explicitly authorizes restoring this idle lane's selected model." };
    host.modelSetResult = "throw-before";
    await expect(runtime.changeModel(change)).rejects.toThrow("outcome unknown");
    expect(JSON.parse(store.getMeta(`lane-model:${lane.id}:pending`)!)).toMatchObject({ previous: executionModel, observed: otherModel, model: executionModel });
    host.modelSetResult = "success";
    expect(await runtime.changeModel(change)).toMatchObject({ model: executionModel, state: { model: executionModel }, modelCheck: { error: null } });
  });

  test("native readback mismatch retains its intent and refuses prompt dispatch", async () => {
    const { runtime, store, config, hosts } = fixture();
    const lane = savedLane(store, config, "switch-mismatch", route("48"), process.pid);
    const host = new HostTransport(lane.sessionFile, "session-switch-mismatch");
    hosts.set(lane.socketPath, host);
    await runtime.start();
    host.modelSetResult = "mismatch";
    const sourceId = modelChangeSource(store, "change-mismatch");
    await expect(runtime.changeModel({ id: lane.id, sourceId, model: otherModel, modelReason: "Must match exact native readback." })).rejects.toThrow("does not match durable");
    await delegate(runtime, message("mismatch-work", lane.route));
    expect(host.prompts).toEqual([]);
    expect(store.lane(lane.id)?.model).toEqual(executionModel);
    expect(store.getMeta(`lane-model:${lane.id}:pending`)).toBeTruthy();
  });

  test("restart reconciles exact native intent, including unloaded transcript restoration without an override", async () => {
    for (const offline of [false, true]) {
      const { runtime, store, config, hosts, directory } = fixture();
      const lane = savedLane(store, config, "switch-restart", route("50"), process.pid);
      const host = new HostTransport(lane.sessionFile, "session-switch-restart");
      hosts.set(lane.socketPath, host);
      await runtime.start();
      const sourceId = modelChangeSource(store, "change-restart");
      host.modelSetResult = "throw-after";
      await expect(runtime.changeModel({ id: lane.id, sourceId, model: otherModel, modelReason: "Reconcile this exact persisted intent after restart." })).rejects.toThrow("acknowledgement lost");
      if (offline) {
        legacyTranscript(lane, otherModel);
        store.updateLane(lane.id, 0, { pid: null, runtimeState: "unloaded" });
      }
      await runtime.stop();
      const reopened = new Store(join(directory, "coordination.sqlite"));
      const messenger = new MessengerTransport();
      const head = new HostTransport(hostPaths(config, "main").sessionFile, "session-main");
      const restored = new HostTransport(lane.sessionFile, "session-switch-restart", otherModel);
      const nativeHosts = new Map([[hostPaths(config, "main").socketPath, head]]);
      if (!offline) nativeHosts.set(lane.socketPath, restored);
      const launched: HostOptions[] = [];
      const restarted = new Superagent(config, reopened, messenger, join(directory, "extension.ts"), () => {}, {
        connect: async path => { const host = nativeHosts.get(path); if (!host) throw new Error("No owned native host"); return host; },
        startHost: async options => { launched.push(options); nativeHosts.set(options.socketPath, restored); return { pid: process.pid }; },
      });
      fixtures.find(entry => entry.runtime === runtime)!.runtime = restarted;
      await restarted.start();
      if (offline) await restarted.resume(lane.id);
      expect(reopened.lane(lane.id)?.model).toEqual(otherModel);
      expect(JSON.parse(reopened.getMeta(`lane-model:${lane.id}:receipt:${sourceId}`)!)).toMatchObject({ sourceId, model: otherModel });
      expect(restored.commands.some(command => command.type === "set_model")).toBe(false);
      expect(restored.prompts).toEqual([]);
      expect(launched).toHaveLength(offline ? 1 : 0);
      if (offline) expect(launched[0]).not.toHaveProperty("model");
    }
  });

  test("a generation race after native selection retains the intent without committing a stale receipt", async () => {
    const { runtime, store, config, hosts } = fixture();
    const lane = savedLane(store, config, "switch-generation", route("51"), process.pid);
    const host = new HostTransport(lane.sessionFile, "session-switch-generation");
    hosts.set(lane.socketPath, host);
    await runtime.start();
    const sourceId = modelChangeSource(store, "change-generation");
    host.beforeSetModel = () => { store.nextGeneration(lane.id); };
    await expect(runtime.changeModel({ id: lane.id, sourceId, model: otherModel, modelReason: "Fence native changes by generation." })).rejects.toThrow("Obsolete host connection");
    expect(store.lane(lane.id)).toMatchObject({ generation: 1, model: executionModel });
    expect(store.getMeta(`lane-model:${lane.id}:receipt:${sourceId}`)).toBeNull();
    expect(store.getMeta(`lane-model:${lane.id}:pending`)).toBeTruthy();
    expect(host.prompts).toEqual([]);
  });

  test("unknown sources and unavailable selections never create switch intents or native effects", async () => {
    const { runtime, store, config, hosts } = fixture();
    const lane = savedLane(store, config, "switch-invalid", route("52"), process.pid);
    const host = new HostTransport(lane.sessionFile, "session-switch-invalid");
    hosts.set(lane.socketPath, host);
    await runtime.start();
    await expect(runtime.changeModel({ id: lane.id, sourceId: "not-received", model: otherModel, modelReason: "Cannot invent source authority." })).rejects.toThrow("received authorized request");
    const sourceId = modelChangeSource(store, "change-invalid");
    await expect(runtime.changeModel({ id: lane.id, sourceId, model: { provider: "fixture", id: "judge" }, modelReason: "No non-chat execution model." })).rejects.toThrow("not an available native chat model");
    expect(store.getMeta(`lane-model:${lane.id}:pending`)).toBeNull();
    expect(host.commands.some(command => command.type === "set_model")).toBe(false);
  });

  test("model changes serialize per lane and fence pending dispatch during native effects", async () => {
    const { runtime, store, config, hosts } = fixture();
    const lane = savedLane(store, config, "switch-serialized", route("49"), process.pid);
    store.updateLane(lane.id, 0, { workState: "paused" });
    const host = new HostTransport(lane.sessionFile, "session-switch-serialized");
    hosts.set(lane.socketPath, host);
    await runtime.start();
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    host.beforeSetModel = async () => { host.beforeSetModel = undefined; entered.resolve(); await finish.promise; };
    const first = runtime.changeModel({ id: lane.id, sourceId: modelChangeSource(store, "serialized-first"), model: otherModel, modelReason: "First serialized change." });
    await entered.promise;
    const second = runtime.changeModel({ id: lane.id, sourceId: modelChangeSource(store, "serialized-second"), model: executionModel, modelReason: "Second serialized change." });
    store.receive(message("serialized-work", lane.route), lane.id);
    await runtime.kick();
    expect(host.prompts).toEqual([]);
    expect(host.commands.filter(command => command.type === "set_model")).toHaveLength(1);
    finish.resolve();
    await Promise.all([first, second]);
    expect(store.lane(lane.id)).toMatchObject({ model: executionModel, modelReason: "Second serialized change." });
    expect(host.commands.filter(command => command.type === "set_model").map(command => command.modelId)).toEqual([otherModel.id, executionModel.id]);
  });

  test("an inspection awaiting catalog I/O cannot quarantine a newly committed same-generation switch", async () => {
    const { runtime, store, config, hosts, main } = fixture();
    const lane = savedLane(store, config, "switch-inspect-race", route("55"), process.pid);
    hosts.set(lane.socketPath, new HostTransport(lane.sessionFile, "session-switch-inspect-race"));
    await runtime.start();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    main.beforeCatalog = async () => { main.beforeCatalog = undefined; entered.resolve(); await release.promise; };
    const inspecting = runtime.inspect(lane.id);
    await entered.promise;
    await runtime.changeModel({ id: lane.id, sourceId: modelChangeSource(store, "change-inspect-race"), model: otherModel, modelReason: "An authorized same-generation switch during readback." });
    release.resolve();
    expect(await inspecting).toMatchObject({ model: otherModel, modelCheck: { expected: otherModel, actual: otherModel, error: null } });
    expect(store.lane(lane.id)?.runtimeState).toBe("idle");
  });
});

describe("authoritative per-lane model selection", () => {
  test("the public catalog preserves native enabled scope and projects only coding metadata", async () => {
    const { runtime, main } = fixture();
    main.models = [
      { ...executionModel, name: "Capable", apiKey: "never-expose", headers: { Authorization: "secret" }, contextWindow: 200_000 },
      { ...otherModel, kind: "chat" }, { provider: "fixture", id: "judge", kind: "judge" },
      { provider: "fixture", id: "tiny", kind: "tiny" },
    ];
    await runtime.start();
    expect(await runtime.availableModels()).toEqual([
      { ...executionModel, name: "Capable", contextWindow: 200_000 }, otherModel,
    ]);
    expect(main.commands.at(-1)).toEqual({ type: "get_available_models" });
  });

  test("two explicit lane selections launch distinct models and persist their reasons", async () => {
    const { runtime, store, directory, launched, hosts, config } = fixture();
    config.model = "global/never-use-for-lanes";
    await runtime.start();
    await admit(runtime, headMessage("2001", route("21")));
    await admit(runtime, headMessage("2002", route("22")));
    const one = await runtime.startLane({ ...selection, sourceId: "2001", title: "Complex", kickoff: "I will inspect the requested workspace, perform the authorized work, and verify the result in this topic.", cwd: directory });
    const reason = "Native judge selected the efficient model for a bounded documentation task.";
    const two = await runtime.startLane({ sourceId: "2002", title: "Bounded", kickoff: "I will inspect the requested workspace, perform the authorized work, and verify the result in this topic.", cwd: directory, model: otherModel, modelReason: reason });
    await runtime.kick();
    expect(launched.map(options => options.model)).toEqual(["fixture/capable", "fixture/efficient"]);
    expect(store.lane(one.id)).toMatchObject(selection);
    expect(store.lane(two.id)).toMatchObject({ model: otherModel, modelReason: reason });
    expect(hosts.get(one.socketPath)?.prompts).toHaveLength(1);
    expect(hosts.get(two.socketPath)?.prompts).toHaveLength(1);
  });

  test("unavailable, non-chat, alias, and empty-reason choices reject before thread or store effects", async () => {
    const { runtime, store, main, directory, messenger, launched } = fixture();
    await runtime.start();
    const source = message("2010", route(null));
    store.receive(source, "main");
    store.submit(source.id, "already-main", 0);
    for (const model of [
      { provider: "fixture", id: "missing" }, { provider: "fixture", id: "judge" },
      { provider: "fixture", id: "cap" }, { provider: "foreign", id: "capable" },
    ]) await expect(runtime.startLane({ ...selection, sourceId: source.id, title: "Invalid", kickoff: "I will inspect the requested workspace, perform the authorized work, and verify the result in this topic.", cwd: directory, model })).rejects.toThrow("not an available native chat model");
    await expect(runtime.startLane({ ...selection, sourceId: source.id, title: "Invalid", kickoff: "I will inspect the requested workspace, perform the authorized work, and verify the result in this topic.", cwd: directory, modelReason: " " })).rejects.toThrow("modelReason");
    main.catalogSuccess = false;
    await expect(runtime.startLane({ ...selection, sourceId: source.id, title: "No native acknowledgement", kickoff: "I will inspect the requested workspace, perform the authorized work, and verify the result in this topic.", cwd: directory })).rejects.toThrow("not acknowledged");
    expect(store.lanes()).toEqual([]);
    expect(store.input(`handoff:${source.id}:lane`)).toBeNull();
    expect(store.getMeta(`handoff-route:${source.id}`)).toBeNull();
    expect(messenger.threads).toEqual([]);
    expect(launched).toEqual([]);
    expect(store.input(source.id)).toMatchObject({ state: "submitted", target: "main" });
  });

  test("same-source model changes reject even during concurrent lane creation", async () => {
    const { runtime, directory, store } = fixture();
    await runtime.start();
    await admit(runtime, headMessage("2020", route("23")));
    const first = runtime.startLane({ ...selection, sourceId: "2020", title: "Original", kickoff: "I will inspect the requested workspace, perform the authorized work, and verify the result in this topic.", cwd: directory });
    const conflict = runtime.startLane({ ...selection, sourceId: "2020", title: "Conflicting", kickoff: "I will inspect the requested workspace, perform the authorized work, and verify the result in this topic.", cwd: directory, model: otherModel });
    const lane = await first;
    await expect(conflict).rejects.toThrow("conflicts");
    await expect(runtime.startLane({ ...selection, sourceId: "2020", title: "Replay conflict", kickoff: "I will inspect the requested workspace, perform the authorized work, and verify the result in this topic.", cwd: directory, model: otherModel })).rejects.toThrow("different model");
    expect(store.lane(lane.id)).toMatchObject(selection);
    expect(store.lanes()).toHaveLength(1);
  });

  test("resolved preset identities are snapshotted before asynchronous lane selection", async () => {
    const { runtime, store, main, directory } = fixture();
    await runtime.start();
    await admit(runtime, headMessage("2025", route("38")));
    const catalogStarted = Promise.withResolvers<void>();
    const releaseCatalog = Promise.withResolvers<void>();
    main.beforeCatalog = async () => {
      main.beforeCatalog = undefined;
      catalogStarted.resolve();
      await releaseCatalog.promise;
    };
    const preset = { ...executionModel };
    const selecting = runtime.startLane({ ...selection, sourceId: "2025", title: "Preset snapshot", kickoff: "I will inspect the requested workspace, perform the authorized work, and verify the result in this topic.", cwd: directory, model: preset });
    await catalogStarted.promise;
    preset.id = otherModel.id;
    releaseCatalog.resolve();
    const lane = await selecting;
    expect(lane.model).toEqual(executionModel);
    expect(store.lane(lane.id)?.model).toEqual(executionModel);
    expect(lane.model).not.toBe(preset);
  });

  test("a changed global default cannot change an unloaded lane's resumed selection", async () => {
    const { runtime, store, config, hosts, launched, messenger, launchBehavior } = fixture();
    launchBehavior.pid = 2147483647; // A terminated native PID in this transport fixture.
    const lane = savedLane(store, config, "resume-choice", route("24"));
    await runtime.start();
    await delegate(runtime, message("2030", lane.route));
    hosts.get(lane.socketPath)!.complete("first execution");
    hosts.get(lane.socketPath)!.shutdownDisconnect = true;
    await runtime.kick();
    expect(messenger.sent).toEqual([]);
    await runtime.kick();
    await runtime.closeLane(lane.id, "completed", "Observed first execution complete");
    expect(store.lane(lane.id)?.runtimeState).toBe("unloaded");
    config.model = "fixture/efficient";
    await runtime.resume(lane.id);
    await delegate(runtime, message("2031", lane.route));
    expect(launched.map(options => options.model)).toEqual(["fixture/capable", undefined]);
    expect(store.lane(lane.id)).toMatchObject({ ...selection, generation: 2 });
  });

  test("native fuzzy resolution mismatch holds without sending a prompt or resetting the model", async () => {
    const { runtime, store, config, launched, hosts, launchBehavior } = fixture();
    const lane = savedLane(store, config, "mismatch", route("25"));
    launchBehavior.model = otherModel;
    await runtime.start();
    await delegate(runtime, message("2040", lane.route));
    const host = hosts.get(lane.socketPath)!;
    expect(launched[0]?.model).toBe("fixture/capable");
    expect(host.prompts).toEqual([]);
    expect(host.commands.some(command => command.type === "set_model")).toBe(false);
    expect(delegated(store, "2040")?.state).toBe("pending");
    expect(store.lane(lane.id)?.runtimeState).toBe("interrupted");
    expect(await runtime.inspect(lane.id)).toMatchObject({ modelCheck: { expected: executionModel, actual: otherModel, error: expect.stringContaining("model drift") } });
    await expect(runtime.resume(lane.id)).rejects.toThrow("model drift");
    expect(host.prompts).toEqual([]);
  });

  test("live operator drift and revoked availability hold followups without model mutation", async () => {
    const { runtime, store, config, hosts, main } = fixture();
    const lane = savedLane(store, config, "live-drift", route("26"), process.pid);
    const host = new HostTransport(lane.sessionFile, "session-live-drift");
    hosts.set(lane.socketPath, host);
    await runtime.start();
    host.state.model = otherModel;
    expect(await runtime.inspect(lane.id)).toMatchObject({ modelCheck: { expected: executionModel, actual: otherModel, error: expect.stringContaining("model drift") } });
    await delegate(runtime, message("2050", lane.route));
    expect(host.prompts).toEqual([]);
    expect(delegated(store, "2050")?.state).toBe("pending");
    host.state.model = executionModel;
    main.models = [otherModel];
    await expect(runtime.resume(lane.id)).rejects.toThrow("not an available native chat model");
    expect(host.prompts).toEqual([]);
    expect(host.commands.some(command => command.type === "set_model")).toBe(false);
  });

  test("model readback after attachment transfer prevents dispatch after an operator change", async () => {
    const transferring = Promise.withResolvers<void>();
    const downloaded = Promise.withResolvers<void>();
    const { runtime, store, config, hosts } = fixture(3, async () => {
      transferring.resolve();
      await downloaded.promise;
      return new Response("data", { headers: { "content-length": "4" } });
    });
    const lane = savedLane(store, config, "download-drift", route("36"), process.pid);
    const host = new HostTransport(lane.sessionFile, "session-download-drift");
    hosts.set(lane.socketPath, host);
    await runtime.start();
    const input = { ...message("2055", lane.route), attachments: [{ id: "file", name: "notes.txt", url: "https://example.test/notes", size: 4 }] };
    const admission = delegate(runtime, input);
    await transferring.promise;
    host.state.model = otherModel;
    downloaded.resolve();
    await admission;
    expect(host.prompts).toEqual([]);
    expect(delegated(store, input.id)?.state).toBe("pending");
    expect(await runtime.inspect(lane.id)).toMatchObject({ modelCheck: { expected: executionModel, actual: otherModel } });
  });

  test("availability is rechecked before unloaded launch and generation changes", async () => {
    const { runtime, store, config, main, launched } = fixture();
    const lane = savedLane(store, config, "revoked", route("27"));
    await runtime.start();
    main.models = [otherModel];
    await delegate(runtime, message("2060", lane.route));
    expect(launched).toEqual([]);
    expect(store.lane(lane.id)).toMatchObject({ generation: 0, model: executionModel, runtimeState: "interrupted" });
    expect(delegated(store, "2060")?.state).toBe("pending");
  });

  test("legacy live ownership adopts native state once, never the global default", async () => {
    const { runtime, store, config, hosts, launched } = fixture();
    const lane = legacyLane(store, config, "legacy-live", route("28"), process.pid);
    const host = new HostTransport(lane.sessionFile, "session-legacy-live", otherModel);
    hosts.set(lane.socketPath, host);
    config.model = "global/unrelated";
    await runtime.start();
    const adopted = store.lane(lane.id)!;
    expect(adopted.model).toEqual(otherModel);
    expect(adopted.modelReason).toContain("Legacy adoption: authoritative native session");
    expect(adopted.modelReason).toContain("not judge-selected");
    await delegate(runtime, message("2070", lane.route));
    expect(host.prompts).toHaveLength(1);
    host.complete("legacy live response");
    await runtime.kick();
    host.state.model = executionModel;
    await expect(runtime.resume(lane.id)).rejects.toThrow("model drift");
    expect(store.lane(lane.id)?.model).toEqual(otherModel);
    expect(store.lane(lane.id)?.modelReason).toBe(adopted.modelReason);
    expect(launched).toEqual([]);
  });

  test("legacy offline transcript restores natively without a model override before one-time adoption", async () => {
    const { runtime, store, config, launched, hosts, launchBehavior } = fixture();
    const lane = legacyLane(store, config, "legacy-offline", route("29"));
    legacyTranscript(lane, otherModel);
    config.model = "global/unrelated";
    launchBehavior.model = otherModel;
    await runtime.start();
    expect(store.lane(lane.id)?.model).toBeNull();
    await delegate(runtime, message("2080", lane.route));
    expect(launched).toHaveLength(1);
    expect(launched[0]).not.toHaveProperty("model");
    expect(store.lane(lane.id)).toMatchObject({ model: otherModel, modelReason: expect.stringContaining("authoritative native session") });
    expect(hosts.get(lane.socketPath)?.prompts).toHaveLength(1);
    expect(store.adoptLaneModel(lane.id, 1, executionModel, "Never overwrite restored transcript")).toBe(false);
  });

  test("never-started legacy lanes adopt the authoritative head current model once, not config.model", async () => {
    const { runtime, store, config, main, launched } = fixture();
    const lane = legacyLane(store, config, "legacy-new", route("30"));
    main.state.model = otherModel;
    config.model = "global/not-native";
    await runtime.start();
    await delegate(runtime, message("2090", lane.route));
    expect(launched[0]?.model).toBe("fixture/efficient");
    expect(store.lane(lane.id)).toMatchObject({ model: otherModel, modelReason: expect.stringContaining("never-started lane") });
    expect(store.lane(lane.id)?.modelReason).toContain("not judge-selected");
  });

  test("legacy lanes hold when the authoritative head default is absent, unavailable, or non-chat", async () => {
    for (const model of [null, { provider: "fixture", id: "not-enabled" }, { provider: "fixture", id: "judge" }]) {
      const { runtime, store, config, main, launched } = fixture();
      const lane = legacyLane(store, config, "legacy-unknown", route("31"));
      main.state.model = model;
      config.model = "fixture/capable";
      await runtime.start();
      await delegate(runtime, message("2100", lane.route));
      expect(launched).toEqual([]);
      expect(store.lane(lane.id)).toMatchObject({ model: null, modelReason: null, generation: 0, runtimeState: "interrupted" });
      expect(delegated(store, "2100")?.state).toBe("pending");
    }
  });

  test("a missing legacy transcript with recorded session identity never becomes a new default-model session", async () => {
    const { runtime, store, config, launched } = fixture();
    const lane = legacyLane(store, config, "legacy-missing", route("37"));
    store.updateLane(lane.id, 0, { sessionId: "recorded-native-session" });
    await runtime.start();
    await delegate(runtime, message("2105", lane.route));
    expect(launched).toEqual([]);
    expect(store.lane(lane.id)).toMatchObject({ model: null, generation: 0, runtimeState: "interrupted" });
    expect((await runtime.inspect(lane.id) as { modelCheck: { error: string } }).modelCheck.error).toContain("restore it before resuming");
  });

  test("an unavailable legacy live model is never adopted or prompted", async () => {
    const { runtime, store, config, hosts } = fixture();
    const lane = legacyLane(store, config, "legacy-unavailable", route("32"), process.pid);
    const host = new HostTransport(lane.sessionFile, "session-legacy-unavailable", { provider: "fixture", id: "judge" });
    hosts.set(lane.socketPath, host);
    await runtime.start();
    await delegate(runtime, message("2110", lane.route));
    expect(store.lane(lane.id)).toMatchObject({ model: null, modelReason: null, runtimeState: "interrupted" });
    expect(host.prompts).toEqual([]);
    expect(delegated(store, "2110")?.state).toBe("pending");
  });

  test("offline legacy readback without a native model holds after launch, before adoption or prompt", async () => {
    const { runtime, store, config, hosts, launched, launchBehavior } = fixture();
    const lane = legacyLane(store, config, "legacy-no-readback", route("33"));
    legacyTranscript(lane, otherModel);
    launchBehavior.model = null;
    await runtime.start();
    await delegate(runtime, message("2120", lane.route));
    expect(launched[0]).not.toHaveProperty("model");
    expect(store.lane(lane.id)).toMatchObject({ model: null, modelReason: null, runtimeState: "interrupted" });
    expect(hosts.get(lane.socketPath)?.prompts).toEqual([]);
  });

  test("generation races fence live legacy adoption and prevent prompt dispatch", async () => {
    const { runtime, store, config, main, hosts } = fixture();
    const lane = legacyLane(store, config, "legacy-race", route("34"), process.pid);
    const host = new HostTransport(lane.sessionFile, "session-legacy-race", otherModel);
    hosts.set(lane.socketPath, host);
    main.beforeCatalog = () => { main.beforeCatalog = undefined; store.nextGeneration(lane.id); };
    await runtime.start();
    await delegate(runtime, message("2130", lane.route));
    expect(store.lane(lane.id)).toMatchObject({ generation: 1, model: null, modelReason: null });
    expect(host.prompts).toEqual([]);
  });

  test("generation races during availability checks cannot launch a superseded lane", async () => {
    const { runtime, store, config, main, launched } = fixture();
    const lane = savedLane(store, config, "launch-race", route("35"));
    await runtime.start();
    main.beforeCatalog = () => { main.beforeCatalog = undefined; store.nextGeneration(lane.id); };
    await delegate(runtime, message("2140", lane.route));
    expect(launched).toEqual([]);
    expect(store.lane(lane.id)).toMatchObject({ generation: 1, ...selection });
    expect(delegated(store, "2140")?.state).toBe("pending");
  });
});

describe("frozen native preset lane choices", () => {
  test("native preset starts and resumes use the saved full snapshot, never later preset edits", async () => {
    const { runtime, store, config, nativePresets, directory, launched, hosts, messenger, launchBehavior } = fixture();
    launchBehavior.pid = 2147483647;
    const saved = structuredClone(nativePresets.get("high")!);
    await runtime.start();
    await admit(runtime, headMessage("2200", route("60")));
    const lane = await runtime.startLane({ sourceId: "2200", title: "Frozen native preset", kickoff: "I will inspect the requested workspace, perform the authorized work, and verify the result in this topic.", cwd: directory, preset: "high", modelReason: "Native judge recommends the saved high preset." });
    await runtime.kick();
    expect(store.lane(lane.id)).toMatchObject({ model: saved.model, modelPreset: "high", modelPresetSnapshot: saved.snapshot });
    expect(launched[0]?.modelPreset).toEqual({ name: "high", preset: saved.snapshot });
    expect(launched[0]?.model).toBe("fixture/capable");
    const host = hosts.get(lane.socketPath)!;
    host.shutdownDisconnect = true;
    host.complete("First native preset execution");
    await runtime.kick();
    expect(messenger.sent).toEqual([expect.objectContaining({ id: "2200:kickoff", sourceId: "handoff:2200:lane", route: lane.route })]);
    await runtime.kick();
    await runtime.closeLane(lane.id, "completed", "Observed first preset execution complete");
    nativePresets.set("high", { ...structuredClone(nativePresets.get("low")!), preset: "high" });
    expect(await runtime.startLane({ sourceId: "2200", title: "Original source replay", kickoff: "I will inspect the requested workspace, perform the authorized work, and verify the result in this topic.", cwd: directory, preset: "high", modelReason: "Do not retarget an existing source." }))
      .toMatchObject({ id: lane.id, model: saved.model, modelPresetSnapshot: saved.snapshot });
    config.model = "global/not-a-lane-default";
    await runtime.resume(lane.id);
    await delegate(runtime, message("2201", lane.route));
    expect(launched[1]?.modelPreset).toEqual({ name: "high", preset: saved.snapshot });
    expect(store.lane(lane.id)).toMatchObject({ model: executionModel, modelPresetSnapshot: saved.snapshot });
    expect(hosts.get(lane.socketPath)?.state.modelSettings).toEqual(saved.snapshot);
  });

  test("preset changes apply all native roles/thinking and direct choices preserve the remaining native settings", async () => {
    const { runtime, store, config, nativePresets, hosts, main } = fixture();
    const lane = savedLane(store, config, "preset-switch", route("61"), process.pid);
    const host = new HostTransport(lane.sessionFile, "session-preset-switch");
    hosts.set(lane.socketPath, host);
    const presetBefore = structuredClone([...nativePresets]);
    const mainBefore = structuredClone(main.state.modelSettings);
    await runtime.start();
    const sourceId = modelChangeSource(store, "preset-low-change");
    const change = { id: lane.id, sourceId, preset: "low", modelReason: "Explicitly select the native low preset for this idle lane." };
    const saved = structuredClone(nativePresets.get("low")!);
    expect(await runtime.changeModel(change)).toMatchObject({ model: otherModel, modelPreset: "low", modelPresetSnapshot: saved.snapshot, state: { modelSettings: saved.snapshot } });
    expect(host.commands.filter(command => command.type === "set_model_preset")).toEqual([{ type: "set_model_preset", name: "low", preset: saved.snapshot }]);
    nativePresets.set("low", { ...structuredClone(nativePresets.get("high")!), preset: "low" });
    expect(await runtime.changeModel(change)).toMatchObject({ model: otherModel, modelPresetSnapshot: saved.snapshot });
    expect(host.commands.filter(command => command.type === "set_model_preset")).toHaveLength(1);
    const beforeDirect = structuredClone(host.state.modelSettings);
    await runtime.changeModel({ id: lane.id, sourceId: modelChangeSource(store, "preset-clear-direct"), model: executionModel, modelReason: "Change only this lane's default execution identity." });
    expect(store.lane(lane.id)).toMatchObject({ model: executionModel, modelPreset: null, modelPresetSnapshot: null });
    expect(host.state.modelSettings).toEqual(beforeDirect);
    expect(main.state.modelSettings).toEqual(mainBefore);
    const unchangedHigh = nativePresets.get("high");
    if (!unchangedHigh) throw new Error("The existing high preset unexpectedly disappeared");
    expect(presetBefore[0]).toEqual(["high", unchangedHigh]);
  });

  test("full preset lost-ack recovery rejects default-identity-only evidence and explicit retry uses its saved snapshot", async () => {
    const { runtime, store, config, hosts, nativePresets } = fixture();
    const lane = savedLane(store, config, "preset-ambiguous", route("62"), process.pid);
    const host = new HostTransport(lane.sessionFile, "session-preset-ambiguous");
    hosts.set(lane.socketPath, host);
    await runtime.start();
    const sourceId = modelChangeSource(store, "preset-ambiguous-change");
    const change = { id: lane.id, sourceId, preset: "low", modelReason: "Require complete native preset readback." };
    const snapshot = structuredClone(nativePresets.get("low")!.snapshot);
    host.modelSetResult = "throw-after";
    await expect(runtime.changeModel(change)).rejects.toThrow("acknowledgement lost");
    host.state.modelSettings = { modelRoles: { ...snapshot.modelRoles, smol: "fixture/capable" }, defaultThinkingLevel: Effort.High };
    expect(await runtime.inspect(lane.id)).toMatchObject({ model: executionModel, modelChange: { sourceId, snapshot }, modelCheck: { actual: otherModel, error: expect.stringContaining("durable intent") } });
    expect(store.getMeta(`lane-model:${lane.id}:receipt:${sourceId}`)).toBeNull();
    nativePresets.set("low", { ...structuredClone(nativePresets.get("high")!), preset: "low" });
    host.modelSetResult = "success";
    expect(await runtime.changeModel(change)).toMatchObject({ model: otherModel, modelPresetSnapshot: snapshot, modelChange: null });
    expect(host.state.modelSettings).toEqual(snapshot);
    expect(host.commands.filter(command => command.type === "set_model_preset")).toHaveLength(2);
  });

  test("full preset drift holds execution even when the default model identity still matches", async () => {
    const { runtime, store, config, hosts } = fixture();
    const lane = savedLane(store, config, "preset-roles-drift", route("63"), process.pid);
    const host = new HostTransport(lane.sessionFile, "session-preset-roles-drift");
    hosts.set(lane.socketPath, host);
    await runtime.start();
    await runtime.changeModel({ id: lane.id, sourceId: modelChangeSource(store, "preset-roles-change"), preset: "low", modelReason: "Track the complete preset, not only its default." });
    host.state.modelSettings!.modelRoles.smol = "fixture/capable";
    await delegate(runtime, message("2210", lane.route));
    expect(host.prompts).toEqual([]);
    expect(delegated(store, "2210")?.state).toBe("pending");
    expect(await runtime.inspect(lane.id)).toMatchObject({ modelCheck: { expected: otherModel, actual: otherModel, error: expect.stringContaining("roles/thinking drift") } });
  });

  test("an explicit same-source unloaded preset retry may launch its saved snapshot without blind automatic replay", async () => {
    const { runtime, store, config, hosts, nativePresets, launched } = fixture(2);
    const lane = savedLane(store, config, "preset-offline-retry", route("68"), process.pid);
    const host = new HostTransport(lane.sessionFile, "session-preset-offline-retry");
    hosts.set(lane.socketPath, host);
    legacyTranscript(lane, executionModel);
    await runtime.start();
    const sourceId = modelChangeSource(store, "preset-offline-retry-change");
    const change = { id: lane.id, sourceId, preset: "low", modelReason: "Explicit retry authorizes this exact saved native preset." };
    const snapshot = structuredClone(nativePresets.get("low")!.snapshot);
    host.modelSetResult = "throw-before";
    await expect(runtime.changeModel(change)).rejects.toThrow("outcome unknown");
    store.updateLane(lane.id, 0, { pid: null });
    hosts.delete(lane.socketPath);
    await host.close();
    await runtime.kick();
    expect(launched).toEqual([]);
    nativePresets.set("low", { ...structuredClone(nativePresets.get("high")!), preset: "low" });
    expect(await runtime.changeModel(change)).toMatchObject({ model: otherModel, modelPresetSnapshot: snapshot, modelChange: null });
    expect(launched).toHaveLength(1);
    expect(launched[0]).toMatchObject({ model: "fixture/efficient", modelPreset: { name: "low", preset: snapshot } });
    expect(hosts.get(lane.socketPath)?.prompts).toEqual([]);
  });

  test("unloaded explicit changes restore the old transcript then journal the chosen model before dispatch", async () => {
    const { runtime, store, config, hosts, launched, errors } = fixture();
    const lane = savedLane(store, config, "deferred-journal", route("64"));
    legacyTranscript(lane, executionModel);
    store.updateLane(lane.id, 0, { sessionId: "session-deferred-journal" });
    await runtime.start();
    await runtime.changeModel({ id: lane.id, sourceId: modelChangeSource(store, "deferred-journal-change"), model: otherModel, modelReason: "Journal this explicit selection on native transcript restoration." });
    expect(launched).toEqual([]);
    expect(store.getMeta(`lane-model:${lane.id}:apply`)).toBeTruthy();
    await delegate(runtime, message("2220", lane.route));
    expect(errors).toEqual([]);
    expect(launched).toHaveLength(1);
    expect(launched[0]).not.toHaveProperty("model");
    const host = hosts.get(lane.socketPath)!;
    expect(host.commands.map(command => command.type)).toEqual(["set_model", "get_journal_cursor", "prompt"]);
    expect(host.state.model).toEqual(otherModel);
    expect(store.getMeta(`lane-model:${lane.id}:apply`)).toBe("");
    expect(host.prompts).toHaveLength(1);
  });

  test("intake admitted during the final output flush stays in the shared runtime drain", async () => {
    const { runtime, store, config, hosts, messenger, main } = fixture();
    const lane = savedLane(store, config, "flush-intake", route("69"));
    await runtime.start();
    const sourceId = modelChangeSource(store, "flush-intake-source");
    store.queueOutput({ id: "flush-intake-output", sourceId, route: store.input(sourceId)!.route, text: "Prior output" });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const send = messenger.send.bind(messenger);
    messenger.send = async output => { entered.resolve(); await release.promise; return send(output); };
    const flushing = runtime.kick();
    await entered.promise;
    await runtime.receive(headMessage("2221", lane.route));
    const draining = runtime.kick();
    release.resolve();
    await Promise.all([flushing, draining]);
    expect(hosts.get(lane.socketPath)?.prompts ?? []).toEqual([]);
    expect(main.prompts).toHaveLength(1);
    expect(store.input("2221")?.state).toBe("submitted");
  });

  test("native names are not restricted to bootstrap labels and missing presets cannot create remote work", async () => {
    const { runtime, store, nativePresets, directory, messenger } = fixture();
    nativePresets.set("my-team-coding", { ...structuredClone(nativePresets.get("high")!), preset: "my-team-coding" });
    await runtime.start();
    await admit(runtime, headMessage("2230", route("65")));
    expect(await runtime.startLane({ sourceId: "2230", title: "Custom native preset", kickoff: "I will inspect the requested workspace, perform the authorized work, and verify the result in this topic.", cwd: directory, preset: "my-team-coding", modelReason: "Use an existing operator native preset." })).toMatchObject({ modelPreset: "my-team-coding", model: executionModel });
    store.receive(message("2231", route(null)), "main");
    store.submit("2231", "already-head-owned", 0);
    await expect(runtime.startLane({ sourceId: "2231", title: "Missing preset", kickoff: "I will inspect the requested workspace, perform the authorized work, and verify the result in this topic.", cwd: directory, preset: "missing-native-name", modelReason: "No fallback is authorized." })).rejects.toThrow("not configured");
    expect(messenger.threads).toEqual([]);
    expect(store.input("handoff:2231:lane")).toBeNull();
  });

  test("older unisolated hosts cannot execute or mutate managed lane model settings", async () => {
    for (const scope of ["persistent", undefined] as const) {
      const { runtime, store, config, hosts } = fixture();
      const lane = savedLane(store, config, "unisolated-host", route("66"), process.pid);
      const host = new HostTransport(lane.sessionFile, "session-unisolated-host");
      host.state.settingsScope = scope;
      hosts.set(lane.socketPath, host);
      await runtime.start();
      await delegate(runtime, message("2240", lane.route));
      await expect(runtime.changeModel({ id: lane.id, sourceId: modelChangeSource(store, "unisolated-change"), model: otherModel, modelReason: "Never mutate persistent settings." })).rejects.toThrow("session-isolated");
      expect(host.prompts).toEqual([]);
      expect(host.commands.some(command => command.type === "set_model" || command.type === "set_model_preset")).toBe(false);
      expect(delegated(store, "2240")?.state).toBe("pending");
    }
  });

  test("missing full native modelSettings cannot be replaced with guessed preset readback", async () => {
    const { runtime, store, config, hosts } = fixture();
    const lane = savedLane(store, config, "missing-preset-settings", route("67"), process.pid);
    const host = new HostTransport(lane.sessionFile, "session-missing-preset-settings");
    hosts.set(lane.socketPath, host);
    await runtime.start();
    delete host.state.modelSettings;
    await expect(runtime.changeModel({ id: lane.id, sourceId: modelChangeSource(store, "missing-preset-settings-change"), preset: "low", modelReason: "Require authoritative full native settings." })).rejects.toThrow("lacks complete effective modelSettings");
    expect(host.commands.some(command => command.type === "set_model_preset")).toBe(false);
    expect(store.lane(lane.id)?.model).toEqual(executionModel);
    expect(store.getMeta(`lane-model:${lane.id}:pending`)).toBeNull();
  });
});

describe("exact platform message clocks", () => {
  test("integer IDs and decimal timestamps never lose precision or use lexical integer order", () => {
    for (const platform of ["discord", "telegram"] as const) {
      expect(compareMessageIds(platform, "9007199254740993", "9007199254740992")).toBe(1);
      expect(compareMessageIds(platform, "10", "9")).toBe(1);
      expect(compareMessageIds(platform, "0009", "9")).toBe(0);
      expect(compareMessageIds(platform, "1.2", "2")).toBeNull();
    }
    expect(compareMessageIds("slack", "9007199254740993.000001", "9007199254740993.000002")).toBe(-1);
    expect(compareMessageIds("slack", "10.000001", "9.999999")).toBe(1);
    expect(compareMessageIds("slack", "9.1", "9.100000")).toBe(0);
    expect(compareMessageIds("slack", "9.01", "9.1")).toBe(-1);
    for (const id of ["1", "1e3", "-1.1", "1.", ".1", "1.2.3", "NaN"]) {
      expect(compareMessageIds("slack", id, "1.000001")).toBeNull();
    }
  });
});

describe("real Store runtime coordination", () => {
  test("Slack slash boundaries use durable real-message anchors, insertion order, and immutable first revisions", async () => {
    const { runtime, config, store, main, messenger } = fixture();
    config.slack = { botTokenEnv: "TEST_SLACK", appTokenEnv: "TEST_SLACK_APP", ownerId: "UOWNER", teamId: "TTEAM", allowedChannelIds: [] };
    const dm = route(null, { platform: "slack", accountId: "TTEAM:UBOT", authorityId: "UOWNER", guildId: null, channelId: "DPRIVATE" });
    const actual = (suffix: string, text = "/status", revision = "original"): Inbound => ({
      ...message(`slack:${suffix}:${revision}`, dm, text), messageId: `1750000000.${suffix}`,
    });
    await runtime.start();
    await admit(runtime, actual("000100"));
    store.setMeta(`cursor:${physicalRouteKey(dm)}`, "9999999999.999999"); // Cursor is not admission authority.
    const first = slackCommand("anchored-first", dm, "/new");
    await admit(runtime, first);
    const firstTopic = store.input(first.id)!.route.topicId!;
    await admit(runtime, actual("000099"));
    expect(store.input("slack:000099:original")!.route).toEqual(dm);
    await admit(runtime, actual("000100", "/new edited old request", "edit"));
    expect(store.input("slack:000100:edit")).toMatchObject({ state: "done", route: dm });
    await admit(runtime, actual("000101"));
    expect(store.input("slack:000101:original")!.route.topicId).toBe(firstTopic);
    const second = slackCommand("anchored-second", dm, "/new");
    const back = slackCommand("anchored-main", dm, "/main");
    const third = slackCommand("anchored-third", dm, "/new");
    await admit(runtime, second);
    await admit(runtime, back);
    await admit(runtime, third);
    const thirdTopic = store.input(third.id)!.route.topicId!;
    expect(store.input(back.id)!.route).toEqual(dm);
    await admit(runtime, actual("000101", "/help", "edit"));
    expect(store.input("slack:000101:edit")!.route.topicId).toBe(firstTopic);
    await admit(runtime, actual("000102"));
    expect(store.input("slack:000102:original")!.route.topicId).toBe(thirdTopic);
    await admit(runtime, { ...first, receivedAt: 9999 });
    expect(store.getMeta(`dm:active:${physicalRouteKey(dm)}`)).toBe(thirdTopic);
    const boundaries = JSON.parse(store.getMeta(`dm:command-boundaries:${physicalRouteKey(dm)}`)!);
    expect(boundaries.map((boundary: { anchorMessageId: string }) => boundary.anchorMessageId)).toEqual([
      "1750000000.000100", "1750000000.000101", "1750000000.000101", "1750000000.000101",
    ]);
    expect(boundaries.map((boundary: { insertionOrder: number }) => boundary.insertionOrder)).toEqual([1, 2, 3, 4]);
    expect(boundaries.every((boundary: Record<string, unknown>) => !("messageId" in boundary))).toBe(true);
    expect(store.getMeta(`dm:boundaries:${physicalRouteKey(dm)}`)).toBeNull();
    await admit(runtime, actual("000103", "/new"));
    const messageTopic = store.input("slack:000103:original")!.route.topicId!;
    await admit(runtime, slackCommand("after-message-boundary", dm, "/main"));
    await admit(runtime, actual("000103", "/new revised task", "control-edit"));
    expect(store.input("slack:000103:control-edit")).toMatchObject({ state: "done", route: { ...dm, topicId: messageTopic } });
    expect(store.getMeta(`dm:active:${physicalRouteKey(dm)}`)).toBe("");
    await admit(runtime, first);
    expect(store.getMeta(`dm:active:${physicalRouteKey(dm)}`)).toBe("");
    expect(main.prompts).toEqual([]);
    expect(messenger.threads).toEqual([]);
    await expect(runtime.receive({ ...third, text: "/main" })).rejects.toThrow("Inbound identity conflict");
    await expect(runtime.receive({ ...slackCommand("forged-thread", { ...dm, threadId: "1750000000.000001" }), text: "/new" })).rejects.toThrow("requires a real message ID");
  });

  test("Slack null-anchor commands and new-request work survive reopen without resetting topics or inventing cursors", async () => {
    const { runtime, config, directory, store, main, messenger } = fixture();
    config.slack = { botTokenEnv: "TEST_SLACK", appTokenEnv: "TEST_SLACK_APP", ownerId: "UOWNER", teamId: "TTEAM", allowedChannelIds: [] };
    const dm = route(null, { platform: "slack", accountId: "TTEAM:UBOT", authorityId: "UOWNER", guildId: null, channelId: "DPRIVATE" });
    await runtime.start();
    const first = slackCommand("null-first", dm, "/new");
    await admit(runtime, first);
    const originalRoute = store.input(first.id)!.route;
    await admit(runtime, slackCommand("null-second", dm, "/new"));
    await admit(runtime, slackCommand("null-main", dm, "/main"));
    expect(main.prompts).toEqual([]);
    expect(messenger.activities).toEqual([]);
    expect(store.getMeta(`cursor:${physicalRouteKey(dm)}`)).toBeNull();
    expect(JSON.parse(store.getMeta(`dm:command-boundaries:${physicalRouteKey(dm)}`)!).map((boundary: { anchorMessageId: null }) => boundary.anchorMessageId)).toEqual([null, null, null]);
    await runtime.stop();
    const reopened = new Store(join(directory, "coordination.sqlite"));
    const transport = new MessengerTransport();
    const head = new HostTransport(hostPaths(config, "main").sessionFile, "session-main");
    const restarted = new Superagent(config, reopened, transport, join(directory, "extension.ts"), () => {}, {
      connect: async path => {
        if (path !== hostPaths(config, "main").socketPath) throw new Error("Unexpected lane adoption");
        return head;
      }, startHost: async () => { throw new Error("No lane launch is authorized"); },
    });
    fixtures.find(entry => entry.runtime === runtime)!.runtime = restarted;
    await restarted.start();
    await admit(restarted, { ...first, receivedAt: 12345 });
    expect(reopened.input(first.id)).toMatchObject({ messageId: null, invocationId: first.invocationId, receivedAt: first.receivedAt, route: originalRoute });
    expect(reopened.getMeta(`dm:active:${physicalRouteKey(dm)}`)).toBe("");
    expect(head.prompts).toEqual([]);
    const request = slackCommand("null-request", dm, "/new inspect this repository");
    await admit(restarted, request);
    expect(reopened.input(request.id)).toMatchObject({ target: null, state: "pending", messageId: null, invocationId: request.invocationId, text: request.text });
    const pendingRoute = reopened.input(request.id)!.route;
    expect(pendingRoute.topicId).toMatch(/^topic-/);
    expect(reopened.output(`${request.id}:workspace`)).toMatchObject({ state: "sent", route: pendingRoute, sourceId: request.id });
    expect(head.prompts).toEqual([]);
    expect(transport.activities).toEqual([]);
    expect(transport.fetched).toEqual([]);
    expect(reopened.getMeta(`cursor:${physicalRouteKey(dm)}`)).toBeNull();
    await expect(restarted.receive({ ...first, invocationId: "a".repeat(64) })).rejects.toThrow("Inbound identity conflict");
  });

  test("Discord DM command boundaries use interaction snowflakes, not synthetic event IDs or arrival clocks", async () => {
    const { runtime, store, main } = fixture();
    const dm = route(null, { guildId: null });
    await runtime.start();
    const first = { ...applicationCommand("9007199254740993", dm, "/new"), id: "z-synthetic-event", receivedAt: 999 };
    await admit(runtime, first);
    const topic = store.input(first.id)!.route.topicId!;
    const returned = { ...applicationCommand("9007199254740995", dm, "/main"), id: "a-synthetic-event", receivedAt: 1 };
    await admit(runtime, returned);
    const late = { ...message("9007199254740994", dm, "/status"), receivedAt: 5000 };
    await admit(runtime, late);
    expect(store.input(late.id)?.route).toEqual({ ...dm, topicId: topic });
    await admit(runtime, message("9007199254740992", dm, "/help"));
    expect(store.input("9007199254740992")?.route).toEqual(dm);
    await admit(runtime, applicationCommand("9007199254740996", dm, "/context"));
    expect(store.input("interaction:9007199254740996")?.route).toEqual(dm);
    expect(store.getMeta(`dm:active:${physicalRouteKey(dm)}`)).toBe("");
    expect(store.getMeta(`cursor:${physicalRouteKey(dm)}`)).toBe(late.messageId);
    await admit(runtime, first);
    expect(store.getMeta(`dm:active:${physicalRouteKey(dm)}`)).toBe("");
    expect(store.input(first.id)?.route).toEqual({ ...dm, topicId: topic });
    expect(main.prompts).toEqual([]);
    for (const interactionId of [undefined, "synthetic-command-id", ""]) {
      const invalid = { ...applicationCommand("9007199254740997", dm, "/new"), id: "missing-identity", interactionId };
      await expect(runtime.receive(invalid)).rejects.toThrow("requires a real message ID");
      expect(store.input(invalid.id)).toBeNull();
    }
    expect(store.getMeta(`dm:active:${physicalRouteKey(dm)}`)).toBe("");
  });

  test("slash origin and original DM binding survive controller reopen and conflicting redelivery is rejected", async () => {
    const { runtime, config, directory, store, main, messenger } = fixture();
    const dm = route(null, { guildId: null });
    const original = applicationCommand("1750000000000000200", dm, "/new");
    await runtime.start();
    await admit(runtime, original);
    const originalRoute = store.input(original.id)!.route;
    await admit(runtime, message("1750000000000000201", dm, "/help"));
    await admit(runtime, applicationCommand("1750000000000000202", dm, "/main"));
    expect(main.prompts).toEqual([]);
    expect(messenger.activities).toEqual([]);
    await runtime.stop();

    const reopened = new Store(join(directory, "coordination.sqlite"));
    const transport = new MessengerTransport();
    const head = new HostTransport(hostPaths(config, "main").sessionFile, "session-main");
    const restarted = new Superagent(config, reopened, transport, join(directory, "extension.ts"), () => {}, {
      connect: async path => {
        if (path !== hostPaths(config, "main").socketPath) throw new Error("Unexpected native adoption");
        return head;
      },
      startHost: async () => { throw new Error("No lane launch is authorized"); },
    });
    fixtures.find(entry => entry.runtime === runtime)!.runtime = restarted;
    await restarted.start();
    await admit(restarted, original);
    expect(reopened.input(original.id)).toMatchObject({ route: originalRoute, messageId: null, interactionId: original.interactionId, state: "done" });
    expect(reopened.getMeta(`dm:active:${physicalRouteKey(dm)}`)).toBe("");
    expect(reopened.getMeta(`cursor:${physicalRouteKey(dm)}`)).toBe("1750000000000000201");
    await expect(restarted.receive({ ...original, interactionId: "1750000000000000203" })).rejects.toThrow("Inbound identity conflict");
    await expect(restarted.receive({ ...original, messageId: original.interactionId!, interactionId: undefined })).rejects.toThrow("Inbound identity conflict");
    expect(head.prompts).toEqual([]);
    expect(transport.activities).toEqual([]);
  });

  test("Slack DM boundaries follow exact timestamps across late intake, edits, and immutable command replay", async () => {
    const { runtime, config, store, directory } = fixture();
    delete config.discord;
    config.slack = { botTokenEnv: "TEST_SLACK_BOT_TOKEN", appTokenEnv: "TEST_SLACK_APP_TOKEN", ownerId: "UOWNER", teamId: "TTEAM", allowedChannelIds: ["CCHANNEL"] };
    const dm = route(null, { platform: "slack", accountId: "TTEAM:UBOT", authorityId: "UOWNER", guildId: null, channelId: "DPRIVATE" });
    const event = (suffix: string, text: string, receivedAt = 100): Inbound => ({
      ...message(`slack:${suffix}`, dm, text), messageId: `1750000000.${suffix}`, receivedAt,
    });
    await runtime.start();
    const firstRequest = event("000002", `/new cwd: ${directory}\nfirst task`, 500);
    await admit(runtime, firstRequest);
    const [first] = store.lanes();
    if (!first) throw new Error("Expected the first Slack topic lane");
    await admit(runtime, event("000004", "/main", 1));
    await admit(runtime, event("000003", "Late first topic followup", 900));
    expect(store.input("slack:000003")).toMatchObject({ target: null, state: "done", route: first.route });
    await admit(runtime, { ...event("000003", "Edited first topic followup"), id: "slack:000003:edited" });
    expect(store.input("slack:000003:edited")).toMatchObject({ target: null, state: "done", route: first.route });
    for (const id of ["slack:000003", "slack:000003:edited"]) {
      expect(store.input(`handoff:${id}:${first.id}`)?.target).toBe(first.id);
    }
    await admit(runtime, event("000001", "/head Historical main request", 999));
    expect(store.input("slack:000001")?.target).toBe("main");
    await admit(runtime, event("000005", "/head Current main request", 0));
    expect(store.input("slack:000005")?.route).toEqual(dm);
    await admit(runtime, firstRequest);
    expect(store.getMeta(`dm:active:${physicalRouteKey(dm)}`)).toBe("");
    expect(store.input(firstRequest.id)).toMatchObject({ target: null, state: "done", text: firstRequest.text });
    expect(store.getMeta(`cursor:${physicalRouteKey(dm)}`)).toBe("1750000000.000005");
    await admit(runtime, event("000006", "/new later task"));
    const currentTopic = store.input("slack:000006")!.route.topicId!;
    await admit(runtime, { ...event("000002", "/new revised first task"), id: "slack:first-command-edit" });
    expect(store.input("slack:first-command-edit")).toMatchObject({ target: "main", state: "done", route: first.route });
    await admit(runtime, { ...event("000004", "/new revised main task"), id: "slack:main-command-edit" });
    expect(store.input("slack:main-command-edit")).toMatchObject({ target: "main", state: "done", route: dm });
    await admit(runtime, { ...event("000002", "/main"), id: "slack:first-control-edit" });
    expect(store.input("slack:first-control-edit")).toMatchObject({ state: "done", route: first.route });
    await admit(runtime, { ...event("000004", "/new"), id: "slack:main-control-edit" });
    expect(store.input("slack:main-control-edit")).toMatchObject({ state: "done", route: dm });
    expect(store.lanes()).toHaveLength(1);
    expect(store.input(firstRequest.id)).toMatchObject({ target: null, state: "done", text: firstRequest.text });
    expect(store.input("slack:000004")?.route).toEqual(dm);
    expect(store.getMeta(`dm:active:${physicalRouteKey(dm)}`)).toBe(currentTopic);
    expect(store.getMeta(`cursor:${physicalRouteKey(dm)}`)).toBe("1750000000.000006");
    await expect(runtime.receive({ ...event("000007", "Unsupported timestamp"), id: "slack:bad", messageId: "not-a-timestamp" })).rejects.toThrow("Cannot order");
    expect(store.input("slack:bad")).toBeNull();
    expect(store.getMeta(`dm:active:${physicalRouteKey(dm)}`)).toBe(currentTopic);
  });

  test("edits to existing topic commands never execute changed tasks or reset native sessions", async () => {
    const { runtime, main, store, messenger } = fixture();
    const dm = route(null, { guildId: null });
    await runtime.start();
    await admit(runtime, message("810", dm, "/main"));
    await admit(runtime, message("820", dm, "/new"));
    const activeTopic = store.input("820")!.route.topicId!;
    await admit(runtime, { ...message("810:edited", dm, "/new revised main task"), messageId: "810" });
    expect(store.input("810:edited")).toMatchObject({ target: "main", state: "done", route: dm });
    expect(main.prompts).toEqual([]);
    expect(store.getMeta(`dm:active:${physicalRouteKey(dm)}`)).toBe(activeTopic);
    await admit(runtime, { ...message("810:control-edit", dm, "/new"), messageId: "810" });
    expect(store.input("810:control-edit")?.state).toBe("done");
    expect(messenger.sent.some(output => output.sourceId === "810:control-edit" && output.text.includes("새 메시지"))).toBe(true);
    expect(main.prompts).toEqual([]);
  });

  test("Slack submitted DM handoff preserves original ownership and actual DM threads stay physical", async () => {
    const { runtime, config, store, directory, messenger, main } = fixture();
    config.slack = { botTokenEnv: "TEST_SLACK_BOT_TOKEN", appTokenEnv: "TEST_SLACK_APP_TOKEN", ownerId: "UOWNER", teamId: "TTEAM", allowedChannelIds: [] };
    const dm = route(null, { platform: "slack", accountId: "TTEAM:UBOT", authorityId: "UOWNER", guildId: null, channelId: "DPRIVATE" });
    await runtime.start();
    await admit(runtime, { ...headMessage("slack:head", dm), messageId: "1750000000.000001" });
    const delegated = await runtime.startLane({ ...selection, sourceId: "slack:head", title: "Handoff", kickoff: "I will inspect the requested workspace, perform the authorized work, and verify the result in this topic.", cwd: directory });
    expect(store.input("slack:head")).toMatchObject({ target: "main", state: "submitted", route: dm });
    expect(store.input("handoff:slack:head:lane")?.target).toBe(delegated.id);
    expect(delegated.route.threadId).toBeNull();
    expect(delegated.route.topicId).toBeTruthy();
    const threaded = { ...dm, threadId: "1750000000.000100" };
    await admit(runtime, { ...message("slack:thread", threaded, `cwd: ${directory}\nIndependent native DM thread`), messageId: "1750000000.000101" });
    const physicalLane = store.laneForRoute(threaded);
    if (!physicalLane) throw new Error("Expected a distinct physical Slack DM thread lane");
    expect(physicalLane.id).not.toBe(delegated.id);
    expect(store.input("handoff:slack:thread:lane")?.target).toBe(physicalLane.id);
    expect(store.input("slack:thread")).toMatchObject({ target: null, state: "done", route: threaded });
    expect(store.input("slack:thread")?.route.topicId).toBeUndefined();
    expect(physicalRouteKey(threaded)).not.toBe(physicalRouteKey(dm));
    expect(messenger.threads).toEqual([]);
    expect(main.prompts).toHaveLength(1);
  });

  test("Telegram negative group chats and real forum topic IDs keep independent native lanes", async () => {
    const { runtime, config, store, directory, hosts, messenger } = fixture();
    delete config.discord;
    config.telegram = { tokenEnv: "TEST_TELEGRAM_TOKEN", ownerId: "1", allowedChatIds: ["-1001234567890"] };
    const firstRoute = route("42", { platform: "telegram", guildId: "-1001234567890", channelId: "-1001234567890" });
    const secondRoute = { ...firstRoute, threadId: "43" };
    await runtime.start();
    await admit(runtime, headMessage("901", firstRoute));
    await admit(runtime, headMessage("902", secondRoute));
    const first = await runtime.startLane({ ...selection, sourceId: "901", title: "Forum one", kickoff: "I will inspect the requested workspace, perform the authorized work, and verify the result in this topic.", cwd: directory });
    const second = await runtime.startLane({ ...selection, sourceId: "902", title: "Forum two", kickoff: "I will inspect the requested workspace, perform the authorized work, and verify the result in this topic.", cwd: directory });
    await runtime.kick();
    expect(first.route).toEqual(firstRoute);
    expect(second.route).toEqual(secondRoute);
    expect(first.route.topicId).toBeUndefined();
    expect(first.id).not.toBe(second.id);
    expect(store.input("901")?.target).toBe("main");
    expect(store.input("902")?.target).toBe("main");
    expect(store.input("handoff:901:lane")?.target).toBe(first.id);
    expect(store.input("handoff:902:lane")?.target).toBe(second.id);
    hosts.get(first.socketPath)!.complete("First forum reply");
    hosts.get(second.socketPath)!.complete("Second forum reply");
    await runtime.kick();
    expect(messenger.sent).toEqual([
      expect.objectContaining({ id: "901:kickoff", sourceId: "handoff:901:lane", route: firstRoute }),
      expect.objectContaining({ id: "902:kickoff", sourceId: "handoff:902:lane", route: secondRoute }),
    ]);
    expect(store.input("report:handoff:901:lane")?.route.threadId).toBe("42");
    expect(store.input("report:handoff:902:lane")?.route.threadId).toBe("43");
    await expect(runtime.receive(message("903", { ...firstRoute, guildId: "-100999", channelId: "-100999" }))).rejects.toThrow("Unauthorized");
    expect(store.input("903")).toBeNull();
  });

  test("platform account scope and native identical message IDs never share cursors or lane identity", async () => {
    const { runtime, config, store } = fixture();
    config.telegram = { tokenEnv: "TEST_TELEGRAM_TOKEN", ownerId: "1", allowedChatIds: ["3"] };
    config.slack = { botTokenEnv: "TEST_SLACK_BOT_TOKEN", appTokenEnv: "TEST_SLACK_APP_TOKEN", ownerId: "1", teamId: "TTEAM", allowedChannelIds: ["4"] };
    const discord = route();
    const telegram = route("10", { platform: "telegram", guildId: "3", channelId: "3" });
    await runtime.start();
    await admit(runtime, { ...message("discord:100", discord), messageId: "100" });
    await admit(runtime, { ...message("telegram:100", telegram), messageId: "100" });
    expect(store.input("discord:100")?.route).toEqual(discord);
    expect(store.input("telegram:100")?.route).toEqual(telegram);
    expect(physicalRouteKey(discord)).not.toBe(physicalRouteKey(telegram));
    expect(store.getMeta(`cursor:${physicalRouteKey(discord)}`)).toBe("100");
    expect(store.getMeta(`cursor:${physicalRouteKey(telegram)}`)).toBe("100");
    await expect(runtime.receive({ ...message("discord:100", telegram), messageId: "100" })).rejects.toThrow("physical identity conflict");
    for (const destination of [
      { ...telegram, authorityId: "other" },
      { ...telegram, guildId: "4", channelId: "4" },
      route(null, { platform: "slack", accountId: "TFOREIGN:UBOT", guildId: null, channelId: "DPRIVATE" }),
    ]) await expect(runtime.receive(message("foreign", destination))).rejects.toThrow("Unauthorized");
    expect(store.input("foreign")).toBeNull();
  });

  test("lane children scrub every configured messenger credential while preserving unrelated environment", () => {
    const { runtime, config } = fixture();
    config.telegram = { tokenEnv: "TEST_TELEGRAM_TOKEN", ownerId: "1", allowedChatIds: [] };
    config.slack = { botTokenEnv: "TEST_SLACK_BOT_TOKEN", appTokenEnv: "TEST_SLACK_APP_TOKEN", ownerId: "UOWNER", teamId: "TTEAM", allowedChannelIds: [] };
    const names = ["TEST_DISCORD_TOKEN", "TEST_TELEGRAM_TOKEN", "TEST_SLACK_BOT_TOKEN", "TEST_SLACK_APP_TOKEN", "OMP_RPC_SOCKET", "OMP_SUPERAGENT_GATEWAY_TOKEN", "TEST_PROVIDER_SECRET"];
    const previous = new Map(names.map(name => [name, process.env[name]]));
    try {
      for (const name of names) process.env[name] = `private-${name}`;
      const env = runtime.childEnvironment("lane-test");
      for (const name of names.slice(0, -1)) expect(env[name]).toBeUndefined();
      expect(env.TEST_PROVIDER_SECRET).toBe("private-TEST_PROVIDER_SECRET");
      expect(env.OMP_SUPERAGENT_ROLE).toBe("lane");
      expect(env.OMP_SUPERAGENT_LANE).toBe("lane-test");
      expect(env.OMP_SUPERAGENT_CONFIG).toBe(config.path);
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  for (const certainty of ["rejected", "uncertain", "untyped"] as const) {
    test(`${certainty} message delivery is durably classified and never automatically replayed`, async () => {
      const { runtime, store, messenger } = fixture();
      const destination = route(null, { guildId: null });
      const id = `delivery:${certainty}`;
      store.queueOutput({ id, sourceId: "notice", route: destination, text: "Safe output" });
      messenger.sendError = certainty === "untyped"
        ? Object.assign(new Error("ambiguous SDK error"), { certainty: "rejected" })
        : new DeliveryError("safe platform failure", certainty);
      await runtime.start();
      await runtime.kick();
      await runtime.kick();
      expect(messenger.attempted).toHaveLength(1);
      expect(messenger.sent).toEqual([]);
      expect(store.outputs()).toEqual([]);
      expect(store.claimOutput(id)).toBe(false);
      if (certainty === "rejected") {
        expect(() => store.finishOutput(id, "sent", "unconfirmed-receipt")).toThrow("Invalid output transition");
        store.finishOutput(id, "pending");
        messenger.sendError = undefined;
        await runtime.kick();
        expect(messenger.attempted).toHaveLength(2);
        expect(messenger.sent).toHaveLength(1);
      } else {
        store.finishOutput(id, "sent", "operator-reconciled-receipt");
        await runtime.kick();
        expect(messenger.attempted).toHaveLength(1);
      }
    });
  }

  test("secret native dialogs fail closed without presenting or persisting messenger cards", async () => {
    const { runtime, main, messenger, store } = fixture();
    await runtime.start();
    await admit(runtime, headMessage("secret-source", route(null, { guildId: null })));
    const frame = { type: "extension_ui_request", method: "input", id: "secret-dialog", title: "Credential", secret: true };
    main.state.pendingUiRequests = [frame];
    main.emit(frame);
    await runtime.kick();
    expect(main.responses).toContainEqual({ id: frame.id, response: { cancelled: true } });
    expect(messenger.shown.size).toBe(0);
    expect(store.approvals()).toEqual([]);
  });

  test("ordinary first requests start isolated topic sessions and same-topic followups steer only their own run", async () => {
    const { runtime, store, main, messenger, directory, hosts } = fixture();
    const task = "Inspect the first topic in its selected workspace";
    const original = message("100", route(), `cwd: ${directory}\n${task}`);
    await runtime.start();
    await admit(runtime, original);
    const first = store.laneForRoute(original.route);
    if (!first) throw new Error("Expected the first topic's own lane");
    const worker = hosts.get(first.socketPath);
    if (!worker) throw new Error("Expected the first topic's own Host");
    expect(first.cwd).toBe(directory);
    expect(store.input(original.id)).toMatchObject({ target: null, state: "done", route: original.route, text: original.text });
    expect(store.input(`handoff:${original.id}:lane`)).toMatchObject({ target: first.id, state: "submitted" });
    const prompt = worker.prompts[0]?.command.message;
    expect(prompt).toContain(task);
    expect(prompt).toContain(`Original source ID: ${original.id}`);
    expect(prompt).not.toContain(`cwd: ${directory}\n${task}`);

    const followup = message("100-followup", original.route, "Check the latest status too");
    await admit(runtime, followup);
    const followupId = `handoff:${followup.id}:${first.id}`;
    expect(store.input(followup.id)).toMatchObject({ target: null, state: "done" });
    expect(store.input(followupId)).toMatchObject({ target: first.id, state: "submitted" });
    expect(worker.prompts[1]?.command).toMatchObject({ streamingBehavior: "steer", message: expect.stringContaining(`Original source ID: ${followup.id}`) });

    const other = message("100-other-topic", route("11"), `cwd: ${directory}\nInspect the second topic separately`);
    await admit(runtime, other);
    const second = store.laneForRoute(other.route);
    if (!second) throw new Error("Expected a second isolated lane");
    expect(second.id).not.toBe(first.id);
    expect(store.input(`handoff:${other.id}:lane`)).toMatchObject({ target: second.id, state: "submitted" });
    expect(hosts.get(second.socketPath)?.prompts.map(entry => entry.command.streamingBehavior)).toEqual([undefined]);

    await admit(runtime, original);
    await admit(runtime, followup);
    expect(store.lanes()).toHaveLength(2);
    expect(worker.prompts).toHaveLength(2);
    expect(main.prompts).toEqual([]);
    expect(messenger.threads).toEqual([]);
    expect(messenger.sent.map(output => output.id)).toEqual([`${original.id}:kickoff`, `${other.id}:kickoff`]);
  });

  test("only head synthesis delivers lane reports on their immutable original conversations", async () => {
    const { runtime, store, config, hosts, main, messenger } = fixture();
    const one = savedLane(store, config, "one", route("11"));
    const two = savedLane(store, config, "two", route("12"));
    await runtime.start();
    await delegate(runtime, message("101", one.route));
    await delegate(runtime, message("102", two.route));
    const first = hosts.get(one.socketPath)!;
    const second = hosts.get(two.socketPath)!;
    first.complete("answer for first");
    second.complete("answer for second");
    await runtime.kick();
    expect(messenger.sent).toEqual([]);
    expect(store.lane("one")?.workState).toBe("open");
    expect(store.input("report:handoff:101:one")?.target).toBe("main");
    // Native finish persists reports asynchronously, then wakes the head pump;
    // kick can drain an earlier snapshot before that wake is scheduled.
    await main.whenPrompts(1);
    expect(main.prompts[0]!.command.message).toContain("answer for first");
    expect(main.prompts[0]!.command.message).not.toContain("answer for second");
    main.complete("Head-verified first result");
    await messenger.whenSent(1);
    await runtime.kick();
    await main.whenPrompts(2);
    expect(main.prompts[1]!.command.message).toContain("answer for second");
    main.complete("Head-verified second result");
    await messenger.whenSent(2);
    expect(messenger.sent.map(output => [output.sourceId, output.route.threadId, output.text])).toEqual([
      ["report:handoff:101:one", "11", "Head-verified first result"],
      ["report:handoff:102:two", "12", "Head-verified second result"],
    ]);
    expect(messenger.sent).toHaveLength(2);
  });

  test("cross-channel lane handoff reports and head synthesis return to the requesting conversation", async () => {
    const { runtime, store, config, hosts, main, messenger } = fixture();
    config.discord!.allowedChannelIds.push("5");
    const lane = savedLane(store, config, "cross-channel", route("75"));
    const original = headMessage("cross-channel-source", route(null, { channelId: "5" }), "Ask the existing lane for its result here");
    await runtime.start();
    await admit(runtime, original);
    await runtime.messageLane(lane.id, "Report the requested result to head", original.id);
    const handoffId = `handoff:${original.id}:${lane.id}`;
    expect(store.input(original.id)).toMatchObject({ target: "main", state: "submitted", route: original.route });
    expect(store.input(handoffId)).toMatchObject({ target: lane.id, state: "submitted", route: lane.route });
    main.complete("");
    await runtime.kick();
    hosts.get(lane.socketPath)!.complete("Lane result for the new requesting channel");
    await main.whenPrompts(2);
    const reportId = `report:${handoffId}`;
    expect(store.input(reportId)).toMatchObject({ target: "main", state: "submitted", route: original.route, messageId: original.messageId });
    expect(store.input(reportId)?.text).toContain(`sourceId: ${original.id}`);
    expect(store.input(original.id)).toMatchObject({ target: "main", state: "done", route: original.route });
    expect(store.input(handoffId)).toMatchObject({ target: lane.id, state: "done", route: lane.route });
    expect(messenger.sent).toEqual([]);
    expect(main.prompts[1]!.command.message).toContain("Lane result for the new requesting channel");
    main.complete("Head result delivered where the user requested it");
    await messenger.whenSent(1);
    expect(messenger.sent).toMatchObject([{ sourceId: reportId, route: original.route, text: "Head result delivered where the user requested it" }]);
    expect(messenger.sent.some(output => routeKey(output.route) === routeKey(lane.route))).toBe(false);
  });

  test("explicit /head on bound topics includes compact context and never wakes paused lanes", async () => {
    const { runtime, store, config, main, messenger, launched } = fixture();
    const one = savedLane(store, config, "head-context-one", route("71"));
    const two = savedLane(store, config, "head-context-two", route("72"));
    store.updateLane(one.id, 0, { workState: "paused", result: "Private full lane transcript must not enter the head prompt" });
    await runtime.start();
    await admit(runtime, headMessage("head-first-one", one.route, "Answer this question here"));
    await admit(runtime, headMessage("head-first-two", two.route, "Answer the other question there"));
    expect(store.input("head-first-one")).toMatchObject({ target: "main", state: "submitted", route: one.route });
    expect(store.input("head-first-two")).toMatchObject({ target: "main", state: "pending", route: two.route });
    const prompt = String(main.prompts[0]!.command.message);
    expect(prompt).toContain("sourceId: head-first-one");
    expect(prompt).toContain('"id":"head-context-one"');
    expect(prompt).toContain('"workState":"paused"');
    expect(prompt).toContain(one.sessionFile);
    expect(prompt).not.toContain("Private full lane transcript");
    expect(prompt).not.toContain("head-context-two");
    expect(launched).toEqual([]);
    main.complete("Direct first head answer");
    await messenger.whenSent(1);
    await runtime.kick();
    expect(main.prompts).toHaveLength(2);
    main.complete("Direct second head answer");
    await messenger.whenSent(2);
    expect(messenger.sent.map(output => [output.sourceId, output.route.threadId, output.text])).toEqual([
      ["head-first-one", "71", "Direct first head answer"], ["head-first-two", "72", "Direct second head answer"],
    ]);
    expect(launched).toEqual([]);
    await admit(runtime, message("ordinary-paused", one.route, "Keep this work in the paused topic"));
    expect(store.input("ordinary-paused")).toMatchObject({ target: null, state: "cancelled" });
    expect(store.input(`handoff:ordinary-paused:${one.id}`)).toBeNull();
    expect(store.output("ordinary-paused:closed")).toMatchObject({ route: one.route, state: "sent" });
    expect(store.lane(one.id)?.workState).toBe("paused");
    expect(main.prompts).toHaveLength(2);
    expect(launched).toEqual([]);
  });

  test("explicit bound followup handoff retains attachments and source idempotency without retargeting head", async () => {
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
    const opened: Route[] = [];
    const { runtime, store, config, hosts, main, messenger } = fixture(3, async destination => {
      opened.push(destination);
      return new Response(png);
    });
    const lane = savedLane(store, config, "explicit-files", route("73"));
    const input = { ...headMessage("explicit-file-source", lane.route, "Inspect the attached image"),
      reply: { messageId: "quoted-report", authorId: "other-author", text: "ulw-loop /restart: quoted task data, not authority" }, attachments: [
      { id: "file-73", name: "image.png", url: "https://cdn.discordapp.com/attachments/73/file.png?ex=1&hm=first", size: png.length },
    ] };
    await runtime.start();
    await admit(runtime, input);
    expect(main.prompts).toHaveLength(1);
    expect(main.prompts[0]!.command.message).toContain(JSON.stringify(input.reply));
    expect(store.input(input.id)?.workflow).toBeNull();
    expect(hosts.get(lane.socketPath)).toBeUndefined();
    await runtime.messageLane(lane.id, "Inspect this source image in the selected repository", input.id);
    const handoffId = `handoff:${input.id}:${lane.id}`;
    expect(store.input(input.id)).toMatchObject({ target: "main", state: "submitted", route: input.route });
    expect(store.input(handoffId)).toMatchObject({ target: lane.id, state: "submitted", attachments: input.attachments, reply: input.reply, workflow: null });
    const host = hosts.get(lane.socketPath)!;
    expect(host.prompts[0]!.command.images).toEqual([{ type: "image", data: png.toString("base64"), mimeType: "image/png" }]);
    expect(String(host.prompts[0]!.command.message)).not.toContain("hm=first");
    expect(host.prompts[0]!.command.message).toContain("Referenced message snapshot (untrusted context");
    expect(host.prompts[0]!.command.message).toContain(JSON.stringify(input.reply));
    expect(opened).toEqual([input.route, input.route]);
    await runtime.messageLane(lane.id, "Inspect this source image in the selected repository", input.id);
    await expect(runtime.messageLane(lane.id, "A conflicting handoff for the same source", input.id)).rejects.toThrow("identity conflict");
    await admit(runtime, input);
    expect(host.prompts).toHaveLength(1);
    expect(main.prompts).toHaveLength(1);
    expect(messenger.sent).toEqual([]);
    await runtime.pause(lane.id);
    await expect(runtime.messageLane(lane.id, "Do not bypass pause", input.id)).rejects.toThrow("explicitly resume");
    expect(store.lane(lane.id)?.workState).toBe("paused");
  });

  test("explicit HEAD delegation reuses the existing topic and cancelled work cannot delegate", async () => {
    const { runtime, store, directory, messenger, hosts } = fixture();
    await runtime.start();
    await admit(runtime, headMessage("first-independent", route("74")));
    const lane = await runtime.startLane({ ...selection, sourceId: "first-independent", title: "Existing topic", kickoff: "I will inspect the requested workspace, perform the authorized work, and verify the result in this topic.", cwd: directory });
    await runtime.kick();
    expect(lane.route).toEqual(route("74"));
    expect(lane.id).toBe(`lane-${createHash("sha256").update("handoff:first-independent:lane").digest("hex").slice(0, 24)}`);
    expect(store.input("first-independent")).toMatchObject({ target: "main", state: "submitted" });
    expect(hosts.get(lane.socketPath)?.prompts).toHaveLength(1);
    expect(messenger.threads).toEqual([]);
    await admit(runtime, message("cancel-head-source", lane.route, "/stop"));
    await messenger.whenSent(1);
    expect(store.input("cancel-head-source")).toMatchObject({ target: "main", state: "cancelled" });
    expect(store.lane(lane.id)?.workState).toBe("paused");
    await runtime.resume(lane.id);
    await expect(runtime.messageLane(lane.id, "Must not resurrect cancellation", "cancel-head-source")).rejects.toThrow("cancelled request");
    await expect(runtime.startLane({ ...selection, sourceId: "cancel-head-source", title: "Must not create", kickoff: "I will inspect the requested workspace, perform the authorized work, and verify the result in this topic.", cwd: directory })).rejects.toThrow("cancelled main request");
    expect(store.lanes()).toHaveLength(1);
  });

  test("new-topic delegation downloads copied attachments from the immutable original source route", async () => {
    const opened: Route[] = [];
    const { runtime, store, directory, hosts, messenger } = fixture(3, async destination => {
      opened.push(destination);
      return new Response("data");
    });
    const original = { ...headMessage("new-topic-file", route(null)), attachments: [
      { id: "original-file", name: "notes.txt", url: "https://cdn.discordapp.com/attachments/4/file.txt", size: 4 },
    ] };
    await runtime.start();
    await admit(runtime, original);
    const lane = await runtime.startLane({ ...selection, sourceId: original.id, title: "Delegated files", kickoff: "I will inspect the requested workspace, perform the authorized work, and verify the result in this topic.", cwd: directory });
    await runtime.kick();
    expect(lane.route.threadId).toBe("900");
    expect(opened).toEqual([original.route, original.route]);
    expect(store.input(`handoff:${original.id}:lane`)?.attachments).toEqual(original.attachments);
    expect(store.input(original.id)?.route).toEqual(original.route);
    expect(hosts.get(lane.socketPath)?.prompts).toHaveLength(1);
    expect(messenger.threads).toHaveLength(1);
  });

  test("host budget includes main and queues another lane rather than starting beyond capacity", async () => {
    const { runtime, store, config, launched } = fixture(2);
    const one = savedLane(store, config, "one", route("11"));
    const two = savedLane(store, config, "two", route("12"));
    await runtime.start();
    await delegate(runtime, message("111", one.route));
    await delegate(runtime, message("112", two.route));
    expect(launched).toHaveLength(1);
    expect(launched[0]!.subagentConcurrency).toBe(2);
    expect(delegated(store, "111")?.state).toBe("submitted");
    expect(delegated(store, "112")?.state).toBe("pending");
    expect(store.lane("two")?.generation).toBe(0);
  });

  test.each(["message_end", "agent_end-only"] as const)("HEAD retains its latest meaningful answer through a TODO empty tail via %s", async delivery => {
    const { runtime, main, store, messenger } = fixture();
    await runtime.start();
    const original = headMessage("retained-head-answer");
    const joined = headMessage("retained-head-followup", original.route, "Include the latest status");
    await admit(runtime, original);
    await admit(runtime, joined);
    expect(main.prompts).toHaveLength(2);
    const answer = "  Latest verified HEAD answer\n";
    const messages = [
      { role: "user", content: "Original authorized request" },
      { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Earlier answer" }] },
      { role: "assistant", stopReason: "stop", content: [{ type: "text", text: answer }] },
      { role: "user", content: "TODO reminder: continue until all tasks are complete" },
      { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "" }] },
      { role: "assistant", stopReason: "stop", content: [{ type: "text", text: " \n\t" }] },
      { role: "assistant", stopReason: "stop", content: [{ type: "thinking", thinking: "Private reasoning" }] },
      { role: "assistant", stopReason: "stop", content: [] },
    ];
    if (delivery === "message_end") for (const message of messages) main.emit({ type: "message_end", message });
    main.state.isStreaming = false;
    main.emit({ type: "agent_end", isTerminal: true, yielded: true, messages });
    for (const prompt of main.prompts) main.emit({ type: "prompt_result", id: prompt.id, status: "completed", agentInvoked: true, sessionSettled: false });
    await runtime.kick();
    expect(store.input(original.id)?.state).toBe("submitted");
    expect(messenger.sent).toEqual([]);
    main.state.isSettled = true;
    main.emit({ type: "session_settled" });
    await runtime.kick();
    expect(store.input(original.id)?.state).toBe("done");
    expect(store.input(joined.id)?.state).toBe("done");
    expect(store.output(`${original.id}:answer`)).toMatchObject({ sourceId: original.id, route: original.route, state: "sent", text: answer });
    expect(store.output(`${joined.id}:answer`)).toBeNull();
    expect(messenger.sent).toMatchObject([{ id: `${original.id}:answer`, sourceId: original.id, text: answer }]);

    main.emit({ type: "agent_end", isTerminal: true, messages });
    main.emit({ type: "session_settled" });
    await admit(runtime, original);
    expect(main.prompts).toHaveLength(2);
    expect(messenger.attempted).toHaveLength(1);
    const next = headMessage("retained-next-request", route("another-conversation"));
    await admit(runtime, next);
    main.complete(" \n\t");
    await runtime.kick();
    expect(store.input(next.id)?.state).toBe("done");
    expect(store.output(`${next.id}:answer`)).toBeNull();
    expect(messenger.sent).toHaveLength(1);
  });

  test.each(["replacement", "error", "aborted"] as const)("terminal-only HEAD continuation applies %s text without replaying an earlier run", async scenario => {
    const { runtime, main, store, messenger } = fixture();
    await runtime.start();
    const original = headMessage("retained-head-continuation");
    await admit(runtime, original);
    main.emit({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Earlier run answer" }] } });
    main.emit({ type: "prompt_result", id: main.prompts[0]!.id, status: "completed", agentInvoked: true, sessionSettled: false });
    await runtime.kick();
    main.emit({ type: "agent_start" });
    main.emit({ type: "agent_end", isTerminal: true, messages: [
      { role: "assistant", stopReason: scenario === "replacement" ? "stop" : scenario,
        content: [{ type: "text", text: scenario === "replacement" ? "Latest continuation answer" : "Private failed response" }] },
      { role: "assistant", stopReason: "stop", content: [] },
    ] });
    main.state.isStreaming = false;
    main.state.isSettled = true;
    main.emit({ type: "session_settled" });
    await runtime.kick();
    expect(store.input(original.id)?.state).toBe("done");
    if (scenario === "replacement") {
      expect(messenger.sent).toMatchObject([{ sourceId: original.id, text: "Latest continuation answer" }]);
      expect(store.output(`${original.id}:answer`)).toMatchObject({ state: "sent", text: "Latest continuation answer" });
    } else {
      expect(messenger.sent).toEqual([]);
      expect(store.output(`${original.id}:answer`)).toBeNull();
    }
  });

  for (const stopReason of ["error", "aborted"] as const)
  test.each(["message_end", "agent_end-only"] as const)(`HEAD ${stopReason} clears retained text via %s`, async delivery => {
    const { runtime, main, store, messenger } = fixture();
    await runtime.start();
    const original = headMessage("retained-head-failure");
    await admit(runtime, original);
    const earlier = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Earlier successful yield" }] };
    main.emit({ type: "message_end", message: earlier });
    main.emit({ type: "prompt_result", id: main.prompts[0]!.id, status: "completed", agentInvoked: true, sessionSettled: false });
    await runtime.kick();
    main.emit({ type: "agent_start" });
    const terminal = { role: "assistant", stopReason, content: [], errorMessage: "Private provider diagnostics" };
    if (delivery === "message_end") main.emit({ type: "message_end", message: terminal });
    main.emit({ type: "agent_end", isTerminal: true, messages: [earlier, terminal] });
    main.state.isStreaming = false;
    main.state.isSettled = true;
    main.emit({ type: "session_settled" });
    await runtime.kick();
    expect(store.input(original.id)?.state).toBe(stopReason === "error" ? "uncertain" : "cancelled");
    expect(messenger.sent).toHaveLength(1);
    expect(messenger.sent[0]!.text).toContain(stopReason === "error" ? "실패" : "중단");
    expect(messenger.sent[0]!.text).not.toContain("Earlier successful yield");
    expect(messenger.sent[0]!.text).not.toContain("Private provider diagnostics");
    expect(store.output(`${original.id}:answer`)).toMatchObject({ state: "sent", text: messenger.sent[0]!.text });
  });

  test.each(["message_end", "agent_end-only"] as const)("HEAD retry success retains its answer through an empty terminal tail via %s", async delivery => {
    const { runtime, main, store, messenger } = fixture();
    await runtime.start();
    const original = headMessage("retained-head-retry");
    await admit(runtime, original);
    main.emit({ type: "message_end", message: { role: "assistant", stopReason: "error", content: [] } });
    main.emit({ type: "prompt_result", id: main.prompts[0]!.id, status: "error", agentInvoked: true, sessionSettled: false });
    await runtime.kick();
    main.emit({ type: "agent_start" });
    const messages = [
      { role: "assistant", stopReason: "error", content: [], errorMessage: "Private transient failure" },
      { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Verified retry answer" }] },
      { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "" }] },
    ];
    if (delivery === "message_end") for (const message of messages) main.emit({ type: "message_end", message });
    else main.emit({ type: "message_end", message: messages[0] });
    main.emit({ type: "agent_end", isTerminal: true, messages });
    main.state.isStreaming = false;
    main.state.isSettled = true;
    main.emit({ type: "session_settled" });
    await runtime.kick();
    expect(store.input(original.id)?.state).toBe("done");
    expect(messenger.sent).toMatchObject([{ sourceId: original.id, text: "Verified retry answer" }]);
    expect(store.output(`${original.id}:answer`)).toMatchObject({ state: "sent", text: "Verified retry answer" });
  });

  test.each(["error", "aborted"] as const)("a cumulative empty success cannot revive HEAD text cleared by %s", async stopReason => {
    const { runtime, main, store, messenger } = fixture();
    await runtime.start();
    const original = headMessage("retained-head-cleared");
    await admit(runtime, original);
    const earlier = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Cleared earlier answer" }] };
    main.emit({ type: "message_end", message: earlier });
    main.emit({ type: "message_end", message: { role: "assistant", stopReason, content: [] } });
    const empty = { role: "assistant", stopReason: "stop", content: [] };
    main.emit({ type: "message_end", message: empty });
    main.emit({ type: "agent_end", isTerminal: true, messages: [earlier, empty] });
    main.state.isStreaming = false;
    main.state.isSettled = true;
    main.emit({ type: "prompt_result", id: main.prompts[0]!.id, status: "completed", agentInvoked: true, sessionSettled: true });
    main.emit({ type: "session_settled" });
    await runtime.kick();
    expect(store.input(original.id)?.state).toBe("done");
    expect(store.output(`${original.id}:answer`)).toBeNull();
    expect(messenger.sent).toEqual([]);
  });

  test("local main commands cannot send a previous assistant answer", async () => {
    const { runtime, main, store, messenger } = fixture();
    await runtime.start();
    await admit(runtime, headMessage("local-prior-answer"));
    main.complete("Previous request answer");
    await runtime.kick();
    main.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "old unrelated secret" }] } });
    main.local = true;
    await admit(runtime, headMessage("120", route(null, { guildId: null }), "/local-command"));
    expect(store.input("120")?.state).toBe("done");
    expect(store.output("120:answer")).toBeNull();
    expect(messenger.sent).toMatchObject([{ sourceId: "local-prior-answer", text: "Previous request answer" }]);
  });

  test("pause persists before abort failure, pauses goal, cancels native children and stale approvals", async () => {
    const { runtime, store, config, hosts, messenger } = fixture();
    const lane = savedLane(store, config, "one", route("11"));
    await runtime.start();
    await delegate(runtime, message("130", lane.route));
    const host = hosts.get(lane.socketPath)!;
    host.children = [{ id: "child-a" }, { id: "child-b" }];
    host.state.goal = { enabled: true, mode: "active" };
    const dialog = { type: "extension_ui_request", method: "confirm", id: "dialog-1", title: "Allow?" };
    host.state.pendingUiRequests = [dialog];
    host.emit(dialog);
    await messenger.whenApproval();
    host.abortFails = true;
    await expect(runtime.pause(lane.id)).rejects.toThrow();
    expect(store.lane(lane.id)?.workState).toBe("paused");
    expect(host.commands.some(command => command.type === "goal" && command.op === "pause")).toBe(true);
    expect(host.cancelled).toEqual(["child-a", "child-b"]);
    expect(store.approvals(lane.id)).toEqual([]);
    expect(host.responses[0]).toMatchObject({ id: "dialog-1", response: { cancelled: true } });
    expect(delegated(store, "130")?.state).toBe("cancelled");
    host.complete("late success must not post");
    await runtime.kick();
    expect(messenger.sent).toEqual([]);
  });

  test("resume controls are settled without being sent as native prompts", async () => {
    const { runtime, store, config, hosts, messenger } = fixture();
    const lane = savedLane(store, config, "one", route("11"));
    store.updateLane(lane.id, 0, { workState: "paused" });
    await runtime.start();
    await admit(runtime, message("135", lane.route, "/resume"));
    await messenger.whenSent(1);
    expect(store.lane(lane.id)?.workState).toBe("open");
    expect(store.input("135")?.state).toBe("done");
    expect(hosts.get(lane.socketPath)?.prompts ?? []).toEqual([]);
    expect(messenger.sent).toHaveLength(1);
  });

  test.each(["queued", "pending-native", "submitted-native", "stale-generation", "missing-generation", "missing-owner"] as const)(
    "startup keeps a durable %s /resume out of HEAD and issues only a proven first native resume", async scenario => {
      const { runtime, store, config, hosts, main, messenger } = fixture();
      const lane = savedLane(store, config, "recover-resume", route("11"), process.pid);
      const other = savedLane(store, config, "other-resume", route("12"));
      const nativeStarted = scenario === "pending-native" || scenario === "submitted-native";
      // The live handler opens the lane before writing its native resume receipt.
      store.updateLane(lane.id, lane.generation, { workState: nativeStarted ? "open" : "paused" });
      store.updateLane(other.id, other.generation, { workState: "paused" });
      const worker = new HostTransport(lane.sessionFile, "session-recover-resume");
      worker.state.goal = { enabled: false, mode: "active", goal: { status: "paused" } };
      hosts.set(lane.socketPath, worker);
      const source = message("queued-resume", lane.route, "/resume");
      // Simulate a crash after durable intake but before the live control handler.
      store.receive(source, "main", {
        [`user-source:${source.id}`]: "true",
        ...(scenario === "missing-owner" ? {} : { [`topic-owner:${source.id}`]: lane.id }),
        ...(scenario === "missing-generation" ? {} : {
          [`topic-resume-generation:${source.id}`]: String(scenario === "stale-generation" ? lane.generation + 1 : lane.generation),
        }),
      });
      const receiptId = `resume:${source.id}:${lane.id}`;
      if (nativeStarted) {
        store.receive({ ...source, id: receiptId, text: "Resume the original objective." }, lane.id,
          { [`handoff-source:${receiptId}`]: source.id });
        if (scenario === "submitted-native") expect(store.submit(receiptId, "native-resume-original", lane.generation)).toBe(true);
      }

      await runtime.start();
      await messenger.whenSent(scenario === "submitted-native" ? 2 : 1);
      await runtime.kick();
      const firstNativeResume = scenario === "queued";
      expect(worker.commands.filter(command => command.type === "goal" && command.op === "resume"))
        .toHaveLength(firstNativeResume ? 1 : 0);
      expect(worker.state.goal?.goal?.status).toBe(firstNativeResume ? "active" : "paused");
      expect(store.lane(lane.id)?.workState).toBe(firstNativeResume || nativeStarted ? "open" : "paused");
      expect(store.lane(other.id)?.workState).toBe("paused");
      expect(store.input(source.id)?.state).toBe(scenario === "stale-generation" || scenario === "missing-generation" ? "cancelled"
        : nativeStarted ? "uncertain" : "done");
      expect(store.output(`${source.id}:control`)).toMatchObject({ sourceId: source.id, route: source.route, state: "sent" });
      if (scenario === "submitted-native") {
        expect(store.input(receiptId)).toMatchObject({ state: "uncertain", requestId: "native-resume-original", generation: lane.generation });
      }
      if (scenario === "pending-native") expect(store.input(receiptId)).toMatchObject({ state: "uncertain", requestId: null });
      await admit(runtime, source);
      expect(worker.commands.filter(command => command.type === "goal" && command.op === "resume"))
        .toHaveLength(firstNativeResume ? 1 : 0);
      expect(main.prompts).toEqual([]);
      expect(worker.prompts).toEqual([]);
      expect(messenger.sent.filter(output => output.id === `${source.id}:control`)).toHaveLength(1);
    });

  test("a recovered lane stop supersedes only earlier resume controls for its own lane", async () => {
    const { runtime, store, config, main, hosts, messenger } = fixture();
    const first = savedLane(store, config, "resume-stopped", route("11"), process.pid);
    const second = savedLane(store, config, "resume-unrelated", route("12"));
    store.updateLane(first.id, first.generation, { workState: "paused" });
    store.updateLane(second.id, second.generation, { workState: "paused" });
    const worker = new HostTransport(first.sessionFile, "session-resume-stopped");
    worker.state.goal = { enabled: false, mode: "active", goal: { status: "paused" } };
    hosts.set(first.socketPath, worker);
    const queueResume = (id: string, lane: Lane) => store.receive(message(id, lane.route, "/resume"), "main", {
      [`user-source:${id}`]: "true", [`topic-owner:${id}`]: lane.id, [`topic-resume-generation:${id}`]: String(lane.generation),
    });
    queueResume("resume-older", first);
    queueResume("resume-elsewhere", second);
    store.receive(message("stop-boundary-resume", first.route, "/stop"), "main", {
      "user-source:stop-boundary-resume": "true", "head:stop-target:stop-boundary-resume": JSON.stringify(first.id),
    });
    queueResume("resume-newer", first);

    await runtime.start();
    await messenger.whenSent(3);
    expect(store.input("resume-older")?.state).toBe("cancelled");
    expect(store.input("resume-elsewhere")?.state).toBe("done");
    expect(store.input("resume-newer")?.state).toBe("done");
    expect(store.input(`resume:resume-older:${first.id}`)).toBeNull();
    expect(store.input(`resume:resume-newer:${first.id}`)?.state).toBe("submitted");
    expect(worker.commands.filter(command => command.type === "goal" && command.op === "resume")).toHaveLength(1);
    expect(main.prompts).toEqual([]);
  });

  test("a resume admitted while the recovered stop awaits native cleanup cannot enter the fresh HEAD dispatch snapshot", async () => {
    const { runtime, store, config, main, hosts, messenger } = fixture();
    const lane = savedLane(store, config, "resume-during-stop", route("11"), process.pid);
    const worker = new HostTransport(lane.sessionFile, "session-resume-during-stop");
    worker.state.goal = { enabled: false, mode: "active", goal: { status: "paused" } };
    const stopping = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    worker.beforeAbort = async () => { stopping.resolve(); await release.promise; };
    hosts.set(lane.socketPath, worker);
    const stop = message("recovered-stop", lane.route, "/stop");
    store.receive(stop, "main", { [`user-source:${stop.id}`]: "true", [`head:stop-target:${stop.id}`]: JSON.stringify(lane.id) });

    const startup = runtime.start();
    await stopping.promise;
    const resume = message("resume-during-cleanup", lane.route, "/resume");
    try {
      await runtime.receive(resume);
      expect(store.input(resume.id)?.state).toBe("pending");
    } finally { release.resolve(); }

    await startup;
    await messenger.whenSent(2);
    await runtime.kick();
    expect(store.input(resume.id)?.state).toBe("done");
    expect(store.input(`resume:${resume.id}:${lane.id}`)?.state).toBe("submitted");
    expect(worker.commands.filter(command => command.type === "goal" && command.op === "resume")).toHaveLength(1);
    expect(main.prompts).toEqual([]);
    expect(worker.prompts).toEqual([]);
  });

  test("explicit resume owns a paused native goal's result without replaying the cancelled prompt", async () => {
    const { runtime, store, config, hosts, main, messenger } = fixture();
    const lane = savedLane(store, config, "goal-resume", route("11"));
    await runtime.start();
    await delegate(runtime, message("goal-original", lane.route));
    const host = hosts.get(lane.socketPath);
    if (!host) throw new Error("Expected the executing native lane");
    host.state.goal = { enabled: true, mode: "active", goal: { status: "active" } };
    await runtime.pause(lane.id);
    const source = message("goal-resume-source", lane.route, "/resume");
    await admit(runtime, source);
    expect(host.state.goal).toMatchObject({ enabled: true, goal: { status: "active" } });
    expect(host.prompts).toHaveLength(1);
    expect(store.input(`resume:${source.id}:${lane.id}`)?.state).toBe("submitted");
    expect(store.input(`handoff:goal-original:${lane.id}`)?.state).toBe("cancelled");
    host.state.goal = null;
    host.state.isStreaming = false;
    host.state.isSettled = true;
    host.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Resumed native objective verified" }], stopReason: "stop" } });
    host.emit({ type: "session_settled" });
    await messenger.whenSent(2);
    await runtime.kick();
    const resumeId = `resume:${source.id}:${lane.id}`;
    expect(store.input(resumeId)?.state).toBe("done");
    expect(store.input(`report:${resumeId}`)).toBeNull();
    expect(main.prompts).toEqual([]);
    expect(store.output(`${resumeId}:answer`)).toMatchObject({
      sourceId: source.id, route: source.route, text: "Resumed native objective verified", state: "sent",
    });
    expect(store.input(`report:handoff:goal-original:${lane.id}`)).toBeNull();
    expect(messenger.sent.filter(output => output.id === `${source.id}:control`)).toHaveLength(1);
  });

  test("native goal resume cannot bypass an uncertain earlier submission or an unconfirmed kickoff", async () => {
    for (const hold of ["uncertain", "kickoff"] as const) {
      const { runtime, store, config, hosts } = fixture();
      const lane = savedLane(store, config, `resume-${hold}`, route("11"));
      await runtime.start();
      await delegate(runtime, message(`original-${hold}`, lane.route));
      const host = hosts.get(lane.socketPath);
      if (!host) throw new Error("Expected the executing native lane");
      host.state.goal = { enabled: true, mode: "active", goal: { status: "active" } };
      await runtime.pause(lane.id);
      const held = message(`held-${hold}`, lane.route);
      store.receive(held, lane.id);
      if (hold === "uncertain") store.settle(held.id, "uncertain");
      else store.setMeta(`kickoff-output:${held.id}`, "unconfirmed-output");
      const source = message(`resume-${hold}`, lane.route);
      store.receive(source, "main");
      store.settle(source.id, "done");
      await expect(runtime.resume(lane.id, source.id)).rejects.toThrow("Resolve native work");
      expect(store.lane(lane.id)?.workState).toBe("paused");
      expect(host.state.goal?.goal?.status).toBe("paused");
      expect(host.commands.filter(command => command.type === "goal" && command.op === "resume")).toEqual([]);
    }
  });

  test("explicit resume restores an unloaded native goal without replaying an old input", async () => {
    const { runtime, store, config, hosts, launchBehavior, main } = fixture();
    const lane = savedLane(store, config, "unloaded-goal", route("11"));
    store.updateLane(lane.id, lane.generation, { workState: "paused" });
    mkdirSync(dirname(lane.sessionFile), { recursive: true });
    writeFileSync(lane.sessionFile, JSON.stringify({ type: "session", version: 3, id: "session-unloaded-goal", cwd: lane.cwd }) + "\n");
    launchBehavior.goal = { enabled: false, mode: "active", goal: { status: "paused" } };
    await runtime.start();
    const source = message("resume-unloaded-goal", lane.route);
    store.receive(source, "main");
    store.settle(source.id, "done");
    await runtime.resume(lane.id, source.id);
    const host = hosts.get(lane.socketPath);
    if (!host) throw new Error("Expected the restored native lane");
    expect(host.prompts).toEqual([]);
    expect(host.state.goal?.goal?.status).toBe("active");
    expect(store.lane(lane.id)?.workState).toBe("open");
    host.state.goal = null;
    host.state.isStreaming = false;
    host.state.isSettled = true;
    host.emit({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Restored objective verified" }] } });
    host.emit({ type: "session_settled" });
    await main.whenPrompts(1);
    expect(store.input(`report:resume:${source.id}:${lane.id}`)?.text).toContain("Restored objective verified");
  });

  test("one source can resume a goal and deliver its full correction and attachment idempotently", async () => {
    const downloads: Route[] = [];
    const { runtime, store, config, hosts, main } = fixture(3, async route => {
      downloads.push(route);
      return new Response("owner correction");
    });
    const lane = savedLane(store, config, "resume-correction", route("11"));
    await runtime.start();
    await delegate(runtime, message("original-correction", lane.route));
    const host = hosts.get(lane.socketPath);
    if (!host) throw new Error("Expected the executing native lane");
    host.state.goal = { enabled: true, mode: "active", goal: { status: "active" } };
    await runtime.pause(lane.id);
    const source: Inbound = { ...message("resume-correction-source", lane.route, "Resume, but apply this exact correction."),
      attachments: [{ id: "correction", name: "correction.txt", url: "adapter-file:correction", size: 16 }] };
    store.receive(source, "main");
    store.settle(source.id, "done");
    await runtime.resume(lane.id, source.id);
    await runtime.resume(lane.id, source.id);
    host.state.goal = null;
    host.state.isStreaming = false;
    host.state.isSettled = true;
    host.emit({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Resumed objective" }] } });
    host.emit({ type: "session_settled" });
    await main.whenPrompts(1);
    main.complete("Resume milestone received");
    await runtime.messageLane(lane.id, source.text, source.id);
    await runtime.messageLane(lane.id, source.text, source.id);
    expect(host.prompts).toHaveLength(2);
    expect(host.prompts[1]?.command.message).toContain(source.text);
    expect(store.input(`handoff:${source.id}:${lane.id}`)?.attachments).toEqual(source.attachments);
    expect(downloads).toEqual([source.route]);
    expect(host.commands.filter(command => command.type === "goal" && command.op === "resume")).toHaveLength(1);
    host.complete("Correction applied");
    await main.whenPrompts(2);
    expect(store.input(`resume:${source.id}:${lane.id}`)?.state).toBe("done");
    expect(store.input(`handoff:${source.id}:${lane.id}`)?.state).toBe("done");
  });

  test("a source-authorized resume reopens a completed unloaded conversation before forwarding work", async () => {
    const { runtime, store, config, hosts } = fixture();
    const lane = savedLane(store, config, "completed-unloaded", route("11"));
    store.updateLane(lane.id, lane.generation, { workState: "completed" });
    mkdirSync(dirname(lane.sessionFile), { recursive: true });
    writeFileSync(lane.sessionFile, JSON.stringify({ type: "session", version: 3, id: "session-completed-unloaded", cwd: lane.cwd }) + "\n");
    await runtime.start();
    const source = message("reopen-completed-source", lane.route, "Continue the existing conversation.");
    store.receive(source, "main");
    store.settle(source.id, "done");
    await runtime.resume(lane.id, source.id);
    expect(store.lane(lane.id)).toMatchObject({ workState: "open", model: lane.model, sessionFile: lane.sessionFile });
    await runtime.messageLane(lane.id, source.text, source.id);
    const host = hosts.get(lane.socketPath);
    if (!host) throw new Error("Expected the restored native conversation");
    expect(host.prompts).toHaveLength(1);
    expect(host.prompts[0]?.command.message).toContain(source.text);
    expect(host.commands.filter(command => command.type === "goal" && command.op === "resume")).toEqual([]);
  });

  for (const outcome of ["error", "aborted", "no-run"] as const) {
    test(`native resume ${outcome} is not a completed objective`, async () => {
      const { runtime, store, config, hosts, main } = fixture();
      const lane = savedLane(store, config, `goal-${outcome}`, route("11"));
      await runtime.start();
      await delegate(runtime, message(`original-${outcome}`, lane.route));
      const host = hosts.get(lane.socketPath);
      if (!host) throw new Error("Expected the executing native lane");
      host.state.goal = { enabled: true, mode: "active", goal: { status: "active" } };
      await runtime.pause(lane.id);
      const source = message(`resume-${outcome}`, lane.route);
      store.receive(source, "main");
      store.settle(source.id, "done");
      host.goalResumeRuns = outcome !== "no-run";
      await runtime.resume(lane.id, source.id);
      if (outcome !== "no-run") {
        host.state.isSettled = true;
        host.state.isStreaming = false;
        host.emit({ type: "agent_end", messages: [{
          role: "assistant", stopReason: outcome, content: [{ type: "text", text: "Unverified success" }],
        }] });
        host.emit({ type: "session_settled" });
      }
      await main.whenPrompts(1);
      expect(store.input(`resume:${source.id}:${lane.id}`)?.state).toBe(outcome === "aborted" ? "cancelled" : "uncertain");
      expect(store.input(`report:resume:${source.id}:${lane.id}`)?.text).not.toContain("Unverified success");
      expect(host.prompts).toHaveLength(1);
    });
  }

  test("a later pause supersedes a resume waiting for native model readiness", async () => {
    const { runtime, store, config, hosts, main } = fixture();
    const lane = savedLane(store, config, "resume-readiness-race", route("11"));
    await runtime.start();
    await delegate(runtime, message("original-readiness-race", lane.route));
    const host = hosts.get(lane.socketPath);
    if (!host) throw new Error("Expected the executing native lane");
    host.state.goal = { enabled: true, mode: "active", goal: { status: "active" } };
    await runtime.pause(lane.id);
    const source = message("resume-readiness-race", lane.route);
    store.receive(source, "main");
    store.settle(source.id, "done");
    const checking = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    main.beforeCatalog = async () => { checking.resolve(); await release.promise; };
    const resumed = runtime.resume(lane.id, source.id).then(() => null, (error: unknown) => error);
    await checking.promise;
    await runtime.pause(lane.id);
    release.resolve();
    expect(await resumed).toMatchObject({ message: "A later pause superseded this resume" });
    expect(store.lane(lane.id)?.workState).toBe("paused");
    expect(host.commands.filter(command => command.type === "goal" && command.op === "resume")).toEqual([]);
    expect(store.input(`resume:${source.id}:${lane.id}`)).toBeNull();
  });

  test("a late native resume acknowledgement cannot restore an admission cancelled by a newer pause", async () => {
    const { runtime, store, config, hosts, main } = fixture();
    const lane = savedLane(store, config, "resume-ack-race", route("11"));
    await runtime.start();
    await delegate(runtime, message("original-ack-race", lane.route));
    const host = hosts.get(lane.socketPath);
    if (!host) throw new Error("Expected the executing native lane");
    host.state.goal = { enabled: true, mode: "active", goal: { status: "active" } };
    await runtime.pause(lane.id);
    const source = message("resume-ack-race", lane.route);
    store.receive(source, "main");
    store.settle(source.id, "done");
    const accepted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    host.beforeGoalResume = async () => { accepted.resolve(); await release.promise; };
    const resumed = runtime.resume(lane.id, source.id);
    await accepted.promise;
    await runtime.pause(lane.id);
    release.resolve();
    await resumed;
    host.emit({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Late output" }] }] });
    host.emit({ type: "session_settled" });
    await runtime.kick();
    expect(store.input(`resume:${source.id}:${lane.id}`)?.state).toBe("cancelled");
    expect(store.input(`report:resume:${source.id}:${lane.id}`)).toBeNull();
    expect(store.lane(lane.id)?.workState).toBe("paused");
    expect(main.prompts).toEqual([]);
  });

  test("restart enforces persisted pause without reopening cancelled work", async () => {
    const { runtime, store, config, hosts } = fixture();
    const lane = savedLane(store, config, "one", route("11"), process.pid);
    store.updateLane(lane.id, 0, { workState: "cancelled" });
    const host = new HostTransport(lane.sessionFile, "session-one");
    host.state.isStreaming = true;
    host.state.isSettled = false;
    host.state.goal = { enabled: true };
    host.children = [{ id: "old-child" }];
    hosts.set(lane.socketPath, host);
    await runtime.start();
    expect(store.lane(lane.id)?.workState).toBe("cancelled");
    expect(host.state.isStreaming).toBe(false);
    expect(host.cancelled).toEqual(["old-child"]);
    await expect(runtime.resume(lane.id)).rejects.toThrow("Cancelled");
  });

  async function ownerDecision() {
    const f = fixture();
    await f.runtime.start();
    await admit(f.runtime, headMessage("decision-source"));
    const id = decisionId(f.main.state.sessionId, "decision-call");
    const frame = { type: "extension_ui_request", method: "ask", id: "decision-native",
      questions: [{ id: `${id}:0`, question: "Which database?", options: [{ label: "SQLite" }, { label: "Redis" }], recommended: 0 }] };
    f.main.state.pendingUiRequests = [frame];
    f.main.emit(frame);
    await f.messenger.whenApproval();
    await f.messenger.handlers!.reconnect!();
    const approval = [...f.messenger.shown.values()][0]!;
    return { ...f, id, frame, approval, response: { answers: [{ id: `${id}:0`, selectedOptions: ["Redis"] }] } };
  }

  async function laneDecision() {
    const f = fixture();
    const destination = route("42");
    const lane = savedLane(f.store, f.config, "choice-lane", destination);
    const task = "Implement the fixture; choose a reversible local cache layout.";
    const source = headMessage("lane-choice-owner", destination, task);
    await f.runtime.start();
    await admit(f.runtime, source);
    await f.runtime.messageLane(lane.id, task, source.id);
    await f.runtime.kick();
    const host = f.hosts.get(lane.socketPath);
    if (!host) throw new Error("Lane native Host was not launched");
    const decision = decisionId(host.state.sessionId, "lane-choice-call");
    const frame = { type: "extension_ui_request", method: "ask", id: "lane-choice-native",
      questions: [{ id: `${decision}:0`, question: "Which local cache layout?", options: [{ label: "Flat" }, { label: "Nested" }] }] };
    host.state.pendingUiRequests = [frame];
    host.emit(frame);
    f.main.complete("");
    await f.main.whenPrompts(2);
    const approval = f.runtime.inspectDecision(decision);
    return { ...f, source, host, decision, frame, approval, lane, answers: [{ id: `${decision}:0`, selectedOptions: ["Flat"] }] };
  }

  test("HEAD answers the exact routine lane choice without a card, progress message, or separate result", async () => {
    const f = await laneDecision();
    expect(f.messenger.shown.size).toBe(0);
    await expect(f.messenger.handlers!.answer(f.approval.approvalId, { answers: f.answers }, f.source.route)).rejects.toMatchObject({ certainty: "rejected" });
    await expect(f.runtime.reviewLaneDecision({ id: f.decision, reason: "Local and reversible",
      answers: [{ ...f.answers[0]!, selectedOptions: ["Invented"] }] })).rejects.toMatchObject({ certainty: "rejected" });
    expect(f.host.responses).toEqual([]);

    f.main.emit({ type: "message_end", message: { role: "assistant", stopReason: "toolUse", content: [
      { type: "text", text: "Internal review in progress" },
      { type: "toolCall", id: "choose", name: "lane_review_decision", arguments: {} },
    ] } });
    const selected = await f.runtime.reviewLaneDecision({ id: f.decision, reason: "Local and reversible", answers: f.answers });
    f.main.complete("Internal review result");
    await admit(f.runtime, headMessage("after-choice", f.source.route));
    await f.main.whenPrompts(3);
    await f.runtime.kick();
    expect(selected).toMatchObject({ state: "answered", headSelection: { reason: "Local and reversible" }, response: { answers: f.answers } });
    expect(f.host.responses).toEqual([{ id: f.frame.id, response: { answers: f.answers } }]);
    expect(f.messenger.attempted).toEqual([]);
    expect(f.messenger.shown.size).toBe(0);
  });

  test("HEAD escalation opens the original lane question and leaves its answer to the owner", async () => {
    const f = await laneDecision();
    const duplicate = { ...f.frame, id: "head-duplicate-question" };
    f.main.state.pendingUiRequests = [duplicate];
    f.main.emit(duplicate);
    await f.runtime.kick();
    expect(f.main.responses).toEqual([{ id: duplicate.id, response: { cancelled: true } }]);
    expect(f.messenger.shown.size).toBe(0);

    const escalated = await f.runtime.reviewLaneDecision({ id: f.decision, reason: "Requires an owner commitment" });
    expect(escalated).toMatchObject({ state: "pending", requestId: f.frame.id, remoteId: `card-${f.approval.approvalId}` });
    expect(f.messenger.shown.get(f.approval.approvalId)).toMatchObject({
      route: f.source.route, request: f.frame, ownerContext: "Requires an owner commitment",
    });
    expect(f.host.responses).toEqual([]);
    await f.messenger.handlers!.reconnect!();
    expect(f.messenger.shown.get(f.approval.approvalId)).toMatchObject({
      remoteId: escalated.remoteId, request: f.frame, ownerContext: "Requires an owner commitment",
    });
    await expect(f.runtime.reviewLaneDecision({ id: f.decision, reason: "Trying to bypass the owner", answers: f.answers })).rejects.toThrow("original pending lane choice");

    await f.messenger.handlers!.answer(f.approval.approvalId, { answers: f.answers }, f.source.route);
    expect(f.host.responses).toEqual([{ id: f.frame.id, response: { answers: f.answers } }]);
    expect(f.runtime.inspectDecision(f.decision).headSelection).toBeUndefined();
    expect(f.messenger.sent).toEqual([]);
  });

  test("unclassified lane selects still go to the operator and cannot be answered by HEAD", async () => {
    const f = fixture();
    const lane = savedLane(f.store, f.config, "approval-lane", route("44"), process.pid);
    const host = new HostTransport(lane.sessionFile, "session-approval-lane");
    const frame = { type: "extension_ui_request", method: "select", id: "execution-approval", title: "Allow external action?",
      options: ["Approve", "Deny"] };
    host.state.pendingUiRequests = [frame];
    f.hosts.set(lane.socketPath, host);
    await f.runtime.start();
    await f.messenger.whenApproval();
    expect(f.messenger.shown.size).toBe(1);
    expect(f.main.prompts).toEqual([]);
    expect(f.runtime.listDecisions()).toEqual([]);
    expect(host.responses).toEqual([]);
  });

  test.each(["report", "progress"])("a decision raised from %s retains the original owner source through activity and handoff links", async kind => {
    const { runtime, store, main, messenger } = fixture();
    await runtime.start();
    store.receive(message("owner-source"), "main", { "user-source:owner-source": "true" });
    store.settle("owner-source", "done");
    store.receive(message("handoff-source"), "main", { "handoff-source:handoff-source": "owner-source" });
    store.settle("handoff-source", "done");
    const synthetic = `${kind}:handoff-source`;
    store.receive(message(synthetic), "main", { [`activity-source:${synthetic}`]: "handoff-source" });
    await runtime.kick();
    const id = decisionId(main.state.sessionId, `${kind}-decision`);
    const frame = { type: "extension_ui_request", method: "ask", id: `${kind}-question`,
      questions: [{ id: `${id}:0`, question: "Which scope?", options: [{ label: "Local" }] }] };
    main.state.pendingUiRequests = [frame];
    main.emit(frame);
    await messenger.whenApproval();
    await messenger.handlers!.reconnect!();
    expect(runtime.inspectDecision(id).sourceId).toBe("owner-source");
    const withdrawn = await runtime.withdrawDecision(id, runtime.inspectDecision(id).sourceId!, "Owner changed the requirement");
    expect(withdrawn).toMatchObject({ state: "withdrawn", withdrawal: { sourceId: "owner-source" } });
    expect(main.responses).toEqual([{ id: frame.id, response: { cancelled: true } }]);
  });

  test("owner decisions use the existing authenticated card and preserve answers without duplicate delivery", async () => {
    const { runtime, messenger, main, id, frame, approval, response, store } = await ownerDecision();
    expect(runtime.listDecisions()).toMatchObject([{ id, state: "pending", sourceId: "decision-source", target: "main",
      requestId: frame.id, route: route(), remoteId: `card-${approval.id}`,
      questions: [{ question: "Which database?", recommended: 0 }] }]);
    await expect(messenger.handlers!.answer(approval.id, response, route("foreign"))).rejects.toMatchObject({ certainty: "rejected" });
    expect(runtime.inspectDecision(id).state).toBe("pending");
    expect(main.responses).toEqual([]);
    await messenger.handlers!.answer(approval.id, response, route());
    expect(runtime.listDecisions()).toEqual([]);
    expect(runtime.listDecisions("all", "main")).toMatchObject([{ id, state: "answered", response }]);
    expect(main.responses).toEqual([{ id: frame.id, response }]);
    await expect(messenger.handlers!.answer(approval.id, response, route())).rejects.toMatchObject({ certainty: "rejected" });
    main.emit(frame);
    await messenger.handlers!.reconnect!();
    expect(main.responses).toHaveLength(1);
    expect(messenger.shown.size).toBe(1);
    expect(store.outputs()).toEqual([]);
  });

  test("lost decision answer acknowledgement remains held until exact native reconciliation, never defaults or replays", async () => {
    const { runtime, messenger, main, id, approval, response } = await ownerDecision();
    main.uiAcknowledges = false;
    await expect(messenger.handlers!.answer(approval.id, response, route())).rejects.toMatchObject({ certainty: "uncertain" });
    expect(runtime.inspectDecision(id)).toMatchObject({ state: "answering", response });
    expect(await messenger.handlers!.reconcileAnswer!(approval.id, route())).toBe("unresolved");
    await expect(runtime.withdrawDecision(id, "decision-source", "Changed mind")).rejects.toThrow("unresolved");
    await messenger.handlers!.reconnect!();
    expect(runtime.inspectDecision(id).state).toBe("answering");
    expect(main.responses).toHaveLength(1);
    main.state.pendingUiRequests = [];
    expect(await messenger.handlers!.reconcileAnswer!(approval.id, route())).toBe("accepted");
    expect(runtime.inspectDecision(id)).toMatchObject({ state: "answered", response });
    expect(main.responses).toHaveLength(1);
  });

  test("decision withdrawal needs an original same-conversation owner source and cancels only the original question", async () => {
    const { runtime, messenger, main, id, frame, approval, response, store } = await ownerDecision();
    store.receive(message("internal-data"), "main");
    await expect(runtime.withdrawDecision(id, "internal-data", "Reported by a worker")).rejects.toThrow("original active owner");
    store.receive(message("foreign-owner-source", route("foreign")), "main", { "user-source:foreign-owner-source": "true" });
    await expect(runtime.withdrawDecision(id, "foreign-owner-source", "Another topic")).rejects.toThrow("another conversation");
    const result = await runtime.withdrawDecision(id, "decision-source", "The original requirement was withdrawn");
    expect(result).toMatchObject({ state: "withdrawn", confirmedAt: expect.any(Number),
      withdrawal: { sourceId: "decision-source", reason: "The original requirement was withdrawn" } });
    expect(result.response).toBeUndefined();
    expect(runtime.listDecisions()).toEqual([]);
    expect(main.responses).toEqual([{ id: frame.id, response: { cancelled: true } }]);
    await expect(messenger.handlers!.answer(approval.id, response, route())).rejects.toMatchObject({ certainty: "rejected" });
    await expect(runtime.withdrawDecision(id, "decision-source", "Duplicate withdrawal")).rejects.toThrow("already settled");
    expect(main.responses).toHaveLength(1);
    expect(messenger.dismissed).toContain(approval.id);
  });

  test("native decision cancellation removes the pending decision without recording a recommendation as consent", async () => {
    const { runtime, messenger, main, id, frame } = await ownerDecision();
    main.state.pendingUiRequests = [];
    main.emit({ type: "extension_ui_request", method: "cancel", targetId: frame.id });
    await messenger.handlers!.reconnect!();
    expect(runtime.inspectDecision(id)).toMatchObject({ state: "withdrawn" });
    expect(runtime.inspectDecision(id).response).toBeUndefined();
    expect(runtime.listDecisions()).toEqual([]);
    expect(main.responses).toEqual([]);
  });

  test("reconnect UI replay rehydrates one durable card and accepts only one native answer", async () => {
    const { runtime, store, config, hosts, messenger } = fixture();
    const lane = savedLane(store, config, "one", route("11"), process.pid);
    const host = new HostTransport(lane.sessionFile, "session-one");
    const frame = { type: "extension_ui_request", method: "confirm", id: "native-dialog", title: "Allow?" };
    host.state.pendingUiRequests = [frame];
    hosts.set(lane.socketPath, host);
    const id = `a-${createHash("sha256").update("one:0:native-dialog").digest("hex").slice(0, 24)}`;
    store.putApproval({
      id, target: lane.id, generation: 0, requestId: frame.id, route: lane.route,
      request: frame, state: "pending", remoteId: "existing-card",
    });
    await runtime.start();
    host.emit(frame);
    await messenger.whenApproval();
    expect(messenger.shown.size).toBe(1);
    expect(store.approval(id)?.remoteId).toBe("existing-card");
    messenger.shown.clear(); // An independently restarted Gateway lost its cache.
    await messenger.handlers!.reconnect!();
    expect(messenger.shown.size).toBe(1);
    expect(messenger.shown.get(id)).toMatchObject({ target: lane.id, generation: 0, requestId: frame.id, remoteId: "existing-card", route: lane.route });
    expect(host.responses).toEqual([]);
    expect(messenger.sent).toEqual([]);
    await messenger.handlers!.answer(id, { confirmed: true }, lane.route);
    await expect(messenger.handlers!.answer(id, { confirmed: true }, lane.route)).rejects.toThrow();
    expect(host.responses.filter(response => response.response.confirmed)).toHaveLength(1);
    expect(store.approval(id)?.state).toBe("answered");
  });

  test("answer replay reconciles the exact pending native dialog before allowing one retry", async () => {
    const { runtime, store, config, hosts, messenger } = fixture();
    const lane = savedLane(store, config, "answer-retry", route("answer-retry"), process.pid);
    const host = new HostTransport(lane.sessionFile, "session-answer-retry");
    const frame = { type: "extension_ui_request", method: "confirm", id: "retry-dialog", title: "Allow?" };
    host.state.pendingUiRequests = [frame];
    hosts.set(lane.socketPath, host);
    const id = `a-${createHash("sha256").update(`${lane.id}:0:${frame.id}`).digest("hex").slice(0, 24)}`;
    store.putApproval({ id, target: lane.id, generation: 0, requestId: frame.id, route: lane.route, request: frame, state: "pending", remoteId: "original-retry-card" });
    await runtime.start();
    expect(await messenger.handlers!.reconcileAnswer!(id, lane.route)).toBe("retry");
    expect(host.responses).toEqual([]);
    await messenger.handlers!.answer(id, { confirmed: true }, lane.route);
    expect(await messenger.handlers!.reconcileAnswer!(id, lane.route)).toBe("accepted");
    expect(host.responses).toEqual([{ id: frame.id, response: { confirmed: true } }]);
    await expect(messenger.handlers!.answer(id, { confirmed: true }, lane.route)).rejects.toMatchObject({ certainty: "rejected" });
    expect(host.responses).toHaveLength(1);
  });

  test("attempted native approval with lost acknowledgement remains unresolved without response or cancellation replay", async () => {
    const { runtime, store, config, hosts, messenger } = fixture();
    const lane = savedLane(store, config, "answer-uncertain", route("answer-uncertain"), process.pid);
    const host = new HostTransport(lane.sessionFile, "session-answer-uncertain");
    const frame = { type: "extension_ui_request", method: "confirm", id: "uncertain-dialog", title: "Allow?" };
    host.state.pendingUiRequests = [frame];
    host.uiAcknowledges = false;
    hosts.set(lane.socketPath, host);
    const id = `a-${createHash("sha256").update(`${lane.id}:0:${frame.id}`).digest("hex").slice(0, 24)}`;
    store.putApproval({ id, target: lane.id, generation: 0, requestId: frame.id, route: lane.route, request: frame, state: "pending", remoteId: "original-uncertain-card" });
    await runtime.start();
    await expect(messenger.handlers!.answer(id, { confirmed: true }, lane.route)).rejects.toMatchObject({ certainty: "uncertain" });
    expect(store.approval(id)?.state).toBe("answered");
    expect(await messenger.handlers!.reconcileAnswer!(id, lane.route)).toBe("unresolved");
    host.emit(frame);
    await messenger.handlers!.reconnect!();
    expect(host.responses).toEqual([{ id: frame.id, response: { confirmed: true } }]);
    expect(await messenger.handlers!.reconcileAnswer!(id, lane.route)).toBe("unresolved");
    host.state.pendingUiRequests = []; // Actual native acceptance is eventually observable.
    expect(await messenger.handlers!.reconcileAnswer!(id, lane.route)).toBe("accepted");
    expect(host.responses).toHaveLength(1);
  });

  test("approval replay distinguishes stale identity from unavailable exact native evidence", async () => {
    const { runtime, store, config, hosts, messenger } = fixture();
    const lane = savedLane(store, config, "answer-identity", route("answer-identity"), process.pid);
    const host = new HostTransport(lane.sessionFile, "session-answer-identity");
    const frame = { type: "extension_ui_request", method: "confirm", id: "identity-dialog", title: "Allow?" };
    host.state.pendingUiRequests = [frame];
    hosts.set(lane.socketPath, host);
    const id = `a-${createHash("sha256").update(`${lane.id}:0:${frame.id}`).digest("hex").slice(0, 24)}`;
    store.putApproval({ id, target: lane.id, generation: 0, requestId: frame.id, route: lane.route, request: frame, state: "pending", remoteId: "identity-card" });
    await runtime.start();
    expect(await messenger.handlers!.reconcileAnswer!(id, { ...lane.route, threadId: "foreign-thread" })).toBe("rejected");
    host.state.pendingUiRequests = [{ ...frame, title: "Different native dialog" }];
    expect(await messenger.handlers!.reconcileAnswer!(id, lane.route)).toBe("rejected");
    host.state.pendingUiRequests = [frame];
    const getState = host.client.getState;
    host.client.getState = async () => { throw new Error("Native inventory unavailable"); };
    expect(await messenger.handlers!.reconcileAnswer!(id, lane.route)).toBe("unresolved");
    host.client.getState = getState;
    hosts.delete(lane.socketPath);
    await host.close();
    expect(await messenger.handlers!.reconcileAnswer!(id, lane.route)).toBe("unresolved");
    store.nextGeneration(lane.id);
    expect(await messenger.handlers!.reconcileAnswer!(id, lane.route)).toBe("rejected");
    expect(host.responses).toEqual([]);
  });

  test("fresh-head reconciliation preserves answered-but-native-pending requests without implicit cancel", async () => {
    const { runtime, store, config, hosts, messenger } = fixture();
    const lane = savedLane(store, config, "answered-restart", route("answered-restart"), process.pid);
    const host = new HostTransport(lane.sessionFile, "session-answered-restart");
    const frame = { type: "extension_ui_request", method: "confirm", id: "answered-restart-dialog", title: "Allow?" };
    host.state.pendingUiRequests = [frame];
    hosts.set(lane.socketPath, host);
    const id = `a-${createHash("sha256").update(`${lane.id}:0:${frame.id}`).digest("hex").slice(0, 24)}`;
    store.putApproval({ id, target: lane.id, generation: 0, requestId: frame.id, route: lane.route, request: frame, state: "pending", remoteId: "answered-card" });
    store.resolveApproval(id, 0, "answered");
    await runtime.start();
    expect(host.responses).toEqual([]);
    expect(messenger.shown.size).toBe(0);
    expect(await messenger.handlers!.reconcileAnswer!(id, lane.route)).toBe("unresolved");
    expect(host.responses).toEqual([]);
  });

  test("queued startup approval waits until the original native inventory and card are restored", async () => {
    const { runtime, store, config, hosts, main, messenger } = fixture();
    const lane = savedLane(store, config, "one", route("11"), process.pid);
    const host = new HostTransport(lane.sessionFile, "session-one");
    const frame = { type: "extension_ui_request", method: "confirm", id: "queued-native-dialog", title: "Allow?" };
    host.state.pendingUiRequests = [frame];
    hosts.set(lane.socketPath, host);
    const id = `a-${createHash("sha256").update("one:0:queued-native-dialog").digest("hex").slice(0, 24)}`;
    store.putApproval({ id, target: lane.id, generation: 0, requestId: frame.id, route: lane.route, request: frame, state: "pending", remoteId: "original-card" });
    const inventory = Promise.withResolvers<RuntimeState>();
    const intakeStarted = Promise.withResolvers<void>();
    main.client.getState = async () => inventory.promise;
    let queued: Promise<void> | undefined;
    messenger.onStart = handlers => {
      queued = handlers.answer(id, { confirmed: true }, lane.route);
      void queued.catch(() => {});
      intakeStarted.resolve();
    };
    const starting = runtime.start();
    await intakeStarted.promise;
    expect(messenger.shown.size).toBe(0);
    expect(host.responses).toEqual([]);
    expect(store.approval(id)?.state).toBe("pending");
    inventory.resolve(structuredClone(main.state));
    await starting;
    await queued;
    expect(messenger.shown.get(id)?.remoteId).toBe("original-card");
    expect(messenger.shown.size).toBe(1);
    expect(store.approval(id)).toMatchObject({ state: "answered", requestId: frame.id, remoteId: "original-card" });
    expect(host.responses).toEqual([{ id: frame.id, response: { confirmed: true } }]);
  });

  test("startup failure rejects queued intake before closing the store and post-stop handlers remain fenced", async () => {
    const { runtime, config, directory, hosts, messenger } = fixture();
    hosts.delete(hostPaths(config, "main").socketPath);
    const destination = route(null, { guildId: null });
    let captured: Handlers | undefined;
    let queuedMessage: Promise<void> | undefined;
    let queuedAnswer: Promise<void> | undefined;
    messenger.onStart = handlers => {
      captured = handlers;
      queuedMessage = handlers.message(message("queued-on-failure", destination));
      queuedAnswer = handlers.answer("unrestored-card", { confirmed: true }, destination);
      void queuedMessage.catch(() => {});
      void queuedAnswer.catch(() => {});
    };
    await expect(runtime.start()).rejects.toThrow("No native host");
    await expect(queuedMessage!).rejects.toThrow("stopped before intake readiness");
    await expect(queuedAnswer!).rejects.toThrow("stopped before intake readiness");
    await expect(captured!.ready!).rejects.toThrow("stopped before intake readiness");
    await expect(captured!.message(message("after-stop", destination))).rejects.toThrow("stopped");
    await expect(runtime.receive(message("direct-after-stop", destination))).rejects.toThrow("stopped");
    const reopened = new Store(join(directory, "coordination.sqlite"));
    try { expect(reopened.inputs()).toEqual([]); }
    finally { reopened.close(); }
  });

  test("stop cancels a closed startup barrier without waiting for incomplete host inventory", async () => {
    const { runtime, main, messenger } = fixture();
    const inventory = Promise.withResolvers<RuntimeState>();
    const intakeStarted = Promise.withResolvers<void>();
    main.client.getState = async () => inventory.promise;
    let captured: Handlers | undefined;
    let queued: Promise<void> | undefined;
    messenger.onStart = handlers => {
      captured = handlers;
      queued = handlers.message(message("queued-on-stop", route(null, { guildId: null })));
      void queued.catch(() => {});
      intakeStarted.resolve();
    };
    const starting = runtime.start();
    void starting.catch(() => {});
    await intakeStarted.promise;
    await runtime.stop();
    await expect(queued!).rejects.toThrow("stopped before intake readiness");
    await expect(captured!.ready!).rejects.toThrow("stopped before intake readiness");
    inventory.resolve(structuredClone(main.state));
    await expect(starting).rejects.toThrow("stopped");
  });

  test("handlers with an already opened readiness gate cannot access a store after shutdown", async () => {
    const { runtime, messenger } = fixture();
    const destination = route(null, { guildId: null });
    await runtime.start();
    const handlers = messenger.handlers!;
    await handlers.ready;
    await runtime.stop();
    await expect(handlers.message(message("after-ready-stop", destination))).rejects.toThrow("Controller is stopped");
    await expect(handlers.answer("old-card", { confirmed: true }, destination)).rejects.toThrow("Controller is stopped");
  });

  test("connection loss gets one identity-checked reconnect, quarantines old request, and never replays it", async () => {
    const { runtime, store, main, hosts, config, messenger, launched } = fixture();
    await runtime.start();
    await admit(runtime, headMessage("138", route(null, { guildId: null })));
    const replacement = new HostTransport(main.state.sessionFile!, main.state.sessionId);
    replacement.state.isSettled = false;
    replacement.state.isStreaming = true;
    hosts.set(hostPaths(config, "main").socketPath, replacement);
    await main.close();
    await messenger.whenSent(1);
    await runtime.kick();
    expect(store.input("138")?.state).toBe("uncertain");
    expect(replacement.prompts).toEqual([]);
    expect(launched).toEqual([]);
  });

  test("obsolete generation callbacks cannot settle or publish an old native request", async () => {
    const { runtime, store, config, hosts, messenger } = fixture();
    const lane = savedLane(store, config, "one", route("11"));
    await runtime.start();
    await delegate(runtime, message("139", lane.route));
    const host = hosts.get(lane.socketPath)!;
    store.nextGeneration(lane.id);
    host.complete("stale callback");
    await runtime.kick();
    expect(delegated(store, "139")?.state).toBe("submitted");
    expect(messenger.sent).toEqual([]);
  });

  test("unknown submitted work is quarantined on restart without prompt replay or killing the live lane", async () => {
    const { runtime, store, config, hosts, launched, messenger } = fixture();
    const lane = savedLane(store, config, "one", route("11"), process.pid);
    const host = new HostTransport(lane.sessionFile, "session-one");
    host.state.isSettled = false;
    host.state.isStreaming = true;
    hosts.set(lane.socketPath, host);
    store.receive(message("140", lane.route), lane.id);
    store.submit("140", "previous-native-id", 0);
    await runtime.start();
    expect(store.input("140")?.state).toBe("uncertain");
    expect(host.prompts).toEqual([]);
    expect(launched).toEqual([]);
    expect(store.lane(lane.id)).toMatchObject({ generation: 0, pid: process.pid, runtimeState: "running" });
    expect(messenger.sent).toEqual([]);
    expect(store.input("report:140")).toMatchObject({ target: "main", route: lane.route });
    expect(store.input("report:140")?.text).toContain("native outcome: uncertain");
  });

  test("native shutdown denial preserves host ownership and blocks capacity reuse", async () => {
    const { runtime, store, config, hosts, launched } = fixture(2);
    const one = savedLane(store, config, "one", route("11"), process.pid);
    const two = savedLane(store, config, "two", route("12"));
    const host = new HostTransport(one.sessionFile, "session-one");
    host.shutdownAllowed = false;
    hosts.set(one.socketPath, host);
    await runtime.start();
    await delegate(runtime, message("150", two.route));
    expect(host.commands.some(command => command.type === "shutdown_host")).toBe(true);
    expect(launched).toEqual([]);
    expect(store.lane(one.id)?.pid).toBe(process.pid);
    expect(delegated(store, "150")?.state).toBe("pending");
  });

  test("restart and explicit resume keep later lane inputs behind an unresolved original submission", async () => {
    const { runtime, store, config, hosts } = fixture();
    const lane = savedLane(store, config, "uncertain-order", route("uncertain-order"), process.pid);
    const host = new HostTransport(lane.sessionFile, "session-uncertain-order");
    hosts.set(lane.socketPath, host);
    store.receive(message("ambiguous-first", lane.route), lane.id);
    store.submit("ambiguous-first", "original-native-receipt", 0);
    store.receive(message("pending-later", lane.route), lane.id);
    await runtime.start();
    expect(store.input("ambiguous-first")?.state).toBe("uncertain");
    expect(store.input("pending-later")?.state).toBe("pending");
    expect(host.prompts).toEqual([]);
    await runtime.resume(lane.id);
    await runtime.kick();
    expect(store.input("pending-later")?.state).toBe("pending");
    expect(host.prompts).toEqual([]);
    store.settle("ambiguous-first", "done"); // Explicit resolution, not pause/resume.
    await runtime.kick();
    expect(host.prompts).toHaveLength(1);
    expect(host.prompts[0]!.command.message).toContain("Request ID: pending-later");
  });

  test("a reattached lane reports held follow-ups until the owner resolves the exact input in its topic", async () => {
    const { runtime, store, config, hosts, launched, messenger, main } = fixture();
    const lane = savedLane(store, config, "survivor", route("11"), process.pid);
    const other = savedLane(store, config, "unrelated", route("12"));
    const host = new HostTransport(lane.sessionFile, "session-survivor");
    hosts.set(lane.socketPath, host);
    store.receive(message("original-lane-input", lane.route), lane.id);
    store.submit("original-lane-input", "lost-native-receipt", lane.generation);
    await runtime.start();

    const followUp = message("after-restart", lane.route);
    store.receive(followUp, "main");
    store.settle(followUp.id, "done");
    expect(await runtime.messageLane(lane.id, followUp.text, followUp.id)).toEqual({
      inputId: "handoff:after-restart:survivor", state: "pending",
      queueHolds: { runtimeBlocked: false, uncertainInputIds: ["original-lane-input"] },
    });
    expect(await runtime.inspect(lane.id)).toMatchObject({
      state: { isSettled: true, queuedMessageCount: 0 },
      observationState: { ownerCurrent: false },
      queueHolds: { runtimeBlocked: false, uncertainInputIds: ["original-lane-input"] },
    });
    host.beforeState = () => { throw new Error("Native connection stopped reporting state"); };
    expect(await runtime.inspect(lane.id)).toMatchObject({
      state: null, stateError: expect.any(String),
      queueHolds: { runtimeBlocked: true, uncertainInputIds: ["original-lane-input"] },
    });
    host.beforeState = undefined;
    // Reconcile the independent runtime block without clearing durable uncertainty.
    await runtime.resume(lane.id);
    main.beforeState = () => { throw new Error("HEAD state is temporarily unavailable"); };
    await admit(runtime, message("lane-queue-status", lane.route, "/status"));
    const status = messenger.sent.find(output => output.sourceId === "lane-queue-status")?.text;
    expect(status).toContain("Native HEAD: unavailable or unverified.");
    expect(status).toContain("original-lane-input");
    main.beforeState = undefined;

    await admit(runtime, message("other-topic-resolve", other.route, "/resolve --lane original-lane-input"));
    expect(store.input("other-topic-resolve")?.state).toBe("cancelled");
    expect(store.input("original-lane-input")?.state).toBe("uncertain");
    expect(host.prompts).toHaveLength(0);

    host.state.isSettled = false;
    host.state.isStreaming = true;
    host.emit({ type: "agent_start" });
    await admit(runtime, message("lane-owner-resolve", lane.route, "/resolve --lane original-lane-input"));
    expect(store.input("lane-owner-resolve")?.state).toBe("done");
    expect(store.input("original-lane-input")?.state).toBe("cancelled");
    expect(store.input("handoff:after-restart:survivor")?.state).toBe("pending");
    expect(host.prompts).toHaveLength(0);

    host.state.isSettled = true;
    host.state.isStreaming = false;
    host.emit({ type: "session_settled" });
    await host.whenPrompts(1);
    expect(host.prompts.map(prompt => prompt.command.message)).toEqual([expect.stringContaining("Request ID: handoff:after-restart:survivor")]);
    expect(launched).toEqual([]);
  });

  test("resolved lane readback recovers without a native event or blocking unrelated lanes", async () => {
    const { runtime, config, store, hosts } = fixture();
    const lane = savedLane(store, config, "lost-admission", route("11"), process.pid);
    const other = savedLane(store, config, "healthy-sibling", route("12"), process.pid);
    const host = new HostTransport(lane.sessionFile, "session-lost-admission");
    const otherHost = new HostTransport(other.sessionFile, "session-healthy-sibling");
    hosts.set(lane.socketPath, host);
    hosts.set(other.socketPath, otherHost);
    await runtime.start();
    host.beforePrompt = () => { throw new Error("Native prompt acknowledgement was lost"); };
    await delegate(runtime, message("lost", lane.route));
    host.beforePrompt = undefined;
    await delegate(runtime, message("later", lane.route));
    expect(delegated(store, "lost")?.state).toBe("uncertain");

    host.beforeState = () => { throw new Error("Native settlement read failed"); };
    await admit(runtime, message("resolve-lost-lane", lane.route, "/resolve --lane handoff:lost:lost-admission"));
    expect(delegated(store, "lost")?.state).toBe("cancelled");
    expect(delegated(store, "later")?.state).toBe("pending");
    expect(host.prompts).toHaveLength(1);

    const reading = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    host.beforeState = async () => {
      reading.resolve();
      await release.promise;
    };
    const wake = runtime.kick();
    try {
      await reading.promise;
      // Use a deadline only to keep a shared-pump regression from hanging teardown.
      const deadline = new Promise<never>((_, reject) => AbortSignal.timeout(1500).addEventListener("abort",
        () => reject(new Error("Unrelated lane dispatch waited for the failing Host"))));
      await Promise.race([delegate(runtime, message("unrelated", other.route)), deadline]);
      expect(otherHost.prompts.map(prompt => prompt.command.message)).toEqual([
        expect.stringContaining("Request ID: handoff:unrelated:healthy-sibling"),
      ]);
      expect(delegated(store, "later")?.state).toBe("pending");
    } finally {
      host.beforeState = undefined;
      release.resolve();
    }
    await wake;
    await host.whenPrompts(2);
    expect(host.prompts.map(prompt => prompt.command.message)).toEqual([
      expect.stringContaining("Request ID: handoff:lost:lost-admission"),
      expect.stringContaining("Request ID: handoff:later:lost-admission"),
    ]);
  });

  test("a pending workflow reports a later uncertain steering input in its active lane group", async () => {
    const { runtime, config, store, hosts } = fixture();
    const lane = savedLane(store, config, "lane-group", route("11"), process.pid);
    const host = new HostTransport(lane.sessionFile, "session-lane-group");
    hosts.set(lane.socketPath, host);
    await runtime.start();
    const activateSource = (id: string) => {
      const source = message(id, lane.route);
      store.receive(source, "main", { [`user-source:${id}`]: "true" });
      store.settle(id, "done");
      return source;
    };
    const initial = activateSource("active-lane");
    await runtime.messageLane(lane.id, initial.text, initial.id);
    const workflow = activateSource("queued-workflow");
    const choice = { name: "ulw-plan" as const, reason: "Select the planning workflow for this follow-up." };
    await runtime.messageLane(lane.id, workflow.text, workflow.id, choice);
    const steer = activateSource("later-steer");
    host.beforePrompt = () => { throw new Error("Native steering acknowledgement was lost"); };
    expect(await runtime.messageLane(lane.id, steer.text, steer.id)).toMatchObject({ state: "uncertain" });
    expect(host.prompts.map(prompt => prompt.command.streamingBehavior)).toEqual([undefined, "steer"]);
    expect(await runtime.messageLane(lane.id, workflow.text, workflow.id, choice)).toMatchObject({
      state: "pending", queueHolds: { uncertainInputIds: ["handoff:later-steer:lane-group"] },
    });
  });

  test("a surviving PID without a verified lane connection reports a runtime hold instead of dispatching", async () => {
    const { runtime, store, config, launched, messenger } = fixture();
    const lane = savedLane(store, config, "unverified-host", route("11"), process.pid);
    await runtime.start();
    const followUp = message("check-connection", lane.route);
    store.receive(followUp, "main");
    store.settle(followUp.id, "done");

    expect(await runtime.messageLane(lane.id, followUp.text, followUp.id)).toEqual({
      inputId: "handoff:check-connection:unverified-host", state: "pending",
      queueHolds: { runtimeBlocked: true, uncertainInputIds: [] },
    });
    expect(await runtime.inspect(lane.id)).toMatchObject({
      runtimeState: "interrupted", state: null, queueHolds: { runtimeBlocked: true, uncertainInputIds: [] },
    });
    await admit(runtime, message("unverified-host-status", lane.route, "/status"));
    expect(messenger.sent.find(output => output.sourceId === "unverified-host-status")?.text).toContain('"runtimeBlocked":true');
    expect(launched).toEqual([]);
  });

  test("shutdown acceptance and socket disconnect never release a still-live native process", async () => {
    const { runtime, store, config, hosts, launched } = fixture(2);
    const one = savedLane(store, config, "shutdown-pid", route("shutdown-pid"), process.pid);
    const two = savedLane(store, config, "shutdown-waiter", route("shutdown-waiter"));
    const host = new HostTransport(one.sessionFile, "session-shutdown-pid");
    hosts.set(one.socketPath, host);
    await runtime.start();
    await delegate(runtime, message("shutdown-waiting", two.route));
    expect(host.commands.filter(command => command.type === "shutdown_host")).toHaveLength(1);
    expect(store.lane(one.id)).toMatchObject({ pid: process.pid, runtimeState: "idle" });
    expect(launched).toEqual([]);
    host.client.getState = async () => { throw new Error("Native dispose/readback failed after shutdown acceptance"); };
    await runtime.kick();
    await host.close(); // A transport close is still not native PID exit.
    await runtime.kick();
    expect(store.lane(one.id)?.pid).toBe(process.pid);
    expect(delegated(store, "shutdown-waiting")?.state).toBe("pending");
    expect(launched).toEqual([]);
    expect(host.commands.filter(command => command.type === "shutdown_host")).toHaveLength(1);
  });

  test("native exit retains capacity until its owned socket is gone, then permits a new lane", async () => {
    const { runtime, store, config, hosts, launched } = fixture(2);
    const one = savedLane(store, config, "shutdown-socket", route("shutdown-socket"), 2147483647);
    const two = savedLane(store, config, "socket-waiter", route("socket-waiter"));
    const host = new HostTransport(one.sessionFile, "session-shutdown-socket");
    host.state.hostPid = 2147483647;
    hosts.set(one.socketPath, host);
    mkdirSync(dirname(one.socketPath), { recursive: true });
    const socket = Bun.listen({ unix: one.socketPath, socket: { data() {} } });
    try {
      await runtime.start();
      await delegate(runtime, message("socket-waiting", two.route));
      await host.close();
      await runtime.kick();
      expect(store.lane(one.id)?.pid).toBe(2147483647);
      expect(launched).toEqual([]);
      socket.stop(true);
      rmSync(one.socketPath, { force: true });
      await runtime.kick();
      expect(store.lane(one.id)).toMatchObject({ pid: null, runtimeState: "unloaded" });
      expect(launched).toHaveLength(1);
      expect(delegated(store, "socket-waiting")?.state).toBe("submitted");
    } finally { socket.stop(true); }
  });

  test("a native settle in the finish drain's final microtask gap still reports the completed lane", async () => {
    const { runtime, store, config, hosts, main, messenger, errors } = fixture(2);
    const lane = savedLane(store, config, "finish-gap", route("finish-gap"));
    const original = message("finish-gap-source", lane.route);
    await runtime.start();
    await delegate(runtime, original);
    const host = hosts.get(lane.socketPath)!;
    // Finish the admission-triggered busy read before arranging this distinct
    // prompt_result -> pending-async -> session_settled sequence.
    const admitted = Promise.withResolvers<void>();
    setImmediate(admitted.resolve);
    await admitted.promise;
    host.state.isStreaming = false;
    host.state.hasPendingAsyncWork = true;
    const readState = host.client.getState;
    const trace: string[] = [];
    let firstRead = true;
    host.client.getState = async () => {
      const state = await readState();
      if (!firstRead) { trace.push("fresh state"); return state; }
      firstRead = false;
      Object.defineProperty(state, "isSettled", { get() {
        trace.push("busy state");
        // finishOnce returns immediately after reading false. The first hop
        // queues the event behind the inner drain's final condition check; the
        // second emits it before the outer finish() await can resume. There is
        // no sleep, polling, replaced runtime method, or extra later wakeup.
        queueMicrotask(() => queueMicrotask(() => {
          trace.push("late native settle");
          host.state.isSettled = true;
          host.state.hasPendingAsyncWork = false;
          host.emit({ type: "session_settled" });
        }));
        return false;
      } });
      return state;
    };
    host.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "native lane result" }] } });
    host.emit({ type: "prompt_result", id: host.prompts[0]!.id, agentInvoked: true, status: "completed", sessionSettled: false });
    const drained = Promise.withResolvers<void>();
    setImmediate(drained.resolve);
    await drained.promise;
    expect(trace.slice(0, 3)).toEqual(["busy state", "late native settle", "fresh state"]);
    expect(delegated(store, original.id)?.state).toBe("done");
    const reportId = `report:handoff:${original.id}:${lane.id}`;
    expect(store.input(reportId)).toMatchObject({ target: "main", route: original.route });
    expect(store.input(reportId)!.text).toContain("native lane result");
    expect(main.prompts).toHaveLength(1);
    expect(String(main.prompts[0]!.command.message)).toContain(`Request ID: ${reportId}`);
    expect(messenger.sent).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("settled answers report to head while a persistent owned service retains its host slot", async () => {
    const { runtime, store, config, hosts, launched, messenger } = fixture(2);
    const one = savedLane(store, config, "one", route("11"));
    const two = savedLane(store, config, "two", route("12"));
    await runtime.start();
    await delegate(runtime, message("155", one.route));
    const host = hosts.get(one.socketPath)!;
    host.state.hasOwnedRunningWork = true;
    host.complete("The requested service is ready");
    await runtime.kick();
    await delegate(runtime, message("156", two.route));
    expect(messenger.sent).toEqual([]);
    expect(store.input("report:handoff:155:one")?.text).toContain("The requested service is ready");
    expect(host.commands.some(command => command.type === "shutdown_host")).toBe(false);
    expect(launched).toHaveLength(1);
    expect(delegated(store, "156")?.state).toBe("pending");
    expect(store.lane(one.id)?.pid).toBe(process.pid);
  });

  test("catchup uses only stored authorized cursors and duplicate redelivery does not resubmit", async () => {
    const { runtime, store, main, messenger } = fixture();
    const destination = route(null, { guildId: null });
    const original = message("160", destination);
    store.receive(original, "main");
    store.settle(original.id, "done");
    store.setMeta("discord:routes", JSON.stringify([destination]));
    store.setMeta(`cursor:${routeKey(destination)}`, "160");
    messenger.backlog.set(routeKey(destination), [original, headMessage("161", destination)]);
    await runtime.start();
    expect(messenger.fetched).toEqual([{ route: destination, cursor: "160" }]);
    expect(JSON.parse(store.getMeta("messenger:routes")!)).toEqual([destination]);
    expect(main.prompts).toHaveLength(1);
    expect(store.input("161")?.state).toBe("submitted");
    await messenger.handlers!.reconnect!();
    expect(main.prompts).toHaveLength(1);
    expect(messenger.fetched[1]!.cursor).toBe("161");
    expect(store.getMeta(`cursor:${routeKey(destination)}`)).toBe("161");
  });

  test("migrated route metadata never resurrects obsolete legacy destinations", async () => {
    const { runtime, store, messenger } = fixture();
    const legacy = route(null, { guildId: null });
    store.setMeta("discord:routes", JSON.stringify([legacy]));
    store.setMeta(`cursor:${physicalRouteKey(legacy)}`, "100");
    store.setMeta("messenger:routes", "[]");
    await runtime.start();
    await messenger.handlers!.reconnect!();
    expect(messenger.fetched).toEqual([]);
    expect(store.getMeta(`cursor:${physicalRouteKey(legacy)}`)).toBe("100");
    expect(store.getMeta("messenger:routes")).toBe("[]");
  });

  test("Slack catchup sorts exact timestamps before applying DM boundaries and rejects foreign or unsupported history", async () => {
    const { runtime, config, store, messenger, errors } = fixture();
    config.slack = { botTokenEnv: "TEST_SLACK_BOT_TOKEN", appTokenEnv: "TEST_SLACK_APP_TOKEN", ownerId: "UOWNER", teamId: "TTEAM", allowedChannelIds: [] };
    const dm = route(null, { platform: "slack", accountId: "TTEAM:UBOT", authorityId: "UOWNER", guildId: null, channelId: "DPRIVATE" });
    const event = (suffix: string, text: string): Inbound => ({ ...message(`history:${suffix}`, dm, text), messageId: `1750000000.${suffix}` });
    store.setMeta("messenger:routes", JSON.stringify([dm]));
    store.setMeta(`cursor:${physicalRouteKey(dm)}`, "1750000000.000001");
    messenger.backlog.set(routeKey(dm), [event("000005", "/head main followup"), event("000003", "topic followup"), event("000004", "/main"), event("000002", "/new")]);
    await runtime.start();
    const topicId = store.input("history:000002")!.route.topicId!;
    expect(store.input("history:000003")?.route.topicId).toBe(topicId);
    expect(store.input("history:000005")?.route).toEqual(dm);
    expect(store.getMeta(`cursor:${physicalRouteKey(dm)}`)).toBe("1750000000.000005");
    messenger.backlog.set(routeKey(dm), [{ ...event("000006", "foreign"), route: { ...dm, accountId: "TTEAM:OTHER" } }]);
    await messenger.handlers!.reconnect!();
    expect(store.input("history:000006")).toBeNull();
    messenger.backlog.set(routeKey(dm), [{ ...event("000007", "invalid"), messageId: "not-a-timestamp" }]);
    await messenger.handlers!.reconnect!();
    expect(store.input("history:000007")).toBeNull();
    expect(store.getMeta(`cursor:${physicalRouteKey(dm)}`)).toBe("1750000000.000005");
    expect(errors).toHaveLength(2);
  });

  test("Telegram no-history recovery remains adapter-owned without advancing stored cursors", async () => {
    const { runtime, config, store, messenger, main, errors } = fixture();
    delete config.discord;
    config.telegram = { tokenEnv: "TEST_TELEGRAM_TOKEN", ownerId: "1", allowedChatIds: [] };
    const dm = route(null, { platform: "telegram", guildId: null, channelId: "1" });
    store.setMeta("messenger:routes", JSON.stringify([dm]));
    store.setMeta(`cursor:${physicalRouteKey(dm)}`, "500");
    messenger.backlog.set(routeKey(dm), null);
    await runtime.start();
    await messenger.handlers!.reconnect!();
    expect(messenger.fetched).toEqual([{ route: dm, cursor: "500" }, { route: dm, cursor: "500" }]);
    expect(store.getMeta(`cursor:${physicalRouteKey(dm)}`)).toBe("500");
    expect(main.prompts).toEqual([]);
    expect(errors).toEqual([]);
    const recovered = message("telegram:501", dm, "/new");
    recovered.messageId = "501";
    await messenger.handlers!.message(recovered);
    await runtime.kick();
    expect(store.input(recovered.id)?.route.topicId).toBeTruthy();
    expect(store.getMeta(`cursor:${physicalRouteKey(dm)}`)).toBe("501");
  });

  test("direct main guild delegation creates one independent thread and preserves submitted ownership", async () => {
    const { runtime, store, directory, messenger } = fixture();
    await runtime.start();
    const original = headMessage("170", route(null));
    await admit(runtime, original);
    const [one, two] = await Promise.all([
      runtime.startLane({ ...selection, sourceId: original.id, title: "Delegation", kickoff: "I will inspect the requested workspace, perform the authorized work, and verify the result in this topic.", cwd: directory }),
      runtime.startLane({ ...selection, sourceId: original.id, title: "Delegation", kickoff: "I will inspect the requested workspace, perform the authorized work, and verify the result in this topic.", cwd: directory }),
    ]);
    expect(one.id).toBe(two.id);
    expect(messenger.threads).toHaveLength(1);
    expect(one.route.threadId).toBe("900");
    expect(store.input(original.id)).toMatchObject({ target: "main", state: "submitted" });
    expect(store.input("handoff:170:lane")?.target).toBe(one.id);
    expect(store.laneForRoute(original.route)).toBeNull();
  });

  test("DM head delegation creates an active logical topic and ambiguous guild creation is not retried", async () => {
    const { runtime, directory, messenger, store } = fixture();
    await runtime.start();
    const dm = route(null, { guildId: null });
    await admit(runtime, headMessage("180", dm));
    const delegated = await runtime.startLane({ ...selection, sourceId: "180", title: "DM task", kickoff: "I will inspect the requested workspace, perform the authorized work, and verify the result in this topic.", cwd: directory });
    expect(delegated.route.threadId).toBeNull();
    expect(delegated.route.topicId).toMatch(/^topic-/);
    expect(messenger.threads).toEqual([]);
    expect(store.input("180")).toMatchObject({ target: "main", state: "submitted", route: dm });
    expect(store.input("handoff:180:lane")?.route.topicId).toBe(delegated.route.topicId);
    expect(store.getMeta(`dm:active:${physicalRouteKey(dm)}`)).toBe(delegated.route.topicId!);
    await admit(runtime, message("182", dm, "Follow this delegated topic"));
    expect(store.input("182")).toMatchObject({ target: null, state: "done", route: delegated.route });
    expect(store.input(`handoff:182:${delegated.id}`)?.target).toBe(delegated.id);
    store.receive(message("181", route(null)), "main");
    store.submit("181", "native-main-next", 0);
    messenger.threadFails = true;
    await expect(runtime.startLane({ ...selection, sourceId: "181", title: "Uncertain", kickoff: "I will inspect the requested workspace, perform the authorized work, and verify the result in this topic.", cwd: directory })).rejects.toThrow();
    messenger.threadFails = false;
    await expect(runtime.startLane({ ...selection, sourceId: "181", title: "Uncertain", kickoff: "I will inspect the requested workspace, perform the authorized work, and verify the result in this topic.", cwd: directory })).rejects.toThrow("interrupted");
    expect(messenger.threads).toEqual([]);
  });

  test("DM /new without content asks once, survives restart, and never launches an empty model prompt", async () => {
    const { runtime, config, directory, store, main, messenger } = fixture();
    const dm = route(null, { guildId: null });
    const boundary = message("500", dm, "/new");
    await runtime.start();
    await admit(runtime, boundary);
    const topicId = store.input("500")!.route.topicId!;
    expect(topicId).toMatch(/^topic-/);
    expect(store.input("500")?.state).toBe("done");
    expect(main.prompts).toEqual([]);
    expect(messenger.sent).toHaveLength(1);
    expect(store.lanes()).toEqual([]);
    await admit(runtime, boundary);
    expect(messenger.sent).toHaveLength(1);
    await runtime.stop();

    const reopened = new Store(join(directory, "coordination.sqlite"));
    const transport = new MessengerTransport();
    const head = new HostTransport(hostPaths(config, "main").sessionFile, "session-main");
    const restarted = new Superagent(config, reopened, transport, join(directory, "extension.ts"), () => {}, {
      connect: async path => {
        if (path !== hostPaths(config, "main").socketPath) throw new Error("Unexpected native adoption");
        return head;
      },
      startHost: async () => { throw new Error("No lane is authorized before cwd selection"); },
    });
    fixtures.find(entry => entry.runtime === runtime)!.runtime = restarted;
    await restarted.start();
    expect(reopened.getMeta(`dm:active:${physicalRouteKey(dm)}`)).toBe(topicId);
    expect(head.prompts).toEqual([]);
    await admit(restarted, message("501", dm, "Inspect the requested repository"));
    expect(reopened.input("501")).toMatchObject({ target: null, state: "pending", route: { ...dm, topicId } });
    expect(reopened.output("501:workspace")).toMatchObject({ sourceId: "501", route: { ...dm, topicId }, state: "sent" });
    expect(reopened.lanes()).toEqual([]);
    expect(head.prompts).toEqual([]);
    await admit(restarted, boundary);
    expect(reopened.getMeta(`dm:active:${physicalRouteKey(dm)}`)).toBe(topicId);
    expect(transport.fetched.every(entry => entry.route.topicId === undefined)).toBe(true);
  });

  test("two logical DM topics isolate followups and /main preserves both lanes and immutable replay", async () => {
    const { runtime, store, directory, messenger, main } = fixture();
    const dm = route(null, { guildId: null });
    await runtime.start();
    const firstRequest = message("600", dm, `/new cwd: ${directory}\nfirst repository task`);
    await admit(runtime, firstRequest);
    const firstId = store.input("handoff:600:lane")?.target;
    const first = firstId ? store.lane(firstId) : null;
    if (!first) throw new Error("Expected the first logical DM lane");
    await admit(runtime, message("601", dm, "First followup"));
    expect(store.input("601")).toMatchObject({ target: null, state: "done", route: first.route });
    await admit(runtime, message("610", dm, `/new cwd: ${directory}\nsecond repository task`));
    const secondId = store.input("handoff:610:lane")?.target;
    const second = secondId ? store.lane(secondId) : null;
    if (!second) throw new Error("Expected the second logical DM lane");
    await admit(runtime, message("611", dm, "Second followup"));
    expect(store.input("611")).toMatchObject({ target: null, state: "done", route: second.route });
    expect(first.route.threadId).toBeNull();
    expect(second.route.threadId).toBeNull();
    expect(first.route.topicId).not.toBe(second.route.topicId);
    expect(physicalRouteKey(first.route)).toBe(physicalRouteKey(second.route));
    expect(store.laneForRoute(dm)).toBeNull();
    await admit(runtime, message("620", dm, "/main"));
    await admit(runtime, headMessage("621", dm, "A direct head question"));
    expect(store.input("621")?.target).toBe("main");
    expect(store.input("621")?.route.topicId).toBeUndefined();
    expect(store.lanes()).toHaveLength(2);
    await admit(runtime, firstRequest);
    expect(store.getMeta(`dm:active:${physicalRouteKey(dm)}`)).toBe("");
    expect(store.input("600")).toMatchObject({ target: null, state: "done", text: firstRequest.text });
    // Historical catchup is assigned by the command timeline, not today's /main.
    await admit(runtime, message("605", dm, "Late catchup belonging to first topic"));
    expect(store.input("605")).toMatchObject({ target: null, state: "done", route: first.route });
    for (const [id, lane] of [["601", first], ["611", second], ["605", first]] as const) {
      expect(store.input(`handoff:${id}:${lane.id}`)?.target).toBe(lane.id);
    }
    expect(main.prompts).toHaveLength(1);
    expect(main.prompts[0]?.command.message).toContain("A direct head question");
    expect(messenger.threads).toEqual([]);
  });

  for (const platform of ["discord", "telegram", "slack"] as const) {
    test(`${platform} old DM topic card remains valid after /main but cannot answer another topic's dialog`, async () => {
    const { runtime, config, store, directory, hosts, messenger } = fixture();
    config.telegram = { tokenEnv: "TEST_TELEGRAM_TOKEN", ownerId: "1", allowedChatIds: [] };
    config.slack = { botTokenEnv: "TEST_SLACK_BOT_TOKEN", appTokenEnv: "TEST_SLACK_APP_TOKEN", ownerId: "1", teamId: "TTEAM", allowedChannelIds: [] };
    const dm = route(null, { platform, accountId: platform === "slack" ? "TTEAM:UBOT" : "2", guildId: null, channelId: platform === "telegram" ? "1" : platform === "slack" ? "DPRIVATE" : "4" });
    const command = (id: string, text: string): Inbound => ({ ...message(id, dm, text), messageId: platform === "slack" ? `1750000000.${id.padStart(6, "0")}` : id });
    await runtime.start();
    await admit(runtime, command("700", `/new cwd: ${directory}\nfirst task`));
    const firstId = store.input("handoff:700:lane")?.target;
    const first = firstId ? store.lane(firstId) : null;
    if (!first) throw new Error("Expected the first topic for its approval card");
    await admit(runtime, command("710", `/new cwd: ${directory}\nsecond task`));
    const secondId = store.input("handoff:710:lane")?.target;
    const second = secondId ? store.lane(secondId) : null;
    if (!second) throw new Error("Expected the second topic for a distinct approval card");
    const firstHost = hosts.get(first.socketPath)!;
    const secondHost = hosts.get(second.socketPath)!;
    const frame = { type: "extension_ui_request", method: "confirm", id: "same-native-dialog-id", title: "Allow?" };
    firstHost.state.pendingUiRequests = [frame];
    secondHost.state.pendingUiRequests = [frame];
    firstHost.emit(frame);
    secondHost.emit(frame);
    const firstApproval = store.approvals(first.id)[0]!;
    const secondApproval = store.approvals(second.id)[0]!;
    expect(firstApproval.route.topicId).toBe(first.route.topicId);
    expect(secondApproval.route.topicId).toBe(second.route.topicId);
    await admit(runtime, command("720", "/main"));
    await expect(messenger.handlers!.answer(firstApproval.id, { confirmed: true }, second.route)).rejects.toThrow("foreign approval");
    await expect(messenger.handlers!.answer(firstApproval.id, { confirmed: true }, dm)).rejects.toThrow("foreign approval");
    await messenger.handlers!.answer(firstApproval.id, { confirmed: true }, firstApproval.route);
    expect(firstHost.responses.filter(response => response.response.confirmed)).toHaveLength(1);
    expect(secondHost.responses).toEqual([]);
    expect(store.approval(secondApproval.id)?.state).toBe("pending");
    await expect(messenger.handlers!.answer(firstApproval.id, { confirmed: true }, firstApproval.route)).rejects.toThrow();
    await runtime.pause(second.id);
    expect(store.approval(secondApproval.id)?.state).toBe("cancelled");
    expect(secondHost.responses).toContainEqual({ id: frame.id, response: { cancelled: true } });
    });
  }

  test("attachments stream to a private request path and actual image bytes reach native prompt without signed URLs", async () => {
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
    const requested: string[] = [];
    const fetcher: Messenger["openAttachment"] = async (destination, attachment, signal) => {
      requested.push(attachment.url);
      expect(destination).toEqual(route(null, { guildId: null }));
      expect(signal).toBeInstanceOf(AbortSignal);
      return new Response(png, { headers: { "content-length": String(png.length) } });
    };
    const { runtime, main, directory } = fixture(3, fetcher);
    await runtime.start();
    await admit(runtime, {
      ...headMessage("190", route(null, { guildId: null })),
      attachments: [{ id: "77", name: "../../image.png", url: "https://cdn.discordapp.com/attachments/4/77/image.png?secret=signed", size: png.length, contentType: "image/png" }],
    });
    const prompt = main.prompts[0]!.command;
    expect(requested).toHaveLength(1);
    expect(prompt.message).toContain(join(directory, "attachments"));
    expect(prompt.message).not.toContain("secret=signed");
    expect(prompt.message).not.toContain("cdn.discordapp.com");
    expect(prompt.images).toEqual([{ type: "image", data: png.toString("base64"), mimeType: "image/png" }]);
  });

  for (const [platform, unknownSize] of [["telegram", false], ["telegram", true], ["slack", false]] as const) {
    test(`${platform} opaque attachments (unknown size: ${unknownSize}) remain adapter-owned with bounded private persistence and sniffed images`, async () => {
      const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
      const opened: Array<{ route: Route; reference: string }> = [];
      const { runtime, config, main, directory } = fixture(3, async (destination, attachment, signal) => {
        opened.push({ route: destination, reference: attachment.url });
        expect(signal.aborted).toBe(false);
        return new Response(png, { headers: unknownSize ? {} : { "content-length": String(png.length) } });
      });
      delete config.discord;
      config.telegram = { tokenEnv: "TEST_TELEGRAM_TOKEN", ownerId: "1", allowedChatIds: [] };
      config.slack = { botTokenEnv: "TEST_SLACK_BOT_TOKEN", appTokenEnv: "TEST_SLACK_APP_TOKEN", ownerId: "1", teamId: "TTEAM", allowedChannelIds: [] };
      const dm = route(null, { platform, accountId: platform === "slack" ? "TTEAM:UBOT" : "2", guildId: null, channelId: platform === "slack" ? "DPRIVATE" : "1" });
      const reference = platform === "telegram" ? "telegram-file:opaque_file_id" : "slack-file:FOPAQUE";
      await runtime.start();
      const input = { ...headMessage(`${platform}:attachment`, dm), messageId: platform === "slack" ? "1750000000.000001" : "100", attachments: [{ id: "opaque", name: "../../not-an-image.txt", url: reference, size: unknownSize ? null : png.length, contentType: "text/plain" }] };
      await admit(runtime, input);
      expect(opened).toEqual([{ route: dm, reference }]);
      expect(main.prompts[0]!.command.images).toEqual([{ type: "image", data: png.toString("base64"), mimeType: "image/png" }]);
      expect(main.prompts[0]!.command.message).not.toContain(reference);
      const requestDirectory = join(directory, "attachments", createHash("sha256").update(input.id).digest("hex").slice(0, 24));
      const files = readdirSync(requestDirectory);
      expect(files).toHaveLength(1);
      expect(files[0]).not.toContain(".download");
      expect(statSync(join(requestDirectory, files[0]!)).mode & 0o777).toBe(0o600);
      expect(statSync(join(requestDirectory, files[0]!)).size).toBe(png.length);
      expect(statSync(requestDirectory).mode & 0o777).toBe(0o700);
    });
  }

  test("unknown-size voice attachments retain actual byte length and media context in native prompts", async () => {
    const { runtime, config, main } = fixture(3, async () => new Response("OggS", { headers: { "content-length": "4" } }));
    delete config.discord;
    config.telegram = { tokenEnv: "TEST_TELEGRAM_TOKEN", ownerId: "1", allowedChatIds: [] };
    const dm = route(null, { platform: "telegram", guildId: null, channelId: "1" });
    await runtime.start();
    await admit(runtime, { ...headMessage("unknown-voice", dm), attachments: [
      { id: "voice", name: "voice.ogg", url: "telegram-file:voice", size: null, voice: true, durationSeconds: 1.5 },
    ] });
    expect(main.prompts[0]!.command.message).toContain("4 bytes; voice message; duration 1.5 seconds");
  });

  test.each(["file", "request", "image"] as const)("unknown attachment sizes still enforce the actual %s byte budget", async mode => {
    const mib = 1024 * 1024;
    const chunk = new Uint8Array(mib);
    if (mode === "image") chunk.set([137, 80, 78, 71, 13, 10, 26, 10]);
    let opened = 0;
    const { runtime, config, main, store, directory } = fixture(3, async () => {
      opened++;
      let remaining = mode === "request" ? 15 : mode === "image" ? 9 : 21;
      return new Response(new ReadableStream({
        pull(controller) {
          if (remaining-- > 0) controller.enqueue(chunk);
          else controller.close();
        },
      }));
    });
    delete config.discord;
    config.telegram = { tokenEnv: "TEST_TELEGRAM_TOKEN", ownerId: "1", allowedChatIds: [] };
    const dm = route(null, { platform: "telegram", guildId: null, channelId: "1" });
    const input: Inbound = { ...headMessage(`unknown-limit-${mode}`, dm),
      attachments: Array.from({ length: mode === "request" ? 3 : 1 }, (_, index) => ({
        id: `file-${index}`, name: "file", url: `telegram-file:file-${index}`, size: null,
      })) };
    await runtime.start();
    await admit(runtime, input);
    expect(store.input(input.id)?.state).toBe("cancelled");
    expect(main.prompts).toEqual([]);
    expect(opened).toBe(input.attachments.length);
    const requestDirectory = join(directory, "attachments", createHash("sha256").update(input.id).digest("hex").slice(0, 24));
    expect(readdirSync(requestDirectory).filter(name => name.endsWith(".download"))).toEqual([]);
  });

  test("attachment count, individual size and aggregate bounds reject before adapter access", async () => {
    let opened = 0;
    const { runtime, main, store } = fixture(3, async () => { opened++; throw new Error("Bounds must reject before adapter access"); });
    await runtime.start();
    const attachment = { id: "file", name: "file", url: "opaque-resource", size: 1 };
    const payloads = [
      Array.from({ length: 11 }, (_, index) => ({ ...attachment, id: String(index) })),
      [{ ...attachment, size: -1 }],
      [{ ...attachment, size: 20 * 1024 * 1024 + 1 }],
      Array.from({ length: 3 }, (_, index) => ({ ...attachment, id: String(index), size: 15 * 1024 * 1024 })),
    ];
    for (const [index, attachments] of payloads.entries()) {
      const id = String(300 + index);
      await admit(runtime, { ...headMessage(id, route(null, { guildId: null })), attachments });
      expect(store.input(id)?.state).toBe("cancelled");
    }
    expect(opened).toBe(0);
    expect(main.prompts).toEqual([]);
  });

  for (const mode of ["short", "header", "rejected"] as const) {
    test(`attachment ${mode} response leaves no partial file or native prompt`, async () => {
      const { runtime, store, main, directory } = fixture(3, async () => mode === "rejected"
        ? new Response("denied", { status: 403 })
        : new Response(new Uint8Array([1]), { headers: mode === "header" ? { "content-length": "3" } : {} }));
      await runtime.start();
      const input = { ...headMessage("310", route(null, { guildId: null })), attachments: [{ id: "opaque", name: "file", url: "adapter-file:opaque", size: 2 }] };
      await admit(runtime, input);
      expect(store.input(input.id)?.state).toBe("cancelled");
      expect(main.prompts).toEqual([]);
      const requestDirectory = join(directory, "attachments", createHash("sha256").update(input.id).digest("hex").slice(0, 24));
      expect(readdirSync(requestDirectory)).toEqual([]);
    });
  }

  test("adapter attachment rejection and oversized streams prevent native admission", async () => {
    let fetches = 0;
    const fetcher: Messenger["openAttachment"] = async (_route, attachment) => {
      fetches++;
      if (attachment.id === "77") throw new Error("Owning adapter rejected the resource");
      return new Response(new Uint8Array([1, 2, 3]));
    };
    const { runtime, main, store, messenger } = fixture(3, fetcher);
    await runtime.start();
    await admit(runtime, { ...headMessage("200", route(null, { guildId: null })), attachments: [
      { id: "77", name: "private", url: "https://127.0.0.1/private", size: 1 },
    ] });
    expect(fetches).toBe(1);
    await admit(runtime, { ...headMessage("201", route(null, { guildId: null })), attachments: [
      { id: "78", name: "large", url: "https://cdn.discordapp.com/attachments/4/78/file", size: 1 },
    ] });
    expect(fetches).toBe(2);
    expect(main.prompts).toEqual([]);
    expect(store.input("200")?.state).toBe("cancelled");
    expect(store.input("201")?.state).toBe("cancelled");
    expect(messenger.sent).toHaveLength(2);
  });

  test("a blocked attachment download never blocks durable intake of another request", async () => {
    const requested = Promise.withResolvers<void>();
    const response = Promise.withResolvers<Response>();
    const fetcher: Messenger["openAttachment"] = async () => { requested.resolve(); return response.promise; };
    const { runtime, store } = fixture(3, fetcher);
    await runtime.start();
    await runtime.receive({ ...headMessage("205", route(null, { guildId: null })), attachments: [
      { id: "78", name: "file", url: "https://cdn.discordapp.com/attachments/4/78/file", size: 1 },
    ] });
    await requested.promise;
    try {
      await runtime.receive(headMessage("206", route("88")));
      expect(store.input("206")).toMatchObject({ state: "pending", target: "main" });
      expect(store.input("205")?.state).toBe("pending");
    } finally { response.resolve(new Response(new Uint8Array([1]))); }
    await runtime.kick();
  });

  for (const stopReason of ["error", "aborted"] as const) {
    test(`goal continuation ${stopReason} supersedes the originating successful yield`, async () => {
      const { runtime, store, config, hosts, messenger } = fixture();
      const lane = savedLane(store, config, "one", route("11"));
      await runtime.start();
      await delegate(runtime, message("230", lane.route));
      const host = hosts.get(lane.socketPath)!;
      host.state.goal = { enabled: true, mode: "active" };
      host.state.isStreaming = false;
      host.emit({ type: "message_end", message: {
        role: "assistant", content: [{ type: "text", text: "Earlier successful yield" }],
        stopReason: "stop", api: "openai-responses", provider: "openai", model: "fixture", timestamp: 100,
      } });
      host.emit({ type: "prompt_result", id: host.prompts[0]!.id, status: "completed", agentInvoked: true, sessionSettled: false });
      await runtime.kick();
      expect(delegated(store, "230")?.state).toBe("submitted");
      expect(messenger.sent).toEqual([]);

      host.state.isStreaming = true;
      host.emit({ type: "agent_start" });
      const terminal = {
        role: "assistant", content: [], stopReason,
        errorMessage: stopReason === "error" ? "Provider request failed; private diagnostics must not be posted" : "Request aborted",
        api: "openai-responses", provider: "openai", model: "fixture", timestamp: 101,
      };
      host.emit({ type: "message_end", message: terminal });
      host.emit({ type: "agent_end", messages: [terminal], yielded: true, isTerminal: true });
      host.state.isStreaming = false;
      host.state.isSettled = true;
      host.emit({ type: "session_settled" });
      await runtime.kick();
      const expected = stopReason === "error" ? "uncertain" : "cancelled";
      expect(delegated(store, "230")?.state).toBe(expected);
      expect(messenger.sent).toEqual([]);
      expect(store.input("report:handoff:230:one")?.text).toContain(stopReason === "error" ? "실패" : "중단");
      expect(store.input("report:handoff:230:one")?.text).not.toContain("private diagnostics");
      expect(store.input("report:handoff:230:one")?.text).toContain(`native outcome: ${expected}`);
      expect(store.input("report:handoff:230:one")?.text).not.toContain("Earlier successful yield");
      expect(store.lane(lane.id)?.workState).toBe("open");
    });
  }

  test("goal continuation recovered native success supersedes an earlier failure without latching transient errors", async () => {
    const { runtime, store, config, hosts, messenger } = fixture();
    const lane = savedLane(store, config, "one", route("11"));
    await runtime.start();
    await delegate(runtime, message("231", lane.route));
    const host = hosts.get(lane.socketPath)!;
    host.state.goal = { enabled: true, mode: "active" };
    host.state.isStreaming = false;
    host.emit({ type: "prompt_result", id: host.prompts[0]!.id, status: "error", agentInvoked: true, sessionSettled: false });
    await runtime.kick();
    host.state.isStreaming = true;
    host.emit({ type: "agent_start" });
    host.emit({ type: "message_end", message: {
      role: "assistant", content: [], stopReason: "error", errorMessage: "Transient provider failure",
      api: "openai-responses", provider: "openai", model: "fixture", timestamp: 101,
    } });
    const recovered = {
      role: "assistant", content: [{ type: "text", text: "Recovered final response" }], stopReason: "stop",
      api: "openai-responses", provider: "openai", model: "fixture", timestamp: 102,
    };
    host.emit({ type: "message_end", message: recovered });
    host.emit({ type: "agent_end", messages: [recovered], yielded: true, isTerminal: true });
    host.state.isStreaming = false;
    host.state.isSettled = true;
    host.emit({ type: "session_settled" });
    await runtime.kick();
    expect(delegated(store, "231")?.state).toBe("done");
    expect(messenger.sent).toEqual([]);
    expect(store.input("report:handoff:231:one")?.text).toContain("Recovered final response");
    expect(store.input("report:handoff:231:one")?.text).toContain("native outcome: done");
    expect(store.input("report:handoff:231:one")?.text).not.toContain("Transient provider failure");
    expect(store.lane(lane.id)?.workState).toBe("open");
  });

  test("goal continuation ownership preserves originating command failure without later native success", async () => {
    const { runtime, store, config, hosts, messenger } = fixture();
    const lane = savedLane(store, config, "one", route("11"));
    await runtime.start();
    await delegate(runtime, message("232", lane.route));
    const host = hosts.get(lane.socketPath)!;
    host.emit({ type: "message_end", message: {
      role: "assistant", content: [{ type: "text", text: "Partial original response" }], stopReason: "stop",
    } });
    host.state.isStreaming = false;
    host.state.isSettled = true;
    host.emit({ type: "prompt_result", id: host.prompts[0]!.id, status: "error", agentInvoked: true, sessionSettled: true,
      error: { message: "Native command-level failure", retryable: false } });
    host.emit({ type: "session_settled" });
    await runtime.kick();
    expect(delegated(store, "232")?.state).toBe("uncertain");
    expect(messenger.sent).toEqual([]);
    expect(store.input("report:handoff:232:one")?.text).toContain("실패");
    expect(store.input("report:handoff:232:one")?.text).not.toContain("Partial original response");
  });

  test("goal continuation aborted after durable pause cannot reopen or post the cancelled request", async () => {
    const { runtime, store, config, hosts, messenger } = fixture();
    const lane = savedLane(store, config, "one", route("11"));
    await runtime.start();
    await delegate(runtime, message("233", lane.route));
    const host = hosts.get(lane.socketPath)!;
    host.state.goal = { enabled: true, mode: "active" };
    host.emit({ type: "prompt_result", id: host.prompts[0]!.id, status: "completed", agentInvoked: true, sessionSettled: false });
    await runtime.kick();
    await runtime.pause(lane.id);
    host.emit({ type: "message_end", message: { role: "assistant", content: [], stopReason: "aborted", errorMessage: "Request aborted" } });
    host.emit({ type: "session_settled" });
    await runtime.kick();
    expect(delegated(store, "233")?.state).toBe("cancelled");
    expect(store.lane(lane.id)?.workState).toBe("paused");
    expect(messenger.sent).toEqual([]);
    expect(store.input("report:handoff:233:one")).toBeNull();
  });

  test("wrong session identity is quarantined without duplicate launch", async () => {
    const { runtime, store, config, hosts, launched, errors } = fixture();
    const lane = savedLane(store, config, "one", route("11"), process.pid);
    hosts.set(lane.socketPath, new HostTransport(lane.sessionFile, "foreign-session"));
    await runtime.start();
    await delegate(runtime, message("210", lane.route));
    expect(launched).toEqual([]);
    expect(delegated(store, "210")?.state).toBe("pending");
    expect(store.lane(lane.id)?.sessionId).toBe("session-one");
    expect(errors).toHaveLength(1);
  });
});

test("workspace replies cannot place another thread's pending request or revive a stopped one", async () => {
  const { runtime, store, main, hosts, directory } = fixture();
  await runtime.start();
  const a = route("41"), b = route("42");
  const send = async (input: Inbound) => { await runtime.receive(input); await runtime.kick(); };
  await send({ ...message("410", a), text: "Repair project A" });
  await send({ ...message("420", b), text: "Repair project B" });
  const askA = store.output("410:workspace"), askB = store.output("420:workspace");
  expect(askA?.state).toBe("sent");
  expect(askB?.state).toBe("sent");
  await send({ ...message("411", a), text: `cwd: ${directory}`,
    reply: { messageId: askB!.remoteId!, authorId: null, text: "workspace" } });
  expect(store.lanes()).toHaveLength(0);
  await send({ ...message("421", b), text: "/stop" });
  expect(store.input("420")?.state).toBe("cancelled");
  await send({ ...message("422", b), text: `cwd: ${directory}` });
  expect(store.lanes()).toHaveLength(0);
  await send({ ...message("412", a), text: directory, reply: {
    messageId: askA!.remoteId!, authorId: null, text: "workspace",
  } });
  const lane = store.laneForRoute(a);
  expect(lane?.cwd).toBe(directory);
  expect(hosts.get(lane!.socketPath)?.prompts.map(item => item.command.message)).toEqual([expect.stringContaining("Repair project A")]);
  expect(store.laneForRoute(b)).toBeNull();
  expect(main.prompts).toEqual([]);
});

test("a historical request in an already bound channel waits for a specific prior session, even when both used the same repo", async () => {
  const searches: string[] = [];
  let available = true;
  const { runtime, config, store, hosts, main, errors } = fixture(3, undefined, { topicMemory: {
    status: async () => ({ backend: "mnemopi", active: true, searchable: true, writable: true }),
    search: async query => {
      searches.push(query);
      if (!available) throw new Error("private-provider-diagnostic");
      return { backend: "mnemopi", query, items: [], count: 0 };
    },
  } });
  config.discord!.allowedChannelIds.push("5");
  const destination = route("53", { channelId: "5" });
  const unrelated = savedLane(store, config, "current", destination);
  const lastWeek = "2026-11-11T12:00:00.000Z", now = Date.parse("2026-11-18T12:00:00.000Z");
  for (const [id, detail] of [["one", "callback-state"], ["two", "device-cookie"], ["foreign", "private-detail"]] as const) {
    const lane = savedLane(store, config, id, id === "foreign" ? route("51", { accountId: "99" }) : route(id === "one" ? "51" : "52"));
    const sessionId = `session-${id}`, task = `로그인 버그 조사: ${detail} 문제를 확인해줘`;
    store.updateLane(id, lane.generation, { sessionId });
    mkdirSync(dirname(lane.sessionFile), { recursive: true });
    const content = `\`\`\`superagent-runtime-context\nRequest ID: opener-${id}\n\nOriginal source ID: opener-${id}\n\nOriginal authorized conversation: ${routeKey(lane.route)}\n\nReply only to this request.\n\nIndependent lane ${id}; cwd: ${lane.cwd}\nDelivery mode: topic reply.\n\`\`\`\n\n${task}`;
    writeFileSync(lane.sessionFile, [
      { type: "session", version: 3, id: sessionId, timestamp: lastWeek, cwd: lane.cwd },
      { type: "message", id: "turn", parentId: null, timestamp: lastWeek, message: { role: "user", content } },
    ].map(entry => JSON.stringify(entry)).join("\n") + "\n");
  }
  await runtime.start();
  const input = { ...message("610", destination, "지난주 로그인 버그 보던 데서 계속해줘"), receivedAt: now };
  await admit(runtime, input);
  const question = store.output("610:workspace");
  if (!question?.remoteId) throw new Error("Expected a scoped choice between prior sessions");
  expect(question.text).not.toMatch(/callback-state|device-cookie/);
  expect(store.lanes()).toHaveLength(4);
  const choices = JSON.parse(store.getMeta("topic-history:610")!) as Array<{ laneId: string }>;
  expect(choices.map(ref => ref.laneId).sort()).toEqual(["one", "two"]);
  const number = choices.findIndex(ref => ref.laneId === "two") + 1;
  expect(number).toBeGreaterThan(0);
  const reply = { messageId: question.remoteId, authorId: null, text: "not authoritative" };
  await admit(runtime, { ...message("611", destination, String(number)), receivedAt: now + 1, reply });
  const target = store.input("handoff:610:lane")?.target;
  const continuation = target && store.lane(target);
  if (!continuation) throw new Error("Historical choice never reached a continuation session");
  const prompt = hosts.get(continuation.socketPath)?.prompts[0]?.command.message;
  expect(prompt).toContain("device-cookie");
  expect(prompt).not.toContain("callback-state");
  expect(continuation.id).not.toBe("two");
  expect(continuation.route.channelId).toBe(destination.channelId);
  expect(store.laneForRoute(destination)?.id).toBe(unrelated.id);
  expect(main.prompts).toHaveLength(0);
  await admit(runtime, input);
  await admit(runtime, { ...message("612", destination, String(number)), receivedAt: now + 2, reply });
  expect(store.lanes()).toHaveLength(5);
  expect(hosts.get(continuation.socketPath)?.prompts).toHaveLength(1);
  expect(searches).toEqual([input.text]); // no second recall on choice, dispatch or redelivery
  const held = { ...message("613", destination, "지난주 로그인 버그 보던 데서 계속해줘"), receivedAt: now + 3 };
  await admit(runtime, held);
  const second = store.output("613:workspace");
  if (!second?.remoteId) throw new Error("Expected a new, source-bound choice");
  const old = store.lane("two")!;
  store.updateLane(old.id, old.generation, { workState: "paused" });
  await admit(runtime, { ...message("614", destination, String(number)), receivedAt: now + 4,
    reply: { ...reply, messageId: second.remoteId } });
  expect(store.input("613")?.state).toBe("cancelled");
  expect(store.input("handoff:613:lane")).toBeNull();
  expect(store.lane("two")?.workState).toBe("paused");
  available = false;
  await admit(runtime, { ...message("615", destination, input.text), receivedAt: now + 5 });
  expect(store.output("615:workspace")?.text).toContain("조회하지 못해");
  expect(store.input("handoff:615:lane")).toBeNull();
  expect(errors.map(String).join("\n")).not.toContain("private-provider-diagnostic");
  expect(searches).toHaveLength(3);
});

test("ambiguous repository names wait for the owner's choice; a quote or another channel cannot supply it", async () => {
  const { runtime, store, main, hosts, config, directory } = fixture();
  for (const [id, name, destination] of [
    ["a", "client-ui", route("51")], ["b", "client-api", route("52")],
    ["c", "foreign-repo", route("53", { channelId: "99" })],
  ] as const) {
    const cwd = join(directory, name);
    mkdirSync(cwd);
    savedLane(store, { ...config, headCwd: cwd }, id, destination);
  }
  await runtime.start();
  const thread = route("54");
  const task = "client-ui랑 client-api의 변경을 비교해줘";
  await admit(runtime, message("540", thread, task));
  const question = store.output("540:workspace");
  if (!question?.remoteId) throw new Error("An ambiguous repository request was not held for clarification");
  const reply = { messageId: question.remoteId, text: "client-ui", authorId: null };
  await admit(runtime, { ...message("541", thread, "foreign-repo"), reply });
  expect(store.laneForRoute(thread)).toBeNull();
  expect(store.input("541")?.state).toBe("cancelled");
  await admit(runtime, { ...message("542", thread, "client-api"), reply });
  const lane = store.laneForRoute(thread);
  expect(lane?.cwd).toBe(join(directory, "client-api"));
  await admit(runtime, { ...message("543", thread, "client-ui"), reply });
  await admit(runtime, { ...message("542", thread, "client-ui"), id: "542:edit", reply });
  expect(store.input("543")?.state).toBe("cancelled");
  expect(hosts.get(lane!.socketPath)?.prompts.map(turn => turn.command.message)).toEqual([expect.stringContaining(task)]);
  await admit(runtime, message("544", route("56"), "Do not use client-api; start a new project"));
  expect(store.output("544:workspace")?.state).toBe("sent");
  expect(main.prompts).toEqual([]);
});

test("a reply in a Slack workspace question's thread selects the repository for the parent request only", async () => {
  const { runtime, config, directory, store, messenger, hosts } = fixture();
  config.slack = { botTokenEnv: "TEST_SLACK", appTokenEnv: "TEST_SLACK_APP", ownerId: "UOWNER", teamId: "TTEAM", allowedChannelIds: ["CCHANNEL"] };
  const parent: Route = { platform: "slack", authorityId: "UOWNER", accountId: "TTEAM:UBOT", guildId: "TTEAM", channelId: "CCHANNEL", threadId: null };
  const stamp = "1750000000.000001", question = "1750000001.000002";
  const send = messenger.send.bind(messenger);
  messenger.send = async output => {
    const id = await send(output);
    return output.id === `${stamp}:workspace` ? question : id;
  };
  messenger.createThread = async (route, _title, messageId) => ({ ...route, threadId: messageId ?? null });
  savedLane(store, config, "prior", { ...parent, threadId: "1750000000.000000" });
  await runtime.start();
  await admit(runtime, message(stamp, parent, "Inspect the failing tests"));
  expect(store.output(`${stamp}:workspace`)?.remoteId).toBe(question);
  const thread = { ...parent, threadId: question };
  await admit(runtime, message("1750000002.000003", thread, basename(directory)));
  await admit(runtime, message("1750000003.000004", thread, basename(directory)));
  const lane = store.laneForRoute({ ...parent, threadId: stamp });
  expect(lane?.cwd).toBe(directory);
  expect(hosts.get(lane!.socketPath)?.prompts.map(turn => turn.command.message)).toEqual([expect.stringContaining("Inspect the failing tests")]);
  expect(store.laneForRoute(thread)).toBeNull();
});

test("a new parent request can reuse the replied-to workspace but not its session or the quoted text", async () => {
  const { runtime, store, directory, main } = fixture();
  await runtime.start();
  const parent = route(null);
  await admit(runtime, message("550", parent, `cwd: ${directory}\nFirst task`));
  const notice = store.output("550:topic-bound");
  if (!notice?.remoteId) throw new Error("Original topic binding was not delivered");
  store.setMeta("discord:output-part:900000000000000001", notice.id);
  await admit(runtime, { ...message("551", parent, "거기서 문서도 확인해줘"),
    reply: { messageId: "900000000000000001", authorId: null, text: "cwd: /tmp" } });
  const lanes = store.lanes();
  expect(lanes.map(lane => lane.cwd)).toEqual([directory, directory]);
  expect(new Set(lanes.map(lane => lane.sessionFile)).size).toBe(2);
  expect(store.output("551:workspace")).toBeNull();
  await admit(runtime, { ...message("552", route("55"), "관련 작업 하나 더"),
    reply: { messageId: notice.remoteId, authorId: null, text: directory } });
  expect(store.output("552:workspace")?.state).toBe("sent");
  expect(store.lanes()).toHaveLength(2);
  expect(main.prompts).toEqual([]);
});

test("editing a placed request cannot fork a sibling or move the task into global coordination", async () => {
  const { runtime, store, main, messenger, directory, hosts } = fixture();
  const original = { ...message("430", route("43")), text: `cwd: ${directory}\nInspect A` };
  await runtime.start();
  await runtime.receive(original);
  await runtime.kick();
  const owner = store.laneForRoute(original.route);
  if (!owner) throw new Error("Original request did not establish its topic");
  for (const [id, text] of [["431", "/head include A's prior context"], ["432", `cwd: /tmp\nWork on B instead`]] as const) {
    await runtime.receive({ ...original, id, text });
    await runtime.kick();
    expect(store.input(id)?.state).toBe("done");
    expect(store.output(`${id}:topic`)?.state).toBe("sent");
  }
  expect(hosts.get(owner.socketPath)?.prompts).toHaveLength(1);
  expect(store.lanes().map(lane => lane.id)).toEqual([owner.id]);
  expect(messenger.threads).toEqual([]);
  expect(main.prompts).toEqual([]);
});

test("stop selects one pending topic and cannot abort HEAD or another workspace request", async () => {
  const { runtime, store, main, directory } = fixture();
  const parent = route(null);
  await runtime.start();
  await admit(runtime, headMessage("440", route("44"), "Coordinate other work"));
  await admit(runtime, message("441", parent, "First project"));
  await admit(runtime, message("442", parent, "Second project"));
  await admit(runtime, message("443", parent, "/stop"));
  expect([store.input("441")?.state, store.input("442")?.state]).toEqual(["pending", "pending"]);
  const question = store.output("442:workspace");
  if (!question?.remoteId) throw new Error("Missing second workspace question");
  await admit(runtime, { ...message("444", parent, "/stop"),
    reply: { messageId: question.remoteId, authorId: null, text: "" } });
  expect([store.input("441")?.state, store.input("442")?.state]).toEqual(["pending", "cancelled"]);

  const lookup = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  main.beforeCatalog = async () => { lookup.resolve(); await release.promise; };
  const topic = route("45");
  await runtime.receive(message("445", topic, `cwd: ${directory}\nRun task`));
  await lookup.promise;
  try {
    await runtime.receive(message("446", topic, "/stop"));
    expect(store.input("445")?.state).toBe("cancelled");
  } finally { release.resolve(); }
  await runtime.kick();
  expect(store.laneForRoute(topic)).toBeNull();
  expect(store.input("440")?.state).toBe("submitted");
  expect(main.abortCount).toBe(0);
});

test("a fresh DM reserves one topic before placement, and an edited boundary cannot stop it", async () => {
  const { runtime, store, main, messenger, directory, hosts } = fixture();
  const dm = route(null, { guildId: null });
  messenger.canCreateThread = async () => false;
  await runtime.start();
  await admit(runtime, message("451", dm, "Work on A"));
  await admit(runtime, message("452", dm, "Check a second detail"));
  const topic = store.input("451")?.route;
  expect(topic?.topicId).toBeTruthy();
  expect(store.input("452")?.route).toEqual(topic);
  await admit(runtime, message("453", dm, `cwd: ${directory}`));
  const lane = store.lanes()[0];
  if (!lane) throw new Error("DM work did not start");
  expect(hosts.get(lane.socketPath)?.prompts).toHaveLength(2);
  await expect(runtime.messageLane(lane.id, "duplicate manager handoff", "handoff:451:lane")).rejects.toThrow("Topic-owned");
  expect(main.prompts).toEqual([]);
  const boundary = message("460", dm, "/new");
  await admit(runtime, boundary);
  await admit(runtime, message("461", dm, "Work on B"));
  await admit(runtime, { ...boundary, id: "460:edit", text: "/stop" });
  expect(store.input("461")?.state).toBe("pending");
  expect(store.output("460:edit:topic")?.state).toBe("sent");
});

test("uncertain creation of a sibling cannot stall followup work in the already bound topic", async () => {
  const { runtime, store, main, messenger, directory, hosts } = fixture();
  const thread = route("47");
  await runtime.start();
  await admit(runtime, message("471", thread, `cwd: ${directory}\nInspect project A`));
  const a = store.laneForRoute(thread);
  if (!a) throw new Error("Missing original lane");
  messenger.threadFails = true;
  await admit(runtime, message("472", thread, `/new cwd: ${directory}\nSeparate investigation`));
  expect(store.input("472")?.state).toBe("uncertain");
  await admit(runtime, message("473", thread, "Continue the original inspection"));
  expect(hosts.get(a.socketPath)?.prompts[1]?.command.message).toContain("Continue the original inspection");
  expect(store.input(`handoff:473:${a.id}`)?.state).toBe("submitted");
  expect(store.lanes()).toHaveLength(1);
  expect(main.prompts).toEqual([]);
});

describe("ordinary placement in owner parents without native threads", () => {
  test.each(["telegram", "discord"] as const)("%s places independent requests without moving their source or result", async platform => {
    const { runtime, config, directory, store, messenger, main, hosts } = fixture();
    const chat = "-1001234567890";
    config.telegram = { tokenEnv: "TEST_TELEGRAM_TOKEN", ownerId: "1", allowedChatIds: [chat] };
    const parent = route(null, platform === "telegram" ? { platform, guildId: chat, channelId: chat } : {});
    const nextDirectory = join(directory, "independent-project");
    mkdirSync(nextDirectory);
    messenger.canCreateThread = async () => false;
    await runtime.start();

    const first = message("9101", parent, `cwd: ${directory}\nInspect the parser`);
    await admit(runtime, first);
    const [lane] = store.lanes();
    const worker = lane && hosts.get(lane.socketPath);
    if (!lane || !worker) throw new Error("The plain parent did not establish a topic worker");
    expect(lane.route.topicId).toBeTruthy();
    expect(physicalRouteKey(lane.route)).toBe(physicalRouteKey(parent));
    expect(store.input(first.id)).toMatchObject({ state: "done", target: null, route: parent });
    expect(store.output(`${first.id}:kickoff`)).toMatchObject({ state: "sent", route: lane.route });
    expect(worker.prompts[0]?.command.message).toContain("Inspect the parser");
    worker.complete("Parser inspected.");
    await messenger.whenSent(2);
    await runtime.kick();
    expect(store.output(`handoff:${first.id}:lane:answer`)).toMatchObject({
      state: "sent", sourceId: first.id, route: parent, text: "Parser inspected.",
    });

    await admit(runtime, message("9102", parent, `cwd: ${nextDirectory}\nReview the updater`));
    const secondLane = store.lanes().find(item => item.cwd === nextDirectory);
    expect(secondLane?.sessionFile).not.toBe(lane.sessionFile);
    expect(secondLane?.route.topicId).toBeTruthy();
    expect(secondLane?.route.topicId).not.toBe(lane.route.topicId);
    expect(main.prompts).toEqual([]);
    expect(messenger.threadSources).toEqual([]);
  });

  test("a parent reply uses the exact topic receipt unless the owner selects a different workspace", async () => {
    const { runtime, config, directory, store, messenger, main, hosts } = fixture();
    const parent = route(null, { platform: "telegram", guildId: "-1001234567890", channelId: "-1001234567890" });
    config.telegram = { tokenEnv: "TEST_TELEGRAM_TOKEN", ownerId: "1", allowedChatIds: [parent.channelId] };
    const nextDirectory = join(directory, "other-project");
    mkdirSync(nextDirectory);
    messenger.canCreateThread = async () => false;
    await runtime.start();

    const original = message("9111", parent, `cwd: ${directory}\nInspect the parser`);
    await admit(runtime, original);
    const [lane] = store.lanes();
    const worker = lane && hosts.get(lane.socketPath);
    if (!lane || !worker) throw new Error("Missing parent placement worker");
    worker.complete("Parser inspected.");
    await messenger.whenSent(2);
    await runtime.kick();
    const result = store.output("handoff:9111:lane:answer");
    if (!result?.remoteId) throw new Error("Missing parent result receipt");
    const reply = { messageId: result.remoteId, authorId: parent.accountId, text: result.text };
    const followup = { ...message("9112", parent, "Check the enum branch too"), reply };
    await admit(runtime, followup);
    const followupId = `handoff:${followup.id}:${lane.id}`;
    expect(store.input(followup.id)?.route).toEqual(lane.route);
    expect(store.input(followupId)).toMatchObject({ target: lane.id, route: lane.route, state: "submitted" });
    expect(worker.prompts[1]?.command.message).toContain("Check the enum branch too");

    const newWork = { ...message("9113", parent, `cwd: ${nextDirectory}\nInspect the unrelated updater`), reply };
    await admit(runtime, newWork);
    const next = store.lanes().find(item => item.cwd === nextDirectory);
    if (!next) throw new Error("Missing switched workspace placement");
    expect(store.input(newWork.id)?.route).toEqual(parent);
    expect(store.input(`handoff:${newWork.id}:lane`)).toMatchObject({ target: next.id, route: next.route });
    expect(worker.prompts).toHaveLength(2);

    await admit(runtime, { ...followup, id: "9112:edit", text: "Check the parser enum",
      reply: { messageId: newWork.messageId, authorId: original.route.authorityId, text: "" } });
    expect(store.input("9112:edit")?.route).toEqual(lane.route);
    expect(store.getMeta("topic-owner:9112:edit")).toBe(lane.id);
    expect(main.prompts).toEqual([]);
  });

  test("a reply to the original request stops and resumes only its logical topic", async () => {
    const { runtime, config, directory, store, messenger, main } = fixture();
    const parent = route(null, { platform: "telegram", guildId: "-1001234567890", channelId: "-1001234567890" });
    config.telegram = { tokenEnv: "TEST_TELEGRAM_TOKEN", ownerId: "1", allowedChatIds: [parent.channelId] };
    messenger.canCreateThread = async () => false;
    await runtime.start();

    const original = message("9121", parent, `cwd: ${directory}\nInspect the parser`);
    await admit(runtime, original);
    const [lane] = store.lanes();
    if (!lane) throw new Error("Missing logical parent lane");
    const reply = { messageId: original.messageId, authorId: parent.authorityId, text: original.text };
    await admit(runtime, { ...message("9122", parent, "/stop"), reply });
    await messenger.whenSent(2);
    expect(store.lane(lane.id)?.workState).toBe("paused");
    expect(main.abortCount).toBe(0);

    await admit(runtime, { ...message("9123", parent, "/resume"), reply });
    await messenger.whenSent(3);
    expect(store.input("9123")).toMatchObject({ state: "done", route: lane.route });
    expect(store.lane(lane.id)?.workState).toBe("open");
    expect(main.prompts).toEqual([]);
  });

  test.each(["probe-failed", "mutation-uncertain"] as const)("never makes a logical topic after %s", async failure => {
    const { runtime, config, directory, store, messenger, main } = fixture();
    const parent = route(null, { platform: "telegram", guildId: "-1001234567890", channelId: "-1001234567890" });
    config.telegram = { tokenEnv: "TEST_TELEGRAM_TOKEN", ownerId: "1", allowedChatIds: [parent.channelId] };
    messenger.canCreateThread = async () => {
      if (failure === "probe-failed") throw new DeliveryError("Capability check failed", "uncertain");
      return true;
    };
    messenger.threadFails = true;
    await runtime.start();
    const original = message("9131", parent, `cwd: ${directory}\nInspect the parser`);
    await admit(runtime, original);
    messenger.canCreateThread = async () => false;
    await admit(runtime, original);

    expect(store.input(original.id)).toMatchObject({ state: "uncertain", route: parent });
    expect(store.lanes()).toEqual([]);
    expect(store.output(`${original.id}:kickoff`)).toBeNull();
    expect(store.getMeta(`handoff-route:${original.id}`)).toBe(failure === "mutation-uncertain" ? "uncertain" : null);
    expect(messenger.threadSources).toEqual(failure === "mutation-uncertain" ? [original.messageId] : []);
    expect(main.prompts).toEqual([]);
  });

  test("a manual request for a native sibling does not become a parent logical topic", async () => {
    const { runtime, directory, store, messenger } = fixture();
    const parent = route(null);
    messenger.canCreateThread = async () => false;
    await runtime.start();
    const original = headMessage("9141", route("42"));
    await admit(runtime, original);

    const start = { ...selection, sourceId: original.id, title: "Native sibling",
      kickoff: "Inspect the repository.", cwd: directory };
    await expect(runtime.startLane({ ...start, destination: { ...parent, topicId: "not-an-owner-topic" } }))
      .rejects.toThrow("ordinary owner intake");
    await expect(runtime.startLane({ ...start, destination: parent })).rejects.toThrow("independent native thread");
    expect(store.lanes()).toEqual([]);
    expect(store.input(original.id)?.route).toEqual(original.route);
    expect(store.output(`${original.id}:kickoff`)).toBeNull();
  });

  test("logical routing does not authorize unlisted, foreign, or threaded Telegram destinations", async () => {
    const { runtime, config, store } = fixture();
    const parent = route(null, { platform: "telegram", guildId: "-1001234567890", channelId: "-1001234567890" });
    const restricted = "-1009876543210";
    config.telegram = { tokenEnv: "TEST_TELEGRAM_TOKEN", ownerId: "1", allowedChatIds: [parent.channelId] };
    const logical = { ...parent, topicId: "some-work" };
    for (const destination of [
      { ...logical, guildId: restricted, channelId: restricted },
      { ...logical, guildId: "-1001001001001", channelId: "-1001001001001" },
      { ...logical, authorityId: "99" },
      { ...logical, threadId: "7" },
    ]) {
      await expect(runtime.receive(message("9151", destination))).rejects.toThrow(/not authorized|Unauthorized/);
    }
    expect(store.input("9151")).toBeNull();
  });
});
