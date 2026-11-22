import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  loadConfig, parseConfig, WORKER_NAME_PATTERN, type Config, type WorkerConfig, type WorkerSuperkit,
} from "./config";
import { canEnableGlobalMemory, memoryBlockReason, parseMemoryHelperOutput, type ManagedMemoryReport, type ManagedMemoryStatus } from "./managed-memory";
import { activeManagedUlwRevision, MANAGED_ULW_FIXTURE_ROOT_ENV } from "./managed-ulw";
import { requireCompatibleWorker, MINIMUM_WORKER_OMP, placement, workerInstance } from "./remote-lanes";
import { Store } from "./store";
import { workerPackage, type WorkerCapability } from "./remote-worker-wire";
import { grantInstruction, protectedPaths, type MacosWorkerScope } from "./worker-macos";
import type { MacosSetupReport } from "./worker-macos-setup";
import {
  authorizedKeysScript, commandScript, installScript, macosPrepareScript, memoryScript, newNonce, parseFacts, PATH_FILES, preflightScript,
  REMOTE_RELEASES, REMOTE_STATE_DIR, REMOTE_WRAPPER, sq, userSshdApplyScript, userSshdInspectScript, workerJsonScript,
} from "./worker-setup-remote";
import {
  listenAddress, planUserSshd, userSshdConfig, userSshdDirectory, userSshdPlist, USER_SSHD_BINARY, USER_SSHD_DIRECTORY, USER_SSHD_LABEL, USER_SSHD_MIN_PORT,
  type UserSshdDesired, type UserSshdPlan,
} from "./worker-user-sshd";

const SETUP_DESTINATION = /^[A-Za-z0-9][A-Za-z0-9_.@:%-]*$/;
const SSH_ALIAS = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const TAILNET_FROM = "100.64.0.0/10,fd7a:115c:a1e0::/48";
/** The operator's home: where OpenSSH looks for the key, config and known_hosts HEAD uses. */
const headHome = (): string => process.env.HOME || homedir();
const packageRoot = fileURLToPath(new URL("../", import.meta.url));

export const WORKER_USAGE = `Usage:
  omp-sa worker add NAME --ssh SETUP_DESTINATION --root ABS_PATH [--root ABS_PATH ...] --config FILE
      [--dedicated-key [--from CIDR,...|any] [--hostname HOST] [--port PORT] [--user-sshd]]
      [--superkit managed|none] [--state-dir ABS_PATH] [--replace] [--dry-run]
  omp-sa worker doctor NAME --config FILE
  omp-sa worker list --config FILE`;

export class WorkerSetupError extends Error {
  override readonly name = "WorkerSetupError";
}

// ---------------------------------------------------------------- command line

export interface AddOptions {
  name: string;
  /** Ordinary SSH destination the operator can log in with; used only by `add`. */
  ssh: string;
  roots: string[];
  dedicatedKey: boolean;
  /** macOS: run the worker account's own sshd on `hostname`:`port` (see worker-user-sshd). */
  userSshd: boolean;
  superkit: WorkerSuperkit;
  dryRun: boolean;
  replace: boolean;
  configPath: string;
  /** authorized_keys `from=` list; null omits it. */
  from: string | null;
  hostname?: string;
  port?: number;
  stateDir?: string;
}
export type WorkerCommand =
  | ({ kind: "add" } & AddOptions)
  | { kind: "doctor"; name: string; configPath: string }
  | { kind: "list"; configPath: string };

export function parseWorkerArgs(args: readonly string[]): WorkerCommand {
  const [kind, ...rest] = args;
  if (kind !== "add" && kind !== "doctor" && kind !== "list") throw new WorkerSetupError(WORKER_USAGE);
  const positional: string[] = [];
  const values = new Map<string, string[]>();
  const booleans = new Set<string>();
  const valueFlags = kind === "add"
    ? ["--ssh", "--root", "--config", "--superkit", "--from", "--hostname", "--port", "--state-dir"] : ["--config"];
  const booleanFlags = kind === "add" ? ["--dedicated-key", "--user-sshd", "--dry-run", "--replace"] : [];
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index]!;
    if (!flag.startsWith("--")) { positional.push(flag); continue; }
    if (booleanFlags.includes(flag)) { booleans.add(flag); continue; }
    const value = rest[++index];
    if (!valueFlags.includes(flag) || value === undefined || value.startsWith("--")
      || (values.has(flag) && flag !== "--root")) throw new WorkerSetupError(WORKER_USAGE);
    values.set(flag, [...values.get(flag) ?? [], value]);
  }
  const configPath = values.get("--config")?.[0];
  if (!configPath || positional.length !== (kind === "list" ? 0 : 1)) throw new WorkerSetupError(WORKER_USAGE);
  if (kind === "list") return { kind, configPath };
  const name = positional[0]!;
  if (!WORKER_NAME_PATTERN.test(name)) throw new WorkerSetupError(`Worker name must match ${WORKER_NAME_PATTERN}`);
  if (kind === "doctor") return { kind, name, configPath };

  const ssh = values.get("--ssh")?.[0];
  const roots = values.get("--root") ?? [];
  if (!ssh || !roots.length) throw new WorkerSetupError(`worker add requires --ssh and at least one --root\n${WORKER_USAGE}`);
  if (!SETUP_DESTINATION.test(ssh)) throw new WorkerSetupError("--ssh must be an SSH destination such as an alias or user@host");
  const superkit = values.get("--superkit")?.[0] ?? "managed";
  if (superkit !== "managed" && superkit !== "none") throw new WorkerSetupError('--superkit must be "managed" or "none"');
  const dedicatedKey = booleans.has("--dedicated-key");
  const fromValue = values.get("--from")?.[0];
  const hostname = values.get("--hostname")?.[0];
  const portValue = values.get("--port")?.[0];
  if (!dedicatedKey && (fromValue !== undefined || hostname !== undefined || portValue !== undefined)) {
    throw new WorkerSetupError("--from, --hostname and --port describe the dedicated alias and require --dedicated-key");
  }
  if (hostname !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(hostname)) throw new WorkerSetupError("--hostname must be a host name or address");
  const port = portValue === undefined ? undefined : Number(portValue);
  if (port !== undefined && !(Number.isInteger(port) && port >= 1 && port <= 65535)) throw new WorkerSetupError("--port must be 1-65535");
  const userSshd = booleans.has("--user-sshd");
  if (userSshd && (!dedicatedKey || hostname === undefined || port === undefined)) {
    throw new WorkerSetupError("--user-sshd serves the dedicated alias and requires --dedicated-key, --hostname (the worker's tailnet address) and --port");
  }
  if (userSshd && port! < USER_SSHD_MIN_PORT) throw new WorkerSetupError(`--user-sshd runs without root and cannot listen below port ${USER_SSHD_MIN_PORT}`);
  const from = fromValue === undefined ? TAILNET_FROM : fromValue === "any" ? null : fromValue;
  if (from !== null && !from.split(",").every(item => /^!?[A-Za-z0-9.:*?\/_-]+$/.test(item))) {
    throw new WorkerSetupError("--from must be a comma-separated list of CIDRs/addresses/patterns, or any");
  }
  const stateDir = values.get("--state-dir")?.[0];
  if (stateDir !== undefined && !/^\/[A-Za-z0-9_./-]+$/.test(stateDir)) throw new WorkerSetupError("--state-dir must be an absolute path of plain characters");
  return {
    kind, name, ssh, roots: roots.map(normalizeRoot), dedicatedKey, userSshd, superkit, from, hostname, port, stateDir,
    dryRun: booleans.has("--dry-run"), replace: booleans.has("--replace"), configPath,
  };
}

function normalizeRoot(root: string): string {
  if (!/^\/[^\0\r\n]+$/.test(root)) throw new WorkerSetupError(`--root must be an absolute path: ${root}`);
  const normalized = join(root).replace(/(?<=.)\/+$/, "");
  if (normalized === "/") throw new WorkerSetupError("--root must not be the filesystem root");
  return normalized;
}

// ------------------------------------------------------- platform (one place)

/**
 * Everything that depends on the worker's operating system. A new platform
 * adds an entry here (its launch manager, requirements, one-time preparation,
 * doctor rows and native Host owner) and its Host launch path; the setup steps
 * themselves do not branch on it.
 */
interface PlatformPolicy {
  readonly owner: string;
  readonly describe: string;
  readonly requirements: (info: PreflightInfo) => string[];
  /** Worker-side one-time preparation after the release is installed; never raises a dialog. */
  readonly prepare: ((context: PrepareContext) => Promise<PrepareOutcome>) | null;
  /** Rows the worker's own capability adds to doctor. */
  readonly doctor: ((capability: WorkerCapability) => DoctorRow[]) | null;
}
export interface PrepareContext {
  readonly options: AddOptions;
  readonly io: SetupIo;
  readonly info: PreflightInfo;
  readonly release: string;
  readonly scope: MacosWorkerScope;
}
export interface PrepareOutcome { readonly status: "ok" | "would" | "attention"; readonly detail: string }

const describeScope = (items: readonly { path: string; category: string }[]) => items.map(item => `${item.path} (${item.category})`).join(", ");

type PrepareReport = MacosSetupReport & { pointerChanged: boolean };

function parsePrepareReport(text: string): PrepareReport {
  try {
    const report = JSON.parse(text) as PrepareReport;
    const strings = (value: unknown) => Array.isArray(value) && value.every(entry => typeof entry === "string");
    if (typeof report.setup === "string" && typeof report.launcher?.path === "string" && typeof report.launcher.cdhash === "string"
      && typeof report.launcher.installed === "boolean" && typeof report.pointerChanged === "boolean" && strings(report.granted)
      && Array.isArray(report.pending) && report.pending.every(item => typeof item.path === "string" && typeof item.category === "string")) return report;
  } catch { /* Reported below. */ }
  throw new WorkerSetupError("macOS launcher setup on the worker returned an unreadable report");
}

