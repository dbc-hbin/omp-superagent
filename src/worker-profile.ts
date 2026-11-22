import { Database } from "bun:sqlite";
import { lstatSync, realpathSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { readWorkerFile } from "./worker-registration";
import { gitWorkerRepository } from "./worker-repository";
import { WorkerRefusal } from "./worker-request";
import { trustedWorkerPath, workerInstallRoot } from "./worker-trust";
import type { WorkerPolicy, WorkerRepo } from "./worker-wire";

export interface WorkerHostProfile {
  readonly config: Readonly<Record<string, unknown>>;
  readonly flags: readonly string[];
  readonly extensionPaths: readonly string[];
  readonly managedUlwPath: string;
}

const flags = ["--no-extensions", "--no-lsp"] as const;
// --no-extensions is necessary but does not suppress all stock custom tool and
// MCP discovery. Keep only the explicitly composed OMP extension roots and
// builtin resources. Reject independent project config before the CLI starts.
const config = {
  disabledProviders: ["native", "agent-plugins", "agents", "agents-md", "claude", "claude-md", "claude-plugins",
    "cline", "codex", "cursor", "custom-context", "gemini", "github", "mcp-json", "opencode", "skillshare",
    "ssh-config", "ssh-json", "vscode", "windsurf"],
  mcp: { enableProjectConfig: false },
  marketplace: { autoUpdate: false },
  skills: { customDirectories: [], enablePiProject: false, enableAgentsProject: false, enableClaudeProject: false },
};
const dotenv = [".env", ".env.local", ".env.development", ".env.development.local",
  ".env.production", ".env.production.local", ".env.test", ".env.test.local"];
const projectInputs = [...dotenv, "bunfig.toml", ".omp", ".pi", ".claude", ".codex", ".cursor", ".gemini",
  ".opencode", ".agent", ".agents", ".cline", ".windsurf", ".codeium", ".omp-plugin", ".claude-plugin",
  "mcp.json", ".mcp.json", ".vscode/mcp.json", "opencode.json", "opencode.jsonc", "WATCHDOG.yml", "WATCHDOG.yaml"];
const providerEnvironment = [
  "ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "OPENAI_API_KEY", "GEMINI_API_KEY", "COPILOT_GITHUB_TOKEN",
  "AZURE_OPENAI_API_KEY", "GROQ_API_KEY", "CEREBRAS_API_KEY", "XAI_API_KEY", "OPENROUTER_API_KEY",
  "KILO_API_KEY", "MISTRAL_API_KEY", "ZAI_API_KEY", "UMANS_AI_CODING_PLAN_API_KEY", "ABLITERATION_API_KEY",
  "KIRO_API_KEY", "MINIMAX_API_KEY", "OPENCODE_API_KEY", "CURSOR_ACCESS_TOKEN", "CLINE_API_KEY",
  "COMMAND_CODE_API_KEY", "CHARM_HYPER_API_KEY", "AI_GATEWAY_API_KEY", "STEPFUN_API_KEY", "HELMCODE_API_KEY",
  "WAFER_SERVERLESS_API_KEY", "YOLO_AUTO_API_KEY", "SINGULARITYAPI_DEV_API_KEY", "SINGULARITYAPI_TECH_API_KEY",
  "SCW_SECRET_KEY", "OTARI_API_KEY",
] as const;

const controls = /[\u0000-\u001f\u007f]/;
const appData = ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"] as const;
const gitSettings = [
  /^core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks|autocrlf|eol|safecrlf)$/,
  /^extensions\.objectformat$/,
  /^remote\.[A-Za-z0-9._/-]+\.(url|pushurl|fetch|push|tagopt|prune|prunetags|mirror|followremotehead)$/,
  /^branch\.[A-Za-z0-9._/-]+\.(remote|merge|rebase|pushremote|description)$/,
  /^user\.(name|email|useconfigonly)$/,
];

/** Stock sources read cwd, its Git root and, for plugin registries, ancestors above the root. */
export function assertWorkerWorkspaceStartup(cwd: string, home: string): void {
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (dir === home || (dir !== cwd && ["/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp"].includes(dir))) break;
    for (const name of projectInputs) {
      if (lstatSync(join(dir, name), { throwIfNoEntry: false }))
        throw new WorkerRefusal(`Worker startup refuses project configuration (${name}); use a checkout without ambient OMP inputs`);
    }
    if (dirname(dir) === dir) break;
  }
}

