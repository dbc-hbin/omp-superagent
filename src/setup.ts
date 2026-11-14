import {
  accessSync, closeSync, constants, existsSync, fstatSync, linkSync, lstatSync,
  openSync, readFileSync, realpathSync, unlinkSync, writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isatty } from "node:tty";
import { setImmediate as yieldToSignals } from "node:timers/promises";
import { credentialEnvNames, hostPaths, parseConfig, type Config } from "./config";
import {
  assertCredentialsUnchanged, readCredentialFile, serializeCredentials, stagePrivateFile,
  validateCredential, writeCredentials,
} from "./credentials";
import { saveMnemopiPreference } from "./setup-memory";
import { inspectNativeJudge } from "./setup-judge";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

class SetupCancelled extends Error {
  constructor() { super("Setup cancelled; no files were written"); }
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
  private reader?: { kill(signal: NodeJS.Signals): void; exited: Promise<number> };
  private interrupt = () => {
    this.cancelled = true;
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

  check(): void { if (this.cancelled) throw new SetupCancelled(); }
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
  const upstream = await Bun.file(join(root, "upstream", "omp.json")).json() as {
    checkout: string; runtime: { entry: string };
  };
  const nativeEntry = resolve(root, upstream.checkout, upstream.runtime.entry);
  const command = [realpathSync(process.execPath), "--no-env-file", nativeEntry];
  accessSync(command[0]!, constants.X_OK);
  if (!lstatSync(nativeEntry).isFile()) throw new Error("Prepare the pinned native OMP CLI before setup");
  console.log(`Native command: ${command.map(shellQuote).join(" ")}`);
  const selected = [...new Set((await terminal.ask("Messengers (comma-separated discord,telegram,slack): "))
    .split(",").map(s => s.trim().toLowerCase()).filter(Boolean))];
  if (!selected.length || selected.some(p => !["discord", "telegram", "slack"].includes(p)))
    throw new Error("Select at least one supported messenger");
  const raw: Record<string, unknown> = { ...template, command };
  for (const platform of ["discord", "telegram", "slack"]) delete raw[platform];
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

/** Interactive preparation only: no account verification, activation, or service control. */
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
    let recommendMemory = false;
    if (previousConfig) {
      let value: unknown;
      try { value = JSON.parse(previousConfig.toString("utf8")); }
      catch { throw new Error("Existing configuration is not valid JSON; it was not modified"); }
      config = parseConfig(value, path);
      console.log("Existing configuration preserved; only its configured credentials will be prompted.");
    } else {
      ({ config, text } = await newConfig(terminal, path));
    }
    hostPaths(config, "main");
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
    if (!previousConfig) {
      console.log("Recommended: native OMP Mnemopi memory persists across conversations (project-scoped by default).");
      console.log("This saves OMP's global memory.backend preference only; existing memory options stay unchanged.");
      console.log("Depending on existing native settings, later memory use may process conversations with models and download models.");
      console.log("Setup does not start memory or OMP; it activates on later OMP startup. Running OMP instances may apply native settings reloads.");
      recommendMemory = /^y(es)?$/i.test((await terminal.ask("Enable native Mnemopi memory after saving setup? [y/N]: ")).trim());
      if (!recommendMemory) console.log("Native memory settings will not be changed.");
    }
    console.log(`Configuration: ${path}\nPrivate credentials: ${path}.env`);
    await terminal.confirm("Write configuration/credentials?");
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
    console.log(`Saved configuration: ${path}\nPrivate credentials: ${path}.env (0600)`);
    if (recommendMemory) {
      const memory = await saveMnemopiPreference(config.headCwd);
      if (memory.status === "failed") {
        console.log("Setup saved, but native Mnemopi could not be saved or verified; memory activation is not confirmed. No service was started by setup.");
      } else if (memory.status === "not-saved") {
        console.log("Setup saved, but native persistence did not retain memory.backend=mnemopi; Mnemopi was not enabled by setup. Concurrent native settings were preserved.");
      } else if (memory.status === "shadowed") {
        console.log(`Saved native memory.backend=mnemopi in OMP agent settings: ${memory.agentDir}`);
        console.log(`Mnemopi is not effective for the head workspace (${memory.source} settings take precedence); those settings were preserved. No service was started by setup.`);
      } else {
        console.log(`Saved native memory.backend=mnemopi in OMP agent settings: ${memory.agentDir}`);
        console.log("Mnemopi is configured for the head workspace on later OMP startup; no service was started by setup.");
      }
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
        console.log("In an ordinary native OMP terminal opened in the head workspace, open /models, choose Roles -> Judge, and assign a native judgment model. Use the intended global/project storage scope and review any overriding native config overlay; do not use a messenger-managed session or read-only attach to persist this setting.");
        console.log("This is configuration-only advice: selector presence does not prove model or authentication availability. Setup did not select a model, open account storage, or call a model/provider.");
      }
    }
    const cli = `${shellQuote(process.execPath)} --no-env-file ${shellQuote(join(root, "src", "cli.ts"))}`;
    console.log(`Next: ${cli} doctor --config ${shellQuote(path)}\nStart explicitly: ${cli} start --config ${shellQuote(path)}`);
  } finally {
    try { if (configTemporary) unlinkSync(configTemporary); }
    finally { await terminal.close(); }
  }
}
