import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, constants, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launcherPath, supportDirectory, writePayloadPointer } from "./worker-macos";
import { RemoteWorkerError } from "./remote-worker-wire";

/**
 * Runs a command in the worker account's own user context, outside the SSH
 * session and so surviving its end:
 *  - linux: a transient unit of the account's systemd user manager (linger required);
 *  - darwin: a one-shot LaunchAgent in the `gui/<uid>` launchd domain, the same
 *    context as stock OMP started from the desktop (login keychain reachable).
 */
export const LABEL_PREFIX = "com.omp-superagent.worker.";

export interface UserContextOptions {
  /** Bound on the whole run; exceeding it reports `code: null`. */
  readonly timeoutMs: number;
  /** The worker's private 0700 state directory: darwin keeps its job plist and captured output here. */
  readonly stateDir: string;
  /** Short lowercase name of what runs; part of the darwin job label. */
  readonly purpose: string;
  /** Existing private 0600 file that receives the command's stdout and stderr (appended). */
  readonly logPath?: string;
  /** Return the command's stdout (linux `--pipe`; darwin a private capture file). */
  readonly capture?: boolean;
  /** linux: a transient unit name for a launcher unit that leaves the processes it starts running (Type=oneshot, KillMode=process). */
  readonly unit?: string;
  /**
   * darwin: the leading `argv` entries that are the versioned payload (e.g. bun and the release's script). The
   * LaunchAgent then runs only the fixed launcher, whose pointer is set to them; the rest are the payload's arguments.
   * The job outlives the command while it still has responsible descendants. Ignored on linux, where `argv` runs as given.
   */
  readonly payloadLength?: number;
  /** Test-only: environment given to the job (the account's own login environment otherwise). */
  readonly env?: Readonly<Record<string, string>>;
  /** darwin: support directory holding the fixed launcher; defaults to the account's. */
  readonly support?: string;
}

export interface UserContextResult {
  /** The command's exit status; null when it was signalled, timed out or its status was lost. */
  readonly code: number | null;
  readonly stdout: Buffer;
}

const guiDomain = () => `gui/${process.getuid?.()}`;

function launchctl(args: string[]) {
  const child = Bun.spawnSync(["/bin/launchctl", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10_000, killSignal: "SIGKILL" });
  return { code: child.exitCode, stdout: child.stdout.toString("utf8"), stderr: child.stderr.toString("utf8") };
}

/** Linux: the account needs a user manager that outlives SSH sessions. macOS: a logged-in GUI session. */
export function requireUserContext(platform: string = process.platform): void {
  if (platform === "linux") {
    const uid = process.getuid?.();
    const linger = Bun.spawnSync(["loginctl", "show-user", String(uid), "--property=Linger", "--value"],
      { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 5_000, killSignal: "SIGKILL" });
    if (linger.exitCode !== 0 || linger.stdout.toString("utf8").trim() !== "yes") {
      throw new RemoteWorkerError("Worker account needs lingering (loginctl enable-linger) so its Hosts survive SSH logout");
    }
    return;
  }
  if (platform === "darwin") {
    if (launchctl(["print", guiDomain()]).code !== 0) {
      throw new RemoteWorkerError(`The worker account has no GUI login session (${guiDomain()} is unavailable). Log in to this Mac's desktop as the worker account `
        + "once and keep that session (do not log out or fast-user-switch away; or enable automatic login), so Hosts run with its login keychain");
    }
    return;
  }
  throw new RemoteWorkerError(`Remote workers support Linux (systemd user manager) and macOS (GUI login session); ${platform} workers are not supported`);
}

export interface LaunchctlJob {
  readonly state: string | null;
  readonly runs: number;
  readonly pid: number | null;
  readonly lastExitCode: number | null;
}

/** Top-level fields of `launchctl print gui/<uid>/<label>` (nested coalition blocks are indented deeper). */
export function parseLaunchctlPrint(text: string): LaunchctlJob {
  const field = (name: string) => new RegExp(`^\\t${name} = (.+)$`, "m").exec(text)?.[1]?.trim() ?? null;
  const number = (value: string | null) => value !== null && /^-?\d+$/.test(value) ? Number(value) : null;
  return { state: field("state"), runs: number(field("runs")) ?? 0, pid: number(field("pid")), lastExitCode: number(field("last exit code")) };
}

const xml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * A one-shot, never-restarted LaunchAgent. AbandonProcessGroup keeps processes
 * the command left behind (a detached Host) when the job is removed.
 */
export function launchAgentPlist(job: {
  label: string; argv: readonly string[]; stdoutPath: string; stderrPath: string; env?: Readonly<Record<string, string>>;
}): string {
  const strings = (values: readonly string[]) => values.map(value => `<string>${xml(value)}</string>`).join("");
  const env = job.env ? `<key>EnvironmentVariables</key><dict>${Object.entries(job.env)
    .map(([name, value]) => `<key>${xml(name)}</key><string>${xml(value)}</string>`).join("")}</dict>` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(job.label)}</string>
