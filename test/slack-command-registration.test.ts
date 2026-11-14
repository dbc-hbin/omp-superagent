import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebClient, type WebClientOptions } from "@slack/web-api";
import type { Config } from "../src/config";
import { MESSENGER_COMMANDS } from "../src/messenger-commands";
import { parseSlackCommand, SLACK_COMMANDS } from "../src/slack-commands";
import { registerSlackCommands, type SlackCommandClient } from "../src/slack-command-registration";

const teamId = "T123456";
const appId = "A123456";
const botId = "B123456";
const botUserId = "U123456";
const botEnv = "SLACK_COMMAND_TEST_BOT";
const appEnv = "SLACK_COMMAND_TEST_SOCKET";
const manifestEnv = "SLACK_COMMAND_TEST_CONFIGURATION";
const otherEnv = "SLACK_COMMAND_TEST_UNRELATED";
const botToken = "private-slack-bot-credential";
const manifestToken = "private-slack-configuration-credential";
const privateUrl = "https://hooks.slack.com/commands/private/response?secret=never-print";
const directories: string[] = [];
const environment = new Map<string, string | undefined>();
type Row = Record<string, unknown>;

function setEnv(name: string, value?: string) {
  if (!environment.has(name)) environment.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function config(): Config {
  const directory = mkdtempSync(join(tmpdir(), "superagent-slack-commands-"));
  directories.push(directory);
  setEnv(botEnv, botToken);
  setEnv(manifestEnv, manifestToken);
  setEnv(appEnv);
  setEnv(otherEnv);
  return {
    path: join(directory, "config.json"), stateDir: join(directory, "state"), headCwd: directory,
    command: ["not-an-executable"], maxHosts: 4, maxSubagents: 8, idleMs: 300000,
    slack: { botTokenEnv: botEnv, appTokenEnv: appEnv, ownerId: "UOWNER1", teamId, allowedChannelIds: ["C123456"] },
  };
}

function manifest() {
  return {
    _metadata: { major_version: 1, minor_version: 1 },
    display_information: { name: "Existing app", description: "Keep this app branding", background_color: "#123456" },
    features: {
      bot_user: { display_name: "Existing bot", always_online: true },
      app_home: { home_tab_enabled: true, messages_tab_enabled: true },
      shortcuts: [{ name: "Keep shortcut", callback_id: "keep", description: "Unrelated feature", type: "message" }],
      unfurl_domains: ["example.com"],
      slash_commands: [{ command: "/hermes", description: "Old Hermes command", url: privateUrl, should_escape: true }],
      future_feature: { enabled: true, values: ["keep", "order"] },
    },
    oauth_config: {
      redirect_urls: ["https://example.com/first", "https://example.com/second"],
      scopes: { bot: ["users:read", "chat:write"], user: ["channels:read"], bot_optional: ["reactions:write"] },
      token_management_enabled: true,
    },
    settings: {
      socket_mode_enabled: true, org_deploy_enabled: true, token_rotation_enabled: true,
      event_subscriptions: { bot_events: ["message.im", "reaction_added"], user_events: ["reaction_removed"] },
      interactivity: { is_enabled: true, message_menu_options_url: "https://example.com/options" },
      allowed_ip_address_ranges: ["192.0.2.1", "192.0.2.2"],
    },
    functions: { keep: { title: "Existing function", input_parameters: { required: ["second", "first"], properties: {} } } },
    unknown_future_root: { keep: false, url: "https://example.com/keep", values: [] },
  };
}

interface Call { role: "bot" | "configuration"; method: string; args?: unknown }
interface RemoteOptions {
  auth?: Row;
  bot?: Row;
  validation?: Row;
  updateResponse?: Row;
  onCall?: (call: Call) => void;
  readback?: (value: Row) => unknown;
}

/** Stateful Slack API boundary: update changes the manifest subsequently exported. */
function remote(initial: Row = manifest(), options: RemoteOptions = {}) {
  let state = structuredClone(initial);
  let updates = 0;
  const calls: Call[] = [];
  const clients: { token: string; options: WebClientOptions }[] = [];
  async function call(role: Call["role"], method: string, args?: unknown): Promise<unknown> {
    const entry = { role, method, ...(args === undefined ? {} : { args: structuredClone(args) }) };
    calls.push(entry);
    options.onCall?.(entry);
    if (method === "auth.test") {
      expect(role).toBe("bot");
      return { ok: true, team_id: teamId, user_id: botUserId, bot_id: botId, app_id: appId,
        url: privateUrl, response_metadata: { scopes: ["users:read", "commands", "chat:write"] }, ...options.auth };
    }
    if (method === "bots.info") {
      expect(role).toBe("bot");
      expect(args).toEqual({ bot: botId, team_id: teamId });
      return { ok: true, bot: { id: botId, user_id: botUserId, app_id: appId, deleted: false, icons: { image_36: privateUrl } }, ...options.bot };
    }
    expect(role).toBe("configuration");
    expect((args as Row).app_id).toBe(appId);
    if (method === "apps.manifest.export") return { ok: true, manifest: updates && options.readback ? options.readback(structuredClone(state)) : structuredClone(state) };
    if (method === "apps.manifest.validate") return { ok: true, errors: [], ...options.validation };
    if (method === "apps.manifest.update") {
      state = structuredClone((args as Row).manifest as Row);
      updates++;
      return { ok: true, app_id: appId, permissions_updated: false, ...options.updateResponse };
    }
    throw new Error("Unexpected test API call");
  }
  return {
    calls, clients,
    get state() { return state; },
    get updates() { return updates; },
    createWebClient(token: string, settings: WebClientOptions): SlackCommandClient {
      clients.push({ token, options: settings });
      const role = token === botToken ? "bot" : "configuration";
      expect(token).toBe(role === "bot" ? botToken : manifestToken);
      return {
        auth: { test: () => call(role, "auth.test") },
        bots: { info: args => call(role, "bots.info", args) },
        apps: { manifest: {
          export: args => call(role, "apps.manifest.export", args),
          validate: args => call(role, "apps.manifest.validate", args),
          update: args => call(role, "apps.manifest.update", args),
        } },
      } as SlackCommandClient;
    },
  };
}

function noSecrets(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const secret of [botToken, manifestToken, privateUrl, "https://", "wss://"]) expect(text).not.toContain(secret);
}

