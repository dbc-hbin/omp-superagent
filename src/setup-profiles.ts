import type { Config } from "./config";
import { validateCredential } from "./credentials";
import { OperatorStartError, runOperator, type OperatorRun } from "./operator";

interface ProfileOptions {
  readonly signal?: AbortSignal;
  readonly run?: OperatorRun;
}

interface ProfileResult {
  readonly platform: "discord" | "telegram";
  readonly status: "applied" | "failed";
  readonly message: string;
}

/** One-shot native API workflows only; never starts a messenger or OMP session. */
export async function setupBotProfiles(
  config: Config, credentials: Readonly<Record<string, string>>, options: ProfileOptions = {},
): Promise<ProfileResult[]> {
  const results: ProfileResult[] = [];
  if (config.discord) options.signal?.throwIfAborted();
  for (const [platform, service] of [["discord", config.discord], ["telegram", config.telegram]] as const) {
    if (options.signal?.aborted) break;
    if (!service) continue;
    const name = platform === "discord" ? "Discord" : "Telegram";
    const inspection = `Profile inspection failed; no ${name} profile update was attempted. Credential/API details suppressed.`;
    const unresolved = `Profile update is unresolved; it may have reached ${name}. No automatic retry was attempted; API details suppressed.`;
    const bot = credentials[service.tokenEnv] ?? "";
    try {
      validateCredential(bot);
    } catch {
      results.push({ platform, status: "failed", message: inspection });
      continue;
    }
    try {
      const run = options.run ?? runOperator;
      results.push(await run<ProfileResult>(`${platform}-avatar`, { ownerId: service.ownerId }, { bot }, options.signal));
    } catch (error) {
      // Cancellation after dispatch can interrupt a write; no retry or next platform.
      const beforeWrite = error instanceof OperatorStartError ||
        (error instanceof Error && error.message === inspection);
      const message = beforeWrite ? inspection : unresolved;
      results.push({ platform, status: "failed", message });
    }
  }
  return results;
}
