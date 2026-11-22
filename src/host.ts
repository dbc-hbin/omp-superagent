import { spawn, type ChildProcess } from "node:child_process";
import { constants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import { Readable, type Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  RpcClient,
  type RpcAgentProcess,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { RPC_GOAL_CONTINUATION_MODE } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-goal";
import { HostChannel, type HostResponse, type HostState } from "./host-protocol";
import { requireHostOwner } from "./host-owner-path";
import { inspectInstalledOmp, resolveOmpCommand } from "./installed-omp";
import type { DialogResponse, LanePresetSnapshot } from "./contracts";
import type { WorkerHostProfile } from "./worker-profile";
import { activeManagedUlw, managedUlwLaunchExtensions, MANAGED_ULW_ENV, MANAGED_ULW_FIXTURE_ENV, MANAGED_ULW_FIXTURE_ROOT_ENV, validateManagedUlwPackage } from "./managed-ulw";

const CONNECT_TIMEOUT_MS = 5_000;
const START_TIMEOUT_MS = 30_000;
const MAX_PENDING_BYTES = 16 * 1024 * 1024;
const MAX_PENDING_WRITES = 4096;

export interface HostOptions {
  command: string[];
  /** Target-owned launch policy, never decoded from an SSH request. */
  readonly worker?: WorkerHostProfile;
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

  constructor(readonly input: Readable, readonly output: Writable, readonly disconnect: (error?: Error) => void) {
    // Node and Bun publish incompatible getReader overloads for the same WHATWG stream.
    this.stdout = Readable.toWeb(input) as unknown as ReadableStream<Uint8Array>;
    const { promise, resolve } = Promise.withResolvers<number>();
    this.exited = promise;
    input.once("close", () => {
      const error = new Error(this.#error || "RPC socket disconnected; request outcome may be unknown");
      for (const reject of this.#pending) reject(error);
      resolve(this.#error ? 1 : 0);
    });
    input.on("error", error => { this.#error = error.message; });
    if (input !== (output as NodeJS.EventEmitter)) output.on("error", error => { this.#error = error.message; });
    this.stdin = { write: data => this.#write(data) };
  }

  peekStderr(): string { return this.#error; }

  // RpcClient.stop() is a detach operation for this transport, never a host signal.
  kill(): void { this.disconnect(); }

  #write(data: string | Uint8Array): Promise<void> {
    if (this.output.destroyed || !this.output.writable) {
      return Promise.reject(new Error("RPC socket is disconnected"));
    }
    const bytes = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
    if (this.output.writableLength + bytes > MAX_PENDING_BYTES || this.#pending.size >= MAX_PENDING_WRITES) {
      return Promise.reject(new Error("RPC socket write backlog exceeded its bound"));
    }
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const finish = (error?: Error | null) => {
      if (!this.#pending.delete(finish)) return;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      const error = new Error("RPC socket write timed out; request outcome may be unknown");
      finish(error);
      this.disconnect(error);
    }, CONNECT_TIMEOUT_MS);
    timer.unref();
    this.#pending.add(finish);
    try { this.output.write(data, finish); }
    catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    return promise;
  }
}

class AdapterClient extends RpcClient {
  override async getState(): Promise<HostState> {
    return await super.getState() as HostState;
  }
}

export class HostConnection {
  readonly client: AdapterClient;
  readonly exited: Promise<void>;
  readonly #listeners = new Set<(frame: HostFrame) => void>();
  readonly #channel: HostChannel;
  #close: Promise<void> | undefined;

  private constructor(transport: SocketProcess) {
    this.exited = transport.exited.then(() => {});
    this.#channel = new HostChannel(transport.input, transport.output);
    this.#channel.on("frame", frame => this.#emit(frame));
    this.client = new AdapterClient({ spawn: () => transport });
  }

  static async connect(socketPath: string, timeoutMs = CONNECT_TIMEOUT_MS): Promise<HostConnection> {
    return (await HostConnection.open(socketPath, timeoutMs)).connection;
  }

  /** Internal runtime only: incremental deltas become activity ticks, not stock session events. */
  static async connectForActivity(socketPath: string, timeoutMs = CONNECT_TIMEOUT_MS): Promise<HostConnection> {
    return (await HostConnection.#open(socketPath, timeoutMs, "activity-v1")).connection;
  }

  static async open(socketPath: string, timeoutMs = CONNECT_TIMEOUT_MS) {
    return await HostConnection.#open(socketPath, timeoutMs, "full");
  }

  /** The enrolled worker verifies the Unix endpoint on its host. Check its attestation
   * again in the native handshake on this exact SSH stream, before sending any input. */
  static async fromWorker(input: Readable, output: Writable, disconnect: () => void,
    expected: { pid: number; sessionId: string; sessionFile: string }) {
    const connection = new HostConnection(new SocketProcess(input, output, disconnect));
    const timeout = setTimeout(disconnect, CONNECT_TIMEOUT_MS);
    try {
      const state = await connection.#handshake();
      if (state.hostPid !== expected.pid || state.sessionId !== expected.sessionId || state.sessionFile !== expected.sessionFile) {
        throw new Error("Remote Host identity differs from its worker registration");
      }
      await connection.#enableActivityUpdates(state);
      return connection;
    } catch (error) {
      disconnect();
      await connection.close();
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async #handshake() {
    await this.client.start();
    const state = await this.client.getState();
    if (typeof state.sessionId !== "string" || !state.sessionId ||
        typeof state.sessionFile !== "string" || !path.isAbsolute(state.sessionFile) ||
        !Number.isSafeInteger(state.hostPid) || state.hostPid < 1 ||
        state.adapterProtocol !== "owned-stock-stdio-v1" || !Number.isSafeInteger(state.adapterOwnerPid)
        || state.adapterOwnerPid < 1) {
      throw new Error("Endpoint did not identify an owned stock-stdio adapter and persistent OMP session");
    }
    return { ...state, sessionFile: state.sessionFile };
  }

  /** Identity is captured once per fresh handshake, never reused across probes. */
  static async #open(socketPath: string, timeoutMs: number, messageUpdates: "full" | "activity-v1") {
    const before = await socketIdentity(socketPath);
    const socket = net.createConnection(socketPath);
    const transport = new SocketProcess(socket, socket, error => socket.destroy(error));
    const connection = new HostConnection(transport);
    const timeout = setTimeout(() => socket.destroy(new Error("RPC socket connection/identity probe timed out")), timeoutMs);
    timeout.unref();
    try {
      const state = await connection.#handshake();
      const after = await socketIdentity(socketPath);
      if (before.dev !== after.dev || before.ino !== after.ino) {
        throw new Error("RPC socket identity changed while connecting");
      }
      if (messageUpdates === "activity-v1") await connection.#enableActivityUpdates(state);
      return { connection, state, identity: { pid: state.hostPid, ownerPid: state.adapterOwnerPid,
        sessionId: state.sessionId, sessionFile: state.sessionFile, dev: after.dev, ino: after.ino } };
    } catch (error) {
      await connection.close();
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async #enableActivityUpdates(state: HostState): Promise<void> {
    if (typeof state.loadedSuperkitPath !== "string" || !path.isAbsolute(state.loadedSuperkitPath))
      throw new Error("Native Host has not verified its omp-superkit extension; stop and start the Host");
    const capability = await this.request({ type: "get_host_admission", messageUpdateCapability: true });
    if (!capability.success || capability.command !== "get_host_admission") {
      throw new Error("Owned Host could not report its message update capability");
    }
    // An existing owner can be reattached without changing its native filter.
    const messageUpdates = "activity-v1";
    if (capability.data?.messageUpdates !== messageUpdates) return;
    const response = await this.request({ type: "set_host_message_updates", messageUpdates });
    if (!response.success || response.command !== "set_host_message_updates" || response.data?.messageUpdates !== messageUpdates) {
      throw new Error("Owned Host did not acknowledge its advertised activity projection");
    }
  }

  /** Private adapter correlation. Stock RpcClient deliberately has no generic request API. */
  request(command: Record<string, unknown>, id?: string): Promise<HostResponse> {
    if (typeof command.type !== "string" || !command.type) throw new Error("RPC command requires a type");
    if (Object.hasOwn(command, "id")) throw new Error("Pass the persisted request id as the second argument");
    return this.#channel.request(command, id, command.type === "compact" ? 0 : 30_000).then(response => {
      if (response.type !== "response" || response.command !== command.type || typeof response.success !== "boolean"
        || !response.success && typeof response.error !== "string") throw new Error("Invalid owned Host response envelope");
      return response as HostResponse;
    });
  }

  uiResponse(id: string, response: DialogResponse): void {
    if (!id) throw new Error("UI response requires its original request id");
    this.#channel.send({ ...response, type: "extension_ui_response", id });
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
        this.#channel.removeAllListeners();
        this.#listeners.clear();
      });
    }
    return this.#close;
  }
}

export function connect(socketPath: string): Promise<HostConnection> {
  return HostConnection.connect(socketPath);
}

export async function buildHostArgs(options: HostOptions, configPath = `${options.socketPath}.config.json`,
  composition?: { extensionPaths: string[]; noExtensions: boolean }): Promise<string[]> {
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
  if (options.modelPreset) {
    // Only named lane presets need the SDK's model resolver. HEAD launches
    // (including restored model settings) must not load it just to build argv.
    const { isValidModelPresetName } = await import("@oh-my-pi/pi-coding-agent/config/model-presets");
    if (!isValidModelPresetName(options.modelPreset.name))
      throw new Error("A native model preset must have a valid name");
  }
  const managedUlwPath = selectManagedUlw(options);
  const extensions = composition?.extensionPaths ?? [
    fileURLToPath(new URL("../", import.meta.url)), managedUlwPath, options.extensionPath,
    fileURLToPath(new URL("./board-extension.ts", import.meta.url)),
    fileURLToPath(new URL("./host-extension.ts", import.meta.url)),
  ];
  return [
    "--mode", "rpc-ui",
    "--session", options.sessionFile, "--cwd", options.cwd,
    ...(options.worker?.flags ?? []),
    ...(composition?.noExtensions && !options.worker ? ["--no-extensions"] : []),
    ...extensions.flatMap(extension => ["-e", extension]),
    "--config", configPath,
  ];
}

function selectManagedUlw(options: HostOptions): string {
  if (options.worker) return validateManagedUlwPackage(options.worker.managedUlwPath);
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
  const hostOwnerExecutable = await requireHostOwner();
  const fixtureRoot = options.managedUlwRoot ?? options.env[MANAGED_ULW_FIXTURE_ROOT_ENV];
  const bun = options.env.OMP_SUPERAGENT_BUN ?? (path.basename(process.execPath) === "bun" ? process.execPath
    : Bun.which("bun", { PATH: options.env.PATH ?? process.env.PATH }));
  if (!bun || !path.isAbsolute(bun)) throw new Error("Managed Host launch requires an explicit installed Bun executable");
  options = { ...options, command: resolveOmpCommand(options.command, options.env.PATH ?? ""), managedUlwPath,
    env: { ...options.env, [MANAGED_ULW_ENV]: managedUlwPath,
    OMP_SUPERAGENT_BUN: bun,
    ...(fixture ? { [MANAGED_ULW_FIXTURE_ENV]: fixture } : {}),
    ...(fixtureRoot ? { [MANAGED_ULW_FIXTURE_ROOT_ENV]: fixtureRoot } : {}) } };
  await buildHostArgs(options);
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
  const { executable, processBackend } = await inspectInstalledOmp(options.command, [], options.env);
  options = { ...options, command: [executable, ...options.command.slice(1)] };

  const launchDirectory = await fs.mkdtemp(path.join(path.dirname(options.socketPath), ".launch-"));
  const configPath = path.join(launchDirectory, "config.json");
  let child: ChildProcess | undefined;
  let log: fs.FileHandle | undefined;
  let failure: Error | undefined;
  let cleanup: Promise<void> | undefined;
  const cleanLaunch = () => cleanup ??= fs.rm(launchDirectory, { recursive: true });
  try {
    const initialSettings = options.modelPreset?.preset ?? options.modelSettings;
    await fs.writeFile(configPath, JSON.stringify({
      ...options.worker?.config,
      task: { maxConcurrency: options.subagentConcurrency },
      goal: { continuationModes: [RPC_GOAL_CONTINUATION_MODE] },
      ...(options.modelPreset ? { modelPresets: { [options.modelPreset.name]: options.modelPreset.preset } } : {}),
      ...(initialSettings ? {
        modelRoles: {
          ...Object.fromEntries((options.clearedModelRoles ?? []).map(role => [role, null])),
          ...initialSettings.modelRoles,
        },
        ...(initialSettings.defaultThinkingLevel !== undefined
          ? { defaultThinkingLevel: initialSettings.defaultThinkingLevel } : {}),
      } : options.model ? { modelRoles: { default: options.model } } : {}),
    }), { flag: "wx", mode: 0o600 });
    log = await fs.open(options.logPath, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    const stat = await log.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
      throw new Error("Host log must be a private regular file owned by this user");
    }
    const manifestPath = path.join(launchDirectory, "owner.json");
    const extensionPaths = [fileURLToPath(new URL("../", import.meta.url)), managedUlwPath, options.extensionPath,
      fileURLToPath(new URL("./board-extension.ts", import.meta.url)),
      fileURLToPath(new URL("./host-extension.ts", import.meta.url))];
    const composition = await managedUlwLaunchExtensions({ cwd: options.cwd, managedUlwPath,
      extensionPaths, configPath, parentConfigPath: process.env.OMP_SUPERAGENT_HOST_CONFIG, commandArgs: options.command.slice(1),
      ...(options.worker ? { worker: { extensionPaths: options.worker.extensionPaths } } : {}),
      launchArgs: [...options.command.slice(1), ...await buildHostArgs(options, configPath)],
      env: options.env, bunCommand: [bun, "--no-env-file"] });
    const { env: _inheritedEnvironment, worker: _workerProfile, ...launchOptions } = options;
    const helperPath = fileURLToPath(new URL("./host-sdk-helper.ts", import.meta.url));
    const manifest = { options: launchOptions, args: await buildHostArgs(options, configPath, composition), configPath, memoryWriteDir: composition.memoryWriteDir,
      processBackend, helperPath, nativeSocket: path.join(path.dirname(options.socketPath), `.n-${crypto.randomUUID().slice(0, 8)}.sock`) };
    // Preparation used to run inside the owner; it shares the same startup budget.
    const deadline = Date.now() + START_TIMEOUT_MS;
    const prepare = Bun.spawn([bun, "--no-env-file", helperPath, "prepare"], {
      cwd: options.worker ? launchDirectory : options.cwd, env: options.env, stdin: new Blob([JSON.stringify(manifest)]), stdout: "pipe", stderr: log.fd,
      timeout: START_TIMEOUT_MS, killSignal: "SIGKILL",
    });
    const [prepared, code] = await Promise.all([new Response(prepare.stdout).text(), prepare.exited]);
    if (Date.now() >= deadline) throw new Error("Native session preparation timed out");
    if (code !== 0) throw new Error("Native session preparation failed");
    const flags = JSON.parse(prepared);
    if (typeof flags?.toolsExplicitlySelected !== "boolean" || typeof flags.noTools !== "boolean")
      throw new Error("Native session preparation did not confirm tool selection");
    await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, toolsExplicitlySelected: flags.toolsExplicitlySelected,
      noTools: flags.noTools, inventory: flags.inventory }), { flag: "wx", mode: 0o600 });
    if (Date.now() >= deadline) throw new Error("Native Host startup timed out before launch");
    child = spawn(hostOwnerExecutable, [manifestPath], {
      cwd: options.cwd, env: options.env,
      detached: true, stdio: ["ignore", log.fd, log.fd], shell: false,
    });
    child.once("error", error => { failure = error; });
    child.once("exit", (code, signal) => {
      failure = new Error(`OMP host exited during startup (${signal ?? code}); see ${options.logPath}`);
      void cleanLaunch().catch(() => {});
    });
    child.unref();
    await log.close();
    log = undefined;
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
      const { connection, identity } = await HostConnection.open(options.socketPath, Math.max(1, deadline - Date.now()));
      try {
        if (identity.dev !== startingSocket.dev || identity.ino !== startingSocket.ino) {
          throw new Error("Launched RPC socket identity changed while connecting");
        }
        if (identity.ownerPid !== child.pid) throw new Error("Endpoint does not belong to the launched pipe owner");
        if (path.resolve(identity.sessionFile) !== path.resolve(options.sessionFile)) {
          throw new Error("Launched RPC host identified a different session file");
        }
        if (failure) throw failure;
        return { pid: identity.pid };
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
      await cleanLaunch();
    }
    throw error;
  } finally { await log?.close(); }
}
