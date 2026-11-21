import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, realpath, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CURRENT_SESSION_VERSION, type SessionEntry, type SessionHeader, type SessionMessageEntry }
  from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import type { Lane } from "../src/contracts";
import { findPastTopic, pastTopicQuery, readPastTopic, refersToPastTopic } from "../src/topic-history";
import { workflowContext } from "../src/workflow";

const rootPaths: string[] = [];
const receivedAt = Date.parse("2026-11-18T12:00:00Z");
const lastWeek = "2026-11-12T14:00:00.000Z";
const thisWeek = "2026-11-17T14:00:00.000Z";
const korean = "지난주 로그인 버그 보던 데서 계속해줘";
const english = "Pick the login bug back up.";

afterEach(async () => {
  for (const root of rootPaths.splice(0)) await rm(root, { force: true, recursive: true });
});

async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), "sa-history-"));
  rootPaths.push(root);
  const cwd = join(root, "workspace");
  await mkdir(cwd);
  return (id: string): Lane => ({
    id, cwd, repoRoot: null, title: "Generic lane title", brief: "Generic brief", acceptance: [],
    route: { platform: "discord", accountId: "bot", authorityId: "owner", guildId: null, channelId: id, threadId: null },
    model: null, modelReason: null, modelPreset: null, modelPresetSnapshot: null, workState: "open", runtimeState: "unloaded",
    sessionFile: join(root, "sessions", id, "session.jsonl"), sessionId: `native-${id}`,
    socketPath: join(root, "run", `${id}.sock`), generation: 1, pid: null, createdAt: Date.parse(lastWeek),
    lastActivityAt: Date.parse(thisWeek), result: null,
  });
}

function prompt(text: string, timestamp = lastWeek, id = "owner-turn", parentId: string | null = null): SessionMessageEntry {
  return { type: "message", id, parentId, timestamp,
    message: { role: "user", content: [{ type: "text", text }], timestamp: Date.parse(timestamp) } };
}

async function writeJournal(lane: Lane, entries: readonly SessionEntry[]): Promise<void> {
  await mkdir(dirname(lane.sessionFile), { recursive: true });
  if (!lane.sessionId) throw new Error("A journal fixture needs a session ID");
  const header: SessionHeader = { type: "session", version: CURRENT_SESSION_VERSION,
    id: lane.sessionId, cwd: lane.cwd, timestamp: lastWeek };
  const titleSlot = serializeTitleSlot({ title: lane.title, updatedAt: thisWeek });
  await writeFile(lane.sessionFile, titleSlot + [header, ...entries].map(entry => JSON.stringify(entry)).join("\n") + "\n");
}

test.each([
  [korean, true],
  ["이전에 작업하던 로그인 인증 버그를 이어서 처리해줘.", true],
  ["저번에 보던 로그인 문제부터 마저 봐줘.", true],
  ["Can you resume the OAuth redirect investigation from last week?", true],
  [english, true],
  ["Continue working on the credential rotation.", true],
  ["Continue.", false],
  ["Continue the original inspection", false],
  ["Let's resume that old thing.", false],
  ["Please continue running the smoke suite.", false],
  ["Run the tests we wrote last week.", false],
  ["지난주에 만들어둔 로그인 테스트를 지금 실행해 줘.", false],
  ["거기서 이어서 해줘.", false],
  ["그거 계속해줘.", false],
  ["Don't resume the login bug from last week.", false],
  ["Explain what 'resume the login bug from last week' means.", false],
  ["> 지난주 로그인 버그 보던 데서 계속해줘\n새 결제 기능을 구현해줘.", false],
] as const)("routes only a described retrospective continuation: %s", (input, expected) => {
  expect(refersToPastTopic(input)).toBe(expected);
});

test("native recall receives the original topical clause, not quoted or unrelated follow-up text", () => {
  const text = `> 실제 요청이 아닌 인용 답변\n${korean}\n\n${workflowContext("Private route data")}\n\n별도로 결제 테스트를 돌려줘.`;

  expect(pastTopicQuery(text)).toBe(korean);
});

