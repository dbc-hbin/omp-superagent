import { afterEach, expect, jest, test } from "bun:test";
import { openLive } from "./oracles/bun-gateway/openai-live.ts";

const providerKey = "sk-fixture-secret";
const options = { model: "gpt-live-1", voice: "noeul", apiKey: providerKey, backendModel: "gpt-6-luna" };
const connection = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
const receipt = "Draft posted for written confirmation; not yet submitted or executed.";
type WireMessage = {
  type: string; audio?: string; item?: { type: string; call_id: string; output: string };
};

class ProviderFixture extends EventTarget {
  static OPEN = 1;
  readyState = 0;
  bufferedAmount = 0;
  sent: WireMessage[] = [];
  constructor(readonly url: string, readonly options: { headers: Record<string, string> }) {
    super();
    fixture = this;
  }
  open() {
    this.readyState = ProviderFixture.OPEN;
    this.dispatchEvent(new Event("open"));
  }
  send(payload: string) {
    const message: WireMessage = JSON.parse(payload);
    this.sent.push(message);
    this.dispatchEvent(new MessageEvent("client", { data: message }));
  }
  close() {
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
  terminate() { this.close(); }
  push(message: object) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
  }
  responses(event: object, delegation: string | null = "delegate_1") {
    this.push({ type: "response.event", event, delegation_id: delegation });
  }
  next(match: (message: WireMessage) => boolean) {
    const pending = Promise.withResolvers<WireMessage>();
    const receive = (event: Event) => {
      if (!(event instanceof MessageEvent) || !match(event.data)) return;
      this.removeEventListener("client", receive);
      pending.resolve(event.data);
    };
    this.addEventListener("client", receive);
    return pending.promise;
  }
}

let fixture: ProviderFixture | undefined;
const connections: { controller: AbortController; provider: ProviderFixture }[] = [];
afterEach(() => {
  for (const { controller, provider } of connections.splice(0)) {
    controller.abort();
    if (provider.readyState === ProviderFixture.OPEN) provider.push({ type: "session.closed" });
  }
  if (connection) Object.defineProperty(globalThis, "WebSocket", connection);
  fixture = undefined;
});

function connect(forward = async (_text: string) => receipt) {
  Object.defineProperty(globalThis, "WebSocket", { ...connection, value: ProviderFixture });
  const controller = new AbortController();
  const audio: Buffer[] = [];
  const state = { interrupted: 0, ended: 0 };
  const proposals: string[] = [];
  const ready = openLive(options, {
    audio: (pcm) => { audio.push(pcm); },
    interrupt: () => { state.interrupted++; },
    ended: () => { state.ended++; },
    forward(text) { proposals.push(text); return forward(text); },
  }, controller.signal);
  if (!fixture) throw new Error("Expected the OpenAI Live WebSocket to be constructed");
  connections.push({ controller, provider: fixture });
  return { ready, provider: fixture, controller, audio, state, proposals };
}

async function start(forward?: (text: string) => Promise<string>) {
  const setup = connect(forward);
  setup.provider.open();
  setup.provider.push({ type: "session.started", session: { id: "live_1" } });
  return { ...setup, live: await setup.ready };
}

function call(text: string, id = "call_1") {
  return {
    type: "response.output_item.done",
    item: { id: "item_1", type: "function_call", status: "completed", call_id: id,
      name: "forward_to_head", arguments: JSON.stringify({ text }) },
  };
}

