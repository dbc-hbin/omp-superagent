import { expect, test } from "bun:test";
import { activeManagedUlwRevision } from "../src/managed-ulw";
import { workerPackage } from "../src/remote-worker-wire";
import { strict as assert } from "node:assert";
import { EventEmitter, once } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadEntriesFromFileStream } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { hostPaths, parseConfig } from "../src/config";
import type { Inbound, Messenger, OutputRecord, Route } from "../src/contracts";
import { HostConnection, startHost } from "../src/host";
import { remoteConnect, remoteInspect } from "../src/remote-worker";
import type { WorkerHostIdentity } from "../src/remote-worker-wire";
import { Superagent, type RuntimeHost } from "../src/runtime";
import { Store } from "../src/store";
import { assertResidentFixtureOwner, stopHostFixtures, waitForFixtureProcessExit } from "./fixtures/host-fixture-processes";
import { detachedJournalOrder, nativeRemoteWorkerFixture, sshRemoteWorkerFixture, type RemoteWorkerProof } from "./fixtures/native-remote-worker";
import { recoveryGateMarker, remoteWorkerModel, workspaceProbe } from "./fixtures/native-remote-worker-provider";
import { nativeRequestEnvelope } from "./fixtures/native-request-envelope";
import { launchdAvailable } from "./fixtures/worker-launchd";

const nativeTest = process.env.OMP_SUPERAGENT_NATIVE_TEST === "1" ? test : test.skip;
// Opt-in proof against an operator-provisioned worker over real OpenSSH; see docs/OPERATIONS.md.
const sshWorker = process.env.OMP_SUPERAGENT_SSH_WORKER;
// The worker's Host starts through the real gui-domain LaunchAgent and its fixed launcher (macOS).
const launchdTest = launchdAvailable ? test : test.skip;
const sshTest = sshWorker && process.env.OMP_SUPERAGENT_NATIVE_TEST === "1" ? test : test.skip;
const route: Route = { platform: "discord", accountId: "2", authorityId: "1", guildId: "3", channelId: "4", threadId: "8001" };

class ThreadMessenger implements Messenger {
  private readonly events = new EventEmitter();
  private readonly sent = new Map<string, OutputRecord>();
  private handlers?: Parameters<Messenger["start"]>[0];

  async start(handlers: Parameters<Messenger["start"]>[0]): Promise<void> { this.handlers = handlers; }
  async deliver(message: Inbound): Promise<void> {
    assert.ok(this.handlers, "Messenger must be started before fixture intake");
    await this.handlers.ready;
    await this.handlers.message(message);
  }
  async send(output: OutputRecord): Promise<string> {
    assert.ok(!this.sent.has(output.id), `Duplicate messenger delivery: ${output.id}`);
    this.sent.set(output.id, structuredClone(output));
    this.events.emit(output.id);
    return `thread-receipt:${output.id}`;
  }
  async delivered(id: string): Promise<OutputRecord> {
    if (!this.sent.has(id)) {
      try { await once(this.events, id, { signal: AbortSignal.timeout(45_000) }); }
      catch (cause) { throw new Error(`Thread never received ${id}`, { cause }); }
    }
    const output = this.sent.get(id);
    assert.ok(output);
    return output;
  }
  deliveredIds(): string[] { return [...this.sent.keys()]; }
  deliveriesFrom(sourceId: string): OutputRecord[] {
    return [...this.sent.values()].filter(output => output.sourceId === sourceId);
  }
  async createThread(): Promise<Route> { throw new Error("Existing thread must never create a new destination"); }
  async showApproval(): Promise<string> { throw new Error("Offline provider should never request an approval"); }
  async dismissApproval(): Promise<void> { throw new Error("Offline provider should never dismiss an approval"); }
  async fetchAfter(): Promise<Inbound[]> { return []; }
  async openAttachment(): Promise<Response> { throw new Error("Offline fixture has no attachments"); }
  async stop(): Promise<void> { this.handlers = undefined; }
}

