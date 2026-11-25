import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import { EventEmitter, once } from "node:events";
import { duplexPair, PassThrough, type Duplex } from "node:stream";
import { MAX_RPC_FRAME_BYTES, MAX_RPC_REASSEMBLED_BYTES } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-frame";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry, MAIN_AGENT_ID, type AgentRef } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import hostExtension from "../src/host-extension";
import { MANAGED_ULW_ENV } from "../src/managed-ulw";
import { buildHostArgs, connect, HostConnection, HostStartError, startHost, type HostFrame, type HostOptions } from "../src/host";
import { HostChannel, HostRequestTimeout, indexServiceCompletions } from "../src/host-protocol";
import { assertResidentFixtureOwner, stopHostFixtures, waitForFixtureProcessExit } from "./fixtures/host-fixture-processes";
import { writeStockHostExecutable } from "./fixtures/stock-host";
import { hostOwnerExecutable } from "../src/host-owner-path";
import { offlineMnemopi } from "./fixtures/native-memory";

test("adapter correlation times out without replay and still observes a late original response", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const channel = new HostChannel(input, output);
  const sent: string[] = [];
  output.on("data", data => sent.push(String(data)));
  try {
    await expect(channel.request({ type: "get_state" }, "stalled-query", 5)).rejects.toBeInstanceOf(HostRequestTimeout);
    expect(channel.pending.size).toBe(0);
    const late = Promise.withResolvers<HostFrame>();
    channel.once("frame", late.resolve);
    input.write(`${JSON.stringify({ type: "response", id: "stalled-query", command: "get_state", success: true, data: {} })}\n`);
    expect(await late.promise).toMatchObject({ id: "stalled-query", success: true });
    expect(sent).toHaveLength(1);
    const compact = channel.request({ type: "compact" }, "native-compact", 0);
    expect(channel.pending.get("native-compact")?.timer).toBeUndefined();
    input.write(`${JSON.stringify({ type: "response", id: "native-compact", command: "compact", success: true, data: {} })}\n`);
    expect(await compact).toMatchObject({ id: "native-compact", success: true });
  } finally { channel.destroy(); }
});

test("adapter emits and reassembles intact public protocol-v2 chunks", async () => {
  const wire = new PassThrough();
  const writer = new HostChannel(new PassThrough(), wire, true);
  const reader = new HostChannel(wire, new PassThrough());
  const result = Promise.withResolvers<HostFrame>();
  reader.once("frame", result.resolve);
  try {
    writer.encoder.setProtocolVersion(2);
    const frame = { type: "notice", id: "large-original", data: "x".repeat(MAX_RPC_FRAME_BYTES + 1) };
    writer.send(frame);
    expect(await result.promise).toEqual(frame);
  } finally { writer.destroy(); reader.destroy(); }
});

test("terminal service disposal needs native completion for the exact generation, not its name", () => {
  const daemon = { owner: "native-session", id: "service-id", name: "builder", startedAt: 10, restartCount: 0,
    state: "exited", exitedAt: 20 };
  const entries = [{ type: "custom_message", customType: "launch-completion", details: { daemons: [{ ...daemon }] } }];
  const proof = indexServiceCompletions(entries);
  expect(proof.hasCompletion(daemon)).toBe(true);
  for (const changed of [{ owner: "foreign" }, { id: "replacement" }, { startedAt: 11 }, { restartCount: 1 },
    { state: "failed" }, { exitedAt: 21 }]) {
    expect(proof.hasCompletion({ ...daemon, ...changed })).toBe(false);
  }
  expect(indexServiceCompletions([]).hasCompletion(daemon)).toBe(false);
  expect(proof.hasCompletion({ ...daemon, state: "running" })).toBe(false);
});

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  const failures: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup(); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, "Host fixture cleanup failed");
}, { timeout: 45_000 });

async function directory(launchesHost = false): Promise<string> {
  const result = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "osh-"));
  cleanups.push(async () => {
    if (launchesHost && await stopHostFixtures(result) !== 1)
      throw new Error(`Expected exactly one Host fixture launch; retained ${result}`);
    await fs.rm(result, { recursive: true, force: true });
  });
  await fs.chmod(result, 0o700);
  await fs.writeFile(path.join(result, "extension.ts"), "export default function () {}\n");
  if (launchesHost) {
    await fs.mkdir(path.join(result, "agent"), { mode: 0o700 });
    await fs.writeFile(path.join(result, "agent/config.yml"), JSON.stringify(offlineMnemopi), { mode: 0o600 });
  }
  return result;
}

