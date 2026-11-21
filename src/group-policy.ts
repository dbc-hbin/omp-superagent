import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { Config } from "./config";
import type { Platform, Route } from "./contracts";

export const GROUP_MODEL_SELECTOR = /^([a-z][a-z0-9-]{0,62})\/([a-zA-Z0-9][a-zA-Z0-9._/-]{0,158})$/;

type GroupRoomScope = {
  readonly platform: Platform;
  readonly guildId: string;
  readonly channelId: string;
  readonly userIds: readonly string[];
  readonly dailyLimit: number;
};

type RoomMode = { readonly mode: "request" }
  | { readonly mode: "chat"; readonly model: string }
  | { readonly mode: "work"; readonly model: string; readonly repository: string };

export type GroupRoom = GroupRoomScope & RoomMode & { readonly revision: string };

export type GroupRequest = {
  readonly id: string;
  readonly route: Route;
  readonly messageId: string;
  readonly userId: string;
  readonly mode: GroupRoom["mode"];
  readonly revision: string;
  readonly text: string;
};

export type GroupReply = { readonly sourceId: string } & (
  { readonly outcome: "received" | "failed" | "interrupted" }
  | { readonly outcome: "finished"; readonly text?: string }
);

export function groupRoom(config: Config, route: Route): GroupRoom | undefined {
  return config.groupRooms?.find(room => room.platform === route.platform
    && room.guildId === route.guildId && room.channelId === route.channelId);
}

export function groupRoomKey(room: GroupRoomScope): string {
  return JSON.stringify([room.platform, room.guildId, room.channelId]);
}

export function parseGroupRooms(raw: unknown, config: Config, base: string): readonly GroupRoom[] {
  if (!Array.isArray(raw)) throw new Error("groupRooms must be an array");
  const seen = new Set<string>();
  return raw.map((value: unknown, index): GroupRoom => {
    const path = `groupRooms[${index}]`;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
    const { platform, guildId, channelId, userIds, mode, model, repository, dailyLimit, ...extra } =
      value as Record<string, unknown>;
    if (Object.keys(extra).length || typeof guildId !== "string" || typeof channelId !== "string"
      || typeof dailyLimit !== "number" || !Number.isSafeInteger(dailyLimit) || dailyLimit < 1) {
      throw new Error(`${path} requires exact platform, guildId, channelId and a positive dailyLimit`);
    }
    let userPattern: RegExp;
    switch (platform) {
      case "discord":
        if (!config.discord?.allowedGuildIds.includes(guildId) || !config.discord.allowedChannelIds.includes(channelId)
          || config.discord.voice?.textChannelId === channelId || config.discord.voice?.channelId === channelId) {
          throw new Error(`${path} must name an allowed Discord server and parent channel outside the voice configuration`);
        }
        userPattern = /^[1-9]\d{0,19}$/;
        break;
      case "telegram":
        if (guildId !== channelId || !config.telegram?.allowedChatIds.includes(channelId)) {
          throw new Error(`${path} must name an allowed Telegram group; guildId and channelId must be its same signed ID`);
        }
        userPattern = /^[1-9]\d{0,15}$/;
        break;
      case "slack":
        if (guildId !== config.slack?.teamId || !config.slack.allowedChannelIds.includes(channelId)) {
          throw new Error(`${path} must name an allowed Slack workspace and channel`);
        }
        userPattern = /^[UW][A-Z0-9]+$/;
        break;
      default:
        throw new Error(`${path}.platform must be discord, telegram, or slack`);
    }
    if (!Array.isArray(userIds) || !userIds.length || !userIds.every((id): id is string =>
      typeof id === "string" && userPattern.test(id) && (platform !== "telegram" || Number.isSafeInteger(Number(id))))) {
      throw new Error(`${path}.userIds must be a non-empty allowlist of stable platform user IDs`);
    }
    const scope = { platform, guildId, channelId, userIds: [...new Set(userIds)].sort(), dailyLimit };
    const key = groupRoomKey(scope);
    if (seen.has(key)) throw new Error(`${path} duplicates a group room`);
    seen.add(key);

    let policy: RoomMode;
    if (mode === "request") {
      if (model !== undefined || repository !== undefined) {
        throw new Error(`${path} request mode does not accept model or repository`);
      }
      policy = { mode };
    } else if (mode === "chat" || mode === "work") {
      if (typeof model !== "string" || !GROUP_MODEL_SELECTOR.test(model)) {
        throw new Error(`${path} ${mode} mode requires an exact provider/model`);
      }
      if (mode === "work") {
        if (typeof repository !== "string" || !repository.trim()) throw new Error(`${path}.repository is required for work`);
        const directory = realpathSync(resolve(base, repository));
        if (!statSync(directory).isDirectory()) throw new Error(`${path}.repository must point to a directory`);
        policy = { mode, model, repository: directory };
      } else {
        if (repository !== undefined) throw new Error(`${path} chat mode does not accept a repository`);
        policy = { mode, model };
      }
    } else {
      throw new Error(`${path}.mode must be request, chat, or work`);
    }
    const room = { ...scope, ...policy };
    return { ...room, revision: createHash("sha256").update(JSON.stringify(room)).digest("hex") };
  });
}
