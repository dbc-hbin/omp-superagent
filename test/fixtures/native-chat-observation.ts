/** One owner chat scenario through the Rust Gateway, HEAD, and a real native lane. */
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { parseSessionEntries } from "@oh-my-pi/pi-coding-agent";
import { loadConfig } from "../../src/config";
import type { Inbound, OutputRecord, Route } from "../../src/contracts";
import { gatewayFixture, until } from "./native-rust-gateway";
import { nativeJournalDispatches } from "./native-tool-transport";

const root = process.env.OMP_NATIVE_GATEWAY_ROOT;
assert(root && process.env.HOME === join(root, "home") && process.cwd() === root);
const bin = join(root, "bin");
await mkdir(bin, { mode: 0o700 });
await mkdir(join(root, "topic"), { mode: 0o700 });
await writeFile(join(root, ".native-chat-observation"), "", { mode: 0o600 });
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
await writeFile(join(bin, "gh"), `#!/bin/sh\nexec ${shellQuote(process.execPath)} --no-env-file --no-install ${
  shellQuote(join(import.meta.dir, "native-chat-observation-gh.ts"))} "$@"\n`, { mode: 0o700 });
// The Rust daemon and both stock OMP Hosts inherit this cloned fixture PATH.
process.env.PATH = [bin, process.env.PATH ?? "/usr/bin:/bin"].join(delimiter);

const fixture = gatewayFixture(root);
let passed = false;
let cleaning: Promise<void> | undefined;
const cleanup = () => cleaning ??= fixture.cleanup(passed);
const terminate = () => { void cleanup().then(() => process.exit(143), error => {
  console.error(error); process.exit(1);
}); };
process.on("SIGTERM", terminate);

const parent: Route = { platform: "discord", accountId: "2", authorityId: "1", guildId: "3", channelId: "4", threadId: null };
const work = { ...parent, threadId: "50" };
const prChat = { ...parent, threadId: "51" };
const laneChat = { ...parent, threadId: "52" };
type Receipt = { readonly output: OutputRecord; readonly remoteId: string };
type Tool = { readonly name: string; readonly action?: string };

