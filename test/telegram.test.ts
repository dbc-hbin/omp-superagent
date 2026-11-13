import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Message, Update } from "grammy/types";
import { TelegramMessenger, telegramDeliveryError } from "../src/telegram.ts";
import { DeliveryError } from "../src/delivery.ts";
import { Store } from "../src/store.ts";
import type { Approval, DialogResponse, Inbound, OutputRecord, Route } from "../src/contracts.ts";
import { type Config, hostPaths } from "../src/config.ts";
import { createGatewayMessenger } from "../src/gateway-client.ts";
import { gatewayPaths } from "../src/gateway-protocol.ts";
import { GatewayServer, type GatewayStatus } from "../src/gateway-server.ts";
import { GatewayStore } from "../src/gateway-store.ts";
import { Superagent, type RuntimeHost, type RuntimeState } from "../src/runtime.ts";

// These tests run the real grammY Api serializer/error boundary against an
// in-process HTTP simulation. They never contact Telegram or activate a bot.
const owner = "42";
const bot = "900";
const token = "900:LOCAL_TEST_ONLY";
const group: Route = { platform: "telegram", accountId: bot, authorityId: owner, guildId: "-100", channelId: "-100", threadId: null };
const dm: Route = { ...group, guildId: null, channelId: owner };
const topic: Route = { ...group, threadId: "7" };
const bots: TelegramMessenger[] = [];
const stores: Store[] = [];
afterEach(async () => { for (const messenger of bots.splice(0)) await messenger.stop(); for (const store of stores.splice(0)) store.close(); });
function store() { const value = new Store(":memory:"); stores.push(value); return value; }
function message(patch: Record<string, unknown> = {}): Message {
  return { message_id: 10, date: 100, chat: { id: -100, type: "supergroup", title: "Allowed", is_forum: true },
    from: { id: 42, is_bot: false, first_name: "Owner" }, text: "hello", ...patch } as unknown as Message;
}
function approval(patch: Partial<Approval> = {}): Approval {
  return { id: "approve", target: "lane", generation: 3, requestId: "native-request", route: topic,
    request: { method: "confirm", title: "Proceed?", message: "One external action" }, state: "pending", remoteId: null, ...patch };
}
function output(text: string, route = group): OutputRecord { return { id: "output", sourceId: "input", text, route, state: "sending", remoteId: null, error: null }; }
async function drain() {
  for (let i = 0; i < 4; i++) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setImmediate(resolve); await promise;
  }
}
async function eventually(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Telegram Gateway fixture condition timed out");
    await drain();
  }
}

// Only the native transport is simulated: approval reconciliation and answer
// delivery below run through the production runtime, Gateway IPC and adapter.
class ApprovalHost implements RuntimeHost {
  readonly responses: Array<{ id: string; response: DialogResponse }> = [];
  readonly exited = Promise.withResolvers<void>().promise;
  readonly state: RuntimeState;
  constructor(sessionFile: string, sessionId: string, pending: Record<string, unknown>[] = []) {
    this.state = { sessionFile, sessionId, hostPid: process.pid, model: { provider: "fixture", id: "chat" },
      settingsScope: "session", isSettled: pending.length === 0, isStreaming: false, hasOwnedRunningWork: false,
      pendingUiRequests: pending };
  }
  readonly client = {
    getState: async () => structuredClone(this.state),
    abortAndRestoreQueue: async () => { throw new Error("Approval recovery must not abort native work"); },
    getSubagents: async () => [],
    cancelSubagent: async () => { throw new Error("Approval recovery must not cancel native children"); },
  };
  async request(command: Record<string, unknown>): Promise<unknown> {
    if (command.type === "get_available_models") return { success: true, data: { models: [{ ...this.state.model, kind: "chat" }] } };
    throw new Error(`Unexpected approval recovery command: ${command.type}`);
  }
  uiResponse(id: string, response: DialogResponse): void {
    this.responses.push({ id, response });
    this.state.pendingUiRequests = this.state.pendingUiRequests!.filter(frame => frame.id !== id);
  }
  onFrame(): () => void { return () => {}; }
  async close(): Promise<void> {} // Detach the head transport, not its native session.
}

