import { createHmac } from "node:crypto";
import { delimiter } from "node:path";
import { extractProfileFlags } from "@oh-my-pi/pi-coding-agent/cli/profile-bootstrap";
import { Type, type Static } from "@sinclair/typebox/type";
import { Value } from "@sinclair/typebox/value";
import { credentialEnvNames, type Config } from "./config";

// Parse only fields used from the CLI JSON. The stock extension loader does not
// resolve the SDK usage module's internal omptype import.
const scopeIdentityFields = {
  accountId: Type.Optional(Type.Unknown()),
  projectId: Type.Optional(Type.Unknown()),
  orgId: Type.Optional(Type.Unknown()),
};
const identityFields = {
  ...scopeIdentityFields,
  email: Type.Optional(Type.Unknown()),
  orgName: Type.Optional(Type.Unknown()),
};
const identitySchema = Type.Object(identityFields);
const accountSchema = Type.Object({ provider: Type.String(), ...identityFields });
const limitSchema = Type.Object({
  label: Type.String(),
  amount: Type.Object({
    unit: Type.String(),
    used: Type.Optional(Type.Number()),
    limit: Type.Optional(Type.Number()),
    remaining: Type.Optional(Type.Number()),
    usedFraction: Type.Optional(Type.Number()),
    remainingFraction: Type.Optional(Type.Number()),
  }),
  window: Type.Optional(Type.Object({
    id: Type.String(),
    label: Type.String(),
    resetsAt: Type.Optional(Type.Number()),
    resetLabel: Type.Optional(Type.String()),
  })),
  scope: Type.Optional(Type.Object(scopeIdentityFields)),
  status: Type.Optional(Type.String()),
});
const responseSchema = Type.Object({
  generatedAt: Type.Optional(Type.Number()),
  reports: Type.Array(Type.Object({
    provider: Type.String(),
    limits: Type.Array(limitSchema),
    metadata: Type.Optional(identitySchema),
  })),
  accountsWithoutUsage: Type.Optional(Type.Array(accountSchema)),
  disabledCredentials: Type.Optional(Type.Array(accountSchema)),
});
const number = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const resetDay = new Intl.DateTimeFormat("ko-KR", { month: "numeric", day: "numeric", weekday: "short" });
const resetTime = new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const quotaUnits = new Set(["tokens", "requests", "credits", "usd", "minutes", "bytes"]);
const quotaWindows = new Map([["5h", "5시간"], ["24h", "일간"], ["1d", "일간"], ["daily", "일간"],
  ["7d", "주간"], ["weekly", "주간"], ["30d", "월간"], ["monthly", "월간"]]);
const publicMeters = new Map([
  ["All models", "All models"], ["Credits", "Credits"], ["Claude Extra Usage", "Extra Usage"],
  ["Claude 7 Day (Opus)", "Opus"], ["Claude 7 Day (Sonnet)", "Sonnet"], ["Claude 7 Day (Fable)", "Fable"],
]);

function limitLine(limit: Static<typeof limitSchema>, today: string, index: number): string {
  const { amount, label, window } = limit;
  // Native redaction does not cover provider-controlled display labels. Render
  // only known meter categories or a numbered bucket, never provider free text.
  const period = window && quotaWindows.get(window.id);
  const meter = publicMeters.get(label);
  const name = period && meter ? `${period} (${meter})` : period ?? meter ?? `사용량 항목 ${index + 1}`;
  const remaining = amount.remaining ?? (amount.limit !== undefined && amount.used !== undefined
    ? Math.max(0, amount.limit - amount.used) : undefined);
  let fraction = amount.remainingFraction;
  if (fraction === undefined) {
    if (amount.usedFraction !== undefined) fraction = 1 - amount.usedFraction;
    else if (amount.limit !== undefined && amount.limit > 0 && remaining !== undefined) fraction = remaining / amount.limit;
    else if (amount.unit === "percent") {
      if (remaining !== undefined) fraction = remaining / 100;
      else if (amount.used !== undefined) fraction = 1 - amount.used / 100;
    }
  }
  const parts: string[] = [];
  if (fraction !== undefined && Number.isFinite(fraction)) parts.push(`${number.format(Math.max(0, fraction) * 100)}% 남음`);
  if (remaining !== undefined && quotaUnits.has(amount.unit)) {
    parts.push(`${number.format(remaining)} ${amount.unit} 남음`);
  }
  if (limit.status === "exhausted") parts.push("한도 도달");
  if (!parts.length) parts.push("남은 한도 미확인");
  const reset = window?.resetsAt === undefined ? undefined : new Date(window.resetsAt);
  if (reset && Number.isFinite(reset.getTime())) {
    const day = reset.toDateString() === today ? "오늘" : resetDay.format(reset);
    const action = window?.resetLabel === "expires" ? "만료"
      : window?.resetLabel === "tick" || window?.resetLabel === "regen" ? "충전" : "초기화";
    parts.push(`${day} ${resetTime.format(reset)} ${action}`);
  }
  return `• ${name}  ${parts.join(" · ")}`;
}

