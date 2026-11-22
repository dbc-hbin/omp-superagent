import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { WorkerLaneRef } from "./worker-wire";

const gitOid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const controls = /[\u0000-\u001f\u007f]/;
const gitTimeoutMs = 10_000;

function gitProcess(cwd: string, args: readonly string[], timeout?: number) {
  return Bun.spawn(["/usr/bin/git", "--no-pager", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null",
    "-c", "core.untrackedCache=false", "-c", "core.excludesFile=/dev/null", ...args], {
    cwd, env: {
      PATH: "/usr/bin:/bin", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1",
      GIT_NO_REPLACE_OBJECTS: "1", GIT_ALLOW_PROTOCOL: "",
    },
    stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout, killSignal: "SIGKILL",
  });
}

/** Read the local Git repository without ambient Git configuration, hooks, or network access. */
export async function gitWorkerRepository(cwd: string, args: readonly string[]): Promise<string | null> {
  const git = gitProcess(cwd, args, gitTimeoutMs);
  const reader = git.stdout.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let output = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 256 * 1024) {
        git.kill("SIGKILL");
        await reader.cancel();
        await git.exited;
        return null;
      }
      output += decoder.decode(value, { stream: true });
    }
    return await git.exited === 0 ? output + decoder.decode() : null;
  } finally {
    reader.releaseLock();
  }
}

function unavailablePath(error: unknown): boolean {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    && ["ENOENT", "ENOTDIR", "ELOOP", "EACCES", "EPERM", "EINVAL"].includes(error.code);
}

async function checkoutRoot(canonical: string): Promise<string | null> {
  const layout = await gitWorkerRepository(canonical,
    ["rev-parse", "--path-format=absolute", "--show-toplevel", "--absolute-git-dir", "--git-common-dir"]);
  const [root, gitDir, commonDir, end, ...extra] = layout?.split("\n") ?? [];
  if (!root || !isAbsolute(root) || controls.test(root) || end !== "" || extra.length) return null;
  const metadata = join(root, ".git");
  // Keep both the index and objects in the checkout approved by the operator.
  // A gitfile, linked worktree, symlink or changed effective layout is not that checkout.
  if (gitDir !== metadata || commonDir !== metadata || await realpath(root) !== root
    || !(await lstat(metadata)).isDirectory()) return null;
  return root;
}

async function repositoryIdentity(root: string): Promise<string | null> {
  // Resolve effective fetch URLs locally, including insteadOf rules. Require
  // exactly one URL, and omit credentials from the hashed identity.
  const output = await gitWorkerRepository(root, ["remote", "get-url", "--all", "origin"]);
  if (output === null) return null;
  const [origin, end, ...extra] = output.split("\n");
  if (!origin || end !== "" || extra.length || /[\s?#\\]/u.test(origin)) return null;
  const scp = /^(?:([A-Za-z0-9_.-]+)@)?([A-Za-z0-9.-]+):([^/][^:]*)$/.exec(origin);
  const url = URL.parse(scp ? `ssh://${scp[1] ? `${scp[1]}@` : ""}${scp[2]}/${scp[3]}` : origin);
  if (!url || !["http:", "https:", "ssh:"].includes(url.protocol)
    || !/^[A-Za-z0-9.-]+$/.test(url.hostname)
    || (url.protocol === "ssh:" && (!url.username || url.password))) return null;
  // Check the spelling before URL's dot-segment normalization. Do not guess
  // whether an escaping form or URL query names another repo.
  const rawPath = scp?.[3] ?? /^[A-Za-z]+:\/\/[^/]+\/(.+)$/.exec(origin)?.[1];
  const path = rawPath?.replace(/\/$/, "");
  if (!path || !/^[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/.test(path)
    || path.split("/").some(part => part === "." || part === "..")) return null;
  const host = url.hostname.toLowerCase();
  // These public forges use the same repository paths across SSH/HTTPS. For
  // other servers, different transports can map identical paths differently.
  const publicForge = ["github.com", "gitlab.com", "bitbucket.org"].includes(host) && !url.port
    && (url.protocol === "https:" || (url.protocol === "ssh:" && url.username === "git"));
  // Never interpret a private server's relative SCP path as an absolute SSH path.
  const repoPath = publicForge ? path.replace(/\.git$/, "") : path;
  if (!repoPath || (publicForge && (!repoPath.includes("/") || repoPath.endsWith("/")))) return null;
  const identity = publicForge
    ? JSON.stringify(["forge", host, repoPath])
    : JSON.stringify([scp ? "scp" : url.protocol, host, url.port, repoPath, url.protocol === "ssh:" ? url.username : ""]);
  return createHash("sha256").update(identity).digest("hex");
}

/** Match only a full, unambiguous network origin. Never expose it or its credentials. */
export async function workerRepositoryIdentity(cwd: string): Promise<string | null> {
  try {
    const root = await checkoutRoot(await realpath(cwd));
    return root && await repositoryIdentity(root);
  } catch (error) {
    if (unavailablePath(error)) return null;
    throw error;
  }
}

function withinTree(path: string): boolean {
  return path === "" || (!isAbsolute(path) && path.split(sep).every(part =>
    part && part !== ".." && part !== "." && part.toLowerCase() !== ".git"));
}

async function matchesBlob(root: string, indexed: Buffer, committed: Buffer): Promise<boolean> {
  const tab = indexed.indexOf(9);
  if (tab < 0) return false;
  // Only ordinary, stage-zero entries. Lowercase tags and S hide changes;
  // unsupported modes include submodules, which can select another Git config.
  const [, mode, oid] = /^H (100644|100755|120000) ([0-9a-f]+) 0$/.exec(indexed.toString("latin1", 0, tab)) ?? [];
  const name = indexed.subarray(tab + 1);
  const path = name.toString("utf8");
  if (!oid || !gitOid.test(oid) || !path || !withinTree(path) || !Buffer.from(path).equals(name)) return false;
  const treeHeader = Buffer.from(`${mode} blob ${oid}\t`);
  if (!committed.subarray(0, treeHeader.length).equals(treeHeader)
    || !committed.subarray(treeHeader.length).equals(name)) return false;
  const absolute = join(root, path);
  const parent = dirname(absolute);
  if (await realpath(parent) !== parent) return false;
  const hash = createHash(oid.length === 40 ? "sha1" : "sha256");
  if (mode === "120000") {
    const target = await readlink(absolute, { encoding: "buffer" });
    return hash.update(`blob ${target.length}\0`).update(target).digest("hex") === oid;
  }
  const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || !Number.isSafeInteger(stat.size) || Boolean(stat.mode & 0o100) !== (mode === "100755")) return false;
    hash.update(`blob ${stat.size}\0`);
    const buffer = Buffer.allocUnsafe(Math.min(stat.size, 64 * 1024));
    for (let remaining = stat.size; remaining > 0;) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(remaining, buffer.length), null);
      if (!bytesRead) return false;
      hash.update(buffer.subarray(0, bytesRead));
      remaining -= bytesRead;
    }
    const after = await file.stat();
    return stat.size === after.size && stat.mtimeMs === after.mtimeMs && stat.ctimeMs === after.ctimeMs
      && hash.digest("hex") === oid;
  } finally { await file.close(); }
}

