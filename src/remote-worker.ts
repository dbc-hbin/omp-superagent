import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Static, TSchema } from "@sinclair/typebox/type";
import type { Lane, WorkerPlacement } from "./contracts";
import { HostConnection, type HostOptions } from "./host";
import type { RuntimeHost } from "./runtime";
import {
  absolutePath, attachIdentitySchema, CAPABILITY_TIMEOUT, capabilitySchema, decodeHeader, encodeHeader, INPUT_TIMEOUT, inputStoredSchema,
  inspectionSchema, laneId, laneSchema, optionsSchema, parse, placementSchema, PROVISION_TIMEOUT, RemoteWorkerError, replySchema,
  REQUEST_TIMEOUT, resultFileSchema, revisionHash, START_TIMEOUT, startedSchema, uuid, workspaceSchema, writeHeader,
  type WorkerAttachIdentity, type WorkerScope
} from "./remote-worker-wire";
import { Type } from "@sinclair/typebox/type";
import { evidenceRequestSchema, evidenceResultSchema, type EvidenceRequest } from "./lane-evidence";
import { createHash } from "node:crypto";

function ssh(destination: string) {
  // Keep SSH identity selection and host keys in the operator's normal OpenSSH config.
  // Do not send HEAD's application/provider environment, use an agent forward, or
  // reuse a master process which might have been started with different trust options.
  const env = Object.fromEntries(["HOME", "USER", "LOGNAME", "PATH", "SSH_AUTH_SOCK"].flatMap(key => {
    const value = process.env[key];
    return value === undefined ? [] : [[key, value]];
  }));
  const child = spawn("ssh", [
    "-T", "-a", "-x", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
    "-o", "ClearAllForwardings=yes", "-o", "PermitLocalCommand=no", "-o", "ControlPath=none",
    "-o", "SendEnv=-*", "-o", "ConnectTimeout=8", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2",
    "--", destination, "omp-sa-worker",
  ], { env, stdio: ["pipe", "pipe", "ignore"] });
  // Stream consumers separately observe EOF/failure; avoid unhandled EPIPE while
  // changing from a control frame to byte forwarding or closing the connection.
  child.on("error", () => child.stdout.destroy());
  child.stdin.on("error", () => child.stdout.destroy());
  return {
    input: child.stdout, output: child.stdin,
    close: () => {
      child.stdin.destroy();
      child.stdout.destroy();
      child.kill("SIGTERM");
    },
  };
}
type Transport = ReturnType<typeof ssh>;

function scope(placement: WorkerPlacement, instance: string): WorkerScope {
  return { placement: parse(placementSchema, placement, "SSH placement"), instance: parse(uuid, instance, "HEAD instance") };
}

function laneReference(placement: WorkerPlacement, lane: Lane) {
  if (!isDeepStrictEqual(placement, lane.placement)) {
    throw new RemoteWorkerError("Requested SSH placement does not match the lane binding");
  }
  const { id, cwd, socketPath, sessionFile, generation, pid, sessionId } = lane;
  return parse(laneSchema, { id, cwd, socketPath, sessionFile, generation, pid, sessionId }, "lane binding");
}

const timeouts: Record<string, number> = {
  start: START_TIMEOUT, capability: CAPABILITY_TIMEOUT, provision: PROVISION_TIMEOUT, input: INPUT_TIMEOUT,
};

async function exchange<T extends TSchema>(transport: Transport, request: WorkerScope & { readonly op: string }, schema: T,
  body?: Uint8Array): Promise<Static<T>> {
  const header = encodeHeader(request);
  const [raw] = await Promise.all([
    decodeHeader(transport.input, timeouts[request.op] ?? REQUEST_TIMEOUT),
    (async () => {
      await writeHeader(transport.output, header);
      if (body?.length) await new Promise<void>((resolve, reject) => transport.output.write(body, error => error ? reject(error) : resolve()));
    })(),
  ]);
  const reply = parse(replySchema, raw, "reply");
  if (reply.workerId !== request.placement.workerId || reply.instance !== request.instance) {
    throw new RemoteWorkerError("SSH worker identity or HEAD instance did not match the pinned placement");
  }
  if ("error" in reply) throw new RemoteWorkerError(reply.error);
  return parse(schema, reply.value, "reply payload");
}

async function control<T extends TSchema>(request: WorkerScope & { readonly op: string }, schema: T, body?: Uint8Array): Promise<Static<T>> {
  const transport = ssh(request.placement.destination);
  try { return await exchange(transport, request, schema, body); }
  finally { transport.close(); }
}

export async function remoteCapability(placement: WorkerPlacement, instance: string) {
  return control({ ...scope(placement, instance), op: "capability" }, capabilitySchema);
}

/** Ship HEAD's validated immutable superkit package; the worker verifies, probes and activates it. */
export async function remoteProvision(placement: WorkerPlacement, instance: string,
  pack: { provenance: { revision: string; repository: string; branch: string; preparedAt: string }; digest: string; bytes: Uint8Array }) {
  const request = { ...scope(placement, instance), op: "provision", provenance: pack.provenance, digest: pack.digest, size: pack.bytes.length };
  return control(request, Type.Object({ revision: revisionHash, changed: Type.Boolean() }, { additionalProperties: false }), pack.bytes);
}

async function readExact(input: Transport["input"], size: number, timeout: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  const timer = setTimeout(() => input.destroy(new RemoteWorkerError("Worker result transfer timed out")), timeout);
  try {
    for await (const chunk of input as AsyncIterable<Buffer>) {
      chunks.push(chunk);
      length += chunk.length;
      if (length > size) throw new RemoteWorkerError("Worker result exceeds its declared size");
      if (length === size) break;
    }
  } finally { clearTimeout(timer); }
  if (length !== size) throw new RemoteWorkerError("Worker result ended before its declared size");
  return Buffer.concat(chunks, length);
}

