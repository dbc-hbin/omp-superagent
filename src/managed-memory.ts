import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { Type, type Static } from "@sinclair/typebox";
import { IsStandardObject as isRecord, Value } from "@sinclair/typebox/value";
import { fileURLToPath } from "node:url";
import { credentialEnvNames, type Config } from "./config";

const nativeScope = {
  source: Type.Union([Type.Literal("default"), Type.Literal("global"), Type.Literal("project"),
    Type.Literal("overlay"), Type.Literal("env"), Type.Literal("runtime")]),
  agentDir: Type.String(),
};
const enabledMemory = Type.Object({
  ...nativeScope,
  status: Type.Literal("enabled"),
  backend: Type.Union([Type.Literal("local"), Type.Literal("hindsight"), Type.Literal("mnemopi"), Type.Literal("sharpshooter")]),
});
const missingMemory = Type.Object({ ...nativeScope, status: Type.Literal("missing"), backend: Type.Literal("off") });
const memoryStatus = Type.Union([enabledMemory, missingMemory, Type.Object({
  status: Type.Union([Type.Literal("legacy"), Type.Literal("unknown"), Type.Literal("unbound-profile")]),
})]);
const memoryReport = Type.Object({ memory: memoryStatus, updated: Type.Boolean() });
export type ManagedMemoryStatus = Static<typeof memoryStatus>;
export type ManagedMemoryReport = Static<typeof memoryReport>;
type GlobalMemoryCandidate = Static<typeof missingMemory> & { source: "default" | "global" };

export async function effectiveManagedMemory(settings: Settings, writeAgentDir: string | null): Promise<ManagedMemoryStatus> {
  const { cfgMemoryBackend } = await import("@oh-my-pi/pi-coding-agent/memory-backend/settings");
  // The SDK reads an unrecognized selector as its default. It may belong to a newer CLI;
  // never replace that explicit choice as if the operator had selected "off".
  const configured = settings.rawValue(cfgMemoryBackend);
  if (configured !== undefined && !cfgMemoryBackend.accepts(configured)) return { status: "unknown" };
  // The RPC soft pin uses this setting's own schema default when unconfigured.
  // Do not write a runtime override to the read-only snapshot used for consent.
  const backend = cfgMemoryBackend.get(settings);
  const agentDir = settings.getAgentDir();
  let source = cfgMemoryBackend.provenance(settings);
  if (source === "default") {
    // Native provenance reports the default for a masked selector as well as an
    // absent one. Inspect the native layers before authorizing a global edit.
    const { overrides, configOverlay, project, global } = settings.mirrorState();
    for (const [owner, layer] of [
      ["runtime", overrides], ["overlay", configOverlay], ["project", project], ["global", global],
    ] as const) {
      const section = layer.memory;
      if (section === undefined) continue;
      if (section !== null && !isRecord(section)) return { status: "unknown" };
      if (owner !== "global" && (section === null || section.backend === null)) {
        source = owner;
        break;
      }
    }
    if (source === "default") {
      const { hasUnresolvedNativeLegacy } = await import("./native-settings");
      if (await hasUnresolvedNativeLegacy(agentDir)) return { status: "legacy" };
    }
  }
  if (backend !== "off") return { status: "enabled", backend, source, agentDir };
  if (source === "default" || source === "global") {
    if (agentDir !== writeAgentDir) return { status: "unbound-profile" };
    const { hasUnresolvedNativeProjectSettings } = await import("./native-settings");
    if (await hasUnresolvedNativeProjectSettings(settings)) return { status: "unknown" };
  }
  return { status: "missing", backend, source, agentDir };
}

export function canEnableGlobalMemory(memory: ManagedMemoryStatus): memory is GlobalMemoryCandidate {
  return memory.status === "missing" && (memory.source === "default" || memory.source === "global");
}

/** Setup binds the edit to the profile shown before final save; startup uses its launch profile. */
export async function ensureManagedMemory(settings: Settings, writeAgentDir: string | null, expected?: GlobalMemoryCandidate): Promise<ManagedMemoryReport> {
  try {
    const current = await effectiveManagedMemory(settings, writeAgentDir);
    if (!canEnableGlobalMemory(current) || (expected && !Bun.deepEquals(current, expected))) {
      return { memory: current, updated: false };
    }
    const { editNativeGlobalConfig, readNativeSettings } = await import("./native-settings");
    const [updated] = await editNativeGlobalConfig(settings, [{ path: "memory.backend", value: "mnemopi" }],
      async actual => Bun.deepEquals(await effectiveManagedMemory(actual, writeAgentDir), current));
    // A concurrent edit may have selected another usable backend or disabled this workspace.
    return { memory: await effectiveManagedMemory(await readNativeSettings(settings), writeAgentDir), updated: updated === true };
  } catch {
    // Native parse or lock errors can contain private settings.
    return { memory: { status: "unknown" }, updated: false };
  }
}

export function parseMemoryConsent(bytes: string): GlobalMemoryCandidate {
  const value: unknown = JSON.parse(bytes);
  if (!Value.Check(memoryStatus, value) || !canEnableGlobalMemory(value))
    throw new Error("Expected consent to repair the current global memory preference");
  return value;
}

export function memoryBlockReason(memory: ManagedMemoryStatus): string {
  const requirement = "Managed sessions require an enabled native OMP memory backend.";
  switch (memory.status) {
    case "enabled": return "";
    case "unbound-profile": return `${requirement} Automatic configuration is limited to the operator's launch profile. Enable memory in the effective profile or select it explicitly at launch.`;
    case "unknown": return `${requirement} Native memory settings could not be verified; inspect the selected profile and launch overlays.`;
    case "legacy": return `${requirement} Unmigrated native settings could not be verified; migrate them with ordinary stock OMP in the selected profile first.`;
    case "missing": return `${requirement} Effective backend is ${memory.backend} (${memory.source} settings). ${
      canEnableGlobalMemory(memory) ? "Run interactive setup or configure the selected native profile."
        : "Review the overriding native settings for this workspace; Superagent does not change them."}`;
  }
}

export async function inspectManagedMemory(config: Config): Promise<ManagedMemoryStatus> {
  return (await runMemoryHelper(config)).memory;
}

export function applyConsentedMnemopi(config: Config, consent: GlobalMemoryCandidate): Promise<ManagedMemoryReport> {
  return runMemoryHelper(config, consent);
}

async function runMemoryHelper(config: Config, consent?: GlobalMemoryCandidate): Promise<ManagedMemoryReport> {
  const env = { ...process.env };
  for (const name of credentialEnvNames(config)) delete env[name];
  const helper = fileURLToPath(new URL("./managed-memory-helper.ts", import.meta.url));
  const unavailable: ManagedMemoryReport = { memory: { status: "unknown" }, updated: false };
  try {
    const operation = consent ? "apply-consented" : "inspect";
    const child = Bun.spawn([process.execPath, "--no-env-file", "--no-install", helper, operation, ...config.command.slice(1)], {
      cwd: config.headCwd, env, stdin: consent ? new Blob([JSON.stringify(consent)]) : "ignore",
      stdout: "pipe", stderr: "ignore", timeout: 30_000, killSignal: "SIGKILL",
    });
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    if (code !== 0) return unavailable;
    const line = stdout.split("\n").findLast(value => value.startsWith("MANAGED_MEMORY "));
    const parsed: unknown = line && JSON.parse(line.slice("MANAGED_MEMORY ".length));
    return Value.Check(memoryReport, parsed) ? parsed : unavailable;
  } catch {
    return unavailable;
  }
}
