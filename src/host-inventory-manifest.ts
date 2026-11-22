import { dirname, isAbsolute, join } from "node:path";
import { getDaemonDir, getDaemonRuntimeDir } from "@oh-my-pi/pi-utils/dirs";

/** Resolve read-only inventory metadata under the SDK helper's bootstrapped profile and environment. */
export async function hostInventoryManifest(processBackend: "daemon" | "broker", cwd = process.cwd()) {
  try {
    switch (processBackend) {
      case "broker": {
        // Fresh SDK processes can select a different state root after an XDG migration.
        if (process.env.XDG_STATE_HOME) return undefined;
        const projectRoot = dirname(getDaemonRuntimeDir(cwd));
        const globalRoot = join(dirname(getDaemonDir()), "daemons", "global");
        return isAbsolute(projectRoot) && isAbsolute(globalRoot)
          ? { backend: "broker", projectRoot, globalRoot } as const : undefined;
      }
      case "daemon": {
        const { daemonEndpoint, daemonDbPath, daemonLockPath, daemonTcpAddress, daemonTokenPath } =
          await import("@oh-my-pi/pi-coding-agent/daemon/paths");
        const { DAEMON_DIR_ENV, DAEMON_PROTOCOL_VERSION } = await import("@oh-my-pi/pi-coding-agent/daemon/protocol");
        if (process.env.XDG_STATE_HOME && !process.env[DAEMON_DIR_ENV]) return undefined;
        if (daemonTcpAddress()) return undefined;
        const endpoint = daemonEndpoint();
        const tokenPath = daemonTokenPath();
        const lockPath = daemonLockPath();
        const dbPath = daemonDbPath();
        const uid = process.geteuid?.();
        if (uid === undefined || ![endpoint, tokenPath, lockPath, dbPath].every(isAbsolute)) return undefined;
        const { daemonBuildId } = await import("@oh-my-pi/pi-coding-agent/daemon/build");
        const { resolveCliEntryCmd } = await import("@oh-my-pi/pi-coding-agent/subprocess/worker-client");
        return { backend: "daemon", endpoint, tokenPath, lockPath, dbPath, uid,
          version: DAEMON_PROTOCOL_VERSION, clientBuild: daemonBuildId(), clientExe: resolveCliEntryCmd() } as const;
      }
    }
  } catch (error) {
    // Optional metadata must not make preparation stricter. Inventory still runs through the SDK.
    if (error instanceof Error) return undefined;
    throw error;
  }
}
