import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { test } from "bun:test";
import type { GatewayRestartRecord, Inbound, OutputRecord, Route } from "../src/contracts";
import { requireGateway } from "../src/gateway-native";
import type { GatewayStatus } from "../src/gateway-wire";
import { waitForFixtureProcessExit } from "./fixtures/host-fixture-processes";
import { gatewayFixture, type Head, until } from "./fixtures/native-rust-gateway";

const nativeTest = process.env.OMP_SUPERAGENT_NATIVE_TEST === "1" ? test : test.skip;
const route: Route = { platform: "discord", accountId: "2", authorityId: "1", guildId: "3", channelId: "4", threadId: null };
type SendReceipt = { readonly remoteId: string; readonly output: OutputRecord };
type NativeRustGateway = ReturnType<typeof gatewayFixture>;

async function withNativeRustGateway(proof: (fixture: NativeRustGateway) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(await realpath("/tmp"), "osrg-"));
  const fixture = gatewayFixture(root);
  let succeeded = false;
  try {
    await mkdir(fixture.home, { mode: 0o700 });
    const preflight = await fixture.sdk("prepare");
    console.log(preflight.stdout.trim());
    assert(!existsSync(fixture.sessionFile), "Initial startup must materialize its own stock OMP session");
    await proof(fixture);
    succeeded = true;
  } catch (error) {
    throw new Error(`Native Rust Gateway proof failed; retained config, SQLite and private logs: ${root}`, { cause: error });
  } finally {
    await fixture.cleanup(succeeded);
    if (succeeded) await rm(root, { recursive: true, force: true });
  }
}

function sampleIdleMemory(gatewayPid: number, head: Head): void {
  if (process.env.OMP_TEST_GATEWAY_IDLE_RSS !== "1") return;
  // Sample only after the real Host confirms it is settled. ps's RSS is KiB
  // per process, not heap or unique physical memory. Don't sum or gate it.
  // Compare like-for-like OS, architecture, build profile and stock version.
  const pids = [gatewayPid, head.ownerPid, head.pid];
  const sample = Bun.spawnSync(["/bin/ps", "-o", "pid=", "-o", "rss=", "-p", pids.join(",")]);
  assert.equal(sample.exitCode, 0, sample.stderr.toString());
  const rows = new Map(sample.stdout.toString().trim().split("\n").map(row => {
    const [pid, rss] = row.trim().split(/\s+/).map(Number);
    assert(pid && rss, `Expected a resident process, got ${row}`);
    return [pid, rss] as const;
  }));
  // Darwin top MEM is a footprint reading, not the same metric as ps RSS.
  const footprints = new Map<number, string>();
  if (process.platform === "darwin") {
    const top = Bun.spawnSync(["/usr/bin/top", "-l", "1", "-stats", "pid,mem",
      ...pids.flatMap(pid => ["-pid", String(pid)])]);
    assert.equal(top.exitCode, 0, top.stderr.toString());
    for (const line of top.stdout.toString().split("\n")) {
      const [id, mem] = line.trim().split(/\s+/);
      const pid = Number(id);
      if (pids.includes(pid) && mem) footprints.set(pid, mem);
    }
    assert.equal(footprints.size, pids.length, "Darwin top did not report all three idle fixture PIDs");
  }
  const role = (pid: number) => {
    const rssKiB = rows.get(pid);
    assert(rssKiB, `Missing idle sample for owned PID ${pid}`);
    return { pid, rssKiB, ...(footprints.has(pid) ? { darwinTopMem: footprints.get(pid) } : {}) };
  };
  console.log(JSON.stringify({ idleMemory: { gateway: role(gatewayPid), rustOwner: role(head.ownerPid), stockOmp: role(head.pid) } }));
}

function input(id: string, text: string): Inbound {
  return { id, messageId: id, route, text, receivedAt: Date.now(), attachments: [] };
}

const headInput = (id: string) => input(id, `/head Native lifecycle request ${id}`);

function ledger<T>(fixture: NativeRustGateway, inspect: (db: Database) => T): T {
  const db = new Database(join(fixture.root, "coordination.sqlite"), { readonly: true, strict: true });
  try { return inspect(db); }
  finally { db.close(); }
}

function meta(db: Database, key: string): string | undefined {
  return db.query<{ value: string }, [string]>("SELECT value FROM metadata WHERE key=?").get(key)?.value;
}

async function sendReceipts(fixture: NativeRustGateway): Promise<readonly SendReceipt[]> {
  return (await readFile(join(fixture.root, "adapter-output.jsonl"), "utf8")).trim().split("\n")
    .map((line): SendReceipt => JSON.parse(line));
}

