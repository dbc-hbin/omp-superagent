import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { WebClientOptions } from "@slack/web-api";
import { SlackMessenger, type SlackMessengerOptions } from "../src/slack.ts";
import { DeliveryError } from "../src/delivery.ts";
import type { Approval, DialogResponse, Inbound, Messenger, OutputRecord, Route } from "../src/contracts.ts";

type Data = Record<string, any>;
type Handlers = Parameters<Messenger["start"]>[0];
const team = "TOWN";
const owner = "UOWNER";
const bot = "UBOT";
const botId = "BBOT";
const route: Route = { platform: "slack", accountId: `${team}:${bot}`, authorityId: owner, guildId: team, channelId: "CALLOWED", threadId: null };
const dm: Route = { ...route, guildId: null, channelId: "DOWNER" };
const output = (text: string, destination = route): OutputRecord => ({ id: "output", sourceId: "input", route: destination, text, state: "sending", remoteId: null, error: null });
const approval = (patch: Partial<Approval> = {}): Approval => ({ id: "approval-secret-not-in-controls", target: "lane", generation: 7, requestId: "native-request", route, request: { method: "confirm", title: "Deploy?", message: "External action" }, state: "pending", remoteId: null, ...patch });
const message = (ts = "1000.000001", patch: Data = {}): Data => ({ type: "message", user: owner, team, text: "hello", ts, ...patch });
const clone = <T>(value: T): T => structuredClone(value);
const drain = async () => { const { promise, resolve } = Promise.withResolvers<void>(); setImmediate(resolve); await promise; };

/** Real WebClient serialization/error handling, with no external HTTP endpoints. */
class SlackHTTP {
  calls: { method: string; args: Data; authorization: string | undefined; redirect: unknown }[] = [];
  remote = new Map<string, Data>();
  channels = new Map<string, Data>([
    ["CALLOWED", { id: "CALLOWED", is_channel: true, is_im: false, is_mpim: false, is_member: true, context_team_id: team }],
    ["DOWNER", { id: "DOWNER", is_im: true, is_mpim: false, user: owner, context_team_id: team }],
    ["DOTHER", { id: "DOTHER", is_im: true, is_mpim: false, user: "UOTHER", context_team_id: team }],
    ["GMPIM", { id: "GMPIM", is_im: false, is_mpim: true, is_member: true, context_team_id: team }],
  ]);
  behavior = new Map<string, (args: Data) => Data | Response | Promise<Data | Response>>();
  external: { url: string; init: RequestInit | undefined }[] = [];
  externalFailure: unknown;
  externalResponse = () => new Response("contents");
  file: Data = {
    id: "FFILE", user: owner, mode: "hosted", is_external: false, size: 8, name: "file.txt", team_id: team,
    shares: { public: { CALLOWED: [{ ts: "1000.000001", team_id: team }] } },
    url_private_download: `https://files.slack.com/files-pri/${team}-FFILE/download/file.txt`,
  };
  views: Data[] = [];
  count = 0;
  fetch: NonNullable<WebClientOptions["fetch"]> = async (input, init) => {
    const method = new URL(input).pathname.split("/").at(-1)!;
    const form = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
    const args: Data = Object.fromEntries(form);
    for (const key of ["blocks", "view", "files"]) if (typeof args[key] === "string") args[key] = JSON.parse(args[key]);
    this.calls.push({ method, args, authorization: init?.headers?.Authorization ?? init?.headers?.authorization, redirect: init?.redirect });
    const custom = this.behavior.get(method);
    let result: Data | Response;
    if (custom) result = await custom(args);
    else if (method === "auth.test") result = { team_id: team, user_id: bot, bot_id: botId };
    else if (method === "users.info") result = { user: { id: owner, team_id: team, is_bot: false, deleted: false } };
    else if (method === "conversations.info") result = { channel: this.channels.get(args.channel) };
    else if (method === "chat.postMessage") {
      const ts = `2000.${String(++this.count).padStart(6, "0")}`;
      const remote = { type: "message", user: bot, bot_id: botId, team, ts, ...clone(args) };
      this.remote.set(`${args.channel}:${ts}`, remote);
      result = { channel: args.channel, ts, message: remote };
    } else if (method === "chat.update") {
      const old = this.remote.get(`${args.channel}:${args.ts}`);
      if (!old) result = { ok: false, error: "message_not_found" };
      else { Object.assign(old, clone(args)); result = { channel: args.channel, ts: args.ts, message: old }; }
    } else if (method === "conversations.history" || method === "conversations.replies") {
      const candidates = [...this.remote].filter(([key]) => key.startsWith(`${args.channel}:`)).map(([, value]) => value);
      const exact = args.oldest === args.latest && args.inclusive === "true";
      result = { messages: candidates.filter(value => exact ? value.ts === args.oldest : method === "conversations.replies" ? value.thread_ts === args.ts || value.ts === args.ts : !value.thread_ts || value.thread_ts === value.ts), has_more: false, response_metadata: { next_cursor: "" } };
    } else if (method === "views.open") { const view = { ...args.view, id: `V${this.views.length + 1}` }; this.views.push(view); result = { view }; }
    else if (method === "files.info") result = { file: this.file };
    else if (method === "files.getUploadURLExternal") result = { file_id: "FOUTPUT", upload_url: "https://files.slack.com/upload/v1/signed-ticket" };
    else if (method === "files.completeUploadExternal") result = { files: [{ id: "FOUTPUT" }] };
    else throw new Error(`Unhandled test API method: ${method}`);
    return result instanceof Response ? result : Response.json({ ok: true, ...result });
  };
  download: NonNullable<SlackMessengerOptions["fetch"]> = async (input, init) => {
    this.external.push({ url: String(input), init });
    if (this.externalFailure) throw this.externalFailure;
    return this.externalResponse();
  };
}

class SocketBoundary extends EventEmitter {
  starts = 0;
  stops = 0;
  async start() { this.starts++; this.emit("connected"); return { ok: true }; }
  async disconnect() { this.stops++; }
}

