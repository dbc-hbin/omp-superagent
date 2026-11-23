import { createHash } from "node:crypto";
import {
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ChannelFlagsBitField, ChannelType, Client,
  Events, GatewayIntentBits, MessageFlags, ModalBuilder, Partials, PermissionFlagsBits, StringSelectMenuBuilder,
  Routes, TextInputBuilder, TextInputStyle,
  type ChatInputCommandInteraction, type ForumChannel, type Interaction, type MediaChannel, type Message, type MessageCreateOptions, type PartialMessage, type PermissionsBitField,
} from "discord.js";
import { physicalRoute, physicalRouteKey, routeKey, type Approval, type Attachment, type DialogResponse, type DiscordContext, type DiscordPurposeNote, type DiscordPurposeRequest, type Inbound, type MessageActivity, type MessageReference, type Messenger, type OutputRecord, type ReplyContext, type Route, type StorePort, type ThreadInfo, type ThreadUpdate } from "../../../src/contracts.ts";
import { changeDiscordPurpose, discordPurposeNotes, discordPurposeRequest } from "../../../src/discord-context";
import { validateDecisionAnswer, validateDecisionResponse } from "../../../src/decisions";
import { parseDialog, type Dialog } from "../../../src/dialog.ts";
import { approvalCardToken, DeliveryError } from "../../../src/delivery.ts";
import { parseDiscordCommand } from "../../../src/discord-commands.ts";
import { extractDiscordCards, renderDiscordMarkdown, type DiscordEmbed } from "../../../src/discord-markdown.ts";
import { DiscordVoice } from "./discord-voice";
import { VOICE_DRAFT_HEADER } from "./discord-voice-draft";
import type { DiscordVoiceConfig } from "../../../src/config";

// Reference (not copied): gimso2x/ompbot @ 4d2eb28d0bf66644892dc0fc333580d0eb7e7780,
// src/discord/{adapter,attachments,channel,transport}.ts (MIT, ompbot contributors).
// discord.js owns Gateway/REST, including nonce serialization. Nonces are only a
// short-window server dedupe aid, never an exactly-once delivery guarantee.
const NO_MENTIONS = { parse: [] as never[], repliedUser: false };
const FILE_LIMIT = 8 * 1024 * 1024;
const MESSAGE_LIMIT = 2000;
const SELECT_PAGE_SIZE = 25;
const SELECT_TEXT_LIMIT = 100;
type Handlers = Parameters<Messenger["start"]>[0];
type Controls = ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[];
type Answer = NonNullable<DialogResponse["answers"]>[number];
interface Pending {
  approval: Approval; token: string; dialog: Dialog; messageId: string | null;
  active: boolean; busy: boolean; question: number; answers: Answer[];
  selected: string[]; customInput?: string;
}
interface Admission {
  ready: Promise<boolean>;
  resolvedReady: boolean;
  stopped: boolean;
  stop(): void;
}

export interface DiscordMessengerOptions {
  token: string;
  ownerId: string;
  allowedGuildIds: string[];
  allowedChannelIds: string[];
  voice?: DiscordVoiceConfig;
  voiceApiKey?: string;
  /** A supported discord.js Client, primarily for deterministic transport tests. */
  client?: Client;
  /** Attachment HTTP boundary; Discord credentials are never sent to the CDN. */
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  store?: Pick<StorePort, "getMeta" | "setMeta">;
  onError?: (error: unknown) => void;
}

/** Only an explicit client-side or HTTP rejection establishes non-delivery. */
export function deliveryError(error: unknown): DeliveryError {
  if (error instanceof DeliveryError) return error;
  const record = error !== null && typeof error === "object" ? error as Record<string, unknown> : {};
  const status = typeof record.status === "number" ? record.status : undefined;
  const retryAfter = typeof record.retryAfter === "number" ? record.retryAfter : undefined;
  const rejected = record.name === "RateLimitError" || (status !== undefined && status >= 400 && status < 500 && status !== 408);
  return new DeliveryError(error instanceof Error ? error.message : "Discord delivery failed", rejected ? "rejected" : "uncertain", retryAfter, { cause: error });
}

function hash(value: string): string { return createHash("sha256").update(value).digest("hex").slice(0, 24); }
export function discordNonce(id: string, route: Route, part = 0): string { return hash(JSON.stringify([id, routeKey(route), part])); }

export function discordAttachmentAllowed(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && (!url.port || url.port === "443") &&
      !url.hash && (url.hostname === "cdn.discordapp.com" || url.hostname === "media.discordapp.net") &&
      /^\/attachments\/[0-9]+\/[0-9]+\/[^/]+$/.test(url.pathname) && !/%(?:2f|5c)/i.test(url.pathname);
  } catch { return false; }
}

export function parseDiscordControl(value: string): { token: string; action: string } | null {
  const match = /^omp:([a-f0-9]{24}):([a-z]+(?:-[0-9]+)?)$/.exec(value);
  return match?.[0] === value ? { token: match[1]!, action: match[2]! } : null;
}

function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function unsupported(reason: string): never { throw new Error(reason); }
function menuText(value: string): string {
  return value.length <= SELECT_TEXT_LIMIT ? value : `${value.slice(0, SELECT_TEXT_LIMIT - 1).replace(/[\uD800-\uDBFF]$/, "")}…`;
}

/** Keep Discord capacity checks separate from shared native dialog semantics. */
function discordDialog(request: Record<string, unknown>): Dialog {
  if (request.secret === true) return parseDialog(request); // Reject before inspecting any secret content.
  // Reserve room for question labels, controls, and a 4000-character free-text
  // response when a request must be displayed through a text attachment.
  if (Buffer.byteLength(JSON.stringify(request), "utf8") > FILE_LIMIT - 64 * 1024) unsupported("Dialog content exceeds the safe Discord attachment limit; use the local OMP interface.");
  const dialog = parseDialog(request);
  if (dialog.method === "ask") for (const question of dialog.questions) {
    if (question.options.length > SELECT_PAGE_SIZE) unsupported("Ask options exceed Discord limits.");
    for (const option of question.options) {
      if (option.label.length > SELECT_TEXT_LIMIT) unsupported("Ask option cannot fit a Discord select menu.");
      if (option.description && option.description.length > SELECT_TEXT_LIMIT) unsupported("Ask description cannot fit a Discord select menu.");
    }
  }
  if (dialog.method === "input" || dialog.method === "editor") {
    if (dialog.title.length > 45 || dialog.title.length === 0) unsupported("Input title cannot fit a Discord modal.");
    if (dialog.placeholder && dialog.placeholder.length > 100) unsupported("Input placeholder cannot fit a Discord modal.");
    if (dialog.prefill && dialog.prefill.length > 4000) unsupported("Editor content exceeds Discord's 4000-character modal limit.");
  }
  return dialog;
}

