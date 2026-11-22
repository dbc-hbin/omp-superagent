import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MINIMUM_WORKER_OMP } from "../src/remote-lanes";
import { workerPackage, type WorkerCapability } from "../src/remote-worker-wire";
import {
  authorizedKeysLine, blockMismatches, classifyForcedCommand, findHostBlock, keyIdentity, knownHostsName, macosDoctorRows, macosPrepareStep, mergeWorkerConfig,
  parsePreflight, parseSshG, parseWorkerArgs, planPreflight, planWorkerJson, releaseFiles, releaseId, remoteLoginNote, sshConfigBlock, sshUnreachable,
  stateDirFits, tailscaleRemedy, unenforcedWarning, ustarArchive, workerAdd, wrapperContent, workerJsonText,
  type PreflightInfo, type RemoteRunner, type WorkerJson,
} from "../src/worker-setup";
import {
  authorizedKeysScript, commandScript, installScript, macosPrepareScript, memoryScript, newNonce, parseFacts, preflightScript, sq, userSshdApplyScript,
  userSshdInspectScript, workerJsonScript,
} from "../src/worker-setup-remote";
import { listenAddress, planUserSshd, userSshdConfig, userSshdPlist, USER_SSHD_LABEL, type UserSshdDesired, type UserSshdState } from "../src/worker-user-sshd";

const INSTANCE = "33333333-3333-4333-8333-333333333333";
const OTHER_INSTANCE = "44444444-4444-4444-8444-444444444444";
const WORKER_ID = "55555555-5555-4555-8555-555555555555";
const PUBLIC_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGFsaWNlQ29tZVRvVGhlUGFydHlXaXRoQ29mZmVl omp-sa-builder";

function facts(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const base: Record<string, string | undefined> = {
    direct: "0", uname_s: "Linux", uname_m: "x86_64", user: "alice", uid: "1000", home: "/home/alice", home_real: "/home/alice",
    login_shell: "/bin/bash", user_manager: "running", linger: "yes", "root.0": "/home/alice/projects",
    omp_path: "/home/alice/.bun/bin/omp", omp_version: `omp/${MINIMUM_WORKER_OMP}`, bun_path: "/home/alice/.bun/bin/bun",
    bun_version: "1.4.4", git_version: "git version 2.43.0", models_chat: "4", release_current: "",
  };
  return Object.fromEntries(Object.entries({ ...base, ...overrides }).filter((entry): entry is [string, string] => entry[1] !== undefined));
}
const info = (overrides: Record<string, string | undefined> = {}, roots = ["/home/alice/projects"]): PreflightInfo => parsePreflight(facts(overrides), roots);

describe("worker command line", () => {
  const add = ["add", "builder", "--ssh", "builder-setup", "--root", "/srv/a", "--root", "/srv/b/", "--config", "/tmp/c.json"];

  test("parses add with repeatable roots and the dedicated-key defaults", () => {
    expect(parseWorkerArgs(add)).toMatchObject({
      kind: "add", name: "builder", ssh: "builder-setup", roots: ["/srv/a", "/srv/b"], dedicatedKey: false, superkit: "managed",
      dryRun: false, replace: false, configPath: "/tmp/c.json", from: "100.64.0.0/10,fd7a:115c:a1e0::/48",
    });
    const dedicated = parseWorkerArgs([...add, "--dedicated-key", "--hostname", "100.64.0.9", "--port", "2222", "--dry-run"]);
    expect(dedicated).toMatchObject({ dedicatedKey: true, hostname: "100.64.0.9", port: 2222, dryRun: true, from: "100.64.0.0/10,fd7a:115c:a1e0::/48" });
    expect(parseWorkerArgs([...add, "--dedicated-key", "--from", "any"])).toMatchObject({ from: null });
    expect(parseWorkerArgs([...add, "--dedicated-key", "--from", "10.0.0.0/8,192.0.2.1"])).toMatchObject({ from: "10.0.0.0/8,192.0.2.1" });
    expect(parseWorkerArgs([...add, "--dedicated-key", "--hostname", "100.64.0.9", "--port", "2222", "--user-sshd"])).toMatchObject({ dedicatedKey: true, userSshd: true });
    expect(parseWorkerArgs([...add, "--dedicated-key"])).toMatchObject({ userSshd: false });
    expect(parseWorkerArgs(["doctor", "builder", "--config", "/tmp/c.json"])).toEqual({ kind: "doctor", name: "builder", configPath: "/tmp/c.json" });
    expect(parseWorkerArgs(["list", "--config", "/tmp/c.json"])).toEqual({ kind: "list", configPath: "/tmp/c.json" });
  });

  test("rejects malformed invocations", () => {
    const bad = (args: string[]) => expect(() => parseWorkerArgs(args)).toThrow();
    bad([]);
    bad(["remove", "x", "--config", "c"]);
    bad(["add", "builder", "--root", "/srv/a", "--config", "c"]);
    bad(["add", "builder", "--ssh", "h", "--config", "c"]);
    bad(["add", "-bad", "--ssh", "h", "--root", "/srv/a", "--config", "c"]);
    bad(["add", "builder", "--ssh", "-oProxyCommand=x", "--root", "/srv/a", "--config", "c"]);
    bad(["add", "builder", "--ssh", "h", "--root", "relative", "--config", "c"]);
    bad(["add", "builder", "--ssh", "h", "--root", "/", "--config", "c"]);
    bad([...add, "--superkit", "maybe"]);
    bad([...add, "--from", "any"]);
    bad([...add, "--port", "2222"]);
    bad([...add, "--dedicated-key", "--port", "70000"]);
    bad([...add, "--dedicated-key", "--from", 'a"b']);
    bad([...add, "--ssh", "other"]);
    // --user-sshd serves the dedicated alias: it needs the key, the tailnet address, an unprivileged port.
    bad([...add, "--user-sshd"]);
    bad([...add, "--dedicated-key", "--port", "2222", "--user-sshd"]);
    bad([...add, "--dedicated-key", "--hostname", "100.64.0.9", "--user-sshd"]);
    bad([...add, "--dedicated-key", "--hostname", "100.64.0.9", "--port", "22", "--user-sshd"]);
    bad(["doctor", "--config", "c"]);
    bad(["list", "extra", "--config", "c"]);
  });
});

