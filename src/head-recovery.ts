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
  const sameRun = typeof receiptData.hostPid === "number" && Number.isSafeInteger(receiptData.hostPid)
    && receiptData.hostPid > 0 && typeof receiptData.instanceKey === "string" && receiptData.instanceKey !== ""
    && typeof receiptData.runOrdinal === "number" && Number.isSafeInteger(receiptData.runOrdinal) && receiptData.runOrdinal > 0
    && receiptData.hostPid === startData.hostPid && receiptData.instanceKey === startData.instanceKey
    && receiptData.runOrdinal === startData.runOrdinal;
  // The exact settled run failed before any tool started: only its prompt,
  // failed model replies without tool calls, native provider refusals and
  // usage records exist. An earlier tool, another request, an unknown journal
  // entry or anything after the receipt makes the effect history unproven.
  const toolFreeFailure = frame.status === "error" && frame.sessionSettled === true && frame.agentInvoked === true
    && sameRun && users.length === 1 && receiptIndex > latestStartIndex
    && slice.every((entry, index) => {
      if (entry.type === "model_usage" || entry === receipt) return true;
      // The settled receipt ends this run. Later native lifecycle and
      // extension state records (for example session_exit on a restart) are
      // not its effects; a later run, tool or message is not attributable.
      if (index > receiptIndex) return (entry.type === "custom" || entry.type === "custom_message")
        && !["rpc_agent_start", "rpc_prompt_result", "tool_execution_start"].includes(String(entry.customType));
      if (matches(entry, "rpc_agent_start")) {
        const start = object(entry.data);
        return start.hostPid === receiptData.hostPid && start.instanceKey === receiptData.instanceKey
          && typeof start.runOrdinal === "number" && Number.isSafeInteger(start.runOrdinal)
          && start.runOrdinal > 0 && start.runOrdinal <= Number(receiptData.runOrdinal);
      }
      if (entry.type === "custom") return entry.customType === "provider_refusal";
      if (entry.type !== "message") return false;
      const message = object(entry.message);
      return message.role === "user" || message.role === "assistant" && message.stopReason === "error"
        && Array.isArray(message.content) && !message.content.some(part => object(part).type === "toolCall");
    });
  // The exact provider refused the entire turn for quota. A partial answer or
  // another provider's reply makes it something other than a quota hold.
  const quotaFailure: HeadQuotaFailure | null = toolFreeFailure
    && error.provider === "openai-codex" && typeof error.model === "string" && error.model !== ""
    && error.retryable === false && typeof error.message === "string"
    // Stock OMP's RPC error lacks a structured quota code. Match either
    // native Codex formatter, but require the exact code in its metadata.
    && /^Codex (?:error event|response failed)(?:: [\s\S]+)? \(code=usage_limit_reached(?:, status=[a-z_]+)?\)$/.test(error.message)
    && Number.isFinite(failedAt) && latestRunStatus === "error"
    && slice.slice(receiptIndex + 1).every(entry => entry.type === "model_usage")
    && slice.every(entry => {
      if (entry.type === "custom") return entry.customType !== "provider_refusal";
      const message = object(entry.message);
      return entry.type !== "message" || message.role !== "assistant" || message.provider === error.provider
        && message.model === error.model && Array.isArray(message.content) && message.content.length === 0;
    })
    ? { failedAt, model: { provider: error.provider, id: error.model } } : null;
  const selected = [receipt, ...starts, ...assistants];
  if (selected.some(entry => typeof entry.id !== "string")) return null;
  const entryIds = [...new Set(selected.map(entry => String(entry.id)))];
  const proof = { entryIds, receiptStatus: String(frame.status), latestRunStatus: latestRunStatus ?? null,
    outcome: outcome ?? null };
  return { ...proof, toolFreeFailure, quotaFailure, boundary: String(journal[end]!.id),
    fingerprint: createHash("sha256").update(JSON.stringify(slice.map(entry => [
      entry.id, entry.type, entry.customType,
      matches(entry, "rpc_prompt_result") ? object(entry.data).frame : null,
      matches(entry, "rpc_prompt_result") || matches(entry, "rpc_agent_start")
        ? [object(entry.data).hostPid ?? null, object(entry.data).instanceKey ?? null, object(entry.data).runOrdinal ?? null] : null,
      entry.type === "message" ? object(entry.message).role : null,
      entry.type === "message" ? object(entry.message).stopReason : null,
    ]))).digest("hex") };
}
