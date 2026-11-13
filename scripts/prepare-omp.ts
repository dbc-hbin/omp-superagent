#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { updateManagedUlw } from "../src/managed-ulw";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = await Bun.file(join(root, "upstream", "omp.json")).json() as {
  repository: string; tag: string; revision: string; checkout: string; patches: string[];
};
const upstream = resolve(root, source.checkout);
const revision = source.revision;
async function run(args: string[], cwd = root): Promise<string> {
  const proc = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "inherit" });
  const text = await new Response(proc.stdout).text();
  if (await proc.exited !== 0) throw new Error(`Command failed: ${args.join(" ")}`);
  return text.trim();
}

if (!existsSync(join(upstream, ".git"))) {
  await run(["git", "clone", "--depth=1", "--branch", source.tag, source.repository, upstream]);
}
if (await run(["git", "rev-parse", "HEAD"], upstream) !== revision)
  throw new Error("OMP checkout differs from the pinned revision; preserve it and prepare a separate checkout");
const patches = source.patches;
if (!patches.length) throw new Error("No OMP integration patch is present");
for (const patch of patches) {
  const path = resolve(root, patch);
  const reverse = Bun.spawn(["git", "apply", "--reverse", "--check", path], { cwd: upstream, stdout: "ignore", stderr: "ignore" });
  if (await reverse.exited === 0) { console.log(`Already applied: ${patch}`); continue; }
  await run(["git", "apply", "--check", path], upstream);
  await run(["git", "apply", path], upstream);
}
await run([process.execPath, "install", "--frozen-lockfile"], upstream);
await updateManagedUlw();
console.log(`Prepared ${upstream} at ${revision}. Installed system omp was not replaced.`);
