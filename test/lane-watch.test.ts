import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { hostPaths, type Config } from "../src/config";
import { physicalRoute } from "../src/contracts";
import type { Inbound, Lane, Messenger, OutputRecord, Route } from "../src/contracts";
import { DeliveryError } from "../src/delivery";
import { isLaneWatchNotice, LaneWatcher } from "../src/lane-watch";
import { Superagent, type RuntimeHost, type RuntimeState } from "../src/runtime";
import { Store } from "../src/store";

const origin: Route = { platform: "discord", accountId: "2", authorityId: "1", guildId: "3", channelId: "4",
  threadId: null, topicId: "watch-topic" };
const destination: Route = { platform: "discord", accountId: "2", authorityId: "1", guildId: "3", channelId: "4", threadId: "5" };
const restricted: Route = { ...destination, channelId: "6" };
const laneId = "lane-fixture";
const secret = "PRIVATE-FIXTURE-CONTENT";
const model = { provider: "fixture", id: "fixture" };
const cleanups: Array<() => void | Promise<void>> = [];
let nextMessageId = 10_000;
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function message(id: string, route = origin, text = secret): Inbound {
  return { id, route, text, messageId: String(nextMessageId++), attachments: [], receivedAt: 1 };
}

function owner(store: Store, id: string, route = origin): string {
  store.receive(message(id, route), "main", { [`user-source:${id}`]: "true" });
  store.settle(id, "done");
  return id;
}

function makeLane(store: Store, config: Config, route = destination, id = laneId) {
  const source = `open-${id}`;
  store.receive(message(source, route), null, { [`user-source:${source}`]: "true", [`topic-owner:${source}`]: id });
  const lane = { id, route, title: secret, cwd: config.headCwd, repoRoot: null, brief: secret, acceptance: [secret],
    model, modelReason: "fixture", modelPreset: null, modelPresetSnapshot: null,
    ...hostPaths(config, id), workState: "open", runtimeState: "unloaded", sessionId: null,
    generation: 0, pid: null, createdAt: 1, lastActivityAt: 1, result: null } satisfies Lane;
  store.createLane(lane, source);
  store.settle(source, "done");
  return lane;
}

