import { createHash, randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Api, InputFile } from "grammy";
import type { CallbackQuery, Chat, InlineKeyboardButton, InlineKeyboardMarkup, Message, Update, UserFromGetMe } from "grammy/types";
import { physicalRouteKey, routeKey, type Approval, type Attachment, type DialogResponse, type Inbound, type Messenger, type OutputRecord, type Route, type StorePort } from "./contracts.ts";
import { parseDialog, type Dialog } from "./dialog.ts";
import { DeliveryError } from "./delivery.ts";

// grammY Api has no retry transformer installed. Only getUpdates is retried.
// Bot API: https://core.telegram.org/bots/api#getupdates (24-hour retention),
// #sendmessage (4096 characters), #getfile (20 MB), #inlinekeyboardbutton
// (64-byte callback_data), #createforumtopic, and #editmessagetext.
const TEXT_LIMIT = 4096;
const UPLOAD_LIMIT = 50 * 1024 * 1024;
const DOWNLOAD_LIMIT = 20 * 1024 * 1024;
// getUpdates retains updates for at most 24 hours. An old offset is therefore
// unnecessary after that idle interval; dropping it also safely precedes the
// documented random update_id reset after at least a week without updates.
const CURSOR_IDLE_MS = 24 * 60 * 60 * 1000;
type Handlers = Parameters<Messenger["start"]>[0];
type Answer = NonNullable<DialogResponse["answers"]>[number];
interface Progress {
  messageId: string | null;
  attempted: boolean;
  active: boolean;
  question: number;
  answers: Answer[];
  selected: string[];
  customInput?: string;
  lastUpdate?: string;
  /** A final answer was attempted; only durable queue readback proves admission. */
  answerRequest?: string;
}
interface Pending extends Progress {
  approval: Approval;
  token: string;
  dialog: Dialog;
  stamp: string;
  busy: boolean;
  verified: boolean;
}
interface CardView { text: string; reply_markup: InlineKeyboardMarkup }

export interface TelegramMessengerOptions {
  token: string;
  ownerId: string;
  allowedChatIds: string[];
  store: Pick<StorePort, "getMeta" | "setMeta"> & {
    /** The Gateway retains answers while the original native request is pending. */
    hasPendingAnswer?(approvalId: string, route: Route): boolean;
  };
  onError?: (error: unknown) => void;
  /** Supported grammY HTTP boundary, also used for authenticated file downloads. */
  fetch?: typeof fetch;
}

