import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../src/config";
import type { Approval, Attachment, Inbound, Messenger, OutputRecord, Route } from "../src/contracts";
import { DeliveryError } from "../src/delivery";
import { createGatewayMessenger } from "../src/gateway-client";
import { gatewayCall, gatewayPaths, gatewayRequest } from "../src/gateway-protocol";
import { GatewayServer, type GatewayStatus } from "../src/gateway-server";
import { GatewayStore } from "../src/gateway-store";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const route: Route = { platform: "slack", accountId: "B1", authorityId: "T1", guildId: null, channelId: "D1", threadId: null };
function input(id: string): Inbound {
  return { id, route, messageId: id, text: `message ${id}`, receivedAt: 123, attachments: [] };
}
async function eventually(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Gateway fixture condition timed out");
    await Bun.sleep(5);
  }
}

class FakeMessenger implements Messenger {
  handlers?: Parameters<Messenger["start"]>[0];
  readonly sends: OutputRecord[] = [];
  readonly approvals = new Set<string>();
  stopped = false;
  sendFailure?: DeliveryError;
  download?: (signal: AbortSignal) => Response;
  async start(handlers: Parameters<Messenger["start"]>[0]) { this.handlers = handlers; }
  async send(output: OutputRecord) {
    this.sends.push(output);
    if (this.sendFailure) throw this.sendFailure;
    return "remote-message";
  }
  async showApproval(approval: Approval) { this.approvals.add(approval.id); return "remote-approval"; }
  async dismissApproval(approval: Approval) { this.approvals.delete(approval.id); }
  async createThread(destination: Route, _title: string) { return { ...destination, threadId: "thread" }; }
  async fetchAfter(_route: Route, _id: string): Promise<Inbound[] | null> { return null; }
  async openAttachment(_route: Route, _attachment: Attachment, signal: AbortSignal) {
    return this.download?.(signal) ?? new Response("data");
  }
  async stop() { this.stopped = true; }
  async emit(message: Inbound) {
    await this.handlers!.ready;
    await this.handlers!.message(message);
  }
  async answerCard(approval: Approval) {
    await this.handlers!.ready;
    if (!this.approvals.has(approval.id)) throw new DeliveryError("Approval card is not registered", "rejected");
    await this.handlers!.answer(approval.id, { confirmed: true }, approval.route);
  }
}

async function fixture() {
  const root = await mkdtemp(join(await realpath("/tmp"), "ogw-"));
  await mkdir(join(root, "run"), { mode: 0o700 });
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const config: Config = { path: join(root, "config.json"), stateDir: root, headCwd: root,
    command: ["unused"], maxHosts: 2, maxSubagents: 4, idleMs: 1000 };
  const store = new GatewayStore(root);
  cleanups.push(async () => store.close());
  const messenger = new FakeMessenger();
  let stopRequests = 0;
  const server = new GatewayServer({ socketPath: gatewayPaths(config).socketPath, store, messenger,
    authorizeHead: async pid => { if (pid !== process.pid) throw new DeliveryError("Foreign native owner", "rejected"); },
    status: (): GatewayStatus => ({ gateway: { pid: process.pid, ready: true, admissionReady: server.ready,
      pendingEvents: store.pending(), stopping: false }, head: { pid: process.pid, ready: server.headReady,
      connected: server.connected, socketPath: join(root, "run", "main.sock"), error: null } }),
    stop: async () => { stopRequests++; }, onError: () => {},
  });
  await server.listen();
  cleanups.push(() => server.close());
  await messenger.start({ ready: server.initialReady.promise,
    message: async message => { store.admit({ kind: "message", input: message }); server.deliver(); },
    answer: async (approvalId, response, source) => { store.admit({ kind: "answer", approvalId, response, route: source }); server.deliver(); },
  });
  function client(): Messenger {
    const saved = process.env.OMP_SUPERAGENT_GATEWAY_TOKEN;
    process.env.OMP_SUPERAGENT_GATEWAY_TOKEN = store.token();
    const result = createGatewayMessenger(config);
    if (saved === undefined) delete process.env.OMP_SUPERAGENT_GATEWAY_TOKEN;
    else process.env.OMP_SUPERAGENT_GATEWAY_TOKEN = saved;
    cleanups.push(() => result.stop());
    return result;
  }
  return { config, store, server, messenger, client, get stopRequests() { return stopRequests; } };
}

