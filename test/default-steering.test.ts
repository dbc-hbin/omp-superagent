import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Approval, DialogResponse, Inbound, LaneModel, Messenger, OutputRecord, Route } from "../src/contracts";
import { physicalRoute, physicalRouteKey } from "../src/contracts";
import { type Config, hostPaths } from "../src/config";
import { Superagent, type RuntimeAdapters, type RuntimeHost, type RuntimeState } from "../src/runtime";
import { Store } from "../src/store";

const model: LaneModel = { provider: "fixture", id: "tracked" };
const route = (threadId: string | null = "10", patch: Partial<Route> = {}): Route => ({
  platform: "discord", accountId: "2", authorityId: "1", guildId: "3", channelId: "4", threadId, ...patch,
});
const inbound = (id: string, destination = route(), text = `Request ${id}`): Inbound => ({
  id, messageId: id, route: destination, text, attachments: [], receivedAt: 1,
});

const headInbound = (id: string, destination = route(), task = `Request ${id}`): Inbound =>
  inbound(id, destination, `/head ${task}`);

class TrackedHost implements RuntimeHost {
  readonly prompts: Array<{ id: string; command: Record<string, unknown> }> = [];
  readonly listeners = new Set<(frame: Record<string, unknown>) => void>();
  readonly exit = Promise.withResolvers<void>();
  disconnected = false;
  readonly exited = this.exit.promise.then(() => { this.disconnected = true; });
  readonly state: RuntimeState;
  emitStart = true;
  local = false;
  constructor(sessionFile: string, sessionId: string) {
    this.state = { sessionFile, sessionId, model, hostPid: process.pid, settingsScope: "session", isSettled: true, isStreaming: false,
      isCompacting: false, queuedMessageCount: 0, hasPendingAsyncWork: false, hasOwnedRunningWork: false,
      pendingUiRequests: [], goal: null };
  }
  readonly client = {
    getState: async () => structuredClone(this.state),
    abortAndRestoreQueue: async () => {
      this.state.isStreaming = false;
      this.state.isSettled = true;
      this.state.queuedMessageCount = 0;
      for (const prompt of this.prompts) this.emit({ type: "prompt_result", id: prompt.id, status: "aborted", agentInvoked: true });
      return { steering: [], followUp: [] };
    },
    getSubagents: async () => [],
    cancelSubagent: async (_id: string) => {},
  };
  async request(command: Record<string, unknown>, id?: string): Promise<unknown> {
    if (command.type === "get_available_models") return { success: true, data: { models: [model] } };
    if (command.type === "get_available_commands") return { success: true, data: { commands: [] } };
    if (command.type === "get_entries") return { success: true, data: { entries: [], leafId: null } };
    if (command.type === "goal") { this.state.goal = null; return { success: true }; }
    if (command.type === "shutdown_host") return { success: true };
    if (command.type !== "prompt" || !id) throw new Error(`Unexpected request ${command.type}`);
    this.prompts.push({ id, command });
    if (this.local) return { success: true, data: { agentInvoked: false } };
    this.state.isSettled = false;
    this.state.isStreaming = true;
    if (command.streamingBehavior !== "steer" && this.emitStart) this.emit({ type: "agent_start" });
    // The native admitted-prompt acknowledgement intentionally has no data.
    return { success: true };
  }
  emit(frame: Record<string, unknown>): void { for (const listener of this.listeners) listener(frame); }
  result(index: number, status = "completed"): void {
    this.emit({ type: "prompt_result", id: this.prompts[index]!.id, status, agentInvoked: true });
  }
  yield(text: string): void {
    this.state.isSettled = true;
    this.state.isStreaming = false;
    const message = { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" };
    this.emit({ type: "message_end", message });
    this.emit({ type: "agent_end", isTerminal: true, messages: [message] });
  }
  onFrame(listener: (frame: Record<string, unknown>) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  uiResponse(_id: string, _response: DialogResponse): void {}
  async close(): Promise<void> {}
}

class TopicMessenger implements Messenger {
  readonly sent: OutputRecord[] = [];
  readonly creations: Array<{ route: Route; sourceMessageId?: string }> = [];
  readonly capabilities: Route[] = [];
  supported = true;
  capabilityError?: Error;
  creationError?: Error;
  beforeCreate?: () => void;
  canCreateThread: Messenger["canCreateThread"] = async route => {
    this.capabilities.push(route);
    if (this.capabilityError) throw this.capabilityError;
    return this.supported;
  };
  async start(): Promise<void> {}
  async send(output: OutputRecord): Promise<string> { this.sent.push(output); return output.id; }
  async createThread(route: Route, _title: string, sourceMessageId?: string): Promise<Route> {
    this.creations.push({ route, sourceMessageId });
    this.beforeCreate?.();
    if (this.creationError) throw this.creationError;
    return { ...physicalRoute(route), threadId: route.platform === "slack" ? sourceMessageId ?? "1750000001.000001" : "900" };
  }
  async showApproval(_approval: Approval): Promise<string> { return "card"; }
  async dismissApproval(_approval: Approval): Promise<void> {}
  async fetchAfter(): Promise<Inbound[]> { return []; }
  async openAttachment(): Promise<never> { throw new Error("No attachment in this case"); }
  async stop(): Promise<void> {}
}

const fixtures: Array<{ runtime: Superagent; store: Store; directory: string }> = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.runtime.stop();
    fixture.store.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});
