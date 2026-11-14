import { createHash } from "node:crypto";
import { LogLevel, WebClient, type WebClientOptions } from "@slack/web-api";
import { SocketModeClient } from "@slack/socket-mode";
import { physicalRoute, physicalRouteKey, routeKey, type Approval, type Attachment, type DialogResponse, type Inbound, type MessageActivity, type MessageReference, type Messenger, type OutputRecord, type Route } from "./contracts.ts";
import { parseDialog, type Dialog } from "./dialog.ts";
import { DeliveryError } from "./delivery.ts";
import { compareMessageIds } from "./message-order.ts";
import { parseSlackCommand } from "./slack-commands.ts";

type RecordValue = Record<string, unknown>;
type Handlers = Parameters<Messenger["start"]>[0];
type Socket = Pick<SocketModeClient, "on" | "off" | "start" | "disconnect">;
type Http = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type Envelope = { type: string; envelope_id?: string; body: RecordValue; accepts_response_payload?: boolean; ack(response?: unknown): Promise<void> };
type Block = RecordValue;
type Answer = NonNullable<DialogResponse["answers"]>[number];
interface Pending {
  approval: Approval; token: string; dialog: Dialog; messageId: string | null;
  active: boolean; question: number; answers: Answer[];
  selected: string[]; customInput?: string;
  modal?: { id: string; metadata: string; action: string };
}

export interface SlackMessengerOptions {
  botToken: string;
  appToken: string;
  ownerId: string;
  teamId: string;
  allowedChannelIds: string[];
  onError?: (error: unknown) => void;
  /** Supported WebClient HTTP boundary; retry and logging safety are not overridable. */
  webClientOptions?: Pick<WebClientOptions, "fetch" | "slackApiUrl">;
  /** Official SocketModeClient, or a deterministic SDK event boundary in tests. */
  socket?: Socket;
  /** External upload/download HTTP boundary; never used for Socket Mode bootstrap. */
  fetch?: Http;
}

const FILE_LIMIT = 8 * 1024 * 1024;
const TEXT_LIMIT = 3000;
const object = (value: unknown): value is RecordValue => !!value && typeof value === "object" && !Array.isArray(value);
const string = (value: unknown): value is string => typeof value === "string";
const timestamp = (value: unknown): value is string => string(value) && /^[0-9]{1,20}\.[0-9]{6}$/.test(value);
const slackId = (value: unknown): value is string => string(value) && /^[A-Z][A-Z0-9]+$/.test(value);
const hash = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 24);
const plain = (value: string) => ({ type: "plain_text", text: value || "(empty)", emoji: false });
const escapeText = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
// Slack reserves leading slash commands in its composer. These are ordinary
// authenticated owner messages, sharing the runtime's existing command parser,
// including the head's bare query and argument forms of /model, /effort, /stop,
// /compact, and the rest of the ordinary-text command surface.
// Only an exact first token converts; lookalikes such as "!models" stay plain text.
const controlText = (value: string): string => value.replace(/^!(new|main|stop|restart|resume|model|effort|help|status|context|compact|usage)(?=$|\s)/, "/$1");
const tokenFor = (approval: Approval): string => hash(JSON.stringify([approval.id, approval.generation, approval.target, approval.requestId, routeKey(approval.route)]));
const compare = (left: string, right: string): number => {
  const result = compareMessageIds("slack", left, right);
  if (result === null) throw new DeliveryError("Invalid Slack message timestamp", "rejected");
  return result;
};

/** SDK exceptions may contain request headers, payloads, or signed URLs. Never retain their cause. */
function failure(error: unknown): DeliveryError {
  if (error instanceof DeliveryError) return error;
  const record = object(error) ? error : {};
  const data = object(record.data) ? record.data : {};
  const code = string(data.error) && /^[a-z_]+$/.test(data.error) ? data.error : undefined;
  const retryAfter = typeof record.retryAfter === "number" && Number.isFinite(record.retryAfter) ? Math.max(0, record.retryAfter * 1000) : undefined;
  if (record.code === "slack_webapi_rate_limited_error") return new DeliveryError("Slack request rate limited", "rejected", retryAfter);
  if (record.code === "slack_webapi_platform_error" && code) {
    const uncertain = ["internal_error", "fatal_error", "request_timeout", "service_unavailable"].includes(code);
    return new DeliveryError(`Slack API rejected request: ${code}`, uncertain ? "uncertain" : "rejected");
  }
  const status = typeof record.statusCode === "number" ? record.statusCode : undefined;
  return new DeliveryError("Slack transport failed", status && status >= 400 && status < 500 && status !== 408 ? "rejected" : "uncertain");
}

function sections(text: string): Block[] {
  const chunks: string[] = [];
  // Split only at Unicode code-point boundaries. No user text is ever interpreted as mrkdwn.
  let chunk = "";
  for (const point of text || "(empty)") {
    if (chunk.length + point.length > TEXT_LIMIT) { chunks.push(chunk); chunk = ""; }
    chunk += point;
  }
  chunks.push(chunk);
  return chunks.map(value => ({ type: "section", text: plain(value) }));
}

/** Official WebClient/SocketMode SDKs own HTTP and WebSocket protocol handling. */
export class SlackMessenger implements Messenger {
  readonly client: WebClient;
  readonly socket: Socket;
  private accountId: string | null = null;
  private botUserId: string | null = null;
  private botId: string | null = null;
  private appId: string | null = null;
  private socketAppId: string | null = null;
  private handlers: Handlers | null = null;
  private connected = false;
  private intake: Promise<void> = Promise.resolve();
  private stopSignal = Promise.withResolvers<void>();
  private ready: Promise<boolean> = Promise.resolve(false);
  private readonly interactions = new Set<Promise<void>>();
  private readonly interactionQueues = new Map<string, Promise<void>>();
  private readonly interactionReceipts = new Map<string, Map<string, Promise<void>>>();
  private readonly pending = new Map<string, Pending>();
  private readonly channels: Set<string>;
  private readonly http: Http;
  private readonly report: (error: unknown) => void;
  private readonly onEnvelope = (envelope: Envelope) => {
    if (!this.appId || this.socketAppId !== this.appId) return;
    if (envelope.type === "interactive") {
      const task = this.queueInteraction(envelope).catch(error => this.report(failure(error)));
      this.interactions.add(task);
      void task.finally(() => { this.interactions.delete(task); });
      return;
    }
    this.intake = this.intake.then(async () => { if (await this.ready) await this.receive(envelope); }).catch(error => this.report(failure(error)));
  };
  private readonly onConnected = () => {
    if (!this.connected) return;
    this.intake = this.intake.then(async () => { if (await this.ready && this.socketAppId === this.appId) await this.handlers?.reconnect?.(); }).catch(error => this.report(failure(error)));
  };
  private readonly onWireMessage = (data: unknown, isBinary: boolean) => {
    if (isBinary || !string(data)) return;
    let value: unknown;
    try { value = JSON.parse(data); } catch { return; }
    if (!object(value) || value.type !== "hello") return;
    this.socketAppId = object(value.connection_info) && slackId(value.connection_info.app_id) ? value.connection_info.app_id : null;
    if (this.socketAppId !== this.appId) this.report(new Error("Slack Socket Mode application does not match the authenticated bot"));
  };
  private readonly onConnecting = () => { this.socketAppId = null; };
  private readonly onSocketError = () => { this.report(new Error("Slack Socket Mode transport failed")); };