let envelopeSequence = 0;
function envelope(type: string, body: Data) {
  const done = Promise.withResolvers<void>();
  const value = { type, envelope_id: `fixture-envelope-${++envelopeSequence}`, body, acks: [] as unknown[], async ack(response?: unknown) { value.acks.push(response); done.resolve(); }, done: done.promise };
  return value;
}
const incoming = (event: Data, patch: Data = {}) => envelope("events_api", { type: "event_callback", team_id: team, event_id: "envelope-independent", event: { ...event, channel: "CALLOWED" }, ...patch });

async function fixture(http = new SlackHTTP(), custom: Partial<Handlers> = {}) {
  const socket = new SocketBoundary();
  const received: Inbound[] = [];
  const answers: { id: string; response: DialogResponse; route: Route }[] = [];
  const errors: unknown[] = [];
  let reconnects = 0;
  const messenger = new SlackMessenger({
    botToken: "xoxb-test-private", appToken: "xapp-bootstrap-private", ownerId: owner, teamId: team,
    allowedChannelIds: ["CALLOWED", "GMPIM"], socket: socket as unknown as NonNullable<SlackMessengerOptions["socket"]>,
    webClientOptions: { fetch: http.fetch }, fetch: http.download, onError: error => errors.push(error),
  });
  await messenger.start({ message: async value => { received.push(value); }, answer: async (id, response, route) => { answers.push({ id, response, route }); }, reconnect: async () => { reconnects++; }, ...custom });
  return { messenger, socket, http, received, answers, errors, reconnects: () => reconnects };
}

function click(remote: Data, action: string, patch: Data = {}) {
  const token = (remote.blocks[0].block_id as string).split(":")[1];
  return envelope("interactive", {
    type: "block_actions", team: { id: team }, user: { id: owner, team_id: team },
    channel: { id: remote.channel }, container: { type: "message", channel_id: remote.channel, message_ts: remote.ts },
    message: clone(remote), actions: [{ type: "button", action_id: `omp:${token}:${action}` }], trigger_id: "valid-trigger", ...patch,
  });
}
function submit(view: Data, value: string | null, patch: Data = {}) {
  return envelope("interactive", {
    type: "view_submission", team: { id: team }, user: { id: owner, team_id: team },
    view: { ...clone(view), state: { values: { response: { value: { type: "plain_text_input", value } } } } }, ...patch,
  });
}
function selection(remote: Data, action: string, values: string[], multi = false) {
  const event = click(remote, action);
  const element = event.body.actions[0];
  element.type = multi ? "multi_static_select" : "static_select";
  if (multi) element.selected_options = values.map(value => ({ value }));
  else element.selected_option = values.length ? { value: values[0] } : null;
  return event;
}

