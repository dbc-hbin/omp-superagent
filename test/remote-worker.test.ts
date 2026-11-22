import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmod, cp, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { delimiter, dirname, join, resolve } from "node:path";
import type { Lane, WorkerPlacement } from "../src/contracts";
import { packManagedUlwRevision, readUlwManifest } from "../src/managed-ulw";
import { remoteCapability, remoteConnect, remoteEvidence, remoteInput, remoteInspect, remoteProvision, remoteResult, remoteStart, remoteWorkspace } from "../src/remote-worker";
import { workerPackage } from "../src/remote-worker-wire";
import { WorkerLaneState } from "../src/remote-worker-state";
import { dependencies } from "../package.json";
import { readFile } from "node:fs/promises";
import { writeStockHostExecutable } from "./fixtures/stock-host";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  const errors: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "Remote worker fixture cleanup failed");
}, { timeout: 45_000 });

async function workerInstall(home: string): Promise<string> {
  // Resolve the managed revision as an installed worker would, not from the
  // HEAD checkout's active pointer or a worker environment override.
  const repository = resolve(import.meta.dir, "..");
  const installation = join(home, "worker-package");
  const manifest = readUlwManifest();
  const managed = join(installation, manifest.directory);
  const active = { revision: "a".repeat(40), repository: manifest.repository, branch: "main", preparedAt: new Date(0).toISOString() };
  const revision = join(managed, "revisions", active.revision);
  await Promise.all([revision, join(installation, "upstream"), join(installation, "test", "fixtures"),
    join(installation, "test", "oracles")].map(path => mkdir(path, { recursive: true, mode: 0o700 })));
  await Promise.all([
    ...["src", "bin", "package.json", "upstream/ulw.json", "test/fixtures/host-fixture-processes.ts",
      "test/fixtures/host-owner-identity.ts", "test/oracles/bun-gateway"]
      .map(path => cp(join(repository, path), join(installation, path), { recursive: true })),
    ...["skills", "host-owner", "node_modules"].map(path => symlink(join(repository, path), join(installation, path), "dir")),
    cp(join(import.meta.dir, "fixtures/managed-ulw"), join(revision, "package"), { recursive: true }),
    writeFile(join(managed, "owner.json"), JSON.stringify({ owner: "omp-superagent-managed-ulw-v1" })),
    writeFile(join(managed, "active.json"), JSON.stringify(active)),
    writeFile(join(revision, "provenance.json"), JSON.stringify(active)),
  ]);
  return join(installation, "bin", "omp-sa-worker");
}

