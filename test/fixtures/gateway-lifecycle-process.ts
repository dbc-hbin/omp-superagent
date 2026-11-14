/** Real detached lifecycle fixture; only messenger/native transports are isolated. */
import { spawn } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, requireMessengerCredentials } from "../../src/config";
import { loadCredentials } from "../../src/credentials";
import type { Inbound, Messenger } from "../../src/contracts";
import { runGatewayRestart } from "../../src/gateway-restart";

const arg = (name: string) => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1]; };
const config = await loadConfig(arg("--config")!);
loadCredentials(config);
requireMessengerCredentials(config);
// Keep the same credential-before-native-import boundary as the supported CLI loader.
const { launchGateway, startGateway } = await import("../../src/gateway");
const self = fileURLToPath(import.meta.url);
if (arg("--runner")) {
  await runGatewayRestart(config.path, arg("--runner")!, {
    launch: (configuration, requestId) => launchGateway(configuration, requestId, [process.execPath, "--no-env-file", self]),
  });
} else {
  let monitor: ReturnType<typeof setInterval> | undefined;
  let seen = 0;
  let reading = false;
  const messenger: Messenger = {
    async start(handlers) {
      monitor = setInterval(() => {
        if (reading) return;
        reading = true;
        void readFile(join(config.stateDir, "ingress.jsonl"), "utf8").then(async text => {
          for (const line of text.trim().split("\n").filter(Boolean).slice(seen)) {
            await handlers.message(JSON.parse(line) as Inbound);
            seen++;
          }
        }, () => {}).finally(() => { reading = false; });
      }, 10);
    },
    async stop() { if (monitor) clearInterval(monitor); },
    async send(output) { await appendFile(join(config.stateDir, "sent.jsonl"), `${JSON.stringify(output)}\n`); return "remote"; },
    async showApproval() { return "approval"; }, async dismissApproval() {},
    async createThread(route) { return route; }, async fetchAfter() { return null; },
    async openAttachment() { return new Response("fixture"); },
  };
  await startGateway(config, { messenger, restartRequestId: arg("--restart-request"), onError: () => {},
    managedUlwPath: fileURLToPath(new URL("./managed-ulw", import.meta.url)),
    launchRestartRunner: (configPath, requestId, fd) => spawn(process.execPath,
      ["--no-env-file", self, "--config", configPath, "--runner", requestId], {
        cwd: config.headCwd, detached: true, stdio: ["ignore", fd, fd], shell: false,
      }),
  });
}