test("native ownership snapshots resample child startup once without trusting a mixed epoch", async () => {
  const root = await directory();
  const socketPath = path.join(root, "native.sock");
  const managed = path.resolve(import.meta.dir, "fixtures/managed-ulw");
  const registry = new AgentRegistry();
  class Session {
    readonly settings = Settings.isolated();
    readonly extensionRunner = {
      getLoadedExtensions: () => [{ path: "fixture", resolvedPath: path.join(managed, "index.ts") }],
      isExtensionActive: () => true,
    };
    readonly agent = {};
    readonly instanceKey: string;
    readonly sessionManager;
    readonly goalRuntime = { pauseGoal() {} };
    readonly yieldQueue = { has: () => false };
    hasAdmittedSubmission = false;
    hasPostPromptWork = false;
    isBusyForSnapshot = false;
    isStreaming = false;
    isCompacting = false;
    isDisposed = false;
    queuedMessageCount = 0;
    runStartedAt?: number;
    wakeSources = undefined;
    constructor(id: string) {
      this.instanceKey = id;
      const journal: unknown[] = [];
      this.sessionManager = {
        getSessionId: () => id, getSessionFile: () => path.join(root, id + ".jsonl"), getLeafId: () => null,
        getEntries: () => journal, appendCustomEntry: (customType: string, data: unknown) => {
          journal.push({ type: "custom", customType, data });
        },
        ensureOnDisk: async () => {}, flushSync() {},
      };
    }
    getAsyncJobTree() { return null; }
    getAsyncJobSnapshot() { return null; }
    getGoalModeState() { return null; }
    waitForIdle() {}
    abortCompaction() {}
    beginDispose() { throw new Error("An unstable drain must not reach disposal"); }
  }
  type SessionHandle = Parameters<AgentRegistry["attachSession"]>[1];
  const head = new Session("head");
  const child = new Session("child");
  const base = { id: MAIN_AGENT_ID, kind: "main" as const, displayName: "head",
    session: head as unknown as SessionHandle, sessionFile: head.sessionManager.getSessionFile() };
  registry.register(base);
  const callbacks = new Map<string, (event: unknown, context: ExtensionContext) => Promise<void>>();
  const pi = {
    pi: { AgentRegistry: { global: () => registry }, MAIN_AGENT_ID, AgentSession: Session },
    on: (name: string, callback: (event: unknown, context: ExtensionContext) => Promise<void>) => callbacks.set(name, callback),
  } as unknown as ExtensionAPI;
  const settings = { OMP_SUPERAGENT_NATIVE_SOCKET: socketPath, OMP_SUPERAGENT_HOST_CONFIG: path.join(root, "config"),
    [MANAGED_ULW_ENV]: managed };
  const previous = Object.fromEntries(Object.keys(settings).map(name => [name, process.env[name]]));
  try {
    Object.assign(process.env, settings);
    hostExtension(pi);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  const ctx = { agent: { kind: "main" }, sessionManager: head.sessionManager } as unknown as ExtensionContext;
  // Run the real private RPC handler and codec without a native process or OS socket.
  const [host, owner] = duplexPair();
  const channel = new HostChannel(owner, owner);
  cleanups.push(async () => { channel.destroy(); await channel.exited; });
  await fs.writeFile(socketPath, "");
  const server = spyOn(net, "createServer").mockImplementation(((accept: (input: Duplex) => void) => {
    return Object.assign(new EventEmitter(), {
      listen(_path: string, ready: () => void) { accept(host); ready(); },
      close() { host.destroy(); },
    });
  }) as typeof net.createServer);
  try { await callbacks.get("session_start")!(null, ctx); }
  finally { server.mockRestore(); }
  cleanups.push(async () => { await callbacks.get("session_shutdown")!(null, ctx); });

  const childFile = child.sessionManager.getSessionFile();
  await fs.writeFile(childFile, JSON.stringify({ type: "session", id: "child" }) + "\n");
  let childRef: AgentRef | undefined;
  const registerChild = () => {
    childRef = registry.registerIfAvailable({ id: "child", kind: "sub", parentId: MAIN_AGENT_ID, displayName: "child",
      session: null, sessionFile: childFile }, null);
    expect(childRef).toBeDefined();
  };
  const inventory = () => {};
  let observe = inventory, calls = 0, available = true;
  channel.on("frame", (frame: HostFrame) => {
    if (frame.type !== "list_service_units") return;
    calls++;
    observe();
    channel.send({ type: "response", id: frame.id, command: frame.type, success: available, data: { units: [] } });
  });
  const read = async (change: () => void = inventory, command = "snapshot") => {
    observe = change;
    calls = 0;
    const response = await channel.request({ type: command }, undefined, 2_000);
    return { calls, response };
  };
  expect(await read(() => { if (calls === 1) registerChild(); })).toMatchObject({
    calls: 2, response: { success: true, data: { hasOwnedRunningWork: false } },
  });
  expect(await read(() => {
    if (calls !== 1) return;
    child.runStartedAt = 1;
    expect(registry.attachSession("child", child as unknown as SessionHandle, childFile, childRef)).toBe(true);
  })).toMatchObject({ calls: 2, response: { success: true, data: { hasOwnedRunningWork: true } } });
  expect(await read()).toMatchObject({ calls: 1, response: { success: true, data: { hasOwnedRunningWork: true } } });

  const removeChild = () => { expect(registry.unregister("child", childRef)).toBe(true); };
  expect(await read(() => { if (calls === 1) removeChild(); else registerChild(); })).toMatchObject({
    calls: 2, response: { success: false, error: "Native ownership tree changed during service observation" },
  });
  expect(await read(removeChild, "shutdown_host")).toMatchObject({
    calls: 1, response: { success: false, error: "Native ownership tree changed during service observation" },
  });
  available = false;
  expect(await read()).toMatchObject({ calls: 1, response: { success: false, error: "Native service ownership is unavailable" } });
  available = true;
  expect(await read(() => { registry.register(base); })).toMatchObject({
    calls: 1, response: { success: false, error: "Native root changed during ownership observation" },
  });
});

function startFixtureHost(launch: HostOptions): ReturnType<typeof startHost> {
  const starting = startHost(launch);
  // Tests assert the outcome separately; teardown must join even a rejection.
  cleanups.push(async () => { await Promise.allSettled([starting]); });
  return starting;
}

function nextFrame(emitter: EventEmitter, name: string, predicate: (frame: HostFrame) => boolean): Promise<HostFrame> {
  const { promise, resolve, reject } = Promise.withResolvers<HostFrame>();
  const listener = (frame: HostFrame) => {
    if (!predicate(frame)) return;
    clearTimeout(timeout);
    emitter.off(name, listener);
    resolve(frame);
  };
  const timeout = setTimeout(() => {
    emitter.off(name, listener);
    reject(new Error(`Timed out waiting for ${name}`));
  }, 2_000);
  emitter.on(name, listener);
  return promise;
}

async function fixture(handler?: (frame: HostFrame, peer: net.Socket) => boolean, loadedSuperkitPath?: string) {
  const root = await directory();
  const socketPath = path.join(root, "h.sock");
  const sessionFile = path.join(root, "session.jsonl");
  const events = new EventEmitter();
  const received: HostFrame[] = [];
  const peers = new Set<net.Socket>();
  let connections = 0;
  const send = (peer: net.Socket, frame: HostFrame) => { peer.write(`${JSON.stringify(frame)}\n`); };
  const server = net.createServer(peer => {
    peers.add(peer);
    connections++;
    peer.on("close", () => { peers.delete(peer); });
    peer.on("error", () => {});
    peer.setEncoding("utf8");
    let pending = "";
    peer.on("data", chunk => {
      pending += chunk;
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const frame = JSON.parse(pending.slice(0, newline)) as HostFrame;
        pending = pending.slice(newline + 1);
        received.push(frame);
        events.emit("received", frame);
        if (handler?.(frame, peer)) continue;
        if (frame.type === "extension_ui_response") continue;
        const data = frame.type === "negotiate_protocol" ? { protocolVersion: 2 }
          : frame.type === "get_state" ? { sessionId: "fixture-session", sessionFile, hostPid: process.pid,
            adapterOwnerPid: process.pid, adapterProtocol: "owned-stock-stdio-v1", loadedSuperkitPath }
          : { message: frame.message };
        send(peer, { type: "response", id: frame.id, command: frame.type, success: true, data });
        if (frame.type === "prompt") {
          send(peer, { type: "prompt_result", id: frame.id, agentInvoked: true, status: "completed", sessionSettled: true });
        }
      }
    });
    send(peer, {
      type: "ready", supportedProtocolVersions: [1, 2],
      maxFrameBytes: MAX_RPC_FRAME_BYTES, maxReassembledFrameBytes: MAX_RPC_REASSEMBLED_BYTES,
    });
  });
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  server.once("error", reject);
  server.listen(socketPath, () => { server.off("error", reject); resolve(); });
  await promise;
  await fs.chmod(socketPath, 0o600);
  cleanups.push(async () => {
    for (const peer of peers) peer.destroy();
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    await closed.promise;
  });
  return { root, socketPath, sessionFile, received, peers, events, send, get connections() { return connections; } };
}

