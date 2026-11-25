import assert from "node:assert/strict";
import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseSessionEntries, type FileEntry } from "@oh-my-pi/pi-coding-agent";
import { hostPaths, type Config } from "../../src/config";
import type { Inbound, InputRecord, Lane, OutputRecord } from "../../src/contracts";
import { HostConnection } from "../../src/host";
import { renderReplyVoice } from "../../src/soul";
import type { GatewayService } from "../oracles/bun-gateway/gateway";
import { waitForFixtureProcessExit } from "./host-fixture-processes";
import { nativeRequestEnvelope } from "./native-request-envelope";
import {
  assertSoulProviderRows, soulCases, soulChildRelease, soulDigest, soulKickoff, soulProfiles, soulSteerEntered, soulSteerRelease,
  soulText, soulVoiceClose, soulVoiceOpen, soulWitnessFile, type SoulProviderWitness,
} from "./native-soul-cases";
import { nativeJournalDispatches } from "./native-tool-transport";

type Source = Pick<Inbound, "id" | "route" | "text">;
type Delivery = { readonly id: string; readonly sourceId: string; readonly text: string; readonly original: Source };
const voiceKey = "soul:reply-voice";

function nativeUsers(entries: readonly FileEntry[]): string[] {
  return entries.flatMap(entry => entry.type === "message" && entry.message.role === "user" ? [soulText(entry.message.content)] : []);
}

