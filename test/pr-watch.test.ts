import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../src/config";
import type { Inbound } from "../src/contracts";
import type { PrSnapshot } from "../src/pr-github";
import { PrWatcher } from "../src/pr-watch";
import { Store } from "../src/store";

const fixtures: Array<{ store: Store | null; directory: string }> = [];
afterEach(() => {
  for (const { store, directory } of fixtures.splice(0)) {
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
const base: PrSnapshot = { head: "a".repeat(40), state: "open", mergedSha: null, self: "owner",
  feedback: [], failures: [], ci: { outcome: "missing" }, headChange: "unknown" };
const feedback = (key: string, actor = "reviewer") => ({
  key, actor, kind: "review", url: "https://github.com/example/project/pull/7#discussion_r1", text: `Feedback ${key}`,
});
function fixture(intervalSeconds: number | null = 1, settleSource = true) {
  const directory = mkdtempSync("/tmp/sa-pr-watch-");
  const config: Config = { path: join(directory, "config.json"), stateDir: directory, headCwd: directory,
    command: [process.execPath], maxHosts: 2, maxSubagents: 4, idleMs: 1000,
    discord: { tokenEnv: "UNUSED", ownerId: "1", allowedGuildIds: ["3"], allowedChannelIds: ["4"] } };
  const dbPath = join(directory, "coordination.sqlite");
  const store = new Store(dbPath);
  const resource: (typeof fixtures)[number] = { store, directory };
  fixtures.push(resource);
  const reopen = () => {
    resource.store?.close();
    resource.store = null;
    const replacement = new Store(dbPath);
    resource.store = replacement;
    return replacement;
  };
  const input: Inbound = { id: "source", messageId: "123", text: "Follow this PR", receivedAt: 1, attachments: [],
    route: { platform: "discord", accountId: "2", authorityId: "1", guildId: "3", channelId: "4", threadId: "5" } };
  store.receive(input, "main", { "user-source:source": "true" });
  if (settleSource) store.settle(input.id, "done");
  else store.submit(input.id, "fixture-native-request", 0);
  const observed = { snapshot: base, calls: 0, failure: false };
  const read = async () => {
    observed.calls++;
    if (observed.failure) throw new Error("GitHub read failed");
    return observed.snapshot;
  };
  const watcher = new PrWatcher(store, config, read);
  const request = { sourceId: input.id };
  const command = { ...request, action: "track" as const, ref: "example/project#7",
    ...(intervalSeconds === null ? {} : { intervalSeconds }) };
  watcher.change(command);
  const signal = new AbortController().signal;
  return { store, reopen, config, input, observed, watcher, read, request, command, signal };
}

test("baseline is quiet and new reviews and CI reruns are durable original-route HEAD observations", async () => {
  const f = fixture();
  f.observed.snapshot = { ...base, feedback: [feedback("old")], ci: { outcome: "passed", key: "first-pass", skipped: 0 } };
  await f.watcher.poll(1000, f.signal);
  expect(f.store.inputs("main")).toHaveLength(0);
  expect(f.watcher.list(f.request)[0]?.baseline?.ci).toBe("passed");
  f.observed.snapshot = { ...base, feedback: [feedback("old"), feedback("new"), feedback("own", "owner")],
    failures: [{ key: "check:1:run1", name: "tests", conclusion: "failure", url: "https://github.com/example/project/actions/runs/1" }],
    ci: { outcome: "failed" } };
  await f.watcher.poll(2000, f.signal);
  const [event] = f.store.inputs("main");
  expect(event?.route).toEqual(f.input.route);
  expect(event?.messageId).toBe("123");
  expect(event?.text).toContain("Feedback new");
  expect(event?.text).not.toContain("Feedback old");
  expect(event?.text).not.toContain("Feedback own");
  expect(event?.text).toContain("PR_CI_FAIL");
  expect(event && f.store.getMeta(`user-source:${event.id}`)).toBeNull();
  await new PrWatcher(f.store, f.config, f.read).poll(3000, f.signal);
  expect(f.store.inputs("main")).toHaveLength(1);
  f.observed.snapshot = { ...f.observed.snapshot, failures: [{ key: "check:1:run2", name: "tests",
    conclusion: "failure", url: "https://github.com/example/project/actions/runs/1" }], ci: { outcome: "failed" } };
  await f.watcher.poll(4000, f.signal);
  expect(f.store.inputs("main")).toHaveLength(2);
});

test("a completed CI rerun reports once and the consumed pass is not replayed after SQLite restart", async () => {
  const f = fixture();
  f.observed.snapshot = { ...base, ci: { outcome: "pending" } };
  await f.watcher.poll(0, f.signal);
  f.observed.snapshot = { ...base, ci: { outcome: "passed", key: "run-1", skipped: 0 } };
  await f.watcher.poll(1000, f.signal);
  const [pass] = f.store.inputs("main");
  if (!pass) throw new Error("Expected first CI pass");
  expect(pass.text).toContain("PR_CI_PASS");
  expect(pass.route).toEqual(f.input.route);
  expect(f.store.settle(pass.id, "done")).toBe(true);
  const reopened = f.reopen();
  const restored = new PrWatcher(reopened, f.config, f.read);
  await restored.poll(2000, f.signal);
  expect(reopened.inputs("main")).toEqual([]);
  expect(restored.list(f.request)[0]).toMatchObject({ baseline: { ci: "pending" }, latest: { ci: "passed" } });
  f.observed.snapshot = { ...base, ci: { outcome: "pending" } };
  await restored.poll(3000, f.signal);
  expect(reopened.inputs("main")).toEqual([]);
  f.observed.snapshot = { ...base, ci: { outcome: "passed_with_skips", key: "run-2", skipped: 2 } };
  await restored.poll(4000, f.signal);
  const notices = reopened.inputs("main");
  expect(notices).toHaveLength(1);
  expect(notices[0]?.id).not.toBe(pass.id);
  expect(notices[0]?.text).toContain("PR_CI_PASS");
  expect(notices[0]?.text).toContain('"outcome":"passed_with_skips","skipped":2');
});

test.each(["discord", "slack"] as const)("a %s app-command notice preserves its real origin without inventing a message", async platform => {
  const f = fixture();
  f.config.slack = { botTokenEnv: "UNUSED", appTokenEnv: "UNUSED", teamId: "T1", ownerId: "U1", allowedChannelIds: ["C1"] };
  const origin: Inbound = { ...f.input, id: "app-source", messageId: null, ...(
    platform === "discord" ? { interactionId: "1234" } : {
      route: { platform, accountId: "T1:B1", authorityId: "U1", guildId: "T1", channelId: "C1", threadId: null },
      invocationId: "d".repeat(64),
    }
  ) };
  f.watcher.change({ ...f.request, action: "untrack", ref: f.command.ref });
  f.store.receive(origin, "main", { "user-source:app-source": "true" });
  f.store.settle(origin.id, "done");
  f.watcher.change({ ...f.command, sourceId: origin.id });
  await f.watcher.poll(0, f.signal);
  f.observed.snapshot = { ...base, ci: { outcome: "passed", key: "app-origin-pass", skipped: 0 } };
  await f.watcher.poll(1000, f.signal);
  const [notice] = f.store.inputs("main");
  expect(notice).toMatchObject({ route: origin.route, messageId: null, text: expect.stringContaining("PR_CI_PASS") });
  expect(notice?.interactionId).toBe(origin.interactionId);
  expect(notice?.invocationId).toBe(origin.invocationId);
});

test("omitted cadence reads immediately then waits five minutes", async () => {
  const f = fixture(null);
  await f.watcher.poll(1000, f.signal);
  f.watcher.change({ ...f.command, intervalSeconds: 300 }); // Explicit default is the same source intent.
  f.observed.snapshot = { ...base, feedback: [feedback("next")] };
  await f.watcher.poll(300999, f.signal);
  expect(f.store.inputs("main")).toEqual([]);
  await f.watcher.poll(301000, f.signal);
  expect(f.store.inputs("main")[0]?.text).toContain("Feedback next");
});

test("self pushes do not wake HEAD but external changes and repeated close/reopen do", async () => {
  const f = fixture();
  await f.watcher.poll(0, f.signal);
  f.observed.snapshot = { ...base, head: "b".repeat(40), headChange: "self" };
  await f.watcher.poll(1000, f.signal);
  expect(f.store.inputs("main")).toHaveLength(0);
  f.observed.snapshot = { ...base, headChange: "rewritten" };
  await f.watcher.poll(2000, f.signal);
  expect(f.store.inputs("main")[0]?.text).toContain("PR_HEAD_MOVED");
  for (const [index, state] of (["closed", "open", "closed", "open"] as const).entries()) {
    f.observed.snapshot = { ...base, state };
    await f.watcher.poll(3000 + index * 1000, f.signal);
  }
  expect(f.store.inputs("main")).toHaveLength(5);
  f.observed.snapshot = { ...base, state: "merged", mergedSha: "c".repeat(40) };
  await f.watcher.poll(7000, f.signal);
  const calls = f.observed.calls;
  await f.watcher.poll(8000, f.signal);
  expect(f.observed.calls).toBe(calls);
  expect(f.store.inputs("main").at(-1)?.text).toContain("PR_MERGED");
});

test("failed observations preserve the baseline, notify once and recover without losing later feedback", async () => {
  const f = fixture();
  await f.watcher.poll(0, f.signal);
  f.observed.failure = true;
  await f.watcher.poll(1000, f.signal);
  await f.watcher.poll(2000, f.signal);
  expect(f.store.inputs("main")).toHaveLength(1);
  expect(f.watcher.list(f.request)[0]?.baseline?.head).toBe(base.head);
  f.observed.failure = false;
  f.observed.snapshot = { ...base, feedback: [feedback("later")] };
  await f.watcher.poll(3000, f.signal);
  expect(f.store.inputs("main")).toHaveLength(2);
  expect(f.watcher.list(f.request)[0]?.error).toBeNull();
});

test("tracking mutations are source-bound and an old retry cannot re-enable an untracked PR", () => {
  const f = fixture();
  const epoch = f.watcher.list(f.request)[0]?.epoch;
  f.watcher.change(f.command);
  expect(f.watcher.list(f.request)[0]?.epoch).toBe(epoch);
  expect(() => f.watcher.change({ ...f.command, intervalSeconds: 2 })).toThrow("identity conflict");
  f.watcher.change({ action: "untrack", sourceId: "source", ref: f.command.ref });
  f.watcher.change(f.command);
  expect(f.watcher.list(f.request)).toHaveLength(0);
  expect(() => f.watcher.change({ ...f.command, sourceId: "missing" })).toThrow("authorized user source");
});

test("matching PR registrations in separate conversations keep independent cursors and untrack scope", async () => {
  const f = fixture();
  const other = { ...f.input, id: "other", messageId: "124", route: { ...f.input.route, threadId: "6" } };
  f.store.receive(other, "main", { "user-source:other": "true" });
  f.store.settle(other.id, "done");
  f.watcher.change({ ...f.command, sourceId: other.id });
  await f.watcher.poll(0, f.signal);
  expect(f.watcher.list(f.request).map(item => item.sourceId)).toEqual([f.input.id]);
  expect(f.watcher.list({ sourceId: other.id, ref: "https://github.com/EXAMPLE/project/pull/7" }).map(item => item.sourceId))
    .toEqual([other.id]);
  expect(f.watcher.list({ sourceId: other.id, ref: "example/project#8" })).toEqual([]);
  f.watcher.change({ action: "untrack", ref: f.command.ref, sourceId: other.id });
  f.observed.snapshot = { ...base, feedback: [feedback("new")] };
  await f.watcher.poll(1000, f.signal);
  expect(f.watcher.list({ sourceId: other.id })).toEqual([]);
  expect(f.store.inputs("main").map(item => item.route)).toEqual([f.input.route]);
});

test("old records and receipts retain stop and uncertainty across restart without inventing a CI baseline", async () => {
  const f = fixture(1, false);
  const statusSource = { ...f.input, id: "status", messageId: "124" };
  f.store.receive(statusSource, "main", { "user-source:status": "true" });
  f.store.settle(statusSource.id, "done");
  const previousBoundary = JSON.stringify({ inputId: "older-stop", cancelledInputIds: [] });
  const receipt = {
    ref: { owner: "example", repo: "project", number: 7 }, epoch: "legacy", sourceId: f.input.id,
    laneId: null, intervalSeconds: 1, ignoreAuthors: [], stopBoundary: previousBoundary, nextCheckAt: 1000,
    snapshot: null, seen: [], events: 0, error: null,
  };
  const oldUntrack = { action: "untrack", sourceId: statusSource.id, ref: f.command.ref } as const;
  f.store.setMeta("pr-watch:v1", JSON.stringify({
    watches: [{ ...receipt, snapshot: { head: base.head, state: "open", mergedSha: null, self: "owner" },
      seen: ["already-observed"], events: 1 }],
    receipts: {
      [JSON.stringify([f.input.id, "track", f.command.ref])]: { command: f.command, result: receipt },
      [JSON.stringify([statusSource.id, "untrack", f.command.ref])]: { command: oldUntrack, result: null },
    },
  }));
  f.store.setMeta("head:stop-boundary", JSON.stringify({ inputId: "stop", cancelledInputIds: [] }));
  const restored = new PrWatcher(f.store, f.config, f.read);
  expect(restored.change(f.command)?.epoch).toBe("legacy");
  expect(restored.list({ sourceId: statusSource.id })[0]).toMatchObject({
    held: true, baseline: null, latest: { head: base.head, ci: null }, events: 1,
  });
  await restored.poll(1000, f.signal);
  expect(f.observed.calls).toBe(0);

  // In a live legacy watch, preserve the cursor and seen keys rather than taking a fresh baseline.
  f.store.setMeta("head:stop-boundary", previousBoundary);
  f.observed.snapshot = { ...base, ci: { outcome: "passed", key: "old-pass", skipped: 0 },
    feedback: [feedback("already-observed"), feedback("new")] };
  await restored.poll(1000, f.signal);
  const [notice] = f.store.inputs("main", "pending");
  if (!notice) throw new Error("Expected new legacy feedback");
  expect(notice.text).toContain("Feedback new");
  expect(notice.text).not.toContain("already-observed");
  expect(notice.text).not.toContain("PR_CI_PASS");
  expect(restored.list({ sourceId: statusSource.id })[0]).toMatchObject({ baseline: null, latest: { ci: "passed" } });
  expect(f.store.settle(notice.id, "uncertain")).toBe(true);
  expect(f.store.settle(f.input.id, "uncertain")).toBe(true);
  const reopened = f.reopen();
  const restarted = new PrWatcher(reopened, f.config, f.read);
  await restarted.poll(2000, f.signal);
  expect(f.observed.calls).toBe(1);
  expect(reopened.inputs("main", "uncertain").map(input => input.id)).toEqual([f.input.id, notice.id]);
  expect(restarted.list({ sourceId: statusSource.id })[0]?.held).toBe(true);
  const resume = { ...f.input, id: "register-again", messageId: "125" };
  reopened.receive(resume, "main", { "user-source:register-again": "true" });
  reopened.settle(resume.id, "done");
  restarted.change({ ...f.command, sourceId: resume.id });
  expect(restarted.change(oldUntrack)).toBeNull();
  expect(restarted.list({ sourceId: statusSource.id }).map(item => item.sourceId)).toEqual([resume.id]);
  expect(reopened.input(notice.id)?.state).toBe("uncertain");
});

test("untrack during a slow read cannot write a stale cursor or deliver feedback", async () => {
  const f = fixture();
  await f.watcher.poll(0, f.signal);
  const pending = Promise.withResolvers<PrSnapshot>();
  const watcher = new PrWatcher(f.store, f.config, () => pending.promise);
  const poll = watcher.poll(1000, f.signal);
  watcher.change({ action: "untrack", sourceId: "source", ref: f.command.ref });
  pending.resolve({ ...base, feedback: [feedback("late")] });
  await poll;
  expect(watcher.list(f.request)).toHaveLength(0);
  expect(f.store.inputs("main")).toHaveLength(0);
});

test("head stop during a read durably holds watches until a new explicit registration", async () => {
  const f = fixture();
  await f.watcher.poll(0, f.signal);
  const pending = Promise.withResolvers<PrSnapshot>();
  const watcher = new PrWatcher(f.store, f.config, () => pending.promise);
  const poll = watcher.poll(1000, f.signal);
  f.store.setMeta("head:stop-boundary", JSON.stringify({ inputId: "stop", cancelledInputIds: [] }));
  pending.resolve({ ...base, feedback: [feedback("late")] });
  await poll;
  expect(watcher.list(f.request)[0]?.held).toBe(true);
  const restored = new PrWatcher(f.store, f.config, f.read);
  await restored.poll(2000, f.signal);
  expect(f.observed.calls).toBe(1);
  expect(f.store.inputs("main")).toHaveLength(0);
  f.store.receive({ ...f.input, id: "resume", messageId: "124" }, "main", { "user-source:resume": "true" });
  restored.change({ ...f.command, sourceId: "resume" });
  expect(restored.list(f.request)[0]?.held).toBe(false);
});

test("changing the allowed route prevents network observation", async () => {
  const f = fixture();
  f.config.discord = { tokenEnv: "UNUSED", ownerId: "1", allowedGuildIds: ["3"], allowedChannelIds: ["999"] };
  await f.watcher.poll(0, f.signal);
  expect(f.observed.calls).toBe(0);
  expect(() => f.watcher.list(f.request)).toThrow("authorized user source");
  expect(() => f.watcher.change({ ...f.command, ref: "example/project#8" })).toThrow("authorized user source");
});

test("aborted observation does not persist a cursor or emit an error wake", async () => {
  const f = fixture();
  const pending = Promise.withResolvers<PrSnapshot>();
  const controller = new AbortController();
  const watcher = new PrWatcher(f.store, f.config, () => pending.promise);
  const poll = watcher.poll(0, controller.signal);
  controller.abort();
  pending.resolve(base);
  await poll;
  expect(watcher.list(f.request)[0]?.baseline).toBeNull();
  expect(f.store.inputs("main")).toHaveLength(0);
});

test("a failed atomic admission leaves feedback eligible on the next pass", async () => {
  const f = fixture();
  await f.watcher.poll(0, f.signal);
  f.observed.snapshot = { ...base, feedback: [feedback("new")] };
  const receive = f.store.receive.bind(f.store);
  f.store.receive = () => { throw new Error("Admission failed"); };
  await expect(f.watcher.poll(1000, f.signal)).rejects.toThrow("Admission failed");
  f.store.receive = receive;
  await f.watcher.poll(1000, f.signal);
  expect(f.store.inputs("main")).toHaveLength(1);
  expect(f.store.inputs("main")[0]?.text).toContain("Feedback new");
});

test("damaged cursor never silently becomes a fresh baseline", async () => {
  const f = fixture();
  f.store.setMeta("pr-watch:v1", '{"watches":[]}');
  await expect(f.watcher.poll(0, f.signal)).rejects.toThrow("damaged");
  expect(f.observed.calls).toBe(0);
});
