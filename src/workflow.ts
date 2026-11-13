import { WORKFLOW_NAMES, type WorkflowActivation, type WorkflowChoice, type WorkflowName } from "./contracts";

// Boundary contract inspected against omp-ulw/ulw.ts (2026-11-14). This bridge
// recognizes only its six ULW workflows, not arbitrary mentions or skill prose.
const aliases: Array<[WorkflowName, RegExp]> = [
  ["ulw-research", /^(?:ulw|mass[\s-]*ulw|ulw[\s-]*mass|mulw|meth)[\s-]*research\b/i],
  ["mass-ulw", /^(?:mass[\s-]*ulw|ulw[\s-]*mass|mulw|meth)\b/i],
  ["ulw-plan", /^ulw[\s-]*plan\b/i],
  ["ulw-loop", /^ulw[\s-]*loop\b/i],
  ["ulw-execute", /^ulw[\s-]*execute\b/i],
];
const identifierTail = /^(?:[-_][A-Za-z0-9]|\.[A-Za-z0-9]|[-_.]?[A-Za-z0-9]*[/\\])/;
const nativeWords = /(?<![\p{L}\p{N}_./\\-])(?<!::)(?:ultrathink|orchestrate|workflowz|jevify)(?![\p{L}\p{N}_/\\-])(?!\.[\p{L}\p{N}_-])(?!\()/u;
const nativeWord: Partial<Record<WorkflowName, string>> = {
  "ulw-plan": "ultrathink", "ulw-loop": "orchestrate", "ulw-execute": "orchestrate",
  "mass-ulw": "workflowz", "ulw-research": "workflowz",
};

/** Only the original authorized user's leading invocation is eligible. */
function invocation(text: string): { name: WorkflowName; length: number } | null {
  const prefix = /^\s*\/?/.exec(text)![0].length;
  const leading = text.slice(prefix);
  for (const [name, expression] of aliases) {
    const match = expression.exec(leading);
    if (match && /^(?:[\s:.,!?]|$)/.test(leading.slice(match[0].length))
      && !identifierTail.test(leading.slice(match[0].length))) return { name, length: prefix + match[0].length };
  }
  const plain = /^(?:ultrawork|ulw)\b/i.exec(leading);
  if (!plain) return null;
  const tail = leading.slice(plain[0].length);
  if (/^[-_.]?[A-Za-z0-9]*[/\\]/.test(tail)) return null;
  // Native ULW permits a suffix only for its named workflow family; unsupported
  // identifiers and paths are data. Do not search past quotes or negations.
  if (identifierTail.test(tail) && !/^[-_](?:loop|plan|research|execute|mass)(?![-_.]?[A-Za-z0-9])/i.test(tail)) return null;
  return { name: "ulw", length: prefix + plain[0].length };
}

export function leadingWorkflow(text: string): WorkflowName | null {
  return invocation(text)?.name ?? null;
}

export function workflowChoice(value: WorkflowChoice | undefined): WorkflowChoice | null {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || !WORKFLOW_NAMES.includes(value.name)
    || typeof value.reason !== "string" || !value.reason.trim()
    || Object.keys(value).some(key => key !== "name" && key !== "reason")) {
    throw new Error("workflow requires a supported name and a nonempty reason");
  }
  return { name: value.name, reason: value.reason };
}

/** Head selection is typed authority; a brief/message is never a selector. */
export function headWorkflow(sourceId: string, originalText: string, choice: WorkflowChoice | undefined): WorkflowActivation | null {
  const selected = workflowChoice(choice);
  if (!selected) return null;
  const user = leadingWorkflow(originalText);
  if (user && user !== selected.name) throw new Error("Head workflow conflicts with the original user's workflow invocation");
  return { ...selected, sourceId, provenance: "head" };
}

/** Native matchers must not treat routing/brief/report prose as user keywords. */
export function workflowContext(envelope: string): string {
  let longest = 2;
  for (const match of envelope.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  const fence = "`".repeat(longest + 1);
  return `${fence}superagent-runtime-context\n${envelope}\n${fence}`;
}

/** Keep user native keywords (including quoted/negative ones) byte-for-byte. */
export function workflowPrompt(activation: WorkflowActivation | null, originalText: string, envelope: string): string {
  if (!activation) return envelope;
  const leading = invocation(originalText);
  let request = leading?.name === activation.name ? originalText : `${activation.name}\n\n${originalText}`;
  const selected = invocation(request)!;
  const keyword = nativeWord[activation.name];
  // Apply only the native bridge's default. A raw user mention, even quoted or
  // negated, suppresses that default and is left for OMP's native prose matcher.
  // Check before adding context, whose metadata must not change this decision.
  if (keyword && !nativeWords.test(originalText.slice(leading?.length ?? 0))
    && /^(?:\s|$)/.test(request.slice(selected.length))) {
    request = `${request.slice(0, selected.length)} ${keyword}${request.slice(selected.length)}`;
  }
  return `${request}\n\n${workflowContext(envelope)}`;
}

export function advertisedWorkflow(value: unknown, name: WorkflowName): boolean {
  if (!value || typeof value !== "object" || !("commands" in value) || !Array.isArray(value.commands)) return false;
  return value.commands.some(command => command && typeof command === "object"
    && command.name === name && command.source === "extension"
    && command.description === `Run the OMP-adapted ${name} workflow`);
}
