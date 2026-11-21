import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isConfiguredRoute, type Config } from "./config";
import type { Messenger } from "./contracts";
import { DeliveryError } from "./delivery";
import { groupRoom, groupRoomKey, type GroupReply, type GroupRequest } from "./group-policy";

const schema = `
  CREATE TABLE IF NOT EXISTS group_requests (
    sequence INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, room TEXT NOT NULL, day TEXT NOT NULL,
    data TEXT NOT NULL, state TEXT NOT NULL
      CHECK(state IN ('pending','running','received','finished','failed','interrupted','revoked','receipt_blocked')),
    worktree TEXT
  );
  CREATE INDEX IF NOT EXISTS group_request_day ON group_requests(room,day);
  CREATE INDEX IF NOT EXISTS group_request_pending ON group_requests(sequence) WHERE state='pending';
  CREATE TABLE IF NOT EXISTS group_responses (
    sequence INTEGER PRIMARY KEY, id TEXT NOT NULL, outcome TEXT NOT NULL, text TEXT, remote_id TEXT,
    state TEXT NOT NULL DEFAULT 'ready' CHECK(state IN ('ready','attempted','sent','failed','uncertain')),
    UNIQUE(id,outcome)
  );
  CREATE INDEX IF NOT EXISTS group_response_ready ON group_responses(sequence) WHERE state='ready';
`;

interface SavedGroup {
  readonly id: string;
  readonly data: string;
  readonly state: "pending" | "running" | "received" | "finished" | "failed" | "interrupted" | "revoked" | "receipt_blocked";
  readonly worktree: string | null;
}

interface ResponseRow {
  readonly id: string;
  readonly data: string;
  readonly outcome: GroupReply["outcome"];
  readonly text: string | null;
}

type ResponseSettlement = "sent" | "failed" | "uncertain";

const readRequest = (row: SavedGroup | ResponseRow): GroupRequest => JSON.parse(row.data);
const databasePath = (stateDir: string) => join(stateDir, "coordination.sqlite");

/** Local operator only. Never expose request text, worktree paths or runner diagnostics as status in chat. */
export function groupRequests(stateDir: string, id?: string) {
  const file = databasePath(stateDir);
  if (!existsSync(file)) return [];
  using db = new Database(file, { readonly: true });
  const exists = db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='group_requests'").get();
  if (!exists) return [];
  const rows = id === undefined
    ? db.query<SavedGroup, []>("SELECT id,data,state,worktree FROM group_requests ORDER BY sequence DESC LIMIT 100").all()
    : db.query<SavedGroup, [string]>("SELECT id,data,state,worktree FROM group_requests WHERE id=?").all(id);
  return rows.map(row => ({
    ...readRequest(row), state: row.state, worktree: row.worktree,
    delivery: db.query<{ outcome: string; state: string; remoteId: string | null }, [string]>(
      "SELECT outcome,state,remote_id AS remoteId FROM group_responses WHERE id=? ORDER BY sequence").all(row.id),
  }));
}

export class GroupAccess {
  private readonly db: Database;
  private readonly abort = new AbortController();
  private active?: Promise<void>;
  private sending?: Promise<void>;

  constructor(private readonly config: Config, private readonly messenger: Pick<Messenger, "sendGroup">) {
    const db = new Database(databasePath(config.stateDir));
    try {
      db.exec("PRAGMA busy_timeout = 5000;");
      db.exec(schema);
      db.transaction(() => {
        // A replacement cannot know whether the previous process invoked the provider or edited a file.
        db.exec(`INSERT INTO group_responses(id,outcome)
          SELECT id,'interrupted' FROM group_requests WHERE state='running';
          UPDATE group_requests SET state='interrupted' WHERE state='running';
          UPDATE group_responses SET state='uncertain' WHERE state='attempted';
          UPDATE group_requests SET state='receipt_blocked' WHERE state='pending' AND EXISTS (
            SELECT 1 FROM group_responses WHERE group_responses.id=group_requests.id
              AND outcome='received' AND state IN ('failed','uncertain')
          );`);
      }).immediate();
    } catch (error) {
      db.close();
      throw error;
    }
    this.db = db;
  }

  private room(request: GroupRequest) {
    const route = request.route;
    if (!isConfiguredRoute(this.config, route) || route.guildId === null) return undefined;
    const room = groupRoom(this.config, route);
    return room?.revision === request.revision && room.mode === request.mode
      && room.userIds.includes(request.userId) ? room : undefined;
  }

  accept(request: GroupRequest): void {
    const room = this.room(request);
    if (!room || !request.id || !request.messageId || !request.text.trim() || Buffer.byteLength(request.text) > 4000) {
      throw new DeliveryError("Group request is not authorized", "rejected");
    }
    const key = groupRoomKey(room);
    const day = new Date().toISOString().slice(0, 10);
    this.db.transaction(() => {
      const prior = this.db.query<SavedGroup, [string]>("SELECT * FROM group_requests WHERE id=?").get(request.id);
      if (prior) {
        if (!isDeepStrictEqual(readRequest(prior), request)) throw new DeliveryError("Group request identity conflict", "rejected");
        return;
      }
      const count = this.db.query<{ count: number }, [string, string]>(
        "SELECT COUNT(*) AS count FROM group_requests WHERE room=? AND day=?").get(key, day);
      const pending = this.db.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM group_requests WHERE state IN ('pending','running')").get();
      if (!count || !pending || count.count >= room.dailyLimit || (room.mode !== "request" && pending.count >= 32)) {
        throw new DeliveryError("Group request budget exceeded", "rejected");
      }
      this.db.run("INSERT INTO group_requests(id,room,day,data,state) VALUES(?,?,?,?,?)",
        [request.id, key, day, JSON.stringify(request), room.mode === "request" ? "received" : "pending"]);
      if (room.mode !== "chat") this.db.run("INSERT INTO group_responses(id,outcome) VALUES(?,'received')", [request.id]);
    }).immediate();
  }

