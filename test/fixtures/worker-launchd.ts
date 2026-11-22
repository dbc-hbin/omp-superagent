import { strict as assert } from "node:assert";
import { dlopen, FFIType } from "bun:ffi";
import { LABEL_PREFIX } from "../../src/worker-user-context";

/** Real-launchd loopback proofs run the worker's user context for real (macOS only). */
export const launchdAvailable = process.platform === "darwin" && process.env.OMP_SUPERAGENT_NATIVE_TEST === "1";

function run(command: string[]): string {
  return Bun.spawnSync(command, { stdin: "ignore", stdout: "pipe", stderr: "ignore" }).stdout.toString("utf8");
}

/**
 * A Host owner started through the worker's real LaunchAgent is detached from
 * every parent (launchd's child, not the endpoint's or an SSH session's) and its
 * responsible process is the fixed launcher, the identity the owner's one-time
 * privacy grants belong to.
 */
export function assertLaunchdOwner(ownerPid: number, launcher: string): void {
  assert.equal(run(["ps", "-o", "ppid=", "-p", String(ownerPid)]).trim(), "1", "Host owner must be detached from the endpoint");
  const { symbols } = dlopen("/usr/lib/libSystem.B.dylib", { responsibility_get_pid_responsible_for_pid: { args: [FFIType.i32], returns: FFIType.i32 } });
  const responsible = symbols.responsibility_get_pid_responsible_for_pid(ownerPid);
  assert.notEqual(responsible, ownerPid, "Host owner must not be its own responsible process");
  assert.equal(run(["ps", "-o", "command=", "-p", String(responsible)]).split(" --status ")[0]!.trim(), launcher);
}

/** Launcher jobs remove themselves once their Host and tools are gone; wait for that so none outlive the proof. */
export async function awaitNoWorkerJobs(): Promise<void> {
  const deadline = Date.now() + 20_000;
  // Polls launchd's job table: removal has no event to await.
  while (run(["launchctl", "list"]).split("\n").some(line => line.includes(LABEL_PREFIX))) {
    assert.ok(Date.now() < deadline, "Worker LaunchAgent jobs outlived their Hosts");
    await Bun.sleep(100);
  }
}
