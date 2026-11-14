import { REST, Routes, type RESTOptions } from "discord.js";
import type { Config } from "./config";
import { loadCredentials, validateCredential } from "./credentials";
import { DISCORD_COMMANDS } from "./discord-commands";

type CommandRest = Pick<REST, "get" | "put">;

export interface DiscordCommandRegistrationOptions {
  apply?: boolean;
  createRest?: (options: Partial<RESTOptions>, token: string) => CommandRest;
}

interface Registration {
  id: string;
  application_id: string;
  type: number;
  name: string;
  description: string;
  [key: string]: unknown;
}

export interface DiscordCommandRegistrationReport {
  status: "dry-run" | "blocked" | "applied";
  applicationId: string;
  botId: string;
  plannedGlobal: typeof DISCORD_COMMANDS;
  currentGlobal: { id: string; type: number; name: string }[];
  obsoleteGlobal: { id: string; type: number; name: string }[];
  guilds: {
    guildId: string;
    registrations: { id: string; type: number; name: string }[];
    shadowing: { id: string; type: number; name: string }[];
  }[];
  note: string;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Malformed Discord response");
  return value as Record<string, unknown>;
}

function snowflake(value: unknown): string {
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw new Error("Malformed Discord identity");
  return value;
}

function registrations(value: unknown, applicationId: string, guildId?: string): Registration[] {
  if (!Array.isArray(value)) throw new Error("Malformed Discord command list");
  const ids = new Set<string>();
  const keys = new Set<string>();
  return value.map(item => {
    const row = object(item);
    const id = snowflake(row.id);
    if (row.application_id !== applicationId ||
        (guildId === undefined ? row.guild_id !== undefined : row.guild_id !== guildId) ||
        !Number.isInteger(row.type) || ![1, 2, 3, 4].includes(row.type as number) ||
        typeof row.name !== "string" || !row.name.length || row.name.length > 32 ||
        typeof row.description !== "string" ||
        (row.options !== undefined && !Array.isArray(row.options)))
      throw new Error("Malformed Discord command list");
    const key = `${row.type}:${row.name}`;
    if (ids.has(id) || keys.has(key)) throw new Error("Duplicate Discord registration");
    ids.add(id);
    keys.add(key);
    return row as Registration;
  });
}

function sortedNumbers(value: unknown, fallback: number[]): number[] {
  const values = value === undefined ? fallback : value;
  if (!Array.isArray(values) || !values.every(item => Number.isInteger(item)) ||
      new Set(values).size !== values.length) throw new Error("Malformed Discord command contexts");
  return [...values].sort((a, b) => a - b);
}

function localizations(value: unknown): Record<string, string> {
  if (value == null) return {};
  const entries = Object.entries(object(value));
  if (entries.some(([, text]) => typeof text !== "string")) throw new Error("Malformed Discord localization");
  return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b))) as Record<string, string>;
}

/** Keep semantic option fields, omitting only Discord's documented empty defaults. */
function commandOption(value: unknown): Record<string, unknown> {
  const row = object(value);
  if (!Number.isInteger(row.type) || typeof row.name !== "string" || typeof row.description !== "string")
    throw new Error("Malformed Discord command option");
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(row).sort()) {
    const item = row[key];
    if (item === undefined) continue;
    if ((key === "required" || key === "autocomplete") && item === false) continue;
    if (key === "name_localizations" || key === "description_localizations") {
      const values = localizations(item);
      if (Object.keys(values).length) result[key] = values;
    } else if (key === "options" || key === "choices" || key === "channel_types") {
      if (!Array.isArray(item)) throw new Error("Malformed Discord command option");
      if (item.length) result[key] = key === "options" ? item.map(commandOption) : item;
    } else {
      result[key] = item;
    }
  }
  return result;
}

function definition(value: unknown): Record<string, unknown> {
  const row = object(value);
  if (typeof row.name !== "string" || typeof row.description !== "string" ||
      (row.options !== undefined && !Array.isArray(row.options))) throw new Error("Malformed Discord definition");
  return {
    type: row.type ?? 1,
    name: row.name,
    description: row.description,
    options: ((row.options ?? []) as unknown[]).map(commandOption),
    contexts: sortedNumbers(row.contexts, [0, 1, 2]),
    integration_types: sortedNumbers(row.integration_types, [0]),
    name_localizations: localizations(row.name_localizations),
    description_localizations: localizations(row.description_localizations),
    default_member_permissions: row.default_member_permissions ?? null,
    default_permission: row.default_permission ?? true,
    nsfw: row.nsfw ?? false,
  };
}

function exactDefinitions(actual: Registration[]): boolean {
  const normalized = (commands: readonly unknown[]) => commands.map(definition)
    .sort((a, b) => `${a.type}:${a.name}`.localeCompare(`${b.type}:${b.name}`));
  return JSON.stringify(normalized(actual)) === JSON.stringify(normalized(DISCORD_COMMANDS));
}

