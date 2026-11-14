import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { DialogResponse, GatewayRestartNotice, GatewayRestartRecord, GatewayRestartRequest, Inbound, Route } from "./contracts";
import { routeKey } from "./contracts";
import { DeliveryError } from "./delivery";

export type GatewayEvent =
  | { kind: "message"; input: Inbound }
  | { kind: "answer"; approvalId: string; response: DialogResponse; route: Route }
  | ({ kind: "restart" } & GatewayRestartNotice)
  | { kind: "reconnect"; barrier?: string };
export type GatewayReceipt = "accepted" | "rejected" | "unresolved";
export interface QueuedEvent { sequence: number; event: GatewayEvent; reconciliation?: true }

function identity(event: GatewayEvent): unknown {
  if (event.kind !== "message") return event;
  const { receivedAt: _, ...input } = event.input;
  return { ...event, input: { ...input, attachments: input.attachments.map(file => {
    let location = file.url;
    try {
      const url = new URL(location);
      if (input.route.platform === "discord" && url.protocol === "https:" &&
          ["cdn.discordapp.com", "media.discordapp.net"].includes(url.hostname)) {
        for (const key of ["ex", "is", "hm"]) url.searchParams.delete(key);
        url.searchParams.sort();
        location = url.href;
      }
    } catch { /* Adapter-owned non-URL references remain exact. */ }
    return { ...file, url: location };
  }).sort((a, b) => a.id.localeCompare(b.id)) } };
}

/** A separate lifetime lock; never impersonates the head Store writer. */
export class GatewayStore {
  private readonly lock: Database;
  private readonly db: Database;
  private closed = false;

  constructor(stateDir: string) {
    const path = join(stateDir, "coordination.sqlite");
    this.lock = new Database(`${path}.gateway-lock`, { create: true, strict: true });
    let database: Database | undefined;
    try {
      this.lock.run("PRAGMA busy_timeout = 100");
      this.lock.run("BEGIN EXCLUSIVE");
      this.db = database = new Database(path, { create: true, strict: true });
      this.db.run("PRAGMA busy_timeout = 5000");
      this.db.run("PRAGMA journal_mode = WAL");
      this.db.run("PRAGMA synchronous = FULL");
      this.db.run(`
        CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS gateway_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, identity TEXT NOT NULL UNIQUE,
          data TEXT NOT NULL, received_at INTEGER NOT NULL,
          delivered_at INTEGER, delivery_error TEXT, attempted_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS gateway_events_pending ON gateway_events(delivered_at, sequence);
        CREATE TABLE IF NOT EXISTS gateway_effects (
          id TEXT PRIMARY KEY, operation TEXT NOT NULL, arguments TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('attempted','complete')),
          result TEXT
        );
      `);
      const columns = this.db.query("PRAGMA table_info(gateway_events)").all() as Array<{ name: string }>;
      this.db.transaction(() => {
        if (!columns.some(column => column.name === "attempted_at")) {
          this.db.run("ALTER TABLE gateway_events ADD COLUMN attempted_at INTEGER");
          // A pre-migration callback may already have reached native code.
          this.db.run("UPDATE gateway_events SET attempted_at=received_at WHERE delivered_at IS NULL AND identity LIKE 'answer:%'");
        }
        // Old generic handler errors were incorrectly treated as completed.
        // Inbox dedupe is safe; old callbacks must reconcile, never blind replay.
        this.db.run("UPDATE gateway_events SET attempted_at=COALESCE(attempted_at,delivered_at,received_at),delivered_at=NULL,delivery_error='unresolved' WHERE delivery_error='Head rejected admitted event'");
      }).immediate();
      chmodSync(path, 0o600);
      chmodSync(`${path}.gateway-lock`, 0o600);
    } catch (error) {
      database?.close(true);
      this.lock.close(true);
      throw error;
    }
  }

