import { expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { spawn, type ChildProcess } from "node:child_process";
import { watch } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { buildHostArgs, HostConnection, type HostOptions } from "../src/host";
import { nativeDisabledProviders } from "./fixtures/native-extension";

const nativeTest = process.env.OMP_SUPERAGENT_NATIVE_TEST === "1" ? test : test.skip;
const providerFixture = path.resolve(import.meta.dir, "../.upstream/omp/packages/coding-agent/test/fixtures/socket-host-smoke-extension.ts");
const reply = "Socket host smoke response";

// This relay supplies a real controlling terminal, not a second RPC client or a fake renderer.
const pythonPTY = String.raw`
import errno, fcntl, json, os, pty, select, signal, struct, sys, termios
argv = json.loads(sys.argv[1])
pid, master = pty.fork()
if pid == 0:
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 160, 0, 0))
    os.execvpe(argv[0], argv, os.environ)

def terminate(_signal, _frame):
    try: os.kill(pid, signal.SIGKILL)
    except ProcessLookupError: pass
    os._exit(143)

signal.signal(signal.SIGTERM, terminate)
probe = b""
try:
    while True:
        ready, _, _ = select.select([master, sys.stdin.fileno()], [], [])
        if master in ready:
            try: data = os.read(master, 65536)
            except OSError as error:
                if error.errno == errno.EIO: break
                raise
            if not data: break
            os.write(sys.stdout.fileno(), data)
            # Only terminal capability replies; all UI and transcript bytes come from actual OMP.
            probe = (probe + data)[-8192:]
            for query, response in [
                (b"\x1b[6n", b"\x1b[1;1R"),
                (b"\x1b]11;?\x07", b"\x1b]11;rgb:0000/0000/0000\x07"),
                (b"\x1b]11;?\x1b\\", b"\x1b]11;rgb:0000/0000/0000\x1b\\"),
            ]:
                while query in probe:
                    os.write(master, response)
                    probe = probe.replace(query, b"", 1)
        if sys.stdin.fileno() in ready:
            data = os.read(sys.stdin.fileno(), 65536)
            if not data: break
            os.write(master, data)
    _, status = os.waitpid(pid, 0)
    pid = 0
    code = os.waitstatus_to_exitcode(status)
finally:
    os.close(master)
    if pid:
        try: os.kill(pid, signal.SIGKILL)
        except ProcessLookupError: pass
        os.waitpid(pid, 0)
sys.exit(code if code >= 0 else 128 - code)
`;

// These are external-process I/O deadlines, not sleeps guessing when rendering has completed.
async function within<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(() => timeout.reject(new Error(message)), timeoutMs);
  try { return await Promise.race([promise, timeout.promise]); }
  finally { clearTimeout(timer); }
}

function terminalText(raw: string): string {
  return raw.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1bP[\s\S]*?\x1b\\/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "");
}

interface PTYSession {
  process: Subprocess<"pipe", "pipe", "pipe">;
  stderr: Promise<string>;
  pump: Promise<void>;
  rendered(text: string): Promise<void>;
  transcript(): string;
}

function attachPTY(command: string[], cwd: string, env: Record<string, string>): PTYSession {
  const process = Bun.spawn(["python3", "-u", "-c", pythonPTY, JSON.stringify(command)], {
    cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const stderr = new Response(process.stderr).text();
  let raw = "";
  let ended = false;
  const waiting = new Set<{ text: string; resolve: () => void; reject: (error: Error) => void }>();
  const pump = (async () => {
    const decoder = new TextDecoder();
    const reader = process.stdout.getReader();
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        raw = (raw + decoder.decode(result.value, { stream: true })).slice(-4 * 1024 * 1024);
        if (!waiting.size) continue;
        const rendered = terminalText(raw);
        for (const waiter of waiting) {
          if (!rendered.includes(waiter.text)) continue;
          waiting.delete(waiter);
          waiter.resolve();
        }
      }
    } finally {
      ended = true;
      reader.releaseLock();
      for (const waiter of waiting) waiter.reject(new Error("Native attach closed before rendering expected content"));
      waiting.clear();
    }
  })();
  void pump.catch(() => {});
  return {
    process, stderr, pump,
    transcript: () => raw,
    async rendered(text: string): Promise<void> {
      if (terminalText(raw).includes(text)) return;
      if (ended) throw new Error("Native attach already exited without expected content");
      const pending = Promise.withResolvers<void>();
      const waiter = { text, resolve: pending.resolve, reject: pending.reject };
      waiting.add(waiter);
      try { await within(pending.promise, 30_000, `Actual OMP TUI did not render: ${text}`); }
      finally { waiting.delete(waiter); }
    },
  };
}