  constructor(private readonly options: SlackMessengerOptions) {
    this.channels = new Set(options.allowedChannelIds);
    this.http = options.fetch ?? globalThis.fetch;
    this.report = options.onError ?? (error => console.error("Slack event failed:", error));
    // SDK debug/error payloads can contain tokens or request bodies. Only fixed,
    // credential-free transport diagnostics cross the logging boundary.
    const logger = {
      debug() {}, info() {}, warn() {}, error: () => this.onSocketError(),
      setLevel(_level: LogLevel) {}, getLevel: () => LogLevel.ERROR, setName(_name: string) {},
    };
    this.client = new WebClient(options.botToken, {
      ...options.webClientOptions, retryConfig: { retries: 0 }, rejectRateLimitedCalls: true,
      allowAbsoluteUrls: false, logger, teamId: options.teamId,
    });
    this.socket = options.socket ?? new SocketModeClient({
      appToken: options.appToken, logger,
      clientOptions: { retryConfig: { retries: 0 }, rejectRateLimitedCalls: true },
    });
  }

  private async api(method: string, args: RecordValue = {}): Promise<RecordValue> {
    try {
      const result = await this.client.apiCall(method, args);
      if (!result.ok) throw new DeliveryError("Slack API returned an unsuccessful result", "uncertain");
      if (result.response_metadata?.warnings?.includes("message_truncated")) throw new DeliveryError("Slack reports that published content was truncated", "uncertain");
      return result as unknown as RecordValue;
    } catch (error) { throw failure(error); }
  }

  async start(handlers: Handlers): Promise<void> {
    if (this.handlers) throw new Error("Slack messenger is already started");
    try {
      const identity = await this.api("auth.test");
      if (identity.team_id !== this.options.teamId || !slackId(identity.user_id) || !slackId(identity.bot_id)) throw new DeliveryError("Slack bot authentication does not match the configured workspace", "rejected");
      const botResult = await this.api("bots.info", { bot: identity.bot_id });
      const bot = botResult.bot;
      if (!object(bot) || bot.id !== identity.bot_id || bot.user_id !== identity.user_id || !slackId(bot.app_id)
        || (bot.team_id !== undefined && bot.team_id !== this.options.teamId)) throw new DeliveryError("Slack bot application identity could not be verified", "rejected");
      const ownerResult = await this.api("users.info", { user: this.options.ownerId });
      const owner = ownerResult.user;
      if (!object(owner) || owner.id !== this.options.ownerId || owner.team_id !== this.options.teamId || owner.is_bot !== false || owner.deleted === true || owner.is_app_user === true) throw new DeliveryError("Slack owner must be an active human in the configured workspace", "rejected");
      this.botUserId = identity.user_id;
      this.botId = identity.bot_id;
      this.appId = bot.app_id;
      this.accountId = `${this.options.teamId}:${this.botUserId}`;
      this.handlers = handlers;
      this.stopSignal = Promise.withResolvers<void>();
      const authenticatedSocket = Promise.withResolvers<void>();
      this.ready = Promise.race([
        Promise.all([handlers.ready ?? Promise.resolve(), authenticatedSocket.promise]).then(() => true),
        this.stopSignal.promise.then(() => false),
      ]).catch(error => { this.report(failure(error)); return false; });
      this.socket.on("slack_event", this.onEnvelope);
      this.socket.on("ws_message", this.onWireMessage);
      this.socket.on("connecting", this.onConnecting);
      this.socket.on("reconnecting", this.onConnecting);
      this.socket.on("disconnected", this.onConnecting);
      this.socket.on("connected", this.onConnected);
      this.socket.on("error", this.onSocketError);
      await this.socket.start();
      // apps.connections.open does not promise app_id. The SDK's public raw
      // event exposes hello.connection_info.app_id without private-field access.
      if (this.socketAppId !== this.appId) throw new DeliveryError("Slack Socket Mode application does not match the authenticated bot", "rejected");
      this.connected = true;
      authenticatedSocket.resolve();
    } catch (error) { await this.stop(); throw failure(error); }
  }

  private assertRoute(route: Route): void {
    if (!this.accountId || route.platform !== "slack" || route.accountId !== this.accountId || route.authorityId !== this.options.ownerId || !slackId(route.channelId) ||
      (route.threadId !== null && !timestamp(route.threadId)) ||
      (route.guildId !== null && (route.guildId !== this.options.teamId || !this.channels.has(route.channelId)))) throw new DeliveryError("Slack route is not authorized for this workspace, bot, and owner", "rejected");
  }

  private async destination(route: Route): Promise<void> {
    this.assertRoute(route);
    const response = await this.api("conversations.info", { channel: route.channelId });
    const channel = response.channel;
    if (!object(channel) || channel.id !== route.channelId || channel.is_mpim === true || channel.is_archived === true ||
      (channel.context_team_id !== undefined && channel.context_team_id !== this.options.teamId)) throw new DeliveryError("Slack destination identity is not authorized", "rejected");
    if (route.guildId === null) {
      if (channel.is_im !== true || channel.user !== this.options.ownerId) throw new DeliveryError("Slack direct message is not the configured owner's one-to-one DM", "rejected");
    } else if (channel.is_im === true || channel.is_member !== true) throw new DeliveryError("Slack bot must be a member of the configured channel", "rejected");
  }

