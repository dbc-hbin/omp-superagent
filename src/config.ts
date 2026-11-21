import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { physicalRoute, type Platform, type Route } from "./contracts";
import { resolveOmpCommand } from "./installed-omp";

export interface DiscordConfig {
  tokenEnv: string;
  ownerId: string;
  allowedGuildIds: string[];
  allowedChannelIds: string[];
  voice?: DiscordVoiceConfig;
}

type DiscordVoiceSessionConfig = {
  readonly channelId: string;
  readonly textChannelId: string;
  readonly voice: string;
  readonly maxSessionSeconds: number;
};

export type DiscordVoiceConfig = DiscordVoiceSessionConfig & (
  | {
      readonly auth?: "api";
      readonly apiKeyEnv: string;
      readonly model: string;
      readonly backendModel: string;
    }
  | {
      readonly auth: "subscription";
      readonly apiKeyEnv?: never;
      readonly model?: never;
      readonly backendModel?: never;
    }
);

export interface TelegramConfig {
  tokenEnv: string;
  ownerId: string;
  allowedChatIds: string[];
}

export interface SlackConfig {
  botTokenEnv: string;
  appTokenEnv: string;
  ownerId: string;
  teamId: string;
  allowedChannelIds: string[];
}

export interface Config {
  path: string;
  stateDir: string;
  headCwd: string;
  command: string[];
  maxHosts: number;
  maxSubagents: number;
  idleMs: number;
  model?: string;
  discord?: DiscordConfig;
  telegram?: TelegramConfig;
  slack?: SlackConfig;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value;
}
function integer(value: unknown, name: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error(`${name} must be an integer >= ${minimum}`);
  return value as number;
}
function ids(value: unknown, name: string, pattern = /^\d+$/): string[] {
  if (!Array.isArray(value) || !value.every(v => typeof v === "string" && pattern.test(v)))
    throw new Error(`${name} must be an array of valid platform IDs`);
  return [...new Set(value)];
}

function id(value: unknown, name: string, pattern: RegExp): string {
  const result = text(value, name);
  if (!pattern.test(result)) throw new Error(`${name} is not a valid platform ID`);
  return result;
}

function tokenEnv(value: unknown, name: string): string {
  const result = text(value, name);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(result)) throw new Error(`${name} must name an environment variable`);
  return result;
}

export function configuredPlatforms(config: Config): Platform[] {
  return (["discord", "telegram", "slack"] as const).filter(platform => config[platform] !== undefined);
}

export function voiceApiKeyEnv(config: Config): string | undefined {
  const voice = config.discord?.voice;
  switch (voice?.auth) {
    case "api":
    case undefined:
      return voice?.apiKeyEnv;
    case "subscription":
      return undefined;
  }
}

export function credentialEnvNames(config: Config): string[] {
  const voiceKey = voiceApiKeyEnv(config);
  return [...new Set([
    ...(config.discord ? [config.discord.tokenEnv] : []),
    ...(voiceKey === undefined ? [] : [voiceKey]),
    ...(config.telegram ? [config.telegram.tokenEnv] : []),
    ...(config.slack ? [config.slack.botTokenEnv, config.slack.appTokenEnv] : []),
  ])];
}

export function requireMessengerCredentials(config: Config): void {
  // Only an explicit API voice session needs its provider key, not text intake.
  const voiceKey = voiceApiKeyEnv(config);
  for (const name of credentialEnvNames(config)) {
    if (name === voiceKey) continue;
    if (!process.env[name]) throw new Error(`Missing messenger credential environment variable ${name}`);
  }
}

