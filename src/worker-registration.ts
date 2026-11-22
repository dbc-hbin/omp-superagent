import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync,
  renameSync, rmSync, unlinkSync, type Stats,
} from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { Type } from "@sinclair/typebox/type";
import { Value } from "@sinclair/typebox/value";
import { privateDirectory } from "./config";
import { stagePrivateFile } from "./credentials";
import { workerRepositoryHead } from "./worker-repository";
import { trustedWorkerPath } from "./worker-trust";
import { WorkerDescriptionSchema, type WorkerDescription, type WorkerLaneRef, type WorkerRegistration } from "./worker-wire";

export class WorkerRegistrationError extends Error {
  override readonly name = "WorkerRegistrationError";
}

const destinationPattern = "^[A-Za-z0-9_][A-Za-z0-9_.-]*@[A-Za-z0-9][A-Za-z0-9_.-]*(?![\\s\\S])";
const destinationRE = new RegExp(destinationPattern);
const inventory = Type.Array(Type.Object({
  destination: Type.String({ pattern: destinationPattern }),
  identityFile: Type.String(),
  description: WorkerDescriptionSchema,
  default: Type.Optional(Type.Boolean()),
  defaultRepository: Type.Optional(Type.Object({
    root: Type.String(),
    repoId: Type.String({ pattern: "^[0-9a-f]{64}$" }),
  }, { additionalProperties: false })),
}));
const fileLimit = 1024 * 1024;
const controls = /[\u0000-\u001f\u007f]/;

export function workerHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function workerPublicKey(input: string): string {
  const payload = /^ssh-ed25519 ([A-Za-z0-9+/]{68})(?:[ \t]+[^\r\n\0]*)?(?![\s\S])/.exec(input)?.[1];
  if (payload) {
    const blob = Buffer.from(payload, "base64");
    const header = Buffer.from("\0\0\0\x0bssh-ed25519\0\0\0\x20");
    if (blob.length === header.length + 32 && blob.subarray(0, header.length).equals(header))
      return `ssh-ed25519 ${payload}`;
  }
  throw new WorkerRegistrationError("Expected one OpenSSH Ed25519 public key");
}

export function shellWord(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new WorkerRegistrationError("Worker shell arguments must be single-line values");
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

export function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function checkWorkerFile(stat: Stats, allowedMode: number): void {
  if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1 ||
      (stat.mode & 0o7777 & ~allowedMode) !== 0 || stat.size > fileLimit)
    throw new WorkerRegistrationError("Worker file must be a bounded, owned regular file with safe permissions");
}

export function readWorkerFile(path: string, allowedMode = 0o600): Buffer | undefined {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (isMissing(error)) return; throw error; }
  try {
    checkWorkerFile(fstatSync(fd), allowedMode);
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

/** Refuse symlinks and unsafe existing permissions; never repair unrelated account paths. */
export function workerDirectory(path: string, allowedMode: number, create = false): void {
  if (create) {
    try { mkdirSync(path, { mode: 0o700 }); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
  }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o7777 & ~allowedMode) !== 0)
    throw new WorkerRegistrationError(`Worker directory is not an owned directory with safe permissions: ${path}`);
}

export async function withWorkerWriteLock<T>(path: string, action: () => T | Promise<T>): Promise<T> {
  let lock: Database | undefined;
  try {
    try {
      trustedWorkerPath(dirname(path), [], "directory");
      // Create the private sidecar if needed. Never reopen/close its inode here:
      // closing an unrelated fd can release this process's SQLite file locks.
      try { closeSync(openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)); }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
      checkWorkerFile(lstatSync(path), 0o600);
      lock = new Database(path, { readwrite: true, strict: true });
      lock.run("PRAGMA busy_timeout = 0");
      lock.run("BEGIN EXCLUSIVE");
    } catch (cause) { throw new WorkerRegistrationError(`Worker write lock unavailable: ${path}`, { cause }); }
    // As with Store's writer lock, the OS releases ownership on process exit.
    // Keep the inode: unlinking would let contenders take independent locks.
    return await action();
  } finally { lock?.close(true); }
}

function checkWorkerDirectories(directory: string): void {
  workerDirectory(directory, 0o700);
  workerDirectory(dirname(directory), 0o700);
  trustedWorkerPath(directory, [], "directory");
}