  private async incomingRoute(channelId: string, threadId: string | null): Promise<Route | null> {
    if (!this.accountId) return null;
    // DMs are verified using conversations.info; an event's channel_type is not authority.
    const route: Route = { platform: "slack", accountId: this.accountId, authorityId: this.options.ownerId, guildId: channelId.startsWith("D") ? null : this.options.teamId, channelId, threadId };
    if (route.guildId !== null && !this.channels.has(channelId)) return null;
    await this.destination(route);
    return route;
  }

  private normalize(message: RecordValue, route: Route): (Inbound & MessageReference) | null {
    if (message.type !== "message" || message.user !== this.options.ownerId || message.bot_id || message.app_id ||
      (message.subtype !== undefined && message.subtype !== "file_share") || !timestamp(message.ts) ||
      (message.team !== undefined && message.team !== this.options.teamId) ||
      (message.user_team !== undefined && message.user_team !== this.options.teamId) ||
      (message.source_team !== undefined && message.source_team !== this.options.teamId) ||
      (message.text !== undefined && !string(message.text))) return null;
    if (message.thread_ts !== undefined && !timestamp(message.thread_ts)) return null;
    const threadId = timestamp(message.thread_ts) && message.thread_ts !== message.ts ? message.thread_ts : null;
    const actual = { ...route, threadId };
    const attachments: Attachment[] = [];
    for (const file of Array.isArray(message.files) ? message.files : []) {
      if (!object(file) || !slackId(file.id) || !file.id.startsWith("F") || file.user !== this.options.ownerId || file.is_external === true ||
        !string(file.name) || typeof file.size !== "number" || !Number.isSafeInteger(file.size) || file.size < 0) throw new DeliveryError("Slack message contains an unsupported or nonowner attachment; use the local OMP interface", "rejected");
      attachments.push({ id: file.id, name: file.name, url: `slack-file:${file.id}`, size: file.size, ...(string(file.mimetype) ? { contentType: file.mimetype } : {}) });
    }
    const edited = object(message.edited) ? message.edited : undefined;
    if (edited && (!timestamp(edited.ts) || edited.user !== this.options.ownerId)) return null;
    const revision = edited ? `edit:${edited.ts}:${hash(JSON.stringify([message.text ?? "", attachments.map(file => [file.id, file.name, file.size, file.contentType]).sort()]))}` : "original";
    return {
      id: `slack:${this.accountId}:${route.channelId}:${message.ts}:${revision}`,
      route: actual, messageId: message.ts, text: controlText((message.text as string | undefined) ?? ""),
      // Number is only a lossy display/age timestamp, never used to order Slack IDs.
      receivedAt: Number((edited?.ts as string | undefined) ?? message.ts) * 1000,
      attachments,
    };
  }

  private async receive(envelope: Envelope): Promise<void> {
    if (!this.appId || this.socketAppId !== this.appId) throw new DeliveryError("Slack Socket Mode application is not authorized", "rejected");
    const body = envelope.body;
    if (envelope.type === "slash_commands") { await this.receiveCommand(envelope); return; }
    if (envelope.type !== "events_api" || body.team_id !== this.options.teamId || (body.api_app_id !== undefined && body.api_app_id !== this.appId) || !object(body.event)) { await envelope.ack(); return; }
    const event = body.event;
    if (event.type !== "message" || !slackId(event.channel) || (event.channel_type !== undefined && !["im", "channel", "group"].includes(String(event.channel_type)))) { await envelope.ack(); return; }
    let message = event;
    if (event.subtype === "message_changed") {
      if (!object(event.message) || !object(event.message.edited)) { await envelope.ack(); return; }
      message = event.message;
    } else if (event.subtype !== undefined && event.subtype !== "file_share") { await envelope.ack(); return; }
    if (message.user !== this.options.ownerId || message.bot_id || message.app_id) { await envelope.ack(); return; }
    const route = await this.incomingRoute(event.channel, null);
    const input = route ? this.normalize(message, route) : null;
    if (input) await this.handlers!.message(input);
    // A failed durable admission deliberately leaves the envelope unacknowledged.
    await envelope.ack();
  }

  private async receiveCommand(envelope: Envelope): Promise<void> {
    const body = envelope.body;
    const refuse = async () => envelope.ack({ response_type: "ephemeral", text: "Superagent refused this command: use a configured command as the authorized owner in this app's workspace and an allowed channel or owner DM. Slash commands cannot target threads." });
    // Real Slack slash commands carry no message/thread identity. Neither the
    // opaque trigger nor a claimed channel name can supply those identities.
    if (body.team_id !== this.options.teamId || body.user_id !== this.options.ownerId || !this.appId
      || (body.api_app_id !== undefined && body.api_app_id !== this.appId)
      || (body.app_id !== undefined && body.app_id !== this.appId)
      || (body.bot_id !== undefined && body.bot_id !== this.botId)
      || !slackId(body.channel_id) || !string(body.trigger_id) || !body.trigger_id.length
      || !string(body.command) || !string(body.text)
      || ["ts", "message_ts", "thread_ts", "thread_id", "message", "container"].some(field => field in body)) { await refuse(); return; }
    const text = parseSlackCommand(body.command, body.text);
    if (text === null) { await refuse(); return; }
    let route: Route | null;
    try { route = await this.incomingRoute(body.channel_id, null); }
    catch { await refuse(); return; }
    if (!route) { await refuse(); return; }
    const invocationId = createHash("sha256").update(JSON.stringify([this.appId, this.options.teamId, this.options.ownerId, body.channel_id, body.trigger_id])).digest("hex");
    await this.handlers!.message({
      id: `slack:${this.accountId}:${body.channel_id}:invocation:${invocationId}`,
      route, messageId: null, invocationId, text, receivedAt: Date.now(), attachments: [],
    });
    // The receipt admits only. Results always use the ordinary durable outbox;
    // response_url, token, and trigger_id never cross the adapter boundary.
    await envelope.ack(envelope.accepts_response_payload ? { response_type: "ephemeral", text: "Superagent command admitted. The result will appear in this conversation." } : undefined);
  }

  private messagePayload(text: string, blocks = sections(text)): RecordValue {
    if (blocks.length > 50) throw new DeliveryError("Slack card exceeds 50 blocks; use the local OMP interface", "rejected");
    const fallback = escapeText(text || "(empty output)");
    // A long top-level text can be split by Slack. Omit it rather than truncate:
    // Slack's documented accessibility path derives fallback from plain blocks.
    return { ...(fallback.length <= TEXT_LIMIT ? { text: fallback } : {}), blocks, parse: "none", link_names: false };
  }

