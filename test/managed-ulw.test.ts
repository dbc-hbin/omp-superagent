import { afterEach, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { activeManagedUlw, managedUlwLaunchExtensions, managedUlwStatus, updateManagedUlw, type UlwManifest } from "../src/managed-ulw";
import { connect, startHost, type HostOptions } from "../src/host";
import { getExtensionNameFromPath } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { stopHostFixtures } from "./fixtures/host-fixture-processes";
import { writeStockHostExecutable } from "./fixtures/stock-host";
import { offlineMnemopi } from "./fixtures/native-memory";

const cleanups: Array<() => Promise<void>> = [];
// Production revisions are deliberately not pruned. Tests own their entire temp
// root, and must restore write permission solely to remove those isolated files.
async function writable(path: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      await chmod(path, 0o700);
      for (const entry of await readdir(path)) await writable(join(path, entry));
    } else await chmod(path, 0o600);
  } catch (error) {
    // startHost may still be removing its private .launch-* directory after exit.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); }, { timeout: 45_000 });

async function command(args: string[], cwd: string): Promise<string> {
  const child = Bun.spawn(args, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (exit) throw new Error(`${args[0]} failed: ${stderr}`);
  return stdout.trim();
}
async function promptExtension(revision: string, defect = "none"): Promise<string> {
  const source = await readFile(join(import.meta.dir, "fixtures/managed-ulw-prompt-extension.ts"), "utf8");
  return source.replace('const defect: string = "none";', `const defect: string = ${JSON.stringify(defect)};`)
    + `\nexport const revision = ${JSON.stringify(revision)};\n`;
}
async function fixture(packageName = "omp-ulw") {
  const root = await mkdtemp(join(await realpath("/tmp"), "omu-"));
  const starting: ReturnType<typeof startHost>[] = [];
  let closing = false;
  cleanups.push(async () => {
    closing = true;
    if (starting.length) {
      // A rejected or interrupted start may already have spawned both processes.
      const outcomes = await Promise.allSettled(starting);
      const started = outcomes.filter(outcome => outcome.status === "fulfilled").length;
      const exited = await stopHostFixtures(root);
      if (exited < started) throw new Error(`Expected ${started} Host fixture receipts, found ${exited}; retained ${root}`);
    }
    await writable(root);
    await rm(root, { recursive: true, force: true });
  });
  const startFixtureHost = (options: HostOptions) => {
    if (closing) throw new Error(`Host fixture teardown has started: ${root}`);
    const launch = startHost(options);
    starting.push(launch);
    return launch;
  };
  const remote = join(root, "remote");
  const managed = join(root, "managed");
  await mkdir(remote);
  await command(["git", "init", "--initial-branch=main"], remote);
  await command(["git", "config", "user.email", "fixture@example.invalid"], remote);
  await command(["git", "config", "user.name", "Managed ULW fixture"], remote);
  await mkdir(join(remote, "skills/fixture"), { recursive: true });
  await writeFile(join(remote, "skills/fixture/SKILL.md"), "---\nname: ulw-local-fixture\ndescription: Local git install fixture.\n---\nRead only fixture.\n");
  await writeFile(join(remote, "resource.txt"), "resource-v1");
  await writeFile(join(remote, "package.json"), JSON.stringify({ name: packageName, version: "0.0.0-fixture", type: "module",
    omp: { extensions: ["./index.ts"] }, scripts: { postinstall: "exit 91", build: "exit 92" } }));
  await writeFile(join(remote, "index.ts"), await promptExtension("v1"));
  const commit = async () => {
    await command(["git", "add", "."], remote);
    await command(["git", "commit", "-m", "fixture revision"], remote);
    return command(["git", "rev-parse", "HEAD"], remote);
  };
  const first = await commit();
  const manifestPath = join(root, "ulw.json");
  const manifest: UlwManifest = { repository: remote, ref: "HEAD", directory: managed, checkIntervalMs: 60_000,
    commandTimeoutMs: 30_000, probeTimeoutMs: 30_000, materialize: null };
  await writeFile(manifestPath, JSON.stringify(manifest));
  const options = { manifestPath, root: managed };
  const cli = (...extra: string[]) => command([process.execPath, resolve(import.meta.dir, "../scripts/prepare-ulw.ts"),
    "--manifest", manifestPath, "--root", managed, ...extra], root);
  return { root, remote, managed, options, first, manifest, manifestPath, commit, cli, startFixtureHost };
}

async function launchFixture(packageName = "omp-superkit", alternateName = "omp-ulw") {
  const f = await fixture(packageName);
  const home = join(f.root, "home");
  const agentDir = join(home, "agent");
  const unrelated = join(f.root, "operator-package");
  const oldUlw = join(f.root, "old-ulw");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await writeFile(join(agentDir, "config.yml"), JSON.stringify(offlineMnemopi), { mode: 0o600 });
  await mkdir(join(unrelated, "skills/operator-skill"), { recursive: true });
  await mkdir(oldUlw);
  await writeFile(join(agentDir, "extensions/ambient.ts"), "throw new Error('discovery must not import ambient modules');\n");
  await writeFile(join(unrelated, "index.ts"), "throw new Error('discovery must not import package modules');\n");
  await writeFile(join(unrelated, "extra.ts"), "throw new Error('disabled module must not load');\n");
  await writeFile(join(unrelated, "skills/operator-skill/SKILL.md"),
    "---\nname: operator-skill\ndescription: Preserved operator resource.\n---\nOperator resource.\n");
  await writeFile(join(unrelated, "package.json"), JSON.stringify({
    name: "operator-package", omp: { extensions: ["./index.ts"] },
  }));
  await writeFile(join(oldUlw, "package.json"), JSON.stringify({ name: alternateName, omp: { extensions: ["./index.ts"] } }));
  await writeFile(join(oldUlw, "index.ts"), "throw new Error('unmanaged ULW must not load');\n");
  const configPath = join(f.root, "launch.json");
  await writeFile(configPath, JSON.stringify({ extensions: [unrelated, oldUlw] }));
  const launch = (commandArgs: string[] = [], env: Record<string, string | undefined> = {}, parentConfigPath?: string) => managedUlwLaunchExtensions({
    cwd: f.root, managedUlwPath: f.remote, extensionPaths: [], configPath, parentConfigPath,
    commandArgs,
    launchArgs: [...commandArgs, "--mode", "rpc-ui", "--cwd", f.root, "-e", f.remote, "--config", configPath],
    env: { PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: agentDir,
      XDG_CONFIG_HOME: join(home, "config"), CI: "true", ...env },
    bunCommand: [process.execPath, "--no-env-file"],
  });
  return { ...f, home, agentDir, unrelated, oldUlw, configPath, launch };
}

test("stock launch snapshot retains unrelated ambient modules and package resources, replacing only ULW identity", async () => {
  const f = await launchFixture();
  const { extensionPaths: paths, noExtensions } = await f.launch();
  expect(noExtensions).toBe(true);
  expect(paths).toContain(join(f.agentDir, "extensions/ambient.ts"));
  expect(paths).toContain(join(f.unrelated, "index.ts"));
  expect(paths).toContain(f.unrelated);
  expect(paths).not.toContain(f.oldUlw);
  expect(paths).not.toContain(join(f.oldUlw, "index.ts"));
  expect(paths.filter(entry => entry === f.remote)).toHaveLength(1);
  // Explicit managed resources precede configured resources in stock OMP.
  expect(paths.indexOf(f.remote)).toBeLessThan(paths.indexOf(f.unrelated));
  expect(paths.indexOf(join(f.remote, "index.ts"))).toBeLessThan(paths.indexOf(join(f.unrelated, "index.ts")));
  expect(await readFile(join(f.unrelated, "skills/operator-skill/SKILL.md"), "utf8")).toContain("Operator resource.");
}, 60_000);

test("stock launch refuses resource roots that would resurrect a disabled sibling module", async () => {
  const f = await launchFixture();
  await writeFile(join(f.unrelated, "package.json"), JSON.stringify({
    name: "operator-package", omp: { extensions: ["./index.ts", "./extra.ts"] },
  }));
  await writeFile(f.configPath, JSON.stringify({
    extensions: [f.unrelated, f.oldUlw], disabledExtensions: ["extension-module:extra"],
  }));
  await expect(f.launch()).rejects.toThrow("re-enable disabled modules or change hook order");
  expect(await readFile(join(f.unrelated, "extra.ts"), "utf8")).toContain("disabled module must not load");
}, 60_000);

test("stock launch excludes a second ULW reached through native ambient symlink discovery", async () => {
  const f = await launchFixture("omp-ulw", "omp-superkit");
  await writeFile(f.configPath, JSON.stringify({ extensions: [f.unrelated] }));
  await symlink(f.oldUlw, join(f.agentDir, "extensions/old-ulw"));
  const launch = await f.launch();
  expect(launch.noExtensions).toBe(true);
  expect(launch.extensionPaths.some(entry => entry.includes("old-ulw"))).toBe(false);
  expect(launch.extensionPaths).toContain(join(f.agentDir, "extensions/ambient.ts"));
  expect(launch.extensionPaths).toContain(f.unrelated);
}, 60_000);

test("stock launch reports package hook order that explicit discovery cannot preserve", async () => {
  const f = await launchFixture();
  await mkdir(join(f.unrelated, "hooks/pre"), { recursive: true });
  await writeFile(join(f.unrelated, "hooks/pre/proof.ts"), "throw new Error('hook discovery must not run factories');\n");
  await expect(f.launch()).rejects.toThrow("re-enable disabled modules or change hook order");
}, 60_000);

test("stock launch reports TypeScript commands that --no-extensions cannot preserve", async () => {
  const f = await launchFixture();
  await mkdir(join(f.agentDir, "commands/operator"), { recursive: true });
  await writeFile(join(f.agentDir, "commands/operator/index.ts"), "throw new Error('command discovery must not execute factories');\n");
  await expect(f.launch()).rejects.toThrow("cannot preserve TypeScript custom commands");
}, 60_000);

test("stock launch preserves ordinary native discovery and TypeScript commands when there is no other ULW copy", async () => {
  const f = await launchFixture();
  await writeFile(f.configPath, JSON.stringify({ extensions: [f.unrelated] }));
  await mkdir(join(f.agentDir, "commands/operator"), { recursive: true });
  await writeFile(join(f.agentDir, "commands/operator/index.ts"), "throw new Error('command discovery must not execute factories');\n");
  const launch = await f.launch();
  expect(launch.noExtensions).toBe(false);
  expect(launch.extensionPaths).toEqual([f.remote]);
}, 60_000);

test("stock launch honors original --no-extensions without resurrecting ambient or configured modules", async () => {
  const f = await launchFixture();
  await mkdir(join(f.agentDir, "commands/operator"), { recursive: true });
  await writeFile(join(f.agentDir, "commands/operator/index.ts"), "throw new Error('disabled command must not load');\n");
  const launch = await f.launch(["--no-extensions", "-e", f.unrelated]);
  expect(launch).toEqual({ extensionPaths: [f.remote], noExtensions: true, memoryWriteDir: f.agentDir });
  expect(launch.extensionPaths).not.toContain(join(f.agentDir, "extensions/ambient.ts"));
  expect(launch.extensionPaths).not.toContain(f.oldUlw);
}, 60_000);

test("stock launch rejects a conflicting original explicit ULW directory or module instead of pretending flags can remove it", async () => {
  const f = await launchFixture();
  await writeFile(f.configPath, "{}");
  for (const args of [
    ["-e", f.oldUlw],
    [`--extension=${join(f.oldUlw, "index.ts")}`],
    ["--no-extensions", "--hook", f.oldUlw],
  ]) {
    await expect(f.launch(args)).rejects.toThrow("explicitly selected by -e/--hook");
  }
}, 60_000);

test("stock launch includes original extra extensions when checking disabled modules under exclusion", async () => {
  const f = await launchFixture();
  await writeFile(join(f.unrelated, "package.json"), JSON.stringify({
    name: "operator-package", omp: { extensions: ["./index.ts", "./extra.ts"] },
  }));
  await writeFile(f.configPath, JSON.stringify({
    extensions: [f.oldUlw], disabledExtensions: ["extension-module:extra"],
  }));
  await expect(f.launch(["--extension", f.unrelated])).rejects.toThrow("re-enable disabled modules or change hook order");
}, 60_000);

test("stock launch rejects reordering an original explicit module ahead of ambient modules", async () => {
  const f = await launchFixture();
  await writeFile(f.configPath, JSON.stringify({ extensions: [f.oldUlw] }));
  const cliExtension = join(f.root, "cli-extension.ts");
  await writeFile(cliExtension, "throw new Error('CLI discovery must not execute factories');\n");
  await expect(f.launch(["-e", cliExtension])).rejects.toThrow("re-enable disabled modules or change hook order");
}, 60_000);

test("stock launch uses original --config overlays and the generated config in native replacement order", async () => {
  const f = await launchFixture();
  const originalConfig = join(f.root, "operator.json");
  const replacementConfig = join(f.root, "replacement.json");
  await writeFile(originalConfig, JSON.stringify({ extensions: [f.unrelated, f.oldUlw] }));
  await writeFile(replacementConfig, JSON.stringify({ extensions: [f.unrelated] }));
  await writeFile(f.configPath, "{}");
  const excluded = await f.launch(["--config", originalConfig]);
  expect(excluded.noExtensions).toBe(true);
  expect(excluded.extensionPaths).toContain(f.unrelated);
  expect(excluded.extensionPaths).not.toContain(f.oldUlw);
  const replaced = await f.launch(["--config", originalConfig, `--config=${replacementConfig}`]);
  expect(replaced).toEqual({ extensionPaths: [f.remote], noExtensions: false, memoryWriteDir: f.agentDir });
  await writeFile(f.configPath, JSON.stringify({ extensions: [f.unrelated] }));
  expect(await f.launch(["--config", originalConfig])).toEqual({ extensionPaths: [f.remote], noExtensions: false, memoryWriteDir: f.agentDir });
}, 60_000);

test("stock launch preserves PI_CONFIG_FILES precedence beneath original CLI configs", async () => {
  const f = await launchFixture();
  const environmentConfig = join(f.root, "environment.json");
  const originalConfig = join(f.root, "operator.json");
  await writeFile(environmentConfig, JSON.stringify({ extensions: [f.oldUlw] }));
  await writeFile(originalConfig, JSON.stringify({ extensions: [f.unrelated] }));
  await writeFile(f.configPath, "{}");
  const launch = await f.launch(["--config", originalConfig], { PI_CONFIG_FILES: environmentConfig });
  expect(launch).toEqual({ extensionPaths: [f.remote], noExtensions: false, memoryWriteDir: f.agentDir });
}, 60_000);

test("stock launch bootstraps the explicit profile before its .env and native discovery", async () => {
  const f = await launchFixture();
  const profileAgent = join(f.home, ".omp/profiles/work/agent");
  const profileConfig = join(f.root, "profile.json");
  await mkdir(join(profileAgent, "extensions"), { recursive: true });
  await writeFile(join(profileAgent, "extensions/profile.ts"), "throw new Error('profile discovery must not execute factories');\n");
  await writeFile(profileConfig, JSON.stringify({ extensions: [f.unrelated, f.oldUlw] }));
  await writeFile(join(profileAgent, ".env"), `PI_CONFIG_FILES=${profileConfig}\n`);
  await writeFile(f.configPath, "{}");
  const launch = await f.launch(["--profile=work"]);
  expect(Bun.YAML.parse(await readFile(join(profileAgent, "config.yml"), "utf8"))).toEqual({ memory: { backend: "mnemopi" } });
  expect(launch.noExtensions).toBe(true);
  expect(launch.extensionPaths).toContain(join(profileAgent, "extensions/profile.ts"));
  expect(launch.extensionPaths).not.toContain(join(f.agentDir, "extensions/ambient.ts"));
  expect(launch.extensionPaths).toContain(f.unrelated);
  expect(launch.extensionPaths).not.toContain(f.oldUlw);
}, 60_000);

test("stock launch follows native profile value consumption instead of scanning tokens", async () => {
  const f = await launchFixture();
  const launch = await f.launch(["--system-prompt", "--profile", "work"]);
  expect(launch.noExtensions).toBe(true);
  expect(launch.extensionPaths).toContain(join(f.agentDir, "extensions/ambient.ts"));
}, 60_000);

test("Host memory writes stay within the original launch profile across dotenv and lane inheritance", async () => {
  const f = await launchFixture();
  const profile = join(f.root, "alternate");
  const config = join(profile, "config.yml");
  const bytes = "memory: {backend: off}\n";
  await mkdir(profile);
  await writeFile(config, bytes);
  await writeFile(join(f.root, ".env"), `PI_CODING_AGENT_DIR=${profile}\n`);
  await expect(f.launch([], { PI_CODING_AGENT_DIR: undefined })).rejects.toThrow("operator's launch profile");
  expect(await readFile(config, "utf8")).toBe(bytes);

  const parentConfig = join(f.root, "parent/config.json");
  await mkdir(join(f.root, "parent"));
  await writeFile(join(f.root, "parent/owner.json"), JSON.stringify({ configPath: parentConfig, memoryWriteDir: f.agentDir }));
  await expect(f.launch([], { PI_CODING_AGENT_DIR: profile }, parentConfig)).rejects.toThrow("operator's launch profile");
  expect(await readFile(config, "utf8")).toBe(bytes);
  const enabled = "memory: {backend: local}\n";
  await writeFile(config, enabled);
  expect((await f.launch([], { PI_CODING_AGENT_DIR: profile }, parentConfig)).memoryWriteDir).toBeNull();
  expect(await readFile(config, "utf8")).toBe(enabled);
}, 60_000);

test("stock launch includes original plugin-dir hooks in native exclusion snapshots", async () => {
  const f = await launchFixture();
  const plugin = join(f.root, "operator-plugin");
  const hook = join(plugin, "hooks/pre/plugin-proof.ts");
  await mkdir(join(plugin, "hooks/pre"), { recursive: true });
  await writeFile(hook, "throw new Error('plugin discovery must not execute factories');\n");
  const launch = await f.launch([`--plugin-dir=${plugin}`]);
  expect(launch.noExtensions).toBe(true);
  expect(launch.extensionPaths).toContain(hook);
  expect(launch.extensionPaths).not.toContain(f.oldUlw);
}, 60_000);

test("stock launch rejects ULW plugin-dir resources that --no-extensions cannot exclude", async () => {
  const f = await launchFixture();
  await writeFile(f.configPath, "{}");
  await expect(f.launch(["--plugin-dir", f.oldUlw])).rejects.toThrow("cannot exclude another ULW copy's plugin resources");
}, 60_000);

test("stock launch rejects non-launch argv and end-of-options that prevents managed selection", async () => {
  const f = await launchFixture();
  await writeFile(f.configPath, "{}");
  await expect(f.launch(["--"])).rejects.toThrow("does not select the managed ULW package root");
  await expect(f.launch(["zsh", "-c", "exit 0"])).rejects.toThrow("not a shell command");
  await expect(f.launch(["--trusted-extension", join(f.remote, "index.ts")])).rejects.toThrow("--trusted-extension cannot be combined");
  await expect(f.launch(["--trusted-extension", join(f.remote, "index.ts"), "--"])).rejects.toThrow("cannot preserve managed ULW package resources");
}, 60_000);

test("stock launch does not resurrect disabled managed modules when replacing another ULW", async () => {
  const f = await launchFixture();
  await writeFile(f.configPath, JSON.stringify({ extensions: [f.oldUlw],
    disabledExtensions: [`extension-module:${getExtensionNameFromPath(join(f.remote, "index.ts"))}`] }));
  await expect(f.launch()).rejects.toThrow("re-enable disabled modules or change hook order");
}, 60_000);

test("stock launch refuses to change project package resource scope while excluding another ULW copy", async () => {
  const f = await launchFixture();
  await rename(join(f.unrelated, "skills"), join(f.unrelated, "knowledge"));
  await writeFile(join(f.unrelated, "package.json"), JSON.stringify({
    name: "operator-package", omp: { extensions: ["./index.ts"], skills: ["./knowledge"] },
  }));
  await mkdir(join(f.root, ".omp"));
  await writeFile(join(f.root, ".omp/config.yml"), JSON.stringify({ extensions: [f.unrelated, f.oldUlw] }));
  await writeFile(f.configPath, "{}");
  await expect(f.launch()).rejects.toThrow(`change project resource scope to user scope: ${f.unrelated}`);
}, 60_000);

test("real preparation CLI installs, reads back provenance/resources/skills, and ignores arbitrary package scripts", async () => {
  const f = await fixture();
  const original = await readFile(join(f.remote, "index.ts"), "utf8");
  const output = JSON.parse(await f.cli());
  expect(output.revision).toBe(f.first);
  expect(output.error).toBeNull();
  expect(JSON.parse(await f.cli("--status")).revision).toBe(f.first);
  const installed = activeManagedUlw(f.options);
  expect(installed).toBe(join(f.managed, "revisions", f.first, "package"));
  expect(await readFile(join(installed, "resource.txt"), "utf8")).toBe("resource-v1");
  expect(JSON.parse(await readFile(join(installed, "package.json"), "utf8")).omp.skills).toEqual(["./skills"]);
  expect((await lstat(join(installed, "index.ts"))).mode & 0o222).toBe(0);
  const provenance = JSON.parse(await readFile(join(installed, "../provenance.json"), "utf8"));
  expect(provenance.repository).toBe(f.remote);
  expect(provenance.branch).toBe("refs/heads/main");
  expect(provenance.revision).toBe(f.first);
  expect(await readFile(join(f.remote, "index.ts"), "utf8")).toBe(original);
  expect(await command(["git", "status", "--porcelain"], f.remote)).toBe("");
}, 60_000);

test("changed remote activates atomically; unchanged remote and failed updates retain current immutable files", async () => {
  const f = await fixture();
  await updateManagedUlw(f.options);
  const firstPath = activeManagedUlw(f.options);
  const firstBytes = await readFile(join(firstPath, "index.ts"), "utf8");
  const inode = (await lstat(join(firstPath, "index.ts"))).ino;
  await updateManagedUlw(f.options);
  expect(activeManagedUlw(f.options)).toBe(firstPath);
  expect((await lstat(join(firstPath, "index.ts"))).ino).toBe(inode);
  const manifestPath = join(f.remote, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, name: "omp-superkit" }));
  await writeFile(join(f.remote, "index.ts"), await promptExtension("v2"));
  const second = await f.commit();
  const updated = await updateManagedUlw(f.options);
  expect(updated.revision).toBe(second);
  const secondPath = activeManagedUlw(f.options);
  expect(JSON.parse(await readFile(join(secondPath, "package.json"), "utf8")).name).toBe("omp-superkit");
  const secondBytes = await readFile(join(secondPath, "index.ts"), "utf8");
  const secondInode = (await lstat(join(secondPath, "index.ts"))).ino;
  expect(secondPath).not.toBe(firstPath);
  expect(await readFile(join(firstPath, "index.ts"), "utf8")).toBe(firstBytes);
  expect((await lstat(join(firstPath, "index.ts"))).ino).toBe(inode);
  await writeFile(join(f.remote, "index.ts"), "export default function incompatible() { throw new Error('fixture-incompatible-api'); }\n");
  const broken = await f.commit();
  await expect(updateManagedUlw(f.options)).rejects.toThrow("previous active revision retained");
  expect(activeManagedUlw(f.options)).toBe(secondPath);
  const failed = managedUlwStatus(f.options);
  expect(failed.revision).toBe(second);
  expect(failed.upstreamRevision).toBe(broken);
  expect(failed.error).toContain("fixture-incompatible-api");
  expect(failed.updating).toBe(false);
  expect(await readFile(join(secondPath, "index.ts"), "utf8")).toBe(secondBytes);
  expect((await lstat(join(secondPath, "index.ts"))).ino).toBe(secondInode);
  expect(await readFile(join(firstPath, "index.ts"), "utf8")).toBe(firstBytes);
  expect(await command(["git", "status", "--porcelain"], f.remote)).toBe("");
  await writeFile(f.manifestPath, JSON.stringify({ ...f.manifest, repository: join(f.root, "missing.git") }));
  await expect(updateManagedUlw(f.options)).rejects.toThrow("previous active revision retained");
  expect(activeManagedUlw(f.options)).toBe(secondPath);
  expect(managedUlwStatus(f.options).error).not.toBeNull();
  expect(await readFile(join(secondPath, "index.ts"), "utf8")).toBe(secondBytes);
}, 90_000);

