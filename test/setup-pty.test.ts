import { expect, test } from "bun:test";
import { YAML, type Subprocess } from "bun";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

// Opt in because this exercises the prepared real native CLI, Python, and Unix PTYs.
const ptyTest = process.env.OMP_SUPERAGENT_SETUP_PTY_TEST === "1" ? test : test.skip;
const repo = path.resolve(import.meta.dir, "..");
const relay = path.join(import.meta.dir, "fixtures/setup-pty.py");
const wrapper = path.join(repo, "scripts/setup.sh");
const cli = path.join(repo, "src/cli.ts");
const defaultNames = ["DISCORD_BOT_TOKEN", "TELEGRAM_BOT_TOKEN", "SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"];
const customName = "SETUP_PTY_TELEGRAM_TOKEN";
const unrelatedName = "SETUP_PTY_UNRELATED";
const trackedNames = [...defaultNames, customName, unrelatedName];
const memoryPrompt = "Enable native Mnemopi memory after saving setup? [y/N]: ";

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
      const error = new Error("Setup exited before the expected terminal event");
      for (const waiter of this.prompts) waiter.reject(error);
      for (const request of this.requests.values()) request.reject(error);
      this.prompts.clear();
      this.requests.clear();
    });
    void this.pump.catch(() => {});
  }

  transcript(): string { return this.raw; }

  async prompt(text: string): Promise<void> {
    const index = this.raw.indexOf(text, this.cursor);
    if (index >= 0) { this.cursor = index + text.length; return; }
    if (this.ended) throw new Error(`Setup exited before prompt: ${text}`);
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
  phase: "launch" | "doctor";
  argv: string[];
  hashes: Record<string, string | null>;
}

