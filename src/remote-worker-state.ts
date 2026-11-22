import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";
import { Type, type Static } from "@sinclair/typebox/type";
import { SESSION_HEADER_READ_LIMIT, sessionHeaderIdFromPrefix } from "@oh-my-pi/pi-coding-agent/session/session-header-id";
import {
  approvedWorkspace, bootId, errorCode, openPrivateFile, optionalStat, privateWorkerDirectory, workspacePaths,
  type WorkerProvision
} from "./remote-worker-provision";
import {
  hostIdentitySchema, laneSchema, launchedSchema, optionsSchema, parse, placementSchema, RemoteWorkerError, uuid,
  type WorkerLane, type WorkerLaunched, type WorkerLaunchOptions, type WorkerScope
} from "./remote-worker-wire";
import { isDeepStrictEqual } from "node:util";

const fingerprintSchema = Type.Object({
  ...hostIdentitySchema.properties, dev: Type.String({ pattern: "^\\d+$" }), ino: Type.String({ pattern: "^\\d+$" }),
}, { additionalProperties: false });
const reservation = {
  lane: laneSchema, placement: placementSchema, options: optionsSchema, launched: launchedSchema, token: uuid, fresh: Type.Boolean(),
  /** The record this reservation replaced, restored if its launcher never claims it. */
  prior: Type.Optional(Type.String({ maxLength: 65536 })),
};
const recordSchema = Type.Union([
  Type.Object({ ...reservation, stage: Type.Literal("reserved") }, { additionalProperties: false }),
  Type.Object({ ...reservation, stage: Type.Literal("launching") }, { additionalProperties: false }),
  Type.Object({ ...reservation, stage: Type.Literal("owned"), identity: fingerprintSchema }, { additionalProperties: false }),
  Type.Object({ ...reservation, stage: Type.Literal("released"), identity: fingerprintSchema }, { additionalProperties: false }),
]);
type Reservation = Static<typeof recordSchema>;
export type OwnedReservation = Extract<Reservation, { stage: "owned" }>;
export type LaunchReservation = Extract<Reservation, { stage: "launching" }>;

export function generationSocket(directory: string, generation: number): string {
  return join(directory, `r${generation.toString(36)}.sock`);
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (errorCode(error) === "ESRCH") return false; throw error; }
}

function verifyExit(path: string, identity: OwnedReservation["identity"]): void {
  const fd = openPrivateFile(path, constants.O_RDONLY);
  try {
    const buffer = Buffer.alloc(8192);
    const bytes = readSync(fd, buffer);
    const expected = {
      pid: identity.pid, ownerPid: identity.ownerPid, sessionId: identity.sessionId,
      sessionFile: identity.sessionFile, code: 0, signal: null, persisted: true, observationsFlushed: true
    };
    if (bytes === buffer.length || !isDeepStrictEqual(JSON.parse(buffer.subarray(0, bytes).toString("utf8")), expected)) {
      throw new RemoteWorkerError("Worker native exit did not confirm clean journal persistence for this generation");
    }
  } finally { closeSync(fd); }
}

export function transcriptId(path: string): string | null {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (errorCode(error) === "ENOENT") return null; throw error; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1) {
      throw new RemoteWorkerError("Worker transcript ownership is invalid");
    }
    const limit = Math.min(stat.size, SESSION_HEADER_READ_LIMIT);
    const buffer = Buffer.alloc(limit);
    const length = readSync(fd, buffer);
    const id = sessionHeaderIdFromPrefix(buffer.subarray(0, length));
    if (!id) throw new RemoteWorkerError("Worker transcript has no verifiable session header");
    return id;
  } finally { closeSync(fd); }
}

export class WorkerLaneState {
  readonly paths: ReturnType<typeof workspacePaths>;
  readonly #db: Database;
  readonly #boot = bootId();

