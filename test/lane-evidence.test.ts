import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectEvidence, EVIDENCE_LIMIT } from "../src/lane-evidence";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function workspace() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lane-evidence-")));
  roots.push(root);
  const cwd = join(root, "repo");
  mkdirSync(cwd);
  writeFileSync(join(root, "secret.txt"), "outside");
  return { root, cwd };
}

const git = (cwd: string, ...args: string[]) => {
  const child = Bun.spawnSync(["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args]);
  expect(child.exitCode).toBe(0);
};

test("file evidence is bounded and confined to the lane workspace after resolving symlinks", async () => {
  const { root, cwd } = workspace();
  writeFileSync(join(cwd, "report.txt"), "0123456789");
  writeFileSync(join(cwd, "large.log"), "x".repeat(EVIDENCE_LIMIT + 10));
  symlinkSync(join(root, "secret.txt"), join(cwd, "escape.txt"));
  expect(await collectEvidence(cwd, { kind: "file", path: "report.txt", offset: 2, limit: 3 }))
    .toEqual({ kind: "file", cwd, path: join(cwd, "report.txt"), text: "234", bytes: 10, truncated: true });
  expect(await collectEvidence(cwd, { kind: "file", path: join(cwd, "report.txt") })).toMatchObject({ text: "0123456789", truncated: false });
  expect(await collectEvidence(cwd, { kind: "file", path: "large.log" })).toMatchObject({ bytes: EVIDENCE_LIMIT + 10, truncated: true });
  await expect(collectEvidence(cwd, { kind: "file", path: "../secret.txt" })).rejects.toThrow("outside the lane workspace");
  await expect(collectEvidence(cwd, { kind: "file", path: "escape.txt" })).rejects.toThrow("outside the lane workspace");
  await expect(collectEvidence(cwd, { kind: "file", path: "missing.txt" })).rejects.toThrow("does not exist");
  await expect(collectEvidence(cwd, { kind: "file", path: "." })).rejects.toThrow("not a regular file");
});

test("git evidence reports status, log and diff stat without changing the repository", async () => {
  const { cwd } = workspace();
  git(cwd, "init", "-q", "-b", "main");
  writeFileSync(join(cwd, "a.txt"), "one\n");
  git(cwd, "add", "a.txt");
  git(cwd, "commit", "-q", "-m", "first evidence commit");
  writeFileSync(join(cwd, "a.txt"), "one\ntwo\n");
  expect((await collectEvidence(cwd, { kind: "git", command: "status" })).text).toContain("## main\n M a.txt");
  expect((await collectEvidence(cwd, { kind: "git", command: "log", count: 1 })).text).toContain("first evidence commit");
  expect((await collectEvidence(cwd, { kind: "git", command: "diff-stat" })).text).toContain("a.txt | 1 +");
  const plain = workspace().cwd;
  expect(await collectEvidence(plain, { kind: "git", command: "status" })).toMatchObject({ exitCode: 128, text: expect.stringContaining("not a git repository") });
});

test("the Host log artifact is read from its tail", async () => {
  const { root, cwd } = workspace();
  const log = join(root, "r1.log");
  writeFileSync(log, "early\nlate\n");
  expect(await collectEvidence(cwd, { kind: "artifact", name: "host-log", limit: 5 }, log))
    .toEqual({ kind: "artifact", cwd, path: log, text: "late\n", bytes: 11, truncated: true });
  await expect(collectEvidence(cwd, { kind: "artifact", name: "host-log" })).rejects.toThrow("no Host log");
});
