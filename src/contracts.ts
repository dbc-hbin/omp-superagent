import type { ModelPreset as NativeModelPreset } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import type { LaneEvidence, LaneReport, LaneWaitTarget } from "./lane/lane-report";
import type { CronUpdate } from "./cron/cron-jobs";
import type { ReviewRound } from "./pr/pr-intake-review";
import type { GroupReply, GroupRequest } from "./group/group-policy";
import type { StagedResultAttachment } from "./messaging/result-attachment";
import type { RemotePlacement } from "./worker/worker-wire";
import type { OmpResetAccount } from "./omp/omp-usage";

/** Coordination records only. OMP owns transcripts and execution state. */
export type Platform = "discord" | "telegram" | "slack" | "kakao";
export type HistoryPlatform = Extract<Platform, "discord" | "slack">;

export interface Route {
  platform: Platform;
  accountId: string;
  authorityId: string;
  guildId: string | null;
  channelId: string;
  threadId: string | null;
  /** Coordination-only topic (DM or supported owner parent channel), never a physical channel/thread ID. */
  topicId?: string;
}

export function routeKey(route: Route): string {
  const identity = [
    route.platform, route.accountId, route.authorityId,
    route.guildId, route.channelId, route.threadId,
  ];
  // Preserve all existing physical-route keys in already-created ledgers.
  if (route.topicId !== undefined) identity.push(route.topicId);
  return JSON.stringify(identity);
}

export function physicalRoute(route: Route): Route {
  const { topicId: _topic, ...physical } = route;
  return physical;
}

export function physicalRouteKey(route: Route): string {
  return routeKey(physicalRoute(route));
}

/** Deferred intake shares order across threads and logical topics of a channel or DM. */
export function routingConversation(route: Route): string {
  return routeKey({ ...physicalRoute(route), threadId: null });
}

/** Syntax only: these candidates still require current receipt and route authority. */
export function deferredRecoveryCandidate(text: string) {
  const match = /^\/(restart|stop)(?:\s+(\S+))?$/u.exec(text.trim());
  if (!match) return null;
  const [, name, argument] = match;
  if (name === "restart") return argument ? null : { kind: "restart" } as const;
  if (!argument) return { kind: "bare-stop" } as const;
  if (argument === "head") return { kind: "head-stop" } as const;
  return { kind: "lane-stop", laneId: argument } as const;
}

/** Reserved legacy synthetic identities; never a source of work or authority. */
export function isRetiredScopeInput(id: string): boolean {
  return id.startsWith("scope-review:") || id.startsWith("handoff:scope-review:");
}

/** Exact successor generation reserved when a submitted card is authorized to restore its original lane session. */
export const laneModelPickerRestoreKey = (sourceId: string) => `lane-model:picker-restore:${sourceId}`;

export interface Attachment {
  id: string;
  name: string;
  /** Token-free resource reference; only the owning adapter resolves it. */
  url: string;
  /** null means the platform did not declare a size; zero is a known empty file. */
  size: number | null;
  contentType?: string;
  voice?: true;
  durationSeconds?: number;
}

/** Untrusted contextual snapshot, never sender authority, command text, or routing. */
export interface ReplyContext {
  messageId: string;
  authorId: string | null;
  text: string | null;
  quote?: string;
}

/** Untrusted observations, never instructions, authority, or automatic routing policy.
 * For threads, channel describes the parent and thread describes the destination.
 * Missing optional properties mean unavailable; a null topic is an observed empty topic.
 */
export interface DiscordContext {
  readonly kind: "guild" | "dm";
  readonly channel: {
    readonly id: string;
    readonly name?: string;
    readonly topic?: string | null;
    readonly purpose?: string;
  };
  readonly thread?: { readonly id: string; readonly parentId: string; readonly name?: string; readonly purpose?: string };
}

export type DiscordPurposeRequest = {
  readonly sourceId: string;
  readonly route: Route;
} & (
  | { readonly action: "list" }
  | { readonly action: "set"; readonly purpose: string }
  | { readonly action: "clear" }
);
export interface DiscordPurposeNote { readonly route: Route; readonly purpose: string }

