import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Inbound, Route } from "../../src/contracts";

const parent: Route = { platform: "discord", accountId: "2", authorityId: "1", guildId: "3", channelId: "4", threadId: null };
const thread: Route = { ...parent, threadId: "50" };

const plain = { concept: "plain", tone: "direct", register: "natural", detail: "balanced", structure: "answer-first", emoji: "none" } as const;
const editorial = { ...plain, concept: "editorial", register: "formal", detail: "brief" } as const;
export const soulProfiles = {
  plain: { revision: 0, style: plain },
  editorial: { revision: 1, style: editorial },
  mentoring: { revision: 2, style: { ...editorial, concept: "mentoring", tone: "neutral" } },
} as const;
export const soulSteerEntered = "soul-steer-entered";
export const soulSteerRelease = "soul-steer-release";
export const soulWitnessFile = "soul-provider.jsonl";
export const soulVoiceOpen = "<superagent-reply-voice>";
export const soulVoiceClose = "</superagent-reply-voice>";
export const soulKickoff = "I will inspect the authorized local workspace in this thread.";
export const soulChildTask = "Inspect the isolated child model's available capabilities and report them.";
export const soulChildAnswer = "The native child inspection is complete.";
export const soulChildRelease = "soul-child-release";
export const soulLaneResult = "The native lane finished its manager assignment.";
export const soulSteeredResult = "The native lane incorporated the bound follow-up into its manager result.";

export const soulCases = {
  oldHead: { id: "401", route: parent, text: "Explain the local fixture in one sentence." },
  opening: { id: "402", route: thread, text: "/head Start a separate lane in the verified local fixture workspace." },
  oldLane: { id: "403", route: thread, text: "Continue independently with an ordinary result for this topic." },
  editorUpdate: { id: "404", route: parent, text: "앞으로 유능한 편집장처럼, 존댓말로 짧게 결론부터 해줘" },
  editorHead: { id: "405", route: parent, text: "Explain the term `super-plan` without selecting any workflow." },
  editorLane: { id: "406", route: thread, text: "Give the next independent result directly in this topic." },
  oneOff: { id: "411", route: parent, text: "Set your reply style to warm for one message only." },
  mentorUpdate: { id: "412", route: parent, text: "이제부터 옆자리 선배처럼 차분하게 설명해 줘" },
  mentorHead: { id: "413", route: parent, text: "Summarize what the isolated fixture now checks." },
  mentorLane: { id: "414", route: thread, text: "Summarize the independent result for this topic." },
  negated: { id: "415", route: parent, text: "From now on, reply like a mentor but avoid a casual register." },
  manager: { id: "407", route: thread, text: "/head Delegate the next local check to our existing lane and report its result here." },
  steer: { id: "408", route: thread, text: "Also include the current bound-topic detail in the result." },
  child: { id: "409", route: parent, text: "/head Ask a bounded native child to inspect its own capabilities, then report back." },
  super: { id: "410", route: parent, text: "/head /super-plan outline the isolated fixture verification." },
} as const satisfies Record<string, Pick<Inbound, "id" | "route" | "text">>;

export type SoulProviderWitness = {
  readonly role: "head" | "lane" | "child";
  readonly requestId: string;
  readonly pid: number;
  readonly voice: readonly string[];
  readonly voiceLines: readonly string[];
  readonly voiceTags: readonly [number, number];
  readonly headContract: boolean;
  readonly managerTools: readonly string[];
  readonly policyCount: number;
  readonly mode: "topic reply" | "manager handoff" | null;
  readonly steering: boolean;
};

export function soulDigest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function soulText(content: string | readonly { readonly type: string; readonly text?: string }[]): string {
  return typeof content === "string" ? content : content.flatMap(part =>
    part.type === "text" && part.text !== undefined ? [part.text] : []).join("\n");
}

export function assertSoulProviderRows(rows: readonly SoulProviderWitness[], identity: {
  readonly head: { readonly ids: readonly string[]; readonly beforeReopen: number; readonly pid: number };
  readonly lane: { readonly ids: readonly string[]; readonly pid: number };
}, voiceByRevision: readonly string[]): void {
  const { oldHead, opening, editorUpdate, editorHead, oneOff, mentorUpdate, child, super: workflow } = soulCases;
  const [opened, oldLane, editorLane, mentorLane, manager, steer] = identity.lane.ids;
  const childId = `child:${child.id}`;
  for (const role of ["head", "lane", "child"] as const) {
    const actual = rows.filter(row => row.role === role);
    const expected = role === "child" ? [childId] : identity[role].ids;
    assert.deepEqual([...new Set(actual.map(row => row.requestId))], expected, `Exact actual provider requests for ${role}`);
    if (role === "lane") assert(actual.every(row => row.pid === identity.lane.pid), "The same resident lane must serve these requests");
    if (role === "head") {
      const reopenIndex = expected.indexOf(mentorUpdate.id);
      assert(reopenIndex > 0);
      assert(actual.every(row => row.pid === (expected.indexOf(row.requestId) < reopenIndex
        ? identity.head.beforeReopen : identity.head.pid)), "The expected native controller must own each HEAD request");
    }
  }
  // An update executes inside a run; it cannot replace that run's admitted voice.
  const baseline = new Set([oldHead.id, opening.id, `report:${opened}`, oldLane, editorUpdate.id]);
  const editorPhase = new Set([editorHead.id, editorLane, oneOff.id, mentorUpdate.id]);
  const silent = new Set([opened, manager, steer, childId]);
  const topicReplies = new Set([oldLane, editorLane, mentorLane]);
  for (const row of rows) {
    const label = `${row.role}/${row.requestId}`;
    const suppressed = silent.has(row.requestId);
    const revision = baseline.has(row.requestId) ? 0 : editorPhase.has(row.requestId) ? 1 : 2;
    assert.deepEqual(row.voiceTags, suppressed ? [0, 0] : [1, 1], `${label}: exact system prompt voice tag count`);
    assert.deepEqual(row.voice, suppressed ? [] : [voiceByRevision[revision]], `${label}: provider payload at revision ${revision}`);
    if (row.role === "lane") {
      assert.equal(row.mode, topicReplies.has(row.requestId) ? "topic reply" : "manager handoff", label);
      assert.equal(row.steering, row.requestId === steer, label);
    }
    if (row.role !== "child") assert.equal(row.headContract, row.role === "head", `${label}: HEAD contract scope`);
    if (row.role !== "head") assert.deepEqual(row.managerTools, [], `${label}: HEAD authority must not cross roles`);
    const explicit = row.requestId === workflow.id;
    assert.equal(row.policyCount, explicit ? 1 : 0, `${label}: SUPER policy scope is unchanged`);
  }
}
