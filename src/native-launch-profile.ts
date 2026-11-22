/** Stock OMP chooses its profile before settings or discovery import native dotenv. */
export async function parseNativeLaunch(launchArgs: readonly string[]) {
  const { extractProfileFlags } = await import("@oh-my-pi/pi-coding-agent/cli/profile-bootstrap");
  const { getAgentDir, setProfile, resolveProfileEnv } = await import("@oh-my-pi/pi-utils/dirs");
  const bootstrap = extractProfileFlags(launchArgs);
  setProfile(bootstrap.profile ?? resolveProfileEnv(process.env.OMP_PROFILE, process.env.PI_PROFILE));
  // Capture the operator's destination before native launch imports load workspace dotenv.
  const launchAgentDir = getAgentDir();
  if (bootstrap.aliasName !== undefined) throw new Error("Managed Hosts cannot install native aliases");
  const { isNativeShell } = await import("@oh-my-pi/pi-coding-agent/cli/native-shell");
  if (isNativeShell(bootstrap.argv[0])) throw new Error("Managed Hosts require native launch argv, not a shell command");
  const { resolveCliArgv } = await import("@oh-my-pi/pi-coding-agent/cli-commands");
  const resolved = resolveCliArgv(bootstrap.argv);
  if ("error" in resolved) throw new Error(resolved.error);
  if (resolved.argv[0] !== "launch") throw new Error("Managed Hosts require native OMP launch argv");
  const { parseArgs } = await import("@oh-my-pi/pi-coding-agent/cli/args");
  return { ...parseArgs(resolved.argv.slice(1)), launchAgentDir };
}