function readProfileFile(path: string, mode?: number): Buffer | undefined {
  try { return readWorkerFile(path, mode); }
  catch (cause) { throw new WorkerRefusal("Worker profile input must be a bounded regular file with safe ownership and permissions", { cause }); }
}

function containsCommand(doc: unknown): boolean {
  const pending = [doc];
  const seen = new WeakSet<object>();
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === "string" && value.startsWith("!")) return true;
    if (value === null || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    for (const child of Object.values(value)) pending.push(child);
  }
  return false;
}

function assertWorkerAuthDatabase(path: string): void {
  if (!lstatSync(path, { throwIfNoEntry: false })) return;
  let commandBacked: boolean;
  try {
    using db = new Database(path, { readonly: true });
    db.run("PRAGMA trusted_schema = OFF");
    // Stock OMP 19.0.0 stores enabled API keys as JSON { key, source? }.
    // Query just the presence flag: do not load the stock store or return any credential fields.
    const table = db.query<{ type: string }, []>("PRAGMA main.table_list('auth_credentials')").get();
    if (!table) return;
    if (table.type !== "table") throw new WorkerRefusal("Worker auth credentials must be stored in a regular SQLite table");
    const columns = db.query<{ name: string }, []>("PRAGMA main.table_info(auth_credentials)").all();
    const active = columns.some(column => column.name === "disabled_cause") ? "c.disabled_cause IS NULL"
      : columns.some(column => column.name === "disabled") ? "c.disabled IS NOT 1" : "1";
    // The stock OAuth deserializer spreads persisted fields over its type marker.
    commandBacked = db.query<{ blocked: number }, []>(`
      SELECT EXISTS (
        SELECT 1 FROM main.auth_credentials AS c CROSS JOIN json_each(c.data) AS entry
        WHERE ${active} AND entry.key = 'key' AND entry.type = 'text' AND substr(entry.value, 1, 1) = '!'
          AND (c.credential_type = 'api_key' OR (c.credential_type = 'oauth' AND EXISTS (
            SELECT 1 FROM json_each(c.data) WHERE key = 'type' AND value = 'api_key'
          )))
      ) AS blocked
    `).get()?.blocked === 1;
  } catch (error) {
    if (error instanceof WorkerRefusal) throw error;
    throw new WorkerRefusal("Worker profile auth database could not be verified");
  }
  if (commandBacked) throw new WorkerRefusal("Worker profile does not allow command-backed auth credentials");
}

function workerProfileInputs(agent: string, repos: WorkerPolicy["repos"]) {
  const disabledProviders = new Set(config.disabledProviders);
  for (const name of ["config.yml", "config.yaml", "models.yml", "models.yaml", "models.json", "settings.json", "auth.json"]) {
    const data = readProfileFile(join(agent, name), 0o644);
    if (!data) continue;
    let parsed: unknown;
    try { parsed = name.endsWith(".json") ? JSON.parse(data.toString("utf8")) : Bun.YAML.parse(data.toString("utf8")); }
    catch { throw new WorkerRefusal("Worker profile settings, models or legacy auth could not be verified"); }
    // Model and auth config's !command form runs in the selected project cwd.
    if (containsCommand(parsed)) {
      if (name === "auth.json") throw new WorkerRefusal("Worker profile does not allow command-backed auth credentials");
      throw new WorkerRefusal("Worker profile does not allow command-backed settings or model credentials");
    }
    if ((name.startsWith("config.") || name === "settings.json") && parsed && typeof parsed === "object") {
      // The stock broker may supply or refresh API-key records that local preflight cannot verify.
      const auth = "auth" in parsed ? parsed.auth : undefined;
      const broker = auth && typeof auth === "object" && "broker" in auth ? auth.broker : undefined;
      if (("auth.broker.url" in parsed && typeof parsed["auth.broker.url"] === "string" && parsed["auth.broker.url"]) ||
          (broker && typeof broker === "object" && "url" in broker && typeof broker.url === "string" && broker.url))
        throw new WorkerRefusal("Worker profile does not allow auth brokers; use locally stored credentials");
      if ("disabledProviders" in parsed) {
        const configured = parsed.disabledProviders;
        if (Array.isArray(configured) && configured.every(provider => typeof provider === "string")) {
          for (const provider of configured) disabledProviders.add(provider);
        } else if (configured !== undefined && configured !== null) {
          throw new WorkerRefusal("Worker profile does not allow path-specific discovery provider settings");
        }
      }
    }
  }
  const data = readProfileFile(join(agent, "worker-extensions.json"));
  if (!data) return { disabledProviders: [...disabledProviders], extensionPaths: [] };
  let value: unknown;
  try { value = JSON.parse(data.toString("utf8")); }
  catch (cause) { throw new WorkerRefusal("Invalid worker-extensions.json", { cause }); }
  if (!Array.isArray(value) || value.length > 32)
    throw new WorkerRefusal("worker-extensions.json must list at most 32 absolute extension module files");
  const extensionPaths = [...new Set(value.map((entry: unknown) => {
    if (typeof entry !== "string" || !/\.(ts|[mc]?js)$/.test(entry) || entry.endsWith(".d.ts"))
      throw new WorkerRefusal("worker-extensions.json requires absolute extension module files, not packages or directories");
    return trustedWorkerPath(entry, repos, "file");
  }))];
  return { disabledProviders: [...disabledProviders], extensionPaths };
}

