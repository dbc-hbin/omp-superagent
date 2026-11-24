import { Type, type Static, type TSchema } from "@sinclair/typebox/type";
import { Value } from "@sinclair/typebox/value";

export class PrReadError extends Error {
  constructor(readonly reason: "reference" | "request" | "response" | "changed" | "ci-changed" | "aborted") {
    super({
      reference: "Invalid GitHub PR reference",
      request: "GitHub PR observation request failed",
      response: "GitHub PR observation response was invalid or incomplete",
      changed: "GitHub PR changed during observation",
      "ci-changed": "GitHub PR check attempts changed during observation",
      aborted: "GitHub PR observation was cancelled",
    }[reason]);
    this.name = "PrReadError";
  }
}

const id = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
export const sha = Type.String({ pattern: "^(?:[0-9a-f]{40}|[0-9a-f]{64})$" });
// PR intake accepts SHA-1 only; general GitHub reads also accept SHA-256.
export const sha40 = Type.String({ pattern: "^[0-9a-f]{40}$" });
const nullableText = Type.Union([Type.String(), Type.Null()]);
const user = Type.Union([Type.Object({
  login: Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9-]*(\\[bot\\])?$", maxLength: 100 }),
}), Type.Null()]);
export const loginSchema = Type.Object({
  login: Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9-]*$", maxLength: 39 }),
});
export const metadataSchema = Type.Object({
  head: Type.Object({ sha }),
  state: Type.Union([Type.Literal("open"), Type.Literal("closed")]),
  merged: Type.Boolean(),
  merge_commit_sha: Type.Union([sha, Type.Null()]),
});
export const commentSchema = Type.Object({
  id, user, body: nullableText, html_url: Type.String(), updated_at: Type.String({ minLength: 1 }),
});
export const reviewSchema = Type.Object({
  id, user, body: nullableText, html_url: Type.String(),
  state: Type.Union((["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"] as const).map(value => Type.Literal(value))),
  submitted_at: nullableText,
});
export const timelineSchema = Type.Union([
  Type.Object({
    event: Type.Literal("review_dismissed"), id, actor: user, created_at: Type.String(),
    dismissed_review: Type.Object({
      review_id: id, dismissal_message: nullableText,
    }),
  }),
  Type.Object({ event: Type.String({ pattern: "^(?!review_dismissed$).+" }) }),
]);
export const checkPageSchema = Type.Object({
  total_count: Type.Integer({ minimum: 0 }),
  check_runs: Type.Array(Type.Object({
    id, name: Type.String(), html_url: nullableText,
    head_sha: sha, status: Type.Union((["queued", "in_progress", "completed", "waiting", "requested", "pending"] as const).map(value => Type.Literal(value))),
    conclusion: Type.Union([
      Type.Union((["success", "failure", "neutral", "cancelled", "skipped", "timed_out", "action_required", "stale", "startup_failure"] as const).map(value => Type.Literal(value))),
      Type.Null(),
    ]),
    started_at: nullableText, completed_at: nullableText,
  })),
});
export const statusSchema = Type.Object({
  id, context: Type.String(), target_url: nullableText, created_at: Type.String(),
  state: Type.Union((["error", "failure", "pending", "success"] as const).map(value => Type.Literal(value))),
});
export const ciOutcomeSchema = Type.Union(
  (["missing", "pending", "skipped", "failed", "passed", "passed_with_skips"] as const).map(value => Type.Literal(value)),
);
export const comparePageSchema = Type.Object({
  status: Type.Union((["ahead", "behind", "diverged", "identical"] as const).map(value => Type.Literal(value))),
  total_commits: Type.Integer({ minimum: 0 }),
  base_commit: Type.Object({ sha }),
  merge_base_commit: Type.Object({ sha }),
  commits: Type.Array(Type.Object({ sha, author: user, committer: user })),
});

export function parseWire<T extends TSchema>(schema: T, output: string): Static<T> {
  let value: unknown;
  try { value = JSON.parse(output); }
  catch (error) {
    if (error instanceof SyntaxError) throw new PrReadError("response");
    throw error;
  }
  if (!Value.Check(schema, value)) throw new PrReadError("response");
  return value;
}

export function pages<T extends TSchema>(schema: T) {
  return Type.Array(schema, { minItems: 1 });
}

/** API content is untrusted data, never an instruction or an email identity. */
export function safeText(value: string, limit = 4096): string {
  return value.normalize("NFKC").replace(/\r\n?/g, "\n")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, character => character === "\n" || character === "\t" ? character : " ")
    .replace(/[^\s<>()"@,;:]+@[^\s<>()"@,;:]+/gu, "[email]")
    .slice(0, limit);
}

export function safeUrl(value: string | null): string {
  if (value === null) return "";
  const normalized = safeText(value, 2048);
  try {
    const url = new URL(normalized);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return "";
    url.search = "";
    // Keep GitHub's comment/review anchors, never arbitrary fragment payloads.
    if (!/^#[a-zA-Z0-9_-]+$/.test(url.hash)) url.hash = "";
    return url.href.length <= 2048 ? url.href : "";
  } catch (error) {
    if (error instanceof TypeError) return "";
    throw error;
  }
}
