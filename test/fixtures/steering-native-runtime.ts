import { Database } from "bun:sqlite";
import { expect } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import { parseSessionEntries, type FileEntry } from "@oh-my-pi/pi-coding-agent";
import { type Config, hostPaths, privateDirectory } from "../../src/config";
import type { Approval, Inbound, Lane, MessageReference, Messenger, OutputRecord, Route } from "../../src/contracts";
import { HostConnection, startHost, type HostFrame, type HostOptions } from "../../src/host";
import { Superagent } from "../../src/runtime";
import { Store } from "../../src/store";
import { nativeDisabledProviders } from "./native-extension";
import { nativeRequestEnvelope } from "./native-request-envelope";
import { steeringModel, steeringRecord } from "./steering-native-extension";

type Handlers = Parameters<Messenger["start"]>[0];
type Trace = { sequence: number; socketPath: string; frame: HostFrame; inputStates?: Record<string, string> };
type Admission = { socketPath: string; id: string | undefined; command: Record<string, unknown>; response: unknown };
type Gate = { token: string; run: number; sessionId: string; pid: number; socket: net.Socket };
type Observation = { phase: string; run: number; sessionId: string; requestId?: string; requestIds?: string[]; sourceIds?: string[]; token?: string };

// Deadlines bound actual child-process/socket events; fake clocks cannot drive OMP's process.
async function within<T>(promise: Promise<T>, label: string, ms = 40_000): Promise<T> {
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(() => timeout.reject(new Error(`Native steering deadline: ${label}`)), ms);
  try { return await Promise.race([promise, timeout.promise]); }
  finally { clearTimeout(timer); }
}

// These are cooperative condition drains, not elapsed-time success criteria.
async function until(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 40_000;
  await within((async () => {
    while (!await predicate()) {
      if (Date.now() >= deadline) throw new Error(`Native steering condition deadline: ${label}`);
      const drain = Promise.withResolvers<void>();
      setImmediate(drain.resolve);
      await drain.promise;
    }
  })(), label);
}

class RecordingMessenger implements Messenger {
  handlers?: Handlers;
  readonly sent: Array<OutputRecord & { sequence: number; inputStates: Record<string, string> }> = [];
  readonly creations: Array<{ route: Route; title: string; sourceMessageId?: string; destination: Route }> = [];
  constructor(private readonly snapshot: () => { sequence: number; inputStates: Record<string, string> }) {}
  async start(handlers: Handlers): Promise<void> { this.handlers = handlers; }
  async deliver(input: Inbound): Promise<void> {
    if (!this.handlers) throw new Error("Recording Messenger is not started");
    await this.handlers.message(input);
  }
  async send(output: OutputRecord): Promise<string> {
    this.sent.push({ ...structuredClone(output), ...this.snapshot() });
    return `native-steering-receipt:${output.id}`;
  }
  async canCreateThread(): Promise<boolean> { return true; }
  async createThread(route: Route, title: string, sourceMessageId?: string): Promise<Route> {
    // Recording adapter only: these are platform-shaped native route IDs, not live-account API calls.
    const destination = { ...route, threadId: String(8001 + this.creations.length) };
    this.creations.push({ route: structuredClone(route), title, sourceMessageId, destination });
    return destination;
  }
  async showApproval(_approval: Approval): Promise<string> { throw new Error("Unexpected native steering approval"); }
  async dismissApproval(): Promise<void> { throw new Error("Unexpected native steering approval dismissal"); }
  async fetchAfter(): Promise<Inbound[]> { return []; }
  async openAttachment(): Promise<Response> { throw new Error("Native steering fixture has no attachments"); }
  async stop(): Promise<void> { this.handlers = undefined; }
}

function users(entries: readonly FileEntry[]): Array<{ requestId: string; sourceId: string }> {
  return entries.flatMap(entry => {
    if (entry.type !== "message" || entry.message.role !== "user") return [];
    const content = entry.message.content;
    const text = typeof content === "string" ? content : content.filter(part => part.type === "text").map(part => part.text).join("\n");
    const envelope = nativeRequestEnvelope(text);
    return envelope ? [{ requestId: envelope.requestId, sourceId: envelope.sourceId }] : [];
  });
}

function observations(entries: readonly FileEntry[]): Observation[] {
  return entries.flatMap(entry => entry.type === "custom" && entry.customType === steeringRecord ? [entry.data as Observation] : []);
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
}

