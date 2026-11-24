import type { Config } from "./config";
import { operatorBotToken, runOperator, type OperatorRun } from "./operator";
import languageCodes from "./telegram-command-languages.json";

interface MenuCommand {
  readonly command: string;
  readonly description: string;
}

type OwnerScope = { readonly type: "chat"; readonly chat_id: string }
  | { readonly type: "chat_member"; readonly chat_id: string; readonly user_id: number };

export interface TelegramCommandRegistrationOptions {
  readonly apply?: boolean;
  /** Omit for the default language list; Telegram cannot enumerate language overrides. */
  readonly languageCode?: string;
  readonly run?: OperatorRun;
}

export interface TelegramCommandRegistrationReport {
  readonly status: "dry-run" | "applied";
  readonly botId: string;
  readonly languageCode: string | null;
  readonly plannedCommands: readonly MenuCommand[];
  readonly scopes: readonly {
    readonly scope: OwnerScope;
    readonly current: readonly MenuCommand[];
    readonly changed: boolean;
  }[];
  readonly note: string;
}

/** API-only, opt-in menus. Never polls, manages webhooks, or starts OMP. */
export async function registerTelegramCommands(
  config: Config, options: TelegramCommandRegistrationOptions = {},
): Promise<TelegramCommandRegistrationReport> {
  const policy = config.telegram;
  if (!policy) throw new Error("telegram-commands requires configured Telegram credentials and policy");
  // Keep bad operator input separate from failures reading private credentials.
  if (!/^[1-9][0-9]*$/.test(policy.ownerId) || !Number.isSafeInteger(Number(policy.ownerId)) ||
      policy.allowedChatIds.some(id => !/^-[1-9][0-9]*$/.test(id) || !Number.isSafeInteger(Number(id)))) {
    throw new Error("Telegram command menus require a positive owner ID and negative allowed group IDs");
  }
  const { languageCode } = options;
  if (languageCode !== undefined && languageCode !== "" && !languageCodes.includes(languageCode)) {
    throw new Error("Telegram command language must be an empty string or a two-letter lowercase ISO 639-1 code");
  }
  const bot = operatorBotToken("Telegram", config.path, policy.tokenEnv);
  return (options.run ?? runOperator)("telegram-commands", {
    apply: options.apply === true, ownerId: policy.ownerId,
    allowedChatIds: policy.allowedChatIds, languageCode,
  }, { bot });
}
