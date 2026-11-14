import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { parseSessionEntries, type FileEntry } from "@oh-my-pi/pi-coding-agent";
import { hostPaths, loadConfig, privateDirectory } from "../../src/config";
import type { Approval, GatewayRestartRecord, Inbound, Lane, OutputRecord, Route } from "../../src/contracts";
import { launchGateway, stopGateway } from "../../src/gateway";
import { gatewayStatus } from "../../src/gateway-protocol";
import { processAlive } from "../../src/gateway-restart";
import { loadCredentials } from "../../src/credentials";
import { DeliveryError } from "../../src/delivery";
import { HostConnection } from "../../src/host";
import { nativeDisabledProviders } from "./native-extension";
import { nativeRequestEnvelope } from "./native-request-envelope";

interface Event {
  readonly kind: string;
  readonly at: number;
  readonly pid: number;
  readonly role?: string;
  readonly index?: number;
  readonly output?: OutputRecord;
  readonly outputId?: string;
  readonly approval?: Approval;
  readonly sessionId?: string;
  readonly sessionFile?: string;
  readonly headPid?: number;
  readonly headAlive?: boolean;
  readonly ack?: { readonly state: string; readonly remote_id: string | null };
  readonly goal?: { readonly id: string; readonly status: string };
  readonly confirmed?: boolean;
  readonly stream?: number;
  readonly statusCode?: number;
  readonly headersSent?: boolean;
  readonly clientId?: string;
  readonly frame?: { readonly id?: string; readonly confirmed?: boolean; readonly cancelled?: boolean };
  readonly requestId?: string;
  readonly response?: { readonly type: string; readonly id: string; readonly command: string; readonly success: boolean;
    readonly data: { readonly entries: readonly FileEntry[]; readonly leafId: string | null } };
  readonly nativeFrame?: { readonly type?: string; readonly message?: { readonly role?: string; readonly stopReason?: string } };
  readonly bytes?: string;
  readonly destroyed?: boolean;
  readonly error?: string;
}
interface InputRow { readonly state: string; readonly request_id: string | null }
interface OwnedProcess { readonly pid: number; readonly group: number; readonly argv: string; readonly native: boolean; readonly runner: boolean }

const rootSetting = process.env.OMP_RESTART_NATIVE_ROOT;
assert(rootSetting && path.isAbsolute(rootSetting) && process.env.HOME === path.join(rootSetting, "home"));
const root = rootSetting;
const scenario = process.env.OMP_RESTART_NATIVE_SCENARIO;
assert(scenario === "busy" || scenario === "approval" || scenario === "lane" || scenario === "stop" || scenario === "ack-interrupted"
  || scenario === "settled-goal" || scenario === "quarantine" || scenario === "operator-stop" || scenario === "lane-failure" || scenario === "lane-abort"
  || scenario === "lane-failure-recovery-window" || scenario === "lane-abort-recovery-window");
const recoveryWindow = scenario === "lane-failure-recovery-window" || scenario === "lane-abort-recovery-window";
const abortedLane = scenario === "lane-abort" || scenario === "lane-abort-recovery-window";
const detachedLane = scenario === "lane-failure" || scenario === "lane-abort" || recoveryWindow;
const parsed: unknown = JSON.parse(process.env.OMP_TEST_COMMAND ?? "null");
assert(Array.isArray(parsed) && parsed.length > 0 && parsed.every((value: unknown) => typeof value === "string" && value.length > 0),
  "OMP_TEST_COMMAND must explicitly name the patched native CLI argv");