/** Verify the selected key immediately before handing its path to an external process. */
export function checkWorkerIdentity(path: string): void {
  try {
    if (!canonicalPath(path)) throw new WorkerRegistrationError("Worker key path must be canonical");
    checkWorkerDirectories(dirname(path));
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try { checkWorkerFile(fstatSync(fd), 0o600); }
    finally { closeSync(fd); }
  } catch (cause) { throw new WorkerRegistrationError(`Dedicated worker SSH identity is unavailable or unsafe: ${path}`, { cause }); }
}

function endpointFor(stateDir: string, destination: string) {
  return { destination, identityFile: join(stateDir, "workers", `${workerHash(destination)}.key`) };
}

function validateDescription(value: unknown): WorkerDescription {
  if (!Value.Check(WorkerDescriptionSchema, value) || !/^[A-Za-z0-9_-]{1,128}$/.test(value.workerId) ||
      controls.test(value.workerId) || !canonicalPath(value.stateDir) || value.active > value.capacity ||
      value.repos.some(repo => !/^[0-9a-f]{64}$/.test(repo.id) || controls.test(repo.id) || !canonicalPath(repo.cwd)) ||
      new Set(value.repos.map(repo => repo.id)).size !== value.repos.length)
    throw new WorkerRegistrationError("Invalid worker description");
  return {
    workerId: value.workerId, platform: value.platform, stateDir: value.stateDir,
    repos: value.repos.map(({ id, cwd }) => ({ id, cwd })).sort((left, right) => left.id.localeCompare(right.id)),
    capacity: value.capacity, active: value.active,
  };
}

function canonicalPath(path: string): boolean {
  return isAbsolute(path) && normalize(path) === path && !controls.test(path);
}

/** Last verified inventory, not endpoint readiness. Pending keys are not listed. */
export function listWorkers(stateDir: string): WorkerRegistration[] {
  const directory = join(stateDir, "workers");
  try { checkWorkerDirectories(directory); }
  catch (error) { if (isMissing(error)) return []; throw error; }
  const bytes = readWorkerFile(join(directory, "verified.json"));
  if (bytes === undefined) return [];
  const parsed: unknown = JSON.parse(bytes.toString("utf8"));
  if (!Value.Check(inventory, parsed)) throw new WorkerRegistrationError("Invalid verified worker inventory");
  const ids = new Set<string>();
  const destinations = new Set<string>();
  let defaultSeen = false;
  return parsed.map(({ destination, identityFile, description, default: preferred, defaultRepository }) => {
    const verified = validateDescription(description);
    if (identityFile !== endpointFor(stateDir, destination).identityFile ||
        ids.has(verified.workerId) || destinations.has(destination) ||
        (defaultRepository && (!preferred || defaultSeen || !canonicalPath(defaultRepository.root)
          || !verified.repos.some(repo => repo.id === defaultRepository.repoId))))
      throw new WorkerRegistrationError("Conflicting verified worker inventory");
    ids.add(verified.workerId);
    destinations.add(destination);
    // Legacy boolean-only entries never authorized disclosure from any local checkout.
    defaultSeen ||= defaultRepository !== undefined;
    return { destination, identityFile, description: verified, ...(defaultRepository && { default: true, defaultRepository }) };
  });
}

type VerifyWorker = (
  endpoint: Pick<WorkerRegistration, "destination" | "identityFile">,
  workspace?: Pick<WorkerLaneRef, "repoId" | "revision" | "subdir">,
) => Promise<WorkerDescription>;
type EnrollmentResult =
  | { readonly status: "pending"; readonly destination: string; readonly publicKey: string; readonly initCommand: string;
      readonly verificationError?: string }
  | { readonly status: "verified"; readonly destination: string; readonly description: WorkerDescription; readonly default: boolean };

function pendingEnrollment(destination: string, publicKey: string, verificationError?: string): EnrollmentResult {
  return { status: "pending", destination, publicKey,
    initCommand: `omp-sa worker init --head-key ${shellWord(publicKey)} --repo /absolute/path/to/repo`, verificationError };
}

function sameEnrollment(before: WorkerDescription, after: WorkerDescription): boolean {
  const { active: _before, ...saved } = before;
  const { active: _after, ...observed } = after;
  return Bun.deepEquals(saved, observed);
}

