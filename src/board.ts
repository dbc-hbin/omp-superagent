import { Database } from "bun:sqlite";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { Lane } from "./contracts";

export interface BoardIdentity {
  role: "head" | "lane";
  actor: string;
  sessionId: string;
}

export interface BoardMessage extends BoardIdentity {
  id: number;
  channel: string;
  thread: number;
  replyTo: number | null;
  text: string;
  mentions: string[];
  createdAt: number;
}

export interface BoardPost {
  text: string;
  channel?: string;
  replyTo?: number;
  mentions?: string[];
}

export interface BoardRead {
  channel?: string;
  thread?: number;
  after?: number;
  limit?: number;
  unreadOnly?: boolean;
}

export type BoardNotice = Omit<BoardMessage, "text">;

export interface BoardState {
  identity: BoardIdentity;
  /** Contiguous prefix of bodies actually returned to this session. */
  readCursor: number;
  /** Highest delivered header only; sparse receipts, not this cursor, select notices. */
  noticeCursor: number;
  subscriptions: string[];
  channels: string[];
}

export class BoardMembershipError extends Error {
  constructor() { super("This native session is not currently connected to this superagent's shared board"); }
}

function canonicalSessionFile(path: string): string {
  try {
    return existsSync(path) ? realpathSync(path) : join(realpathSync(dirname(path)), basename(path));
  } catch {
    throw new BoardMembershipError();
  }
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS board_sessions (
    session_id TEXT PRIMARY KEY, actor TEXT NOT NULL, role TEXT NOT NULL,
    read_cursor INTEGER NOT NULL DEFAULT 0, notice_cursor INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS board_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES board_sessions(session_id),
    actor TEXT NOT NULL, role TEXT NOT NULL, tool_call_id TEXT NOT NULL,
    channel TEXT NOT NULL, thread INTEGER NOT NULL,
    reply_to INTEGER REFERENCES board_messages(id), text TEXT NOT NULL,
    mentions TEXT NOT NULL, created_at INTEGER NOT NULL,
    UNIQUE(session_id, tool_call_id)
  );
  CREATE INDEX IF NOT EXISTS board_channel_order ON board_messages(channel, id);
  CREATE INDEX IF NOT EXISTS board_thread_order ON board_messages(thread, id);
  CREATE TABLE IF NOT EXISTS board_mentions (
    message_id INTEGER NOT NULL REFERENCES board_messages(id), actor TEXT NOT NULL,
    PRIMARY KEY(message_id, actor)
  );
  CREATE TABLE IF NOT EXISTS board_subscriptions (
    session_id TEXT NOT NULL REFERENCES board_sessions(session_id), channel TEXT NOT NULL,
    PRIMARY KEY(session_id, channel)
  );
  CREATE TABLE IF NOT EXISTS board_receipts (
    session_id TEXT NOT NULL REFERENCES board_sessions(session_id),
    message_id INTEGER NOT NULL REFERENCES board_messages(id),
    read_at INTEGER, noticed_at INTEGER,
    PRIMARY KEY(session_id, message_id)
  );
`;

interface MessageRow {
  id: number;
  session_id: string;
  actor: string;
  role: BoardIdentity["role"];
  channel: string;
  thread: number;
  reply_to: number | null;
  text: string;
  mentions: string;
  created_at: number;
}

const message = (row: MessageRow): BoardMessage => ({
  id: row.id, sessionId: row.session_id, actor: row.actor, role: row.role,
  channel: row.channel, thread: row.thread, replyTo: row.reply_to,
  text: row.text, mentions: JSON.parse(row.mentions) as string[], createdAt: row.created_at,
});

function actorName(value: string): void {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new Error("Invalid board actor");
}

function channelName(value: string): void {
  if (value === "general") return;
  if (typeof value !== "string" || !value.startsWith("repo:") || value.length > 4096 ||
      value.includes("\0") || !isAbsolute(value.slice(5)) || resolve(value.slice(5)) !== value.slice(5)) {
    throw new Error("Board channel must be general or repo:<canonical absolute repository path>");
  }
}

function position(value: number, name: string, minimum = 1): void {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`Invalid board ${name}`);
}

function pageSize(value = 50): number {
  position(value, "limit");
  if (value > 100) throw new Error("Board limit must be at most 100");
  return value;
}

/** The caller resolves the Git root first; channel names never execute Git or message content. */
export function boardRepositoryChannel(repository: string): string {
  const channel = `repo:${realpathSync(repository)}`;
  channelName(channel);
  return channel;
}

/**
 * Independent multi-writer connection to the local coordination ledger. Identity
 * comes from the native host/session, never from tool parameters or message text.
 */
export class Board {
  private readonly db: Database;
  private readonly identity: Readonly<BoardIdentity>;
  private readonly stateDirectory: string;
  private readonly sessionFile: string;
  private readonly generation: number;
  private closed = false;

  constructor(path: string, identity: BoardIdentity, readonly repositoryChannel: string, sessionFile: string) {
    actorName(identity.actor);
    if ((identity.role !== "head" && identity.role !== "lane") ||
        (identity.role === "head") !== (identity.actor === "head")) throw new Error("Invalid board role identity");
    if (typeof identity.sessionId !== "string" || !identity.sessionId || identity.sessionId.length > 1024) {
      throw new Error("A native session ID is required for the board");
    }
    channelName(repositoryChannel);
    if (!repositoryChannel.startsWith("repo:")) throw new Error("A repository board channel is required");
    this.identity = Object.freeze({ role: identity.role, actor: identity.actor, sessionId: identity.sessionId });
    // Never register membership or create an instance on tool access. Only the
    // existing runtime's authoritative host/lane records can admit a session.
    if (!existsSync(path) || typeof sessionFile !== "string" || !isAbsolute(sessionFile)) throw new BoardMembershipError();
    path = realpathSync(path);
    this.stateDirectory = dirname(path);
    this.sessionFile = canonicalSessionFile(sessionFile);
    const db = new Database(path, { create: false, strict: true });
    try {
      this.db = db;
      db.run("PRAGMA busy_timeout = 5000");
      this.generation = this.requireMembership();
      db.run("PRAGMA journal_mode = WAL");
      db.run("PRAGMA synchronous = FULL");
      db.run("PRAGMA foreign_keys = ON");
      db.run(SCHEMA);
      db.transaction(() => {
        this.requireMembership();
        const existing = db.query("SELECT actor, role FROM board_sessions WHERE session_id = ?")
          .get(this.identity.sessionId) as { actor: string; role: string } | null;
        if (existing) {
          if (existing.actor !== this.identity.actor || existing.role !== this.identity.role) {
            throw new Error("Native board session identity conflict");
          }
          return;
        }
        db.query("INSERT INTO board_sessions(session_id, actor, role) VALUES (?, ?, ?)")
          .run(this.identity.sessionId, this.identity.actor, this.identity.role);
        for (const channel of ["general", repositoryChannel]) {
          db.query("INSERT INTO board_subscriptions(session_id, channel) VALUES (?, ?)")
            .run(this.identity.sessionId, channel);
        }
      }).immediate();
    } catch (error) {
      db.close(true);
      throw error;
    }
  }

  post(toolCallId: string, input: BoardPost): BoardMessage {
    if (typeof toolCallId !== "string" || !toolCallId || toolCallId.length > 1024) throw new Error("A native tool call ID is required");
    if (typeof input.text !== "string" || !input.text.trim() || input.text.length > 16000) {
      throw new Error("Board text must contain 1..16000 characters");
    }
    if (input.replyTo !== undefined) position(input.replyTo, "reply parent");
    if (input.mentions !== undefined && (!Array.isArray(input.mentions) || input.mentions.length > 32)) {
      throw new Error("Board mentions must be an array of at most 32 actor IDs");
    }
    const mentions = [...new Set(input.mentions ?? [])].sort();
    for (const actor of mentions) actorName(actor);
    return this.db.transaction(() => {
      this.requireMembership();
      const parent = input.replyTo === undefined ? null : this.get(input.replyTo);
      if (input.replyTo !== undefined && !parent) throw new Error("Board reply parent does not exist");
      const channel = input.channel ?? parent?.channel ?? this.repositoryChannel;
      channelName(channel);
      if (parent && parent.channel !== channel) throw new Error("A board reply must stay in its parent's channel");
      const existing = this.db.query("SELECT * FROM board_messages WHERE session_id = ? AND tool_call_id = ?")
        .get(this.identity.sessionId, toolCallId) as MessageRow | null;
      if (existing) {
        if (existing.channel !== channel || existing.reply_to !== (input.replyTo ?? null) ||
            existing.text !== input.text || existing.mentions !== JSON.stringify(mentions)) {
          throw new Error("Board tool call identity conflict");
        }
        return message(existing);
      }
      const inserted = this.db.query(`INSERT INTO board_messages
        (session_id, actor, role, tool_call_id, channel, thread, reply_to, text, mentions, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
        .get(this.identity.sessionId, this.identity.actor, this.identity.role, toolCallId, channel,
          parent?.thread ?? 0, parent?.id ?? null, input.text, JSON.stringify(mentions), Date.now()) as { id: number };
      if (!parent) this.db.query("UPDATE board_messages SET thread = id WHERE id = ?").run(inserted.id);
      for (const actor of mentions) {
        this.db.query("INSERT INTO board_mentions(message_id, actor) VALUES (?, ?)").run(inserted.id, actor);
      }
      // The author receives this exact post as its tool result, not its parent or skipped messages.
      this.markRead([inserted.id]);
      return this.get(inserted.id)!;
    }).immediate();
  }

  read(input: BoardRead = {}): BoardMessage[] {
    const limit = pageSize(input.limit);
    if (input.channel !== undefined) channelName(input.channel);
    if (input.thread !== undefined) position(input.thread, "thread");
    if (input.after !== undefined) position(input.after, "after position", 0);
    return this.db.transaction(() => {
      this.requireMembership();
      const rows = this.db.query(`SELECT m.* FROM board_messages m
        LEFT JOIN board_receipts r ON r.message_id = m.id AND r.session_id = ?
        WHERE m.id > ? AND (? IS NULL OR m.channel = ?) AND (? IS NULL OR m.thread = ?)
          AND (? = 0 OR r.read_at IS NULL) ORDER BY m.id LIMIT ?`)
        .all(this.identity.sessionId, input.after ?? 0, input.channel ?? null, input.channel ?? null,
          input.thread ?? null, input.thread ?? null, input.unreadOnly === false ? 0 : 1, limit) as MessageRow[];
      this.markRead(rows.map(row => row.id));
      return rows.map(message);
    }).immediate();
  }

  subscribe(channels: string[]): BoardState {
    if (!Array.isArray(channels) || channels.length > 128) throw new Error("Board subscriptions must contain at most 128 channels");
    const unique = [...new Set(channels)].sort();
    for (const channel of unique) channelName(channel);
    this.db.transaction(() => {
      this.requireMembership();
      this.db.query("DELETE FROM board_subscriptions WHERE session_id = ?").run(this.identity.sessionId);
      for (const channel of unique) {
        this.db.query("INSERT INTO board_subscriptions(session_id, channel) VALUES (?, ?)")
          .run(this.identity.sessionId, channel);
      }
    }).immediate();
    return this.state();
  }

  /** Header delivery is independent of reading. No timers, callbacks, or executor live here. */
  notices(limit = 50): BoardNotice[] {
    pageSize(limit);
    return this.db.transaction(() => {
      this.requireMembership();
      const rows = this.db.query(`SELECT m.* FROM board_messages m
        LEFT JOIN board_receipts r ON r.message_id = m.id AND r.session_id = ?
        WHERE m.actor != ? AND r.read_at IS NULL AND r.noticed_at IS NULL AND (
          (? = 'head' AND m.role = 'lane') OR (? = 'lane' AND (
            EXISTS (SELECT 1 FROM board_mentions n WHERE n.message_id = m.id AND n.actor = ?) OR
            EXISTS (SELECT 1 FROM board_subscriptions s WHERE s.session_id = ? AND s.channel = m.channel)
          ))) ORDER BY m.id LIMIT ?`)
        .all(this.identity.sessionId, this.identity.actor, this.identity.role, this.identity.role,
          this.identity.actor, this.identity.sessionId, limit) as MessageRow[];
      const now = Date.now();
      for (const row of rows) {
        this.db.query(`INSERT INTO board_receipts(session_id, message_id, noticed_at) VALUES (?, ?, ?)
          ON CONFLICT(session_id, message_id) DO UPDATE SET noticed_at = excluded.noticed_at`)
          .run(this.identity.sessionId, row.id, now);
      }
      if (rows.length) {
        this.db.query("UPDATE board_sessions SET notice_cursor = MAX(notice_cursor, ?) WHERE session_id = ?")
          .run(rows[rows.length - 1]!.id, this.identity.sessionId);
      }
      return rows.map(row => {
        const { text: _text, ...header } = message(row);
        return header;
      });
    }).immediate();
  }

  state(): BoardState {
    this.requireMembership();
    const row = this.db.query("SELECT read_cursor, notice_cursor FROM board_sessions WHERE session_id = ?")
      .get(this.identity.sessionId) as { read_cursor: number; notice_cursor: number };
    const subscriptions = this.db.query("SELECT channel FROM board_subscriptions WHERE session_id = ? ORDER BY channel")
      .all(this.identity.sessionId) as Array<{ channel: string }>;
    const channels = this.db.query("SELECT DISTINCT channel FROM board_messages ORDER BY channel")
      .all() as Array<{ channel: string }>;
    return { identity: { ...this.identity }, readCursor: row.read_cursor, noticeCursor: row.notice_cursor,
      subscriptions: subscriptions.map(item => item.channel),
      channels: [...new Set(["general", this.repositoryChannel, ...channels.map(item => item.channel)])].sort() };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private get(id: number): BoardMessage | null {
    const row = this.db.query("SELECT * FROM board_messages WHERE id = ?").get(id) as MessageRow | null;
    return row ? message(row) : null;
  }

  private requireMembership(): number {
    if (this.closed) throw new BoardMembershipError();
    let generation: number;
    const tables = this.db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('metadata', 'lanes')")
      .all() as Array<{ name: string }>;
    if (this.identity.role === "head") {
      if (!tables.some(table => table.name === "metadata")) throw new BoardMembershipError();
      const session = this.db.query("SELECT value FROM metadata WHERE key = 'main:sessionId'")
        .get() as { value: string } | null;
      const currentGeneration = this.db.query("SELECT value FROM metadata WHERE key = 'main:generation'")
        .get() as { value: string } | null;
      const owner = this.db.query("SELECT value FROM metadata WHERE key = 'gateway:head'")
        .get() as { value: string } | null;
      let ownedHead: { pid?: number; sessionId?: string; sessionFile?: string } | null;
      try { ownedHead = JSON.parse(owner?.value ?? "null"); }
      catch { throw new BoardMembershipError(); }
      // main:sessionId and its file survive shutdown. Only the actual process
      // still owned by this Gateway is a member, not a standalone resumed copy.
      // Keep that process admitted during a transient Gateway disconnection.
      if (!ownedHead || ownedHead.pid !== process.pid || ownedHead.sessionId !== this.identity.sessionId ||
          typeof ownedHead.sessionFile !== "string" || canonicalSessionFile(ownedHead.sessionFile) !== this.sessionFile) {
        throw new BoardMembershipError();
      }
      if (session?.value !== this.identity.sessionId || this.sessionFile !==
          canonicalSessionFile(join(this.stateDirectory, "sessions", "main", "session.jsonl"))) throw new BoardMembershipError();
      generation = Number(currentGeneration?.value ?? "0");
    } else {
      if (!tables.some(table => table.name === "lanes")) throw new BoardMembershipError();
      const row = this.db.query("SELECT generation, data FROM lanes WHERE id = ?")
        .get(this.identity.actor) as { generation: number; data: string } | null;
      if (!row) throw new BoardMembershipError();
      const lane = JSON.parse(row.data) as Lane;
      if (lane.id !== this.identity.actor || lane.sessionId !== this.identity.sessionId ||
          canonicalSessionFile(lane.sessionFile) !== this.sessionFile || lane.pid !== process.pid ||
          (lane.workState !== "open" && lane.workState !== "paused") ||
          (lane.runtimeState !== "running" && lane.runtimeState !== "idle") || lane.generation !== row.generation) {
        throw new BoardMembershipError();
      }
      generation = row.generation;
    }
    if (!Number.isSafeInteger(generation) || generation < 0 ||
        (this.generation !== undefined && generation !== this.generation)) throw new BoardMembershipError();
    return generation;
  }

  private markRead(ids: number[]): void {
    if (!ids.length) return;
    const now = Date.now();
    for (const id of ids) {
      this.db.query(`INSERT INTO board_receipts(session_id, message_id, read_at) VALUES (?, ?, ?)
        ON CONFLICT(session_id, message_id) DO UPDATE SET read_at = excluded.read_at`)
        .run(this.identity.sessionId, id, now);
    }
    // Only a contiguous, exactly observed prefix advances the read cursor. Filters,
    // pagination, replies and a high notice cursor cannot acknowledge unseen gaps.
    const gap = this.db.query(`SELECT MIN(m.id) AS id FROM board_messages m
      LEFT JOIN board_receipts r ON r.message_id = m.id AND r.session_id = ?
      WHERE m.id > (SELECT read_cursor FROM board_sessions WHERE session_id = ?) AND r.read_at IS NULL`)
      .get(this.identity.sessionId, this.identity.sessionId) as { id: number | null };
    const end = gap.id === null
      ? (this.db.query("SELECT COALESCE(MAX(id), 0) AS id FROM board_messages").get() as { id: number }).id
      : gap.id - 1;
    this.db.query("UPDATE board_sessions SET read_cursor = MAX(read_cursor, ?) WHERE session_id = ?")
      .run(end, this.identity.sessionId);
  }
}
