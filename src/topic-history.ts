// allow: SIZE_OK — This API owns one bounded retrieval boundary; the journal provenance checks
// and task/checkpoint selection must travel together in the requested single source module.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { resolveSessionLeafId, type SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { parseSessionContent } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import type { Lane } from "./contracts";
import { parseLaneReportResult } from "./lane-report";

export interface TopicMatch {
  readonly laneId: string;
  readonly entryId: string;
  readonly at: number;
  readonly evidence: string;
}

const MAX_QUERY = 4096;
const MAX_FIELD = 8192;
const MAX_ENVELOPE = 64 * 1024;
const MAX_JOURNAL = 16 * 1024 * 1024;
const MAX_SEARCH = 64 * 1024 * 1024;
const EXCERPT = 480;
const CHECKPOINT = 320;
const MAX_RECALL_ITEMS = 10;
const ALIAS_ANCHOR = [2] as const;
const SEMANTIC_ANCHOR = [5] as const;
const RECALL_ANCHORS = [...ALIAS_ANCHOR, ...SEMANTIC_ANCHOR] as const;
const DAY = 86_400_000;
const nativeId = /^[\w-]{1,128}$/;
const lastWeek = /\blast week\b|지난\s*주/giu;
const lastMonth = /\blast month\b|지난\s*달|저번\s*달/giu;
const yesterday = /\byesterday\b|어제/giu;
const timePhrases = [lastWeek, lastMonth, yesterday] as const;
const enPast = /\b(?:earlier|previously|before|last time|the other day|from before|where (?:we|you|i) left off|(?:we|you|i) (?:were|had been|worked on|started|looked at|investigated))\b/giu;
const enResume = /\b(?:resume|pick (?:back )?up|go back to|return to|carry on with|continue|pick(?= .{1,120}\bback up\b)|back up)\b/giu;
const enLead = /(?:^|[.!?,]\s+)(?:(?:please|can you|could you|would you|let['’]s)\s+)*(?:resume|pick|go back to|return to|carry on with|continue)\b/iu;
const koPast = /지난\s*(?:번|주|달)|저번(?:에|주|달)?|이전(?:에)?|예전(?:에)?|그때|아까|어제|(?:하|보|고치|잡|찾|다루|만들|살펴보|해보)던|(?:했|봤|다뤘|고쳤|만들었)던|하던\s*데서|보던\s*데서/gu;
const koResume = /계속(?:해서|해\s*줘|해줘|해|하|봐\s*줘|봐줘|봐)?|이어서|이어\s*(?:서|가|해\s*줘|해줘|해|봐\s*줘|봐줘|봐)|재개(?:해\s*줘|해줘|해|하)?|마저/gu;
const inlineQuotes = /"[^"\r\n]*"|“[^”\r\n]*”|‘[^’\r\n]*’|(?<![\p{L}\p{N}])'[^'\r\n]*'|`[^`\r\n]*`/gu;
const ignored = new Set(`a about again also an and as at back be by can could current day did do for from had have how i in is it last left let me month my of off old on original or our please prior previous same so stuff task that the then there thing this time to topic up us was we were what when where which will with work worked working would you your look looking investigation investigate check track tracking handle tell thanks
거 걸 것 그 그거 그거를 거기 거기서 거기부터 이거 저거 나 네 다시 다음 데 데서 도 좀 뒤 때 에서 요 여기 이 일 일단 작업 저 제 중 지금 처음 해 하던 해줘 해주세요 봐 봐줘 봐주세요 주세요 처리 처리해 처리해줘 처리해주세요 진행해 진행해줘 진행해주세요 확인해줘 확인해주세요 확인 진행 검토 조사 부탁 과제 관련 부터 까지 보던 봤던 들던 했던 계속 이어서 이어 재개 마저
ulw ultrawork mass jevify orchestrate workflowz ultrathink`.split(/\s+/));
const categories = new Set(["bug", "test", "feature", "migration", "change", "inspection", "review", "analysis", "incident"]);
const recallBoilerplate = new Set(`action agent app assistant authorized build call change code complete confirm context continue conversation current data default detail discuss docs evidence execute file follow help history implement information input journal label lane latest mean memory message model native need nickname note output owner past pending private proceed project prompt record recall recent remember repetition report repo repository request result resume route run search session source standard start status step summary superagent support update use user verify workspace
결과 계속 기록 내용 대화 메시지 메모 모델 문서 변경 요약 확인 요청 자료 이전 정보 진행 설정 세션 사용자 작업 작업공간 저장소 참고 관련 기본 완료 반복 이어서 재개 워크스페이스`.split(/\s+/));
const aliases = new Map([
  ["로그인", "login"], ["signin", "login"], ["로그아웃", "logout"], ["인증", "authentication"], ["auth", "authentication"],
  ["버그", "bug"], ["문제", "bug"], ["오류", "bug"], ["에러", "bug"], ["issue", "bug"],
  ["error", "bug"], ["failure", "bug"], ["fail", "bug"], ["broken", "bug"], ["break", "bug"], ["fix", "bug"], ["fixe", "bug"], ["fixed", "bug"],
  ["regression", "bug"], ["crash", "bug"], ["debug", "bug"],
  ["테스트", "test"], ["기능", "feature"], ["마이그레이션", "migration"],
  ["리다이렉트", "redirect"], ["리디렉션", "redirect"], ["리다이렉션", "redirect"], ["redirection", "redirect"],
]);

/** Exclude pasted blocks and quote lines, not inline names of the task. */
function directText(text: string): string {
  let fence = "";
  return text.split(/\r?\n/).filter(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1].startsWith(fence) && !marker[2].trim()) fence = "";
      return false;
    }
    if (marker) { fence = marker[1]; return false; }
    return !/^ {0,3}>/.test(line);
  }).join("\n");
}