const command = parsed.filter((value: unknown): value is string => typeof value === "string");
const interrupted = new AbortController();
const terminate = () => { interrupted.abort(new Error("Owned native restart proof interrupted")); };
process.on("SIGTERM", terminate);
process.on("SIGINT", terminate);
async function within<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  // Failure bounds for real OS/RPC processes, not synchronization delays.
  const expired = Promise.withResolvers<never>();
  const timer = setTimeout(() => expired.reject(new Error(label)), ms);
  try { return await Promise.race([work, expired.promise]); }
  finally { clearTimeout(timer); }
}
async function until(predicate: () => boolean | Promise<boolean>, label: string, cleanup = false): Promise<void> {
  const deadline = Date.now() + (cleanup ? 15_000 : 60_000);
  while (!await predicate()) {
    if (!cleanup) interrupted.signal.throwIfAborted();
    assert(Date.now() < deadline, `Native restart did not reach ${label}; retained ${root}`);
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}
const events = async (name: string): Promise<Event[]> => {
  if (!existsSync(path.join(root, name))) return [];
  const text = await fs.readFile(path.join(root, name), "utf8");
  return text.slice(0, text.lastIndexOf("\n") + 1).split("\n").filter(Boolean).map(line => JSON.parse(line));
};
for (const name of ["agent", "head", "lane"]) privateDirectory(path.join(root, name));
const model = "restart-native/local";
await fs.writeFile(path.join(root, "agent/config.yml"), JSON.stringify({
  disabledProviders: nativeDisabledProviders, modelRoles: { default: model, judge: model }, defaultThinkingLevel: "low",
  ...(detachedLane ? { retry: { enabled: false } } : {}),
  modelPresets: Object.fromEntries(["high", "middle", "low"].map(name => [name, { modelRoles: { default: model, judge: model }, defaultThinkingLevel: "low" }])),
}), { mode: 0o600 });
await fs.writeFile(path.join(root, "agent/models.yml"), "providers: {}\n", { mode: 0o600 });
const settingsBytes = await fs.readFile(path.join(root, "agent/config.yml"));
const configPath = path.join(root, "config.json");
const providerPath = path.resolve(import.meta.dir, "restart-native-provider.ts");
const nativeCommand = recoveryWindow
  ? command.flatMap((argument, index) => index === 0 ? [argument, "--preload", providerPath] : [argument])
  : command;
await fs.writeFile(configPath, JSON.stringify({
  stateDir: root, headCwd: path.join(root, "head"),
  command: [...nativeCommand, "-e", path.resolve(import.meta.dir, "native-extension.ts"), "-e", providerPath],
  maxHosts: 2, maxSubagents: 2, idleMs: 3_600_000, model,
  discord: { tokenEnv: "OMP_RESTART_NATIVE_DUMMY_TOKEN", ownerId: "1", allowedGuildIds: ["3"], allowedChannelIds: ["4", "5"] },
}), { mode: 0o600 });
await fs.writeFile(`${configPath}.env`, "OMP_RESTART_NATIVE_DUMMY_TOKEN=isolated-dummy-not-an-account\n", { mode: 0o600 });
await fs.writeFile(path.join(root, "ingress.jsonl"), "", { mode: 0o600 });
const config = await loadConfig(configPath);
loadCredentials(config);
const mainPaths = hostPaths(config, "main");
const loader = path.resolve(import.meta.dir, "restart-native-process.ts");
const connections = new Set<HostConnection>();
let ledger: Database | undefined;
let evidence: Record<string, unknown> | undefined;
let cleanupReceipt: { readonly startedAt: number; readonly completedAt: number; readonly remainingProcessCount: number;
  readonly remainingProcesses: readonly OwnedProcess[]; readonly gateFilesRemoved: boolean } | undefined;
const route: Route = { platform: "discord", accountId: "2", authorityId: "1", guildId: "3", channelId: "4", threadId: "10" };
const restartRoute: Route = { ...route, channelId: "5", threadId: "20" };
const queuedRoute: Route = { ...route, channelId: "5", threadId: "21" };
const input = (id: string, text: string, destination: Route): Inbound => ({ id, text, route: destination, messageId: id, attachments: [], receivedAt: Date.now() });
const original = input("901", "Finish the entrusted native goal, keeping the completed file effect exactly once across my restart.", route);
const restart = input("902", "/restart", restartRoute);
const queued = input("903", "Deliver this never-submitted queued request exactly once after the native goal finishes.", queuedRoute);
const deliver = (message: Inbound) => fs.appendFile(path.join(root, "ingress.jsonl"), `${JSON.stringify({ kind: "message", input: message })}\n`);
const stateOf = (id: string): InputRow | null => {
  assert(ledger);
  return ledger.query<InputRow, [string]>("SELECT state,request_id FROM inputs WHERE id=?").get(id);
};
const metadata = <T>(key: string): T | null => {
  assert(ledger);
  const row = ledger.query<{ value: string }, [string]>("SELECT value FROM metadata WHERE key=?").get(key);
  return row ? JSON.parse(row.value) : null;
};
const status = async () => {
  try { return await gatewayStatus(config); }
  catch { return null; } // Endpoint replacement may disconnect a read-only observer.
};
async function ownedProcesses(): Promise<OwnedProcess[]> {
  const child = Bun.spawn(["/bin/ps", "-axo", "pid=,pgid=,command="], { stdout: "pipe", stderr: "pipe" });
  const [text, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  assert.equal(code, 0, error);
  return text.split("\n").flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match) return [];
    const [, pid, group, argv] = match;
    if (!pid || !group || !argv) return [];
    const gateway = argv.includes(loader) && argv.includes(`--config ${config.path}`);
    const native = argv.includes(`--session ${path.join(root, "sessions")}/`) && argv.includes(`--rpc-socket ${path.join(root, "run")}/`);
    return gateway || native ? [{ pid: Number(pid), group: Number(group), argv, native, runner: gateway && argv.includes("--runner ") }] : [];
  });
}
async function cleanup() {
  const startedAt = Date.now();
  await fs.writeFile(path.join(root, "cleanup"), "Only this fixture's private processes may stop.\n", { mode: 0o600 });
  await fs.writeFile(path.join(root, "release-ack"), "cleanup\n", { mode: 0o600 });
  await fs.writeFile(path.join(root, "release-resume"), "cleanup\n", { mode: 0o600 });
  await fs.writeFile(path.join(root, "release-lane"), "cleanup\n", { mode: 0o600 });
  await fs.writeFile(path.join(root, "release-reconnect"), "cleanup\n", { mode: 0o600 });
  await fs.writeFile(path.join(root, "release-successor-attach"), "cleanup\n", { mode: 0o600 });
  await fs.writeFile(path.join(root, "release-lane-outcome"), "cleanup\n", { mode: 0o600 });
  await fs.writeFile(path.join(root, "release-lane-recovery-entries"), "cleanup\n", { mode: 0o600 });
  await until(async () => {
    const transport = await events("transport-events.jsonl");
    return (await ownedProcesses()).filter(owned => !owned.native && !owned.runner)
      .every(owned => transport.some(event => event.kind === "gateway-closed" && event.pid === owned.pid));
  }, "fixture Gateway supervision detached before native cleanup", true);
  const sockets = new Set([mainPaths.socketPath]);
  if (ledger) for (const row of ledger.query<{ data: string }, []>("SELECT data FROM lanes").all()) {
    const lane: Lane = JSON.parse(row.data);
    sockets.add(lane.socketPath);
  }
  for (const socket of sockets) {
    let observer: HostConnection | undefined;
    try {
    if (existsSync(socket)) {
      observer = await within(HostConnection.connect(socket), 5_000, "Owned native cleanup connection timed out");
      const native = await observer.client.getState();
      assert(native.sessionFile?.startsWith(path.join(root, "sessions") + path.sep));
      if (!native.isSettled) await within(observer.client.abortAndRestoreQueue(), 5_000, "Owned native cleanup abort timed out");
      if ((await observer.client.getState()).goal?.enabled) await observer.request({ type: "goal", op: "pause" });
      await until(async () => (await observer?.client.getState())?.isSettled === true, "owned native cleanup quiescence", true);
      await within(observer.client.shutdownHost(), 5_000, "Owned native cleanup shutdown timed out");
      await within(observer.exited, 5_000, "Owned native cleanup transport stayed open");
    }
    } finally { await observer?.close(); }
  }
  for (const connection of connections) await connection.close();
  connections.clear();
  let remainingProcesses = await ownedProcesses();
  await until(async () => {
    if (remainingProcesses.length === 0) return true;
    remainingProcesses = await ownedProcesses();
    return remainingProcesses.length === 0;
  }, "all fixture-owned detached processes exited", true);
  ledger?.close();
  ledger = undefined;
  for (const name of ["release-ack", "release-resume", "release-lane", "release-reconnect", "release-successor-attach", "release-lane-outcome",
    "arm-lane-recovery-entries", "release-lane-recovery-entries"])
    await fs.rm(path.join(root, name), { force: true });
  return { startedAt, completedAt: Date.now(), remainingProcessCount: remainingProcesses.length, remainingProcesses, gateFilesRemoved: true };
}
try {
  await within(launchGateway(config, undefined, [process.execPath, "--no-env-file", loader]), 50_000, "Initial isolated Gateway launch timed out");
  await until(async () => Boolean((await status())?.head.ready), "production Gateway/native extension readiness");
  const beforeGateway = await status();
  assert(beforeGateway?.head.pid);
  ledger = new Database(path.join(root, "coordination.sqlite"), { readonly: true, strict: true });
  const old = await HostConnection.connect(mainPaths.socketPath);
  connections.add(old);
  let survivingLane: Lane | undefined;
  let laneSource: Inbound | undefined;
  let detachedLaneReceipt: Record<string, unknown> | undefined;
  if (scenario === "lane" || detachedLane) {
    laneSource = input("904", "Start the independent local fixture lane at the explicitly provided destination.", { ...route, threadId: "30" });
    await deliver(laneSource);
    await until(async () => (await events("native-events.jsonl")).some(event => event.kind === "lane-held"), "independent native lane execution");
    const row = ledger.query<{ data: string }, []>("SELECT data FROM lanes").get();
    assert(row);
    survivingLane = JSON.parse(row.data);
    await until(async () => (await old.client.getState()).isSettled, "head yields after independent lane dispatch");
  }
  await deliver(original);
  if (scenario === "settled-goal") {
    await until(async () => (await old.client.getState()).isSettled && stateOf(original.id)?.state === "done",
      "native no-progress suppression settles with the original runtime input cleared");
    const initial = parseSessionEntries(await fs.readFile(mainPaths.sessionFile, "utf8"));
    const continuations = initial.filter(entry => entry.type === "custom_message" && entry.customType === "goal-continuation");
    assert.equal(continuations.length, 1, "The real native continuation must run before empty-activity suppression settles the goal");
    assert.equal((await events("native-events.jsonl")).filter(event => event.kind === "no-progress-response").length, 2);
  } else {
    await until(async () => (await events("native-events.jsonl")).some(event => event.kind === "held"), "completed real file effect and active native tool gate");
  }
  assert.equal(await fs.readFile(path.join(root, "head/completed-effect.log"), "utf8"), "completed-once\n");
  const before = await old.client.getState();
  assert.equal(before.hostPid, beforeGateway.head.pid);
  assert.equal(before.isStreaming, scenario !== "settled-goal");
  assert.equal(before.isSettled, scenario === "settled-goal");
  assert.equal(before.goal?.enabled, true);
  assert.equal(before.goal?.goal.status, "active");
  assert.equal(before.thinkingLevel, "low");
  assert.deepEqual(before.model && { provider: before.model.provider, id: before.model.id }, { provider: "restart-native", id: "local" });
  const originalAdmission = stateOf(original.id);
  assert(originalAdmission?.request_id);
  assert.equal(originalAdmission.state, scenario === "settled-goal" ? "done" : "submitted");
  let card: Approval | undefined;
  if (scenario === "approval" || scenario === "quarantine") {
    await until(async () => (await events("transport-events.jsonl")).some(event => event.kind === "show-approval"), "original-route native question card");
    card = (await events("transport-events.jsonl")).find(event => event.kind === "show-approval")?.approval;
    assert(card);
    assert.deepEqual(card.route, route);
    assert((await old.client.getState()).pendingUiRequests?.some(frame => frame.id === card?.requestId));
  }
  if (scenario === "quarantine") {
    assert(card);
    await fs.appendFile(path.join(root, "ingress.jsonl"), `${JSON.stringify({ kind: "answer", approvalId: card.id, response: { confirmed: true }, route })}\n`);
    await until(() => ledger?.query<{ delivery_error: string | null; delivered_at: number | null }, [string]>(
      "SELECT delivery_error,delivered_at FROM gateway_events WHERE identity=?").get(`answer:${card?.id}`)?.delivery_error === "unresolved",
    "actual original-route answer quarantined after its intended native wire response was lost");
    const attempts = (await events("native-events.jsonl")).filter(event => event.kind === "native-ui-wire-drop");
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]?.frame?.id, card.requestId);
    assert.equal(attempts[0]?.frame?.confirmed, true);
    assert.equal(ledger.query<{ state: string }, [string]>("SELECT state FROM approvals WHERE id=?").get(card.id)?.state, "answered");
    assert((await old.client.getState()).pendingUiRequests?.some(frame => frame.id === card?.requestId));
    assert.deepEqual((await events("native-events.jsonl")).filter(event => event.kind === "question-result"), []);
    await until(async () => (await events("transport-events.jsonl")).some(event => event.kind === "wire-events-close"),
      "real unresolved Gateway receipt closes its event stream");
  }
  await deliver(restart);
  await until(async () => (await events("transport-events.jsonl")).some(event => event.kind === "send" && event.output?.id === "902:restart-ack"), "original-route acknowledgement at actual Messenger transport");
  const ack = (await events("transport-events.jsonl")).find(event => event.kind === "send" && event.output?.id === "902:restart-ack");
  assert(ack?.output);
  assert.deepEqual(ack.output.route, restartRoute);
  assert.equal(ack.headPid, before.hostPid);
  assert.equal(ack.headAlive, true);
  assert.equal((await old.client.getState()).isStreaming, scenario !== "settled-goal", "Native work cannot be interrupted before the ACK send returns");
  if (scenario === "quarantine") {
    await until(async () => {
      const transport = await events("transport-events.jsonl");
      return transport.some(event => event.kind === "wire-window-open") && transport.some(event => event.kind === "wire-attach-held");
    },
      "actual reconnect attach held after async restart receive was receipted while ACK remains pending");
    const admitted = ledger.query<{ delivered_at: number | null; delivery_error: string | null }, []>(
      "SELECT delivered_at,delivery_error FROM gateway_events WHERE identity='message:902'").get();
    assert(admitted?.delivered_at !== null && admitted?.delivered_at !== undefined);
    assert.equal(admitted.delivery_error, null);
    assert.equal((await status())?.head.connected, false);
    assert.equal((await status())?.head.ready, false);
    assert.equal((await events("transport-events.jsonl")).filter(event => event.kind === "send-returned" && event.outputId === "902:restart-ack").length, 0);
  }
  await deliver(queued);
  await deliver(restart); // The same original owner admission is intentionally replayed.
  if (scenario === "quarantine") {
    await until(async () => (await events("transport-events.jsonl")).some(event => event.kind === "ingress-admitted" && event.index === 5),
      "queued original Messenger admissions persist while the native event stream is disconnected");
    const admitted = ledger.query<{ delivered_at: number | null }, []>(
      "SELECT delivered_at FROM gateway_events WHERE identity='message:903'").get();
    assert.equal(admitted?.delivered_at, null);
    assert.equal(stateOf(queued.id), null, "A held Gateway event must not be fabricated as runtime-admitted input");
  } else {
    await until(() => stateOf(queued.id)?.state === "pending", "durable never-submitted queue behind the restart fence");
    assert.equal(stateOf(queued.id)?.request_id, null);
  }
  assert.equal(processAlive(beforeGateway.head.pid), true);
  let operatorStop: { readonly boundaryBefore: string | null; readonly boundaryAfter: string;
    readonly refusal: { readonly name: string; readonly message: string; readonly certainty: string } } | undefined;
  if (scenario === "operator-stop") {
    assert.equal(metadata("gateway:restart"), null, "Operator stop must precede any accepted Gateway lifecycle request");
    const boundaryBefore = ledger.query<{ value: string }, []>("SELECT value FROM metadata WHERE key='gateway:operator-stop'").get()?.value ?? null;
    try {
      await stopGateway(config);
      assert.fail("The actual native host must refuse shutdown while its entrusted execution is busy");
    } catch (error) {
      assert(error instanceof DeliveryError);
      assert.equal(error.certainty, "rejected", "Busy shutdown must be a known native refusal, never force or ambiguous termination");
      const boundaryAfter = ledger.query<{ value: string }, []>("SELECT value FROM metadata WHERE key='gateway:operator-stop'").get()?.value;
      assert(boundaryAfter);
      assert.notEqual(boundaryAfter, boundaryBefore);
      operatorStop = { boundaryBefore, boundaryAfter, refusal: { name: error.name, message: error.message, certainty: error.certainty } };
    }
    const held = await old.client.getState();
    assert.equal(held.hostPid, before.hostPid);
    assert.equal(held.isSettled, false);
    assert.equal(held.isStreaming, true);
    assert.equal(held.goal?.enabled, true);
    assert.equal(held.goal?.goal.id, before.goal?.goal.id);
    assert.equal(metadata("gateway:restart"), null);
  }
  if (scenario === "stop") {
    await deliver(input("904", "/stop head", restartRoute));
    await until(() => metadata<{ state: string }>("head:restart:902")?.state === "refused", "explicit stop superseding the durable restart intent");
  }
  await fs.writeFile(path.join(root, "release-ack"), "The original-route ACK send may now return.\n", { mode: 0o600 });
  if (detachedLane) {
    assert(survivingLane);
    const lane = survivingLane;
    await until(async () => (await events("transport-events.jsonl")).some(event => event.kind === "wire-successor-attach-held"),
      "successor HEAD is held at actual authenticated transport attachment before it can restore the surviving lane");
    assert.equal(processAlive(beforeGateway.head.pid), false);
    const checkpoint = metadata<{ checkpoint?: { residents: readonly { id: string; inputId?: string; requestIds: readonly string[];
      result?: unknown; ownedRuns: number; entryId?: string }[] } }>("head:restart:902")?.checkpoint;
    const saved = checkpoint?.residents.find(resident => resident.id === lane.id);
    assert(saved?.entryId);
    assert.equal(saved.inputId, "handoff:904:lane");
    assert.equal(saved.result, undefined, "The checkpoint must precede the lane's first native prompt result");
    assert.equal(saved.ownedRuns, 1);
    const admission = stateOf("handoff:904:lane");
    assert(admission?.request_id);
    assert.equal(admission.state, "submitted");
    assert.deepEqual(saved.requestIds, [admission.request_id]);
    let entries = parseSessionEntries(await fs.readFile(lane.sessionFile, "utf8"));
    assert.equal(entries.filter(entry => entry.type === "custom" && entry.customType === "rpc_prompt_result").length, 0);
    const observer = await HostConnection.connect(lane.socketPath);
    connections.add(observer);
    assert.equal((await observer.client.getState()).hostPid, lane.pid);
    await fs.writeFile(path.join(root, "release-lane"), "Let only the first native lane turn yield successfully while HEAD is detached.\n", { mode: 0o600 });
    await until(async () => {
      entries = parseSessionEntries(await fs.readFile(lane.sessionFile, "utf8"));
      return (await events("native-events.jsonl")).some(event => event.kind === "lane-detached-continuation" && event.pid === lane.pid)
        && entries.some(entry => {
          if (entry.type !== "custom" || entry.customType !== "rpc_prompt_result") return false;
          const data = entry.data;
          if (!data || typeof data !== "object" || !("frame" in data)) return false;
          const frame = data.frame;
          return frame && typeof frame === "object" && "id" in frame && frame.id === admission.request_id
            && "status" in frame && frame.status === "completed";
        });
    }, "first successful native prompt result followed by a real autonomous lane goal continuation while detached");
    const leaf = entries.findIndex(entry => entry.id === saved.entryId);
    assert(leaf >= 0);
    const starts = entries.slice(leaf + 1).filter(entry => {
      if (entry.type !== "custom" || entry.customType !== "rpc_agent_start") return false;
      const data = entry.data;
      return data && typeof data === "object" && "sessionId" in data && data.sessionId === lane.sessionId
        && "sessionFile" in data && data.sessionFile === lane.sessionFile;
    });
    assert.equal(starts.length, 1, "Exactly one real continuation start must be durable after the checkpoint, not inferred from the older completed receipt");
    let recoveryWindowReceipt: Record<string, unknown> | undefined;
    let heldResponse: Event | undefined;
    if (recoveryWindow) {
      const active = await observer.client.getState();
      assert.equal(active.isStreaming, true);
      assert.equal(active.isSettled, false);
      await fs.writeFile(path.join(root, "arm-lane-recovery-entries"), "Hold only the next real HEAD restoration journal response.\n", { mode: 0o600 });
      await fs.writeFile(path.join(root, "release-successor-attach"), "Attach replacement HEAD while the real lane continuation remains active.\n", { mode: 0o600 });
      await until(async () => (await events("native-events.jsonl")).some(event => event.kind === "lane-recovery-entries-held" && event.pid === lane.pid),
        "actual replacement restoration get_entries snapshot held at the independent native lane socket");
      heldResponse = (await events("native-events.jsonl")).find(event => event.kind === "lane-recovery-entries-held" && event.pid === lane.pid);
      assert(heldResponse?.response);
      assert(heldResponse.requestId?.startsWith("restart-recovery-head:"));
      assert.equal(heldResponse.response.id, heldResponse.requestId);
      assert.equal(heldResponse.response.command, "get_entries");
      assert.equal(heldResponse.response.success, true);
      assert.deepEqual(JSON.parse(heldResponse.bytes ?? "null"), heldResponse.response);
      const snapshot = heldResponse.response.data.entries;
      const receiptIndex = snapshot.findIndex(entry => {
        if (entry.type !== "custom" || entry.customType !== "rpc_prompt_result") return false;
        const data = entry.data;
        if (!data || typeof data !== "object" || !("frame" in data)) return false;
        const frame = data.frame;
        return frame && typeof frame === "object" && "id" in frame && frame.id === admission.request_id
          && "status" in frame && frame.status === "completed";
      });
      const startIndex = snapshot.findIndex(entry => entry.id === starts[0]?.id);
      const yieldIndex = snapshot.findIndex(entry => entry.type === "message"
        && entry.message.role === "assistant" && entry.message.stopReason === "stop");
      assert(receiptIndex >= 0 && yieldIndex >= 0 && startIndex > yieldIndex,
        "The held original snapshot contains the completed original receipt and a continuation after its successful assistant yield");
      assert.equal(snapshot.some(entry => entry.type === "message" && entry.message.role === "assistant"
        && (entry.message.stopReason === "aborted" || entry.message.stopReason === "error")), false);
      assert.equal((await observer.client.getState()).isStreaming, true, "The lane is still executing after the actual restoration snapshot was taken");
      const requests = await events("native-events.jsonl");
      const requested = requests.find(event => event.kind === "head-recovery-entries-request" && event.requestId === heldResponse?.requestId);
      assert(requested);
      const successorOwner = metadata<{ pid: number }>("gateway:head");
      assert(successorOwner);
      assert.equal(requested.pid, successorOwner.pid);
      assert.notEqual(requested.pid, before.hostPid);
      assert.notEqual(requested.pid, lane.pid);
      assert.equal(requests.some(event => event.kind === "head-recovery-entries-received" && event.requestId === heldResponse?.requestId), false);
      const observerRequestId = `restart-recovery-observer:${scenario}`;
      const observerResponse = await observer.request({ type: "get_entries" }, observerRequestId);
      assert.equal(observerResponse.success, true, "An independent observer must not be caught by the HEAD restoration response gate");
      assert.equal(observerResponse.id, observerRequestId);
      recoveryWindowReceipt = { replacementHeadPid: requested.pid, activeNativeStateAtSnapshot: active,
        heldResponse, snapshotReceiptIndex: receiptIndex, snapshotYieldIndex: yieldIndex,
        snapshotContinuationStartIndex: startIndex, observerRequestId, observerResponse };
    }
    if (abortedLane) await observer.client.abortAndRestoreQueue();
    else await fs.writeFile(path.join(root, "release-lane-outcome"), "The actual local provider continuation now returns its terminal error.\n", { mode: 0o600 });
    const stopReason = abortedLane ? "aborted" : "error";
    await until(async () => {
      entries = parseSessionEntries(await fs.readFile(lane.sessionFile, "utf8"));
      return (await observer.client.getState()).isSettled && entries.some(entry => entry.type === "message"
        && entry.message.role === "assistant" && entry.message.stopReason === stopReason);
    }, `real native lane continuation reaches ${stopReason} before releasing restoration`);
    if (recoveryWindow) {
      assert(heldResponse?.response);
      await until(async () => {
        const native = await events("native-events.jsonl");
        return native.some(event => event.kind === "head-recovery-native-event" && event.requestId === heldResponse?.requestId
          && event.nativeFrame?.type === "message_end" && event.nativeFrame.message?.stopReason === stopReason)
          && native.some(event => event.kind === "head-recovery-native-event" && event.requestId === heldResponse?.requestId
            && event.nativeFrame?.type === "agent_end")
          && native.some(event => event.kind === "head-recovery-native-event" && event.requestId === heldResponse?.requestId
            && event.nativeFrame?.type === "session_settled");
      }, "replacement HEAD consumes actual terminal assistant and native settlement while its earlier restoration response remains held");
      const native = await events("native-events.jsonl");
      const requestIndex = native.findIndex(event => event.kind === "head-recovery-entries-request" && event.requestId === heldResponse?.requestId);
      const snapshotIndex = native.findIndex(event => event.kind === "lane-recovery-entries-held" && event.requestId === heldResponse?.requestId);
      const forwardedTerminalIndex = native.findIndex(event => event.kind === "lane-recovery-native-forward" && event.requestId === heldResponse?.requestId
        && event.nativeFrame?.type === "message_end" && event.nativeFrame.message?.stopReason === stopReason);
      const observedTerminalIndex = native.findIndex(event => event.kind === "head-recovery-native-event" && event.requestId === heldResponse?.requestId
        && event.nativeFrame?.type === "message_end" && event.nativeFrame.message?.stopReason === stopReason);
      const observedAgentEndIndex = native.findIndex(event => event.kind === "head-recovery-native-event" && event.requestId === heldResponse?.requestId
        && event.nativeFrame?.type === "agent_end");
      const forwardedSettlementIndex = native.findIndex(event => event.kind === "lane-recovery-native-forward" && event.requestId === heldResponse?.requestId
        && event.nativeFrame?.type === "session_settled");
      const observedSettlementIndex = native.findIndex(event => event.kind === "head-recovery-native-event" && event.requestId === heldResponse?.requestId
        && event.nativeFrame?.type === "session_settled");
      assert(requestIndex >= 0 && snapshotIndex > requestIndex && forwardedTerminalIndex > snapshotIndex && observedTerminalIndex > forwardedTerminalIndex);
      assert(observedAgentEndIndex > observedTerminalIndex && observedSettlementIndex > observedAgentEndIndex);
      assert(forwardedSettlementIndex > forwardedTerminalIndex && observedSettlementIndex > forwardedSettlementIndex);
      assert.equal(native.some(event => event.kind === "lane-recovery-entries-released" && event.requestId === heldResponse?.requestId), false);
      assert.equal(native.some(event => event.kind === "head-recovery-entries-received" && event.requestId === heldResponse?.requestId), false);
      const terminalIndex = entries.findIndex(entry => entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === stopReason);
      assert(terminalIndex >= 0);
      assert.equal(heldResponse.response.data.entries.some(entry => entry.id === entries[terminalIndex]?.id), false,
        "The delayed original response must omit the later journaled terminal assistant");
      recoveryWindowReceipt = { ...recoveryWindowReceipt, nativeEntriesBeforeResponseRelease: entries,
        nativeStateBeforeResponseRelease: await observer.client.getState(), terminalEntryId: entries[terminalIndex]?.id,
        ordering: { requestIndex, snapshotIndex, forwardedTerminalIndex, observedTerminalIndex, observedAgentEndIndex,
          forwardedSettlementIndex, observedSettlementIndex } };
      await fs.writeFile(path.join(root, "release-lane-recovery-entries"), "Deliver the unchanged earlier snapshot only after HEAD observed native termination and settlement.\n", { mode: 0o600 });
      await until(async () => (await events("native-events.jsonl")).some(event => event.kind === "head-recovery-entries-received"
        && event.requestId === heldResponse?.requestId), "original held restoration journal response delivered unchanged after actual terminal events");
      const released = await events("native-events.jsonl");
      const releaseIndex = released.findIndex(event => event.kind === "lane-recovery-entries-released" && event.requestId === heldResponse?.requestId);
      const receiveIndex = released.findIndex(event => event.kind === "head-recovery-entries-received" && event.requestId === heldResponse?.requestId);
      assert(releaseIndex > observedSettlementIndex && receiveIndex > releaseIndex);
      assert.equal(released.filter(event => event.kind === "lane-recovery-entries-held").length, 1);
      assert.equal(released.filter(event => event.kind === "lane-recovery-entries-released").length, 1);
      assert.equal(released[releaseIndex]?.destroyed, false);
      assert.equal(released[releaseIndex]?.bytes, heldResponse.bytes);
      assert.deepEqual(released[receiveIndex]?.response, heldResponse.response);
      recoveryWindowReceipt = { ...recoveryWindowReceipt, responseReleased: released[releaseIndex], responseReceived: released[receiveIndex],
        ordering: { requestIndex, snapshotIndex, forwardedTerminalIndex, observedTerminalIndex, observedAgentEndIndex,
          forwardedSettlementIndex, observedSettlementIndex, releaseIndex, receiveIndex } };
    } else {
      assert.equal(stateOf("handoff:904:lane")?.state, "submitted", "Only the gated replacement may recover the detached native outcome");
      assert.equal(stateOf("report:handoff:904:lane"), null);
    }
    detachedLaneReceipt = { checkpoint: saved, originalAdmission: admission, nativeStartsAfterCheckpoint: starts,
      nativeEntriesBeforeReattach: recoveryWindow ? undefined : entries,
      nativeStateBeforeReattach: recoveryWindow ? undefined : await observer.client.getState(), recoveryWindow: recoveryWindowReceipt };
    if (!recoveryWindow) await fs.writeFile(path.join(root, "release-successor-attach"), "Restore actual HEAD attachment only after the lane's later native terminal outcome is durable.\n", { mode: 0o600 });
  }
  if (scenario === "quarantine") {
    await until(async () => (await events("transport-events.jsonl")).some(event => event.kind === "process-start" && event.role === "runner"),
      "owned restart accepted and one-shot runner launched while authenticated SSE reconnect is still held");
    const transport = await events("transport-events.jsonl");
    assert.equal(transport.filter(event => event.kind === "wire-attach-released").length, 0);
    const window = transport.find(event => event.kind === "wire-window-open");
    assert(window);
    assert(transport.some(event => event.kind === "wire-events-close" && event.stream === window.stream));
    const stream = transport.find(event => event.kind === "wire-events-open" && event.stream === window.stream);
    assert(stream?.clientId);
    assert.equal(stream.statusCode, 200);
    assert.equal(stream.headersSent, true);
    assert.equal(transport.find(event => event.kind === "wire-attach-held")?.clientId, stream.clientId);
    const lifecycle = metadata<GatewayRestartRecord>("gateway:restart");
    const checkpoint = metadata<{ requestId: string }>("head:restart:902");
    assert(lifecycle && checkpoint);
    assert.equal(lifecycle.requestId, checkpoint.requestId);
    assert.equal(lifecycle.gatewayPid, beforeGateway.gateway.pid);
    assert.equal(lifecycle.headPid, before.hostPid);
    await fs.writeFile(path.join(root, "release-reconnect"), "Release the real HTTP attach after lifecycle acceptance in the missing-SSE window.\n", { mode: 0o600 });
  }
  if (scenario === "stop" || scenario === "ack-interrupted" || scenario === "operator-stop") {
    if (scenario === "stop") {
      await until(() => stateOf("904")?.state === "cancelled", "confirmed native HEAD stop");
      assert.equal(stateOf(queued.id)?.state, "cancelled");
      const stopped = await old.client.getState();
      assert.equal(stopped.isSettled, true);
      assert.equal(stopped.goal?.goal.status, "paused");
    } else if (scenario === "operator-stop") {
      await until(() => metadata<{ state: string }>("head:restart:902")?.state === "refused",
        "durable operator stop supersedes the older HEAD intent before native checkpoint");
      assert.equal(stateOf(restart.id)?.state, "done", "The accepted ACK admission is terminal; the separate restart intent is refused.");
      assert.equal(metadata<{ checkpoint?: unknown }>("head:restart:902")?.checkpoint, undefined);
      const held = await old.client.getState();
      assert.equal(held.hostPid, before.hostPid);
      assert.equal(held.isSettled, false);
      assert.equal(held.isStreaming, true);
      assert.equal(held.goal?.goal.id, before.goal?.goal.id);
      assert.equal(held.goal?.goal.status, "active");
      assert.equal(held.goal?.enabled, true);
      assert.equal((await events("native-events.jsonl")).filter(event => event.kind === "native-aborted").length, 0,
        "An earlier restart cannot checkpoint or interrupt native work after actual operator stop superseded it");
      assert.equal(metadata("gateway:restart"), null);
    } else {
      await until(() => ledger?.query<{ state: string }, []>("SELECT state FROM outputs WHERE id='902:restart-ack'").get()?.state === "uncertain",
        "interrupted ACK delivery quarantined without native interruption");
      assert.equal((await old.client.getState()).isStreaming, true);
      assert.equal((await events("native-events.jsonl")).filter(event => event.kind === "native-aborted").length, 0);
      assert.equal(stateOf(queued.id)?.state, "pending");
    }
    await deliver(restart);
    await until(async () => (await events("transport-events.jsonl")).some(event => event.kind === "ingress-admitted" && event.index === (scenario === "stop" ? 6 : 5)),
      "original restart duplicate processed without another lifecycle effect");
    const unchanged = await status();
    assert.equal(unchanged?.gateway.pid, beforeGateway.gateway.pid);
    assert.equal(unchanged?.head.pid, beforeGateway.head.pid);
    const transport = await events("transport-events.jsonl");
    assert.equal(transport.filter(event => event.kind === "send" && event.output?.id === "902:restart-ack").length, 1);
    assert.equal(transport.filter(event => event.kind === "process-start" && event.role === "gateway").length, 1);
    assert.equal(transport.filter(event => event.kind === "process-start" && event.role === "runner").length, 0);
    assert.equal(ledger.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM metadata WHERE key LIKE 'gateway:restart:%'").get()?.count, 0);
    evidence = { scenario, root, nativeSession: mainPaths.sessionFile, coordination: path.join(root, "coordination.sqlite"),
      gatewayPid: beforeGateway.gateway.pid, headPid: before.hostPid, sessionId: before.sessionId,
      originalInput: stateOf(original.id), queuedInput: stateOf(queued.id), restartInput: stateOf(restart.id),
      ack: ledger.query("SELECT id,source_id,state,remote_id,route FROM outputs WHERE id='902:restart-ack'").get(),
      restart: metadata("head:restart:902"), successorProcesses: 0, duplicateAcks: 0,
      operatorStop: operatorStop ?? null, observedAt: Date.now(), beforeRestart: before, beforeCleanup: await old.client.getState() };
  } else {
  await until(async () => (await events("native-events.jsonl")).some(event => event.kind === "resumed"), "same native goal resumed in the successor through goal RPC");
  await until(async () => Boolean((await status())?.head.ready), "replacement Gateway and HEAD readiness");
  const receipt = metadata<GatewayRestartRecord>("gateway:restart");
  const afterGateway = await status();
  assert(receipt?.state === "started" && afterGateway?.head.pid);
  assert.notEqual(afterGateway.gateway.pid, beforeGateway.gateway.pid);
  assert.notEqual(afterGateway.head.pid, beforeGateway.head.pid);
  assert.equal(receipt.gatewayPid, beforeGateway.gateway.pid);
  assert.equal(receipt.headPid, beforeGateway.head.pid);
  assert.equal(receipt.successorPid, afterGateway.gateway.pid);
  assert.equal(receipt.replacementPid, afterGateway.head.pid);
  assert.equal(receipt.sessionId, before.sessionId);
  assert.equal(receipt.sessionFile, before.sessionFile);
  assert.equal(processAlive(beforeGateway.gateway.pid), false);
  assert.equal(processAlive(beforeGateway.head.pid), false);
  const successor = await HostConnection.connect(mainPaths.socketPath);
  connections.add(successor);
  const after = await successor.client.getState();
  assert.equal(after.sessionId, before.sessionId);
  assert.equal(after.sessionFile, before.sessionFile);
  assert.deepEqual(after.model, before.model);
  assert.equal(after.thinkingLevel, before.thinkingLevel);
  assert.equal(after.goal?.goal.id, before.goal?.goal.id);
  assert.equal(after.goal?.goal.status, "active");
  assert.equal(after.goal?.enabled, true);
  assert.deepEqual(after.pendingUiRequests, []);
  const resumedId = `restart-resume:${receipt.requestId}:main`;
  assert.equal(stateOf(resumedId)?.state, "submitted");
  assert.equal(stateOf(original.id)?.state, scenario === "settled-goal" ? "done" : "cancelled");
  const aborted = (await events("native-events.jsonl")).find(event => event.kind === "native-aborted");
  if (scenario === "settled-goal") {
    assert.equal(aborted, undefined, "The original no-progress turn already settled before restart; no active tool was invented");
    const checkpoint = metadata<{ checkpoint?: { goalSourceId?: string; goalActive: boolean;
      residents: readonly { id: string; inputId?: string; requestIds: readonly string[] }[] } }>("head:restart:902")?.checkpoint;
    assert.equal(checkpoint?.goalActive, true);
    assert.equal(checkpoint?.goalSourceId, original.id, "Only the native goal's original input may supply resume routing");
    const resident = checkpoint?.residents.find(value => value.id === "main");
    assert(resident);
    assert.equal(resident.inputId, undefined, "The native goal source survives after finish clears live.input");
    assert.deepEqual(resident.requestIds, []);
  } else {
    assert(aborted);
    assert.equal(aborted.pid, before.hostPid);
    assert.deepEqual(aborted.ack, { state: "sent", remote_id: "restart-native-remote:902:restart-ack" }, "The native AbortSignal may fire only after a durable sent ACK receipt");
  }
  const nativeEntries = parseSessionEntries(await fs.readFile(mainPaths.sessionFile, "utf8"));
  const journal = nativeEntries.filter(entry => entry.type === "custom" && entry.customType === "rpc_prompt_result").map(entry => {
    assert(entry.type === "custom");
    const data = entry.data;
    assert(data && typeof data === "object" && "sessionId" in data && "sessionFile" in data && "frame" in data);
    const frame = data.frame;
    assert(frame && typeof frame === "object" && "id" in frame && "status" in frame);
    return { sessionId: data.sessionId, sessionFile: data.sessionFile, frame: { id: frame.id, status: frame.status } };
  });
  assert.equal(journal.filter(entry => entry.sessionId === before.sessionId && entry.sessionFile === before.sessionFile
    && entry.frame.id === originalAdmission.request_id && entry.frame.status === (scenario === "settled-goal" ? "completed" : "aborted")).length, 1);
  if (card) {
    assert(ledger);
    const approval = card;
    const cancelled = ledger.query<{ state: string; request_id: string }, [string]>("SELECT state,request_id FROM approvals WHERE id=?").get(approval.id);
    assert.deepEqual(cancelled, { state: scenario === "quarantine" ? "answered" : "cancelled", request_id: approval.requestId });
    if (scenario === "quarantine") {
      assert.deepEqual(metadata(`approval:restart-cancel:${approval.id}`), {
        requestId: approval.requestId, generation: approval.generation, target: approval.target,
      });
    }
    const transport = await events("transport-events.jsonl");
    assert.equal(transport.filter(event => event.kind === "dismiss-approval" && event.approval?.id === approval.id).length, 1);
    assert.deepEqual((await events("native-events.jsonl")).filter(event => event.kind === "question-result").map(event => event.confirmed), [false]);
    await fs.appendFile(path.join(root, "ingress.jsonl"), `${JSON.stringify({ kind: "answer", approvalId: approval.id, response: { confirmed: true }, route })}\n`);
    await until(() => ledger?.query<{ delivery_error: string | null }, [string]>(
      "SELECT delivery_error FROM gateway_events WHERE identity=?").get(`answer:${approval.id}`)?.delivery_error === "rejected", "stale original-route question answer rejected without native effect");
    assert.deepEqual((await successor.client.getState()).pendingUiRequests, []);
  }
  await deliver(restart); // Replay again through the actual successor's Messenger intake.
  const expectedIngress = scenario === "quarantine" ? 7 : scenario === "approval" || survivingLane ? 6 : 5;
  await until(async () => (await events("transport-events.jsonl")).some(event => event.kind === "ingress-admitted"
    && event.pid === afterGateway.gateway.pid && event.index === expectedIngress), "duplicate restart intake processed by successor without another handoff");
  let laneReadback: Record<string, unknown> | undefined;
  if (survivingLane) {
    const laneConnection = await HostConnection.connect(survivingLane.socketPath);
    connections.add(laneConnection);
    const actual = await laneConnection.client.getState();
    assert.equal(actual.hostPid, survivingLane.pid);
    assert.equal(actual.sessionId, survivingLane.sessionId);
    let reportReadback: Record<string, unknown> | undefined;
    if (detachedLane) {
      assert.equal(actual.isStreaming, false);
      assert.equal(actual.isSettled, true);
      const expected = abortedLane ? "cancelled" : "uncertain";
      await until(() => stateOf("handoff:904:lane")?.state === expected,
        "replacement uses the later detached native failure/abort instead of the first successful prompt yield");
      const row = ledger.query<{ data: string }, []>("SELECT data FROM inputs WHERE id='report:handoff:904:lane'").get();
      assert(row);
      const report: Inbound = JSON.parse(row.data);
      assert(laneSource);
      assert.deepEqual(report.route, laneSource.route);
      assert.match(report.text, new RegExp(`native outcome: ${expected}\\.`));
      assert.equal(ledger.query<{ value: string }, []>(
        "SELECT value FROM metadata WHERE key='activity-source:report:handoff:904:lane'").get()?.value, "904");
      reportReadback = { input: report, originalSourceId: "904", laneInput: stateOf("handoff:904:lane"), detachedNative: detachedLaneReceipt };
    } else {
      assert.equal(actual.isStreaming, true);
      await fs.writeFile(path.join(root, "release-lane"), "Complete the surviving lane without interruption or resubmission.\n", { mode: 0o600 });
      await until(() => stateOf("handoff:904:lane")?.state === "done", "surviving lane's unicast native receipt recovered by replacement head");
    }
    const laneEntries = parseSessionEntries(await fs.readFile(survivingLane.sessionFile, "utf8"));
    assert.equal(laneEntries.filter(entry => entry.type === "message" && entry.message.role === "user").length, 1);
    assert.equal((await events("native-events.jsonl")).filter(event => event.kind === "lane-held").length, 1);
    laneReadback = { id: survivingLane.id, pid: actual.hostPid, sessionId: actual.sessionId, sessionFile: actual.sessionFile,
      input: stateOf("handoff:904:lane"), report: reportReadback,
      nativeReceipts: laneEntries.filter(entry => entry.type === "custom" && (entry.customType === "rpc_prompt_result" || entry.customType === "rpc_agent_start")) };
  }
  await fs.writeFile(path.join(root, "release-resume"), "Complete the existing native goal.\n", { mode: 0o600 });
  let resumedCard: Approval | undefined;
  if (scenario === "settled-goal") {
    await until(async () => (await events("transport-events.jsonl")).some(event => event.kind === "show-approval"
      && event.pid === afterGateway.gateway.pid), "new native approval card from the source-bound resumed goal");
    resumedCard = (await events("transport-events.jsonl")).find(event => event.kind === "show-approval"
      && event.pid === afterGateway.gateway.pid)?.approval;
    assert(resumedCard);
    assert.deepEqual(resumedCard.route, route, "The original goal's route A, never the owner's restart route B, owns the new approval");
    assert((await successor.client.getState()).pendingUiRequests?.some(frame => frame.id === resumedCard?.requestId));
    await fs.appendFile(path.join(root, "ingress.jsonl"), `${JSON.stringify({ kind: "answer", approvalId: resumedCard.id, response: { confirmed: true }, route })}\n`);
  }
  await until(() => stateOf(resumedId)?.state === "done" && stateOf(queued.id)?.state === "done", "resumed goal completion and queued request delivery");
  await until(() => ledger?.query<{ count: number }, []>(
    "SELECT COUNT(*) AS count FROM outputs WHERE state='sent' AND text IN ('QUEUED_DELIVERED_ONCE','GOAL_COMPLETED_AFTER_NATIVE_RESTART')").get()?.count === 2,
  "both original-route goal and queued final responses durably sent");
  await until(async () => (await successor.client.getState()).isSettled, "final native quiescence");
  if (survivingLane) await until(() => stateOf("report:handoff:904:lane")?.state === "done"
    && ledger?.query<{ state: string }, [string]>("SELECT state FROM outputs WHERE id=?").get("report:handoff:904:lane:answer")?.state === "sent",
  "recovered original-route lane report completed with a durable external send receipt");
  assert.equal(await fs.readFile(path.join(root, "head/completed-effect.log"), "utf8"), "completed-once\n");
  const entries = parseSessionEntries(await fs.readFile(mainPaths.sessionFile, "utf8"));
  const envelopes = entries.flatMap(entry => {
    if (entry.type !== "message" || entry.message.role !== "user") return [];
    const content = entry.message.content;
    const text = typeof content === "string" ? content : content.filter(part => part.type === "text").map(part => part.text).join("\n");
    const envelope = nativeRequestEnvelope(text);
    return envelope ? [envelope] : [];
  });
  assert.deepEqual(envelopes.map(envelope => envelope.sourceId), survivingLane ? ["904", "901", "903", "report:handoff:904:lane"] : ["901", "903"],
    "No original user prompt or /restart prompt may be replayed; native goal RPC supplies continuation");
  const calls = entries.flatMap(entry => entry.type === "message" && entry.message.role === "assistant"
    ? entry.message.content.filter(part => part.type === "toolCall") : []);
  assert.equal(calls.filter(call => call.name === "goal" && call.arguments.op === "create").length, 1);
  assert.equal(calls.filter(call => call.name === "goal" && call.arguments.op === "complete").length, 1);
  assert.equal(calls.filter(call => call.name === "goal" && call.arguments.op === "resume").length, 0, "The provider must not substitute a model tool call for the controller's goal RPC");
  const modes = entries.filter(entry => entry.type === "mode_change");
  const paused = modes.findIndex(entry => entry.mode === "goal_paused");
  assert(paused >= 0 && modes.slice(paused + 1).some(entry => entry.mode === "goal"), "The native journal must record pause followed by resume");
  const sent = (await events("transport-events.jsonl")).filter(event => event.kind === "send");
  assert.equal(sent.filter(event => event.output?.id === "902:restart-ack").length, 1);
  assert.equal(sent.filter(event => event.output?.text === "QUEUED_DELIVERED_ONCE").length, 1);
  assert.deepEqual(sent.find(event => event.output?.text === "QUEUED_DELIVERED_ONCE")?.output?.route, queuedRoute);
  assert.equal(sent.filter(event => event.output?.text === "GOAL_COMPLETED_AFTER_NATIVE_RESTART").length, 1);
  assert.deepEqual(sent.find(event => event.output?.text === "GOAL_COMPLETED_AFTER_NATIVE_RESTART")?.output?.route, route);
  if (detachedLane) {
    assert(survivingLane);
    assert(laneSource);
    assert.equal(stateOf("handoff:904:lane")?.state, abortedLane ? "cancelled" : "uncertain");
    assert.equal(sent.filter(event => event.output?.text === "LANE_REPORT_DELIVERED").length, 1);
    assert.deepEqual(sent.find(event => event.output?.text === "LANE_REPORT_DELIVERED")?.output?.route, laneSource.route);
    assert.equal((await events("native-events.jsonl")).filter(event => event.kind === "lane-detached-continuation").length, 1);
  }
  if (scenario === "quarantine") {
    assert(card);
    const attempted = (await events("native-events.jsonl")).filter(event => event.kind === "native-ui-wire-attempt"
      && event.frame?.id === card?.requestId && event.frame.confirmed === true);
    assert.equal(attempted.length, 1, "Neither reconnect nor successor/stale ingress may replay the quarantined original native answer");
  }
  if (resumedCard) {
    await until(() => ledger?.query<{ delivered_at: number | null }, [string]>(
      "SELECT delivered_at FROM gateway_events WHERE identity=?").get(`answer:${resumedCard?.id}`)?.delivered_at != null,
    "resumed original-route approval answer durably receipted");
    const answer = ledger.query<{ delivered_at: number | null; delivery_error: string | null }, [string]>(
      "SELECT delivered_at,delivery_error FROM gateway_events WHERE identity=?").get(`answer:${resumedCard.id}`);
    assert(answer?.delivered_at !== null && answer?.delivered_at !== undefined);
    assert.equal(answer.delivery_error, null);
    assert.deepEqual((await events("native-events.jsonl")).filter(event => event.kind === "resumed-question-result")
      .map(event => ({ confirmed: event.confirmed, sessionId: event.sessionId })), [{ confirmed: true, sessionId: before.sessionId }]);
    assert.equal((await events("transport-events.jsonl")).filter(event => event.kind === "show-approval" && event.approval?.id === resumedCard?.id).length, 1);
  }
  assert(ledger);
  assert.equal(ledger.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM metadata WHERE key LIKE 'gateway:restart:%'").get()?.count, 1);
  const transport = await events("transport-events.jsonl");
  assert.equal(transport.filter(event => event.kind === "process-start" && event.role === "gateway").length, 2);
  assert.equal(transport.filter(event => event.kind === "process-start" && event.role === "runner").length, 1);
  assert.deepEqual(transport.filter(event => event.kind === "fixture-error"), []);
  await until(async () => (await events("transport-events.jsonl")).some(event => event.kind === "runner-exit"), "one-shot restart runner exit");
  assert.equal((await events("native-events.jsonl")).filter(event => event.kind === "native-start").length, survivingLane ? 3 : 2);
  assert.deepEqual(await fs.readFile(path.join(root, "agent/config.yml")), settingsBytes, "No global/shared native settings may change");
  const ackReadback = ledger.query<{ id: string; source_id: string; state: string; remote_id: string | null; route: string }, [string]>(
    "SELECT id,source_id,state,remote_id,route FROM outputs WHERE id=?").get(receipt.ackOutputId);
  assert(ackReadback);
  assert.equal(ackReadback.state, "sent");
  assert.equal(ackReadback.remote_id, "restart-native-remote:902:restart-ack");
  const recoveredInput = stateOf(resumedId);
  const queuedInput = stateOf(queued.id);
  const finalNativeState = await successor.client.getState();
  const nativeReceipts = entries.filter(entry => entry.type === "custom" && entry.customType === "rpc_prompt_result");
  const completedFileEffects = (await fs.readFile(path.join(root, "head/completed-effect.log"), "utf8")).split("\n").filter(Boolean);
  const locations = {
    root, evidence: path.join(root, "evidence.json"), coordination: path.join(root, "coordination.sqlite"),
    nativeSession: mainPaths.sessionFile, transportEvents: path.join(root, "transport-events.jsonl"),
    nativeEvents: path.join(root, "native-events.jsonl"), ingress: path.join(root, "ingress.jsonl"),
    effect: path.join(root, "head/completed-effect.log"), config: config.path,
  };
  evidence = {
    scenario, requestId: receipt.requestId, gatewayRestartReceipt: receipt, survivingLane: laneReadback,
    processes: { oldGatewayPid: beforeGateway.gateway.pid, gatewayPid: afterGateway.gateway.pid,
      oldHeadPid: before.hostPid, headPid: after.hostPid },
    native: { sessionId: before.sessionId, sessionFile: before.sessionFile,
      model: after.model && { provider: after.model.provider, id: after.model.id }, effort: after.thinkingLevel,
      goalBefore: before.goal, goalResumed: after.goal, goalFinal: finalNativeState.goal ?? null },
    ack: { outputId: receipt.ackOutputId, remoteId: ackReadback.remote_id, route: restartRoute,
      sendStartedAt: ack.at, sendReturnedAt: transport.find(event => event.kind === "send-returned" && event.outputId === receipt.ackOutputId)?.at,
      sentStateReadbackAt: aborted?.at, sentStateReadback: aborted?.ack, durableOutputReadback: ackReadback,
      oldHeadAliveAtSend: ack.headAlive },
    recovery: { inputId: resumedId, input: recoveredInput, originalInputId: original.id,
      originalNativeRequestId: originalAdmission.request_id, originalInput: stateOf(original.id),
      queuedInputId: queued.id, queuedInput, goalModeEntries: modes,
      nativeJournalReceipts: nativeReceipts, goalCompletionEntries: entries.filter(entry => entry.type === "custom" && entry.customType === "goal-completed") },
    beforeRestart: before, resumedState: after,
    newApproval: resumedCard ?? null,
    headRestartCheckpoint: metadata("head:restart:902"),
    approval: card ? { id: card.id, nativeRequestId: card.requestId, remoteId: `restart-native-card:${card.id}`, route: card.route,
      answerReceipt: ledger.query<{ delivery_error: string; delivered_at: number }, [string]>(
        "SELECT delivery_error,delivered_at FROM gateway_events WHERE identity=?").get(`answer:${card.id}`) } : null,
    counts: { originalPrompts: envelopes.filter(envelope => envelope.sourceId === original.id).length,
      queuedPrompts: envelopes.filter(envelope => envelope.sourceId === queued.id).length,
      restartPrompts: envelopes.filter(envelope => envelope.sourceId === restart.id).length,
      originalCompletedFileEffects: completedFileEffects.length, queuedMessengerEffects: sent.filter(event => event.output?.text === "QUEUED_DELIVERED_ONCE").length,
      restartAcks: sent.filter(event => event.output?.id === receipt.ackOutputId).length,
      gatewayProcesses: transport.filter(event => event.kind === "process-start" && event.role === "gateway").length,
      restartRunners: transport.filter(event => event.kind === "process-start" && event.role === "runner").length },
    paths: Object.fromEntries(Object.entries(locations).map(([name, location]) => [name, { path: location, uri: pathToFileURL(location).href }])),
  };
  }
} catch (error) {
  console.error(`Native restart ${scenario} proof failed; retained diagnostics at ${root}\n${String(error)}`);
  for (const name of ["transport-events.jsonl", "native-events.jsonl", "logs/gateway.log", "logs/main.log"]) {
    if (existsSync(path.join(root, name))) console.error(`${name}:\n${(await fs.readFile(path.join(root, name), "utf8")).slice(-16_000)}`);
  }
  throw error;
} finally {
  try { cleanupReceipt = await cleanup(); }
  finally { process.off("SIGTERM", terminate); process.off("SIGINT", terminate); }
}
assert(evidence && cleanupReceipt);
const result = { ...evidence, cleanup: cleanupReceipt };
const nativeEvents = await events("native-events.jsonl");
const sessionFiles = new Set([mainPaths.sessionFile, ...nativeEvents.flatMap(event => event.sessionFile ? [event.sessionFile] : [])]);
const nativeSessions = [];
for (const sessionFile of sessionFiles) {
  assert(sessionFile.startsWith(path.join(root, "sessions") + path.sep));
  nativeSessions.push({ sessionFile, entries: parseSessionEntries(await fs.readFile(sessionFile, "utf8")) });
}
const receipts = new Database(path.join(root, "coordination.sqlite"), { readonly: true, strict: true });
try {
  await fs.writeFile(path.join(root, "evidence.json"), `${JSON.stringify({ ...result, raw: {
    routes: { original: route, restart: restartRoute, queued: queuedRoute },
    ingress: (await fs.readFile(path.join(root, "ingress.jsonl"), "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line)),
    nativeEvents, transportEvents: await events("transport-events.jsonl"), nativeSessions,
    inputs: receipts.query("SELECT * FROM inputs ORDER BY sequence").all(),
    outputs: receipts.query("SELECT * FROM outputs ORDER BY sequence").all(),
    approvals: receipts.query("SELECT * FROM approvals ORDER BY sequence").all(),
    gatewayEvents: receipts.query("SELECT * FROM gateway_events ORDER BY sequence").all(),
    checkpoints: receipts.query("SELECT key,value FROM metadata WHERE key LIKE 'head:restart%' OR key LIKE 'head:goal%' OR key LIKE 'gateway:restart%' OR key LIKE 'approval:restart-cancel:%' OR key IN ('gateway:operator-stop','gateway:head','gateway:socket') ORDER BY key").all(),
    remainingProcesses: cleanupReceipt.remainingProcesses,
  } })}\n`, { mode: 0o600 });
} finally { receipts.close(); }
console.log(JSON.stringify(result));
