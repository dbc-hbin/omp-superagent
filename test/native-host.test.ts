import { expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { watch } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseSessionEntries } from "@oh-my-pi/pi-coding-agent";
import { buildHostArgs, HostConnection, type HostFrame, type HostOptions } from "../src/host";
import { nativeDisabledProviders } from "./fixtures/native-extension";

const nativeTest = process.env.OMP_SUPERAGENT_NATIVE_TEST === "1" ? test : test.skip;
const RECORD_TYPE = "omp-superagent-native-test";
const fixturePath = path.resolve(import.meta.dir, "fixtures/native-extension.ts");
const providerFixturePath = path.resolve(import.meta.dir, "../.upstream/omp/packages/coding-agent/test/fixtures/socket-host-smoke-extension.ts");

// Real deadlines only bound external CLI/socket I/O; fake clocks cannot advance the native child.
interface HostExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface FixtureRecord {
  fixture?: string;
  phase: string;
  token: string;
  sessionId: string;
  pid: number;
  confirmed?: boolean;
  agentStarts: number;
  networkAttempts: number;
  answers?: FixtureRecord[];
}

function nativeCommand(): string[] {
  if (!process.env.OMP_TEST_COMMAND) {
    throw new Error("Native smoke requires OMP_TEST_COMMAND as an explicit patched CLI argv JSON array");
  }
  const command: unknown = JSON.parse(process.env.OMP_TEST_COMMAND);
  if (!Array.isArray(command) || !command.length || command.some(arg => typeof arg !== "string" || !arg)) {
    throw new Error("OMP_TEST_COMMAND must be a nonempty JSON array of argv strings");
  }
  return command;
}

function observe(connection: HostConnection, matches: (frame: HostFrame) => boolean) {
  const { promise, resolve, reject } = Promise.withResolvers<HostFrame>();
  void promise.catch(() => {});
  const unsubscribe = connection.onFrame(frame => {
    if (!matches(frame)) return;
    cancel();
    resolve(frame);
  });
  const timer = setTimeout(() => {
    cancel();
    reject(new Error("Native host did not emit the expected RPC frame"));
  }, 10_000);
  const cancel = () => { clearTimeout(timer); unsubscribe(); };
  return { promise, cancel };
}

function notification(frame: HostFrame): FixtureRecord | undefined {
  if (frame.type !== "extension_ui_request" || frame.method !== "notify" || typeof frame.message !== "string") return;
  let data: unknown;
  try { data = JSON.parse(frame.message); } catch { return; }
  if (typeof data === "object" && data !== null && "fixture" in data && data.fixture === RECORD_TYPE) {
    return data as FixtureRecord;
  }
}

async function checkpoint(connection: HostConnection, token: string, id: string): Promise<FixtureRecord> {
  const event = observe(connection, frame => notification(frame)?.token === token);
  const completion = observe(connection, frame => frame.type === "prompt_result" && frame.id === id);
  try {
    const response = await connection.request({ type: "prompt", message: `/fixture-state ${token}` }, id);
    expect(response).toMatchObject({ id, command: "prompt", success: true });
    expect(await completion.promise).toMatchObject({ id, status: "completed", agentInvoked: false, sessionSettled: true });
    return notification(await event.promise)!;
  } finally { event.cancel(); completion.cancel(); }
}

