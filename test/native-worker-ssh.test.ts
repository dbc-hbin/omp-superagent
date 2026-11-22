import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { hostPaths, loadConfig, type Config } from "../src/config";
import { HostConnection, startHost } from "../src/host";
import { Superagent } from "../src/runtime";
import { Store } from "../src/store";
import { RecordingMessenger } from "./fixtures/model-native-runtime";
import { waitForFixtureProcessExit } from "./fixtures/host-fixture-processes";
import { selectWorkerPlacement } from "../src/worker-placement";
import { lookupWorker, remoteLanePaths, workerConnect, workerOpen, workerProbe, type WorkerLaneRef } from "../src/worker-wire";
import { nativeTestArgv } from "./fixtures/native-command";
import { nativeDisabledProviders } from "./fixtures/native-extension";
import { offlineMnemopi } from "./fixtures/native-memory";

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  const deadline = Promise.withResolvers<never>();
  const timer = setTimeout(() => deadline.reject(new Error(`Timed out waiting for ${label}`)), 25_000);
  try { return await Promise.race([promise, deadline.promise]); }
  finally { clearTimeout(timer); }
}

async function shutdownFixture(host: HostConnection) {
  try {
    const state = await host.client.getState();
    expect(await host.request({ type: "shutdown_host" })).toMatchObject({ success: true });
    await host.exited;
    // Both OS processes are local to this loopback test. An RPC acknowledgement
    // alone doesn't mean the owner has finished writing its exit receipt.
    await waitForFixtureProcessExit([state.hostPid, state.adapterOwnerPid]);
  } finally { await host.close(); }
}

/** Real head controller + stock OMP; only the external messenger and inference
 * provider are fixtures. Head and worker have different homes and checkouts. */
async function verifyChatLane(config: Config, enrollment: string, path: string) {
  const model = { provider: "socket-host-smoke", id: "local" };
  const provider = resolve(import.meta.dir, "fixtures/native-extension.ts");
  const agent = join(config.stateDir, ".omp/agent");
  await mkdir(agent, { recursive: true, mode: 0o700 });
  await writeFile(join(agent, "config.yml"), JSON.stringify({ ...offlineMnemopi, disabledProviders: nativeDisabledProviders }));
  const main = hostPaths(config, "main");
  const store = new Store(join(config.stateDir, "coordination.sqlite"));
  const messenger = new RecordingMessenger();
  const errors: unknown[] = [];
  const runtime = new Superagent(config, store, messenger, resolve(import.meta.dir, "../src/lane-extension.ts"), error => errors.push(error));
  const route = { platform: "discord" as const, accountId: "2", authorityId: "1", guildId: "3", channelId: "4", threadId: "50" };
  const wait = async (predicate: () => boolean, message: string) => {
    const deadline = Date.now() + 35_000;
    while (!predicate()) {
      if (errors.length) throw new AggregateError(errors, message);
      if (Date.now() >= deadline) throw new Error(message);
      await Bun.sleep(25);
    }
  };
  const submit = async (id: string, text: string) => {
    await messenger.deliver({ route, id, messageId: id, receivedAt: Date.now(), text, attachments: [] });
    await wait(() => store.input(id)?.state === "done", `Head did not settle input ${id}`);
  };
  let ownedHead: HostConnection | undefined;
  try {
    await Promise.all([dirname(main.socketPath), dirname(main.logPath), dirname(main.sessionFile)]
      .map(dir => mkdir(dir, { recursive: true, mode: 0o700 })));
    await startHost({ ...main, command: config.command, cwd: config.headCwd, extensionPath: provider,
      env: { HOME: config.stateDir, PATH: path, PI_CODING_AGENT_DIR: agent }, managedUlwPath: resolve(import.meta.dir, "fixtures/managed-ulw"),
      model: `${model.provider}/${model.id}`, subagentConcurrency: 1 });
    ownedHead = await HostConnection.connect(main.socketPath);
    await runtime.start();
    messenger.thread = { route, title: "SSH worker QA", archived: false, requiresTag: false, availableTags: [], appliedTags: [] };
    await submit("102", "/head Test on the enrolled worker.");
    const lane = await runtime.startLane({ sourceId: "102", title: "SSH worker QA", cwd: config.headCwd, model,
      modelReason: "Use the offline native fixture.", kickoff: "Starting the remote check.", placement: { target: "remote" } });
    expect(lane.remote?.workerId).toBe(enrollment);
    await wait(() => messenger.sent.some(output => output.sourceId === "report:handoff:102:lane"), "Missing remote result on original thread");
    const first = store.lane(lane.id);
    expect(first?.sessionId).toBeTruthy();
    await submit("103", "/head Continue the same remote work.");
    await runtime.messageLane(lane.id, "Follow up in the original checkout.", "103");
    const result = `report:handoff:103:${lane.id}`;
    await wait(() => messenger.sent.some(output => output.sourceId === result), "Missing follow-up result");
    expect(messenger.sent.find(output => output.sourceId === result)).toMatchObject({ route, text: "Socket host smoke response" });
    expect(store.lane(lane.id)).toMatchObject({ sessionId: first?.sessionId, generation: first?.generation, pid: first?.pid });
  } finally {
    const lanes = store.lanes();
    try {
      await runtime.stop();
      for (const lane of lanes) {
        if (!lane.remote || !lane.pid) continue;
        const { workerRef } = await import("../src/worker-wire");
        const connection = await workerConnect(await lookupWorker(config.stateDir, lane.remote), workerRef(lane));
        await shutdownFixture(connection);
      }
    } finally {
      if (ownedHead) await shutdownFixture(ownedHead);
    }
  }
}

