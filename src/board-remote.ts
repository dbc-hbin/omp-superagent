import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { Board, BoardMembershipError, type BoardIdentity, type BoardNotice, type BoardPost, type BoardRead, type BoardState } from "./board";

/**
 * A worker lane's shared board is HEAD's board. Its board extension sends each
 * operation to HEAD as a stock extension UI `editor` request on the lane's own
 * RPC stream (the only stream HEAD has with that Host). HEAD answers from the
 * lane identity it verified for that stream, never from the request.
 */
export const BOARD_RPC_TITLE = "superagent-board-rpc-v1";
/** HEAD disconnected: the request fails like a missing membership, not a hang. */
const BOARD_RPC_TIMEOUT_MS = 15_000;

export type BoardRequest =
  | { op: "membership" }
  | { op: "post"; toolCallId: string; input: BoardPost }
  | { op: "read"; input: BoardRead }
  | { op: "subscribe"; channels: string[] }
  | { op: "notices" };
type BoardReply = { ok: true; value: unknown; repositoryChannel: string } | { ok: false; membership: boolean; error: string };

/** The operations the board extension uses, from a local Board or from HEAD. */
export interface BoardBackend {
  readonly repositoryChannel: string;
  membership(): Readonly<BoardIdentity> | Promise<Readonly<BoardIdentity>>;
  post(toolCallId: string, input: BoardPost): unknown;
  read(input: BoardRead): Promise<{ messages: unknown[] } & BoardState> | ({ messages: unknown[] } & BoardState);
  subscribe(channels: string[]): unknown;
  notices(): BoardNotice[] | Promise<BoardNotice[]>;
  close(): void;
}

export class LocalBoard implements BoardBackend {
  constructor(private readonly board: Board) { }
  get repositoryChannel(): string { return this.board.repositoryChannel; }
  membership() { return this.board.membership(); }
  post(toolCallId: string, input: BoardPost) { return this.board.post(toolCallId, input); }
  read(input: BoardRead) { return { messages: this.board.read(input), ...this.board.state() }; }
  subscribe(channels: string[]) { return this.board.subscribe(channels); }
  notices() { return this.board.notices(); }
  close() { this.board.close(); }
}

export class RemoteBoard implements BoardBackend {
  private constructor(private readonly ctx: ExtensionContext, readonly repositoryChannel: string) { }

  static async open(ctx: ExtensionContext): Promise<RemoteBoard> {
    const reply = await RemoteBoard.call(ctx, { op: "membership" });
    return new RemoteBoard(ctx, reply.repositoryChannel);
  }

  private static async call(ctx: ExtensionContext, request: BoardRequest): Promise<Extract<BoardReply, { ok: true }>> {
    const text = await ctx.ui.editor(BOARD_RPC_TITLE, JSON.stringify(request), { timeout: BOARD_RPC_TIMEOUT_MS });
    if (text === undefined) throw new BoardMembershipError();
    const reply = JSON.parse(text) as BoardReply;
    if (!reply.ok) throw reply.membership ? new BoardMembershipError() : new Error(reply.error);
    return reply;
  }

  async membership() { return (await RemoteBoard.call(this.ctx, { op: "membership" })).value as BoardIdentity; }
  async post(toolCallId: string, input: BoardPost) { return (await RemoteBoard.call(this.ctx, { op: "post", toolCallId, input })).value; }
  async read(input: BoardRead) {
    return (await RemoteBoard.call(this.ctx, { op: "read", input })).value as { messages: unknown[] } & BoardState;
  }
  async subscribe(channels: string[]) { return (await RemoteBoard.call(this.ctx, { op: "subscribe", channels })).value; }
  async notices() { return (await RemoteBoard.call(this.ctx, { op: "notices" })).value as BoardNotice[]; }
  close() { }
}

/** HEAD side: answer one request against the board session of the verified worker lane stream. */
export function serveBoardRequest(open: () => Board, prefill: unknown): string {
  let reply: BoardReply;
  try {
    const request = JSON.parse(String(prefill)) as BoardRequest;
    const board = new LocalBoard(open());
    const value = request.op === "membership" ? board.membership()
      : request.op === "post" ? board.post(String(request.toolCallId), request.input)
        : request.op === "read" ? board.read(request.input ?? {})
          : request.op === "subscribe" ? board.subscribe(request.channels)
            : request.op === "notices" ? board.notices()
              : (() => { throw new Error("Unknown shared board operation"); })();
    reply = { ok: true, value, repositoryChannel: board.repositoryChannel };
  } catch (error) {
    reply = {
      ok: false, membership: error instanceof BoardMembershipError,
      error: error instanceof Error ? error.message : "Shared board operation failed"
    };
  }
  return JSON.stringify(reply);
}