interface Call { method: string; payload: Record<string, unknown>; init: RequestInit }
interface ApiFailure { error_code: number; description?: string; parameters?: Record<string, unknown> }
class TelegramHttp {
  readonly calls: Call[] = [];
  readonly remote = new Map<number, Message>();
  readonly failures = new Map<string, Array<ApiFailure | Error>>();
  webhook = "";
  topicsEnabled = false;
  forum = true;
  filePath = "documents/file_1.txt";
  fileStatus = 200;
  fileResponse = "contents";
  lastMultipart = "";
  private nextMessage = 100;
  private queued: Update[][] = [];
  private poll: { resolve(value: Update[]): void; cleanup(): void } | null = null;
  fail(method: string, failure: ApiFailure | Error) { const queue = this.failures.get(method) ?? []; queue.push(failure); this.failures.set(method, queue); }
  push(...updates: Update[]) {
    if (this.poll) { const poll = this.poll; this.poll = null; poll.cleanup(); poll.resolve(updates); }
    else this.queued.push(updates);
  }
  update(id: number, value: Message) { this.push({ update_id: id, message: value } as Update); }
  callback(id: number, remoteId: number, action: string, patch: Record<string, unknown> = {}) {
    const remote = structuredClone(this.remote.get(remoteId)!);
    const data = remote.reply_markup!.inline_keyboard.flat().find(button => "callback_data" in button && button.callback_data.endsWith(`:${action}`));
    if (!data || !("callback_data" in data)) throw new Error(`Missing test callback ${action}`);
    this.push({ update_id: id, callback_query: { id: `query-${id}`, from: { id: 42, is_bot: false, first_name: "Owner" },
      chat_instance: "chat-instance", message: remote, data: data.callback_data, ...patch } } as unknown as Update);
  }
  readonly fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    if (url.startsWith(`https://api.telegram.org/file/bot${token}/`)) {
      this.calls.push({ method: "download", payload: { url }, init });
      return new Response(this.fileResponse, { status: this.fileStatus, ...(this.fileStatus === 302 ? { headers: { location: "https://attacker.invalid/" } } : {}) });
    }
    const method = url.slice(url.lastIndexOf("/") + 1);
    let payload: Record<string, unknown> = {};
    if (typeof init.body === "string") payload = JSON.parse(init.body) as Record<string, unknown>;
    else if (init.body) {
      this.lastMultipart = await new Response(init.body as ConstructorParameters<typeof Response>[0]).text();
      for (const key of ["chat_id", "message_thread_id"]) {
        const match = new RegExp(`name="${key}"\\r\\n\\r\\n([^\\r]+)`).exec(this.lastMultipart);
        if (match) payload[key] = match[1];
      }
    }
    this.calls.push({ method, payload, init });
    const failure = this.failures.get(method)?.shift();
    if (failure instanceof Error) throw failure;
    if (failure) return Response.json({ ok: false, description: "rejected", ...failure });
    let result: unknown;
    if (method === "getMe") result = { id: 900, is_bot: true, first_name: "Local Bot", username: "local_test_bot", has_topics_enabled: this.topicsEnabled };
    else if (method === "getWebhookInfo") result = { url: this.webhook, pending_update_count: 0 };
    else if (method === "getChat") result = Number(payload.chat_id) > 0 ? { id: Number(payload.chat_id), type: "private", first_name: "Owner" } :
      { id: Number(payload.chat_id), type: "supergroup", title: "Allowed", ...(this.forum ? { is_forum: true } : {}) };
    else if (method === "getUpdates") {
      if (this.queued.length) result = this.queued.shift();
      else {
        const { promise, resolve, reject } = Promise.withResolvers<Update[]>();
        const signal = init.signal;
        const abort = () => { this.poll = null; reject(new Error("aborted")); };
        if (signal?.aborted) abort();
        else {
          signal?.addEventListener("abort", abort, { once: true });
          this.poll = { resolve, cleanup: () => signal?.removeEventListener("abort", abort) };
        }
        result = await promise;
      }
    } else if (method === "sendMessage" || method === "sendDocument") {
      const id = this.nextMessage++;
      result = this.receipt(id, payload);
      this.remote.set(id, result as Message);
    } else if (method === "editMessageText" || method === "editMessageReplyMarkup") {
      const id = Number(payload.message_id);
      const previous = this.remote.get(id);
      if (!previous) return Response.json({ ok: false, error_code: 400, description: "Bad Request: message to edit not found" });
      result = { ...previous, ...(method === "editMessageText" ? { text: payload.text } : {}), reply_markup: payload.reply_markup };
      this.remote.set(id, result as Message);
    } else if (method === "answerCallbackQuery") result = true;
    else if (method === "createForumTopic") result = { message_thread_id: 88, name: payload.name, icon_color: 7322096 };
    else if (method === "getFile") result = { file_id: payload.file_id, file_unique_id: "unique", file_size: 8, file_path: this.filePath };
    else throw new Error(`Unexpected API method ${method}`);
    return Response.json({ ok: true, result });
  }) as typeof fetch;
  private receipt(id: number, payload: Record<string, unknown>): Message {
    const chatId = Number(payload.chat_id);
    return { message_id: id, date: 100, from: { id: 900, is_bot: true, first_name: "Local Bot" },
      chat: chatId > 0 ? { id: chatId, type: "private", first_name: "Owner" } : { id: chatId, type: "supergroup", title: "Allowed", is_forum: true },
      ...(payload.message_thread_id ? { message_thread_id: Number(payload.message_thread_id) } : {}), text: payload.text,
      ...(payload.reply_markup ? { reply_markup: payload.reply_markup } : {}) } as unknown as Message;
  }
}

async function fixture(options: { http?: TelegramHttp; ledger?: Store; message?: (input: Inbound) => Promise<void>; answer?: (id: string, response: DialogResponse, route: Route) => Promise<void>; hasPendingAnswer?: (id: string, route: Route) => boolean; reconnect?: () => Promise<void>; ready?: Promise<void> } = {}) {
  const http = options.http ?? new TelegramHttp();
  const ledger = options.ledger ?? store();
  const received: Inbound[] = [];
  const answers: { id: string; response: DialogResponse; route: Route }[] = [];
  const errors: unknown[] = [];
  const messenger = new TelegramMessenger({ token, ownerId: owner, allowedChatIds: ["-100"],
    store: { getMeta: key => ledger.getMeta(key), setMeta: (key, value) => ledger.setMeta(key, value), hasPendingAnswer: options.hasPendingAnswer },
    fetch: http.fetch, onError: error => errors.push(error) });
  bots.push(messenger);
  await messenger.start({ message: options.message ?? (async input => { received.push(input); }),
    answer: options.answer ?? (async (id, response, route) => { answers.push({ id, response, route }); }), reconnect: options.reconnect, ready: options.ready });
  return { messenger, http, ledger, received, answers, errors };
}