test("initial native approval readiness gates admission, while head detach preserves durable intake and dedup", async () => {
  const f = await fixture();
  const first = f.client();
  const ready = Promise.withResolvers<void>();
  const received: string[] = [];
  await first.start({ ready: ready.promise, message: async message => { received.push(message.id); }, answer: async () => {} });
  let admitted = false;
  const admission = f.messenger.emit(input("initial")).then(() => { admitted = true; });
  await Bun.sleep(15);
  expect(admitted).toBe(false);
  expect(f.server.headReady).toBe(false);
  ready.resolve();
  await admission;
  await eventually(() => received.length === 1 && f.store.pending() === 0);
  await first.stop();
  expect(f.messenger.stopped).toBe(false);
  await f.messenger.emit(input("offline"));
  await f.messenger.emit(input("offline"));
  expect(f.store.pending()).toBe(1);
  const second = f.client();
  await second.start({ message: async message => { received.push(message.id); }, answer: async () => {} });
  await eventually(() => received.length === 2 && f.store.pending() === 0);
  expect(received).toEqual(["initial", "offline"]);
});

test("lost event receipt redelivers original source identity in order to the next head attachment", async () => {
  const f = await fixture();
  const options = { token: f.store.token(), clientId: crypto.randomUUID() };
  const socket = gatewayPaths(f.config).socketPath;
  await gatewayCall(socket, "/attach", { pid: process.pid }, options);
  const stream = await gatewayRequest(socket, "/events", undefined, options);
  await gatewayCall(socket, "/ready", {}, options);
  // Deliberately close without acknowledging the reconnect event or input.
  await f.messenger.emit(input("unreceipted"));
  stream.destroy();
  await eventually(() => !f.server.connected);
  const received: Inbound[] = [];
  const client = f.client();
  await client.start({ message: async message => { received.push(message); }, answer: async () => {} });
  await eventually(() => received.length === 1 && f.store.pending() === 0);
  expect(received).toEqual([input("unreceipted")]);
});

test.each(["Controller is stopped", "Head store admission failed"])("%s before acceptance preserves platform-ACKed ingress for the replacement head", async failure => {
  const f = await fixture();
  const first = f.client();
  const failed = Promise.withResolvers<void>();
  let attempts = 0;
  await first.start({ message: async () => {
    attempts++;
    failed.resolve();
    // Neither shutdown nor a local store error is a durable head receipt.
    throw new Error(failure);
  }, answer: async () => {} });
  await f.messenger.emit(input("failed-head-admission"));
  await failed.promise;
  await eventually(() => !f.server.connected);
  expect(f.server.ready).toBe(true);
  expect(f.store.pending()).toBe(1);
  const status = await gatewayCall<GatewayStatus>(gatewayPaths(f.config).socketPath, "/status");
  expect(status.gateway).toMatchObject({ pendingEvents: 1, unresolvedEvents: 1, admissionReady: true });
  expect(status.head.ready).toBe(false);
  expect(f.store.next()?.event).toEqual({ kind: "message", input: input("failed-head-admission") });
  expect(attempts).toBe(1);
  await first.stop();

  // Gateway already acknowledged the platform; recovery has only its journal.
  const accepted: Inbound[] = [];
  const replacement = f.client();
  await replacement.start({ message: async message => { accepted.push(message); }, answer: async () => {} });
  await eventually(() => accepted.length === 1 && f.store.pending() === 0);
  expect(accepted).toEqual([input("failed-head-admission")]);
});

