import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { ApplicationCommandOptionType, ChannelType, Collection, Events, MessageFlags, type Client, type Message, type MessageCreateOptions } from "discord.js";
import { DiscordMessenger, deliveryError, discordAttachmentAllowed, discordNonce, parseDiscordControl, type DiscordMessengerOptions } from "../src/discord.ts";
import { DeliveryError } from "../src/delivery.ts";
import { parseDialog } from "../src/dialog.ts";
import { type Approval, type Attachment, type DialogResponse, type Inbound, type OutputRecord, type Route } from "../src/contracts.ts";

const owner = "owner";
const bot = "bot";
const route: Route = { platform: "discord", accountId: bot, authorityId: owner, guildId: "guild", channelId: "parent", threadId: null };
const approval = (patch: Partial<Approval> = {}): Approval => ({
  id: "approval", target: "lane", generation: 7, requestId: "request", route,
  request: { method: "confirm", title: "Deploy?", message: "External action" }, state: "pending", remoteId: null, ...patch,
});
const output = (text: string, destination = route): OutputRecord => ({ id: "output", sourceId: "input", route: destination, text, state: "sending", remoteId: null, error: null });

class RemoteMessage {
  author = { id: bot, bot: true };
  components: { components: { customId: string }[] }[] = [];
  edits: unknown[] = [];
  editFailure: unknown;
  constructor(readonly id: string, readonly channelId: string, readonly guildId: string | null, payload: MessageCreateOptions) { this.setComponents(payload.components); }
  private setComponents(components: MessageCreateOptions["components"]) {
    this.components = (components ?? []).map(row => {
      const data = "toJSON" in row ? row.toJSON() : row;
      return { components: "components" in data ? data.components.map(component => ({ customId: "custom_id" in component ? String(component.custom_id) : "" })) : [] };
    });
  }
  async edit(payload: MessageCreateOptions) { this.edits.push(payload); this.setComponents(payload.components); if (this.editFailure) throw this.editFailure; return this; }
}

class Channel {
  sent: MessageCreateOptions[] = [];
  remote = new Map<string, RemoteMessage>();
  fetched: unknown[] = [];
  history = new Collection<string, Message>();
  failure: unknown;
  recipientId = owner;
  constructor(readonly id = "parent", readonly guildId: string | null = "guild", readonly parentId: string | null = null) {}
  get type() { return this.parentId ? ChannelType.PublicThread : this.guildId ? ChannelType.GuildText : ChannelType.DM; }
  isThread() { return this.parentId !== null; }
  isSendable() { return true; }
  async send(payload: MessageCreateOptions) {
    this.sent.push(payload);
    if (this.failure) throw this.failure;
    const message = new RemoteMessage(`remote-${this.sent.length}`, this.id, this.guildId, payload);
    this.remote.set(message.id, message);
    return message;
  }
  messages = { fetch: async (query: unknown) => {
    this.fetched.push(query);
    if (typeof query !== "string") return this.history;
    const message = this.remote.get(query);
    if (!message) throw Object.assign(new Error("Unknown message"), { code: 10008, status: 404 });
    return message;
  } };
  threads = { create: async (_options: unknown) => new Channel("created-thread", this.guildId, this.id) };
}

class Gateway extends EventEmitter {
  user = { id: bot };
  application = { id: "application" };
  reactions = new Map<string, Set<string>>();
  reactionCalls: { method: "PUT" | "DELETE"; path: string }[] = [];
  reactionFailure: unknown;
  rest = {
    options: { retries: 3, rejectOnRateLimit: null as unknown },
    put: (path: string) => this.react("PUT", path),
    delete: (path: string) => this.react("DELETE", path),
  };
  channelMap = new Map<string, Channel>();
  lookups: string[] = [];
  destroyed = false;
  channels = { fetch: async (id: string) => { this.lookups.push(id); return this.channelMap.get(id) ?? null; } };
  private async react(method: "PUT" | "DELETE", path: string): Promise<void> {
    this.reactionCalls.push({ method, path });
    if (this.reactionFailure) throw this.reactionFailure;
    const match = /^\/channels\/([^/]+)\/messages\/([0-9]+)\/reactions\/([^/]+)\/@me$/.exec(path);
    if (!match?.[1] || !match[2] || !match[3]) throw new Error(`Unsupported own-reaction route: ${path}`);
    const key = `${match[1]}:${match[2]}:${decodeURIComponent(match[3])}`;
    const users = this.reactions.get(key) ?? new Set<string>();
    if (method === "PUT") { users.add(bot); this.reactions.set(key, users); }
    else users.delete(bot);
  }
  isReady() { return true; }
  async destroy() { this.destroyed = true; }
}

function inbound(channel: Channel, patch: Record<string, unknown> = {}): Message {
  return {
    id: "100", author: { id: owner, bot: false }, channel, channelId: channel.id, guildId: channel.guildId,
    type: 0, content: "hello", attachments: new Collection(), editedTimestamp: null, createdTimestamp: 1000, webhookId: null,
    partial: false, ...patch,
  } as unknown as Message;
}

async function fixture(options: Pick<DiscordMessengerOptions, "fetch"> = {}, admit?: (id: string, response: DialogResponse, route: Route) => Promise<void>) {
  const gateway = new Gateway();
  const channel = new Channel();
  gateway.channelMap.set(channel.id, channel);
  const received: Inbound[] = [];
  const answers: { id: string; response: unknown; route: Route }[] = [];
  const errors: unknown[] = [];
  const messenger = new DiscordMessenger({ token: "unused", ownerId: owner, allowedGuildIds: ["guild"], allowedChannelIds: ["parent"], client: gateway as unknown as Client, onError: error => errors.push(error), ...options });
  await messenger.start({ message: async value => { received.push(value); }, answer: async (id, response, route) => { await admit?.(id, response, route); answers.push({ id, response, route }); } });
  return { gateway, channel, messenger, received, answers, errors };
}

async function drain() {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  await promise;
}

function interaction(message: RemoteMessage, customId: string, kind: "button" | "select" | "modal" = "button", patch: Record<string, unknown> = {}) {
  const result = {
    customId, message, channelId: message.channelId, guildId: message.guildId, user: { id: owner },
    isChatInputCommand: () => false,
    isButton: () => kind === "button", isStringSelectMenu: () => kind === "select", isModalSubmit: () => kind === "modal", isFromMessage: () => true,
    values: ["0"], fields: { getTextInputValue: () => "typed answer" }, replies: [] as unknown[], ack: 0, modals: [] as unknown[],
    async reply(value: unknown) { result.replies.push(value); },
    async deferUpdate() { result.ack++; },
    async showModal(value: unknown) { result.modals.push(value); },
    ...patch,
  };
  return result;
}
function commandInteraction(channel: Channel | null, patch: Record<string, unknown> = {}) {
  const result = {
    id: "200", applicationId: "application", user: { id: owner, bot: false },
    channel, channelId: channel?.id ?? "parent", guildId: channel ? channel.guildId : "guild",
    commandName: "status", options: { data: [] }, createdTimestamp: 2000,
    token: "secret-interaction-token", isChatInputCommand: () => true,
    replies: [] as { content: string; flags: number; allowedMentions: unknown }[], deferred: 0, followups: 0,
    async reply(value: { content: string; flags: number; allowedMentions: unknown }) { result.replies.push(value); },
    async deferReply() { result.deferred++; },
    async followUp() { result.followups++; },
    ...patch,
  };
  return result;
}
function control(message: RemoteMessage, action: string): string {
  const any = message.components.flatMap(row => row.components)[0]!.customId;
  return `omp:${parseDiscordControl(any)!.token}:${action}`;
}