test("connect negotiates through public RpcClient and probes the live session", async () => {
  const host = await fixture();
  const connection = await HostConnection.connect(host.socketPath);
  cleanups.push(() => connection.close());
  expect(host.received.map(frame => frame.type)).toEqual(["negotiate_protocol", "get_state"]);
  expect((await connection.client.getState()).sessionFile).toBe(host.sessionFile);
});

test("managed attachment to a verified owner without activity projection preserves its native event filter", async () => {
  const host = await fixture(undefined, path.resolve(import.meta.dir, "fixtures/managed-ulw"));
  const connection = await HostConnection.connectForActivity(host.socketPath);
  cleanups.push(() => connection.close());
  expect((await connection.client.getState()).sessionFile).toBe(host.sessionFile);
  expect(host.received.map(frame => frame.type)).toEqual([
    "negotiate_protocol", "get_state", "get_host_admission", "get_state",
  ]);
});

test("an owner without a superkit load receipt remains inspectable but cannot accept managed work", async () => {
  const host = await fixture();
  await expect(HostConnection.connectForActivity(host.socketPath)).rejects.toThrow("has not verified its omp-superkit extension");
  const connection = await HostConnection.connect(host.socketPath);
  cleanups.push(() => connection.close());
  expect((await connection.client.getState()).sessionFile).toBe(host.sessionFile);
  expect(host.received.map(frame => frame.type)).toEqual([
    "negotiate_protocol", "get_state", "negotiate_protocol", "get_state", "get_state",
  ]);
});

test("caller-persisted prompt ids correlate acknowledgement and completion", async () => {
  const host = await fixture();
  const connection = await connect(host.socketPath);
  cleanups.push(() => connection.close());
  const completed = Promise.withResolvers<unknown>();
  connection.client.onPromptResult(frame => completed.resolve(frame));
  const response = await connection.request({ type: "prompt", message: "stored first" }, "persisted-input-17");
  expect(response.id).toBe("persisted-input-17");
  expect(response.success).toBe(true);
  expect(await completed.promise).toMatchObject({ id: "persisted-input-17" });
  expect(host.received.find(frame => frame.type === "prompt")?.id).toBe("persisted-input-17");
});

