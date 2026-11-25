import { Type } from "@sinclair/typebox";
import type { Inbound, StorePort } from "./contracts";
import { ownerRoutingProse, transportRoutingProse } from "./topic-history";

const dimensions = {
  concept: {
    plain: "",
    editorial: "Use an editorial presentation: distill the relevant points and make distinctions precise within the requested format.",
    mentoring: "Use a mentoring presentation: make the reasoning easy to follow and use a concrete example when it fits the requested format.",
  },
  tone: {
    direct: "Be candid and matter-of-fact without being curt.",
    warm: "Sound warm and approachable without adding filler.",
    neutral: "Use a calm, neutral tone.",
  },
  register: {
    natural: "Match the operator's register.",
    formal: "Use a respectful, formal register (존댓말 in Korean).",
    casual: "Use a relaxed, conversational register.",
  },
  detail: {
    balanced: "Give the context needed to use the answer.",
    brief: "Keep the answer brief unless the operator asks for depth.",
    detailed: "Include relevant context and explanation.",
  },
  structure: {
    "answer-first": "Lead with the answer, result, or blocker.",
    "evidence-first": "Present the key evidence before the conclusion.",
    natural: "Organize the answer naturally for the question.",
  },
  emoji: {
    none: "Do not add decorative emoji.",
    light: "Use an occasional emoji only where it reads naturally.",
  },
} as const;

type Voice = { [D in keyof typeof dimensions]: keyof typeof dimensions[D] };
const requests = {
  concept: {
    plain: /\b(?:plain|no particular) (?:concept|persona|style)\b|컨셉\s*(?:없이|빼고)|기본\s*컨셉/u,
    editorial: /\b(?:like an? editor|editorial (?:voice|style|approach|concept)|editor(?:-like)? (?:voice|style|approach|concept))\b|(?:편집장|편집자|에디터)\s*(?:처럼|같이|같은|스타일|컨셉|콘셉트?|느낌|말투)/u,
    mentoring: /\b(?:like (?:a|my) (?:mentor|coach)|(?:mentor|coach)(?:-like|ing)? (?:voice|style|approach|concept))\b|(?:멘토|코치|(?:옆자리|옆에 있는|일 잘하는)\s*선배|선배)\s*(?:처럼|같이|같은|스타일|컨셉|콘셉트?|느낌|말투)/u,
  },
  tone: {
    direct: /\b(?:candid|straightforward|matter-of-fact|direct(?:ly)?|blunt(?:ly)?)\b|단도직입|직설적|담백/u,
    warm: /\b(?:warm(?:er|ly)?|friendl(?:y|ier)|approachable)\b|따뜻|친근|다정/u,
    neutral: /\b(?:neutral(?:ly)?|calm(?:ly)?)\b|중립적|차분/u,
  },
  register: {
    natural: /\b(?:my|match my|mirror my) register\b|내 말투에 맞/u,
    formal: /\b(?:formally|respectfully|politely|(?:formal|respectful|polite)(?=\s*(?:[,!.]|$)|\s+(?:tone|language|voice|register|style|replies|and)\b))\b|존댓말|격식\s*있게|예의\s*있게|공손(?:하게|히)/u,
    casual: /\b(?:casual(?:ly)?|informal(?:ly)?|conversational)\b|반말|격식 없이/u,
  },
  detail: {
    balanced: /\bbalanced (?:detail|length)\b|적당한 분량/u,
    brief: /\b(?:brief(?:ly)?|concis(?:e|ely)|shorter|short replies)\b|짧(?:게|고)|간결하게|간단하게/u,
    detailed: /\b(?:detailed|in detail|more detail|thorough(?:ly)?)\b|자세하게|상세하게/u,
  },
  structure: {
    "answer-first": /\b(?:answer|conclusion|result) first\b|(?:결론|결과|답|핵심|요점)\s*(?:부터|을\s*먼저)/u,
    "evidence-first": /\b(?:evidence|reasoning) first\b|근거부터/u,
    natural: /\bnatural (?:structure|order)\b|자연스러운 순서/u,
  },
  emoji: {
    none: /\b(?:no|without) emoji(?:s)?\b|(?:이모지|이모티콘)\s*(?:없이|빼고|금지|쓰지\s*말)/u,
    light: /\b(?:occasional|light|use some) emoji(?:s)?\b|(?:가끔|가벼운)\s*(?:이모지|이모티콘)/u,
  },
} satisfies { [D in keyof Voice]: Record<Voice[D], RegExp> };
const defaultVoice = {
  concept: "plain", tone: "direct", register: "natural", detail: "balanced", structure: "answer-first", emoji: "none",
} satisfies Voice;
const setting = "soul:reply-voice";

