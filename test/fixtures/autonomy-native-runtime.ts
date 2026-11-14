import { expect } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseSessionEntries } from "@oh-my-pi/pi-coding-agent";
import { type Config, hostPaths, privateDirectory } from "../../src/config";
import type { Approval, Attachment, Inbound, Messenger, OutputRecord, Route } from "../../src/contracts";
import { HostConnection, startHost } from "../../src/host";
import { Superagent } from "../../src/runtime";
import { Store } from "../../src/store";
import { workflowContext } from "../../src/workflow";
import { nativeDisabledProviders } from "./native-extension";
import { autonomyModel } from "./autonomy-native-extension";

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(() => timeout.reject(new Error(`Native autonomy deadline: ${label}`)), 40_000);
  try { return await Promise.race([promise, timeout.promise]); }
  finally { clearTimeout(timer); }
}

async function until(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
  await within((async () => {
    while (!await predicate()) {
      const drain = Promise.withResolvers<void>();
      setImmediate(drain.resolve);
      await drain.promise;
    }
  })(), label);
}

class RecordingMessenger implements Messenger {
  readonly sent: OutputRecord[] = [];
  readonly downloads: Array<{ route: Route; attachment: Attachment }> = [];
  async start(): Promise<void> {}
  async send(output: OutputRecord): Promise<string> {
    this.sent.push(structuredClone(output));
    return `autonomy-receipt:${output.id}`;
  }
  async canCreateThread(): Promise<boolean> { return true; }
  async createThread(route: Route): Promise<Route> { return { ...route, threadId: "8001" }; }
  async showApproval(_approval: Approval): Promise<string> { throw new Error("Unexpected native autonomy approval"); }
  async dismissApproval(): Promise<void> {}
  async fetchAfter(): Promise<Inbound[]> { return []; }
  async openAttachment(route: Route, attachment: Attachment): Promise<Response> {
    if (attachment.url !== "adapter-file:resume-correction") throw new Error("Unexpected native fixture attachment");
    this.downloads.push({ route, attachment });
    return new Response("Apply the exact owner correction.\n");
  }
  async stop(): Promise<void> {}
}