export type PresenceAction = "start" | "status" | "stop";
export interface MessengerPresenceRequest {
  readonly action: PresenceAction;
  readonly sourceId: string;
  readonly route: Route;
}
export interface DiscordPresenceStatus {
  readonly platform: "discord";
  readonly desired: "default" | "online" | "invisible";
  readonly connection: "connected" | "disconnected";
  /** Last presence written on this authenticated socket, not a Discord UI acknowledgement. */
  readonly lastSent: "online" | "invisible" | null;
  readonly replayed: boolean;
}

export interface Inbound {
  id: string;
  route: Route;
  /** Actual platform message ID; application commands have no source message. */
  messageId: string | null;
  /** Discord's actual interaction snowflake, never its response token. */
  interactionId?: string;
  /** Slack's scoped SHA256 trigger fingerprint, never a message timestamp or capability. */
  invocationId?: string;
  /** Authenticated card selection; not a platform message, approval, or topic boundary. */
  readonly pickerSelection?: {
    readonly outputId: string;
    readonly cardId: string;
    readonly group: number;
    readonly option: number;
    /** Emitted only when the final model choice is made on a scoped Discord card. */
    readonly target?: "head" | "lane";
    /** Emitted only by the reset picker's separate Confirm action. */
    readonly confirmed?: true;
  };
  text: string;
  /** Physical Discord content when `text` is an addressed command or a confirmed voice draft. */
  readonly discordOriginalText?: string;
  /** Adapter-verified routing-only view; an empty string excludes the entire message. */
  readonly routingText?: string;
  /** Telegram's authenticated formatting verdict; absent on pre-upgrade receipts. */
  readonly telegramProtectedCommand?: boolean;
  /** Original Telegram text or caption when an addressed bot suffix was removed. */
  readonly telegramOriginalText?: string;
  receivedAt: number;
  attachments: Attachment[];
  reply?: ReplyContext;
  /** The adapter observed a reply or shared message without an in-route reply snapshot. */
  readonly unresolvedReply?: true;
  discordContext?: DiscordContext;
}

/** A real platform message that can be fetched, reacted to, or used as a thread source. */
export interface MessageReference {
  route: Route;
  messageId: string;
}

export type WorkState = "open" | "paused" | "completed" | "cancelled";
export type RuntimeState = "unloaded" | "starting" | "running" | "idle" | "interrupted";
export interface LaneModel {
  provider: string;
  id: string;
}
export const laneFallbackKey = (id: string) => `lane-model:${id}:fallback`;
export interface LaneFallbackReceipt {
  readonly sessionId: string;
  readonly generation: number;
  readonly hostPid: number;
  readonly entryId: string;
}
export const HEAD_MODEL_CONTROL = "head:model-control";
export interface HeadModelChange {
  readonly sourceId: string;
  readonly model: LaneModel;
}
export const MODEL_PRESET_NAMES = ["high", "middle", "low"] as const;
export type ModelPreset = string;
export type LanePresetSnapshot = NativeModelPreset;
export interface ResolvedLanePreset {
  model: LaneModel;
  preset: ModelPreset;
  snapshot: LanePresetSnapshot;
}
export interface LaneModelChoice {
  model?: LaneModel;
  preset?: ModelPreset;
}
/** Observations, not verified acceptance, execution authority, or a live-state guarantee. */
export interface LaneObservation {
  inputId: string;
  requestId: string;
  sessionId: string;
  generation: number;
  lastReportAt: number;
  summary: string;
  lastEvidenceAt: number | null;
  lastEvidence: (LaneEvidence & { at: number }) | null;
  waiting: { target: LaneWaitTarget; since: number } | null;
}
export interface Lane {
  id: string;
  title: string;
  route: Route;
  cwd: string;
  repoRoot: string | null;
  /** Immutable remote ownership; absent for a local lane, including legacy rows. */
  readonly remote?: RemotePlacement;
  brief: string;
  acceptance: string[];
  /** Null only for pre-selection records awaiting native-state adoption. */
  model: LaneModel | null;
  modelReason: string | null;
  /** Preset label at selection time, never a live link to mutable configuration. */
  modelPreset: ModelPreset | null;
  modelPresetSnapshot: LanePresetSnapshot | null;
  workState: WorkState;
  runtimeState: RuntimeState;
  sessionFile: string;
  sessionId: string | null;
  socketPath: string;
  generation: number;
  pid: number | null;
  createdAt: number;
  lastActivityAt: number;
  result: string | null;
  observation?: LaneObservation;
}

