import { expect, test } from "bun:test";
import { YAML, type Subprocess } from "bun";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { nativeTestCommand } from "./fixtures/native-command";

// Opt in because this exercises the installed real native CLI, Python, and Unix PTYs.
const ptyTest = process.env.OMP_SUPERAGENT_SETUP_PTY_TEST === "1" ? test : test.skip;
const repo = path.resolve(import.meta.dir, "..");
const relay = path.join(import.meta.dir, "fixtures/setup-pty.py");
const wrapper = path.join(repo, "scripts/setup.sh");
const cli = path.join(repo, "src/cli.ts");
const defaultNames = ["DISCORD_BOT_TOKEN", "TELEGRAM_BOT_TOKEN", "SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"];
const customName = "SETUP_PTY_TELEGRAM_TOKEN";
const unrelatedName = "SETUP_PTY_UNRELATED";
const trackedNames = [...defaultNames, customName, unrelatedName];
const mnemopiSavePrompt = "Write configuration/credentials and enable native Mnemopi memory? [y/N]: ";
const judgeRecommendation = "Recommended: configure a native judge model for OMP's judge role";
const judgeUnknown = "native OMP judge configuration could not be verified";
// Runner preflight is shared; every setup/doctor invocation still probes the real CLI itself.
let nativeCommandPreflight: Promise<string[]> | undefined;

// These are external-process failure deadlines; fake timers cannot drive a PTY.
// Successful interactions await real relay/prompt events, never a settling sleep.
async function within<T>(promise: Promise<T>, message: string): Promise<T> {
  const deadline = Promise.withResolvers<never>();
  const timer = setTimeout(() => deadline.reject(new Error(message)), 25_000);
  try { return await Promise.race([promise, deadline.promise]); }
  finally { clearTimeout(timer); }
}

interface RelayEvent {
  type: "output" | "reply" | "error" | "exit";
  id?: number;
  data?: string;
  message?: string;
  echo?: boolean | null;
  argv?: string[];
  pid?: number;
  readerPids?: number[];
  remaining?: number[];
  code?: number;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

class Terminal {
  readonly child: Subprocess<"pipe", "pipe", "pipe">;
  readonly stderr: Promise<string>;
  private readonly pump: Promise<void>;
  private readonly done = Promise.withResolvers<RelayEvent>();
  private readonly requests = new Map<number, Deferred<RelayEvent>>();
  private readonly prompts = new Set<{ text: string; resolve: () => void; reject: (error: Error) => void }>();
  private raw = "";
  private cursor = 0;
  private serial = 0;
  private ended = false;
  private exitCode?: number;