for (const defect of ["no-effect", "empty-preset", "missing-workflow", "duplicate-preset", "duplicate-workflow"]) {
  test(`loadable ${defect} candidate fails native prompt composition before changing the active pointer`, async () => {
    const f = await fixture();
    await updateManagedUlw(f.options);
    const active = activeManagedUlw(f.options);
    const pointer = await readFile(join(f.managed, "active.json"), "utf8");
    const installed = await readFile(join(active, "index.ts"), "utf8");
    await writeFile(join(f.remote, "index.ts"), await promptExtension("incompatible", defect));
    const candidate = await f.commit();
    await expect(updateManagedUlw(f.options)).rejects.toThrow("previous active revision retained");
    expect(await readFile(join(f.managed, "active.json"), "utf8")).toBe(pointer);
    expect(activeManagedUlw(f.options)).toBe(active);
    expect(await readFile(join(active, "index.ts"), "utf8")).toBe(installed);
    const status = managedUlwStatus(f.options);
    expect(status.revision).toBe(f.first);
    expect(status.upstreamRevision).toBe(candidate);
    expect(status.updating).toBe(false);
    expect(status.error).toContain(defect === "missing-workflow" || defect === "duplicate-workflow"
      ? "exactly one explicitly activated ULW policy" : defect === "empty-preset"
        ? "working instructions" : "exactly one applied model preset");
    expect((await readdir(f.managed)).filter(entry => entry.startsWith(".stage-"))).toEqual([]);
    expect(await readdir(join(f.managed, "revisions"))).toEqual([f.first]);
  }, 90_000);
}

