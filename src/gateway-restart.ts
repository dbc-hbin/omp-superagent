#!/usr/bin/env -S bun --no-env-file
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { hostPaths, loadConfig, requireMessengerCredentials, type Config } from "./config";
import { loadCredentials } from "./credentials";
import type { GatewayRestartRecord } from "./contracts";
import { GatewayStore } from "./gateway-store";
import type { GatewayStatus } from "./gateway-server";
import { gatewayPaths } from "./gateway-protocol";

export interface RestartPlan {
  configPath: string;
  stateDir: string;
  configHash: string;
  socket: { pid: number; dev: number; ino: number };
  head: { pid: number; sessionId: string; sessionFile: string; dev: number; ino: number };
  runnerPid?: number;
  runnerReady?: boolean;
  launchPid?: number;
}
interface Metadata { getMeta(key: string): string | null }
export function readRestartPlan(store: Metadata, requestId: string): RestartPlan | null {
  return JSON.parse(store.getMeta(`gateway:restart-plan:${requestId}`) ?? "null") as RestartPlan | null;
}
export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
}
export async function restartConfigHash(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

/** Durable identity, not a caller-supplied PID, grants permission to resume this exact session. */
export async function validateRestartPlan(config: Config, record: GatewayRestartRecord | null, plan: RestartPlan | null): Promise<void> {
  if (!record || !plan || resolve(plan.configPath) !== resolve(config.path) || resolve(plan.stateDir) !== resolve(config.stateDir) ||
      record.gatewayPid !== plan.socket.pid || record.headPid !== plan.head.pid ||
      record.sessionId !== plan.head.sessionId || resolve(record.sessionFile) !== resolve(plan.head.sessionFile) ||
      resolve(record.sessionFile) !== resolve(hostPaths(config, "main").sessionFile))
    throw new Error("Restart durable ownership does not match the original configuration and session");
  if (await restartConfigHash(config.path) !== plan.configHash)
    throw new Error("Restart configuration changed; no replacement is authorized");
  // Static native imports run OMP's dotenv loader before the explicit credential boundary.
  const { readSessionHeaderId } = await import("@oh-my-pi/pi-coding-agent/session/session-loader");
  if (await readSessionHeaderId(record.sessionFile) !== record.sessionId)
    throw new Error("Restart session identity changed; no replacement is authorized");
}

/** Write even when the predecessor still owns its lifetime lock; never overwrite cancellation/success. */
function recordFailure(db: Database, requestId: string, reason: string): void {
  db.transaction(() => {
    const row = db.query("SELECT value FROM metadata WHERE key=?").get(`gateway:restart:${requestId}`) as { value: string } | null;
    if (!row) return;
    const record = JSON.parse(row.value) as GatewayRestartRecord;
    if ((record.state !== "accepted" && record.state !== "head-stopped") || readRestartPlan({
      getMeta: key => (db.query("SELECT value FROM metadata WHERE key=?").get(key) as { value: string } | null)?.value ?? null,
    }, requestId)?.runnerPid !== process.pid) return;
    const failed = JSON.stringify({ ...record, state: "failed", reason });
    db.query("UPDATE metadata SET value=? WHERE key=?").run(failed, `gateway:restart:${requestId}`);
    const latest = db.query("SELECT value FROM metadata WHERE key='gateway:restart'").get() as { value: string } | null;
    if (latest && (JSON.parse(latest.value) as GatewayRestartRecord).requestId === requestId)
      db.query("UPDATE metadata SET value=? WHERE key='gateway:restart'").run(failed);
  }).immediate();
}

/** Bounded detached handoff, never a supervisor: wait, launch once through the normal loader, exit. */
export async function runGatewayRestart(configPath: string, requestId: string, options: {
  timeoutMs?: number;
  /** Original owned directory lets failure receipts survive a removed/changed config file. */
  stateDir?: string;
  /** Real subprocess fixture seam; never persisted or selected by production flags/configuration. */
  launch?: (config: Config, requestId: string) => Promise<GatewayStatus>;
} = {}): Promise<void> {
  const stateDir = options.stateDir ?? (await loadConfig(configPath)).stateDir;
  const db = new Database(join(stateDir, "coordination.sqlite"), { create: false, strict: true });
  db.run("PRAGMA busy_timeout=5000");
  const metadata: Metadata = {
    getMeta: key => (db.query("SELECT value FROM metadata WHERE key=?").get(key) as { value: string } | null)?.value ?? null,
  };
  let lock: GatewayStore | undefined;
  try {
    const config = await loadConfig(configPath);
    if (resolve(config.stateDir) !== resolve(stateDir)) throw new Error("Restart state directory changed");
    // Resolve credentials before any native module may run its own dotenv loader.
    loadCredentials(config);
    requireMessengerCredentials(config);
    const deadline = Date.now() + (options.timeoutMs ?? 90_000);
    let record: GatewayRestartRecord | null;
    let plan: RestartPlan | null;
    for (;;) {
      record = JSON.parse(metadata.getMeta(`gateway:restart:${requestId}`) ?? "null") as GatewayRestartRecord | null;
      plan = readRestartPlan(metadata, requestId);
      await validateRestartPlan(config, record, plan);
      if (!record || !plan || (record.state !== "accepted" && record.state !== "head-stopped")) return;
      if (metadata.getMeta("gateway:restart-active") !== requestId) throw new Error("Restart is not the active owned intent");
      if (plan.runnerPid !== undefined && plan.runnerPid !== process.pid)
        throw new Error("Restart runner identity changed");
      if (plan.runnerPid === process.pid && !plan.runnerReady) {
        const socket = await lstat(gatewayPaths(config).socketPath);
        if (!socket.isSocket() || socket.uid !== process.getuid?.() || socket.dev !== plan.socket.dev || socket.ino !== plan.socket.ino)
          throw new Error("Predecessor Gateway endpoint changed before successor preparation");
        db.transaction(() => {
          const current = JSON.parse(metadata.getMeta(`gateway:restart:${requestId}`) ?? "null") as GatewayRestartRecord | null;
          const owned = readRestartPlan(metadata, requestId);
          if (!current || (current.state !== "accepted" && current.state !== "head-stopped") || !owned || owned.runnerPid !== process.pid)
            throw new Error("Successor preparation lost request ownership");
          db.query("UPDATE metadata SET value=? WHERE key=?").run(JSON.stringify({ ...owned, runnerReady: true }), `gateway:restart-plan:${requestId}`);
        }).immediate();
      }
      if (record.state === "head-stopped" && processAlive(record.headPid)) throw new Error("Predecessor HEAD shutdown is not confirmed");
      if (record.state === "head-stopped" && plan.runnerPid === process.pid && !processAlive(record.gatewayPid)) {
        try { lock = new GatewayStore(config.stateDir); }
        catch { /* A released process identity is not yet a released lifetime lock. */ }
        if (lock) break;
      }
      if (Date.now() >= deadline) throw new Error("Predecessor did not exit and release its lifetime lock");
      await Bun.sleep(25);
    }
    // The lock serializes final cancellation/identity checks with every normal start.
    const current = lock.getRestart(requestId);
    const currentPlan = readRestartPlan(lock, requestId);
    await validateRestartPlan(config, current, currentPlan);
    if (!current || !currentPlan || current.state !== "head-stopped" || currentPlan.runnerPid !== process.pid ||
        lock.getMeta("gateway:restart-active") !== requestId || currentPlan.launchPid ||
        processAlive(current.gatewayPid) || processAlive(current.headPid)) return;
    const socket = JSON.parse(lock.getMeta("gateway:socket") ?? "null") as RestartPlan["socket"] | null;
    if (!socket || socket.pid !== currentPlan.socket.pid || socket.dev !== currentPlan.socket.dev || socket.ino !== currentPlan.socket.ino ||
        lock.getMeta("gateway:head") !== "null") throw new Error("Predecessor endpoint ownership changed");
    lock.close();
    lock = undefined;
    // This import must stay after credential resolution; Gateway imports native OMP modules.
    const { launchGateway } = await import("./gateway");
    const status = await (options.launch ?? launchGateway)(config, requestId);
    const result = JSON.parse(metadata.getMeta(`gateway:restart:${requestId}`) ?? "null") as GatewayRestartRecord | null;
    if (!result || result.state !== "started" || result.successorPid !== status.gateway.pid ||
        result.replacementPid !== status.head.pid || status.gateway.pid === result.gatewayPid || status.head.pid === result.headPid)
      throw new Error("Replacement ownership/readiness was not confirmed");
  } catch {
    recordFailure(db, requestId, "One-shot restart handoff failed or timed out; no retry or forced kill was attempted. Inspect the exact durable request before recovery.");
  } finally { lock?.close(); db.close(); }
}

if (import.meta.main) {
  const at = (name: string) => process.argv[process.argv.indexOf(name) + 1];
  const config = at("--config"), request = at("--request");
  if (!config || !request) process.exitCode = 1;
  else await runGatewayRestart(config, request, { stateDir: at("--state-dir") }).catch(() => { process.exitCode = 1; });
}