  constructor(command: string[], cwd: string, env: Record<string, string>, tty = true) {
    const child = Bun.spawn(["python3", "-u", relay, JSON.stringify({ command, tty })], {
      cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    this.child = child;
    const stderr = new Response(child.stderr).text();
    this.stderr = stderr;
    void this.done.promise.catch(() => {});
    this.pump = (async () => {
      let pending = "";
      const decoder = new TextDecoder();
      for await (const bytes of child.stdout) {
        pending += decoder.decode(bytes, { stream: true });
        let newline: number;
        while ((newline = pending.indexOf("\n")) >= 0) {
          const event = JSON.parse(pending.slice(0, newline)) as RelayEvent;
          pending = pending.slice(newline + 1);
          if (event.type === "output") {
            this.raw += Buffer.from(event.data!, "base64").toString("utf8");
            for (const waiter of this.prompts) {
              const index = this.raw.indexOf(waiter.text, this.cursor);
              if (index < 0) continue;
              this.cursor = index + waiter.text.length;
              this.prompts.delete(waiter);
              waiter.resolve();
            }
          } else if (event.type === "exit") {
            this.ended = true;
            this.exitCode = event.code;
            this.done.resolve(event);
          } else {
            const request = this.requests.get(event.id!);
            this.requests.delete(event.id!);
            if (event.type === "error") request?.reject(new Error(event.message));
            else request?.resolve(event);
          }
        }
      }
      if (!this.ended) {
        const [code, relayError] = await Promise.all([child.exited, stderr]);
        throw new Error(`PTY relay exited (${code}) without an exit event${relayError ? `:\n${relayError.trim()}` : ""}`);
      }
    })().catch(error => {
      this.done.reject(error);
      for (const waiter of this.prompts) waiter.reject(error);
      for (const request of this.requests.values()) request.reject(error);
      this.prompts.clear();
      this.requests.clear();
      throw error;
    }).finally(() => {
      this.ended = true;
      const error = this.earlyExit("Setup exited before the expected terminal event");
      for (const waiter of this.prompts) waiter.reject(error);
      for (const request of this.requests.values()) request.reject(error);
      this.prompts.clear();
      this.requests.clear();
    });
    void this.pump.catch(() => {});
  }

  transcript(): string { return this.raw; }

  private earlyExit(message: string): Error {
    return new Error(`${message} (exit ${this.exitCode ?? "unknown"}):\n${this.raw}`);
  }

  async prompt(text: string): Promise<void> {
    const index = this.raw.indexOf(text, this.cursor);
    if (index >= 0) { this.cursor = index + text.length; return; }
    if (this.ended) throw this.earlyExit(`Setup exited before prompt: ${text}`);
    const pending = Promise.withResolvers<void>();
    const waiter = { text, resolve: () => pending.resolve(), reject: pending.reject };
    this.prompts.add(waiter);
    try { await within(pending.promise, `Setup did not render prompt: ${text}`); }
    finally { this.prompts.delete(waiter); }
  }

  private async request(value: Record<string, unknown>): Promise<RelayEvent> {
    const id = ++this.serial;
    const pending = Promise.withResolvers<RelayEvent>();
    this.requests.set(id, pending);
    this.child.stdin.write(`${JSON.stringify({ ...value, id })}\n`);
    await this.child.stdin.flush();
    try { return await within(pending.promise, "PTY request exceeded its deadline"); }
    finally { this.requests.delete(id); }
  }

  async input(value: string, secret = false): Promise<RelayEvent> {
    return this.request({ type: "write", data: Buffer.from(value).toString("base64"), secret });
  }

  async answer(prompt: string, value: string): Promise<void> {
    await this.prompt(prompt);
    await this.input(`${value}\n`);
  }

  async secret(name: string, value: string, configured: boolean): Promise<void> {
    await this.prompt(`${name} (${configured ? "configured; Enter keeps existing" : "not configured; required"}): `);
    const observed = await this.input(`${value}\n`, true);
    expect(observed.echo).toBe(false);
    expect(observed.argv!.length).toBeGreaterThan(0);
    if (value) expect(observed.argv!.join("\n")).not.toContain(value);
  }

  async finished(success: boolean, tty = true): Promise<void> {
    const event = await within(this.done.promise, "Setup did not exit");
    await within(Promise.all([this.child.exited, this.pump]), "PTY relay did not close");
    expect(await this.stderr).toBe("");
    if (success) expect(event.code).toBe(0);
    else expect(event.code).not.toBe(0);
    expect(event.echo).toBe(tty ? true : null);
    expect(event.remaining).toEqual([]);
  }

  async close(): Promise<void> {
    if (this.child.exitCode === null) this.child.kill("SIGTERM");
    try { await within(this.child.exited, "PTY relay did not terminate"); }
    finally { await this.pump.catch(() => {}); }
  }
}

interface Audit {
  phase: "launch" | "doctor" | "probe" | "profile";
  argv: string[];
  hashes: Record<string, string | null>;
  platform?: string;
  method?: string;
  credentialHash?: string;
  imageHash?: string;
}

interface Fixture {
  root: string;
  config: string;
  state: string;
  env: Record<string, string>;
  ambientEnv?: string;
  nativeConfig: string;
  nativeFallbackConfig: string;
  nativeDb: string;
  nativeProjectConfig: string;
  nativeMemories: string;
  nativeOriginal: string;
  nativeDbOriginal?: string;
  nativeCommand: string[];
  terminal(command?: string[], tty?: boolean): Terminal;
  audit(): Promise<Audit[]>;
  nativeSetupImports(): Promise<number>;
  inert(rejectedStart?: boolean, memorySaved?: boolean): Promise<void>;
  cleanup(): Promise<void>;
}

async function exists(target: string): Promise<boolean> {
  try { await fs.lstat(target); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function fixture(native: Record<string, unknown> | null = { memory: { backend: "off" },
  mnemopi: { bank: "pty-preserve-bank", autoRetain: false }, modelRoles: { judge: "vendor/keep-judge" } }): Promise<Fixture> {
  // macOS os.tmpdir() can exceed the real native Unix-socket path allowance.
  const root = await fs.realpath(await fs.mkdtemp("/tmp/osp-"));
  const config = path.join(root, "named-config.json");
  const state = path.join(root, "explicit-state");
  const audit = path.join(root, "process-audit.jsonl");
  const importAudit = path.join(root, "native-import-audit.jsonl");
  const violation = path.join(root, "forbidden-transport");
  const guard = path.join(root, "network-guard.js");
  await fs.mkdir(path.join(root, "home"));
  await fs.mkdir(path.join(root, "tmp"));
  // This preload observes the real CLI, not an alternate setup/doctor implementation.
  // Profile SDK methods are intercepted locally; all actual network entrypoints
  // still fail before opening a socket, including native --help.
  await fs.writeFile(guard, `
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import net from "node:net";
import tls from "node:tls";
import dgram from "node:dgram";
const names = JSON.parse(process.env.SETUP_PTY_NAMES);
function record(phase, argv = process.argv, env = process.env) {
  appendFileSync(process.env.SETUP_PTY_AUDIT, JSON.stringify({ phase, argv,
    hashes: Object.fromEntries(names.map(name => [name, env[name] === undefined ? null :
      createHash("sha256").update(env[name]).digest("hex")])) }) + "\\n");
}
function deny(operation) {
  return function () {
    writeFileSync(process.env.SETUP_PTY_VIOLATION, operation);
    throw new Error("Setup/doctor attempted forbidden transport: " + operation);
  };
}
net.Socket.prototype.connect = deny("net.connect");
net.Server.prototype.listen = deny("net.listen");
tls.connect = deny("tls.connect");
for (const name of ["bind", "connect", "send"]) dgram.Socket.prototype[name] = deny("dgram." + name);
for (const name of ["connect", "listen", "serve"]) Bun[name] = deny("Bun." + name);
globalThis.fetch = deny("fetch");
globalThis.WebSocket = class { constructor() { deny("WebSocket")(); } };
record("launch");
// Profile mocks belong to setup's Bun process. The installed compiled OMP
// metadata subprocess inherits the network guard, not external SDK preloads.
if (process.argv.includes("setup")) {
const { REST, Routes } = await import(${JSON.stringify(import.meta.resolve("discord.js"))});
const { Api } = await import(${JSON.stringify(import.meta.resolve("grammy"))});
const hash = value => createHash("sha256").update(value).digest("hex");
const tokens = new WeakMap();
const setToken = REST.prototype.setToken;
REST.prototype.setToken = function (token) { tokens.set(this, token); return setToken.call(this, token); };
function profile(platform, method, token, image) {
  const at = process.argv.indexOf("--config");
  const configPath = process.argv[at + 1];
  if (!process.argv.includes("setup") || !existsSync(configPath) || !existsSync(configPath + ".env"))
    return deny("profile-before-save")();
  appendFileSync(process.env.SETUP_PTY_AUDIT, JSON.stringify({
    phase: "profile", argv: process.argv, hashes: {}, platform, method,
    credentialHash: hash(token), imageHash: image ? hash(image) : undefined,
  }) + "\\n");
  if (process.env.SETUP_PTY_PROFILE_FAILURE === platform && method !== "getMe")
    throw new Error(token + " private profile failure");
}
REST.prototype.get = async function (route) {
  if (route !== Routes.user("@me")) return deny("unexpected-discord-profile-route")();
  profile("discord", "getMe", tokens.get(this));
  return { id: "900", bot: true, avatar: "mascot-avatar" };
};
REST.prototype.patch = async function (route, options) {
  if (route !== Routes.user("@me")) return deny("unexpected-discord-profile-route")();
  const image = Buffer.from(options.body.avatar.split(",")[1], "base64");
  profile("discord", "setProfile", tokens.get(this), image);
  return { id: "900", bot: true, avatar: "mascot-avatar" };
};
Api.prototype.getMe = async function () {
  profile("telegram", "getMe", this.token);
  return { id: 900, is_bot: true, first_name: "Local bot" };
};
Api.prototype.setMyProfilePhoto = async function (photo) {
  if (photo.type !== "static") return deny("unexpected-telegram-photo-type")();
  profile("telegram", "setProfile", this.token, Buffer.from(await photo.photo.toRaw()));
  return true;
};
Api.prototype.getUserProfilePhotos = async function (id, options) {
  if (id !== 900 || options.limit !== 1) return deny("unexpected-telegram-profile-target")();
  profile("telegram", "getProfile", this.token);
  return { total_count: 1, photos: [[{ file_id: "mascot-photo", file_unique_id: "mascot-unique", width: 1254, height: 1254 }]] };
};
}
// Native settings imports eagerly load OMP's own dotenv, unlike setup itself.
// Observe that real side effect rather than mocking the inspector or its wiring.
process.on("exit", () => {
  if (process.env.SETUP_PTY_NATIVE_ENV_MARKER === "native-imported")
    appendFileSync(process.env.SETUP_PTY_IMPORT_AUDIT, JSON.stringify(process.argv) + "\\n");
});
const originalSpawn = Bun.spawn;
Bun.spawn = function (...args) {
  const command = Array.isArray(args[0]) ? args[0] : args[0]?.cmd;
  const child = originalSpawn.apply(Bun, args);
  if (process.argv.includes("doctor") && command) {
    record("doctor");
    const options = Array.isArray(args[0]) ? args[1] : args[0];
    record("probe", command, options?.env ?? process.env);
  }
  return child;
};
`);
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: path.join(root, "home"),
    TMPDIR: path.join(root, "tmp"), TERM: "dumb", LANG: "en_US.UTF-8", NO_COLOR: "1",
    PI_CODING_AGENT_DIR: path.join(root, "agent"),
    XDG_CONFIG_HOME: path.join(root, "xdg-config"), XDG_CACHE_HOME: path.join(root, "xdg-cache"),
    BUN_OPTIONS: `--preload=${guard}`, SETUP_PTY_AUDIT: audit,
    SETUP_PTY_IMPORT_AUDIT: importAudit,
    SETUP_PTY_VIOLATION: violation, SETUP_PTY_NAMES: JSON.stringify(trackedNames),
    ...(process.env.OMP_TEST_NATIVES_DIR ? { PI_NATIVES_DIR: process.env.OMP_TEST_NATIVES_DIR } : {}),
  };
  const selectedCommand = await (nativeCommandPreflight ??= nativeTestCommand());
  const selectedExecutable = Bun.which(selectedCommand[0]!, { PATH: env.PATH });
  if (!selectedExecutable) throw new Error("Selected native test executable is unavailable to the PTY fixture");
  const nativeCommand = [await fs.realpath(selectedExecutable), ...selectedCommand.slice(1)];
  // Fresh setup discovers a standalone CLI through PATH, not test-only argv.
  // A private alias also supports explicit installations not named "omp".
  const nativeBin = path.join(root, "native-bin");
  await fs.mkdir(nativeBin);
  await fs.symlink(nativeCommand[0]!, path.join(nativeBin, "omp"));
  env.PATH = [nativeBin, env.PATH].join(path.delimiter);
  // Resolve isolated fixture paths through native APIs in a fresh process; do
  // not import native dirs/dotenv into this runner's real HOME or cache them.
  const settingsModule = import.meta.resolve("@oh-my-pi/pi-coding-agent/config/settings");
  const dirsModule = Bun.resolveSync("@oh-my-pi/pi-utils/dirs", path.dirname(fileURLToPath(settingsModule)));
  const resolver = Bun.spawn([process.execPath, "--no-env-file", "-e", `
    import { join } from "node:path";
    import { getAgentDir, getAgentDbPath, getProjectAgentDir, getMemoriesDir, MAIN_CONFIG_FILENAMES } from ${JSON.stringify(dirsModule)};
    const agentDir = getAgentDir();
    console.log(JSON.stringify({
      nativeConfig: join(agentDir, MAIN_CONFIG_FILENAMES[0]),
      nativeFallbackConfig: join(agentDir, MAIN_CONFIG_FILENAMES[1]),
      nativeDb: getAgentDbPath(agentDir),
      nativeProjectConfig: join(getProjectAgentDir(process.cwd()), MAIN_CONFIG_FILENAMES[0]),
      nativeMemories: getMemoriesDir(agentDir),
    }));
  `], { cwd: root, env: { ...env, BUN_OPTIONS: "" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [resolvedPaths, resolveError, resolveCode] = await Promise.all([
    new Response(resolver.stdout).text(), new Response(resolver.stderr).text(), resolver.exited,
  ]);
  expect(resolveError).toBe("");
  expect(resolveCode).toBe(0);
  const nativePaths = JSON.parse(resolvedPaths) as Pick<Fixture, "nativeConfig" | "nativeFallbackConfig" | "nativeDb" | "nativeProjectConfig" | "nativeMemories">;
  const nativeOriginal = native === null ? "" : `\n${JSON.stringify(native, null, "\t")}\n\n`;
  await fs.mkdir(path.dirname(nativePaths.nativeConfig), { recursive: true });
  if (native !== null) await fs.writeFile(nativePaths.nativeConfig, nativeOriginal, { mode: 0o600 });
  const nativeEnv = path.join(root, "home", ".env");
  const nativeEnvBytes = "SETUP_PTY_NATIVE_ENV_MARKER=native-imported\n";
  await fs.writeFile(nativeEnv, nativeEnvBytes, { mode: 0o600 });
  const nativeAuth = path.join(path.dirname(nativePaths.nativeConfig), "auth.json");
  const nativeAuthBytes = '{"private":"pty-native-auth-must-stay-private"}\n';
  await fs.writeFile(nativeAuth, nativeAuthBytes, { mode: 0o600 });
  const nativeModels = path.join(path.dirname(nativePaths.nativeConfig), "models.yml");
  const nativeModelsBytes = "providers: {}\n# native model metadata must stay untouched\n";
  await fs.writeFile(nativeModels, nativeModelsBytes, { mode: 0o600 });
  const sessions: Terminal[] = [];
  const context: Fixture = {
    root, config, state, env, nativeCommand, ...nativePaths, nativeOriginal,
    terminal(command = ["bash", "-x", wrapper, "--config", config], tty = true) {
      const session = new Terminal(command, root, env, tty);
      sessions.push(session);
      return session;
    },
    async audit(): Promise<Audit[]> {
      const text = await fs.readFile(audit, "utf8");
      return text.trim().split("\n").map(line => JSON.parse(line));
    },
    async nativeSetupImports(): Promise<number> {
      if (!await exists(importAudit)) return 0;
      return (await fs.readFile(importAudit, "utf8")).trim().split("\n")
        .filter(line => (JSON.parse(line) as string[]).includes("setup")).length;
    },
    async inert(rejectedStart = false, memorySaved = false) {
      expect(await Bun.file(violation).exists()).toBe(false);
      expect(await exists(state)).toBe(false);
      if (!memorySaved) {
        if (native === null) expect(await exists(context.nativeConfig)).toBe(false);
        else expect(await fs.readFile(context.nativeConfig, "utf8")).toBe(nativeOriginal);
      }
      if (context.nativeDbOriginal === undefined) expect(await exists(context.nativeDb)).toBe(false);
      else expect(await fs.readFile(context.nativeDb, "utf8")).toBe(context.nativeDbOriginal);
      expect(await fs.readFile(nativeEnv, "utf8")).toBe(nativeEnvBytes);
      expect(await fs.readFile(nativeAuth, "utf8")).toBe(nativeAuthBytes);
      expect(await fs.readFile(nativeModels, "utf8")).toBe(nativeModelsBytes);
      expect((await fs.stat(nativeAuth)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(nativeModels)).mode & 0o777).toBe(0o600);
      expect(await exists(context.nativeMemories)).toBe(false);
      if (context.ambientEnv === undefined) expect(await exists(path.join(root, ".env"))).toBe(false);
      else expect(await fs.readFile(path.join(root, ".env"), "utf8")).toBe(context.ambientEnv);
      expect(await Bun.file(path.join(root, "config.local.json")).exists()).toBe(false);
      expect((await fs.readdir(root)).some(name => name.startsWith(".setup-"))).toBe(false);
      async function noSockets(directory: string): Promise<void> {
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
          const target = path.join(directory, entry.name);
          expect((await fs.lstat(target)).isSocket()).toBe(false);
          if (entry.isDirectory()) await noSockets(target);
        }
      }
      await noSockets(root);
      for (const row of await context.audit()) {
        if (rejectedStart) {
          expect(row.phase).toBe("launch");
          expect(row.argv.slice(1)).toEqual([cli, "start", "--config", config]);
        } else {
          expect(row.argv).not.toContain("start");
        }
        expect(row.argv.some(arg => /(?:^|\/)gateway(?:-daemon)?\.[cm]?[jt]s$/.test(arg))).toBe(false);
      }
    },
    async cleanup() {
      try { for (const session of sessions) await session.close(); }
      finally { await fs.rm(root, { recursive: true, force: true }); }
    },
  };
  return context;
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

async function doctor(context: Fixture, explicit: Record<string, string> = {}, expectedExit = 0) {
  const env = { ...context.env, ...explicit };
  const auditStart = (await context.audit()).length;
  const child = Bun.spawn([process.execPath, "--no-env-file", cli, "doctor", "--config", context.config], {
    cwd: context.root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  try {
    const [stdout, stderr, code] = await within(Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]), "Explicit real doctor command did not exit");
    expect(stderr).toBe("");
    expect(code).toBe(expectedExit);
    const result = JSON.parse(stdout);
    expect(result.config).toBe(context.config);
    expect(result.messengersActivated).toBe(false);
    expect(Object.values(result.credentials).every(value => value === true)).toBe(true);
    const audit = (await context.audit()).slice(auditStart);
    const launch = audit.filter(row => row.phase === "launch" && row.argv.includes("doctor")).at(-1)!;
    expect(launch).toBeDefined();
    for (const name of trackedNames) {
      expect(launch.hashes[name]).toBe(env[name] === undefined ? null : hash(env[name]));
    }
    const observed = audit.filter(row => row.phase === "doctor").at(-1)!;
    expect(observed).toBeDefined();
    // The compiled CLI need not execute Bun preloads. Audit the actual child
    // environment and permit only metadata commands on the selected executable.
    const probes = audit.filter(row => row.phase === "probe" && row.argv[0] === context.nativeCommand[0]);
    expect(probes.map(row => row.argv)).toEqual(
      [["--version"], ["--help"], ["ps", "--help"]].map(argv => [context.nativeCommand[0], ...argv]));
    for (const probe of probes) {
      for (const name of Object.keys(result.credentials)) expect(probe.hashes[name]).toBeNull();
    }
    const memoryChecks = audit.filter(row => row.phase === "probe" && row.argv.some(arg => arg.endsWith("/managed-memory-helper.ts")));
    expect(memoryChecks).toHaveLength(1);
    for (const name of Object.keys(result.credentials)) expect(memoryChecks[0]!.hashes[name]).toBeNull();
    return { stdout, result, observed };
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
}

async function existingConfig(context: Fixture, nativeArgs: readonly string[] = []) {
  const value = {
    command: [...context.nativeCommand, ...nativeArgs], stateDir: context.state, headCwd: context.root,
    maxHosts: 4, maxSubagents: 8, idleMs: 300000,
    telegram: { tokenEnv: customName, ownerId: "246813579", allowedChatIds: ["-97531"] },
  };
  // Noncanonical formatting is intentional: the wizard must not rewrite valid JSON.
  const config = `\n${JSON.stringify(value, null, "\t")}\n\n`;
  const env = `${customName}=pty-original-telegram\n${unrelatedName}=pty-unrelated-must-not-load\n`;
  await fs.writeFile(context.config, config);
  await fs.writeFile(`${context.config}.env`, env, { mode: 0o600 });
  return { config, env };
}

async function newTelegram(context: Fixture, terminal: Terminal, headCwd = context.root) {
  await terminal.answer("Messengers (comma-separated discord,telegram,slack): ", "telegram");
  await terminal.answer("telegram owner user ID (required): ", "246813579");
  await terminal.answer("Telegram allowed group chat IDs (", "");
  await terminal.answer("Head workspace absolute directory [", headCwd);
  await terminal.answer(`Use head workspace ${headCwd}? [y/N]: `, "y");
  await terminal.answer("State directory (absolute path, required): ", context.state);
  await terminal.answer("maxHosts [", "");
  await terminal.answer("maxSubagents [", "");
  await terminal.answer("idleMs [", "");
}

ptyTest("actual traced setup wrapper prepares all messengers privately; explicit doctor stays inert", async () => {
  const context = await fixture();
  const marker = path.join(context.root, "must-not-execute");
  const secrets = {
    DISCORD_BOT_TOKEN: `pty-discord-$(touch ${marker})-$HOME-\\literal=;`,
    TELEGRAM_BOT_TOKEN: `pty-telegram-\`touch ${marker}\`-#literal`,
    SLACK_BOT_TOKEN: "pty-slack-'single'-\"double\"-$HOME",
    SLACK_APP_TOKEN: "pty-slack-app-\\backslash-$(printf inert)=;",
  };
  try {
    const terminal = context.terminal();
    await terminal.answer("Messengers (comma-separated discord,telegram,slack): ", "discord,telegram,slack");
    const setupLaunch = (await context.audit()).find(row => row.argv.includes("setup"));
    expect(setupLaunch).toBeDefined();
    for (const name of trackedNames) expect(setupLaunch!.hashes[name]).toBeNull();
    await terminal.answer("discord owner user ID (required): ", "123456789");
    await terminal.answer("Discord allowed guild IDs (", "11111,22222");
    await terminal.answer("Discord allowed parent channel IDs (", "33333");
    await terminal.answer("telegram owner user ID (required): ", "246813579");
    await terminal.answer("Telegram allowed group chat IDs (", "-97531");
    await terminal.answer("slack owner user ID (required): ", "UOWNER123");
    await terminal.answer("Slack workspace/team ID (required): ", "TTEAM123");
    await terminal.answer("Slack allowed channel IDs (", "CCHANNEL123");
    await terminal.answer("Head workspace absolute directory [", context.root);
    await terminal.answer(`Use head workspace ${context.root}? [y/N]: `, "y");
    await terminal.answer("State directory (absolute path, required): ", context.state);
    await terminal.answer("maxHosts [", "");
    await terminal.answer("maxSubagents [", "");
    await terminal.answer("idleMs [", "");
    for (const [name, value] of Object.entries(secrets)) await terminal.secret(name, value, false);
    await terminal.prompt(mnemopiSavePrompt);
    const review = terminal.transcript();
    expect(review).toContain(`selected OMP profile: ${path.dirname(context.nativeConfig)}`);
    expect(review).toContain("memory.backend=mnemopi");
    expect(review).toContain("persists across conversations");
    expect(review).toContain("later OMP startup");
    expect(review).toContain("may process conversations with models and download models");
    expect(review).toContain("bot profile pictures with the repository mascot");
    expect(await Bun.file(context.config).exists()).toBe(false);
    expect(await Bun.file(`${context.config}.env`).exists()).toBe(false);
    expect(await fs.readFile(context.nativeConfig, "utf8")).toBe(context.nativeOriginal);
    expect(await exists(context.nativeDb)).toBe(false);
    expect((await context.audit()).filter(row => row.phase === "profile")).toEqual([]);
    await terminal.input("y\n");
    await terminal.finished(true);
    expect(terminal.transcript()).toContain("+ set +x");
    expect(terminal.transcript()).toContain("Saved native memory.backend=mnemopi");
    expect(terminal.transcript()).toContain("Native OMP memory.backend=mnemopi is configured");
    expect(terminal.transcript()).toContain("discord: Mascot profile picture applied");
    expect(terminal.transcript()).toContain("telegram: Mascot upload accepted");
    expect(terminal.transcript()).toContain("slack: Bot/app tokens cannot upload the app icon automatically");
    expect(terminal.transcript()).toContain("Basic Information -> Display Information -> App icon");
    const profiles = (await context.audit()).filter(row => row.phase === "profile");
    expect(profiles.map(row => [row.platform, row.method])).toEqual([
      ["discord", "getMe"], ["discord", "setProfile"], ["discord", "getMe"],
      ["telegram", "getMe"], ["telegram", "setProfile"], ["telegram", "getProfile"],
    ]);
    const imageHash = createHash("sha256").update(await fs.readFile(path.join(repo, "assets/superagent-avatar.jpg"))).digest("hex");
    for (const profile of profiles) {
      expect(profile.credentialHash).toBe(hash(profile.platform === "discord" ? secrets.DISCORD_BOT_TOKEN : secrets.TELEGRAM_BOT_TOKEN));
      if (profile.method === "setProfile") expect(profile.imageHash).toBe(imageHash);
    }
    expect(terminal.transcript()).not.toContain(judgeRecommendation);
    expect(terminal.transcript()).not.toContain(judgeUnknown);
    expect(YAML.parse(await fs.readFile(context.nativeConfig, "utf8"))).toEqual({
      ...(YAML.parse(context.nativeOriginal) as Record<string, unknown>), memory: { backend: "mnemopi" },
    });
    const bytes = await fs.readFile(context.config, "utf8");
    const config = JSON.parse(bytes);
    expect(config.headCwd).toBe(context.root);
    expect(config.stateDir).toBe(context.state);
    expect(config.command).toEqual([context.nativeCommand[0]]);
    expect([config.maxHosts, config.maxSubagents, config.idleMs]).toEqual([4, 8, 300000]);
    expect(config.discord).toEqual({
      tokenEnv: defaultNames[0], ownerId: "123456789", allowedGuildIds: ["11111", "22222"],
      allowedChannelIds: ["33333"], requireAddressing: false, editProgressInPlace: false,
    });
    expect(config.telegram).toEqual({ tokenEnv: defaultNames[1], ownerId: "246813579", allowedChatIds: ["-97531"] });
    expect(config.slack).toEqual({ botTokenEnv: defaultNames[2], appTokenEnv: defaultNames[3], ownerId: "UOWNER123", teamId: "TTEAM123", allowedChannelIds: ["CCHANNEL123"] });
    const credentialBytes = await fs.readFile(`${context.config}.env`, "utf8");
    expect(parseEnv(credentialBytes)).toEqual(secrets);
    expect((await fs.stat(`${context.config}.env`)).mode & 0o777).toBe(0o600);
    const explicit = "pty-explicit-environment-wins";
    const proof = await doctor(context, { DISCORD_BOT_TOKEN: explicit });
    expect(proof.result.memory).toMatchObject({ status: "enabled", source: "global", backend: "mnemopi" });
    expect(proof.result.platforms).toEqual(["discord", "telegram", "slack"]);
    expect(proof.result.credentials).toEqual(Object.fromEntries(defaultNames.map(name => [name, true])));
    expect(await fs.readFile(context.config, "utf8")).toBe(bytes);
    expect(await fs.readFile(`${context.config}.env`, "utf8")).toBe(credentialBytes);
    for (const [name, value] of Object.entries(secrets)) {
      expect(proof.observed.hashes[name]).toBe(hash(name === "DISCORD_BOT_TOKEN" ? explicit : value));
      expect(terminal.transcript()).not.toContain(value);
      expect(bytes).not.toContain(value);
      expect(proof.stdout).not.toContain(value);
      for (const row of await context.audit()) expect(row.argv.join("\n")).not.toContain(value);
    }
    expect(proof.stdout).not.toContain(explicit);
    expect(await Bun.file(marker).exists()).toBe(false);
    await context.inert(false, true);
  } finally { await context.cleanup(); }
}, 120_000);

ptyTest("missing judge advice follows publication even when native Mnemopi is enabled", async () => {
  const context = await fixture({ memory: { backend: "off" }, modelRoles: { default: "pty-private-chat-selector" } });
  try {
    const terminal = context.terminal();
    await newTelegram(context, terminal);
    await terminal.secret("TELEGRAM_BOT_TOKEN", "pty-memory-and-judge-secret", false);
    await terminal.answer(mnemopiSavePrompt, "yes");
    await terminal.finished(true);
    const transcript = terminal.transcript();
    expect(transcript).toContain("Saved native memory.backend=mnemopi");
    expect(transcript).toContain(judgeRecommendation);
    expect(transcript.indexOf(judgeRecommendation)).toBeGreaterThan(transcript.indexOf("Saved configuration:"));
    expect(transcript).toContain("/models, choose Roles -> Judge");
    expect(transcript).toContain("ordinary native OMP terminal opened in the head workspace");
    expect(transcript).toContain("selector presence does not prove model or authentication availability");
    expect(await context.nativeSetupImports()).toBe(1);
    expect(transcript).not.toContain("pty-private-chat-selector");
    expect(transcript).not.toContain("pty-memory-and-judge-secret");
    expect(YAML.parse(await fs.readFile(context.nativeConfig, "utf8"))).toEqual({
      memory: { backend: "mnemopi" }, modelRoles: { default: "pty-private-chat-selector" },
    });
    await context.inert(false, true);
  } finally { await context.cleanup(); }
}, 90_000);

// setup.test.ts exercises native read-only judge input variants. Drive
// representative outcomes through the wizard rather than re-running it for
// each storage or selector spelling.
ptyTest("fresh installs recommend a judge, unresolved legacy state is unknown, and modern YAML is authoritative", async () => {
  for (const mode of ["fresh", "legacy", "modern-yaml"]) {
    const context = await fixture(null);
    const legacy = path.join(path.dirname(context.nativeConfig), "settings.json");
    const legacyBytes = "pty-private-opaque-legacy-settings-must-not-be-parsed\n";
    const fallbackBytes = '{"memory":{"backend":"local"},"modelRoles":{"default":"pty-private-default-only"}}\n';
    try {
      if (mode !== "fresh") {
        await fs.writeFile(legacy, legacyBytes, { mode: 0o600 });
        context.nativeDbOriginal = "pty-private-opaque-legacy-db-must-not-be-opened\n";
        await fs.writeFile(context.nativeDb, context.nativeDbOriginal, { mode: 0o600 });
      }
      if (mode === "modern-yaml") await fs.writeFile(context.nativeFallbackConfig, fallbackBytes, { mode: 0o600 });
      const terminal = context.terminal();
      await newTelegram(context, terminal);
      await terminal.secret("TELEGRAM_BOT_TOKEN", "pty-native-presence-judge-secret", false);
      await terminal.answer(mode === "fresh" ? mnemopiSavePrompt : "Write configuration/credentials? [y/N]: ", "y");
      await terminal.finished(mode !== "legacy");
      const transcript = terminal.transcript();
      expect(transcript).toContain("Saved configuration:");
      if (mode === "legacy") {
        expect(transcript).toContain("Unmigrated native settings could not be verified");
        expect(transcript).not.toContain(mnemopiSavePrompt);
        expect(transcript).toContain(judgeUnknown);
        expect(transcript).toContain("unknown, not confirmed missing");
        expect(transcript).not.toContain(judgeRecommendation);
      } else {
        expect(transcript).toContain(judgeRecommendation);
        expect(transcript).toContain("open account storage");
        expect(transcript).not.toContain(judgeUnknown);
        expect(transcript.indexOf(judgeRecommendation)).toBeGreaterThan(transcript.indexOf("Saved configuration:"));
      }
      expect(transcript).not.toContain("pty-private");
      expect(transcript).not.toContain("pty-native-presence-judge-secret");
      expect(transcript).not.toContain("pty-native-auth-must-stay-private");
      expect(await context.nativeSetupImports()).toBe(1);
      if (mode !== "fresh") expect(await fs.readFile(legacy, "utf8")).toBe(legacyBytes);
      else expect(await exists(legacy)).toBe(false);
      if (mode === "modern-yaml") expect(await fs.readFile(context.nativeFallbackConfig, "utf8")).toBe(fallbackBytes);
      else expect(await exists(context.nativeFallbackConfig)).toBe(false);
      if (mode === "fresh")
        expect(YAML.parse(await fs.readFile(context.nativeConfig, "utf8"))).toEqual({ memory: { backend: "mnemopi" } });
      await context.inert(false, mode === "fresh");
    } finally { await context.cleanup(); }
  }
}, 180_000);

ptyTest("project null leaves a legacy judge unknown while overlay null explicitly clears it", async () => {
  for (const layer of ["project", "overlay"]) {
    const context = await fixture(null);
    const legacy = path.join(path.dirname(context.nativeConfig), "settings.json");
    const legacyBytes = "pty-private-unresolved-global-judge\n";
    const layerPath = layer === "project" ? context.nativeProjectConfig : path.join(context.root, "judge-overlay.yml");
    const layerBytes = '{"modelRoles":{"judge":null}}\n';
    try {
      await fs.writeFile(legacy, legacyBytes, { mode: 0o600 });
      context.nativeDbOriginal = "pty-private-unresolved-account-storage\n";
      await fs.writeFile(context.nativeDb, context.nativeDbOriginal, { mode: 0o600 });
      await fs.mkdir(path.dirname(layerPath), { recursive: true });
      await fs.writeFile(layerPath, layerBytes, { mode: 0o600 });
      if (layer === "overlay") context.env.PI_CONFIG_FILES = layerPath;
      const terminal = context.terminal();
      await newTelegram(context, terminal);
      await terminal.secret("TELEGRAM_BOT_TOKEN", "pty-legacy-precedence-judge-secret", false);
      await terminal.answer("Write configuration/credentials? [y/N]: ", "y");
      await terminal.finished(false);
      const transcript = terminal.transcript();
      expect(transcript).toContain("Saved configuration:");
      if (layer === "project") {
        expect(transcript).toContain(judgeUnknown);
        expect(transcript).not.toContain(judgeRecommendation);
      } else {
        expect(transcript).not.toContain(judgeUnknown);
        expect(transcript).toContain(judgeRecommendation);
        expect(transcript).toContain("empty or unset in overlay settings");
      }
      expect(transcript).not.toContain("pty-private");
      expect(transcript).not.toContain("pty-legacy-precedence-judge-secret");
      expect(await context.nativeSetupImports()).toBe(1);
      expect(await fs.readFile(legacy, "utf8")).toBe(legacyBytes);
      expect(await fs.readFile(layerPath, "utf8")).toBe(layerBytes);
      expect(await exists(context.nativeFallbackConfig)).toBe(false);
      await context.inert();
    } finally { await context.cleanup(); }
  }
}, 90_000);

ptyTest("effective global, project and overlay judge selectors suppress advice without availability checks or native writes", async () => {
  for (const [layer, selector] of [
    ["global", "pty-private-unavailable/judge"],
    ["overlay", ["@pty-private-role", "pty-private-unavailable/judge"]],
    ["project", "@pty-private-head-role"],
  ] as const) {
    const context = await fixture(layer === "global" ? { memory: { backend: "mnemopi" }, modelRoles: { judge: selector } } : null);
    const legacy = path.join(path.dirname(context.nativeConfig), "settings.json");
    const legacyBytes = "pty-private-unresolved-global-judge\n";
    const projectNull = '{"modelRoles":{"judge":null}}\n';
    try {
      let headCwd = context.root;
      let layerPath = context.nativeProjectConfig;
      let bytes = projectNull;
      if (layer !== "global") {
        await fs.writeFile(legacy, legacyBytes, { mode: 0o600 });
        bytes = `\n${JSON.stringify({ modelRoles: { judge: selector } })}\n`;
      }
      if (layer === "project") {
        headCwd = path.join(context.root, "actual-head-workspace");
        await fs.mkdir(headCwd);
        layerPath = path.join(headCwd, path.relative(context.root, context.nativeProjectConfig));
      }
      if (layer === "overlay") {
        layerPath = path.join(context.root, "judge-overlay.yml");
        context.env.PI_CONFIG_FILES = layerPath;
      }
      await fs.mkdir(path.dirname(layerPath), { recursive: true });
      await fs.writeFile(layerPath, bytes, { mode: 0o600 });
      context.nativeDbOriginal = "judge-setup-must-not-open-or-migrate-this-account-store";
      await fs.writeFile(context.nativeDb, context.nativeDbOriginal, { mode: 0o600 });
      const terminal = context.terminal();
      await newTelegram(context, terminal, headCwd);
      await terminal.secret("TELEGRAM_BOT_TOKEN", "pty-configured-judge-secret", false);
      await terminal.answer("Write configuration/credentials? [y/N]: ", "y");
      await terminal.finished(layer === "global");
      expect(terminal.transcript()).toContain("Saved configuration:");
      expect(terminal.transcript()).not.toContain(judgeRecommendation);
      expect(terminal.transcript()).not.toContain(judgeUnknown);
      expect(terminal.transcript()).not.toContain("pty-private");
      expect(terminal.transcript()).not.toContain("pty-native-auth-must-stay-private");
      expect(terminal.transcript()).not.toContain("pty-configured-judge-secret");
      expect(await context.nativeSetupImports()).toBe(1);
      expect(await fs.readFile(layerPath, "utf8")).toBe(bytes);
      expect((await fs.stat(layerPath)).mode & 0o777).toBe(0o600);
      if (layer !== "global") expect(await fs.readFile(legacy, "utf8")).toBe(legacyBytes);
      await context.inert();
    } finally { await context.cleanup(); }
  }
}, 120_000);

ptyTest("empty or null overlay judge roles recommend effective configuration without exposing hidden assignments", async () => {
  for (const selector of [null, [",", " , "]]) {
    const context = await fixture({ memory: { backend: "mnemopi" }, modelRoles: { judge: "pty-private-global/judge" } });
    const overlay = path.join(context.root, "judge-overlay.yml");
    const bytes = `${JSON.stringify({ modelRoles: { judge: selector } })}\n`;
    const project = '{"modelRoles":{"judge":"@pty-private-project"}}\n';
    try {
      await fs.mkdir(path.dirname(context.nativeProjectConfig), { recursive: true });
      await fs.writeFile(context.nativeProjectConfig, project, { mode: 0o600 });
      await fs.writeFile(overlay, bytes, { mode: 0o600 });
      context.env.PI_CONFIG_FILES = overlay;
      const terminal = context.terminal();
      await newTelegram(context, terminal);
      await terminal.secret("TELEGRAM_BOT_TOKEN", "pty-shadowed-judge-secret", false);
      await terminal.answer("Write configuration/credentials? [y/N]: ", "y");
      await terminal.finished(true);
      expect(terminal.transcript()).toContain(judgeRecommendation);
      expect(terminal.transcript()).toContain("empty or unset in overlay settings");
      expect(terminal.transcript()).toContain("a hidden lower-layer assignment does not make it effective");
      expect(terminal.transcript()).toContain("review any overriding native config overlay");
      expect(terminal.transcript()).not.toContain(judgeUnknown);
      expect(terminal.transcript()).not.toContain("pty-private");
      expect(terminal.transcript()).not.toContain("pty-shadowed-judge-secret");
      expect(await fs.readFile(overlay, "utf8")).toBe(bytes);
      expect(await fs.readFile(context.nativeProjectConfig, "utf8")).toBe(project);
      await context.inert();
    } finally { await context.cleanup(); }
  }
}, 120_000);

ptyTest("delimiter-only global and project judge settings recommend configuration without native writes", async () => {
  for (const [layer, selector] of [["global", " , , \t"], ["project", [",", " , "]]] as const) {
    const context = await fixture({
      memory: { backend: "mnemopi" }, ...(layer === "global" ? { modelRoles: { judge: selector } } : {}),
    });
    const bytes = `${JSON.stringify({ modelRoles: { judge: selector } })}\n`;
    try {
      if (layer === "project") {
        await fs.mkdir(path.dirname(context.nativeProjectConfig), { recursive: true });
        await fs.writeFile(context.nativeProjectConfig, bytes, { mode: 0o600 });
      }
      const terminal = context.terminal();
      await newTelegram(context, terminal);
      await terminal.secret("TELEGRAM_BOT_TOKEN", "pty-delimiter-only-judge-secret", false);
      await terminal.answer("Write configuration/credentials? [y/N]: ", "y");
      await terminal.finished(true);
      expect(terminal.transcript()).toContain(judgeRecommendation);
      expect(terminal.transcript()).toContain(`empty or unset in ${layer} settings`);
      expect(terminal.transcript()).not.toContain(judgeUnknown);
      expect(terminal.transcript()).not.toContain("pty-delimiter-only-judge-secret");
      if (layer === "project") expect(await fs.readFile(context.nativeProjectConfig, "utf8")).toBe(bytes);
      await context.inert();
    } finally { await context.cleanup(); }
  }
}, 90_000);

ptyTest("a malformed native overlay reports an unknown judge without repair or secret diagnostics", async () => {
  const context = await fixture({});
  const privateValue = "pty-private-native-judge-failure";
  const malformed = `modelRoles: [\nprivate: ${privateValue}\n`;
  const overlay = path.join(context.root, "judge-overlay.yml");
  try {
    await fs.writeFile(overlay, malformed, { mode: 0o600 });
    context.env.PI_CONFIG_FILES = overlay;
    const terminal = context.terminal();
    await newTelegram(context, terminal);
    await terminal.secret("TELEGRAM_BOT_TOKEN", "pty-unknown-judge-secret", false);
    await terminal.answer("Write configuration/credentials? [y/N]: ", "y");
    await terminal.finished(false);
    expect(terminal.transcript()).toContain("Saved configuration:");
    expect(terminal.transcript()).toContain(judgeUnknown);
    expect(terminal.transcript()).toContain("unknown, not confirmed missing");
    expect(terminal.transcript()).not.toContain(judgeRecommendation);
    expect(terminal.transcript()).not.toContain(privateValue);
    expect(terminal.transcript()).not.toContain("pty-unknown-judge-secret");
    expect(terminal.transcript()).not.toContain("Settings config is invalid");
    expect(terminal.transcript()).not.toContain("Failed to parse config overlay");
    expect(await exists(context.config)).toBe(true);
    expect(parseEnv(await fs.readFile(`${context.config}.env`, "utf8")))
      .toEqual({ TELEGRAM_BOT_TOKEN: "pty-unknown-judge-secret" });
    expect(await fs.readFile(overlay, "utf8")).toBe(malformed);
    expect((await fs.readdir(path.dirname(context.nativeConfig))).some(name => name.includes(".invalid"))).toBe(false);
    await context.inert();
  } finally { await context.cleanup(); }
}, 90_000);

ptyTest("existing setup saves only the explicitly consented native profile's backend", async () => {
  const context = await fixture({});
  try {
    const profile = path.join(context.env.HOME!, ".omp/profiles/setup-memory/agent");
    const profileConfig = path.join(profile, "config.yml");
    await fs.mkdir(profile, { recursive: true });
    await fs.writeFile(profileConfig, '{"memory":{"backend":"off"},"mnemopi":{"bank":"preserve-bank"}}\n');
    const original = await existingConfig(context, ["--profile=setup-memory"]);
    const terminal = context.terminal();
    await terminal.secret(customName, "pty-refreshed-without-judge-inspection", true);
    await terminal.answer("Replace existing credential values? [y/N]: ", "yes");
    await terminal.prompt(mnemopiSavePrompt);
    expect(terminal.transcript()).toContain(`selected OMP profile: ${profile}`);
    expect(YAML.parse(await fs.readFile(profileConfig, "utf8"))).toEqual({
      memory: { backend: "off" }, mnemopi: { bank: "preserve-bank" },
    });
    await terminal.input("yes\n");
    await terminal.finished(true);
    expect(terminal.transcript()).toContain("Saved configuration:");
    expect(terminal.transcript()).not.toContain(judgeRecommendation);
    expect(terminal.transcript()).not.toContain(judgeUnknown);
    expect(terminal.transcript()).not.toContain("pty-refreshed-without-judge-inspection");
    expect(await context.nativeSetupImports()).toBe(0);
    expect(YAML.parse(await fs.readFile(profileConfig, "utf8"))).toEqual({
      memory: { backend: "mnemopi" }, mnemopi: { bank: "preserve-bank" },
    });
    expect(await exists(path.join(profile, "agent.db"))).toBe(false);
    expect(await fs.readFile(context.config, "utf8")).toBe(original.config);
    expect(parseEnv(await fs.readFile(`${context.config}.env`, "utf8"))).toEqual({
      [customName]: "pty-refreshed-without-judge-inspection", [unrelatedName]: "pty-unrelated-must-not-load",
    });
    await context.inert();
  } finally { await context.cleanup(); }
}, 90_000);

ptyTest("new setup cancellation, final refusal and pre-publication conflicts never commit planned memory", async () => {
  for (const [action, answer] of [
    ["eof", "\x04"], ["decline", "n\n"], ["enter", "\n"], ["ambiguous", "yeah\n"],
    ["interrupt", "\x03"], ["config-race", "y\n"], ["credential-lock", "y\n"],
  ] as const) {
    const context = await fixture();
    try {
      const terminal = context.terminal();
      await newTelegram(context, terminal);
      await terminal.secret("TELEGRAM_BOT_TOKEN", "pty-unpublished-memory-secret", false);
      await terminal.prompt(mnemopiSavePrompt);
      expect(await fs.readFile(context.nativeConfig, "utf8")).toBe(context.nativeOriginal);
      if (action === "config-race") await fs.writeFile(context.config, "external-publication\n");
      if (action === "credential-lock") await fs.writeFile(`${context.config}.env.lock`, "other-publisher\n", { mode: 0o600 });
      await terminal.input(answer);
      await terminal.finished(false);
      expect(terminal.transcript()).not.toContain("Saved configuration:");
      expect(terminal.transcript()).not.toContain("Saved native memory.backend");
      expect(terminal.transcript()).not.toContain("Start explicitly:");
      expect(terminal.transcript()).not.toContain(judgeRecommendation);
      expect(terminal.transcript()).not.toContain(judgeUnknown);
      expect(await context.nativeSetupImports()).toBe(0);
      expect((await context.audit()).filter(row => row.phase === "profile")).toEqual([]);
      expect(terminal.transcript()).not.toContain("pty-unpublished-memory-secret");
      if (action === "config-race") expect(await fs.readFile(context.config, "utf8")).toBe("external-publication\n");
      else expect(await exists(context.config)).toBe(false);
      expect(await exists(`${context.config}.env`)).toBe(false);
      expect(await exists(context.nativeDb)).toBe(false);
      await context.inert();
    } finally { await context.cleanup(); }
  }
}, 180_000);

ptyTest("final save preserves concurrent native changes and reports the now-effective backend", async () => {
  const privateValue = "pty-private-concurrent-native-failure";
  for (const [layer, bytes, success, outcome] of [
    ["global", '{"mnemopi":{"bank":"external-bank"}}\n', false, "Effective backend is off (default settings)"],
    ["global", '{"memory":{"backend":"local"},"mnemopi":{"bank":"external-bank"}}\n', true, "Native OMP memory.backend=local is configured"],
    ["project", '{"memory":{"backend":"off"}}\n', false, "Effective backend is off (project settings)"],
    ["global", `memory: [\nprivate: ${privateValue}\n`, false, "Native memory settings could not be verified"],
  ] as const) {
    const context = await fixture();
    try {
      const terminal = context.terminal();
      await newTelegram(context, terminal);
      const credential = "pty-saved-despite-concurrent-native-edit";
      await terminal.secret("TELEGRAM_BOT_TOKEN", credential, false);
      await terminal.prompt(mnemopiSavePrompt);
      const nativePath = layer === "global" ? context.nativeConfig : context.nativeProjectConfig;
      await fs.mkdir(path.dirname(nativePath), { recursive: true });
      await fs.writeFile(nativePath, bytes, { mode: 0o600 });
      await terminal.input("yes\n");
      await terminal.finished(success);
      const transcript = terminal.transcript();
      expect(transcript).toContain("Saved configuration:");
      expect(transcript).toContain(outcome);
      expect(transcript.includes("Start explicitly:")).toBe(success);
      expect(transcript).not.toContain("Saved native memory.backend");
      expect(transcript).not.toContain(privateValue);
      expect(transcript).not.toContain(credential);
      expect(await fs.readFile(nativePath, "utf8")).toBe(bytes);
      expect(parseEnv(await fs.readFile(`${context.config}.env`, "utf8"))).toEqual({ TELEGRAM_BOT_TOKEN: credential });
      await context.inert(false, layer === "global");
    } finally { await context.cleanup(); }
  }
}, 180_000);

ptyTest("new setup rejects a missing credential before ambient dotenv or native config can load", async () => {
  const context = await fixture();
  try {
    context.ambientEnv = "TELEGRAM_BOT_TOKEN=pty-ambient-new-setup-must-not-count\n";
    await fs.writeFile(path.join(context.root, ".env"), context.ambientEnv, { mode: 0o600 });
    const terminal = context.terminal();
    await newTelegram(context, terminal);
    await terminal.secret("TELEGRAM_BOT_TOKEN", "", false);
    await terminal.finished(false);
    expect(terminal.transcript()).toContain("A credential is required for TELEGRAM_BOT_TOKEN");
    expect(terminal.transcript()).not.toContain("pty-ambient-new-setup-must-not-count");
    expect(terminal.transcript()).not.toContain(mnemopiSavePrompt);
    expect(terminal.transcript()).not.toContain(judgeRecommendation);
    expect(terminal.transcript()).not.toContain(judgeUnknown);
    expect(await context.nativeSetupImports()).toBe(0);
    expect(await exists(context.config)).toBe(false);
    expect(await exists(`${context.config}.env`)).toBe(false);
    expect(await exists(context.nativeDb)).toBe(false);
    await context.inert();
  } finally { await context.cleanup(); }
}, 90_000);

ptyTest("setup blocked by a project or overlay opt-out does not offer a global memory edit", async () => {
  for (const layer of ["project", "overlay"] as const) {
    const context = await fixture({ memory: { backend: "mnemopi" } });
    const bytes = '{"memory":{"backend":"off"},"mnemopi":{"bank":"override-kept"}}\n';
    const override = layer === "project" ? context.nativeProjectConfig : path.join(context.root, "memory-overlay.yml");
    try {
      await fs.mkdir(path.dirname(override), { recursive: true });
      await fs.writeFile(override, bytes, { mode: 0o600 });
      if (layer === "overlay") context.env.PI_CONFIG_FILES = override;
      const terminal = context.terminal();
      await newTelegram(context, terminal);
      await terminal.secret("TELEGRAM_BOT_TOKEN", "pty-shadowed-memory-secret", false);
      await terminal.answer("Write configuration/credentials? [y/N]: ", "yes");
      await terminal.finished(false);
      const transcript = terminal.transcript();
      expect(transcript).toContain("Saved configuration:");
      expect(transcript).toContain("Setup saved but is incomplete");
      expect(transcript).not.toContain(mnemopiSavePrompt);
      expect(transcript).not.toContain("Saved native memory.backend");
      expect(transcript).toContain(`Effective backend is off (${layer} settings)`);
      expect(transcript).not.toContain("Start explicitly:");
      expect(await fs.readFile(override, "utf8")).toBe(bytes);
      expect(await exists(context.config)).toBe(true);
      expect(await exists(`${context.config}.env`)).toBe(true);
      const proof = await doctor(context, {}, 1);
      expect(proof.result.memory).toMatchObject({ status: "missing", backend: "off", source: layer });
      expect(proof.result.memoryBlock).toContain("require an enabled native OMP memory backend");
      await context.inert();
    } finally { await context.cleanup(); }
  }
}, 120_000);

ptyTest("native configuration failure leaves setup saved and reports no unverified memory success or secret", async () => {
  const context = await fixture();
  const nativeSecret = "pty-native-config-secret-must-not-be-rendered";
  const invalidNative = `memory: [\nprivate: ${nativeSecret}\n`;
  try {
    await fs.writeFile(context.nativeConfig, invalidNative);
    const terminal = context.terminal();
    await newTelegram(context, terminal);
    await terminal.secret("TELEGRAM_BOT_TOKEN", "pty-saved-before-native-failure", false);
    await terminal.answer("Write configuration/credentials? [y/N]: ", "yes");
    await terminal.finished(false);
    expect(terminal.transcript()).toContain("Saved configuration:");
    expect(terminal.transcript()).toContain("Native memory settings could not be verified");
    expect(terminal.transcript()).toContain(judgeUnknown);
    expect(terminal.transcript()).toContain("unknown, not confirmed missing");
    expect(terminal.transcript()).not.toContain(judgeRecommendation);
    expect(terminal.transcript()).not.toContain(mnemopiSavePrompt);
    expect(terminal.transcript()).not.toContain("Saved native memory.backend");
    expect(terminal.transcript()).not.toContain(nativeSecret);
    expect(await fs.readFile(context.nativeConfig, "utf8")).toBe(invalidNative);
    expect((await fs.readdir(path.dirname(context.nativeConfig))).some(name => name.includes(".invalid"))).toBe(false);
    expect(await exists(context.config)).toBe(true);
    expect(parseEnv(await fs.readFile(`${context.config}.env`, "utf8"))).toEqual({ TELEGRAM_BOT_TOKEN: "pty-saved-before-native-failure" });
    await fs.writeFile(context.nativeConfig, context.nativeOriginal);
    await context.inert();
  } finally { await context.cleanup(); }
}, 90_000);

ptyTest("existing setup keeps an alternate backend byte-for-byte and blank credentials ignore ambient dotenv", async () => {
  const context = await fixture({ memory: { backend: "local" }, mnemopi: { bank: "keep-even-when-unused" } });
  try {
    const original = await existingConfig(context);
    context.ambientEnv = `${customName}=pty-ambient-phantom\n${unrelatedName}=pty-ambient-unrelated\n`;
    await fs.writeFile(path.join(context.root, ".env"), context.ambientEnv, { mode: 0o600 });
    const terminal = context.terminal();
    await terminal.secret(customName, "", true);
    const setupLaunch = (await context.audit()).find(row => row.argv.includes("setup"))!;
    expect(setupLaunch).toBeDefined();
    for (const name of trackedNames) expect(setupLaunch.hashes[name]).toBeNull();
    await terminal.answer("Write configuration/credentials? [y/N]: ", "y");
    await terminal.finished(true);
    expect(await fs.readFile(context.config, "utf8")).toBe(original.config);
    expect(await fs.readFile(`${context.config}.env`, "utf8")).toBe(original.env);
    expect((await fs.stat(`${context.config}.env`)).mode & 0o777).toBe(0o600);
    expect(terminal.transcript()).not.toContain("Messengers (");
    expect(terminal.transcript()).not.toContain(mnemopiSavePrompt);
    expect(terminal.transcript()).not.toContain("Saved native memory.backend");
    expect(terminal.transcript()).toContain("Native OMP memory.backend=local is configured");
    expect(terminal.transcript()).toContain("Start explicitly:");
    expect(await fs.readFile(context.nativeConfig, "utf8")).toBe(context.nativeOriginal);
    expect(terminal.transcript()).not.toContain("Recommended: native OMP Mnemopi");
    expect(terminal.transcript()).not.toContain(judgeRecommendation);
    expect(terminal.transcript()).not.toContain(judgeUnknown);
    expect(await context.nativeSetupImports()).toBe(0);
    expect(terminal.transcript()).not.toContain("Replace existing credential values?");
    for (const name of defaultNames) expect(terminal.transcript()).not.toContain(`${name} (`);
    const proof = await doctor(context);
    expect(proof.result.memory).toMatchObject({ status: "enabled", backend: "local", source: "global" });
    expect(proof.result.credentials).toEqual({ [customName]: true });
    expect(proof.observed.hashes[customName]).toBe(hash("pty-original-telegram"));
    expect(proof.observed.hashes[unrelatedName]).toBeNull();
    expect(terminal.transcript()).not.toContain("pty-original-telegram");
    expect(terminal.transcript()).not.toContain("pty-unrelated-must-not-load");
    expect(terminal.transcript()).not.toContain("pty-ambient-phantom");
    expect(proof.stdout).not.toContain("pty-ambient-phantom");
    // A shell-only installation stays shell-only when Enter retains its value.
    await fs.unlink(`${context.config}.env`);
    const shellOnly = "pty-shell-only-retained";
    context.env[customName] = shellOnly;
    const shellTerminal = context.terminal();
    await shellTerminal.secret(customName, "", true);
    await shellTerminal.answer("Write configuration/credentials? [y/N]: ", "y");
    await shellTerminal.finished(true);
    expect(await fs.readFile(context.config, "utf8")).toBe(original.config);
    expect(parseEnv(await fs.readFile(`${context.config}.env`, "utf8"))).toEqual({});
    expect(shellTerminal.transcript()).not.toContain(shellOnly);
    expect(shellTerminal.transcript()).not.toContain(judgeRecommendation);
    expect(shellTerminal.transcript()).not.toContain(judgeUnknown);
    expect((await context.audit()).filter(row => row.phase === "profile").at(-1)?.credentialHash).toBe(hash(shellOnly));
    expect(await context.nativeSetupImports()).toBe(0);
    const shellProof = await doctor(context);
    expect(shellProof.observed.hashes[customName]).toBe(hash(shellOnly));
    expect(shellProof.stdout).not.toContain(shellOnly);
    for (const row of await context.audit()) expect(row.argv.join("\n")).not.toContain(shellOnly);
    await context.inert();
  } finally { await context.cleanup(); }
}, 90_000);

ptyTest("start rejects missing named credentials before ambient dotenv can activate any service", async () => {
  const context = await fixture();
  try {
    const original = await existingConfig(context);
    await fs.unlink(`${context.config}.env`);
    const phantom = "pty-ambient-start-must-not-authenticate";
    context.ambientEnv = `${customName}=${phantom}\n`;
    await fs.writeFile(path.join(context.root, ".env"), context.ambientEnv, { mode: 0o600 });
    const terminal = context.terminal([
      process.execPath, "--no-env-file", cli, "start", "--config", context.config,
    ], false);
    await terminal.finished(false, false);
    expect(terminal.transcript()).toContain(`Missing messenger credential environment variable ${customName}`);
    expect(terminal.transcript()).not.toContain(phantom);
    expect(await fs.readFile(context.config, "utf8")).toBe(original.config);
    expect(await exists(`${context.config}.env`)).toBe(false);
    const audit = await context.audit();
    // The rejected CLI process is the only launch: no native help or Gateway child.
    expect(audit).toHaveLength(1);
    for (const name of trackedNames) expect(audit[0]!.hashes[name]).toBeNull();
    await context.inert(true);
  } finally { await context.cleanup(); }
}, 60_000);

ptyTest("profile setup uses start's shell precedence and preserves saved files on ambiguous upload failure", async () => {
  const context = await fixture({ memory: { backend: "mnemopi" } });
  try {
    const original = await existingConfig(context);
    const explicit = "pty-profile-explicit-shell-token";
    const saved = "pty-profile-new-private-token";
    context.env[customName] = explicit;
    context.env.SETUP_PTY_PROFILE_FAILURE = "telegram";
    const terminal = context.terminal();
    await terminal.secret(customName, saved, true);
    await terminal.answer("Replace existing credential values? [y/N]: ", "y");
    await terminal.answer("Write configuration/credentials? [y/N]: ", "y");
    await terminal.finished(false);
    const profiles = (await context.audit()).filter(row => row.phase === "profile");
    expect(profiles.map(row => row.method)).toEqual(["getMe", "setProfile"]);
    expect(profiles.every(row => row.credentialHash === hash(explicit))).toBe(true);
    expect(terminal.transcript()).toContain("Profile update is unresolved");
    expect(terminal.transcript()).toContain("No automatic retry");
    expect(terminal.transcript()).toContain("Local configuration/credentials remain saved");
    expect(terminal.transcript()).not.toContain("Mascot upload accepted");
    expect(terminal.transcript()).not.toContain(explicit);
    expect(terminal.transcript()).not.toContain(saved);
    expect(await fs.readFile(context.config, "utf8")).toBe(original.config);
    expect(parseEnv(await fs.readFile(`${context.config}.env`, "utf8"))[customName]).toBe(saved);
    await context.inert();
  } finally { await context.cleanup(); }
}, 90_000);

ptyTest("setup preserves an existing explicit Discord addressing opt-in byte-for-byte", async () => {
  const context = await fixture({ memory: { backend: "mnemopi" } });
  try {
    const value = {
      command: context.nativeCommand, stateDir: context.state, headCwd: context.root,
      maxHosts: 4, maxSubagents: 8, idleMs: 300000,
      discord: {
        tokenEnv: "DISCORD_BOT_TOKEN", ownerId: "123456789", allowedGuildIds: ["11111"],
        allowedChannelIds: ["33333"], requireAddressing: true,
      },
    };
    const bytes = `\n${JSON.stringify(value, null, "\t")}\n\n`;
    await fs.writeFile(context.config, bytes);
    await fs.writeFile(`${context.config}.env`, "DISCORD_BOT_TOKEN=pty-existing-discord-token\n", { mode: 0o600 });
    const terminal = context.terminal();
    await terminal.secret("DISCORD_BOT_TOKEN", "", true);
    await terminal.answer("Write configuration/credentials? [y/N]: ", "y");
    await terminal.finished(true);
    expect(await fs.readFile(context.config, "utf8")).toBe(bytes);
    await context.inert();
  } finally { await context.cleanup(); }
}, 90_000);

ptyTest("Slack-only setup gives the mascot app-icon step without any profile API calls", async () => {
  const context = await fixture({ memory: { backend: "mnemopi" } });
  try {
    const original = JSON.parse((await existingConfig(context)).config);
    delete original.telegram;
    original.slack = {
      botTokenEnv: "SLACK_BOT_TOKEN", appTokenEnv: "SLACK_APP_TOKEN",
      ownerId: "UOWNER123", teamId: "TTEAM123", allowedChannelIds: [],
    };
    const bytes = `${JSON.stringify(original)}\n`;
    const tokens = "SLACK_BOT_TOKEN=pty-slack-only-bot\nSLACK_APP_TOKEN=pty-slack-only-app\n";
    await fs.writeFile(context.config, bytes);
    await fs.writeFile(`${context.config}.env`, tokens, { mode: 0o600 });
    const terminal = context.terminal();
    await terminal.secret("SLACK_BOT_TOKEN", "", true);
    await terminal.secret("SLACK_APP_TOKEN", "", true);
    await terminal.answer("Write configuration/credentials? [y/N]: ", "y");
    await terminal.finished(true);
    expect(terminal.transcript()).toContain("Set it manually at https://api.slack.com/apps");
    expect(terminal.transcript()).toContain(path.join(repo, "assets/superagent-avatar.jpg"));
    expect(terminal.transcript()).not.toContain("pty-slack-only");
    expect(terminal.transcript()).not.toContain("profile picture applied");
    expect((await context.audit()).filter(row => row.phase === "profile")).toEqual([]);
    expect(await fs.readFile(context.config, "utf8")).toBe(bytes);
    expect(await fs.readFile(`${context.config}.env`, "utf8")).toBe(tokens);
    await context.inert();
  } finally { await context.cleanup(); }
}, 90_000);

ptyTest("terminal and parent-only signals, EOF and declined confirmations preserve files and reap readers", async () => {
  const context = await fixture();
  const replacement = "pty-cancelled-replacement-$(printf inert)";
  try {
    const original = await existingConfig(context);
    for (const action of ["interrupt", "SIGINT", "SIGTERM", "SIGHUP", "eof", "decline-replacement", "decline-final"]) {
      const terminal = context.terminal();
      if (action === "interrupt" || action === "eof" || action.startsWith("SIG")) {
        await terminal.prompt(`${customName} (configured; Enter keeps existing): `);
        const observed = await terminal.input(action === "eof" ? "" : replacement, true);
        expect(observed.echo).toBe(false);
        expect(observed.argv!.join("\n")).not.toContain(replacement);
        if (action.startsWith("SIG")) {
          expect(observed.readerPids!.length).toBeGreaterThan(0);
          // Signal only the Bun setup PID, not its foreground process group.
          process.kill(observed.pid!, action as NodeJS.Signals);
        } else {
          await terminal.input(action === "interrupt" ? "\x03" : "\x04");
        }
      } else {
        await terminal.secret(customName, replacement, true);
        await terminal.answer("Replace existing credential values? [y/N]: ", action === "decline-replacement" ? "n" : "y");
        if (action === "decline-final") await terminal.answer(mnemopiSavePrompt, "n");
      }
      await terminal.finished(false);
      expect(terminal.transcript()).not.toContain(replacement);
      expect(terminal.transcript()).not.toContain(judgeRecommendation);
      expect(terminal.transcript()).not.toContain(judgeUnknown);
      expect(await context.nativeSetupImports()).toBe(0);
      expect(await fs.readFile(context.config, "utf8")).toBe(original.config);
      expect(await fs.readFile(`${context.config}.env`, "utf8")).toBe(original.env);
      expect((await fs.stat(`${context.config}.env`)).mode & 0o777).toBe(0o600);
    }
    await context.inert();
  } finally { await context.cleanup(); }
}, 120_000);

ptyTest("new setup rejects an unusable socket directory before asking for credentials or publishing", async () => {
  const context = await fixture();
  const longState = path.join(context.root, "x".repeat(160));
  try {
    const terminal = context.terminal();
    await terminal.answer("Messengers (comma-separated discord,telegram,slack): ", "telegram");
    await terminal.answer("telegram owner user ID (required): ", "246813579");
    await terminal.answer("Telegram allowed group chat IDs (", "");
    await terminal.answer("Head workspace absolute directory [", context.root);
    await terminal.answer(`Use head workspace ${context.root}? [y/N]: `, "y");
    await terminal.answer("State directory (absolute path, required): ", longState);
    await terminal.answer("maxHosts [", "");
    await terminal.answer("maxSubagents [", "");
    await terminal.answer("idleMs [", "");
    await terminal.finished(false);
    expect(terminal.transcript()).toContain("stateDir is too long for local Unix sockets");
    expect(terminal.transcript()).not.toContain("TELEGRAM_BOT_TOKEN (");
    expect(terminal.transcript()).not.toContain(judgeRecommendation);
    expect(terminal.transcript()).not.toContain(judgeUnknown);
    expect(await context.nativeSetupImports()).toBe(0);
    expect(await exists(context.config)).toBe(false);
    expect(await exists(`${context.config}.env`)).toBe(false);
    expect(await exists(longState)).toBe(false);
    await context.inert();
  } finally { await context.cleanup(); }
}, 60_000);

ptyTest("setup help works without a terminal while secret entry fails closed without writes", async () => {
  const context = await fixture();
  try {
    for (const present of [false, true]) {
      const original = present ? await existingConfig(context) : undefined;
      for (const command of [
        ["bash", "-x", wrapper, "--config", context.config],
        [process.execPath, "--no-env-file", cli, "setup", "--config", context.config],
      ]) {
        const terminal = context.terminal(command, false);
        await terminal.finished(false, false);
        expect(terminal.transcript()).toContain("controlling terminal");
        expect(terminal.transcript()).not.toContain(judgeRecommendation);
        expect(terminal.transcript()).not.toContain(judgeUnknown);
        const help = context.terminal([...command, "--help"], false);
        await help.finished(true, false);
        expect(help.transcript()).toContain("omp-sa setup --config FILE");
        if (original) {
          expect(await fs.readFile(context.config, "utf8")).toBe(original.config);
          expect(await fs.readFile(`${context.config}.env`, "utf8")).toBe(original.env);
          expect((await fs.stat(`${context.config}.env`)).mode & 0o777).toBe(0o600);
        } else {
          expect(await Bun.file(context.config).exists()).toBe(false);
          expect(await Bun.file(`${context.config}.env`).exists()).toBe(false);
        }
      }
    }
    expect(await context.nativeSetupImports()).toBe(0);
    await context.inert();
  } finally { await context.cleanup(); }
}, 90_000);