describe("Slack authenticated intake and durable ACK", () => {
  test("real SDK auth is bot-token-only, validates bot workspace and active human owner before Socket Mode", async () => {
    for (const patch of [{ team_id: "TOTHER" }, { bot_id: undefined }, { user_id: undefined }]) {
      const http = new SlackHTTP();
      http.behavior.set("auth.test", () => ({ team_id: team, user_id: bot, bot_id: botId, ...patch }));
      await expect(fixture(http)).rejects.toThrow("authentication");
      expect(http.calls.some(call => call.method === "chat.postMessage")).toBe(false);
    }
    for (const patch of [{ team_id: "TOTHER" }, { is_bot: true }, { is_app_user: true }, { deleted: true }]) {
      const http = new SlackHTTP();
      http.behavior.set("users.info", () => ({ user: { id: owner, team_id: team, is_bot: false, ...patch } }));
      await expect(fixture(http)).rejects.toThrow("active human");
    }
    const f = await fixture();
    expect(f.socket.starts).toBe(1);
    expect(f.http.calls.every(call => call.authorization === "Bearer xoxb-test-private" && call.redirect === "error")).toBe(true);
    expect(JSON.stringify(f.http.calls)).not.toContain("xapp-bootstrap-private");
    await f.messenger.stop();
  });

  test("stable original/edit IDs ignore envelope retries and preserve physical root/thread/DM identity", async () => {
    const f = await fixture();
    const original = message();
    const events = [incoming(original), incoming(original, { event_id: "different-envelope" }), incoming({ type: "message", subtype: "message_changed", message: message("1000.000001", { text: "changed", edited: { user: owner, ts: "1001.000001" } }) }), incoming(message("1002.000001", { thread_ts: "1000.000001" })), incoming(message("1003.000001"), { event: { ...message("1003.000001"), channel: "DOWNER", channel_type: "im" } })];
    for (const event of events) { f.socket.emit("slack_event", event); await event.done; }
    expect(f.received).toHaveLength(5);
    expect(f.received[0]!.id).toBe(f.received[1]!.id);
    expect(f.received[2]!.id).not.toBe(f.received[0]!.id);
    expect(f.received[2]!.messageId).toBe("1000.000001");
    expect(f.received[3]!.route).toEqual({ ...route, threadId: "1000.000001" });
    expect(f.received[4]!.route).toEqual(dm);
    expect(f.received[0]!.id).toContain("CALLOWED:1000.000001:original");
    await f.messenger.stop();
  });

  test("owner, workspace, subtypes, bots, group authority, and direct recipient are independently gated", async () => {
    const f = await fixture();
    const events = [
      incoming(message(), { team_id: "TOTHER" }), incoming(message("1000.000002", { user: "UOTHER" })),
      incoming(message("1000.000003", { bot_id: botId })), incoming(message("1000.000004", { subtype: "bot_message" })),
      incoming(message("1000.000005", { subtype: "message_deleted" })), incoming(message("1000.000006", { user_team: "TOTHER" })),
      incoming(message("1000.000007"), { event: { ...message("1000.000007"), channel: "CDENIED" } }),
      incoming(message("1000.000008"), { event: { ...message("1000.000008"), channel: "GMPIM", channel_type: "mpim" } }),
      incoming(message("1000.000009"), { event: { ...message("1000.000009"), channel: "DOTHER", channel_type: "im" } }),
      incoming({ type: "message", subtype: "message_changed", message: message("1000.000010", { edited: { user: "UOTHER", ts: "1001.000001" } }) }),
    ];
    for (const event of events) f.socket.emit("slack_event", event);
    await drain();
    expect(f.received).toEqual([]);
    expect(f.http.calls.some(call => call.method === "conversations.info" && call.args.channel === "CDENIED")).toBe(false);
    expect(events.filter(event => event.acks.length === 0)).toHaveLength(1); // Unauthorized DM lookup fails closed.
    await f.messenger.stop();
  });

  test("ACK follows durable admission; failed admission leaves retryable envelope unacknowledged", async () => {
    const durable = Promise.withResolvers<void>();
    let entered = false;
    const f = await fixture(new SlackHTTP(), { message: async () => { entered = true; await durable.promise; } });
    const event = incoming(message());
    f.socket.emit("slack_event", event);
    await drain();
    expect(entered).toBe(true);
    expect(event.acks).toEqual([]);
    durable.resolve();
    await event.done;
    await f.messenger.stop();
    const failed = await fixture(new SlackHTTP(), { message: async () => { throw new Error("database rejected xoxb-test-private"); } });
    const rejected = incoming(message());
    failed.socket.emit("slack_event", rejected);
    await drain();
    expect(rejected.acks).toEqual([]);
    expect(failed.errors).toHaveLength(1);
    expect(JSON.stringify(failed.errors.map(error => String(error)))).not.toContain("xoxb");
    await failed.messenger.stop();
  });

  test("file intake is token-free and edited attachment refresh does not change revision", async () => {
    const f = await fixture();
    for (const url of ["https://attacker.invalid/a", "https://files.slack.com/refreshed?token=never-store"]) {
      const event = incoming(message("1000.000001", { subtype: "file_share", edited: { user: owner, ts: "1001.000001" }, files: [{ id: "FFILE", user: owner, name: "file.txt", size: 8, mimetype: "text/plain", url_private: url }] }));
      f.socket.emit("slack_event", event); await event.done;
    }
    expect(f.received[0]!.attachments).toEqual([{ id: "FFILE", name: "file.txt", size: 8, contentType: "text/plain", url: "slack-file:FFILE" }]);
    expect(f.received[0]!.id).toBe(f.received[1]!.id);
    expect(JSON.stringify(f.received)).not.toContain("never-store");
    expect(f.http.external).toEqual([]);
    const unsupported = incoming(message("1002.000001", { files: [{ id: "FFOREIGN", user: "UOTHER", name: "other.txt", size: 2 }] }));
    f.socket.emit("slack_event", unsupported); await drain();
    expect(unsupported.acks).toEqual([]);
    expect(f.received).toHaveLength(2);
    expect(String(f.errors[0])).toContain("unsupported or nonowner attachment");
    await f.messenger.stop();
  });

  test("native message control spellings normalize identically during live intake and catchup", async () => {
    const f = await fixture();
    const commands = [
      "!new independent request", "!main", "!stop", "!resume",
      "!model", "!model fixture/efficient", "!effort", "!effort high",
      "!newspaper", "!models", "!effortless",
      "quoted !new request", "quoted !model", " !main", " !effort high",
      "!help", "!status", "!stop head", "!stop lane-example", "!context",
      "!compact preserve the API contract", "!usage", "!model preset", "!model preset high",
      "!helper", "!statusline", "!contextual", "!compacted", "!usages",
      "quoted !help", " !status", "please !compact now", "trailing !usage",
    ];
    for (const [index, text] of commands.entries()) {
      const original = message(`1000.${String(index + 1).padStart(6, "0")}`, { text });
      f.http.remote.set(`CALLOWED:${original.ts}`, original);
      const event = incoming(original); f.socket.emit("slack_event", event); await event.done;
    }
    const expected = [
      "/new independent request", "/main", "/stop", "/resume",
      "/model", "/model fixture/efficient", "/effort", "/effort high",
      "!newspaper", "!models", "!effortless",
      "quoted !new request", "quoted !model", " !main", " !effort high",
      "/help", "/status", "/stop head", "/stop lane-example", "/context",
      "/compact preserve the API contract", "/usage", "/model preset", "/model preset high",
      "!helper", "!statusline", "!contextual", "!compacted", "!usages",
      "quoted !help", " !status", "please !compact now", "trailing !usage",
    ];
    expect(f.received.map(input => input.text)).toEqual(expected);
    const recovered = await f.messenger.fetchAfter(route, "1000.000000");
    expect(recovered.map(input => input.text)).toEqual(expected);
    expect(recovered.map(input => input.id)).toEqual(f.received.map(input => input.id));
    await f.messenger.stop();
  });
});

