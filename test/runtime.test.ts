import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Effort } from "../.upstream/omp/packages/catalog/src/effort";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Approval, DialogResponse, Inbound, Lane, LaneModel, LanePresetSnapshot, ResolvedLanePreset, Messenger, OutputRecord, Route } from "../src/contracts";
import { physicalRouteKey, routeKey, WORKFLOW_NAMES } from "../src/contracts";
import { containsMagicKeyword } from "../.upstream/omp/packages/tui/src/prompt/magic-keywords";
import { type Config, hostPaths } from "../src/config";
import type { HostOptions } from "../src/host";
import { DeliveryError } from "../src/delivery";
import { compareMessageIds } from "../src/message-order";
import { Superagent, type RuntimeHost, type RuntimeState } from "../src/runtime";
import { Store } from "../src/store";

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
  beforeSetModel?: () => Promise<void> | void;
  modelSetResult: "success" | "throw-before" | "throw-after" | "mismatch" = "success";
  state: RuntimeState;

  constructor(sessionFile: string, sessionId: string, model: LaneModel | null = executionModel) {
    this.state = { sessionFile, sessionId, model, settingsScope: "session",
      modelSettings: { modelRoles: { default: "fixture/capable", smol: "fixture/efficient" }, defaultThinkingLevel: Effort.High },
      hostPid: process.pid, isSettled: true, isStreaming: false, hasOwnedRunningWork: false, pendingUiRequests: [], goal: null };
    const deferred = Promise.withResolvers<void>();
    this.exited = deferred.promise;
    this.exit = () => deferred.resolve();
  }
  client = {
    getState: async () => structuredClone(this.state),
    abortAndRestoreQueue: async () => {
      if (this.abortFails) throw new Error("native abort failed");
      this.state.isStreaming = false;
      this.state.isSettled = true;
    },
    getSubagents: async () => this.children,
    cancelSubagent: async (id: string) => { this.cancelled.push(id); },
  };
  async request(command: Record<string, unknown>, id?: string): Promise<unknown> {
    this.commands.push(command);
    if (command.type === "get_available_models") {
      await this.beforeCatalog?.();
      return { success: this.catalogSuccess, data: { models: structuredClone(this.models) } };
    }
    if (command.type === "get_available_commands") {
      await this.beforeCapabilities?.();
      return { success: true, data: { commands: this.workflowAvailable ? WORKFLOW_NAMES.map(name => ({
        name, source: "extension", description: `Run the OMP-adapted ${name} workflow`,
      })) : [] } };
    }
    if (command.type === "set_model" || command.type === "set_model_preset") {
      await this.beforeSetModel?.();
      if (this.modelSetResult === "throw-before") throw new Error("Native model request transport outcome unknown");
      if (this.state.settingsScope !== "session") return { success: false, error: "Session-isolated settings required" };
      if (this.modelSetResult !== "mismatch") {
        if (command.type === "set_model_preset") {
          const preset = structuredClone(command.preset) as LanePresetSnapshot;
          const model = [executionModel, otherModel].find(model => `${model.provider}/${model.id}` === preset.modelRoles.default);
          if (!model) throw new Error("Fixture native preset has no exact available default");
          this.state.model = { ...model };
          this.state.modelSettings = { modelRoles: { ...preset.modelRoles }, defaultThinkingLevel: preset.defaultThinkingLevel ?? this.state.modelSettings?.defaultThinkingLevel };
        } else this.state.model = { provider: String(command.provider), id: String(command.modelId) };
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
      if (!this.local) {
        this.state.isSettled = false;
        this.state.isStreaming = true;
        this.emit({ type: "agent_start" });
      }
      return { success: true, data: { agentInvoked: !this.local } };
    }
    if (command.type === "goal") { this.state.goal = null; return { success: true, data: {} }; }
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
  readonly backlog = new Map<string, Inbound[] | null>();
  readonly threads: Route[] = [];
  private sendWaiters: Array<{ count: number; resolve: () => void }> = [];
  private approvalWaiters: Array<() => void> = [];
  threadFails = false;
  sendError?: Error;
  onStart?: (handlers: Handlers) => void;
  openAttachment: Messenger["openAttachment"] = async () => { throw new Error("No test attachment is authorized"); };
  async start(handlers: Handlers): Promise<void> { this.handlers = handlers; this.onStart?.(handlers); }
  async send(output: OutputRecord): Promise<string> {
    if (!this.handlers) throw new Error("Messenger must start before send");
    this.attempted.push(output);
    if (this.sendError) throw this.sendError;
    this.sent.push(output);
    for (const waiter of this.sendWaiters) if (this.sent.length >= waiter.count) waiter.resolve();
    return `remote-${output.id}`;
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
  async createThread(route: Route): Promise<Route> {
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
const message = (id: string, destination = route(), text = `task ${id}`): Inbound => ({
  id, route: destination, messageId: id, text, receivedAt: 100, attachments: [],
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

function fixture(maxHosts = 3, openAttachment?: Messenger["openAttachment"]) {
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
  const launchBehavior: { model?: LaneModel | null; pid?: number } = {};
  const nativePresets = new Map<string, ResolvedLanePreset>([
    ["high", { model: executionModel, preset: "high", snapshot: { modelRoles: { default: "fixture/capable", smol: "fixture/efficient" }, defaultThinkingLevel: Effort.High } }],
    ["low", { model: otherModel, preset: "low", snapshot: { modelRoles: { default: "fixture/efficient", smol: "fixture/efficient" }, defaultThinkingLevel: Effort.Low } }],
  ]);
  const errors: unknown[] = [];
  const runtime = new Superagent(config, store, messenger, join(directory, "extension.ts"), error => errors.push(error), {
    resolvePreset: async name => {
      const preset = nativePresets.get(name);
      if (!preset) throw new Error("Native preset is not configured");
      return structuredClone(preset);
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
      if (options.modelPreset) host.state.modelSettings = structuredClone(options.modelPreset.preset);
      hosts.set(options.socketPath, host);
      if (!existsSync(options.sessionFile)) writeFileSync(options.sessionFile, JSON.stringify({ type: "session", version: 3, id: host.state.sessionId, cwd: options.cwd }) + "\n");
      return { pid: launchBehavior.pid ?? process.pid };
    },
  });
  fixtures.push({ runtime, directory });
  return { runtime, config, directory, store, messenger, main, hosts, launched, errors, launchBehavior, nativePresets };
}

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

describe("trusted workflow activation", () => {
  test("preserves real user leading invocation, original route/request, and deduplicates redelivery", async () => {
    const { runtime, store, main } = fixture();
    await runtime.start();
    const original = { ...message("workflow-user", route(null, { guildId: null }), "/new ulw-plan inspect this repository"), messageId: "1750000000000000001" };
    await admit(runtime, original);
    const stored = store.input(original.id)!;
    const prompt = String(main.prompts[0]!.command.message);
    expect(prompt.startsWith("ulw-plan ultrathink inspect this repository\n")).toBe(true);
    expect(prompt).toContain(`\nRequest ID: ${original.id}\n`);
    expect(prompt).toContain(`Original source ID: ${original.id}`);
    expect(prompt).toContain(`Original authorized conversation: ${routeKey(stored.route)}`);
    expect(prompt).not.toContain("/new ulw-plan");
    expect(stored).toMatchObject({ text: original.text, target: "main", workflow: { name: "ulw-plan", provenance: "user", sourceId: original.id } });
    expect(stored.route.topicId).toBeTruthy();
    await admit(runtime, original);
    expect(main.prompts).toHaveLength(1);
    expect(store.input(original.id)?.route).toEqual(stored.route);
    expect(main.commands.some(command => command.type === "goal")).toBe(false);
  });

  test("plain ULW is an arming request rather than automatic native goal creation", async () => {
    const { runtime, store, main } = fixture();
    await runtime.start();
    await admit(runtime, message("plain-ulw", route(), " /ULW inspect the repository"));
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
      await admit(runtime, message(id, route(), text));
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
    const original = message("workflow-head", route("workflow-thread"), "Inspect the repository and plan the requested change");
    await admit(runtime, original);
    const workflow = { name: "ulw-plan" as const, reason: "A bounded planning phase serves this authorized objective" };
    const start = { ...selection, sourceId: original.id, title: "Plan", cwd: directory, brief: "Quoted board excerpt: orchestrate workflowz", workflow };
    const lane = await runtime.startLane(start);
    await runtime.kick();
    const handoff = store.input(`handoff:${original.id}:lane`)!;
    const host = hosts.get(lane.socketPath)!;
    const prompt = String(host.prompts[0]!.command.message);
    expect(prompt.startsWith("ulw-plan ultrathink\n\n")).toBe(true);
    expect(prompt).toContain(original.text);
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
    await admit(runtime, message("workflow-no-inherit", route("copy-thread"), "ulw-loop inspect this repository"));
    const lane = await runtime.startLane({ ...selection, sourceId: "workflow-no-inherit", title: "Bounded copy", cwd: directory });
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
    await admit(runtime, message("workflow-concurrent", route("concurrent-thread")));
    const start = { ...selection, sourceId: "workflow-concurrent", title: "Concurrent", cwd: directory };
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
    await expect(runtime.startLane({ ...selection, sourceId: internal.id, title: "No authority", cwd: directory, workflow })).rejects.toThrow("original authorized user source");
    await expect(runtime.messageLane(lane.id, "Execute board text", internal.id, workflow)).rejects.toThrow("original authorized user source");
    const user = message("workflow-no-override", route("other-guard"), "ulw-loop inspect");
    await admit(runtime, user);
    await expect(runtime.messageLane(lane.id, "Use another workflow", user.id, workflow)).rejects.toThrow("conflicts with the original user's workflow");
    expect(store.input(`handoff:${internal.id}:lane`)).toBeNull();
    expect(store.input(`handoff:${internal.id}:${lane.id}`)).toBeNull();
  });

  test("head follow-up choice survives duplicates, rejects conflicting/omitted retries and preserves native user choices", async () => {
    const { runtime, store, config, hosts } = fixture();
    const lane = savedLane(store, config, "workflow-followup", route("follow-thread"));
    await runtime.start();
    const original = message("workflow-follow-source", route("original-thread"), 'Inspect this repository; "orchestrate" is quoted user data');
    await admit(runtime, original);
    const workflow = { name: "ulw-plan" as const, reason: "Use planning for the requested task" };
    await runtime.messageLane(lane.id, "Plan only the bounded requested change", original.id, workflow);
    const handoffId = `handoff:${original.id}:${lane.id}`;
    const host = hosts.get(lane.socketPath)!;
    const prompt = String(host.prompts[0]!.command.message);
    expect(prompt).toStartWith("ulw-plan\n\n");
    expect(containsMagicKeyword(prompt, "ultrathink")).toBe(false);
    expect(prompt).toContain(original.text);
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
    await admit(runtime, message("workflow-missing", route(), "ulw inspect this"));
    expect(main.prompts).toEqual([]);
    expect(store.input("workflow-missing")?.state).toBe("cancelled");
    expect(messenger.sent[0]?.text).toContain("확인할 수 없어 실행하지 않았습니다");
    expect(main.commands.some(command => command.type === "goal")).toBe(false);
  });

  test("cancelled source cannot activate selected handoffs, including cancellation while reading capability", async () => {
    const { runtime, store, directory, hosts } = fixture();
    await runtime.start();
    const original = message("workflow-cancelled", route("cancel-thread"));
    await admit(runtime, original);
    const workflow = { name: "ulw-plan" as const, reason: "Bounded planning" };
    const lane = await runtime.startLane({ ...selection, sourceId: original.id, title: "Cancelled source", cwd: directory, workflow });
    const host = hosts.get(lane.socketPath);
    if (host) {
      host.complete("First source result");
      await runtime.kick();
    }
    store.settle(original.id, "cancelled");
    await expect(runtime.messageLane(lane.id, "Do not run", original.id, workflow)).rejects.toThrow("cancelled");
    await expect(runtime.startLane({ ...selection, sourceId: original.id, title: "No retry", cwd: directory, workflow })).rejects.toThrow("cancelled");

    const other = fixture();
    await other.runtime.start();
    other.main.beforeCapabilities = () => { other.store.settle("workflow-cancel-race", "cancelled"); };
    await admit(other.runtime, message("workflow-cancel-race", route(), "ulw inspect"));
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
    await admit(runtime, message("2001", route("21")));
    await admit(runtime, message("2002", route("22")));
    const one = await runtime.startLane({ ...selection, sourceId: "2001", title: "Complex", cwd: directory });
    const reason = "Native judge selected the efficient model for a bounded documentation task.";
    const two = await runtime.startLane({ sourceId: "2002", title: "Bounded", cwd: directory, model: otherModel, modelReason: reason });
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
    ]) await expect(runtime.startLane({ ...selection, sourceId: source.id, title: "Invalid", cwd: directory, model })).rejects.toThrow("not an available native chat model");
    await expect(runtime.startLane({ ...selection, sourceId: source.id, title: "Invalid", cwd: directory, modelReason: " " })).rejects.toThrow("modelReason");
    main.catalogSuccess = false;
    await expect(runtime.startLane({ ...selection, sourceId: source.id, title: "No native acknowledgement", cwd: directory })).rejects.toThrow("not acknowledged");
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
    await admit(runtime, message("2020", route("23")));
    const first = runtime.startLane({ ...selection, sourceId: "2020", title: "Original", cwd: directory });
    const conflict = runtime.startLane({ ...selection, sourceId: "2020", title: "Conflicting", cwd: directory, model: otherModel });
    const lane = await first;
    await expect(conflict).rejects.toThrow("conflicts");
    await expect(runtime.startLane({ ...selection, sourceId: "2020", title: "Replay conflict", cwd: directory, model: otherModel })).rejects.toThrow("different model");
    expect(store.lane(lane.id)).toMatchObject(selection);
    expect(store.lanes()).toHaveLength(1);
  });

  test("resolved preset identities are snapshotted before asynchronous lane selection", async () => {
    const { runtime, store, main, directory } = fixture();
    await runtime.start();
    await admit(runtime, message("2025", route("38")));
    const catalogStarted = Promise.withResolvers<void>();
    const releaseCatalog = Promise.withResolvers<void>();
    main.beforeCatalog = async () => {
      main.beforeCatalog = undefined;
      catalogStarted.resolve();
      await releaseCatalog.promise;
    };
    const preset = { ...executionModel };
    const selecting = runtime.startLane({ ...selection, sourceId: "2025", title: "Preset snapshot", cwd: directory, model: preset });
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
    await admit(runtime, message("2200", route("60")));
    const lane = await runtime.startLane({ sourceId: "2200", title: "Frozen native preset", cwd: directory, preset: "high", modelReason: "Native judge recommends the saved high preset." });
    await runtime.kick();
    expect(store.lane(lane.id)).toMatchObject({ model: saved.model, modelPreset: "high", modelPresetSnapshot: saved.snapshot });
    expect(launched[0]?.modelPreset).toEqual({ name: "high", preset: saved.snapshot });
    expect(launched[0]?.model).toBe("fixture/capable");
    const host = hosts.get(lane.socketPath)!;
    host.shutdownDisconnect = true;
    host.complete("First native preset execution");
    await runtime.kick();
    expect(messenger.sent).toEqual([]);
    await runtime.kick();
    await runtime.closeLane(lane.id, "completed", "Observed first preset execution complete");
    nativePresets.set("high", { ...structuredClone(nativePresets.get("low")!), preset: "high" });
    expect(await runtime.startLane({ sourceId: "2200", title: "Original source replay", cwd: directory, preset: "high", modelReason: "Do not retarget an existing source." }))
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
    expect(host.commands.map(command => command.type)).toEqual(["set_model", "prompt"]);
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
    await runtime.receive(message("2221", lane.route));
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
    await admit(runtime, message("2230", route("65")));
    expect(await runtime.startLane({ sourceId: "2230", title: "Custom native preset", cwd: directory, preset: "my-team-coding", modelReason: "Use an existing operator native preset." })).toMatchObject({ modelPreset: "my-team-coding", model: executionModel });
    store.receive(message("2231", route(null)), "main");
    store.submit("2231", "already-head-owned", 0);
    await expect(runtime.startLane({ sourceId: "2231", title: "Missing preset", cwd: directory, preset: "missing-native-name", modelReason: "No fallback is authorized." })).rejects.toThrow("not configured");
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
  test("Slack DM boundaries follow exact timestamps across late intake, edits, and immutable command replay", async () => {
    const { runtime, config, store, directory } = fixture();
    delete config.discord;
    config.slack = { botTokenEnv: "TEST_SLACK_BOT_TOKEN", appTokenEnv: "TEST_SLACK_APP_TOKEN", ownerId: "UOWNER", teamId: "TTEAM", allowedChannelIds: ["CCHANNEL"] };
    const dm = route(null, { platform: "slack", accountId: "TTEAM:UBOT", authorityId: "UOWNER", guildId: null, channelId: "DPRIVATE" });
    const event = (suffix: string, text: string, receivedAt = 100): Inbound => ({
      ...message(`slack:${suffix}`, dm, text), messageId: `1750000000.${suffix}`, receivedAt,
    });
    await runtime.start();
    const firstRequest = event("000002", "/new first task", 500);
    await admit(runtime, firstRequest);
    const first = await runtime.startLane({ ...selection, sourceId: firstRequest.id, title: "Slack first", cwd: directory });
    await admit(runtime, event("000004", "/main", 1));
    await admit(runtime, event("000003", "Late first topic followup", 900));
    expect(store.input("slack:000003")).toMatchObject({ target: "main", route: first.route });
    await admit(runtime, { ...event("000003", "Edited first topic followup"), id: "slack:000003:edited" });
    expect(store.input("slack:000003:edited")).toMatchObject({ target: "main", route: first.route });
    await admit(runtime, event("000001", "Historical main request", 999));
    expect(store.input("slack:000001")?.target).toBe("main");
    await admit(runtime, event("000005", "Current main request", 0));
    expect(store.input("slack:000005")?.route).toEqual(dm);
    await admit(runtime, firstRequest);
    expect(store.getMeta(`dm:active:${physicalRouteKey(dm)}`)).toBe("");
    expect(store.input(firstRequest.id)?.target).toBe("main");
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
    expect(store.input(firstRequest.id)?.target).toBe("main");
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
    const { runtime, config, store, directory, messenger } = fixture();
    config.slack = { botTokenEnv: "TEST_SLACK_BOT_TOKEN", appTokenEnv: "TEST_SLACK_APP_TOKEN", ownerId: "UOWNER", teamId: "TTEAM", allowedChannelIds: [] };
    const dm = route(null, { platform: "slack", accountId: "TTEAM:UBOT", authorityId: "UOWNER", guildId: null, channelId: "DPRIVATE" });
    await runtime.start();
    await admit(runtime, { ...message("slack:head", dm), messageId: "1750000000.000001" });
    const delegated = await runtime.startLane({ ...selection, sourceId: "slack:head", title: "Handoff", cwd: directory });
    expect(store.input("slack:head")).toMatchObject({ target: "main", state: "submitted", route: dm });
    expect(store.input("handoff:slack:head:lane")?.target).toBe(delegated.id);
    expect(delegated.route.threadId).toBeNull();
    expect(delegated.route.topicId).toBeTruthy();
    const threaded = { ...dm, threadId: "1750000000.000100" };
    await admit(runtime, { ...message("slack:thread", threaded, "Independent native DM thread"), messageId: "1750000000.000101" });
    expect(store.input("slack:thread")).toMatchObject({ target: "main", route: threaded });
    expect(store.input("slack:thread")?.route.topicId).toBeUndefined();
    expect(physicalRouteKey(threaded)).not.toBe(physicalRouteKey(dm));
    expect(messenger.threads).toEqual([]);
  });

  test("Telegram negative group chats and real forum topic IDs keep independent native lanes", async () => {
    const { runtime, config, store, directory, hosts, messenger } = fixture();
    delete config.discord;
    config.telegram = { tokenEnv: "TEST_TELEGRAM_TOKEN", ownerId: "1", allowedChatIds: ["-1001234567890"] };
    const firstRoute = route("42", { platform: "telegram", guildId: "-1001234567890", channelId: "-1001234567890" });
    const secondRoute = { ...firstRoute, threadId: "43" };
    await runtime.start();
    await admit(runtime, message("901", firstRoute));
    await admit(runtime, message("902", secondRoute));
    const first = await runtime.startLane({ ...selection, sourceId: "901", title: "Forum one", cwd: directory });
    const second = await runtime.startLane({ ...selection, sourceId: "902", title: "Forum two", cwd: directory });
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
    expect(messenger.sent).toEqual([]);
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
    await admit(runtime, message("secret-source", route(null, { guildId: null })));
    const frame = { type: "extension_ui_request", method: "input", id: "secret-dialog", title: "Credential", secret: true };
    main.state.pendingUiRequests = [frame];
    main.emit(frame);
    await runtime.kick();
    expect(main.responses).toContainEqual({ id: frame.id, response: { cancelled: true } });
    expect(messenger.shown.size).toBe(0);
    expect(store.approvals()).toEqual([]);
  });

  test("unknown topics enter head directly and lane selection never rebinds queued followups", async () => {
    const { runtime, store, main, messenger, directory } = fixture();
    await runtime.start();
    await admit(runtime, message("100"));
    expect(store.input("100")).toMatchObject({ target: "main", state: "submitted" });
    expect(store.input("route:100")).toBeNull();
    expect(main.prompts[0]!.command.message).toContain("sourceId: 100");
    await admit(runtime, message("100-followup"));
    expect(main.prompts).toHaveLength(1);
    expect(messenger.sent).toEqual([]);
    const lane = await runtime.startLane({ ...selection, sourceId: "100", title: "Topic", cwd: directory });
    await runtime.kick();
    expect(store.input("100")?.target).toBe("main");
    expect(store.input("100-followup")).toMatchObject({ target: "main", state: "pending" });
    expect(store.input("handoff:100:lane")?.target).toBe(lane.id);
    expect(messenger.threads).toEqual([]);
    expect(lane.cwd).toBe(directory);
    expect(await runtime.startLane({ ...selection, sourceId: "100", title: "Replay", cwd: directory })).toMatchObject({ id: lane.id, title: "Topic" });
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
    const original = message("cross-channel-source", route(null, { channelId: "5" }), "Ask the existing lane for its result here");
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

  test("bound followups enter head with compact lane context and direct answers never wake lanes", async () => {
    const { runtime, store, config, main, messenger, launched } = fixture();
    const one = savedLane(store, config, "head-context-one", route("71"));
    const two = savedLane(store, config, "head-context-two", route("72"));
    store.updateLane(one.id, 0, { workState: "paused", result: "Private full lane transcript must not enter the head prompt" });
    await runtime.start();
    await admit(runtime, message("head-first-one", one.route, "Answer this question here"));
    await admit(runtime, message("head-first-two", two.route, "Answer the other question there"));
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
    expect(store.lane(one.id)?.workState).toBe("paused");
  });

  test("explicit bound followup handoff retains attachments and source idempotency without retargeting head", async () => {
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
    const opened: Route[] = [];
    const { runtime, store, config, hosts, main, messenger } = fixture(3, async destination => {
      opened.push(destination);
      return new Response(png);
    });
    const lane = savedLane(store, config, "explicit-files", route("73"));
    const input = { ...message("explicit-file-source", lane.route, "Inspect the attached image"), attachments: [
      { id: "file-73", name: "image.png", url: "https://cdn.discordapp.com/attachments/73/file.png?ex=1&hm=first", size: png.length },
    ] };
    await runtime.start();
    await admit(runtime, input);
    expect(main.prompts).toHaveLength(1);
    expect(hosts.get(lane.socketPath)).toBeUndefined();
    await runtime.messageLane(lane.id, "Inspect this source image in the selected repository", input.id);
    const handoffId = `handoff:${input.id}:${lane.id}`;
    expect(store.input(input.id)).toMatchObject({ target: "main", state: "submitted", route: input.route });
    expect(store.input(handoffId)).toMatchObject({ target: lane.id, state: "submitted", attachments: input.attachments });
    const host = hosts.get(lane.socketPath)!;
    expect(host.prompts[0]!.command.images).toEqual([{ type: "image", data: png.toString("base64"), mimeType: "image/png" }]);
    expect(String(host.prompts[0]!.command.message)).not.toContain("hm=first");
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

  test("first independent head input starts in its existing topic and cancelled work cannot delegate", async () => {
    const { runtime, store, directory, messenger, hosts } = fixture();
    await runtime.start();
    await admit(runtime, message("first-independent", route("74")));
    const lane = await runtime.startLane({ ...selection, sourceId: "first-independent", title: "Existing topic", cwd: directory });
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
    await expect(runtime.startLane({ ...selection, sourceId: "cancel-head-source", title: "Must not create", cwd: directory })).rejects.toThrow("cancelled main request");
    expect(store.lanes()).toHaveLength(1);
  });

  test("new-topic delegation downloads copied attachments from the immutable original source route", async () => {
    const opened: Route[] = [];
    const { runtime, store, directory, hosts, messenger } = fixture(3, async destination => {
      opened.push(destination);
      return new Response("data");
    });
    const original = { ...message("new-topic-file", route(null)), attachments: [
      { id: "original-file", name: "notes.txt", url: "https://cdn.discordapp.com/attachments/4/file.txt", size: 4 },
    ] };
    await runtime.start();
    await admit(runtime, original);
    const lane = await runtime.startLane({ ...selection, sourceId: original.id, title: "Delegated files", cwd: directory });
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

  test("local main commands cannot send a previous assistant answer", async () => {
    const { runtime, main, store, messenger } = fixture();
    await runtime.start();
    main.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "old unrelated secret" }] } });
    main.local = true;
    await admit(runtime, message("120", route(null, { guildId: null }), "/local-command"));
    expect(store.input("120")?.state).toBe("done");
    expect(messenger.sent).toEqual([]);
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
    await admit(runtime, message("138", route(null, { guildId: null })));
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
    messenger.backlog.set(routeKey(destination), [original, message("161", destination)]);
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
    messenger.backlog.set(routeKey(dm), [event("000005", "main followup"), event("000003", "topic followup"), event("000004", "/main"), event("000002", "/new")]);
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
    const original = message("170", route(null));
    await admit(runtime, original);
    const [one, two] = await Promise.all([
      runtime.startLane({ ...selection, sourceId: original.id, title: "Delegation", cwd: directory }),
      runtime.startLane({ ...selection, sourceId: original.id, title: "Delegation", cwd: directory }),
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
    await admit(runtime, message("180", dm));
    const delegated = await runtime.startLane({ ...selection, sourceId: "180", title: "DM task", cwd: directory });
    expect(delegated.route.threadId).toBeNull();
    expect(delegated.route.topicId).toMatch(/^topic-/);
    expect(messenger.threads).toEqual([]);
    expect(store.input("180")).toMatchObject({ target: "main", state: "submitted", route: dm });
    expect(store.input("handoff:180:lane")?.route.topicId).toBe(delegated.route.topicId);
    expect(store.getMeta(`dm:active:${physicalRouteKey(dm)}`)).toBe(delegated.route.topicId!);
    await admit(runtime, message("182", dm, "Follow this delegated topic"));
    expect(store.input("182")).toMatchObject({ target: "main", route: delegated.route });
    store.receive(message("181", route(null)), "main");
    store.submit("181", "native-main-next", 0);
    messenger.threadFails = true;
    await expect(runtime.startLane({ ...selection, sourceId: "181", title: "Uncertain", cwd: directory })).rejects.toThrow();
    messenger.threadFails = false;
    await expect(runtime.startLane({ ...selection, sourceId: "181", title: "Uncertain", cwd: directory })).rejects.toThrow("interrupted");
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
    expect(reopened.input("501")).toMatchObject({ target: "main", state: "submitted", route: { ...dm, topicId } });
    expect(reopened.input("route:501")).toBeNull();
    expect(head.prompts[0]!.command.message).toContain("sourceId: 501");
    await admit(restarted, boundary);
    expect(reopened.getMeta(`dm:active:${physicalRouteKey(dm)}`)).toBe(topicId);
    expect(transport.fetched.every(entry => entry.route.topicId === undefined)).toBe(true);
  });

  test("two logical DM topics isolate followups and /main preserves both lanes and immutable replay", async () => {
    const { runtime, store, directory, messenger, main } = fixture();
    const dm = route(null, { guildId: null });
    await runtime.start();
    const firstRequest = message("600", dm, "/new first repository task");
    await admit(runtime, firstRequest);
    expect(main.prompts[0]!.command.message).not.toContain("/new first repository task");
    const first = await runtime.startLane({ ...selection, sourceId: "600", title: "First", cwd: directory });
    await admit(runtime, message("601", dm, "First followup"));
    expect(store.input("601")).toMatchObject({ target: "main", route: first.route });
    await admit(runtime, message("610", dm, "/new second repository task"));
    const second = await runtime.startLane({ ...selection, sourceId: "610", title: "Second", cwd: directory });
    await admit(runtime, message("611", dm, "Second followup"));
    expect(store.input("611")).toMatchObject({ target: "main", route: second.route });
    expect(first.route.threadId).toBeNull();
    expect(second.route.threadId).toBeNull();
    expect(first.route.topicId).not.toBe(second.route.topicId);
    expect(physicalRouteKey(first.route)).toBe(physicalRouteKey(second.route));
    expect(store.laneForRoute(dm)).toBeNull();
    await admit(runtime, message("620", dm, "/main"));
    await admit(runtime, message("621", dm, "A direct head question"));
    expect(store.input("621")?.target).toBe("main");
    expect(store.input("621")?.route.topicId).toBeUndefined();
    expect(store.lanes()).toHaveLength(2);
    await admit(runtime, firstRequest);
    expect(store.getMeta(`dm:active:${physicalRouteKey(dm)}`)).toBe("");
    expect(store.input("600")?.target).toBe("main");
    // Historical catchup is assigned by the command timeline, not today's /main.
    await admit(runtime, message("605", dm, "Late catchup belonging to first topic"));
    expect(store.input("605")).toMatchObject({ target: "main", route: first.route });
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
    await admit(runtime, command("700", "/new first task"));
    const first = await runtime.startLane({ ...selection, sourceId: "700", title: "First", cwd: directory });
    await runtime.kick();
    await admit(runtime, command("710", "/new second task"));
    const second = await runtime.startLane({ ...selection, sourceId: "710", title: "Second", cwd: directory });
    await runtime.kick();
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
      ...message("190", route(null, { guildId: null })),
      attachments: [{ id: "77", name: "../../image.png", url: "https://cdn.discordapp.com/attachments/4/77/image.png?secret=signed", size: png.length, contentType: "image/png" }],
    });
    const prompt = main.prompts[0]!.command;
    expect(requested).toHaveLength(1);
    expect(prompt.message).toContain(join(directory, "attachments"));
    expect(prompt.message).not.toContain("secret=signed");
    expect(prompt.message).not.toContain("cdn.discordapp.com");
    expect(prompt.images).toEqual([{ type: "image", data: png.toString("base64"), mimeType: "image/png" }]);
  });

  for (const platform of ["telegram", "slack"] as const) {
    test(`${platform} opaque attachments remain adapter-owned with bounded private persistence and sniffed images`, async () => {
      const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
      const opened: Array<{ route: Route; reference: string }> = [];
      const { runtime, config, main, directory } = fixture(3, async (destination, attachment, signal) => {
        opened.push({ route: destination, reference: attachment.url });
        expect(signal.aborted).toBe(false);
        return new Response(png, { headers: { "content-length": String(png.length) } });
      });
      delete config.discord;
      config.telegram = { tokenEnv: "TEST_TELEGRAM_TOKEN", ownerId: "1", allowedChatIds: [] };
      config.slack = { botTokenEnv: "TEST_SLACK_BOT_TOKEN", appTokenEnv: "TEST_SLACK_APP_TOKEN", ownerId: "1", teamId: "TTEAM", allowedChannelIds: [] };
      const dm = route(null, { platform, accountId: platform === "slack" ? "TTEAM:UBOT" : "2", guildId: null, channelId: platform === "slack" ? "DPRIVATE" : "1" });
      const reference = platform === "telegram" ? "telegram-file:opaque_file_id" : "slack-file:FOPAQUE";
      await runtime.start();
      const input = { ...message(`${platform}:attachment`, dm), messageId: platform === "slack" ? "1750000000.000001" : "100", attachments: [{ id: "opaque", name: "../../not-an-image.txt", url: reference, size: png.length, contentType: "text/plain" }] };
      await admit(runtime, input);
      expect(opened).toEqual([{ route: dm, reference }]);
      expect(main.prompts[0]!.command.images).toEqual([{ type: "image", data: png.toString("base64"), mimeType: "image/png" }]);
      expect(main.prompts[0]!.command.message).not.toContain(reference);
      const requestDirectory = join(directory, "attachments", createHash("sha256").update(input.id).digest("hex").slice(0, 24));
      const files = readdirSync(requestDirectory);
      expect(files).toHaveLength(1);
      expect(files[0]).not.toContain(".download");
      expect(statSync(join(requestDirectory, files[0]!)).mode & 0o777).toBe(0o600);
      expect(statSync(requestDirectory).mode & 0o777).toBe(0o700);
    });
  }

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
      await admit(runtime, { ...message(id, route(null, { guildId: null })), attachments });
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
      const input = { ...message("310", route(null, { guildId: null })), attachments: [{ id: "opaque", name: "file", url: "adapter-file:opaque", size: 2 }] };
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
    await admit(runtime, { ...message("200", route(null, { guildId: null })), attachments: [
      { id: "77", name: "private", url: "https://127.0.0.1/private", size: 1 },
    ] });
    expect(fetches).toBe(1);
    await admit(runtime, { ...message("201", route(null, { guildId: null })), attachments: [
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
    await runtime.receive({ ...message("205", route(null, { guildId: null })), attachments: [
      { id: "78", name: "file", url: "https://cdn.discordapp.com/attachments/4/78/file", size: 1 },
    ] });
    await requested.promise;
    try {
      await runtime.receive(message("206", route("88")));
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