test("retrieves a dated Korean subject from a stock owner turn with no workspace terms", async () => {
  const makeLane = await fixture();
  const matching = makeLane("older-branch");
  const newer = makeLane("newer-branch");
  const other = makeLane("other-work");
  await writeJournal(matching, [prompt("Investigate the sign-in failure. The broken callback is /auth/canary-309.")]);
  await writeJournal(newer, [prompt("Fix the login bug on the mobile login screen.", thisWeek)]);
  await writeJournal(other, [prompt("Add login controls to the settings panel.")]);

  const results = await findPastTopic(korean, [newer, other, matching], receivedAt);

  expect(results.map(match => match.laneId)).toEqual([matching.id]);
  expect(results[0]?.evidence).toContain("2026-11-12");
  expect(results[0]?.evidence).toContain("/auth/canary-309");
});

test("preserves ambiguity rather than breaking ties by recency or by supplied order", async () => {
  const makeLane = await fixture();
  const first = makeLane("a");
  const second = makeLane("b");
  await writeJournal(first, [prompt("Investigate the login bug in the staging callback framing.")]);
  await writeJournal(second, [prompt("Fix the login bug in the browser credential cache.", thisWeek)]);

  const matches = await findPastTopic(english, [second, first], receivedAt);

  expect(new Set(matches.map(match => match.laneId))).toEqual(new Set([first.id, second.id]));
});

const nicknameQuery = "지난주 보던 보라색 회전문을 이어서 봐줘.";
const nicknameRecall = {
  content: "보라색 회전문 means the rotating credential cache. Memory-only marker: mnemo-private.",
};

test("a bilingual memory can name a historical turn but is never returned as evidence", async () => {
  const lane = (await fixture())("credential-cache");
  await writeJournal(lane, [prompt("Investigate the rotating credential cache on sign-out.")]);

  expect(await findPastTopic(nicknameQuery, [lane], receivedAt)).toEqual([]);
  const matches = await findPastTopic(nicknameQuery, [lane], receivedAt, [nicknameRecall]);

  expect(matches.map(({ laneId, entryId, at }) => ({ laneId, entryId, at }))).toEqual([
    { laneId: lane.id, entryId: "owner-turn", at: Date.parse(lastWeek) },
  ]);
  expect(matches[0]?.evidence).toContain("rotating credential cache on sign-out");
  expect(matches[0]?.evidence).not.toContain("mnemo-private");
  expect(matches[0]?.evidence).not.toContain("보라색 회전문");
});

test("a lexically disjoint native recall can identify a journal turn through a distinctive shared passage", async () => {
  const lane = (await fixture())("semantic-certificate");
  const passage = "Diagnose intermittent certificate revocation during encrypted gateway negotiation.";
  await writeJournal(lane, [prompt(passage)]);
  const query = "지난주 보던 접속 끊김을 이어서 봐줘.";

  expect(await findPastTopic(query, [lane], receivedAt)).toEqual([]);
  const matches = await findPastTopic(query, [lane], receivedAt, [{ content: `${passage}\n\nPrivate memory alias: hidden-slate.` }]);

  expect(matches.map(match => match.laneId)).toEqual([lane.id]);
  expect(matches[0]?.evidence).toContain(passage);
  expect(matches[0]?.evidence).not.toContain("hidden-slate");
});

test("a legacy direct evidence hash still reopens its native owner entry", async () => {
  const lane = (await fixture())("previous-pin");
  const task = "Investigate the login bug in the clipboard handler.";
  await writeJournal(lane, [prompt(task)]);
  // This byte format was persisted before recall-assisted selection existed.
  const evidence = `Owner task (entry owner-turn, 2026-11-12 UTC): ${task}`;
  const digest = createHash("sha256").update(evidence).digest("hex");

  const actual = await readPastTopic(english, lane, receivedAt, "owner-turn", digest);

  expect(actual).toEqual({ laneId: lane.id, entryId: "owner-turn", at: Date.parse(lastWeek), evidence });
});

