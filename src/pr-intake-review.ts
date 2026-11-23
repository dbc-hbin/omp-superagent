import { createHash } from "node:crypto";
import { physicalRoute, routeKey, type Inbound, type InputRecord, type Lane, type Route, type StorePort } from "./contracts";
import { compareMessageIds } from "./message-order";
import type { CronJobs } from "./cron-jobs";
import type { CronPrCandidate, CronPrIntake } from "./cron-pr-intake";
import type { CronPrJob } from "./cron-jobs";
import { hasIntakeReplyRoute, intakeThreadKey, intakeStatusKey, intakeWorkId, intakeWorkPrefix } from "./pr-intake-work";
import { inspectIntakeMerge, mergeIntakePull } from "./pr-intake-github";
import { applyIntakeFix, intakeFixDigest, parseIntakeFix, reconcileIntakeFix } from "./pr-intake-fix";
import { readIntakeMaterial, readIntakeMaterialTarget } from "./pr-intake-material";
import { inspectIntakeComment, publishIntakeComment } from "./pr-intake-comment";
import { advancePrIntakeAutomation, prIntakeManualHold, readPrIntakeAutomation } from "./pr-intake-automation";
import type { PrIntakeMode } from "./pr-intake-mode";

export class PrControlError extends Error {}
export const prAction = /^(?:pr-review|pr-merge|pr-fix|pr-status)(?:\s|$)/;
type Action = "pr-review" | "pr-merge" | "pr-fix" | "pr-status";
export interface ReviewRound {
  readonly job: string;
  readonly repository: string;
  readonly repositoryId: number;
  readonly ownerId: number;
  readonly number: number;
  readonly laneId: string;
  readonly opener: string;
  readonly source: string;
  readonly inputId: string;
  readonly head: string;
  readonly epoch: string;
  readonly automation?: { readonly revision: string; readonly anchor: string };
}
interface Effect {
  readonly action: "pr-fix" | "pr-merge";
  readonly source: string;
  readonly state: "unknown" | "confirmed";
  readonly sha?: string;
}
export const prReviewApis = { readIntakeMaterial, applyIntakeFix, reconcileIntakeFix, inspectIntakeMerge, mergeIntakePull,
  inspectIntakeComment, publishIntakeComment };
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const scopeKey = (job: string, number: number) => `pr-review:${job}:${number}`;
const pointer = (laneId: string) => `pr-review-lane:${laneId}`;
export function isPrReviewLane(store: StorePort, laneId: string): boolean {
  return store.getMeta(pointer(laneId)) !== null;
}
const materialKey = (round: ReviewRound) => `pr-review-material:${round.inputId}`;
const effectKey = (round: ReviewRound) => `pr-review-effect:${round.inputId}`;
const args = /^(pr-review|pr-status|pr-merge|pr-fix) ([\da-f-]{36}) ([1-9]\d*)(?: ([a-f0-9]{40}|[a-f0-9]{64}))?(?: ([a-f0-9]{64}))?$/;

function approved(text: string): boolean {
  try {
    const result: unknown = JSON.parse(text);
    return typeof result === "object" && result !== null && Object.keys(result).length === 2
      && [...text.matchAll(/"(?:[^"\\]|\\[\s\S])*"/g)].filter(token => /^\s*:/.test(text.slice(token.index + token[0].length))).length === 2
      && "verdict" in result && result.verdict === "approve" && "summary" in result
      && typeof result.summary === "string" && result.summary.trim().length > 0;
  } catch { return false; }
}

export class PrReviews {
  constructor(private readonly store: StorePort, private readonly cron: CronJobs,
    private readonly intake: CronPrIntake, private readonly api: typeof prReviewApis) {}

  saved(job: string, number: number): ReviewRound | null {
    const value = this.store.getMeta(scopeKey(job, number));
    return value === null ? null : JSON.parse(value);
  }

