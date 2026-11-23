import { createHash } from "node:crypto";
import type { HeadRecoveryAttempt } from "./contracts";

export interface HeadQuotaFailure {
  readonly model: { readonly provider: "openai-codex"; readonly id: string };
  readonly failedAt: number;
}

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? value as Record<string, unknown> : {};

/** Only journal identities and native outcome fields leave this evidence reader. */
export function headRecoveryEvidence(entries: unknown[], owner: Pick<HeadRecoveryAttempt,
  "sessionId" | "sessionFile" | "requestId" | "cursor">, boundary?: string) {
  const journal = entries.map(object);
  const start = owner.cursor === null ? -1 : journal.findIndex(entry => entry.id === owner.cursor);
  const end = boundary === undefined ? journal.length - 1 : journal.findIndex(entry => entry.id === boundary);
  if (owner.cursor !== null && start < 0 || end <= start || typeof journal[end]?.id !== "string") return null;
  const slice = journal.slice(start + 1, end + 1);
  const matches = (entry: Record<string, unknown>, type: string) => entry.type === "custom" && entry.customType === type
    && object(entry.data).sessionId === owner.sessionId && object(entry.data).sessionFile === owner.sessionFile;
  const receipts = slice.filter(entry => matches(entry, "rpc_prompt_result"));
  const receiptsForRequest = receipts.filter(entry => object(object(entry.data).frame).id === owner.requestId);
  if (receiptsForRequest.length !== 1 || receipts.length !== 1) return null;
  const receipt = receiptsForRequest[0]!;
  const frame = object(object(receipt.data).frame);
  const starts = slice.filter(entry => matches(entry, "rpc_agent_start"));
  const latestStart = starts.at(-1);
  const latestStartIndex = latestStart ? slice.indexOf(latestStart) : -1;
  // Another submitted user message is an ownership boundary, even if its RPC
  // receipt has not arrived. Do not borrow its assistant outcome.
  const users = slice.filter(entry => entry.type === "message" && object(entry.message).role === "user");
  const firstAssistantIndex = slice.findIndex(entry => entry.type === "message" && object(entry.message).role === "assistant");
  if (users.length > 1 || users.some(entry => firstAssistantIndex >= 0 && slice.indexOf(entry) > firstAssistantIndex)) return null;
  const assistants = slice.slice(latestStartIndex + 1).filter(entry => entry.type === "message"
    && object(entry.message).role === "assistant");
  const latestAssistant = assistants.at(-1);
  const latestRunStatus = object(latestAssistant?.message).stopReason;
  let outcome: "done" | "cancelled" | undefined;
  const receiptData = object(receipt.data);
  const startData = object(latestStart?.data);
  const receiptAfterStart = typeof receiptData.runOrdinal === "number" && typeof startData.runOrdinal === "number"
    && receiptData.hostPid === startData.hostPid
    ? receiptData.runOrdinal >= startData.runOrdinal
    : slice.indexOf(receipt) > latestStartIndex;
  if (frame.status === "aborted" && (!latestStart || receiptAfterStart)) outcome = "cancelled";
  if (frame.status === "completed") {
    if (frame.agentInvoked === false && !latestStart) outcome = "done";
    else if (latestStart && (latestRunStatus === "stop" || latestRunStatus === "length")) outcome = "done";
    else if (latestStart && latestRunStatus === "aborted") outcome = "cancelled";
  }
  const error = object(frame.error);
  const failedAt = typeof receipt.timestamp === "string" ? Date.parse(receipt.timestamp) : NaN;
  const receiptIndex = slice.indexOf(receipt);
  // The exact provider refused the entire turn. An earlier tool, partial
  // answer, other request, or unknown journal effect makes this unsafe to close.
  const quotaFailure: HeadQuotaFailure | null = frame.status === "error" && frame.sessionSettled === true
    && frame.agentInvoked === true && error.provider === "openai-codex" && typeof error.model === "string" && error.model !== ""
    && error.retryable === false && typeof error.message === "string"
    && /^Codex error event: .+ \(code=usage_limit_reached\)$/.test(error.message)
    && Number.isFinite(failedAt) && latestStart && receiptAfterStart && latestRunStatus === "error"
    && users.length === 1 && receiptIndex > latestStartIndex
    && slice.every((entry, index) => {
      if (entry.type === "model_usage" || entry === receipt) return true;
      if (index >= receiptIndex) return false;
      if (matches(entry, "rpc_agent_start")) return true;
      if (entry.type !== "message") return false;
      const message = object(entry.message);
      return message.role === "user" || message.role === "assistant" && message.stopReason === "error"
        && message.provider === error.provider && message.model === error.model
        && Array.isArray(message.content) && message.content.length === 0;
    })
    ? { failedAt, model: { provider: error.provider, id: error.model } } : null;
  const selected = [receipt, ...starts, ...assistants];
  if (selected.some(entry => typeof entry.id !== "string")) return null;
  const entryIds = [...new Set(selected.map(entry => String(entry.id)))];
  const proof = { entryIds, receiptStatus: String(frame.status), latestRunStatus: latestRunStatus ?? null,
    outcome: outcome ?? null };
  return { ...proof, quotaFailure, boundary: String(journal[end]!.id),
    fingerprint: createHash("sha256").update(JSON.stringify(slice.map(entry => [
      entry.id, entry.type, entry.customType,
      matches(entry, "rpc_prompt_result") ? object(entry.data).frame : null,
      matches(entry, "rpc_prompt_result") || matches(entry, "rpc_agent_start")
        ? [object(entry.data).hostPid ?? null, object(entry.data).instanceKey ?? null, object(entry.data).runOrdinal ?? null] : null,
      entry.type === "message" ? object(entry.message).role : null,
      entry.type === "message" ? object(entry.message).stopReason : null,
    ]))).digest("hex") };
}
