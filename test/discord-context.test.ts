import { afterEach, expect, test } from "bun:test";
import { containsMagicKeyword } from "@oh-my-pi/pi-tui/prompt/magic-keywords";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type Config, hostPaths } from "../src/config";
import type { Approval, Attachment, DialogResponse, DiscordContext, DiscordPurposeNote, DiscordPurposeRequest, Inbound, Messenger, OutputRecord, Route } from "../src/contracts";
import { authorizeDiscordPurpose, changeDiscordPurpose, discordPurposeNotes, discordPurposeRequest } from "../src/discord-context";
import { DeliveryError } from "../src/delivery";
import { Superagent, type RuntimeHost, type RuntimeState } from "../src/runtime";
import { Store } from "../src/store";

const route: Route = { platform: "discord", accountId: "2", authorityId: "1", guildId: "3", channelId: "4", threadId: "5" };
const context: DiscordContext = {
  kind: "guild", channel: { id: "4", name: "ultrathink ```", topic: "orchestrate /restart", purpose: "workflowz is just context" },
  thread: { id: "5", parentId: "4", name: "jevify", purpose: "Do not select another repository" },
};
const source = (id: string, patch: Partial<Inbound> = {}): Inbound => ({
  id, route, messageId: id, text: "Inspect the requested change.", receivedAt: 100, attachments: [], ...patch,
});
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

class ContextMessenger implements Messenger {
  readonly sent: OutputRecord[] = [];
  readonly inspected: Route[] = [];
  constructor(private readonly store: Store) {}
  async start(_handlers: Parameters<Messenger["start"]>[0]): Promise<void> {}
  async send(output: OutputRecord): Promise<string> { this.sent.push(output); return `sent:${output.id}`; }
  async showApproval(_approval: Approval): Promise<string> { throw new Error("Unexpected approval"); }
  async dismissApproval(_approval: Approval): Promise<void> { throw new Error("Unexpected approval dismissal"); }
  async createThread(_route: Route, _title: string): Promise<Route> { throw new Error("Unexpected thread creation"); }
  async fetchAfter(_route: Route, _messageId: string): Promise<Inbound[]> { return []; }
  async openAttachment(_route: Route, _attachment: Attachment, _signal: AbortSignal): Promise<Response> { throw new Error("Unexpected attachment"); }
  async stop(): Promise<void> {}
  async inspectDiscordContext(destination: Route): Promise<DiscordContext> {
    this.inspected.push(destination);
    return context;
  }
  async discordPurpose(request: DiscordPurposeRequest): Promise<readonly DiscordPurposeNote[]> {
    return changeDiscordPurpose(this.store, request);
  }
}