async function runUsageCli(
  config: Config,
  invocation: { readonly args: readonly string[]; readonly timeout?: number; readonly captureReceipt?: boolean },
  environment: NodeJS.ProcessEnv,
) {
  const [executable, ...launchArgs] = config.command;
  if (!executable) throw new Error("No configured OMP executable");
  const { profile, argv } = extractProfileFlags(launchArgs);
  const extensionFlags: string[] = [];
  const env = { ...environment };
  if (invocation.args[0] !== "--help") {
    const { parseArgs } = await import("@oh-my-pi/pi-coding-agent/cli/args");
    const { noExtensions, extensions, hooks, config: overlays, trustedExtensions } = parseArgs(argv);
    if (trustedExtensions?.length) throw new Error("OMP usage does not expose trusted-extension mode");
    // Stock usage loads overlays through PI_CONFIG_FILES. Native Settings
    // applies inherited paths first, then --config paths in argument order.
    if (overlays?.length) {
      if (overlays.some(path => path.includes(delimiter))) throw new Error("OMP usage cannot encode a configured overlay path");
      env.PI_CONFIG_FILES = [env.PI_CONFIG_FILES, ...overlays].filter(Boolean).join(delimiter);
    }
    if (noExtensions) extensionFlags.push("--no-extensions");
    for (const path of [...(extensions ?? []), ...(hooks ?? [])]) extensionFlags.push(`--extension=${path}`);
  }
  for (const name of credentialEnvNames(config)) delete env[name];
  delete env.OMP_SUPERAGENT_GATEWAY_TOKEN;
  const child = Bun.spawn([executable, ...(profile ? [`--profile=${profile}`] : []), "usage", ...invocation.args, ...extensionFlags], {
    cwd: config.headCwd, env, stdin: "ignore", stdout: "pipe", stderr: invocation.captureReceipt ? "pipe" : "ignore",
    timeout: invocation.timeout ?? 30_000, killSignal: "SIGKILL",
  });
  const [stdout, code, stderr] = await Promise.all([new Response(child.stdout).text(), child.exited,
    child.stderr ? new Response(child.stderr).text() : ""]);
  return { stdout, code, stderr };
}

function usageAccountLabel(
  identity: Static<typeof identitySchema> | undefined,
  limits: readonly Static<typeof limitSchema>[] = [],
): string {
  // Accept only short OMP redaction masks, not raw emails, markup or provider diagnostics.
  const mask = (value: unknown) => typeof value === "string"
    && /^[\p{L}\p{M}\p{N} ._+-]{1,12}\*(?:[\p{L}\p{M}\p{N} ._+-]{1,12}\*)?$/u.test(value)
    ? value.replaceAll("*", "…") : undefined;
  const scopeMask = (key: keyof typeof scopeIdentityFields) => {
    const scoped = new Set(limits.map(limit => limit.scope?.[key]).filter(value => value != null));
    return scoped.size === 1 ? mask(scoped.values().next().value) : undefined;
  };
  const name = mask(identity?.email) ?? mask(identity?.accountId) ?? mask(identity?.projectId)
    ?? scopeMask("accountId") ?? scopeMask("projectId");
  const organization = mask(identity?.orgName) ?? mask(identity?.orgId) ?? scopeMask("orgId");
  return [name, organization === name ? undefined : organization].filter(Boolean).join(" / ");
}

