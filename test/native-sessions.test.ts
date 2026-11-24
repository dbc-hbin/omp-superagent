import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";

test("native session discovery reuses the existing journal, artifacts, picker, ID lookup and writable resume", async () => {
  const root = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "sas-"));
  try {
    const child = Bun.spawn([process.execPath, "--no-env-file", path.join(import.meta.dir, "fixtures/native-session-discovery.ts"), root], {
      env: { ...process.env, HOME: path.join(root, "home"), USERPROFILE: path.join(root, "home"),
        PI_CODING_AGENT_DIR: path.join(root, "agent"), OMP_PROFILE: "", PI_PROFILE: "",
        XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"),
        XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state") },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(stdout.trim()).toBe("NATIVE_SESSION_DISCOVERY_PROOF");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}, 30_000);
