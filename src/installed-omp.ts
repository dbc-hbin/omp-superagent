import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Resolve outside dependency shims, including PATH injected by bun run/install. */
export function discoverInstalledOmp(path = process.env.PATH ?? ""): string {
  for (const directory of path.split(delimiter)) {
    if (!directory || /(?:^|[/\\])node_modules(?:[/\\]|$)/.test(directory)) continue;
    const candidate = Bun.which("omp", { PATH: directory });
    if (!candidate) continue;
    const executable = realpathSync(candidate);
    if (executable.startsWith(join(root, "node_modules") + "/")) continue;
    return executable;
  }
  throw new Error("An installed stock OMP is required on PATH, or configure its executable directly");
}

/** Resolve path-like executables before any change to the launch working directory. */
export function resolveOmpCommand(command: string[], path = process.env.PATH ?? "", cwd = process.cwd()): string[] {
  const [entry, ...args] = command;
  if (!entry) throw new Error("Configure an installed OMP executable");
  const executable = entry === "omp" ? discoverInstalledOmp(path) : entry.includes("/") ? resolve(cwd, entry) : entry;
  if ([executable, ...args].some(arg => isAbsolute(arg) && resolve(arg).startsWith(join(root, "node_modules") + "/")))
    throw new Error("Configure a separately installed OMP executable, not this project's SDK dependency");
  return [executable, ...args];
}

type InstalledOmp = Awaited<ReturnType<typeof probeInstalledOmp>>;
const inspected = new Map<string, { identity: string; result: Promise<InstalledOmp> }>();
const EXECUTION_ENV_KEYS = [
  "PATH",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "DYLD_LIBRARY_PATH",
  "DYLD_FALLBACK_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
] as const;

function fileIdentity(filePath: string): [string, ...string[]] {
  const target = realpathSync(filePath);
  const { dev, ino, size, mtimeNs, ctimeNs } = statSync(target, { bigint: true });
  return [target, dev.toString(), ino.toString(), size.toString(), mtimeNs.toString(), ctimeNs.toString()];
}

function readShebangTokens(filePath: string): string[] | null {
  const fd = openSync(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(256);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    if (bytes < 2 || buffer[0] !== 0x23 || buffer[1] !== 0x21) return null;
    const line = buffer.subarray(2, bytes).toString("utf8");
    const newline = line.indexOf("\n");
    const trimmed = (newline >= 0 ? line.slice(0, newline) : line).replace(/\r$/, "").trim();
    return trimmed ? trimmed.split(/[ \t]+/) : [];
  } finally {
    closeSync(fd);
  }
}

function resolveEnvCommand(tokens: readonly string[], path: string): string | null {
  let index = 1;
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (token === "--") { index++; break; }
    if (token.startsWith("-") && token.length > 1) {
      if ((token === "-u" || token === "--unset" || token === "-C" || token === "--chdir" || token === "-a" || token === "--argv0")
        && index + 1 < tokens.length) {
        index += 2;
        continue;
      }
      index++;
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) { index++; continue; }
    break;
  }
  const target = tokens[index];
  if (!target) return null;
  if (isAbsolute(target) || target.includes("/")) return resolve(target);
  return Bun.which(target, { PATH: path });
}

/**
 * The kernel-executed file plus its shebang interpreter and loader environment:
 * replacing, rewriting or retargeting the binary/script, or changing PATH/LD_*
 * changes this identity. Returns null when a required shebang target is missing.
 */
function executionIdentity(
  executable: string, path: string, credentials: readonly string[], environment: NodeJS.ProcessEnv,
): string | null {
  const files: [string, ...string[]][] = [];
  const seen = new Set<string>();
  let current: string | null = executable;
  for (let depth = 0; depth < 4 && current; depth++) {
    const id = fileIdentity(current);
    if (seen.has(id[0])) break;
    seen.add(id[0]);
    files.push(id);
    const tokens = readShebangTokens(id[0]);
    if (!tokens) break;
    const interpreter = tokens[0];
    if (!interpreter) return null;
    const resolvedInterp = isAbsolute(interpreter) || interpreter.includes("/")
      ? resolve(interpreter)
      : Bun.which(interpreter, { PATH: path });
    if (!resolvedInterp) return null;
    if (basename(interpreter) === "env") {
      files.push(fileIdentity(resolvedInterp));
      const target = resolveEnvCommand(tokens, path);
      if (!target) return null;
      current = target;
      continue;
    }
    current = resolvedInterp;
  }
  const env = EXECUTION_ENV_KEYS.map(name => credentials.includes(name) ? null : environment[name] ?? null);
  return JSON.stringify({ files, env });
}