describe("shared native dialog normalization", () => {
  test("preserves exact native values, marker bounds, details, and initial focus", () => {
    expect(parseDialog({ method: "select", title: "Choose", options: [" A ", "Beta", "Done selecting"], selectionMarker: "checkbox", markableCount: 2, checkedIndices: [1], initialIndex: 2, optionDetails: [{ description: "first" }, {}, { description: "action" }] })).toEqual({
      method: "select", title: "Choose", options: [" A ", "Beta", "Done selecting"], marker: "checkbox", markableCount: 2, checked: [1], initialIndex: 2, details: ["first", undefined, "action"],
    });
    expect(parseDialog({ method: "select", title: "Radio", options: ["first", "second"], selectionMarker: "radio" })).toMatchObject({ marker: "radio", markableCount: 2, checked: [] });
    expect(parseDialog({ method: "select", title: "Plain", options: ["one"] })).toMatchObject({ marker: undefined, markableCount: 0, checked: [], details: [undefined] });
  });

  test("normalizes all native methods without imposing Discord capacities", () => {
    expect(parseDialog({ method: "confirm", title: "Confirm", message: "exact\nmessage" })).toEqual({ method: "confirm", title: "Confirm", message: "exact\nmessage" });
    for (const method of ["input", "editor"] as const) expect(parseDialog({ method, title: "T".repeat(46), placeholder: "P".repeat(101), prefill: "x".repeat(4001) })).toEqual({ method, title: "T".repeat(46), placeholder: "P".repeat(101), prefill: "x".repeat(4001) });
    const labels = Array.from({ length: 26 }, (_, index) => `${index}:${"L".repeat(101)}`);
    expect(parseDialog({ method: "select", title: "Many", options: labels })).toMatchObject({ options: labels });
    const questions = [{ id: "q", question: "Question?", header: "Header", multi: true, recommended: 25, options: labels.map(label => ({ label, description: "D".repeat(101), preview: "full preview" })) }];
    expect(parseDialog({ method: "ask", questions })).toEqual({ method: "ask", questions });
    expect(parseDialog({ method: "ask", questions: [{ id: "free", question: "Anything?", options: [] }] })).toMatchObject({ questions: [{ id: "free", options: [] }] });
  });

  test("rejects malformed native state rather than silently changing it", () => {
    const select = { method: "select", title: "Pick", options: ["one", "two"], selectionMarker: "checkbox", markableCount: 1 };
    for (const patch of [
      { selectionMarker: "custom" }, { markableCount: 3 }, { markableCount: -1 }, { markableCount: 0.5 },
      { checkedIndices: [1] }, { checkedIndices: [0, 0] }, { checkedIndices: ["0"] }, { initialIndex: 2 },
      { initialIndex: 0.5 }, { options: ["same", "same"] }, { optionDetails: {} }, { optionDetails: [{ description: 2 }] },
    ]) expect(() => parseDialog({ ...select, ...patch })).toThrow();
    for (const request of [
      { method: "confirm", title: "Missing message" }, { method: "input", title: "Secret", secret: true },
      { method: "input", title: "Input", placeholder: 2 }, { method: "editor", title: "Editor", prefill: {} },
      { method: "ask", questions: [] }, { method: "ask", questions: [{ id: "q", question: "?", options: [], recommended: 0 }] },
      { method: "ask", questions: [{ id: "q", question: "?", options: [{ label: "A" }, { label: "A" }] }] },
      { method: "ask", questions: [{ id: "q", question: "?", options: [] }, { id: "q", question: "?", options: [] }] },
      { method: "unsupported", title: "Unsupported" },
    ]) expect(() => parseDialog(request)).toThrow();
  });
});

describe("Discord routing and parsing", () => {
  test("guild AND parent-channel gates precede partial fetch and attachment inspection", async () => {
    const { messenger, gateway, received } = await fixture();
    let fetched = 0;
    for (const channel of [new Channel("parent", "foreign-guild"), new Channel("other", "guild"), new Channel("thread", "guild", "other")]) {
      gateway.emit(Events.MessageCreate, inbound(channel, { partial: true, fetch: async () => { fetched++; throw new Error("must not fetch"); } }));
    }
    gateway.emit(Events.MessageCreate, inbound(new Channel(), { author: { id: "stranger", bot: false }, partial: true, fetch: async () => { fetched++; } }));
    await drain();
    expect(fetched).toBe(0);
    expect(received).toEqual([]);
    await messenger.stop();
  });

  test("thread identity uses its parent, while bots and nonowner DMs are dropped", async () => {
    const { messenger, gateway, received } = await fixture();
    gateway.emit(Events.MessageCreate, inbound(new Channel("thread", "guild", "parent")));
    gateway.emit(Events.MessageCreate, inbound(new Channel("dm", null)));
    gateway.emit(Events.MessageCreate, inbound(new Channel("dm", null), { author: { id: "stranger", bot: false } }));
    gateway.emit(Events.MessageCreate, inbound(new Channel(), { author: { id: owner, bot: true } }));
    await drain();
    expect(received.map(value => value.route)).toEqual([{ ...route, threadId: "thread" }, { ...route, guildId: null, channelId: "dm" }]);
    await messenger.stop();
  });

  test("original and edit IDs dedupe stably without losing original message identity", async () => {
    const { messenger, channel } = await fixture();
    const original = inbound(channel);
    const edit = inbound(channel, { content: "changed", editedTimestamp: 2000 });
    expect(messenger.normalize(original)!.id).toBe("discord:bot:100:original");
    expect(messenger.normalize(edit)!.messageId).toBe("100");
    expect(messenger.normalize(edit)!.id).toBe(messenger.normalize(edit)!.id);
    expect(messenger.normalize(edit)!.id).not.toBe(messenger.normalize(original)!.id);
    expect(messenger.normalize(inbound(channel, { content: "different", editedTimestamp: 2000 }))!.id).not.toBe(messenger.normalize(edit)!.id);
    const attachment = { id: "200", name: "file.txt", size: 3, contentType: "text/plain" };
    const first = inbound(channel, { editedTimestamp: 2000, attachments: new Collection([["a", { ...attachment, url: "https://cdn.discordapp.com/attachments/100/200/file.txt?hm=old" }]]) });
    const refreshed = inbound(channel, { editedTimestamp: 2000, attachments: new Collection([["a", { ...attachment, url: "https://cdn.discordapp.com/attachments/100/200/file.txt?hm=new" }]]) });
    expect(messenger.normalize(first)!.id).toBe(messenger.normalize(refreshed)!.id);
    await messenger.stop();
  });

  test("only credential-free HTTPS Discord CDN attachment paths are admitted", async () => {
    expect(discordAttachmentAllowed("https://cdn.discordapp.com/attachments/100/200/file.txt?ex=a&is=b&hm=c")).toBe(true);
    for (const url of [
      "http://cdn.discordapp.com/attachments/100/200/file.txt", "https://cdn.discordapp.com.evil/attachments/100/200/file.txt",
      "https://token@cdn.discordapp.com/attachments/100/200/file.txt", "https://cdn.discordapp.com:444/attachments/100/200/file.txt",
      "file:///a", "https://cdn.discordapp.com/a", "https://cdn.discordapp.com/attachments/100/200/",
      "https://cdn.discordapp.com/attachments/100/200/file.txt#fragment", "https://cdn.discordapp.com/attachments/100/200/file%2fother.txt",
    ]) expect(discordAttachmentAllowed(url)).toBe(false);
    const { messenger, channel } = await fixture();
    const attachments = new Collection([
      ["a", { id: "200", name: "safe.txt", url: "https://media.discordapp.net/attachments/100/200/safe.txt", size: 3, contentType: "text/plain" }],
      ["b", { id: "b", name: "bad.txt", url: "https://evil.example/b", size: 3, contentType: "text/plain" }],
    ]);
    expect(messenger.normalize(inbound(channel, { attachments }))!.attachments).toEqual([{ id: "200", name: "safe.txt", url: "https://media.discordapp.net/attachments/100/200/safe.txt", size: 3, contentType: "text/plain" }]);
    await messenger.stop();
  });

  test("intake waits for each persistence handler before the next message or edit", async () => {
    const gateway = new Gateway();
    const channel = new Channel();
    const gate = Promise.withResolvers<void>();
    const order: string[] = [];
    const messenger = new DiscordMessenger({ token: "unused", ownerId: owner, allowedGuildIds: ["guild"], allowedChannelIds: ["parent"], client: gateway as unknown as Client });
    await messenger.start({ message: async value => { order.push(`start:${value.text}`); if (value.text === "first") await gate.promise; order.push(`done:${value.text}`); }, answer: async () => {} });
    gateway.emit(Events.MessageCreate, inbound(channel, { content: "first" }));
    gateway.emit(Events.MessageUpdate, inbound(channel), inbound(channel, { content: "second", editedTimestamp: 2000 }));
    await drain();
    expect(order).toEqual(["start:first"]);
    gate.resolve();
    await drain();
    expect(order).toEqual(["start:first", "done:first", "start:second", "done:second"]);
    await messenger.stop();
  });
});