describe("Slack side effects, exact history, and threads", () => {
  test("short text is untrusted plain text without mentions, parsing, or unfurls", async () => {
    const f = await fixture();
    const text = "<!everyone> <@UOTHER> <https://evil.invalid|link> & :here:";
    const id = await f.messenger.send(output(text));
    const sent = f.http.remote.get(`CALLOWED:${id}`)!;
    expect(sent.blocks[0].text).toEqual({ type: "plain_text", text, emoji: false });
    expect(sent.text).toBe("&lt;!everyone&gt; &lt;@UOTHER&gt; &lt;https://evil.invalid|link&gt; &amp; :here:");
    expect([sent.mrkdwn, sent.link_names, sent.unfurl_links, sent.unfurl_media]).toEqual(["false", "false", "false", "false"]);
    expect(sent.parse).toBe("none");
    for (const invalid of [{ ...route, accountId: "TOTHER:UBOT" }, { ...route, authorityId: "UOTHER" }, { ...route, guildId: "TOTHER" }, { ...dm, channelId: "DOTHER" }, { ...route, channelId: "GMPIM" }, { ...route, channelId: "CDENIED" }]) await expect(f.messenger.send(output("blocked", invalid))).rejects.toBeInstanceOf(DeliveryError);
    expect(f.http.calls.filter(call => call.method === "chat.postMessage")).toHaveLength(1);
    await f.messenger.stop();
  });

  test("escaping cannot expand fallback into Slack's multi-message splitting range", async () => {
    const f = await fixture();
    const text = "<&".repeat(1400);
    const id = await f.messenger.send(output(text));
    const sent = f.http.remote.get(`CALLOWED:${id}`)!;
    expect(sent.text).toBeUndefined();
    expect(sent.blocks.map((block: Data) => block.text.text).join("")).toBe(text);
    expect(f.http.calls.filter(call => call.method === "chat.postMessage")).toHaveLength(1);
    f.http.behavior.set("chat.postMessage", () => ({ channel: "CALLOWED", ts: "2000.999999", response_metadata: { warnings: ["message_truncated"] } }));
    try { await f.messenger.send(output("one")); throw new Error("expected rejection"); }
    catch (error) { expect(error).toBeInstanceOf(DeliveryError); expect((error as DeliveryError).certainty).toBe("uncertain"); }
    await f.messenger.stop();
  });

  test("long output is one supported external upload, no partial messages and no bot token on signed upload", async () => {
    const f = await fixture();
    const text = "<!everyone>\n" + "complete output\n".repeat(500);
    expect(await f.messenger.send(output(text, { ...route, threadId: "1000.000001" }))).toBe("file:FOUTPUT");
    expect(f.http.calls.filter(call => call.method === "chat.postMessage")).toHaveLength(0);
    expect(f.http.calls.filter(call => call.method === "files.getUploadURLExternal")).toHaveLength(1);
    const complete = f.http.calls.find(call => call.method === "files.completeUploadExternal")!.args;
    expect(complete.channel_id).toBe("CALLOWED");
    expect(complete.thread_ts).toBe("1000.000001");
    expect(complete.initial_comment).toBeUndefined();
    expect(Buffer.from(f.http.external[0]!.init!.body as Uint8Array).toString()).toBe(text);
    expect(f.http.external[0]!.init!.headers).toEqual({ "Content-Type": "application/octet-stream" });
    expect(f.http.external[0]!.init!.redirect).toBe("error");
    expect(f.http.calls.some(call => call.method === "files.upload")).toBe(false);
    await expect(f.messenger.send(output("x".repeat(8 * 1024 * 1024 + 1)))).rejects.toThrow("8 MiB");
    await f.messenger.stop();
  });

  test("real SDK never retries mutation uncertainty or known rate rejection; publication failures remain conservative", async () => {
    for (const [behavior, certainty] of [
      [() => { throw new Error("lost socket xoxb-test-private"); }, "uncertain"],
      [() => new Response("too many", { status: 429, headers: { "retry-after": "2" } }), "rejected"],
      [() => ({ ok: false, error: "internal_error" }), "uncertain"],
      [() => ({ ok: false, error: "missing_scope" }), "rejected"],
    ] as const) {
      const http = new SlackHTTP(); http.behavior.set("chat.postMessage", behavior);
      const f = await fixture(http);
      let caught: unknown;
      try { await f.messenger.send(output("one mutation")); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(DeliveryError);
      expect((caught as DeliveryError).certainty).toBe(certainty);
      if ((caught as DeliveryError).message.includes("rate limited")) expect((caught as DeliveryError).retryAfterMs).toBe(2000);
      expect(http.calls.filter(call => call.method === "chat.postMessage")).toHaveLength(1);
      expect(String(caught)).not.toContain("xoxb-test-private");
      await f.messenger.stop();
    }
    const http = new SlackHTTP();
    http.behavior.set("files.completeUploadExternal", () => { throw new Error("connection lost after publication"); });
    const f = await fixture(http);
    try { await f.messenger.send(output("long".repeat(1000))); throw new Error("expected failure"); }
    catch (error) { expect((error as DeliveryError).certainty).toBe("uncertain"); }
    expect(http.calls.filter(call => call.method === "files.completeUploadExternal")).toHaveLength(1);
    await f.messenger.stop();
  });

  test("failed byte upload cannot publish, and an untrusted upload URL is never fetched", async () => {
    const http = new SlackHTTP(); http.externalFailure = new Error("lost before publication");
    const f = await fixture(http);
    await expect(f.messenger.send(output("x".repeat(4000)))).rejects.toThrow("before publication");
    expect(http.calls.some(call => call.method === "files.completeUploadExternal")).toBe(false);
    http.behavior.set("files.getUploadURLExternal", () => ({ file_id: "FOUTPUT", upload_url: "https://attacker.invalid/upload/v1/steal" }));
    await expect(f.messenger.send(output("x".repeat(4000)))).rejects.toThrow("unauthorized upload");
    expect(http.external).toHaveLength(1);
    await f.messenger.stop();
  });

  test("stored root source is verified and reused; no source posts one real root", async () => {
    const f = await fixture();
    f.http.remote.set("CALLOWED:1000.000001", message());
    expect(await f.messenger.createThread(route, "Independent topic", "1000.000001")).toEqual({ ...route, threadId: "1000.000001" });
    expect(f.http.calls.filter(call => call.method === "chat.postMessage")).toHaveLength(0);
    f.http.remote.set("CALLOWED:1000.000002", message("1000.000002", { user: "UOTHER" }));
    f.http.remote.set("CALLOWED:1000.000003", message("1000.000003", { thread_ts: "1000.000001" }));
    for (const source of ["1000.000002", "1000.000003", "1000.000004", "invalid"]) await expect(f.messenger.createThread(route, "topic", source)).rejects.toBeInstanceOf(DeliveryError);
    const created = await f.messenger.createThread(dm, "Actual Slack DM thread");
    expect(created.channelId).toBe("DOWNER");
    expect(created.threadId).toBe("2000.000001");
    await expect(f.messenger.createThread(created, "nested")).rejects.toThrow("cannot nest");
    await f.messenger.stop();
  });

  test("history paginates all stored root routes using exact decimal order without float rounding", async () => {
    const http = new SlackHTTP();
    http.behavior.set("conversations.history", args => args.cursor ? { messages: [message("9999999999999.000001"), message("9999999999999.000002")], has_more: false } : { messages: [message("9999999999999.000003"), message("9999999999999.000004", { thread_ts: "9999999999999.000003" })], has_more: true, response_metadata: { next_cursor: "second-page" } });
    const f = await fixture(http);
    expect((await f.messenger.fetchAfter(route, "9999999999999.000000")).map(input => input.messageId)).toEqual(["9999999999999.000001", "9999999999999.000002", "9999999999999.000003"]);
    const calls = http.calls.filter(call => call.method === "conversations.history");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.args.cursor).toBe("second-page");
    expect(calls.every(call => call.args.oldest === "9999999999999.000000")).toBe(true);
    await f.messenger.stop();
  });

  test("thread catchup uses real replies API, time pagination advances, and missing access/retention/rate errors never fake completeness", async () => {
    const http = new SlackHTTP();
    http.behavior.set("conversations.replies", args => args.oldest === "1000.000001" ? { messages: [message("1000.000002", { thread_ts: "1000.000001" })], has_more: true } : { messages: [message("1000.000003", { thread_ts: "1000.000001" })], has_more: false });
    const f = await fixture(http);
    expect((await f.messenger.fetchAfter({ ...route, threadId: "1000.000001" }, "1000.000001")).map(input => input.messageId)).toEqual(["1000.000002", "1000.000003"]);
    expect(http.calls.filter(call => call.method === "conversations.replies").map(call => call.args.oldest)).toEqual(["1000.000001", "1000.000002"]);
    for (const result of [{ ok: false, error: "missing_scope" }, { ok: false, error: "not_allowed_token_type" }, { messages: [], is_limited: true }, { messages: [], has_more: true }]) {
      http.behavior.set("conversations.replies", () => result);
      await expect(f.messenger.fetchAfter({ ...route, threadId: "1000.000001" }, "1000.000001")).rejects.toBeInstanceOf(DeliveryError);
    }
    http.behavior.set("conversations.replies", () => new Response("limited", { status: 429, headers: { "retry-after": "10" } }));
    await expect(f.messenger.fetchAfter({ ...route, threadId: "1000.000001" }, "1000.000001")).rejects.toThrow("rate limited");
    const before = http.calls.length;
    f.socket.emit("connected"); await drain();
    expect(f.reconnects()).toBe(1);
    expect(http.calls).toHaveLength(before); // Adapter does not discover arbitrary conversations.
    await f.messenger.stop();
  });

  test("root history time pages move newest-first boundary without skipping short pages", async () => {
    const http = new SlackHTTP();
    http.behavior.set("conversations.history", args => args.latest ? { messages: [message("1000.000002")], has_more: false } : { messages: [message("1000.000004"), message("1000.000003")], has_more: true });
    const f = await fixture(http);
    expect((await f.messenger.fetchAfter(route, "1000.000001")).map(input => input.messageId)).toEqual(["1000.000002", "1000.000003", "1000.000004"]);
    expect(http.calls.filter(call => call.method === "conversations.history")[1]!.args.latest).toBe("1000.000003");
    http.behavior.set("conversations.history", () => ({ messages: [], has_more: true, response_metadata: { next_cursor: "repeated" } }));
    await expect(f.messenger.fetchAfter(route, "1000.000001")).rejects.toThrow("cursor did not advance");
    await f.messenger.stop();
  });
});