test("negotiates actual Live audio and relays raw PCM when the provider starts the session", async () => {
  const { provider, ready, audio, state } = connect();
  provider.open();
  expect(provider.url).toBe("wss://api.openai.com/v1/live/sessions");
  expect(provider.options.headers.Authorization).toBe(`Bearer ${providerKey}`);
  expect(provider.sent).toEqual([expect.objectContaining({
    type: "session.start",
    session: expect.objectContaining({
      model: "gpt-live-1", store: false,
      audio: { format: { type: "audio/pcm", rate: 24_000 }, output: { voice: "noeul" } },
      delegation: { type: "responses", responses: expect.objectContaining({
        model: "gpt-6-luna", parallel_tool_calls: false,
        tools: [expect.objectContaining({ type: "function", name: "forward_to_head" })],
      }) },
    }),
  })]);
  provider.push({ type: "session.started", session: { id: "live_1" } });
  const live = await ready;
  const voiced = Buffer.alloc(960).fill(Buffer.from([0x0a, 0x19]));
  const outgoing = provider.next((e) => e.audio === voiced.toString("base64"));
  live.input(voiced.subarray(0, 317));
  live.input(voiced.subarray(317));
  await outgoing;
  expect(state.interrupted).toBe(1);
  const silent = await provider.next((e) => e.audio === Buffer.alloc(960).toString("base64"));
  expect(silent.type).toBe("session.input_audio.append");

  provider.push({ type: "session.output_audio.delta", delta: "AQACAA==" });
  expect(audio).toEqual([Buffer.from([1, 0, 2, 0])]);
  live.close();
  provider.push({ type: "session.closed" });
  expect(provider.sent.at(-1)).toEqual({ type: "session.close" });
  expect(state.ended).toBe(1);
});

test("posts the dictated draft unchanged at completion, then returns only its correlated draft receipt", async () => {
  const pending = Promise.withResolvers<string>();
  const { provider, proposals } = await start(() => pending.promise);
  const dictated = 'src/GPUPath.ts에서 dispatch("keep_case")를 확인해 줘.\n테스트는 2개만 추가하고 설정은 바꾸지 마.';
  provider.responses({ type: "response.created", response: { id: "resp_1" } }, null);
  provider.push({ type: "session.delegation.created", delegation: { id: "delegate_1", target: "responses", response_id: "resp_1" } });
  provider.responses({ type: "response.function_call_arguments.done", arguments: '{"text":"partial"}' });
  provider.responses(call(dictated), null);
  provider.responses(call("Duplicate must not replace the first request"));
  expect(proposals).toEqual([]);

  const continuation = provider.next((event) => event.type === "response.create");
  provider.responses({ type: "response.completed", response: { id: "resp_1", output: [] } });
  expect(proposals).toEqual([dictated]);
  expect(provider.sent.some((event) => event.type === "response.item.create")).toBe(false);
  pending.resolve(receipt);
  await continuation;
  expect(provider.sent.filter((event) => event.type !== "session.start" && event.type !== "session.input_audio.append")).toEqual([
    { type: "response.item.create", item: { type: "function_call_output", call_id: "call_1",
      output: JSON.stringify({ status: "draft_posted", detail: receipt, workSubmitted: false,
        workExecuted: false, voiceAuthorized: false }) } },
    { type: "response.create" },
  ]);
  provider.responses({ type: "response.created", response: { id: "resp_followup" } });
  provider.responses(call("Model must not initiate a second call", "call_2"));
  expect(proposals).toEqual([dictated]);
  expect(provider.readyState).toBe(3);
});

test("ignores cancelled work and never delivers an in-flight result after abort", async () => {
  const pending = Promise.withResolvers<string>();
  const { provider, proposals, controller, state, live } = await start(() => pending.promise);
  provider.responses({ type: "response.created", response: { id: "resp_cancelled" } });
  provider.responses(call("Do not propose this", "call_cancelled"));
  provider.responses({ type: "response.cancelled", response: { id: "resp_cancelled" } });
  provider.responses({ type: "response.created", response: { id: "resp_1" } });
  provider.responses(call("Propose this"));
  provider.responses({ type: "response.completed", response: { id: "resp_1" } });
  expect(proposals).toEqual(["Propose this"]);

  controller.abort(new Error(providerKey));
  pending.resolve(receipt);
  await pending.promise;
  live.close();
  expect(provider.sent.some((event) => event.type.startsWith("response."))).toBe(false);
  expect(provider.sent.filter((event) => event.type === "session.close")).toHaveLength(1);
  expect(provider.readyState).toBe(ProviderFixture.OPEN);
  provider.push({ type: "session.closed" });
  expect(provider.readyState).toBe(3);
  expect(state.ended).toBe(1);
});