export type InputState = "pending" | "submitted" | "done" | "uncertain" | "cancelled";
export type ActiveInputState = Extract<InputState, "pending" | "submitted" | "uncertain">;
export const WORKFLOW_NAMES = ["super", "super-plan", "super-loop", "super-run", "super-graph", "super-research", "jevify"] as const;
export type WorkflowName = typeof WORKFLOW_NAMES[number];
export interface WorkflowChoice {
  name: WorkflowName;
  reason: string;
}
/** An activation request, not proof of native arming or native goal creation. */
export interface WorkflowActivation extends WorkflowChoice {
  sourceId: string;
  provenance: "user" | "head";
}
export interface InputRecord extends Inbound {
  workflow: WorkflowActivation | null;
  target: string | null;
  state: InputState;
  requestId: string | null;
  generation: number | null;
}

export type OutputState = "pending" | "sending" | "sent" | "uncertain" | "failed";
export type HeadPicker = {
  readonly sessionId: string;
  readonly generation: number;
  readonly expiresAt: number;
  readonly current?: string;
  readonly groups: readonly { readonly label: string; readonly options: readonly string[] }[];
} & (
  | { readonly kind: "model"; readonly currentProvider?: string; readonly modelTargets?: {
    readonly lane?: {
      readonly id: string;
      readonly generation: number;
      readonly sessionId: string | null;
      readonly current?: string;
      readonly currentProvider?: string;
      /** If present, the canonical option indices allowed in each HEAD group. Empty means no lane choices. */
      readonly allowedOptions?: readonly (readonly number[])[];
    };
  } }
  | { readonly kind: "effort"; readonly forModel: LaneModel }
  | { readonly kind: "fast"; readonly forModel: LaneModel }
  | { readonly kind: "usage-reset"; readonly accounts: readonly Pick<OmpResetAccount, "target" | "label" | "identity" | "offer">[] }
);

/** Both admission and durable lane writes resolve the same original card coordinates. */
export function resolvePickerOption(picker: HeadPicker, selection: NonNullable<Inbound["pickerSelection"]>) {
  if (!Number.isSafeInteger(selection.group) || selection.group < 0
    || !Number.isSafeInteger(selection.option) || selection.option < 0) return null;
  if (selection.target === "lane") {
    const lane = picker.kind === "model" ? picker.modelTargets?.lane : undefined;
    if (!lane || lane.allowedOptions !== undefined && !lane.allowedOptions?.[selection.group]?.includes(selection.option)) return null;
  }
  const group = picker.groups[selection.group];
  const option = group?.options[selection.option];
  return group && option ? { group, option } : null;
}

export interface KickoffHold {
  readonly outputId: string;
  readonly state: OutputState | "missing";
}
export interface OutputRecord {
  id: string;
  sourceId: string;
  route: Route;
  /** Durable original owner message, only in the same physical conversation. */
  replyTo?: MessageReference & { readonly requireExisting?: true };
  /** Discord status message replaced in place; fixed when the output is claimed. */
  readonly editOf?: MessageReference;
  /** Initial Discord status message; overflow falls back to one attachment instead of multi-message split. */
  readonly status?: boolean;
  readonly picker?: HeadPicker;
  readonly resultAttachment?: StagedResultAttachment;
  text: string;
  state: OutputState;
  remoteId: string | null;
  error: string | null;
}

export type SettlementOutput = Pick<OutputRecord, "id" | "text" | "picker"> & {
  /** Physically distinct Discord HEAD steers proved to precede this shared answer. */
  readonly discordHeadFollowups?: readonly string[];
  /** Controller-only lane failure routing, never derived from output text. */
  readonly laneFailure?: "quota" | "recover";
};

export interface LaneRecoveryScope {
  readonly lane: Lane;
  readonly failed: InputRecord;
  readonly original: InputRecord;
}

