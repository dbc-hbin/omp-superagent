import type { Config } from "./config";
import { operatorBotToken, runOperator, type OperatorRun } from "./operator";

export interface DiscordCommandRegistrationOptions {
  readonly apply?: boolean;
  readonly run?: OperatorRun;
}

interface DiscordDefinition {
  readonly type: 1;
  readonly name: string;
  readonly description: string;
  readonly contexts: readonly [0, 1];
  readonly integration_types: readonly [0];
  readonly options?: readonly [{ readonly type: 3; readonly name: "text"; readonly description: string; readonly required: false }];
}

interface RegistrationSummary {
  readonly id: string;
  readonly type: number;
  readonly name: string;
}

export interface DiscordCommandRegistrationReport {
  readonly status: "dry-run" | "blocked" | "applied";
  readonly applicationId: string;
  readonly botId: string;
  readonly plannedGlobal: readonly DiscordDefinition[];
  readonly currentGlobal: readonly RegistrationSummary[];
  readonly obsoleteGlobal: readonly RegistrationSummary[];
  readonly guilds: readonly {
    readonly guildId: string;
    readonly registrations: readonly RegistrationSummary[];
    readonly shadowing: readonly RegistrationSummary[];
  }[];
  readonly note: string;
}

/** REST-only opt-in. Never opens a Gateway or starts OMP. */
export async function registerDiscordCommands(
  config: Config, options: DiscordCommandRegistrationOptions = {},
): Promise<DiscordCommandRegistrationReport> {
  const policy = config.discord;
  if (!policy) throw new Error("discord-commands requires configured Discord credentials and policy");
  const bot = operatorBotToken("Discord", config.path, policy.tokenEnv);
  return (options.run ?? runOperator)("discord-commands", {
    apply: options.apply === true, allowedGuildIds: policy.allowedGuildIds,
  }, { bot });
}