/** REST-only opt-in. Never opens a Gateway, imports native OMP, or retries a mutation. */
export async function registerDiscordCommands(
  config: Config, options: DiscordCommandRegistrationOptions = {},
): Promise<DiscordCommandRegistrationReport> {
  if (!config.discord) throw new Error("discord-commands requires configured Discord credentials and policy");
  try {
    // Reuse the existing private sibling-file/environment policy, selecting Discord only.
    loadCredentials({ ...config, telegram: undefined, slack: undefined });
  } catch { throw new Error("Cannot safely load the configured Discord credential; details suppressed"); }
  const token = process.env[config.discord.tokenEnv];
  if (!token) throw new Error("Configured Discord credential is missing");
  try { validateCredential(token); }
  catch { throw new Error("Configured Discord credential is invalid; value suppressed"); }

  let rest: CommandRest;
  try {
    rest = (options.createRest ?? ((settings, credential) => new REST(settings).setToken(credential)))(
      { version: "10", retries: 0, rejectOnRateLimit: () => true }, token,
    );
  } catch { throw new Error("Discord REST initialization failed; details suppressed"); }

  let report: DiscordCommandRegistrationReport;
  let applicationId: string;
  try {
    const bot = object(await rest.get(Routes.user("@me")));
    const botId = snowflake(bot.id);
    if (bot.bot !== true) throw new Error("Discord identity is not a bot");
    const application = object(await rest.get(Routes.oauth2CurrentApplication()));
    applicationId = snowflake(application.id);
    if (applicationId !== botId ||
        (application.bot !== undefined && snowflake(object(application.bot).id) !== botId))
      throw new Error("Discord bot/application identity mismatch");
    const current = registrations(await rest.get(Routes.applicationCommands(applicationId)), applicationId);
    const supported = new Set(DISCORD_COMMANDS.map(command => `${command.type ?? 1}:${command.name}`));
    const summary = (rows: Registration[]) => rows.map(row => ({
      id: row.id, type: row.type,
      name: row.name.replaceAll(token, "[redacted]").replace(/https?:\/\/\S+/gi, "[redacted-url]"),
    }));
    const guilds: DiscordCommandRegistrationReport["guilds"] = [];
    for (const guildId of config.discord.allowedGuildIds) {
      const rows = registrations(await rest.get(Routes.applicationGuildCommands(applicationId, guildId)), applicationId, guildId);
      guilds.push({ guildId, registrations: summary(rows), shadowing: summary(rows.filter(row => supported.has(`${row.type}:${row.name}`))) });
    }
    report = {
      status: "dry-run", applicationId, botId, plannedGlobal: DISCORD_COMMANDS,
      currentGlobal: summary(current),
      obsoleteGlobal: summary(current.filter(row => !supported.has(`${row.type}:${row.name}`))),
      guilds,
      note: "Read-only plan. --apply takes exclusive ownership of this dedicated bot's GLOBAL command list, replacing it with supported Superagent definitions and deleting all other global registrations (including Hermes). Guild registrations are preserved; supported-name guild shadows block apply. No Gateway or native runtime was started.",
    };
  } catch {
    throw new Error("Discord command inspection failed: identity, permissions, or response could not be verified. No mutation was attempted; raw SDK details suppressed. No automatic retry was attempted.");
  }

  if (!options.apply) return report;
  if (report.guilds.some(guild => guild.shadowing.length)) {
    return { ...report, status: "blocked", note: "Apply refused: allowed-guild registrations shadow supported global commands. No mutation was attempted; all guild registrations are preserved. Resolve guild conflicts explicitly before applying." };
  }
  try {
    await rest.put(Routes.applicationCommands(applicationId), { body: DISCORD_COMMANDS });
  } catch {
    throw new Error("Discord global command overwrite is unresolved: the request failed and may have reached Discord. No automatic retry was attempted; raw SDK details suppressed. Inspect with discord-commands (without --apply) before deciding any further mutation.");
  }
  try {
    const actual = registrations(await rest.get(Routes.applicationCommands(applicationId)), applicationId);
    if (!exactDefinitions(actual)) throw new Error("Discord readback differs");
  } catch {
    throw new Error("Discord global command overwrite is unresolved: authoritative GET did not verify the exact supported definitions. No automatic retry was attempted; raw SDK details suppressed. Inspect with discord-commands (without --apply) before deciding any further mutation.");
  }
  return { ...report, status: "applied", note: "Global command overwrite verified by authoritative GET: exact supported Superagent names, types, descriptions, options, contexts, and guild-only installation. Obsolete global registrations were removed; guild registrations were not changed. No Gateway or native runtime was started." };
}
