import {
  closeSync, constants, existsSync, fstatSync, linkSync, lstatSync,
  openSync, readFileSync, realpathSync, unlinkSync, writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isatty } from "node:tty";
import { setImmediate as yieldToSignals } from "node:timers/promises";
import { credentialEnvNames, hostPaths, parseConfig, type Config } from "./config";
import { discoverInstalledOmp, inspectInstalledOmp } from "./installed-omp";
import {
  assertCredentialsUnchanged, readCredentialFile, serializeCredentials, stagePrivateFile,
  validateCredential, writeCredentials,
} from "./credentials";
import { applyConsentedMnemopi, canEnableGlobalMemory, inspectManagedMemory, memoryBlockReason } from "./managed-memory";
import { inspectNativeJudge } from "./setup-judge";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

class SetupCancelled extends Error {
  constructor(saved = false) {
    super(saved ? "Setup cancelled after saving; local files and any completed profile changes were preserved"
      : "Setup cancelled; no files were written");
  }
}

// Bash owns the standard terminal password read and restoration, not a custom raw
// editor. Only this static program is passed in argv; input goes to private stdout.
const READ = `set +x
trap 'printf "\\n" >&2; exit 130' INT TERM HUP
IFS= builtin read -r value
status=$?
[ "$status" -eq 0 ] || exit 1
printf '%s' "$value"
`;
const READ_SECRET = READ.replace("read -r value", "read -r -s value").replace("status=$?", "status=$?\nprintf '\\n' >&2");

class Terminal {
  private fd: number;
  private cancelled = false;
  saved = false;
  readonly abort = new AbortController();
  private reader?: { kill(signal: NodeJS.Signals): void; exited: Promise<number> };
  private interrupt = () => {
    this.cancelled = true;
    this.abort.abort();
    // A signal addressed to the setup PID does not automatically reach its child.
    // Always use the trapped signal so Bash restores its own silent-read state.
    try { this.reader?.kill("SIGINT"); } catch { /* The reader may already have exited. */ }
  };

  constructor() {
    try {
      this.fd = openSync("/dev/tty", constants.O_RDWR | constants.O_NOCTTY);
      if (!fstatSync(this.fd).isCharacterDevice() || !isatty(this.fd)) {
        closeSync(this.fd);
        throw new Error("Not a terminal");
      }
    } catch { throw new Error("Setup requires a controlling terminal; piped or echoed secret input is not supported"); }
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, this.interrupt);
  }

  async ask(label: string, secret = false): Promise<string> {
    if (this.cancelled) throw new SetupCancelled();
    writeSync(this.fd, label);
    const child = Bun.spawn(["/bin/bash", "--noprofile", "--norc", "-p", "+x", "-c", secret ? READ_SECRET : READ], {
      stdin: this.fd, stdout: "pipe", stderr: this.fd,
      env: { ...process.env, BASH_ENV: "/dev/null", ENV: "/dev/null", SHELLOPTS: "", BASHOPTS: "" },
    });
    this.reader = child;
    try {
      const [buffer, code] = await Promise.all([new Response(child.stdout).arrayBuffer(), child.exited]);
      if (code !== 0 || this.cancelled) throw new SetupCancelled();
      const bytes = Buffer.from(buffer);
      const value = bytes.toString("utf8");
      if (!Buffer.from(value, "utf8").equals(bytes)) throw new Error("Input must be valid UTF-8");
      return value;
    } catch (error) {
      this.interrupt();
      throw error;
    } finally {
      await child.exited;
      this.reader = undefined;
    }
  }

  async confirm(label: string): Promise<void> {
    if (!/^y(es)?$/i.test((await this.ask(`${label} [y/N]: `)).trim())) throw new SetupCancelled();
  }

  check(): void { if (this.cancelled) throw new SetupCancelled(this.saved); }
  async close(): Promise<void> {
    if (this.reader) { this.interrupt(); await this.reader.exited; }
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.off(signal, this.interrupt);
    closeSync(this.fd);
  }
}

function currentConfig(path: string): Buffer | undefined {
  try {
    lstatSync(path); // A dangling symlink is not an absent configuration.
    return readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (existsSync(dirname(path))) {
        try { lstatSync(path); } catch { return undefined; }
      }
    }
    throw new Error("Cannot read configuration; its parent directory must already exist");
  }
}

function unchanged(path: string, previous: Buffer | undefined): void {
  const current = currentConfig(path);
  if (!!current !== !!previous || (current && previous && !current.equals(previous)))
    throw new Error("Configuration changed during setup; nothing was overwritten");
}