export class DiscordMessenger implements Messenger {
  readonly client: Client;
  private readonly guilds: Set<string>;
  private readonly channels: Set<string>;
  private handlers: Handlers | null = null;
  private connected = false;
  private admission: Admission | null = null;
  private intake: Promise<void> = Promise.resolve();
  private readonly pending = new Map<string, Pending>();
  private readonly report: (error: unknown) => void;
  private readonly voice?: DiscordVoice;
  private voiceConnected = false;
  private voiceEpoch = 0;
  private readonly onVoiceDisconnect = () => {
    this.voiceConnected = false;
    this.voiceEpoch++;
    this.voice?.close();
  };
  private readonly onMessage = (message: Message) => {
    // Revocation and work-mode starts must use the call state at event receipt,
    // not after stalled intake. The owner command fences older queued starts.
    if (this.voice && this.voiceConnected && this.admission?.resolvedReady && !this.admission.stopped &&
      !message.partial && DiscordVoice.isPriorityControl(message.content) && message.channelId === this.options.voice?.textChannelId &&
      this.route(message.channel)?.guildId) {
      this.voice.command(message);
      return;
    }
    this.enqueue(message, true);
  };
  private readonly onEdit = (_old: Message | PartialMessage, message: Message | PartialMessage) => { this.enqueue(message, false); };
  private readonly onInteraction = (interaction: Interaction) => { void this.interact(interaction).catch(this.report); };
  private readonly onReconnect = () => {
    if (!this.connected) return;
    this.voiceConnected = true;
    const admission = this.admission;
    this.intake = this.intake.then(async () => {
      if (await this.admitted(admission)) await this.handlers?.reconnect?.();
    }).catch(this.report);
  };