  /** Shared head maintenance wakes this controller; never await inference in the owner intake queue. */
  tick(allowRun: boolean, report: (error: unknown) => void): void {
    if (this.abort.signal.aborted) return;
    if (allowRun && !this.active) this.launch(report);
    if (!this.sending) this.sending = this.flush().catch(report).finally(() => { this.sending = undefined; });
  }

  get busy(): boolean { return this.active !== undefined || this.sending !== undefined; }
  get running(): boolean { return this.active !== undefined; }

  private launch(report: (error: unknown) => void): void {
    try {
      // Work needs a confirmed kickoff to the same room. Chat has no
      // intermediate message and is eligible as soon as it is admitted.
      const row = this.db.query<SavedGroup, []>(`SELECT q.* FROM group_requests q
        LEFT JOIN group_responses r ON r.id=q.id AND r.outcome='received'
        WHERE q.state='pending' AND (r.id IS NULL OR r.state='sent') ORDER BY q.sequence LIMIT 1`).get();
      if (row) this.active = this.run(readRequest(row)).catch(report).finally(() => { this.active = undefined; });
    } catch (error) { report(error); }
  }

  private async run(request: GroupRequest): Promise<void> {
    const room = this.room(request);
    if (!room || room.mode === "request") {
      this.db.run("UPDATE group_requests SET state='revoked' WHERE id=? AND state='pending'", [request.id]);
      return;
    }
    const claimed = this.db.run("UPDATE group_requests SET state='running' WHERE id=? AND state='pending'", [request.id]);
    if (claimed.changes !== 1) return;
    let outcome: "finished" | "failed" | "interrupted" = "failed";
    let text: string | null = null;
    let worktree: string | null = null;
    try {
      const entry = this.config.command[0];
      const executable = entry && (isAbsolute(entry) ? entry : Bun.which(entry));
      if (!executable) throw new Error("Group mode requires an installed stock OMP executable");
      const { runRestrictedGroup } = await import("./group-runner");
      const result = await runRestrictedGroup({
        id: request.id, mode: room.mode, model: room.model, executable, text: request.text,
        stateDir: join(this.config.stateDir, "groups"), signal: this.abort.signal,
        ...(room.mode === "work" ? { repository: room.repository } : {}),
      });
      worktree = room.mode === "work" ? result.worktree ?? null : null;
      if (room.mode === "chat" && result.ok && result.text?.trim()) {
        text = result.text.trim().slice(0, 1500).replace(/[\uD800-\uDBFF]$/, "");
      }
      if (result.ok && (room.mode === "work" ? worktree !== null : text !== null)) outcome = "finished";
    } catch {
      // Never put provider failures, process stderr, tool output or local paths on a group route.
      outcome = "failed";
    }
    if (this.abort.signal.aborted) { outcome = "interrupted"; text = null; }
    this.db.transaction(() => {
      this.db.run("UPDATE group_requests SET state=?,worktree=? WHERE id=? AND state='running'", [outcome, worktree, request.id]);
      this.db.run("INSERT INTO group_responses(id,outcome,text) VALUES(?,?,?)", [request.id, outcome, text]);
    }).immediate();
  }

  private async flush(): Promise<void> {
    for (let count = 0; count < 8 && !this.abort.signal.aborted; count++) {
      const row = this.db.query<ResponseRow, []>(`SELECT r.id,r.outcome,r.text,q.data FROM group_responses r
        INNER JOIN group_requests q ON q.id=r.id WHERE r.state='ready' ORDER BY r.sequence LIMIT 1`).get();
      if (!row) return;
      if (!this.room(readRequest(row)) || !this.messenger.sendGroup) {
        this.finishResponse(row, "failed", null);
        continue;
      }
      const claimed = this.db.run("UPDATE group_responses SET state='attempted' WHERE id=? AND outcome=? AND state='ready'", [row.id, row.outcome]);
      if (claimed.changes !== 1) continue;
      let state: ResponseSettlement = "sent";
      let remoteId: string | null = null;
      try {
        remoteId = await this.messenger.sendGroup(row.outcome === "finished"
          ? { sourceId: row.id, outcome: row.outcome, ...(row.text === null ? {} : { text: row.text }) }
          : { sourceId: row.id, outcome: row.outcome });
      } catch (error) {
        state = error instanceof DeliveryError && error.certainty === "rejected" ? "failed" : "uncertain";
      }
      this.finishResponse(row, state, remoteId);
    }
  }

  private finishResponse(row: ResponseRow, state: ResponseSettlement, remoteId: string | null): void {
    this.db.transaction(() => {
      this.db.run("UPDATE group_responses SET state=?,remote_id=? WHERE id=? AND outcome=?", [state, remoteId, row.id, row.outcome]);
      if (row.outcome === "received" && state !== "sent") {
        this.db.run("UPDATE group_requests SET state='receipt_blocked' WHERE id=? AND state='pending'", [row.id]);
      }
    }).immediate();
  }

  async stop(): Promise<void> {
    this.abort.abort();
    await Promise.allSettled([this.active, this.sending]);
    this.db.close();
  }
}
