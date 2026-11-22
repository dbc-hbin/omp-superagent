import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { closeSync, constants, mkdirSync, realpathSync, renameSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { createConnection } from "node:net";
import { basename, join } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { HostConnection, startHost } from "./host";
import { resolveOmpCommand } from "./installed-omp";
import { activeManagedUlwRevision, installManagedUlwRevision } from "./managed-ulw";
import {
  approvedWorkspace, bootId, directWorkerContext, errorCode, forwardedWorkerEnvironment, laneEnvironment, loadWorkerProvision, loginEnvironment,
  openPrivateFile, optionalStat, privateWorkerDirectory, requireUserManager, workspacePaths, type WorkerProvision
} from "./remote-worker-provision";
import { macosWorkerFacts, workerPayload } from "./worker-macos";
import { runInUserContext } from "./worker-user-context";
import { generationSocket, transcriptId, WorkerLaneState, type OwnedReservation } from "./remote-worker-state";
import {
  decodeHeader, encodeHeader, INPUT_TIMEOUT, MODEL_LISTING_TIMEOUT, hostIdentitySchema, laneId, parse, placementSchema, PROVISION_TIMEOUT,
  RemoteWorkerError, REQUEST_TIMEOUT, requestSchema, START_TIMEOUT, uuid, workerPackage, writeHeader,
  type WorkerCapability, type WorkerLane, type WorkerLaunchOptions, type WorkerRequest, type WorkerScope
} from "./remote-worker-wire";
import { repositoryRoot } from "./repository";
import { collectEvidence, EvidenceError } from "./lane-evidence";
import { ResultAttachmentError, stageResultAttachment } from "./result-attachment";

async function run(argv: string[], env: Record<string, string>, timeout: number, what: string): Promise<string> {
  let child: Bun.Subprocess<"ignore", "pipe", "ignore">;
  try { child = Bun.spawn(argv, { env, stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout, killSignal: "SIGKILL" }); }
  catch { throw new RemoteWorkerError(`Worker ${what} could not run the configured OMP command`); }
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (code !== 0) throw new RemoteWorkerError(`Worker ${what} failed (${code}) in the account's login environment`);
  return stdout;
}

/** Measured in the account's login environment, exactly what a launched Host would see. */
async function capability(config: WorkerProvision, env: Record<string, string>): Promise<WorkerCapability> {
  const [omp] = resolveOmpCommand(config.command, env.PATH ?? "");
  const [version, listing] = await Promise.all([
    run([omp!, "--version"], env, 15_000, "OMP version check"),
    run([omp!, "models", "--json"], env, MODEL_LISTING_TIMEOUT, "OMP model listing"),
  ]);
  const ompVersion = /^omp\/(\S+)$/.exec(version.trim())?.[1];
  if (!ompVersion) throw new RemoteWorkerError("Worker command did not identify as stock OMP");
  const models = (JSON.parse(listing) as { models?: { kind?: string; selector?: string }[] }).models ?? [];
  let superkit: string | null = null;
  try { superkit = activeManagedUlwRevision().revision; }
  catch { /* Not provisioned (or unusable): HEAD provisions or refuses; never launch it. */ }
  const boot = bootId();
  return {
    package: workerPackage(), platform: process.platform, bootId: boot, clock: Date.now(), omp: ompVersion, superkit,
    roots: config.workspaceRoots,
    models: models.flatMap(model => model.kind === "chat" && typeof model.selector === "string" ? [model.selector] : []),
    ...process.platform === "darwin" && !directWorkerContext() ? { macos: macosWorkerFacts(config, boot) } : {},
  };
}

/**
 * The lane model (HEAD's exact selection, also for presets) must be listed by
 * the worker's own OMP and auth. Other preset roles can be aliases, fuzzy
 * patterns or fallback lists that only OMP's own resolution can judge.
 */
function requireModels(available: readonly string[], options: WorkerLaunchOptions): void {
  if (options.model && !available.includes(options.model)) {
    throw new RemoteWorkerError(`Worker OMP does not offer ${options.model} with this account's configuration and auth`);
  }
}

async function readBody(input: Readable, size: number, timeout: number): Promise<Uint8Array> {
  if (size === 0) return new Uint8Array(0);
  const body = new Uint8Array(size);
  let offset = 0;
  const timer = setTimeout(() => input.destroy(new RemoteWorkerError("Worker transfer timed out")), timeout);
  try {
    for await (const chunk of input as AsyncIterable<Buffer>) {
      if (offset + chunk.length > size) throw new RemoteWorkerError("Worker transfer exceeds its declared size");
      body.set(chunk, offset);
      offset += chunk.length;
      if (offset === size) break;
    }
  } finally { clearTimeout(timer); }
  if (offset !== size) throw new RemoteWorkerError("Worker transfer ended before its declared size");
  return body;
}

function authenticate(config: WorkerProvision, scope: WorkerScope): void {
  if (config.instance !== scope.instance || config.workerId !== scope.placement.workerId) {
    throw new RemoteWorkerError("SSH worker identity or HEAD instance does not match provisioning");
  }
}

async function validatedHost(state: WorkerLaneState, lane: WorkerLane) {
  const evidence = state.evaluate(lane);
  const row = evidence.row;
  if (row?.stage !== "owned" || !evidence.socket || row.lane.generation !== lane.generation) {
    throw new RemoteWorkerError("Worker has no verified endpoint for this lane generation");
  }
  const socket = generationSocket(state.paths.directory, lane.generation);
  const { connection, identity } = await HostConnection.open(socket);
  try {
    const current = state.evaluate(lane);
    const pin = row.identity;
    if (!current.socket || current.row?.token !== row.token || !matchesSocket(socket, pin)
      || identity.dev !== Number(pin.dev) || identity.ino !== Number(pin.ino)
      || identity.sessionFile !== pin.sessionFile || identity.sessionId !== pin.sessionId
      || identity.pid !== pin.pid || identity.ownerPid !== pin.ownerPid) {
      throw new RemoteWorkerError("Worker Host handshake does not match the original generation and owner");
    }
    return { socket, row };
  } finally { await connection.close(); }
}

function matchesSocket(path: string, pin: OwnedReservation["identity"]): boolean {
  const stat = optionalStat(path);
  return !!stat?.isSocket() && stat.uid === BigInt(process.getuid?.() ?? -1) && (stat.mode & 0o777n) === 0o600n
    && `${stat.dev}` === pin.dev && `${stat.ino}` === pin.ino;
}

async function launch(config: WorkerProvision, scope: WorkerScope, id: string, token: string, umask: number): Promise<void> {
  const state = new WorkerLaneState(config, scope, id);
  try {
    const { lane, options, fresh, launched } = state.claim(token);
    if (fresh) mkdirSync(state.paths.directory, { mode: 0o700 });
    privateWorkerDirectory(state.paths.directory);
    const socketPath = generationSocket(state.paths.directory, lane.generation);
    if (optionalStat(socketPath) || transcriptId(lane.sessionFile) !== lane.sessionId) {
      throw new RemoteWorkerError("Unexpected endpoint or transcript before worker launch");
    }
    // Same option object as a local lane; only the worker's paths, its login
    // environment and the HEAD-pinned superkit revision are worker-specific.
    // The Host and its tools get the account's ordinary umask, not this endpoint's.
    process.umask(umask);
    const { pid } = await startHost({
      ...options, command: config.command, socketPath, sessionFile: lane.sessionFile, cwd: lane.cwd,
      extensionPath: fileURLToPath(new URL("./lane-extension.ts", import.meta.url)),
      logPath: join(state.paths.directory, `r${lane.generation.toString(36)}.log`),
      env: laneEnvironment(await loginEnvironment(), id),
      managedUlwRevision: launched.superkit,
    });
    const before = optionalStat(socketPath);
    const { connection, identity } = await HostConnection.open(socketPath);
    try {
      const owner = parse(hostIdentitySchema,
        { pid: identity.pid, ownerPid: identity.ownerPid, sessionId: identity.sessionId, sessionFile: identity.sessionFile },
        "native Host identity");
      const observedId = transcriptId(lane.sessionFile);
      if (!before || identity.dev !== Number(before.dev) || identity.ino !== Number(before.ino) || owner.pid !== pid
        || observedId !== null && observedId !== owner.sessionId) {
        throw new RemoteWorkerError("Launched worker Host identity is unconfirmed");
      }
      const pin = { ...owner, dev: `${before.dev}`, ino: `${before.ino}` };
      if (!matchesSocket(socketPath, pin)) throw new RemoteWorkerError("Launched worker endpoint changed during confirmation");
      state.confirm(token, pin);
    } finally { await connection.close(); }
  } finally { state.close(); }
}

/** Test-only "direct" context: the endpoint itself parents the launcher, as no user manager exists on the CI host. */
async function runDirectly(argv: string[], logPath: string): Promise<{ code: number | null }> {
  const log = openPrivateFile(logPath, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT);
  try {
    const child = spawn(argv[0]!, argv.slice(1), { detached: true, stdio: ["ignore", log, log] });
    const [code] = await once(child, "exit");
    return { code };
  } finally { closeSync(log); }
}

async function detachedLaunch(config: WorkerProvision, request: Extract<WorkerRequest, { op: "start" }>, token: string,
  state: WorkerLaneState) {
  const logPath = join(config.stateDir, "launcher.log");
  closeSync(openPrivateFile(logPath, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT));
  const payload = workerPayload();
  const launcher = [...payload, "--launch", request.instance, JSON.stringify(request.placement), request.lane.id, token];
  // The launcher runs as the main process of a transient unit in the account's
  // user manager (Linux) or a one-shot LaunchAgent in its gui domain (macOS),
  // outside the SSH session. It leaves the Host it starts running after it
  // exits; the job's exit status is the launcher's. Losing the SSH channel cannot
  // cancel a committed start or erase its receipt. A crashed launcher stays reserved forever.
  const unit = `omp-sa-${basename(workspacePaths(config, request, request.lane.id).directory)}-g${request.lane.generation.toString(36)}`;
  const { code } = directWorkerContext()
    ? await runDirectly(launcher, logPath)
    : await runInUserContext(launcher, {
      timeoutMs: START_TIMEOUT, stateDir: config.stateDir, purpose: "launch", logPath, unit, payloadLength: payload.length,
      env: forwardedWorkerEnvironment(),
    });
  if (code !== 0) {
    // An exit status (not a signal) with the reservation still unclaimed proves no Host started.
    if (typeof code === "number") state.abandon(token);
    throw new RemoteWorkerError("Worker launch remains unconfirmed; see the worker launcher log");
  }
}

async function forward(state: WorkerLaneState, lane: WorkerLane, reply: (value: object) => Promise<void>): Promise<void> {
  const { socket, row } = await validatedHost(state, lane);
  const peer = createConnection(socket);
  const timer = setTimeout(() => peer.destroy(new RemoteWorkerError("Worker Host connect timed out")), 5_000);
  const detach = () => peer.destroy();
  process.stdin.on("error", detach);
  try {
    await once(peer, "connect");
    clearTimeout(timer);
    // Do not allow a broker path chosen by the caller, and do not forward into a
    // different socket than the native handshake just verified.
    if (!matchesSocket(socket, row.identity) || state.read()?.token !== row.token)
      throw new RemoteWorkerError("Worker Host endpoint changed before stream attach");
    const { pid, ownerPid, sessionId, sessionFile } = row.identity;
    peer.on("error", detach);
    await reply({
      pid, ownerPid, sessionId, sessionFile, placement: row.placement, laneId: row.lane.id, generation: row.lane.generation,
      launched: row.launched
    });
    process.stdin.pipe(peer);
    await pipeline(peer, process.stdout, { end: false });
  } finally {
    clearTimeout(timer);
    process.stdin.off("error", detach).unpipe(peer);
    peer.destroy();
  }
}

function workspace(config: WorkerProvision, cwd: string): string {
  try { return approvedWorkspace(config, cwd); }
  catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") throw new RemoteWorkerError(`Workspace does not exist on the worker: ${cwd}`);
    throw error;
  }
}

