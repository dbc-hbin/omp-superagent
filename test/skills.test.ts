import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const scenarios = [
  ["head", "main", "default"], ["head", "main", "narrow"],
  ["head", "sub", "default"], ["head", "sub", "narrow"],
  ["lane", "main", "default"], ["lane", "sub", "narrow"],
] as const;
// Ordinary tests need no external extension checkout. The parent explicitly
// supplies a local read-only entrypoint when proving real ULW composition.
const ulwPath = process.env.OMP_TEST_ULW_EXTENSION ? path.resolve(process.env.OMP_TEST_ULW_EXTENSION) : undefined;
const compositionScenarios = ulwPath ? (["ulw-first", "superagent-first"] as const).flatMap(order =>
  (["head", "lane"] as const).flatMap(role => (["main", "sub"] as const).map(kind =>
    [role, kind, "default", order] as const))) : [];
const cases = [...scenarios.map(([role, kind, selection]) => [role, kind, selection, "standalone"] as const), ...compositionScenarios];

test.each(cases)("native packaged skills, scoped tools, and preserved selections: %s/%s/%s/%s", async (role, kind, selection, order) => {
  const root = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "oss-"));
  const home = path.join(root, "home");
  const agent = path.join(root, "agent");
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(agent, { recursive: true });
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures/skills.ts"), root, role, kind, selection,
    ...(order === "standalone" ? [] : [ulwPath!, order])], {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, USERPROFILE: home,
      PI_CODING_AGENT_DIR: agent, PI_NO_TITLE: "1", CI: "true", NO_COLOR: "1",
      XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"),
      XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state"),
      TMPDIR: root, TMP: root, TEMP: root,
      ...(process.env.OMP_TEST_NATIVES_DIR ? { PI_NATIVES_DIR: process.env.OMP_TEST_NATIVES_DIR } : {}),
    },
    stdout: "pipe", stderr: "pipe",
  });
  // Only an external-process deadline: fake time cannot terminate a hung OMP
  // subprocess. Readiness/completion below await its actual exit, never a sleep.
  const timeout = setTimeout(() => child.kill("SIGKILL"), 45_000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0 || stderr) throw new Error(`Native skills fixture ${role}/${kind}/${selection}/${order} exited ${code}\n${stderr}\n${stdout}`);
    const line = stdout.split("\n").find(line => line.startsWith("NATIVE_SKILLS_PROOF "));
    expect(line).toBeDefined();
    const proof = JSON.parse(line!.slice("NATIVE_SKILLS_PROOF ".length)) as {
      role: string; kind: string; reads: string[]; schemas: Record<string, unknown>;
      active: string[]; discovered: string[]; networkAttempts: number;
      composition: boolean; extensionOrder?: string; turns: number;
    };
    expect(proof.role).toBe(role);
    expect(proof.kind).toBe(kind);
    expect(proof.composition).toBe(order !== "standalone");
    expect(proof.extensionOrder).toBe(order === "standalone" ? undefined : order);
    expect(proof.turns).toBe(2);
    expect(proof.reads).toHaveLength(6);
    expect(proof.discovered).toContain("project-existing");
    expect(proof.discovered).toContain("user-existing");
    expect(proof.discovered).toContain("custom-existing");
    expect(proof.active).toContain("read");
    expect(proof.active).toContain("task");
    expect(proof.networkAttempts).toBe(0);
    if (selection === "narrow") expect(proof.active).not.toContain("bash");
    else expect(proof.active).toContain("bash");
    if (role === "lane") expect(proof.schemas).toEqual({});
    else {
      expect(Object.keys(proof.schemas).sort()).toEqual(["lane_close", "lane_init_presets", "lane_inspect", "lane_message", "lane_models", "lane_pause", "lane_resume", "lane_set_model", "lane_start"]);
      if (kind === "sub") expect(proof.active.some(name => name.startsWith("lane_"))).toBe(false);
      else if (selection === "narrow") expect(proof.active).not.toContain("lane_message");
      else expect(proof.active).toContain("lane_message");
    }
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
    await fs.rm(root, { recursive: true, force: true });
  }
}, 50_000);