  constructor(readonly config: WorkerProvision, readonly scope: WorkerScope, id: string) {
    this.paths = workspacePaths(config, scope, id);
    const ledger = join(config.stateDir, "lanes.sqlite");
    closeSync(openPrivateFile(ledger, constants.O_RDWR | constants.O_CREAT));
    this.#db = new Database(ledger, { strict: true });
    try {
      this.#db.exec(`PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS launches (lane TEXT PRIMARY KEY, record TEXT NOT NULL)`);
    } catch (error) { this.#db.close(); throw error; }
  }

  close(): void { this.#db.close(); }

  read(): Reservation | null {
    const row = this.#db.query<{ record: string }, [string]>("SELECT record FROM launches WHERE lane = ?").get(this.paths.directory);
    return row && parse(recordSchema, JSON.parse(row.record), "launch reservation");
  }

  #save(record: Reservation): void {
    this.#db.query(`INSERT INTO launches VALUES (?, ?) ON CONFLICT(lane) DO UPDATE SET record = excluded.record`)
      .run(this.paths.directory, JSON.stringify(record));
  }

  #verifyPaths(lane: WorkerLane): void {
    if (lane.socketPath !== this.paths.socketPath || lane.sessionFile !== this.paths.sessionFile ||
      approvedWorkspace(this.config, lane.cwd) !== lane.cwd) {
      throw new RemoteWorkerError("Lane paths do not match the worker workspace binding");
    }
    if (optionalStat(this.paths.directory)) privateWorkerDirectory(this.paths.directory);
    // The HEAD path is a stable lane handle, never itself a connectable endpoint.
    if (optionalStat(this.paths.socketPath)) throw new RemoteWorkerError("Unreserved endpoint at worker lane binding");
  }