test("detach and native client stop do not shut down the host; manual reconnect is independent", async () => {
  const host = await fixture();
  const first = await connect(host.socketPath);
  await first.close();
  await first.exited;
  const second = await connect(host.socketPath);
  await second.client.stop();
  await second.exited;
  const third = await connect(host.socketPath);
  cleanups.push(() => third.close());
  expect(host.connections).toBe(3);
  expect(host.received.some(frame => frame.type === "shutdown_host")).toBe(false);
  expect((await third.client.getState()).sessionId).toBe("fixture-session");
});

test("original UI requests and notices survive fragmented UTF-8 transport", async () => {
  const host = await fixture();
  const connection = await connect(host.socketPath);
  cleanups.push(() => connection.close());
  const events = new EventEmitter();
  const unsubscribe = connection.onFrame(frame => { events.emit("frame", frame); });
  const ui = { type: "extension_ui_request", id: "original-ui-23", method: "confirm", title: "승인 요청", timeout: 1234 };
  const notice = { type: "notice", message: "keep original details", details: { lane: "A" } };
  const uiFrame = nextFrame(events, "frame", frame => frame.type === "extension_ui_request");
  const noticeFrame = nextFrame(events, "frame", frame => frame.type === "notice");
  const bytes = Buffer.from(`${JSON.stringify(ui)}\n${JSON.stringify(notice)}\n`);
  for (const peer of host.peers) {
    const split = bytes.indexOf(Buffer.from("승")) + 1;
    peer.write(bytes.subarray(0, split));
    peer.write(bytes.subarray(split));
  }
  expect(await uiFrame).toEqual(ui);
  expect(await noticeFrame).toEqual(notice);
  const answer = nextFrame(host.events, "received", frame => frame.type === "extension_ui_response");
  connection.uiResponse(ui.id, { confirmed: true });
  expect(await answer).toEqual({ type: "extension_ui_response", id: ui.id, confirmed: true });
  unsubscribe();
});

test("disconnect rejects an outstanding request without reconnecting or replaying", async () => {
  const host = await fixture((frame, peer) => {
    if (frame.type !== "prompt") return false;
    peer.destroy();
    return true;
  });
  const connection = await connect(host.socketPath);
  const outcome = connection.request({ type: "prompt", message: "ambiguous external effect" }, "never-replay");
  await expect(outcome).rejects.toThrow();
  await connection.exited;
  expect(host.connections).toBe(1);
  const reconnected = await connect(host.socketPath);
  cleanups.push(() => reconnected.close());
  expect(host.received.filter(frame => frame.id === "never-replay")).toHaveLength(1);
});

test("independent clients can use identical persisted ids without cross-routing", async () => {
  const host = await fixture();
  const first = await connect(host.socketPath);
  const second = await connect(host.socketPath);
  cleanups.push(() => first.close(), () => second.close());
  const [a, b] = await Promise.all([
    first.request({ type: "echo", message: "first" }, "same-id"),
    second.request({ type: "echo", message: "second" }, "same-id"),
  ]);
  expect(a).toMatchObject({ id: "same-id", data: { message: "first" } });
  expect(b).toMatchObject({ id: "same-id", data: { message: "second" } });
});

test("out-of-order requests retain explicit identities and duplicate outstanding ids fail", async () => {
  const held: Array<{ frame: HostFrame; peer: net.Socket }> = [];
  const host = await fixture((frame, peer) => {
    if (frame.type !== "hold") return false;
    held.push({ frame, peer });
    return true;
  });
  const connection = await connect(host.socketPath);
  cleanups.push(() => connection.close());
  const received = nextFrame(host.events, "received", frame => frame.id === "second-id");
  const first = connection.request({ type: "hold" }, "first-id");
  const second = connection.request({ type: "hold" }, "second-id");
  expect(() => connection.request({ type: "hold" }, "first-id")).toThrow("already outstanding");
  await received;
  for (const { frame, peer } of held.reverse()) {
    host.send(peer, { type: "response", id: frame.id, command: frame.type, success: true, data: { original: frame.id } });
  }
  expect(await first).toMatchObject({ id: "first-id", data: { original: "first-id" } });
  expect(await second).toMatchObject({ id: "second-id", data: { original: "second-id" } });
});

test("socket writes are bounded and fail rather than retaining an unbounded prompt", async () => {
  const host = await fixture();
  const connection = await connect(host.socketPath);
  cleanups.push(() => connection.close());
  await expect(connection.request({ type: "prompt", message: "x".repeat(17 * 1024 * 1024) }, "too-large")).rejects.toThrow("backlog");
  await connection.exited;
  expect(host.received.some(frame => frame.id === "too-large")).toBe(false);
});

test("rejects shared socket directories, permissive sockets, symlinks, and non-sockets", async () => {
  const host = await fixture();
  await fs.chmod(host.root, 0o755);
  await expect(connect(host.socketPath)).rejects.toThrow("0700");
  await fs.chmod(host.root, 0o700);
  await fs.chmod(host.socketPath, 0o644);
  await expect(connect(host.socketPath)).rejects.toThrow("0600");
  await fs.chmod(host.socketPath, 0o600);
  const link = path.join(host.root, "link.sock");
  await fs.symlink(host.socketPath, link);
  await expect(connect(link)).rejects.toThrow("0600");
  const alias = path.join(host.root, "alias");
  await fs.symlink(host.root, alias);
  await expect(connect(path.join(alias, "h.sock"))).rejects.toThrow("0700");
  const file = path.join(host.root, "file.sock");
  await fs.writeFile(file, "not a socket", { mode: 0o600 });
  await expect(connect(file)).rejects.toThrow("0600");
});

