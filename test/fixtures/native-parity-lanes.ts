import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { cp, mkdir, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { nativeTestArgv, nativeTestCommand } from "./native-command";
import { nativeDisabledProviders } from "./native-extension";
import { offlineMnemopi } from "./native-memory";
import { sshWorkerSettings } from "./native-remote-worker";
import { parse } from "../../src/remote-worker-wire";
import { installWorkerLauncher, launcherPath, supportDirectory } from "../../src/worker-macos";
import { assertLaunchdOwner, awaitNoWorkerJobs } from "./worker-launchd";
import { parityModel, parityProbe } from "./native-parity-provider";
import type * as HostFixtures from "./host-fixture-processes";

const repo = resolve(import.meta.dir, "../..");
const provider = join(import.meta.dir, "native-parity-provider.ts");
/** What production gives every lane Host, local (extension.ts) and remote (the worker). */
const laneExtension = join(repo, "src/lane-extension.ts");
const custody = "test/fixtures/host-fixture-processes.ts";
const remoteTransport = join(import.meta.dir, "native-remote-worker.ts");
const managedPackage = join(import.meta.dir, "managed-ulw");

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

/** One private OMP account: its own native home, config, caches and the parity provider as default model. */
async function privateProfile(home: string, root: string, executablePath: string): Promise<Record<string, string>> {
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
      modelRoles: { default: `${parityModel.provider}/${parityModel.id}` },
    }), { mode: 0o600 }),
    writeFile(join(agent, "models.yml"), "providers: {}\n", { mode: 0o600 }),
  ]);
  return env;
}

/** The HEAD account, local lane workspace and `ssh` shim directory that every parity run shares. */
async function headSide(root: string, probe: string) {
  const bun = await realpath(process.execPath);
  const localPath = [dirname(bun), "/usr/bin", "/bin"].join(delimiter);
  const headHome = join(root, "head-home");
  const headState = join(root, "head");
  const headCwd = join(root, "head-cwd");
  const localCwd = join(root, "local-workspace");
  const sshBin = join(root, "bin");
  await Promise.all([headCwd, join(headState, "logs"), join(headState, "sessions", "main"), localCwd, sshBin]
    .map(path => mkdir(path, { recursive: true, mode: 0o700 })));
  const headEnv = await privateProfile(headHome, root, localPath);
  const command = await nativeTestCommand({ ...headEnv, OMP_TEST_COMMAND: JSON.stringify(nativeTestArgv()),
    OMP_TEST_NATIVES_DIR: headEnv.PI_NATIVES_DIR });
  assert.equal(command.length, 1, "Worker provisioning requires one installed stock OMP executable, without CLI overrides");
  await writeFile(join(localCwd, parityProbe), probe, { mode: 0o600 });
  const startAttempts = join(root, "worker-start-attempts");
  // An existing receipt disables the transport's lost-start-reply fault: this proof compares steady-state behavior.
  const lostStartReceipt = join(root, "lost-worker-start.json");
  await writeFile(lostStartReceipt, "{}", { mode: 0o600 });
  return {
    bun, localPath, headState, headCwd, localCwd, sshBin, command, startAttempts, lostStartReceipt,
    transportPath: [sshBin, localPath].join(delimiter),
    headEnv: { ...headEnv, SA_PROOF_ROOT: headState, SA_PROOF_CUSTODY: join(repo, custody), OMP_SUPERAGENT_ROLE: "head" },
    /** HEAD-side `ssh` on PATH: the fixture transport runs the worker CLI behind it. */
    shim: (exec: object) => writeFile(join(sshBin, "ssh"), `#!${bun} --no-env-file
import { loopbackWorkerExec } from ${JSON.stringify(remoteTransport)};
await loopbackWorkerExec(${JSON.stringify(exec)});
`, { mode: 0o700 }),
  };
}

/** What the parity test needs from a worker, wherever it runs. */
export interface ParityFixture {
  readonly destination: string;
  readonly workerId: string;
  readonly instance: string;
  readonly probe: string;
  readonly localCwd: string;
  readonly workerCwd: string;
  readonly stateDir: string;
  readonly headState: string;
  readonly headCwd: string;
  readonly command: string[];
  readonly provider: string;
  readonly laneExtension: string;
  readonly managedPackage: string;
  readonly transportPath: string;
  readonly headEnv: Record<string, string>;
  /** The worker account is its own machine profile (skills, OS, platform notes), not a copy of HEAD's. */
  readonly accountEnvironment: boolean;
  stopWorkers(): Promise<void>;
  /** Remove per-run worker state after a completed run. */
  cleanup(): Promise<void>;
  /** Optional: where and with what environment a worker lane's Host owner runs. */
  workerProcess?(ownerPid: number): Promise<Record<string, unknown>>;
  /** Optional: which machine and account the worker is. */
  workerIdentity?(): Promise<Record<string, unknown>>;
}