describe("preflight planning", () => {
  test("a ready Linux account passes and names the native Host owner to ship", () => {
    const plan = planPreflight(info());
    expect(plan.refusals).toEqual([]);
    expect(plan.ownerBinary).toBe("omp-host-owner-linux-x64");
    expect(planPreflight(info({ uname_m: "aarch64" })).ownerBinary).toBe("omp-host-owner-linux-arm64");
    expect(planPreflight(info({ git_version: undefined })).warnings.join(" ")).toContain("git");
  });

  test("each unsupported condition is refused with its own precise reason", () => {
    const reasons = (overrides: Record<string, string | undefined>, roots?: string[]) => planPreflight(info(overrides, roots)).refusals.join("\n");
    expect(reasons({ uname_s: "FreeBSD" })).toContain("FreeBSD workers are not supported; remote workers currently require Linux with a systemd user manager or macOS");
    expect(planPreflight(info({ uname_s: "FreeBSD" })).ownerBinary).toBeNull();
    expect(reasons({ user_manager: "" })).toContain("no running systemd user manager");
    expect(reasons({ user_manager: "degraded" })).toBe("");
    expect(reasons({ linger: "no" })).toContain("loginctl enable-linger alice");
    expect(reasons({ omp_path: "", omp_version: "" })).toContain("OMP is not on the account's login-shell PATH");
    expect(reasons({ omp_version: "omp/0.0.1" })).toContain(`older than the required ${MINIMUM_WORKER_OMP}`);
    expect(reasons({ models_chat: "0" })).toContain("no chat models");
    expect(reasons({ models_chat: "" })).toContain("no chat models");
    expect(reasons({ bun_path: "", bun_version: "" })).toContain("bun is not on the account's login-shell PATH");
    expect(reasons({ uname_m: "riscv64" })).toContain("unsupported worker architecture riscv64");
    expect(reasons({ home_real: "/home/al ice" })).toContain("home directory");
    expect(reasons({ "root.0": "!missing" })).toContain("--root /home/alice/projects does not exist on the worker");
    expect(reasons({ "root.0": "!notdir" })).toContain("is not a directory");
  });

  test("a macOS account needs its GUI session and the Command Line Tools, found without running cc", () => {
    const mac = { uname_s: "Darwin", uname_m: "arm64", user: "worker", uid: "501", home: "/Users/worker", home_real: "/Users/worker", login_shell: "/bin/zsh",
      user_manager: undefined, linger: undefined, gui_domain: "yes", developer_tools: "yes", "root.0": "/Users/worker/projects" };
    const reasons = (overrides: Record<string, string | undefined> = {}) => planPreflight(info({ ...mac, ...overrides }, ["/Users/worker/projects"])).refusals.join("\n");
    expect(planPreflight(info(mac, ["/Users/worker/projects"]))).toMatchObject({ refusals: [], ownerBinary: "omp-host-owner-darwin-arm64" });
    expect(planPreflight(info({ ...mac, uname_m: "x86_64" }, ["/Users/worker/projects"])).ownerBinary).toBe("omp-host-owner-darwin-x64");
    // No Linux user manager facts are asked of a Mac, and none of the Mac's facts of a Linux box.
    expect(reasons()).toBe("");
    expect(reasons({ gui_domain: "no" })).toContain("the account worker has no GUI login session (launchctl print gui/501 failed): log in at the Mac's desktop as that account and stay logged in");
    expect(reasons({ gui_domain: undefined })).toContain("no GUI login session");
    expect(reasons({ developer_tools: undefined })).toContain("install Xcode Command Line Tools (xcode-select --install) once at the Mac");
    expect(reasons({ gui_domain: "no", developer_tools: undefined }).split("\n")).toHaveLength(2);
    expect(parsePreflight(facts(mac), []).loginShell).toBe("/bin/zsh");
    expect(parsePreflight(facts({ ...mac, "path_marker.zshenv": "yes" }), []).pathMarkers).toEqual([".zshenv"]);
    expect(parsePreflight(facts(mac), []).pathMarkers).toEqual([]);
  });

  test("the loopback test context runs the same checks on the machine's own platform", () => {
    // Neither a user manager nor a GUI session is required of the fixture's own machine.
    const plan = planPreflight(info({ direct: "1", uname_s: "Darwin", uname_m: "arm64", user_manager: undefined, linger: undefined }));
    expect(plan.refusals).toEqual([]);
    expect(plan.ownerBinary).toBe("omp-host-owner-darwin-arm64");
    expect(planPreflight(info({ direct: "1", user_manager: undefined, linger: undefined })).refusals).toEqual([]);
  });

  test("facts are read only from lines carrying the run's nonce", () => {
    const nonce = newNonce();
    const parsed = parseFacts(`motd noise\n@@${nonce} user alice\n@@other user mallory\n@@${nonce} log one\n@@${nonce} log two\n@@${nonce} empty \r\n`, nonce);
    expect(parsed).toEqual({ user: "alice", log: "one\ntwo", empty: "" });
    const worker = parsePreflight(facts({ worker_json: Buffer.from(JSON.stringify({ workerId: WORKER_ID, instance: INSTANCE, stateDir: "/s", workspaceRoots: ["/r"], command: ["omp"] })).toString("base64") }), []);
    expect(worker.workerJson).toMatchObject({ workerId: WORKER_ID, instance: INSTANCE });
    expect(parsePreflight(facts({ worker_json: Buffer.from("{").toString("base64") }), []).workerJson).toBe("invalid");
    expect(parsePreflight(facts({ authorized_keys_file: "none" }), []).authorizedKey).toBe("no-file");
    expect(parsePreflight(facts({ release_package: JSON.stringify(workerPackage()), release_present: "yes" }), []).releasePackage).toEqual(workerPackage());
  });
});

