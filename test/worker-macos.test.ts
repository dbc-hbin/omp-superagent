import { afterEach, expect, test } from "bun:test";
import { dlopen, FFIType } from "bun:ffi";
import { chmodSync, closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, realpath, rm, stat, symlink } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import {
  codesignIdentity, installWorkerLauncher, launcherPath, macosWorkerStatus, parsePayloadPointer, payloadPointerPath, protectedPaths,
  readGrants, requireMacosWorkerReady, serializePayloadPointer, supportDirectory, tccCategory, writeGrants, writePayloadPointer
} from "../src/worker-macos";
import { prepareMacosWorker, setupMacosWorker } from "../src/worker-macos-setup";
import { macosPrepareScript, newNonce, parseFacts, userSshdApplyScript, userSshdInspectScript } from "../src/worker-setup-remote";
import { listenAddress, planUserSshd, userSshdConfig, userSshdDirectory, userSshdFacts, userSshdPlist, USER_SSHD_BINARY, type UserSshdDesired } from "../src/worker-user-sshd";
import { LABEL_PREFIX, runInUserContext } from "../src/worker-user-context";

const darwin = test.skipIf(process.platform !== "darwin");
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
}, { timeout: 30_000 });

async function privateRoot(): Promise<string> {
  const root = await mkdtemp(join(await realpath("/tmp"), "wmac-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("the payload pointer is one absolute executable and its arguments, one per line", () => {
  expect(parsePayloadPointer("/opt/bun\n--no-env-file\n/rel/1/src/server.ts\n")).toEqual(["/opt/bun", "--no-env-file", "/rel/1/src/server.ts"]);
  expect(parsePayloadPointer("/opt/bun")).toEqual(["/opt/bun"]);
  expect(serializePayloadPointer(["/opt/bun", "a b"])).toBe("/opt/bun\na b\n");
  expect(() => parsePayloadPointer("bun\nx\n")).toThrow("absolute");
  expect(() => parsePayloadPointer("/opt/bun\n\nx\n")).toThrow("empty");
  expect(() => parsePayloadPointer("/opt/bun\nx\0y\n")).toThrow("binary");
  expect(() => parsePayloadPointer(`/opt/bun\n${"x".repeat(17_000)}\n`)).toThrow("size limit");
  expect(() => parsePayloadPointer(`/opt/bun\n${"x\n".repeat(40)}`)).toThrow("excessive");
  expect(() => serializePayloadPointer(["/opt/bun", "two\nlines"])).toThrow("single lines");
});

test("privacy-protected folders are classified by canonical path, and everything else needs no grant", () => {
  const home = "/Users/worker";
  expect(tccCategory("/Users/worker/Desktop/app", home)).toBe("desktop");
  expect(tccCategory("/Users/worker/Documents", home)).toBe("documents");
  expect(tccCategory("/Users/worker/Downloads/x", home)).toBe("downloads");
  expect(tccCategory("/Users/worker/Library/Mobile Documents/com~apple~CloudDocs", home)).toBe("icloud-drive");
  expect(tccCategory("/Users/worker/Library/CloudStorage/Dropbox", home)).toBe("cloud-storage");
  expect(tccCategory("/Volumes/External/code", home)).toBe("removable-or-network");
  for (const path of ["/Users/worker/projects", "/Users/worker/DocumentsOld", "/Users/worker/.osa", "/private/tmp/x", "/opt/work"]) {
    expect(tccCategory(path, home)).toBeNull();
  }
  expect(protectedPaths({ stateDir: "/Users/worker/.osa", workspaceRoots: ["/Users/worker/projects", "/Volumes/E/code"] }, home))
    .toEqual([{ path: "/Volumes/E/code", category: "removable-or-network" }]);
});

test("a worker without the launcher is refused with the setup step, before any launch", async () => {
  const support = join(await privateRoot(), "support");
  expect(() => requireMacosWorkerReady({ stateDir: "/x", workspaceRoots: ["/x/work"] }, support)).toThrow("not installed");
  expect(macosWorkerStatus({ stateDir: "/x", workspaceRoots: ["/x/work"] }, support)).toMatchObject({ launcher: null, grants: null, missing: [] });
});

test("the payload pointer is private, atomic and rewritten only when it changes", async () => {
  const support = join(await privateRoot(), "support");
  expect(writePayloadPointer(support, ["/opt/bun", "/rel/1"])).toBe(true);
  expect(writePayloadPointer(support, ["/opt/bun", "/rel/1"])).toBe(false);
  expect(writePayloadPointer(support, ["/opt/bun", "/rel/2"])).toBe(true);
  expect(readFileSync(payloadPointerPath(support), "utf8")).toBe("/opt/bun\n/rel/2\n");
  expect((await stat(payloadPointerPath(support))).mode & 0o777).toBe(0o600);
  expect((await stat(support)).mode & 0o777).toBe(0o700);
  expect((await readdir(support)).filter(name => name.endsWith(".tmp"))).toEqual([]);
});

darwin("an installed launcher is never replaced and its recorded identity gates the grants", async () => {
  const support = join(await privateRoot(), "support");
  const first = installWorkerLauncher(support);
  expect(first).toMatchObject({ installed: true, identifier: "com.omp-superagent.worker-launcher" });
  const bytes = readFileSync(launcherPath(support));
  const second = installWorkerLauncher(support);
  expect(second).toMatchObject({ installed: false, cdhash: first.cdhash });
  expect(readFileSync(launcherPath(support)).equals(bytes)).toBe(true);

  const scope = { stateDir: join(support, "state"), workspaceRoots: ["/Volumes/External/code"] };
  expect(macosWorkerStatus(scope, support).missing).toEqual([{ path: "/Volumes/External/code", category: "removable-or-network" }]);
  expect(() => requireMacosWorkerReady(scope, support)).toThrow("let the worker launcher read /Volumes/External/code (removable-or-network)");
  const grants = { version: 1 as const, launcher: { identifier: first.identifier, cdhash: first.cdhash }, fullDiskAccess: false, folders: ["removable-or-network"], recordedAt: "now" };
  writeGrants(support, grants);
  expect((await stat(join(support, "grants.json"))).mode & 0o777).toBe(0o600);
  expect(readGrants(support)).toEqual(grants);
  expect(() => requireMacosWorkerReady(scope, support)).not.toThrow();
  writeGrants(support, { ...grants, launcher: { ...grants.launcher, cdhash: "0".repeat(40) } });
  expect(() => requireMacosWorkerReady(scope, support)).toThrow("changed since its grants were recorded");
}, 60_000);

async function ourJobs(): Promise<string[]> {
  const child = Bun.spawnSync(["launchctl", "list"], { stdout: "pipe" });
  return child.stdout.toString("utf8").split("\n").filter(line => line.includes(LABEL_PREFIX));
}

async function untilTrue(condition: () => boolean | Promise<boolean>, what: string, timeoutMs = 15_000): Promise<void> {
  // Polls a real OS state change (launchd job lifecycle, process exit) that has no event to await.
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
}

const libSystem = process.platform === "darwin"
  ? dlopen("/usr/lib/libSystem.B.dylib", { responsibility_get_pid_responsible_for_pid: { args: [FFIType.i32], returns: FFIType.i32 } }) : undefined;
const responsibleFor = (pid: number) => libSystem!.symbols.responsibility_get_pid_responsible_for_pid(pid);

darwin("the job always runs the one fixed launcher while the payload version changes, and the launcher keeps attribution until the Host ends", async () => {
  const root = await privateRoot();
  const support = join(root, "support");
  const stateDir = join(root, "state");
  await mkdir(stateDir, { mode: 0o700 });
  const identity = installWorkerLauncher(support);
  const bytes = readFileSync(launcherPath(support));
  const log = join(root, "launcher.log");
  closeSync(openSync(log, "a", 0o600));
  const options = { timeoutMs: 30_000, stateDir, purpose: "launch", logPath: log, support };

  // The payload reports its parent: the job's program is the fixed launcher, not the payload.
  const report = 'echo "$0 args=$* parent=$(ps -o command= -p $PPID)"';
  for (const version of ["A", "B"]) {
    const run = await runInUserContext(["/bin/sh", "-c", report, `payload-${version}`, "hello"], { ...options, payloadLength: 4 });
    expect(run.code).toBe(0);
  }
  const lines = readFileSync(log, "utf8").trim().split("\n");
  expect(lines).toHaveLength(2);
  expect(lines[0]).toStartWith("payload-A args=hello parent=");
  expect(lines[1]).toStartWith("payload-B args=hello parent=");
  for (const line of lines) expect(line).toContain(launcherPath(support));
  expect(readFileSync(payloadPointerPath(support), "utf8").split("\n")[3]).toBe("payload-B");

  // The launcher binary and its code identity are untouched by the "upgrade".
  expect(readFileSync(launcherPath(support)).equals(bytes)).toBe(true);
  expect(codesignIdentity(launcherPath(support))).toEqual({ identifier: identity.identifier, cdhash: identity.cdhash });
  await untilTrue(async () => (await ourJobs()).length === 0, "launcher jobs to remove themselves");

  // A detached descendant (the Host owner) keeps the launcher alive as its responsible process, then it removes its job.
  const pidFile = join(root, "child.pid");
  const script = `use POSIX; exit 0 if fork(); POSIX::setsid(); open(F, ">", $ARGV[0]); print F $$; close F; exec "/bin/sleep", "300";`;
  const run = await runInUserContext(["/usr/bin/perl", "-e", script, pidFile], { ...options, payloadLength: 1 });
  expect(run.code).toBe(0);
  let child = 0;
  try {
    await untilTrue(() => { try { child = Number(readFileSync(pidFile, "utf8").trim()); } catch { return false; } return child > 1; }, "the detached child");
    const jobs = await ourJobs();
    expect(jobs).toHaveLength(1);
    const launcherPid = Number(jobs[0]!.split(/\s+/)[0]);
    expect(launcherPid).toBeGreaterThan(1);
    expect(Bun.spawnSync(["ps", "-o", "command=", "-p", String(launcherPid)]).stdout.toString()).toContain(launcherPath(support));
    expect(responsibleFor(child)).toBe(launcherPid);
    process.kill(child, "SIGKILL");
    await untilTrue(async () => (await ourJobs()).length === 0, "the launcher to end its job after the Host exited");
    expect(Bun.spawnSync(["ps", "-p", String(launcherPid)]).exitCode).not.toBe(0);
  } finally { if (child) try { process.kill(child, "SIGKILL"); } catch { /* already gone */ } }
  expect((await readdir(stateDir)).filter(name => name.startsWith(LABEL_PREFIX))).toEqual([]);
}, 120_000);

darwin("the launcher refuses an unsafe pointer or support directory and runs nothing", async () => {
  const root = await privateRoot();
  const support = join(root, "support");
  const stateDir = join(root, "state");
  await mkdir(stateDir, { mode: 0o700 });
  installWorkerLauncher(support);
  const marker = join(root, "ran");
  const pointer = payloadPointerPath(support);
  writePayloadPointer(support, ["/bin/sh", "-c", `touch ${marker}`]);
  // The launcher's own checks decide; it needs no launchd job to run.
  const attempt = () => ({ code: Bun.spawnSync([launcherPath(support), "--", "x"], { stdin: "ignore", stdout: "ignore", stderr: "ignore", timeout: 30_000 }).exitCode });

  expect(attempt().code).toBe(0);
  expect(await Bun.file(marker).exists()).toBe(true);
  await rm(marker);

  chmodSync(pointer, 0o644);
  expect(attempt().code).toBe(78);
  chmodSync(pointer, 0o600);
  chmodSync(support, 0o755);
  expect(attempt().code).toBe(78);
  chmodSync(support, 0o700);
  for (const text of ["relative/bun\n", "/bin/sh\n\n-c\n", ""]) {
    writeFileSync(pointer, text);
    expect(attempt().code).toBe(78);
  }
  await rm(pointer);
  expect(attempt().code).toBe(78);
  expect(await Bun.file(marker).exists()).toBe(false);
  expect(await ourJobs()).toEqual([]);
}, 120_000);

darwin("the real support directory is the account's Library, not the test's", () => {
  expect(supportDirectory()).toBe(join(homedir(), "Library", "Application Support", "omp-superagent-worker"));
});

darwin("one-time setup installs the launcher, probes only through it and records what it could read", async () => {
  const root = await privateRoot();
  const support = join(root, "support");
  const stateDir = join(root, "state");
  await mkdir(stateDir, { mode: 0o700 });
  // A missing external volume is classified as protected but lists without any prompt (no such directory).
  const missing = "/Volumes/omp-sa-no-such-volume/code";
  const report = await setupMacosWorker({ stateDir, workspaceRoots: [root, missing] }, support);
  expect(report.launcher).toMatchObject({ path: launcherPath(support), identifier: "com.omp-superagent.worker-launcher", installed: true });
  expect(report.granted).toEqual([]);
  expect(report.pending).toEqual([expect.objectContaining({ path: missing, category: "removable-or-network" })]);
  expect(report.pending[0]!.instruction).toContain(launcherPath(support));
  expect(readGrants(support)).toMatchObject({ version: 1, folders: [], fullDiskAccess: report.fullDiskAccess, launcher: { cdhash: report.launcher.cdhash } });
  expect(await ourJobs()).toEqual([]);
  expect((await setupMacosWorker({ stateDir, workspaceRoots: [root] }, support)).launcher).toMatchObject({ installed: false, cdhash: report.launcher.cdhash });
  expect(() => requireMacosWorkerReady({ stateDir, workspaceRoots: [root] }, support)).not.toThrow();
}, 60_000);

darwin("preparing a worker builds the launcher, points it at the release and keeps its grants, without a prompt or a launchd job", async () => {
  const root = await privateRoot();
  const support = join(root, "support");
  const scope = { stateDir: join(root, "state"), workspaceRoots: [root, "/Volumes/omp-sa-no-such-volume/code"] };
  const first = prepareMacosWorker(scope, support);
  expect(first).toMatchObject({ pointerChanged: true, fullDiskAccess: false, granted: [], launcher: { installed: true, path: launcherPath(support) } });
  expect(first.pending).toEqual([expect.objectContaining({ path: "/Volumes/omp-sa-no-such-volume/code", category: "removable-or-network" })]);
  expect(first.pending[0]!.instruction).toContain(launcherPath(support));
  expect(first.pending[0]!.instruction).toContain(first.setup);
  expect(parsePayloadPointer(readFileSync(payloadPointerPath(support), "utf8"))).toEqual([process.execPath, "--no-env-file", resolve(import.meta.dir, "../src/remote-worker-server.ts")]);
  expect(readGrants(support)).toMatchObject({ folders: [], launcher: { cdhash: first.launcher.cdhash } });
  expect(() => requireMacosWorkerReady(scope, support)).toThrow("removable-or-network");

  // The owner's recorded grants belong to the launcher's identity and survive a re-run, which changes nothing.
  writeGrants(support, { ...readGrants(support)!, folders: ["removable-or-network"] });
  const second = prepareMacosWorker(scope, support);
  expect(second).toMatchObject({ pointerChanged: false, granted: ["removable-or-network"], pending: [], launcher: { installed: false, cdhash: first.launcher.cdhash } });
  expect(() => requireMacosWorkerReady(scope, support)).not.toThrow();

  // Grants recorded for another binary are discarded, never trusted.
  writeGrants(support, { ...readGrants(support)!, launcher: { identifier: "x", cdhash: "0".repeat(40) } });
  expect(prepareMacosWorker(scope, support)).toMatchObject({ granted: [], pending: [expect.anything()] });
  expect(await ourJobs()).toEqual([]);
}, 60_000);

darwin("the prepare script runs the installed release over plain sh and reports one JSON line", async () => {
  const root = await privateRoot();
  const home = join(root, "home");
  const releases = join(home, ".local/share/omp-superagent-worker/releases");
  await mkdir(releases, { recursive: true, mode: 0o700 });
  await symlink(resolve(import.meta.dir, ".."), join(releases, "rel1"));
  const scope = JSON.stringify({ stateDir: join(home, "st"), workspaceRoots: [join(home, "projects"), "/Volumes/omp-sa-no-such-volume/code"] });
  const run = (release: string) => {
    const nonce = newNonce();
    const child = Bun.spawnSync(["sh", "-s"], {
      stdin: Buffer.from(macosPrepareScript({ nonce, bun: process.execPath, release, scope })),
      env: { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, stdout: "pipe", stderr: "pipe", timeout: 120_000,
    });
    return { facts: parseFacts(child.stdout.toString("utf8"), nonce), code: child.exitCode };
  };
  const first = run("rel1");
  expect(first.facts.error).toBeUndefined();
  const report = JSON.parse(first.facts.prepare!);
  expect(report).toMatchObject({ pointerChanged: true, launcher: { installed: true }, pending: [{ category: "removable-or-network" }] });
  expect((await stat(join(home, "Library/Application Support/omp-superagent-worker"))).mode & 0o777).toBe(0o700);
  expect(JSON.parse(run("rel1").facts.prepare!)).toMatchObject({ pointerChanged: false, launcher: { installed: false, cdhash: report.launcher.cdhash } });
  expect(run("missing").facts.error).toContain("release is not installed");
  expect(await ourJobs()).toEqual([]);
}, 180_000);

const sshdTest = test.skipIf(process.platform !== "darwin" || !existsSync(USER_SSHD_BINARY));

/** The worker's own sshd, bootstrapped for real on loopback with a throwaway home and a unique launchd label. */
sshdTest("the user sshd is created, left alone when matching, restarted on a changed config and booted out cleanly", async () => {
  const root = await privateRoot();
  const home = join(root, "home");
  await mkdir(home, { recursive: true, mode: 0o700 });
  const label = `com.omp-superagent.sshd-test-${crypto.randomUUID().slice(0, 8)}`;
  const domain = `gui/${process.getuid!()}`;
  const gui = Bun.spawnSync(["launchctl", "print", domain], { stdout: "ignore", stderr: "ignore" });
  if (gui.exitCode !== 0) return; // No GUI login session to bootstrap into (a headless runner).
  cleanups.push(async () => { Bun.spawnSync(["launchctl", "bootout", `${domain}/${label}`], { stdout: "ignore", stderr: "ignore" }); });
  const freePort = (): number => { const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } }); const port = probe.port; probe.stop(true); return port; };
  const desired = (port: number): UserSshdDesired => ({ home, user: userInfo().username, listen: [listenAddress("127.0.0.1", port)], label });
  const env = { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
  const script = (source: string) => {
    const child = Bun.spawnSync(["sh", "-s"], { stdin: Buffer.from(source), env, stdout: "pipe", stderr: "pipe", timeout: 120_000 });
    return parseFacts(child.stdout.toString("utf8"), nonce);
  };
  let nonce = "";
  const inspect = () => {
    nonce = newNonce();
    const facts = script(userSshdInspectScript({ nonce, label }));
    return { sshd_binary: facts.sshd_binary, state: { config: facts.sshd_config ? Buffer.from(facts.sshd_config, "base64").toString() : null,
      plist: facts.sshd_plist ? Buffer.from(facts.sshd_plist, "base64").toString() : null, hostKey: facts.host_key || null,
      launchd: facts.launchd === "absent" ? null : facts.launchd! } };
  };
  const apply = (want: UserSshdDesired, port: number) => {
    const plan = planUserSshd(inspect().state, want);
    nonce = newNonce();
    return { plan, facts: script(userSshdApplyScript({ nonce, label, config: userSshdConfig(want), plist: userSshdPlist(want), port, action: plan.launchd })) };
  };
  const banner = async (port: number) => {
    const { promise, resolve: done } = Promise.withResolvers<string>();
    const socket = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data(_socket, data) { done(Buffer.from(data).toString()); }, error(_socket, error) { done(String(error)); } } });
    const text = await promise;
    socket.end();
    return text;
  };

  const first = freePort();
  expect(inspect()).toMatchObject({ sshd_binary: "yes", state: { config: null, plist: null, hostKey: null, launchd: null } });
  const created = apply(desired(first), first);
  expect(created.plan).toEqual({ config: "create", plist: "create", hostKey: "create", launchd: "bootstrap" });
  expect(created.facts).toMatchObject({ host_key_state: "created", sshd_config: "written", sshd_plist: "written", launchd: "running" });
  expect(created.facts.listening).toContain(`127.0.0.1 port ${first}`);
  expect((await stat(userSshdDirectory(home))).mode & 0o777).toBe(0o700);
  expect((await stat(join(userSshdDirectory(home), "sshd_config"))).mode & 0o777).toBe(0o600);
  expect(await banner(first)).toStartWith("SSH-2.0-OpenSSH");
  expect(userSshdFacts(home, process.getuid!(), label)).toMatchObject({ state: "running", listening: [`127.0.0.1:${first}`] });

  const again = apply(desired(first), first);
  expect(again.plan).toEqual({ config: "unchanged", plist: "unchanged", hostKey: "keep", launchd: "none" });
  expect(again.facts).toMatchObject({ host_key_state: "kept", sshd_config: "unchanged", sshd_plist: "unchanged", launchd_action: "none" });
  expect((await readdir(userSshdDirectory(home))).filter(name => name.includes(".bak-"))).toEqual([]);

  const second = freePort();
  const moved = apply(desired(second), second);
  expect(moved.plan).toEqual({ config: "update", plist: "unchanged", hostKey: "keep", launchd: "kickstart" });
  expect(moved.facts.listening).toContain(`127.0.0.1 port ${second}`);
  expect((await readdir(userSshdDirectory(home))).filter(name => name.startsWith("sshd_config.bak-"))).toHaveLength(1);
  expect(await banner(second)).toStartWith("SSH-2.0-OpenSSH");

  const bad = freePort();
  nonce = newNonce();
  const rejected = script(userSshdApplyScript({ nonce, label, config: "ListenAddress 127.0.0.1:1\nNoSuchDirective yes\n", plist: userSshdPlist(desired(bad)), port: bad, action: "none" }));
  expect(rejected.error).toContain("sshd rejected the configuration");
  expect(readFileSync(join(userSshdDirectory(home), "sshd_config"), "utf8")).toBe(userSshdConfig(desired(second)));

  Bun.spawnSync(["launchctl", "bootout", `${domain}/${label}`], { stdout: "ignore", stderr: "ignore" });
  expect(inspect().state.launchd).toBeNull();
}, 180_000);
