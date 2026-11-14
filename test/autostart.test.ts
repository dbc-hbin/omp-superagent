import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync,
  symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autostartStatus, installAutostart, uninstallAutostart, type AutostartAdapters } from "../src/autostart";
import { main } from "../src/cli";
import { parseConfig } from "../src/config";
import { writeCredentials } from "../src/credentials";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "superagent-autostart-"));
  roots.push(root);
  const home = join(root, `home & <'"> $()`);
  mkdirSync(home, { mode: 0o700 });
  const path = join(root, `config & <'"> $().json`);
  const raw = {
    command: [process.execPath, "--no-env-file", "/never-run-native-account-or-provider"], headCwd: root, stateDir: "state",
    maxHosts: 4, maxSubagents: 8, idleMs: 300000,
    telegram: { tokenEnv: "AUTOSTART_TEST_TOKEN", ownerId: "123", allowedChatIds: [] },
  };
  writeFileSync(path, JSON.stringify(raw));
  const config = parseConfig(raw, path);
  writeCredentials(path, { AUTOSTART_TEST_TOKEN: "secret-$HOME-<never-persist>", UNRELATED: "never-copy-this" }, undefined);
  const calls: string[][] = [];
  let disabled = true;
  let loaded = false;
  let state = "not running";
  let runs = 1;
  let lastExitCode = 0;
  let pid: number | undefined;
  let pathOverride: string | undefined;
  let failure: { command: string; code: number; stderr?: string } | undefined;
  let malformedDisabled = false;
  const adapters: AutostartAdapters = {
    platform: "darwin", home, uid: process.getuid!(), executable: process.execPath,
    async run(args) {
      calls.push(args);
      if (failure?.command === args[0]) return { code: failure.code, stdout: "", stderr: failure.stderr ?? "SENSITIVE-NOT-FOR-OUTPUT" };
      const label = args[1]!.split("/").at(-1)!;
      if (args[0] === "print-disabled") {
        const status = await identity();
        return { code: 0, stdout: malformedDisabled ? "unexpected" : `disabled services = {\n "${status.label}" => ${disabled}\n}`, stderr: "" };
      }
      if (args[0] === "print") return loaded
        ? { code: 0, stdout: `gui/501/${label} = {
  path = ${pathOverride ?? join(home, "Library", "LaunchAgents", `${label}.plist`)}
  program = ${realpathSync(process.execPath)}
  state = ${state}
  runs = ${runs}
  ${pid === undefined ? "" : `pid = ${pid}`}
  last exit code = ${lastExitCode}
}`, stderr: "" }
        : { code: 113, stdout: "", stderr: `Could not find service "${label}" in domain for user gui: 501` };
      if (args[0] === "enable") disabled = false;
      else if (args[0] === "bootout") loaded = false;
      else throw new Error(`Unexpected launchctl mutation ${args[0]}`);
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  // Resolve the same identity without recursively invoking the fake manager.
  async function identity() {
    const status = await autostartStatus(config, { ...adapters, run: async args =>
      args[0] === "print-disabled" ? { code: 0, stdout: "disabled services = {}", stderr: "" }
        : { code: 113, stdout: "", stderr: "Could not find service" } });
    return status;
  }
  return {
    root, home, path, raw, config, adapters, calls,
    setManager(values: { loaded?: boolean; disabled?: boolean; state?: string; pid?: number; runs?: number; path?: string; lastExitCode?: number }) {
      if (values.loaded !== undefined) loaded = values.loaded;
      if (values.disabled !== undefined) disabled = values.disabled;
      if (values.state !== undefined) state = values.state;
      if (values.runs !== undefined) runs = values.runs;
      if (values.lastExitCode !== undefined) lastExitCode = values.lastExitCode;
      pid = values.pid;
      pathOverride = values.path;
    },
    fail(command: string, code: number, stderr?: string) { failure = { command, code, stderr }; },
    malformedDisabled() { malformedDisabled = true; },
  };
}

describe("macOS login registration", () => {
  test("installs argv safely without native execution, tokens, shell environment, or immediate bootstrap", async () => {
    const f = fixture();
    const report = await installAutostart(f.config, f.adapters);
    expect(report).toMatchObject({ supported: true, installed: true, ownership: "owned", disabled: false, loaded: false, launcher: null });
    const bytes = readFileSync(report.plistPath!, "utf8");
    expect(bytes).toContain("<key>RunAtLoad</key><true/>");
    expect(bytes).toContain("<key>KeepAlive</key><false/>");
    expect(bytes).toContain("<key>AbandonProcessGroup</key><true/>");
    expect(bytes).toContain(`<string>${realpathSync(process.execPath)}</string><string>--no-env-file</string>`);
    expect(bytes).toContain("<string>start</string><string>--config</string>");
    expect(bytes).toContain("config &amp; &lt;&apos;&quot;&gt; $().json");
    expect(bytes).toContain("home &amp; &lt;&apos;&quot;&gt; $()");
    for (const forbidden of ["AUTOSTART_TEST_TOKEN", "secret-", "UNRELATED", "never-copy-this", "PI_CODING_AGENT_DIR", "sh -c"])
      expect(bytes).not.toContain(forbidden);
    expect(bytes.match(/<key>EnvironmentVariables<\/key><dict>(.*?)<\/dict>/s)?.[1].match(/<key>/g)).toHaveLength(2);
    expect(lstatSync(report.plistPath!).mode & 0o777).toBe(0o600);
    expect(f.calls.filter(args => !["print", "print-disabled"].includes(args[0]!))).toEqual([["enable", `gui/${f.adapters.uid}/${report.label}`]]);
    expect(existsSync(f.config.stateDir)).toBe(false);
  });

  test("same install preserves its inode; canonical state aliases share identity but separate instances do not", async () => {
    const f = fixture();
    const first = await installAutostart(f.config, f.adapters);
    const stat = lstatSync(first.plistPath!);
    const second = await installAutostart(f.config, f.adapters);
    expect(second.label).toBe(first.label);
    expect(lstatSync(first.plistPath!).ino).toBe(stat.ino);
    expect(f.calls.filter(args => args[0] === "enable")).toHaveLength(1);
    mkdirSync(join(f.root, "actual"));
    symlinkSync(join(f.root, "actual"), join(f.root, "alias"));
    const actual = await autostartStatus({ ...f.config, stateDir: join(f.root, "actual", "not-created") }, f.adapters);
    const alias = await autostartStatus({ ...f.config, stateDir: join(f.root, "alias", "not-created") }, f.adapters);
    expect(alias.label).toBe(actual.label);
    expect(actual.label).not.toBe(first.label);
    expect(existsSync(join(f.root, "actual", "not-created"))).toBe(false);
  });

  test("default-enabled installation does not create a launchctl override", async () => {
    const f = fixture();
    f.setManager({ disabled: false });
    const report = await installAutostart(f.config, f.adapters);
    expect(report.disabled).toBe(false);
    expect(f.calls.every(args => ["print", "print-disabled"].includes(args[0]!))).toBe(true);
  });

  test("updates an owned unloaded executable with escaped argv, but refuses replacement while loaded", async () => {
    const f = fixture();
    const installed = await installAutostart(f.config, f.adapters);
    const executable = join(f.root, `bun & <'"> $()`);
    writeFileSync(executable, "fixture-executable-not-run", { mode: 0o700 });
    const next = { ...f.adapters, executable };
    f.setManager({ loaded: true });
    await expect(installAutostart(f.config, next)).rejects.toThrow("must be uninstalled while idle");
    f.setManager({ loaded: false });
    await installAutostart(f.config, next);
    expect(readFileSync(installed.plistPath!, "utf8")).toContain("bun &amp; &lt;&apos;&quot;&gt; $()");
  });

  test("requires private sibling credentials rather than promising shell-only login credentials", async () => {
    const f = fixture();
    rmSync(`${f.path}.env`);
    await expect(installAutostart(f.config, f.adapters)).rejects.toThrow("private FILE.env");
    expect(f.calls).toEqual([]);
    expect(existsSync(join(f.home, "Library"))).toBe(false);
    writeFileSync(`${f.path}.env`, "AUTOSTART_TEST_TOKEN=TOP-SECRET", { mode: 0o644 });
    await expect(installAutostart(f.config, f.adapters)).rejects.toThrow("mode 0600");
    expect(f.calls).toEqual([]);
  });

  test("rejects bare or nonexecutable native commands before registering a login job", async () => {
    const f = fixture();
    await expect(installAutostart({ ...f.config, command: ["bun", "native.ts"] }, f.adapters))
      .rejects.toThrow("absolute executable config.command[0]");
    const nonexecutable = join(f.root, "not-executable");
    writeFileSync(nonexecutable, "not a runnable command", { mode: 0o600 });
    for (const command of [nonexecutable, join(f.root, "missing-executable")])
      await expect(installAutostart({ ...f.config, command: [command] }, f.adapters))
        .rejects.toThrow("existing executable");
    expect(f.calls).toEqual([]);
    expect(existsSync(join(f.home, "Library"))).toBe(false);
  });

  test("refuses foreign, symlink, hard-linked and unsafe definitions without takeover", async () => {
    const f = fixture();
    const report = await installAutostart(f.config, f.adapters);
    const original = readFileSync(report.plistPath!, "utf8");
    writeFileSync(report.plistPath!, "<plist>FOREIGN</plist>");
    await expect(installAutostart(f.config, f.adapters)).rejects.toThrow("foreign");
    await expect(uninstallAutostart(f.config, f.adapters)).rejects.toThrow("foreign");
    expect(readFileSync(report.plistPath!, "utf8")).toBe("<plist>FOREIGN</plist>");
    expect((await autostartStatus(f.config, f.adapters)).ownership).toBe("foreign");
    rmSync(report.plistPath!);
    const foreign = join(f.root, "foreign.plist");
    writeFileSync(foreign, original, { mode: 0o600 });
    symlinkSync(foreign, report.plistPath!);
    await expect(installAutostart(f.config, f.adapters)).rejects.toThrow("unsafe");
    await expect(uninstallAutostart(f.config, f.adapters)).rejects.toThrow("unsafe");
    expect(readFileSync(foreign, "utf8")).toBe(original);
    rmSync(report.plistPath!);
    linkSync(foreign, report.plistPath!);
    await expect(installAutostart(f.config, f.adapters)).rejects.toThrow("unsafe");
    await expect(uninstallAutostart(f.config, f.adapters)).rejects.toThrow("unsafe");
    rmSync(report.plistPath!);
    writeFileSync(report.plistPath!, original, { mode: 0o600 });
    chmodSync(report.plistPath!, 0o644);
    await expect(uninstallAutostart(f.config, f.adapters)).rejects.toThrow("unsafe");
  });

  test("does not adopt another config or checkout using the same state directory", async () => {
    const f = fixture();
    await installAutostart(f.config, f.adapters);
    const otherPath = join(f.root, "other.json");
    const other = { ...f.config, path: otherPath };
    writeCredentials(otherPath, { AUTOSTART_TEST_TOKEN: "other-secret" }, undefined);
    await expect(installAutostart(other, f.adapters)).rejects.toThrow("owning config and checkout");
    await expect(uninstallAutostart(other, f.adapters)).rejects.toThrow("owning config and checkout");
  });

  test("refuses symlinked LaunchAgents and group-writable directories", async () => {
    const f = fixture();
    mkdirSync(join(f.home, "Library"));
    const foreign = join(f.root, "foreign-agents");
    mkdirSync(foreign);
    symlinkSync(foreign, join(f.home, "Library", "LaunchAgents"));
    await expect(installAutostart(f.config, f.adapters)).rejects.toThrow("non-symlink");
    expect((await autostartStatus(f.config, f.adapters)).ownership).toBe("foreign");
    rmSync(join(f.home, "Library", "LaunchAgents"));
    mkdirSync(join(f.home, "Library", "LaunchAgents"));
    chmodSync(join(f.home, "Library", "LaunchAgents"), 0o777);
    await expect(installAutostart(f.config, f.adapters)).rejects.toThrow("not group/world writable");
  });

  test("reports disabled override, loaded completed launcher and last exit separately", async () => {
    const f = fixture();
    await installAutostart(f.config, f.adapters);
    f.setManager({ loaded: true, disabled: true });
    const status = await autostartStatus(f.config, f.adapters);
    expect(status).toMatchObject({ installed: true, disabled: true, loaded: true,
      launcher: { state: "not running", pid: null, runs: 1, lastExitCode: 0, lastTerminatingSignal: null } });
    expect(status).not.toHaveProperty("ready");
    expect(status.note).toContain("not Gateway readiness");
    const enabled = await installAutostart(f.config, f.adapters);
    expect(enabled.disabled).toBe(false);
    f.setManager({ loaded: true, lastExitCode: 78 });
    expect((await autostartStatus(f.config, f.adapters)).launcher?.lastExitCode).toBe(78);
    expect(f.calls.some(args => ["bootstrap", "kickstart", "start"].includes(args[0]!))).toBe(false);
  });

  test.each([
    { state: "running", pid: 987654, runs: 1 },
    { state: "spawn scheduled", runs: 0 },
    { state: "not running", runs: 0 },
    { state: "waiting", runs: 1 },
  ])("refuses active or ambiguous launcher %j without killing or removing anything", async launcher => {
    const f = fixture();
    const installed = await installAutostart(f.config, f.adapters);
    f.setManager({ loaded: true, ...launcher });
    f.calls.length = 0;
    await expect(uninstallAutostart(f.config, f.adapters)).rejects.toThrow("not safely idle");
    expect(existsSync(installed.plistPath!)).toBe(true);
    expect(f.calls.some(args => ["bootout", "kill", "stop"].includes(args[0]!))).toBe(false);
  });

  test("unloads only the completed owned one-shot and preserves credentials/state and running Gateway ownership", async () => {
    const f = fixture();
    const installed = await installAutostart(f.config, f.adapters);
    mkdirSync(f.config.stateDir);
    writeFileSync(join(f.config.stateDir, "gateway-owned"), "running-independent-gateway");
    const credentials = readFileSync(`${f.path}.env`, "utf8");
    f.setManager({ loaded: true });
    f.calls.length = 0;
    const removed = await uninstallAutostart(f.config, f.adapters);
    expect(removed).toMatchObject({ installed: false, loaded: false, ownership: "absent" });
    expect(existsSync(installed.plistPath!)).toBe(false);
    expect(readFileSync(`${f.path}.env`, "utf8")).toBe(credentials);
    expect(readFileSync(join(f.config.stateDir, "gateway-owned"), "utf8")).toBe("running-independent-gateway");
    expect(f.calls.filter(args => !["print", "print-disabled"].includes(args[0]!))).toEqual([["bootout", `gui/${f.adapters.uid}/${installed.label}`]]);
    await uninstallAutostart(f.config, f.adapters);
  });

  test("refuses unverified loaded owner even if the on-disk definition is ours", async () => {
    const f = fixture();
    const installed = await installAutostart(f.config, f.adapters);
    f.setManager({ loaded: true, path: "/foreign/definition.plist" });
    await expect(uninstallAutostart(f.config, f.adapters)).rejects.toThrow("ownership cannot be verified");
    expect((await autostartStatus(f.config, f.adapters)).error).toContain("ownership");
    expect(existsSync(installed.plistPath!)).toBe(true);
  });

  test.each(["print-disabled", "print", "enable", "bootout"])("reports launchctl %s failures without stderr secrets or detached fallback", async command => {
    const f = fixture();
    const report = await installAutostart(f.config, f.adapters);
    f.setManager({ loaded: true, disabled: command === "enable" });
    f.fail(command, 5);
    if (command === "bootout") await expect(uninstallAutostart(f.config, f.adapters)).rejects.toThrow(`launchctl ${command} failed`);
    else await expect(installAutostart(f.config, f.adapters)).rejects.toThrow(`launchctl ${command} failed`);
    expect(existsSync(report.plistPath!)).toBe(true);
    const status = await autostartStatus(f.config, f.adapters);
    expect(JSON.stringify(status)).not.toContain("SENSITIVE");
    expect(f.calls.some(args => ["bootstrap", "kickstart", "load", "start", "kill"].includes(args[0]!))).toBe(false);
  });

  test("does not confuse arbitrary missing-service or malformed override errors with success", async () => {
    const f = fixture();
    f.fail("print", 5, "Could not find service");
    await expect(installAutostart(f.config, f.adapters)).rejects.toThrow("launcher state is unknown");
    const other = fixture();
    other.malformedDisabled();
    await expect(installAutostart(other.config, other.adapters)).rejects.toThrow("unrecognized response");
  });

  test("status does not create directories; unsupported systems do not call launchctl", async () => {
    const f = fixture();
    const status = await autostartStatus(f.config, f.adapters);
    expect(status).toMatchObject({ installed: false, ownership: "absent" });
    expect(existsSync(join(f.home, "Library"))).toBe(false);
    expect(existsSync(f.config.stateDir)).toBe(false);
    f.calls.length = 0;
    const unsupported = { ...f.adapters, platform: "linux" };
    expect(await autostartStatus(f.config, unsupported)).toMatchObject({ supported: false, installed: false, loaded: null });
    await expect(installAutostart(f.config, unsupported)).rejects.toThrow("macOS");
    await expect(uninstallAutostart(f.config, unsupported)).rejects.toThrow("macOS");
    expect(f.calls).toEqual([]);
  });

  test("CLI rejects force, target and duplicate arguments before loading config or credentials", async () => {
    for (const command of ["install", "uninstall"]) {
      await expect(main([command])).rejects.toThrow("--config FILE is required");
      for (const args of [
        ["main", "--config", "unused.json"], ["--config", "unused.json", "--force"],
        ["--config", "unused.json", "--config", "other.json"], ["--config", "--force"],
      ]) await expect(main([command, ...args])).rejects.toThrow(`Usage: ${command}`);
    }
  });

  test("CLI status keeps native/provider/auth modules and credential loader inactive", async () => {
    const f = fixture();
    // Real CLI status runs in a fresh module graph. Import guards fail before any
    // native loader or messenger account activation can execute.
    const script = `
      Bun.plugin({ name: "forbid-account-runtime", setup(build) {
        build.onLoad({ filter: /(?:node_modules\\/.*(?:pi-coding-agent|discord|grammy|slack)|\\/src\\/(?:host|gateway|runtime|messengers)\\.ts$)/ }, args => {
          throw new Error("Forbidden runtime/account import: " + args.path);
        });
      }});
      const { main } = await import(${JSON.stringify(new URL("../src/cli.ts", import.meta.url).href)});
      await main(["status", "--config", ${JSON.stringify(f.path)}]);
      if (process.env.AUTOSTART_TEST_TOKEN) throw new Error("Status loaded private credentials");
    `;
    const env = { ...process.env };
    delete env.AUTOSTART_TEST_TOKEN;
    const child = Bun.spawn([process.execPath, "--no-env-file", "-e", script], {
      cwd: f.root, env, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toHaveProperty("autostart");
    expect(stdout).not.toContain("secret-");
    expect(existsSync(f.config.stateDir)).toBe(false);
  });
});