describe("Slack native approval controls", () => {
  test("confirm settles once, ACK follows durable answer, and old DM card stays on original logical topic", async () => {
    const durable = Promise.withResolvers<void>();
    const results: { response: DialogResponse; route: Route }[] = [];
    const f = await fixture(new SlackHTTP(), { answer: async (_id, response, route) => { results.push({ response, route }); await durable.promise; } });
    const original = { ...dm, topicId: "original-topic" };
    const id = await f.messenger.showApproval(approval({ route: original }));
    const remote = f.http.remote.get(`DOWNER:${id}`)!;
    expect(JSON.stringify(remote.blocks)).not.toContain("approval-secret-not-in-controls");
    const first = click(remote, "yes"); f.socket.emit("slack_event", first); await drain();
    const duplicate = click(remote, "yes"); duplicate.envelope_id = first.envelope_id; f.socket.emit("slack_event", duplicate); await drain();
    expect(first.acks).toEqual([]);
    expect(duplicate.acks).toEqual([]);
    expect(results).toEqual([{ response: { confirmed: true }, route: original }]);
    durable.resolve(); await Promise.all([first.done, duplicate.done]);
    expect(f.http.remote.get(`DOWNER:${id}`)!.blocks.some((block: Data) => block.type === "actions")).toBe(false);
    const stale = click(remote, "no"); f.socket.emit("slack_event", stale); await stale.done;
    expect(results).toHaveLength(1);
    await f.messenger.stop();
  });

  test("distinct selections and submit wait for a blocked refresh, while true retries cannot revert the latest selection", async () => {
    const f = await fixture();
    const id = await f.messenger.showApproval(approval({ request: { method: "ask", questions: [{ id: "choice", question: "Pick one", options: [{ label: "A" }, { label: "B" }] }] } }));
    const remote = f.http.remote.get(`CALLOWED:${id}`)!;
    const refreshing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let updates = 0;
    f.http.behavior.set("chat.update", async args => {
      if (++updates === 1) { refreshing.resolve(); await release.promise; }
      Object.assign(remote, clone(args));
      return { channel: args.channel, ts: args.ts, message: remote };
    });
    try {
      const first = selection(remote, "choose-0", ["0"]);
      first.body.actions[0].action_ts = "3000.000001";
      f.socket.emit("slack_event", first); await refreshing.promise;
      const latest = selection(remote, "choose-0", ["1"]);
      latest.body.actions[0].action_ts = "3000.000002";
      // A retransmitted action may have a new envelope ID; action_ts is its
      // server event identity, not a value-based deduplication fingerprint.
      const retry = selection(remote, "choose-0", ["0"]);
      retry.body.actions[0].action_ts = first.body.actions[0].action_ts;
      const submit = click(remote, "next-0");
      for (const event of [latest, retry, submit]) f.socket.emit("slack_event", event);
      await drain();
      expect(latest.acks).toEqual([]);
      expect(submit.acks).toEqual([]);
      expect(f.answers).toEqual([]);
      release.resolve();
      await Promise.all([latest.done, retry.done, submit.done]);
      expect(f.answers.map(answer => answer.response)).toEqual([{ answers: [{ id: "choice", selectedOptions: ["B"] }] }]);
      expect(updates).toBe(3); // A refresh, B refresh, final dismissal; no retry refresh.
    } finally { release.resolve(); await f.messenger.stop(); }
  });

  test("modal submission arriving during an earlier selection refresh is queued rather than lost", async () => {
    const f = await fixture();
    const id = await f.messenger.showApproval(approval({ request: { method: "ask", questions: [{ id: "choice", question: "Choose or type", options: [{ label: "A" }] }] } }));
    const remote = f.http.remote.get(`CALLOWED:${id}`)!;
    const open = click(remote, "other-0"); f.socket.emit("slack_event", open); await open.done; await drain();
    const view = f.http.views[0]!;
    const refreshing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let updates = 0;
    f.http.behavior.set("chat.update", async args => {
      if (++updates === 1) { refreshing.resolve(); await release.promise; }
      Object.assign(remote, clone(args));
      return { channel: args.channel, ts: args.ts, message: remote };
    });
    try {
      const choose = selection(remote, "choose-0", ["0"]); f.socket.emit("slack_event", choose); await refreshing.promise;
      const typed = submit(view, "newest exact free text");
      const retry = submit(view, "newest exact free text");
      const next = click(remote, "next-0");
      for (const event of [typed, retry, next]) f.socket.emit("slack_event", event);
      await drain();
      expect(typed.acks).toEqual([]);
      expect(next.acks).toEqual([]);
      expect(f.answers).toEqual([]);
      release.resolve(); await Promise.all([typed.done, retry.done, next.done]);
      expect(f.answers.map(answer => answer.response)).toEqual([{ answers: [{ id: "choice", selectedOptions: [], customInput: "newest exact free text" }] }]);
      expect(updates).toBe(3);
    } finally { release.resolve(); await f.messenger.stop(); }
  });

  test("startup connects without awaiting readiness, then replays queued old-card callbacks only after reconciliation", async () => {
    const http = new SlackHTTP();
    const first = await fixture(http);
    const original = { ...dm, topicId: "original-topic" };
    const id = await first.messenger.showApproval(approval({ route: original }));
    const card = clone(http.remote.get(`DOWNER:${id}`)!);
    await first.messenger.stop();
    const readiness = Promise.withResolvers<void>();
    const second = await fixture(http, { ready: readiness.promise });
    try {
      const callback = click(card, "yes");
      const input = incoming(message("1009.000001"));
      second.socket.emit("slack_event", callback);
      second.socket.emit("slack_event", input);
      await drain();
      expect(second.socket.starts).toBe(1);
      expect(second.answers).toEqual([]);
      expect(second.received).toEqual([]);
      expect(callback.acks).toEqual([]);
      expect(input.acks).toEqual([]);
      expect(await second.messenger.showApproval(approval({ route: original, remoteId: id }))).toBe(id);
      readiness.resolve();
      await Promise.all([callback.done, input.done]);
      expect(second.answers).toEqual([{ id: "approval-secret-not-in-controls", response: { confirmed: true }, route: original }]);
      expect(second.received.map(value => value.messageId)).toEqual(["1009.000001"]);
    } finally { readiness.resolve(); await second.messenger.stop(); }
  });

  test("stop aborts an unresolved startup barrier without ACKing or handling queued business events", async () => {
    const readiness = Promise.withResolvers<void>();
    const f = await fixture(new SlackHTTP(), { ready: readiness.promise });
    const id = await f.messenger.showApproval(approval());
    const card = f.http.remote.get(`CALLOWED:${id}`)!;
    const callback = click(card, "yes");
    const input = incoming(message());
    f.socket.emit("slack_event", callback);
    f.socket.emit("slack_event", input);
    await drain();
    await f.messenger.stop();
    expect(f.socket.stops).toBe(1);
    expect(f.answers).toEqual([]);
    expect(f.received).toEqual([]);
    expect(callback.acks).toEqual([]);
    expect(input.acks).toEqual([]);
    readiness.resolve(); await drain();
    expect(f.answers).toEqual([]);
  });

  test("failed native reconciliation leaves queued messages and callbacks unacknowledged", async () => {
    const readiness = Promise.withResolvers<void>();
    const f = await fixture(new SlackHTTP(), { ready: readiness.promise });
    try {
      const id = await f.messenger.showApproval(approval());
      const card = f.http.remote.get(`CALLOWED:${id}`)!;
      const callback = click(card, "yes");
      const input = incoming(message());
      f.socket.emit("slack_event", callback);
      f.socket.emit("slack_event", input);
      readiness.reject(new Error("native reconciliation failed"));
      await drain();
      expect(f.answers).toEqual([]);
      expect(f.received).toEqual([]);
      expect(callback.acks).toEqual([]);
      expect(input.acks).toEqual([]);
      expect(f.errors).toHaveLength(1);
    } finally { await f.messenger.stop(); }
  });

  test("team/user/channel/card/generation validation rejects spoofed or stale controls", async () => {
    const f = await fixture();
    const id = await f.messenger.showApproval(approval());
    const remote = clone(f.http.remote.get(`CALLOWED:${id}`)!);
    const events = [click(remote, "yes", { team: { id: "TOTHER" } }), click(remote, "yes", { user: { id: "UOTHER" } }), click(remote, "yes", { channel: { id: "COTHER" } }), click(remote, "yes", { container: { type: "message", channel_id: "CALLOWED", message_ts: "9000.000001" } }), click(remote, "yes", { message: { ...clone(remote), user: owner } })];
    for (const event of events) { f.socket.emit("slack_event", event); await event.done; }
    expect(f.answers).toEqual([]);
    await f.messenger.showApproval(approval({ generation: 8 }));
    const old = click(remote, "yes"); f.socket.emit("slack_event", old); await old.done;
    expect(f.answers).toEqual([]);
    await f.messenger.stop();
  });

  test("select returns exact unmodified original labels and renders checked/native markers", async () => {
    const f = await fixture();
    const request = { method: "select", title: "Select behavior", options: ["☑ exact value", "<@UOTHER> no mention", "Apply"], selectionMarker: "checkbox", checkedIndices: [0], markableCount: 2, initialIndex: 1, optionDetails: [{ description: "Keep this semantics" }] };
    const id = await f.messenger.showApproval(approval({ request }));
    const remote = f.http.remote.get(`CALLOWED:${id}`)!;
    expect(remote.text).toContain("[x] ☑ exact value");
    expect(remote.text).toContain("(initial focus)");
    const ids = remote.blocks.map((block: Data) => block.block_id).filter(Boolean);
    expect(new Set(ids).size).toBe(ids.length);
    const event = selection(remote, "select", ["1"]); f.socket.emit("slack_event", event); await event.done;
    expect(f.answers[0]!.response).toEqual({ value: "<@UOTHER> no mention" });
    await f.messenger.stop();
  });

  test("long confirmation remains one complete plain-text card, not truncated message parts", async () => {
    const f = await fixture();
    const content = "All consequences <!everyone>\n".repeat(250);
    const id = await f.messenger.showApproval(approval({ request: { method: "confirm", title: "Full confirmation", message: content } }));
    const remote = f.http.remote.get(`CALLOWED:${id}`)!;
    expect(remote.text).toBeUndefined();
    expect(remote.blocks.filter((block: Data) => block.type === "section").map((block: Data) => block.text.text).join("")).toBe(`Full confirmation\n\n${content}`);
    expect(f.http.calls.filter(call => call.method === "chat.postMessage")).toHaveLength(1);
    await f.messenger.stop();
  });

  test("input/editor use linked native modal; forged metadata, stale view, wrong user/team cannot answer", async () => {
    for (const method of ["input", "editor"]) {
      const f = await fixture();
      const original = { ...dm, topicId: "topic-before-switch" };
      const id = await f.messenger.showApproval(approval({ route: original, request: { method, title: "Full native title".repeat(5), prefill: "exact prefill", placeholder: "not secret" } }));
      const remote = f.http.remote.get(`DOWNER:${id}`)!;
      const open = click(remote, "open"); f.socket.emit("slack_event", open); await open.done; await drain();
      const view = f.http.views[0]!;
      expect(view.blocks[0].element.multiline).toBe(method === "editor");
      expect(view.blocks[0].element.initial_value).toBe("exact prefill");
      const bad = [submit(view, "bad", { team: { id: "TOTHER" } }), submit(view, "bad", { user: { id: "UOTHER" } }), submit({ ...view, private_metadata: "forged" }, "bad"), submit({ ...view, id: "VOTHER" }, "bad")];
      for (const event of bad) { f.socket.emit("slack_event", event); await event.done; }
      expect(f.answers).toEqual([]);
      const good = submit(view, "  exact answer\n"); f.socket.emit("slack_event", good); await good.done;
      expect(f.answers).toEqual([{ id: "approval-secret-not-in-controls", response: { value: "  exact answer\n" }, route: original }]);
      const duplicate = submit(view, "second"); f.socket.emit("slack_event", duplicate); await duplicate.done;
      expect(f.answers).toHaveLength(1);
      await f.messenger.stop();
    }
  });

  test("ask supports multiple questions, exact choices, free text, optional selection, and stale question rejection", async () => {
    const f = await fixture();
    const id = await f.messenger.showApproval(approval({ request: { method: "ask", questions: [
      { id: "one", header: "First", question: "Choose many", multi: true, recommended: 1, options: [{ label: "A", preview: "Full preview <!everyone>" }, { label: "B", description: "Exact description" }] },
      { id: "two", question: "Choose or type", options: [{ label: "Native label" }] },
    ] } }));
    const remote = f.http.remote.get(`CALLOWED:${id}`)!;
    expect(remote.text).toContain("recommended, not preselected");
    for (const event of [selection(remote, "choose-0", ["0", "1"], true), click(remote, "other-0")]) { f.socket.emit("slack_event", event); await event.done; await drain(); }
    const firstView = f.http.views[0]!;
    const custom = submit(firstView, " free text "); f.socket.emit("slack_event", custom); await custom.done; await drain();
    const next = click(remote, "next-0"); f.socket.emit("slack_event", next); await next.done; await drain();
    const stale = selection(remote, "choose-0", ["0"], true); f.socket.emit("slack_event", stale); await stale.done;
    const choose = selection(remote, "choose-1", ["0"]); f.socket.emit("slack_event", choose); await choose.done; await drain();
    const other = click(remote, "other-1"); f.socket.emit("slack_event", other); await other.done; await drain();
    const second = submit(f.http.views[1]!, "Native free text"); f.socket.emit("slack_event", second); await second.done; await drain();
    const submitAll = click(remote, "next-1"); f.socket.emit("slack_event", submitAll); await submitAll.done;
    expect(f.answers[0]!.response).toEqual({ answers: [{ id: "one", selectedOptions: ["A", "B"], customInput: " free text " }, { id: "two", selectedOptions: [], customInput: "Native free text" }] });
    await f.messenger.stop();
  });

  test("modal close reopens safely; cancel dismisses card and invalidates already-open modal", async () => {
    const f = await fixture();
    const id = await f.messenger.showApproval(approval({ request: { method: "input", title: "Input" } }));
    const remote = f.http.remote.get(`CALLOWED:${id}`)!;
    const open = click(remote, "open"); f.socket.emit("slack_event", open); await open.done; await drain();
    const close = submit(f.http.views[0]!, null, { type: "view_closed" }); f.socket.emit("slack_event", close); await close.done;
    const reopen = click(remote, "open"); f.socket.emit("slack_event", reopen); await reopen.done; await drain();
    expect(f.http.views).toHaveLength(2);
    const cancel = click(remote, "cancel"); f.socket.emit("slack_event", cancel); await cancel.done;
    const stale = submit(f.http.views[1]!, "late"); f.socket.emit("slack_event", stale); await stale.done;
    expect(f.answers.map(answer => answer.response)).toEqual([{ cancelled: true }]);
    await f.messenger.stop();
  });

  test("restart rehydrates matching owned card through authoritative history; foreign receipt is never edited", async () => {
    const http = new SlackHTTP();
    const first = await fixture(http);
    const thread = { ...route, threadId: "1000.000001" };
    const id = await first.messenger.showApproval(approval({ route: thread }));
    await first.messenger.stop();
    const second = await fixture(http);
    expect(await second.messenger.showApproval(approval({ route: thread, remoteId: id }))).toBe(id);
    expect(http.calls.filter(call => call.method === "chat.postMessage")).toHaveLength(1);
    expect(http.calls.some(call => call.method === "conversations.replies" && call.args.ts === thread.threadId)).toBe(true);
    const remote = http.remote.get(`CALLOWED:${id}`)!;
    const event = click(remote, "yes"); second.socket.emit("slack_event", event); await event.done;
    expect(second.answers[0]!.response).toEqual({ confirmed: true });
    await second.messenger.stop();
    const third = await fixture(http);
    const edits = http.calls.filter(call => call.method === "chat.update").length;
    await expect(third.messenger.showApproval(approval({ route: thread, remoteId: id, generation: 8 }))).rejects.toThrow("matching owned");
    expect(http.calls.filter(call => call.method === "chat.update")).toHaveLength(edits);
    await third.messenger.stop();
  });

  test("secret and unrepresentable labels fail closed with native cancellation, never truncating choice semantics", async () => {
    const f = await fixture();
    for (const [index, request] of [{ method: "input", title: "Password", secret: true, prefill: "do-not-publish" }, { method: "select", title: "Choices", options: ["a".repeat(76)] }, { method: "editor", title: "Long editor", prefill: "b".repeat(3001) }].entries()) {
      await f.messenger.showApproval(approval({ id: `unsupported-${index}`, request }));
    }
    expect(f.answers.map(answer => answer.response)).toEqual([{ cancelled: true }, { cancelled: true }, { cancelled: true }]);
    expect(JSON.stringify([...f.http.remote.values()])).not.toContain("do-not-publish");
    expect(f.http.views).toEqual([]);
    await f.messenger.stop();
  });
});

