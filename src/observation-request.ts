import { ownerRoutingProse } from "./topic-history";

const observationSubject = /\b(?:presence|online|pr|ci|lane|pull request|watches|monitors)\b|github\.com\/[^ ]+\/pull\/\d+|#\d+|온라인|오프라인|접속\s*표시|레인|작업|봇/iu;
const watchTarget = /^(?:watch|monitor|track|untrack|(?:start|stop) (?:watching|monitoring|tracking)|keep an eye on)\s+(?:(?:this|that|the|our|my)\s+)?(?:pr\b|pull request\b|lane\b|ci(?=[.?!\s]*$|\s+(?:checks?|runs?|status|on|for|of|and)\b)|https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+\b|[\w.-]+\/[\w.-]+#\d+\b|#\d+\b)/i;
const watchList = /^(?:list|show) (?:my |the |our )?(?:watches|monitors)\b/i;
const notify = /^(?:notify me|let me know) (?:when|if)\b/i;
const implicitWatch = /^(?:keep an eye on (?:it|this)|(?:notify me|let me know) when (?:it|this) (?:finishes|stalls|fails|passes|completes))[.?!\s]*$/i;
const englishPresence = /^(?:(?:please|can you|could you)\s+)*(?:keep|set|show|check|enable|disable|turn (?:on|off)|is)\s+(?:the |our |your |my )?(?:(?:discord|slack|telegram)\s+)?(?:bot(?:'s)?\s+(?:presence|online|invisible)\b|presence\b|online (?:indicator|dot)\b)/i;
const koreanWatch = /(?:감시|모니터링|추적)(?:해|(?:를|을)?\s*(?:시작|중지|종료|해제|그만)(?:해)?)$/u;
const koreanPresence = /(?:(?:온라인|오프라인)(?:으로|\s*상태(?:로|를)?)?\s*(?:유지|표시|전환)해|(?:온라인|오프라인|접속)\s*표시(?:를)?\s*(?:켜|꺼))$/u;
const koreanStatus = /(?:(?:상태|목록)(?:를|을)?\s*(?:알려|보여|확인해)|(?:되면|나면|지면|추면|하면|했는지|인지)\s*(?:여기(?:에|로)?\s*)?알려)$/u;

/** This changes only the session receiving the message, never the subscription or
 * presence. HEAD resolves the target, asks when ambiguous, and calls the tool. */
export function isObservationRequest(text: string): boolean {
  const prose = ownerRoutingProse(text);
  if (!prose || prose.includes("\n") || prose.startsWith("/") || /^cwd\s*:/i.test(prose)) return false;
  const english = prose.replace(/^(?:(?:please|can you|could you)\s+)+/i, "");
  if (englishPresence.test(prose) || watchTarget.test(english) || watchList.test(english) || implicitWatch.test(english)) return true;
  if (!observationSubject.test(prose) && !/^(?:감시|모니터링)/u.test(prose)) return false;
  const request = prose.replace(/[.!?…\s]+$/u, "").replace(/\s*(?:주세요|주라|줘요?|줘라|둬|놔|봐|라)$/u, "");
  return notify.test(english) || koreanWatch.test(request) || koreanPresence.test(request) || koreanStatus.test(request);
}