test("a previously prepared loadable no-op revision must pass the new composition gate before activation", async () => {
  const f = await fixture();
  await updateManagedUlw(f.options);
  const active = activeManagedUlw(f.options);
  const pointer = await readFile(join(f.managed, "active.json"), "utf8");
  await writeFile(join(f.remote, "index.ts"), "export default function legacyLoadOnlyFixture() {}\n");
  const candidate = await f.commit();
  // Simulate an immutable package accepted by the former import-only gate.
  const revisionRoot = join(f.managed, "revisions", candidate);
  const prepared = join(revisionRoot, "package");
  await mkdir(join(prepared, "skills"), { recursive: true });
  for (const file of ["index.ts", "package.json", "resource.txt"]) {
    await writeFile(join(prepared, file), await readFile(join(f.remote, file)), { mode: 0o444 });
  }
  await writeFile(join(revisionRoot, "provenance.json"), JSON.stringify({
    revision: candidate, repository: f.remote, branch: "refs/heads/main", preparedAt: new Date().toISOString(),
  }));
  await chmod(join(prepared, "skills"), 0o555);
  await chmod(prepared, 0o555);
  await expect(updateManagedUlw(f.options)).rejects.toThrow("exactly one applied model preset");
  expect(await readFile(join(f.managed, "active.json"), "utf8")).toBe(pointer);
  expect(activeManagedUlw(f.options)).toBe(active);
  expect(managedUlwStatus(f.options).upstreamRevision).toBe(candidate);
  expect(managedUlwStatus(f.options).updating).toBe(false);
  expect(await readFile(join(prepared, "index.ts"), "utf8")).toContain("legacyLoadOnlyFixture");
  expect((await readdir(f.managed)).filter(entry => entry.startsWith(".stage-"))).toEqual([]);
}, 90_000);

