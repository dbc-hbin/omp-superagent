/** Real detached Gateway/one-shot loader with local Messenger and a controlled HTTP reconnect window. */
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import { IncomingMessage, Server, ServerResponse } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, requireMessengerCredentials } from "../../src/config";
import { loadCredentials } from "../../src/credentials";
import type { Approval, DialogResponse, Inbound, Messenger, OutputRecord, Route } from "../../src/contracts";
import { DeliveryError } from "../../src/delivery";
import { processAlive, runGatewayRestart } from "../../src/gateway-restart";
import type { GatewayService } from "../../src/gateway";

const arg = (name: string) => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1]; };
const configPath = arg("--config");
assert(configPath, "The isolated loader requires an explicit private config");
const config = await loadConfig(configPath);
const root = config.stateDir;
assert(process.env.OMP_RESTART_NATIVE_ROOT === root && process.env.HOME === join(root, "home"));
assert(!existsSync(join(root, "cleanup")), "No fixture process may activate after cleanup begins");
loadCredentials(config);
requireMessengerCredentials(config);
// A static native import would run OMP's dotenv loader before this credential boundary.
const { launchGateway, startGateway } = await import("../../src/gateway");
const self = fileURLToPath(import.meta.url);
const runnerRequest = arg("--runner");
const record = (kind: string, fields: Record<string, unknown> = {}) => {
  appendFileSync(join(root, "transport-events.jsonl"), `${JSON.stringify({ kind, at: Date.now(), pid: process.pid, ...fields })}\n`, { mode: 0o600 });
};
record("process-start", { role: runnerRequest ? "runner" : "gateway", requestId: runnerRequest });
if (runnerRequest) {
  try {
    await runGatewayRestart(config.path, runnerRequest, {
      launch: (configuration, requestId) => {
        assert(!existsSync(join(root, "cleanup")), "Fixture cleanup cancels its isolated successor launch");
        return launchGateway(configuration, requestId, [process.execPath, "--no-env-file", self]);
      },
    });
  } finally { record("runner-exit"); }
} else {
  type Ingress = { kind: "message"; input: Inbound }
    | { kind: "answer"; approvalId: string; response: DialogResponse; route: Route };
  interface GatewayIngressReceipt { readonly sequence: number; readonly data: string;
    readonly delivered_at: number | null; readonly delivery_error: string | null }
  let closed = false;
  let seen = 0;
  let pending = false;
  let draining: Promise<void> | undefined;
  let watcher: FSWatcher | undefined;
  let starting: Promise<GatewayService> | undefined;
  const waitForGate = async (name: string): Promise<void> => {
    const done = Promise.withResolvers<void>();
    const check = () => {
      if (existsSync(join(root, name)) || existsSync(join(root, "cleanup"))) done.resolve();
    };
    const gate = watch(root, check);
    try { check(); await done.promise; } finally { gate.close(); }
  };
  let activeEvents: ServerResponse | undefined;
  let streamIndex = 0;
  let holdReconnect = false;
  const detachedLane = process.env.OMP_RESTART_NATIVE_SCENARIO === "lane-failure" || process.env.OMP_RESTART_NATIVE_SCENARIO === "lane-abort"
    || process.env.OMP_RESTART_NATIVE_SCENARIO === "lane-failure-recovery-window" || process.env.OMP_RESTART_NATIVE_SCENARIO === "lane-abort-recovery-window";
  if (process.env.OMP_RESTART_NATIVE_SCENARIO === "quarantine" || detachedLane) {
    // Control raw HTTP delivery in this private process. Production still owns
    // authentication, PID authorization, native reconciliation and every receipt.
    const emit = Server.prototype.emit;
    Server.prototype.emit = function (this: Server, event: string | symbol, ...args: unknown[]): boolean {
      const [request, response] = args;
      if (event !== "request" || this.address() !== join(root, "run/gateway.sock")
        || !(request instanceof IncomingMessage) || !(response instanceof ServerResponse)) return emit.call(this, event, ...args);
      if (request.url === "/attach" && detachedLane && arg("--restart-request") && !existsSync(join(root, "release-successor-attach"))) {
        record("wire-successor-attach-held", { clientId: request.headers["x-gateway-client"] });
        void waitForGate("release-successor-attach").then(() => {
          record("wire-successor-attach-released", { destroyed: response.destroyed });
          if (!request.destroyed && !response.destroyed) emit.call(this, event, ...args);
          else response.destroy();
        }).catch(error => { record("fixture-error", { error: String(error) }); response.destroy(); });
        return true;
      }
      if (request.url === "/attach" && holdReconnect && !existsSync(join(root, "release-reconnect"))) {
        record("wire-attach-held", { clientId: request.headers["x-gateway-client"] });
        void waitForGate("release-reconnect").then(() => {
          record("wire-attach-released", { destroyed: response.destroyed });
          if (!request.destroyed && !response.destroyed) emit.call(this, event, ...args);
          else response.destroy();
        }).catch(error => { record("fixture-error", { error: String(error) }); response.destroy(); });
        return true;
      }
      if (request.url === "/events") {
        const stream = ++streamIndex;
        activeEvents = response;
        response.once("close", () => {
          record("wire-events-close", { stream, statusCode: response.statusCode });
          if (activeEvents === response) activeEvents = undefined;
        });
        const forwarded = emit.call(this, event, ...args);
        record("wire-events-open", { stream, statusCode: response.statusCode, headersSent: response.headersSent,
          clientId: request.headers["x-gateway-client"] });
        return forwarded;
      }
      return emit.call(this, event, ...args);
    };
  }
  class RecordingMessenger implements Messenger {
    async start(handlers: Parameters<Messenger["start"]>[0]): Promise<void> {
      const drain = () => {
        if (closed) return;
        pending = true;
        if (draining) return;
        draining = (async () => {
          await handlers.ready;
          while (pending && !closed) {
            pending = false;
            const text = await readFile(join(root, "ingress.jsonl"), "utf8");
            const lines = text.slice(0, text.lastIndexOf("\n") + 1).split("\n").filter(Boolean);
            for (const line of lines.slice(seen)) {
              const event: Ingress = JSON.parse(line);
              switch (event.kind) {
                case "message": await handlers.message(event.input); break;
                case "answer": await handlers.answer(event.approvalId, event.response, event.route); break;
                default: { const unknown: never = event; throw new Error(`Unknown fixture ingress: ${JSON.stringify(unknown)}`); }
              }
              seen++;
              record("ingress-admitted", { index: seen, event });
            }
          }
        })().catch(error => {
          record("fixture-error", { error: String(error) });
          throw error;
        }).finally(() => { draining = undefined; });
        void draining.catch(error => { console.error(String(error)); process.exitCode = 1; });
      };
      watcher = watch(root, (_event, name) => {
        if (String(name) === "ingress.jsonl") drain();
        if (String(name) === "cleanup") {
          // Detach supervision first; the orchestrator then aborts/reaps only this fixture's HEAD.
          void starting?.then(service => service.close()).catch(error => { record("fixture-error", { error: String(error) }); });
        }
      });
      drain();
      if (existsSync(join(root, "cleanup"))) void starting?.then(service => service.close());
    }
    async send(output: OutputRecord): Promise<string> {
      const db = new Database(join(root, "coordination.sqlite"), { readonly: true, strict: true });
      let headPid: number | undefined;
      try {
        const saved = db.query<{ value: string }, []>("SELECT value FROM metadata WHERE key='gateway:head'").get();
        const head: { pid: number } | null = saved ? JSON.parse(saved.value) : null;
        headPid = head?.pid;
      } finally { db.close(); }
      record("send", { output, headPid, headAlive: headPid !== undefined && processAlive(headPid) });
      if (output.id === "902:restart-ack") {
        if (process.env.OMP_RESTART_NATIVE_SCENARIO === "quarantine") {
          holdReconnect = true;
          const admitted = Promise.withResolvers<void>();
          let receipt: GatewayIngressReceipt | null = null;
          const check = () => {
            const observed = new Database(join(root, "coordination.sqlite"), { readonly: true, strict: true });
            try {
              receipt = observed.query<GatewayIngressReceipt, []>(
                "SELECT sequence,data,delivered_at,delivery_error FROM gateway_events WHERE identity='message:902'",
              ).get();
              if (receipt?.delivered_at !== null && receipt?.delivered_at !== undefined || existsSync(join(root, "cleanup"))) admitted.resolve();
            } finally { observed.close(); }
          };
          const changes = watch(root, check);
          try { check(); await admitted.promise; } finally { changes.close(); }
          record("wire-restart-receipted", { receipt });
          // The owner control returned and was receipted while this ACK send is
          // still pending. Closing SSE now cannot turn it into a model turn.
          const stream = streamIndex;
          activeEvents?.destroy();
          record("wire-window-open", { stream });
        }
        await waitForGate("release-ack");
        if (process.env.OMP_RESTART_NATIVE_SCENARIO === "ack-interrupted")
          throw new DeliveryError("Isolated original-route ACK response was interrupted after the recorded send", "uncertain");
      }
      record("send-returned", { outputId: output.id });
      return `restart-native-remote:${output.id}`;
    }
    async showApproval(approval: Approval): Promise<string> {
      record("show-approval", { approval });
      return `restart-native-card:${approval.id}`;
    }
    async dismissApproval(approval: Approval): Promise<void> { record("dismiss-approval", { approval }); }
    async createThread(): Promise<Route> { throw new Error("This proof never creates an external thread"); }
    async fetchAfter(): Promise<Inbound[]> { return []; }
    async openAttachment(): Promise<Response> { throw new Error("This proof never opens external attachments"); }
    async stop(): Promise<void> {
      closed = true;
      watcher?.close();
      record("gateway-closed");
    }
  }
  starting = startGateway(config, {
    messenger: new RecordingMessenger(), restartRequestId: arg("--restart-request"),
    managedUlwPath: fileURLToPath(new URL("./managed-ulw", import.meta.url)),
    onError: error => { record("gateway-error", { error: String(error) }); },
    launchRestartRunner: (path, requestId, fd) => spawn(process.execPath,
      ["--no-env-file", self, "--config", path, "--runner", requestId], {
        cwd: config.headCwd, detached: true, stdio: ["ignore", fd, fd], shell: false,
      }),
  });
  await starting;
}
