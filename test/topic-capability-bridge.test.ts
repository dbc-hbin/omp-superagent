import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../src/config";
import type { Approval, Attachment, Inbound, OutputRecord, Route, ThreadInfo, ThreadUpdate } from "../src/contracts";
import type { DownloadMessenger as Messenger } from "./fixtures/inbound-attachments";
import { DeliveryError } from "../src/delivery";
import { createGatewayMessenger } from "../src/gateway-client";
import { gatewayCall, gatewayPaths } from "../src/gateway-protocol";
import { GatewayServer } from "./oracles/bun-gateway/gateway-server";
import type { GatewayStatus } from "../src/gateway-wire";
import { GatewayStore } from "./oracles/bun-gateway/gateway-store";
import { MessengerHub } from "./oracles/bun-gateway/messengers";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const route: Route = {
  platform: "slack", accountId: "B1", authorityId: "T1", guildId: null,
  channelId: "C1", threadId: null, topicId: "head-owned-topic",
};

class CapabilityTransport implements Messenger {
  readonly checked: Route[] = [];
  readonly mutations: string[] = [];
  readonly canCreateThread?: (destination: Route) => Promise<boolean>;

  constructor(capability?: (destination: Route) => Promise<boolean>) {
    if (capability) this.canCreateThread = async destination => {
      this.checked.push(destination);
      return capability(destination);
    };
  }
  async start(_handlers: Parameters<Messenger["start"]>[0]) {}
  async stop() {}
  async send(_output: OutputRecord): Promise<string> { this.mutations.push("send"); throw new Error("Unexpected send"); }
  async showApproval(_approval: Approval): Promise<string> { this.mutations.push("showApproval"); throw new Error("Unexpected approval"); }
  async dismissApproval(_approval: Approval): Promise<void> { this.mutations.push("dismissApproval"); throw new Error("Unexpected dismissal"); }
  async createThread(_destination: Route, _title: string, _sourceMessageId?: string, _appliedTags?: readonly string[]): Promise<Route> { this.mutations.push("createThread"); throw new Error("Unexpected thread creation"); }
  async fetchAfter(_destination: Route, _cursor: string): Promise<Inbound[] | null> { throw new Error("Unexpected history read"); }
  async openAttachment(_destination: Route, _attachment: Attachment, _signal: AbortSignal): Promise<Response> { throw new Error("Unexpected attachment read"); }
}