test("transient head admission failure reconnects with the same identity and drains ordered pending ingress", async () => {
  const f = await fixture();
  const client = f.client();
  const attempts: Inbound[] = [];
  const accepted: string[] = [];
  await client.start({ message: async message => {
    attempts.push(message);
    if (attempts.length === 1) throw new Error("Transient store failure before acceptance");
    accepted.push(message.id);
  }, answer: async () => {} });
  await f.messenger.emit(input("transient"));
  await f.messenger.emit(input("following"));
  await eventually(() => accepted.length === 2 && f.store.pending() === 0);
  expect(attempts).toEqual([input("transient"), input("transient"), input("following")]);
  expect(accepted).toEqual(["transient", "following"]);
  expect(f.server.headReady).toBe(true);
});

test("only explicit definitive rejection settles failed admission and unblocks following ingress", async () => {
  const f = await fixture();
  const client = f.client();
  const seen: string[] = [];
  await client.start({ message: async message => {
    seen.push(message.id);
    if (message.id === "rejected") throw new DeliveryError("Definitively foreign input", "rejected");
  }, answer: async () => {} });
  await f.messenger.emit(input("rejected"));
  await f.messenger.emit(input("valid"));
  await eventually(() => f.store.pending() === 0);
  expect(seen).toEqual(["rejected", "valid"]);
  expect(f.server.connected).toBe(true);
});

test("ambiguous native answer is retained and reconciled without duplicate approval effects", async () => {
  const f = await fixture();
  const client = f.client();
  const reconciling = Promise.withResolvers<void>();
  const reconciled = Promise.withResolvers<"accepted">();
  let answerAttempts = 0;
  let nativeEffects = 0;
  let received = 0;
  await client.start({ message: async () => { received++; }, answer: async (id, response, source) => {
    expect(id).toBe("original-native-approval");
    expect(response).toEqual({ confirmed: true });
    expect(source).toEqual(route);
    answerAttempts++;
    nativeEffects++;
    throw new Error("Native response receipt was lost after the effect");
  }, reconcileAnswer: async (id, source) => {
    expect(id).toBe("original-native-approval");
    expect(source).toEqual(route);
    reconciling.resolve();
    return reconciled.promise;
  } });
  await f.server.initialReady.promise;
  await f.messenger.handlers!.answer("original-native-approval", { confirmed: true }, route);
  await f.messenger.emit(input("after-approval"));
  await reconciling.promise;
  expect(f.store.hasPendingAnswer("original-native-approval", route)).toBe(true);
  expect(f.store.hasPendingAnswer("original-native-approval", { ...route, topicId: "foreign-topic" })).toBe(false);
  expect(f.store.hasPendingAnswer("different-native-approval", route)).toBe(false);
  expect(f.store.next()?.reconciliation).toBe(true);
  expect(f.server.headReady).toBe(false);
  expect(received).toBe(0);
  expect(answerAttempts).toBe(1);
  expect(nativeEffects).toBe(1);
  reconciled.resolve("accepted");
  await eventually(() => received === 1 && f.store.pending() === 0);
  expect(f.store.hasPendingAnswer("original-native-approval", route)).toBe(false);
  expect(answerAttempts).toBe(1);
  expect(nativeEffects).toBe(1);
});