test("a direct candidate does not hide an independently grounded recall candidate", async () => {
  const makeLane = await fixture();
  const direct = makeLane("named-directly");
  const recalled = makeLane("named-by-memory");
  await writeJournal(direct, [prompt("보라색 회전문 상태를 점검해줘. The rotating credential cache may be affected.")]);
  await writeJournal(recalled, [prompt("Reproduce stale results in the rotating credential cache.")]);

  const matches = await findPastTopic(nicknameQuery, [direct, recalled], receivedAt, [nicknameRecall, nicknameRecall]);

  expect(matches.map(match => match.laneId)).toEqual([direct.id, recalled.id]);
});

test.each([
  ["no independent owner phrase", "Check invoice rounding after adjustment.", nicknameRecall],
  ["recall not about the query", "Investigate the rotating credential cache.", {
    content: "A recall about old authentication work: investigate the rotating credential cache.",
  }],
  ["one shared term, even repeatedly", "Inspect credential credential credential repair.", {
    content: "보라색 회전문 means credential credential credential.",
  }],
  ["terms never used together in the owner task", "Inspect the rotating adapter. Rewrite credential serialization.", {
    content: "보라색 회전문 means rotating credential.",
  }],
  ["shared generic descriptions", "Review the latest workspace context and the native owner journal.", {
    content: "보라색 회전문 means workspace context and the native owner journal.",
  }],
  ["shared IDs alone", "Handle ticket CAPTURE-3984 and REJECTION-2190.", {
    id: "owner-turn", source: "native-owner-turn", content: "보라색 회전문 means CAPTURE-3984 and REJECTION-2190.",
  }],
  ["query and anchoring details in separate passages", "Investigate the rotating credential cache.", {
    content: "The phrase is 보라색 회전문.\n\nUnrelated history: investigate the rotating credential cache.",
  }],
  ["quoted recall evidence", "Investigate the rotating credential cache.", {
    content: "The phrase is 보라색 회전문.\n> The rotating credential cache is stuck.",
  }],
  ["quoted native evidence", "Check billing rules.\n> Investigate the rotating credential cache.", nicknameRecall],
  ["an inline quotation instead of owner evidence", 'Translate "Investigate the rotating credential cache" into German.', nicknameRecall],
  ["a long prior continuation echo",
    `Resume the original cache from last week.\n\nInvestigate the rotating credential cache.\n${"Available details. ".repeat(300)}`,
    nicknameRecall],
] as const)("abstains on native recall with %s", async (_kind, task, item) => {
  const lane = (await fixture())("guarded-phrase");
  await writeJournal(lane, [prompt(task)]);

  expect(await findPastTopic(nicknameQuery, [lane], receivedAt, [item])).toEqual([]);
});

test("recall does not authorize other journals, abandoned branches, or outside dates", async () => {
  const makeLane = await fixture();
  const foreign = makeLane("foreign-credentials");
  const abandoned = makeLane("abandoned-credentials");
  const outside = makeLane("outside-week");
  const task = "Investigate the rotating credential cache.";
  await writeJournal(foreign, [prompt(task)]);
  await writeJournal(abandoned, [
    prompt("Inspect context."),
    { ...prompt(task, lastWeek, "abandoned-entry", "owner-turn"), activeLeafId: "owner-turn" },
  ]);
  await writeJournal(outside, [prompt(task, thisWeek)]);

  const matches = await findPastTopic(nicknameQuery, [abandoned, outside], receivedAt, [
    { ...nicknameRecall, id: "owner-turn", source: foreign.sessionFile },
  ]);

  expect(matches).toEqual([]);
});

test("native recall includes the final default result but never selects with an incomplete hint set", async () => {
  const makeLane = await fixture();
  const first = makeLane("first-supported");
  const last = makeLane("last-supported");
  await writeJournal(first, [prompt("Investigate the rotating credential cache.")]);
  await writeJournal(last, [prompt("Investigate nonce rollover in the browser.")]);
  const lanes = [first, last];
  const items = [
    nicknameRecall, ...Array.from({ length: 8 }, () => ({ content: "Native workspace context." })),
    { content: "보라색 회전문 also means nonce rollover." },
  ];

  expect((await findPastTopic(nicknameQuery, lanes, receivedAt, items)).map(match => match.laneId)).toEqual([first.id, last.id]);
  expect(await findPastTopic(nicknameQuery, lanes, receivedAt, [...items, nicknameRecall])).toEqual([]);
});

