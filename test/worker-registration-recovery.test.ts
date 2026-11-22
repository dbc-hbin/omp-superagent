import { afterEach, expect, test } from "bun:test";
import {
  chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync,
  symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { selectWorkerPlacement } from "../src/worker-placement";
import { addWorker, listWorkers } from "../src/worker-registration";
import { lookupWorker, type WorkerDescription, type WorkerRegistration } from "../src/worker-wire";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const registrationModule = join(import.meta.dir, "../src/worker-registration.ts");
const wireModule = join(import.meta.dir, "../src/worker-wire.ts");
const repoId = "a".repeat(64);
const revision = "b".repeat(40);

function fixture() {
  const root = mkdtempSync(join(realpathSync("/tmp"), "wr-"));
  roots.push(root);
  const ancestor = join(root, "data");
  mkdirSync(ancestor, { mode: 0o700 });
  return { root, ancestor, stateDir: join(ancestor, "state") };
}

function enrollment(stateDir: string, workerId: string) {
  const options = { stateDir, destination: `worker@${workerId}.example.invalid` };
  const description: WorkerDescription = {
    workerId, platform: "linux", stateDir: `/worker/${workerId}/state`,
    repos: [{ id: repoId, cwd: "/worker/approved" }], capacity: 1, active: 0,
  };
  return { options, description, describe: async () => description };
}

function placement(description: WorkerDescription) {
  return { workerId: description.workerId, stateDir: description.stateDir, repoId, revision, subdir: "" };
}

async function pair(stateDir: string, workerId: string): Promise<WorkerRegistration> {
  const { options, description, describe } = enrollment(stateDir, workerId);
  expect((await addWorker(options, describe)).status).toBe("pending");
  expect((await addWorker(options, describe)).status).toBe("verified");
  return lookupWorker(stateDir, placement(description));
}

const sshProbe = { socket: false, sessionFile: false, pidAlive: false, ownerAlive: false, uncertain: false, pid: null, sessionId: null };

async function probeWithFixtureSsh(root: string, registration: WorkerRegistration) {
  const calls = join(root, "ssh-calls");
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "ssh"), `#!/bin/sh
while [ "$#" -gt 0 ] && [ "$1" != "-i" ]; do shift; done
[ "$#" -eq 5 ] && [ "$3" = "--" ] || exit 1
printf '%s\\n' "$2" "$4" >> "$CALLS"
IFS= read -r request || exit 1
printf '%s\\n' "$REPLY"
`, { mode: 0o700 });
  const ref = { laneId: "lane-owned", generation: 1, repoId, revision, subdir: "" };
  const probe = Bun.spawn([process.execPath, "--no-env-file", "-e", `
    import { workerProbe } from ${JSON.stringify(wireModule)};
    const fixture = JSON.parse(process.env.PROBE_FIXTURE);
    console.log(JSON.stringify(await workerProbe(fixture.registration, fixture.ref)));
  `], {
    env: { PATH: bin, CALLS: calls, REPLY: JSON.stringify({ ok: true, value: sshProbe }),
      PROBE_FIXTURE: JSON.stringify({ registration, ref }) },
    stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10_000,
  });
  const [code, stdout, stderr] = await Promise.all([probe.exited, new Response(probe.stdout).text(), new Response(probe.stderr).text()]);
  return { code, stdout, stderr, calls: existsSync(calls) ? readFileSync(calls, "utf8").trimEnd().split("\n") : [] };
}