async function newConfig(terminal: Terminal, path: string): Promise<{ config: Config; text: string }> {
  const template = await Bun.file(join(root, "config.example.json")).json() as Record<string, any>;
  const command = [discoverInstalledOmp()];
  console.log(`Installed OMP command: ${command.map(shellQuote).join(" ")}`);
  const selected = [...new Set((await terminal.ask("Messengers (comma-separated discord,telegram,slack): "))
    .split(",").map(s => s.trim().toLowerCase()).filter(Boolean))];
  if (!selected.length || selected.some(p => !["discord", "telegram", "slack"].includes(p)))
    throw new Error("Select at least one supported messenger");
  const raw: Record<string, unknown> = { ...template, command };
  // Kakao needs an operator-run bridge; add its block manually (docs/kakao-bridge-protocol.md).
  for (const platform of ["discord", "telegram", "slack", "kakao"]) delete raw[platform];
  const list = async (label: string) => (await terminal.ask(`${label} (comma-separated; empty = deny groups / DM only): `))
    .split(",").map(s => s.trim()).filter(Boolean);
  for (const platform of selected) {
    const policy = { ...template[platform] };
    policy.ownerId = (await terminal.ask(`${platform} owner user ID (required): `)).trim();
    if (platform === "discord") {
      policy.allowedGuildIds = await list("Discord allowed guild IDs");
      policy.allowedChannelIds = await list("Discord allowed parent channel IDs");
    } else if (platform === "telegram") {
      policy.allowedChatIds = await list("Telegram allowed group chat IDs");
    } else {
      policy.teamId = (await terminal.ask("Slack workspace/team ID (required): ")).trim();
      policy.allowedChannelIds = await list("Slack allowed channel IDs");
    }
    raw[platform] = policy;
  }
  const headCwd = (await terminal.ask(`Head workspace absolute directory [${process.cwd()}]: `)).trim() || process.cwd();
  if (!isAbsolute(headCwd)) throw new Error("Head workspace must be an absolute existing directory");
  const head = realpathSync(headCwd);
  if (!lstatSync(head).isDirectory()) throw new Error("Head workspace must be an existing directory");
  raw.headCwd = head;
  await terminal.confirm(`Use head workspace ${head}?`);
  const stateDir = (await terminal.ask("State directory (absolute path, required): ")).trim();
  if (!isAbsolute(stateDir)) throw new Error("State directory must be an explicit absolute path");
  raw.stateDir = stateDir;
  for (const key of ["maxHosts", "maxSubagents", "idleMs"] as const) {
    const answer = (await terminal.ask(`${key} [template default ${template[key]}]: `)).trim();
    raw[key] = answer ? Number(answer) : template[key];
  }
  const config = parseConfig(raw, path);
  return { config, text: `${JSON.stringify(raw, null, 2)}\n` };
}

function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