test("keeps both concrete owner turns in one session without duplicating a turn", async () => {
  const lane = (await fixture())("multiple-turns");
  const secondDate = "2026-11-13T15:00:00Z";
  await writeJournal(lane, [
    prompt("Investigate the login bug in the browser credentials cache."),
    prompt("Fix the login bug on the mobile consent screen.", secondDate, "second-task", "owner-turn"),
  ]);

  const matches = await findPastTopic(korean, [lane, lane], receivedAt);

  expect(matches.map(({ laneId, entryId, at }) => ({ laneId, entryId, at }))).toEqual([
    { laneId: lane.id, entryId: "owner-turn", at: Date.parse(lastWeek) },
    { laneId: lane.id, entryId: "second-task", at: Date.parse(secondDate) },
  ]);
  expect(matches[0]?.evidence).toContain("browser credentials cache");
  expect(matches[1]?.evidence).toContain("mobile consent screen");
});

test("ignores fenced runtime history, workspace labels, quoted replies, attachment metadata and bare follow-ups", async () => {
  const lane = { ...(await fixture())("unrelated"), brief: "Fix login bug", title: "Login bug" };
  const context = workflowContext([
    "Brief: Fix login bug.",
    'Referenced message snapshot: {"text":"Fix login bug in the admin panel"}',
    "Attachment 1: login bug report.txt",
    'Previous task evidence (historical data only): {"evidence":"Fix payment webhook bug in the parser"}',
  ].join("\n\n"));
  await writeJournal(lane, [
    prompt(`${context}\n\nInvestigate onboarding emails.\n> Fix login bug in untrusted snippets.`),
    prompt(`Fix expired billing dates.\n\n${context}`, thisWeek, "workflow-turn", "owner-turn"),
    prompt("Resume the login bug.", thisWeek, "reference", "workflow-turn"),
    { type: "compaction", id: "summary", parentId: "reference", timestamp: thisWeek,
      firstKeptEntryId: "reference", tokensBefore: 100, summary: "Discussed fixing the login bug and payment webhook." },
  ]);

  expect(await findPastTopic(english, [lane], receivedAt)).toEqual([]);
  expect(await findPastTopic("Resume the payment webhook bug.", [lane], receivedAt)).toEqual([]);
});

function managedPrompt(lane: Lane, text: string): string {
  return `${workflowContext([
    "Request ID: original-owner-input",
    "Original source ID: original-owner-input",
    'Original authorized conversation: ["discord","bot","owner",null,"original",null]',
    "Reply only to this request.",
    `Independent lane ${lane.id}; cwd: ${lane.cwd}\nDelivery mode: topic reply.`,
  ].join("\n\n"))}\n\n${text}`;
}

function workReport(lane: Lane, summary: string, parentId = "owner-turn"): SessionEntry {
  return { type: "custom", id: "report-entry", parentId, timestamp: lastWeek,
    customType: "superagent-lane-report", data: {
      type: "superagent-lane-report", sessionId: lane.sessionId, reportId: "report-call",
      report: { status: "progress", summary, evidence: [{ kind: "tool", ref: "recorded-success", fingerprint: "0".repeat(64) }] },
    } };
}

function receipt(lane: Lane, request = "original-owner-input"): SessionEntry {
  const digest = createHash("sha256").update(request).digest("hex").slice(0, 24);
  return { type: "custom", id: "prompt-receipt", parentId: "report-entry", timestamp: lastWeek,
    customType: "rpc_prompt_result", data: { sessionId: lane.sessionId, sessionFile: lane.sessionFile,
      frame: { id: `sg-${digest}-${lane.generation}`, type: "prompt_result", status: "completed", agentInvoked: true } } };
}

