import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";

// Both native execution and this exact external package are explicit opt-ins.
// Never silently substitute a mock ULW extension or a developer checkout path.
const nativeUlwTest = process.env.OMP_SUPERAGENT_NATIVE_TEST === "1" && process.env.OMP_TEST_ULW_EXTENSION ? test : test.skip;

async function within<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  // Deadline only: fake timers cannot reap an independently running native OMP.
  const expired = Promise.withResolvers<never>();
  const timer = setTimeout(() => expired.reject(new Error(label)), ms);
  try { return await Promise.race([work, expired.promise]); }
  finally { clearTimeout(timer); }
}

nativeUlwTest("actual shared ULW activates native Gateway head and explicitly selected lane workflows without granting data authority", async () => {
  const root = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "osu-"));
  await fs.chmod(root, 0o700);
  let succeeded = false;
  let terminate: (() => Promise<void>) | undefined;
  try {
    const entrypoint = await fs.realpath(path.resolve(process.env.OMP_TEST_ULW_EXTENSION!));
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
        OMP_TEST_COMMAND: process.env.OMP_TEST_COMMAND ?? "", OMP_TEST_ULW_EXTENSION: entrypoint,
        ...(process.env.OMP_TEST_NATIVES_DIR ? { PI_NATIVES_DIR: process.env.OMP_TEST_NATIVES_DIR } : {}),
      },
      stdout: "pipe", stderr: "pipe",
    });
    terminate = async () => {
      if (child.exitCode !== null) { await child.exited; return; }
      child.kill("SIGTERM");
      try { await within(child.exited, 75_000, "Native ULW fixture owned-process cleanup timed out"); }
      catch {
        child.kill("SIGKILL");
        await within(child.exited, 5_000, "Owned native ULW fixture did not exit after SIGKILL");
      }
    };
    const [stdout, stderr, code] = await within(Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]), 180_000, `Native ULW proof exceeded deadline; diagnostics retained: ${root}`);
    expect({ code, diagnostics: code === 0 ? "" : `${stdout}${stderr}\nRetained native ULW proof: ${root}` }).toEqual({ code: 0, diagnostics: "" });
    expect(stdout).toContain("NATIVE_ULW_GATEWAY_PROOF ");
    succeeded = true;
  } finally {
    await terminate?.();
    if (succeeded) await fs.rm(root, { recursive: true, force: true });
  }
}, 270_000);
