import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { canEnableGlobalMemory, effectiveMnemopi, type MnemopiReport, type MnemopiStatus } from "./managed-memory";

/** Only after explicit global consent and successful setup publication. */
export async function saveMnemopiPreference(settings: Settings, expected: MnemopiStatus): Promise<MnemopiReport> {
  try {
    const current = await effectiveMnemopi(settings);
    if (!canEnableGlobalMemory(current) || !Bun.deepEquals(current, expected)) {
      return { memory: current, updated: false };
    }
    const { editNativeGlobalConfig, readNativeSettings } = await import("./native-settings");
    const [updated] = await editNativeGlobalConfig(settings, [{ path: "memory.backend", value: "mnemopi" }],
      async actual => Bun.deepEquals(await effectiveMnemopi(actual), expected));
    // The native writer preserves concurrent settings. Report what the new process
    // will resolve, not the user's consent or a transient staged value.
    return { memory: await effectiveMnemopi(await readNativeSettings(settings)), updated: updated === true };
  } catch {
    // Native parse or lock errors can contain private settings.
    return { memory: { status: "unknown" }, updated: false };
  }
}
