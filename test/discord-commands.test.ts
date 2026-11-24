import { describe, expect, test } from "bun:test";
import { ApplicationCommandOptionType, ApplicationCommandType, ApplicationIntegrationType, InteractionContextType } from "discord.js";
import { DISCORD_COMMANDS } from "./fixtures/discord-commands.ts";
import { parseDiscordCommand } from "./oracles/bun-gateway/discord-commands.ts";

describe("Discord command catalog", () => {
  test("registers only supported Superagent commands for guild installs and owner bot DMs", () => {
    expect(DISCORD_COMMANDS.map(command => command.name)).toEqual([
      "help", "head", "status", "restart", "context", "usage", "cron", "resume", "resolve", "main", "model", "effort", "compact", "stop", "new",
      "usage-reset",
    ]);
    for (const command of DISCORD_COMMANDS) {
      expect(command.type).toBe(ApplicationCommandType.ChatInput);
      expect(command.description).toContain("Superagent");
      expect(command.description.length).toBeLessThanOrEqual(100);
      expect(command.contexts).toEqual([InteractionContextType.Guild, InteractionContextType.BotDM]);
      expect(command.integration_types).toEqual([ApplicationIntegrationType.GuildInstall]);
      expect(parseDiscordCommand(command.name, [])).toBe(`/${command.name}`);
      if (["head", "model", "effort", "compact", "stop", "new", "resolve", "cron"].includes(command.name)) {
        expect(command.options).toEqual([{
          name: "text", type: ApplicationCommandOptionType.String, description: expect.any(String), required: false,
        }]);
        expect(command.options![0]!.description.length).toBeLessThanOrEqual(100);
      } else expect(command.options).toBeUndefined();
    }
  });

  test.each(["head", "model", "effort", "compact", "stop", "new", "resolve", "cron"])("/%s preserves free text and multiline instructions", name => {
    expect(parseDiscordCommand(name, [{ name: "text", type: ApplicationCommandOptionType.String, value: "  first line\nsecond line  " }])).toBe(`/${name} first line\nsecond line`);
  });

  test("Discord usage and usage-reset both reject stale options", () => {
    expect(parseDiscordCommand("usage-reset", [{ name: "text", type: ApplicationCommandOptionType.String, value: "anthropic/9" }])).toBeNull();
    expect(parseDiscordCommand("usage", [{ name: "text", type: ApplicationCommandOptionType.String, value: "reset" }])).toBeNull();
  });

  test("rejects unknown commands and every stale option shape instead of ignoring data", () => {
    const text = { name: "text", type: ApplicationCommandOptionType.String, value: "high" };
    for (const name of ["hermes", "clear", "models", "usage reset", "STATUS", "/status", "status\n", ""]) {
      expect(parseDiscordCommand(name, [])).toBeNull();
    }
    for (const name of ["help", "status", "restart", "context", "resume", "main"]) {
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
