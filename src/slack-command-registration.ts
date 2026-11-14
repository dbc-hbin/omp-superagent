import { LogLevel, WebClient, type WebClientOptions } from "@slack/web-api";
import type { Config } from "./config";
import { readCredentialFile, validateCredential } from "./credentials";
import { SLACK_COMMANDS } from "./slack-commands";

export interface SlackCommandClient {
  auth: Pick<WebClient["auth"], "test">;
  bots: Pick<WebClient["bots"], "info">;
  apps: { manifest: Pick<WebClient["apps"]["manifest"], "export" | "validate" | "update"> };
}

export interface SlackCommandRegistrationOptions {
  apply?: boolean;
  /** Explicit app-configuration credential, from this environment name or the sibling private credential file. */
  manifestTokenEnv: string;
  createWebClient?: (token: string, options: WebClientOptions) => SlackCommandClient;
}

export interface SlackCommandRegistrationReport {
  status: "dry-run" | "applied";
  teamId: string;
  botId: string;
  botUserId: string;
  appId: string;
  currentCommands: string[];
  obsoleteCommands: string[];
  plannedCommands: typeof SLACK_COMMANDS;
  changed: boolean;
  updated: boolean;
  manifestReadbackMatched: boolean;
  commandsGrant: "granted" | "missing" | "unknown";
  requiresReinstall: boolean | null;
  permissionsUpdated: boolean | null;
  note: string;
}

type ObjectValue = Record<string, unknown>;
type Manifest = Parameters<WebClient["apps"]["manifest"]["update"]>[0]["manifest"];
const object = (value: unknown): value is ObjectValue => !!value && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown, prefix: string): value is string => typeof value === "string" && new RegExp(`^${prefix}[A-Z0-9]+$`).test(value);
const envName = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);

function exportedManifest(value: unknown): Manifest {
  if (!object(value) || !object(value.display_information) || typeof value.display_information.name !== "string" ||
    !value.display_information.name || !object(value.settings) || value.settings.socket_mode_enabled !== true) throw new Error("Invalid Socket Mode manifest");
  for (const key of ["features", "oauth_config"] as const) {
    if (value[key] !== undefined && !object(value[key])) throw new Error("Invalid manifest object");
  }
  if (object(value.oauth_config) && value.oauth_config.scopes !== undefined && !object(value.oauth_config.scopes)) throw new Error("Invalid scopes");
  const scopes = object(value.oauth_config) && object(value.oauth_config.scopes) ? value.oauth_config.scopes : {};
  if (scopes.bot !== undefined && (!Array.isArray(scopes.bot) || !scopes.bot.every(scope => typeof scope === "string"))) throw new Error("Invalid bot scopes");
  const commands = object(value.features) ? value.features.slash_commands : undefined;
  if (commands !== undefined && (!Array.isArray(commands) || !commands.every(command => object(command) &&
    typeof command.command === "string" && /^\/[a-z0-9_-]{1,31}$/.test(command.command) && typeof command.description === "string"))) throw new Error("Invalid command list");
  return structuredClone(value) as Manifest;
}

// These are disabled/empty API defaults, not a blanket removal of false or empty
// values: unknown future fields and function/workflow definitions remain exact.
const emptyDefaults: Record<string, unknown> = {
  "_metadata.major_version": 1,
  "display_information.description": "", "display_information.long_description": "",
  "features.app_home.home_tab_enabled": false, "features.app_home.messages_tab_enabled": false,
  "features.app_home.messages_tab_read_only_enabled": false, "features.bot_user.always_online": false,
  "features.slash_commands.*.should_escape": false, "features.slash_commands.*.usage_hint": "", "features.slash_commands.*.url": "",
  "settings.org_deploy_enabled": false, "settings.token_rotation_enabled": false, "settings.is_hosted": false,
  "settings.interactivity.is_enabled": false, "settings.incoming_webhooks.incoming_webhooks_enabled": false,
};
const unordered = new Set([
  "oauth_config.redirect_urls", "oauth_config.scopes.bot", "oauth_config.scopes.user",
  "oauth_config.scopes.bot_optional", "oauth_config.scopes.user_optional",
  "settings.allowed_ip_address_ranges", "settings.event_subscriptions.bot_events", "settings.event_subscriptions.user_events",
  "features.unfurl_domains",
]);
const emptyContainers = new Set([
  "_metadata", "features", "features.app_home", "features.slash_commands", "features.shortcuts", "features.workflow_steps",
  "oauth_config", "oauth_config.scopes", "settings", "settings.event_subscriptions", "settings.interactivity", "settings.incoming_webhooks",
]);

