import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { MAX_RPC_REASSEMBLED_BYTES, RpcFrameDecoder, RpcFrameEncoder } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-frame";
import type { RpcResponse, RpcSessionState } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import type { UnitSnapshot } from "@oh-my-pi/pi-coding-agent/daemon/protocol";
import type { LanePresetSnapshot } from "./contracts";

/** Private adapter observations, not additions to the stock RPC protocol. */
export type HostState = RpcSessionState & {
  hostPid: number;
  adapterOwnerPid: number;
  adapterProtocol: "owned-stock-stdio-v1";
  readonly journalCursorVersion?: 1;
  settingsScope: "session";
  modelSettings: LanePresetSnapshot;
  hasOwnedRunningWork: boolean;
  pendingUiRequests: Record<string, unknown>[];
};
export type Frame = Record<string, unknown>;
/** Only lifecycle evidence crosses the private socket, never command lines or service logs. */
export type ServiceUnit = Pick<UnitSnapshot, "id" | "key" | "owner" |
  "startedAt" | "restartCount" | "state" | "exitedAt" | "pids" | "supervised"> & {
    readonly generation?: UnitSnapshot["generation"];
  };
export type Response = Frame & { success: boolean; data?: unknown; error?: string };
export type HostResponse = RpcResponse | {
  type: "response"; id?: string; command: "shutdown_host" | "set_model_preset" | "get_host_admission"; success: true; data: Frame;
} | {
  type: "response"; id?: string; command: "set_host_message_updates"; success: true;
  data: { readonly messageUpdates: "full" | "activity-v1" };
} | {
  type: "response"; id?: string; command: "get_journal_cursor"; success: true;
  data: { readonly leafId: string | null };
} | {
  type: "response"; id?: string; command: string; success: false; error: string; code?: string;
};
export class HostRequestTimeout extends Error {
  constructor() { super("Host request timed out; its outcome may be unknown"); }
}

export const serviceGenerationKey = (value: Frame | ServiceUnit) =>
  JSON.stringify([value.owner, value.id, value.generation, value.startedAt, value.restartCount]);

const hasValidGeneration = (daemon: Frame | ServiceUnit) =>
  !("generation" in daemon) || typeof daemon.generation === "string" && daemon.generation.length > 0;
const isFrame = (value: unknown): value is Frame => value !== null && typeof value === "object";
const isTerminal = (state: unknown): state is "exited" | "failed" => state === "exited" || state === "failed";

function launchCompletions(value: unknown): readonly unknown[] | undefined {
  if (!isFrame(value) || value.type !== "custom_message" || value.customType !== "launch-completion") return;
  return isFrame(value.details) && Array.isArray(value.details.daemons) ? value.details.daemons : undefined;
}

function serviceExitKey({ owner, id, generation, startedAt, restartCount, exitedAt }: Frame | ServiceUnit): string | undefined {
  if (typeof owner !== "string" || typeof id !== "string"
    || generation !== undefined && (typeof generation !== "string" || !generation)
    || typeof startedAt !== "number" || typeof restartCount !== "number" || typeof exitedAt !== "number"
    || Number.isNaN(startedAt) || Number.isNaN(restartCount) || Number.isNaN(exitedAt)) return undefined;
  // Keep numeric equality exact; JSON number encoding would collapse non-finite
  // timestamps into null. A legacy completion has no generation string.
  return JSON.stringify([owner, id, generation, String(startedAt), String(restartCount), String(exitedAt)]);
}

/** Positive native journal evidence for this exact terminal service generation. */
export function serviceCompletionRecorded(daemon: Frame, entries: readonly unknown[]): boolean {
  const key = serviceExitKey(daemon);
  if (key === undefined || !hasValidGeneration(daemon) || !isTerminal(String(daemon.state))) return false;
  return entries.some(entry => launchCompletions(entry)?.some(observed => isFrame(observed)
    && observed.state === daemon.state && serviceExitKey(observed) === key));
}

