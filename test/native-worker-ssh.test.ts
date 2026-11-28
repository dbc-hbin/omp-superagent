import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { hostPaths, loadConfig, type Config } from "../src/config/config";
import { HostConnection, startHost } from "../src/omp/host";
import { hostOwnerExecutable } from "../src/omp/host-owner-path";
import { Superagent } from "../src/runtime/controller";
import { Store } from "../src/storage/store";
import { DecisionParityMessenger, verifyWorkerDecisionParity } from "./fixtures/native-worker-decision-parity";
import { waitForFixtureProcessExit } from "./fixtures/host-fixture-processes";
import { selectWorkerPlacement } from "../src/worker/worker-placement";
import { lookupWorker, remoteLanePaths, workerConnect, workerOpen, workerProbe, workerRef, type WorkerLaneRef,
  type WorkerRegistration } from "../src/worker/worker-wire";
import { nativeTestArgv } from "./fixtures/native-command";
import { nativeDisabledProviders } from "./fixtures/native-extension";
import { offlineMnemopi } from "./fixtures/native-memory";
import { nativeJournalDispatches } from "./fixtures/native-tool-transport";
import { verifyNativeWorkerMemory } from "./fixtures/native-worker-memory-proof";
import { memoryFixture } from "./fixtures/native-worker-memory-provider";

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

