import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseSessionEntries } from "@oh-my-pi/pi-coding-agent";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { HostConnection, startHost } from "../src/host";
import { nativeDisabledProviders } from "./fixtures/native-extension";
import { nativeTestCommand } from "./fixtures/native-command";
import { offlineMnemopi } from "./fixtures/native-memory";

const nativeTest = process.env.OMP_SUPERAGENT_NATIVE_TEST === "1" ? test : test.skip;

nativeTest("stock OMP resumes a managed session by ID, respects a live native writer, and permits intentional continuation after release", async () => {
  const command = await nativeTestCommand();
  const root = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "sasa-"));
  const cwd = path.join(root, "workspace");
  const otherCwd = path.join(root, "other");
  const home = path.join(root, "home");
  const agent = path.join(root, "agent");
  for (const dir of [cwd, otherCwd, home, agent]) await fs.mkdir(dir, { mode: 0o700 });
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agent,
    PI_NO_TITLE: "1", CI: "true", NO_COLOR: "1", TMPDIR: root, TMP: root, TEMP: root,
    XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"),
    XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state"),
    PI_TEST_SESSION_OWNERS_DIR: path.join(root, "session-owners"),
    ...(process.env.OMP_TEST_NATIVES_DIR ? { PI_NATIVES_DIR: process.env.OMP_TEST_NATIVES_DIR } : {}),
  };
  const nativeConfig = path.join(agent, "config.yml");
  await fs.writeFile(nativeConfig, JSON.stringify({ ...offlineMnemopi, disabledProviders: nativeDisabledProviders,
    eval: { js: false, py: false } }));
  const options = {
    command, cwd, env, socketPath: path.join(root, "lane.sock"), sessionFile: path.join(root, "session.jsonl"),
    logPath: path.join(root, "native.log"), extensionPath: path.join(import.meta.dir, "fixtures/native-extension.ts"),
    managedUlwPath: path.join(import.meta.dir, "fixtures/managed-ulw"),
    model: "socket-host-smoke/local", subagentConcurrency: 1,
  };
  let host: { pid: number } | undefined;
  let connection: HostConnection | undefined;
  let ordinary: RpcClient | undefined;
  let succeeded = false;
  const openOrdinary = async (id: string) => {
    const client = new RpcClient({
      command, cwd: otherCwd, env, model: "socket-host-smoke/local",
      args: ["--resume", id, "--no-extensions", "-e", options.extensionPath, "--config", nativeConfig],
    });
    await client.start();
    return client;
  };
  try {
    host = await startHost(options);
    connection = await HostConnection.connect(options.socketPath);
    await connection.client.promptAndWait("Original managed lane evidence.");
    await connection.client.waitForSettled(30_000);
    const originalState = await connection.client.getState();

    expect(await connection.request({ type: "shutdown_host" })).toMatchObject({ success: true });
    await connection.exited;
    await connection.close();
    connection = undefined;
    ordinary = await openOrdinary(originalState.sessionId);
    expect((await ordinary.getState()).sessionId).toBe(originalState.sessionId);
    await ordinary.promptAndWait("Intentional operator continuation after managed release.");
    await ordinary.waitForSettled(30_000);
    expect((await ordinary.getState()).sessionId).toBe(originalState.sessionId);
    const resumedFile = (await ordinary.getState()).sessionFile!;
    expect(await fs.realpath(resumedFile)).toBe(options.sessionFile);
    expect((await fs.lstat(resumedFile)).isSymbolicLink()).toBe(true);
    await ordinary.stop();
    ordinary = undefined;

    host = await startHost(options);
    connection = await HostConnection.connect(options.socketPath);
    await connection.client.promptAndWait("Managed owner continued the operator's source.");
    await connection.client.waitForSettled(30_000);
    const before = await fs.readFile(options.sessionFile);
    ordinary = await openOrdinary(originalState.sessionId);
    await ordinary.promptAndWait("Intentional concurrent native resume.");
    await ordinary.waitForSettled(30_000);
    const continuationId = (await ordinary.getState()).sessionId;
    expect(continuationId).not.toBe(originalState.sessionId);
    expect(await fs.readFile(options.sessionFile)).toEqual(before);
    expect(await connection.client.getState()).toMatchObject({ sessionId: originalState.sessionId, hostPid: host.pid });
    await ordinary.stop();
    ordinary = undefined;
    expect(await connection.request({ type: "shutdown_host" })).toMatchObject({ success: true });
    await connection.exited;
    const released = await fs.readFile(options.sessionFile);
    ordinary = await openOrdinary(originalState.sessionId);
    // Native resume follows a previously created continuation, rather than
    // overriding the operator's choice with Superagent-specific routing.
    expect((await ordinary.getState()).sessionId).toBe(continuationId);
    expect(await fs.readFile(options.sessionFile)).toEqual(released);
    const users = parseSessionEntries(await fs.readFile(options.sessionFile, "utf8"))
      .flatMap(entry => entry.type === "message" && entry.message.role === "user" ? [JSON.stringify(entry.message.content)] : []);
    expect(users.some(text => text.includes("Original managed lane evidence."))).toBe(true);
    expect(users.some(text => text.includes("Intentional concurrent native resume."))).toBe(false);
    expect(users.some(text => text.includes("Intentional operator continuation after managed release."))).toBe(true);
    succeeded = true;
  } catch (cause) {
    const log = await fs.readFile(options.logPath, "utf8").then(text => text.slice(-12_000), () => "");
    throw new Error(`${cause instanceof Error ? cause.message : String(cause)}\nNative access artifacts: ${root}\n${ordinary?.getStderr() ?? ""}\n${log}`, { cause });
  } finally {
    await ordinary?.stop();
    await connection?.close();
    if (host) { try { process.kill(host.pid, "SIGKILL"); } catch {} }
    if (succeeded) await fs.rm(root, { recursive: true, force: true });
  }
}, 120_000);