/** Configuration policy; each adapter additionally checks authenticated account identity. */
export function authorizeRoute(config: Config, route: Route): boolean {
  if (route.guildId !== null && route.topicId !== undefined
    && (route.platform === "telegram" || route.platform === "discord")) {
    return route.threadId === null && typeof route.topicId === "string" && route.topicId.length > 0 && route.topicId.length <= 128
      && authorizeRoute(config, physicalRoute(route));
  }
  if (!route.accountId || !route.channelId || !route.authorityId) return false;
  if (route.topicId !== undefined && (route.guildId !== null || route.threadId !== null || !route.topicId || route.topicId.length > 128)) return false;
  switch (route.platform) {
    case "discord": {
      const policy = config.discord;
      return !!policy && route.authorityId === policy.ownerId &&
        (route.guildId === null ? route.threadId === null :
          policy.allowedGuildIds.includes(route.guildId) && policy.allowedChannelIds.includes(route.channelId));
    }
    case "telegram": {
      const policy = config.telegram;
      return !!policy && route.authorityId === policy.ownerId &&
        (route.guildId === null ? route.channelId === policy.ownerId :
          route.guildId === route.channelId && policy.allowedChatIds.includes(route.channelId));
    }
    case "slack": {
      const policy = config.slack;
      return !!policy && route.authorityId === policy.ownerId &&
        route.accountId.startsWith(`${policy.teamId}:`) &&
        (route.guildId === null ? /^D[A-Z0-9]+$/.test(route.channelId) :
          route.guildId === policy.teamId && policy.allowedChannelIds.includes(route.channelId));
    }
  }
}

export async function loadConfig(path: string): Promise<Config> {
  const absolute = resolve(path);
  return parseConfig(await Bun.file(absolute).json(), absolute);
}

