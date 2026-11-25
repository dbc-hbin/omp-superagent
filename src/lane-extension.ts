import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { ToolCall, ToolResultMessage } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { type Static, Type } from "@sinclair/typebox";
import { type LaneEvidence, type LaneReportEvent, type ScopeReviewReceipt, parseLaneReportResult } from "./lane-report";
import { registerResultAttach, RESULT_ATTACH_TOOL } from "./result-attachment";
import { registerDecisionAsk } from "./decision-tool";

const instructions = readFileSync(new URL("../skills/lane/SKILL.md", import.meta.url), "utf8");
const nonempty = Type.String({ minLength: 1, pattern: "\\S" });
const evidenceReference = Type.Union([
  Type.Object({ kind: Type.Literal("file"), path: nonempty }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("tool"), toolCallId: nonempty }, { additionalProperties: false }),
]);
const evidence = Type.Array(evidenceReference, { maxItems: 32 });
const requiredEvidence = Type.Array(evidenceReference, { minItems: 1, maxItems: 32 });
const waiting = Type.Union([
  Type.Object({ kind: Type.Union([Type.Literal("tool"), Type.Literal("approval"), Type.Literal("job")]),
    id: nonempty, target: nonempty }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("dependency"), target: nonempty }, { additionalProperties: false }),
]);
const summary = Type.String({ minLength: 1, maxLength: 4000, pattern: "\\S" });
const parameters = Type.Union([
  Type.Object({ status: Type.Literal("progress"), summary, evidence: requiredEvidence },
    { additionalProperties: false }),
  Type.Object({ status: Type.Literal("waiting"), summary, waiting, evidence: Type.Optional(evidence) },
    { additionalProperties: false }),
  Type.Object({ status: Type.Literal("resolved"), summary, waiting, evidence: requiredEvidence },
    { additionalProperties: false }),
  Type.Object({ status: Type.Literal("scope_review"), sourceId: nonempty }, { additionalProperties: false }),
]);
const coordinationTool = (name: string) => name === "lane_report" || name === RESULT_ATTACH_TOOL || name.startsWith("board_");
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const keys = (value: Record<string, unknown>, names: string[]) =>
  Object.keys(value).every(key => names.includes(key));

// Direct native/custom-tool dispatch can bypass model argument validation.
function validInput(input: unknown): input is Static<typeof parameters> {
  if (!record(input)) return false;
  if (input.status === "scope_review") {
    return Object.hasOwn(input, "status") && Object.hasOwn(input, "sourceId") &&
      keys(input, ["status", "sourceId"]) && text(input.sourceId);
  }
  if (!keys(input, ["status", "summary", "waiting", "evidence"]) ||
      !text(input.summary) || input.summary.length > 4000 ||
      !["progress", "waiting", "resolved"].includes(input.status as string)) return false;
  if (input.evidence !== undefined && (!Array.isArray(input.evidence) || input.evidence.length > 32 ||
      input.evidence.some(item => !record(item) || (item.kind === "file"
        ? !keys(item, ["kind", "path"]) || !text(item.path)
        : item.kind !== "tool" || !keys(item, ["kind", "toolCallId"]) || !text(item.toolCallId))))) return false;
  if (input.status !== "waiting" && (!Array.isArray(input.evidence) || input.evidence.length === 0)) return false;
  if (input.status === "progress") return !Object.hasOwn(input, "waiting");
  const target = input.waiting;
  return record(target) && text(target.target) && (target.kind === "dependency"
    ? keys(target, ["kind", "target"])
    : ["tool", "approval", "job"].includes(target.kind as string) &&
      keys(target, ["kind", "id", "target"]) && text(target.id));
}

function fileEvidence(path: string, cwd: string): LaneEvidence {
  const source = resolve(cwd, path);
  const ref = realpathSync(source);
  // Nonblocking prevents a raced FIFO from hanging; no-follow pins the canonical file.
  const fd = openSync(ref, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile()) throw new Error("Lane file evidence must be a regular file");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(Math.min(Number(before.size), 256 * 1024));
    let bytes = 0n;
    while (bytes < before.size) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      hash.update(buffer.subarray(0, count));
      bytes += BigInt(count);
    }
    const after = fstatSync(fd, { bigint: true });
    const current = lstatSync(ref, { bigint: true });
    if (!current.isFile() || realpathSync(source) !== ref || bytes !== before.size ||
        [after, current].some(stat => stat.dev !== before.dev || stat.ino !== before.ino ||
          stat.size !== before.size || stat.mtimeNs !== before.mtimeNs || stat.ctimeNs !== before.ctimeNs)) {
      throw new Error("Lane file evidence changed while being read");
    }
    return { kind: "file", ref, fingerprint: hash.digest("hex") };
  } finally {
    closeSync(fd);
  }
}