function normalized(value: unknown, path = ""): unknown {
  if (Object.hasOwn(emptyDefaults, path) && value === emptyDefaults[path]) return undefined;
  if (Array.isArray(value)) {
    const result = value.map(item => normalized(item, `${path}.*`));
    if (!result.length && (unordered.has(path) || emptyContainers.has(path))) return undefined;
    if (unordered.has(path) || path === "features.slash_commands") result.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    return result;
  }
  if (!object(value)) return value;
  const result: ObjectValue = {};
  for (const key of Object.keys(value).sort()) {
    const item = normalized(value[key], path ? `${path}.${key}` : key);
    if (item !== undefined) result[key] = item;
  }
  return !Object.keys(result).length && emptyContainers.has(path) ? undefined : result;
}

function exact(actual: Manifest, expected: Manifest): boolean {
  return JSON.stringify(normalized(actual)) === JSON.stringify(normalized(expected));
}

function redact<T>(value: T, secrets: string[]): T {
  if (typeof value === "string") return secrets.reduce((text, secret) => text.replaceAll(secret, "[redacted]"), value)
    .replace(/(?:https?|wss?):\/\/\S+/gi, "[redacted-url]") as T;
  if (Array.isArray(value)) return value.map(item => redact(item, secrets)) as T;
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, secrets)])) as T;
  return value;
}

