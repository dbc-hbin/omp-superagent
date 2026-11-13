import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Platform, Route } from "./contracts";

export interface DiscordConfig {
  tokenEnv: string;
  ownerId: string;
  allowedGuildIds: string[];
  allowedChannelIds: string[];
}

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

export function credentialEnvNames(config: Config): string[] {
  return [...new Set([
    ...(config.discord ? [config.discord.tokenEnv] : []),
    ...(config.telegram ? [config.telegram.tokenEnv] : []),
    ...(config.slack ? [config.slack.botTokenEnv, config.slack.appTokenEnv] : []),
  ])];
}

export function requireMessengerCredentials(config: Config): void {
  for (const name of credentialEnvNames(config)) {
    if (!process.env[name]) throw new Error(`Missing messenger credential environment variable ${name}`);
  }
}

/** Configuration policy; each adapter additionally checks authenticated account identity. */
export function authorizeRoute(config: Config, route: Route): boolean {
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
  const raw = record(await Bun.file(absolute).json(), "config");
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
    throw new Error("command must be an argv array for the patched OMP executable");
  const headCwd = realpathSync(pathValue(raw.headCwd, "headCwd"));
  if (!lstatSync(headCwd).isDirectory()) throw new Error("headCwd must be a directory");
  const command = raw.command as string[];
  const maxHosts = integer(raw.maxHosts, "maxHosts", 2);
  const maxSubagents = integer(raw.maxSubagents, "maxSubagents", maxHosts);
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
      allowedChannelIds: ids(discord.allowedChannelIds, "discord.allowedChannelIds"),
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
