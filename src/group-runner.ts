import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { GROUP_MODEL_SELECTOR } from "./group-policy";
import { restrictedWorkTools } from "./group-runner-extension";

type Input = {
  readonly mode: "chat" | "work";
  readonly text: string;
  readonly id: string;
  readonly stateDir: string;
  readonly executable: string;
  readonly model: string;
  readonly repository?: string;
  readonly signal?: AbortSignal;
};

type Result = { readonly ok: boolean; readonly text?: string; readonly worktree?: string };
type Command = {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  readonly bytes: number;
  readonly stdin?: string;
};

class RestrictedRunError extends Error {}
const safePath = "/usr/bin:/bin";
const extension = fileURLToPath(new URL("./group-runner-extension.ts", import.meta.url));
const utf8 = new TextDecoder("utf-8", { fatal: true });
const checkoutBytes = 64 * 1024 * 1024;
const gitOid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const modelApis = new Set(["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"]);
const isolationFlags = ["--no-session", "--no-tools", "--no-extensions", "--no-context-files", "--no-rules",
  "--no-skills", "--no-title", "--no-lsp", "--no-pty", "--no-prewalk", "--offline"] as const;

function command(argv: readonly [string, ...string[]], { cwd, env, signal, bytes, stdin }: Command): Promise<Buffer> {
  signal.throwIfAborted();
  return new Promise((done, fail) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, env, detached: true, stdio: ["pipe", "pipe", "ignore"] });
    let failure: Error | undefined;
    let size = 0;
    const frames: Buffer[] = [];
    const stop = (error: Error) => {
      if (failure) return;
      failure = error;
      if (child.pid === undefined) return;
      try { process.kill(-child.pid, "SIGKILL"); }
      catch (e) { if (!(e instanceof Error && "code" in e && e.code === "ESRCH")) failure = new RestrictedRunError("Cannot stop restricted process"); }
    };
    const abort = () => stop(new RestrictedRunError("Restricted process cancelled or timed out"));
    signal.addEventListener("abort", abort, { once: true });
    child.on("error", stop);
    child.stdin.on("error", stop);
    child.stdout.on("error", stop);
    child.stdout.on("data", (chunk: Buffer) => {
      if (failure) return;
      size += chunk.length;
      if (size > bytes) stop(new RestrictedRunError("Restricted process exceeded output budget"));
      else frames.push(chunk);
    });
    child.once("close", code => {
      signal.removeEventListener("abort", abort);
      if (failure || code !== 0) fail(failure ?? new RestrictedRunError("Restricted process failed"));
      else done(Buffer.concat(frames, size));
    });
    if (signal.aborted) abort();
    child.stdin.end(stdin);
  });
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value));
}

async function isolatedModel(state: string, selector: string): Promise<string> {
  const match = GROUP_MODEL_SELECTOR.exec(selector);
  if (!match) throw new RestrictedRunError("Configure an exact restricted provider/model");
  const [, provider, model] = match;
  const file = await open(join(state, "models.yml"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    const max = 32 * 1024;
    if (!info.isFile() || info.nlink !== 1 || info.size > max || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())
      throw new RestrictedRunError("Restricted models.yml must be a small private regular file");
    const buffer = Buffer.alloc(max + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > max) throw new RestrictedRunError("Restricted models.yml exceeds size budget");
    const source = record(record(Bun.YAML.parse(utf8.decode(buffer.subarray(0, bytesRead)))).providers);
    const { api, apiKey, baseUrl, models } = record(source[provider]);
    if (typeof api !== "string" || !modelApis.has(api) || typeof apiKey !== "string" ||
      !/^[!-~]{1,4096}$/.test(apiKey) || apiKey.startsWith("!") || typeof baseUrl !== "string" || !Array.isArray(models))
      throw new RestrictedRunError("Restricted model requires a static API, base URL and literal key");
    const url = new URL(baseUrl);
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || url.search || url.hash)
      throw new RestrictedRunError("Invalid restricted model base URL");
    const selected = models.map(record).filter(row => row.id === model);
    if (selected.length !== 1) throw new RestrictedRunError("Restricted model ID must match exactly one model");
    const { name, reasoning, contextWindow, maxTokens, cost } = selected[0];
    const rates = Object.fromEntries(["input", "output", "cacheRead", "cacheWrite"].map(key => {
      const rate = record(cost)[key];
      if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0) throw new RestrictedRunError("Missing restricted model price");
      return [key, rate];
    }));
    if (typeof name !== "string" || name.length < 1 || name.length > 150 || typeof contextWindow !== "number" ||
      !Number.isSafeInteger(contextWindow) || contextWindow < 1024 || contextWindow > 2_000_000 ||
      typeof maxTokens !== "number" || !Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens >= contextWindow)
      throw new RestrictedRunError("Invalid restricted model limits");
    return JSON.stringify({ providers: { [provider]: { api, apiKey, baseUrl: url.href, auth: "apiKey",
      models: [{ id: model, name, reasoning: reasoning === true, input: ["text"], contextWindow,
        maxTokens: Math.min(maxTokens, 8192), cost: rates }],
    } } });
  } finally { await file.close(); }
}