export const soulUpdateSchema = Type.Object({
  sourceId: Type.String({ minLength: 1, pattern: "\\S" }),
}, { additionalProperties: false });
type SoulUpdate = Partial<Voice> | "reset";
type Ledger = Pick<StorePort, "getMeta" | "setMeta">;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function voicePatch(value: unknown): value is Partial<Voice> {
  return object(value) && Object.keys(value).length > 0 && Object.entries(value).every(([key, choice]) =>
    Object.hasOwn(dimensions, key) && typeof choice === "string" && Object.hasOwn(dimensions[key as keyof Voice], choice));
}

function completeVoice(value: unknown) {
  // Both persisted pre-concept profiles and the first native wire version
  // have all the original fields but no concept.
  if (!voicePatch(value) || Object.keys(defaultVoice).some(key => key !== "concept" && !Object.hasOwn(value, key)))
    throw new Error("Invalid reply voice profile");
  return { ...defaultVoice, ...value };
}

function savedVoice(store: Ledger) {
  const raw = store.getMeta(setting);
  if (raw === null) return { revision: 0, sourceId: null, style: defaultVoice };
  const saved: unknown = JSON.parse(raw);
  if (!object(saved) || Object.keys(saved).length !== 3 || typeof saved.revision !== "number"
      || !Number.isSafeInteger(saved.revision) || saved.revision < 1 || typeof saved.sourceId !== "string" || !saved.sourceId)
    throw new Error("Stored reply voice is invalid");
  return { revision: saved.revision, sourceId: saved.sourceId, style: completeVoice(saved.style) };
}

function startsWithPresentation(text: string): boolean {
  return Object.values(requests).some(choices => Object.values(choices).some(pattern => pattern.exec(text)?.index === 0));
}

function onlyPresentationGrammar(text: string): boolean {
  // Every non-choice word must be reply syntax, not a task, exception, example
  // or time/channel qualifier. This also prevents a negated choice from
  // becoming affirmative just because its vocabulary matched a dimension.
  const english = /\b(?:please|answer|answers|reply|replies|respond|response|responses|explain|use|keep|make|be|your|my|our|the|a|an|it|in|with|and|to|as|more|tone|register|length|style|voice|approach|concept|format)\b/gu;
  const korean = /(?:답변|응답|말투|톤|분량|방식|스타일|컨셉|콘셉트?)(?:으로|은|는|을|를|이|가)?|(?:으로|하게|있게|해서|하고|이며|이고|면서|그리고|또|좀|더|늘|항상|기본적으로|답해|말해|설명해|알려|써|해|바꿔|변경해|설정해|정해|부탁해|부탁드려요|줘|주세요|주라|서|로|게)/gu;
  return !text.replace(english, " ").replace(korean, " ").replace(/[\s,.!，。、]+/gu, "");
}