  needsReconciliation(scope: Pick<ReviewRound, "repositoryId" | "number">): boolean {
    const state = readPrIntakeAutomation(this.store, scope);
    return !!state && [...state.comments, state.fix, state.merge].some(entry => entry?.state === "unknown" || entry?.state === "pending");
  }

  laneRound(laneId: string): ReviewRound | null {
    const claim = this.store.getMeta(pointer(laneId));
    if (claim === null) return null;
    const value = this.store.getMeta(claim);
    if (!value) throw new PrControlError("PR 레인 등록이 손상되어 실행을 보류했습니다.");
    const round: ReviewRound = JSON.parse(value);
    if (round.laneId !== laneId) throw new PrControlError("PR 레인 식별자가 일치하지 않습니다.");
    return round;
  }

  private effect(r: ReviewRound): Effect | null {
    return JSON.parse(this.store.getMeta(effectKey(r)) ?? "null");
  }

  assertActive(r: ReviewRound): void {
    const source = this.store.input(r.source);
    if (!source || this.store.getMeta(scopeKey(r.job, r.number)) !== JSON.stringify(r))
      throw new PrControlError("PR 검토 등록이 중단되거나 변경되었습니다. 새 소유자 검토 명령이 필요합니다.");
    const parent = { ...physicalRoute(source.route), threadId: null };
    if (r.automation) {
      const active = this.cron.activePrEnrollment(r.job);
      const candidate = active && this.intake.candidate(active.job, r.number);
      const offer = candidate && this.store.output(candidate.outputId);
      if (!active || active.job.epoch !== r.epoch || active.job.repository !== r.repository
        || this.cron.prPolicy(r.job)?.revision !== r.automation.revision
        || !candidate || candidate.repositoryId !== r.repositoryId || candidate.ownerId !== r.ownerId
        || candidate.policyRevision !== r.automation.revision || candidate.epoch !== r.epoch
        || !offer || offer.state !== "sent" || offer.remoteId !== r.automation.anchor || !this.intake.canDeliver(offer)
        || routeKey(parent) !== routeKey(active.source.route) || source.route.threadId !== offer.remoteId
        || (source.state !== "pending" && source.state !== "done")
        || !source.id.startsWith(intakeWorkPrefix) || source.messageId !== null || source.interactionId !== undefined
        || this.store.getMeta(`user-source:${source.id}`) !== null)
        throw new PrControlError("등록한 자동 단계 또는 원래 PR·스레드 영수증을 확인하지 못했습니다.");
    } else if (this.cron.requireActivePrJob(source, r.job, parent).epoch !== r.epoch)
      throw new PrControlError("원래 PR 등록이 변경되었습니다.");
  }

  private placed(r: ReviewRound): Lane {
    if (r.opener.startsWith(intakeWorkPrefix)) {
      const lane = this.store.lane(r.laneId);
      const opening = this.store.input(`handoff:${r.opener}:lane`);
      const kickoff = this.store.output(`${r.opener}:kickoff`);
      const original = this.store.input(r.opener);
      const anchor = this.store.getMeta(intakeThreadKey(r.job, r.number));
      if (lane && original && opening?.target === lane.id && !lane.remote && anchor === lane.route.threadId
        && this.store.getMeta(`handoff-source:${opening.id}`) === original.id
        && routeKey(original.route) === routeKey(lane.route) && routeKey(opening.route) === routeKey(lane.route)
        && kickoff?.sourceId === opening.id && kickoff.state === "sent" && kickoff.remoteId
        && routeKey(kickoff.route) === routeKey(lane.route)) return lane;
      throw new PrControlError("PR 자동 검토 스레드·레인 또는 시작 메시지 전송을 확인할 수 없습니다.");
    }
    const lane = this.store.headLanePlacement(r.opener);
    if (!lane || lane === "unverified" || lane.id !== r.laneId || !lane.route.threadId || lane.remote)
      throw new PrControlError("스레드 생성·레인 배정·시작 메시지 중 확인되지 않은 단계가 있습니다. 원래 명령과 Discord 전송 기록을 대조하세요. 스레드를 다시 만들지 않습니다.");
    return lane;
  }

