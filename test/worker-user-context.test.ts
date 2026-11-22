import { afterEach, expect, test } from "bun:test";
import { closeSync, openSync } from "node:fs";
import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { loginEnvironment } from "../src/remote-worker-provision";
import { launchAgentPlist, LABEL_PREFIX, parseLaunchctlPrint, requireUserContext, runInUserContext } from "../src/worker-user-context";

const darwin = test.skipIf(process.platform !== "darwin");

const exited = `gui/501/com.omp-superagent.worker.exp.abc123 = {
\tactive count = 0
\tpath = /private/tmp/lx/com.omp-superagent.worker.exp.abc123.plist
\ttype = LaunchAgent
\tstate = not running

\tprogram = /bin/sh
\trequired = x
\truns = 1
\tlast exit code = 3

\tresource coalition = {
\t\tID = 7149
\t\tstate = active
\t}
\tproperties = runatload | abandon process group | inferred program
}`;

test("launchctl print parsing reads the job's own fields, not its coalition's", () => {
  expect(parseLaunchctlPrint(exited)).toEqual({ state: "not running", runs: 1, pid: null, lastExitCode: 3 });
  expect(parseLaunchctlPrint("\tstate = running\n\truns = 2\n\tpid = 4242\n\tlast exit code = (never exited)\n"))
    .toEqual({ state: "running", runs: 2, pid: 4242, lastExitCode: null });
  expect(parseLaunchctlPrint("")).toEqual({ state: null, runs: 0, pid: null, lastExitCode: null });
});

test("the LaunchAgent plist is a one-shot, group-abandoning job with escaped arguments", () => {
  const plist = launchAgentPlist({
    label: `${LABEL_PREFIX}launch.0011`, argv: ["/bin/sh", "-c", "echo '<a&b>'"], stdoutPath: "/tmp/out", stderrPath: "/dev/null",
    env: { HOME: "/h&m" },
  });
  expect(plist).toContain(`<key>Label</key><string>${LABEL_PREFIX}launch.0011</string>`);
  expect(plist).toContain("<array><string>/bin/sh</string><string>-c</string><string>echo '&lt;a&amp;b&gt;'</string></array>");
  expect(plist).toContain("<key>RunAtLoad</key><true/>");
  expect(plist).toContain("<key>KeepAlive</key><false/>");
  expect(plist).toContain("<key>AbandonProcessGroup</key><true/>");
  expect(plist).toContain("<key>StandardOutPath</key><string>/tmp/out</string>");
  expect(plist).toContain("<key>EnvironmentVariables</key><dict><key>HOME</key><string>/h&amp;m</string></dict>");
  expect(launchAgentPlist({ label: "x", argv: ["/bin/true"], stdoutPath: "/a", stderrPath: "/b" })).not.toContain("EnvironmentVariables");
});

test("the user context is dispatched by platform and other platforms are refused", async () => {
  for (const platform of ["win32", "freebsd"]) {
    expect(() => requireUserContext(platform)).toThrow(`${platform} workers are not supported`);
    expect(() => runInUserContext(["/bin/true"], { timeoutMs: 1_000, stateDir: "/tmp", purpose: "x" }, platform)).toThrow(`do not support ${platform}`);
  }
});

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
}, { timeout: 30_000 });

async function privateRoot(): Promise<string> {
  const root = await mkdtemp(join(await realpath("/tmp"), "wuc-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function ourJobs(): Promise<string[]> {
  const child = Bun.spawnSync(["launchctl", "list"], { stdout: "pipe" });
  return child.stdout.toString("utf8").split("\n").filter(line => line.includes(LABEL_PREFIX));
}

darwin("a LaunchAgent job runs in the gui domain with the login environment and leaves no job or plist", async () => {
  const root = await privateRoot();
  expect(() => requireUserContext()).not.toThrow();
  const env = await loginEnvironment(root);
  expect(env.HOME).toBe(userInfo().homedir);
  expect(env.PATH).toContain("/usr/bin");
  expect(env.PATH).not.toBe("/usr/bin:/bin:/usr/sbin:/sbin"); // not launchd's bare default: the login shell added the user's entries
  expect(Object.keys(env).filter(name => ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"].includes(name))).toEqual([]);
  expect(await readdir(root)).toEqual([]);
  expect(await ourJobs()).toEqual([]);

  const run = await runInUserContext(["/bin/sh", "-c", "echo $PROBE; exit 7"], { timeoutMs: 20_000, stateDir: root, purpose: "probe", capture: true, env: { PROBE: "forwarded" } });
  expect(run.code).toBe(7);
  expect(run.stdout.toString()).toBe("forwarded\n");
  expect(await readdir(root)).toEqual([]);
}, 60_000);

darwin("a job that outlives its deadline is stopped and removed", async () => {
  const root = await privateRoot();
  const run = await runInUserContext(["/bin/sleep", "60"], { timeoutMs: 1_000, stateDir: root, purpose: "slow" });
  expect(run.code).toBeNull();
  expect(await readdir(root)).toEqual([]);
  expect(await ourJobs()).toEqual([]);
}, 30_000);

darwin("a detached Host started inside a job survives the job's removal in the gui domain", async () => {
  const root = await privateRoot();
  const pidFile = join(root, "child.pid");
  // The parent exits at once (the job ends); the child setsid()s like the Host owner does and keeps running.
  const script = `use POSIX; exit 0 if fork(); POSIX::setsid(); open(F, ">", $ARGV[0]); print F $$; close F; exec "/bin/sleep", "300";`;
  const log = join(root, "launcher.log");
  closeSync(openSync(log, "a", 0o600));
  const run = await runInUserContext(["/usr/bin/perl", "-e", script, pidFile], { timeoutMs: 20_000, stateDir: root, purpose: "survivor", logPath: log });
  expect(run.code).toBe(0);
  let pid = 0;
  try {
    const deadline = Date.now() + 10_000;
    while (!pid && Date.now() < deadline) {
      try { pid = Number((await readFile(pidFile, "utf8")).trim()); } catch { await Bun.sleep(50); }
    }
    expect(pid).toBeGreaterThan(1);
    expect(await ourJobs()).toEqual([]);
    expect((await readdir(root)).filter(name => name.endsWith(".plist"))).toEqual([]);
    expect(() => process.kill(pid, 0)).not.toThrow();
    const parent = Bun.spawnSync(["ps", "-o", "ppid=", "-p", String(pid)]).stdout.toString().trim();
    expect(parent).toBe("1");
    expect(Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)]).stdout.toString()).toContain("sleep 300");
  } finally { if (pid) try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
}, 60_000);