async function* gitRecords(root: string, args: readonly string[]): AsyncGenerator<Buffer, boolean> {
  const git = gitProcess(root, args);
  const kill = () => {
    if (git.exitCode === null && git.signalCode === null) git.kill("SIGKILL");
  };
  let timedOut = false;
  const expire = () => {
    timedOut = true;
    kill();
  };
  let deadline = setTimeout(expire, gitTimeoutMs);
  let pending = Buffer.alloc(0);
  try {
    for await (const bytes of git.stdout) {
      // While we yield records, Git may be blocked on its pipe while the caller
      // hashes files. Only time waits for a new chunk or for Git to exit.
      clearTimeout(deadline);
      if (timedOut) return false;
      const chunk = Buffer.from(bytes);
      const records = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let offset = 0;
      for (let end = records.indexOf(0); end !== -1; end = records.indexOf(0, offset)) {
        yield records.subarray(offset, end);
        offset = end + 1;
      }
      pending = records.subarray(offset);
      if (pending.length > 256 * 1024) return false;
      deadline = setTimeout(expire, gitTimeoutMs);
    }
    return pending.length === 0 && await git.exited === 0 && !timedOut;
  } finally {
    clearTimeout(deadline);
    kill();
    await git.exited;
  }
}

async function matchesCommit(root: string, gitArgs: readonly string[], revision: string): Promise<boolean> {
  const index = gitRecords(root, [...gitArgs, "ls-files", "--stage", "-v", "-z"]);
  const tree = gitRecords(root, [...gitArgs, "ls-tree", "-r", "-z", revision]);
  try {
    for (;;) {
      // Both Git inventories are ordered by the raw, full pathname.
      const [indexed, committed] = await Promise.all([index.next(), tree.next()]);
      if (indexed.done || committed.done) return indexed.done === true && committed.done === true
        && indexed.value && committed.value;
      if (!await matchesBlob(root, indexed.value, committed.value)) return false;
    }
  } finally {
    await Promise.all([index.return(false), tree.return(false)]);
  }
}

/** Inspect metadata through Git, and read tracked bytes without Git's content converters. */
export async function workerRepositoryHead(cwd: string): Promise<(Pick<WorkerLaneRef, "repoId" | "revision" | "subdir">
  & { readonly root: string }) | null> {
  try {
    const canonical = await realpath(cwd);
    const root = await checkoutRoot(canonical);
    if (!root) return null;
    const subdir = relative(root, canonical);
    if (subdir.length > 2048 || !withinTree(subdir) || controls.test(subdir) || subdir.includes("\\")) return null;
    const gitArgs = [`--git-dir=${join(root, ".git")}`, `--work-tree=${root}`];
    const head = [...gitArgs, "rev-parse", "--verify", "HEAD^{commit}"];
    const [repoId, headOutput] = await Promise.all([repositoryIdentity(root), gitWorkerRepository(root, head)]);
    const revision = headOutput?.replace(/\n$/, "");
    if (!repoId || !revision || !gitOid.test(revision)) return null;
    // None of these plumbing commands refresh the index or pass working-tree
    // bytes to a filter. Compare the same parsed index entries to HEAD and disk.
    if (await gitWorkerRepository(root, [...gitArgs, "ls-files", "--others", "--exclude-standard",
      "--directory", "--no-empty-directory", "-z"]) !== "") return null;
    if (!await matchesCommit(root, gitArgs, revision)) return null;
    if (subdir && await gitWorkerRepository(root, [...gitArgs, "cat-file", "-t", `${revision}:${subdir}`]) !== "tree\n") return null;
    const [stableHead, stableRepo] = await Promise.all([gitWorkerRepository(root, head), repositoryIdentity(root)]);
    if (stableHead !== headOutput || stableRepo !== repoId) return null;
    return { root, repoId, revision, subdir };
  } catch (error) {
    if (unavailablePath(error)) return null;
    throw error;
  }
}
