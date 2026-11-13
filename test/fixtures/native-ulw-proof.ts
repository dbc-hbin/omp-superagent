import assert from "node:assert/strict";
import type { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseSessionEntries, type FileEntry } from "@oh-my-pi/pi-coding-agent";
import { hostPaths, type Config } from "../../src/config";
import type { Inbound, InputRecord, Lane, Messenger, OutputRecord, Route } from "../../src/contracts";
import { HostConnection } from "../../src/host";
import type { GatewayService } from "../../src/gateway";
import { nativeRequestEnvelope } from "./native-request-envelope";

type Evidence = { role: string; requestId: string; policyCount: number; sessionId: string; notices: string[]; directives: string[]; activeTools: string[] };

function userRequests(entries: readonly FileEntry[]): Array<{ id: string; text: string }> {
  return entries.flatMap(entry => {
    if (entry.type !== "message" || entry.message.role !== "user") return [];
    const body = entry.message.content;
    const text = typeof body === "string" ? body : body.filter(part => part.type === "text").map(part => part.text).join("");
    const id = nativeRequestEnvelope(text)?.requestId;
    return id ? [{ id, text }] : [];
  });
}

function nativeMessages(entries: readonly FileEntry[], customType: string) {
  return entries.flatMap(entry => entry.type === "custom_message" && entry.customType === customType ? [entry] : []);
}

