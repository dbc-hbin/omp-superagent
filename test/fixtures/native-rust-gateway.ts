/** Private subprocess harness for the native daemon and isolated stock OMP. */
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { hostPaths, loadConfig, parseConfig } from "../../src/config";
import type { Inbound } from "../../src/contracts";
import { gatewayCall } from "../../src/gateway-protocol";
import type { GatewayStatus } from "../../src/gateway-wire";
import { assertResidentFixtureOwner, stopHostFixtures, waitForFixtureProcessExit } from "./host-fixture-processes";
import { nativeRequestEnvelope } from "./native-request-envelope";
import { offlineMnemopi } from "./native-memory";

export type Head = { readonly pid: number; readonly ownerPid: number; readonly sessionId: string;
  readonly sessionFile: string; readonly dev: number; readonly ino: number };
type Instance = { readonly head: Head; readonly gatewayPid: number };
type ModelObservation = {
  readonly head: Head;
  readonly model: { readonly provider: string; readonly id: string } | null;
  readonly configuredDefault?: string;
  readonly thinkingLevel: { readonly present: boolean; readonly value?: string | null };
};
const packageRoot = resolve(import.meta.dir, "../..");

async function within<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  const timeout = Promise.withResolvers<never>();
  const handle = setTimeout(() => timeout.reject(new Error(label)), ms);
  try { return await Promise.race([work, timeout.promise]); }
  finally { clearTimeout(handle); }
}

export async function until<T>(check: () => T | undefined | Promise<T | undefined>, label: string): Promise<T> {
  const deadline = performance.now() + 55_000;
  for (;;) {
    const result = await check();
    if (result !== undefined) return result;
    assert(performance.now() < deadline, `Native Rust Gateway did not reach ${label}`);
    await Bun.sleep(25);
  }
}

