import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, unlinkSync, type Stats } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { HostConnection } from "./host";
import { ownsCheckout, privateWorkerDirectory } from "./worker-checkout";
import { workerExit, type WorkerIdentity, type WorkerLedger, type WorkerReceipt } from "./worker-ledger";
import { WorkerRefusal } from "./worker-request";
import { remoteLanePaths, type WorkerPolicy, type WorkerProbe } from "./worker-wire";

export const WORKER_ATTEMPT_ENV = "OMP_SUPERAGENT_WORKER_ATTEMPT";
export const WORKER_SESSION_ENV = "OMP_SUPERAGENT_WORKER_EXPECTED_SESSION";
const SOCKET_TIMEOUT_MS = 5_000;

export function workerPaths(policy: WorkerPolicy, laneId: string) {
  const { socketPath, sessionFile } = remoteLanePaths(policy, laneId);
  if (Buffer.byteLength(socketPath) > 100) throw new WorkerRefusal("Worker socket path exceeds 100 bytes");
  return { socketPath, sessionFile, exitPath: `${socketPath}.exit.json`, logPath: join(dirname(socketPath), `${laneId}.log`) };
}
type WorkerPaths = ReturnType<typeof workerPaths>;
type WorkerFiles = Awaited<ReturnType<typeof readWorkerFiles>>;

function checkedFile(path: string): Stats | undefined {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat && (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0))
    throw new WorkerRefusal("Worker session or exit record is not an owned regular file");
  return stat;
}

function checkedSocket(path: string): Stats | undefined {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat && (!stat.isSocket() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600))
    throw new WorkerRefusal("Worker endpoint is not an owned private socket");
  return stat;
}

function sameFile(expected: Pick<Stats, "dev" | "ino">, observed: Stats | undefined): boolean {
  return observed !== undefined && expected.dev === observed.dev && expected.ino === observed.ino;
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    // Other errors do not prove absence.
    return true;
  }
}

export async function readWorkerFiles(paths: WorkerPaths) {
  privateWorkerDirectory(dirname(paths.socketPath));
  privateWorkerDirectory(dirname(dirname(paths.sessionFile)));
  privateWorkerDirectory(dirname(paths.sessionFile));
  const socket = checkedSocket(paths.socketPath);
  const exit = checkedFile(paths.exitPath);
  const session = checkedFile(paths.sessionFile);
  let sessionId: string | null = null;
  if (session) {
    const { readSessionHeaderId } = await import("@oh-my-pi/pi-coding-agent/session/session-loader");
    sessionId = await readSessionHeaderId(paths.sessionFile) ?? null;
    if (!sameFile(session, checkedFile(paths.sessionFile))) throw new WorkerRefusal("Worker journal changed while reading its identity");
  }
  return { socket, exit, session, sessionId };
}

function provenExit(paths: WorkerPaths, files: WorkerFiles, receipt: WorkerReceipt) {
  if (!files.exit || !files.sessionId || files.exit.size > 4096 || (files.exit.mode & 0o077) !== 0) return null;
  const fd = openSync(paths.exitPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!sameFile(files.exit, stat) || stat.size !== files.exit.size) return null;
    let exit: unknown;
    try { exit = JSON.parse(readFileSync(fd, "utf8")); }
    catch (error) {
      if (error instanceof SyntaxError) return null;
      throw error;
    }
    if (!Value.Check(workerExit, exit) || exit.workerAttempt !== receipt.attempt || exit.sessionFile !== paths.sessionFile
      || exit.sessionId !== files.sessionId || receipt.sessionId !== null && exit.sessionId !== receipt.sessionId
      || receipt.phase === "live" && (exit.pid !== receipt.identity.pid || exit.ownerPid !== receipt.identity.ownerPid)
      || exit.pid === exit.ownerPid) return null;
    return exit;
  } finally { closeSync(fd); }
}

export function absentWorkerHost(files: WorkerFiles, receipt: WorkerReceipt | null): WorkerProbe {
  const expected = receipt?.sessionId ?? null;
  const uncertain = !!files.socket || files.sessionId !== expected || !!files.session !== (expected !== null)
    || (!!files.exit && expected === null);
  return { socket: !!files.socket, sessionFile: !!files.session, sessionId: uncertain ? null : files.sessionId,
    pid: null, pidAlive: false, ownerAlive: false, uncertain,
    ...(!uncertain && receipt?.phase === "released" && receipt.exitVerified && { exitGeneration: receipt.generation }) };
}

