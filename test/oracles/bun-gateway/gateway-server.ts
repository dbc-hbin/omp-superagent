import { chmod, lstat, unlink } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { dirname } from "node:path";
import type { Approval, Attachment, GatewayRestartRecord, GatewayRestartRequest, Inbound, MessageReference, Messenger, OutputRecord, Route, ThreadUpdate } from "../../../src/contracts";
import { DeliveryError } from "../../../src/delivery";
import { discordPurposeRequest } from "../../../src/discord-context";
import { MAX_GATEWAY_ATTACHMENT, MAX_GATEWAY_ATTACHMENT_BATCH, readGatewayJson, type GatewayResult } from "../../../src/gateway-protocol";
import { GatewayStore } from "./gateway-store";
import type { GatewayStatus } from "../../../src/gateway-wire";
import { fixtureAttachmentSpool, type AttachmentDownload } from "../../fixtures/inbound-attachments";

interface HeadClient { id: string; pid: number; ready: boolean; resumed: boolean; reconciled: boolean; events?: ServerResponse; sequence?: number; reconciliation?: string }
interface ServerOptions {
  socketPath: string;
  store: GatewayStore;
  messenger: Omit<Messenger, "openAttachment">;
  downloadAttachment?: AttachmentDownload;
  authorizeHead(pid: number): Promise<void>;
  status(): GatewayStatus;
  stop(): Promise<void>;
  restart?(request: GatewayRestartRequest): Promise<GatewayRestartRecord>;
  runRestart?(requestId: string): void;
  onError(error: unknown): void;
}

function failure(error: unknown): GatewayResult {
  return { ok: false, error: error instanceof DeliveryError ? error.message : "Gateway operation failed",
    certainty: error instanceof DeliveryError ? error.certainty : "uncertain",
    ...(error instanceof DeliveryError && error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}) };
}
function json(response: ServerResponse, value: GatewayResult, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DeliveryError("Invalid Gateway request", "rejected");
  return value as Record<string, unknown>;
}

function threadTags(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(tag => typeof tag !== "string"))
    throw new DeliveryError("Invalid thread tags", "rejected");
  return value;
}

function threadUpdate(value: unknown): ThreadUpdate {
  const update = record(value);
  if (!Object.keys(update).length || Object.keys(update).some(key => !["title", "appliedTags", "archived"].includes(key))
      || (Object.hasOwn(update, "title") && typeof update.title !== "string")
      || (Object.hasOwn(update, "archived") && typeof update.archived !== "boolean"))
    throw new DeliveryError("Invalid thread update", "rejected");
  return {
    ...(typeof update.title === "string" ? { title: update.title } : {}),
    ...(typeof update.archived === "boolean" ? { archived: update.archived } : {}),
    ...(Object.hasOwn(update, "appliedTags") ? { appliedTags: threadTags(update.appliedTags) } : {}),
  };
}

/** Ordinary-code IPC: a fixed Messenger surface, never a native RPC relay. */
export class GatewayServer {
  readonly initialReady = Promise.withResolvers<void>();
  private readonly server = createServer((request, response) => {
    void this.handle(request, response).catch(error => {
      if (!response.headersSent) json(response, failure(error), 400);
      else response.destroy();
      this.options.onError(error);
    });
  });
  private readonly peers = new Set<Socket>();
  private readonly effects = new Set<Promise<void>>();
  private readonly restartRequests = new Map<string, { request: GatewayRestartRequest; result: Promise<GatewayRestartRecord> }>();
  private readonly restartRuns = new Set<string>();
  private client?: HeadClient;
  private admissionReady = false;
  private socketIdentity?: { dev: number; ino: number };
  private closing = false;

