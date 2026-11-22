export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}
export function textSignature(part: unknown): { id?: string; phase?: "commentary" | "final_answer" } {
  const signature = record(part).textSignature;
  if (typeof signature !== "string") return {};
  try {
    const parsed = record(JSON.parse(signature));
    return parsed.v === 1 && typeof parsed.id === "string"
      ? { id: parsed.id, ...(parsed.phase === "commentary" || parsed.phase === "final_answer" ? { phase: parsed.phase } : {}) }
      : {};
  } catch { return {}; }
}
export function assistantText(value: unknown): string | null {
  const message = record(value);
  if (message.role !== "assistant" || !Array.isArray(message.content)) return null;
  const text = message.content.filter(part => record(part).type === "text"
    && textSignature(part).phase !== "commentary"
    && (message.stopReason !== "toolUse" || textSignature(part).phase === "final_answer"))
    .map(part => String(record(part).text ?? "")).join("");
  return text.trim() ? text : null;
}
