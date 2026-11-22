import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { main } from "../src/cli";
import { enrollWorker, readWorkerPolicy } from "../src/worker-enrollment";
import { addWorker, listWorkers } from "../src/worker-registration";
import { workerRepositoryIdentity } from "../src/worker-repository";
import type { WorkerDescription, WorkerLaneRef } from "../src/worker-wire";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(realpathSync("/tmp"), "sw-"));
  roots.push(root);
  const stateDir = join(root, "head");
  const home = join(root, "h'$");
  mkdirSync(home, { mode: 0o700 });
  return { root, home, options: { stateDir, destination: "worker@build.tailnet.example" } };
}

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(["/usr/bin/git", ...args], {
    cwd, env: { PATH: "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trimEnd();
}

function targetRepo(root: string, name: string): string {
  const path = join(root, name);
  mkdirSync(path);
  git(path, ["init", "--quiet"]);
  git(path, ["config", "--local", "remote.origin.url", `https://github.com/example/${name}.git`]);
  return path;
}

const describeBeforeAuthorization = async (): Promise<WorkerDescription> => {
  throw new Error("The target has not authorized the key");
};

async function pendingKey(options: Parameters<typeof addWorker>[0]) {
  const result = await addWorker(options, describeBeforeAuthorization);
  if (result.status !== "pending") throw new Error("Expected a pending enrollment");
  return result;
}

async function defaultCheckout(root: string) {
  const cwd = targetRepo(root, "head-checkout");
  git(cwd, ["-c", "user.name=Fixture", "-c", "user.email=test@example.invalid", "-c", "commit.gpgSign=false",
    "commit", "--quiet", "--allow-empty", "-m", "Fixture"]);
  const revision = git(cwd, ["rev-parse", "HEAD"]);
  const repoId = await workerRepositoryIdentity(cwd);
  if (!repoId) throw new Error("Expected a network repository identity");
  const description: WorkerDescription = {
    workerId: "worker-verified", platform: "linux", stateDir: "/private/worker", capacity: 1, active: 0,
    repos: [{ id: repoId, cwd: "/srv/allowed-checkout" }],
  };
  return { cwd, revision, repoId, description };
}

test("worker add leaves first-phase keys private and registers only a verified rerun with that same key", async () => {
  const { root, options } = fixture();
  const { cwd, repoId, revision, description } = await defaultCheckout(root);
  const enroll = { ...options, defaultRepositoryRoot: cwd };
  const pending = await pendingKey(enroll);
  expect(pending.initCommand).toContain(`--head-key '${pending.publicKey}'`);
  expect(listWorkers(options.stateDir)).toEqual([]);

  const scoped: Pick<WorkerLaneRef, "repoId" | "revision" | "subdir">[] = [];
  await addWorker(enroll, async ({ identityFile }, workspace) => {
    if (workspace) scoped.push(workspace);
    expect(lstatSync(identityFile).mode & 0o777).toBe(0o600);
    const result = Bun.spawnSync(["ssh-keygen", "-y", "-f", identityFile],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim().split(/\s+/).slice(0, 2).join(" ")).toBe(pending.publicKey);
    return description;
  });
  expect(scoped).toEqual([{ repoId, revision, subdir: "" }]);
  expect(listWorkers(options.stateDir).map(({ identityFile: _key, ...worker }) => worker))
    .toEqual([{ destination: options.destination, description, default: true, defaultRepository: { root: cwd, repoId } }]);
});

test.each([false, true])("add --default refuses incompatible worker inventory or revision (approved identity: %s)", async approved => {
  const { root, options } = fixture();
  const { cwd, description } = await defaultCheckout(root);
  await pendingKey(options);
  const observed = approved ? description : { ...description, repos: [{ id: "a".repeat(64), cwd: "/srv/other" }] };
  let scoped = 0;

  await expect(addWorker({ ...options, defaultRepositoryRoot: cwd }, async (_endpoint, workspace) => {
    if (workspace) {
      scoped++;
      throw new Error("The worker is at another revision");
    }
    return observed;
  })).rejects.toThrow(approved ? /requested Git revision/ : /not approved for the default repository identity/);

  expect(scoped).toBe(approved ? 1 : 0);
  expect(listWorkers(options.stateDir)).toEqual([]);
});

test("add --default refuses a head workspace below its checkout root before pairing", async () => {
  const { root, options } = fixture();
  const { cwd, description } = await defaultCheckout(root);
  const nested = join(cwd, "nested");
  mkdirSync(nested);
  writeFileSync(join(nested, "entry"), "Fixture\n");
  git(cwd, ["add", "."]);
  git(cwd, ["-c", "user.name=Fixture", "-c", "user.email=test@example.invalid", "-c", "commit.gpgSign=false",
    "commit", "--quiet", "-m", "Commit nested directory"]);

  await expect(addWorker({ ...options, defaultRepositoryRoot: nested }, async () => description))
    .rejects.toThrow(/root of a clean head-side Git checkout/);
  expect(existsSync(options.stateDir)).toBe(false);
});

test("failed verification does not publish a pending worker or overwrite a pinned registration", async () => {
  const { options } = fixture();
  const { publicKey } = await pendingKey(options);
  await expect(addWorker(options, describeBeforeAuthorization)).resolves.toMatchObject({
    status: "pending", publicKey, verificationError: "Worker could not be verified using its dedicated key and a known SSH host key",
  });
  expect(listWorkers(options.stateDir)).toEqual([]);

  const description: WorkerDescription = {
    workerId: "worker-verified", platform: "darwin", stateDir: "/private/worker", capacity: 1, active: 0,
    repos: [{ id: "9".repeat(64), cwd: "/srv/allowed-checkout" }],
  };
  await addWorker(options, async () => description);
  await expect(addWorker(options, async () => ({ ...description, stateDir: "/elsewhere" }))).rejects.toThrow(/no longer matches/);
  expect(listWorkers(options.stateDir).map(worker => worker.description.stateDir)).toEqual(["/private/worker"]);
});

test("target init appends one fixed restricted key and preserves prior authorization and policy on repeat", async () => {
  const { home, root, options } = fixture();
  const { publicKey } = await pendingKey(options);
  const first = targetRepo(root, "one");
  const second = targetRepo(root, "two");
  const auth = join(home, ".ssh", "authorized_keys");
  mkdirSync(join(home, ".ssh"), { mode: 0o700 });
  const previous = "# User-owned existing content without a final newline";
  writeFileSync(auth, previous, { mode: 0o640 });
  const authorization = lstatSync(auth);
  const target = { home, headKey: `${publicKey} workstation`, executable: process.execPath, repositories: [first, second] };

  const result = await enrollWorker(target);
  await expect(enrollWorker({ ...target, repositories: [second, first] })).resolves.toEqual(result);
  const authBytes = readFileSync(auth, "utf8");
  expect(authBytes.split("\n").slice(0, 1)).toEqual([previous]);
  const entry = authBytes.split("\n")[1] ?? "";
  expect(entry).toMatch(/^restrict,command="exec .* '--no-env-file'/);
  expect(entry).toContain(` 'worker' 'serve' '--policy' `);
  expect(entry.endsWith(` ${publicKey} omp-sa-worker`)).toBe(true);
  expect(authBytes.trimEnd().split("\n")).toHaveLength(2);
  expect(lstatSync(auth).ino).toBe(authorization.ino);
  expect(lstatSync(auth).mode & 0o777).toBe(authorization.mode & 0o777);
  const policyFile = join(result.stateDir, "policy.json");
  expect(lstatSync(policyFile).mode & 0o777).toBe(0o600);
  expect(readWorkerPolicy(home, policyFile)).toEqual(result);
  expect(result.repos.map(repo => repo.cwd).sort()).toEqual([first, second]);
});

test("target init refuses a permissive duplicate rather than authorizing or altering that key", async () => {
  const { home, root, options } = fixture();
  const { publicKey } = await pendingKey(options);
  const repo = targetRepo(root, "checkout");
  const auth = join(home, ".ssh", "authorized_keys");
  mkdirSync(join(home, ".ssh"), { mode: 0o700 });
  const unscoped = `  ${publicKey.replace(" ", "\t")} unrelated login key\r\n`;
  writeFileSync(auth, unscoped, { mode: 0o600 });

  await expect(enrollWorker({ home, headKey: publicKey, executable: process.execPath, repositories: [repo] }))
    .rejects.toThrow(/different or duplicate authorization/);
  expect(readFileSync(auth, "utf8")).toBe(unscoped);
});

test("target init refuses nested paths and leaves SSH untouched", async () => {
  const { home, root, options } = fixture();
  const { publicKey } = await pendingKey(options);
  const nested = join(targetRepo(root, "checkout"), "nested");
  mkdirSync(nested);
  await expect(enrollWorker({ home, headKey: publicKey, executable: process.execPath, repositories: [nested] }))
    .rejects.toThrow(/root of an existing non-bare Git checkout/);
  expect(existsSync(join(home, ".ssh"))).toBe(false);
});

test("worker CLI rejects extra options before consulting account or configuration state", async () => {
  await expect(main(["worker", "init", "--head-key", "ignored", "--repo", "/unused", "--config", "/unused"]))
    .rejects.toThrow(/Usage: omp-sa worker init/);
  await expect(main(["worker", "serve", "--policy", "/unused", "--help"]))
    .rejects.toThrow(/requires the enrolled SSH forced command/);
  await expect(main(["worker", "add", "user@host", "--default", "--default"]))
    .rejects.toThrow(/Usage: omp-sa worker add/);
  await expect(main(["worker", "add", "user@host", "--local-repo", "/unused"]))
    .rejects.toThrow(/Usage: omp-sa worker add/);
});

test.each([false, true])("worker add --default pins the configured or explicitly selected checkout (override: %s)", async override => {
  const { root, options } = fixture();
  const { cwd, repoId, description } = await defaultCheckout(root);
  const config = join(root, "config.json");
  writeFileSync(config, JSON.stringify({
    stateDir: options.stateDir, headCwd: override ? root : cwd, command: [process.execPath],
    maxHosts: 2, maxSubagents: 2, idleMs: 0,
    telegram: { tokenEnv: "UNUSED_FIXTURE_TOKEN", ownerId: "123", allowedChatIds: [] },
  }));
  await pendingKey(options);
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "ssh"), '#!/bin/sh\nIFS= read -r request || exit 11\nprintf "%s\\n" "$WORKER_REPLY"\n', { mode: 0o700 });
  const cli = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "../src/cli.ts"),
    "worker", "add", options.destination, "--config", config, "--default", ...(override ? ["--local-repo", "head-checkout"] : [])], {
    cwd: root, env: { PATH: bin, HOME: root, WORKER_REPLY: JSON.stringify({ ok: true, value: description }) },
    stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10_000,
  });
  const [status, output, stderr] = await Promise.all([cli.exited, new Response(cli.stdout).text(), new Response(cli.stderr).text()]);
  if (status !== 0) throw new Error(stderr);

  expect(JSON.parse(output)).toMatchObject({ status: "verified", default: true });
  expect(listWorkers(options.stateDir).map(worker => worker.defaultRepository)).toEqual([{ root: cwd, repoId }]);
});

