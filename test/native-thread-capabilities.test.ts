import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { ChannelFlagsBitField, ChannelType, PermissionFlagsBits, PermissionsBitField, type Client, type MessageCreateOptions } from "discord.js";
import type { WebClientOptions } from "@slack/web-api";
import { DiscordMessenger } from "../src/discord.ts";
import { SlackMessenger, type SlackMessengerOptions } from "../src/slack.ts";
import { TelegramMessenger } from "../src/telegram.ts";
import { DeliveryError } from "../src/delivery.ts";
import type { Route } from "../src/contracts.ts";

// Only SDK transport boundaries are simulated. No bot, webhook, or socket is
// activated; capability reads run through the production adapter methods.
type Data = Record<string, any>;
const running: Array<{ stop(): Promise<void> }> = [];
afterEach(async () => { for (const messenger of running.splice(0)) await messenger.stop(); });
const handlers = { message: async () => {}, answer: async () => {} };
const discordRoute: Route = { platform: "discord", accountId: "bot", authorityId: "owner", guildId: "guild", channelId: "parent", threadId: null };
const telegramRoute: Route = { platform: "telegram", accountId: "900", authorityId: "42", guildId: "-100", channelId: "-100", threadId: null };
const telegramDm: Route = { ...telegramRoute, guildId: null, channelId: "42" };
const slackRoute: Route = { platform: "slack", accountId: "TOWN:UBOT", authorityId: "UOWNER", guildId: "TOWN", channelId: "CALLOWED", threadId: null };
const slackDm: Route = { ...slackRoute, guildId: null, channelId: "DOWNER" };

class DiscordChannel {
  type: ChannelType = ChannelType.GuildText;
  guildId: string | null = "guild";
  parentId: string | null = null;
  recipientId = "owner";
  flags = new ChannelFlagsBitField();
  permissions = new PermissionsBitField([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.CreatePublicThreads, PermissionFlagsBits.SendMessagesInThreads]);
  memberFailure: unknown;
  threadFailure: unknown;
  threadOptions: unknown[] = [];
  sent: MessageCreateOptions[] = [];
  source = new Map<string, Data>();
  sourceReads: string[] = [];
  constructor(readonly id = "parent") {}
  isThread() { return this.parentId !== null; }
  isSendable() { return this.type !== ChannelType.GuildForum && this.type !== ChannelType.GuildMedia; }
  permissionsFor() { return this.permissions; }
  guild = { members: { fetchMe: async (_options: unknown) => {
    if (this.memberFailure) throw this.memberFailure;
    return { id: "bot" };
  } } };
  created(id = "native-thread") {
    const thread = new DiscordChannel(id);
    thread.type = this.type === ChannelType.GuildAnnouncement ? ChannelType.AnnouncementThread : ChannelType.PublicThread;
    thread.parentId = this.id;
    return thread;
  }
  threads = { create: async (options: unknown) => {
    this.threadOptions.push(options);
    if (this.threadFailure) throw this.threadFailure;
    return this.created();
  } };
  messages = { fetch: async (id: string) => {
    this.sourceReads.push(id);
    const message = this.source.get(id);
    if (!message) throw new Error("Missing source");
    return message;
  } };
  async send(payload: MessageCreateOptions) {
    this.sent.push(payload);
    return { id: "123", channelId: this.id, guildId: this.guildId, author: { id: "bot" },
      startThread: async (options: unknown) => { this.threadOptions.push(options); return this.created("123"); } };
  }
}

class DiscordGateway extends EventEmitter {
  user = { id: "bot" };
  rest = { options: { retries: 0, rejectOnRateLimit: null as unknown } };
  lookups: Array<{ id: string; options: unknown }> = [];
  channel = new DiscordChannel();
  failure: unknown;
  channels = { fetch: async (id: string, options: unknown) => {
    this.lookups.push({ id, options });
    if (this.failure) throw this.failure;
    return this.channel;
  } };
  isReady() { return true; }
  async destroy() {}
}

async function discord() {
  const gateway = new DiscordGateway();
  const messenger = new DiscordMessenger({ token: "local-only", ownerId: "owner", allowedGuildIds: ["guild"], allowedChannelIds: ["parent"], client: gateway as unknown as Client });
  running.push(messenger);
  await messenger.start(handlers);
  return { messenger, gateway, channel: gateway.channel };
}