function fixture() {
  const directory = realpathSync(mkdtempSync("/tmp/sa-lane-watch-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const config: Config = {
    path: join(directory, "config.json"), stateDir: directory, headCwd: directory, command: [process.execPath],
    maxHosts: 2, maxSubagents: 2, idleMs: 60_000,
    discord: { tokenEnv: "UNUSED", ownerId: "1", allowedGuildIds: ["3"], allowedChannelIds: ["4", "6"] },
    slack: { botTokenEnv: "UNUSED", appTokenEnv: "UNUSED", ownerId: "U1", teamId: "T1", allowedChannelIds: ["C1"] },
    groupRooms: [{ platform: "discord", guildId: "3", channelId: "6", userIds: ["1"], mode: "request",
      dailyLimit: 1, revision: "test" }],
  };
  const database = join(directory, "coordination.sqlite");
  const open = () => {
    const store = new Store(database);
    cleanups.push(() => store.close());
    return store;
  };
  const store = open();
  const lane = makeLane(store, config);
  const watcher = new LaneWatcher(store, config);
  const sourceId = owner(store, "registered");
  const track = { action: "track" as const, sourceId, laneId };
  return { config, store, open, watcher, lane, track };
}

function submitted(store: Store, lane: Lane, id: string) {
  store.receive(message(id, lane.route), lane.id, { [`user-source:${id}`]: "true", [`topic-owner:${id}`]: lane.id });
  store.submit(id, `native-${id}`, lane.generation);
  const input = store.input(id);
  if (!input) throw new Error("Fixture native input is missing");
  return input;
}

function notices(store: Store) {
  return store.inputs("main", "pending").filter(input => isLaneWatchNotice(input.id));
}

test("structured lane evidence produces one durable original-route receipt without transcript or authority", () => {
  const { store, config, lane, track, watcher, open } = fixture();
  store.updateLane(lane.id, lane.generation, { sessionId: "native-lane", runtimeState: "running" });
  const input = submitted(store, lane, "work");
  const evidence = { kind: "file" as const, ref: `/${secret}`, fingerprint: "a".repeat(64) };
  store.recordLaneReport(input.id, lane.generation, "native-lane", "baseline",
    { status: "progress", summary: secret, evidence: [evidence] }, 10);
  expect(watcher.change(track)).toMatchObject({ tracking: true, events: 0 });
  watcher.poll(10_000);
  expect(notices(store)).toEqual([]);

  store.recordLaneReport(input.id, lane.generation, "native-lane", "same-evidence",
    { status: "progress", summary: "Reworded commentary", evidence: [evidence] }, 20);
  watcher.poll(10_001);
  expect(notices(store)).toEqual([]);
  store.recordLaneReport(input.id, lane.generation, "native-lane", "changed-evidence",
    { status: "progress", summary: secret, evidence: [{ ...evidence, fingerprint: "b".repeat(64) }] }, 21);
  watcher.poll(10_002);

  store.close();
  const reopened = open();
  const restored = new LaneWatcher(reopened, config);
  restored.poll(11_000);
  const pending = notices(reopened);
  expect(pending).toHaveLength(1);
  const [notice] = pending;
  if (!notice) throw new Error("Missing durable observation");
  const original = reopened.input(track.sourceId);
  if (!original?.messageId) throw new Error("Missing original physical message identity");
  expect(notice).toMatchObject({ route: origin, target: "main", messageId: original.messageId, attachments: [], workflow: null });
  expect(reopened.ownerSource(notice.id)).toBeNull();
  expect([...reopened.admittedMessageIds(origin)]).toEqual([original.messageId]);
  expect(notice.text).not.toContain(secret);
  restored.consume(notice);
  expect(reopened.outputs()).toEqual([expect.objectContaining({ sourceId: notice.id, route: origin, text: notice.text,
    replyTo: { route: physicalRoute(origin), messageId: original.messageId } })]);
  expect(reopened.headRecoveryEffects(original.id)).toEqual([]);
  expect(restored.change({ action: "status", sourceId: track.sourceId, laneId })).toMatchObject({ events: 1, lastEvents: ["progress"] });
});

test.each(["discord-interaction", "slack-invocation"] as const)("preserves a %s registration without manufacturing a message ID", async kind => {
  const { store, watcher, lane, track } = fixture();
  const original: Inbound = kind === "discord-interaction"
    ? { ...message("interaction-source"), messageId: null, interactionId: "139143" }
    : { ...message("invocation-source", { platform: "slack", accountId: "T1:B1", authorityId: "U1",
      guildId: "T1", channelId: "C1", threadId: null }), messageId: null, invocationId: "a".repeat(64) };
  store.receive(original, "main", { [`user-source:${original.id}`]: "true" });
  store.settle(original.id, "done");
  watcher.change({ ...track, sourceId: original.id });
  store.updateLane(lane.id, lane.generation, { workState: "paused" });
  watcher.poll(10);
  if (kind === "slack-invocation") await watcher.pollCrossPlatform(10, { open: () => true, check: async () => true });

  const [notice] = notices(store);
  if (!notice) throw new Error("Missing command observation");
  expect(notice.route).toEqual(original.route);
  expect(notice.messageId).toBeNull();
  expect(notice.interactionId).toBe(original.interactionId);
  expect(notice.invocationId).toBe(original.invocationId);
  expect(store.ownerSource(notice.id)).toBeNull();
  watcher.consume(notice);
  expect(store.outputs()).toEqual([expect.objectContaining({ route: original.route, sourceId: notice.id })]);
});

test("settled native work and elapsed silence are not completion, and ambiguous execution is not a verified error", () => {
  const { store, lane, watcher, track } = fixture();
  const quiet = submitted(store, lane, "quiet");
  watcher.change(track);
  watcher.poll(9_000_000);
  store.settle(quiet.id, "done");
  store.updateLane(lane.id, lane.generation, { runtimeState: "idle" });
  watcher.poll(9_000_100);
  expect(notices(store)).toEqual([]);

  const lost = submitted(store, lane, "lost-ack");
  store.settle(lost.id, "uncertain");
  watcher.poll(9_000_200);
  expect(watcher.change({ action: "status", sourceId: track.sourceId, laneId })).toMatchObject({
    workState: "open", blocked: "execution-uncertain", lastEvents: ["execution-uncertain"],
  });
  store.settle(lost.id, "cancelled");
  const failed = submitted(store, lane, "observed-error");
  watcher.recordFailure(failed);
  store.settle(failed.id, "uncertain");
  watcher.poll(9_000_300);
  expect(watcher.change({ action: "status", sourceId: track.sourceId, laneId })).toMatchObject({
    workState: "open", events: 2, lastEvents: ["failed", "execution-uncertain"],
  });
});

test("a repeated lane wait neither yields another notice nor becomes a stall by aging", () => {
  const { store, lane, watcher, track } = fixture();
  store.updateLane(lane.id, lane.generation, { sessionId: "native-lane", runtimeState: "running" });
  const input = submitted(store, lane, "waiting-work");
  const waiting = { kind: "dependency" as const, target: secret };
  watcher.change(track);
  store.recordLaneReport(input.id, lane.generation, "native-lane", "waiting-1",
    { status: "waiting", summary: secret, waiting, evidence: [] }, 10);
  watcher.poll(11);
  store.recordLaneReport(input.id, lane.generation, "native-lane", "waiting-2",
    { status: "waiting", summary: "Another report about the same wait", waiting, evidence: [] }, 20);
  watcher.poll(10_000_000);

  expect(watcher.change({ action: "status", sourceId: track.sourceId, laneId })).toMatchObject({
    blocked: null, lastEvents: ["waiting"], events: 1,
  });
  const pending = notices(store);
  expect(pending).toHaveLength(1);
  expect(pending[0]?.text).not.toContain(secret);
});

test.each(["runtime-interrupted", "kickoff-held"] as const)("only a durable %s blocker yields a stall notice", kind => {
  const { store, lane, watcher, track } = fixture();
  const work = "pending-work";
  const kickoff = "kickoff-output";
  store.receive(message(work, lane.route), lane.id, { [`kickoff-output:${work}`]: kickoff });
  store.queueOutput({ id: kickoff, sourceId: work, route: lane.route, text: "Kickoff" });
  watcher.change(track);
  watcher.poll(5_000_000);
  expect(notices(store)).toEqual([]);
  if (kind === "runtime-interrupted") store.updateLane(lane.id, lane.generation, { runtimeState: "interrupted" });
  else {
    store.claimOutput(kickoff);
    store.finishOutput(kickoff, "uncertain");
  }
  watcher.poll(5_000_001);
  expect(watcher.change({ action: "status", sourceId: track.sourceId, laneId })).toMatchObject({
    workState: "open", blocked: kind, lastEvents: [kind], events: 1,
  });
});

test("status and untrack cannot use another logical conversation or a synthetic/restricted source", () => {
  const { store, config, watcher, track } = fixture();
  watcher.change(track);
  const other = owner(store, "other", { ...origin, topicId: "other-topic" });
  const group = owner(store, "restricted", restricted);
  const foreign = makeLane(store, config, { ...destination, accountId: "777", threadId: "8" }, "lane-other-account");
  const groupLane = makeLane(store, config, restricted, "lane-restricted");
  store.receive(message("synthetic"), "main");

  expect(watcher.change({ action: "status", sourceId: other })).toEqual([]);
  expect(watcher.change({ action: "untrack", sourceId: other, laneId })).toBeNull();
  expect(watcher.change({ action: "status", sourceId: track.sourceId })).toEqual([
    expect.objectContaining({ sourceId: track.sourceId, laneId, tracking: true }),
  ]);
  for (const sourceId of [group, "synthetic"]) {
    expect(() => watcher.change({ action: "status", sourceId })).toThrow("original authorized owner");
  }
  for (const target of [foreign, groupLane]) {
    expect(() => watcher.change({ ...track, laneId: target.id })).toThrow("authorized managed lane");
  }
});

test("head stop and untrack suppress pending delivery; fresh registration does not replay held history", () => {
  const { store, config, watcher, track, lane, open } = fixture();
  const registered = watcher.change(track);
  store.updateLane(lane.id, lane.generation, { workState: "paused" });
  watcher.poll(10);
  const [queued] = notices(store);
  if (!queued) throw new Error("Missing queued pause observation");
  watcher.consume(queued);
  const output = store.output(`${queued.id}:notice`);
  if (!output) throw new Error("Missing pending outbox notice");
  expect(watcher.deliveryScope(output)).not.toBeNull();
  store.setMeta("head:stop-boundary", JSON.stringify({ inputId: "owner-stop", cancelledInputIds: [] }));
  expect(watcher.deliveryScope(output)).toBeNull();

  store.close();
  const reopened = open();
  const restored = new LaneWatcher(reopened, config);
  reopened.updateLane(lane.id, lane.generation, { workState: "open" });
  restored.poll(20);
  expect(restored.change(track)).toEqual(registered);
  expect(restored.change({ action: "status", sourceId: track.sourceId, laneId })).toMatchObject({
    tracking: false, held: "head-stopped", workState: "paused", lastEvents: ["paused"], events: 1,
  });
  expect(notices(reopened)).toEqual([]);

  const fresh = owner(reopened, "new-registration");
  expect(restored.change({ ...track, sourceId: fresh })).toMatchObject({
    tracking: true, held: null, sourceId: fresh, workState: "open", events: 1,
  });
  reopened.updateLane(lane.id, lane.generation, { workState: "completed", result: secret });
  restored.poll(30);
  const [final] = notices(reopened);
  if (!final) throw new Error("Missing observation after re-registration");
  const stop = { action: "untrack" as const, sourceId: owner(reopened, "untrack"), laneId };
  expect(restored.change(stop)).toMatchObject({ tracking: false, held: "untracked", workState: null, lastEvents: null });
  restored.consume(final);
  expect(reopened.input(final.id)?.state).toBe("cancelled");
  expect(reopened.output(`${final.id}:notice`)).toBeNull();
  restored.change({ ...track, sourceId: owner(reopened, "new-again") });
  restored.change(stop);
  expect(restored.change({ action: "status", sourceId: track.sourceId, laneId })).toMatchObject({ tracking: true, events: 2 });
});

function runtimeFixture({ store, config }: Pick<ReturnType<typeof fixture>, "store" | "config">, assertRoute?: Messenger["assertRoute"]) {
  const state: RuntimeState = { sessionFile: hostPaths(config, "main").sessionFile, sessionId: "native-head",
    isSettled: true, isStreaming: false, hasOwnedRunningWork: false, pendingUiRequests: [], goal: null };
  const prompts: Record<string, unknown>[] = [];
  const sent: OutputRecord[] = [];
  const errors: unknown[] = [];
  let listener: ((frame: Record<string, unknown>) => void) | undefined;
  let requestId: string | undefined;
  const awaitingAnswers = new Map<string, () => void>();
  const host: RuntimeHost = {
    client: { getState: async () => ({ ...state }), getSubagents: async () => [],
      abortAndRestoreQueue: async () => { throw new Error("Observation attempted native abort"); },
      cancelSubagent: async () => { throw new Error("Observation attempted native child cancellation"); } },
    exited: new Promise(() => {}),
    async request(command, id) {
      if (command.type === "get_entries") return { success: true, data: { entries: [], leafId: null } };
      if (command.type !== "prompt" || !id) throw new Error(`Unexpected native request: ${String(command.type)}`);
      requestId = id;
      prompts.push(command);
      state.isSettled = false;
      state.isStreaming = true;
      return { success: true, data: { agentInvoked: true } };
    },
    uiResponse() { throw new Error("Unexpected native dialog"); },
    onFrame(subscriber) { listener = subscriber; return () => { listener = undefined; }; },
    async close() {},
  };
  const messenger: Messenger = {
    async start() {}, async stop() {}, async fetchAfter() { return null; },
    ...(assertRoute ? { assertRoute } : {}),
    async send(output) { sent.push(output); awaitingAnswers.get(output.sourceId)?.(); return `sent-${sent.length}`; },
    async showApproval() { throw new Error("Observation attempted an approval"); },
    async dismissApproval() { throw new Error("Observation attempted approval dismissal"); },
    async createThread() { throw new Error("Observation attempted thread creation"); },
    async openAttachment() { throw new Error("Observation attempted to open an attachment"); },
  };
  const connected: string[] = [];
  const runtime = new Superagent(config, store, messenger, join(config.stateDir, "extension.ts"), error => errors.push(error), {
    async connect(path) { connected.push(path); return host; },
    async startHost() { throw new Error("Observation attempted to load the lane"); },
  });
  cleanups.pop(); // The runtime owns and closes this Store.
  cleanups.push(() => runtime.stop());
  const finishHead = (sourceId: string) => {
    if (!listener || !requestId) throw new Error("Missing admitted native HEAD prompt");
    const delivered = Promise.withResolvers<void>();
    awaitingAnswers.set(sourceId, delivered.resolve);
    state.isSettled = true;
    state.isStreaming = false;
    listener({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Watch registration handled." }] } });
    listener({ type: "prompt_result", id: requestId, agentInvoked: true, status: "completed", sessionSettled: true });
    return delivered.promise;
  };
  return { runtime, sent, prompts, errors, connected, finishHead };
}

test("HEAD watches a different unloaded lane and replies to the original message without a native notification turn", async () => {
  const { store, config, track, lane } = fixture();
  const requestingLane = makeLane(store, config, origin, "lane-requesting-topic");
  const { runtime, sent, prompts, errors, connected } = runtimeFixture({ store, config });
  await runtime.start();
  await expect(runtime.watchLane(track)).rejects.toThrow("current HEAD turn");
  const original = message("1200", origin, `Notify me when lane ${lane.id} finishes.`);
  await runtime.receive(original);
  await runtime.kick();
  expect(errors).toEqual([]);
  expect(store.input(original.id)).toMatchObject({ target: "main", state: "submitted", route: origin });
  expect(await runtime.watchLane({ ...track, sourceId: original.id })).toMatchObject({ tracking: true, events: 0 });

  await runtime.closeLane(lane.id, "completed", secret);
  await runtime.kick();

  expect(prompts).toHaveLength(1);
  expect(connected).toEqual([hostPaths(config, "main").socketPath]);
  expect(store.lane(requestingLane.id)).toMatchObject({ workState: "open", runtimeState: "unloaded" });
  expect(errors).toEqual([]);
  expect(sent).toEqual([expect.objectContaining({
    route: origin, replyTo: { route: physicalRoute(origin), messageId: original.messageId },
  })]);
  const [output] = sent;
  if (!output) throw new Error("Missing watcher notification");
  expect(output.route).not.toEqual(lane.route);
  expect(output.text).not.toContain(secret);
  expect(store.output(output.id)?.state).toBe("sent");
  expect(await runtime.watchLane({ action: "status", sourceId: original.id, laneId })).toMatchObject({
    workState: "completed", runtimeState: "unloaded", events: 1, lastEvents: ["completed"],
  });
  const noticeId = output.id.slice(0, -":notice".length);
  expect(store.ownerSource(noticeId)).toBeNull();
  await expect(runtime.messageLane(lane.id, "Must not dispatch", noticeId)).rejects.toThrow("cannot authorize lane work");
  await expect(runtime.resume(lane.id, noticeId)).rejects.toThrow("cannot authorize lane resume");
});

test.each(["before cursor", "before delivery"] as const)("a replaced target account %s holds and redacts a cross-platform watch across restart", async phase => {
  const { store, open, config, lane } = fixture();
  const slack: Route = { platform: "slack", accountId: "T1:B1", authorityId: "U1", guildId: "T1", channelId: "C1", threadId: null };
  let authenticatedDiscord = "999";
  let captureRejection = false;
  let revokeAfterProof = false;
  const beforeRejection = Promise.withResolvers<number>();
  const assertRoute: NonNullable<Messenger["assertRoute"]> = (route, purpose) => {
    if (route.platform !== "discord" || purpose !== "history")
      throw new Error("Must verify the target through its authenticated adapter");
    if (route.accountId !== authenticatedDiscord) {
      if (captureRejection) beforeRejection.resolve(store.outputs().filter(output => isLaneWatchNotice(output.id)).length);
      throw new DeliveryError("Discord account is not authenticated", "rejected");
    }
    if (revokeAfterProof) { revokeAfterProof = false; authenticatedDiscord = "999"; }
  };
  const { runtime, sent, errors, finishHead } = runtimeFixture({ store, config }, assertRoute);
  await runtime.start();
  const original = { ...message("cross-platform-watch", slack, `Notify me when lane ${lane.id} finishes.`), messageId: "1700000000.001200" };
  await runtime.receive(original);
  await runtime.kick();
  expect(store.input(original.id)).toMatchObject({ target: "main", route: slack, state: "submitted" });
  const command = { action: "track" as const, sourceId: original.id, laneId };
  await expect(runtime.watchLane(command)).rejects.toThrow("verified authorized target route");
  expect(await runtime.watchLane({ ...command, action: "status" })).toBeNull();

  authenticatedDiscord = destination.accountId;
  expect(await runtime.watchLane(command)).toMatchObject({ tracking: true, workState: "open", events: 0 });
  captureRejection = true;
  if (phase === "before cursor") authenticatedDiscord = "999";
  else revokeAfterProof = true;
  await runtime.closeLane(lane.id, "completed", secret);
  await runtime.kick();

  expect(await beforeRejection.promise).toBe(phase === "before cursor" ? 0 : 1);
  const held = { tracking: false, held: "target-unavailable", workState: null, runtimeState: null, blocked: null, events: null, lastEvents: null };
  expect(await runtime.watchLane({ ...command, action: "status" })).toMatchObject(held);
  expect(await runtime.watchLane({ action: "status", sourceId: original.id })).toEqual([expect.objectContaining(held)]);
  expect(sent).toEqual([]);
  expect(errors).toEqual([]);
  await finishHead(original.id);
  await runtime.stop();

  captureRejection = false;
  authenticatedDiscord = destination.accountId;
  const reopened = open();
  const successor = runtimeFixture({ store: reopened, config }, assertRoute);
  await successor.runtime.start();
  const next = { ...original, id: "cross-platform-watch-again", messageId: "1700000000.001201", text: `Track lane ${lane.id} again.` };
  await successor.runtime.receive(next);
  await successor.runtime.kick();
  expect(await successor.runtime.watchLane({ action: "status", sourceId: next.id, laneId })).toMatchObject(held);
  expect(await successor.runtime.watchLane({ ...command, sourceId: next.id })).toMatchObject({
    tracking: true, held: null, workState: "completed", events: 0, lastEvents: [],
  });
  expect(successor.sent).toEqual([]);
});
