import type { IncomingMessage } from "node:http";
import { Readable, Transform } from "node:stream";
import type { Config } from "./config";
import { createHash } from "node:crypto";
import type { Approval, Attachment, DiscordContext, DiscordPurposeNote, DiscordPurposeRequest, GatewayRestartRecord, GatewayRestartRequest, Inbound, MessageActivity, MessageReference, Messenger, OutputRecord, Route, ThreadInfo, ThreadUpdate } from "./contracts";
import { DeliveryError } from "./delivery";
import { gatewayCall, gatewayPaths, gatewayRequest, MAX_GATEWAY_ATTACHMENT, MAX_GATEWAY_FRAME, readGatewayJson, type GatewayResult } from "./gateway-protocol";
import type { GatewayReceipt, QueuedEvent } from "./gateway-wire";
import type { GroupReply } from "./group-policy";

export interface GatewayHeadMessenger extends Messenger {
  assertRoute(route: Route): Promise<void>;
  requestRestart(request: GatewayRestartRequest): Promise<GatewayRestartRecord>;
}

/** Transport-only head adapter. Detaching never logs out the actual accounts. */
class GatewayMessenger implements GatewayHeadMessenger {
  private readonly clientId = crypto.randomUUID();
  private readonly socketPath: string;
  private readonly token: string;
  private handlers?: Parameters<Messenger["start"]>[0];
  private events?: IncomingMessage;
  private stopped = false;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private delivery: Promise<void> = Promise.resolve();
  private intakeReady = false;
  private connecting?: Promise<void>;
  private reconnectDelay = 250;

  constructor(config: Config) {
    this.socketPath = gatewayPaths(config).socketPath;
    this.token = process.env.OMP_SUPERAGENT_GATEWAY_TOKEN ?? "";
  }

  private options() { return { token: this.token, clientId: this.clientId }; }
  private call<T>(endpoint: string, body: unknown, signal?: AbortSignal): Promise<T> {
    if (this.stopped) return Promise.reject(new DeliveryError("Gateway client is stopped", "rejected"));
    return gatewayCall<T>(this.socketPath, endpoint, body, { ...this.options(), signal });
  }

