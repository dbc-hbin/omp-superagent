import type { IncomingMessage } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import type { Config } from "../config/config";
import { createHash } from "node:crypto";
import type { Approval, DiscordContext, DiscordPurposeNote, DiscordPurposeRequest, GatewayRestartRecord, GatewayRestartRequest, Inbound, InboundAttachmentBatch, InboundAttachmentReceipt, MessageActivity, MessageReference, Messenger, OutputRecord, Route, ThreadInfo, ThreadUpdate } from "../contracts";
import { DeliveryError } from "../messaging/delivery";
import {
  gatewayCall, gatewayPaths, GatewaySocketChangedError, MAX_GATEWAY_FRAME, openGatewayEvents, parseInboundAttachmentReceipt,
  type GatewayEventConnection, type GatewaySocketIdentity,
} from "./gateway-protocol";
import type { GatewayReceipt, QueuedEvent } from "./gateway-wire";
import type { GroupReply } from "../group/group-policy";
import type { DiscordPresenceStatus, MessengerPresenceRequest } from "../contracts";

export interface GatewayHeadMessenger extends Messenger {
  assertRoute(route: Route, purpose?: "history" | "bound-work"): Promise<void>;
  requestRestart(request: GatewayRestartRequest): Promise<GatewayRestartRecord>;
}

function retryableHandshake(error: unknown): boolean {
  if (error instanceof GatewaySocketChangedError) return true;
  const cause = error instanceof DeliveryError ? error.cause : error;
  return cause instanceof Error && "code" in cause
    && ["ENOENT", "ECONNREFUSED", "ECONNRESET", "EPIPE"].includes(String(cause.code));
}

function retryableReconnect(error: unknown): boolean {
  return retryableHandshake(error) || (error instanceof DeliveryError && error.certainty === "uncertain");
}