/** Independent real patched-OMP proof; existing native verification assets remain unchanged. */
export async function nativeSteeringRuntime(): Promise<void> {
  const parsed: unknown = JSON.parse(process.env.OMP_TEST_COMMAND ?? "null");
  if (!Array.isArray(parsed) || !parsed.length || parsed.some(value => typeof value !== "string" || !value))
    throw new Error("Native steering requires OMP_TEST_COMMAND as an explicit patched CLI argv JSON array");
  const nativeCommand: string[] = parsed;
  const natives = process.env.OMP_TEST_NATIVES_DIR;
  if (natives && !path.isAbsolute(natives)) throw new Error("OMP_TEST_NATIVES_DIR must be absolute");
  const managedUlwPath = process.env.OMP_TEST_ULW_EXTENSION
    ? path.dirname(await fs.realpath(path.resolve(process.env.OMP_TEST_ULW_EXTENSION)))
    : path.resolve(import.meta.dir, "managed-ulw");
  const root = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "oss-"));
  await fs.chmod(root, 0o700);
  const home = path.join(root, "home");
  const agent = path.join(root, "agent");
  const headCwd = path.join(root, "head");
  const workspaces = [path.join(root, "one"), path.join(root, "two")];
  for (const directory of [home, agent, headCwd, ...workspaces, path.join(root, "run"), path.join(root, "logs"), path.join(root, "sessions/main")]) privateDirectory(directory);
  await fs.writeFile(path.join(agent, "config.yml"), JSON.stringify({ disabledProviders: nativeDisabledProviders }), { mode: 0o600 });
  await fs.writeFile(path.join(agent, "models.yml"), "providers: {}\n", { mode: 0o600 });
  const settingsBefore = await Promise.all(["config.yml", "models.yml"].map(async name => ({ name, bytes: await fs.readFile(path.join(agent, name)) })));
  const barrierPath = path.join(root, "barrier.sock");
  const gates = new Map<string, Gate>();
  const sockets = new Set<net.Socket>();
  const errors: unknown[] = [];
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", error => errors.push(error));
    let data = "";
    socket.on("data", bytes => {
      data += bytes.toString();
      if (!data.includes("\n")) return;
      try {
        const hello = JSON.parse(data.trim()) as Omit<Gate, "socket">;
        if (gates.has(hello.token)) throw new Error(`Native tool barrier invoked twice: ${hello.token}`);
        gates.set(hello.token, { ...hello, socket });
      } catch (error) { errors.push(error); }
    });
  });
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(barrierPath, listening.resolve);
  await within(listening.promise, "private tool barrier listening");
  await fs.chmod(barrierPath, 0o600);
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, USERPROFILE: home,
    PI_CODING_AGENT_DIR: agent, PI_NO_TITLE: "1", CI: "true", NO_COLOR: "1",
    XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"),
    XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state"),
    OMP_SUPERAGENT_TEST_MANAGED_ULW_PATH: managedUlwPath, OMP_TEST_STEERING_BARRIER: barrierPath,
    TMPDIR: root, TMP: root, TEMP: root, ...(natives ? { PI_NATIVES_DIR: natives } : {}),
  };
  const fixture = path.resolve(import.meta.dir, "steering-native-extension.ts");
  const guard = path.resolve(import.meta.dir, "native-extension.ts");
  const command = ["/usr/bin/env", "-i", ...Object.entries(env).map(([name, value]) => `${name}=${value}`), ...nativeCommand, "-e", guard];
  const config: Config = {
    path: path.join(root, "superagent.json"), stateDir: root, headCwd, command,
    maxHosts: 3, maxSubagents: 3, idleMs: 3_600_000, model: `${steeringModel.provider}/${steeringModel.id}`,
    discord: { tokenEnv: "NATIVE_STEERING_DISCORD_TOKEN", ownerId: "1", allowedGuildIds: ["3"], allowedChannelIds: ["4"] },
  };
  await fs.writeFile(config.path, JSON.stringify(config), { mode: 0o600 });
  const mainPaths = hostPaths(config, "main");
  const mainOptions: HostOptions = { ...mainPaths, command, cwd: headCwd, env, extensionPath: fixture,
    managedUlwPath, model: config.model, subagentConcurrency: 1 };
  const databasePath = path.join(root, "coordination.sqlite");
  let store = new Store(databasePath);
  const ledger = new Database(databasePath, { readonly: true, strict: true });
  let sequence = 0;
  const trace: Trace[] = [];
  const admissions: Admission[] = [];
  const inputStateRows = ledger.query("SELECT id, state FROM inputs ORDER BY sequence");
  const inputStates = () => Object.fromEntries((inputStateRows.all() as Array<{ id: string; state: string }>)
    .map(input => [input.id, input.state]));
  const messenger = new RecordingMessenger(() => ({ sequence: ++sequence,
    inputStates: inputStates() }));
  const connections = new Set<HostConnection>();
  const owned = new Map<string, { pid: number; socketPath: string; sessionFile: string }>();
  let intentionallyKilledHead: number | undefined;
  const expectedReconnectFailures = new Set<unknown>();
  const expectedDisconnections: unknown[] = [];
  const capture = async (socketPath: string) => {
    let connection: HostConnection;
    try { connection = await HostConnection.connect(socketPath); }
    catch (error) {
      // The production controller makes one connection-only reconciliation
      // attempt after an actual disconnect. Only this exact killed endpoint's
      // failed attempt is expected; all other runtime errors remain failures.
      if (intentionallyKilledHead !== undefined && socketPath === mainPaths.socketPath) expectedReconnectFailures.add(error);
      throw error;
    }
    connections.add(connection);
    connection.onFrame(frame => {
      trace.push({ sequence: ++sequence, socketPath, frame: structuredClone(frame),
        ...(frame.type === "prompt_result" || frame.type === "session_settled"
          ? { inputStates: inputStates() } : {}) });
    });
    const request = connection.request.bind(connection);
    connection.request = async (command, id) => {
      const response = await request(command, id);
      if (command.type === "prompt")
        admissions.push({ socketPath, id, command: structuredClone(command), response: structuredClone(response) });
      return response;
    };
    return connection;
  };
  const makeRuntime = () => new Superagent(config, store, messenger, fixture, error => {
    if (expectedReconnectFailures.has(error)) expectedDisconnections.push(error);
    else errors.push(error);
  }, {
    startHost: async options => {
      const started = await startHost({ ...options, managedUlwPath });
      owned.set(options.socketPath, { ...started, socketPath: options.socketPath, sessionFile: options.sessionFile });
      return started;
    },
    connect: capture,
  });
  let runtime = makeRuntime();
  let succeeded = false;
  const route: Route = { platform: "discord", accountId: "2", authorityId: "1", guildId: "3", channelId: "4", threadId: null };
  const otherRoute: Route = { ...route, threadId: "7001" };
  const inbound = (id: string, destination: Route, text: string): Inbound & MessageReference => ({ id, messageId: id, route: destination,
    text, receivedAt: Date.now(), attachments: [] });
  const entries = async (sessionFile = mainPaths.sessionFile) => parseSessionEntries(await fs.readFile(sessionFile, "utf8"));
  const healthy = () => { if (errors.length) throw new AggregateError(errors, "Native steering runtime reported an error"); };
  const wait = (predicate: () => boolean | Promise<boolean>, label: string) => until(async () => { healthy(); return predicate(); }, label);
  const done = (...ids: string[]) => ids.every(id => store.input(id)?.state === "done");
  const results = (id: string) => trace.filter(event => event.frame.type === "prompt_result" && event.frame.id === store.input(id)?.requestId);
  const checkpoint = async (connection: HostConnection, count: number) => {
    await wait(async () => (await connection.client.getState()).queuedMessageCount === count, `native queue count ${count}`);
  };
  const gate = async (token: string) => {
    await wait(() => gates.has(token), `real native tool barrier ${token}`);
    return gates.get(token)!;
  };
  const release = (token: string) => {
    const current = gates.get(token);
    if (!current || current.socket.destroyed) throw new Error(`Native barrier is not live: ${token}`);
    current.socket.write("release\n");
  };
  const requireAdmission = (id: string, socketPath: string, steer: boolean) => {
    const input = store.input(id)!;
    const admitted = admissions.filter(value => value.id === input.requestId);
    expect(admitted).toHaveLength(1);
    expect(admitted[0]).toMatchObject({ socketPath, command: { type: "prompt", ...(steer ? { streamingBehavior: "steer" } : {}) },
      response: { command: "prompt", success: true } });
    expect(admitted[0]!.command.streamingBehavior).toBe(steer ? "steer" : undefined);
    // A queued prompt opens a real correlated native completion ticket; bare steer does not.
    expect(admitted[0]!.response).not.toHaveProperty("data");
    expect(results(id)).toHaveLength(1);
    expect(results(id)[0]!.frame).toMatchObject({ status: "completed", agentInvoked: true, sessionSettled: true });
  };
  try {
    const started = await startHost(mainOptions);
    owned.set(mainPaths.socketPath, { ...started, ...mainPaths });
    // Observe through a separate native connection without replacing the runtime's real transport.
    const main = await HostConnection.connect(mainPaths.socketPath);
    connections.add(main);
    const mainIdentity = await main.client.getState();
    expect(mainIdentity).toMatchObject({ hostPid: started.pid, sessionFile: mainPaths.sessionFile,
      isSettled: true, settingsScope: "session", model: steeringModel });
    await runtime.start();

    const first = inbound("101", route, "First head request [native-barrier:head-live]");
    const follow = inbound("102", route, "Ordinary same-route followup [native-follow]");
    const cross = inbound("103", otherRoute, "Independent cross-topic request [native-cross]");
    await messenger.deliver(first);
    const firstGate = await gate("head-live");
    expect(firstGate).toMatchObject({ pid: started.pid, sessionId: mainIdentity.sessionId, run: 1 });
    expect(store.input(first.id)?.state).toBe("submitted");
    await messenger.deliver(follow);
    await checkpoint(main, 1);
    await wait(() => admissions.some(value => value.id === store.input(follow.id)?.requestId), "native steer admission response");
    await messenger.deliver(cross);
    await runtime.kick();
    expect(store.input(follow.id)).toMatchObject({ target: "main", state: "submitted", route });
    expect(store.input(cross.id)).toMatchObject({ target: "main", state: "pending", requestId: null, route: otherRoute });
    expect((await main.client.getState()).queuedMessageCount).toBe(1);
    expect(results(first.id)).toHaveLength(0);
    expect(results(follow.id)).toHaveLength(0);
    expect(messenger.sent).toHaveLength(0);
    release("head-live");
    await wait(() => done(first.id, follow.id, cross.id) && messenger.sent.length === 2, "coalesced first answer and isolated cross-topic answer");
    requireAdmission(first.id, mainPaths.socketPath, false);
    requireAdmission(follow.id, mainPaths.socketPath, true);
    requireAdmission(cross.id, mainPaths.socketPath, false);
    expect(store.input(first.id)!.requestId).not.toBe(store.input(follow.id)!.requestId);
    const firstAnswer = messenger.sent.find(output => output.sourceId === first.id)!;
    expect(firstAnswer).toMatchObject({ route, text: "Native final 102; sources 101,102", inputStates: { "101": "done", "102": "done" } });
    expect(messenger.sent.filter(output => [first.id, follow.id].includes(output.sourceId))).toHaveLength(1);
    expect(messenger.sent.find(output => output.sourceId === cross.id)).toMatchObject({ route: otherRoute });
    const firstCompletion = results(first.id)[0]!;
    const followCompletion = results(follow.id)[0]!;
    expect(firstCompletion.inputStates).toMatchObject({ "101": "submitted", "102": "submitted" });
    expect(followCompletion.inputStates).toMatchObject({ "101": "submitted", "102": "submitted" });
    expect(firstAnswer.sequence).toBeGreaterThan(Math.max(firstCompletion.sequence, followCompletion.sequence));
    expect(trace.some(event => event.socketPath === mainPaths.socketPath && event.frame.type === "session_settled"
      && event.sequence > Math.max(firstCompletion.sequence, followCompletion.sequence) && event.sequence < firstAnswer.sequence)).toBe(true);
    const headObservations = observations(await entries());
    expect(headObservations.filter(value => value.phase === "answer")).toEqual([
      expect.objectContaining({ run: 1, requestId: follow.id, requestIds: [first.id, follow.id], sourceIds: [first.id, follow.id] }),
      expect.objectContaining({ run: 2, requestId: cross.id, requestIds: [first.id, follow.id, cross.id] }),
    ]);
    // This is the decisive native proof: no terminal agent_end between the live
    // tool barrier's run and the model call which actually consumed the second user input.
    const crossStart = trace.find(event => event.frame.type === "agent_start" && event.sequence > firstCompletion.sequence)!;
    expect(crossStart.sequence).toBeGreaterThan(followCompletion.sequence);
    expect(trace.filter(event => event.frame.type === "agent_start" && event.sequence < firstCompletion.sequence)).toHaveLength(1);
    const receivedFollow = trace.find(event => {
      const message = event.frame.message as { role?: string; content?: unknown } | undefined;
      if (event.frame.type !== "message_start" || message?.role !== "user") return false;
      const text = typeof message.content === "string" ? message.content : Array.isArray(message.content)
        ? message.content.filter(part => part.type === "text").map(part => part.text).join("\n") : "";
      return nativeRequestEnvelope(text)?.requestId === follow.id;
    });
    expect(receivedFollow).toBeDefined();
    expect(receivedFollow!.sequence).toBeLessThan(firstCompletion.sequence);
    expect(users(await entries())).toEqual([
      { requestId: first.id, sourceId: first.id }, { requestId: follow.id, sourceId: follow.id }, { requestId: cross.id, sourceId: cross.id },
    ]);

    const sourceOne = inbound("201", route, "[native-delegate] Topic one [native-barrier:lane-one]");
    const sourceTwo = inbound("202", route, "[native-delegate] Topic two [native-barrier:lane-two]");
    await messenger.deliver(sourceOne);
    await wait(() => done(sourceOne.id), "first explicit lane source reaches head");
    const selection = (sourceId: string, index: number) => ({ sourceId, title: `Native topic ${index + 1}`, kickoff: "I will inspect the requested workspace, perform the authorized work, and verify the result in this topic.", cwd: workspaces[index]!,
      model: steeringModel, modelReason: "Choose the verified local native model for deterministic independent-session proof." });
    const laneOne = await runtime.startLane(selection(sourceOne.id, 0));
    await gate("lane-one");
    await messenger.deliver(sourceTwo);
    await wait(() => done(sourceTwo.id), "second explicit lane source reaches head");
    const laneTwo = await runtime.startLane(selection(sourceTwo.id, 1));
    await gate("lane-two");
    const laneStateOne = store.lane(laneOne.id)!;
    const laneStateTwo = store.lane(laneTwo.id)!;
    expect(messenger.creations).toEqual([
      { route, title: "Native topic 1", sourceMessageId: sourceOne.messageId, destination: { ...route, threadId: "8001" } },
      { route, title: "Native topic 2", sourceMessageId: sourceTwo.messageId, destination: { ...route, threadId: "8002" } },
    ]);
    expect(laneStateOne.route).toEqual({ ...route, threadId: "8001" });
    expect(laneStateTwo.route).toEqual({ ...route, threadId: "8002" });
    expect(new Set([mainIdentity.sessionId, laneStateOne.sessionId, laneStateTwo.sessionId]).size).toBe(3);
    expect(new Set([mainPaths.sessionFile, laneStateOne.sessionFile, laneStateTwo.sessionFile]).size).toBe(3);
    expect(new Set([started.pid, laneStateOne.pid, laneStateTwo.pid]).size).toBe(3);
    expect(gates.get("lane-one")).toMatchObject({ sessionId: laneStateOne.sessionId, pid: laneStateOne.pid, run: 1 });
    expect(gates.get("lane-two")).toMatchObject({ sessionId: laneStateTwo.sessionId, pid: laneStateTwo.pid, run: 1 });
    const laneConnectionOne = await HostConnection.connect(laneStateOne.socketPath);
    const laneConnectionTwo = await HostConnection.connect(laneStateTwo.socketPath);
    connections.add(laneConnectionOne);
    connections.add(laneConnectionTwo);
    const laneFollow = inbound("203", laneStateOne.route, "[native-delegate] Explicitly send an update to running topic one");
    await messenger.deliver(laneFollow);
    await wait(() => done(laneFollow.id) && messenger.sent.some(output => output.sourceId === laneFollow.id),
      "bound-route ordinary message is acknowledged by head, not automatically dispatched");
    expect(messenger.sent.filter(output => output.sourceId === laneFollow.id)).toEqual([
      expect.objectContaining({ route: laneStateOne.route, text: `Native dispatch acknowledged ${laneFollow.id}; awaiting explicit lane coordination.` }),
    ]);
    expect((await laneConnectionOne.client.getState()).queuedMessageCount).toBe(0);
    await runtime.messageLane(laneOne.id, "Explicit running-lane followup [native-follow]", laneFollow.id);
    const laneOwner = `handoff:${sourceOne.id}:lane`;
    const laneJoined = `handoff:${laneFollow.id}:${laneOne.id}`;
    await checkpoint(laneConnectionOne, 1);
    await wait(() => admissions.some(value => value.id === store.input(laneJoined)?.requestId), "real lane steer admission");
    expect((await laneConnectionTwo.client.getState()).queuedMessageCount).toBe(0);
    expect(store.input(laneJoined)).toMatchObject({ target: laneOne.id, state: "submitted", route: laneStateOne.route });
    expect(results(laneOwner)).toHaveLength(0);
    expect(results(laneJoined)).toHaveLength(0);
    release("lane-one");
    await wait(() => done(laneOwner, laneJoined) && messenger.sent.some(output => output.sourceId === `report:${laneOwner}`),
      "coalesced lane report and head-mediated final delivery");
    requireAdmission(laneOwner, laneStateOne.socketPath, false);
    requireAdmission(laneJoined, laneStateOne.socketPath, true);
    expect(messenger.sent.filter(output => output.sourceId === `report:${laneOwner}`)).toEqual([
      expect.objectContaining({ route: laneStateOne.route }),
    ]);
    expect(messenger.sent.some(output => output.sourceId === `report:${laneJoined}`)).toBe(false);
    expect(observations(await entries(laneStateOne.sessionFile)).filter(value => value.phase === "answer")).toEqual([
      expect.objectContaining({ run: 1, requestId: laneJoined, requestIds: [laneOwner, laneJoined], sourceIds: [sourceOne.id, laneFollow.id] }),
    ]);
    expect(users(await entries(laneStateOne.sessionFile))).toEqual([
      { requestId: laneOwner, sourceId: sourceOne.id }, { requestId: laneJoined, sourceId: laneFollow.id },
    ]);
    expect(results(`handoff:${sourceTwo.id}:lane`)).toHaveLength(0);
    release("lane-two");
    const laneTwoOwner = `handoff:${sourceTwo.id}:lane`;
    await wait(() => done(laneTwoOwner) && messenger.sent.some(output => output.sourceId === `report:${laneTwoOwner}`),
      "second isolated lane completes on its own route");
    expect(users(await entries(laneStateTwo.sessionFile))).toEqual([{ requestId: laneTwoOwner, sourceId: sourceTwo.id }]);
    expect(messenger.sent.filter(output => output.sourceId === `report:${laneTwoOwner}`)).toEqual([
      expect.objectContaining({ route: laneStateTwo.route }),
    ]);
    expect(await main.client.getSubagents()).toEqual([]);
    expect(await laneConnectionOne.client.getSubagents()).toEqual([]);
    expect(await laneConnectionTwo.client.getSubagents()).toEqual([]);

    // Detach/restart the controller, keeping the actual native hosts and durable ledger.
    await runtime.stop();
    expect(messenger.handlers).toBeUndefined();
    store.close();
    store = new Store(databasePath);
    runtime = makeRuntime();
    await runtime.start();
    expect(await main.client.getState()).toMatchObject({ sessionId: mainIdentity.sessionId, hostPid: started.pid, isSettled: true });
    expect(await laneConnectionOne.client.getState()).toMatchObject({ sessionId: laneStateOne.sessionId, hostPid: laneStateOne.pid, isSettled: true });
    expect(await laneConnectionTwo.client.getState()).toMatchObject({ sessionId: laneStateTwo.sessionId, hostPid: laneStateTwo.pid, isSettled: true });
    const beforeReplay = { sent: messenger.sent.length, admissions: admissions.length,
      main: users(await entries()), one: users(await entries(laneStateOne.sessionFile)), two: users(await entries(laneStateTwo.sessionFile)) };
    await messenger.deliver(first);
    await messenger.deliver(follow);
    await messenger.deliver(sourceOne);
    expect((await runtime.startLane(selection(sourceOne.id, 0))).id).toBe(laneOne.id);
    await runtime.messageLane(laneOne.id, "Explicit running-lane followup [native-follow]", laneFollow.id);
    await runtime.kick();
    expect(messenger.creations).toHaveLength(2);
    expect(messenger.sent).toHaveLength(beforeReplay.sent);
    expect(admissions).toHaveLength(beforeReplay.admissions);
    expect(users(await entries())).toEqual(beforeReplay.main);
    expect(users(await entries(laneStateOne.sessionFile))).toEqual(beforeReplay.one);
    expect(users(await entries(laneStateTwo.sessionFile))).toEqual(beforeReplay.two);
    expect(store.input(follow.id)?.state).toBe("done");
    expect(store.input(laneJoined)?.state).toBe("done");

    const stopping = inbound("301", route, "Cancelable owner [native-barrier:head-stop]");
    const withdrawn = inbound("302", route, "This queued steer must never become a new turn [native-withdrawn]");
    const stop = inbound("303", route, "/stop");
    await messenger.deliver(stopping);
    await gate("head-stop");
    await messenger.deliver(withdrawn);
    await checkpoint(main, 1);
    await wait(() => admissions.some(value => value.id === store.input(withdrawn.id)?.requestId), "queued cancellation steer admitted");
    const beforeStopRunCount = trace.filter(event => event.socketPath === mainPaths.socketPath && event.frame.type === "agent_start").length;
    const sentBeforeStop = messenger.sent.length;
    await messenger.deliver(stop);
    await wait(async () => store.input(stopping.id)?.state === "cancelled" && store.input(withdrawn.id)?.state === "cancelled"
      && store.input(stop.id)?.state === "cancelled"
      && messenger.sent.some(output => output.id === `${stop.id}:head-control` && output.text.startsWith("HEAD stop confirmed:"))
      && (await main.client.getState()).isSettled === true, "native stop confirms cancellation and withdraws owner and steer");
    expect(messenger.sent.filter(output => output.id === `${stop.id}:head-control`)).toEqual([
      expect.objectContaining({ sourceId: stop.id, route, text: expect.stringContaining("HEAD stop confirmed:") }),
    ]);
    await wait(() => results(stopping.id).length === 1 && results(withdrawn.id).length === 1, "native aborted results for both correlated tickets");
    expect(results(stopping.id)[0]!.frame).toMatchObject({ status: "aborted", agentInvoked: true });
    expect(results(withdrawn.id)[0]!.frame).toMatchObject({ status: "aborted", agentInvoked: true });
    await runtime.kick();
    expect(await main.client.getState()).toMatchObject({ isSettled: true, isStreaming: false, queuedMessageCount: 0, hasOwnedRunningWork: false });
    expect(trace.filter(event => event.socketPath === mainPaths.socketPath && event.frame.type === "agent_start")).toHaveLength(beforeStopRunCount);
    expect(observations(await entries()).some(value => value.phase === "answer" && value.requestIds?.includes(withdrawn.id))).toBe(false);
    expect(users(await entries()).some(user => user.requestId === withdrawn.id)).toBe(false);
    expect(messenger.sent.slice(sentBeforeStop).every(output => output.sourceId === stop.id)).toBe(true);
    expect(messenger.sent.filter(output => [stopping.id, withdrawn.id].includes(output.sourceId))).toHaveLength(0);
    await messenger.deliver(withdrawn);
    await runtime.kick();
    expect(store.input(withdrawn.id)?.state).toBe("cancelled");
    expect((await main.client.getState()).queuedMessageCount).toBe(0);
    expect(trace.filter(event => event.socketPath === mainPaths.socketPath && event.frame.type === "agent_start")).toHaveLength(beforeStopRunCount);

    const interruptedOwner = inbound("401", route, "Crash-interrupted owner [native-barrier:head-crash]");
    const interruptedSteer = inbound("402", route, "Admitted steer must not replay after native process death [native-crash-follow]");
    await messenger.deliver(interruptedOwner);
    await gate("head-crash");
    await messenger.deliver(interruptedSteer);
    await checkpoint(main, 1);
    await wait(() => admissions.some(value => value.id === store.input(interruptedSteer.id)?.requestId), "crash-boundary native steer admission");
    expect(store.input(interruptedOwner.id)).toMatchObject({ state: "submitted", target: "main" });
    expect(store.input(interruptedSteer.id)).toMatchObject({ state: "submitted", target: "main" });
    expect(results(interruptedOwner.id)).toHaveLength(0);
    expect(results(interruptedSteer.id)).toHaveLength(0);
    await wait(async () => users(await entries()).some(user => user.requestId === interruptedOwner.id), "in-flight owner reaches durable native transcript before death");
    const crashIdentity = await main.client.getState();
    expect(crashIdentity).toMatchObject({ sessionId: mainIdentity.sessionId, sessionFile: mainPaths.sessionFile,
      hostPid: started.pid, isSettled: false, queuedMessageCount: 1 });
    expect(owned.get(mainPaths.socketPath)).toMatchObject({ pid: crashIdentity.hostPid, sessionFile: crashIdentity.sessionFile });
    const crashedPid = crashIdentity.hostPid;
    if (typeof crashedPid !== "number" || !Number.isSafeInteger(crashedPid) || crashedPid <= 0 || crashedPid !== started.pid)
      throw new Error("Refusing to kill a native head without a verified fixture-owned PID");
    const killedSocket = await fs.lstat(mainPaths.socketPath);
    expect(killedSocket.isSocket()).toBe(true);
    intentionallyKilledHead = crashedPid;
    process.kill(crashedPid, "SIGKILL");
    await within(main.exited, "fixture-owned native head disconnect after SIGKILL", 10_000);
    await wait(() => !alive(crashedPid), "fixture-owned killed head PID exits");
    await wait(() => store.input(interruptedOwner.id)?.state === "uncertain" && store.input(interruptedSteer.id)?.state === "uncertain",
      "both in-flight native receipts become uncertain on actual disconnect");
    await runtime.kick();
    await wait(() => messenger.sent.some(output => output.sourceId === interruptedOwner.id), "single durable owner uncertainty notice");
    expect(messenger.sent.filter(output => output.sourceId === interruptedOwner.id)).toHaveLength(1);
    expect(messenger.sent.filter(output => output.sourceId === interruptedSteer.id)).toHaveLength(0);
    expect(messenger.sent.filter(output => [interruptedOwner.id, interruptedSteer.id].includes(output.sourceId))
      .every(output => !output.text.startsWith("Native final "))).toBe(true);
    expect(results(interruptedOwner.id)).toHaveLength(0);
    expect(results(interruptedSteer.id)).toHaveLength(0);
    await runtime.stop();
    store = new Store(databasePath);
    expect(expectedDisconnections.length).toBeLessThanOrEqual(1);
    intentionallyKilledHead = undefined;
    healthy();

    // SIGKILL cannot run native socket teardown. Remove only the unchanged
    // endpoint whose exact session/PID identity we established before killing.
    expect(alive(crashedPid)).toBe(false);
    const staleSocket = await fs.lstat(mainPaths.socketPath).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (staleSocket) {
      expect(staleSocket.isSocket()).toBe(true);
      if (!process.getuid) throw new Error("Native socket ownership proof requires a Unix user identity");
      expect(staleSocket.uid).toBe(process.getuid());
      expect({ dev: staleSocket.dev, ino: staleSocket.ino }).toEqual({ dev: killedSocket.dev, ino: killedSocket.ino });
      await fs.unlink(mainPaths.socketPath);
    }
    const beforeNativeRestore = { admissions: admissions.length, sent: messenger.sent.length,
      users: users(await entries()), starts: trace.filter(event => event.socketPath === mainPaths.socketPath && event.frame.type === "agent_start").length,
      answerCount: observations(await entries()).filter(value => value.phase === "answer").length,
      owner: store.input(interruptedOwner.id), steer: store.input(interruptedSteer.id) };
    expect(beforeNativeRestore.users.filter(user => user.requestId === interruptedOwner.id)).toHaveLength(1);
    expect(beforeNativeRestore.users.some(user => user.requestId === interruptedSteer.id)).toBe(false);
    const replacement = await startHost({ ...mainOptions, model: undefined });
    owned.set(mainPaths.socketPath, { ...replacement, ...mainPaths });
    expect(replacement.pid).not.toBe(crashedPid);
    const restoredMain = await HostConnection.connect(mainPaths.socketPath);
    connections.add(restoredMain);
    expect(await restoredMain.client.getState()).toMatchObject({ hostPid: replacement.pid, sessionId: mainIdentity.sessionId,
      sessionFile: mainPaths.sessionFile, model: steeringModel, settingsScope: "session", isSettled: true, queuedMessageCount: 0 });
    runtime = makeRuntime();
    await runtime.start();
    expect(store.input(interruptedOwner.id)).toEqual(beforeNativeRestore.owner);
    expect(store.input(interruptedSteer.id)).toEqual(beforeNativeRestore.steer);
    expect(users(await entries())).toEqual(beforeNativeRestore.users);
    expect(observations(await entries()).filter(value => value.phase === "answer")).toHaveLength(beforeNativeRestore.answerCount);
    await messenger.deliver(interruptedOwner);
    await messenger.deliver(interruptedSteer);
    await messenger.deliver(sourceOne);
    expect((await runtime.startLane(selection(sourceOne.id, 0))).id).toBe(laneOne.id);
    await runtime.kick();
    expect(await restoredMain.client.getState()).toMatchObject({ hostPid: replacement.pid, sessionId: mainIdentity.sessionId,
      isSettled: true, isStreaming: false, queuedMessageCount: 0, hasOwnedRunningWork: false });
    expect(admissions).toHaveLength(beforeNativeRestore.admissions);
    expect(messenger.sent).toHaveLength(beforeNativeRestore.sent);
    expect(messenger.creations).toHaveLength(2);
    expect(trace.filter(event => event.socketPath === mainPaths.socketPath && event.frame.type === "agent_start")).toHaveLength(beforeNativeRestore.starts);
    expect(users(await entries())).toEqual(beforeNativeRestore.users);
    expect(store.input(interruptedOwner.id)).toMatchObject({ state: "uncertain", requestId: beforeNativeRestore.owner!.requestId });
    expect(store.input(interruptedSteer.id)).toMatchObject({ state: "uncertain", requestId: beforeNativeRestore.steer!.requestId });
    expect(results(interruptedOwner.id)).toHaveLength(0);
    expect(results(interruptedSteer.id)).toHaveLength(0);
    for (const settings of settingsBefore) expect(await fs.readFile(path.join(agent, settings.name))).toEqual(settings.bytes);
    healthy();
    succeeded = true;
  } catch (cause) {
    const diagnostic = { cause: String(cause), errors: errors.map(String), expectedDisconnections: expectedDisconnections.map(String), trace, admissions, sent: messenger.sent,
      creations: messenger.creations, inputs: ledger.query("SELECT * FROM inputs ORDER BY sequence").all(),
      lanes: ledger.query("SELECT * FROM lanes").all(), outputs: ledger.query("SELECT * FROM outputs ORDER BY sequence").all() };
    await fs.writeFile(path.join(root, "failure.json"), JSON.stringify(diagnostic, null, 2), { mode: 0o600 });
    throw new Error(`${cause instanceof Error ? cause.message : String(cause)}\nNative steering diagnostics retained: ${root}/failure.json`, { cause });
  } finally {
    try {
      await runtime.stop();
      const laneRows = ledger.query("SELECT data FROM lanes").all() as Array<{ data: string }>;
      for (const { data } of laneRows) {
        const lane = JSON.parse(data) as Lane;
        if (lane.pid) owned.set(lane.socketPath, { pid: lane.pid, socketPath: lane.socketPath, sessionFile: lane.sessionFile });
      }
      for (const host of owned.values()) {
        if (!alive(host.pid)) continue;
        let connection: HostConnection | undefined;
        let verified = false;
        try {
          connection = await HostConnection.connect(host.socketPath);
          const state = await connection.client.getState();
          if (state.hostPid !== host.pid || state.sessionFile !== host.sessionFile) throw new Error("Refusing foreign native steering host cleanup");
          verified = true;
          if (!state.isSettled) await connection.client.abortAndRestoreQueue();
          await connection.client.shutdownHost();
          await within(connection.exited, "owned native steering shutdown", 10_000);
          await within(until(() => !alive(host.pid), "owned native process exit"), "native process exit", 10_000);
        } catch (error) {
          if (!verified) throw error;
          if (alive(host.pid)) process.kill(host.pid, "SIGKILL");
          await within(until(() => !alive(host.pid), "owned native forced exit"), "native forced exit", 10_000);
        } finally { await connection?.close(); }
      }
    } finally {
      for (const connection of connections) await connection.close();
      for (const socket of sockets) socket.destroy();
      const closed = Promise.withResolvers<void>();
      server.close(error => error ? closed.reject(error) : closed.resolve());
      await closed.promise;
      ledger.close();
      store.close();
      if (succeeded) await fs.rm(root, { recursive: true, force: true });
    }
  }
}