async function startup(socketPath: string, child: ChildProcess, exited: Promise<HostExit>): Promise<HostConnection> {
  const deadline = Date.now() + 45_000;
  let change = Promise.withResolvers<void>();
  const failure = Promise.withResolvers<never>();
  const watcher = watch(path.dirname(socketPath), () => change.resolve());
  watcher.on("error", failure.reject);
  const timeout = setTimeout(() => failure.reject(new Error("Native OMP did not create its private RPC socket before the startup deadline")), 45_000);
  const earlyExit = exited.then(() => { throw new Error("Native OMP exited before RPC readiness"); });
  void earlyExit.catch(() => {});
  void failure.promise.catch(() => {});
  try {
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error("Native OMP exited before RPC readiness");
      try {
        const stat = await fs.lstat(socketPath);
        if ((stat.mode & 0o777) === 0o600) {
          return await HostConnection.connect(socketPath, Math.max(1, deadline - Date.now()));
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await Promise.race([change.promise, earlyExit, failure.promise]);
      change = Promise.withResolvers<void>();
    }
    throw new Error("Native OMP startup exceeded its deadline");
  } finally { clearTimeout(timeout); watcher.close(); }
}

nativeTest("actual OMP keeps one persistent host across controller detach, pending approval, and graceful shutdown", async () => {
  const command = nativeCommand();
  const nativesDirectory = process.env.OMP_TEST_NATIVES_DIR;
  if (nativesDirectory && !path.isAbsolute(nativesDirectory)) {
    throw new Error("OMP_TEST_NATIVES_DIR must be an explicit absolute native-cache path");
  }
  const root = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "osn-"));
  await fs.chmod(root, 0o700);
  const home = path.join(root, "home");
  const agentDirectory = path.join(root, "agent");
  const cwd = path.join(root, "workspace");
  for (const directory of [home, agentDirectory, cwd]) await fs.mkdir(directory, { mode: 0o700 });
  const configPath = path.join(root, "config.json");
  await fs.writeFile(configPath, JSON.stringify({ task: { maxConcurrency: 1 }, disabledProviders: nativeDisabledProviders }), { mode: 0o600 });
  const options: HostOptions = {
    command: [...command, "-e", providerFixturePath],
    socketPath: path.join(root, "host.sock"), sessionFile: path.join(root, "main.jsonl"),
    cwd, extensionPath: fixturePath, env: {}, logPath: path.join(root, "native.log"),
    managedUlwPath: path.resolve(import.meta.dir, "fixtures/managed-ulw"),
    model: "socket-host-smoke/local", subagentConcurrency: 1,
  };
  const log = await fs.open(options.logPath, "wx", 0o600);
  let child: ChildProcess | undefined;
  let succeeded = false;
  const connections = new Set<HostConnection>();
  const exit = Promise.withResolvers<HostExit>();
  // Attach before spawning so an early process error is never an unhandled rejection.
  void exit.promise.catch(() => {});
  try {
    child = spawn(options.command[0]!, [...options.command.slice(1), ...buildHostArgs(options, configPath)], {
      cwd, detached: true, shell: false, stdio: ["ignore", log.fd, log.fd],
      // Whitelist instead of inheriting provider credentials, profiles, config overlays, or account agents.
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, USERPROFILE: home,
        PI_CODING_AGENT_DIR: agentDirectory, PI_NO_TITLE: "1", CI: "true", NO_COLOR: "1",
        ...(nativesDirectory ? { PI_NATIVES_DIR: nativesDirectory } : {}),
        XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"),
        XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state"),
        TMPDIR: root, TMP: root, TEMP: root,
      },
    });
    child.once("error", exit.reject);
    child.once("exit", (code, signal) => exit.resolve({ code, signal }));
    const first = await startup(options.socketPath, child, exit.promise);
    connections.add(first);
    const initial = await first.client.getState();
    expect(initial.hostPid).toBe(child.pid);
    expect(initial.sessionFile).toBe(options.sessionFile);
    expect(initial.model).toMatchObject({ provider: "socket-host-smoke", id: "local" });
    const before = await checkpoint(first, "before-detach", "native-checkpoint-before");
    expect(before).toMatchObject({ sessionId: initial.sessionId, pid: child.pid, agentStarts: 0, networkAttempts: 0, answers: [] });

    const approval = observe(first, frame => frame.type === "extension_ui_request" && frame.method === "confirm" && frame.message === "original-approval-token");
    let dialog: HostFrame;
    try {
      const accepted = await first.request({ type: "prompt", message: "/fixture-ask original-approval-token" }, "native-persisted-approval");
      expect(accepted).toMatchObject({ id: "native-persisted-approval", success: true });
      dialog = await approval.promise;
    } finally { approval.cancel(); }
    expect(typeof dialog.id).toBe("string");
    const deniedShutdown = await first.request({ type: "shutdown_host" }, "native-refused-shutdown");
    expect(deniedShutdown).toMatchObject({ command: "shutdown_host", success: false, code: "session_busy" });
    expect((await first.client.getState()).pendingUiRequests).toContainEqual(expect.objectContaining({ id: dialog.id, method: "confirm" }));

    await first.close();
    await first.exited;
    process.kill(child.pid!, 0);
    const second = await HostConnection.connect(options.socketPath);
    connections.add(second);
    const reattached = await second.client.getState();
    expect(reattached).toMatchObject({ sessionId: initial.sessionId, sessionFile: options.sessionFile, hostPid: child.pid });
    expect(reattached.pendingUiRequests).toContainEqual(expect.objectContaining({ id: dialog.id, message: "original-approval-token" }));
    expect(await second.request({ type: "shutdown_host" }, "native-still-refused-shutdown")).toMatchObject({ success: false, code: "session_busy" });

    const answer = observe(second, frame => notification(frame)?.phase === "answer");
    try {
      second.uiResponse(dialog.id as string, { confirmed: true });
      expect(notification(await answer.promise)).toMatchObject({ phase: "answer", token: "original-approval-token", confirmed: true, sessionId: initial.sessionId, pid: child.pid });
    } finally { answer.cancel(); }
    // Late answers from another surface must not run the handler a second time.
    second.uiResponse(dialog.id as string, { confirmed: false });
    const after = await checkpoint(second, "after-answer", "native-checkpoint-after");
    expect(after.answers).toHaveLength(1);
    expect(after.answers?.[0]).toMatchObject({ token: "original-approval-token", confirmed: true });
    expect(after).toMatchObject({ agentStarts: 0, networkAttempts: 0 });
    const finalState = await second.client.getState();
    expect(finalState).toMatchObject({ sessionId: initial.sessionId, hostPid: child.pid, pendingUiRequests: [], isSettled: true, hasPendingAsyncWork: false, queuedMessageCount: 0 });

    await second.client.shutdownHost();
    await second.exited;
    const shutdownTimeout = setTimeout(() => { child?.kill("SIGKILL"); }, 10_000);
    try { expect(await exit.promise).toEqual({ code: 0, signal: null }); }
    finally { clearTimeout(shutdownTimeout); }
    expect((await fs.stat(options.sessionFile)).size).toBeGreaterThan(0);
    const entries = parseSessionEntries(await fs.readFile(options.sessionFile, "utf8"));
    expect(entries[0]).toMatchObject({ type: "session", id: initial.sessionId });
    const header = entries.find(entry => entry.type === "session");
    expect(await fs.realpath(header!.cwd)).toBe(await fs.realpath(cwd));
    const records = entries.filter(entry => entry.type === "custom" && entry.customType === RECORD_TYPE)
      .map(entry => (entry as { data: FixtureRecord }).data);
    expect(records.map(record => record.phase)).toEqual(["checkpoint", "answer", "checkpoint", "shutdown"]);
    expect(records.filter(record => record.phase === "answer")).toEqual([expect.objectContaining({ confirmed: true, token: "original-approval-token" })]);
    expect(records.every(record => record.sessionId === initial.sessionId && record.pid === child!.pid && record.agentStarts === 0 && record.networkAttempts === 0)).toBe(true);
    await expect(fs.lstat(options.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
    succeeded = true;
  } catch (cause) {
    const tail = await fs.readFile(options.logPath, "utf8").then(text => text.slice(-16_384), () => "<native log unavailable>");
    throw new Error(`${cause instanceof Error ? cause.message : String(cause)}\nNative artifacts retained: ${root}\nNative log tail:\n${tail}`, { cause });
  } finally {
    for (const connection of connections) await connection.close();
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exit.promise.catch(() => {});
    }
    await log.close();
    if (succeeded) await fs.rm(root, { recursive: true, force: true });
  }
}, 90_000);
