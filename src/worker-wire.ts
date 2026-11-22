import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Lane } from "./contracts";
import type { HostOptions } from "./host";

/** Only the enrollment CLI chooses destinations/keys. Lane prompts never supply SSH argv. */
export interface WorkerRepo { readonly id: string; readonly cwd: string }
export interface WorkerDescription {
  readonly workerId: string; readonly platform: "linux" | "darwin"; readonly stateDir: string;
  readonly repos: readonly WorkerRepo[]; readonly capacity: number; readonly active: number;
}
export interface WorkerRegistration {
  readonly destination: string; readonly identityFile: string; readonly description: WorkerDescription;
  readonly default?: boolean;
  readonly defaultRepository?: { readonly root: string; readonly repoId: string };
}
export interface WorkerPolicy {
  readonly workerId: string; readonly stateDir: string; readonly repos: readonly WorkerRepo[];
  readonly capacity: number; readonly command: string[];
}
export interface RemotePlacement {
  readonly workerId: string; readonly repoId: string; readonly revision: string;
  readonly subdir: string; readonly stateDir: string;
}
export interface WorkerSelector {
  readonly target?: "local" | "remote"; readonly platform?: "linux" | "darwin"; readonly worker?: string;
}
export interface WorkerLaneRef {
  readonly laneId: string; readonly generation: number; readonly repoId: string;
  readonly revision: string; readonly subdir: string;
}
export interface WorkerProbe {
  readonly socket: boolean; readonly sessionFile: boolean; readonly pidAlive: boolean; readonly ownerAlive: boolean;
  readonly uncertain: boolean; readonly pid: number | null; readonly sessionId: string | null;
  /** Exact generation whose persisted native exit the worker verified. */
  readonly exitGeneration?: number;
}
export type WorkerLaunch = Pick<HostOptions, "model" | "modelPreset" | "subagentConcurrency">;
export const WORKER_HEADER_BYTES = 64 * 1024;
type Endpoint = Pick<WorkerRegistration, "destination" | "identityFile">;

const natural = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const positive = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const text = Type.String({ minLength: 1 });
const absolute = Type.String({ pattern: "^/[^\\u0000]*$" });
export const WorkerDescriptionSchema = Type.Object({
  workerId: text, platform: Type.Union([Type.Literal("linux"), Type.Literal("darwin")]),
  stateDir: absolute, repos: Type.Array(Type.Object({ id: text, cwd: absolute }), { minItems: 1 }),
  capacity: positive, active: natural,
});
const probe = Type.Object({
  socket: Type.Boolean(), sessionFile: Type.Boolean(), pidAlive: Type.Boolean(), ownerAlive: Type.Boolean(),
  uncertain: Type.Boolean(), pid: Type.Union([positive, Type.Null()]), sessionId: Type.Union([text, Type.Null()]),
  exitGeneration: Type.Optional(positive),
});
const opened = Type.Object({ pid: positive });
const attached = Type.Object({ pid: positive, sessionId: text, sessionFile: absolute });
const reply = Type.Union([
  Type.Object({ ok: Type.Literal(true), value: Type.Unknown() }),
  Type.Object({ ok: Type.Literal(false), error: Type.String() }),
]);

function decode<S extends TSchema>(line: Buffer, schema: S): Static<S> {
  const result: unknown = JSON.parse(line.toString("utf8"));
  if (!Value.Check(reply, result)) throw new Error("Invalid worker response envelope");
  if (!result.ok) throw new Error(`Worker refused operation: ${result.error}`);
  if (!Value.Check(schema, result.value)) throw new Error("Invalid worker response");
  return result.value;
}

function startSSH(endpoint: Endpoint) {
  if (!/^(?:[A-Za-z0-9_][\w.-]*@)?[A-Za-z0-9][\w.-]*$/.test(endpoint.destination) || !isAbsolute(endpoint.identityFile)) {
    throw new Error("Invalid registered SSH endpoint");
  }
  // Never borrow a multiplexed connection authenticated with another key, or
  // forward the operator's agent, ports or terminal into the worker account.
  const child = spawn("ssh", ["-F", "/dev/null", "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
    "-o", "ClearAllForwardings=yes", "-o", "ForwardAgent=no", "-o", "ForwardX11=no",
    "-o", "ControlPath=none", "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none",
    "-o", "PreferredAuthentications=publickey", "-o", "ConnectTimeout=8",
    "-i", endpoint.identityFile, "--", endpoint.destination, "omp-sa-worker-v1"], { stdio: "pipe" });
  // Drain diagnostics without collecting or relaying possibly sensitive peer output.
  child.stderr.resume();
  return child;
}

/** Stop exactly at the newline; an attach response and the native ready frame
 * can share one SSH packet. Leave remaining bytes in the paused stdout stream. */
