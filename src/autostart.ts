import { createHash } from "node:crypto";
import {
  accessSync, closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync,
  realpathSync, renameSync, unlinkSync, type Stats,
} from "node:fs";
import { userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { credentialEnvNames, type Config } from "./config";
import { readCredentialFile, stagePrivateFile, validateCredential } from "./credentials";

interface CommandResult { code: number; stdout: string; stderr: string }
/** Only OS identity and launchctl transport are injectable; never a production environment switch. */
export interface AutostartAdapters {
  platform: string;
  home: string;
  uid: number;
  executable: string;
  run(args: string[]): Promise<CommandResult>;
}
interface Launcher {
  state: string; pid: number | null; runs: number | null;
  lastExitCode: number | null; lastTerminatingSignal: number | null;
}
export interface AutostartStatus {
  supported: boolean;
  manager: "launchd";
  label?: string;
  plistPath?: string;
  installed: boolean;
  ownership: "owned" | "foreign" | "absent";
  disabled: boolean | null;
  loaded: boolean | null;
  launcher: Launcher | null;
  error?: string;
  note: string;
}
interface Definition {
  label: string; plistPath: string; stateDir: string; configPath: string;
  cliPath: string; home: string; executable: string; path: string; target: string;
}
interface Snapshot { bytes: string; stat: Stats; executable: string }
const NOTE = "Login-only one-shot launcher, not a Gateway supervisor. Registration/loading is not Gateway readiness. Install never starts accounts. Native provider authentication, settings, and model presets must already be available under the OS account home; shell-only environment is not preserved.";

function defaults(): AutostartAdapters {
  const user = userInfo();
  return {
    platform: process.platform, home: user.homedir, uid: user.uid, executable: process.execPath,
    async run(args) {
      const child = Bun.spawn(["/bin/launchctl", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      return { code, stdout, stderr };
    },
  };
}
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
function canonical(path: string): string {
  try { return realpathSync(path); }
  catch (error) {
    if (!missing(error) || dirname(path) === path) throw error;
    try {
      if (lstatSync(path).isSymbolicLink()) throw new Error("Cannot canonicalize a dangling stateDir symlink");
    } catch (statError) { if (!missing(statError)) throw statError; }
    return join(canonical(dirname(path)), basename(path));
  }
}
function definition(config: Config, adapters: AutostartAdapters): Definition {
  const stateDir = canonical(resolve(config.stateDir));
  const label = `app.omp-superagent.${createHash("sha256").update(stateDir).digest("hex").slice(0, 24)}`;
  const executable = realpathSync(adapters.executable);
  const home = adapters.home;
  if (!isAbsolute(home) || !isAbsolute(executable)) throw new Error("Autostart requires absolute OS home and Bun paths");
  return {
    stateDir, label, home, executable, configPath: resolve(config.path),
    cliPath: fileURLToPath(new URL("./cli.ts", import.meta.url)),
    plistPath: join(home, "Library", "LaunchAgents", `${label}.plist`),
    path: [...new Set([dirname(executable), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(":"),
    target: `gui/${adapters.uid}/${label}`,
  };
}
function xml(value: string): string {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value) || Buffer.from(value).toString("utf8") !== value)
    throw new Error("Autostart paths must be valid XML UTF-8 strings");
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}
function plist(d: Definition): string {
  if (d.executable.includes(":")) throw new Error("Bun executable directory cannot contain a PATH separator");
  const strings = (values: string[]) => values.map(value => `<string>${xml(value)}</string>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(d.label)}</string>
<key>ProgramArguments</key><array>${strings([d.executable, "--no-env-file", d.cliPath, "start", "--config", d.configPath])}</array>
<key>WorkingDirectory</key><string>${xml(dirname(d.cliPath))}</string>
<key>EnvironmentVariables</key><dict><key>HOME</key><string>${xml(d.home)}</string><key>PATH</key><string>${xml(d.path)}</string></dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><false/>
<key>AbandonProcessGroup</key><true/>
<key>OMPSuperagentStateDir</key><string>${xml(d.stateDir)}</string>
</dict></plist>
`;
}
function safeDirectory(path: string, uid: number, create: boolean): void {
  if (create) {
    try { mkdirSync(path, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o022))
    throw new Error("Autostart directory must be owned, non-symlink, and not group/world writable");
}
function directories(d: Definition, uid: number, create: boolean): boolean {
  try {
    safeDirectory(d.home, uid, false);
    safeDirectory(join(d.home, "Library"), uid, create);
    safeDirectory(dirname(d.plistPath), uid, create);
    return true;
  } catch (error) { if (!create && missing(error)) return false; throw error; }
}
function snapshot(d: Definition, uid: number): Snapshot | undefined {
  let fd: number;
  try {
    const stat = lstatSync(d.plistPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== uid || stat.nlink !== 1 || (stat.mode & 0o077))
      throw new Error("Refusing foreign or unsafe autostart definition");
    fd = openSync(d.plistPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) { if (missing(error)) return undefined; throw error; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== uid || stat.nlink !== 1 || (stat.mode & 0o077))
      throw new Error("Refusing foreign or unsafe autostart definition");
    const bytes = readFileSync(fd, "utf8");
    // Accept only our complete generated grammar, including identity, argv and one-shot policy.
    // A previous absolute Bun path may be updated, but no arbitrary plist keys are trusted.
    const encoded = bytes.match(/<key>ProgramArguments<\/key><array><string>([^<]*)<\/string>/)?.[1];
    const executable = encoded?.replace(/&(amp|lt|gt|quot|apos);/g, (_, entity: string) =>
      ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[entity]!);
    if (!executable || !isAbsolute(executable)) throw new Error("Refusing foreign autostart definition");
    const old = { ...d, executable, path: [...new Set([dirname(executable), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(":") };
    if (bytes !== plist(old)) throw new Error("Refusing foreign autostart definition; use its owning config and checkout");
    return { bytes, stat, executable };
  } finally { closeSync(fd); }
}
function unchanged(d: Definition, uid: number, previous: Snapshot | undefined): void {
  const current = snapshot(d, uid);
  if (!!current !== !!previous || current && previous &&
      (current.stat.dev !== previous.stat.dev || current.stat.ino !== previous.stat.ino ||
       current.stat.ctimeMs !== previous.stat.ctimeMs || current.bytes !== previous.bytes))
    throw new Error("Autostart definition changed; no file was replaced or removed");
}
async function checked(adapters: AutostartAdapters, args: string[]): Promise<CommandResult> {
  const result = await adapters.run(args);
  if (result.code !== 0) throw new Error(`launchctl ${args[0]} failed (exit ${result.code}); autostart manager state is not confirmed`);
  return result;
}
async function manager(d: Definition, adapters: AutostartAdapters) {
  const disabledResult = await checked(adapters, ["print-disabled", `gui/${adapters.uid}`]);
  if (!/disabled services\s*=\s*\{/.test(disabledResult.stdout))
    throw new Error("launchctl print-disabled returned an unrecognized response");
  const overrides = [...disabledResult.stdout.matchAll(/"([^"]+)"\s*=>\s*(true|false)/g)];
  const disabled = overrides.find(match => match[1] === d.label)?.[2] === "true";
  const result = await adapters.run(["print", d.target]);
  if (result.code !== 0) {
    if (/Could not find service\b/.test(result.stderr) && result.code === 113)
      return { disabled, loaded: false, launcher: null, path: null, program: null };
    throw new Error(`launchctl print failed (exit ${result.code}); launcher state is unknown`);
  }
  const field = (name: string) => result.stdout.match(new RegExp(`^\\s*${name} = (.+)$`, "m"))?.[1]?.trim();
  const number = (name: string) => {
    const value = field(name);
    return value !== undefined && /^\d+$/.test(value) ? Number(value) : null;
  };
  const state = field("state");
  if (!state) throw new Error("launchctl print returned an unrecognized launcher state");
  return {
    disabled, loaded: true, path: field("path") ?? null, program: field("program") ?? null,
    launcher: { state, pid: number("pid"), runs: number("runs"), lastExitCode: number("last exit code"),
      lastTerminatingSignal: number("last terminating signal") },
  };
}
function loadedOwner(d: Definition, previous: Snapshot | undefined, observed: Awaited<ReturnType<typeof manager>>): void {
  if (observed.loaded && (!previous || observed.path !== d.plistPath || observed.program !== previous.executable))
    throw new Error("Refusing a loaded launcher whose ownership cannot be verified");
}
function supported(adapters: AutostartAdapters): void {
  if (adapters.platform !== "darwin") throw new Error("Autostart install/uninstall supports macOS per-user login LaunchAgents only");
}

export async function autostartStatus(config: Config, adapters = defaults()): Promise<AutostartStatus> {
  const report: AutostartStatus = {
    supported: adapters.platform === "darwin", manager: "launchd", installed: false,
    ownership: "absent", disabled: null, loaded: null, launcher: null, note: NOTE,
  };
  if (!report.supported) return report;
  try {
    const d = definition(config, adapters);
    Object.assign(report, { label: d.label, plistPath: d.plistPath });
    try {
      const previous = directories(d, adapters.uid, false) ? snapshot(d, adapters.uid) : undefined;
      report.installed = !!previous;
      report.ownership = previous ? "owned" : "absent";
      const observed = await manager(d, adapters);
      Object.assign(report, { disabled: observed.disabled, loaded: observed.loaded, launcher: observed.launcher });
      loadedOwner(d, previous, observed);
    } catch (error) {
      if (error instanceof Error && /foreign|unsafe|directory must/.test(error.message)) report.ownership = "foreign";
      throw error;
    }
  } catch (error) { report.error = error instanceof Error ? error.message : "Autostart status unavailable"; }
  return report;
}

async function mutate(config: Config, install: boolean, adapters: AutostartAdapters): Promise<AutostartStatus> {
  supported(adapters);
  const d = definition(config, adapters);
  if (install) {
    if (!isAbsolute(config.command[0]!))
      throw new Error("Autostart requires an absolute executable config.command[0]; shell PATH is not preserved");
    try { accessSync(config.command[0]!, constants.X_OK); }
    catch { throw new Error("Autostart config.command[0] must be an existing executable"); }
    const credentials = readCredentialFile(config.path);
    for (const name of credentialEnvNames(config)) {
      if (name === "HOME" || name === "PATH") throw new Error("Autostart credentials must use variable names other than HOME/PATH");
      const value = credentials?.values[name];
      if (!value) throw new Error(`Autostart requires ${name} in private FILE.env; shell-only credentials are not available at login`);
      validateCredential(value);
    }
  }
  const hasDirectory = directories(d, adapters.uid, install);
  if (!hasDirectory) {
    const observed = await manager(d, adapters);
    loadedOwner(d, undefined, observed);
    return autostartStatus(config, adapters);
  }
  const lockPath = `${d.plistPath}.lock`;
  let lock: number;
  try { lock = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch { throw new Error("Autostart registration is locked; no definition was changed"); }
  const lockStat = fstatSync(lock);
  let temporary: string | undefined;
  try {
    const previous = snapshot(d, adapters.uid);
    const observed = await manager(d, adapters);
    loadedOwner(d, previous, observed);
    if (install) {
      const contents = plist(d);
      if (previous?.bytes !== contents) {
        if (observed.loaded) throw new Error("Loaded launcher must be uninstalled while idle before changing its definition");
        temporary = stagePrivateFile(d.plistPath, contents);
        unchanged(d, adapters.uid, previous);
        if (previous) renameSync(temporary, d.plistPath);
        else linkSync(temporary, d.plistPath);
      }
      if (observed.disabled) await checked(adapters, ["enable", d.target]);
    } else if (previous) {
      if (observed.loaded) {
        const launcher = observed.launcher!;
        if (launcher.pid !== null || launcher.state !== "not running" || !launcher.runs)
          throw new Error("Launcher is actively starting or not safely idle; no Gateway/head was terminated");
        // Exact owned grammar has no timer, KeepAlive or other trigger after its completed run.
        unchanged(d, adapters.uid, previous);
        await checked(adapters, ["bootout", d.target]);
      }
      unchanged(d, adapters.uid, previous);
      unlinkSync(d.plistPath);
    }
  } finally {
    if (temporary) { try { unlinkSync(temporary); } catch (error) { if (!missing(error)) throw error; } }
    closeSync(lock);
    try {
      const stat = lstatSync(lockPath);
      if (stat.dev === lockStat.dev && stat.ino === lockStat.ino) unlinkSync(lockPath);
    } catch (error) { if (!missing(error)) throw error; }
  }
  const report = await autostartStatus(config, adapters);
  if (report.error || install && (!report.installed || report.disabled !== false) || !install && report.installed)
    throw new Error(report.error ?? "Autostart registration outcome could not be confirmed");
  return report;
}
export function installAutostart(config: Config, adapters = defaults()): Promise<AutostartStatus> {
  return mutate(config, true, adapters);
}
export function uninstallAutostart(config: Config, adapters = defaults()): Promise<AutostartStatus> {
  return mutate(config, false, adapters);
}