/** Builds proof for the current observation only, from one native transcript. */
export function indexServiceCompletions(entries: readonly unknown[]) {
  const byGeneration = new Set<string>();
  const exact = { exited: new Set<string>(), failed: new Set<string>() };
  let generationEvidenceBlocked = false;
  for (const entry of entries) {
    const daemons = launchCompletions(entry);
    if (!daemons) continue;
    for (const observed of daemons) {
      // The historical generation lookup could not cross an unreadable row.
      if (observed === null || observed === undefined) generationEvidenceBlocked = true;
      if (!isFrame(observed) || !isTerminal(observed.state)) continue;
      const key = serviceExitKey(observed);
      if (key === undefined) continue;
      exact[observed.state].add(key);
      if (!generationEvidenceBlocked && hasValidGeneration(observed)) byGeneration.add(serviceGenerationKey(observed));
    }
  }
  return {
    hasGeneration: (key: string) => byGeneration.has(key),
    hasCompletion: (daemon: Frame | ServiceUnit) => {
      if (!isTerminal(daemon.state) || !hasValidGeneration(daemon)) return false;
      const key = serviceExitKey(daemon);
      return key !== undefined && exact[daemon.state].has(key);
    },
  };
}

/** Public native JSONL/v2 framing, with correlation owned by this adapter. */
export class HostChannel extends EventEmitter {
  readonly pending = new Map<string, {
    resolve(value: Response): void; reject(error: Error): void; timer?: ReturnType<typeof setTimeout>;
  }>();
  readonly exited: Promise<void>;
  readonly ready = Promise.withResolvers<void>();
  readonly encoder = new RpcFrameEncoder();
  #closed = false;
  constructor(readonly input: Readable, readonly output: Writable, readonly framed = false) {
    super();
    const closed = Promise.withResolvers<void>();
    this.exited = closed.promise;
    const decoder = new RpcFrameDecoder();
    const text = new StringDecoder("utf8");
    let buffer = "";
    input.on("data", (chunk: string | Buffer) => {
      try {
        buffer += typeof chunk === "string" ? chunk : text.write(chunk);
        if (Buffer.byteLength(buffer) > MAX_RPC_REASSEMBLED_BYTES) throw new Error("Host frame backlog exceeded its bound");
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          if (!line) continue;
          const decoded = decoder.push(JSON.parse(line));
          if (!decoded) continue;
          const frame = decoded as Frame;
          if (frame.type === "ready") this.ready.resolve();
          if (frame.type === "response" && typeof frame.id === "string") {
            const request = this.pending.get(frame.id);
            if (request) {
              this.pending.delete(frame.id);
              clearTimeout(request.timer);
              request.resolve(frame as Response);
            }
          }
          this.emit("frame", frame);
        }
      } catch (error) { this.destroy(error instanceof Error ? error : new Error(String(error))); }
    });
    const finish = () => {
      if (this.#closed) return;
      this.#closed = true;
      const error = new Error("Host disconnected; request outcome may be unknown");
      this.ready.reject(error);
      for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
      this.pending.clear();
      closed.resolve();
    };
    void this.ready.promise.catch(() => {});
    input.on("error", finish);
    input.on("end", finish);
    input.on("close", finish);
    output.on("error", finish);
  }
  send(frame: Frame): void {
    if (this.#closed || this.output.destroyed) throw new Error("Host is disconnected");
    for (const data of this.framed ? this.encoder.encodeFrames(frame) : [`${JSON.stringify(frame)}\n`]) {
      // Include protocol-v2 base64/chunk overhead within a bounded wire queue.
      if (Buffer.byteLength(data) + this.output.writableLength > MAX_RPC_REASSEMBLED_BYTES * 2) {
        this.destroy(new Error("Host write backlog exceeded its bound"));
        throw new Error("Host write backlog exceeded its bound");
      }
      this.output.write(data);
    }
  }
  request(frame: Frame, id: string = crypto.randomUUID(), timeoutMs = 10_000): Promise<Response> {
    if (this.pending.has(id)) throw new Error(`Request ${id} is already outstanding`);
    if (Buffer.byteLength(JSON.stringify(frame)) > 16 * 1024 * 1024) {
      this.destroy();
      return Promise.reject(new Error("Host write backlog exceeded its bound"));
    }
    const result = Promise.withResolvers<Response>();
    const timer = timeoutMs > 0 ? setTimeout(() => {
      this.pending.delete(id);
      result.reject(new HostRequestTimeout());
    }, timeoutMs) : undefined;
    timer?.unref();
    this.pending.set(id, { ...result, timer });
    try { this.send({ ...frame, id }); }
    catch (error) { this.pending.delete(id); clearTimeout(timer); result.reject(error); }
    return result.promise;
  }
  destroy(error?: Error): void {
    this.input.destroy(error);
    this.output.destroy();
  }
}
