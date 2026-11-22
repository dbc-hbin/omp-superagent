import type { Config } from "./config";
import { workerRepositoryHead } from "./worker-repository";
import { listWorkers } from "./worker-registration";
import { workerDescribe, type RemotePlacement, type WorkerLaneRef, type WorkerRegistration, type WorkerSelector } from "./worker-wire";

class WorkerPlacementError extends Error {}
type Workspace = Pick<WorkerLaneRef, "repoId" | "revision" | "subdir">;

async function availableSlots(registration: WorkerRegistration, { repoId, revision, subdir }: Workspace): Promise<number> {
  const saved = registration.description;
  const approved = saved.repos.find(repo => repo.id === repoId);
  if (!approved) return 0;
  try {
    const live = await workerDescribe(registration, { repoId, revision, subdir });
    const inventory = live.repos.filter(repo => repo.id === repoId);
    return live.workerId === saved.workerId && live.platform === saved.platform && live.stateDir === saved.stateDir
      && inventory.length === 1 && inventory[0]?.cwd === approved.cwd ? Math.max(0, Math.min(saved.capacity, live.capacity) - live.active) : 0;
  } catch (error) {
    if (error instanceof Error) return 0; // No readiness receipt; no permission to open.
    throw error;
  }
}

/** Observe only the enrolled worker; do not open or retarget an unavailable checkout. */
export async function workerPlacementReady(registration: WorkerRegistration, workspace: Workspace): Promise<boolean> {
  return await availableSlots(registration, workspace) > 0;
}

/** Admission only: read approved inventory and live capacity; never start work here. */
export async function selectWorkerPlacement(
  config: Pick<Config, "stateDir">, cwd: string, placement?: WorkerSelector,
  admission?: { queued(): ReadonlyMap<string, number>; reserve(workerId: string): void },
): Promise<RemotePlacement | null> {
  if (placement?.target === "local") {
    if (placement.platform !== undefined || placement.worker !== undefined) {
      throw new WorkerPlacementError("Local placement cannot specify a remote worker or worker platform");
    }
    return null;
  }
  const required = placement?.target === "remote" || placement?.platform !== undefined || placement?.worker !== undefined;
  const registered = listWorkers(config.stateDir).filter(({ description, defaultRepository }) =>
    (required || defaultRepository !== undefined) && (placement?.worker === undefined || description.workerId === placement.worker)
    && (placement?.platform === undefined || description.platform === placement.platform));
  if (!registered.length) {
    if (!required) return null;
    throw new WorkerPlacementError("No paired worker matches the requested worker or platform");
  }
  const source = await workerRepositoryHead(cwd);
  if (!source) {
    if (!required) return null;
    throw new WorkerPlacementError("Remote placement requires a clean Git checkout with a verifiable network origin and a committed workspace directory");
  }
  const { root, ...workspace } = source;
  const candidates = registered.filter(({ description, defaultRepository }) =>
    description.repos.some(repo => repo.id === workspace.repoId) &&
    (required || (defaultRepository?.root === root && defaultRepository.repoId === workspace.repoId)));
  if (!candidates.length) {
    if (!required) return null;
    throw new WorkerPlacementError("No matching paired worker is approved for this repository identity");
  }
  const observed = await Promise.all(candidates.map(async worker => ({ worker, free: await availableSlots(worker, workspace) })));
  // Read and reserve synchronously after the SSH round trips: concurrent
  // admissions see each other's decisions without serializing network I/O.
  const queued = admission?.queued();
  const waiting = (worker: WorkerRegistration) => queued?.get(worker.description.workerId) ?? 0;
  observed.sort(({ worker: left }, { worker: right }) => {
    const a = left.description.workerId, b = right.description.workerId;
    return waiting(left) - waiting(right) || Number(right.defaultRepository !== undefined) - Number(left.defaultRepository !== undefined)
      || (a === b ? 0 : a < b ? -1 : 1);
  });
  // Explicit placement freezes its worker even when no candidate is ready now.
  // The runtime repeats this preflight on the selected worker before open.
  const selected = (observed.find(({ worker, free }) => free > waiting(worker)) ?? (required ? observed[0] : null))?.worker;
  if (!selected) return null;
  const { workerId, stateDir } = selected.description;
  admission?.reserve(workerId);
  return { workerId, stateDir, ...workspace };
}
