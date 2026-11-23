import type { ModelPreset as NativeModelPreset } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import type { LaneEvidence, LaneReport, LaneWaitTarget } from "./lane-report";
import type { CronUpdate } from "./cron-jobs";
import type { GroupReply, GroupRequest } from "./group-policy";
import type { StagedResultAttachment } from "./result-attachment";
import type { RemotePlacement } from "./worker-wire";

/** Coordination records only. OMP owns transcripts and execution state. */
export type Platform = "discord" | "telegram" | "slack";

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
  };
  text: string;
  /** Physical Discord content when `text` is an addressed command or a confirmed voice draft. */
  readonly discordOriginalText?: string;
  /** Adapter-verified routing-only view; an empty string excludes the entire message. */
  readonly routingText?: string;
  receivedAt: number;
  attachments: Attachment[];
  reply?: ReplyContext;
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
  | { readonly kind: "model"; readonly currentProvider?: string }
  | { readonly kind: "effort"; readonly forModel: LaneModel }
);

export interface KickoffHold {
  readonly outputId: string;
  readonly state: OutputState | "missing";
}
export interface OutputRecord {
  id: string;
  sourceId: string;
  route: Route;
  /** Durable original owner message, only in the same physical conversation. */
  replyTo?: MessageReference;
  /** Discord status message replaced in place; fixed when the output is claimed. */
  readonly editOf?: MessageReference;
  readonly picker?: HeadPicker;
  readonly resultAttachment?: StagedResultAttachment;
  text: string;
  state: OutputState;
  remoteId: string | null;
  error: string | null;
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

export interface StorePort {
  receive(input: Inbound, target: string | null, metadata?: Readonly<Record<string, string>>, workflow?: WorkflowActivation | null): boolean;
  input(id: string): InputRecord | null;
  ownerSource(id: string): InputRecord | null;
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
  /** An uncertain HEAD input with a nonempty original native-owner record. */
  hasHeadRecoveryInput(): boolean;
  /** No automatic head replacement while an original HEAD delivery is unresolved. */
  hasUnresolvedHeadDelivery(): boolean;
  kickoffHold(target: string): KickoffHold | null;
  /** The first authorized revision on the physical route, even after settlement. */
  firstAdmittedMessage(route: Route, messageId: string): InputRecord | null;
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
  /** Nonterminal native assistant observation; never settles or dispatches its owner. */
  progress(id: string, generation: number, sessionId: string, eventId: string, text: string): boolean;
  recordLaneReport(id: string, generation: number, sessionId: string, eventId: string, report: LaneReport, observedAt?: number): boolean;
  resolveLaneWaiting(id: string, generation: number, sessionId: string, kind: "tool" | "approval", nativeId: string): boolean;
  settle(id: string, state: "done" | "uncertain" | "cancelled", output?: Pick<OutputRecord, "id" | "text" | "picker">, headModel?: HeadModelChange): boolean;
  settleCronControl(inputId: string, update: CronUpdate): boolean;
  resolveLaneInput(controlId: string, laneId: string, inputId: string, output: { readonly id: string; readonly text: string }): boolean;
  headRecoveryEffects(inputId: string): HeadRecoveryEffect[];
  prepareHeadRecovery(attempt: HeadRecoveryAttempt): boolean;
  commitHeadRecovery(expected: HeadRecoveryAttempt, decided: HeadRecoveryAttempt): boolean;
  queueOutput(output: Omit<OutputRecord, "state" | "remoteId" | "error" | "editOf">): boolean;
  output(id: string): OutputRecord | null;
  outputs(): OutputRecord[];
  claimOutput(id: string): boolean;
  finishOutput(id: string, state: "sent" | "uncertain" | "failed" | "pending", remoteId?: string, error?: string): void;
  createLane(lane: Lane & { model: LaneModel; modelReason: string }, sourceId: string): Lane;
  lane(id: string): Lane | null;
  laneForRoute(route: Route): Lane | null;
  lanes(): Lane[];
  updateLane(id: string, generation: number, patch: Partial<Pick<Lane,
    "workState" | "runtimeState" | "sessionId" | "pid" | "lastActivityAt" | "result"
  >>): boolean;
  nextGeneration(id: string): Lane;
  adoptLaneModel(id: string, generation: number, model: LaneModel, reason: string): boolean;
  changeLaneModel(id: string, generation: number, expected: LaneModel | null, model: LaneModel, reason: string,
    preset: ModelPreset | null, snapshot: LanePresetSnapshot | null, metadata?: Readonly<Record<string, string>>): boolean;
  putApproval(approval: Approval, ownerInputId?: string): void;
  approval(id: string): Approval | null;
  approvals(target?: string): Approval[];
  resolveApproval(id: string, generation: number, state: "answered" | "cancelled", resolution?: ApprovalResolution): boolean;
  setApprovalMessage(id: string, remoteId: string): void;
  recoverDeliveries(): void;
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
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

export interface Messenger {
  start(handlers: {
    /** Authenticate first; do not consume inbound events until native approvals are reconciled. */
    ready?: Promise<void>;
    message(input: Inbound): Promise<void>;
    group?(request: GroupRequest): Promise<void>;
    answer(approvalId: string, response: DialogResponse, route: Route): Promise<void>;
    /** Reconcile a previously attempted answer before retrying its native effect. */
    reconcileAnswer?(approvalId: string, route: Route): Promise<"retry" | "accepted" | "rejected" | "unresolved">;
    reconnect?(): Promise<void>;
    /** Owned Gateway lifecycle outcome; never a user instruction or model turn. */
    restart?(notice: GatewayRestartNotice): Promise<void>;
  }): Promise<void>;
  send(output: OutputRecord): Promise<string>;
  sendGroup?(reply: GroupReply): Promise<string>;
  /** Verify the authenticated adapter. History is read-only and may run before intake is acknowledged. */
  assertRoute?(route: Route, purpose?: "history"): void | Promise<void>;
  /** Cosmetic own reactions on the original message; never an admission or completion receipt. */
  setActivity?(message: MessageReference, activity: MessageActivity): Promise<void>;
  showApproval(approval: Approval): Promise<string>;
  dismissApproval(approval: Approval): Promise<void>;
  /** Read-only authenticated capability probe; false is unsupported, not a failed creation. */
  canCreateThread?(route: Route, appliedTags?: readonly string[]): Promise<boolean>;
  createThread(route: Route, title: string, sourceMessageId?: string, appliedTags?: readonly string[]): Promise<Route>;
  /** Optional native thread management; unsupported transports must not simulate it. */
  inspectThread?(route: Route): Promise<ThreadInfo>;
  updateThread?(route: Route, update: ThreadUpdate): Promise<ThreadInfo>;
  inspectDiscordContext?(route: Route): Promise<DiscordContext>;
  discordPurpose?(request: DiscordPurposeRequest): Promise<readonly DiscordPurposeNote[]>;
  messengerPresence?(request: MessengerPresenceRequest): Promise<DiscordPresenceStatus>;
  /** null explicitly means no history API; intake recovery belongs to the adapter. */
  fetchAfter(route: Route, messageId: string): Promise<Inbound[] | null>;
  /** Validate platform/auth destination before fetching. Never follow redirects with credentials. */
  openAttachment(route: Route, attachment: Attachment, signal: AbortSignal): Promise<Response>;
  stop(): Promise<void>;
}