describe("Telegram identity, polling, and durable admission", () => {
  test("stop aborts waiting for startup reconciliation without opening a poll", async () => {
    const gate = Promise.withResolvers<void>();
    const { messenger, http } = await fixture({ ready: gate.promise });
    expect(http.calls.map(call => call.method)).toEqual(["getMe", "getWebhookInfo"]);
    await messenger.stop();
    gate.resolve(); await drain();
    expect(http.calls.map(call => call.method)).toEqual(["getMe", "getWebhookInfo"]);
  });
  test("rejected startup reconciliation cannot fetch, consume, or acknowledge updates", async () => {
    const gate = Promise.withResolvers<void>();
    const { http, ledger, errors } = await fixture({ ready: gate.promise });
    http.update(1, message());
    gate.reject(new Error(`private startup failure ${token}`)); await drain();
    expect(http.calls.map(call => call.method)).toEqual(["getMe", "getWebhookInfo"]);
    expect(ledger.getMeta("telegram:900:offset")).toBeNull();
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).not.toContain(token);
  });
  test("getMe identifies the account; existing webhooks are rejected without setup mutations", async () => {
    const http = new TelegramHttp(); http.webhook = "https://existing.invalid/hook";
    await expect(fixture({ http })).rejects.toThrow("already has a webhook");
    expect(http.calls.map(call => call.method)).toEqual(["getMe", "getWebhookInfo"]);
  });
  test("only direct human-owner messages enter owner DM and allowlisted group/forum routes", async () => {
    const { messenger } = await fixture();
    for (const patch of [
      { from: { id: 43, is_bot: false } }, { from: { id: 42, is_bot: true } }, { from: undefined },
      { sender_chat: { id: -100, type: "supergroup" } }, { forward_origin: { type: "user" } }, { forward_sender_name: "Owner" },
      { via_bot: { id: 42 } }, { business_connection_id: "business" },
      { chat: { id: 43, type: "private" } }, { chat: { id: -101, type: "supergroup" } }, { chat: { id: -100, type: "channel" } },
      { chat: { id: -100, type: "group" }, message_thread_id: 7 },
    ]) expect(messenger.normalize(message(patch))).toBeNull();
    expect(messenger.normalize(message())?.route).toEqual(group);
    expect(messenger.normalize(message({ message_thread_id: 7 }))?.route).toEqual(topic);
    expect(messenger.normalize(message({ chat: { id: 42, type: "private" } }))?.route).toEqual(dm);
    await expect(messenger.send(output("wrong account", { ...group, accountId: "901" }))).rejects.toBeInstanceOf(DeliveryError);
    await expect(messenger.send(output("wrong group", { ...group, guildId: "-101", channelId: "-101" }))).rejects.toBeInstanceOf(DeliveryError);
    await expect(messenger.send(output("wrong DM", { ...dm, channelId: "43" }))).rejects.toBeInstanceOf(DeliveryError);
  });
  test("duplicate and edited IDs are bot/chat/version namespaced and replay-stable", async () => {
    const { messenger } = await fixture();
    const original = messenger.normalize(message())!;
    expect(original.id).toBe("telegram:900:-100:10:original");
    expect(messenger.normalize(message())?.id).toBe(original.id);
    const edited = messenger.normalize(message({ edit_date: 102, text: "edited" }))!;
    expect(edited.id).not.toBe(original.id);
    expect(messenger.normalize(message({ edit_date: 102, text: "edited" }))?.id).toBe(edited.id);
    expect(messenger.normalize(message({ edit_date: 102, text: "different same-second edit" }))?.id).not.toBe(edited.id);
    expect(messenger.normalize(message({ chat: { id: 42, type: "private" } }))?.id).not.toBe(original.id);
  });
  test("one durable message produces one output across replay, and offset follows awaited admission", async () => {
    const ledger = store();
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const { messenger, http } = await fixture({ ledger, message: async input => {
      if (ledger.receive(input, "main")) ledger.queueOutput({ id: `${input.id}:answer`, sourceId: input.id, route: input.route, text: "one answer" });
      entered.resolve(); await gate.promise;
    } });
    http.update(1, message()); await entered.promise;
    expect(ledger.inputs()).toHaveLength(1);
    expect(ledger.getMeta("telegram:900:offset")).toBeNull();
    expect(http.calls.filter(call => call.method === "getUpdates")).toHaveLength(1);
    gate.resolve(); await drain();
    expect(ledger.getMeta("telegram:900:offset")).toBe("2");
    http.update(2, message()); await drain();
    expect(ledger.inputs()).toHaveLength(1);
    const queued = ledger.outputs(); expect(queued).toHaveLength(1);
    expect(ledger.claimOutput(queued[0]!.id)).toBe(true);
    const receipt = await messenger.send(queued[0]!);
    ledger.finishOutput(queued[0]!.id, "sent", receipt);
    expect(ledger.outputs()).toHaveLength(0);
    expect(http.calls.filter(call => call.method === "sendMessage")).toHaveLength(1);
    await messenger.stop();
    const replacement = await fixture({ ledger, http: new TelegramHttp() });
    expect(replacement.http.calls.find(call => call.method === "getUpdates")?.payload.offset).toBe(3);
  });
  test("failed admission preserves cursor for replay on connection restart without mutation retries", async () => {
    let attempts = 0;
    const { messenger, http, ledger, errors } = await fixture({ message: async () => { if (++attempts === 1) throw new Error(`sensitive ${token}`); } });
    http.update(5, message()); await drain();
    expect(ledger.getMeta("telegram:900:offset")).toBeNull();
    expect(String(errors[0])).not.toContain(token);
    await messenger.stop();
    const recovered = await fixture({ ledger, message: async () => { attempts++; } });
    recovered.http.update(5, message()); await drain();
    expect(attempts).toBe(2);
    expect(ledger.getMeta("telegram:900:offset")).toBe("6");
  });
  test("long-idle restart omits a stale high offset and admits a lower randomized update sequence", async () => {
    const ledger = store();
    const original: Inbound = { id: "telegram:900:-100:10:original", route: group, messageId: "10", text: "hello", receivedAt: 100000, attachments: [] };
    ledger.receive(original, "main");
    ledger.setMeta("telegram:900:offset", "900001");
    ledger.setMeta("telegram:900:observed-at", String(Date.now() - 8 * 24 * 60 * 60 * 1000));
    const { http } = await fixture({ ledger, message: async input => { ledger.receive(input, "main"); } });
    expect(http.calls.find(call => call.method === "getUpdates")!.payload.offset).toBeUndefined();
    http.push({ update_id: 7, message: message() } as Update, { update_id: 8, message: message({ message_id: 11, text: "new epoch" }) } as Update);
    await drain();
    expect(ledger.inputs().map(input => input.messageId)).toEqual(["10", "11"]);
    expect(ledger.getMeta("telegram:900:offset")).toBe("9");
    expect(Number(ledger.getMeta("telegram:900:observed-at"))).toBeGreaterThan(Date.now() - 60000);
  });
  test("a live idle poll drops its expired offset before receiving a new sequence", async () => {
    const ledger = store();
    ledger.setMeta("telegram:900:offset", "900001");
    ledger.setMeta("telegram:900:observed-at", String(Date.now()));
    const { http, received } = await fixture({ ledger });
    expect(http.calls.find(call => call.method === "getUpdates")!.payload.offset).toBe(900001);
    ledger.setMeta("telegram:900:observed-at", String(Date.now() - 24 * 60 * 60 * 1000 - 1));
    http.push(); await drain();
    expect(http.calls.filter(call => call.method === "getUpdates").at(-1)!.payload.offset).toBeUndefined();
    http.update(7, message()); await drain();
    expect(received).toHaveLength(1);
    expect(ledger.getMeta("telegram:900:offset")).toBe("8");
  });
  test("a cursor without durable age metadata never acknowledges an unknown sequence epoch", async () => {
    const ledger = store(); ledger.setMeta("telegram:900:offset", "900001");
    const { http } = await fixture({ ledger });
    expect(http.calls.find(call => call.method === "getUpdates")!.payload.offset).toBeUndefined();
  });
  test("stop aborts an outstanding poll and history absence is explicit", async () => {
    const { messenger, ledger } = await fixture();
    expect(await messenger.fetchAfter(topic, "10")).toBeNull();
    await messenger.stop();
    expect(ledger.getMeta("telegram:900:offset")).toBeNull();
  });
  test("a competing poll conflict stops intake without stealing transport or acknowledging updates", async () => {
    const http = new TelegramHttp();
    http.fail("getUpdates", { error_code: 409, description: "Conflict: another poller" });
    const { messenger, ledger, errors } = await fixture({ http });
    await drain();
    expect(errors).toHaveLength(1);
    expect(ledger.getMeta("telegram:900:offset")).toBeNull();
    expect(http.calls.map(call => call.method)).toEqual(["getMe", "getWebhookInfo", "getUpdates"]);
    await messenger.stop();
  });
  test("transient read failure reconnects and replays the unchanged durable offset", async () => {
    // Exercise the real abortable production backoff as part of SDK polling
    // integration; await admission itself, never a guessed wall-clock sleep.
    const http = new TelegramHttp(); const ledger = store();
    ledger.setMeta("telegram:900:offset", "8");
    ledger.setMeta("telegram:900:observed-at", String(Date.now()));
    http.fail("getUpdates", new Error("temporary read failure"));
    const admitted = Promise.withResolvers<void>();
    let reconnects = 0;
    await fixture({ http, ledger, reconnect: async () => { reconnects++; }, message: async input => { ledger.receive(input, "main"); admitted.resolve(); } });
    http.update(8, message());
    await admitted.promise; await drain();
    expect(reconnects).toBe(1);
    expect(http.calls.filter(call => call.method === "getUpdates").slice(0, 2).map(call => call.payload.offset)).toEqual([8, 8]);
    expect(ledger.getMeta("telegram:900:offset")).toBe("9");
    expect(http.calls.some(call => call.method === "deleteWebhook")).toBe(false);
  });
});

