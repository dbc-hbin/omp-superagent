import { MESSENGER_COMMANDS } from "../../../src/messenger-commands";

/** Only registered names are accepted; invalid no-argument invocations are not commands. */
export function parseSlackCommand(name: string, text: string): string | null {
  const command = MESSENGER_COMMANDS.find(command => name === `/superagent-${command.name}`);
  if (!command) return null;
  const argument = text.trim();
  if (argument && command.text === undefined) return null;
  return `/${command.name}${argument ? ` ${argument}` : ""}`;
}