describe("Slack private attachment credential boundaries", () => {
  const attachment = { id: "FFILE", name: "file.txt", size: 8, url: "slack-file:FFILE" };
  test("files.info authorizes original share/owner and exact Slack path before authenticated no-redirect download", async () => {
    const f = await fixture();
    const signal = new AbortController().signal;
    const response = await f.messenger.openAttachment(route, attachment, signal);
    expect(await response.text()).toBe("contents");
    const download = f.http.external[0]!;
    expect(download.url).toBe(`https://files.slack.com/files-pri/${team}-FFILE/download/file.txt`);
    expect(download.init).toEqual({ signal, redirect: "error", headers: { Authorization: "Bearer xoxb-test-private" } });
    expect(f.http.calls.some(call => call.method === "files.info" && call.args.file === "FFILE")).toBe(true);
    f.http.file.shares = { private: { DOWNER: [{ ts: "1000.000002", thread_ts: "1000.000001", team_id: team }] } };
    await f.messenger.openAttachment({ ...dm, threadId: "1000.000001", topicId: "original" }, attachment, signal);
    await expect(f.messenger.openAttachment({ ...dm, threadId: "1000.000009" }, attachment, signal)).rejects.toThrow("original destination");
    await f.messenger.stop();
  });

  test("spoofed file IDs, foreign workspace/owner/shares/external files never trigger a credentialed fetch", async () => {
    const f = await fixture();
    const original = clone(f.http.file);
    for (const patch of [{ user: "UOTHER" }, { team_id: "TOTHER" }, { is_external: true }, { mode: "external" }, { shares: { public: { COTHER: [{ ts: "1000.000001", team_id: team }] } } }, { shares: { public: { CALLOWED: [{ ts: "1000.000001", team_id: "TOTHER" }] } } }, { shares: {} }]) {
      f.http.file = { ...clone(original), ...patch };
      await expect(f.messenger.openAttachment(route, attachment, new AbortController().signal)).rejects.toBeInstanceOf(DeliveryError);
    }
    for (const patch of [{ id: "FOTHER" }, { url: "https://attacker.invalid/token" }]) await expect(f.messenger.openAttachment(route, { ...attachment, ...patch }, new AbortController().signal)).rejects.toBeInstanceOf(DeliveryError);
    expect(f.http.external).toEqual([]);
    await f.messenger.stop();
  });

  test("authoritative private URLs still require exact HTTPS host/workspace/file path; redirects and transport errors never leak tokens", async () => {
    const f = await fixture();
    for (const url of ["https://attacker.invalid/files-pri/TOWN-FFILE/a", "https://files.slack.com.attacker.invalid/files-pri/TOWN-FFILE/a", "http://files.slack.com/files-pri/TOWN-FFILE/a", "https://files.slack.com:444/files-pri/TOWN-FFILE/a", "https://user:pass@files.slack.com/files-pri/TOWN-FFILE/a", "https://files.slack.com/files-pri/TOTHER-FFILE/a", "https://files.slack.com/files-pri/TOWN-FOTHER/a", "https://files.slack.com/files-pri/TOWN-FFILE/%2e%2e/secret", "https://files.slack.com/files-pri/TOWN-FFILE/a%2fb"]) {
      f.http.file.url_private_download = url;
      await expect(f.messenger.openAttachment(route, attachment, new AbortController().signal)).rejects.toThrow("allowed workspace/file path");
    }
    expect(f.http.external).toEqual([]);
    f.http.file.url_private_download = `https://files.slack.com/files-pri/${team}-FFILE/file.txt`;
    f.http.externalFailure = new Error("redirect to attacker.invalid with xoxb-test-private");
    await expect(f.messenger.openAttachment(route, attachment, new AbortController().signal)).rejects.toThrow("Slack private attachment download failed");
    expect(f.http.external[0]!.init!.redirect).toBe("error");
    await f.messenger.stop();
  });
});
