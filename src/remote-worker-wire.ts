import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { evidenceRequestSchema } from "./lane-evidence";
import { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog/effort";
import { Type, type Static, type TSchema } from "@sinclair/typebox/type";
import { Value } from "@sinclair/typebox/value";

const PROTOCOL = "omp-sa-worker-2";
/** Fits a bounded evidence reply even when every byte needs JSON escaping. */
const HEADER_LIMIT = 512 * 1024;
export const REQUEST_TIMEOUT = 15_000;
/** Worker-side bound for `omp models --json` in the login environment. */
export const MODEL_LISTING_TIMEOUT = 60_000;
/**
 * HEAD waits for a worker's own bounded work plus SSH connect: capability is
 * linger (5 s) + login shell (20 s) + model listing; start adds the launcher
 * (login shell, Host startup and composition, each bounded).
 */
export const CAPABILITY_TIMEOUT = 120_000;
export const INPUT_TIMEOUT = 120_000;
export const PROVISION_TIMEOUT = 300_000;
export const PROVISION_LIMIT = 256 * 1024 * 1024;
export const INPUT_LIMIT = 64 * 1024 * 1024;
export const START_TIMEOUT = 300_000;

export class RemoteWorkerError extends Error {
  override readonly name = "RemoteWorkerError";
}

export const text = (maxLength: number) => Type.String({ minLength: 1, maxLength, pattern: "^[^\\u0000\\r\\n]+(?![\\s\\S])" });
export const absolutePath = Type.String({ minLength: 2, maxLength: 4096, pattern: "^/[^\\u0000\\r\\n]*(?![\\s\\S])" });
export const uuid = Type.String({ minLength: 36, maxLength: 36, pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" });
export const laneId = Type.String({ pattern: "^lane-[A-Za-z0-9_-]{1,123}(?![\\s\\S])" });
const pid = Type.Integer({ minimum: 1, maximum: 0x7fffffff });
export const generation = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
export const revisionHash = Type.String({ pattern: "^[0-9a-f]{40,64}$" });
export const sha256 = Type.String({ pattern: "^[0-9a-f]{64}$" });
export const placementSchema = Type.Object({
  worker: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*(?![\\s\\S])" }),
  destination: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]*(?![\\s\\S])" }),
  workerId: uuid,
}, { additionalProperties: false });
export const laneSchema = Type.Object({
  id: laneId, cwd: absolutePath, socketPath: absolutePath, sessionFile: absolutePath, generation,
  pid: Type.Union([pid, Type.Null()]), sessionId: Type.Union([text(256), Type.Null()]),
}, { additionalProperties: false });
export const optionsSchema = Type.Object({
  model: Type.Optional(text(1024)),
  modelPreset: Type.Optional(Type.Object({
    name: text(128),
    preset: Type.Object({
      modelRoles: Type.Record(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*(?![\\s\\S])" }), text(1024),
        { maxProperties: 64, additionalProperties: false }),
      defaultThinkingLevel: Type.Optional(Type.Union([...THINKING_EFFORTS.map(level => Type.Literal(level)), Type.Literal("auto")])),
    }, { additionalProperties: false }),
  }, { additionalProperties: false })),
  subagentConcurrency: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
}, { additionalProperties: false });
export const provenanceSchema = Type.Object({
  revision: revisionHash, repository: text(1024), branch: text(1024), preparedAt: text(64),
}, { additionalProperties: false });
/** Worker facts measured in the worker account's login context. */
export const capabilitySchema = Type.Object({
  package: Type.Object({ version: text(64), digest: sha256 }, { additionalProperties: false }),
  platform: text(32),
  bootId: text(64),
  clock: Type.Integer({ minimum: 0 }),
  omp: text(64),
  superkit: Type.Union([revisionHash, Type.Null()]),
  roots: Type.Array(absolutePath, { minItems: 1, maxItems: 64 }),
  models: Type.Array(text(1024), { maxItems: 4096 }),
  /** macOS only: the readiness of the fixed launcher, reported (not enforced) here so doctor can name each missing piece; starting a Host enforces it. */
  macos: Type.Optional(Type.Object({
    launcher: Type.Union([Type.Object({ path: absolutePath, cdhash: text(64) }, { additionalProperties: false }), Type.Null()]),
    /** The launcher on disk is not the binary the recorded grants belong to. */
    launcherChanged: Type.Boolean(),
    /** Whether the launcher's payload pointer names this running release. */
    pointer: Type.Union([Type.Literal("current"), Type.Literal("stale"), Type.Literal("absent")]),
    /** Protected paths of the worker scope no recorded grant covers. */
    missing: Type.Array(Type.Object({ path: absolutePath, category: text(64) }, { additionalProperties: false }), { maxItems: 65 }),
    /** The one-time setup script of this release, run at the Mac. */
    setup: absolutePath,
    /** Present only when the worker account runs its own sshd (worker add --user-sshd): its launchd state and the addresses it listens on. */
    userSshd: Type.Optional(Type.Object({
      state: text(64), listening: Type.Array(text(128), { maxItems: 16 }),
    }, { additionalProperties: false })),
    /** The boot the worker was first seen on, and the latest later boot whose login brought its launchd agents back unattended. */
    reboot: Type.Optional(Type.Object({ first: text(64), verified: Type.Union([text(64), Type.Null()]) }, { additionalProperties: false })),
  }, { additionalProperties: false })),
}, { additionalProperties: false });
/** What a launched Host actually loaded, pinned in the worker reservation. */
export const launchedSchema = Type.Object({
  package: capabilitySchema.properties.package, omp: text(64), superkit: Type.Union([revisionHash, Type.Null()]), bootId: text(64),
}, { additionalProperties: false });
const requestScope = { protocol: Type.Literal(PROTOCOL), instance: uuid, placement: placementSchema };
export const requestSchema = Type.Union([
  Type.Object({ ...requestScope, op: Type.Literal("capability") }, { additionalProperties: false }),
  // `size` raw archive bytes follow the header on the same stream.
  Type.Object({
    ...requestScope, op: Type.Literal("provision"), provenance: provenanceSchema, digest: sha256,
    size: Type.Integer({ minimum: 1, maximum: PROVISION_LIMIT })
  }, { additionalProperties: false }),
  Type.Object({ ...requestScope, op: Type.Literal("resolve"), id: laneId, cwd: absolutePath }, { additionalProperties: false }),
  Type.Object({ ...requestScope, op: Type.Literal("inspect"), lane: laneSchema }, { additionalProperties: false }),
  Type.Object({
    ...requestScope, op: Type.Literal("start"), lane: laneSchema, options: optionsSchema,
    superkit: Type.Union([revisionHash, Type.Null()])
  }, { additionalProperties: false }),
  Type.Object({ ...requestScope, op: Type.Literal("attach"), lane: laneSchema }, { additionalProperties: false }),
  Type.Object({ ...requestScope, op: Type.Literal("evidence"), lane: laneSchema, request: evidenceRequestSchema }, { additionalProperties: false }),
  // Reply header {name, size, digest}, then `size` raw bytes of the staged result file.
  Type.Object({ ...requestScope, op: Type.Literal("result"), lane: laneSchema, path: text(1024) }, { additionalProperties: false }),
  // `size` raw bytes follow; stored once under the lane's private worker directory.
  Type.Object({
    ...requestScope, op: Type.Literal("input"), lane: laneSchema, name: text(255), digest: sha256,
    size: Type.Integer({ minimum: 0, maximum: INPUT_LIMIT })
  }, { additionalProperties: false }),
]);
export const workspaceSchema = Type.Object({
  cwd: absolutePath, repoRoot: Type.Union([absolutePath, Type.Null()]), socketPath: absolutePath, sessionFile: absolutePath,
}, { additionalProperties: false });
export const inspectionSchema = Type.Object({ socket: Type.Boolean(), transcript: Type.Boolean(), alive: Type.Boolean() },
  { additionalProperties: false });
export const startedSchema = Type.Object({ pid, launched: launchedSchema }, { additionalProperties: false });
export const inputStoredSchema = Type.Object({ path: absolutePath }, { additionalProperties: false });
export const RESULT_LIMIT = 8 * 1024 * 1024;
export const resultFileSchema = Type.Object({
  name: text(255), size: Type.Integer({ minimum: 1, maximum: RESULT_LIMIT }), digest: sha256,
}, { additionalProperties: false });
export const hostIdentitySchema = Type.Object({
  pid, ownerPid: pid, sessionId: text(256), sessionFile: absolutePath,
}, { additionalProperties: false });
export const attachIdentitySchema = Type.Object({
  ...hostIdentitySchema.properties, generation, laneId, placement: placementSchema, launched: launchedSchema,
}, { additionalProperties: false });
export const replySchema = Type.Union([
  Type.Object({ protocol: Type.Literal(PROTOCOL), workerId: uuid, instance: uuid, value: Type.Unknown() }, { additionalProperties: false }),
  Type.Object({ protocol: Type.Literal(PROTOCOL), workerId: uuid, instance: uuid, error: text(1024) }, { additionalProperties: false }),
]);

export type WorkerRequest = Static<typeof requestSchema>;
export type WorkerLane = Static<typeof laneSchema>;
export type WorkerLaunchOptions = Static<typeof optionsSchema>;
export type WorkerHostIdentity = Static<typeof hostIdentitySchema>;
export type WorkerAttachIdentity = Static<typeof attachIdentitySchema>;
export type WorkerScope = Pick<WorkerRequest, "instance" | "placement">;
export type WorkerCapability = Static<typeof capabilitySchema>;
export type WorkerLaunched = Static<typeof launchedSchema>;

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
let packageIdentity: WorkerCapability["package"] | undefined;
/**
 * Release version and a digest of the code both ends run: package.json, the
 * worker command and src/. HEAD and worker must match exactly.
 */
export function workerPackage(): WorkerCapability["package"] {
  if (packageIdentity) return packageIdentity;
  const files = ["package.json", "bin/omp-sa-worker"];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(relative(packageRoot, path));
    }
  };
  walk(join(packageRoot, "src"));
  const hash = createHash("sha256").update("omp-sa-worker-package-v1\0");
  for (const file of files.sort()) {
    hash.update(`${file}\0`).update(createHash("sha256").update(readFileSync(join(packageRoot, file))).digest("hex")).update("\0");
  }
  const { version } = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version: string };
  return packageIdentity = { version, digest: hash.digest("hex") };
}

