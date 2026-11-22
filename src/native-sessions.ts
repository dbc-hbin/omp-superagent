import * as fs from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { readSessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";

/** Stock OMP follows leaf session links for discovery and writes through them. */
export async function publishNativeSession(sessionFile: string, cwd: string, expectedId?: string): Promise<string | undefined> {
  const info = await readSessionInfo(sessionFile);
  if (!info) return;
  if (expectedId !== undefined && (info.id !== expectedId || info.cwd !== cwd))
    throw new Error("Refusing to publish a journal with a different managed session identity");
  const source = await fs.realpath(sessionFile);
  const directory = SessionManager.getDefaultSessionDir(cwd);
  const target = join(directory, `${info.created.toISOString().replace(/[:.]/g, "-")}_${info.id}.jsonl`);
  if (target === source) return target;

  const link = async (original: string, destination: string) => {
    try { await fs.symlink(original, destination); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await fs.readlink(destination).catch(() => undefined);
      if (!existing || resolve(dirname(destination), existing) !== original)
        throw new Error(`Native session discovery path already belongs to another file: ${destination}`);
    }
  };
  // The resumed session must keep its original spill artifacts and child journals.
  if (source.endsWith(".jsonl")) {
    const artifacts = source.slice(0, -".jsonl".length);
    await fs.mkdir(artifacts, { recursive: true, mode: 0o700 });
    await link(artifacts, target.slice(0, -".jsonl".length));
  }
  await link(source, target);
  return target;
}
