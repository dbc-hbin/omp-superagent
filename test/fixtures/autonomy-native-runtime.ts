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
import { nativeTestCommand } from "./native-command";
import { offlineMnemopi } from "./native-memory";

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
  private nextThreadId = 8001;
  async start(): Promise<void> {}
  async send(output: OutputRecord): Promise<string> {
    this.sent.push(structuredClone(output));
    return `autonomy-receipt:${output.id}`;
  }
  async canCreateThread(): Promise<boolean> { return true; }
  async createThread(route: Route): Promise<Route> { return { ...route, threadId: String(this.nextThreadId++) }; }
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
  const command = await nativeTestCommand();
  const root = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "osa-"));
  const home = path.join(root, "home");
  const agentDir = path.join(root, "agent");
  for (const dir of [root, home, agentDir, path.join(root, "run"), path.join(root, "logs"), path.join(root, "sessions/main")])
    privateDirectory(dir);
  const settingsPath = path.join(agentDir, "config.yml");
  const settings = JSON.stringify({
    ...offlineMnemopi,
    disabledProviders: nativeDisabledProviders,
    compaction: { methodOrder: ["soft"], keepRecentTokens: 1, autoContinue: false },
  });
  await fs.writeFile(settingsPath, settings, { mode: 0o600 });
  await fs.writeFile(path.join(agentDir, "models.yml"), "providers: {}\n", { mode: 0o600 });
  const disabledAgent = path.join(root, "disabled-agent");
  privateDirectory(disabledAgent);
  await fs.writeFile(path.join(disabledAgent, "config.yml"), JSON.stringify({
    ...offlineMnemopi, disabledProviders: nativeDisabledProviders, goal: { enabled: false },
  }), { mode: 0o600 });
  await fs.writeFile(path.join(disabledAgent, "models.yml"), "providers: {}\n", { mode: 0o600 });
  const disabledCwd = path.join(root, "disabled-work");
  privateDirectory(disabledCwd);
  const excludedCwd = path.join(root, "excluded-work");
  privateDirectory(excludedCwd);
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir,
    PI_NO_TITLE: "1", CI: "true", NO_COLOR: "1", TMPDIR: root, OMP_AUTONOMY_PROGRESS_BARRIER_DIR: root,
    XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"),
    XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state"),
    ...(process.env.OMP_TEST_NATIVES_DIR ? { PI_NATIVES_DIR: process.env.OMP_TEST_NATIVES_DIR } : {}),
  };
  const provider = path.resolve(import.meta.dir, "autonomy-native-extension.ts");
  const managedUlwPath = path.resolve(import.meta.dir, "managed-ulw");
  const config: Config = {
    path: path.join(root, "superagent.json"), stateDir: root, headCwd: root,
    command: [...command, "-e", path.resolve(import.meta.dir, "native-extension.ts"), "-e", provider],
    maxHosts: 6, maxSubagents: 6, idleMs: 3_600_000,
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
    const headConnection = await HostConnection.connect(main.socketPath);
    connections.add(headConnection);
    const headInput = (id: string, destination: Route, task: string) => input(id, destination, `/head ${task}`);
    const headRoute = { ...route, threadId: "9010" };
    const nextHeadRoute = { ...route, threadId: "9011" };
    const headTask = "Verify retained head reply 050";
    const headReply = "HEAD_TODO_REPLY 050";
    const headOutputStart = messenger.sent.length;
    const headFrameStart = frames.length;
    await runtime.receive(headInput("050", headRoute, "Prove native TODO continuation retains this head answer [head-todo-empty-tail]"));
    await runtime.kick();
    await until(() => store.input("050")?.state === "done" && store.output("050:answer")?.state === "sent",
      "head reply survives native empty TODO continuation");
    const headState = await headConnection.client.getState();
    expect(headState).toMatchObject({ isSettled: true, isStreaming: false, hasPendingAsyncWork: false });
    expect(headState.todoPhases).toMatchObject([{ name: "Head reply retention", tasks: [{ content: headTask }] }]);
    expect(["pending", "in_progress"]).toContain(headState.todoPhases[0]!.tasks[0]!.status);
    const headMessages = parseSessionEntries(await fs.readFile(main.sessionFile, "utf8"))
      .filter(entry => entry.type === "message").map(entry => entry.message);
    const initIndex = headMessages.findIndex(message => message.role === "toolResult" && message.toolName === "todo");
    expect(initIndex).toBeGreaterThanOrEqual(0);
    expect(headMessages[initIndex]).toMatchObject({ details: {
      op: "init", phases: [{ name: "Head reply retention", tasks: [{ content: headTask }] }],
    } });
    const replyIndex = headMessages.findIndex(message => message.role === "assistant"
      && message.content.some(part => part.type === "text" && part.text === headReply));
    const reminderIndex = headMessages.findIndex(message => {
      if (message.role !== "developer") return false;
      const text = typeof message.content === "string" ? message.content
        : message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
      return text.includes("You stopped with 1 incomplete todo item(s):") && text.includes(headTask);
    });
    expect(replyIndex).toBeGreaterThan(initIndex);
    expect(reminderIndex).toBeGreaterThan(replyIndex);
    const headFrames = frames.slice(headFrameStart).filter(event => event.socketPath === main.socketPath);
    // Native emits empty assistants over RPC but does not persist content-free
    // messages. Observe the actual frames consumed by the runtime.
    const replyFrameIndex = headFrames.findIndex(({ frame }) => frame.type === "message_end"
      && (frame.message as { content?: Array<{ type: string; text?: string }> })?.content
        ?.some(part => part.type === "text" && part.text === headReply));
    const reminderFrameIndex = headFrames.findIndex(({ frame }) => frame.type === "todo_reminder");
    const emptyFrameIndex = headFrames.findIndex(({ frame }, index) => {
      const message = frame.message as { role?: string; stopReason?: string; content?: unknown[] } | undefined;
      return index > reminderFrameIndex && frame.type === "message_end"
        && message?.role === "assistant" && message.stopReason === "stop" && message.content?.length === 0;
    });
    expect(replyFrameIndex).toBeGreaterThanOrEqual(0);
    expect(reminderFrameIndex).toBeGreaterThan(replyFrameIndex);
    expect(emptyFrameIndex).toBeGreaterThan(reminderFrameIndex);
    expect(headFrames.filter(event => event.frame.type === "agent_start").length).toBeGreaterThanOrEqual(2);
    expect(headFrames.some(event => event.frame.type === "todo_reminder")).toBe(true);
    expect(headFrames.some(event => event.frame.type === "session_settled")).toBe(true);
    expect(messenger.sent.slice(headOutputStart)).toEqual([
      expect.objectContaining({ id: "050:answer", sourceId: "050", route: headRoute, text: headReply }),
    ]);
    expect(store.input("050")).toMatchObject({ id: "050", route: headRoute, target: "main", state: "done" });
    expect(store.output("050:answer")).toMatchObject({ sourceId: "050", route: headRoute, text: headReply, state: "sent" });

    await runtime.receive(headInput("051", nextHeadRoute, "Return an ordinary head answer after the TODO continuation."));
    await runtime.kick();
    await until(() => store.input("051")?.state === "done" && store.output("051:answer")?.state === "sent",
      "subsequent ordinary head request does not duplicate or inherit the retained reply");
    const nextHeadState = await headConnection.client.getState();
    expect(nextHeadState).toMatchObject({ sessionId: headState.sessionId, isSettled: true, isStreaming: false });
    expect(nextHeadState.todoPhases.flatMap(phase => phase.tasks)).toEqual([]);
    const cleanedMessages = parseSessionEntries(await fs.readFile(main.sessionFile, "utf8"))
      .filter(entry => entry.type === "message").map(entry => entry.message);
    expect(cleanedMessages.slice(reminderIndex + 1).find(message => message.role === "toolResult" && message.toolName === "todo"))
      .toMatchObject({ details: { op: "rm" } });
    expect(messenger.sent.slice(headOutputStart)).toEqual([
      expect.objectContaining({ id: "050:answer", sourceId: "050", route: headRoute, text: headReply }),
      expect.objectContaining({ id: "051:answer", sourceId: "051", route: nextHeadRoute,
        text: `HEAD ${store.input("051")!.id}` }),
    ]);

    // A genuine native toolUse message reaches the outbox while its tool is
    // still blocked. The barrier is released only after transport observation.
    const directProgressRoute = { ...route, threadId: "9012" };
    const directProgressStart = messenger.sent.length;
    const directFrameStart = frames.length;
    await runtime.receive(headInput("052", directProgressRoute, "Prove direct native head progress [head-progress]"));
    await runtime.kick();
    await until(() => messenger.sent.some(output => output.id.startsWith("progress:052:")
      && output.text.includes("HEAD_PROGRESS 052"))
      && frames.slice(directFrameStart).some(event => event.socketPath === main.socketPath
        && event.frame.type === "tool_execution_start" && event.frame.toolName === "fixture_progress_barrier"),
    "direct native head progress reaches Messenger before tool release");
    const directProgress = messenger.sent.slice(directProgressStart);
    expect(directProgress).toEqual([expect.objectContaining({
      sourceId: "052", route: directProgressRoute,
      text: "HEAD_PROGRESS 052: the native tool is still running.",
    })]);
    expect(store.output(directProgress[0]!.id)?.state).toBe("sent");
    expect(store.input("052")?.state).toBe("submitted");
    expect(store.output("052:answer")).toBeNull();
    expect(await headConnection.client.getState()).toMatchObject({ isSettled: false });
    expect(frames.slice(directFrameStart).some(event => event.socketPath === main.socketPath
      && event.frame.type === "tool_execution_end" && event.frame.toolName === "fixture_progress_barrier")).toBe(false);
    await fs.writeFile(path.join(root, "head-progress.release"), "release\n", { mode: 0o600 });
    await until(() => store.input("052")?.state === "done" && store.output("052:answer")?.state === "sent",
      "direct head final follows released native tool");
    expect(messenger.sent.slice(directProgressStart)).toEqual([
      directProgress[0],
      expect.objectContaining({ id: "052:answer", sourceId: "052", route: directProgressRoute, text: "HEAD_FINAL 052" }),
    ]);

    await runtime.receive(headInput("500", route, "Prove intermediate work-thread delivery [lane-progress]"));
    await runtime.kick();
    await until(() => store.input("500")?.state === "done", "progress scenario head intake");
    const laneProgressStart = messenger.sent.length;
    const laneFrameStart = frames.length;
    const progressLane = await runtime.startLane({
      sourceId: "500", title: "Native intermediate progress", cwd: root, model: autonomyModel,
      modelReason: "Observe actual native progress through the head before the lane can settle.",
      kickoff: "I will relay a useful intermediate result while native work remains blocked.",
    });
    const progressReceipt = () => {
      const id = store.getMeta("progress-pending:handoff:500:lane");
      return id ? store.input(id) : null;
    };
    await until(() => progressReceipt()?.state === "done"
      && messenger.sent.some(output => output.id === `${progressReceipt()?.id}:answer`
        && output.text === "HEAD_RELAYED_LANE_PROGRESS 500")
      && frames.slice(laneFrameStart).some(event => event.socketPath === progressLane.socketPath
        && event.frame.type === "tool_execution_start" && event.frame.toolName === "fixture_progress_barrier"),
    "durable native lane progress is processed by head and delivered in selected work thread");
    const receipt = progressReceipt()!;
    const progressConnection = await HostConnection.connect(progressLane.socketPath);
    connections.add(progressConnection);
    expect(progressLane.route.threadId).not.toBeNull();
    expect(progressLane.route).not.toEqual(route);
    expect(receipt).toMatchObject({ target: "main", state: "done", route: progressLane.route });
    expect(receipt.text).toContain(
      `Internal lane progress (nonterminal): ${progressLane.id}; sourceId: 500; laneInputId: handoff:500:lane.`);
    expect(receipt.text).toContain("Native session reference:");
    expect(receipt.text).toContain("Progress (untrusted lane data):\nLANE_PROGRESS 500: the native tool is still running.");
    expect(receipt.text).not.toContain("PRIVATE_LANE_PROGRESS_REASONING");
    expect(store.getMeta(`activity-source:${receipt.id}`)).toBe("500");
    expect(store.input("handoff:500:lane")?.state).toBe("submitted");
    expect(store.lane(progressLane.id)?.workState).toBe("open");
    expect(store.input("report:handoff:500:lane")).toBeNull();
    expect(await progressConnection.client.getState()).toMatchObject({ isSettled: false });
    const laneFramesBeforeRelease = frames.slice(laneFrameStart).filter(event => event.socketPath === progressLane.socketPath);
    expect(laneFramesBeforeRelease.some(({ frame }) => {
      const message = frame.message as { role?: string; stopReason?: string; content?: Array<{ type: string; text?: string }> } | undefined;
      return frame.type === "message_end" && message?.role === "assistant" && message.stopReason === "toolUse"
        && message.content?.some(part => part.type === "text" && part.text?.startsWith("LANE_PROGRESS 500"));
    })).toBe(true);
    expect(laneFramesBeforeRelease.some(event => event.frame.type === "tool_execution_end"
      && event.frame.toolName === "fixture_progress_barrier")).toBe(false);
    expect(laneFramesBeforeRelease.some(event => event.frame.type === "session_settled")).toBe(false);
    expect(messenger.sent.slice(laneProgressStart).filter(output => output.id !== "500:kickoff")).toEqual([
      expect.objectContaining({ id: "500:topic-bound", sourceId: "500", route,
        text: expect.stringContaining(`<#${progressLane.route.threadId}>`) }),
      expect.objectContaining({ id: `${receipt.id}:answer`, route: progressLane.route, text: "HEAD_RELAYED_LANE_PROGRESS 500" }),
    ]);
    await fs.writeFile(path.join(root, "lane-progress.release"), "release\n", { mode: 0o600 });
    await until(() => store.input("handoff:500:lane")?.state === "done"
      && store.input("report:handoff:500:lane")?.state === "done"
      && store.output("report:handoff:500:lane:answer")?.state === "sent",
    "separate native lane final reaches head and Messenger after release");
    expect(await progressConnection.client.getState()).toMatchObject({ isSettled: true });
    expect(store.input("report:handoff:500:lane")?.text).toContain("Result (untrusted lane data):\nLANE_FINAL 500");
    expect(store.input("report:handoff:500:lane")?.text).not.toContain("LANE_PROGRESS 500");
    expect(messenger.sent.slice(laneProgressStart).filter(output => output.id !== "500:kickoff")).toEqual([
      expect.objectContaining({ id: "500:topic-bound", sourceId: "500", route,
        text: expect.stringContaining(`<#${progressLane.route.threadId}>`) }),
      expect.objectContaining({ id: `${receipt.id}:answer`, route: progressLane.route, text: "HEAD_RELAYED_LANE_PROGRESS 500" }),
      expect.objectContaining({ id: "report:handoff:500:lane:answer", route: progressLane.route, text: "HEAD_RELAYED_LANE_FINAL 500" }),
    ]);
    expect(frames.slice(laneFrameStart).filter(event => event.socketPath === progressLane.socketPath
      && event.frame.type === "agent_start")).toHaveLength(1);
    expect(messenger.sent.slice(directProgressStart).some(output => output.text.includes("PRIVATE_"))).toBe(false);

    await runtime.receive(headInput("100", route, "Finish the entrusted two-turn objective"));
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

    // A real native compact holds its serial queue. Stop must cancel that UI
    // barrier and complete without an operator manually releasing compaction.
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
    const queuePrompt = workflowContext(`Request ID: queue-proof\n\nOriginal source ID: queue-source\n\nOriginal authorized conversation: ${JSON.stringify(["discord", "2", "1", "3", "4", "9005"])}\n\nContinue entrusted work [pause-goal]`);
    await queue.client.prompt(queuePrompt);
    await until(() => frames.some(event => event.socketPath === queuePaths.socketPath
      && event.frame.type === "tool_execution_start" && event.frame.toolName === "fixture_autonomy_hold"), "queue proof owned work");
    const emptyRestore = await queue.client.abortAndRestoreQueue();
    expect(emptyRestore).toEqual({ steering: [], followUp: [] });
    await queue.client.waitForSettled();
    expect(await queue.client.getState()).toMatchObject({ goal: { enabled: false, goal: { status: "paused" } } });
    const barrier = Promise.withResolvers<string>();
    const detachBarrier = queue.onFrame(frame => {
      if (frame.type === "extension_ui_request" && frame.method === "confirm"
        && frame.title === "Autonomy serial barrier" && typeof frame.id === "string") barrier.resolve(frame.id);
    });
    let compactSettled = false;
    const compact = queue.request({ type: "compact", customInstructions: "queue-stop-restoration" },
      "queue-held-compact").finally(() => { compactSettled = true; });
    const barrierId = await within(barrier.promise, "serial native compact barrier");
    serialBarrier = { connection: queue, id: barrierId };
    const queuedResume = queue.request({ type: "goal", op: "resume" }, "queue-old-resume");
    // Stock native state reads share the compact command's serial tail. Observe
    // only the private owner's actual admission fence while that tail is held.
    expect(await queue.request({ type: "get_host_admission" })).toMatchObject({ success: true, data: {
      pendingGoalResumes: [expect.objectContaining({ id: "queue-old-resume", current: true })],
    } });
    const stopped = queue.client.abortAndRestoreQueue();
    const restored = await within(stopped, "priority stop while native compaction is held");
    // All three user drafts fit. The agent-authored context belongs in the
    // journal, not in this response; its absence here is not truncation.
    expect(restored).toEqual({
      steering: [
        { text: "Already admitted steering\nKeep the exact first draft." },
        { text: "Already admitted second steering: preserve ordering." },
      ],
      followUp: [{ text: "Already admitted follow-up\nKeep the exact final draft." }],
    });
    serialBarrier = undefined;
    expect(await compact).toMatchObject({ success: false });
    expect(compactSettled).toBe(true);
    expect(await queuedResume).toMatchObject({ success: false, error: "Goal resume cancelled before admission" });
    await queue.request({ type: "get_available_commands" }, "queue-drained-barrier");
    const queueState = await queue.client.getState();
    expect(queueState).toMatchObject({ isSettled: true, isStreaming: false, queuedMessageCount: 0,
      goal: { enabled: false, goal: { status: "paused" } } });
    expect(frames.filter(event => event.socketPath === queuePaths.socketPath && event.frame.type === "agent_start")).toHaveLength(2);
    detachBarrier();
    await queue.client.goal("drop");
    await queue.request({ type: "shutdown_host" });
    await within(queue.exited, "queue proof native shutdown");
    owned.delete(queuePaths.socketPath);
    const queueJournal = parseSessionEntries(await fs.readFile(queuePaths.sessionFile, "utf8"));
    expect(queueJournal.flatMap(entry => entry.type === "message" && entry.message.role === "user"
      ? [entry.message.content] : [])).toEqual([[{ type: "text", text: queuePrompt }]]);
    expect(queueJournal.filter(entry => entry.type === "custom_message" && entry.customType === "fixture-stop-context"))
      .toEqual([expect.objectContaining({ content: "Preserve admitted internal context without a model turn.", display: true })]);

    const secondRoute = { ...route, threadId: "9002" };
    await runtime.receive(headInput("200", secondRoute, "Continue entrusted work [pause-goal]"));
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
    const correctionTask = "Resume, but apply this full correction [resume-correction].";
    const correction: Inbound = {
      ...headInput("202", second.route, correctionTask),
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
    await runtime.messageLane(second.id, correctionTask, correction.id);
    await until(() => store.input(`handoff:202:${second.id}`)?.state === "done", "full source correction and attachment delivery");
    expect(store.input(`handoff:202:${second.id}`)).toMatchObject({ text: correctionTask, attachments: correction.attachments });
    expect(store.input(`report:handoff:202:${second.id}`)?.text).toContain("CORRECTION_APPLIED 202");
    expect(messenger.downloads.slice(downloadsBeforeCorrection)).toEqual([{ route: correction.route, attachment: correction.attachments[0] }]);
    await runtime.resume(second.id, correction.id);
    await runtime.messageLane(second.id, correctionTask, correction.id);
    await secondConnection.client.getState();
    expect(frames.filter(event => event.socketPath === second.socketPath && event.frame.type === "agent_start")).toHaveLength(4);
    const disabledRoute = { ...route, threadId: "9003" };
    await runtime.receive(headInput("300", disabledRoute, "Report native capability [goal-disabled]"));
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
    await runtime.receive(headInput("400", excludedRoute, "Report explicit tool selection [goal-disabled]"));
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
    console.log(JSON.stringify({ nativeAutonomy: "passed",
      headEmptyTodoTail: { sessionId: headState.sessionId, sourceId: "050", route: headRoute,
        meaningfulFrameIndex: replyFrameIndex, reminderFrameIndex, emptyFrameIndex,
        emittedReplies: 1, nextSourceId: "051", nativeTodoCleared: true },
      directHeadProgress: { sourceId: "052", route: directProgressRoute, deliveredBeforeToolRelease: true, separateFinal: true },
      laneProgress: { sourceId: "500", receiptId: receipt.id, route: progressLane.route,
        deliveredBeforeToolRelease: true, separateFinal: true, nativeRuns: 1 },
      first: { sessionId: firstState.sessionId, runs: 2 },
      queuedResume: { sessionId: queueState.sessionId, sourceId: "queue-source", route: queueRoute, runs: 2,
        cancelled: true, restored },
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
        await connection.request({ type: "shutdown_host" });
        await within(connection.exited, "owned native shutdown");
      } finally { await connection.close(); }
    }
    for (const connection of connections) await connection.close();
    store.close();
    if (success) await fs.rm(root, { recursive: true, force: true });
  }
}
