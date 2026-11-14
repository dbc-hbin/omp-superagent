import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hostPaths, loadConfig } from "../src/config";
import type { GatewayRestartRecord, GatewayRestartRequest, Inbound, Messenger, Route } from "../src/contracts";
import { gatewayStatus, launchGateway, startGateway, stopGateway, type GatewayOptions, type GatewayService } from "../src/gateway";
import { processAlive, runGatewayRestart } from "../src/gateway-restart";
import { connect } from "../src/host";
import { main } from "../src/cli";
import { Store } from "../src/store";
import type { ManagedUlwStatus } from "../src/managed-ulw";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 12_000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error("Gateway lifecycle fixture timed out");
    await Bun.sleep(10);
  }
}
const route: Route = { platform: "discord", accountId: "1", authorityId: "2", guildId: null, channelId: "3", threadId: null };
async function fixture(updateManagedUlw?: () => Promise<ManagedUlwStatus>, options: Pick<GatewayOptions, "launchRestartRunner"> = {}) {
  const root = await mkdtemp(join(await realpath("/tmp"), "ogl-"));
  await chmod(root, 0o700);
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "config.json");
  await writeFile(path, JSON.stringify({ stateDir: root, headCwd: root, maxHosts: 2, maxSubagents: 4, idleMs: 1000,
    command: [process.execPath, fileURLToPath(new URL("./fixtures/gateway-host.ts", import.meta.url))],
    model: "provider/initial-model", discord: { tokenEnv: "GATEWAY_TEST_BOT_TOKEN", ownerId: "2", allowedGuildIds: [], allowedChannelIds: [] } }));
  await writeFile(`${path}.env`, "GATEWAY_TEST_BOT_TOKEN=isolated-test-secret\n", { mode: 0o600 });
  const config = await loadConfig(path);
  let handlers: Parameters<Messenger["start"]>[0] | undefined;
  let stopped = false;
  const messenger: Messenger = {
    async start(value) { handlers = value; }, async stop() { stopped = true; },
    async send() { return "remote"; }, async showApproval() { return "approval"; }, async dismissApproval() {},
    async createThread(destination) { return destination; }, async fetchAfter() { return null; },
    async openAttachment() { return new Response("fixture"); },
  };
  const saved = process.env.GATEWAY_TEST_BOT_TOKEN;
  process.env.GATEWAY_TEST_BOT_TOKEN = "isolated-test-secret";
  let service: GatewayService;
  try { service = await startGateway(config, { messenger, onError: () => {},
    managedUlwPath: fileURLToPath(new URL("./fixtures/managed-ulw", import.meta.url)), updateManagedUlw, ...options }); }
  finally {
    if (saved === undefined) delete process.env.GATEWAY_TEST_BOT_TOKEN;
    else process.env.GATEWAY_TEST_BOT_TOKEN = saved;
  }
  cleanups.push(async () => {
    await rm(join(root, "busy"), { force: true });
    await rm(join(root, "busy-shutdown"), { force: true });
    await rm(join(root, "ambiguous-shutdown"), { force: true });
    try { await service.stop(); }
    catch {
      const pid = service.status().head.pid;
      if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} }
      await service.close();
    }
  });
  await until(() => service.status().head.ready);
  expect(service.status().head.initialization).toMatchObject({ sessionId: "gateway-fixture-session", state: "complete" });
  return { root, config, service, get stopped() { return stopped; },
    async emit(id: string) {
      const input: Inbound = { id, route, messageId: id, text: id, receivedAt: Date.now(), attachments: [] };
      await handlers!.ready;
      await handlers!.message(input);
    } };
}

