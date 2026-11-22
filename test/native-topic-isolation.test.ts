import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { routeKey, type Inbound, type Lane, type OutputRecord, type Route } from "../src/contracts";
import { gatewayCall } from "../src/gateway-protocol";
import type { GatewayStatus } from "../src/gateway-wire";
import { assertResidentFixtureOwner, waitForFixtureProcessExit } from "./fixtures/host-fixture-processes";
import { offlineMnemopi } from "./fixtures/native-memory";
import { gatewayFixture, until, type Head } from "./fixtures/native-rust-gateway";
import type { TopicCheckpoint, TopicJournal, TopicMemorySeed, TopicRecallWitness } from "./fixtures/topic-isolation-native";

const nativeTest = process.env.OMP_SUPERAGENT_NATIVE_TEST === "1" ? test : test.skip;
const channel = { platform: "discord", accountId: "2", authorityId: "1", guildId: "3", channelId: "4" } as const;
const topicA = { ...channel, threadId: "50" } satisfies Route;
const topicB = { ...channel, threadId: "51" } satisfies Route;
const topicC = { ...channel, threadId: "52" } satisfies Route;
const continuationParent = { ...channel, channelId: "5", threadId: null } satisfies Route;
const fixtureDir = join(import.meta.dir, "fixtures");
type Fixture = ReturnType<typeof gatewayFixture>;
type SendReceipt = { readonly remoteId: string; readonly output: OutputRecord };
type Turn = { readonly input: Inbound; readonly answer: string; readonly destination?: Route };
type RotationReceipt = { readonly stage: string; readonly original: Head; readonly sessionFile: string;
  readonly replacementSessionId: string; readonly replacementOwnerPid: number };
type JournalIdentity = { readonly sessionId: string | null; readonly sessionFile: string };
type NativeRead = {
  readonly checkpoint: TopicCheckpoint; readonly journal: TopicJournal;
  readonly "seed-memory": TopicMemorySeed; readonly "recall-witness": TopicRecallWitness;
};

function inbound(id: string, route: Route, text: string): Inbound {
  return { id, messageId: String(90_000 + Number(id)), route, text, receivedAt: Date.now(), attachments: [] };
}

function ledger<T>(fixture: Fixture, inspect: (db: Database) => T): T {
  const db = new Database(join(fixture.root, "coordination.sqlite"), { readonly: true, strict: true });
  try { return inspect(db); }
  finally { db.close(); }
}

function lane(fixture: Fixture, route: Route): Lane {
  const row = ledger(fixture, db => db.query<{ data: string }, [string]>(
    "SELECT data FROM lanes WHERE route_key=?",
  ).get(routeKey(route)));
  assert(row, `Missing automatically created topic for ${routeKey(route)}`);
  return JSON.parse(row.data);
}

async function nativeRead<M extends keyof NativeRead>(fixture: Fixture, mode: M, path: string): Promise<NativeRead[M]> {
  const result = await fixture.run([process.execPath, "--no-env-file", "--no-install", join(fixtureDir, "topic-isolation-native.ts"), mode, path]);
  return JSON.parse(result.stdout);
}

async function sendTurn(fixture: Fixture, turn: Turn): Promise<void> {
  await fixture.deliver(turn.input);
  await waitForAnswer(fixture, turn);
}

async function waitForAnswer(fixture: Fixture, { input, answer, destination }: Turn): Promise<void> {
  await until(() => ledger(fixture, db => {
    const source = db.query<{ state: string }, [string]>("SELECT state FROM inputs WHERE id=?").get(input.id);
    assert(source?.state !== "uncertain" && source?.state !== "cancelled", `Unsettled source ${input.id}: ${source?.state}`);
    const event = db.query<{ delivered_at: number | null; delivery_error: string | null }, [string]>(
      "SELECT delivered_at,delivery_error FROM gateway_events WHERE identity=?",
    ).get(`message:${input.id}`);
    assert(!event?.delivery_error, `Gateway rejected ${input.id}: ${event?.delivery_error}`);
    const replies = db.query<{ id: string; state: string; text: string; remote_id: string | null;
      route: string; reply_to: string | null }, [string, string]>(
      "SELECT id,state,text,remote_id,route,reply_to FROM outputs WHERE source_id=? AND id<>?",
    ).all(destination ? `handoff:${input.id}:lane` : input.id, `${input.id}:kickoff`);
    assert(replies.length <= 1, `Multiple outbox replies to ${input.id}`);
    const [output] = replies;
    if (source?.state !== "done" || event?.delivered_at == null || output?.state !== "sent") return;
    assert.equal(output.text, answer);
    assert.equal(output.remote_id, `fixture:${output.id}`);
    assert.deepEqual(JSON.parse(output.route), destination ?? input.route);
    assert.deepEqual(output.reply_to === null ? null : JSON.parse(output.reply_to),
      destination ? null : { route: input.route, messageId: input.messageId });
    return output;
  }), `accepted ingress and sent result for ${input.id}`);
}

