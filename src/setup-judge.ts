import type { SettingProvenance } from "@oh-my-pi/pi-coding-agent/config/settings";
import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type JudgeConfiguration =
  | { status: "configured" | "missing"; source: SettingProvenance }
  | { status: "unknown" };

async function isPresent(path: string): Promise<boolean> {
  try { await stat(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Read configuration only, after a new setup has successfully published. */
export async function inspectNativeJudge(cwd: string): Promise<JudgeConfiguration> {
  try {
    // Like setup-memory, keep even native dotenv/config imports behind setup's
    // credential acquisition and publication. Never resolve a model or open auth.
    const { Settings } = await import("@oh-my-pi/pi-coding-agent/config/settings");
    const settings = await Settings.loadReadOnly({ cwd });
    const source = settings.getModelRoleProvenance("judge");
    if (source === "default") {
      // Read-only settings intentionally skip legacy global migration. Only an
      // effective higher-layer assignment can settle the role without it; in
      // particular native project null falls through, unlike overlay null.
      const nativeSettings = import.meta.resolve("@oh-my-pi/pi-coding-agent/config/settings");
      const nativeDirs = Bun.resolveSync("@oh-my-pi/pi-utils/dirs", dirname(fileURLToPath(nativeSettings)));
      const { getAgentDir, getAgentDbPath, MAIN_CONFIG_FILENAMES } = await import(nativeDirs);
      const agentDir = getAgentDir();
      let hasModernConfig = false;
      for (const filename of MAIN_CONFIG_FILENAMES) {
        if (await isPresent(join(agentDir, filename))) {
          hasModernConfig = true;
          break;
        }
      }
      if (!hasModernConfig && (await Promise.all([
        isPresent(join(agentDir, "settings.json")), isPresent(getAgentDbPath(agentDir)),
      ])).some(Boolean)) return { status: "unknown" };
    }
    // Native modelRoles defaults to an empty record. This accessor normalizes
    // string/array selectors, but does not resolve aliases or automatic fallbacks.
    // Read the effective value, not a hidden global/project assignment: an
    // overlay null or empty value can hide a configured lower-layer judge.
    return {
      status: settings.getModelRole("judge")?.split(",").some(selector => selector.trim()) ? "configured" : "missing",
      source,
    };
  } catch {
    // Native parse/read diagnostics can contain private settings or selectors.
    return { status: "unknown" };
  }
}
