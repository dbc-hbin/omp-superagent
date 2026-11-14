import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { request as httpRequest, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import type { Config } from "../src/config";
import type { Approval, Attachment, GatewayRestartNotice, GatewayRestartRecord, GatewayRestartRequest, Inbound, MessageActivity, MessageReference, Messenger, OutputRecord, Route } from "../src/contracts";
import { DeliveryError } from "../src/delivery";
import { createGatewayMessenger } from "../src/gateway-client";
import { gatewayCall, gatewayPaths, gatewayRequest, readGatewayJson, type GatewayResult } from "../src/gateway-protocol";
import { GatewayServer, type GatewayStatus } from "../src/gateway-server";
import { GatewayStore } from "../src/gateway-store";
import { Store } from "../src/store";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const route: Route = { platform: "slack", accountId: "B1", authorityId: "T1", guildId: null, channelId: "D1", threadId: null };
function input(id: string): Inbound & MessageReference {
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
  readonly activities: Array<{ message: MessageReference; activity: MessageActivity }> = [];
  beforeActivity?: () => Promise<void> | void;
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
  async setActivity(message: MessageReference, activity: MessageActivity) {
    await this.beforeActivity?.();
    this.activities.push({ message: structuredClone(message), activity });
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

async function fixture(options: {
  restart?(request: GatewayRestartRequest, store: GatewayStore): Promise<GatewayRestartRecord>;
  runRestart?(requestId: string): void;
  authorizeHead?(pid: number): Promise<void>;
} = {}) {
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
    authorizeHead: options.authorizeHead ?? (async pid => { if (pid !== process.pid) throw new DeliveryError("Foreign native owner", "rejected"); }),
    status: (): GatewayStatus => ({ gateway: { pid: process.pid, ready: true, admissionReady: server.ready,
      pendingEvents: store.pending(), stopping: false }, head: { pid: process.pid, ready: server.headReady,
      connected: server.connected, socketPath: join(root, "run", "main.sock"), error: null } }),
    stop: async () => { stopRequests++; }, onError: () => {},
    ...(options.restart ? { restart: (request: GatewayRestartRequest) => options.restart!(request, store) } : {}),
    ...(options.runRestart ? { runRestart: options.runRestart } : {}),
  });
  await server.listen();
  cleanups.push(() => server.close());
  await messenger.start({ ready: server.initialReady.promise,
    message: async message => { server.admitMessage(message); },
    answer: async (approvalId, response, source) => { store.admit({ kind: "answer", approvalId, response, route: source }); server.deliver(); },
  });
  function client() {
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

function restartSource(f: { config: Config }, source: Inbound = { ...input("restart-source"), text: " \n/restart\t" }) {
  const headStore = new Store(join(f.config.stateDir, "coordination.sqlite"));
  cleanups.push(async () => headStore.close());
  const request: GatewayRestartRequest = { requestId: crypto.randomUUID(), inputId: source.id, ackOutputId: `${source.id}:restart:ack` };
  headStore.receive(source, "main", { [`user-source:${source.id}`]: "true" });
  headStore.settle(source.id, "done", { id: request.ackOutputId, text: "Restart accepted; waiting for owned processes." });
  headStore.claimOutput(request.ackOutputId);
  headStore.finishOutput(request.ackOutputId, "sent", "remote-restart-ack");
  const record: GatewayRestartRecord = { ...request, gatewayPid: process.pid, headPid: process.pid,
    sessionId: "existing-session", sessionFile: join(f.config.stateDir, "existing-session.jsonl"), state: "accepted" };
  return { headStore, request, record, source };
}

test("receipt reactions follow durable admission without delaying ACK or requiring a resident head", async () => {
  const f = await fixture();
  const client = f.client();
  await client.start({ message: async () => {}, answer: async () => {} });
  await f.server.initialReady.promise;
  await client.stop();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.messenger.beforeActivity = async () => {
    expect(f.store.pending()).toBe(1);
    entered.resolve();
    await release.promise;
  };
  try {
    await f.messenger.emit(input("offline-reaction"));
    await entered.promise;
    await f.messenger.emit(input("offline-reaction"));
    expect(f.messenger.activities).toEqual([]);
    expect(f.store.pending()).toBe(1);
  } finally { release.resolve(); }
  await f.server.close();
  expect(f.messenger.activities).toEqual([{ message: { route, messageId: "offline-reaction" }, activity: "received" }]);
});

test("reaction failures never reject durable input or a later answer and activity crosses real Gateway IPC", async () => {
  const f = await fixture();
  const client = f.client();
  const answered = Promise.withResolvers<void>();
  f.messenger.beforeActivity = () => { throw new Error("Missing reaction scope"); };
  await client.start({
    message: async message => {
      try {
        if (message.messageId !== null) await client.setActivity?.({ route: message.route, messageId: message.messageId }, "thinking");
      } catch { /* Cosmetic API failure only. */ }
      await client.send({ id: "reply", sourceId: message.id, route: message.route, text: "answer",
        state: "sending", remoteId: null, error: null });
      answered.resolve();
    },
    answer: async () => {},
  });
  await f.messenger.emit(input("reaction-denied"));
  await answered.promise;
  expect(f.messenger.sends.map(output => output.text)).toEqual(["answer"]);
  f.messenger.beforeActivity = undefined;
  await client.setActivity?.(input("reaction-denied"), "idle");
  expect(f.messenger.activities).toEqual([{ message: { route, messageId: "reaction-denied" }, activity: "idle" }]);
});

test("slash commands cross durable Gateway IPC without receipt reactions or nullable message effects", async () => {
  const f = await fixture();
  const first = f.client();
  await first.start({ message: async () => {}, answer: async () => {} });
  await f.server.initialReady.promise;
  await first.stop();
  const original: Inbound = { ...input("discord:2:interaction:1750000000000000001"),
    route: { platform: "discord", accountId: "2", authorityId: "1", guildId: null, channelId: "4", threadId: null },
    messageId: null, interactionId: "1750000000000000001", text: "/status" };
  await f.messenger.emit(original);
  await f.messenger.emit(original);
  expect(f.store.next()?.event).toEqual({ kind: "message", input: original });
  expect(f.store.pending()).toBe(1);
  expect(f.messenger.activities).toEqual([]);
  const accepted: Inbound[] = [];
  const replacement = f.client();
  await replacement.start({ message: async command => { accepted.push(command); }, answer: async () => {} });
  await eventually(() => accepted.length === 1 && f.store.pending() === 0);
  expect(accepted).toEqual([original]);
  await expect(replacement.setActivity!({ route: original.route, messageId: null } as unknown as MessageReference, "thinking"))
    .rejects.toMatchObject({ certainty: "rejected" });
  expect(f.messenger.activities).toEqual([]);
});

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

test("a quarantined answer holds ordinary ingress but cannot trap owner restart behind it", async () => {
  const admitted = Promise.withResolvers<GatewayRestartRecord>();
  const checkpoint = Promise.withResolvers<void>();
  const reconnecting = Promise.withResolvers<void>();
  const reconnect = Promise.withResolvers<void>();
  let gateReconnect = false;
  let lifecycleAttempt = false;
  const f = await fixture({ restart: async (request, store) => {
    const result: GatewayRestartRecord = { ...request, gatewayPid: process.pid, headPid: process.pid,
      sessionId: "existing-session", sessionFile: join(f.config.stateDir, "existing-session.jsonl"), state: "accepted" };
    store.setRestart(result);
    return result;
  }, runRestart: () => {}, authorizeHead: async pid => {
    if (pid !== process.pid) throw new DeliveryError("Foreign native owner", "rejected");
    if (gateReconnect && !lifecycleAttempt) { reconnecting.resolve(); await reconnect.promise; }
  } });
  const client = f.client();
  const received: string[] = [];
  let cancelled = false;
  let answerEffects = 0;
  await client.start({
    message: async message => {
      received.push(message.id);
      if (message.text === "/restart") {
        const { request } = restartSource(f, message);
        gateReconnect = true;
        // Production receive schedules control work, then acknowledges ingress;
        // lifecycle handoff is deliberately later, during a disconnected SSE.
        void checkpoint.promise.then(() => client.requestRestart(request)).then(admitted.resolve, admitted.reject);
      }
    },
    answer: async () => { answerEffects++; throw new DeliveryError("Original native response is unconfirmed", "uncertain"); },
    reconcileAnswer: async () => cancelled ? "rejected" : "unresolved",
  });
  await f.server.initialReady.promise;
  await f.messenger.handlers!.answer("quarantined-original-card", { confirmed: true }, route);
  await eventually(() => f.store.unresolved() === 1);
  await f.messenger.emit(input("ordinary-after-quarantine"));
  await f.messenger.emit({ ...input("restart-through-quarantine"), text: "/restart" });
  try {
    await reconnecting.promise;
    expect(f.server.connected).toBe(false);
    expect(f.server.headReady).toBe(false);
    lifecycleAttempt = true;
    checkpoint.resolve();
    const admittedRestart = await admitted.promise;
    expect(admittedRestart.state).toBe("accepted");
    expect(f.store.hasPendingAnswer("quarantined-original-card", route)).toBe(true);
    expect(received).toEqual(["restart-through-quarantine"]);
    expect(answerEffects).toBe(1);
    expect(f.store.getRestart(admittedRestart.requestId)?.state).toBe("accepted");
    cancelled = true; // The exact native generation was deliberately cancelled, not approved/replayed.
  } finally { gateReconnect = false; lifecycleAttempt = true; checkpoint.resolve(); reconnect.resolve(); }
  await eventually(() => f.store.pending() === 0);
  expect(received).toEqual(["restart-through-quarantine", "ordinary-after-quarantine"]);
  expect(answerEffects).toBe(1);
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
  const command: Inbound = { ...input("durable-command"), route: { ...route, platform: "discord" },
    messageId: null, interactionId: "1750000000000000001", text: "/status" };
  store.admit({ kind: "message", input: command });
  const id = crypto.randomUUID();
  expect(store.beginEffect(id, "send", [input("durable")]).fresh).toBe(true);
  store.close();
  const recovered = new GatewayStore(root);
  cleanups.push(async () => recovered.close());
  expect(recovered.next()?.event).toEqual({ kind: "message", input: input("durable") });
  expect(recovered.beginEffect(id, "send", [input("durable")])).toMatchObject({ fresh: false,
    result: { ok: false, certainty: "uncertain" } });
  expect(() => recovered.admit({ kind: "message", input: { ...input("durable"), text: "changed" } })).toThrow("identity conflict");
  recovered.receipt(recovered.next()!.sequence, "accepted");
  expect(recovered.next()?.event).toEqual({ kind: "message", input: command });
  expect(recovered.admit({ kind: "message", input: command })).toBe(false);
  expect(() => recovered.admit({ kind: "message", input: { ...command, interactionId: "1750000000000000002" } })).toThrow("identity conflict");
  expect(() => recovered.admit({ kind: "message", input: { ...command, messageId: command.interactionId!, interactionId: undefined } })).toThrow("identity conflict");
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

test("restart authenticates and rechecks managed-head authority before consuming its body", async () => {
  let revoked = false;
  let authorizations = 0;
  const secret = "private-response-token-never-expose";
  const f = await fixture({ authorizeHead: async () => {
    authorizations++;
    if (revoked) throw new DeliveryError(secret, "rejected");
  } });
  const socket = gatewayPaths(f.config).socketPath;
  async function partial(headers: Record<string, string>) {
    const received = Promise.withResolvers<GatewayResult>();
    const request = httpRequest({ socketPath: socket, path: "/restart", method: "POST",
      headers: { ...headers, "content-length": "4096" }, signal: AbortSignal.timeout(2000) }, response => {
      void readGatewayJson(response).then(value => received.resolve(value as GatewayResult), received.reject);
    });
    request.on("error", received.reject);
    request.write("{"); // Deliberately never complete the JSON body.
    try { return await received.promise; }
    finally { request.destroy(); }
  }
  expect(await partial({})).toMatchObject({ ok: false, error: "Gateway head authorization required", certainty: "rejected" });
  const options = { token: f.store.token(), clientId: crypto.randomUUID() };
  const headers = { authorization: `Bearer ${options.token}`, "x-gateway-client": options.clientId };
  expect(await partial(headers)).toMatchObject({ error: "Gateway client is detached" });
  expect(authorizations).toBe(0);
  await gatewayCall(socket, "/attach", { pid: process.pid }, options);
  const events = await gatewayRequest(socket, "/events", undefined, options);
  cleanups.push(async () => { events.destroy(); });
  await gatewayCall(socket, "/ready", {}, options);
  revoked = true;
  const result = await partial(headers);
  expect(result).toMatchObject({ ok: false, error: "Gateway head authorization rejected", certainty: "rejected" });
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(authorizations).toBe(2);
});

test("restart RPC waits for head readiness and validates bounded identities", async () => {
  let accepts = 0;
  const f = await fixture({ restart: async () => { accepts++; throw new Error("must not accept"); }, runRestart: () => {} });
  const source = restartSource(f);
  const client = f.client();
  const ready = Promise.withResolvers<void>();
  await client.start({ ready: ready.promise, message: async () => {}, answer: async () => {} });
  await expect(client.requestRestart(source.request)).rejects.toMatchObject({ certainty: "rejected", message: "Gateway head is not ready for restart" });
  ready.resolve();
  await eventually(() => f.server.headReady);
  for (const patch of [
    { requestId: "-------------------invalid-uuid------" },
    { requestId: "00000000-0000-0000-0000-000000000000" },
    { inputId: "" }, { inputId: "x".repeat(1025) }, { ackOutputId: " " }, { ackOutputId: "x".repeat(1025) },
  ]) await expect(client.requestRestart({ ...source.request, ...patch })).rejects.toMatchObject({ certainty: "rejected" });
  expect(accepts).toBe(0);
});

test("restart acceptance is durable, deduplicated while in flight, and runs only after successful response finish", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let original!: GatewayRestartRecord;
  let accepts = 0;
  let runs = 0;
  let finished = 0;
  const f = await fixture({
    restart: async (request, store) => {
      accepts++;
      entered.resolve();
      await release.promise;
      const record = { ...original, ...request };
      store.setRestart(record);
      return record;
    },
    runRestart: requestId => {
      expect(finished).toBeGreaterThan(0);
      expect(f.store.getRestart(requestId)?.state).toBe("accepted");
      runs++;
    },
  });
  const source = restartSource(f);
  original = source.record;
  const client = f.client();
  await client.start({ message: async () => {}, answer: async () => {} });
  await eventually(() => f.server.headReady);
  // Inspect the existing HTTP server only to observe the real response finish boundary.
  const internal = f.server as unknown as { server: Server };
  internal.server.on("request", (request, response) => {
    if (request.url === "/restart") response.once("finish", () => { if (response.statusCode === 200) finished++; });
  });
  const first = client.requestRestart(source.request);
  await entered.promise;
  expect(runs).toBe(0);
  expect(f.store.getRestart()).toBeNull();
  const duplicate = client.requestRestart(source.request);
  await expect(client.requestRestart({ ...source.request, requestId: crypto.randomUUID() })).rejects.toMatchObject({ certainty: "rejected" });
  await expect(client.requestRestart({ ...source.request, ackOutputId: "different-ack" })).rejects.toMatchObject({ certainty: "rejected" });
  release.resolve();
  expect(await first).toEqual(original);
  expect(await duplicate).toEqual(original);
  expect(await client.requestRestart(source.request)).toEqual(original);
  expect(accepts).toBe(1);
  expect(runs).toBe(1);
  await expect(client.requestRestart({ ...source.request, requestId: crypto.randomUUID() })).rejects.toMatchObject({ certainty: "rejected" });
  await expect(client.requestRestart({ ...source.request, inputId: "another-source" })).rejects.toMatchObject({ certainty: "rejected" });
  const status = await gatewayCall<GatewayStatus>(gatewayPaths(f.config).socketPath, "/status");
  expect(status.restart).toMatchObject({ requestId: original.requestId, state: "accepted", sessionId: original.sessionId });
  expect(status.restart).not.toHaveProperty("sessionFile");
  expect(JSON.stringify(status)).not.toContain(f.store.token());
});

test("a lost restart acceptance response cannot trigger shutdown until a later successful receipt", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  let original!: GatewayRestartRecord;
  let accepts = 0;
  let runs = 0;
  const f = await fixture({ restart: async (request, store) => {
    accepts++;
    entered.resolve();
    await release.promise;
    store.setRestart({ ...original, ...request });
    return store.getRestart(request.requestId)!;
  }, runRestart: () => { runs++; } });
  const source = restartSource(f);
  original = source.record;
  const client = f.client();
  await client.start({ message: async () => {}, answer: async () => {} });
  await eventually(() => f.server.headReady);
  // Observe the response socket without adding any production-only test endpoint.
  const internal = f.server as unknown as { server: Server };
  let response: ServerResponse | undefined;
  internal.server.once("request", (_request, accepted) => { response = accepted; accepted.once("close", closed.resolve); });
  const first = client.requestRestart(source.request).catch(error => error);
  await entered.promise;
  response!.destroy();
  await closed.promise;
  release.resolve();
  expect(await first).toBeInstanceOf(DeliveryError);
  await eventually(() => f.store.getRestart() !== null);
  expect(runs).toBe(0);
  expect(await client.requestRestart(source.request)).toEqual(original);
  expect(accepts).toBe(1);
  expect(runs).toBe(1);
});

test.each(["refused", "uncertain", "failed", "head-stopped", "started"] as const)("persisted %s restart receipts never run the lifecycle again", async state => {
  let runs = 0;
  const f = await fixture({ restart: async () => { throw new Error("must use persisted receipt"); }, runRestart: () => { runs++; } });
  const source = restartSource(f);
  f.store.setRestart({ ...source.record, state, reason: "Owned restart remains fenced." });
  const client = f.client();
  await client.start({ message: async () => {}, answer: async () => {} });
  await eventually(() => f.server.headReady);
  expect(await client.requestRestart(source.request)).toMatchObject({ state });
  expect(runs).toBe(0);
});

test("restart RPC requires persisted acceptance and redacts thrown delivery details", async () => {
  const secret = "response-url-with-private-credentials";
  let original!: GatewayRestartRecord;
  let mode: "delivery" | "error" | "unpersisted" = "delivery";
  let runs = 0;
  const f = await fixture({ restart: async () => {
    if (mode === "delivery") throw new DeliveryError(secret, "rejected");
    if (mode === "error") throw new Error(secret);
    return original;
  }, runRestart: () => { runs++; } });
  const source = restartSource(f);
  original = source.record;
  const client = f.client();
  await client.start({ message: async () => {}, answer: async () => {} });
  await eventually(() => f.server.headReady);
  for (const next of ["delivery", "error", "unpersisted"] as const) {
    mode = next;
    const error = await client.requestRestart(source.request).catch(value => value);
    expect(error).toBeInstanceOf(DeliveryError);
    expect(error.certainty).toBe(next === "delivery" ? "rejected" : "uncertain");
    expect(error.message).not.toContain(secret);
  }
  expect(runs).toBe(0);
});

test.each(["user-source", "command", "arguments", "pending-input", "wrong-target", "ack-source", "ack-route", "ack-pending", "ack-sending", "ack-uncertain", "ack-failed", "ack-remote"])("restart authority rejects invalid durable %s", async invalid => {
  let accepts = 0;
  const f = await fixture({ restart: async () => { accepts++; throw new Error("Invalid authority must never reach lifecycle acceptance"); }, runRestart: () => {} });
  const source = restartSource(f);
  const db = new Database(join(f.config.stateDir, "coordination.sqlite"), { strict: true });
  cleanups.push(async () => db.close());
  if (invalid === "user-source") source.headStore.setMeta(`user-source:${source.request.inputId}`, "false");
  else if (invalid === "command" || invalid === "arguments") db.query("UPDATE inputs SET data=? WHERE id=?")
    .run(JSON.stringify({ ...source.source, text: invalid === "command" ? "/status" : "/restart now" }), source.request.inputId);
  else if (invalid === "pending-input") db.query("UPDATE inputs SET state='pending' WHERE id=?").run(source.request.inputId);
  else if (invalid === "wrong-target") db.query("UPDATE inputs SET target='lane' WHERE id=?").run(source.request.inputId);
  else if (invalid === "ack-source") db.query("UPDATE outputs SET source_id='status-command' WHERE id=?").run(source.request.ackOutputId);
  else if (invalid === "ack-route") db.query("UPDATE outputs SET route=? WHERE id=?").run(JSON.stringify({ ...route, topicId: "different-topic" }), source.request.ackOutputId);
  else if (invalid === "ack-remote") db.query("UPDATE outputs SET remote_id=NULL WHERE id=?").run(source.request.ackOutputId);
  else db.query("UPDATE outputs SET state=? WHERE id=?").run(invalid.slice(4), source.request.ackOutputId);
  expect(() => f.store.validateRestart(source.request)).toThrow(DeliveryError);
  expect(() => f.store.setRestart(source.record)).toThrow(DeliveryError);
  expect(f.store.getRestart()).toBeNull();
  expect(f.store.getMeta(`gateway:restart-source:${source.request.inputId}`)).toBeNull();
  const client = f.client();
  await client.start({ message: async () => {}, answer: async () => {} });
  await eventually(() => f.server.headReady);
  await expect(client.requestRestart(source.request)).rejects.toMatchObject({ certainty: "rejected" });
  expect(accepts).toBe(0);
});

test.each(["discord", "telegram", "slack"] as const)("%s restart authority uses the original durable route and sent ACK", async platform => {
  const f = await fixture();
  const source = restartSource(f, { ...input(`restart-${platform}`), route: { ...route, platform }, text: " /restart \n" });
  const validated = f.store.validateRestart(source.request);
  expect(validated).toMatchObject(source.source);
  expect(validated.route).toEqual(source.source.route);
  f.store.setRestart(source.record);
  expect(f.store.getRestart(source.request.requestId)).toEqual(source.record);
  expect(f.store.getRestart()).toEqual(source.record);
  expect(f.store.getMeta(`gateway:restart-source:${source.request.inputId}`)).toBe(source.request.requestId);
});

test("restart receipts atomically retain source identity across store reopening", async () => {
  const f = await fixture();
  const source = restartSource(f);
  f.store.setRestart(source.record);
  f.store.setRestart({ ...source.record, state: "uncertain", reason: "Shutdown receipt is ambiguous." });
  for (const patch of [
    { requestId: crypto.randomUUID() }, { inputId: "different-source" }, { ackOutputId: "different-ack" },
    { gatewayPid: 1 }, { headPid: 1 }, { sessionId: "different-session" }, { sessionFile: "different-session.jsonl" },
  ]) expect(() => f.store.setRestart({ ...source.record, ...patch })).toThrow("identity conflict");
  expect(f.store.getRestart()?.state).toBe("uncertain");
  expect(f.store.getMeta(`gateway:restart-source:${source.request.inputId}`)).toBe(source.request.requestId);
  f.store.close();
  const recovered = new GatewayStore(f.config.stateDir);
  cleanups.push(async () => recovered.close());
  expect(recovered.getRestart(source.request.requestId)).toMatchObject({ ...source.request, state: "uncertain" });
  expect(recovered.getRestart()).toEqual(recovered.getRestart(source.request.requestId));
  expect(() => recovered.setRestart({ ...source.record, requestId: crypto.randomUUID() })).toThrow("identity conflict");
});

test("historical restart updates do not displace a newer active latest receipt", async () => {
  const f = await fixture();
  const first = restartSource(f);
  f.store.setRestart(first.record);
  f.store.setRestart({ ...first.record, state: "started" });
  const inputB = { ...input("restart-newer"), text: "/restart" };
  const requestB: GatewayRestartRequest = { requestId: crypto.randomUUID(), inputId: inputB.id, ackOutputId: `${inputB.id}:restart:ack` };
  first.headStore.receive(inputB, "main", { [`user-source:${inputB.id}`]: "true" });
  first.headStore.settle(inputB.id, "done", { id: requestB.ackOutputId, text: "New restart acknowledgement." });
  first.headStore.claimOutput(requestB.ackOutputId);
  first.headStore.finishOutput(requestB.ackOutputId, "sent", "remote-newer-ack");
  const recordB: GatewayRestartRecord = { ...first.record, ...requestB };
  f.store.setRestart(recordB);
  const lateA: GatewayRestartRecord = { ...first.record, state: "started", reason: "Late completion receipt for the earlier restart." };
  f.store.setRestart(lateA);
  expect(f.store.getRestart(first.request.requestId)).toEqual(lateA);
  expect(f.store.getRestart(requestB.requestId)).toEqual(recordB);
  expect(f.store.getRestart()).toEqual(recordB);
  expect(f.store.getMeta(`gateway:restart-source:${first.request.inputId}`)).toBe(first.request.requestId);
  expect(f.store.getMeta(`gateway:restart-source:${requestB.inputId}`)).toBe(requestB.requestId);
  const status = await gatewayCall<GatewayStatus>(gatewayPaths(f.config).socketPath, "/status");
  expect(status.restart).toMatchObject({ ...requestB, state: "accepted" });
  expect(() => f.store.setRestart({ ...lateA, ackOutputId: requestB.ackOutputId })).toThrow("identity conflict");
  expect(f.store.getRestart()).toEqual(recordB);
  f.store.setRestart({ ...recordB, state: "head-stopped" });
  expect(f.store.getRestart()).toEqual({ ...recordB, state: "head-stopped" });
});

test("refused and uncertain restart events have distinct durable receipts and never become model inputs", async () => {
  const f = await fixture();
  const requestId = crypto.randomUUID();
  const refused: GatewayRestartNotice = { requestId, outcome: "refused", reason: "Native work is active." };
  const uncertain: GatewayRestartNotice = { requestId, outcome: "uncertain", reason: "Shutdown receipt is ambiguous." };
  expect(f.store.admit({ kind: "restart", ...refused })).toBe(true);
  expect(f.store.admit({ kind: "restart", ...refused })).toBe(false);
  expect(f.store.admit({ kind: "restart", ...uncertain })).toBe(true);
  const notices: GatewayRestartNotice[] = [];
  let messages = 0;
  let reconnects = 0;
  const client = f.client();
  await client.start({ message: async () => { messages++; }, answer: async () => {}, reconnect: async () => { reconnects++; },
    restart: async notice => { notices.push(notice); } });
  await eventually(() => f.store.pending() === 0);
  expect(notices).toEqual([refused, uncertain]);
  expect(f.store.admit({ kind: "restart", ...refused })).toBe(false);
  expect(f.store.admit({ kind: "restart", ...uncertain })).toBe(false);
  expect(() => f.store.admit({ kind: "restart", ...uncertain, reason: "Changed original identity" })).toThrow("identity conflict");
  expect(messages).toBe(0);
  expect(reconnects).toBe(0);
});

test("unhandled restart outcome delivery remains durable until a replacement handler accepts it", async () => {
  const f = await fixture();
  const notice: GatewayRestartNotice = { requestId: crypto.randomUUID(), outcome: "uncertain", reason: "Lifecycle remains fenced." };
  f.store.admit({ kind: "restart", ...notice });
  const first = f.client();
  await first.start({ message: async () => { throw new Error("must not become input"); }, answer: async () => {} });
  await eventually(() => f.store.unresolved() === 1);
  expect(f.store.pending()).toBe(1);
  await first.stop();
  const second = f.client();
  const accepted: GatewayRestartNotice[] = [];
  await second.start({ message: async () => { throw new Error("must not become input"); }, answer: async () => {},
    restart: async value => { accepted.push(value); } });
  await eventually(() => f.store.pending() === 0);
  expect(accepted).toEqual([notice]);
});