async function readyHost(socketPath: string, child: ChildProcess, exited: Promise<unknown>): Promise<HostConnection> {
  let changed = Promise.withResolvers<void>();
  const watcher = watch(path.dirname(socketPath), () => changed.resolve());
  const failed = Promise.withResolvers<never>();
  watcher.on("error", failed.reject);
  const deadline = Date.now() + 45_000;
  const earlyExit = exited.then(() => { throw new Error("Actual OMP host exited before readiness"); });
  void earlyExit.catch(() => {});
  void failed.promise.catch(() => {});
  try {
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error("Actual OMP host exited during startup");
      try {
        const stat = await fs.lstat(socketPath);
        if ((stat.mode & 0o777) === 0o600) return await HostConnection.connect(socketPath, Math.max(1, deadline - Date.now()));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await within(Promise.race([changed.promise, failed.promise, earlyExit]), Math.max(1, deadline - Date.now()), "Actual OMP host socket was not ready");
      changed = Promise.withResolvers<void>();
    }
    throw new Error("Actual OMP host startup exceeded its deadline");
  } finally { watcher.close(); }
}

async function nativePrompt(connection: HostConnection, id: string, message: string): Promise<void> {
  const completion = Promise.withResolvers<void>();
  const unsubscribe = connection.client.onPromptResult(frame => {
    if (frame.id !== id) return;
    if (frame.status !== "completed" || !frame.agentInvoked) {
      completion.reject(new Error(`Native fixture model did not complete ${id}`));
    } else completion.resolve();
  });
  void completion.promise.catch(() => {});
  try {
    expect(await connection.request({ type: "prompt", message }, id)).toMatchObject({ id, success: true });
    await within(completion.promise, 10_000, "Local fixture model did not finish");
    expect(await connection.client.getLastAssistantText()).toBe(reply);
  } finally { unsubscribe(); }
}