/** Use the configured stock OMP's profile and publish only the quota projection. */
export async function readOmpUsage(config: Config, environment: NodeJS.ProcessEnv = process.env): Promise<string> {
  const { stdout, code } = await runUsageCli(config, { args: ["--json", "--redact"] }, environment);
  if (code !== 0) throw new Error(`OMP usage exited with code ${code}`);
  const response = usageJson(stdout);
  if (!Value.Check(responseSchema, response)) throw new Error("Unsupported OMP usage response");

  const today = new Date(response.generatedAt ?? Date.now()).toDateString();
  const accounts = new Map<string, { readonly label: string; readonly lines: readonly string[] }[]>();
  const addAccount = (provider: string, label: string, lines: string[]) => {
    const entries = accounts.get(provider) ?? [];
    entries.push({ label, lines });
    accounts.set(provider, entries);
  };
  for (const report of response.reports) {
    addAccount(report.provider, usageAccountLabel(report.metadata, report.limits), report.limits.length
      ? report.limits.map((limit, index) => limitLine(limit, today, index)) : ["• 남은 한도 미확인"]);
  }
  for (const account of response.accountsWithoutUsage ?? []) {
    addAccount(account.provider, usageAccountLabel(account), ["• 남은 한도 미확인"]);
  }
  for (const account of response.disabledCredentials ?? []) {
    addAccount(account.provider, usageAccountLabel(account), ["• 계정 비활성화됨"]);
  }
  if (!accounts.size) return "OMP 사용량\n\n설정된 OMP 프로필에서 보고된 계정 한도가 없습니다.";
  const sections = [...accounts].flatMap(([provider, entries], providerIndex) => {
    const name = provider === "openai-codex" ? "Codex" : provider === "anthropic" ? "Claude"
      : /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(provider) ? provider : `OMP 제공자 ${providerIndex + 1}`;
    return entries.map(({ label, lines }, index) =>
      [[name, entries.length > 1 ? `계정 ${index + 1}` : "", label].filter(Boolean).join(" · "), ...lines].join("\n"));
  });
  return `OMP 사용량 · ${resetTime.resolvedOptions().timeZone}\n\n${sections.join("\n\n")}`;
}

function usageJson(stdout: string): unknown {
  try { return JSON.parse(stdout); }
  catch { throw new Error("Invalid JSON from OMP usage"); }
}

function resetNameHint(value: string | undefined): string | undefined {
  // Show at most two letters or numbers, and never the whole name or email.
  const characters = Array.from(value?.trim() ?? "");
  const prefix = characters.slice(0, Math.min(2, characters.length - 1)).join("");
  return /^[\p{L}\p{N}]{1,2}$/u.test(prefix) ? `${prefix}…` : undefined;
}

const count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const resetAccountsSchema = Type.Object({
  accounts: Type.Array(Type.Object({
    provider: Type.Union([Type.Literal("openai-codex"), Type.Literal("anthropic")]),
    credentialId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    availableCount: count,
    redeemableCount: count,
    nextCreditId: Type.Optional(Type.String()),
    accountId: Type.Optional(Type.String()),
    email: Type.Optional(Type.String()),
    orgId: Type.Optional(Type.String()),
    orgName: Type.Optional(Type.String()),
    error: Type.Optional(Type.String()),
    credits: Type.Array(Type.Object({
      id: Type.Optional(Type.String()),
      status: Type.Optional(Type.String()),
      expiresAt: Type.Optional(Type.String()),
    })),
  })),
});

type ResetIdentity = Readonly<{ account?: string; email?: string; organization?: string }>;

export interface OmpResetAccount {
  /** The public CLI's exact provider and local credential row selector, not a provider identity. */
  readonly target: string;
  readonly label: string;
  readonly availableCount: number;
  readonly redeemableCount: number;
  readonly unavailable: boolean;
  /** Stable across credential row replacement; never contains a printable account ID. */
  readonly identity: ResetIdentity | null;
  readonly offer: string;
}

export class OmpResetUnsupported extends Error {}

export function couldMatchResetAccount(
  previous: Pick<OmpResetAccount, "target" | "identity">,
  current: Pick<OmpResetAccount, "target" | "identity">,
): boolean {
  if (previous.target === current.target) return true;
  const provider = previous.target.split("/", 1)[0];
  if (current.target.split("/", 1)[0] !== provider) return false;
  const a = previous.identity;
  const b = current.identity;
  if (!a || !b) return true;
  if (a.organization && b.organization && a.organization !== b.organization) return false;
  if (a.email && b.email && a.email === b.email) return true;
  // Codex can share an upstream account lock across logins in a workspace.
  if (a.account && b.account) return a.account === b.account;
  if (a.email && b.email) return false;
  // No overlapping fields that separate these accounts. Hold rather than
  // spending again on a possible re-login with more or less identity metadata.
  return true;
}