function options(root: string): HostOptions {
  return {
    command: [path.join(root, "host.ts")],
    socketPath: path.join(root, "new.sock"), sessionFile: path.join(root, "session.jsonl"),
    cwd: root, extensionPath: path.join(root, "extension.ts"), env: {
      HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: path.join(root, "agent"),
      XDG_CONFIG_HOME: path.join(root, "config"), PATH: process.env.PATH ?? "/usr/bin:/bin",
    },
    managedUlwPath: path.resolve(import.meta.dir, "fixtures/managed-ulw"),
    logPath: path.join(root, "host.log"), model: "provider/model", subagentConcurrency: 2,
  };
}

test("managed activity projection does not withhold snapshots from a later plain RpcClient subscriber", async () => {
  const root = await directory(true);
  const launch = options(root);
  const messageId = "msg-1";
  const message = { role: "assistant", content: [{ type: "text", text: "partial 🌊".repeat(256) }] };
  const update = { type: "message_update", messageId, message,
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "🌊", partial: message } };
  const final = { ...message, stopReason: "stop" };
  const done = { type: "message_update", messageId, message: final,
    assistantMessageEvent: { type: "done", reason: "stop", message: final } };
  const started = { type: "message_start", messageId, message: { ...message, content: [] } };
  const notice = { type: "extension_ui_request", id: "projection-notice", method: "notify", message: "Activity present" };
  const ended = { type: "message_end", messageId, message: final };
  const terminal = { type: "agent_end", messages: [final] };
  const settled = { type: "session_settled" };
  const nativeFrames = [started, update, notice, done, ended, terminal, settled];
  await writeStockHostExecutable(launch.command[0]!, `
import { recordHostFixture } from ${JSON.stringify(path.resolve(import.meta.dir, "fixtures/host-fixture-processes.ts"))};
import { stockHostFixture } from ${JSON.stringify(path.resolve(import.meta.dir, "fixtures/stock-host.ts"))};
recordHostFixture(${JSON.stringify(root)});
const frames = ${JSON.stringify(nativeFrames)};
const sessionEvents = new Set(["message_start", "message_update", "message_end", "agent_end"]);
let events = null;
let messageUpdates = "full";
await stockHostFixture({
  sessionFile: process.argv[process.argv.indexOf("--session") + 1],
  handle(command, native) {
    if (command.type === "set_event_filter") {
      events = command.events;
      messageUpdates = command.messageUpdates ?? "full";
      return { data: { events, messageUpdates } };
    }
    if (command.type !== "get_projection_fixture") return;
    for (const frame of frames) {
      if (events !== null && sessionEvents.has(frame.type) && !events.includes(frame.type)) continue;
      if (messageUpdates === "delta" && frame.assistantMessageEvent?.type === "text_delta") {
        const { partial, ...increment } = frame.assistantMessageEvent;
        native.send({ ...frame, message: { role: "assistant" }, assistantMessageEvent: increment });
      } else native.send(frame);
    }
    return { data: { emitted: true } };
  },
});
`);
  await startFixtureHost(launch);
  const managed = await HostConnection.connectForActivity(launch.socketPath);
  cleanups.push(() => managed.close());
  const plain = await HostConnection.connect(launch.socketPath);
  cleanups.push(() => plain.close());

  const sdkUpdates: unknown[] = [];
  const unsubscribe = plain.client.onSessionEvent(event => {
    if (event.type === "message_update") sdkUpdates.push(event);
  });
  cleanups.push(async () => { unsubscribe(); });
  const watch = (connection: HostConnection) => {
    const seen: HostFrame[] = [];
    const events = new EventEmitter();
    const off = connection.onFrame(frame => {
      if (frame.type === "response") return;
      seen.push(frame);
      events.emit("frame", frame);
    });
    cleanups.push(async () => { off(); });
    return nextFrame(events, "frame", frame => frame.type === "session_settled")
      .then(() => seen).finally(off);
  };
  const emit = async (id: string) => {
    const [compact, full, receipt] = await Promise.all([
      watch(managed),
      watch(plain),
      managed.request({ type: "get_projection_fixture" }, id),
    ]);
    expect(receipt).toMatchObject({ id, success: true, data: { emitted: true } });
    return { compact, full };
  };
  const managedFrames = [started, { type: "host_message_update_activity", messageId },
    notice, done, ended, terminal, settled];
  expect(await emit("projection-default")).toEqual({ compact: managedFrames, full: nativeFrames });

  // Explicit stock filters still belong to the native publisher. The reset
  // acknowledges native state and does not reset the private peer projection.
  expect(await plain.client.setEventFilter(["message_end"])).toEqual(["message_end"]);
  expect(sdkUpdates).toEqual([update, done]);
  const filtered = [notice, ended, settled];
  expect(await emit("projection-stock-filtered")).toEqual({ compact: filtered, full: filtered });
  expect(await plain.client.setEventFilter(null)).toBeNull();
  expect(await emit("projection-stock-reset")).toEqual({ compact: managedFrames, full: nativeFrames });
}, 60_000);

