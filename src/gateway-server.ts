import { once } from "node:events";
import { chmod, lstat, unlink } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { Approval, Attachment, Messenger, OutputRecord, Route } from "./contracts";
import { DeliveryError } from "./delivery";
import { MAX_GATEWAY_ATTACHMENT, readGatewayJson, type GatewayResult } from "./gateway-protocol";
import { GatewayStore } from "./gateway-store";
import type { ManagedUlwStatus } from "./managed-ulw";

export interface GatewayStatus {
  gateway: { pid: number; ready: boolean; admissionReady: boolean; pendingEvents: number; unresolvedEvents?: number; stopping: boolean };
  head: { pid: number | null; ready: boolean; connected: boolean; socketPath: string; error: string | null };
  ulw?: ManagedUlwStatus;
}
interface HeadClient { id: string; pid: number; ready: boolean; resumed: boolean; events?: ServerResponse; sequence?: number; reconciliation?: string }
interface ServerOptions {
  socketPath: string;
  store: GatewayStore;
  messenger: Messenger;
  authorizeHead(pid: number): Promise<void>;
  status(): GatewayStatus;
  stop(): Promise<void>;
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
      json(response, { ok: true, value: { ...status, gateway: { ...status.gateway, unresolvedEvents: this.options.store.unresolved() } } });
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
      this.client = { id, pid: Number(data.pid), ready: false, resumed: data.resumed === true };
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
      json(response, { ok: true });
      this.deliver();
    } else if (endpoint === "/receipt") {
      if (!Number.isSafeInteger(data.sequence) || data.sequence !== client.sequence)
        throw new DeliveryError("Gateway receipt is not the outstanding event", "rejected");
      const outstanding = this.options.store.next()?.event;
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
        this.openAdmission();
      }
      json(response, { ok: true });
      if (outcome === "unresolved") client.events?.destroy();
      else this.deliver();
    } else if (endpoint === "/detach") {
      client.events?.destroy();
      this.client = undefined;
      json(response, { ok: true });
    } else if (endpoint === "/effect") {
      const task = this.effect(data, response);
      this.effects.add(task);
      try { await task; } finally { this.effects.delete(task); }
    } else if (endpoint === "/attachment") {
      await this.attachment(data, response);
    } else throw new DeliveryError("Unknown Gateway operation", "rejected");
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
    const operations: Record<string, number[]> = { send: [1], showApproval: [1], dismissApproval: [1], createThread: [2, 3], fetchAfter: [2] };
    if (!Object.hasOwn(operations, operation) || !operations[operation]!.includes(args.length))
      throw new DeliveryError("Unknown Gateway effect", "rejected");
    const previous = this.options.store.beginEffect(id, operation, args);
    if (!previous.fresh) { json(response, previous.result as GatewayResult); return; }
    let result: GatewayResult;
    try {
      const messenger = this.options.messenger;
      const value = operation === "send" ? await messenger.send(args[0] as OutputRecord)
        : operation === "showApproval" ? await messenger.showApproval(args[0] as Approval)
        : operation === "dismissApproval" ? await messenger.dismissApproval(args[0] as Approval)
        : operation === "createThread" ? await messenger.createThread(args[0] as Route, args[1] as string, args[2] as string | undefined)
        : await messenger.fetchAfter(args[0] as Route, args[1] as string);
      result = { ok: true, value };
    } catch (error) { result = failure(error); }
    // Persistence precedes the receipt; disconnection never cancels or repeats
    // a remote mutation whose outcome may already exist.
    this.options.store.finishEffect(id, result);
    if (!response.destroyed) json(response, result);
  }

  private async attachment(data: Record<string, unknown>, response: ServerResponse): Promise<void> {
    const attachment = record(data.attachment) as unknown as Attachment;
    if (!Number.isSafeInteger(attachment.size) || attachment.size < 0 || attachment.size > MAX_GATEWAY_ATTACHMENT)
      throw new DeliveryError("Invalid attachment size", "rejected");
    const controller = new AbortController();
    let cancelRead: (() => Promise<void>) | undefined;
    const abort = () => { controller.abort(); void cancelRead?.().catch(() => {}); };
    response.on("close", abort);
    try {
      const upstream = await this.options.messenger.openAttachment(data.route as Route, attachment, controller.signal);
      if (!upstream.body) throw new DeliveryError("Attachment response has no body", "rejected");
      const length = upstream.headers.get("content-length");
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > attachment.size))
        throw new DeliveryError("Attachment response exceeds declared size", "rejected");
      response.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
        "x-gateway-attachment-protocol": "1",
        ...(length === null ? {} : { "x-gateway-attachment-length": length }),
      });
      response.flushHeaders();
      const reader = upstream.body.getReader();
      cancelRead = () => reader.cancel();
      let bytes = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > attachment.size || bytes > MAX_GATEWAY_ATTACHMENT) throw new Error("Attachment stream exceeds declared size");
        if (!chunk.value.byteLength) continue;
        // Socket closure alone is not a completion receipt: some HTTP stacks
        // expose a destroyed response as an empty/truncated successful body.
        const frame = Buffer.allocUnsafe(4);
        frame.writeUInt32BE(chunk.value.byteLength);
        if (!response.write(frame)) await once(response, "drain", { signal: controller.signal });
        if (!response.write(chunk.value)) await once(response, "drain", { signal: controller.signal });
      }
      if (bytes !== attachment.size) throw new Error("Attachment stream was truncated");
      response.end(Buffer.alloc(4));
    } finally {
      response.off("close", abort);
      controller.abort();
      await cancelRead?.().catch(() => {});
    }
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
