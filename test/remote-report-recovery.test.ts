import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostPaths, type Config } from "../src/config";
import type { Approval, Lane, Messenger, OutputRecord, Route } from "../src/contracts";
import { Superagent, type RuntimeAdapters, type RuntimeHost, type RuntimeState } from "../src/runtime";
import { Store } from "../src/store";

const route: Route = { platform: "discord", accountId: "2", authorityId: "1", guildId: "3", channelId: "4", threadId: "31" };
const model = { provider: "fixture", id: "coding" };
const placement = { worker: "builder", destination: "builder-ssh", workerId: "12345678-1234-1234-1234-123456789abc" };
const root = "handoff:source:remote";
const originalResult = "Result from the original remote request.";
const foreignResult = "This answer belongs to a different request.";
const frame = (text: string) => ({ role: "assistant", stopReason: "stop", content: [{ type: "text", text }] });
const report = {
  type: "superagent-lane-report", sessionId: "remote-session", reportId: "report-tool-id",
  report: { status: "progress", summary: "Recovered native observation.",
    evidence: [{ kind: "tool", ref: "build", fingerprint: "a".repeat(64) }] },
};

class NativeSession {
  readonly entries: Array<Record<string, unknown>> = [];
  readonly prompts: Array<{ id: string; message: string }> = [];
  readonly goalResumes: string[] = [];
  readonly state: RuntimeState & { instanceKey: string; generation: number };
  leafId: string | null = null;
  beforePrompt?: () => void;
  beforeAbort?: () => Promise<void>;
  constructor(sessionFile: string, sessionId: string, hostPid: number) {
    this.state = { sessionFile, sessionId, hostPid, journalCursorVersion: 1, instanceKey: `${sessionId}:instance`, generation: 0,
      isSettled: true, isStreaming: false, pendingUiRequests: [], hasOwnedRunningWork: false, settingsScope: "session",
      model, thinkingLevel: "high" };
  }
  append(data: Record<string, unknown>): void {
    const id = `entry-${this.entries.length}-${String(data.type)}`;
    this.entries.push({ id, parentId: this.leafId,
      timestamp: "2025-12-20T12:00:00.000Z", ...data });
    this.leafId = id;
  }
  observation(customType: string, data: Record<string, unknown>, runOrdinal = 1): void {
    const { sessionId, sessionFile, hostPid, instanceKey } = this.state;
    this.append({ type: "custom", customType, data: { sessionId, sessionFile, hostPid, instanceKey, runOrdinal, ...data } });
  }
  begin(id: string, message: string): void {
    this.beforePrompt?.();
    this.prompts.push({ id, message });
    this.state.isSettled = false;
    this.state.isStreaming = true;
    this.observation("rpc_agent_start", {});
    this.append({ type: "message", message: { role: "user", content: [{ type: "text", text: message }] } });
  }
  finish(requestId?: string, text = originalResult, sessionSettled = true): void {
    this.append({ type: "message", message: frame(text) });
    if (requestId) this.observation("rpc_prompt_result", { frame: { type: "prompt_result", id: requestId,
      status: "completed", agentInvoked: true, sessionSettled } });
    this.state.isSettled = true;
    this.state.isStreaming = false;
  }
}

