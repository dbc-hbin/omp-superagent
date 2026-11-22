import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { appendFile, cp, mkdir, readdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox/type";
import { decodeHeader, encodeHeader, parse, replySchema, REQUEST_TIMEOUT, requestSchema,
  startedSchema, START_TIMEOUT } from "../../src/remote-worker-wire";
import { nativeTestArgv, nativeTestCommand } from "./native-command";
import { nativeDisabledProviders } from "./native-extension";
import { offlineMnemopi } from "./native-memory";
import { recoveryGate, remoteWorkerModel, waitForProofFile, workspaceProbe } from "./native-remote-worker-provider";

const repo = resolve(import.meta.dir, "../..");
const provider = join(import.meta.dir, "native-remote-worker-provider.ts");
const custody = "test/fixtures/host-fixture-processes.ts";
const managedPackage = join(import.meta.dir, "managed-ulw");

export async function detachedJournalOrder(sessionFile: string): Promise<string[]> {
  const { loadEntriesFromFileStream } = await import("@oh-my-pi/pi-coding-agent/session/session-loader");
  const { entries } = await loadEntriesFromFileStream(sessionFile, { throwIfMissing: true });
  const priorCompletion = entries.findIndex(entry => entry.type === "custom" && entry.customType === "rpc_prompt_result");
  assert.notEqual(priorCompletion, -1, "Expected the original kickoff's native completion before the detached follow-up");
  return entries.slice(priorCompletion + 1).flatMap(entry => {
    if (entry.type === "custom" && ["rpc_agent_start", "rpc_prompt_result"].includes(entry.customType)) return [entry.customType];
    if (entry.type === "message" && ["user", "assistant"].includes(entry.message.role)) return [entry.message.role];
    return [];
  });
}

/** A worker install without omp-superkit: HEAD must provision its own pinned revision. */
async function stageWorker(installation: string): Promise<void> {
  await Promise.all(["upstream", "test/fixtures", "test/oracles"].map(path =>
    mkdir(resolve(installation, path), { recursive: true, mode: 0o700 })));
  await Promise.all([
    ...["src", "bin", "package.json", "upstream/ulw.json", custody,
      "test/fixtures/host-owner-identity.ts", "test/oracles/bun-gateway"].map(path =>
      cp(join(repo, path), join(installation, path), { recursive: true })),
    ...["skills", "host-owner", "node_modules"].map(path => symlink(join(repo, path), join(installation, path), "dir")),
  ]);
}

async function privateProfile(home: string, root: string, executablePath: string) {
  const agent = join(home, "agent");
  const config = join(home, ".config");
  const tmp = join(home, "tmp");
  const env = {
    PATH: executablePath, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agent,
    XDG_CONFIG_HOME: config, XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"),
    XDG_STATE_HOME: join(home, "state"), TMPDIR: tmp, TMP: tmp, TEMP: tmp,
    PI_NATIVES_DIR: process.env.OMP_TEST_NATIVES_DIR ?? join(root, "natives"),
    PI_NO_TITLE: "1", CI: "true", NO_COLOR: "1", SA_PROOF_HOME: home,
  };
  await Promise.all([agent, config, tmp, join(root, "natives")].map(path => mkdir(path, { recursive: true, mode: 0o700 })));
  await Promise.all([
    writeFile(join(agent, "config.yml"), JSON.stringify({
      ...offlineMnemopi, disabledProviders: nativeDisabledProviders, extensions: [provider],
      modelRoles: { default: `${remoteWorkerModel.provider}/${remoteWorkerModel.id}` },
    }), { mode: 0o600 }),
    writeFile(join(agent, "models.yml"), "providers: {}\n", { mode: 0o600 }),
  ]);
  return env;
}

type ExecFixture = {
  readonly destination: string;
  readonly startAttempts: string;
  readonly lostStartReceipt: string;
} & ({
  readonly transport: "loopback";
  readonly argv: readonly [string, ...string[]];
  readonly env: Record<string, string>;
  readonly virtualCwd: string;
  readonly workerAlias: string;
} | {
  readonly transport: "ssh";
  readonly ssh: string;
});

/**
 * HEAD-side `ssh` on PATH. In loopback mode it is the whole transport: no sshd,
 * keys, user account, or network. In ssh mode it relays the unchanged argv to
 * the real OpenSSH client. Both record each start and drop the first committed
 * start reply, so HEAD must recover the launch without a second one.
 */
export async function loopbackWorkerExec(fixture: ExecFixture): Promise<void> {
  const args = process.argv.slice(2);
  assert.deepEqual(args.slice(-3), ["--", fixture.destination, "omp-sa-worker"]);
  assert.ok(args.includes("-T") && args.includes("-a") && args.includes("StrictHostKeyChecking=yes"));
  const request = parse(requestSchema, await decodeHeader(process.stdin, REQUEST_TIMEOUT), "worker request");
  const loopback = fixture.transport === "loopback" ? fixture : undefined;
  if (loopback && request.op === "resolve") assert.equal(request.cwd, loopback.virtualCwd);
  // Model the remote filesystem namespace only. Identity, launch and attach
  // still go through the real CLI; resolve calls the real worker realpath.
  const header = encodeHeader(loopback && request.op === "resolve" ? { ...request, cwd: loopback.workerAlias } : request);
  const dropStartReply = request.op === "start" && !existsSync(fixture.lostStartReceipt);
  if (request.op === "start") await appendFile(fixture.startAttempts, `${request.lane.generation}\n`, { mode: 0o600 });
  const [command, ...argv] = fixture.transport === "loopback" ? fixture.argv : [fixture.ssh, ...args];
  const child = spawn(command, argv, {
    env: fixture.transport === "loopback" ? fixture.env : process.env, stdio: ["pipe", dropStartReply ? "pipe" : "inherit", "inherit"],
  });
  const input = child.stdin;
  assert.ok(input, "Loopback worker requires its private control pipe");
  const terminate = () => child.kill("SIGTERM");
  const pipeError = () => process.stdin.destroy();
  process.once("SIGTERM", terminate);
  input.on("error", pipeError);
  try {
    const exit = once(child, "exit");
    // Bodies (provisioning, inputs) and attach streams follow the header.
    input.write(header);
    process.stdin.pipe(input);
    if (dropStartReply) {
      assert.ok(child.stdout);
      const reply = parse(replySchema, await decodeHeader(child.stdout, START_TIMEOUT), "lost start reply");
      assert.ok("value" in reply, "Only a committed worker start reply can be dropped");
      const { pid } = parse(startedSchema, reply.value, "lost start result");
      await writeFile(fixture.lostStartReceipt, JSON.stringify({ laneId: request.lane.id, generation: request.lane.generation, pid }),
        { mode: 0o600, flag: "wx" });
    }
    const [code] = await exit;
    process.exitCode = code === 0 && dropStartReply ? 83 : typeof code === "number" ? code : 1;
  } finally {
    process.stdin.unpipe(input);
    process.stdin.destroy();
    process.off("SIGTERM", terminate);
  }
}

export async function nativeRemoteWorkerFixture(root: string) {
  const bun = await realpath(process.execPath);
  const localPath = [dirname(bun), "/usr/bin", "/bin"].join(delimiter);
  const headHome = join(root, "head-home");
  const workerHome = join(root, "worker-home");
  const headState = join(root, "head");
  const headCwd = join(root, "head-cwd");
  const stateDir = join(root, "ws");
  const cwd = join(workerHome, "workspace");
  const workerAlias = join(workerHome, "workspace-link");
  const virtualCwd = join(root, "not-mounted-at-head", "workspace");
  const installation = join(workerHome, "package");
  const sshBin = join(root, "bin");
  const provisionDir = join(workerHome, ".config", "omp-superagent");
  const destination = "native-worker-loopback";
  const workerId = randomUUID();
  const instance = randomUUID();
  const probe = randomUUID();
  const startAttempts = join(root, "worker-start-attempts");
  const lostStartReceipt = join(root, "lost-worker-start.json");
  await Promise.all([headCwd, join(headState, "logs"), join(headState, "sessions", "main"), stateDir, cwd, sshBin, provisionDir].map(path =>
    mkdir(path, { recursive: true, mode: 0o700 })));
  const [headEnv, workerEnv] = await Promise.all([
    privateProfile(headHome, root, localPath), privateProfile(workerHome, root, localPath),
  ]);
  const command = await nativeTestCommand({ ...headEnv, OMP_TEST_COMMAND: JSON.stringify(nativeTestArgv()),
    OMP_TEST_NATIVES_DIR: headEnv.PI_NATIVES_DIR });
  assert.equal(command.length, 1, "Worker provisioning requires one installed stock OMP executable, without CLI overrides");
  await stageWorker(installation);
  const workerCustody = join(installation, custody);
  const worker: typeof import("./host-fixture-processes") = await import(workerCustody);
  const loopback: ExecFixture = { transport: "loopback", destination, virtualCwd, workerAlias, startAttempts, lostStartReceipt,
    argv: [bun, "--no-env-file", join(installation, "bin/omp-sa-worker")],
    env: { ...workerEnv, SA_PROOF_CUSTODY: workerCustody, SA_PROOF_ROOT: stateDir, OMP_SUPERAGENT_TEST_WORKER_CONTEXT: "direct" },
  };
  await Promise.all([
    writeFile(join(provisionDir, "worker.json"), JSON.stringify({ workerId, instance, stateDir, workspaceRoots: [cwd], command }),
      { mode: 0o600 }),
    writeFile(join(cwd, workspaceProbe), probe, { mode: 0o600 }),
    symlink(cwd, workerAlias, "dir"),
    writeFile(join(sshBin, "ssh"), `#!${bun} --no-env-file
import { loopbackWorkerExec } from ${JSON.stringify(import.meta.path)};
await loopbackWorkerExec(${JSON.stringify(loopback)});
`, { mode: 0o700 }),
  ]);
  const gate = recoveryGate(stateDir);
  return {
    destination, workerId, instance, laneCwd: virtualCwd, cwd, stateDir, headState, headCwd, probe, command, provider, managedPackage,
    startAttempts, lostStartReceipt,
    transportPath: [sshBin, localPath].join(delimiter),
    headEnv: { ...headEnv, SA_PROOF_ROOT: headState, SA_PROOF_CUSTODY: join(repo, custody), OMP_SUPERAGENT_ROLE: "head" },
    assertWorkerOwner: (root, identity) => worker.assertResidentFixtureOwner(root, identity),
    waitForGate: () => waitForProofFile(gate.entered),
    releaseGate: () => writeFile(gate.release, "", { mode: 0o600, flag: "wx" }),
    readWorkerFile: path => readFile(path, "utf8"),
    localJournal: async path => path,
    async stopWorkers(): Promise<void> {
      const directories = await readdir(stateDir, { withFileTypes: true });
      for (const dir of directories) {
        if (dir.isDirectory() && /^[a-f0-9]{24}$/.test(dir.name)) await worker.stopHostFixtures(join(stateDir, dir.name));
      }
    },
    async cleanup(): Promise<void> {},
  } satisfies RemoteWorkerProof;
}

/** What the shared scenario needs from a worker, wherever it runs. */
export interface RemoteWorkerProof {
  readonly destination: string;
  readonly workerId: string;
  readonly instance: string;
  /** The cwd HEAD passes; only the worker can resolve it. */
  readonly laneCwd: string;
  /** The worker's canonical workspace. */
  readonly cwd: string;
  readonly stateDir: string;
  readonly probe: string;
  readonly headState: string;
  readonly headCwd: string;
  readonly command: string[];
  readonly provider: string;
  readonly managedPackage: string;
  readonly startAttempts: string;
  readonly lostStartReceipt: string;
  readonly transportPath: string;
  readonly headEnv: Record<string, string>;
  assertWorkerOwner(root: string, identity: { readonly nativePid: number; readonly ownerPid: number }): Promise<void>;
  waitForGate(): Promise<void>;
  releaseGate(): Promise<void>;
  readWorkerFile(path: string): Promise<string>;
  /** A local path holding the worker journal's current bytes. */
  localJournal(path: string): Promise<string>;
  stopWorkers(): Promise<void>;
  /** Remove per-run worker state after a completed run. */
  cleanup(): Promise<void>;
  /** Optional run evidence for an operator-run proof. */
  record?(evidence: Record<string, unknown>): Promise<void>;
  /** Optional: where and with what environment the worker's Host owner runs. */
  workerProcess?(ownerPid: number): Promise<Record<string, unknown>>;
}

/**
 * Operator-provisioned real worker reached through the operator's OpenSSH
 * alias. The worker account runs the installed omp-sa-worker and stock OMP
 * with this offline provider in a private profile (see docs/OPERATIONS.md).
 */
export const sshWorkerSettings = Type.Object({
  destination: Type.String({ minLength: 1 }), workerId: Type.String({ minLength: 1 }), instance: Type.String({ minLength: 1 }),
  cwd: Type.String({ pattern: "^/" }), stateDir: Type.String({ pattern: "^/" }),
  install: Type.String({ pattern: "^/" }), bun: Type.String({ pattern: "^/" }),
  /** Login destination for fixture observation when `destination` uses a forced-command worker key. */
  observe: Type.Optional(Type.String({ minLength: 1 })),
}, { additionalProperties: false });

export async function sshRemoteWorkerFixture(root: string, value: string): Promise<RemoteWorkerProof> {
  const settings = parse(sshWorkerSettings, JSON.parse(value), "OMP_SUPERAGENT_SSH_WORKER");
  const bun = await realpath(process.execPath);
  const localPath = [dirname(bun), "/usr/bin", "/bin"].join(delimiter);
  const headHome = join(root, "head-home");
  const headState = join(root, "head");
  const headCwd = join(root, "head-cwd");
  const sshBin = join(root, "bin");
  const startAttempts = join(root, "worker-start-attempts");
  const lostStartReceipt = join(root, "lost-worker-start.json");
  const journals = join(root, "journals");
  await Promise.all([headCwd, join(headState, "logs"), join(headState, "sessions", "main"), sshBin, journals].map(path =>
    mkdir(path, { recursive: true, mode: 0o700 })));
  const headEnv = await privateProfile(headHome, root, localPath);
  const command = await nativeTestCommand({ ...headEnv, OMP_TEST_COMMAND: JSON.stringify(nativeTestArgv()),
    OMP_TEST_NATIVES_DIR: headEnv.PI_NATIVES_DIR });
  const ssh = Bun.which("ssh");
  assert.ok(ssh, "The real-SSH proof requires an OpenSSH client on PATH");
  // Fixture-only side channel through the same alias for observation and the
  // provider gate; HEAD itself only ever runs the fixed omp-sa-worker command.
  const remote = async (script: string): Promise<string> => {
    const child = Bun.spawn([ssh, "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "--", settings.observe ?? settings.destination,
      `exec ${settings.bun} --no-env-file run -`], { stdin: new Blob([script]), stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(`Worker observation failed (${code}): ${err.trim()}`);
    return out;
  };
  const custodyModule = JSON.stringify(join(settings.install, custody));
  const providerModule = JSON.stringify(join(settings.install, "test/fixtures/native-remote-worker-provider.ts"));
  const gate = recoveryGate(settings.stateDir);
  const run = async (script: string) => JSON.parse(await remote(`${script}\n`)) as unknown;
  const probe = String(await run(`console.log(JSON.stringify(require("node:fs").readFileSync(${JSON.stringify(join(settings.cwd, workspaceProbe))}, "utf8")));`));
  // A prior aborted run must not satisfy this run's gate.
  await run(`const fs = require("node:fs"); for (const p of ${JSON.stringify([gate.entered, gate.release])}) fs.rmSync(p, { force: true }); console.log("null");`);
  const lanes = async () => await run(`console.log(JSON.stringify(require("node:fs").readdirSync(${JSON.stringify(settings.stateDir)}, { withFileTypes: true })
    .filter(d => d.isDirectory() && /^[a-f0-9]{24}$/.test(d.name)).map(d => d.name)));`) as string[];
  const preexisting = new Set(await lanes());
  // Lane IDs and the pinned HEAD instance repeat across runs. Reservations an
  // aborted run left behind make the worker (correctly) refuse the new lane.
  const reservations = await run(`const { Database } = require("bun:sqlite"); const fs = require("node:fs");
    const path = ${JSON.stringify(join(settings.stateDir, "lanes.sqlite"))};
    console.log(fs.existsSync(path) ? new Database(path, { readonly: true }).query("SELECT COUNT(*) AS n FROM launches").get().n : 0);`);
  assert.equal(reservations, 0, `Worker ${settings.stateDir} still holds reservations from an earlier run; stop and remove them first`);
  const exec: ExecFixture = { transport: "ssh", ssh, destination: settings.destination, startAttempts, lostStartReceipt };
  await writeFile(join(sshBin, "ssh"), `#!${bun} --no-env-file
import { loopbackWorkerExec } from ${JSON.stringify(import.meta.path)};
await loopbackWorkerExec(${JSON.stringify(exec)});
`, { mode: 0o700 });
  let journal = 0;
  const created = async () => (await lanes()).filter(name => !preexisting.has(name));
  return {
    destination: settings.destination, workerId: settings.workerId, instance: settings.instance,
    laneCwd: settings.cwd, cwd: settings.cwd, stateDir: settings.stateDir, probe,
    headState, headCwd, command, provider, managedPackage, startAttempts, lostStartReceipt,
    transportPath: [sshBin, localPath].join(delimiter),
    headEnv: { ...headEnv, SA_PROOF_ROOT: headState, SA_PROOF_CUSTODY: join(repo, custody), OMP_SUPERAGENT_ROLE: "head" },
    assertWorkerOwner: async (dir, identity) => {
      await run(`await (await import(${custodyModule})).assertResidentFixtureOwner(${JSON.stringify(dir)}, ${JSON.stringify(identity)}); console.log("null");`);
    },
    waitForGate: async () => {
      await run(`await (await import(${providerModule})).waitForProofFile(${JSON.stringify(gate.entered)}); console.log("null");`);
    },
    releaseGate: async () => {
      await run(`require("node:fs").writeFileSync(${JSON.stringify(gate.release)}, "", { mode: 0o600, flag: "wx" }); console.log("null");`);
    },
    readWorkerFile: async path => String(await run(`console.log(JSON.stringify(require("node:fs").readFileSync(${JSON.stringify(path)}, "utf8")));`)),
    localJournal: async path => {
      const copy = join(journals, `${journal++}.jsonl`);
      await writeFile(copy, String(await run(`console.log(JSON.stringify(require("node:fs").readFileSync(${JSON.stringify(path)}, "utf8")));`)), { mode: 0o600 });
      return copy;
    },
    async stopWorkers(): Promise<void> {
      const dirs = (await created()).map(name => join(settings.stateDir, name));
      await run(`const { stopHostFixtures } = await import(${custodyModule});
        for (const dir of ${JSON.stringify(dirs)}) await stopHostFixtures(dir); console.log("null");`);
    },
    workerProcess: async ownerPid => await run(`const fs = require("node:fs"); const os = require("node:os");
      const env = Object.fromEntries(fs.readFileSync("/proc/${ownerPid}/environ", "utf8").split("\\0").filter(Boolean)
        .map(entry => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)]));
      const shell = os.userInfo().shell;
      // A fresh login shell in the account's user manager, not this observer's (bun-modified) environment.
      const login = Bun.spawnSync(["systemd-run", "--user", "--quiet", "--wait", "--pipe", "--collect", "--",
        shell, "-l", "-i", "-c", "printf '%s' \\"$PATH\\""], { stdin: "ignore", stderr: "ignore" }).stdout.toString();
      console.log(JSON.stringify({ cgroup: fs.readFileSync("/proc/${ownerPid}/cgroup", "utf8").trim(),
        // First-occurrence order decides command resolution; rc files may repeat entries.
        pathResolvesLikeLoginShell: [...new Set(env.PATH.split(":"))].join(":") === [...new Set(login.split(":"))].join(":"),
        hostPath: env.PATH, loginShellPath: login, sshConnectionPresent: "SSH_CONNECTION" in env, role: env.OMP_SUPERAGENT_ROLE,
        managedUlw: env.OMP_SUPERAGENT_MANAGED_ULW_PATH ?? null, home: env.HOME }));`) as Record<string, unknown>,
    async record(evidence): Promise<void> {
      const worker = await run(`const os = require("node:os");
        console.log(JSON.stringify({ hostname: os.hostname(), platform: process.platform, arch: process.arch, user: os.userInfo().username }));`);
      console.log(`SSH worker proof: ${JSON.stringify({ destination: settings.destination, worker, ...evidence })}`);
    },
    async cleanup(): Promise<void> {
      const dirs = (await created()).map(name => join(settings.stateDir, name));
      // Lane IDs and the pinned HEAD instance repeat across runs, so also drop
      // this run's durable reservations; the worker never reuses released state.
      await run(`const fs = require("node:fs"); const { Database } = require("bun:sqlite");
        const db = new Database(${JSON.stringify(join(settings.stateDir, "lanes.sqlite"))});
        for (const dir of ${JSON.stringify(dirs)}) db.query("DELETE FROM launches WHERE lane = ?").run(dir);
        db.close();
        for (const p of ${JSON.stringify([...dirs, gate.entered, gate.release])}) fs.rmSync(p, { recursive: true, force: true }); console.log("null");`);
    },
  };
}