  private async post(route: Route, text: string, blocks?: Block[]): Promise<string> {
    const result = await this.api("chat.postMessage", { channel: route.channelId, ...(route.threadId ? { thread_ts: route.threadId } : {}), ...this.messagePayload(text, blocks), mrkdwn: false, unfurl_links: false, unfurl_media: false });
    if (result.channel !== route.channelId || !timestamp(result.ts)) throw new DeliveryError("Slack send has no authoritative destination receipt", "uncertain");
    return result.ts;
  }

  async send(output: OutputRecord): Promise<string> {
    await this.destination(output.route);
    if (Buffer.byteLength(output.text, "utf8") > FILE_LIMIT) throw new DeliveryError("Slack text output exceeds the safe 8 MiB upload limit", "rejected");
    if (output.text.length <= TEXT_LIMIT) return this.post(output.route, output.text);
    // No partial multi-message output. The external upload is unpublished until
    // completeUploadExternal; no deprecated files.upload or SDK mutation retries.
    const bytes = Buffer.from(output.text, "utf8");
    const filename = `omp-${hash(JSON.stringify([output.id, routeKey(output.route)]))}.txt`;
    const ticket = await this.api("files.getUploadURLExternal", { filename, length: bytes.byteLength });
    if (!slackId(ticket.file_id) || !ticket.file_id.startsWith("F") || !string(ticket.upload_url)) throw new DeliveryError("Slack returned an invalid upload ticket", "rejected");
    let upload: URL;
    try { upload = new URL(ticket.upload_url); } catch { throw new DeliveryError("Slack returned an invalid upload URL", "rejected"); }
    if (upload.protocol !== "https:" || upload.hostname !== "files.slack.com" || upload.username || upload.password || (upload.port && upload.port !== "443") || !upload.pathname.startsWith("/upload/v1/")) throw new DeliveryError("Slack returned an unauthorized upload URL", "rejected");
    try {
      const response = await this.http(upload, { method: "POST", body: bytes, redirect: "error", headers: { "Content-Type": "application/octet-stream" } });
      await response.body?.cancel();
      if (!response.ok) throw new DeliveryError("Slack file bytes were not accepted; publication was not attempted", "rejected");
    } catch { throw new DeliveryError("Slack file upload failed before publication was attempted", "rejected"); }
    const completed = await this.api("files.completeUploadExternal", {
      files: [{ id: ticket.file_id, title: filename }], channel_id: output.route.channelId,
      ...(output.route.threadId ? { thread_ts: output.route.threadId } : {}),
    });
    if (!Array.isArray(completed.files) || !completed.files.some(file => object(file) && file.id === ticket.file_id)) throw new DeliveryError("Slack file publication has no authoritative receipt", "uncertain");
    return `file:${ticket.file_id}`;
  }

  async setActivity(message: MessageReference, activity: MessageActivity): Promise<void> {
    if (!timestamp(message.messageId)) throw new DeliveryError("Activity requires a Slack message timestamp", "rejected");
    await this.destination(message.route);
    const args = { channel: message.route.channelId, timestamp: message.messageId, name: activity === "received" ? "eyes" : "thought_balloon" };
    try {
      if (activity === "idle") await this.client.reactions.remove(args);
      else await this.client.reactions.add(args);
    } catch (error) {
      if (object(error) && error.code === "slack_webapi_platform_error" && object(error.data) &&
        error.data.error === (activity === "idle" ? "no_reaction" : "already_reacted")) return;
      throw failure(error);
    }
  }

  private control(pending: Pending, action: string): string { return `omp:${pending.token}:${action}`; }
  private button(pending: Pending, action: string, label: string): RecordValue { return { type: "button", action_id: this.control(pending, action), text: plain(label), value: action }; }

  private validateDialog(dialog: Dialog): void {
    const labels: string[] = dialog.method === "select" ? dialog.options : dialog.method === "ask" ? dialog.questions.flatMap(question => question.options.map(option => option.label)) : [];
    if (labels.some(label => label.length > 75)) throw new DeliveryError("Slack choice labels exceed 75 characters; use the local OMP interface (labels cannot be truncated)", "rejected");
    if (dialog.method === "select" && (dialog.options.length > 100 || dialog.details.some(detail => detail && detail.length > 75))) throw new DeliveryError("Slack select exceeds native option limits; use the local OMP interface", "rejected");
    if (dialog.method === "ask" && dialog.questions.some(question => question.options.length > 100 || question.options.some(option => option.description && option.description.length > 75))) throw new DeliveryError("Slack ask exceeds native option limits; use the local OMP interface", "rejected");
    if ((dialog.method === "input" || dialog.method === "editor") && ((dialog.prefill?.length ?? 0) > 3000 || (dialog.placeholder?.length ?? 0) > 150)) throw new DeliveryError("Slack input exceeds native 3000-character input/150-character placeholder limits; use the local OMP interface", "rejected");
    if (Buffer.byteLength(JSON.stringify(dialog), "utf8") > 100 * 1024) throw new DeliveryError("Slack dialog exceeds the safe card size; use the local OMP interface", "rejected");
  }

