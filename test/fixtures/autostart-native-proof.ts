/** Actual CLI/launchd proof. Only model RPC and Messenger use existing local fixtures. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { hostPaths, loadConfig } from "../../src/config";
import type { Messenger } from "../../src/contracts";
import { loadCredentials } from "../../src/credentials";

const root = (() => {
  const value = process.env.OMP_AUTOSTART_NATIVE_ROOT;
  assert(value && path.isAbsolute(value) && process.env.HOME === path.join(value, "home"));
  return value;
})();
assert.equal(process.platform, "darwin");
assert(process.getuid);
const domain = `gui/${process.getuid()}`;
const label = `app.omp-superagent.${createHash("sha256").update(await fs.realpath(root)).digest("hex").slice(0, 24)}`;
const target = `${domain}/${label}`;
const installedPath = path.join(os.userInfo().homedir, "Library", "LaunchAgents", `${label}.plist`);
const bootstrapPath = path.join(root, "login.plist");
const configPath = path.join(root, "config.json");
const cliPath = path.resolve(import.meta.dir, "../../src/cli.ts");
const hostFixture = path.resolve(import.meta.dir, "gateway-host.ts");
const secret = `isolated-autostart-not-an-account-${crypto.randomUUID()}`;
const interrupted = new AbortController();
const interrupt = () => interrupted.abort(new Error("Owned autostart proof interrupted"));
process.on("SIGTERM", interrupt);
process.on("SIGINT", interrupt);
const evidence: Record<string, unknown> = {
  domain, label, installedPath, bootstrapPath,
  scope: "Actual CLI install/status/uninstall and actual launchd bootstrap; copied definition changes only isolation environment.",
  limits: [
    "No real login, reboot, cold account activation, or detached Gateway process-group survival was exercised.",
    "Actual CLI start returns an independently running real Gateway; the existing Host RPC fixture and recording Messenger avoid all bot/model network calls.",
  ],
};
let installedBytes: Buffer | undefined;
let registrationOwned = false;
let service: import("../../src/gateway").GatewayService | undefined;
let headPid: number | undefined;
let messengerStopped = false;

async function run(cmd: string[], timeoutMs = 15_000) {
  const child = Bun.spawn({ cmd, cwd: root, env: process.env, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
  const killTimer = setTimeout(() => child.kill("SIGKILL"), timeoutMs + 2_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    return { code, stdout, stderr };
  } finally { clearTimeout(timer); clearTimeout(killTimer); }
}
async function checked(cmd: string[]) {
  const result = await run(cmd);
  assert.equal(result.code, 0, `${cmd.join(" ")}\n${result.stdout}${result.stderr}`);
  return result.stdout;
}
const launchctl = (...args: string[]) => run(["/bin/launchctl", ...args]);
async function cli(command: string) {
  return JSON.parse(await checked([process.execPath, "--no-env-file", cliPath, command, "--config", configPath]));
}
async function until(predicate: () => boolean | Promise<boolean>, detail: string, cleanup = false) {
  const deadline = Date.now() + (cleanup ? 15_000 : 25_000);
  while (!await predicate()) {
    if (!cleanup) interrupted.signal.throwIfAborted();
    assert(Date.now() < deadline, `${detail}; retained ${root}`);
    await Bun.sleep(25);
  }
}
async function launches(): Promise<Array<{ pid: number; args: string[]; credentialPresent: boolean }>> {
  if (!existsSync(path.join(root, "launches.jsonl"))) return [];
  return (await fs.readFile(path.join(root, "launches.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
}
async function liveHead() {
  assert(service && headPid);
  assert.equal(service.status().gateway.pid, process.pid);
  assert.equal(service.status().head.pid, headPid);
  assert.equal(service.status().head.ready, true);
  assert.equal(messengerStopped, false);
  assert.equal((await launches()).length, 1);
  process.kill(headPid, 0);
}
async function install() {
  let result;
  try { result = await cli("install"); }
  finally {
    // A lost CLI receipt does not authorize forgetting a file this exact
    // attempt created. Preflight already proved this random label absent.
    if (existsSync(installedPath)) installedBytes = await fs.readFile(installedPath);
  }
  assert.equal(result.label, label);
  assert.equal(result.plistPath, installedPath);
  assert.equal(result.installed, true);
  assert.equal(result.ownership, "owned");
  assert.equal(result.loaded, false, "Install must never bootstrap a launcher");
  assert(installedBytes);
  assert(!installedBytes.includes(secret), "A credential must never enter the service definition");
  assert(!installedBytes.includes("GATEWAY_TEST_BOT_TOKEN"), "Only the private credential file supplies credentials");
  await checked(["/usr/bin/plutil", "-lint", installedPath]);
  const definition = JSON.parse(await checked(["/usr/bin/plutil", "-convert", "json", "-o", "-", installedPath]));
  assert.deepEqual(definition.ProgramArguments, [await fs.realpath(process.execPath), "--no-env-file", cliPath, "start", "--config", configPath]);
  assert.equal(definition.Label, label);
  assert.equal(definition.RunAtLoad, true);
  assert.equal(definition.KeepAlive, false);
  assert.equal(definition.AbandonProcessGroup, true);
  assert.equal(definition.EnvironmentVariables.HOME, os.userInfo().homedir);
  assert.deepEqual(Object.keys(definition.EnvironmentVariables).sort(), ["HOME", "PATH"]);
  assert.notEqual((await launchctl("print", target)).code, 0, "Install must not start/register a job");
  // Native imports can migrate HOME's settings. Bootstrap ONLY this isolated copy,
  // never the installed production-HOME definition. All execution/policy keys stay exact.
  const { EnvironmentVariables: originalEnv, ...policy } = definition;
  definition.EnvironmentVariables = {
    ...originalEnv,
    ...Object.fromEntries(["HOME", "USERPROFILE", "PI_CODING_AGENT_DIR", "PI_NO_TITLE", "CI", "NO_COLOR",
      "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR",
      "COPILOT_HOME", "TMPDIR", "TMP", "TEMP", "PI_NATIVES_DIR"]
      .flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]])),
  };
  assert.deepEqual((({ EnvironmentVariables: _, ...rest }) => rest)(definition), policy);
  await fs.writeFile(bootstrapPath, JSON.stringify(definition), { mode: 0o600 });
  await checked(["/usr/bin/plutil", "-convert", "xml1", bootstrapPath]);
  await checked(["/usr/bin/plutil", "-lint", bootstrapPath]);
  return result;
}
async function bootstrap() {
  await liveHead(); // Never let the actual CLI activate a real adapter.
  registrationOwned = true; // Even a lost bootstrap receipt must be reconciled.
  const result = await launchctl("bootstrap", domain, bootstrapPath);
  evidence.bootstrap = result;
  assert.equal(result.code, 0,
    `Actual GUI launchd bootstrap unsupported/failed; no detached fallback was used:\n${result.stdout}${result.stderr}`);
  let output = "";
  await until(async () => {
    const result = await launchctl("print", target);
    output = result.stdout;
    return result.code === 0 && /\bstate = not running\b/.test(output) && /\bruns = 1\b/.test(output)
      && /\blast exit code = 0\b/.test(output) && !/^\s*pid = \d+/m.test(output);
  }, "Actual one-shot CLI start did not exit successfully");
  assert(output.includes(bootstrapPath), "Only the exact test-owned registration may be inspected/removed");
  evidence.launcher = output;
  await liveHead();
  const status = await cli("status");
  assert.equal(status.gateway.gateway.pid, process.pid);
  assert.equal(status.gateway.head.pid, headPid);
  assert.equal(status.autostart.label, label);
  assert.equal(status.autostart.installed, true);
  return output;
}
async function bootoutCopy() {
  if (!registrationOwned) return;
  let output = "";
  await until(async () => {
    const result = await launchctl("print", target);
    if (result.code !== 0) { registrationOwned = false; return true; }
    output = result.stdout;
    assert(output.includes(bootstrapPath) && output.includes(cliPath) && output.includes(configPath),
      "Refusing to remove a registration not matching exact test path/program/config");
    return /\bstate = not running\b/.test(output) && !/^\s*pid = \d+/m.test(output);
  }, "Owned launcher did not become idle for cleanup", true);
  if (!registrationOwned) return;
  await checked(["/bin/launchctl", "bootout", target]);
  registrationOwned = false;
  assert.notEqual((await launchctl("print", target)).code, 0);
}
async function uninstall() {
  assert(installedBytes);
  assert((await fs.readFile(installedPath)).equals(installedBytes), "Refusing to uninstall a changed/foreign plist");
  const result = await cli("uninstall");
  assert.equal(result.label, label);
  assert.equal(result.installed, false);
  assert.equal(existsSync(installedPath), false);
  installedBytes = undefined;
  return result;
}

try {
  assert(!existsSync(installedPath), "Refusing an existing account LaunchAgent, even on a label collision");
  assert.notEqual((await launchctl("print", target)).code, 0, "Refusing any existing registration");
  const disabledBefore = await checked(["/bin/launchctl", "print-disabled", domain]);
  assert(!disabledBefore.includes(`"${label}"`), "Refusing a preexisting override for the unique test label");
  await fs.mkdir(path.join(root, "agent"), { mode: 0o700 });
  await fs.writeFile(path.join(root, "agent/config.yml"), "{}\n", { mode: 0o600 });
  await fs.writeFile(path.join(root, "agent/models.yml"), "providers: {}\n", { mode: 0o600 });
  await fs.writeFile(configPath, JSON.stringify({
    stateDir: root, headCwd: root,
    command: [process.execPath, "--no-env-file", hostFixture],
    maxHosts: 2, maxSubagents: 2, idleMs: 3_600_000, model: "autostart-fixture/local",
    discord: { tokenEnv: "GATEWAY_TEST_BOT_TOKEN", ownerId: "2", allowedGuildIds: [], allowedChannelIds: [] },
  }), { mode: 0o600 });
  await fs.writeFile(`${configPath}.env`, `GATEWAY_TEST_BOT_TOKEN=${secret}\n`, { mode: 0o600 });
  const config = await loadConfig(configPath);
  loadCredentials(config);
  // Preserve the CLI's credential-before-native-import boundary.
  const { startGateway } = await import("../../src/gateway");
  const { gatewayStatus } = await import("../../src/gateway-protocol");
  const absent = await cli("status");
  assert.equal(absent.gateway, null);
  assert.equal(absent.autostart.installed, false);
  evidence.firstInstall = await install();
  assert.equal(await gatewayStatus(config), null);
  assert.equal((await launches()).length, 0, "Install must not activate the Gateway/head");
  assert(!existsSync(hostPaths(config, "main").socketPath));

  const messenger: Messenger = {
    async start() { await fs.appendFile(path.join(root, "messenger.jsonl"), '{"kind":"start"}\n'); },
    async stop() { messengerStopped = true; },
    async send(output) { await fs.appendFile(path.join(root, "sent.jsonl"), `${JSON.stringify(output)}\n`); return "local"; },
    async showApproval() { return "local"; }, async dismissApproval() {},
    async createThread(route) { return route; }, async fetchAfter() { return null; },
    async openAttachment() { return new Response("local"); },
  };
  service = await startGateway(config, { messenger, onError: () => {},
    managedUlwPath: path.resolve(import.meta.dir, "managed-ulw"),
  });
  await until(() => service!.status().head.ready, "Isolated Gateway/fixture head readiness");
  headPid = service.status().head.pid!;
  evidence.gatewayPid = process.pid;
  evidence.headPid = headPid;
  assert.equal((await launches())[0]!.credentialPresent, false);
  await bootstrap();

  await fs.writeFile(path.join(root, "busy"), "independently owned work\n", { mode: 0o600 });
  const refusedStop = await run([process.execPath, "--no-env-file", cliPath, "stop", "--config", configPath]);
  assert.notEqual(refusedStop.code, 0, "Autostart must not bypass native busy-stop ownership");
  await liveHead();
  // Exercise the existing restart gate as well: a sent owner intent and its
  // matching fence cannot authorize replacement while native work is busy.
  const { Store } = await import("../../src/store");
  const request = { requestId: crypto.randomUUID(), inputId: "autostart-restart", ackOutputId: "autostart-restart-ack" };
  const route = { platform: "discord" as const, accountId: "1", authorityId: "2", guildId: null, channelId: "3", threadId: null };
  const store = new Store(path.join(root, "coordination.sqlite"));
  try {
    store.receive({ id: request.inputId, route, messageId: request.inputId, text: "/restart", receivedAt: Date.now(), attachments: [] },
      "main", { [`user-source:${request.inputId}`]: "true" });
    store.settle(request.inputId, "done");
    store.queueOutput({ id: request.ackOutputId, sourceId: request.inputId, route, text: "Local restart acknowledgement" });
    store.claimOutput(request.ackOutputId);
    store.finishOutput(request.ackOutputId, "sent", "local");
    store.setMeta("head:restart-fence", JSON.stringify({ ...request, ownerPid: headPid,
      sessionId: "gateway-fixture-session", sessionFile: hostPaths(config, "main").sessionFile,
      state: "accepted", stopBoundary: store.getMeta("gateway:operator-stop") }));
  } finally { store.close(); }
  const refusedRestart = await service.restart(request);
  assert.equal(refusedRestart.state, "refused");
  assert.match(refusedRestart.reason!, /busy/);
  evidence.refusedRestart = refusedRestart;
  await liveHead();
  // The registered copy has a deliberately different path/environment. Remove
  // only that exact idle copy, then exercise real CLI uninstall of its original.
  await bootoutCopy();
  evidence.firstUninstall = await uninstall();
  await liveHead();
  assert.deepEqual(await service.restart(request), refusedRestart, "Uninstall must not rewrite existing restart authority");
  assert(existsSync(path.join(root, "busy")), "Uninstall must not alter independent work");

  evidence.secondInstall = await install();
  await bootstrap();
  await fs.rm(path.join(root, "busy"));
  await checked([process.execPath, "--no-env-file", cliPath, "stop", "--config", configPath]);
  await until(async () => (await gatewayStatus(config)) === null && messengerStopped, "Explicit CLI stop completes");
  // Observe multiple real Gateway supervision ticks with the one-shot job STILL
  // loaded: no KeepAlive recovery, launchctl kickstart, or replacement is allowed.
  await Bun.sleep(2_200);
  const afterStop = await launchctl("print", target);
  assert.equal(afterStop.code, 0, afterStop.stderr);
  assert(/\bruns = 1\b/.test(afterStop.stdout), afterStop.stdout);
  assert(/\bstate = not running\b/.test(afterStop.stdout), afterStop.stdout);
  assert.equal((await launches()).length, 1, "Explicit stop must not be resurrected");
  assert.equal(await gatewayStatus(config), null);
  evidence.afterStop = afterStop.stdout;
  await bootoutCopy();
  evidence.secondUninstall = await uninstall();
  evidence.finalStatus = await cli("status");
  const disabledAfter = await checked(["/bin/launchctl", "print-disabled", domain]);
  assert(!disabledAfter.includes(`"${label}"`), "No test-owned enable/disable override may remain");
  evidence.completed = true;
} catch (error) {
  evidence.error = error instanceof Error ? error.stack : String(error);
  throw error;
} finally {
  const failures: string[] = [];
  try { await bootoutCopy(); } catch (error) { failures.push(String(error)); }
  if (installedBytes) {
    try { await uninstall(); } catch (error) { failures.push(String(error)); }
  }
  try {
    await fs.rm(path.join(root, "busy"), { force: true });
    if (service) {
      // Service handle belongs to this fixture, never a process-name/PID guess.
      await service.stop();
      await service.close();
    }
    if (headPid) {
      await until(() => {
        try { process.kill(headPid!, 0); return false; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error; }
      }, "Exact fixture head exit", true);
    }
  } catch (error) { failures.push(String(error)); }
  evidence.cleanup = { registrationRemoved: !registrationOwned, plistRemoved: !existsSync(installedPath), failures };
  await fs.writeFile(path.join(root, "autostart-evidence.json"), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  process.off("SIGTERM", interrupt);
  process.off("SIGINT", interrupt);
  assert.equal(failures.length, 0, `Owned autostart cleanup failed: ${failures.join("\n")}; retained ${root}`);
}
