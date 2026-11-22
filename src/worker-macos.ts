import { accessSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { RemoteWorkerError, type WorkerCapability } from "./remote-worker-wire";
import { userSshdFacts } from "./worker-user-sshd";

/**
 * macOS worker support files, shared by the endpoint (preflight, payload
 * pointer), the one-time setup and future onboarding.
 *
 *   <home>/Library/Application Support/omp-superagent-worker/   0700
 *     bin/omp-sa-worker-launcher   the ONE fixed, ad-hoc signed LaunchAgent executable; installed once, never replaced
 *     payload                      0600 pointer: the launcher's payload argv (bun + versioned release), one entry per line
 *     grants.json                  0600 record of the one-time privacy grants, written by setup
 *     boots.json                   0600 the boot the worker was first seen on and later boots its login agents came back on
 */
export const LAUNCHER_IDENTIFIER = "com.omp-superagent.worker-launcher";
const SUPPORT_NAME = "omp-superagent-worker";
const MAX_POINTER = 16 * 1024;
const MAX_PAYLOAD = 32;

export const launcherSource = fileURLToPath(new URL("../worker-launcher/omp-sa-worker-launcher.c", import.meta.url));

export const supportDirectory = (home = homedir()) => join(home, "Library", "Application Support", SUPPORT_NAME);
export const launcherPath = (support = supportDirectory()) => join(support, "bin", "omp-sa-worker-launcher");
export const payloadPointerPath = (support = supportDirectory()) => join(support, "payload");
export const grantsPath = (support = supportDirectory()) => join(support, "grants.json");
export const bootsPath = (support = supportDirectory()) => join(support, "boots.json");

/** The launcher's pointer grammar: non-empty single-line entries, the first absolute, bounded. */
export function parsePayloadPointer(text: string): string[] {
  if (Buffer.byteLength(text) > MAX_POINTER) throw new RemoteWorkerError("Worker payload pointer exceeds its size limit");
  const entries = (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
  if (entries.length > MAX_PAYLOAD || entries.some(entry => entry === "" || entry.includes("\0"))) {
    throw new RemoteWorkerError("Worker payload pointer has an empty, binary or excessive entry");
  }
  if (!entries[0]!.startsWith("/")) throw new RemoteWorkerError("Worker payload must start with an absolute executable path");
  return entries;
}

export function serializePayloadPointer(argv: readonly string[]): string {
  if (argv.some(entry => entry.includes("\n"))) throw new RemoteWorkerError("Worker payload entries must be single lines");
  const text = `${argv.join("\n")}\n`;
  parsePayloadPointer(text);
  return text;
}

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    throw new RemoteWorkerError(`${path} must be a directory owned by the worker account with mode 0700`);
  }
}

/** Atomic private write (temp file + rename, mode 0600). */
function writePrivateFile(path: string, text: string): void {
  const temporary = `${path}.${process.pid}.tmp`;
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeSync(fd, text); } finally { closeSync(fd); }
  renameSync(temporary, path);
}

/** What the launcher runs: the installed bun and this release's worker server. */
export const workerPayload = (): string[] => [process.execPath, "--no-env-file", fileURLToPath(new URL("./remote-worker-server.ts", import.meta.url))];

/** This release's one-time setup script (`bun --no-env-file <it>` at the Mac records the owner's privacy grants). */
export const setupScript = (): string => fileURLToPath(new URL("./worker-macos-setup.ts", import.meta.url));