  async material(r: ReviewRound, signal: AbortSignal): Promise<string> {
    this.assertActive(r);
    const material = await this.api.readIntakeMaterial(r.repository, r.number, r.head, signal, r);
    this.assertActive(r);
    this.store.setMeta(materialKey(r), JSON.stringify({ digest: digest(material), ...readIntakeMaterialTarget(material) }));
    return material;
  }

  answer(r: ReviewRound): string | null {
    const input = this.store.input(r.inputId);
    const lane = this.placed(r);
    const answer = this.store.output(`${r.inputId}:answer`);
    const delivery = r.automation && input && hasIntakeReplyRoute(this.store, input, r.source)
      ? { source: { id: r.source }, outputSourceId: input.id } : this.store.topicDelivery(r.inputId);
    return input?.state === "done" && input.target === lane.id && input.requestId && input.generation !== null
      && this.store.getMeta(materialKey(r)) && delivery?.source.id === r.source && answer?.state === "sent"
      && answer.remoteId && delivery.outputSourceId === answer.sourceId && routeKey(answer.route) === routeKey(lane.route)
      ? answer.text : null;
  }

  async advance(r: ReviewRound, observedHead: string | null, policy: NonNullable<ReturnType<CronJobs["prPolicy"]>>,
    signal: AbortSignal, verifyRound: () => void): Promise<{ text: string; nextHead: string | null }> {
    const manual = this.effect(r);
    if (manual) return { text: `별도의 소유자 명령 ${manual.action}: ${manual.state}. /cron pr-status ${r.job} ${r.number}`, nextHead: null };
    const input = this.store.input(r.inputId);
    if (!input || input.state === "pending" || input.state === "submitted" || input.state === "uncertain")
      return { text: `PR #${r.number} ${r.head}: 검토 ${input?.state ?? "미확인"}.`, nextHead: null };
    if (input.state === "cancelled" && observedHead === r.head) {
      const why = this.store.output(`${r.inputId}:held`)?.text ?? "검토가 취소되어 이 SHA에는 완료된 결과가 없습니다.";
      return { text: `${why} 원인을 해결한 뒤 이 스레드에서 /cron pr-review ${r.job} ${r.number} ${r.head}`, nextHead: null };
    }
    const answer = this.answer(r);
    const material = this.store.getMeta(materialKey(r));
    if (input.state === "done" && !answer)
      return { text: "원래 검토 답변의 Discord 전달이 확인되지 않아 새 검토·쓰기를 보류했습니다.", nextHead: null };
    const rank = { review: 1, fix: 2, merge: 3 } as const;
    const verify = (stage: PrIntakeMode) => {
      verifyRound();
      if (rank[stage] > rank[policy.mode] || r.automation?.revision !== policy.revision || this.effect(r)
        || this.answer(r) !== answer || this.store.getMeta(materialKey(r)) !== material)
        throw new PrControlError("자동 단계 또는 전달된 검토 결과가 변경되었습니다.");
    };
    const result = await advancePrIntakeAutomation(r, { store: this.store, mode: policy.mode, observedHead, signal, verify,
      evidence: answer && material ? { answer, material: JSON.parse(material) } : null, api: this.api });
    return { text: result.message, nextHead: result.nextHead ?? null };
  }

  startAutomated(job: CronPrJob, candidate: CronPrCandidate, head: string, route: Route, laneId: string, revision: string): ReviewRound {
    const previous = this.saved(job.id, candidate.number);
    if (!route.threadId || previous && (!previous.automation || previous.laneId !== laneId))
      throw new PrControlError("다른 작업이 이미 이 PR의 검토 레인을 소유합니다.");
    const source = intakeWorkId(job.id, candidate.number, revision, head);
    if (this.store.input(source)) throw new PrControlError("이미 접수한 SHA입니다. 자동으로 재실행하지 않습니다.");
    const round: ReviewRound = { job: job.id, number: candidate.number, repository: job.repository, laneId,
      repositoryId: candidate.repositoryId, ownerId: candidate.ownerId, head, epoch: job.epoch, source,
      opener: previous?.opener ?? source, inputId: `handoff:${source}:${previous ? laneId : "lane"}`,
      automation: { revision, anchor: route.threadId } };
    this.store.receivePrWork({ id: source, route, receivedAt: Date.now(), attachments: [], messageId: null,
      text: `Static PR review: ${job.repository}#${candidate.number} ${head}` }, null, round);
    return round;
  }

