import type { Config } from "./config";
import { requireMessengerCredentials } from "./config";
import type { Approval, Attachment, Inbound, MessageActivity, MessageReference, Messenger, OutputRecord, Platform, Route, StorePort } from "./contracts";
import { physicalRouteKey } from "./contracts";
import { DeliveryError } from "./delivery";
import { DiscordMessenger } from "./discord";
import { SlackMessenger } from "./slack";
import { TelegramMessenger } from "./telegram";

/** One head; transports retain their own authenticated account and recovery state. */
export class MessengerHub implements Messenger {
  private readonly active: Messenger[] = [];
  private readonly activityQueues = new Map<string, Promise<void>>();
  private readonly thinkingMessages = new Set<string>();
  private started = false;

  constructor(private readonly adapters: Partial<Record<Platform, Messenger>>) {
    if (!Object.keys(adapters).length) throw new Error("At least one messenger is required");
  }

  private adapter(route: Route): Messenger {
    const adapter = this.adapters[route.platform];
    if (!adapter) throw new DeliveryError(`Messenger ${route.platform} is not configured`, "rejected");
    return adapter;
  }

  async start(handlers: Parameters<Messenger["start"]>[0]): Promise<void> {
    if (this.active.length) throw new Error("Messenger hub is already started");
    try {
      for (const [platform, adapter] of Object.entries(this.adapters) as [Platform, Messenger][]) {
        this.active.push(adapter);
        await adapter.start({
          ready: handlers.ready,
          message: async input => {
            if (input.route.platform !== platform) throw new Error("Messenger intake crossed platform boundaries");
            await handlers.message(input);
          },
          answer: async (approvalId, response, route) => {
            if (route.platform !== platform) throw new Error("Messenger approval crossed platform boundaries");
            await handlers.answer(approvalId, response, route);
          },
          reconnect: async () => {
            if (this.started) await handlers.reconnect?.();
          },
        });
      }
      this.started = true;
    } catch (error) {
      await this.stop().catch(() => {});
      throw error;
    }
  }

  send(output: OutputRecord): Promise<string> {
    return this.adapter(output.route).send(output);
  }
  async setActivity(message: MessageReference, activity: MessageActivity): Promise<void> {
    const key = JSON.stringify([physicalRouteKey(message.route), message.messageId]);
    const apply = async () => {
      // An edit is fresh ingress, but Telegram's single reaction must stay thinking.
      if (activity === "received" && this.thinkingMessages.has(key)) return;
      if (activity === "thinking") this.thinkingMessages.add(key);
      else if (activity === "idle") this.thinkingMessages.delete(key);
      await this.adapter(message.route).setActivity?.(message, activity);
    };
    const previous = this.activityQueues.get(key);
    // A later state is independent of an earlier failed cosmetic operation.
    const operation = previous ? previous.then(apply, apply) : apply();
    this.activityQueues.set(key, operation);
    try { await operation; }
    finally { if (this.activityQueues.get(key) === operation) this.activityQueues.delete(key); }
  }
  showApproval(approval: Approval): Promise<string> {
    return this.adapter(approval.route).showApproval(approval);
  }
  dismissApproval(approval: Approval): Promise<void> {
    return this.adapter(approval.route).dismissApproval(approval);
  }
  canCreateThread(route: Route): Promise<boolean> {
    return this.adapter(route).canCreateThread?.(route) ?? Promise.resolve(false);
  }
  createThread(route: Route, title: string, sourceMessageId?: string): Promise<Route> {
    return this.adapter(route).createThread(route, title, sourceMessageId);
  }
  fetchAfter(route: Route, messageId: string): Promise<Inbound[] | null> {
    return this.adapter(route).fetchAfter(route, messageId);
  }
  openAttachment(route: Route, attachment: Attachment, signal: AbortSignal): Promise<Response> {
    return this.adapter(route).openAttachment(route, attachment, signal);
  }
  async stop(): Promise<void> {
    this.started = false;
    await Promise.allSettled(this.activityQueues.values());
    const stopped = await Promise.allSettled(this.active.splice(0).reverse().map(adapter => adapter.stop()));
    const failed = stopped.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed.length) throw new AggregateError(failed.map(result => result.reason), "Messenger shutdown failed");
  }
}

export function createMessenger(config: Config, store: Pick<StorePort, "getMeta" | "setMeta">, onError: (error: unknown) => void): MessengerHub {
  requireMessengerCredentials(config);
  const adapters: Partial<Record<Platform, Messenger>> = {};
  if (config.discord) adapters.discord = new DiscordMessenger({
    ...config.discord, token: process.env[config.discord.tokenEnv]!, onError,
  });
  if (config.telegram) adapters.telegram = new TelegramMessenger({
    ...config.telegram, token: process.env[config.telegram.tokenEnv]!, store, onError,
  });
  if (config.slack) adapters.slack = new SlackMessenger({
    ...config.slack, botToken: process.env[config.slack.botTokenEnv]!,
    appToken: process.env[config.slack.appTokenEnv]!, onError,
  });
  return new MessengerHub(adapters);
}
