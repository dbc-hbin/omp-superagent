import { MESSENGER_COMMANDS } from "./messenger-commands";

/** Slack reserves /help and /status, so every supported picker entry is namespaced. */
export const SLACK_COMMANDS = MESSENGER_COMMANDS.map(command => ({
  command: `/superagent-${command.name}`,
  description: command.description,
  ...("text" in command ? { usage_hint: command.text } : {}),
  should_escape: false,
}));

/** Only registered names are accepted; invalid no-argument invocations are not commands. */
export function parseSlackCommand(name: string, text: string): string | null {
  const command = MESSENGER_COMMANDS.find(command => name === `/superagent-${command.name}`);
  if (!command) return null;
  const argument = text.trim();
  if (argument && !("text" in command)) return null;
  return `/${command.name}${argument ? ` ${argument}` : ""}`;
}
