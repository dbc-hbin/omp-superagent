import { lstatSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkerRefusal } from "./worker-request";
import type { WorkerPolicy } from "./worker-wire";

const controls = /[\u0000-\u001f\u007f]/;
export const workerInstallRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

function within(root: string, candidate: string): boolean {
  const suffix = relative(root, candidate);
  return !isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`);
}

/** A trusted input is a local account/system path that no enrolled tree or other user can replace. */
export function trustedWorkerPath(path: string, repos: WorkerPolicy["repos"], kind: "file" | "directory" | "profile"): string {
  const fail = () => new WorkerRefusal(`Worker ${kind} input must be an owned canonical path outside enrolled checkouts`);
  if (!isAbsolute(path) || resolve(path) !== path || controls.test(path) || repos.some(repo => within(repo.cwd, path)))
    throw fail();
  // realpath can preserve the caller's spelling on a case-insensitive volume.
  const enrolled = new Set(repos.flatMap(repo => {
    const stat = lstatSync(repo.cwd, { throwIfNoEntry: false });
    return stat ? [`${stat.dev}:${stat.ino}`] : [];
  }));
  for (let dir = path; ; dir = dirname(dir)) {
    const stat = lstatSync(dir, { throwIfNoEntry: false });
    if (stat) {
      const stickyRoot = dir !== path && stat.uid === 0 && stat.isDirectory() && (stat.mode & 0o1000) !== 0;
      if (enrolled.has(`${stat.dev}:${stat.ino}`) || (stat.uid !== 0 && stat.uid !== process.getuid?.()) ||
          ((stat.mode & 0o022) !== 0 && !stickyRoot) ||
          (dir === path && kind === "file" ? !stat.isFile() : !stat.isDirectory())) throw fail();
    } else if (dir === path && kind !== "profile") throw fail();
    if (dirname(dir) === dir) break;
  }
  return path;
}
