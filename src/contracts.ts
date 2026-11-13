import type { ModelPreset as NativeModelPreset } from "@oh-my-pi/pi-coding-agent/config/model-settings";

/** Coordination records only. OMP owns transcripts and execution state. */
export type Platform = "discord" | "telegram" | "slack";

export interface Route {
  platform: Platform;
  accountId: string;
  authorityId: string;
  guildId: string | null;
  channelId: string;
  threadId: string | null;
  /** Coordination-only DM topic; never a platform channel/thread identifier. */
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
  size: number;
  contentType?: string;
}

export interface Inbound {
  id: string;
  route: Route;
  messageId: string;
  text: string;
  receivedAt: number;
  attachments: Attachment[];
}

export type WorkState = "open" | "paused" | "completed" | "cancelled";
export type RuntimeState = "unloaded" | "starting" | "running" | "idle" | "interrupted";
export interface LaneModel {
  provider: string;
  id: string;
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
export interface Lane {
  id: string;
  title: string;
  route: Route;
  cwd: string;
  repoRoot: string | null;
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
}

export type InputState = "pending" | "submitted" | "done" | "uncertain" | "cancelled";
export const WORKFLOW_NAMES = ["ulw", "mass-ulw", "ulw-plan", "ulw-loop", "ulw-execute", "ulw-research"] as const;
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
export interface OutputRecord {
  id: string;
  sourceId: string;
  route: Route;
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
}

export interface StorePort {
  receive(input: Inbound, target: string | null, metadata?: Readonly<Record<string, string>>, workflow?: WorkflowActivation | null): boolean;
  input(id: string): InputRecord | null;
  inputs(target?: string): InputRecord[];
  bindInput(id: string, target: string): void;
  submit(id: string, requestId: string, generation: number): boolean;
  settle(id: string, state: "done" | "uncertain" | "cancelled", output?: { id: string; text: string }): boolean;
  queueOutput(output: Omit<OutputRecord, "state" | "remoteId" | "error">): boolean;
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
  putApproval(approval: Approval): void;
  approval(id: string): Approval | null;
  approvals(target?: string): Approval[];
  resolveApproval(id: string, generation: number, state: "answered" | "cancelled"): boolean;
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

export interface Messenger {
  start(handlers: {
    /** Authenticate first; do not consume inbound events until native approvals are reconciled. */
    ready?: Promise<void>;
    message(input: Inbound): Promise<void>;
    answer(approvalId: string, response: DialogResponse, route: Route): Promise<void>;
    /** Reconcile a previously attempted answer before retrying its native effect. */
    reconcileAnswer?(approvalId: string, route: Route): Promise<"retry" | "accepted" | "rejected" | "unresolved">;
    reconnect?(): Promise<void>;
  }): Promise<void>;
  send(output: OutputRecord): Promise<string>;
  showApproval(approval: Approval): Promise<string>;
  dismissApproval(approval: Approval): Promise<void>;
  createThread(route: Route, title: string, sourceMessageId?: string): Promise<Route>;
  /** null explicitly means no history API; intake recovery belongs to the adapter. */
  fetchAfter(route: Route, messageId: string): Promise<Inbound[] | null>;
  /** Validate platform/auth destination before fetching. Never follow redirects with credentials. */
  openAttachment(route: Route, attachment: Attachment, signal: AbortSignal): Promise<Response>;
  stop(): Promise<void>;
}
