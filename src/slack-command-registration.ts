import type { Config } from "./config";
import { readCredentialFile, validateCredential } from "./credentials";
import { runOperator, type OperatorRun } from "./operator";

export interface SlackCommandRegistrationOptions {
  readonly apply?: boolean;
  /** Explicit app-configuration credential from an environment name or the sibling private file. */
  readonly manifestTokenEnv: string;
  readonly run?: OperatorRun;
}

export interface SlackCommandRegistrationReport {
  readonly status: "dry-run" | "applied";
  readonly teamId: string;
  readonly botId: string;
  readonly botUserId: string;
  readonly appId: string;
  readonly currentCommands: readonly string[];
  readonly obsoleteCommands: readonly string[];
  readonly plannedCommands: readonly {
    readonly command: string;
    readonly description: string;
    readonly usage_hint?: string;
    readonly should_escape: boolean;
  }[];
  readonly changed: boolean;
  readonly updated: boolean;
  readonly manifestReadbackMatched: boolean;
  readonly commandsGrant: "granted" | "missing" | "unknown";
  readonly requiresReinstall: boolean | null;
  readonly permissionsUpdated: boolean | null;
  readonly note: string;
}

const envName = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Resolve only the bot and explicitly selected configuration credential. */
export async function registerSlackCommands(
  config: Config, options: SlackCommandRegistrationOptions,
): Promise<SlackCommandRegistrationReport> {
  const policy = config.slack;
  if (!policy) throw new Error("slack-commands requires configured Slack credentials and policy");
  const name = options.manifestTokenEnv;
  if (typeof name !== "string" || !envName.test(name))
    throw new Error("slack-commands requires --manifest-token-env NAME naming an app configuration credential");
  if (typeof policy.botTokenEnv !== "string" || !envName.test(policy.botTokenEnv) ||
    typeof policy.teamId !== "string" || !/^T[A-Z0-9]+$/.test(policy.teamId))
    throw new Error("Invalid Slack bot credential name or workspace policy");
  if (name === policy.appTokenEnv || name === policy.botTokenEnv)
    throw new Error("A distinct explicit Slack app configuration credential is required");
  let bot: string;
  let manifest: string;
  try {
    const botEnv = process.env[policy.botTokenEnv];
    const manifestEnv = process.env[name];
    const file = !botEnv || !manifestEnv ? readCredentialFile(config.path) : undefined;
    bot = botEnv || file?.values[policy.botTokenEnv] || "";
    manifest = manifestEnv || file?.values[name] || "";
  } catch { throw new Error("Cannot safely load configured Slack credentials; details suppressed"); }
  if (!bot) throw new Error("Configured Slack bot credential is missing");
  if (!manifest) throw new Error("Explicit Slack app configuration credential is missing; set the named environment variable or its private sibling credential entry");
  try { validateCredential(bot); validateCredential(manifest); }
  catch { throw new Error("Configured Slack credential is invalid; values suppressed"); }

  return (options.run ?? runOperator)<SlackCommandRegistrationReport>(
    "slack-commands", { teamId: policy.teamId, apply: options.apply === true }, { bot, manifest },
  );
}
