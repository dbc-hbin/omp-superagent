#!/usr/bin/env -S bun --no-env-file
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { configuredPlatforms, credentialEnvNames, hostPaths, loadConfig, requireMessengerCredentials } from "./config";
import { inspectInstalledOmp } from "./installed-omp";
import { requireHostOwner } from "./host-owner-path";
import { loadCredentials } from "./credentials";
import type { Lane } from "./contracts";
import { readLaneRows } from "./lane-rows";

// Keep Host/SDK imports out of setup, doctor and command registration:
// OMP's dotenv loader must not choose their credential sources.
const HELP = `omp-sa — messenger-connected OMP head and independent topic sessions

Usage:
  omp-sa --help                       (also: omp-sa help)
  omp-sa setup --config FILE
  omp-sa start --config FILE
  omp-sa install --config FILE
  omp-sa uninstall --config FILE
  omp-sa status --config FILE
  omp-sa group [REQUEST_ID] --config FILE
  omp-sa stop [main|LANE_ID] --config FILE
  omp-sa doctor --config FILE
  omp-sa discord-commands --config FILE [--apply]
  omp-sa telegram-commands --config FILE [--language CODE] [--apply]
  omp-sa slack-commands --config FILE --manifest-token-env NAME [--apply]

Setup and service lifecycle:
  setup creates FILE interactively, or preserves an existing FILE and prompts for its configured credentials.
  It saves a private FILE.env and sets configured Discord/Telegram bot profile pictures through REST; it does not start bots.
  Managed sessions keep any enabled native OMP memory backend. If the profile has memory off or unset,
  saving setup or starting a managed session sets memory.backend=mnemopi; project and launch overrides are preserved.
  On first setup, if no native Judge model is configured, setup explains how to select one in ordinary OMP
  (/models > Roles > Judge); it does not choose a model for you.
  doctor checks native prerequisites, the effective memory backend and credential presence without changing settings or logging in.
  start launches a detached Gateway and one HEAD, activating ALL configured messengers. No autostart is installed.
  start can return before HEAD can accept work. Check head.ready and head.initialization in the start response
  (gateway.head in status); initial high/middle/low model presets must be verified before queued work runs.
  status shows live Gateway/HEAD readiness when reachable, login launcher status, and saved lane IDs, models and states.
  group reads the private group request inbox, including restricted worktree paths, without starting the bot.
  A saved lane state does not prove its Host is running or that the work completed.
  stop main shuts down the Gateway and HEAD; a busy Host can refuse. Bare CLI stop also targets main.
  stop LANE_ID requests shutdown of just that managed lane Host. It does not delete the lane or its session.
  install enables macOS per-user startup at future login only; requires configured messenger credentials in private FILE.env
  and native settings/authentication under the OS account home. No immediate start or shell environment capture.
  uninstall removes only the owned login launcher; it does not stop an existing Gateway/head or remove credentials/state.

Add a messenger to an existing installation:
  Edit FILE: keep existing blocks and add the desired top-level block with the fields below.
    discord   tokenEnv, ownerId, allowedGuildIds[], allowedChannelIds[]
    telegram  tokenEnv, ownerId, allowedChatIds[]
    slack     botTokenEnv, appTokenEnv, ownerId, teamId, allowedChannelIds[]
  Copy the block shape from ${join(import.meta.dir, "../config.example.json")}.
  Use string IDs for the same trusted owner on each platform. Credential fields name variables, never tokens.
  Supply their values in the Gateway environment or private FILE.env (mode 0600). Run doctor before activation.
  Editing FILE does not reload a running service. The next Gateway start activates all configured blocks.
  Other FILE settings: command (stock OMP argv), headCwd, stateDir, maxHosts (includes HEAD),
  maxSubagents (shared budget), idleMs (idle lane eviction), optional model (HEAD startup model).

Command registration:
discord-commands uses Discord REST only: dry-run by default, with no Gateway or native runtime activation.
--apply exclusively replaces this dedicated bot's GLOBAL commands with supported Superagent commands, deleting obsolete registrations (including Hermes). Guild commands are preserved; shadowing conflicts refuse apply.
telegram-commands configures owner-scoped Telegram command menus; --language selects an optional Telegram language code.
slack-commands configures /superagent-* commands through the app manifest; NAME identifies an app-configuration token environment variable, never a token argument.
All command registration is read-only by default and requires --apply to change remote configuration. No polling, Socket Mode, or native model session is started.
Running a Host requires an installed stock OMP with stdio RPC (rpc-ui), session resume, and extensions.
Same-process native TUI attach is not supported.

Owner controls in chat (not shell commands):
  Send /help in Discord or Telegram. In Slack messages replace / with ! (e.g. !help, !status);
  registered Slack commands use /superagent-* (e.g. /superagent-status).
  /status, /context, /usage     Inspect HEAD state, context or usage without starting a model turn.
  /model [list|provider/id]     Inspect or select the shared HEAD model; changes require an idle HEAD.
  /model preset [list|NAME]     Inspect or select a preset. Only NAME --global also saves future defaults.
  /effort [LEVEL]               Inspect or change HEAD thinking effort; existing lanes keep their settings.
  /compact [instructions]       Compact idle HEAD context, optionally with multiline instructions.
  /cron [help]                  Schedule and manage one-time or recurring jobs in this conversation.
  /new [request], /main         Start a topic or return to the main topic in the owner's DM.
  /stop [head|LANE_ID]          Stop HEAD work or pause a lane, NOT the service. With no argument, pause
                                the lane bound to this chat, or stop HEAD work if there is no bound lane.
  /resume                       Resume the lane bound to this chat, not HEAD.
  /restart                      Interrupt HEAD work and restart Gateway and HEAD with the same session and
                                memory profile. Independent lanes stay running; interrupted prompts are not replayed.
  /resolve [INPUT_ID]           Close one uncertain HEAD input without retrying it. Use /status to find its ID;
                                the ID is required if several are held. This does not establish task success.
  /resolve --lane INPUT_ID      Close one exact uncertain input in this chat's bound lane, without replay.

Capabilities to request from HEAD in chat (not CLI subcommands):
  Lanes and threads: ask HEAD to start, inspect, steer, pause, resume or close an independent lane,
    select its model/preset, or inspect and update its Discord thread or forum tags.
  PR monitoring: give HEAD a GitHub PR URL and check interval to watch reviews and CI; ask to list or stop watches.
    Requires gh with read access. A change notification does not authorize a merge or a new task.
  Scheduled jobs: explicitly ask HEAD in plain language to schedule a task; manage it with /cron in the same chat.
  Decisions: ask HEAD to request an owner decision, list pending decisions, inspect one or withdraw it.
  Discord channel context: ask HEAD to inspect channel/thread context or set, list or clear a local purpose
    note. Notes do not edit Discord's channel description or authorize work.
  Shared board: registered HEAD and lane sessions can post, read and subscribe to informational updates
    within this instance. Board posts are not commands or approvals.
  Workflows: begin a request with ulw, ulw-plan, ulw-execute, ulw-loop, ulw-research or mass-ulw.
    For batch judging against one rubric, begin with lowercase jevify (not /jevify).
  Operations guide and native tool names: ${join(import.meta.dir, "../docs/OPERATIONS.md")}

Add Discord voice using a Codex subscription (optional; no API key or paid fallback):
  In FILE, set discord.voice to the object below. Preserve the existing discord owner, token and allowlists.
  Replace the IDs with Discord snowflakes (strings). Both channels must be in an allowed guild;
  restrict the voice channel to the owner and bot, and include the text channel in discord.allowedChannelIds.
  {"auth":"subscription","channelId":"VOICE_CHANNEL_ID","textChannelId":"TEXT_CHANNEL_ID","voice":"cove","maxSessionSeconds":300}
  Do not include apiKeyEnv, model or backendModel in this object.

  As the OS user running the Gateway (macOS/Linux):
    codex login                         # Sign in with an eligible ChatGPT account, not an API key.
    omp-sa doctor --config FILE        # Checks config without connecting; does not verify voice entitlement.
  The Gateway includes WebRTC; no Python environment is required. The next Gateway start loads
  the change. Configuration alone does not start a call.

Alternative: Discord voice with separately billed OpenAI Live API (no Codex login):
  Use the same channel allowlists. Set discord.voice to an API object instead of the subscription object:
  {"auth":"api","channelId":"VOICE_CHANNEL_ID","textChannelId":"TEXT_CHANNEL_ID","voice":"marin","maxSessionSeconds":300,"model":"gpt-live-1","backendModel":"gpt-6-luna","apiKeyEnv":"SUPERAGENT_VOICE_OPENAI_KEY"}
  Choose models and a voice available to your account. Put the key in the named environment variable or FILE.env,
  not in JSON; never reuse a messenger token. Omitting auth selects the existing API mode, not subscription.

  Owner commands are ordinary Discord messages in the configured text channel, not CLI or registered slash commands:
    /voice start        Join the configured voice channel first, then start a conversation without work drafts.
    /voice start work   Start a new call that may publish spoken work drafts in this text channel.
    /voice start share  Subscription only: start a new call that may publish one draft within one minute of readiness.
    /voice work off     Revoke posting and invalidate any unconfirmed draft without ending the call.
    /voice confirm      Reply to the exact posted draft to submit it to HEAD. Separate approvals still apply.
    /voice stop         End the call. Only a new call can enable work drafts.
  Live answers ordinary conversation by voice. HEAD replies only in Discord text.
  Full guide: ${join(import.meta.dir, "../docs/discord-voice.md")}
`;