/** Official API only. No socket, runtime activation, token parsing, or automatic retries. */
export async function registerSlackCommands(
  config: Config, options: SlackCommandRegistrationOptions,
): Promise<SlackCommandRegistrationReport> {
  const policy = config.slack;
  if (!policy) throw new Error("slack-commands requires configured Slack credentials and policy");
  if (!envName(options.manifestTokenEnv)) throw new Error("slack-commands requires --manifest-token-env NAME naming an app configuration credential");
  if (!envName(policy.botTokenEnv) || !id(policy.teamId, "T")) throw new Error("Invalid Slack bot credential name or workspace policy");
  let botToken: string;
  let manifestToken: string;
  try {
    // Resolve only the bot and explicitly selected configuration credential. Never
    // load Discord, Telegram, the Socket Mode app token, or unrelated dotenv keys.
    const file = !process.env[policy.botTokenEnv] || !process.env[options.manifestTokenEnv] ? readCredentialFile(config.path) : undefined;
    botToken = process.env[policy.botTokenEnv] || file?.values[policy.botTokenEnv] || "";
    manifestToken = process.env[options.manifestTokenEnv] || file?.values[options.manifestTokenEnv] || "";
  } catch { throw new Error("Cannot safely load configured Slack credentials; details suppressed"); }
  if (!botToken) throw new Error("Configured Slack bot credential is missing");
  if (!manifestToken) throw new Error("Explicit Slack app configuration credential is missing; set the named environment variable or its private sibling credential entry");
  try { validateCredential(botToken); validateCredential(manifestToken); }
  catch { throw new Error("Configured Slack credential is invalid; values suppressed"); }

  let bot: SlackCommandClient;
  let app: SlackCommandClient;
  try {
    const logger = { debug() {}, info() {}, warn() {}, error() {}, setLevel(_level: LogLevel) {}, getLevel: () => LogLevel.ERROR, setName(_name: string) {} };
    const settings: WebClientOptions = { retryConfig: { retries: 0 }, rejectRateLimitedCalls: true, allowAbsoluteUrls: false, logger };
    const create = options.createWebClient ?? ((token, settings) => new WebClient(token, settings));
    bot = create(botToken, { ...settings, teamId: policy.teamId });
    app = create(manifestToken, settings);
  } catch { throw new Error("Slack API initialization failed; details suppressed"); }

  let teamId: string;
  let botId: string;
  let botUserId: string;
  let appId: string;
  let current: Manifest;
  let commandsGrant: SlackCommandRegistrationReport["commandsGrant"] = "unknown";
  try {
    const identity = await bot.auth.test();
    if (identity.ok !== true || identity.team_id !== policy.teamId || !id(identity.bot_id, "B") || !id(identity.user_id, "[UW]")) throw new Error("Wrong bot identity");
    const result = await bot.bots.info({ bot: identity.bot_id, team_id: policy.teamId });
    if (result.ok !== true || !result.bot || result.bot.id !== identity.bot_id || result.bot.user_id !== identity.user_id ||
      result.bot.deleted === true || !id(result.bot.app_id, "A") || (identity.app_id !== undefined && identity.app_id !== result.bot.app_id)) throw new Error("Wrong app identity");
    teamId = identity.team_id;
    botId = identity.bot_id;
    botUserId = identity.user_id;
    appId = result.bot.app_id;
    // The SDK obtains this from Slack's x-oauth-scopes response header, not the
    // manifest's requested scopes (which say nothing about installed grants).
    const grants = identity.response_metadata?.scopes ?? result.response_metadata?.scopes;
    if (Array.isArray(grants) && grants.every(scope => typeof scope === "string")) commandsGrant = grants.includes("commands") ? "granted" : "missing";
    const response = await app.apps.manifest.export({ app_id: appId });
    if (response.ok !== true) throw new Error("Export failed");
    current = exportedManifest(response.manifest);
  } catch {
    throw new Error("Slack command inspection failed: configured workspace, bot/app identity, Socket Mode, or manifest export could not be verified. No mutation was attempted; raw API details suppressed. No automatic retry was attempted.");
  }

  const intended = structuredClone(current);
  intended.features = { ...intended.features, slash_commands: structuredClone(SLACK_COMMANDS) };
  intended.oauth_config = { ...intended.oauth_config, scopes: {
    ...intended.oauth_config?.scopes,
    bot: [...new Set([...(intended.oauth_config?.scopes?.bot ?? []), "commands" as const])],
  } };
  const currentCommands = current.features?.slash_commands?.map(command => command.command) ?? [];
  const supported = new Set(SLACK_COMMANDS.map(command => command.command));
  const changed = !exact(current, intended);
  let updated = false;
  let permissionsUpdated: boolean | null = null;
  let manifestReadbackMatched = !changed;
  if (options.apply === true && changed) {
    try {
      const validation = await app.apps.manifest.validate({ app_id: appId, manifest: intended });
      if (validation.ok !== true || (validation.errors !== undefined && (!Array.isArray(validation.errors) || validation.errors.length))) throw new Error("Invalid manifest");
    } catch {
      throw new Error("Slack manifest validation failed. No mutation was attempted; raw API details suppressed. The explicit configuration credential needs app_configurations:write. No automatic retry was attempted.");
    }
    try {
      const response = await app.apps.manifest.update({ app_id: appId, manifest: intended });
      if (response.ok !== true || response.app_id !== appId || typeof response.permissions_updated !== "boolean") throw new Error("Uncertain update response");
      permissionsUpdated = response.permissions_updated;
      updated = true;
    } catch {
      throw new Error("Slack manifest update outcome is uncertain; the app may have changed. Inspect its authoritative manifest before another apply. Raw API details suppressed; no automatic retry was attempted.");
    }
    try {
      const response = await app.apps.manifest.export({ app_id: appId });
      if (response.ok !== true || !exact(exportedManifest(response.manifest), intended)) throw new Error("Readback differs");
      manifestReadbackMatched = true;
    } catch {
      throw new Error("Slack manifest update may have succeeded, but authoritative readback failed or differed from the intended commands or unrelated configuration. Outcome uncertain; inspect the app before another apply. Raw API details suppressed; no automatic retry was attempted.");
    }
  }
  const requiresReinstall = permissionsUpdated === true || commandsGrant === "missing" ? true : commandsGrant === "unknown" ? null : false;
  return redact({
    status: options.apply === true ? "applied" : "dry-run", teamId, botId, botUserId, appId,
    currentCommands, obsoleteCommands: currentCommands.filter(command => !supported.has(command)),
    plannedCommands: structuredClone(SLACK_COMMANDS), changed, updated, manifestReadbackMatched, commandsGrant, requiresReinstall, permissionsUpdated,
    note: [
      options.apply === true ? "The exported app configuration matches the supported commands." : "Dry-run: API reads and local comparison only; apply replaces this exact app's slash command list, including obsolete Hermes commands.",
      "All unrelated manifest fields and existing scopes are preserved. Socket Mode must already be enabled; no HTTP request URLs are invented.",
      requiresReinstall === true ? "Reinstall or reauthorize the app in the configured workspace to grant the required permissions; registration does not establish active command delivery." :
        requiresReinstall === null ? "Installed commands scope could not be confirmed; check grants and reinstall or reauthorize if needed. Active command delivery is not verified." :
          "The configured bot reports the commands grant; active Socket Mode command delivery is not verified.",
      "Configuration credentials require app_configurations:read, plus app_configurations:write for apply. Bot identity inspection requires users:read. No socket or runtime was started.",
    ].join(" "),
  } satisfies SlackCommandRegistrationReport, [botToken, manifestToken]);
}