  private view(pending: Pending): { text: string; blocks: Block[] } {
    const dialog = pending.dialog;
    let text: string;
    const controls: Block[] = [];
    let row = 0;
    const actions = (elements: RecordValue[]) => ({ type: "actions", block_id: this.control(pending, `row-${pending.question}-${row++}`), elements });
    const cancel = this.button(pending, "cancel", "Cancel");
    if (dialog.method === "confirm") {
      text = `${dialog.title}\n\n${dialog.message}`;
      controls.push(actions([this.button(pending, "yes", "Confirm"), this.button(pending, "no", "Decline"), cancel]));
    } else if (dialog.method === "input" || dialog.method === "editor") {
      text = `${dialog.title}\nRespond in the editor (not secret; maximum 3000 characters).`;
      controls.push(actions([this.button(pending, "open", "Respond"), cancel]));
    } else if (dialog.method === "select") {
      text = dialog.title;
      if (dialog.marker) text += `\n${dialog.options.map((label, index) => `${index < dialog.markableCount ? dialog.marker === "checkbox" ? dialog.checked.includes(index) ? "[x]" : "[ ]" : dialog.checked.includes(index) ? "(x)" : "( )" : "—"} ${label}${index === dialog.initialIndex ? " (initial focus)" : ""}`).join("\n")}\nChoose one row; OMP supplies the checked state on each request.`;
      controls.push(actions([{ type: "static_select", action_id: this.control(pending, "select"), placeholder: plain("Choose one option"), options: dialog.options.map((label, index) => ({ text: plain(label), value: String(index), ...(dialog.details[index] ? { description: plain(dialog.details[index]!) } : {}) })) }]), actions([cancel]));
    } else {
      const question = dialog.questions[pending.question]!;
      text = `Question ${pending.question + 1}/${dialog.questions.length}${question.header ? ` — ${question.header}` : ""}\n${question.question}\n${question.multi ? "Multiple answers allowed." : "Choose one option OR free text."}\n${question.options.map((option, index) => `${index + 1}. ${option.label}${index === question.recommended ? " (recommended, not preselected)" : ""}${option.preview ? `\n${option.preview}` : ""}`).join("\n")}${pending.customInput !== undefined ? `\nFree text: ${pending.customInput}` : ""}`;
      if (question.options.length) {
        const options = question.options.map((option, index) => ({ text: plain(option.label), value: String(index), ...(option.description ? { description: plain(option.description) } : {}) }));
        const selected = options.filter((_, index) => pending.selected.includes(question.options[index]!.label));
        controls.push(actions([{
          type: question.multi ? "multi_static_select" : "static_select", action_id: this.control(pending, `choose-${pending.question}`), placeholder: plain("Choose options"), options,
          ...(question.multi ? { ...(selected.length ? { initial_options: selected } : {}), max_selected_items: options.length } : selected[0] ? { initial_option: selected[0] } : {}),
        }]));
      }
      controls.push(actions([this.button(pending, `other-${pending.question}`, "Other / free text"), this.button(pending, `next-${pending.question}`, pending.question + 1 === dialog.questions.length ? "Submit all answers" : "Next question"), cancel]));
    }
    const blocks = [...sections(text), ...controls];
    // A compact correlation is required even on cards with no active controls.
    blocks[0] = { ...blocks[0], block_id: this.control(pending, "card") };
    this.messagePayload(text, blocks);
    if (text.length > 39000) throw new DeliveryError("Slack dialog exceeds the message text limit; use the local OMP interface", "rejected");
    return { text, blocks };
  }

  private async historyMessage(route: Route, messageId: string): Promise<RecordValue> {
    if (!timestamp(messageId)) throw new DeliveryError("Invalid Slack stored message timestamp", "rejected");
    if (!route.threadId || route.threadId === messageId) {
      const result = await this.api("conversations.history", { channel: route.channelId, oldest: messageId, latest: messageId, inclusive: true, limit: 1, include_all_metadata: true });
      const message = Array.isArray(result.messages) ? result.messages.find(value => object(value) && value.ts === messageId) : undefined;
      if (!object(message)) throw new DeliveryError("Slack stored message is not accessible in authoritative history", "rejected");
      return message;
    }
    const result = await this.api("conversations.replies", { channel: route.channelId, ts: route.threadId, oldest: messageId, latest: messageId, inclusive: true, limit: 2, include_all_metadata: true });
    const message = Array.isArray(result.messages) ? result.messages.find(value => object(value) && value.ts === messageId) : undefined;
    if (!object(message) || message.thread_ts !== route.threadId) throw new DeliveryError("Slack stored card is not in its original thread", "rejected");
    return message;
  }

  private assertCard(message: RecordValue, pending: Pending): void {
    if (message.ts !== pending.messageId || message.user !== this.botUserId || message.bot_id !== this.botId ||
      (message.team !== undefined && message.team !== this.options.teamId) ||
      (pending.approval.route.threadId ? message.thread_ts !== pending.approval.route.threadId : timestamp(message.thread_ts) && message.thread_ts !== message.ts) ||
      !Array.isArray(message.blocks) || !message.blocks.some(block => object(block) && block.block_id === this.control(pending, "card"))) throw new DeliveryError("Slack message is not the matching owned approval card", "rejected");
    for (const block of message.blocks) {
      if (!object(block)) continue;
      if (string(block.block_id) && block.block_id.startsWith("omp:") && !block.block_id.startsWith(`omp:${pending.token}:`)) throw new DeliveryError("Slack card correlation does not match the approval generation", "rejected");
      for (const element of Array.isArray(block.elements) ? block.elements : []) if (object(element) && string(element.action_id) && !element.action_id.startsWith(`omp:${pending.token}:`)) throw new DeliveryError("Slack card controls belong to another approval", "rejected");
    }
  }

  private async update(pending: Pending, inactive = false): Promise<void> {
    if (!pending.messageId) return;
    await this.destination(pending.approval.route);
    const message = await this.historyMessage(pending.approval.route, pending.messageId);
    this.assertCard(message, pending);
    const view = this.view(pending);
    const blocks = inactive ? view.blocks.filter(block => block.type !== "actions") : view.blocks;
    await this.api("chat.update", { channel: pending.approval.route.channelId, ts: pending.messageId, as_user: true, ...this.messagePayload(view.text, blocks) });
  }

  async showApproval(approval: Approval): Promise<string> {
    await this.destination(approval.route);
    if (!this.handlers || approval.state !== "pending") throw new DeliveryError("Slack approval is not pending on a started messenger", "rejected");
    const token = tokenFor(approval);
    const existing = this.pending.get(token);
    if (existing?.active && existing.messageId) {
      if (approval.remoteId && approval.remoteId !== existing.messageId) throw new DeliveryError("Slack approval receipt does not match its active card", "rejected");
      return existing.messageId;
    }
    for (const pending of this.pending.values()) if (pending.approval.id === approval.id) await this.dismissApproval(pending.approval);
    let dialog: Dialog;
    let initialView: { text: string; blocks: Block[] };
    try {
      dialog = parseDialog(approval.request);
      this.validateDialog(dialog);
      initialView = this.view({ approval, token, dialog, messageId: approval.remoteId, active: false, question: 0, answers: [], selected: [] });
    }
    catch {
      // No unsupported/secret question is silently left pending on the native host.
      const notice = "Request cancelled: this dialog cannot be represented safely in Slack. Use the local OMP interface; secret input is never collected here.";
      // An existing receipt cannot be safely edited without its original parsed
      // card; verify its identity with a minimal safe confirm view first.
      const rejected: Pending = { approval: { ...approval, route: { ...approval.route } }, token, dialog: { method: "confirm", title: "Request cancelled", message: notice }, messageId: approval.remoteId, active: false, question: 0, answers: [], selected: [] };
      if (rejected.messageId) await this.update(rejected, true);
      else rejected.messageId = await this.post(approval.route, notice, [{ type: "section", block_id: this.control(rejected, "card"), text: plain(notice) }]);
      await this.handlers.answer(approval.id, { cancelled: true }, rejected.approval.route);
      return rejected.messageId;
    }
    const pending: Pending = { approval: { ...approval, route: { ...approval.route } }, token, dialog, messageId: approval.remoteId, active: false, question: 0, answers: [], selected: [] };
    try {
      this.pending.set(token, pending);
      if (pending.messageId) await this.update(pending);
      else pending.messageId = await this.post(approval.route, initialView.text, initialView.blocks);
      pending.active = true;
      return pending.messageId;
    } catch (error) { this.pending.delete(token); throw failure(error); }
  }

