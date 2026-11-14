import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Routes, type REST, type RESTOptions } from "discord.js";
import { main } from "../src/cli";
import type { Config } from "../src/config";
import { DISCORD_COMMANDS } from "../src/discord-commands";
import { registerDiscordCommands } from "../src/discord-command-registration";

const applicationId = "100000000000000001";
const guildId = "200000000000000002";
const tokenName = "DISCORD_REGISTRATION_TEST_TOKEN";
const otherTokenName = "DISCORD_REGISTRATION_OTHER_TOKEN";
const token = "private-discord-registration-token-never-print";
const globalPath = Routes.applicationCommands(applicationId);
const guildPath = Routes.applicationGuildCommands(applicationId, guildId);
const directories: string[] = [];
const environment = new Map<string, string | undefined>();

function setEnvironment(name: string, value?: string) {
  if (!environment.has(name)) environment.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function fixture(allowedGuildIds: string[] = []): Config {
  const directory = mkdtempSync(join(tmpdir(), "superagent-discord-commands-"));
  directories.push(directory);
  setEnvironment(tokenName, token);
  return {
    path: join(directory, "config.json"), stateDir: join(directory, "state"), headCwd: directory,
    command: ["not-an-executable"], maxHosts: 4, maxSubagents: 8, idleMs: 300000,
    discord: { tokenEnv: tokenName, ownerId: "300000000000000003", allowedGuildIds, allowedChannelIds: [] },
  };
}

function command(name: string, extra: Record<string, unknown> = {}) {
  return { id: "400000000000000004", application_id: applicationId, type: 1, name, description: "Old Hermes command", ...extra };
}

function authoritativeCommands() {
  return DISCORD_COMMANDS.map((definition, index) => ({
    ...definition, id: String(500000000000000000n + BigInt(index)), application_id: applicationId,
    version: "600000000000000006",
  }));
}

interface Step {
  method: "get" | "put";
  path: string;
  value?: unknown;
  error?: unknown;
}

function inspection(global: unknown = [], guilds: { id: string; commands: unknown }[] = []): Step[] {
  return [
    { method: "get", path: Routes.user("@me"), value: { id: applicationId, bot: true } },
    { method: "get", path: Routes.oauth2CurrentApplication(), value: { id: applicationId, bot: { id: applicationId } } },
    { method: "get", path: globalPath, value: global },
    ...guilds.map(guild => ({ method: "get" as const, path: Routes.applicationGuildCommands(applicationId, guild.id), value: guild.commands })),
  ];
}

function transport(steps: Step[]) {
  const pending = [...steps];
  const calls: { method: string; path: string; body?: unknown }[] = [];
  let settings: Partial<RESTOptions> | undefined;
  let credential: string | undefined;
  function request(method: "get" | "put", path: string, body?: unknown): unknown {
    calls.push({ method, path, ...(body === undefined ? {} : { body }) });
    const step = pending.shift();
    if (!step) throw new Error("Unexpected transport call");
    expect({ method, path }).toEqual({ method: step.method, path: step.path });
    if (step.error !== undefined) throw step.error;
    return step.value;
  }
  const rest: Pick<REST, "get" | "put"> = {
    async get(path) { return request("get", path); },
    async put(path, options) { return request("put", path, options?.body); },
  };
  return {
    calls, pending,
    get settings() { return settings; },
    get credential() { return credential; },
    createRest(options: Partial<RESTOptions>, value: string) { settings = options; credential = value; return rest; },
  };
}

afterEach(() => {
  for (const [name, value] of environment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  environment.clear();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("explicit Discord global command registration", () => {
  test.each(["discord-commands", "telegram-commands", "slack-commands"])("CLI rejects invalid %s arguments before loading credentials", async command => {
    await expect(main([command])).rejects.toThrow("--config FILE is required");
    for (const args of [
      ["--config", "--apply"],
      ["--config", "unused.json", "--apply", "--apply"],
      ["--config", "unused.json", "--guild", guildId],
      ["--config", "unused.json", "--config", "other.json"],
    ]) await expect(main([command, ...args])).rejects.toThrow(`Usage: ${command}`);
    if (command === "telegram-commands") {
      await expect(main([command, "--config", "unused.json", "--language"])).rejects.toThrow("Usage:");
      await expect(main([command, "--config", "unused.json", "--language", "ko", "--language", "en"])).rejects.toThrow("Usage:");
    }
    if (command === "slack-commands") {
      await expect(main([command, "--config", "unused.json"])).rejects.toThrow("Usage:");
      await expect(main([command, "--config", "unused.json", "--manifest-token-env"])).rejects.toThrow("Usage:");
      await expect(main([command, "--config", "unused.json", "--manifest-token-env", "FIRST", "--manifest-token-env", "SECOND"])).rejects.toThrow("Usage:");
    }
  });

  test("CLI help describes REST-only dry-run and destructive global-only apply", async () => {
    const cli = new URL("../src/cli.ts", import.meta.url).pathname;
    const proc = Bun.spawn([process.execPath, "--no-env-file", cli, "discord-commands", "--help"], {
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("discord-commands --config FILE [--apply]");
    expect(stdout).toContain("dry-run by default");
    expect(stdout).toContain("deleting obsolete registrations (including Hermes)");
    expect(stdout).toContain("Guild commands are preserved");
    expect(stdout).toContain("no Gateway or native runtime activation");
  });

  test("dry-run reads bot/application identity, globals, and allowed guilds without mutation", async () => {
    const config = fixture([guildId]);
    const rest = transport(inspection([command("hermes")], [{ id: guildId, commands: [] }]));
    const result = await registerDiscordCommands(config, rest);
    expect(result.status).toBe("dry-run");
    expect(result.applicationId).toBe(applicationId);
    expect(result.botId).toBe(applicationId);
    expect(result.plannedGlobal).toEqual(DISCORD_COMMANDS);
    expect(result.obsoleteGlobal).toEqual([{ id: "400000000000000004", type: 1, name: "hermes" }]);
    expect(result.guilds).toEqual([{ guildId, registrations: [], shadowing: [] }]);
    expect(result.note).toContain("deleting all other global registrations");
    expect(JSON.stringify(result)).not.toContain(token);
    expect(rest.calls.every(call => call.method === "get")).toBe(true);
    expect(rest.pending).toHaveLength(0);
    expect(rest.credential).toBe(token);
    expect(rest.settings?.retries).toBe(0);
    const reject = rest.settings?.rejectOnRateLimit;
    if (typeof reject !== "function") throw new Error("Rate-limit rejection must be configured");
    expect(await reject({} as Parameters<typeof reject>[0])).toBe(true);
    expect(rest.settings?.version).toBe("10");
  });

  test("approved apply replaces only global commands with the exact catalog and verifies GET", async () => {
    const config = fixture([guildId]);
    const unrelated = command("unrelated", { guild_id: guildId });
    const rest = transport([
      ...inspection([command("hermes")], [{ id: guildId, commands: [unrelated] }]),
      { method: "put", path: globalPath, value: { deliberately: "not authoritative" } },
      { method: "get", path: globalPath, value: authoritativeCommands() },
    ]);
    const result = await registerDiscordCommands(config, { ...rest, apply: true });
    expect(result.status).toBe("applied");
    expect(result.note).toContain("authoritative GET");
    expect(result.guilds[0]?.registrations[0]?.name).toBe("unrelated");
    expect(rest.calls.filter(call => call.method === "put")).toEqual([{ method: "put", path: globalPath, body: DISCORD_COMMANDS }]);
    expect(rest.calls.at(-1)).toEqual({ method: "get", path: globalPath });
    expect(rest.pending).toHaveLength(0);
  });

  test("normalizes server-added defaults and global list/context ordering", async () => {
    const config = fixture();
    const returned = authoritativeCommands().reverse().map(row => ({
      ...row, contexts: [1, 0], integration_types: [0],
      options: (row.options ?? []).map(option => ({
        ...option, required: false, autocomplete: false,
        name_localizations: null, description_localizations: null, choices: [],
      })),
      default_member_permissions: null, default_permission: true, dm_permission: true, nsfw: false,
      name_localizations: null, description_localizations: null,
    }));
    const rest = transport([
      ...inspection(), { method: "put", path: globalPath, value: [] },
      { method: "get", path: globalPath, value: returned },
    ]);
    expect((await registerDiscordCommands(config, { ...rest, apply: true })).status).toBe("applied");
    expect(rest.pending).toHaveLength(0);
  });

  test("dry-run flags supported-name guild shadows; apply refuses without touching either list", async () => {
    const config = fixture([guildId]);
    for (const apply of [false, true]) {
      const rest = transport(inspection([command("hermes")], [{ id: guildId, commands: [command("help", { guild_id: guildId })] }]));
      const result = await registerDiscordCommands(config, { ...rest, apply });
      expect(result.status).toBe(apply ? "blocked" : "dry-run");
      expect(result.guilds[0]?.shadowing.map(command => command.name)).toEqual(["help"]);
      expect(rest.calls.every(call => call.method === "get")).toBe(true);
      expect(rest.pending).toHaveLength(0);
    }
  });

  test("guild commands of another type do not shadow a supported slash command", async () => {
    const config = fixture([guildId]);
    const rest = transport([
      ...inspection([], [{ id: guildId, commands: [command("help", { type: 2, description: "", guild_id: guildId })] }]),
      { method: "put", path: globalPath, value: [] },
      { method: "get", path: globalPath, value: authoritativeCommands() },
    ]);
    expect((await registerDiscordCommands(config, { ...rest, apply: true })).status).toBe("applied");
    expect(rest.calls.filter(call => call.path === guildPath)).toHaveLength(1);
  });

  test("loads only the configured Discord credential, using the existing nonempty env precedence", async () => {
    const config = fixture();
    config.telegram = { tokenEnv: otherTokenName, ownerId: "1", allowedChatIds: [] };
    setEnvironment(otherTokenName);
    setEnvironment("UNRELATED_REGISTRATION_KEY");
    writeFileSync(`${config.path}.env`, `${tokenName}=file-discord-token\n${otherTokenName}=other-platform-secret\nUNRELATED_REGISTRATION_KEY=not-loaded\n`, { mode: 0o600 });
    const shell = transport(inspection());
    await registerDiscordCommands(config, shell);
    expect(shell.credential).toBe(token);
    expect(process.env[otherTokenName]).toBeUndefined();
    setEnvironment(tokenName, "");
    const file = transport(inspection());
    await registerDiscordCommands(config, file);
    expect(file.credential).toBe("file-discord-token");
    expect(process.env[otherTokenName]).toBeUndefined();
    expect(process.env.UNRELATED_REGISTRATION_KEY).toBeUndefined();
  });

  test("missing Discord configuration/credential stops before REST initialization", async () => {
    const config = fixture();
    const rest = transport([]);
    await expect(registerDiscordCommands({ ...config, discord: undefined }, rest)).rejects.toThrow("requires configured Discord");
    setEnvironment(tokenName);
    await expect(registerDiscordCommands(config, rest)).rejects.toThrow("credential is missing");
    expect(rest.settings).toBeUndefined();
    expect(rest.calls).toHaveLength(0);
  });

  test("invalid credentials and unsafe credential files are suppressed before any REST call", async () => {
    const config = fixture();
    const rest = transport([]);
    setEnvironment(tokenName, `${token}\ninvalid`);
    await expect(registerDiscordCommands(config, rest)).rejects.toThrow("credential is invalid; value suppressed");
    writeFileSync(`${config.path}.env`, `${tokenName}=${token}`, { mode: 0o644 });
    await expect(registerDiscordCommands(config, rest)).rejects.toThrow("Cannot safely load");
    expect(rest.settings).toBeUndefined();
    expect(rest.calls).toHaveLength(0);
  });

  test("non-bot and wrong application identities fail closed before reading or mutating commands", async () => {
    const config = fixture();
    for (const steps of [
      [{ method: "get" as const, path: Routes.user("@me"), value: { id: applicationId, bot: false } }],
      inspection().slice(0, 2).map((step, index) => index === 1 ? { ...step, value: { id: "999" } } : step),
      inspection().slice(0, 2).map((step, index) => index === 1 ? { ...step, value: { id: applicationId, bot: { id: "999" } } } : step),
    ]) {
      const rest = transport(steps);
      await expect(registerDiscordCommands(config, { ...rest, apply: true })).rejects.toThrow("No mutation was attempted");
      expect(rest.calls.every(call => call.method === "get")).toBe(true);
      expect(rest.pending).toHaveLength(0);
    }
  });

  test("malformed or wrong-application command lists fail closed, including guild lists", async () => {
    const config = fixture();
    for (const value of [null, {}, [null], [command("help", { application_id: "999" })],
      [command("help", { type: "1" })], [command("help", { options: {} })],
      [command("help"), command("help")]]) {
      const rest = transport(inspection(value));
      await expect(registerDiscordCommands(config, { ...rest, apply: true })).rejects.toThrow("No mutation was attempted");
      expect(rest.calls.filter(call => call.method === "put")).toHaveLength(0);
    }
    const guild = transport(inspection([], [{ id: guildId, commands: [command("help", { guild_id: "999" })] }]));
    await expect(registerDiscordCommands({ ...config, discord: { ...config.discord!, allowedGuildIds: [guildId] } }, { ...guild, apply: true })).rejects.toThrow("No mutation was attempted");
    expect(guild.calls.filter(call => call.method === "put")).toHaveLength(0);
  });

  test("SDK errors never expose credentials or URLs and are not retried", async () => {
    const config = fixture();
    for (const error of [new Error(`401 https://discord.com/api/webhooks/123/${token} Authorization: Bot ${token}`),
      { message: token, url: `https://discord.com/${token}`, status: 429 }, `${token}`]) {
      const rest = transport([{ method: "get", path: Routes.user("@me"), error }]);
      let message = "";
      try { await registerDiscordCommands(config, { ...rest, apply: true }); }
      catch (error) { message = error instanceof Error ? error.message : String(error); }
      expect(message).toContain("No mutation was attempted");
      expect(message).toContain("No automatic retry");
      expect(message).not.toContain(token);
      expect(message).not.toContain("https://");
      expect(rest.calls).toHaveLength(1);
    }
  });

  test("REST initialization failures cannot leak an SDK error or credential", async () => {
    const config = fixture();
    await expect(registerDiscordCommands(config, {
      createRest() { throw new Error(`https://discord.com/${token}`); },
    })).rejects.toThrow("Discord REST initialization failed; details suppressed");
  });

  test("failed/ambiguous PUT is unresolved, redacted, and never automatically retried or read back", async () => {
    const config = fixture();
    for (const failure of ["timeout", "429", "500", "401"]) {
      const rest = transport([
        ...inspection(),
        { method: "put", path: globalPath, error: new Error(`${failure} https://discord.com/${token}`) },
      ]);
      let message = "";
      try { await registerDiscordCommands(config, { ...rest, apply: true }); }
      catch (error) { message = error instanceof Error ? error.message : String(error); }
      expect(message).toContain("overwrite is unresolved");
      expect(message).toContain("No automatic retry");
      expect(message).not.toContain(token);
      expect(message).not.toContain("https://");
      expect(rest.calls.filter(call => call.method === "put")).toHaveLength(1);
      expect(rest.calls.at(-1)?.method).toBe("put");
      expect(rest.pending).toHaveLength(0);
    }
  });

  test("failed authoritative readback is unresolved without mutation retry", async () => {
    const config = fixture();
    const rest = transport([
      ...inspection(), { method: "put", path: globalPath, value: authoritativeCommands() },
      { method: "get", path: globalPath, error: new Error(`https://discord.com/${token}`) },
    ]);
    await expect(registerDiscordCommands(config, { ...rest, apply: true })).rejects.toThrow("unresolved: authoritative GET");
    expect(rest.calls.filter(call => call.method === "put")).toHaveLength(1);
    expect(rest.calls).toHaveLength(5);
    expect(rest.pending).toHaveLength(0);
  });

  test("readback must match every supported name/type/description/option/context and installation", async () => {
    const config = fixture();
    const changes = [
      (rows: Record<string, unknown>[]) => rows.pop(),
      (rows: Record<string, unknown>[]) => { rows[0]!.name = "unsupported"; },
      (rows: Record<string, unknown>[]) => { rows[0]!.type = 2; },
      (rows: Record<string, unknown>[]) => { rows[0]!.description = "Hermes"; },
      (rows: Record<string, unknown>[]) => { rows[0]!.contexts = [0]; },
      (rows: Record<string, unknown>[]) => { rows[0]!.integration_types = [0, 1]; },
      (rows: Record<string, unknown>[]) => { rows[0]!.default_member_permissions = "8"; },
      (rows: Record<string, unknown>[]) => { rows[0]!.options = [{ type: 3, name: "text", description: "unexpected" }]; },
      (rows: Record<string, unknown>[]) => {
        const row = rows.find(row => row.name === "model")!;
        row.options = [{ ...DISCORD_COMMANDS.find(command => command.name === "model")!.options![0], required: true }];
      },
    ];
    for (const change of changes) {
      const rows = authoritativeCommands();
      change(rows);
      const rest = transport([
        ...inspection(), { method: "put", path: globalPath, value: rows },
        { method: "get", path: globalPath, value: rows },
      ]);
      await expect(registerDiscordCommands(config, { ...rest, apply: true })).rejects.toThrow("unresolved: authoritative GET");
      expect(rest.calls.filter(call => call.method === "put")).toHaveLength(1);
      expect(rest.pending).toHaveLength(0);
    }
  });

  test("malformed readback cannot be mistaken for verified apply", async () => {
    const config = fixture();
    for (const value of [null, {}, [command("help", { contexts: "invalid" })]]) {
      const rest = transport([
        ...inspection(), { method: "put", path: globalPath, value: [] },
        { method: "get", path: globalPath, value },
      ]);
      await expect(registerDiscordCommands(config, { ...rest, apply: true })).rejects.toThrow("unresolved: authoritative GET");
      expect(rest.calls.filter(call => call.method === "put")).toHaveLength(1);
    }
  });
});
