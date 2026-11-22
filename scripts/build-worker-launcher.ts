#!/usr/bin/env bun
// Builds and ad-hoc signs the macOS worker launcher at worker-launcher/bin/ for inspection. A worker installs its
// own copy once through `bun run setup:macos-worker` (installWorkerLauncher); an installed launcher is never replaced.
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildWorkerLauncher, codesignIdentity } from "../src/worker-macos";

if (process.platform !== "darwin") {
  console.log("The worker launcher is macOS only; nothing to build");
} else {
  const destination = join(resolve(import.meta.dir, ".."), "worker-launcher", "bin", "omp-sa-worker-launcher");
  mkdirSync(join(destination, ".."), { recursive: true });
  buildWorkerLauncher(destination);
  console.log(`${destination} ${JSON.stringify(codesignIdentity(destination))}`);
}
