import assert from "node:assert/strict";
import type { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseSessionEntries } from "@oh-my-pi/pi-coding-agent";
import { hostPaths, type Config } from "../../src/config";
import type { Inbound, Messenger, OutputRecord, Route } from "../../src/contracts";
import type { GatewayService } from "../oracles/bun-gateway/gateway";
import { HostConnection } from "../../src/host";
import { nativeRequestEnvelope } from "./native-request-envelope";

interface Event {
  kind: string;
  pid: number;
  inputId?: string;
  snapshot?: { inputId: string; attemptId: string; evidenceEntryIds: string[] };
}

export async function runNativeRecoveryProof(options: {
  root: string; config: Config; db: Database; gateway: GatewayService;
  messenger: Messenger & { sent: OutputRecord[]; deliver(input: Inbound): Promise<void> };
  connections: Set<HostConnection>; owned: Map<number, { socketPath: string; sessionFile: string }>;
  until(predicate: () => boolean | Promise<boolean>, label: string): Promise<void>;
}): Promise<void> {
  const { root, config, db, gateway, messenger, connections, owned, until } = options;
  const main = hostPaths(config, "main");
  const head = await HostConnection.connect(main.socketPath);
  connections.add(head);
  const original = await head.client.getState();
  assert(original.hostPid);
  owned.set(original.hostPid, main);
  assert.equal(original.settingsScope, "session");
  assert.equal(original.model?.provider, "gateway-native");
  assert.equal(original.goal, null);
  const route: Route = { platform: "discord", accountId: "2", authorityId: "1", guildId: "3", channelId: "4", threadId: "80" };
  const input = (id: string, text: string): Inbound => ({
    id, messageId: id, route, text, receivedAt: Date.now(), attachments: [],
  });
  const headInput = (id: string) => input(id, `/head Native recovery request ${id}`);
  const state = (id: string) => (db.query("SELECT state FROM inputs WHERE id=?").get(id) as { state: string } | null)?.state;
  const events = async (): Promise<Event[]> => {
    const text = await fs.readFile(path.join(root, "recovery-events.jsonl"), "utf8").catch(error => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    return text.slice(0, text.lastIndexOf("\n") + 1).split("\n").filter(Boolean).map(line => JSON.parse(line));
  };
  const entries = async () => parseSessionEntries(await fs.readFile(main.sessionFile, "utf8"));
  const recoveryCalls = async (id: string) => (await events()).filter(event => event.kind === "recovery-model" && event.snapshot?.inputId === id);
  const waitSettled = (label: string) => until(async () => {
    const actual = await head.client.getState();
    return actual.isSettled && !actual.isStreaming && !actual.hasOwnedRunningWork && !actual.hasPendingAsyncWork;
  }, label);
  const status = async (id: string) => {
    await messenger.deliver(input(id, "/status"));
    await until(() => state(id) === "done" && messenger.sent.some(output => output.sourceId === id), `status control ${id}`);
  };

  await messenger.deliver(headInput("801"));
  await until(async () => (await recoveryCalls("801")).length === 1, "same HEAD model receives original durable completion evidence");
  assert.equal(state("801"), "uncertain");
  await messenger.deliver(headInput("802"));
  await until(() => state("802") === "pending", "later ordinary input is durably held throughout recovery");
  assert.equal(await fs.readFile(path.join(root, "original-effect-801"), "utf8"), "Original native effect 801\n");
  const during = await head.client.getState();
  assert.equal(during.hostPid, original.hostPid);
  assert.equal(during.sessionId, original.sessionId);
  assert.deepEqual(during.model, original.model);
  await fs.writeFile(path.join(root, "release-recovery"), "verified queued hold", { mode: 0o600 });
  await until(() => {
    const saved = db.query("SELECT value FROM metadata WHERE key='head:recovery:801'").get() as { value: string } | null;
    const attempt = saved ? JSON.parse(saved.value) as { state: string; decision?: { decision: string } } : null;
    assert(!(attempt?.state === "settled" && attempt.decision?.decision === "hold"),
      `Native evidence-backed release was refused: ${saved?.value}`);
    return state("801") === "done" && state("802") === "done"
      && messenger.sent.some(output => output.text === "HEAD:802");
  }, "validated HEAD decision releases later work after its native turn settles");
  await waitSettled("native recovery and queued reply settle");
  const decisionEntries = (await entries()).filter(entry => entry.type === "message" && entry.message.role === "assistant")
    .flatMap(entry => entry.type === "message" && entry.message.role === "assistant"
      ? entry.message.content.filter(part => part.type === "toolCall" && part.name === "head_recovery") : []);
  assert.equal(decisionEntries.length, 1, "The actual model must invoke the production recovery tool");
  const first = (await recoveryCalls("801"))[0]!;
  assert(first.snapshot?.evidenceEntryIds.length);
  assert.equal(first.pid, original.hostPid);
  assert(messenger.sent.some(output => output.sourceId === "801"), "Reconciliation is reported on the original request");
  assert(messenger.sent.every(output => JSON.stringify(output.route) === JSON.stringify(route)));
  const originalOutputs = messenger.sent.filter(output => output.sourceId === "801").map(output => output.id);
  await messenger.deliver(headInput("801"));
  await status("810");
  await waitSettled("duplicate delivery and status leave recovery settled");
  assert.equal((await recoveryCalls("801")).length, 1);
  assert.deepEqual(messenger.sent.filter(output => output.sourceId === "801").map(output => output.id), originalOutputs,
    "Duplicate ingress and lifecycle reads cannot resend a reconciliation notification");

  await messenger.deliver(headInput("803"));
  await until(() => state("803") === "uncertain", "lost admission remains uncertain without a native receipt");
  await messenger.deliver(headInput("804"));
  await until(() => state("804") === "pending", "missing original receipt fences ordinary work");
  await waitSettled("missing receipt does not create speculative native execution");
  await status("811");
  assert.equal(state("803"), "uncertain");
  assert.equal(state("804"), "pending");
  assert.equal((await recoveryCalls("803")).length, 0);
  assert(messenger.sent.some(output => output.sourceId === "811" && output.text.includes('"803"')));
  assert.equal((await events()).filter(event => event.kind === "unadmitted-prompt").length, 1);
  await messenger.deliver(input("812", "/resolve 803"));
  await until(() => state("803") === "cancelled" && state("804") === "done", "owner escape hatch remains usable after automatic hold");

  await messenger.deliver(headInput("805"));
  await until(async () => (await recoveryCalls("805")).length === 1, "restricted recovery reaches adversarial tool call");
  await waitSettled("blocked recovery tool ends its isolated native turn");
  await messenger.deliver(headInput("806"));
  await status("813");
  assert.equal(state("805"), "uncertain");
  assert.equal(state("806"), "pending");
  assert.equal(await fs.stat(path.join(root, "unauthorized-recovery-write")).then(() => true, error => {
    if (error.code === "ENOENT") return false;
    throw error;
  }), false, "Recovery must not execute a model-requested filesystem mutation");
  assert.equal((await recoveryCalls("805")).length, 1);
  await messenger.deliver(input("814", "/resolve 805"));
  await until(() => state("805") === "cancelled" && state("806") === "done", "manual resolution releases rejected recovery without replay");
  await waitSettled("all original and control requests settle");

  const journal = await entries();
  const denied = journal.flatMap(entry => entry.type === "message" && entry.message.role === "toolResult"
    && entry.message.toolCallId.startsWith("recovery-escape:") ? [entry.message] : []);
  assert.equal(denied.length, 1, "The real native executor must record the recovery tool restriction");
  assert.equal(denied[0]!.isError, true);
  assert.match(JSON.stringify(denied[0]!.content), /recovery/i);
  const originalRequests = journal.flatMap(entry => {
    if (entry.type !== "message" || entry.message.role !== "user") return [];
    const content = entry.message.content;
    const text = typeof content === "string" ? content : content.filter(part => part.type === "text").map(part => part.text).join("");
    const requestId = nativeRequestEnvelope(text)?.requestId;
    return requestId ? [requestId] : [];
  });
  assert.deepEqual(originalRequests, ["801", "802", "804", "805", "806"], "No lost original prompt is replayed");
  const effects = journal.flatMap(entry => entry.type === "message" && entry.message.role === "toolResult"
    && entry.message.toolCallId.startsWith("original-effect:") ? [entry.message] : []);
  assert.equal(effects.length, 2);
  assert(effects.every(effect => !effect.isError));
  assert.equal(await fs.readFile(path.join(root, "original-effect-805"), "utf8"), "Original native effect 805\n");
  assert.deepEqual(db.query("SELECT id FROM lanes").all(), [], "Recovery creates no independent lane or supervisor");
  const final = await head.client.getState();
  assert.equal(final.hostPid, original.hostPid);
  assert.equal(final.sessionId, original.sessionId);
  assert.deepEqual(final.model, original.model);
  assert.deepEqual(final.pendingUiRequests, []);
  await gateway.stop();
  const shutdowns = (await entries()).filter(entry => entry.type === "custom" && entry.customType === "omp-superagent-native-test");
  assert.equal(shutdowns.length, 1);
  assert.equal((shutdowns[0] as { data: { networkAttempts: number } }).data.networkAttempts, 0);
}
