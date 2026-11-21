import { afterEach, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, chmod, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readSessionHeaderId } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { main } from "../src/cli";
import { hostPaths, type Config } from "../src/config";
import type { GatewayRestartRecord, GatewayRestartRequest, Inbound } from "../src/contracts";
import { launchGateway } from "./oracles/bun-gateway/gateway";
import { gatewayPaths } from "../src/gateway-protocol";
import { normalizedRestartConfigHash, processAlive, restartConfigHash, runGatewayRestart,
  type RestartPlan } from "./oracles/bun-gateway/gateway-restart";
import { GatewayStore } from "./oracles/bun-gateway/gateway-store";
import type { ManagedUlwStatus } from "../src/managed-ulw";
import { Store } from "../src/store";
import {
  cleanups, configFixture, detachedFixture, fixture, LIFECYCLE_PHASE_MS, metadata,
  route, RPC_MS, STARTUP_MS, token, until, waitStatus, withFixtureToken,
} from "./fixtures/gateway-lifecycle";
import { assertResidentFixtureOwner, waitForFixtureProcessExit } from "./fixtures/host-fixture-processes";

const RESTART_SHUTDOWN_MS = 2 * LIFECYCLE_PHASE_MS + RPC_MS; // runner preparation, shutdown RPC, then owner exit

afterEach(async () => {
  const failures: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup(); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, "Gateway lifecycle fixture cleanup failed");
}, { timeout: STARTUP_MS + RPC_MS + 3 * LIFECYCLE_PHASE_MS });

const input = (id: string, text = id): Inbound => ({ id, route, messageId: id, text, receivedAt: Date.now(), attachments: [] });
const restartRecord = (root: string, requestId: string) => metadata<GatewayRestartRecord>(root, `gateway:restart:${requestId}`);
const restartPlan = (root: string, requestId: string) => metadata<RestartPlan>(root, `gateway:restart-plan:${requestId}`);
const lines = async <T>(root: string, name: string): Promise<T[]> =>
  (await readFile(join(root, name), "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
type Launch = { pid: number; args: string[]; config: unknown; credentialPresent: boolean };
const launches = (root: string) => lines<Launch>(root, "launches.jsonl");
async function sessionId(file: string): Promise<string> {
  const id = await readSessionHeaderId(file);
  if (!id) throw new Error("Missing native session header");
  return id;
}
async function deadHead(config: Config) {
  const sessionFile = hostPaths(config, "main").sessionFile;
  const id = crypto.randomUUID();
  await mkdir(dirname(sessionFile), { recursive: true, mode: 0o700 });
  await writeFile(sessionFile, `${JSON.stringify({ type: "session", id, cwd: config.headCwd, timestamp: new Date().toISOString() })}\n`);
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", ""], { stdout: "ignore", stderr: "ignore" });
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await child.exited;
    }
  });
  await until("known predecessor PID to exit", 5_000, () => child.exitCode !== null);
  return { pid: child.pid, sessionId: id, sessionFile };
}
function seedRestart(root: string, source: Inbound, head: { pid: number; sessionId: string; sessionFile: string }): GatewayRestartRequest {
  const request = { requestId: crypto.randomUUID(), inputId: source.id, ackOutputId: `ack-${source.id}` };
  const store = new Store(join(root, "coordination.sqlite"));
  try {
    store.receive(source, "main", { [`user-source:${request.inputId}`]: "true" });
    store.settle(request.inputId, "done");
    store.queueOutput({ id: request.ackOutputId, sourceId: request.inputId, route, text: "Restart acknowledged" });
    store.claimOutput(request.ackOutputId);
    store.finishOutput(request.ackOutputId, "sent", "remote-ack");
    store.setMeta("head:restart-fence", JSON.stringify({ ...request, ownerPid: head.pid,
      sessionId: head.sessionId, sessionFile: head.sessionFile, state: "accepted",
      stopBoundary: store.getMeta("gateway:operator-stop") }));
  } finally { store.close(); }
  return request;
}