describe("Discord application commands", () => {
  test("normalizes supported options and preserves the original channel, thread, or owner DM route", async () => {
    const { messenger, gateway, channel, received } = await fixture();
    const thread = new Channel("thread", "guild", "parent");
    const dm = new Channel("dm", null);
    const cases = [
      { channel, name: "help", text: undefined, expected: "/help", target: route },
      { channel: thread, name: "model", text: " preset exact-name --global ", expected: "/model preset exact-name --global", target: { ...route, threadId: thread.id } },
      { channel: dm, name: "compact", text: " keep decisions\nand open questions ", expected: "/compact keep decisions\nand open questions", target: { ...route, guildId: null, channelId: dm.id } },
      { channel, name: "effort", text: "high", expected: "/effort high", target: route },
      { channel, name: "stop", text: "head", expected: "/stop head", target: route },
      { channel: dm, name: "new", text: "investigate the issue", expected: "/new investigate the issue", target: { ...route, guildId: null, channelId: dm.id } },
    ];
    for (const [index, entry] of cases.entries()) {
      const command = commandInteraction(entry.channel, {
        id: String(200 + index), commandName: entry.name,
        options: { data: entry.text === undefined ? [] : [{ name: "text", type: ApplicationCommandOptionType.String, value: entry.text }] },
      });
      gateway.emit(Events.InteractionCreate, command);
      await drain();
      expect(received[index]).toEqual({
        id: `discord:bot:interaction:${200 + index}`, route: entry.target, messageId: null, interactionId: String(200 + index),
        text: entry.expected, receivedAt: 2000, attachments: [],
      });
      expect(command.replies).toEqual([{
        content: "Superagent accepted this command. Its result will be sent to this conversation.",
        flags: MessageFlags.Ephemeral, allowedMentions: { parse: [], repliedUser: false },
      }]);
      expect(command.deferred).toBe(0);
      expect(command.followups).toBe(0);
    }
    expect(gateway.lookups).toEqual([]); // Cached, identity-checked SDK channels suffice.
    expect(channel.fetched).toEqual([]);
    expect(thread.fetched).toEqual([]);
    expect(dm.fetched).toEqual([]);
    expect(channel.sent).toEqual([]); // Results belong to the existing durable outbox.
    expect(dm.sent).toEqual([]);
    expect(JSON.stringify(received)).not.toContain("secret-interaction-token");
    await messenger.stop();
  });

  test("bypasses slow ordinary intake but never ACKs before its own durable handler completes", async () => {
    const gateway = new Gateway();
    const channel = new Channel();
    const busy = Promise.withResolvers<void>();
    const durable = Promise.withResolvers<void>();
    const order: string[] = [];
    const messenger = new DiscordMessenger({ token: "unused", ownerId: owner, allowedGuildIds: ["guild"], allowedChannelIds: ["parent"], client: gateway as unknown as Client });
    await messenger.start({ message: async input => {
      order.push(`start:${input.text}`);
      if (input.text === "busy") await busy.promise;
      if (input.interactionId) await durable.promise;
      order.push(`durable:${input.text}`);
    }, answer: async () => {} });
    gateway.emit(Events.MessageCreate, inbound(channel, { content: "busy" }));
    gateway.emit(Events.MessageCreate, inbound(channel, { id: "101", content: "queued" }));
    await drain();
    const command = commandInteraction(channel);
    gateway.emit(Events.InteractionCreate, command);
    await drain();
    expect(order).toEqual(["start:busy", "start:/status"]);
    expect(command.replies).toEqual([]);
    expect(command.deferred).toBe(0);
    expect(command.followups).toBe(0);
    durable.resolve();
    await drain();
    expect(order).toEqual(["start:busy", "start:/status", "durable:/status"]);
    expect(command.replies).toHaveLength(1);
    busy.resolve();
    await drain();
    expect(order).toEqual(["start:busy", "start:/status", "durable:/status", "durable:busy", "start:queued", "durable:queued"]);
    await messenger.stop();
  });

  test.each(["pending", "rejected"] as const)("%s readiness immediately refuses commands without intake or waiting", async state => {
    const gateway = new Gateway();
    const channel = new Channel();
    const ready = Promise.withResolvers<void>();
    const received: Inbound[] = [];
    const errors: unknown[] = [];
    const messenger = new DiscordMessenger({ token: "unused", ownerId: owner, allowedGuildIds: ["guild"], allowedChannelIds: ["parent"], client: gateway as unknown as Client, onError: error => errors.push(error) });
    await messenger.start({ ready: ready.promise, message: async input => { received.push(input); }, answer: async () => {} });
    if (state === "rejected") { ready.reject(new Error("secret startup failure")); await drain(); }
    const command = commandInteraction(channel);
    gateway.emit(Events.InteractionCreate, command);
    await drain();
    expect(command.replies).toHaveLength(1);
    expect(command.replies[0]!.content).toContain("not ready");
    expect(command.replies[0]!.flags).toBe(MessageFlags.Ephemeral);
    expect(received).toEqual([]);
    expect(gateway.lookups).toEqual([]);
    if (state === "pending") {
      ready.resolve();
      await drain();
      expect(received).toEqual([]); // Refusal was not a deferred submission.
      gateway.emit(Events.InteractionCreate, commandInteraction(channel, { id: "201" }));
      await drain();
      expect(received).toHaveLength(1);
    } else {
      expect(errors).toHaveLength(1);
      expect(String(errors[0])).not.toContain("secret startup failure");
    }
    await messenger.stop();
  });

  test("owner and actual application identity are checked before any channel lookup", async () => {
    const { messenger, gateway, channel, received } = await fixture();
    for (const patch of [
      { user: { id: "stranger", bot: false } }, { user: { id: owner, bot: true } },
      { applicationId: "foreign-application" }, { applicationId: bot },
    ]) {
      const command = commandInteraction(null, patch);
      gateway.emit(Events.InteractionCreate, command);
      await drain();
      expect(command.replies).toHaveLength(1);
      expect(command.replies[0]!.flags).toBe(MessageFlags.Ephemeral);
      expect(command.deferred).toBe(0);
    }
    gateway.application.id = "";
    const unidentified = commandInteraction(null);
    gateway.emit(Events.InteractionCreate, unidentified);
    await drain();
    expect(unidentified.replies[0]!.content).toContain("does not belong");
    expect(received).toEqual([]);
    expect(gateway.lookups).toEqual([]);
    expect(channel.fetched).toEqual([]);
    await messenger.stop();
  });

  test("guild and parent allowlists, exact source identity, and genuine owner-only DMs are enforced", async () => {
    const { messenger, gateway, channel, received } = await fixture();
    const strangerDM = new Channel("dm", null); strangerDM.recipientId = "stranger";
    const groupDM = new Channel("group", null);
    Object.defineProperty(groupDM, "type", { value: ChannelType.GroupDM });
    for (const entry of [
      { channel: new Channel("parent", "foreign-guild"), patch: {} },
      { channel: new Channel("other", "guild"), patch: {} },
      { channel: new Channel("thread", "guild", "other"), patch: {} },
      { channel, patch: { channelId: "different-channel" } },
      { channel, patch: { guildId: null } },
      { channel: new Channel("parent", "foreign-guild"), patch: { guildId: "guild" } },
      { channel: strangerDM, patch: {} },
      { channel: groupDM, patch: {} },
      { channel: new Channel("dm", null), patch: { guildId: "guild" } },
    ]) {
      const command = commandInteraction(entry.channel, entry.patch);
      gateway.emit(Events.InteractionCreate, command);
      await drain();
      expect(command.replies).toHaveLength(1);
      expect(command.replies[0]!.content).toContain("not authorized");
    }
    expect(received).toEqual([]);
    expect(gateway.lookups).toEqual([]);
    await messenger.stop();
  });

  test("SDK channel fetch resolves missing cache entries, never interaction IDs as messages", async () => {
    const { messenger, gateway, channel, received } = await fixture();
    const command = commandInteraction(null);
    gateway.emit(Events.InteractionCreate, command);
    await drain();
    expect(gateway.lookups).toEqual(["parent"]);
    expect(received[0]!.route).toEqual(route);
    expect(channel.fetched).toEqual([]);
    for (const replacement of [new Channel("wrong-id", "guild"), new Channel("parent", "foreign-guild")]) {
      gateway.channelMap.set("parent", replacement);
      const forged = commandInteraction(null, { id: "201" });
      gateway.emit(Events.InteractionCreate, forged);
      await drain();
      expect(forged.replies[0]!.content).toContain("not authorized");
      expect(replacement.fetched).toEqual([]);
    }
    expect(received).toHaveLength(1);
    await messenger.stop();
  });

  test("unsupported commands and stale option shapes are refused rather than dropping arguments", async () => {
    const { messenger, gateway, channel, received } = await fixture();
    const text = { name: "text", type: ApplicationCommandOptionType.String, value: "high" };
    for (const patch of [
      { commandName: "hermes" }, { commandName: "status", options: { data: [text] } },
      ...[
        [text, text], [{ ...text, name: "model" }], [{ ...text, type: ApplicationCommandOptionType.Integer, value: 3 }],
        [{ ...text, options: [] }], [{ ...text, focused: true }], [{ name: "text", type: ApplicationCommandOptionType.String }],
        [{ name: "subcommand", type: ApplicationCommandOptionType.Subcommand, options: [] }],
      ].map(data => ({ commandName: "model", options: { data } })),
    ]) {
      const command = commandInteraction(channel, patch);
      gateway.emit(Events.InteractionCreate, command);
      await drain();
      expect(command.replies).toHaveLength(1);
      expect(command.replies[0]!.content).toContain("unsupported or stale");
      expect(command.deferred).toBe(0);
    }
    expect(received).toEqual([]);
    expect(gateway.lookups).toEqual([]);
    await messenger.stop();
  });

  test("duplicate deliveries keep one durable event identity, distinct from real message identity", async () => {
    const { messenger, gateway, channel, received } = await fixture();
    for (let index = 0; index < 2; index++) {
      gateway.emit(Events.InteractionCreate, commandInteraction(channel));
      await drain();
    }
    gateway.emit(Events.MessageCreate, inbound(channel, { id: "200", content: "/status" }));
    await drain();
    expect(received).toHaveLength(3);
    expect(received[0]).toEqual(received[1]);
    expect(received[0]!.id).toBe("discord:bot:interaction:200");
    expect(received[0]!.messageId).toBeNull();
    expect(received[0]!.interactionId).toBe("200");
    expect(received[2]!.id).toBe("discord:bot:200:original");
    expect(received[2]!.messageId).toBe("200");
    expect(received[2]!.interactionId).toBeUndefined();
    expect(channel.fetched).toEqual([]);
    await messenger.stop();
  });

  test("uncertain durable admission is redacted, never reports success, and never replays", async () => {
    const gateway = new Gateway();
    const channel = new Channel();
    const errors: unknown[] = [];
    let admissions = 0;
    const messenger = new DiscordMessenger({ token: "unused", ownerId: owner, allowedGuildIds: ["guild"], allowedChannelIds: ["parent"], client: gateway as unknown as Client, onError: error => errors.push(error) });
    await messenger.start({ message: async () => { admissions++; throw new Error("secret-interaction-token in admission failure"); }, answer: async () => {} });
    const command = commandInteraction(channel);
    gateway.emit(Events.InteractionCreate, command);
    await drain();
    expect(admissions).toBe(1);
    expect(command.replies).toHaveLength(1);
    expect(command.replies[0]!.content).toContain("could not confirm acceptance");
    expect(command.replies[0]!.content).toContain("may already have been recorded");
    expect(command.replies[0]!.content).not.toMatch(/accepted this command|resubmit|try again/i);
    expect(command.deferred).toBe(0);
    expect(command.followups).toBe(0);
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).not.toContain("secret-interaction-token");
    expect((errors[0] as Error).cause).toBeUndefined();
    await messenger.stop();
  });

  test.each(["accepted", "refused"] as const)("%s ACK errors cannot leak tokens, retry admission, or invoke followups", async state => {
    const { messenger, gateway, channel, received, errors } = await fixture();
    const command = commandInteraction(channel, state === "refused" ? { user: { id: "stranger", bot: false } } : {});
    let attempts = 0;
    command.reply = async () => { attempts++; throw Object.assign(new Error("https://discord.com/api/interactions/200/secret-interaction-token/callback"), { requestBody: { token: "secret-interaction-token" } }); };
    gateway.emit(Events.InteractionCreate, command);
    await drain();
    expect(attempts).toBe(1);
    expect(received).toHaveLength(state === "accepted" ? 1 : 0);
    expect(command.followups).toBe(0);
    expect(command.deferred).toBe(0);
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain("acknowledgement failed");
    expect(String(errors[0])).not.toContain("secret-interaction-token");
    expect((errors[0] as Error).cause).toBeUndefined();
    await messenger.stop();
  });

  test("channel lookup failures are redacted and cannot admit or claim success", async () => {
    const { messenger, gateway, received, errors } = await fixture();
    gateway.channels.fetch = async () => { throw new Error("secret-interaction-token from SDK"); };
    const command = commandInteraction(null);
    gateway.emit(Events.InteractionCreate, command);
    await drain();
    expect(received).toEqual([]);
    expect(command.replies[0]!.content).toContain("nothing was admitted");
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).not.toContain("secret-interaction-token");
    expect((errors[0] as Error).cause).toBeUndefined();
    await messenger.stop();
  });
});