test("concurrent real installer processes serialize and never publish an incomplete revision", async () => {
  const f = await fixture();
  const [first, second] = await Promise.all([f.cli(), f.cli()]);
  expect(JSON.parse(first).revision).toBe(f.first);
  expect(JSON.parse(second).revision).toBe(f.first);
  expect(activeManagedUlw(f.options)).toBe(join(f.managed, "revisions", f.first, "package"));
  expect((await readdir(f.managed)).filter(entry => entry.startsWith(".stage-"))).toEqual([]);
  expect(await readdir(join(f.managed, "revisions"))).toEqual([f.first]);
}, 60_000);

test("new Hosts select the newly active package despite an old head marker; live Hosts retain readable old files", async () => {
  const f = await fixture();
  await updateManagedUlw(f.options);
  const firstPath = activeManagedUlw(f.options);
  const launcher = join(f.root, "host.ts");
  await writeStockHostExecutable(launcher, `import * as fs from 'node:fs';
import { recordHostFixture } from ${JSON.stringify(resolve(import.meta.dir, "fixtures/host-fixture-processes.ts"))};
import { stockHostFixture } from ${JSON.stringify(resolve(import.meta.dir, "fixtures/stock-host.ts"))};
import { readSessionHeaderId } from ${JSON.stringify(import.meta.resolve("@oh-my-pi/pi-coding-agent/session/session-loader"))};
recordHostFixture(${JSON.stringify(f.root)});
const args=process.argv.slice(2); const value=flag=>args[args.indexOf(flag)+1];
const socket=process.env.OMP_SUPERAGENT_HOST_SOCKET; const sessionFile=value('--session');
const packagePath=process.env.OMP_SUPERAGENT_MANAGED_ULW_PATH;
fs.writeFileSync(socket+'.observed.json',JSON.stringify({packagePath,args,managedRoot:process.env.OMP_SUPERAGENT_TEST_MANAGED_ULW_ROOT}));
const sessionId=await readSessionHeaderId(sessionFile);
if(!sessionId)throw new Error('Fixture requires the actual persisted session identity');
await stockHostFixture({sessionId,sessionFile,state:()=>({sessionName:fs.readFileSync(packagePath+'/index.ts','utf8')})});`);
  const home = join(f.root, "host-home");
  await mkdir(join(home, "agent"), { recursive: true });
  await writeFile(join(home, "agent/config.yml"), JSON.stringify(offlineMnemopi), { mode: 0o600 });
  const launch = async (name: string, env: Record<string, string>, managedUlwRoot?: string) => {
    const options: HostOptions = { command: [launcher], socketPath: join(f.root, `${name}.sock`),
      sessionFile: join(f.root, `${name}.jsonl`), cwd: f.root, extensionPath: launcher,
      managedUlwRoot, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, PI_CODING_AGENT_DIR: join(home, "agent"), ...env },
      logPath: join(f.root, `${name}.log`), subagentConcurrency: 1 };
    await f.startFixtureHost(options);
    return JSON.parse(await readFile(options.socketPath + ".observed.json", "utf8")) as { packagePath: string; args: string[]; managedRoot: string };
  };
  const head = await launch("head", {}, f.managed);
  expect(head.packagePath).toBe(firstPath);
  expect(head.managedRoot).toBe(f.managed);
  await writeFile(join(f.remote, "index.ts"), await promptExtension("v2"));
  await f.commit();
  await updateManagedUlw(f.options);
  const secondPath = activeManagedUlw(f.options);
  const lane = await launch("lane", { OMP_SUPERAGENT_MANAGED_ULW_PATH: head.packagePath,
    OMP_SUPERAGENT_TEST_MANAGED_ULW_ROOT: head.managedRoot });
  expect(lane.packagePath).toBe(secondPath);
  expect(lane.packagePath).not.toBe(head.packagePath);
  expect(head.args.filter(arg => arg === firstPath)).toHaveLength(1);
  expect(lane.args.filter(arg => arg === secondPath)).toHaveLength(1);
  expect(await readFile(join(head.packagePath, "index.ts"), "utf8")).toContain("v1");
  const liveHead = await connect(join(f.root, "head.sock"));
  try {
    const response = await liveHead.request({ type: "get_state" });
    expect(JSON.stringify(response)).toContain("v1");
    expect(JSON.stringify(response)).not.toContain("v2");
  } finally { await liveHead.close(); }
}, 90_000);

