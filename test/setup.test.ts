import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { parseConfig } from "../src/config";
import {
  assertCredentialsUnchanged, loadCredentials, readCredentialFile, serializeCredentials,
  validateCredential, writeCredentials,
} from "../src/credentials";

const directories: string[] = [];
const environment = new Map<string, string | undefined>();

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "superagent-setup-"));
  directories.push(directory);
  const path = join(directory, "config.json");
  const raw = {
    command: [process.execPath], headCwd: directory, stateDir: "state",
    maxHosts: 4, maxSubagents: 8, idleMs: 300000,
    telegram: { tokenEnv: "SETUP_TEST_TOKEN", ownerId: "123", allowedChatIds: [] },
  };
  return { directory, path, raw, config: parseConfig(raw, path) };
}

function setEnvironment(name: string, value?: string) {
  if (!environment.has(name)) environment.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  for (const [name, value] of environment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  environment.clear();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("private setup credentials", () => {
  test("round-trips shell-looking bytes without interpolation or injected assignments", () => {
    const values = {
      SETUP_TEST_TOKEN: `  $HOME ${"${DO_NOT_EXPAND}"} $(touch /tmp/not-executed) \\ literal # 'single'  `,
      OTHER_TOKEN: 'first\\nsecond\\backslash$PATH "double" `tick`',
      EMPTY: "",
    };
    const text = serializeCredentials(values);
    expect(parseEnv(text)).toEqual(values);
    expect(Object.keys(parseEnv(text))).toEqual(Object.keys(values));
    for (const value of Object.values(values).filter(Boolean)) validateCredential(value);
  });

  test("writes private sibling files and retains unrelated keys", () => {
    const { path } = fixture();
    const old = { SETUP_TEST_TOKEN: "old", UNRELATED: "keep $HOME \\ exactly" };
    writeCredentials(path, old, undefined);
    expect(lstatSync(`${path}.env`).mode & 0o777).toBe(0o600);
    const snapshot = readCredentialFile(path)!;
    writeCredentials(path, { ...snapshot.values, SETUP_TEST_TOKEN: "new$literal" }, snapshot);
    expect(readCredentialFile(path)?.values).toEqual({ ...old, SETUP_TEST_TOKEN: "new$literal" });
    expect(() => lstatSync(join(path, "..", ".env"))).toThrow();
    expect(() => lstatSync(`${path}.env.lock`)).toThrow();
  });

  test("refuses an existing publisher lock without stealing it or changing credentials", () => {
    const { path } = fixture();
    writeCredentials(path, { SETUP_TEST_TOKEN: "original" }, undefined);
    const snapshot = readCredentialFile(path)!;
    writeFileSync(`${path}.env.lock`, "other-setup-pid\n", { mode: 0o600 });
    expect(() => writeCredentials(path, { SETUP_TEST_TOKEN: "replacement" }, snapshot)).toThrow("write lock unavailable");
    expect(readFileSync(`${path}.env.lock`, "utf8")).toBe("other-setup-pid\n");
    expect(readCredentialFile(path)?.values.SETUP_TEST_TOKEN).toBe("original");
    rmSync(`${path}.env.lock`);
    writeCredentials(path, { SETUP_TEST_TOKEN: "replacement" }, snapshot);
    expect(readCredentialFile(path)?.values.SETUP_TEST_TOKEN).toBe("replacement");
    expect(() => lstatSync(`${path}.env.lock`)).toThrow();
  });

  test("two setup processes with the same original snapshot cannot both replace credentials", async () => {
    const { path } = fixture();
    writeCredentials(path, { SETUP_TEST_TOKEN: "original" }, undefined);
    const modulePath = new URL("../src/credentials.ts", import.meta.url).href;
    const spawnWriter = (value: string) => Bun.spawn([
      process.execPath, "--no-env-file", "-e", `
        import { readCredentialFile, writeCredentials } from ${JSON.stringify(modulePath)};
        const path = ${JSON.stringify(path)};
        const snapshot = readCredentialFile(path);
        process.stdout.write("ready\\n");
        await Bun.stdin.text();
        try {
          writeCredentials(path, { SETUP_TEST_TOKEN: ${JSON.stringify(value)} }, snapshot);
          console.log("committed");
        } catch (error) {
          console.log(error.message.includes("changed during setup") ? "stale" : "unexpected");
          process.exitCode = 2;
        }
      `,
    ], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const first = spawnWriter("first-publication");
    const second = spawnWriter("second-publication");
    const firstReader = first.stdout.getReader();
    const secondReader = second.stdout.getReader();
    const ready = async (reader: typeof firstReader) => {
      const decoder = new TextDecoder();
      let text = "";
      while (!text.includes("\n")) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("Credential writer exited before taking its snapshot");
        text += decoder.decode(chunk.value, { stream: true });
      }
      expect(text).toBe("ready\n");
    };
    const remaining = async (reader: typeof firstReader) => {
      const decoder = new TextDecoder();
      let text = "";
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return text + decoder.decode();
        text += decoder.decode(chunk.value, { stream: true });
      }
    };
    try {
      // Both children hold the original snapshot before either is permitted to
      // publish. EOF is the barrier; there are no sleep-based ordering guesses.
      await Promise.all([ready(firstReader), ready(secondReader)]);
      first.stdin.end();
      expect(await remaining(firstReader)).toBe("committed\n");
      expect(await first.exited).toBe(0);
      second.stdin.end();
      expect(await remaining(secondReader)).toBe("stale\n");
      expect(await second.exited).toBe(2);
      expect(readCredentialFile(path)?.values.SETUP_TEST_TOKEN).toBe("first-publication");
      expect(await new Response(first.stderr).text()).toBe("");
      expect(await new Response(second.stderr).text()).toBe("");
      expect(() => lstatSync(`${path}.env.lock`)).toThrow();
    } finally {
      for (const child of [first, second]) {
        if (child.exitCode === null) child.kill();
      }
      await Promise.all([first.exited, second.exited]);
      firstReader.releaseLock();
      secondReader.releaseLock();
    }
  }, 10_000);

  test("reads a complete first publication even if interruption left a private stage link", () => {
    const { directory, path } = fixture();
    const stage = join(directory, ".setup-interrupted.tmp");
    writeFileSync(stage, "SETUP_TEST_TOKEN=published\n", { mode: 0o600 });
    linkSync(stage, `${path}.env`);
    expect(lstatSync(`${path}.env`).nlink).toBe(2);
    const snapshot = readCredentialFile(path)!;
    expect(snapshot.values.SETUP_TEST_TOKEN).toBe("published");
    writeCredentials(path, { SETUP_TEST_TOKEN: "updated" }, snapshot);
    expect(readCredentialFile(path)?.values.SETUP_TEST_TOKEN).toBe("updated");
    expect(readFileSync(stage, "utf8")).toBe("SETUP_TEST_TOKEN=published\n");
  });

  test("loads only configured credential names and gives nonempty explicit environment precedence", () => {
    const { path, config } = fixture();
    writeCredentials(path, { SETUP_TEST_TOKEN: "private$literal", SETUP_TEST_UNRELATED: "never-inject" }, undefined);
    setEnvironment("SETUP_TEST_TOKEN", "explicit-shell");
    setEnvironment("SETUP_TEST_UNRELATED");
    loadCredentials(config);
    expect(process.env.SETUP_TEST_TOKEN).toBe("explicit-shell");
    expect(process.env.SETUP_TEST_UNRELATED).toBeUndefined();
    setEnvironment("SETUP_TEST_TOKEN", "");
    loadCredentials(config);
    expect(process.env.SETUP_TEST_TOKEN).toBe("private$literal");
    expect(process.env.SETUP_TEST_UNRELATED).toBeUndefined();
  });

  test("supports existing env-only configurations without creating a credential file", () => {
    const { path, config } = fixture();
    setEnvironment("SETUP_TEST_TOKEN", "explicit-only");
    loadCredentials(config);
    expect(process.env.SETUP_TEST_TOKEN).toBe("explicit-only");
    expect(readCredentialFile(path)).toBeUndefined();
  });

  test("refuses permissive credential files rather than chmodding or reading them", () => {
    const { path } = fixture();
    writeFileSync(`${path}.env`, "SETUP_TEST_TOKEN=not-public\n", { mode: 0o644 });
    chmodSync(`${path}.env`, 0o644);
    expect(() => readCredentialFile(path)).toThrow("private file");
    expect(lstatSync(`${path}.env`).mode & 0o777).toBe(0o644);
    expect(readFileSync(`${path}.env`, "utf8")).toBe("SETUP_TEST_TOKEN=not-public\n");
  });

  test("refuses symlinks, including dangling credential symlinks", () => {
    const { directory, path } = fixture();
    const target = join(directory, "target");
    symlinkSync(target, `${path}.env`);
    expect(() => readCredentialFile(path)).toThrow("symlink");
    writeFileSync(target, "SETUP_TEST_TOKEN=keep\n", { mode: 0o600 });
    expect(() => readCredentialFile(path)).toThrow("symlink");
    expect(readFileSync(target, "utf8")).toBe("SETUP_TEST_TOKEN=keep\n");
  });

  test("rejects changed-underneath credentials and preserves the newer bytes", () => {
    const { directory, path } = fixture();
    writeCredentials(path, { SETUP_TEST_TOKEN: "original" }, undefined);
    const snapshot = readCredentialFile(path)!;
    writeFileSync(`${path}.env`, "SETUP_TEST_TOKEN=external-change\n");
    expect(() => writeCredentials(path, { SETUP_TEST_TOKEN: "replacement" }, snapshot)).toThrow("changed during setup");
    expect(readFileSync(`${path}.env`, "utf8")).toBe("SETUP_TEST_TOKEN=external-change\n");
    expect(readdirSync(directory).some(name => name.startsWith(".setup-"))).toBe(false);
  });

  test("rejects unexpected file creation and deletion without overwriting data", () => {
    const { path } = fixture();
    writeCredentials(path, { SETUP_TEST_TOKEN: "created-externally" }, undefined);
    expect(() => assertCredentialsUnchanged(path, undefined)).toThrow("changed during setup");
    const snapshot = readCredentialFile(path)!;
    rmSync(`${path}.env`);
    expect(() => writeCredentials(path, { SETUP_TEST_TOKEN: "replacement" }, snapshot)).toThrow("changed during setup");
    expect(readCredentialFile(path)).toBeUndefined();
  });

  test("invalid encoding, multiline tokens and invalid config candidates fail before persistence", () => {
    const { path, raw } = fixture();
    for (const value of ["", "first\nsecond", "first\rsecond", "a\0b", "\ud800"]) {
      expect(() => validateCredential(value)).toThrow();
    }
    expect(() => parseConfig({ ...raw, telegram: { ...raw.telegram, ownerId: "" } }, path)).toThrow("ownerId");
    expect(() => parseConfig({ ...raw, maxSubagents: 1 }, path)).toThrow("maxSubagents");
    expect(readCredentialFile(path)).toBeUndefined();
    expect(() => lstatSync(path)).toThrow();
    writeFileSync(`${path}.env`, Buffer.from([0xff]), { mode: 0o600 });
    expect(() => readCredentialFile(path)).toThrow("UTF-8");
    expect(readFileSync(`${path}.env`)).toEqual(Buffer.from([0xff]));
  });
});

// Use a fresh process for each native-config case: native dirs and dotenv cache
// their environment at import time, so importing them in this runner is unsafe.
async function nativeMemoryCase(before: string, after = "") {
  const { directory } = fixture();
  const home = join(directory, "home");
  mkdirSync(home);
  const helper = new URL("../src/setup-memory.ts", import.meta.url).href;
  const nativeSettings = import.meta.resolve("@oh-my-pi/pi-coding-agent/config/settings");
  const nativeBackend = import.meta.resolve("@oh-my-pi/pi-coding-agent/memory-backend/settings");
  const nativeDirs = Bun.resolveSync("@oh-my-pi/pi-utils/dirs", dirname(fileURLToPath(nativeSettings)));
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", `
    import { YAML } from "bun";
    import { mkdir, readdir, rename, rm } from "node:fs/promises";
    import { join } from "node:path";
    import net from "node:net";
    import tls from "node:tls";
    import dgram from "node:dgram";
    import { saveMnemopiPreference } from ${JSON.stringify(helper)};
    const deny = () => { throw new Error("Native setup must stay offline"); };
    net.Socket.prototype.connect = net.Server.prototype.listen = tls.connect = deny;
    for (const name of ["bind", "connect", "send"]) dgram.Socket.prototype[name] = deny;
    for (const name of ["connect", "listen", "serve"]) Bun[name] = deny;
    globalThis.fetch = deny;
    globalThis.WebSocket = class { constructor() { deny(); } };
    // Intentional dynamic imports exercise the credential-safe config-only boundary.
    const { Settings } = await import(${JSON.stringify(nativeSettings)});
    const { cfgMemoryBackend } = await import(${JSON.stringify(nativeBackend)});
    const { getAgentDir, getAgentDbPath, getProjectAgentDir, getMemoriesDir, MAIN_CONFIG_FILENAMES } =
      await import(${JSON.stringify(nativeDirs)});
    const cwd = process.cwd();
    const agentDir = getAgentDir();
    const configPath = join(agentDir, MAIN_CONFIG_FILENAMES[0]);
    await mkdir(agentDir, { recursive: true });
    const writeConfig = value => Bun.write(configPath, JSON.stringify(value));
    ${before}
    const result = await saveMnemopiPreference(cwd);
    ${after}
    const actual = await Settings.loadReadOnly({ cwd });
    const effective = cfgMemoryBackend.get(actual);
    cfgMemoryBackend.pinDefault(actual);
    const rpcEffective = cfgMemoryBackend.get(actual);
    let memoryFiles = [];
    try { memoryFiles = await readdir(getMemoriesDir(agentDir), { recursive: true }); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    console.log(JSON.stringify({ result, effective, rpcEffective,
      global: actual.getGlobalSettings(), project: actual.getProjectSettings(), memoryFiles,
      agentDbExists: await Bun.file(getAgentDbPath(agentDir)).exists(),
      disk: YAML.parse(await Bun.file(configPath).text()) }));
  `], {
    cwd: directory, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: directory,
      PI_CODING_AGENT_DIR: join(directory, "native-agent"),
      XDG_CONFIG_HOME: join(directory, "xdg-config"), XDG_DATA_HOME: join(directory, "xdg-data"),
      XDG_STATE_HOME: join(directory, "xdg-state"), XDG_CACHE_HOME: join(directory, "xdg-cache"),
      NO_COLOR: "1", TERM: "dumb",
    },
  });
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    return JSON.parse(stdout);
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
}

describe("deferred native Mnemopi preference", () => {
  test("sets only the native backend and survives RPC defaults without starting memory", async () => {
    const original = {
      memory: { backend: "local" }, modelRoles: { default: "vendor/model", judge: "vendor/judge" },
      mnemopi: { autoRecall: false, autoRetain: false, scoping: "global", bank: "keep-bank", dbPath: "keep.db" },
    };
    const result = await nativeMemoryCase(`await writeConfig(${JSON.stringify(original)});`);
    expect(result.result.status).toBe("enabled");
    expect(result.effective).toBe("mnemopi");
    expect(result.rpcEffective).toBe("mnemopi");
    expect(result.disk).toEqual({ ...original, memory: { backend: "mnemopi" } });
    expect(result.memoryFiles).toEqual([]);
    expect(result.agentDbExists).toBe(false);
  }, 30_000);

  test("config-only persistence never opens or changes native account/token storage", async () => {
    const result = await nativeMemoryCase(`
      await writeConfig({ memory: { backend: "off" }, mnemopi: { bank: "keep" } });
      const accountBytes = "native-account-file-must-not-be-opened-or-migrated";
      await Bun.write(getAgentDbPath(agentDir), accountBytes);
    `, `
      if (await Bun.file(getAgentDbPath(agentDir)).text() !== accountBytes)
        throw new Error("Native account storage changed during setup");
    `);
    expect(result.result.status).toBe("enabled");
    expect(result.effective).toBe("mnemopi");
    expect(result.memoryFiles).toEqual([]);
  }, 30_000);

  test("native persistence preserves a disjoint edit made after staging", async () => {
    const result = await nativeMemoryCase(`
      await writeConfig({ memory: { backend: "off" }, modelRoles: { default: "vendor/old" } });
      const flush = Settings.prototype.flush;
      let edited = false;
      Settings.prototype.flush = async function () {
        if (!edited && this.getGlobalSettings().memory?.backend === "mnemopi") {
          edited = true;
          await writeConfig({ memory: { backend: "off" }, modelRoles: { default: "vendor/new" },
            mnemopi: { bank: "concurrent-bank", autoRetain: false } });
        }
        return flush.call(this);
      };
    `);
    expect(result.result.status).toBe("enabled");
    expect(result.disk).toEqual({ memory: { backend: "mnemopi" }, modelRoles: { default: "vendor/new" },
      mnemopi: { bank: "concurrent-bank", autoRetain: false } });
    expect(result.memoryFiles).toEqual([]);
  }, 30_000);

  test("a same-setting external edit wins and authoritative readback refuses success", async () => {
    const result = await nativeMemoryCase(`
      await writeConfig({ memory: { backend: "off" } });
      const flush = Settings.prototype.flush;
      let edited = false;
      Settings.prototype.flush = async function () {
        if (!edited && this.getGlobalSettings().memory?.backend === "mnemopi") {
          edited = true;
          await writeConfig({ memory: { backend: "local" }, mnemopi: { bank: "external" } });
        }
        return flush.call(this);
      };
    `);
    expect(result.result.status).toBe("not-saved");
    expect(result.effective).toBe("local");
    expect(result.disk).toEqual({ memory: { backend: "local" }, mnemopi: { bank: "external" } });
  }, 30_000);

  test("reports a project shadow without overwriting it or claiming Mnemopi is effective", async () => {
    const result = await nativeMemoryCase(`
      await writeConfig({ memory: { backend: "off" }, mnemopi: { bank: "untouched" } });
      const projectDir = getProjectAgentDir(cwd);
      await mkdir(projectDir, { recursive: true });
      await Bun.write(join(projectDir, MAIN_CONFIG_FILENAMES[0]), JSON.stringify({ memory: { backend: "off" } }));
    `);
    expect(result.result).toMatchObject({ status: "shadowed", source: "project" });
    expect(result.effective).toBe("off");
    expect(result.disk).toEqual({ memory: { backend: "mnemopi" }, mnemopi: { bank: "untouched" } });
    expect(result.project.memory.backend).toBe("off");
    expect(result.memoryFiles).toEqual([]);
  }, 30_000);

  test("native config overlays remain authoritative and are never rewritten", async () => {
    const result = await nativeMemoryCase(`
      await writeConfig({ memory: { backend: "off" }, mnemopi: { bank: "global-kept" } });
      const overlayPath = join(cwd, "native-override.yml");
      const overlayBytes = '{"memory":{"backend":"local"},"mnemopi":{"bank":"overlay-kept"}}\\n';
      await Bun.write(overlayPath, overlayBytes);
      process.env.PI_CONFIG_FILES = overlayPath;
    `, `
      if (await Bun.file(overlayPath).text() !== overlayBytes)
        throw new Error("Native config overlay changed during setup");
    `);
    expect(result.result).toMatchObject({ status: "shadowed", source: "overlay" });
    expect(result.effective).toBe("local");
    expect(result.disk).toEqual({ memory: { backend: "mnemopi" }, mnemopi: { bank: "global-kept" } });
    expect(result.memoryFiles).toEqual([]);
  }, 30_000);

  test("native write failures are reported without rewriting unrelated values", async () => {
    const result = await nativeMemoryCase(`
      await writeConfig({ memory: { backend: "off" }, mnemopi: { bank: "preserve-on-failure" } });
      const flush = Settings.prototype.flush;
      let replaced = false;
      Settings.prototype.flush = async function () {
        if (!replaced && this.getGlobalSettings().memory?.backend === "mnemopi") {
          replaced = true;
          // A real filesystem failure at the native persistence boundary.
          await rename(configPath, configPath + ".original");
          await mkdir(configPath);
        }
        return flush.call(this);
      };
    `, `await rm(configPath, { recursive: true }); await rename(configPath + ".original", configPath);`);
    expect(result.result).toEqual({ status: "failed" });
    expect(result.disk).toEqual({ memory: { backend: "off" }, mnemopi: { bank: "preserve-on-failure" } });
    expect(result.memoryFiles).toEqual([]);
  }, 30_000);
});

async function nativeJudgeCase(before: string) {
  const { directory } = fixture();
  const home = join(directory, "home");
  mkdirSync(home);
  const helper = new URL("../src/setup-judge.ts", import.meta.url).href;
  const nativeSettings = import.meta.resolve("@oh-my-pi/pi-coding-agent/config/settings");
  const nativeDirs = Bun.resolveSync("@oh-my-pi/pi-utils/dirs", dirname(fileURLToPath(nativeSettings)));
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", `
    import { mkdir, readdir, lstat, readFile, readlink, symlink } from "node:fs/promises";
    import { dirname, join } from "node:path";
    import net from "node:net";
    import tls from "node:tls";
    import dgram from "node:dgram";
    import { inspectNativeJudge } from ${JSON.stringify(helper)};
    import { getAgentDir, getAgentDbPath, getProjectAgentDir, MAIN_CONFIG_FILENAMES }
      from ${JSON.stringify(nativeDirs)};
    const deny = () => { throw new Error("Native judge inspection must stay offline"); };
    net.Socket.prototype.connect = net.Server.prototype.listen = tls.connect = deny;
    for (const name of ["bind", "connect", "send"]) dgram.Socket.prototype[name] = deny;
    for (const name of ["connect", "listen", "serve"]) Bun[name] = deny;
    globalThis.fetch = deny;
    globalThis.WebSocket = class { constructor() { deny(); } };
    const cwd = process.cwd();
    const agentDir = getAgentDir();
    const configPath = join(agentDir, MAIN_CONFIG_FILENAMES[0]);
    const projectDir = getProjectAgentDir(cwd);
    const projectPath = join(projectDir, MAIN_CONFIG_FILENAMES[0]);
    const overlayPath = join(cwd, "native-override.yml");
    await mkdir(agentDir, { recursive: true });
    const writeConfig = value => Bun.write(configPath, JSON.stringify(value));
    const writeProject = async value => {
      await mkdir(projectDir, { recursive: true });
      await Bun.write(projectPath, JSON.stringify(value));
    };
    const writeOverlay = async value => {
      await Bun.write(overlayPath, JSON.stringify(value));
      process.env.PI_CONFIG_FILES = overlayPath;
    };
    // Fresh fixtures have no legacy state. Cases that exercise it explicitly
    // add opaque bytes, which a real account-store open could not migrate.
    const writeLegacy = () => Bun.write(join(agentDir, "settings.json"), "private-selector-opaque-legacy-json");
    const writeDb = () => Bun.write(getAgentDbPath(agentDir), "judge-inspection-must-not-open-account-storage");
    await Bun.write(join(agentDir, "auth.json"), '{"private":"judge-auth-secret"}\\n');
    await Bun.write(join(agentDir, "models.yml"), 'providers: {}\\n# preserve model metadata\\n');
    ${before}
    async function snapshot(target) {
      let stat;
      try { stat = await lstat(target); }
      catch (error) { if (error.code === "ENOENT") return null; throw error; }
      if (stat.isSymbolicLink()) return [stat.mode, await readlink(target)];
      if (!stat.isDirectory()) return [stat.mode, (await readFile(target)).toString("base64")];
      const entries = [];
      for (const name of (await readdir(target)).sort()) {
        entries.push([name, await snapshot(join(target, name))]);
      }
      return [stat.mode, entries];
    }
    // Observe native configuration/auth inputs, not OMP's separate diagnostic log sink.
    const inputs = [agentDir, getAgentDbPath(agentDir), projectDir, overlayPath];
    const original = await Promise.all(inputs.map(snapshot));
    const result = await inspectNativeJudge(cwd);
    const unchanged = Bun.deepEquals(original, await Promise.all(inputs.map(snapshot)));
    console.log(JSON.stringify({ result, unchanged }));
  `], {
    cwd: directory, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: directory,
      PI_CODING_AGENT_DIR: join(directory, "native-agent"),
      XDG_CONFIG_HOME: join(directory, "xdg-config"), XDG_DATA_HOME: join(directory, "xdg-data"),
      XDG_STATE_HOME: join(directory, "xdg-state"), XDG_CACHE_HOME: join(directory, "xdg-cache"),
      NO_COLOR: "1", TERM: "dumb",
    },
  });
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(stdout).not.toContain("judge-auth-secret");
    expect(stdout).not.toContain("private-selector");
    const result = JSON.parse(stdout);
    expect(result.unchanged).toBe(true);
    return result.result;
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
}

describe("deferred native judge inspection", () => {
  test("truly fresh installs and modern empty records do not mistake automatic judge fallback for configuration", async () => {
    expect(await nativeJudgeCase("")).toEqual({ status: "missing", source: "default" });
    expect(await nativeJudgeCase('await writeConfig({ modelRoles: { default: "private-selector/chat" } });'))
      .toEqual({ status: "missing", source: "default" });
  }, 30_000);

  test("unmigrated legacy JSON and account databases leave lower-layer judge configuration unknown", async () => {
    for (const legacy of ["await writeLegacy();", "await writeDb();", "await writeLegacy(); await writeDb();"]) {
      for (const higher of ["", "await writeProject({ modelRoles: { judge: null } });",
        "await writeOverlay({ modelRoles: { default: 'private-selector/chat' } });"]) {
        expect(await nativeJudgeCase(`${legacy} ${higher}`)).toEqual({ status: "unknown" });
      }
    }
  }, 90_000);

  test("both native modern filenames are authoritative despite opaque legacy JSON and database bytes", async () => {
    for (const filenameIndex of [0, 1]) {
      for (const selector of [undefined, "private-selector/judge", " , , ", ["", " "]]) {
        expect(await nativeJudgeCase(`
          await writeLegacy(); await writeDb();
          await Bun.write(join(agentDir, MAIN_CONFIG_FILENAMES[${filenameIndex}]),
            JSON.stringify({ modelRoles: ${JSON.stringify(selector === undefined ? {} : { judge: selector })} }));
        `)).toEqual(selector === "private-selector/judge"
          ? { status: "configured", source: "global" }
          : { status: "missing", source: selector === undefined ? "default" : "global" });
      }
    }
    expect(await nativeJudgeCase(`
      await writeLegacy(); await writeDb();
      await writeConfig({});
      await Bun.write(join(agentDir, MAIN_CONFIG_FILENAMES[1]),
        JSON.stringify({ modelRoles: { judge: "private-selector/hidden-fallback" } }));
    `)).toEqual({ status: "missing", source: "default" });
  }, 90_000);

  test("legacy presence metadata errors are unknown without opening or changing storage", async () => {
    for (const target of ['join(agentDir, "settings.json")', "getAgentDbPath(agentDir)"]) {
      expect(await nativeJudgeCase(`
        await mkdir(dirname(${target}), { recursive: true });
        await symlink(${target}, ${target});
      `)).toEqual({ status: "unknown" });
    }
  }, 30_000);

  test("effective higher-layer assignments settle the judge despite unresolved legacy global state", async () => {
    for (const [layer, write] of [["project", "writeProject"], ["overlay", "writeOverlay"]]) {
      for (const selector of ["private-selector/judge", "", " , , ", [], ["", " "], null]) {
        expect(await nativeJudgeCase(`
          await writeLegacy(); await writeDb();
          await ${write}({ modelRoles: { judge: ${JSON.stringify(selector)} } });
        `)).toEqual(selector === null && layer === "project" ? { status: "unknown" }
          : { status: selector === "private-selector/judge" ? "configured" : "missing", source: layer });
      }
    }
  }, 120_000);

  test("global, project and overlay selectors, aliases and native fallback arrays count without resolution", async () => {
    for (const [layer, write] of [["global", "writeConfig"], ["project", "writeProject"], ["overlay", "writeOverlay"]]) {
      for (const selector of ["private-selector/judge", "@private-selector", "pi/private-selector", "*",
        "@private-selector,private-selector/unavailable", ["@private-selector", "private-selector/unavailable"],
        " , private-selector/judge, ", ["", "private-selector/judge", " "]]) {
        expect(await nativeJudgeCase(`await ${write}({ modelRoles: { judge: ${JSON.stringify(selector)} } });`))
          .toEqual({ status: "configured", source: layer });
      }
    }
  }, 120_000);

  test("delimiter-only strings and arrays contain no configured selector at any native layer", async () => {
    for (const [layer, write] of [["global", "writeConfig"], ["project", "writeProject"], ["overlay", "writeOverlay"]]) {
      for (const selector of [",", " , , \t", ["", " "], [",", " , "]]) {
        expect(await nativeJudgeCase(`await ${write}({ modelRoles: { judge: ${JSON.stringify(selector)} } });`))
          .toEqual({ status: "missing", source: layer });
      }
    }
  }, 90_000);

  test("overlay null and empty effective values hide lower-layer assignments rather than confirming them", async () => {
    for (const selector of [null, "", "   ", []]) {
      expect(await nativeJudgeCase(`
        await writeConfig({ modelRoles: { judge: "private-selector/global" } });
        await writeProject({ modelRoles: { judge: "@private-selector" } });
        await writeOverlay({ modelRoles: { judge: ${JSON.stringify(selector)} } });
      `)).toEqual({ status: "missing", source: "overlay" });
    }
    expect(await nativeJudgeCase(`
      await writeConfig({ modelRoles: { judge: "private-selector/global" } });
      await writeProject({ modelRoles: { judge: null } });
    `)).toEqual({ status: "configured", source: "global" });
    expect(await nativeJudgeCase('await writeConfig({ modelRoles: { judge: "" } });'))
      .toEqual({ status: "missing", source: "global" });
  }, 60_000);

  test("malformed, invalid and unreadable settings are unknown without repair or private diagnostics", async () => {
    for (const before of [
      'await Bun.write(configPath, "modelRoles: [\\nprivate: private-selector-malformed\\n");',
      'await mkdir(projectDir, { recursive: true }); await Bun.write(projectPath, "modelRoles: [\\nprivate: private-selector-project\\n");',
      'await writeOverlay({}); await Bun.write(overlayPath, "modelRoles: [\\nprivate: private-selector-overlay\\n");',
      'await writeConfig({ judgment: { attemptTimeoutMs: -1 }, private: "private-selector-invalid" });',
      'await mkdir(configPath);',
      'process.env.PI_CONFIG_FILES = overlayPath;',
    ]) {
      expect(await nativeJudgeCase(before)).toEqual({ status: "unknown" });
    }
  }, 60_000);
});
