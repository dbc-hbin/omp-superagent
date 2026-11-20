import { extractProfileFlags } from "@oh-my-pi/pi-coding-agent/cli/profile-bootstrap";
import { Type, type Static } from "@sinclair/typebox/type";
import { Value } from "@sinclair/typebox/value";
import { credentialEnvNames, type Config } from "./config";

// Parse only fields used from the CLI JSON. The stock extension loader does not
// resolve the SDK usage module's internal omptype import.
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
  status: Type.Optional(Type.String()),
});
const responseSchema = Type.Object({
  generatedAt: Type.Optional(Type.Number()),
  reports: Type.Array(Type.Object({ provider: Type.String(), limits: Type.Array(limitSchema) })),
  accountsWithoutUsage: Type.Optional(Type.Array(Type.Object({ provider: Type.String() }))),
  disabledCredentials: Type.Optional(Type.Array(Type.Object({ provider: Type.String() }))),
});
const number = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const resetDay = new Intl.DateTimeFormat("ko-KR", { month: "numeric", day: "numeric", weekday: "short" });
const resetTime = new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

function limitLine(limit: Static<typeof limitSchema>, today: string): string {
  const { amount, label, window } = limit;
  const windowLabel = window?.label;
  const shortWindow = window?.id === "5h" ? "5시간" : window?.id === "7d" ? "주간" : windowLabel;
  let name = label;
  if (windowLabel && shortWindow && windowLabel.toLowerCase() !== "quota window") {
    const labelWithoutProvider = label.replace(/^Claude /, "");
    const index = labelWithoutProvider.toLowerCase().indexOf(windowLabel.toLowerCase());
    name = index >= 0
      ? `${labelWithoutProvider.slice(0, index)}${shortWindow}${labelWithoutProvider.slice(index + windowLabel.length)}`
      : `${shortWindow} (${labelWithoutProvider})`;
  }
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
  if (remaining !== undefined && amount.unit !== "percent" && amount.unit !== "unknown") {
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

/** Use the configured stock OMP's profile and publish only the quota projection. */
export async function readOmpUsage(config: Config, environment: NodeJS.ProcessEnv = process.env): Promise<string> {
  const [executable, ...launchArgs] = config.command;
  if (!executable) throw new Error("No configured OMP executable");
  const { profile } = extractProfileFlags(launchArgs);
  const env = { ...environment };
  for (const name of credentialEnvNames(config)) delete env[name];
  const child = Bun.spawn([executable, ...(profile ? [`--profile=${profile}`] : []),
    "usage", "--json", "--redact", "--no-extensions"], {
    cwd: config.headCwd, env, stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 30_000, killSignal: "SIGKILL",
  });
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (code !== 0) throw new Error(`OMP usage exited with code ${code}`);
  const response: unknown = JSON.parse(stdout);
  if (!Value.Check(responseSchema, response)) throw new Error("Unsupported OMP usage response");

  const today = new Date(response.generatedAt ?? Date.now()).toDateString();
  const accounts = new Map<string, string[][]>();
  const addAccount = (provider: string, lines: string[]) => {
    const entries = accounts.get(provider) ?? [];
    entries.push(lines);
    accounts.set(provider, entries);
  };
  for (const report of response.reports) {
    addAccount(report.provider, report.limits.length
      ? report.limits.map(limit => limitLine(limit, today)) : ["• 남은 한도 미확인"]);
  }
  for (const { provider } of response.accountsWithoutUsage ?? []) {
    addAccount(provider, ["• 남은 한도 미확인"]);
  }
  for (const { provider } of response.disabledCredentials ?? []) {
    addAccount(provider, ["• 계정 비활성화됨"]);
  }
  if (!accounts.size) return "OMP 사용량\n\n설정된 OMP 프로필에서 보고된 계정 한도가 없습니다.";
  const sections = [...accounts].flatMap(([provider, entries]) => {
    const name = provider === "openai-codex" ? "Codex" : provider === "anthropic" ? "Claude" : provider;
    return entries.map((limits, index) =>
      [`${name}${entries.length > 1 ? ` · 계정 ${index + 1}` : ""}`, ...limits].join("\n"));
  });
  return `OMP 사용량 · ${resetTime.resolvedOptions().timeZone}\n\n${sections.join("\n\n")}`;
}