test("adds an anchored same-request checkpoint during the requested week, without private quote text", async () => {
  const lane = (await fixture())("settled-work");
  const started = "2026-11-03T18:00:00Z";
  await writeJournal(lane, [
    prompt(managedPrompt(lane, "Fix the login bug on the nonce-bound credential callback."), started),
    workReport(lane, "Reproduced cookie rejection immediately after the nonce comparison.\n> incidental private token"),
    receipt(lane),
  ]);

  const matches = await findPastTopic(korean, [lane], receivedAt);

  expect(matches.map(match => match.laneId)).toEqual([lane.id]);
  expect(matches[0]?.evidence).toContain("nonce-bound credential callback");
  expect(matches[0]?.evidence).toContain("entry owner-turn");
  expect(matches[0]?.evidence).toContain("cookie rejection immediately after the nonce comparison");
  expect(matches[0]?.evidence).toContain("entry report-entry");
  expect(matches[0]?.evidence).not.toContain("incidental private token");
});

test.each(["unchanged", "owner rewritten", "receipt replaced", "checkpoint rewritten", "outside date", "inactive entry"] as const)(
  "a recall-assisted pin rereads only its dated active journal evidence: %s", async kind => {
    const lane = (await fixture())("recall-checkpoint");
    const started = "2026-11-03T18:00:00Z";
    const task = `${"Read the available notes. ".repeat(30)}Investigate the rotating credential cache nonce.`;
    const owner = prompt(managedPrompt(lane, task), started);
    const report = workReport(lane, "Reproduced nonce drift in staging.");
    const completion = receipt(lane);
    await writeJournal(lane, [owner, report, completion]);
    const [match] = await findPastTopic(nicknameQuery, [lane], receivedAt, [nicknameRecall]);
    if (!match) throw new Error("The original dated checkpoint needs a recall-assisted evidence pin");
    expect(match.evidence).toContain("rotating credential cache nonce");
    expect(match.evidence).toContain("Reproduced nonce drift in staging.");
    const evidenceHash = createHash("sha256").update(match.evidence).digest("hex");
    if (kind === "owner rewritten") {
      await writeJournal(lane, [prompt(managedPrompt(lane, task.replace("cache nonce", "cache expiry")), started), report, completion]);
    } else if (kind === "receipt replaced") {
      await writeJournal(lane, [owner, report, receipt(lane, "other-request")]);
    } else if (kind === "checkpoint rewritten") {
      await writeJournal(lane, [owner, workReport(lane, "Reproduced nonce drift in production."), completion]);
    } else if (kind === "outside date") {
      await writeJournal(lane, [owner, { ...report, timestamp: started }, completion]);
    } else if (kind === "inactive entry") {
      await writeJournal(lane, [owner, report, completion, prompt("Read the notes.", lastWeek, "other-root")]);
    }

    const actual = await readPastTopic(nicknameQuery, lane, receivedAt, match.entryId, evidenceHash);

    expect(actual).toEqual(kind === "unchanged" ? match : null);
  },
);

test.each(["other request", "other session", "later user turn", "later user turn with future timestamp"] as const)(
  "does not copy a report lacking exact turn ownership: %s", async kind => {
    const lane = (await fixture())("unbound-checkpoint");
    const later = kind.startsWith("later user turn")
      ? [prompt("Change invoice formatting.", kind === "later user turn" ? lastWeek : "2026-11-19T00:00:00Z",
        "different-turn", "owner-turn")] : [];
    await writeJournal(lane, [
      prompt(managedPrompt(lane, "Fix the login bug on the nonce-bound credential callback.")), ...later,
      workReport(kind === "other session" ? { ...lane, sessionId: "wrong-native-session" } : lane,
        "Wrong checkpoint must not cross.", later.at(-1)?.id ?? "owner-turn"),
      receipt(lane, kind === "other request" ? "another-runtime-input" : undefined),
    ]);

    const matches = await findPastTopic(english, [lane], receivedAt);

    expect(matches.map(match => match.laneId)).toEqual([lane.id]);
    expect(matches[0]?.evidence).not.toContain("Wrong checkpoint must not cross");
  },
);