class Peer implements RuntimeHost {
  readonly exit = Promise.withResolvers<void>();
  readonly exited = this.exit.promise;
  readonly listeners = new Set<(frame: Record<string, unknown>) => void>();
  afterPrompt?: (id: string) => Promise<void>;
  constructor(readonly native: NativeSession, readonly head = false) {}
  readonly client = {
    getState: async () => structuredClone(this.native.state),
    abortAndRestoreQueue: async () => {
      await this.native.beforeAbort?.();
      this.native.state.isSettled = true;
      this.native.state.isStreaming = false;
      return {};
    },
    getSubagents: async () => [],
    cancelSubagent: async () => {},
  };
  async request(command: Record<string, unknown>, id?: string): Promise<unknown> {
    const native = this.native;
    const reply = (data: unknown) => ({ success: true, data });
    if (command.type === "get_available_models") return reply({ models: [{ ...model, kind: "chat" }] });
    if (command.type === "goal") {
      const goal = native.state.goal?.goal;
      if (!goal) throw new Error("No native goal");
      if (command.op === "pause") {
        native.state.goal = { enabled: false, goal: { ...goal, status: "paused" } };
        return reply({});
      }
      if (command.op === "resume" && typeof id === "string") {
        native.goalResumes.push(id);
        native.state.goal = { enabled: true, goal: { ...goal, status: "active" } };
        native.state.isSettled = false;
        native.state.isStreaming = true;
        this.emit({ type: "agent_start" });
        return reply({});
      }
    }
    const { leafId } = native;
    if (command.type === "get_journal_cursor") return reply({ leafId });
    if (command.type === "get_entries") {
      const since = command.since;
      const start = typeof since === "string" ? native.entries.findIndex(entry => entry.id === since) : -1;
      if (since !== undefined && start < 0) return { success: false, code: "unknown_since" };
      return reply({ entries: structuredClone(native.entries.slice(start + 1)), leafId });
    }
    if (command.type !== "prompt" || typeof id !== "string" || typeof command.message !== "string")
      throw new Error(`Unexpected native RPC: ${String(command.type)}`);
    native.begin(id, command.message);
    this.emit({ type: "agent_start" });
    await this.afterPrompt?.(id);
    if (this.head) {
      const text = command.message.includes(originalResult) ? originalResult : "No verified completion.";
      native.finish(id, text);
      this.emit({ type: "message_end", message: frame(text) });
      this.emit({ type: "prompt_result", id, agentInvoked: true, status: "completed" });
      this.emit({ type: "session_settled" });
    }
    return reply({});
  }
  uiResponse(id: string): void {
    this.native.state.pendingUiRequests = this.native.state.pendingUiRequests?.filter(request => request.id !== id);
  }
  onFrame(listener: (frame: Record<string, unknown>) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  emit(frame: Record<string, unknown>): void {
    for (const listener of this.listeners) listener(frame);
  }
  async close(): Promise<void> { this.exit.resolve(); }
}

function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "remote-report-")));
  const database = join(directory, "coordination.sqlite");
  const config: Config = { path: join(directory, "config.json"), headCwd: directory, stateDir: directory,
    command: [process.execPath], maxHosts: 2, maxSubagents: 2, idleMs: 60_000,
    workers: { [placement.worker]: { ...placement, superkit: "managed" } },
    discord: { tokenEnv: "TEST_TOKEN", ownerId: "1", allowedGuildIds: ["3"], allowedChannelIds: ["4"] } };
  const main = new NativeSession(hostPaths(config, "main").sessionFile, "head-session", process.pid);
  const native = new NativeSession("/worker/remote.jsonl", "remote-session", 6200);
  native.append({ type: "message", message: frame("Earlier work, outside the request cursor.") });
  let remotePeer: Peer | undefined;
  let runtime: Superagent | undefined;
  const sent: OutputRecord[] = [];
  const delivered = Promise.withResolvers<OutputRecord>();
  const shown = Promise.withResolvers<Approval>();
  const messenger: Messenger = {
    async start() {},
    async stop() {},
    async send(output) {
      sent.push(output);
      if (output.text === originalResult) delivered.resolve(output);
      return `sent-${output.id}`;
    },
    async showApproval(approval) { shown.resolve(approval); return approval.remoteId ?? "approval-card"; },
    async dismissApproval() {},
    async createThread() { throw new Error("No thread creation expected"); },
    async fetchAfter() { return null; },
    async openAttachment() { throw new Error("No attachment expected"); },
  };
  const adapters: Partial<RuntimeAdapters> = {
    connect: async () => new Peer(main, true),
    remoteConnect: async () => (remotePeer = new Peer(native)),
    remoteInspect: async () => ({ socket: true, transcript: true, alive: true }),
    remoteStart: async () => { throw new Error("Recovery must not launch a new worker host"); },
    startHost: async () => { throw new Error("Recovery must not launch a local host"); },
    readOmpUsage: async () => "",
  };
  const lane = {
    id: "remote", route, title: "Remote task", cwd: "/worker/repo", repoRoot: "/worker/repo", placement,
    model, modelReason: "Native fixture selection", modelPreset: null, modelPresetSnapshot: null,
    brief: "Remote task", acceptance: [], sessionFile: "/worker/remote.jsonl", sessionId: native.state.sessionId,
    socketPath: "/worker/remote.sock", generation: 4, pid: native.state.hostPid ?? null,
    workState: "open", runtimeState: "idle", createdAt: 100, lastActivityAt: 100, result: null,
  } satisfies Lane;
  const errors: unknown[] = [];
  const seed = new Store(database);
  const input = (id: string) => ({ id, route, messageId: id, text: `Task ${id}`, receivedAt: 100, attachments: [] });
  seed.receive(input("seed"), "main");
  seed.createLane(lane, "seed");
  seed.settle("seed", "done");
  seed.receive(input("source"), "main", { "user-source:source": "true" });
  seed.settle("source", "done");
  seed.close();
  async function start() {
    const store = new Store(database);
    const controller = new Superagent(config, store, messenger, join(directory, "extension.ts"), error => errors.push(error), adapters);
    runtime = controller;
    await controller.start();
    return controller;
  }
  async function admit(controller: Superagent) {
    await controller.messageLane(lane.id, "Run the remote work.", "source");
    const id = native.prompts[0]?.id;
    if (!id) throw new Error(`No original native request started: ${errors.map(String).join("; ")}`);
    return id;
  }
  async function disconnect() {
    if (!remotePeer) throw new Error("Remote transport was not attached");
    await remotePeer.close();
  }
  function losePromptReply() {
    const peer = remotePeer;
    if (!peer) throw new Error("Remote transport was not attached");
    peer.afterPrompt = async id => {
      native.finish(id);
      await peer.close();
      throw new Error("Prompt response lost after acceptance");
    };
  }
  async function dispose() {
    await runtime?.stop();
    rmSync(directory, { recursive: true, force: true });
  }
  cleanups.push(dispose);
  return { start, admit, disconnect, losePromptReply, native, sent, delivered, shown };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