<key>ProgramArguments</key><array>${strings(job.argv)}</array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><false/>
<key>AbandonProcessGroup</key><true/>
<key>StandardOutPath</key><string>${xml(job.stdoutPath)}</string>
<key>StandardErrorPath</key><string>${xml(job.stderrPath)}</string>
${env}</dict></plist>
`;
}

function createPrivateFile(path: string, text = ""): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, text); } finally { closeSync(fd); }
}

async function runInLaunchAgent(argv: readonly string[], options: UserContextOptions): Promise<UserContextResult> {
  const label = `${LABEL_PREFIX}${options.purpose}.${randomBytes(8).toString("hex")}`;
  const target = `${guiDomain()}/${label}`;
  const base = join(options.stateDir, label);
  const plistPath = `${base}.plist`;
  const capturePath = `${base}.out`;
  const statusPath = `${base}.status`;
  const support = options.support ?? supportDirectory();
  const supervised = options.payloadLength !== undefined;
  let command: readonly string[] = argv;
  if (supervised) {
    writePayloadPointer(support, argv.slice(0, options.payloadLength));
    command = [launcherPath(support), "--status", statusPath, "--", ...argv.slice(options.payloadLength)];
  }
  // A supervised job removes itself once its descendants are gone; any other is removed here.
  let remove = !supervised;
  try {
    if (options.capture) createPrivateFile(capturePath);
    createPrivateFile(plistPath, launchAgentPlist({
      label, argv: command, env: options.env,
      stdoutPath: options.capture ? capturePath : options.logPath ?? "/dev/null", stderrPath: options.logPath ?? "/dev/null",
    }));
    const boot = launchctl(["bootstrap", guiDomain(), plistPath]);
    if (boot.code !== 0) throw new RemoteWorkerError(`launchctl bootstrap failed in ${guiDomain()}: ${boot.stderr.trim().slice(0, 300)}`);
    remove = true;
    const deadline = Date.now() + options.timeoutMs;
    let code: number | null = null;
    for (; ;) {
      if (supervised) {
        try { code = Number(readFileSync(statusPath, "utf8").trim()); remove = false; break; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      const print = launchctl(["print", target]);
      const job = print.code === 0 ? parseLaunchctlPrint(print.stdout) : null;
      // A vanished or finished job without a status lost its launcher before it could report.
      if (!job || job.state === "not running" && job.runs > 0) {
        if (supervised) { remove = false; break; }
        code = job?.lastExitCode ?? null;
        break;
      }
      if (Date.now() > deadline) break;
      await Bun.sleep(50);
    }
    // A job still running at the deadline is stopped; its detached descendants stay.
    return { code: Number.isInteger(code) ? code : null, stdout: options.capture ? readFileSync(capturePath) : Buffer.alloc(0) };
  } finally {
    if (remove) launchctl(["bootout", target]);
    for (const path of [plistPath, capturePath, statusPath]) rmSync(path, { force: true });
  }
}

async function runInUserManager(argv: readonly string[], options: UserContextOptions): Promise<UserContextResult> {
  const log = options.logPath === undefined ? null : openSync(options.logPath, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
  try {
    const wrapped = ["systemd-run", "--user", "--quiet", "--wait", "--collect",
      ...options.capture ? ["--pipe"] : [],
      ...options.unit ? [`--unit=${options.unit}`, "--property=Type=oneshot", "--property=KillMode=process"] : [],
      ...options.logPath ? [`--property=StandardOutput=append:${options.logPath}`, `--property=StandardError=append:${options.logPath}`] : [],
      ...Object.entries(options.env ?? {}).map(([name, value]) => `--setenv=${name}=${value}`),
      "--", ...argv];
    // Detached from the SSH session's process group, so losing the channel cannot cancel the wait.
    const child = spawn(wrapped[0]!, wrapped.slice(1), { detached: true, stdio: ["ignore", options.capture ? "pipe" : log ?? "ignore", log ?? "ignore"] });
    const chunks: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
    const closed = Promise.withResolvers<number | null>();
    child.once("error", closed.reject);
    child.once("close", closed.resolve);
    const code = await closed.promise.finally(() => clearTimeout(timer));
    return { code, stdout: Buffer.concat(chunks) };
  } finally { if (log !== null) closeSync(log); }
}

/** Runs `argv` to completion in the account's user context; see {@link UserContextOptions}. */
export function runInUserContext(argv: readonly string[], options: UserContextOptions, platform: string = process.platform): Promise<UserContextResult> {
  if (platform === "linux") return runInUserManager(argv, options);
  if (platform === "darwin") return runInLaunchAgent(argv, options);
  throw new RemoteWorkerError(`Remote workers do not support ${platform}`);
}
