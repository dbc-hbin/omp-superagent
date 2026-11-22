import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workerLaunchProfile } from "../src/worker-profile";
import { WorkerRefusal } from "../src/worker-request";
import type { WorkerPolicy } from "../src/worker-wire";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const home = mkdtempSync(join(realpathSync("/tmp"), "wp-"));
  roots.push(home);
  const cwd = join(home, "checkout");
  const stateDir = join(home, "worker-state");
  mkdirSync(cwd);
  mkdirSync(stateDir);
  const policy: WorkerPolicy = {
    workerId: "fixture-worker", stateDir, repos: [{ id: "a".repeat(64), cwd }], capacity: 1,
    command: [realpathSync(process.execPath)],
  };
  const marker = join(cwd, "auth-command-ran");
  const key = `!printf fixture-only > "${marker}"`;
  const launch = (env: NodeJS.ProcessEnv = {}) => workerLaunchProfile(policy, cwd, { HOME: home, ...env });
  return { home, marker, key, launch };
}

function authDb(dir: string): Database {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "agent.db");
  writeFileSync(path, "", { mode: 0o600, flag: "wx" });
  const db = new Database(path);
  db.run(`CREATE TABLE auth_credentials (
    id INTEGER PRIMARY KEY, provider TEXT NOT NULL, credential_type TEXT NOT NULL, data TEXT NOT NULL,
    disabled_cause TEXT, identity_key TEXT, created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0
  )`);
  return db;
}

test.each([
  ["default", ".omp/agent", false, false, false],
  ["explicit agent override despite XDG", "custom/agent", false, true, true],
  ["default XDG", "xdg/omp", false, true, false],
  ["named profile in XDG", "xdg/omp/profiles/fixture", true, true, false],
  ["named profile without XDG profile directory", ".omp/profiles/fixture/agent", true, true, false],
] as const)("worker refuses command-backed auth in the effective %s database", (_location, folder, named, xdg, override) => {
  const { home, key, launch, marker } = fixture();
  if (xdg) mkdirSync(join(home, "xdg", "omp"), { recursive: true });
  using db = authDb(join(home, folder));
  db.run("INSERT INTO auth_credentials (provider, credential_type, data) VALUES (?, ?, ?)",
    ["fixture-provider", "api_key", JSON.stringify({ key, source: "login" })]);

  expect(() => launch({
    ...(named ? { OMP_PROFILE: "fixture" } : {}),
    ...(xdg ? { XDG_DATA_HOME: join(home, "xdg") } : {}),
    ...(override ? { PI_CODING_AGENT_DIR: join(home, folder) } : {}),
  })).toThrow(/^Worker profile does not allow command-backed auth credentials$/);
  expect(existsSync(marker)).toBe(false);
});

test("worker inspects committed WAL credentials without running or exposing the command", () => {
  const { home, key, launch, marker } = fixture();
  const agent = join(home, ".omp", "agent");
  using db = authDb(agent);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA wal_autocheckpoint = 0");
  db.run("INSERT INTO auth_credentials (provider, credential_type, data) VALUES (?, ?, ?)",
    ["fixture-provider", "api_key", JSON.stringify({ key }).replace("!", "\\u0021")]);
  expect(existsSync(join(agent, "agent.db-wal"))).toBe(true);

  expect(launch).toThrow(/^Worker profile does not allow command-backed auth credentials$/);
  expect(existsSync(marker)).toBe(false);
});

test("worker refuses a command-backed key in a legacy SQLite auth table before stock migration", () => {
  const { home, key, launch } = fixture();
  const agent = join(home, ".omp", "agent");
  mkdirSync(agent, { recursive: true });
  using db = new Database(join(agent, "agent.db"));
  db.run("CREATE TABLE auth_credentials (credential_type TEXT, data TEXT, disabled INTEGER)");
  db.run("INSERT INTO auth_credentials VALUES (?, ?, ?)", ["api_key", JSON.stringify({ key }), 0]);

  expect(launch).toThrow(/^Worker profile does not allow command-backed auth credentials$/);
});

test("worker preserves normal local authentication and ignores a disabled key and a shadowed database", () => {
  const { home, key, launch } = fixture();
  const agent = join(home, ".omp", "agent");
  const xdg = join(home, "xdg");
  const live = join(xdg, "omp");
  using fallback = authDb(agent);
  using db = authDb(live);
  fallback.run("INSERT INTO auth_credentials (provider, credential_type, data) VALUES (?, ?, ?)",
    ["shadowed", "api_key", JSON.stringify({ key })]);
  const insert = db.prepare("INSERT INTO auth_credentials (provider, credential_type, data, disabled_cause) VALUES (?, ?, ?, ?)");
  insert.run("plain", "api_key", JSON.stringify({ key: "fixture-literal" }), null);
  insert.run("disabled", "api_key", JSON.stringify({ key }), "disabled");
  insert.run("oauth", "oauth", JSON.stringify({ access: "!opaque-fixture-token", refresh: "fixture-refresh", expires: 123 }), null);
  const filename = join(live, "agent.db");
  const before = readFileSync(filename);

  expect(launch({ XDG_DATA_HOME: xdg, OPENAI_API_KEY: "fixture-env" }).env).toMatchObject({
    PI_CODING_AGENT_DIR: agent, XDG_DATA_HOME: xdg, OPENAI_API_KEY: "fixture-env",
  });
  expect(readFileSync(filename).equals(before)).toBe(true);
});

test.each([
  ["legacy stored credential", "auth.json", (key: string) => JSON.stringify({ fixture: { type: "api_key", key } }),
    /command-backed auth credentials/],
  ["command-backed broker token", "config.yaml", (key: string) => JSON.stringify({ "auth.broker.token": key }),
    /command-backed settings or model credentials/],
  ["nested broker URL", "config.yaml", () => JSON.stringify({ auth: { broker: { url: "https://example.invalid" } } }),
    /does not allow auth brokers/],
  ["dotted broker URL", "config.yml", () => JSON.stringify({ "auth.broker.url": "https://example.invalid" }),
    /does not allow auth brokers/],
] as const)("worker refuses %s in %s", (_setting, filename, contents, error) => {
  const { home, key, launch, marker } = fixture();
  const agent = join(home, ".omp", "agent");
  mkdirSync(agent, { recursive: true });
  writeFileSync(join(agent, filename), contents(key), { mode: 0o600 });

  expect(launch).toThrow(error);
  expect(existsSync(marker)).toBe(false);
});

test("worker fails closed with no credential detail when local auth storage is unreadable", () => {
  const { home, launch } = fixture();
  const agent = join(home, ".omp", "agent");
  mkdirSync(agent, { recursive: true });
  writeFileSync(join(agent, "agent.db"), "invalid SQLite with fixture-secret", { mode: 0o600 });

  try { launch(); }
  catch (error) {
    expect(error).toBeInstanceOf(WorkerRefusal);
    expect(error).toHaveProperty("message", "Worker profile auth database could not be verified");
    expect(error).not.toHaveProperty("cause");
    return;
  }
  throw new Error("An unreadable auth database did not refuse worker startup");
});