test("a lost transport reports the original proven result once on the authorized route", async () => {
  const f = fixture();
  const runtime = await f.start();
  const id = await f.admit(runtime);
  f.native.append({ type: "custom", customType: "superagent-lane-report", data: report });
  f.native.append({ type: "message", message: { role: "toolResult", toolName: "lane_report", toolCallId: report.reportId,
    details: report, timestamp: Date.parse("2025-12-20T12:00:01.000Z") } });
  f.native.finish(id);
  f.native.observation("rpc_agent_start", {}, 2);
  f.native.append({ type: "message", message: frame(foreignResult) });
  f.native.append({ type: "custom", customType: "superagent-lane-report", data: {
    ...report, reportId: "another-request", report: { ...report.report, summary: "Unrelated observation" },
  } });

  await f.disconnect();
  const output = await f.delivered.promise;

  expect(output).toMatchObject({ route, sourceId: `report:${root}`, text: originalResult });
  expect(runtime.store.input(root)?.state).toBe("done");
  expect(runtime.store.lane("remote")?.observation).toMatchObject({ inputId: root, requestId: id,
    summary: report.report.summary, lastEvidenceAt: Date.parse("2025-12-20T12:00:00.000Z") });
  expect(f.native.prompts.map(prompt => prompt.id)).toEqual([id]);
  expect(f.sent.filter(item => item.text === originalResult)).toEqual([output]);
});

test("a lost prompt acknowledgement uses durable terminal evidence without sending a second prompt", async () => {
  const f = fixture();
  const runtime = await f.start();
  f.losePromptReply();

  const id = await f.admit(runtime);
  const output = await f.delivered.promise;

  expect(output).toMatchObject({ route, sourceId: `report:${root}` });
  expect(runtime.store.input(root)?.state).toBe("done");
  expect(f.native.prompts.map(prompt => prompt.id)).toEqual([id]);
});

test("a replacement HEAD recovers the durable result and deduplicates subsequent attachments", async () => {
  const f = fixture();
  const first = await f.start();
  const id = await f.admit(first);
  await first.stop();
  f.native.finish(id);

  const second = await f.start();
  const output = await f.delivered.promise;
  await second.stop();
  const third = await f.start();

  expect(third.store.input(root)?.state).toBe("done");
  expect(f.native.prompts.map(prompt => prompt.id)).toEqual([id]);
  expect(f.sent.filter(item => item.sourceId === `report:${root}`)).toEqual([output]);
  expect(output.route).toEqual(route);
});