/** A lane's requested result file, staged on its worker with the local staging rules. */
export async function remoteResult(placement: WorkerPlacement, instance: string, lane: Lane, path: string) {
  const request = { ...scope(placement, instance), op: "result", lane: laneReference(placement, lane), path };
  const transport = ssh(request.placement.destination);
  try {
    const file = await exchange(transport, request, resultFileSchema);
    const bytes = await readExact(transport.input, file.size, INPUT_TIMEOUT);
    if (createHash("sha256").update(bytes).digest("hex") !== file.digest) throw new RemoteWorkerError("Worker result digest does not match");
    return { name: file.name, data: bytes.toString("base64") };
  } finally { transport.close(); }
}

/** Bounded read-only evidence from the lane's worker workspace. */
export async function remoteEvidence(placement: WorkerPlacement, instance: string, lane: Lane, request: EvidenceRequest) {
  const payload = {
    ...scope(placement, instance), op: "evidence", lane: laneReference(placement, lane),
    request: parse(evidenceRequestSchema, request, "evidence request")
  };
  return control(payload, evidenceResultSchema);
}

/** Store one input file under the lane's private worker directory and return the worker path. */
export async function remoteInput(placement: WorkerPlacement, instance: string, lane: Lane, name: string, bytes: Uint8Array) {
  const request = {
    ...scope(placement, instance), op: "input", lane: laneReference(placement, lane), name,
    digest: createHash("sha256").update(bytes).digest("hex"), size: bytes.length
  };
  return (await control(request, inputStoredSchema, bytes)).path;
}

export async function remoteWorkspace(placement: WorkerPlacement, cwd: string, instance: string, laneIdValue: string) {
  const request = {
    ...scope(placement, instance), op: "resolve", cwd: parse(absolutePath, cwd, "workspace path"), id: parse(laneId, laneIdValue, "lane id"),
  };
  return control(request, workspaceSchema);
}

export async function remoteInspect(placement: WorkerPlacement, instance: string, lane: Lane) {
  const request = { ...scope(placement, instance), op: "inspect", lane: laneReference(placement, lane) };
  return control(request, inspectionSchema);
}

export async function remoteStart(placement: WorkerPlacement, instance: string, lane: Lane,
  options: Pick<HostOptions, "model" | "modelPreset" | "subagentConcurrency">, superkit: string | null) {
  const request = {
    ...scope(placement, instance), op: "start", lane: laneReference(placement, lane),
    options: parse(optionsSchema, options, "Host launch options"), superkit
  };
  return control(request, startedSchema);
}

async function bridge(transport: Transport, pin: WorkerAttachIdentity): Promise<RuntimeHost> {
  // A fresh listener is visible only under this user's mode-0700 directory.
  // The stock HostConnection owns native RPC framing, state, and events.
  const directory = await mkdtemp(join(await realpath("/tmp"), "osa-"));
  const path = join(directory, "host.sock");
  let peer: Socket | undefined;
  let cleaning: Promise<void> | undefined;
  const cleanup = () => cleaning ??= (async () => {
    transport.close();
    peer?.destroy();
    if (listener.listening) await new Promise<void>(resolve => listener.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  })();
  const stop = () => { void cleanup().catch(error => console.error("Worker transport cleanup failed:", error.message)); };
  const listener = createServer({ pauseOnConnect: true }, socket => {
    if (peer) { socket.destroy(); return; }
    peer = socket;
    socket.on("error", stop).once("close", stop);
    transport.input.once("close", () => { if (!transport.input.readableEnded) socket.destroy(); });
    transport.input.pipe(socket);
    socket.pipe(transport.output);
  });
  try {
    await chmod(directory, 0o700);
    listener.listen(path);
    await once(listener, "listening");
    listener.on("error", stop);
    await chmod(path, 0o600);
    const { connection, identity } = await HostConnection.open(path, REQUEST_TIMEOUT);
    if (identity.pid !== pin.pid || identity.ownerPid !== pin.ownerPid || identity.sessionFile !== pin.sessionFile
      || identity.sessionId !== pin.sessionId) {
      await connection.close();
      throw new RemoteWorkerError("SSH stream did not identify the original lane session and native owner");
    }
    return {
      client: connection.client,
      request: connection.request.bind(connection),
      uiResponse: connection.uiResponse.bind(connection),
      onFrame: connection.onFrame.bind(connection),
      exited: connection.exited,
      launched: pin.launched,
      close: async () => { try { await connection.close(); } finally { await cleanup(); } },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export async function remoteConnect(placement: WorkerPlacement, instance: string, lane: Lane): Promise<RuntimeHost> {
  const request = { ...scope(placement, instance), op: "attach", lane: laneReference(placement, lane) };
  const transport = ssh(request.placement.destination);
  try {
    const pin = await exchange(transport, request, attachIdentitySchema);
    if (!isDeepStrictEqual(pin.placement, placement) || pin.generation !== lane.generation || pin.laneId !== lane.id
      || pin.sessionFile !== lane.sessionFile || lane.sessionId !== null && pin.sessionId !== lane.sessionId
      || lane.pid !== null && pin.pid !== lane.pid) {
      throw new RemoteWorkerError("SSH stream receipt did not match the original lane, generation, placement or session");
    }
    return await bridge(transport, pin);
  } catch (error) { transport.close(); throw error; }
}
