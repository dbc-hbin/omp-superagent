import type { Inbound } from "../contracts";
import { matchesWrittenCommand, messengerCommandText } from "../messaging/messenger-commands";
import { record } from "./native-frames";

// Native command and branch journal contract from omp-superkit 12d19ec.
const selector = /^\s*(\/?superstack)(?=\s|$)/i;
export const headSuperstackTaskPrefix = "superstack\n\n";

type HeadSuperstackReceipt =
  | { readonly kind: "enable" | "off" | "held" }
  | { readonly kind: "task"; readonly start: number; readonly view: "written" | "telegram" };

// This runs only on original intake. For a task, pin an offset into one of
// the immutable source views rather than storing another copy of its text.
export function admitHeadSuperstack(input: Inbound, task: string): HeadSuperstackReceipt | undefined {
  const match = selector.exec(task);
  if (!match || !matchesWrittenCommand(input)) return;
  const written = messengerCommandText(input);
  if (!written.endsWith(task)) return;
  const wrapperLength = written.length - task.length;
  const start = wrapperLength + match[0].length;
  const args = written.slice(start).trim();
  const view = input.route.platform === "telegram" ? input.routingText : written;
  const projected = view !== written;
  if (projected) {
    // An exposed second token on the same line cannot corroborate a masked
    // first token. Telegram only attests the first written slash command.
    const sameLine = /^[^\r\n]*/u.exec(written.slice(start))?.[0];
    const attestedSlash = wrapperLength === 0 && match[1]?.startsWith("/") && input.telegramProtectedCommand === false;
    if (view === undefined || !view.startsWith(written.slice(0, start)) || !/^(?:\s|$)/u.test(view.slice(start))
      || (!attestedSlash && match[1] && sameLine?.includes(match[1]))) return { kind: "held" };
  }
  if (args === "" || args === "off")
    return view?.slice(start).trim() === args ? { kind: args ? "off" : "enable" } : { kind: "held" };
  if (!view?.slice(start).trim()) return { kind: "held" };
  return { kind: "task", start, view: projected ? "telegram" : "written" };
}

export function recordedHeadSuperstack(value: string | null): HeadSuperstackReceipt | null {
  if (value === null) return null;
  const { kind, start, view } = record(JSON.parse(value));
  if (kind === "task" && typeof start === "number" && Number.isSafeInteger(start) && start > 0
    && (view === "written" || view === "telegram")) return { kind, start, view };
  if (kind === "enable" || kind === "off") return { kind };
  return { kind: "held" };
}

export function headSuperstackTaskText(input: Inbound, task: Extract<HeadSuperstackReceipt, { kind: "task" }>): string | undefined {
  return (task.view === "telegram" ? input.routingText : messengerCommandText(input))?.slice(task.start).trim();
}

export function advertisesSuperstack(value: unknown): boolean {
  const { commands } = record(value);
  return Array.isArray(commands) && commands.map(record).some(command =>
    command.name === "superstack" && command.source === "extension"
    && command.description === "Enable branch-local skill routing for an optional task, or use off to disable it");
}

export function superstackBranchEnabled(value: unknown): boolean | undefined {
  const { entries, leafId } = record(value);
  if (!Array.isArray(entries) || (leafId !== null && typeof leafId !== "string")) return undefined;
  const byId = new Map(entries.map(record).map(entry => [entry.id, entry]));
  const visited = new Set<string>();
  let id = leafId;
  while (typeof id === "string" && !visited.has(id)) {
    visited.add(id);
    const entry = byId.get(id);
    if (!entry) return undefined;
    if (entry.type === "custom" && entry.customType === "omp-superstack:state")
      return typeof entry.data === "boolean" ? entry.data : undefined;
    if (entry.parentId !== null && typeof entry.parentId !== "string") return undefined;
    id = entry.parentId;
  }
  return id === null ? false : undefined;
}

export function superstackControlOutcome(id: string, wanted: boolean, enabled: boolean | undefined) {
  if (enabled === undefined) return { state: "uncertain",
    text: `Superstack 설정을 확인하지 못했습니다. 명령을 다시 보내지 않았고 다음 HEAD 요청을 보류했습니다. 원래 세션을 확인하거나 /resolve ${id} 로 보류를 종료하세요.` } as const;
  if (enabled !== wanted) return { state: "cancelled",
    text: "HEAD 브랜치에 요청한 Superstack 설정이 적용되지 않았습니다. 모델 작업은 시작하지 않았습니다." } as const;
  return { state: "done", text: `현재 HEAD 세션 브랜치의 Superstack 설정을 ${enabled ? "켰습니다" : "껐습니다"}. 모델 작업은 시작하지 않았습니다.` } as const;
}