  constructor(private readonly options: DiscordMessengerOptions) {
    this.guilds = new Set(options.allowedGuildIds);
    this.channels = new Set(options.allowedChannelIds);
    this.report = options.onError ?? (error => console.error("Discord event failed:", error));
    if (options.voice) this.voice = new DiscordVoice(options.voice, options.ownerId,
      options.voiceApiKey !== options.token ? options.voiceApiKey : undefined, this.report);
    this.client = options.client ?? new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent,
        ...(options.voice ? [GatewayIntentBits.GuildVoiceStates] : [])],
      partials: [Partials.Channel, Partials.Message],
      allowedMentions: NO_MENTIONS,
      rest: { retries: 0, rejectOnRateLimit: () => true },
    });
    // Disable discord.js's default retries even on an injected supported Client.
    this.client.rest.options.retries = 0;
    this.client.rest.options.rejectOnRateLimit = () => true;
  }

  async start(handlers: Handlers): Promise<void> {
    if (this.handlers) throw new Error("Discord messenger is already started");
    this.handlers = handlers;
    const stopped = Promise.withResolvers<boolean>();
    this.admission = {
      ready: Promise.race([
        (handlers.ready ?? Promise.resolve()).then(() => true, () => {
          this.report(new Error("Discord startup readiness failed; intake remains disabled"));
          return false;
        }),
        stopped.promise,
      ]),
      resolvedReady: handlers.ready === undefined,
      stopped: false,
      stop: () => { stopped.resolve(false); },
    };
    const admission = this.admission;
    void admission.ready.then(ready => { admission.resolvedReady = ready; });
    this.client.on(Events.MessageCreate, this.onMessage);
    this.client.on(Events.MessageUpdate, this.onEdit);
    this.client.on(Events.InteractionCreate, this.onInteraction);
    this.client.on(Events.ShardResume, this.onReconnect);
    this.client.on(Events.ShardDisconnect, this.onVoiceDisconnect);
    this.client.on(Events.ShardReconnecting, this.onVoiceDisconnect);
    this.client.on(Events.ShardReady, this.onReconnect);
    this.client.on(Events.Error, this.report);
    try {
      if (!this.client.isReady()) {
        const { promise, resolve } = Promise.withResolvers<void>();
        const ready = () => { resolve(); };
        this.client.once(Events.ClientReady, ready);
        try { await this.client.login(this.options.token); await promise; }
        finally { this.client.off(Events.ClientReady, ready); }
      }
      this.connected = true;
      this.voiceConnected = true;
    } catch (error) { await this.stop(); throw error; }
  }

  private async admitted(admission = this.admission): Promise<boolean> {
    return !!admission && await admission.ready && !admission.stopped && this.admission === admission;
  }

  private route(channel: { id: string; isThread(): boolean; parentId?: string | null; guildId?: string | null }): Route | null {
    const accountId = this.client.user?.id;
    if (!accountId) return null;
    const guildId = channel.guildId ?? null;
    const threadId = channel.isThread() ? channel.id : null;
    const channelId = threadId ? channel.parentId : channel.id;
    if (!channelId || (guildId && (!this.guilds.has(guildId) || !this.channels.has(channelId)))) return null;
    return { platform: "discord", accountId, authorityId: this.options.ownerId, guildId, channelId, threadId };
  }

  private enqueue(message: Message | PartialMessage, fresh: boolean): void {
    const admission = this.admission;
    const voiceEpoch = this.voiceConnected && admission?.resolvedReady ? this.voiceEpoch : null;
    this.intake = this.intake.then(async () => {
      if (!await this.admitted(admission)) return;
      // Check destination and known author before even fetching a partial message.
      if (!this.route(message.channel) || (message.author && (message.author.bot || message.author.id !== this.options.ownerId))) return;
      if (!message.guildId && "recipientId" in message.channel && message.channel.recipientId !== this.options.ownerId) return;
      const full = message.partial ? await message.fetch() : message;
      const inbound = this.normalize(full, "pointer");
      if (inbound) {
        if (this.isVoiceControl(inbound)) {
          if (!fresh || message.partial || voiceEpoch !== this.voiceEpoch || !this.voiceConnected) return;
          const work = this.voice?.command(full);
          if (work) await this.handlers?.message({ ...inbound, text: work, attachments: [], reply: undefined });
          return;
        }
        await this.resolveReply(full, inbound);
        await this.handlers?.message(inbound);
      }
    }).catch(this.report);
  }

  /** Use only a reply pointer when the caller will resolve cache and API together. */
  normalize(message: Message, replyContext: "cached" | "pointer" = "cached"): Inbound | null {
    if (message.author.bot || message.author.id !== this.options.ownerId || message.webhookId) return null;
    const route = this.route(message.channel);
    if (!route || (message.type !== 0 && message.type !== 19)) return null;
    if (!route.guildId && (message.channel.type !== ChannelType.DM || message.channel.recipientId !== this.options.ownerId)) return null;
    const attachments = [...message.attachments.values()].filter(file => discordAttachmentAllowed(file.url) &&
      typeof file.size === "number" && Number.isSafeInteger(file.size) && file.size >= 0).map(file => ({
      id: file.id, name: file.name, url: file.url, size: file.size,
      ...(file.contentType ? { contentType: file.contentType } : {}),
      ...(message.flags?.has(MessageFlags.IsVoiceMessage) ? { voice: true as const } : {}),
      ...(typeof file.duration === "number" && Number.isFinite(file.duration) && file.duration >= 0 ? { durationSeconds: file.duration } : {}),
    }));
    // Stickers, whitespace, and filtered attachments are not instructions. This
    // also ignores contentless edits instead of replacing an admitted intent.
    if (!message.content.trim() && attachments.length === 0) return null;
    const reply = this.replyPointer(message);
    if (reply && replyContext === "cached") this.snapshotReply(message, message.channel.messages.cache?.get(reply.messageId), reply);
    // CDN URLs carry expiring signatures; refreshing one must not create a new
    // input revision for an unchanged Discord edit.
    // Reply/voice snapshots are context, not a new edit or download identity.
    let revision = "original";
    if (message.editedTimestamp !== null) {
      const attachmentIdentity = attachments.map(file => [file.id, file.name, file.size, file.contentType])
        .sort((left, right) => String(left[0]).localeCompare(String(right[0])));
      revision = `edit:${message.editedTimestamp}:${hash(JSON.stringify([message.content, attachmentIdentity]))}`;
    }
    return {
      id: `discord:${route.accountId}:${message.id}:${revision}`, route, messageId: message.id,
      text: message.content, receivedAt: message.editedTimestamp ?? message.createdTimestamp, attachments,
      ...(reply ? { reply } : {}),
      discordContext: this.context(route, message.channel),
    };
  }

  private isVoiceControl(input: Inbound): boolean {
    return input.route.guildId !== null && input.route.threadId === null &&
      input.route.channelId === this.options.voice?.textChannelId && DiscordVoice.isControl(input.text);
  }

  /** Cached objects only: optional metadata must never delay or discard intake. */
  private context(route: Route, channel?: unknown): DiscordContext {
    const context: DiscordContext = {
      kind: route.guildId ? "guild" : "dm", channel: { id: route.channelId },
      ...(route.threadId ? { thread: { id: route.threadId, parentId: route.channelId } } : {}),
    };
    let observed = context;
    try {
      if (object(channel) && channel.id === (route.threadId ?? route.channelId)) {
        const parent = route.threadId ? channel.parent : channel;
        const metadata = object(parent) && parent.id === route.channelId &&
          (parent.guildId ?? null) === route.guildId ? parent : undefined;
        observed = {
          ...context,
          channel: { ...context.channel,
            ...(metadata && typeof metadata.name === "string" ? { name: metadata.name } : {}),
            ...(metadata && (metadata.topic === null || typeof metadata.topic === "string") ? { topic: metadata.topic } : {}),
          },
          ...(context.thread ? { thread: { ...context.thread,
            ...(typeof channel.name === "string" ? { name: channel.name } : {}),
          } } : {}),
        };
      }
    } catch {
      this.report(new Error("Discord channel metadata unavailable; owner intake preserved"));
    }
    try {
      const notes = this.options.store ? discordPurposeNotes(this.options.store, route) : [];
      const parent = notes.find(note => note.route.threadId === null);
      const thread = notes.find(note => note.route.threadId === route.threadId && route.threadId !== null);
      return { ...observed, channel: { ...observed.channel, ...(parent ? { purpose: parent.purpose } : {}) },
        ...(observed.thread ? { thread: { ...observed.thread, ...(thread ? { purpose: thread.purpose } : {}) } } : {}) };
    } catch {
      this.report(new Error("Discord purpose metadata unavailable; owner intake preserved"));
      return observed;
    }
  }

  async inspectDiscordContext(route: Route): Promise<DiscordContext> {
    this.assertRoute(route);
    try { return this.context(route, await this.channel(route)); }
    catch (error) {
      if (error instanceof DeliveryError && error.certainty === "rejected") throw error;
      this.report(new Error("Discord channel inspection unavailable"));
      return this.context(route);
    }
  }

  async discordPurpose(input: DiscordPurposeRequest): Promise<readonly DiscordPurposeNote[]> {
    const request = discordPurposeRequest(input);
    this.assertRoute(request.route);
    if (!this.options.store) throw new DeliveryError("Discord purpose storage is unavailable", "rejected");
    // A DM route needs live recipient verification; guild routes use the configured exact allowlist.
    if (!request.route.guildId) await this.channel(request.route);
    return changeDiscordPurpose(this.options.store, request);
  }

  private replyPointer(message: Message): ReplyContext | undefined {
    const reference = message.reference;
    // discord.js caches embedded referenced_message in this channel's manager.
    // Never use fetchReference(): it follows the reference's channel selector.
    if (message.type !== 19 || !reference?.messageId || !/^[0-9]{1,20}$/.test(reference.messageId) ||
      reference.channelId !== message.channelId || (reference.guildId !== undefined && reference.guildId !== message.guildId)) return;
    return { messageId: reference.messageId, authorId: null, text: null };
  }

  private snapshotReply(message: Message, referenced: Message | undefined, reply: ReplyContext): boolean {
    if (!referenced || referenced.partial || referenced.id !== reply.messageId ||
      referenced.channelId !== message.channelId || referenced.guildId !== message.guildId) return false;
    reply.authorId = referenced.author?.id ?? null;
    reply.text = typeof referenced.content === "string" &&
      !(referenced.author?.id === this.client.user?.id && referenced.content.startsWith(VOICE_DRAFT_HEADER))
      ? referenced.content : null;
    return true;
  }

  private async resolveReply(message: Message, input: Inbound): Promise<void> {
    if (!input.reply || this.snapshotReply(message, message.channel.messages.cache?.get(input.reply.messageId), input.reply)) return;
    try {
      const referenced = await message.channel.messages.fetch({ message: input.reply.messageId, cache: false });
      this.snapshotReply(message, referenced, input.reply);
    } catch {
      // Missing/deleted/inaccessible originals retain only their same-channel
      // pointer; failure to obtain context must not lose the owner's message.
    }
  }

  assertRoute(route: Route): void {
    if (route.platform !== "discord" || route.accountId !== this.client.user?.id || route.authorityId !== this.options.ownerId ||
      !route.channelId || (!route.guildId && route.threadId !== null) ||
      (route.guildId && (!this.guilds.has(route.guildId) || !this.channels.has(route.channelId)))) {
      throw new DeliveryError("Discord route is not authorized for this bot and owner", "rejected");
    }
  }

  private async channel(route: Route, force = false) {
    this.assertRoute(route);
    const channel = await this.client.channels.fetch(route.threadId ?? route.channelId, { force });
    if (!channel) throw new DeliveryError("Discord destination cannot receive messages", "rejected");
    const actual = this.route(channel);
    if (!actual || physicalRouteKey(actual) !== physicalRouteKey(route)) throw new DeliveryError("Discord destination identity changed", "rejected");
    if (!route.guildId && (channel.type !== ChannelType.DM || channel.recipientId !== this.options.ownerId)) throw new DeliveryError("Discord DM does not belong to the owner", "rejected");
    return channel;
  }

  private async destination(route: Route) {
    const channel = await this.channel(route);
    if (!channel.isSendable()) throw new DeliveryError("Discord destination cannot receive messages", "rejected");
    return channel;
  }

  async openAttachment(route: Route, attachment: Attachment, signal: AbortSignal): Promise<Response> {
    this.assertRoute(route);
    if (typeof attachment.size !== "number" || !Number.isSafeInteger(attachment.size) || attachment.size < 0 ||
      !discordAttachmentAllowed(attachment.url)) throw new DeliveryError("Attachment is not an authorized Discord CDN attachment", "rejected");
    const url = new URL(attachment.url);
    const [, , channelId, attachmentId] = url.pathname.split("/");
    if (channelId !== (route.threadId ?? route.channelId) || attachmentId !== attachment.id) {
      throw new DeliveryError("Discord attachment does not belong to this destination and resource", "rejected");
    }
    await this.destination(route);
    try {
      // The CDN uses its signed resource URL, never the bot's API credential.
      return await (this.options.fetch ?? fetch)(url, { redirect: "error", credentials: "omit", signal });
    } catch {
      throw new DeliveryError("Discord attachment download failed", "rejected");
    }
  }

  private payload(text: string, nonce: string, components?: Controls): MessageCreateOptions & { embeds: DiscordEmbed[] } {
    // Discord renders no markdown tables, so outbound tables become aligned fences,
    // and valid ```card specs become embeds.
    // The stored OutputRecord text is never modified; only this payload changes.
    const cards = extractDiscordCards(text);
    const content = renderDiscordMarkdown(cards.text, FILE_LIMIT);
    if (Buffer.byteLength(content, "utf8") > FILE_LIMIT) throw new DeliveryError("Discord text attachment exceeds the safe 8 MiB upload limit", "rejected");
    return {
      ...(content.length <= MESSAGE_LIMIT ? { content: content || (cards.embeds.length ? "" : "(empty output)") } : {
        content: "Full text is attached (exceeds Discord's message limit).",
        files: [new AttachmentBuilder(Buffer.from(content, "utf8"), { name: `omp-${nonce}.txt` })],
      }),
      embeds: cards.embeds,
      allowedMentions: NO_MENTIONS, nonce, enforceNonce: true, ...(components ? { components } : {}),
    };
  }

  async send(output: OutputRecord): Promise<string> {
    try {
      if (output.editOf !== undefined) {
        // A status update replaces its message; a rejected edit is never reposted.
        if (!object(output.editOf) || typeof output.editOf.messageId !== "string" || !/^[0-9]{1,20}$/.test(output.editOf.messageId)
          || !object(output.editOf.route) || physicalRouteKey(output.editOf.route) !== physicalRouteKey(output.route)) {
          throw new DeliveryError("Discord status edit requires a plain message in the exact destination conversation", "rejected");
        }
        const channel = await this.destination(output.route);
        const payload = this.payload(output.text, discordNonce(output.id, output.route));
        const message = await channel.messages.edit(output.editOf.messageId, {
          content: payload.content ?? "", embeds: payload.embeds, files: payload.files ?? [], attachments: [], allowedMentions: NO_MENTIONS,
        });
        if (message.id !== output.editOf.messageId) throw new DeliveryError("Discord status edit receipt could not be verified", "uncertain");
        return message.id;
      }
      if (output.replyTo !== undefined && (!object(output.replyTo) || !object(output.replyTo.route)
        || typeof output.replyTo.messageId !== "string" || !/^[0-9]{1,20}$/.test(output.replyTo.messageId)
        || physicalRouteKey(output.replyTo.route) !== physicalRouteKey(output.route))) {
        throw new DeliveryError("Discord reply requires a real message in the exact destination conversation", "rejected");
      }
      const channel = await this.destination(output.route);
      const message = await channel.send({
        ...this.payload(output.text, discordNonce(output.id, output.route)),
        // Discord may omit a deleted reference in this same send. Never retry
        // without a reference: an ambiguous first attempt may already exist.
        ...(output.replyTo ? { reply: { messageReference: output.replyTo.messageId, failIfNotExists: false } } : {}),
      });
      return message.id;
    } catch (error) { throw deliveryError(error); }
  }

  async setActivity(message: MessageReference, activity: MessageActivity): Promise<void> {
    try {
      if (!/^[0-9]{1,20}$/.test(message.messageId)) throw new DeliveryError("Activity requires a Discord message snowflake", "rejected");
      const channel = await this.destination(message.route);
      const emoji = activity === "received" ? "\u{1F440}" : "\u{1F4AD}";
      const reaction = Routes.channelMessageOwnReaction(channel.id, message.messageId, encodeURIComponent(emoji));
      if (activity === "idle") await this.client.rest.delete(reaction);
      else await this.client.rest.put(reaction);
    } catch (error) {
      const failure = deliveryError(error);
      throw new DeliveryError("Discord activity update failed", failure.certainty, failure.retryAfterMs);
    }
  }

  private control(pending: Pending, action: string): string { return `omp:${pending.token}:${action}`; }
  private button(pending: Pending, action: string, label: string, style = ButtonStyle.Secondary): ButtonBuilder {
    return new ButtonBuilder().setCustomId(this.control(pending, action)).setLabel(label).setStyle(style);
  }
  private view(pending: Pending, selectPage?: number): { content: string; components: Controls } {
    const dialog = pending.dialog;
    const cancel = this.button(pending, "cancel", "Cancel");
    if (dialog.method === "confirm") return {
      content: `${dialog.title}\n\n${dialog.message}`,
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(this.button(pending, "yes", "Confirm", ButtonStyle.Danger), this.button(pending, "no", "Decline"), cancel)],
    };
    if (dialog.method === "input" || dialog.method === "editor") return {
      content: `${dialog.title}\nOpen the editor to respond. Discord inputs are not secret; maximum 4000 characters.`,
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(this.button(pending, "open", "Respond", ButtonStyle.Primary), cancel)],
    };
    if (dialog.method === "select") {
      const page = selectPage ?? Math.floor((dialog.initialIndex ?? 0) / SELECT_PAGE_SIZE);
      const first = page * SELECT_PAGE_SIZE;
      const labels = dialog.options.slice(first, first + SELECT_PAGE_SIZE);
      const pages = Math.ceil(dialog.options.length / SELECT_PAGE_SIZE);
      const numbered = pages > 1 || labels.some((label, offset) => label.length > SELECT_TEXT_LIMIT
        || (dialog.details[first + offset]?.length ?? 0) > SELECT_TEXT_LIMIT);
      const marker = (index: number) => index >= dialog.markableCount || !dialog.marker ? "" : dialog.marker === "checkbox" ? (dialog.checked.includes(index) ? "☑️" : "⬜") : "⚪";
      const rows = labels.map((label, offset) => {
        const index = first + offset;
        const detail = dialog.details[index];
        const emoji = marker(index);
        const name = numbered ? `#${index + 1}: ${label}` : label;
        return {
          text: `${emoji ? `${emoji} ` : ""}${name}${index === dialog.initialIndex ? " (initial focus)" : ""}${numbered && detail ? `\n${detail}` : ""}`,
          option: { label: menuText(name), value: String(index), ...(emoji ? { emoji: { name: emoji } } : {}),
            ...(detail ? { description: menuText(detail) } : {}) },
        };
      });
      const state = numbered || dialog.marker ? `\n${rows.map(row => row.text).join("\n")}` : "";
      const navigation = new ActionRowBuilder<ButtonBuilder>();
      if (page > 0) navigation.addComponents(this.button(pending, `page-${page - 1}`, "Previous"));
      if (page + 1 < pages) navigation.addComponents(this.button(pending, `page-${page + 1}`, "Next"));
      navigation.addComponents(cancel);
      return {
        content: dialog.title + (pages > 1 ? `\nPage ${page + 1}/${pages}` : "") + state
          + (dialog.marker ? "\nChoose one row per response; OMP supplies the checked state on each request." : ""),
        components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder()
          .setCustomId(this.control(pending, page === 0 ? "select" : `select-${page}`))
          .setMinValues(1).setMaxValues(1).addOptions(rows.map(row => row.option))), navigation],
      };
    }
    const question = dialog.questions[pending.question]!;
    const components: Controls = [];
    if (question.options.length) components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder().setCustomId(this.control(pending, `choose-${pending.question}`)).setMinValues(0).setMaxValues(question.multi ? question.options.length : 1)
        .addOptions(question.options.map((option, index) => ({ label: option.label, value: String(index), default: pending.selected.includes(option.label), ...(option.description ? { description: option.description } : {}) }))),
    ));
    components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      this.button(pending, `other-${pending.question}`, "Other / free text"),
      this.button(pending, `next-${pending.question}`, pending.question + 1 === dialog.questions.length ? "Submit all answers" : "Next question", ButtonStyle.Primary), cancel,
    ));
    const previews = question.options.map((option, index) => `${index + 1}. ${option.label}${index === question.recommended ? " (recommended, not preselected)" : ""}${option.preview ? `\n${option.preview}` : ""}`).join("\n");
    const context = pending.approval.ownerContext;
    return { content: [`Question ${pending.question + 1}/${dialog.questions.length}${question.header ? ` — ${question.header}` : ""}`,
      question.question, context ? `Why your decision is needed: ${context}` : "",
      question.multi ? "Multiple answers allowed." : "Choose one option OR free text.",
      previews, pending.customInput ? "Free text entered." : ""].filter(Boolean).join("\n"), components };
  }

  async showApproval(approval: Approval): Promise<string> {
    this.assertRoute(approval.route);
    if (!this.handlers) throw new DeliveryError("Discord messenger is not started", "rejected");
    if (approval.state !== "pending") throw new DeliveryError("Discord approval is no longer pending", "rejected");
    const token = approvalCardToken(approval);
    const existing = this.pending.get(token);
    if (existing?.active && existing.messageId) {
      if (approval.remoteId && approval.remoteId !== existing.messageId) throw new DeliveryError("Discord approval receipt does not match its active control", "rejected");
      return existing.messageId;
    }
    for (const pending of this.pending.values()) if (pending.approval.id === approval.id) await this.dismissApproval(pending.approval);
    let dialog: Dialog;
    try { dialog = discordDialog(approval.request); }
    catch (error) {
      const channel = await this.destination(approval.route);
      const notice = `Request cancelled: ${error instanceof Error ? error.message : "Unsupported dialog."}`;
      let message: Message;
      try {
        const payload = this.payload(notice, discordNonce(`approval-cancel:${token}`, approval.route));
        if (approval.remoteId) {
          message = await channel.messages.fetch(approval.remoteId);
          this.assertApprovalMessage(message, approval, token);
          await message.edit({ content: payload.content, files: payload.files, attachments: [], components: [], allowedMentions: NO_MENTIONS });
        } else message = await channel.send(payload);
      }
      catch (failure) { throw deliveryError(failure); }
      await this.handlers.answer(approval.id, { cancelled: true }, approval.route);
      return message.id;
    }
    const pending: Pending = { approval: { ...approval, route: { ...approval.route } }, token, dialog, messageId: approval.remoteId, active: false, busy: false, question: 0, answers: [], selected: [] };
    const view = this.view(pending);
    this.pending.set(token, pending);
    try {
      const channel = await this.destination(approval.route);
      const payload = this.payload(view.content, discordNonce(`approval:${token}`, approval.route), view.components);
      let message: Message;
      if (approval.remoteId) {
        message = await channel.messages.fetch(approval.remoteId);
        this.assertApprovalMessage(message, approval, token);
        await message.edit({ content: payload.content, files: payload.files, attachments: [], components: view.components, allowedMentions: NO_MENTIONS });
      } else message = await channel.send(payload);
      pending.messageId = message.id;
      pending.active = true;
      return message.id;
    } catch (error) { pending.active = false; this.pending.delete(token); throw deliveryError(error); }
  }

  private assertApprovalMessage(message: Message, approval: Approval, token: string): void {
    const source: Route = {
      ...physicalRoute(approval.route), accountId: message.author.id, guildId: message.guildId,
      channelId: approval.route.threadId ? approval.route.channelId : message.channelId,
      threadId: approval.route.threadId ? message.channelId : null,
    };
    if ((approval.remoteId && message.id !== approval.remoteId) || message.author.id !== this.client.user?.id || physicalRouteKey(source) !== physicalRouteKey(approval.route)) {
      throw new DeliveryError("Discord approval message does not belong to this bot and destination", "rejected");
    }
    for (const row of message.components) {
      if (!("components" in row)) continue;
      for (const component of row.components) {
        if ("customId" in component && component.customId && parseDiscordControl(component.customId)?.token !== token) {
          throw new DeliveryError("Discord message belongs to a different approval identity", "rejected");
        }
      }
    }
  }

  private async refresh(pending: Pending, selectPage?: number): Promise<void> {
    if (!pending.messageId || !pending.active) return;
    const channel = await this.destination(pending.approval.route);
    const message = await channel.messages.fetch(pending.messageId);
    this.assertApprovalMessage(message, pending.approval, pending.token);
    const view = this.view(pending, selectPage);
    const payload = this.payload(view.content, discordNonce(`approval:${pending.token}`, pending.approval.route), view.components);
    await message.edit({ content: payload.content, files: payload.files, attachments: [], components: view.components, allowedMentions: NO_MENTIONS });
  }

  async dismissApproval(approval: Approval): Promise<void> {
    this.assertRoute(approval.route);
    const matches = [...this.pending.values()].filter(pending => pending.approval.id === approval.id && pending.approval.generation === approval.generation && routeKey(pending.approval.route) === routeKey(approval.route));
    for (const pending of matches) pending.active = false;
    const messageIds = new Set([approval.remoteId, ...matches.map(pending => pending.messageId)].filter((id): id is string => !!id));
    const token = approvalCardToken(approval);
    try {
      const channel = await this.destination(approval.route);
      for (const id of messageIds) {
        try {
          const message = await channel.messages.fetch(id);
          this.assertApprovalMessage(message, approval, token);
          await message.edit({ components: [], allowedMentions: NO_MENTIONS });
        }
        catch (error) {
          if (object(error) && (error.code === 10008 || error.code === 10003)) continue; // Already deleted.
          throw error;
        }
      }
      for (const pending of matches) this.pending.delete(pending.token);
    } catch (error) { throw deliveryError(error); }
  }

  private modal(pending: Pending, action: string): ModalBuilder {
    const dialog = pending.dialog;
    const ask = dialog.method === "ask";
    const title = ask ? "Other answer" : (dialog as Extract<Dialog, { method: "input" | "editor" }>).title;
    const input = new TextInputBuilder().setCustomId("value").setLabel(ask ? "Your answer (not secret)" : "Response (not secret)").setRequired(false).setMaxLength(4000)
      .setStyle(dialog.method === "input" ? TextInputStyle.Short : TextInputStyle.Paragraph);
    if (dialog.method === "input" && dialog.placeholder) input.setPlaceholder(dialog.placeholder);
    const prefill = ask ? pending.customInput : dialog.method === "editor" ? dialog.prefill : undefined;
    if (prefill) input.setValue(prefill);
    return new ModalBuilder().setCustomId(this.control(pending, action)).setTitle(title).addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
  }

  private async finish(pending: Pending, response: DialogResponse, interaction: { deferUpdate(): Promise<unknown> }): Promise<void> {
    validateDecisionResponse(pending.approval, response);
    // The handler's receipt is the durable admission boundary. Until it resolves,
    // leave the original control and draft actionable, without acknowledging it.
    await this.handlers!.answer(pending.approval.id, response, pending.approval.route);
    // Admission succeeded: ACK/cleanup failures must never resubmit the answer.
    pending.active = false;
    try { await interaction.deferUpdate(); }
    finally { await this.dismissApproval(pending.approval); }
  }

  private async commandReply(interaction: ChatInputCommandInteraction, content: string): Promise<void> {
    try { await interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: NO_MENTIONS }); }
    catch {
      // SDK errors can contain the interaction response URL and its secret token.
      // A failed/expired ACK never replays admission or falls back to a followup.
      this.report(new Error("Discord command acknowledgement failed; admission was not retried"));
    }
  }

  private async command(interaction: ChatInputCommandInteraction): Promise<void> {
    const handlers = this.handlers;
    const admission = this.admission;
    const deny = (content: string) => this.commandReply(interaction, content);
    if (!this.client.application?.id || interaction.applicationId !== this.client.application.id || !this.client.user?.id) {
      await deny("This command does not belong to the connected Superagent application."); return;
    }
    if (interaction.user.bot || interaction.user.id !== this.options.ownerId) {
      await deny("Only the configured owner can use Superagent commands."); return;
    }
    const text = parseDiscordCommand(interaction.commandName, interaction.options.data);
    if (text === null) {
      await deny("This Superagent command or its options are unsupported or stale; nothing was admitted."); return;
    }
    // Commands have a three-second initial response deadline. Unlike ordinary
    // messages/components, never wait for readiness or the serialized intake.
    if (!this.connected || !handlers || !admission?.resolvedReady || admission.stopped) {
      await deny("Superagent is not ready to accept commands; nothing was admitted."); return;
    }
    if (!/^[0-9]{1,20}$/.test(interaction.id) || !Number.isFinite(interaction.createdTimestamp) || !interaction.channelId ||
      (interaction.guildId !== null && !this.guilds.has(interaction.guildId))) {
      await deny("This conversation is not authorized for Superagent commands."); return;
    }
    let route: Route | null;
    let discordContext: DiscordContext | undefined;
    try {
      // This resolves a channel, never a command's interaction ID as a message.
      const channel = interaction.channel ?? await this.client.channels.fetch(interaction.channelId);
      route = channel ? this.route(channel) : null;
      if (!channel || channel.id !== interaction.channelId || !route || route.guildId !== interaction.guildId ||
        !channel.isSendable() || (!route.guildId && (channel.type !== ChannelType.DM || channel.recipientId !== this.options.ownerId))) {
        await deny("This conversation is not authorized for Superagent commands."); return;
      }
      discordContext = this.context(route, channel);
    } catch {
      this.report(new Error("Discord command destination verification failed; nothing was admitted"));
      await deny("Superagent could not verify this conversation; nothing was admitted."); return;
    }
    if (!this.connected || this.handlers !== handlers || this.admission !== admission || admission.stopped || !admission.resolvedReady) {
      await deny("Superagent is not ready to accept commands; nothing was admitted."); return;
    }
    try {
      // The captured handler resolves only after durable admission. Do not
      // defer an apparent success before this boundary or persist response tokens.
      await handlers.message({
        id: `discord:${route.accountId}:interaction:${interaction.id}`, route, messageId: null,
        interactionId: interaction.id, text, receivedAt: interaction.createdTimestamp, attachments: [],
        ...(discordContext ? { discordContext } : {}),
      });
    } catch {
      this.report(new Error("Discord command durable admission could not be confirmed; admission was not retried"));
      await deny("Superagent could not confirm acceptance. This command may already have been recorded; no automatic retry was made. Check this conversation and service status before taking further action.");
      return;
    }
    await this.commandReply(interaction, "Superagent accepted this command. Its result will be sent to this conversation.");
  }

  private async interact(interaction: Interaction): Promise<void> {
    if (interaction.isChatInputCommand()) { await this.command(interaction); return; }
    if (!interaction.isButton() && !interaction.isStringSelectMenu() && !interaction.isModalSubmit()) return;
    const parsed = parseDiscordControl(interaction.customId);
    if (!parsed) return;
    if (!await this.admitted()) return;
    const pending = this.pending.get(parsed.token);
    const deny = async (content: string) => { await interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: NO_MENTIONS }); };
    if (interaction.user.id !== this.options.ownerId) { await deny("Only the configured owner can answer this request."); return; }
    if (!pending?.active || pending.busy || !this.handlers) { await deny("This request is expired or already being handled."); return; }
    const route = pending.approval.route;
    const message = interaction.isModalSubmit() ? (interaction.isFromMessage() ? interaction.message : null) : interaction.message;
    const source: Route = {
      ...physicalRoute(route), accountId: message?.author.id ?? "", authorityId: interaction.user.id, guildId: interaction.guildId,
      channelId: route.threadId ? route.channelId : interaction.channelId ?? "",
      threadId: route.threadId ? interaction.channelId : null,
    };
    if (!message || message.id !== pending.messageId || physicalRouteKey(source) !== physicalRouteKey(route) ||
      message.channelId !== (route.threadId ?? route.channelId) || message.guildId !== route.guildId) {
      await deny("This control does not belong to this destination or request."); return;
    }
    this.assertRoute(route);
    const action = parsed.action;
    const dialog = pending.dialog;
    if (interaction.isButton() && action === "open" && (dialog.method === "input" || dialog.method === "editor")) {
      await interaction.showModal(this.modal(pending, "value")); return;
    }
    if (interaction.isButton() && dialog.method === "ask" && action === `other-${pending.question}`) {
      await interaction.showModal(this.modal(pending, `custom-${pending.question}`)); return;
    }
    pending.busy = true;
    try {
      if (interaction.isButton() && action === "cancel") { await this.finish(pending, { cancelled: true }, interaction); return; }
      if (dialog.method === "confirm" && interaction.isButton() && (action === "yes" || action === "no")) {
        await this.finish(pending, { confirmed: action === "yes" }, interaction); return;
      }
      if (dialog.method === "select" && interaction.isButton() && action.startsWith("page-")) {
        const page = Number(action.slice("page-".length));
        if (page * SELECT_PAGE_SIZE >= dialog.options.length) throw new Error("Invalid Discord select page");
        // Navigation only edits this card. It never admits or resolves a native answer.
        await interaction.deferUpdate();
        await this.refresh(pending, page);
        return;
      }
      if (dialog.method === "select" && interaction.isStringSelectMenu() && (action === "select" || action.startsWith("select-"))) {
        const first = action === "select" ? 0 : Number(action.slice("select-".length)) * SELECT_PAGE_SIZE;
        const index = interaction.values[0];
        const position = Number(index);
        const label = dialog.options[position];
        if (interaction.values.length !== 1 || !index || !/^(0|[1-9][0-9]*)$/.test(index)
          || position < first || position >= first + SELECT_PAGE_SIZE || label === undefined) throw new Error("Invalid Discord select value");
        await this.finish(pending, { value: label }, interaction); return;
      }
      if ((dialog.method === "input" || dialog.method === "editor") && interaction.isModalSubmit() && action === "value") {
        await this.finish(pending, { value: interaction.fields.getTextInputValue("value") }, interaction); return;
      }
      if (dialog.method === "ask") {
        const question = dialog.questions[pending.question]!;
        if (interaction.isStringSelectMenu() && action === `choose-${pending.question}`) {
          if ((!question.multi && interaction.values.length > 1) || new Set(interaction.values).size !== interaction.values.length || interaction.values.some(value => !/^(0|[1-9][0-9]*)$/.test(value) || !question.options[Number(value)])) throw new Error("Invalid Discord ask selection");
          await interaction.deferUpdate(); // Partial draft progress, not a final answer.
          pending.selected = interaction.values.map(value => question.options[Number(value)]!.label);
          if (!question.multi && pending.selected.length) pending.customInput = undefined;
        } else if (interaction.isModalSubmit() && action === `custom-${pending.question}`) {
          await interaction.deferUpdate();
          pending.customInput = interaction.fields.getTextInputValue("value").trim() || undefined;
          if (!question.multi && pending.customInput) pending.selected = [];
        } else if (interaction.isButton() && action === `next-${pending.question}`) {
          const answer: Answer = { id: question.id, selectedOptions: [...pending.selected], ...(pending.customInput ? { customInput: pending.customInput } : {}) };
          if (pending.approval.decision) validateDecisionAnswer(question, answer);
          if (pending.question + 1 === dialog.questions.length) {
            await this.finish(pending, { answers: [...pending.answers, answer] }, interaction); return;
          }
          await interaction.deferUpdate();
          pending.answers.push(answer);
          pending.question++;
          pending.selected = [];
          pending.customInput = undefined;
        } else return;
        await this.refresh(pending);
      }
    } finally { pending.busy = false; }
  }

  /** Only the caller's stored, already-authorized cursor; never bootstrap history. */
  async fetchAfter(route: Route, messageId: string): Promise<Inbound[]> {
    if (!/^[0-9]{1,20}$/.test(messageId)) throw new DeliveryError("Catchup requires a stored Discord message snowflake", "rejected");
    const channel = await this.destination(physicalRoute(route));
    const inputs: Inbound[] = [];
    let cursor = messageId;
    for (;;) {
      const page = await channel.messages.fetch({ after: cursor, limit: 100, cache: false });
      const messages = [...page.values()].sort((left, right) => BigInt(left.id) < BigInt(right.id) ? -1 : 1);
      if (!messages.length) break;
      for (const message of messages) {
        const input = this.normalize(message, "pointer");
        if (input && !this.isVoiceControl(input) && physicalRouteKey(input.route) === physicalRouteKey(route)) {
          await this.resolveReply(message, input);
          inputs.push(input);
        }
      }
      const next = messages[messages.length - 1]!.id;
      if (BigInt(next) <= BigInt(cursor)) throw new Error("Discord catchup cursor did not advance");
      cursor = next;
      if (page.size < 100) break;
    }
    return inputs;
  }

  private forumTags(channel: ForumChannel | MediaChannel, appliedTags: readonly string[] | undefined, permissions: Readonly<PermissionsBitField>): void {
    if (appliedTags !== undefined && (!Array.isArray(appliedTags) || appliedTags.length > 5 ||
      new Set(appliedTags).size !== appliedTags.length || appliedTags.some(id => typeof id !== "string"))) {
      throw new DeliveryError("Discord forum/media tags must be at most five unique tag IDs", "rejected");
    }
    if (channel.flags.has(ChannelFlagsBitField.Flags.RequireTag) && !appliedTags?.length) {
      throw new DeliveryError("Discord forum/media topics require an explicitly selected tag in this channel", "rejected");
    }
    for (const id of appliedTags ?? []) {
      const tag = channel.availableTags.find(tag => tag.id === id);
      if (!tag) throw new DeliveryError("Discord tag ID is not available in this forum/media channel", "rejected");
      if (tag.moderated && !permissions.has(PermissionFlagsBits.ManageThreads)) {
        throw new DeliveryError("Discord moderated tags require ManageThreads permission", "rejected");
      }
    }
  }

  private async forumThreadAllowed(channel: ForumChannel | MediaChannel, appliedTags?: readonly string[]): Promise<boolean> {
    const member = await channel.guild.members.fetchMe({ force: true });
    const permissions = channel.permissionsFor(member);
    if (!permissions) throw new DeliveryError("Discord bot channel permissions could not be resolved", "rejected");
    this.forumTags(channel, appliedTags, permissions);
    // Forum/media posts require SEND_MESSAGES, not CREATE_PUBLIC_THREADS.
    // Reading and replying must also work for the resulting native topic.
    // https://docs.discord.com/developers/topics/threads#creating-threads-in-forum-and-media-channels
    return permissions.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.SendMessages, PermissionFlagsBits.SendMessagesInThreads]);
  }

  /** Read-only capability checks never enable features or choose forum tags. */
  async canCreateThread(route: Route, appliedTags?: readonly string[]): Promise<boolean> {
    this.assertRoute(route);
    if (!route.guildId || route.threadId !== null) {
      if (appliedTags !== undefined) throw new DeliveryError("Discord tags can only be selected for forum/media topic creation", "rejected");
      return false;
    }
    try {
      const channel = await this.channel(route, true);
      if (channel.type === ChannelType.GuildForum || channel.type === ChannelType.GuildMedia) return await this.forumThreadAllowed(channel, appliedTags);
      if (appliedTags !== undefined) throw new DeliveryError("Discord tags can only be selected for forum/media topic creation", "rejected");
      if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) return false;
      const member = await channel.guild.members.fetchMe({ force: true });
      const permissions = channel.permissionsFor(member);
      if (!permissions) throw new DeliveryError("Discord bot channel permissions could not be resolved", "rejected");
      // A new announcement thread needs a starter message; both destinations
      // must also allow the bot to participate in the thread it creates.
      // https://docs.discord.com/developers/topics/threads#permissions
      return permissions.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.CreatePublicThreads, PermissionFlagsBits.SendMessagesInThreads]);
    } catch (error) { throw deliveryError(error); }
  }

  async createThread(route: Route, title: string, sourceMessageId?: string, appliedTags?: readonly string[]): Promise<Route> {
    this.assertRoute(route);
    if (!route.guildId) throw new DeliveryError("Discord DMs cannot create threads; provide an explicit authorized guild target", "rejected");
    if (route.threadId) throw new DeliveryError("Discord cannot nest threads; provide an explicit parent-channel target", "rejected");
    if (typeof title !== "string" || !title.trim() || title.length > 100) throw new DeliveryError("Discord thread title must contain 1–100 characters", "rejected");
    try {
      // Forum/media roots cannot receive ordinary messages, but can create
      // native starter-message posts within this same authorized destination.
      const channel = await this.channel(route, true);
      if (appliedTags !== undefined && channel.type !== ChannelType.GuildForum && channel.type !== ChannelType.GuildMedia) {
        throw new DeliveryError("Discord tags can only be selected for forum/media topic creation", "rejected");
      }
      let thread;
      if (channel.type === ChannelType.GuildForum || channel.type === ChannelType.GuildMedia) {
        if (sourceMessageId !== undefined) throw new DeliveryError("Discord forum/media topics cannot reuse a source message; provide the authorized parent without a source", "rejected");
        if (!await this.forumThreadAllowed(channel, appliedTags)) throw new DeliveryError("Discord bot lacks permissions to create and use a forum/media topic", "rejected");
        thread = await channel.threads.create({ name: title, ...(appliedTags === undefined ? {} : { appliedTags: [...appliedTags] }),
          message: { content: title, allowedMentions: NO_MENTIONS } });
      } else if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) {
        throw new DeliveryError("This guild channel cannot create a public conversation thread", "rejected");
      } else if (sourceMessageId) {
        if (!/^[0-9]{1,20}$/.test(sourceMessageId)) throw new DeliveryError("Invalid thread source message ID", "rejected");
        const source = await channel.messages.fetch(sourceMessageId);
        if (source.id !== sourceMessageId || source.channelId !== route.channelId || source.guildId !== route.guildId) throw new DeliveryError("Discord thread source does not belong to this destination", "rejected");
        thread = await source.startThread({ name: title });
      } else if (channel.type === ChannelType.GuildAnnouncement) {
        // Announcement threads can only be started from a real message.
        const starter = await channel.send({ content: title, allowedMentions: NO_MENTIONS });
        if (starter.channelId !== route.channelId || starter.guildId !== route.guildId || starter.author.id !== this.client.user?.id) throw new DeliveryError("Discord thread starter had an unexpected destination", "uncertain");
        thread = await starter.startThread({ name: title });
      } else {
        thread = await channel.threads.create({ name: title, type: ChannelType.PublicThread });
      }
      const created = this.route(thread);
      if (!created || created.threadId === null || created.guildId !== route.guildId || created.channelId !== route.channelId) throw new DeliveryError("Created Discord thread had an unexpected destination", "uncertain");
      return created;
    } catch (error) { throw deliveryError(error); }
  }

  private async threadContext(route: Route) {
    this.assertRoute(route);
    if (!route.guildId) throw new DeliveryError("Discord thread inspection requires an authorized guild destination", "rejected");
    const channel = await this.channel(route, true);
    const parent = channel.isThread() ? await this.channel({ ...route, threadId: null }, true) : channel;
    if (parent.type !== ChannelType.GuildText && parent.type !== ChannelType.GuildAnnouncement &&
      parent.type !== ChannelType.GuildForum && parent.type !== ChannelType.GuildMedia) {
      throw new DeliveryError("Discord destination is not a supported thread parent", "rejected");
    }
    const member = await parent.guild.members.fetchMe({ force: true });
    const parentPermissions = parent.permissionsFor(member);
    const permissions = channel.isThread() ? channel.permissionsFor(member) : parentPermissions;
    if (!parentPermissions || !permissions) throw new DeliveryError("Discord bot channel permissions could not be resolved", "rejected");
    if (!parentPermissions.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]) ||
      !permissions.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) {
      throw new DeliveryError("Discord bot lacks permissions to inspect this thread destination", "rejected");
    }
    return { channel, parent, permissions };
  }

  async inspectThread(route: Route): Promise<ThreadInfo> {
    try {
      const { channel, parent } = await this.threadContext(route);
      const forum = parent.type === ChannelType.GuildForum || parent.type === ChannelType.GuildMedia;
      return {
        route: physicalRoute(route),
        title: channel.isThread() ? channel.name : parent.name,
        archived: channel.isThread() ? channel.archived : null,
        requiresTag: forum && parent.flags.has(ChannelFlagsBitField.Flags.RequireTag),
        availableTags: forum ? parent.availableTags.map(tag => ({ id: tag.id, name: tag.name, moderated: tag.moderated })) : [],
        appliedTags: channel.isThread() ? [...channel.appliedTags] : [],
      };
    } catch (error) { throw deliveryError(error); }
  }

  async updateThread(route: Route, update: ThreadUpdate): Promise<ThreadInfo> {
    this.assertRoute(route);
    if (!route.guildId || !route.threadId) throw new DeliveryError("Discord thread updates require an existing guild thread", "rejected");
    if (typeof update !== "object" || update === null || Array.isArray(update) || !Object.keys(update).length ||
      Object.keys(update).some(key => key !== "title" && key !== "appliedTags" && key !== "archived") ||
      ("title" in update && (typeof update.title !== "string" || !update.title.trim() || update.title.length > 100)) ||
      ("archived" in update && typeof update.archived !== "boolean") ||
      ("appliedTags" in update && !Array.isArray(update.appliedTags))) {
      throw new DeliveryError("Discord thread update requires only a title of 1-100 characters, tag IDs, or a boolean archived value", "rejected");
    }
    let edited = false;
    try {
      const { channel, parent, permissions } = await this.threadContext(route);
      if (!channel.isThread()) throw new DeliveryError("Discord thread updates require an existing guild thread", "rejected");
      if (!permissions.has(PermissionFlagsBits.ManageThreads)) throw new DeliveryError("Discord thread updates require ManageThreads permission", "rejected");
      if ("appliedTags" in update) {
        if (parent.type !== ChannelType.GuildForum && parent.type !== ChannelType.GuildMedia) {
          throw new DeliveryError("Discord tags can only be updated on forum/media threads", "rejected");
        }
        this.forumTags(parent, update.appliedTags, permissions);
      }
      // discord.js sends these fields together in one PATCH. Omitted fields
      // stay omitted: never unarchive, lock, or change tags as a side effect.
      await channel.edit({
        ...(update.title === undefined ? {} : { name: update.title }),
        ...(update.appliedTags === undefined ? {} : { appliedTags: [...update.appliedTags] }),
        ...(update.archived === undefined ? {} : { archived: update.archived }),
      });
      edited = true;
      const result = await this.inspectThread(route);
      if ((update.title !== undefined && result.title !== update.title) ||
        (update.archived !== undefined && result.archived !== update.archived) ||
        (update.appliedTags !== undefined && (result.appliedTags.length !== update.appliedTags.length ||
          update.appliedTags.some(id => !result.appliedTags.includes(id))))) {
        throw new DeliveryError("Discord thread update readback did not match the requested state", "uncertain");
      }
      return result;
    } catch (error) {
      if (edited) throw new DeliveryError("Discord thread update was sent but authoritative readback could not be confirmed", "uncertain", undefined, { cause: error });
      throw deliveryError(error);
    }
  }

  async stop(): Promise<void> {
    this.connected = false;
    this.onVoiceDisconnect();
    if (this.admission) {
      this.admission.stopped = true;
      this.admission.stop();
    }
    this.client.off(Events.MessageCreate, this.onMessage);
    this.client.off(Events.MessageUpdate, this.onEdit);
    this.client.off(Events.InteractionCreate, this.onInteraction);
    this.client.off(Events.ShardResume, this.onReconnect);
    this.client.off(Events.ShardDisconnect, this.onVoiceDisconnect);
    this.client.off(Events.ShardReconnecting, this.onVoiceDisconnect);
    this.client.off(Events.ShardReady, this.onReconnect);
    this.client.off(Events.Error, this.report);
    await this.intake;
    this.handlers = null;
    for (const pending of this.pending.values()) pending.active = false;
    this.pending.clear();
    await this.client.destroy();
  }
}