function stableEffectId(parts: readonly string[]): string {
  const hash = createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

/** Transport-only head adapter. Detaching never logs out the actual accounts. */
class GatewayMessenger implements GatewayHeadMessenger {
  readonly managesStartupHistory = true;
  private readonly clientId = crypto.randomUUID();
  private readonly socketPath: string;
  private readonly token: string;
  private handlers?: Parameters<Messenger["start"]>[0];
  private events?: GatewayEventConnection;
  private stopped = false;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private delivery: Promise<void> = Promise.resolve();
  private intakeReady = false;
  private connecting?: Promise<void>;
  private reconnectDelay = 250;
  private readonly detach = new AbortController();
  private readonly startupSignal: AbortSignal;

  constructor(config: Config, hostShutdown?: AbortSignal) {
    this.socketPath = gatewayPaths(config).socketPath;
    this.token = process.env.OMP_SUPERAGENT_GATEWAY_TOKEN ?? "";
    this.startupSignal = hostShutdown ? AbortSignal.any([hostShutdown, this.detach.signal]) : this.detach.signal;
  }

  private options() { return { token: this.token, clientId: this.clientId }; }
  private call<T>(endpoint: string, body: unknown, signal?: AbortSignal): Promise<T> {
    if (this.stopped) return Promise.reject(new DeliveryError("Gateway client is stopped", "rejected"));
    return gatewayCall<T>(this.socketPath, endpoint, body, { ...this.options(), signal });
  }

  private markReady(expectedSocket: GatewaySocketIdentity): Promise<void> {
    return gatewayCall(this.socketPath, "/ready", {}, { ...this.options(), expectedSocket, signal: this.detach.signal });
  }

  async start(handlers: Parameters<Messenger["start"]>[0]): Promise<void> {
    if (this.handlers || this.stopped) throw new Error("Gateway messenger cannot be started twice");
    if (!this.token) throw new DeliveryError("Head was not launched by its Gateway", "rejected");
    this.handlers = handlers;
    try {
      // A reserved Host can become ready while its Gateway is being replaced.
      // Repeat only the authenticated handshake, never a handler or an effect.
      for (;;) {
        this.startupSignal.throwIfAborted();
        try { await this.connect(this.startupSignal); break; }
        catch (error) {
          if (!retryableHandshake(error)) throw error;
          await delay(this.reconnectDelay, undefined, { signal: this.startupSignal, ref: false });
        }
      }
      this.startupSignal.throwIfAborted();
      // Return before the native-approval gate, like the actual adapters. The
      // head must attach/reconcile native UI before enabling any admission.
      void (handlers.ready ?? Promise.resolve()).then(async () => {
        if (this.stopped) return;
        this.intakeReady = true;
        const events = this.events;
        // If the stream already disconnected, its replacement will send ready.
        if (!events) return;
        try { await this.markReady(events.socket); }
        catch (error) {
          if (this.events !== events) return;
          this.events = undefined;
          events.stream.destroy();
          if (retryableReconnect(error)) this.scheduleReconnect();
        }
      }, () => { this.events?.stream.destroy(); });
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  private connect(signal?: AbortSignal): Promise<void> {
    if (this.connecting) return this.connecting;
    this.connecting = this.openEvents(signal).finally(() => { this.connecting = undefined; });
    return this.connecting;
  }
  private async openEvents(signal = this.detach.signal): Promise<void> {
    const connection = await openGatewayEvents(this.socketPath, {
      ...this.options(), pid: process.pid, resumed: this.intakeReady,
      startupHistory: this.handlers?.reserveStartupHistory !== undefined, signal,
    });
    try {
      signal.throwIfAborted();
      if (this.intakeReady) await this.markReady(connection.socket);
      signal.throwIfAborted();
      if (connection.reserveHistory) this.handlers?.reserveStartupHistory?.();
    } catch (error) {
      connection.stream.destroy();
      throw error;
    }
    this.events = connection;
    void this.consume(connection.stream).catch(() => { connection.stream.destroy(); }).finally(() => {
      if (this.events !== connection) return;
      this.events = undefined;
      this.scheduleReconnect();
    });
  }
  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect().catch(error => {
        if (retryableReconnect(error)) this.scheduleReconnect();
      });
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
          let retryAfterMs = 0;
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
            else await this.handlers.reconnect?.(event.historyRecovery === true ? frame.sequence : false, event.historyPlatform);
          } catch (error) {
            outcome = error instanceof DeliveryError && error.certainty === "rejected" ? "rejected" : "unresolved";
            const retryHint = error instanceof DeliveryError ? error.retryAfterMs : undefined;
            if (outcome === "unresolved" && retryHint !== undefined && Number.isFinite(retryHint)) retryAfterMs = retryHint;
          }
          // A handler may finish after its Gateway has been replaced. Its
          // receipt belongs only to this stream; redelivery reconciles the
          // durable outcome after reattachment instead of ACKing a new server.
          disconnected.signal.throwIfAborted();
          // A poison input stays visible and ordered without a tight retry loop.
          this.reconnectDelay = outcome === "unresolved" ? Math.max(retryAfterMs, Math.min(this.reconnectDelay * 2, 30_000)) : 250;
          await this.call("/receipt", { sequence: frame.sequence, outcome }, disconnected.signal);
        });
        await this.delivery;
      }
      if (pending.length > MAX_GATEWAY_FRAME) throw new Error("Gateway event frame exceeds size limit");
    }
  }

  private effect<T>(operation: string, args: unknown[], id: string = crypto.randomUUID()): Promise<T> {
    return this.call<T>("/effect", { id, operation, args });
  }
  sendGroup(reply: GroupReply): Promise<string> {
    return this.effect("sendGroup", [reply], stableEffectId(["group-reply", reply.sourceId, reply.outcome]));
  }
  requestRestart(request: GatewayRestartRequest): Promise<GatewayRestartRecord> { return this.call("/restart", request); }
  send(output: OutputRecord): Promise<string> {
    const { resultAttachment } = output;
    if (!resultAttachment) return this.effect("send", [output]);
    // Stable across client reattachment; the Gateway journals the one attempt.
    const id = stableEffectId(["result-attachment", output.id]);
    // Transfer only a receipt; the old persisted payload is read by the Gateway
    // itself so its original attempt fingerprint can still be reconciled.
    const { payload } = resultAttachment;
    return this.effect("send", [{
      id: output.id, route: output.route, text: output.text, replyTo: output.replyTo,
      resultAttachment: "data" in payload ? { name: payload.name, legacy: true } : payload,
    }], id);
  }
  assertRoute(route: Route, purpose?: "history" | "bound-work"): Promise<void> {
    return this.call(purpose === "history" || purpose === "bound-work" ? "/history/route" : "/route", { route }, AbortSignal.timeout(1000));
  }
  setActivity(message: MessageReference, activity: MessageActivity): Promise<void> {
    return this.effect("setActivity", [{ route: message.route, messageId: message.messageId }, activity]);
  }
  showApproval(approval: Approval): Promise<string> { return this.effect("showApproval", [approval]); }
  dismissApproval(approval: Approval): Promise<void> { return this.effect("dismissApproval", [approval]); }
  canCreateThread(route: Route, appliedTags?: readonly string[], placementSource?: Route): Promise<boolean> {
    if (placementSource) return this.effect("canCreateThread", [route, appliedTags ?? null, placementSource]);
    return this.effect("canCreateThread", appliedTags === undefined ? [route] : [route, appliedTags]);
  }
  createThread(route: Route, title: string, sourceMessageId?: string, appliedTags?: readonly string[], placementSource?: Route): Promise<Route> {
    if (placementSource) {
      if (sourceMessageId !== undefined) throw new Error("Cross-channel threads cannot use a source message");
      return this.effect("createThread", [route, title, null, appliedTags ?? null, placementSource]);
    }
    return this.effect("createThread", appliedTags !== undefined ? [route, title, sourceMessageId ?? null, appliedTags]
      : sourceMessageId !== undefined ? [route, title, sourceMessageId] : [route, title]);
  }
  inspectThread(route: Route, placementSource?: Route): Promise<ThreadInfo> {
    return this.effect("inspectThread", placementSource ? [route, placementSource] : [route]);
  }
  updateThread(route: Route, update: ThreadUpdate): Promise<ThreadInfo> { return this.effect("updateThread", [route, update]); }
  inspectDiscordContext(route: Route): Promise<DiscordContext> { return this.effect("inspectDiscordContext", [route]); }
  messengerPresence(request: MessengerPresenceRequest): Promise<DiscordPresenceStatus> {
    return this.effect("messengerPresence", [request]);
  }
  discordPurpose(request: DiscordPurposeRequest): Promise<readonly DiscordPurposeNote[]> { return this.effect("discordPurpose", [request]); }
  fetchAfter(route: Route, messageId: string, historySequence?: number): Promise<Inbound[] | null> {
    return this.effect("fetchAfter", historySequence === undefined ? [route, messageId] : [route, messageId, historySequence]);
  }

  async openAttachment(batch: InboundAttachmentBatch, signal: AbortSignal): Promise<InboundAttachmentReceipt> {
    if (this.stopped) throw new DeliveryError("Gateway client is stopped", "rejected");
    const result = await gatewayCall<unknown>(this.socketPath, "/attachment", batch, {
      ...this.options(), signal, timeoutMs: 30_000 * Math.min(batch.attachments.length, 10) + 1000,
    });
    return parseInboundAttachmentReceipt(this.socketPath, batch, result);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.detach.abort();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.events?.stream.destroy();
    this.events = undefined;
    this.handlers = undefined;
    // Detach is best effort, never a messenger/server shutdown request.
    try { await gatewayCall(this.socketPath, "/detach", {}, this.options()); } catch { /* Gateway may be unavailable. */ }
  }
}

export function createGatewayMessenger(config: Config, hostShutdown?: AbortSignal): GatewayHeadMessenger {
  return new GatewayMessenger(config, hostShutdown);
}
