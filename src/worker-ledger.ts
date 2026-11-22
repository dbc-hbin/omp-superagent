import { Database } from "bun:sqlite";
import { closeSync, constants, fstatSync, lstatSync, openSync } from "node:fs";
import { join } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { releaseCheckout } from "./worker-checkout";
import { WorkerRefusal } from "./worker-request";
import type { WorkerLaneRef, WorkerPolicy } from "./worker-wire";

export const workerPid = Type.Integer({ minimum: 1, maximum: 0x7fffffff });
const sessionId = Type.String({ minLength: 1, maxLength: 512 });
const identityFields = {
  pid: workerPid,
  ownerPid: workerPid,
  sessionId,
  sessionFile: Type.String({ minLength: 1 }),
};
const identity = Type.Object({
  ...identityFields,
  dev: Type.Number(),
  ino: Type.Number(),
});
export const workerExit = Type.Object({
  ...identityFields,
  workerAttempt: Type.String(),
  code: Type.Union([Type.Integer(), Type.Null()]),
  signal: Type.Union([Type.String(), Type.Null()]),
  persisted: Type.Literal(true),
  observationsFlushed: Type.Literal(true),
});
const receiptFields = {
  laneId: Type.String(),
  generation: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  repoId: Type.String(),
  revision: Type.String(),
  subdir: Type.String(),
  repoRoot: Type.String(),
  gitDir: Type.String(),
  launchDigest: Type.String({ pattern: "^[0-9a-f]{64}$" }),
  attempt: Type.String({ pattern: "^[0-9a-f-]{36}$" }),
  launcherPid: workerPid,
  sessionId: Type.Union([sessionId, Type.Null()]),
};
const receipt = Type.Union([
  Type.Object({ ...receiptFields, phase: Type.Literal("reserved") }),
  Type.Object({ ...receiptFields, phase: Type.Literal("launching") }),
  Type.Object({ ...receiptFields, phase: Type.Literal("live"), identity }),
  Type.Object({ ...receiptFields, phase: Type.Literal("released"), exitVerified: Type.Optional(Type.Literal(true)) }),
]);
export type WorkerReceipt = Readonly<Static<typeof receipt>>;
export type WorkerIdentity = Readonly<Static<typeof identity>>;
type ReservedReceipt = Extract<WorkerReceipt, { phase: "reserved" }>;
type WorkerSeal = Pick<WorkerLaneRef, "generation" | "repoId" | "revision" | "subdir"> & { readonly repoRoot: string };

function decode(row: { readonly data: string } | null): WorkerReceipt | null {
  if (!row) return null;
  const value: unknown = JSON.parse(row.data);
  if (!Value.Check(receipt, value)) throw new WorkerRefusal("Worker launch ledger has an invalid receipt");
  return value;
}

export class WorkerLedger {
  readonly #db: Database;
  readonly #capacity: number;

  static count(policy: WorkerPolicy): number {
    if (!lstatSync(join(policy.stateDir, "worker.sqlite"), { throwIfNoEntry: false })) return 0;
    const ledger = new WorkerLedger(policy, "read");
    try { return ledger.active().length; } finally { ledger.close(); }
  }

