import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Board, BoardMembershipError, type BoardPost } from "../src/board";
import boardExtension from "../src/board-extension";
import { BoardFixture } from "./fixtures/board";

const fixtures: BoardFixture[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const fixture of fixtures.splice(0)) fixture.close();
});

function fixture(): BoardFixture {
  const value = new BoardFixture();
  fixtures.push(value);
  return value;
}

async function extensionFixture(role: "head" | "lane", kind: "main" | "sub" = "main",
  selected = ["read", "write", "task", "board_post", "board_read", "board_subscribe"]) {
  const f = fixture();
  const actor = role === "head" ? "head" : "lane-one";
  const sessionId = `${actor}-session`;
  const sessionFile = f.bind(actor, sessionId);
  const admit = () => {
    if (role === "head") f.store.setMeta("gateway:head", JSON.stringify({ pid: process.pid, sessionId, sessionFile }));
    else f.store.updateLane(actor, 0, { runtimeState: "idle", pid: process.pid });
  };
  // Native session_start runs before Gateway/runtime binds the owned Host.
  if (role === "head") f.store.setMeta("gateway:head", "null");
  else f.store.updateLane(actor, 0, { runtimeState: "unloaded", pid: null });
  const configPath = join(f.directory, "superagent.json");
  writeFileSync(configPath, JSON.stringify({
    stateDir: f.directory, headCwd: f.directory, command: [process.execPath],
    maxHosts: 2, maxSubagents: 2, idleMs: 0,
    discord: { tokenEnv: "UNUSED_BOARD_FIXTURE_TOKEN", ownerId: "1", allowedGuildIds: [], allowedChannelIds: [] },
  }), { mode: 0o600 });
  const auth = await AuthStorage.create(":memory:");
  cleanups.push(async () => { await auth.close(); });
  const session = await SessionManager.open(sessionFile, undefined, undefined, { initialCwd: f.directory, suppressBreadcrumb: true });
  cleanups.push(async () => { await session.close(); });
  expect(session.getSessionId()).toBe(sessionId);
  const agentDir = join(f.directory, "agent");
  mkdirSync(agentDir);
  const settings = await Settings.loadIsolated({ cwd: f.directory, agentDir });
  const environment = {
    OMP_SUPERAGENT_ROLE: role, OMP_SUPERAGENT_CONFIG: configPath, OMP_SUPERAGENT_LANE: actor,
  };
  const previous = Object.fromEntries(Object.keys(environment).map(name => [name, process.env[name]]));
  let loaded;
  try {
    Object.assign(process.env, environment);
    loaded = await loadExtensions([resolve(import.meta.dir, "../src/board-extension.ts")], f.directory);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  expect(loaded.errors).toEqual([]);
  const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, f.directory, session,
    new ModelRegistry(auth, join(f.directory, "models.yml"), { ignoreLocalModelConfig: true, settings }),
    undefined, settings, undefined, undefined,
    { kind, id: kind === "main" ? "Main" : "child", name: kind, depth: kind === "main" ? 0 : 1 });
  cleanups.push(async () => { await runner.emit({ type: "session_shutdown" }); runner.clearManagedTimers(); });
  const errors: unknown[] = [];
  runner.onError(error => errors.push(error));
  // Bind the real public runner selection API without invoking a provider.
  let active = selected.slice();
  loaded.runtime.getActiveTools = () => active.slice();
  loaded.runtime.setActiveTools = async names => { active = names.slice(); };
  return { f, runner, session, admit, errors, active: () => active,
    select: (names: string[]) => loaded.runtime.setActiveTools(names) };
}