test("a busy owned HEAD refuses shutdown, and explicit stop cancels an accepted restart", async () => {
  const f = await fixture();
  const [initial] = await launches(f.root);
  expect(initial).toMatchObject({ credentialPresent: false, config: { modelRoles: { default: "provider/initial-model" } } });
  const pid = initial!.pid;
  expect(initial!.args).not.toContain("--session-settings");
  expect(initial!.args).not.toContain("--rpc-socket");
  const sessionFile = hostPaths(f.config, "main").sessionFile;
  const head = { pid, sessionFile, sessionId: await sessionId(sessionFile) };
  const owned = metadata<RestartPlan["head"]>(f.root, "gateway:head");
  if (!owned) throw new Error("Gateway did not save the launched Host identity");
  expect(owned).toMatchObject(head);
  await assertResidentFixtureOwner(f.root, { nativePid: pid, ownerPid: owned.ownerPid });
  expect(f.service.status().head.initialization).toMatchObject({ sessionId: head.sessionId, state: "complete" });

  await writeFile(join(f.root, "busy"), "busy");
  const busy = seedRestart(f.root, input("busy-restart", "/restart"), head);
  const refused = await f.service.restart(busy);
  expect(refused.state).toBe("refused");
  expect(await f.service.restart(busy)).toEqual(refused);
  f.service.runRestart(busy.requestId);
  expect(restartRecord(f.root, busy.requestId)).toEqual(refused);
  await until("busy restart outcome at the original HEAD", RPC_MS, async () =>
    existsSync(join(f.root, "restart-notices.jsonl")) &&
    (await lines<{ requestId: string; outcome: string }>(f.root, "restart-notices.jsonl")).some(
      notice => notice.requestId === busy.requestId && notice.outcome === "refused"));

  const superseded = seedRestart(f.root, input("superseded-restart", "/restart"), head);
  await expect(main(["stop", "main", "--config", f.config.path])).rejects.toThrow("Host is busy (session_busy)");
  expect(f.service.status()).toMatchObject({ gateway: { stopping: false }, head: { pid, ready: true } });
  expect(f.stopped).toBe(false);
  expect(restartRecord(f.root, superseded.requestId)).toBeNull();
  await rm(join(f.root, "busy"));
  expect(await f.service.restart(superseded)).toMatchObject({ state: "refused", reason: expect.stringContaining("operator stop") });
  f.service.runRestart(superseded.requestId);
  expect(processAlive(pid)).toBe(true);
  // Neither the pipe owner's busy refusal nor either stale restart reached native disposal.
  expect(existsSync(join(f.root, "shutdowns.jsonl"))).toBe(false);

  const current = seedRestart(f.root, input("current-restart", "/restart"), head);
  const accepted = await f.service.restart(current);
  expect(accepted.state).toBe("accepted");
  expect(await f.service.restart(current)).toEqual(accepted);
  await expect(launchGateway(f.config, current.requestId)).rejects.toThrow();
  f.service.runRestart(current.requestId);
  await f.service.stop();
  f.service.runRestart(current.requestId);
  expect(restartRecord(f.root, current.requestId)).toMatchObject({ state: "refused", reason: expect.stringContaining("operator stop") });
  expect(processAlive(pid)).toBe(false);
  await waitForFixtureProcessExit([owned.ownerPid]);
  expect(f.stopped).toBe(true);
  expect(existsSync(gatewayPaths(f.config).socketPath)).toBe(false);
  expect(await launches(f.root)).toHaveLength(1);
}, STARTUP_MS + 2 * RPC_MS + 25_000 + LIFECYCLE_PHASE_MS); // startup, notice, CLI refusal, supervised stop

