import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MINIMUM_WORKER_OMP } from "../src/remote-lanes";
import { workerPackage } from "../src/remote-worker-wire";
import {
  authorizedKeysLine, blockMismatches, classifyForcedCommand, findHostBlock, keyIdentity, knownHostsName, mergeWorkerConfig, parsePreflight,
  parseSshG, parseWorkerArgs, planPreflight, planWorkerJson, releaseFiles, releaseId, sshConfigBlock, stateDirFits, tailscaleRemedy, unenforcedWarning,
  ustarArchive, wrapperContent, workerJsonText, type PreflightInfo, type WorkerJson,
} from "../src/worker-setup";
import {
  authorizedKeysScript, commandScript, installScript, memoryScript, newNonce, parseFacts, preflightScript, sq, workerJsonScript,
} from "../src/worker-setup-remote";

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
    expect(reasons({ uname_s: "Darwin", uname_m: "arm64" })).toContain("Darwin workers are not supported");
    expect(planPreflight(info({ uname_s: "Darwin" })).ownerBinary).toBeNull();
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

  test("the loopback test context runs the same checks on the machine's own platform", () => {
    const plan = planPreflight(info({ direct: "1", uname_s: "Darwin", uname_m: "arm64", user_manager: undefined, linger: undefined }));
    expect(plan.refusals).toEqual([]);
    expect(plan.ownerBinary).toBe("omp-host-owner-darwin-arm64");
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
      command: commandScript({ nonce, wrapper: wrapperContent("/home/alice", "/home/alice/.bun/bin/bun"), bashrc: true }),
      commandNoRc: commandScript({ nonce, wrapper: "#!/bin/sh\n", bashrc: false }),
      workerJson: workerJsonScript({ nonce, content: workerJsonText({ workerId: WORKER_ID, instance: INSTANCE, stateDir: "/s", workspaceRoots: [hostile], command: ["omp"] }), stateDir: "/home/alice/s" }),
      memoryInspect: memoryScript({ nonce, release: "current", cwd: "/srv/a", consent: null, agentDir: null }),
      memoryApply: memoryScript({ nonce, release: "0.1.6-abcdef012345", cwd: "/srv/a", consent: '{"status":"missing"}', agentDir: "/home/alice/.omp/agent" }),
      authorizedKeys: authorizedKeysScript({ nonce, line: `restrict,command="/x" ${PUBLIC_KEY}`, key: keyIdentity(PUBLIC_KEY) }),
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
  });
});