function toolRecords(ctx: ExtensionContext, ids: ReadonlySet<string>) {
  const calls = new Map<string, ToolCall>();
  const results = new Map<string, ToolResultMessage>();
  if (ids.size > 0) {
    // Branch order preserves the first call and the last result for each ID.
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message") continue;
      const message = entry.message;
      if (message.role === "assistant") {
        for (const block of message.content) {
          if (block.type === "toolCall" && ids.has(block.id) && !calls.has(block.id)) calls.set(block.id, block);
        }
      } else if (message.role === "toolResult" && ids.has(message.toolCallId)) {
        results.set(message.toolCallId, message);
      }
    }
  }
  return { calls, results };
}

function toolEvidence(id: string, records: ReturnType<typeof toolRecords>): LaneEvidence {
  const call = records.calls.get(id);
  const result = records.results.get(id);
  if (!call || !result || result.toolName !== call.name || result.isError !== false ||
      coordinationTool(call.name) || (typeof call.arguments.path === "string" &&
        /^xd:\/\/(?:lane_report|board_[a-z_]+)(?:[/?#]|$)/.test(call.arguments.path)) ||
      parseLaneReportResult(result) || (record(result.details) && result.details.type === "superagent-scope-review")) {
    throw new Error("Lane tool evidence requires a completed successful native tool call, not report/board chatter");
  }
  // Native identity/time envelopes are not evidence of changed work.
  const resultRecord = { toolName: result.toolName, content: result.content, details: result.details, isError: result.isError };
  return { kind: "tool", ref: id, fingerprint: createHash("sha256").update(JSON.stringify(resultRecord)).digest("hex") };
}

/** A worker role entrypoint, never the head's manager or messenger client. */
export default function laneExtension(pi: ExtensionAPI): void {
  if (process.env.OMP_SUPERAGENT_ROLE !== "lane") return;
  registerDecisionAsk(pi);
  registerResultAttach(pi);
  let approvalSessionId: string | undefined;
  const pendingApprovals = new Set<string>();
  const scopeApprovals = new Map<string, "requested" | "approved" | "unverified">();
  const approvals = (ctx: ExtensionContext) => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (approvalSessionId !== sessionId) {
      pendingApprovals.clear();
      scopeApprovals.clear();
      approvalSessionId = sessionId;
    }
    return pendingApprovals;
  };
  pi.on("session_start", async (_event, ctx) => {
    approvals(ctx);
    if (ctx.agent.kind !== "main") {
      // Subtract only our tool; never re-enable an operator-excluded native tool.
      const active = pi.getActiveTools();
      const scoped = active.filter(name => name !== "lane_report" && name !== RESULT_ATTACH_TOOL);
      if (scoped.length !== active.length) await pi.setActiveTools(scoped);
    }
  });
  pi.on("tool_call", (event, ctx) => {
    if (event.toolName === "lane_report" && ctx.agent.kind !== "main") {
      return { block: true, reason: "Lane reporting is restricted to the root lane session" };
    }
    if (ctx.agent.kind === "main" && (event.toolName === "ask" || event.toolName === "write" && event.input.path === "xd://ask")) {
      return { block: true, reason: "Use decision_ask for a structured owner choice or manager review. Native execution approvals are unchanged." };
    }
  });
  pi.on("tool_approval_requested", (event, ctx) => {
    if (ctx.agent.kind === "main" && event.sessionId === ctx.sessionManager.getSessionId()) {
      approvals(ctx).add(event.toolCallId);
      if (event.toolName === "lane_report")
        scopeApprovals.set(event.toolCallId, scopeApprovals.has(event.toolCallId) ? "unverified" : "requested");
    }
  });
  pi.on("tool_approval_resolved", (event, ctx) => {
    if (event.sessionId !== ctx.sessionManager.getSessionId()) return;
    approvals(ctx).delete(event.toolCallId);
    if (ctx.agent.kind === "main" && event.toolName === "lane_report")
      scopeApprovals.set(event.toolCallId,
        event.approved && scopeApprovals.get(event.toolCallId) === "requested" ? "approved" : "unverified");
  });
  pi.on("agent_end", (_event, ctx) => { if (ctx.agent.kind === "main") scopeApprovals.clear(); });
  pi.on("session_shutdown", () => {
    pendingApprovals.clear();
    scopeApprovals.clear();
  });
  pi.on("before_agent_start", async (event, ctx) => {
    if (ctx.agent.kind !== "main") return;
    return { systemPrompt: [
      ...event.systemPrompt,
      instructions,
      `Lane identity: ${process.env.OMP_SUPERAGENT_LANE}. Workspace: ${ctx.cwd}.`,
    ] };
  });
  pi.registerTool({
    name: "lane_report", label: "Report lane observations", approval: "read", loadMode: "essential",
    description: "Record an evidence-backed progress, waiting, or resolved observation in this lane's native tool journal. " +
      "Progress/resolved require selected real file paths or completed successful native toolCallIds; hashes are computed here. " +
      "Waiting/resolved name the exact tool/approval/job ID or a dependency label. Native tool/approval/job waiting IDs must be observable now. " +
      "For a standalone original owner message in the active bound topic that appears to supersede the existing assignment, " +
      "call lane_report directly with status scope_review and its Original source ID, never via eval, bash, or write. " +
      "This only requests HEAD review; it does not grant permission. " +
      "Reports do not send messages, prove acceptance, dispatch, resume, or change execution authority. Board/report chatter is not evidence.",
    parameters,
    async execute(id, params, signal, _onUpdate, ctx) {
      if (ctx.agent.kind !== "main") throw new Error("Lane reporting is restricted to the root lane session");
      if (!validInput(params)) throw new Error("Invalid lane report parameters");
      approvals(ctx);
      const nativeApproval = scopeApprovals.get(id);
      scopeApprovals.delete(id);
      if (params.status === "scope_review") {
        signal?.throwIfAborted();
        const sessionFile = ctx.sessionManager.getSessionFile();
        if (!sessionFile) throw new Error("Lane scope review requires a native session file");
        const receipt: ScopeReviewReceipt = {
          type: "superagent-scope-review", sourceId: params.sourceId,
          sessionId: ctx.sessionManager.getSessionId(), sessionFile, toolCallId: id,
        };
        // Only a matched direct native start/end can request review. Do not append a custom entry.
        return {
          content: [{ type: "text", text: "Emitted a scope-review signal. HEAD admission depends on controller verification and successful settlement; the assignment has not changed." }],
          details: nativeApproval === undefined ? receipt : { ...receipt, nativeApproval },
        };
      }
      const target = params.status === "waiting" ? params.waiting : undefined;
      if (target?.kind === "approval" && !approvals(ctx).has(target.id)) {
        throw new Error("Lane approval wait requires an observed pending native tool approval");
      }
      if (target?.kind === "job" && !ctx.getAsyncJobSnapshot()?.running.some(job => job.id === target.id)) {
        throw new Error("Lane job wait requires a running native session job");
      }
      const references = params.evidence ?? [];
      const ids = new Set<string>();
      if (target?.kind === "tool") ids.add(target.id);
      for (const item of references) if (item.kind === "tool") ids.add(item.toolCallId);
      const records = toolRecords(ctx, ids);
      if (target?.kind === "tool") {
        const call = records.calls.get(target.id);
        if (!call || records.results.has(target.id) || target.id === id || call.name === "lane_report") {
          throw new Error("Lane tool wait requires an actual pending native tool call");
        }
      }
      const selected = references.map(item => item.kind === "file"
        ? fileEvidence(item.path, ctx.cwd) : toolEvidence(item.toolCallId, records));
      const event: LaneReportEvent = {
        type: "superagent-lane-report", sessionId: ctx.sessionManager.getSessionId(), reportId: id,
        report: { status: params.status, summary: params.summary, evidence: selected,
          ...(params.status === "progress" ? {} : { waiting: params.waiting }) },
      };
      // Eval bridges return nested details to the kernel, not a toolResult
      // message. The same native journal event survives that path and replay.
      pi.appendEntry("superagent-lane-report", event);
      return { content: [{ type: "text", text: `Recorded lane ${params.status} observation in the native tool result.` }], details: event };
    },
  });
}