function fixture(maxHosts = 1, requestRestart?: RuntimeAdapters["requestRestart"], topicMemory?: RuntimeAdapters["topicMemory"]) {
  const directory = realpathSync(mkdtempSync("/tmp/default-steering-"));
  const config: Config = { path: join(directory, "config.json"), stateDir: directory, headCwd: directory,
    command: [process.execPath], maxHosts, maxSubagents: 4, idleMs: 60_000,
    discord: { tokenEnv: "TEST_TOKEN", ownerId: "1", allowedGuildIds: ["3"], allowedChannelIds: ["4"] },
    slack: { botTokenEnv: "TEST_SLACK", appTokenEnv: "TEST_SLACK_APP", ownerId: "UOWNER", teamId: "TTEAM", allowedChannelIds: ["CCHANNEL"] },
    telegram: { tokenEnv: "TEST_TELEGRAM", ownerId: "1", allowedChatIds: ["-3"] } };
  const store = new Store(join(directory, "coordination.sqlite"));
  const messenger = new TopicMessenger();
  const main = new TrackedHost(hostPaths(config, "main").sessionFile, "main-session");
  const hosts = new Map([[hostPaths(config, "main").socketPath, main]]);
  const errors: unknown[] = [];
  const runtime = new Superagent(config, store, messenger, join(directory, "extension.ts"), error => errors.push(error), {
    requestRestart,
    topicMemory,
    connect: async path => {
      const host = hosts.get(path);
      if (!host || host.disconnected) throw new Error("Host is not accepting connections");
      return host;
    },
    startHost: async options => {
      hosts.set(options.socketPath, new TrackedHost(options.sessionFile, `lane-session-${hosts.size}`));
      return { pid: process.pid };
    },
  });
  fixtures.push({ runtime, store, directory });
  const select = (sourceId: string, destination?: Route) => ({ sourceId, title: "Independent task", kickoff: "I will inspect the requested workspace, perform the authorized work, and verify the result in this topic.", cwd: directory,
    model, modelReason: "Use the verified available model.", ...(destination ? { destination } : {}) });
  return { runtime, store, messenger, main, hosts, directory, config, errors, select };
}
async function receive(runtime: Superagent, input: Inbound): Promise<void> {
  await runtime.receive(input);
  await runtime.kick();
}
async function drain(runtime: Superagent): Promise<void> {
  const before = Promise.withResolvers<void>();
  setImmediate(before.resolve);
  await before.promise;
  await runtime.kick();
  const after = Promise.withResolvers<void>();
  setImmediate(after.resolve);
  await after.promise;
}