/**
 * One HEAD account that runs a local lane and reaches a loopback worker account
 * (no sshd: the `ssh` shim on PATH launches the worker's real `omp-sa-worker`
 * with OMP_SUPERAGENT_TEST_WORKER_CONTEXT=direct, or with `launchd` through the
 * real gui-domain LaunchAgent on macOS). Both accounts load the same
 * deterministic provider, so the same scripted scenario runs on either lane.
 */
export async function nativeLaneParityFixture(root: string, launchd = false): Promise<ParityFixture> {
  const workerHome = join(root, "worker-home");
  const stateDir = join(root, "ws");
  const workerCwd = join(workerHome, "workspace");
  const installation = join(workerHome, "package");
  const provisionDir = join(workerHome, ".config", "omp-superagent");
  const destination = "native-parity-loopback";
  const workerId = randomUUID();
  const instance = randomUUID();
  const probe = randomUUID();
  await Promise.all([stateDir, workerCwd, provisionDir].map(path => mkdir(path, { recursive: true, mode: 0o700 })));
  const head = await headSide(root, probe);
  const workerEnv = await privateProfile(workerHome, root, head.localPath);
  await stageWorker(installation);
  const support = supportDirectory(workerHome);
  if (launchd) installWorkerLauncher(support);
  const workerCustody = join(installation, custody);
  const worker: typeof HostFixtures = await import(workerCustody);
  const loopback = { transport: "loopback", destination, startAttempts: head.startAttempts, lostStartReceipt: head.lostStartReceipt,
    argv: [head.bun, "--no-env-file", join(installation, "bin/omp-sa-worker")],
    env: { ...workerEnv, SA_PROOF_CUSTODY: workerCustody, SA_PROOF_ROOT: stateDir,
      OMP_SUPERAGENT_TEST_WORKER_CONTEXT: launchd ? "forward-env" : "direct" },
    virtualCwd: workerCwd, workerAlias: workerCwd,
  };
  await Promise.all([
    writeFile(join(provisionDir, "worker.json"), JSON.stringify({ workerId, instance, stateDir, workspaceRoots: [workerCwd], command: head.command }),
      { mode: 0o600 }),
    writeFile(join(workerCwd, parityProbe), probe, { mode: 0o600 }),
    head.shim(loopback),
  ]);
  return {
    destination, workerId, instance, probe, workerCwd, stateDir, provider, laneExtension, managedPackage,
    localCwd: head.localCwd, headState: head.headState, headCwd: head.headCwd, command: head.command,
    transportPath: head.transportPath, headEnv: head.headEnv, accountEnvironment: launchd,
    async stopWorkers(): Promise<void> {
      const directories = await readdir(stateDir, { withFileTypes: true });
      for (const dir of directories) {
        if (dir.isDirectory() && /^[a-f0-9]{24}$/.test(dir.name)) await worker.stopHostFixtures(join(stateDir, dir.name));
      }
    },
    async cleanup(): Promise<void> { if (launchd) await awaitNoWorkerJobs(); },
    ...launchd ? { async workerProcess(ownerPid: number) {
      assertLaunchdOwner(ownerPid, launcherPath(support));
      return { launchd: true, launcher: launcherPath(support) };
    } } : {},
  };
}

/**
 * The same proof against an operator-provisioned worker reached through the
 * operator's OpenSSH alias (settings as in sshRemoteWorkerFixture). The worker
 * account's installed stock OMP must also load the parity provider (see
 * docs/OPERATIONS.md); the worker's workspace receives this run's probe file.
 */
