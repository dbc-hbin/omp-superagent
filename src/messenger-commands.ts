import catalog from "./messenger-command-catalog.json" with { type: "json" };

/** Owner controls and platform-specific registration metadata shared with the native Gateway. */
export const MESSENGER_COMMAND_CATALOG: readonly {
  readonly name: string;
  readonly description: string;
  readonly text?: string;
  readonly discordOnly?: boolean;
  readonly discord?: {
    readonly description: string;
    readonly text: boolean;
  };
}[] = catalog;

export const MESSENGER_COMMANDS = MESSENGER_COMMAND_CATALOG.filter(command => !command.discordOnly);
