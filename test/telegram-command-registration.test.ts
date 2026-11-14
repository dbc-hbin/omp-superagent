import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Api } from "grammy";
import type { BotCommand, BotCommandScopeChat, BotCommandScopeChatMember } from "grammy/types";
import type { Config } from "../src/config";
import { MESSENGER_COMMANDS } from "../src/messenger-commands";
import { registerTelegramCommands } from "../src/telegram-command-registration";

const tokenName = "TELEGRAM_MENU_TEST_TOKEN";
const discordTokenName = "TELEGRAM_MENU_OTHER_DISCORD";
const slackTokenName = "TELEGRAM_MENU_OTHER_SLACK";
const token = "900:PRIVATE_LOCAL_MENU_TEST_TOKEN";
const ownerScope: BotCommandScopeChat = { type: "chat", chat_id: "42" };
const groupScope: BotCommandScopeChatMember = { type: "chat_member", chat_id: "-100", user_id: 42 };
const expectedCommands = () => MESSENGER_COMMANDS.map(command => ({ command: command.name, description: command.description }));
const directories: string[] = [];
const environment = new Map<string, string | undefined>();

function setEnvironment(name: string, value?: string) {
  if (!environment.has(name)) environment.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function fixture(allowedChatIds = ["-100"]): Config {
  const directory = mkdtempSync(join(tmpdir(), "superagent-telegram-commands-"));
  directories.push(directory);
  setEnvironment(tokenName, token);
  return {
    path: join(directory, "config.json"), stateDir: join(directory, "state"), headCwd: directory,
    command: ["must-not-start"], maxHosts: 4, maxSubagents: 8, idleMs: 300000,
    telegram: { tokenEnv: tokenName, ownerId: "42", allowedChatIds },
  };
}

function menuKey(scope: unknown, language = "") { return JSON.stringify([scope, language]); }

// Exercise installed grammY's real methods/serialization at its supported HTTP
// boundary. No Telegram request, poller, webhook, or native runtime is started.
class TelegramMenusHttp {
  readonly calls: { method: string; payload: Record<string, unknown>; init: RequestInit }[] = [];
  readonly menus = new Map<string, unknown>();
  readonly chats = new Map<string, Record<string, unknown>>();
  readonly members = new Map<string, Record<string, unknown>>();
  readonly failures = new Map<string, unknown>();
  identity: Record<string, unknown> = { id: 900, is_bot: true, first_name: "Local", username: "local_test_bot" };
  afterSet?: (http: TelegramMenusHttp, payload: Record<string, unknown>) => void;
  credential: string | undefined;
  private readonly fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const method = String(input).split("/").at(-1)!;
    const payload = typeof init.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    this.calls.push({ method, payload, init });
    if (this.failures.has(method)) {
      const failure = this.failures.get(method); this.failures.delete(method);
      if (failure instanceof Error) throw failure;
      return Response.json({ ok: false, error_code: 400, description: "private failure", ...failure as object });
    }
    let result: unknown;
    if (method === "getMe") result = this.identity;
    else if (method === "getChat") {
      const id = String(payload.chat_id);
      result = this.chats.get(id) ?? (id === "42" ? { id: 42, type: "private", first_name: "Owner" } :
        { id: Number(id), type: "supergroup", title: "Allowed", is_forum: true });
    } else if (method === "getChatMember") result = this.members.get(String(payload.chat_id)) ?? {
      status: "member", user: { id: 42, is_bot: false, first_name: "Owner" },
    };
    else if (method === "getMyCommands") result = this.menus.get(menuKey(payload.scope, String(payload.language_code ?? ""))) ?? [];
    else if (method === "setMyCommands") {
      this.menus.set(menuKey(payload.scope, String(payload.language_code ?? "")), structuredClone(payload.commands));
      this.afterSet?.(this, payload);
      result = true;
    } else throw new Error(`Forbidden API method: ${method}`);
    return Response.json({ ok: true, result });
  }) as typeof fetch;
  readonly createApi = (credential: string) => {
    this.credential = credential;
    return new Api(credential, { fetch: this.fetch, sensitiveLogs: false, baseFetchConfig: { redirect: "error" } });
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

describe("explicit owner-scoped Telegram command menus", () => {
  test("dry-run inspects actual owner DM, groups, membership and menus without mutation", async () => {
    const config = fixture(["-100", "-101", "-100"]);
    const http = new TelegramMenusHttp();
    http.chats.set("-101", { id: -101, type: "group", title: "Other allowed group" });
    const report = await registerTelegramCommands(config, { createApi: http.createApi });
    expect(report.status).toBe("dry-run");
    expect(report.botId).toBe("900");
    expect(report.languageCode).toBeNull();
    expect(report.plannedCommands).toEqual(expectedCommands());
    expect(report.scopes.map(target => target.scope)).toEqual([
      ownerScope, groupScope, { type: "chat_member", chat_id: "-101", user_id: 42 },
    ]);
    expect(http.calls.map(call => call.method)).toEqual([
      "getMe", "getChat", "getChat", "getChatMember", "getChat", "getChatMember",
      "getMyCommands", "getMyCommands", "getMyCommands",
    ]);
    expect(http.calls.filter(call => call.method === "getChatMember").map(call => call.payload)).toEqual([
      { chat_id: "-100", user_id: 42 }, { chat_id: "-101", user_id: 42 },
    ]);
    expect(http.calls.every(call => !Object.hasOwn(call.payload, "language_code"))).toBe(true);
    expect(report.note).toContain("unknown and untouched");
    expect(report.note).toContain("cannot enumerate");
  });

  test("apply replaces only owner scopes and verifies exact command names/descriptions/order", async () => {
    const config = fixture(); const http = new TelegramMenusHttp();
    const unrelated = [
      menuKey({ type: "default" }), menuKey({ type: "all_private_chats" }),
      menuKey({ type: "chat", chat_id: "-100" }), menuKey({ type: "chat_member", chat_id: "-100", user_id: 43 }),
      menuKey(ownerScope, "ko"), menuKey(groupScope, "ko"),
    ];
    for (const key of [...unrelated, menuKey(ownerScope), menuKey(groupScope)]) {
      http.menus.set(key, [{ command: "old", description: "Old menu" }]);
    }
    const report = await registerTelegramCommands(config, { apply: true, createApi: http.createApi });
    expect(report.status).toBe("applied");
    const writes = http.calls.filter(call => call.method === "setMyCommands");
    expect(writes.map(call => call.payload)).toEqual([
      { commands: expectedCommands(), scope: ownerScope }, { commands: expectedCommands(), scope: groupScope },
    ]);
    expect(http.calls.slice(-4).map(call => call.method)).toEqual(["setMyCommands", "getMyCommands", "setMyCommands", "getMyCommands"]);
    for (const scope of [ownerScope, groupScope]) expect(http.menus.get(menuKey(scope))).toEqual(expectedCommands());
    for (const key of unrelated) expect(http.menus.get(key)).toEqual([{ command: "old", description: "Old menu" }]);
    expect(JSON.stringify(report)).not.toContain(token);
  });

  test("language selector is applied consistently, while all other languages remain untouched", async () => {
    const config = fixture(); const http = new TelegramMenusHttp();
    http.menus.set(menuKey(ownerScope), [{ command: "original", description: "Default" }]);
    const report = await registerTelegramCommands(config, { apply: true, languageCode: "ko", createApi: http.createApi });
    expect(report.languageCode).toBe("ko");
    const menuCalls = http.calls.filter(call => call.method.endsWith("MyCommands"));
    expect(menuCalls).toHaveLength(6);
    expect(menuCalls.every(call => call.payload.language_code === "ko")).toBe(true);
    expect(http.menus.get(menuKey(ownerScope))).toEqual([{ command: "original", description: "Default" }]);
    const fallback = new TelegramMenusHttp();
    await registerTelegramCommands(config, { languageCode: "", createApi: fallback.createApi });
    expect(fallback.calls.filter(call => call.method === "getMyCommands").every(call => !Object.hasOwn(call.payload, "language_code"))).toBe(true);
  });

  test("already exact lists are read and reported verified without needless writes", async () => {
    const config = fixture(); const http = new TelegramMenusHttp();
    for (const scope of [ownerScope, groupScope]) http.menus.set(menuKey(scope), expectedCommands());
    const report = await registerTelegramCommands(config, { apply: true, createApi: http.createApi });
    expect(report.status).toBe("applied");
    expect(report.scopes.every(target => !target.changed)).toBe(true);
    expect(http.calls.some(call => call.method === "setMyCommands")).toBe(false);
  });

  test("foreign chats, channels, and absent/incorrect owner membership fail before all writes", async () => {
    for (const change of [
      (http: TelegramMenusHttp) => { http.identity = { ...http.identity, is_bot: false }; },
      (http: TelegramMenusHttp) => { http.chats.set("42", { id: 43, type: "private" }); },
      (http: TelegramMenusHttp) => { http.chats.set("42", { id: 42, type: "group" }); },
      (http: TelegramMenusHttp) => { http.chats.set("-100", { id: -101, type: "supergroup" }); },
      (http: TelegramMenusHttp) => { http.chats.set("-100", { id: -100, type: "channel" }); },
      (http: TelegramMenusHttp) => { http.chats.set("-100", { id: -100, type: "supergroup", is_direct_messages: true }); },
      ...["left", "kicked", "restricted"].map(status => (http: TelegramMenusHttp) => {
        http.members.set("-100", { status, is_member: false, user: { id: 42, is_bot: false } });
      }),
      (http: TelegramMenusHttp) => { http.members.set("-100", { status: "member", user: { id: 43, is_bot: false } }); },
      (http: TelegramMenusHttp) => { http.members.set("-100", { status: "member", user: { id: 42, is_bot: true } }); },
    ]) {
      const config = fixture(); const http = new TelegramMenusHttp(); change(http);
      await expect(registerTelegramCommands(config, { apply: true, createApi: http.createApi })).rejects.toThrow("No mutation was attempted");
      expect(http.calls.some(call => call.method === "setMyCommands")).toBe(false);
    }
  });

  test("present restricted members and administrators are valid owner-specific group targets", async () => {
    for (const status of ["creator", "administrator", "restricted"]) {
      const config = fixture(); const http = new TelegramMenusHttp();
      http.members.set("-100", { status, is_member: true, user: { id: 42, is_bot: false } });
      const report = await registerTelegramCommands(config, { createApi: http.createApi });
      expect(report.scopes[1]!.scope).toEqual(groupScope);
    }
  });

  test("credentials use only the configured Telegram env/file precedence", async () => {
    const config = fixture([]);
    config.discord = { tokenEnv: discordTokenName, ownerId: "123", allowedChannelIds: [], allowedGuildIds: [] };
    config.slack = { botTokenEnv: slackTokenName, appTokenEnv: `${slackTokenName}_APP`, ownerId: "UOWNER", teamId: "TTEAM", allowedChannelIds: [] };
    for (const name of [discordTokenName, slackTokenName, `${slackTokenName}_APP`]) setEnvironment(name);
    writeFileSync(`${config.path}.env`, `${tokenName}=900:FILE_ONLY\n${discordTokenName}=private-other\n${slackTokenName}=private-slack\n`, { mode: 0o600 });
    const first = new TelegramMenusHttp();
    await registerTelegramCommands(config, { createApi: first.createApi });
    expect(first.credential).toBe(token);
    setEnvironment(tokenName, "");
    const second = new TelegramMenusHttp();
    await registerTelegramCommands(config, { createApi: second.createApi });
    expect(second.credential).toBe("900:FILE_ONLY");
    for (const name of [discordTokenName, slackTokenName, `${slackTokenName}_APP`]) expect(process.env[name]).toBeUndefined();
  });

  test("invalid language, missing platform, and invalid credentials fail before API initialization", async () => {
    const config = fixture(); const http = new TelegramMenusHttp();
    for (const languageCode of ["eng", "KO", "zz", "xx", "../private", token]) {
      await expect(registerTelegramCommands(config, { languageCode, createApi: http.createApi })).rejects.toThrow("language");
    }
    await expect(registerTelegramCommands({ ...config, telegram: undefined }, { createApi: http.createApi })).rejects.toThrow("configured Telegram");
    setEnvironment(tokenName);
    await expect(registerTelegramCommands(config, { createApi: http.createApi })).rejects.toThrow("credential is missing");
    setEnvironment(tokenName, "private\ninvalid");
    await expect(registerTelegramCommands(config, { createApi: http.createApi })).rejects.toThrow("value suppressed");
    expect(http.calls).toHaveLength(0);
    expect(http.credential).toBeUndefined();
  });

  test("inspection failures and report menu descriptions cannot expose token URLs or raw errors", async () => {
    const config = fixture(); const http = new TelegramMenusHttp();
    http.failures.set("getChatMember", new Error(`private owner data https://api.telegram.org/bot${token}/getChatMember`));
    try {
      await registerTelegramCommands(config, { apply: true, createApi: http.createApi });
      throw new Error("Expected inspection failure");
    } catch (error) {
      expect(String(error)).toContain("No mutation was attempted");
      expect(String(error)).not.toContain(token);
      expect(String(error)).not.toContain("private owner data");
      expect(String(error)).not.toContain("https://");
    }
    expect(http.calls.some(call => call.method === "setMyCommands")).toBe(false);
    const reportHttp = new TelegramMenusHttp();
    reportHttp.menus.set(menuKey(ownerScope), [{ command: "old", description: `Private ${token} https://api.telegram.org/bot${token}/getMe` }]);
    const report = await registerTelegramCommands(config, { createApi: reportHttp.createApi });
    expect(JSON.stringify(report)).not.toContain(token);
    expect(JSON.stringify(report)).not.toContain("https://");
  });

  test("ambiguous mutation failures are redacted, never retried, and stop remaining scopes", async () => {
    for (const failure of [new Error(`private https://api.telegram.org/bot${token}/setMyCommands`),
      { error_code: 429, description: `private ${token}`, parameters: { retry_after: 1 } }]) {
      const config = fixture(); const http = new TelegramMenusHttp(); http.failures.set("setMyCommands", failure);
      try {
        await registerTelegramCommands(config, { apply: true, createApi: http.createApi });
        throw new Error("Expected mutation failure");
      } catch (error) {
        expect(String(error)).toContain("unresolved");
        expect(String(error)).toContain("No automatic retry");
        expect(String(error)).not.toContain(token);
        expect(String(error)).not.toContain("https://");
      }
      expect(http.calls.filter(call => call.method === "setMyCommands")).toHaveLength(1);
    }
  });

  test("readback must match every name, description and position, including no extra commands", async () => {
    for (const alter of [
      (rows: BotCommand[]) => rows.map((row, index) => index ? row : { ...row, command: "wrong" }),
      (rows: BotCommand[]) => rows.map((row, index) => index ? row : { ...row, description: "Wrong description" }),
      (rows: BotCommand[]) => rows.toReversed(),
      (rows: BotCommand[]) => rows.slice(1),
      (rows: BotCommand[]) => [...rows, { command: "extra", description: "Unrelated" }],
    ]) {
      const config = fixture(); const http = new TelegramMenusHttp();
      http.afterSet = (transport, payload) => { transport.menus.set(menuKey(payload.scope), alter(expectedCommands())); };
      await expect(registerTelegramCommands(config, { apply: true, createApi: http.createApi })).rejects.toThrow("authoritative getMyCommands");
      expect(http.calls.filter(call => call.method === "setMyCommands")).toHaveLength(1);
    }
    const config = fixture(); const http = new TelegramMenusHttp();
    http.afterSet = transport => { transport.failures.set("getMyCommands", new Error(`private ${token}`)); };
    await expect(registerTelegramCommands(config, { apply: true, createApi: http.createApi })).rejects.toThrow("authoritative getMyCommands");
    expect(http.calls.filter(call => call.method === "setMyCommands")).toHaveLength(1);
  });
});
