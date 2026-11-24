import { Database } from "bun:sqlite";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type Config } from "../../src/config";
import type { GatewayRestartRecord, Inbound, Route } from "../../src/contracts";
import type { DownloadMessenger as Messenger } from "./inbound-attachments";
import { startGateway, type GatewayOptions } from "../oracles/bun-gateway/gateway";
import { gatewayCall, gatewayPaths } from "../../src/gateway-protocol";
import { processAlive, type RestartPlan } from "../oracles/bun-gateway/gateway-restart";
import type { GatewayStatus } from "../../src/gateway-wire";
import { stopHostFixtures } from "./host-fixture-processes";
import { writeStockHostExecutable } from "./stock-host";
import { offlineMnemopi } from "./native-memory";

// Match the actual operation windows (host owner exit, restart preparation,
// Gateway wire, and the detached launch receipt), not a global test timeout.
export const STARTUP_MS = 45_000;
export const RPC_MS = 30_000;
export const LIFECYCLE_PHASE_MS = 15_000;
const fixtureProcess = fileURLToPath(new URL("./gateway-lifecycle-process.ts", import.meta.url));
const managedUlwPath = fileURLToPath(new URL("./managed-ulw", import.meta.url));
export const route: Route = { platform: "discord", accountId: "1", authorityId: "2", guildId: null, channelId: "3", threadId: null };
export const token = "isolated-test-secret";
export const cleanups: Array<() => Promise<void>> = [];

export async function until<T>(label: string, timeoutMs: number, probe: () => T | false | null | undefined | Promise<T | false | null | undefined>): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    const left = deadline - performance.now();
    if (left <= 0) throw new Error(`Timed out waiting for ${label} (${timeoutMs} ms)`);
    await Bun.sleep(Math.min(left, 25));
  }
}

export function metadata<T>(root: string, key: string): T | null {
  const db = new Database(join(root, "coordination.sqlite"), { readonly: true });
  try {
    // The successor may be writing or closing the WAL during a receipt probe.
    db.run("PRAGMA busy_timeout = 5000");
    const row = db.query<{ value: string }, [string]>("SELECT value FROM metadata WHERE key=?").get(key);
    return row ? JSON.parse(row.value) : null;
  } finally { db.close(); }
}

export async function waitStatus(config: Config, label: string, timeoutMs: number,
  check: (status: GatewayStatus | null) => boolean | Promise<boolean>): Promise<GatewayStatus> {
  const { socketPath } = gatewayPaths(config);
  const deadline = AbortSignal.timeout(timeoutMs);
  let last: GatewayStatus | undefined;
  let lastError: unknown;
  try {
    return await until(label, timeoutMs, async () => {
      let current: GatewayStatus | null = null;
      if (existsSync(socketPath)) {
        try {
          current = await gatewayCall<GatewayStatus>(socketPath, "/status", undefined,
            { signal: AbortSignal.any([deadline, AbortSignal.timeout(5_000)]) });
          last = current;
        } catch (error) { lastError = error; }
      }
      return await check(current) && current;
    });
  } catch (cause) {
    throw new Error(`${String(cause)}; last status: ${JSON.stringify(last)}; last IPC error: ${String(lastError)}`, { cause });
  }
}

export async function configFixture() {
  const root = await mkdtemp(join(await realpath("/tmp"), "ogl-"));
  let beforeRemoval: (() => Promise<void>) | undefined;
  cleanups.push(async () => {
    try {
      try { await beforeRemoval?.(); }
      finally {
        const launches = await stopHostFixtures(root, join(root, "run"));
        if (beforeRemoval && !launches) throw new Error("Gateway started without a Host fixture identity");
      }
    }
    catch (cause) { throw new Error(`Could not close fixture; retained ${root}`, { cause }); }
    await rm(root, { recursive: true, force: true });
  });
  await chmod(root, 0o700);
  const home = join(root, "home");
  const agent = join(root, "agent");
  await mkdir(home, { mode: 0o700 });
  await mkdir(agent, { mode: 0o700 });
  await writeFile(join(agent, "config.yml"), JSON.stringify(offlineMnemopi), { mode: 0o600 });
  const headEnvironment = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, USERPROFILE: home,
    PI_CODING_AGENT_DIR: agent, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"),
    XDG_STATE_HOME: join(home, "state"), XDG_CACHE_HOME: join(home, "cache"),
    ...(process.env.PI_NATIVES_DIR ? { PI_NATIVES_DIR: process.env.PI_NATIVES_DIR } : {}),
  };
  const path = join(root, "config.json");
  const executable = join(root, "omp.ts");
  await writeStockHostExecutable(executable, `
import ${JSON.stringify(fileURLToPath(new URL("./gateway-host.ts", import.meta.url)))};
`);
  await writeFile(path, JSON.stringify({ stateDir: root, headCwd: root, maxHosts: 2, maxSubagents: 4, idleMs: 1000,
    command: [executable], model: "provider/initial-model",
    discord: { tokenEnv: "GATEWAY_TEST_BOT_TOKEN", ownerId: "2", allowedGuildIds: [], allowedChannelIds: [] } }));
  await writeFile(`${path}.env`, `GATEWAY_TEST_BOT_TOKEN=${token}\n`, { mode: 0o600 });
  return { root, headEnvironment, config: await loadConfig(path),
    beforeRemoval: (cleanup: () => Promise<void>) => { beforeRemoval = cleanup; } };
}

