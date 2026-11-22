import { loadWorkerProvision } from "./remote-worker-provision";
import { grantInstruction, installWorkerLauncher, launcherPath, macosWorkerStatus, protectedPaths, readGrants, setupScript, supportDirectory, workerPayload, writeGrants, writePayloadPointer, type MacosWorkerScope, type WorkerGrants } from "./worker-macos";
import { requireUserContext, runInUserContext } from "./worker-user-context";

/** Listed only with Full Disk Access; denied silently (no prompt) without it. */
const FULL_DISK_ACCESS_PROBE = "/Library/Application Support/com.apple.TCC";
/** Time the owner has to answer one privacy prompt at the screen. */
const PROMPT_TIMEOUT_MS = 120_000;

export interface MacosSetupReport {
  /** This release's setup script: what the owner runs at the Mac. */
  readonly setup: string;
  readonly launcher: { path: string; identifier: string; cdhash: string; installed: boolean };
  readonly fullDiskAccess: boolean;
  readonly granted: readonly string[];
  /** Protected paths the launcher still cannot read, each with the exact toggle to enable. */
  readonly pending: readonly { path: string; category: string; instruction: string }[];
}

async function probe(launcher: string, stateDir: string, path: string): Promise<boolean> {
  // The probe runs in the gui domain, so a privacy prompt appears on the Mac's own screen even when setup is driven over SSH.
  const { code } = await runInUserContext([launcher, "--probe", path], { timeoutMs: PROMPT_TIMEOUT_MS, stateDir, purpose: "grant-probe" });
  return code === 0;
}

/**
 * The one-time macOS setup, run at the Mac (or over SSH with the owner at the screen): installs the fixed
 * launcher if absent (never replaces it), lets the launcher itself list each privacy-protected path of the
 * worker scope (raising each prompt once, attributed to the launcher), and records what it could read in
 * the private grants file. Later lanes, reboots and upgrades neither prompt nor change that identity.
 */
export async function setupMacosWorker(scope: MacosWorkerScope & { stateDir: string }, support = supportDirectory()): Promise<MacosSetupReport> {
  requireUserContext("darwin");
  const launcher = installWorkerLauncher(support);
  const path = launcherPath(support);
  const folders = new Set<string>();
  const pending: { path: string; category: string; instruction: string }[] = [];
  const fullDiskAccess = await probe(path, scope.stateDir, FULL_DISK_ACCESS_PROBE);
  for (const item of protectedPaths(scope)) {
    if (fullDiskAccess || await probe(path, scope.stateDir, item.path)) folders.add(item.category);
    else {
      pending.push({ ...item, instruction: grantInstruction(path, setupScript(), [item]) });
    }
  }
  const grants: WorkerGrants = {
    version: 1, launcher: { identifier: launcher.identifier, cdhash: launcher.cdhash }, fullDiskAccess,
    folders: [...folders].sort(), recordedAt: new Date().toISOString(),
  };
  writeGrants(support, grants);
  return { setup: setupScript(), launcher: { path, ...launcher }, fullDiskAccess, granted: grants.folders, pending };
}

/**
 * The non-interactive part of the setup, safe over any SSH login: installs the fixed launcher if absent (never
 * replaces it), points it at this release, and keeps the grants already recorded for the same launcher (a new
 * launcher starts with none). It never lists a protected folder, so it raises no privacy prompt; what the owner
 * still has to do at the Mac is returned as `pending`.
 */
export function prepareMacosWorker(scope: MacosWorkerScope, support = supportDirectory()): MacosSetupReport & { pointerChanged: boolean } {
  const launcher = installWorkerLauncher(support);
  const path = launcherPath(support);
  const pointerChanged = writePayloadPointer(support, workerPayload());
  let grants = readGrants(support);
  if (grants?.launcher.cdhash !== launcher.cdhash) {
    grants = { version: 1, launcher: { identifier: launcher.identifier, cdhash: launcher.cdhash }, fullDiskAccess: false, folders: [], recordedAt: new Date().toISOString() };
    writeGrants(support, grants);
  }
  const pending = macosWorkerStatus(scope, support).missing.map(item => ({ ...item, instruction: grantInstruction(path, setupScript(), [item]) }));
  return { setup: setupScript(), launcher: { path, ...launcher }, fullDiskAccess: grants.fullDiskAccess, granted: grants.folders, pending, pointerChanged };
}

/** `--prepare '<{"stateDir","workspaceRoots"}>'`: what `omp-sa worker add` runs over SSH, one JSON line out, no prompt. */
function preparedScope(argument: string): MacosWorkerScope {
  const value = JSON.parse(argument) as Partial<MacosWorkerScope>;
  if (typeof value.stateDir !== "string" || !Array.isArray(value.workspaceRoots) || !value.workspaceRoots.every(root => typeof root === "string")) {
    throw new Error("--prepare needs a JSON scope with stateDir and workspaceRoots");
  }
  return { stateDir: value.stateDir, workspaceRoots: value.workspaceRoots };
}

if (import.meta.main) {
  try {
    if (process.argv[2] === "--prepare") {
      console.log(JSON.stringify(prepareMacosWorker(preparedScope(process.argv[3] ?? ""))));
    } else {
      const { stateDir, workspaceRoots } = loadWorkerProvision();
      const report = await setupMacosWorker({ stateDir, workspaceRoots });
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = report.pending.length ? 1 : 0;
    }
  } catch (error) {
    console.error("macOS worker setup failed:", error instanceof Error ? error.message : "unknown error");
    process.exitCode = 1;
  }
}
