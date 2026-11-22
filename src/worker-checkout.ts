import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { gitWorkerRepository, workerRepositoryHead, workerRepositoryIdentity } from "./worker-repository";
import { WorkerRefusal } from "./worker-request";
import type { WorkerLaneRef, WorkerPolicy, WorkerRepo } from "./worker-wire";

export function privateWorkerDirectory(directory: string, create = false): boolean {
  if (create) mkdirSync(directory, { mode: 0o700, recursive: true });
  const info = lstatSync(directory, { throwIfNoEntry: false });
  if (!info) return false;
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700
    || realpathSync(directory) !== directory) throw new WorkerRefusal("Worker storage must be canonical and private (0700)");
  return true;
}

function within(root: string, candidate: string): boolean {
  const suffix = relative(root, candidate);
  return !isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`);
}

export async function enrolledRepo(policy: WorkerPolicy, repo: WorkerRepo): Promise<string> {
  const root = lstatSync(repo.cwd, { throwIfNoEntry: false });
  const uid = process.getuid?.();
  if (!root?.isDirectory() || root.uid !== uid || (root.mode & 0o022) !== 0 || realpathSync(repo.cwd) !== repo.cwd
    || within(policy.stateDir, repo.cwd) || within(repo.cwd, policy.stateDir))
    throw new WorkerRefusal("Enrolled repository must be a canonical checkout separate from worker storage");
  const [top, id, gitDir] = await Promise.all([
    gitWorkerRepository(repo.cwd, ["rev-parse", "--show-toplevel"]),
    workerRepositoryIdentity(repo.cwd),
    gitWorkerRepository(repo.cwd, ["rev-parse", "--absolute-git-dir"]),
  ]);
  const gitPath = gitDir?.replace(/\n$/, "");
  const stat = gitPath && lstatSync(gitPath, { throwIfNoEntry: false });
  if (top !== `${repo.cwd}\n` || id !== repo.id || !gitPath || !isAbsolute(gitPath)
    || !stat || !stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o022) !== 0 || realpathSync(gitPath) !== gitPath)
    throw new WorkerRefusal("Configured checkout does not match its enrolled Git identity");
  return gitPath;
}

export async function boundWorkspace(repo: WorkerRepo, ref: Pick<WorkerLaneRef, "revision" | "subdir">): Promise<string> {
  const cwd = join(repo.cwd, ref.subdir);
  if (!lstatSync(cwd, { throwIfNoEntry: false })?.isDirectory() || realpathSync(cwd) !== cwd || !within(repo.cwd, cwd))
    throw new WorkerRefusal("Worker subdirectory is not a canonical directory inside its enrolled checkout");
  const observed = await workerRepositoryHead(cwd);
  if (!observed || observed.repoId !== repo.id || observed.revision !== ref.revision || observed.subdir !== ref.subdir)
    throw new WorkerRefusal("Worker checkout must be clean at the exact requested Git revision and subdirectory");
  return cwd;
}

const claimName = "omp-sa-checkout.lock";
type CheckoutClaim = { readonly gitDir: string; readonly attempt: string };

function readClaim(gitDir: string) {
  const path = join(gitDir, claimName);
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (!info) return null;
  if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600 || info.size > 128)
    throw new WorkerRefusal("Checkout reservation is not a private worker claim");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size)
      throw new WorkerRefusal("Checkout reservation changed during verification");
    return { value: readFileSync(fd, "utf8"), info };
  } finally { closeSync(fd); }
}

function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** One physical checkout can be used by only one resident lane, even across enrolled keys. */
export function reserveCheckout({ gitDir, attempt }: CheckoutClaim): void {
  const temporary = join(gitDir, `.omp-sa-${attempt}.tmp`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try {
      writeFileSync(fd, attempt);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    linkSync(temporary, join(gitDir, claimName));
    syncDirectory(gitDir);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST")
      throw new WorkerRefusal("An independent worker lane already reserves this checkout");
    throw error;
  } finally { unlinkSync(temporary); }
}

export function ownsCheckout({ gitDir, attempt }: CheckoutClaim): boolean {
  return realpathSync(gitDir) === gitDir && readClaim(gitDir)?.value === attempt;
}

/** Never remove another attempt's claim. The lane ledger serializes release of our own claim. */
export function releaseCheckout({ gitDir, attempt }: CheckoutClaim): void {
  if (realpathSync(gitDir) !== gitDir) throw new WorkerRefusal("Checkout reservation directory changed");
  const claim = readClaim(gitDir);
  if (claim?.value !== attempt) return;
  const path = join(gitDir, claimName);
  const current = lstatSync(path, { throwIfNoEntry: false });
  if (!current || claim.info.dev !== current.dev || claim.info.ino !== current.ino)
    throw new WorkerRefusal("Checkout reservation changed before release");
  unlinkSync(path);
  syncDirectory(gitDir);
}