  /** Captured in the receipt of an incoming owner command, never filled in by
   * the pump later. A queued command cannot borrow a subsequently delivered review. */
  approvalAt(command: Inbound, argument: string): string | null {
    const { route } = command;
    const match = args.exec(argument);
    if (!match || (match[1] !== "pr-fix" && match[1] !== "pr-merge") || !match[2] || !route.threadId) return null;
    const r = this.saved(match[2], Number(match[3]));
    if (!r || r.head !== match[4]) return null;
    let lane: Lane;
    try { lane = this.placed(r); } catch { return null; }
    if (lane.workState !== "open" || routeKey(lane.route) !== routeKey(route)) return null;
    const answer = this.answer(r);
    if (!answer) return null;
    const input = this.store.input(r.inputId);
    const output = this.store.output(`${r.inputId}:answer`);
    // A Gateway catch-up may admit an earlier physical owner message only
    // after the answer has been sent. It is not a later confirmation.
    const event = command.messageId ?? command.interactionId;
    if (!output?.remoteId || !event || compareMessageIds("discord", event, output.remoteId) !== 1) return null;
    return digest(JSON.stringify([r.inputId, r.epoch, input?.requestId, input?.generation, output?.remoteId, answer]));
  }

  private next(r: ReviewRound): string {
    const text = this.answer(r);
    const cmd = `${r.job} ${r.number} ${r.head}`;
    const state = this.store.input(r.inputId)?.state ?? "not admitted";
    if (!text) return `${r.head}: ${state}. 검토 답변의 전송이 확인되기 전에는 병합하거나 수정할 수 없습니다.`;
    if (approved(text)) return prIntakeManualHold(this.store, r, "pr-merge", r.head)
      ?? `검토한 SHA: ${r.head}. 현재 CI·보호 규칙을 다시 확인한 뒤 병합하려면 이 스레드에서 /cron pr-merge ${cmd}`;
    const fix = parseIntakeFix(text);
    if (fix) return prIntakeManualHold(this.store, r, "pr-fix", r.head)
      ?? `수정 제안: ${fix.path}. 위 답변의 정확한 변경을 확인한 뒤 이 스레드에서 /cron pr-fix ${cmd} ${intakeFixDigest(r.repository, r.number, r.head, fix)}`;
    return `병합 승인 없음. 수정 후 이 스레드에서 /cron pr-review ${r.job} ${r.number} <새 HEAD SHA> 로 다시 검토하세요.`;
  }