async function workerFixture(native = false) {
  const root = await mkdtemp(join(await realpath("/tmp"), "osw-"));
  const home = join(root, "home");
  const cwd = join(root, "workspace");
  const stateDir = join(root, "state");
  const sshBin = join(root, "bin");
  const configDir = join(home, ".config", "omp-superagent");
  const previousPath = process.env.PATH;
  const previousSecret = process.env.WORKER_HEAD_TEST_SECRET;
  cleanups.push(async () => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousSecret === undefined) delete process.env.WORKER_HEAD_TEST_SECRET;
    else process.env.WORKER_HEAD_TEST_SECRET = previousSecret;
    await rm(root, { recursive: true, force: true });
  });
  await Promise.all([cwd, stateDir, sshBin, configDir].map(path => mkdir(path, { recursive: true, mode: 0o700 })));
  const placement: WorkerPlacement = { worker: "builder", destination: "build-alias", workerId: randomUUID() };
  const instance = randomUUID();
  const id = "lane-remote";
  const drop = join(root, "drop-ssh-response");
  const recycled = join(root, "recycled-pids.json");
  const pidProbe = join(root, "pid-probe.ts");
  const command = join(root, "omp");
  const provision = join(configDir, "worker.json");
  await writeFile(provision, JSON.stringify({
    workerId: placement.workerId, instance, stateDir, workspaceRoots: [cwd],
    command: [command]
  }), { mode: 0o600 });
  const bun = await realpath(process.execPath);
  const worker = native ? await workerInstall(home) : resolve(import.meta.dir, "../bin/omp-sa-worker");
  if (native) await writeFile(pidProbe, `
import { existsSync, readFileSync } from "node:fs";
const marker = ${JSON.stringify(recycled)};
if (existsSync(marker)) {
  const reused = new Set(JSON.parse(readFileSync(marker, "utf8")));
  const kill = process.kill.bind(process);
  process.kill = (pid, signal) => signal === 0 && reused.has(pid) ? true : kill(pid, signal);
}
`);
  await writeFile(join(sshBin, "ssh"), `#!${bun} --no-env-file
import { existsSync, unlinkSync } from "node:fs";
import { decodeHeader } from ${JSON.stringify(resolve(import.meta.dir, "../src/remote-worker-wire.ts"))};
const args = process.argv.slice(2);
if (args.slice(-3).join(" ") !== "-- build-alias omp-sa-worker" ||
    !args.includes("StrictHostKeyChecking=yes") || !args.includes("-a") || !args.includes("-T"))
  throw new Error("Unexpected worker SSH invocation");
const env = { ...process.env, HOME: ${JSON.stringify(home)}, PI_CODING_AGENT_DIR: ${JSON.stringify(join(home, "agent"))},
  OMP_SUPERAGENT_ROLE: "head", OMP_SUPERAGENT_CONFIG: "/should-not-authorize-a-manager", WORKER_LOCAL_TEST_SECRET: "worker-local",
  OMP_SUPERAGENT_TEST_WORKER_CONTEXT: "direct",
  STOCK_HOST_MODELS: JSON.stringify({ models: [{ kind: "chat", selector: "worker/offered" }, { kind: "image", selector: "worker/image" }] }) };
const command = ${JSON.stringify([bun, "--no-env-file", ...(native ? ["--preload", pidProbe] : []), worker])};
if (existsSync(${JSON.stringify(drop)})) {
  unlinkSync(${JSON.stringify(drop)});
  const request = await decodeHeader(process.stdin, 5000);
  const child = Bun.spawn(command, { env, stdin: new Blob([JSON.stringify(request) + "\\n"]), stdout: "pipe", stderr: "inherit" });
  await new Response(child.stdout).text();
  await child.exited;
  // A completed worker reply never reaches HEAD.
  process.exit(83);
} else {
  const child = Bun.spawn(command, { env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  process.exitCode = await child.exited;
}
`, { mode: 0o700 });
  process.env.PATH = [sshBin, dirname(bun), previousPath].filter(Boolean).join(delimiter);
  process.env.WORKER_HEAD_TEST_SECRET = "do-not-forward";
  return { root, instance, placement, id, cwd, command, provision, drop, recycled, worker };
}

async function laneFixture(fixture: Awaited<ReturnType<typeof workerFixture>>, generation = 0): Promise<Lane> {
  const { placement, cwd, instance, id } = fixture;
  const workspace = await remoteWorkspace(placement, cwd, instance, id);
  return {
    ...workspace, id, placement, generation, title: "Remote work",
    route: { platform: "discord", accountId: "account", authorityId: "owner", guildId: null, channelId: "ch", threadId: "thread" },
    brief: "Worker transport", acceptance: [], model: null, modelReason: null, modelPreset: null, modelPresetSnapshot: null,
    workState: "open", runtimeState: generation === 0 ? "unloaded" : "starting", sessionId: null, pid: null,
    createdAt: 1, lastActivityAt: 1, result: null,
  };
}

test("resolve authenticates the pinned worker and checks canonical workspaces against private provisioning", async () => {
  const { root, placement, instance, id, cwd, provision } = await workerFixture();
  const outside = join(root, "workspace-sibling");
  const escape = join(cwd, "escape");
  await mkdir(outside);
  await symlink(outside, escape);
  const alias = join(root, "inside-link");
  await symlink(cwd, alias);

  expect(await remoteWorkspace(placement, alias, instance, id)).toMatchObject({ cwd, repoRoot: null });
  await expect(remoteWorkspace(placement, escape, instance, id)).rejects.toThrow("outside worker-approved roots");
  await expect(remoteWorkspace({ ...placement, workerId: randomUUID() }, cwd, instance, id)).rejects.toThrow("worker identity");
  await expect(remoteWorkspace(placement, cwd, randomUUID(), id)).rejects.toThrow("HEAD instance");
  await chmod(provision, 0o644);
  await expect(remoteWorkspace(placement, cwd, instance, id)).rejects.toThrow();
});