/** Begin without network I/O; a separate invocation verifies the restricted SSH endpoint. */
export async function addWorker(
  options: { readonly stateDir: string; readonly destination: string; readonly defaultRepositoryRoot?: string },
  describe: VerifyWorker,
): Promise<EnrollmentResult> {
  const { stateDir, destination, defaultRepositoryRoot } = options;
  if (!destinationRE.test(destination) || destination.length > 320)
    throw new WorkerRegistrationError("Worker destination must be an explicit user@host");
  const source = defaultRepositoryRoot === undefined ? null : await workerRepositoryHead(defaultRepositoryRoot);
  if (defaultRepositoryRoot !== undefined && (!source || source.subdir !== ""))
    throw new WorkerRegistrationError("A default worker requires the root of a clean head-side Git checkout with a verifiable network origin");
  trustedWorkerPath(stateDir, [], "profile");
  privateDirectory(stateDir);
  const directory = join(stateDir, "workers");
  workerDirectory(directory, 0o700, true);
  return await withWorkerWriteLock(join(directory, "write.lock"), async () => {
    const registrations = listWorkers(stateDir);
    const previous = registrations.find(worker => worker.destination === destination);
    if (source && registrations.some(worker => worker.defaultRepository && worker !== previous))
      throw new WorkerRegistrationError("A different verified worker is already the default");
    const endpoint = endpointFor(stateDir, destination);
    if (!previous && !lstatSync(endpoint.identityFile, { throwIfNoEntry: false }))
      return pendingEnrollment(destination, await createIdentity(endpoint.identityFile, directory));
    checkWorkerIdentity(endpoint.identityFile);

    let observed: WorkerDescription;
    try { observed = await describe(endpoint); }
    catch (cause) {
      const message = "Worker could not be verified using its dedicated key and a known SSH host key";
      if (previous) throw new WorkerRegistrationError(message, { cause });
      return pendingEnrollment(destination, await identityPublicKey(endpoint.identityFile), message);
    }
    const description = validateDescription(observed);
    if (previous) {
      if (!sameEnrollment(previous.description, description))
        throw new WorkerRegistrationError("Worker description no longer matches the verified enrollment");
    } else if (registrations.some(worker => worker.description.workerId === description.workerId)) {
      throw new WorkerRegistrationError("Worker identity is already verified at a different SSH destination");
    }
    let defaultRepository = previous?.defaultRepository;
    if (source) {
      const { root, ...workspace } = source;
      if (!description.repos.some(repo => repo.id === workspace.repoId))
        throw new WorkerRegistrationError("Worker is not approved for the default repository identity");
      // Do not send the head-side path (or a revision for an unapproved repo).
      let scoped: WorkerDescription;
      checkWorkerIdentity(endpoint.identityFile);
      try { scoped = validateDescription(await describe(endpoint, workspace)); }
      catch (cause) {
        throw new WorkerRegistrationError("Worker could not verify the default repository at the requested Git revision", { cause });
      }
      if (!sameEnrollment(description, scoped))
        throw new WorkerRegistrationError("Worker description no longer matches the verified enrollment");
      defaultRepository = { root, repoId: workspace.repoId };
    }
    const registration = { ...endpoint, description, ...(defaultRepository && { default: true, defaultRepository }) };
    if (!Bun.deepEquals(registration, previous)) {
      const updated = previous ? registrations.map(worker => worker === previous ? registration : worker)
        : [...registrations, registration];
      const path = join(directory, "verified.json");
      const temporary = stagePrivateFile(path, `${JSON.stringify(updated, null, 2)}\n`);
      try { renameSync(temporary, path); }
      finally {
        try { unlinkSync(temporary); }
        catch (error) { if (!isMissing(error)) throw error; }
      }
    }
    return { status: "verified", destination, description, default: defaultRepository !== undefined };
  });
}

async function identityPublicKey(path: string): Promise<string> {
  checkWorkerIdentity(path);
  const keygen = Bun.spawn(["ssh-keygen", "-y", "-f", path],
    { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 10_000 });
  const [key, code] = await Promise.all([new Response(keygen.stdout).text(), keygen.exited]);
  if (code !== 0) throw new WorkerRegistrationError("Could not read the dedicated worker SSH identity");
  return workerPublicKey(key.trimEnd());
}

async function createIdentity(path: string, directory: string): Promise<string> {
  const temporary = mkdtempSync(join(directory, ".identity-"));
  try {
    const generated = join(temporary, "head");
    const keygen = Bun.spawn(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "omp-sa-worker", "-f", generated],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore", timeout: 10_000 });
    if (await keygen.exited !== 0) throw new WorkerRegistrationError("Could not generate a dedicated worker SSH key");
    const publicKey = workerPublicKey(readFileSync(`${generated}.pub`, "utf8").trimEnd());
    checkWorkerFile(lstatSync(generated), 0o600);
    linkSync(generated, path);
    return publicKey;
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
