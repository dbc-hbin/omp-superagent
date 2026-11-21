// Configuration only. Never import the SDK entry point, account storage, or a backend.
import { effectiveMnemopi, parseMemoryConsent, type MnemopiReport } from "./managed-memory";
import { parseNativeLaunch } from "./native-launch-profile";

const unavailable: MnemopiReport = { memory: { status: "unknown" }, updated: false };
async function check(): Promise<MnemopiReport> {
  const cwd = process.cwd();
  const [operation, ...args] = process.argv.slice(2);
  if (operation !== "inspect" && operation !== "apply-consented") return unavailable;
  const parsed = await parseNativeLaunch([...args, "--mode", "rpc-ui", "--cwd", cwd]);
  if (parsed.mode !== "rpc-ui" || parsed.cwd !== cwd) return unavailable;
  const { Settings } = await import("@oh-my-pi/pi-coding-agent/config/settings");
  const settings = await Settings.loadReadOnly({ cwd, configFiles: parsed.config });
  if (operation === "inspect") return { memory: await effectiveMnemopi(settings), updated: false };
  const expected = parseMemoryConsent(await Bun.stdin.text());
  const { saveMnemopiPreference } = await import("./setup-memory");
  return saveMnemopiPreference(settings, expected);
}

// Native parse/read diagnostics may include private settings. Emit only known fields.
const report = await check().catch(() => unavailable);
process.stdout.write(`MANAGED_MEMORY ${JSON.stringify(report)}\n`);
