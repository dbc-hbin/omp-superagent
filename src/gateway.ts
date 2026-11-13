#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { Database } from "bun:sqlite";
import { constants, existsSync } from "node:fs";
import { lstat, mkdir, open, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { credentialEnvNames, hostPaths, loadConfig, privateDirectory, requireMessengerCredentials, type Config } from "./config";
import type { Messenger } from "./contracts";
import { DeliveryError } from "./delivery";
import { gatewayCall, gatewayPaths } from "./gateway-protocol";
import { GatewayServer, type GatewayStatus } from "./gateway-server";
import { GatewayStore } from "./gateway-store";
import { connect, startHost } from "./host";
import { createMessenger } from "./messengers";
import { activeManagedUlw, managedUlwStatus, readUlwManifest, updateManagedUlw, validateManagedUlwPackage,
  type ManagedUlwStatus } from "./managed-ulw";

export { gatewayPaths } from "./gateway-protocol";
export type { GatewayStatus } from "./gateway-server";
export interface GatewayOptions {
  messenger?: Messenger;
  onError?: (error: unknown) => void;
  extensionPath?: string;
  /** Isolated fixture package injection, never a production disable switch. */
  managedUlwPath?: string;
  /** Controlled source-refresh fixture; production always uses updateManagedUlw. */
  updateManagedUlw?: () => Promise<ManagedUlwStatus>;
}
interface HeadIdentity { pid: number; sessionId: string; sessionFile: string; dev: number; ino: number }
interface SocketIdentity { pid: number; dev: number; ino: number }

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}
async function removeDeadSocket(socketPath: string, identity: SocketIdentity | null): Promise<void> {
  let stat;
  try { stat = await lstat(socketPath); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (!identity || alive(identity.pid) || !stat.isSocket() || stat.uid !== process.getuid?.() ||
      stat.dev !== identity.dev || stat.ino !== identity.ino)
    throw new Error("Existing endpoint ownership is unresolved; no socket was removed or second host started");
  await unlink(socketPath);
}

/** Owns adapters and exactly one native head; never reads or connects lane sockets. */
export class GatewayService {
  private readonly store: GatewayStore;
  private readonly messenger: Messenger;
  private readonly server: GatewayServer;
  private readonly report: (error: unknown) => void;
  private head: HeadIdentity | null;
  private transportsReady = false;
  private stopping = false;
  private closed = false;
  private launching = false;
  private error: string | null = null;
  private supervision?: Promise<void>;
  private monitor?: ReturnType<typeof setInterval>;
  private updateMonitor?: ReturnType<typeof setInterval>;
  private updating?: Promise<void>;
  private ulw: ManagedUlwStatus = { revision: null, packagePath: null, upstreamRevision: null,
    checkedAt: null, error: null, updating: false };
  private closing?: Promise<void>;
  private stopTask?: Promise<void>;
  private readonly signal = () => { void this.stop().catch(this.report); };

  constructor(readonly config: Config, private readonly options: GatewayOptions = {}) {
    this.report = options.onError ?? (() => console.error("Gateway operation failed; inspect private service state"));
    this.store = new GatewayStore(config.stateDir);
    try {
      this.head = JSON.parse(this.store.getMeta("gateway:head") ?? "null") as HeadIdentity | null;
      this.messenger = options.messenger ?? createMessenger(config, this.store, this.report);
      this.server = new GatewayServer({
        socketPath: gatewayPaths(config).socketPath, store: this.store, messenger: this.messenger,
        authorizeHead: pid => this.authorizeHead(pid), status: () => this.status(), onError: this.report,
        stop: async () => {
          await this.stopHead();
          // Allow the CLI to receive the committed shutdown receipt first.
          setTimeout(() => { void this.close().catch(this.report); }, 25);
        },
      });
    } catch (error) { this.store.close(); throw error; }
  }

  async start(): Promise<void> {
    try {
      if (this.options.managedUlwPath) {
        this.ulw = { ...this.ulw, packagePath: validateManagedUlwPackage(this.options.managedUlwPath), injected: true };
        if (this.options.updateManagedUlw) void this.refreshUlw();
      } else {
        // Installation is mandatory before service activation. A slow/unreachable
        // upstream must not delay an already prepared Gateway's IPC or head.
        activeManagedUlw();
        this.ulw = managedUlwStatus();
        void this.refreshUlw();
        this.updateMonitor = setInterval(() => { void this.refreshUlw(); }, readUlwManifest().checkIntervalMs);
        this.updateMonitor.unref();
      }
      const path = gatewayPaths(this.config).socketPath;
      const previous = JSON.parse(this.store.getMeta("gateway:socket") ?? "null") as SocketIdentity | null;
      await removeDeadSocket(path, previous);
      await this.server.listen();
      await this.messenger.start({
        ready: this.server.initialReady.promise,
        message: async input => { this.store.admit({ kind: "message", input }); this.server.deliver(); },
        answer: async (approvalId, response, route) => {
          this.store.admit({ kind: "answer", approvalId, response, route }); this.server.deliver();
        },
        reconnect: async () => { this.store.admit({ kind: "reconnect" }); this.server.deliver(); },
      });
      this.transportsReady = true;
      await this.ensureHead();
      this.monitor = setInterval(() => {
        void this.ensureHead().catch(error => { this.error = "Head ownership/startup requires reconciliation"; this.report(error); });
      }, 1_000);
      process.on("SIGTERM", this.signal);
      process.on("SIGINT", this.signal);
    } catch (error) { await this.close(); throw error; }
  }

  status(): GatewayStatus {
    const live = this.head ? alive(this.head.pid) : false;
    return {
      gateway: { pid: process.pid, ready: this.transportsReady && !this.closed,
        admissionReady: this.server.ready, pendingEvents: this.closed ? 0 : this.store.pending(), stopping: this.stopping },
      head: { pid: this.head?.pid ?? null, ready: live && this.server.headReady,
        connected: live && this.server.connected, socketPath: hostPaths(this.config, "main").socketPath, error: this.error },
      ulw: { ...this.ulw },
    };
  }

  private refreshUlw(): Promise<void> {
    if (this.updating) return this.updating;
    this.ulw = { ...this.ulw, updating: true };
    this.updating = Promise.resolve().then(() => (this.options.updateManagedUlw ?? updateManagedUlw)()).then(status => { this.ulw = status; }, error => {
      if (this.options.managedUlwPath) {
        this.ulw = { ...this.ulw, updating: false, error: error instanceof Error ? error.message : "Managed ULW update failed" };
      } else {
        try { this.ulw = managedUlwStatus(); }
        catch { this.ulw = { ...this.ulw, updating: false, error: "Managed ULW status is unavailable" }; }
      }
      this.report(error);
    }).finally(() => { this.updating = undefined; });
    return this.updating;
  }

  private async identifyHead(): Promise<HeadIdentity> {
    const paths = hostPaths(this.config, "main");
    const connection = await connect(paths.socketPath);
    try {
      const state = await connection.client.getState();
      if (resolve(state.sessionFile!) !== resolve(paths.sessionFile)) throw new Error("Main endpoint belongs to another native session");
      const stat = await lstat(paths.socketPath);
      return { pid: state.hostPid!, sessionId: state.sessionId, sessionFile: state.sessionFile!, dev: stat.dev, ino: stat.ino };
    } finally { await connection.close(); }
  }
  private sameHead(actual: HeadIdentity, expected: HeadIdentity): boolean {
    return actual.pid === expected.pid && actual.sessionId === expected.sessionId &&
      resolve(actual.sessionFile) === resolve(expected.sessionFile) && actual.dev === expected.dev && actual.ino === expected.ino;
  }
  private async authorizeHead(pid: number): Promise<void> {
    const actual = await this.identifyHead();
    if (actual.pid !== pid || (!this.head && !this.launching) || (this.head && !this.sameHead(actual, this.head)))
      throw new DeliveryError("Gateway client is not the supervised native head", "rejected");
  }
  private ensureHead(): Promise<void> {
    if (this.stopping || this.closed) return Promise.resolve();
    if (this.supervision) return this.supervision;
    this.supervision = this.reconcileHead().finally(() => { this.supervision = undefined; });
    return this.supervision;
  }
  private async reconcileHead(): Promise<void> {
    const paths = hostPaths(this.config, "main");
    if (this.head && alive(this.head.pid)) {
      // A live PID alone is not adoption authority. Probe the saved session and
      // inode each time; a PID reuse or replaced socket is never a second writer.
      const known = this.head;
      try {
        const actual = await this.identifyHead();
        if (!this.sameHead(actual, known)) throw new Error("Known native head identity changed");
        this.error = null;
        return;
      } catch (error) {
        // Losing a probe while this exact owned process dies is normal recovery,
        // not a fatal adapter/ownership error. A still-live PID remains blocked.
        if (alive(known.pid)) throw error;
      }
    }
    await removeDeadSocket(paths.socketPath, this.head);
    this.head = null;
    this.store.setMeta("gateway:head", "null");
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    for (const name of credentialEnvNames(this.config)) delete env[name];
    delete env.OMP_RPC_SOCKET;
    env.OMP_SUPERAGENT_CONFIG = this.config.path;
    env.OMP_SUPERAGENT_ROLE = "head";
    env.OMP_SUPERAGENT_GATEWAY_TOKEN = this.store.token();
    await mkdir(dirname(paths.sessionFile), { recursive: true, mode: 0o700 });
    this.launching = true;
    try {
      const launched = await startHost({ command: this.config.command, cwd: this.config.headCwd,
        sessionFile: paths.sessionFile, socketPath: paths.socketPath, logPath: paths.logPath,
        extensionPath: this.options.extensionPath ?? fileURLToPath(new URL("./extension.ts", import.meta.url)),
        managedUlwPath: this.options.managedUlwPath,
        env, model: existsSync(paths.sessionFile) ? undefined : this.config.model,
        subagentConcurrency: Math.floor(this.config.maxSubagents / this.config.maxHosts),
      });
      const identity = await this.identifyHead();
      if (identity.pid !== launched.pid) throw new Error("Launched head ownership changed");
      this.head = identity;
      this.store.setMeta("gateway:head", JSON.stringify(identity));
      this.error = null;
    } finally { this.launching = false; }
  }

  private stopHead(): Promise<void> {
    if (this.stopTask) return this.stopTask;
    this.stopTask = this.shutdownHead().finally(() => { this.stopTask = undefined; });
    return this.stopTask;
  }
  private async shutdownHead(): Promise<void> {
    if (this.closed) return;
    this.stopping = true;
    await this.supervision;
    if (this.head && alive(this.head.pid)) {
      const head = this.head;
      const actual = await this.identifyHead();
      if (!this.sameHead(actual, head)) { this.stopping = false; throw new Error("Refusing to stop an unowned native host"); }
      const connection = await connect(hostPaths(this.config, "main").socketPath);
      try {
        const result = await connection.request({ type: "shutdown_host" });
        if (!result.success) {
          this.stopping = false;
          throw new DeliveryError(result.error ?? "Native head refused busy shutdown", "rejected");
        }
      } catch (error) {
        // An ambiguous shutdown is not a license to restart or kill the host.
        throw error;
      } finally { await connection.close(); }
      const deadline = Date.now() + 15_000;
      while (alive(head.pid) && Date.now() < deadline) await Bun.sleep(25);
      if (alive(head.pid)) throw new Error("Native head shutdown is pending; Gateway supervision remains stopped");
    }
    this.head = null;
    this.store.setMeta("gateway:head", "null");
  }
  async stop(): Promise<void> {
    await this.stopHead();
    await this.close();
  }
  close(): Promise<void> {
    if (!this.closing) this.closing = this.detach();
    return this.closing;
  }
  private async detach(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.monitor) clearInterval(this.monitor);
    if (this.updateMonitor) clearInterval(this.updateMonitor);
    process.off("SIGTERM", this.signal);
    process.off("SIGINT", this.signal);
    await this.supervision;
    await this.updating;
    await this.server.close();
    try { await this.messenger.stop(); }
    finally { this.transportsReady = false; this.store.close(); }
  }
}