/** Inspect the public installed CLI, not the SDK pin; a quota report is not a reset balance. */
export async function listOmpUsageResets(
  config: Config, identityKey: string, environment: NodeJS.ProcessEnv = process.env,
): Promise<readonly OmpResetAccount[]> {
  const help = await runUsageCli(config, { args: ["--help"] }, environment);
  if (help.code !== 0) throw new Error("OMP usage help unavailable");
  if (!/\busage\s+\[ACTION\]\s+\[TARGET\]/.test(help.stdout) ||
    !/\busage reset\s+(?:codex|openai-codex|anthropic|claude)\/\d+\b/.test(help.stdout))
    throw new OmpResetUnsupported("Installed OMP does not advertise exact-account usage reset");
  // Native redaction aliases depend on which other accounts are present. Derive
  // the stable fence from native identities in memory before returning any rows.
  const { stdout, code } = await runUsageCli(config, { args: ["reset", "--json"] }, environment);
  if (code !== 0) throw new Error("OMP saved resets unavailable");
  const result = usageJson(stdout);
  if (!Value.Check(resetAccountsSchema, result)) throw new Error("Unsupported OMP saved reset response");
  const seen = new Set<string>();
  const fingerprint = (values: readonly unknown[]) => createHmac("sha256", identityKey)
    .update(JSON.stringify(values)).digest("hex");
  return result.accounts.map(row => {
    const target = `${row.provider}/${row.credentialId}`;
    if (seen.has(target) || row.redeemableCount > row.availableCount) throw new Error("Inconsistent OMP saved reset response");
    seen.add(target);
    const hashAlias = (kind: string, value?: string) => {
      const normalized = value?.trim().toLowerCase();
      return normalized ? fingerprint([row.provider, kind, normalized]) : undefined;
    };
    const identity = (row.accountId ?? row.email)?.trim() ? {
      account: hashAlias("account", row.accountId),
      email: hashAlias("email", row.email),
      organization: hashAlias("organization", row.orgId),
    } : null;
    const name = resetNameHint(row.email?.split("@", 1)[0]) ?? resetNameHint(row.orgName);
    return {
      target,
      label: [row.provider === "openai-codex" ? "Codex" : "Claude", `계정 #${row.credentialId}`, name].filter(Boolean).join(" · "),
      availableCount: row.availableCount,
      redeemableCount: row.redeemableCount,
      // Native refuses to spend without an account identity for its cross-process fence.
      unavailable: row.error !== undefined || row.redeemableCount > 0 && identity === null,
      identity,
      // Match an unchanged offer before handoff without retaining provider identities or credit IDs.
      offer: fingerprint([
        identity, row.nextCreditId, row.availableCount, row.redeemableCount,
        row.credits.map(credit => JSON.stringify([credit.id, credit.status, credit.expiresAt])).sort(),
      ]),
    };
  });
}

/** Only the caller's already durably claimed confirmation can invoke this one-shot CLI. */
export async function redeemOmpUsageReset(
  config: Config, account: OmpResetAccount, environment: NodeJS.ProcessEnv = process.env,
): Promise<"reset" | "refused" | "unconfirmed"> {
  if (!/^(?:openai-codex|anthropic)\/[1-9]\d*$/.test(account.target))
    throw new Error("Invalid exact OMP saved reset target");
  // Native lists, takes the provider/account fence, then attempts one spend.
  // Its mutating form has a human receipt, not a JSON response body.
  const { stdout, stderr, code } = await runUsageCli(config, {
    args: ["reset", account.target, "--redact"], timeout: 60_000, captureReceipt: true,
  }, environment);
  const provider = account.target.startsWith("anthropic/") ? "Claude" : "Codex";
  if (code === 0 && /^Reset applied for .+ \((Claude|Codex)\) — .+\.$/.exec(stdout.trim())?.[1] === provider)
    return "reset";
  if (code === 1 && !stdout) {
    const line = stderr.replace(/\x1b\[[\d;]*m/g, "").trim();
    // Split at the first native boundary before examining the reason.
    // Unconfirmed receipts may carry arbitrary provider text after it.
    const boundary = /^.{1,400}? (?:\((Claude|Codex)\)|\[(Claude|Codex)\]): /.exec(line);
    if (boundary) {
      const reason = line.slice(boundary[0].length);
      if (boundary[1] === provider && (
        reason === "nothing to reset right now — your covered limits aren't constrained, so no credit was spent."
        || reason === "the reset offer changed — nothing was spent; reopen /usage reset."
        || reason === "that reset was already redeemed."
        || reason === "couldn't load this account's saved resets (network/auth) — nothing was spent, try again."
        || /^another omp process (?:spent a saved reset on this account .+ ago, so this one was not spent\. Check `omp usage` before spending another|started spending a saved reset on this account .+ ago, so nothing was spent\. Try again in a minute)\.$/.test(reason)
      )) return "refused";
      if (boundary[2] === provider && /^(?:saved resets unavailable \(.+\), so nothing was spent|no saved resets usable right now(?: \(.+\))?)\.$/.test(reason))
        return "refused";
    }
  }
  return "unconfirmed";
}
