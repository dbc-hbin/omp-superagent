import { randomUUID } from "node:crypto";
import {
  closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, realpathSync,
  unlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { stagePrivateFile } from "./credentials";
import {
  checkWorkerFile, readWorkerFile, shellWord, withWorkerWriteLock, workerDirectory,
  workerHash, workerPublicKey, WorkerRegistrationError,
} from "./worker-registration";
import { gitWorkerRepository, workerRepositoryIdentity } from "./worker-repository";
import { trustedWorkerPath, workerInstallRoot } from "./worker-trust";
import type { WorkerPolicy, WorkerRepo } from "./worker-wire";

const policyRoot = ".omp-sa-worker";
const policyFile = "policy.json";
const hashPattern = "^[0-9a-f]{64}$";
const maxRepositories = 128;
const controls = /[\u0000-\u001f\u007f]/;
const policySchema = Type.Object({
  fingerprint: Type.String({ pattern: hashPattern }),
  workerId: Type.String({ pattern: "^worker-[0-9a-f-]{36}$" }),
  stateDir: Type.String(),
  repos: Type.Array(Type.Object({ id: Type.String({ pattern: hashPattern }), cwd: Type.String() }, { additionalProperties: false }),
    { minItems: 1, maxItems: maxRepositories }),
  capacity: Type.Literal(1),
  command: Type.Tuple([Type.String()]),
}, { additionalProperties: false });

function policyAt(path: string) {
  const bytes = readWorkerFile(path);
  if (bytes === undefined) return;
  const stored: unknown = JSON.parse(bytes.toString("utf8"));
  if (!Value.Check(policySchema, stored) || stored.stateDir !== dirname(path) ||
      basename(stored.stateDir) !== stored.fingerprint.slice(0, 16) ||
      controls.test(stored.stateDir) || controls.test(stored.workerId) ||
      !isAbsolute(stored.command[0]) || controls.test(stored.command[0]) ||
      stored.repos.some(repo => !isAbsolute(repo.cwd) || controls.test(repo.cwd) || controls.test(repo.id)) ||
      new Set(stored.repos.map(repo => repo.id)).size !== stored.repos.length)
    throw new WorkerRegistrationError("Invalid target worker policy");
  return stored;
}

function enrollmentAuthorization(path: string, key: string, repos: WorkerPolicy["repos"]): string {
  trustedWorkerPath(workerInstallRoot, repos, "directory");
  const cli = trustedWorkerPath(fileURLToPath(new URL("./cli.ts", import.meta.url)), repos, "file");
  const bun = trustedWorkerPath(realpathSync(process.execPath), repos, "file");
  const argv = [bun, "--no-env-file", cli, "worker", "serve", "--policy", path].map(shellWord);
  const command = `exec ${argv.join(" ")}`.replaceAll('"', '\\"');
  return `restrict,command="${command}" ${key} omp-sa-worker`;
}

function authorizationSnapshot(path: string, key: string, expected: string, hasPolicy: boolean) {
  const baseline = readWorkerFile(path, 0o644);
  const text = baseline ? new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(baseline) : "";
  if (text.includes("\0")) throw new WorkerRegistrationError("Invalid target authorized_keys");
  // OpenSSH permits whitespace between the key fields, comments, and options.
  // Conservatively refuse any noncomment occurrence except our exact sole entry.
  const blob = key.slice("ssh-ed25519 ".length).replaceAll("+", "\\+");
  const keyFields = new RegExp(`(?:^|\\s)ssh-ed25519\\s+${blob}(?=\\s|$)`);
  const sameKey = text.split(/\r?\n/).filter(line => !line.trimStart().startsWith("#") && keyFields.test(line));
  if (sameKey.length) {
    if (hasPolicy && sameKey.length === 1 && sameKey[0] === expected) return null;
    throw new WorkerRegistrationError("The supplied key already exists with a different or duplicate authorization; no authorization was overwritten");
  }
  return { baseline };
}

/** Never replace or rewrite an existing authorization file, including its permissions. */
function appendAuthorization(path: string, expected: string, baseline: Buffer | undefined): void {
  const flags = constants.O_APPEND | constants.O_NONBLOCK | constants.O_NOFOLLOW;
  const fd = baseline ? openSync(path, flags | constants.O_RDWR)
    : openSync(path, flags | constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    if (baseline) {
      const original = fstatSync(fd);
      checkWorkerFile(original, 0o644);
      const named = lstatSync(path);
      if (original.dev !== named.dev || original.ino !== named.ino || !readFileSync(fd).equals(baseline))
        throw new WorkerRegistrationError("authorized_keys changed during enrollment; no authorization was overwritten");
    }
    writeFileSync(fd, `${baseline?.length && baseline.at(-1) !== 10 ? "\n" : ""}${expected}\n`);
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

async function targetRepositories(paths: readonly string[], directory: string): Promise<WorkerRepo[]> {
  const repos: WorkerRepo[] = [];
  const inside = (root: string, path: string) => root === path || path.startsWith(root === "/" ? "/" : `${root}/`);
  for (const path of paths) {
    const cwd = realpathSync(path);
    if (controls.test(cwd) || !lstatSync(cwd).isDirectory() ||
        await gitWorkerRepository(cwd, ["rev-parse", "--show-toplevel"]) !== `${cwd}\n`)
      throw new WorkerRegistrationError("Each --repo must be the root of an existing non-bare Git checkout");
    if (inside(cwd, directory) || inside(directory, cwd))
      throw new WorkerRegistrationError("Worker state and enrolled Git checkouts must not overlap");
    const id = await workerRepositoryIdentity(cwd);
    if (!id || repos.some(repo => repo.id === id))
      throw new WorkerRegistrationError("Each enrolled Git checkout needs a distinct verifiable network origin");
    repos.push({ id, cwd });
  }
  return repos.sort((left, right) => left.id.localeCompare(right.id));
}

/** Explicit target-side authorization; the CLI separately checks native prerequisites. */
export async function enrollWorker(options: {
  readonly home: string; readonly headKey: string; readonly repositories: readonly string[]; readonly executable: string;
}): Promise<WorkerPolicy> {
  const key = workerPublicKey(options.headKey);
  const fingerprint = workerHash(key);
  workerDirectory(options.home, 0o755);
  const home = realpathSync(options.home);
  const root = join(home, policyRoot);
  const stateDir = join(root, fingerprint.slice(0, 16));
  const path = join(stateDir, policyFile);
  const ssh = join(home, ".ssh");
  if (controls.test(stateDir) || Buffer.byteLength(join(stateDir, "run", `lane-${"0".repeat(24)}.sock`)) > 100)
    throw new WorkerRegistrationError("Target account home cannot be used for worker Unix sockets");
  if (!options.repositories.length || options.repositories.length > maxRepositories)
    throw new WorkerRegistrationError(`Target enrollment requires 1–${maxRepositories} Git checkouts`);
  const repos = await targetRepositories(options.repositories, stateDir);
  const executable = trustedWorkerPath(realpathSync(options.executable), repos, "file");
  const command = [executable];
  const line = enrollmentAuthorization(path, key, repos);
  // Run every trust check before making policy, lock, or SSH directories.
  trustedWorkerPath(stateDir, repos, "profile");
  trustedWorkerPath(ssh, repos, "profile");
  workerDirectory(root, 0o700, true);
  return await withWorkerWriteLock(join(root, "init.lock"), () => {
    workerDirectory(stateDir, 0o700, true);
    workerDirectory(ssh, 0o755, true);
    const previous = policyAt(path);
    if (previous && (previous.fingerprint !== fingerprint ||
        !Bun.deepEquals(previous.repos, repos) || !Bun.deepEquals(previous.command, command)))
      throw new WorkerRegistrationError("Enrollment already has a different policy; no policy or authorization was overwritten");
    const auth = join(ssh, "authorized_keys");
    const snapshot = authorizationSnapshot(auth, key, line, previous !== undefined);
    const policy: WorkerPolicy = { workerId: previous?.workerId ?? `worker-${randomUUID()}`, stateDir, repos, capacity: 1, command };
    if (!previous) {
      const temporary = stagePrivateFile(path, `${JSON.stringify({ fingerprint, ...policy }, null, 2)}\n`);
      try { linkSync(temporary, path); }
      finally { unlinkSync(temporary); }
    }
    if (snapshot) appendAuthorization(auth, line, snapshot.baseline);
    return policy;
  });
}

/** This path comes from authorized_keys, never from SSH_ORIGINAL_COMMAND. */
export function readWorkerPolicy(home: string, path: string): WorkerPolicy {
  workerDirectory(home, 0o755);
  const root = join(realpathSync(home), policyRoot);
  if (!/^[0-9a-f]{16}$/.test(basename(dirname(path))) || path !== join(root, basename(dirname(path)), policyFile))
    throw new WorkerRegistrationError("Worker serve requires its exact enrolled policy path");
  workerDirectory(root, 0o700);
  workerDirectory(dirname(path), 0o700);
  const stored = policyAt(path);
  if (!stored) throw new WorkerRegistrationError("The enrolled worker policy is missing");
  const { fingerprint: _fingerprint, ...policy } = stored;
  return policy;
}