  async dismissApproval(approval: Approval): Promise<void> {
    this.assertRoute(approval.route);
    const token = tokenFor(approval);
    let pending = this.pending.get(token);
    if (!pending && approval.remoteId) {
      let dialog: Dialog;
      try { dialog = parseDialog(approval.request); this.validateDialog(dialog); }
      catch { dialog = { method: "confirm", title: "Request closed", message: "Use the local OMP interface." }; }
      pending = { approval: { ...approval, route: { ...approval.route } }, token, dialog, messageId: approval.remoteId, active: false, question: 0, answers: [], selected: [] };
    }
    if (!pending) return;
    pending.active = false;
    pending.modal = undefined;
    try { await this.update(pending, true); }
    catch (error) {
      if (!(error instanceof DeliveryError) || !["Slack API rejected request: message_not_found", "Slack API rejected request: channel_not_found"].includes(error.message)) throw error;
    }
    this.pending.delete(token);
    this.interactionReceipts.delete(token);
  }

  private async finish(pending: Pending, response: DialogResponse): Promise<void> {
    // Claim locally before persistence/host I/O. An ambiguous callback cannot
    // unlock the card for another answer; runtime remains native authority.
    pending.active = false;
    pending.modal = undefined;
    try { await this.handlers!.answer(pending.approval.id, response, pending.approval.route); }
    finally { await this.dismissApproval(pending.approval); }
  }

  private async openModal(pending: Pending, action: string, trigger: unknown): Promise<void> {
    if (!string(trigger) || !trigger) throw new DeliveryError("Slack modal has no valid trigger", "rejected");
    if (pending.modal) return; // Replayed button cannot replace a still-open modal.
    const dialog = pending.dialog;
    const ask = dialog.method === "ask";
    const metadata = hash(JSON.stringify([pending.token, pending.messageId, pending.approval.route.channelId, action]));
    const prefill = ask ? pending.customInput : dialog.method === "input" || dialog.method === "editor" ? dialog.prefill : undefined;
    const placeholder = dialog.method === "input" || dialog.method === "editor" ? dialog.placeholder : undefined;
    const title = ask ? "Other answer" : "OMP response"; // Full original title remains on the linked card.
    const result = await this.api("views.open", { trigger_id: trigger, view: {
      type: "modal", callback_id: this.control(pending, action), private_metadata: metadata, notify_on_close: true,
      title: plain(title), submit: plain("Submit"), close: plain("Cancel"),
      blocks: [{ type: "input", block_id: "response", optional: true, label: plain("Response (not secret)"), element: {
        type: "plain_text_input", action_id: "value", multiline: dialog.method !== "input", max_length: 3000,
        ...(prefill !== undefined ? { initial_value: prefill } : {}), ...(placeholder ? { placeholder: plain(placeholder) } : {}),
      } }],
    } });
    if (!object(result.view) || !slackId(result.view.id)) throw new DeliveryError("Slack modal has no authoritative view receipt", "uncertain");
    pending.modal = { id: result.view.id, metadata, action };
  }

  private selection(action: RecordValue, options: string[], multi: boolean): string[] {
    const values = multi ? action.selected_options : action.selected_option === null ? [] : [action.selected_option];
    if (!Array.isArray(values) || (!multi && values.length > 1)) throw new DeliveryError("Invalid Slack selection", "rejected");
    const selected = values.map(value => {
      if (!object(value) || !string(value.value) || !/^(0|[1-9][0-9]*)$/.test(value.value)) throw new DeliveryError("Invalid Slack option index", "rejected");
      const label = options[Number(value.value)];
      if (label === undefined) throw new DeliveryError("Slack selected option is not in the original dialog", "rejected");
      return label;
    });
    if (new Set(selected).size !== selected.length) throw new DeliveryError("Duplicate Slack selected options", "rejected");
    return selected;
  }

  private async queueInteraction(envelope: Envelope): Promise<void> {
    if (!await this.ready) return; // Shutdown must leave unreconciled envelopes unacknowledged.
    const body = envelope.body;
    const view = object(body.view) ? body.view : {};
    const actions = Array.isArray(body.actions) ? body.actions : [];
    const action = object(actions[0]) ? actions[0] : {};
    const modal = body.type === "view_submission" || body.type === "view_closed";
    const control = modal ? view.callback_id : action.action_id;
    const parsed = string(control) ? /^omp:([a-f0-9]{24}):([a-z]+(?:-[0-9]+)?)$/.exec(control) : null;
    if (!parsed || !object(body.team) || body.team.id !== this.options.teamId || !object(body.user) || body.user.id !== this.options.ownerId ||
      (body.user.team_id !== undefined && body.user.team_id !== this.options.teamId)) { await envelope.ack(); return; }
    const token = parsed[1]!;
    // Use server event identity, never a choice-value fingerprint: selecting A,
    // then B, then A again are three different legitimate user interactions.
    const identity = modal && slackId(view.id) ? `view:${body.type}:${view.id}` : timestamp(action.action_ts) ? `action:${control}:${action.action_ts}` :
      string(envelope.envelope_id) && envelope.envelope_id ? `envelope:${envelope.envelope_id}` : null;
    const previous = this.interactionQueues.get(token) ?? Promise.resolve();
    // A failed UI refresh must not discard a later distinct selection or modal.
    // Revalidate card, generation, and current question when its turn arrives.
    const task: Promise<void> = previous.catch(() => {}).then(async () => {
      const duplicate = identity ? this.interactionReceipts.get(token)?.get(identity) : undefined;
      if (duplicate) { await duplicate; await envelope.ack(); return; }
      await this.interact(envelope, () => {
        if (!identity) return;
        let receipts = this.interactionReceipts.get(token);
        if (!receipts) { receipts = new Map(); this.interactionReceipts.set(token, receipts); }
        receipts.set(identity, task);
      });
    });
    this.interactionQueues.set(token, task);
    try { await task; }
    finally { if (this.interactionQueues.get(token) === task) this.interactionQueues.delete(token); }
  }