async function verifyJournal(fixture: Fixture, owner: JournalIdentity, expected: {
  readonly cwd: string; readonly turns: readonly Turn[];
}): Promise<TopicJournal> {
  const journal = await nativeRead(fixture, "journal", owner.sessionFile);
  assert.equal(journal.sessionId, owner.sessionId);
  assert.equal(journal.cwd, expected.cwd);
  assert.deepEqual(journal.prompts.map(({ sourceId, route }) => ({ sourceId, route })),
    expected.turns.map(({ input }) => ({ sourceId: input.id, route: routeKey(input.route) })));
  assert.deepEqual(journal.replies, expected.turns.map(({ answer }) => answer));
  const receipts = ledger(fixture, db => journal.prompts.map(({ requestId }) => {
    assert(requestId);
    const input = db.query<{ request_id: string | null; state: string }, [string]>(
      "SELECT request_id,state FROM inputs WHERE id=?",
    ).get(requestId);
    assert(input?.state === "done" && input.request_id, `Missing native admission for ${requestId}`);
    return { id: input.request_id, status: "completed", sessionId: owner.sessionId, sessionFile: owner.sessionFile };
  }));
  assert.deepEqual(journal.results, receipts, `Native prompt results differ for ${owner.sessionFile}`);
  return journal;
}