test("prepared Gateway starts its head while a source check is pending; failed check does not restart that host", async () => {
  const pending = Promise.withResolvers<ManagedUlwStatus>();
  const f = await fixture(() => pending.promise);
  const pid = f.service.status().head.pid;
  try {
    expect(f.service.status().gateway.ready).toBe(true);
    expect(f.service.status().head.ready).toBe(true);
    expect(f.service.status().ulw?.updating).toBe(true);
    pending.reject(new Error("isolated slow upstream failed"));
    await until(() => f.service.status().ulw?.updating === false);
    expect(f.service.status().ulw?.error).toBe("isolated slow upstream failed");
    expect(f.service.status().head.pid).toBe(pid);
    expect(f.service.status().head.ready).toBe(true);
  } finally {
    pending.resolve({ revision: null, packagePath: null, upstreamRevision: null, checkedAt: null, error: null, updating: false });
  }
});

test("Gateway owns one credential-free native head; busy CLI stop refuses, explicit stop cannot resurrect", async () => {
  const f = await fixture();
  const headStore = new Store(join(f.root, "coordination.sqlite"));
  headStore.close();
  const launches = (await readFile(join(f.root, "launches.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(launches).toHaveLength(1);
  expect(launches[0].credentialPresent).toBe(false);
  expect(launches[0].args).toContain("--session-settings");
  expect(launches[0].args).toContain("provider/initial-model");
  const pid = f.service.status().head.pid;
  await writeFile(join(f.root, "busy"), "busy");
  await expect(main(["stop", "main", "--config", f.config.path])).rejects.toThrow("Host is busy");
  expect(f.service.status().gateway.stopping).toBe(false);
  expect(f.service.status().head.pid).toBe(pid);
  expect(f.stopped).toBe(false);
  await rm(join(f.root, "busy"));
  await main(["stop", "main", "--config", f.config.path]);
  await until(() => f.stopped);
  await Bun.sleep(1100);
  expect((await readFile(join(f.root, "launches.jsonl"), "utf8")).trim().split("\n")).toHaveLength(1);
  expect(existsSync(join(f.root, "run", "gateway.sock"))).toBe(false);
});

test("confirmed-dead owned head restarts, offline input stays durable, and existing native model is not reset", async () => {
  const f = await fixture();
  const coordination = new Store(join(f.root, "coordination.sqlite"));
  const snapshot = { modelRoles: { default: "provider/preset-model", smol: "provider/small-model" }, defaultThinkingLevel: "low" };
  try {
    coordination.setMeta("main:sessionId", "gateway-fixture-session");
    coordination.setMeta("head:model-settings:gateway-fixture-session", JSON.stringify({ settings: snapshot, clearedRoles: ["slow"] }));
    coordination.setMeta("head:model-settings:unrelated-session", JSON.stringify({
      settings: { modelRoles: { default: "provider/wrong-session" } }, clearedRoles: [],
    }));
  } finally { coordination.close(); }
  const old = f.service.status().head.pid!;
  process.kill(old, "SIGKILL");
  await f.emit("offline-original-source");
  expect(f.service.status().gateway.pendingEvents).toBeGreaterThan(0);
  await until(() => f.service.status().head.pid !== old && f.service.status().head.ready);
  await until(async () => existsSync(join(f.root, "received.jsonl")) &&
    (await readFile(join(f.root, "received.jsonl"), "utf8")).includes("offline-original-source"));
  const launches = (await readFile(join(f.root, "launches.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(launches).toHaveLength(2);
  expect(launches[1].args).not.toContain("--model");
  expect(launches[1].args).not.toContain("--model-preset");
  expect(launches[1].config).toMatchObject({
    ...snapshot, modelRoles: { ...snapshot.modelRoles, slow: null },
  });
  const messages = (await readFile(join(f.root, "received.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(messages.map(message => message.id)).toEqual(["offline-original-source"]);
});

function seedRestart(root: string, pid: number, id = crypto.randomUUID()): GatewayRestartRequest {
  const request = { requestId: id, inputId: `input-${id}`, ackOutputId: `ack-${id}` };
  const store = new Store(join(root, "coordination.sqlite"));
  try {
    store.receive({ id: request.inputId, route, messageId: request.inputId, text: "/restart", receivedAt: Date.now(), attachments: [] },
      "main", { [`user-source:${request.inputId}`]: "true" });
    store.settle(request.inputId, "done");
    store.queueOutput({ id: request.ackOutputId, sourceId: request.inputId, route, text: "Restart acknowledged" });
    store.claimOutput(request.ackOutputId);
    store.finishOutput(request.ackOutputId, "sent", "remote-ack");
    store.setMeta("head:restart-fence", JSON.stringify({ ...request, ownerPid: pid,
      sessionId: "gateway-fixture-session", sessionFile: join(root, "sessions", "main", "session.jsonl"), state: "accepted",
      stopBoundary: store.getMeta("gateway:operator-stop") }));
  } finally { store.close(); }
  return request;
}
function restartRecord(root: string, requestId: string): GatewayRestartRecord | null {
  const db = new Database(join(root, "coordination.sqlite"), { readonly: true });
  try {
    const row = db.query("SELECT value FROM metadata WHERE key=?").get(`gateway:restart:${requestId}`) as { value: string } | null;
    return row ? JSON.parse(row.value) : null;
  } finally { db.close(); }
}
async function restartDiagnostics(root: string, requestId: string): Promise<string> {
  const db = new Database(join(root, "coordination.sqlite"), { readonly: true });
  let state: Array<{ key: string; value: string | null }>;
  try {
    state = ["gateway:head", "gateway:socket", "gateway:restart-active", `gateway:restart:${requestId}`,
      `gateway:restart-plan:${requestId}`, "head:preset-bootstrap"].map(key => ({ key,
        value: (db.query("SELECT value FROM metadata WHERE key=?").get(key) as { value: string } | null)?.value ?? null }));
  } finally { db.close(); }
  const log = await readFile(join(root, "logs", "gateway.log"), "utf8").catch(() => "No successor Gateway log was created.");
  return `${JSON.stringify(state)}\nSuccessor Gateway log:\n${log.slice(-16_000)}`;
}

test("restart refuses native busy work before shutdown and preserves exact sent source dedupe", async () => {
  const f = await fixture();
  const pid = f.service.status().head.pid!;
  const request = seedRestart(f.root, pid);
  await writeFile(join(f.root, "busy"), "busy");
  const refused = await f.service.restart(request);
  expect(refused.state).toBe("refused");
  expect(await f.service.restart(request)).toEqual(refused);
  f.service.runRestart(request.requestId);
  expect(processAlive(pid)).toBe(true);
  expect(f.service.status().gateway.stopping).toBe(false);
  expect(existsSync(join(f.root, "shutdowns.jsonl"))).toBe(false);
  expect(restartRecord(f.root, request.requestId)).toEqual(refused);
  await until(async () => existsSync(join(f.root, "restart-notices.jsonl")) &&
    (await readFile(join(f.root, "restart-notices.jsonl"), "utf8")).includes(request.requestId));
});

test("a refused busy CLI stop still supersedes restart intent captured before lifecycle acceptance", async () => {
  const f = await fixture();
  const pid = f.service.status().head.pid!;
  const request = seedRestart(f.root, pid);
  await writeFile(join(f.root, "busy"), "busy");
  await expect(main(["stop", "main", "--config", f.config.path])).rejects.toThrow("Host is busy");
  expect(f.service.status().gateway.stopping).toBe(false);
  expect(restartRecord(f.root, request.requestId)).toBeNull();
  await rm(join(f.root, "busy"));
  const refused = await f.service.restart(request);
  expect(refused.state).toBe("refused");
  expect(refused.reason).toContain("operator stop");
  f.service.runRestart(request.requestId);
  expect(f.service.status().head.pid).toBe(pid);
  expect(processAlive(pid)).toBe(true);
  await until(() => existsSync(join(f.root, "shutdowns.jsonl"))); // Only the failed explicit stop was attempted.
  expect((await readFile(join(f.root, "shutdowns.jsonl"), "utf8")).trim().split("\n")).toHaveLength(1);
});

test("duplicate accepted restart cannot adopt the old endpoint and explicit stop cancels successor authority", async () => {
  const f = await fixture();
  const pid = f.service.status().head.pid!;
  const request = seedRestart(f.root, pid);
  const accepted = await f.service.restart(request);
  expect(accepted.state).toBe("accepted");
  expect(await f.service.restart(request)).toEqual(accepted);
  await expect(launchGateway(f.config, request.requestId)).rejects.toThrow();
  f.service.runRestart(request.requestId);
  await f.service.stop();
  f.service.runRestart(request.requestId);
  expect(restartRecord(f.root, request.requestId)).toMatchObject({ state: "refused", reason: expect.stringContaining("operator stop") });
  expect(processAlive(pid)).toBe(false);
  expect((await readFile(join(f.root, "launches.jsonl"), "utf8")).trim().split("\n")).toHaveLength(1);
});

test("shutdown busy refusal restores intake; ambiguous shutdown never launches or revives a HEAD", async () => {
  for (const mode of ["busy-shutdown", "ambiguous-shutdown"]) {
    const f = await fixture();
    const pid = f.service.status().head.pid!;
    const request = seedRestart(f.root, pid);
    expect((await f.service.restart(request)).state).toBe("accepted");
    await writeFile(join(f.root, mode), mode);
    f.service.runRestart(request.requestId);
    f.service.runRestart(request.requestId);
    await until(() => restartRecord(f.root, request.requestId)?.state === (mode === "busy-shutdown" ? "refused" : "uncertain"));
    expect(processAlive(pid)).toBe(true);
    expect(f.service.status().gateway.stopping).toBe(mode === "ambiguous-shutdown");
    expect((await readFile(join(f.root, "shutdowns.jsonl"), "utf8")).trim().split("\n")).toHaveLength(1);
    expect((await readFile(join(f.root, "launches.jsonl"), "utf8")).trim().split("\n")).toHaveLength(1);
  }
});

test("definite successor spawn failure refuses while the original HEAD remains able to deliver the outcome", async () => {
  const f = await fixture(undefined, { launchRestartRunner: () => spawn("/nonexistent/omp-superagent-restart-runner", [], { stdio: "ignore" }) });
  const pid = f.service.status().head.pid!;
  const request = seedRestart(f.root, pid);
  expect((await f.service.restart(request)).state).toBe("accepted");
  f.service.runRestart(request.requestId);
  await until(() => restartRecord(f.root, request.requestId)?.state === "refused");
  expect(processAlive(pid)).toBe(true);
  expect(f.service.status().gateway.stopping).toBe(false);
  expect(existsSync(join(f.root, "shutdowns.jsonl"))).toBe(false);
});

test("one-shot successor records sanitized predecessor timeout without relaunch or kill", async () => {
  const f = await fixture();
  const request = seedRestart(f.root, f.service.status().head.pid!);
  const accepted = await f.service.restart(request);
  const head = await connect(hostPaths(f.config, "main").socketPath);
  try { await head.request({ type: "shutdown_host" }); } finally { await head.close(); }
  await until(() => !processAlive(accepted.headPid));
  const db = new Database(join(f.root, "coordination.sqlite"));
  try {
    const row = db.query("SELECT value FROM metadata WHERE key=?").get(`gateway:restart-plan:${request.requestId}`) as { value: string };
    const plan = JSON.parse(row.value);
    for (const key of [`gateway:restart:${request.requestId}`, "gateway:restart"])
      db.query("UPDATE metadata SET value=? WHERE key=?").run(JSON.stringify({ ...accepted, state: "head-stopped" }), key);
    db.query("UPDATE metadata SET value=? WHERE key=?").run(JSON.stringify({ ...plan, runnerPid: process.pid, runnerReady: true }),
      `gateway:restart-plan:${request.requestId}`);
  } finally { db.close(); }
  const saved = process.env.GATEWAY_TEST_BOT_TOKEN;
  process.env.GATEWAY_TEST_BOT_TOKEN = "isolated-test-secret";
  try { await runGatewayRestart(f.config.path, request.requestId, { timeoutMs: 30, launch: async () => { throw new Error("must not launch"); } }); }
  finally { if (saved === undefined) delete process.env.GATEWAY_TEST_BOT_TOKEN; else process.env.GATEWAY_TEST_BOT_TOKEN = saved; }
  expect(restartRecord(f.root, request.requestId)).toMatchObject({ state: "failed", reason: expect.stringContaining("no retry or forced kill") });
  expect(restartRecord(f.root, request.requestId)?.reason).not.toContain("isolated-test-secret");
  expect(processAlive(process.pid)).toBe(true);
  expect((await readFile(join(f.root, "launches.jsonl"), "utf8")).trim().split("\n")).toHaveLength(1);
});

test("successor records sanitized failure in the original store when configuration disappears and no adapter remains", async () => {
  const f = await fixture();
  const request = seedRestart(f.root, f.service.status().head.pid!);
  const accepted = await f.service.restart(request);
  await f.service.stop();
  expect(f.stopped).toBe(true);
  const db = new Database(join(f.root, "coordination.sqlite"));
  try {
    const row = db.query("SELECT value FROM metadata WHERE key=?").get(`gateway:restart-plan:${request.requestId}`) as { value: string };
    for (const key of [`gateway:restart:${request.requestId}`, "gateway:restart"])
      db.query("UPDATE metadata SET value=? WHERE key=?").run(JSON.stringify({ ...accepted, state: "head-stopped" }), key);
    db.query("UPDATE metadata SET value=? WHERE key=?").run(JSON.stringify({ ...JSON.parse(row.value), runnerPid: process.pid }),
      `gateway:restart-plan:${request.requestId}`);
  } finally { db.close(); }
  await rm(f.config.path);
  await runGatewayRestart(f.config.path, request.requestId, { stateDir: f.root });
  const failed = restartRecord(f.root, request.requestId)!;
  expect(failed.state).toBe("failed");
  expect(failed.reason).not.toContain(f.root);
  expect(failed.reason).not.toContain("isolated-test-secret");
  expect((await readFile(join(f.root, "launches.jsonl"), "utf8")).trim().split("\n")).toHaveLength(1);
});

test("detached restart replaces both processes, preserves native session/settings and durable handoff input", async () => {
  const root = await mkdtemp(join(await realpath("/tmp"), "oglr-"));
  await chmod(root, 0o700);
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "config.json");
  await writeFile(configPath, JSON.stringify({ stateDir: root, headCwd: root, maxHosts: 2, maxSubagents: 4, idleMs: 1000,
    command: [process.execPath, fileURLToPath(new URL("./fixtures/gateway-host.ts", import.meta.url))],
    model: "provider/initial-model", discord: { tokenEnv: "GATEWAY_TEST_BOT_TOKEN", ownerId: "2", allowedGuildIds: [], allowedChannelIds: [] } }));
  await writeFile(`${configPath}.env`, "GATEWAY_TEST_BOT_TOKEN=isolated-test-secret\n", { mode: 0o600 });
  const config = await loadConfig(configPath);
  const child = spawn(process.execPath, ["--no-env-file", fileURLToPath(new URL("./fixtures/gateway-lifecycle-process.ts", import.meta.url)),
    "--config", configPath], { cwd: root, stdio: "ignore" });
  cleanups.push(async () => {
    try { await stopGateway(config); } catch {}
    const db = new Database(join(root, "coordination.sqlite"), { readonly: true });
    try {
      for (const key of ["gateway:head", "gateway:socket"]) {
        const row = db.query("SELECT value FROM metadata WHERE key=?").get(key) as { value: string } | null;
        const pid = row ? (JSON.parse(row.value) as { pid?: number } | null)?.pid : undefined;
        if (pid && processAlive(pid)) { try { process.kill(pid, "SIGKILL"); } catch {} }
      }
    } finally { db.close(); }
    if (child.pid && processAlive(child.pid)) child.kill("SIGKILL");
  });
  await until(async () => { try { return Boolean((await gatewayStatus(config))?.head.ready); } catch { return false; } });
  const before = (await gatewayStatus(config))!;
  const transcript = await readFile(hostPaths(config, "main").sessionFile, "utf8");
  const request = seedRestart(root, before.head.pid!);
  const coordination = new Store(join(root, "coordination.sqlite"));
  try {
    coordination.setMeta("main:sessionId", "gateway-fixture-session");
    coordination.setMeta("head:model-settings:gateway-fixture-session", JSON.stringify({
      settings: { modelRoles: { default: "provider/preserved" }, defaultThinkingLevel: "low" }, clearedRoles: ["slow"],
    }));
  } finally { coordination.close(); }
  const native = await connect(hostPaths(config, "main").socketPath);
  let rejected = false;
  try { rejected = !(await native.request({ type: "fixture_restart", request })).success; }
  catch (error) {
    // A lost native receipt is admissible only after real durable Gateway acceptance.
    const persisted = restartRecord(root, request.requestId);
    if (!persisted || !["accepted", "head-stopped", "started"].includes(persisted.state))
      throw new Error(`Restart transport failed before acceptance: ${String(error)}\n${await restartDiagnostics(root, request.requestId)}`);
  }
  finally { await native.close(); }
  if (rejected)
    throw new Error(`Native fixture reported restart rejection.\n${await restartDiagnostics(root, request.requestId)}`);
  const accepted = restartRecord(root, request.requestId);
  if (!accepted) throw new Error("Restart returned without a durable lifecycle receipt");
  expect(["accepted", "head-stopped", "started"]).toContain(accepted.state);
  // This source remains on the transport's disk through endpoint/lifetime-lock handoff.
  const input: Inbound = { id: "handoff-original-source", route, messageId: "handoff-original-source", text: "handoff",
    receivedAt: Date.now(), attachments: [] };
  await writeFile(join(root, "ingress.jsonl"), `${JSON.stringify(input)}\n`);
  try {
    await until(async () => {
      try { const status = await gatewayStatus(config); return Boolean(status?.head.ready && status.gateway.pid !== before.gateway.pid &&
        status.head.pid !== before.head.pid && restartRecord(root, request.requestId)?.state === "started"); } catch { return false; }
    });
  } catch (error) {
    throw new Error(`${String(error)}\n${await restartDiagnostics(root, request.requestId)}`);
  }
  const after = (await gatewayStatus(config))!;
  expect(processAlive(before.gateway.pid)).toBe(false);
  expect(processAlive(before.head.pid!)).toBe(false);
  expect(after.gateway.pid).not.toBe(before.gateway.pid);
  expect(after.head.pid).not.toBe(before.head.pid);
  expect(restartRecord(root, request.requestId)).toMatchObject({ state: "started", successorPid: after.gateway.pid,
    replacementPid: after.head.pid, sessionId: "gateway-fixture-session", sessionFile: hostPaths(config, "main").sessionFile });
  expect(await readFile(hostPaths(config, "main").sessionFile, "utf8")).toBe(transcript);
  await until(async () => existsSync(join(root, "received.jsonl")) &&
    (await readFile(join(root, "received.jsonl"), "utf8")).includes(input.id));
  const launches = (await readFile(join(root, "launches.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(launches).toHaveLength(2);
  expect(launches.every(launch => !launch.credentialPresent)).toBe(true);
  expect(launches[1].config).toMatchObject({ modelRoles: { default: "provider/preserved", slow: null }, defaultThinkingLevel: "low" });
  const delivered = (await readFile(join(root, "received.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(delivered.filter(message => message.id === input.id)).toHaveLength(1);
}, 30_000);