  constructor(private readonly options: ServerOptions) {
    void this.initialReady.promise.catch(() => {});
    this.server.on("connection", socket => {
      this.peers.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => this.peers.delete(socket));
    });
  }
  get connected(): boolean { return !!this.client?.events && !this.client.events.destroyed; }
  get headReady(): boolean { return this.connected && !!this.client?.ready && !this.client.reconciliation && this.options.store.unresolved() === 0; }
  get ready(): boolean { return this.admissionReady; }

  admitMessage(input: Inbound): void {
    const fresh = this.options.store.admit({ kind: "message", input });
    if (fresh && input.messageId !== null && this.options.messenger.setActivity) {
      const message = { route: input.route, messageId: input.messageId };
      const operation = Promise.resolve().then(() => this.options.messenger.setActivity?.(message, "received"));
      this.effects.add(operation);
      void operation.catch(() => this.options.onError(new Error("Message receipt reaction failed")))
        .finally(() => this.effects.delete(operation));
    }
    this.deliver();
  }

  private openAdmission(): void {
    if (this.admissionReady) return;
    this.admissionReady = true;
    this.initialReady.resolve();
  }

  async listen(): Promise<void> {
    const opened = Promise.withResolvers<void>();
    this.server.once("error", opened.reject);
    this.server.listen(this.options.socketPath, () => opened.resolve());
    await opened.promise;
    this.server.off("error", opened.reject);
    this.server.on("error", this.options.onError);
    await chmod(this.options.socketPath, 0o600);
    const stat = await lstat(this.options.socketPath);
    this.socketIdentity = { dev: stat.dev, ino: stat.ino };
    this.options.store.setMeta("gateway:socket", JSON.stringify({ pid: process.pid, ...this.socketIdentity }));
  }

  private authenticated(request: IncomingMessage): string {
    if (request.headers.authorization !== `Bearer ${this.options.store.token()}`)
      throw new DeliveryError("Gateway head authorization required", "rejected");
    const id = request.headers["x-gateway-client"];
    if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id)) throw new DeliveryError("Invalid Gateway client", "rejected");
    return id;
  }
  private head(request: IncomingMessage): HeadClient {
    const id = this.authenticated(request);
    if (!this.client || this.client.id !== id) throw new DeliveryError("Gateway client is detached", "rejected");
    return this.client;
  }
  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const endpoint = request.url;
    if (endpoint === "/status" && request.method === "GET") {
      const status = this.options.status();
      const latest = this.options.store.getRestart();
      const { sessionFile: _, ...restart } = latest ?? {};
      json(response, { ok: true, value: { ...status, ...(latest ? { restart } : {}), gateway: { ...status.gateway, unresolvedEvents: this.options.store.unresolved() } } });
      return;
    }
    if (endpoint === "/stop" && request.method === "POST") {
      await readGatewayJson(request);
      await this.options.stop();
      json(response, { ok: true });
      return;
    }
    if (this.closing) throw new DeliveryError("Gateway is stopping", "rejected");
    if (endpoint === "/attach" && request.method === "POST") {
      const id = this.authenticated(request);
      const data = record(await readGatewayJson(request));
      if (!Number.isSafeInteger(data.pid) || Number(data.pid) < 1) throw new DeliveryError("Invalid head PID", "rejected");
      await this.options.authorizeHead(Number(data.pid));
      if (this.client && this.client.id !== id && this.connected) throw new DeliveryError("A head client is already attached", "rejected");
      if (this.client?.id === id) this.client.events?.destroy();
      const reconciled = this.client?.id === id && this.client.pid === data.pid && this.client.reconciled;
      this.client = { id, pid: Number(data.pid), ready: false, resumed: data.resumed === true, reconciled };
      json(response, { ok: true });
      return;
    }
    const client = this.head(request);
    if (endpoint === "/events" && request.method === "GET") {
      if (client.events && !client.events.destroyed) throw new DeliveryError("Head event stream already open", "rejected");
      response.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
      response.flushHeaders();
      client.events = response;
      response.on("close", () => {
        if (client.events !== response) return;
        client.events = undefined;
        client.ready = false;
        client.sequence = undefined;
      });
      this.deliver();
      return;
    }
    if (request.method !== "POST") throw new DeliveryError("Unknown Gateway operation", "rejected");
    if (endpoint === "/restart") {
      // Recheck supervised process authority before reading any caller body.
      try { await this.options.authorizeHead(client.pid); }
      catch { throw new DeliveryError("Gateway head authorization rejected", "rejected"); }
      // Native approval reconciliation belongs to this authenticated controller,
      // not to one SSE connection. Quarantine may close that stream after
      // receive durably admits a priority restart but before its async handoff.
      if (!this.admissionReady || !client.reconciled || client.reconciliation)
        throw new DeliveryError("Gateway head is not ready for restart", "rejected");
      await this.restart(record(await readGatewayJson(request)), response);
      return;
    }
    const data = record(await readGatewayJson(request));
    if (endpoint === "/ready") {
      const wasReady = client.ready;
      client.ready = true;
      if (!wasReady && client.resumed) {
        // A resumed controller's own startup gate is already resolved, but a
        // freshly authenticated adapter has no restored approval card cache.
        // Its initial admission barrier must wait for head reconciliation ACK.
        if (!this.admissionReady) client.reconciliation = crypto.randomUUID();
        this.options.store.admit({ kind: "reconnect", ...(client.reconciliation ? { barrier: client.reconciliation } : {}) });
      } else if (!client.resumed) {
        // A new controller reconciled native approvals before calling /ready.
        this.openAdmission();
      }
      if (!client.reconciliation) client.reconciled = true;
      json(response, { ok: true });
      this.deliver();
    } else if (endpoint === "/receipt") {
      if (!Number.isSafeInteger(data.sequence) || data.sequence !== client.sequence)
        throw new DeliveryError("Gateway receipt is not the outstanding event", "rejected");
      const outstanding = this.options.store.next(client.sequence)?.event;
      const barrier = outstanding?.kind === "reconnect" ? outstanding.barrier : undefined;
      if (data.outcome !== "accepted" && data.outcome !== "rejected" && data.outcome !== "unresolved")
        throw new DeliveryError("Invalid Gateway admission receipt", "rejected");
      const outcome = data.outcome;
      if (barrier && !this.admissionReady && outcome !== "accepted") {
        // Keep the durable reconciliation event pending. Never ACK fresh
        // platform approval replies against an unregistered/empty card cache.
        this.options.store.receipt(Number(data.sequence), "unresolved");
        json(response, { ok: true });
        client.events?.destroy();
        return;
      }
      this.options.store.receipt(Number(data.sequence), outcome);
      client.sequence = undefined;
      if (barrier && barrier === client.reconciliation && outcome === "accepted") {
        client.reconciliation = undefined;
        client.reconciled = true;
        this.openAdmission();
      }
      json(response, { ok: true });
      if (outcome === "unresolved") client.events?.destroy();
      else this.deliver();
    } else if (endpoint === "/detach") {
      client.events?.destroy();
      this.client = undefined;
      json(response, { ok: true });
    } else if (endpoint === "/route" || endpoint === "/history/route") {
      const messenger = this.options.messenger;
      if (!this.admissionReady || !client.ready || !client.reconciled || client.reconciliation || !messenger.assertRoute)
        throw new DeliveryError("Authenticated messenger route is not ready", "rejected");
      if (endpoint === "/route" && this.options.store.pending() !== 0) throw new DeliveryError("Gateway intake is still pending", "rejected");
      const { platform, accountId, authorityId, guildId, channelId, threadId, topicId } = record(data.route);
      if ((platform !== "discord" && platform !== "telegram" && platform !== "slack")
        || typeof accountId !== "string" || typeof authorityId !== "string" || typeof channelId !== "string"
        || guildId !== null && typeof guildId !== "string" || threadId !== null && typeof threadId !== "string"
        || topicId !== undefined && typeof topicId !== "string") throw new DeliveryError("Invalid messenger route", "rejected");
      await messenger.assertRoute({ platform, accountId, authorityId, guildId, channelId, threadId, ...(topicId === undefined ? {} : { topicId }) });
      if (this.closing || this.client !== client) throw new DeliveryError("Gateway client is detached or stopping", "rejected");
      json(response, { ok: true });
    } else if (endpoint === "/effect") {
      const task = this.effect(data, response);
      this.effects.add(task);
      try { await task; } finally { this.effects.delete(task); }
    } else if (endpoint === "/attachment") {
      await this.attachment(data, response);
    } else throw new DeliveryError("Unknown Gateway operation", "rejected");
  }

  private async restart(data: Record<string, unknown>, response: ServerResponse): Promise<void> {
    const { requestId, inputId, ackOutputId } = data;
    if (typeof requestId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(requestId)
      || typeof inputId !== "string" || !inputId.trim() || inputId.length > 1024
      || typeof ackOutputId !== "string" || !ackOutputId.trim() || ackOutputId.length > 1024)
      throw new DeliveryError("Invalid Gateway restart request", "rejected");
    if (!this.options.restart || !this.options.runRestart) throw new DeliveryError("Gateway restart is unavailable", "rejected");
    const request = { requestId, inputId, ackOutputId };
    const prior = this.options.store.getRestart(requestId);
    const pending = this.restartRequests.get(requestId);
    const identity = prior ?? pending?.request;
    const source = this.options.store.getMeta(`gateway:restart-source:${inputId}`);
    if (identity && (identity.inputId !== inputId || identity.ackOutputId !== ackOutputId) || source !== null && source !== requestId)
      throw new DeliveryError("Gateway restart identity conflict", "rejected");
    for (const entry of this.restartRequests.values()) {
      if (entry.request.inputId === inputId && entry.request.requestId !== requestId)
        throw new DeliveryError("Gateway restart identity conflict", "rejected");
    }
    let result: GatewayRestartRecord;
    try {
      if (prior) result = prior;
      else {
        if (!pending) {
          this.options.store.validateRestart(request);
          const operation = Promise.resolve().then(() => this.options.restart!(request));
          this.restartRequests.set(requestId, { request, result: operation });
        }
        try { result = await this.restartRequests.get(requestId)!.result; }
        finally { this.restartRequests.delete(requestId); }
      }
    } catch (error) {
      throw new DeliveryError("Gateway restart request failed", error instanceof DeliveryError ? error.certainty : "uncertain");
    }
    const persisted = this.options.store.getRestart(requestId);
    if (result.requestId !== requestId || result.inputId !== inputId || result.ackOutputId !== ackOutputId
      || !persisted || persisted.inputId !== inputId || persisted.ackOutputId !== ackOutputId)
      throw new DeliveryError("Gateway restart acceptance was not persisted", "uncertain");
    result = persisted;
    if (response.destroyed) return;
    if (result.state === "accepted") response.once("finish", () => {
      if (this.restartRuns.has(requestId) || this.options.store.getRestart(requestId)?.state !== "accepted") return;
      this.restartRuns.add(requestId);
      try { this.options.runRestart!(requestId); }
      catch { this.options.onError(new Error("Gateway restart execution failed")); }
    });
    json(response, { ok: true, value: result });
  }

  deliver(): void {
    const client = this.client;
    if (!client?.ready || !client.events || client.events.destroyed || client.sequence !== undefined) return;
    const event = this.options.store.next();
    if (!event) return;
    // A lost callback receipt is ambiguous even if the head disconnects before
    // processing the frame. Reconcile the original native request on redelivery.
    if (event.event.kind === "answer") this.options.store.attempt(event.sequence);
    client.sequence = event.sequence;
    client.events.write(`${JSON.stringify(event)}\n`);
  }

  private async effect(data: Record<string, unknown>, response: ServerResponse): Promise<void> {
    const { id, operation, args } = data;
    if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id) || typeof operation !== "string" || !Array.isArray(args))
      throw new DeliveryError("Invalid Gateway effect", "rejected");
    const operations: Record<string, number[]> = { send: [1], setActivity: [2], showApproval: [1], dismissApproval: [1],
      canCreateThread: [1, 2], createThread: [2, 3, 4], inspectThread: [1], updateThread: [2],
      inspectDiscordContext: [1], discordPurpose: [1], fetchAfter: [2] };
    if (!Object.hasOwn(operations, operation) || !operations[operation]!.includes(args.length))
      throw new DeliveryError("Unknown Gateway effect", "rejected");
    const previous = this.options.store.beginEffect(id, operation, args);
    if (!previous.fresh) { json(response, previous.result as GatewayResult); return; }
    let result: GatewayResult;
    try {
      const messenger = this.options.messenger;
      if (operation === "send") {
        const output = record(args[0]);
        if (output.status !== undefined && (typeof output.status !== "boolean"
          || output.status && record(output.route).platform !== "discord")) {
          throw new DeliveryError("Discord status requires a plain Discord message", "rejected");
        }
        if (output.replyTo !== undefined) {
          const reply = record(output.replyTo);
          const source = record(reply.route);
          const destination = record(output.route);
          if (destination.platform !== "discord" || typeof reply.messageId !== "string" || !/^[0-9]{1,20}$/.test(reply.messageId)
            || ["platform", "accountId", "authorityId", "guildId", "channelId", "threadId"].some(key => source[key] !== destination[key])) {
            throw new DeliveryError("Discord reply requires a real message in the exact destination conversation", "rejected");
          }
        }
      }
      if (operation === "setActivity" && args[1] !== "received" && args[1] !== "thinking" && args[1] !== "idle")
        throw new DeliveryError("Invalid message activity", "rejected");
      if (operation === "setActivity" && (typeof record(args[0]).messageId !== "string" || !record(args[0]).messageId))
        throw new DeliveryError("Message activity requires a real message ID", "rejected");
      if (operation === "inspectThread" && !messenger.inspectThread || operation === "updateThread" && !messenger.updateThread)
        throw new DeliveryError("Thread management is unsupported on this transport", "rejected");
      const purpose = operation === "discordPurpose" ? discordPurposeRequest(args[0]) : undefined;
      if (purpose) {
        this.options.store.validateDiscordPurpose(purpose);
        if (!messenger.discordPurpose) throw new DeliveryError("Discord purpose notes are unsupported", "rejected");
      }
      if (operation === "inspectDiscordContext" && !messenger.inspectDiscordContext)
        throw new DeliveryError("Discord context inspection is unsupported", "rejected");
      const value = operation === "send" ? await messenger.send(args[0] as OutputRecord)
        : operation === "setActivity" ? await messenger.setActivity?.(args[0] as MessageReference, args[1] as "received" | "thinking" | "idle")
        : operation === "showApproval" ? await messenger.showApproval(args[0] as Approval)
        : operation === "dismissApproval" ? await messenger.dismissApproval(args[0] as Approval)
        : operation === "canCreateThread" ? await messenger.canCreateThread?.(args[0] as Route, args.length === 2 ? threadTags(args[1]) : undefined) ?? false
        : operation === "createThread" ? await messenger.createThread(args[0] as Route, args[1] as string,
          args[2] == null ? undefined : args[2] as string, args.length === 4 ? threadTags(args[3]) : undefined)
        : operation === "inspectThread" ? await messenger.inspectThread?.(args[0] as Route)
        : operation === "updateThread" ? await messenger.updateThread?.(args[0] as Route, threadUpdate(args[1]))
        : operation === "inspectDiscordContext" ? await messenger.inspectDiscordContext?.(args[0] as Route)
        : purpose ? await messenger.discordPurpose?.(purpose)
        : await messenger.fetchAfter(args[0] as Route, args[1] as string);
      result = { ok: true, value };
    } catch (error) { result = failure(error); }
    // Persistence precedes the receipt; disconnection never cancels or repeats
    // a remote mutation whose outcome may already exist.
    this.options.store.finishEffect(id, result);
    if (!response.destroyed) json(response, result);
  }

  private async attachment(data: Record<string, unknown>, response: ServerResponse): Promise<void> {
    const { inputId, route, attachments } = data;
    if (typeof inputId !== "string" || !inputId || !Array.isArray(attachments) || !attachments.length || attachments.length > 10
      || Object.keys(data).some(key => !["inputId", "route", "attachments"].includes(key)))
      throw new DeliveryError("Invalid attachment request", "rejected");
    const files = attachments.map(value => record(value) as unknown as Attachment);
    let declared = 0;
    for (const attachment of files) {
      if (attachment.size !== null && (!Number.isSafeInteger(attachment.size) || attachment.size < 0 || attachment.size > MAX_GATEWAY_ATTACHMENT))
        throw new DeliveryError("Invalid attachment size", "rejected");
      declared += attachment.size ?? 0;
    }
    if (declared > MAX_GATEWAY_ATTACHMENT_BATCH) throw new DeliveryError("Attachment request exceeds the size limit", "rejected");
    const download = this.options.downloadAttachment;
    if (!download) throw new DeliveryError("Fixture is missing an attachment adapter", "rejected");
    const controller = new AbortController();
    const abort = () => controller.abort();
    response.on("close", abort);
    try {
      const receipt = await fixtureAttachmentSpool(dirname(dirname(this.options.socketPath)),
        { inputId, route: route as Route, attachments: files }, controller.signal, download);
      json(response, { ok: true, value: receipt });
    } finally { response.off("close", abort); }
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.initialReady.reject(new Error("Gateway closed before initial head readiness"));
    this.client?.events?.destroy();
    this.client = undefined;
    for (const peer of this.peers) peer.destroy();
    const closed = Promise.withResolvers<void>();
    this.server.close(() => closed.resolve());
    await closed.promise;
    await Promise.allSettled(this.effects);
    try {
      const stat = await lstat(this.options.socketPath);
      if (stat.dev === this.socketIdentity?.dev && stat.ino === this.socketIdentity.ino) await unlink(this.options.socketPath);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
