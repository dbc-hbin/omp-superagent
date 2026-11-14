import { Api } from "grammy";
import type { BotCommand, BotCommandScopeChat, BotCommandScopeChatMember, LanguageCode } from "grammy/types";
import type { Config } from "./config";
import { loadCredentials, validateCredential } from "./credentials";
import { MESSENGER_COMMANDS } from "./messenger-commands";

type CommandApi = Pick<Api, "getMe" | "getChat" | "getChatMember" | "getMyCommands" | "setMyCommands">;
type OwnerScope = BotCommandScopeChat | BotCommandScopeChatMember;

// The SDK exports its language mapping as declarations only, not runtime data.
// Keep validation tied to its actual union rather than asserting any two letters.
const LANGUAGE_CODES = [
  "aa", "ab", "ae", "af", "ak", "am", "an", "ar", "as", "av", "ay", "az",
  "ba", "be", "bg", "bi", "bm", "bn", "bo", "br", "bs",
  "ca", "ce", "ch", "co", "cr", "cs", "cu", "cv", "cy",
  "da", "de", "dv", "dz", "ee", "el", "en", "eo", "es", "et", "eu",
  "fa", "ff", "fi", "fj", "fo", "fr", "fy", "ga", "gd", "gl", "gn", "gu", "gv",
  "ha", "he", "hi", "ho", "hr", "ht", "hu", "hy", "hz",
  "ia", "id", "ie", "ig", "ii", "ik", "io", "is", "it", "iu",
  "ja", "jv", "ka", "kg", "ki", "kj", "kk", "kl", "km", "kn", "ko", "kr", "ks", "ku", "kv", "kw", "ky",
  "la", "lb", "lg", "li", "ln", "lo", "lt", "lu", "lv",
  "mg", "mh", "mi", "mk", "ml", "mn", "mr", "ms", "mt", "my",
  "na", "nb", "nd", "ne", "ng", "nl", "nn", "no", "nr", "nv", "ny",
  "oc", "oj", "om", "or", "os", "pa", "pi", "pl", "ps", "pt", "qu",
  "rm", "rn", "ro", "ru", "rw", "sa", "sc", "sd", "se", "sg", "si", "sk", "sl", "sm", "sn", "so", "sq", "sr", "ss", "st", "su", "sv", "sw",
  "ta", "te", "tg", "th", "ti", "tk", "tl", "tn", "to", "tr", "ts", "tt", "tw", "ty",
  "ug", "uk", "ur", "uz", "ve", "vi", "vo", "wa", "wo", "xh", "yi", "yo", "za", "zh", "zu",
] as const satisfies readonly LanguageCode[];

function normalizeLanguageCode(value: string | undefined): LanguageCode | undefined {
  // Omission and the API's empty-string selector both select the default list.
  // Omit both because the installed SDK does not include "" in LanguageCode.
  if (value === undefined || value === "") return undefined;
  const language = LANGUAGE_CODES.find(code => code === value);
  if (language === undefined) throw new Error("Telegram command language must be an empty string or a two-letter lowercase ISO 639-1 code");
  return language;
}

export interface TelegramCommandRegistrationOptions {
  apply?: boolean;
  /** Omit for the default language list; Telegram cannot enumerate language overrides. */
  languageCode?: string;
  createApi?: (token: string) => CommandApi;
}

export interface TelegramCommandRegistrationReport {
  status: "dry-run" | "applied";
  botId: string;
  languageCode: string | null;
  plannedCommands: BotCommand[];
  scopes: { scope: OwnerScope; current: BotCommand[]; changed: boolean }[];
  note: string;
}

function commands(value: unknown): BotCommand[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error("Invalid command list");
  return value.map(row => {
    if (!row || typeof row !== "object" || typeof row.command !== "string" ||
      !/^[a-z0-9_]{1,32}$/.test(row.command) || typeof row.description !== "string" ||
      row.description.length < 1 || row.description.length > 256) throw new Error("Invalid command definition");
    return { command: row.command, description: row.description };
  });
}

function exact(actual: BotCommand[], expected: BotCommand[]): boolean {
  // Order also defines the visible picker, so a reordered list is not exact.
  return JSON.stringify(actual) === JSON.stringify(expected);
}

