import { createHash } from "node:crypto";
import {
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ChannelFlagsBitField, ChannelType, Client,
  Events, GatewayIntentBits, MessageFlags, ModalBuilder, Partials, PermissionFlagsBits, StringSelectMenuBuilder,
  Routes, TextInputBuilder, TextInputStyle,
  type ForumChannel, type Interaction, type MediaChannel, type Message, type MessageCreateOptions, type PartialMessage,
} from "discord.js";
import { physicalRoute, physicalRouteKey, routeKey, type Approval, type Attachment, type DialogResponse, type Inbound, type MessageActivity, type Messenger, type OutputRecord, type Route } from "./contracts.ts";
import { parseDialog, type Dialog } from "./dialog.ts";
import { DeliveryError } from "./delivery.ts";

// Reference (not copied): gimso2x/ompbot @ 4d2eb28d0bf66644892dc0fc333580d0eb7e7780,
// src/discord/{adapter,attachments,channel,transport}.ts (MIT, ompbot contributors).
// discord.js owns Gateway/REST, including nonce serialization. Nonces are only a
// short-window server dedupe aid, never an exactly-once delivery guarantee.
const NO_MENTIONS = { parse: [] as never[], repliedUser: false };
const FILE_LIMIT = 8 * 1024 * 1024;
const MESSAGE_LIMIT = 2000;
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
  stopped: boolean;
  stop(): void;
}