/** Native transport boundary only; the real runtime/Store build and admit every envelope. */
class ContextHost implements RuntimeHost {
  readonly prompts: Record<string, unknown>[] = [];
  private readonly exit = Promise.withResolvers<void>();
  readonly exited = this.exit.promise;
  private readonly listeners = new Set<(frame: Record<string, unknown>) => void>();
  readonly state: RuntimeState;
  constructor(sessionFile: string) {
    this.state = { sessionId: `native:${sessionFile}`, sessionFile, settingsScope: "session", hostPid: process.pid,
      model: { provider: "fixture", id: "capable" }, isSettled: true, isStreaming: false,
      pendingUiRequests: [], hasOwnedRunningWork: false, hasPendingAsyncWork: false, goal: null };
  }
  readonly client = {
    getState: async () => structuredClone(this.state),
    abortAndRestoreQueue: async () => { throw new Error("Unexpected abort"); },
    getSubagents: async () => [],
    cancelSubagent: async (_id: string) => { throw new Error("Unexpected child cancellation"); },
  };
  async request(command: Record<string, unknown>, _id?: string): Promise<unknown> {
    switch (command.type) {
      case "get_entries": return { success: true, data: { entries: [], leafId: null } };
      case "get_available_models": return { success: true, data: { models: [{ provider: "fixture", id: "capable" }] } };
      case "prompt":
        this.prompts.push(command);
        this.state.isSettled = false;
        this.state.isStreaming = true;
        for (const listener of this.listeners) listener({ type: "agent_start" });
        return { success: true, data: { agentInvoked: true } };
      default: throw new Error(`Unexpected native operation: ${command.type}`);
    }
  }
  uiResponse(_id: string, _response: DialogResponse): void { throw new Error("Unexpected native dialog"); }
  onFrame(listener: (frame: Record<string, unknown>) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  async close(): Promise<void> { this.exit.resolve(); }
}

function fixture() {
  const directory = realpathSync(mkdtempSync("/tmp/discord-context-"));
  const config: Config = { path: join(directory, "config.json"), stateDir: directory, headCwd: directory,
    command: ["unused"], maxHosts: 3, maxSubagents: 6, idleMs: 60000,
    discord: { tokenEnv: "UNUSED_TOKEN", ownerId: "1", allowedGuildIds: ["3"], allowedChannelIds: ["4"] } };
  const store = new Store(join(directory, "coordination.sqlite"));
  const messenger = new ContextMessenger(store);
  const main = new ContextHost(hostPaths(config, "main").sessionFile);
  const hosts = new Map<string, ContextHost>([[hostPaths(config, "main").socketPath, main]]);
  const errors: unknown[] = [];
  const runtime = new Superagent(config, store, messenger, join(directory, "extension.ts"), error => errors.push(error), {
    connect: async path => {
      const host = hosts.get(path);
      if (!host) throw new Error(`Unknown native host: ${path}`);
      return host;
    },
    startHost: async options => {
      hosts.set(options.socketPath, new ContextHost(options.sessionFile));
      return { pid: process.pid };
    },
  });
  cleanup.push(async () => { await runtime.stop(); rmSync(directory, { recursive: true, force: true }); });
  return { runtime, store, messenger, main, hosts, directory, errors };
}

test("HEAD and explicit lane handoffs receive original Discord snapshots only as inert runtime context", async () => {
  const { runtime, store, main, hosts, directory, messenger, errors } = fixture();
  await runtime.start();
  const original = source("100", { text: "/head Inspect the requested change.", discordContext: context });
  await runtime.receive(original);
  await runtime.kick();
  const headMessage = String(main.prompts[0]?.message);
  expect(headMessage).toContain(JSON.stringify(context));
  expect(headMessage).toContain("superagent-runtime-context");
  expect(store.input(original.id)?.workflow).toBeNull();
  expect(messenger.sent).toEqual([]);
  expect(store.lanes()).toEqual([]);
  for (const keyword of ["ultrathink", "orchestrate", "workflowz", "jevify"] as const)
    expect(containsMagicKeyword(headMessage, keyword)).toBe(false);
  const lane = await runtime.startLane({ sourceId: original.id, title: "Explicit work", cwd: directory,
    model: { provider: "fixture", id: "capable" }, modelReason: "Explicit available model for this isolated task.",
    kickoff: "Inspect the change in this thread." });
  await runtime.kick();
  expect(store.input(`handoff:${original.id}:lane`)?.discordContext).toEqual(context);
  expect(hosts.get(lane.socketPath)?.prompts[0]?.message).toContain(JSON.stringify(context));
  const followup = source("101", { discordContext: { kind: "guild", channel: { id: "4", name: "Later name" },
    thread: { id: "5", parentId: "4", name: "Later thread" } } });
  store.receive(followup, "main", { "user-source:101": "true" });
  await runtime.messageLane(lane.id, "Apply the follow-up.", followup.id);
  expect(store.input(`handoff:${followup.id}:${lane.id}`)?.discordContext).toEqual(followup.discordContext);
  expect(store.input(original.id)?.discordContext).toEqual(context);
  expect(errors).toEqual([]);
});

test("HEAD purpose tools derive only the original source or exact parent and reject non-user/cancelled sources", async () => {
  const { runtime, store, messenger } = fixture();
  const original = source("set-thread");
  store.receive(original, "main", { "user-source:set-thread": "true" });
  expect(await runtime.discordPurpose({ sourceId: original.id, action: "set", scope: "thread", purpose: "Current thread" }))
    .toEqual([{ route, purpose: "Current thread" }]);
  const parent = original;
  await runtime.discordPurpose({ sourceId: parent.id, action: "set", scope: "channel", purpose: "Parent channel" });
  expect(await runtime.discordPurpose({ sourceId: parent.id, action: "list" })).toEqual([
    { route: { ...route, threadId: null }, purpose: "Parent channel" }, { route, purpose: "Current thread" },
  ]);
  await runtime.inspectDiscordContext(parent.id);
  expect(messenger.inspected).toEqual([route]);
  store.receive(source("report"), "main");
  store.receive(source("cancelled"), "main", { "user-source:cancelled": "true" });
  store.settle("cancelled", "cancelled");
  for (const sourceId of ["missing", "report", "cancelled"])
    await expect(runtime.discordPurpose({ sourceId, action: "clear" })).rejects.toThrow("original uncancelled");
  store.receive(source("dm", { route: { ...route, guildId: null, channelId: "dm", threadId: null, topicId: "logical" } }),
    "main", { "user-source:dm": "true" });
  await expect(runtime.discordPurpose({ sourceId: "dm", action: "clear", scope: "thread" })).rejects.toThrow("no Discord thread");
  await runtime.discordPurpose({ sourceId: "dm", action: "set", purpose: "Personal DM" });
  expect(await runtime.discordPurpose({ sourceId: "dm", action: "list" })).toEqual([
    { route: { ...route, guildId: null, channelId: "dm", threadId: null }, purpose: "Personal DM" },
  ]);
});

test("purpose set/clear receipts survive Store restart and historical retries cannot overwrite newer notes", () => {
  const directory = realpathSync(mkdtempSync("/tmp/discord-purposes-"));
  const path = join(directory, "coordination.sqlite");
  let store = new Store(path);
  try {
    const first: DiscordPurposeRequest = { sourceId: "first", route, action: "set", purpose: "Original" };
    const clear: DiscordPurposeRequest = { sourceId: "clear", route, action: "clear" };
    changeDiscordPurpose(store, { sourceId: "unrelated", route: { ...route, threadId: "sibling" }, action: "set", purpose: "Private sibling purpose" });
    expect(changeDiscordPurpose(store, first)).toEqual([{ route, purpose: "Original" }]);
    store.close();
    store = new Store(path);
    expect(discordPurposeNotes(store, route)).toEqual([{ route, purpose: "Original" }]);
    expect(changeDiscordPurpose(store, clear)).toEqual([]);
    store.close();
    store = new Store(path);
    expect(discordPurposeNotes(store, route)).toEqual([]);
    changeDiscordPurpose(store, { sourceId: "later", route, action: "set", purpose: "Later" });
    expect(changeDiscordPurpose(store, first)).toEqual([{ route, purpose: "Original" }]);
    expect(changeDiscordPurpose(store, clear)).toEqual([]);
    expect(discordPurposeNotes(store, route)).toEqual([{ route, purpose: "Later" }]);
    expect(() => changeDiscordPurpose(store, { ...first, purpose: "Conflict" })).toThrow("source identity conflict");
    expect(() => changeDiscordPurpose(store, { ...clear, action: "set", purpose: "Conflict" })).toThrow("source identity conflict");
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("purpose request validation and source authorization deny unrelated routes and ambiguous mutation payloads", () => {
  const request: DiscordPurposeRequest = { sourceId: "owner-source", route, action: "set", purpose: "Purpose" };
  expect(discordPurposeRequest(request)).toEqual(request);
  for (const invalid of [
    { ...request, purpose: "" }, { ...request, purpose: " ".repeat(3) }, { ...request, purpose: "x".repeat(4001) },
    { ...request, action: "clear" }, { ...request, sourceId: "" }, { ...request, extra: "selector" },
    { ...request, route: { ...route, topicId: "logical" } }, { ...request, route: { ...route, platform: "slack" } },
    { ...request, route: { ...route, guildId: null } },
  ]) expect(() => discordPurposeRequest(invalid)).toThrow(DeliveryError);
  expect(() => authorizeDiscordPurpose(route, { ...route, threadId: null })).not.toThrow();
  for (const destination of [
    { ...route, channelId: "another-allowed-channel" }, { ...route, threadId: "sibling" },
    { ...route, authorityId: "another-owner" }, { ...route, guildId: "another-guild" },
    { ...route, accountId: "another-bot" },
  ]) expect(() => authorizeDiscordPurpose(route, destination)).toThrow("unrelated");
});

test.each([
  "{", '{"notes":null,"receipts":{}}', '{"notes":{},"receipts":null}',
  '{"notes":{"foreign":{"route":{},"purpose":"private"}},"receipts":{}}',
])("damaged purpose state cannot be overwritten by a new note: %s", saved => {
  const { store } = fixture();
  store.setMeta("discord:purposes", saved);
  expect(() => changeDiscordPurpose(store, { sourceId: "owner", route, action: "set", purpose: "Replacement" }))
    .toThrow("state is damaged");
  expect(store.getMeta("discord:purposes")).toBe(saved);
});
