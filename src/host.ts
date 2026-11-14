import { spawn, type ChildProcess } from "node:child_process";
import { constants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  RpcClient,
  type RpcAgentProcess,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import type {
  RpcCommand,
  RpcExtensionUIResponse,
  RpcResponse,
  RpcSessionState,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { isValidModelPresetName } from "@oh-my-pi/pi-coding-agent/config/model-presets";
import type { DialogResponse, LanePresetSnapshot } from "./contracts";
import { activeManagedUlw, MANAGED_ULW_ENV, MANAGED_ULW_FIXTURE_ENV, MANAGED_ULW_FIXTURE_ROOT_ENV, validateManagedUlwPackage } from "./managed-ulw";

const CONNECT_TIMEOUT_MS = 5_000;
const START_TIMEOUT_MS = 30_000;
const MAX_PENDING_BYTES = 16 * 1024 * 1024;
const MAX_PENDING_WRITES = 4096;

export interface HostOptions {
  command: string[];
  socketPath: string;
  sessionFile: string;
  cwd: string;
  extensionPath: string;
  /** Explicit isolated fixture package; production always resolves the active managed revision. */
  managedUlwPath?: string;
  /** Isolated managed-installation root; unlike package injection, follows its active pointer. */
  managedUlwRoot?: string;
  /** Complete child environment; omitted credentials must never be inherited again. */
  env: Record<string, string>;
  logPath: string;
  model?: string;
  modelPreset?: { name: string; preset: LanePresetSnapshot };
  /** Restore session-local preset roles without overriding the transcript's active model/effort. */
  modelSettings?: LanePresetSnapshot;
  clearedModelRoles?: string[];
  subagentConcurrency: number;
}

export type HostFrame = Record<string, unknown>;

export class HostStartError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HostStartError";
  }
}

function assertSocketPath(socketPath: string): void {
  // Match the core host's portable limit, including macOS sockaddr_un.
  if (!path.isAbsolute(socketPath) || Buffer.byteLength(socketPath) > 100) {
    throw new Error("RPC socket must be an absolute Unix socket path of at most 100 bytes");
  }
}

async function privateDirectory(directory: string): Promise<void> {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) {
    throw new Error(`RPC socket directory must be owned by this user with mode 0700 (no symlink): ${directory}`);
  }
}

async function socketIdentity(socketPath: string): Promise<Stats> {
  assertSocketPath(socketPath);
  await privateDirectory(path.dirname(socketPath));
  const stat = await fs.lstat(socketPath);
  if (!stat.isSocket() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600) {
    throw new Error(`RPC socket must be owned by this user with mode 0600: ${socketPath}`);
  }
  return stat;
}

/** RpcClient owns framing, negotiation, correlation, and events. This only carries bytes. */
class SocketProcess implements RpcAgentProcess {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  readonly stdin: RpcAgentProcess["stdin"];
  readonly #pending = new Set<(error: Error) => void>();
  #error = "";

