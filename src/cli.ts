#!/usr/bin/env -S bun --no-env-file
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { configuredPlatforms, credentialEnvNames, hostPaths, loadConfig, requireMessengerCredentials } from "./config";
import { loadCredentials } from "./credentials";
import type { Lane } from "./contracts";
import { setup } from "./setup";

// Lifecycle imports below must stay lazy: static Gateway/Host imports execute
// OMP's dotenv loader before setup/doctor/command registration select credential sources.
const HELP = `omp-superagent — messenger-connected OMP head and independent topic sessions

Usage:
  omp-superagent setup --config FILE
  omp-superagent start --config FILE
  omp-superagent status --config FILE
  omp-superagent attach [main|LANE_ID] --config FILE [--read-only]
  omp-superagent stop [main|LANE_ID] --config FILE
  omp-superagent doctor --config FILE
  omp-superagent discord-commands --config FILE [--apply]
  omp-superagent telegram-commands --config FILE [--language CODE] [--apply]
  omp-superagent slack-commands --config FILE --manifest-token-env NAME [--apply]

setup interactively prepares configuration and a private FILE.env; it never activates accounts or starts services.
start explicitly launches a detached Gateway and its native head, activating configured messenger connections. No install/autostart is performed.
stop main stops the supervised Gateway/head service; busy native hosts refuse without being killed or resurrected.
attach uses the same host, not another --resume writer. Run it in a herdr pane if desired.
discord-commands uses Discord REST only: dry-run by default, with no Gateway or native runtime activation.
--apply exclusively replaces this dedicated bot's GLOBAL commands with supported Superagent commands, deleting obsolete registrations (including Hermes). Guild commands are preserved; shadowing conflicts refuse apply.
telegram-commands configures owner-scoped Telegram command menus; --language selects an optional Telegram language code.
slack-commands configures /superagent-* commands through the app manifest; NAME identifies an app-configuration token environment variable, never a token argument.
All command registration is read-only by default and requires --apply to change remote configuration. No polling, Socket Mode, or native model session is started.
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
  if (!["setup", "start", "status", "attach", "stop", "doctor", "discord-commands", "telegram-commands", "slack-commands"].includes(command!)) throw new Error(`Unknown command: ${command}`);
  const configAt = args.indexOf("--config");
  if (configAt < 0 || !args[configAt + 1]) throw new Error("--config FILE is required");
  if (command === "setup") { await setup(args[configAt + 1]!); return; }
  if (command === "discord-commands" || command === "telegram-commands" || command === "slack-commands") {
    const extra = command === "telegram-commands" ? " [--language CODE]"
      : command === "slack-commands" ? " --manifest-token-env NAME" : "";
    const usage = `Usage: ${command} --config FILE${extra} [--apply]`;
    const valueFlags = new Set(["--config", ...(command === "telegram-commands" ? ["--language"]
      : command === "slack-commands" ? ["--manifest-token-env"] : [])]);
    const values = new Map<string, string>();
    let apply = false;
    for (let index = 1; index < args.length; index++) {
      const flag = args[index]!;
      if (flag === "--apply" && !apply) { apply = true; continue; }
      const value = args[index + 1];
      if (!valueFlags.has(flag) || values.has(flag) || !value || value.startsWith("-")) throw new Error(usage);
      values.set(flag, value);
      index++;
    }
    const configPath = values.get("--config");
    const manifestTokenEnv = values.get("--manifest-token-env");
    if (!configPath || command === "slack-commands" && !manifestTokenEnv) throw new Error(usage);
    const config = await loadConfig(configPath);
    let report: unknown;
    if (command === "discord-commands") {
      const { registerDiscordCommands } = await import("./discord-command-registration");
      report = await registerDiscordCommands(config, { apply });
    } else if (command === "telegram-commands") {
      const { registerTelegramCommands } = await import("./telegram-command-registration");
      report = await registerTelegramCommands(config, { apply, languageCode: values.get("--language") });
    } else {
      const { registerSlackCommands } = await import("./slack-command-registration");
      report = await registerSlackCommands(config, { apply, manifestTokenEnv: manifestTokenEnv! });
    }
    console.log(JSON.stringify(report, null, 2));
    if (report && typeof report === "object" && "status" in report && report.status === "blocked") process.exitCode = 1;
    return;
  }
  const config = await loadConfig(args[configAt + 1]!);
  const target = args[1] && !args[1]!.startsWith("-") ? args[1]! : "main";
  const paths = hostPaths(config, target);
  if (command === "doctor") {
    loadCredentials(config);
    const probeEnv = { ...process.env };
    for (const name of credentialEnvNames(config)) delete probeEnv[name];
    const probe = Bun.spawn([...config.command, "--help"], { env: probeEnv, stdout: "pipe", stderr: "ignore" });
    const [stdout, code] = await Promise.all([
      new Response(probe.stdout).text(), probe.exited,
    ]);
    if (code !== 0) throw new Error(`OMP command failed (${code}); diagnostic output suppressed to protect credentials`);
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
    const { gatewayStatus } = await import("./gateway");
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
      const { stopGateway } = await import("./gateway");
      await stopGateway(config);
      console.log("Gateway and supervised main host accepted graceful shutdown.");
      return;
    }
    const { connect } = await import("./host");
    const host = await connect(paths.socketPath);
    try {
      const response = await host.request({ type: "shutdown_host" });
      if (!response.success) throw new Error(response.error ?? "Host refused shutdown");
      console.log(`Host ${target} accepted graceful shutdown.`);
    } finally { await host.close(); }
    return;
  }
  if (target !== "main") throw new Error("start only activates the Gateway/main service; lanes remain head-owned");
  loadCredentials(config);
  // Resolve required messenger credentials before native imports can populate env
  // from their own project/provider configuration. Other native settings stay native.
  requireMessengerCredentials(config);
  const { gatewayPaths, launchGateway } = await import("./gateway");
  const status = await launchGateway(config);
  console.log(JSON.stringify({ ...status, gatewaySocketPath: gatewayPaths(config).socketPath,
    gatewayLogPath: gatewayPaths(config).logPath,
    note: "Gateway owns messenger transports. Explicit start may return while initialization is checking/running or blocked. head.ready requires verified native high/middle/low presets; head.initialization reports setup/recovery state separately from approval-reconciled intake readiness. Ordinary input remains durably queued until initialization completes." }, null, 2));
}

if (import.meta.main) {
  await main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