// Needs a locally executable sshd, not an enabled system SSH service. No real
// authorized_keys, provider account, messenger, or existing ssh-agent is used.
const sshTest = process.env.OMP_SUPERAGENT_WORKER_SSH_TEST === "1" ? test : test.skip;
sshTest("enroll via the CLI, launch once over SSH, reconnect to the same stock OMP, and confirm shutdown", async () => {
  const root = await mkdtemp(join(await realpath("/tmp"), "ow-"));
  const target = join(root, "w"), head = join(root, "h"), bin = join(root, "bin");
  const repo = resolve(import.meta.dir, ".."), workspace = join(head, "project"), checkout = join(target, "project");
  const cli = join(repo, "src/cli.ts"), hostKey = join(root, "hostkey");
  const sshdPath = Bun.which("sshd") ?? "/usr/sbin/sshd", ssh = Bun.which("ssh");
  if (!ssh) throw new Error("OpenSSH client required");
  const omp = nativeTestArgv()[0];
  if (!omp) throw new Error("Stock OMP executable required");
  const path = [dirname(omp), dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin"].join(":");
  const env = (home: string) => ({ HOME: home, PATH: path, LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1" });
  const command = (name: string, args: string[], home: string, search = path) => execFileSync(name, args,
    { env: { ...env(home), PATH: search }, cwd: home, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 40_000 });
  const git = (home: string, ...args: string[]) => command("git", ["-c", "core.hooksPath=/dev/null", ...args], home);
  const cliJson = (home: string, ...args: string[]) => JSON.parse(command(process.execPath, ["--no-env-file", cli, ...args], home, `${bin}:${path}`));
  await Promise.all([target,head,bin].map(dir => mkdir(dir, { mode: 0o700 })));
  const configPath = join(head, "config.local.json"), destination = `${userInfo().username}@127.0.0.1`;
  git(head, "init", "-q", workspace);
  await writeFile(join(workspace, "input.txt"), "pinned contents\n");
  git(workspace, "add", "input.txt");
  git(workspace, "-c", "user.name=SSH fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Fixture input");
  const origin = "https://example.invalid/worker/qa.git";
  git(workspace, "remote", "add", "origin", origin);
  git(target, "clone", "-q", "--local", "--no-hardlinks", workspace, checkout);
  git(checkout, "remote", "set-url", "origin", origin);
  await writeFile(configPath, JSON.stringify({ stateDir: head, headCwd: workspace, command: [omp],
    maxHosts: 2, maxSubagents: 2, idleMs: 3_600_000,
    discord: { tokenEnv: "UNUSED_SSH_TEST_TOKEN", ownerId: "1", allowedGuildIds: ["3"], allowedChannelIds: ["4"] } }), { mode: 0o600 });
  const agent = join(target, ".omp", "agent");
  await mkdir(join(agent, "extensions"), { recursive: true, mode: 0o700 });
  await writeFile(join(agent, "config.yml"), JSON.stringify({ ...offlineMnemopi, disabledProviders: nativeDisabledProviders }));
  await writeFile(join(agent, "worker-extensions.json"), JSON.stringify([join(repo, "test/fixtures/native-extension.ts")]), { mode: 0o600 });
  command("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", hostKey], head);
  const known = join(root, "known_hosts");
  await writeFile(known, `worker-fixture ${await readFile(`${hostKey}.pub`, "utf8")}`);
  const reservation = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = reservation.port;
  reservation.stop(true);
  const serverConfig = join(root, "sshd_config");
  await writeFile(serverConfig, [
    `Port ${port}`, "ListenAddress 127.0.0.1", `HostKey ${hostKey}`, `PidFile ${root}/pid`,
    `AuthorizedKeysFile ${target}/.ssh/authorized_keys`, "StrictModes no", "UsePAM no",
    "KbdInteractiveAuthentication no", "PasswordAuthentication no", "AuthenticationMethods publickey",
    `AllowUsers ${userInfo().username}`, "DisableForwarding yes", "PermitTTY no",
    `SetEnv HOME=${target} PATH=${path} PI_CODING_AGENT_DIR=${agent} OMP_SUPERAGENT_TEST_MANAGED_ULW_PATH=${join(repo,"test/fixtures/managed-ulw")}`,
  ].join("\n") + "\n");
  // Use real ssh plus only the fixture's ephemeral port and host-key store.
  // Keep the production argv, including the fixed original command, untouched.
  await writeFile(join(bin, "ssh"), `#!/bin/sh\nexec "${ssh}" -p ${port} -o HostKeyAlias=worker-fixture -o UserKnownHostsFile="${known}" "$@"\n`, { mode: 0o700 });
  const server = Bun.spawn([sshdPath, "-D", "-e", "-f", serverConfig], { env: env(target), stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const logs = createInterface({ input: Readable.fromWeb(server.stderr) });
  const ready = Promise.withResolvers<void>();
  logs.on("line", line => { if (line.includes("Server listening on 127.0.0.1")) ready.resolve(); });
  void server.exited.then(code => ready.reject(new Error(`Fixture sshd exited: ${code}`)));
  const oldPath = process.env.PATH;
  let owned: { socketPath: string; sessionFile: string; pid: number } | undefined, success = false;
  let live: HostConnection | undefined;
  try {
    await within(ready.promise, "loopback sshd");
    const add = ["worker", "add", destination, "--config", configPath];
    const invitation = cliJson(head, ...add);
    expect(invitation.status).toBe("pending");
    expect(cliJson(target, "worker", "init", "--head-key", invitation.publicKey, "--repo", checkout)).toMatchObject({ status: "initialized" });
    expect(cliJson(head, ...add, "--default", "--local-repo", workspace)).toMatchObject({ status: "verified", default: true });
    process.env.PATH = `${bin}:${path}`;
    const config = await loadConfig(configPath);
    const placement = await selectWorkerPlacement(config, workspace);
    if (!placement) throw new Error("Approved default checkout did not select its ready worker");
    const reg = await lookupWorker(config.stateDir, placement);
    const ref: WorkerLaneRef = { laneId: "lane-ssh-qa", generation: 1, revision: placement.revision, repoId: placement.repoId, subdir: placement.subdir };
    const launch = { model: "socket-host-smoke/local", subagentConcurrency: 1 };
    const { pid } = await workerOpen(reg, ref, launch);
    owned = { ...remoteLanePaths(placement, ref.laneId), pid };
    expect(await workerOpen(reg, ref, launch)).toMatchObject({ pid });
    live = await workerConnect(reg, ref);
    const first = await live.client.getState();
    expect(first).toMatchObject({ hostPid: pid, sessionFile: owned.sessionFile, model: { provider: "socket-host-smoke", id: "local" } });
    expect(await live.request({ type: "prompt", message: "/help" })).toMatchObject({ success: false });
    expect(await live.request({ type: "get_state", unexpected: true })).toMatchObject({ success: false });
    await live.close();
    live = await workerConnect(reg, ref);
    expect(await live.client.getState()).toMatchObject({ hostPid: pid, sessionId: first.sessionId });
    const token = "round-trip-through-enrolled-worker", id = crypto.randomUUID();
    const recorded = Promise.withResolvers<void>();
    live.onFrame(frame => {
      if (frame.type === "prompt_result" && frame.id === id && frame.status === "completed") recorded.resolve();
    });
    expect(await live.request({ type: "prompt", message: `Record this ordinary remote turn: ${token}` }, id)).toMatchObject({ success: true });
    await within(recorded.promise, "worker prompt result");
    expect(await readFile(owned.sessionFile, "utf8")).toContain(token);
    const askId = crypto.randomUUID(), answered = Promise.withResolvers<void>(), received = Promise.withResolvers<void>();
    const detach = live.onFrame(frame => {
      if (frame.type === "extension_ui_request" && frame.method === "ask" && typeof frame.id === "string") {
        received.resolve();
        live?.uiResponse(frame.id, { cancelled: true });
      }
      if (frame.type === "prompt_result" && frame.id === askId && frame.status === "completed") answered.resolve();
    });
    try {
      expect(await live.request({ type: "prompt", message: "Ask me to decide. [native-decision-cancel]" }, askId)).toMatchObject({ success: true });
      await within(Promise.all([received.promise, answered.promise]), "worker dialog and final result");
      expect(await readFile(owned.sessionFile, "utf8")).toContain("native-decision-cancel");
    } finally { detach(); }
    await expect(workerConnect(reg, { ...ref, generation: 2 })).rejects.toThrow();
    expect(await live.request({ type: "shutdown_host" })).toMatchObject({ success: true });
    await live.exited;
    const deadline = Date.now() + 10_000;
    for (;;) {
      const state = await workerProbe(reg, ref);
      if (!state.pidAlive && !state.ownerAlive && !state.socket && !state.uncertain) break;
      if (Date.now() > deadline) throw new Error("Native worker exit was not confirmed");
      await Bun.sleep(100);
    }
    await verifyChatLane(config, placement.workerId, path);
    success = true;
  } finally {
    await live?.close();
    try {
      if (!success && owned && await Bun.file(owned.sessionFile).exists()) {
        const local = await HostConnection.connect(owned.socketPath).catch(() => undefined);
        if (local) try {
          const state = await local.client.getState();
          if (state.hostPid === owned.pid && state.sessionFile === owned.sessionFile) await local.request({ type: "shutdown_host" });
        } finally { await local.close(); }
      }
    } finally {
      if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
      server.kill(); await server.exited;
      if (success) await rm(root, { recursive: true });
      else console.error(`Private remote-worker fixture retained: ${root}`);
    }
  }
}, 150_000);