describe("Discord attachment credential boundary", () => {
  const attachment: Attachment = { id: "200", name: "file.txt", url: "https://cdn.discordapp.com/attachments/100/200/file.txt?ex=a&is=b&hm=c", size: 3 };

  test("authenticates the original physical thread before fetching without credentials or redirects", async () => {
    const calls: { url: string; options: RequestInit | undefined }[] = [];
    const response = new Response("abc");
    const { messenger, gateway } = await fixture({ fetch: async (input, options) => { calls.push({ url: String(input), options }); return response; } });
    const thread = new Channel("100", "guild", "parent");
    gateway.channelMap.set(thread.id, thread);
    const signal = new AbortController().signal;
    expect(await messenger.openAttachment({ ...route, threadId: thread.id }, attachment, signal)).toBe(response);
    expect(gateway.lookups).toEqual(["100"]);
    expect(calls).toEqual([{ url: attachment.url, options: { redirect: "error", credentials: "omit", signal } }]);
    expect(JSON.stringify(calls)).not.toContain("unused");
    await messenger.stop();
  });

  test("rejects forged account, authority, resource, parent, and DM recipient before CDN access", async () => {
    let downloads = 0;
    const { messenger, gateway } = await fixture({ fetch: async () => { downloads++; return new Response("abc"); } });
    const signal = new AbortController().signal;
    const destination = { ...route, threadId: "100" };
    for (const forged of [{ ...destination, platform: "slack" as const }, { ...destination, accountId: "other" }, { ...destination, authorityId: "other" }, { ...destination, guildId: "other" }]) {
      await expect(messenger.openAttachment(forged, attachment, signal)).rejects.toMatchObject({ certainty: "rejected" });
    }
    for (const forged of [
      { ...attachment, id: "201" }, { ...attachment, url: attachment.url.replace("/100/", "/101/") },
      { ...attachment, url: "https://cdn.discordapp.com/not-attachments/100/200/file.txt" },
      { ...attachment, url: "https://unused@cdn.discordapp.com/attachments/100/200/file.txt" },
    ]) await expect(messenger.openAttachment(destination, forged, signal)).rejects.toMatchObject({ certainty: "rejected" });
    expect(gateway.lookups).toEqual([]);
    gateway.channelMap.set("100", new Channel("100", "guild", "other-parent"));
    await expect(messenger.openAttachment(destination, attachment, signal)).rejects.toThrow("destination identity changed");
    const dm = new Channel("100", null); dm.recipientId = "stranger"; gateway.channelMap.set(dm.id, dm);
    await expect(messenger.openAttachment({ ...route, guildId: null, channelId: "100" }, attachment, signal)).rejects.toThrow("DM does not belong");
    expect(downloads).toBe(0);
    await messenger.stop();
  });

  test("logical DM topics use the same authenticated resource and preserve cancellation", async () => {
    const signal = new AbortController().signal;
    const calls: RequestInit[] = [];
    const { messenger, gateway } = await fixture({ fetch: async (_input, options) => { calls.push(options!); return new Response("abc"); } });
    const dm = new Channel("100", null); gateway.channelMap.set(dm.id, dm);
    for (const topicId of ["old-topic", "new-topic"]) await messenger.openAttachment({ ...route, guildId: null, channelId: "100", topicId }, { ...attachment, url: attachment.url.replace("cdn.discordapp.com", "media.discordapp.net") }, signal);
    expect(gateway.lookups).toEqual(["100", "100"]);
    expect(calls.map(call => call.signal)).toEqual([signal, signal]);
    await messenger.stop();
  });

  test("HTTP failure is not retried and cannot expose credential-like exception text", async () => {
    let downloads = 0;
    const { messenger, gateway } = await fixture({ fetch: async (_input, options) => { downloads++; expect(options!.redirect).toBe("error"); throw new Error("unused secret from HTTP boundary"); } });
    gateway.channelMap.set("100", new Channel("100", "guild", "parent"));
    try {
      await messenger.openAttachment({ ...route, threadId: "100" }, attachment, new AbortController().signal);
      throw new Error("download unexpectedly succeeded");
    } catch (error) {
      expect(error).toMatchObject({ certainty: "rejected", message: "Discord attachment download failed" });
      expect((error as Error).cause).toBeUndefined();
    }
    expect(downloads).toBe(1);
    await messenger.stop();
  });
});

describe("Discord output delivery", () => {
  test("long output is one attachment with stable scoped nonce and no mentions", async () => {
    const { messenger, channel, gateway } = await fixture();
    const thread = new Channel("thread", "guild", "parent");
    gateway.channelMap.set(thread.id, thread);
    const target = { ...route, threadId: "thread" };
    const receipt = await messenger.send(output("@everyone " + "x".repeat(2000), target));
    expect(receipt).toBe("remote-1");
    expect(channel.sent).toHaveLength(0);
    expect(thread.sent).toHaveLength(1);
    expect(thread.sent[0]!.allowedMentions).toEqual({ parse: [], repliedUser: false });
    expect(thread.sent[0]!.files).toHaveLength(1);
    expect(thread.sent[0]!.nonce).toBe(discordNonce("output", target));
    expect(thread.sent[0]!.enforceNonce).toBe(true);
    expect(discordNonce("output", target, 1)).not.toBe(discordNonce("output", target));
    expect(discordNonce("output", route)).not.toBe(discordNonce("output", target));
    expect(gateway.rest.options.retries).toBe(0);
    await messenger.stop();
  });

  test("timeout and 5xx are uncertain and never retried; 403 and rate limits are rejected", async () => {
    const { messenger, channel } = await fixture();
    channel.failure = Object.assign(new Error("socket closed after write"), { status: 503 });
    try { await messenger.send(output("result")); throw new Error("send unexpectedly succeeded"); }
    catch (error) { expect(error).toBeInstanceOf(DeliveryError); expect((error as DeliveryError).certainty).toBe("uncertain"); }
    expect(channel.sent).toHaveLength(1);
    expect(deliveryError(new Error("timeout")).certainty).toBe("uncertain");
    expect(deliveryError({ status: 408 }).certainty).toBe("uncertain");
    expect(deliveryError({ status: 403 }).certainty).toBe("rejected");
    expect(deliveryError({ name: "RateLimitError", retryAfter: 1250 })).toMatchObject({ certainty: "rejected", retryAfterMs: 1250 });
    await messenger.stop();
  });

  test("forged account, authority, thread parent, and DM recipient fail before sending", async () => {
    const { messenger, gateway, channel } = await fixture();
    for (const forged of [{ ...route, accountId: "other" }, { ...route, authorityId: "other" }, { ...route, guildId: "other" }]) await expect(messenger.send(output("bad", forged))).rejects.toMatchObject({ certainty: "rejected" });
    const thread = new Channel("thread", "guild", "different-parent");
    gateway.channelMap.set(thread.id, thread);
    await expect(messenger.send(output("bad", { ...route, threadId: "thread" }))).rejects.toMatchObject({ certainty: "rejected" });
    const dm = new Channel("dm", null); dm.recipientId = "stranger"; gateway.channelMap.set(dm.id, dm);
    await expect(messenger.send(output("bad", { ...route, guildId: null, channelId: "dm" }))).rejects.toMatchObject({ certainty: "rejected" });
    expect(channel.sent).toHaveLength(0);
    expect(thread.sent).toHaveLength(0);
    expect(dm.sent).toHaveLength(0);
    await messenger.stop();
  });

  test("logical DM output topics share real Discord destination but retain distinct delivery identity", async () => {
    const { messenger, gateway } = await fixture();
    const dm = new Channel("dm", null);
    gateway.channelMap.set(dm.id, dm);
    const oldTopic: Route = { ...route, guildId: null, channelId: dm.id, topicId: "old-topic" };
    const newTopic: Route = { ...oldTopic, topicId: "new-topic" };
    await messenger.send(output("old result", oldTopic));
    await messenger.send(output("new result", newTopic));
    expect(gateway.lookups).toEqual(["dm", "dm"]);
    expect(dm.sent.map(value => value.content)).toEqual(["old result", "new result"]);
    expect(dm.sent[0]!.nonce).not.toBe(dm.sent[1]!.nonce);
    await messenger.stop();
  });
});