nativeTest("stock topics stay isolated across HEAD rotation and recall-assisted continuation in new and bound threads", async () => {
  const root = await mkdtemp(join(await realpath("/tmp"), "osti-"));
  const fixture = gatewayFixture(root);
  let succeeded = false;
  try {
    await mkdir(fixture.home, { mode: 0o700 });
    const preflight = await fixture.sdk("prepare");
    console.log(preflight.stdout.trim());
    const config = await loadConfig(fixture.config);
    const provider = join(fixtureDir, "topic-isolation-provider.ts");
    const command = config.command.map(arg => arg === join(fixtureDir, "gateway-provider-extension.ts") ? provider : arg);
    assert(command.includes(provider), "The stock fixture launch must use its topic-specific offline provider");
    assert(config.discord);
    await writeFile(fixture.config, JSON.stringify({ ...config, command, maxHosts: 5, maxSubagents: 5,
      discord: { ...config.discord, allowedChannelIds: [...config.discord.allowedChannelIds, continuationParent.channelId] } }));
    const settingsFile = join(root, "agent", "config.yml");
    const settings: Record<string, unknown> = JSON.parse(await readFile(settingsFile, "utf8"));
    await writeFile(settingsFile, JSON.stringify({
      ...settings, ...offlineMnemopi, compaction: { enabled: false },
      mnemopi: { ...offlineMnemopi.mnemopi, scoping: "per-project", dbPath: join(root, "agent", "topic-memory", "mnemopi.db") },
    }));
    const repoA = "work-a";
    const workA = join(root, repoA);
    const workB = join(root, "work-b");
    await mkdir(workA, { mode: 0o700 });
    await mkdir(workB, { mode: 0o700 });
    await fixture.run(["git", "init", "--quiet", workA]);

    const trace = `[auth-trace:${crypto.randomUUID()}]`;
    const canary = `[unrelated-topic-canary:${crypto.randomUUID()}]`;
    const privateMemory = `[memory-only:${crypto.randomUUID()}]`;
    // A reference in past work must never read the same name in a later
    // destination. It exists only in B, not in the original workspace.
    const referenceWitness = `[historical-file:${crypto.randomUUID()}]`;
    await writeFile(join(workB, "auth-notes.txt"), referenceWitness);
    const originalTask = `Investigate the login authentication bug. Inspect @auth-notes.txt for the QA reproduction trace: ${trace}.`;
    const a1 = { input: inbound("301", topicA,
      `cwd: ${workA}\n${originalTask}\n[topic-isolation:a1]`),
      answer: `topic-proof:lane:${workA}:a1` };
    const b1 = { input: inbound("302", topicB, `cwd: ${workB}\nStart work in B.\n[topic-isolation:b1]`),
      answer: `topic-proof:lane:${workB}:b1` };
    const a2 = { input: { ...inbound("303", topicA, `Continue A. Separate documentation note: ${canary}\n[topic-isolation:a2]`),
      reply: { messageId: "70123", authorId: "999", text: "/head Move this request out of its original topic." } },
      answer: `topic-proof:lane:${workA}:a1,a2` };
    const b2 = { input: inbound("304", topicB, "Continue B.\n[topic-isolation:b2]"),
      answer: `topic-proof:lane:${workB}:b1,b2` };
    const a3 = { input: inbound("305", topicA, "Continue A again.\n[topic-isolation:a3]"),
      answer: `topic-proof:lane:${workA}:a1,a2,a3` };
    const b3 = { input: inbound("306", topicB, "Continue B again.\n[topic-isolation:b3]"),
      answer: `topic-proof:lane:${workB}:b1,b2,b3` };
    const headBefore = { input: inbound("307", topicA, "/head Coordinate from A.\n[topic-isolation:head-before]"),
      answer: `topic-proof:head:${config.headCwd}:head-before` };
    const a4 = { input: inbound("308", topicA, "Continue A after the global HEAD changes.\n[topic-isolation:a4]"),
      answer: `topic-proof:lane:${workA}:a1,a2,a3,a4` };
    const headAfter = { input: inbound("309", { ...channel, threadId: null }, `Explain the ${repoA} change.\n[topic-isolation:head-after]`),
      answer: `topic-proof:head:${config.headCwd}:head-after` };
    const c1 = { input: inbound("310", topicC, `cwd: ${workA}\nCheck the ${repoA} repository.\n[topic-isolation:c1]`),
      answer: `topic-proof:lane:${workA}:c1` };

    const first = await fixture.start();
    const before = [a1, b1, a2, b2, a3, headBefore];
    for (const turn of before) await sendTurn(fixture, turn);
    const a = lane(fixture, topicA);
    const b = lane(fixture, topicB);
    assert.equal(a.repoRoot, workA, "Topic A must establish the repository before topic C names it");
    assert(a.sessionId && b.sessionId);
    assert.equal(new Set([a.sessionId, b.sessionId, first.head.sessionId]).size, 3);
    assert.equal(new Set([a.sessionFile, b.sessionFile, first.head.sessionFile]).size, 3);
    const checkpoint = await nativeRead(fixture, "checkpoint", join(root, "run", "main.sock"));
    const originalSelection = await fixture.observeModel();
    assert.deepEqual(checkpoint.identity, first.head);
    assert.deepEqual(originalSelection.head, first.head);
    assert.deepEqual(originalSelection.model, { provider: "gateway-native", id: "local" });
    assert(checkpoint.isSettled && checkpoint.contextPercent !== null && checkpoint.contextPercent >= 50,
      `Expected native context over the rotation threshold: ${JSON.stringify(checkpoint)}`);

    await fixture.deliver(b3.input);
    const inFlight = join(root, "topic-b-in-flight");
    await until(() => existsSync(inFlight) || undefined, "topic B executing in its original stock process");
    assert.equal(Number(await readFile(inFlight, "utf8")), b.pid);
    await writeFile(join(root, `advance-head-clock.${first.head.pid}`), "", { mode: 0o600, flag: "wx" });
    const replacement = await until(async () => {
      const row = ledger(fixture, db => db.query<{ value: string }, []>(
        "SELECT value FROM metadata WHERE key='gateway:head-rotation'",
      ).get());
      if (!row) return;
      const receipt: RotationReceipt = JSON.parse(row.value);
      assert.notEqual(receipt.stage, "refused", `Native owner refused rotation: ${row.value}`);
      if (receipt.stage !== "complete") return;
      const status = await gatewayCall<GatewayStatus>(join(root, "run", "gateway.sock"), "/status");
      assert.equal(status.gateway.pid, first.gatewayPid, "Rotation keeps the real native daemon");
      if (status.gateway.admissionReady && status.head.ready
        && status.head.initialization?.sessionId === receipt.replacementSessionId) return receipt;
    }, "fresh native HEAD rotation and ingress readiness");
    assert.deepEqual(replacement.original, first.head);
    const selection = await fixture.observeModel();
    const newHead = selection.head;
    assert.deepEqual(selection.model, originalSelection.model);
    assert.equal(selection.configuredDefault, originalSelection.configuredDefault);
    // Both readings are from this fixture's non-reasoning model; idle effort
    // can be represented as absent or explicitly off by stock OMP.
    assert.equal(selection.thinkingLevel.value ?? "off", originalSelection.thinkingLevel.value ?? "off");
    assert.notEqual(newHead.pid, first.head.pid);
    assert.notEqual(newHead.sessionId, first.head.sessionId);
    assert.notEqual(newHead.sessionFile, first.head.sessionFile);
    assert.equal(newHead.sessionId, replacement.replacementSessionId);
    assert.equal(newHead.sessionFile, replacement.sessionFile);
    assert.equal(newHead.ownerPid, replacement.replacementOwnerPid);
    await assertResidentFixtureOwner(root, { nativePid: newHead.pid, ownerPid: newHead.ownerPid });
    await waitForFixtureProcessExit([first.head.pid, first.head.ownerPid]);

    const activeB = lane(fixture, topicB);
    assert.deepEqual([activeB.pid, activeB.sessionId, activeB.generation], [b.pid, b.sessionId, b.generation]);
    await writeFile(join(root, "release-topic-b"), "", { mode: 0o600, flag: "wx" });
    await waitForAnswer(fixture, b3);
    await fixture.deliver(a3.input); // Exact original source replay after global replacement.
    await sendTurn(fixture, a4);
    await sendTurn(fixture, headAfter);
    const resumed = lane(fixture, topicA);
    assert.deepEqual([resumed.id, resumed.sessionId, resumed.sessionFile], [a.id, a.sessionId, a.sessionFile]);
    const intact = lane(fixture, topicB);
    assert.deepEqual([intact.id, intact.sessionId, intact.sessionFile], [b.id, b.sessionId, b.sessionFile]);
    await sendTurn(fixture, c1);
    const c = lane(fixture, topicC);
    assert(c.sessionId);
    assert.equal(new Set([c.sessionId, resumed.sessionId, intact.sessionId, first.head.sessionId, newHead.sessionId]).size, 5);
    assert.equal(new Set([c.sessionFile, resumed.sessionFile, intact.sessionFile, first.head.sessionFile, newHead.sessionFile]).size, 5);
    const earlier = await verifyJournal(fixture, resumed, { cwd: workA, turns: [a1, a2, a3, a4] });
    const originalEntry = earlier.prompts.find(prompt => prompt.sourceId === a1.input.id);
    assert(originalEntry);
    for (const [owner, cwd, turns] of [
      [intact, workB, [b1, b2, b3]], [c, workA, [c1]],
      [first.head, config.headCwd, [headBefore]], [newHead, config.headCwd, [headAfter]],
    ] as const) await verifyJournal(fixture, owner, { cwd, turns });

    const receipts: SendReceipt[] = (await readFile(join(root, "adapter-output.jsonl"), "utf8"))
      .trim().split("\n").map(line => JSON.parse(line));
    const openings = [a1.input, b1.input, c1.input];
    const kickoff = new Set(openings.map(input => `${input.id}:kickoff`));
    assert.deepEqual(receipts.filter(({ output }) => kickoff.has(output.id)).map(({ output }) => ({
      route: output.route, replyTo: output.replyTo,
    })), openings.map(({ route, messageId }) => ({ route, replyTo: { route, messageId } })));
    assert.deepEqual(receipts.filter(({ output }) => !kickoff.has(output.id)).map(({ output, remoteId }) => {
      assert.equal(remoteId, `fixture:${output.id}`);
      return { sourceId: output.sourceId, route: output.route, replyTo: output.replyTo, text: output.text };
    }), [...before, b3, a4, headAfter, c1].map(({ input, answer }) => ({
      sourceId: input.id, route: input.route, replyTo: { route: input.route, messageId: input.messageId }, text: answer,
    })));

    const journals = await Promise.all([resumed, intact, c, first.head, newHead].map(async ({ sessionFile }) =>
      ({ sessionFile, before: await readFile(sessionFile) })));
    const [sourceJournal] = journals;
    assert(sourceJournal?.before.includes(trace) && sourceJournal.before.includes(canary), "Source journal lacks its history witnesses");
    const alias = "velvet turnstile";
    assert(journals.every(journal => !journal.before.includes(alias) && !journal.before.includes(privateMemory)),
      "The paraphrase bridge and private mnemonic must start outside all candidate journals");
    const paraphrase = `Resume the ${alias}.`;
    const miss = inbound("311", continuationParent, paraphrase);
    await fixture.deliver(miss);
    await until(() => ledger(fixture, db => {
      const event = db.query<{ delivered_at: number | null; delivery_error: string | null }, [string]>(
        "SELECT delivered_at,delivery_error FROM gateway_events WHERE identity=?",
      ).get(`message:${miss.id}`);
      assert(!event?.delivery_error, `Gateway rejected the empty-bank control: ${event?.delivery_error}`);
      const output = db.query<{ state: string }, [string]>("SELECT state FROM outputs WHERE id=?").get(`${miss.id}:workspace`);
      if (event?.delivered_at == null || output?.state !== "sent") return;
      const metadata = (key: string) => db.query<{ value: string }, [string]>("SELECT value FROM metadata WHERE key=?").get(key)?.value;
      assert.equal(metadata(`topic-history:${miss.id}`), "[]", "The paraphrase must not match by journal alone");
      assert.equal(metadata(`topic-history-unavailable:${miss.id}`), undefined, "Empty recall must be a healthy miss");
      assert(!db.query("SELECT id FROM inputs WHERE id=?").get(`handoff:${miss.id}:lane`), "No handoff may follow the empty recall");
      return true;
    }), "a sent clarification for the same paraphrase with an empty head bank");
    for (const { sessionFile, before } of journals) {
      assert(before.equals(await readFile(sessionFile)), `Empty recall changed an earlier journal: ${sessionFile}`);
    }

    const memoryBridge = `The ${alias} is the nickname for the login authentication bug.`;
    const memory = `${memoryBridge} Journal excerpt: ${originalTask} Private mnemonic: ${privateMemory}.`;
    await writeFile(join(root, "topic-memory-seed.txt"), memory, { flag: "wx", mode: 0o600 });
    const seed = await nativeRead(fixture, "seed-memory", join(root, "run", "main.sock"));
    assert.deepEqual([seed.pid, seed.sessionId], [newHead.pid, newHead.sessionId]);
    const witnessPath = join(root, "topic-memory-seed.json");
    assert.deepEqual(await nativeRead(fixture, "recall-witness", witnessPath), {
      content: memory, recallCount: 0, lastRecalled: null,
    }, "The seed must not perform a recall itself");
    const headAfterSeed = await readFile(newHead.sessionFile);
    assert(!headAfterSeed.includes(privateMemory), "The seed must stay out of the HEAD journal");

    const continuation = inbound("312", continuationParent, paraphrase);
    const destination = { ...continuationParent, threadId: continuation.messageId } satisfies Route;
    const digest = createHash("sha256").update(trace).digest("hex");
    const continued = { input: continuation, destination,
      answer: `topic-proof:lane:${workA}:auth-continuation\nauth-trace:${digest}:bounded` };
    await sendTurn(fixture, continued);
    const fresh = lane(fixture, destination);
    assert(fresh.sessionId);
    assert.equal(new Set([fresh.sessionId, c.sessionId, resumed.sessionId, intact.sessionId, first.head.sessionId, newHead.sessionId]).size, 6);
    assert.equal(new Set([fresh.sessionFile, c.sessionFile, resumed.sessionFile, intact.sessionFile, first.head.sessionFile, newHead.sessionFile]).size, 6);
    const witness = await nativeRead(fixture, "recall-witness", witnessPath);
    assert.equal(witness.content, memory);
    assert.equal(witness.recallCount, 1, "The actual native lookup must recall the seeded row once");
    assert(witness.lastRecalled && Date.parse(witness.lastRecalled) >= continuation.receivedAt);
    const journal = await verifyJournal(fixture, fresh, { cwd: workA, turns: [continued] });
    const evidence = journal.prompts[0]?.previous;
    assert(evidence, "The new model turn must include previous-task evidence");
    assert(evidence.evidence.includes(originalTask) && evidence.sessionId === resumed.sessionId,
      "The new model turn must receive the earlier task's bounded native journal evidence");
    const matched = ledger(fixture, db => db.query<{ value: string }, [string]>(
      "SELECT value FROM metadata WHERE key=?",
    ).get(`topic-previous:${continuation.id}`));
    assert(matched);
    const { laneId, sessionId, entryId, evidenceHash } = JSON.parse(matched.value);
    assert.deepEqual({ laneId, sessionId, entryId, evidenceHash }, {
      laneId: resumed.id, sessionId: resumed.sessionId, entryId: originalEntry.entryId,
      evidenceHash: createHash("sha256").update(evidence.evidence).digest("hex"),
    });
    const destinationJournal = await readFile(fresh.sessionFile);
    assert(!destinationJournal.includes(canary) && !destinationJournal.includes(privateMemory)
      && !destinationJournal.includes(memoryBridge)
      && !destinationJournal.includes("Private mnemonic:"), "The continuation must depend on recall but carry only the journal evidence");
    for (const { sessionFile, before } of journals) {
      const expected = sessionFile === newHead.sessionFile ? headAfterSeed : before;
      assert(expected.equals(await readFile(sessionFile)), `Continuation modified an earlier native journal: ${sessionFile}`);
    }

    const effects = ledger(fixture, db => db.query<{ arguments: string; state: string; result: string | null }, []>(
      "SELECT arguments,state,result FROM gateway_effects WHERE operation='createThread'",
    ).all());
    assert.equal(effects.length, 1);
    const [effect] = effects;
    assert(effect?.result && effect.state === "complete", "Gateway did not record the authorized thread creation");
    const [parent, , messageId] = JSON.parse(effect.arguments);
    assert.deepEqual({ parent, messageId, result: JSON.parse(effect.result) }, {
      parent: continuationParent, messageId: continuation.messageId, result: { ok: true, value: destination },
    });

    const bound = { input: inbound("313", topicB, paraphrase),
      answer: `topic-proof:lane:${workB}:b1,b2,b3,auth-continuation\nauth-trace:${digest}:bounded` };
    await sendTurn(fixture, bound);
    await fixture.deliver(bound.input); // The same ingress cannot import evidence or run twice.
    const boundLane = lane(fixture, topicB);
    assert.deepEqual([boundLane.id, boundLane.sessionId, boundLane.sessionFile, boundLane.cwd],
      [intact.id, intact.sessionId, intact.sessionFile, workB]);
    const boundJournal = await verifyJournal(fixture, boundLane, { cwd: workB, turns: [b1, b2, b3, bound] });
    assert.deepEqual(boundJournal.prompts.at(-1)?.previous, evidence);
    assert(!(await readFile(boundLane.sessionFile, "utf8")).includes(referenceWitness),
      "A file reference in historical data expanded against the current lane's workspace");
    assert.equal((await nativeRead(fixture, "recall-witness", witnessPath)).recallCount, 2);
    for (const { sessionFile, before } of journals) {
      if (sessionFile === boundLane.sessionFile) continue;
      const expected = sessionFile === newHead.sessionFile ? headAfterSeed : before;
      assert(expected.equals(await readFile(sessionFile)), `Bound continuation modified another journal: ${sessionFile}`);
    }
    assert(destinationJournal.equals(await readFile(fresh.sessionFile)), "Bound continuation wrote to the unrelated new thread");
    assert.deepEqual(ledger(fixture, db => db.query<{ id: string }, []>("SELECT id FROM lanes ORDER BY id").all()).map(row => row.id),
      [resumed.id, intact.id, c.id, fresh.id].sort(), "Bound continuation must not create an extra lane");
    assert.deepEqual(ledger(fixture, db => db.query(
      "SELECT arguments,state,result FROM gateway_effects WHERE operation='createThread'",
    ).all()), effects, "Bound continuation must not create another thread");

    const ordinary = { input: inbound("314", continuationParent, `Inspect the ${alias}.`),
      answer: `topic-proof:head:${config.headCwd}:head-after,routing-check` };
    await sendTurn(fixture, ordinary);
    assert.equal((await nativeRead(fixture, "recall-witness", witnessPath)).recallCount, 3);
    const added = (await readFile(newHead.sessionFile)).subarray(headAfterSeed.length).toString();
    assert(added.includes(resumed.id) && added.includes(resumed.sessionId) && added.includes(originalEntry.entryId),
      "Ordinary HEAD routing must receive the prior managed session corroborating the recalled nickname");
    assert(![privateMemory, memoryBridge, canary, trace].some(text => added.includes(text)),
      "Routing hints must not copy raw recall, the prior task, or unrelated context into HEAD");
    assert.equal(ledger(fixture, db => db.query("SELECT id FROM lanes").all()).length, 4);

    await fixture.cli("stop");
    await fixture.initialExit();
    await waitForFixtureProcessExit([newHead.pid, newHead.ownerPid]);
    succeeded = true;
  } catch (error) {
    throw new Error(`Native topic isolation proof failed; retained private evidence at ${root}`, { cause: error });
  } finally {
    if (!succeeded) await writeFile(join(root, "release-topic-b"), "", { mode: 0o600 });
    await fixture.cleanup(succeeded);
    if (succeeded) await rm(root, { recursive: true, force: true });
  }
}, 300_000);