test.each(["saved leaf", "different branch"] as const)("recovery uses the append watermark and the %s independently", async parent => {
  const f = fixture();
  const first = await f.start();
  const savedLeaf = f.native.leafId;
  f.native.append({ type: "message", message: frame(foreignResult) });
  const otherBranch = f.native.leafId;
  f.native.leafId = savedLeaf;
  if (parent === "different branch") f.native.beforePrompt = () => { f.native.leafId = otherBranch; };
  const id = await f.admit(first);
  await first.stop();
  f.native.finish(id);

  const runtime = await f.start();

  const receipt = runtime.store.input(`report:${root}`);
  if (parent === "saved leaf") {
    expect(runtime.store.input(root)?.state).toBe("done");
    expect(receipt?.text).toContain(originalResult);
  } else {
    expect(runtime.store.input(root)?.state).toBe("uncertain");
    expect(receipt?.text).not.toContain(originalResult);
  }
  expect(receipt?.text).not.toContain(foreignResult);
  expect(f.native.prompts.map(prompt => prompt.id)).toEqual([id]);
});

test("a late exact receipt restores historical observations without reopening uncertain progress", async () => {
  const f = fixture();
  const first = await f.start();
  const id = await f.admit(first);
  await first.stop();
  f.native.append({ type: "custom", customType: "superagent-lane-report", data: {
    ...report, reportId: "waiting-report", report: { status: "waiting", summary: "Waiting for a native tool.", evidence: [],
      waiting: { kind: "tool", id: report.reportId, target: "build" } },
  } });
  f.native.append({ type: "custom", customType: "superagent-lane-report", data: report });
  f.native.append({ type: "message", message: { role: "toolResult", toolName: "lane_report", toolCallId: report.reportId,
    details: report, timestamp: Date.parse("2025-12-20T12:00:01.000Z") } });
  f.native.finish();
  const second = await f.start();
  expect(second.store.input(root)?.state).toBe("uncertain");
  expect(second.store.lane("remote")?.observation).toBeUndefined();
  expect(second.store.recordLaneReport(root, 4, "remote-session", "unproved", {
    status: "progress", summary: "Unproven live progress.",
    evidence: [{ kind: "tool", ref: "unproved", fingerprint: "b".repeat(64) }],
  })).toBe(false);
  await second.stop();
  f.native.observation("rpc_prompt_result", { frame: {
    type: "prompt_result", id, status: "completed", agentInvoked: true, sessionSettled: true,
  } });
  f.native.append({ type: "custom", customType: "superagent-lane-report",
    data: { ...report, reportId: "outside-receipt", report: { ...report.report, summary: "Outside the proved request." } } });

  const third = await f.start();
  const output = await f.delivered.promise;

  expect(third.store.input(root)?.state).toBe("done");
  expect(third.store.lane("remote")?.observation).toMatchObject({ inputId: root, requestId: id,
    summary: report.report.summary, waiting: null, lastEvidenceAt: Date.parse("2025-12-20T12:00:00.000Z") });
  expect(third.store.input(`progress:${root}:structured:${report.reportId}`)).toBeNull();
  expect(output).toMatchObject({ route, sourceId: `report:${root}:done` });
  expect(f.native.prompts.map(prompt => prompt.id)).toEqual([id]);
});

test.each(["missing receipt", "foreign receipt", "later native run", "changed instance", "changed settings", "missing cursor"] as const)
("a replacement HEAD never claims completion from %s", async scenario => {
  const f = fixture();
  const first = await f.start();
  const id = await f.admit(first);
  await first.stop();
  f.native.finish(scenario === "missing receipt" ? undefined : scenario === "foreign receipt" ? "wrong-request" : id,
    originalResult, scenario !== "later native run");
  if (scenario === "later native run") {
    f.native.observation("rpc_agent_start", {}, 2);
    f.native.append({ type: "message", message: frame(foreignResult) });
  }
  if (scenario === "changed instance") f.native.state.instanceKey = "different-native-instance";
  if (scenario === "changed settings") f.native.state.thinkingLevel = "low";
  if (scenario === "missing cursor") f.native.entries.shift();

  const runtime = await f.start();

  expect(runtime.store.input(root)?.state).toBe("uncertain");
  const receipt = runtime.store.input(`report:${root}`);
  expect(receipt?.route).toEqual(route);
  expect(receipt?.text).not.toContain(originalResult);
  expect(receipt?.text).not.toContain(foreignResult);
  expect(f.native.prompts.map(prompt => prompt.id)).toEqual([id]);
});