describe("Telegram output, topics, and attachment credentials", () => {
  test("plain output disables previews/paid broadcasts and uses a single document for oversized text", async () => {
    const { messenger, http } = await fixture();
    await messenger.send(output("**not markdown** https://example.invalid", topic));
    const sent = http.calls.find(call => call.method === "sendMessage")!;
    expect(sent.payload.parse_mode).toBeUndefined();
    expect(sent.payload.link_preview_options).toEqual({ is_disabled: true });
    expect(sent.payload.allow_paid_broadcast).toBe(false);
    expect(sent.payload.message_thread_id).toBe(7);
    await messenger.send(output("x".repeat(4097), topic));
    expect(http.calls.filter(call => call.method === "sendDocument")).toHaveLength(1);
    expect(http.calls.filter(call => call.method === "sendMessage")).toHaveLength(1);
    expect(http.lastMultipart).toContain("x".repeat(4097));
  });
  test("ambiguous writes are uncertain and 429 is a known rejection, neither automatically retries", async () => {
    const { messenger, http } = await fixture();
    http.fail("sendMessage", new Error(`connection lost ${token}`));
    try { await messenger.send(output("once")); throw new Error("expected failure"); }
    catch (error) { expect(error).toBeInstanceOf(DeliveryError); expect((error as DeliveryError).certainty).toBe("uncertain"); expect(String(error)).not.toContain(token); }
    expect(http.calls.filter(call => call.method === "sendMessage")).toHaveLength(1);
    http.fail("sendMessage", { error_code: 429, parameters: { retry_after: 2 } });
    try { await messenger.send(output("later")); throw new Error("expected failure"); }
    catch (error) { expect((error as DeliveryError).certainty).toBe("rejected"); expect((error as DeliveryError).retryAfterMs).toBe(2000); }
    expect(http.calls.filter(call => call.method === "sendMessage")).toHaveLength(2);
    expect(telegramDeliveryError({ error_code: 500 }).certainty).toBe("uncertain");
  });
  test("creates only real supported forum topics and never manufactures a topic ID", async () => {
    const { messenger, http } = await fixture();
    expect(await messenger.createThread(group, "Independent work")).toEqual({ ...group, threadId: "88" });
    await expect(messenger.createThread(topic, "Nested")).rejects.toThrow("cannot nest");
    await expect(messenger.createThread(dm, "No forum mode")).rejects.toThrow("does not support");
    http.forum = false;
    await expect(messenger.createThread(group, "Normal group")).rejects.toThrow("does not support");
    expect(http.calls.filter(call => call.method === "createForumTopic")).toHaveLength(1);
  });
  test("caption/photo/document/audio/video retain metadata without token-bearing URLs", async () => {
    const { messenger } = await fixture();
    const file = { file_id: "file_1", file_unique_id: "unique", file_size: 8, file_name: "original.txt", mime_type: "text/plain" };
    for (const kind of ["document", "audio", "video"]) {
      const input = messenger.normalize(message({ text: undefined, caption: "caption", [kind]: file }))!;
      expect(input.text).toBe("caption");
      expect(input.attachments[0]).toEqual({ id: "file_1", name: "original.txt", url: "telegram-file:file_1", size: 8, contentType: "text/plain" });
      expect(JSON.stringify(input)).not.toContain(token);
    }
    const input = messenger.normalize(message({ text: undefined, photo: [
      { file_id: "small", file_unique_id: "s", width: 10, height: 10, file_size: 1 },
      { file_id: "large", file_unique_id: "l", width: 100, height: 100, file_size: 8 },
    ] }))!;
    expect(input.attachments[0]?.id).toBe("large");
  });
  test("download requires admitted account/route/resource and exact safe Telegram file path", async () => {
    const { messenger, http, received } = await fixture();
    http.update(1, message({ document: { file_id: "file_1", file_unique_id: "unique", file_size: 8, file_name: "original.txt", mime_type: "text/plain" } }));
    await drain();
    const attachment = received[0]!.attachments[0]!;
    const signal = new AbortController().signal;
    expect(await (await messenger.openAttachment(group, attachment, signal)).text()).toBe("contents");
    const download = http.calls.find(call => call.method === "download")!;
    expect(download.payload.url).toBe(`https://api.telegram.org/file/bot${token}/documents/file_1.txt`);
    expect(download.init.redirect).toBe("error");
    expect(download.init.signal).toBe(signal);
    for (const [destination, file] of [[{ ...group, accountId: "other" }, attachment], [topic, attachment], [group, { ...attachment, url: "https://attacker.invalid/file" }], [group, { ...attachment, id: "foreign", url: "telegram-file:foreign" }]] as const) {
      await expect(messenger.openAttachment(destination, file, signal)).rejects.toBeInstanceOf(DeliveryError);
    }
    for (const path of ["../secret", "documents/../secret", "https://attacker.invalid/file", "/absolute", "documents/%2e%2e/secret", "documents/file?token=bad", "documents/./file"]) {
      http.filePath = path;
      await expect(messenger.openAttachment(group, attachment, signal)).rejects.toThrow("unsafe");
    }
    expect(http.calls.filter(call => call.method === "download")).toHaveLength(1);
    http.filePath = "documents/file_1.txt"; http.fileStatus = 302;
    await expect(messenger.openAttachment(group, attachment, signal)).rejects.toThrow("redirects");
  });
});