function hash(value: string): string { return createHash("sha256").update(value).digest("hex").slice(0, 24); }
function integer(value: string): boolean { return /^(0|[1-9][0-9]*)$/.test(value) && Number.isSafeInteger(Number(value)); }
function record(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" ? value as Record<string, unknown> : {}; }
function code(error: unknown): number | undefined { const value = record(error).error_code; return typeof value === "number" ? value : undefined; }
function notModified(error: unknown): boolean { return code(error) === 400 && String(record(error).description).includes("message is not modified"); }

/** Never retain SDK errors: their nested HTTP causes/payloads can contain tokens. */
export function telegramDeliveryError(error: unknown): DeliveryError {
  if (error instanceof DeliveryError) return error;
  const status = code(error);
  const retry = record(record(error).parameters).retry_after;
  return new DeliveryError(status ? `Telegram API rejected operation (${status})` : "Telegram operation outcome is unknown",
    status !== undefined && status >= 400 && status < 500 && status !== 408 ? "rejected" : "uncertain",
    status === 429 && typeof retry === "number" && retry >= 0 ? retry * 1000 : undefined);
}

export class TelegramMessenger implements Messenger {
  private readonly api: Api;
  private readonly http: typeof fetch;
  private readonly chats: Set<string>;
  private readonly report: (error: unknown) => void;
  private me: UserFromGetMe | null = null;
  private handlers: Handlers | null = null;
  private abort: AbortController | null = null;
  private polling: Promise<void> | null = null;
  private readonly pending = new Map<string, Pending>();
  private readonly approvalFlights = new Map<string, Promise<string>>();

  constructor(private readonly options: TelegramMessengerOptions) {
    this.http = options.fetch ?? globalThis.fetch;
    // Redirects may otherwise forward the bot token embedded in the API URL.
    this.api = new Api(options.token, { fetch: this.http, sensitiveLogs: false, timeoutSeconds: 45, baseFetchConfig: { redirect: "error" } });
    this.chats = new Set(options.allowedChatIds);
    this.report = options.onError ?? (error => console.error("Telegram event failed:", error));
    if (!/^[1-9][0-9]*$/.test(options.ownerId) || !Number.isSafeInteger(Number(options.ownerId)) ||
      options.allowedChatIds.some(id => !/^-[1-9][0-9]*$/.test(id) || !Number.isSafeInteger(Number(id)))) {
      throw new DeliveryError("Telegram requires a positive owner user ID and negative allowed group IDs", "rejected");
    }
  }

  private get offsetKey(): string { return `telegram:${this.me!.id}:offset`; }
  private get observedAtKey(): string { return `telegram:${this.me!.id}:observed-at`; }
  private stateKey(token: string): string { return `telegram:${this.me!.id}:approval:${token}`; }
  private cardKey(route: Route, messageId: string): string { return `telegram:${this.me!.id}:card:${hash(JSON.stringify([physicalRouteKey(route), messageId]))}`; }
  private fileKey(route: Route, fileId: string): string { return `telegram:${this.me!.id}:file:${hash(JSON.stringify([physicalRouteKey(route), fileId]))}`; }
  private approvalToken(approval: Approval): string { return hash(JSON.stringify([approval.id, approval.generation, approval.target, approval.requestId, routeKey(approval.route)])); }

  async start(handlers: Handlers): Promise<void> {
    if (this.handlers) throw new DeliveryError("Telegram messenger is already started", "rejected");
    this.handlers = handlers;
    this.abort = new AbortController();
    // Observe rejection immediately, even if reconciliation fails while the
    // authentication reads are still in flight. No raw startup error is logged.
    const ready = handlers.ready?.then(() => true, () => false);
    try {
      this.me = await this.api.getMe(this.abort.signal);
      if (!this.me.is_bot || !Number.isSafeInteger(this.me.id)) throw new DeliveryError("Telegram getMe did not identify a bot", "rejected");
      const webhook = await this.api.getWebhookInfo(this.abort.signal);
      if (webhook.url) throw new DeliveryError("Telegram bot already has a webhook; refusing to remove or replace it", "rejected");
      const offset = this.options.store.getMeta(this.offsetKey);
      if (offset !== null && !integer(offset)) throw new DeliveryError("Telegram stored update offset is invalid", "rejected");
      this.polling = this.poll(offset === null ? undefined : Number(offset), this.abort.signal, ready);
    } catch (error) {
      this.abort.abort(); this.abort = null; this.handlers = null; this.me = null;
      throw telegramDeliveryError(error);
    }
  }

  private async poll(offset: number | undefined, signal: AbortSignal, ready?: Promise<boolean>): Promise<void> {
    if (signal.aborted) return;
    if (ready) {
      const { promise, resolve } = Promise.withResolvers<boolean>();
      const abort = () => { resolve(false); };
      signal.addEventListener("abort", abort, { once: true });
      try {
        if (!await Promise.race([ready, promise])) {
          if (!signal.aborted) this.report(new DeliveryError("Telegram startup reconciliation failed; intake remains stopped", "rejected"));
          return;
        }
      } finally { signal.removeEventListener("abort", abort); }
    }
    let recovering = false;
    while (!signal.aborted) {
      try {
        const savedObservedAt = this.options.store.getMeta(this.observedAtKey);
        const now = Date.now();
        // Missing timestamps (including older ledgers), clock rollback, and
        // retention-expired cursors must not send an old high offset that could
        // acknowledge a new, lower random update sequence before admission.
        if (offset !== undefined && (savedObservedAt === null || !integer(savedObservedAt) ||
          Number(savedObservedAt) > now || now - Number(savedObservedAt) >= CURSOR_IDLE_MS)) offset = undefined;
        const updates = await this.api.getUpdates({ ...(offset === undefined ? {} : { offset }), timeout: 30, limit: 100,
          allowed_updates: ["message", "edited_message", "callback_query"] }, signal);
        const observedAt = Date.now();
        if (recovering) { await this.handlers?.reconnect?.(); recovering = false; }
        for (const update of updates) {
          if (signal.aborted) return;
          if (!Number.isSafeInteger(update.update_id) || update.update_id < 0) throw new DeliveryError("Telegram supplied an invalid update ID", "rejected");
          if (offset !== undefined && update.update_id < offset) continue;
          await this.process(update);
          // The next getUpdates call acknowledges this cursor remotely. Persist
          // only after durable admission/native approval processing completes.
          const next = update.update_id + 1;
          this.options.store.setMeta(this.offsetKey, String(next));
          // Offset first: a crash between writes can only cause conservative
          // replay, never pair a fresh timestamp with a stale high offset.
          this.options.store.setMeta(this.observedAtKey, String(observedAt));
          offset = next;
        }
      } catch (error) {
        if (signal.aborted) return;
        const safe = telegramDeliveryError(error);
        this.report(safe);
        if ([401, 403, 409].includes(code(error) ?? 0)) return;
        recovering = true;
        try { await delay(Math.max(1000, safe.retryAfterMs ?? 0), undefined, { signal }); }
        catch { return; }
      }
    }
  }

  private route(chat: Chat, threadId?: number): Route | null {
    if (!this.me || !Number.isSafeInteger(chat.id)) return null;
    const channelId = String(chat.id);
    if (chat.type === "private") {
      if (channelId !== this.options.ownerId || (threadId !== undefined && !this.me.has_topics_enabled)) return null;
    } else if ((chat.type !== "group" && chat.type !== "supergroup") || !this.chats.has(channelId) || chat.id >= 0 ||
      (threadId !== undefined && (chat.type !== "supergroup" || !chat.is_forum))) return null;
    if (threadId !== undefined && (!Number.isSafeInteger(threadId) || threadId <= 0)) return null;
    return { platform: "telegram", accountId: String(this.me.id), authorityId: this.options.ownerId,
      guildId: chat.type === "private" ? null : channelId, channelId, threadId: threadId === undefined ? null : String(threadId) };
  }

  /** Sender and physical destination are API identities, never quoted identities. */
  normalize(message: Message): Inbound | null {
    const data = record(message);
    if (!message.from || message.from.is_bot || String(message.from.id) !== this.options.ownerId || message.sender_chat ||
      data.forward_origin || data.forward_from || data.forward_sender_name || data.forward_from_chat || data.is_automatic_forward || data.via_bot || data.business_connection_id) return null;
    const route = this.route(message.chat, message.message_thread_id);
    if (!route || !Number.isSafeInteger(message.message_id) || message.message_id <= 0) return null;
    const files: Attachment[] = [];
    const add = (file: { file_id: string; file_unique_id: string; file_size?: number; file_name?: string; mime_type?: string }, name: string, contentType?: string) => {
      if (!/^[A-Za-z0-9_-]+$/.test(file.file_id)) return;
      files.push({ id: file.file_id, name: file.file_name ?? name, url: `telegram-file:${file.file_id}`,
        size: file.file_size ?? 0, ...(file.mime_type ?? contentType ? { contentType: file.mime_type ?? contentType } : {}) });
    };
    const photo = message.photo?.reduce((largest, candidate) => candidate.width * candidate.height > largest.width * largest.height ? candidate : largest);
    if (photo) add(photo, `photo-${photo.file_unique_id}.jpg`, "image/jpeg");
    if (message.document) add(message.document, `document-${message.document.file_unique_id}`);
    if (message.audio) add(message.audio, `audio-${message.audio.file_unique_id}`);
    if (message.video) add(message.video, `video-${message.video.file_unique_id}.mp4`, "video/mp4");
    if (message.voice) add(message.voice, `voice-${message.voice.file_unique_id}.ogg`, "audio/ogg");
    if (message.video_note) add(message.video_note, `video-note-${message.video_note.file_unique_id}.mp4`, "video/mp4");
    const text = message.text ?? message.caption ?? "";
    if (!text && files.length === 0) return null;
    const revision = message.edit_date === undefined ? "original" : `edit:${message.edit_date}:${hash(JSON.stringify([text, files]))}`;
    return { id: `telegram:${route.accountId}:${route.channelId}:${message.message_id}:${revision}`, route,
      messageId: String(message.message_id), text, receivedAt: (message.edit_date ?? message.date) * 1000, attachments: files };
  }

  private async process(update: Update): Promise<void> {
    if (update.callback_query) { await this.callback(update.callback_query); return; }
    const message = update.message ?? update.edited_message;
    if (!message) return;
    const input = this.normalize(message);
    if (!input) return;
    // An exact reply to an active bot card is the only text approval surface.
    const reply = message.reply_to_message;
    const pending = reply && [...this.pending.values()].find(value => value.messageId === String(reply.message_id) &&
      physicalRouteKey(value.approval.route) === physicalRouteKey(input.route));
    if (pending) {
      if (!reply.from || String(reply.from.id) !== String(this.me!.id) || !reply.from.is_bot || !this.matchesCard(pending, reply)) return;
      if (!pending.active || !pending.verified || pending.busy || !message.text || message.edit_date !== undefined) return;
      if (pending.lastUpdate === input.id) return;
      if (pending.dialog.method === "input" || pending.dialog.method === "editor") {
        await this.finish(pending, { value: message.text }, input.id); return;
      }
      if (pending.dialog.method === "ask") {
        const question = pending.dialog.questions[pending.question]!;
        pending.customInput = message.text;
        if (!question.multi) pending.selected = [];
        pending.lastUpdate = input.id;
        this.save(pending);
        await this.refresh(pending);
        return;
      }
      return;
    }
    // Card receipts outlive their controls and in-memory Pending objects. Never
    // reinterpret a late reply as a new task in the currently selected DM topic.
    if (reply?.from?.is_bot && String(reply.from.id) === String(this.me!.id)) {
      const source = this.route(reply.chat, reply.message_thread_id);
      if (source && physicalRouteKey(source) === physicalRouteKey(input.route) &&
        this.options.store.getMeta(this.cardKey(source, String(reply.message_id))) !== null) return;
    }
    // Unregistered old approval replies must not become ordinary agent input.
    if (reply?.from?.is_bot && String(reply.from.id) === String(this.me!.id) &&
      reply.reply_markup?.inline_keyboard.some(row => row.some(button => "callback_data" in button && /^omp:[a-f0-9]{24}:/.test(button.callback_data)))) return;
    for (const file of input.attachments) this.options.store.setMeta(this.fileKey(input.route, file.id), JSON.stringify(file));
    await this.handlers!.message(input);
  }

  private assertRoute(route: Route): void {
    if (!this.me || route.platform !== "telegram" || route.accountId !== String(this.me.id) || route.authorityId !== this.options.ownerId ||
      (route.guildId === null ? route.channelId !== this.options.ownerId : route.guildId !== route.channelId || !this.chats.has(route.channelId)) ||
      (route.threadId !== null && (!integer(route.threadId) || Number(route.threadId) <= 0)) ||
      (route.topicId !== undefined && route.guildId !== null)) throw new DeliveryError("Telegram route is not authorized for this bot and owner", "rejected");
  }

  private async destination(route: Route): Promise<Chat> {
    this.assertRoute(route);
    const chat = await this.api.getChat(route.channelId);
    const actual = this.route(chat, route.threadId === null ? undefined : Number(route.threadId));
    if (!actual || physicalRouteKey(actual) !== physicalRouteKey(route)) throw new DeliveryError("Telegram destination identity changed", "rejected");
    return chat;
  }

  private thread(route: Route): { message_thread_id?: number } { return route.threadId === null ? {} : { message_thread_id: Number(route.threadId) }; }
  private assertReceipt(message: Message, route: Route, messageId?: string): void {
    const actual = this.route(message.chat, message.message_thread_id);
    if (!actual || physicalRouteKey(actual) !== physicalRouteKey(route) || String(message.from?.id) !== String(this.me!.id) || !message.from?.is_bot ||
      !Number.isSafeInteger(message.message_id) || message.message_id <= 0 || (messageId && String(message.message_id) !== messageId)) {
      throw new DeliveryError("Telegram mutation returned an unexpected message identity", "uncertain");
    }
  }

  async send(output: OutputRecord): Promise<string> {
    try {
      await this.destination(output.route);
      const bytes = Buffer.byteLength(output.text, "utf8");
      if (bytes > UPLOAD_LIMIT) throw new DeliveryError("Telegram text document exceeds the 50 MiB upload limit", "rejected");
      const message = output.text.length <= TEXT_LIMIT ? await this.api.sendMessage(output.route.channelId, output.text || "(empty output)", {
        ...this.thread(output.route), link_preview_options: { is_disabled: true }, allow_paid_broadcast: false,
      }) : await this.api.sendDocument(output.route.channelId, new InputFile(Buffer.from(output.text, "utf8"), `omp-${hash(output.id)}.txt`), {
        ...this.thread(output.route), caption: "Full output is attached.", allow_paid_broadcast: false,
      });
      this.assertReceipt(message, output.route);
      return String(message.message_id);
    } catch (error) { throw telegramDeliveryError(error); }
  }

  private save(pending: Pending): void {
    const { messageId, attempted, active, question, answers, selected, customInput, lastUpdate, answerRequest } = pending;
    // Partial ask answers are needed only while the dialog remains live.
    this.options.store.setMeta(this.stateKey(pending.token), JSON.stringify({ messageId, attempted, active,
      question: active ? question : 0, answers: active ? answers : [], selected: active ? selected : [],
      ...(active && customInput !== undefined ? { customInput } : {}), lastUpdate, answerRequest } satisfies Progress));
  }
  private button(pending: Pending, action: string, text: string): InlineKeyboardButton {
    const callback_data = `omp:${pending.token}:${action}`;
    if (Buffer.byteLength(callback_data, "utf8") > 64) throw new DeliveryError("Telegram callback exceeds 64 bytes", "rejected");
    return { text, callback_data };
  }
  private view(pending: Pending): CardView {
    const dialog = pending.dialog;
    let text: string;
    const rows: InlineKeyboardButton[][] = [];
    if (dialog.method === "confirm") {
      text = `${dialog.title}\n\n${dialog.message}`;
      rows.push([this.button(pending, "yes", "Confirm"), this.button(pending, "no", "Decline")]);
    } else if (dialog.method === "input" || dialog.method === "editor") {
      text = `${dialog.title}\nReply directly to THIS card with your complete response (not secret).${dialog.placeholder ? `\n${dialog.placeholder}` : ""}${dialog.prefill !== undefined ? `\nCurrent content:\n${dialog.prefill}` : ""}`;
    } else if (dialog.method === "select") {
      text = `${dialog.title}\nChoose one row; marked selections are OMP's current state.\n` + dialog.options.map((label, index) => {
        const marker = index < dialog.markableCount && dialog.marker ? (dialog.marker === "checkbox" ? (dialog.checked.includes(index) ? "[x] " : "[ ] ") : "( ) ") : "";
        rows.push([this.button(pending, `pick-${index}`, `${index + 1}. ${marker}${label}`)]);
        return `${index + 1}. ${marker}${label}${index === dialog.initialIndex ? " (initial focus)" : ""}${dialog.details[index] ? ` — ${dialog.details[index]}` : ""}`;
      }).join("\n");
    } else {
      const question = dialog.questions[pending.question]!;
      text = `Question ${pending.question + 1}/${dialog.questions.length}${question.header ? ` — ${question.header}` : ""}\n${question.question}\n${question.multi ? "Toggle multiple choices and/or reply directly to THIS card with free text." : "Choose one option OR reply directly to THIS card with free text."}\n`;
      text += question.options.map((option, index) => {
        rows.push([this.button(pending, `q${pending.question}-${index}`, `${pending.selected.includes(option.label) ? "[x] " : ""}${index + 1}. ${option.label}`)]);
        return `${index + 1}. ${option.label}${index === question.recommended ? " (recommended, not preselected)" : ""}${option.description ? ` — ${option.description}` : ""}${option.preview ? `\n${option.preview}` : ""}`;
      }).join("\n");
      if (pending.customInput !== undefined) text += `\nFree text received: ${pending.customInput.length} characters (stored in full).`;
      rows.push([this.button(pending, `next-${pending.question}`, pending.question + 1 === dialog.questions.length ? "Submit all answers" : "Next question")]);
    }
    rows.push([this.button(pending, "cancel", "Cancel")]);
    // A fresh activation stamp forces a real authoritative edit response on
    // restart; Telegram has no getMessage API. Never fake a cached readback.
    text += `\n\nOMP card ${pending.stamp}`;
    if (text.length > TEXT_LIMIT || rows.length > 100 || rows.flat().some(button => button.text.length > 64)) {
      throw new DeliveryError("Dialog exceeds Telegram card limits; use the local OMP interface", "rejected");
    }
    return { text, reply_markup: { inline_keyboard: rows } };
  }

  async showApproval(approval: Approval): Promise<string> {
    const token = this.approvalToken(approval);
    const existing = this.approvalFlights.get(token);
    if (existing) return existing;
    const flight = this.approvalCard(approval);
    this.approvalFlights.set(token, flight);
    try { return await flight; }
    finally { this.approvalFlights.delete(token); }
  }

  private async approvalCard(approval: Approval): Promise<string> {
    this.assertRoute(approval.route);
    if (!this.handlers || approval.state !== "pending") throw new DeliveryError("Telegram approval is not pending on an active messenger", "rejected");
    const token = this.approvalToken(approval);
    const existing = this.pending.get(token);
    if (existing?.active && existing.verified && existing.messageId) {
      if (approval.remoteId && approval.remoteId !== existing.messageId) throw new DeliveryError("Telegram approval receipt conflict", "rejected");
      return existing.messageId;
    }
    let pending: Pending;
    let view: CardView;
    try {
      const dialog = parseDialog(approval.request);
      const saved = this.options.store.getMeta(this.stateKey(token));
      const progress: Progress = saved ? JSON.parse(saved) as Progress : { messageId: null, attempted: false, active: true, question: 0, answers: [], selected: [] };
      if (approval.remoteId && progress.messageId && approval.remoteId !== progress.messageId) throw new DeliveryError("Telegram approval receipt conflict", "rejected");
      if (saved && !progress.active && (progress.attempted || progress.messageId)) {
        // Native reconciliation precedes Gateway replay. Keep the exact answered
        // card closed while its durably admitted response awaits the replacement
        // head; rejecting here would cancel the native request before replay.
        // Neither an ordinary closed tombstone nor an ambiguous remote mutation
        // is authority to rehydrate a request, and no response body is retained.
        if (progress.messageId && progress.answerRequest === hash(JSON.stringify(approval.request)) &&
          this.options.store.hasPendingAnswer?.(approval.id, approval.route)) return progress.messageId;
        throw new DeliveryError("Telegram approval has already been answered or has an unresolved outcome", "uncertain");
      }
      const messageId = approval.remoteId ?? progress.messageId;
      if (messageId && this.options.store.getMeta(this.cardKey(approval.route, messageId)) === "closed") {
        throw new DeliveryError("Telegram approval receipt is closed", "uncertain");
      }
      pending = { ...progress, messageId: approval.remoteId ?? progress.messageId, approval: { ...approval, route: { ...approval.route } }, token, dialog,
        stamp: randomBytes(6).toString("hex"), busy: false, verified: false };
      if (pending.attempted && !pending.messageId) throw new DeliveryError("Telegram approval send outcome is unknown; refusing to resend", "uncertain");
      view = this.view(pending);
    } catch (error) {
      if (error instanceof DeliveryError && error.message !== "Dialog exceeds Telegram card limits; use the local OMP interface") throw error;
      // Never echo the request/title/prefill or parser errors (especially secret input).
      const notice = "Request cancelled: this dialog cannot safely be represented in Telegram. Use the local OMP interface.";
      try {
        await this.destination(approval.route);
        const message = approval.remoteId ? await this.api.editMessageText(approval.route.channelId, this.messageId(approval.remoteId), notice, { reply_markup: { inline_keyboard: [] }, link_preview_options: { is_disabled: true } }) :
          await this.api.sendMessage(approval.route.channelId, notice, { ...this.thread(approval.route), link_preview_options: { is_disabled: true }, allow_paid_broadcast: false });
        if (message === true) throw new DeliveryError("Telegram returned no authoritative card identity", "uncertain");
        this.assertReceipt(message, approval.route, approval.remoteId ?? undefined);
        this.options.store.setMeta(this.cardKey(approval.route, String(message.message_id)), "closed");
        await this.handlers.answer(approval.id, { cancelled: true }, approval.route);
        return String(message.message_id);
      } catch (failure) { throw telegramDeliveryError(failure); }
    }
    this.pending.set(token, pending);
    try {
      await this.destination(approval.route);
      pending.attempted = true;
      this.save(pending);
      const message = pending.messageId ? await this.api.editMessageText(approval.route.channelId, this.messageId(pending.messageId), view.text, {
        reply_markup: view.reply_markup, link_preview_options: { is_disabled: true },
      }) : await this.api.sendMessage(approval.route.channelId, view.text, {
        ...this.thread(approval.route), reply_markup: view.reply_markup, link_preview_options: { is_disabled: true }, allow_paid_broadcast: false,
      });
      if (message === true) throw new DeliveryError("Telegram returned no authoritative card identity", "uncertain");
      this.assertReceipt(message, approval.route, pending.messageId ?? undefined);
      if (!this.matchesControls(pending, message)) throw new DeliveryError("Telegram card response has unexpected controls", "uncertain");
      pending.messageId = String(message.message_id);
      this.options.store.setMeta(this.cardKey(approval.route, pending.messageId), "card");
      if (this.pending.get(token) !== pending || !pending.active) {
        this.save(pending);
        await this.dismissApproval({ ...approval, remoteId: pending.messageId });
        return pending.messageId;
      }
      pending.active = true; pending.verified = true; this.save(pending);
      return pending.messageId;
    } catch (error) {
      const safe = telegramDeliveryError(error);
      pending.active = false;
      // A known rejected initial send can be explicitly retried; an ambiguous
      // send or ANY edit failure must never fall back to a new message.
      if (!pending.messageId && safe.certainty === "rejected") { pending.attempted = false; pending.active = true; }
      this.save(pending); this.pending.delete(token);
      throw safe;
    }
  }

  private messageId(id: string): number {
    if (!integer(id) || Number(id) <= 0) throw new DeliveryError("Invalid Telegram card message ID", "rejected");
    return Number(id);
  }
  private matchesControls(pending: Pending, message: Message): boolean {
    const buttons = message.reply_markup?.inline_keyboard.flat() ?? [];
    return buttons.length > 0 && buttons.every(button => "callback_data" in button && button.callback_data.startsWith(`omp:${pending.token}:`));
  }
  private matchesCard(pending: Pending, message: Message): boolean {
    try { this.assertReceipt(message, pending.approval.route, pending.messageId ?? undefined); }
    catch { return false; }
    return this.matchesControls(pending, message);
  }
  private async refresh(pending: Pending): Promise<void> {
    if (!pending.active || !pending.messageId) return;
    const view = this.view(pending);
    try {
      const message = await this.api.editMessageText(pending.approval.route.channelId, this.messageId(pending.messageId), view.text, {
        reply_markup: view.reply_markup, link_preview_options: { is_disabled: true },
      });
      if (message === true || !this.matchesCard(pending, message)) throw new DeliveryError("Telegram returned an unexpected edited card", "uncertain");
    } catch (error) { if (!notModified(error)) throw telegramDeliveryError(error); }
  }
  private async finish(pending: Pending, response: DialogResponse, eventId: string): Promise<void> {
    pending.active = false; pending.lastUpdate = eventId;
    pending.answerRequest = hash(JSON.stringify(pending.approval.request)); this.save(pending);
    try { await this.handlers!.answer(pending.approval.id, response, pending.approval.route); }
    finally { await this.dismissApproval({ ...pending.approval, remoteId: pending.messageId }); }
  }

  private async callback(query: CallbackQuery): Promise<void> {
    const parsed = /^omp:([a-f0-9]{24}):([a-z]+[0-9]*(?:-[0-9]+)?)$/.exec(query.data ?? "");
    const pending = parsed ? this.pending.get(parsed[1]!) : undefined;
    const reject = async () => {
      try { await this.api.answerCallbackQuery(query.id, { text: "This request is expired, unauthorized, or already being handled." }); }
      catch (error) { this.report(telegramDeliveryError(error)); }
    };
    if (!parsed || query.from.is_bot || String(query.from.id) !== this.options.ownerId || !pending?.active || !pending.verified || pending.busy || !this.handlers ||
      !query.message || !("date" in query.message) || query.message.date === 0 || !this.matchesCard(pending, query.message as Message)) { await reject(); return; }
    this.assertRoute(pending.approval.route);
    const eventId = `callback:${query.id}`;
    if (pending.lastUpdate === eventId) { await reject(); return; }
    pending.busy = true;
    try {
      const action = parsed[2]!;
      const dialog = pending.dialog;
      if (action === "cancel") await this.finish(pending, { cancelled: true }, eventId);
      else if (dialog.method === "confirm" && (action === "yes" || action === "no")) await this.finish(pending, { confirmed: action === "yes" }, eventId);
      else if (dialog.method === "select" && /^pick-[0-9]+$/.test(action)) {
        const option = dialog.options[Number(action.slice(5))];
        if (option === undefined) { await reject(); return; }
        await this.finish(pending, { value: option }, eventId);
      } else if (dialog.method === "ask") {
        const question = dialog.questions[pending.question]!;
        const choice = new RegExp(`^q${pending.question}-([0-9]+)$`).exec(action);
        if (choice) {
          const option = question.options[Number(choice[1])];
          if (!option) { await reject(); return; }
          pending.selected = question.multi ? (pending.selected.includes(option.label) ? pending.selected.filter(value => value !== option.label) : [...pending.selected, option.label]) : [option.label];
          if (!question.multi) pending.customInput = undefined;
        } else if (action === `next-${pending.question}`) {
          pending.answers.push({ id: question.id, selectedOptions: [...pending.selected], ...(pending.customInput !== undefined ? { customInput: pending.customInput } : {}) });
          pending.question++; pending.selected = []; pending.customInput = undefined;
          if (pending.question === dialog.questions.length) { await this.finish(pending, { answers: pending.answers }, eventId); return; }
        } else { await reject(); return; }
        pending.lastUpdate = eventId; this.save(pending); await this.refresh(pending);
      } else { await reject(); return; }
      // Spinner acknowledgement follows durable/native processing, never before.
      try { await this.api.answerCallbackQuery(query.id); } catch (error) { this.report(telegramDeliveryError(error)); }
    } finally { pending.busy = false; }
  }

  async dismissApproval(approval: Approval): Promise<void> {
    this.assertRoute(approval.route);
    const token = this.approvalToken(approval);
    const pending = this.pending.get(token);
    if (pending) { pending.active = false; this.save(pending); }
    const saved = this.options.store.getMeta(this.stateKey(token));
    const progress = saved ? JSON.parse(saved) as Progress : undefined;
    const id = approval.remoteId ?? pending?.messageId ?? progress?.messageId;
    if (id) this.options.store.setMeta(this.cardKey(approval.route, id), "closed");
    if (progress) this.options.store.setMeta(this.stateKey(token), JSON.stringify({ ...progress, active: false, question: 0, answers: [], selected: [], customInput: undefined }));
    try {
      if (id) await this.api.editMessageReplyMarkup(approval.route.channelId, this.messageId(id), { reply_markup: { inline_keyboard: [] } });
    } catch (error) {
      if (!notModified(error) && !(code(error) === 400 && String(record(error).description).includes("message to edit not found"))) throw telegramDeliveryError(error);
    } finally { this.pending.delete(token); }
  }

  async createThread(route: Route, title: string, _sourceMessageId?: string): Promise<Route> {
    try {
      this.assertRoute(route);
      if (route.threadId !== null) throw new DeliveryError("Telegram cannot nest forum topics", "rejected");
      if (!title.trim() || [...title].length > 128) throw new DeliveryError("Telegram forum topic title must contain 1–128 characters", "rejected");
      const chat = await this.destination(route);
      if (!(chat.type === "supergroup" && chat.is_forum) && !(chat.type === "private" && this.me!.has_topics_enabled)) {
        throw new DeliveryError("Telegram destination does not support forum topics", "rejected");
      }
      const topic = await this.api.createForumTopic(route.channelId, title);
      if (!Number.isSafeInteger(topic.message_thread_id) || topic.message_thread_id <= 0) throw new DeliveryError("Telegram created an invalid forum topic identity", "uncertain");
      const { topicId: _topic, ...physical } = route;
      return { ...physical, threadId: String(topic.message_thread_id) };
    } catch (error) { throw telegramDeliveryError(error); }
  }

  /** No arbitrary history API: recovery is the durable offset (upstream retains at most 24 hours). */
  async fetchAfter(route: Route, _messageId: string): Promise<null> { this.assertRoute(route); return null; }

  async openAttachment(route: Route, attachment: Attachment, signal: AbortSignal): Promise<Response> {
    try {
      this.assertRoute(route);
      if (!/^[A-Za-z0-9_-]+$/.test(attachment.id) || attachment.url !== `telegram-file:${attachment.id}` || attachment.size > DOWNLOAD_LIMIT ||
        this.options.store.getMeta(this.fileKey(route, attachment.id)) !== JSON.stringify(attachment)) {
        throw new DeliveryError("Telegram attachment does not belong to an admitted message on this route", "rejected");
      }
      const file = await this.api.getFile(attachment.id, signal);
      const path = file.file_path;
      if (file.file_id !== attachment.id || (file.file_size !== undefined && file.file_size > DOWNLOAD_LIMIT) || !path ||
        !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(path) || path.split("/").some(segment => segment === "." || segment === "..")) {
        throw new DeliveryError("Telegram returned an unsafe or oversized file resource", "rejected");
      }
      // Token exists only in this immediate HTTPS request; never in ledger/errors.
      const url = `https://api.telegram.org/file/bot${this.options.token}/${path}`;
      const response = await this.http(url, { signal, redirect: "error" });
      if (response.redirected || (response.url && response.url !== url) || (response.status >= 300 && response.status < 400)) {
        throw new DeliveryError("Telegram file redirects or origin substitutions are forbidden", "rejected");
      }
      return response;
    } catch (error) { throw telegramDeliveryError(error); }
  }

  async stop(): Promise<void> {
    this.abort?.abort();
    await this.polling;
    this.polling = null; this.abort = null; this.handlers = null;
    this.pending.clear(); this.me = null;
  }
}
