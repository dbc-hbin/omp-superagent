import { createHash } from "node:crypto";
import { dirname } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { startHost } from "./host";
import { boundWorkspace, enrolledRepo, privateWorkerDirectory, reserveCheckout } from "./worker-checkout";
import { absentWorkerHost, attestWorkerHost, inspectWorkerHost, rawWorkerSocket, readWorkerFiles,
  WORKER_ATTEMPT_ENV, WORKER_SESSION_ENV, workerPaths } from "./worker-host";
import { WorkerLedger, type WorkerReceipt } from "./worker-ledger";
import { assertWorkerGitStartup, requireWorkerStartupFlags, workerLaunchProfile, workerManagedUlwPath } from "./worker-profile";
import { parseWorkerPolicy, parseWorkerRequest, WorkerRefusal } from "./worker-request";
import { bridgeWorker, workerHeader, workerReply } from "./worker-stdio";
import type { WorkerDescription, WorkerLaneRef, WorkerLaunch, WorkerPolicy, WorkerProbe, WorkerRepo } from "./worker-wire";

type WorkerLane = {
  readonly ref: WorkerLaneRef;
  readonly repo: WorkerRepo;
  readonly paths: ReturnType<typeof workerPaths>;
};
type Workspace = Pick<WorkerLaneRef, "repoId" | "revision" | "subdir">;

function validateStorage(policy: WorkerPolicy): void {
  if (!privateWorkerDirectory(policy.stateDir)) throw new WorkerRefusal("Private worker storage is missing");
  // Check the portable limit using a production lane ID before advertising the worker.
  workerPaths(policy, `lane-${"0".repeat(24)}`);
}

function findRepo(policy: WorkerPolicy, repoId: string): WorkerRepo {
  const repo = policy.repos.find(candidate => candidate.id === repoId);
  if (!repo) throw new WorkerRefusal("Worker repository is not enrolled for this key");
  return repo;
}

async function describeWorker(policy: WorkerPolicy, workspace?: Workspace): Promise<WorkerDescription> {
  const platform = process.platform;
  if (platform !== "linux" && platform !== "darwin") throw new WorkerRefusal("Unsupported worker platform");
  const { workerId, stateDir, repos, capacity } = policy;
  // Keep process/Git subprocess counts bounded even when the policy lists many repos.
  for (const repo of repos) await enrolledRepo(policy, repo);
  if (workspace) await boundWorkspace(findRepo(policy, workspace.repoId), workspace);
  return { workerId, platform, stateDir, repos, capacity, active: WorkerLedger.count(policy) };
}

class WorkerService {
  readonly #policy: WorkerPolicy;
  readonly #ledger: WorkerLedger;

  constructor(policy: WorkerPolicy) {
    this.#policy = policy;
    this.#ledger = new WorkerLedger(policy);
  }

