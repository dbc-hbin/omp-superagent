/** Isolated native-RPC peer for Gateway lifecycle tests; no platform activation. */
import { appendFile, chmod, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { MAX_RPC_FRAME_BYTES, MAX_RPC_REASSEMBLED_BYTES } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-frame";
import { loadConfig } from "../../src/config";
import { createGatewayMessenger } from "../../src/gateway-client";
import { Store } from "../../src/store";

const arg = (name: string) => process.argv[process.argv.indexOf(name) + 1]!;
const config = await loadConfig(process.env.OMP_SUPERAGENT_CONFIG!);
const socketPath = arg("--rpc-socket");
const sessionFile = arg("--session");
await mkdir(dirname(sessionFile), { recursive: true });
const sessionId = "gateway-fixture-session";
if (!existsSync(sessionFile)) await appendFile(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: config.headCwd })}\n`);
const messenger = createGatewayMessenger(config);
await appendFile(join(config.stateDir, "launches.jsonl"), `${JSON.stringify({ pid: process.pid,
  args: process.argv, config: JSON.parse(await readFile(arg("--config"), "utf8")),
  credentialPresent: Boolean(process.env.GATEWAY_TEST_BOT_TOKEN) })}\n`);
const server = createServer(peer => {
  peer.on("error", () => {});
  peer.setEncoding("utf8");
  let pending = "";
  const send = (frame: unknown) => peer.write(`${JSON.stringify(frame)}\n`);
  peer.on("data", chunk => {
    pending += chunk;
    let newline: number;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const frame = JSON.parse(pending.slice(0, newline)) as Record<string, unknown>;
      pending = pending.slice(newline + 1);
      if (frame.type === "shutdown_host") {
        const busy = existsSync(join(config.stateDir, "busy"));
        send({ type: "response", id: frame.id, command: frame.type, success: !busy,
          ...(busy ? { error: "Host is busy" } : { data: {} }) });
        if (!busy) void messenger.stop().finally(() => { server.close(); setTimeout(() => process.exit(0), 50); });
      } else {
        send({ type: "response", id: frame.id, command: frame.type, success: true,
          data: frame.type === "negotiate_protocol" ? { protocolVersion: 2 }
            : { sessionId, sessionFile, hostPid: process.pid } });
      }
    }
  });
  send({ type: "ready", supportedProtocolVersions: [1, 2], maxFrameBytes: MAX_RPC_FRAME_BYTES,
    maxReassembledFrameBytes: MAX_RPC_REASSEMBLED_BYTES });
});
const listening = Promise.withResolvers<void>();
server.once("error", listening.reject);
server.listen(socketPath, listening.resolve);
await listening.promise;
await chmod(socketPath, 0o600);
// This RPC peer replaces the whole native controller. Model a head whose
// fixture presets were preverified; actual initialization/readback belongs to
// native-gateway.test.ts, not these transport/process lifecycle cases.
const coordination = new Store(join(config.stateDir, "coordination.sqlite"));
try {
  const saved = coordination.getMeta("head:preset-bootstrap");
  if (saved) {
    const initialization = JSON.parse(saved) as { sessionId: string; state: string };
    if (initialization.sessionId !== sessionId || initialization.state !== "complete") {
      throw new Error("Lifecycle peer cannot replace an incomplete or foreign initialization receipt");
    }
  } else coordination.setMeta("head:preset-bootstrap", JSON.stringify({ sessionId,
    state: "complete", replayBlocked: true, detail: "Lifecycle RPC peer: fixture presets were already verified." }));
} finally { coordination.close(); }
await messenger.start({
  message: async input => { await appendFile(join(config.stateDir, "received.jsonl"), `${JSON.stringify(input)}\n`); },
  answer: async () => {},
});
