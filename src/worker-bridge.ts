import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hostOwnerExecutable } from "./host-owner-path";
import { WorkerRefusal } from "./worker-request";
import { trustedWorkerPath } from "./worker-trust";
import type { WorkerPolicy } from "./worker-wire";

export function workerBridgePaths(repos: WorkerPolicy["repos"]) {
  return {
    bin: trustedWorkerPath(hostOwnerExecutable, repos, "file"),
    bun: trustedWorkerPath(realpathSync(process.execPath), repos, "file"),
    helper: trustedWorkerPath(fileURLToPath(new URL("./worker-serve-prepare.ts", import.meta.url)), repos, "file"),
  };
}

/** Preserve the PID sshd is waiting on, and transfer unread stdin without a JS pipe. */
export function execWorkerBridge(policy: WorkerPolicy, path: string): never {
  const { bin, bun, helper } = workerBridgePaths(policy.repos);
  if (!process.execve) throw new WorkerRefusal("Worker serve requires Bun execve support");
  return process.execve(bin, [bin, "--worker-serve", bun, helper, path], process.env);
}