describe("HEAD and topic steering", () => {
  test("restart checkpoints joined native work without creating another steering ticket or replaying either prompt", async () => {
    let restartCalls = 0;
    const f = fixture(1, async request => {
      restartCalls++;
      return { ...request, gatewayPid: process.pid, headPid: process.pid, sessionId: "main-session",
        sessionFile: hostPaths(f.config, "main").sessionFile, state: "accepted" };
    });
    const { runtime, main, store } = f;
    await runtime.start();
    await receive(runtime, headInbound("restart-active-owner"));
    await receive(runtime, headInbound("restart-active-followup"));
    const commandsBefore = main.prompts.length;
    await receive(runtime, inbound("restart-control", route(), "/restart"));
    expect(restartCalls).toBe(1);
    expect(main.prompts).toHaveLength(commandsBefore);
    expect(store.input("restart-active-owner")?.state).toBe("cancelled");
    expect(store.input("restart-active-followup")?.state).toBe("cancelled");
    expect(store.input("restart-control")?.state).toBe("done");
    expect(store.output("restart-control:restart-ack")?.state).toBe("sent");
    expect(JSON.parse(store.getMeta("head:restart-fence")!).state).toBe("accepted");
  });

  test("explicit local handling completes without a prompt_result or stale assistant output", async () => {
    const { runtime, main, store, messenger } = fixture();
    await runtime.start();
    main.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Unrelated old answer" }] } });
    main.local = true;
    await receive(runtime, headInbound("90", route(), "/local-command"));
    expect(store.input("90")?.state).toBe("done");
    expect(messenger.sent).toHaveLength(0);
    expect(main.prompts).toHaveLength(1);
  });

  test("joins only the exact route, preserves source identity, and emits one final answer after every ticket", async () => {
    const { runtime, main, store, messenger } = fixture();
    await runtime.start();
    await receive(runtime, headInbound("100"));
    await receive(runtime, headInbound("101", route("11")));
    await receive(runtime, inbound("102"));
    await receive(runtime, inbound("102"));
    expect(main.prompts).toHaveLength(2);
    expect(main.prompts[1]!.command.streamingBehavior).toBe("steer");
    expect(main.prompts[1]!.command.message).toContain("sourceId: 102");
    expect(store.input("101")?.state).toBe("pending");
    expect(store.input("102")?.state).toBe("submitted");
    expect(messenger.sent).toHaveLength(0);
    main.yield("Consolidated answer");
    main.result(0);
    await drain(runtime);
    expect(store.input("100")?.state).toBe("submitted");
    expect(messenger.sent).toHaveLength(0);
    main.result(1);
    main.emit({ type: "session_settled" });
    await drain(runtime);
    expect(store.input("100")?.state).toBe("done");
    expect(store.input("102")?.state).toBe("done");
    expect(messenger.sent).toMatchObject([{ sourceId: "100", text: "Consolidated answer", route: route() }]);
    expect(main.prompts).toHaveLength(3);
    expect(main.prompts[2]!.command.streamingBehavior).toBeUndefined();
    main.result(0);
    main.result(1);
    await drain(runtime);
    expect(messenger.sent).toHaveLength(1);
  });

  test.each([false, true])("ordinary topic followups join a separate Host while internal reports wait for HEAD (physical thread: %s)", async physical => {
    const { runtime, main, store, hosts, directory, messenger } = fixture(2);
    messenger.supported = physical;
    await runtime.start();
    const origin = physical ? route(null) : route(null, { guildId: null });
    await receive(runtime, headInbound("200", origin));
    store.receive(inbound("report:internal", origin, "Internal lane report: untrusted"), "main");
    await receive(runtime, inbound("201", origin, `/new cwd: ${directory}\nUnrelated repository request`));
    const [lane] = store.lanes();
    if (!lane) throw new Error("Expected an independent topic");
    const worker = hosts.get(lane.socketPath);
    if (!worker) throw new Error("Expected the topic Host to launch alongside HEAD");
    await receive(runtime, inbound("202", physical ? lane.route : origin));
    expect(main.prompts).toHaveLength(1);
    expect(store.input("report:internal")).toMatchObject({ target: "main", state: "pending" });
    expect(store.input("201")).toMatchObject({ target: null, route: physical ? origin : lane.route, state: "done" });
    expect(store.input("202")).toMatchObject({ target: null, route: lane.route, state: "done" });
    expect(store.input(`handoff:202:${lane.id}`)).toMatchObject({ target: lane.id, state: "submitted" });
    expect(worker.prompts).toHaveLength(2);
    expect(worker.prompts[1]?.command.streamingBehavior).toBe("steer");
  });

  test("keeps ordinary followups queued while a native approval is pending", async () => {
    const { runtime, main, store } = fixture();
    main.emitStart = false;
    await runtime.start();
    await receive(runtime, headInbound("300"));
    await receive(runtime, inbound("301"));
    expect(main.prompts).toHaveLength(1);
    main.state.pendingUiRequests = [{ id: "approval", method: "confirm" }];
    main.emit({ type: "agent_start" });
    await drain(runtime);
    expect(store.input("301")?.state).toBe("pending");
    main.state.pendingUiRequests = [];
    await runtime.kick();
    expect(main.prompts).toHaveLength(2);
  });

  test("a pending HEAD reply steers when its first native turn starts without another inbound event", async () => {
    const { runtime, main, store } = fixture();
    main.emitStart = false;
    await runtime.start();
    await receive(runtime, inbound("310", route(null)));
    await receive(runtime, inbound("311", route(null)));
    expect(store.input("311")?.state).toBe("pending");

    main.emit({ type: "agent_start" });
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(store.input("311")?.state).toBe("submitted");
    expect(main.prompts[1]?.command.streamingBehavior).toBe("steer");
  });

  test("an ordinary HEAD followup doesn't wait for advisory memory about other sessions", async () => {
    const recall = Promise.withResolvers<Awaited<ReturnType<NonNullable<RuntimeAdapters["topicMemory"]>["search"]>>>();
    const { runtime, main, store, directory } = fixture(2, undefined, {
      status: async () => ({ backend: "mnemopi", active: true, searchable: true, writable: true }),
      search: () => recall.promise,
    });
    try {
      await runtime.start();
      await receive(runtime, inbound("320", route("10"), `cwd: ${directory}\nInspect this workspace`));
      expect(store.laneForRoute(route("10"))?.sessionId).toBeTruthy();
      await receive(runtime, headInbound("321", route(null)));
      await receive(runtime, inbound("322", route(null), "Check the migration error handling first"));

      expect(store.input("322")?.state).toBe("submitted");
      expect(main.prompts[1]?.command.streamingBehavior).toBe("steer");
    } finally {
      recall.resolve({ backend: "mnemopi", query: "", items: [], count: 0 });
    }
  });

  test("disconnect marks all admitted inputs uncertain without replay or duplicate notices", async () => {
    const { runtime, main, store, messenger } = fixture();
    await runtime.start();
    await receive(runtime, headInbound("400"));
    await receive(runtime, headInbound("401"));
    await receive(runtime, headInbound("402"));
    main.exit.resolve();
    await drain(runtime);
    for (const id of ["400", "401", "402"]) expect(store.input(id)?.state).toBe("uncertain");
    expect(main.prompts).toHaveLength(3);
    expect(messenger.sent).toHaveLength(1);
    await receive(runtime, headInbound("403"));
    expect(main.prompts).toHaveLength(3);
  });

  test("head stop cancels all joined receipts and late native results cannot send an answer", async () => {
    const { runtime, main, store, messenger } = fixture();
    await runtime.start();
    await receive(runtime, headInbound("500"));
    await receive(runtime, headInbound("501"));
    await receive(runtime, headInbound("502"));
    await receive(runtime, inbound("503", route(), "/stop head"));
    await drain(runtime);
    for (const id of ["500", "501", "502"]) expect(store.input(id)?.state).toBe("cancelled");
    main.yield("Must never deliver");
    for (let index = 0; index < 3; index++) main.result(index);
    main.emit({ type: "session_settled" });
    await drain(runtime);
    expect(messenger.sent.some(output => output.text === "Must never deliver")).toBe(false);
    expect(main.prompts).toHaveLength(3);
  });

  test("explicit lane messages coalesce into one head report, never direct external lane output", async () => {
    const { runtime, main, store, hosts, messenger, select } = fixture(2);
    await runtime.start();
    await receive(runtime, headInbound("600"));
    const lane = await runtime.startLane(select("600"));
    await runtime.kick();
    const laneHost = hosts.get(lane.socketPath)!;
    await receive(runtime, headInbound("601"));
    await runtime.messageLane(lane.id, "Explicit delegated followup", "601");
    expect(laneHost.prompts).toHaveLength(2);
    expect(laneHost.prompts[1]!.command.streamingBehavior).toBe("steer");
    laneHost.yield("Lane consolidated result");
    laneHost.result(1);
    laneHost.result(0);
    laneHost.emit({ type: "session_settled" });
    await drain(runtime);
    expect(store.input(`handoff:601:${lane.id}`)?.state).toBe("done");
    expect(store.input("report:handoff:600:lane")?.text).toContain("Lane consolidated result");
    expect(store.input(`report:handoff:601:${lane.id}`)).toBeNull();
    expect(messenger.sent).toEqual([expect.objectContaining({ id: "600:kickoff", sourceId: "handoff:600:lane", route: lane.route })]);
    expect(main.prompts).toHaveLength(2);
  });

  test("parent handoffs steer only the matching manager conversation even when another run reports to the same thread", async () => {
    const { runtime, store, hosts, select } = fixture(2);
    const parent = route(null);
    await runtime.start();
    await receive(runtime, headInbound("605"));
    const lane = await runtime.startLane(select("605"));
    await runtime.kick();
    const worker = hosts.get(lane.socketPath);
    if (!worker) throw new Error("Expected the original work-thread Host");

    await receive(runtime, headInbound("606", parent));
    const reopened = await runtime.messageLane(lane.id, "Check the follow-up.", "606");
    expect(reopened.state).toBe("pending");
    expect(worker.prompts).toHaveLength(1);
    worker.yield("The thread-origin task finished.");
    worker.result(0);
    worker.emit({ type: "session_settled" });
    await drain(runtime);
    expect(worker.prompts[1]?.command.streamingBehavior).toBeUndefined();

    await receive(runtime, headInbound("607", parent));
    const joined = await runtime.messageLane(lane.id, "Include the edge case.", "607");
    expect(worker.prompts.map(prompt => prompt.command.streamingBehavior)).toEqual([undefined, undefined, "steer"]);
    worker.yield("Both parent follow-ups are verified.");
    worker.result(2);
    worker.result(1);
    worker.emit({ type: "session_settled" });
    await drain(runtime);
    expect(store.input(joined.inputId)?.state).toBe("done");
    expect(store.input(`report:${joined.inputId}`)).toBeNull();
    expect(store.input(`report:${reopened.inputId}`)).toMatchObject({ route: lane.route,
      text: expect.stringContaining("Both parent follow-ups are verified.") });
  });

  test("a bound thread reply cannot join a manager handoff whose answer belongs to another thread", async () => {
    const { runtime, store, hosts, select } = fixture(2);
    await runtime.start();
    await receive(runtime, headInbound("610", route("10")));
    const destination = route("11");
    const lane = await runtime.startLane(select("610", destination));
    await runtime.kick();
    const worker = hosts.get(lane.socketPath);
    if (!worker) throw new Error("Expected the explicitly selected lane");

    await receive(runtime, inbound("611", destination));

    const handoffId = `handoff:611:${lane.id}`;
    expect(store.input(handoffId)).toMatchObject({ route: destination, state: "pending" });
    expect(worker.prompts).toHaveLength(1);
    worker.yield("Manager task completed");
    worker.result(0);
    worker.emit({ type: "session_settled" });
    await drain(runtime);
    expect(store.input("report:handoff:610:lane")?.route).toEqual(route("10"));
    expect(store.input(handoffId)?.state).toBe("submitted");
    expect(worker.prompts[1]?.command.streamingBehavior).toBeUndefined();
  });

  test("ordinary /head text in an active lane's thread steers HEAD, not the lane", async () => {
    const { runtime, store, main, hosts, directory } = fixture(2);
    const destination = route("10");
    await runtime.start();
    await receive(runtime, inbound("620", destination, `cwd: ${directory}\nOpen this workspace`));
    const lane = store.laneForRoute(destination);
    if (!lane) throw new Error("Expected a lane bound to the work thread");
    await receive(runtime, headInbound("621", destination));
    await receive(runtime, headInbound("622", destination, "Adjust the coordination request"));

    expect(store.input("622")).toMatchObject({ target: "main", route: destination, state: "submitted" });
    expect(main.prompts[1]?.command.streamingBehavior).toBe("steer");
    expect(hosts.get(lane.socketPath)?.prompts).toHaveLength(1);
  });

  test("a joined bound reply keeps its run's manager report in the thread after HEAD opens a sibling for the source", async () => {
    const { runtime, store, hosts, select } = fixture(3);
    const destination = route("10");
    await runtime.start();
    await receive(runtime, headInbound("630", destination));
    const lane = await runtime.startLane(select("630"));
    await runtime.kick();
    const worker = hosts.get(lane.socketPath);
    if (!worker) throw new Error("Expected the original work-thread Host");
    worker.yield("First task completed");
    worker.result(0);
    worker.emit({ type: "session_settled" });
    await drain(runtime);

    await receive(runtime, headInbound("631", destination));
    await runtime.messageLane(lane.id, "Work on the parser", "631");
    await receive(runtime, inbound("632", destination, "Use the revised parsing requirement"));
    expect(store.input(`handoff:632:${lane.id}`)?.state).toBe("submitted");
    const sibling = await runtime.startLane(select("631", route(null)));
    expect(sibling.route.threadId).toBe("900");
    worker.yield("Combined result");
    worker.result(1);
    worker.result(2);
    worker.emit({ type: "session_settled" });
    await drain(runtime);

    expect(store.input(`report:handoff:631:${lane.id}`)).toMatchObject({ route: destination });
    expect(store.input(`handoff:632:${lane.id}`)?.state).toBe("done");
  });
});