async function verifyNativeBridge(options: {
  readonly ssh: string; readonly known: string; readonly port: number; readonly worker: WorkerRegistration;
  readonly ref: WorkerLaneRef; readonly pid: number;
}) {
  const { ssh, known, port, worker, ref, pid } = options;
  const child = Bun.spawn([ssh, "-F", "/dev/null", "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
    "-o", `UserKnownHostsFile=${known}`, "-o", "GlobalKnownHostsFile=/dev/null", "-o", "UpdateHostKeys=no",
    "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none",
    "-p", `${port}`, "-i", worker.identityFile, `${userInfo().username}@127.0.0.1`, "omp-sa-worker-v1"], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const diagnostics = new Response(child.stderr).text();
  const lines = createInterface({ input: Readable.fromWeb(child.stdout) });
  const upstream = lines[Symbol.asyncIterator]();
  const frame = async (label: string): Promise<unknown> => {
    const next = await within(upstream.next(), label);
    if (next.done) throw new Error(`SSH detached before ${label}: ${await diagnostics}`);
    return JSON.parse(next.value);
  };
  const rpc = { type: "get_state", id: "pipelined-state" };
  try {
    // One write puts work beyond the request newline before either worker reply.
    const attach = { version: 1, op: "attach", workerId: worker.description.workerId, ref };
    await child.stdin.write(`${JSON.stringify(attach)}\n${JSON.stringify(rpc)}\n`);
    await child.stdin.flush();
    expect(await frame("worker reply")).toMatchObject({ ok: true, value: { pid } });
    expect(await frame("native ready")).toMatchObject({ type: "ready" });
    expect(await frame("pipelined response")).toMatchObject({ type: "response", id: rpc.id, success: true, data: { hostPid: pid } });

    // Read live process evidence while this exact SSH stream is still open.
    const policy = join(worker.description.stateDir, "policy.json");
    const processes = execFileSync("/bin/ps", ["-ww", "-ax", "-o", "pid=", "-o", "ppid=", "-o", "comm=", "-o", "args="],
      { encoding: "utf8" }).split("\n").filter(line => line.includes(policy));
    expect(processes).toHaveLength(1);
    expect(processes[0]).toContain(`${hostOwnerExecutable} --worker-serve `);
    expect(processes[0]).not.toMatch(/\bbun(?:-dev)? \S*--no-env-file/);

    // A duplicate delivery of the first pipelined RPC would arrive before
    // this later request and fail the exact correlation check.
    await child.stdin.write(`${JSON.stringify({ ...rpc, id: "after-handoff" })}\n`);
    await child.stdin.flush();
    expect(await frame("post-handoff response")).toMatchObject({ type: "response", id: "after-handoff", success: true });
    await child.stdin.end();
    expect(await within(child.exited, "native bridge detach")).toBe(0);
  } finally {
    lines.close();
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
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
  const messenger = new DecisionParityMessenger();
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
      env: { HOME: config.stateDir, PATH: path, PI_CODING_AGENT_DIR: agent }, managedUlwPath: resolve(import.meta.dir, "fixtures/managed-super"),
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
    await verifyWorkerDecisionParity({ runtime, store, messenger, lane, stateDir: config.stateDir });
  } finally {
    const lanes = store.lanes();
    try {
      await runtime.stop();
      for (const lane of lanes) {
        if (!lane.remote || !lane.pid) continue;
        const registration = await lookupWorker(config.stateDir, lane.remote);
        const ref = workerRef(lane);
        await shutdownFixture(await workerConnect(registration, ref));
        // The next phase reuses this worker's only slot. Let the worker
        // verify the native exit receipt and retire the durable checkout claim.
        expect(await workerProbe(registration, ref)).toMatchObject({
          exitGeneration: ref.generation, socket: false, pidAlive: false, ownerAlive: false, uncertain: false,
        });
      }
    } finally {
      if (ownedHead) await shutdownFixture(ownedHead);
    }
  }
}

// Needs a locally executable sshd, not an enabled system SSH service. No real
// authorized_keys, provider account, messenger, or existing ssh-agent is used.
const sshTest = process.env.OMP_SUPERAGENT_WORKER_SSH_TEST === "1" ? test : test.skip;
sshTest("enroll stock OMP over SSH, reconnect, and sync explicit remote project facts into native HEAD", async () => {
  const root = await mkdtemp(join(await realpath("/tmp"), "ow-"));
  const target = join(root, "w"), head = join(root, "h"), bin = join(root, "bin");
  const repo = resolve(import.meta.dir, ".."), workspace = join(head, "project"), checkout = join(target, "project");
  const managedSuper = join(repo, "test/fixtures/managed-super");
  const cli = join(repo, "src/cli.ts"), hostKey = join(root, "hostkey");
  const sshdPath = Bun.which("sshd") ?? "/usr/sbin/sshd", ssh = Bun.which("ssh");
  if (!ssh) throw new Error("OpenSSH client required");
  const omp = nativeTestArgv()[0];
  if (!omp) throw new Error("Stock OMP executable required");
  const path = [dirname(omp), dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin"].join(":");
  const env = (home: string) => ({
    HOME: home, PATH: path, LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1",
    OMP_SUPERAGENT_TEST_MANAGED_ULW_PATH: managedSuper,
  });
  const command = (name: string, args: string[], home: string, search = path) => execFileSync(name, args,
    { env: { ...env(home), PATH: search }, cwd: home, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 40_000 });
  const git = (home: string, ...args: string[]) => command("git", ["-c", "core.hooksPath=/dev/null", ...args], home);
  const cliJson = (home: string, ...args: string[]) => JSON.parse(command(process.execPath, ["--no-env-file", cli, ...args], home, `${bin}:${path}`));
  await Promise.all([target,head,bin].map(dir => mkdir(dir, { mode: 0o700 })));
  const configPath = join(head, "config.local.json");
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
  await mkdir(join(target, memoryFixture.directory), { mode: 0o700 });
  await writeFile(join(agent, "config.yml"), JSON.stringify({ ...offlineMnemopi, autolearn: { enabled: true },
    models: { offline: true }, disabledProviders: nativeDisabledProviders }), { mode: 0o600 });
  await writeFile(join(agent, "worker-extensions.json"), JSON.stringify([join(repo, "test/fixtures/native-extension.ts")]), { mode: 0o600 });
  command("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", hostKey], head);
  const known = join(root, "known_hosts");
  const reservation = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = reservation.port;
  reservation.stop(true);
  const destination = `${userInfo().username}@127.0.0.1:${port}`;
  await writeFile(known, `[127.0.0.1]:${port} ${await readFile(`${hostKey}.pub`, "utf8")}`, { mode: 0o600 });
  const serverConfig = join(root, "sshd_config");
  await writeFile(serverConfig, [
    `Port ${port}`, "ListenAddress 127.0.0.1", `HostKey ${hostKey}`, `PidFile ${root}/pid`,
    `AuthorizedKeysFile ${target}/.ssh/authorized_keys`, "StrictModes no", "UsePAM no",
    "KbdInteractiveAuthentication no", "PasswordAuthentication no", "AuthenticationMethods publickey",
    `AllowUsers ${userInfo().username}`, "DisableForwarding yes", "PermitTTY no",
    `SetEnv HOME=${target} PATH=${path} PI_CODING_AGENT_DIR=${agent} OMP_SUPERAGENT_TEST_MANAGED_ULW_PATH=${managedSuper}`,
  ].join("\n") + "\n");
  // Isolate the host-key store. The real client must use the enrolled port.
  await writeFile(join(bin, "ssh"), `#!/bin/sh\nexec "${ssh}" -o UserKnownHostsFile="${known}" -o GlobalKnownHostsFile=/dev/null -o UpdateHostKeys=no "$@"\n`,
    { mode: 0o700 });
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
    // Simulate an inherited group-write default at the private fixture's
    // forced command without altering the enrollment/authorization guards.
    const authorizedKeys = join(target, ".ssh", "authorized_keys");
    const authorization = await readFile(authorizedKeys, "utf8");
    const forced = 'restrict,command="';
    assert(authorization.startsWith(forced + "exec "));
    await writeFile(authorizedKeys, forced + "umask 002; " + authorization.slice(forced.length));
    expect(cliJson(head, ...add, "--default", "--local-repo", workspace)).toMatchObject({ status: "verified", default: true });
    process.env.PATH = `${bin}:${path}`;
    const config = await loadConfig(configPath);
    const placement = await selectWorkerPlacement(config, workspace);
    if (!placement) throw new Error("Approved default checkout did not select its ready worker");
    expect(cliJson(head, "worker", "list", "--config", configPath).workers)
      .toMatchObject([{ destination, workerId: placement.workerId, default: true }]);
    expect(cliJson(head, "worker", "doctor", destination, "--config", configPath)).toMatchObject({
      status: "ok", worker: { destination, workerId: placement.workerId }, live: { active: 0, available: 1 },
      workspace: { repoId: placement.repoId, revision: placement.revision, subdir: placement.subdir },
    });
    const reg = await lookupWorker(config.stateDir, placement);
    const ref: WorkerLaneRef = { laneId: "lane-ssh-qa", generation: 1, revision: placement.revision, repoId: placement.repoId, subdir: placement.subdir };
    const launch = { model: "socket-host-smoke/local", subagentConcurrency: 1 };
    const late = { ...ref, laneId: "lane-late-open" };
    const fresh = await workerProbe(reg, late);
    expect(fresh).toMatchObject({ memoryLaunchVersion: 1, socket: false, sessionFile: false, uncertain: false });
    expect(fresh.sealedGeneration).toBeUndefined();
    const sealed = await workerProbe(reg, late, true);
    expect(sealed).toMatchObject({ sealedGeneration: late.generation, socket: false });
    expect(sealed.memoryLaunchVersion).toBeUndefined();
    await expect(workerOpen(reg, late, launch)).rejects.toThrow("sealed");
    // A failure in native launch composition must not consume the sole slot
    // or leave a checkout claim when no session/owner has been started yet.
    const bad = { ...ref, laneId: "lane-preflight" };
    const settings = join(agent, "config.yml");
    const before = await readFile(settings);
    await writeFile(settings, JSON.stringify({ memory: { backend: "off" }, disabledProviders: nativeDisabledProviders }));
    await expect(workerOpen(reg, bad, launch)).rejects.toThrow("no Host was launched");
    expect(await workerProbe(reg, bad)).toMatchObject({ socket: false, sessionFile: false, uncertain: false });
    await writeFile(settings, before);
    const { pid } = await workerOpen(reg, ref, launch);
    owned = { ...remoteLanePaths(placement, ref.laneId), pid };
    const journal = await lstat(owned.sessionFile);
    assert(journal.isFile() && journal.uid === process.getuid?.(), "Worker did not publish an owned session journal");
    expect(journal.mode & 0o022).toBe(0);
    expect(await workerOpen(reg, ref, launch)).toMatchObject({ pid });
    await verifyNativeBridge({ ssh, known, port, worker: reg, ref, pid });
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
    expect(await live.request({ type: "prompt", message: `Record this ordinary remote turn: ${token}. ${memoryFixture.seed}` }, id))
      .toMatchObject({ success: true });
    await within(recorded.promise, "worker prompt result");
    expect(await readFile(owned.sessionFile, "utf8")).toContain(token);
    const seed = await live.request({ type: "get_entries" });
    assert(seed.success && seed.command === "get_entries", "No native journal for the non-opted-in worker");
    expect(nativeJournalDispatches(seed.data.entries).filter(call => call.name === "retain" && call.mode === "execute")
      .map(call => ({ ok: call.ok, args: call.args }))).toEqual([
      { ok: true, args: { items: [{ content: memoryFixture.unshared }] } },
    ]);
    expect(await live.request({ type: "get_worker_memory", after: 0 })).toMatchObject({ success: false });
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

    // Use the same isolated sshd/worker enrollment, but a clean HEAD home for
    // the live in-process SDK binding provided by the production extension.
    const memoryHome = join(head, "m");
    const memoryConfigPath = join(memoryHome, "config.json");
    await mkdir(join(memoryHome, "workers"), { recursive: true, mode: 0o700 });
    await copyFile(reg.identityFile, join(memoryHome, "workers", basename(reg.identityFile)));
    await writeFile(memoryConfigPath, JSON.stringify({
      ...config, stateDir: memoryHome, headCwd: workspace, remoteMemorySync: true, idleMs: 12_000,
      model: launch.model,
    }), { mode: 0o600 });
    expect(cliJson(memoryHome, "worker", "add", destination, "--config", memoryConfigPath, "--default", "--local-repo", workspace))
      .toMatchObject({ status: "verified", default: true });
    await verifyNativeWorkerMemory(await loadConfig(memoryConfigPath), {
      workerHome: target, workerCwd: checkout, workerId: placement.workerId, path: `${bin}:${path}`,
    });
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
}, 180_000);