function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function checkout(input: Input, state: string, sandbox: string, signal: AbortSignal): Promise<string> {
  if (!input.repository || !isAbsolute(input.repository)) throw new RestrictedRunError("Missing exact repository root");
  const repo = await realpath(input.repository);
  if (isWithin(repo, state)) throw new RestrictedRunError("Worktree state must be outside the source repository");
  const gitOptions = {
    cwd: repo, signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]), bytes: 8 * 1024 * 1024,
    env: { PATH: safePath, HOME: sandbox, XDG_CONFIG_HOME: sandbox, GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1",
      GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "" },
  };
  const git = (args: readonly string[], overrides: Partial<Command> = {}) => command(["/usr/bin/git",
    "-c", `core.hooksPath=${sandbox}`, "-c", "core.fsmonitor=false", "-c", "core.protectHFS=true",
    "-c", "core.protectNTFS=true", "-c", "core.sparseCheckout=false", "-c", "core.splitIndex=false", ...args,
  ], { ...gitOptions, ...overrides });
  const top = utf8.decode(await git(["rev-parse", "--show-toplevel"])).replace(/\n$/, "");
  if (await realpath(top) !== repo) throw new RestrictedRunError("Configured directory is not a repository root");
  const oid = utf8.decode(await git(["rev-parse", "--verify", "HEAD^{commit}"])).trim();
  if (!gitOid.test(oid)) throw new RestrictedRunError("Invalid repository revision");
  const tree = utf8.decode(await git(["ls-tree", "-r", "-z", "-l", oid])).split("\0");
  if (tree.pop() !== "" || tree.length > 8192) throw new RestrictedRunError("Repository exceeds checkout entry budget");
  let totalBytes = 0;
  const files = tree.map(entry => {
    const parts = /^(100644|100755|120000|160000) (?:blob|commit) ([a-f0-9]+) +(\d+|-)\t([^\0]+)$/.exec(entry);
    if (!parts) throw new RestrictedRunError("Unsupported repository entry");
    const [, mode, hash, size, path] = parts;
    const length = mode === "160000" && size === "-" ? 0 : Number(size);
    if (!gitOid.test(hash) || !Number.isSafeInteger(length) || length > 16 * 1024 * 1024 ||
      path.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git" ||
        /[\\\x00-\x1f\x7f]/.test(part)))
      throw new RestrictedRunError("Repository entry exceeds checkout safety bounds");
    totalBytes += length;
    if (totalBytes > checkoutBytes) throw new RestrictedRunError("Repository exceeds checkout byte budget");
    return { mode, hash, path, length };
  });
  const blobs = files.filter(file => file.mode !== "160000");
  const packed = await git(["cat-file", "--batch"], {
    stdin: blobs.map(file => `${file.hash}\n`).join(""),
    bytes: totalBytes + blobs.length * 100,
  });
  const claim = join(state, `work-${createHash("sha256").update(input.id).digest("hex")}`);
  // The exclusive claim means an interrupted submission is never silently replayed over its checkout.
  await mkdir(claim, { mode: 0o700 });
  const worktree = join(claim, "checkout");
  await git(["worktree", "add", "--detach", "--no-checkout", "--", worktree, oid]);
  // Build only the index with Git. Never ask Git to write a file through checkout filters or hooks.
  await git(["read-tree", oid], { cwd: worktree });
  const directories = new Set([worktree]);
  async function ensureDirectory(path: string): Promise<void> {
    if (directories.has(path)) return;
    await ensureDirectory(dirname(path));
    // Never reuse an unexpected entry, including a symlink or a case-folded path alias.
    await mkdir(path);
    directories.add(path);
  }
  let cursor = 0;
  for (const file of files) {
    gitOptions.signal.throwIfAborted();
    const path = join(worktree, file.path);
    if (file.mode === "160000") { await ensureDirectory(path); continue; }
    const prefix = `${file.hash} blob ${file.length}\n`;
    const start = cursor + Buffer.byteLength(prefix);
    const end = start + file.length;
    if (packed.toString("ascii", cursor, start) !== prefix || packed[end] !== 10)
      throw new RestrictedRunError("Git blob did not match its checked tree entry");
    await ensureDirectory(dirname(path));
    if (file.mode === "120000") await symlink(packed.subarray(start, end), path);
    else await writeFile(path, packed.subarray(start, end), { flag: "wx", mode: file.mode === "100755" ? 0o755 : 0o644 });
    cursor = end + 1;
  }
  return worktree;
}