export function gatewayFixture(root: string) {
  const runDir = join(root, "run");
  const config = join(root, "superagent.json");
  const sessionFile = join(root, "sessions", "main", "session.jsonl");
  const gatewaySocket = join(runDir, "gateway.sock");
  const hostSocket = join(runDir, "main.sock");
  const home = join(root, "home");
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, USERPROFILE: home,
    PI_CODING_AGENT_DIR: join(root, "agent"), PI_NO_TITLE: "1", CI: "true", NO_COLOR: "1",
    XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"),
    CODEX_HOME: join(root, "codex"), CLAUDE_CONFIG_DIR: join(root, "claude"), COPILOT_HOME: join(root, "copilot"),
    TMPDIR: root, TMP: root, TEMP: root,
    OMP_TEST_HOST_FIXTURE_ROOT: root, OMP_NATIVE_GATEWAY_ROOT: root, OMP_NATIVE_GATEWAY_PRESETS: "valid",
    OMP_SUPERAGENT_ROOT: packageRoot, OMP_SUPERAGENT_BUN: process.execPath,
    OMP_SUPERAGENT_TEST_MANAGED_ULW_PATH: join(import.meta.dir, "managed-ulw"),
    ...(process.env.OMP_TEST_COMMAND === undefined ? {} : { OMP_TEST_COMMAND: process.env.OMP_TEST_COMMAND }),
    ...(process.env.OMP_TEST_NATIVES_DIR ? { OMP_TEST_NATIVES_DIR: process.env.OMP_TEST_NATIVES_DIR,
      PI_NATIVES_DIR: process.env.OMP_TEST_NATIVES_DIR } : {}),
  };
  const targetDir = resolve(packageRoot, process.env.CARGO_TARGET_DIR ?? "gateway/target");
  const example = join(targetDir, "debug", "examples", "gateway-lifecycle-fixture");
  const bun = [process.execPath, "--no-env-file", "--no-install"];
  const launch = () => Bun.spawn([example, config], { cwd: root,
    env: { ...env, ISOLATED_GATEWAY_DISCORD_TOKEN: "offline-fixture-only" },
    stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  let gateway: ReturnType<typeof launch> | undefined;
  let logs: Promise<string> | undefined;

  const run = async (cmd: readonly string[], expected = 0) => {
    const child = Bun.spawn([...cmd], { cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    try {
      const [stdout, stderr, exit] = await within(Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]), 40_000, `Command timed out: ${cmd.slice(-3).join(" ")}`);
      assert.equal(exit, expected, `${stdout}${stderr}`);
      return { stdout, stderr };
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    }
  };
  const sdk = (...args: string[]) => run([...bun, import.meta.path, ...args]);
  const cli = (command: "status" | "stop", expected = 0) =>
    run([...bun, join(packageRoot, "src", "cli.ts"), command, "--config", config], expected);
  const cliStatus = async (): Promise<GatewayStatus | null> =>
    (JSON.parse((await cli("status")).stdout) as { gateway: GatewayStatus | null }).gateway;
  const snapshot = async (phase: "streaming" | "settled"): Promise<Head> =>
    JSON.parse((await sdk("snapshot", phase)).stdout);
  const observeModel = async (): Promise<ModelObservation> =>
    JSON.parse((await sdk("snapshot", "settled", "model")).stdout);
  const releaseBusy = () => writeFile(join(root, "release-207"), "", { mode: 0o600 });
  const detached = async () => (await readdir(root)).sort().flatMap(name => {
    const match = /^gateway-fixture-(runner|successor)\.(\d+)$/.exec(name);
    return match ? [{ role: match[1], pid: Number(match[2]) }] : [];
  });

  async function ready(gatewayPid: number): Promise<Instance> {
    await until(async () => {
      if (gateway?.pid === gatewayPid) assert.equal(gateway.exitCode, null, "Native daemon exited during startup");
      if (!existsSync(gatewaySocket) || (statSync(gatewaySocket).mode & 0o777) !== 0o600) return;
      const status = await gatewayCall<GatewayStatus>(gatewaySocket, "/status", undefined, { timeoutMs: 2_000 });
      if (status.gateway.pid === gatewayPid && status.head.ready && status.gateway.admissionReady) return status;
    }, "attached, preset-ready HEAD and durable intake readiness");
    const head = await snapshot("settled");
    await assertResidentFixtureOwner(root, { nativePid: head.pid, ownerPid: head.ownerPid });
    const status = await cliStatus();
    assert(status, "The operator could not see the native fixture daemon");
    assert.equal(status.gateway.pid, gatewayPid);
    assert.equal(status.gateway.admissionReady, true);
    assert.equal(status.head.ready, true);
    assert.equal(status.head.pid, head.pid);
    assert.equal(status.head.initialization?.sessionId, head.sessionId);
    assert.equal(head.sessionFile, sessionFile);
    return { head, gatewayPid };
  }

  async function start(): Promise<Instance> {
    const child = gateway = launch();
    logs = new Response(child.stderr).text();
    return ready(child.pid);
  }

  async function initialExit(): Promise<void> {
    const child = gateway;
    assert(child);
    assert.equal(await within(child.exited, 40_000, "Initial native daemon did not exit"), 0, (await logs) ?? "");
  }

  async function headExit(head: Head): Promise<void> {
    await waitForFixtureProcessExit([head.pid, head.ownerPid]);
    assert.deepEqual(JSON.parse(await readFile(`${hostSocket}.exit.json`, "utf8")), {
      pid: head.pid, ownerPid: head.ownerPid, sessionId: head.sessionId, sessionFile,
      code: 0, signal: null, persisted: true, observationsFlushed: true,
    });
  }

  async function stop({ head, gatewayPid }: Instance): Promise<void> {
    assert.equal((await cliStatus())?.gateway.pid, gatewayPid, "Operator stop must target the exact fixture Gateway");
    await cli("stop");
    if (gateway?.pid === gatewayPid) await initialExit();
    else await waitForFixtureProcessExit([gatewayPid]);
    await headExit(head);
    assert.equal(await cliStatus(), null);
    assert.equal(existsSync(hostSocket), false);
  }

  async function deliver(input: Inbound): Promise<void> {
    const temporary = join(root, "staged-input");
    const inbox = join(root, "adapter-inbox.json");
    await writeFile(temporary, JSON.stringify(input), { mode: 0o600, flag: "wx" });
    await rename(temporary, inbox);
    await until(() => !existsSync(inbox) || undefined, `adapter consumption of ${input.id}`);
  }

  async function cleanup(succeeded: boolean): Promise<void> {
    try {
      await writeFile(join(root, "stop-test-gateways"), "", { mode: 0o600 });
      await releaseBusy();
      if (gateway?.exitCode === null) {
        const child = gateway;
        try { await within(child.exited, 5_000, "Owned native daemon did not observe the cleanup marker"); }
        catch {
          child.kill("SIGKILL"); // Only the exact example child started by Bun.
          await within(child.exited, 5_000, "Owned daemon did not exit after SIGKILL");
        }
      }
      await waitForFixtureProcessExit((await detached()).map(child => child.pid));
      const diagnostics = await logs;
      if (!succeeded && diagnostics) console.error(diagnostics);
    } finally { await stopHostFixtures(root, runDir); }
  }

  return { root, home, config, sessionFile, run, sdk, cli, cliStatus, snapshot, observeModel, releaseBusy,
    ready, start, initialExit, headExit, stop, deliver, detached, cleanup };
}

async function sdkMain(): Promise<void> {
  const root = process.env.OMP_TEST_HOST_FIXTURE_ROOT;
  assert(root && root === process.cwd() && process.env.HOME === join(root, "home")
    && process.env.PI_CODING_AGENT_DIR === join(root, "agent"), "Native Gateway SDK requires its private home");
  const configPath = join(root, "superagent.json");

  switch (process.argv[2]) {
    case "prepare": {
      const [{ nativeTestCommand }, { nativeDisabledProviders }] = await Promise.all([
        import("./native-command"), import("./native-extension"),
      ]);
      const native = await nativeTestCommand();
      const headCwd = join(root, "head");
      const agent = join(root, "agent");
      for (const directory of [headCwd, agent]) {
        await mkdir(directory, { mode: 0o700 });
        await chmod(directory, 0o700);
      }
      const model = "gateway-native/local";
      const modelRoles = { default: model, judge: model };
      await writeFile(join(agent, "config.yml"), JSON.stringify({
        ...offlineMnemopi,
        disabledProviders: nativeDisabledProviders, modelRoles,
        modelPresets: Object.fromEntries(["high", "middle", "low"].map(name => [name, { modelRoles }])),
      }), { mode: 0o600 });
      await writeFile(join(agent, "models.yml"), "providers: {}\n", { mode: 0o600 });
      // Share the same normalized Config as the operator CLI and its native launch.
      const config = parseConfig({
        stateDir: root, headCwd,
        command: [...native, "-e", join(import.meta.dir, "native-extension.ts"),
          "-e", join(import.meta.dir, "gateway-provider-extension.ts")],
        maxHosts: 2, maxSubagents: 2, idleMs: 3_600_000, model,
        discord: { tokenEnv: "ISOLATED_GATEWAY_DISCORD_TOKEN", ownerId: "1", allowedGuildIds: ["3"], allowedChannelIds: ["4"] },
      }, configPath);
      await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
      await writeFile(join(root, ".native-rust-gateway"), "offline-native-rust-gateway\n", { mode: 0o600, flag: "wx" });
      break;
    }
    case "snapshot": {
      const wanted = process.argv[3];
      assert(wanted === "streaming" || wanted === "settled");
      const paths = hostPaths(await loadConfig(configPath), "main");
      const { HostConnection } = await import("../../src/host");
      const { connection, identity } = await HostConnection.open(paths.socketPath);
      const deadline = performance.now() + 10_000;
      try {
        for (;;) {
          const state = await connection.client.getState();
          const reached = wanted === "streaming" ? state.isStreaming && !state.isSettled
            : state.isSettled && !state.isStreaming && !state.isCompacting
              && !state.hasPendingAsyncWork && !state.hasOwnedRunningWork
              && state.queuedMessageCount === 0 && state.pendingUiRequests.length === 0;
          if (reached) {
            // Project only public model identity and effort, never auth, endpoint or tool data.
            console.log(JSON.stringify(process.argv[4] === "model" ? {
              head: identity, model: state.model ? { provider: state.model.provider, id: state.model.id } : null,
              configuredDefault: state.modelSettings.defaultThinkingLevel,
              thinkingLevel: { present: Object.hasOwn(state, "thinkingLevel"), value: state.thinkingLevel },
            } : identity));
            break;
          }
          assert(performance.now() < deadline, `Actual stock Host did not reach ${wanted}`);
          await Bun.sleep(25);
        }
      } finally { await connection.close(); }
      break;
    }
    case "transcript": {
      const paths = hostPaths(await loadConfig(configPath), "main");
      const { parseSessionEntries } = await import("@oh-my-pi/pi-coding-agent");
      const entries = parseSessionEntries(await readFile(paths.sessionFile, "utf8"));
      const requests = entries.flatMap(entry => {
        if (entry.type !== "message" || entry.message.role !== "user") return [];
        const content = entry.message.content;
        const text = typeof content === "string" ? content : content.filter(part => part.type === "text").map(part => part.text).join("");
        const id = nativeRequestEnvelope(text)?.requestId;
        return id ? [id] : [];
      });
      const shutdowns = entries.flatMap(entry => {
        if (entry.type !== "custom" || entry.customType !== "omp-superagent-native-test") return [];
        const data: unknown = entry.data;
        if (typeof data !== "object" || data === null || !("phase" in data) || data.phase !== "shutdown"
          || !("pid" in data) || !("sessionId" in data) || !("networkAttempts" in data)) return [];
        return [{ pid: data.pid, sessionId: data.sessionId, networkAttempts: data.networkAttempts }];
      });
      console.log(JSON.stringify({ requests, shutdowns }));
      break;
    }
    default: throw new Error("Unknown native Gateway SDK operation");
  }
}

if (import.meta.main) await sdkMain();