/** API-only, opt-in menus. Never polls, manages webhooks, or imports the runtime. */
export async function registerTelegramCommands(
  config: Config, options: TelegramCommandRegistrationOptions = {},
): Promise<TelegramCommandRegistrationReport> {
  const policy = config.telegram;
  if (!policy) throw new Error("telegram-commands requires configured Telegram credentials and policy");
  if (!/^[1-9][0-9]*$/.test(policy.ownerId) || !Number.isSafeInteger(Number(policy.ownerId)) ||
    policy.allowedChatIds.some(id => !/^-[1-9][0-9]*$/.test(id) || !Number.isSafeInteger(Number(id)))) {
    throw new Error("Telegram command menus require a positive owner ID and negative allowed group IDs");
  }
  const languageCode = normalizeLanguageCode(options.languageCode);
  try {
    // Preserve the existing explicit-environment/private-file precedence while
    // neither loading nor requiring any other platform's credentials.
    loadCredentials({ ...config, discord: undefined, slack: undefined });
  } catch { throw new Error("Cannot safely load the configured Telegram credential; details suppressed"); }
  const token = process.env[policy.tokenEnv];
  if (!token) throw new Error("Configured Telegram credential is missing");
  try { validateCredential(token); }
  catch { throw new Error("Configured Telegram credential is invalid; value suppressed"); }

  let api: CommandApi;
  try {
    // No retry transformer. Redirects must not forward the token-bearing URL.
    api = (options.createApi ?? (credential => new Api(credential, {
      sensitiveLogs: false, timeoutSeconds: 45, baseFetchConfig: { redirect: "error" },
    })))(token);
  } catch { throw new Error("Telegram API initialization failed; details suppressed"); }

  const plannedCommands = MESSENGER_COMMANDS.map(command => ({ command: command.name, description: command.description }));
  const language = languageCode === undefined ? {} : { language_code: languageCode };
  const scopes: TelegramCommandRegistrationReport["scopes"] = [];
  let botId: string;
  try {
    const bot = await api.getMe();
    if (!bot.is_bot || !Number.isSafeInteger(bot.id) || bot.id <= 0 || String(bot.id) === policy.ownerId) throw new Error("Invalid bot identity");
    botId = String(bot.id);
    const ownerChat = await api.getChat(policy.ownerId);
    if (String(ownerChat.id) !== policy.ownerId || ownerChat.type !== "private") throw new Error("Invalid owner DM");
    const targets: OwnerScope[] = [{ type: "chat", chat_id: policy.ownerId }];
    for (const chatId of new Set(policy.allowedChatIds)) {
      const chat = await api.getChat(chatId);
      if (String(chat.id) !== chatId || (chat.type !== "group" && chat.type !== "supergroup") ||
        ("is_direct_messages" in chat && chat.is_direct_messages === true)) throw new Error("Invalid allowed group");
      const member = await api.getChatMember(chatId, Number(policy.ownerId));
      if (String(member.user.id) !== policy.ownerId || member.user.is_bot ||
        !(member.status === "creator" || member.status === "administrator" || member.status === "member" ||
          (member.status === "restricted" && member.is_member))) throw new Error("Owner membership not verified");
      targets.push({ type: "chat_member", chat_id: chatId, user_id: Number(policy.ownerId) });
    }
    // Finish every ownership and menu read before attempting any mutation.
    for (const scope of targets) {
      const current = commands(await api.getMyCommands({ scope, ...language }));
      scopes.push({ scope, current, changed: !exact(current, plannedCommands) });
    }
  } catch {
    throw new Error("Telegram command inspection failed: bot identity, owner DM, allowed-group membership, or menu response could not be verified. No mutation was attempted; raw API details suppressed. No automatic retry was attempted.");
  }

  if (options.apply === true) {
    for (const target of scopes) {
      if (!target.changed) continue;
      try {
        const result = await api.setMyCommands(plannedCommands, { scope: target.scope, ...language });
        if (result !== true) throw new Error("Missing success receipt");
      } catch {
        throw new Error("Telegram command menu update is unresolved: the request failed and may have reached Telegram; earlier scopes may already have changed. No automatic retry was attempted; raw API details suppressed. Inspect with telegram-commands without --apply before deciding any further mutation.");
      }
      try {
        const actual = commands(await api.getMyCommands({ scope: target.scope, ...language }));
        if (!exact(actual, plannedCommands)) throw new Error("Menu readback differs");
      } catch {
        throw new Error("Telegram command menu update is unresolved: authoritative getMyCommands did not verify the exact supported names, descriptions, and order; earlier scopes may already have changed. No automatic retry was attempted; raw API details suppressed. Inspect with telegram-commands without --apply before deciding any further mutation.");
      }
    }
  }
  const redact = (text: string) => text.replaceAll(token, "[redacted]").replace(/https?:\/\/\S+/gi, "[redacted-url]");
  return {
    status: options.apply === true ? "applied" : "dry-run", botId, languageCode: options.languageCode ?? null,
    plannedCommands,
    scopes: scopes.map(target => ({ ...target, current: target.current.map(command => ({
      command: command.command, description: redact(command.description),
    })) })),
    note: `${options.apply === true ? "Owner-scoped command menus verified by getMyCommands, including exact supported names, descriptions, and order." : "Read-only plan; no mutation was attempted. --apply replaces only these owner-scoped command lists."} Only the selected language list is inspected or changed. Other scopes and bot configuration are untouched. Language-specific menus not selected here are unknown and untouched: Telegram cannot enumerate them, and they may override the default-language menu. No polling, webhooks, or native runtime was started.`,
  };
}