export async function startGateway(config: Config, options: GatewayOptions = {}): Promise<GatewayService> {
  privateDirectory(config.stateDir);
  for (const directory of ["run", "logs", "sessions"]) privateDirectory(join(config.stateDir, directory));
  const service = new GatewayService(config, options);
  await service.start();
  return service;
}

export async function gatewayStatus(config: Config): Promise<GatewayStatus | null> {
  const path = gatewayPaths(config).socketPath;
  if (!existsSync(path)) return null;
  return gatewayCall<GatewayStatus>(path, "/status");
}
export async function stopGateway(config: Config): Promise<void> {
  await gatewayCall(gatewayPaths(config).socketPath, "/stop", {}, { timeoutMs: 25_000 });
}

/** Explicit CLI activation only; ordinary commands never start the service. */
export async function launchGateway(config: Config): Promise<GatewayStatus> {
  let running: GatewayStatus | null;
  try { running = await gatewayStatus(config); }
  catch (error) {
    // A private, recorded dead daemon may leave its exact socket behind. The
    // replacement daemon acquires the SQLite lifetime lock before reconciling
    // that inode. Unknown/live endpoints are never bypassed.
    const database = new Database(join(config.stateDir, "coordination.sqlite"), { readonly: true });
    try {
      const row = database.query("SELECT value FROM metadata WHERE key='gateway:socket'").get() as { value: string } | null;
      const previous = row ? JSON.parse(row.value) as SocketIdentity : null;
      if (!previous || alive(previous.pid)) throw error;
      running = null;
    } finally { database.close(); }
  }
  if (running) return running;
  requireMessengerCredentials(config);
  privateDirectory(config.stateDir);
  for (const directory of ["run", "logs", "sessions"]) privateDirectory(join(config.stateDir, directory));
  const paths = gatewayPaths(config);
  const log = await open(paths.logPath, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  let child;
  let failure: Error | undefined;
  try {
    const stat = await log.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
      throw new Error("Gateway log must be a private owned regular file");
    child = spawn(process.execPath, [fileURLToPath(new URL("./gateway.ts", import.meta.url)), "--config", config.path], {
      cwd: config.headCwd, detached: true, stdio: ["ignore", log.fd, log.fd], shell: false,
    });
    child.once("error", error => { failure = error; });
    child.once("exit", () => { failure = new Error(`Gateway exited during startup; see ${paths.logPath}`); });
    child.unref();
  } finally { await log.close(); }
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (failure) throw failure;
    try {
      const status = await gatewayStatus(config);
      if (status && status.gateway.pid === child.pid && status.gateway.ready && status.head.pid) return status;
    } catch { /* A freshly spawned daemon may still be binding/authenticating. */ }
    await Bun.sleep(50);
  }
  // The service may already own a live head. Never kill it on a lost receipt.
  throw new Error(`Gateway startup outcome unresolved; inspect status and ${paths.logPath} before retrying`);
}

if (import.meta.main) {
  const index = process.argv.indexOf("--config");
  if (index < 0 || !process.argv[index + 1]) throw new Error("Gateway requires --config FILE");
  try { await startGateway(await loadConfig(process.argv[index + 1]!)); }
  catch { console.error("Gateway startup failed; no unowned host/socket was removed"); process.exitCode = 1; }
}
