import { Database } from "bun:sqlite";
import { expect } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { watch } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseSessionEntries, type FileEntry, type SessionHeader } from "@oh-my-pi/pi-coding-agent";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { type Config, hostPaths, privateDirectory } from "../../src/config";
import type { Approval, Inbound, Lane, LanePresetSnapshot, Messenger, OutputRecord, Route } from "../../src/contracts";
import { buildHostArgs, HostConnection, startHost, type HostOptions } from "../../src/host";
import { Superagent } from "../../src/runtime";
import { NativePresetManager } from "../../src/native-presets";
import { Store } from "../../src/store";
import { Effort } from "../../.upstream/omp/packages/catalog/src/effort";
import { nativeDisabledProviders } from "./native-extension";
import { modelAbortMarker, modelCompactAbortInstructions, modelCompactInstructions, modelCompactMarker, modelCompactSummary,
  modelFixtureModels, modelFixtureProvider, modelJudgeMarker, modelRolesMarker } from "./model-selection-extension";
import { nativeRequestEnvelope } from "./native-request-envelope";

const selectionProviderFixture = path.resolve(import.meta.dir, "model-selection-extension.ts");
const networkGuardFixture = path.resolve(import.meta.dir, "native-extension.ts");
const reply = "Socket host smoke response";

type Handlers = Parameters<Messenger["start"]>[0];
class RecordingMessenger implements Messenger {
  readonly sent: OutputRecord[] = [];
  handlers?: Handlers;
  async start(handlers: Handlers): Promise<void> { this.handlers = handlers; }
  async deliver(input: Inbound): Promise<void> {
    if (!this.handlers) throw new Error("Messenger has not started");
    await this.handlers.message(input);
  }
  async send(output: OutputRecord): Promise<string> {
    this.sent.push(structuredClone(output));
    return `native-receipt:${output.id}`;
  }
  async showApproval(_approval: Approval): Promise<string> { throw new Error("Unexpected native dialog"); }
  async dismissApproval(_approval: Approval): Promise<void> { throw new Error("Unexpected native dialog dismissal"); }
  async createThread(_route: Route, _title: string): Promise<Route> { throw new Error("The independent thread already exists"); }
  async fetchAfter(_route: Route, _messageId: string): Promise<Inbound[]> { return []; }
  async openAttachment(): Promise<Response> { throw new Error("Native fixture has no authorized attachments"); }
  async stop(): Promise<void> { this.handlers = undefined; }
}

