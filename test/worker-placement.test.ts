import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { addWorker, listWorkers } from "../src/worker-registration";
import { workerRepositoryIdentity } from "../src/worker-repository";
import type { WorkerDescription, WorkerSelector } from "../src/worker-wire";

const placementModule = fileURLToPath(new URL("../src/worker-placement.ts", import.meta.url));
const origin = "https://github.com/example/project.git";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["/usr/bin/git", "-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "-c", "commit.gpgSign=false", ...args], {
    env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10_000,
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trimEnd();
}

async function repo(cwd: string, url: string): Promise<void> {
  await mkdir(join(cwd, "docs"), { recursive: true });
  git(cwd, "init", "--quiet", "--template=");
  git(cwd, "remote", "add", "origin", url);
  await writeFile(join(cwd, "docs", "note"), "committed text\n");
  await writeFile(join(cwd, ".gitignore"), "private.txt\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "--quiet", "-m", "Fixture");
}

async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "omp-sa-placement-")));
  roots.push(root);
  const cwd = join(root, "source", "project");
  const stateDir = join(root, "state");
  const bin = join(root, "bin");
  const replies = join(root, "replies");
  const calls = join(root, "describes");
  await Promise.all([mkdir(bin), mkdir(replies), repo(cwd, origin)]);
  await writeFile(join(bin, "ssh"), `#!/bin/sh
while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done
[ "$#" -eq 3 ] && [ "$3" = "omp-sa-worker-v1" ] || exit 11
IFS= read -r request || exit 12
case "$request" in *'"op":"describe"'*'"workspace":'*) ;; *) exit 13 ;; esac
printf '%s\\n' "$2" >> "$DESCRIBE_CALLS"
printf '%s\\n' "$request" >> "$DESCRIBE_CALLS.requests"
exec /bin/cat "$DESCRIBE_REPLIES/$2.json"
`, { mode: 0o700 });
  // Measure the paired inventory independently from the source checkout.
  const workerRepo = join(root, "worker", "project");
  await repo(workerRepo, "git@github.com:example/project");
  const repoId = await workerRepositoryIdentity(workerRepo);
  if (!repoId) throw new Error("Fixture could not identify the worker repository");
  return { root, cwd, stateDir, bin, calls, replies, workerRepo, repoId };
}

type Fixture = Awaited<ReturnType<typeof setup>>;

async function pair(f: Fixture, worker: {
  readonly id: string;
  readonly platform?: WorkerDescription["platform"];
  readonly preferred?: boolean;
  readonly live?: Partial<WorkerDescription>;
  readonly refusal?: string;
}) {
  const destination = `worker@${worker.id}.example.invalid`;
  const description = {
    workerId: worker.id, platform: worker.platform ?? "linux", stateDir: `/worker/${worker.id}/state`,
    repos: [{ id: f.repoId, cwd: f.workerRepo }], capacity: 1, active: 0,
  };
  const add = { stateDir: f.stateDir, destination, ...(worker.preferred && { defaultRepositoryRoot: f.cwd }) };
  await addWorker(add, async () => description);
  await addWorker(add, async () => description);
  const reply = worker.refusal ? { ok: false, error: worker.refusal } : { ok: true, value: { ...description, ...worker.live } };
  await writeFile(join(f.replies, `${destination}.json`), `${JSON.stringify(reply)}\n`);
  return { destination, description };
}