test.serial("forces socket teardown when the graceful abort receives no closing acknowledgment", async () => {
  jest.useFakeTimers();
  try {
    const { provider, controller, state } = await start();
    const closed = Promise.withResolvers<void>();
    provider.addEventListener("close", () => closed.resolve(), { once: true });
    controller.abort();
    expect(provider.sent.at(-1)).toEqual({ type: "session.close" });
    // Exercise the full grace period on the clock of this in-process fixture.
    jest.advanceTimersByTime(1_999);
    expect(provider.readyState).toBe(ProviderFixture.OPEN);
    expect(state.ended).toBe(0);
    jest.advanceTimersByTime(1);
    expect(provider.readyState).toBe(3);
    await closed.promise;
    expect(state.ended).toBe(1);
  } finally {
    jest.useRealTimers();
  }
});

test.each(["response.failed", "response.incomplete"])("closes without forwarding or retrying after %s", async (type) => {
  const { provider, proposals, state } = await start();
  const response = { id: "resp_1" };
  provider.responses({ type: "response.created", response });
  provider.responses(call("Do not propose failed work"));
  provider.responses({ type, response });
  expect(proposals).toEqual([]);
  expect(provider.sent.map((event) => event.type)).toEqual(["session.start"]);
  expect(provider.readyState).toBe(3);
  expect(state.ended).toBe(1);
});

test("never reflects provider secrets in errors or claims a failed draft was posted", async () => {
  const rejected = connect();
  const error = rejected.ready.catch((err: unknown) => err);
  rejected.provider.open();
  rejected.provider.push({ type: "error", error: { message: providerKey } });
  const failure = await error;
  expect(failure).toBeInstanceOf(Error);
  expect(String(failure)).not.toContain(providerKey);
  expect(rejected.provider.readyState).toBe(3);

  const { provider } = await start(async () => { throw new Error(providerKey); });
  const continuation = provider.next((event) => event.type === "response.create");
  provider.responses({ type: "response.created", response: { id: "resp_1" } }, null);
  provider.responses(call("Propose work"), null);
  provider.responses({ type: "response.completed", response: { id: "resp_1" } }, null);
  await continuation;
  const output = provider.sent.find((event) => event.type === "response.item.create")?.item?.output;
  expect(JSON.parse(output ?? "")).toEqual({
    status: "draft_unconfirmed", detail: expect.not.stringContaining(providerKey),
    workSubmitted: false, workExecuted: false, voiceAuthorized: false,
  });
});

test("closes rather than allowing unbounded delegated Responses work", async () => {
  const { provider, proposals, state } = await start();
  for (let i = 1; i <= 12; i++) {
    expect(state.ended).toBe(0);
    const response = { id: `resp_${i}` };
    provider.responses({ type: "response.created", response });
    provider.responses({ type: "response.completed", response });
  }
  expect(proposals).toEqual([]);
  expect(state.ended).toBe(1);
  expect(provider.readyState).toBe(3);
});

test.each([
  ["with a forged confirmation", { text: "Request a change", approved: true }],
  ["over the wire limit", { text: "x".repeat(1_001) }],
])("rejects a draft %s without posting or truncating it", async (_label, args) => {
  const { provider, proposals } = await start();
  const continuation = provider.next((event) => event.type === "response.create");
  const invalid = call("Request a change");
  invalid.item.arguments = JSON.stringify(args);
  provider.responses({ type: "response.created", response: { id: "resp_1" } });
  provider.responses(invalid);
  provider.responses({ type: "response.completed", response: { id: "resp_1" } });
  await continuation;
  expect(proposals).toEqual([]);
  const output = provider.sent.find((event) => event.type === "response.item.create")?.item?.output;
  expect(JSON.parse(output ?? "")).toMatchObject({ status: "not_submitted", voiceAuthorized: false });
});