test("an operator pause still cancels the reattached request and does not publish a late result", async () => {
  const f = fixture();
  const first = await f.start();
  const id = await f.admit(first);
  f.native.state.pendingUiRequests = [{ type: "extension_ui_request", id: "native-confirm", method: "confirm", title: "Approve original work?" }];
  await first.stop();
  const runtime = await f.start();
  const approval = await f.shown.promise;

  await runtime.pause("remote");
  f.native.finish(id);
  await f.disconnect();
  await runtime.kick();

  expect(runtime.store.lane("remote")?.workState).toBe("paused");
  expect(approval).toMatchObject({ route, requestId: "native-confirm", target: "remote" });
  expect(runtime.store.approval(approval.id)?.state).toBe("cancelled");
  expect(runtime.store.input(root)?.state).toBe("cancelled");
  expect(runtime.store.input(`report:${root}`)).toBeNull();
  expect(f.native.prompts.map(prompt => prompt.id)).toEqual([id]);
});

test("a durably paused lane reattaches only to cancel submitted work after a confirmed abort", async () => {
  const f = fixture();
  const first = await f.start();
  const id = await f.admit(first);
  const uncertain = "earlier-uncertain";
  first.store.receive({ id: uncertain, route, messageId: uncertain, text: "Older uncertain work.", receivedAt: 99, attachments: [] }, "remote");
  first.store.submit(uncertain, "older-native-id", 4);
  first.store.settle(uncertain, "uncertain");
  first.store.updateLane("remote", 4, { workState: "paused" });
  await first.stop();
  f.native.beforeAbort = async () => {
    f.native.state.isSettled = true;
    f.native.state.isStreaming = false;
    throw new Error("Native abort acknowledgement lost");
  };

  const runtime = await f.start();

  expect(runtime.store.lane("remote")?.workState).toBe("paused");
  expect(runtime.store.input(root)?.state).toBe("submitted");
  expect(runtime.store.input(uncertain)?.state).toBe("uncertain");
  f.native.beforeAbort = undefined;
  await runtime.pause("remote");
  expect(runtime.store.input(root)?.state).toBe("cancelled");
  expect(runtime.store.input(uncertain)?.state).toBe("uncertain");
  expect(runtime.store.input(`report:${root}`)).toBeNull();
  expect(f.native.prompts.map(prompt => prompt.id)).toEqual([id]);
});

test.each(["paused original goal", "paused replacement goal", "paused settings drift", "open original goal"] as const)
("a restarted head never replays a submitted goal resume for a %s", async scenario => {
  const f = fixture();
  f.native.state.goal = { enabled: false, goal: { id: "goal-original", status: "paused" } };
  const first = await f.start();

  await first.resume("remote", "source");
  const inputId = "resume:source:remote";
  const request = first.store.input(inputId);
  expect(request?.state).toBe("submitted");
  const requestId = request?.requestId;
  if (!requestId) throw new Error("Original goal resume did not receive a native request ID");
  if (scenario !== "open original goal") first.store.updateLane("remote", 4, { workState: "paused" });
  await first.stop();
  if (scenario === "paused replacement goal")
    f.native.state.goal = { enabled: true, goal: { id: "goal-unrelated", status: "active" } };
  if (scenario === "paused settings drift") f.native.state.thinkingLevel = "low";

  const runtime = await f.start();
  await runtime.resume("remote", "source");

  expect(runtime.store.input(inputId)?.state).toBe(scenario === "paused original goal" ? "cancelled" : "uncertain");
  if (scenario === "paused original goal") {
    expect(f.native.state.goal).toMatchObject({ enabled: false, goal: { id: "goal-original", status: "paused" } });
    expect(runtime.store.input(`report:${inputId}`)).toBeNull();
  } else expect(runtime.store.input(`report:${inputId}`)?.route).toEqual(route);
  expect(f.native.goalResumes).toEqual([requestId]);
  expect(f.native.prompts).toEqual([]);
});