  constructor(readonly socket: net.Socket) {
    // Node and Bun publish incompatible getReader overloads for the same WHATWG stream.
    this.stdout = Readable.toWeb(socket) as unknown as ReadableStream<Uint8Array>;
    const { promise, resolve } = Promise.withResolvers<number>();
    this.exited = promise;
    socket.once("close", () => {
      const error = new Error(this.#error || "RPC socket disconnected; request outcome may be unknown");
      for (const reject of this.#pending) reject(error);
      resolve(this.#error ? 1 : 0);
    });
    socket.on("error", error => { this.#error = error.message; });
    this.stdin = { write: data => this.#write(data) };
  }

  peekStderr(): string { return this.#error; }

  // RpcClient.stop() is a detach operation for this transport, never a host signal.
  kill(): void { this.socket.destroy(); }

  #write(data: string | Uint8Array): Promise<void> {
    if (this.socket.destroyed || !this.socket.writable) {
      return Promise.reject(new Error("RPC socket is disconnected"));
    }
    const bytes = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
    if (this.socket.writableLength + bytes > MAX_PENDING_BYTES || this.#pending.size >= MAX_PENDING_WRITES) {
      return Promise.reject(new Error("RPC socket write backlog exceeded its bound"));
    }
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const finish = (error?: Error | null) => {
      if (!this.#pending.delete(fail)) return;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const fail = (error: Error) => finish(error);
    const timer = setTimeout(() => {
      const error = new Error("RPC socket write timed out; request outcome may be unknown");
      finish(error);
      this.socket.destroy(error);
    }, CONNECT_TIMEOUT_MS);
    timer.unref();
    this.#pending.add(fail);
    try { this.socket.write(data, finish); }
    catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    return promise;
  }
}

export class HostConnection {
  readonly client: RpcClient;
  readonly exited: Promise<void>;
  readonly #listeners = new Set<(frame: HostFrame) => void>();
  readonly #subscriptions: Array<() => void>;
  #close: Promise<void> | undefined;

  private constructor(transport: SocketProcess) {
    this.exited = transport.exited.then(() => {});
    this.client = new RpcClient({ spawn: () => transport });
    this.#subscriptions = [
      this.client.onSessionEvent(frame => this.#emit(frame)),
      this.client.onExtensionUIRequest(frame => this.#emit(frame)),
      this.client.onPromptResult(frame => this.#emit(frame)),
      this.client.onSessionSettled(() => this.#emit({ type: "session_settled" })),
    ];
  }

  static async connect(socketPath: string, timeoutMs = CONNECT_TIMEOUT_MS): Promise<HostConnection> {
    const before = await socketIdentity(socketPath);
    const socket = net.createConnection(socketPath);
    const transport = new SocketProcess(socket);
    const connection = new HostConnection(transport);
    const timeout = setTimeout(() => socket.destroy(new Error("RPC socket connection/identity probe timed out")), timeoutMs);
    timeout.unref();
    try {
      await connection.client.start();
      const after = await socketIdentity(socketPath);
      if (before.dev !== after.dev || before.ino !== after.ino) {
        throw new Error("RPC socket identity changed while connecting");
      }
      const state = await connection.client.getState();
      if (typeof state.sessionId !== "string" || !state.sessionId ||
          typeof state.sessionFile !== "string" || !path.isAbsolute(state.sessionFile) ||
          !Number.isSafeInteger(state.hostPid) || state.hostPid! < 1) {
        throw new Error("RPC socket did not identify a persistent OMP session");
      }
      return connection;
    } catch (error) {
      await connection.close();
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Raw response envelope, like RpcClient.request. No reconnect or prompt replay. */
  request(command: Record<string, unknown>, id?: string): Promise<RpcResponse> {
    if (typeof command.type !== "string" || !command.type) throw new Error("RPC command requires a type");
    if (Object.hasOwn(command, "id")) throw new Error("Pass the persisted request id as the second argument");
    return this.client.request(command as RpcCommand, {
      id,
      // Native compaction owns its cancellation/deadline. Keep its correlated
      // result alive until completion, explicit abort, or transport loss.
      ...(command.type === "compact" ? { timeoutMs: 0 } : {}),
    });
  }

  uiResponse(id: string, response: DialogResponse): void {
    if (!id) throw new Error("UI response requires its original request id");
    this.client.respondToUI({ ...response, type: "extension_ui_response", id } as RpcExtensionUIResponse);
  }

  onFrame(listener: (frame: HostFrame) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  #emit(frame: object): void {
    for (const listener of this.#listeners) listener(frame as HostFrame);
  }

  close(): Promise<void> {
    if (!this.#close) {
      this.#close = this.client.stop().finally(() => {
        for (const unsubscribe of this.#subscriptions) unsubscribe();
        this.#listeners.clear();
      });
    }
    return this.#close;
  }
}

export function connect(socketPath: string): Promise<HostConnection> {
  return HostConnection.connect(socketPath);
}

export function buildHostArgs(options: HostOptions, configPath = `${options.socketPath}.config.json`): string[] {
  assertSocketPath(options.socketPath);
  for (const [name, value] of Object.entries({
    sessionFile: options.sessionFile, cwd: options.cwd, extensionPath: options.extensionPath,
    logPath: options.logPath, configPath,
  })) {
    if (!value || !path.isAbsolute(value)) throw new Error(`${name} must be an explicit absolute path`);
  }
  if (!options.command.length || options.command.some(arg => !arg || arg.includes("\0"))) {
    throw new Error("Host command must be a nonempty argv without NUL bytes");
  }
  if (!Number.isSafeInteger(options.subagentConcurrency) || options.subagentConcurrency < 1) {
    throw new Error("subagentConcurrency must be a positive integer");
  }
  if (options.modelPreset && !isValidModelPresetName(options.modelPreset.name))
    throw new Error("A native model preset must have a valid name");
  const managedUlwPath = selectManagedUlw(options);
  return [
    "--mode", "rpc-ui", "--session-settings", "--rpc-socket", options.socketPath,
    "--session", options.sessionFile, "--cwd", options.cwd,
    // A file entrypoint has no native sibling-resource discovery. The explicit
    // package root adds skills without replacing any user/project settings.
    "-e", fileURLToPath(new URL("../", import.meta.url)),
    "-e", managedUlwPath,
    "-e", options.extensionPath,
    "-e", fileURLToPath(new URL("./board-extension.ts", import.meta.url)),
    "--config", configPath,
    ...(options.model ? ["--model", options.model] : []),
    ...(options.modelPreset ? ["--model-preset", options.modelPreset.name] : []),
  ];
}

function selectManagedUlw(options: HostOptions): string {
  const fixture = options.managedUlwPath ?? options.env[MANAGED_ULW_FIXTURE_ENV];
  const root = options.managedUlwRoot ?? options.env[MANAGED_ULW_FIXTURE_ROOT_ENV];
  return fixture ? validateManagedUlwPackage(fixture) : activeManagedUlw(root ? { root } : {});
}

/** Launch only a new host. Existing endpoints require the caller's explicit adoption decision. */
export async function startHost(options: HostOptions): Promise<{ pid: number }> {
  try { return await launchHost(options); }
  catch (cause) {
    // Never read child output into errors: logs can contain credentials or prompt content.
    throw new HostStartError(cause instanceof Error ? cause.message : "OMP host startup failed", { cause });
  }
}

async function launchHost(options: HostOptions): Promise<{ pid: number }> {
  // Snapshot once before any awaits; an updater may activate a newer revision
  // during startup, but this Host must load one exact immutable package.
  const managedUlwPath = selectManagedUlw(options);
  const fixture = options.managedUlwPath ?? options.env[MANAGED_ULW_FIXTURE_ENV];
  const fixtureRoot = options.managedUlwRoot ?? options.env[MANAGED_ULW_FIXTURE_ROOT_ENV];
  options = { ...options, managedUlwPath, env: { ...options.env, [MANAGED_ULW_ENV]: managedUlwPath,
    ...(fixture ? { [MANAGED_ULW_FIXTURE_ENV]: fixture } : {}),
    ...(fixtureRoot ? { [MANAGED_ULW_FIXTURE_ROOT_ENV]: fixtureRoot } : {}) } };
  buildHostArgs(options);
  await fs.mkdir(path.dirname(options.socketPath), { recursive: true, mode: 0o700 });
  await privateDirectory(path.dirname(options.socketPath));
  let existing = false;
  try { await fs.lstat(options.socketPath); existing = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (existing) {
    const connection = await connect(options.socketPath);
    try {
      const state = await connection.client.getState();
      throw new Error(`RPC socket already hosts session ${state.sessionId} at ${state.sessionFile}; explicit adoption required`);
    } finally { await connection.close(); }
  }

  const launchDirectory = await fs.mkdtemp(path.join(path.dirname(options.socketPath), ".launch-"));
  const configPath = path.join(launchDirectory, "config.json");
  let child: ChildProcess | undefined;
  let log: fs.FileHandle | undefined;
  let failure: Error | undefined;
  try {
    await fs.writeFile(configPath, JSON.stringify({
      task: { maxConcurrency: options.subagentConcurrency },
      ...(options.modelPreset ? { modelPresets: { [options.modelPreset.name]: options.modelPreset.preset } } : {}),
      ...(options.modelSettings ? {
        modelRoles: {
          ...Object.fromEntries((options.clearedModelRoles ?? []).map(role => [role, null])),
          ...options.modelSettings.modelRoles,
        },
        ...(options.modelSettings.defaultThinkingLevel !== undefined
          ? { defaultThinkingLevel: options.modelSettings.defaultThinkingLevel } : {}),
      } : {}),
    }), { flag: "wx", mode: 0o600 });
    log = await fs.open(options.logPath, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    const stat = await log.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
      throw new Error("Host log must be a private regular file owned by this user");
    }
    child = spawn(options.command[0]!, [...options.command.slice(1), ...buildHostArgs(options, configPath)], {
      cwd: options.cwd, env: options.env,
      detached: true, stdio: ["ignore", log.fd, log.fd], shell: false,
    });
    child.once("error", error => { failure = error; });
    child.once("exit", (code, signal) => {
      failure = new Error(`OMP host exited during startup (${signal ?? code}); see ${options.logPath}`);
      void fs.rm(launchDirectory, { recursive: true }).catch(() => {});
    });
    child.unref();
    await log.close();
    log = undefined;
    const deadline = Date.now() + START_TIMEOUT_MS;
    let startingSocket: Stats | undefined;
    while (Date.now() < deadline) {
      if (failure) throw failure;
      let observed: Stats;
      try {
        observed = await fs.lstat(options.socketPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (startingSocket) throw new Error("Launched RPC socket disappeared during startup");
        await Bun.sleep(50);
        continue;
      }
      if (!observed.isSocket() || observed.uid !== process.getuid?.()) {
        throw new Error("Launched RPC endpoint is not a socket owned by this user");
      }
      if (startingSocket && (startingSocket.dev !== observed.dev || startingSocket.ino !== observed.ino)) {
        throw new Error("Launched RPC socket identity changed during startup");
      }
      startingSocket ??= observed;
      // Native bind creates the inode before its asynchronous chmod completes.
      // Only this new, unchanged owned socket gets a bounded readiness wait;
      // never connect to a permissive endpoint or relax ordinary connect checks.
      if ((observed.mode & 0o777) !== 0o600) {
        await Bun.sleep(50);
        continue;
      }
      const connection = await HostConnection.connect(options.socketPath, Math.max(1, deadline - Date.now()));
      try {
        const connectedSocket = await socketIdentity(options.socketPath);
        if (connectedSocket.dev !== startingSocket.dev || connectedSocket.ino !== startingSocket.ino) {
          throw new Error("Launched RPC socket identity changed while connecting");
        }
        const response = await connection.client.request({ type: "get_state" }, {
          timeoutMs: Math.max(1, deadline - Date.now()),
        });
        if (!response.success || response.command !== "get_state") {
          throw new Error("Launched RPC host did not confirm its session identity");
        }
        const state: RpcSessionState = response.data;
        if (path.resolve(state.sessionFile!) !== path.resolve(options.sessionFile)) {
          throw new Error("Launched RPC host identified a different session file");
        }
        if (state.hostPid !== child.pid) {
          throw new Error("RPC endpoint does not belong to the launched host process");
        }
        if (failure) throw failure;
        if (!child.pid) throw new Error("OMP host did not receive a process id");
        return { pid: child.pid };
      } finally { await connection.close(); }
    }
    throw new Error(`OMP host startup timed out; see ${options.logPath}`);
  } catch (error) {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const force = setTimeout(() => {
        if (child?.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 1_000);
      force.unref();
    }
    // Never unlink the socket: it may still belong to an active or racing host.
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) {
      await fs.rm(launchDirectory, { recursive: true });
    }
    throw error;
  } finally { await log?.close(); }
}
