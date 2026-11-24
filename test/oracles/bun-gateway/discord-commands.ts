import { ApplicationCommandOptionType } from "discord.js";
import { DISCORD_COMMANDS } from "../../fixtures/discord-commands";

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