export interface Approval {
  id: string;
  target: string;
  generation: number;
  requestId: string;
  route: Route;
  request: Record<string, unknown>;
  state: "pending" | "answered" | "cancelled";
  remoteId: string | null;
  decision?: { id: string; sourceId: string | null; sessionId: string };
  /** Presentation only; not part of the original native question or card identity. */
  readonly ownerContext?: string;
}

export interface ApprovalResolution {
  response?: DialogResponse;
  reason?: string;
  sourceId?: string;
  headSelection?: { readonly reviewId: string; readonly reason: string };
}

export interface HeadRecoveryDecision {
  attemptId: string;
  decision: "release" | "hold";
  evidenceEntryIds: string[];
  reason: string;
}

export interface HeadRecoveryAttempt {
  attemptId: string;
  inputId: string;
  requestId: string;
  generation: number;
  sessionId: string;
  sessionFile: string;
  hostPid: number;
  recoveryRequestId: string;
  promptDigest: string;
  stopBoundary: string | null;
  cursor: string | null;
  boundary: string;
  evidenceEntryIds: string[];
  evidenceFingerprint: string;
  state: "prepared" | "submitted" | "decided" | "settled" | "held";
  decision?: HeadRecoveryDecision;
  outcome?: "done" | "cancelled";
  blocked?: boolean;
  abandonedByOwner?: true;
}

export interface HeadRecoveryEffect {
  id: string;
  kind: string;
  state: string;
}

/** A known failure is terminal; an unrecognized state is not evidence of settlement. */
export function headRecoveryEffectsSettled(effects: readonly HeadRecoveryEffect[]): boolean {
  return effects.every(({ state }) => state === "sent" || state === "complete" || state === "failed");
}

/** Ordered HEAD receipts for owner inputs still waiting for topic routing. */
export interface DeferredRoutingPort {
  enqueue(input: Inbound): void;
  /** Verify an existing deferred receipt and refresh eligible attachment URLs without changing order. */
  reconcile(input: Inbound): boolean;
  input(id: string): Inbound | null;
  has(id: string): boolean;
  head(conversation: string): string | null;
  conversations(): readonly string[];
  priority(conversation: string, includeBare: boolean): Iterable<Inbound>;
  earlierLaneStops(lane: Pick<Lane, "id" | "route">, beforeId: string): Iterable<Inbound>;
  hasEarlierMessage(input: Pick<Inbound, "id" | "route">, messageId: string): boolean;
  /** IDs before this queued receipt, or all currently queued IDs for fresh direct admission. */
  idsBefore(id: string): readonly string[];
  remove(id: string): void;
}