describe("Discord message activity", () => {
  test.each([
    ["channel", route],
    ["thread", { ...route, threadId: "thread" }],
    ["logical DM topic", { ...route, guildId: null, channelId: "dm", topicId: "original-topic" }],
  ] as const)("own reactions preserve receipt and other users in the original %s", async (_name, target) => {
    const { messenger, gateway } = await fixture();
    gateway.channelMap.set("thread", new Channel("thread", "guild", "parent"));
    gateway.channelMap.set("dm", new Channel("dm", null));
    const channelId = target.threadId ?? target.channelId;
    const eyes = `${channelId}:100:\u{1F440}`;
    const thought = `${channelId}:100:\u{1F4AD}`;
    gateway.reactions.set(thought, new Set(["stranger"]));
    try {
      for (const activity of ["received", "received", "thinking", "thinking"] as const) await messenger.setActivity({ route: target, messageId: "100" }, activity);
      expect(gateway.reactions.get(eyes)).toEqual(new Set([bot]));
      expect(gateway.reactions.get(thought)).toEqual(new Set(["stranger", bot]));
      await messenger.setActivity({ route: target, messageId: "100" }, "idle");
      await messenger.setActivity({ route: target, messageId: "100" }, "idle");
      expect([...gateway.reactions]).toEqual([[thought, new Set(["stranger"])], [eyes, new Set([bot])]]);
      const prefix = `/channels/${channelId}/messages/100/reactions/`;
      expect(gateway.reactionCalls).toEqual([
        { method: "PUT", path: `${prefix}%F0%9F%91%80/@me` },
        { method: "PUT", path: `${prefix}%F0%9F%91%80/@me` },
        { method: "PUT", path: `${prefix}%F0%9F%92%AD/@me` },
        { method: "PUT", path: `${prefix}%F0%9F%92%AD/@me` },
        { method: "DELETE", path: `${prefix}%F0%9F%92%AD/@me` },
        { method: "DELETE", path: `${prefix}%F0%9F%92%AD/@me` },
      ]);
    } finally { await messenger.stop(); }
  });

  test("foreign route identities and malformed message IDs cannot mutate reactions", async () => {
    const { messenger, gateway } = await fixture();
    const dm = new Channel("dm", null); dm.recipientId = "stranger";
    gateway.channelMap.set("dm", dm);
    gateway.channelMap.set("thread", new Channel("thread", "guild", "different-parent"));
    const foreign: Route[] = [
      { ...route, platform: "telegram" }, { ...route, accountId: "other" }, { ...route, authorityId: "other" },
      { ...route, guildId: "other" }, { ...route, channelId: "other" }, { ...route, threadId: "thread" },
      { ...route, guildId: null, channelId: "dm" },
    ];
    try {
      for (const target of foreign) for (const activity of ["received", "thinking", "idle"] as const) {
        await expect(messenger.setActivity({ route: target, messageId: "100" }, activity)).rejects.toMatchObject({ certainty: "rejected" });
      }
      for (const messageId of ["", "100/../101", "not-a-snowflake", "1".repeat(21)]) {
        await expect(messenger.setActivity({ route, messageId }, "received")).rejects.toMatchObject({ certainty: "rejected" });
      }
      expect(gateway.reactionCalls).toEqual([]);
      expect(gateway.reactions.size).toBe(0);
    } finally { await messenger.stop(); }
  });

  test.each([
    { failure: Object.assign(new Error("secret-discord-token"), { status: 403 }), certainty: "rejected", retryAfterMs: undefined },
    { failure: Object.assign(new Error("secret-discord-token"), { status: 503 }), certainty: "uncertain", retryAfterMs: undefined },
    { failure: Object.assign(new Error("secret-discord-token"), { name: "RateLimitError", retryAfter: 1250 }), certainty: "rejected", retryAfterMs: 1250 },
  ])("reaction failure is sanitized and not retried ($certainty)", async ({ failure, certainty, retryAfterMs }) => {
    const { messenger, gateway } = await fixture();
    gateway.reactionFailure = failure;
    try {
      const caught: unknown = await messenger.setActivity({ route, messageId: "100" }, "thinking").catch((error: unknown) => error);
      expect(caught).toBeInstanceOf(DeliveryError);
      if (!(caught instanceof DeliveryError)) throw new Error("Expected a sanitized delivery error");
      expect(caught.certainty).toBe(certainty);
      expect(caught.retryAfterMs).toBe(retryAfterMs);
      expect(String(caught)).not.toContain("secret-discord-token");
      expect(caught.cause).toBeUndefined();
      expect(gateway.reactionCalls).toHaveLength(1);
      expect(gateway.reactions.size).toBe(0);
    } finally { await messenger.stop(); }
  });
});