test("buildHostArgs keeps explicit persistence, native RPC UI, cwd, extension, and scoped configuration", async () => {
  const root = await directory();
  const launch = options(root);
  expect(await buildHostArgs(launch)).toEqual([
    "--mode", "rpc-ui",
    "--session", launch.sessionFile, "--cwd", root,
    "-e", path.resolve(import.meta.dir, "..") + path.sep,
    "-e", launch.managedUlwPath!, "-e", launch.extensionPath,
    "-e", path.resolve(import.meta.dir, "../src/board-extension.ts"),
    "-e", path.resolve(import.meta.dir, "../src/host-extension.ts"),
    "--config", `${launch.socketPath}.config.json`,
  ]);
  await expect(buildHostArgs({ ...launch, sessionFile: "" })).rejects.toThrow("sessionFile");
  await expect(buildHostArgs({ ...launch, socketPath: `/${"x".repeat(100)}` })).rejects.toThrow("100 bytes");
  await expect(buildHostArgs({ ...launch, subagentConcurrency: 0 })).rejects.toThrow("positive integer");
  await expect(buildHostArgs({ ...launch, command: [] })).rejects.toThrow("argv");
  await expect(buildHostArgs({ ...launch, managedUlwPath: root })).rejects.toThrow();
  await expect(buildHostArgs({ ...launch, modelPreset: { name: "invalid preset", preset: { modelRoles: {} } } })).rejects.toThrow("valid name");
  const inherited = { ...launch, managedUlwPath: undefined, env: {
    OMP_SUPERAGENT_MANAGED_ULW_PATH: "/must-not-select-a-parent-host-revision",
    OMP_SUPERAGENT_TEST_MANAGED_ULW_PATH: launch.managedUlwPath!,
  } };
  const args = await buildHostArgs(inherited);
  expect(args.filter(value => value === launch.managedUlwPath)).toHaveLength(1);
  expect(args).not.toContain("/must-not-select-a-parent-host-revision");
  expect(await buildHostArgs(launch, `${launch.socketPath}.config.json`, {
    extensionPaths: [launch.extensionPath], noExtensions: true,
  })).toEqual(["--mode", "rpc-ui", "--session", launch.sessionFile, "--cwd", root,
    "--no-extensions", "-e", launch.extensionPath, "--config", `${launch.socketPath}.config.json`]);
});

test("startHost probes but never adopts or unlinks an existing live socket", async () => {
  const host = await fixture();
  const launch = { ...options(host.root), socketPath: host.socketPath };
  const before = await fs.lstat(host.socketPath);
  await expect(startHost(launch)).rejects.toThrow("explicit adoption required");
  expect((await fs.lstat(host.socketPath)).ino).toBe(before.ino);
  expect(host.connections).toBe(1);
});

test("startHost preserves stale sockets for explicit operator cleanup", async () => {
  const host = await fixture();
  const stale = path.join(host.root, "stale.sock");
  const original = path.join(host.root, "original.sock");
  const server = net.createServer();
  const ready = Promise.withResolvers<void>();
  server.listen(original, () => ready.resolve());
  await ready.promise;
  await fs.chmod(original, 0o600);
  await fs.rename(original, stale);
  const closed = Promise.withResolvers<void>();
  server.close(() => closed.resolve());
  await closed.promise;
  const before = await fs.lstat(stale);
  expect(before.isSocket()).toBe(true);
  await expect(startHost({ ...options(host.root), socketPath: stale })).rejects.toThrow();
  expect((await fs.lstat(stale)).ino).toBe(before.ino);
});

test("a lane's native project denial blocks startup before publishing a session", async () => {
  const root = await directory();
  const launch = { ...options(root), cwd: path.join(root, "lane-checkout") };
  await fs.mkdir(path.join(root, "agent"), { mode: 0o700 });
  await fs.writeFile(path.join(root, "agent/config.yml"), JSON.stringify(offlineMnemopi));
  await fs.mkdir(path.join(launch.cwd, ".omp"), { recursive: true });
  const project = path.join(launch.cwd, ".omp/config.yml");
  const bytes = '{"memory":{"backend":"off"}}\n';
  await fs.writeFile(project, bytes);
  const launched = path.join(root, "native-launched");
  await writeStockHostExecutable(launch.command[0]!, `await Bun.write(${JSON.stringify(launched)}, "launched");`);

  await expect(startFixtureHost(launch)).rejects.toThrow("Effective backend is off (project settings)");

  expect(await Bun.file(launched).exists()).toBe(false);
  expect(await Bun.file(launch.sessionFile).exists()).toBe(false);
  expect(await fs.readFile(project, "utf8")).toBe(bytes);
}, 40_000);

test("startup failures are named and never include host log contents", async () => {
  const root = await directory();
  const launch = { ...options(root), command: [path.join(root, "missing-executable")] };
  await fs.writeFile(launch.logPath, "credential-secret-must-remain-in-log", { mode: 0o600 });
  const error = await startFixtureHost(launch).then(() => null, cause => cause);
  expect(error).toBeInstanceOf(HostStartError);
  expect(error.message).not.toContain("credential-secret");
});