test("CLI stop does not connect to a local namesake when the durable remote worker is unregistered", async () => {
  const { root, options: { stateDir } } = fixture();
  const config = join(root, "config.json");
  writeFileSync(config, JSON.stringify({
    headCwd: root, stateDir, command: [process.execPath], maxHosts: 2, maxSubagents: 2, idleMs: 0,
    telegram: { tokenEnv: "UNUSED_FIXTURE_TOKEN", ownerId: "123", allowedChatIds: [] },
  }));
  const laneId = "lane-owned-remote";
  const remote = { workerId: "worker-not-enrolled", repoId: "a".repeat(64), revision: "b".repeat(40),
    subdir: "", stateDir: "/fixture-worker" };
  const lane = { id: laneId, generation: 1, pid: 12345, sessionId: "fixture-session",
    socketPath: join(remote.stateDir, "run", `${laneId}.sock`),
    sessionFile: join(remote.stateDir, "sessions", laneId, "session.jsonl") };
  const localRun = join(stateDir, "run");
  mkdirSync(localRun, { recursive: true, mode: 0o700 });
  const db = new Database(join(stateDir, "coordination.sqlite"));
  try {
    db.run("CREATE TABLE lanes (data TEXT NOT NULL, remote TEXT)");
    db.run("INSERT INTO lanes (data, remote) VALUES (?, ?)", [JSON.stringify(lane), JSON.stringify(remote)]);
  } finally { db.close(); }
  const localSocket = join(localRun, `${laneId}.sock`);
  let connections = 0;
  const server = createServer(socket => { connections++; socket.destroy(); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject).listen(localSocket, resolve); });
  try {
    chmodSync(localSocket, 0o600);
    await expect(main(["stop", laneId, "--config", config])).rejects.toThrow("Remote lane has no matching verified worker registration");
    expect(connections).toBe(0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => { if (error) reject(error); else resolve(); }));
  }
});
