import { test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const ulwPath = process.env.OMP_TEST_ULW_EXTENSION ? path.resolve(process.env.OMP_TEST_ULW_EXTENSION) : undefined;
// Each composition run already verifies the default tool selection. Keep the
// standalone run for explicit exclusions and native prompts without Superkit.
const defaultOrders = ulwPath ? ["ulw-first", "superagent-first"] as const : ["standalone"] as const;
const cases = (["head", "lane"] as const).flatMap(role => (["main", "sub"] as const).flatMap(kind => [
  [role, kind, "narrow", "standalone"] as const,
  ...defaultOrders.map(order => [role, kind, "default", order] as const),
]));

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
    // The fixture asserts on native state directly. The marker distinguishes
    // completing those checks from an extension exiting the process early.
    const completed = stdout.split("\n").includes("NATIVE_SKILLS_PROOF");
    if (code !== 0 || stderr || !completed)
      throw new Error(`Native skills fixture ${role}/${kind}/${selection}/${order} exited ${code} (completed: ${completed})\n${stderr}\n${stdout}`);
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
    await fs.rm(root, { recursive: true, force: true });
  }
}, 50_000);