describe("worker.json and config planning", () => {
  const existing: WorkerJson = {
    workerId: WORKER_ID, instance: INSTANCE, stateDir: "/home/alice/.local/state/omp-superagent-worker",
    workspaceRoots: ["/home/alice/projects", "/home/alice/old"], command: ["omp"],
  };
  const input = (overrides: Partial<Parameters<typeof planWorkerJson>[0]> = {}) => ({
    existing: null, instance: INSTANCE, configured: undefined, otherWorkers: new Map<string, string>(), replace: false,
    stateDir: undefined, homeReal: "/home/alice", roots: ["/home/alice/projects"], ...overrides,
  });

  test("creates a fresh worker.json with a new id and the default private state directory", () => {
    const plan = planWorkerJson(input());
    expect(plan).toMatchObject({ decision: "create", refusal: null });
    expect(plan.desired).toMatchObject({ instance: INSTANCE, stateDir: "/home/alice/.local/state/omp-superagent-worker", workspaceRoots: ["/home/alice/projects"], command: ["omp"] });
    expect(plan.desired.workerId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("re-running keeps the identity and is unchanged; changed roots report what is removed", () => {
    const same = planWorkerJson(input({ existing, roots: existing.workspaceRoots }));
    expect(same).toMatchObject({ decision: "unchanged", refusal: null });
    expect(same.desired.workerId).toBe(WORKER_ID);
    const fewer = planWorkerJson(input({ existing }));
    expect(fewer.decision).toBe("update");
    expect(fewer.notes.join(" ")).toContain("/home/alice/old");
    expect(fewer.desired.workerId).toBe(WORKER_ID);
  });

  test("a worker that belongs to another HEAD or has an unreadable file is refused unless --replace", () => {
    const foreign = { ...existing, instance: OTHER_INSTANCE };
    expect(planWorkerJson(input({ existing: foreign })).refusal).toContain(`HEAD instance ${OTHER_INSTANCE}`);
    expect(planWorkerJson(input({ existing: "invalid" })).refusal).toContain("not a valid provisioning file");
    const replaced = planWorkerJson(input({ existing: foreign, replace: true }));
    expect(replaced.refusal).toBeNull();
    expect(replaced.desired).toMatchObject({ instance: INSTANCE, stateDir: foreign.stateDir });
    expect(replaced.desired.workerId).not.toBe(WORKER_ID);
  });

  test("HEAD's registered id wins; another name's account is never silently rebound", () => {
    const configured = { destination: "builder", workerId: "66666666-6666-4666-8666-666666666666", superkit: "managed" as const };
    const plan = planWorkerJson(input({ existing, configured }));
    expect(plan.desired.workerId).toBe(configured.workerId);
    expect(plan.notes.join(" ")).toContain("workerId changes");
    expect(planWorkerJson(input({ existing, otherWorkers: new Map([[WORKER_ID, "other"]]) })).refusal).toContain('worker "other"');
  });

  test("state directory moves need --replace and must fit a Unix socket path", () => {
    expect(planWorkerJson(input({ existing, stateDir: "/home/alice/state" })).refusal).toContain("needs --replace");
    expect(planWorkerJson(input({ existing, stateDir: "/home/alice/state", replace: true })).refusal).toBeNull();
    expect(stateDirFits("/home/alice/.local/state/omp-superagent-worker")).toBe(true);
    const long = `/home/${"a".repeat(30)}/.local/state/omp-superagent-worker`;
    expect(stateDirFits(long)).toBe(false);
    expect(planWorkerJson(input({ homeReal: `/home/${"a".repeat(30)}` })).refusal).toContain("--state-dir");
    expect(workerJsonText(existing).endsWith("}\n")).toBe(true);
  });

  test("the wrapper execs the worker's own bun on the current release", () => {
    expect(wrapperContent("/home/alice", "/home/alice/.bun/bin/bun")).toBe(
      `#!/bin/sh\nexec '/home/alice/.bun/bin/bun' --no-env-file '/home/alice/.local/share/omp-superagent-worker/releases/current/bin/omp-sa-worker' "$@"\n`);
  });

  test("registering keeps every other key, key order, indentation and the final newline", () => {
    const raw = `{\n\t"stateDir": "state",\n\t"command": ["omp"],\n\t"discord": {"tokenEnv": "T"},\n\t"maxHosts": 2\n}\n`;
    const entry = { destination: "builder", workerId: WORKER_ID, superkit: "managed" as const };
    const added = mergeWorkerConfig(raw, "builder", entry);
    expect(added.changed).toBe(true);
    expect(Object.keys(JSON.parse(added.text))).toEqual(["stateDir", "command", "discord", "maxHosts", "workers"]);
    expect(added.text.startsWith('{\n\t"stateDir": "state"')).toBe(true);
    expect(added.text.endsWith("}\n")).toBe(true);
    expect(JSON.parse(added.text).workers.builder).toEqual(entry);
    const again = mergeWorkerConfig(added.text, "builder", entry);
    expect(again).toMatchObject({ changed: false, text: added.text });
    const updated = mergeWorkerConfig(added.text, "builder", { ...entry, destination: "omp-sa-builder" });
    expect(updated).toMatchObject({ changed: true, previous: entry });
    const second = mergeWorkerConfig(updated.text, "other", { ...entry, destination: "other", workerId: OTHER_INSTANCE });
    expect(Object.keys(JSON.parse(second.text).workers)).toEqual(["builder", "other"]);
    expect(mergeWorkerConfig(`{"a":1}`, "w", entry).text).toBe(`{\n  "a": 1,\n  "workers": {\n    "w": ${JSON.stringify(entry, null, 2).replace(/\n/g, "\n    ")}\n  }\n}`);
  });
});

describe("dedicated key SSH material", () => {
  test("authorized_keys line carries the tailnet from= list by default, restrict and the forced command", () => {
    const command = "/home/alice/.local/bin/omp-sa-worker";
    expect(authorizedKeysLine(command, `${PUBLIC_KEY}\n`, "100.64.0.0/10,fd7a:115c:a1e0::/48")).toBe(
      `from="100.64.0.0/10,fd7a:115c:a1e0::/48",restrict,command="${command}" ${PUBLIC_KEY}`);
    expect(authorizedKeysLine(command, PUBLIC_KEY, null)).toBe(`restrict,command="${command}" ${PUBLIC_KEY}`);
    expect(() => authorizedKeysLine('/home/a"b/x', PUBLIC_KEY, null)).toThrow("Unsupported worker command path");
    expect(() => authorizedKeysLine(command, "ssh-rsa AAAA x", null)).toThrow("ssh-ed25519");
    expect(() => authorizedKeysLine(command, `${PUBLIC_KEY}\nrestrict ssh-ed25519 AAAA evil`, null)).toThrow();
    expect(keyIdentity(PUBLIC_KEY)).toBe("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGFsaWNlQ29tZVRvVGhlUGFydHlXaXRoQ29mZmVl");
  });

  test("ssh -G output yields the host to copy; the alias block pins the identity", () => {
    const host = parseSshG("user alice\nhostname 192.0.2.7\nport 2200\nproxyjump none\nidentityfile ~/.ssh/id_ed25519\nhostname ignored\n");
    expect(host).toEqual({ hostname: "192.0.2.7", user: "alice", port: 2200, proxyJump: null });
    expect(parseSshG("user a\nhostname h\nport 22\nproxyjump bastion\n").proxyJump).toBe("bastion");
    expect(() => parseSshG("port 22\n")).toThrow("HostName and User");
    const block = sshConfigBlock("builder", { ...host, hostname: "100.64.0.9", port: 2222 }, "/home/op/.ssh/omp-sa-builder_ed25519");
    expect(block).toBe([
      "# omp-superagent worker builder (managed by omp-sa worker add)", "Host omp-sa-builder", "  HostName 100.64.0.9", "  User alice",
      "  Port 2222", "  IdentityFile /home/op/.ssh/omp-sa-builder_ed25519", "  IdentitiesOnly yes", "  StrictHostKeyChecking yes", "  BatchMode yes", "",
    ].join("\n"));
    expect(knownHostsName("100.64.0.9", 2222)).toBe("[100.64.0.9]:2222");
    expect(knownHostsName("worker.example", 22)).toBe("worker.example");
  });

  test("an existing alias block is found, recognized as managed, and compared field by field", () => {
    const host = { hostname: "100.64.0.9", user: "alice", port: 2222, proxyJump: null };
    const identity = "/home/op/.ssh/omp-sa-builder_ed25519";
    const config = `Host *\n  ServerAliveInterval 30\n\n${sshConfigBlock("builder", host, identity)}\nHost other\n  HostName x\n`;
    const block = findHostBlock(config, "omp-sa-builder")!;
    expect(block.managed).toBe(true);
    expect(blockMismatches(block, host, identity)).toEqual([]);
    expect(blockMismatches(block, { ...host, port: 22 }, identity)).toEqual(["Port is 2222, expected 22"]);
    expect(blockMismatches(block, { ...host, user: "bob" }, "/other/key").join(";")).toContain("User is alice, expected bob");
    expect(findHostBlock(config, "omp-sa-missing")).toBeNull();
    const manual = findHostBlock("Host omp-sa-builder\n  HostName 100.64.0.9\n  User alice\n", "omp-sa-builder")!;
    expect(manual.managed).toBe(false);
    expect(blockMismatches(manual, host, identity).join(";")).toContain("IdentitiesOnly is unset");
  });

  test("a forced command is enforced only when the answer is a worker protocol frame", () => {
    expect(classifyForcedCommand(`{"protocol":"omp-sa-worker-2","workerId":"x","instance":"y","error":"closed"}\n`)).toBe("enforced");
    expect(classifyForcedCommand("alice\n")).toBe("bypassed");
    expect(classifyForcedCommand(`{"protocol":"something-else"}\n`)).toBe("bypassed");
    expect(classifyForcedCommand("")).toBe("unclear");
    const remedy = tailscaleRemedy("omp-sa-builder");
    for (const text of ["Tailscale SSH", "ssh.socket.d/omp-sa.conf", "ListenStream=<tailnet-ip>:2222", "FreeBind=yes", "sshd_config.d/omp-sa.conf",
      "ListenAddress <tailnet-ip>:2222", "sshd -t", "--hostname", "--port 2222", "never changes sshd"]) expect(remedy).toContain(text);
    expect(remedy).not.toMatch(/100\.64\.\d/);
    const warning = unenforcedWarning("worker-setup");
    for (const text of ["runs arbitrary commands", "command=, from=, restrict", "Tailscale SSH", "ListenStream=<tailnet-ip>:2222", "sshd -t",
      "--dedicated-key --hostname <tailnet-ip-or-name> --port"]) expect(warning).toContain(text);
  });
});

describe("release archive and remote scripts", () => {
  const scratch = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "osw-rel-"));
    for (const [path, content] of Object.entries({
      "package.json": "{}", "bun.lock": "lock", "bin/omp-sa-worker": "#!/usr/bin/env bun\n", "upstream/ulw.json": "{}",
      "host-owner/bin/omp-host-owner-linux-x64": "ELF", "host-owner/bin/omp-host-owner-linux-arm64": "other arch",
      "src/a/b.ts": "export {}", "src/.hidden": "kept: digested too", "skills/head/SKILL.md": "# skill", "docs/skip.md": "no", "test/skip.ts": "no",
    })) {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    Bun.spawnSync(["chmod", "755", join(dir, "bin/omp-sa-worker"), join(dir, "host-owner/bin/omp-host-owner-linux-x64")]);
    return dir;
  };

  test("ships exactly the runtime files and only the worker's native owner", () => {
    const dir = scratch();
    try {
      const { files, lockfile } = releaseFiles(dir, "omp-host-owner-linux-x64");
      expect(lockfile).toBe(true);
      expect(files.map(file => file.path)).toEqual(["bin/omp-sa-worker", "bun.lock", "host-owner/bin/omp-host-owner-linux-x64", "package.json",
        "skills/head/SKILL.md", "src/.hidden", "src/a/b.ts", "upstream/ulw.json"]);
      expect(files.find(file => file.path === "bin/omp-sa-worker")!.mode).toBe(0o755);
      expect(files.find(file => file.path === "package.json")!.mode).toBe(0o644);
      rmSync(join(dir, "bun.lock"));
      expect(releaseFiles(dir, "omp-host-owner-linux-x64").lockfile).toBe(false);
      expect(() => releaseFiles(dir, "omp-host-owner-linux-riscv64")).toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("the archive is deterministic and extracts byte-for-byte with the system tar, including long paths", () => {
    const deep = `src/${"d".repeat(60)}/${"e".repeat(60)}/file.ts`;
    const files = [
      { path: "package.json", data: Buffer.from('{"a":1}'), mode: 0o644 },
      { path: "bin/omp-sa-worker", data: Buffer.alloc(1000, 7), mode: 0o755 },
      { path: deep, data: Buffer.alloc(512, 1), mode: 0o644 },
      { path: "empty", data: Buffer.alloc(0), mode: 0o644 },
    ];
    const archive = ustarArchive(files);
    expect(ustarArchive(files).equals(archive)).toBe(true);
    expect(archive.length % 512).toBe(0);
    const out = mkdtempSync(join(tmpdir(), "osw-tar-"));
    try {
      const tar = Bun.spawnSync(["tar", "-xf", "-", "-C", out], { stdin: archive });
      expect(tar.exitCode).toBe(0);
      expect(readFileSync(join(out, "package.json"), "utf8")).toBe('{"a":1}');
      expect(readFileSync(join(out, deep)).equals(files[2]!.data)).toBe(true);
      expect(readFileSync(join(out, "bin/omp-sa-worker")).equals(files[1]!.data)).toBe(true);
      expect(Bun.spawnSync(["test", "-x", join(out, "bin/omp-sa-worker")]).exitCode).toBe(0);
    } finally { rmSync(out, { recursive: true, force: true }); }
    expect(() => ustarArchive([{ path: "x".repeat(300), data: Buffer.alloc(0), mode: 0o644 }])).toThrow("too long");
    expect(releaseId({ version: "1.2.3", digest: "abcdef0123456789" })).toBe("1.2.3-abcdef012345");
  });

  test("every generated remote script is valid POSIX sh and quotes operator values", () => {
    const nonce = newNonce();
    const hostile = "/srv/it's a \"root\" $(touch pwned)";
    expect(sq("it's")).toBe(`'it'\\''s'`);
    const scripts = {
      preflight: preflightScript({ nonce, roots: [hostile, "/srv/b"], releaseId: "0.1.6-abcdef012345", authorizedKey: PUBLIC_KEY }),
      preflightNoKey: preflightScript({ nonce, roots: ["/srv/a"], releaseId: "0.1.6-abcdef012345", authorizedKey: null }),
      install: installScript({ nonce, releaseId: "0.1.6-abcdef012345", version: "0.1.6", digest: "d".repeat(64), tarSha256: "e".repeat(64), frozen: true }),
      command: commandScript({ nonce, wrapper: wrapperContent("/home/alice", "/home/alice/.bun/bin/bun"), pathFile: ".bashrc" }),
      commandZsh: commandScript({ nonce, wrapper: wrapperContent("/Users/worker", "/Users/worker/.bun/bin/bun"), pathFile: ".zshenv" }),
      commandNoRc: commandScript({ nonce, wrapper: "#!/bin/sh\n", pathFile: null }),
      macosPrepare: macosPrepareScript({ nonce, bun: "/Users/o'brien/.bun/bin/bun", release: "0.1.6-abcdef012345", scope: JSON.stringify({ stateDir: "/Users/o'brien/s", workspaceRoots: [hostile] }) }),
      workerJson: workerJsonScript({ nonce, content: workerJsonText({ workerId: WORKER_ID, instance: INSTANCE, stateDir: "/s", workspaceRoots: [hostile], command: ["omp"] }), stateDir: "/home/alice/s" }),
      memoryInspect: memoryScript({ nonce, release: "current", cwd: "/srv/a", consent: null, agentDir: null }),
      memoryApply: memoryScript({ nonce, release: "0.1.6-abcdef012345", cwd: "/srv/a", consent: '{"status":"missing"}', agentDir: "/home/alice/.omp/agent" }),
      authorizedKeys: authorizedKeysScript({ nonce, line: `restrict,command="/x" ${PUBLIC_KEY}`, key: keyIdentity(PUBLIC_KEY) }),
      sshdInspect: userSshdInspectScript({ nonce, label: USER_SSHD_LABEL }),
      sshdApply: userSshdApplyScript({ nonce, label: USER_SSHD_LABEL, config: userSshdConfig(SSHD), plist: userSshdPlist(SSHD), port: 2222, action: "reload" }),
      sshdApplyNone: userSshdApplyScript({ nonce, label: USER_SSHD_LABEL, config: "# it's\n", plist: "<plist/>", port: 2222, action: "none" }),
    };
    for (const [name, script] of Object.entries(scripts)) {
      const check = Bun.spawnSync(["sh", "-n"], { stdin: Buffer.from(script) });
      expect(`${name}: ${check.stderr.toString()}`).toBe(`${name}: `);
    }
    expect(scripts.preflight).not.toContain("PRIVATE");
    expect(scripts.preflight).toContain(sq(hostile));
    expect(scripts.install).toContain("--ignore-scripts --production");
    expect(scripts.install).toContain("--frozen-lockfile");
    expect(scripts.memoryInspect).toContain("--no-install");
    // The Mac's non-interactive zsh reads ~/.zshenv, never ~/.bashrc; the block is the same guarded one.
    expect(scripts.commandZsh).toContain('RC="$HOME_REAL"/\'.zshenv\'');
    expect(scripts.commandZsh).not.toContain(".bashrc");
    expect(scripts.command).toContain('RC="$HOME_REAL"/\'.bashrc\'');
    expect(scripts.commandNoRc).not.toContain("RC=");
    expect(scripts.preflight).toContain('emit gui_domain "$(/bin/launchctl print "gui/$(id -u)"');
    expect(scripts.preflight).toContain("xcode-select -p");
    expect(scripts.preflight).toContain('[ -x "$DEV/usr/bin/cc" ]');
    expect(scripts.macosPrepare).toContain("--prepare");
    expect(scripts.macosPrepare).toContain(sq("/Users/o'brien/.bun/bin/bun"));
    expect(scripts.sshdApply).toContain(sq(userSshdConfig(SSHD)));
    expect(scripts.sshdApplyNone).toContain(sq("# it's\n"));
    expect(scripts.sshdApply).toContain('/usr/sbin/sshd -t -f "$D/.sshd_config.$$"');
    expect(scripts.sshdApply).not.toContain("sudo");
  });
});

const SSHD: UserSshdDesired = { home: "/Users/worker", user: "worker", listen: [listenAddress("100.64.0.9", 2222)] };

describe("user sshd", () => {
  test("the config and LaunchAgent are exactly the verified recipe", () => {
    expect(userSshdConfig(SSHD).split("\n").filter(line => line && !line.startsWith("#"))).toEqual([
      "ListenAddress 100.64.0.9:2222",
      "HostKey /Users/worker/.omp-sa-sshd/ssh_host_ed25519_key",
      "PidFile /Users/worker/.omp-sa-sshd/sshd.pid",
      "AuthorizedKeysFile .ssh/authorized_keys",
      "PasswordAuthentication no", "KbdInteractiveAuthentication no", "UsePAM no", "PermitRootLogin no",
      "AllowUsers worker", "UseDNS no", "StrictModes yes",
    ]);
    expect(userSshdConfig({ ...SSHD, listen: ["100.64.0.9:2222", listenAddress("fd7a:115c:a1e0::9", 2222)] })).toContain("ListenAddress [fd7a:115c:a1e0::9]:2222\n");
    expect(listenAddress("host.tail.ts.net", 2222)).toBe("host.tail.ts.net:2222");
    const plist = userSshdPlist(SSHD);
    expect(plist).toContain(`<key>Label</key>\n\t<string>${USER_SSHD_LABEL}</string>`);
    expect(plist).toContain(["/usr/sbin/sshd", "-D", "-f", "/Users/worker/.omp-sa-sshd/sshd_config", "-E", "/Users/worker/.omp-sa-sshd/sshd.log"]
      .map(entry => `<string>${entry}</string>`).join("\n\t\t"));
    for (const fragment of ["<key>RunAtLoad</key>\n\t<true/>", "<key>KeepAlive</key>\n\t<true/>", "<key>ThrottleInterval</key>\n\t<integer>30</integer>"]) expect(plist).toContain(fragment);
    expect(userSshdPlist({ ...SSHD, home: "/Users/a&b" })).toContain("/Users/a&amp;b/.omp-sa-sshd/sshd_config");
  });

  const current = (overrides: Partial<UserSshdState> = {}): UserSshdState => ({
    config: userSshdConfig(SSHD), plist: userSshdPlist(SSHD), hostKey: "ssh-ed25519 AAAA", launchd: "running", ...overrides,
  });

  test("a matching running agent is left alone; anything else is repaired with the least restart", () => {
    expect(planUserSshd(current(), SSHD)).toEqual({ config: "unchanged", plist: "unchanged", hostKey: "keep", launchd: "none" });
    expect(planUserSshd({ config: null, plist: null, hostKey: null, launchd: null }, SSHD))
      .toEqual({ config: "create", plist: "create", hostKey: "create", launchd: "bootstrap" });
    // A different config is rewritten and read by restarting the loaded agent.
    expect(planUserSshd(current({ config: userSshdConfig({ ...SSHD, listen: ["100.64.0.9:2300"] }) }), SSHD))
      .toEqual({ config: "update", plist: "unchanged", hostKey: "keep", launchd: "kickstart" });
    // A changed plist is only read by launchd on a fresh bootstrap.
    expect(planUserSshd(current({ plist: userSshdPlist({ ...SSHD, home: "/Users/other" }) }), SSHD).launchd).toBe("reload");
    // Matching files with a stopped or crash-looping agent: restart; not loaded at all: load.
    expect(planUserSshd(current({ launchd: "waiting" }), SSHD).launchd).toBe("kickstart");
    expect(planUserSshd(current({ launchd: null }), SSHD).launchd).toBe("bootstrap");
    expect(planUserSshd(current({ hostKey: null }), SSHD)).toMatchObject({ hostKey: "create", launchd: "none" });
  });
});

const macFacts = {
  uname_s: "Darwin", uname_m: "arm64", user: "worker", uid: "501", home: "/Users/worker", home_real: "/Users/worker", login_shell: "/bin/zsh",
  user_manager: undefined, linger: undefined, gui_domain: "yes", developer_tools: "yes",
  omp_path: "/Users/worker/.bun/bin/omp", bun_path: "/Users/worker/.bun/bin/bun",
};
const MAC_ROOTS = ["/Users/worker/projects", "/Users/worker/Documents/code"];
const macInfo = (overrides: Record<string, string | undefined> = {}) =>
  parsePreflight(facts({ ...macFacts, "root.0": MAC_ROOTS[0], "root.1": MAC_ROOTS[1], ...overrides }), MAC_ROOTS);

/** A Mac that answers only the setup connection's preflight and PATH probe (a dry run changes nothing). */
function fakeMac(overrides: Record<string, string | undefined> = {}, behavior: { unreachable?: boolean; sshd?: Record<string, string> } = {}) {
  const calls: string[] = [];
  const remote: RemoteRunner = async (_destination, command, stdin) => {
    calls.push(command);
    if (behavior.unreachable) return { code: 255, stdout: "", stderr: "ssh: connect to host mac.example port 22: Connection refused\n" };
    if (command === "sh -s" && typeof stdin === "string" && stdin.includes("emit uname_s")) {
      const nonce = /^NONCE=(\w+)$/m.exec(stdin)![1];
      const lines = Object.entries(facts({ ...macFacts, "root.0": MAC_ROOTS[0], "root.1": MAC_ROOTS[1], ...overrides })).map(([key, value]) => `@@${nonce} ${key} ${value}`);
      return { code: 0, stdout: `Last login: noise\n${lines.join("\n")}\n`, stderr: "" };
    }
    if (command === "sh -s" && behavior.sshd && typeof stdin === "string" && stdin.includes("emit sshd_binary")) {
      const nonce = /^NONCE=(\w+)$/m.exec(stdin)![1];
      return { code: 0, stdout: Object.entries(behavior.sshd).map(([key, value]) => `@@${nonce} ${key} ${value}`).join("\n"), stderr: "" };
    }
    if (command.includes('printf %s "$PATH"')) return { code: 0, stdout: "/usr/bin:/bin:/usr/sbin:/sbin", stderr: "" };
    throw new Error(`a dry run sent an unexpected command: ${command}`);
  };
  return { calls, remote };
}

const hasDarwinOwner = existsSync(new URL("../host-owner/bin/omp-host-owner-darwin-arm64", import.meta.url).pathname);

describe("macOS onboarding", () => {
  const dry = async (overrides: Record<string, string | undefined> = {}, behavior: { unreachable?: boolean; sshd?: Record<string, string> } = {}, extra: string[] = []) => {
    const root = mkdtempSync(join(tmpdir(), "osw-mac-"));
    const configPath = join(root, "config.json");
    writeFileSync(configPath, JSON.stringify({ stateDir: "state", headCwd: ".", command: ["omp"], maxHosts: 2, maxSubagents: 2, idleMs: 1000,
      discord: { tokenEnv: "DISCORD_BOT_TOKEN", ownerId: "1", allowedGuildIds: [], allowedChannelIds: [] } }));
    const mac = fakeMac(overrides, behavior);
    const output: string[] = [];
    let failure = "";
    try {
      const command = parseWorkerArgs(["add", "mac", "--ssh", "mac-setup", ...MAC_ROOTS.flatMap(path => ["--root", path]), "--dry-run", "--config", configPath, ...extra]);
      if (command.kind !== "add") throw new Error("not an add command");
      await workerAdd(command, { log: line => output.push(line), remote: mac.remote });
    } catch (error) { failure = error instanceof Error ? error.message : String(error); }
    rmSync(root, { recursive: true, force: true });
    return { text: [...output, failure].join("\n"), calls: mac.calls };
  };

  test.skipIf(!hasDarwinOwner)("a ready Mac plans the zsh PATH block, the launcher and exactly the owner steps its protected roots need", async () => {
    const { text, calls } = await dry();
    expect(text).not.toContain("REFUSED");
    expect(text).toContain("Darwin arm64 as worker; macOS with a logged-in GUI session");
    expect(text).toContain("would add the guarded PATH block at the top of ~/.zshenv");
    expect(text).not.toContain(".bashrc");
    expect(text).toContain("macOS launcher: would build and ad-hoc sign omp-sa-worker-launcher once if absent");
    expect(text).toContain("owner steps at the Mac would remain for: /Users/worker/Documents/code (documents)");
    expect(text).not.toContain("projects (");
    // Only the preflight and the PATH probe ran: nothing was built, written or prompted on the Mac.
    expect(calls).toEqual(["sh -s", `sh -c 'printf %s "$PATH"'`]);
    const open = await dry({ "root.1": "/Users/worker/work" });
    expect(open.text).toContain("no root is privacy-protected: no owner step at the Mac");
    expect((await dry({ "path_marker.zshenv": "yes" })).text).toContain("~/.zshenv already has the PATH block (still not effective");
  });

  test.skipIf(!hasDarwinOwner)("a Mac without its GUI session or Command Line Tools is refused with what to do at the Mac", async () => {
    const { text } = await dry({ gui_domain: "no", developer_tools: undefined });
    expect(text).toContain("REFUSED");
    expect(text).toContain("log in at the Mac's desktop as that account and stay logged in");
    expect(text).toContain("install Xcode Command Line Tools (xcode-select --install) once at the Mac");
    expect(text).toContain("worker add stopped at step 2 (preflight)");
  });

  const userSshdArgs = ["--dedicated-key", "--hostname", "100.64.0.9", "--port", "2222", "--user-sshd"];
  const base64 = (text: string) => Buffer.from(text).toString("base64");
  const desired: UserSshdDesired = { home: "/Users/worker", user: "worker", listen: ["100.64.0.9:2222"] };

  test.skipIf(!hasDarwinOwner)("--user-sshd plans the worker's own sshd before the dedicated key, and reports a matching one as unchanged", async () => {
    const home = mkdtempSync(join(tmpdir(), "osw-head-"));
    const realHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const fresh = await dry({}, { sshd: { sshd_binary: "yes", launchd: "absent" } }, userSshdArgs);
      expect(fresh.text).not.toContain("REFUSED");
      expect(fresh.text).toContain("own sshd on 100.64.0.9:2222 (AllowUsers this account only; no root, no Remote Login)");
      expect(fresh.text).toContain("would create the ed25519 host key in /Users/worker/.omp-sa-sshd");
      expect(fresh.text).toContain("launchd: load the LaunchAgent (launchctl bootstrap)");
      expect(fresh.text.indexOf("user-sshd")).toBeLessThan(fresh.text.indexOf("dedicated-key"));
      expect(fresh.text).toContain("would pin the host key of the worker's own sshd for [100.64.0.9]:2222 once it exists");
      // Inspection only: the preflight, the PATH probe and the read-only sshd inspection ran; nothing was written on the Mac.
      expect(fresh.calls).toEqual(["sh -s", `sh -c 'printf %s "$PATH"'`, "sh -s"]);

      const running = await dry({}, { sshd: {
        sshd_binary: "yes", launchd: "running", host_key: "ssh-ed25519 AAAAworkerhostkey", sshd_config: base64(userSshdConfig(desired)), sshd_plist: base64(userSshdPlist(desired)),
      } }, userSshdArgs);
      expect(running.text).toContain("sshd_config unchanged");
      expect(running.text).toContain("LaunchAgent com.omp-superagent.sshd.plist unchanged");
      expect(running.text).toContain("launchd: already running with this configuration, left alone");
      expect(running.text).toContain("host key in /Users/worker/.omp-sa-sshd kept");
      expect(running.text).toContain("would pin the worker's ed25519 host key for [100.64.0.9]:2222");

      const different = await dry({}, { sshd: {
        sshd_binary: "yes", launchd: "running", host_key: "ssh-ed25519 AAAAworkerhostkey", sshd_config: base64("ListenAddress 100.64.0.9:2300\n"), sshd_plist: base64(userSshdPlist(desired)),
      } }, userSshdArgs);
      expect(different.text).toContain("sshd_config rewrite (the previous file is kept as .bak-*)");
      expect(different.text).toContain("launchd: restart it to read the configuration (launchctl kickstart -k)");

      const missing = await dry({}, { sshd: { launchd: "absent" } }, userSshdArgs);
      expect(missing.text).toContain("/usr/sbin/sshd is not available on the worker");
      expect((await dry()).text).toContain("user-sshd      skipped   not requested (--user-sshd)");
    } finally {
      if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("--user-sshd on Linux is refused: it needs root there, and the administrator's drop-in recipe is printed", async () => {
    const { text, calls } = await dry({ uname_s: "Linux", user_manager: "running", linger: "yes", gui_domain: undefined, developer_tools: undefined }, {}, userSshdArgs);
    expect(text).toContain("REFUSED");
    expect(text).toContain("--user-sshd is macOS only: an sshd that honors authorized_keys options on another port needs root on Linux");
    for (const fragment of ["ssh.socket.d/omp-sa.conf", "ListenStream=<tailnet-ip>:2222", "sshd_config.d/omp-sa.conf", "ListenAddress <tailnet-ip>:2222"]) expect(text).toContain(fragment);
    expect(text).toContain("worker add stopped at step 2 (preflight)");
    expect(calls).toEqual(["sh -s"]);
  });

  test("a Mac that cannot be reached gets the least invasive Remote Login enablement, and a refused key does not", async () => {
    const { text } = await dry({}, { unreachable: true });
    expect(text).toContain("Preflight failed (ssh exit 255)");
    expect(text).toContain('System Settings > General > Sharing > Remote Login');
    expect(text).toContain("limit \"Allow access for\" to the worker account only");
    expect(text).toContain("never changes system settings");
    expect(remoteLoginNote("mac-setup")).toContain("If mac-setup is a Mac");
    expect(sshUnreachable("ssh: connect to host h port 22: Connection refused")).toBe(true);
    expect(sshUnreachable("ssh: connect to host h port 22: Operation timed out")).toBe(true);
    expect(sshUnreachable("worker@h: Permission denied (publickey).")).toBe(false);
  });

  const context = (dryRun: boolean, remote: RemoteRunner) => ({
    options: { dryRun, ssh: "mac-setup" } as never, io: { log: () => {}, remote }, info: macInfo(), release: "0.1.6-abcdef012345",
    scope: { stateDir: "/Users/worker/.osa", workspaceRoots: MAC_ROOTS },
  });
  const prepared = (report: object): RemoteRunner => async (_destination, _command, stdin) => {
    const nonce = /^NONCE=(\w+)$/m.exec(String(stdin))![1];
    return { code: 0, stdout: `@@${nonce} prepare ${JSON.stringify(report)}\n`, stderr: "" };
  };
  const launcher = { path: "/Users/worker/Library/Application Support/omp-superagent-worker/bin/omp-sa-worker-launcher", identifier: "com.omp-superagent.worker-launcher", cdhash: "0123456789abcdef0123456789abcdef01234567", installed: true };

  test("the install step reports the launcher and each owner step still open, never as a failure of setup itself", async () => {
    const pending = { path: MAC_ROOTS[1], category: "documents", instruction: "x" };
    const open = await macosPrepareStep(context(false, prepared({ setup: "/rel/src/worker-macos-setup.ts", launcher, pointerChanged: true, fullDiskAccess: false, granted: [], pending: [pending] })));
    expect(open.status).toBe("attention");
    expect(open.detail).toContain("built and signed now");
    expect(open.detail).toContain("payload pointer updated -> release 0.1.6-abcdef012345");
    expect(open.detail).toContain("owner steps remaining at the Mac (setup never triggers a dialog itself): /Users/worker/Documents/code (documents)");
    expect(open.detail).toContain("bun --no-env-file /rel/src/worker-macos-setup.ts");
    expect(open.detail).toContain("Privacy & Security > Files & Folders");
    const done = await macosPrepareStep(context(false, prepared({ setup: "/rel/s.ts", launcher: { ...launcher, installed: false }, pointerChanged: false, fullDiskAccess: false, granted: ["documents"], pending: [] })));
    expect(done).toMatchObject({ status: "ok" });
    expect(done.detail).toContain("already installed, kept");
    expect(done.detail).toContain("recorded grants: documents");
    await expect(macosPrepareStep(context(false, prepared({ nope: 1 })))).rejects.toThrow("unreadable report");
    const failing: RemoteRunner = async (_destination, _command, stdin) => ({ code: 3, stdout: `@@${/^NONCE=(\w+)$/m.exec(String(stdin))![1]} error macOS launcher setup failed: cc missing\n`, stderr: "" });
    await expect(macosPrepareStep(context(false, failing))).rejects.toThrow("macOS launcher setup failed on the worker: macOS launcher setup failed: cc missing");
  });

  const capability = (macos: WorkerCapability["macos"]): WorkerCapability => ({
    package: workerPackage(), platform: "darwin", bootId: "b", clock: 0, omp: "1", superkit: null, roots: MAC_ROOTS, models: [], macos,
  });
  const ready = { launcher: { path: launcher.path, cdhash: launcher.cdhash }, launcherChanged: false, pointer: "current" as const, missing: [], setup: "/rel/src/worker-macos-setup.ts" };

  test("doctor rows name the launcher, its payload, the session and each missing grant with the exact toggle", () => {
    const rows = (macos: WorkerCapability["macos"]) => macosDoctorRows(capability(macos));
    expect(rows(undefined)).toEqual([]);
    expect(rows(ready).map(row => [row.check, row.status])).toEqual([["macos session", "ok"], ["macos launcher", "ok"], ["macos payload", "ok"], ["macos grants", "ok"]]);
    expect(rows({ ...ready, launcher: null })).toEqual([expect.objectContaining({ check: "macos session" }),
      expect.objectContaining({ check: "macos launcher", status: "fail", detail: expect.stringContaining("Command Line Tools") })]);
    const changed = rows({ ...ready, launcherChanged: true }).find(row => row.check === "macos launcher")!;
    expect(changed.status).toBe("fail");
    expect(changed.detail).toContain("not the binary the recorded grants belong to");
    for (const pointer of ["stale", "absent"] as const) {
      expect(rows({ ...ready, pointer }).find(row => row.check === "macos payload")).toMatchObject({ status: "warn", detail: expect.stringContaining(`pointer is ${pointer}`) });
    }
    const missing = rows({ ...ready, missing: [{ path: MAC_ROOTS[1]!, category: "documents" }] }).find(row => row.check === "macos grants")!;
    expect(missing.status).toBe("fail");
    expect(missing.detail).toContain(`cannot read ${MAC_ROOTS[1]} (documents)`);
    expect(missing.detail).toContain(`bun --no-env-file ${ready.setup}`);
    expect(missing.detail).toContain('enable "omp-sa-worker-launcher" in System Settings > Privacy & Security > Files & Folders');
    expect(missing.detail).toContain(`add ${launcher.path} to Full Disk Access`);
  });

  test("doctor adds a user sshd row only when the agent exists, ok only when running and listening", () => {
    const sshdRow = (userSshd: { state: string; listening: string[] }, macos = ready) => macosDoctorRows(capability({ ...macos, userSshd })).find(row => row.check === "user sshd");
    expect(macosDoctorRows(capability(ready)).some(row => row.check === "user sshd")).toBe(false);
    expect(sshdRow({ state: "running", listening: ["100.64.0.9:2222"] })).toMatchObject({ status: "ok", detail: expect.stringContaining("listening on 100.64.0.9:2222") });
    expect(sshdRow({ state: "running", listening: [] })).toMatchObject({ status: "warn", detail: expect.stringContaining("listens on no socket") });
    expect(sshdRow({ state: "not loaded", listening: [] })).toMatchObject({ status: "warn", detail: expect.stringContaining("com.omp-superagent.sshd is not loaded") });
    // Also reported when the launcher is missing (its own row fails first).
    expect(sshdRow({ state: "running", listening: ["100.64.0.9:2222"] }, { ...ready, launcher: null } as never)).toMatchObject({ status: "ok" });
  });

  test("doctor reports whether the login agents came back after a reboot", () => {
    const rebootRow = (reboot: { first: string; verified: string | null }) => macosDoctorRows(capability({ ...ready, reboot })).find(row => row.check === "macos reboot");
    expect(macosDoctorRows(capability(ready)).some(row => row.check === "macos reboot")).toBe(false);
    // capability() reports boot "b".
    expect(rebootRow({ first: "b", verified: null })).toMatchObject({ status: "ok", detail: expect.stringContaining("no reboot since setup") });
    expect(rebootRow({ first: "a", verified: "b" })).toMatchObject({ status: "ok", detail: expect.stringContaining("came back after a reboot and login") });
    expect(rebootRow({ first: "a", verified: null })).toMatchObject({ status: "warn", detail: expect.stringContaining("not running and listening again") });
  });
});
