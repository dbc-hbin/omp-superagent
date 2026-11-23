import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import { cfgRetryUsageReservePct } from "@oh-my-pi/pi-coding-agent/session/settings";
import { quotaTierFor } from "@oh-my-pi/pi-catalog/compat/behavior";
import type { HeadQuotaFailure } from "./head-recovery";

/** Match stock OMP's usage-report cache horizon, not a presumed provider reset time. */
export const HEAD_QUOTA_CHECK_MS = 5 * 60_000;

type QuotaSession = Pick<AgentSession, "modelRegistry" | "sessionId" | "settings"> & {
  readonly model: Pick<NonNullable<AgentSession["model"]>, "provider" | "id" | "baseUrl"> | undefined;
};

export async function readHeadQuota(
  session: QuotaSession,
  failure: HeadQuotaFailure,
  signal: AbortSignal,
): Promise<boolean> {
  const { model, sessionId } = session;
  if (!model || model.provider !== failure.model.provider || model.id !== failure.model.id) return false;
  const { authStorage } = session.modelRegistry;
  const { health, usage, sessions } = authStorage;
  if (typeof health?.model !== "function" || typeof usage?.reports !== "function"
    || typeof sessions?.permits !== "function") return false;
  const { provider, id, baseUrl } = model;
  // Native health supplies model scope, entitlement, reserves and credential
  // blocks, but can use a stale last-good report after a failed usage read.
  const availability = await health.model(provider, { modelId: id, baseUrl, sessionId, signal,
    reserveFraction: cfgRetryUsageReservePct.get(session.settings) / 100 });
  const eligible = availability.accounts.filter(account => account.credentialType === "oauth"
    && account.state === "healthy" && account.remainingFraction !== undefined && account.remainingFraction > 0
    && sessions.permits(provider, sessionId, account.credentialId));
  if (!eligible.length) return false;
  const reports = await usage.reports({ provider, baseUrlResolver: () => baseUrl, signal });
  if (signal.aborted || session.sessionId !== sessionId || session.model !== model) return false;
  const now = Date.now();
  const spark = quotaTierFor(provider, id) === "spark";
  const windowPrefix = spark ? `${provider}:spark:` : `${provider}:`;
  return reports?.some(report => {
    const { fetchedAt, metadata } = report;
    if (report.provider !== provider || !Number.isFinite(fetchedAt) || fetchedAt <= failure.failedAt
      || fetchedAt > now || now - fetchedAt > HEAD_QUOTA_CHECK_MS || !metadata
      || metadata.source === "ratelimit-headers" || metadata.headersUpdatedAt !== undefined) return false;
    const meters = metadata.meterStates;
    const meter: unknown = spark
      ? meters && typeof meters === "object" && "spark" in meters ? meters.spark : null
      : metadata;
    if (!meter || typeof meter !== "object" || !("allowed" in meter) || meter.allowed !== true
      || !("limitReached" in meter) || meter.limitReached !== false) return false;
    // The verdict can include credit-funded overage. Check actual headroom in
    // this report, not just the potentially older snapshot used by model health.
    const windows = report.limits.filter(limit =>
      limit.id === `${windowPrefix}primary` || limit.id === `${windowPrefix}secondary`);
    const limits = windows.length || spark ? windows : report.limits.filter(limit => limit.id === `${provider}:spend-cap`);
    if (!limits.length || !limits.every(limit => {
      const used = limit.amount.usedFraction;
      return limit.status !== "exhausted" && typeof used === "number" && used >= 0 && used < 1;
    })) return false;
    // Local reports carry the credential row. A broker may carry only the
    // Codex account ID; accept it only if it maps to exactly one native row.
    const accountId = metadata.accountId;
    const matching = metadata.credentialId === undefined && typeof accountId === "string" && accountId
      ? authStorage.oauth.accounts(provider, sessionId).filter(account => account.accountId === accountId) : [];
    const credentialId = metadata.credentialId ?? (matching.length === 1 ? matching[0]?.credentialId : undefined);
    return eligible.some(account => account.credentialId === credentialId
      && sessions.permits(provider, sessionId, account.credentialId));
  }) ?? false;
}