  async start(handlers: Parameters<Messenger["start"]>[0]): Promise<void> {
    if (this.handlers || this.stopped) throw new Error("Gateway messenger cannot be started twice");
    if (!this.token) throw new DeliveryError("Head was not launched by its Gateway", "rejected");
    this.handlers = handlers;
    try {
      await this.connect();
      // Return before the native-approval gate, like the actual adapters. The
      // head must attach/reconcile native UI before enabling any admission.
      void (handlers.ready ?? Promise.resolve()).then(async () => {
        if (this.stopped) return;
        this.intakeReady = true;
        await this.call("/ready", {});
      }).catch(() => { this.events?.destroy(); });
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  private connect(): Promise<void> {
    if (this.connecting) return this.connecting;
    this.connecting = this.openEvents().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }
  private async openEvents(): Promise<void> {
    await this.call("/attach", { pid: process.pid, resumed: this.intakeReady });
    const events = await gatewayRequest(this.socketPath, "/events", undefined, this.options());
    if (events.statusCode !== 200) {
      const result = await readGatewayJson(events) as GatewayResult;
      throw new DeliveryError(result.error ?? "Gateway event stream rejected", result.certainty ?? "rejected");
    }
    if (this.stopped) { events.destroy(); return; }
    this.events = events;
    void this.consume(events).catch(() => { events.destroy(); }).finally(() => {
      if (this.events !== events) return;
      this.events = undefined;
      this.scheduleReconnect();
    });
    if (this.intakeReady) await this.call("/ready", {});
  }
  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect().catch(() => { this.scheduleReconnect(); });
    }, this.reconnectDelay);
    this.reconnectTimer.unref();
  }
  private async consume(stream: IncomingMessage): Promise<void> {
    const disconnected = new AbortController();
    stream.once("close", () => disconnected.abort());
    if (stream.destroyed) disconnected.abort();
    let pending = Buffer.alloc(0);
    for await (const chunk of stream) {
      pending = Buffer.concat([pending, Buffer.from(chunk)]);
      let newline: number;
      while ((newline = pending.indexOf(10)) >= 0) {
        if (newline > MAX_GATEWAY_FRAME) throw new Error("Gateway event frame exceeds size limit");
        const frame = JSON.parse(pending.subarray(0, newline).toString("utf8")) as QueuedEvent;
        pending = pending.subarray(newline + 1);
        // Inbox IDs are deduplicated by the head. Previously attempted native
        // answers instead require exact original-state reconciliation.
        this.delivery = this.delivery.catch(() => {}).then(async () => {
          if (this.stopped || !this.handlers) return;
          disconnected.signal.throwIfAborted();
          let outcome: GatewayReceipt = "accepted";
          try {
            const event = frame.event;
            if (event.kind === "message") await this.handlers.message(event.input);
            else if (event.kind === "group") {
              if (!this.handlers.group) throw new DeliveryError("Restricted group ingress is not enabled", "rejected");
              await this.handlers.group(event.request);
            }
            else if (event.kind === "answer") {
              const reconciled = frame.reconciliation
                ? await this.handlers.reconcileAnswer?.(event.approvalId, event.route) ?? "unresolved" : "retry";
              if (reconciled === "retry") await this.handlers.answer(event.approvalId, event.response, event.route);
              else outcome = reconciled;
            }
            else if (event.kind === "restart") {
              if (!this.handlers.restart) throw new Error("Gateway restart outcome handler is unavailable");
              const { kind: _, ...notice } = event;
              await this.handlers.restart(notice);
            }
            else await this.handlers.reconnect?.();
          } catch (error) {
            outcome = error instanceof DeliveryError && error.certainty === "rejected" ? "rejected" : "unresolved";
          }
          // A handler may finish after its Gateway has been replaced. Its
          // receipt belongs only to this stream; redelivery reconciles the
          // durable outcome after reattachment instead of ACKing a new server.
          disconnected.signal.throwIfAborted();
          // A poison input stays visible and ordered without a tight retry loop.
          this.reconnectDelay = outcome === "unresolved" ? Math.min(this.reconnectDelay * 2, 30_000) : 250;
          await this.call("/receipt", { sequence: frame.sequence, outcome }, disconnected.signal);
        });
        await this.delivery;
      }
      if (pending.length > MAX_GATEWAY_FRAME) throw new Error("Gateway event frame exceeds size limit");
    }
  }

  private effect<T>(operation: string, args: unknown[]): Promise<T> {
    return this.call<T>("/effect", { id: crypto.randomUUID(), operation, args });
  }
  sendGroup(reply: GroupReply): Promise<string> {
    const hash = createHash("sha256").update(JSON.stringify(["group-reply", reply.sourceId, reply.outcome])).digest("hex");
    const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
    return this.call<string>("/effect", { id, operation: "sendGroup", args: [reply] });
  }
  requestRestart(request: GatewayRestartRequest): Promise<GatewayRestartRecord> { return this.call("/restart", request); }
  send(output: OutputRecord): Promise<string> {
    const { resultAttachment } = output;
    if (!resultAttachment) return this.effect("send", [output]);
    // Stable across client reattachment; the Gateway journals the one attempt.
    const hash = createHash("sha256").update(JSON.stringify(["result-attachment", output.id])).digest("hex");
    const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
    // The adapter needs bytes and filename, not filesystem paths or native IDs.
    return this.call<string>("/effect", { id, operation: "send", args: [{
      id: output.id, route: output.route, text: output.text, replyTo: output.replyTo, resultAttachment: resultAttachment.payload,
    }] });
  }
  assertRoute(route: Route): Promise<void> { return this.call("/route", { route }, AbortSignal.timeout(1000)); }
  setActivity(message: MessageReference, activity: MessageActivity): Promise<void> {
    return this.effect("setActivity", [{ route: message.route, messageId: message.messageId }, activity]);
  }
  showApproval(approval: Approval): Promise<string> { return this.effect("showApproval", [approval]); }
  dismissApproval(approval: Approval): Promise<void> { return this.effect("dismissApproval", [approval]); }
  canCreateThread(route: Route, appliedTags?: readonly string[]): Promise<boolean> {
    return this.effect("canCreateThread", appliedTags === undefined ? [route] : [route, appliedTags]);
  }
  createThread(route: Route, title: string, sourceMessageId?: string, appliedTags?: readonly string[]): Promise<Route> {
    return this.effect("createThread", appliedTags !== undefined ? [route, title, sourceMessageId ?? null, appliedTags]
      : sourceMessageId !== undefined ? [route, title, sourceMessageId] : [route, title]);
  }
  inspectThread(route: Route): Promise<ThreadInfo> { return this.effect("inspectThread", [route]); }
  updateThread(route: Route, update: ThreadUpdate): Promise<ThreadInfo> { return this.effect("updateThread", [route, update]); }
  inspectDiscordContext(route: Route): Promise<DiscordContext> { return this.effect("inspectDiscordContext", [route]); }
  discordPurpose(request: DiscordPurposeRequest): Promise<readonly DiscordPurposeNote[]> { return this.effect("discordPurpose", [request]); }
  fetchAfter(route: Route, messageId: string): Promise<Inbound[] | null> { return this.effect("fetchAfter", [route, messageId]); }

  async openAttachment(route: Route, attachment: Attachment, signal: AbortSignal): Promise<Response> {
    if (this.stopped) throw new DeliveryError("Gateway client is stopped", "rejected");
    if (attachment.size !== null && (!Number.isSafeInteger(attachment.size) || attachment.size < 0 || attachment.size > MAX_GATEWAY_ATTACHMENT))
      throw new DeliveryError("Invalid attachment size", "rejected");
    const incoming = await gatewayRequest(this.socketPath, "/attachment", { route, attachment }, { ...this.options(), signal });
    if (incoming.headers["x-gateway-attachment-protocol"] !== "1") {
      const result = await readGatewayJson(incoming) as GatewayResult;
      throw new DeliveryError(result.error ?? "Attachment rejected", result.certainty ?? "uncertain");
    }
    let bytes = 0;
    const header = Buffer.allocUnsafe(4);
    let headerBytes = 0;
    let remaining = 0;
    let complete = false;
    const bounded = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        let offset = 0;
        while (offset < chunk.length) {
          if (complete) { callback(new Error("Attachment data followed its completion frame")); return; }
          if (!remaining) {
            const count = Math.min(4 - headerBytes, chunk.length - offset);
            chunk.copy(header, headerBytes, offset, offset + count);
            headerBytes += count;
            offset += count;
            if (headerBytes < 4) continue;
            remaining = header.readUInt32BE();
            headerBytes = 0;
            if (!remaining) { complete = true; continue; }
            if (bytes + remaining > (attachment.size ?? MAX_GATEWAY_ATTACHMENT) || bytes + remaining > MAX_GATEWAY_ATTACHMENT) {
              callback(new Error("Attachment stream exceeds declared size"));
              return;
            }
          }
          const count = Math.min(remaining, chunk.length - offset);
          if (count) this.push(chunk.subarray(offset, offset + count));
          offset += count;
          remaining -= count;
          bytes += count;
        }
        callback();
      },
      flush(callback) {
        callback(!complete || remaining || headerBytes || attachment.size !== null && bytes !== attachment.size
          ? new Error("Attachment stream ended without a complete delivery receipt") : undefined);
      },
    });
    incoming.on("error", error => bounded.destroy(error));
    incoming.on("aborted", () => bounded.destroy(new Error("Attachment stream was interrupted")));
    bounded.on("close", () => incoming.destroy());
    incoming.pipe(bounded);
    const headers = new Headers();
    const contentType = incoming.headers["content-type"];
    const contentLength = incoming.headers["x-gateway-attachment-length"];
    if (typeof contentType === "string") headers.set("content-type", contentType);
    if (typeof contentLength === "string") headers.set("content-length", contentLength);
    return new Response(Readable.toWeb(bounded) as ReadableStream<Uint8Array>, { status: incoming.statusCode ?? 502, headers });
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    // Detach is best effort, never a messenger/server shutdown request.
    try { await this.call("/detach", {}); } catch { /* Gateway may be unavailable. */ }
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.events?.destroy();
    this.events = undefined;
    this.handlers = undefined;
  }
}

export function createGatewayMessenger(config: Config): GatewayHeadMessenger { return new GatewayMessenger(config); }