function readHeader(child: ChildProcessWithoutNullStreams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    const cleanup = () => {
      child.stdout.off("readable", receive);
      child.stdout.off("end", ended);
      child.stdout.off("error", fail);
      child.stdin.off("error", fail);
      child.off("error", fail);
    };
    const fail = (error: Error) => { cleanup(); reject(error); };
    const ended = () => fail(new Error("SSH disconnected before a worker receipt; do not redispatch an uncertain operation"));
    const receive = () => {
      let chunk: Buffer | null;
      while ((chunk = child.stdout.read()) !== null) {
        const end = chunk.indexOf(10);
        length += end < 0 ? chunk.length : end;
        if (length > WORKER_HEADER_BYTES) { fail(new Error("Worker response exceeds header limit")); return; }
        chunks.push(end < 0 ? chunk : chunk.subarray(0, end));
        if (end < 0) continue;
        cleanup();
        if (end + 1 < chunk.length) child.stdout.unshift(chunk.subarray(end + 1));
        resolve(Buffer.concat(chunks, length));
        return;
      }
    };
    child.once("error", fail);
    child.stdout.once("end", ended);
    child.stdout.once("error", fail);
    child.stdin.once("error", fail);
    child.stdout.on("readable", receive);
  });
}

async function exchange<S extends TSchema>(endpoint: Endpoint, request: object, schema: S, attach: boolean) {
  const payload = Buffer.from(`${JSON.stringify({ version: 1, ...request })}\n`);
  if (payload.length > WORKER_HEADER_BYTES) throw new Error("Worker request exceeds header limit");
  const { checkWorkerIdentity } = await import("./worker-registration");
  checkWorkerIdentity(endpoint.identityFile);
  const child = startSSH(endpoint);
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  // On attach, the child can exit after this call returns. Its stdout closure
  // then signals detach to the stock RPC client, never native Host death.
  void exited.catch(() => {});
  const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
  try {
    const response = readHeader(child);
    if (attach) child.stdin.write(payload);
    else child.stdin.end(payload);
    const value = decode(await response, schema);
    if (!attach) {
      child.stdout.resume();
      if (await exited !== 0) throw new Error("SSH exited unsuccessfully; worker operation outcome may be unknown");
    }
    return { value, child };
  } catch (error) {
    child.kill();
    throw error;
  } finally { clearTimeout(timer); }
}

export async function workerDescribe(endpoint: Endpoint, workspace?: Pick<WorkerLaneRef, "repoId" | "revision" | "subdir">): Promise<WorkerDescription> {
  return (await exchange(endpoint, { op: "describe", workspace }, WorkerDescriptionSchema, false)).value;
}

export async function lookupWorker(stateDir: string, remote: RemotePlacement): Promise<WorkerRegistration> {
  const { listWorkers } = await import("./worker-registration");
  const matches = (await listWorkers(stateDir)).filter(reg => reg.description.workerId === remote.workerId);
  const [reg] = matches;
  if (matches.length !== 1 || !reg || reg.description.stateDir !== remote.stateDir
    || !reg.description.repos.some(repo => repo.id === remote.repoId)) {
    throw new Error("Remote lane has no matching verified worker registration");
  }
  return reg;
}

export function remoteLanePaths(remote: Pick<RemotePlacement, "stateDir">, laneId: string) {
  if (!/^lane-[A-Za-z0-9_-]+$/.test(laneId) || !isAbsolute(remote.stateDir)) throw new Error("Invalid remote lane path");
  return { sessionFile: join(remote.stateDir, "sessions", laneId, "session.jsonl"), socketPath: join(remote.stateDir, "run", `${laneId}.sock`) };
}

export function workerRef(lane: Pick<Lane, "id" | "remote" | "generation">): WorkerLaneRef {
  if (!lane.remote) throw new Error("Lane is not assigned to a worker");
  const { repoId, revision, subdir } = lane.remote;
  return { laneId: lane.id, generation: lane.generation, repoId, revision, subdir };
}

export async function workerProbe(reg: WorkerRegistration, ref: WorkerLaneRef): Promise<WorkerProbe> {
  return (await exchange(reg, { op: "probe", workerId: reg.description.workerId, ref }, probe, false)).value;
}

export async function workerOpen(reg: WorkerRegistration, ref: WorkerLaneRef, launch: WorkerLaunch) {
  return (await exchange(reg, { op: "open", workerId: reg.description.workerId, ref, launch }, opened, false)).value;
}

export async function workerConnect(reg: WorkerRegistration, ref: WorkerLaneRef) {
  const { HostConnection } = await import("./host");
  const { value, child } = await exchange(reg, { op: "attach", workerId: reg.description.workerId, ref }, attached, true);
  if (value.sessionFile !== remoteLanePaths(reg.description, ref.laneId).sessionFile) {
    child.kill();
    throw new Error("Worker attached to an unexpected session file");
  }
  return HostConnection.fromWorker(child.stdout, child.stdin, () => child.kill(), value);
}