  #matches(row: Reservation, lane: WorkerLane): void {
    if (lane.id !== row.lane.id || lane.cwd !== row.lane.cwd || lane.sessionFile !== row.lane.sessionFile ||
      lane.socketPath !== row.lane.socketPath || !isDeepStrictEqual(row.placement, this.scope.placement) ||
      lane.generation < row.lane.generation) {
      throw new RemoteWorkerError("Lane does not match the current worker reservation");
    }
  }

  #rejectOrphanEndpoints(ownedPath: string | null): void {
    for (const name of readdirSync(this.paths.directory)) {
      if (/^r[0-9a-z]+\.sock$/.test(name) && join(this.paths.directory, name) !== ownedPath) {
        throw new RemoteWorkerError("Worker lane has an orphan generation endpoint");
      }
    }
  }

  evaluate(lane: WorkerLane) {
    return this.#db.transaction(() => this.#evaluate(lane)).immediate();
  }

  #evaluate(lane: WorkerLane) {
    this.#verifyPaths(lane);
    const row = this.read();
    if (!row) {
      if (lane.sessionId !== null || lane.pid !== null || optionalStat(this.paths.directory)) {
        throw new RemoteWorkerError("Worker lane has orphan evidence with no launch reservation");
      }
      return { row: null, socket: false, transcript: false, alive: false };
    }
    this.#matches(row, lane);
    if (row.stage === "reserved" || row.stage === "launching") {
      throw new RemoteWorkerError("Worker launch reservation is not confirmed; refusing duplicate launch or release");
    }
    const { identity } = row;
    if (lane.sessionId !== null && lane.sessionId !== identity.sessionId || lane.pid !== null && lane.pid !== identity.pid) {
      throw new RemoteWorkerError("Lane session or PID does not match the original worker owner");
    }
    const transcript = transcriptId(lane.sessionFile);
    if (transcript !== null && transcript !== identity.sessionId) {
      throw new RemoteWorkerError("Worker transcript does not match the original session");
    }
    const path = generationSocket(this.paths.directory, row.lane.generation);
    if (transcript === null && row.stage === "released") {
      throw new RemoteWorkerError("Worker cannot confirm the original released transcript");
    }
    if (optionalStat(this.paths.directory)) this.#rejectOrphanEndpoints(row.stage === "owned" ? path : null);
    if (row.stage === "released") {
      // A durable terminal receipt refers to a process generation, not these
      // PID numbers forever. Later PID reuse cannot resurrect this Host.
      return { row, socket: false, transcript: true, alive: false };
    }
    const stat = optionalStat(path);
    // Sample both PIDs, even when one is already gone; EPERM and unknown errors are not proof.
    // After a reboot the recorded PIDs name nothing of ours, even if reused.
    const sameBoot = row.launched.bootId === this.#boot;
    const nativeAlive = sameBoot && pidAlive(identity.pid);
    const ownerAlive = sameBoot && pidAlive(identity.ownerPid);
    const alive = nativeAlive || ownerAlive;
    if (stat && (!stat.isSocket() || stat.uid !== BigInt(process.getuid?.() ?? -1) || (stat.mode & 0o777n) !== 0o600n ||
      `${stat.dev}` !== identity.dev || `${stat.ino}` !== identity.ino || !nativeAlive || !ownerAlive)) {
      throw new RemoteWorkerError("Worker endpoint does not match the original native Host owner");
    }
    if (!stat && !alive) {
      if (optionalStat(path) || transcript === null || !optionalStat(`${path}.exit.json`)) {
        throw new RemoteWorkerError("Worker cannot confirm a released Host and original transcript");
      }
      verifyExit(`${path}.exit.json`, identity);
      this.#rejectOrphanEndpoints(null);
      // The caller holds the immediate transaction that read this generation.
      // Neither a concurrent inspect nor start can overwrite a newer reservation.
      const released = { ...row, stage: "released" } as const;
      this.#save(released);
      return { row: released, socket: false, transcript: true, alive: false };
    }
    if (lane.generation !== row.lane.generation && (stat || alive)) {
      throw new RemoteWorkerError("Prior worker generation still owns the lane");
    }
    return { row, socket: stat !== null, transcript: transcript !== null, alive };
  }

  reserve(lane: WorkerLane, options: WorkerLaunchOptions, launched: WorkerLaunched): string | null {
    if (lane.generation === 0) throw new RemoteWorkerError("Worker launch requires an admitted lane generation");
    const token = this.#db.transaction(() => {
      const prior = this.#evaluate(lane);
      if (prior.row?.lane.generation === lane.generation) {
        if (!prior.socket || !isDeepStrictEqual(prior.row.options, options)
          || prior.row.launched.superkit !== launched.superkit) return false;
        return null;
      }
      if (prior.socket || prior.alive || lane.pid !== null || optionalStat(generationSocket(this.paths.directory, lane.generation))) {
        throw new RemoteWorkerError("Worker cannot reserve over an existing process or endpoint");
      }
      const token = randomUUID();
      this.#save({
        stage: "reserved", lane: { ...lane, sessionId: prior.row?.identity.sessionId ?? null }, options, launched, token,
        // One level only: the replaced record's own history is not needed to restore it.
        placement: this.scope.placement, fresh: prior.row === null,
        ...(prior.row ? { prior: JSON.stringify({ ...prior.row, prior: undefined }) } : {}),
      });
      return token;
    }).immediate();
    if (token === false) throw new RemoteWorkerError("Worker generation is already reserved; launch will not be repeated");
    return token;
  }

  /**
   * The launcher exited without claiming this reservation. Hosts start only after
   * a claim, so no Host exists for it: restore the record it replaced.
   */
  abandon(token: string): void {
    this.#db.transaction(() => {
      const row = this.read();
      if (row?.stage !== "reserved" || row.token !== token) return;
      if (row.prior === undefined) {
        this.#db.query("DELETE FROM launches WHERE lane = ?").run(this.paths.directory);
      } else this.#save(parse(recordSchema, JSON.parse(row.prior), "prior launch reservation"));
    }).immediate();
  }

  claim(token: string): LaunchReservation {
    return this.#db.transaction(() => {
      const row = this.read();
      if (row?.stage !== "reserved" || row.token !== token || !isDeepStrictEqual(row.placement, this.scope.placement)) {
        throw new RemoteWorkerError("Worker launch reservation is no longer valid");
      }
      this.#verifyPaths(row.lane);
      if (!row.fresh) this.#rejectOrphanEndpoints(null);
      const running = { ...row, stage: "launching" } as const;
      this.#save(running);
      return running;
    }).immediate();
  }

  confirm(token: string, identity: OwnedReservation["identity"]): void {
    this.#db.transaction(() => {
      const row = this.read();
      if (row?.stage !== "launching" || row.token !== token || !isDeepStrictEqual(row.placement, this.scope.placement) ||
        identity.sessionFile !== row.lane.sessionFile || row.lane.sessionId !== null && identity.sessionId !== row.lane.sessionId) {
        throw new RemoteWorkerError("Launched Host no longer matches its worker reservation");
      }
      this.#save({ ...row, stage: "owned", identity });
    }).immediate();
  }
}