test("existing worker endpoints without a launch receipt are never adopted or replaced", async () => {
  const fixture = await workerFixture();
  const { placement, instance } = fixture;
  const lane = await laneFixture(fixture);
  expect(await remoteInspect(placement, instance, lane)).toEqual({ socket: false, transcript: false, alive: false });
  await mkdir(dirname(lane.socketPath), { mode: 0o700 });
  const orphan = createServer(peer => peer.destroy());
  orphan.listen(lane.socketPath);
  await once(orphan, "listening");
  cleanups.push(() => new Promise(resolve => orphan.close(resolve)));
  await chmod(lane.socketPath, 0o600);
  const starting = { ...lane, generation: 1 };
  await expect(remoteInspect(placement, instance, starting)).rejects.toThrow("Unreserved endpoint");
  await expect(remoteStart(placement, instance, starting, { subagentConcurrency: 2 }, null)).rejects.toThrow("Unreserved endpoint");
  await expect(remoteConnect(placement, instance, starting)).rejects.toThrow("Unreserved endpoint");
});

test("an unconfirmed launch remains fenced across SSH connections and later generations", async () => {
  const fixture = await workerFixture();
  const { placement, instance } = fixture;
  // The executable passes the capability checks, but its native Host never starts.
  await writeStockHostExecutable(fixture.command, "process.exit(1);");
  const lane = await laneFixture(fixture, 1);
  const options = { subagentConcurrency: 2 };
  await expect(remoteStart(placement, instance, lane, options, null)).rejects.toThrow("launch remains unconfirmed");
  await expect(remoteInspect(placement, instance, lane)).rejects.toThrow("reservation is not confirmed");
  await expect(remoteStart(placement, instance, lane, options, null)).rejects.toThrow("reservation is not confirmed");
  await expect(remoteStart(placement, instance, { ...lane, generation: 2 }, options, null)).rejects.toThrow("reservation is not confirmed");
});