/** The fixed launcher, its payload pointer and what the owner still has to grant at the Mac; nothing here raises a privacy prompt. */
export async function macosPrepareStep({ options, io, info, release, scope }: PrepareContext): Promise<PrepareOutcome> {
  if (options.dryRun) {
    const owed = protectedPaths(scope, info.homeReal);
    return {
      status: "would",
      detail: `macOS launcher: would build and ad-hoc sign omp-sa-worker-launcher once if absent, point its payload at release ${release} and keep any recorded grants\n`
        + (owed.length ? `owner steps at the Mac would remain for: ${describeScope(owed)}` : "no root is privacy-protected: no owner step at the Mac"),
    };
  }
  const nonce = newNonce();
  const facts = await runScript(io.remote, options.ssh, macosPrepareScript({
    nonce, bun: info.bun!.path, release, scope: JSON.stringify(scope),
  }), nonce, 300_000, "macOS launcher setup");
  const report = parsePrepareReport(facts.prepare ?? "");
  const lines = [`macOS launcher ${report.launcher.path} (cdhash ${report.launcher.cdhash.slice(0, 12)}; ${report.launcher.installed ? "built and signed now" : "already installed, kept"}); `
    + `payload pointer ${report.pointerChanged ? "updated" : "unchanged"} -> release ${release}; `
    + `recorded grants: ${report.fullDiskAccess ? "Full Disk Access" : report.granted.join(", ") || "none"}`];
  if (!report.pending.length) return { status: "ok", detail: lines.join("\n") };
  lines.push(`owner steps remaining at the Mac (setup never triggers a dialog itself): ${describeScope(report.pending)}`,
    grantInstruction(report.launcher.path, report.setup, report.pending));
  return { status: "attention", detail: lines.join("\n") };
}

export function macosDoctorRows(capability: WorkerCapability): DoctorRow[] {
  const macos = capability.macos;
  if (!macos) return [];
  const rows: DoctorRow[] = [{ check: "macos session", status: "ok", detail: "GUI login session available; Hosts run in its launchd domain with the login keychain" }];
  // The account's own sshd (worker add --user-sshd), when its LaunchAgent exists: launchd state and sockets only, never a dialog.
  const sshd = macos.userSshd;
  const sshdRows: DoctorRow[] = !sshd ? [] : [sshd.state === "running" && sshd.listening.length
    ? { check: "user sshd", status: "ok", detail: `${USER_SSHD_LABEL} running, listening on ${sshd.listening.join(", ")}` }
    : { check: "user sshd", status: "warn", detail: `${USER_SSHD_LABEL} is ${sshd.state}${sshd.state === "running" ? " but listens on no socket" : ""}; run worker add again with --user-sshd to repair it (its log is ~/${USER_SSHD_DIRECTORY}/sshd.log on the worker)` }];
  if (!macos.launcher) {
    rows.push({ check: "macos launcher", status: "fail", detail: "the fixed worker launcher is not installed; run worker add again (it builds and signs it once; needs Xcode Command Line Tools on the Mac)" });
    return [...rows, ...sshdRows];
  }
  const identity = `${macos.launcher.path} (cdhash ${macos.launcher.cdhash.slice(0, 12)})`;
  rows.push(macos.launcherChanged
    ? { check: "macos launcher", status: "fail", detail: `${identity} is not the binary the recorded grants belong to; at the Mac, run: bun --no-env-file ${macos.setup} to re-record them (macOS ties a grant to the binary's signature)` }
    : { check: "macos launcher", status: "ok", detail: `${identity} matches the recorded grants` });
  rows.push(macos.pointer === "current"
    ? { check: "macos payload", status: "ok", detail: "the launcher's payload pointer names the installed release" }
    : { check: "macos payload", status: "warn", detail: `the launcher's payload pointer is ${macos.pointer}; it is rewritten before the next launch, or run worker add again` });
  rows.push(macos.missing.length
    ? { check: "macos grants", status: "fail", detail: `the launcher cannot read ${describeScope(macos.missing)}; ${grantInstruction(macos.launcher.path, macos.setup, macos.missing)}` }
    : { check: "macos grants", status: "ok", detail: "every privacy-protected root and the state directory is covered (or none is protected)" });
  return [...rows, ...sshdRows];
}
const PLATFORMS: Readonly<Record<string, PlatformPolicy>> = {
  linux: {
    owner: "linux",
    describe: "Linux with a systemd user manager",
    prepare: null,
    doctor: null,
    requirements: info => {
      const problems: string[] = [];
      if (info.userManager !== "running" && info.userManager !== "degraded") {
        problems.push(`the account has no running systemd user manager (systemctl --user is-system-running: ${info.userManager || "unavailable"}); `
          + "a Host must run in the user manager so it survives SSH logout");
      }
      if (info.linger !== "yes") {
        problems.push(`lingering is off for ${info.user}; ask an administrator to run: loginctl enable-linger ${info.user}`);
      }
      return problems;
    },
  },
  darwin: {
    owner: "darwin",
    describe: "macOS with a logged-in GUI session",
    prepare: macosPrepareStep,
    doctor: macosDoctorRows,
    requirements: info => {
      const problems: string[] = [];
      if (info.guiDomain !== "yes") {
        problems.push(`the account ${info.user} has no GUI login session (launchctl print gui/${info.uid || "<uid>"} failed): log in at the Mac's desktop as that account and stay logged in `
          + "(do not log out or fast-user-switch away; or enable automatic login), so Hosts run in its launchd domain with its login keychain");
      }
      if (!info.developerTools) {
        problems.push("install Xcode Command Line Tools (xcode-select --install) once at the Mac: the fixed worker launcher is compiled there, and compiling must not raise the install dialog during setup");
      }
      return problems;
    },
  },
};

export function platformPolicy(info: Pick<PreflightInfo, "system" | "direct">): PlatformPolicy | null {
  // Test fixtures only: a loopback "worker" on the CI machine's own platform, without its user manager or GUI session.
  if (info.direct) return { owner: info.system.toLowerCase(), describe: info.system, requirements: () => [], prepare: null, doctor: null };
  return PLATFORMS[info.system.toLowerCase()] ?? null;
}

const OWNER_ARCH: Readonly<Record<string, string>> = { x86_64: "x64", amd64: "x64", aarch64: "arm64", arm64: "arm64" };

// ------------------------------------------------------------------- preflight

export interface WorkerJson {
  workerId: string;
  instance: string;
  stateDir: string;
  workspaceRoots: string[];
  command: string[];
}
export interface PreflightInfo {
  system: string;
  machine: string;
  user: string;
  uid: string;
  home: string;
  homeReal: string;
  loginShell: string;
  direct: boolean;
  userManager: string;
  linger: string;
  /** macOS: `yes`/`no` for the `gui/<uid>` launchd domain; empty elsewhere. */
  guiDomain: string;
  /** macOS: Command Line Tools are installed (found by directory, never by running cc). */
  developerTools: boolean;
  omp: { path: string; version: string } | null;
  bun: { path: string; version: string } | null;
  git: string | null;
  chatModels: number | null;
  roots: { given: string; canonical: string | null; problem: string | null }[];
  /** null: absent; "invalid": present but not a usable provisioning file. */
  workerJson: WorkerJson | "invalid" | null;
  wrapper: string | null;
  /** Startup files (see PATH_FILES) that already carry the guarded PATH block. */
  pathMarkers: string[];
  hostKey: string | null;
  authorizedKey: "absent" | "no-file" | { line: string };
  releasePresent: boolean;
  releasePackage: { version: string; digest: string } | null;
  releaseCurrent: string | null;
}

function decode(value: string | undefined): string | null {
  return value ? Buffer.from(value, "base64").toString("utf8") : null;
}

function parseWorkerJson(text: string): WorkerJson | "invalid" {
  try {
    const value: unknown = JSON.parse(text);
    const record = value as Record<string, unknown>;
    if (record && typeof record.workerId === "string" && typeof record.instance === "string" && typeof record.stateDir === "string"
      && Array.isArray(record.workspaceRoots) && record.workspaceRoots.every(root => typeof root === "string")
      && Array.isArray(record.command) && record.command.every(entry => typeof entry === "string")) {
      return record as unknown as WorkerJson;
    }
  } catch { /* Reported as invalid below. */ }
  return "invalid";
}