async function fixture(messenger: Messenger) {
  const root = await mkdtemp(join(await realpath("/tmp"), "ocap-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "run"), { mode: 0o700 });
  const config: Config = {
    path: join(root, "config.json"), stateDir: root, headCwd: root,
    command: ["unused"], maxHosts: 2, maxSubagents: 4, idleMs: 1000,
  };
  const store = new GatewayStore(root);
  cleanups.push(async () => store.close());
  const server = new GatewayServer({
    socketPath: gatewayPaths(config).socketPath, store, messenger,
    downloadAttachment: messenger.openAttachment.bind(messenger),
    authorizeHead: async pid => {
      if (pid !== process.pid) throw new DeliveryError("Foreign native owner", "rejected");
    },
    status: (): GatewayStatus => ({
      gateway: { pid: process.pid, ready: true, admissionReady: server.ready, pendingEvents: store.pending(), stopping: false },
      head: { pid: process.pid, ready: server.headReady, connected: server.connected, socketPath: join(root, "run", "main.sock"), error: null },
    }),
    stop: async () => {}, onError: () => {},
  });
  await server.listen();
  cleanups.push(() => server.close());
  const saved = process.env.OMP_SUPERAGENT_GATEWAY_TOKEN;
  let client: ReturnType<typeof createGatewayMessenger>;
  try {
    process.env.OMP_SUPERAGENT_GATEWAY_TOKEN = store.token();
    client = createGatewayMessenger(config);
  } finally {
    if (saved === undefined) delete process.env.OMP_SUPERAGENT_GATEWAY_TOKEN;
    else process.env.OMP_SUPERAGENT_GATEWAY_TOKEN = saved;
  }
  cleanups.push(() => client.stop());
  return { client, store, socket: gatewayPaths(config).socketPath };
}

test("hub capability checks preserve the original route and never create a thread to probe support", async () => {
  const slack = new CapabilityTransport(async destination => destination.threadId === null);
  const telegram = new CapabilityTransport();
  const hub = new MessengerHub({ slack, telegram });
  expect(await hub.canCreateThread(route)).toBe(true);
  const threaded = { ...route, threadId: "123.456" };
  expect(await hub.canCreateThread(threaded)).toBe(false);
  expect(slack.checked[0]).toBe(route);
  expect(slack.checked[1]).toBe(threaded);
  expect(await hub.canCreateThread({ ...route, platform: "telegram" })).toBe(false);
  expect(() => hub.canCreateThread({ ...route, platform: "discord" })).toThrow("not configured");
  expect(telegram.checked).toEqual([]);
  expect(slack.mutations).toEqual([]);
  expect(telegram.mutations).toEqual([]);
});

test("gateway forwards capability checks through the hub with the unchanged source route", async () => {
  const slack = new CapabilityTransport(async destination => destination.threadId === null);
  const telegram = new CapabilityTransport(async () => true);
  const f = await fixture(new MessengerHub({ slack, telegram }));
  await f.client.start({ message: async () => {}, answer: async () => {} });
  expect(await f.client.canCreateThread!(route)).toBe(true);
  const threaded = { ...route, threadId: "123.456" };
  expect(await f.client.canCreateThread!(threaded)).toBe(false);
  expect(slack.checked).toEqual([route, threaded]);
  expect(telegram.checked).toEqual([]);
  expect(slack.mutations).toEqual([]);
  expect(telegram.mutations).toEqual([]);
});

test("gateway treats an injected messenger without a capability method as unsupported without creation", async () => {
  const transport = new CapabilityTransport();
  const f = await fixture(transport);
  await f.client.start({ message: async () => {}, answer: async () => {} });
  expect(await f.client.canCreateThread!(route)).toBe(false);
  expect(transport.checked).toEqual([]);
  expect(transport.mutations).toEqual([]);
});

test("gateway capability calls retain head authorization, route checks, and a fixed operation whitelist", async () => {
  const transport = new CapabilityTransport(async destination => {
    if (destination.accountId !== route.accountId || destination.authorityId !== route.authorityId)
      throw new DeliveryError("Foreign capability route", "rejected");
    return true;
  });
  const f = await fixture(transport);
  const owner = { token: f.store.token(), clientId: crypto.randomUUID() };
  const effect = (operation: string, args: unknown[]) => ({ id: crypto.randomUUID(), operation, args });
  await expect(gatewayCall(f.socket, "/effect", effect("canCreateThread", [route]), owner)).rejects.toThrow("detached");
  await expect(gatewayCall(f.socket, "/attach", { pid: process.pid }, { ...owner, token: "not-the-token" })).rejects.toThrow("authorization required");
  await expect(gatewayCall(f.socket, "/attach", { pid: process.pid + 1 }, owner)).rejects.toThrow("Foreign native owner");
  expect(transport.checked).toEqual([]);
  await gatewayCall(f.socket, "/attach", { pid: process.pid }, owner);
  const foreign = { ...route, authorityId: "foreign-workspace" };
  await expect(gatewayCall(f.socket, "/effect", effect("canCreateThread", [foreign]), owner)).rejects.toThrow("Foreign capability route");
  expect(await gatewayCall<boolean>(f.socket, "/effect", effect("canCreateThread", [route]), owner)).toBe(true);
  await expect(gatewayCall(f.socket, "/effect", effect("canCreateThread", []), owner)).rejects.toThrow("Unknown Gateway effect");
  for (const operation of ["lane_start", "lane_message", "token", "constructor", "__proto__"])
    await expect(gatewayCall(f.socket, "/effect", effect(operation, [route]), owner)).rejects.toThrow("Unknown Gateway effect");
  expect(transport.checked).toEqual([foreign, route]);
  expect(transport.mutations).toEqual([]);
});

class TopicTransport extends CapabilityTransport {
  topic: ThreadInfo | undefined;
  failure: DeliveryError | undefined;
  constructor() {
    super();
  }
  override async createThread(destination: Route, title: string, sourceMessageId?: string, appliedTags?: readonly string[]): Promise<Route> {
    if (sourceMessageId !== undefined) throw new DeliveryError("Forum source must be absent", "rejected");
    if (!appliedTags?.length) throw new DeliveryError("Tag required", "rejected");
    this.mutations.push("createThread");
    this.topic = { route: { ...destination, threadId: "101" }, title, archived: false, requiresTag: true,
      availableTags: [{ id: "201", name: "Work", moderated: false }], appliedTags };
    return this.topic.route;
  }
  async inspectThread(destination: Route): Promise<ThreadInfo> {
    if (!this.topic || destination.threadId !== this.topic.route.threadId || destination.accountId !== this.topic.route.accountId)
      throw new DeliveryError("Unknown topic", "rejected");
    return this.topic;
  }
  async updateThread(destination: Route, changes: ThreadUpdate): Promise<ThreadInfo> {
    const before = await this.inspectThread(destination);
    this.mutations.push("updateThread");
    if (this.failure) throw this.failure;
    this.topic = { ...before, ...changes };
    return this.topic;
  }
}

test("Gateway and hub preserve selected tags, omitted source IDs, partial edits and authoritative thread reads", async () => {
  const transport = new TopicTransport();
  const f = await fixture(new MessengerHub({ discord: transport }));
  await f.client.start({ message: async () => {}, answer: async () => {} });
  const parent: Route = { ...route, platform: "discord", guildId: "G1", topicId: undefined };
  const created = await f.client.createThread(parent, "Work", undefined, ["201"]);
  if (!f.client.updateThread || !f.client.inspectThread) throw new Error("Expected thread management");
  expect(await f.client.inspectThread(created)).toMatchObject({ title: "Work", appliedTags: ["201"], archived: false });
  expect(await f.client.updateThread(created, { title: "Finished", archived: true }))
    .toMatchObject({ route: created, title: "Finished", appliedTags: ["201"], archived: true });
  expect(await f.client.updateThread(created, { archived: false }))
    .toMatchObject({ title: "Finished", appliedTags: ["201"], archived: false });
  await expect(f.client.inspectThread({ ...created, accountId: "other" })).rejects.toThrow("Unknown topic");
  expect(transport.mutations).toEqual(["createThread", "updateThread", "updateThread"]);
});

test("Gateway retains uncertain thread edit receipts, rejects conflicting retries and validates mutation fields", async () => {
  const transport = new TopicTransport();
  const parent: Route = { ...route, platform: "discord", guildId: "G1" };
  const created = await transport.createThread(parent, "Work", undefined, ["201"]);
  const f = await fixture(new MessengerHub({ discord: transport }));
  const owner = { token: f.store.token(), clientId: crypto.randomUUID() };
  await gatewayCall(f.socket, "/attach", { pid: process.pid }, owner);
  transport.failure = new DeliveryError("Lost edit receipt", "uncertain");
  const edit = { id: crypto.randomUUID(), operation: "updateThread", args: [created, { archived: true }] };
  await expect(gatewayCall(f.socket, "/effect", edit, owner)).rejects.toThrow("Lost edit receipt");
  transport.failure = undefined;
  await expect(gatewayCall(f.socket, "/effect", edit, owner)).rejects.toThrow("Lost edit receipt");
  await expect(gatewayCall(f.socket, "/effect", { ...edit, args: [created, { archived: false }] }, owner)).rejects.toThrow();
  for (const changes of [{}, { archived: "true" }, { appliedTags: null }, { title: 1 }, { locked: true }]) {
    await expect(gatewayCall(f.socket, "/effect", {
      id: crypto.randomUUID(), operation: "updateThread", args: [created, changes],
    }, owner)).rejects.toBeInstanceOf(DeliveryError);
  }
  expect(transport.mutations).toEqual(["createThread", "updateThread"]);
});