describe("Discord native topic capability", () => {
  test("authorized text and announcement roots require actual bot channel permissions", async () => {
    const f = await discord();
    for (const type of [ChannelType.GuildText, ChannelType.GuildAnnouncement]) {
      f.channel.type = type;
      expect(await f.messenger.canCreateThread(discordRoute)).toBe(true);
    }
    expect(f.gateway.lookups.every(read => (read.options as Data).force === true)).toBe(true);
    for (const permission of [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.CreatePublicThreads, PermissionFlagsBits.SendMessagesInThreads]) {
      f.channel.permissions.remove(permission);
      expect(await f.messenger.canCreateThread(discordRoute)).toBe(false);
      f.channel.permissions.add(permission);
    }
    expect(f.channel.sent).toEqual([]);
    expect(f.channel.threadOptions).toEqual([]);
  });

  test("DMs and existing threads issue no reads, unauthorized roots reject before lookup", async () => {
    const f = await discord();
    expect(await f.messenger.canCreateThread({ ...discordRoute, guildId: null, channelId: "dm", topicId: "logical" })).toBe(false);
    expect(await f.messenger.canCreateThread({ ...discordRoute, threadId: "thread" })).toBe(false);
    for (const patch of [{ guildId: "foreign" }, { channelId: "other" }, { authorityId: "other" }, { accountId: "other" }]) {
      await expect(f.messenger.canCreateThread({ ...discordRoute, ...patch })).rejects.toBeInstanceOf(DeliveryError);
    }
    expect(f.gateway.lookups).toEqual([]);
    for (const type of [ChannelType.GuildVoice, ChannelType.GuildCategory, ChannelType.GuildStageVoice]) {
      f.channel.type = type;
      expect(await f.messenger.canCreateThread(discordRoute)).toBe(false);
    }
    expect(f.channel.sent).toEqual([]);
    expect(f.channel.threadOptions).toEqual([]);
  });

  test("channel and member network/auth errors reject, never report unsupported", async () => {
    const f = await discord();
    f.gateway.failure = new Error("network down");
    await expect(f.messenger.canCreateThread(discordRoute)).rejects.toBeInstanceOf(DeliveryError);
    f.gateway.failure = undefined;
    f.channel.memberFailure = Object.assign(new Error("Unauthorized"), { status: 401 });
    await expect(f.messenger.canCreateThread(discordRoute)).rejects.toBeInstanceOf(DeliveryError);
  });

  test("creates actual public or announcement threads and preserves source identity", async () => {
    const f = await discord();
    expect(await f.messenger.createThread({ ...discordRoute, topicId: "logical" }, "Topic")).toEqual({ ...discordRoute, threadId: "native-thread" });
    expect(f.channel.threadOptions[0]).toEqual({ name: "Topic", type: ChannelType.PublicThread });
    f.channel.type = ChannelType.GuildAnnouncement;
    expect(await f.messenger.createThread(discordRoute, "Announcement")).toEqual({ ...discordRoute, threadId: "123" });
    expect(f.channel.sent).toEqual([{ content: "Announcement", allowedMentions: { parse: [], repliedUser: false } }]);
    f.channel.source.set("456", { id: "456", channelId: "parent", guildId: "guild", startThread: async () => f.channel.created("456") });
    expect(await f.messenger.createThread(discordRoute, "From source", "456")).toEqual({ ...discordRoute, threadId: "456" });
    expect(f.channel.sourceReads).toEqual(["456"]);
    expect(f.channel.sent).toHaveLength(1);
    f.channel.source.set("789", { id: "789", channelId: "other", guildId: "guild", startThread: async () => { throw new Error("Must not create"); } });
    await expect(f.messenger.createThread(discordRoute, "Wrong source", "789")).rejects.toThrow("does not belong");
  });

  test("forum and media roots create native starter-message topics without CREATE_PUBLIC_THREADS", async () => {
    for (const type of [ChannelType.GuildForum, ChannelType.GuildMedia]) {
      const f = await discord();
      f.channel.type = type;
      f.channel.permissions.remove(PermissionFlagsBits.CreatePublicThreads);
      expect(f.channel.permissions.has(PermissionFlagsBits.CreatePublicThreads)).toBe(false);
      expect(f.channel.isSendable()).toBe(false);
      expect(await f.messenger.canCreateThread(discordRoute)).toBe(true);
      expect(f.channel.sent).toEqual([]);
      expect(f.channel.threadOptions).toEqual([]);
      expect(f.channel.sourceReads).toEqual([]);
      expect(await f.messenger.createThread({ ...discordRoute, topicId: "logical" }, "Sibling topic")).toEqual({ ...discordRoute, threadId: "native-thread" });
      expect(f.channel.threadOptions).toEqual([{ name: "Sibling topic", message: {
        content: "Sibling topic", allowedMentions: { parse: [], repliedUser: false },
      } }]);
      expect(f.channel.sent).toEqual([]);
      expect(f.channel.sourceReads).toEqual([]);
      expect(f.gateway.lookups.every(read => (read.options as Data).force === true)).toBe(true);
    }
  });

  test("required forum/media tags reject honestly without creation or guessed tags", async () => {
    for (const type of [ChannelType.GuildForum, ChannelType.GuildMedia]) {
      const f = await discord();
      f.channel.type = type;
      f.channel.flags.add(ChannelFlagsBitField.Flags.RequireTag);
      await expect(f.messenger.canCreateThread(discordRoute)).rejects.toThrow("explicitly selected tag");
      await expect(f.messenger.createThread(discordRoute, "No tag selected")).rejects.toThrow("explicitly selected tag");
      expect(f.channel.sent).toEqual([]);
      expect(f.channel.threadOptions).toEqual([]);
      expect(f.channel.sourceReads).toEqual([]);
    }
  });

  test("forum/media source references refuse reuse without fetching or copying the source", async () => {
    for (const type of [ChannelType.GuildForum, ChannelType.GuildMedia]) {
      const f = await discord();
      f.channel.type = type;
      for (const source of ["456", ""]) {
        await expect(f.messenger.createThread(discordRoute, "Do not copy source", source)).rejects.toThrow("cannot reuse a source message");
      }
      expect(f.channel.sent).toEqual([]);
      expect(f.channel.threadOptions).toEqual([]);
      expect(f.channel.sourceReads).toEqual([]);
    }
  });

  test("forum/media creation requires every usable-topic permission and authorized scope", async () => {
    for (const type of [ChannelType.GuildForum, ChannelType.GuildMedia]) {
      const f = await discord();
      f.channel.type = type;
      for (const permission of [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.SendMessages, PermissionFlagsBits.SendMessagesInThreads]) {
        f.channel.permissions.remove(permission);
        expect(await f.messenger.canCreateThread(discordRoute)).toBe(false);
        await expect(f.messenger.createThread(discordRoute, "Permission denied")).rejects.toThrow("lacks permissions");
        f.channel.permissions.add(permission);
      }
      for (const patch of [{ guildId: "foreign" }, { channelId: "other" }, { authorityId: "other" }, { accountId: "other" }]) {
        await expect(f.messenger.canCreateThread({ ...discordRoute, ...patch })).rejects.toBeInstanceOf(DeliveryError);
        await expect(f.messenger.createThread({ ...discordRoute, ...patch }, "Unauthorized")).rejects.toBeInstanceOf(DeliveryError);
      }
      expect(f.channel.sent).toEqual([]);
      expect(f.channel.threadOptions).toEqual([]);
      expect(f.channel.sourceReads).toEqual([]);
    }
  });

  test("forum/media read failures reject rather than claiming unsupported or creating a topic", async () => {
    for (const type of [ChannelType.GuildForum, ChannelType.GuildMedia]) {
      const f = await discord();
      f.channel.type = type;
      f.gateway.failure = new Error("channel network failed");
      await expect(f.messenger.canCreateThread(discordRoute)).rejects.toBeInstanceOf(DeliveryError);
      await expect(f.messenger.createThread(discordRoute, "Do not create")).rejects.toBeInstanceOf(DeliveryError);
      f.gateway.failure = undefined;
      for (const failure of [new Error("member network failed"), Object.assign(new Error("Unauthorized"), { status: 401 })]) {
        f.channel.memberFailure = failure;
        await expect(f.messenger.canCreateThread(discordRoute)).rejects.toBeInstanceOf(DeliveryError);
        await expect(f.messenger.createThread(discordRoute, "Do not create")).rejects.toBeInstanceOf(DeliveryError);
      }
      expect(f.channel.sent).toEqual([]);
      expect(f.channel.threadOptions).toEqual([]);
      expect(f.channel.sourceReads).toEqual([]);
    }
  });

  test("forum/media native mutation network failures remain uncertain with no fallback post", async () => {
    for (const type of [ChannelType.GuildForum, ChannelType.GuildMedia]) {
      const f = await discord();
      f.channel.type = type;
      f.channel.threadFailure = new Error("native create connection lost");
      await expect(f.messenger.createThread(discordRoute, "Uncertain native topic")).rejects.toMatchObject({ certainty: "uncertain" });
      expect(f.channel.threadOptions).toEqual([{ name: "Uncertain native topic", message: {
        content: "Uncertain native topic", allowedMentions: { parse: [], repliedUser: false },
      } }]);
      expect(f.channel.sent).toEqual([]);
      expect(f.channel.sourceReads).toEqual([]);
    }
  });
});