  private async interact(envelope: Envelope, claim: () => void): Promise<void> {
    const body = envelope.body;
    if (!object(body.team) || body.team.id !== this.options.teamId || !object(body.user) || body.user.id !== this.options.ownerId ||
      (body.user.team_id !== undefined && body.user.team_id !== this.options.teamId) || !this.handlers) { await envelope.ack(); return; }
    const modal = body.type === "view_submission" || body.type === "view_closed";
    const view = object(body.view) ? body.view : {};
    const actions = Array.isArray(body.actions) ? body.actions : [];
    const action = object(actions[0]) ? actions[0] : {};
    const control = modal ? view.callback_id : action.action_id;
    const parsed = string(control) ? /^omp:([a-f0-9]{24}):([a-z]+(?:-[0-9]+)?)$/.exec(control) : null;
    const pending = parsed ? this.pending.get(parsed[1]!) : undefined;
    if (!parsed || !pending?.active || (!modal && (body.type !== "block_actions" || actions.length !== 1))) { await envelope.ack(); return; }
    const actionName = parsed[2]!;
    if (modal) {
      if (!pending.modal || view.id !== pending.modal.id || view.private_metadata !== pending.modal.metadata || pending.modal.action !== actionName) { await envelope.ack(); return; }
    } else {
      const container = object(body.container) ? body.container : {};
      const channel = object(body.channel) ? body.channel : {};
      const message = object(body.message) ? body.message : {};
      if (container.type !== "message" || container.channel_id !== pending.approval.route.channelId || container.message_ts !== pending.messageId || channel.id !== pending.approval.route.channelId || message.ts !== pending.messageId) { await envelope.ack(); return; }
      try { this.assertCard(message, pending); }
      catch { await envelope.ack(); return; }
      const expectedType = actionName === "select" ? "static_select" : actionName.startsWith("choose-") && pending.dialog.method === "ask" && pending.dialog.questions[pending.question]?.multi ? "multi_static_select" : actionName.startsWith("choose-") ? "static_select" : "button";
      if (action.type !== expectedType) { await envelope.ack(); return; }
    }
    this.assertRoute(pending.approval.route);
    claim(); // Invalid/stale linkage must not poison a later genuine callback identity.
    {
      if (body.type === "view_closed") { pending.modal = undefined; await envelope.ack(); return; }
      const dialog = pending.dialog;
      if (!modal && ((actionName === "open" && (dialog.method === "input" || dialog.method === "editor")) || (dialog.method === "ask" && actionName === `other-${pending.question}`))) {
        await envelope.ack();
        await this.openModal(pending, dialog.method === "ask" ? `custom-${pending.question}` : "value", body.trigger_id);
        return;
      }
      // Native admission is durable before ACK for all final answers. Duplicate
      // deliveries wait behind the original operation and revalidate afterward.
      if (!modal && actionName === "cancel") { await this.finish(pending, { cancelled: true }); await envelope.ack(); return; }
      if (dialog.method === "confirm" && !modal && (actionName === "yes" || actionName === "no")) { await this.finish(pending, { confirmed: actionName === "yes" }); await envelope.ack(); return; }
      if (dialog.method === "select" && !modal && actionName === "select") {
        const selected = this.selection(action, dialog.options, false);
        if (selected.length !== 1) throw new DeliveryError("Slack select requires one original option", "rejected");
        await this.finish(pending, { value: selected[0]! }); await envelope.ack(); return;
      }
      let value: string | undefined;
      if (modal) {
        const state = object(view.state) ? view.state : {};
        const values = object(state.values) ? state.values : {};
        const response = object(values.response) ? values.response : {};
        const input = object(response.value) ? response.value : {};
        if (input.type !== "plain_text_input" || (input.value !== null && !string(input.value)) || (string(input.value) && input.value.length > 3000)) throw new DeliveryError("Malformed Slack modal input", "rejected");
        value = string(input.value) ? input.value : "";
      }
      if ((dialog.method === "input" || dialog.method === "editor") && modal && actionName === "value") { await this.finish(pending, { value: value! }); await envelope.ack(); return; }
      if (dialog.method === "ask") {
        const question = dialog.questions[pending.question]!;
        if (!modal && actionName === `choose-${pending.question}`) {
          pending.selected = this.selection(action, question.options.map(option => option.label), !!question.multi);
          if (!question.multi && pending.selected.length) pending.customInput = undefined;
        } else if (modal && actionName === `custom-${pending.question}`) {
          pending.customInput = value || undefined;
          pending.modal = undefined;
          if (!question.multi && pending.customInput !== undefined) pending.selected = [];
        } else if (!modal && actionName === `next-${pending.question}`) {
          pending.answers.push({ id: question.id, selectedOptions: [...pending.selected], ...(pending.customInput !== undefined ? { customInput: pending.customInput } : {}) });
          if (pending.question + 1 === dialog.questions.length) { await this.finish(pending, { answers: pending.answers }); await envelope.ack(); return; }
          pending.question++;
          pending.selected = [];
          pending.customInput = undefined;
          pending.modal = undefined;
        } else { await envelope.ack(); return; }
        await envelope.ack();
        await this.update(pending);
        return;
      }
      await envelope.ack();
    }
  }