test("a prepared Gateway stays ready during a source check and restores the confirmed-dead HEAD with its durable input and settings", async () => {
  const pending = new AbortController();
  const gate = AbortSignal.any([pending.signal, AbortSignal.timeout(STARTUP_MS)]);
  const f = await fixture({ updateManagedUlw: () => new Promise<ManagedUlwStatus>((_, reject) => {
    if (gate.aborted) reject(gate.reason);
    else gate.addEventListener("abort", () => reject(gate.reason), { once: true });
  }) });
  const old = f.service.status().head.pid!;
  try {
    expect(f.service.status()).toMatchObject({ gateway: { ready: true }, head: { ready: true }, ulw: { updating: true } });
  } finally { pending.abort(new Error("isolated slow upstream failed")); }
  await until("failed source check to settle", 5_000, () => f.service.status().ulw?.updating === false);
  expect(f.service.status()).toMatchObject({
    head: { pid: old, ready: true }, ulw: { error: "isolated slow upstream failed" },
  });
  expect(f.errors).toEqual([new Error("isolated slow upstream failed")]);
  f.errors.length = 0;

  const id = await sessionId(hostPaths(f.config, "main").sessionFile);
  const snapshot = { modelRoles: { default: "provider/preset-model", smol: "provider/small-model" }, defaultThinkingLevel: "low" };
  const coordination = new Store(join(f.root, "coordination.sqlite"));
  try {
    coordination.setMeta("main:sessionId", id);
    coordination.setMeta(`head:model-settings:${id}`, JSON.stringify({ settings: snapshot, clearedRoles: ["slow"] }));
    coordination.setMeta("head:model-settings:unrelated-session", JSON.stringify({
      settings: { modelRoles: { default: "provider/wrong-session" } }, clearedRoles: [],
    }));
  } finally { coordination.close(); }
  process.kill(old, "SIGKILL");
  const offline = input("offline-original-source");
  await f.emit(offline);
  expect(f.service.status().gateway.pendingEvents).toBeGreaterThan(0);
  await until("replacement HEAD with drained ingress", LIFECYCLE_PHASE_MS + STARTUP_MS, () => {
    const { head, gateway } = f.service.status();
    return head.ready && head.pid !== old && gateway.pendingEvents === 0;
  });
  const started = await launches(f.root);
  expect(started).toHaveLength(2);
  expect(started[1]!.args).not.toContain("--model");
  expect(started[1]!.args).not.toContain("--model-preset");
  expect(started[1]!.config).toMatchObject({ ...snapshot, modelRoles: { ...snapshot.modelRoles, slow: null } });
  expect(await lines<Inbound>(f.root, "received.jsonl")).toEqual([offline]);
  expect(f.errors).toEqual([]);
  const replacement = f.service.status().head.pid!;
  await main(["stop", "main", "--config", f.config.path]);
  await until("CLI stop detached the messenger and closed the Gateway endpoint", 5_000,
    () => f.stopped && !existsSync(gatewayPaths(f.config).socketPath));
  expect(processAlive(replacement)).toBe(false);
  expect(await launches(f.root)).toHaveLength(2);
}, 2 * STARTUP_MS + LIFECYCLE_PHASE_MS + 25_000 + 10_000);