export async function runNativeUlwProof(options: {
  root: string; config: Config; db: Database; gateway: GatewayService;
  messenger: Messenger & { sent: OutputRecord[]; deliver(input: Inbound): Promise<void> };
  connections: Set<HostConnection>; owned: Map<number, { socketPath: string; sessionFile: string }>;
  until(predicate: () => boolean | Promise<boolean>, label: string): Promise<void>;
}): Promise<void> {
  const { root, config, db, gateway, messenger, connections, owned } = options;
  const main = hostPaths(config, "main");
  const route: Route = { platform: "discord", accountId: "2", authorityId: "1", guildId: "3", channelId: "4", threadId: null };
  const thread = { ...route, threadId: "50" };
  const texts = [
    "> ulw-plan quoted-user-data-only\nExplain the quoted text without running that workflow.",
    "Explain a report mentioning ulw-execute and the plain word ulw; do not select a workflow.",
    "Plan this separate local topic using the verified workspace.",
    "ulw inspect this local proof without creating a native goal.",
    "ulw-plan inspect native planning activation in the main conversation.",
    "ulw-execute inspect native execution activation in the main conversation.",
    "Continue the same independent local topic under an explicitly selected execution workflow.",
  ];
  const inputs = texts.map((text, index) => ({ id: String(301 + index), messageId: String(301 + index),
    route: index === 2 || index === 6 ? thread : route, text, receivedAt: Date.now() + index, attachments: [],
  } satisfies Inbound));
  const input = (id: string) => {
    const row = db.query("SELECT data,target,state FROM inputs WHERE id=?").get(id) as { data: string; target: string; state: InputRecord["state"] } | null;
    return row ? { ...row, record: { ...JSON.parse(row.data) as InputRecord, target: row.target, state: row.state } } : null;
  };
  const lanes = () => (db.query("SELECT data FROM lanes").all() as Array<{ data: string }>).map(row => JSON.parse(row.data) as Lane);
  const until = (predicate: () => boolean | Promise<boolean>, label: string) => options.until(async () => {
    const failed = db.query("SELECT id,state FROM inputs WHERE state IN ('uncertain','cancelled')").all();
    assert.deepEqual(failed, [], `Native ULW request failed before ${label}`);
    assert.deepEqual(lanes().filter(lane => lane.runtimeState === "interrupted"), [],
      `Actual native lane startup/ownership failed before ${label}; inspect retained private OMP logs`);
    return predicate();
  }, label);
  const connect = async (socketPath: string) => {
    const connection = await HostConnection.connect(socketPath);
    connections.add(connection);
    return connection;
  };
  const head = await connect(main.socketPath);
  const headState = await head.client.getState();
  assert(headState.hostPid);
  owned.set(headState.hostPid, main);
  assert.equal(headState.settingsScope, "session");
  assert.equal(headState.model?.provider, "gateway-native");
  assert.equal(headState.goal, null);
  for (const item of inputs) {
    await messenger.deliver(item);
    await until(() => messenger.sent.filter(output => output.text === `HEAD:${item.id}`).length === 1 && input(item.id)?.record.state === "done", `actual ULW head reply ${item.id}`);
    // Replay goes through the real Gateway, not a direct provider invocation.
    await messenger.deliver(item);
    await until(() => gateway.status().gateway.pendingEvents === 0, `deduplicated ULW receipt ${item.id}`);
    assert.equal((await head.client.getState()).goal, null, "RPC ULW must not fabricate or silently create a native goal");
  }
  assert.equal(lanes().length, 1);
  const lane = lanes()[0]!;
  assert(lane.pid && lane.sessionId);
  owned.set(lane.pid, lane);
  assert.deepEqual(lane.route, thread);
  assert.equal(lane.cwd, path.join(root, "topic"));
  assert.notEqual(lane.sessionId, headState.sessionId);
  const actualLane = await connect(lane.socketPath);
  assert.equal((await actualLane.client.getState()).goal, null);
  const firstHandoff = "handoff:303:lane";
  const secondHandoff = `handoff:307:${lane.id}`;
  const headEntries = parseSessionEntries(await fs.readFile(main.sessionFile, "utf8"));
  const laneEntries = parseSessionEntries(await fs.readFile(lane.sessionFile, "utf8"));
  const headRequests = userRequests(headEntries);
  const laneRequests = userRequests(laneEntries);
  assert.deepEqual(headRequests.map(request => request.id).sort(), [...inputs.map(item => item.id), `report:${firstHandoff}`, `report:${secondHandoff}`].sort());
  assert.deepEqual(laneRequests.map(request => request.id), [firstHandoff, secondHandoff]);
  for (const item of inputs) {
    const original = headRequests.find(request => request.id === item.id)!;
    // Native specialised invocation may insert its default keyword immediately
    // after the alias; the complete original task arguments must remain once.
    const originalTask = item.text.replace(/^ulw-(?:plan|execute)\s+/, "");
    assert.equal(original.text.split(originalTask).length - 1, 1, "Original user task must occur exactly once in its native envelope");
    assert.equal(input(item.id)?.target, "main");
    assert.equal(input(item.id)?.record.text, item.text, "Durable original text remains immutable across native keyword expansion and replay");
    assert.deepEqual(input(item.id)?.record.route, item.route);
    const output = messenger.sent.filter(output => output.text === `HEAD:${item.id}`);
    assert.equal(output.length, 1);
    assert.deepEqual(output[0]!.route, item.route);
  }
  for (const [sourceId, handoffId, name] of [["303", firstHandoff, "ulw-plan"], ["307", secondHandoff, "ulw-execute"]] as const) {
    const handed = input(handoffId)!;
    assert.equal(handed.target, lane.id);
    assert.deepEqual(handed.record.route, thread);
    assert.equal(handed.record.workflow?.name, name);
    assert.equal(handed.record.workflow?.sourceId, sourceId);
    assert.equal(handed.record.workflow?.provenance, "head");
    assert(handed.record.workflow?.reason.trim());
    assert.deepEqual(db.query("SELECT value FROM metadata WHERE key=?").get(`handoff-source:${handoffId}`), { value: sourceId });
    assert.equal(input(`report:${handoffId}`)?.target, "main");
    assert.equal(input(`report:${handoffId}`)?.record.workflow, null, "Native report text never authorizes a workflow");
    assert.equal(messenger.sent.find(output => output.text === `HEAD:${sourceId}`)?.sourceId, `report:${handoffId}`);
  }
  for (const id of ["301", "302", "303", "307"]) assert.equal(input(id)?.record.workflow, null);
  for (const [id, name] of [["304", "ulw"], ["305", "ulw-plan"], ["306", "ulw-execute"]] as const) {
    const workflow = input(id)?.record.workflow;
    assert.equal(workflow?.name, name);
    assert.equal(workflow?.sourceId, id);
    assert.equal(workflow?.provenance, "user");
  }
  const evidence = (entries: readonly FileEntry[]) => entries.flatMap(entry => entry.type === "custom" && entry.customType === "native-ulw:provider" ? [entry.data as Evidence] : []);
  const headEvidence = evidence(headEntries);
  const laneEvidence = evidence(laneEntries);
  assert.equal(headEvidence.length, headRequests.length);
  assert.equal(laneEvidence.length, 2);
  for (const id of ["301", "302", "303", `report:${firstHandoff}`]) {
    const actual = headEvidence.find(record => record.requestId === id)!;
    assert(actual);
    assert.equal(actual.policyCount, 0, "Quote/report/board data must not arm the real head policy");
    assert.deepEqual(actual.notices, []);
    assert.deepEqual(actual.directives, []);
  }
  const plain = headEvidence.find(record => record.requestId === "304")!;
  assert.equal(plain.policyCount, 1);
  assert.deepEqual(plain.notices, []);
  assert.deepEqual(plain.directives, []);
  assert.equal(laneRequests[0]!.text.split(inputs[2]!.text).length - 1, 1, "Explicit initial lane workflow retains its original task once");
  assert.equal(laneRequests[1]!.text.split(inputs[6]!.text).length - 1, 1, "Explicit lane follow-up retains its original task once");
  for (const [records, selected] of [[headEvidence, { "305": "ultrathink-notice", "306": "orchestrate-notice" }],
    [laneEvidence, { [firstHandoff]: "ultrathink-notice", [secondHandoff]: "orchestrate-notice" }]] as const) {
    for (const record of records) {
      const notice = (selected as Record<string, string>)[record.requestId];
      assert.deepEqual(record.notices, notice ? [notice] : [], "Only this dispatch's actual native keyword event proves its mode");
      assert.equal(record.directives.length, notice ? 1 : 0, "Ordinary replies/reports must not inherit an earlier workflow directive");
      if (notice) assert(record.directives[0]!.includes(notice === "ultrathink-notice" ? "<omp-ulw-plan-pointer>" : "<omp-ulw-execute-pointer>"));
    }
  }
  for (const [entries, actual] of [[headEntries, headEvidence], [laneEntries, laneEvidence]] as const) {
    assert.equal(nativeMessages(entries, "ultrathink-notice").length, 1);
    assert.equal(nativeMessages(entries, "orchestrate-notice").length, 1);
    assert(actual.filter(record => record.notices.includes("orchestrate-notice")).every(record => record.activeTools.includes("task")),
      "Native execution notices must honor the native enabled-task capability gate");
    const directives = nativeMessages(entries, "omo-ultrawork:directive");
    assert.equal(directives.length, 2);
    assert(directives.some(message => String(message.content).includes("<omp-ulw-plan-pointer>")));
    assert(directives.some(message => String(message.content).includes("<omp-ulw-execute-pointer>")));
    assert.equal(entries.filter(entry => entry.type === "custom" && entry.customType === "omo-ultrawork:state" && entry.data === true).length, 1);
    assert(actual.every(record => record.sessionId === (entries === headEntries ? headState.sessionId : lane.sessionId)));
  }
  for (const id of ["303", "307"]) {
    assert.equal(messenger.sent.filter(output => output.text === `HEAD:${id}:delegated`).length, 1,
      "Head acknowledges its actual handoff without provoking native empty-stop recovery");
  }
  assert.equal(messenger.sent.length, inputs.length + 2);
  assert(messenger.sent.every(output => output.text.startsWith("HEAD:")));
  for (const connection of [head, actualLane]) {
    await until(async () => (await connection.client.getState()).isSettled, "native ULW workflow settlement");
    assert.equal((await connection.client.getState()).hasOwnedRunningWork, false);
  }
  // The live head owns lane recovery. Stop that settled controller through
  // Gateway before terminating the remaining owned lane, not merely detach
  // Gateway while the head still interprets lane shutdown as a recoverable loss.
  await gateway.stop();
  await head.exited;
  assert.equal((await actualLane.client.getState()).isSettled, true);
  assert.equal((await actualLane.client.getState()).hasOwnedRunningWork, false);
  await actualLane.client.shutdownHost();
  await actualLane.exited;
  for (const sessionFile of [main.sessionFile, lane.sessionFile]) {
    const entries = parseSessionEntries(await fs.readFile(sessionFile, "utf8"));
    const shutdowns = entries.flatMap(entry => entry.type === "custom" && entry.customType === "omp-superagent-native-test" ? [entry.data as { networkAttempts: number }] : []);
    assert.equal(shutdowns.length, 1);
    assert.equal(shutdowns[0]!.networkAttempts, 0);
  }
  console.log(`NATIVE_ULW_GATEWAY_PROOF ${JSON.stringify({ inputs: inputs.length, headTurns: headEvidence.length, laneTurns: laneEvidence.length,
    nativeNotices: ["ultrathink-notice", "orchestrate-notice"], networkAttempts: 0 })}`);
}
