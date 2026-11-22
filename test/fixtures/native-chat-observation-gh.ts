/** Offline gh wire: only the known read-only PR query plan can succeed. */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = process.env.OMP_NATIVE_GATEWAY_ROOT;
assert(root && existsSync(join(root, ".native-chat-observation")));
const args = process.argv.slice(2);
assert.deepEqual(args.slice(0, -1), ["api", "--hostname", "github.com", "--method", "GET", "--paginate", "--slurp",
  "--header", "Accept: application/vnd.github+json"]);
const repo = "repos/fixture-owner/fixture-repo";
const pr = `${repo}/pulls/7`;
const head = "a".repeat(40);
const failed = existsSync(join(root, "fail-fixture-ci"));
const replies: ReadonlyMap<string, unknown> = new Map<string, unknown>([
  [pr, [{ head: { sha: head }, state: "open", merged: false, merge_commit_sha: null }]],
  ["user", [{ login: "fixture-owner" }]],
  [`${repo}/issues/7/comments?per_page=100`, [[]]],
  [`${pr}/comments?per_page=100`, [[]]],
  [`${pr}/reviews?per_page=100`, [[]]],
  [`${repo}/issues/7/timeline?per_page=100`, [[]]],
  [`${repo}/commits/${head}/statuses?per_page=100`, [[]]],
  [`${repo}/commits/${head}/check-runs?per_page=100&filter=latest`, [{
    total_count: 1,
    check_runs: [{
      id: 17, name: "offline-integration-build", html_url: null, head_sha: head,
      status: failed ? "completed" : "in_progress", conclusion: failed ? "failure" : null,
      started_at: "2026-11-01T00:00:00Z", completed_at: failed ? "2026-11-01T00:01:00Z" : null,
    }],
  }]],
]);
const endpoint = args.at(-1);
assert(endpoint && replies.has(endpoint), `Unrecognized offline gh read: ${endpoint}`);
process.stdout.write(JSON.stringify(replies.get(endpoint)));