/** Only unambiguous, supported choices in the original author's own prose are saved. */
export function soulUpdateIntent(source: Inbound): SoulUpdate | null {
  const headPrefix = /^ {0,3}\/head[ \t]/u;
  const raw = source.text.replace(headPrefix, "");
  const body = raw.trim();
  const prose = transportRoutingProse(source).replace(headPrefix, "").trim();
  const indented = /^[ \t]{4}|^\t/u;
  const addressedText = source.discordOriginalText;
  if (!body || indented.test(raw) || body !== prose || body !== ownerRoutingProse(raw) || /[\r\n?？]/u.test(raw)) return null;
  if (addressedText !== undefined) {
    // An addressed message can be normalized by removing only the bot
    // mention, but a voice draft or quoted physical line is not that prose.
    const original = addressedText.replace(/<@!?(\d+)>/gu, (mention, id) => id === source.route.accountId ? " " : mention);
    if (indented.test(addressedText) || /[\r\n]/u.test(addressedText)
        || original.trim().replace(/\s+/gu, " ") !== source.text.trim().replace(/\s+/gu, " ")) return null;
  }
  const labeled = /^(?:soul|말투)\s*:\s*(\S.*)$/iu.exec(body)?.[1];
  const request = labeled ?? body;
  if (/^(?:please\s+)?reset(?:\s+(?:(?:the|your|our)\s+)?(?:soul|reply style|writing style))?(?:\s+to\s+(?:the\s+)?default(?:s)?)?[.!]?$/iu.test(request)
      && (labeled !== undefined || /(?:soul|reply style|writing style)\b/iu.test(request))) return "reset";
  if (/^(?:(?:소울|말투|응답\s*스타일)(?:을|를)?\s+)?(?:기본(?:값|값으로|으로)?\s*(?:초기화해|되돌려|돌려)|초기화(?:해)?)\s*(?:줘|주세요)?[.!]?$/u.test(request)
      && (labeled !== undefined || /^(?:소울|말투|응답\s*스타일)/u.test(request))) return "reset";
  const styleText = request.toLowerCase().replace(/[‘’]/gu, "'");
  // A persistent change must be a direct instruction about this agent's
  // replies. Questions, alternatives, scoped exceptions and examples are
  // not configuration even when they contain a supported phrase.
  if (/\b(?:not|don't|never|instead of|or|could|would|should|can you|if|unless|suppose|imagine|pretend|for example|example of|quote|forwarded|only when|only for|just this|(?:this|the next) (?:thread|task|reply|answer)|(?:he|she|they) (?:said|asked))\b|말고|아니[라면]|않|하지\s*마|말아|만약|가정|상상|척해|예를\s*들|예시|인용|전달받|라고\s*(?:했|하던|쓰|적)|라는\s*(?:요청|문구|말|지시)|라면|해\s*줄래|할\s*수\s*있|어떨까|어때|(?:이번|이|다음)\s*(?:한\s*번|한번|답변|작업|스레드|메시지)(?:에(?:서)?)?만|이번만/u.test(styleText)) return null;
  const englishSetting = /^(?:please\s+)?(?:change|set|update)\s+(?:(?:the|your|our)\s+)?(?:soul|reply style|writing style)\b(?:\s+to)?\s+/u;
  const englishReply = /^(?:please\s+)?(?:(?:answer|reply|respond|explain)\s+(?:(?:in|with|using)\s+(?:(?:a|an|the)\s+)?|(?=like\s|[a-z]+ly\b))|(?:answer|reply|respond)\s+(?=(?:answer|conclusion|result|evidence|reasoning) first\b)|use\s+(?=.*\b(?:tone|register|voice|style|length|format)\b)(?:(?:a|an|the)\s+)?)/u;
  const englishFuture = /^(?:from now on|going forward|from your next reply(?: onward)?|henceforth),?\s+/u;
  const koreanFuture = /^(?:(?:답변은|응답은|말투는)\s+)?(?:앞으로(?:는|도)?|이제부터(?:는)?|지금부터(?:는)?|다음(?:\s*답변)?부터(?:는)?|앞으론|항상|매번)\s+/u;
  const koreanSetting = /^(?:기본\s*)?(?:소울|말투|(?:답변|응답)\s*(?:방식|스타일|말투)|답변\s*컨셉)(?:을|를|은|는)?\s+/u;
  const koreanSetRequest = /(?:바꿔|변경해|설정해|정해)\s*(?:줘|주세요|주라)?[.!]?$/u;
  const koreanReply = /(?:해\s*(?:줘|주세요|주라)?|알려\s*(?:줘|주세요|주라)|부탁(?:해|드려요)?)[.!]?$/u;
  const koreanLead = /^(?:(?:제게|저한테|나한테|뭐든|기본적으로|답변은|응답은|말투는|답변을|응답을|말투를|답변할\s*때(?:는|마다)?|응답할\s*때(?:는|마다)?|유능한|능숙한|좋은|친절한|믿음직한)\s+)*/u;
  const persistentEnglish = styleText.replace(englishFuture, "");
  const persistentKorean = styleText.replace(koreanFuture, "");
  let presentation: string;
  if (labeled !== undefined) presentation = styleText.replace(koreanLead, "");
  else if (englishSetting.test(styleText)) presentation = styleText.replace(englishSetting, "");
  else if (koreanSetting.test(styleText) && koreanSetRequest.test(styleText)) presentation = styleText.replace(koreanSetting, "").replace(koreanLead, "");
  else if (persistentEnglish !== styleText && englishReply.test(persistentEnglish)) presentation = persistentEnglish.replace(englishReply, "");
  else if (persistentKorean !== styleText && koreanReply.test(persistentKorean)) presentation = persistentKorean.replace(koreanLead, "");
  else return null;
  if (labeled === undefined && !startsWithPresentation(presentation)) return null;
  const patch: Record<string, string> = {};
  let remainder = presentation;
  for (const [dimension, choices] of Object.entries(requests)) {
    const matches = Object.entries(choices).filter(([, pattern]) => pattern.test(presentation));
    if (matches.length > 1) return null;
    if (matches[0]) {
      const [choice, pattern] = matches[0];
      patch[dimension] = choice;
      remainder = remainder.replace(new RegExp(pattern.source, "gu"), " ");
    }
  }
  // Do not silently apply only the familiar half of a concept plus style
  // request when the owner named an unsupported concept.
  if (!patch.concept && /\b(?:concept|persona|like an?)\b|컨셉|콘셉트?|처럼|같은\s*느낌/u.test(presentation)) return null;
  return onlyPresentationGrammar(remainder) && voicePatch(patch) ? patch : null;
}

export function soulSourceId(value: unknown): string {
  if (object(value) && Object.keys(value).length === 1 && typeof value.sourceId === "string" && value.sourceId.trim())
    return value.sourceId;
  throw new Error("A reply voice update takes only its original sourceId");
}

export function applySoulUpdate(store: Ledger, sourceId: string, update: SoulUpdate) {
  const current = savedVoice(store);
  if (current.sourceId !== sourceId) {
    const style = update === "reset" ? defaultVoice : { ...current.style, ...update };
    const next = { revision: current.revision + 1, sourceId, style };
    if (!Number.isSafeInteger(next.revision)) throw new Error("Reply voice revision is unavailable");
    store.setMeta(setting, JSON.stringify(next));
  }
  const applied = savedVoice(store);
  return { revision: applied.revision, style: applied.style };
}

export function replyVoiceProfile(store: Ledger, version: 1 | 2 = 2) {
  const { concept, ...base } = savedVoice(store).style;
  return version === 2 ? { ...base, concept } : base;
}

export function renderReplyVoice(value: unknown): string {
  const style = completeVoice(value);
  return [
    "<superagent-reply-voice>",
    "Apply this voice only to prose addressed to the operator. Use their language. Separate verified facts from inference. Task formats, role instructions, permissions and workflows are unchanged.",
    dimensions.concept[style.concept], dimensions.tone[style.tone], dimensions.register[style.register], dimensions.detail[style.detail],
    dimensions.structure[style.structure], dimensions.emoji[style.emoji],
    "</superagent-reply-voice>",
  ].filter(Boolean).join("\n");
}
