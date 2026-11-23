import { expect, spyOn, test } from "bun:test";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgRetryUsageReservePct } from "@oh-my-pi/pi-coding-agent/session/settings";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { readHeadQuota } from "../src/head-quota";

test.each([
  { reason: "fresh eligible quota", reportAge: 0, failureAge: 1_000, allowed: true, permitted: true, expected: true },
  { reason: "report before the failure", reportAge: 2_000, failureAge: 1_000, allowed: true, permitted: true, expected: false },
  { reason: "last-good report beyond cache horizon", reportAge: 360_000, failureAge: 600_000, allowed: true, permitted: true, expected: false },
  { reason: "provider still denies usage", reportAge: 0, failureAge: 1_000, allowed: false, permitted: true, expected: false },
  { reason: "session excludes the account", reportAge: 0, failureAge: 1_000, allowed: true, permitted: false, expected: false },
  { reason: "newer report only allows credit overage", reportAge: 0, failureAge: 1_000, allowed: true,
    permitted: true, reportedFraction: 1, expected: false },
  { reason: "newer report is inside the reserve", reportAge: 0, failureAge: 1_000, allowed: true,
    permitted: true, reportedFraction: 0.99, reserve: 10, expected: false },
  { reason: "healthy account is outside the discovered model roster", reportAge: 0, failureAge: 1_000,
    allowed: true, permitted: true, modelAccount: "other-codex-account", expected: false },
  { reason: "healthy account is in the discovered model roster", reportAge: 0, failureAge: 1_000,
    allowed: true, permitted: true, modelAccount: "fixture-codex-account", expected: true },
])("native Codex usage recovery: $reason", async ({ reportAge, failureAge, allowed, permitted, reportedFraction, reserve, modelAccount, expected }) => {
  await using root = await mkdtempDisposable(join(tmpdir(), "head-quota-"));
  const provider = "openai-codex";
  const model = { provider, id: "gpt-6.2-astra", baseUrl: "https://quota-fixture.invalid",
    ...(modelAccount === undefined ? {} : { accountAccess: { [modelAccount]: {} } }) };
  const now = Date.now();
  const sessionId = "head-quota-test-session";
  const settings = await Settings.loadIsolated({ cwd: root.path, agentDir: root.path });
  if (reserve !== undefined) cfgRetryUsageReservePct.set(settings, reserve);
  const auth = await AuthStorage.create(":memory:");
  const report = (usedFraction: number): UsageReport => ({
    provider, fetchedAt: now - reportAge,
    metadata: { accountId: "fixture-codex-account", planType: "pro", allowed, limitReached: !allowed },
    limits: [{ id: `${provider}:primary`, label: "5 Hour", status: usedFraction === 1 ? "warning" : "ok",
      scope: { provider, shared: true }, amount: { usedFraction, unit: "percent" } }],
  });
  try {
    await auth.credentials.set(provider, { type: "oauth", access: "fixture-only",
      refresh: "fixture-only", expires: now + 60 * 60_000, accountId: "fixture-codex-account" });
    if (!permitted) auth.sessions.restrict(provider, sessionId, []);
    auth.usage.setProvider(provider, {
      id: provider,
      fetchUsage: async () => report(0.2),
    });
    if (reportedFraction !== undefined) spyOn(auth.usage, "reports").mockResolvedValue([report(reportedFraction)]);
    const modelRegistry = new ModelRegistry(auth, join(root.path, "models.yml"), { ignoreLocalModelConfig: true, settings });
    expect(await readHeadQuota({ model, modelRegistry, sessionId, settings },
      { model: { provider, id: model.id }, failedAt: now - failureAge }, AbortSignal.timeout(2_000))).toBe(expected);
  } finally { auth.close(); }
});
