import {
  ApplicationCommandOptionType, ApplicationCommandType, ApplicationIntegrationType, InteractionContextType,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";
import { MESSENGER_COMMANDS } from "./messenger-commands";

/** The complete supported slash-command picker, also used for registration. */
export const DISCORD_COMMANDS: readonly RESTPostAPIChatInputApplicationCommandsJSONBody[] = MESSENGER_COMMANDS.map(
  (command): RESTPostAPIChatInputApplicationCommandsJSONBody => ({
  type: ApplicationCommandType.ChatInput, name: command.name, description: command.description,
  contexts: [InteractionContextType.Guild, InteractionContextType.BotDM],
  integration_types: [ApplicationIntegrationType.GuildInstall],
  ...("text" in command ? { options: [{ type: ApplicationCommandOptionType.String, name: "text", description: command.text, required: false }] } : {}),
}));

/** Reject stale registrations/options instead of silently executing a different command. */
export function parseDiscordCommand(name: string, options: unknown): string | null {
  const command = DISCORD_COMMANDS.find(command => command.name === name);
  if (!command || !Array.isArray(options)) return null;
  if (options.length === 0) return `/${name}`;
  if (!command.options?.length || options.length !== 1) return null;
  const option: unknown = options[0];
  if (!option || typeof option !== "object" || Array.isArray(option)) return null;
  const value = option as Record<string, unknown>;
  if (Object.keys(value).some(key => key !== "name" && key !== "type" && key !== "value") ||
    value.name !== "text" || value.type !== ApplicationCommandOptionType.String || typeof value.value !== "string") return null;
  const text = value.value.trim();
  return `/${name}${text ? ` ${text}` : ""}`;
}