test("a lost start reconciles to one owner and a released generation restores the same session despite PID reuse", async () => {
  const fixture = await workerFixture(true);
  const { placement, instance, command, drop, recycled, worker } = fixture;
  const lane = await laneFixture(fixture, 1);
  const laneDir = dirname(lane.sessionFile);
  // The fixture verifies the Rust owner's actual argv and installation path.
  const ownerFixture = resolve(dirname(worker), "../test/fixtures/host-fixture-processes.ts");
  const { stopHostFixtures, waitForFixtureProcessExit }: typeof import("./fixtures/host-fixture-processes") = await import(ownerFixture);
  cleanups.push(async () => {
    if (await Bun.file(join(laneDir, "r1.log")).exists()) await stopHostFixtures(laneDir);
  });
  await writeStockHostExecutable(command, `
import { recordHostFixture } from ${JSON.stringify(ownerFixture)};
import { stockHostFixture } from ${JSON.stringify(resolve(import.meta.dir, "fixtures/stock-host.ts"))};
recordHostFixture(${JSON.stringify(laneDir)});
await stockHostFixture({
  sessionFile: process.argv[process.argv.indexOf("--session") + 1],
  handle(request) {
    if (request.type === "get_worker_fixture") return { data: {
      role: process.env.OMP_SUPERAGENT_ROLE, lane: process.env.OMP_SUPERAGENT_LANE,
      headCredentialPresent: Object.hasOwn(process.env, "WORKER_HEAD_TEST_SECRET"),
      managerConfigPresent: Object.hasOwn(process.env, "OMP_SUPERAGENT_CONFIG"),
      localCredential: process.env.WORKER_LOCAL_TEST_SECRET,
    } };
  },
});
`);
  const options = { subagentConcurrency: 2 };
  // The worker install's own active revision; anything else is refused before reserving.
  const pinnedRevision = "a".repeat(40);
  await expect(remoteStart(placement, instance, lane, options, "b".repeat(40))).rejects.toThrow(`HEAD pinned ${"b".repeat(40)}`);
  await expect(remoteStart(placement, instance, lane, { ...options, model: "head-only/model" }, pinnedRevision))
    .rejects.toThrow("does not offer head-only/model");
  expect(await remoteInspect(placement, instance, lane)).toEqual({ socket: false, transcript: false, alive: false });
  await writeFile(drop, "");
  await expect(remoteStart(placement, instance, lane, options, pinnedRevision)).rejects.toThrow("before sending a control frame");
  expect(await remoteInspect(placement, instance, lane)).toEqual({ socket: true, transcript: true, alive: true });
  const connection = await remoteConnect(placement, instance, lane);
  cleanups.push(() => connection.close());
  const state = await connection.client.getState();
  if (typeof state.hostPid !== "number" || !("adapterOwnerPid" in state) || typeof state.adapterOwnerPid !== "number") {
    throw new Error("Fixture has no stock native process and adapter owner identity");
  }
  const bound = { ...lane, pid: state.hostPid, sessionId: state.sessionId };
  expect(await connection.request({ type: "get_worker_fixture" })).toMatchObject({
    success: true, data: {
      role: "lane", lane: lane.id, headCredentialPresent: false, managerConfigPresent: false, localCredential: "worker-local",
    }
  });
  // A requested result file is staged on the worker with the local rules and streamed back.
  const resultBytes = Buffer.from([137, 80, 78, 71, 0, 1, 2]);
  await writeFile(join(fixture.cwd, "report.png"), resultBytes);
  expect(await remoteResult(placement, instance, bound, "report.png")).toEqual({ name: "report.png", data: resultBytes.toString("base64") });
  await writeFile(join(fixture.cwd, ".hidden"), "private");
  await expect(remoteResult(placement, instance, bound, ".hidden")).rejects.toThrow("non-hidden");
  await expect(remoteResult(placement, instance, bound, "missing.png")).rejects.toThrow("could not be read safely");
  // Evidence is read on the worker, inside the lane workspace only.
  await writeFile(join(fixture.cwd, "evidence.txt"), "from the worker");
  expect(await remoteEvidence(placement, instance, bound, { kind: "file", path: "evidence.txt" }))
    .toMatchObject({ kind: "file", cwd: fixture.cwd, text: "from the worker", truncated: false });
  await expect(remoteEvidence(placement, instance, bound, { kind: "file", path: "../home" })).rejects.toThrow("outside the lane workspace");
  expect(await remoteEvidence(placement, instance, bound, { kind: "git", command: "status" })).toMatchObject({ exitCode: 128 });
  // Inputs land once, verified, under the lane's private worker directory.
  const input = await remoteInput(placement, instance, bound, "../notes .txt", new TextEncoder().encode("worker input"));
  expect(dirname(input)).toBe(join(laneDir, "inputs"));
  expect(await readFile(input, "utf8")).toBe("worker input");
  expect(await remoteInput(placement, instance, bound, "../notes .txt", new TextEncoder().encode("worker input"))).toBe(input);
  await connection.close();
  const retry = await remoteStart(placement, instance, bound, options, pinnedRevision);
  expect(retry.pid).toBe(state.hostPid);
  await expect(remoteStart(placement, instance, { ...bound, pid: null, generation: 2 }, options, pinnedRevision))
    .rejects.toThrow("Prior worker generation still owns the lane");
  await expect(remoteConnect(placement, instance, { ...bound, sessionId: randomUUID() })).rejects.toThrow("original worker owner");
  await expect(remoteConnect(placement, instance, { ...bound, pid: 1 })).rejects.toThrow("original worker owner");
  await expect(remoteConnect(placement, instance, { ...bound, sessionFile: `${bound.sessionFile}.other` })).rejects.toThrow("workspace binding");
  const resident = await remoteConnect(placement, instance, bound);
  cleanups.push(() => resident.close());
  const actualSocket = join(laneDir, "r1.sock");
  await rename(actualSocket, `${actualSocket}.displaced`);
  try {
    expect(await remoteInspect(placement, instance, bound)).toEqual({ socket: false, transcript: true, alive: true });
  } finally { await rename(`${actualSocket}.displaced`, actualSocket); }
  expect(await resident.request({ type: "shutdown_host" })).toMatchObject({ success: true });
  await resident.exited;
  await waitForFixtureProcessExit([state.hostPid, state.adapterOwnerPid]);
  const exitReceipt = `${actualSocket}.exit.json`;
  const next = { ...bound, generation: 2, pid: null };
  await rename(exitReceipt, `${exitReceipt}.missing`);
  await expect(remoteInspect(placement, instance, bound)).rejects.toThrow("cannot confirm a released Host");
  await expect(remoteStart(placement, instance, next, options, pinnedRevision)).rejects.toThrow("cannot confirm a released Host");
  await rename(`${exitReceipt}.missing`, exitReceipt);
  expect(await remoteInspect(placement, instance, bound)).toEqual({ socket: false, transcript: true, alive: false });

  // Future SSH workers see these old PID numbers as present in the OS. The
  // persisted release must not re-probe either PID or reread the exit sidecar.
  await writeFile(recycled, JSON.stringify([state.hostPid, state.adapterOwnerPid]));
  await rename(exitReceipt, `${exitReceipt}.verified`);
  expect(await remoteInspect(placement, instance, bound)).toEqual({ socket: false, transcript: true, alive: false });
  await expect(remoteStart(placement, instance, bound, options, pinnedRevision)).rejects.toThrow("will not be repeated");
  const orphan = createServer(peer => peer.destroy());
  orphan.listen(actualSocket);
  await once(orphan, "listening");
  try {
    await expect(remoteInspect(placement, instance, bound)).rejects.toThrow("orphan generation endpoint");
    await expect(remoteStart(placement, instance, next, options, pinnedRevision)).rejects.toThrow("orphan generation endpoint");
  } finally { await new Promise<void>(resolve => orphan.close(() => resolve())); }

  const restored = await remoteStart(placement, instance, next, options, pinnedRevision);
  const replacement = await remoteConnect(placement, instance, { ...next, pid: restored.pid });
  cleanups.push(() => replacement.close());
  expect(await replacement.client.getState()).toMatchObject({ sessionId: state.sessionId, sessionFile: bound.sessionFile, hostPid: restored.pid });
  await expect(remoteInspect(placement, instance, bound)).rejects.toThrow("current worker reservation");
  expect(await replacement.request({ type: "shutdown_host" })).toMatchObject({ success: true });
  await replacement.exited;
}, 75_000);

