import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const nativeTest = process.env.OMP_SUPERAGENT_NATIVE_TEST === "1" ? test : test.skip;

async function within<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  // External-process failure bounds, not synchronization sleeps; fake timers
  // cannot advance a separate native OMP process or reap its real PID.
  const expired = Promise.withResolvers<never>();
  const timer = setTimeout(() => expired.reject(new Error(label)), ms);
  try { return await Promise.race([work, expired.promise]); }
  finally { clearTimeout(timer); }
}

nativeTest("production Gateway durably receives during native head recovery and real head tools exclusively control lane delivery", async () => {
  // Native imports and subprocesses begin only after HOME/settings isolation.
  const root = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "osg-"));
  await fs.chmod(root, 0o700);
  let succeeded = false;
  let terminate: (() => Promise<void>) | undefined;
  try {
    const home = path.join(root, "home");
    await fs.mkdir(home, { mode: 0o700 });
    const child = Bun.spawn({
      cmd: [process.execPath, path.resolve(import.meta.dir, "fixtures/native-gateway.ts")],
      cwd: root,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, USERPROFILE: home,
        PI_CODING_AGENT_DIR: path.join(root, "agent"), PI_NO_TITLE: "1", CI: "true", NO_COLOR: "1",
        XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"),
        XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state"),
        CODEX_HOME: path.join(root, "codex"), CLAUDE_CONFIG_DIR: path.join(root, "claude"), COPILOT_HOME: path.join(root, "copilot"),
        TMPDIR: root, TMP: root, TEMP: root, OMP_NATIVE_GATEWAY_ROOT: root,
        OMP_TEST_COMMAND: process.env.OMP_TEST_COMMAND ?? "",
        ...(process.env.OMP_TEST_NATIVES_DIR ? { PI_NATIVES_DIR: process.env.OMP_TEST_NATIVES_DIR } : {}),
      },
      stdout: "pipe", stderr: "pipe",
    });
    terminate = async () => {
      if (child.exitCode !== null) { await child.exited; return; }
      child.kill("SIGTERM"); // The owned fixture closes its Gateway and exact recorded hosts.
      try { await within(child.exited, 75_000, "Native Gateway fixture signal cleanup timed out"); }
      catch {
        child.kill("SIGKILL"); // Only this exact spawned fixture, never a process-name match.
        await within(child.exited, 5_000, "Owned native Gateway fixture did not exit after SIGKILL");
      }
    };
    const [stdout, stderr, code] = await within(Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]), 180_000, `Native Gateway proof exceeded its owned-process deadline; retained diagnostics: ${root}`);
    expect({ code, diagnostics: code === 0 ? "" : `${stdout}${stderr}\nRetained native Gateway proof: ${root}` }).toEqual({ code: 0, diagnostics: "" });
    succeeded = true;
  } finally {
    await terminate?.();
    if (succeeded) await fs.rm(root, { recursive: true, force: true });
  }
}, 270_000);