async function place(f: Fixture, cwd: string, selector?: WorkerSelector): Promise<unknown> {
  // Isolate PATH in a child instead of modifying the test runner's environment.
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", `
    import { selectWorkerPlacement } from ${JSON.stringify(placementModule)};
    const { stateDir, cwd, selector } = JSON.parse(process.env.PLACEMENT_ARGS);
    try {
      console.log(JSON.stringify({ value: await selectWorkerPlacement({ stateDir }, cwd, selector) }));
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      console.log(JSON.stringify({ error: error.message }));
    }
  `], {
    cwd: f.root,
    env: {
      PATH: f.bin, HOME: f.root, DESCRIBE_CALLS: f.calls, DESCRIBE_REPLIES: f.replies,
      PLACEMENT_ARGS: JSON.stringify({ stateDir: f.stateDir, cwd, selector }),
    },
    stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10_000, killSignal: "SIGKILL",
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(stderr);
  return JSON.parse(stdout);
}

test("pairing a matching worker without a default does not opt ordinary lanes into remote execution", async () => {
  const f = await setup();
  await pair(f, { id: "worker-a" });

  expect(await place(f, f.cwd)).toEqual({ value: null });
  expect(existsSync(f.calls)).toBe(false);
});

test("a verified default pins the exact committed subdirectory without looking at ignored private files", async () => {
  const f = await setup();
  const { destination, description } = await pair(f, { id: "worker-a", preferred: true });
  git(f.cwd, "remote", "set-url", "origin", "https://user:fixture-only@github.com/example/project.git");
  await writeFile(join(f.cwd, "private.txt"), "ignored secret fixture");
  const revision = git(f.cwd, "rev-parse", "HEAD");

  expect(await place(f, join(f.cwd, "docs"))).toEqual({ value: {
    workerId: description.workerId, stateDir: description.stateDir, repoId: f.repoId, revision, subdir: "docs",
  } });
  expect(await readFile(f.calls, "utf8")).toBe(`${destination}\n`);
  expect(JSON.parse(await readFile(`${f.calls}.requests`, "utf8")).workspace)
    .toEqual({ repoId: f.repoId, revision, subdir: "docs" });
});

test.each([false, true])("a same-origin, same-revision second checkout needs explicit remote placement (%s)", async explicit => {
  const f = await setup();
  const { destination, description } = await pair(f, { id: "worker-a", preferred: true });
  const otherCheckout = join(f.root, "other");
  git(f.root, "clone", "--quiet", "--local", "--no-hardlinks", f.cwd, otherCheckout);
  git(otherCheckout, "remote", "set-url", "origin", origin);
  const revision = git(f.cwd, "rev-parse", "HEAD");

  const result = await place(f, otherCheckout, explicit ? { target: "remote" } : undefined);

  if (explicit) {
    expect(result).toEqual({ value: {
      workerId: description.workerId, stateDir: description.stateDir, repoId: f.repoId, revision, subdir: "",
    } });
    expect(await readFile(f.calls, "utf8")).toBe(`${destination}\n`);
  } else {
    expect(result).toEqual({ value: null });
    expect(existsSync(f.calls)).toBe(false);
  }
});

test("a legacy boolean default remains non-disclosing after ordinary registration refresh", async () => {
  const f = await setup();
  const { destination, description } = await pair(f, { id: "worker-a" });
  await writeFile(join(f.stateDir, "workers", "verified.json"),
    JSON.stringify(listWorkers(f.stateDir).map(worker => ({ ...worker, default: true }))));
  await addWorker({ destination, stateDir: f.stateDir }, async () => description);

  expect(await place(f, f.cwd)).toEqual({ value: null });
  expect(existsSync(f.calls)).toBe(false);
});

test.each([true, false])("the bound checkout's new revision needs a fresh scoped worker receipt (ready: %s)", async ready => {
  const f = await setup();
  const { description } = await pair(f, { id: "worker-a", preferred: true,
    refusal: ready ? undefined : "Checkout is not at the requested revision" });
  git(f.cwd, "commit", "--quiet", "--allow-empty", "-m", "New revision");
  const revision = git(f.cwd, "rev-parse", "HEAD");

  expect(await place(f, f.cwd)).toEqual({ value: ready ? {
    workerId: description.workerId, stateDir: description.stateDir, repoId: f.repoId, revision, subdir: "",
  } : null });
  expect(JSON.parse(await readFile(`${f.calls}.requests`, "utf8")).workspace)
    .toEqual({ repoId: f.repoId, revision, subdir: "" });
});

test("explicit local placement opts out of a paired default", async () => {
  const f = await setup();
  await pair(f, { id: "worker-a", preferred: true });

  expect(await place(f, f.cwd, { target: "local" })).toEqual({ value: null });
  expect(existsSync(f.calls)).toBe(false);
});

test("platform selection deterministically skips stale, full, and changed worker inventory", async () => {
  const f = await setup();
  const high = await pair(f, { id: "worker-e" });
  const selected = await pair(f, { id: "worker-d" });
  const moved = await pair(f, { id: "worker-c", live: { repos: [{ id: f.repoId, cwd: "/moved/project" }] } });
  const full = await pair(f, { id: "worker-b", live: { active: 1 } });
  const stale = await pair(f, { id: "worker-aa", refusal: "Checkout is not at the requested revision" });
  await pair(f, { id: "worker-a", platform: "darwin" });
  const revision = git(f.cwd, "rev-parse", "HEAD");

  expect(await place(f, f.cwd, { platform: "linux" })).toEqual({ value: {
    workerId: "worker-d", stateDir: selected.description.stateDir, repoId: f.repoId, revision, subdir: "",
  } });
  expect((await readFile(f.calls, "utf8")).trimEnd().split("\n").sort()).toEqual([
    stale.destination, full.destination, moved.destination, selected.destination, high.destination,
  ]);
});

test("an exact unavailable worker remains pinned instead of substituting another connected worker", async () => {
  const f = await setup();
  await pair(f, { id: "worker-a" });
  const { destination, description } = await pair(f, { id: "worker-b", live: { active: 1 } });
  const revision = git(f.cwd, "rev-parse", "HEAD");

  expect(await place(f, f.cwd, { worker: "worker-b" })).toEqual({
    value: { workerId: "worker-b", stateDir: description.stateDir, repoId: f.repoId, revision, subdir: "" },
  });
  expect(await readFile(f.calls, "utf8")).toBe(`${destination}\n`);
});

test("remote placement refuses identical repository basenames under different owners before SSH", async () => {
  const f = await setup();
  await pair(f, { id: "worker-a", preferred: true });
  git(f.cwd, "remote", "set-url", "origin", "https://github.com/another-owner/project.git");

  expect(await place(f, f.cwd, { target: "remote" })).toEqual({
    error: expect.stringContaining("this repository identity"),
  });
  expect(existsSync(f.calls)).toBe(false);
});

test("a local-only clone without a verifiable network origin stays local despite a paired default", async () => {
  const f = await setup();
  await pair(f, { id: "worker-a", preferred: true });
  git(f.cwd, "remote", "set-url", "origin", f.workerRepo);

  expect(await place(f, f.cwd)).toEqual({ value: null });
  expect(existsSync(f.calls)).toBe(false);
});

test("the default does not disclose when Git rewrites the pinned checkout's origin to another repository", async () => {
  const f = await setup();
  await pair(f, { id: "worker-a", preferred: true });
  git(f.cwd, "config", "--local", "url.https://github.com/other/project.git.insteadOf", origin);

  expect(await place(f, f.cwd)).toEqual({ value: null });
  expect(existsSync(f.calls)).toBe(false);
});

test.each(["tracked", "staged", "untracked", "assume-unchanged", "skip-worktree"] as const)(
  "required remote placement refuses %s source changes", async kind => {
  const f = await setup();
  await pair(f, { id: "worker-a" });
  const file = kind === "untracked" ? "untracked.txt" : "docs/note";
  if (kind === "assume-unchanged" || kind === "skip-worktree") git(f.cwd, "update-index", `--${kind}`, file);
  await writeFile(join(f.cwd, file), "uncommitted contents\n");
  if (kind === "staged") git(f.cwd, "add", file);

  expect(await place(f, f.cwd, { target: "remote" })).toEqual({
    error: expect.stringContaining("clean Git checkout"),
  });
  expect(existsSync(f.calls)).toBe(false);
});

test.each(["clean", "process"])("read-only preflight accepts identical tracked bytes without invoking a configured %s converter", async filter => {
  const f = await setup();
  const { description } = await pair(f, { id: "worker-a" });
  await writeFile(join(f.cwd, ".gitattributes"), "docs/note filter=fixture\n");
  git(f.cwd, "add", ".gitattributes");
  git(f.cwd, "commit", "--quiet", "-m", "Declare converter attribute");
  git(f.cwd, "config", "--local", `filter.fixture.${filter}`, "/usr/bin/false");
  git(f.cwd, "config", "--local", "filter.fixture.required", "true");
  // Force a normal Git refresh to re-read the file instead of trusting its stat cache.
  const old = new Date("2020-01-01T00:00:00Z");
  await utimes(join(f.cwd, "docs", "note"), old, old);
  const revision = git(f.cwd, "rev-parse", "HEAD");

  expect(await place(f, f.cwd, { target: "remote" })).toEqual({ value: {
    workerId: description.workerId, stateDir: description.stateDir, repoId: f.repoId, revision, subdir: "",
  } });
});

test("a checkout with a separate Git directory is refused before contacting the worker", async () => {
  const f = await setup();
  await pair(f, { id: "worker-a" });
  git(f.cwd, "init", "--quiet", `--separate-git-dir=${join(f.root, "redirected-metadata")}`);

  expect(await place(f, f.cwd, { target: "remote" })).toEqual({
    error: expect.stringContaining("clean Git checkout"),
  });
  expect(existsSync(f.calls)).toBe(false);
});
