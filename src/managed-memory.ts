import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { fileURLToPath } from "node:url";
import { credentialEnvNames, type Config } from "./config";

const nativeScope = {
  source: Type.Union([Type.Literal("default"), Type.Literal("global"), Type.Literal("project"),
    Type.Literal("overlay"), Type.Literal("env"), Type.Literal("runtime")]),
  agentDir: Type.String(),
};
const enabledMemory = Type.Object({ ...nativeScope, status: Type.Literal("enabled"), backend: Type.Literal("mnemopi") });
const missingMemory = Type.Object({
  ...nativeScope,
  status: Type.Literal("missing"),
  backend: Type.Union([Type.Literal("off"), Type.Literal("local"), Type.Literal("hindsight"),
    Type.Literal("sharpshooter")]),
});
const memoryStatus = Type.Union([enabledMemory, missingMemory, Type.Object({
  status: Type.Union([Type.Literal("legacy"), Type.Literal("unknown")]),
})]);
const overlayUnset = Type.Object({ backend: Type.Null() });
const memoryReport = Type.Object({ memory: memoryStatus, updated: Type.Boolean() });
export type MnemopiStatus = Static<typeof memoryStatus>;
export type MnemopiReport = Static<typeof memoryReport>;
type GlobalMemoryCandidate = Static<typeof missingMemory> & { source: "default" | "global" };

export async function effectiveMnemopi(settings: Settings): Promise<MnemopiStatus> {
  const { cfgMemoryBackend } = await import("@oh-my-pi/pi-coding-agent/memory-backend/settings");
  // The RPC soft pin uses this setting's own schema default when unconfigured.
  // Do not write a runtime override to the read-only snapshot used for consent.
  const backend = cfgMemoryBackend.get(settings);
  const agentDir = settings.getAgentDir();
  let source = cfgMemoryBackend.provenance(settings);
  if (source === "default") {
    // Stock provenance describes the value, not an explicit overlay tombstone.
    // An overlay unset must not make setup offer an ineffectual global edit.
    const { memory } = settings.mirrorState().configOverlay;
    if (memory === null || Value.Check(overlayUnset, memory)) {
      source = "overlay";
    } else {
      const { hasUnresolvedNativeLegacy } = await import("./native-settings");
      if (await hasUnresolvedNativeLegacy(agentDir)) return { status: "legacy" };
    }
  }
  return backend === "mnemopi" ? { status: "enabled", backend, source, agentDir }
    : { status: "missing", backend, source, agentDir };
}

export function canEnableGlobalMemory(memory: MnemopiStatus): memory is GlobalMemoryCandidate {
  return memory.status === "missing" && (memory.source === "default" || memory.source === "global");
}

export function parseMemoryConsent(bytes: string): MnemopiStatus {
  const value: unknown = JSON.parse(bytes);
  if (!Value.Check(memoryStatus, value) || !canEnableGlobalMemory(value))
    throw new Error("Expected consent to repair the current global memory preference");
  return value;
}

export function memoryBlockReason(memory: MnemopiStatus): string {
  const requirement = "Managed sessions require effective native OMP Mnemopi (memory.backend=mnemopi).";
  switch (memory.status) {
    case "enabled": return "";
    case "unknown": return `${requirement} Native memory settings could not be verified; inspect the selected profile and launch overlays.`;
    case "legacy": return `${requirement} Unmigrated native settings could not be verified; migrate them with ordinary stock OMP in the selected profile first.`;
    case "missing": return `${requirement} Effective backend is ${memory.backend} (${memory.source} settings). ${
      canEnableGlobalMemory(memory) ? "Run interactive setup or configure the selected native profile."
        : "Review the overriding native settings for this workspace; Superagent does not change them."}`;
  }
}

export async function inspectManagedMnemopi(config: Config): Promise<MnemopiStatus> {
  return (await runMemoryHelper(config)).memory;
}

export function applyConsentedMnemopi(config: Config, consent: GlobalMemoryCandidate): Promise<MnemopiReport> {
  return runMemoryHelper(config, consent);
}

async function runMemoryHelper(config: Config, consent?: GlobalMemoryCandidate): Promise<MnemopiReport> {
  const env = { ...process.env };
  for (const name of credentialEnvNames(config)) delete env[name];
  const helper = fileURLToPath(new URL("./managed-memory-helper.ts", import.meta.url));
  const unavailable: MnemopiReport = { memory: { status: "unknown" }, updated: false };
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