function pathEnvironment(source: NodeJS.ProcessEnv, repos: WorkerPolicy["repos"]): string {
  const dirs = new Set<string>();
  for (const raw of (source.PATH ?? "").split(delimiter)) {
    if (!isAbsolute(raw) || controls.test(raw)) continue;
    try { dirs.add(trustedWorkerPath(realpathSync(raw), repos, "directory")); }
    catch (error) {
      if (!(error instanceof WorkerRefusal) && !(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  for (const dir of ["/usr/bin", "/bin", "/usr/sbin", "/sbin"])
    if (lstatSync(dir, { throwIfNoEntry: false })) dirs.add(realpathSync(dir));
  return [...dirs].join(delimiter);
}

/** Project checks and target profile checks run before either OMP or the SDK preparation process starts. */
export function workerLaunchProfile(policy: WorkerPolicy, cwd: string, source: NodeJS.ProcessEnv = process.env) {
  const { repos, stateDir, command } = policy;
  const executable = command[0];
  if (command.length !== 1 || executable === undefined)
    throw new WorkerRefusal("Worker startup requires one enrolled stock OMP executable, with no extra arguments");
  const home = trustedWorkerPath(source.HOME ?? "", repos, "directory");
  assertWorkerWorkspaceStartup(cwd, home);
  assertWorkerWorkspaceStartup(stateDir, home);
  trustedWorkerPath(executable, repos, "file");
  trustedWorkerPath(workerInstallRoot, repos, "directory");
  trustedWorkerPath(realpathSync(process.execPath), repos, "file");

  const named = (source.OMP_PROFILE ?? source.PI_PROFILE)?.trim();
  const profileName = named && named !== "default" ? named : undefined;
  if (profileName && (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(profileName) || profileName.endsWith(".") ||
      /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)/i.test(profileName)))
    throw new WorkerRefusal("Invalid target OMP profile name");
  const base = join(home, ".omp");
  const root = trustedWorkerPath(profileName ? join(base, "profiles", profileName) : base, repos, "profile");
  const defaultAgent = join(root, "agent");
  const agent = trustedWorkerPath((profileName ? undefined : source.PI_CODING_AGENT_DIR) || defaultAgent, repos, "profile");
  const env: Record<string, string> = {
    HOME: home, PATH: pathEnvironment(source, repos), PI_CODING_AGENT_DIR: agent,
    ...(profileName ? { OMP_PROFILE: profileName } : {}),
    // Stock OMP can also ask Git about the current workspace during startup.
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_VALUE_0: "false",
    GIT_CONFIG_KEY_1: "core.hooksPath", GIT_CONFIG_VALUE_1: "/dev/null",
  };
  for (const name of ["LANG", "LC_ALL", "LC_CTYPE", "NO_COLOR", ...providerEnvironment]) {
    const value = source[name];
    if (value && !value.includes("\0")) env[name] = value;
  }
  const dataRoots = new Set([agent]);
  const pluginRoots = new Set([root]);
  let authDbRoot = agent;
  for (const name of appData) {
    const value = source[name];
    if (!value) continue;
    env[name] = trustedWorkerPath(value, repos, "profile");
    const xdgBase = trustedWorkerPath(join(value, "omp"), repos, "profile");
    const xdgProfile = trustedWorkerPath(profileName ? join(xdgBase, "profiles", profileName) : xdgBase, repos, "profile");
    if (name === "XDG_DATA_HOME") {
      dataRoots.add(xdgProfile);
      pluginRoots.add(xdgProfile);
      // Stock DirResolver uses XDG data only for the standard agent directory
      // and only when the applicable app/profile directory already exists.
      if (agent === defaultAgent && lstatSync(xdgProfile, { throwIfNoEntry: false })) authDbRoot = xdgProfile;
    }
  }
  for (const dir of new Set([home, base, root, agent])) {
    if ([...dotenv, ".bunfig.toml", "bunfig.toml"].some(name => lstatSync(join(dir, name), { throwIfNoEntry: false })))
      throw new WorkerRefusal("Worker startup does not read target dotenv or Bun preload configuration; use the target profile's stored auth");
  }
  for (const dir of pluginRoots) {
    const plugins = trustedWorkerPath(join(dir, "plugins"), repos, "profile");
    if (lstatSync(join(plugins, "node_modules"), { throwIfNoEntry: false }))
      throw new WorkerRefusal("Worker OMP profile has ambient plugin code; select a dedicated profile and explicitly allow worker extensions");
  }
  for (const dir of dataRoots) {
    for (const name of ["agent.db", "agent.db-wal", "agent.db-shm", "models.db", "models.db-wal", "models.db-shm"]) {
      const path = join(dir, name);
      if (lstatSync(path, { throwIfNoEntry: false })) trustedWorkerPath(path, repos, "file");
    }
  }
  const { disabledProviders, extensionPaths } = workerProfileInputs(agent, repos);
  assertWorkerAuthDatabase(join(authDbRoot, "agent.db"));
  return { env, profile: { config: { ...config, disabledProviders }, flags, extensionPaths }, executable };
}

export async function workerManagedUlwPath(repos: WorkerPolicy["repos"]): Promise<string> {
  const { activeManagedUlw } = await import("./managed-ulw");
  try { return trustedWorkerPath(activeManagedUlw(), repos, "directory"); }
  catch (cause) { throw new WorkerRefusal("Worker requires an active operator-installed managed superkit outside enrolled checkouts", { cause }); }
}

/** Stock Git may interpret more configuration than the read-only checkout verifier. */
export async function assertWorkerGitStartup(repo: WorkerRepo): Promise<void> {
  const metadata = join(repo.cwd, ".git");
  const configFile = join(metadata, "config");
  const stat = lstatSync(configFile, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0 ||
      lstatSync(join(metadata, "config.worktree"), { throwIfNoEntry: false }))
    throw new WorkerRefusal("Worker startup requires an owned regular Git config without worktree overrides");
  const values = await gitWorkerRepository(repo.cwd, ["config", "--local", "--no-includes", "--null", "--list"]);
  if (!values?.endsWith("\0") || values.slice(0, -1).split("\0").some(entry => {
    const key = entry.split("\n", 1)[0] ?? "";
    return !gitSettings.some(allowed => allowed.test(key));
  })) throw new WorkerRefusal("Worker startup refuses nonstandard local Git configuration (including hooks, filters and includes)");
}

/** Required public launch switches must be advertised by the enrolled binary, not the bundled SDK. */
export async function requireWorkerStartupFlags(executable: string, cwd: string, env: Record<string, string>): Promise<void> {
  const child = Bun.spawn([executable, "--help"], {
    cwd, env, stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 30_000, killSignal: "SIGKILL",
  });
  const [help, exit] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (exit !== 0 || !flags.every(flag => new RegExp(`(?:^|\\s)${flag}(?=[\\s,=]|$)`, "m").test(help)))
    throw new WorkerRefusal("Enrolled stock OMP does not support the required worker startup isolation flags");
}