export function parse<T extends TSchema>(schema: T, value: unknown, name: string): Static<T> {
  if (!Value.Check(schema, value)) throw new RemoteWorkerError(`Invalid worker ${name}`);
  return value;
}

export function encodeHeader(fields: object): string {
  const header = `${JSON.stringify({ protocol: PROTOCOL, ...fields })}\n`;
  if (Buffer.byteLength(header) > HEADER_LIMIT) throw new RemoteWorkerError("Worker control frame exceeds its size limit");
  return header;
}

export function decodeHeader(input: Readable, timeout: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    const finish = (error?: Error) => {
      clearTimeout(timer);
      input.off("readable", read).off("error", finish).off("end", disconnected).off("close", disconnected);
      if (error) reject(error);
    };
    const disconnected = () => finish(new RemoteWorkerError("Worker closed the stream before sending a control frame"));
    const read = () => {
      try {
        for (; ;) {
          const chunk: unknown = input.read();
          if (chunk === null) return;
          if (!Buffer.isBuffer(chunk)) throw new RemoteWorkerError("Worker control stream is not binary");
          const newline = chunk.indexOf(10);
          length += (newline === -1 ? chunk.length : newline);
          if (length >= HEADER_LIMIT) throw new RemoteWorkerError("Worker control frame exceeds its size limit");
          chunks.push(newline === -1 ? chunk : chunk.subarray(0, newline));
          if (newline === -1) continue;
          const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, length)));
          if (newline + 1 < chunk.length) input.unshift(chunk.subarray(newline + 1));
          finish();
          resolve(value);
          return;
        }
      } catch (cause) { finish(new RemoteWorkerError("Could not read worker control frame", { cause })); }
    };
    const timer = setTimeout(() => finish(new RemoteWorkerError("Worker did not respond before the control timeout")), timeout);
    input.on("readable", read).once("error", finish).once("end", disconnected).once("close", disconnected);
    read();
    if (input.readableEnded || input.destroyed) disconnected();
  });
}

export function writeHeader(output: Writable, header: string): Promise<void> {
  return new Promise((resolve, reject) => {
    output.write(header, error => error ? reject(error) : resolve());
  });
}
