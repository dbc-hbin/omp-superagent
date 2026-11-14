import { describe, expect, test } from "bun:test";
import { ApplicationCommandOptionType, ApplicationCommandType, ApplicationIntegrationType, InteractionContextType } from "discord.js";
import { DISCORD_COMMANDS, parseDiscordCommand } from "../src/discord-commands.ts";

describe("Discord command catalog", () => {
  test("registers only supported Superagent commands for guild installs and owner bot DMs", () => {
    expect(DISCORD_COMMANDS.map(command => command.name)).toEqual([
      "help", "status", "restart", "context", "usage", "resume", "main", "model", "effort", "compact", "stop", "new",
    ]);
    for (const command of DISCORD_COMMANDS) {
      expect(command.type).toBe(ApplicationCommandType.ChatInput);
      expect(command.description).toContain("Superagent");
      expect(command.description.length).toBeLessThanOrEqual(100);
      expect(command.contexts).toEqual([InteractionContextType.Guild, InteractionContextType.BotDM]);
      expect(command.integration_types).toEqual([ApplicationIntegrationType.GuildInstall]);
      expect(parseDiscordCommand(command.name, [])).toBe(`/${command.name}`);
      if (["model", "effort", "compact", "stop", "new"].includes(command.name)) {
        expect(command.options).toEqual([{
          name: "text", type: ApplicationCommandOptionType.String, description: expect.any(String), required: false,
        }]);
        expect(command.options![0]!.description.length).toBeLessThanOrEqual(100);
      } else expect(command.options).toBeUndefined();
    }
  });

  test.each(["model", "effort", "compact", "stop", "new"])("/%s preserves free text and multiline instructions", name => {
    expect(parseDiscordCommand(name, [{ name: "text", type: ApplicationCommandOptionType.String, value: "  first line\nsecond line  " }])).toBe(`/${name} first line\nsecond line`);
  });

  test("rejects unknown commands and every stale option shape instead of ignoring data", () => {
    const text = { name: "text", type: ApplicationCommandOptionType.String, value: "high" };
    for (const name of ["hermes", "clear", "models", "STATUS", "/status", "status\n", ""]) {
      expect(parseDiscordCommand(name, [])).toBeNull();
    }
    for (const name of ["help", "status", "restart", "context", "usage", "resume", "main"]) {
      expect(parseDiscordCommand(name, [text])).toBeNull();
    }
    for (const options of [
      undefined, null, {}, "text", [null], [[]], ["high"], [text, text],
      [{ ...text, name: "value" }], [{ ...text, type: ApplicationCommandOptionType.Integer }],
      [{ ...text, value: 1 }], [{ ...text, value: null }], [{ name: "text", type: ApplicationCommandOptionType.String }],
      [{ ...text, options: [] }], [{ ...text, focused: true }], [{ ...text, stale: true }],
      [{ name: "preset", type: ApplicationCommandOptionType.Subcommand, options: [text] }],
    ]) expect(parseDiscordCommand("model", options)).toBeNull();
  });
});