  /** History is queried only for runtime's stored routes and cursors. No workspace scans. */
  async fetchAfter(route: Route, messageId: string): Promise<Inbound[]> {
    if (!timestamp(messageId)) throw new DeliveryError("Slack catchup requires a stored exact message timestamp", "rejected");
    await this.destination(route);
    const messages: RecordValue[] = [];
    let cursor: string | undefined;
    let boundary = messageId;
    let latest: string | undefined;
    const seenCursors = new Set<string>();
    for (;;) {
      const result = await this.api(route.threadId ? "conversations.replies" : "conversations.history", {
        channel: route.channelId, ...(route.threadId ? { ts: route.threadId } : {}),
        oldest: boundary, ...(latest ? { latest } : {}), inclusive: false, limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      if (result.is_limited === true || !Array.isArray(result.messages)) throw new DeliveryError("Slack history is incomplete or retention-limited", "rejected");
      const page = result.messages.filter(object);
      if (page.length !== result.messages.length || page.some(message => !timestamp(message.ts))) throw new DeliveryError("Slack returned malformed history", "rejected");
      messages.push(...page);
      const metadata = object(result.response_metadata) ? result.response_metadata : {};
      const next = string(metadata.next_cursor) ? metadata.next_cursor.trim() : "";
      if (next) {
        if (seenCursors.has(next)) throw new DeliveryError("Slack history pagination cursor did not advance", "rejected");
        seenCursors.add(next); cursor = next; continue;
      }
      cursor = undefined;
      if (result.has_more !== true) break;
      // Slack also supports time pagination. Replies are oldest-first; channel
      // history newest-first. Never use Number(timestamp) to choose boundaries.
      if (!page.length) throw new DeliveryError("Slack history claimed more messages without an advancing page", "rejected");
      const ordered = page.map(message => message.ts as string).sort(compare);
      if (route.threadId) {
        const nextBoundary = ordered[ordered.length - 1]!;
        if (compare(nextBoundary, boundary) <= 0) throw new DeliveryError("Slack reply pagination did not advance", "rejected");
        boundary = nextBoundary;
      } else {
        const nextLatest = ordered[0]!;
        if ((latest && compare(nextLatest, latest) >= 0) || compare(nextLatest, messageId) <= 0) throw new DeliveryError("Slack history pagination did not advance", "rejected");
        latest = nextLatest;
      }
    }
    const inputs = new Map<string, Inbound & MessageReference>();
    for (const message of messages) {
      if (compare(message.ts as string, messageId) <= 0) continue;
      const input = this.normalize(message, route);
      if (input && physicalRouteKey(input.route) === physicalRouteKey(route)) inputs.set(input.id, input);
    }
    return [...inputs.values()].sort((left, right) => compare(left.messageId, right.messageId));
  }

  /** Slack roots in an authenticated channel or owner DM support thread_ts. */
  async canCreateThread(route: Route): Promise<boolean> {
    this.assertRoute(route);
    if (route.threadId !== null) return false;
    await this.destination(route);
    return true;
  }

  async createThread(route: Route, title: string, sourceMessageId?: string): Promise<Route> {
    await this.destination(route);
    if (route.threadId) throw new DeliveryError("Slack cannot nest conversation threads", "rejected");
    if (!title.trim() || title.length > TEXT_LIMIT) throw new DeliveryError("Slack thread title must contain 1–3000 characters", "rejected");
    if (sourceMessageId) {
      const source = await this.historyMessage(route, sourceMessageId);
      if (source.type !== "message" || source.user !== this.options.ownerId || source.bot_id || source.app_id ||
        (source.subtype !== undefined && source.subtype !== "file_share") ||
        (source.thread_ts !== undefined && source.thread_ts !== source.ts) ||
        (source.team !== undefined && source.team !== this.options.teamId) ||
        (source.user_team !== undefined && source.user_team !== this.options.teamId) ||
        (source.source_team !== undefined && source.source_team !== this.options.teamId)) throw new DeliveryError("Slack thread source is not an authorized owner root message", "rejected");
      return { ...physicalRoute(route), threadId: sourceMessageId };
    }
    return { ...physicalRoute(route), threadId: await this.post(route, title) };
  }

  async openAttachment(route: Route, attachment: Attachment, signal: AbortSignal): Promise<Response> {
    await this.destination(route);
    if (!/^F[A-Z0-9]+$/.test(attachment.id) || attachment.url !== `slack-file:${attachment.id}`) throw new DeliveryError("Slack attachment reference is not an authorized file ID", "rejected");
    const result = await this.api("files.info", { file: attachment.id });
    const file = result.file;
    if (!object(file) || file.id !== attachment.id || file.user !== this.options.ownerId || file.mode !== "hosted" || file.is_external !== false || file.file_access === "check_file_info" ||
      (file.team_id !== undefined && file.team_id !== this.options.teamId)) throw new DeliveryError("Slack file is not an owned hosted workspace attachment", "rejected");
    const shares = object(file.shares) ? file.shares : {};
    const allowedShares = [shares.public, shares.private].filter(object).flatMap(group => Array.isArray(group[route.channelId]) ? group[route.channelId] as unknown[] : []);
    if (!allowedShares.some(share => object(share) && share.team_id === this.options.teamId && timestamp(share.ts) &&
      (route.threadId ? share.thread_ts === route.threadId || share.ts === route.threadId : share.thread_ts === undefined || share.thread_ts === share.ts))) throw new DeliveryError("Slack file has no authoritative share in the original destination", "rejected");
    const value = file.url_private_download ?? file.url_private;
    let url: URL;
    try { url = new URL(string(value) ? value : ""); } catch { throw new DeliveryError("Slack file has no valid private download URL", "rejected"); }
    const path = `/files-pri/${this.options.teamId}-${attachment.id}/`;
    if (url.protocol !== "https:" || url.hostname !== "files.slack.com" || url.username || url.password || (url.port && url.port !== "443") || !url.pathname.startsWith(path) || url.hash || /%(?:2f|5c|2e)/i.test(url.pathname)) throw new DeliveryError("Slack private file URL is not on the allowed workspace/file path", "rejected");
    try { return await this.http(url, { signal, redirect: "error", headers: { Authorization: `Bearer ${this.options.botToken}` } }); }
    catch { throw new DeliveryError("Slack private attachment download failed", "rejected"); }
  }

  async stop(): Promise<void> {
    this.connected = false;
    this.stopSignal.resolve();
    this.socket.off("slack_event", this.onEnvelope);
    this.socket.off("ws_message", this.onWireMessage);
    this.socket.off("connecting", this.onConnecting);
    this.socket.off("reconnecting", this.onConnecting);
    this.socket.off("disconnected", this.onConnecting);
    this.socket.off("connected", this.onConnected);
    this.socket.off("error", this.onSocketError);
    await this.intake;
    await Promise.all(this.interactions);
    this.interactionQueues.clear();
    this.interactionReceipts.clear();
    for (const pending of this.pending.values()) pending.active = false;
    this.pending.clear();
    this.handlers = null;
    this.accountId = this.botUserId = this.botId = this.appId = this.socketAppId = null;
    try { await this.socket.disconnect(); } catch { this.onSocketError(); }
  }
}