/**
 * Inspect CLI metadata only; never open an agent or provider session.
 * Results are reused in this process while the configured executable's file
 * identity, shebang interpreter, and execution environment are unchanged, so
 * repeated Host starts do not respawn the probes.
 */
export async function inspectInstalledOmp(
  command: string[], credentials: string[] = [], environment: NodeJS.ProcessEnv = process.env,
): Promise<InstalledOmp> {
  const path = environment.PATH ?? "";
  const [entry] = resolveOmpCommand(command, path);
  const executable = entry && (isAbsolute(entry) ? entry : Bun.which(entry, { PATH: path }));
  if (!executable) throw new Error(`Cannot find the configured OMP executable ${entry ?? ""} on PATH`);
  let identity: string | null;
  try { identity = executionIdentity(executable, path, credentials, environment); }
  catch { return probeInstalledOmp(executable, credentials, environment); }
  if (identity === null) return probeInstalledOmp(executable, credentials, environment);
  const cached = inspected.get(executable);
  if (cached?.identity === identity) return cached.result;
  const result = probeInstalledOmp(executable, credentials, environment);
  inspected.set(executable, { identity, result });
  const forget = () => { if (inspected.get(executable)?.result === result) inspected.delete(executable); };
  try {
    const value = await result;
    // A file replaced while it was probed may not be the one that answered.
    let unchanged = false;
    try { unchanged = executionIdentity(executable, path, credentials, environment) === identity; } catch {}
    if (!unchanged) forget();
    return value;
  } catch (error) {
    forget();
    throw error;
  }
}

async function probeInstalledOmp(
  executable: string, credentials: string[], environment: NodeJS.ProcessEnv,
) {
  const env = { ...environment };
  for (const name of credentials) delete env[name];
  const probe = async (...args: string[]) => {
    // Require the CLI itself, not a runtime/script wrapper with an ambiguous
    // native argv boundary. Metadata inspection never loads launch extensions.
    const child = Bun.spawn([executable, ...args], {
      // Unlike --version, root help loads the CLI's bundled native addon.
      // Its first extraction and load on macOS can take more than ten seconds.
      env, stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: args[0] === "--version" ? 10_000 : 30_000,
    });
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    if (code !== 0) throw new Error(`OMP executable ${executable}: ${args.join(" ")} failed (${code}); diagnostic output suppressed to protect credentials`);
    return stdout;
  };
  const version = (await probe("--version")).trim().match(/^omp\/(\S+)$/)?.[1];
  if (!version)
    throw new Error(`${executable} did not identify as OMP; configure its executable directly, not a runtime/script wrapper`);
  const help = await probe("--help");
  const flags = ["--mode", "--resume", "--extension", "--model"];
  if (!flags.every(flag => new RegExp(`${flag}(?=[\\s,=])`).test(help)) || !/(?<![\w-])rpc-ui(?![\w-])/.test(help))
    throw new Error(`OMP ${version} at ${executable} must support public stdio RPC (rpc-ui), session resume, extensions, and model selection`);
  // Match the selected executable's process interface, not the package SDK or
  // a failed/empty daemon observation. Both CLIs advertise these on ps only.
  const processes = await probe("ps", "--help");
  const broker = /--global(?=[\s,=])/.test(processes);
  const daemon = /--signal(?=[\s,=])/.test(processes);
  if (broker === daemon)
    throw new Error(`OMP ${version} at ${executable} has an unrecognized process ownership interface (ps --help)`);
  const processBackend = broker ? "broker" as const : "daemon" as const;
  return {
    executable, version, processBackend,
    stdioRpc: true, sessions: true, extensions: true, modelSelection: true,
  };
}
