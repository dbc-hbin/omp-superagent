import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Client, Collection, type ClientUser, type Message } from "discord.js";
import { physicalRoute, physicalRouteKey, routeKey, type Approval, type Inbound, type Lane, type LaneModel, type Route } from "../src/contracts.ts";
import { DiscordMessenger } from "./oracles/bun-gateway/discord.ts";
import { GatewayStore } from "./oracles/bun-gateway/gateway-store";
import { Store } from "../src/store.ts";
import { lanePlacement, readLaneRows } from "../src/lane-rows";
import { TOPIC_CHOICE_WAIT_MS } from "../src/topic-request";
import type { LaneReport } from "../src/lane-report";
import type { HeadRecoveryAttempt } from "../src/contracts";
import { acknowledgeDecision, decisionId, decisionViews } from "../src/decisions";

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
function decisionApproval(): Approval {
  const id = decisionId("decision-session", "decision-tool");
  return { ...approval("decision-approval", "main"), decision: { id, sourceId: "owner-request", sessionId: "decision-session" },
    request: { method: "ask", questions: [
      { id: `${id}:0`, question: "Which storage?", options: [{ label: "SQLite", description: "No new service" }, { label: "Redis" }], recommended: 0 },
      { id: `${id}:1`, question: "Which checks?", options: [{ label: "Unit" }, { label: "Native" }], multi: true },
    ] } };
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
  test("active queue filters keep durable order and exclude terminal work and other targets", () => {
    const { store } = fixture();
    const other = admitLane(store);
    store.receive(inbound("first"), "main");
    store.receive(inbound("other", other.route), other.id);
    store.receive(inbound("legacy"), null);
    store.receive(inbound("third"), "main");
    store.receive(inbound("last"), "main");
    store.submit("first", "native-first", 0);
    store.settle("first", "uncertain");
    store.submit("third", "native-third", 0);
    store.settle("last", "cancelled");

    expect(store.inputs("main").map(input => input.id)).toEqual(["first", "third"]);
    expect(store.inputs(undefined, "pending").map(input => input.id)).toEqual([`source-${other.id}`, "other", "legacy"]);
    expect(store.inputs("main", "submitted").map(input => input.id)).toEqual(["third"]);
    expect(store.hasInput(other.id, "uncertain")).toBe(false);
    expect(store.hasInput("main", "uncertain")).toBe(true);
  });

  test("native recovery only fences uncertain HEAD work with a nonempty original owner record", () => {
    const { store } = fixture();
    const other = admitLane(store);
    store.receive(inbound("lane-owner", other.route), other.id, { "head-native-owner:lane-owner": "record" });
    store.submit("lane-owner", "native-lane", 0);
    store.settle("lane-owner", "uncertain");
    store.receive(inbound("head-owner"), "main", { "head-native-owner:head-owner": "record" });
    store.submit("head-owner", "native-head", 0);
    expect(store.hasHeadRecoveryInput()).toBe(false);
    store.settle("head-owner", "uncertain");
    expect(store.hasHeadRecoveryInput()).toBe(true);
    store.setMeta("head-native-owner:head-owner", "");
    expect(store.hasHeadRecoveryInput()).toBe(false);
    store.setMeta("head-native-owner:head-owner", "record");
    store.settle("head-owner", "cancelled");
    expect(store.hasHeadRecoveryInput()).toBe(false);
  });

  function recovery(store: Store): HeadRecoveryAttempt {
    store.receive(inbound("recovery-original"), "main");
    store.submit("recovery-original", "original-rpc", 0);
    store.settle("recovery-original", "uncertain");
    return { attemptId: "recovery-attempt", inputId: "recovery-original", requestId: "original-rpc", generation: 0,
      sessionId: "original-session", sessionFile: "/sessions/original.jsonl", hostPid: process.pid,
      recoveryRequestId: "recovery-rpc", promptDigest: "prompt-digest", cursor: null, boundary: "native-receipt",
      stopBoundary: null, evidenceEntryIds: ["native-receipt", "native-assistant"],
      evidenceFingerprint: "exact-original-evidence", state: "prepared" };
  }
  function released(expected: HeadRecoveryAttempt, state: "decided" | "settled" = "decided"): HeadRecoveryAttempt {
    return { ...expected, state, outcome: "done", decision: { attemptId: expected.attemptId,
      decision: "release", evidenceEntryIds: expected.evidenceEntryIds, reason: "Observed native processing outcome only" } };
  }

  test("recovery decision, exact target settlement and original-route output are one durable transaction", () => {
    const { store, path } = fixture();
    let expected = recovery(store);
    expect(store.prepareHeadRecovery(expected)).toBe(true);
    const proposed = released(expected);
    expect(store.commitHeadRecovery(expected, proposed)).toBe(true);
    expect(store.input(expected.inputId)?.state).toBe("uncertain");
    expect(store.outputs()).toEqual([]);
    expected = proposed;
    const db = new Database(path);
    try {
      db.run(`CREATE TRIGGER fail_recovery_output BEFORE INSERT ON outputs
        BEGIN SELECT RAISE(ABORT, 'crash before output binding'); END`);
      expect(() => store.commitHeadRecovery(expected, released(expected, "settled"))).toThrow("crash before output binding");
      expect(store.input(expected.inputId)?.state).toBe("uncertain");
      expect(JSON.parse(store.getMeta(`head:recovery:${expected.inputId}`)!)).toEqual(expected);
      db.run("DROP TRIGGER fail_recovery_output");
      expect(store.commitHeadRecovery(expected, released(expected, "settled"))).toBe(true);
      expect(store.input(expected.inputId)?.state).toBe("done");
      expect(store.output(`${expected.inputId}:recovery:${expected.attemptId}`)).toMatchObject({
        sourceId: expected.inputId, route: route(), state: "pending",
      });
      expect(store.getMeta("head:recovery-active")).toBe(expected.inputId);
      expect(store.commitHeadRecovery(expected, released(expected, "settled"))).toBe(false);
      store.close();
      const reopened = open(path);
      expect(JSON.parse(reopened.getMeta(`head:recovery:${expected.inputId}`)!)).toEqual(released(expected, "settled"));
      expect(reopened.input(expected.inputId)?.state).toBe("done");
      expect(reopened.outputs()).toHaveLength(1);
    } finally { db.close(); }
  });

  test.each(["stop", "owner-resolve", "identity", "ambiguous-output"] as const)(
    "%s prevents a stale recovery commit without partial effects", race => {
      const { store } = fixture();
      const expected = recovery(store);
      expect(store.prepareHeadRecovery(expected)).toBe(true);
      if (race === "stop") store.setMeta("head:stop-boundary", JSON.stringify({ inputId: "new-stop", cancelledInputIds: [] }));
      if (race === "owner-resolve") store.settle(expected.inputId, "cancelled");
      if (race === "identity") store.setMeta(`head:recovery:${expected.inputId}`, JSON.stringify({ ...expected, attemptId: "new-attempt" }));
      if (race === "ambiguous-output") {
        store.queueOutput({ id: "uncertain-original-effect", sourceId: expected.inputId, route: route(), text: "Original output" });
        store.claimOutput("uncertain-original-effect");
        store.finishOutput("uncertain-original-effect", "uncertain");
      }
      expect(store.commitHeadRecovery(expected, released(expected))).toBe(false);
      expect(store.output(`${expected.inputId}:recovery:${expected.attemptId}`)).toBeNull();
      expect(store.input(expected.inputId)?.state).toBe(race === "owner-resolve" ? "cancelled" : "uncertain");
    });

  test("interrupted preparation is durable and evidence snapshots expose no gateway arguments, result or token", () => {
    const { store, path } = fixture();
    const expected = recovery(store);
    expect(store.prepareHeadRecovery(expected)).toBe(true);
    expect(store.prepareHeadRecovery({ ...expected, attemptId: "duplicate" })).toBe(false);
    const db = new Database(path);
    try {
      db.run("CREATE TABLE gateway_effects(id TEXT PRIMARY KEY,operation TEXT,arguments TEXT,state TEXT,result TEXT)");
      db.query("INSERT INTO gateway_effects VALUES (?,?,?,?,?)").run("ambiguous-gateway-effect", "send",
        JSON.stringify([{ sourceId: expected.inputId, text: "SECRET_TOKEN_DO_NOT_PROJECT" }]), "attempted", null);
      db.query("INSERT INTO gateway_effects VALUES (?,?,?,?,?)").run("unrelated-effect", "send",
        JSON.stringify([{ sourceId: "different-request", text: "UNRELATED_PRIVATE_PAYLOAD" }]), "attempted", null);
      expect(store.headRecoveryEffects(expected.inputId)).toEqual([
        { id: "ambiguous-gateway-effect", kind: "send", state: "uncertain" },
      ]);
      expect(JSON.stringify(store.headRecoveryEffects(expected.inputId))).not.toContain("SECRET_TOKEN");
      expect(store.commitHeadRecovery(expected, released(expected))).toBe(false);
      store.close();
      const reopened = open(path);
      expect(reopened.getMeta("head:recovery-active")).toBe(expected.inputId);
      expect(JSON.parse(reopened.getMeta(`head:recovery:${expected.inputId}`)!)).toEqual(expected);
    } finally { db.close(); }
  });

  test("structured observations separate new evidence from repeated reports and waiting", () => {
    const { store } = fixture();
    const managed = admitLane(store);
    store.updateLane(managed.id, 0, { sessionId: "native-observation" });
    store.submit("source-lane", "native-request", 0);
    const report: LaneReport = { status: "progress", summary: "Verified the selected artifact changed",
      evidence: [{ kind: "file", ref: "/workspace/repo/result", fingerprint: "a".repeat(64) }] };
    expect(store.recordLaneReport("source-lane", 0, "native-observation", "first", report, 1000)).toBe(true);
    expect(store.recordLaneReport("source-lane", 0, "native-observation", "first", report, 2000)).toBe(false);
    expect(store.recordLaneReport("source-lane", 0, "native-observation", "repeat", report, 3000)).toBe(false);
    expect(store.lane(managed.id)?.observation).toMatchObject({ lastReportAt: 3000, lastEvidenceAt: 1000, waiting: null });
    store.progress("source-lane", 0, "native-observation", "commentary", "Still working");
    expect(store.lane(managed.id)?.observation?.lastEvidenceAt).toBe(1000);
    const waiting: LaneReport = { status: "waiting", summary: "Waiting for verification",
      evidence: [], waiting: { kind: "tool", id: "native-check", target: "Verification command" } };
    expect(store.recordLaneReport("source-lane", 0, "native-observation", "waiting", waiting, 4000)).toBe(true);
    expect(store.recordLaneReport("source-lane", 0, "native-observation", "same-wait", {
      ...waiting, waiting: { kind: "tool", id: "native-check", target: "Same verification, renamed" },
    }, 5000)).toBe(false);
    expect(store.lane(managed.id)?.observation).toMatchObject({ lastReportAt: 5000, lastEvidenceAt: 1000, waiting: { since: 4000 } });
    expect(store.recordLaneReport("source-lane", 0, "native-observation", "same-proof", report, 6000)).toBe(false);
    expect(store.lane(managed.id)?.observation?.waiting?.since).toBe(4000);
    expect(store.resolveLaneWaiting("source-lane", 0, "native-observation", "tool", "unrelated")).toBe(false);
    expect(store.resolveLaneWaiting("source-lane", 0, "native-observation", "approval", "native-check")).toBe(false);
    expect(store.resolveLaneWaiting("source-lane", 0, "native-observation", "tool", "native-check")).toBe(true);
    expect(store.resolveLaneWaiting("source-lane", 0, "native-observation", "tool", "native-check")).toBe(false);
    expect(store.lane(managed.id)?.observation).toMatchObject({ lastEvidenceAt: 1000, waiting: null });
    expect(store.input("source-lane")?.state).toBe("submitted");
    expect(store.lane(managed.id)?.workState).toBe("open");
    expect(store.inputs("main")).toHaveLength(1);
    expect(store.inputs("main")[0]?.text).toContain("does not verify success");
    expect(store.outputs()).toEqual([]);
  });

  test("identical successful tool results are not new evidence merely because their native call IDs differ", () => {
    const { store, path } = fixture();
    const managed = admitLane(store);
    store.updateLane(managed.id, 0, { sessionId: "native-observation" });
    store.submit("source-lane", "native-request", 0);
    const report: LaneReport = { status: "progress", summary: "Selected native verification result",
      evidence: [{ kind: "tool", ref: "first-native-call", fingerprint: "a".repeat(64) }] };
    expect(store.recordLaneReport("source-lane", 0, "native-observation", "first", report, 1000)).toBe(true);
    store.close();
    const reopened = open(path);
    expect(reopened.recordLaneReport("source-lane", 0, "native-observation", "same-output", {
      ...report, evidence: [{ ...report.evidence[0]!, ref: "different-native-call" }],
    }, 2000)).toBe(false);
    expect(reopened.lane(managed.id)?.observation).toMatchObject({ lastEvidenceAt: 1000, lastReportAt: 2000 });
    expect(reopened.recordLaneReport("source-lane", 0, "native-observation", "new-output", {
      ...report, evidence: [{ kind: "tool", ref: "third-native-call", fingerprint: "b".repeat(64) }],
    }, 3000)).toBe(true);
    expect(reopened.lane(managed.id)?.observation).toMatchObject({ lastEvidenceAt: 3000 });
  });

  test("waiting clocks, evidence fingerprints and report receipts survive reopen without old reports restoring a resolved wait", () => {
    const { store, path } = fixture();
    const managed = admitLane(store);
    store.updateLane(managed.id, 0, { sessionId: "native-observation" });
    store.submit("source-lane", "native-request", 0);
    const waiting: LaneReport = { status: "waiting", summary: "Blocked on the external schema",
      waiting: { kind: "dependency", target: "/workspace/repo/schema.json" }, evidence: [] };
    store.recordLaneReport("source-lane", 0, "native-observation", "original-wait", waiting, 1000);
    store.close();
    const reopened = open(path);
    expect(reopened.recordLaneReport("source-lane", 0, "native-observation", "original-wait", waiting, 8000)).toBe(false);
    expect(reopened.recordLaneReport("source-lane", 0, "native-observation", "repeat-wait", waiting, 9000)).toBe(false);
    expect(reopened.lane(managed.id)?.observation).toMatchObject({ waiting: { since: 1000 }, lastEvidenceAt: null });
    const resolved: LaneReport = { status: "resolved", summary: "The requested schema is available", waiting: waiting.waiting,
      evidence: [{ kind: "file", ref: "/workspace/repo/schema.json", fingerprint: "b".repeat(64) }] };
    expect(reopened.recordLaneReport("source-lane", 0, "native-observation", "wrong-resolution", {
      ...resolved, waiting: { kind: "dependency", target: "/workspace/repo/other.json" },
    }, 9500)).toBe(false);
    expect(reopened.recordLaneReport("source-lane", 0, "native-observation", "resolved", resolved, 10000)).toBe(true);
    expect(reopened.recordLaneReport("source-lane", 0, "native-observation", "resolved", resolved, 11000)).toBe(false);
    expect(reopened.recordLaneReport("source-lane", 0, "native-observation", "original-wait", waiting, 12000)).toBe(false);
    expect(reopened.lane(managed.id)?.observation).toMatchObject({ waiting: null, lastEvidenceAt: 10000, lastReportAt: 10000 });
    expect(() => reopened.recordLaneReport("source-lane", 0, "native-observation", "resolved", {
      ...resolved, summary: "A conflicting replay",
    }, 13000)).toThrow("Lane report identity conflict");
  });

  test.each(["generation", "session", "paused", "cancelled", "uncertain"] as const)(
    "structured reports and late native resolution cannot mutate an observation after %s changes", reason => {
      const { store } = fixture();
      const managed = admitLane(store);
      store.updateLane(managed.id, 0, { sessionId: "native-observation" });
      store.submit("source-lane", "native-request", 0);
      const waiting: LaneReport = { status: "waiting", summary: "Waiting",
        waiting: { kind: "approval", id: "native-approval", target: "Owner decision" }, evidence: [] };
      store.recordLaneReport("source-lane", 0, "native-observation", "wait", waiting, 1000);
      const before = store.lane(managed.id)?.observation;
      if (reason === "generation") store.nextGeneration(managed.id);
      else if (reason === "session") store.updateLane(managed.id, 0, { sessionId: "new-session" });
      else if (reason === "paused") store.updateLane(managed.id, 0, { workState: "paused" });
      else store.settle("source-lane", reason);
      expect(store.recordLaneReport("source-lane", 0, "native-observation", "late", waiting, 2000)).toBe(false);
      expect(store.resolveLaneWaiting("source-lane", 0, "native-observation", "approval", "native-approval")).toBe(false);
      expect(store.lane(managed.id)?.observation).toEqual(before);
    },
  );

  test("reply snapshots and voice metadata survive reopen without changing on redelivery", () => {
    const { store, path } = fixture();
    const original: Inbound = { ...inbound("reply-snapshot"),
      reply: { messageId: "referenced", authorId: "other-author", text: "Original report", quote: "report" },
      attachments: [{ id: "voice", name: "voice.ogg", url: "telegram-file:voice", size: null, voice: true, durationSeconds: 1.5 }],
    };
    expect(store.receive(original, "main")).toBe(true);
    store.close();
    const reopened = open(path);
    expect(reopened.input(original.id)).toMatchObject({ reply: original.reply, attachments: original.attachments });
    expect(reopened.receive({ ...original, reply: { messageId: "referenced", authorId: null, text: null } }, "main")).toBe(false);
    expect(reopened.input(original.id)?.reply).toEqual(original.reply);
    expect(reopened.receive({ ...original, reply: undefined, attachments: original.attachments.map(({ voice, durationSeconds, ...file }) => file) }, "main")).toBe(false);
    expect(reopened.input(original.id)?.attachments).toEqual(original.attachments);
    expect(() => reopened.receive({ ...original, text: "Changed owner instruction" }, "main")).toThrow("identity conflict");
  });

  test("Discord context snapshots survive reopen and metadata redelivery while each owner revision retains its own snapshot", () => {
    const { store, path } = fixture();
    const original: Inbound = { ...inbound("discord-context"), discordOriginalText: "<@42> request discord-context",
      discordContext: { kind: "guild", channel: { id: "channel", name: "Original", topic: null, purpose: "Original purpose" },
        thread: { id: "thread", parentId: "channel", name: "Original thread" } },
    };
    store.receive(original, "main");
    const edited: Inbound = { ...original, id: "discord-context:edit", text: "Edited owner instruction",
      discordOriginalText: "<@42> Edited owner instruction",
      discordContext: { kind: "guild", channel: { id: "channel", name: "Later", topic: "New topic" },
        thread: { id: "thread", parentId: "channel", name: "Renamed thread", purpose: "Later purpose" } },
    };
    store.receive(edited, "main");
    store.close();
    const reopened = open(path);
    expect(reopened.receive({ ...original, discordContext: edited.discordContext }, "main")).toBe(false);
    expect(reopened.input(original.id)?.discordContext).toEqual(original.discordContext);
    expect(reopened.input(original.id)?.discordOriginalText).toBe(original.discordOriginalText);
    expect(() => reopened.receive({ ...original, discordOriginalText: `${original.text} <@42>` }, "main"))
      .toThrow("identity conflict");
    expect(reopened.input(edited.id)?.discordContext).toEqual(edited.discordContext);
    expect(reopened.receive({ ...edited, discordContext: undefined }, "main")).toBe(false);
    expect(reopened.input(edited.id)?.discordContext).toEqual(edited.discordContext);
  });

  test("Telegram routing snapshots survive reopen without changing text or legacy replay identity", () => {
    const { store, path } = fixture();
    const telegram = route({ platform: "telegram", accountId: "900", authorityId: "42", guildId: null, channelId: "42", threadId: null });
    const legacy = { ...inbound("telegram:900:42:10:original", telegram), messageId: "10", text: "Legacy quote" };
    const quoted = { ...inbound("telegram:900:42:11:original", telegram), messageId: "11", text: "Copied plan", routingText: "" };
    expect(store.receive(legacy, "main")).toBe(true);
    expect(store.receive(quoted, "main")).toBe(true);
    store.close();

    const reopened = open(path);
    expect(reopened.receive({ ...legacy, routingText: "" }, "main")).toBe(false);
    expect(reopened.receive({ ...quoted, routingText: quoted.text }, "main")).toBe(false);
    expect(reopened.input(legacy.id)?.routingText).toBeUndefined();
    expect(reopened.input(quoted.id)).toMatchObject({ text: quoted.text, messageId: "11", routingText: "" });
    expect(() => reopened.receive({ ...quoted, text: "Different message" }, "main")).toThrow("identity conflict");
  });

  test("nonterminal lane progress coalesces durable receipts without settling or externally delivering lane work", () => {
    const { store, path } = fixture();
    const managed = admitLane(store);
    store.updateLane(managed.id, 0, { sessionId: "native-progress" });
    store.submit("source-lane", "native-request", 0);
    expect(store.progress("source-lane", 0, "native-progress", "first", "Inspected the failure")).toBe(true);
    const first = "progress:source-lane:first";
    expect(store.input(first)).toMatchObject({ target: "main", state: "pending", route: managed.route, workflow: null });
    expect(store.input(first)?.text).toContain("nonterminal");
    expect(store.input(first)?.text).toContain("untrusted");
    expect(store.input("source-lane")).toMatchObject({ state: "submitted", requestId: "native-request" });
    expect(store.outputs()).toEqual([]);
    expect(store.progress("source-lane", 0, "native-progress", "second", "Found the cause")).toBe(true);
    expect(store.input(first)?.state).toBe("cancelled");
    expect(store.inputs("main").map(input => input.id)).toEqual(["progress:source-lane:second"]);
    store.close();
    const reopened = open(path);
    expect(reopened.progress("source-lane", 0, "native-progress", "first", "Inspected the failure")).toBe(false);
    reopened.settle("source-lane", "done", { id: "final", text: "Verified independent final result" });
    expect(reopened.input("progress:source-lane:second")?.state).toBe("cancelled");
    expect(reopened.input("report:source-lane")?.text).toContain("Verified independent final result");
    expect(reopened.input("report:source-lane")?.text).not.toContain("Found the cause");
  });

  test("progress uses validated head-selected topic and cancels stale pending receipts before submission", () => {
    const { store } = fixture();
    const source = inbound("topic-source", route({ threadId: null }));
    store.receive(source, "main");
    const handoff = { ...source, id: `handoff:${source.id}:lane`, route: route({ threadId: "selected" }) };
    store.receive(handoff, null, { [`handoff-source:${handoff.id}`]: source.id });
    const managed = store.createLane(lane("selected-lane", handoff.route), handoff.id);
    store.setMeta(`head-delivery:${source.id}`, JSON.stringify({ source: source.route, destination: managed.route, laneId: managed.id }));
    store.updateLane(managed.id, 0, { sessionId: "native-topic" });
    store.submit(handoff.id, "request", 0);
    store.progress(handoff.id, 0, "native-topic", "topic", "Working in selected topic");
    const receipt = `progress:${handoff.id}:topic`;
    expect(store.input(receipt)?.route).toEqual(managed.route);
    store.updateLane(managed.id, 0, { workState: "paused" });
    expect(store.submit(receipt, "head-request", 0)).toBe(false);
    expect(store.input(receipt)?.state).toBe("cancelled");
    expect(store.progress(handoff.id, 0, "native-topic", "paused", "Must not surface")).toBe(false);
    store.updateLane(managed.id, 0, { workState: "open" });
    store.setMeta(`head-delivery:${source.id}`, JSON.stringify({ source: source.route, destination: route({ threadId: "wrong" }), laneId: managed.id }));
    expect(() => store.progress(handoff.id, 0, "native-topic", "invalid-route", "Must not surface")).toThrow("Invalid head-selected delivery binding");
    expect(store.input(`progress:${handoff.id}:invalid-route`)).toBeNull();
  });

  test("progress excludes stale generations, sessions, uncertain or cancelled sources and empty observations", () => {
    const { store } = fixture();
    const managed = admitLane(store);
    store.updateLane(managed.id, 0, { sessionId: "native-progress" });
    const source = inbound("original-progress");
    store.receive(source, "main");
    const handoff = { ...source, id: "progress-handoff", route: managed.route };
    store.receive(handoff, managed.id, { [`handoff-source:${handoff.id}`]: source.id });
    store.submit(handoff.id, "native-request", 0);
    expect(store.progress(handoff.id, 1, "native-progress", "stale-generation", "No")).toBe(false);
    expect(store.progress(handoff.id, 0, "wrong-session", "stale-session", "No")).toBe(false);
    expect(store.progress(handoff.id, 0, "native-progress", "empty", " \n")).toBe(false);
    store.settle(source.id, "uncertain");
    expect(store.progress(handoff.id, 0, "native-progress", "uncertain", "No")).toBe(false);
    store.settle(source.id, "cancelled");
    expect(store.progress(handoff.id, 0, "native-progress", "cancelled", "No")).toBe(false);
    expect(store.inputs("main").filter(input => input.id.startsWith("progress:"))).toEqual([]);
  });

  test("a submitted progress synthesis cannot deliver stale progress after independent lane final", () => {
    const { store } = fixture();
    const managed = admitLane(store);
    store.updateLane(managed.id, 0, { sessionId: "native-progress" });
    store.submit("source-lane", "native-request", 0);
    store.progress("source-lane", 0, "native-progress", "active", "Milestone");
    const receipt = "progress:source-lane:active";
    store.submit(receipt, "head-request", 0);
    store.settle("source-lane", "done", { id: "lane-final", text: "Final result" });
    store.settle(receipt, "done", { id: "stale-progress-answer", text: "Old milestone synthesis" });
    expect(store.output("stale-progress-answer")).toBeNull();
    expect(store.input("report:source-lane")?.state).toBe("pending");
  });

  test("head progress keeps uncertain delivery receipts and is never blindly retried", () => {
    const { store } = fixture();
    store.receive(inbound("head-progress"), "main");
    store.setMeta("main:sessionId", "native-head");
    store.submit("head-progress", "request", 0);
    expect(store.progress("head-progress", 0, "native-head", "event", "Meaningful milestone")).toBe(true);
    const outputId = "progress:head-progress:event";
    expect(store.output(outputId)?.text).toBe("Meaningful milestone");
    expect(store.claimOutput(outputId)).toBe(true);
    store.finishOutput(outputId, "uncertain");
    expect(store.progress("head-progress", 0, "native-head", "event", "Meaningful milestone")).toBe(false);
    expect(store.outputs()).toEqual([]);
    expect(store.output(outputId)?.state).toBe("uncertain");
  });

  test("Discord head progress edits one confirmed status message in place and keeps its physical id on redelivery", () => {
    const { store, path } = fixture();
    const source = inbound("status-source");
    store.receive(source, "main");
    store.setMeta("main:sessionId", "native-head");
    store.submit(source.id, "request", 0);
    const update = (event: string, text: string) => {
      expect(store.progress(source.id, 0, "native-head", event, text, true)).toBe(true);
      const id = `progress:${source.id}:${event}`;
      expect(store.claimOutput(id, true)).toBe(true);
      return id;
    };
    const first = update("one", "Reading the code");
    expect(store.output(first)).toMatchObject({ text: "⏳ Reading the code", state: "sending", status: true });
    expect(store.output(first)?.editOf).toBeUndefined();
    store.finishOutput(first, "sent", "900");

    const target = { route: physicalRoute(source.route), messageId: "900" };
    const second = update("two", "Running tests");
    expect(store.output(second)?.editOf).toEqual(target);
    // An ambiguous edit is not retried by itself; an explicit redelivery keeps the target.
    store.finishOutput(second, "uncertain");
    expect(store.outputs()).toEqual([]);
    store.finishOutput(second, "pending");
    store.close();
    const reopened = open(path);
    expect(reopened.claimOutput(second, true)).toBe(true);
    expect(reopened.output(second)?.editOf).toEqual(target);
    reopened.finishOutput(second, "sent", "900");
    // Reply lookups still resolve the edited message to the output that created it.
    expect(reopened.sentOutputForMessage(source.route, "900")?.id).toBe(first);

    expect(reopened.progress(source.id, 0, "native-head", "three", "Fixing", true)).toBe(true);
    const third = `progress:${source.id}:three`;
    expect(reopened.claimOutput(third, true)).toBe(true);
    expect(reopened.output(third)?.editOf).toEqual(target);
    // A rejected edit fails that update only; it is never requeued as a new post.
    reopened.finishOutput(third, "failed", undefined, "Messenger rejected delivery");
    expect(reopened.outputs()).toEqual([]);
    expect(reopened.output(third)).toMatchObject({ state: "failed", editOf: target });

    expect(reopened.progress(source.id, 0, "native-head", "four", "Almost done", true)).toBe(true);
    const fourth = `progress:${source.id}:four`;
    expect(reopened.claimOutput(fourth, true)).toBe(true);
    expect(reopened.output(fourth)?.editOf).toBeUndefined();
    reopened.finishOutput(fourth, "sent", "901");
    expect(reopened.progress(source.id, 0, "native-head", "five", "Done soon", true)).toBe(true);
    const fifth = `progress:${source.id}:five`;
    expect(reopened.claimOutput(fifth, true)).toBe(true);
    expect(reopened.output(fifth)?.editOf).toEqual({ ...target, messageId: "901" });
  });

  test("an uncertain status post is never edited, and non-Discord progress keeps posting plain messages", () => {
    const { store } = fixture();
    const source = inbound("uncertain-status");
    store.receive(source, "main");
    store.setMeta("main:sessionId", "native-head");
    store.submit(source.id, "request", 0);
    store.progress(source.id, 0, "native-head", "one", "First", true);
    expect(store.claimOutput(`progress:${source.id}:one`, true)).toBe(true);
    store.finishOutput(`progress:${source.id}:one`, "uncertain");
    store.progress(source.id, 0, "native-head", "two", "Second", true);
    expect(store.claimOutput(`progress:${source.id}:two`, true)).toBe(true);
    expect(store.output(`progress:${source.id}:two`)?.editOf).toBeUndefined();

    const telegram = route({ platform: "telegram", accountId: "bot", authorityId: "owner", guildId: null, channelId: "42", threadId: null });
    const plain = inbound("telegram-status", telegram);
    store.receive(plain, "main");
    store.submit(plain.id, "request-telegram", 0);
    for (const event of ["one", "two"]) {
      store.progress(plain.id, 0, "native-head", event, `Update ${event}`, true);
      const id = `progress:${plain.id}:${event}`;
      expect(store.claimOutput(id, true)).toBe(true);
      expect(store.output(id)).toMatchObject({ text: `Update ${event}`, state: "sending" });
      expect(store.output(id)?.editOf).toBeUndefined();
      store.finishOutput(id, "sent", `telegram-${event}`);
    }
  });

  test("Discord progress posts separate plain messages by default and shares status streams across HEAD lane summaries when enabled", () => {
    const { store } = fixture();
    const defaultHead = inbound("default-progress");
    store.receive(defaultHead, "main");
    store.setMeta("main:sessionId", "native-head");
    store.submit(defaultHead.id, "req-default", 0);
    expect(store.progress(defaultHead.id, 0, "native-head", "p1", "Step 1")).toBe(true);
    expect(store.claimOutput(`progress:${defaultHead.id}:p1`)).toBe(true);
    expect(store.output(`progress:${defaultHead.id}:p1`)).toMatchObject({ text: "Step 1" });
    expect(store.output(`progress:${defaultHead.id}:p1`)?.status).toBeUndefined();
    store.finishOutput(`progress:${defaultHead.id}:p1`, "sent", "800");
    expect(store.progress(defaultHead.id, 0, "native-head", "p2", "Step 2")).toBe(true);
    expect(store.claimOutput(`progress:${defaultHead.id}:p2`)).toBe(true);
    expect(store.output(`progress:${defaultHead.id}:p2`)).toMatchObject({ text: "Step 2" });
    expect(store.output(`progress:${defaultHead.id}:p2`)?.editOf).toBeUndefined();

    // Card-only update places the marker on its own line so the fence stays intact.
    const cardHead = inbound("card-progress");
    store.receive(cardHead, "main");
    store.submit(cardHead.id, "req-card", 0);
    const cardFence = "```card\n{\"root\":\"c\",\"elements\":{\"c\":{\"type\":\"Card\",\"props\":{\"title\":\"T\"}}}}\n```";
    expect(store.progress(cardHead.id, 0, "native-head", "c1", cardFence, true)).toBe(true);
    expect(store.output(`progress:${cardHead.id}:c1`)).toMatchObject({ text: `⏳\n${cardFence}`, status: true });

    // Non-topic lane progress summarized by HEAD shares one stream per lane input, while the final report stays separate.
    const selected = admitLane(store, "lane-summary");
    store.updateLane(selected.id, 0, { sessionId: "native-lane" });
    const laneInput = "source-lane-summary";
    store.submit(laneInput, "lane-req", 0);
    expect(store.progress(laneInput, 0, "native-lane", "u1", "Working 1", true)).toBe(true);
    const p1Id = `progress:${laneInput}:u1`;
    store.submit(p1Id, "head-sum-1", 0);
    expect(store.settle(p1Id, "done", { id: `${p1Id}:answer`, text: "Summary 1" }, undefined, true)).toBe(true);
    expect(store.claimOutput(`${p1Id}:answer`, true)).toBe(true);
    expect(store.output(`${p1Id}:answer`)).toMatchObject({ text: "⏳ Summary 1", status: true });
    store.finishOutput(`${p1Id}:answer`, "sent", "910");

    expect(store.progress(laneInput, 0, "native-lane", "u2", "Working 2", true)).toBe(true);
    const p2Id = `progress:${laneInput}:u2`;
    store.submit(p2Id, "head-sum-2", 0);
    expect(store.settle(p2Id, "done", { id: `${p2Id}:answer`, text: "Summary 2" }, undefined, true)).toBe(true);
    expect(store.claimOutput(`${p2Id}:answer`, true)).toBe(true);
    expect(store.output(`${p2Id}:answer`)).toMatchObject({
      text: "⏳ Summary 2", status: true, editOf: { route: physicalRoute(selected.route), messageId: "910" },
    });
    store.finishOutput(`${p2Id}:answer`, "sent", "910");

    // Final lane completion report settles separately with no status marker or editOf.
    expect(store.settle(laneInput, "done", { id: "lane-done", text: "Final lane text" }, undefined, true)).toBe(true);
    const reportId = `report:${laneInput}`;
    store.submit(reportId, "head-report", 0);
    expect(store.settle(reportId, "done", { id: `${reportId}:answer`, text: "Final answer" }, undefined, true)).toBe(true);
    expect(store.claimOutput(`${reportId}:answer`, true)).toBe(true);
    expect(store.output(`${reportId}:answer`)?.text).toBe("Final answer");
    expect(store.output(`${reportId}:answer`)?.editOf).toBeUndefined();
    expect(store.output(`${reportId}:answer`)?.status).toBeUndefined();
  });

  test("Slack invocation origins survive handoffs, reports, and reopen without a source timestamp", () => {
    const { store, path } = fixture();
    const destination = route({ platform: "slack", accountId: "TTEAM:UBOT", authorityId: "UOWNER", guildId: null, channelId: "DOWNER", threadId: null, topicId: "topic-slash" });
    const managed = admitLane(store, "slack-lane", destination);
    const original: Inbound = { ...inbound("slack-command:stable-fingerprint", destination), messageId: null,
      invocationId: "a".repeat(64), text: "/new inspect this repository" };
    expect(store.receive(original, "main", { [`user-source:${original.id}`]: "true" })).toBe(true);
    const handoff = { ...original, id: `handoff:${original.id}:${managed.id}` };
    store.receive(handoff, managed.id, { [`handoff-source:${handoff.id}`]: original.id });
    store.submit(handoff.id, "native-slash-request", managed.generation);
    store.settle(handoff.id, "done", { id: "slack-result", text: "Verified work result" });
    const reportId = `report:${handoff.id}`;
    for (const id of [original.id, handoff.id, reportId]) expect(store.input(id)).toMatchObject({ messageId: null, invocationId: original.invocationId });
    store.close();
    const reopened = open(path);
    expect(reopened.receive({ ...original, receivedAt: 999 }, "main")).toBe(false);
    expect(reopened.input(original.id)?.receivedAt).toBe(original.receivedAt);
    for (const changed of [{ ...original, text: "/main" }, { ...original, invocationId: "b".repeat(64) },
      { ...original, route: { ...destination, topicId: "other-topic" } }]) {
      expect(() => reopened.receive(changed, "main")).toThrow("Inbound identity conflict");
    }
    expect(() => reopened.receive({ ...original, messageId: "1750000000.000001" }, "main")).toThrow("requires a real message ID");
    expect(() => reopened.receive({ ...original, invocationId: "opaque-trigger-capability" }, "main")).toThrow("requires a real message ID");
    expect([...reopened.admittedMessageIds(destination)]).toEqual([]);
    for (const id of [original.id, handoff.id, reportId]) expect(reopened.input(id)).toMatchObject({ messageId: null, invocationId: original.invocationId });
  });

  test("durable actual user messages include settled first revisions and exclude unrelated routes and synthetic inputs", () => {
    const { store } = fixture();
    const physical = route({ platform: "slack", accountId: "TTEAM:UBOT", authorityId: "UOWNER", guildId: null, channelId: "DOWNER", threadId: null });
    const first = { ...inbound("first-actual", { ...physical, topicId: "first-topic" }), messageId: "1750000000.000001" };
    const edit = { ...first, id: "edit-actual", route: physical, text: "edited" };
    store.receive({ ...first, id: "internal-handoff" }, "main");
    for (const [index, patch] of [{ platform: "discord" } as const, { accountId: "OTHER:UBOT" }, { authorityId: "UOTHER" }, { channelId: "DOTHER" }, { threadId: "1750000000.000001" }, { guildId: "TTEAM" }].entries()) {
      const input = { ...first, id: `unrelated-${index}`, route: { ...physical, ...patch } };
      store.receive(input, "main", { [`user-source:${input.id}`]: "true" });
    }
    const otherId = { ...first, id: "other-message", messageId: "1750000000.000002" };
    for (const input of [otherId, first, edit]) {
      store.receive(input, "main", { [`user-source:${input.id}`]: "true" });
      store.settle(input.id, "done");
    }
    const logical = { ...physical, topicId: "another-logical-topic" };
    expect(store.firstAdmittedMessage(logical, first.messageId)).toMatchObject({ id: first.id, route: first.route, state: "done" });
    expect(store.firstAdmittedMessage(physical, "1750000000.000003")).toBeNull();
    expect([...store.admittedMessageIds(physical)]).toEqual([otherId.messageId, first.messageId, edit.messageId]);
  });

  test("interaction origin survives handoffs, reports and reopen and participates in dedupe identity", () => {
    const { store, path } = fixture();
    const managed = admitLane(store);
    const original: Inbound = { ...inbound("interaction:1750000000000000001"), messageId: null,
      interactionId: "1750000000000000001", text: "/new inspect this repository" };
    expect(store.receive(original, "main", { [`user-source:${original.id}`]: "true" })).toBe(true);
    const handoff = { ...original, id: `handoff:${original.id}:${managed.id}`, route: managed.route };
    store.receive(handoff, managed.id, { [`handoff-source:${handoff.id}`]: original.id });
    store.submit(handoff.id, "native-interaction-request", managed.generation);
    store.settle(handoff.id, "done", { id: "lane-result", text: "Inspected repository" });
    const reportId = `report:${handoff.id}`;
    for (const id of [original.id, handoff.id, reportId]) {
      expect(store.input(id)).toMatchObject({ messageId: null, interactionId: original.interactionId });
    }
    store.close();
    const reopened = open(path);
    expect(reopened.receive(original, "main")).toBe(false);
    for (const changed of [
      { ...original, interactionId: "1750000000000000002" },
      { ...original, messageId: "1750000000000000001", interactionId: undefined },
      { ...original, messageId: "1750000000000000001" },
    ]) expect(() => reopened.receive(changed, "main")).toThrow("Inbound identity conflict");
    for (const id of [original.id, handoff.id, reportId]) {
      expect(reopened.input(id)).toMatchObject({ messageId: null, interactionId: original.interactionId });
    }
    const legacy = inbound("legacy-message-without-interaction");
    expect(reopened.receive(legacy, "main")).toBe(true);
    expect(reopened.input(legacy.id)?.interactionId).toBeUndefined();
    expect(() => reopened.receive({ ...legacy, interactionId: "1750000000000000003" }, "main")).toThrow("Inbound identity conflict");
  });

  test("an event without a real message or valid Discord interaction identity is not admitted", () => {
    const { store } = fixture();
    for (const identity of [
      { messageId: null },
      { messageId: null, interactionId: "synthetic-command-id" },
      { messageId: null, interactionId: "" },
      { messageId: undefined },
    ]) {
      expect(() => store.receive({ ...inbound("invalid-origin"), ...identity } as Inbound, "main")).toThrow("requires a real message ID");
      expect(store.input("invalid-origin")).toBeNull();
    }
    expect(() => store.receive({ ...inbound("foreign-interaction", route({ platform: "slack" })),
      messageId: null, interactionId: "1750000000000000001" }, "main")).toThrow("requires a real message ID");
  });

  test("workflow choices commit atomically with original source and exact immutable handoff", () => {
    const { store, path } = fixture();
    const managed = admitLane(store);
    const original = { ...inbound("workflow-source", route({ threadId: "source-thread" })), text: "Inspect the authorized repository" };
    store.receive(original, "main", { [`user-source:${original.id}`]: "true" });
    const handoff = { ...original, id: "workflow-handoff", route: managed.route, text: "Inspect just this bounded part" };
    const workflow = { name: "super-plan" as const, reason: "Planning is needed for this authorized task", sourceId: original.id, provenance: "head" as const };
    const metadata = { [`handoff-source:${handoff.id}`]: original.id };
    expect(store.receive(handoff, managed.id, metadata, workflow)).toBe(true);
    expect(store.receive(handoff, managed.id, metadata, workflow)).toBe(false);
    for (const changed of [null, { ...workflow, name: "super-loop" as const }, { ...workflow, reason: "A different choice" },
      { ...workflow, sourceId: "foreign" }, { ...workflow, provenance: "user" as const }]) {
      expect(() => store.receive(handoff, managed.id, metadata, changed)).toThrow("Workflow identity conflict");
    }
    workflow.reason = "Caller mutation after admission";
    expect(store.input(handoff.id)?.workflow?.reason).toBe("Planning is needed for this authorized task");
    expect(store.input(original.id)).toMatchObject({ ...original, workflow: null, target: "main", state: "pending" });
    store.close();
    const reopened = open(path);
    expect(reopened.input(handoff.id)).toMatchObject({ route: managed.route, workflow: {
      name: "super-plan", sourceId: original.id, provenance: "head", reason: "Planning is needed for this authorized task",
    } });
    expect(reopened.input(original.id)?.text).toBe(original.text);
  });

  test("reads pre-SUPER rows without requeueing a handoff or reinterpreting previously ordinary text", () => {
    const { store, path } = fixture();
    const managed = admitLane(store);
    const pendingBeforeUpgrade = store.inputs(managed.id, "pending");
    const original = { ...inbound("old-workflow-source", route({ threadId: "old-source" })), text: "/ulw-plan inspect",
      attachments: [{ id: "file", name: "reference.txt", size: 12, contentType: "text/plain",
        url: "https://cdn.discordapp.com/attachments/1/2/reference.txt?ex=original" }] };
    const handoff = { ...original, id: "old-workflow-handoff", route: managed.route, text: "Plan only the bounded change" };
    const ordinary = { ...inbound("old-ordinary-text"), text: "super-plan change the repository" };
    const userActivation = { name: "ulw-plan", reason: "Original invocation", sourceId: original.id, provenance: "user" as const };
    const headActivation = { ...userActivation, reason: "Typed planning handoff", provenance: "head" as const };
    store.close();
    const oldDb = new Database(path);
    try {
      const insert = oldDb.query("INSERT INTO inputs(id, data, target, state, request_id, generation) VALUES (?, ?, ?, ?, ?, ?)");
      insert.run(original.id, JSON.stringify({ ...original, workflow: userActivation }), "main", "pending", null, null);
      insert.run(handoff.id, JSON.stringify({ ...handoff, workflow: headActivation }), managed.id, "submitted", "old-ticket", 7);
      insert.run(ordinary.id, JSON.stringify(ordinary), "main", "done", "ordinary-ticket", 1);
      const source = oldDb.query("INSERT INTO metadata(key, value) VALUES (?, ?)");
      source.run(`user-source:${original.id}`, "true");
      source.run(`handoff-source:${handoff.id}`, original.id);
      source.run(`user-source:${ordinary.id}`, "true");
    } finally {
      oldDb.close();
    }
    const reopened = open(path);
    expect(reopened.input(original.id)).toMatchObject({ ...original, workflow: { ...userActivation, name: "super-plan" } });
    expect(reopened.input(handoff.id)).toMatchObject({ ...handoff, workflow: { ...headActivation, name: "super-plan" },
      target: managed.id, state: "submitted", requestId: "old-ticket", generation: 7 });
    expect(reopened.input(ordinary.id)).toMatchObject({ ...ordinary, workflow: null, state: "done", requestId: "ordinary-ticket" });
    expect(reopened.receive(ordinary, "main")).toBe(false);
    expect(() => reopened.receive(ordinary, "main", {}, { ...userActivation, name: "super-plan", sourceId: ordinary.id })).toThrow("Workflow identity conflict");
    expect(reopened.receive(handoff, "main", {}, { ...headActivation, name: "super-plan" })).toBe(false);
    expect(() => reopened.receive(handoff, managed.id, {}, { ...headActivation, name: "super-loop" })).toThrow("Workflow identity conflict");
    expect(reopened.inputs(managed.id, "pending")).toEqual(pendingBeforeUpgrade);
    const refreshed = { ...original, attachments: [{ ...original.attachments[0]!, url: "https://cdn.discordapp.com/attachments/1/2/reference.txt?ex=refreshed" }] };
    expect(reopened.receive(refreshed, "main", {}, { ...userActivation, name: "super-plan" })).toBe(false);
    const onDisk = new Database(path, { readonly: true });
    try {
      const data = onDisk.query<{ data: string }, [string]>("SELECT data FROM inputs WHERE id = ?");
      expect(JSON.parse(data.get(original.id)!.data)).toEqual({ ...refreshed, workflow: userActivation });
      expect(JSON.parse(data.get(handoff.id)!.data)).toEqual({ ...handoff, workflow: headActivation });
      expect(JSON.parse(data.get(ordinary.id)!.data)).toEqual(ordinary);
    } finally {
      onDisk.close();
    }
  });

  test("reports and inbound object properties do not acquire workflow authority", () => {
    const { store } = fixture();
    const managed = admitLane(store);
    const source = inbound("actual-user");
    const workflow = { name: "super-loop" as const, sourceId: source.id, reason: "Original invocation", provenance: "user" as const };
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
    const workflow = { name: "super-plan" as const, sourceId: source.id, reason: "Bounded planning", provenance: "head" as const };
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

  function confirmedChoice(store: Store, directory: string) {
    const original = inbound("history-choice");
    const confirmedAt = original.receivedAt + 100;
    const questionId = `${original.id}:workspace`;
    store.receive(original, null, {
      [`user-source:${original.id}`]: "true",
      [`topic-history:${original.id}`]: JSON.stringify([{ cwd: realpathSync(directory) }, { cwd: "/other-workspace" }]),
    });
    store.queueOutput({ id: questionId, sourceId: original.id, route: original.route, text: "Which prior task?" });
    store.claimOutput(questionId);
    const clock = spyOn(Date, "now").mockReturnValue(confirmedAt);
    try { store.finishOutput(questionId, "sent", "question"); }
    finally { clock.mockRestore(); }
    const input = store.input(original.id);
    if (!input) throw new Error("Original choice source not admitted");
    return { input, confirmedAt, deadline: confirmedAt + TOPIC_CHOICE_WAIT_MS };
  }

  const gatewayChoiceCases: readonly {
    readonly name: string;
    readonly holds: boolean;
    readonly event: (fixture: ReturnType<typeof confirmedChoice>, cwd: string) => Partial<Inbound>;
  }[] = [
    { name: "a naked number authored at expiry", holds: true, event: f => ({ text: "2", receivedAt: f.deadline }) },
    { name: "a cwd header without a reply", holds: true, event: (_, cwd) => ({ text: `cwd: ${cwd}` }) },
    { name: "a bare repository in a reply to the original", holds: true,
      event: (f, cwd) => ({ text: basename(cwd), reply: { messageId: f.input.messageId ?? "", authorId: null, text: null } }) },
    { name: "a bare path in a reply to the confirmed question", holds: true,
      event: (_, cwd) => ({ text: cwd, reply: { messageId: "question", authorId: null, text: null } }) },
    { name: "a direct reply posted before the head recorded the question receipt", holds: true,
      event: f => ({ receivedAt: f.confirmedAt - 1, reply: { messageId: "question", authorId: null, text: null } }) },
    { name: "an exact slash-command stop", holds: true, event: () => ({ text: "/stop", messageId: null, interactionId: "901" }) },
    { name: "an unreferenced repo name", holds: false, event: (_, cwd) => ({ text: basename(cwd) }) },
    { name: "an older bare number", holds: false, event: f => ({ receivedAt: f.confirmedAt - 1 }) },
    { name: "an answer authored after expiry", holds: false, event: f => ({ receivedAt: f.deadline + 1 }) },
    { name: "a reply to somebody else's question", holds: false,
      event: () => ({ reply: { messageId: "unrelated-question", authorId: null, text: null } }) },
    { name: "an edited Discord answer", holds: false, event: () => ({ id: "discord:account:902:edit:201:sha" }) },
    { name: "a new work directive", holds: false, event: (_, cwd) => ({ text: `/new cwd: ${cwd}\nStart another task` }) },
    ...(["accountId", "authorityId", "guildId", "channelId", "threadId"] as const).map(field => ({
      name: `another ${field}`, holds: false, event: () => ({ route: route({ [field]: "unrelated" }) }),
    })),
  ];

  for (const { name, holds, event } of gatewayChoiceCases) {
    test(`automatic history choice ${holds ? "waits for" : "ignores"} ${name} in the Gateway ledger`, () => {
      const { store, directory } = fixture();
      const choice = confirmedChoice(store, directory);
      const { input, deadline } = choice;
      const pinKey = `topic-choice-auto:${input.id}`;
      expect(store.hasPendingTopicChoice(input, deadline)).toBe(false); // No Gateway table in standalone Store.
      const gateway = new GatewayStore(directory);
      const clock = spyOn(Date, "now").mockReturnValue(deadline + 10);
      try {
        gateway.admit({ kind: "message", input: {
          ...inbound("discord:account:902:original"), messageId: "902", text: "1", receivedAt: choice.confirmedAt,
          ...event(choice, directory),
        } });
        expect(store.hasPendingTopicChoice(input, deadline)).toBe(holds);
        // An admission after the preliminary check cannot slip through the atomic recheck.
        expect(store.tryAutoTopicChoice(input, deadline, "")).toBe(!holds);
        expect(store.getMeta(pinKey)).toBe(holds ? null : "");
        if (holds) {
          const queued = gateway.next();
          if (!queued) throw new Error("Expected the persisted Gateway message");
          gateway.receipt(queued.sequence, "unresolved");
          expect(store.hasPendingTopicChoice(input, deadline)).toBe(true);
          gateway.receipt(queued.sequence, "rejected");
          expect(store.hasPendingTopicChoice(input, deadline)).toBe(false);
          expect(store.tryAutoTopicChoice(input, deadline, "")).toBe(true);
        }
      } finally {
        clock.mockRestore();
        gateway.close();
      }
    });
  }

  test.each(["not expired", "stale deadline", "manual choice", "already automatic", "cancelled"] as const)(
    "the local-only Store refuses an automatic history pin when %s", scenario => {
      const { store, directory } = fixture();
      const { input, deadline } = confirmedChoice(store, directory);
      const pinKey = `topic-choice-auto:${input.id}`;
      const clock = spyOn(Date, "now").mockReturnValue(scenario === "not expired" ? deadline - 1 : deadline);
      try {
        if (scenario === "manual choice") store.setMeta(`topic-previous:${input.id}`, "owner-pin");
        if (scenario === "already automatic") expect(store.tryAutoTopicChoice(input, deadline, "")).toBe(true);
        if (scenario === "cancelled") store.settle(input.id, "cancelled");
        expect(store.tryAutoTopicChoice(input, scenario === "stale deadline" ? deadline - 1 : deadline, "new-pin")).toBe(false);
        expect(store.getMeta(pinKey)).toBe(scenario === "already automatic" ? "" : null);
      } finally { clock.mockRestore(); }
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

  test("a pre-placement ledger is readable as local before and after migration", () => {
    const directory = mkdtempSync(join(tmpdir(), "omp-superagent-legacy-placement-"));
    directories.push(directory);
    const path = join(directory, "coordination.sqlite");
    const legacy = lane();
    const db = new Database(path);
    try {
      db.run("CREATE TABLE lanes (id TEXT PRIMARY KEY, route_key TEXT NOT NULL UNIQUE, generation INTEGER NOT NULL, data TEXT NOT NULL)");
      db.query("INSERT INTO lanes (id,route_key,generation,data) VALUES (?,?,?,?)")
        .run(legacy.id, routeKey(legacy.route), legacy.generation, JSON.stringify(legacy));
      expect(readLaneRows(db).map(lanePlacement)).toEqual([{ target: "local" }]);
    } finally { db.close(); }

    const migrated = open(path);
    expect(migrated.lane(legacy.id)).toEqual(legacy);
    expect(migrated.nextGeneration(legacy.id)).toMatchObject({ id: legacy.id, generation: 1 });
  });

  test("remote placement survives generations, writer reopen, route lookup, and read-only status", () => {
    const { store, path } = fixture();
    const remote = { workerId: "paired-linux", repoId: "1".repeat(64), revision: "2".repeat(40),
      subdir: "pkg/docs", stateDir: "/worker/state" };
    store.receive(inbound("source"), "main");
    const selected = store.createLane(lane("remote-lane", route(), { remote }), "source");
    store.nextGeneration(selected.id);
    store.close();
    const reopened = open(path);
    expect(reopened.laneForRoute(selected.route)).toMatchObject({ remote, generation: 1 });
    const readonly = new Database(path, { readonly: true });
    try {
      expect(readLaneRows(readonly).map(lanePlacement)).toEqual([{ target: "remote", ...remote }]);
    } finally { readonly.close(); }
  });

  test("lane reuse cannot change the pinned worker or downgrade it to local", () => {
    const { store } = fixture();
    const remote = { workerId: "paired-linux", repoId: "1".repeat(64), revision: "2".repeat(40),
      subdir: "", stateDir: "/worker/state" };
    store.receive(inbound("source"), "main");
    const selected = store.createLane(lane("remote-lane", route(), { remote }), "source");
    store.receive(inbound("new-source"), null);

    expect(() => store.createLane(lane("candidate", route(), {
      remote: { ...remote, workerId: "other-paired-linux" },
    }), "source")).toThrow("different remote placement");
    expect(() => store.createLane(lane("candidate"), "new-source")).toThrow("different remote placement");
    expect(store.input("new-source")?.target).toBeNull();
    expect(store.lane(selected.id)?.remote).toEqual(remote);
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

  test("linked output identity survives reopen and retry and rejects a replacement reply target", () => {
    const { store, path } = fixture();
    const source = { ...inbound("reply-source"), messageId: "101" };
    store.receive(source, "main", { [`user-source:${source.id}`]: "true" });
    store.settle(source.id, "done", { id: "reply-output", text: "answer" });
    expect(store.claimOutput("reply-output")).toBe(true);
    store.finishOutput("reply-output", "uncertain");
    store.close();
    const recovered = open(path);
    recovered.finishOutput("reply-output", "pending");
    expect(recovered.outputs()[0]?.replyTo).toEqual({ route: source.route, messageId: "101" });
    const retry = { id: "reply-output", sourceId: source.id, route: source.route, text: "answer" };
    expect(recovered.queueOutput(retry)).toBe(false);
    expect(recovered.queueOutput({ ...retry, replyTo: { route: source.route, messageId: "101" } })).toBe(false);
    expect(() => recovered.queueOutput({ ...retry, replyTo: { route: source.route, messageId: "102" } })).toThrow("identity conflict");
    expect(() => recovered.queueOutput({ ...retry, replyTo: { route: route({ channelId: "other" }), messageId: "101" } })).toThrow("identity conflict");
    expect(() => recovered.queueOutput({ ...retry, id: "forged-new", replyTo: { route: source.route, messageId: "102" } })).toThrow("reply differs from its source");
  });

  test.each(["interaction", "invocation", "unlinked-synthetic"] as const)("outputs do not turn %s identity into a source message", kind => {
    const { store } = fixture();
    const source: Inbound = {
      ...inbound("not-a-message", kind === "invocation" ? route({ platform: "slack" }) : route()),
      messageId: kind === "unlinked-synthetic" ? "copied-message" : null,
      ...(kind === "interaction" ? { interactionId: "201" } : {}),
      ...(kind === "invocation" ? { invocationId: createHash("sha256").update("slack-invocation").digest("hex") } : {}),
      reply: { messageId: "999", authorId: "owner", text: "untrusted quote" },
    };
    store.receive(source, "main", kind === "unlinked-synthetic" ? {} : { [`user-source:${source.id}`]: "true" });
    store.settle(source.id, "done", { id: "unlinked-answer", text: "answer" });
    expect(store.outputs()[0]?.replyTo).toBeUndefined();
  });

  test("logical Discord DM topics retain a reply to the same physical owner conversation", () => {
    const { store } = fixture();
    const destination = route({ guildId: null, channelId: "owner-dm", threadId: null, topicId: "work-topic" });
    const source = { ...inbound("dm-source", destination), messageId: "101" };
    store.receive(source, "main", { [`user-source:${source.id}`]: "true" });
    store.settle(source.id, "done", { id: "dm-answer", text: "answer" });
    expect(store.output("dm-answer")?.replyTo).toEqual({
      route: route({ guildId: null, channelId: "owner-dm", threadId: null }), messageId: "101",
    });
    expect(store.output("dm-answer")?.route).toEqual(destination);
  });

  test.each([false, true])("source-linked reports only reply when delivered to the original physical conversation (new thread: %s)", newThread => {
    const { store, path } = fixture();
    const source = { ...inbound("original", route({ threadId: null })), messageId: "101" };
    store.receive(source, "main", { [`user-source:${source.id}`]: "true" });
    const handoff = { ...source, id: `handoff:${source.id}:lane`, route: route({ threadId: "selected" }) };
    store.receive(handoff, null, { [`handoff-source:${handoff.id}`]: source.id });
    const managed = store.createLane(lane("report-lane", handoff.route), handoff.id);
    if (newThread) store.setMeta(`head-delivery:${source.id}`, JSON.stringify({
      source: source.route, destination: managed.route, laneId: managed.id,
    }));
    store.submit(handoff.id, "lane-native", 0);
    store.settle(handoff.id, "done", { id: "lane-result", text: "Completed lane observation" });
    store.close();
    const recovered = open(path);
    const report = recovered.input(`report:${handoff.id}`)!;
    expect(report.messageId).toBe("101"); // Copied identity must not authorize a cross-channel reply.
    recovered.settle(report.id, "done", { id: "report-answer", text: "HEAD synthesis" });
    expect(recovered.output("report-answer")?.replyTo).toEqual(newThread ? undefined : { route: source.route, messageId: "101" });
    expect(recovered.output("report-answer")?.route).toEqual(newThread ? managed.route : source.route);
  });

  test("old SQLite queued outputs migrate without acquiring a new reply identity on replay", () => {
    const directory = mkdtempSync(join(tmpdir(), "omp-superagent-legacy-output-"));
    directories.push(directory);
    const path = join(directory, "coordination.sqlite");
    const legacy = new Database(path);
    legacy.run(`CREATE TABLE outputs (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      source_id TEXT NOT NULL, route TEXT NOT NULL, text TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending', remote_id TEXT, error TEXT
    )`);
    legacy.query("INSERT INTO outputs(id,source_id,route,text) VALUES (?,?,?,?)")
      .run("legacy-answer", "original", JSON.stringify(route()), "answer");
    legacy.close();
    const store = open(path);
    const source = { ...inbound("original"), messageId: "101" };
    store.receive(source, "main", { [`user-source:${source.id}`]: "true" });
    expect(store.outputs()).toEqual([{
      id: "legacy-answer", sourceId: source.id, route: source.route, text: "answer",
      state: "pending", remoteId: null, error: null,
    }]);
    expect(store.queueOutput({ id: "legacy-answer", sourceId: source.id, route: source.route, text: "answer" })).toBe(false);
    expect(() => store.queueOutput({
      id: "legacy-answer", sourceId: source.id, route: source.route, text: "answer",
      replyTo: { route: source.route, messageId: "101" },
    })).toThrow("identity conflict");
    store.claimOutput("legacy-answer");
    store.finishOutput("legacy-answer", "failed");
    store.finishOutput("legacy-answer", "pending");
    expect(store.output("legacy-answer")?.replyTo).toBeUndefined();
    expect(store.output("legacy-answer")?.status).toBeUndefined();
    expect(store.queueOutput({ id: "status-after-upgrade", sourceId: source.id, route: source.route, text: "⏳ ok", status: true })).toBe(true);
    store.close();
    const reopened = open(path);
    expect(reopened.output("status-after-upgrade")?.status).toBe(true);
    expect(() => reopened.queueOutput({
      id: "status-telegram",
      sourceId: "tg",
      route: route({ platform: "telegram", accountId: "bot", authorityId: "owner", guildId: null, channelId: "42", threadId: null }),
      text: "⏳ bad",
      status: true,
    })).toThrow("Status delivery requires a plain Discord message");
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

  test("decision ledger keeps original choices, recommendation, card and exact owner response across restart", () => {
    const { store, path } = fixture();
    const question = decisionApproval();
    store.putApproval(question);
    store.setApprovalMessage(question.id, "original-card");
    store.putApproval(question);
    expect(decisionViews(store)).toMatchObject([{ id: question.decision!.id, state: "pending",
      sessionId: "decision-session", sourceId: "owner-request", remoteId: "original-card",
      questions: [{ question: "Which storage?", recommended: 0, options: [{ label: "SQLite", description: "No new service" }, { label: "Redis" }] },
        { multi: true }] }]);
    const response = { answers: [
      { id: `${question.decision!.id}:0`, selectedOptions: [], customInput: "Use the existing database" },
      { id: `${question.decision!.id}:1`, selectedOptions: ["Unit", "Native"] },
    ] };
    expect(store.resolveApproval(question.id, 0, "answered", { response })).toBe(true);
    expect(store.resolveApproval(question.id, 0, "cancelled", { reason: "Lost race" })).toBe(false);
    expect(decisionViews(store)[0]).toMatchObject({ state: "answering", response });
    store.close();
    const reopened = open(path);
    expect(decisionViews(reopened)[0]).toMatchObject({ state: "answering", remoteId: "original-card", response });
    acknowledgeDecision(reopened, reopened.approval(question.id)!, "different-session");
    expect(decisionViews(reopened)[0]!.state).toBe("answering");
    acknowledgeDecision(reopened, reopened.approval(question.id)!, "decision-session");
    expect(decisionViews(reopened)[0]).toMatchObject({ state: "answered", response, confirmedAt: expect.any(Number) });
    expect(decisionViews(reopened)[0]!.withdrawal).toBeUndefined();
    expect(reopened.outputs()).toEqual([]);
  });

  test("decision dedupe and malformed answers roll back without changing the original native approval", () => {
    const { store } = fixture();
    const question = decisionApproval();
    store.putApproval(question);
    expect(() => store.putApproval({ ...question, id: "duplicate-decision", requestId: "new-native-id" })).toThrow("already has a native request");
    expect(store.approval("duplicate-decision")).toBeNull();
    expect(() => store.resolveApproval(question.id, 0, "answered")).toThrow("exact owner answer");
    const first = `${question.decision!.id}:0`, second = `${question.decision!.id}:1`;
    for (const response of [
      { confirmed: true },
      { answers: [{ id: first, selectedOptions: ["A"] }, { id: second, selectedOptions: [] }] },
      { answers: [{ id: first, selectedOptions: [] }, { id: second, selectedOptions: [] }] },
      { answers: [{ id: second, selectedOptions: ["Unit"] }, { id: first, selectedOptions: ["SQLite"] }] },
      { answers: [{ id: first, selectedOptions: ["SQLite", "Redis"] }, { id: second, selectedOptions: [] }] },
      { answers: [{ id: first, selectedOptions: ["SQLite"], customInput: "Conflicting" }, { id: second, selectedOptions: [] }] },
      { answers: [{ id: first, selectedOptions: ["SQLite"] }, { id: second, selectedOptions: ["Unit", "Unit"] }] },
    ]) {
      expect(() => store.resolveApproval(question.id, 0, "answered", { response })).toThrow();
      expect(store.approval(question.id)?.state).toBe("pending");
      expect(decisionViews(store)[0]!.response).toBeUndefined();
    }
    expect(decisionViews(store)).toHaveLength(1);
  });

  test("withdrawal is not approval and ordinary confirmations and unmarked asks never become decisions", () => {
    const { store } = fixture();
    store.putApproval(approval("permission", "main"));
    store.putApproval({ ...approval("ordinary-question", "main"), requestId: "ordinary-native",
      request: { method: "ask", questions: [{ id: "ordinary", question: "Question", options: [] }] } });
    expect(decisionViews(store)).toEqual([]);
    const question = { ...decisionApproval(), requestId: "decision-native" };
    store.putApproval(question);
    expect(store.resolveApproval(question.id, 0, "cancelled", { reason: "Requirement changed", sourceId: "withdraw-request" })).toBe(true);
    expect(store.resolveApproval(question.id, 0, "answered", { response: { cancelled: true } })).toBe(false);
    expect(decisionViews(store)[0]).toMatchObject({ state: "withdrawn",
      withdrawal: { reason: "Requirement changed", sourceId: "withdraw-request" } });
    expect(decisionViews(store)[0]!.response).toBeUndefined();
    expect(store.approvals().map(approval => approval.id)).toEqual(["permission", "ordinary-question"]);
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

  test.each(["original path", "symlink alias"] as const)("a second writer using the %s is rejected until close", kind => {
    const { store, path, directory } = fixture();
    const secondPath = kind === "symlink alias" ? join(directory, "alias.sqlite") : path;
    if (kind === "symlink alias") symlinkSync(path, secondPath);
    expect(() => open(secondPath)).toThrow();
    store.close();
    store.close();
    const next = open(secondPath);
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