describe("Discord approval controls", () => {
  test("strict bounded control IDs cannot inject arbitrary approval identities", () => {
    const token = "a".repeat(24);
    expect(parseDiscordControl(`omp:${token}:next-3`)).toEqual({ token, action: "next-3" });
    for (const value of [`omp:${token}:next-3:extra`, `omp:${token}:yes\n`, "omp:approval:yes", `prefix:omp:${token}:yes`]) expect(parseDiscordControl(value)).toBeNull();
  });

  for (const { name, request, action, kind, response } of [
    { name: "confirmation", request: { method: "confirm", title: "Deploy?", message: "External action" }, action: "yes", kind: "button", response: { confirmed: true } },
    { name: "decline", request: { method: "confirm", title: "Deploy?", message: "External action" }, action: "no", kind: "button", response: { confirmed: false } },
    { name: "cancellation", request: { method: "confirm", title: "Deploy?", message: "External action" }, action: "cancel", kind: "button", response: { cancelled: true } },
    { name: "selection", request: { method: "select", title: "Pick", options: ["one", "two"] }, action: "select", kind: "select", response: { value: "one" } },
    { name: "input modal", request: { method: "input", title: "Input" }, action: "value", kind: "modal", response: { value: "typed answer" } },
    { name: "editor modal", request: { method: "editor", title: "Edit", prefill: "initial" }, action: "value", kind: "modal", response: { value: "typed answer" } },
    { name: "final ask submission", request: { method: "ask", questions: [{ id: "q1", question: "Anything?", options: [] }] }, action: "next-0", kind: "button", response: { answers: [{ id: "q1", selectedOptions: [] }] } },
  ] as const) {
    test(`${name} waits for durable admission and remains actionable after admission failure`, async () => {
      const rejected = Promise.withResolvers<void>();
      const accepted = Promise.withResolvers<void>();
      const failure = new Error("Durable admission unavailable");
      const order: string[] = [];
      let admissions = 0;
      const { messenger, channel, gateway, answers, errors } = await fixture({}, async () => {
        order.push(`admit:${++admissions}`);
        await (admissions === 1 ? rejected.promise : accepted.promise);
        order.push("durable");
      });
      const id = await messenger.showApproval(approval({ request }));
      const message = channel.remote.get(id)!;
      const customId = control(message, action);
      if (kind === "modal") {
        const open = interaction(message, control(message, "open"));
        gateway.emit(Events.InteractionCreate, open);
        await drain();
        expect(open.modals).toHaveLength(1);
        expect(open.ack).toBe(0);
        expect(admissions).toBe(0); // Opening an editor does not admit a final answer.
      }
      const edit = message.edit.bind(message);
      message.edit = async payload => { order.push("dismiss"); return edit(payload); };
      const first = interaction(message, customId, kind);
      gateway.emit(Events.InteractionCreate, first);
      await drain();
      expect(order).toEqual(["admit:1"]);
      expect(first.ack).toBe(0);
      expect(answers).toEqual([]);
      expect(message.edits).toEqual([]);
      expect(message.components.length).toBeGreaterThan(0);

      const simultaneous = interaction(message, customId, kind);
      gateway.emit(Events.InteractionCreate, simultaneous);
      await drain();
      expect(simultaneous.replies).toHaveLength(1);
      expect(admissions).toBe(1);
      rejected.reject(failure);
      await drain();
      expect(errors).toEqual([failure]);
      expect(first.ack).toBe(0);
      expect(message.edits).toEqual([]);
      expect(message.components.length).toBeGreaterThan(0);
      expect(await messenger.showApproval(approval({ request, remoteId: id }))).toBe(id);
      expect(channel.sent).toHaveLength(1);
      await drain();
      expect(admissions).toBe(1); // No automatic replay on an unacknowledged failure.

      const retry = interaction(message, customId, kind);
      retry.deferUpdate = async () => { retry.ack++; order.push("ack"); };
      gateway.emit(Events.InteractionCreate, retry);
      await drain();
      expect(order).toEqual(["admit:1", "admit:2"]);
      expect(retry.ack).toBe(0);
      expect(message.edits).toEqual([]);
      accepted.resolve();
      await drain();
      expect(order).toEqual(["admit:1", "admit:2", "durable", "ack", "dismiss"]);
      expect(retry.ack).toBe(1);
      expect(answers).toEqual([{ id: "approval", response, route }]);
      expect(message.components).toEqual([]);
      gateway.emit(Events.InteractionCreate, interaction(message, customId, kind));
      await drain();
      expect(admissions).toBe(2);
      expect(answers).toHaveLength(1);
      await messenger.stop();
    });
  }

  for (const failurePoint of ["ack", "dismiss"] as const) {
    test(`an ambiguous ${failurePoint} failure after durable admission never resubmits the answer`, async () => {
      const { messenger, channel, gateway, answers, errors } = await fixture();
      const id = await messenger.showApproval(approval());
      const message = channel.remote.get(id)!;
      const customId = control(message, "yes");
      const failure = new Error("Connection closed after remote write");
      const click = interaction(message, customId);
      if (failurePoint === "ack") click.deferUpdate = async () => { click.ack++; throw failure; };
      else message.editFailure = failure;
      gateway.emit(Events.InteractionCreate, click);
      await drain();
      expect(answers).toEqual([{ id: "approval", response: { confirmed: true }, route }]);
      expect(click.ack).toBe(1);
      expect(errors).toHaveLength(1);
      expect(message.edits).toHaveLength(1);
      const repeated = interaction(message, customId);
      gateway.emit(Events.InteractionCreate, repeated);
      await drain();
      expect(repeated.replies).toHaveLength(1);
      expect(answers).toHaveLength(1);
      expect(message.edits).toHaveLength(1);
      await messenger.stop();
    });
  }

  test("owner, source message, route, and generation are independently bound", async () => {
    const { messenger, channel, gateway, answers } = await fixture();
    const id = await messenger.showApproval(approval());
    const message = channel.remote.get(id)!;
    const yes = control(message, "yes");
    for (const patch of [{ user: { id: "stranger" } }, { channelId: "other" }, { guildId: "other" }, { message: new RemoteMessage("forged", "parent", "guild", {}) }]) {
      const click = interaction(message, yes, "button", patch);
      gateway.emit(Events.InteractionCreate, click); await drain();
      expect(click.replies).toHaveLength(1); expect(click.ack).toBe(0);
    }
    const newId = await messenger.showApproval(approval({ generation: 8 }));
    const oldClick = interaction(message, yes);
    gateway.emit(Events.InteractionCreate, oldClick); await drain();
    expect(oldClick.replies).toHaveLength(1);
    const current = channel.remote.get(newId)!;
    const click = interaction(current, control(current, "yes"));
    gateway.emit(Events.InteractionCreate, click); await drain();
    expect(click.ack).toBe(1);
    expect(answers).toEqual([{ id: "approval", response: { confirmed: true }, route }]);
    expect(current.components).toEqual([]);
    gateway.emit(Events.InteractionCreate, click); await drain();
    expect(answers).toHaveLength(1);
    await messenger.stop();
  });

  test("select returns the exact original label, not a synthesized chat message", async () => {
    const { messenger, channel, gateway, answers, received } = await fixture();
    const id = await messenger.showApproval(approval({ request: { method: "select", title: "Pick", options: ["one", "two"] } }));
    const message = channel.remote.get(id)!;
    gateway.emit(Events.InteractionCreate, interaction(message, control(message, "select"), "select", { values: ["1"] }));
    await drain();
    expect(answers[0]!.response).toEqual({ value: "two" });
    expect(received).toEqual([]);
    await messenger.stop();
  });

  test("native checkbox selects show host state and return one exact label per toggle or action", async () => {
    const { messenger, channel, gateway, answers } = await fixture();
    const request = { method: "select", title: "Choose", options: ["Alpha", "Beta", "Other", "Done selecting"], selectionMarker: "checkbox", markableCount: 3, checkedIndices: [0, 2] };
    const id = await messenger.showApproval(approval({ request }));
    const message = channel.remote.get(id)!;
    expect(channel.sent[0]!.content).toContain("☑️ Alpha");
    expect(channel.sent[0]!.content).toContain("⬜ Beta");
    expect(channel.sent[0]!.content).toContain("☑️ Other");
    expect(channel.sent[0]!.content).not.toContain("⬜ Done selecting");
    const row = channel.sent[0]!.components![0]!;
    const data = "toJSON" in row ? row.toJSON() : row;
    expect(data).toMatchObject({ components: [{ min_values: 1, max_values: 1, options: [
      { label: "Alpha", value: "0", emoji: { name: "☑️" } },
      { label: "Beta", value: "1", emoji: { name: "⬜" } },
      { label: "Other", value: "2", emoji: { name: "☑️" } },
      { label: "Done selecting", value: "3" },
    ] }] });
    gateway.emit(Events.InteractionCreate, interaction(message, control(message, "select"), "select", { values: ["1"] }));
    await drain();
    expect(answers[0]!.response).toEqual({ value: "Beta" });
    const nextId = await messenger.showApproval(approval({ id: "next-checkbox", requestId: "next-request", request: { ...request, checkedIndices: [0, 1, 2] } }));
    const next = channel.remote.get(nextId)!;
    expect(channel.sent[1]!.content).toContain("☑️ Beta");
    gateway.emit(Events.InteractionCreate, interaction(next, control(next, "select"), "select", { values: ["3"] }));
    await drain();
    expect(answers[1]!.response).toEqual({ value: "Done selecting" });
    await messenger.stop();
  });

  test("modal responses retain original message and route and acknowledge submission", async () => {
    const { messenger, channel, gateway, answers } = await fixture();
    const id = await messenger.showApproval(approval({ request: { method: "editor", title: "Edit", prefill: "initial" } }));
    const message = channel.remote.get(id)!;
    const click = interaction(message, control(message, "open"));
    gateway.emit(Events.InteractionCreate, click); await drain();
    expect(click.modals).toHaveLength(1); expect(click.ack).toBe(0);
    const forged = interaction(message, control(message, "value"), "modal", { isFromMessage: () => false });
    gateway.emit(Events.InteractionCreate, forged); await drain();
    expect(forged.replies).toHaveLength(1); expect(answers).toHaveLength(0);
    const submit = interaction(message, control(message, "value"), "modal");
    gateway.emit(Events.InteractionCreate, submit); await drain();
    expect(submit.ack).toBe(1); expect(answers[0]).toEqual({ id: "approval", response: { value: "typed answer" }, route });
    await messenger.stop();
  });

  test("late old-topic modal answers retain their original logical route after a new topic card appears", async () => {
    const { messenger, gateway, answers, received } = await fixture();
    const dm = new Channel("dm", null);
    gateway.channelMap.set(dm.id, dm);
    const oldRoute: Route = { ...route, guildId: null, channelId: dm.id, topicId: "old-topic" };
    const newRoute: Route = { ...oldRoute, topicId: "new-topic" };
    const oldId = await messenger.showApproval(approval({ id: "old-approval", target: "old-lane", requestId: "old-request", route: oldRoute, request: { method: "input", title: "Old question" } }));
    const oldCard = dm.remote.get(oldId)!;
    const oldValue = control(oldCard, "value");
    const open = interaction(oldCard, control(oldCard, "open"));
    gateway.emit(Events.InteractionCreate, open); await drain();
    expect(open.modals).toHaveLength(1);
    const newId = await messenger.showApproval(approval({ id: "new-approval", target: "new-lane", requestId: "new-request", route: newRoute, request: { method: "input", title: "New question" } }));
    const newCard = dm.remote.get(newId)!;
    const newValue = control(newCard, "value");
    // Ordinary chat, even a reply to a card, is never synthesized into an
    // approval answer or assigned a logical topic by this transport.
    gateway.emit(Events.MessageCreate, inbound(dm, { content: "/main", reference: { messageId: newId } }));
    await drain();
    expect(answers).toEqual([]);
    expect(received[0]!.route).toEqual({ ...route, guildId: null, channelId: dm.id });
    const late = interaction(oldCard, oldValue, "modal", { fields: { getTextInputValue: () => "old answer" } });
    gateway.emit(Events.InteractionCreate, late); await drain();
    expect(late.ack).toBe(1);
    expect(answers).toEqual([{ id: "old-approval", response: { value: "old answer" }, route: oldRoute }]);
    expect(newCard.components.length).toBeGreaterThan(0);
    gateway.emit(Events.InteractionCreate, interaction(newCard, newValue, "modal", { fields: { getTextInputValue: () => "new answer" } }));
    await drain();
    expect(answers[1]).toEqual({ id: "new-approval", response: { value: "new answer" }, route: newRoute });
    await messenger.stop();
  });

  test("a modal token cannot borrow another topic's card even in the same owner DM", async () => {
    const { messenger, gateway, answers } = await fixture();
    const dm = new Channel("dm", null);
    gateway.channelMap.set(dm.id, dm);
    const oldRoute: Route = { ...route, guildId: null, channelId: dm.id, topicId: "old-topic" };
    const newRoute: Route = { ...oldRoute, topicId: "new-topic" };
    const oldId = await messenger.showApproval(approval({ id: "old-approval", route: oldRoute, request: { method: "editor", title: "Old" } }));
    const newId = await messenger.showApproval(approval({ id: "new-approval", route: newRoute, request: { method: "editor", title: "New" } }));
    const oldCard = dm.remote.get(oldId)!;
    const newCard = dm.remote.get(newId)!;
    const oldValue = control(oldCard, "value");
    const newValue = control(newCard, "value");
    for (const forged of [
      interaction(newCard, oldValue, "modal"),
      interaction(oldCard, newValue, "modal"),
      interaction(oldCard, oldValue, "modal", { channelId: "foreign-dm" }),
      interaction(oldCard, oldValue, "modal", { message: new RemoteMessage(oldId, "foreign-dm", null, {}) }),
    ]) {
      gateway.emit(Events.InteractionCreate, forged); await drain();
      expect(forged.replies).toHaveLength(1);
      expect(forged.ack).toBe(0);
    }
    expect(answers).toEqual([]);
    gateway.emit(Events.InteractionCreate, interaction(oldCard, oldValue, "modal")); await drain();
    expect(answers[0]!.route).toEqual(oldRoute);
    expect(newCard.components.length).toBeGreaterThan(0);
    await messenger.stop();
  });

  test("secret input and unrepresentable controls visibly cancel without rendering content", async () => {
    const { messenger, channel, answers } = await fixture();
    await messenger.showApproval(approval({ request: { method: "input", title: "SECRET-TITLE", placeholder: "SECRET-CONTENT", secret: true } }));
    expect(channel.sent[0]!.content).toContain("Request cancelled");
    expect(channel.sent[0]!.content).not.toContain("SECRET");
    expect(channel.sent[0]!.components).toBeUndefined();
    await messenger.showApproval(approval({ id: "other", request: { method: "select", title: "Malformed", options: ["a"], selectionMarker: "checkbox", markableCount: 2, checkedIndices: [0] } }));
    expect(answers.map(value => value.response)).toEqual([{ cancelled: true }, { cancelled: true }]);
    expect(channel.sent[1]!.content).toContain("Malformed marked-option count");
    await messenger.stop();
  });

  test("shared normalization does not relax Discord menu, modal, or attachment capacities", async () => {
    const { messenger, channel, answers } = await fixture();
    const requests = [
      { method: "select", title: "Many", options: Array.from({ length: 26 }, (_, index) => String(index)) },
      { method: "select", title: "Wide", options: ["x".repeat(101)] },
      { method: "select", title: "Details", options: ["one"], optionDetails: [{ description: "x".repeat(101) }] },
      { method: "ask", questions: [{ id: "q", question: "Many?", options: Array.from({ length: 26 }, (_, index) => ({ label: String(index) })) }] },
      { method: "ask", questions: [{ id: "q", question: "Wide?", options: [{ label: "x".repeat(101) }] }] },
      { method: "ask", questions: [{ id: "q", question: "Details?", options: [{ label: "one", description: "x".repeat(101) }] }] },
      { method: "input", title: "" },
      { method: "input", title: "x".repeat(46) },
      { method: "input", title: "Placeholder", placeholder: "x".repeat(101) },
      { method: "editor", title: "Edit", prefill: "x".repeat(4001) },
      { method: "confirm", title: "Huge", message: "x".repeat(8 * 1024 * 1024 - 64 * 1024) },
    ];
    for (const [index, request] of requests.entries()) await messenger.showApproval(approval({ id: `oversized-${index}`, request }));
    expect(channel.sent).toHaveLength(requests.length);
    expect(answers.map(value => value.response)).toEqual(requests.map(() => ({ cancelled: true })));
    for (const sent of channel.sent) {
      expect(sent.content).toContain("Request cancelled");
      expect(sent.components).toBeUndefined();
      expect(sent.files).toBeUndefined();
    }
    await messenger.stop();
  });

  test("ask preserves ordered question IDs and multi/free-text drafts after failed final admission", async () => {
    const failure = new Error("Durable admission unavailable");
    let accepting = false;
    let admissions = 0;
    const { messenger, channel, gateway, answers, errors } = await fixture({}, async () => {
      admissions++;
      if (!accepting) throw failure;
    });
    const id = await messenger.showApproval(approval({ request: { method: "ask", questions: [
      { id: "q1", question: "Single?", options: [{ label: "A" }, { label: "B" }] },
      { id: "q2", question: "Multiple?", multi: true, options: [{ label: "C" }, { label: "D" }] },
    ] } }));
    const message = channel.remote.get(id)!;
    const token = parseDiscordControl(message.components[0]!.components[0]!.customId)!.token;
    const act = async (action: string, kind: "button" | "select" | "modal" = "button", patch: Record<string, unknown> = {}) => {
      const click = interaction(message, `omp:${token}:${action}`, kind, patch);
      gateway.emit(Events.InteractionCreate, click); await drain();
      return click;
    };
    expect((await act("choose-0", "select", { values: ["0"] })).ack).toBe(1);
    const open = await act("other-0");
    expect(open.modals).toHaveLength(1);
    expect(open.ack).toBe(0);
    expect((await act("custom-0", "modal")).ack).toBe(1); // Free text replaces a single selection.
    expect((await act("next-0")).ack).toBe(1);
    expect((await act("choose-1", "select", { values: ["0", "1"] })).ack).toBe(1);
    expect((await act("custom-1", "modal")).ack).toBe(1);
    expect(admissions).toBe(0); // Partial progress only ACKs the current draft.
    const edits = message.edits.length;
    expect((await act("next-1")).ack).toBe(0);
    expect(errors).toEqual([failure]);
    expect(answers).toEqual([]);
    expect(message.edits).toHaveLength(edits);
    expect(message.components.length).toBeGreaterThan(0);
    // The same final question remains editable, retaining earlier questions and
    // free text rather than advancing beyond the dialog on a failed admission.
    expect((await act("choose-1", "select", { values: ["1"] })).ack).toBe(1);
    accepting = true;
    expect((await act("next-1")).ack).toBe(1);
    expect(admissions).toBe(2);
    expect(answers[0]!.response).toEqual({ answers: [
      { id: "q1", selectedOptions: [], customInput: "typed answer" },
      { id: "q2", selectedOptions: ["D"], customInput: "typed answer" },
    ] });
    await messenger.stop();
  });

  test("dismiss is idempotent and invalidates actions before deleting remote controls", async () => {
    const { messenger, channel, gateway, answers } = await fixture();
    const id = await messenger.showApproval(approval());
    const message = channel.remote.get(id)!;
    const yes = control(message, "yes");
    const persisted = approval({ remoteId: id });
    await messenger.dismissApproval(persisted);
    await messenger.dismissApproval(persisted);
    gateway.emit(Events.InteractionCreate, interaction(message, yes)); await drain();
    expect(message.components).toEqual([]);
    expect(answers).toEqual([]);
    await messenger.stop();
  });
});