class TelegramHTTP {
  calls: Array<{ method: string; args: Data }> = [];
  forum = true;
  chatType = "supergroup";
  topicsEnabled = false;
  memberStatus = "administrator";
  canManageTopics = true;
  failures = new Map<string, Error | Data>();
  readonly fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const method = String(input).split("/").at(-1)!;
    const args: Data = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    this.calls.push({ method, args });
    const failure = this.failures.get(method);
    if (failure instanceof Error) throw failure;
    if (failure) return Response.json({ ok: false, ...failure });
    let result: Data;
    if (method === "getMe") result = { id: 900, is_bot: true, first_name: "Local Bot", has_topics_enabled: this.topicsEnabled };
    else if (method === "getWebhookInfo") result = { url: "", pending_update_count: 0 };
    else if (method === "getChat") result = Number(args.chat_id) > 0 ? { id: Number(args.chat_id), type: "private", first_name: "Owner" } :
      { id: Number(args.chat_id), type: this.chatType, title: "Allowed", is_forum: this.forum };
    else if (method === "getChatMember") result = { status: this.memberStatus, user: { id: 900, is_bot: true, first_name: "Local Bot" }, can_manage_topics: this.canManageTopics };
    else if (method === "createForumTopic") result = { message_thread_id: 88, name: args.name, icon_color: 7322096 };
    else throw new Error(`Unexpected read-only Telegram method: ${method}`);
    return Response.json({ ok: true, result });
  }) as typeof fetch;
}