try {
  console.log((await fixture.sdk("prepare")).stdout.trim());
  const config = await loadConfig(fixture.config);
  assert.equal(config.model, "gateway-native/local");
  const existingProvider = join(import.meta.dir, "gateway-provider-extension.ts");
  assert.equal(config.command.filter(arg => arg === existingProvider).length, 1);
  const command = config.command.map(arg => arg === existingProvider ? join(import.meta.dir, "native-chat-observation-model.ts") : arg);
  await writeFile(fixture.config, JSON.stringify({ ...config, command }), { mode: 0o600 });
  const nativeSettingsFile = join(root, "agent", "config.yml");
  const nativeSettings = Bun.YAML.parse(await readFile(nativeSettingsFile, "utf8"));
  assert(nativeSettings && typeof nativeSettings === "object" && !Array.isArray(nativeSettings));
  // Keep a single, determinate native child call and its real result together.
  await writeFile(nativeSettingsFile, JSON.stringify({ ...nativeSettings,
    modelRoles: { default: config.model, judge: config.model, task: config.model },
    async: { enabled: false }, task: { batch: false, structured: false }, bash: { autoBackground: { enabled: false } },
  }), { mode: 0o600 });
  const instance = await fixture.start();
  using db = new Database(join(root, "coordination.sqlite"), { readonly: true, strict: true });
  const deliveredPath = join(root, "adapter-output.jsonl");
  const inputState = db.query<{ state: string }, [string]>("SELECT state FROM inputs WHERE id=?");
  const receipts = async (): Promise<Receipt[]> => existsSync(deliveredPath)
    ? (await readFile(deliveredPath, "utf8")).split("\n").slice(0, -1).map(line => JSON.parse(line)) : [];
  const delivery = async (label: string, matches: (output: OutputRecord) => boolean) => until(async () => {
    const delivered = (await receipts()).filter(({ output }) => matches(output));
    assert(delivered.length <= 1, `Duplicate visible output for ${label}`);
    if (!delivered[0]) return;
    const { output, remoteId } = delivered[0];
    const persisted = db.query<{ state: string; remote_id: string | null }, [string]>(
      "SELECT state,remote_id FROM outputs WHERE id=?",
    ).get(output.id);
    if (persisted?.state !== "sent") return;
    assert.equal(persisted.remote_id, remoteId);
    assert.equal(inputState.get(output.sourceId)?.state, "done");
    return output;
  }, label);

  const expectedCalls = new Map<string, Tool>();
  let snowflake = 94_100;
  async function request(message: { text: string; route: Route; tool: Tool }): Promise<OutputRecord> {
    const id = String(++snowflake);
    const input: Inbound = { id, messageId: id, route: message.route, text: message.text, receivedAt: Date.now(), attachments: [] };
    assert(!input.text.startsWith("/"), "Observation smoke must use ordinary owner chat");
    expectedCalls.set(input.id, message.tool);
    await fixture.deliver(input);
    const output = await delivery(input.text, row => row.id === `${id}:answer`);
    assert.equal(output.sourceId, id);
    assert.deepEqual(output.route, input.route);
    assert.deepEqual(output.replyTo, { route: input.route, messageId: id });
    return output;
  }

  for (const [text, action, desired] of [
    ["이 디스코드 봇을 온라인으로 유지해 줘.", "start", "online"],
    ["이 디스코드 봇의 접속 상태를 알려 줘.", "status", "online"],
    ["이 디스코드 봇을 오프라인으로 표시해 줘.", "stop", "invisible"],
    ["이 디스코드 봇의 지금 표시 상태를 알려 줘.", "status", "invisible"],
  ] as const) {
    const output = await request({ text, route: parent, tool: { name: "messenger_presence", action } });
    assert.equal(output.text, `디스코드 봇의 설정: ${desired} (disconnected).`);
  }

  const ref = "fixture-owner/fixture-repo#7";
  const prTrack = await request({ text: `Watch ${ref} every second and let me know here when CI changes.`,
    route: prChat, tool: { name: "pr_watch", action: "track" } });
  assert.equal(prTrack.text, `Watching ${ref} every 1s; the baseline is pending.`);
  const readPr = () => request({ text: `What is the latest CI status on ${ref}?`,
    route: prChat, tool: { name: "pr_watch_list" } });
  const prBaseline = db.query<{ ci: string | null }, []>(
    "SELECT json_extract(value,'$.watches[0].baseline.ci') AS ci FROM metadata WHERE key='pr-watch:v1'",
  );
  await until(() => prBaseline.get()?.ci === "pending" || undefined, "first quiet PR baseline with an observed pending check");
  assert.equal((await readPr()).text, `${ref} baseline CI: pending; latest CI: pending.`);
  assert.equal((await receipts()).filter(({ output }) => output.sourceId.startsWith("pr-observation:")).length, 0);
  await writeFile(join(root, "fail-fixture-ci"), "", { mode: 0o600 });
  const ci = await delivery("CI failure sent to its registration route", output => output.sourceId.startsWith("pr-observation:"));
  assert.deepEqual(ci.route, prChat);
  assert.equal(ci.text, "PR CI failed: offline-integration-build.");
  assert.equal((await readPr()).text, `${ref} baseline CI: pending; latest CI: failed.`);
  const prStop = await request({ text: `Stop watching ${ref}.`, route: prChat, tool: { name: "pr_watch", action: "untrack" } });
  assert.equal(prStop.text, `Stopped PR observation for ${ref}.`);
  assert.equal((await readPr()).text, `No active PR watch for ${ref}.`);

  const opened = await request({ text: "Start a separate lane in the fixture workspace to verify its local evidence.",
    route: work, tool: { name: "lane_start" } });
  const laneId = /^Opened independent work (lane-[a-zA-Z0-9_-]+)\.$/.exec(opened.text)?.[1];
  assert(laneId, "Expected durable lane identity from the production tool");
  await until(() => existsSync(join(root, "entered-chat-lane")) || undefined, "stock native lane at its offline model boundary");
  const watchLane = (text: string, action: string) => request({ text, route: laneChat, tool: { name: "lane_watch", action } });
  const tracked = await watchLane(`Notify me here of progress or completion for ${laneId}.`, "track");
  assert.equal(tracked.text, `Lane ${laneId}: tracking=true, work=open.`);
  await writeFile(join(root, "topic", "lane-progress"), "Verified local evidence\n", { mode: 0o600 });
  const laneNotice = async (event: string) => {
    const output = await delivery(`Lane observation for ${event}`, row =>
      row.id.startsWith("lane-watch-notice:") && row.text.includes(event));
    assert.notEqual(output.sourceId, tracked.sourceId, "The notice must not become an effect of the original owner turn");
    assert.deepEqual(output.route, laneChat);
    assert.deepEqual(output.replyTo, tracked.replyTo);
    assert(output.text.startsWith(`Lane ${laneId} observation:`));
    return output;
  };
  const progress = await laneNotice("New structured progress evidence");
  await writeFile(join(root, "finish-chat-lane"), "", { mode: 0o600 });
  const laneReport = await delivery("settled native lane report", output => output.sourceId.startsWith("report:"));
  assert.deepEqual(laneReport.route, work);
  assert.equal(laneReport.text, "The offline lane recorded verified local evidence.");
  const closed = await request({ text: `Mark ${laneId} complete; the native lane's evidence has been verified.`,
    route: laneChat, tool: { name: "lane_close" } });
  assert.equal(closed.text, `Lane ${laneId} recorded as completed.`);
  const completed = await laneNotice("recorded as completed by explicit closure");
  assert.equal((await watchLane(`What is the observation status for ${laneId}?`, "status")).text,
    `Lane ${laneId}: tracking=true, work=completed.`);
  assert.equal((await watchLane(`Stop notifying me about ${laneId}.`, "untrack")).text,
    `Lane ${laneId}: tracking=false, work=null.`);
  assert.equal((await watchLane(`Is the observation of ${laneId} still active?`, "status")).text,
    `Lane ${laneId}: tracking=false, work=null.`);

  const child = await request({ text: "Use a native child to check if it can control these observation tools.",
    route: parent, tool: { name: "task" } });
  assert.equal(child.text, "Native child has no observation manager authority.");
  const entries = parseSessionEntries(await readFile(fixture.sessionFile, "utf8"));
  const nativeCalls = nativeJournalDispatches(entries).filter(call => call.mode === "execute");
  for (const [sourceId, expected] of expectedCalls) {
    const calls = nativeCalls.filter(call => call.result.toolCallId.startsWith(`observation-proof:${sourceId}:`));
    assert.deepEqual(calls.map(call => ({ name: call.name, ok: call.ok, action: call.args?.action })), [
      { name: expected.name, ok: true, action: expected.action },
    ]);
    if (["messenger_presence", "lane_watch", "pr_watch", "pr_watch_list"].includes(expected.name))
      assert.equal(calls[0]?.args?.sourceId, sourceId, "Native manager call applied the exact original owner source");
  }
  const sent = (await receipts()).map(receipt => receipt.output);
  assert.deepEqual(sent.filter(output => output.sourceId.startsWith("pr-observation:")).map(output => output.id), [ci.id]);
  assert.deepEqual(sent.filter(output => output.id.startsWith("lane-watch-notice:")).map(output => output.id), [progress.id, completed.id]);
  await fixture.snapshot("settled");
  await fixture.stop(instance);
  passed = true;
} finally {
  try { await cleanup(); }
  finally { process.off("SIGTERM", terminate); }
}