async function verifyDelivery(fixture: NativeRustGateway, id: string, effectId?: string): Promise<string> {
  const output = await until(() => ledger(fixture, db => {
    const state = db.query<{ state: string }, [string]>("SELECT state FROM inputs WHERE id=?").get(id)?.state;
    const rows = db.query<{ id: string; state: string; remote_id: string | null }, [string, string | null, string | null]>(
      "SELECT id,state,remote_id FROM outputs WHERE source_id=? AND (? IS NULL OR id=?)").all(id, effectId ?? null, effectId ?? null);
    assert(rows.length <= 1, `Request ${id} delivered multiple replies for ${effectId ?? "its model turn"}`);
    const [row] = rows;
    if (state === "done" && row?.state === "sent") return row;
  }), `durable input completion and sent output for ${effectId ?? id}`);
  await until(() => ledger(fixture, db => {
    const event = db.query<{ delivery_error: string | null; delivered: number }, [string]>(
      "SELECT delivery_error,delivered_at IS NOT NULL AS delivered FROM gateway_events WHERE identity=?").get(`message:${id}`);
    if (event?.delivered === 1) {
      assert.equal(event.delivery_error, null);
      return event;
    }
  }), `accepted native Gateway ingress receipt for ${id}`);
  const seen = (await sendReceipts(fixture)).filter(receipt =>
    receipt.output.sourceId === id && (!effectId || receipt.output.id === effectId));
  assert.equal(seen.length, 1);
  const [receipt] = seen;
  assert(receipt);
  assert.deepEqual({ id: receipt.output.id, remoteId: receipt.remoteId,
    route: receipt.output.route, replyTo: receipt.output.replyTo },
  { id: output.id, remoteId: output.remote_id, route, replyTo: { route, messageId: id } });
  return receipt.output.text;
}

async function verifyTranscript(fixture: NativeRustGateway, heads: readonly Head[], requests: readonly string[]): Promise<void> {
  assert.deepEqual(JSON.parse((await fixture.sdk("transcript")).stdout), {
    requests,
    shutdowns: heads.map(({ pid, sessionId }) => ({ pid, sessionId, networkAttempts: 0 })),
  });
}

nativeTest("native Gateway stops only settled work and resumes the original stock OMP session", () =>
  withNativeRustGateway(async fixture => {
    const nativeConfig = join(fixture.root, "agent", "config.yml");
    const enabledSettings = JSON.parse(await readFile(nativeConfig, "utf8"));
    const globallyOff = JSON.stringify({ ...enabledSettings, memory: { backend: "off" } });
    await writeFile(nativeConfig, globallyOff);
    const first = await fixture.start();
    assert.deepEqual(Bun.YAML.parse(await readFile(nativeConfig, "utf8")), enabledSettings,
      "An owned startup repairs only the globally disabled memory setting");
    sampleIdleMemory(first.gatewayPid, first.head);
    // Omit the bot credential: a mistaken new launch cannot reach the network.
    await writeFile(nativeConfig, globallyOff);
    const reused = JSON.parse((await fixture.run([await requireGateway(), "launch", "--config", fixture.config])).stdout) as GatewayStatus;
    assert.equal(reused.gateway.pid, first.gatewayPid);
    assert.equal(reused.head.pid, first.head.pid);
    assert.equal(await readFile(nativeConfig, "utf8"), globallyOff, "A redundant launch must not write memory settings");
    await writeFile(nativeConfig, JSON.stringify(enabledSettings));
    await fixture.deliver(headInput("201"));
    assert.equal(await verifyDelivery(fixture, "201"), "HEAD:201");
    assert.deepEqual(await fixture.snapshot("settled"), first.head);
    await fixture.stop(first);

    const second = await fixture.start();
    assert.notEqual(second.head.pid, first.head.pid);
    assert.notEqual(second.head.ownerPid, first.head.ownerPid);
    assert.equal(second.head.sessionId, first.head.sessionId);
    sampleIdleMemory(second.gatewayPid, second.head);
    await fixture.deliver(headInput("207"));
    await until(() => existsSync(join(fixture.root, "entered-207")) || undefined, "the held offline model turn");
    assert.deepEqual(await fixture.snapshot("streaming"), second.head);
    const refusal = await fixture.cli("stop", 1);
    assert.match(refusal.stderr, /Host is busy\b/);
    assert.deepEqual(await fixture.snapshot("streaming"), second.head);
    const status = await fixture.cliStatus();
    assert(status, "Busy refusal must retain the original Gateway");
    assert.equal(status.gateway.pid, second.gatewayPid);
    assert.equal(status.gateway.stopping, false);
    assert.equal(status.head.pid, second.head.pid);
    await fixture.releaseBusy();
    assert.equal(await verifyDelivery(fixture, "207"), "HEAD:207");
    assert.deepEqual(await fixture.snapshot("settled"), second.head);
    await fixture.stop(second);
    assert.equal(await verifyDelivery(fixture, "201"), "HEAD:201");
    assert.deepEqual((await sendReceipts(fixture)).map(receipt => receipt.output.sourceId), ["201", "207"]);
    await verifyTranscript(fixture, [first.head, second.head], ["201", "207"]);
  }), 300_000);

