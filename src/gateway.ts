#!/usr/bin/env bun
import { spawn, type ChildProcess } from "node:child_process";
import { Database } from "bun:sqlite";
import { constants, existsSync } from "node:fs";
import { lstat, mkdir, open, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readSessionHeaderId } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { credentialEnvNames, hostPaths, loadConfig, privateDirectory, requireMessengerCredentials, type Config } from "./config";
import type { GatewayRestartRecord, GatewayRestartRequest, LanePresetSnapshot, Messenger } from "./contracts";
import { DeliveryError } from "./delivery";
import { gatewayCall, gatewayPaths } from "./gateway-protocol";
import { GatewayServer, type GatewayStatus } from "./gateway-server";
import { GatewayStore } from "./gateway-store";
import { readRestartPlan, restartConfigHash, validateRestartPlan, type RestartPlan } from "./gateway-restart";
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
  /** Isolated subprocess fixture seam; production always uses the fixed one-shot helper. */
  launchRestartRunner?: (configPath: string, requestId: string, logFd: number) => ChildProcess;
  /** Only the durable, owned one-shot handoff may supply this identity. */
  restartRequestId?: string;
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
  private restartRunning?: Promise<void>;
  private restartAccepting = false;
  private stopGeneration = 0;
  private configHash?: string;
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
        restart: request => this.restart(request), runRestart: requestId => this.runRestart(requestId),
        stop: async () => {
          this.cancelRestart();
          await this.stopHead();
          // Allow the CLI to receive the committed shutdown receipt first.
          setTimeout(() => { void this.close().catch(this.report); }, 25);
        },
      });
    } catch (error) { this.store.close(); throw error; }
  }

  async start(): Promise<void> {
    try {
      this.configHash = await restartConfigHash(this.config.path);
      if (this.options.restartRequestId) await this.validateReplacement();
      else {
        const active = this.store.getMeta("gateway:restart-active");
        const pending = this.store.getRestart(active || undefined);
        if (pending && (pending.state === "accepted" || pending.state === "head-stopped" || pending.state === "uncertain"))
          throw new Error("An owned restart handoff is pending; ordinary startup cannot adopt it");
      }
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
        message: async input => { this.server.admitMessage(input); },
        answer: async (approvalId, response, route) => {
          this.store.admit({ kind: "answer", approvalId, response, route }); this.server.deliver();
        },
        reconnect: async () => { this.store.admit({ kind: "reconnect" }); this.server.deliver(); },
      });
      this.transportsReady = true;
      await this.ensureHead();
      if (this.options.restartRequestId) {
        const record = this.store.getRestart(this.options.restartRequestId)!;
        if (record.state !== "head-stopped" || this.stopping || !this.head || this.head.pid === record.headPid || this.head.sessionId !== record.sessionId ||
            resolve(this.head.sessionFile) !== resolve(record.sessionFile))
          throw new Error("Replacement native head identity did not match the restart request");
        this.store.setRestart({ ...record, state: "started", successorPid: process.pid, replacementPid: this.head.pid });
        this.store.setMeta("gateway:restart-active", "");
      }
      this.monitor = setInterval(() => {
        void this.ensureHead().catch(error => { this.error = "Head ownership/startup requires reconciliation"; this.report(error); });
      }, 1_000);
      process.on("SIGTERM", this.signal);
      process.on("SIGINT", this.signal);
    } catch (error) { await this.close(); throw error; }
  }

  status(): GatewayStatus {
    const live = this.head ? alive(this.head.pid) : false;
    const saved = this.closed ? null : this.store.getMeta("head:preset-bootstrap");
    const recorded: GatewayStatus["head"]["initialization"] = saved ? JSON.parse(saved) : undefined;
    const initialization = recorded?.sessionId === this.head?.sessionId ? recorded : this.head ? {
      sessionId: this.head.sessionId, state: "checking" as const,
      detail: "Waiting for authoritative native HEAD attachment, approval reconciliation and preset inspection.",
    } : undefined;
    return {
      gateway: { pid: process.pid, ready: this.transportsReady && !this.closed,
        admissionReady: this.server.ready, pendingEvents: this.closed ? 0 : this.store.pending(), stopping: this.stopping },
      head: { pid: this.head?.pid ?? null, ready: live && this.server.headReady && initialization?.state === "complete",
        connected: live && this.server.connected, socketPath: hostPaths(this.config, "main").socketPath, error: this.error,
        ...(initialization ? { initialization } : {}) },
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
    const restoring = existsSync(paths.sessionFile);
    const sessionId = restoring ? await readSessionHeaderId(paths.sessionFile) : undefined;
    if (sessionId && this.store.getMeta("main:sessionId") && sessionId !== this.store.getMeta("main:sessionId")) {
      throw new Error("Stored head settings belong to a different native session; refusing startup");
    }
    const settingsRecord = sessionId ? this.store.getMeta(`head:model-settings:${sessionId}`) : null;
    const savedSettings: { settings: LanePresetSnapshot; clearedRoles: string[] } | undefined =
      settingsRecord ? JSON.parse(settingsRecord) : undefined;
    this.launching = true;
    try {
      const launched = await startHost({ command: this.config.command, cwd: this.config.headCwd,
        sessionFile: paths.sessionFile, socketPath: paths.socketPath, logPath: paths.logPath,
        extensionPath: this.options.extensionPath ?? fileURLToPath(new URL("./extension.ts", import.meta.url)),
        managedUlwPath: this.options.managedUlwPath,
        env, model: restoring ? undefined : this.config.model,
        ...(savedSettings ? { modelSettings: savedSettings.settings, clearedModelRoles: savedSettings.clearedRoles } : {}),
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
    this.cancelRestart();
    await this.stopHead();
    await this.close();
  }

  private cancelRestart(): void {
    if (this.closed) return;
    this.stopGeneration++;
    const active = this.store.getMeta("gateway:restart-active");
    const record = this.store.getRestart(active || undefined);
    if (!record || (record.gatewayPid !== process.pid && record.successorPid !== process.pid) ||
        (record.state !== "accepted" && record.state !== "head-stopped")) return;
    this.store.setRestart({ ...record, state: "refused", reason: "Explicit operator stop superseded the restart; no successor is authorized." });
    this.store.setMeta("gateway:restart-active", "");
  }

  private async validateReplacement(): Promise<void> {
    const requestId = this.options.restartRequestId!;
    const record = this.store.getRestart(requestId);
    const plan = readRestartPlan(this.store, requestId);
    await validateRestartPlan(this.config, record, plan);
    if (!record || !plan || record.state !== "head-stopped" || plan.launchPid !== process.pid ||
        record.successorPid !== process.pid || this.store.getMeta("gateway:restart-active") !== requestId ||
        alive(record.gatewayPid) || alive(record.headPid))
      throw new Error("Replacement Gateway has no exact durable launch authority");
  }

  /** Accept only a sent owner command; the HTTP response must finish before execution. */
  async restart(request: GatewayRestartRequest): Promise<GatewayRestartRecord> {
    this.store.validateRestart(request);
    const existing = this.store.getRestart(request.requestId);
    if (existing) {
      if (existing.inputId !== request.inputId || existing.ackOutputId !== request.ackOutputId)
        throw new DeliveryError("Restart request identity conflict", "rejected");
      return existing;
    }
    if (!this.head) throw new DeliveryError("Owned HEAD is unavailable; restart was not authorized", "rejected");
    const head = this.head;
    const stopGeneration = this.stopGeneration;
    const record: GatewayRestartRecord = { ...request, gatewayPid: process.pid, headPid: head.pid,
      sessionId: head.sessionId, sessionFile: head.sessionFile, state: "accepted" };
    const refuse = (reason: string, outcome: "refused" | "uncertain" = "refused") => {
      const result = { ...record, state: outcome, reason };
      this.store.setRestart(result);
      this.store.admit({ kind: "restart", requestId: request.requestId, outcome, reason });
      this.server.deliver();
      return result;
    };
    const activeId = this.store.getMeta("gateway:restart-active");
    const active = this.store.getRestart(activeId || undefined);
    if (this.closed || this.stopping || this.restartAccepting || active &&
        (active.state === "accepted" || active.state === "head-stopped" || active.state === "uncertain"))
      return refuse("Gateway already has an active or unresolved lifecycle operation; no process was stopped.");
    this.restartAccepting = true;
    this.stopping = true;
    try {
      await this.supervision;
      const fence = JSON.parse(this.store.getMeta("head:restart-fence") ?? "null") as {
        requestId?: string; inputId?: string; ackOutputId?: string; ownerPid?: number; sessionId?: string; sessionFile?: string;
      } | null;
      if (!fence || fence.requestId !== request.requestId || fence.inputId !== request.inputId ||
          fence.ackOutputId !== request.ackOutputId || fence.ownerPid !== head.pid || fence.sessionId !== head.sessionId ||
          !fence.sessionFile || resolve(fence.sessionFile) !== resolve(head.sessionFile))
        return refuse("HEAD restart fence does not match the owned request; no process was stopped.");
      const actual = await this.identifyHead();
      if (!this.sameHead(actual, head))
        return refuse("Native HEAD ownership changed; no process was stopped.");
      const connection = await connect(hostPaths(this.config, "main").socketPath);
      try {
        const state = await connection.client.getState();
        if (state.hostPid !== head.pid || state.sessionId !== head.sessionId || !state.sessionFile ||
            resolve(state.sessionFile) !== resolve(head.sessionFile))
          return refuse("Native HEAD identity could not be verified; no process was stopped.");
        if (state.isSettled !== true || state.isStreaming !== false || state.isCompacting !== false ||
            state.queuedMessageCount !== 0 || state.hasPendingAsyncWork !== false || state.hasOwnedRunningWork !== false ||
            !Array.isArray(state.pendingUiRequests) || state.pendingUiRequests.length || state.goal === undefined || state.goal?.enabled)
          return refuse("Native HEAD is busy or its idle ownership state is incomplete; no process was stopped.");
      } finally { await connection.close(); }
      const socket = JSON.parse(this.store.getMeta("gateway:socket") ?? "null") as SocketIdentity | null;
      const stat = await lstat(gatewayPaths(this.config).socketPath);
      if (!socket || socket.pid !== process.pid || socket.dev !== stat.dev || socket.ino !== stat.ino)
        return refuse("Gateway endpoint ownership could not be verified; no process was stopped.");
      const plan: RestartPlan = { configPath: this.config.path, stateDir: this.config.stateDir,
        configHash: await restartConfigHash(this.config.path), socket, head };
      if (plan.configHash !== this.configHash)
        return refuse("Gateway configuration changed since activation; no process was stopped or successor authorized.");
      if (stopGeneration !== this.stopGeneration)
        return refuse("An explicit operator stop superseded restart acceptance; no successor was authorized.");
      this.store.setMeta(`gateway:restart-plan:${request.requestId}`, JSON.stringify(plan));
      this.store.setRestart(record);
      this.store.setMeta("gateway:restart-active", request.requestId);
      return record;
    } catch {
      return refuse("Native idle or ownership probe was unavailable; no shutdown was requested.");
    } finally {
      this.restartAccepting = false;
      if (stopGeneration === this.stopGeneration && this.store.getRestart(request.requestId)?.state !== "accepted") this.stopping = false;
    }
  }

  runRestart(requestId: string): void {
    if (this.restartRunning || this.closed) return;
    const record = this.store.getRestart(requestId);
    if (!record || record.state !== "accepted" || record.gatewayPid !== process.pid) return;
    // Reserve synchronously: duplicate response-finish callbacks cannot shut down twice.
    this.restartRunning = this.executeRestart(record).catch(this.report).finally(() => { this.restartRunning = undefined; });
  }

  private async executeRestart(record: GatewayRestartRecord): Promise<void> {
    try {
      const actual = await this.identifyHead();
      if (this.store.getRestart(record.requestId)?.state !== "accepted") return;
      const plan = readRestartPlan(this.store, record.requestId);
      if (!plan || !this.sameHead(actual, plan.head))
        throw new DeliveryError("Native HEAD ownership changed; restart was refused without a shutdown", "rejected");
      const paths = gatewayPaths(this.config);
      const log = await open(paths.logPath, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      try {
        const stat = await log.stat();
        if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077))
          throw new Error("Restart log ownership is invalid");
        if (this.store.getRestart(record.requestId)?.state !== "accepted") return;
        const runner = this.options.launchRestartRunner?.(this.config.path, record.requestId, log.fd) ??
          spawn(process.execPath, ["--no-env-file", fileURLToPath(new URL("./gateway-restart.ts", import.meta.url)),
          "--config", this.config.path, "--state-dir", this.config.stateDir, "--request", record.requestId], {
          cwd: this.config.headCwd, detached: true, stdio: ["ignore", log.fd, log.fd], shell: false,
        });
        // Spawn has an asynchronous error receipt. Do not release the lifetime lock until it is known.
        const spawned = Promise.withResolvers<void>();
        runner.once("spawn", spawned.resolve);
        runner.once("error", spawned.reject);
        try { await spawned.promise; }
        catch { throw new DeliveryError("Successor could not be spawned; native shutdown was not requested", "rejected"); }
        if (!runner.pid) throw new Error("Successor runner has no process identity");
        this.store.setMeta(`gateway:restart-plan:${record.requestId}`, JSON.stringify({ ...plan, runnerPid: runner.pid }));
        let exited = false;
        runner.once("exit", () => { exited = true; });
        runner.unref();
        const deadline = Date.now() + 15_000;
        while (!readRestartPlan(this.store, record.requestId)?.runnerReady) {
          const state = this.store.getRestart(record.requestId)?.state;
          if (state === "refused") return;
          if (state !== "accepted") throw new Error("Successor preparation failed or lost its durable request");
          if (exited) throw new DeliveryError("Successor exited before preparation; native shutdown was not requested", "rejected");
          if (Date.now() >= deadline) throw new Error("Successor preparation outcome is unresolved");
          await Bun.sleep(25);
        }
      } finally { await log.close(); }
      const prepared = this.store.getRestart(record.requestId)?.state;
      if (prepared === "refused") return;
      if (prepared !== "accepted") throw new Error("Successor preparation authority changed");
      // Reuse the supervised shutdown boundary only after the one-shot successor
      // durably confirms its own identity. Its ambiguous outcome never authorizes a launch.
      await this.stopHead();
      if (this.store.getRestart(record.requestId)?.state !== "accepted") return;
      this.store.setRestart({ ...record, state: "head-stopped" });
      await this.close();
    } catch (error) {
      if (this.closed) return;
      const saved = this.store.getRestart(record.requestId);
      if (!saved || saved.state === "refused") return;
      const refused = error instanceof DeliveryError && error.certainty === "rejected";
      const reason = refused ? "Restart preparation or native shutdown was refused; no replacement Gateway was launched."
        : "Restart shutdown or successor spawn outcome is uncertain; no automatic retry or forced kill is authorized.";
      this.store.setRestart({ ...saved, state: refused ? "refused" : "uncertain", reason });
      if (refused) this.store.setMeta("gateway:restart-active", "");
      this.store.admit({ kind: "restart", requestId: record.requestId, outcome: refused ? "refused" : "uncertain", reason });
      this.server.deliver();
      if (refused) this.stopping = false;
    }
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
  if (!options.restartRequestId) {
    privateDirectory(config.stateDir);
    for (const directory of ["run", "logs", "sessions"]) privateDirectory(join(config.stateDir, directory));
  }
  let service: GatewayService;
  if (options.restartRequestId) {
    // The parent persists the spawned PID while holding the lifetime lock. A
    // scheduled-fast child waits for that exact receipt, never for an arbitrary owner.
    const deadline = Date.now() + 15_000;
    const db = new Database(join(config.stateDir, "coordination.sqlite"), { readonly: true });
    try {
      for (;;) {
        const getMeta = (key: string) => (db.query("SELECT value FROM metadata WHERE key=?").get(key) as { value: string } | null)?.value ?? null;
        const record = JSON.parse(getMeta(`gateway:restart:${options.restartRequestId}`) ?? "null") as GatewayRestartRecord | null;
        const plan = readRestartPlan({ getMeta }, options.restartRequestId);
        if (!record || !plan || record.state !== "head-stopped" || getMeta("gateway:restart-active") !== record.requestId ||
            (plan.launchPid !== undefined && plan.launchPid !== process.pid) ||
            (record.successorPid !== undefined && record.successorPid !== process.pid))
          throw new Error("Replacement launch receipt was cancelled or belongs to another process");
        if (plan.launchPid === process.pid && record.successorPid === process.pid) {
          try { service = new GatewayService(config, options); break; }
          catch (error) {
            if (!error || typeof error !== "object" || !("code" in error) || error.code !== "SQLITE_BUSY") throw error;
            // Only known pre-activation lock contention is waitable; no effect is retried.
          }
        }
        if (Date.now() >= deadline) throw new Error("Exact restart launch receipt/lifetime lock was not released");
        await Bun.sleep(25);
      }
    } finally { db.close(); }
  } else service = new GatewayService(config, options);
  await service.start();
  return service;
}

export async function gatewayStatus(config: Config): Promise<GatewayStatus | null> {
  const path = gatewayPaths(config).socketPath;
  if (!existsSync(path)) return null;
  return gatewayCall<GatewayStatus>(path, "/status");
}
export async function stopGateway(config: Config): Promise<void> {
  try { await gatewayCall(gatewayPaths(config).socketPath, "/stop", {}, { timeoutMs: 25_000 }); }
  catch (error) {
    const database = new Database(join(config.stateDir, "coordination.sqlite"), { readonly: true });
    try {
      const row = database.query("SELECT value FROM metadata WHERE key='gateway:restart'").get() as { value: string } | null;
      const restart = row ? JSON.parse(row.value) as GatewayRestartRecord : null;
      if (restart && (restart.state === "accepted" || restart.state === "head-stopped"))
        throw new DeliveryError("Gateway stop was not confirmed during a restart handoff; the successor was not cancelled. Inspect status before retrying stop.", "uncertain");
    } finally { database.close(); }
    throw error;
  }
}

/** Explicit CLI activation only; ordinary commands never start the service. */
export async function launchGateway(config: Config, restartRequestId?: string, command = [process.execPath, "--no-env-file",
  fileURLToPath(new URL("./gateway.ts", import.meta.url))]): Promise<GatewayStatus> {
  let restart: GatewayRestartRecord | null = null;
  let plan: RestartPlan | null = null;
  let handoff: GatewayStore | undefined;
  if (restartRequestId) {
    handoff = new GatewayStore(config.stateDir);
    try {
      restart = handoff.getRestart(restartRequestId);
      plan = readRestartPlan(handoff, restartRequestId);
      await validateRestartPlan(config, restart, plan);
      if (!restart || !plan || restart.state !== "head-stopped" || plan.runnerPid !== process.pid || plan.launchPid ||
          handoff.getMeta("gateway:restart-active") !== restartRequestId || alive(restart.gatewayPid) || alive(restart.headPid))
        throw new Error("Restart launch authority is no longer valid");
    } catch (error) { handoff.close(); throw error; }
  }
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
      if (!previous || alive(previous.pid)) { handoff?.close(); throw error; }
      running = null;
    } finally { database.close(); }
  }
  if (running) {
    handoff?.close();
    if (restartRequestId) throw new Error("Restart cannot return or adopt an existing Gateway endpoint");
    return running;
  }
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
    child = spawn(command[0]!, [...command.slice(1), "--config", config.path,
      ...(restartRequestId ? ["--restart-request", restartRequestId] : [])], {
      cwd: config.headCwd, detached: true, stdio: ["ignore", log.fd, log.fd], shell: false,
    });
    child.once("error", error => { failure = error; });
    child.once("exit", () => { failure = new Error(`Gateway exited during startup; see ${paths.logPath}`); });
    if (handoff && restart && plan && child.pid) {
      handoff.setMeta(`gateway:restart-plan:${restart.requestId}`, JSON.stringify({ ...plan, launchPid: child.pid }));
      handoff.setRestart({ ...restart, successorPid: child.pid });
    }
    child.unref();
  } finally { handoff?.close(); await log.close(); }
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (failure) throw failure;
    try {
      const status = await gatewayStatus(config);
      if (status && status.gateway.pid === child.pid && status.gateway.ready && status.head.pid &&
          (!restart || status.head.pid !== restart.headPid)) return status;
    } catch { /* A freshly spawned daemon may still be binding/authenticating. */ }
    await Bun.sleep(50);
  }
  // The service may already own a live head. Never kill it on a lost receipt.
  throw new Error(`Gateway startup outcome unresolved; inspect status and ${paths.logPath} before retrying`);
}

if (import.meta.main) {
  const index = process.argv.indexOf("--config");
  if (index < 0 || !process.argv[index + 1]) throw new Error("Gateway requires --config FILE");
  const restartAt = process.argv.indexOf("--restart-request");
  try { await startGateway(await loadConfig(process.argv[index + 1]!), {
    ...(restartAt >= 0 ? { restartRequestId: process.argv[restartAt + 1] } : {}),
  }); }
  catch { console.error("Gateway startup failed; no unowned host/socket was removed"); process.exitCode = 1; }
}