export interface StorePort {
  readonly deferredRouting: DeferredRoutingPort;
  /** Typed, noninteractive work on the confirmed bot offer; never valid for ordinary owner intake. */
  receivePrWork(input: Inbound, target: string | null, round: ReviewRound): boolean;
  receive(input: Inbound, target: string | null, metadata?: Readonly<Record<string, string>>, workflow?: WorkflowActivation | null): boolean;
  input(id: string): InputRecord | null;
  ownerSource(id: string): InputRecord | null;
  /** Revalidate a report's exact failed admission, actionable owner and operator selection. */
  laneRecoveryScope(reportId: string): LaneRecoveryScope | null;
  /** Original parent route for a redirected report or a handoff derived from that report. */
  reportApprovalSource(id: string): InputRecord | null;
  /** Manager handoff's verified reply route, pinned for a parent-origin thread follow-up or a joined bound reply. */
  laneReplyRoute(input: InputRecord, source: InputRecord): Route;
  /** Exact original owner and authorized delivery route for a topic-owned lane input. */
  topicDelivery(id: string): { readonly source: InputRecord; readonly route: Route; readonly outputSourceId: string } | null;
  /** Whether an unowned dialog could belong to a durable topic admission on this native generation. */
  hasTopicAdmission(target: string, generation: number): boolean;
  /** A timely owner choice or stop on the original route is durably admitted by Gateway and still awaiting its head receipt. */
  hasPendingTopicChoice(input: InputRecord, deadline: number): boolean;
  /** At expiry, save the automatic pin (empty means current context) only if the same pending question still has no owner choice or Gateway fence. */
  tryAutoTopicChoice(input: InputRecord, deadline: number, pin: string): boolean;
  inputs(target?: string, state?: ActiveInputState): InputRecord[];
  hasInput(target: string, state: ActiveInputState): boolean;
  /** Latest admitted lane run, excluding inputs joined to another run. */
  latestLaneRun(target: string): InputRecord | null;
  /** A successful lane run still has an unresolved final report or delivery. */
  hasPendingLaneResult(target: string): boolean;
  hasPendingLanePlacement(target: string): boolean;
  /** Check both transfer endpoints without reading their queued messages or private dialog contents. */
  hasWorkerMemoryHold(target: string): boolean;
  /** Optional maintenance must never wait for a competing Gateway writer. */
  tryWorkerMemoryMeta(keys: string | readonly string[], value: string): boolean;
  /** An uncertain HEAD input with a nonempty original native-owner record. */
  hasHeadRecoveryInput(): boolean;
  /** No automatic head replacement while an original HEAD delivery is unresolved. */
  hasUnresolvedHeadDelivery(): boolean;
  /** Any queued or held coordination work makes hibernating the controller unsafe. */
  hasHeadSleepWork(): boolean;
  kickoffHold(target: string): KickoffHold | null;
  /** The first authorized revision on the physical route, even after settlement. */
  firstAdmittedMessage(route: Route, messageId: string): InputRecord | null;
  /** A physically later owner message (or revision of this original) was already admitted in this exact topic. */
  isLateTopicOriginal(source: InputRecord): boolean;
  /** Exact logical child of a parent reply; unverified evidence must not select a stop target. */
  repliedParentTopic(route: Route, messageId: string): Lane | "unverified" | null;
  /** Workspace evidenced by a placed owner message or a confirmed bot reply on this physical route. */
  repliedTopicWorkspace(route: Route, messageId: string): string | null;
  /** Exact HEAD lane_start placement, including its confirmed kickoff. */
  headLanePlacement(sourceId: string): Lane | "unverified" | null;
  /** Resolve one physical reply without treating its quoted content as identity. */
  repliedStop(route: Route, messageId: string):
    | { readonly kind: "lane"; readonly lane: Lane; readonly unplaced: readonly InputRecord[] }
    | { readonly kind: "workspace"; readonly sourceId: string }
    | { readonly kind: "sources"; readonly sources: readonly InputRecord[] }
    | { readonly kind: "unverified" | "unknown" };
  isDiscordWorkspaceQuestion(route: Route, messageId: string): boolean;
  sentOutputForMessage(route: Route, messageId: string): OutputRecord | null;
  /** Actual authorized message IDs in durable admission order; not invocation or edit IDs. */
  admittedMessageIds(route: Route): Iterable<string>;
  bindInput(id: string, target: string): void;
  submit(id: string, requestId: string, generation: number): boolean;
  /** Reopen the verified lane and submit its goal resume together, without admitting a prompt. */
  submitGoalResume(input: Inbound, target: string, sourceId: string, owner: {
    requestId: string; generation: number; sessionId: string; sessionFile: string; cursor: string | null; goalId?: string;
    scopedWorkOwnerId?: string;
  }, priorWorkState?: Lane["workState"]): InputRecord;
  /** Nonterminal native assistant observation; never settles or dispatches its owner. */
  progress(id: string, generation: number, sessionId: string, eventId: string, text: string, editInPlace?: boolean): boolean;
  recordLaneReport(id: string, generation: number, sessionId: string, eventId: string, report: LaneReport, observedAt?: number): boolean;
  resolveLaneWaiting(id: string, generation: number, sessionId: string, kind: "tool" | "approval", nativeId: string): boolean;
  settle(id: string, state: "done" | "uncertain" | "cancelled", output?: SettlementOutput, headModel?: HeadModelChange, editInPlace?: boolean): boolean;
  settleCronControl(inputId: string, update: CronUpdate): boolean;
  resolveLaneInput(controlId: string, laneId: string, inputId: string, output: { readonly id: string; readonly text: string }): boolean;
  headRecoveryEffects(inputId: string): HeadRecoveryEffect[];
  prepareHeadRecovery(attempt: HeadRecoveryAttempt): boolean;
  commitHeadRecovery(expected: HeadRecoveryAttempt, decided: HeadRecoveryAttempt): boolean;
  queueOutput(output: Omit<OutputRecord, "state" | "remoteId" | "error" | "editOf">): boolean;
  /** Atomically replace this native Host's outstanding job bindings and enqueue observed results. */
  saveHeadJobs(bindingKey: string, owners: readonly (readonly [string, string, string])[],
    outputs?: readonly Pick<OutputRecord, "id" | "sourceId" | "route" | "text">[]): void;
  recordRestartCheckpointFailure(expectedFence: string, stopBoundary: string | null, failedFence: string,
    output: Pick<OutputRecord, "id" | "sourceId" | "route" | "text">): boolean;
  recordHeadHoldNotice(blockerId: string, output: Omit<OutputRecord, "state" | "remoteId" | "error" | "editOf">): boolean;
  output(id: string): OutputRecord | null;
  outputs(physicalRoute?: string): OutputRecord[];
  claimOutput(id: string, editInPlace?: boolean): boolean;
  finishOutput(id: string, state: "sent" | "uncertain" | "failed" | "pending", remoteId?: string, error?: string): void;
  createLane(lane: Lane & { model: LaneModel; modelReason: string }, sourceId: string): Lane;
  lane(id: string): Lane | null;
  laneForRoute(route: Route): Lane | null;
  lanes(): Lane[];
  updateLane(id: string, generation: number, patch: Partial<Pick<Lane,
    "workState" | "runtimeState" | "sessionId" | "pid" | "lastActivityAt" | "result"
  >>): boolean;
  retireLocalLaneHost(expected: Pick<Lane, "id" | "generation" | "pid" | "sessionId" | "socketPath">): boolean;
  nextGeneration(id: string, pickerRestoreSourceId?: string): Lane;
  adoptLaneModel(id: string, generation: number, model: LaneModel, reason: string): boolean;
  changeLaneModel(id: string, generation: number, expected: LaneModel | null, model: LaneModel, reason: string,
    preset: ModelPreset | null, snapshot: LanePresetSnapshot | null, metadata?: Readonly<Record<string, string>>, operatorSourceId?: string): boolean;
  recordLaneFallback(id: string, configured: LaneModel, previous: string | null, receipt: LaneFallbackReceipt,
    notice: Pick<OutputRecord, "id" | "sourceId" | "route" | "text">): boolean;
  putApproval(approval: Approval, ownerInputId?: string): void;
  approval(id: string): Approval | null;
  approvals(target?: string): Approval[];
  /** No Messenger card or automatic native response for a retired approval or its unresolved admission. */
  isNativeApprovalHeld(owner: {
    readonly target: string; readonly generation: number; readonly sessionId: string;
    readonly input?: { readonly id: string; readonly sessionFile: string };
  }, approvalId: string): boolean;
  /** Retired card identities whose original remote dismissal is not yet confirmed. */
  retiredApprovalDismissals(): string[];
  /** Consume the one dismissal attempt only when there is an exact remote card receipt. */
  claimRetiredApprovalDismissal(id: string): Approval | null;
  finishRetiredApprovalDismissal(id: string): void;
  resolveApproval(id: string, generation: number, state: "answered" | "cancelled", resolution?: ApprovalResolution): boolean;
  setApprovalMessage(id: string, remoteId: string): void;
  recoverDeliveries(): void;
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
  completeHistoryBoundary(key: string, cursor: string, sequence: string | null): void;
  close(): void;
}

