import { Database } from "bun:sqlite";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
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
export function validateManagedUlwPackage(packagePath: string): string {
  if (!isAbsolute(packagePath)) throw new Error("Managed ULW package must have an absolute path");
  const canonical = realpathSync(packagePath);
  const pkg = JSON.parse(readFileSync(join(canonical, "package.json"), "utf8")) as PackageManifest;
  if (pkg.name !== "omp-ulw" || !Array.isArray(pkg.omp?.extensions) || !pkg.omp.extensions.length)
    throw new Error("Managed ULW package has no native extension manifest");
  for (const entry of pkg.omp.extensions) {
    if (typeof entry !== "string" || !entry || isAbsolute(entry)) throw new Error("Invalid managed ULW extension entry");
    const target = realpathSync(resolve(canonical, entry));
    if (!target.startsWith(canonical + sep) || !lstatSync(target).isFile()) throw new Error("Managed ULW extension leaves its package");
  }
  if (!lstatSync(join(canonical, "skills")).isDirectory()) throw new Error("Managed ULW skills are missing");
  return canonical;
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
    await writeFile(join(root, "owner.json"), JSON.stringify({ owner: ownership }), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // Concurrent initialization may have created the directory just before its
    // ownership marker. Never claim a pre-existing, unmarked directory.
    for (let attempt = 0; attempt < 20; attempt++) {
      try { assertOwned(root); return; }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
      await Bun.sleep(10);
    }
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
      if (active && active.repository !== manifest.repository) throw new Error("Managed ULW source repository changed; explicit operator reconciliation required");
      if (active?.revision === upstreamRevision && active.repository === manifest.repository) {
        activeManagedUlw(options);
      } else {
        const revisionRoot = join(root, "revisions", upstreamRevision);
        let prepared = false;
        try {
          const provenance = JSON.parse(await readFile(join(revisionRoot, "provenance.json"), "utf8")) as ActiveRevision;
          if (provenance.revision !== upstreamRevision || provenance.repository !== manifest.repository)
            throw new Error("Existing immutable ULW revision has different provenance");
          validateManagedUlwPackage(join(revisionRoot, "package"));
          prepared = true;
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        const provenance: ActiveRevision = { revision: upstreamRevision, repository: manifest.repository, branch, preparedAt: new Date().toISOString() };
        if (!prepared) {
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
        if (prepared) {
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
        nextActive = provenance;
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