function laneRows(stateDir: string): Lane[] {
  const path = join(stateDir, "coordination.sqlite");
  if (!existsSync(path)) return [];
  const db = new Database(path, { readonly: true });
  try {
    return readLaneRows(db);
  } finally { db.close(); }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  if (!args.length || args.includes("--help") || args[0] === "help") { console.log(HELP); return; }
  const [command] = args;
  if (!["setup", "start", "install", "uninstall", "status", "group", "stop", "doctor", "discord-commands", "telegram-commands", "slack-commands"].includes(command!)) throw new Error(`Unknown command: ${command}`);
  const configAt = args.indexOf("--config");
  if (configAt < 0 || !args[configAt + 1]) throw new Error("--config FILE is required");
  if (command === "install" || command === "uninstall") {
    if (args.length !== 3 || configAt !== 1 || args[2]!.startsWith("-"))
      throw new Error(`Usage: ${command} --config FILE`);
    const config = await loadConfig(args[2]!);
    const { installAutostart, uninstallAutostart } = await import("./autostart");
    console.log(JSON.stringify(await (command === "install" ? installAutostart(config) : uninstallAutostart(config)), null, 2));
    return;
  }
  if (command === "setup") {
    const { setup } = await import("./setup");
    await setup(args[configAt + 1]!);
    return;
  }
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
  if (command === "group") {
    if (!((configAt === 1 && args.length === 3) || (configAt === 2 && args.length === 4 && !args[1]?.startsWith("-")))) {
      throw new Error("Usage: group [REQUEST_ID] --config FILE");
    }
    const { groupRequests } = await import("./group-access");
    console.log(JSON.stringify(groupRequests(config.stateDir, configAt === 2 ? args[1] : undefined), null, 2));
    return;
  }
  const target = args[1] && !args[1]!.startsWith("-") ? args[1]! : "main";
  const paths = hostPaths(config, target);
  if (command === "doctor") {
    const { requireGateway } = await import("./gateway-native");
    const { inspectManagedMemory, memoryBlockReason } = await import("./managed-memory");
    loadCredentials(config);
    const omp = await inspectInstalledOmp(config.command, credentialEnvNames(config));
    const memory = await inspectManagedMemory(config);
    console.log(JSON.stringify({
      config: config.path, command: config.command, headCwd: config.headCwd,
      omp, hostOwnerExecutable: await requireHostOwner(), gatewayExecutable: await requireGateway(), nativeTuiAttach: false,
      maxHosts: config.maxHosts, maxSubagents: config.maxSubagents,
      platforms: configuredPlatforms(config),
      credentials: Object.fromEntries(credentialEnvNames(config).map(name => [name, Boolean(process.env[name])])),
      memory,
      ...(memory.status === "enabled" ? {} : { memoryBlock: memoryBlockReason(memory) }),
      messengersActivated: false,
    }, null, 2));
    if (memory.status !== "enabled") process.exitCode = 1;
    return;
  }
  if (command === "status") {
    const { gatewayStatus } = await import("./gateway-protocol");
    const { autostartStatus } = await import("./autostart");
    console.log(JSON.stringify({
      gateway: await gatewayStatus(config),
      autostart: await autostartStatus(config),
      main: { socketPath: hostPaths(config, "main").socketPath },
      lanes: laneRows(config.stateDir).map(l => ({
        id: l.id, title: l.title, cwd: l.cwd, workState: l.workState,
        model: l.model, modelReason: l.modelReason, modelPreset: l.modelPreset,
        recordedRuntimeState: l.runtimeState, sessionId: l.sessionId, socketPath: l.socketPath,
      })),
      note: "Gateway/head readiness is live when the Gateway is reachable; lane records are not a completion guarantee.",
    }, null, 2));
    return;
  }
  if (target !== "main" && !laneRows(config.stateDir).some(l => l.id === target))
    throw new Error("Unknown managed lane");
  if (command === "stop") {
    if (target === "main") {
      const { stopGateway } = await import("./gateway-native");
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
  // Only pass validated messenger credentials to the native launcher.
  requireMessengerCredentials(config);
  const { gatewayPaths } = await import("./gateway-protocol");
  const { launchGateway } = await import("./gateway-native");
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