/** Points the fixed launcher at `argv`. Only an upgrade changes it; returns whether the pointer changed. */
export function writePayloadPointer(support: string, argv: readonly string[]): boolean {
  const text = serializePayloadPointer(argv);
  privateDirectory(support);
  const path = payloadPointerPath(support);
  try { if (readFileSync(path, "utf8") === text) return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  writePrivateFile(path, text);
  return true;
}

/** `identifier` and `cdhash` from `codesign -dvvv`: the identity privacy grants and keychain ACLs are bound to. */
export function codesignIdentity(executable: string): { identifier: string; cdhash: string } {
  const child = Bun.spawnSync(["codesign", "-dvvv", executable], { stdin: "ignore", stdout: "ignore", stderr: "pipe", timeout: 20_000 });
  const output = child.stderr.toString("utf8");
  const identifier = /^Identifier=(.+)$/m.exec(output)?.[1];
  const cdhash = /^CDHash=([0-9a-f]+)$/m.exec(output)?.[1];
  if (child.exitCode !== 0 || !identifier || !cdhash) throw new RemoteWorkerError(`Worker launcher at ${executable} is not signed`);
  return { identifier, cdhash };
}

/** Compiles and ad-hoc signs the launcher to `destination`. */
export function buildWorkerLauncher(destination: string, source = launcherSource): void {
  if (process.platform !== "darwin") throw new RemoteWorkerError("The worker launcher is macOS only");
  for (const command of [
    ["cc", "-O2", "-Wall", "-Werror", "-o", destination, source],
    ["codesign", "--force", "--sign", "-", "--identifier", LAUNCHER_IDENTIFIER, destination],
  ]) {
    const child = Bun.spawnSync(command, { stdin: "ignore", stdout: "ignore", stderr: "pipe", timeout: 120_000 });
    if (child.exitCode !== 0) {
      throw new RemoteWorkerError(`${command[0]} failed building the worker launcher: ${child.stderr.toString("utf8").slice(0, 400)}`);
    }
  }
}

/**
 * Installs the launcher once. An installed launcher is NEVER replaced: its code
 * identity carries the owner's grants, and a rebuilt binary has a new cdhash.
 */
export function installWorkerLauncher(support: string): { identifier: string; cdhash: string; installed: boolean } {
  privateDirectory(support);
  privateDirectory(join(support, "bin"));
  const path = launcherPath(support);
  if (existsSync(path)) return { ...codesignIdentity(path), installed: false };
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    buildWorkerLauncher(temporary);
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
  return { ...codesignIdentity(path), installed: true };
}

/** What the owner granted to the launcher, as proven by setup's own probes. */
export interface WorkerGrants {
  readonly version: 1;
  readonly launcher: { identifier: string; cdhash: string };
  readonly fullDiskAccess: boolean;
  /** Privacy categories (see tccCategory) a probe through the launcher could read. */
  readonly folders: readonly string[];
  readonly recordedAt: string;
}

export function readGrants(support = supportDirectory()): WorkerGrants | null {
  let text: string;
  try { text = readFileSync(grantsPath(support), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  const grants = JSON.parse(text) as WorkerGrants;
  if (grants.version !== 1 || typeof grants.launcher?.cdhash !== "string" || !Array.isArray(grants.folders)) {
    throw new RemoteWorkerError("Worker grants record is malformed; rerun the macOS worker setup");
  }
  return grants;
}

export function writeGrants(support: string, grants: WorkerGrants): void {
  privateDirectory(support);
  writePrivateFile(grantsPath(support), `${JSON.stringify(grants, null, 2)}\n`);
}

/**
 * The privacy-protected folder class a canonical path lives in (these raise a
 * Files and Folders prompt for the first process that lists them), or null.
 * A boot-volume path is never under /Volumes once canonical.
 */
export function tccCategory(canonical: string, home = homedir()): string | null {
  const under = (root: string) => canonical === root || canonical.startsWith(root + sep);
  if (under(join(home, "Desktop"))) return "desktop";
  if (under(join(home, "Documents"))) return "documents";
  if (under(join(home, "Downloads"))) return "downloads";
  if (under(join(home, "Library", "Mobile Documents"))) return "icloud-drive";
  if (under(join(home, "Library", "CloudStorage"))) return "cloud-storage";
  if (under("/Volumes")) return "removable-or-network";
  return null;
}

export interface MacosWorkerScope { readonly stateDir: string; readonly workspaceRoots: readonly string[] }

/** Protected paths of a worker scope with the category each needs. */
export function protectedPaths(scope: MacosWorkerScope, home = homedir()): { path: string; category: string }[] {
  return [scope.stateDir, ...scope.workspaceRoots].flatMap(path => {
    const category = tccCategory(path, home);
    return category ? [{ path, category }] : [];
  });
}

/** The exact one-time owner step that lets the fixed launcher read a protected path; it never raises a prompt by itself. */
export function grantInstruction(launcher: string, setup: string, items: readonly { path: string; category: string }[]): string {
  return `at the Mac, run: bun --no-env-file ${setup} (one privacy prompt per protected folder, attributed to "omp-sa-worker-launcher": click Allow). `
    + `If it was denied before, enable "omp-sa-worker-launcher" in System Settings > Privacy & Security > Files & Folders (or add ${launcher} to Full Disk Access), `
    + `then run it again to record the grant for ${items.map(item => `${item.path} (${item.category})`).join(", ")}`;
}

export interface MacosWorkerStatus {
  readonly launcher: { path: string; identifier: string; cdhash: string } | null;
  readonly grants: WorkerGrants | null;
  /** The launcher on disk is not the binary the grants were recorded for. */
  readonly launcherChanged: boolean;
  /** Protected paths of the scope that no recorded grant covers. */
  readonly missing: { path: string; category: string }[];
}

/** Non-prompting readiness of a worker scope: reads only the support files and the launcher's signature. */
export function macosWorkerStatus(scope: MacosWorkerScope, support = supportDirectory()): MacosWorkerStatus {
  const path = launcherPath(support);
  let launcher: MacosWorkerStatus["launcher"] = null;
  try {
    accessSync(path, constants.X_OK);
    launcher = { path, ...codesignIdentity(path) };
  } catch (error) { if (existsSync(path)) throw error; }
  const grants = readGrants(support);
  return {
    launcher, grants, launcherChanged: !!launcher && !!grants && launcher.cdhash !== grants.launcher.cdhash,
    missing: protectedPaths(scope).filter(item => !grants?.fullDiskAccess && !grants?.folders.includes(item.category)),
  };
}

/**
 * Records this boot for the reboot check: the first boot a capability ran on,
 * and every later boot on which the login brought the worker's launchd agents
 * back by itself. A capability runs in the GUI login session, so reaching this
 * code after a reboot proves the login happened; with an own sshd, it must
 * also be running and listening again. Returns null before the launcher exists.
 */
export function recordBoot(support: string, boot: string, agentsBack: boolean): { first: string; verified: string | null } | null {
  if (!existsSync(launcherPath(support))) return null;
  let record: { first: string; verified: string[] } | null = null;
  try { record = JSON.parse(readFileSync(bootsPath(support), "utf8")) as { first: string; verified: string[] }; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (record && (typeof record.first !== "string" || !Array.isArray(record.verified))) throw new RemoteWorkerError("Worker boots record is malformed; remove it and run worker doctor again");
  const next = record ? { first: record.first, verified: [...record.verified] } : { first: boot, verified: [] };
  if (boot !== next.first && agentsBack && !next.verified.includes(boot)) next.verified = [...next.verified, boot].slice(-8);
  if (!isDeepStrictEqual(next, record)) writePrivateFile(bootsPath(support), `${JSON.stringify(next)}\n`);
  return { first: next.first, verified: next.verified.at(-1) ?? null };
}

/** The launcher readiness a capability reports (doctor shows it); never touches a protected folder. */
export function macosWorkerFacts(scope: MacosWorkerScope, boot: string, support = supportDirectory()): NonNullable<WorkerCapability["macos"]> {
  const status = macosWorkerStatus(scope, support);
  let pointer: "current" | "stale" | "absent" = "absent";
  try { pointer = isDeepStrictEqual(parsePayloadPointer(readFileSync(payloadPointerPath(support), "utf8")), workerPayload()) ? "current" : "stale"; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") pointer = "stale"; }
  const userSshd = userSshdFacts();
  const reboot = recordBoot(support, boot, !userSshd || (userSshd.state === "running" && userSshd.listening.length > 0));
  return {
    launcher: status.launcher && { path: status.launcher.path, cdhash: status.launcher.cdhash },
    launcherChanged: status.launcherChanged, pointer, missing: status.missing, setup: setupScript(),
    ...userSshd && { userSshd }, ...reboot && { reboot },
  };
}

/**
 * Refuses a launch that would block on a privacy dialog or run under a
 * launcher the owner never approved, naming exactly what is missing. Never
 * touches a protected folder itself (listing one would raise the prompt).
 */
export function requireMacosWorkerReady(scope: MacosWorkerScope, support = supportDirectory()): void {
  const status = macosWorkerStatus(scope, support);
  if (!status.launcher) {
    throw new RemoteWorkerError(`macOS worker launcher is not installed at ${launcherPath(support)}; run the one-time macOS worker setup at the Mac`);
  }
  if (status.launcherChanged) {
    throw new RemoteWorkerError(`macOS worker launcher at ${status.launcher.path} changed since its grants were recorded; rerun the one-time macOS worker setup at the Mac`);
  }
  if (status.missing.length) {
    const list = status.missing.map(item => `${item.path} (${item.category})`).join(", ");
    throw new RemoteWorkerError(`macOS has not been told to let the worker launcher read ${list}. Use paths outside Desktop, Documents, Downloads, iCloud, cloud `
      + `and external volumes, or ${grantInstruction(status.launcher.path, setupScript(), status.missing)}`);
  }
}