export interface DialogResponse {
  value?: string;
  confirmed?: boolean;
  cancelled?: boolean;
  answers?: Array<{ id: string; selectedOptions: string[]; customInput?: string }>;
}

export type MessageActivity = "received" | "thinking" | "idle";

export interface GatewayRestartRequest {
  /** Persisted UUID, shared by controller and authenticated Gateway protocol. */
  requestId: string;
  inputId: string;
  ackOutputId: string;
}

/** Durable lifecycle receipt, bound to the original owner input and owned processes. */
export interface GatewayRestartRecord extends GatewayRestartRequest {
  /** Original Gateway and native HEAD, never the one-shot runner. */
  gatewayPid: number;
  headPid: number;
  sessionId: string;
  sessionFile: string;
  state: "accepted" | "head-stopped" | "started" | "refused" | "uncertain" | "failed";
  /** Replacement Gateway PID. The detached runner has a separate private plan identity. */
  successorPid?: number;
  /** Replacement native HEAD PID. */
  replacementPid?: number;
  reason?: string;
}

export interface GatewayRestartNotice {
  requestId: string;
  outcome: "refused" | "uncertain";
  reason: string;
}

export interface ThreadInfo {
  readonly route: Route;
  readonly title: string;
  readonly archived: boolean | null;
  readonly requiresTag: boolean;
  readonly availableTags: readonly { readonly id: string; readonly name: string; readonly moderated: boolean }[];
  readonly appliedTags: readonly string[];
}