test("an unavailable key leaves unrelated enrollment, lookup, status and local-by-default placement usable", async () => {
  const { root, stateDir } = fixture();
  const missing = await pair(stateDir, "missing");
  unlinkSync(missing.identityFile);

  const healthy = await pair(stateDir, "healthy");
  const removedKey = enrollment(stateDir, missing.description.workerId);
  await expect(addWorker(removedKey.options, removedKey.describe)).rejects.toThrow(/identity is unavailable or unsafe/);
  expect(existsSync(missing.identityFile)).toBe(false);
  expect(await lookupWorker(stateDir, placement(healthy.description))).toEqual(healthy);
  expect(await selectWorkerPlacement({ stateDir }, root)).toBeNull();
  const probe = await probeWithFixtureSsh(root, healthy);
  if (probe.code !== 0) throw new Error(probe.stderr);
  expect(JSON.parse(probe.stdout)).toEqual(sshProbe);
  expect(probe.calls).toEqual([healthy.identityFile, healthy.destination]);

  const config = join(root, "config.json");
  writeFileSync(config, JSON.stringify({
    stateDir, headCwd: root, command: [process.execPath], maxHosts: 2, maxSubagents: 2, idleMs: 0,
    telegram: { tokenEnv: "UNUSED_FIXTURE_TOKEN", ownerId: "123", allowedChatIds: [] },
  }));
  const status = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "../src/cli.ts"),
    "status", "--config", config], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10_000 });
  const [code, stdout, stderr] = await Promise.all([status.exited, new Response(status.stdout).text(), new Response(status.stderr).text()]);
  if (code !== 0) throw new Error(stderr);
  expect(JSON.parse(stdout).workers).toMatchObject([
    { destination: missing.destination, workerId: "missing", default: false },
    { destination: healthy.destination, workerId: "healthy", default: false },
  ]);
}, 15_000);

test.each(["missing", "symlink", "hard link", "exposed mode", "writable ancestor", "symlinked ancestor"] as const)(
  "SSH does not spawn with a %s on the selected endpoint after lookup", async problem => {
    const { root, ancestor, stateDir } = fixture();
    const registration = await pair(stateDir, "target");
    const { identityFile } = registration;
    const replacement = join(root, "replacement");
    writeFileSync(replacement, "not the enrolled identity", { mode: 0o600 });
    switch (problem) {
      case "missing": unlinkSync(identityFile); break;
      case "symlink":
        unlinkSync(identityFile);
        symlinkSync(replacement, identityFile);
        break;
      case "hard link": linkSync(identityFile, join(root, "alias")); break;
      case "exposed mode": chmodSync(identityFile, 0o644); break;
      case "writable ancestor": chmodSync(ancestor, 0o777); break;
      case "symlinked ancestor": {
        const moved = join(root, "moved");
        renameSync(ancestor, moved);
        symlinkSync(moved, ancestor);
        break;
      }
    }
    const probe = await probeWithFixtureSsh(root, registration);
    expect(probe.code).toBe(1);
    expect(probe.stderr).toContain("Dedicated worker SSH identity is unavailable or unsafe");
    expect(probe.calls).toEqual([]);
  }, 15_000);

test("a second enrollment cannot verify concurrently but can reacquire after the verifier is killed", async () => {
  const { stateDir } = fixture();
  const { options, description, describe } = enrollment(stateDir, "interrupted");
  expect((await addWorker(options, describe)).status).toBe("pending");
  const holder = Bun.spawn([process.execPath, "--no-env-file", "-e", `
    import { addWorker } from ${JSON.stringify(registrationModule)};
    const fixture = JSON.parse(process.env.ENROLLMENT_FIXTURE);
    await addWorker(fixture.options, async () => {
      console.log("verifying");
      await Bun.stdin.text();
      return fixture.description;
    });
  `], {
    env: { ENROLLMENT_FIXTURE: JSON.stringify({ options, description }) },
    stdin: "pipe", stdout: "pipe", stderr: "inherit", timeout: 10_000, killSignal: "SIGKILL",
  });
  const lines = createInterface({ input: Readable.fromWeb(holder.stdout) });
  try {
    const ready = await lines[Symbol.asyncIterator]().next();
    expect(ready.value).toBe("verifying");
    await expect(addWorker(options, describe)).rejects.toThrow(/Worker write lock unavailable/);
    expect(listWorkers(stateDir)).toEqual([]);

    holder.kill("SIGKILL");
    await holder.exited;
    expect(holder.signalCode).toBe("SIGKILL");
    await expect(addWorker(options, describe)).resolves.toMatchObject({ status: "verified", description });
    expect(listWorkers(stateDir).map(worker => worker.description.workerId)).toEqual(["interrupted"]);
  } finally {
    lines.close();
    if (holder.exitCode === null && holder.signalCode === null) holder.kill("SIGKILL");
    await holder.exited;
  }
}, 15_000);
