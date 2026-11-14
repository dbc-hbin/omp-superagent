import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

type MemoryPreferenceResult =
  | { status: "enabled" | "shadowed" | "not-saved"; agentDir: string; source: string }
  | { status: "failed" };

/** Called only after setup's configuration and credentials have been published. */
export async function saveMnemopiPreference(cwd: string): Promise<MemoryPreferenceResult> {
  let settings: Settings | undefined;
  try {
    // Do not import the package entry point, a memory backend, or a model runtime.
    // Native settings transitively load native dotenv, so even these config-only
    // imports must stay behind credential acquisition and final publication.
    const [{ Settings }, { cfgMemoryBackend }] = await Promise.all([
      import("@oh-my-pi/pi-coding-agent/config/settings"),
      import("@oh-my-pi/pi-coding-agent/memory-backend/settings"),
    ]);
    // Config-only persistence must not open agent.db, migrate authentication,
    // quarantine malformed startup config, or initialize the global singleton.
    settings = await Settings.loadConfigOnly({ cwd });
    cfgMemoryBackend.set(settings, "mnemopi");
    await settings.flush();
    settings.cancelPendingSaves();

    // A flush may preserve a concurrent edit instead of applying our stale write.
    // A fresh, read-only instance is authoritative, not the writer's staged value.
    const actual = await Settings.loadReadOnly({ cwd, agentDir: settings.getAgentDir() });
    let persisted: unknown = actual.getGlobalSettings();
    for (const segment of cfgMemoryBackend.segments) {
      persisted = persisted && typeof persisted === "object" && Object.hasOwn(persisted, segment)
        ? (persisted as Record<string, unknown>)[segment] : undefined;
    }
    const source = actual.getProvenance(cfgMemoryBackend);
    return {
      status: persisted !== "mnemopi" ? "not-saved" : cfgMemoryBackend.get(actual) === "mnemopi" ? "enabled" : "shadowed",
      agentDir: actual.getAgentDir(), source,
    };
  } catch {
    // Native diagnostics can contain config values. Never echo a caught error or
    // undo setup publication / unrelated native writes to compensate for failure.
    return { status: "failed" };
  } finally {
    settings?.cancelPendingSaves();
  }
}