function source(messageId: string, text: string): Inbound {
  return { id: `discord:2:message:${messageId}`, messageId, route, text: `/head ${text}`, attachments: [], receivedAt: Date.now() };
}

async function nativeIdentity(connection: RuntimeHost): Promise<WorkerHostIdentity> {
  const state = await connection.client.getState();
  assert.ok(typeof state.hostPid === "number" && state.sessionFile
    && "adapterOwnerPid" in state && typeof state.adapterOwnerPid === "number");
  expect(state).toMatchObject({ model: remoteWorkerModel, adapterProtocol: "owned-stock-stdio-v1", isSettled: true });
  return { pid: state.hostPid, ownerPid: state.adapterOwnerPid, sessionId: state.sessionId, sessionFile: state.sessionFile };
}

async function shutdown(connection: RuntimeHost, identity: WorkerHostIdentity): Promise<void> {
  expect(await connection.request({ type: "shutdown_host" })).toMatchObject({ success: true });
  await waitForFixtureProcessExit([identity.pid, identity.ownerPid]);
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(() => timeout.reject(new Error("Owned native process exited without closing its transport")), 5_000);
  try { await Promise.race([connection.exited, timeout.promise]); }
  finally { clearTimeout(timer); }
}

const scenario = "stock OMP recovers a lost start reply and detached completion, then resumes the original worker and thread";
nativeTest(`${scenario} (loopback worker)`, () => proveRemoteWorker(nativeRemoteWorkerFixture), 180_000);
launchdTest(`${scenario} (loopback worker, real launchd)`, () => proveRemoteWorker(root => nativeRemoteWorkerFixture(root, true)), 180_000);
sshTest(`${scenario} (real SSH worker)`, () => proveRemoteWorker(root => sshRemoteWorkerFixture(root, sshWorker!)), 300_000);