export async function runNativeSoulProof(options: {
  readonly root: string;
  readonly config: Config;
  readonly db: Database;
  readonly gateway: GatewayService;
  readonly reopen: (stopped: GatewayService) => Promise<GatewayService>;
  readonly messenger: { readonly sent: readonly OutputRecord[]; deliver(input: Inbound): Promise<void> };
  readonly connections: Set<HostConnection>;
  readonly owned: Map<number, { socketPath: string; sessionFile: string }>;
  until(predicate: () => boolean | Promise<boolean>, label: string): Promise<void>;
}): Promise<void> {
  const { root, config, db, messenger, connections, owned } = options;
  const { oldHead, opening, oldLane, editorUpdate, editorHead, editorLane, oneOff, mentorUpdate, mentorHead, mentorLane,
    negated, manager, steer, child, super: workflow } = soulCases;
  const { editorial, mentoring } = soulProfiles;
  const input = db.query<{ data: string; target: string | null; state: InputRecord["state"] }, [string]>(
    "SELECT data,target,state FROM inputs WHERE id=?",
  );
  const metadata = db.query<{ value: string }, [string]>("SELECT value FROM metadata WHERE key=?");
  const outputs = db.query<{ id: string; state: string; remote_id: string }, []>(
    "SELECT id,state,remote_id FROM outputs",
  );
  const output = db.query<{ state: string }, [string]>("SELECT state FROM outputs WHERE id=?");
  const getLane = () => {
    const rows = db.query<{ data: string }, []>("SELECT data FROM lanes").all();
    assert.equal(rows.length, 1, "Only one lane may be created across these owner turns");
    const [row] = rows;
    assert(row);
    const lane: Lane = JSON.parse(row.data);
    return lane;
  };
  const until = (check: () => boolean | Promise<boolean>, label: string) => options.until(async () => {
    const failures = db.query("SELECT id,target,state FROM inputs WHERE state IN ('uncertain','cancelled')").all();
    assert.deepEqual(failures, [], `Native SOUL admission failed before ${label}`);
    return check();
  }, label);
  const connect = async (socketPath: string) => {
    const connection = await HostConnection.connect(socketPath);
    connections.add(connection);
    return connection;
  };
  const mainPaths = hostPaths(config, "main");
  const originalHead = await connect(mainPaths.socketPath);
  const headState = await originalHead.client.getState();
  assert(headState.hostPid);
  owned.set(headState.hostPid, mainPaths);
  assert.equal(headState.model?.provider, "gateway-native");
  assert.equal(headState.goal, null);
  assert.equal(metadata.get(voiceKey), null, "A fresh instance must not inherit operator preferences");

  const originals = new Map<string, Inbound>();
  const expected: Delivery[] = [];
  const submit = async (source: Source) => {
    const inbound: Inbound = { ...source, messageId: source.id, receivedAt: Date.now(), attachments: [] };
    originals.set(source.id, inbound);
    await messenger.deliver(inbound);
  };
  const receipt = async (original: Source, text: string, delivery?: { readonly sourceId?: string; readonly id?: string }) => {
    const sourceId = delivery?.sourceId ?? original.id;
    const id = delivery?.id ?? `${sourceId}:answer`;
    expected.push({ id, sourceId, text, original });
    await until(() => input.get(sourceId)?.state === "done" && output.get(id)?.state === "sent", `settled, sent ${id}`);
  };
  const headReply = async (source: Source) => {
    await submit(source);
    await receipt(source, `HEAD:${source.id}`);
  };
  const savedVoice = (source: Source, profile: typeof editorial | typeof mentoring) => {
    const saved = metadata.get(voiceKey);
    assert(saved, "The actual authorized tool call must commit the SOUL revision");
    assert.deepEqual(JSON.parse(saved.value), { ...profile, sourceId: source.id });
    return saved.value;
  };

  await headReply(oldHead);
  await submit(opening);
  const opened = `handoff:${opening.id}:lane`;
  await receipt(opening, soulKickoff, { sourceId: opened, id: `${opening.id}:kickoff` });
  await receipt(opening, `HEAD:${opening.id}:delegated`);
  await receipt(opening, `HEAD:${opening.id}:report`, { sourceId: `report:${opened}` });
  const resident = getLane();
  assert(resident.pid && resident.sessionId);
  owned.set(resident.pid, resident);
  const lane = await connect(resident.socketPath);
  const laneState = await lane.client.getState();
  assert.equal(laneState.hostPid, resident.pid);
  assert.equal(laneState.sessionId, resident.sessionId);
  assert.notEqual(laneState.sessionId, headState.sessionId);
  assert.deepEqual(resident.route, opening.route);
  const handoff = (source: Source) => `handoff:${source.id}:${resident.id}`;
  const laneReply = async (source: Source) => {
    await submit(source);
    await receipt(source, `LANE:${source.id}`, { id: `${handoff(source)}:answer` });
    assert.equal(input.get(handoff(source))?.target, resident.id);
  };
  await laneReply(oldLane);
  assert.equal(metadata.get(voiceKey), null);

  await headReply(editorUpdate);
  const editorReceipt = savedVoice(editorUpdate, editorial);
  await headReply(editorHead);
  await laneReply(editorLane);

  await submit(oneOff);
  await receipt(oneOff, `HEAD:${oneOff.id}:refused`);
  assert.equal(metadata.get(voiceKey)?.value, editorReceipt, "A refused one-off must not write a SOUL revision");

  const gateway = await options.reopen(options.gateway);
  await originalHead.exited;
  const head = await connect(mainPaths.socketPath);
  const reopened = await head.client.getState();
  owned.set(reopened.hostPid, mainPaths);
  assert.notEqual(reopened.hostPid, headState.hostPid, "Reopen must use a new native controller process");
  assert.equal(reopened.sessionId, headState.sessionId);
  assert.equal(reopened.sessionFile, headState.sessionFile);
  assert.equal(metadata.get(voiceKey)?.value, editorReceipt, "The new controller preserved the original SOUL revision");
  assert.equal((await lane.client.getState()).hostPid, resident.pid);

  await headReply(mentorUpdate);
  const mentorReceipt = savedVoice(mentorUpdate, mentoring);
  await headReply(mentorHead);
  await laneReply(mentorLane);
  await submit(negated);
  await receipt(negated, `HEAD:${negated.id}:refused`);
  assert.equal(metadata.get(voiceKey)?.value, mentorReceipt, "A negated request must not write a SOUL revision");

  await submit(manager);
  await until(() => existsSync(join(root, soulSteerEntered)), "the actual manager lane's native tool barrier");
  assert.equal(Number(await readFile(join(root, soulSteerEntered), "utf8")), resident.pid);
  await receipt(manager, `HEAD:${manager.id}:delegated`);
  await submit(steer);
  await until(async () => {
    const state = await lane.client.getState();
    return state.isStreaming && state.queuedMessages.steering.length === 1
      && input.get(handoff(steer))?.state === "submitted";
  }, "stock OMP queue admits the bound owner follow-up to the manager run");
  assert.equal(metadata.get(`steering-owner:${handoff(steer)}`)?.value, handoff(manager));
  await writeFile(join(root, soulSteerRelease), "", { mode: 0o600, flag: "wx" });
  await receipt(manager, `HEAD:${manager.id}:report`, { sourceId: `report:${handoff(manager)}` });
  assert.equal(input.get(handoff(steer))?.state, "done");
  assert.equal(input.get(`report:${handoff(steer)}`), null, "A joined steer must not produce its own manager report");

  let paused = false;
  const offPause = head.onFrame(frame => {
    if (frame.type === "agent_end" && frame.isTerminal === false && frame.yielded === true && frame.awaitingAsyncWork === true) paused = true;
  });
  try {
    await submit(child);
    await until(() => paused, "stock OMP yields the exact root run while waiting for its native child");
    assert.equal(output.get(`${child.id}:answer`), null, "Loop yield cannot publish an unsettled owner answer");
    assert.equal((await head.request({ type: "get_entries" })).success, true);
    const pause = await head.request({ type: "goal", op: "pause" });
    assert.equal(pause.success, true, JSON.stringify(pause));
    assert.equal((await head.request({ type: "set_event_filter", events: ["message_end", "agent_start"] })).success, true);
  } finally {
    offPause();
    await writeFile(join(root, soulChildRelease), "", { mode: 0o600, flag: "wx" });
  }
  await receipt(child, `HEAD:${child.id}`);
  assert.equal((await head.request({ type: "set_event_filter", events: null })).success, true);
  await headReply(workflow);
  for (const id of [editorUpdate.id, oneOff.id, mentorUpdate.id, steer.id]) {
    const original = originals.get(id);
    assert(original);
    await messenger.deliver(original);
  }
  await until(async () => gateway.status().gateway.pendingEvents === 0 && (await head.client.getState()).isSettled
    && (await lane.client.getState()).isSettled, "the original native hosts settle after ingress replay");
  assert.equal((await head.client.getState()).goal, null, "Explicit SUPER planning must not silently create a goal");
  const currentLane = getLane();
  assert.deepEqual([currentLane.pid, currentLane.generation, currentLane.sessionId, currentLane.sessionFile],
    [resident.pid, resident.generation, resident.sessionId, resident.sessionFile]);
  assert.equal(metadata.get(voiceKey)?.value, mentorReceipt, "Later requests and ingress replay do not mutate the durable style");
  assert.deepEqual(messenger.sent.map(({ id, sourceId, text, route, replyTo }) => ({ id, sourceId, text, route, replyTo }))
    .sort((a, b) => a.id.localeCompare(b.id)), expected.map(({ id, sourceId, text, original }) => ({
    id, sourceId, text, route: original.route, replyTo: { route: original.route, messageId: original.id },
  })).sort((a, b) => a.id.localeCompare(b.id)), "Only the expected kickoff and route-bound replies reach the recorder");
  assert.deepEqual(outputs.all().sort((a, b) => a.id.localeCompare(b.id)),
    expected.map(({ id }) => ({ id, state: "sent", remote_id: `gateway-native-receipt:${id}` })).sort((a, b) => a.id.localeCompare(b.id)),
    "Every externally observed send has one durable receipt");

  const headEntries = parseSessionEntries(await readFile(mainPaths.sessionFile, "utf8"));
  const laneEntries = parseSessionEntries(await readFile(resident.sessionFile, "utf8"));
  const headIds = [oldHead.id, opening.id, `report:${opened}`, editorUpdate.id, editorHead.id, oneOff.id, mentorUpdate.id,
    mentorHead.id, negated.id, manager.id, `report:${handoff(manager)}`, child.id, workflow.id];
  const laneIds = [opened, ...[oldLane, editorLane, mentorLane, manager, steer].map(handoff)];
  const modelRows: SoulProviderWitness[] = (await readFile(join(root, soulWitnessFile), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const profiles = [soulProfiles.plain, editorial, mentoring] as const;
  const conceptOnly = profiles.map(({ style }) => renderReplyVoice({ ...editorial.style, concept: style.concept }));
  assert.equal(new Set(conceptOnly).size, profiles.length, "Each concept changes provider guidance with every other choice held fixed");
  const voiceByRevision = profiles.map(({ style }) => soulDigest(renderReplyVoice(style)));
  assertSoulProviderRows(modelRows, {
    head: { ids: headIds, beforeReopen: headState.hostPid, pid: reopened.hostPid },
    lane: { ids: laneIds, pid: resident.pid },
  }, voiceByRevision);
  const durableUsers = [...nativeUsers(headEntries), ...nativeUsers(laneEntries)];
  const voiceLines = new Set(modelRows.flatMap(row => row.voiceLines));
  const assertNoVoice = (text: string) => {
    assert(!text.includes(soulVoiceOpen) && !text.includes(soulVoiceClose), "Ephemeral voice tags entered a durable user message");
    assert(!text.includes("omp-superagent-reply-voice:"), "Private admission token entered a durable user message");
    assert(!text.split("\n").some(line => voiceLines.has(soulDigest(line.trim()))), "A provider-only voice directive entered a durable user message");
  };
  for (const text of durableUsers) assertNoVoice(text);
  assert.deepEqual(nativeUsers(headEntries).map(text => nativeRequestEnvelope(text)?.requestId), headIds);
  assert.deepEqual(nativeUsers(laneEntries).map(text => nativeRequestEnvelope(text)?.requestId), laneIds);
  const nativeNotices = (entries: readonly FileEntry[]) => entries.flatMap((entry, index) => {
    if (entry.type !== "custom_message" || !["ultrathink-notice", "orchestrate-notice", "workflow-notice", "jevify-notice"].includes(entry.customType)) return [];
    return [{ notice: entry.customType, owner: nativeRequestEnvelope(nativeUsers(entries.slice(index + 1))[0] ?? "")?.requestId }];
  });
  assert.deepEqual(nativeNotices(headEntries), [{ notice: "ultrathink-notice", owner: workflow.id }]);
  assert.deepEqual(nativeNotices(laneEntries), []);
  for (const source of originals.values()) {
    const row = input.get(source.id);
    assert(row);
    const record: InputRecord = JSON.parse(row.data);
    assert.equal(record.text, source.text);
    assert.deepEqual(record.route, source.route);
    assert.equal(record.workflow?.name ?? null, source.id === workflow.id ? "super-plan" : null);
    assertNoVoice(record.text);
  }
  const attempts = nativeJournalDispatches(headEntries).filter(call => call.name === "soul_update" && call.mode === "execute");
  assert.deepEqual(attempts.map(call => ({ scope: call.result.toolCallId.split(":").slice(0, 3).join(":"), ok: call.ok })), [
    { scope: `soul-proof:${editorUpdate.id}:soul_update`, ok: true },
    { scope: `soul-proof:${oneOff.id}:soul_update`, ok: false },
    { scope: `soul-proof:${mentorUpdate.id}:soul_update`, ok: true },
    { scope: `soul-proof:${negated.id}:soul_update`, ok: false },
  ], "Stock OMP journal must show both writes and the refused attempts");
  for (const refused of attempts.filter(call => !call.ok))
    assert.match(soulText(refused.result.content), /Reply voice changes require a fresh, explicit owner request to HEAD/);
  assert.deepEqual(attempts.filter(call => call.ok).map(call => ({ args: call.args, result: JSON.parse(soulText(call.result.content)) })), [
    { args: { sourceId: editorUpdate.id }, result: editorial },
    { args: { sourceId: mentorUpdate.id }, result: mentoring },
  ], "Both native write acknowledgements match the exact profile revisions read from SQLite");

  await gateway.stop();
  await head.exited;
  assert.equal((await lane.request({ type: "shutdown_host" })).success, true);
  await lane.exited;
  await waitForFixtureProcessExit([headState.hostPid, headState.adapterOwnerPid, reopened.hostPid, reopened.adapterOwnerPid,
    resident.pid, laneState.adapterOwnerPid]);
  for (const sessionFile of [mainPaths.sessionFile, resident.sessionFile]) {
    const journal = parseSessionEntries(await readFile(sessionFile, "utf8"));
    const shutdowns = journal.flatMap(entry => {
      if (entry.type !== "custom" || entry.customType !== "omp-superagent-native-test") return [];
      const data: unknown = entry.data;
      assert(data && typeof data === "object" && "networkAttempts" in data);
      return [data.networkAttempts];
    });
    assert.deepEqual(shutdowns, sessionFile === mainPaths.sessionFile ? [0, 0] : [0]);
  }
  console.log(`NATIVE_SOUL_GATEWAY_PROOF ${JSON.stringify({ revision: mentoring.revision, controllerReopened: true, headIds, laneIds, sends: expected.length, networkAttempts: 0 })}`);
}