export async function sshLaneParityFixture(root: string, value: string): Promise<ParityFixture> {
  const settings = parse(sshWorkerSettings, JSON.parse(value), "OMP_SUPERAGENT_SSH_WORKER");
  const probe = randomUUID();
  const head = await headSide(root, probe);
  const ssh = Bun.which("ssh");
  assert.ok(ssh, "The real-SSH proof requires an OpenSSH client on PATH");
  // Fixture-only side channel through the same alias for observation and
  // cleanup; HEAD itself only ever runs the fixed omp-sa-worker command.
  const remote = async (script: string): Promise<string> => {
    const child = Bun.spawn([ssh, "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "--", settings.observe ?? settings.destination,
      `exec ${settings.bun} --no-env-file run -`], { stdin: new Blob([script]), stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(`Worker observation failed (${code}): ${err.trim()}`);
    return out;
  };
  const run = async (script: string) => JSON.parse(await remote(`${script}\n`)) as unknown;
  const custodyModule = JSON.stringify(join(settings.install, custody));
  const probeFile = join(settings.cwd, parityProbe);
  const lanes = async () => await run(`console.log(JSON.stringify(require("node:fs").readdirSync(${JSON.stringify(settings.stateDir)}, { withFileTypes: true })
    .filter(d => d.isDirectory() && /^[a-f0-9]{24}$/.test(d.name)).map(d => d.name)));`) as string[];
  const preexisting = new Set(await lanes());
  // Lane IDs and the pinned HEAD instance repeat across runs. Reservations an
  // aborted run left behind make the worker (correctly) refuse the new lane.
  const reservations = await run(`const { Database } = require("bun:sqlite"); const fs = require("node:fs");
    const path = ${JSON.stringify(join(settings.stateDir, "lanes.sqlite"))};
    console.log(fs.existsSync(path) ? new Database(path, { readonly: true }).query("SELECT COUNT(*) AS n FROM launches").get().n : 0);`);
  assert.equal(reservations, 0, `Worker ${settings.stateDir} still holds reservations from an earlier run; stop and remove them first`);
  assert.equal(await run(`console.log(JSON.stringify(require("node:fs").existsSync(${JSON.stringify(probeFile)})));`), false,
    `Worker workspace already holds ${probeFile} from an earlier run; remove it first`);
  await run(`require("node:fs").writeFileSync(${JSON.stringify(probeFile)}, ${JSON.stringify(probe)}, { mode: 0o600, flag: "wx" }); console.log("null");`);
  await head.shim({ transport: "ssh", ssh, destination: settings.destination, startAttempts: head.startAttempts, lostStartReceipt: head.lostStartReceipt });
  const created = async () => (await lanes()).filter(name => !preexisting.has(name)).map(name => join(settings.stateDir, name));
  return {
    destination: settings.destination, workerId: settings.workerId, instance: settings.instance, probe,
    workerCwd: settings.cwd, stateDir: settings.stateDir, provider, laneExtension, managedPackage,
    localCwd: head.localCwd, headState: head.headState, headCwd: head.headCwd, command: head.command,
    transportPath: head.transportPath, headEnv: head.headEnv, accountEnvironment: true,
    async stopWorkers(): Promise<void> {
      const dirs = await created();
      await run(`const { stopHostFixtures } = await import(${custodyModule});
        for (const dir of ${JSON.stringify(dirs)}) await stopHostFixtures(dir); console.log("null");`);
    },
    async cleanup(): Promise<void> {
      const dirs = await created();
      // Lane IDs and the pinned HEAD instance repeat across runs, so also drop
      // this run's durable reservations; the worker never reuses released state.
      await run(`const fs = require("node:fs"); const { Database } = require("bun:sqlite");
        const db = new Database(${JSON.stringify(join(settings.stateDir, "lanes.sqlite"))});
        for (const dir of ${JSON.stringify(dirs)}) db.query("DELETE FROM launches WHERE lane = ?").run(dir);
        db.close();
        for (const p of ${JSON.stringify([...dirs, probeFile])}) fs.rmSync(p, { recursive: true, force: true }); console.log("null");`);
    },
    workerIdentity: async () => await run(`const os = require("node:os");
      console.log(JSON.stringify({ hostname: os.hostname(), platform: process.platform, arch: process.arch, user: os.userInfo().username }));`) as Record<string, unknown>,
    workerProcess: async ownerPid => await run(`const fs = require("node:fs"); const os = require("node:os");
      const env = Object.fromEntries(fs.readFileSync("/proc/${ownerPid}/environ", "utf8").split("\\0").filter(Boolean)
        .map(entry => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)]));
      console.log(JSON.stringify({ cgroup: fs.readFileSync("/proc/${ownerPid}/cgroup", "utf8").trim(), hostPath: env.PATH,
        sshConnectionPresent: "SSH_CONNECTION" in env, role: env.OMP_SUPERAGENT_ROLE, home: env.HOME, shell: os.userInfo().shell,
        superagentEnvironment: Object.keys(env).filter(name => name.startsWith("OMP_SUPERAGENT_")).sort() }));`) as Record<string, unknown>,
  };
}
