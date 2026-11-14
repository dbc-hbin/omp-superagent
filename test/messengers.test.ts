import { expect, test } from "bun:test";
import type { Approval, Attachment, DialogResponse, Inbound, MessageActivity, MessageReference, Messenger, OutputRecord, Platform, Route } from "../src/contracts";
import { MessengerHub } from "../src/messengers";

class Transport implements Messenger {
  handlers?: Parameters<Messenger["start"]>[0];
  readonly sent: OutputRecord[] = [];
  readonly shown: Approval[] = [];
  readonly opened: Attachment[] = [];
  readonly activities: Array<{ message: MessageReference; activity: MessageActivity }> = [];
  beforeActivity?: () => Promise<void>;
  stops = 0;
  constructor(readonly platform: Platform, readonly failStart = false) {}
  async start(handlers: Parameters<Messenger["start"]>[0]) {
    this.handlers = handlers;
    if (this.failStart) throw new Error("startup rejected");
  }
  async stop() { this.stops++; }
  async send(output: OutputRecord) { this.sent.push(output); return `${this.platform}:receipt`; }
  async setActivity(message: MessageReference, activity: MessageActivity) {
    await this.beforeActivity?.();
    this.activities.push({ message, activity });
  }
  async showApproval(approval: Approval) { this.shown.push(approval); return `${this.platform}:card`; }
  async dismissApproval(_approval: Approval) {}
  async createThread(route: Route) { return { ...route, threadId: `${this.platform}:thread` }; }
  async fetchAfter(_route: Route, _cursor: string) { return this.platform === "telegram" ? null : []; }
  async openAttachment(_route: Route, attachment: Attachment, _signal: AbortSignal) {
    this.opened.push(attachment);
    return new Response(this.platform);
  }
}
function route(platform: Platform): Route {
  return { platform, accountId: "same", authorityId: "same", guildId: null, channelId: "same", threadId: null };
}
function output(platform: Platform): OutputRecord {
  return { id: "same", sourceId: "same", route: route(platform), text: "private reply", state: "pending", remoteId: null, error: null };
}
function approval(platform: Platform): Approval {
  return { id: "same", requestId: "native", target: "lane", generation: 1, route: route(platform), request: { method: "confirm" }, state: "pending", remoteId: null };
}

test("identical account and conversation strings stay on their owning messenger", async () => {
  const telegram = new Transport("telegram"), slack = new Transport("slack");
  const hub = new MessengerHub({ telegram, slack });
  const accepted: Inbound[] = [];
  const answers: Array<{ id: string; response: DialogResponse; route: Route }> = [];
  await hub.start({
    async message(input) { accepted.push(input); },
    async answer(id, response, route) { answers.push({ id, response, route }); },
  });
  try {
    await hub.send(output("telegram"));
    await hub.send(output("slack"));
    await hub.showApproval(approval("slack"));
    expect(telegram.sent.map(value => value.route.platform)).toEqual(["telegram"]);
    expect(slack.sent.map(value => value.route.platform)).toEqual(["slack"]);
    expect(telegram.shown).toEqual([]);
    expect(slack.shown.map(value => value.route.platform)).toEqual(["slack"]);
    const file = { id: "same", name: "file", url: "telegram-file:same", size: 1 };
    expect(await (await hub.openAttachment(route("telegram"), file, new AbortController().signal)).text()).toBe("telegram");
    expect(slack.opened).toEqual([]);
    expect(await hub.fetchAfter(route("telegram"), "1")).toBeNull();
    const input: Inbound = { id: "same", route: route("telegram"), messageId: "1", text: "hello", receivedAt: 1, attachments: [] };
    await telegram.handlers!.message(input);
    await slack.handlers!.answer("approval", { confirmed: true }, route("slack"));
    expect(accepted).toEqual([input]);
    expect(answers[0]?.route.platform).toBe("slack");
    await expect(telegram.handlers!.message({ ...input, route: route("slack") })).rejects.toThrow("crossed platform");
    await expect(telegram.handlers!.answer("approval", { confirmed: true }, route("slack"))).rejects.toThrow("crossed platform");
    expect(() => hub.send(output("discord"))).toThrow("not configured");
    expect(accepted).toHaveLength(1);
    expect(answers).toHaveLength(1);
  } finally { await hub.stop(); }
});

test("partial startup failure closes every opened transport including the failed one", async () => {
  const discord = new Transport("discord"), telegram = new Transport("telegram", true), slack = new Transport("slack");
  const hub = new MessengerHub({ discord, telegram, slack });
  await expect(hub.start({ async message() {}, async answer() {} })).rejects.toThrow("startup rejected");
  expect(discord.stops).toBe(1);
  expect(telegram.stops).toBe(1);
  expect(slack.handlers).toBeUndefined();
  await hub.stop();
  expect(discord.stops).toBe(1);
});

test.each([false, true])("reaction transitions serialize per physical message across logical topics, earlier failure: %s", async rejected => {
  const telegram = new Transport("telegram"), slack = new Transport("slack");
  const hub = new MessengerHub({ telegram, slack });
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  telegram.beforeActivity = async () => { entered.resolve(); await gate.promise; };
  const original = { route: route("telegram"), messageId: "1" };
  const first = hub.setActivity(original, "received");
  const firstResult = first.then(() => "ok", () => "rejected");
  await entered.promise;
  const thinking = hub.setActivity({ ...original, route: { ...original.route, topicId: "another-logical-topic" } }, "thinking");
  const idle = hub.setActivity(original, "idle");
  try {
    await hub.setActivity({ route: route("slack"), messageId: "1" }, "received");
    expect(slack.activities.map(value => value.activity)).toEqual(["received"]);
    expect(telegram.activities).toEqual([]);
  } finally {
    telegram.beforeActivity = undefined;
    if (rejected) gate.reject(new Error("Reaction unavailable"));
    else gate.resolve();
  }
  await Promise.all([thinking, idle]);
  expect(await firstResult).toBe(rejected ? "rejected" : "ok");
  expect(telegram.activities.map(value => value.activity)).toEqual(rejected ? ["thinking", "idle"] : ["received", "thinking", "idle"]);
});