describe("Discord explicit thread and recovery surfaces", () => {
  test("startup callbacks wait for restored cards without blocking login or rehydration", async () => {
    const first = await fixture();
    const id = await first.messenger.showApproval(approval());
    const card = first.channel.remote.get(id)!;
    const click = interaction(card, control(card, "yes"));
    await first.messenger.stop();
    const gateway = new Gateway();
    gateway.channelMap.set(first.channel.id, first.channel);
    const ready = Promise.withResolvers<void>();
    const answers: unknown[] = [];
    const messages: Inbound[] = [];
    let reconnects = 0;
    let fetched = 0;
    const messenger = new DiscordMessenger({ token: "unused", ownerId: owner, allowedGuildIds: ["guild"], allowedChannelIds: ["parent"], client: gateway as unknown as Client });
    await messenger.start({ ready: ready.promise, message: async input => { messages.push(input); }, answer: async (id, response, destination) => { answers.push({ id, response, destination }); }, reconnect: async () => { reconnects++; } });
    gateway.emit(Events.InteractionCreate, click);
    gateway.emit(Events.MessageCreate, inbound(first.channel, { partial: true, fetch: async () => { fetched++; return inbound(first.channel); } }));
    gateway.emit(Events.ShardResume, 0, 3);
    await drain();
    expect(answers).toEqual([]);
    expect(messages).toEqual([]);
    expect(fetched).toBe(0);
    expect(reconnects).toBe(0);
    expect(click.replies).toEqual([]);
    expect(click.ack).toBe(0);
    expect(await messenger.showApproval(approval({ remoteId: id }))).toBe(id);
    expect(first.channel.sent).toHaveLength(1);
    ready.resolve();
    await drain();
    expect(answers).toEqual([{ id: "approval", response: { confirmed: true }, destination: route }]);
    expect(messages).toHaveLength(1);
    expect(fetched).toBe(1);
    expect(reconnects).toBe(1);
    expect(click.ack).toBe(1);
    expect(card.components).toEqual([]);
    await messenger.stop();
  });

  test("stopping an unresolved startup gate releases intake and never admits callbacks", async () => {
    const gateway = new Gateway();
    const channel = new Channel();
    gateway.channelMap.set(channel.id, channel);
    const ready = Promise.withResolvers<void>();
    const delivered: unknown[] = [];
    const messenger = new DiscordMessenger({ token: "unused", ownerId: owner, allowedGuildIds: ["guild"], allowedChannelIds: ["parent"], client: gateway as unknown as Client });
    await messenger.start({ ready: ready.promise, message: async input => { delivered.push(input); }, answer: async (_id, response) => { delivered.push(response); }, reconnect: async () => { delivered.push("reconnect"); } });
    const id = await messenger.showApproval(approval());
    const card = channel.remote.get(id)!;
    const click = interaction(card, control(card, "yes"));
    gateway.emit(Events.MessageCreate, inbound(channel));
    gateway.emit(Events.InteractionCreate, click);
    gateway.emit(Events.ShardResume, 0, 3);
    await drain();
    await messenger.stop();
    expect(gateway.destroyed).toBe(true);
    ready.resolve();
    await drain();
    expect(delivered).toEqual([]);
    expect(click.ack).toBe(0);
  });

  test("a rejected startup gate stays closed for messages, reconnects, and restored controls", async () => {
    const gateway = new Gateway();
    const channel = new Channel();
    gateway.channelMap.set(channel.id, channel);
    const ready = Promise.withResolvers<void>();
    const delivered: unknown[] = [];
    const errors: unknown[] = [];
    const messenger = new DiscordMessenger({ token: "unused", ownerId: owner, allowedGuildIds: ["guild"], allowedChannelIds: ["parent"], client: gateway as unknown as Client, onError: error => { errors.push(error); } });
    await messenger.start({ ready: ready.promise, message: async input => { delivered.push(input); }, answer: async (_id, response) => { delivered.push(response); }, reconnect: async () => { delivered.push("reconnect"); } });
    const id = await messenger.showApproval(approval());
    const card = channel.remote.get(id)!;
    const click = interaction(card, control(card, "yes"));
    gateway.emit(Events.InteractionCreate, click);
    gateway.emit(Events.MessageCreate, inbound(channel));
    gateway.emit(Events.ShardResume, 0, 3);
    ready.reject(new Error("native restore failed"));
    await drain();
    gateway.emit(Events.MessageCreate, inbound(channel, { id: "101" }));
    await drain();
    expect(delivered).toEqual([]);
    expect(click.ack).toBe(0);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("Discord startup readiness failed; intake remains disabled");
    await messenger.stop();
  });

  test("controller restart rehydrates the persisted card by editing the exact receipt", async () => {
    const first = await fixture();
    const id = await first.messenger.showApproval(approval());
    const message = first.channel.remote.get(id)!;
    await first.messenger.stop();
    const gateway = new Gateway();
    gateway.channelMap.set(first.channel.id, first.channel);
    const answers: unknown[] = [];
    const messenger = new DiscordMessenger({ token: "unused", ownerId: owner, allowedGuildIds: ["guild"], allowedChannelIds: ["parent"], client: gateway as unknown as Client });
    await messenger.start({ message: async () => {}, answer: async (id, response, destination) => { answers.push({ id, response, destination }); } });
    expect(await messenger.showApproval(approval({ remoteId: id }))).toBe(id);
    expect(first.channel.sent).toHaveLength(1);
    expect(message.edits).toHaveLength(1);
    gateway.emit(Events.InteractionCreate, interaction(message, control(message, "yes"))); await drain();
    expect(answers).toEqual([{ id: "approval", response: { confirmed: true }, destination: route }]);
    await messenger.stop();
  });

  test("missing, foreign, mismatched, and ambiguously edited cards are never replaced", async () => {
    const { messenger, channel } = await fixture();
    await expect(messenger.showApproval(approval({ remoteId: "missing" }))).rejects.toMatchObject({ certainty: "rejected" });
    expect(channel.sent).toHaveLength(0);
    const foreign = new RemoteMessage("foreign", "parent", "guild", {});
    foreign.author = { id: "another-bot", bot: true };
    channel.remote.set(foreign.id, foreign);
    await expect(messenger.showApproval(approval({ remoteId: foreign.id }))).rejects.toMatchObject({ certainty: "rejected" });
    expect(foreign.edits).toHaveLength(0);
    const wrong = new RemoteMessage("wrong", "parent", "guild", {});
    wrong.components = [{ components: [{ customId: `omp:${"f".repeat(24)}:yes` }] }];
    channel.remote.set(wrong.id, wrong);
    await expect(messenger.showApproval(approval({ remoteId: wrong.id }))).rejects.toMatchObject({ certainty: "rejected" });
    expect(wrong.edits).toHaveLength(0);
    const uncertain = new RemoteMessage("uncertain", "parent", "guild", {});
    uncertain.editFailure = new Error("connection closed after edit");
    channel.remote.set(uncertain.id, uncertain);
    await expect(messenger.showApproval(approval({ remoteId: uncertain.id }))).rejects.toMatchObject({ certainty: "uncertain" });
    expect(uncertain.edits).toHaveLength(1);
    expect(channel.sent).toHaveLength(0);
    await messenger.stop();
  });

  test("rehydrating unsupported input cancels on its original card without a new receipt", async () => {
    const { messenger, channel, answers } = await fixture();
    const card = new RemoteMessage("persisted", "parent", "guild", {});
    channel.remote.set(card.id, card);
    const id = await messenger.showApproval(approval({ remoteId: card.id, request: { method: "input", title: "secret", secret: true, placeholder: "NEVER-SEND" } }));
    expect(id).toBe(card.id);
    expect(channel.sent).toHaveLength(0);
    expect(card.edits).toHaveLength(1);
    expect(card.edits[0]).toMatchObject({ content: expect.stringContaining("Request cancelled"), components: [] });
    expect(JSON.stringify(card.edits)).not.toContain("NEVER-SEND");
    expect(answers[0]!.response).toEqual({ cancelled: true });
    await messenger.stop();
  });

  test("resume and fresh-session reconnect hooks are awaited in intake order", async () => {
    const gateway = new Gateway();
    const channel = new Channel();
    const gate = Promise.withResolvers<void>();
    const order: string[] = [];
    const messenger = new DiscordMessenger({ token: "unused", ownerId: owner, allowedGuildIds: ["guild"], allowedChannelIds: ["parent"], client: gateway as unknown as Client });
    await messenger.start({ message: async input => { order.push(input.text); }, answer: async () => {}, reconnect: async () => { order.push("recover-start"); await gate.promise; order.push("recover-done"); } });
    gateway.emit(Events.ShardResume, 0, 3);
    gateway.emit(Events.MessageCreate, inbound(channel, { content: "after-reconnect" }));
    await drain();
    expect(order).toEqual(["recover-start"]);
    gate.resolve(); await drain();
    expect(order).toEqual(["recover-start", "recover-done", "after-reconnect"]);
    gateway.emit(Events.ShardReady, 0); await drain();
    expect(order.slice(-2)).toEqual(["recover-start", "recover-done"]);
    await messenger.stop();
    expect(gateway.listenerCount(Events.ShardResume)).toBe(0);
    expect(gateway.listenerCount(Events.ShardReady)).toBe(0);
  });

  test("creates a real guild thread but rejects DM and nested-thread targets", async () => {
    const { messenger } = await fixture();
    expect(await messenger.createThread(route, "lane title")).toEqual({ ...route, threadId: "created-thread" });
    await expect(messenger.createThread({ ...route, guildId: null, channelId: "dm" }, "lane")).rejects.toThrow("DMs cannot create threads");
    await expect(messenger.createThread({ ...route, threadId: "thread" }, "lane")).rejects.toThrow("cannot nest threads");
    await messenger.stop();
  });

  test("catchup requires explicit snowflake cursor, filters owner, and orders results", async () => {
    const { messenger, channel, gateway } = await fixture();
    channel.history = new Collection([
      ["103", inbound(channel, { id: "103", content: "later" })],
      ["102", inbound(channel, { id: "102", author: { id: "stranger", bot: false } })],
      ["101", inbound(channel, { id: "101", content: "earlier" })],
    ]);
    await expect(messenger.fetchAfter(route, "")).rejects.toThrow("stored Discord message snowflake");
    expect(gateway.lookups).toEqual([]);
    const values = await messenger.fetchAfter(route, "100");
    expect(values.map(value => value.messageId)).toEqual(["101", "103"]);
    expect(channel.fetched).toEqual([{ after: "100", limit: 100, cache: false }]);
    await messenger.stop();
  });

  test("logical-topic catchup reads the physical DM cursor and returns only physical inbound routes", async () => {
    const { messenger, gateway } = await fixture();
    const dm = new Channel("dm", null);
    gateway.channelMap.set(dm.id, dm);
    dm.history = new Collection([["101", inbound(dm, { id: "101" })]]);
    const logical: Route = { ...route, guildId: null, channelId: dm.id, topicId: "topic" };
    const values = await messenger.fetchAfter(logical, "100");
    expect(gateway.lookups).toEqual(["dm"]);
    expect(dm.fetched).toEqual([{ after: "100", limit: 100, cache: false }]);
    expect(values[0]!.route).toEqual({ ...route, guildId: null, channelId: dm.id });
    await messenger.stop();
  });
});
