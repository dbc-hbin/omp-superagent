import { isAbsolute, normalize } from "node:path";
import { isDeepStrictEqual } from "node:util";

export type LaneWaitTarget =
  | { kind: "tool" | "approval" | "job"; id: string; target: string }
  | { kind: "dependency"; target: string };

export interface LaneEvidence {
  kind: "file" | "tool";
  ref: string;
  fingerprint: string;
}

export interface LaneReport {
  status: "progress" | "waiting" | "resolved";
  summary: string;
  evidence: LaneEvidence[];
  waiting?: LaneWaitTarget;
}

export interface LaneReportEvent {
  type: "superagent-lane-report";
  sessionId: string;
  reportId: string;
  report: LaneReport;
}

/** Evidence of a tool execution only; it does not authorize a scope change. */
export type ScopeReviewReceipt = {
  readonly type: "superagent-scope-review";
  readonly sourceId: string;
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly toolCallId: string;
};

/** Stock OMP select wire for this tool. A positive answer describes this call
 * only; the native Host, not the controller, handles any session-wide choice. */
export function scopeReviewApproval(request: Record<string, unknown>, response?: { value?: string }): boolean {
  if (request.method !== "select" || request.secret === true) return false;
  const options = request.options;
  const session = "Approve lane_report for this session";
  if (!isDeepStrictEqual(options, ["Approve", "Deny"]) && !isDeepStrictEqual(options, ["Approve", session, "Deny"])) return false;
  if (!response) return true;
  return isDeepStrictEqual(response, { value: "Approve" })
    || Array.isArray(options) && options.includes(session) && isDeepStrictEqual(response, { value: session });
}

export function laneWaitKey(waiting: LaneWaitTarget): string {
  return JSON.stringify([waiting.kind, waiting.kind === "dependency" ? waiting.target : waiting.id]);
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const keys = (value: Record<string, unknown>, names: string[]) =>
  Object.keys(value).every(key => names.includes(key));

/** Parse only the structured native result, never receipt text or a claimed event in content. */
export function parseLaneReportResult(result: unknown): LaneReportEvent | null {
  try {
    if (!record(result) || result.isError === true || !record(result.details)) return null;
    const event = result.details;
    if (!keys(event, ["type", "sessionId", "reportId", "report"]) ||
        event.type !== "superagent-lane-report" || !text(event.sessionId) || !text(event.reportId) ||
        !record(event.report)) return null;
    const report = event.report;
    if (!keys(report, ["status", "summary", "evidence", "waiting"]) ||
        !["progress", "waiting", "resolved"].includes(report.status as string) ||
        !text(report.summary) || report.summary.length > 4000 || !Array.isArray(report.evidence) ||
        report.evidence.length > 32) return null;
    if (report.evidence.some(item => !record(item) || !keys(item, ["kind", "ref", "fingerprint"]) ||
        (item.kind !== "file" && item.kind !== "tool") || !text(item.ref) ||
        (item.kind === "file" && (!isAbsolute(item.ref) || normalize(item.ref) !== item.ref)) ||
        typeof item.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(item.fingerprint))) return null;
    if (report.status !== "waiting" && report.evidence.length === 0) return null;
    if (report.status === "progress") {
      if (Object.hasOwn(report, "waiting")) return null;
    } else {
      const waiting = report.waiting;
      if (!record(waiting) || !text(waiting.target)) return null;
      if (waiting.kind === "dependency") {
        if (!keys(waiting, ["kind", "target"])) return null;
      } else if (!["tool", "approval", "job"].includes(waiting.kind as string) ||
          !text(waiting.id) || !keys(waiting, ["kind", "id", "target"])) return null;
    }
    return event as unknown as LaneReportEvent;
  } catch {
    // Malformed native details must not escape into the head's event loop.
    return null;
  }
}
