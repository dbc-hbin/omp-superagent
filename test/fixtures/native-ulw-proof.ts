import assert from "node:assert/strict";
import type { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseSessionEntries, type FileEntry } from "@oh-my-pi/pi-coding-agent";
import { hostPaths, type Config } from "../../src/config";
import type { Inbound, InputRecord, Lane, Messenger, OutputRecord, Route } from "../../src/contracts";
import { HostConnection } from "../../src/host";
import { hasCanonicalSuperkitSkills } from "../../src/superkit-skills";
import type { GatewayService } from "../oracles/bun-gateway/gateway";
import { waitForFixtureProcessExit } from "./host-fixture-processes";
import { nativeRequestEnvelope } from "./native-request-envelope";
import { nativeJournalDispatches } from "./native-tool-transport";

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
  const entrypoint = process.env.OMP_TEST_ULW_EXTENSION;
  assert(entrypoint, "Native SUPER proof requires the real selected Superkit entrypoint");
  const packagePath = path.dirname(entrypoint);
  const skillRoot = path.join(packagePath, "skills");
  const canonicalLayout = hasCanonicalSuperkitSkills(packagePath);
  const main = hostPaths(config, "main");
  const route: Route = { platform: "discord", accountId: "2", authorityId: "1", guildId: "3", channelId: "4", threadId: null };
  const thread = { ...route, threadId: "50" };
  const texts = [
    "> /super-plan quoted-user-data-only\nExplain the quoted text without running that workflow.",
    "Explain a report mentioning /super-run and the plain word super; do not select a workflow.",
    "Plan this separate local topic using the verified workspace.",
    "super inspect this local proof without creating a native goal.",
    "/super-plan inspect native planning activation in the main conversation.",
    "super-run inspect native execution activation in the main conversation.",
    "Continue the same independent local topic under an explicitly selected execution workflow.",
    "Classify the independent findings in the same topic using the head-selected bulk method.",
    "jevify inspect native bulk classification activation in the main conversation.",
  ];
  const inputs = texts.map((text, index) => ({ id: String(301 + index), messageId: String(301 + index),
    route: index === 2 || index === 6 || index === 7 ? thread : route, text: `/head ${text}`, receivedAt: Date.now() + index, attachments: [],
  } satisfies Inbound));
  const input = (id: string) => {
    const row = db.query("SELECT data,target,state FROM inputs WHERE id=?").get(id) as { data: string; target: string; state: InputRecord["state"] } | null;
    return row ? { ...row, record: { ...JSON.parse(row.data) as InputRecord, target: row.target, state: row.state } } : null;
  };
  const lanes = () => (db.query("SELECT data FROM lanes").all() as Array<{ data: string }>).map(row => JSON.parse(row.data) as Lane);
  const until = (predicate: () => boolean | Promise<boolean>, label: string) => options.until(async () => {
    const failed = db.query("SELECT id,state FROM inputs WHERE state IN ('uncertain','cancelled')").all();
    assert.deepEqual(failed, [], `Native SUPER request failed before ${label}`);
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
    await until(() => messenger.sent.filter(output => output.text === `HEAD:${item.id}`).length === 1 && input(item.id)?.record.state === "done", `actual SUPER head reply ${item.id}`);
    // Replay goes through the real Gateway, not a direct provider invocation.
    await messenger.deliver(item);
    await until(() => gateway.status().gateway.pendingEvents === 0, `deduplicated SUPER receipt ${item.id}`);
    assert.equal((await head.client.getState()).goal, null, "RPC SUPER must not fabricate or silently create a native goal");
  }
  assert.equal(lanes().length, 1);
  const lane = lanes()[0]!;
  assert(lane.pid && lane.sessionId);
  owned.set(lane.pid, lane);
  assert.deepEqual(lane.route, thread);
  assert.equal(lane.cwd, path.join(root, "topic"));
  assert.notEqual(lane.sessionId, headState.sessionId);
  const actualLane = await connect(lane.socketPath);
  const laneState = await actualLane.client.getState();
  assert.equal(laneState.goal, null);
  const firstHandoff = "handoff:303:lane";
  const secondHandoff = `handoff:307:${lane.id}`;
  const bulkHandoff = `handoff:308:${lane.id}`;
  const headEntries = parseSessionEntries(await fs.readFile(main.sessionFile, "utf8"));
  const laneEntries = parseSessionEntries(await fs.readFile(lane.sessionFile, "utf8"));
  const headRequests = userRequests(headEntries);
  const laneRequests = userRequests(laneEntries);
  assert.deepEqual(headRequests.map(request => request.id).sort(), [...inputs.map(item => item.id), `report:${firstHandoff}`, `report:${secondHandoff}`, `report:${bulkHandoff}`].sort());
  assert.deepEqual(laneRequests.map(request => request.id), [firstHandoff, secondHandoff, bulkHandoff]);
  const management = nativeJournalDispatches(headEntries)
    .filter(call => call.mode === "execute" && (call.name === "lane_start" || call.name === "lane_message"));
  assert.deepEqual(management.map(({ name, args, ok }) => ({ name, sourceId: args?.sourceId, ok })), [
    { name: "lane_start", sourceId: "303", ok: true },
    { name: "lane_message", sourceId: "307", ok: true },
    { name: "lane_message", sourceId: "308", ok: true },
  ], "Workflow handoffs require actual completed manager dispatch in the head's native journal");
  for (const [index, item] of inputs.entries()) {
    const original = headRequests.find(request => request.id === item.id)!;
    // Native specialised invocation may insert its default keyword immediately
    // after the alias; the complete original task arguments must remain once.
    const originalTask = texts[index]!.replace(/^\/?super-(?:plan|run)\s+/, "");
    assert.equal(original.text.split(originalTask).length - 1, 1, "Original user task must occur exactly once in its native envelope");
    assert.equal(input(item.id)?.target, "main");
    assert.equal(input(item.id)?.record.text, item.text, "Durable original text remains immutable across native keyword expansion and replay");
    assert.deepEqual(input(item.id)?.record.route, item.route);
    const output = messenger.sent.filter(output => output.text === `HEAD:${item.id}`);
    assert.equal(output.length, 1);
    assert.deepEqual(output[0]!.route, item.route);
  }
  for (const [sourceId, handoffId, name] of [["303", firstHandoff, "super-plan"], ["307", secondHandoff, "super-run"], ["308", bulkHandoff, "jevify"]] as const) {
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
  for (const id of ["301", "302", "303", "307", "308"]) assert.equal(input(id)?.record.workflow, null);
  for (const [id, name] of [["304", "super"], ["305", "super-plan"], ["306", "super-run"], ["309", "jevify"]] as const) {
    const workflow = input(id)?.record.workflow;
    assert.equal(workflow?.name, name);
    assert.equal(workflow?.sourceId, id);
    assert.equal(workflow?.provenance, "user");
  }
  const evidence = (entries: readonly FileEntry[]) => entries.flatMap(entry => entry.type === "custom" && entry.customType === "native-ulw:provider" ? [entry.data as Evidence] : []);
  const headEvidence = evidence(headEntries);
  const laneEvidence = evidence(laneEntries);
  assert.equal(headEvidence.length, headRequests.length);
  assert.equal(laneEvidence.length, 3);
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
  assert(headRequests.find(request => request.id === "304")?.text.startsWith("super "), "Plain SUPER must reach the actual head without a goal wrapper");
  assert.equal(laneRequests[0]!.text.split(texts[2]!).length - 1, 1, "Explicit initial lane workflow retains its original task once");
  assert.equal(laneRequests[1]!.text.split(texts[6]!).length - 1, 1, "Explicit lane follow-up retains its original task once");
  assert.equal(laneRequests[2]!.text.split(texts[7]!).length - 1, 1, "Native bulk selection retains its original task once");
  assert(laneRequests[0]!.text.startsWith("super-plan ultrathink\n\n"));
  assert(laneRequests[1]!.text.startsWith("super-run orchestrate\n\n"));
  assert(laneRequests[2]!.text.startsWith("jevify\n\n"));
  for (const [records, selected] of [[headEvidence, { "305": "ultrathink-notice", "306": "orchestrate-notice", "309": "jevify-notice" }],
    [laneEvidence, { [firstHandoff]: "ultrathink-notice", [secondHandoff]: "orchestrate-notice", [bulkHandoff]: "jevify-notice" }]] as const) {
    for (const record of records) {
      const notice = (selected as Record<string, string>)[record.requestId];
      assert.deepEqual(record.notices, notice ? [notice] : [], "Only this dispatch's actual native keyword event proves its mode");
      const legacyId = notice === "ultrathink-notice" ? "ulw-plan" : notice === "orchestrate-notice" ? "ulw-execute" : undefined;
      assert.equal(record.directives.length, legacyId ? 1 : 0, "Native jevify and ordinary replies/reports must not inherit an earlier SUPER directive");
      if (legacyId) {
        const command = legacyId === "ulw-plan" ? "super-plan" : "super-run";
        const skill = canonicalLayout ? command : legacyId;
        const directive = record.directives[0];
        assert(directive?.startsWith(`<omp-${legacyId}-pointer>`) && directive.includes(command)
          && directive.includes(path.join(skillRoot, skill, "SKILL.md")),
          `Actual ${record.role} directive must point from ${command} to its installed ${skill} skill`);
      }
    }
  }
  for (const [entries, actual] of [[headEntries, headEvidence], [laneEntries, laneEvidence]] as const) {
    assert.equal(nativeMessages(entries, "ultrathink-notice").length, 1);
    assert.equal(nativeMessages(entries, "orchestrate-notice").length, 1);
    assert.equal(nativeMessages(entries, "jevify-notice").length, 1);
    assert(actual.filter(record => record.notices.includes("orchestrate-notice")).every(record => record.activeTools.includes("task")),
      "Native execution notices must honor the native enabled-task capability gate");
    assert(actual.filter(record => record.notices.includes("jevify-notice")).every(record => record.activeTools.includes("eval")),
      "Native bulk classification notices must honor the native enabled-eval capability gate");
    const directives = nativeMessages(entries, "omo-ultrawork:directive");
    assert.equal(directives.length, 2);
    assert(directives.some(message => String(message.content).includes("<omp-ulw-plan-pointer>")));
    assert(directives.some(message => String(message.content).includes("<omp-ulw-execute-pointer>")));
    assert.equal(entries.filter(entry => entry.type === "custom" && entry.customType === "omo-ultrawork:state" && entry.data === true).length, 1);
    assert(actual.every(record => record.sessionId === (entries === headEntries ? headState.sessionId : lane.sessionId)));
  }
  for (const id of ["303", "307", "308"]) {
    assert.equal(messenger.sent.filter(output => output.text === `HEAD:${id}:delegated`).length, 1,
      "Head acknowledges its actual handoff without provoking native empty-stop recovery");
  }
  const kickoff = messenger.sent.filter(output => output.id === "303:kickoff");
  assert.deepEqual(kickoff.map(output => ({ id: output.id, sourceId: output.sourceId, route: output.route, text: output.text })), [{
    id: "303:kickoff", sourceId: firstHandoff, route: thread,
    text: "I will inspect the requested workspace, perform the authorized work, and verify the result in this topic.",
  }], "The initial lane handoff delivers its exact authorized kickoff once in the work topic");
  assert.equal(messenger.sent.length, inputs.length + 3 + kickoff.length);
  assert(messenger.sent.filter(output => output.id !== "303:kickoff").every(output => output.text.startsWith("HEAD:")));
  for (const connection of [head, actualLane]) {
    await until(async () => (await connection.client.getState()).isSettled, "native SUPER workflow settlement");
    assert.equal((await connection.client.getState()).hasOwnedRunningWork, false);
  }
  // The live head owns lane recovery. Stop that settled controller through
  // Gateway before terminating the remaining owned lane, not merely detach
  // Gateway while the head still interprets lane shutdown as a recoverable loss.
  await gateway.stop();
  await head.exited;
  assert.equal((await actualLane.client.getState()).isSettled, true);
  assert.equal((await actualLane.client.getState()).hasOwnedRunningWork, false);
  assert.equal((await actualLane.request({ type: "shutdown_host" })).success, true);
  await actualLane.exited;
  await waitForFixtureProcessExit([headState.hostPid, headState.adapterOwnerPid, lane.pid, laneState.adapterOwnerPid]);
  for (const sessionFile of [main.sessionFile, lane.sessionFile]) {
    const entries = parseSessionEntries(await fs.readFile(sessionFile, "utf8"));
    const shutdowns = entries.flatMap(entry => entry.type === "custom" && entry.customType === "omp-superagent-native-test" ? [entry.data as { networkAttempts: number }] : []);
    assert.equal(shutdowns.length, 1);
    assert.equal(shutdowns[0]!.networkAttempts, 0);
  }
  console.log(`NATIVE_ULW_GATEWAY_PROOF ${JSON.stringify({ inputs: inputs.length, headTurns: headEvidence.length, laneTurns: laneEvidence.length,
    nativeNotices: ["ultrathink-notice", "orchestrate-notice", "jevify-notice"], networkAttempts: 0 })}`);
}