describe("native topic binding", () => {
  const slackDm = route(null, { platform: "slack", accountId: "TTEAM:UBOT", authorityId: "UOWNER", guildId: null, channelId: "DDIRECT" });
  const telegramDm = route(null, { platform: "telegram", guildId: null, channelId: "1" });
  const source = (id: string, destination: Route) => ({ ...headInbound(id, destination), messageId: destination.platform === "slack" ? "1750000000.000001" : id });

  test("a logical DM reply joins a manager run on its bound native topic without moving the answer", async () => {
    const { runtime, store, hosts, directory } = fixture(2);
    await runtime.start();
    await receive(runtime, inbound("710", telegramDm, `/new cwd: ${directory}\nInspect the workspace`));
    const [lane] = store.lanes();
    const worker = lane && hosts.get(lane.socketPath);
    if (!lane || !worker) throw new Error("Expected a native topic Host");
    worker.yield("Initial scan complete");
    worker.result(0);
    worker.emit({ type: "session_settled" });
    await drain(runtime);

    await receive(runtime, headInbound("711", telegramDm));
    await runtime.messageLane(lane.id, "Check the restore path", "711");
    await receive(runtime, inbound("712", telegramDm, "Use the saved restore settings"));

    const owner = store.input("711");
    const joined = `handoff:712:${lane.id}`;
    expect(owner?.route).toMatchObject({ threadId: null, topicId: expect.any(String) });
    expect(store.input(joined)).toMatchObject({ route: lane.route, state: "submitted" });
    expect(worker.prompts[2]?.command.streamingBehavior).toBe("steer");
    worker.yield("Combined restore result");
    worker.result(1);
    worker.result(2);
    worker.emit({ type: "session_settled" });
    await drain(runtime);
    expect(store.input(`report:handoff:711:${lane.id}`)?.route).toEqual(owner?.route);
    expect(store.input(joined)?.state).toBe("done");
  });

  test.each([true, false])("Slack slash /new delegates real work without an invocation-based native thread source, native supported: %s", async supported => {
    const { runtime, store, messenger, main, hosts, directory } = fixture(2);
    messenger.supported = supported;
    await runtime.start();
    const original: Inbound = { ...inbound(`slack-command:${supported}`, slackDm, `/new cwd: ${directory}\ninspect this repository`),
      messageId: null, invocationId: createHash("sha256").update(String(supported)).digest("hex") };
    await receive(runtime, original);
    expect(main.prompts).toEqual([]);
    const originalRoute = store.input(original.id)!.route;
    const [lane] = store.lanes();
    if (!lane) throw new Error("Expected a lane from /new with a workspace");
    expect(store.input(original.id)).toMatchObject({ target: null, state: "done" });
    const task = hosts.get(lane.socketPath)?.prompts[0]?.command.message;
    expect(task).toContain("inspect this repository");
    expect(task).not.toContain("/new cwd:");
    expect(messenger.creations).toEqual(supported ? [{ route: slackDm, sourceMessageId: undefined }] : []);
    expect(lane.route.threadId).toBe(supported ? "1750000001.000001" : null);
    expect(store.input(`handoff:${original.id}:lane`)).toMatchObject({ messageId: null, invocationId: original.invocationId });
    await expect(runtime.messageLane(lane.id, "Additional bounded work", original.id)).rejects.toThrow("Topic-owned intake");
    expect(store.input(`handoff:${original.id}:${lane.id}`)).toBeNull();
    expect(store.input(original.id)).toMatchObject({ route: originalRoute, messageId: null, invocationId: original.invocationId });
    expect(store.getMeta(`cursor:${physicalRouteKey(slackDm)}`)).toBeNull();
    expect(store.getMeta(`cursor:${physicalRouteKey(lane.route)}`)).toBe(supported ? "1750000001.000001" : null);
  });

  test.each([true, false])("slash /new inputs preserve origin in authorized guild threads or logical owner DM topics, native supported: %s", async supported => {
    const { runtime, store, messenger, main, hosts, directory } = fixture(2);
    messenger.supported = supported;
    await runtime.start();
    const destination = supported ? route(null) : route(null, { guildId: null });
    const original: Inbound = { ...inbound("discord:2:interaction:1750000000000000001", destination, `/new cwd: ${directory}\ninspect this repository`),
      messageId: null, interactionId: "1750000000000000001" };
    await receive(runtime, original);
    expect(main.prompts).toEqual([]);
    const originalRoute = store.input(original.id)!.route;
    const [lane] = store.lanes();
    if (!lane) throw new Error("Expected a lane from /new with a workspace");
    expect(store.input(original.id)).toMatchObject({ target: null, state: "done" });
    const task = hosts.get(lane.socketPath)?.prompts[0]?.command.message;
    expect(task).toContain("inspect this repository");
    expect(task).not.toContain("/new cwd:");
    expect(messenger.creations).toEqual(supported ? [{ route: destination, sourceMessageId: undefined }] : []);
    expect(lane.route.threadId).toBe(supported ? "900" : null);
    expect(messenger.sent.find(output => output.id === `${original.id}:topic-bound`)?.text)
      .toBe(supported ? "작업 스레드: <#900>" : undefined);
    expect(store.input(`handoff:${original.id}:lane`)).toMatchObject({ messageId: null, interactionId: original.interactionId });
    await expect(runtime.messageLane(lane.id, "Explicit additional bounded work", original.id)).rejects.toThrow("Topic-owned intake");
    expect(store.input(`handoff:${original.id}:${lane.id}`)).toBeNull();
    expect(store.input(original.id)).toMatchObject({ messageId: null, interactionId: original.interactionId, route: originalRoute });
    expect(store.getMeta(`cursor:${physicalRouteKey(destination)}`)).toBeNull();
    expect(JSON.parse(store.getMeta("messenger:routes")!).some((known: Route) => physicalRouteKey(known) === physicalRouteKey(destination))).toBe(true);
  });

  test.each([slackDm, telegramDm])("creates supported private native topics once, with durable source and destination notices", async destination => {
    const { runtime, store, messenger, select } = fixture();
    await runtime.start();
    const original = source("700", destination);
    await receive(runtime, original);
    messenger.beforeCreate = () => expect(store.getMeta(`handoff-route:${original.id}`)).toBe("uncertain");
    const [first, second] = await Promise.all([runtime.startLane(select(original.id)), runtime.startLane(select(original.id))]);
    await runtime.kick();
    expect(second.id).toBe(first.id);
    expect(messenger.creations).toHaveLength(1);
    expect(messenger.capabilities).toEqual([physicalRoute(original.route)]);
    expect(first.route.threadId).toBeTruthy();
    expect(first.route.topicId).toBeUndefined();
    expect(first.runtimeState).toBe("unloaded");
    expect(messenger.sent).toHaveLength(2);
    expect(messenger.sent.map(output => output.route)).toEqual([original.route, first.route]);
    expect(messenger.sent[0]?.text).toBe(destination.platform === "telegram" ? "작업 주제: Independent task" : "작업 스레드: Independent task");
    expect(JSON.parse(store.getMeta(`head-delivery:${original.id}`)!)).toEqual({ source: original.route, destination: first.route, laneId: first.id });
    await runtime.startLane(select(original.id));
    await runtime.kick();
    expect(messenger.sent).toHaveLength(2);
    messenger.supported = false;
    const followup = source("701", original.route);
    followup.messageId = original.route.platform === "slack" ? "1750000000.000002" : "701";
    await receive(runtime, followup);
    expect((await runtime.startLane(select(followup.id))).id).toBe(first.id);
    expect(messenger.capabilities).toHaveLength(1);
    expect(store.getMeta(`cursor:${physicalRouteKey(first.route)}`)).toBe(destination.platform === "slack" ? first.route.threadId : null);
  });

  test("unsupported private capability retains a logical topic; unsupported groups refuse without mutation", async () => {
    const { runtime, messenger, select } = fixture();
    messenger.supported = false;
    await runtime.start();
    await receive(runtime, headInbound("800", route(null, { guildId: null })));
    const logical = await runtime.startLane(select("800"));
    expect(logical.route.threadId).toBeNull();
    expect(logical.route.topicId).toBeTruthy();
    await receive(runtime, headInbound("801", route(null)));
    await expect(runtime.startLane(select("801"))).rejects.toThrow("does not support");
    expect(messenger.creations).toHaveLength(0);
  });

  test.each([
    ["telegram", "original"],
    ["discord", "kickoff"],
  ] as const)("a %s reply to an ordinary HEAD placement's %s stops only its logical lane", async (platform, reference) => {
    const { runtime, store, messenger, main, select } = fixture(3);
    messenger.supported = false;
    const parent = platform === "telegram" ? route(null, { platform, guildId: "-3", channelId: "-3" }) : route(null);
    await runtime.start();
    const original = inbound("810", parent, "Inspect the parser");
    await receive(runtime, original);
    const first = await runtime.startLane(select(original.id));
    await receive(runtime, inbound("811", parent, "Investigate an unrelated task"));
    const second = await runtime.startLane(select("811"));
    await drain(runtime);
    expect(first.id).not.toBe(second.id);
    expect(store.input(original.id)).toMatchObject({ target: "main", state: "submitted", route: parent });
    expect(store.getMeta(`topic-owner:${original.id}`)).toBeNull();
    expect(messenger.creations).toEqual([]);
    const kickoff = store.output(`${original.id}:kickoff`);
    const messageId = reference === "original" ? original.messageId : kickoff?.remoteId;
    if (!messageId) throw new Error("Missing exact reply address");
    const reply = { messageId, authorId: null, text: null };
    expect(store.repliedTopicWorkspace(parent, messageId)).toBe(first.cwd);

    await receive(runtime, { ...inbound("812", parent, "/stop"), reply });
    await drain(runtime);

    expect(store.input("812")).toMatchObject({ route: first.route, state: "cancelled" });
    expect(store.lane(first.id)?.workState).toBe("paused");
    expect(store.lane(second.id)?.workState).toBe("open");
    expect(store.input(original.id)?.state).toBe("submitted");
    expect(main.state.isStreaming).toBe(true);
  });

  test.each(["edit only", "ambiguous original", "exact kickoff"] as const)(
    "Telegram reply stop resolves physical message revisions: %s", async target => {
      const { runtime, store, messenger, main, select } = fixture(3);
      messenger.supported = false;
      const parent = route(null, { platform: "telegram", guildId: "-3", channelId: "-3" });
      const original = inbound("840", parent, "Inspect the first implementation");
      const edit = { ...original, id: "telegram:2:840:edit:1", text: "Inspect the revised implementation" };
      await runtime.start();
      await receive(runtime, original);
      await receive(runtime, edit);
      const first = target === "edit only" ? null : await runtime.startLane(select(original.id));
      const revised = await runtime.startLane(select(edit.id));
      const reference = target === "exact kickoff" ? store.output(`${edit.id}:kickoff`)?.remoteId : original.messageId;
      if (!reference) throw new Error("Missing exact reply address");
      const stop = { ...inbound("841", parent, "/stop"), reply: { messageId: reference, authorId: null, text: null } };

      await receive(runtime, stop);
      await drain(runtime);

      expect(store.lane(revised.id)?.workState).toBe(target === "ambiguous original" ? "open" : "paused");
      if (first) expect(store.lane(first.id)?.workState).toBe("open");
      expect(main.state.isStreaming).toBe(true);
      expect(store.input(original.id)?.state).toBe("submitted");
      expect(store.input(edit.id)?.state).toBe("submitted");
      if (target === "ambiguous original") {
        expect(store.output(`${stop.id}:control`)).toMatchObject({
          route: parent, sourceId: stop.id, state: "sent", text: expect.stringContaining("/stop head"),
        });
      } else {
        expect(store.output(`${stop.id}:head-control`)).toMatchObject({
          route: revised.route, sourceId: stop.id, state: "sent", text: expect.stringContaining(revised.id),
        });
      }
    },
  );

  test("Telegram reply stop refuses a physical message shared by a lane and an independently active HEAD revision", async () => {
    const { runtime, store, messenger, main, select } = fixture(2);
    messenger.supported = false;
    const parent = route(null, { platform: "telegram", guildId: "-3", channelId: "-3" });
    const original = inbound("850", parent, "Inspect the first implementation");
    const edit = { ...original, id: "telegram:2:850:edit:1", text: "Inspect the revised implementation" };
    await runtime.start();
    await receive(runtime, original);
    const lane = await runtime.startLane(select(original.id));
    main.yield("The original revision was assigned to the lane.");
    main.result(0);
    await drain(runtime);
    expect(store.input(original.id)?.state).toBe("done");
    await receive(runtime, edit);
    expect(store.input(edit.id)?.state).toBe("submitted");
    const stop = { ...inbound("851", parent, "/stop"), reply: { messageId: "850", authorId: null, text: null } };

    await receive(runtime, stop);
    await drain(runtime);

    expect(store.lane(lane.id)?.workState).toBe("open");
    expect(store.input(edit.id)?.state).toBe("submitted");
    expect(main.state.isStreaming).toBe(true);
    expect(store.output(`${stop.id}:control`)).toMatchObject({
      route: parent, sourceId: stop.id, state: "sent", text: expect.stringContaining("/stop head"),
    });
  });

  test.each(["uncertain kickoff", "unconfirmed Discord kickoff part", "conflicting sent receipts"] as const)("bare reply stop never falls back to HEAD on %s", async failure => {
    const { runtime, store, messenger, main, select } = fixture(2);
    messenger.supported = false;
    if (failure !== "conflicting sent receipts") {
      const send = messenger.send.bind(messenger);
      messenger.send = async output => {
        if (output.id === "820:kickoff") throw new Error("Kickoff send outcome lost");
        return send(output);
      };
    }
    const parent = route(null);
    await runtime.start();
    const original = inbound("820", parent, "Inspect the parser");
    await receive(runtime, original);
    let messageId = original.id;
    if (failure !== "conflicting sent receipts") {
      await expect(runtime.startLane(select(original.id))).rejects.toThrow("Kickoff delivery is not confirmed");
      expect(store.output(`${original.id}:kickoff`)?.state).toBe("uncertain");
      if (failure === "unconfirmed Discord kickoff part") {
        messageId = "824";
        store.setMeta(`discord:output-part:${messageId}`, `${original.id}:kickoff`);
      }
    } else {
      await runtime.startLane(select(original.id));
      const kickoff = store.output(`${original.id}:kickoff`);
      if (!kickoff?.remoteId) throw new Error("Missing kickoff receipt");
      messageId = kickoff.remoteId;
      store.queueOutput({ id: "collision", sourceId: original.id, route: parent, text: "A different delivered output" });
      store.claimOutput("collision");
      store.finishOutput("collision", "sent", messageId);
    }
    const reply = { messageId, authorId: null, text: null };
    const [lane] = store.lanes();
    if (!lane) throw new Error("Missing registered lane");

    const stop = { ...inbound("821", parent, "/stop"), reply };
    await receive(runtime, stop);
    await drain(runtime);
    await receive(runtime, stop);

    expect(store.repliedTopicWorkspace(parent, messageId)).toBeNull();
    expect(store.input(stop.id)).toMatchObject({ route: parent, state: "cancelled" });
    expect(store.output(`${stop.id}:control`)).toMatchObject({ route: parent, sourceId: stop.id, state: "sent",
      text: expect.stringContaining("/stop head") });
    expect(messenger.sent.filter(output => output.sourceId === stop.id)).toHaveLength(1);
    expect(main.state.isStreaming).toBe(true);
    expect(store.lane(lane.id)?.workState).toBe("open");
    await receive(runtime, { ...headInbound("822", parent, "Keep this coordination turn in HEAD"), reply });
    expect(store.input("822")).toMatchObject({ route: parent, target: "main" });
    await receive(runtime, { ...inbound("823", parent, "/stop head"), reply });
    await drain(runtime);
    expect(main.state.isStreaming).toBe(false);
    expect(store.lane(lane.id)?.workState).toBe("open");
  });

  test("workspace reuse recognizes the exact HEAD kickoff and native binding notice, not a general HEAD reply or foreign route", async () => {
    const { runtime, store, main, select } = fixture(2);
    const parent = route(null);
    await runtime.start();
    const original = inbound("830", parent, "Inspect the parser");
    await receive(runtime, original);
    const lane = await runtime.startLane(select(original.id));
    main.yield("Acknowledged.");
    main.result(0);
    await drain(runtime);
    const kickoff = store.output(`${original.id}:kickoff`)?.remoteId;
    const notice = store.output(`${original.id}:topic-bound`)?.remoteId;
    const answer = store.output(`${original.id}:answer`)?.remoteId;
    if (!kickoff || !notice || !answer) throw new Error("Missing confirmed native placement and HEAD receipts");

    expect(store.repliedTopicWorkspace(lane.route, kickoff)).toBe(lane.cwd);
    expect(store.repliedTopicWorkspace(parent, notice)).toBe(lane.cwd);
    expect(store.repliedTopicWorkspace(parent, answer)).toBeNull();
    for (const other of [
      { ...parent, accountId: "99" }, { ...parent, authorityId: "99" },
      { ...parent, guildId: "99" }, { ...parent, channelId: "99" },
      { ...parent, threadId: "99" }, { ...parent, platform: "telegram" as const },
    ]) expect(store.repliedTopicWorkspace(other, notice)).toBeNull();
  });

  test("capability failure is not unsupported, and ambiguous creation is never replayed", async () => {
    const { runtime, store, messenger, select } = fixture();
    await runtime.start();
    await receive(runtime, source("900", slackDm));
    messenger.capabilityError = new Error("Authenticated capability probe failed");
    await expect(runtime.startLane(select("900"))).rejects.toThrow("probe failed");
    expect(store.getMeta("handoff-route:900")).toBeNull();
    messenger.capabilityError = undefined;
    messenger.creationError = new Error("Remote result lost");
    await expect(runtime.startLane(select("900"))).rejects.toThrow("Remote result lost");
    messenger.creationError = undefined;
    await expect(runtime.startLane(select("900"))).rejects.toThrow("interrupted");
    expect(messenger.creations).toHaveLength(1);
    expect(store.lanes()).toHaveLength(0);
  });

  test("a sibling decision uses the authorized parent without passing a child message as the root", async () => {
    const { runtime, store, messenger, select } = fixture();
    await runtime.start();
    const existing = route("88", { platform: "slack", accountId: "TTEAM:UBOT", authorityId: "UOWNER", guildId: null, channelId: "DDIRECT" });
    existing.threadId = "1750000000.000001";
    const initial = source("1000", existing);
    await receive(runtime, initial);
    const first = await runtime.startLane(select(initial.id));
    const followup = { ...source("1001", existing), messageId: "1750000000.000002" };
    await receive(runtime, followup);
    const sibling = await runtime.startLane(select(followup.id, { ...physicalRoute(existing), threadId: null }));
    await runtime.kick();
    expect(sibling.id).not.toBe(first.id);
    expect(messenger.creations[0]).toEqual({ route: { ...physicalRoute(existing), threadId: null }, sourceMessageId: undefined });
    expect(store.laneForRoute(existing)?.id).toBe(first.id);
    expect((await runtime.startLane(select(followup.id, { ...physicalRoute(existing), threadId: null }))).id).toBe(sibling.id);
    expect(messenger.creations).toHaveLength(1);
  });

  test("only explicitly selected native binding redirects lane reports; original head replies remain at source", async () => {
    const { runtime, store, messenger, select } = fixture();
    await runtime.start();
    const original = source("1100", slackDm);
    await receive(runtime, original);
    const lane = await runtime.startLane(select(original.id));
    store.settle(original.id, "done", { id: "original-head-reply", text: "Head acknowledgement" });
    store.submit(`handoff:${original.id}:lane`, "native-lane-ticket", 0);
    store.settle(`handoff:${original.id}:lane`, "done", { id: "lane-result", text: "Untrusted lane result" });
    const report = store.input(`report:handoff:${original.id}:lane`)!;
    expect(report.route).toEqual(lane.route);
    expect(report.target).toBe("main");
    expect(store.outputs().find(output => output.id === "original-head-reply")?.route).toEqual(original.route);
    expect(() => store.queueOutput({ id: "arbitrary-redirect", sourceId: original.id, route: lane.route, text: "Forbidden" })).toThrow("route differs");
    expect(messenger.sent.some(output => output.text === "Untrusted lane result")).toBe(false);
  });
});