/** Validate an in-memory setup candidate with exactly the same policy as a saved config. */
export function parseConfig(value: unknown, path: string): Config {
  const absolute = resolve(path);
  const raw = record(value, "config");
  if (raw.modelPresets !== undefined)
    throw new Error("modelPresets belong to native OMP settings; initialize them through the head, not this application config");
  const discord = raw.discord === undefined ? undefined : record(raw.discord, "discord");
  const telegram = raw.telegram === undefined ? undefined : record(raw.telegram, "telegram");
  const slack = raw.slack === undefined ? undefined : record(raw.slack, "slack");
  if (!discord && !telegram && !slack) throw new Error("Configure at least one messenger: discord, telegram, or slack");
  const base = dirname(absolute);
  const pathValue = (v: unknown, key: string) => resolve(base, text(v, key));
  if (!Array.isArray(raw.command) || !raw.command.length ||
      !raw.command.every(v => typeof v === "string" && v.length > 0))
    throw new Error("command must be an argv array for an installed stock OMP executable");
  if (raw.command.some(v => /^(?:--session-settings|--rpc-socket|--model-preset)(?:=|$)/.test(v)) || raw.command[1] === "attach")
    throw new Error("command contains unsupported patched OMP arguments; configure an installed stock OMP executable");
  const headCwd = realpathSync(pathValue(raw.headCwd, "headCwd"));
  if (!lstatSync(headCwd).isDirectory()) throw new Error("headCwd must be a directory");
  const command = resolveOmpCommand(raw.command as string[], process.env.PATH, base);
  const maxHosts = integer(raw.maxHosts, "maxHosts", 2);
  const maxSubagents = integer(raw.maxSubagents, "maxSubagents", maxHosts);
  const discordChannels = discord ? ids(discord.allowedChannelIds, "discord.allowedChannelIds") : [];
  const voice = discord?.voice === undefined ? undefined : record(discord.voice, "discord.voice");
  let voiceConfig: DiscordVoiceConfig | undefined;
  if (voice) {
    const channelId = id(voice.channelId, "discord.voice.channelId", /^\d+$/);
    const textChannelId = id(voice.textChannelId, "discord.voice.textChannelId", /^\d+$/);
    if (textChannelId === channelId || !discordChannels.includes(textChannelId))
      throw new Error("discord.voice.textChannelId must be a separate, allowed text channel");
    const maxSessionSeconds = integer(voice.maxSessionSeconds, "discord.voice.maxSessionSeconds", 1);
    if (maxSessionSeconds * 1000 > 2 ** 31 - 1) throw new Error("discord.voice.maxSessionSeconds exceeds timer range");
    const session = { channelId, textChannelId, voice: text(voice.voice, "discord.voice.voice"), maxSessionSeconds };
    const auth = voice.auth;
    switch (auth) {
      case "subscription": {
        const unsupported = Object.keys(voice).find(key => key !== "auth" && !Object.hasOwn(session, key));
        if (unsupported !== undefined) throw new Error(`discord.voice.${unsupported} is not supported with subscription auth`);
        voiceConfig = { ...session, auth: "subscription" };
        break;
      }
      case "api":
      case undefined: {
        const apiKeyEnv = tokenEnv(voice.apiKeyEnv, "discord.voice.apiKeyEnv");
        if ([discord?.tokenEnv, telegram?.tokenEnv, slack?.appTokenEnv, slack?.botTokenEnv].includes(apiKeyEnv))
          throw new Error("discord.voice.apiKeyEnv must not name a messenger token");
        voiceConfig = {
          ...session, ...(auth === undefined ? {} : { auth }), apiKeyEnv,
          model: text(voice.model, "discord.voice.model"),
          backendModel: text(voice.backendModel, "discord.voice.backendModel"),
        };
        break;
      }
      default:
        throw new Error('discord.voice.auth must be "api" or "subscription"');
    }
  }
  return {
    path: absolute,
    stateDir: pathValue(raw.stateDir, "stateDir"),
    headCwd,
    command,
    maxHosts,
    maxSubagents,
    idleMs: integer(raw.idleMs, "idleMs", 0),
    ...(raw.model === undefined ? {} : { model: text(raw.model, "model") }),
    ...(discord ? { discord: {
      tokenEnv: tokenEnv(discord.tokenEnv, "discord.tokenEnv"),
      ownerId: id(discord.ownerId, "discord.ownerId", /^\d+$/),
      allowedGuildIds: ids(discord.allowedGuildIds, "discord.allowedGuildIds"),
      allowedChannelIds: discordChannels,
      ...(voiceConfig ? { voice: voiceConfig } : {}),
    } } : {}),
    ...(telegram ? { telegram: {
      tokenEnv: tokenEnv(telegram.tokenEnv, "telegram.tokenEnv"),
      ownerId: id(telegram.ownerId, "telegram.ownerId", /^[1-9]\d*$/),
      allowedChatIds: ids(telegram.allowedChatIds, "telegram.allowedChatIds", /^-\d+$/),
    } } : {}),
    ...(slack ? { slack: {
      botTokenEnv: tokenEnv(slack.botTokenEnv, "slack.botTokenEnv"),
      appTokenEnv: tokenEnv(slack.appTokenEnv, "slack.appTokenEnv"),
      ownerId: id(slack.ownerId, "slack.ownerId", /^[UW][A-Z0-9]+$/),
      teamId: id(slack.teamId, "slack.teamId", /^T[A-Z0-9]+$/),
      allowedChannelIds: ids(slack.allowedChannelIds, "slack.allowedChannelIds", /^[CG][A-Z0-9]+$/),
    } } : {}),
  };
}

/** No caller can turn a shared/symlink directory into a trusted socket directory. */
export function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid()))
    throw new Error(`Not an owned directory: ${path}`);
  chmodSync(path, 0o700);
}

export function hostPaths(config: Config, id: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid host ID");
  const socketPath = join(config.stateDir, "run", `${id}.sock`);
  if (Buffer.byteLength(socketPath) > 100) throw new Error("stateDir is too long for local Unix sockets; use a shorter private path");
  return {
    socketPath,
    sessionFile: join(config.stateDir, "sessions", id, "session.jsonl"),
    logPath: join(config.stateDir, "logs", `${id}.log`),
  };
}
