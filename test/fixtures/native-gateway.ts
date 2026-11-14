import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseSessionEntries, type FileEntry } from "@oh-my-pi/pi-coding-agent";
import { type Config, hostPaths, privateDirectory } from "../../src/config";
import type { Approval, Inbound, Lane, MessageActivity, Messenger, OutputRecord, Route } from "../../src/contracts";
import { startGateway, gatewayPaths, type GatewayService, type GatewayStatus } from "../../src/gateway";
import { HostConnection } from "../../src/host";
import { nativeDisabledProviders } from "./native-extension";
import { runNativeUlwProof } from "./native-ulw-proof";
import { nativeRequestEnvelope } from "./native-request-envelope";

type Handlers = Parameters<Messenger["start"]>[0];
const interrupted = new AbortController();
let detectNativeFailure: (() => Promise<void>) | undefined;
class RecordingMessenger implements Messenger {
  readonly sent: OutputRecord[] = [];
  readonly activities: Array<{ message: Pick<Inbound, "route" | "messageId">; activity: MessageActivity }> = [];
  handlers?: Handlers;
  async start(handlers: Handlers): Promise<void> { this.handlers = handlers; }
  async deliver(input: Inbound): Promise<void> {
    assert(this.handlers, "Actual Gateway messenger is not receiving");
    await this.handlers.message(input);
  }
  async send(output: OutputRecord): Promise<string> {
    this.sent.push(structuredClone(output));
    return `gateway-native-receipt:${output.id}`;
  }
  async setActivity(message: Pick<Inbound, "route" | "messageId">, activity: MessageActivity): Promise<void> {
    this.activities.push({ message: { route: structuredClone(message.route), messageId: message.messageId }, activity });
  }
  async showApproval(_approval: Approval): Promise<string> { throw new Error("Unexpected native Gateway approval"); }
  async dismissApproval(_approval: Approval): Promise<void> { throw new Error("Unexpected native Gateway approval dismissal"); }
  async createThread(_route: Route, _title: string): Promise<Route> { throw new Error("The original independent topic already exists"); }
  async fetchAfter(): Promise<Inbound[]> { return []; }
  async openAttachment(): Promise<Response> { throw new Error("No attachments are authorized by this proof"); }
  async stop(): Promise<void> { this.handlers = undefined; }
}

async function until(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (!await predicate()) {
    interrupted.signal.throwIfAborted();
    await detectNativeFailure?.();
    if (Date.now() >= deadline) throw new Error(`Native Gateway did not reach ${label}`);
    const drain = Promise.withResolvers<void>();
    setImmediate(drain.resolve);
    await drain.promise;
  }
}

async function within<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  // These deadlines bound real native RPC/process failure, never guessed waits
  // for an assertion. A separate OMP process cannot share fake test timers.
  const expired = Promise.withResolvers<never>();
  const timer = setTimeout(() => expired.reject(new Error(label)), ms);
  try { return await Promise.race([work, expired.promise]); }
  finally { clearTimeout(timer); }
}