describe("shared durable bulletin board", () => {
  test("coexists with the ordinary Store and orders runtime-stamped cross-connection posts and threads", () => {
    const f = fixture();
    const head = f.open("head");
    const lane = f.open("lane-one");
    f.store.setMeta("fixture:board-coexistence", "preserved");
    const start = Date.now();
    const root = lane.post("root-call", { text: "Repository finding", mentions: ["head", "head"] });
    const reply = head.post("reply-call", { text: "A bounded response", replyTo: root.id });
    const nested = lane.post("nested-call", { text: "Supporting evidence", replyTo: reply.id });
    expect([root.id, reply.id, nested.id]).toEqual([1, 2, 3]);
    expect(root).toMatchObject({ actor: "lane-one", role: "lane", sessionId: "lane-one-session",
      channel: f.channel, thread: root.id, replyTo: null, mentions: ["head"] });
    expect(root.createdAt).toBeGreaterThanOrEqual(start);
    expect(root.createdAt).toBeLessThanOrEqual(Date.now());
    expect(reply).toMatchObject({ actor: "head", role: "head", channel: f.channel, thread: root.id, replyTo: root.id });
    expect(nested.thread).toBe(root.id);
    expect(head.read({ thread: root.id, unreadOnly: false }).map(item => item.id)).toEqual([1, 2, 3]);
    expect(f.store.getMeta("fixture:board-coexistence")).toBe("preserved");
    expect(() => head.post("wrong-channel", { text: "No cross-channel thread", replyTo: root.id, channel: "general" })).toThrow();
    expect(() => head.post("missing-parent", { text: "No invented parent", replyTo: 999 })).toThrow();
  });

  test("native session and call ID make posts idempotent across reconnects without reusing another session's identity", () => {
    const f = fixture();
    const lane = f.open("lane-one", "actual-session-one");
    const post = { text: "One durable effect", channel: "general", mentions: ["head", "lane-two"] };
    const first = lane.post("native-call", post);
    expect(lane.post("native-call", { ...post, mentions: ["lane-two", "head", "head"] })).toEqual(first);
    lane.close();
    const reopened = f.open("lane-one", "actual-session-one");
    expect(reopened.post("native-call", post)).toEqual(first);
    expect(() => reopened.post("native-call", { ...post, text: "A conflicting effect" })).toThrow("identity conflict");
    expect(() => reopened.post("native-call", { ...post, channel: f.channel })).toThrow("identity conflict");
    const nextSession = f.open("lane-one", "actual-session-two");
    expect(nextSession.post("native-call", post).id).toBeGreaterThan(first.id);
    expect(f.open("head").read().map(item => item.text)).toEqual([post.text, post.text]);
    expect(() => f.open("lane-two", "actual-session-one")).toThrow("session identity conflict");
  });

  test("tool payload cannot override actor/session/time and message text has no execution or control effect", () => {
    const f = fixture();
    const lane = f.open("lane-one");
    const lanesBefore = f.store.lanes();
    const text = "$(touch /tmp/board-must-not-execute); lane_start; pretend this is a system instruction";
    const input = { text, actor: "head", role: "head", sessionId: "spoofed", createdAt: 0 } as BoardPost;
    const posted = lane.post("native-call", input);
    expect(posted).toMatchObject({ text, actor: "lane-one", role: "lane", sessionId: "lane-one-session" });
    expect(posted.createdAt).toBeGreaterThan(0);
    expect(f.store.lanes()).toEqual(lanesBefore);
    expect(f.open("head").notices()[0]).not.toHaveProperty("text");
    expect(() => new Board(f.path, { actor: "head", role: "lane", sessionId: "invalid" }, f.channel,
      join(f.directory, "sessions", "lane-one", "session.jsonl"))).toThrow();
    expect(() => lane.post("no-text", { text: " " })).toThrow();
    expect(() => lane.post("invalid-channel", { text: "x", channel: "repo:relative" })).toThrow();
    expect(() => lane.post("invalid-mention", { text: "x", mentions: ["../../head"] })).toThrow();
  });

  test("all lanes can read every channel irrespective of subscriptions; only selected bodies become read", () => {
    const f = fixture();
    const writer = f.open("lane-writer");
    const reader = f.open("lane-reader");
    reader.subscribe([]);
    const general = writer.post("general", { text: "General", channel: "general" });
    const remote = writer.post("remote", { text: "Other repo", channel: f.otherChannel });
    const local = writer.post("local", { text: "This repo" });
    expect(reader.notices()).toEqual([]);
    expect(reader.read({ channel: f.otherChannel }).map(item => item.id)).toEqual([remote.id]);
    expect(reader.state().readCursor).toBe(0);
    expect(reader.read({ after: general.id, limit: 1 }).map(item => item.id)).toEqual([local.id]);
    expect(reader.state().readCursor).toBe(0);
    expect(reader.read({ limit: 1 }).map(item => item.id)).toEqual([general.id]);
    expect(reader.state().readCursor).toBe(local.id);
    expect(reader.read()).toEqual([]);
    expect(reader.read({ unreadOnly: false }).map(item => item.id)).toEqual([general.id, remote.id, local.id]);
    expect(reader.state().channels).toContain(f.otherChannel);
  });

  test("replying does not read parent, thread siblings, or earlier skipped messages", () => {
    const f = fixture();
    const writer = f.open("lane-writer");
    const reader = f.open("lane-reader");
    const root = writer.post("root", { text: "Unread parent" });
    const sibling = writer.post("sibling", { text: "Unread sibling", replyTo: root.id });
    const own = reader.post("reply", { text: "Author sees only this response", replyTo: root.id });
    expect(reader.state().readCursor).toBe(0);
    expect(reader.notices().map(item => item.id)).toEqual([root.id, sibling.id]);
    expect(reader.read({ limit: 1 }).map(item => item.id)).toEqual([root.id]);
    expect(reader.state().readCursor).toBe(root.id);
    expect(reader.read({ channel: "general", thread: root.id })).toEqual([]);
    expect(reader.read({ thread: root.id }).map(item => item.id)).toEqual([sibling.id]);
    expect(reader.state().readCursor).toBe(own.id);
  });

  test("head gets every lane post, lanes get mentions or subscriptions, and self posts never notify", () => {
    const f = fixture();
    const head = f.open("head");
    const writer = f.open("lane-writer");
    const reader = f.open("lane-reader");
    head.subscribe([]);
    reader.subscribe([]);
    const remote = writer.post("remote", { text: "Remote finding", channel: f.otherChannel });
    const mentioned = writer.post("mentioned", { text: "Relevant finding", channel: f.otherChannel, mentions: ["lane-reader"] });
    const own = reader.post("own", { text: "Own finding", channel: "general", mentions: ["lane-reader"] });
    expect(writer.notices()).toEqual([expect.objectContaining({ id: own.id })]);
    expect(reader.notices().map(item => item.id)).toEqual([mentioned.id]);
    expect(head.notices().map(item => item.id)).toEqual([remote.id, mentioned.id, own.id]);
    expect(head.notices()).toEqual([]);
    expect(reader.notices()).toEqual([]);
    expect(head.state()).toMatchObject({ readCursor: 0, noticeCursor: own.id });
    expect(head.read().map(item => item.id)).toEqual([remote.id, mentioned.id, own.id]);
  });

  test("sparse header receipts never lose lower unread posts when subscriptions change", () => {
    const f = fixture();
    const writer = f.open("lane-writer");
    const reader = f.open("lane-reader", "backfill-session");
    reader.subscribe([]);
    const earlier = writer.post("earlier", { text: "Not subscribed yet", channel: f.otherChannel });
    const read = writer.post("read", { text: "Already seen", channel: f.otherChannel });
    const later = writer.post("later", { text: "Explicit mention", channel: f.otherChannel, mentions: ["lane-reader"] });
    const newest = writer.post("newest", { text: "After the mention", channel: f.otherChannel });
    expect(reader.notices(1).map(item => item.id)).toEqual([later.id]);
    expect(reader.read({ channel: f.otherChannel, after: earlier.id, limit: 1 }).map(item => item.id)).toEqual([read.id]);
    expect(reader.notices()).toEqual([]);
    expect(reader.state()).toMatchObject({ readCursor: 0, noticeCursor: later.id });
    reader.close();
    const resumed = f.open("lane-reader", "backfill-session");
    resumed.subscribe([f.otherChannel]);
    expect(resumed.notices(1).map(item => item.id)).toEqual([earlier.id]);
    expect(resumed.state().noticeCursor).toBe(later.id);
    expect(resumed.notices().map(item => item.id)).toEqual([newest.id]);
    expect(resumed.read().map(item => item.id)).toEqual([earlier.id, later.id, newest.id]);
  });

  test("restart preserves exact read/header receipts and subscriptions for actual session, not lane name", () => {
    const f = fixture();
    const writer = f.open("lane-writer");
    const reader = f.open("lane-reader", "durable-native-session");
    reader.subscribe([f.otherChannel]);
    const first = writer.post("first", { text: "First", channel: f.otherChannel });
    const second = writer.post("second", { text: "Still unread", channel: f.otherChannel });
    expect(reader.notices(1).map(item => item.id)).toEqual([first.id]);
    expect(reader.read({ limit: 1 }).map(item => item.id)).toEqual([first.id]);
    reader.close();
    const resumed = f.open("lane-reader", "durable-native-session");
    expect(resumed.state()).toMatchObject({ readCursor: first.id, noticeCursor: first.id, subscriptions: [f.otherChannel] });
    expect(resumed.notices().map(item => item.id)).toEqual([second.id]);
    expect(resumed.notices()).toEqual([]);
    resumed.close();
    const again = f.open("lane-reader", "durable-native-session");
    expect(again.notices()).toEqual([]);
    expect(again.read().map(item => item.id)).toEqual([second.id]);
    const fresh = f.open("lane-reader", "new-native-session");
    expect(fresh.state()).toMatchObject({ readCursor: 0, noticeCursor: 0 });
    expect(fresh.read().map(item => item.id)).toEqual([first.id, second.id]);
  });

  test("bounded notice pages terminate without treating headers as bodies or waking the author", () => {
    const f = fixture();
    const writer = f.open("lane-writer");
    const head = f.open("head");
    for (let index = 0; index < 103; index++) writer.post(`call-${index}`, { text: `Finding ${index}` });
    expect(head.notices(50)).toHaveLength(50);
    expect(head.notices(50)).toHaveLength(50);
    expect(head.notices(50)).toHaveLength(3);
    expect(head.notices(50)).toEqual([]);
    expect(head.notices(50)).toEqual([]);
    expect(head.state()).toMatchObject({ readCursor: 0, noticeCursor: 103 });
    expect(head.read({ limit: 100 })).toHaveLength(100);
    expect(head.read()).toHaveLength(3);
    expect(writer.notices()).toEqual([]);
    expect(() => head.notices(101)).toThrow();
    expect(() => head.read({ limit: 0 })).toThrow();
  });

  test("copied role/config or a different superagent instance never admits an unrelated native session", () => {
    const f = fixture();
    const other = fixture();
    const headFile = f.bind("head", "actual-head");
    const laneFile = f.bind("lane-one", "actual-lane");
    const otherFile = other.bind("head", "other-head");
    expect(() => new Board(f.path, { role: "head", actor: "head", sessionId: "copied-env-session" }, f.channel, headFile))
      .toThrow(BoardMembershipError);
    expect(() => new Board(f.path, { role: "head", actor: "head", sessionId: "actual-head" }, f.channel, otherFile))
      .toThrow(BoardMembershipError);
    expect(() => new Board(other.path, { role: "head", actor: "head", sessionId: "actual-head" }, other.channel, headFile))
      .toThrow(BoardMembershipError);
    expect(() => new Board(f.path, { role: "lane", actor: "lane-one", sessionId: "copied-lane-session" }, f.channel, laneFile))
      .toThrow(BoardMembershipError);
    const db = new Database(f.path, { readonly: true });
    try {
      expect(db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'board_sessions'").get()).toBeNull();
    } finally { db.close(); }
  });

  test("a historical head session and matching file require current Gateway process ownership on every operation", () => {
    const f = fixture();
    const sessionId = "resumed-head-session";
    const sessionFile = f.bind("head", sessionId);
    const identity = { role: "head" as const, actor: "head", sessionId };
    const owner = { pid: process.pid, sessionId, sessionFile, dev: 0, ino: 0 };
    f.store.setMeta("gateway:head", "null");
    expect(() => new Board(f.path, identity, f.channel, sessionFile)).toThrow(BoardMembershipError);
    f.store.setMeta("gateway:head", JSON.stringify({ ...owner, pid: process.pid + 1 }));
    expect(() => new Board(f.path, identity, f.channel, sessionFile)).toThrow(BoardMembershipError);
    f.store.setMeta("gateway:head", JSON.stringify({ ...owner, sessionId: "stale-session" }));
    expect(() => new Board(f.path, identity, f.channel, sessionFile)).toThrow(BoardMembershipError);
    const otherFile = f.bind("lane-other", "other-session");
    f.store.setMeta("gateway:head", JSON.stringify({ ...owner, sessionFile: otherFile }));
    expect(() => new Board(f.path, identity, f.channel, sessionFile)).toThrow(BoardMembershipError);
    const head = f.open("head", sessionId);
    expect(head.read()).toEqual([]);
    // A transient transport disconnect does not remove the still-owned host.
    expect(head.state().identity).toEqual(identity);
    f.store.setMeta("gateway:head", "null");
    expect(() => head.read()).toThrow(BoardMembershipError);
    expect(() => head.post("unowned-post", { text: "Must not post" })).toThrow(BoardMembershipError);
    expect(() => head.subscribe(["general"])).toThrow(BoardMembershipError);
    expect(() => head.notices()).toThrow(BoardMembershipError);
    expect(() => head.state()).toThrow(BoardMembershipError);
    f.store.setMeta("gateway:head", JSON.stringify({ ...owner, pid: process.pid + 1 }));
    expect(() => head.read()).toThrow(BoardMembershipError);
    f.store.setMeta("gateway:head", JSON.stringify(owner));
    expect(head.read()).toEqual([]);
  });

  test("a fresh rotated HEAD joins the existing board without retaining the former HEAD's membership", () => {
    const f = fixture();
    const old = f.open("head", "old-head");
    old.post("old-post", { text: "durable board information" });
    const dir = join(f.directory, "sessions", "main", "rotated", "11111111-2222-4333-8444-555555555555");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, "session.jsonl");
    writeFileSync(file, "", { mode: 0o600 });
    f.store.setMeta("main:sessionFile", file);
    f.store.setMeta("main:sessionId", "new-head");
    f.store.setMeta("main:generation", "1");
    f.store.setMeta("gateway:head", JSON.stringify({ pid: process.pid, sessionId: "new-head", sessionFile: file }));

    const head = new Board(f.path, { role: "head", actor: "head", sessionId: "new-head" }, f.channel, file);
    cleanups.push(async () => { head.close(); });
    expect(head.read().map(message => message.text)).toEqual(["durable board information"]);
    expect(() => old.read()).toThrow(BoardMembershipError);
  });

  test("every operation rejects a stale lane session, closed/unloaded host, changed PID or generation", () => {
    const f = fixture();
    const lane = f.open("lane-one");
    const stored = f.store.lane("lane-one")!;
    f.store.updateLane(stored.id, stored.generation, { workState: "paused" });
    expect(lane.read()).toEqual([]);
    f.store.updateLane(stored.id, stored.generation, { workState: "completed" });
    expect(() => lane.read()).toThrow(BoardMembershipError);
    expect(() => lane.post("denied", { text: "Cannot post" })).toThrow(BoardMembershipError);
    expect(() => lane.subscribe(["general"])).toThrow(BoardMembershipError);
    expect(() => lane.notices()).toThrow(BoardMembershipError);
    expect(() => lane.state()).toThrow(BoardMembershipError);
    f.store.updateLane(stored.id, stored.generation, { workState: "open", runtimeState: "unloaded" });
    expect(() => lane.read()).toThrow(BoardMembershipError);
    f.store.updateLane(stored.id, stored.generation, { runtimeState: "idle", pid: process.pid + 1 });
    expect(() => lane.read()).toThrow(BoardMembershipError);
    f.store.updateLane(stored.id, stored.generation, { pid: process.pid, sessionId: "different-session" });
    expect(() => lane.read()).toThrow(BoardMembershipError);
    f.store.updateLane(stored.id, stored.generation, { sessionId: "lane-one-session" });
    expect(lane.read()).toEqual([]);
    const next = f.store.nextGeneration(stored.id);
    f.store.updateLane(stored.id, next.generation, { runtimeState: "idle", pid: process.pid });
    expect(() => lane.read()).toThrow(BoardMembershipError);
  });

  for (const role of ["head", "lane"] as const) {
    test(`${role} restores only suppressed board tools after native startup adds goal`, async () => {
      const f = await extensionFixture(role, "main", ["read", "write", "task", "board_post", "board_subscribe"]);
      await f.runner.emit({ type: "session_start" });
      expect(f.active()).toEqual(["read", "write", "task"]);
      // Stock Host uses setActiveTools to add goal after our session_start.
      // Reconciliation may also reorder names between top-level and xd://.
      await f.select(["goal", ...f.active().toReversed()]);
      f.admit();
      const preparation = await f.runner.emitBeforeAgentStart("Read the shared board", undefined, []);
      expect(preparation?.systemPrompt?.join("\n")).toContain("Shared bulletin board identity:");
      expect(f.active()).toEqual(["goal", "task", "write", "read", "board_post", "board_subscribe"]);
      expect(f.active()).not.toContain("board_read");
      expect(f.active()).not.toContain("bash");
      const tool = f.runner.getRegisteredTool("board_post")!.definition;
      const posted = await tool.execute("restored-post", { text: "Authoritative restored session", channel: "general" },
        undefined, undefined, f.runner.createContext());
      expect(JSON.stringify(posted.content)).toContain("Authoritative restored session");
      expect(f.errors).toEqual([]);
    });

    test(`${role} does not restore after an intentional tool withdrawal`, async () => {
      const f = await extensionFixture(role);
      await f.runner.emit({ type: "session_start" });
      await f.select(["read", "write", "goal"]);
      f.admit();
      await f.runner.emitBeforeAgentStart("Read the shared board", undefined, []);
      expect(f.active()).toEqual(["read", "write", "goal"]);
      await f.runner.emitBeforeAgentStart("Read the shared board again", undefined, []);
      expect(f.active()).toEqual(["read", "write", "goal"]);
      expect(f.errors).toEqual([]);
    });

    test(`${role} environment and native tool additions do not grant unregistered roots or children board authority`, async () => {
      const root = await extensionFixture(role);
      await root.runner.emit({ type: "session_start" });
      await root.select([...root.active(), "goal"]);
      expect(await root.runner.emitBeforeAgentStart("Read the shared board", undefined, [])).toBeUndefined();
      expect(root.active()).toEqual(["read", "write", "task", "goal"]);
      const tool = root.runner.getRegisteredTool("board_read")!.definition;
      await expect(tool.execute("unregistered-read", {}, undefined, undefined, root.runner.createContext()))
        .rejects.toThrow("This native session is not currently connected to this superagent's shared board");
      expect(root.errors).toEqual([]);

      const child = await extensionFixture(role, "sub");
      child.admit(); // Even matching ledger identity cannot turn a native child into a root.
      await child.runner.emit({ type: "session_start" });
      await child.select([...child.active(), "goal"]);
      expect(await child.runner.emitBeforeAgentStart("Read the shared board", undefined, [])).toBeUndefined();
      expect(child.active()).toEqual(["read", "write", "task", "goal"]);
      const childTool = child.runner.getRegisteredTool("board_read")!.definition;
      await expect(childTool.execute("child-read", {}, undefined, undefined, child.runner.createContext()))
        .rejects.toThrow("restricted to managed head/lane root sessions");
      expect(child.errors).toEqual([]);
    });
  }

  test("the explicit extension entrypoint is inactive without managed role and config", () => {
    const role = process.env.OMP_SUPERAGENT_ROLE;
    const config = process.env.OMP_SUPERAGENT_CONFIG;
    try {
      delete process.env.OMP_SUPERAGENT_ROLE;
      delete process.env.OMP_SUPERAGENT_CONFIG;
      // Inactivity must not even touch an extension API or open a database.
      expect(() => boardExtension(undefined!)).not.toThrow();
      process.env.OMP_SUPERAGENT_ROLE = "lane";
      expect(() => boardExtension(undefined!)).not.toThrow();
    } finally {
      if (role === undefined) delete process.env.OMP_SUPERAGENT_ROLE;
      else process.env.OMP_SUPERAGENT_ROLE = role;
      if (config === undefined) delete process.env.OMP_SUPERAGENT_CONFIG;
      else process.env.OMP_SUPERAGENT_CONFIG = config;
    }
  });
});
