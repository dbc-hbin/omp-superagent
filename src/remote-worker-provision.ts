import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { Type, type Static } from "@sinclair/typebox/type";
import { absolutePath, parse, RemoteWorkerError, text, uuid, type WorkerScope } from "./remote-worker-wire";

const provisionSchema = Type.Object({
  workerId: uuid, instance: uuid, stateDir: absolutePath,
  workspaceRoots: Type.Array(absolutePath, { minItems: 1, maxItems: 64, uniqueItems: true }),
  // Worker-local installed executable only. No argv overrides to --session, --cwd, etc.
  command: Type.Tuple([text(4096)]),
}, { additionalProperties: false });
export type WorkerProvision = Static<typeof provisionSchema>;

export const errorCode = (error: unknown) => error instanceof Error && "code" in error ? error.code : undefined;

export function optionalStat(path: string) {
  try { return lstatSync(path, { bigint: true }); }
  catch (error) { if (errorCode(error) === "ENOENT") return null; throw error; }
}

export function privateWorkerDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) {
    throw new RemoteWorkerError("Worker runtime directory must be owned with mode 0700");
  }
}

function trustedAncestors(path: string): void {
  let current = path;
  for (; ;) {
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.uid !== 0 && stat.uid !== process.getuid?.()
      || (stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0) {
      throw new RemoteWorkerError("Worker provisioning has unsafe directory ancestry");
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

export function openPrivateFile(path: string, flags: number): number {
  const fd = openSync(path, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  const stat = fstatSync(fd);
  if (stat.isFile() && stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o600 && stat.nlink === 1) return fd;
  closeSync(fd);
  throw new RemoteWorkerError("Worker provisioning or state file must be an owned mode 0600 regular file");
}

export function loadWorkerProvision(): WorkerProvision {
  const home = realpathSync(homedir());
  const path = join(home, ".config", "omp-superagent", "worker.json");
  trustedAncestors(dirname(path));
  const fd = openPrivateFile(path, constants.O_RDONLY);
  try {
    const buffer = Buffer.alloc(32 * 1024);
    const length = readSync(fd, buffer);
    if (length === buffer.length) throw new RemoteWorkerError("Worker provisioning exceeds its size limit");
    const value: unknown = JSON.parse(buffer.subarray(0, length).toString("utf8"));
    const config = parse(provisionSchema, value, "provisioning");
    if (config.command[0] !== "omp" && !isAbsolute(config.command[0])) {
      throw new RemoteWorkerError("Worker command must be omp or an absolute installed executable");
    }
    const stateDir = realpathSync(config.stateDir);
    trustedAncestors(stateDir);
    privateWorkerDirectory(stateDir);
    for (const root of config.workspaceRoots) {
      if (realpathSync(root) !== root || !lstatSync(root).isDirectory()) {
        throw new RemoteWorkerError("Worker workspace roots must be existing canonical directories");
      }
    }
    return { ...config, stateDir };
  } finally { closeSync(fd); }
}

export function approvedWorkspace(config: WorkerProvision, cwd: string): string {
  const canonical = realpathSync(cwd);
  if (!lstatSync(canonical).isDirectory() || !config.workspaceRoots.some(root => {
    const suffix = relative(root, canonical);
    return suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
  })) throw new RemoteWorkerError("Workspace is outside worker-approved roots");
  return canonical;
}

export function workspacePaths(config: WorkerProvision, scope: WorkerScope, id: string) {
  const key = createHash("sha256").update(JSON.stringify([scope.placement.workerId, scope.instance, id])).digest("hex").slice(0, 24);
  const directory = join(config.stateDir, key);
  // Every per-generation public and native socket shares this portable limit.
  if (Buffer.byteLength(join(directory, "r12345678901.sock")) > 100) {
    throw new RemoteWorkerError("Worker stateDir is too long for private Unix sockets");
  }
  return { directory, socketPath: join(directory, "host.sock"), sessionFile: join(directory, "session.jsonl") };
}

/** Test-only: loopback fixtures launch directly from the endpoint on non-Linux CI. */
export const TEST_WORKER_CONTEXT_ENV = "OMP_SUPERAGENT_TEST_WORKER_CONTEXT";
export const directWorkerContext = () => process.env[TEST_WORKER_CONTEXT_ENV] === "direct";

function exactlyOne(argv: string[], timeout: number): { code: number | null; stdout: Buffer } {
  const child = Bun.spawnSync(argv, { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout, killSignal: "SIGKILL" });
  return { code: child.exitCode, stdout: child.stdout };
}

/**
 * Worker Hosts run like stock OMP started by this account on this machine: in
 * its systemd user manager (not the SSH session, so logout does not end them)
 * with its login-shell environment. Refuse rather than fall back.
 */
export function requireUserManager(): void {
  if (directWorkerContext()) return;
  if (process.platform !== "linux") {
    throw new RemoteWorkerError(`Remote workers currently require Linux with a systemd user manager; ${process.platform} workers are not supported`);
  }
  const uid = process.getuid?.();
  const linger = exactlyOne(["loginctl", "show-user", String(uid), "--property=Linger", "--value"], 5_000);
  if (linger.code !== 0 || linger.stdout.toString("utf8").trim() !== "yes") {
    throw new RemoteWorkerError("Worker account needs lingering (loginctl enable-linger) so its Hosts survive SSH logout");
  }
}

export function bootId(): string {
  if (directWorkerContext()) return `direct:${hostname()}`;
  return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
}

/** Variables that describe the transport or service manager, not the account's login environment. */
const transportOnly = new Set(["OMP_RPC_SOCKET", "SSH_CLIENT", "SSH_CONNECTION", "SSH_TTY", "SSH_ORIGINAL_COMMAND",
  "INVOCATION_ID", "JOURNAL_STREAM", "SYSTEMD_EXEC_PID", "MANAGERPID", "MAINPID", "NOTIFY_SOCKET", "_", "SHLVL", "PWD", "OLDPWD"]);

/**
 * The account's login-shell environment (`$SHELL -l -i -c`, NUL-framed after a
 * nonce, stdin /dev/null, bounded). From the SSH endpoint it is measured inside
 * a transient user-manager unit; the launcher already runs in one.
 */
export function loginEnvironment(viaUserManager: boolean): Record<string, string> {
  if (directWorkerContext()) {
    return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  }
  const shell = userInfo().shell;
  if (!shell || !isAbsolute(shell)) throw new RemoteWorkerError("Worker account has no absolute login shell");
  const marker = `omp-sa-login-${randomUUID()}`;
  const argv = [...(viaUserManager ? ["systemd-run", "--user", "--quiet", "--wait", "--pipe", "--collect", "--"] : []),
    shell, "-l", "-i", "-c", `printf '%s\\0' ${marker}; exec env -0`];
  const { code, stdout } = exactlyOne(argv, 20_000);
  const start = stdout.indexOf(Buffer.from(`${marker}\0`));
  if (code !== 0 || start === -1) throw new RemoteWorkerError("Worker login-shell environment could not be read");
  const env: Record<string, string> = {};
  for (const entry of stdout.subarray(start + marker.length + 1).toString("utf8").split("\0")) {
    const equals = entry.indexOf("=");
    if (equals > 0) env[entry.slice(0, equals)] = entry.slice(equals + 1);
  }
  if (!env.PATH || !env.HOME) throw new RemoteWorkerError("Worker login-shell environment has no PATH or HOME");
  return env;
}

export function laneEnvironment(login: Record<string, string>, lane: string): Record<string, string> {
  return Object.fromEntries([
    ...Object.entries(login).filter(([name]) => !name.startsWith("OMP_SUPERAGENT_") && !transportOnly.has(name)),
    ["OMP_SUPERAGENT_ROLE", "lane"], ["OMP_SUPERAGENT_LANE", lane],
    // The lane's shared board is HEAD's, reached over the lane's own stream.
    ["OMP_SUPERAGENT_BOARD", "worker"],
  ]);
}
