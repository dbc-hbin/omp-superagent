import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { authorizeRoute, configuredPlatforms, credentialEnvNames, loadConfig } from "../src/config";
import type { Route } from "../src/contracts";

const dirs: string[] = [];
async function config(patch: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "superagent-config-"));
  dirs.push(dir);
  const path = join(dir, "config.json");
  await Bun.write(path, JSON.stringify({
    stateDir: "state", headCwd: dir, command: ["omp"], maxHosts: 2, maxSubagents: 2, idleMs: 1000,
    discord: { tokenEnv: "DISCORD_BOT_TOKEN", ownerId: "123", allowedGuildIds: [], allowedChannelIds: [] },
    ...patch,
  }));
  return path;
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
describe("operator execution limits", () => {
  test("rejects a subagent budget that cannot cover admitted hosts", async () => {
    await expect(loadConfig(await config({ maxHosts: 4, maxSubagents: 2 }))).rejects.toThrow("maxSubagents");
  });
  test("resolves workspace and state paths relative to the configuration", async () => {
    const path = await config();
    const loaded = await loadConfig(path);
    expect(loaded.stateDir).toBe(join(dirname(path), "state"));
    expect(loaded.headCwd).toBe(realpathSync(dirname(path)));
  });
  test("requires an explicit Discord owner rather than a permissive default", async () => {
    await expect(loadConfig(await config({ discord: { tokenEnv: "TOKEN", allowedGuildIds: [], allowedChannelIds: [] } })))
      .rejects.toThrow("discord.ownerId");
  });
  test("supports Telegram-only and Slack-only installations without Discord credentials", async () => {
    const telegram = await loadConfig(await config({
      discord: undefined,
      telegram: { tokenEnv: "TG_TOKEN", ownerId: "456", allowedChatIds: ["-100123", "-100123"] },
    }));
    expect(configuredPlatforms(telegram)).toEqual(["telegram"]);
    expect(credentialEnvNames(telegram)).toEqual(["TG_TOKEN"]);
    expect(telegram.telegram?.allowedChatIds).toEqual(["-100123"]);
    const slack = await loadConfig(await config({
      discord: undefined,
      slack: { botTokenEnv: "SLACK_BOT_TOKEN", appTokenEnv: "SLACK_APP_TOKEN", ownerId: "U123", teamId: "T123", allowedChannelIds: ["C123"] },
    }));
    expect(configuredPlatforms(slack)).toEqual(["slack"]);
    expect(credentialEnvNames(slack)).toEqual(["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"]);
    await expect(loadConfig(await config({ discord: undefined }))).rejects.toThrow("at least one");
  });
  test("platform authorization cannot cross workspace, owner, or group allowlists", async () => {
    const loaded = await loadConfig(await config({
      telegram: { tokenEnv: "TG_TOKEN", ownerId: "456", allowedChatIds: ["-100123"] },
      slack: { botTokenEnv: "SLACK_BOT_TOKEN", appTokenEnv: "SLACK_APP_TOKEN", ownerId: "U123", teamId: "T123", allowedChannelIds: ["C123"] },
    }));
    const telegram: Route = { platform: "telegram", accountId: "789", authorityId: "456", guildId: "-100123", channelId: "-100123", threadId: "7" };
    const slack: Route = { platform: "slack", accountId: "T123:UBOT", authorityId: "U123", guildId: "T123", channelId: "C123", threadId: "1730000000.000001" };
    expect(authorizeRoute(loaded, telegram)).toBe(true);
    expect(authorizeRoute(loaded, { ...telegram, channelId: "-100999" })).toBe(false);
    expect(authorizeRoute(loaded, { ...telegram, guildId: null, channelId: "999" })).toBe(false);
    expect(authorizeRoute(loaded, { ...telegram, guildId: null, channelId: "456" })).toBe(true);
    expect(authorizeRoute(loaded, slack)).toBe(true);
    expect(authorizeRoute(loaded, { ...slack, accountId: "T999:UBOT" })).toBe(false);
    expect(authorizeRoute(loaded, { ...slack, authorityId: "U999" })).toBe(false);
    expect(authorizeRoute(loaded, { ...slack, guildId: null, channelId: "C123" })).toBe(false);
    expect(authorizeRoute(loaded, { ...slack, guildId: null, channelId: "D123" })).toBe(true);
    expect(authorizeRoute(loaded, { ...slack, topicId: "forged" })).toBe(false);
  });
  test("rejects malformed token variable names and platform-specific identifiers", async () => {
    await expect(loadConfig(await config({
      discord: undefined, telegram: { tokenEnv: "123:actual-token", ownerId: "456", allowedChatIds: [] },
    }))).rejects.toThrow("environment variable");
    await expect(loadConfig(await config({
      discord: undefined, telegram: { tokenEnv: "TG_TOKEN", ownerId: "456", allowedChatIds: ["456"] },
    }))).rejects.toThrow("allowedChatIds");
    await expect(loadConfig(await config({
      discord: undefined,
      slack: { botTokenEnv: "BOT", appTokenEnv: "APP", ownerId: "123", teamId: "T123", allowedChannelIds: [] },
    }))).rejects.toThrow("slack.ownerId");
  });
  test("rejects a second project-local preset registry instead of silently ignoring it", async () => {
    await expect(loadConfig(await config({
      modelPresets: { high: { provider: "local", id: "chat" } },
    }))).rejects.toThrow("native OMP settings");
  });
});