  constructor(policy: WorkerPolicy, mode: "read" | "write" = "write") {
    const path = join(policy.stateDir, "worker.sqlite");
    const access = mode === "read" ? constants.O_RDONLY : constants.O_RDWR | constants.O_CREAT;
    const fd = openSync(path, access | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600)
        throw new WorkerRefusal("Worker ledger must be a private regular file (0600)");
    } finally { closeSync(fd); }
    this.#capacity = policy.capacity;
    this.#db = new Database(path, { strict: true, readonly: mode === "read" });
    try {
      this.#db.exec("PRAGMA busy_timeout = 5000;");
      if (mode === "write") this.#db.exec(`
        PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS worker_identity (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), worker_id TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS worker_lanes (id TEXT PRIMARY KEY, phase TEXT NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS worker_seals (
          id TEXT PRIMARY KEY, generation INTEGER NOT NULL, repoId TEXT NOT NULL,
          revision TEXT NOT NULL, subdir TEXT NOT NULL, repoRoot TEXT NOT NULL
        );
      `);
      if (mode === "write") this.#db.transaction(() => {
        this.#db.query("INSERT OR IGNORE INTO worker_identity VALUES (1, ?)").run(policy.workerId);
      }).immediate();
      const row = this.#db.query<{ worker_id: string }, []>("SELECT worker_id FROM worker_identity WHERE singleton = 1").get();
      if (row?.worker_id !== policy.workerId) throw new WorkerRefusal("Worker storage belongs to a different enrollment");
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  close(): void { this.#db.close(); }

  get(laneId: string): WorkerReceipt | null {
    return decode(this.#db.query<{ data: string }, [string]>("SELECT data FROM worker_lanes WHERE id = ?").get(laneId));
  }

  active(): WorkerReceipt[] {
    return this.#db.query<{ data: string }, []>("SELECT data FROM worker_lanes WHERE phase != 'released'")
      .all().flatMap(row => decode(row) ?? []);
  }

  #write(value: WorkerReceipt): void {
    this.#db.query("INSERT OR REPLACE INTO worker_lanes (id, phase, data) VALUES (?, ?, ?)")
      .run(value.laneId, value.phase, JSON.stringify(value));
  }

  #sealedGeneration(ref: WorkerLaneRef, repoRoot: string): number | undefined {
    const seal = this.#db.query<WorkerSeal, [string]>(
      "SELECT generation, repoId, revision, subdir, repoRoot FROM worker_seals WHERE id = ?").get(ref.laneId);
    if (seal && (seal.repoId !== ref.repoId || seal.revision !== ref.revision || seal.subdir !== ref.subdir || seal.repoRoot !== repoRoot))
      throw new WorkerRefusal("Worker lane has a different durable checkout binding");
    return seal?.generation;
  }

  confirmRelease(ref: WorkerLaneRef, repoRoot: string, options: {
    readonly observed: WorkerReceipt | null; readonly reconcile: boolean;
  }): boolean {
    const confirm = this.#db.transaction(() => {
      const current = this.get(ref.laneId);
      if (current?.attempt !== options.observed?.attempt || current && current.phase !== "released") return false;
      const sealed = this.#sealedGeneration(ref, repoRoot);
      if (ref.generation < (sealed ?? 0) || ref.generation < (current?.generation ?? 0))
        throw new WorkerRefusal("Worker lane generation is stale");
      if (sealed === ref.generation || current?.generation === ref.generation) return true;
      if (!options.reconcile) return false;
      // Keep any previous exit/session receipt intact. Reserve and seal use the
      // same immediate transaction: either a launch is already admitted, or
      // even an open request that arrives after this reply must refuse.
      this.#db.query("INSERT OR REPLACE INTO worker_seals VALUES (?, ?, ?, ?, ?, ?)")
        .run(ref.laneId, ref.generation, ref.repoId, ref.revision, ref.subdir, repoRoot);
      return true;
    });
    return options.reconcile ? confirm.immediate() : confirm();
  }

  reserve(ref: WorkerLaneRef, binding: { readonly repoRoot: string; readonly gitDir: string; readonly launchDigest: string }, previous: WorkerReceipt | null): ReservedReceipt {
    return this.#db.transaction(() => {
      if ((this.#sealedGeneration(ref, binding.repoRoot) ?? 0) >= ref.generation)
        throw new WorkerRefusal("Worker lane generation was sealed and cannot open");
      const current = this.get(ref.laneId);
      if (current && (current.phase !== "released" || current.generation >= ref.generation)
        || current?.attempt !== previous?.attempt || current?.phase !== previous?.phase)
        throw new WorkerRefusal("Worker lane generation is already reserved or no longer current");
      const active = this.#db.query<{ count: number }, []>("SELECT count(*) AS count FROM worker_lanes WHERE phase != 'released'").get();
      if (!active || active.count >= this.#capacity) throw new WorkerRefusal("Worker Host capacity is occupied");
      const value: ReservedReceipt = { ...ref, ...binding, attempt: crypto.randomUUID(), launcherPid: process.pid,
        phase: "reserved", sessionId: current?.sessionId ?? null };
      this.#write(value);
      return value;
    }).immediate();
  }

  transition(current: WorkerReceipt, next: WorkerReceipt): boolean {
    return this.#db.transaction(() => {
      const actual = this.get(current.laneId);
      if (actual?.attempt !== current.attempt || actual.phase !== current.phase) return false;
      this.#write(next);
      return true;
    }).immediate();
  }

  retire(current: WorkerReceipt, exit?: { readonly sessionId: string; readonly clean: boolean; readonly cleanup: () => void }): boolean {
    return this.#db.transaction(() => {
      const actual = this.get(current.laneId);
      if (actual?.attempt !== current.attempt || actual.phase !== current.phase) return false;
      exit?.cleanup();
      releaseCheckout(current);
      const { laneId, generation, repoId, revision, subdir, repoRoot, gitDir, attempt, launcherPid, launchDigest } = current;
      this.#write({ laneId, generation, repoId, revision, subdir, repoRoot, gitDir, attempt, launcherPid, launchDigest,
        phase: "released", sessionId: exit?.sessionId ?? current.sessionId, ...(exit?.clean && { exitVerified: true }) });
      return true;
    }).immediate();
  }
}
