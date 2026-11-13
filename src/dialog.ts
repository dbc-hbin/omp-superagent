/** Native OMP dialog semantics, independent of a transport's UI capacities. */
export interface Question {
  id: string;
  question: string;
  header?: string;
  options: { label: string; description?: string; preview?: string }[];
  multi?: boolean;
  recommended?: number;
}

export type Dialog =
  | { method: "confirm"; title: string; message: string }
  | { method: "select"; title: string; options: string[]; details: (string | undefined)[]; marker?: "radio" | "checkbox"; checked: number[]; markableCount: number; initialIndex?: number }
  | { method: "input"; title: string; placeholder?: string; prefill?: string }
  | { method: "editor"; title: string; placeholder?: string; prefill?: string }
  | { method: "ask"; questions: Question[] };

function text(value: unknown): value is string { return typeof value === "string"; }
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function unsupported(reason: string): never { throw new Error(reason); }

/** Preserve native values and host-owned checked state; never collect secrets. */
export function parseDialog(request: Record<string, unknown>): Dialog {
  if (request.secret === true) unsupported("Secret input cannot safely be collected through a messenger; use the local OMP interface.");
  if (request.method === "ask") {
    if (!Array.isArray(request.questions) || request.questions.length === 0) unsupported("Ask request has no questions.");
    const questions: Question[] = request.questions.map((value: unknown) => {
      if (!object(value) || !text(value.id) || !text(value.question) || !Array.isArray(value.options)) return unsupported("Malformed ask question.");
      if (value.header !== undefined && !text(value.header)) unsupported("Malformed ask header.");
      if (value.multi !== undefined && typeof value.multi !== "boolean") unsupported("Malformed ask selection mode.");
      const options = value.options.map((option: unknown) => {
        if (!object(option) || !text(option.label) || !option.label) return unsupported("Malformed ask option.");
        if (option.description !== undefined && !text(option.description)) unsupported("Malformed ask description.");
        if (option.preview !== undefined && !text(option.preview)) unsupported("Malformed ask preview.");
        return { label: option.label, description: option.description as string | undefined, preview: option.preview as string | undefined };
      });
      if (new Set(options.map(option => option.label)).size !== options.length) unsupported("Ask option labels are not unique.");
      if (value.recommended !== undefined && (!Number.isInteger(value.recommended) || (value.recommended as number) < 0 || (value.recommended as number) >= options.length)) unsupported("Malformed recommended option.");
      return { id: value.id, question: value.question, header: value.header as string | undefined, multi: value.multi as boolean | undefined, recommended: value.recommended as number | undefined, options };
    });
    if (new Set(questions.map(question => question.id)).size !== questions.length) unsupported("Ask question IDs are not unique.");
    return { method: "ask", questions };
  }
  if (!text(request.title)) unsupported("Dialog title is missing.");
  if (request.method === "confirm") {
    if (!text(request.message)) unsupported("Confirmation message is missing.");
    return { method: "confirm", title: request.title, message: request.message };
  }
  if (request.method === "select") {
    if (!Array.isArray(request.options) || request.options.length === 0 || !request.options.every(option => text(option) && option.length > 0) || new Set(request.options).size !== request.options.length) unsupported("Malformed or duplicate select options.");
    if (request.selectionMarker !== undefined && request.selectionMarker !== "radio" && request.selectionMarker !== "checkbox") unsupported("Malformed select marker.");
    const marker = request.selectionMarker as "radio" | "checkbox" | undefined;
    const markableCount = request.markableCount ?? (marker ? request.options.length : 0);
    if (!Number.isInteger(markableCount) || (markableCount as number) < 0 || (markableCount as number) > request.options.length) unsupported("Malformed marked-option count.");
    const checked = request.checkedIndices ?? [];
    if (!Array.isArray(checked) || checked.some(index => !Number.isInteger(index) || index < 0 || index >= (markableCount as number)) || new Set(checked).size !== checked.length) unsupported("Malformed checked-option state.");
    if (request.initialIndex !== undefined && (!Number.isInteger(request.initialIndex) || (request.initialIndex as number) < 0 || (request.initialIndex as number) >= request.options.length)) unsupported("Malformed initial select index.");
    if (request.optionDetails !== undefined && !Array.isArray(request.optionDetails)) unsupported("Malformed select details.");
    const details = request.options.map((_, index) => {
      const detail = Array.isArray(request.optionDetails) ? request.optionDetails[index] : undefined;
      if (detail === undefined) return undefined;
      if (!object(detail) || (detail.description !== undefined && !text(detail.description))) return unsupported("Malformed select description.");
      return detail.description as string | undefined;
    });
    return { method: "select", title: request.title, options: request.options as string[], details, marker, checked, markableCount: markableCount as number, initialIndex: request.initialIndex as number | undefined };
  }
  if (request.method === "input" || request.method === "editor") {
    if (request.placeholder !== undefined && !text(request.placeholder)) unsupported("Malformed input placeholder.");
    if (request.prefill !== undefined && !text(request.prefill)) unsupported("Malformed editor content.");
    return { method: request.method, title: request.title, placeholder: request.placeholder as string | undefined, prefill: request.prefill as string | undefined };
  }
  return unsupported(`Dialog method ${String(request.method)} cannot be represented safely in a messenger.`);
}
