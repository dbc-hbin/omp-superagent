import { Database } from "bun:sqlite";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const ownership = "omp-superagent-managed-ulw-v1";
const hash = /^[0-9a-f]{40,64}$/;
export const MANAGED_ULW_ENV = "OMP_SUPERAGENT_MANAGED_ULW_PATH";
// Only explicitly injected fixtures propagate. The per-Host revision marker above
// is informational: a new lane must resolve the current active revision afresh.
export const MANAGED_ULW_FIXTURE_ENV = "OMP_SUPERAGENT_TEST_MANAGED_ULW_PATH";
export const MANAGED_ULW_FIXTURE_ROOT_ENV = "OMP_SUPERAGENT_TEST_MANAGED_ULW_ROOT";

export interface UlwManifest {
  repository: string;
  ref: "HEAD";
  directory: string;
  checkIntervalMs: number;
  commandTimeoutMs: number;
  probeTimeoutMs: number;
  materialize: string | null;
}
export interface ManagedUlwStatus {
  revision: string | null;
  packagePath: string | null;
  upstreamRevision: string | null;
  checkedAt: string | null;
  error: string | null;
  updating: boolean;
  injected?: boolean;
}
interface ActiveRevision { revision: string; repository: string; branch: string; preparedAt: string }
interface PackageManifest {
  name?: string;
  omp?: { extensions?: string[]; skills?: string[]; [key: string]: unknown };
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}
export interface ManagedUlwOptions { manifestPath?: string; root?: string }

function isManagedUlwPackageName(name: string | undefined): boolean {
  return name === "omp-superkit" || name === "omp-ulw";
}

function matchesUlwRepository(previous: string, current: string): boolean {
  // GitHub kept the repository identity and history when it renamed the project.
  return previous === current || (
    previous === "https://github.com/dbc-hbin/omp-ulw.git" &&
    current === "https://github.com/dbc-hbin/omp-superkit.git"
  );
}

