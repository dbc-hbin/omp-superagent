import { realpathSync } from "node:fs";
import { sep } from "node:path";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import { readManagedUlwPackage } from "./managed-ulw";

/** Inspect this stock session's bound factories, not a second SDK loader or launch argv. */
export async function verifyHostSuperkit(session: AgentSession, selected: string | undefined): Promise<string> {
  if (!selected) throw new Error("Managed omp-superkit launch path is missing");
  const { packagePath, extensionFiles } = readManagedUlwPackage(selected);
  const missingModule = () => {
    const runner = session.extensionRunner;
    if (!runner || typeof runner.getLoadedExtensions !== "function" || typeof runner.isExtensionActive !== "function")
      throw new Error("Installed OMP cannot report its active extensions");
    const active = new Set(runner.getLoadedExtensions()
      .filter(ext => ext.resolvedPath.startsWith(packagePath + sep) && runner.isExtensionActive(ext.path))
      .map(ext => realpathSync(ext.resolvedPath)));
    return extensionFiles.find(file => !active.has(file));
  };
  let missing = missingModule();
  if (missing && session.hasPendingDeferredExtensions) {
    await session.loadDeferredExtensions();
    missing = missingModule();
  }
  if (missing) throw new Error(`Managed omp-superkit extension is not active: ${missing}`);
  return packagePath;
}