export interface DiscordMessengerOptions {
  token: string;
  ownerId: string;
  allowedGuildIds: string[];
  allowedChannelIds: string[];
  /** A supported discord.js Client, primarily for deterministic transport tests. */
  client?: Client;
  /** Attachment HTTP boundary; Discord credentials are never sent to the CDN. */
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
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

/** Keep Discord capacity checks separate from shared native dialog semantics. */
function discordDialog(request: Record<string, unknown>): Dialog {
  if (request.secret === true) return parseDialog(request); // Reject before inspecting any secret content.
  // Reserve room for question labels, controls, and a 4000-character free-text
  // response when a request must be displayed through a text attachment.
  if (Buffer.byteLength(JSON.stringify(request), "utf8") > FILE_LIMIT - 64 * 1024) unsupported("Dialog content exceeds the safe Discord attachment limit; use the local OMP interface.");
  const dialog = parseDialog(request);
  if (dialog.method === "ask") for (const question of dialog.questions) {
    if (question.options.length > 25) unsupported("Ask options exceed Discord limits.");
    for (const option of question.options) {
      if (option.label.length > 100) unsupported("Ask option cannot fit a Discord select menu.");
      if (option.description && option.description.length > 100) unsupported("Ask description cannot fit a Discord select menu.");
    }
  }
  if (dialog.method === "select") {
    if (dialog.options.length > 25 || dialog.options.some(option => option.length > 100)) unsupported("Select options cannot fit a Discord select menu.");
    if (dialog.details.some(detail => detail && detail.length > 100)) unsupported("Select description cannot fit a Discord select menu.");
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
  private readonly onMessage = (message: Message) => { this.enqueue(message); };
  private readonly onEdit = (_old: Message | PartialMessage, message: Message | PartialMessage) => { this.enqueue(message); };
  private readonly onInteraction = (interaction: Interaction) => { void this.interact(interaction).catch(this.report); };
  private readonly onReconnect = () => {
    if (!this.connected) return;
    const admission = this.admission;
    this.intake = this.intake.then(async () => {
      if (await this.admitted(admission)) await this.handlers?.reconnect?.();
    }).catch(this.report);
  };

  constructor(private readonly options: DiscordMessengerOptions) {
    this.guilds = new Set(options.allowedGuildIds);
    this.channels = new Set(options.allowedChannelIds);
    this.report = options.onError ?? (error => console.error("Discord event failed:", error));
    this.client = options.client ?? new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent],
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
      stopped: false,
      stop: () => { stopped.resolve(false); },
    };
    this.client.on(Events.MessageCreate, this.onMessage);
    this.client.on(Events.MessageUpdate, this.onEdit);
    this.client.on(Events.InteractionCreate, this.onInteraction);
    this.client.on(Events.ShardResume, this.onReconnect);
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

  private enqueue(message: Message | PartialMessage): void {
    const admission = this.admission;
    this.intake = this.intake.then(async () => {
      if (!await this.admitted(admission)) return;
      // Check destination and known author before even fetching a partial message.
      if (!this.route(message.channel) || (message.author && (message.author.bot || message.author.id !== this.options.ownerId))) return;
      if (!message.guildId && "recipientId" in message.channel && message.channel.recipientId !== this.options.ownerId) return;
      const full = message.partial ? await message.fetch() : message;
      const inbound = this.normalize(full);
      if (inbound) await this.handlers?.message(inbound);
    }).catch(this.report);
  }

  /** Pure normalization of an already fetched Discord message; no attachment downloads. */
  normalize(message: Message): Inbound | null {
    if (message.author.bot || message.author.id !== this.options.ownerId || message.webhookId) return null;
    const route = this.route(message.channel);
    if (!route || (message.type !== 0 && message.type !== 19)) return null;
    if (!route.guildId && (message.channel.type !== ChannelType.DM || message.channel.recipientId !== this.options.ownerId)) return null;
    const attachments = [...message.attachments.values()].filter(file => discordAttachmentAllowed(file.url)).map(file => ({
      id: file.id, name: file.name, url: file.url, size: file.size,
      ...(file.contentType ? { contentType: file.contentType } : {}),
    }));
    // CDN URLs carry expiring signatures; refreshing one must not create a new
    // input revision for an unchanged Discord edit.
    const attachmentIdentity = attachments.map(file => [file.id, file.name, file.size, file.contentType]).sort((left, right) => String(left[0]).localeCompare(String(right[0])));
    const revision = message.editedTimestamp === null ? "original" : `edit:${message.editedTimestamp}:${hash(JSON.stringify([message.content, attachmentIdentity]))}`;
    return {
      id: `discord:${route.accountId}:${message.id}:${revision}`, route, messageId: message.id,
      text: message.content, receivedAt: message.editedTimestamp ?? message.createdTimestamp, attachments,
    };
  }

  private assertRoute(route: Route): void {
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
    if (!discordAttachmentAllowed(attachment.url)) throw new DeliveryError("Attachment is not an authorized Discord CDN attachment", "rejected");
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

  private payload(content: string, nonce: string, components?: Controls): MessageCreateOptions {
    if (Buffer.byteLength(content, "utf8") > FILE_LIMIT) throw new DeliveryError("Discord text attachment exceeds the safe 8 MiB upload limit", "rejected");
    return {
      ...(content.length <= MESSAGE_LIMIT ? { content: content || "(empty output)" } : {
        content: "Full text is attached (exceeds Discord's message limit).",
        files: [new AttachmentBuilder(Buffer.from(content, "utf8"), { name: `omp-${nonce}.txt` })],
      }),
      allowedMentions: NO_MENTIONS, nonce, enforceNonce: true, ...(components ? { components } : {}),
    };
  }

  async send(output: OutputRecord): Promise<string> {
    try {
      const channel = await this.destination(output.route);
      const message = await channel.send(this.payload(output.text, discordNonce(output.id, output.route)));
      return message.id;
    } catch (error) { throw deliveryError(error); }
  }

  async setActivity(message: Pick<Inbound, "route" | "messageId">, activity: MessageActivity): Promise<void> {
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
  private view(pending: Pending): { content: string; components: Controls } {
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
      const marker = (index: number) => index >= dialog.markableCount || !dialog.marker ? "" : dialog.marker === "checkbox" ? (dialog.checked.includes(index) ? "☑️" : "⬜") : "⚪";
      const state = dialog.marker ? `\n${dialog.options.map((label, index) => `${marker(index)} ${label}${index === dialog.initialIndex ? " (initial focus)" : ""}`).join("\n")}\nChoose one row per response; OMP supplies the checked state on each request.` : "";
      return {
        content: dialog.title + state,
        components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder().setCustomId(this.control(pending, "select")).setMinValues(1).setMaxValues(1).addOptions(dialog.options.map((label, index) => ({ label, value: String(index), ...(marker(index) ? { emoji: { name: marker(index) } } : {}), ...(dialog.details[index] ? { description: dialog.details[index] } : {}) })))), new ActionRowBuilder<ButtonBuilder>().addComponents(cancel)],
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
    return { content: `Question ${pending.question + 1}/${dialog.questions.length}${question.header ? ` — ${question.header}` : ""}\n${question.question}\n${question.multi ? "Multiple answers allowed." : "Choose one option OR free text."}\n${previews}\n${pending.customInput ? `Free text: ${pending.customInput}` : ""}`, components };
  }

  async showApproval(approval: Approval): Promise<string> {
    this.assertRoute(approval.route);
    if (!this.handlers) throw new DeliveryError("Discord messenger is not started", "rejected");
    if (approval.state !== "pending") throw new DeliveryError("Discord approval is no longer pending", "rejected");
    const token = hash(JSON.stringify([approval.id, approval.generation, approval.target, approval.requestId, routeKey(approval.route)]));
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

  private async refresh(pending: Pending): Promise<void> {
    if (!pending.messageId || !pending.active) return;
    const channel = await this.destination(pending.approval.route);
    const message = await channel.messages.fetch(pending.messageId);
    this.assertApprovalMessage(message, pending.approval, pending.token);
    const view = this.view(pending);
    const payload = this.payload(view.content, discordNonce(`approval:${pending.token}`, pending.approval.route), view.components);
    await message.edit({ content: payload.content, files: payload.files, attachments: [], components: view.components, allowedMentions: NO_MENTIONS });
  }

  async dismissApproval(approval: Approval): Promise<void> {
    this.assertRoute(approval.route);
    const matches = [...this.pending.values()].filter(pending => pending.approval.id === approval.id && pending.approval.generation === approval.generation && routeKey(pending.approval.route) === routeKey(approval.route));
    for (const pending of matches) pending.active = false;
    const messageIds = new Set([approval.remoteId, ...matches.map(pending => pending.messageId)].filter((id): id is string => !!id));
    try {
      const channel = await this.destination(approval.route);
      for (const id of messageIds) {
        try {
          const message = await channel.messages.fetch(id);
          const token = hash(JSON.stringify([approval.id, approval.generation, approval.target, approval.requestId, routeKey(approval.route)]));
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
    // The handler's receipt is the durable admission boundary. Until it resolves,
    // leave the original control and draft actionable, without acknowledging it.
    await this.handlers!.answer(pending.approval.id, response, pending.approval.route);
    // Admission succeeded: ACK/cleanup failures must never resubmit the answer.
    pending.active = false;
    try { await interaction.deferUpdate(); }
    finally { await this.dismissApproval(pending.approval); }
  }

  private async interact(interaction: Interaction): Promise<void> {
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
      if (dialog.method === "select" && interaction.isStringSelectMenu() && action === "select") {
        const index = interaction.values[0];
        if (interaction.values.length !== 1 || !index || !/^(0|[1-9][0-9]*)$/.test(index) || !dialog.options[Number(index)]) throw new Error("Invalid Discord select value");
        await this.finish(pending, { value: dialog.options[Number(index)]! }, interaction); return;
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
        const input = this.normalize(message);
        if (input && physicalRouteKey(input.route) === physicalRouteKey(route)) inputs.push(input);
      }
      const next = messages[messages.length - 1]!.id;
      if (BigInt(next) <= BigInt(cursor)) throw new Error("Discord catchup cursor did not advance");
      cursor = next;
      if (page.size < 100) break;
    }
    return inputs;
  }

  private async forumThreadAllowed(channel: ForumChannel | MediaChannel): Promise<boolean> {
    if (channel.flags.has(ChannelFlagsBitField.Flags.RequireTag)) {
      throw new DeliveryError("Discord forum/media topics require an explicitly selected tag in this channel; this interface cannot select tags", "rejected");
    }
    const member = await channel.guild.members.fetchMe({ force: true });
    const permissions = channel.permissionsFor(member);
    if (!permissions) throw new DeliveryError("Discord bot channel permissions could not be resolved", "rejected");
    // Forum/media posts require SEND_MESSAGES, not CREATE_PUBLIC_THREADS.
    // Reading and replying must also work for the resulting native topic.
    // https://docs.discord.com/developers/topics/threads#creating-threads-in-forum-and-media-channels
    return permissions.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.SendMessages, PermissionFlagsBits.SendMessagesInThreads]);
  }

  /** Read-only capability checks never enable features or choose forum tags. */
  async canCreateThread(route: Route): Promise<boolean> {
    this.assertRoute(route);
    if (!route.guildId || route.threadId !== null) return false;
    try {
      const channel = await this.channel(route, true);
      if (channel.type === ChannelType.GuildForum || channel.type === ChannelType.GuildMedia) return await this.forumThreadAllowed(channel);
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

  async createThread(route: Route, title: string, sourceMessageId?: string): Promise<Route> {
    this.assertRoute(route);
    if (!route.guildId) throw new DeliveryError("Discord DMs cannot create threads; provide an explicit authorized guild target", "rejected");
    if (route.threadId) throw new DeliveryError("Discord cannot nest threads; provide an explicit parent-channel target", "rejected");
    if (!title.trim() || title.length > 100) throw new DeliveryError("Discord thread title must contain 1–100 characters", "rejected");
    try {
      // Forum/media roots cannot receive ordinary messages, but can create
      // native starter-message posts within this same authorized destination.
      const channel = await this.channel(route, true);
      let thread;
      if (channel.type === ChannelType.GuildForum || channel.type === ChannelType.GuildMedia) {
        if (sourceMessageId !== undefined) throw new DeliveryError("Discord forum/media topics cannot reuse a source message; provide the authorized parent without a source", "rejected");
        if (!await this.forumThreadAllowed(channel)) throw new DeliveryError("Discord bot lacks permissions to create and use a forum/media topic", "rejected");
        thread = await channel.threads.create({ name: title, message: { content: title, allowedMentions: NO_MENTIONS } });
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

  async stop(): Promise<void> {
    this.connected = false;
    if (this.admission) {
      this.admission.stopped = true;
      this.admission.stop();
    }
    this.client.off(Events.MessageCreate, this.onMessage);
    this.client.off(Events.MessageUpdate, this.onEdit);
    this.client.off(Events.InteractionCreate, this.onInteraction);
    this.client.off(Events.ShardResume, this.onReconnect);
    this.client.off(Events.ShardReady, this.onReconnect);
    this.client.off(Events.Error, this.report);
    await this.intake;
    this.handlers = null;
    for (const pending of this.pending.values()) pending.active = false;
    this.pending.clear();
    await this.client.destroy();
  }
}
