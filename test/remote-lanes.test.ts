import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../src/config";
import type { WorkerPlacement } from "../src/contracts";
import { activeManagedUlwRevision } from "../src/managed-ulw";
import { MINIMUM_WORKER_OMP, prepareWorkerLaunch, requireCompatibleWorker, requireWorkerModel } from "../src/remote-lanes";
import { workerPackage, type WorkerCapability } from "../src/remote-worker-wire";
import { Store } from "../src/store";

const placement: WorkerPlacement = { worker: "builder", destination: "build-alias", workerId: "dbaf439b-f2f3-47b4-abf0-73beee9d7833" };
const head = activeManagedUlwRevision().revision;

function capability(patch: Partial<WorkerCapability> = {}): WorkerCapability {
  return {
    package: workerPackage(), platform: "linux", bootId: "boot", clock: Date.now(), omp: MINIMUM_WORKER_OMP,
    superkit: head, roots: ["/worker"], models: ["fixture/capable"], ...patch,
  };
}

function context(superkit: "managed" | "none") {
  const directory = realpathSync(mkdtempSync("/tmp/sa-remote-lanes-"));
  const config = {
    path: join(directory, "config.json"), stateDir: directory, headCwd: directory, command: ["omp"], maxHosts: 2, maxSubagents: 2, idleMs: 0,
    workers: { builder: { destination: placement.destination, workerId: placement.workerId, superkit } },
  } satisfies Config;
  return { config, store: new Store(join(directory, "coordination.sqlite")) };
}

test("a worker must run HEAD's exact package, a supported OMP and a synchronized clock", () => {
  expect(() => requireCompatibleWorker(capability())).not.toThrow();
  expect(() => requireCompatibleWorker(capability({ package: { ...workerPackage(), digest: "0".repeat(64) } })))
    .toThrow("install HEAD's exact release");
  expect(() => requireCompatibleWorker(capability({ package: { ...workerPackage(), version: "0.0.1" } })))
    .toThrow("install HEAD's exact release");
  expect(() => requireCompatibleWorker(capability({ omp: "1.0.0" }))).toThrow(`older than the required ${MINIMUM_WORKER_OMP}`);
  expect(() => requireCompatibleWorker(capability({ clock: Date.now() - 5 * 60_000 }))).toThrow("clock differs");
});

test("a worker must be a Linux or macOS machine", () => {
  for (const platform of ["linux", "darwin"]) expect(() => requireCompatibleWorker(capability({ platform }))).not.toThrow();
  expect(() => requireCompatibleWorker(capability({ platform: "win32" }))).toThrow("Worker platform win32 is not supported");
});

test("lane models are checked against the worker's own catalog, not HEAD's", () => {
  expect(() => requireWorkerModel(capability(), { provider: "fixture", id: "capable" })).not.toThrow();
  expect(() => requireWorkerModel(capability(), { provider: "head", id: "only" })).toThrow("not available from the worker");
});

test("a managed worker gets HEAD's pinned superkit; a matching worker is not reprovisioned", async () => {
  const provisioned: string[] = [];
  const adapters = (reported: string | null) => ({
    remoteCapability: async () => capability({ superkit: reported }),
    remoteProvision: async (_placement: WorkerPlacement, _instance: string, pack: { provenance: { revision: string }; digest: string; bytes: Uint8Array }) => {
      expect(pack.digest).toMatch(/^[0-9a-f]{64}$/);
      expect(pack.bytes.length).toBeGreaterThan(0);
      provisioned.push(pack.provenance.revision);
      return { revision: pack.provenance.revision, changed: true };
    },
  });
  expect(await prepareWorkerLaunch(context("managed"), adapters(null), placement)).toBe(head);
  expect(await prepareWorkerLaunch(context("managed"), adapters("b".repeat(40)), placement)).toBe(head);
  expect(provisioned).toEqual([head, head]);
  expect(await prepareWorkerLaunch(context("managed"), adapters(head), placement)).toBe(head);
  expect(provisioned).toHaveLength(2);
});

test("a plain worker launches without superkit and an incompatible one is refused before provisioning", async () => {
  const unexpected = async () => { throw new Error("Unexpected provisioning"); };
  expect(await prepareWorkerLaunch(context("none"), { remoteCapability: async () => capability({ superkit: null }), remoteProvision: unexpected }, placement))
    .toBeNull();
  await expect(prepareWorkerLaunch(context("managed"), { remoteCapability: async () => capability({ omp: "1.0.0", superkit: null }), remoteProvision: unexpected },
    placement)).rejects.toThrow("older than the required");
});