/** Real managed Host/role/goal lifecycle with a local deterministic provider and recording transport. */
export async function nativeAutonomyRuntime(): Promise<void> {
  const command: unknown = JSON.parse(process.env.OMP_TEST_COMMAND ?? "null");
  if (!Array.isArray(command) || !command.every((arg): arg is string => typeof arg === "string" && arg.length > 0)
    || command.length === 0) throw new Error("Native autonomy requires OMP_TEST_COMMAND as patched CLI argv JSON");
  const root = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "osa-"));
  const home = path.join(root, "home");
  const agentDir = path.join(root, "agent");
  for (const dir of [root, home, agentDir, path.join(root, "run"), path.join(root, "logs"), path.join(root, "sessions/main")])
    privateDirectory(dir);
  const settingsPath = path.join(agentDir, "config.yml");
  const settings = JSON.stringify({
    disabledProviders: nativeDisabledProviders,
    compaction: { methodOrder: ["soft"], keepRecentTokens: 1, autoContinue: false },
  });
  await fs.writeFile(settingsPath, settings, { mode: 0o600 });
  await fs.writeFile(path.join(agentDir, "models.yml"), "providers: {}\n", { mode: 0o600 });
  const disabledAgent = path.join(root, "disabled-agent");
  privateDirectory(disabledAgent);
  await fs.writeFile(path.join(disabledAgent, "config.yml"), JSON.stringify({
    disabledProviders: nativeDisabledProviders, goal: { enabled: false },
  }), { mode: 0o600 });
  await fs.writeFile(path.join(disabledAgent, "models.yml"), "providers: {}\n", { mode: 0o600 });
  const disabledCwd = path.join(root, "disabled-work");
  privateDirectory(disabledCwd);
  const excludedCwd = path.join(root, "excluded-work");
  privateDirectory(excludedCwd);
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir,
    PI_NO_TITLE: "1", CI: "true", NO_COLOR: "1", TMPDIR: root,
    XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"),
    XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state"),
    ...(process.env.OMP_TEST_NATIVES_DIR ? { PI_NATIVES_DIR: process.env.OMP_TEST_NATIVES_DIR } : {}),
  };
  const provider = path.resolve(import.meta.dir, "autonomy-native-extension.ts");
  const managedUlwPath = path.resolve(import.meta.dir, "managed-ulw");
  const config: Config = {
    path: path.join(root, "superagent.json"), stateDir: root, headCwd: root,
    command: [...command, "-e", path.resolve(import.meta.dir, "native-extension.ts"), "-e", provider],
    maxHosts: 5, maxSubagents: 5, idleMs: 3_600_000,
    model: `${autonomyModel.provider}/${autonomyModel.id}`,
    discord: { tokenEnv: "AUTONOMY_TEST_TOKEN", ownerId: "1", allowedGuildIds: ["3"], allowedChannelIds: ["4"] },
  };
  await fs.writeFile(config.path, JSON.stringify(config), { mode: 0o600 });
  const store = new Store(path.join(root, "coordination.sqlite"));
  const messenger = new RecordingMessenger();
  const connections = new Set<HostConnection>();
  const owned = new Map<string, number>();
  const frames: Array<{ socketPath: string; frame: Record<string, unknown> }> = [];
  const errors: unknown[] = [];
  const connect = async (socketPath: string) => {
    const connection = await HostConnection.connect(socketPath);
    connections.add(connection);
    connection.onFrame(frame => frames.push({ socketPath, frame }));
    return connection;
  };
  const main = hostPaths(config, "main");
  const runtime = new Superagent(config, store, messenger, path.resolve(import.meta.dir, "../../src/lane-extension.ts"),
    error => errors.push(error), {
      connect,
      startHost: async options => {
        const started = await startHost({ ...options,
          command: options.cwd === excludedCwd ? [...options.command, "--tools", "read"] : options.command,
          managedUlwPath, env: {
          ...env, OMP_SUPERAGENT_ROLE: "lane", OMP_SUPERAGENT_LANE: options.env.OMP_SUPERAGENT_LANE ?? "",
          OMP_SUPERAGENT_CONFIG: config.path,
          ...(options.cwd === disabledCwd ? { PI_CODING_AGENT_DIR: disabledAgent } : {}),
        } });
        owned.set(options.socketPath, started.pid);
        return started;
      },
    });
  let success = false;
  let serialBarrier: { connection: HostConnection; id: string } | undefined;
  try {
    const started = await startHost({
      ...main, cwd: root, command: config.command, env, extensionPath: provider,
      managedUlwPath, model: config.model, subagentConcurrency: 1,
    });
    owned.set(main.socketPath, started.pid);
    await runtime.start();
    const route: Route = { platform: "discord", accountId: "2", authorityId: "1", guildId: "3", channelId: "4", threadId: null };
    const input = (id: string, destination: Route, text: string): Inbound => ({
      id, messageId: id, route: destination, text, receivedAt: Date.now(), attachments: [],
    });
    await runtime.receive(input("100", route, "Finish the entrusted two-turn objective"));
    await runtime.kick();
    await until(() => store.input("100")?.state === "done", "head intake");
    const first = await runtime.startLane({
      sourceId: "100", title: "Autonomous objective", cwd: root, model: autonomyModel,
      modelReason: "Deterministic local provider for the real native lifecycle proof.",
      kickoff: "I will execute and verify the entrusted objective across native turns.",
    });
    await until(() => store.input("handoff:100:lane")?.state === "done", "native autonomous completion");
    const firstConnection = await HostConnection.connect(first.socketPath);
    connections.add(firstConnection);
    const firstState = await firstConnection.client.getState();
    expect(firstState).toMatchObject({ isSettled: true, goal: null });
    const starts = () => frames.filter(event => event.socketPath === first.socketPath && event.frame.type === "agent_start").length;
    expect(starts()).toBe(2);
    const transcript = parseSessionEntries(await fs.readFile(first.sessionFile, "utf8"));
    expect(transcript.filter(entry => entry.type === "custom_message"
      && entry.customType === "goal-continuation")).toHaveLength(1);
    expect(store.input("report:handoff:100:lane")?.text).toContain("AUTONOMY_COMPLETE 100; runs=2");
    await firstConnection.client.getState();
    expect(starts()).toBe(2);

    // Real native serial admission: the UI response is a control frame and can
    // release compact even while an older goal resume remains on the serial tail.
    const queuePaths = hostPaths(config, "queue-proof");
    privateDirectory(path.dirname(queuePaths.sessionFile));
    const queueStarted = await startHost({
      ...queuePaths, cwd: root, command: config.command,
      env: { ...env, OMP_SUPERAGENT_ROLE: "lane" },
      extensionPath: path.resolve(import.meta.dir, "../../src/lane-extension.ts"),
      managedUlwPath, model: config.model, subagentConcurrency: 1,
    });
    owned.set(queuePaths.socketPath, queueStarted.pid);
    const queue = await connect(queuePaths.socketPath);
    const queueRoute = { ...route, threadId: "9005" };
    await queue.client.prompt(workflowContext(`Request ID: queue-proof\n\nOriginal source ID: queue-source\n\nOriginal authorized conversation: ${JSON.stringify(["discord", "2", "1", "3", "4", "9005"])}\n\nContinue entrusted work [pause-goal]`));
    await until(() => frames.some(event => event.socketPath === queuePaths.socketPath
      && event.frame.type === "tool_execution_start" && event.frame.toolName === "fixture_autonomy_hold"), "queue proof owned work");
    await queue.client.abortAndRestoreQueue();
    await queue.client.waitForSettled();
    expect(await queue.client.getState()).toMatchObject({ goal: { enabled: false, goal: { status: "paused" } } });
    const barrier = Promise.withResolvers<string>();
    const detachBarrier = queue.onFrame(frame => {
      if (frame.type === "extension_ui_request" && frame.method === "confirm"
        && frame.title === "Autonomy serial barrier" && typeof frame.id === "string") barrier.resolve(frame.id);
    });
    let compactSettled = false;
    const compact = queue.request({ type: "compact" }, "queue-held-compact").finally(() => { compactSettled = true; });
    const barrierId = await within(barrier.promise, "serial native compact barrier");
    serialBarrier = { connection: queue, id: barrierId };
    const queuedResume = queue.request({ type: "goal", op: "resume" }, "queue-old-resume");
    // The priority read is processed after the preceding resume frame was accepted,
    // but before compact releases the serial command tail.
    expect(await queue.client.getState()).toMatchObject({ goal: { goal: { status: "paused" } } });
    const stopped = queue.client.abortAndRestoreQueue();
    expect(await queue.client.getState()).toMatchObject({ isCompacting: true, goal: { goal: { status: "paused" } } });
    expect(compactSettled).toBe(false);
    queue.uiResponse(barrierId, { confirmed: true });
    serialBarrier = undefined;
    await stopped;
    await compact;
    expect(await queuedResume).toMatchObject({ success: false, error: "Goal resume cancelled before admission" });
    await queue.request({ type: "get_available_commands" }, "queue-drained-barrier");
    const queueState = await queue.client.getState();
    expect(queueState).toMatchObject({ isSettled: true, isStreaming: false, goal: { goal: { status: "paused" } } });
    expect(frames.filter(event => event.socketPath === queuePaths.socketPath && event.frame.type === "agent_start")).toHaveLength(2);
    detachBarrier();
    await queue.client.goal("drop");
    await queue.client.shutdownHost();
    await within(queue.exited, "queue proof native shutdown");
    owned.delete(queuePaths.socketPath);

    const secondRoute = { ...route, threadId: "9002" };
    await runtime.receive(input("200", secondRoute, "Continue entrusted work [pause-goal]"));
    await runtime.kick();
    await until(() => store.input("200")?.state === "done", "second head intake");
    const second = await runtime.startLane({
      sourceId: "200", title: "Pause native objective", cwd: root, model: autonomyModel,
      modelReason: "Exercise actual goal pause and explicit resume without a live account.",
      kickoff: "I will work through the objective and preserve an explicit pause.",
    });
    await until(() => frames.some(event => event.socketPath === second.socketPath
      && event.frame.type === "tool_execution_start" && event.frame.toolName === "fixture_autonomy_hold"), "owned native work");
    await runtime.receive(input("201", second.route, "/stop"));
    await runtime.kick();
    await until(() => messenger.sent.some(output => output.id === "201:head-control"), "pause receipt");
    const secondConnection = await HostConnection.connect(second.socketPath);
    connections.add(secondConnection);
    expect(await secondConnection.client.getState()).toMatchObject({
      isSettled: true, isStreaming: false, goal: { enabled: false, goal: { status: "paused" } },
    });
    expect(store.lane(second.id)?.workState).toBe("paused");
    expect(store.input("report:handoff:200:lane")).toBeNull();
    expect(frames.filter(event => event.socketPath === second.socketPath && event.frame.type === "agent_start")).toHaveLength(2);
    const correction: Inbound = {
      ...input("202", second.route, "Resume, but apply this full correction [resume-correction]."),
      attachments: [{ id: "correction", name: "correction.txt", url: "adapter-file:resume-correction",
        size: Buffer.byteLength("Apply the exact owner correction.\n"), contentType: "text/plain" }],
    };
    await runtime.receive(correction);
    await runtime.kick();
    await until(() => store.input("202")?.state === "done", "owner resume correction reaches head");
    await runtime.resume(second.id, correction.id);
    await runtime.resume(second.id, correction.id);
    await until(() => store.input(`resume:202:${second.id}`)?.state === "done", "resumed native goal result");
    const resumedState = await secondConnection.client.getState();
    expect(resumedState).toMatchObject({ isSettled: true, goal: null });
    expect(store.input(`report:resume:202:${second.id}`)?.text).toContain("AUTONOMY_COMPLETE 200; runs=3");
    expect(store.input("handoff:200:lane")?.state).toBe("cancelled");
    expect(frames.filter(event => event.socketPath === second.socketPath && event.frame.type === "agent_start")).toHaveLength(3);
    const downloadsBeforeCorrection = messenger.downloads.length;
    await runtime.messageLane(second.id, correction.text, correction.id);
    await until(() => store.input(`handoff:202:${second.id}`)?.state === "done", "full source correction and attachment delivery");
    expect(store.input(`handoff:202:${second.id}`)).toMatchObject({ text: correction.text, attachments: correction.attachments });
    expect(store.input(`report:handoff:202:${second.id}`)?.text).toContain("CORRECTION_APPLIED 202");
    expect(messenger.downloads.slice(downloadsBeforeCorrection)).toEqual([{ route: correction.route, attachment: correction.attachments[0] }]);
    await runtime.resume(second.id, correction.id);
    await runtime.messageLane(second.id, correction.text, correction.id);
    await secondConnection.client.getState();
    expect(frames.filter(event => event.socketPath === second.socketPath && event.frame.type === "agent_start")).toHaveLength(4);
    const disabledRoute = { ...route, threadId: "9003" };
    await runtime.receive(input("300", disabledRoute, "Report native capability [goal-disabled]"));
    await runtime.kick();
    await until(() => store.input("300")?.state === "done", "disabled goal head intake");
    const disabled = await runtime.startLane({
      sourceId: "300", title: "Disabled native goals", cwd: disabledCwd, model: autonomyModel,
      modelReason: "Verify the operator's native goal disable remains authoritative.",
      kickoff: "I will inspect the disabled native capability without overriding it.",
    });
    await until(() => store.input("handoff:300:lane")?.state === "done", "disabled goal report");
    expect(store.input("report:handoff:300:lane")?.text).toContain("NATIVE_GOAL_DISABLED");
    expect(frames.filter(event => event.socketPath === disabled.socketPath && event.frame.type === "agent_start")).toHaveLength(1);
    const excludedRoute = { ...route, threadId: "9004" };
    await runtime.receive(input("400", excludedRoute, "Report explicit tool selection [goal-disabled]"));
    await runtime.kick();
    await until(() => store.input("400")?.state === "done", "excluded goal head intake");
    const excluded = await runtime.startLane({
      sourceId: "400", title: "Excluded native goal tool", cwd: excludedCwd, model: autonomyModel,
      modelReason: "Verify explicit native tool selection is not widened by managed role activation.",
      kickoff: "I will respect the explicit native tool selection.",
    });
    await until(() => store.input("handoff:400:lane")?.state === "done", "excluded goal report");
    expect(store.input("report:handoff:400:lane")?.text).toContain("NATIVE_GOAL_DISABLED");
    expect(frames.filter(event => event.socketPath === excluded.socketPath && event.frame.type === "agent_start")).toHaveLength(1);
    expect(await fs.readFile(settingsPath, "utf8")).toBe(settings);
    expect(errors).toEqual([]);
    console.log(JSON.stringify({ nativeAutonomy: "passed", first: { sessionId: firstState.sessionId, runs: 2 },
      queuedResume: { sessionId: queueState.sessionId, sourceId: "queue-source", route: queueRoute, runs: 2, cancelled: true },
      resumed: { sessionId: resumedState.sessionId, runs: 3, sourceId: "202", route: second.route, correctionRuns: 1 },
      globalSettingsUnchanged: true }));
    success = true;
  } catch (error) {
    await fs.writeFile(path.join(root, "failure.json"), JSON.stringify({ error: String(error), errors: errors.map(String), frames,
      inputs: store.inputs(), outputs: messenger.sent }, null, 2), { mode: 0o600 });
    throw new Error(`Native autonomy failed; diagnostics retained at ${root}/failure.json`, { cause: error });
  } finally {
    if (serialBarrier) serialBarrier.connection.uiResponse(serialBarrier.id, { cancelled: true });
    await runtime.stop();
    for (const [socketPath, pid] of owned) {
      const connection = await HostConnection.connect(socketPath);
      try {
        const state = await connection.client.getState();
        if (state.hostPid !== pid) throw new Error("Refusing cleanup of a foreign native Host");
        await connection.client.abortAndRestoreQueue();
        if (state.goal) await connection.client.goal("drop");
        await connection.client.shutdownHost();
        await within(connection.exited, "owned native shutdown");
      } finally { await connection.close(); }
    }
    for (const connection of connections) await connection.close();
    store.close();
    if (success) await fs.rm(root, { recursive: true, force: true });
  }
}