export function parsePreflight(facts: Record<string, string>, roots: readonly string[]): PreflightInfo {
  const text = (key: string) => facts[key] ?? "";
  const tool = (path: string, version: string) => path ? { path, version } : null;
  const models = Number.parseInt(text("models_chat"), 10);
  const workerJson = decode(facts.worker_json);
  let release: PreflightInfo["releasePackage"] = null;
  try {
    const parsed = JSON.parse(text("release_package")) as { version?: unknown; digest?: unknown };
    if (typeof parsed.version === "string" && typeof parsed.digest === "string") release = { version: parsed.version, digest: parsed.digest };
  } catch { /* Missing or unverifiable. */ }
  return {
    system: text("uname_s"), machine: text("uname_m"), user: text("user"), uid: text("uid"), home: text("home"), homeReal: text("home_real"),
    loginShell: text("login_shell"), direct: text("direct") === "1", userManager: text("user_manager"), linger: text("linger"),
    guiDomain: text("gui_domain"), developerTools: facts.developer_tools === "yes",
    omp: tool(text("omp_path"), text("omp_version").replace(/^omp\//, "")),
    bun: tool(text("bun_path"), text("bun_version")),
    git: text("git_version") || null,
    chatModels: Number.isNaN(models) ? null : models,
    roots: roots.map((given, index) => {
      const value = text(`root.${index}`);
      return value === "!missing" ? { given, canonical: null, problem: "does not exist" }
        : value === "!notdir" ? { given, canonical: null, problem: "is not a directory" }
        : value ? { given, canonical: value, problem: null } : { given, canonical: null, problem: "could not be checked" };
    }),
    workerJson: workerJson === null ? null : parseWorkerJson(workerJson),
    wrapper: decode(facts.wrapper),
    pathMarkers: Object.values(PATH_FILES).filter(file => facts[`path_marker${file}`] === "yes"),
    hostKey: facts.host_key || null,
    authorizedKey: facts.authorized_keys_file === "none" ? "no-file" : facts.authorized_keys ? { line: facts.authorized_keys } : "absent",
    releasePresent: facts.release_present === "yes",
    releasePackage: release,
    releaseCurrent: facts.release_current || null,
  };
}

export interface PreflightPlan {
  readonly refusals: string[];
  readonly warnings: string[];
  /** File name of the native Host owner HEAD must ship for this worker, or null when the platform is unsupported. */
  readonly ownerBinary: string | null;
}

export function planPreflight(info: PreflightInfo): PreflightPlan {
  const refusals: string[] = [];
  const warnings: string[] = [];
  const policy = platformPolicy(info);
  const arch = OWNER_ARCH[info.machine];
  if (!policy) {
    refusals.push(`${info.system || "unknown"} workers are not supported; remote workers currently require ${Object.values(PLATFORMS).map(known => known.describe).join(" or ")}`);
  } else {
    refusals.push(...policy.requirements(info));
  }
  if (!arch) refusals.push(`unsupported worker architecture ${info.machine || "unknown"} (supported: x86_64, aarch64)`);
  if (/[^A-Za-z0-9_./-]/.test(info.homeReal) || !info.homeReal.startsWith("/")) {
    refusals.push(`home directory ${info.homeReal || "(unknown)"} contains characters worker provisioning does not support`);
  }
  if (!info.omp) refusals.push("OMP is not on the account's login-shell PATH (install it and sign in on the worker)");
  else if (!/^\d+\.\d+\.\d+/.test(info.omp.version)) refusals.push(`OMP did not report a version (${info.omp.version || "no output"})`);
  else if (Bun.semver.order(info.omp.version, MINIMUM_WORKER_OMP) < 0) {
    refusals.push(`OMP ${info.omp.version} is older than the required ${MINIMUM_WORKER_OMP}`);
  }
  if (info.omp && !(info.chatModels && info.chatModels > 0)) {
    refusals.push("the worker's OMP lists no chat models; sign in to a model provider as this account (the worker uses its own auth)");
  }
  if (!info.bun) refusals.push("bun is not on the account's login-shell PATH (needed to install and run the worker)");
  else if (!info.bun.path.startsWith("/")) refusals.push(`bun resolves to ${info.bun.path}, which is not an executable path`);
  if (!info.git) warnings.push("git is not installed on the worker; lanes cannot resolve repository roots there");
  for (const root of info.roots) if (root.problem) refusals.push(`--root ${root.given} ${root.problem} on the worker`);
  return { refusals, warnings, ownerBinary: policy && arch ? `omp-host-owner-${policy.owner}-${arch}` : null };
}

// -------------------------------------------------------------------- release

export interface ReleaseFile { path: string; data: Buffer; mode: number }

export function releaseId(pkg: { version: string; digest: string }): string {
  return `${pkg.version}-${pkg.digest.slice(0, 12)}`;
}

/** HEAD's package: exactly what workerPackage() digests, plus what the worker needs to run it. */
export function releaseFiles(root: string, ownerBinary: string): { files: ReleaseFile[]; lockfile: boolean } {
  const paths = ["package.json", "bin/omp-sa-worker", "upstream/ulw.json", `host-owner/bin/${ownerBinary}`];
  // macOS workers compile the fixed launcher once from this source.
  if (existsSync(join(root, "worker-launcher/omp-sa-worker-launcher.c"))) paths.push("worker-launcher/omp-sa-worker-launcher.c");
  const lockfile = existsSync(join(root, "bun.lock"));
  if (lockfile) paths.push("bun.lock");
  const walk = (directory: string): void => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) paths.push(path);
    }
  };
  walk("src");
  walk("skills");
  const files = [...new Set(paths)].sort().map(path => {
    const absolute = join(root, path);
    return { path, data: readFileSync(absolute), mode: statSync(absolute).mode & 0o111 ? 0o755 : 0o644 };
  });
  return { files, lockfile };
}