test("missing resources and unreachable upstream cannot activate; unrelated local checkout is untouched", async () => {
  const f = await fixture();
  await expect(updateManagedUlw({ ...f.options, root: f.remote })).rejects.toThrow();
  expect(await command(["git", "status", "--porcelain"], f.remote)).toBe("");
  await rm(join(f.remote, "skills"), { recursive: true });
  await f.commit();
  await expect(updateManagedUlw(f.options)).rejects.toThrow("previous active revision retained");
  await expect(Promise.resolve().then(() => activeManagedUlw(f.options))).rejects.toThrow("not installed");
  await writeFile(f.manifestPath, JSON.stringify({ ...f.manifest, repository: join(f.root, "missing.git") }));
  await expect(updateManagedUlw(f.options)).rejects.toThrow("previous active revision retained");
  expect(managedUlwStatus(f.options).revision).toBeNull();
  expect(managedUlwStatus(f.options).error).not.toBeNull();
}, 60_000);

test("remote rewind retains the newer live revision, and a crashed SQLite lock owner needs no lock-file deletion", async () => {
  const f = await fixture();
  await updateManagedUlw(f.options);
  await writeFile(join(f.remote, "resource.txt"), "resource-v2");
  const second = await f.commit();
  await updateManagedUlw(f.options);
  const secondPath = activeManagedUlw(f.options);
  // Move only this test-owned remote ref. Never reset/remove a user's worktree.
  await command(["git", "update-ref", "refs/heads/main", f.first, second], f.remote);
  await expect(updateManagedUlw(f.options)).rejects.toThrow("fast-forward");
  expect(activeManagedUlw(f.options)).toBe(secondPath);
  expect(await readFile(join(secondPath, "resource.txt"), "utf8")).toBe("resource-v2");
  await command(["git", "update-ref", "refs/heads/main", second, f.first], f.remote);
  const lockPath = join(f.managed, "update.sqlite");
  const before = (await lstat(lockPath)).ino;
  const owner = Bun.spawn([process.execPath, "-e", `import { Database } from 'bun:sqlite';
const db = new Database(${JSON.stringify(lockPath)}); db.exec('BEGIN IMMEDIATE');
console.log('locked'); await Bun.stdin.text();`], { cwd: f.root, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  try {
    const reader = owner.stdout.getReader();
    const ready = await reader.read();
    if (ready.done || !new TextDecoder().decode(ready.value).includes("locked")) throw new Error("Lock fixture failed to acquire ownership");
    reader.releaseLock();
    owner.kill("SIGKILL");
    await owner.exited;
    await updateManagedUlw(f.options);
    expect((await lstat(lockPath)).ino).toBe(before);
    expect(activeManagedUlw(f.options)).toBe(secondPath);
    expect(managedUlwStatus(f.options).error).toBeNull();
  } finally { owner.kill("SIGKILL"); await owner.exited; }
}, 90_000);
