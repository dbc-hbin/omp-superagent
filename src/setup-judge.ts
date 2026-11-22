import type { SettingProvenance } from "@oh-my-pi/pi-coding-agent/config/settings";

type JudgeConfiguration =
  | { status: "configured" | "missing"; source: SettingProvenance }
  | { status: "unknown" };

/** Read configuration only, after a new setup has successfully published. */
export async function inspectNativeJudge(cwd: string): Promise<JudgeConfiguration> {
  try {
    // Keep even native dotenv/config imports behind setup's
    // credential acquisition and publication. Never resolve a model or open auth.
    const { Settings } = await import("@oh-my-pi/pi-coding-agent/config/settings");
    const settings = await Settings.loadReadOnly({ cwd });
    const source = settings.getModelRoleProvenance("judge");
    if (source === "default") {
      // Read-only settings intentionally skip legacy global migration. Only an
      // effective higher-layer assignment can settle the role without it; in
      // particular native project null falls through, unlike overlay null.
      const { hasUnresolvedNativeLegacy } = await import("./native-settings");
      if (await hasUnresolvedNativeLegacy(settings.getAgentDir())) return { status: "unknown" };
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