function wordTokens(text: string): readonly string[] {
  const tokens = text.normalize("NFKC").toLowerCase().replace(/\b(?:sign|log)[ -]in\b/g, "login")
    .match(/[a-z][a-z0-9_]*|[0-9]{3,}|[\p{Script=Hangul}]+/gu) ?? [];
  return tokens.flatMap(token => {
    const stem = token.replace(/^([\p{Script=Hangul}]{2,})(?:에서부터|에서는|부터|에서|으로|처럼|까지|하고|이랑|만|의|은|는|이|가|을|를|에|도)$/u, "$1")
      .replace(/^([a-z]{4,})(?:ing|ed|(?<![isu])s)$/, "$1");
    const word = aliases.get(stem) ?? stem;
    return word.length > 1 && word.length <= 64 && !ignored.has(word) ? [word] : [];
  });
}

function words(text: string): Set<string> {
  return new Set(wordTokens(text));
}

function matchingExcerpt(text: string, terms: ReadonlySet<string>): string {
  // Match anchors in a single bounded piece of useful context, not across unrelated
  // paragraphs of a transcript, and return the actual grounded detail around them.
  for (const excerpt of excerptWindows(text)) {
    const seen = words(excerpt);
    if ([...terms].every(word => seen.has(word))) return excerpt;
  }
  return "";
}

function* excerptWindows(text: string): Iterable<string> {
  const clean = visibleLine(text, MAX_FIELD);
  for (let start = 0; start < clean.length; start += EXCERPT / 2) {
    yield clean.slice(start, start + EXCERPT).trim();
    if (start + EXCERPT >= clean.length) break;
  }
}

function visibleLine(text: string, limit: number): string {
  return directText(text.slice(0, limit)).replace(/[\s\p{Cc}\p{Cf}]+/gu, " ").trim();
}

