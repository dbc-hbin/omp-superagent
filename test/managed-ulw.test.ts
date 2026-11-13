import { afterEach, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { activeManagedUlw, managedUlwStatus, updateManagedUlw, type UlwManifest } from "../src/managed-ulw";
import { connect, startHost, type HostOptions } from "../src/host";

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
    // A terminating Host may remove its own .launch-* directory during cleanup.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function command(args: string[], cwd: string): Promise<string> {
  const child = Bun.spawn(args, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (exit) throw new Error(`${args[0]} failed: ${stderr}`);
  return stdout.trim();
}
async function fixture() {
  const root = await mkdtemp(join(await realpath("/tmp"), "omu-"));
  cleanups.push(async () => { await writable(root); await rm(root, { recursive: true, force: true }); });
  const remote = join(root, "remote");
  const managed = join(root, "managed");
  await mkdir(remote);
  await command(["git", "init", "--initial-branch=main"], remote);
  await command(["git", "config", "user.email", "fixture@example.invalid"], remote);
  await command(["git", "config", "user.name", "Managed ULW fixture"], remote);
  await mkdir(join(remote, "skills/fixture"), { recursive: true });
  await writeFile(join(remote, "skills/fixture/SKILL.md"), "---\nname: ulw-local-fixture\ndescription: Local git install fixture.\n---\nRead only fixture.\n");
  await writeFile(join(remote, "resource.txt"), "resource-v1");
  await writeFile(join(remote, "package.json"), JSON.stringify({ name: "omp-ulw", version: "0.0.0-fixture", type: "module",
    omp: { extensions: ["./index.ts"] }, scripts: { postinstall: "exit 91", build: "exit 92" } }));
  await writeFile(join(remote, "index.ts"), "export const revision = 'v1'; export default function fixture() {}\n");
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
  return { root, remote, managed, options, first, manifest, manifestPath, commit, cli };
}

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
  await writeFile(join(f.remote, "index.ts"), "export const revision = 'v2'; export default function fixture() {}\n");
  const second = await f.commit();
  const updated = await updateManagedUlw(f.options);
  expect(updated.revision).toBe(second);
  const secondPath = activeManagedUlw(f.options);
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
  await writeFile(launcher, `import * as fs from 'node:fs'; import * as net from 'node:net';
const args=process.argv.slice(2); const value=flag=>args[args.indexOf(flag)+1];
const socket=value('--rpc-socket'); const sessionFile=value('--session');
const packagePath=process.env.OMP_SUPERAGENT_MANAGED_ULW_PATH;
fs.writeFileSync(socket+'.observed.json',JSON.stringify({packagePath,args,managedRoot:process.env.OMP_SUPERAGENT_TEST_MANAGED_ULW_ROOT}));
const server=net.createServer(peer=>{let pending='';peer.setEncoding('utf8');
peer.on('error',()=>{});peer.on('data',chunk=>{pending+=chunk;let end;
while((end=pending.indexOf('\\n'))>=0){const cmd=JSON.parse(pending.slice(0,end));pending=pending.slice(end+1);
const bytes=fs.readFileSync(packagePath+'/index.ts','utf8');
peer.write(JSON.stringify({type:'response',id:cmd.id,command:cmd.type,success:true,data:{sessionId:'fixture',sessionFile,hostPid:process.pid,sessionName:bytes}})+'\\n');}});
peer.write(JSON.stringify({type:'ready',supportedProtocolVersions:[1]})+'\\n');});
server.listen(socket,()=>fs.chmodSync(socket,0o600));`);
  const launch = async (name: string, env: Record<string, string>, managedUlwRoot?: string) => {
    const options: HostOptions = { command: [process.execPath, launcher], socketPath: join(f.root, `${name}.sock`),
      sessionFile: join(f.root, `${name}.jsonl`), cwd: f.root, extensionPath: launcher,
      managedUlwRoot, env, logPath: join(f.root, `${name}.log`), subagentConcurrency: 1 };
    const { pid } = await startHost(options);
    cleanups.push(async () => { try { process.kill(pid, "SIGKILL"); } catch {} });
    return JSON.parse(await readFile(options.socketPath + ".observed.json", "utf8")) as { packagePath: string; args: string[]; managedRoot: string };
  };
  const head = await launch("head", {}, f.managed);
  expect(head.packagePath).toBe(firstPath);
  expect(head.managedRoot).toBe(f.managed);
  await writeFile(join(f.remote, "index.ts"), "export const revision='v2'; export default function fixture() {}\n");
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
    const response = await liveHead.client.request({ type: "get_state" });
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