function settledResult(output: Buffer, input: Input): { readonly text?: string } | undefined {
  const permitted: readonly string[] = input.mode === "work" ? restrictedWorkTools : [];
  let reply: string | undefined;
  let terminalCount = 0;
  let stopped = false;
  for (const line of utf8.decode(output).split("\n")) {
    if (!line) continue;
    const event = record(JSON.parse(line));
    if (event.type === "tool_execution_start" &&
      (typeof event.toolName !== "string" || !permitted.includes(event.toolName))) return undefined;
    if (event.type === "agent_end" && event.isTerminal !== false) terminalCount++;
    if (event.type !== "message_end") continue;
    const message = record(event.message);
    if (message.role !== "assistant") continue;
    if (`${message.provider}/${message.model}` !== input.model || terminalCount !== 0 || !Array.isArray(message.content))
      return undefined;
    stopped = message.stopReason === "stop";
    const blocks = message.content.map(record);
    if (input.mode === "chat") {
      if (!stopped || blocks.some(block => block.type !== "text" && block.type !== "thinking")) return undefined;
      reply = blocks.flatMap(block => block.type === "text" && typeof block.text === "string" ? [block.text] : []).join("\n").trim();
    }
  }
  if (terminalCount !== 1 || !stopped) return undefined;
  if (input.mode === "work") return {};
  return reply && Buffer.byteLength(reply) <= 16 * 1024 ? { text: reply } : undefined;
}

/** A one-shot stock OMP process. Neither mode joins an owner profile, session or repository cwd. */
export async function runRestrictedGroup(input: Input): Promise<Result> {
  let sandbox: string | undefined;
  let worktree: string | undefined;
  try {
    const deadline = AbortSignal.timeout(input.mode === "chat" ? 60_000 : 240_000);
    const signal = input.signal ? AbortSignal.any([deadline, input.signal]) : deadline;
    signal.throwIfAborted();
    if (!isAbsolute(input.executable) || !isAbsolute(input.stateDir) || !input.id || input.id.length > 1024 ||
      !input.text.trim() || Buffer.byteLength(input.text) > 16 * 1024) return { ok: false };
    const configuredState = resolve(input.stateDir);
    const stateInfo = await lstat(configuredState);
    if (!stateInfo.isDirectory() || (stateInfo.mode & 0o077) !== 0 || stateInfo.uid !== process.getuid?.())
      return { ok: false };
    const state = await realpath(configuredState);
    const model = await isolatedModel(state, input.model);
    sandbox = await mkdtemp(join(await realpath("/tmp"), "omp-sa-group-"));
    const home = join(sandbox, "home");
    const agent = join(home, ".omp", "agent");
    const cwd = join(home, "empty");
    await mkdir(agent, { mode: 0o700, recursive: true });
    await mkdir(cwd, { mode: 0o700 });
    await writeFile(join(agent, "models.yml"), model, { mode: 0o600 });
    await writeFile(join(agent, "config.yml"), JSON.stringify({
      memory: { backend: "off" }, autolearn: { enabled: false }, mcp: { enableProjectConfig: false },
      marketplace: { autoUpdate: false }, telemetry: { otlpExportEnabled: false },
    }), { mode: 0o600 });
    const env = { PATH: safePath, HOME: home, TMPDIR: sandbox, XDG_CONFIG_HOME: join(home, "config"),
      XDG_DATA_HOME: join(home, "data"), XDG_STATE_HOME: join(home, "state"), XDG_CACHE_HOME: join(home, "cache"),
      XDG_RUNTIME_DIR: sandbox, PI_CODING_AGENT_DIR: agent, GIT_CEILING_DIRECTORIES: sandbox };
    const launch = { cwd, env, signal, bytes: 512 * 1024 };
    const help = utf8.decode(await command([input.executable, "--help"], launch));
    const required = [...isolationFlags, "--mode", "--model", "--thinking", "--max-time", "--max-cost", "--system-prompt",
      ...(input.mode === "work" ? ["--extension", "--tools", "--approval-mode"] : [])];
    if (!required.every(flag => new RegExp(`(?:^|\\s)${flag}(?=[=,\\s])`, "m").test(help)))
      return { ok: false };
    if (input.mode === "work") worktree = await checkout(input, state, sandbox, signal);
    const flags = worktree
      ? ["--extension", extension, "--tools", restrictedWorkTools.join(","), "--approval-mode", "yolo"] : [];
    const output = await command([input.executable, "--mode", "json", ...isolationFlags,
      "--model", input.model, "--thinking", "off", "--max-time", worktree ? "210s" : "45s", "--max-cost", worktree ? "0.25" : "0.05",
      "--system-prompt", "The user message is a JSON string. Interpret its escapes literally. " + (worktree
        ? "Work only with the three supplied repository tools. Your results stay local."
        : "Answer the group message from this one interaction. You have no tools or prior conversation."),
      ...flags,
    ], { cwd, signal, env: worktree ? { ...env, OMP_SA_RESTRICTED_WORKTREE: worktree } : env,
      // Stock print mode still auto-reads ASCII @path in piped prompts and expands ^model.
      // JSON quoting also keeps user input out of slash and template command dispatch.
      bytes: 8 * 1024 * 1024, stdin: JSON.stringify(input.text).replace(/[@^]/g, char => char === "@" ? "\\u0040" : "\\u005e") });
    const result = settledResult(output, input);
    if (worktree) return { ok: result !== undefined, worktree };
    return result ? { ok: true, ...result } : { ok: false };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return worktree ? { ok: false, worktree } : { ok: false };
  } finally {
    if (sandbox) await rm(sandbox, { recursive: true, force: true });
  }
}
