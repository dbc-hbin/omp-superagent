import type { Database } from "bun:sqlite";
import { isAbsolute, normalize } from "node:path";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Lane } from "./contracts";
import type { RemotePlacement } from "./worker-wire";

export interface LaneRow {
  readonly data: string;
  /** Missing only when opening a pre-migration ledger read-only. */
  readonly remote?: string | null;
}

const remoteSchema = Type.Object({
  workerId: Type.String({ pattern: "^[A-Za-z0-9_-]{1,128}$" }),
  repoId: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  revision: Type.String({ pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" }),
  subdir: Type.String({ maxLength: 2048 }),
  stateDir: Type.String(),
}, { additionalProperties: false });

function parseRemote(json: string): RemotePlacement {
  const parsed: unknown = JSON.parse(json);
  if (!Value.Check(remoteSchema, parsed)
    || !isAbsolute(parsed.stateDir) || normalize(parsed.stateDir) !== parsed.stateDir || /[\r\n\0]/.test(parsed.stateDir)
    || /[\\\u0000-\u001f\u007f]/.test(parsed.subdir)
    || (parsed.subdir && parsed.subdir.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git"))) {
    throw new Error("Invalid durable remote lane placement");
  }
  return parsed;
}

/** Placement is a separate immutable SQLite field; state-only updates do not rewrite it. */
export function laneData({ remote: _placement, ...lane }: Lane): string {
  return JSON.stringify(lane);
}

export function toLane(row: LaneRow): Lane {
  const { remote: _placement, ...lane } = JSON.parse(row.data) as Lane;
  return { ...lane, ...(row.remote == null ? {} : { remote: parseRemote(row.remote) }),
    model: lane.model ?? null, modelReason: lane.modelReason ?? null,
    modelPreset: lane.modelPreset ?? null, modelPresetSnapshot: lane.modelPresetSnapshot ?? null };
}

export function readLaneRows(db: Database): Lane[] {
  // Status can read a legacy ledger before any process opens the writer.
  return db.query<LaneRow, []>("SELECT * FROM lanes ORDER BY rowid").all().map(toLane);
}

export function lanePlacement(lane: Lane) {
  return lane.remote ? { target: "remote" as const, ...lane.remote } : { target: "local" as const };
}