export interface ThreadUpdate {
  readonly title?: string;
  readonly appliedTags?: readonly string[];
  readonly archived?: boolean;
}

export interface InboundAttachmentBatch {
  readonly inputId: string;
  readonly route: Route;
  readonly attachments: readonly Attachment[];
}

export interface InboundAttachmentReceipt {
  readonly receipt: string;
  readonly files: readonly { readonly path: string; readonly size: number; readonly mimeType: string; readonly sha256: string }[];
}

export interface Messenger {
  /** Startup history, when needed, is ordered by the authenticated transport. */
  readonly managesStartupHistory?: true;
  start(handlers: {
    /** Authenticate first; do not consume inbound events until native approvals are reconciled. */
    ready?: Promise<void>;
    message(input: Inbound): Promise<void>;
    group?(request: GroupRequest): Promise<void>;
    answer(approvalId: string, response: DialogResponse, route: Route): Promise<void>;
    /** Reconcile a previously attempted answer before retrying its native effect. */
    reconcileAnswer?(approvalId: string, route: Route): Promise<"retry" | "accepted" | "rejected" | "unresolved">;
    /** Pin existing cursors before a fresh Gateway opens ordered intake. */
    reserveStartupHistory?(): void;
    /** A sequence identifies an ordered Gateway gap; false reconciles approvals only. */
    reconnect?(history?: number | false, platform?: HistoryPlatform): Promise<void>;
    /** Owned Gateway lifecycle outcome; never a user instruction or model turn. */
    restart?(notice: GatewayRestartNotice): Promise<void>;
  }): Promise<void>;
  send(output: OutputRecord): Promise<string>;
  sendGroup?(reply: GroupReply): Promise<string>;
  /** Read-only checks for history and already-admitted bound work do not require a drained Gateway queue. */
  assertRoute?(route: Route, purpose?: "history" | "bound-work"): void | Promise<void>;
  /** Cosmetic own reactions on the original message; never an admission or completion receipt. */
  setActivity?(message: MessageReference, activity: MessageActivity): Promise<void>;
  showApproval(approval: Approval): Promise<string>;
  dismissApproval(approval: Approval): Promise<void>;
  /** Read-only authenticated capability probe; false is unsupported, not a failed creation. */
  canCreateThread?(route: Route, appliedTags?: readonly string[], placementSource?: Route): Promise<boolean>;
  createThread(route: Route, title: string, sourceMessageId?: string, appliedTags?: readonly string[], placementSource?: Route): Promise<Route>;
  /** Optional native thread management; unsupported transports must not simulate it. */
  inspectThread?(route: Route, placementSource?: Route): Promise<ThreadInfo>;
  updateThread?(route: Route, update: ThreadUpdate): Promise<ThreadInfo>;
  inspectDiscordContext?(route: Route): Promise<DiscordContext>;
  discordPurpose?(request: DiscordPurposeRequest): Promise<readonly DiscordPurposeNote[]>;
  messengerPresence?(request: MessengerPresenceRequest): Promise<DiscordPresenceStatus>;
  /** null means adapter-owned recovery. An ordered read uses the Gateway's saved gap cutoff. */
  fetchAfter(route: Route, messageId: string, historySequence?: number): Promise<Inbound[] | null>;
  /** Validate the source before fetching; receipt only a complete, private batch. */
  openAttachment(batch: InboundAttachmentBatch, signal: AbortSignal): Promise<InboundAttachmentReceipt>;
  stop(): Promise<void>;
}