interface Fixture {
  root: string;
  config: string;
  state: string;
  env: Record<string, string>;
  ambientEnv?: string;
  nativeConfig: string;
  nativeDb: string;
  nativeProjectConfig: string;
  nativeMemories: string;
  nativeOriginal: string;
  nativeCommand: string[];
  terminal(command?: string[], tty?: boolean): Terminal;
  audit(): Promise<Audit[]>;
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

async function fixture(): Promise<Fixture> {
  // macOS os.tmpdir() can exceed the real native Unix-socket path allowance.
  const root = await fs.realpath(await fs.mkdtemp("/tmp/osp-"));
  const config = path.join(root, "named-config.json");
  const state = path.join(root, "explicit-state");
  const audit = path.join(root, "process-audit.jsonl");
  const violation = path.join(root, "forbidden-transport");
  const guard = path.join(root, "network-guard.js");
  await fs.mkdir(path.join(root, "home"));
  await fs.mkdir(path.join(root, "tmp"));
  // This preload observes the real CLI, not an alternate setup/doctor implementation.
  // All network entrypoints fail before opening a socket, including native --help.
  await fs.writeFile(guard, `
import { appendFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import net from "node:net";
import tls from "node:tls";
import dgram from "node:dgram";
const names = JSON.parse(process.env.SETUP_PTY_NAMES);
function record(phase) {
  appendFileSync(process.env.SETUP_PTY_AUDIT, JSON.stringify({ phase, argv: process.argv,
    hashes: Object.fromEntries(names.map(name => [name, process.env[name] === undefined ? null :
      createHash("sha256").update(process.env[name]).digest("hex")])) }) + "\\n");
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
const originalSpawn = Bun.spawn;
Bun.spawn = function (...args) {
  const command = Array.isArray(args[0]) ? args[0] : args[0]?.cmd;
  if (process.argv.includes("doctor") && command?.includes("--help")) record("doctor");
  return originalSpawn.apply(Bun, args);
};
`);
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: path.join(root, "home"),
    TMPDIR: path.join(root, "tmp"), TERM: "dumb", LANG: "en_US.UTF-8", NO_COLOR: "1",
    PI_CODING_AGENT_DIR: path.join(root, "agent"),
    XDG_CONFIG_HOME: path.join(root, "xdg-config"), XDG_CACHE_HOME: path.join(root, "xdg-cache"),
    BUN_OPTIONS: `--preload=${guard}`, SETUP_PTY_AUDIT: audit,
    SETUP_PTY_VIOLATION: violation, SETUP_PTY_NAMES: JSON.stringify(trackedNames),
  };
  const metadata = await Bun.file(path.join(repo, "upstream/omp.json")).json();
  const preparedBun = path.join(repo, ".upstream/toolchain/node_modules/.bin/bun");
  let executable = process.execPath;
  try { await fs.access(preparedBun, constants.X_OK); executable = preparedBun; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const nativeCommand = [await fs.realpath(executable), "--no-env-file", path.resolve(repo, metadata.checkout, metadata.runtime.entry)];
  // Resolve isolated fixture paths through native APIs in a fresh process; do
  // not import native dirs/dotenv into this runner's real HOME or cache them.
  const settingsModule = import.meta.resolve("@oh-my-pi/pi-coding-agent/config/settings");
  const dirsModule = Bun.resolveSync("@oh-my-pi/pi-utils/dirs", path.dirname(fileURLToPath(settingsModule)));
  const resolver = Bun.spawn([nativeCommand[0]!, "--no-env-file", "-e", `
    import { join } from "node:path";
    import { getAgentDir, getAgentDbPath, getProjectAgentDir, getMemoriesDir, MAIN_CONFIG_FILENAMES } from ${JSON.stringify(dirsModule)};
    const agentDir = getAgentDir();
    console.log(JSON.stringify({
      nativeConfig: join(agentDir, MAIN_CONFIG_FILENAMES[0]),
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
  const nativePaths = JSON.parse(resolvedPaths) as Pick<Fixture, "nativeConfig" | "nativeDb" | "nativeProjectConfig" | "nativeMemories">;
  const nativeOriginal = `\n${JSON.stringify({ memory: { backend: "off" },
    mnemopi: { bank: "pty-preserve-bank", autoRetain: false }, modelRoles: { judge: "vendor/keep-judge" } }, null, "\t")}\n\n`;
  await fs.mkdir(path.dirname(nativePaths.nativeConfig), { recursive: true });
  await fs.writeFile(nativePaths.nativeConfig, nativeOriginal, { mode: 0o600 });
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
    async inert(rejectedStart = false, memorySaved = false) {
      expect(await Bun.file(violation).exists()).toBe(false);
      expect(await exists(state)).toBe(false);
      if (!memorySaved) expect(await fs.readFile(context.nativeConfig, "utf8")).toBe(nativeOriginal);
      expect(await exists(context.nativeDb)).toBe(false);
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

async function doctor(context: Fixture, explicit: Record<string, string> = {}) {
  const env = { ...context.env, ...explicit };
  const child = Bun.spawn([process.execPath, "--no-env-file", cli, "doctor", "--config", context.config], {
    cwd: context.root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  try {
    const [stdout, stderr, code] = await within(Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]), "Explicit real doctor command did not exit");
    expect(stderr).toBe("");
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.config).toBe(context.config);
    expect(result.messengersActivated).toBe(false);
    expect(Object.values(result.credentials).every(value => value === true)).toBe(true);
    const audit = await context.audit();
    const launch = audit.filter(row => row.phase === "launch" && row.argv.includes("doctor")).at(-1)!;
    expect(launch).toBeDefined();
    for (const name of trackedNames) {
      expect(launch.hashes[name]).toBe(env[name] === undefined ? null : hash(env[name]));
    }
    const observed = audit.filter(row => row.phase === "doctor").at(-1)!;
    expect(observed).toBeDefined();
    // The native command really ran --help, but received no messenger credentials.
    const probe = audit.filter(row => row.phase === "launch" && row.argv.includes("--help")).at(-1)!;
    expect(probe).toBeDefined();
    for (const name of Object.keys(result.credentials)) expect(probe.hashes[name]).toBeNull();
    return { stdout, result, observed };
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
}

async function existingConfig(context: Fixture) {
  const value = {
    command: context.nativeCommand, stateDir: context.state, headCwd: context.root,
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

async function newTelegram(context: Fixture, terminal: Terminal) {
  await terminal.answer("Messengers (comma-separated discord,telegram,slack): ", "telegram");
  await terminal.answer("telegram owner user ID (required): ", "246813579");
  await terminal.answer("Telegram allowed group chat IDs (", "");
  await terminal.answer("Head workspace absolute directory [", context.root);
  await terminal.answer(`Use head workspace ${context.root}? [y/N]: `, "y");
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
    await terminal.answer(memoryPrompt, "yes");
    await terminal.prompt("Write configuration/credentials? [y/N]: ");
    expect(await Bun.file(context.config).exists()).toBe(false);
    expect(await Bun.file(`${context.config}.env`).exists()).toBe(false);
    expect(await fs.readFile(context.nativeConfig, "utf8")).toBe(context.nativeOriginal);
    expect(await exists(context.nativeDb)).toBe(false);
    await terminal.input("y\n");
    await terminal.finished(true);
    expect(terminal.transcript()).toContain("+ set +x");
    expect(terminal.transcript()).toContain("persists across conversations");
    expect(terminal.transcript()).toContain("OMP's global memory.backend preference");
    expect(terminal.transcript()).toContain("later OMP startup");
    expect(terminal.transcript()).toContain("may process conversations with models and download models");
    expect(terminal.transcript()).toContain("Saved native memory.backend=mnemopi");
    expect(YAML.parse(await fs.readFile(context.nativeConfig, "utf8"))).toEqual({
      ...(YAML.parse(context.nativeOriginal) as Record<string, unknown>), memory: { backend: "mnemopi" },
    });
    const bytes = await fs.readFile(context.config, "utf8");
    const config = JSON.parse(bytes);
    expect(config.headCwd).toBe(context.root);
    expect(config.stateDir).toBe(context.state);
    expect(config.command).toEqual(context.nativeCommand);
    expect([config.maxHosts, config.maxSubagents, config.idleMs]).toEqual([4, 8, 300000]);
    expect(config.discord).toEqual({ tokenEnv: defaultNames[0], ownerId: "123456789", allowedGuildIds: ["11111", "22222"], allowedChannelIds: ["33333"] });
    expect(config.telegram).toEqual({ tokenEnv: defaultNames[1], ownerId: "246813579", allowedChatIds: ["-97531"] });
    expect(config.slack).toEqual({ botTokenEnv: defaultNames[2], appTokenEnv: defaultNames[3], ownerId: "UOWNER123", teamId: "TTEAM123", allowedChannelIds: ["CCHANNEL123"] });
    const credentialBytes = await fs.readFile(`${context.config}.env`, "utf8");
    expect(parseEnv(credentialBytes)).toEqual(secrets);
    expect((await fs.stat(`${context.config}.env`)).mode & 0o777).toBe(0o600);
    const explicit = "pty-explicit-environment-wins";
    const proof = await doctor(context, { DISCORD_BOT_TOKEN: explicit });
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

ptyTest("new setup decline, Enter and non-yes answers save credentials without touching native memory", async () => {
  for (const answer of ["n", "", "yeah"]) {
    const context = await fixture();
    try {
      const terminal = context.terminal();
      await newTelegram(context, terminal);
      await terminal.secret("TELEGRAM_BOT_TOKEN", "pty-declined-memory-secret", false);
      await terminal.answer(memoryPrompt, answer);
      await terminal.answer("Write configuration/credentials? [y/N]: ", "y");
      await terminal.finished(true);
      expect(terminal.transcript()).toContain("Native memory settings will not be changed.");
      expect(terminal.transcript()).not.toContain("Saved native memory.backend");
      expect(terminal.transcript()).not.toContain("pty-declined-memory-secret");
      expect(await exists(context.config)).toBe(true);
      expect(parseEnv(await fs.readFile(`${context.config}.env`, "utf8"))).toEqual({ TELEGRAM_BOT_TOKEN: "pty-declined-memory-secret" });
      expect(await exists(context.nativeDb)).toBe(false);
      await context.inert();
    } finally { await context.cleanup(); }
  }
}, 120_000);

ptyTest("new setup cancellation, final refusal and pre-publication conflicts never commit opted-in memory", async () => {
  for (const action of ["cancel-memory", "eof-memory", "decline-final", "enter-final", "cancel-final", "config-race", "credential-lock"]) {
    const context = await fixture();
    try {
      const terminal = context.terminal();
      await newTelegram(context, terminal);
      await terminal.secret("TELEGRAM_BOT_TOKEN", "pty-unpublished-memory-secret", false);
      await terminal.prompt(memoryPrompt);
      if (action === "cancel-memory" || action === "eof-memory") {
        await terminal.input(action === "cancel-memory" ? "\x03" : "\x04");
      } else {
        await terminal.input("y\n");
        await terminal.prompt("Write configuration/credentials? [y/N]: ");
        expect(await fs.readFile(context.nativeConfig, "utf8")).toBe(context.nativeOriginal);
        if (action === "config-race") await fs.writeFile(context.config, "external-publication\n");
        if (action === "credential-lock") await fs.writeFile(`${context.config}.env.lock`, "other-publisher\n", { mode: 0o600 });
        await terminal.input(action === "cancel-final" ? "\x03" : action === "decline-final" ? "n\n" : action === "enter-final" ? "\n" : "y\n");
      }
      await terminal.finished(false);
      expect(terminal.transcript()).not.toContain("Saved native memory.backend");
      expect(terminal.transcript()).not.toContain("pty-unpublished-memory-secret");
      if (action === "config-race") expect(await fs.readFile(context.config, "utf8")).toBe("external-publication\n");
      else expect(await exists(context.config)).toBe(false);
      expect(await exists(`${context.config}.env`)).toBe(false);
      expect(await exists(context.nativeDb)).toBe(false);
      await context.inert();
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
    expect(terminal.transcript()).not.toContain(memoryPrompt);
    expect(await exists(context.config)).toBe(false);
    expect(await exists(`${context.config}.env`)).toBe(false);
    expect(await exists(context.nativeDb)).toBe(false);
    await context.inert();
  } finally { await context.cleanup(); }
}, 90_000);

ptyTest("published setup reports project-shadowed memory without overwriting the project preference", async () => {
  const context = await fixture();
  const project = '{"memory":{"backend":"off"},"mnemopi":{"bank":"project-kept"}}\n';
  try {
    await fs.mkdir(path.dirname(context.nativeProjectConfig), { recursive: true });
    await fs.writeFile(context.nativeProjectConfig, project, { mode: 0o600 });
    const terminal = context.terminal();
    await newTelegram(context, terminal);
    await terminal.secret("TELEGRAM_BOT_TOKEN", "pty-shadowed-memory-secret", false);
    await terminal.answer(memoryPrompt, "Y");
    await terminal.answer("Write configuration/credentials? [y/N]: ", "yes");
    await terminal.finished(true);
    expect(terminal.transcript()).toContain("Saved configuration:");
    expect(terminal.transcript()).toContain("Saved native memory.backend=mnemopi");
    expect(terminal.transcript()).toContain("Mnemopi is not effective for the head workspace (project settings take precedence)");
    expect(terminal.transcript()).not.toContain("Mnemopi is configured for the head workspace");
    expect(await fs.readFile(context.nativeProjectConfig, "utf8")).toBe(project);
    expect(YAML.parse(await fs.readFile(context.nativeConfig, "utf8"))).toEqual({
      ...(YAML.parse(context.nativeOriginal) as Record<string, unknown>), memory: { backend: "mnemopi" },
    });
    expect(await exists(context.config)).toBe(true);
    expect(await exists(`${context.config}.env`)).toBe(true);
    await context.inert(false, true);
  } finally { await context.cleanup(); }
}, 90_000);

ptyTest("native configuration failure leaves setup saved and reports no unverified memory success or secret", async () => {
  const context = await fixture();
  const nativeSecret = "pty-native-config-secret-must-not-be-rendered";
  const invalidNative = `memory: [\nprivate: ${nativeSecret}\n`;
  try {
    await fs.writeFile(context.nativeConfig, invalidNative);
    const terminal = context.terminal();
    await newTelegram(context, terminal);
    await terminal.secret("TELEGRAM_BOT_TOKEN", "pty-saved-before-native-failure", false);
    await terminal.answer(memoryPrompt, "yes");
    await terminal.answer("Write configuration/credentials? [y/N]: ", "yes");
    await terminal.finished(true);
    expect(terminal.transcript()).toContain("Saved configuration:");
    expect(terminal.transcript()).toContain("Setup saved, but native Mnemopi could not be saved or verified");
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

ptyTest("existing config and blank retention ignore ambient dotenv; only named credentials load", async () => {
  const context = await fixture();
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
    expect(terminal.transcript()).not.toContain(memoryPrompt);
    expect(terminal.transcript()).not.toContain("Recommended: native OMP Mnemopi");
    expect(terminal.transcript()).not.toContain("Replace existing credential values?");
    for (const name of defaultNames) expect(terminal.transcript()).not.toContain(`${name} (`);
    const proof = await doctor(context);
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
        if (action === "decline-final") await terminal.answer("Write configuration/credentials? [y/N]: ", "n");
      }
      await terminal.finished(false);
      expect(terminal.transcript()).not.toContain(replacement);
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
        const help = context.terminal([...command, "--help"], false);
        await help.finished(true, false);
        expect(help.transcript()).toContain("omp-superagent setup --config FILE");
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
    await context.inert();
  } finally { await context.cleanup(); }
}, 90_000);