async function processExited(pid: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (true) {
    try { process.kill(pid, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    if (Date.now() >= deadline) throw new Error(`Owned native PID ${pid} did not exit`);
    const drain = Promise.withResolvers<void>();
    setImmediate(drain.resolve);
    await drain.promise;
  }
}

function requestIds(entries: readonly FileEntry[]): string[] {
  return entries.flatMap(entry => {
    if (entry.type !== "message" || entry.message.role !== "user") return [];
    const content = entry.message.content;
    const text = typeof content === "string" ? content : content.filter(part => part.type === "text").map(part => part.text).join("");
    const id = nativeRequestEnvelope(text)?.requestId;
    return id ? [id] : [];
  });
}

function nativeToolResults(entries: readonly FileEntry[], name: string) {
  // A restarted local provider may reuse its wire call IDs. Correlate each
  // result with the preceding invocation, never a session-wide ID-only set.
  const calls = new Map<string, string>();
  return entries.flatMap(entry => {
    if (entry.type !== "message") return [];
    if (entry.message.role === "assistant") {
      for (const part of entry.message.content) {
        if (part.type !== "toolCall") continue;
        const device = part.name === "write" && typeof part.arguments.path === "string" && part.arguments.path.startsWith("xd://")
          ? part.arguments.path.slice("xd://".length) : part.name;
        calls.set(part.id, device);
      }
      return [];
    }
    if (entry.message.role !== "toolResult") return [];
    const device = calls.get(entry.message.toolCallId);
    calls.delete(entry.message.toolCallId);
    return device === name ? [entry.message] : [];
  });
}

const root = process.env.OMP_NATIVE_GATEWAY_ROOT;
assert(root && path.isAbsolute(root), "Native Gateway proof needs a private absolute root");
const presetScenario = process.env.OMP_NATIVE_GATEWAY_PRESETS ?? "create";
assert(["create", "valid", "failed", "skipped", "interrupted"].includes(presetScenario));
assert.equal(process.env.HOME, path.join(root, "home"));
const parsed: unknown = JSON.parse(process.env.OMP_TEST_COMMAND ?? "null");
assert(Array.isArray(parsed) && parsed.length && parsed.every(value => typeof value === "string" && value), "OMP_TEST_COMMAND must explicitly name the patched native CLI argv");
const ulwEntrypoint = process.env.OMP_TEST_ULW_EXTENSION ? await fs.realpath(process.env.OMP_TEST_ULW_EXTENSION) : undefined;
const managedUlwPath = ulwEntrypoint
  ? (await fs.stat(ulwEntrypoint)).isDirectory() ? ulwEntrypoint : path.dirname(ulwEntrypoint)
  : path.resolve(import.meta.dir, "managed-ulw");
if (ulwEntrypoint) {
  assert((await fs.stat(ulwEntrypoint)).isFile(), "OMP_TEST_ULW_EXTENSION must explicitly name the actual extension entrypoint file");
  const manifest = JSON.parse(await fs.readFile(path.join(managedUlwPath, "package.json"), "utf8")) as { omp?: { extensions?: unknown } };
  assert(Array.isArray(manifest.omp?.extensions) && manifest.omp.extensions.every(value => typeof value === "string"),
    "The opted-in ULW package must explicitly advertise its actual extension");
  const advertised = await Promise.all(manifest.omp.extensions.map(value => fs.realpath(path.resolve(managedUlwPath, value))));
  assert.deepEqual(advertised, [ulwEntrypoint], "Managed loading must use the exact opted-in shared ULW entrypoint once, without a substitute or duplicate -e");
}
const agent = path.join(root, "agent");
const headCwd = path.join(root, "head");
const laneCwd = path.join(root, "topic");
for (const directory of [agent, headCwd, laneCwd]) privateDirectory(directory);
const model = "gateway-native/local";
const settings = {
  disabledProviders: nativeDisabledProviders, modelRoles: { default: model, judge: model },
  // Explicitly grant only the native keyword settings this proof exercises;
  // native task capability requirements still control orchestration notices.
  ...(ulwEntrypoint ? { magicKeywords: { enabled: true, ultrathink: true, orchestrate: true } } : {}),
  ...(presetScenario === "valid" || ulwEntrypoint ? {
    modelPresets: Object.fromEntries(["high", "middle", "low"].map(name => [name, { modelRoles: { default: model, judge: model } }])),
  } : {}),
};
await fs.writeFile(path.join(agent, "config.yml"), JSON.stringify(settings), { mode: 0o600 });
await fs.writeFile(path.join(agent, "models.yml"), "providers: {}\n", { mode: 0o600 });
const settingsBytes = new Map(await Promise.all(["config.yml", "models.yml"].map(async name => [name, await fs.readFile(path.join(agent, name))] as const)));
const config: Config = {
  path: path.join(root, "superagent.json"), stateDir: root, headCwd,
  command: [...parsed, "-e", path.resolve(import.meta.dir, "native-extension.ts"), "-e",
    path.resolve(import.meta.dir, ulwEntrypoint ? "native-ulw-provider-extension.ts" : "gateway-provider-extension.ts")],
  maxHosts: 2, maxSubagents: 2, idleMs: 3_600_000, model,
  discord: { tokenEnv: "ISOLATED_GATEWAY_DISCORD_TOKEN", ownerId: "1", allowedGuildIds: ["3"], allowedChannelIds: ["4"] },
};
await fs.writeFile(config.path, JSON.stringify(config), { mode: 0o600 });
async function readCliStatus(): Promise<GatewayStatus> {
  const child = Bun.spawn([process.execPath, "--no-env-file", path.resolve(import.meta.dir, "../../src/cli.ts"),
    "status", "--config", config.path], {
    cwd: config.stateDir, env: { ...process.env }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  try {
    const [stdout, stderr, code] = await within(Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]), 10_000, "Isolated actual CLI status did not exit");
    assert.equal(code, 0, stderr);
    assert.equal(stderr, "");
    const result = JSON.parse(stdout) as { gateway: GatewayStatus | null };
    assert(result.gateway, "Actual CLI must read the live private Gateway");
    return result.gateway;
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
}
const messenger = new RecordingMessenger();
const errors: unknown[] = [];
const connections = new Set<HostConnection>();
let gateway: GatewayService | undefined;
let starting: Promise<GatewayService> | undefined;
let ledger: Database | undefined;
let stoppedPid: number | undefined;
const route: Route = { platform: "discord", accountId: "2", authorityId: "1", guildId: "3", channelId: "4", threadId: null };
const thread = { ...route, threadId: "50" };
const inputs = ["201", "202", "203", "204", "205", "206", "207"].map(id => ({
  id, messageId: id, route: id === "201" || id === "207" ? route : thread,
  text: id === "202" ? "Start this independent topic in the verified workspace." : `Native Gateway request ${id}`,
  receivedAt: Date.now() + Number(id), attachments: [],
} satisfies Inbound));
const mainPaths = hostPaths(config, "main");
const owned = new Map<number, { socketPath: string; sessionFile: string }>();
let cleaning: Promise<void> | undefined;
function cleanup(): Promise<void> {
  return cleaning ??= (async () => {
    interrupted.abort(new Error("Owned native Gateway fixture is shutting down"));
    if (stoppedPid) {
      try { process.kill(stoppedPid, "SIGCONT"); } catch { /* It may already have died. */ }
      stoppedPid = undefined;
    }
    await fs.writeFile(path.join(root!, "release-207"), "cleanup", { mode: 0o600 });
    await fs.writeFile(path.join(root!, "release-bootstrap"), "cleanup", { mode: 0o600 });
    if (starting) {
      try { gateway = await within(starting, 40_000, "Native Gateway startup exceeded signal cleanup deadline"); }
      catch (error) { console.error(String(error)); }
    }
    if (gateway) {
      const pid = gateway.status().head.pid;
      if (pid) owned.set(pid, mainPaths);
      try { await within(gateway.close(), 7_000, "Gateway detach exceeded cleanup deadline"); }
      catch (error) { console.error(String(error)); }
    }
    const databasePath = path.join(root!, "coordination.sqlite");
    let cleanupLedger: Database | undefined;
    try {
      const db = ledger ?? (existsSync(databasePath) ? cleanupLedger = new Database(databasePath, { readonly: true, strict: true }) : undefined);
      if (db) {
        const saved = db.query("SELECT value FROM metadata WHERE key='gateway:head'").get() as { value: string } | null;
        const identity = saved ? JSON.parse(saved.value) as { pid: number; sessionFile: string } | null : null;
        if (identity?.pid && identity.sessionFile === mainPaths.sessionFile) owned.set(identity.pid, mainPaths);
        for (const row of db.query("SELECT data FROM lanes").all() as Array<{ data: string }>) {
          const lane = JSON.parse(row.data) as Lane;
          if (lane.pid) owned.set(lane.pid, lane);
        }
      }
    } catch (error) { console.error(`Native ownership ledger cleanup: ${String(error)}`); }
    finally { cleanupLedger?.close(); }
    const hostCleanup = await Promise.allSettled([...owned].map(async ([pid, host]) => {
      let connection: HostConnection | undefined;
      try {
        try { process.kill(pid, 0); } catch { return; }
        connection = await within(HostConnection.connect(host.socketPath), 5_000, "Owned host cleanup connection timed out");
        const state = await within(connection.client.getState(), 2_000, "Owned host identity readback timed out");
        if (state.hostPid !== pid || state.sessionFile !== host.sessionFile) return;
        if (!state.isSettled) await within(connection.client.abortAndRestoreQueue(), 3_000, "Owned host abort timed out");
        await within(connection.client.shutdownHost(), 3_000, "Owned host shutdown timed out");
        await within(connection.exited, 3_000, "Owned host did not exit after shutdown");
        await processExited(pid);
      } catch {
        // Only PIDs recorded by this private Gateway/Store are eligible. A
        // successfully identified different socket occupant returned above.
        try { process.kill(pid, "SIGKILL"); } catch { /* Already exited. */ }
        await processExited(pid);
      } finally {
        if (connection) await within(connection.close(), 1_000, "Owned host transport did not detach").catch(error => console.error(String(error)));
      }
    }));
    for (const connection of connections) await within(connection.close(), 1_000, "Native observer transport did not detach").catch(error => console.error(String(error)));
    ledger?.close();
    ledger = undefined;
    const failures = hostCleanup.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, "Owned native Gateway host cleanup failed");
  })();
}
const terminate = (signal: NodeJS.Signals): void => {
  void cleanup().then(() => process.exit(signal === "SIGINT" ? 130 : 143), error => {
    console.error(`Native Gateway signal cleanup failed: ${String(error)}`);
    process.exit(1);
  });
};
process.on("SIGTERM", terminate);
process.on("SIGINT", terminate);
try {
  starting = startGateway(config, { messenger, managedUlwPath, onError: error => errors.push(error) });
  gateway = await starting;
  starting = undefined;
  interrupted.signal.throwIfAborted();
  ledger = new Database(path.join(root, "coordination.sqlite"), { readonly: true, strict: true });
  const db = ledger;
  const bootstrapEntries = async () => parseSessionEntries(await fs.readFile(mainPaths.sessionFile, "utf8")).filter(entry =>
    entry.type === "message" && entry.message.role === "user" && JSON.stringify(entry.message.content).includes("Native preset startup initialization"));
  if (!ulwEntrypoint && ["create", "interrupted"].includes(presetScenario)) {
    await until(() => existsSync(path.join(root, "entered-bootstrap")), "actual same-head startup initialization model boundary");
    await messenger.deliver(inputs[0]!);
    await until(() => !!db.query("SELECT id FROM inputs WHERE id='201' AND state='pending'").get(), "durable ordinary input held behind initialization");
    const initializing = gateway.status();
    assert.equal(initializing.head.ready, false);
    assert.equal(initializing.head.initialization?.state, "running");
    assert.equal(initializing.gateway.admissionReady, true);
    assert.equal(messenger.sent.length, 0);
    assert.equal((await bootstrapEntries()).length, 1);
    assert.deepEqual(requestIds(parseSessionEntries(await fs.readFile(mainPaths.sessionFile, "utf8"))), []);
    if (presetScenario === "create") {
      const operator = await readCliStatus();
      assert.equal(operator.head.initialization?.state, "running");
      assert.equal(operator.head.ready, false);
      assert.equal(operator.head.pid, initializing.head.pid);
      assert.equal(operator.head.initialization?.requestId, initializing.head.initialization?.requestId);
    }
    if (presetScenario === "interrupted") {
      const originalPid = initializing.head.pid;
      assert(originalPid);
      const originalRequest = initializing.head.initialization!.requestId;
      process.kill(originalPid, "SIGKILL");
      await until(() => {
        const status = gateway!.status();
        return status.head.pid !== originalPid && status.head.connected && status.head.initialization?.state === "uncertain";
      }, "replacement head preserves ambiguous startup intent without replay");
      assert.equal(gateway.status().head.initialization?.requestId, originalRequest);
    } else await fs.writeFile(path.join(root, "release-bootstrap"), "create presets", { mode: 0o600 });
  }
  if (!ulwEntrypoint && ["failed", "skipped"].includes(presetScenario)) {
    await until(() => gateway!.status().head.initialization?.state === "failed", "observable unsuccessful initializer");
    await messenger.deliver(inputs[0]!);
    await until(() => !!db.query("SELECT id FROM inputs WHERE id='201' AND state='pending'").get(), "input retained after failed setup");
  } else if (presetScenario !== "interrupted") await until(() => gateway!.status().head.ready, "production head Gateway handshake and verified native presets");
  assert.equal((await fs.lstat(gatewayPaths(config).socketPath)).mode & 0o777, 0o600);
  if (!ulwEntrypoint && presetScenario !== "create") {
    const status = gateway.status();
    assert.equal(status.head.ready, presetScenario === "valid");
    assert.equal(status.gateway.admissionReady, true);
    assert.equal(messenger.sent.length, 0, "Bootstrap results are not externally delivered as user answers");
    assert.equal((await bootstrapEntries()).length, ["valid", "skipped"].includes(presetScenario) ? 0 : 1);
    for (const [name, bytes] of settingsBytes) assert.deepEqual(await fs.readFile(path.join(agent, name)), bytes);
    // A Gateway reconnect/adoption must not turn a failed or interrupted
    // lifecycle into a new initialization prompt in the live native head.
    const before = await fs.readFile(mainPaths.sessionFile, "utf8");
    await gateway.close();
    gateway = undefined;
    gateway = await startGateway(config, { messenger, managedUlwPath, onError: error => errors.push(error) });
    await until(() => {
      const adopted = gateway!.status();
      return adopted.head.connected && adopted.gateway.admissionReady && (presetScenario !== "valid" || adopted.head.ready);
    }, "Gateway adoption of the exact existing head and approval-reconciled intake");
    assert.equal(await fs.readFile(mainPaths.sessionFile, "utf8"), before);
    assert.equal(gateway.status().head.ready, presetScenario === "valid");
    assert.deepEqual(errors, []);
    await gateway.stop();
    gateway = undefined;
  } else if (ulwEntrypoint) {
    await runNativeUlwProof({ root, config, db, gateway, messenger, connections, owned, until });
    gateway = undefined;
    for (const [name, bytes] of settingsBytes) assert.deepEqual(await fs.readFile(path.join(agent, name)), bytes);
    assert.deepEqual(errors, []);
  } else {
  assert.equal(gateway.status().head.initialization?.state, "complete");
  const operator = await readCliStatus();
  assert.equal(operator.head.initialization?.state, "complete");
  assert.equal(operator.head.ready, true);
  assert.equal(operator.head.pid, gateway.status().head.pid);
  assert.equal((await bootstrapEntries()).length, 1);
  const initializedEntries = parseSessionEntries(await fs.readFile(mainPaths.sessionFile, "utf8"));
  const initializations = nativeToolResults(initializedEntries, "lane_init_presets");
  assert.equal(initializations.length, 1, "Only the actual existing head chooses and persists native presets once");
  assert.notEqual(initializations[0]!.isError, true);
  const initialized = Bun.YAML.parse(await fs.readFile(path.join(agent, "config.yml"), "utf8")) as {
    modelRoles: Record<string, string>; modelPresets: Record<string, { modelRoles: Record<string, string> }>;
  };
  assert.deepEqual(initialized.modelRoles, settings.modelRoles);
  assert.deepEqual(Object.keys(initialized.modelPresets).sort(), ["high", "low", "middle"]);
  for (const preset of Object.values(initialized.modelPresets)) assert.deepEqual(preset.modelRoles, settings.modelRoles);
  assert.deepEqual(await fs.readFile(path.join(agent, "models.yml")), settingsBytes.get("models.yml"));
  settingsBytes.set("config.yml", await fs.readFile(path.join(agent, "config.yml")));
  const input = (id: string) => db.query("SELECT target,state,request_id,generation FROM inputs WHERE id=?").get(id) as { target: string; state: string; request_id: string; generation: number } | null;
  const lane = () => {
    const rows = db.query("SELECT data FROM lanes").all() as Array<{ data: string }>;
    assert(rows.length <= 1, "Gateway may not create a second lane or controller");
    return rows[0] ? JSON.parse(rows[0].data) as Lane : null;
  };
  detectNativeFailure = async () => {
    const failed = db.query("SELECT id,target,state,request_id FROM inputs WHERE state IN ('uncertain','cancelled') ORDER BY sequence").all();
    if (!failed.length) return;
    const currentLane = lane();
    const nativeErrors = (await Promise.all([mainPaths, ...(currentLane ? [currentLane] : [])].map(async host => {
      const text = await fs.readFile(host.sessionFile, "utf8").catch(() => "");
      return parseSessionEntries(text).flatMap(entry => entry.type === "message" && entry.message.role === "assistant" &&
        ["error", "aborted"].includes(entry.message.stopReason) ? [{ sessionFile: host.sessionFile,
          stopReason: entry.message.stopReason, error: entry.message.errorMessage, content: entry.message.content }] : []);
    }))).flat();
    throw new Error(`Native request failed before expected progress: ${JSON.stringify({ failed, nativeErrors })}`);
  };
  const sent = (id: string) => messenger.sent.flatMap(output => output.text.split("\n")
    .filter(line => line === `HEAD:${id}`).map(() => output));
  const connect = async (socketPath: string) => {
    const connection = await HostConnection.connect(socketPath);
    connections.add(connection);
    return connection;
  };
  const head = await connect(mainPaths.socketPath);
  const initialHead = await head.client.getState();
  assert.equal(initialHead.settingsScope, "session");
  assert.equal(initialHead.sessionFile, mainPaths.sessionFile);
  assert.equal(initialHead.model?.provider, "gateway-native");
  assert.equal(initialHead.model?.id, "local");
  assert(initialHead.hostPid);
  owned.set(initialHead.hostPid, mainPaths);
  for (const item of inputs.slice(0, 3)) {
    await messenger.deliver(item);
    await until(() => sent(item.id).length === 1, `head-only reply ${item.id}`);
  }
  const firstLane = lane();
  assert(firstLane?.pid && firstLane.sessionId);
  owned.set(firstLane.pid, firstLane);
  assert.notEqual(firstLane.pid, initialHead.hostPid);
  assert.notEqual(firstLane.sessionId, initialHead.sessionId);
  assert.notEqual(firstLane.sessionFile, initialHead.sessionFile);
  assert.deepEqual(firstLane.route, thread);
  assert.equal(firstLane.cwd, laneCwd);
  const actualLane = await connect(firstLane.socketPath);
  const laneState = await actualLane.client.getState();
  assert.equal(laneState.settingsScope, "session");
  assert.deepEqual(laneState.model, initialHead.model);
  assert.equal(laneState.hostPid, firstLane.pid);
  assert.equal(laneState.sessionId, firstLane.sessionId);
  const firstHandoff = "handoff:202:lane";
  const followupHandoff = `handoff:203:${firstLane.id}`;
  assert.equal(input("202")?.target, "main");
  assert.equal(input("203")?.target, "main");
  assert.equal(input(firstHandoff)?.target, firstLane.id);
  assert.equal(input(followupHandoff)?.target, firstLane.id);
  assert.equal(input(`report:${firstHandoff}`)?.target, "main");
  assert.equal(input(`report:${followupHandoff}`)?.target, "main");
  await until(() => {
    const receipts = db.query("SELECT state FROM outputs ORDER BY sequence").all() as Array<{ state: string }>;
    return receipts.length === 4 && receipts.every(receipt => receipt.state === "sent") &&
      gateway!.status().gateway.pendingEvents === 0;
  }, "initial head replies and durable external receipts settle before forced head loss");

  // The Gateway owns ingress even while the actual head cannot execute one byte.
  process.kill(initialHead.hostPid, "SIGSTOP");
  stoppedPid = initialHead.hostPid;
  for (const item of inputs.slice(3, 5)) await messenger.deliver(item);
  await messenger.deliver(inputs[3]!); // Adapter replay while native head is unavailable.
  assert(gateway.status().gateway.pendingEvents >= 2);
  const queued = db.query("SELECT data,delivered_at FROM gateway_events ORDER BY sequence").all() as Array<{ data: string; delivered_at: number | null }>;
  for (const item of inputs.slice(3, 5)) {
    const matching = queued.filter(row => JSON.parse(row.data).input?.id === item.id);
    assert.equal(matching.length, 1, "Raw Gateway admission must be durable and deduplicated before ACK");
    assert.equal(matching[0]!.delivered_at, null);
    assert.equal(input(item.id), null, "Suspended head must not already own queued user input");
    assert.equal(sent(item.id).length, 0);
  }
  assert.deepEqual(requestIds(parseSessionEntries(await fs.readFile(firstLane.sessionFile, "utf8"))), [firstHandoff, followupHandoff]);
  process.kill(initialHead.hostPid, "SIGKILL");
  stoppedPid = undefined;
  await messenger.deliver(inputs[5]!); // Receipt remains available throughout real death/recovery.
  await until(() => {
    const status = gateway!.status();
    return status.head.ready && status.head.pid !== initialHead.hostPid;
  }, "reconciled actual head replacement");
  const restored = await connect(mainPaths.socketPath);
  const restoredHead = await restored.client.getState();
  assert(restoredHead.hostPid);
  owned.set(restoredHead.hostPid, mainPaths);
  assert.notEqual(restoredHead.hostPid, initialHead.hostPid);
  assert.equal(restoredHead.sessionId, initialHead.sessionId);
  assert.equal(restoredHead.sessionFile, initialHead.sessionFile);
  assert.deepEqual(restoredHead.model, initialHead.model);
  assert.equal(restoredHead.settingsScope, "session");
  for (const item of inputs.slice(3, 6)) await until(() => sent(item.id).length === 1, `restored head reply ${item.id}`);
  for (const item of inputs.slice(0, 6)) await messenger.deliver(item);
  await until(() => gateway!.status().gateway.pendingEvents === 0, "durable Gateway receipts and duplicate replay drain");
  await messenger.deliver(inputs[6]!);
  await until(() => existsSync(path.join(root, "entered-207")), "actual native provider's busy barrier");
  await assert.rejects(gateway.stop(), /busy|active|settled|running|work/i);
  assert(messenger.handlers, "Busy refusal must leave Gateway receiving");
  await fs.writeFile(path.join(root, "release-207"), "release", { mode: 0o600 });
  await until(() => sent("207").length === 1 && input("207")?.state === "done", "busy turn completion");
  await until(() => gateway!.status().gateway.pendingEvents === 0, "final durable admission receipt");

  const reportOwners = new Map<string, string>();
  const expectedLaneRequests = [firstHandoff, followupHandoff, ...inputs.slice(3, 6).map(item => `handoff:${item.id}:${firstLane.id}`)];
  for (const handoffId of expectedLaneRequests) {
    const row = db.query("SELECT value FROM metadata WHERE key=?").get(`steering-owner:${handoffId}`) as { value: string } | null;
    assert(row, "Every actual lane input must retain its native settlement owner");
    assert(expectedLaneRequests.includes(row.value), "Consolidated reports may only belong to an admitted lane input");
    assert(expectedLaneRequests.indexOf(row.value) <= expectedLaneRequests.indexOf(handoffId), "A follow-up cannot own an earlier input");
    assert.equal(input(handoffId)?.state, "done");
    reportOwners.set(handoffId, row.value);
  }
  const expectedReports = [...new Set(reportOwners.values())].map(owner => `report:${owner}`);
  const expectedHeadRequests = [...inputs.map(item => item.id), ...expectedReports];
  const headEntries = parseSessionEntries(await fs.readFile(mainPaths.sessionFile, "utf8"));
  const headIds = requestIds(headEntries);
  // Concurrent durable inputs and returned reports may interleave, but every
  // original occurs once and precedes the report of its native steering group.
  assert.deepEqual([...headIds].sort(), [...expectedHeadRequests].sort());
  const laneEntries = parseSessionEntries(await fs.readFile(firstLane.sessionFile, "utf8"));
  const laneIds = requestIds(laneEntries);
  assert.deepEqual(laneIds, expectedLaneRequests);
  const managementCalls = headEntries.flatMap(entry => entry.type === "message" && entry.message.role === "assistant"
    ? entry.message.content.flatMap(part => {
      if (part.type !== "toolCall") return [];
      if (["lane_start", "lane_message"].includes(part.name)) return [{ name: part.name, sourceId: part.arguments.sourceId }];
      if (part.name !== "write" || !["xd://lane_start", "xd://lane_message"].includes(String(part.arguments.path))) return [];
      const args = JSON.parse(String(part.arguments.content)) as { sourceId: string };
      return [{ name: String(part.arguments.path).slice("xd://".length), sourceId: args.sourceId }];
    }) : []);
  assert.deepEqual(managementCalls, [
    { name: "lane_start", sourceId: "202" }, ...inputs.slice(2, 6).map(item => ({ name: "lane_message", sourceId: item.id })),
  ], "Every lane dispatch must be an actual manager tool issued by the head after original user intake");
  const laneManagerCalls = laneEntries.flatMap(entry => entry.type === "message" && entry.message.role === "assistant"
    ? entry.message.content.flatMap(part => part.type === "toolCall" && part.name.startsWith("lane_") ? [part] : []) : []);
  assert.deepEqual(laneManagerCalls, [], "Actual separate lane may not load or use head manager authority");
  const deniedLaneCalls = nativeToolResults(laneEntries, "lane_message");
  assert.equal(deniedLaneCalls.length, laneIds.length, "Each actual lane request probes the real manager device authority boundary");
  for (const denied of deniedLaneCalls) {
    assert.equal(denied.isError, true);
    assert(JSON.stringify(denied.content).includes("No such tool: xd://lane_message"), "Native manager device must actually reject lane execution");
  }
  for (const item of inputs.slice(1, 6)) {
    const handoffId: string = item.id === "202" ? firstHandoff : `handoff:${item.id}:${firstLane.id}`;
    const owner = reportOwners.get(handoffId)!;
    const reportId = `report:${owner}`;
    assert(headIds.indexOf(item.id) < headIds.indexOf(reportId));
    assert.equal(input(item.id)?.target, "main");
    assert.equal(input(item.id)?.state, "done");
    assert.equal(input(handoffId)?.target, firstLane.id);
    const admittedRow = db.query("SELECT data FROM inputs WHERE id=?").get(item.id) as { data: string };
    const admitted = JSON.parse(admittedRow.data) as Inbound;
    assert.deepEqual({ id: admitted.id, messageId: admitted.messageId, route: admitted.route, text: admitted.text,
      receivedAt: admitted.receivedAt, attachments: admitted.attachments }, item, "Native intake preserves the exact original identity and authorized task data");
    assert.equal(input(reportId)?.target, "main");
    const ownerSource = db.query("SELECT value FROM metadata WHERE key=?").get(`handoff-source:${owner}`) as { value: string };
    const reportRow = db.query("SELECT data FROM inputs WHERE id=?").get(reportId) as { data: string };
    const report = JSON.parse(reportRow.data) as Inbound;
    assert(report.text.includes(`sourceId: ${ownerSource.value}; laneInputId: ${owner}`));
    const grouped = expectedLaneRequests.filter(id => reportOwners.get(id) === owner);
    assert.deepEqual([...report.text.matchAll(/^LANE:([^\r\n]+)$/gm)].map(match => match[1]), grouped,
      "The actual native lane result must account for every joined handoff exactly once and in order");
    assert.deepEqual(sent(item.id)[0]?.route, item.route);
    assert.equal(sent(item.id)[0]?.sourceId, reportId);
  }
  const kickoff = messenger.sent.filter(output => output.id === "202:kickoff");
  assert.equal(kickoff.length, 1, "Thread kickoff must be externally delivered once, including duplicate source replay");
  assert.deepEqual(kickoff[0]?.route, thread);
  assert.equal(kickoff[0]?.sourceId, firstHandoff);
  assert(kickoff[0]?.text.trim());
  const expectedOutputSources = ["201", firstHandoff, ...expectedReports, "207"];
  assert.deepEqual(messenger.sent.map(output => output.sourceId).sort(), [...expectedOutputSources].sort());
  assert.deepEqual(messenger.sent.filter(output => output.id !== "202:kickoff").flatMap(output => output.text.split("\n")).sort(), inputs.map(item => `HEAD:${item.id}`).sort(),
    "Head-only delivery must account for every original input once, whether native work yields one or several outputs");
  for (const item of inputs) assert.equal(sent(item.id).length, 1);
  await until(() => inputs.every(item => messenger.activities.filter(value => value.message.messageId === item.messageId).at(-1)?.activity === "idle"),
    "native head, lane and report processing reactions settle");
  for (const item of inputs) {
    const activities = messenger.activities.filter(value => value.message.messageId === item.messageId);
    assert.equal(activities.filter(value => value.activity === "received").length, 1, "Duplicate ingress must not add another receipt reaction");
    assert(activities.some(value => value.activity === "thinking"), "Real native processing must be visible on every original input");
    assert(activities.every(value => JSON.stringify(value.message.route) === JSON.stringify(item.route)), "Reactions must stay on the original message route, not a report or newly selected destination");
  }
  const outputs = db.query("SELECT id,source_id,state,remote_id FROM outputs ORDER BY sequence").all() as Array<{ id: string; source_id: string; state: string; remote_id: string }>;
  assert.deepEqual(outputs.map(output => output.source_id).sort(), [...expectedOutputSources].sort());
  assert(outputs.every(output => output.state === "sent" && output.remote_id === `gateway-native-receipt:${output.id}`));
  const boardPosts = [...nativeToolResults(headEntries, "board_post"), ...nativeToolResults(laneEntries, "board_post")];
  const posted = boardPosts.map(post => {
    assert.notEqual(post.isError, true);
    const value = JSON.parse(post.content.filter(part => part.type === "text").map(part => part.text).join("")) as {
      id: number; actor: string; role: string; sessionId: string; channel: string; text: string; mentions: string[];
    };
    assert(Number.isSafeInteger(value.id) && value.id > 0);
    return { ...value, toolCallId: post.toolCallId };
  });
  assert.deepEqual(posted.map(value => ({ actor: value.actor, role: value.role, sessionId: value.sessionId,
    channel: value.channel, text: value.text, mentions: value.mentions })), [
    { actor: "head", role: "head", sessionId: initialHead.sessionId, channel: "general", text: "native-gateway:head-brief", mentions: [] },
    ...laneIds.map(id => ({ actor: firstLane.id, role: "lane", sessionId: firstLane.sessionId, channel: "general",
      text: `native-gateway:lane-finding:${id}`, mentions: ["head"] })),
  ], "Required actual head/lane posts must have exact native actors, sessions and handed-off request identities");
  assert.equal(new Set(posted.map(value => value.id)).size, posted.length, "No native post may appear twice under the same board ID");
  assert.equal(new Set(posted.map(value => JSON.stringify([value.sessionId, value.toolCallId]))).size, posted.length,
    "Every request-bearing post must originate from one unique native session/tool execution");
  const headReads = nativeToolResults(headEntries, "board_read");
  const laneReads = nativeToolResults(laneEntries, "board_read");
  assert.equal(headReads.length, expectedReports.length);
  assert.equal(laneReads.length, laneIds.length);
  for (const [name, bytes] of settingsBytes) assert.deepEqual(await fs.readFile(path.join(agent, name)), bytes);
  assert.deepEqual(errors, []);

  await gateway.close();
  gateway = undefined;
  assert.equal(messenger.handlers, undefined);
  assert.equal((await restored.client.getState()).hostPid, restoredHead.hostPid, "Gateway close must detach without killing native head");
  assert.equal((await actualLane.client.getState()).hostPid, firstLane.pid, "Gateway must never own a direct lane transport");
  for (const connection of [actualLane, restored]) {
    const state = await connection.client.getState();
    assert.equal(state.isSettled, true);
    assert.deepEqual(state.pendingUiRequests, []);
    assert.equal(state.hasOwnedRunningWork, false);
    assert.equal((await connection.request({ type: "shutdown_host" })).success, true);
    await connection.exited;
  }
  for (const sessionFile of [mainPaths.sessionFile, firstLane.sessionFile]) {
    const entries = parseSessionEntries(await fs.readFile(sessionFile, "utf8"));
    const shutdowns = entries.filter(entry => entry.type === "custom" && entry.customType === "omp-superagent-native-test");
    assert.equal(shutdowns.length, 1);
    assert.equal((shutdowns[0] as { data: { networkAttempts: number } }).data.networkAttempts, 0);
  }
  }
} catch (error) {
  const tails = (await Promise.all([path.join(root, "logs"), path.join(root, "home", ".omp", "logs")].map(async directory => {
    const names = await fs.readdir(directory).catch(() => [] as string[]);
    return Promise.all(names.map(async name => `${path.join(directory, name)}:\n${(await fs.readFile(path.join(directory, name), "utf8")).slice(-12_000)}`));
  }))).flat();
  console.error(JSON.stringify({ error: String(error), status: gateway?.status(), errors: errors.map(String), sent: messenger.sent }, null, 2));
  console.error(tails.join("\n"));
  throw error;
} finally {
  try { await cleanup(); }
  finally {
    process.off("SIGTERM", terminate);
    process.off("SIGINT", terminate);
  }
}
