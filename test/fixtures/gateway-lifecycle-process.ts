/** Real detached lifecycle fixture; only messenger/native transports are isolated. */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, watch } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, requireMessengerCredentials } from "../../src/config";
import { loadCredentials } from "../../src/credentials";
import type { Inbound } from "../../src/contracts";
import type { DownloadMessenger as Messenger } from "./inbound-attachments";
import { runGatewayRestart } from "../oracles/bun-gateway/gateway-restart";

const arg = (name: string) => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1]; };
const config = await loadConfig(arg("--config")!);
const cleanup = join(config.stateDir, "cleanup");
if (existsSync(cleanup)) throw new Error("Fixture has already been stopped");
loadCredentials(config);
requireMessengerCredentials(config);
// Keep the same credential-before-native-import boundary as the supported CLI loader.
const { launchGateway, startGateway } = await import("../oracles/bun-gateway/gateway");
const self = fileURLToPath(import.meta.url);
if (arg("--runner")) {
  await runGatewayRestart(config.path, arg("--runner")!, {
    async launch(configuration, requestId) {
      // runGatewayRestart only reaches launch after confirming the old
      // processes are gone and the exact lifetime lock has been released.
      const queued = join(config.stateDir, "handoff-queued");
      const gate = Promise.withResolvers<void>();
      const onChange = () => {
        if (existsSync(cleanup)) gate.reject(new Error("Fixture cleanup cancelled the successor"));
        else if (existsSync(queued)) gate.resolve();
      };
      const watcher = watch(config.stateDir, onChange);
      const timer = setTimeout(() => gate.reject(new Error("Handoff input was not queued")), 15_000);
      try { onChange(); await gate.promise; }
      finally { clearTimeout(timer); watcher.close(); }
      return launchGateway(configuration, requestId, [process.execPath, "--no-env-file", self]);
    },
  });
} else {
  let monitor: ReturnType<typeof setInterval> | undefined;
  let seen = 0;
  let reading = false;
  let stopped = false;
  const stopIntake = () => { stopped = true; if (monitor) clearInterval(monitor); };
  const ingressFailed = (error: unknown) => {
    stopIntake();
    process.exitCode = 1;
    appendFileSync(join(config.stateDir, "ingress-failure.jsonl"),
      `${JSON.stringify({ pid: process.pid, position: seen + 1, error: String(error) })}\n`);
  };
  const messenger: Messenger = {
    async start(handlers) {
      void (handlers.ready ?? Promise.resolve()).then(() => {
        if (stopped) return;
        monitor = setInterval(() => {
          const ingress = join(config.stateDir, "ingress.jsonl");
          if (reading || existsSync(cleanup) || !existsSync(ingress)) return;
          reading = true;
          void readFile(ingress, "utf8").then(async text => {
            const lines = text.slice(0, text.lastIndexOf("\n") + 1).split("\n").filter(Boolean);
            for (const line of lines.slice(seen)) {
              if (stopped) return;
              const input: Inbound = JSON.parse(line);
              await handlers.message(input);
              seen++;
              appendFileSync(join(config.stateDir, "ingress-admissions.jsonl"),
                `${JSON.stringify({ id: input.id, position: seen, pid: process.pid })}\n`);
            }
          }).catch(ingressFailed)
            .finally(() => { reading = false; });
        }, 25);
      }, error => { if (!stopped && !existsSync(cleanup)) ingressFailed(error); });
    },
    async stop() { stopIntake(); },
    async send(output) { await appendFile(join(config.stateDir, "sent.jsonl"), `${JSON.stringify(output)}\n`); return "remote"; },
    async showApproval() { return "approval"; }, async dismissApproval() {},
    async createThread(route) { return route; }, async fetchAfter() { return null; },
    async openAttachment() { return new Response("fixture"); },
  };
  const starting = startGateway(config, { messenger, restartRequestId: arg("--restart-request"), onError: error => console.error(error),
    managedUlwPath: fileURLToPath(new URL("./managed-ulw", import.meta.url)),
    launchRestartRunner: (configPath, requestId, fd) => spawn(process.execPath,
      ["--no-env-file", self, "--config", configPath, "--runner", requestId], {
        cwd: config.headCwd, detached: true, stdio: ["ignore", fd, fd], shell: false,
      }),
  });
  const stop = () => {
    if (!existsSync(cleanup)) return;
    watcher.close();
    void starting.then(async service => {
      try { await service.stop(); }
      finally { await service.close(); }
    }).catch(error => { console.error("Fixture cleanup failed", error); process.exitCode = 1; });
  };
  const watcher = watch(config.stateDir, { persistent: false }, stop);
  stop();
  await starting;
}