async function telegram() {
  const http = new TelegramHTTP();
  const meta = new Map<string, string>();
  const messenger = new TelegramMessenger({ token: "900:LOCAL_ONLY", ownerId: "42", allowedChatIds: ["-100"], fetch: http.fetch,
    store: { getMeta: key => meta.get(key) ?? null, setMeta: (key, value) => { meta.set(key, value); } } });
  running.push(messenger);
  // Keep long polling behind startup readiness; capability reads need no intake.
  await messenger.start({ ...handlers, ready: new Promise<void>(() => {}) });
  http.calls.length = 0;
  return { messenger, http };
}

describe("Telegram native topic capability", () => {
  test("forum supergroups require bot administrator can_manage_topics", async () => {
    const f = await telegram();
    expect(await f.messenger.canCreateThread(telegramRoute)).toBe(true);
    expect(f.http.calls.map(call => call.method)).toEqual(["getChat", "getChatMember"]);
    expect(f.http.calls[1]!.args).toMatchObject({ chat_id: "-100", user_id: 900 });
    f.http.canManageTopics = false;
    expect(await f.messenger.canCreateThread(telegramRoute)).toBe(false);
    f.http.canManageTopics = true;
    for (const status of ["member", "restricted", "left", "kicked"]) {
      f.http.memberStatus = status;
      expect(await f.messenger.canCreateThread(telegramRoute)).toBe(false);
    }
    expect(f.http.calls.every(call => ["getChat", "getChatMember"].includes(call.method))).toBe(true);
  });

  test("private topic support reads current getMe without enabling topic mode", async () => {
    const f = await telegram();
    expect(await f.messenger.canCreateThread(telegramDm)).toBe(false);
    f.http.topicsEnabled = true;
    expect(await f.messenger.canCreateThread({ ...telegramDm, topicId: "logical" })).toBe(true);
    expect(f.http.calls.map(call => call.method)).toEqual(["getChat", "getMe", "getChat", "getMe"]);
    expect(await f.messenger.createThread({ ...telegramDm, topicId: "logical" }, "Private topic")).toEqual({ ...telegramDm, threadId: "88" });
    expect(f.http.calls.at(-1)).toEqual({ method: "createForumTopic", args: { chat_id: "42", name: "Private topic" } });
    expect(f.http.calls.some(call => /webhook|enable|set/i.test(call.method))).toBe(false);
  });

  test("nonforum roots cannot create topics; nested and unauthorized routes issue no requests", async () => {
    const f = await telegram();
    f.http.forum = false;
    expect(await f.messenger.canCreateThread(telegramRoute)).toBe(false);
    f.http.chatType = "group";
    expect(await f.messenger.canCreateThread(telegramRoute)).toBe(false);
    expect(f.http.calls.map(call => call.method)).toEqual(["getChat", "getChat"]);
    f.http.calls.length = 0;
    expect(await f.messenger.canCreateThread({ ...telegramRoute, threadId: "7" })).toBe(false);
    for (const destination of [{ ...telegramRoute, guildId: "-200", channelId: "-200" }, { ...telegramDm, channelId: "43" },
      { ...telegramRoute, accountId: "901" }, { ...telegramRoute, authorityId: "43" }]) {
      await expect(f.messenger.canCreateThread(destination)).rejects.toBeInstanceOf(DeliveryError);
    }
    expect(f.http.calls).toEqual([]);
    await expect(f.messenger.createThread(telegramRoute, "Unsupported")).rejects.toThrow("does not support");
    expect(f.http.calls.some(call => call.method === "createForumTopic")).toBe(false);
  });

  test("authenticated API failures and network errors never become false", async () => {
    const f = await telegram();
    for (const method of ["getChat", "getChatMember", "getMe"]) {
      for (const failure of [new Error("network failed"), { error_code: 401, description: "Unauthorized" }]) {
        f.http.failures.set(method, failure);
        await expect(f.messenger.canCreateThread(method === "getMe" ? telegramDm : telegramRoute)).rejects.toBeInstanceOf(DeliveryError);
        f.http.failures.delete(method);
      }
    }
    expect(f.http.calls.some(call => call.method === "createForumTopic")).toBe(false);
  });

  test("forum creation returns actual message_thread_id, never logical topic identity", async () => {
    const f = await telegram();
    expect(await f.messenger.canCreateThread(telegramRoute)).toBe(true);
    expect(await f.messenger.createThread(telegramRoute, "Forum topic", "123")).toEqual({ ...telegramRoute, threadId: "88" });
    expect(f.http.calls.at(-1)).toEqual({ method: "createForumTopic", args: { chat_id: "-100", name: "Forum topic" } });
  });
});