export function readUlwManifest(manifestPath = join(projectRoot, "upstream/ulw.json")): UlwManifest {
  const value = JSON.parse(readFileSync(manifestPath, "utf8")) as UlwManifest;
  if (!value.repository || value.ref !== "HEAD" || !value.directory ||
      !Number.isSafeInteger(value.checkIntervalMs) || value.checkIntervalMs < 60_000 ||
      !Number.isSafeInteger(value.commandTimeoutMs) || value.commandTimeoutMs < 1_000 ||
      !Number.isSafeInteger(value.probeTimeoutMs) || value.probeTimeoutMs < 1_000 ||
      !(value.materialize === null || typeof value.materialize === "string"))
    throw new Error("Invalid managed ULW manifest");
  return value;
}
function rootFor(options: ManagedUlwOptions, manifest = readUlwManifest(options.manifestPath)): string {
  return resolve(options.root ?? resolve(projectRoot, manifest.directory));
}
function assertOwned(root: string): void {
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077))
    throw new Error("Managed ULW directory must be a private owned directory");
  if (readFileSync(join(root, "owner.json"), "utf8") !== JSON.stringify({ owner: ownership }))
    throw new Error("Refusing to modify an unrelated ULW directory");
}
function readActive(root: string): ActiveRevision | null {
  try {
    const value = JSON.parse(readFileSync(join(root, "active.json"), "utf8")) as ActiveRevision;
    if (!hash.test(value.revision) || !value.repository || !value.branch) throw new Error("Invalid managed ULW active pointer");
    return value;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
export function readManagedUlwPackage(packagePath: string) {
  if (!isAbsolute(packagePath)) throw new Error("Managed ULW package must have an absolute path");
  const canonical = realpathSync(packagePath);
  const pkg = JSON.parse(readFileSync(join(canonical, "package.json"), "utf8")) as PackageManifest;
  if (!isManagedUlwPackageName(pkg.name) || !Array.isArray(pkg.omp?.extensions) || !pkg.omp.extensions.length)
    throw new Error("Managed ULW package has no native extension manifest");
  const extensionFiles = pkg.omp.extensions.map(entry => {
    if (typeof entry !== "string" || !entry || isAbsolute(entry)) throw new Error("Invalid managed ULW extension entry");
    const target = realpathSync(resolve(canonical, entry));
    if (!target.startsWith(canonical + sep) || !lstatSync(target).isFile()) throw new Error("Managed ULW extension leaves its package");
    return target;
  });
  if (!lstatSync(join(canonical, "skills")).isDirectory()) throw new Error("Managed ULW skills are missing");
  return { packagePath: canonical, extensionFiles };
}
export function validateManagedUlwPackage(packagePath: string): string {
  return readManagedUlwPackage(packagePath).packagePath;
}
export function activeManagedUlw(options: ManagedUlwOptions = {}): string {
  const root = rootFor(options);
  try { assertOwned(root); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("Mandatory managed ULW is not installed; run bun run prepare:ulw");
    throw error;
  }
  const active = readActive(root);
  if (!active) throw new Error("Mandatory managed ULW is not installed; run bun run prepare:ulw");
  const revisionRoot = join(root, "revisions", active.revision);
  const provenance = JSON.parse(readFileSync(join(revisionRoot, "provenance.json"), "utf8")) as ActiveRevision;
  if (provenance.revision !== active.revision || provenance.repository !== active.repository)
    throw new Error("Managed ULW provenance does not match its active pointer");
  return validateManagedUlwPackage(join(revisionRoot, "package"));
}
export function managedUlwStatus(options: ManagedUlwOptions = {}): ManagedUlwStatus {
  const root = rootFor(options);
  let saved: Partial<ManagedUlwStatus> = {};
  try { saved = JSON.parse(readFileSync(join(root, "status.json"), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const active = readActive(root);
  return { revision: active?.revision ?? null, packagePath: active ? join(root, "revisions", active.revision, "package") : null,
    upstreamRevision: saved.upstreamRevision ?? null, checkedAt: saved.checkedAt ?? null,
    error: saved.error ?? null, updating: saved.updating ?? false };
}
async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try { await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}
async function initialize(root: string): Promise<void> {
  try {
    await mkdir(root, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // Concurrent initialization may have created the directory just before its
    // ownership marker. Never claim a pre-existing, unmarked directory.
    for (let attempt = 0; attempt < 20; attempt++) {
      try { assertOwned(root); return; }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
      await Bun.sleep(10);
    }
    assertOwned(root);
    return;
  }
  // A second installer may already be reading owner.json. Publish complete bytes
  // without replacing an existing marker or claiming a directory we didn't create.
  const marker = join(root, `.owner-${crypto.randomUUID()}.tmp`);
  try {
    await writeFile(marker, JSON.stringify({ owner: ownership }), { flag: "wx", mode: 0o600 });
    await link(marker, join(root, "owner.json"));
  } finally {
    await rm(marker, { force: true });
  }
  assertOwned(root);
}
async function run(args: string[], cwd: string, timeout: number, env?: Record<string, string>): Promise<string> {
  const child = Bun.spawn(args, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout, killSignal: "SIGKILL" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (exit !== 0) throw new Error(`${args[0]} ${args[1] ?? ""} failed (${exit}): ${stderr.slice(-2000)}`);
  return stdout.trim();
}
async function immutableTree(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await immutableTree(path);
    else if (!entry.isSymbolicLink()) { const stat = await lstat(path); await chmod(path, 0o444 | (stat.mode & 0o111)); }
  }
  await chmod(directory, 0o555);
}
async function checkLinks(directory: string, root = directory): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await checkLinks(path, root);
    else if (entry.isSymbolicLink()) {
      const target = realpathSync(path);
      if (!target.startsWith(root + sep)) throw new Error("Managed ULW resource symlink leaves its package");
    }
  }
}
async function probe(packagePath: string, stage: string, manifest: UlwManifest): Promise<void> {
  const home = join(stage, "probe-home");
  await mkdir(home, { mode: 0o700 });
  const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, USERPROFILE: home,
    PI_CODING_AGENT_DIR: join(home, "agent"), XDG_CONFIG_HOME: join(home, "config"),
    XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"), CI: "true", NO_COLOR: "1" };
  if (process.env.PI_NATIVES_DIR) env.PI_NATIVES_DIR = process.env.PI_NATIVES_DIR;
  await run([process.execPath, fileURLToPath(new URL("./managed-ulw-probe.ts", import.meta.url)), packagePath],
    home, manifest.probeTimeoutMs, env);
}

/** Snapshot native discovery in the exact environment the installed CLI will use. */
export async function managedUlwLaunchExtensions(options: {
  cwd: string;
  managedUlwPath: string;
  extensionPaths: string[];
  configPath: string;
  parentConfigPath?: string;
  /** Native argv prefix retained verbatim by the caller when it replaces the generated Host args. */
  commandArgs: string[];
  /** Exact native OMP argv, including the original command's flags and generated Host args; no executable prefix. */
  launchArgs: string[];
  env: Record<string, string | undefined>;
  bunCommand: string[];
}): Promise<{ extensionPaths: string[]; noExtensions: boolean; memoryWriteDir: string | null }> {
  if (!options.bunCommand.length) throw new Error("Managed ULW discovery requires the launcher's Bun command");
  const { env, bunCommand, ...input } = options;
  const output = await run([...bunCommand, fileURLToPath(import.meta.url), "--launch-extensions", JSON.stringify(input)],
    options.cwd, 30_000, Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)));
  const result = output.split("\n").findLast(line => line.startsWith("MANAGED_ULW_LAUNCH "));
  if (!result) throw new Error("Stock OMP discovery did not return a launch composition");
  return JSON.parse(result.slice("MANAGED_ULW_LAUNCH ".length));
}

if (import.meta.main && process.argv[2] === "--launch-extensions") {
  const input = JSON.parse(process.argv[3]!) as {
    cwd: string; managedUlwPath: string; extensionPaths: string[]; parentConfigPath?: string;
    commandArgs: string[]; launchArgs: string[];
  };
  const { parseNativeLaunch } = await import("./native-launch-profile");
  const parsed = await parseNativeLaunch(input.launchArgs);
  const { extractProfileFlags } = await import("@oh-my-pi/pi-coding-agent/cli/profile-bootstrap");
  const { getProjectDir } = await import("@oh-my-pi/pi-utils/dirs");
  const { parseArgs } = await import("@oh-my-pi/pi-coding-agent/cli/args");
  const command = parseArgs(extractProfileFlags(input.commandArgs).argv);
  if (parsed.trustedExtensions?.length) {
    throw new Error("Stock OMP --trusted-extension cannot preserve managed ULW package resources");
  }
  const { applyStartupCwd } = await import("@oh-my-pi/pi-coding-agent/cli/startup-cwd");
  await applyStartupCwd(parsed);
  const cwd = getProjectDir();
  const { Settings } = await import("@oh-my-pi/pi-coding-agent/config/settings");
  const { discoverSessionExtensionPaths } = await import("@oh-my-pi/pi-coding-agent/sdk");
  const { discoverExtensionPaths, listPackageExtensionModules } = await import("@oh-my-pi/pi-coding-agent/extensibility/extensions/loader");
  const { initializeWithSettings } = await import("@oh-my-pi/pi-coding-agent/discovery");
  const { listOmpExtensionRoots, withOmpExtensionRootScope, setInvocationConfiguredExtensions } = await import("@oh-my-pi/pi-coding-agent/discovery/omp-extension-roots");
  const { injectPluginDirRoots, preloadPluginRoots, listClaudePluginRoots } = await import("@oh-my-pi/pi-coding-agent/discovery/helpers");
  const { cfgExtensions } = await import("@oh-my-pi/pi-coding-agent/extensibility/settings");
  const { findRepoRoot } = await import("@oh-my-pi/pi-coding-agent/capability/fs");
  const { discoverCustomCommands } = await import("@oh-my-pi/pi-coding-agent/extensibility/custom-commands/loader");
  const { getAgentDir } = await import("@oh-my-pi/pi-utils");
  const { homedir } = await import("node:os");
  if (parsed.pluginDirs?.length) await injectPluginDirRoots(homedir(), parsed.pluginDirs, cwd);
  else await preloadPluginRoots(homedir(), cwd);
  const { ensureManagedMemory, memoryBlockReason } = await import("./managed-memory");
  const settings = await Settings.loadReadOnly({ cwd, agentDir: getAgentDir(), configFiles: parsed.config })
    .catch(() => { throw new Error(memoryBlockReason({ status: "unknown" })); });
  let memoryWriteDir: string | null = parsed.launchAgentDir;
  if (input.parentConfigPath) {
    // A lane inherits its head's post-dotenv environment. It cannot use that
    // environment to enlarge the write authority recorded by the head's launcher.
    const parent: unknown = await Bun.file(join(dirname(input.parentConfigPath), "owner.json")).json().catch(() => null);
    if (!parent || typeof parent !== "object" || !("configPath" in parent) || parent.configPath !== input.parentConfigPath ||
        !("memoryWriteDir" in parent) || parent.memoryWriteDir !== memoryWriteDir) memoryWriteDir = null;
  }
  let composition: { extensionPaths: string[]; noExtensions: boolean };
  const restore = initializeWithSettings(settings);
  try {
    const managed = validateManagedUlwPackage(input.managedUlwPath);
    const ulwRoot = async (entry: string): Promise<string | undefined> => {
      let current: string;
      try { current = await realpath(entry); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
      if (!(await lstat(current)).isDirectory()) current = dirname(current);
      for (;;) {
        try {
          const manifest = JSON.parse(await readFile(join(current, "package.json"), "utf8")) as PackageManifest;
          return isManagedUlwPackageName(manifest.name) ? current : undefined;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const parent = dirname(current);
        if (parent === current) return undefined;
        current = parent;
      }
    };
    const nativeExplicit = [...new Set([...(parsed.extensions ?? []), ...(parsed.hooks ?? [])])];
    // These argv entries remain in the caller's command. Appending flags cannot
    // revoke an explicit -e/--hook, even with --no-extensions.
    const commandExplicit = [...(command.extensions ?? []), ...(command.hooks ?? [])];
    const commandModules = await listPackageExtensionModules(commandExplicit, cwd, { plugins: false });
    const commandRoots = await withOmpExtensionRootScope(commandExplicit, "explicit-only", () => listOmpExtensionRoots({
      cwd, home: homedir(), repoRoot: null, agentDir: getAgentDir(),
    }));
    for (const entry of [...commandModules, ...commandRoots]) {
      const root = await ulwRoot(entry.path);
      if (root && root !== managed) {
        throw new Error(`Stock OMP cannot exclude another ULW copy explicitly selected by -e/--hook: ${root}; remove that original launch argument`);
      }
    }
    // --no-extensions scopes OMP packages, not the independent marketplace and
    // --plugin-dir resource providers. Their roots cannot be removed by -e.
    for (const plugin of (await listClaudePluginRoots(homedir(), cwd)).roots) {
      const root = await ulwRoot(plugin.path);
      if (root && root !== managed) {
        throw new Error(`Stock OMP cannot exclude another ULW copy's plugin resources: ${root}; remove --plugin-dir or disable that plugin`);
      }
    }
    const mode = parsed.noExtensions ? "explicit-only" : "merge";
    const original = await withOmpExtensionRootScope(nativeExplicit, mode, () => {
      setInvocationConfiguredExtensions(cfgExtensions.get(settings), settings.extensionsSourceLevel());
      return discoverSessionExtensionPaths({
        additionalExtensionPaths: nativeExplicit, disableExtensionDiscovery: parsed.noExtensions,
      }, cwd, settings);
    });
    const roots = await listOmpExtensionRoots({
      cwd, home: homedir(), repoRoot: await findRepoRoot(cwd), agentDir: getAgentDir(),
      extensionRoots: { explicit: nativeExplicit, configured: cfgExtensions.get(settings),
        configuredLevel: settings.extensionsSourceLevel(), mode },
    });
    if (!(await Promise.all(roots.map(root => realpath(root.path)))).includes(managed)) {
      throw new Error("Native OMP launch argv does not select the managed ULW package root; generated Host flags may be after --");
    }
    const retained = [];
    let conflict = false;
    for (const entry of original) {
      const root = await ulwRoot(entry);
      if (!root || root === managed) retained.push(entry);
      else conflict = true;
    }
    const resourceRoots: string[] = [];
    for (const root of roots) {
      const identity = await ulwRoot(root.path);
      if (!identity || identity === managed) resourceRoots.push(root.path);
      else conflict = true;
    }
    if (!conflict) {
      // Ordinary native discovery preserves every native surface, including
      // TypeScript commands, when no other ULW copy needs exclusion.
      composition = { extensionPaths: [...new Set([...input.extensionPaths, managed])], noExtensions: !!parsed.noExtensions };
    } else {
      const commands = parsed.noExtensions ? [] : (await discoverCustomCommands({ cwd, agentDir: getAgentDir() })).paths;
      if (commands.length) {
        throw new Error(`Stock OMP --no-extensions cannot preserve TypeScript custom commands while excluding another ULW copy: `
          + JSON.stringify(commands.map(command => command.path)));
      }
      // File paths preserve the authoritative module selection/order. Directory
      // roots preserve all sibling capabilities, not just the skill CLI surface.
      const explicit = [...retained, ...resourceRoots];
      const actualExplicit = [...(command.extensions ?? []), ...explicit, ...(command.hooks ?? [])];
      const expected = retained;
      const actual = await discoverExtensionPaths(actualExplicit, cwd, undefined, { ambient: false });
      const canonical = async (entries: string[]) => Promise.all(entries.map(entry => realpath(entry)));
      const expectedFiles = await canonical(expected);
      const actualFiles = await canonical(actual);
      if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
        throw new Error(`Stock OMP cannot preserve this extension/resource selection with --no-extensions: `
          + `package resources would re-enable disabled modules or change hook order. `
          + `Expected modules ${JSON.stringify(expectedFiles)}; explicit CLI modules ${JSON.stringify(actualFiles)}`);
      }
      const actualRoots = await withOmpExtensionRootScope(actualExplicit, "explicit-only", () => listOmpExtensionRoots({
        cwd, home: homedir(), repoRoot: null, agentDir: getAgentDir(),
      }));
      const expectedRoots = await canonical([...new Set(resourceRoots)]);
      if (JSON.stringify(await canonical(actualRoots.map(root => root.path))) !== JSON.stringify(expectedRoots)) {
        throw new Error("Stock OMP explicit CLI resource roots differ from the selected native package roots");
      }
      for (const root of roots.filter(root => resourceRoots.includes(root.path))) {
        const actualLevel = actualRoots[expectedRoots.indexOf(await realpath(root.path))]?.level;
        if (actualLevel !== root.level) {
          throw new Error(`Stock OMP explicit -e would change ${root.level} resource scope to ${actualLevel} scope: ${root.path}`);
        }
      }
      composition = { extensionPaths: explicit, noExtensions: true };
    }
  } finally { restore(); }
  // Discovery can refuse an incompatible launch. Do not persist memory for it.
  const { readNativeSettings } = await import("./native-settings");
  const current = await readNativeSettings(settings).catch(() => { throw new Error(memoryBlockReason({ status: "unknown" })); });
  const { memory } = await ensureManagedMemory(current, memoryWriteDir);
  if (memory.status !== "enabled") throw new Error(memoryBlockReason(memory));
  console.log(`MANAGED_ULW_LAUNCH ${JSON.stringify({ ...composition, memoryWriteDir })}`);
}

/** Serialized source preparation only. No Gateway, account adapter, or Host starts here. */
export async function updateManagedUlw(options: ManagedUlwOptions = {}): Promise<ManagedUlwStatus> {
  const manifest = readUlwManifest(options.manifestPath);
  const root = rootFor(options, manifest);
  await mkdir(dirname(root), { recursive: true });
  await initialize(root);
  const lock = new Database(join(root, "update.sqlite"));
  lock.exec("PRAGMA busy_timeout=0");
  const deadline = Date.now() + manifest.commandTimeoutMs * 4;
  try {
    for (;;) {
      try { lock.exec("BEGIN IMMEDIATE"); break; }
      catch (error) {
        if (!(error instanceof Error) || !/locked|busy/i.test(error.message) || Date.now() >= deadline) throw error;
        await Bun.sleep(25);
      }
    }
    let stage: string | undefined;
    let upstreamRevision: string | null = null;
    const checkedAt = new Date().toISOString();
    try {
      await atomicJson(join(root, "status.json"), { ...managedUlwStatus(options), checkedAt, updating: true, error: null });
      const git = (args: string[], cwd = root) => run(["git", "-c", "core.hooksPath=/dev/null", ...args], cwd, manifest.commandTimeoutMs,
        { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, USERPROFILE: root,
          GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" });
      const remote = await git(["ls-remote", "--symref", manifest.repository, "HEAD"]);
      const branch = /^ref: (refs\/heads\/[^\s]+)\s+HEAD$/m.exec(remote)?.[1];
      upstreamRevision = /^([0-9a-f]{40,64})\s+HEAD$/m.exec(remote)?.[1] ?? null;
      if (!branch || !upstreamRevision) throw new Error("ULW upstream did not advertise an unambiguous default branch and HEAD commit");
      const active = readActive(root);
      let nextActive: ActiveRevision | undefined;
      if (active && !matchesUlwRepository(active.repository, manifest.repository))
        throw new Error("Managed ULW source repository changed; explicit operator reconciliation required");
      if (active?.revision === upstreamRevision) {
        activeManagedUlw(options);
      } else {
        const revisionRoot = join(root, "revisions", upstreamRevision);
        let preparedRepository: string | undefined;
        try {
          const provenance = JSON.parse(await readFile(join(revisionRoot, "provenance.json"), "utf8")) as ActiveRevision;
          if (provenance.revision !== upstreamRevision || !matchesUlwRepository(provenance.repository, manifest.repository))
            throw new Error("Existing immutable ULW revision has different provenance");
          validateManagedUlwPackage(join(revisionRoot, "package"));
          preparedRepository = provenance.repository;
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        const provenance: ActiveRevision = { revision: upstreamRevision, repository: manifest.repository, branch, preparedAt: new Date().toISOString() };
        if (!preparedRepository) {
          stage = await mkdtemp(join(root, ".stage-"));
          const source = join(stage, "source");
          const distribution = join(stage, "distribution");
          const packagePath = join(distribution, "package");
          await mkdir(packagePath, { recursive: true, mode: 0o700 });
          await git(["clone", "--no-checkout", "--no-local", manifest.repository, source]);
          await git(["fetch", "origin", upstreamRevision], source);
          await git(["checkout", "--detach", upstreamRevision], source);
          if (await git(["rev-parse", "HEAD"], source) !== upstreamRevision) throw new Error("ULW checkout revision changed while staging");
          if (active) {
            try { await git(["merge-base", "--is-ancestor", active.revision, upstreamRevision], source); }
            catch { throw new Error("ULW upstream update is not a provable fast-forward; explicit operator reconciliation required"); }
          }
          await git(["submodule", "update", "--init", "--recursive", "--depth=1"], source);
          await checkLinks(source);
          // Export tracked runtime/resources, not .git, dev node_modules, or the
          // user's checkout. Gitlinks are only build inputs for materialization.
          const archive = join(stage, "source.tar");
          await git(["archive", "--format=tar", `--output=${archive}`, "HEAD"], source);
          await run(["tar", "-xf", archive, "-C", packagePath], stage, manifest.commandTimeoutMs);
          if (manifest.materialize) {
            const materialize = resolve(source, manifest.materialize);
            if (!materialize.startsWith(source + sep)) throw new Error("ULW materializer leaves source checkout");
            await run([process.execPath, materialize, "--target-root", join(packagePath, "skills/frontend")], source, manifest.commandTimeoutMs);
          }
          const pkgPath = join(packagePath, "package.json");
          const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as PackageManifest;
          pkg.omp = { ...pkg.omp, skills: pkg.omp?.skills ?? ["./skills"] };
          await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
          if (Object.keys(pkg.dependencies ?? {}).length || Object.keys(pkg.optionalDependencies ?? {}).length) {
            await run([process.execPath, "install", "--production", "--ignore-scripts", "--frozen-lockfile"], packagePath, manifest.commandTimeoutMs);
          }
          validateManagedUlwPackage(packagePath);
          await checkLinks(packagePath);
          await probe(packagePath, stage, manifest);
          await writeFile(join(distribution, "provenance.json"), JSON.stringify(provenance, null, 2) + "\n", { mode: 0o444 });
          await immutableTree(packagePath);
          await mkdir(join(root, "revisions"), { recursive: true, mode: 0o700 });
          await rename(distribution, revisionRoot);
        }
        if (preparedRepository) {
          // A previously prepared revision may have been active before a remote
          // rewind. Do not bypass ancestry merely because its files already exist.
          stage = await mkdtemp(join(root, ".stage-"));
          if (active) {
            const source = join(stage, "ancestry");
            await git(["clone", "--no-checkout", "--no-local", manifest.repository, source]);
            await git(["fetch", "origin", upstreamRevision], source);
            try { await git(["merge-base", "--is-ancestor", active.revision, upstreamRevision], source); }
            catch { throw new Error("ULW upstream update is not a provable fast-forward; explicit operator reconciliation required"); }
          }
          await probe(join(revisionRoot, "package"), stage, manifest);
        }
        nextActive = { ...provenance, repository: preparedRepository ?? provenance.repository };
      }
      // Finish fallible staging cleanup/status publication before committing the
      // active pointer, so a failed preparation never reports a rollback after
      // it has already activated a new revision.
      if (stage) { await rm(stage, { recursive: true, force: true }); stage = undefined; }
      await atomicJson(join(root, "status.json"), { upstreamRevision, checkedAt, updating: false, error: null });
      const selected = nextActive ?? active!;
      const result: ManagedUlwStatus = { revision: selected.revision,
        packagePath: join(root, "revisions", selected.revision, "package"), upstreamRevision, checkedAt, updating: false, error: null };
      // The only activation write. Old immutable directories are never pruned:
      // running Hosts and their native children may still import from them.
      if (nextActive) await atomicJson(join(root, "active.json"), nextActive);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Managed ULW update failed";
      await atomicJson(join(root, "status.json"), { upstreamRevision, checkedAt, updating: false, error: message });
      throw new Error(`Managed ULW update failed; previous active revision retained: ${message}`, { cause: error });
    } finally {
      // Never delete an immutable revision or any path outside this invocation's
      // exclusively-created staging directory.
      if (stage) await rm(stage, { recursive: true, force: true });
      lock.exec("ROLLBACK");
    }
  } finally { lock.close(); }
}
