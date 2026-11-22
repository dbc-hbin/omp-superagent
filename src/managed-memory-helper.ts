// Configuration only. Never import the SDK entry point, account storage, or a backend.
import { canEnableGlobalMemory, effectiveManagedMemory, ensureManagedMemory, parseMemoryConsent, type ManagedMemoryReport } from "./managed-memory";
import { parseNativeLaunch } from "./native-launch-profile";

const unavailable: ManagedMemoryReport = { memory: { status: "unknown" }, updated: false };
const [operation, ...args] = process.argv.slice(2);
async function check(): Promise<ManagedMemoryReport> {
  const cwd = process.cwd();
  if (operation !== "inspect" && operation !== "preflight" && operation !== "ensure" && operation !== "apply-consented") return unavailable;
  const parsed = await parseNativeLaunch([...args, "--mode", "rpc-ui", "--cwd", cwd]);
  if (parsed.mode !== "rpc-ui" || parsed.cwd !== cwd) return unavailable;
  const { Settings } = await import("@oh-my-pi/pi-coding-agent/config/settings");
  const settings = await Settings.loadReadOnly({ cwd, configFiles: parsed.config });
  if (operation === "inspect" || operation === "preflight") {
    return { memory: await effectiveManagedMemory(settings, parsed.launchAgentDir), updated: false };
  }
  return ensureManagedMemory(settings, parsed.launchAgentDir,
    operation === "apply-consented" ? parseMemoryConsent(await Bun.stdin.text()) : undefined);
}

// Native parse/read diagnostics may include private settings. Emit only known fields.
const report = await check().catch(() => unavailable);
const output = operation === "preflight" || operation === "ensure"
  ? report.memory.status === "enabled" || (operation === "preflight" && canEnableGlobalMemory(report.memory))
  : report;
process.stdout.write(`MANAGED_MEMORY ${JSON.stringify(output)}\n`);
