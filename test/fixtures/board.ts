import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Board, boardRepositoryChannel } from "../../src/board";
import { Store } from "../../src/store";

/** Real independent SQLite connections sharing the production coordination file. */
export class BoardFixture {
  readonly directory = realpathSync(mkdtempSync(join(tmpdir(), "omp-board-")));
  readonly path = join(this.directory, "coordination.sqlite");
  readonly channel = boardRepositoryChannel(this.directory);
  readonly otherChannel: string;
  readonly store = new Store(this.path);
  private readonly boards: Board[] = [];

  constructor() {
    const other = join(this.directory, "other-repository");
    mkdirSync(other);
    this.otherChannel = boardRepositoryChannel(other);
  }

  open(actor: string, sessionId = `${actor}-session`, repositoryChannel = this.channel): Board {
    const sessionFile = this.bind(actor, sessionId);
    const board = new Board(this.path, { actor, role: actor === "head" ? "head" : "lane", sessionId }, repositoryChannel, sessionFile);
    this.boards.push(board);
    return board;
  }

  bind(actor: string, sessionId: string): string {
    const sessionFile = join(this.directory, "sessions", actor === "head" ? "main" : actor, "session.jsonl");
    mkdirSync(dirname(sessionFile), { recursive: true });
    writeFileSync(sessionFile, JSON.stringify({ type: "session", id: sessionId }) + "\n");
    if (actor === "head") {
      this.store.setMeta("main:sessionId", sessionId);
      this.store.setMeta("gateway:head", JSON.stringify({ pid: process.pid, sessionId, sessionFile, dev: 0, ino: 0 }));
      return sessionFile;
    }
    const existing = this.store.lane(actor);
    if (existing) {
      this.store.updateLane(actor, existing.generation, { sessionId, pid: process.pid, runtimeState: "idle", workState: "open" });
      return sessionFile;
    }
    const route = { platform: "discord" as const, accountId: "fixture", authorityId: "owner", guildId: null,
      channelId: actor, threadId: null };
    const sourceId = `board-source-${actor}`;
    this.store.receive({ id: sourceId, messageId: sourceId, route, text: "Bound board fixture", receivedAt: Date.now(), attachments: [] }, null);
    this.store.createLane({ id: actor, route, title: "Board fixture", cwd: this.directory, repoRoot: this.directory,
      model: { provider: "fixture", id: "fixture" }, modelReason: "Deterministic local board fixture",
      modelPreset: null, modelPresetSnapshot: null, brief: "Board fixture", acceptance: ["Real SQLite membership"],
      workState: "open", runtimeState: "idle", sessionFile, sessionId, socketPath: join(this.directory, `${actor}.sock`),
      generation: 0, pid: process.pid, createdAt: Date.now(), lastActivityAt: Date.now(), result: null }, sourceId);
    return sessionFile;
  }

  close(): void {
    for (const board of this.boards) board.close();
    this.store.close();
    rmSync(this.directory, { recursive: true, force: true });
  }
}