async function dispatch(config: WorkerProvision, request: WorkerRequest, reply: (value: object) => Promise<void>) {
  switch (request.op) {
    case "capability": {
      // A macOS worker reports its launcher readiness here (doctor names what is missing); starting a Host enforces it.
      requireUserManager();
      return reply(await capability(config, await loginEnvironment(config.stateDir)));
    }
    case "provision": {
      // HEAD's validated immutable package; the worker never fetches its own.
      const bytes = await readBody(process.stdin, request.size, PROVISION_TIMEOUT);
      try { return await reply(await installManagedUlwRevision({ provenance: request.provenance, digest: request.digest, bytes })); }
      catch (error) {
        throw new RemoteWorkerError(`Worker omp-superkit provisioning failed: ${error instanceof Error ? error.message.slice(0, 600) : "unknown error"}`);
      }
    }
    case "resolve": {
      const cwd = workspace(config, request.cwd);
      const root = await repositoryRoot(cwd);
      const repoRoot = root === null ? null : workspace(config, root);
      const { socketPath, sessionFile } = workspacePaths(config, request, request.id);
      return reply({ cwd, repoRoot, socketPath, sessionFile });
    }
  }
  const lane = request.lane;
  const state = new WorkerLaneState(config, request, lane.id);
  try {
    switch (request.op) {
      case "inspect": {
        const { socket, transcript, alive } = state.evaluate(lane);
        if (socket) await validatedHost(state, lane);
        return await reply({ socket, transcript, alive });
      }
      case "start": {
        // Cheap binding checks first; nothing below runs for a lane this worker must refuse.
        state.evaluate(lane);
        requireUserManager(config);
        const facts = await capability(config, await loginEnvironment(config.stateDir));
        if (request.superkit !== null && facts.superkit !== request.superkit) {
          throw new RemoteWorkerError(`Worker omp-superkit is ${facts.superkit ?? "not installed"}; HEAD pinned ${request.superkit}`);
        }
        requireModels(facts.models, request.options);
        const token = state.reserve(lane, request.options,
          { package: facts.package, omp: facts.omp, superkit: request.superkit, bootId: facts.bootId });
        if (token) await detachedLaunch(config, request, token, state);
        const { row } = await validatedHost(state, lane);
        return await reply({ pid: row.identity.pid, launched: row.launched });
      }
      case "attach":
        return await forward(state, lane, reply);
      case "result": {
        // Same staging rules as a local lane's result file, against this worker's
        // own private paths; HEAD then queues it under its owner checks.
        const { row } = state.evaluate(lane);
        if (!row) throw new RemoteWorkerError("Worker has no launched lane for a result file");
        const home = realpathSync(homedir());
        let payload: { name: string; data: string };
        try {
          payload = stageResultAttachment(request.path, {
            cwd: row.lane.cwd, privatePaths: [config.stateDir,
            join(home, ".config", "omp-superagent"), join(home, ".omp"), join(home, ".ssh"), row.lane.sessionFile]
          });
        } catch (error) {
          if (error instanceof ResultAttachmentError) throw new RemoteWorkerError(error.message);
          throw error;
        }
        const bytes = Buffer.from(payload.data, "base64");
        await reply({ name: payload.name, size: bytes.length, digest: createHash("sha256").update(bytes).digest("hex") });
        await new Promise<void>((resolve, reject) => process.stdout.write(bytes, error => error ? reject(error) : resolve()));
        return;
      }
      case "evidence": {
        // Read-only and bounded, from the workspace this worker bound to the lane.
        const { row } = state.evaluate(lane);
        if (!row) throw new RemoteWorkerError("Worker has no launched lane for evidence");
        try {
          return await reply(await collectEvidence(row.lane.cwd, request.request,
            join(state.paths.directory, `r${row.lane.generation.toString(36)}.log`)));
        } catch (error) {
          if (error instanceof EvidenceError) throw new RemoteWorkerError(error.message);
          throw error;
        }
      }
      case "input": {
        // Inputs exist only for a lane this worker already owns.
        if (!state.evaluate(lane).row) throw new RemoteWorkerError("Worker has no launched lane for this input");
        const bytes = await readBody(process.stdin, request.size, INPUT_TIMEOUT);
        if (createHash("sha256").update(bytes).digest("hex") !== request.digest) {
          throw new RemoteWorkerError("Worker input digest does not match");
        }
        const directory = join(state.paths.directory, "inputs");
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        privateWorkerDirectory(directory);
        const name = basename(request.name).replace(/[^\w.-]+/g, "_").slice(-120) || "input";
        const path = join(directory, `${request.digest.slice(0, 16)}-${name}`);
        if (!optionalStat(path)) {
          const fd = openPrivateFile(`${path}.${process.pid}.tmp`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
          try { writeSync(fd, bytes); } finally { closeSync(fd); }
          renameSync(`${path}.${process.pid}.tmp`, path);
        }
        return await reply({ path });
      }
      default: {
        const exhaustive: never = request;
        throw new RemoteWorkerError(`Unsupported worker operation: ${exhaustive}`);
      }
    }
  } finally { state.close(); }
}

export async function workerStdio(): Promise<void> {
  process.umask(0o077);
  const { workerId, instance, stateDir, workspaceRoots, command } = loadWorkerProvision();
  const config = { workerId, instance, stateDir, workspaceRoots, command };
  let answered = false;
  const send = async (fields: object) => {
    const header = encodeHeader({ workerId, instance, ...fields });
    answered = true;
    await writeHeader(process.stdout, header);
  };
  try {
    const request = parse(requestSchema, await decodeHeader(process.stdin, REQUEST_TIMEOUT), "request");
    authenticate(config, request);
    await dispatch(config, request, value => send({ value }));
  } catch (error) {
    if (answered) throw error;
    // Error frames are single-line text of bounded length.
    await send({
      error: error instanceof RemoteWorkerError ? error.message.replace(/[\r\n\0]+/g, " ").slice(0, 1024)
        : "Worker operation failed; check worker provisioning and state"
    });
  } finally { process.stdin.destroy(); }
}

if (import.meta.main) {
  try {
    const inherited = process.umask(0o077);
    const [mode, instance, placement, id, token, ...extra] = process.argv.slice(2);
    if (mode !== "--launch" || !placement || extra.length) throw new RemoteWorkerError("Invalid worker launcher arguments");
    const config = loadWorkerProvision();
    const scope = { instance: parse(uuid, instance, "HEAD instance"), placement: parse(placementSchema, JSON.parse(placement), "placement") };
    authenticate(config, scope);
    await launch(config, scope, parse(laneId, id, "lane id"), parse(uuid, token, "launch token"), inherited);
  } catch (error) {
    console.error("Worker launcher failed:", error instanceof Error ? error.message : "unknown error");
    process.exitCode = 1;
  }
}
