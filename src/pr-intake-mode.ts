import { normalizeIntakeRepository } from "./cron-pr-intake";

export const prModeEffects = {
  review: "static review and a bounded GitHub PR comment",
  fix: "static review, a bounded GitHub PR comment, and an eligible safe fix commit",
  merge: "static review, a bounded GitHub PR comment, an eligible safe fix commit, and a verified final re-review, CI check, and merge",
} as const;

export type PrIntakeMode = keyof typeof prModeEffects;

type ModeCommand = { readonly target: string | null; readonly mode: PrIntakeMode };

const naturalModes: readonly (readonly [RegExp, PrIntakeMode])[] = [
  [/^(?:무인|자동)으로[ \t]*리뷰[ \t]*만$/u, "review"],
  [/^(?:무인|자동)으로[ \t]*리뷰[ \t]*후[ \t]*수정[ \t]*커밋[ \t]*까지$/u, "fix"],
  [/^(?:무인|자동)으로[ \t]*수정[ \t]*커밋[ \t]*후[ \t]*(?:머지|병합)[ \t]*까지$/u, "merge"],
];
const beforeRepo = /^([A-Za-z0-9-]+\/[A-Za-z0-9_.-]+)(?:[ \t]*(?:저장소(?:는|에서)|는|은|를|을|에서|에[ \t]+대해))?[ \t]+/u;
const afterRepo = /[ \t]+(?:\(([A-Za-z0-9-]+\/[A-Za-z0-9_.-]+)\)|([A-Za-z0-9-]+\/[A-Za-z0-9_.-]+))$/u;
const future = /^앞으로(?:는)?[ \t]+/u;
const ending = /[ \t]+(?:(?:진행|설정|하도록|하게)[ \t]*)?해(?:[ \t]*(?:줘(?:요)?|주세요))?$/u;
const lineBreak = /[\r\n\u2028\u2029]/u;
const jobId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;

export function parsePrModeControl(argument: string): ModeCommand | null {
  if (lineBreak.test(argument)) return null;
  const match = /^pr-mode[ \t]+(?:(\S+)[ \t]+)?(review|fix|merge)$/u.exec(argument.trim());
  const [, selector, mode] = match ?? [];
  if (mode !== "review" && mode !== "fix" && mode !== "merge") return null;
  if (selector === undefined) return { target: null, mode };
  const target = jobId.test(selector) ? selector.toLowerCase() : normalizeIntakeRepository(selector);
  return target ? { target, mode } : null;
}

/** Only a complete direct instruction can become a controller command. */
export function prModeArgument(text: string): string | null {
  if (lineBreak.test(text)) return null;
  const command = text.trim();
  const slash = /^\/cron[ \t]+(.+)$/u.exec(command)?.[1];
  if (slash !== undefined) {
    const parsed = parsePrModeControl(slash);
    return parsed?.target ? `pr-mode ${parsed.target} ${parsed.mode}` : null;
  }

  const sentence = command.replace(/[.!]$/u, "").replace(future, "");
  const prefix = beforeRepo.exec(sentence);
  const remainder = prefix ? sentence.slice(prefix[0].length).replace(future, "") : sentence;
  const suffix = afterRepo.exec(remainder);
  if (prefix && suffix) return null;
  const repository = prefix?.[1] ?? suffix?.[1] ?? suffix?.[2];
  const target = repository === undefined ? null : normalizeIntakeRepository(repository);
  if (repository !== undefined && !target) return null;
  const instruction = suffix ? remainder.slice(0, suffix.index) : remainder;
  const body = instruction.replace(ending, "");
  const level = /^PR[ \t]*자동화(?:[ \t]*모드)?(?:를|는)?[ \t]+([123])[ \t]*단계로[ \t]*(?:바꿔|변경해|설정해)(?:[ \t]*(?:줘(?:요)?|주세요))?$/iu.exec(instruction)?.[1];
  const mode = level === "1" ? "review" : level === "2" ? "fix" : level === "3" ? "merge"
    : naturalModes.find(([pattern]) => pattern.test(body))?.[1];
  return mode ? `pr-mode ${target ? `${target} ` : ""}${mode}` : null;
}