export async function attestWorkerHost(paths: WorkerPaths, files: WorkerFiles, receipt: WorkerReceipt): Promise<WorkerIdentity> {
  if (!files.socket || !files.sessionId || !ownsCheckout(receipt)) throw new WorkerRefusal("No owned worker socket/journal/checkout");
  const { connection, identity, state } = await HostConnection.open(paths.socketPath);
  try {
    if (!("workerAttempt" in state) || state.workerAttempt !== receipt.attempt ||
      typeof state.loadedSuperkitPath !== "string" || !state.loadedSuperkitPath.startsWith("/") || identity.pid === identity.ownerPid ||
      identity.sessionFile !== paths.sessionFile || identity.sessionId !== files.sessionId ||
      receipt.sessionId !== null && identity.sessionId !== receipt.sessionId || !sameFile(identity, files.socket) ||
      !sameFile(identity, checkedSocket(paths.socketPath)) || !pidAlive(identity.pid) || !pidAlive(identity.ownerPid) ||
      receipt.phase === "live" && (receipt.identity.pid !== identity.pid || receipt.identity.ownerPid !== identity.ownerPid
        || !sameFile(receipt.identity, files.socket)))
      throw new WorkerRefusal("Worker native Host identity or launch receipt does not match");
    return identity;
  } finally { await connection.close(); }
}

export async function inspectWorkerHost(ledger: WorkerLedger, paths: WorkerPaths, receipt: WorkerReceipt | null, attest = true): Promise<WorkerProbe> {
  const files = await readWorkerFiles(paths);
  if (!receipt || receipt.phase === "released") return absentWorkerHost(files, receipt);
  if (receipt.phase === "reserved") {
    const untouched = absentWorkerHost(files, receipt);
    if (!pidAlive(receipt.launcherPid) && !untouched.uncertain && ledger.retire(receipt))
      return untouched;
    return { ...untouched, uncertain: true };
  }
  const exit = provenExit(paths, files, receipt);
  const pid = receipt.phase === "live" ? receipt.identity.pid : exit?.pid ?? null;
  const owner = receipt.phase === "live" ? receipt.identity.ownerPid : exit?.ownerPid ?? null;
  const nativeAlive = pid !== null && pidAlive(pid);
  const ownerAlive = owner !== null && pidAlive(owner);
  if (exit && !nativeAlive && !ownerAlive && (!files.socket || receipt.phase === "live" && sameFile(receipt.identity, files.socket))) {
    const cleanup = () => {
      if (!files.session || !sameFile(files.session, checkedFile(paths.sessionFile))
        || !files.exit || !sameFile(files.exit, checkedFile(paths.exitPath))
        || pidAlive(exit.pid) || pidAlive(exit.ownerPid)) throw new WorkerRefusal("Worker native exit evidence changed");
      const socket = checkedSocket(paths.socketPath);
      if (!socket) return;
      if (!files.socket || !sameFile(files.socket, socket)) throw new WorkerRefusal("Worker socket changed before exit cleanup");
      unlinkSync(paths.socketPath);
    };
    const clean = exit.code === 0 && exit.signal === null;
    if (ledger.retire(receipt, { sessionId: exit.sessionId, clean, cleanup }))
      return { socket: false, sessionFile: true, sessionId: exit.sessionId, pid: null, pidAlive: false, ownerAlive: false,
        uncertain: false, ...(clean ? { exitGeneration: receipt.generation } : {}) };
  }
  if (attest && files.socket && !exit) {
    try {
      const identity = await attestWorkerHost(paths, files, receipt);
      const live = { ...receipt, phase: "live", sessionId: identity.sessionId, identity } as const;
      const saved = receipt.phase === "live" || ledger.transition(receipt, live) ? live : ledger.get(receipt.laneId);
      if (saved?.phase === "live" && saved.attempt === receipt.attempt &&
        saved.identity.pid === identity.pid && saved.identity.ownerPid === identity.ownerPid &&
        saved.identity.sessionId === identity.sessionId && sameFile(saved.identity, files.socket)) {
        return { socket: true, sessionFile: true, sessionId: identity.sessionId, pid: identity.pid,
          pidAlive: true, ownerAlive: true, uncertain: false };
      }
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      // Neither a refused identity nor a dead socket establishes native exit.
    }
  }
  return { socket: !!files.socket, sessionFile: !!files.session, sessionId: null,
    pid, pidAlive: nativeAlive, ownerAlive, uncertain: true };
}

export async function rawWorkerSocket(path: string, identity: WorkerIdentity): Promise<Socket> {
  if (!sameFile(identity, checkedSocket(path))) throw new WorkerRefusal("Worker socket changed before attach");
  const socket = createConnection(path);
  socket.pause();
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => socket.destroy(new WorkerRefusal("Worker socket attach timed out")), SOCKET_TIMEOUT_MS);
      socket.once("error", reject);
      socket.once("connect", () => { clearTimeout(timer); resolve(); });
      socket.once("close", () => {
        clearTimeout(timer);
        reject(new WorkerRefusal("Worker socket closed during attach"));
      });
    });
    if (!sameFile(identity, checkedSocket(path))) throw new WorkerRefusal("Worker socket changed during attach");
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}
