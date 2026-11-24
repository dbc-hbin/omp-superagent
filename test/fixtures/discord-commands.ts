import {
  ApplicationCommandOptionType, ApplicationCommandType, ApplicationIntegrationType, InteractionContextType,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";
import { MESSENGER_COMMAND_CATALOG } from "../../src/messenger-commands";

/** Test-side projection of the shared catalog using Discord's SDK types. */
export const DISCORD_COMMANDS: readonly RESTPostAPIChatInputApplicationCommandsJSONBody[] = MESSENGER_COMMAND_CATALOG.map(
  (command): RESTPostAPIChatInputApplicationCommandsJSONBody => ({
  type: ApplicationCommandType.ChatInput, name: command.name, description: command.discord?.description ?? command.description,
  contexts: [InteractionContextType.Guild, InteractionContextType.BotDM],
  integration_types: [ApplicationIntegrationType.GuildInstall],
  ...(command.discord?.text !== false && command.text !== undefined
    ? { options: [{ type: ApplicationCommandOptionType.String, name: "text", description: command.text, required: false }] } : {}),
}));