async function proveRemoteWorker(provision: (root: string) => Promise<RemoteWorkerProof>): Promise<void> {
  const root = await mkdtemp(join(await realpath("/tmp"), "onw-"));
  const previousPath = process.env.PATH;
  let fixture: RemoteWorkerProof | undefined;
  let runtime: Superagent | undefined;
  let worker: RuntimeHost | undefined;
  let head: HostConnection | undefined;
  let completed = false;
  const runtimeErrors: unknown[] = [];
  try {
    const f = fixture = await provision(root);
    process.env.PATH = f.transportPath;
    // Only the test transport maps this virtual path into the worker's
    // workspace namespace. A HEAD realpath or local launch cannot use it.
    await expect(realpath(f.laneCwd)).rejects.toMatchObject({ code: "ENOENT" });
    const config = parseConfig({
      command: f.command, headCwd: f.headCwd, stateDir: f.headState, maxHosts: 2, maxSubagents: 2, idleMs: 3_600_000,
      workers: { builder: { destination: f.destination, workerId: f.workerId } },
      discord: { tokenEnv: "UNUSED_NATIVE_WORKER_TOKEN", ownerId: "1", allowedGuildIds: ["3"], allowedChannelIds: ["4"] },
    }, join(f.headState, "superagent.json"));
    const paths = hostPaths(config, "main");
    await startHost({
      ...paths, cwd: f.headCwd, command: f.command, extensionPath: f.provider,
      managedUlwPath: f.managedPackage, env: f.headEnv, subagentConcurrency: 1
    });
    head = await HostConnection.connect(paths.socketPath);
    const headIdentity = await nativeIdentity(head);
    await assertResidentFixtureOwner(f.headState, { nativePid: headIdentity.pid, ownerPid: headIdentity.ownerPid });
    const database = join(f.headState, "coordination.sqlite");
    let store = new Store(database);
    const messenger = new ThreadMessenger();
    const errors: unknown[] = runtimeErrors;
    const controller = (coordination: Store) => new Superagent(config, coordination, messenger, f.provider, error => errors.push(error));
    runtime = controller(store);
    // The worker's private provision pins the HEAD's durable instance.
    store.setMeta("worker:instance", f.instance);
    await runtime.start();
    const first = source("1750000000000000001", "Inspect the selected worker workspace.");
    const follow = source("1750000000000000002", "Explicitly delegate an additional workspace check.");
    const afterResume = source("1750000000000000003", "Resume the same lane and verify its workspace again.");
    const kickoff = "I’ll run the workspace check on the configured worker and report back here.";
    const receive = async (input: Inbound) => {
      await messenger.deliver(input);
      expect(await messenger.delivered(`${input.id}:answer`)).toMatchObject({
        route, text: `Head acknowledged ${input.id}`, replyTo: { route, messageId: input.messageId },
      });
    };
    const requireReport = async (input: Inbound, handoffId: string) => {
      expect(await messenger.delivered(`report:${handoffId}:answer`)).toMatchObject({
        route, replyTo: { route, messageId: input.messageId }, text: `Head acknowledged report:${handoffId}`,
      });
      expect(store.input(handoffId)).toMatchObject({ state: "done", route, messageId: input.messageId });
      const report = store.input(`report:${handoffId}`);
      expect(report).toMatchObject({ target: "main", route, state: "done" });
      expect(report?.text).toContain(`Worker finished ${input.id}: ${f.probe}`);
    };

    await receive(first);
    const lane = await runtime.startLane({
      sourceId: first.id, title: "Inspect worker workspace", cwd: f.laneCwd, worker: "builder", kickoff,
      model: remoteWorkerModel, modelReason: "Use the runner's deterministic offline model.",
    });
    const placement = { worker: "builder", destination: f.destination, workerId: f.workerId };
    expect(lane).toMatchObject({ route, cwd: f.cwd, placement });
    expect(dirname(dirname(lane.sessionFile))).toBe(f.stateDir);
    const initialHandoff = `handoff:${first.id}:lane`;
    expect(await messenger.delivered(`${first.id}:kickoff`)).toMatchObject({
      sourceId: initialHandoff, route, text: kickoff, replyTo: { route, messageId: first.messageId },
    });
    expect(store.output(`${first.id}:kickoff`)?.state).toBe("sent");
    await requireReport(first, initialHandoff);
    // HEAD verifies the worker lane through bounded evidence read on the worker.
    expect(await runtime.laneEvidence(lane.id, { kind: "file", path: workspaceProbe })).toMatchObject({ cwd: f.cwd, text: f.probe });
    await expect(runtime.laneEvidence(lane.id, { kind: "file", path: "../" })).rejects.toThrow("outside the lane workspace");
    expect(await runtime.laneEvidence(lane.id, { kind: "artifact", name: "host-log" }))
      .toMatchObject({ kind: "artifact", path: join(dirname(lane.sessionFile), "r1.log") });
    // The worker started without omp-superkit; HEAD shipped and pinned its own revision.
    expect(store.lane(lane.id)?.workerLaunch).toEqual({
      package: workerPackage(), omp: expect.any(String), superkit: activeManagedUlwRevision().revision, bootId: expect.any(String),
    });

    const resident = store.lane(lane.id);
    assert.ok(resident);
    worker = await remoteConnect(placement, f.instance, resident);
    const identity = await nativeIdentity(worker);
    expect(identity).toMatchObject({ sessionFile: resident.sessionFile, sessionId: resident.sessionId, pid: resident.pid });
    expect(await Bun.file(f.lostStartReceipt).json()).toEqual({
      laneId: lane.id, generation: resident.generation, pid: identity.pid,
    });
    expect(identity.sessionId).not.toBe(headIdentity.sessionId);
    const workerProcess = await f.workerProcess?.(identity.ownerPid);
    if (workerProcess) {
      // Outside the SSH session, in the account's user manager, with its login-shell PATH.
      if (workerProcess.context === "launchd") {
        expect(workerProcess).toMatchObject({ ownerParent: 1, launcherAlive: true, sshConnectionPresent: false, role: "lane" });
      } else {
        expect(workerProcess).toMatchObject({ pathResolvesLikeLoginShell: true, sshConnectionPresent: false, role: "lane" });
        expect(String(workerProcess.cgroup)).toMatch(/\/user@\d+\.service\/.*omp-sa-.*\.service$/);
      }
    }
    expect(new Set([identity.pid, identity.ownerPid, headIdentity.pid, headIdentity.ownerPid]).size).toBe(4);
    await f.assertWorkerOwner(dirname(resident.sessionFile), { nativePid: identity.pid, ownerPid: identity.ownerPid });

    await receive(follow);
    const followHandoff = `handoff:${follow.id}:${lane.id}`;
    const followReport = `report:${followHandoff}`;
    expect(store.input(followHandoff)).toBeNull();
    expect(await runtime.messageLane(lane.id, `${follow.text} ${recoveryGateMarker}`, follow.id)).toMatchObject({
      inputId: followHandoff, state: "submitted",
    });
    await f.waitForGate();
    const detachedPrompt = store.input(followHandoff)?.requestId;
    assert.ok(detachedPrompt);
    expect(await worker.client.getState()).toMatchObject({ isStreaming: true, isSettled: false, sessionId: identity.sessionId });
    expect(store.input(followReport)).toBeNull();
    // Keep the independent read-only worker observer attached. The old
    // controller closes its own connections and Store before OMP can finish.
    await runtime.stop();
    const terminal = Promise.withResolvers<Record<string, unknown>>();
    const unobserve = worker.onFrame(frame => {
      if (frame.type === "prompt_result" && frame.id === detachedPrompt) terminal.resolve(frame);
    });
    const timer = setTimeout(() => terminal.reject(new Error("Detached worker did not finish the accepted prompt")), 20_000);
    try {
      await f.releaseGate();
      expect(await terminal.promise).toMatchObject({ status: "completed", agentInvoked: true, sessionSettled: true });
    } finally {
      clearTimeout(timer);
      unobserve();
    }
    expect(await nativeIdentity(worker)).toEqual(identity);
    const detachedOrder = await detachedJournalOrder(await f.localJournal(identity.sessionFile));
    // Stock OMP may record the user and run-start markers in either order.
    // Both precede the assistant answer and its durable terminal receipt.
    expect(detachedOrder.slice(0, 2).sort()).toEqual(["rpc_agent_start", "user"]);
    expect(detachedOrder.slice(2)).toEqual(["assistant", "rpc_prompt_result"]);
    store = new Store(database);
    runtime = controller(store);
    expect(store.input(followHandoff)).toMatchObject({ state: "submitted", requestId: detachedPrompt });
    expect(store.input(followReport)).toBeNull();
    expect(messenger.deliveriesFrom(followReport)).toEqual([]);
    await runtime.start();
    await requireReport(follow, followHandoff);
    expect(store.input(followHandoff)?.requestId).toBe(detachedPrompt);
    expect(messenger.deliveriesFrom(followReport)).toEqual([await messenger.delivered(`${followReport}:answer`)]);

    await runtime.pause(lane.id);
    expect(store.laneForRoute(route)).toMatchObject({
      id: lane.id, workState: "paused", sessionId: identity.sessionId, generation: resident.generation, placement,
    });
    await receive(afterResume);
    await expect(runtime.messageLane(lane.id, afterResume.text, afterResume.id)).rejects.toThrow("explicitly resume");
    await runtime.resume(lane.id, afterResume.id);
    expect(store.laneForRoute(route)).toMatchObject({
      id: lane.id, workState: "open", sessionId: identity.sessionId, generation: resident.generation, placement,
    });
    const resumedHandoff = `handoff:${afterResume.id}:${lane.id}`;
    await runtime.messageLane(lane.id, afterResume.text, afterResume.id);
    await requireReport(afterResume, resumedHandoff);
    expect(await nativeIdentity(worker)).toEqual(identity);
    expect((await Bun.file(f.startAttempts).text()).trimEnd().split("\n")).toEqual([String(resident.generation)]);
    expect(errors).toEqual([]);
    const promptIds = [initialHandoff, followHandoff, resumedHandoff].map(id => {
      const requestId = store.input(id)?.requestId;
      assert.ok(requestId, `Missing native admission ID for ${id}`);
      return requestId;
    });

    await runtime.stop(); // Detach HEAD before shutting down the exact fixture owners.
    await shutdown(worker, identity);
    await shutdown(head, headIdentity);
    expect(await remoteInspect(placement, f.instance, resident)).toEqual({ socket: false, alive: false, transcript: true });
    const exitReceipt = join(dirname(identity.sessionFile), `r${resident.generation.toString(36)}.sock.exit.json`);
    expect(JSON.parse(await f.readWorkerFile(exitReceipt))).toEqual({
      ...identity, code: 0, signal: null, persisted: true, observationsFlushed: true,
    });
    const { entries, malformedRecords } = await loadEntriesFromFileStream(await f.localJournal(identity.sessionFile), { throwIfMissing: true });
    expect(malformedRecords).toBe(0);
    expect(entries[0]).toMatchObject({ type: "session", id: identity.sessionId, cwd: f.cwd });
    const nativeSources = entries.flatMap(entry => {
      if (entry.type !== "message" || entry.message.role !== "user") return [];
      const content = entry.message.content;
      const text = typeof content === "string" ? content : content.filter(part => part.type === "text").map(part => part.text).join("\n");
      const envelope = nativeRequestEnvelope(text);
      assert.ok(envelope);
      return [{ requestId: envelope.requestId, sourceId: envelope.sourceId }];
    });
    expect(nativeSources).toEqual([
      { requestId: initialHandoff, sourceId: first.id },
      { requestId: followHandoff, sourceId: follow.id },
      { requestId: resumedHandoff, sourceId: afterResume.id },
    ]);
    const completions = entries.flatMap(entry =>
      entry.type === "custom" && entry.customType === "rpc_prompt_result" ? [entry.data] : []);
    expect(completions).toEqual(promptIds.map((id, index) => expect.objectContaining({
      sessionId: identity.sessionId, hostPid: identity.pid, runOrdinal: index + 1,
      frame: expect.objectContaining({ type: "prompt_result", id, status: "completed", agentInvoked: true }),
    })));
    await f.record?.({
      workerProcess,
      laneId: lane.id, generation: resident.generation, cwd: lane.cwd, sessionId: identity.sessionId,
      workerPids: { omp: identity.pid, owner: identity.ownerPid }, headPids: { omp: headIdentity.pid, owner: headIdentity.ownerPid },
      startRequests: (await Bun.file(f.startAttempts).text()).trimEnd().split("\n"),
      lostStartReply: await Bun.file(f.lostStartReceipt).json(),
      followReportDeliveries: messenger.deliveriesFrom(followReport).map(output => output.id),
      threadDeliveries: messenger.deliveredIds(),
      nativeCompletions: completions.length,
    });
    completed = true;
  } finally {
    const connections = await Promise.allSettled([runtime?.stop(), worker?.close(), head?.close()]);
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    const owners = fixture ? await Promise.allSettled([
      fixture.stopWorkers(), stopHostFixtures(fixture.headState, join(fixture.headState, "run")),
    ]) : [];
    const failures = [...connections, ...owners].flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (completed && !failures.length) {
      await fixture?.cleanup();
      // Provisioned superkit revisions are immutable (read-only directories).
      await Bun.spawn(["chmod", "-R", "u+w", root]).exited;
      await rm(root, { recursive: true, force: true });
    }
    else console.error(`Native worker proof did not complete; private diagnostics retained at ${root}`, runtimeErrors);
    if (failures.length) throw new AggregateError(failures, "Native worker fixture teardown failed");
  }
}