nativeTest("actual native TUI observes and controls the same RPC host without stopping it on detach", async () => {
  const parsed: unknown = JSON.parse(process.env.OMP_TEST_COMMAND ?? "null");
  if (!Array.isArray(parsed) || !parsed.length || parsed.some(arg => typeof arg !== "string" || !arg)) {
    throw new Error("Native TUI smoke requires OMP_TEST_COMMAND as patched CLI argv JSON");
  }
  const command: string[] = parsed;
  const natives = process.env.OMP_TEST_NATIVES_DIR;
  if (natives && !path.isAbsolute(natives)) throw new Error("OMP_TEST_NATIVES_DIR must be absolute");
  const root = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "ost-"));
  await fs.chmod(root, 0o700);
  const home = path.join(root, "home");
  const agent = path.join(root, "agent");
  const cwd = path.join(root, "workspace");
  for (const directory of [home, agent, cwd]) await fs.mkdir(directory, { mode: 0o700 });
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, USERPROFILE: home,
    PI_CODING_AGENT_DIR: agent, PI_NO_TITLE: "1", CI: "true", TERM: "xterm-256color", COLORTERM: "truecolor",
    XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"),
    XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state"),
    TMPDIR: root, TMP: root, TEMP: root, ...(natives ? { PI_NATIVES_DIR: natives } : {}),
  };
  const options: HostOptions = {
    command,
    socketPath: path.join(root, "host.sock"), sessionFile: path.join(root, "session.jsonl"),
    cwd, extensionPath: providerFixture, env, logPath: path.join(root, "host.log"),
    managedUlwPath: path.resolve(import.meta.dir, "fixtures/managed-ulw"),
    model: "socket-host-smoke/local", subagentConcurrency: 1,
  };
  const config = path.join(root, "config.json");
  await fs.writeFile(config, JSON.stringify({ task: { maxConcurrency: 1 }, disabledProviders: nativeDisabledProviders }), { mode: 0o600 });
  const log = await fs.open(options.logPath, "wx", 0o600);
  const exit = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
  void exit.promise.catch(() => {});
  let child: ChildProcess | undefined;
  let connection: HostConnection | undefined;
  let terminal: PTYSession | undefined;
  let succeeded = false;
  try {
    child = spawn(options.command[0]!, [...options.command.slice(1), ...buildHostArgs(options, config)], {
      cwd, env, detached: true, shell: false, stdio: ["ignore", log.fd, log.fd],
    });
    child.once("error", exit.reject);
    child.once("exit", (code, signal) => exit.resolve({ code, signal }));
    connection = await readyHost(options.socketPath, child, exit.promise);
    const initial = await connection.client.getState();
    expect(initial).toMatchObject({ sessionFile: options.sessionFile, hostPid: child.pid });
    expect(initial.model).toMatchObject({ provider: "socket-host-smoke", id: "local" });
    await nativePrompt(connection, "native-tui-first", "Render the first local fixture response");
    const beforeAttach = await connection.client.getState();

    terminal = attachPTY([...command, "attach", options.socketPath, "--read-only"], cwd, { ...env, PI_CONFIG_FILES: config });
    await terminal.rendered(reply);
    await terminal.rendered("read-only");
    terminal.process.stdin.write("PTY_READ_ONLY_MUST_NOT_BECOME_PROMPT\r");
    await terminal.process.stdin.flush();
    await terminal.rendered("This collab link is read-only");
    expect((await connection.client.getState()).messageCount).toBe(beforeAttach.messageCount);
    expect(JSON.stringify(await connection.client.getMessages())).not.toContain("PTY_READ_ONLY_MUST_NOT_BECOME_PROMPT");

    terminal.process.stdin.write("\x15/leave\r");
    await terminal.process.stdin.flush();
    expect(await within(terminal.process.exited, 10_000, "Native /leave did not detach the PTY")).toBe(0);
    await terminal.pump;
    process.kill(child.pid!, 0);
    expect(await connection.client.getState()).toMatchObject({ sessionId: initial.sessionId, sessionFile: options.sessionFile, hostPid: child.pid });
    await nativePrompt(connection, "native-tui-after-detach", "Produce another local fixture response after native TUI detach");
    expect((await connection.client.getState()).messageCount).toBeGreaterThan(beforeAttach.messageCount);

    const beforeEditable = await connection.client.getState();
    terminal = attachPTY([...command, "attach", options.socketPath], cwd, { ...env, PI_CONFIG_FILES: config });
    await terminal.rendered(reply);
    const editableInput = "NATIVE_TUI_EDITABLE_LOCAL_PROMPT";
    const editableReply = "Socket host editable response";
    const settled = Promise.withResolvers<void>();
    const unsubscribe = connection.client.onSessionSettled(settled.resolve);
    try {
      terminal.process.stdin.write(`${editableInput}\r`);
      await terminal.process.stdin.flush();
      await terminal.rendered(editableReply);
      await within(settled.promise, 10_000, "TUI-submitted local model turn did not settle");
    } finally { unsubscribe(); }
    const messages = await connection.client.getMessages();
    // Native Collab deliberately records attributed guest input as a collab-prompt custom message.
    expect(messages.at(-2)).toMatchObject({
      role: "custom", customType: "collab-prompt", content: editableInput, attribution: "user",
    });
    expect(messages.at(-1)).toMatchObject({ role: "assistant", content: [{ type: "text", text: editableReply }] });
    expect(await connection.client.getLastAssistantText()).toBe(editableReply);
    expect(await connection.client.getState()).toMatchObject({
      sessionId: initial.sessionId, sessionFile: options.sessionFile, hostPid: child.pid,
      messageCount: beforeEditable.messageCount + 2, isSettled: true,
    });
    terminal.process.stdin.write("\x15/leave\r");
    await terminal.process.stdin.flush();
    expect(await within(terminal.process.exited, 10_000, "Editable native /leave did not detach the PTY")).toBe(0);
    await terminal.pump;
    process.kill(child.pid!, 0);
    expect(await connection.client.getState()).toMatchObject({ sessionId: initial.sessionId, hostPid: child.pid });

    await connection.client.shutdownHost();
    await connection.exited;
    expect(await within(exit.promise, 10_000, "Actual RPC host did not shut down cleanly")).toEqual({ code: 0, signal: null });
    expect((await fs.stat(options.sessionFile)).size).toBeGreaterThan(0);
    succeeded = true;
  } catch (cause) {
    if (terminal) await fs.writeFile(path.join(root, "tui.raw"), terminal.transcript(), { mode: 0o600 });
    const tail = await fs.readFile(options.logPath, "utf8").then(text => text.slice(-16_384), () => "<native log unavailable>");
    throw new Error(`${cause instanceof Error ? cause.message : String(cause)}\nNative PTY artifacts retained: ${root}\nNative host log tail:\n${tail}`, { cause });
  } finally {
    if (terminal) {
      if (terminal.process.exitCode === null) terminal.process.kill("SIGTERM");
      try { await within(terminal.process.exited, 5_000, "Python PTY relay did not terminate"); }
      catch { terminal.process.kill("SIGKILL"); await terminal.process.exited; }
      await terminal.pump.catch(() => {});
      const stderr = await terminal.stderr;
      if (!succeeded) await fs.writeFile(path.join(root, "tui.stderr"), stderr, { mode: 0o600 });
    }
    await connection?.close();
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exit.promise.catch(() => {});
    }
    await log.close();
    if (succeeded) await fs.rm(root, { recursive: true, force: true });
  }
}, 120_000);