test("callback lost before receipt cannot replay without original native-state reconciliation", async () => {
  const f = await fixture();
  const options = { token: f.store.token(), clientId: crypto.randomUUID() };
  const socket = gatewayPaths(f.config).socketPath;
  await gatewayCall(socket, "/attach", { pid: process.pid }, options);
  const stream = await gatewayRequest(socket, "/events", undefined, options);
  await gatewayCall(socket, "/ready", {}, options);
  const delivered = Promise.withResolvers<void>();
  stream.once("data", () => delivered.resolve());
  await f.messenger.handlers!.answer("lost-native-approval", { confirmed: true }, route);
  await delivered.promise;
  stream.destroy();
  await eventually(() => !f.server.connected);
  expect(f.store.next()?.reconciliation).toBe(true);

  let answers = 0;
  const client = f.client();
  await client.start({ message: async () => {}, answer: async () => { answers++; } });
  await eventually(() => !f.server.connected);
  await client.stop();
  expect(answers).toBe(0);
  expect(f.store.pending()).toBe(1);
  expect(f.store.hasPendingAnswer("lost-native-approval", route)).toBe(true);

  const safe = f.client();
  await safe.start({ message: async () => {}, answer: async () => { answers++; },
    reconcileAnswer: async () => "retry" });
  await eventually(() => f.store.pending() === 0);
  expect(answers).toBe(1);
});

test("fresh adapter admission waits for resumed head to restore pending approval cards and ACK reconciliation", async () => {
  const f = await fixture();
  const client = f.client();
  const approval: Approval = { id: "pending-approval", target: "main", generation: 1, requestId: "native-confirm",
    route, request: { method: "confirm", title: "Continue?" }, state: "pending", remoteId: "remote-approval" };
  const reconciling = Promise.withResolvers<void>();
  const reconcile = Promise.withResolvers<void>();
  let answers = 0;
  await client.start({ message: async () => {}, answer: async () => { answers++; },
    reconnect: async () => {
      reconciling.resolve();
      await reconcile.promise;
      await client.showApproval(approval);
    },
  });
  await eventually(() => f.server.ready);
  await client.showApproval(approval);
  expect(f.messenger.approvals.has(approval.id)).toBe(true);
  await f.server.close();

  // Same live head/client, fresh process-local adapter card cache and gate.
  const messenger = new FakeMessenger();
  const server = new GatewayServer({ socketPath: gatewayPaths(f.config).socketPath, store: f.store, messenger,
    authorizeHead: async pid => { if (pid !== process.pid) throw new Error("Foreign native owner"); },
    status: (): GatewayStatus => ({ gateway: { pid: process.pid, ready: true, admissionReady: server.ready,
      pendingEvents: f.store.pending(), stopping: false }, head: { pid: process.pid, ready: server.headReady,
      connected: server.connected, socketPath: "unused-native-socket", error: null } }),
    stop: async () => {}, onError: () => {},
  });
  await server.listen();
  cleanups.push(() => server.close());
  await messenger.start({ ready: server.initialReady.promise,
    message: async message => { f.store.admit({ kind: "message", input: message }); server.deliver(); },
    answer: async (approvalId, response, source) => {
      f.store.admit({ kind: "answer", approvalId, response, route: source }); server.deliver();
    },
  });
  let platformAcknowledged = false;
  const reply = messenger.answerCard(approval).then(() => { platformAcknowledged = true; });
  await reconciling.promise;
  expect(server.ready).toBe(false);
  expect(server.headReady).toBe(false);
  expect(messenger.approvals.has(approval.id)).toBe(false);
  expect(platformAcknowledged).toBe(false);
  expect(answers).toBe(0);
  reconcile.resolve();
  await reply;
  await eventually(() => server.ready && answers === 1 && f.store.pending() === 0);
  expect(messenger.approvals.has(approval.id)).toBe(true);
  expect(platformAcknowledged).toBe(true);
});