class SlackSocket extends EventEmitter {
  async start() { return { ok: true }; }
  async disconnect() {}
}

class SlackHTTP {
  calls: Array<{ method: string; args: Data; authorization: unknown }> = [];
  channels = new Map<string, Data>([
    ["CALLOWED", { id: "CALLOWED", is_channel: true, is_member: true, is_im: false, context_team_id: "TOWN" }],
    ["DOWNER", { id: "DOWNER", is_im: true, user: "UOWNER", context_team_id: "TOWN" }],
    ["DOTHER", { id: "DOTHER", is_im: true, user: "UOTHER", context_team_id: "TOWN" }],
  ]);
  sources = new Map<string, Data>();
  failure: Error | Data | undefined;
  readonly fetch: NonNullable<WebClientOptions["fetch"]> = async (input, init) => {
    const method = new URL(input).pathname.split("/").at(-1)!;
    const args = Object.fromEntries(new URLSearchParams(typeof init?.body === "string" ? init.body : ""));
    this.calls.push({ method, args, authorization: init?.headers?.Authorization ?? init?.headers?.authorization });
    if (this.failure instanceof Error) throw this.failure;
    if (this.failure) return Response.json({ ok: false, ...this.failure });
    let result: Data;
    if (method === "auth.test") result = { team_id: "TOWN", user_id: "UBOT", bot_id: "BBOT" };
    else if (method === "users.info") result = { user: { id: "UOWNER", team_id: "TOWN", is_bot: false, deleted: false } };
    else if (method === "conversations.info") result = { channel: this.channels.get(args.channel!) };
    else if (method === "conversations.history") result = { messages: [this.sources.get(`${args.channel}:${args.oldest}`)].filter(Boolean) };
    else if (method === "chat.postMessage") result = { channel: args.channel, ts: "2000.000001" };
    else throw new Error(`Unexpected Slack method: ${method}`);
    return Response.json({ ok: true, ...result });
  };
}

