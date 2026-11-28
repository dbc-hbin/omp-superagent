import { authorizeRoute, type Config } from "../config/config";
import { routeKey, type Route, type StorePort } from "../contracts";
import { groupRoom } from "../group/group-policy";

export function guildThreadParent(config: Config, source: Route, parent: Route): boolean {
  return config.discord?.allowCrossChannelThreads === true && config.discord.crossChannelThreadScope === "guild"
    && source.platform === "discord" && parent.platform === "discord" && source.guildId !== null
    && source.guildId === parent.guildId && source.accountId === parent.accountId && source.authorityId === parent.authorityId
    && source.channelId !== parent.channelId && parent.threadId === null && parent.topicId === undefined
    && authorizeRoute(config, source) && !groupRoom(config, parent);
}

export function discordWorkThreadKey(threadId: string): string {
  // Gateway reads the same exact source and thread receipt from SQLite.
  return `discord:work-thread:${threadId}`;
}

export function discordWorkThreadOwnerKey(inputId: string): string {
  return `discord:work-thread-owner:${inputId}`;
}

/** Read the exact placement receipt without making it current authorization. */
export function recordedDiscordWorkThreadSource(store: Pick<StorePort, "getMeta">, route: Route): Route | null {
  if (route.platform !== "discord" || !route.threadId || route.topicId !== undefined) return null;
  const saved = store.getMeta(discordWorkThreadKey(route.threadId));
  if (!saved) return null;
  const binding: { source: Route; route: Route } = JSON.parse(saved);
  return routeKey(binding.route) === routeKey(route) ? binding.source : null;
}

/** Delivery authority for a confirmed native lane thread, never request ingress. */
export function discordWorkThreadSource(config: Config, store: Pick<StorePort, "getMeta">, route: Route): Route | null {
  if (config.discord?.crossChannelThreadScope !== "guild" || config.discord.allowCrossChannelThreads !== true) return null;
  const source = recordedDiscordWorkThreadSource(store, route);
  return source && guildThreadParent(config, source, { ...route, threadId: null }) ? source : null;
}