/** Interactive configuration and profile REST setup; no messenger or service activation. */
export async function setup(configPath: string): Promise<void> {
  const path = resolve(configPath);
  const terminal = new Terminal();
  let configTemporary: string | undefined;
  let createdConfig = false;
  try {
    const previousConfig = currentConfig(path);
    const previousCredentials = readCredentialFile(path);
    let config: Config;
    let text: string | undefined;
    if (previousConfig) {
      let value: unknown;
      try { value = JSON.parse(previousConfig.toString("utf8")); }
      catch { throw new Error("Existing configuration is not valid JSON; it was not modified"); }
      config = parseConfig(value, path);
      console.log("Existing configuration preserved; setup will check its configured credentials and native memory.");
    } else {
      ({ config, text } = await newConfig(terminal, path));
    }
    hostPaths(config, "main");
    await inspectInstalledOmp(config.command, credentialEnvNames(config));
    const values = Object.assign(Object.create(null) as Record<string, string>, previousCredentials?.values);
    let replacing = false;
    for (const name of credentialEnvNames(config)) {
      const old = Object.hasOwn(values, name) ? values[name] : undefined;
      const explicit = process.env[name];
      const configured = !!(explicit || old);
      const answer = await terminal.ask(`${name} (${configured ? "configured; Enter keeps existing" : "not configured; required"}): `, true);
      if (answer) {
        validateCredential(answer);
        if (Object.hasOwn(values, name) && old !== answer) replacing = true;
        values[name] = answer;
      } else if (!configured) {
        throw new Error(`A credential is required for ${name}`);
      } else if (old) {
        validateCredential(old);
      } else if (explicit) {
        // Enter keeps an env-only installation env-only, without copying its secret.
        validateCredential(explicit);
      }
      console.log(`${name}: configured${explicit ? " (nonempty shell environment takes precedence)" : ""}`);
    }
    serializeCredentials(values); // Prove lossless encoding before any persistent write.
    if (replacing) await terminal.confirm("Replace existing credential values?");
    const initialMemory = await inspectManagedMemory(config);
    const memoryPlan = canEnableGlobalMemory(initialMemory) ? initialMemory : undefined;
    console.log(`Configuration: ${path}\nPrivate credentials: ${path}.env`);
    if (memoryPlan) {
      console.log(`After saving, set memory.backend=mnemopi in the global settings for the selected OMP profile: ${memoryPlan.agentDir}`);
      console.log("Mnemopi persists across conversations (project-scoped by default). Existing memory options and model settings stay unchanged.");
      console.log("Depending on existing native settings, later memory use may process conversations with models and download models.");
      console.log("Setup does not start memory or OMP; it activates on later OMP startup. Running OMP instances may apply native settings reloads.");
    }
    const profilePlatforms = (["discord", "telegram"] as const).filter(platform => config[platform]);
    if (profilePlatforms.length) {
      console.log(`After saving, replace the configured ${profilePlatforms.join("/")} bot profile pictures with the repository mascot: ${join(root, "assets", "superagent-avatar.jpg")}`);
      console.log("This uses profile REST APIs only; no Gateway, polling, messages, or native model session is started.");
    }
    await terminal.confirm(memoryPlan ? "Write configuration/credentials and enable native Mnemopi memory?"
      : "Write configuration/credentials?");
    // Snapshot the same environment-over-file precedence used by start before
    // native settings imports can populate unrelated dotenv values.
    const profileCredentials = Object.fromEntries(credentialEnvNames(config).map(name => [name, process.env[name] || values[name]!]));
    // Deliver pending cancellation before entering the synchronous commit section.
    await yieldToSignals();
    terminal.check();
    if (text !== undefined) configTemporary = stagePrivateFile(path, text);
    unchanged(path, previousConfig);
    assertCredentialsUnchanged(path, previousCredentials);
    terminal.check();
    if (configTemporary) {
      linkSync(configTemporary, path); // Exclusive creation: never overwrite another config.
      createdConfig = true;
    }
    try { writeCredentials(path, values, previousCredentials); }
    catch (error) {
      if (createdConfig && configTemporary) {
        const staged = lstatSync(configTemporary);
        const current = lstatSync(path);
        if (staged.dev === current.dev && staged.ino === current.ino) unlinkSync(path);
        createdConfig = false;
      }
      throw error;
    }
    terminal.saved = true;
    console.log(`Saved configuration: ${path}\nPrivate credentials: ${path}.env (0600)`);
    terminal.check();
    const { memory, updated } = memoryPlan ? await applyConsentedMnemopi(config, memoryPlan)
      : { memory: await inspectManagedMemory(config), updated: false };
    terminal.check();
    if (updated) console.log("Saved native memory.backend=mnemopi in OMP agent settings.");
    if (memory.status === "enabled") {
      console.log(`Native OMP memory.backend=${memory.backend} is configured for the head workspace (${memory.source} settings); no service was started by setup.`);
    } else {
      console.log(`Setup saved but is incomplete. ${memoryBlockReason(memory)} No service was started by setup.`);
      process.exitCode = 1;
    }
    if (createdConfig) {
      const judge = await inspectNativeJudge(config.headCwd);
      if (judge.status === "unknown") {
        console.log("Setup saved, but native OMP judge configuration could not be verified; judge configuration is unknown, not confirmed missing. Native model settings were not changed by this check.");
      } else if (judge.status === "missing") {
        console.log("Recommended: configure a native judge model for OMP's judge role; no effective judge selector is configured for the head workspace.");
        if (judge.source !== "default") {
          console.log(`The effective judge value is empty or unset in ${judge.source} settings; a hidden lower-layer assignment does not make it effective.`);
        }
        console.log("In an ordinary native OMP terminal opened in the head workspace, open /models, choose Roles -> Judge, and assign a native judgment model. Use the intended global/project storage scope and review any overriding native config overlay; do not use a messenger-managed session to persist this setting.");
        console.log("This is configuration-only advice: selector presence does not prove model or authentication availability. Setup did not select a model, open account storage, or call a model/provider.");
      }
    }
    if (profilePlatforms.length) {
      terminal.check();
      const { setupBotProfiles } = await import("./setup-profiles");
      const profiles = await setupBotProfiles(config, profileCredentials, { signal: terminal.abort.signal });
      for (const profile of profiles) {
        console.log(`${profile.platform}: ${profile.message}`);
        if (profile.status === "failed") process.exitCode = 1;
      }
      if (profiles.some(profile => profile.status === "failed"))
        console.log("Local configuration/credentials remain saved; profile setup is incomplete. Inspect the bot profile before running setup again.");
      terminal.check();
    }
    if (config.slack) {
      console.log("slack: Bot/app tokens cannot upload the app icon automatically. Set it manually at https://api.slack.com/apps -> your app -> Basic Information -> Display Information -> App icon.");
      console.log(`Slack app icon file: ${join(root, "assets", "superagent-avatar.jpg")}`);
    }
    const cli = `${shellQuote(process.execPath)} --no-env-file ${shellQuote(join(root, "src", "cli.ts"))}`;
    console.log(`Next: ${cli} doctor --config ${shellQuote(path)}`);
    if (memory.status === "enabled") console.log(`Start explicitly: ${cli} start --config ${shellQuote(path)}`);
  } finally {
    try { if (configTemporary) unlinkSync(configTemporary); }
    finally { await terminal.close(); }
  }
}