nativeTest("authorized messenger /restart accepts compatible config drift and hands off once to the same stock session", () =>
  withNativeRustGateway(async fixture => {
    const first = await fixture.start();
    await fixture.deliver(headInput("201"));
    assert.equal(await verifyDelivery(fixture, "201"), "HEAD:201");
    const cold = await fixture.observeModel();
    assert.deepEqual(cold.head, first.head);

    // Change a real native launch setting after the original daemon loaded it.
    const originalConfig = await readFile(fixture.config, "utf8");
    const nextConfig = JSON.stringify({ ...JSON.parse(originalConfig), maxSubagents: 4 });
    assert.notEqual(nextConfig, originalConfig);
    await writeFile(fixture.config, nextConfig);
    const nativeConfig = join(fixture.root, "agent", "config.yml");
    const enabledSettings = JSON.parse(await readFile(nativeConfig, "utf8"));
    await writeFile(nativeConfig, JSON.stringify({ ...enabledSettings, memory: { backend: "off" } }));
    const acceptedHash = createHash("sha256").update(nextConfig).digest("hex");
    const restart = input("211", "/restart");
    await fixture.deliver(restart);
    assert.match(await verifyDelivery(fixture, restart.id, "211:restart-ack"), /ACK, not restart completion/);
    const handoff = await until(() => ledger(fixture, db => {
      const saved = meta(db, "gateway:restart");
      if (!saved) return;
      const record: GatewayRestartRecord = JSON.parse(saved);
      assert(!["refused", "failed", "uncertain"].includes(record.state), saved);
      if (record.state === "started") return record;
    }), "native restart runner's durable started receipt");
    assert.equal(handoff.inputId, restart.id);
    assert.equal(handoff.ackOutputId, "211:restart-ack");
    assert.equal(handoff.gatewayPid, first.gatewayPid);
    assert.equal(handoff.headPid, first.head.pid);
    assert.equal(handoff.sessionId, first.head.sessionId);
    assert.equal(handoff.sessionFile, first.head.sessionFile);
    assert(handoff.successorPid && handoff.replacementPid, "Native handoff did not record both replacement PIDs");
    const runner = ledger(fixture, db => {
      const saved = meta(db, `gateway:restart-plan:${handoff.requestId}`);
      assert(saved);
      const plan: { configHash: string; runnerPid: number; runnerReady: boolean; launchPid: number } = JSON.parse(saved);
      assert.equal(plan.configHash, acceptedHash);
      assert.equal(plan.runnerReady, true);
      assert.equal(plan.launchPid, handoff.successorPid);
      return plan.runnerPid;
    });
    assert.equal(new Set([first.gatewayPid, first.head.pid, runner, handoff.successorPid, handoff.replacementPid]).size, 5);
    assert.deepEqual(await fixture.detached(), [
      { role: "runner", pid: runner }, { role: "successor", pid: handoff.successorPid },
    ]);
    await fixture.initialExit();
    await fixture.headExit(first.head);
    await waitForFixtureProcessExit([runner]);
    const successor = await fixture.ready(handoff.successorPid);
    assert.deepEqual(Bun.YAML.parse(await readFile(nativeConfig, "utf8")), enabledSettings,
      "The authenticated restart leaves the native profile with enabled memory");
    assert.equal(successor.head.pid, handoff.replacementPid);
    assert.notEqual(successor.head.ownerPid, first.head.ownerPid);
    assert.equal(successor.head.sessionId, first.head.sessionId);
    const resumed = await fixture.observeModel();
    assert.deepEqual(resumed.head, successor.head);
    const result = await verifyDelivery(fixture, restart.id, "211:restart-result");
    assert.match(result, /replacement HEAD is initialized and ready/,
      `Restart result: ${result}\nPublic get_state cold/resumed: ${JSON.stringify({ cold, resumed })}`);

    // Redeliver the exact authorized wire event after the replacement is ready.
    await fixture.deliver(restart);
    await fixture.deliver(headInput("212"));
    assert.equal(await verifyDelivery(fixture, "212"), "HEAD:212");
    assert.deepEqual(await fixture.snapshot("settled"), successor.head);
    await fixture.stop(successor);
    assert.deepEqual((await sendReceipts(fixture)).map(receipt => receipt.output.sourceId), ["201", "211", "211", "212"]);
    assert.deepEqual((await fixture.detached()).map(process => process.pid), [runner, handoff.successorPid]);
    assert.equal(ledger(fixture, db => db.query<{ count: number }, []>(
      "SELECT count(*) AS count FROM metadata WHERE key LIKE 'gateway:restart:%'").get()?.count), 1);
    await verifyTranscript(fixture, [first.head, successor.head], ["201", "212"]);
  }), 300_000);