test("Gateway waits for the recorded adapter owner even after its native process and socket are gone", async () => {
  const f = await configFixture();
  const previous = await deadHead(f.config);
  const socketPath = hostPaths(f.config, "main").socketPath;
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  const server = createServer();
  const close = () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  cleanups.push(async () => { if (server.listening) await close(); });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  await chmod(socketPath, 0o600);
  const stat = await lstat(socketPath);
  const owner = Bun.spawn([process.execPath, "--no-env-file", "-e", "process.stdin.resume();"],
    { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
  cleanups.push(async () => {
    if (owner.exitCode === null && owner.signalCode === null) owner.kill();
    await owner.exited;
  });
  const saved = new Store(join(f.root, "coordination.sqlite"));
  try {
    saved.setMeta("gateway:head", JSON.stringify({ ...previous, ownerPid: owner.pid, dev: stat.dev, ino: stat.ino }));
  } finally { saved.close(); }
  const starting = fixture({}, f);
  void starting.catch(() => {}); // The joined startup is asserted after releasing the prior owner.
  const bound = (status: { gateway: { ready: boolean } } | null) => status?.gateway.ready === true;
  const old = await waitStatus(f.config, "Gateway bound while the prior owner lives", LIFECYCLE_PHASE_MS, bound);
  expect(old.head).toMatchObject({ pid: previous.pid, ready: false });
  expect((await lstat(socketPath)).ino).toBe(stat.ino);
  await close();
  const waiting = await waitStatus(f.config, "Gateway status after prior endpoint close", 5_000, bound);
  expect(waiting.head).toMatchObject({ pid: previous.pid, ready: false });
  expect(existsSync(join(f.root, "launches.jsonl"))).toBe(false);
  owner.stdin.end();
  await owner.exited;
  const replacement = await starting;
  expect(replacement.service.status().head.pid).not.toBe(previous.pid);
  expect(replacement.service.status().head.initialization).toMatchObject({ sessionId: previous.sessionId, state: "complete" });
  expect(await launches(f.root)).toHaveLength(1);
  expect(replacement.errors).toEqual([]);
}, LIFECYCLE_PHASE_MS + STARTUP_MS + 5_000);

test("restart execution distinguishes spawn failure, native refusal and ambiguous native shutdown without replacement", async () => {
  let spawnFails = true;
  let closing = false;
  const liveRunners = new Set<ChildProcess>();
  const f = await fixture({ launchRestartRunner(path, requestId, fd) {
    if (spawnFails || closing) return spawn("/nonexistent/omp-superagent-restart-runner", [], { stdio: "ignore" });
    const runner = spawn(process.execPath, ["--no-env-file", fileURLToPath(new URL("./oracles/bun-gateway/gateway-restart.ts", import.meta.url)),
      "--config", path, "--state-dir", dirname(path), "--request", requestId], { cwd: dirname(path), stdio: ["ignore", fd, fd] });
    liveRunners.add(runner);
    runner.once("exit", () => liveRunners.delete(runner));
    runner.once("error", () => liveRunners.delete(runner));
    return runner;
  } });
  cleanups.push(async () => {
    closing = true;
    for (const runner of liveRunners) runner.kill();
    await until("fixture runner cleanup", 5_000, () => liveRunners.size === 0);
  });
  const sessionFile = hostPaths(f.config, "main").sessionFile;
  const pid = f.service.status().head.pid!;
  const head = { pid, sessionFile, sessionId: await sessionId(sessionFile) };
  for (const [mode, state, shutdowns] of [
    ["spawn-failure", "refused", 0], ["busy-shutdown", "refused", 1], ["ambiguous-shutdown", "uncertain", 2],
  ] as const) {
    const request = seedRestart(f.root, input(mode, "/restart"), head);
    expect((await f.service.restart(request)).state).toBe("accepted");
    if (!spawnFails) await writeFile(join(f.root, mode), mode);
    f.service.runRestart(request.requestId);
    f.service.runRestart(request.requestId);
    await until(`${mode} lifecycle outcome`, spawnFails ? RPC_MS : RESTART_SHUTDOWN_MS, () => {
      const record = restartRecord(f.root, request.requestId);
      if (record && !["accepted", "head-stopped"].includes(record.state)) expect(record.state).toBe(state);
      return record?.state === state;
    });
    const log = join(f.root, "shutdowns.jsonl");
    expect(existsSync(log) ? await lines(f.root, "shutdowns.jsonl") : []).toHaveLength(shutdowns);
    expect(processAlive(pid)).toBe(true);
    expect(f.service.status().gateway.stopping).toBe(state === "uncertain");
    expect(await launches(f.root)).toHaveLength(1);
    await until(`${mode} one-shot runner exit`, 5_000, () => liveRunners.size === 0);
    spawnFails = false;
  }
}, STARTUP_MS + RPC_MS + 2 * RESTART_SHUTDOWN_MS + 15_000);

test("restart accepts safe config drift but refuses invalid policy and changes after acceptance without touching HEAD", async () => {
  let spawns = 0;
  const f = await fixture({ launchRestartRunner() {
    spawns++;
    throw new Error("Config rejection must precede runner spawn");
  } });
  const sessionFile = hostPaths(f.config, "main").sessionFile;
  const pid = f.service.status().head.pid;
  const discord = f.config.discord;
  if (!pid || !discord) throw new Error("Expected a running Discord HEAD fixture");
  const head = { pid, sessionFile, sessionId: await sessionId(sessionFile) };
  const originalHash = await restartConfigHash(f.config.path);
  for (const [name, config, reason] of [
    ["invalid", { ...f.config, idleMs: -1 }, "configuration could not be validated"],
    ["instance", { ...f.config, stateDir: join(f.root, "new-instance") }, "changed the instance"],
    ["profile", { ...f.config, command: [...f.config.command, "--profile", "new-profile"] }, "native HEAD profile"],
    ["owner", { ...f.config, discord: { ...discord, ownerId: "9" } }, "messenger authorization"],
    ["credential", { ...f.config, discord: { ...discord, tokenEnv: "OTHER_BOT_TOKEN" } }, "messenger authorization"],
  ] as const) {
    await writeFile(f.config.path, JSON.stringify(config));
    const request = seedRestart(f.root, input(`config-${name}`, "/restart"), head);
    expect(await f.service.restart(request)).toMatchObject({ state: "refused", reason: expect.stringContaining(reason) });
    expect(restartPlan(f.root, request.requestId)).toBeNull();
    f.service.runRestart(request.requestId);
  }

  const candidate = { ...f.config, maxSubagents: f.config.maxSubagents + 2 };
  await writeFile(f.config.path, JSON.stringify(candidate));
  const request = seedRestart(f.root, input("config-after-acceptance", "/restart"), head);
  expect(await f.service.restart(request)).toMatchObject({ state: "accepted" });
  const acceptedHash = await restartConfigHash(f.config.path);
  expect(acceptedHash).not.toBe(originalHash);
  expect(restartPlan(f.root, request.requestId)?.configHash).toBe(acceptedHash);
  await writeFile(f.config.path, JSON.stringify({ ...candidate, idleMs: f.config.idleMs + 1 }));
  f.service.runRestart(request.requestId);
  const refusal = await until("accepted config drift refusal", RPC_MS, () => {
    const record = restartRecord(f.root, request.requestId);
    return record?.state === "refused" && record;
  });
  expect(refusal.reason).toContain("configuration changed after restart acceptance");
  expect(await f.service.restart(request)).toEqual(refusal);
  expect(f.service.status()).toMatchObject({ gateway: { stopping: false }, head: { pid: head.pid, ready: true } });
  expect(spawns).toBe(0);
  expect(existsSync(join(f.root, "shutdowns.jsonl"))).toBe(false);
  expect(await launches(f.root)).toHaveLength(1);
}, STARTUP_MS + 2 * RPC_MS);

for (const failure of ["live predecessor", "missing configuration"] as const) {
  test(`one-shot runner records a sanitized failure without launch or kill: ${failure}`, async () => {
    const { config, root } = await configFixture();
    const previous = await deadHead(config);
    const socket = { pid: process.pid, dev: 0, ino: 0 };
    const head = { ...previous, ownerPid: previous.pid, dev: 0, ino: 0 };
    const request = seedRestart(root, input(failure, "/restart"), head);
    const plan = { configPath: config.path, stateDir: root, configHash: await restartConfigHash(config.path),
      normalizedConfigHash: normalizedRestartConfigHash(config),
      socket, head, runnerPid: process.pid, runnerReady: true } satisfies RestartPlan;
    const gateway = new GatewayStore(root);
    try {
      gateway.setRestart({ ...request, sessionId: head.sessionId, sessionFile: head.sessionFile,
        gatewayPid: socket.pid, headPid: head.pid, state: "head-stopped" });
      gateway.setMeta("gateway:restart-active", request.requestId);
      gateway.setMeta(`gateway:restart-plan:${request.requestId}`, JSON.stringify(plan));
    } finally { gateway.close(); }
    if (failure === "missing configuration") await rm(config.path);
    let launchAttempts = 0;
    await withFixtureToken(() => runGatewayRestart(config.path, request.requestId, { stateDir: root, timeoutMs: 30,
      async launch() { launchAttempts++; throw new Error("Unexpected successor launch"); },
    }));
    const failed = restartRecord(root, request.requestId);
    expect(failed?.state).toBe("failed");
    expect(failed?.reason).toContain("no retry or forced kill");
    expect(failed?.reason).not.toContain(root);
    expect(failed?.reason).not.toContain(token);
    expect(launchAttempts).toBe(0);
    expect(processAlive(socket.pid)).toBe(true);
  }, 10_000);
}

test("detached restart replaces both processes, preserving the native session and exactly one handoff input", async () => {
  const f = await detachedFixture();
  const before = await waitStatus(f.config, "original detached HEAD readiness", STARTUP_MS, status => {
    f.checkIngress();
    const outcome = f.childExited();
    if (outcome) throw new Error(`Original detached Gateway ${outcome}`);
    return status?.head.ready === true;
  });
  const pid = before.head.pid!;
  const sessionFile = hostPaths(f.config, "main").sessionFile;
  const transcript = await readFile(sessionFile, "utf8");
  const id = await sessionId(sessionFile);
  const source = input("restart-original-source", "/restart");
  const request = seedRestart(f.root, source, { pid, sessionFile, sessionId: id });
  const coordination = new Store(join(f.root, "coordination.sqlite"));
  try {
    coordination.setMeta("main:sessionId", id);
    coordination.setMeta(`head:model-settings:${id}`, JSON.stringify({
      settings: { modelRoles: { default: "provider/preserved" }, defaultThinkingLevel: "low" }, clearedRoles: ["slow"],
    }));
  } finally { coordination.close(); }
  const ingress = join(f.root, "ingress.jsonl");
  const handoff = input("handoff-original-source", "handoff");
  const receipt = () => {
    f.checkIngress();
    const record = restartRecord(f.root, request.requestId);
    if (record && !["accepted", "head-stopped", "started"].includes(record.state))
      throw new Error(`Unexpected durable restart outcome: ${JSON.stringify(record)}`);
    return record;
  };
  try {
    await writeFile(ingress, `${JSON.stringify(source)}\n`);
    await until("durable restart acceptance", RPC_MS, receipt);
    await until("predecessor shutdown and lifetime handoff", RESTART_SHUTDOWN_MS, () =>
      receipt()?.state === "head-stopped" && !processAlive(before.gateway.pid) && !processAlive(pid));
    // The runner is still live but no Gateway owns intake; queue input on the
    // isolated transport disk before allowing the successor to start.
    await appendFile(ingress, `${JSON.stringify(handoff)}\n`.repeat(2));
    await writeFile(join(f.root, "handoff-queued"), "");
    const started = await until("successor launch receipt", STARTUP_MS, () => {
      const record = receipt();
      return record?.state === "started" && record;
    });
    const admissions = "ingress-admissions.jsonl";
    type Admission = { id: string; position: number; pid: number };
    const received = join(f.root, "received.jsonl");
    let returned: Admission[] | undefined;
    const after = await waitStatus(f.config, "replacement HEAD ready and both handoff offers returned", RPC_MS, async status => {
      f.checkIngress();
      if (!returned) {
        if (!existsSync(join(f.root, admissions))) return false;
        const observed = (await lines<Admission>(f.root, admissions)).filter(event => event.id === handoff.id);
        if (observed.length < 2) return false;
        returned = observed;
        return false; // Only a status probe after both callbacks can prove the queue drained.
      }
      if (!status?.head.ready || status.gateway.pid === before.gateway.pid || status.head.pid === pid ||
          status.gateway.pendingEvents !== 0 || !existsSync(received) ||
          !(await readFile(received, "utf8")).includes(`${JSON.stringify(handoff)}\n`)) return false;
      expect(returned).toEqual([2, 3].map(position => ({ id: handoff.id, position, pid: status.gateway.pid })));
      return true;
    });
    expect(started).toMatchObject({ successorPid: after.gateway.pid, replacementPid: after.head.pid, sessionId: id, sessionFile });
    expect(await readFile(sessionFile, "utf8")).toBe(transcript);
    const startedHosts = await launches(f.root);
    expect(startedHosts).toHaveLength(2);
    expect(startedHosts.every(launch => !launch.credentialPresent)).toBe(true);
    expect(startedHosts[1]!.config).toMatchObject({ modelRoles: { default: "provider/preserved", slow: null }, defaultThinkingLevel: "low" });
    expect((await lines<Inbound>(f.root, "received.jsonl")).filter(message => message.id === handoff.id)).toEqual([handoff]);
  } catch (cause) {
    const { logPath } = gatewayPaths(f.config);
    const log = existsSync(logPath) ? await readFile(logPath, "utf8") : "(no successor log)";
    const state = { restart: restartRecord(f.root, request.requestId), plan: restartPlan(f.root, request.requestId),
      head: metadata(f.root, "gateway:head"), socket: metadata(f.root, "gateway:socket"), predecessor: f.childExited() };
    throw new Error(`${String(cause)}\n${JSON.stringify(state)}\nSuccessor Gateway log:\n${log.slice(-16_000)}`, { cause });
  }
}, 2 * STARTUP_MS + 2 * RPC_MS + RESTART_SHUTDOWN_MS + 5_000);
