import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, Collection, type ClientUser, type Message } from "discord.js";
import { physicalRouteKey, routeKey, type Approval, type Inbound, type Lane, type LaneModel, type Route } from "../src/contracts.ts";
import { DiscordMessenger } from "../src/discord.ts";
import { Store } from "../src/store.ts";

const stores: Store[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function open(path: string): Store {
  const store = new Store(path);
  stores.push(store);
  return store;
}
function fixture(): { store: Store; path: string; directory: string } {
  const directory = mkdtempSync(join(tmpdir(), "omp-superagent-store-"));
  directories.push(directory);
  const path = join(directory, "coordination.sqlite");
  return { store: open(path), path, directory };
}
function route(patch: Partial<Route> = {}): Route {
  return {
    platform: "discord", accountId: "account", authorityId: "owner", guildId: "guild",
    channelId: "channel", threadId: "thread", ...patch,
  };
}
function inbound(id: string, destination = route()): Inbound {
  return { id, route: destination, messageId: `message-${id}`, text: `request ${id}`, receivedAt: 100, attachments: [] };
}
type SelectedLane = Lane & { model: LaneModel; modelReason: string };
function lane(id = "lane", destination = route(), patch: Partial<SelectedLane> = {}): SelectedLane {
  return {
    id, route: destination, title: "A bounded task", cwd: "/workspace/repo", repoRoot: "/workspace/repo",
    model: { provider: "fixture", id: "capable" }, modelReason: "Native judge selected this model for the task.",
    modelPreset: null,
    modelPresetSnapshot: null,
    brief: "Use this isolated conversation", acceptance: ["Verified result"], workState: "open",
    runtimeState: "unloaded", sessionFile: `/sessions/${id}.jsonl`, sessionId: null,
    socketPath: `/sockets/${id}.sock`, generation: 0, pid: null, createdAt: 100,
    lastActivityAt: 100, result: null, ...patch,
  };
}
function admitLane(store: Store, id = "lane", destination = route()): Lane {
  store.receive(inbound(`source-${id}`, destination), null);
  return store.createLane(lane(id, destination), `source-${id}`);
}
function approval(id = "approval", target = "lane", generation = 0): Approval {
  return {
    id, target, generation, requestId: "native-dialog", route: route(),
    request: { method: "confirm", title: "Allow action?" }, state: "pending", remoteId: null,
  };
}
function storedOutput(path: string, id: string): { state: string; remote_id: string | null } | null {
  const db = new Database(path, { readonly: true });
  try {
    return db.query("SELECT state, remote_id FROM outputs WHERE id = ?").get(id) as {
      state: string; remote_id: string | null;
    } | null;
  } finally {
    db.close();
  }
}

describe("durable coordination store", () => {
  test("workflow choices commit atomically with original source and exact immutable handoff", () => {
    const { store, path } = fixture();
    const managed = admitLane(store);
    const original = { ...inbound("workflow-source", route({ threadId: "source-thread" })), text: "Inspect the authorized repository" };
    store.receive(original, "main", { [`user-source:${original.id}`]: "true" });
    const handoff = { ...original, id: "workflow-handoff", route: managed.route, text: "Inspect just this bounded part" };
    const workflow = { name: "ulw-plan" as const, reason: "Planning is needed for this authorized task", sourceId: original.id, provenance: "head" as const };
    const metadata = { [`handoff-source:${handoff.id}`]: original.id };
    expect(store.receive(handoff, managed.id, metadata, workflow)).toBe(true);
    expect(store.receive(handoff, managed.id, metadata, workflow)).toBe(false);
    for (const changed of [null, { ...workflow, name: "ulw-loop" as const }, { ...workflow, reason: "A different choice" },
      { ...workflow, sourceId: "foreign" }, { ...workflow, provenance: "user" as const }]) {
      expect(() => store.receive(handoff, managed.id, metadata, changed)).toThrow("Workflow identity conflict");
    }
    workflow.reason = "Caller mutation after admission";
    expect(store.input(handoff.id)?.workflow?.reason).toBe("Planning is needed for this authorized task");
    expect(store.input(original.id)).toMatchObject({ ...original, workflow: null, target: "main", state: "pending" });
    store.close();
    const reopened = open(path);
    expect(reopened.input(handoff.id)).toMatchObject({ route: managed.route, workflow: {
      name: "ulw-plan", sourceId: original.id, provenance: "head", reason: "Planning is needed for this authorized task",
    } });
    expect(reopened.input(original.id)?.text).toBe(original.text);
  });

  test("reports and inbound object properties do not acquire workflow authority", () => {
    const { store } = fixture();
    const managed = admitLane(store);
    const source = inbound("actual-user");
    const workflow = { name: "ulw-loop" as const, sourceId: source.id, reason: "Original invocation", provenance: "user" as const };
    store.receive(source, "main", { [`user-source:${source.id}`]: "true" }, workflow);
    const copied = { ...source, id: "copied", workflow };
    store.receive(copied, managed.id);
    expect(store.input(copied.id)?.workflow).toBeNull();
    store.settle(copied.id, "done", { id: "result", text: "ulw-loop orchestrate report prose" });
    expect(store.input(`report:${copied.id}`)?.workflow).toBeNull();
    expect(() => store.receive(inbound("internal-selection"), managed.id, {
      "handoff-source:internal-selection": `report:${copied.id}`,
    }, { ...workflow, sourceId: `report:${copied.id}`, provenance: "head" })).toThrow("original user source");
    expect(store.input("internal-selection")).toBeNull();
  });

  test("cancelled original sources and mismatched handoffs cannot admit selected workflow work", () => {
    const { store } = fixture();
    const managed = admitLane(store);
    const source = inbound("cancelled-source");
    store.receive(source, "main", { [`user-source:${source.id}`]: "true" });
    const workflow = { name: "ulw-plan" as const, sourceId: source.id, reason: "Bounded planning", provenance: "head" as const };
    expect(() => store.receive(inbound("wrong-handoff"), managed.id, { "handoff-source:wrong-handoff": "other" }, workflow)).toThrow("exact handoff");
    store.settle(source.id, "cancelled");
    expect(() => store.receive(inbound("cancelled-handoff"), managed.id, { "handoff-source:cancelled-handoff": source.id }, workflow)).toThrow("uncancelled");
    expect(store.input("wrong-handoff")).toBeNull();
    expect(store.input("cancelled-handoff")).toBeNull();
  });

  test("logical DM topics share transport but never lane, request, or approval identity", () => {
    const { store } = fixture();
    const physical = route({ guildId: null, threadId: null });
    const one = { ...physical, topicId: "topic-one" };
    const two = { ...physical, topicId: "topic-two" };
    expect(physicalRouteKey(one)).toBe(routeKey(physical));
    expect(physicalRouteKey(two)).toBe(routeKey(physical));
    expect(routeKey(one)).not.toBe(routeKey(two));
    expect(routeKey(physical)).toBe(JSON.stringify([
      physical.platform, physical.accountId, physical.authorityId, physical.guildId, physical.channelId, physical.threadId,
    ]));
    admitLane(store, "one", one);
    admitLane(store, "two", two);
    expect(store.laneForRoute(one)?.id).toBe("one");
    expect(store.laneForRoute(two)?.id).toBe("two");
    expect(store.laneForRoute(physical)).toBeNull();
    store.receive(inbound("follow", one), "one");
    expect(() => store.bindInput("follow", "two")).toThrow();
    store.putApproval({ ...approval("one-card", "one"), route: one });
    expect(() => store.putApproval({ ...approval("one-card", "one"), route: two })).toThrow("identity conflict");
  });

  test("intake and topic metadata commit together and duplicate events cannot change the active topic", () => {
    const { store, path } = fixture();
    const input = inbound("boundary", route({ guildId: null, threadId: null, topicId: "first" }));
    expect(store.receive(input, null, { "dm:active": "first" })).toBe(true);
    expect(store.receive(input, null, { "dm:active": "second" })).toBe(false);
    expect(store.getMeta("dm:active")).toBe("first");
    expect(() => store.receive(inbound("invalid"), "unknown", { "dm:active": "wrong" })).toThrow();
    expect(store.input("invalid")).toBeNull();
    expect(store.getMeta("dm:active")).toBe("first");
    expect(() => store.receive(inbound("rollback"), null, {
      "dm:active": "wrong", "invalid-value": null as unknown as string,
    })).toThrow();
    expect(store.input("rollback")).toBeNull();
    expect(store.getMeta("dm:active")).toBe("first");
    store.close();
    const reopened = open(path);
    expect(reopened.input("boundary")?.route.topicId).toBe("first");
    expect(reopened.getMeta("dm:active")).toBe("first");
  });

  test("concurrent admission persists one immutable request and preserves ordering", async () => {
    const { store, path } = fixture();
    const input = inbound("one");
    const results = await Promise.all(Array.from({ length: 16 }, () => Promise.resolve().then(() => store.receive(input, null))));
    expect(results.filter(Boolean)).toHaveLength(1);
    store.receive(inbound("two"), "main");
    expect(store.inputs().map(input => input.id)).toEqual(["one", "two"]);
    expect(() => store.receive({ ...input, text: "changed" }, null)).toThrow("identity conflict");
    expect(() => store.receive({ ...input, route: route({ authorityId: "other" }) }, null)).toThrow("identity conflict");
    expect(() => store.receive({ ...input, attachments: [{ id: "a", name: "a", url: "https://example.test/a", size: 1 }] }, null))
      .toThrow("identity conflict");
    store.close();
    const reopened = open(path);
    expect(reopened.receive(input, "main")).toBe(false);
    expect(reopened.input("one")?.target).toBeNull();
    expect(reopened.getMeta("missing")).toBeNull();
    reopened.setMeta("cursor", "event-1");
    reopened.setMeta("cursor", "event-2");
    reopened.close();
    expect(open(path).getMeta("cursor")).toBe("event-2");
  });

  test("normalized Discord signature refresh replays update only pending attachment URLs", async () => {
    const { store, path } = fixture();
    const client = new Client({ intents: [] });
    client.user = { id: "2" } as ClientUser;
    const messenger = new DiscordMessenger({ token: "unused", ownerId: "1", allowedGuildIds: ["3"], allowedChannelIds: ["4"], client });
    const attachment = { id: "77", name: "notes.txt", size: 12, contentType: "text/plain" };
    const originalUrl = "https://cdn.discordapp.com/attachments/10/77/notes.txt?ex=100&is=10&hm=original";
    const refreshedUrl = "https://cdn.discordapp.com/attachments/10/77/notes.txt?ex=200&is=20&hm=refreshed";
    const laterUrl = "https://cdn.discordapp.com/attachments/10/77/notes.txt?ex=300&is=30&hm=later";
    const message = {
      id: "100", author: { id: "1", bot: false }, webhookId: null, type: 0, content: "Review attached notes",
      channel: { id: "10", guildId: "3", parentId: "4", isThread: () => true },
      editedTimestamp: 2000, createdTimestamp: 1000,
      attachments: new Collection([[attachment.id, { ...attachment, url: originalUrl }]]),
    } as unknown as Message;
    try {
      const original = messenger.normalize(message)!;
      expect(original.attachments).toEqual([{ ...attachment, url: originalUrl }]);
      const replay = messenger.normalize({ ...message, attachments: new Collection([[attachment.id, { ...attachment, url: refreshedUrl }]]) } as Message)!;
      expect(replay.id).toBe(original.id);
      expect(store.receive(original, "main")).toBe(true);
      expect(store.receive(replay, null)).toBe(false);
      expect(store.input(original.id)).toEqual({ ...replay, workflow: null, target: "main", state: "pending", requestId: null, generation: null });
      expect(store.inputs()).toHaveLength(1);
      expect(store.submit(original.id, "native", 0)).toBe(true);
      const afterSubmit = messenger.normalize({ ...message, attachments: new Collection([[attachment.id, { ...attachment, url: laterUrl }]]) } as Message)!;
      expect(afterSubmit.id).toBe(original.id);
      expect(store.receive(afterSubmit, null)).toBe(false);
      expect(store.input(original.id)).toMatchObject({ target: "main", state: "submitted", requestId: "native", generation: 0, attachments: [{ ...attachment, url: refreshedUrl }] });
      store.close();
      expect(open(path).input(original.id)?.attachments[0]?.url).toBe(refreshedUrl);
    } finally { await messenger.stop(); }
  });

  test("attachment replay preserves stable metadata and rejects all non-signature URL changes", () => {
    const { store } = fixture();
    const attachment = { id: "a", name: "a.txt", url: "https://cdn.discordapp.com/attachments/a?width=40&ex=100&hm=old", size: 3, contentType: "text/plain" };
    const input = { ...inbound("with-file"), attachments: [attachment] };
    store.receive(input, "main");
    for (const patch of [
      { id: "other" }, { name: "changed.txt" }, { size: 4 }, { contentType: "application/json" },
      { url: "https://cdn.discordapp.com/attachments/other?width=40&ex=200&hm=new" },
      { url: "https://cdn.discordapp.com/attachments/a?width=41&ex=200&hm=new" },
      { url: "https://media.discordapp.net/attachments/a?width=40&ex=200&hm=new" },
      { url: "https://evil.example/attachments/a?width=40&ex=200&hm=new" },
    ]) expect(() => store.receive({ ...input, attachments: [{ ...attachment, ...patch }] }, null)).toThrow("identity conflict");
    expect(() => store.receive({ ...input, text: "changed", attachments: [{ ...attachment, url: attachment.url.replace("hm=old", "hm=new") }] }, null)).toThrow("identity conflict");
    expect(() => store.receive({ ...input, route: route({ threadId: "foreign" }), attachments: [{ ...attachment, url: attachment.url.replace("hm=old", "hm=new") }] }, null)).toThrow("identity conflict");
    expect(store.input(input.id)?.attachments).toEqual([attachment]);
    const other = { id: "b", name: "b.txt", url: "https://cdn.discordapp.com/attachments/b?hm=old", size: 4 };
    const ordered = { ...inbound("two-files"), attachments: [attachment, other] };
    store.receive(ordered, "main");
    expect(store.receive({ ...ordered, attachments: [{ ...other, url: other.url.replace("hm=old", "hm=new") }, attachment] }, null)).toBe(false);
    expect(store.input(ordered.id)?.attachments.map(file => file.id)).toEqual(["a", "b"]);
    expect(store.input(ordered.id)?.attachments[1]?.url).toContain("hm=new");
  });

  test("submitted and terminal input replays retain the exact accepted attachment payload", () => {
    const { store } = fixture();
    for (const state of ["submitted", "uncertain", "done", "cancelled"] as const) {
      const attachment = { id: "a", name: "a.txt", url: "https://cdn.discordapp.com/attachments/a?ex=100&hm=old", size: 3 };
      const input = { ...inbound(`file-${state}`), attachments: [attachment] };
      store.receive(input, "main");
      expect(store.submit(input.id, `native-${state}`, 0)).toBe(true);
      if (state !== "submitted") store.settle(input.id, state);
      const before = store.input(input.id);
      expect(store.receive({ ...input, attachments: [{ ...attachment, url: attachment.url.replace("ex=100&hm=old", "ex=200&hm=new") }] }, null)).toBe(false);
      expect(store.input(input.id)).toEqual(before);
    }
    const external = { ...inbound("external"), attachments: [{ id: "a", name: "a", url: "https://example.test/a?hm=old", size: 3 }] };
    store.receive(external, "main");
    expect(() => store.receive({ ...external, attachments: [{ ...external.attachments[0]!, url: "https://example.test/a?hm=new" }] }, null)).toThrow("identity conflict");
  });

  test("lane creation and source binding are idempotent under repeated admission", async () => {
    const { store } = fixture();
    store.receive(inbound("source"), "main");
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => Promise.resolve().then(() =>
      store.createLane(lane(`candidate-${index}`), "source"))));
    expect(new Set(results.map(lane => lane.id)).size).toBe(1);
    expect(store.lanes()).toHaveLength(1);
    const selected = results[0]!;
    expect(store.input("source")?.target).toBe(selected.id);
    expect(store.submit("source", "request", 0)).toBe(true);
    expect(store.createLane(lane("another", route(), { title: "Do not overwrite" }), "source")).toEqual(selected);
    expect(store.receive(inbound("source"), null)).toBe(false);
    expect(store.input("source")?.state).toBe("submitted");
    expect(store.input("source")?.target).toBe(selected.id);
    expect(() => store.createLane(lane("another", route(), { cwd: "/unrelated" }), "source")).toThrow("different route or repository");
  });

  test("a chosen model and reason survive replays, route reuse, generations, and reopen", () => {
    const { store, path } = fixture();
    const selected = admitLane(store);
    expect(selected.modelReason).toBe("Native judge selected this model for the task.");
    expect(store.createLane(lane("replay", route(), { modelReason: "Do not replace the original reason" }), "source-lane"))
      .toMatchObject({ model: selected.model, modelReason: selected.modelReason });
    const different = { provider: "fixture", id: "efficient" };
    expect(() => store.createLane(lane("conflict", route(), { model: different }), "source-lane")).toThrow("different model");
    store.receive(inbound("new-source"), null);
    expect(() => store.createLane(lane("route-conflict", route(), { model: different }), "new-source")).toThrow("different model");
    expect(store.input("new-source")?.target).toBeNull();
    expect(store.updateLane(selected.id, 0, {
      model: different, modelReason: "Injected mutation", cwd: "/changed",
    } as unknown as Parameters<Store["updateLane"]>[2])).toBe(true);
    const next = store.nextGeneration(selected.id);
    expect(next).toMatchObject({ model: selected.model, modelReason: selected.modelReason, cwd: selected.cwd });
    expect(store.adoptLaneModel(selected.id, next.generation, different, "Cannot adopt a selected lane")).toBe(false);
    store.close();
    expect(open(path).lane(selected.id)).toMatchObject({ model: selected.model, modelReason: selected.modelReason, generation: 1 });
  });

  test("new lane creation cannot introduce legacy nulls or empty selection reasons", () => {
    const { store } = fixture();
    store.receive(inbound("source"), null);
    for (const patch of [
      { model: null, modelReason: null }, { modelReason: "  " },
      { model: { provider: "", id: "capable" } },
    ]) expect(() => store.createLane(lane("invalid", route(), patch as unknown as Partial<SelectedLane>), "source")).toThrow("requires an exact model");
    expect(store.lanes()).toEqual([]);
    expect(store.input("source")?.target).toBeNull();
  });

  test("old JSON normalizes only missing selection fields and adoption is generation-fenced exactly once", () => {
    const { store, path } = fixture();
    const original = admitLane(store);
    const { model: _model, modelReason: _reason, modelPreset: _preset, modelPresetSnapshot: _snapshot, ...legacy } = original;
    const db = new Database(path);
    try { db.query("UPDATE lanes SET data = ? WHERE id = ?").run(JSON.stringify(legacy), original.id); }
    finally { db.close(); }
    expect(store.lane(original.id)).toMatchObject({ model: null, modelReason: null });
    expect(store.laneForRoute(original.route)?.model).toBeNull();
    expect(store.lanes()[0]?.modelReason).toBeNull();
    const next = store.nextGeneration(original.id);
    const restored = { provider: "fixture", id: "restored-transcript-model" };
    expect(store.adoptLaneModel(original.id, 0, restored, "Stale native state")).toBe(false);
    expect(store.lane(original.id)?.model).toBeNull();
    expect(() => store.adoptLaneModel(original.id, next.generation, restored, " ")).toThrow("nonempty reason");
    expect(store.adoptLaneModel(original.id, next.generation, restored, "Legacy native transcript adoption, not judge-selected")).toBe(true);
    expect(store.adoptLaneModel(original.id, next.generation, original.model!, "Never replace the adopted selection")).toBe(false);
    store.close();
    expect(open(path).lane(original.id)).toMatchObject({
      model: restored, modelReason: "Legacy native transcript adoption, not judge-selected", generation: 1,
    });
  });

  test("explicit model CAS commits selection, preset snapshot, reason and receipts atomically", () => {
    const { store, path } = fixture();
    const original = admitLane(store);
    const chosen = { provider: "fixture", id: "efficient" };
    const snapshot = { modelRoles: { default: "fixture/efficient", smol: "fixture/capable" } };
    expect(store.changeLaneModel(original.id, 1, original.model, chosen, "Stale generation", "low", snapshot, { receipt: "stale" })).toBe(false);
    expect(store.changeLaneModel(original.id, 0, chosen, chosen, "Wrong previous identity", "low", snapshot, { receipt: "wrong" })).toBe(false);
    expect(store.getMeta("receipt")).toBeNull();
    expect(() => store.changeLaneModel(original.id, 0, original.model, chosen, "Rollback metadata failure", "low", snapshot, {
      receipt: "must-rollback", invalid: null as unknown as string,
    })).toThrow();
    expect(store.lane(original.id)?.model).toEqual(original.model);
    expect(store.getMeta("receipt")).toBeNull();
    expect(store.changeLaneModel(original.id, 0, original.model, chosen, "Explicit idle lane switch", "low", snapshot, { receipt: "committed", pending: "" })).toBe(true);
    expect(store.nextGeneration(original.id)).toMatchObject({ model: chosen, modelPreset: "low", modelPresetSnapshot: snapshot, modelReason: "Explicit idle lane switch", cwd: original.cwd });
    store.close();
    const reopened = open(path);
    expect(reopened.lane(original.id)).toMatchObject({ model: chosen, modelPreset: "low", modelPresetSnapshot: snapshot, modelReason: "Explicit idle lane switch" });
    expect(reopened.getMeta("receipt")).toBe("committed");
    expect(reopened.getMeta("pending")).toBe("");
  });

  test("explicit legacy selection uses a null-expected CAS without converting adoption into mutable control", () => {
    const { store, path } = fixture();
    const original = admitLane(store);
    const { model: _model, modelReason: _reason, modelPreset: _preset, modelPresetSnapshot: _snapshot, ...legacy } = original;
    const db = new Database(path);
    try { db.query("UPDATE lanes SET data = ? WHERE id = ?").run(JSON.stringify(legacy), original.id); }
    finally { db.close(); }
    const chosen = { provider: "fixture", id: "explicit-legacy-choice" };
    expect(store.changeLaneModel(original.id, 0, null, chosen, "Operator explicitly selected a legacy lane model", null, null)).toBe(true);
    expect(store.adoptLaneModel(original.id, 0, original.model!, "Never overwrite an explicit selection")).toBe(false);
    expect(store.changeLaneModel(original.id, 0, null, original.model!, "Stale legacy authority", null, null)).toBe(false);
    expect(store.lane(original.id)).toMatchObject({ model: chosen, modelPreset: null });
  });

  test("all route authority dimensions isolate conversations and cannot be reused across repositories", () => {
    const { store } = fixture();
    const routes = [
      route(), route({ accountId: "other" }), route({ authorityId: "other" }),
      route({ guildId: null }), route({ channelId: "other" }), route({ threadId: "other" }),
      route({ threadId: null }), route({ platform: "telegram" }), route({ platform: "slack" }),
    ];
    routes.forEach((destination, index) => admitLane(store, `lane-${index}`, destination));
    expect(store.lanes()).toHaveLength(routes.length);
    routes.forEach((destination, index) => expect(store.laneForRoute(destination)?.id).toBe(`lane-${index}`));
    store.receive(inbound("followup"), null);
    expect(() => store.createLane(lane("new-id", route(), { cwd: "/another-repo" }), "followup")).toThrow();
    expect(store.input("followup")?.target).toBeNull();
    expect(() => store.createLane(lane("lane-0", route({ threadId: "other" })), "source-lane-5")).toThrow("ID conflict");
    expect(() => store.receive(inbound("wrong-route", route({ accountId: "other" })), "lane-0")).toThrow("route mismatch");
    expect(store.input("wrong-route")).toBeNull();
  });

  test("identical native IDs on different platforms preserve immutable inputs reports and approval owners", () => {
    const { store, path } = fixture();
    for (const platform of ["discord", "telegram", "slack"] as const) {
      const destination = route({ platform });
      const id = `${platform}:same-message-id`;
      const input = { ...inbound(id, destination), messageId: "100" };
      store.receive(input, null);
      const owned = store.createLane(lane(platform, destination), id);
      expect(store.submit(id, "same-native-prompt-id", 0)).toBe(true);
      store.putApproval({ ...approval(`${platform}:card`, owned.id), route: destination });
      store.settle(id, "done", { id: `${id}:answer`, text: `${platform} answer` });
      expect(() => store.receive({ ...input, route: route({ platform: platform === "discord" ? "telegram" : "discord" }) }, "main")).toThrow("identity conflict");
    }
    store.close();
    const reopened = open(path);
    expect(reopened.lanes().map(value => value.route.platform)).toEqual(["discord", "telegram", "slack"]);
    expect(reopened.outputs()).toEqual([]);
    expect(reopened.inputs("main").map(value => [value.route.platform, value.id])).toEqual([
      ["discord", "report:discord:same-message-id"], ["telegram", "report:telegram:same-message-id"], ["slack", "report:slack:same-message-id"],
    ]);
    expect(reopened.input("report:telegram:same-message-id")?.text).toContain("telegram answer");
    expect(reopened.approvals().map(value => [value.route.platform, value.target])).toEqual([
      ["discord", "discord"], ["telegram", "telegram"], ["slack", "slack"],
    ]);
    expect(() => reopened.putApproval({ ...reopened.approval("telegram:card")!, route: route({ platform: "slack" }) })).toThrow("identity conflict");
  });

  test("opaque platform resources replay exactly and never inherit Discord signed-URL refresh rules", () => {
    const { store } = fixture();
    for (const platform of ["telegram", "slack"] as const) {
      const input = {
        ...inbound(`${platform}:opaque`, route({ platform })),
        attachments: [{ id: "file", name: "file", url: `${platform}-file:resource`, size: 1 }],
      };
      expect(store.receive(input, "main")).toBe(true);
      expect(store.receive(input, "main")).toBe(false);
      expect(() => store.receive({ ...input, attachments: [{ ...input.attachments[0]!, url: `${platform}-file:other` }] }, "main")).toThrow("identity conflict");
      const cdn = {
        ...inbound(`${platform}:cdn`, route({ platform })),
        attachments: [{ id: "file", name: "file", url: "https://cdn.discordapp.com/attachments/a?ex=1&hm=old", size: 1 }],
      };
      store.receive(cdn, "main");
      expect(() => store.receive({ ...cdn, attachments: [{ ...cdn.attachments[0]!, url: cdn.attachments[0]!.url.replace("hm=old", "hm=new") }] }, "main")).toThrow("identity conflict");
    }
  });

  test("only matching pending inputs can transfer from unassigned/main into a lane", () => {
    const { store } = fixture();
    admitLane(store);
    store.receive(inbound("unassigned"), null);
    store.bindInput("unassigned", "lane");
    store.bindInput("unassigned", "lane");
    expect(store.input("unassigned")?.target).toBe("lane");
    expect(store.submit("unassigned", "native-1", 0)).toBe(true);
    expect(() => store.bindInput("unassigned", "main")).toThrow("Cannot retarget submitted");
    store.receive(inbound("already-main"), "main");
    store.submit("already-main", "main-native", 0);
    expect(() => store.createLane(lane("candidate"), "already-main")).toThrow("not available");
    expect(store.input("already-main")?.target).toBe("main");
    store.receive(inbound("foreign", route({ threadId: "foreign" })), null);
    expect(() => store.bindInput("foreign", "lane")).toThrow("route mismatch");
    expect(() => store.createLane(lane("candidate"), "missing")).toThrow("Unknown input");
  });

  test("closed/cancelled lanes require explicit reopen and source replay never resets them", () => {
    const { store } = fixture();
    admitLane(store);
    for (const workState of ["paused", "completed", "cancelled"] as const) {
      store.updateLane("lane", 0, { workState, runtimeState: "idle", result: "preserve" });
      expect(store.createLane(lane("candidate"), "source-lane").workState).toBe(workState);
      store.receive(inbound(`followup-${workState}`), null);
      expect(() => store.createLane(lane("candidate"), `followup-${workState}`)).toThrow("explicit reopen");
      expect(store.input(`followup-${workState}`)?.target).toBeNull();
    }
    store.updateLane("lane", 0, { workState: "open" });
    const reopened = store.createLane(lane("candidate"), "followup-cancelled");
    expect(reopened.id).toBe("lane");
    expect(reopened.result).toBe("preserve");
    expect(reopened.runtimeState).toBe("idle");
  });

  test("generation fencing preserves workspace/session and work intent independently of runtime", () => {
    const { store } = fixture();
    const initial = admitLane(store);
    store.updateLane("lane", 0, { workState: "paused", runtimeState: "running", pid: 123, sessionId: "native-session" });
    const next = store.nextGeneration("lane");
    expect(next).toMatchObject({
      generation: 1, runtimeState: "starting", pid: null, workState: "paused",
      cwd: initial.cwd, sessionFile: initial.sessionFile, sessionId: "native-session",
    });
    expect(store.updateLane("lane", 0, { pid: 999, workState: "open" })).toBe(false);
    expect(store.submit("source-lane", "stale", 0)).toBe(false);
    expect(store.submit("source-lane", "held", 1)).toBe(false);
    expect(store.updateLane("lane", 1, { workState: "open", runtimeState: "idle" })).toBe(true);
    expect(store.submit("source-lane", "current", 1)).toBe(true);
    expect(store.submit("source-lane", "duplicate", 1)).toBe(false);
    expect(store.input("source-lane")?.requestId).toBe("current");
    expect(store.updateLane("lane", 1, { cwd: "/injected" } as unknown as Parameters<Store["updateLane"]>[2])).toBe(true);
    expect(store.lane("lane")?.cwd).toBe(initial.cwd);
  });

  test("intake exposure includes unresolved submissions and uncertainty but excludes terminal inputs", () => {
    const { store } = fixture();
    for (const id of ["pending", "submitted", "uncertain", "done", "cancelled"]) store.receive(inbound(id), "main");
    store.submit("submitted", "native-submitted", 1);
    store.submit("uncertain", "native-uncertain", 1);
    store.settle("uncertain", "uncertain");
    store.settle("done", "done");
    store.settle("cancelled", "cancelled");
    expect(store.inputs("main").map(input => [input.id, input.state])).toEqual([
      ["pending", "pending"], ["submitted", "submitted"], ["uncertain", "uncertain"],
    ]);
    expect(store.submit("uncertain", "must-not-repeat", 2)).toBe(false);
    expect(store.settle("uncertain", "done")).toBe(true);
    expect(store.inputs("missing")).toEqual([]);
  });

  test("settlement and immutable output admission commit or roll back together", () => {
    const { store, path } = fixture();
    store.receive(inbound("request"), "main");
    store.submit("request", "native", 0);
    store.queueOutput({ id: "occupied", sourceId: "another", route: route(), text: "another output" });
    expect(() => store.settle("request", "done", { id: "occupied", text: "answer" })).toThrow("identity conflict");
    expect(store.input("request")?.state).toBe("submitted");
    expect(store.settle("request", "done", { id: "request:answer", text: "answer" })).toBe(true);
    expect(store.settle("request", "done", { id: "extra", text: "duplicate" })).toBe(false);
    expect(store.settle("request", "cancelled")).toBe(false);
    expect(store.outputs().map(output => output.id)).toEqual(["occupied", "request:answer"]);
    store.close();
    const reopened = open(path);
    expect(reopened.input("request")?.state).toBe("done");
    expect(reopened.outputs().filter(output => output.sourceId === "request")).toHaveLength(1);
    expect(reopened.queueOutput({ id: "request:answer", sourceId: "request", route: route(), text: "answer" })).toBe(false);
    expect(() => reopened.queueOutput({ id: "request:answer", sourceId: "request", route: route(), text: "changed" })).toThrow();
  });

  test("lane settlement and its full head report commit atomically without an external output", () => {
    const { store, path } = fixture();
    const selected = admitLane(store);
    const source = "source-lane";
    store.submit(source, "native-owned-request", 0);
    store.receive(inbound(`report:${source}`), "main");
    expect(() => store.settle(source, "done", { id: "lane-answer", text: "Must roll back" })).toThrow("identity conflict");
    expect(store.input(source)).toMatchObject({ target: selected.id, state: "submitted", requestId: "native-owned-request" });
    expect(store.outputs()).toEqual([]);

    const original = { ...inbound("original-head-source", route({ channelId: "request-channel", threadId: null })), receivedAt: 150 };
    store.receive(original, "main");
    store.settle("original-head-source", "done");
    const followup = inbound("explicit-handoff");
    store.receive(followup, selected.id, { [`handoff-source:${followup.id}`]: "original-head-source" });
    store.submit(followup.id, "native-followup", 0);
    const fullResult = "Full lane result beyond a summary. ".repeat(100);
    expect(store.settle(followup.id, "done", { id: "unused-external-answer", text: fullResult })).toBe(true);
    expect(store.settle(followup.id, "done", { id: "second-answer", text: "Must not replace" })).toBe(false);
    expect(store.outputs()).toEqual([]);
    const report = store.input(`report:${followup.id}`)!;
    expect(report).toMatchObject({ target: "main", state: "pending", route: original.route, messageId: original.messageId, receivedAt: original.receivedAt, attachments: [] });
    expect(store.input(original.id)).toMatchObject({ target: "main", state: "done", route: original.route });
    expect(store.input(followup.id)).toMatchObject({ target: selected.id, route: selected.route });
    expect(report.text).toContain("sourceId: original-head-source");
    expect(report.requestId).toBeNull();
    expect(report.text).toContain("native-followup");
    expect(report.text).toContain("native outcome: done");
    expect(report.text).toContain(fullResult);
    expect(report.text).toContain(selected.sessionFile);
    store.close();
    const reopened = open(path);
    expect(reopened.input(report.id)).toEqual(report);
    expect(reopened.input(followup.id)?.state).toBe("done");
    expect(reopened.outputs()).toEqual([]);
    expect(reopened.submit(report.id, "head-native-synthesis", 0)).toBe(true);
    reopened.settle(report.id, "done", { id: "head-synthesis", text: "Head-controlled result" });
    expect(reopened.outputs()).toMatchObject([{ sourceId: report.id, route: original.route, text: "Head-controlled result" }]);
  });

  test("outbox IDs deduplicate independently of source while original routes remain immutable", async () => {
    const { store } = fixture();
    store.receive(inbound("request"), "main");
    const output = { id: "answer", sourceId: "request", route: route(), text: "answer" };
    const results = await Promise.all(Array.from({ length: 8 }, () => Promise.resolve().then(() => store.queueOutput(output))));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(store.queueOutput({ ...output, id: "status", text: "working" })).toBe(true);
    expect(() => store.queueOutput({ ...output, id: "wrong", route: route({ authorityId: "foreign" }) })).toThrow("route differs");
    expect(store.claimOutput("answer")).toBe(true);
    expect(store.claimOutput("answer")).toBe(false);
    store.finishOutput("answer", "sent", "discord-receipt");
    store.finishOutput("answer", "sent", "discord-receipt");
    expect(() => store.finishOutput("answer", "sent", "another-receipt")).toThrow("receipt conflict");
    expect(() => store.finishOutput("answer", "pending")).toThrow("Invalid output transition");
    expect(store.queueOutput(output)).toBe(false);
    expect(store.outputs().map(output => output.id)).toEqual(["status"]);
  });

  test("cancellation is terminal and does not allow delayed completion to send an answer", () => {
    const { store } = fixture();
    admitLane(store);
    store.submit("source-lane", "native", 0);
    expect(store.settle("source-lane", "cancelled", { id: "cancel-notice", text: "Cancelled" })).toBe(true);
    expect(store.settle("source-lane", "cancelled", { id: "duplicate-cancel", text: "Cancelled" })).toBe(false);
    expect(store.settle("source-lane", "done", { id: "late-answer", text: "Too late" })).toBe(false);
    store.updateLane("lane", 0, { workState: "cancelled" });
    store.receive(inbound("followup"), "lane");
    expect(store.submit("followup", "must-not-wake", 0)).toBe(false);
    expect(store.lane("lane")?.runtimeState).toBe("unloaded");
    expect(store.outputs()).toEqual([]);
    expect(store.input("report:source-lane")?.text).toContain("Cancelled");
    expect(store.input("report:source-lane")?.text).not.toContain("Too late");
  });

  test("approval identity survives restart and duplicate answer/cancellation resolves exactly once", async () => {
    const { store, path } = fixture();
    admitLane(store);
    const request = approval();
    store.putApproval(request);
    store.setApprovalMessage(request.id, "card");
    store.putApproval({ ...request, request: { title: "Allow action?", method: "confirm" } });
    expect(() => store.putApproval({ ...request, requestId: "another-dialog" })).toThrow("identity conflict");
    expect(() => store.putApproval({ ...request, id: "same-native-dialog" })).toThrow();
    expect(() => store.setApprovalMessage(request.id, "different-card")).toThrow("receipt conflict");
    expect(store.resolveApproval(request.id, 1, "answered")).toBe(false);
    const results = await Promise.all(["answered", "cancelled"].map(state => Promise.resolve().then(() =>
      store.resolveApproval(request.id, 0, state as "answered" | "cancelled"))));
    expect(results).toEqual([true, false]);
    store.putApproval(request);
    expect(store.approval(request.id)?.state).toBe("answered");
    expect(store.approvals()).toEqual([]);
    store.close();
    const reopened = open(path);
    expect(reopened.approval(request.id)).toMatchObject({ state: "answered", remoteId: "card", requestId: "native-dialog" });
    expect(reopened.resolveApproval(request.id, 0, "answered")).toBe(false);
  });

  test("stale/paused approvals cannot authorize work but can be explicitly cancelled", () => {
    const { store } = fixture();
    admitLane(store);
    store.putApproval(approval("stale"));
    store.nextGeneration("lane");
    expect(store.resolveApproval("stale", 0, "answered")).toBe(false);
    expect(store.resolveApproval("stale", 1, "cancelled")).toBe(false);
    expect(store.resolveApproval("stale", 0, "cancelled")).toBe(true);
    expect(store.resolveApproval("stale", 0, "cancelled")).toBe(false);
    expect(() => store.putApproval(approval("obsolete", "lane", 0))).toThrow("Stale approval");
    store.putApproval(approval("paused", "lane", 1));
    store.updateLane("lane", 1, { workState: "paused" });
    expect(store.resolveApproval("paused", 1, "answered")).toBe(false);
    expect(store.approvals("lane").map(approval => approval.id)).toEqual(["paused"]);
    expect(store.resolveApproval("paused", 1, "cancelled")).toBe(true);
    store.setApprovalMessage("paused", "late-card");
    expect(store.approval("paused")?.remoteId).toBe("late-card");
  });

  test("recovery quarantines ambiguous sends without rewriting submitted inputs or live lanes", () => {
    const { store, path } = fixture();
    admitLane(store);
    store.updateLane("lane", 0, { runtimeState: "running", pid: 456 });
    store.submit("source-lane", "native", 0);
    store.queueOutput({ id: "inflight", sourceId: "source-lane", route: route(), text: "answer" });
    store.queueOutput({ id: "pending", sourceId: "source-lane", route: route(), text: "notice" });
    store.claimOutput("inflight");
    store.close();
    const reopened = open(path);
    expect(storedOutput(path, "inflight")?.state).toBe("sending");
    expect(reopened.input("source-lane")).toMatchObject({ state: "submitted", generation: 0, requestId: "native" });
    expect(reopened.lane("lane")).toMatchObject({ runtimeState: "running", pid: 456, workState: "open" });
    reopened.recoverDeliveries();
    reopened.recoverDeliveries();
    expect(storedOutput(path, "inflight")?.state).toBe("uncertain");
    expect(reopened.claimOutput("inflight")).toBe(false);
    expect(reopened.outputs().map(output => output.id)).toEqual(["pending"]);
    reopened.finishOutput("inflight", "sent", "reconciled-receipt");
    expect(storedOutput(path, "inflight")).toEqual({ state: "sent", remote_id: "reconciled-receipt" });
    expect(reopened.input("source-lane")?.state).toBe("submitted");
  });

  test("a known failed/uncertain send retries only after an explicit transition", () => {
    const { store } = fixture();
    store.queueOutput({ id: "answer", sourceId: "notice", route: route(), text: "answer" });
    store.claimOutput("answer");
    store.finishOutput("answer", "failed", undefined, "HTTP rejected");
    expect(store.outputs()).toEqual([]);
    expect(store.claimOutput("answer")).toBe(false);
    store.finishOutput("answer", "pending");
    expect(store.outputs()[0]).toMatchObject({ state: "pending", remoteId: null, error: null });
    store.claimOutput("answer");
    store.finishOutput("answer", "uncertain", undefined, "Connection lost after write");
    expect(store.outputs()).toEqual([]);
    store.finishOutput("answer", "pending");
    expect(store.claimOutput("answer")).toBe(true);
  });

  test("a second writer including a symlink alias is rejected until close", () => {
    const { store, path, directory } = fixture();
    expect(() => open(path)).toThrow();
    const alias = join(directory, "alias.sqlite");
    symlinkSync(path, alias);
    expect(() => open(alias)).toThrow();
    store.close();
    store.close();
    const next = open(alias);
    expect(next.receive(inbound("after-close"), null)).toBe(true);
  });

  test("OS releases the writer lock after abrupt owner death without deleting a sidecar", async () => {
    const { store, path } = fixture();
    store.close();
    const module = new URL("../src/store.ts", import.meta.url).href;
    const child = Bun.spawn([process.execPath, "--eval", `
      import { Store } from ${JSON.stringify(module)};
      const store = new Store(${JSON.stringify(path)});
      store.setMeta("crash-owner", "durable");
      const parentClosed = Promise.withResolvers();
      process.stdin.once("end", () => parentClosed.resolve());
      process.stdin.resume();
      console.log("locked");
      await parentClosed.promise;
      // Keep both SQLite ownership handles strongly reachable until parent EOF.
      store.close();
    `], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    try {
      const reader = child.stdout.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain("locked");
      reader.releaseLock();
      expect(child.exitCode).toBeNull();
      expect(() => open(path)).toThrow();
      expect(child.exitCode).toBeNull();
      child.stdin.write("still-held\n");
      child.stdin.flush();
    } finally {
      child.kill("SIGKILL");
      await child.exited;
    }
    expect(open(path).getMeta("crash-owner")).toBe("durable");
  }, 10_000);
});