  async control(input: InputRecord, argument: string, options: {
    readonly signal: AbortSignal; readonly verify: () => void;
    readonly newLaneId: string; readonly place: (round: ReviewRound, first: boolean) => Promise<void>;
  }): Promise<string> {
    const match = args.exec(argument);
    if (!match || input.attachments.length || input.pickerSelection || input.target !== "main")
      throw new PrControlError("형식: /cron pr-status JOB NUMBER | pr-review/pr-merge JOB NUMBER SHA | pr-fix JOB NUMBER SHA DIGEST (첨부 없이 새 소유자 명령)");
    const [, verb, jobId, n, head, hash] = match;
    const action = verb as Action;
    const number = Number(n);
    if (!jobId || !Number.isSafeInteger(number) || (action === "pr-status") !== !head || (action === "pr-fix") !== !!hash)
      throw new PrControlError("PR 번호·전체 SHA·수정 승인 해시를 확인하세요.");
    const parent = { ...physicalRoute(input.route), threadId: null };
    const job = this.cron.requireActivePrJob(input, jobId, parent);
    if (this.store.getMeta(`pr-control-epoch:${input.id}`) !== job.epoch)
      throw new PrControlError("명령 접수 이후 등록이 변경되었습니다. 현재 등록을 확인한 뒤 새 명령을 보내세요.");
    const candidate = this.intake.candidate(job, number);
    if (!candidate) throw new PrControlError("이 등록에서 발견한 PR이 아닙니다.");
    let previous = this.saved(jobId, number);
    const automaticStatus = this.store.getMeta(intakeStatusKey(jobId, number));
    if (action === "pr-status" && automaticStatus && !input.route.threadId)
      return automaticStatus;
    let anchored = false;
    const anchor = this.store.getMeta(intakeThreadKey(jobId, number));
    const offer = !previous && anchor ? this.store.output(candidate.outputId) : null;
    const declined = offer?.state === "sent" && !!offer.remoteId && routeKey(parent) === routeKey(offer.route)
      && anchor === `rejected:${offer.remoteId}`;
    if (!previous && anchor && !declined) {
      anchored = action === "pr-review" && input.route.threadId === anchor && offer?.state === "sent"
        && offer.remoteId === anchor && routeKey(parent) === routeKey(offer.route) && !this.store.laneForRoute(input.route);
      if (!anchored)
        throw new PrControlError("자동 스레드 생성 영수증이 있습니다. 원래 알림의 스레드를 확인하세요. 두 번째 스레드는 만들지 않습니다.");
    }
    const verify = () => {
      options.verify();
      if (this.store.input(input.id)?.state !== "pending" || this.cron.requireActivePrJob(input, jobId, parent).epoch !== job.epoch)
        throw new PrControlError("원래 명령이 더 이상 활성 상태가 아닙니다.");
    };
    verify();
    const opener = previous ? this.store.input(previous.opener) : null;
    // A definitive preflight refusal before any send can be corrected by a new
    // original owner action. Never reuse a possibly submitted createThread.
    if (previous && action === "pr-review" && !input.route.threadId
      && opener?.state === "cancelled" && opener.route.threadId === null
      && this.store.getMeta(`handoff-route:${previous.opener}`) === null
      && !this.store.input(`handoff:${previous.opener}:lane`) && !this.store.lane(previous.laneId)) previous = null;
    // Discord uses the starter message snowflake as its thread ID. A fresh
    // owner command inside that exact thread can finish a lost create receipt
    // without repeating createThread or adopting a thread by name.
    const destination = previous && this.store.getMeta(`handoff-route:${previous.opener}`);
    const known = destination === "uncertain" && previous ? this.store.getMeta(`handoff-route-result:${previous.opener}`) : destination;
    if (previous && input.route.threadId && action === "pr-review" && input.id !== previous.opener
      && (known && known !== "uncertain" && routeKey(JSON.parse(known)) === routeKey(input.route)
        || opener?.route.threadId === null && destination === "uncertain" && opener.messageId === input.route.threadId
        || opener?.route.threadId === input.route.threadId)
      && !this.store.input(`handoff:${previous.opener}:lane`) && !this.store.lane(previous.laneId)
      && !this.store.laneForRoute(input.route)) {
      anchored = true;
      previous = null;
    }
    if (!previous) {
      if (input.route.threadId && !anchored || action !== "pr-review" || !head) throw new PrControlError("원래 등록한 부모 채널에서 /cron pr-review JOB NUMBER SHA 를 보내세요.");
      if (head !== candidate.head) throw new PrControlError("최초 검토는 원래 제안에 표시된 SHA를 지정해야 합니다. 이후 변경은 전용 스레드에서 검토하세요.");
    } else {
      if (!input.route.threadId) {
        if (previous.opener === input.id && !this.store.headLanePlacement(input.id)) {
          throw new PrControlError("이전 배정이 중단되었습니다. 원래 명령·스레드의 실제 상태를 확인하세요. 자동으로 반복하지 않습니다.");
        }
        return `이 PR에는 이미 전용 레인이 있습니다: <#${this.placed(previous).route.threadId}>. 그 스레드에서 /cron pr-status ${jobId} ${number}`;
      }
      const lane = this.placed(previous);
      if (routeKey(lane.route) !== routeKey(input.route)) throw new PrControlError("이 PR의 원래 스레드가 아닙니다.");
      if (lane.workState !== "open" && action !== "pr-status") throw new PrControlError("원래 PR 레인이 중단되었습니다. 먼저 해당 레인의 상태를 확인하세요.");
      const effect = this.effect(previous);
      if (effect?.state === "unknown") {
        if (action !== "pr-status") throw new PrControlError(`GitHub 요청 ${effect.source} 결과 미확인. /cron pr-status ${jobId} ${number} 로 읽기 전용 확인하세요. 반복 실행하지 않습니다.`);
        const fix = parseIntakeFix(this.answer(previous) ?? "");
        const target = JSON.parse(this.store.getMeta(materialKey(previous)) ?? "null");
        const result = effect.action === "pr-merge" && typeof target?.baseRef === "string" && typeof target.baseSha === "string"
          ? await this.api.inspectIntakeMerge(job.repository, number, previous.head, options.signal, { ...previous, baseRef: target.baseRef, baseSha: target.baseSha })
          : fix && typeof target?.headRef === "string" ? await this.api.reconcileIntakeFix(job.repository, number, previous.head, fix, options.signal, target.headRef, previous) : null;
        verify();
        if (result?.status === "merged" || result?.status === "applied") {
          this.store.setMeta(effectKey(previous), JSON.stringify({ ...effect, state: "confirmed", sha: result.sha }));
          return `GitHub에서 확인: ${result.status} ${result.sha}. 재시도하지 않았습니다.`;
        }
        return "이전 GitHub 변경을 확인하지 못했습니다. GitHub PR과 커밋 이력을 직접 대조하세요. 이 등록에서는 모호한 쓰기를 다시 보내지 않습니다.";
      }
      if (effect?.state === "confirmed") {
        if (action === "pr-status" || action !== "pr-review" || effect.action === "pr-merge" || head === previous.head)
          return `GitHub 확인: ${effect.action} ${effect.sha}. ${effect.action === "pr-fix" ? `이 스레드에서 /cron pr-review ${jobId} ${number} ${effect.sha} 로 새 HEAD를 다시 검토하세요.` : "종료되었습니다."}`;
      }
      if (action === "pr-status") {
        if (previous.automation && this.needsReconciliation(previous)) {
          const answer = this.answer(previous);
          const material = this.store.getMeta(materialKey(previous));
          const result = await advancePrIntakeAutomation(previous, { store: this.store, mode: "review", observedHead: null,
            reconcileOnly: true, evidence: answer && material ? { answer, material: JSON.parse(material) } : null,
            signal: options.signal, api: this.api, verify: () => { throw new PrControlError("상태 조회는 쓰기 권한이 없습니다."); } });
          verify();
          this.store.setMeta(intakeStatusKey(jobId, number), result.message);
          return result.message;
        }
        return previous.epoch === job.epoch && (!previous.automation || this.cron.prPolicy(job.id)?.revision === previous.automation.revision)
          ? [automaticStatus, this.next(previous)].filter(Boolean).join("\n")
          : `이전 등록의 검토입니다. 이 스레드에서 /cron pr-review ${jobId} ${number} <현재 HEAD SHA> 로 다시 검토하세요.`;
      }
      const hold = prIntakeManualHold(this.store, previous, action, head);
      if (hold) throw new PrControlError(hold);
      if (action !== "pr-review") {
        if (previous.epoch !== job.epoch || previous.head !== head || !head) throw new PrControlError("활성 등록의 최종 검토 SHA와 다릅니다. 새로 검토하세요.");
        const approval = this.store.getMeta(`pr-control-review:${input.id}`);
        if (!approval || approval !== this.approvalAt(input, argument))
          throw new PrControlError("명령 접수 시점에 같은 스레드로 전달된 동일 검토 결과가 없습니다. 결과를 확인한 뒤 새 명령을 보내세요.");
        const answer = this.answer(previous);
        if (!answer)
          throw new PrControlError("확인된 검토 결과 또는 수정 제안의 해시가 일치하지 않습니다.");
        const evidence = JSON.parse(this.store.getMeta(materialKey(previous)) ?? "null");
        const reviewed = previous;
        const beforeWrite = () => {
          verify(); this.assertActive(reviewed);
          if (this.effect(reviewed) || approval !== this.approvalAt(input, argument))
            throw new PrControlError("원래 검토·레인·쓰기 상태가 변경되어 요청하지 않았습니다.");
          this.store.setMeta(effectKey(reviewed), JSON.stringify({ source: input.id, action, state: "unknown" } satisfies Effect));
        };
        let result: Awaited<ReturnType<typeof mergeIntakePull | typeof applyIntakeFix>>;
        switch (action) {
          case "pr-fix": {
            const fix = parseIntakeFix(answer);
            if (!fix || intakeFixDigest(job.repository, number, head, fix) !== hash)
              throw new PrControlError("소유자가 지정한 해시가 해당 SHA의 수정 제안과 일치하지 않습니다.");
            result = await this.api.applyIntakeFix(job.repository, number, head, fix, options.signal, confirmed => {
              if (digest(confirmed) !== evidence?.digest) throw new PrControlError("수정 직전 검토 자료가 바뀌었습니다.");
              beforeWrite();
            }, previous);
            break;
          }
          case "pr-merge": {
            if (!approved(answer)) throw new PrControlError("이 SHA에 대한 레인 검토의 병합 승인이 없습니다.");
            const material = await this.api.readIntakeMaterial(job.repository, number, head, options.signal, previous);
            if (digest(material) !== evidence?.digest) throw new PrControlError("검토 이후 PR 기준 브랜치 또는 내용이 바뀌었습니다. 같은 스레드에서 다시 검토하세요.");
            result = await this.api.mergeIntakePull(job.repository, number, head, options.signal, beforeWrite,
              { ...previous, ...readIntakeMaterialTarget(material) });
            break;
          }
        }
        if (result.status === "merged" || result.status === "applied") {
          this.store.setMeta(effectKey(previous), JSON.stringify({ source: input.id, action, state: "confirmed", sha: result.sha } satisfies Effect));
          return result.status === "merged" ? `GitHub 병합 확인: ${result.sha}` : `GitHub 수정 커밋 확인: ${result.sha}. /cron pr-review ${jobId} ${number} ${result.sha}`;
        }
        if (result.status === "blocked" && this.effect(previous)?.source === input.id)
          this.store.setMeta(effectKey(previous), "null"); // Definitive refusal, not an ambiguous request.
        return `GitHub ${result.status}: ${result.reason}. /cron pr-status ${jobId} ${number}`;
      }
      const old = this.store.input(previous.inputId);
      if (old?.state === "pending" || old?.state === "submitted" || old?.state === "uncertain")
        throw new PrControlError(`이전 검토 ${old.id}: ${old.state}. 기존 요청을 먼저 확인하세요.`);
    }
    if (!head) throw new PrControlError("전체 검토 SHA가 필요합니다.");
    const laneId = previous?.laneId ?? options.newLaneId;
    const round: ReviewRound = { job: jobId, number, repository: job.repository, laneId, opener: previous?.opener ?? input.id,
      repositoryId: candidate.repositoryId, ownerId: candidate.ownerId,
      head, source: input.id, epoch: job.epoch, inputId: `handoff:${input.id}:${previous ? laneId : "lane"}` };
    this.store.setMeta(scopeKey(jobId, number), JSON.stringify(round));
    this.store.setMeta(pointer(laneId), scopeKey(jobId, number));
    this.store.setMeta(`topic-owner:${input.id}`, laneId);
    await options.place(round, !previous);
    return `PR #${number} 검토를 접수했습니다. 결과 확인: /cron pr-status ${jobId} ${number}`;
  }
}