/** Deterministic ustar archive (fixed owner and mtime) so it extracts the same with any tar. */
export function ustarArchive(files: readonly ReleaseFile[]): Buffer {
  const blocks: Buffer[] = [];
  const field = (header: Buffer, offset: number, length: number, value: string) => {
    if (Buffer.byteLength(value) > length) throw new WorkerSetupError(`Archive field too long: ${value}`);
    header.write(value, offset, "latin1");
  };
  const octal = (value: number, length: number) => `${value.toString(8).padStart(length - 1, "0")}\0`;
  for (const file of files) {
    let name = file.path;
    let prefix = "";
    if (Buffer.byteLength(name) > 100) {
      const slash = name.split("/").findIndex((_, index, parts) => {
        const head = parts.slice(0, index + 1).join("/");
        return head.length <= 155 && name.length - head.length - 1 <= 100 && index < parts.length - 1;
      });
      if (slash === -1) throw new WorkerSetupError(`Path too long for the release archive: ${file.path}`);
      prefix = name.split("/").slice(0, slash + 1).join("/");
      name = name.slice(prefix.length + 1);
    }
    const header = Buffer.alloc(512);
    field(header, 0, 100, name);
    field(header, 100, 8, octal(file.mode, 8));
    field(header, 108, 8, octal(0, 8));
    field(header, 116, 8, octal(0, 8));
    field(header, 124, 12, octal(file.data.length, 12));
    field(header, 136, 12, octal(0, 12));
    header.fill(0x20, 148, 156);
    header.write("0", 156);
    field(header, 257, 6, "ustar\0");
    field(header, 263, 2, "00");
    field(header, 345, 155, prefix);
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
    blocks.push(header, file.data, Buffer.alloc((512 - file.data.length % 512) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

// --------------------------------------------------------- worker.json / config

const defaultStateDir = (homeReal: string) => `${homeReal}/${REMOTE_STATE_DIR}`;

/** A Host's public and native sockets live below stateDir/<24 hex>/ and must fit a Unix socket path. */
export function stateDirFits(stateDir: string): boolean {
  return Buffer.byteLength(join(stateDir, "0".repeat(24), "r12345678901.sock")) <= 100;
}

export interface WorkerJsonInputs {
  existing: WorkerJson | "invalid" | null;
  /** The HEAD's instance; for a dry run before first use, a placeholder. */
  instance: string;
  configured: WorkerConfig | undefined;
  /** Worker IDs registered under other names. */
  otherWorkers: ReadonlyMap<string, string>;
  replace: boolean;
  stateDir: string | undefined;
  homeReal: string;
  roots: readonly string[];
}
export interface WorkerJsonPlan {
  readonly desired: WorkerJson;
  readonly decision: "create" | "update" | "unchanged";
  readonly refusal: string | null;
  readonly notes: string[];
}

export function planWorkerJson(input: WorkerJsonInputs): WorkerJsonPlan {
  const { existing, configured } = input;
  const sameInstance = existing !== null && existing !== "invalid" && existing.instance === input.instance;
  const kept = sameInstance ? existing : null;
  const stateDir = input.stateDir ?? (existing && existing !== "invalid" ? existing.stateDir : defaultStateDir(input.homeReal));
  const workerId = configured?.workerId ?? kept?.workerId ?? randomUUID();
  const desired: WorkerJson = { workerId, instance: input.instance, stateDir, workspaceRoots: [...input.roots], command: ["omp"] };
  const notes: string[] = [];
  const refuse = (refusal: string) => ({ desired, decision: "update" as const, refusal, notes });
  if (existing === "invalid" && !input.replace) {
    return refuse("the worker's existing worker.json is not a valid provisioning file; inspect it, or pass --replace to back it up and write a new one");
  }
  if (existing && existing !== "invalid" && !sameInstance && !input.replace) {
    return refuse(`the worker already belongs to HEAD instance ${existing.instance}, not this HEAD (${input.instance}); `
      + "pass --replace to take it over (a backup of its worker.json is kept)");
  }
  if (kept && !configured) {
    const owner = input.otherWorkers.get(kept.workerId);
    if (owner) return refuse(`this account is already registered here as worker "${owner}"`);
  }
  if (existing && existing !== "invalid" && input.stateDir && existing.stateDir !== input.stateDir && sameInstance && !input.replace) {
    return refuse(`the worker keeps lane state in ${existing.stateDir}; moving it to ${input.stateDir} needs --replace`);
  }
  if (!stateDirFits(stateDir)) {
    return refuse(`worker state directory ${stateDir} is too long for private Unix sockets (limit: Unix socket path of 100 bytes); `
      + "pass a shorter --state-dir");
  }
  if (existing && existing !== "invalid" && sameInstance && existing.workerId !== workerId) {
    notes.push("the worker's workerId changes to the one HEAD already registered for this name");
  }
  if (kept && !isDeepStrictEqual(kept.workspaceRoots, desired.workspaceRoots)) {
    const removed = kept.workspaceRoots.filter(root => !desired.workspaceRoots.includes(root));
    if (removed.length) notes.push(`approved roots removed: ${removed.join(", ")}`);
  }
  if (existing && existing !== "invalid" && isDeepStrictEqual(existing, desired)) return { desired, decision: "unchanged", refusal: null, notes };
  return { desired, decision: existing === null ? "create" : "update", refusal: null, notes };
}

export function workerJsonText(value: WorkerJson): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function wrapperContent(homeReal: string, bunPath: string): string {
  return `#!/bin/sh\nexec ${sq(bunPath)} --no-env-file ${sq(`${homeReal}/${REMOTE_RELEASES}/current/bin/omp-sa-worker`)} "$@"\n`;
}

export interface ConfigMerge { text: string; changed: boolean; previous: WorkerConfig | undefined }

/** Add or update `workers.<name>` keeping every other key, its order and the file's indentation. */
export function mergeWorkerConfig(raw: string, name: string, entry: WorkerConfig): ConfigMerge {
  const document = JSON.parse(raw) as Record<string, unknown>;
  const workers = (document.workers ?? {}) as Record<string, WorkerConfig>;
  const previous = Object.hasOwn(workers, name) ? workers[name] : undefined;
  const next = { destination: entry.destination, workerId: entry.workerId, superkit: entry.superkit };
  if (previous && isDeepStrictEqual(previous, next)) return { text: raw, changed: false, previous };
  document.workers = { ...workers, [name]: next };
  const indent = /\n([ \t]+)\S/.exec(raw)?.[1] ?? "  ";
  return { text: `${JSON.stringify(document, null, indent)}${raw.endsWith("\n") ? "\n" : ""}`, changed: true, previous };
}

// ------------------------------------------------------------------------ SSH

export function authorizedKeysLine(commandPath: string, publicKey: string, from: string | null): string {
  if (!/^\/[A-Za-z0-9_./-]+$/.test(commandPath)) throw new WorkerSetupError(`Unsupported worker command path: ${commandPath}`);
  const key = publicKey.trim();
  if (!/^ssh-ed25519 [A-Za-z0-9+/]+=* ?[^\r\n]*$/.test(key)) throw new WorkerSetupError("Dedicated key is not a single ssh-ed25519 public key line");
  return `${from === null ? "" : `from="${from}",`}restrict,command="${commandPath}" ${key}`;
}

/** `ssh-ed25519 AAAA...`: the key without its comment. */
export function keyIdentity(publicKey: string): string {
  return publicKey.trim().split(/\s+/).slice(0, 2).join(" ");
}

export interface ResolvedHost { hostname: string; user: string; port: number; proxyJump: string | null }

/** Fields of `ssh -G <destination>` (OpenSSH prints one lowercase key and value per line). */
export function parseSshG(output: string): ResolvedHost {
  const fields = new Map<string, string>();
  for (const line of output.split("\n")) {
    const space = line.indexOf(" ");
    if (space > 0 && !fields.has(line.slice(0, space))) fields.set(line.slice(0, space), line.slice(space + 1).trim());
  }
  const hostname = fields.get("hostname");
  const user = fields.get("user");
  if (!hostname || !user) throw new WorkerSetupError("Could not read the setup destination's HostName and User from ssh -G");
  const proxyJump = fields.get("proxyjump");
  return { hostname, user, port: Number(fields.get("port") ?? 22), proxyJump: proxyJump && proxyJump !== "none" ? proxyJump : null };
}

const managedComment = (name: string) => `# omp-superagent worker ${name} (managed by omp-sa worker add)`;

export function sshConfigBlock(name: string, host: ResolvedHost, identityFile: string): string {
  return [
    managedComment(name), `Host omp-sa-${name}`, `  HostName ${host.hostname}`, `  User ${host.user}`, `  Port ${host.port}`,
    ...host.proxyJump ? [`  ProxyJump ${host.proxyJump}`] : [],
    // The worker client passes these too; the alias states them so manual use is just as strict.
    `  IdentityFile ${identityFile}`, "  IdentitiesOnly yes", "  StrictHostKeyChecking yes", "  BatchMode yes", "",
  ].join("\n");
}

export interface HostBlock { start: number; end: number; managed: boolean; settings: Map<string, string> }

/** The block whose `Host` line names exactly this alias (lines [start, end) of the file). */
export function findHostBlock(config: string, alias: string): HostBlock | null {
  const lines = config.split("\n");
  const start = lines.findIndex(line => /^\s*Host\s/i.test(line) && line.trim().split(/\s+/).slice(1).includes(alias));
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && !/^\s*(Host|Match)\s/i.test(lines[end]!)) end++;
  const settings = new Map<string, string>();
  for (const line of lines.slice(start + 1, end)) {
    const match = /^\s*([A-Za-z]+)\s*[= ]\s*(.*?)\s*$/.exec(line);
    if (match && !line.trim().startsWith("#") && !settings.has(match[1]!.toLowerCase())) settings.set(match[1]!.toLowerCase(), match[2]!);
  }
  return { start, end, managed: start > 0 && lines[start - 1]!.startsWith("# omp-superagent worker "), settings };
}

/** What differs between an existing alias block and the one `worker add` would write. */
export function blockMismatches(block: HostBlock, host: ResolvedHost, identityFile: string): string[] {
  const home = headHome();
  const identity = block.settings.get("identityfile")?.replace(/^~(?=\/)/, home);
  const want: [string, string | undefined, string][] = [
    ["HostName", block.settings.get("hostname"), host.hostname], ["User", block.settings.get("user"), host.user],
    ["Port", block.settings.get("port") ?? "22", String(host.port)], ["IdentityFile", identity, identityFile],
    ["IdentitiesOnly", block.settings.get("identitiesonly")?.toLowerCase(), "yes"],
    ["StrictHostKeyChecking", block.settings.get("stricthostkeychecking")?.toLowerCase(), "yes"],
    ["BatchMode", block.settings.get("batchmode")?.toLowerCase(), "yes"],
    ["ProxyJump", block.settings.get("proxyjump") ?? "", host.proxyJump ?? ""],
  ];
  return want.filter(([, actual, expected]) => actual !== expected).map(([key, actual, expected]) => `${key} is ${actual ?? "unset"}, expected ${expected}`);
}

export const knownHostsName = (hostname: string, port: number): string => port === 22 ? hostname : `[${hostname}]:${port}`;

export type ForcedCommand = "enforced" | "bypassed" | "unclear";

/** `ssh <alias> whoami` must answer with a worker protocol frame, never with whoami's output. */
export function classifyForcedCommand(stdout: string): ForcedCommand {
  const first = stdout.split("\n")[0]?.trim() ?? "";
  if (!first) return "unclear";
  try {
    const frame = JSON.parse(first) as { protocol?: unknown };
    if (typeof frame.protocol === "string" && frame.protocol.startsWith("omp-sa-worker")) return "enforced";
  } catch { /* Not a frame. */ }
  return "bypassed";
}

/** Shared by the refusal and the doctor warning: how to get an OpenSSH listener that honors authorized_keys options. */
function openSshFix(): string[] {
  return [
    "Fix it on the worker as an administrator (worker add never changes sshd). Keep Tailscale SSH on :22 and run OpenSSH on the worker's tailnet address at another port:",
    "  socket-activated sshd (Ubuntu): create /etc/systemd/system/ssh.socket.d/omp-sa.conf containing",
    "      [Socket]", "      ListenStream=<tailnet-ip>:2222", "      FreeBind=yes",
    "    then: systemctl daemon-reload && systemctl restart ssh.socket",
    "  otherwise: create /etc/ssh/sshd_config.d/omp-sa.conf containing",
    "      ListenAddress 0.0.0.0:22", "      ListenAddress [::]:22", "      ListenAddress <tailnet-ip>:2222",
    "    then: sshd -t && systemctl reload ssh",
    "Then re-run worker add with --dedicated-key --hostname <tailnet-ip-or-name> --port 2222.",
  ];
}

export function tailscaleRemedy(alias: string): string {
  return [
    `\`ssh ${alias} whoami\` ran whoami instead of the worker command: the address ${alias} reaches is not served by OpenSSH honoring authorized_keys options`,
    "(for example Tailscale SSH, which ignores forced commands, from= and restrict). HEAD refuses to use it for a worker.",
    ...openSshFix(),
  ].join("\n");
}

/** A destination HEAD was not set up with a dedicated key for still runs arbitrary commands when it answers `whoami`. */
export function unenforcedWarning(destination: string): string {
  return [
    `\`ssh ${destination} whoami\` ran whoami: ${destination} runs arbitrary commands, so authorized_keys options (command=, from=, restrict) are not enforced.`,
    "This is what Tailscale SSH does on a tailnet address's port 22; HEAD's key there is a full shell on the worker account.",
    ...openSshFix(),
  ].join("\n");
}

// ----------------------------------------------------------------- local state

const metaPath = (stateDir: string) => join(stateDir, "coordination.sqlite");

function readMeta(stateDir: string, key: string): string | null {
  if (!existsSync(metaPath(stateDir))) return null;
  const db = new Database(metaPath(stateDir), { readonly: true });
  try { return db.query<{ value: string }, [string]>("SELECT value FROM metadata WHERE key = ?").get(key)?.value ?? null; }
  finally { db.close(); }
}

function writeMeta(stateDir: string, key: string, value: string): void {
  const db = new Database(metaPath(stateDir));
  try {
    db.run("PRAGMA busy_timeout = 5000");
    db.query("INSERT INTO metadata(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  } finally { db.close(); }
}

/** HEAD's `worker:instance`, created by the same code a first remote launch uses unless `create` is false. */
export async function headInstance(stateDir: string, create: boolean): Promise<{ instance: string | null; created: boolean }> {
  const saved = readMeta(stateDir, "worker:instance");
  if (saved) return { instance: saved, created: false };
  if (!create) return { instance: null, created: false };
  if (!existsSync(metaPath(stateDir))) {
    const store = new Store(metaPath(stateDir));
    try { return { instance: workerInstance(store), created: true }; } finally { store.close(); }
  }
  // HEAD's own database without an instance yet: do not take its writer lock; first writer wins.
  const db = new Database(metaPath(stateDir));
  try {
    db.run("PRAGMA busy_timeout = 5000");
    workerInstance({
      getMeta: key => db.query<{ value: string }, [string]>("SELECT value FROM metadata WHERE key = ?").get(key)?.value ?? null,
      setMeta: (key, value) => { db.query("INSERT OR IGNORE INTO metadata(key, value) VALUES (?, ?)").run(key, value); },
    });
    const instance = db.query<{ value: string }, [string]>("SELECT value FROM metadata WHERE key = ?").get("worker:instance")?.value ?? null;
    return { instance, created: true };
  } finally { db.close(); }
}

const timestamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");

/** Atomic replace of a HEAD-side file after copying the original to `<file>.bak-<time>`. */
function replaceLocalFile(path: string, content: string, mode: number): string | null {
  const target = existsSync(path) ? realpathSync(path) : path;
  let backup: string | null = null;
  if (existsSync(target)) {
    backup = `${target}.bak-${timestamp()}`;
    copyFileSync(target, backup);
    chmodSync(backup, statSync(target).mode & 0o777);
  }
  const temporary = `${target}.omp-sa.${process.pid}`;
  writeFileSync(temporary, content, { mode });
  chmodSync(temporary, existsSync(target) ? statSync(target).mode & 0o777 : mode);
  renameSync(temporary, target);
  return backup;
}

// ----------------------------------------------------------------- SSH runners

export interface RemoteResult { code: number | null; stdout: string; stderr: string }
export type RemoteRunner = (destination: string, command: string, stdin: string | Uint8Array | null, timeoutMs: number) => Promise<RemoteResult>;

/** Only what OpenSSH needs: HEAD's application and provider environment never reaches ssh or its children. */
function sshEnvironment(): Record<string, string> {
  return Object.fromEntries(["HOME", "USER", "LOGNAME", "PATH", "SSH_AUTH_SOCK"].flatMap(key => {
    const value = process.env[key];
    return value === undefined ? [] : [[key, value]];
  }));
}

async function localCommand(argv: string[], timeoutMs = 30_000): Promise<RemoteResult> {
  const child = Bun.spawn(argv, { env: sshEnvironment(), stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: timeoutMs, killSignal: "SIGKILL" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, stdout, stderr };
}

/** Ordinary non-interactive OpenSSH to the setup destination: no tty, no agent/port forwarding, host keys checked. */
export const sshRemote: RemoteRunner = async (destination, command, stdin, timeoutMs) => {
  const child = Bun.spawn(["ssh", "-T", "-a", "-x", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
    "-o", "ClearAllForwardings=yes", "-o", "ControlPath=none", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=4", "--", destination, command],
  { env: sshEnvironment(), stdin: stdin === null ? "ignore" : Buffer.from(stdin), stdout: "pipe", stderr: "pipe", timeout: timeoutMs, killSignal: "SIGKILL" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, stdout, stderr };
};

/** The destination never answered (as opposed to refusing the key or the command). */
export const sshUnreachable = (stderr: string): boolean => /connection refused|timed out|no route to host|network is unreachable/i.test(stderr);

/** If the setup destination is a Mac: the least invasive way to let ssh in. Onboarding never changes a system setting. */
export function remoteLoginNote(destination: string): string {
  return `If ${destination} is a Mac: enable System Settings > General > Sharing > Remote Login at the Mac, and limit "Allow access for" to the worker account only `
    + "(not all users); no other sharing service or setting is needed. omp-sa never changes system settings; run worker add again afterwards.";
}

const tail = (text: string, limit = 400) => text.trim().split("\n").slice(-4).join(" | ").slice(-limit);

async function runScript(remote: RemoteRunner, destination: string, script: string, nonce: string, timeoutMs: number, what: string) {
  const result = await remote(destination, "sh -s", script, timeoutMs);
  return factsOrThrow(result, nonce, what);
}

function factsOrThrow(result: RemoteResult, nonce: string, what: string): Record<string, string> {
  const facts = parseFacts(result.stdout, nonce);
  if (facts.error) throw new WorkerSetupError(`${what} failed on the worker: ${facts.error}${facts.log ? `\n${facts.log}` : ""}`);
  if (result.code !== 0) {
    throw new WorkerSetupError(`${what} failed (ssh exit ${result.code})${result.stderr.trim() ? `: ${tail(result.stderr)}` : ""}`);
  }
  return facts;
}

// ----------------------------------------------------------------- add (steps)

export interface SetupIo {
  log: (line: string) => void;
  remote: RemoteRunner;
}
const defaultIo: SetupIo = { log: line => console.log(line), remote: sshRemote };

const STEPS = ["validate", "preflight", "install", "command", "worker.json", "memory", "user-sshd", "dedicated-key", "register", "doctor"] as const;

class Reporter {
  constructor(private readonly log: SetupIo["log"], private readonly dryRun: boolean) {}
  step(index: number, status: string, detail: string): void {
    const lines = detail.split("\n");
    this.log(`[${index + 1}/${STEPS.length}] ${STEPS[index]!.padEnd(14)} ${status.padEnd(9)} ${lines[0]}`);
    for (const line of lines.slice(1)) this.log(`${" ".repeat(28)}${line}`);
  }
  refuse(index: number, reasons: string[]): never {
    this.step(index, "REFUSED", reasons.join("\n"));
    throw new WorkerSetupError(`worker add stopped at step ${index + 1} (${STEPS[index]})${this.dryRun ? " (dry run)" : ""}`);
  }
}

export interface AddResult {
  instance: string;
  workerId: string;
  destination: string;
  release: string;
  dryRun: boolean;
  doctor: DoctorResult | null;
}

async function resolveRuntimeDestination(options: AddOptions): Promise<string> {
  const destination = options.dedicatedKey ? `omp-sa-${options.name}` : options.ssh;
  if (!SSH_ALIAS.test(destination)) {
    throw new WorkerSetupError(`The runtime destination ${destination} must be an SSH config alias; use an alias for --ssh, or pass --dedicated-key to generate one`);
  }
  return destination;
}

export async function workerAdd(options: AddOptions, io: SetupIo = defaultIo): Promise<AddResult> {
  const report = new Reporter(io.log, options.dryRun);
  io.log(`omp-sa worker add ${options.name}${options.dryRun ? " --dry-run (nothing is changed)" : ""}`);

  // 1. Validate locally.
  const config = await loadConfig(options.configPath);
  const runtimeDestination = await resolveRuntimeDestination(options);
  const head = await headInstance(config.stateDir, !options.dryRun);
  const instance = head.instance ?? randomUUID();
  const pkg = workerPackage();
  const id = releaseId(pkg);
  const configured = config.workers && Object.hasOwn(config.workers, options.name) ? config.workers[options.name] : undefined;
  report.step(0, "ok", `config ${config.path}; HEAD instance ${head.instance ?? "new"}${head.created ? " (created)" : head.instance ? "" : " (created on a real run)"}\n`
    + `package ${pkg.version} (${pkg.digest.slice(0, 12)}); runtime destination ${runtimeDestination}`);

  // 2. Preflight over the setup connection.
  const dedicated = options.dedicatedKey ? dedicatedKeyPaths(options.name) : null;
  const existingPublicKey = dedicated && existsSync(dedicated.publicPath) ? readFileSync(dedicated.publicPath, "utf8") : null;
  const nonce = newNonce();
  const preflight = await io.remote(options.ssh, "sh -s", preflightScript({
    nonce, roots: options.roots, releaseId: id, authorizedKey: existingPublicKey && keyIdentity(existingPublicKey),
  }), 150_000);
  if (preflight.code === 255 && sshUnreachable(preflight.stderr)) {
    throw new WorkerSetupError(`Preflight failed (ssh exit 255): ${tail(preflight.stderr)}\n${remoteLoginNote(options.ssh)}`);
  }
  const facts = factsOrThrow(preflight, nonce, "Preflight");
  const info = parsePreflight(facts, options.roots);
  const plan = planPreflight(info);
  const ownerBinary = plan.ownerBinary;
  const reasons = [...plan.refusals];
  if (options.userSshd && info.system === "Linux") {
    reasons.push("--user-sshd is macOS only: an sshd that honors authorized_keys options on another port needs root on Linux. "
      + "Have an administrator set it up with the drop-in recipe below, then run worker add without --user-sshd", ...openSshFix());
  }
  if (ownerBinary && !existsSync(join(packageRoot, "host-owner/bin", ownerBinary))) {
    reasons.push(`HEAD's package has no native Host owner for this worker (host-owner/bin/${ownerBinary}); install the official npm package, `
      + "which carries every platform, or build it for this architecture");
  }
  const json = planWorkerJson({
    existing: info.workerJson, instance, configured, replace: options.replace, stateDir: options.stateDir, homeReal: info.homeReal,
    roots: info.roots.map(root => root.canonical ?? root.given),
    otherWorkers: new Map(Object.entries(config.workers ?? {}).filter(([name]) => name !== options.name).map(([name, worker]) => [worker.workerId, name])),
  });
  if (json.refusal) reasons.push(json.refusal);
  if (reasons.length) report.refuse(1, reasons);
  const bun = info.bun!;
  report.step(1, "ok", `${info.system} ${info.machine} as ${info.user}; ${platformPolicy(info)!.describe}; omp ${info.omp!.version} (${info.chatModels} chat models); `
    + `bun ${bun.version}; ${info.git ?? "no git"}\nroots: ${info.roots.map(root => root.canonical).join(", ")}${plan.warnings.map(warning => `\nwarning: ${warning}`).join("")}`);

  // 3. Install HEAD's exact release.
  const verified = info.releasePresent && info.releasePackage?.version === pkg.version && info.releasePackage.digest === pkg.digest;
  const release = releaseFiles(packageRoot, ownerBinary!);
  // The platform's own one-time preparation (macOS: the fixed launcher) runs once the release is in place.
  const prepare = async (): Promise<PrepareOutcome | null> => platformPolicy(info)!.prepare?.({
    options, io, info, release: id, scope: { stateDir: json.desired.stateDir, workspaceRoots: json.desired.workspaceRoots },
  }) ?? null;
  if (verified) {
    const prepared = await prepare();
    report.step(2, prepared?.status === "attention" ? "attention" : "skipped",
      `release ${id} is installed and verifies${info.releaseCurrent === id ? " (current)" : "; would switch current to it"}${prepared ? `\n${prepared.detail}` : ""}`);
  } else if (options.dryRun) {
    const prepared = await prepare();
    report.step(2, "would", `install release ${id} (${release.files.length} files${release.lockfile ? "" : "; HEAD package has no bun.lock, dependency ranges resolve"})`
      + `${info.releasePresent ? "; the existing directory does not verify and would be moved aside" : ""}${prepared ? `\n${prepared.detail}` : ""}`);
  } else {
    const archive = ustarArchive(release.files);
    const installNonce = newNonce();
    const script = installScript({
      nonce: installNonce, releaseId: id, version: pkg.version, digest: pkg.digest, frozen: release.lockfile,
      tarSha256: createHash("sha256").update(archive).digest("hex"),
    });
    const result = await io.remote(options.ssh, `sh -c ${sq(script)}`, archive, 900_000);
    const installed = factsOrThrow(result, installNonce, "Release install");
    const prepared = await prepare();
    report.step(2, prepared?.status === "attention" ? "attention" : "installed", `release ${id} ${installed.installed === "new" ? "installed" : "already present"}; current -> ${installed.current}`
      + `${release.lockfile ? "" : "\nHEAD package has no bun.lock: dependency ranges were resolved, not frozen"}`
      + `${installed.moved_aside ? `\nan unverified directory was kept at ${installed.moved_aside}` : ""}${prepared ? `\n${prepared.detail}` : ""}`);
  }

  // 4. Command and PATH.
  const wrapper = wrapperContent(info.homeReal, bun.path);
  const wrapperDecision = info.wrapper === wrapper ? "unchanged" : info.wrapper === null ? "create" : "update";
  const binDirectory = `${info.homeReal}/.local/bin`;
  const onPath = async () => (await io.remote(options.ssh, `sh -c 'printf %s "$PATH"'`, null, 30_000)).stdout.split(":").some(entry =>
    entry === binDirectory || entry === `${info.home}/.local/bin`);
  // The startup file a non-interactive SSH command of the login shell reads (zsh, the macOS default, reads ~/.zshenv, not ~/.bashrc).
  const pathFile = PATH_FILES[basename(info.loginShell)] ?? null;
  const marked = pathFile !== null && info.pathMarkers.includes(pathFile);
  const needsPath = !(await onPath());
  const pathAction = !needsPath ? "~/.local/bin is already on the non-interactive SSH PATH"
    : marked ? `~/${pathFile} already has the PATH block (still not effective; check the worker's ~/${pathFile})`
    : pathFile ? `would add the guarded PATH block at the top of ~/${pathFile}`
    : `login shell ${info.loginShell || "unknown"} is neither bash nor zsh: add ~/.local/bin to its non-interactive PATH yourself`;
  if (options.dryRun) {
    report.step(3, "would", `wrapper ${binDirectory}/omp-sa-worker: ${wrapperDecision}; ${pathAction}`);
  } else {
    const commandNonce = newNonce();
    const done = await runScript(io.remote, options.ssh, commandScript({ nonce: commandNonce, wrapper, pathFile: needsPath && !marked ? pathFile : null }),
      commandNonce, 60_000, "Command installation");
    const afterProbe = await io.remote(options.ssh, "sh -c 'command -v omp-sa-worker'", null, 30_000);
    const found = afterProbe.stdout.trim();
    report.step(3, found ? "ok" : "attention", `wrapper ${done.wrapper}; ${done.path ? `~/${pathFile} ${done.path}; ` : ""}`
      + (found ? `omp-sa-worker resolves over ordinary SSH (${found})`
        : `omp-sa-worker does not resolve over a non-interactive SSH login yet. Add ${binDirectory} to that PATH on the worker (${pathAction}); `
          + "a dedicated key's forced command does not need it"));
  }

  // 5. worker.json.
  const desiredJson = workerJsonText(json.desired);
  if (options.dryRun) {
    report.step(4, "would", `${json.decision} ${info.home}/.config/omp-superagent/worker.json (workerId ${json.desired.workerId}); state dir ${json.desired.stateDir}`
      + json.notes.map(note => `\n${note}`).join(""));
  } else {
    const jsonNonce = newNonce();
    const written = await runScript(io.remote, options.ssh, workerJsonScript({ nonce: jsonNonce, content: desiredJson, stateDir: json.desired.stateDir }),
      jsonNonce, 60_000, "worker.json provisioning");
    report.step(4, "ok", `worker.json ${written.worker_json}; workerId ${json.desired.workerId}; state dir ${json.desired.stateDir}; roots ${json.desired.workspaceRoots.join(", ")}`
      + `${written.fixed_config_permissions ? "\nremoved group/other write permission from ~/.config" : ""}`
      + json.notes.map(note => `\n${note}`).join(""));
  }

  // 6. Native memory parity: the same default HEAD applies to its own profile.
  const memory = await memoryStep(options, io, info, id, verified, report);

  // The worker's own sshd comes first: the dedicated key's forced-command probe connects to it.
  const sshd = await userSshdStep(options, io, info, report);

  // Dedicated key, host key pin, ssh alias (also steps of the dedicated-key flow).
  if (dedicated) await dedicatedKeyStep(options, io, sshd.hostKey ? { ...info, hostKey: sshd.hostKey } : info, dedicated, report, sshd.hostKeyPlanned);
  else report.step(7, "skipped", `using the existing SSH alias ${runtimeDestination} as the runtime destination`);

  // 7. Register in HEAD's config.
  const entry: WorkerConfig = { destination: runtimeDestination, workerId: json.desired.workerId, superkit: options.superkit };
  const raw = readFileSync(config.path, "utf8");
  const merged = mergeWorkerConfig(raw, options.name, entry);
  parseConfig(JSON.parse(merged.text), config.path);
  const changedIdentity = merged.previous && (merged.previous.destination !== entry.destination || merged.previous.workerId !== entry.workerId);
  const identityWarning = changedIdentity ? "\nwarning: lanes already bound to the previous destination/workerId refuse to resume until closed" : "";
  if (!merged.changed) report.step(8, "unchanged", `workers.${options.name} already registered in ${config.path}`);
  else if (options.dryRun) report.step(8, "would", `${merged.previous ? "update" : "add"} workers.${options.name} = ${JSON.stringify(entry)} in ${config.path}${identityWarning}`);
  else {
    const backup = replaceLocalFile(config.path, merged.text, 0o600);
    report.step(8, "ok", `${merged.previous ? "updated" : "added"} workers.${options.name} in ${config.path}${backup ? ` (backup ${backup})` : ""}${identityWarning}`
      + "\na running Gateway does not reload its config; the next start uses it");
  }

  // 8. Doctor.
  let doctor: DoctorResult | null = null;
  if (options.dryRun) report.step(9, "would", `run worker doctor ${options.name}`);
  else {
    const verifiedConfig = await loadConfig(options.configPath);
    doctor = await runDoctor(verifiedConfig, options.name, io, { memory });
    report.step(9, doctor.ok ? "ok" : "FAILED", doctor.ok ? "worker doctor passed" : "worker doctor reported failures (below)");
    io.log(renderDoctor(doctor));
  }
  return { instance, workerId: json.desired.workerId, destination: runtimeDestination, release: id, dryRun: options.dryRun, doctor };
}

type MemoryOutcome = { backend: string; updated: boolean } | null;

async function memoryStep(options: AddOptions, io: SetupIo, info: PreflightInfo, id: string, installed: boolean, report: Reporter): Promise<MemoryOutcome> {
  if (options.dryRun && !installed) {
    report.step(5, "would", "inspect the worker account's OMP memory backend once the release is installed");
    return null;
  }
  const cwd = info.roots[0]!.canonical!;
  const inspect = async (consent: ManagedMemoryStatus | null): Promise<ManagedMemoryReport> => {
    const nonce = newNonce();
    const agentDir = consent && "agentDir" in consent ? consent.agentDir : null;
    const facts = await runScript(io.remote, options.ssh, memoryScript({
      nonce, release: id, cwd, consent: consent && JSON.stringify(consent), agentDir,
    }), nonce, 150_000, "Memory check");
    return parseMemoryHelperOutput(facts.memory ?? "");
  };
  const current = (await inspect(null)).memory;
  if (current.status === "enabled") {
    report.step(5, "ok", `worker OMP memory backend ${current.backend} (${current.source} settings, ${current.agentDir}); unchanged`);
    return { backend: current.backend, updated: false };
  }
  if (!canEnableGlobalMemory(current)) {
    report.step(5, "attention", `${memoryBlockReason(current)} Not changed.`);
    return null;
  }
  const text = `worker OMP memory is ${current.backend} (${current.source} settings, ${current.agentDir}); set memory.backend=mnemopi, the default HEAD applies to its own profile`;
  if (options.dryRun) {
    report.step(5, "would", text);
    return null;
  }
  const applied = await inspect(current);
  if (applied.memory.status !== "enabled") {
    report.step(5, "attention", `${text} - not applied. ${memoryBlockReason(applied.memory)}`);
    return null;
  }
  report.step(5, "ok", `${text}: now ${applied.memory.backend}${applied.updated ? " (written; an existing config.yml was first copied to config.yml.bak-*)" : " (changed concurrently by another writer)"}`);
  return { backend: applied.memory.backend, updated: applied.updated };
}

const SSHD_FILE_TEXT = { create: "create", update: "rewrite (the previous file is kept as .bak-*)", unchanged: "unchanged" } as const;
const SSHD_LAUNCHD_TEXT = {
  none: "already running with this configuration, left alone", bootstrap: "load the LaunchAgent (launchctl bootstrap)",
  kickstart: "restart it to read the configuration (launchctl kickstart -k)", reload: "reload it (launchctl bootout, then bootstrap)",
} as const;

function describeUserSshd(plan: UserSshdPlan, home: string, listen: readonly string[], verb: "would" | "did"): string {
  const directory = userSshdDirectory(home);
  const host = plan.hostKey === "create" ? `${verb === "would" ? "would create" : "created"} the ed25519 host key in ${directory}` : `host key in ${directory} kept`;
  return [
    `own sshd on ${listen.join(", ")} (AllowUsers this account only; no root, no Remote Login)`,
    host,
    `sshd_config ${SSHD_FILE_TEXT[plan.config]}`,
    `LaunchAgent ${USER_SSHD_LABEL}.plist ${SSHD_FILE_TEXT[plan.plist]}`,
    `launchd: ${SSHD_LAUNCHD_TEXT[plan.launchd]}`,
  ].join("\n");
}

/**
 * macOS `--user-sshd`: the worker account runs its own non-root sshd (see worker-user-sshd) over the setup connection, so the
 * dedicated key's forced command is served by an OpenSSH that honors it. Returns the host key to pin (the one this sshd has).
 */
async function userSshdStep(options: AddOptions, io: SetupIo, info: PreflightInfo, report: Reporter): Promise<{ hostKey: string | null; hostKeyPlanned: boolean }> {
  if (!options.userSshd) {
    report.step(6, "skipped", "not requested (--user-sshd)");
    return { hostKey: null, hostKeyPlanned: false };
  }
  const desired: UserSshdDesired = { home: info.homeReal, user: info.user, listen: [listenAddress(options.hostname!, options.port!)] };
  const inspectNonce = newNonce();
  const current = await runScript(io.remote, options.ssh, userSshdInspectScript({ nonce: inspectNonce, label: USER_SSHD_LABEL }), inspectNonce, 60_000, "User sshd inspection");
  if (current.sshd_binary !== "yes") report.refuse(6, [`${USER_SSHD_BINARY} is not available on the worker`]);
  const plan = planUserSshd({
    config: decode(current.sshd_config), plist: decode(current.sshd_plist), hostKey: current.host_key || null,
    launchd: !current.launchd || current.launchd === "absent" ? null : current.launchd,
  }, desired);
  if (options.dryRun) {
    report.step(6, "would", describeUserSshd(plan, info.homeReal, desired.listen, "would"));
    return { hostKey: current.host_key || null, hostKeyPlanned: plan.hostKey === "create" };
  }
  const nonce = newNonce();
  const done = await runScript(io.remote, options.ssh, userSshdApplyScript({
    nonce, label: USER_SSHD_LABEL, config: userSshdConfig(desired), plist: userSshdPlist(desired), port: options.port!, action: plan.launchd,
  }), nonce, 120_000, "User sshd setup");
  const unchanged = plan.config === "unchanged" && plan.plist === "unchanged" && plan.hostKey === "keep" && plan.launchd === "none";
  report.step(6, unchanged ? "unchanged" : "ok", `${describeUserSshd(plan, info.homeReal, desired.listen, "did")}\nrunning and listening: ${done.listening!.trim()}`);
  return { hostKey: done.host_key || null, hostKeyPlanned: false };
}

interface DedicatedKeyPaths { privatePath: string; publicPath: string; sshDirectory: string }

function dedicatedKeyPaths(name: string): DedicatedKeyPaths {
  const sshDirectory = join(headHome(), ".ssh");
  const privatePath = join(sshDirectory, `omp-sa-${name}_ed25519`);
  return { privatePath, publicPath: `${privatePath}.pub`, sshDirectory };
}

async function dedicatedKeyStep(options: AddOptions, io: SetupIo, info: PreflightInfo, paths: DedicatedKeyPaths, report: Reporter,
  hostKeyPlanned: boolean): Promise<void> {
  const alias = `omp-sa-${options.name}`;
  const notes: string[] = [];
  const dry = options.dryRun;

  // Key pair on HEAD; the private key is never read or printed.
  let publicKey = existsSync(paths.publicPath) ? readFileSync(paths.publicPath, "utf8").trim() : null;
  if (publicKey) notes.push(`key ${paths.privatePath} exists`);
  else if (dry) notes.push(`would create ed25519 key ${paths.privatePath}`);
  else {
    mkdirSync(paths.sshDirectory, { recursive: true, mode: 0o700 });
    if (!existsSync(paths.privatePath)) {
      const made = await localCommand(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", alias, "-f", paths.privatePath]);
      if (made.code !== 0) throw new WorkerSetupError(`ssh-keygen failed: ${tail(made.stderr)}`);
    } else {
      const derived = await localCommand(["ssh-keygen", "-y", "-f", paths.privatePath]);
      if (derived.code !== 0) throw new WorkerSetupError(`Cannot read the existing key ${paths.privatePath} (is it passphrase protected?)`);
      writeFileSync(paths.publicPath, `${derived.stdout.trim()} ${alias}\n`, { mode: 0o644 });
    }
    publicKey = readFileSync(paths.publicPath, "utf8").trim();
    notes.push(`created ed25519 key ${paths.privatePath}`);
  }

  // authorized_keys line on the worker.
  const wrapperPath = `${info.homeReal}/.local/bin/omp-sa-worker`;
  const line = publicKey ? authorizedKeysLine(wrapperPath, publicKey, options.from) : null;
  if (line && publicKey) {
    const state = info.authorizedKey;
    if (dry) {
      notes.push(typeof state === "object" ? (state.line === line ? "authorized_keys already has the line" : `authorized_keys has this key with different options; expected: ${line}`)
        : "would append the restricted line to the worker's authorized_keys (backup first)");
    } else {
      const nonce = newNonce();
      const done = await runScript(io.remote, options.ssh, authorizedKeysScript({ nonce, line, key: keyIdentity(publicKey) }), nonce, 60_000, "authorized_keys update");
      if (done.authorized_keys === "different") {
        report.refuse(7, [`the worker's authorized_keys already has this key with other options; edit that line to exactly:\n${line}`]);
      }
      notes.push(`worker authorized_keys ${done.authorized_keys}`);
    }
  } else notes.push("would append the restricted authorized_keys line once the key exists");

  // Host alias and pinned host key on HEAD.
  const resolved = await localCommand(["ssh", "-G", options.ssh]);
  if (resolved.code !== 0) throw new WorkerSetupError(`ssh -G ${options.ssh} failed: ${tail(resolved.stderr)}`);
  const base = parseSshG(resolved.stdout);
  const host: ResolvedHost = { ...base, hostname: options.hostname ?? base.hostname, port: options.port ?? base.port };
  const configFile = join(paths.sshDirectory, "config");
  const existing = existsSync(configFile) ? readFileSync(configFile, "utf8") : "";
  const block = findHostBlock(existing, alias);
  const mismatches = block ? blockMismatches(block, host, paths.privatePath) : [];
  if (block && mismatches.length && !block.managed) {
    report.refuse(7, [`~/.ssh/config already defines Host ${alias} differently (${mismatches.join("; ")}); edit it to:\n${sshConfigBlock(options.name, host, paths.privatePath)}`]);
  }
  if (!block) {
    if (dry) notes.push(`would append Host ${alias} to ~/.ssh/config (${host.hostname}:${host.port} as ${host.user}, IdentitiesOnly)`);
    else {
      const separator = existing && !existing.endsWith("\n\n") ? (existing.endsWith("\n") ? "\n" : "\n\n") : "";
      replaceLocalFile(configFile, `${existing}${separator}${sshConfigBlock(options.name, host, paths.privatePath)}`, 0o600);
      notes.push(`added Host ${alias} to ~/.ssh/config (${host.hostname}:${host.port})`);
    }
  } else if (mismatches.length) {
    if (dry) notes.push(`would update the managed Host ${alias} block (${mismatches.join("; ")})`);
    else {
      const lines = existing.split("\n");
      lines.splice(block.start - 1, block.end - block.start + 1, ...sshConfigBlock(options.name, host, paths.privatePath).split("\n"));
      replaceLocalFile(configFile, lines.join("\n"), 0o600);
      notes.push(`updated the managed Host ${alias} block (${mismatches.join("; ")})`);
    }
  } else notes.push(`~/.ssh/config Host ${alias} matches`);

  notes.push(await pinHostKey(host, info.hostKey, dry, report, hostKeyPlanned));

  if (dry) {
    report.step(7, "would", notes.join("\n"));
    return;
  }
  const { state: forced, stderr } = await probeForcedCommand(alias);
  if (forced === "bypassed") {
    report.step(7, "REFUSED", `${notes.join("\n")}\n${tailscaleRemedy(alias)}`);
    throw new WorkerSetupError("The dedicated alias does not enforce its forced command");
  }
  if (forced === "unclear") {
    report.step(7, "REFUSED", `${notes.join("\n")}\nssh ${alias} whoami returned no worker frame${stderr ? ` (${stderr})` : ""}; check that the alias reaches the worker's OpenSSH and trusts its host key`);
    throw new WorkerSetupError("Could not verify forced-command enforcement");
  }
  report.step(7, "ok", `${notes.join("\n")}\nforced command enforced: ssh ${alias} whoami returned a worker protocol frame`);
}

/** Add `[host]:port key` to known_hosts only if absent; a different recorded key is never replaced. */
async function pinHostKey(host: ResolvedHost, hostKey: string | null, dry: boolean, report: Reporter, hostKeyPlanned: boolean): Promise<string> {
  const name = knownHostsName(host.hostname, host.port);
  const file = join(headHome(), ".ssh", "known_hosts");
  const known = existsSync(file) ? await localCommand(["ssh-keygen", "-F", name, "-f", file]) : { code: 1, stdout: "", stderr: "" };
  if (known.code === 0) {
    if (hostKey && !known.stdout.includes(hostKey.split(" ")[1]!)) {
      report.refuse(7, [`known_hosts already records a different host key for ${name}; verify the worker and remove the stale entry yourself`]);
    }
    return `known_hosts already has ${name}`;
  }
  if (!hostKey && dry && hostKeyPlanned) return `would pin the host key of the worker's own sshd for ${name} once it exists`;
  if (!hostKey) {
    report.refuse(7, [`the worker's /etc/ssh/ssh_host_ed25519_key.pub is not readable over the setup connection and ${name} is not in known_hosts; add its host key yourself (verify the fingerprint out of band), then re-run`]);
  }
  if (dry) return `would pin the worker's ed25519 host key for ${name}`;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  replaceLocalFile(file, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${name} ${hostKey}\n`, 0o600);
  return `pinned the worker's ed25519 host key for ${name} (from the setup connection)`;
}

export async function probeForcedCommand(alias: string): Promise<{ state: ForcedCommand; stderr: string }> {
  const result = await localCommand(["ssh", "-T", "-a", "-x", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
    "-o", "ClearAllForwardings=yes", "-o", "PermitLocalCommand=no", "-o", "ControlPath=none", "-o", "SendEnv=-*", "-o", "ConnectTimeout=8",
    "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2", "--", alias, "whoami"], 60_000);
  return { state: classifyForcedCommand(result.stdout), stderr: tail(result.stderr) };
}

// ---------------------------------------------------------------------- doctor

export type CheckStatus = "ok" | "warn" | "fail";
export interface DoctorRow { check: string; status: CheckStatus; detail: string }
export interface DoctorResult { name: string; ok: boolean; rows: DoctorRow[] }

function activeSuperkit(): string | null {
  const root = process.env[MANAGED_ULW_FIXTURE_ROOT_ENV];
  try { return activeManagedUlwRevision(root ? { root } : {}).revision; } catch { return null; }
}

function dedicatedAlias(name: string, destination: string): boolean {
  const file = join(headHome(), ".ssh", "config");
  const block = existsSync(file) ? findHostBlock(readFileSync(file, "utf8"), destination) : null;
  return !!block && basename(block.settings.get("identityfile") ?? "") === `omp-sa-${name}_ed25519`;
}

export async function runDoctor(config: Config, name: string, io: SetupIo = defaultIo,
  recorded: { memory?: MemoryOutcome } = {}): Promise<DoctorResult> {
  const rows: DoctorRow[] = [];
  const row = (check: string, status: CheckStatus, detail: string) => rows.push({ check, status, detail });
  const done = () => ({ name, ok: !rows.some(entry => entry.status === "fail"), rows });
  const entry = config.workers && Object.hasOwn(config.workers, name) ? config.workers[name] : undefined;
  if (!entry) {
    row("configured", "fail", `no workers.${name} in ${config.path}; run worker add first`);
    return done();
  }
  row("configured", "ok", `${entry.destination}, workerId ${entry.workerId}, superkit ${entry.superkit}`);
  const instance = (await headInstance(config.stateDir, false)).instance;
  if (!instance) {
    row("HEAD instance", "fail", "none recorded yet; run worker add");
    return done();
  }
  row("HEAD instance", "ok", instance);
  let capability: WorkerCapability;
  try {
    // Imported here only: the Host client pulls in the OMP SDK, which `worker add`/`list` must not load.
    const { remoteCapability } = await import("./remote-worker");
    capability = await remoteCapability(placement(config, name)!, instance);
  } catch (error) {
    row("worker", "fail", `capability check through ${entry.destination} failed: ${error instanceof Error ? error.message : String(error)}`);
    return done();
  }
  row("worker", "ok", `identity and HEAD instance match; ${capability.platform}; boot ${capability.bootId.slice(0, 12)}`);
  try {
    requireCompatibleWorker(capability);
    row("compatible", "ok", `package ${capability.package.version} (${capability.package.digest.slice(0, 12)}), OMP ${capability.omp}, clock skew ${Math.abs(capability.clock - Date.now())} ms`);
  } catch (error) {
    row("compatible", "fail", error instanceof Error ? error.message : String(error));
  }
  rows.push(...platformPolicy({ system: capability.platform, direct: false })?.doctor?.(capability) ?? []);
  if (entry.superkit === "none") row("superkit", "ok", "none (explicit plain worker)");
  else {
    const revision = activeSuperkit();
    if (!revision) row("superkit", "warn", "HEAD has no active omp-superkit revision to pin yet");
    else if (capability.superkit === revision) row("superkit", "ok", `pinned revision ${revision.slice(0, 12)} installed`);
    else row("superkit", "warn", `worker has ${capability.superkit?.slice(0, 12) ?? "none"}; HEAD would provision ${revision.slice(0, 12)} at the next launch`);
  }
  row("models", capability.models.length ? "ok" : "fail", capability.models.length
    ? `${capability.models.length} chat models from the worker's own OMP and auth` : "the worker's OMP lists no chat models");
  row("roots", "ok", capability.roots.join(", "));
  const memory = await measureMemory(config, name, entry, capability, io, recorded.memory ?? null);
  row("memory", memory.status, memory.detail);
  const managed = dedicatedAlias(name, entry.destination);
  const { state: forced, stderr } = await probeForcedCommand(entry.destination);
  if (forced === "enforced") row("forced command", "ok", `ssh ${entry.destination} whoami returns a worker protocol frame`);
  else if (forced === "bypassed") row("forced command", managed ? "fail" : "warn", managed ? tailscaleRemedy(entry.destination) : unenforcedWarning(entry.destination));
  else row("forced command", managed ? "fail" : "warn", `ssh ${entry.destination} whoami returned no worker frame${stderr ? ` (${stderr})` : ""}`);
  const result = done();
  saveFacts(config, name, result.ok, capability, memory.backend);
  return result;
}

interface MemoryFacts { status: CheckStatus; detail: string; backend: string | null }

/** A forced command cannot run the check but an ordinary alias can; otherwise report what `add` or the last doctor recorded. */
async function measureMemory(config: Config, name: string, entry: WorkerConfig, capability: WorkerCapability, io: SetupIo,
  recorded: MemoryOutcome): Promise<MemoryFacts> {
  const nonce = newNonce();
  const result = await io.remote(entry.destination, "sh -s", memoryScript({
    nonce, release: "current", cwd: capability.roots[0]!, consent: null, agentDir: null,
  }), 150_000).catch(() => null);
  const live = result && result.code === 0 ? parseMemoryHelperOutput(parseFacts(result.stdout, nonce).memory ?? "").memory : null;
  if (live && live.status !== "unknown") {
    return live.status === "enabled" ? { status: "ok", detail: `${live.backend} (${live.source} settings)`, backend: live.backend }
      : { status: "fail", detail: memoryBlockReason(live), backend: null };
  }
  const known = recorded ?? readRecordedMemory(config, name);
  if (known) return { status: "ok", detail: `${known.backend} (recorded earlier; not re-measured through the forced command)`, backend: known.backend };
  return { status: "warn", detail: "unknown: not measurable through the forced command; run worker add again to check and record it", backend: null };
}

function readRecordedMemory(config: Config, name: string): MemoryOutcome {
  try {
    const saved = JSON.parse(readMeta(config.stateDir, `worker-facts:${name}`) ?? "null") as { memory?: string | null } | null;
    return saved?.memory ? { backend: saved.memory, updated: false } : null;
  } catch { return null; }
}

function saveFacts(config: Config, name: string, ok: boolean, capability: WorkerCapability, memory: string | null): void {
  try {
    writeMeta(config.stateDir, `worker-facts:${name}`, JSON.stringify({
      at: new Date().toISOString(), ok, package: capability.package.version, omp: capability.omp,
      models: capability.models.length, superkit: capability.superkit, memory,
    }));
  } catch { /* Facts are advisory. */ }
}

export function renderDoctor(result: DoctorResult): string {
  const width = Math.max(...result.rows.map(entry => entry.check.length));
  return [`worker doctor ${result.name}: ${result.ok ? "ok" : "FAILED"}`,
    ...result.rows.map(entry => `  ${entry.check.padEnd(width)}  ${entry.status.toUpperCase().padEnd(4)}  ${entry.detail.split("\n").join(`\n${" ".repeat(width + 10)}`)}`)].join("\n");
}

// ------------------------------------------------------------------------ list

export function listWorkers(config: Config): string {
  const entries = Object.entries(config.workers ?? {});
  if (!entries.length) return "No workers configured.";
  return entries.map(([name, worker]) => {
    let facts = "no doctor facts yet";
    try {
      const saved = JSON.parse(readMeta(config.stateDir, `worker-facts:${name}`) ?? "null") as { at: string; ok: boolean; package: string; omp: string; models: number } | null;
      if (saved) facts = `last doctor ${saved.at} ${saved.ok ? "ok" : "FAILED"}: package ${saved.package}, OMP ${saved.omp}, ${saved.models} models`;
    } catch { /* Unreadable facts are shown as absent. */ }
    return `${name}  ${worker.destination}  ${worker.workerId}  superkit=${worker.superkit}  ${facts}`;
  }).join("\n");
}

// ------------------------------------------------------------------ entry point

export async function runWorkerCommand(args: readonly string[], io: SetupIo = defaultIo): Promise<void> {
  const command = parseWorkerArgs(args);
  if (command.kind === "list") {
    io.log(listWorkers(await loadConfig(command.configPath)));
  } else if (command.kind === "doctor") {
    const result = await runDoctor(await loadConfig(command.configPath), command.name, io);
    io.log(renderDoctor(result));
    if (!result.ok) process.exitCode = 1;
  } else {
    const result = await workerAdd(command, io);
    if (result.doctor && !result.doctor.ok) process.exitCode = 1;
  }
}