async function errorText(action: Promise<unknown>): Promise<string> {
  try { await action; } catch (error) { return String(error); }
  throw new Error("Expected the operation to reject");
}

afterEach(() => {
  for (const [name, value] of environment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  environment.clear();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Slack supported command surface", () => {
  test("uses unique namespaced picker entries without an HTTP request URL", () => {
    expect(new Set(SLACK_COMMANDS.map(command => command.command)).size).toBe(SLACK_COMMANDS.length);
    for (const command of SLACK_COMMANDS) {
      expect(command.command.length).toBeLessThanOrEqual(32);
      expect(command.description).toContain("Superagent");
      expect(command).not.toHaveProperty("url");
    }
  });

  test("accepts only exact names and validates every no-argument command", () => {
    for (const command of MESSENGER_COMMANDS) {
      expect(parseSlackCommand(`/superagent-${command.name}`, " \n ")).toBe(`/${command.name}`);
      expect(parseSlackCommand(`/superagent-${command.name}`, "input")).toBe("text" in command ? `/${command.name} input` : null);
      expect(parseSlackCommand(`/${command.name}`, "")).toBeNull();
      expect(parseSlackCommand(`!${command.name}`, "")).toBeNull();
    }
    for (const name of ["/hermes", "/superagent-models", "/superagent-help extra", "/SUPERAGENT-help", "superagent-help"]) {
      expect(parseSlackCommand(name, "")).toBeNull();
    }
    expect(parseSlackCommand("/superagent-model", "  --global provider/model  ")).toBe("/model --global provider/model");
    expect(parseSlackCommand("/superagent-compact", "  first line\nsecond line  ")).toBe("/compact first line\nsecond line");
    expect(parseSlackCommand("/superagent-new", "start\nwith context")).toBe("/new start\nwith context");
    expect(parseSlackCommand("/superagent-stop", "actual-lane-id")).toBe("/stop actual-lane-id");
  });
});

describe("explicit Slack command registration", () => {
  test("dry-run authenticates the bot, derives the app authoritatively, exports only, and redacts reports", async () => {
    const policy = config();
    const api = remote();
    const result = await registerSlackCommands(policy, { manifestTokenEnv: manifestEnv, ...api });
    expect(result).toMatchObject({ status: "dry-run", teamId, appId, botId, botUserId,
      currentCommands: ["/hermes"], obsoleteCommands: ["/hermes"], changed: true, updated: false,
      manifestReadbackMatched: false, commandsGrant: "granted", requiresReinstall: false, permissionsUpdated: null });
    expect(result.plannedCommands).toEqual(SLACK_COMMANDS);
    expect(api.calls.map(call => call.method)).toEqual(["auth.test", "bots.info", "apps.manifest.export"]);
    expect(api.updates).toBe(0);
    expect(api.state).toEqual(manifest());
    expect(api.clients.map(client => client.token)).toEqual([botToken, manifestToken]);
    for (const client of api.clients) {
      expect(client.options.retryConfig).toEqual({ retries: 0 });
      expect(client.options.rejectRateLimitedCalls).toBe(true);
      expect(client.options.allowAbsoluteUrls).toBe(false);
    }
    expect(api.clients[0]?.options.teamId).toBe(teamId);
    expect(api.clients[1]?.options.teamId).toBeUndefined();
    expect(result.note).toContain("API reads and local comparison only");
    expect(result.note).toContain("active Socket Mode command delivery is not verified");
    noSecrets(result);
  });

  test("apply replaces only this app's slash list, adds commands scope, and confirms full authoritative state", async () => {
    const policy = config();
    const original = manifest();
    const api = remote(original);
    const result = await registerSlackCommands(policy, { manifestTokenEnv: manifestEnv, apply: true, ...api });
    expect(result).toMatchObject({ status: "applied", appId, changed: true, updated: true, manifestReadbackMatched: true });
    expect(api.calls.map(call => call.method)).toEqual([
      "auth.test", "bots.info", "apps.manifest.export", "apps.manifest.validate", "apps.manifest.update", "apps.manifest.export",
    ]);
    const expected = structuredClone(original) as Row;
    (expected.features as Row).slash_commands = SLACK_COMMANDS;
    ((expected.oauth_config as Row).scopes as Row).bot = ["users:read", "chat:write", "commands"];
    expect(api.state).toEqual(expected);
    expect(api.calls.find(call => call.method === "apps.manifest.validate")?.args).toEqual({ app_id: appId, manifest: expected });
    expect(api.calls.find(call => call.method === "apps.manifest.update")?.args).toEqual({ app_id: appId, manifest: expected });
    expect(original).toEqual(manifest());
    expect(api.updates).toBe(1);
    noSecrets(result);
  });

  test("normalizes supported API defaults, object order, command order, and set-valued scope order", async () => {
    const policy = config();
    const original = manifest();
    const api = remote(original, { readback(value) {
      const features = value.features as Row;
      features.slash_commands = [...(features.slash_commands as Row[])].reverse().map(command => {
        const { should_escape: _default, ...rest } = command;
        return { usage_hint: "", url: "", ...rest };
      });
      ((value.oauth_config as Row).scopes as Row).bot = ["commands", "chat:write", "users:read"];
      ((value.settings as Row).event_subscriptions as Row).bot_events = ["reaction_added", "message.im"];
      (value.settings as Row).is_hosted = false;
      return Object.fromEntries(Object.entries(value).reverse());
    } });
    expect((await registerSlackCommands(policy, { manifestTokenEnv: manifestEnv, apply: true, ...api })).manifestReadbackMatched).toBe(true);
  });

  test("an already exact app needs no validation or update", async () => {
    const policy = config();
    const current = manifest() as Row;
    (current.features as Row).slash_commands = SLACK_COMMANDS;
    ((current.oauth_config as Row).scopes as Row).bot = ["commands", "users:read", "chat:write"];
    const api = remote(current);
    const result = await registerSlackCommands(policy, { manifestTokenEnv: manifestEnv, apply: true, ...api });
    expect(result).toMatchObject({ status: "applied", changed: false, updated: false, manifestReadbackMatched: true });
    expect(api.calls.map(call => call.method)).toEqual(["auth.test", "bots.info", "apps.manifest.export"]);
  });

  test("requires explicit configuration credentials even when bot and Socket Mode credentials exist", async () => {
    const policy = config();
    setEnv(manifestEnv);
    setEnv(appEnv, "private-socket-credential");
    const api = remote();
    await expect(registerSlackCommands(policy, { manifestTokenEnv: manifestEnv, ...api })).rejects.toThrow("app configuration credential is missing");
    for (const name of ["", "--apply", "literal-token-with-hyphens"]) {
      await expect(registerSlackCommands(policy, { manifestTokenEnv: name, ...api })).rejects.toThrow("--manifest-token-env NAME");
    }
    expect(api.clients).toHaveLength(0);
    expect(api.calls).toHaveLength(0);
  });

  test("resolves only Slack bot and explicitly named sibling entries without environment mutation", async () => {
    const policy = config();
    setEnv(botEnv);
    setEnv(manifestEnv);
    policy.discord = { tokenEnv: otherEnv, ownerId: "123456", allowedGuildIds: [], allowedChannelIds: [] };
    policy.telegram = { tokenEnv: "MISSING_UNRELATED_TELEGRAM", ownerId: "123456", allowedChatIds: [] };
    writeFileSync(`${policy.path}.env`, `${botEnv}=${botToken}\n${manifestEnv}=${manifestToken}\n${appEnv}=private-app-token\n${otherEnv}=unrelated-secret\n`, { mode: 0o600 });
    const api = remote();
    await registerSlackCommands(policy, { manifestTokenEnv: manifestEnv, ...api });
    for (const name of [botEnv, manifestEnv, appEnv, otherEnv]) expect(process.env[name]).toBeUndefined();
    expect(api.clients.map(client => client.token)).toEqual([botToken, manifestToken]);
  });

  test("nonempty explicit environment takes precedence over sibling credentials", async () => {
    const policy = config();
    writeFileSync(`${policy.path}.env`, `${botEnv}=wrong-bot\n${manifestEnv}=wrong-configuration\n`, { mode: 0o600 });
    const api = remote();
    await registerSlackCommands(policy, { manifestTokenEnv: manifestEnv, ...api });
    expect(api.clients.map(client => client.token)).toEqual([botToken, manifestToken]);
  });

  test("wrong workspace, user/bot binding, deleted bot, or contradictory app identity cannot reach manifest APIs", async () => {
    const policy = config();
    for (const options of [
      { auth: { team_id: "TOTHER1" } },
      { auth: { bot_id: undefined } },
      { bot: { bot: { id: "BOTHER1", user_id: botUserId, app_id: appId } } },
      { bot: { bot: { id: botId, user_id: "UOTHER1", app_id: appId } } },
      { bot: { bot: { id: botId, user_id: botUserId, app_id: appId, deleted: true } } },
      { bot: { bot: { id: botId, user_id: botUserId, app_id: "AOTHER1" } } },
      { bot: { bot: { id: botId, user_id: botUserId } } },
    ]) {
      const api = remote(manifest(), options);
      const error = await errorText(registerSlackCommands(policy, { manifestTokenEnv: manifestEnv, apply: true, ...api }));
      expect(error).toContain("workspace, bot/app identity");
      expect(error).toContain("No mutation was attempted");
      expect(api.calls.some(call => call.method.startsWith("apps.manifest."))).toBe(false);
      noSecrets(error);
    }
  });

  test("bots.info provides authoritative app identity when auth.test has no app_id", async () => {
    const policy = config();
    const api = remote(manifest(), { auth: { app_id: undefined } });
    expect((await registerSlackCommands(policy, { manifestTokenEnv: manifestEnv, ...api })).appId).toBe(appId);
    expect(api.calls.at(-1)?.args).toEqual({ app_id: appId });
  });

  test("requires Socket Mode already enabled and never invents an HTTP endpoint", async () => {
    const policy = config();
    for (const socketMode of [false, undefined]) {
      const current = manifest() as Row;
      (current.settings as Row).socket_mode_enabled = socketMode;
      const api = remote(current);
      await expect(registerSlackCommands(policy, { manifestTokenEnv: manifestEnv, apply: true, ...api })).rejects.toThrow("Socket Mode");
      expect(api.updates).toBe(0);
      expect(api.calls.some(call => call.method === "apps.manifest.validate")).toBe(false);
    }
  });

  test("validation failure redacts raw errors and never attempts update", async () => {
    const policy = config();
    const api = remote(manifest(), { validation: { ok: false, errors: [{ message: `${manifestToken} ${botToken} ${privateUrl}` }] } });
    const error = await errorText(registerSlackCommands(policy, { manifestTokenEnv: manifestEnv, apply: true, ...api }));
    expect(error).toContain("No mutation was attempted");
    expect(api.updates).toBe(0);
    expect(api.calls.filter(call => call.method === "apps.manifest.validate")).toHaveLength(1);
    noSecrets(error);
  });

  test("inspection and SDK initialization errors suppress configuration tokens and response URLs", async () => {
    const policy = config();
    const secretError = new Error(`${manifestToken} ${botToken} ${privateUrl}`);
    const api = remote(manifest(), { onCall(call) { if (call.method === "apps.manifest.export") throw secretError; } });
    const error = await errorText(registerSlackCommands(policy, { manifestTokenEnv: manifestEnv, apply: true, ...api }));
    expect(error).toContain("No mutation was attempted");
    expect(api.calls.filter(call => call.method === "apps.manifest.export")).toHaveLength(1);
    noSecrets(error);
    const initialization = await errorText(registerSlackCommands(policy, {
      manifestTokenEnv: manifestEnv, createWebClient() { throw secretError; },
    }));
    expect(initialization).toContain("initialization failed");
    noSecrets(initialization);
  });

  test("update transport failure preserves uncertainty and never retries or continues to readback", async () => {
    const policy = config();
    const api = remote(manifest(), { onCall(call) {
      if (call.method === "apps.manifest.update") throw { message: `${manifestToken} ${privateUrl}`, code: "slack_webapi_request_error" };
    } });
    const error = await errorText(registerSlackCommands(policy, { manifestTokenEnv: manifestEnv, apply: true, ...api }));
    expect(error).toContain("outcome is uncertain");
    expect(error).toContain("no automatic retry");
    expect(api.calls.filter(call => call.method === "apps.manifest.update")).toHaveLength(1);
    expect(api.calls.at(-1)?.method).toBe("apps.manifest.update");
    noSecrets(error);
  });

  test("unsuccessful, wrong-target, and incomplete update acknowledgments are uncertain without retries", async () => {
    const policy = config();
    for (const response of [{ ok: false, error: manifestToken }, { app_id: "AOTHER1" }, { permissions_updated: undefined }]) {
      const api = remote(manifest(), { updateResponse: response });
      const error = await errorText(registerSlackCommands(policy, { manifestTokenEnv: manifestEnv, apply: true, ...api }));
      expect(error).toContain("outcome is uncertain");
      expect(api.updates).toBe(1);
      expect(api.calls.at(-1)?.method).toBe("apps.manifest.update");
      noSecrets(error);
    }
  });

  test("authoritative readback must match commands and every unrelated field", async () => {
    const policy = config();
    const changes: ((value: Row) => unknown)[] = [
      value => { (value.features as Row).slash_commands = []; return value; },
      value => { ((value.features as Row).slash_commands as Row[]).push({ command: "/hermes", description: "Stale" }); return value; },
      value => { (((value.features as Row).slash_commands as Row[])[0] as Row).description = "Wrong description"; return value; },
      value => { (((value.features as Row).slash_commands as Row[])[0] as Row).should_escape = true; return value; },
      value => { (((value.features as Row).slash_commands as Row[])[0] as Row).url = privateUrl; return value; },
      value => { delete value.unknown_future_root; return value; },
      value => { (value.display_information as Row).name = "Wrong app branding"; return value; },
      value => { ((value.oauth_config as Row).scopes as Row).user = []; return value; },
      value => { (value.settings as Row).token_rotation_enabled = false; return value; },
      value => { ((value.features as Row).future_feature as Row).values = ["order", "keep"]; return value; },
      value => { (((value.functions as Row).keep as Row).input_parameters as Row).required = ["first", "second"]; return value; },
    ];
    for (const readback of changes) {
      const api = remote(manifest(), { readback });
      const error = await errorText(registerSlackCommands(policy, { manifestTokenEnv: manifestEnv, apply: true, ...api }));
      expect(error).toContain("authoritative readback failed or differed");
      expect(error).toContain("Outcome uncertain");
      expect(api.updates).toBe(1);
      expect(api.calls.filter(call => call.method === "apps.manifest.export")).toHaveLength(2);
      noSecrets(error);
    }
  });

  test("readback transport failure cannot report the mutation as verified", async () => {
    const policy = config();
    let exports = 0;
    const api = remote(manifest(), { onCall(call) {
      if (call.method === "apps.manifest.export" && ++exports === 2) throw new Error(`${manifestToken} ${privateUrl}`);
    } });
    const error = await errorText(registerSlackCommands(policy, { manifestTokenEnv: manifestEnv, apply: true, ...api }));
    expect(error).toContain("update may have succeeded");
    expect(api.updates).toBe(1);
    expect(exports).toBe(2);
    noSecrets(error);
  });

  test("missing installed grant honestly requires reinstall despite matching requested manifest scopes", async () => {
    const policy = config();
    const current = manifest() as Row;
    ((current.oauth_config as Row).scopes as Row).bot = ["commands", "users:read"];
    const api = remote(current, { auth: { response_metadata: { scopes: ["users:read"] } } });
    const result = await registerSlackCommands(policy, { manifestTokenEnv: manifestEnv, apply: true, ...api });
    expect(result).toMatchObject({ commandsGrant: "missing", requiresReinstall: true, manifestReadbackMatched: true });
    expect(result.note).toContain("Reinstall or reauthorize");
    expect(result.note).toContain("does not establish active command delivery");
    expect(result).not.toHaveProperty("active");
    expect(result).not.toHaveProperty("verified");
  });

  test("permissions_updated requires reinstall and missing scope metadata stays unknown", async () => {
    const policy = config();
    const permissions = remote(manifest(), { updateResponse: { permissions_updated: true } });
    expect((await registerSlackCommands(policy, { manifestTokenEnv: manifestEnv, apply: true, ...permissions })).requiresReinstall).toBe(true);
    const unknown = remote(manifest(), { auth: { response_metadata: undefined } });
    const result = await registerSlackCommands(policy, { manifestTokenEnv: manifestEnv, ...unknown });
    expect(result).toMatchObject({ commandsGrant: "unknown", requiresReinstall: null });
    expect(result.note).toContain("Installed commands scope could not be confirmed");
  });

  test("installed official WebClient serializes the actual manifest APIs with distinct credentials", async () => {
    const policy = config();
    let state: Row = manifest();
    const requests: { method: string; token: string; body: Record<string, string> }[] = [];
    const result = await registerSlackCommands(policy, {
      apply: true, manifestTokenEnv: manifestEnv,
      createWebClient(token, settings) {
        return new WebClient(token, { ...settings, fetch: async (url, init) => {
          const method = new URL(String(url)).pathname.split("/").at(-1)!;
          const authorization = new Headers(init?.headers).get("authorization") ?? "";
          const form = new URLSearchParams(String(init?.body));
          const body = Object.fromEntries(form);
          requests.push({ method, token: authorization, body });
          let response: Row;
          if (method === "auth.test") response = { ok: true, team_id: teamId, bot_id: botId, user_id: botUserId };
          else if (method === "bots.info") response = { ok: true, bot: { id: botId, user_id: botUserId, app_id: appId } };
          else if (method === "apps.manifest.export") response = { ok: true, manifest: state };
          else if (method === "apps.manifest.validate") response = { ok: true, errors: [] };
          else if (method === "apps.manifest.update") {
            state = JSON.parse(body.manifest!) as Row;
            response = { ok: true, app_id: appId, permissions_updated: false };
          } else throw new Error("Unexpected official SDK method");
          return new Response(JSON.stringify(response), { headers: { "content-type": "application/json", "x-oauth-scopes": "commands,users:read" } });
        } });
      },
    });
    expect(result).toMatchObject({ updated: true, manifestReadbackMatched: true, commandsGrant: "granted" });
    expect(requests.map(request => request.method)).toEqual([
      "auth.test", "bots.info", "apps.manifest.export", "apps.manifest.validate", "apps.manifest.update", "apps.manifest.export",
    ]);
    for (const request of requests) {
      expect(request.token).toBe(`Bearer ${request.method.startsWith("apps.manifest.") ? manifestToken : botToken}`);
      if (request.method.startsWith("apps.manifest.")) expect(request.body.app_id).toBe(appId);
      expect(request.body).not.toHaveProperty("token");
    }
    expect(JSON.parse(requests.find(request => request.method === "apps.manifest.update")!.body.manifest!).features.slash_commands).toEqual(SLACK_COMMANDS);
    noSecrets(result);
  });
});