  close(): void { this.#ledger.close(); }

  #lane(ref: WorkerLaneRef): WorkerLane {
    return { ref, repo: findRepo(this.#policy, ref.repoId), paths: workerPaths(this.#policy, ref.laneId) };
  }

  #receipt({ ref, repo }: WorkerLane): WorkerReceipt | null {
    const current = this.#ledger.get(ref.laneId);
    if (current && (current.repoId !== ref.repoId || current.revision !== ref.revision
      || current.subdir !== ref.subdir || current.repoRoot !== repo.cwd))
      throw new WorkerRefusal("Worker lane has a different durable checkout binding");
    if (current && ref.generation < current.generation) throw new WorkerRefusal("Worker lane generation is stale");
    return current;
  }

  async #reap(): Promise<void> {
    for (const receipt of this.#ledger.active()) {
      if (!this.#policy.repos.some(repo => repo.id === receipt.repoId && repo.cwd === receipt.repoRoot)) continue;
      try { await inspectWorkerHost(this.#ledger, workerPaths(this.#policy, receipt.laneId), receipt, false); }
      catch (error) {
        if (!(error instanceof Error)) throw error;
        // Damaged or unobservable evidence still consumes capacity.
      }
    }
  }

  async probe(ref: WorkerLaneRef): Promise<WorkerProbe> {
    const lane = this.#lane(ref);
    const observed = this.#receipt(lane);
    const { exitGeneration, ...probe } = await inspectWorkerHost(this.#ledger, lane.paths, observed);
    // Do not claim ownership or absence for a newer generation unless the current
    // resident was positively released and no different attempt raced this probe.
    if (this.#receipt(lane)?.attempt !== observed?.attempt ||
      (observed && observed.generation < ref.generation && (probe.socket || probe.pidAlive || probe.ownerAlive)))
      return { ...probe, uncertain: true, pid: null, sessionId: null };
    return exitGeneration === ref.generation ? { ...probe, exitGeneration } : probe;
  }

  async open(ref: WorkerLaneRef, launch: WorkerLaunch): Promise<{ pid: number }> {
    const lane = this.#lane(ref);
    const preset = launch.modelPreset;
    const launchDigest = createHash("sha256").update(JSON.stringify([launch.model, launch.subagentConcurrency,
      preset?.name, preset?.preset.defaultThinkingLevel, Object.entries(preset?.preset.modelRoles ?? {}).sort()])).digest("hex");
    const observed = this.#receipt(lane);
    if (observed?.generation === ref.generation) {
      if (observed.launchDigest !== launchDigest)
        throw new WorkerRefusal("Worker lane generation was opened with different launch settings");
      const probe = await this.probe(ref);
      if (!probe.uncertain && probe.socket && probe.pidAlive && probe.ownerAlive && probe.pid !== null)
        return { pid: probe.pid };
      throw new WorkerRefusal("Worker lane generation has no verified live Host; it cannot reopen");
    }
    await this.#reap();
    const previous = this.#receipt(lane);
    if (observed?.attempt !== previous?.attempt || (previous && previous.phase !== "released"))
      throw new WorkerRefusal("Worker lane has a resident or uncertain launch");
    if (previous && ref.generation <= previous.generation)
      throw new WorkerRefusal("Worker does not reopen a previous lane generation");
    const gitDir = await enrolledRepo(this.#policy, lane.repo);
    if (previous && previous.gitDir !== gitDir) throw new WorkerRefusal("Worker checkout metadata directory changed");
    const initial = await readWorkerFiles(lane.paths);
    if (absentWorkerHost(initial, previous).uncertain) throw new WorkerRefusal("Worker lane has an unverified socket or journal");
    // Commit admission before reserving the checkout, publishing any session
    // artifacts, or starting the stock OMP process.
    const reservation = this.#ledger.reserve(ref, { repoRoot: lane.repo.cwd, gitDir, launchDigest }, previous);
    let cwd: string;
    let target: ReturnType<typeof workerLaunchProfile>;
    let managedUlwPath: string;
    try {
      reserveCheckout(reservation);
      cwd = await boundWorkspace(lane.repo, ref);
      await assertWorkerGitStartup(lane.repo);
      target = workerLaunchProfile(this.#policy, cwd);
      managedUlwPath = await workerManagedUlwPath(this.#policy.repos);
      await requireWorkerStartupFlags(target.executable, this.#policy.stateDir, target.env);
      if (absentWorkerHost(await readWorkerFiles(lane.paths), reservation).uncertain)
        throw new WorkerRefusal("Worker socket or journal changed before launch");
      privateWorkerDirectory(dirname(lane.paths.socketPath), true);
      privateWorkerDirectory(dirname(dirname(lane.paths.sessionFile)), true);
      privateWorkerDirectory(dirname(lane.paths.sessionFile), true);
    } catch (error) {
      this.#ledger.retire(reservation);
      throw error;
    }
    const launching = { ...reservation, phase: "launching" } as const;
    let preparingSession = false;
    try {
      const { pid } = await startHost({
        ...launch, cwd, command: [target.executable], socketPath: lane.paths.socketPath,
        sessionFile: lane.paths.sessionFile, logPath: lane.paths.logPath,
        extensionPath: fileURLToPath(new URL("./lane-extension.ts", import.meta.url)),
        worker: { ...target.profile, managedUlwPath },
        env: { ...target.env, OMP_SUPERAGENT_ROLE: "lane", OMP_SUPERAGENT_LANE: launching.laneId,
          [WORKER_ATTEMPT_ENV]: launching.attempt, [WORKER_SESSION_ENV]: launching.sessionId ?? "" },
      }, () => {
        if (!this.#ledger.transition(reservation, launching)) throw new WorkerRefusal("Worker launch reservation is no longer current");
        preparingSession = true;
      });
      const probe = await inspectWorkerHost(this.#ledger, lane.paths, launching);
      const actual = this.#ledger.get(ref.laneId);
      if (actual?.attempt !== launching.attempt || actual.phase !== "live" || actual.identity.pid !== pid ||
        !probe.socket || probe.uncertain || probe.pid !== pid)
        throw new WorkerRefusal("Stock worker Host did not confirm the reserved launch identity");
      return { pid };
    } catch (error) {
      if (!preparingSession) {
        this.#ledger.retire(reservation);
        throw new WorkerRefusal("Worker Host preflight failed before session preparation; no Host was launched", { cause: error });
      }
      if (error instanceof WorkerRefusal) throw error;
      throw new WorkerRefusal("Stock worker Host launch is unresolved; inspect the private worker log and probe the same generation", { cause: error });
    }
  }

  async attach(ref: WorkerLaneRef) {
    const lane = this.#lane(ref);
    const observed = this.#receipt(lane);
    if (observed?.generation !== ref.generation) throw new WorkerRefusal("No worker launch receipt for this generation");
    const probe = await inspectWorkerHost(this.#ledger, lane.paths, observed, observed.phase === "launching");
    const receipt = this.#receipt(lane);
    if (receipt?.attempt !== observed.attempt || receipt.phase !== "live" ||
      !probe.socket || !probe.pidAlive || !probe.ownerAlive)
      throw new WorkerRefusal("Worker lane does not have an attachable native Host");
    const identity = await attestWorkerHost(lane.paths, await readWorkerFiles(lane.paths), receipt);
    const socket = await rawWorkerSocket(lane.paths.socketPath, identity);
    const current = this.#receipt(lane);
    if (current?.phase !== "live" || current.attempt !== receipt.attempt) {
      socket.destroy();
      throw new WorkerRefusal("Worker lane changed before attach");
    }
    return { socket, value: { pid: identity.pid, sessionId: identity.sessionId, sessionFile: identity.sessionFile } };
  }
}

/** One authorized forced-command invocation; never reads commands after the header except an attested native bridge. */
export async function serveWorker(policy: WorkerPolicy, input: Readable = process.stdin, output: Writable = process.stdout): Promise<void> {
  let service: WorkerService | undefined;
  let attach: Awaited<ReturnType<WorkerService["attach"]>> | undefined;
  let reply: Parameters<typeof workerReply>[1];
  // Broken SSH output is handled by the write callback or the bridge. It is
  // never a death signal to the detached native processes.
  const outputLost = () => input.pause();
  input.on("error", outputLost);
  output.on("error", outputLost);
  try {
    try {
      const request = parseWorkerRequest(await workerHeader(input));
      const bound = parseWorkerPolicy(policy);
      if (request.op !== "describe" && request.workerId !== bound.workerId)
        throw new WorkerRefusal("Worker request names a different enrollment");
      validateStorage(bound);
      if (request.op === "describe") reply = { ok: true, value: await describeWorker(bound, request.workspace) };
      else {
        service = new WorkerService(bound);
        switch (request.op) {
          case "probe": reply = { ok: true, value: await service.probe(request.ref) }; break;
          case "open": reply = { ok: true, value: await service.open(request.ref, request.launch) }; break;
          case "attach":
            attach = await service.attach(request.ref);
            reply = { ok: true, value: attach.value };
            break;
        }
      }
    } catch (error) {
      reply = { ok: false, error: error instanceof WorkerRefusal ? error.message : "Worker could not verify the operation" };
    } finally { service?.close(); }
    await workerReply(output, reply);
    if (attach) await bridgeWorker(input, output, attach.socket);
  } finally {
    attach?.socket.destroy();
    input.pause();
    input.off("error", outputLost);
    output.off("error", outputLost);
  }
}