test("uses an active native summary only to corroborate a known task's date, without copying summary text", async () => {
  const lane = (await fixture())("compacted-work");
  await writeJournal(lane, [
    prompt("Investigate the login bug in the sticky callback cache.", "2026-11-03T18:00:00Z"),
    { type: "compaction", id: "summary", parentId: "owner-turn", timestamp: lastWeek,
      firstKeptEntryId: "owner-turn", tokensBefore: 100, summary: "Login bug noted alongside an unrelated private marker." },
  ]);
  const matches = await findPastTopic(korean, [lane], receivedAt);

  expect(matches.map(match => match.laneId)).toEqual([lane.id]);
  expect(matches[0]?.evidence).toContain("sticky callback cache");
  expect(matches[0]?.evidence).not.toContain("unrelated private marker");
});

test("uses OMP's active leaf instead of abandoned branch contents or future work", async () => {
  const makeLane = await fixture();
  const abandoned = makeLane("abandoned");
  const future = makeLane("future");
  await writeJournal(abandoned, [
    prompt("Track server health."),
    prompt("Write monitoring docs.", lastWeek, "active-leaf", "owner-turn"),
    { ...prompt("Fix login bug in OAuth.", thisWeek, "off-branch", "owner-turn"), activeLeafId: "active-leaf" },
  ]);
  await writeJournal(future, [prompt("Investigate login bug.", "2026-11-19T00:00:00.000Z")]);

  expect(await findPastTopic(english, [abandoned, future], receivedAt)).toEqual([]);
});

test("will not read foreign coordinates, symlinks, hardlinks, or headers that disagree with the verified lane", async () => {
  const makeLane = await fixture();
  const secure = makeLane("secure");
  const aliased = makeLane("aliased");
  const linked = makeLane("linked");
  const wrongCwd = makeLane("changed-cwd");
  const wrongId = makeLane("changed-session");
  const misplaced = makeLane("wrong-path");
  const entry = prompt("Fix login bug in a credential callback.");
  await writeJournal(secure, [entry]);
  await writeJournal({ ...wrongCwd, cwd: join(wrongCwd.cwd, "..") }, [entry]);
  await writeJournal({ ...wrongId, sessionId: "not-the-lanes-session" }, [entry]);
  const elsewhere = join(dirname(dirname(dirname(misplaced.sessionFile))), "workspace", "other.jsonl");
  await writeJournal({ ...misplaced, sessionFile: elsewhere }, [entry]);
  await writeJournal({ ...aliased, sessionFile: `${elsewhere}.alias-target` }, [entry]);
  await writeJournal({ ...linked, sessionFile: `${elsewhere}.hardlink-target` }, [entry]);
  await mkdir(dirname(aliased.sessionFile), { recursive: true });
  await mkdir(dirname(linked.sessionFile), { recursive: true });
  await symlink(`${elsewhere}.alias-target`, aliased.sessionFile);
  await link(`${elsewhere}.hardlink-target`, linked.sessionFile);

  const matches = await findPastTopic(english,
    [wrongCwd, aliased, wrongId, { ...misplaced, sessionFile: elsewhere }, linked, secure], receivedAt);

  expect(matches.map(match => match.laneId)).toEqual([secure.id]);
});

test("abstains instead of claiming uniqueness when a plausible runner-up exceeds the journal bound", async () => {
  const makeLane = await fixture();
  const small = makeLane("small");
  const large = makeLane("large");
  await writeJournal(small, [prompt("Fix the login bug in the rotating credential cache.")]);
  await writeJournal(large, [prompt("Fix the login bug in the authorization cache.")]);
  await truncate(large.sessionFile, 32 * 1024 * 1024);

  expect(await findPastTopic(english, [small, large], receivedAt)).toEqual([]);
  expect(await findPastTopic(nicknameQuery, [small, large], receivedAt, [nicknameRecall])).toEqual([]);
});