  getMeta(key: string): string | null {
    return (this.db.query("SELECT value FROM metadata WHERE key = ?").get(key) as { value: string } | null)?.value ?? null;
  }
  setMeta(key: string, value: string): void {
    this.db.query("INSERT INTO metadata VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  }

  getRestart(requestId?: string): GatewayRestartRecord | null {
    const value = this.getMeta(requestId === undefined ? "gateway:restart" : `gateway:restart:${requestId}`);
    return value === null ? null : JSON.parse(value) as GatewayRestartRecord;
  }

  /** Read only the head's durable authorized source and its delivered ACK. */
  validateRestart(request: GatewayRestartRequest): Inbound {
    const reject = () => new DeliveryError("Gateway restart requires its original completed owner command and sent acknowledgement", "rejected");
    if (this.getMeta(`user-source:${request.inputId}`) !== "true") throw reject();
    const row = this.db.query("SELECT data,target,state FROM inputs WHERE id=?").get(request.inputId) as {
      data: string; target: string | null; state: string;
    } | null;
    if (!row || row.target !== "main" || row.state !== "done") throw reject();
    const input = JSON.parse(row.data) as Inbound;
    if (input.id !== request.inputId || input.text.trim() !== "/restart") throw reject();
    const ack = this.db.query("SELECT source_id,route,state,remote_id FROM outputs WHERE id=?").get(request.ackOutputId) as {
      source_id: string; route: string; state: string; remote_id: string | null;
    } | null;
    if (!ack || ack.source_id !== input.id || ack.state !== "sent" || !ack.remote_id?.trim()
      || !isDeepStrictEqual(JSON.parse(ack.route), input.route)) throw reject();
    return input;
  }

  setRestart(record: GatewayRestartRecord): void {
    this.db.transaction(() => {
      const previous = this.getRestart(record.requestId);
      const latest = this.getRestart();
      const source = this.getMeta(`gateway:restart-source:${record.inputId}`);
      if (source !== null && source !== record.requestId || previous && (
        previous.inputId !== record.inputId || previous.ackOutputId !== record.ackOutputId
        || previous.gatewayPid !== record.gatewayPid || previous.headPid !== record.headPid
        || previous.sessionId !== record.sessionId || previous.sessionFile !== record.sessionFile)) {
        throw new DeliveryError("Gateway restart identity conflict", "rejected");
      }
      if (!previous) this.validateRestart(record);
      const serialized = JSON.stringify(record);
      this.setMeta(`gateway:restart:${record.requestId}`, serialized);
      // New receipts advance latest; late updates belong only to their own request.
      if (!previous || !latest || latest.requestId === record.requestId) this.setMeta("gateway:restart", serialized);
      this.setMeta(`gateway:restart-source:${record.inputId}`, record.requestId);
    }).immediate();
  }

  admit(event: GatewayEvent): boolean {
    const key = event.kind === "message" ? `message:${event.input.id}`
      : event.kind === "answer" ? `answer:${event.approvalId}`
      : event.kind === "restart" ? `restart:${event.requestId}:${event.outcome}`
      : `reconnect:${crypto.randomUUID()}`;
    return this.db.transaction(() => {
      // Repeated unresolved admissions must not grow a reconnect poison queue.
      if (event.kind === "reconnect" && this.db.query("SELECT 1 FROM gateway_events WHERE delivered_at IS NULL AND data = ?")
        .get(JSON.stringify(event))) return false;
      const existing = this.db.query("SELECT data FROM gateway_events WHERE identity = ?").get(key) as { data: string } | null;
      if (existing) {
        if (!isDeepStrictEqual(identity(JSON.parse(existing.data)), identity(event)))
          throw new Error("Gateway ingress identity conflict");
        return false;
      }
      this.db.query("INSERT INTO gateway_events(identity,data,received_at) VALUES (?,?,?)")
        .run(key, JSON.stringify(event), Date.now());
      return true;
    }).immediate();
  }

  next(sequence?: number): QueuedEvent | null {
    let row = this.db.query<{ sequence: number; data: string; attempted_at: number | null; delivery_error: string | null }, [number | null]>(
      `SELECT sequence,data,attempted_at,delivery_error FROM gateway_events
      WHERE delivered_at IS NULL AND (?1 IS NULL OR sequence=?1) ORDER BY sequence LIMIT 1`)
      .get(sequence ?? null);
    if (sequence === undefined && row?.delivery_error === "unresolved") {
      // Quarantine never grants replay authority, but must not trap the owner
      // outside recovery controls or the native approval-cache startup barrier.
      // Ordinary intake keeps its original sequence behind the unresolved event.
      const control = this.db.query<NonNullable<typeof row>, []>(`SELECT sequence,data,attempted_at,delivery_error FROM gateway_events
        WHERE delivered_at IS NULL AND (
          (json_extract(data,'$.kind')='reconnect' AND json_extract(data,'$.barrier') IS NOT NULL)
          OR (json_extract(data,'$.kind')='message' AND trim(json_extract(data,'$.input.text')) IN ('/restart','/stop','/stop head')))
        ORDER BY CASE WHEN json_extract(data,'$.kind')='reconnect' THEN 0 ELSE 1 END,sequence LIMIT 1`)
        .get();
      if (control) row = control;
    }
    if (!row) return null;
    const event: GatewayEvent = JSON.parse(row.data);
    return { sequence: row.sequence, event, ...(event.kind === "answer" && row.attempted_at !== null ? { reconciliation: true as const } : {}) };
  }
  attempt(sequence: number): void {
    this.db.query("UPDATE gateway_events SET attempted_at=COALESCE(attempted_at,?) WHERE sequence=? AND delivered_at IS NULL")
      .run(Date.now(), sequence);
  }
  receipt(sequence: number, outcome: GatewayReceipt): void {
    this.db.query("UPDATE gateway_events SET delivered_at=?,delivery_error=? WHERE sequence=? AND delivered_at IS NULL")
      .run(outcome === "unresolved" ? null : Date.now(), outcome === "accepted" ? null : outcome, sequence);
  }
  hasPendingAnswer(approvalId: string, route: Route): boolean {
    const row = this.db.query("SELECT data FROM gateway_events WHERE identity=? AND delivered_at IS NULL")
      .get(`answer:${approvalId}`) as { data: string } | null;
    if (!row) return false;
    const event: GatewayEvent = JSON.parse(row.data);
    return event.kind === "answer" && routeKey(event.route) === routeKey(route);
  }
  pending(): number {
    return (this.db.query("SELECT COUNT(*) AS count FROM gateway_events WHERE delivered_at IS NULL").get() as { count: number }).count;
  }
  unresolved(): number {
    // This local COUNT query always produces one numeric aggregate row.
    const row = this.db.query("SELECT COUNT(*) AS count FROM gateway_events WHERE delivered_at IS NULL AND delivery_error='unresolved'")
      .get() as { count: number };
    return row.count;
  }

  beginEffect(id: string, operation: string, args: unknown): { fresh: boolean; result: unknown } {
    const serialized = JSON.stringify(args);
    return this.db.transaction(() => {
      const row = this.db.query("SELECT operation,arguments,state,result FROM gateway_effects WHERE id=?").get(id) as {
        operation: string; arguments: string; state: string; result: string | null;
      } | null;
      if (row) {
        if (row.operation !== operation || row.arguments !== serialized) throw new Error("Gateway effect identity conflict");
        return { fresh: false, result: row.result === null
          ? { ok: false, error: "Gateway effect outcome uncertain", certainty: "uncertain" }
          : JSON.parse(row.result) };
      }
      this.db.query("INSERT INTO gateway_effects(id,operation,arguments,state) VALUES (?,?,?,'attempted')").run(id, operation, serialized);
      return { fresh: true, result: null };
    }).immediate();
  }
  finishEffect(id: string, result: unknown): void {
    this.db.query("UPDATE gateway_effects SET state='complete',result=? WHERE id=?").run(JSON.stringify(result), id);
  }
  token(): string {
    const existing = this.getMeta("gateway:token");
    if (existing) return existing;
    const token = createHash("sha256").update(crypto.randomUUID()).update(crypto.randomUUID()).digest("hex");
    this.setMeta("gateway:token", token);
    return token;
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close(true);
    this.lock.close(true);
  }
}
