import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { workerLaunchProfile } from "../src/worker-profile";
import { serveWorker } from "../src/worker-service";
import { workerRepositoryIdentity } from "../src/worker-repository";
import { remoteLanePaths, type WorkerLaneRef, type WorkerPolicy } from "../src/worker-wire";

async function fixture(startupFile?: string) {
  const root = mkdtempSync(join(realpathSync("/tmp"), "ow-"));
  try {
    const cwd = join(root, "checkout");
    const stateDir = join(root, "state");
    mkdirSync(cwd, { mode: 0o700 });
    mkdirSync(stateDir, { mode: 0o700 });
    const git = (...args: string[]) => execFileSync("/usr/bin/git", ["-C", cwd, ...args], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin", HOME: root, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    }).trim();
    git("init");
    git("remote", "add", "origin", "https://example.invalid/example/worker.git");
    mkdirSync(join(cwd, "src"));
    writeFileSync(join(cwd, "src", "entry.txt"), "pinned\n");
    if (startupFile) {
      const path = join(cwd, startupFile);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "");
    }
    git("add", "--all");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Fixture");
    const repoId = await workerRepositoryIdentity(cwd);
    if (!repoId) throw new Error("Fixture Git identity is missing");
    const policy: WorkerPolicy = { stateDir, workerId: "head-one", capacity: 1, command: ["/usr/bin/false"], repos: [{ cwd, id: repoId }] };
    const ref: WorkerLaneRef = { laneId: "lane-service-test", repoId, revision: git("rev-parse", "HEAD"), subdir: "src", generation: 1 };
    return { root, cwd, policy, ref };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

async function request(policy: WorkerPolicy, payload: object): Promise<unknown> {
  const chunks: Buffer[] = [];
  const input = Readable.from(Buffer.from(`${JSON.stringify({ version: 1, ...payload })}\n`));
  const output = new Writable({ write(chunk: Buffer, _encoding, callback) { chunks.push(chunk); callback(); } });
  await serveWorker(policy, input, output);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

test("scoped describe verifies the pinned directory without allocating worker state", async () => {
  const { root, cwd, policy, ref: { repoId, revision, subdir } } = await fixture();
  try {
    expect(await request(policy, { op: "describe", workspace: { repoId, revision, subdir } }))
      .toMatchObject({ ok: true, value: { workerId: policy.workerId, active: 0 } });
    symlinkSync(join(cwd, "src"), join(cwd, "alias"));
    expect(await request(policy, { op: "describe", workspace: { repoId, revision, subdir: "alias" } }))
      .toMatchObject({ ok: false, error: expect.stringContaining("canonical directory") });
    expect(existsSync(join(policy.stateDir, "worker.sqlite"))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("worker wire refuses injected launch arguments, traversal and a different enrollment before touching storage", async () => {
  const { root, policy, ref } = await fixture();
  try {
    const open = { op: "open", workerId: policy.workerId, ref, launch: { subagentConcurrency: 1 } };
    for (const payload of [
      { ...open, launch: { ...open.launch, command: ["/usr/bin/false"] } },
      { ...open, ref: { ...ref, subdir: "../elsewhere" } },
      { ...open, ref: { ...ref, laneId: `${ref.laneId}\n` } },
      { ...open, workerId: "head-two" },
    ]) {
      expect(await request(policy, payload)).toMatchObject({ ok: false });
    }
    expect(existsSync(join(policy.stateDir, "worker.sqlite"))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a dirty checkout refuses open, releases its unused slot and never reopens that generation", async () => {
  const { root, cwd, policy, ref } = await fixture();
  try {
    writeFileSync(join(cwd, "src", "entry.txt"), "unsent edits\n");
    const open = { op: "open", workerId: policy.workerId, ref, launch: { subagentConcurrency: 1 } };
    expect(await request(policy, open)).toMatchObject({ ok: false, error: expect.stringContaining("must be clean") });
    expect(await request(policy, { op: "describe" })).toMatchObject({ ok: true, value: { active: 0 } });
    expect(await request(policy, { op: "probe", workerId: policy.workerId, ref: { ...ref, generation: 2 } }))
      .toMatchObject({ ok: true, value: { socket: false, sessionFile: false, pidAlive: false, ownerAlive: false, uncertain: false } });
    expect(await request(policy, open)).toMatchObject({ ok: false, error: expect.stringContaining("cannot reopen") });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test.each([
  [".omp/config.yml", ".omp"],
  [".env.local", ".env.local"],
  [".mcp.json", ".mcp.json"],
  [".claude/settings.local.json", ".claude"],
  ["src/bunfig.toml", "bunfig.toml"],
])("worker open refuses startup input %s at its selected directory or repository ancestor", async (file, name) => {
  const { root, policy, ref } = await fixture(file);
  try {
    const open = { op: "open", workerId: policy.workerId, ref, launch: { subagentConcurrency: 1 } };
    expect(await request(policy, open)).toMatchObject({ ok: false, error: expect.stringContaining(`(${name})`) });
    expect(existsSync(remoteLanePaths(policy, ref.laneId).sessionFile)).toBe(false);
    expect(await request(policy, { op: "describe" })).toMatchObject({ ok: true, value: { active: 0 } });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the worker child retains the target model profile but discards ambient code and credential inputs", async () => {
  const { root, cwd, policy } = await fixture();
  try {
    const agent = join(root, "profile");
    mkdirSync(agent, { mode: 0o700 });
    const approved = join(agent, "approved-provider.ts");
    writeFileSync(approved, "export {};\n", { mode: 0o600 });
    writeFileSync(join(agent, "worker-extensions.json"), JSON.stringify([approved]), { mode: 0o600 });
    const { env, profile } = workerLaunchProfile(policy, cwd, { HOME: root, PATH: `.:${cwd}:/usr/bin`,
      PI_CODING_AGENT_DIR: agent, OPENAI_API_KEY: "fixture-only", SSH_AUTH_SOCK: "/tmp/ssh-agent",
      DISCORD_BOT_TOKEN: "fixture", CUSTOM_TOKEN_NAME: "fixture", PI_CONFIG_FILES: "/tmp/other-profile",
      BUN_OPTIONS: "--preload fixture", OMP_SUPERAGENT_TEST_MANAGED_ULW_PATH: cwd });
    expect(env).toMatchObject({ HOME: root, PI_CODING_AGENT_DIR: agent, OPENAI_API_KEY: "fixture-only" });
    expect(env.PATH?.split(":")).not.toContain(cwd);
    expect(env.PATH?.split(":")).not.toContain(".");
    for (const name of ["SSH_AUTH_SOCK", "DISCORD_BOT_TOKEN", "CUSTOM_TOKEN_NAME", "PI_CONFIG_FILES",
      "BUN_OPTIONS", "OMP_SUPERAGENT_TEST_MANAGED_ULW_PATH"]) expect(env).not.toHaveProperty(name);
    expect(profile.extensionPaths).toEqual([approved]);

    const rejected = join(agent, "checkout-module.ts");
    const source = join(cwd, "candidate.ts");
    writeFileSync(source, "export {};\n");
    symlinkSync(source, rejected);
    writeFileSync(join(agent, "worker-extensions.json"), JSON.stringify([rejected]), { mode: 0o600 });
    expect(() => workerLaunchProfile(policy, cwd, { HOME: root, PI_CODING_AGENT_DIR: agent })).toThrow(/owned canonical path/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("worker open refuses executable Git configuration before stock CLI startup", async () => {
  const { root, cwd, policy, ref } = await fixture();
  try {
    execFileSync("/usr/bin/git", ["-C", cwd, "config", "--local", "filter.unapproved.clean", "fixture-value"],
      { env: { PATH: "/usr/bin:/bin", HOME: root, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
    const open = { op: "open", workerId: policy.workerId, ref, launch: { subagentConcurrency: 1 } };
    expect(await request(policy, open)).toMatchObject({ ok: false, error: expect.stringContaining("nonstandard local Git configuration") });
    expect(existsSync(remoteLanePaths(policy, ref.laneId).sessionFile)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the worker profile refuses model credentials that need a command run from the checkout", async () => {
  const { root, cwd, policy } = await fixture();
  try {
    const agent = join(root, "profile");
    mkdirSync(agent, { mode: 0o700 });
    writeFileSync(join(agent, "models.yaml"), "providers:\n  fixture:\n    apiKey: '!fixture-value'\n", { mode: 0o600 });
    expect(() => workerLaunchProfile(policy, cwd, { HOME: root, PI_CODING_AGENT_DIR: agent }))
      .toThrow(/command-backed settings or model credentials/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a journal file not bound by a worker receipt cannot be opened or attached", async () => {
  const { root, policy, ref } = await fixture();
  try {
    const { sessionFile } = remoteLanePaths(policy, ref.laneId);
    mkdirSync(dirname(sessionFile), { recursive: true, mode: 0o700 });
    writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: "unrelated" })}\n`, { mode: 0o600 });
    const bound = { workerId: policy.workerId, ref };
    expect(await request(policy, { ...bound, op: "probe", ref: { ...ref, generation: 0 } }))
      .toMatchObject({ ok: true, value: { sessionFile: true, sessionId: null, uncertain: true } });
    expect(await request(policy, { ...bound, op: "open", launch: { subagentConcurrency: 1 } }))
      .toMatchObject({ ok: false, error: expect.stringContaining("unverified socket or journal") });
    expect(await request(policy, { ...bound, op: "attach" })).toMatchObject({ ok: false });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