test("Gateway ingress and mutation journal survive restart without using the head writer lock", async () => {
  const root = await mkdtemp(join(await realpath("/tmp"), "ogq-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const store = new GatewayStore(root);
  store.admit({ kind: "message", input: input("durable") });
  const id = crypto.randomUUID();
  expect(store.beginEffect(id, "send", [input("durable")]).fresh).toBe(true);
  store.close();
  const recovered = new GatewayStore(root);
  cleanups.push(async () => recovered.close());
  expect(recovered.next()?.event).toEqual({ kind: "message", input: input("durable") });
  expect(recovered.beginEffect(id, "send", [input("durable")])).toMatchObject({ fresh: false,
    result: { ok: false, certainty: "uncertain" } });
  expect(() => recovered.admit({ kind: "message", input: { ...input("durable"), text: "changed" } })).toThrow("identity conflict");
});

test("answer attempt ambiguity and pending-answer route identity survive Gateway store restart", async () => {
  const root = await mkdtemp(join(await realpath("/tmp"), "oga-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const store = new GatewayStore(root);
  store.admit({ kind: "answer", approvalId: "durable-approval", response: { confirmed: true }, route });
  const first = store.next()!;
  expect(first.reconciliation).toBeUndefined();
  store.attempt(first.sequence);
  store.receipt(first.sequence, "unresolved");
  store.close();
  const recovered = new GatewayStore(root);
  cleanups.push(async () => recovered.close());
  expect(recovered.next()).toEqual({ ...first, reconciliation: true });
  expect(recovered.pending()).toBe(1);
  expect(recovered.hasPendingAnswer("durable-approval", route)).toBe(true);
  expect(recovered.hasPendingAnswer("durable-approval", { ...route, topicId: "other" })).toBe(false);
  recovered.receipt(first.sequence, "rejected");
  expect(recovered.pending()).toBe(0);
  expect(recovered.hasPendingAnswer("durable-approval", route)).toBe(false);
});

test("legacy generic error receipts recover inboxes while all pre-migration pending callbacks require reconciliation", async () => {
  const root = await mkdtemp(join(await realpath("/tmp"), "ogm-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const legacy = new Database(join(root, "coordination.sqlite"), { create: true, strict: true });
  legacy.run(`CREATE TABLE gateway_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, identity TEXT NOT NULL UNIQUE,
    data TEXT NOT NULL, received_at INTEGER NOT NULL, delivered_at INTEGER, delivery_error TEXT
  )`);
  legacy.query("INSERT INTO gateway_events(identity,data,received_at,delivered_at,delivery_error) VALUES (?,?,1,2,?)")
    .run("message:legacy-lost", JSON.stringify({ kind: "message", input: input("legacy-lost") }), "Head rejected admitted event");
  legacy.query("INSERT INTO gateway_events(identity,data,received_at,delivered_at,delivery_error) VALUES (?,?,1,2,?)")
    .run("answer:legacy-ambiguous", JSON.stringify({ kind: "answer", approvalId: "legacy-ambiguous", response: { confirmed: true }, route }), "Head rejected admitted event");
  legacy.query("INSERT INTO gateway_events(identity,data,received_at) VALUES (?,?,1)")
    .run("answer:legacy-pending", JSON.stringify({ kind: "answer", approvalId: "legacy-pending", response: { confirmed: true }, route }));
  legacy.close();
  const recovered = new GatewayStore(root);
  cleanups.push(async () => recovered.close());
  expect(recovered.pending()).toBe(3);
  const message = recovered.next()!;
  expect(message.event).toEqual({ kind: "message", input: input("legacy-lost") });
  expect(message.reconciliation).toBeUndefined();
  recovered.receipt(message.sequence, "accepted");
  const ambiguous = recovered.next()!;
  expect(ambiguous).toMatchObject({ event: { kind: "answer", approvalId: "legacy-ambiguous" }, reconciliation: true });
  recovered.receipt(ambiguous.sequence, "rejected");
  expect(recovered.next()).toMatchObject({ event: { kind: "answer", approvalId: "legacy-pending" }, reconciliation: true });
  expect(recovered.hasPendingAnswer("legacy-pending", route)).toBe(true);
});

test("mutations retain certainty/retry-after and duplicate request ids never repeat an external effect", async () => {
  const f = await fixture();
  const client = f.client();
  await client.start({ message: async () => {}, answer: async () => {} });
  const output: OutputRecord = { id: "output", sourceId: "source", route, text: "result", state: "sending", remoteId: null, error: null };
  f.messenger.sendFailure = new DeliveryError("rate limited", "rejected", 321);
  try { await client.send(output); throw new Error("Expected delivery rejection"); }
  catch (error) {
    expect(error).toBeInstanceOf(DeliveryError);
    expect(error).toMatchObject({ certainty: "rejected", retryAfterMs: 321 });
  }
  f.messenger.sendFailure = new DeliveryError("lost receipt", "uncertain");
  await expect(client.send(output)).rejects.toMatchObject({ certainty: "uncertain" });
  expect(f.messenger.sends).toHaveLength(2);
  await client.stop();
  const options = { token: f.store.token(), clientId: crypto.randomUUID() };
  const socket = gatewayPaths(f.config).socketPath;
  await gatewayCall(socket, "/attach", { pid: process.pid }, options);
  f.messenger.sendFailure = undefined;
  const effect = { id: crypto.randomUUID(), operation: "send", args: [output] };
  expect(await gatewayCall(socket, "/effect", effect, options)).toBe("remote-message");
  expect(await gatewayCall(socket, "/effect", effect, options)).toBe("remote-message");
  expect(f.messenger.sends).toHaveLength(3);
  await expect(gatewayCall(socket, "/effect", { ...effect, operation: "prompt" }, options)).rejects.toMatchObject({ certainty: "rejected" });
});

test("attachment IPC streams before completion, forwards abort, and rejects oversized streams", async () => {
  const f = await fixture();
  const client = f.client();
  await client.start({ message: async () => {}, answer: async () => {} });
  const attachment: Attachment = { id: "F1", name: "test.bin", url: "slack-file:F1", size: 4 };
  let upstreamSignal: AbortSignal | undefined;
  f.messenger.download = signal => {
    upstreamSignal = signal;
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1, 2])); } }));
  };
  const abort = new AbortController();
  const response = await client.openAttachment(route, attachment, abort.signal);
  const reader = response.body!.getReader();
  expect((await reader.read()).value).toEqual(new Uint8Array([1, 2]));
  abort.abort();
  await eventually(() => !!upstreamSignal?.aborted);
  await reader.cancel().catch(() => {});
  f.messenger.download = () => new Response(new Uint8Array([1, 2, 3, 4, 5]));
  await expect((async () => {
    const oversized = await client.openAttachment(route, attachment, AbortSignal.timeout(2000));
    await oversized.arrayBuffer();
  })()).rejects.toThrow();
  f.messenger.download = () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3, 4]));
      controller.enqueue(new Uint8Array([5]));
      controller.close();
    },
  }));
  await expect((async () => {
    const lateOverflow = await client.openAttachment(route, attachment, AbortSignal.timeout(2000));
    await lateOverflow.arrayBuffer();
  })()).rejects.toThrow();
  f.messenger.download = () => new Response(new Uint8Array([1, 2]));
  await expect((async () => {
    const truncated = await client.openAttachment(route, attachment, AbortSignal.timeout(2000));
    await truncated.arrayBuffer();
  })()).rejects.toThrow();
  f.messenger.download = () => new Response(new Uint8Array([1, 2, 3, 4]));
  const complete = await client.openAttachment(route, attachment, AbortSignal.timeout(2000));
  expect(new Uint8Array(await complete.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
});

test("only supervised head may attach and explicit stop is a service request, not native RPC forwarding", async () => {
  const f = await fixture();
  const options = { token: f.store.token(), clientId: crypto.randomUUID() };
  const socket = gatewayPaths(f.config).socketPath;
  await expect(gatewayCall(socket, "/attach", { pid: process.pid + 1 }, options)).rejects.toMatchObject({ certainty: "rejected" });
  await expect(gatewayCall(socket, "/attach", { pid: process.pid }, { ...options, token: "wrong" })).rejects.toMatchObject({ certainty: "rejected" });
  await gatewayCall(socket, "/stop", {});
  expect(f.stopRequests).toBe(1);
  expect(f.messenger.stopped).toBe(false);
});
