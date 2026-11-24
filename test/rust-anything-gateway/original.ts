import { strict as assert } from "node:assert";
import { appendFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import type { DialogResponse, Inbound, Route } from "../../src/contracts";
import type { DownloadMessenger as Messenger } from "../fixtures/inbound-attachments";

type Event =
  | { readonly kind: "message"; readonly input: Inbound }
  | { readonly kind: "answer"; readonly approvalId: string; readonly response: DialogResponse; readonly route: Route };
type Store = {
  setMeta(key: string, value: string): void;
  admit(event: Event): boolean;
  hasPendingAnswer(id: string, route: Route): boolean;
  pending(): number;
  close(): void;
};
type Server = {
  readonly initialReady: { readonly promise: Promise<void> };
  readonly ready: boolean;
  readonly headReady: boolean;
  readonly connected: boolean;
  admitMessage(input: Inbound): void;
  deliver(): void;
  listen(): Promise<void>;
  close(): Promise<void>;
};
type Command =
  | { readonly command: "admit"; readonly event: Event }
  | { readonly command: "has-answer"; readonly id: string; readonly route: Route }
  | { readonly command: "stop" };

const [, , checkout, root, socketPath, headPid] = process.argv;
const token = process.env.FIXTURE_GATEWAY_TOKEN;
assert.ok(checkout && isAbsolute(checkout) && root && socketPath && Number(headPid) > 1 && token);
const { GatewayStore }: { GatewayStore: new (path: string) => Store } =
  await import(join(checkout, "src/gateway-store.ts"));
const { GatewayServer }: { GatewayServer: new (options: {
  readonly socketPath: string;
  readonly store: Store;
  readonly messenger: Messenger;
  readonly authorizeHead: (pid: number) => Promise<void>;
  readonly status: () => object;
  readonly stop: () => Promise<void>;
  readonly onError: (error: unknown) => void;
}) => Server } = await import(join(checkout, "src/gateway-server.ts"));
const { DeliveryError }: { DeliveryError: new (message: string, certainty: "rejected") => Error } =
  await import(join(checkout, "src/delivery.ts"));

const store = new GatewayStore(root);
store.setMeta("gateway:token", token);

const messenger: Messenger = {
  async start() {},
  assertRoute(route) {
    if (route.accountId !== "B1" || route.authorityId !== "T1" || route.channelId !== "D1")
      throw new DeliveryError("Fixture route identity rejected", "rejected");
  },
  async send(output) {
    const remoteId = `remote:${output.id}`;
    await appendFile(join(root, "remote.jsonl"), `${JSON.stringify({
      remoteId, sourceId: output.sourceId, route: output.route, text: output.text,
    })}\n`, { mode: 0o600 });
    if (output.id === "lost") {
      // The outside world saw the mutation. The driver now kills only
      // this fixture process, before Gateway can journal a result.
      console.log(JSON.stringify({ remoteCommitted: remoteId }));
      await new Promise<never>(() => {});
    }
    return remoteId;
  },
  async setActivity(message, activity) {
    await appendFile(join(root, "activity.jsonl"), `${JSON.stringify({ ...message, activity })}\n`, { mode: 0o600 });
  },
  async showApproval() { throw new Error("Unexpected fixture operation: showApproval"); },
  async dismissApproval() { throw new Error("Unexpected fixture operation: dismissApproval"); },
  async createThread() { throw new Error("Unexpected fixture operation: createThread"); },
  async fetchAfter() { throw new Error("Unexpected fixture operation: fetchAfter"); },
  async openAttachment() { throw new Error("Unexpected fixture operation: openAttachment"); },
  async stop() {},
};

const server: Server = new GatewayServer({
  socketPath, store, messenger,
  async authorizeHead(pid) {
    if (pid !== Number(headPid)) throw new DeliveryError("Fixture head identity rejected", "rejected");
  },
  status: () => ({
    gateway: { pid: process.pid, ready: true, admissionReady: server.ready, pendingEvents: store.pending(), stopping: false },
    head: { pid: Number(headPid), ready: server.headReady, connected: server.connected, socketPath, error: null },
  }),
  async stop() { throw new Error("Unexpected fixture operation: stop"); },
  onError() { /* Rejected requests are witnessed by their HTTP responses. */ },
});
try {
  await server.listen();
  const ingress: Parameters<Messenger["start"]>[0] = {
    ready: server.initialReady.promise,
    async message(input) { server.admitMessage(input); },
    async answer(approvalId, response, route) {
      store.admit({ kind: "answer", approvalId, response, route });
      server.deliver();
    },
  };
  await messenger.start(ingress);
  const commands = createInterface({ input: process.stdin, crlfDelay: Infinity });
  console.log(JSON.stringify({ started: true }));
  try {
    for await (const line of commands) {
      const command: Command = JSON.parse(line);
      if (command.command === "stop") break;
      if (command.command === "has-answer") {
        console.log(JSON.stringify({ pending: store.hasPendingAnswer(command.id, command.route) }));
        continue;
      }
      const event = command.event;
      console.log(JSON.stringify({ waiting: true }));
      await ingress.ready;
      try {
        if (event.kind === "message") await ingress.message(event.input);
        else await ingress.answer(event.approvalId, event.response, event.route);
        console.log(JSON.stringify({ admitted: true }));
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "Gateway ingress identity conflict") throw error;
        console.log(JSON.stringify({ admitted: false, conflict: true }));
      }
    }
  } finally { commands.close(); }
} finally {
  try { await server.close(); }
  finally { store.close(); }
}
