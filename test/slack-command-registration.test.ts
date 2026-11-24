import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config";
import { MESSENGER_COMMANDS } from "../src/messenger-commands";
import { registerSlackCommands } from "../src/slack-command-registration";
import { loopbackOperator } from "./fixtures/operator";

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
const expectedCommands = MESSENGER_COMMANDS.map(command => ({
  command: `/superagent-${command.name}`,
  description: command.description,
  ...(command.text === undefined ? {} : { usage_hint: command.text }),
  should_escape: false,
}));

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

interface Call {
  method: string;
  token: string;
  form: Record<string, string>;
  args: Row;
}
interface RemoteOptions {
  auth?: Row;
  bot?: Row;
  authHeaders?: Record<string, string>;
  botHeaders?: Record<string, string>;
  validation?: Row;
  updateResponse?: Row;
  onCall?: (call: Call, request: Request) => Response | undefined;
  readback?: (value: Row) => unknown;
}

/** Stateful Slack Web API wire fixture: update changes the manifest subsequently exported. */
function remote(initial: Row = manifest(), options: RemoteOptions = {}) {
  let state = structuredClone(initial);
  let updates = 0;
  const calls: Call[] = [];
  const run = loopbackOperator(async request => {
    const path = new URL(request.url).pathname;
    expect(path.startsWith("/api/")).toBe(true);
    const method = path.slice("/api/".length);
    expect(request.method).toBe("POST");
    expect(request.headers.get("content-type")).toContain("application/x-www-form-urlencoded");
    const token = request.headers.get("authorization") ?? "";
    const form = Object.fromEntries(new URLSearchParams(await request.text()));
    const args: Row = { ...form };
    const wireManifest = form["manifest"];
    if (wireManifest !== undefined) args.manifest = JSON.parse(wireManifest);
    const entry = { method, token, form, args };
    calls.push(entry);
    expect(form).not.toHaveProperty("token");
    const override = options.onCall?.(entry, request);
    if (override) return override;
    if (method === "auth.test") {
      expect(token).toBe(`Bearer ${botToken}`);
      expect(args).toEqual({ team_id: teamId });
      return Response.json({ ok: true, team_id: teamId, user_id: botUserId, bot_id: botId, app_id: appId,
        url: privateUrl, ...options.auth }, { headers: options.authHeaders ?? { "x-oauth-scopes": "users:read, commands, chat:write" } });
    }
    if (method === "bots.info") {
      expect(token).toBe(`Bearer ${botToken}`);
      expect(args).toEqual({ bot: botId, team_id: teamId });
      return Response.json({ ok: true, bot: { id: botId, user_id: botUserId, app_id: appId, deleted: false, icons: { image_36: privateUrl } }, ...options.bot },
        { headers: options.botHeaders });
    }
    expect(token).toBe(`Bearer ${manifestToken}`);
    expect(args.app_id).toBe(appId);
    expect(args).not.toHaveProperty("team_id");
    if (method === "apps.manifest.export") return Response.json({ ok: true, manifest: updates && options.readback ? options.readback(structuredClone(state)) : structuredClone(state) });
    if (method === "apps.manifest.validate") return Response.json({ ok: true, errors: [], ...options.validation });
    if (method === "apps.manifest.update") {
      const submitted = args.manifest;
      if (!submitted || typeof submitted !== "object" || Array.isArray(submitted)) throw new Error("Expected an object manifest");
      state = structuredClone(submitted) as Row;
      updates++;
      return Response.json({ ok: true, app_id: appId, permissions_updated: false, ...options.updateResponse });
    }
    throw new Error("Unexpected test API call");
  });
  return {
    calls, run,
    get state() { return state; },
    get updates() { return updates; },
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

describe("explicit Slack command registration", () => {
  test("dry-run authenticates the bot, derives the app authoritatively, exports only, and redacts reports", async () => {
    const policy = config();
    const api = remote();
    const result = await registerSlackCommands(policy, { manifestTokenEnv: manifestEnv, ...api });
    expect(result).toMatchObject({ status: "dry-run", teamId, appId, botId, botUserId,
      currentCommands: ["/hermes"], obsoleteCommands: ["/hermes"], changed: true, updated: false,
      manifestReadbackMatched: false, commandsGrant: "granted", requiresReinstall: false, permissionsUpdated: null });
    expect(result.plannedCommands).toEqual(expectedCommands);
    expect(new Set(result.plannedCommands.map(command => command.command)).size).toBe(result.plannedCommands.length);
    for (const command of result.plannedCommands) {
      expect(command.command.length).toBeLessThanOrEqual(32);
      expect(command.description).toContain("Superagent");
      expect(command).not.toHaveProperty("url");
    }
    expect(api.calls.map(call => call.method)).toEqual(["auth.test", "bots.info", "apps.manifest.export"]);
    expect(api.updates).toBe(0);
    expect(api.state).toEqual(manifest());
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
    (expected.features as Row).slash_commands = expectedCommands;
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
    (current.features as Row).slash_commands = expectedCommands;
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
    for (const name of [appEnv, botEnv]) {
      await expect(registerSlackCommands(policy, { manifestTokenEnv: name, ...api })).rejects.toThrow("distinct explicit Slack app configuration credential");
    }
    setEnv(manifestEnv, botToken);
    await expect(registerSlackCommands(policy, { manifestTokenEnv: manifestEnv, ...api })).rejects.toThrow("distinct explicit Slack app configuration credential");
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
    expect([...new Set(api.calls.map(call => call.token))]).toEqual([`Bearer ${botToken}`, `Bearer ${manifestToken}`]);
  });

  test("nonempty explicit environment takes precedence over sibling credentials", async () => {
    const policy = config();
    writeFileSync(`${policy.path}.env`, `${botEnv}=wrong-bot\n${manifestEnv}=wrong-configuration\n`, { mode: 0o600 });
    const api = remote();
    await registerSlackCommands(policy, { manifestTokenEnv: manifestEnv, ...api });
    expect([...new Set(api.calls.map(call => call.token))]).toEqual([`Bearer ${botToken}`, `Bearer ${manifestToken}`]);
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
    const message = `${manifestToken} ${botToken} ${privateUrl}`;
    for (const validation of [
      { ok: false, errors: [{ message }] },
      { ok: true, errors: [{ message }] },
      { ok: true, errors: null },
    ]) {
      const api = remote(manifest(), { validation });
      const error = await errorText(registerSlackCommands(policy, { manifestTokenEnv: manifestEnv, apply: true, ...api }));
      expect(error).toContain("Slack manifest validation failed. No mutation was attempted");
      expect(api.updates).toBe(0);
      expect(api.calls.filter(call => call.method === "apps.manifest.validate")).toHaveLength(1);
      expect(api.calls.at(-1)?.method).toBe("apps.manifest.validate");
      noSecrets(error);
    }
  });

  test("inspection HTTP errors suppress configuration tokens and response URLs", async () => {
    const policy = config();
    const api = remote(manifest(), { onCall(call) {
      if (call.method === "apps.manifest.export") return new Response(`${manifestToken} ${botToken} ${privateUrl}`, { status: 502 });
    } });
    const error = await errorText(registerSlackCommands(policy, { manifestTokenEnv: manifestEnv, apply: true, ...api }));
    expect(error).toContain("No mutation was attempted");
    expect(api.calls.filter(call => call.method === "apps.manifest.export")).toHaveLength(1);
    noSecrets(error);
  });

  test("failed, rate-limited, and redirected update requests stay uncertain without retry, redirect, or readback", async () => {
    const policy = config();
    for (const status of [502, 429, 307]) {
      const api = remote(manifest(), { onCall(call, request) {
        if (call.method !== "apps.manifest.update") return undefined;
        const headers: Record<string, string> = status === 307
          ? { location: new URL("/api/not-authorized", request.url).href }
          : { "retry-after": "0" };
        return new Response(`${manifestToken} ${privateUrl}`, { status, headers });
      } });
      const error = await errorText(registerSlackCommands(policy, { manifestTokenEnv: manifestEnv, apply: true, ...api }));
      expect(error).toContain("outcome is uncertain");
      expect(error).toContain("no automatic retry");
      expect(api.calls.filter(call => call.method === "apps.manifest.update")).toHaveLength(1);
      expect(api.calls.at(-1)?.method).toBe("apps.manifest.update");
      noSecrets(error);
    }
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

  test("failed readback cannot report the mutation as verified", async () => {
    const policy = config();
    let exports = 0;
    const api = remote(manifest(), { onCall(call) {
      if (call.method === "apps.manifest.export" && ++exports === 2)
        return new Response(`${manifestToken} ${privateUrl}`, { status: 502 });
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
    const api = remote(current, {
      auth: { response_metadata: { scopes: ["commands"] } },
      authHeaders: { "x-oauth-scopes": "users:read, commands:write" },
      botHeaders: { "x-oauth-scopes": "commands, users:read" },
    });
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
    const unknown = remote(manifest(), { authHeaders: { "x-accepted-oauth-scopes": "commands" } });
    const result = await registerSlackCommands(policy, { manifestTokenEnv: manifestEnv, ...unknown });
    expect(result).toMatchObject({ commandsGrant: "unknown", requiresReinstall: null });
    expect(result.note).toContain("Installed commands scope could not be confirmed");
    const secondary = remote(manifest(), { authHeaders: {}, botHeaders: { "x-oauth-scopes": "users:read, commands" } });
    expect((await registerSlackCommands(policy, { manifestTokenEnv: manifestEnv, ...secondary })).commandsGrant).toBe("granted");
  });

  test("native Web API form serialization sends only the intended app manifest and no token in the form", async () => {
    const policy = config();
    const api = remote({
      display_information: { name: "Keep socket app + café" },
      settings: { socket_mode_enabled: true },
    });
    const result = await registerSlackCommands(policy, { apply: true, manifestTokenEnv: manifestEnv, ...api });
    expect(result).toMatchObject({ updated: true, currentCommands: [], manifestReadbackMatched: true, commandsGrant: "granted" });
    const serialized = api.calls.find(call => call.method === "apps.manifest.update")?.form["manifest"];
    if (serialized === undefined) throw new Error("Missing serialized manifest");
    expect(JSON.parse(serialized)).toEqual({
      display_information: { name: "Keep socket app + café" },
      settings: { socket_mode_enabled: true },
      features: { slash_commands: expectedCommands },
      oauth_config: { scopes: { bot: ["commands"] } },
    });
    expect(api.calls.map(call => Object.keys(call.form).sort())).toEqual([
      ["team_id"], ["bot", "team_id"], ["app_id"], ["app_id", "manifest"], ["app_id", "manifest"], ["app_id"],
    ]);
    noSecrets(result);
  });

  test("manifest publication preserves nested numeric literals and readback compares their numeric values", async () => {
    const policy = config();
    const exported = `{
      "display_information": {"name":"Keep precision"},
      "settings": {"socket_mode_enabled":true},
      "features": {"future":[51.248178375505404,{"integer":18446744073709551617}]},
      "oauth_config": {"scopes":{"future":{"precision":1.0000000000000001e+33}}},
      "functions": {"keep":{"default":[1.00,-0]}}
    }`;
    for (const changed of [false, true]) {
      let submitted: string | undefined;
      const api = remote({}, { onCall(call) {
        if (call.method === "apps.manifest.update") submitted = call.form["manifest"];
        if (call.method !== "apps.manifest.export") return;
        const manifest = submitted?.replace(
          "51.248178375505404", changed ? "51.24817837550541" : "51248178375505404e-15",
        ).replace("[1.00,-0]", "[1,0]") ?? exported;
        return new Response(`{"ok":true,"manifest":${manifest}}`, { headers: { "content-type": "application/json" } });
      } });
      const action = registerSlackCommands(policy, { apply: true, manifestTokenEnv: manifestEnv, ...api });
      if (changed) {
        await expect(action).rejects.toThrow("authoritative readback failed or differed");
      } else {
        expect((await action).manifestReadbackMatched).toBe(true);
      }
      for (const method of ["apps.manifest.validate", "apps.manifest.update"]) {
        const wire = api.calls.find(call => call.method === method)?.form["manifest"];
        if (wire === undefined) throw new Error(`Missing submitted manifest for ${method}`);
        for (const fragment of ["51.248178375505404", "18446744073709551617", "1.0000000000000001e+33", "[1.00,-0]"]) {
          expect(wire).toContain(fragment);
        }
      }
    }
  });
});