describe("Telegram approvals and exact-card interaction", () => {
  test("a durable answer received without a head survives exact native re-presentation and replays once without reopening its card", async () => {
    const root = await mkdtemp(join(await realpath("/tmp"), "otg-"));
    const config: Config = { path: join(root, "config.json"), stateDir: root, headCwd: root,
      command: [process.execPath], maxHosts: 2, maxSubagents: 4, idleMs: 60_000,
      telegram: { tokenEnv: "TELEGRAM_TEST_TOKEN", ownerId: owner, allowedChatIds: ["-100"] } };
    const gateway = new GatewayStore(root);
    const http = new TelegramHttp();
    const errors: unknown[] = [];
    const messenger = new TelegramMessenger({ token, ownerId: owner, allowedChatIds: ["-100"], store: gateway,
      fetch: http.fetch, onError: error => errors.push(error) });
    const server = new GatewayServer({ socketPath: gatewayPaths(config).socketPath, store: gateway, messenger,
      authorizeHead: async pid => { if (pid !== process.pid) throw new Error("Foreign fixture head"); },
      status: (): GatewayStatus => ({ gateway: { pid: process.pid, ready: true, admissionReady: server.ready,
        pendingEvents: gateway.pending(), stopping: false }, head: { pid: process.pid, ready: server.headReady,
        connected: server.connected, socketPath: hostPaths(config, "main").socketPath, error: null } }),
      stop: async () => {}, onError: error => errors.push(error) });
    let runtime: Superagent | undefined;
    let headStore: Store | undefined;
    try {
      await mkdir(join(root, "run"), { mode: 0o700 });
      await server.listen();
      await messenger.start({ ready: server.initialReady.promise,
        message: async input => { gateway.admit({ kind: "message", input }); server.deliver(); },
        answer: async (approvalId, response, route) => { gateway.admit({ kind: "answer", approvalId, response, route }); server.deliver(); },
      });
      headStore = new Store(join(root, "coordination.sqlite"));
      const originalRoute = { ...dm, topicId: "original-logical-topic" };
      const source: Inbound = { id: "original-source", messageId: "1", route: originalRoute, text: "Original task", receivedAt: 100, attachments: [] };
      headStore.receive(source, null);
      const paths = hostPaths(config, "lane");
      headStore.createLane({ id: "lane", title: "Original lane", route: originalRoute, cwd: root, repoRoot: null,
        brief: "Original task", acceptance: [], model: { provider: "fixture", id: "chat" }, modelReason: "Explicit fixture model",
        modelPreset: null, modelPresetSnapshot: null, workState: "open", runtimeState: "running",
        sessionFile: paths.sessionFile, sessionId: "session-lane", socketPath: paths.socketPath,
        generation: 3, pid: process.pid, createdAt: 100, lastActivityAt: 100, result: null }, source.id);
      headStore.settle(source.id, "done");
      const nativeRequest = { type: "extension_ui_request", id: "original-native-request", method: "input", title: "Exact answer" };
      const lane = new ApprovalHost(paths.sessionFile, "session-lane", [nativeRequest]);
      const main = new ApprovalHost(hostPaths(config, "main").sessionFile, "session-main");
      const createHead = (ledger: Store) => {
        const saved = process.env.OMP_SUPERAGENT_GATEWAY_TOKEN;
        process.env.OMP_SUPERAGENT_GATEWAY_TOKEN = gateway.token();
        let client;
        try { client = createGatewayMessenger(config); }
        finally {
          if (saved === undefined) delete process.env.OMP_SUPERAGENT_GATEWAY_TOKEN;
          else process.env.OMP_SUPERAGENT_GATEWAY_TOKEN = saved;
        }
        return new Superagent(config, ledger, client, join(root, "unused-extension.ts"), error => errors.push(error), {
          connect: async path => {
            if (path === paths.socketPath) return lane;
            if (path === hostPaths(config, "main").socketPath) return main;
            throw new Error("Unexpected native endpoint");
          },
          startHost: async () => { throw new Error("Recovery must adopt the original native hosts"); },
        });
      };
      runtime = createHead(headStore);
      await runtime.start();
      await eventually(() => server.headReady);
      const original = headStore.approvals("lane")[0]!;
      const id = Number(original.remoteId);
      const card = structuredClone(http.remote.get(id)!);
      const control = card.reply_markup!.inline_keyboard.flat()[0]! as { callback_data: string };
      const stateKey = `telegram:900:approval:${control.callback_data.split(":")[1]}`;
      await runtime.stop(); runtime = undefined; headStore = undefined;
      await eventually(() => !server.connected);

      const response = { value: "  exact queued answer\nwith original whitespace  " };
      http.update(1, message({ chat: { id: 42, type: "private" }, text: response.value, reply_to_message: card }));
      await eventually(() => gateway.getMeta("telegram:900:offset") === "2");
      expect(gateway.next()?.event).toEqual({ kind: "answer", approvalId: original.id, response, route: originalRoute });
      expect(JSON.parse(gateway.getMeta(stateKey)!)).toMatchObject({ active: false, answers: [], selected: [] });
      expect(gateway.getMeta(stateKey)).not.toContain("exact queued answer");
      expect(http.remote.get(id)!.reply_markup?.inline_keyboard).toEqual([]);
      expect(lane.state.pendingUiRequests).toEqual([nativeRequest]);
      expect(lane.responses).toEqual([]);
      for (const changed of [
        { generation: original.generation + 1 }, { target: "other-lane" }, { requestId: "other-request" },
        { route: { ...originalRoute, topicId: "other-topic" } }, { request: { ...nativeRequest, title: "Changed request" } },
        { remoteId: String(id + 1) },
      ]) await expect(messenger.showApproval({ ...original, ...changed })).rejects.toBeInstanceOf(DeliveryError);
      expect(await messenger.showApproval(original)).toBe(String(id));
      expect(await messenger.showApproval(original)).toBe(String(id));
      expect(lane.responses).toEqual([]);
      expect(JSON.parse(gateway.getMeta(stateKey)!).active).toBe(false);

      headStore = new Store(join(root, "coordination.sqlite"));
      runtime = createHead(headStore);
      await runtime.start();
      await eventually(() => gateway.pending() === 0);
      expect(lane.responses).toEqual([{ id: nativeRequest.id, response }]);
      expect(lane.state.pendingUiRequests).toEqual([]);
      expect(headStore.approval(original.id)).toMatchObject({ state: "answered", generation: 3, route: originalRoute, remoteId: String(id) });
      expect(http.calls.filter(call => call.method === "sendMessage")).toHaveLength(1);
      expect(http.calls.filter(call => call.method === "editMessageText")).toHaveLength(0);
      expect(http.remote.get(id)!.reply_markup?.inline_keyboard).toEqual([]);
      await expect(messenger.showApproval(original)).rejects.toBeInstanceOf(DeliveryError);
      http.update(2, message({ message_id: 11, chat: { id: 42, type: "private" }, text: "late answer", reply_to_message: structuredClone(http.remote.get(id)!) }));
      http.push({ update_id: 3, callback_query: { id: "late-cancel", from: { id: 42, is_bot: false, first_name: "Owner" },
        chat_instance: "original-chat", message: card, data: control.callback_data } } as Update);
      await eventually(() => gateway.getMeta("telegram:900:offset") === "4");
      expect(gateway.pending()).toBe(0);
      expect(headStore.input(source.id)).toMatchObject({ state: "done", route: originalRoute });
      expect(headStore.input("telegram:900:42:11:original")).toBeNull();
      expect(headStore.inputs()).toEqual([]);
      expect(lane.responses).toEqual([{ id: nativeRequest.id, response }]);
      expect(errors).toEqual([]);
    } finally {
      if (runtime) await runtime.stop();
      else headStore?.close();
      await messenger.stop();
      await server.close();
      gateway.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  test("queued restart callbacks wait until their original approval has been reconciled", async () => {
    const http = new TelegramHttp(); const ledger = store();
    const first = await fixture({ http, ledger });
    const a = approval({ route: { ...dm, topicId: "original" } });
    const id = await first.messenger.showApproval(a);
    await first.messenger.stop();
    const gate = Promise.withResolvers<void>();
    const resumed = await fixture({ http, ledger, ready: gate.promise });
    const pollsBefore = http.calls.filter(call => call.method === "getUpdates").length;
    http.callback(1, Number(id), "yes"); await drain();
    expect(http.calls.filter(call => call.method === "getUpdates")).toHaveLength(pollsBefore);
    expect(http.calls.filter(call => call.method === "answerCallbackQuery")).toHaveLength(0);
    expect(ledger.getMeta("telegram:900:offset")).toBeNull();
    expect(resumed.answers).toHaveLength(0);
    await resumed.messenger.showApproval({ ...a, remoteId: id });
    gate.resolve(); await drain();
    expect(resumed.answers).toEqual([{ id: a.id, response: { confirmed: true }, route: a.route }]);
    expect(ledger.getMeta("telegram:900:offset")).toBe("2");
  });
  test("a pending queue row cannot reopen a closed native tombstone without a final-answer attempt", async () => {
    const http = new TelegramHttp(); const ledger = store();
    const first = await fixture({ http, ledger, hasPendingAnswer: () => true });
    const a = approval();
    const id = await first.messenger.showApproval(a);
    await first.messenger.dismissApproval({ ...a, remoteId: id });
    await first.messenger.stop();
    const restarted = await fixture({ http, ledger, hasPendingAnswer: () => true });
    await expect(restarted.messenger.showApproval({ ...a, remoteId: id })).rejects.toThrow("already been answered");
    expect(http.calls.filter(call => call.method === "sendMessage")).toHaveLength(1);
    expect(http.calls.filter(call => call.method === "editMessageText")).toHaveLength(0);
    expect(http.remote.get(Number(id))!.reply_markup?.inline_keyboard).toEqual([]);
    expect(restarted.answers).toEqual([]);
  });
  test("an unadmitted final answer remains uncertain and cannot masquerade as a durable queued response", async () => {
    const { messenger, http, ledger, errors } = await fixture({ hasPendingAnswer: () => false,
      answer: async () => { throw new Error(`private admission failure ${token}`); } });
    const a = approval();
    const id = Number(await messenger.showApproval(a));
    http.callback(1, id, "yes"); await drain();
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).not.toContain(token);
    expect(ledger.getMeta("telegram:900:offset")).toBeNull();
    expect(http.calls.filter(call => call.method === "answerCallbackQuery")).toHaveLength(0);
    await expect(messenger.showApproval({ ...a, remoteId: String(id) })).rejects.toThrow("unresolved outcome");
    expect(http.calls.filter(call => call.method === "sendMessage")).toHaveLength(1);
    expect(http.calls.filter(call => call.method === "editMessageText")).toHaveLength(0);
  });
  test("closed-card replies remain rejected without inline controls after topic switches and restart", async () => {
    const http = new TelegramHttp(); const ledger = store();
    const first = await fixture({ http, ledger });
    const a = approval({ route: { ...dm, topicId: "original" }, request: { method: "input", title: "Respond" } });
    const id = Number(await first.messenger.showApproval(a));
    http.update(1, message({ chat: { id: 42, type: "private" }, text: "original answer", reply_to_message: structuredClone(http.remote.get(id)!) })); await drain();
    expect(first.answers[0]?.response).toEqual({ value: "original answer" });
    const closed = structuredClone(http.remote.get(id)!);
    expect(closed.reply_markup?.inline_keyboard).toEqual([]);
    http.update(2, message({ message_id: 11, chat: { id: 42, type: "private" }, text: "/new different topic" })); await drain();
    http.update(3, message({ message_id: 12, chat: { id: 42, type: "private" }, text: "late approval text", reply_to_message: closed })); await drain();
    expect(first.received.map(input => input.text)).toEqual(["/new different topic"]);
    await first.messenger.stop();
    const restarted = await fixture({ http, ledger });
    http.update(4, message({ message_id: 13, chat: { id: 42, type: "private" }, text: "late after restart", reply_to_message: closed })); await drain();
    expect(restarted.received).toHaveLength(0);
    expect(restarted.answers).toHaveLength(0);
    // A physical group receipt with the same message number is not this DM card.
    http.update(5, message({ message_id: 14, text: "ordinary group reply", reply_to_message: { ...closed, chat: { id: -100, type: "supergroup", title: "Allowed", is_forum: true } } })); await drain();
    expect(restarted.received.map(input => input.text)).toEqual(["ordinary group reply"]);
  });
  test("closing a dialog discards persisted partial free-text answers and retains only receipt safety state", async () => {
    const { messenger, http, ledger } = await fixture();
    const id = Number(await messenger.showApproval(approval({ request: { method: "ask", questions: [
      { id: "q", question: "Free response", options: [] },
    ] } })));
    const card = structuredClone(http.remote.get(id)!);
    const button = card.reply_markup!.inline_keyboard.flat()[0]!;
    if (!("callback_data" in button)) throw new Error("Expected a callback control");
    const stateKey = `telegram:900:approval:${button.callback_data.split(":")[1]}`;
    http.update(1, message({ message_thread_id: 7, text: "temporary full answer", reply_to_message: card })); await drain();
    expect(ledger.getMeta(stateKey)).toContain("temporary full answer");
    http.callback(2, id, "next-0"); await drain();
    expect(ledger.getMeta(stateKey)).not.toContain("temporary full answer");
    expect(JSON.parse(ledger.getMeta(stateKey)!)).toMatchObject({ active: false, answers: [], selected: [] });
  });
  test("concurrent approval publication sends exactly one card", async () => {
    const { messenger, http } = await fixture();
    const a = approval();
    const receipts = await Promise.all([messenger.showApproval(a), messenger.showApproval(a), messenger.showApproval(a)]);
    expect(new Set(receipts).size).toBe(1);
    expect(http.calls.filter(call => call.method === "sendMessage")).toHaveLength(1);
  });
  test("controls bind original topic/generation/card/from/chat/thread and answer only once", async () => {
    const { messenger, http, answers } = await fixture();
    const original = approval({ route: { ...dm, topicId: "original-logical-topic" } });
    const id = Number(await messenger.showApproval(original));
    const card = http.remote.get(id)!;
    for (const button of card.reply_markup!.inline_keyboard.flat()) if ("callback_data" in button) expect(Buffer.byteLength(button.callback_data)).toBeLessThanOrEqual(64);
    http.callback(1, id, "yes", { from: { id: 43, is_bot: false } }); await drain();
    http.callback(2, id, "yes", { message: { ...card, message_id: id + 1 } }); await drain();
    http.callback(3, id, "yes", { message: { ...card, chat: { id: 43, type: "private" } } }); await drain();
    expect(answers).toHaveLength(0);
    http.update(4, message({ chat: { id: 42, type: "private" }, text: "/new changed-topic" })); await drain();
    const duplicate = { update_id: 5, callback_query: { id: "duplicate", from: { id: 42, is_bot: false }, chat_instance: "chat", message: card,
      data: card.reply_markup!.inline_keyboard[0]![0] && (card.reply_markup!.inline_keyboard[0]![0] as { callback_data: string }).callback_data } } as unknown as Update;
    http.push(duplicate, { ...duplicate, update_id: 6 }); await drain();
    expect(answers).toEqual([{ id: original.id, response: { confirmed: true }, route: original.route }]);
  });
  test("input and editor accept only exact-card replies, preserve exact values and cancel natively", async () => {
    const { messenger, http, received, answers } = await fixture();
    let updateId = 0;
    for (const method of ["input", "editor"] as const) {
      const a = approval({ id: method, requestId: method, request: { method, title: "Enter response", prefill: "existing" } });
      const id = Number(await messenger.showApproval(a));
      http.update(++updateId, message({ message_thread_id: 7, text: "ordinary input" })); await drain();
      expect(answers).toHaveLength(method === "input" ? 0 : 1);
      http.update(++updateId, message({ message_thread_id: 7, text: "  exact\nvalue  ", reply_to_message: structuredClone(http.remote.get(id)!) })); await drain();
      expect(answers.at(-1)?.response).toEqual({ value: "  exact\nvalue  " });
    }
    expect(received).toHaveLength(2);
    const id = Number(await messenger.showApproval(approval({ id: "cancel", requestId: "cancel" })));
    http.callback(300, id, "cancel"); await drain();
    expect(answers.at(-1)?.response).toEqual({ cancelled: true });
  });
  test("select returns native exact label and keeps host-owned check markers", async () => {
    const { messenger, http, answers } = await fixture();
    const id = Number(await messenger.showApproval(approval({ request: { method: "select", title: "Choose", options: ["One", "Two"], selectionMarker: "checkbox", checkedIndices: [1], markableCount: 2 } })));
    expect(http.remote.get(id)!.text).toContain("[x] Two");
    http.callback(1, id, "pick-1"); await drain();
    expect(answers[0]?.response).toEqual({ value: "Two" });
  });
  test("forum callbacks cannot move between physical threads or bot authors", async () => {
    const { messenger, http, answers } = await fixture();
    const id = Number(await messenger.showApproval(approval()));
    const card = structuredClone(http.remote.get(id)!);
    http.callback(1, id, "yes", { message: { ...card, message_thread_id: 8 } }); await drain();
    http.callback(2, id, "yes", { message: { ...card, from: { id: 901, is_bot: true } } }); await drain();
    expect(answers).toHaveLength(0);
    http.callback(3, id, "yes"); await drain();
    expect(answers[0]?.route).toEqual(topic);
  });
  test("approval replay identity uses callback query IDs rather than recyclable numeric update IDs", async () => {
    const { messenger, http, ledger, answers } = await fixture();
    const id = Number(await messenger.showApproval(approval({ request: { method: "ask", questions: [
      { id: "q", question: "Choose several", multi: true, options: [{ label: "A" }, { label: "B" }] },
    ] } })));
    http.callback(7, id, "q0-0"); await drain();
    ledger.setMeta("telegram:900:observed-at", String(Date.now() - 8 * 24 * 60 * 60 * 1000));
    http.push(); await drain();
    http.callback(7, id, "q0-1", { id: "different-query-in-new-epoch" }); await drain();
    http.callback(8, id, "next-0"); await drain();
    expect(answers[0]?.response).toEqual({ answers: [{ id: "q", selectedOptions: ["A", "B"] }] });
  });
  test("ask multi/free-text progress survives restart and re-edits the same authoritative card", async () => {
    const http = new TelegramHttp(); const ledger = store();
    const first = await fixture({ http, ledger });
    const a = approval({ request: { method: "ask", questions: [
      { id: "q1", question: "Choose several", multi: true, options: [{ label: "A" }, { label: "B" }] },
      { id: "q2", question: "Choose or type", options: [] },
    ] } });
    const id = Number(await first.messenger.showApproval(a));
    http.callback(1, id, "q0-0"); await drain();
    http.callback(2, id, "q0-1"); await drain();
    http.update(3, message({ message_thread_id: 7, text: "plus free text", reply_to_message: structuredClone(http.remote.get(id)!) })); await drain();
    await first.messenger.stop();
    const second = await fixture({ http, ledger });
    expect(await second.messenger.showApproval({ ...a, remoteId: String(id) })).toBe(String(id));
    expect(http.calls.filter(call => call.method === "sendMessage")).toHaveLength(1);
    expect(http.calls.filter(call => call.method === "editMessageText").length).toBeGreaterThanOrEqual(4);
    http.callback(4, id, "next-0"); await drain();
    http.update(5, message({ message_thread_id: 7, text: "second answer", reply_to_message: structuredClone(http.remote.get(id)!) })); await drain();
    http.callback(6, id, "next-1"); await drain();
    expect(second.answers[0]?.response).toEqual({ answers: [
      { id: "q1", selectedOptions: ["A", "B"], customInput: "plus free text" },
      { id: "q2", selectedOptions: [], customInput: "second answer" },
    ] });
  });
  test("missing/uncertain edits never send a replacement card; ambiguous initial send cannot resend", async () => {
    const { messenger, http } = await fixture();
    await expect(messenger.showApproval(approval({ remoteId: "999" }))).rejects.toBeInstanceOf(DeliveryError);
    expect(http.calls.filter(call => call.method === "sendMessage")).toHaveLength(0);
    const a = approval({ id: "uncertain", requestId: "uncertain" });
    http.fail("sendMessage", new Error("connection lost after write"));
    await expect(messenger.showApproval(a)).rejects.toBeInstanceOf(DeliveryError);
    await expect(messenger.showApproval(a)).rejects.toBeInstanceOf(DeliveryError);
    expect(http.calls.filter(call => call.method === "sendMessage")).toHaveLength(1);
  });
  test("an uncertain restart edit stays on its original receipt and cannot create a replacement", async () => {
    const http = new TelegramHttp(); const ledger = store();
    const first = await fixture({ http, ledger });
    const a = approval();
    const id = await first.messenger.showApproval(a);
    await first.messenger.stop();
    const restarted = await fixture({ http, ledger, hasPendingAnswer: () => true });
    http.fail("editMessageText", new Error("lost response after editing"));
    await expect(restarted.messenger.showApproval({ ...a, remoteId: id })).rejects.toBeInstanceOf(DeliveryError);
    await expect(restarted.messenger.showApproval({ ...a, remoteId: id })).rejects.toBeInstanceOf(DeliveryError);
    expect(http.calls.filter(call => call.method === "sendMessage")).toHaveLength(1);
    expect(http.calls.filter(call => call.method === "editMessageText")).toHaveLength(1);
  });
  test("secret and oversized dialog requests cancel native interaction without exposing request values", async () => {
    const { messenger, http, answers } = await fixture();
    await messenger.showApproval(approval({ request: { method: "input", title: "TOP SECRET TITLE", prefill: "sensitive value", secret: true } }));
    await messenger.showApproval(approval({ id: "large", requestId: "large", request: { method: "confirm", title: "Huge", message: "x".repeat(4097) } }));
    expect(answers.map(value => value.response)).toEqual([{ cancelled: true }, { cancelled: true }]);
    for (const call of http.calls.filter(call => call.method === "sendMessage")) {
      expect(JSON.stringify(call.payload)).not.toContain("sensitive value");
      expect(JSON.stringify(call.payload)).not.toContain("TOP SECRET TITLE");
    }
  });
  test("approval acknowledgement and offset follow awaited native processing", async () => {
    const gate = Promise.withResolvers<void>(); const entered = Promise.withResolvers<void>();
    const { messenger, http, ledger } = await fixture({ answer: async () => { entered.resolve(); await gate.promise; } });
    const id = Number(await messenger.showApproval(approval()));
    http.callback(1, id, "yes"); await entered.promise;
    expect(ledger.getMeta("telegram:900:offset")).toBeNull();
    expect(http.calls.filter(call => call.method === "answerCallbackQuery")).toHaveLength(0);
    gate.resolve(); await drain();
    expect(ledger.getMeta("telegram:900:offset")).toBe("2");
    expect(http.calls.filter(call => call.method === "answerCallbackQuery")).toHaveLength(1);
  });
});
