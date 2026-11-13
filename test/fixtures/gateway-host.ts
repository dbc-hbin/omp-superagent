/** Isolated native-RPC peer for Gateway lifecycle tests; no platform activation. */
import { appendFile, chmod, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { MAX_RPC_FRAME_BYTES, MAX_RPC_REASSEMBLED_BYTES } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-frame";
import { loadConfig } from "../../src/config";
import { createGatewayMessenger } from "../../src/gateway-client";

const arg = (name: string) => process.argv[process.argv.indexOf(name) + 1]!;
const config = await loadConfig(process.env.OMP_SUPERAGENT_CONFIG!);
const socketPath = arg("--rpc-socket");
const sessionFile = arg("--session");
await mkdir(dirname(sessionFile), { recursive: true });
await appendFile(sessionFile, "");
const sessionId = "gateway-fixture-session";
const messenger = createGatewayMessenger(config);
await appendFile(join(config.stateDir, "launches.jsonl"), `${JSON.stringify({ pid: process.pid,
  args: process.argv, credentialPresent: Boolean(process.env.GATEWAY_TEST_BOT_TOKEN) })}\n`);
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
await messenger.start({
  message: async input => { await appendFile(join(config.stateDir, "received.jsonl"), `${JSON.stringify(input)}\n`); },
  answer: async () => {},
});