test("fixture teardown joins the native process and owner when Host rejects after spawning", async () => {
  const root = await directory(true);
  const launch = options(root);
  const identityPath = path.join(root, "launch-identity.json");
  await writeStockHostExecutable(launch.command[0]!, `
import { writeFile } from "node:fs/promises";
import { recordHostFixture } from ${JSON.stringify(path.resolve(import.meta.dir, "fixtures/host-fixture-processes.ts"))};
import { stockHostFixture } from ${JSON.stringify(path.resolve(import.meta.dir, "fixtures/stock-host.ts"))};
recordHostFixture(${JSON.stringify(root)});
await writeFile(${JSON.stringify(identityPath)}, JSON.stringify({ pid: process.pid, ownerPid: process.ppid }));
// A rejected startup kills the owner first. Keep this native child alive
// independently of stdin EOF to exercise fixture custody of both processes.
await stockHostFixture({
  sessionFile: process.argv[process.argv.indexOf("--session") + 1],
  state: () => ({ observationHeld: true }),
  exit: () => new Promise(() => {}),
});
`);
  await expect(startFixtureHost(launch)).rejects.toThrow("Native owned work or durable observations cannot be authoritatively established");
  const { pid, ownerPid }: { pid: number; ownerPid: number } = await Bun.file(identityPath).json();
  expect(pid).not.toBe(ownerPid);
  // Native control remains live even when the owner's shutdown closes its pipes.
  expect(() => process.kill(pid, 0)).not.toThrow();
  const unrelated = Bun.spawn([process.execPath, "--no-env-file", "-e", "process.stdin.pipe(process.stdout)"], {
    env: { OMP_TEST_HOST_FIXTURE_ROOT: root },
    stdin: "pipe", stdout: "pipe", stderr: "inherit",
  });
  try {
    await stopHostFixtures(root);
    await waitForFixtureProcessExit([pid, ownerPid]);
    unrelated.stdin.write("unregistered process survives cleanup");
    unrelated.stdin.end();
    expect(await new Response(unrelated.stdout).text()).toBe("unregistered process survives cleanup");
    expect(await unrelated.exited).toBe(0);
  } finally {
    if (unrelated.exitCode === null && unrelated.signalCode === null) unrelated.kill();
    await unrelated.exited;
  }
}, 60_000);

test("exit persistence does not depend on a lane checkout still being at its original path", async () => {
  const root = await directory(true);
  const launch = { ...options(root), cwd: path.join(root, "checkout") };
  await fs.mkdir(launch.cwd);
  await writeStockHostExecutable(launch.command[0]!, `
import { recordHostFixture } from ${JSON.stringify(path.resolve(import.meta.dir, "fixtures/host-fixture-processes.ts"))};
import { stockHostFixture } from ${JSON.stringify(path.resolve(import.meta.dir, "fixtures/stock-host.ts"))};
recordHostFixture(${JSON.stringify(root)});
await stockHostFixture({ sessionFile: process.argv[process.argv.indexOf("--session") + 1] });
`);
  const { pid } = await startFixtureHost(launch);
  const connection = await connect(launch.socketPath);
  try {
    const state = await connection.client.getState();
    await fs.rename(launch.cwd, path.join(root, "moved"));
    expect(await connection.request({ type: "shutdown_host" })).toMatchObject({ success: true });
    await waitForFixtureProcessExit([pid, state.adapterOwnerPid]);
    expect(await Bun.file(`${launch.socketPath}.exit.json`).json()).toMatchObject({
      pid, ownerPid: state.adapterOwnerPid, sessionId: state.sessionId, persisted: true, observationsFlushed: true,
    });
  } finally { await connection.close(); }
}, 60_000);