export async function withFixtureToken<T>(work: () => Promise<T>): Promise<T> {
  const saved = process.env.GATEWAY_TEST_BOT_TOKEN;
  process.env.GATEWAY_TEST_BOT_TOKEN = token;
  try { return await work(); }
  finally {
    if (saved === undefined) delete process.env.GATEWAY_TEST_BOT_TOKEN;
    else process.env.GATEWAY_TEST_BOT_TOKEN = saved;
  }
}

export async function fixture(options: Pick<GatewayOptions, "updateManagedUlw" | "launchRestartRunner"> = {},
  prepared?: Awaited<ReturnType<typeof configFixture>>) {
  const f = prepared ?? await configFixture();
  let handlers: Parameters<Messenger["start"]>[0] | undefined;
  let stopped = false;
  const messenger: Messenger = {
    async start(value) { handlers = value; }, async stop() { stopped = true; },
    async send() { return "remote"; }, async showApproval() { return "approval"; }, async dismissApproval() {},
    async createThread(destination) { return destination; }, async fetchAfter() { return null; },
    async openAttachment() { return new Response("fixture"); },
  };
  const errors: unknown[] = [];
  const starting = withFixtureToken(() => startGateway(f.config, { messenger, managedUlwPath, headEnvironment: f.headEnvironment,
    onError: error => errors.push(error), ...options }));
  f.beforeRemoval(async () => {
    // Stop supervision before the fixture cleanup runs, even if readiness or
    // an assertion failed. Ambiguous shutdown must not retry native RPC.
    const service = await starting;
    try {
      if (!existsSync(join(f.root, "ambiguous-shutdown"))) {
        for (const mode of ["busy", "busy-shutdown"]) await rm(join(f.root, mode), { force: true });
        await service.stop();
      }
    } finally { await service.close(); }
  });
  const service = await starting;
  await until("fixture HEAD readiness", RPC_MS, () => service.status().head.ready);
  return { ...f, service, errors, get stopped() { return stopped; },
    async emit(input: Inbound) {
      if (!handlers) throw new Error("Fixture messenger was not started");
      await handlers.ready;
      await handlers.message(input);
    } };
}

export async function detachedFixture() {
  const f = await configFixture();
  const child: ChildProcess = spawn(process.execPath, ["--no-env-file", fixtureProcess, "--config", f.config.path],
    { cwd: f.root, env: f.headEnvironment, stdio: ["ignore", "ignore", "ignore"] });
  let outcome: string | undefined;
  child.once("error", error => { outcome = String(error); });
  child.once("exit", (code, sig) => { outcome = `exit ${code ?? sig}`; });
  const checkIngress = () => {
    const failure = join(f.root, "ingress-failure.jsonl");
    if (existsSync(failure)) throw new Error(`Detached fixture intake failed: ${readFileSync(failure, "utf8")}`);
  };
  f.beforeRemoval(async () => {
    // Each owned subprocess closes its own service on this signal; only use
    // recorded PIDs to observe exit, never to signal on a stale identity.
    await writeFile(join(f.root, "cleanup"), "");
    await until("original Gateway process exit", STARTUP_MS + LIFECYCLE_PHASE_MS, () => outcome !== undefined);
    if (existsSync(join(f.root, "coordination.sqlite"))) {
      const key = metadata<GatewayRestartRecord>(f.root, "gateway:restart")?.requestId;
      await until("detached handoff processes to finish cleanup", RPC_MS + LIFECYCLE_PHASE_MS, () => {
        const plan = key ? metadata<RestartPlan>(f.root, `gateway:restart-plan:${key}`) : null;
        return [plan?.runnerPid, plan?.launchPid].every(pid => !pid || !processAlive(pid));
      });
    }
    checkIngress();
    if (outcome !== "exit 0") throw new Error(`Original Gateway ${outcome}; retained ${f.root}`);
  });
  return { ...f, childExited: () => outcome, checkIngress };
}