function request(text: string) {
  if (text.length > MAX_QUERY) return null;
  const clean = directText(text).normalize("NFKC").trim();
  const intent = clean.replace(inlineQuotes, '""');
  if (!intent || intent.startsWith("/") || /\b(?:do not|don['’]t|never|not)\s+(?:resume|continue|go back|pick up)\b|(?:계속하|재개하|이어서 하)지\s*마|(?:말고|대신)\s*(?:새|다른)/iu.test(intent)) return null;
  const en = intent.match(enResume) ?? [];
  const historical = [...timePhrases, enPast, koPast].some(pattern => intent.match(pattern));
  const qualifiedEnglish = en.some(verb => !/^continue$/i.test(verb))
    || /^(?:(?:please|can you|could you|would you)\s+)*continue\s+(?:work(?:ing)? on|the|our|that)\b/i.test(intent);
  if (!(en.length && enLead.test(intent) && (qualifiedEnglish || historical)
    || intent.match(koResume) && (historical || /이어서|이어\s*(?:가|해|봐)|재개|마저/u.test(intent)))) return null;
  const subject = clean.split(/(?:\b(?:and (?:then|also|add|check|fix|verify|run)|then)\b|[.!?]\s+|\n{2,})/iu, 1)[0];
  const terms = words([...timePhrases, enPast, enResume, koPast, koResume]
    .reduce((value, pattern) => value.replace(pattern, " "), subject));
  return terms.size <= 16 && [...terms].some(word => !categories.has(word)) ? { terms, intent, subject: subject.trim() } : null;
}

export function refersToPastTopic(text: string): boolean {
  return request(text) !== null;
}

/** Send only the owner's historical subject to native memory, in its original language. */
export function pastTopicQuery(text: string): string | null {
  return request(text)?.subject ?? null;
}

type RecallItem = { readonly content: string; readonly id?: string; readonly source?: string };

function concreteTerm(word: string): boolean {
  return !categories.has(word) && !recallBoilerplate.has(word) && /^(?:[a-z]{4,}|[\p{Script=Hangul}]{2,})$/u.test(word);
}

function* concretePhrases(text: string, lengths: readonly number[]): Iterable<readonly string[]> {
  for (const clause of text.split(/\n+|[.!?。;:](?:\s|$)/u)) {
    // Remove identifiers as units: splitting e.g. CASE-308 into words would
    // promote coincident identifiers to apparently independent anchors.
    const tokens = wordTokens(clause.normalize("NFKC").replace(/\b(?:[\w-]*\d[\w-]*|[a-f]{8,})\b/gi, " ")).filter(concreteTerm);
    for (const length of lengths) {
      for (let start = 0; start + length <= tokens.length; start++) {
        const phrase = tokens.slice(start, start + length);
        if (phrase.every((word, index) => phrase.indexOf(word) === index)) yield phrase;
      }
    }
  }
}

function recallAnchors(terms: ReadonlySet<string>, items: readonly RecallItem[]): ReadonlySet<string> {
  const anchors = new Set<string>();
  const subject = [...terms].filter(concreteTerm);
  if (!subject.length) return anchors;
  // Exact query terms can establish a nickname bridge within one memory passage.
  // Otherwise native semantic search can suggest a turn only with much stronger
  // corroboration: a substantial ordered phrase independently present in its journal.
  for (const { content } of items) {
    for (const paragraph of directText(content).split(/\n\s*\n/)) {
      for (const phrase of concretePhrases(paragraph, SEMANTIC_ANCHOR)) anchors.add(phrase.join(" "));
      for (const excerpt of excerptWindows(paragraph)) {
        const seen = words(excerpt);
        if (!subject.every(word => seen.has(word))) continue;
        for (const phrase of concretePhrases(excerpt, ALIAS_ANCHOR)) {
          if (phrase.some(word => !terms.has(word))) anchors.add(phrase.join(" "));
        }
      }
    }
  }
  return anchors;
}

function recalledExcerpt(task: string, anchors: ReadonlySet<string>): string {
  if (!anchors.size) return "";
  // Check the phrase in the original owner lines as well as in the rendered
  // excerpt, where line breaks are collapsed.
  const grounded = new Set<string>();
  for (const phrase of concretePhrases(task.replace(inlineQuotes, "\n"), RECALL_ANCHORS)) {
    const key = phrase.join(" ");
    if (anchors.has(key)) grounded.add(key);
  }
  if (!grounded.size) return "";
  for (const excerpt of excerptWindows(task)) {
    for (const phrase of concretePhrases(excerpt, RECALL_ANCHORS)) {
      if (grounded.has(phrase.join(" "))) return excerpt;
    }
  }
  return "";
}

/** Relative calendar phrases use UTC because a messenger route has no owner timezone. */
function dateWindow(intent: string, receivedAt: number): readonly [number, number] | null {
  const now = new Date(receivedAt);
  if (!Number.isFinite(now.getTime())) return null;
  const today = now.getTime() - (now.getUTCHours() * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds()) * 1000 - now.getUTCMilliseconds();
  const dates: (readonly [number, number])[] = [];
  if (intent.match(yesterday)) dates.push([today - DAY, today]);
  if (intent.match(lastWeek)) {
    const monday = today - (now.getUTCDay() + 6) % 7 * DAY;
    dates.push([monday - 7 * DAY, monday]);
  }
  if (intent.match(lastMonth)) dates.push([
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1), Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  ]);
  if (dates.length > 1) return null;
  return dates[0] ?? [0, receivedAt + 1];
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function promptText(content: unknown): string {
  if (typeof content === "string") return content.length <= MAX_ENVELOPE ? content : "";
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content.slice(0, 32)) {
    if (!record(block) || block.type !== "text" || typeof block.text !== "string") continue;
    if (text.length + block.text.length >= MAX_ENVELOPE) return "";
    text += `${text ? "\n" : ""}${block.text}`;
  }
  return text;
}

/** OMP journals the RPC completion ID; the fenced request identifies its input. */
function requestDigest(raw: string, lane: Lane): string | undefined {
  const headers = [...raw.matchAll(/^(`{3,})superagent-runtime-context\nRequest ID: ([^\r\n]{1,512})\n/gm)]
    .sort((a, b) => b[1].length - a[1].length);
  const header = headers[0];
  if (!header || headers[1]?.[1].length === header[1].length) return;
  const scope = raw.slice(header.index + header[0].length, header.index + header[0].length + 4096).split("\n", 12);
  if (scope.includes(`Independent lane ${lane.id}; cwd: ${lane.cwd}`)) {
    // Same request identity used by runtime's prompt submission, excluding generation.
    return createHash("sha256").update(header[2]).digest("hex").slice(0, 24);
  }
}

function completedRequest(data: unknown, lane: Lane, digest: string): boolean {
  if (!record(data) || data.sessionId !== lane.sessionId || data.sessionFile !== lane.sessionFile || !record(data.frame)) return false;
  const { id, type, status, agentInvoked } = data.frame;
  if (typeof id !== "string" || !id.startsWith(`sg-${digest}-`)) return false;
  const generation = id.slice(digest.length + 4);
  return /^[1-9]\d{0,9}$/.test(generation) && Number(generation) <= lane.generation
    && type === "prompt_result" && status === "completed" && agentInvoked === true;
}

function activeBranch(entries: readonly SessionEntry[]): readonly SessionEntry[] {
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  if (byId.size !== entries.length) return [];
  let id = resolveSessionLeafId(entries);
  const path: SessionEntry[] = [];
  while (id !== null) {
    const entry = byId.get(id);
    if (!entry) return [];
    if (entry.type === "reset_boundary") break;
    path.push(entry);
    byId.delete(id); // A repeated active ancestor is a corrupt cycle.
    id = entry.parentId;
  }
  return path.reverse();
}

/** Reuse OMP's title-slot aware parser and leaf replay without opening an OMP session. */
async function readJournal(lane: Lane, budget: { remaining: number }): Promise<readonly SessionEntry[] | null> {
  if (lane.remote || !lane.sessionId || !/^[\w-]+$/.test(lane.id) || lane.id === "main" || !isAbsolute(lane.cwd) || normalize(lane.cwd) !== lane.cwd) return [];
  const root = dirname(dirname(lane.socketPath));
  const parts = ["sessions", lane.id, "session.jsonl"] as const;
  if (!isAbsolute(root) || lane.socketPath !== join(root, "run", `${lane.id}.sock`) || lane.sessionFile !== join(root, ...parts)) return [];
  try {
    const expected = join(await realpath(root), ...parts);
    if (await realpath(lane.sessionFile) !== expected) return [];
    const initial = await lstat(lane.sessionFile, { bigint: true });
    if (!initial.isFile() || initial.nlink !== 1n) return [];
    const file = await open(lane.sessionFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await file.stat({ bigint: true });
      if (!before.isFile() || before.dev !== initial.dev || before.ino !== initial.ino || before.nlink !== 1n
        || (process.getuid && before.uid !== BigInt(process.getuid()))) return [];
      if (before.size > MAX_JOURNAL) return null;
      if (before.size === 0n) return [];
      const size = Number(before.size);
      if (size > budget.remaining) return null;
      budget.remaining -= size;
      const buffer = Buffer.alloc(size);
      for (let offset = 0; offset < size;) {
        const { bytesRead } = await file.read(buffer, offset, size - offset, offset);
        if (!bytesRead) return [];
        offset += bytesRead;
      }
      const after = await lstat(lane.sessionFile, { bigint: true });
      if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino || after.nlink !== before.nlink
        || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs
        || await realpath(lane.sessionFile) !== expected || buffer.at(-1) !== 10) return [];
      const { entries, invalidHeader, malformedRecords } = parseSessionContent(buffer.toString("utf8"));
      const [header, ...body] = entries;
      if (invalidHeader || malformedRecords || !record(header) || header.type !== "session" || header.id !== lane.sessionId
        || header.cwd !== lane.cwd) return [];
      const branch = body.filter((entry): entry is SessionEntry => record(entry) && typeof entry.type === "string" && entry.type !== "session"
        && typeof entry.id === "string" && nativeId.test(entry.id) && (entry.parentId === null || typeof entry.parentId === "string")
        && (entry.activeLeafId === undefined || entry.activeLeafId === null || typeof entry.activeLeafId === "string"));
      return branch.length === body.length ? activeBranch(branch) : [];
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error instanceof Error && "code" in error) return []; // Missing, unreadable or replaced journal.
    throw error;
  }
}

type Checkpoint = { readonly id: string; readonly at: number; readonly text: string };
type MatchedTurn = {
  readonly id: string;
  readonly at: number;
  readonly excerpts: readonly [string, ...string[]];
  readonly direct: boolean;
  readonly digest: string | undefined;
  proposed?: Checkpoint;
  checkpoint?: Checkpoint;
  summaryInWindow?: boolean;
  receiptSeen?: boolean;
};

type TopicQuery = {
  readonly terms: ReadonlySet<string>;
  readonly window: readonly [number, number];
  readonly receivedAt: number;
};

type TopicSelection = { readonly anchors: ReadonlySet<string> } | { readonly entryId: string };
type JournalQuery = TopicQuery & { readonly selection: TopicSelection };

function topicQuery(text: string, receivedAt: number): TopicQuery | null {
  const query = request(text);
  const window = query && dateWindow(query.intent, receivedAt);
  return query && window ? { terms: query.terms, window, receivedAt } : null;
}

function matchJournal(entries: readonly SessionEntry[], lane: Lane, query: JournalQuery): readonly MatchedTurn[] {
  const matches: MatchedTurn[] = [];
  const within = (at: number | undefined) => at !== undefined && at >= query.window[0] && at < query.window[1];
  const { selection } = query;
  let current: MatchedTurn | undefined;
  for (const entry of entries) {
    const at = typeof entry.timestamp === "string" && entry.timestamp.length <= 40 ? Date.parse(entry.timestamp) : NaN;
    const user = entry.type === "message" && record(entry.message) && entry.message.role === "user" ? entry.message : null;
    // Any later native user turn ends the previous request's checkpoint scope,
    // even when its content or date is not usable as evidence.
    if (user) current = undefined;
    if (!Number.isFinite(at) || at < 0 || at > query.receivedAt) continue;
    if (user) {
      if ("entryId" in selection && entry.id !== selection.entryId) continue;
      if (user.synthetic === true || user.parentIrc || user.attribution === "agent") continue;
      const raw = promptText(user.content);
      const task = directText(raw).trim().slice(0, MAX_FIELD);
      if (refersToPastTopic(task.slice(0, MAX_QUERY))) continue; // Prior continuation echoes are not independent task evidence.
      const direct = matchingExcerpt(task, query.terms);
      const [excerpt, ...alternates] = direct ? [direct] : "entryId" in selection ? [...excerptWindows(task)]
        : [recalledExcerpt(task, selection.anchors)];
      if (excerpt) {
        current = { id: entry.id, at, excerpts: [excerpt, ...alternates], direct: !!direct, digest: requestDigest(raw, lane) };
        matches.push(current);
      }
    } else if (current && entry.type === "custom") {
      if (entry.customType === "rpc_prompt_result" && !current.receiptSeen) {
        current.receiptSeen = true;
        if (current.digest && current.proposed && completedRequest(entry.data, lane, current.digest)) {
          current.checkpoint = current.proposed;
        }
      } else if (entry.customType === "superagent-lane-report" && current.digest && !current.receiptSeen) {
        const event = parseLaneReportResult({ details: entry.data });
        if (event?.sessionId === lane.sessionId && event.report.status !== "waiting") {
          const text = visibleLine(event.report.summary, MAX_FIELD).slice(0, CHECKPOINT);
          if (text) current.proposed = { id: entry.id, at, text };
        }
      }
    } else if (current?.direct && within(at) && (entry.type === "compaction" || entry.type === "branch_summary")
      && typeof entry.summary === "string" && matchingExcerpt(entry.summary, query.terms)) {
      current.summaryInWindow = true;
    }
  }
  return matches.filter(turn => within(turn.at) || within(turn.checkpoint?.at) || turn.summaryInWindow);
}

function topicMatch(lane: Lane, turn: MatchedTurn, excerpt: string): TopicMatch {
  const date = new Date(turn.at).toISOString().slice(0, 10);
  const checkpoint = turn.checkpoint
    ? `\nVerified native checkpoint (entry ${turn.checkpoint.id}, ${new Date(turn.checkpoint.at).toISOString().slice(0, 10)} UTC): ${turn.checkpoint.text}`
    : "";
  const evidence = `Owner task (entry ${turn.id}, ${date} UTC): ${excerpt}${checkpoint}`;
  return { laneId: lane.id, entryId: turn.id, at: turn.at, evidence };
}

/** Search only caller-scoped managed lanes. Journal evidence is data, never instructions. */
export async function findPastTopic(text: string, lanes: readonly Lane[], receivedAt: number,
  recallItems: readonly RecallItem[] = []): Promise<readonly TopicMatch[]> {
  const query = topicQuery(text, receivedAt);
  // Do not claim uniqueness from an incomplete set of hints.
  if (!query || recallItems.length > MAX_RECALL_ITEMS || recallItems.some(item => item.content.length > MAX_FIELD)) return [];
  const selection = { anchors: recallAnchors(query.terms, recallItems) };
  const matches = new Map<string, TopicMatch>();
  const budget = { remaining: MAX_SEARCH };
  for (const lane of lanes) {
    const entries = await readJournal(lane, budget);
    if (entries === null) return []; // Incomplete search cannot establish uniqueness.
    for (const turn of matchJournal(entries, lane, { ...query, selection })) {
      matches.set(JSON.stringify([lane.id, lane.sessionId, turn.id]), topicMatch(lane, turn, turn.excerpts[0]));
    }
  }
  return [...matches.values()];
}

/** Revalidate an admitted evidence pin against its exact active journal entry, without recall. */
export async function readPastTopic(text: string, lane: Lane, receivedAt: number, entryId: string,
  evidenceHash: string): Promise<TopicMatch | null> {
  const query = topicQuery(text, receivedAt);
  if (!query || !nativeId.test(entryId) || !/^[a-f0-9]{64}$/.test(evidenceHash)) return null;
  const entries = await readJournal(lane, { remaining: MAX_SEARCH });
  if (entries === null) return null;
  for (const turn of matchJournal(entries, lane, { ...query, selection: { entryId } })) {
    for (const excerpt of turn.excerpts) {
      const match = topicMatch(lane, turn, excerpt);
      if (createHash("sha256").update(match.evidence).digest("hex") === evidenceHash) return match;
    }
  }
  return null;
}
