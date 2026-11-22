import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { authorizeRoute, configuredPlatforms, credentialEnvNames, loadConfig, requireMessengerCredentials } from "../src/config";
import { main } from "../src/cli";
import { loadCredentials } from "../src/credentials";
import { discoverInstalledOmp, inspectInstalledOmp } from "../src/installed-omp";
import type { Route } from "../src/contracts";
import { dependencies } from "../package.json";
import { requireGateway } from "../src/gateway-native";
import { offlineMnemopi } from "./fixtures/native-memory";

const testedVersion = dependencies["@oh-my-pi/pi-coding-agent"];
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
  const voiceDiscord = { tokenEnv: "DISCORD_TOKEN", ownerId: "1", allowedGuildIds: ["2"], allowedChannelIds: ["3"] };
  const voiceSession = { textChannelId: "3", channelId: "4", voice: "selected", maxSessionSeconds: 60 };
  const paidVoice = { ...voiceSession, model: "speech", backendModel: "delegate", apiKeyEnv: "OMP_VOICE_KEY" };

  test("rejects a subagent budget that cannot cover admitted hosts", async () => {
    await expect(loadConfig(await config({ maxHosts: 4, maxSubagents: 2 }))).rejects.toThrow("maxSubagents");
  });
  test("resolves workspace and state paths relative to the configuration", async () => {
    const path = await config();
    const loaded = await loadConfig(path);
    expect(loaded.stateDir).toBe(join(dirname(path), "state"));
    expect(loaded.headCwd).toBe(realpathSync(dirname(path)));
    expect(loaded.command).toEqual([discoverInstalledOmp()]);
  });
  test("requires an explicit Discord owner rather than a permissive default", async () => {
    await expect(loadConfig(await config({ discord: { tokenEnv: "TOKEN", allowedGuildIds: [], allowedChannelIds: [] } })))
      .rejects.toThrow("discord.ownerId");
  });
  test.each(["implicit", "explicit"])("bounds API voice and isolates its provider credential with %s auth", async mode => {
    const voice = { ...paidVoice, ...(mode === "explicit" ? { auth: "api" as const } : {}) };
    const loaded = await loadConfig(await config({ discord: { ...voiceDiscord, voice } }));
    expect(credentialEnvNames(loaded)).toEqual(["DISCORD_TOKEN", "OMP_VOICE_KEY"]);
    expect(loaded.discord?.voice).toEqual(voice);
    for (const patch of [{ apiKeyEnv: "DISCORD_TOKEN" }, { textChannelId: "5" }, { channelId: "3" },
      { maxSessionSeconds: 0 }, { maxSessionSeconds: 2 ** 31 }, { backendModel: "" }]) {
      await expect(loadConfig(await config({ discord: { ...voiceDiscord, voice: { ...voice, ...patch } } }))).rejects.toThrow("discord.voice");
    }
  });
  test("subscription voice loads and requires only messenger credentials", async () => {
    const token = "SUPERAGENT_TEST_SUBSCRIPTION_DISCORD_TOKEN";
    const paidKey = "SUPERAGENT_TEST_SUBSCRIPTION_STALE_VOICE_KEY";
    const voice = { ...voiceSession, auth: "subscription" as const };
    const path = await config({ discord: { ...voiceDiscord, tokenEnv: token, voice } });
    writeFileSync(`${path}.env`, `${token}=test-discord-token\n${paidKey}=test-paid-key\n`, { mode: 0o600 });
    const loaded = await loadConfig(path);
    const previous = { [token]: process.env[token], [paidKey]: process.env[paidKey] };
    try {
      delete process.env[token];
      delete process.env[paidKey];
      loadCredentials(loaded);
      expect(loaded.discord?.voice).toEqual(voice);
      expect(credentialEnvNames(loaded)).toEqual([token]);
      expect(process.env[token]).toBe("test-discord-token");
      expect(process.env[paidKey]).toBeUndefined();
      expect(() => requireMessengerCredentials(loaded)).not.toThrow();
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
  test.each([
    ["model", "speech"],
    ["backendModel", ""],
    ["apiKeyEnv", null],
    ["provider", "unexpected"],
    ["textChannelId", "5"],
    ["maxSessionSeconds", 2 ** 31],
  ] as const)("rejects invalid subscription voice field %s", async (field, value) => {
    const voice = { ...voiceSession, auth: "subscription", [field]: value };
    await expect(loadConfig(await config({ discord: { ...voiceDiscord, voice } }))).rejects.toThrow(`discord.voice.${field}`);
  });
  test.each(["oauth", "", null])("rejects invalid voice auth %p rather than starting API voice", async auth => {
    const voice = { ...paidVoice, auth };
    await expect(loadConfig(await config({ discord: { ...voiceDiscord, voice } }))).rejects.toThrow("discord.voice.auth");
  });
  test("does not infer subscription voice from missing paid settings", async () => {
    await expect(loadConfig(await config({ discord: { ...voiceDiscord, voice: voiceSession } })))
      .rejects.toThrow("discord.voice.apiKeyEnv");
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
  test.each(["--session-settings", "--rpc-socket=/tmp/old.sock", "--model-preset", "attach"])(
    "rejects patched-only launch argument %s", async flag => {
      await expect(loadConfig(await config({ command: ["omp", flag] }))).rejects.toThrow("unsupported patched OMP arguments");
    },
  );
  test("removed attach command cannot start another session writer", async () => {
    await expect(main(["attach", "main", "--config", "unused.json"])).rejects.toThrow("Unknown command: attach");
  });
  test("retains explicit custom stock command argv", async () => {
    const command = [process.execPath, "--no-env-file", "/external/stock-omp.ts", "--profile", "attach"];
    expect((await loadConfig(await config({ command }))).command).toEqual(command);
    await expect(inspectInstalledOmp(command)).rejects.toThrow("not a runtime/script wrapper");
  });
  test("resolves a configured relative executable from the config directory, not a lane workspace", async () => {
    const path = await config({ command: ["./bin/omp", "--profile", "isolated"] });
    expect((await loadConfig(path)).command).toEqual([join(dirname(path), "bin/omp"), "--profile", "isolated"]);
  });
});

describe("installed OMP prerequisite", () => {
  async function runGateway(directory: string, args: readonly string[], env: Readonly<Record<string, string>> = {}) {
    const child = Bun.spawn([await requireGateway(), ...args], {
      env: { PATH: process.env.PATH, HOME: directory, PI_CODING_AGENT_DIR: join(directory, "agent"),
        OMP_SUPERAGENT_ROOT: realpathSync(join(import.meta.dir, "..")), OMP_SUPERAGENT_BUN: process.execPath, ...env },
      stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 30_000, killSignal: "SIGKILL",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    return { stdout, stderr, code };
  }

  async function executable(version = testedVersion, help = "--mode rpc, rpc-ui --resume PATH --extension FILE --model MODEL",
    processHelp = "--signal SIGNAL") {
    const directory = mkdtempSync(join(tmpdir(), "superagent-installed-"));
    dirs.push(directory);
    const command = join(directory, "omp");
    const audit = join(directory, "calls.jsonl");
    writeFileSync(command, `#!${process.execPath}
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(audit)}, JSON.stringify({ args: process.argv.slice(2), credential: process.env.INSTALLED_OMP_TEST_TOKEN ?? null, scope: process.env.INSTALLED_OMP_TEST_SCOPE ?? null, parentOnly: process.env.INSTALLED_OMP_PARENT_ONLY ?? null }) + "\\n");
if (process.argv.at(-1) === "--version") console.log(${JSON.stringify(`omp/${version}`)});
else if (process.argv[2] === "ps" && process.argv[3] === "--help") console.log(${JSON.stringify(processHelp)});
else if (process.argv.at(-1) === "--help") console.log(${JSON.stringify(help)});
else process.exit(8);
`);
    chmodSync(command, 0o700);
    return { directory, command, audit };
  }

  test("ignores dependency shims prepended by Bun lifecycle scripts", async () => {
    const f = await executable();
    const shimDirectory = join(f.directory, "node_modules", ".bin");
    mkdirSync(shimDirectory, { recursive: true });
    symlinkSync("/unavailable/project-sdk", join(shimDirectory, "omp"));
    expect(discoverInstalledOmp(`${shimDirectory}:${f.directory}`)).toBe(realpathSync(f.command));
    expect(() => discoverInstalledOmp(shimDirectory)).toThrow("installed stock OMP");
  });

  test("inspects only help/version in the supplied environment and removes messenger credentials", async () => {
    const f = await executable();
    const previous = process.env.INSTALLED_OMP_TEST_TOKEN;
    const previousParent = process.env.INSTALLED_OMP_PARENT_ONLY;
    process.env.INSTALLED_OMP_TEST_TOKEN = "private-messenger-token";
    process.env.INSTALLED_OMP_PARENT_ONLY = "private-parent-variable";
    try {
      const result = await inspectInstalledOmp(["omp", "--profile", "isolated", "-e", "/must-not-load.ts"], ["INSTALLED_OMP_TEST_TOKEN"], {
        PATH: f.directory, INSTALLED_OMP_TEST_TOKEN: "provided-token", INSTALLED_OMP_TEST_SCOPE: "isolated",
      });
      expect(result).toMatchObject({ executable: realpathSync(f.command), version: testedVersion, stdioRpc: true, sessions: true });
      const rows = (await Bun.file(f.audit).text()).trim().split("\n").map(line => JSON.parse(line));
      expect(rows).toEqual([
        { args: ["--version"], credential: null, scope: "isolated", parentOnly: null },
        { args: ["--help"], credential: null, scope: "isolated", parentOnly: null },
        { args: ["ps", "--help"], credential: null, scope: "isolated", parentOnly: null },
      ]);
    } finally {
      if (previous === undefined) delete process.env.INSTALLED_OMP_TEST_TOKEN;
      else process.env.INSTALLED_OMP_TEST_TOKEN = previous;
      if (previousParent === undefined) delete process.env.INSTALLED_OMP_PARENT_ONLY;
      else process.env.INSTALLED_OMP_PARENT_ONLY = previousParent;
    }
  });

  test.each(["18.22.2", "20.0.0", `${testedVersion}-preview`])("reports OMP %s when the CLI exposes the required capabilities", async version => {
    const f = await executable(version);
    await expect(inspectInstalledOmp([f.command])).resolves.toMatchObject({ version, executable: f.command });
  });

  test("does not confuse patched flags or prefix matches with public capabilities", async () => {
    const f = await executable(testedVersion, "--mode rpc-ui --session-settings FILE --extensions FILE --model-preset high");
    await expect(inspectInstalledOmp([f.command])).rejects.toThrow("public stdio RPC");
    const plain = await executable(testedVersion, "--mode rpc --resume PATH --extension FILE --model MODEL");
    await expect(inspectInstalledOmp([plain.command])).rejects.toThrow("public stdio RPC (rpc-ui)");
  });

  test("doctor reports the configured OMP 18 executable without activating services", async () => {
    const installedVersion = "18.22.2";
    const f = await executable(installedVersion, undefined, "--global SERVICE");
    const path = await config({ command: [f.command] });
    mkdirSync(join(f.directory, "agent"), { mode: 0o700 });
    await Bun.write(join(f.directory, "agent/config.yml"), JSON.stringify(offlineMnemopi));
    const child = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "../src/cli.ts"), "doctor", "--config", path], {
      env: { PATH: process.env.PATH, HOME: f.directory, PI_CODING_AGENT_DIR: join(f.directory, "agent") },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(stdout)).toMatchObject({
      omp: { executable: f.command, version: installedVersion, processBackend: "broker", stdioRpc: true },
      nativeTuiAttach: false, messengersActivated: false,
      memory: { status: "enabled", source: "global", backend: "mnemopi" },
      credentials: { DISCORD_BOT_TOKEN: false },
    });
    expect(await Bun.file(join(dirname(path), "state/coordination.sqlite")).exists()).toBe(false);
    expect(await Bun.file(join(f.directory, "agent/agent.db")).exists()).toBe(false);
    const rows = (await Bun.file(f.audit).text()).trim().split("\n").map(line => JSON.parse(line));
    expect(rows.map(row => row.args)).toEqual([["--version"], ["--help"], ["ps", "--help"]]);
  });

  test("doctor checks the launch-selected native profile, including its dotenv and CLI overlays", async () => {
    const f = await executable(testedVersion);
    const profile = join(f.directory, ".omp/profiles/isolated/agent");
    mkdirSync(profile, { recursive: true, mode: 0o700 });
    const profileOverlay = join(f.directory, "profile.yml");
    const launchOverlay = join(f.directory, "launch.yml");
    await Bun.write(join(profile, ".env"), `PI_CONFIG_FILES=${profileOverlay}\n`);
    await Bun.write(profileOverlay, '{"memory":{"backend":"sharpshooter"}}\n');
    await Bun.write(launchOverlay, '{"memory":{"backend":"off"}}\n');
    for (const overrides of [[], ["--config", launchOverlay]]) {
      const path = await config({ command: [f.command, "--profile=isolated", ...overrides] });
      const child = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "../src/cli.ts"), "doctor", "--config", path], {
        env: { PATH: process.env.PATH, HOME: f.directory, PI_CODING_AGENT_DIR: join(f.directory, "unused-default") },
        stdin: "ignore", stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      const shadowed = overrides.length > 0;
      expect({ code, stderr }).toEqual({ code: shadowed ? 1 : 0, stderr: "" });
      expect(JSON.parse(stdout)).toMatchObject({
        memory: { status: shadowed ? "missing" : "enabled", source: "overlay",
          backend: shadowed ? "off" : "sharpshooter", agentDir: profile },
        messengersActivated: false,
      });
    }
    expect(await Bun.file(join(profile, "agent.db")).exists()).toBe(false);
    expect(await Bun.file(join(profile, "config.yml")).exists()).toBe(false);
  }, 30_000);

  test.each([
    ["launch", "off"], ["serve", "off"], ["launch", "future-backend"], ["serve", "future-backend"],
  ])("direct native Gateway %s rejects a %s overlay before creating state", async (mode, backend) => {
    const f = await executable(testedVersion);
    const denied = join(f.directory, "deny.yml");
    const bytes = JSON.stringify({ memory: { backend } }) + "\n";
    const agent = join(f.directory, "agent");
    mkdirSync(agent, { mode: 0o700 });
    await Bun.write(join(agent, "config.yml"), JSON.stringify(offlineMnemopi));
    await Bun.write(denied, bytes);
    const file = await config({ command: [f.command, "--config", denied] });
    const { stdout, stderr, code } = await runGateway(f.directory, [mode, "--config", file]);
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("Managed sessions require an enabled native OMP memory backend");
    expect(existsSync(join(dirname(file), "state"))).toBe(false);
    expect(await Bun.file(join(agent, "agent.db")).exists()).toBe(false);
    expect(await Bun.file(denied).text()).toBe(bytes);
  }, 40_000);

  test.each(["launch", "serve", "replacement serve"] as const)(
    "direct native Gateway %s leaves global memory off without credentials or a replacement receipt", async mode => {
      const f = await executable();
      const agent = join(f.directory, "agent");
      mkdirSync(agent, { mode: 0o700 });
      const settings = Bun.file(join(agent, "config.yml"));
      const bytes = '{"memory":{"backend":"off"}}\n';
      await Bun.write(settings, bytes);
      const file = await config({ command: [f.command] });
      const replacement = mode === "replacement serve";
      const args = [
        replacement ? "serve" : mode, "--config", file,
        ...(replacement ? ["--restart-request", crypto.randomUUID()] : []),
      ];
      const { code, stdout } = await runGateway(f.directory, args,
        replacement ? { DISCORD_BOT_TOKEN: "fixture-only" } : {});
      expect({ code, stdout }).toEqual({ code: 1, stdout: "" });
      expect(await settings.text()).toBe(bytes);
      expect(existsSync(join(dirname(file), "state"))).toBe(false);
    }, 40_000);

  test("direct native Gateway serve cannot repair memory while another owner holds the lifetime lock", async () => {
    const f = await executable();
    const agent = join(f.directory, "agent");
    mkdirSync(agent, { mode: 0o700 });
    const settings = Bun.file(join(agent, "config.yml"));
    const bytes = '{"memory":{"backend":"off"}}\n';
    await Bun.write(settings, bytes);
    const file = await config({ command: [f.command] });
    const state = join(dirname(file), "state");
    mkdirSync(state, { mode: 0o700 });
    const lock = new Database(join(state, "coordination.sqlite.gateway-lock"));
    try {
      lock.exec("BEGIN EXCLUSIVE");
      const { code, stdout } = await runGateway(f.directory, ["serve", "--config", file], {
        DISCORD_BOT_TOKEN: "offline-fixture-only\u0007",
      });
      expect({ code, stdout }).toEqual({ code: 1, stdout: "" });
      expect(await settings.text()).toBe(bytes);
      expect(existsSync(join(state, "coordination.sqlite"))).toBe(false);
    } finally {
      lock.close();
    }
  }, 40_000);

  test("owned native Gateway refuses an incompatible OMP before repairing memory or exposing messenger credentials", async () => {
    const f = await executable(testedVersion, "--mode rpc --resume PATH --extension FILE --model MODEL");
    const agent = join(f.directory, "agent");
    mkdirSync(agent, { mode: 0o700 });
    const settings = Bun.file(join(agent, "config.yml"));
    const bytes = '{"memory":{"backend":"off"}}\n';
    await Bun.write(settings, bytes);
    const tokenEnv = "INSTALLED_OMP_TEST_TOKEN";
    const file = await config({
      command: [f.command],
      discord: { tokenEnv, ownerId: "123", allowedGuildIds: [], allowedChannelIds: [] },
    });
    const { code, stdout, stderr } = await runGateway(f.directory, ["serve", "--config", file], {
      // An invalid header prevents any real transport request even if ordering regresses.
      [tokenEnv]: "private-messenger-token\u0007",
      OMP_SUPERAGENT_TEST_MANAGED_ULW_PATH: join(import.meta.dir, "fixtures/managed-ulw"),
    });
    expect({ code, stdout }).toEqual({ code: 1, stdout: "" });
    expect(stderr).not.toContain("private-messenger-token");
    const rows = (await Bun.file(f.audit).text()).trim().split("\n").map(line => JSON.parse(line));
    expect(rows.map(({ args, credential }) => ({ args, credential }))).toEqual([
      { args: ["--version"], credential: null },
      { args: ["--help"], credential: null },
    ]);
    expect(await settings.text()).toBe(bytes);
    expect(existsSync(join(dirname(file), "state/run/gateway.sock"))).toBe(false);
  }, 40_000);
});
