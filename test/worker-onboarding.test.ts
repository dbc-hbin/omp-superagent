import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { dependencies } from "../package.json";
import { loadConfig } from "../src/config";
import { workerPackage } from "../src/remote-worker-wire";
import { releaseId, runWorkerCommand, sshRemote } from "../src/worker-setup";
import { writeStockHostExecutable } from "./fixtures/stock-host";

// The loopback "worker" is this machine: the owner binary for its own platform must exist in HEAD's package.
const ownerPlatform = process.platform === "darwin" ? "darwin" : "linux";
const ownerBinary = join(import.meta.dir, "../host-owner/bin", `omp-host-owner-${ownerPlatform}-${process.arch}`);
const describeLoopback = existsSync(ownerBinary) ? describe : describe.skip;

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

/**
 * A private HEAD home, a private worker home and a fake `ssh` on PATH that executes the remote command
 * locally as the worker account (what OpenSSH + a login shell would do), including a forced command from
 * the worker's authorized_keys for the dedicated alias. `bun install` is a shim: no network in tests.
 */
async function fixture() {
  const root = realpathSync(mkdtempSync(join(realpathSync("/tmp"), "osw-onb-")));
  const headHome = join(root, "head-home");
  const workerHome = join(root, "worker-home");
  const bin = join(root, "bin");
  const projects = join(workerHome, "projects");
  for (const path of [headHome, join(headHome, ".ssh"), workerHome, bin, projects, join(root, "head")]) mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(workerHome, 0o755);
  const real = {
    HOME: process.env.HOME, PATH: process.env.PATH, MODELS: process.env.STOCK_HOST_MODELS,
    agent: process.env.PI_CODING_AGENT_DIR,
  };
  cleanups.push(() => {
    for (const [key, value] of [["HOME", real.HOME], ["PATH", real.PATH], ["PI_CODING_AGENT_DIR", real.agent]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const bun = realpathSync(process.execPath);
  const repository = resolve(import.meta.dir, "..");
  writeFileSync(join(bin, "bun"), `#!/bin/sh
if [ "$1" = install ]; then ln -s ${repository}/node_modules node_modules; exit 0; fi
exec ${bun} "$@"
`, { mode: 0o755 });
  await writeStockHostExecutable(join(bin, "omp"), "process.exit(1);");
  const tailscale = join(root, "tailscale-ssh");
  const unreadable = join(root, "no-login");
  const plainForced = join(root, "plain-alias-forced");
  writeFileSync(join(bin, "ssh"), `#!${bun} --no-env-file
import { existsSync, readFileSync, readdirSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "-G") {
  console.log("hostname loopback.example\\nuser tester\\nport 22\\nidentityfile ~/.ssh/id_ed25519");
  process.exit(0);
}
const dash = args.indexOf("--");
if (dash < 0 || !args.includes("-T") || !args.includes("BatchMode=yes") || !args.includes("StrictHostKeyChecking=yes") || !args.includes("-a"))
  throw new Error("Unexpected ssh invocation: " + args.join(" "));
if (existsSync(${JSON.stringify(unreadable)})) { console.error("ssh: connect to host: Connection refused"); process.exit(255); }
const destination = args[dash + 1];
let command = args.slice(dash + 2).join(" ");
const workerHome = ${JSON.stringify(workerHome)};
const env = { ...process.env, HOME: workerHome, SHELL: "/bin/bash", BASH_ENV: workerHome + "/.bashrc",
  OMP_SUPERAGENT_TEST_WORKER_CONTEXT: "direct", OMP_SUPERAGENT_ROLE: "head",
  STOCK_HOST_MODELS: JSON.stringify({ models: [{ kind: "chat", selector: "worker/offered" }] }) };
delete env.PI_CODING_AGENT_DIR; delete env.OMP_PROFILE; delete env.PI_PROFILE; delete env.PI_CONFIG_FILES;
env.PATH = ${JSON.stringify([bin, dirname(bun), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter))};
if (destination.startsWith("omp-sa-") && !existsSync(${JSON.stringify(tailscale)})) {
  // sshd with authorized_keys options: the key's forced command replaces whatever was requested.
  const key = readFileSync(${JSON.stringify(headHome)} + "/.ssh/" + destination + "_ed25519.pub", "utf8").trim().split(" ")[1];
  let forced;
  try {
    const line = readFileSync(workerHome + "/.ssh/authorized_keys", "utf8").split("\\n").find(entry => entry.includes(key));
    forced = line && /command="([^"]+)"/.exec(line)?.[1];
    if (line && !/(^|,)restrict(,|\\s)/.test(line.split(" ")[0] + " ")) forced = undefined;
  } catch { /* No authorized_keys. */ }
  if (!forced) { console.error("Permission denied (publickey)."); process.exit(255); }
  env.SSH_ORIGINAL_COMMAND = command;
  command = forced;
}
if (destination === "worker-setup" && existsSync(${JSON.stringify(plainForced)}) && command === "whoami") {
  // An ordinary alias whose key happens to carry a forced command: whoami is answered by the worker.
  env.SSH_ORIGINAL_COMMAND = command;
  command = workerHome + "/.local/bin/omp-sa-worker";
}
const child = Bun.spawn(["/bin/bash", "-c", command], { env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
process.exitCode = await child.exited;
`, { mode: 0o755 });
  process.env.HOME = headHome;
  delete process.env.PI_CODING_AGENT_DIR;
  process.env.PATH = [bin, dirname(bun), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter);
  const configPath = join(root, "head", "config.json");
  const original = `{
    "stateDir": "state",
    "headCwd": ".",
    "command": ["omp"],
    "maxHosts": 2,
    "maxSubagents": 2,
    "idleMs": 1000,
    "discord": { "tokenEnv": "DISCORD_BOT_TOKEN", "ownerId": "123", "allowedGuildIds": [], "allowedChannelIds": [] }
  }
`;
  writeFileSync(configPath, original);
  // The test stand-in for the worker's /etc/ssh/ssh_host_ed25519_key.pub.
  Bun.spawnSync(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "host", "-f", join(root, "host_key")]);
  const hostKey = readFileSync(join(root, "host_key.pub"), "utf8").trim().split(" ").slice(0, 2).join(" ");
  writeFileSync(join(workerHome, ".omp-sa-test-ssh_host_ed25519_key.pub"), `${hostKey} root@worker\n`);
  const output: string[] = [];
  const io = { log: (line: string) => output.push(line), remote: sshRemote };
  const run = async (...args: string[]) => {
    output.length = 0;
    process.exitCode = 0;
    let failure = "";
    try { await runWorkerCommand([...args, "--config", configPath], io); }
    catch (error) { failure = error instanceof Error ? error.message : String(error); }
    const code = failure ? 1 : Number(process.exitCode ?? 0);
    process.exitCode = 0;
    return { text: [...output, failure].join("\n"), code };
  };
  const backups = (directory: string) => existsSync(directory) ? readdirSync(directory).filter(name => name.includes(".bak-")) : [];
  // The default state directory is too long for a socket path below the long test temp directory.
  const stateDirOnWorker = join(workerHome, "st");
  return { stateDirOnWorker, root, headHome, workerHome, projects, configPath, original, run, backups, tailscale, unreadable, plainForced, hostKey, stateDir: join(root, "head", "state") };
}

describeLoopback("worker add / doctor over a loopback ssh", () => {
  test("dry run reports every decision and changes nothing; add installs, registers and verifies; a second add changes nothing", async () => {
    const f = await fixture();
    const base = ["builder", "--ssh", "worker-setup", "--root", f.projects, "--state-dir", f.stateDirOnWorker];
    const releases = join(f.workerHome, ".local/share/omp-superagent-worker/releases");
    const id = releaseId(workerPackage());

    const dry = await f.run("add", ...base, "--dry-run");
    expect(dry.code).toBe(0);
    for (const step of ["validate", "preflight", "install", "command", "worker.json", "memory", "dedicated-key", "register", "doctor"]) {
      expect(dry.text).toContain(step);
    }
    expect(dry.text).toContain(`install release ${id}`);
    expect(dry.text).toContain("would");
    expect(existsSync(join(f.workerHome, ".local"))).toBe(false);
    expect(existsSync(join(f.workerHome, ".config"))).toBe(false);
    expect(existsSync(join(f.stateDir, "coordination.sqlite"))).toBe(false);
    expect(readFileSync(f.configPath, "utf8")).toBe(f.original);

    const added = await f.run("add", ...base);
    expect(added.text).toContain("worker doctor passed");
    expect(added.code).toBe(0);
    const worker = JSON.parse(readFileSync(join(f.workerHome, ".config/omp-superagent/worker.json"), "utf8"));
    expect(statSync(join(f.workerHome, ".config/omp-superagent/worker.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(f.workerHome, ".config/omp-superagent")).mode & 0o777).toBe(0o700);
    expect(worker).toMatchObject({ workspaceRoots: [f.projects], command: ["omp"], stateDir: f.stateDirOnWorker });
    expect(statSync(worker.stateDir).mode & 0o777).toBe(0o700);
    expect(existsSync(join(releases, id, "bin/omp-sa-worker"))).toBe(true);
    expect(realpathSync(join(releases, "current"))).toBe(join(releases, id));
    expect(readFileSync(join(f.workerHome, ".local/bin/omp-sa-worker"), "utf8")).toMatch(/^#!\/bin\/sh\nexec '.*bun' --no-env-file '.*releases\/current\/bin\/omp-sa-worker' "\$@"\n$/);
    expect(readFileSync(join(f.workerHome, ".bashrc"), "utf8")).toContain("omp-superagent worker PATH");
    expect(readFileSync(join(f.workerHome, ".omp/agent/config.yml"), "utf8")).toContain("mnemopi");
    const config = await loadConfig(f.configPath);
    expect(config.workers?.builder).toEqual({ destination: "worker-setup", workerId: worker.workerId, superkit: "managed" });
    expect(JSON.parse(readFileSync(f.configPath, "utf8")).discord.ownerId).toBe("123");
    expect(readFileSync(f.configPath, "utf8")).toContain('\n    "stateDir": "state"');
    expect(added.text).toMatch(/memory\s+OK\s+mnemopi/);
    expect(added.text).toMatch(/models\s+OK\s+1 chat models/);

    const registered = readFileSync(f.configPath, "utf8");
    // Registering the first time kept the original config; nothing else was backed up.
    expect(f.backups(join(f.root, "head")).length).toBe(1);
    expect(readFileSync(join(f.root, "head", f.backups(join(f.root, "head"))[0]!), "utf8")).toBe(f.original);
    const bashrc = readFileSync(join(f.workerHome, ".bashrc"), "utf8");
    const again = await f.run("add", ...base);
    expect(again.code).toBe(0);
    expect(again.text).toContain(`release ${id} is installed and verifies (current)`);
    expect(again.text).toContain("worker.json unchanged");
    expect(again.text).toContain("memory backend mnemopi");
    expect(again.text).toContain("already registered");
    expect(readFileSync(f.configPath, "utf8")).toBe(registered);
    expect(readFileSync(join(f.workerHome, ".bashrc"), "utf8")).toBe(bashrc);
    expect(f.backups(f.workerHome)).toEqual([]);
    expect(f.backups(join(f.workerHome, ".config/omp-superagent"))).toEqual([]);
    expect(f.backups(join(f.root, "head")).length).toBe(1);
    expect(readdirSync(releases).filter(name => !name.startsWith(".") && name !== "current")).toEqual([id]);

    const doctor = await f.run("doctor", "builder");
    expect(doctor.code).toBe(0);
    expect(doctor.text).toMatch(/compatible\s+OK/);
    // `ssh worker-setup whoami` printed the user name: an arbitrary-command destination is a warning, not a failure.
    expect(doctor.text).toMatch(/forced command\s+WARN/);
    expect(doctor.text).toContain("runs arbitrary commands");
    expect(doctor.text).toContain("authorized_keys options (command=, from=, restrict) are not enforced");
    expect(doctor.text).toContain("Tailscale SSH");
    expect(doctor.text).toContain("--dedicated-key --hostname");
    expect(doctor.text).not.toMatch(/SKIP/);
    writeFileSync(f.plainForced, "");
    const framed = await f.run("doctor", "builder");
    expect(framed.code).toBe(0);
    expect(framed.text).toMatch(/forced command\s+OK/);
    rmSync(f.plainForced);
    expect((await f.run("list")).text).toContain("builder  worker-setup");
    expect((await f.run("list")).text).toContain("last doctor");

    // Another worker name on the same account is refused, not silently rebound.
    const other = await f.run("add", "second", "--ssh", "worker-setup", "--root", f.projects, "--dry-run");
    expect(other.text).toContain('already registered here as worker "builder"');
  }, 240_000);

  test("add refuses precisely: worker owned by another HEAD, unreachable host, root missing", async () => {
    const f = await fixture();
    mkdirSync(join(f.workerHome, ".config/omp-superagent"), { recursive: true, mode: 0o700 });
    writeFileSync(join(f.workerHome, ".config/omp-superagent/worker.json"), JSON.stringify({
      workerId: "11111111-1111-4111-8111-111111111111", instance: "22222222-2222-4222-8222-222222222222",
      stateDir: join(f.workerHome, "state"), workspaceRoots: [f.projects], command: ["omp"],
    }), { mode: 0o600 });
    const base = ["builder", "--ssh", "worker-setup", "--root", f.projects, "--state-dir", f.stateDirOnWorker];
    const owned = await f.run("add", ...base, "--dry-run");
    expect(f.original).toBe(readFileSync(f.configPath, "utf8"));
    expect(owned.text).toMatch(/already belongs to HEAD instance 22222222/);

    const missing = await f.run("add", "builder", "--ssh", "worker-setup", "--root", join(f.workerHome, "nope"), "--dry-run");
    expect(missing.text).toContain("does not exist on the worker");
    writeFileSync(f.unreadable, "");
    expect((await f.run("add", ...base, "--dry-run")).text).toContain("Preflight failed");
  }, 120_000);

  test("--dedicated-key authorizes a restricted key, writes the alias and pins the host key; the forced command is enforced and doctor checks it", async () => {
    const f = await fixture();
    const base = ["edge", "--ssh", "worker-setup", "--root", f.projects, "--dedicated-key", "--hostname", "127.0.0.1", "--port", "2222", "--state-dir", f.stateDirOnWorker];
    const dry = await f.run("add", ...base, "--dry-run");
    expect(dry.text).toContain("would create ed25519 key");
    expect(dry.text).toContain("would pin the worker's ed25519 host key for [127.0.0.1]:2222");
    expect(existsSync(join(f.headHome, ".ssh/omp-sa-edge_ed25519"))).toBe(false);

    const added = await f.run("add", ...base);
    expect(added.text).not.toContain("REFUSED");
    expect(added.code).toBe(0);
    expect(added.text).toContain("forced command enforced");
    const publicKey = readFileSync(join(f.headHome, ".ssh/omp-sa-edge_ed25519.pub"), "utf8").trim();
    expect(added.text).not.toContain("PRIVATE KEY");
    const authorized = readFileSync(join(f.workerHome, ".ssh/authorized_keys"), "utf8");
    expect(authorized).toBe(`from="100.64.0.0/10,fd7a:115c:a1e0::/48",restrict,command="${f.workerHome}/.local/bin/omp-sa-worker" ${publicKey}\n`);
    expect(statSync(join(f.workerHome, ".ssh/authorized_keys")).mode & 0o777).toBe(0o600);
    const sshConfig = readFileSync(join(f.headHome, ".ssh/config"), "utf8");
    expect(sshConfig).toContain(`Host omp-sa-edge\n  HostName 127.0.0.1\n  User tester\n  Port 2222\n  IdentityFile ${f.headHome}/.ssh/omp-sa-edge_ed25519\n  IdentitiesOnly yes\n`);
    expect(readFileSync(join(f.headHome, ".ssh/known_hosts"), "utf8")).toBe(`[127.0.0.1]:2222 ${f.hostKey}\n`);
    expect((await loadConfig(f.configPath)).workers?.edge?.destination).toBe("omp-sa-edge");
    expect(added.text).toMatch(/forced command\s+OK/);

    const keyBefore = readFileSync(join(f.headHome, ".ssh/omp-sa-edge_ed25519"));
    const again = await f.run("add", ...base);
    expect(again.code).toBe(0);
    expect(again.text).toContain("worker authorized_keys unchanged");
    expect(again.text).toContain("Host omp-sa-edge matches");
    expect(again.text).toContain("known_hosts already has [127.0.0.1]:2222");
    expect(readFileSync(join(f.headHome, ".ssh/omp-sa-edge_ed25519"))).toEqual(keyBefore);
    expect(readFileSync(join(f.workerHome, ".ssh/authorized_keys"), "utf8")).toBe(authorized);
    expect(readFileSync(join(f.headHome, ".ssh/config"), "utf8")).toBe(sshConfig);
    expect(f.backups(join(f.workerHome, ".ssh"))).toEqual([]);

    // A listener that ignores authorized_keys options (Tailscale SSH) is detected by doctor and refused with the fix.
    writeFileSync(f.tailscale, "");
    const doctor = await f.run("doctor", "edge");
    expect(doctor.code).toBe(1);
    expect(doctor.text).toMatch(/forced command\s+FAIL/);
    expect(doctor.text).toContain("Tailscale SSH");
    expect(doctor.text).toContain("ListenStream=<tailnet-ip>:2222");
    expect(doctor.text).toContain("FreeBind=yes");
    expect(doctor.text).toContain("sshd -t");
  }, 240_000);

  test("add --dedicated-key refuses an address that bypasses the forced command, before registering anything", async () => {
    const f = await fixture();
    writeFileSync(f.tailscale, "");
    const base = ["edge", "--ssh", "worker-setup", "--root", f.projects, "--dedicated-key", "--hostname", "127.0.0.1", "--port", "2222", "--state-dir", f.stateDirOnWorker];
    expect((await f.run("add", ...base)).text).toContain("does not enforce its forced command");
    expect(readFileSync(f.configPath, "utf8")).toBe(f.original);
    // Setup steps that were safe and idempotent stay done; a later run on a fixed address continues from there.
    rmSync(f.tailscale);
    const fixed = await f.run("add", ...base);
    expect(fixed.code).toBe(0);
    expect((await loadConfig(f.configPath)).workers?.edge?.destination).toBe("omp-sa-edge");
  }, 240_000);
});
