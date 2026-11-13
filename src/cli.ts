#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { configuredPlatforms, credentialEnvNames, hostPaths, loadConfig } from "./config";
import type { Lane } from "./contracts";
import { gatewayPaths, gatewayStatus, launchGateway, stopGateway } from "./gateway";
import { connect } from "./host";

const HELP = `omp-superagent — messenger-connected OMP head and independent topic sessions

Usage:
  omp-superagent start --config FILE
  omp-superagent status --config FILE
  omp-superagent attach [main|LANE_ID] --config FILE [--read-only]
  omp-superagent stop [main|LANE_ID] --config FILE
  omp-superagent doctor --config FILE

start explicitly launches a detached Gateway and its native head, activating configured messenger connections. No install/autostart is performed.
stop main stops the supervised Gateway/head service; busy native hosts refuse without being killed or resurrected.
attach uses the same host, not another --resume writer. Run it in a herdr pane if desired.
Use the patched OMP command prepared with scripts/prepare-omp.ts.
`;

function laneRows(stateDir: string): Lane[] {
  const path = join(stateDir, "coordination.sqlite");
  if (!existsSync(path)) return [];
  const db = new Database(path, { readonly: true });
  try {
    return (db.query("SELECT data FROM lanes ORDER BY rowid").all() as { data: string }[])
      .map(row => JSON.parse(row.data) as Lane);
  } finally { db.close(); }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  if (!args.length || args.includes("--help") || args[0] === "help") { console.log(HELP); return; }
  const [command] = args;
  if (!["start", "status", "attach", "stop", "doctor"].includes(command!)) throw new Error(`Unknown command: ${command}`);
  const configAt = args.indexOf("--config");
  if (configAt < 0 || !args[configAt + 1]) throw new Error("--config FILE is required");
  const config = await loadConfig(args[configAt + 1]!);
  const target = args[1] && !args[1]!.startsWith("-") ? args[1]! : "main";
  const paths = hostPaths(config, target);
  if (command === "doctor") {
    const probe = Bun.spawn([...config.command, "--help"], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(probe.stdout).text(), new Response(probe.stderr).text(), probe.exited,
    ]);
    if (code !== 0) throw new Error(`OMP command failed (${code}): ${stderr}`);
    if (!["--rpc-socket", "--session-settings", "--model-preset"].every(flag => stdout.includes(flag)))
      throw new Error("Configured OMP lacks managed socket/session-settings/model-preset support. Apply the current pinned core patch; a normal installed OMP is not enough.");
    console.log(JSON.stringify({
      config: config.path, command: config.command, headCwd: config.headCwd,
      maxHosts: config.maxHosts, maxSubagents: config.maxSubagents,
      platforms: configuredPlatforms(config),
      credentials: Object.fromEntries(credentialEnvNames(config).map(name => [name, Boolean(process.env[name])])),
      messengersActivated: false,
    }, null, 2));
    return;
  }
  if (command === "status") {
    console.log(JSON.stringify({
      gateway: await gatewayStatus(config),
      main: { socketPath: hostPaths(config, "main").socketPath },
      lanes: laneRows(config.stateDir).map(l => ({
        id: l.id, title: l.title, cwd: l.cwd, workState: l.workState,
        model: l.model ?? null, modelReason: l.modelReason ?? null, modelPreset: l.modelPreset ?? null,
        recordedRuntimeState: l.runtimeState, sessionId: l.sessionId, socketPath: l.socketPath,
      })),
      note: "Gateway/head readiness is live when the Gateway is reachable; lane records are not a completion guarantee.",
    }, null, 2));
    return;
  }
  if (target !== "main" && !laneRows(config.stateDir).some(l => l.id === target))
    throw new Error("Unknown managed lane");
  if (command === "attach") {
    const proc = Bun.spawn([
      ...config.command, "attach", paths.socketPath, ...(args.includes("--read-only") ? ["--read-only"] : []),
    ], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    process.exitCode = await proc.exited;
    return;
  }
  if (command === "stop") {
    if (target === "main") {
      await stopGateway(config);
      console.log("Gateway and supervised main host accepted graceful shutdown.");
      return;
    }
    const host = await connect(paths.socketPath);
    try {
      const response = await host.request({ type: "shutdown_host" });
      if (!response.success) throw new Error(response.error ?? "Host refused shutdown");
      console.log(`Host ${target} accepted graceful shutdown.`);
    } finally { await host.close(); }
    return;
  }
  if (target !== "main") throw new Error("start only activates the Gateway/main service; lanes remain head-owned");
  const status = await launchGateway(config);
  console.log(JSON.stringify({ ...status, gatewaySocketPath: gatewayPaths(config).socketPath,
    gatewayLogPath: gatewayPaths(config).logPath,
    note: "Gateway owns messenger transports. Native head RPC availability and approval-reconciled intake readiness are reported separately." }, null, 2));
}

if (import.meta.main) {
  await main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