async function slack() {
  const http = new SlackHTTP();
  const socket = new SlackSocket();
  const messenger = new SlackMessenger({ botToken: "xoxb-local-only", appToken: "xapp-local-only", ownerId: "UOWNER", teamId: "TOWN", allowedChannelIds: ["CALLOWED"],
    socket: socket as unknown as NonNullable<SlackMessengerOptions["socket"]>, webClientOptions: { fetch: http.fetch } });
  running.push(messenger);
  await messenger.start(handlers);
  http.calls.length = 0;
  return { messenger, http };
}

describe("Slack native topic capability", () => {
  test("authenticated member channel and owner DM roots support thread_ts without posting", async () => {
    const f = await slack();
    expect(await f.messenger.canCreateThread(slackRoute)).toBe(true);
    expect(await f.messenger.canCreateThread({ ...slackDm, topicId: "logical" })).toBe(true);
    expect(f.http.calls.map(call => call.method)).toEqual(["conversations.info", "conversations.info"]);
    expect(f.http.calls.every(call => call.authorization === "Bearer xoxb-local-only")).toBe(true);
  });

  test("existing threads issue no reads and unauthorized roots or foreign DMs reject", async () => {
    const f = await slack();
    expect(await f.messenger.canCreateThread({ ...slackRoute, threadId: "1000.000001" })).toBe(false);
    for (const patch of [{ channelId: "COTHER" }, { guildId: "TOTHER" }, { accountId: "TOWN:UOTHER" }, { authorityId: "UOTHER" }]) {
      await expect(f.messenger.canCreateThread({ ...slackRoute, ...patch })).rejects.toBeInstanceOf(DeliveryError);
    }
    expect(f.http.calls).toEqual([]);
    await expect(f.messenger.canCreateThread({ ...slackDm, channelId: "DOTHER" })).rejects.toBeInstanceOf(DeliveryError);
    for (const patch of [{ is_archived: true }, { is_member: false }, { is_mpim: true }, { context_team_id: "TOTHER" }]) {
      const original = f.http.channels.get("CALLOWED")!;
      f.http.channels.set("CALLOWED", { ...original, ...patch });
      await expect(f.messenger.canCreateThread(slackRoute)).rejects.toBeInstanceOf(DeliveryError);
      f.http.channels.set("CALLOWED", original);
    }
    expect(f.http.calls.some(call => call.method === "chat.postMessage")).toBe(false);
  });

  test("authentication and network errors reject rather than returning unsupported", async () => {
    const f = await slack();
    for (const failure of [new Error("network failed"), { error: "invalid_auth" }]) {
      f.http.failure = failure;
      await expect(f.messenger.canCreateThread(slackRoute)).rejects.toBeInstanceOf(DeliveryError);
    }
  });

  test("reuse requires an actual owner root in the same channel and never copies a source", async () => {
    const f = await slack();
    const source = { type: "message", ts: "1000.000001", user: "UOWNER", team: "TOWN", text: "Owner root" };
    f.http.sources.set("CALLOWED:1000.000001", source);
    expect(await f.messenger.createThread({ ...slackRoute, topicId: "logical" }, "Topic", source.ts)).toEqual({ ...slackRoute, threadId: source.ts });
    for (const patch of [{ user: "UOTHER" }, { thread_ts: "999.000001" }, { user_team: "TOTHER" }, { source_team: "TOTHER" }, { bot_id: "BBOT" }]) {
      f.http.sources.set("CALLOWED:1000.000001", { ...source, ...patch });
      await expect(f.messenger.createThread(slackRoute, "Invalid source", source.ts)).rejects.toBeInstanceOf(DeliveryError);
    }
    await expect(f.messenger.createThread(slackDm, "No source copying", source.ts)).rejects.toBeInstanceOf(DeliveryError);
    expect(f.http.calls.some(call => call.method === "chat.postMessage")).toBe(false);
    expect(await f.messenger.createThread({ ...slackDm, topicId: "logical" }, "New title parent")).toEqual({ ...slackDm, threadId: "2000.000001" });
    const post = f.http.calls.filter(call => call.method === "chat.postMessage");
    expect(post).toHaveLength(1);
    expect(post[0]!.args).toMatchObject({ channel: "DOWNER", text: "New title parent" });
    expect(post[0]!.args.thread_ts).toBeUndefined();
  });
});