test("detached Host preserves launch configuration and reconnects to the same private, ready peer", async () => {
  const root = await directory(true);
  const launch = options(root);
  const credentialNames = ["TEST_HOST_DISCORD_TOKEN", "TEST_HOST_TELEGRAM_TOKEN", "TEST_HOST_SLACK_BOT_TOKEN", "TEST_HOST_SLACK_APP_TOKEN"];
  const previous = new Map(credentialNames.map(name => [name, process.env[name]]));
  launch.env = { ...launch.env, TEST_HOST_PROVIDER_AUTH: "preserved-model-auth", TEST_HOST_EXPLICIT: "supplied-environment" };
  await writeStockHostExecutable(launch.command[0]!, `
import * as fs from "node:fs";
import { recordHostFixture } from ${JSON.stringify(path.resolve(import.meta.dir, "fixtures/host-fixture-processes.ts"))};
import { stockHostFixture } from ${JSON.stringify(path.resolve(import.meta.dir, "fixtures/stock-host.ts"))};
recordHostFixture(${JSON.stringify(root)});
const args = process.argv.slice(2);
const value = flag => args[args.indexOf(flag) + 1];
const sessionFile = value("--session");
fs.writeFileSync(${JSON.stringify(path.join(root, "observed.json"))}, JSON.stringify({ args, config: JSON.parse(fs.readFileSync(value("--config"), "utf8")), cwd: process.cwd(), credentialPresent: ${JSON.stringify(credentialNames)}.map(name => Object.hasOwn(process.env, name)), providerAuth: process.env.TEST_HOST_PROVIDER_AUTH, explicit: process.env.TEST_HOST_EXPLICIT, managedUlwPath: process.env.OMP_SUPERAGENT_MANAGED_ULW_PATH, fixtureUlwPath: process.env.OMP_SUPERAGENT_TEST_MANAGED_ULW_PATH }));
const socketPath = process.env.OMP_SUPERAGENT_NATIVE_SOCKET;
let beforeInode;
await stockHostFixture({ sessionFile, beforeReady: async () => {
  fs.chmodSync(socketPath, 0o644);
  beforeInode = fs.lstatSync(socketPath).ino;
  await Bun.sleep(250);
  fs.chmodSync(socketPath, 0o600);
}, connected: () => {
  const { ino, mode } = fs.lstatSync(socketPath);
  fs.appendFileSync(${JSON.stringify(path.join(root, "connections.jsonl"))},
    JSON.stringify({ beforeInode, ino, mode: mode & 0o777, pid: process.pid }) + "\\n");
} });
`);
  launch.command = [path.relative(process.cwd(), launch.command[0]!)];
  let pid: number;
  try {
    for (const name of credentialNames) process.env[name] = "must-not-reach-lane";
    ({ pid } = await startFixtureHost(launch));
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  const receipt = Bun.file(`${launch.socketPath}.exit.json`);
  const observed = await Bun.file(path.join(root, "observed.json")).json();
  expect(observed.credentialPresent).toEqual([false, false, false, false]);
  expect(observed.providerAuth).toBe("preserved-model-auth");
  expect(observed.explicit).toBe("supplied-environment");
  expect(observed.managedUlwPath).toBe(launch.managedUlwPath);
  expect(observed.fixtureUlwPath).toBe(launch.managedUlwPath);
  expect(observed.args.filter((arg: string) => arg === launch.managedUlwPath)).toHaveLength(1);
  expect(observed.config).toEqual({ task: { maxConcurrency: 2 }, goal: { continuationModes: ["rpc"] },
    modelRoles: { default: "provider/model" } });
  expect(observed.cwd).toBe(root);
  expect(observed.args).toContain("rpc-ui");
  expect(observed.args).not.toContain("--auto-approve");
  const connections = (await fs.readFile(path.join(root, "connections.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(connections.length).toBeGreaterThan(0);
  for (const peer of connections) expect(peer).toMatchObject({ beforeInode: peer.ino, mode: 0o600, pid });
  const attached = await connect(launch.socketPath);
  try { expect((await attached.client.getState()).hostPid).toBe(pid); }
  finally { await attached.close(); }
  const reattached = await connect(launch.socketPath);
  try {
    const identity = await reattached.client.getState();
    expect(identity.hostPid).toBe(pid);
    expect(identity.adapterOwnerPid).not.toBe(pid);
    await assertResidentFixtureOwner(root, { nativePid: pid, ownerPid: identity.adapterOwnerPid });
    expect(await reattached.request({ type: "shutdown_host" })).toMatchObject({ success: true });
    await Promise.race([reattached.exited, once(AbortSignal.timeout(5_000), "abort").then(() => {
      throw new Error("Host acknowledged shutdown but did not disconnect");
    })]);
    expect(await receipt.json()).toMatchObject({ pid, ownerPid: identity.adapterOwnerPid,
      code: 0, signal: null, persisted: true, observationsFlushed: true });
    // A durable native exit receipt and client disconnect do not prove the
    // detached pipe owner is gone. The fixture fallback has not run yet.
    await waitForFixtureProcessExit([pid, identity.adapterOwnerPid]);
  } finally { await reattached.close(); }
}, 60_000);

test("repeated Host starts reuse the executable inspection and prepare in one helper spawn", async () => {
  const roots = [await directory(true), await directory(true)];
  const executable = path.join(roots[0]!, "host.ts");
  await writeStockHostExecutable(executable, `
import { recordHostFixture } from ${JSON.stringify(path.resolve(import.meta.dir, "fixtures/host-fixture-processes.ts"))};
import { stockHostFixture } from ${JSON.stringify(path.resolve(import.meta.dir, "fixtures/stock-host.ts"))};
recordHostFixture(process.env.TEST_HOST_FIXTURE_ROOT);
await stockHostFixture({ sessionFile: process.argv[process.argv.indexOf("--session") + 1] });
`);
  const helper = [process.execPath, "--no-env-file", path.resolve(import.meta.dir, "../src/host-sdk-helper.ts"), "launch"];
  const spawned: string[][][] = [];
  const spy = spyOn(Bun, "spawn");
  try {
    for (const root of roots) {
      spy.mockClear();
      const launch = { ...options(root), command: [executable] };
      launch.env = { ...launch.env, TEST_HOST_FIXTURE_ROOT: root };
      await startFixtureHost(launch);
      // node:child_process launches the resident owner through Bun.spawn's
      // options form; its argv ends in a fresh private manifest path.
      spawned.push(spy.mock.calls.map(([command]) => Array.isArray(command) ? command
        : [(command as unknown as { cmd: string[] }).cmd[0]!]));
      expect(await Bun.file(launch.sessionFile).exists()).toBe(true);
    }
  } finally { spy.mockRestore(); }
  // Before: three CLI probes, launch discovery, session preparation and the
  // owner on every start (6 spawns). Now the probes run once per executable
  // identity and one helper both discovers the launch and prepares the
  // session: 5 spawns for the first start, 2 for each later one.
  expect(spawned).toEqual([
    [[executable, "--version"], [executable, "--help"], [executable, "ps", "--help"], helper, [hostOwnerExecutable]],
    [helper, [hostOwnerExecutable]],
  ]);
}, 60_000);