test("a reservation its launcher never claimed is abandoned back to the record it replaced", async () => {
  const fixture = await workerFixture();
  const { id, cwd, socketPath, sessionFile } = await laneFixture(fixture, 1);
  const lane = { id, cwd, socketPath, sessionFile, generation: 1, pid: null, sessionId: null };
  process.env.OMP_SUPERAGENT_TEST_WORKER_CONTEXT = "direct";
  cleanups.push(async () => { delete process.env.OMP_SUPERAGENT_TEST_WORKER_CONTEXT; });
  const config = {
    workerId: fixture.placement.workerId, instance: fixture.instance, stateDir: join(fixture.root, "state"),
    workspaceRoots: [fixture.cwd], command: [fixture.command] as [string],
  };
  const state = new WorkerLaneState(config, { instance: fixture.instance, placement: fixture.placement }, fixture.id);
  try {
    const launched = { package: workerPackage(), omp: "19.0.0", superkit: null, bootId: "boot" };
    const token = state.reserve(lane, { subagentConcurrency: 1 }, launched);
    expect(token).toEqual(expect.any(String));
    state.abandon("00000000-0000-4000-8000-000000000000");
    expect(state.read()?.stage).toBe("reserved");
    state.abandon(token!);
    expect(state.read()).toBeNull();
    const again = state.reserve(lane, { subagentConcurrency: 1 }, launched)!;
    state.claim(again);
    state.abandon(again);
    // Claimed: a Host may exist, so the reservation stays fenced.
    expect(state.read()?.stage).toBe("launching");
  } finally { state.close(); }
});

test("the worker reports its capability, takes HEAD's superkit package idempotently, and refuses inputs without a lane", async () => {
  const fixture = await workerFixture(true);
  // Provisioned revisions are immutable (read-only directories).
  cleanups.push(() => Bun.spawn(["chmod", "-R", "u+w", fixture.root]).exited);
  const { placement, instance, command } = fixture;
  await writeStockHostExecutable(command, "process.exit(1);");
  expect(await remoteCapability(placement, instance)).toMatchObject({
    package: workerPackage(), omp: dependencies["@oh-my-pi/pi-coding-agent"], superkit: "a".repeat(40),
    roots: [fixture.cwd], models: ["worker/offered"],
  });
  const pack = await packManagedUlwRevision();
  const revision = pack.provenance.revision;
  expect(await remoteProvision(placement, instance, pack)).toEqual({ revision, changed: true });
  expect(await remoteProvision(placement, instance, pack)).toEqual({ revision, changed: false });
  expect((await remoteCapability(placement, instance)).superkit).toBe(revision);
  await expect(remoteProvision(placement, instance, { ...pack, digest: "0".repeat(64) })).rejects.toThrow("provisioning failed");
  expect((await remoteCapability(placement, instance)).superkit).toBe(revision);
  const lane = await laneFixture(fixture, 1);
  await expect(remoteInput(placement, instance, lane, "a.txt", new Uint8Array([1]))).rejects.toThrow("no launched lane");
}, 120_000);