// All timers are external-process deadlines, never guessed delays.
async function within<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(() => timeout.reject(new Error(message)), ms);
  try { return await Promise.race([promise, timeout.promise]); }
  finally { clearTimeout(timer); }
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 40_000;
  // Native RPC completion and durable SQLite settlement are separate events.
  // Cooperative drains observe the real condition without relying on filesystem
  // notifications for native SQLite writes, which this platform does not emit.
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Native runtime did not reach: ${label}`);
    const drain = Promise.withResolvers<void>();
    setImmediate(drain.resolve);
    await drain.promise;
  }
}

async function readyHead(socketPath: string, child: ChildProcess, exited: Promise<unknown>): Promise<HostConnection> {
  let change = Promise.withResolvers<void>();
  const failure = Promise.withResolvers<never>();
  const watcher = watch(path.dirname(socketPath), () => change.resolve());
  watcher.on("error", failure.reject);
  const deadline = Date.now() + 45_000;
  const earlyExit = exited.then(() => { throw new Error("Native head exited before socket readiness"); });
  void earlyExit.catch(() => {});
  void failure.promise.catch(() => {});
  try {
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error("Native head exited during startup");
      try {
        if (((await fs.lstat(socketPath)).mode & 0o777) === 0o600) {
          return await HostConnection.connect(socketPath, Math.max(1, deadline - Date.now()));
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await within(Promise.race([change.promise, earlyExit, failure.promise]), Math.max(1, deadline - Date.now()), "Native head socket was not ready");
      change = Promise.withResolvers<void>();
    }
    throw new Error("Native head startup exceeded its deadline");
  } finally { watcher.close(); }
}

function requestIds(entries: readonly FileEntry[]): string[] {
  return entries.flatMap(entry => {
    if (entry.type !== "message" || entry.message.role !== "user") return [];
    const content = entry.message.content;
    const text = typeof content === "string" ? content : content.filter(part => part.type === "text").map(part => part.text).join("");
    const id = nativeRequestEnvelope(text)?.requestId;
    return id ? [id] : [];
  });
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function processExited(pid: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (alive(pid)) {
    if (Date.now() >= deadline) throw new Error(`Owned native process ${pid} did not exit`);
    const drain = Promise.withResolvers<void>();
    setImmediate(drain.resolve);
    await drain.promise;
  }
}

async function nativeModelRoles(connection: HostConnection, token: string): Promise<Record<string, unknown>> {
  const result = Promise.withResolvers<Record<string, unknown>>();
  const completion = Promise.withResolvers<Record<string, unknown>>();
  const id = `native-model-roles:${token}`;
  const unsubscribe = connection.onFrame(frame => {
    if (frame.type === "prompt_result" && frame.id === id) completion.resolve(frame);
    if (frame.type !== "extension_ui_request" || frame.method !== "notify" || typeof frame.message !== "string") return;
    try {
      const value: unknown = JSON.parse(frame.message);
      if (value && typeof value === "object" && Reflect.get(value, "fixture") === modelRolesMarker && Reflect.get(value, "token") === token)
        result.resolve(value as Record<string, unknown>);
    } catch { /* Other native notifications are unrelated to this checkpoint. */ }
  });
  try {
    expect(await connection.request({ type: "prompt", message: `/fixture-model-roles ${token}` }, id)).toMatchObject({ command: "prompt", success: true });
    const [roles, settled] = await within(Promise.all([result.promise, completion.promise]), 10_000, `Native model role checkpoint timed out: ${token}`);
    expect(settled).toMatchObject({ id, status: "completed", agentInvoked: false, sessionSettled: true });
    return roles;
  } finally { unsubscribe(); }
}

/** Both native registrations use the same isolated real-host lifecycle harness. */
export async function nativeRuntime(modelSelection = false): Promise<void> {
  const providerFixture = selectionProviderFixture;
  const mainModel = modelSelection ? modelFixtureModels.head : { provider: "socket-host-smoke", id: "local" };
  const laneModel = modelSelection ? modelFixtureModels.lane : mainModel;
  const modelReason = modelSelection
    ? "The native judge advised the head model; the head independently selected this available text chat model for the isolated lane."
    : "Use the available deterministic local text chat model for the native lifecycle proof.";
  const parsed: unknown = JSON.parse(process.env.OMP_TEST_COMMAND ?? "null");
  if (!Array.isArray(parsed) || !parsed.length || parsed.some(arg => typeof arg !== "string" || !arg)) {
    throw new Error("Native runtime smoke requires OMP_TEST_COMMAND as an explicit patched CLI argv JSON array");
  }
  const nativeCommand: string[] = parsed;
  const natives = process.env.OMP_TEST_NATIVES_DIR;
  if (natives && !path.isAbsolute(natives)) throw new Error("OMP_TEST_NATIVES_DIR must be absolute");
  const managedUlwPath = process.env.OMP_TEST_ULW_EXTENSION
    ? path.dirname(await fs.realpath(path.resolve(process.env.OMP_TEST_ULW_EXTENSION)))
    : path.resolve(import.meta.dir, "managed-ulw");
  const root = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "osr-"));
  await fs.chmod(root, 0o700);
  const home = path.join(root, "home");
  const agent = path.join(root, "agent");
  const headCwd = path.join(root, "head");
  const laneCwd = path.join(root, "topic");
  for (const directory of [home, agent, headCwd, laneCwd]) privateDirectory(directory);
  const middlePreset: LanePresetSnapshot = {
    modelRoles: { default: `${laneModel.provider}/${laneModel.id}`, smol: `${mainModel.provider}/${mainModel.id}`,
      judge: `${modelFixtureProvider}/${modelFixtureModels.judge.id}` }, defaultThinkingLevel: Effort.Minimal,
  };
  const lowPreset: LanePresetSnapshot = {
    modelRoles: { default: `${modelFixtureProvider}/${modelFixtureModels.changedLane.id}`,
      smol: `${modelFixtureProvider}/${modelFixtureModels.changedDefault.id}`,
      judge: `${modelFixtureProvider}/${modelFixtureModels.judge.id}` }, defaultThinkingLevel: Effort.Low,
  };
  // Production lane launches add a task-budget overlay, preserving this private
  // base policy. Never probe bundled providers or local model servers in smoke QA.
  const agentConfig = {
    disabledProviders: nativeDisabledProviders,
    ...(modelSelection ? {
      modelRoles: { default: `${mainModel.provider}/${mainModel.id}`, judge: `${modelFixtureProvider}/${modelFixtureModels.judge.id}` },
      modelPresets: {
        // Keep the base judge explicit: this preset exercises omitted thinking,
        // not native cross-layer role shadowing when a parent role is removed.
        high: { modelRoles: { default: `${mainModel.provider}/${mainModel.id}`,
          judge: `${modelFixtureProvider}/${modelFixtureModels.judge.id}` } },
        middle: middlePreset,
        low: lowPreset,
        preserved: { modelRoles: { default: `${mainModel.provider}/${mainModel.id}` } },
      },
      eval: { js: true, py: false },
      // Native manual compaction always retains a recent suffix. This fixture
      // has short deterministic turns, so retain one group rather than the
      // production 20k-token default, which correctly rejects tiny sessions.
      compaction: { methodOrder: ["soft"], keepRecentTokens: 1, autoContinue: false },
    } : {}),
  };
  await fs.writeFile(path.join(agent, "config.yml"), JSON.stringify(agentConfig), { mode: 0o600 });
  await fs.writeFile(path.join(agent, "models.yml"), "providers: {}\n", { mode: 0o600 });
  const nativeSettings = new Map(await Promise.all(["config.yml", "models.yml"].map(async name =>
    [name, await fs.readFile(path.join(agent, name))] as const)));
  const unchangedNativeSettings = async () => {
    for (const [name, bytes] of nativeSettings) expect(await fs.readFile(path.join(agent, name))).toEqual(bytes);
  };
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, USERPROFILE: home,
    PI_CODING_AGENT_DIR: agent, PI_NO_TITLE: "1", CI: "true", NO_COLOR: "1",
    XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"),
    XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state"),
    OMP_SUPERAGENT_TEST_MANAGED_ULW_PATH: managedUlwPath,
    TMPDIR: root, TMP: root, TEMP: root, ...(natives ? { PI_NATIVES_DIR: natives } : {}),
  };
  // startHost uses the supplied complete child environment. An exec-only env
  // wrapper keeps the real production launcher while isolating model providers for
  // every child, without mutating the test runner's process.env or its siblings.
  const command = ["/usr/bin/env", "-i", ...Object.entries(env).map(([name, value]) => `${name}=${value}`), ...nativeCommand, "-e", networkGuardFixture];
  const config: Config = {
    path: path.join(root, "superagent.json"), stateDir: root, headCwd, command,
    maxHosts: 2, maxSubagents: 2, idleMs: 3_600_000, model: `${mainModel.provider}/${mainModel.id}`,
    discord: { tokenEnv: "NATIVE_RUNTIME_DISCORD_TOKEN", ownerId: "1", allowedGuildIds: ["3"], allowedChannelIds: ["4"] },
  };
  await fs.writeFile(config.path, JSON.stringify(config), { mode: 0o600 });
  for (const directory of ["run", "sessions/main", "logs"]) privateDirectory(path.join(root, directory));
  const mainPaths = hostPaths(config, "main");
  const headOptions: HostOptions = {
    ...mainPaths, command, cwd: headCwd, env, extensionPath: providerFixture, managedUlwPath,
    model: config.model, subagentConcurrency: 1,
  };
  const nativeConfig = path.join(root, "head-config.json");
  await fs.writeFile(nativeConfig, JSON.stringify({ task: { maxConcurrency: 1 }, disabledProviders: nativeDisabledProviders }), { mode: 0o600 });
  const log = await fs.open(mainPaths.logPath, "wx", 0o600);
  const databasePath = path.join(root, "coordination.sqlite");
  const store = new Store(databasePath);
  const ledger = new Database(databasePath, { readonly: true, strict: true });
  const messenger = new RecordingMessenger();
  const errors: unknown[] = [];
  let headConnection: HostConnection | undefined;
  const presetSettings = modelSelection ? await Settings.loadIsolated({ cwd: headCwd, agentDir: agent }) : undefined;
  const presetManager = presetSettings ? new NativePresetManager(presetSettings, async () => {
    if (!headConnection) throw new Error("Native head catalog is not connected");
    const response = await headConnection.request({ type: "get_available_models" });
    if (!response.success || response.command !== "get_available_models") throw new Error("Native head did not return the full model catalog");
    return response.data.models;
  }, provider => provider === modelFixtureProvider) : undefined;
  const nativeResults: Array<Record<string, unknown>> = [];
  const runtime = new Superagent(config, store, messenger, providerFixture, error => {
    errors.push(error);
  }, {
    startHost: options => startHost({ ...options, managedUlwPath }),
    connect: async socketPath => {
      const connection = await HostConnection.connect(socketPath);
      connection.onFrame(frame => {
        if (frame.type === "prompt_result" && typeof frame.id === "string" && frame.id.startsWith("sg-")) nativeResults.push({ ...frame, socketPath });
      });
      return connection;
    },
    ...(presetManager ? {
      resolvePreset: (name, thinkingContext) => presetManager.resolve(name, thinkingContext), inspectPresets: () => presetManager.inspect(),
      persistPreset: selection => presetManager.persistSelection(selection),
    } : {}),
  });
  const exit = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
  void exit.promise.catch(() => {});
  let child: ChildProcess | undefined;
  let succeeded = false;
  const connections = new Set<HostConnection>();
  const headEvents: Array<Record<string, unknown>> = [];
  const owned = new Map<string, { socketPath: string; sessionFile: string; pid: number }>();
  const outbox = () => ledger.query("SELECT id, source_id, route, text, state, remote_id, error FROM outputs ORDER BY sequence").all() as Array<{
    id: string; source_id: string; route: string; text: string; state: string; remote_id: string | null; error: string | null;
  }>;
  const until = (predicate: () => boolean, label: string) => waitFor(() => {
    if (errors.length) throw new AggregateError(errors, "Production runtime reported an error");
    return predicate();
  }, label);
  const delivered = (id: string) => store.input(id)?.state === "done" && outbox().some(row => row.source_id === id && row.state === "sent");
  const firstHandoff = "handoff:102:lane";
  const report = (id: string) => `report:${id}`;
  const route: Route = { platform: "discord", accountId: "2", authorityId: "1", guildId: "3", channelId: "4", threadId: null };
  const inbound = (id: string, destination: Route, text: string): Inbound => ({ id, messageId: id, route: destination, text, receivedAt: Date.now(), attachments: [] });
  const ordinary = inbound("101", route, "Answer this ordinary head request using the local fixture.");
  const threadRoute = { ...route, threadId: "50" };
  const topic = inbound("102", threadRoute, "Handle this independent topic in its own workspace.");
  const followup = inbound("103", threadRoute, "Continue this independent topic in the same native session.");
  const modelChangeSource = inbound("104", route, "Explicitly change the idle independent lane to the native low preset.");
  const changedFollowup = inbound("105", threadRoute, "Continue this independent topic after its explicit model change.");
  const expectedDelivered = [ordinary, { ...topic, id: report(firstHandoff) }];
  let initialHeadRoles: Record<string, unknown> | undefined;
  let advisoryUsageIds: string[] = [];
  let confirmedHeadSettings: LanePresetSnapshot | undefined;
  let confirmedClearedRoles: string[] | undefined;
  let cancelledRequestId: string | undefined;
  const laneRoles = async (id: string, token: string) => {
    const connection = await HostConnection.connect(store.lane(id)!.socketPath);
    connections.add(connection);
    try { return { ...await nativeModelRoles(connection, token), state: await connection.client.getState() }; }
    finally { await connection.close(); }
  };
  try {
    child = spawn(command[0]!, [...command.slice(1), ...buildHostArgs(headOptions, nativeConfig)], {
      cwd: headCwd, env, detached: true, shell: false, stdio: ["ignore", log.fd, log.fd],
    });
    child.once("error", exit.reject);
    child.once("exit", (code, signal) => exit.resolve({ code, signal }));
    const initial = await readyHead(mainPaths.socketPath, child, exit.promise);
    headConnection = initial;
    connections.add(initial);
    initial.onFrame(frame => {
      if (frame.type === "message_update") return;
      headEvents.push({ at: Date.now(), ...frame });
      if (headEvents.length > 256) headEvents.shift();
    });
    const headState = await initial.client.getState();
    expect(headState).toMatchObject({ hostPid: child.pid, sessionFile: mainPaths.sessionFile, isSettled: true, model: mainModel, settingsScope: "session" });
    owned.set("main", { ...mainPaths, pid: child.pid! });
    await runtime.start();
    expect(store.getMeta("main:sessionId")).toBe(headState.sessionId);
    if (modelSelection) {
      initialHeadRoles = await nativeModelRoles(initial, "head-before-selection");
      await unchangedNativeSettings();
    }

    await messenger.deliver(ordinary);
    await until(() => delivered(ordinary.id), "ordinary request settlement and durable outbox receipt");
    expect(store.input(ordinary.id)).toMatchObject({ target: "main", state: "done", generation: 0, requestId: expect.stringMatching(/^sg-/) });
    expect(messenger.sent.map(output => ({ sourceId: output.sourceId, route: output.route, text: output.text }))).toEqual([{ sourceId: ordinary.id, route, text: reply }]);
    await messenger.deliver(ordinary); // An actual gateway replay must not prompt or deliver twice.
    await runtime.kick();
    expect(messenger.sent).toHaveLength(1);

    await messenger.deliver(topic);
    await until(() => store.input(topic.id)?.state === "done", "original topic reaches and settles in native head first");
    expect(store.input(topic.id)).toMatchObject({ target: "main", state: "done", route: threadRoute, text: topic.text });
    expect(store.input(`route:${topic.id}`)).toBeNull();
    expect(messenger.sent).toHaveLength(1); // Coordination responses are not user replies.

    if (modelSelection) {
      const available = await runtime.availableModels();
      expect(available).toEqual(expect.arrayContaining([
        expect.objectContaining({ ...mainModel, input: ["text"], reasoning: false }),
        expect.objectContaining({ ...laneModel, input: ["text"], reasoning: false }),
      ]));
      const entries = parseSessionEntries(await fs.readFile(mainPaths.sessionFile, "utf8"));
      const usage = entries.flatMap(entry => entry.type === "model_usage" && entry.purpose === "judge" ? [entry] : []);
      expect(usage.length).toBeGreaterThan(0);
      advisoryUsageIds = usage.map(entry => entry.id);
      expect(usage[0]).toMatchObject({
        purpose: "judge", role: "judge", provider: modelFixtureProvider, model: modelFixtureModels.judge.id,
        stopReason: "stop", usage: { cost: { total: 0 } },
      });
      expect(Number.isFinite(usage[0]!.usage.totalTokens)).toBe(true);
      expect(usage[0]!.usage.totalTokens).toBeGreaterThan(0);
      const evalCalls = entries.flatMap(entry => entry.type === "message" && entry.message.role === "assistant"
        ? entry.message.content.filter(part => part.type === "toolCall" && part.name === "eval") : []);
      expect(evalCalls).toHaveLength(1);
      const results = entries.flatMap(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "eval"
        ? [entry.message] : []);
      expect(results).toHaveLength(1);
      expect(results[0]!.isError).not.toBe(true);
      const decision = results[0]!.content.flatMap(part => part.type === "text" ? part.text.split("\n") : [])
        .flatMap(line => {
          try {
            const value: unknown = JSON.parse(line);
            return value && typeof value === "object" && Reflect.get(value, "fixture") === modelJudgeMarker ? [value] : [];
          } catch { return []; }
        });
      expect(decision).toHaveLength(1);
      expect(decision[0]).toMatchObject({
        selection: { choice: `${mainModel.provider}/${mainModel.id}` },
      });
      expect(laneModel).not.toEqual(mainModel); // Advisory choice is intentionally not binding.
    }

    const kickoffText = "I will inspect the requested workspace, perform the authorized work, and verify the result in this topic.";
    const created = await runtime.startLane({ sourceId: topic.id, title: "Native independent topic", kickoff: kickoffText, cwd: laneCwd,
      ...(modelSelection ? { preset: "middle" as const } : { model: laneModel }),
      modelReason, acceptance: ["Reply only inside the original topic thread"] });
    expect(created.route).toEqual(threadRoute);
    expect(created.cwd).toBe(laneCwd);
    await until(() => delivered(report(firstHandoff)), "lane report returns to head before external answer");
    const firstLane = store.lane(created.id)!;
    expect(firstLane.sessionId).toBeTruthy();
    expect(firstLane.sessionId).not.toBe(headState.sessionId);
    expect(firstLane.sessionFile).not.toBe(mainPaths.sessionFile);
    expect(firstLane.pid).not.toBe(child.pid);
    expect(firstLane.generation).toBe(1);
    expect(firstLane).toMatchObject({ model: laneModel, modelReason, modelPreset: modelSelection ? "middle" : null,
      modelPresetSnapshot: modelSelection ? middlePreset : null });
    expect(store.input(topic.id)).toMatchObject({ target: "main", state: "done", generation: 0 });
    expect(store.input(firstHandoff)).toMatchObject({ target: created.id, state: "done", generation: firstLane.generation, route: threadRoute });
    expect(store.input(report(firstHandoff))).toMatchObject({ target: "main", state: "done", route: threadRoute,
      text: expect.stringContaining(`sourceId: ${topic.id}; laneInputId: ${firstHandoff}`) });
    expect(await runtime.inspect(created.id)).toMatchObject({ sessionId: firstLane.sessionId,
      modelCheck: { expected: laneModel, actual: laneModel, error: null },
      state: { sessionId: firstLane.sessionId, sessionFile: firstLane.sessionFile, hostPid: firstLane.pid, isSettled: true, model: laneModel, settingsScope: "session" } });
    if (modelSelection) {
      const checkpoint = await laneRoles(created.id, "initial-middle");
      expect(checkpoint).toMatchObject({ model: laneModel, smol: mainModel, judge: modelFixtureModels.judge,
        state: { modelSettings: middlePreset } });
      expect(checkpoint.state.thinkingLevel).not.toBe(Effort.Low);
    }

    let unloadedTranscript: string | undefined;
    let changedModelReason: string | undefined;
    if (modelSelection) {
      await unchangedNativeSettings();
      // Real native shutdown, not a disconnected controller or a simulated store transition.
      await runtime.closeLane(created.id, "completed", "Observed a settled native answer and durable thread receipt.");
      await processExited(firstLane.pid!);
      await expect(fs.lstat(firstLane.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
      // Process/socket observations precede the controller's durable release
      // reconciliation; ACK alone must never clear native ownership.
      await runtime.kick();
      expect(store.lane(created.id)).toMatchObject({ workState: "completed", runtimeState: "unloaded", pid: null,
        model: laneModel, modelReason, modelPreset: "middle", modelPresetSnapshot: middlePreset,
        sessionId: firstLane.sessionId, sessionFile: firstLane.sessionFile });
      unloadedTranscript = await fs.readFile(firstLane.sessionFile, "utf8");
      expect(requestIds(parseSessionEntries(unloadedTranscript))).toEqual([firstHandoff]);
      config.model = `${modelFixtureProvider}/${modelFixtureModels.changedDefault.id}`;
      await fs.writeFile(config.path, JSON.stringify(config), { mode: 0o600 });
      await unchangedNativeSettings();
      // Simulate an operator editing only this test's isolated native config.
      // This deliberate edit establishes a new baseline; session-only model operations may never write it.
      const editedConfig = { ...agentConfig,
        modelRoles: { ...agentConfig.modelRoles, default: config.model },
        modelPresets: { ...agentConfig.modelPresets, middle: {
          modelRoles: { default: `${mainModel.provider}/${mainModel.id}`, smol: `${modelFixtureProvider}/${modelFixtureModels.changedDefault.id}`,
            judge: `${modelFixtureProvider}/${modelFixtureModels.judge.id}` }, defaultThinkingLevel: Effort.Minimal,
        } },
      };
      const editedBytes = Buffer.from(JSON.stringify(editedConfig));
      await fs.writeFile(path.join(agent, "config.yml"), editedBytes, { mode: 0o600 });
      nativeSettings.set("config.yml", editedBytes);
      await presetSettings!.reloadFromDisk();
      const editedPreset = await presetManager!.resolve("middle");
      expect(editedPreset).toMatchObject({ model: mainModel, preset: "middle" });
      expect(editedPreset.snapshot).not.toEqual(middlePreset);
    }

    await messenger.deliver(followup);
    await until(() => store.input(followup.id)?.state === "done", "bound follow-up reaches head before explicit delegation");
    if (modelSelection) await runtime.resume(created.id, followup.id);
    expect(store.input(followup.id)).toMatchObject({ target: "main", state: "done", route: threadRoute, generation: 0 });
    expect(requestIds(parseSessionEntries(await fs.readFile(firstLane.sessionFile, "utf8")))).toEqual([firstHandoff]);
    const followupHandoff = `handoff:${followup.id}:${created.id}`;
    await runtime.messageLane(created.id, followup.text, followup.id);
    await until(() => delivered(report(followupHandoff)), "explicit follow-up report and head answer settlement");
    expectedDelivered.push({ ...followup, id: report(followupHandoff) });
    const finalLane = store.lane(created.id)!;
    expect(finalLane).toMatchObject({ sessionId: firstLane.sessionId, sessionFile: firstLane.sessionFile,
      model: laneModel, modelReason, generation: firstLane.generation + (modelSelection ? 1 : 0) });
    if (modelSelection) {
      expect(finalLane.pid).not.toBe(firstLane.pid);
      expect(config.model).not.toBe(`${laneModel.provider}/${laneModel.id}`);
      expect((await fs.readFile(finalLane.sessionFile, "utf8")).startsWith(unloadedTranscript!)).toBe(true);
      expect(await runtime.inspect(created.id)).toMatchObject({
        model: laneModel, modelReason, modelPreset: "middle", modelPresetSnapshot: middlePreset,
        modelCheck: { expected: laneModel, actual: laneModel, error: null },
        state: { model: laneModel, sessionId: firstLane.sessionId, hostPid: finalLane.pid, isSettled: true,
          settingsScope: "session", modelSettings: middlePreset },
      });
      expect(await laneRoles(created.id, "resumed-middle")).toMatchObject({ model: laneModel, smol: mainModel, judge: modelFixtureModels.judge });
      await unchangedNativeSettings();
      console.log(JSON.stringify({ nativeResumeReopen: "passed", sourceId: followup.id, route: threadRoute,
        sessionId: finalLane.sessionId, generation: finalLane.generation, model: finalLane.model,
        preset: finalLane.modelPreset, transcriptPreserved: true }));

      // The authorization source is a real received request, never a generated event ID.
      await messenger.deliver(modelChangeSource);
      await until(() => delivered(modelChangeSource.id), "explicit model-change source request settlement");
      expect(store.input(modelChangeSource.id)).toMatchObject({ id: modelChangeSource.id, target: "main", state: "done", route });
      changedModelReason = "The head explicitly changed this settled lane to the native low text-chat preset.";
      await runtime.changeModel({ id: created.id, sourceId: modelChangeSource.id, preset: "low", modelReason: changedModelReason });
      expect(JSON.parse(store.getMeta(`lane-model:${created.id}:receipt:${modelChangeSource.id}`)!)).toMatchObject({
        sourceId: modelChangeSource.id, generation: finalLane.generation, previous: laneModel,
        model: modelFixtureModels.changedLane, reason: changedModelReason, preset: "low",
      });
      expect(store.getMeta(`lane-model:${created.id}:pending`)).toBe("");
      expect(store.lane(created.id)).toMatchObject({ model: modelFixtureModels.changedLane, modelPreset: "low", modelPresetSnapshot: lowPreset, modelReason: changedModelReason,
        sessionId: firstLane.sessionId, sessionFile: firstLane.sessionFile, pid: finalLane.pid, generation: finalLane.generation });
      expect(await runtime.inspect(created.id)).toMatchObject({
        modelCheck: { expected: modelFixtureModels.changedLane, actual: modelFixtureModels.changedLane, error: null },
        state: { model: modelFixtureModels.changedLane, sessionId: firstLane.sessionId, isSettled: true,
          settingsScope: "session", modelSettings: lowPreset },
      });
      expect(await laneRoles(created.id, "changed-low")).toMatchObject({ model: modelFixtureModels.changedLane,
        smol: modelFixtureModels.changedDefault, judge: modelFixtureModels.judge,
        state: { thinkingLevel: Effort.Low, modelSettings: lowPreset } });
      expect(await initial.client.getState()).toMatchObject({ model: mainModel, sessionId: headState.sessionId, modelSettings: headState.modelSettings });
      expect(await nativeModelRoles(initial, "head-after-lane-change")).toMatchObject({
        model: initialHeadRoles!.model, smol: initialHeadRoles!.smol, judge: initialHeadRoles!.judge,
      });
      await unchangedNativeSettings();
      await messenger.deliver(changedFollowup);
      await until(() => store.input(changedFollowup.id)?.state === "done", "changed-model follow-up reaches head first");
      expect(store.input(changedFollowup.id)).toMatchObject({ target: "main", state: "done", generation: 0, route: threadRoute });
      const changedHandoff = `handoff:${changedFollowup.id}:${created.id}`;
      await runtime.messageLane(created.id, changedFollowup.text, changedFollowup.id);
      await until(() => delivered(report(changedHandoff)), "new selected model reply returns to head before delivery");
      expect(store.input(changedHandoff)).toMatchObject({ target: created.id, state: "done", generation: finalLane.generation, route: threadRoute });
      expect(await initial.client.getState()).toMatchObject({ model: mainModel, sessionId: headState.sessionId, modelSettings: headState.modelSettings });
      await unchangedNativeSettings();
      expectedDelivered.push(modelChangeSource, { ...changedFollowup, id: report(changedHandoff) });
    } else expect(finalLane.pid).toBe(firstLane.pid);
    expect(store.input(followupHandoff)).toMatchObject({ target: created.id, state: "done", generation: finalLane.generation });
    expect(store.input(followupHandoff)?.requestId).not.toBe(store.input(firstHandoff)?.requestId);
    await messenger.deliver(topic);
    await messenger.deliver(followup);
    await runtime.kick();
    expect(store.inputs()).toEqual([]);
    expect(store.outputs()).toEqual([]);
    expect(store.approvals()).toEqual([]);
    const expectedSent = expectedDelivered.map(input => ({ sourceId: input.id, route: input.route, text: reply }));
    const expectedOutbox = expectedDelivered.map(input => ({
      id: `${input.id}:answer`, source_id: input.id, route: JSON.stringify(input.route), text: reply,
      state: "sent", remote_id: `native-receipt:${input.id}:answer`, error: null,
    }));
    expectedSent.splice(1, 0, { sourceId: firstHandoff, route: threadRoute, text: kickoffText });
    expectedOutbox.splice(1, 0, { id: `${topic.id}:kickoff`, source_id: firstHandoff, route: JSON.stringify(threadRoute),
      text: kickoffText, state: "sent", remote_id: `native-receipt:${topic.id}:kickoff`, error: null });
    expect(messenger.sent.map(output => ({ sourceId: output.sourceId, route: output.route, text: output.text }))).toEqual(expectedSent);
    expect(outbox()).toEqual(expectedOutbox);
    expect(errors).toEqual([]);

    if (modelSelection) {
      // Messenger controls use the real head RPC without a model turn, including
      // when sent from a conversation bound to an independent lane.
      const laneBefore = await laneRoles(finalLane.id, "before-head-controls");
      const laneTranscriptBefore = await fs.readFile(finalLane.sessionFile, "utf8");
      const laneRecordBefore = structuredClone(store.lane(finalLane.id));
      const headBefore = await nativeModelRoles(initial, "before-head-controls");
      const resultsBefore = nativeResults.length;
      const commandReply = async (id: string, text: string, outcome: "done" | "cancelled" = "done") => {
        await messenger.deliver(inbound(id, threadRoute, text));
        await until(() => store.input(id)?.state === outcome && outbox().some(row => row.source_id === id && row.state === "sent"), `head command ${text}`);
        const response = messenger.sent.find(output => output.sourceId === id)!;
        expect(response.route).toEqual(threadRoute);
        expect(response.text).not.toContain("local-test-only");
        expect(response.text).not.toContain("mock://");
        return response.text;
      };
      const visibleNumber = (text: string, value: number) => {
        expect(Number.isFinite(value)).toBe(true);
        expect(text.replaceAll(",", "")).toMatch(new RegExp(`\\b${String(value).replaceAll(".", "\\.")}\\b`));
      };
      const help = await commandReply("210", "/help");
      for (const name of ["help", "status", "stop", "context", "compact", "usage", "model", "effort"]) expect(help).toContain(`/${name}`);
      const status = await commandReply("211", "/status");
      expect(status).toContain(headState.sessionId);
      expect(status).toContain(`${mainModel.provider}/${mainModel.id}`);
      expect(status).toContain(finalLane.id);
      const nativeContext = (await initial.client.getState()).contextUsage;
      expect(nativeContext).toBeDefined();
      expect(nativeContext!.tokens).toBeGreaterThan(0);
      const context = await commandReply("212", "/context");
      visibleNumber(context, nativeContext!.tokens);
      visibleNumber(context, nativeContext!.contextWindow);
      const nativeUsage = await initial.client.getSessionStats();
      expect(nativeUsage.tokens.input).toBeGreaterThan(0);
      expect(nativeUsage.tokens.output).toBeGreaterThan(0);
      const usage = await commandReply("213", "/usage");
      for (const value of [nativeUsage.tokens.input, nativeUsage.tokens.output, nativeUsage.tokens.total, nativeUsage.cost]) visibleNumber(usage, value);
      for (const [id, text] of [["214", "/model preset"], ["215", "/model preset list"]]) {
        const presets = await commandReply(id!, text!);
        for (const name of Object.keys(agentConfig.modelPresets!)) expect(presets).toMatch(new RegExp(`\\b${name}\\b`));
      }
      expect((await nativeModelRoles(initial, "after-read-only-head-controls")).calls).toEqual(headBefore.calls);
      expect(await initial.client.getSessionStats()).toEqual(nativeUsage);
      expect(await initial.client.getState()).toMatchObject({ model: mainModel, sessionId: headState.sessionId });
      await commandReply("216", "/model preset low");
      expect(await nativeModelRoles(initial, "head-low-preset")).toMatchObject({ model: modelFixtureModels.changedLane,
        smol: modelFixtureModels.changedDefault, judge: modelFixtureModels.judge, calls: headBefore.calls });
      expect(await initial.client.getState()).toMatchObject({ sessionId: headState.sessionId, model: modelFixtureModels.changedLane,
        modelSettings: lowPreset, thinkingLevel: Effort.Low, settingsScope: "session" });
      expect(JSON.parse(store.getMeta(`head:model-settings:${headState.sessionId}`)!)).toMatchObject({ settings: lowPreset, clearedRoles: expect.any(Array) });
      // Resolve through the actual NativePresetManager, not a hand-built
      // snapshot. high omits effort; persistent base policy is not the HEAD's
      // just-applied low policy and must not replace it during this switch.
      const baseThinking = (await presetManager!.inspect()).settings.defaultThinkingLevel;
      expect(baseThinking).not.toBe(Effort.Low);
      await commandReply("2161", "/model preset high");
      const inheritedHeadState = await initial.client.getState();
      expect(inheritedHeadState).toMatchObject({ sessionId: headState.sessionId, model: mainModel, settingsScope: "session" });
      expect(inheritedHeadState.modelSettings).toEqual({
        modelRoles: { default: `${mainModel.provider}/${mainModel.id}`, judge: `${modelFixtureProvider}/${modelFixtureModels.judge.id}` },
        defaultThinkingLevel: Effort.Low,
      });
      // The selected model has no reasoning effort. Its effective level is
      // unset, while the current HEAD policy must still survive the switch.
      expect(inheritedHeadState.thinkingLevel).toBeUndefined();
      await commandReply("2162", "/model preset low");
      expect(store.lane(finalLane.id)).toEqual(laneRecordBefore);
      expect(await fs.readFile(finalLane.sessionFile, "utf8")).toBe(laneTranscriptBefore);
      await unchangedNativeSettings();
      const controls = [
        inbound("201", threadRoute, "/model"),
        inbound("202", threadRoute, "/model list"),
        inbound("203", threadRoute, `/model ${modelFixtureModels.changedLane.provider}/${modelFixtureModels.changedLane.id}`),
        inbound("204", threadRoute, "/effort"),
        inbound("205", threadRoute, "/effort off"),
        inbound("206", threadRoute, `/effort ${Effort.Minimal}`),
      ];
      for (const control of controls) {
        await messenger.deliver(control);
        await until(() => delivered(control.id), `head control ${control.text}`);
        const response = messenger.sent.find(output => output.sourceId === control.id)!;
        expect(response.route).toEqual(threadRoute);
        expect(response.text).not.toContain("local-test-only");
        expect(response.text).not.toContain("mock://");
        if (control.id === "205") expect((await initial.client.getState()).thinkingLevel).toBe("off");
      }
      expect(messenger.sent.find(output => output.sourceId === "201")?.text).toContain(`${modelFixtureModels.changedLane.provider}/${modelFixtureModels.changedLane.id}`);
      expect(messenger.sent.find(output => output.sourceId === "202")?.text).toContain(
        `${modelFixtureModels.changedLane.provider}/${modelFixtureModels.changedLane.id}`);
      expect(messenger.sent.find(output => output.sourceId === "206")?.text).toContain(Effort.Minimal);
      expect(await initial.client.getState()).toMatchObject({
        sessionId: headState.sessionId, model: modelFixtureModels.changedLane,
        thinkingLevel: Effort.Minimal, settingsScope: "session", isSettled: true,
      });
      const laneAfter = await laneRoles(finalLane.id, "after-head-controls");
      expect(laneAfter.state.model).toEqual(laneBefore.state.model);
      expect(laneAfter.state.thinkingLevel).toEqual(laneBefore.state.thinkingLevel);
      expect(laneAfter.state.modelSettings).toEqual(laneBefore.state.modelSettings);
      const sentBeforeReplay = messenger.sent.length;
      await messenger.deliver(controls[2]!);
      await messenger.deliver(controls[5]!);
      await runtime.kick();
      expect(messenger.sent.length).toBe(sentBeforeReplay);
      expect(nativeResults.length).toBe(resultsBefore);
      expect((await nativeModelRoles(initial, "after-head-controls")).calls).toEqual(headBefore.calls);
      expect(store.inputs()).toEqual([]);
      await unchangedNativeSettings();

      // The frozen role default differs from the later transcript model, and
      // its thinking policy differs from the later transcript effort. Resume
      // must restore both sources independently, not reapply the preset.
      await commandReply("207", `/model ${modelFixtureModels.changedDefault.provider}/${modelFixtureModels.changedDefault.id}`);
      await commandReply("208", `/effort ${Effort.Minimal}`);
      expect(await initial.client.getState()).toMatchObject({ model: modelFixtureModels.changedDefault,
        thinkingLevel: Effort.Minimal, modelSettings: lowPreset, sessionId: headState.sessionId });

      const beforeCompactEntries = parseSessionEntries(await fs.readFile(mainPaths.sessionFile, "utf8"));
      const beforeCompactMessages = await initial.client.getMessages();
      const compactReply = await commandReply("217", `/compact ${modelCompactInstructions}`);
      const compactEntries = parseSessionEntries(await fs.readFile(mainPaths.sessionFile, "utf8"));
      const compactions = compactEntries.filter(entry => entry.type === "compaction");
      expect(compactions).toHaveLength(beforeCompactEntries.filter(entry => entry.type === "compaction").length + 1);
      const compact = compactions.at(-1)!;
      expect(compact.summary).toContain(modelCompactSummary);
      expect(compact.tokensBefore).toBeGreaterThan(0);
      expect(compactEntries.some(entry => entry.id === compact.firstKeptEntryId)).toBe(true);
      const compactRecords = compactEntries.flatMap(entry => entry.type === "custom" && entry.customType === modelCompactMarker ? [entry.data] : []);
      expect(compactRecords).toEqual(expect.arrayContaining([
        expect.objectContaining({ phase: "prepared", instructions: modelCompactInstructions, firstKeptEntryId: compact.firstKeptEntryId }),
        expect.objectContaining({ phase: "provider-summary", instructions: modelCompactInstructions,
          prompt: expect.stringContaining(`Additional focus: ${modelCompactInstructions}`) }),
      ]));
      const compactMessages = await initial.client.getMessages();
      expect(compactMessages).not.toEqual(beforeCompactMessages);
      expect(compactMessages).toEqual(expect.arrayContaining([expect.objectContaining({ role: "compactionSummary", summary: expect.stringContaining(modelCompactSummary) })]));
      expect(compactMessages.length).toBeLessThan(beforeCompactMessages.length);
      const compactState = await initial.client.getState();
      expect(compactState).toMatchObject({ sessionId: headState.sessionId, model: modelFixtureModels.changedDefault,
        thinkingLevel: Effort.Minimal, modelSettings: lowPreset, isSettled: true, isCompacting: false });
      expect(compactState.contextUsage).toBeDefined();
      visibleNumber(compactReply, compactState.contextUsage!.tokens);
      visibleNumber(compactReply, compactState.contextUsage!.contextWindow);
      expect(nativeResults.length).toBe(resultsBefore);
      expect(requestIds(compactEntries)).toEqual(requestIds(beforeCompactEntries));
      await unchangedNativeSettings();

      const beforeBlockedCalls = (await nativeModelRoles(initial, "before-head-stop")).calls as Record<string, number>;
      const controlledModelKey = `${modelFixtureModels.changedDefault.provider}/${modelFixtureModels.changedDefault.id}`;
      const ready = Promise.withResolvers<void>();
      const stopWatching = initial.onFrame(frame => {
        if (frame.type !== "extension_ui_request" || frame.method !== "notify" || typeof frame.message !== "string") return;
        try {
          const marker: unknown = JSON.parse(frame.message);
          if (marker && typeof marker === "object" && Reflect.get(marker, "fixture") === modelAbortMarker
            && Reflect.get(marker, "phase") === "ready" && Reflect.get(marker, "requestId") === "301") ready.resolve();
        } catch { /* Only this provider readiness notification unblocks stop. */ }
      });
      const laneBeforeStop = structuredClone(store.lane(finalLane.id));
      const blocked = inbound("301", threadRoute, "Wait in the local provider until the native head abort signal fires.");
      try {
        await messenger.deliver(blocked);
        await within(ready.promise, 10_000, "Native provider did not publish abort-signal readiness");
        expect(await initial.client.getState()).toMatchObject({ hostPid: child.pid, sessionId: headState.sessionId, isStreaming: true, isSettled: false });
        cancelledRequestId = store.input(blocked.id)?.requestId ?? undefined;
        expect(cancelledRequestId).toMatch(/^sg-/);
        await commandReply("302", "/stop head", "cancelled");
      } finally { stopWatching(); }
      await until(() => nativeResults.some(result => result.id === cancelledRequestId), "native aborted task completion");
      expect(store.input(blocked.id)).toMatchObject({ state: "cancelled", target: "main", requestId: cancelledRequestId });
      expect(await initial.client.getState()).toMatchObject({ hostPid: child.pid, sessionId: headState.sessionId, isSettled: true,
        isStreaming: false, hasOwnedRunningWork: false, queuedMessageCount: 0, pendingUiRequests: [] });
      expect(alive(child.pid!)).toBe(true);
      expect(messenger.handlers).toBeDefined();
      expect(store.lane(finalLane.id)).toEqual(laneBeforeStop);
      expect(await runtime.inspect(finalLane.id)).toMatchObject({ state: { hostPid: finalLane.pid, sessionId: firstLane.sessionId, isSettled: true } });
      const abortEntries = parseSessionEntries(await fs.readFile(mainPaths.sessionFile, "utf8"));
      expect(abortEntries.flatMap(entry => entry.type === "custom" && entry.customType === modelAbortMarker ? [entry.data] : [])).toEqual([
        { phase: "ready", requestId: blocked.id }, { phase: "aborted", requestId: blocked.id },
      ]);
      const stoppedCalls = (await nativeModelRoles(initial, "after-head-stop")).calls;
      expect(stoppedCalls).toEqual({ ...beforeBlockedCalls, [controlledModelKey]: beforeBlockedCalls[controlledModelKey]! + 1 });
      const completionsAfterStop = nativeResults.length;
      const deliveriesAfterStop = messenger.sent.length;
      await messenger.deliver(blocked);
      await runtime.kick();
      expect((await nativeModelRoles(initial, "after-cancelled-input-replay")).calls).toEqual(stoppedCalls);
      expect(nativeResults.length).toBe(completionsAfterStop);
      expect(messenger.sent.length).toBe(deliveriesAfterStop);
      expect(messenger.sent.some(output => output.sourceId === blocked.id)).toBe(false);

      const fresh = inbound("303", route, "Answer this fresh request after stopping the previous head task.");
      await messenger.deliver(fresh);
      await until(() => delivered(fresh.id), "fresh native head request after stop");
      expect(messenger.sent.find(output => output.sourceId === fresh.id)?.text).toBe(reply);
      expect(store.input(fresh.id)).toMatchObject({ target: "main", state: "done" });

      // A second real native summary deliberately parks on its own abort signal.
      // Status and stop must overtake the still-pending compact RPC, rather than
      // waiting behind its serial command handler or claiming prompt acceptance.
      const compactReady = Promise.withResolvers<void>();
      const stopWatchingCompact = initial.onFrame(frame => {
        if (frame.type !== "extension_ui_request" || frame.method !== "notify" || typeof frame.message !== "string") return;
        try {
          const marker: unknown = JSON.parse(frame.message);
          if (marker && typeof marker === "object" && Reflect.get(marker, "fixture") === modelAbortMarker
            && Reflect.get(marker, "phase") === "ready" && Reflect.get(marker, "requestId") === "305") compactReady.resolve();
        } catch { /* Other native notifications cannot establish readiness. */ }
      });
      const compactInput = inbound("305", threadRoute, `/compact ${modelCompactAbortInstructions}`);
      try {
        await messenger.deliver(compactInput);
        await within(compactReady.promise, 10_000, "Native compact provider did not publish abort-signal readiness");
        expect(store.input(compactInput.id)).toMatchObject({ state: "submitted" });
        expect(await initial.client.getState()).toMatchObject({ isCompacting: true, sessionId: headState.sessionId });
        expect(messenger.sent.some(output => output.sourceId === compactInput.id)).toBe(false);
        const duringCompact = await commandReply("306", "/status");
        expect(duringCompact).toContain(headState.sessionId);
        await commandReply("307", "/context");
        await commandReply("308", "/usage");
        await commandReply("309", "/stop head", "cancelled");
      } finally { stopWatchingCompact(); }
      expect(store.input(compactInput.id)).toMatchObject({ state: "cancelled" });
      expect(await initial.client.getState()).toMatchObject({ sessionId: headState.sessionId, hostPid: child.pid,
        isCompacting: false, isSettled: true, queuedMessageCount: 0, hasOwnedRunningWork: false });
      const afterCompactAbort = parseSessionEntries(await fs.readFile(mainPaths.sessionFile, "utf8"));
      expect(afterCompactAbort.filter(entry => entry.type === "compaction")).toHaveLength(compactions.length);
      expect(afterCompactAbort.flatMap(entry => entry.type === "custom" && entry.customType === modelAbortMarker ? [entry.data] : [])).toEqual([
        { phase: "ready", requestId: blocked.id }, { phase: "aborted", requestId: blocked.id },
        { phase: "ready", requestId: compactInput.id }, { phase: "aborted", requestId: compactInput.id },
      ]);
      expect(store.lane(finalLane.id)).toEqual(laneBeforeStop);
      expect(messenger.sent.some(output => output.sourceId === compactInput.id)).toBe(false);
      const beforeLaneStop = await nativeModelRoles(initial, "before-lane-stop");
      const laneStopResults = nativeResults.length;
      const headBeforeLaneStop = await initial.client.getState();
      await commandReply("304", `/stop ${finalLane.id}`, "cancelled");
      expect(store.lane(finalLane.id)).toMatchObject({ workState: "paused", runtimeState: "idle", pid: finalLane.pid,
        sessionId: firstLane.sessionId, generation: finalLane.generation, model: modelFixtureModels.changedLane, modelPresetSnapshot: lowPreset });
      expect(await runtime.inspect(finalLane.id)).toMatchObject({ state: { hostPid: finalLane.pid, sessionId: firstLane.sessionId, isSettled: true } });
      expect(await initial.client.getState()).toMatchObject({ hostPid: child.pid, sessionId: headState.sessionId,
        model: headBeforeLaneStop.model, thinkingLevel: headBeforeLaneStop.thinkingLevel, isSettled: true });
      expect((await nativeModelRoles(initial, "after-lane-stop")).calls).toEqual(beforeLaneStop.calls);
      expect(nativeResults.length).toBe(laneStopResults);
      expect(messenger.handlers).toBeDefined();
      expect(alive(child.pid!)).toBe(true);
      await unchangedNativeSettings();

      // Only an explicit --global may cross the native settings boundary. All
      // session-only controls and priority/abort proofs above retain the exact
      // operator-edited file bytes before this first global save.
      const nativeConfigPath = path.join(agent, "config.yml");
      const beforeGlobalConfig = Bun.YAML.parse(await fs.readFile(nativeConfigPath, "utf8")) as Record<string, unknown>;
      const laneBeforeGlobal = await runtime.inspect(finalLane.id);
      const laneRecordBeforeGlobal = structuredClone(store.lane(finalLane.id));
      const laneTranscriptBeforeGlobal = await fs.readFile(finalLane.sessionFile, "utf8");
      const callsBeforeGlobal = (await nativeModelRoles(initial, "before-global-head-preset")).calls;
      const nativeResultsBeforeGlobal = nativeResults.length;
      expect(beforeGlobalConfig.modelRoles).not.toEqual(lowPreset.modelRoles);
      expect(beforeGlobalConfig.defaultThinkingLevel).not.toBe(lowPreset.defaultThinkingLevel);
      const globalLow = inbound("218", threadRoute, "/model preset low --global");
      const globalNotice = await commandReply(globalLow.id, globalLow.text);
      expect(globalNotice).toContain(`Preset "low": previous model: "${modelFixtureModels.changedDefault.provider}/${modelFixtureModels.changedDefault.id}"; effort: ${Effort.Minimal} -> actual model: "${modelFixtureModels.changedLane.provider}/${modelFixtureModels.changedLane.id}"; effort: ${Effort.Low}.`);
      expect(globalNotice).toContain("Session applied; global saved (future/default settings).");
      expect(globalNotice).toContain("Existing lanes unchanged.");
      expect(await initial.client.getState()).toMatchObject({ sessionId: headState.sessionId,
        model: modelFixtureModels.changedLane, thinkingLevel: Effort.Low, modelSettings: lowPreset, settingsScope: "session" });
      expect(await nativeModelRoles(initial, "head-global-low-preset")).toMatchObject({ model: modelFixtureModels.changedLane,
        smol: modelFixtureModels.changedDefault, judge: modelFixtureModels.judge, calls: callsBeforeGlobal });
      const lowGlobalBytes = await fs.readFile(nativeConfigPath);
      const lowGlobalConfig = Bun.YAML.parse(lowGlobalBytes.toString()) as Record<string, unknown>;
      expect(lowGlobalConfig).toEqual({ ...beforeGlobalConfig, modelRoles: lowPreset.modelRoles,
        defaultThinkingLevel: lowPreset.defaultThinkingLevel });
      expect(lowGlobalConfig.modelPresets).toEqual(beforeGlobalConfig.modelPresets);
      expect(await fs.readFile(path.join(agent, "models.yml"))).toEqual(nativeSettings.get("models.yml")!);
      const verifyGlobalDefaults = async (expected: LanePresetSnapshot) => {
        const saved = await Settings.loadIsolated({ cwd: headCwd, agentDir: agent });
        try {
          expect(saved.getGlobalSettings().modelRoles).toEqual(expected.modelRoles);
          expect(saved.getGlobalSettings().defaultThinkingLevel).toBe(expected.defaultThinkingLevel);
        } finally { saved.cancelPendingSaves(); }
      };
      await verifyGlobalDefaults(lowPreset);
      // Establish the new byte invariant only after the independent parsed
      // expectation proves the exact allowed fields changed and nothing else.
      nativeSettings.set("config.yml", lowGlobalBytes);
      await unchangedNativeSettings();

      // A newer explicit global selection must survive replay of the old
      // request. Bytes, timestamps or callback counts alone cannot prove that
      // a duplicate did not reapply the old native/global selection.
      const newerGlobalPreset: LanePresetSnapshot = {
        modelRoles: { default: `${mainModel.provider}/${mainModel.id}`,
          smol: `${modelFixtureModels.changedDefault.provider}/${modelFixtureModels.changedDefault.id}`,
          judge: `${modelFixtureModels.judge.provider}/${modelFixtureModels.judge.id}` },
        defaultThinkingLevel: Effort.Minimal,
      };
      await commandReply("219", "/model preset middle --global");
      const newerGlobalState = await initial.client.getState();
      expect(newerGlobalState).toMatchObject({ sessionId: headState.sessionId, model: mainModel,
        modelSettings: newerGlobalPreset, settingsScope: "session" });
      // This model has no reasoning effort; the frozen/persisted Minimal policy
      // remains intact even though native effective thinking is model default.
      expect(newerGlobalState.thinkingLevel).toBeUndefined();
      const newerGlobalBytes = await fs.readFile(nativeConfigPath);
      const newerGlobalConfig = Bun.YAML.parse(newerGlobalBytes.toString()) as Record<string, unknown>;
      expect(newerGlobalConfig).toEqual({ ...beforeGlobalConfig, modelRoles: newerGlobalPreset.modelRoles,
        defaultThinkingLevel: newerGlobalPreset.defaultThinkingLevel });
      expect(newerGlobalConfig.modelPresets).toEqual(beforeGlobalConfig.modelPresets);
      await verifyGlobalDefaults(newerGlobalPreset);
      nativeSettings.set("config.yml", newerGlobalBytes);
      const sentBeforeGlobalReplay = messenger.sent.length;
      await messenger.deliver(globalLow);
      await runtime.kick();
      expect(messenger.sent.length).toBe(sentBeforeGlobalReplay);
      const afterGlobalReplay = await initial.client.getState();
      expect(afterGlobalReplay).toMatchObject({ sessionId: headState.sessionId, model: mainModel,
        modelSettings: newerGlobalPreset, settingsScope: "session" });
      expect(afterGlobalReplay.thinkingLevel).toBeUndefined();
      await verifyGlobalDefaults(newerGlobalPreset);
      await unchangedNativeSettings();

      // Restore the frozen low policy separately from the later transcript
      // model/effort, retaining the existing same-session restart proof below.
      await commandReply("220", "/model preset low");
      await commandReply("221", `/model ${modelFixtureModels.changedDefault.provider}/${modelFixtureModels.changedDefault.id}`);
      await commandReply("222", `/effort ${Effort.Minimal}`);
      expect(await initial.client.getState()).toMatchObject({ sessionId: headState.sessionId,
        model: modelFixtureModels.changedDefault, thinkingLevel: Effort.Minimal, modelSettings: lowPreset, settingsScope: "session" });
      expect((await nativeModelRoles(initial, "after-global-head-controls")).calls).toEqual(callsBeforeGlobal);
      expect(nativeResults.length).toBe(nativeResultsBeforeGlobal);
      expect(store.lane(finalLane.id)).toEqual(laneRecordBeforeGlobal);
      expect(await runtime.inspect(finalLane.id)).toEqual(laneBeforeGlobal);
      expect(await fs.readFile(finalLane.sessionFile, "utf8")).toBe(laneTranscriptBeforeGlobal);
      await unchangedNativeSettings();

      const confirmedSettingsRecord = JSON.parse(store.getMeta(`head:model-settings:${headState.sessionId}`)!) as {
        settings: LanePresetSnapshot; clearedRoles: string[];
      };
      confirmedHeadSettings = confirmedSettingsRecord.settings;
      confirmedClearedRoles = confirmedSettingsRecord.clearedRoles;
      expect(confirmedHeadSettings).toEqual(lowPreset);
      expect(confirmedClearedRoles).toEqual(expect.any(Array));
      expect(await initial.client.getState()).toMatchObject({ modelSettings: confirmedHeadSettings,
        model: modelFixtureModels.changedDefault, thinkingLevel: Effort.Minimal });
    }

    // stop() detaches rather than killing OMP. Inspect and explicitly shut down
    // only the native processes whose identities belong to this test's ledger.
    await runtime.stop();
    expect(messenger.handlers).toBeUndefined();
    owned.set(finalLane.id, { socketPath: finalLane.socketPath, sessionFile: finalLane.sessionFile, pid: finalLane.pid! });
    for (const [id, host] of owned) {
      const connection = await HostConnection.connect(host.socketPath);
      connections.add(connection);
      expect(await connection.client.getState()).toMatchObject({ sessionFile: host.sessionFile, sessionId: id === "main" ? headState.sessionId : firstLane.sessionId,
        model: modelSelection ? id === "main" ? modelFixtureModels.changedDefault : modelFixtureModels.changedLane : id === "main" ? mainModel : laneModel,
        hostPid: host.pid, isSettled: true, settingsScope: "session", pendingUiRequests: [], hasOwnedRunningWork: false });
      expect(await connection.request({ type: "shutdown_host" }, `native-runtime-shutdown-${id}`)).toMatchObject({ command: "shutdown_host", success: true });
      await within(connection.exited, 10_000, `Native ${id} did not close after shutdown`);
      await processExited(host.pid);
      await expect(fs.lstat(host.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(await within(exit.promise, 10_000, "Native head process did not exit cleanly")).toEqual({ code: 0, signal: null });
    if (modelSelection) {
      // Frozen roles/policy are a private config overlay; native transcript
      // model and effort remain independent and win over that role default.
      const restartOptions: HostOptions = { ...headOptions, model: undefined,
        modelSettings: confirmedHeadSettings, clearedModelRoles: confirmedClearedRoles };
      const restartArgs = buildHostArgs(restartOptions, nativeConfig);
      expect(restartArgs).not.toContain("--model-preset");
      expect(restartArgs).not.toContain("--model");
      const restarted = await startHost(restartOptions);
      owned.set("main", { ...mainPaths, pid: restarted.pid });
      const resumed = await HostConnection.connect(mainPaths.socketPath);
      connections.add(resumed);
      expect(await resumed.client.getState()).toMatchObject({
        hostPid: restarted.pid, sessionId: headState.sessionId, sessionFile: mainPaths.sessionFile,
        model: modelFixtureModels.changedDefault, thinkingLevel: Effort.Minimal,
        modelSettings: confirmedHeadSettings, settingsScope: "session", isSettled: true,
      });
      expect(await nativeModelRoles(resumed, "head-after-restart")).toMatchObject({ model: modelFixtureModels.changedDefault,
        smol: modelFixtureModels.changedDefault, judge: modelFixtureModels.judge });
      await unchangedNativeSettings();
      expect(await resumed.request({ type: "shutdown_host" })).toMatchObject({ success: true });
      await within(resumed.exited, 10_000, "Restored native head did not close after shutdown");
      await processExited(restarted.pid);
    }
    const headEntries = parseSessionEntries(await fs.readFile(mainPaths.sessionFile, "utf8"));
    const laneEntries = parseSessionEntries(await fs.readFile(firstLane.sessionFile, "utf8"));
    expect(headEntries[0]).toMatchObject({ type: "session", id: headState.sessionId });
    expect(laneEntries[0]).toMatchObject({ type: "session", id: firstLane.sessionId });
    const headRequestIds = requestIds(headEntries);
    const laneRequestIds = requestIds(laneEntries);
    expect(headRequestIds).toEqual([ordinary.id, topic.id, report(firstHandoff), followup.id, report(followupHandoff),
      ...(modelSelection ? [modelChangeSource.id, changedFollowup.id, report(`handoff:${changedFollowup.id}:${created.id}`), "301", "303"] : [])]);
    expect(laneRequestIds).toEqual([firstHandoff, followupHandoff, ...(modelSelection ? [`handoff:${changedFollowup.id}:${created.id}`] : [])]);
    expect(new Set(headRequestIds).size).toBe(headRequestIds.length);
    expect(new Set(laneRequestIds).size).toBe(laneRequestIds.length);
    const dispatched = [...headRequestIds, ...laneRequestIds].map(id => {
      const receipt = ledger.query("SELECT target, state, request_id AS requestId FROM inputs WHERE id = ?").get(id) as {
        target: string; state: string; requestId: string;
      } | null;
      if (!receipt?.requestId) throw new Error(`Missing durable native dispatch receipt for ${id}`);
      expect(receipt.state).toBe(id === "301" ? "cancelled" : "done");
      return receipt;
    });
    expect(new Set(dispatched.map(input => input.requestId)).size).toBe(dispatched.length);
    expect(nativeResults.map(result => result.id).sort()).toEqual(dispatched.map(input => input.requestId).sort());
    for (const input of dispatched) {
      const result = nativeResults.find(result => result.id === input.requestId);
      expect(result).toMatchObject({ status: input.requestId === cancelledRequestId ? "aborted" : "completed", agentInvoked: true, sessionSettled: true,
        socketPath: input.target === "main" ? mainPaths.socketPath : firstLane.socketPath });
    }
    // Empty head answers produce discarded native internal turns, not new
    // runtime prompts. Assert their durable dispatch/completion identities above.
    for (const [entries, cwd, shutdownCount] of [[headEntries, headCwd, modelSelection ? 2 : 1], [laneEntries, laneCwd, modelSelection ? 2 : 1]] as const) {
      const header = entries[0] as SessionHeader;
      expect(await fs.realpath(header.cwd)).toBe(await fs.realpath(cwd));
      const shutdowns = entries.filter(entry => entry.type === "custom" && entry.customType === "omp-superagent-native-test");
      expect(shutdowns).toHaveLength(shutdownCount);
      for (const shutdown of shutdowns) expect(shutdown).toMatchObject({ data: { phase: "shutdown", networkAttempts: 0 } });
    }
    if (modelSelection) {
      const answers = laneEntries.flatMap(entry => entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : []);
      expect(answers).toHaveLength(3);
      for (const answer of answers.slice(0, 2)) expect(answer).toMatchObject({ provider: laneModel.provider, model: laneModel.id, stopReason: "stop" });
      expect(answers[2]).toMatchObject({ provider: modelFixtureProvider, model: modelFixtureModels.changedLane.id, stopReason: "stop" });
      expect(laneEntries.filter(entry => entry.type === "model_change")).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "model_change", model: `${modelFixtureProvider}/${modelFixtureModels.changedLane.id}` }),
      ]));
      const roleRecords = laneEntries.flatMap(entry => entry.type === "custom" && entry.customType === modelRolesMarker ? [entry.data] : []);
      expect(roleRecords).toEqual([
        expect.objectContaining({ token: "initial-middle", model: laneModel, smol: mainModel, judge: modelFixtureModels.judge }),
        expect.objectContaining({ token: "resumed-middle", model: laneModel, smol: mainModel, judge: modelFixtureModels.judge }),
        expect.objectContaining({ token: "changed-low", model: modelFixtureModels.changedLane, smol: modelFixtureModels.changedDefault, judge: modelFixtureModels.judge }),
        expect.objectContaining({ token: "before-head-controls", model: modelFixtureModels.changedLane, smol: modelFixtureModels.changedDefault, judge: modelFixtureModels.judge }),
        expect.objectContaining({ token: "after-head-controls", model: modelFixtureModels.changedLane, smol: modelFixtureModels.changedDefault, judge: modelFixtureModels.judge }),
      ]);
      const persistedJudgeUsage = headEntries.flatMap(entry => entry.type === "model_usage" && entry.purpose === "judge" ? [entry] : []);
      expect(persistedJudgeUsage.length).toBeGreaterThanOrEqual(1);
      expect(persistedJudgeUsage.map(entry => entry.id)).toEqual(expect.arrayContaining(advisoryUsageIds));
      for (const usage of persistedJudgeUsage) {
        expect(usage).toMatchObject({
          purpose: "judge", role: "judge", provider: modelFixtureProvider, model: modelFixtureModels.judge.id, stopReason: "stop",
          usage: { cost: { total: 0 } },
        });
        expect(Number.isFinite(usage.usage.totalTokens)).toBe(true);
        expect(usage.usage.totalTokens).toBeGreaterThan(0);
        expect(Number.isFinite(usage.usage.cost.total)).toBe(true);
      }
      await unchangedNativeSettings();
      const persisted = new Store(databasePath);
      try { expect(persisted.lane(created.id)).toMatchObject({ model: modelFixtureModels.changedLane, modelReason: changedModelReason,
        modelPreset: "low", modelPresetSnapshot: lowPreset, sessionId: firstLane.sessionId, generation: 2 }); }
      finally { persisted.close(); }
    }
    succeeded = true;
  } catch (cause) {
    const native: Array<Record<string, unknown>> = [];
    const lanes = (ledger.query("SELECT data FROM lanes").all() as Array<{ data: string }>).map(row => JSON.parse(row.data) as Lane);
    for (const host of [{ id: "main", ...mainPaths }, ...lanes]) {
      let connection: HostConnection | undefined;
      try {
        connection = await HostConnection.connect(host.socketPath);
        native.push({ id: host.id, state: await connection.request({ type: "get_state" }), messages: await connection.client.getMessages() });
      } catch (error) { native.push({ id: host.id, error: String(error) }); }
      finally { await connection?.close(); }
    }
    const live = Reflect.get(runtime, "live") as Map<string, Record<string, unknown>>;
    const diagnostic = {
      cause: String(cause), errors: errors.map(String), native, headEvents, sent: messenger.sent,
      inputs: ledger.query("SELECT id, data, target, state, request_id, generation FROM inputs ORDER BY sequence").all(),
      outputs: outbox(), metadata: ledger.query("SELECT * FROM metadata").all(), lanes,
      controller: {
        pumping: Boolean(Reflect.get(runtime, "pumping")), repeat: Reflect.get(runtime, "repeat"),
        live: [...live].map(([id, host]) => ({ id, busy: host.busy, input: host.input, result: host.result, finishing: Boolean(host.finishing), finishAgain: host.finishAgain })),
      },
    };
    await fs.writeFile(path.join(root, "failure.json"), JSON.stringify(diagnostic, null, 2), { mode: 0o600 });
    const names = await fs.readdir(path.join(root, "logs")).catch(() => [] as string[]);
    const tails = await Promise.all(names.map(async name => `${name}:\n${(await fs.readFile(path.join(root, "logs", name), "utf8")).slice(-8192)}`));
    throw new Error(`${cause instanceof Error ? cause.message : String(cause)}\nNative runtime diagnostics retained: ${root}/failure.json\nNative runtime logs:\n${tails.join("\n")}`, { cause });
  } finally {
    try {
      await runtime.stop();
      const lanes = ledger.query("SELECT data FROM lanes").all() as Array<{ data: string }>;
      for (const row of lanes) {
        const lane = JSON.parse(row.data) as Lane;
        if (lane.pid) owned.set(lane.id, { socketPath: lane.socketPath, sessionFile: lane.sessionFile, pid: lane.pid });
      }
      for (const host of owned.values()) {
        if (!alive(host.pid)) continue;
        let connection: HostConnection | undefined;
        let foreign = false;
        try {
          connection = await HostConnection.connect(host.socketPath);
          connections.add(connection);
          const state = await connection.client.getState();
          if (state.hostPid !== host.pid || state.sessionFile !== host.sessionFile) {
            foreign = true;
            throw new Error("Refusing foreign host cleanup");
          }
          if (!state.isSettled) await connection.client.abortAndRestoreQueue();
          await connection.client.shutdownHost();
          await within(connection.exited, 10_000, "Owned native cleanup did not finish");
          await processExited(host.pid);
        } catch (error) {
          if (foreign) throw error;
          if (alive(host.pid)) process.kill(host.pid, "SIGKILL");
          await processExited(host.pid);
        } finally { await connection?.close(); }
      }
    } finally {
      for (const connection of connections) await connection.close();
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exit.promise.catch(() => {});
      }
      ledger.close();
      store.close();
      presetSettings?.cancelPendingSaves();
      await log.close();
      if (succeeded) await fs.rm(root, { recursive: true, force: true });
    }
  }
}
