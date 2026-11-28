import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { getAgentDbPath } from "@oh-my-pi/pi-utils/dirs";
import { authorizeRoute, type Config } from "../config/config";
import type { InputRecord, Route, StorePort } from "../contracts";
import { messengerCommandText, telegramCommandBlocked } from "../messaging/messenger-commands";
import { discordWorkThreadSource } from "../messaging/discord-work-thread";
import { discardResultAttachment, isOriginalAttachmentMessage, pruneResultAttachments, readResultAttachmentIntent,
  readResultAttachmentStart, requestedResultPath, ResultAttachmentError, stageResultAttachment,
  type ResultAttachmentIntent, type ResultAttachmentPayload } from "../messaging/result-attachment";

type AttachmentRun = {
  readonly id: string;
  readonly generation: number;
  readonly sessionId: string;
  readonly input?: Pick<InputRecord, "requestId">;
  readonly running: boolean;
  readonly ownedRuns: number;
  readonly result?: object;
  readonly recovery?: object;
  readonly admitted: ReadonlyMap<string, { readonly input: Pick<InputRecord, "id"> }>;
};

type AttachmentStart = NonNullable<ReturnType<typeof readResultAttachmentStart>> & {
  readonly ownerRequestId: string;
  readonly toolName: unknown;
};

type AttachmentBinding = {
  readonly source: InputRecord;
  readonly input: InputRecord;
  readonly outputSourceId: string;
  readonly route: Route;
};

export class ResultAttachments {
  private readonly starts = new WeakMap<AttachmentRun, Map<string, AttachmentStart>>();

  constructor(private readonly config: Config,
    private readonly store: Pick<StorePort, "lane" | "input" | "topicDelivery" | "getMeta" | "output" | "queueOutput">,
    private readonly delivery: {
      readonly headSessionFile: () => string;
      readonly wakeOutputs: (route: Route) => void;
      readonly report: (error: unknown) => void;
    }) {}

  prune(): void {
    if (!existsSync(join(this.config.stateDir, "result-attachments"))) return;
    try { pruneResultAttachments(this.config.stateDir); }
    catch (error) { this.delivery.report(error); }
  }

  authorizeOwner(route: Route): void {
    // Route eligibility can include restricted group members. Only the
    // configured platform owner can disclose files from the local filesystem.
    if (route.authorityId !== this.config[route.platform]?.ownerId) {
      throw new ResultAttachmentError("Result attachments require the configured messenger owner");
    }
    if (!authorizeRoute(this.config, route) && !discordWorkThreadSource(this.config, this.store, route))
      throw new Error("Unauthorized messenger route");
  }

  queue(run: AttachmentRun, intent: ResultAttachmentIntent, admission: {
    readonly binding: AttachmentBinding;
    readonly canPublish: () => boolean;
  }): string {
    const { source, input, outputSourceId, route } = admission.binding;
    const lane = run.id === "main" ? null : this.store.lane(run.id);
    if (run.id !== "main" && !lane) throw new Error(`Unknown lane: ${run.id}`);
    if (lane?.remote) throw new ResultAttachmentError("Remote result files cannot be staged on the head");
    const sessionFile = lane?.sessionFile ?? this.delivery.headSessionFile();
    if (!admission.canPublish() || !run.running || run.ownedRuns !== 1 || run.result || run.recovery
      || (lane && lane.workState !== "open") || intent.sessionFile !== sessionFile || intent.sessionId !== run.sessionId
      || input.state !== "submitted" || input.generation !== run.generation || input.target !== run.id || !input.requestId
      || run.admitted.get(input.requestId)?.input.id !== input.id || source.state === "cancelled" || source.state === "uncertain"
      || this.store.getMeta(`user-source:${source.id}`) !== "true" || !isOriginalAttachmentMessage(source)) {
      throw new ResultAttachmentError("Result attachments require the original owner input in the current native run");
    }
    this.authorizeOwner(source.route);
    this.authorizeOwner(route);
    if (telegramCommandBlocked(source) || requestedResultPath(messengerCommandText(source)) !== intent.path)
      throw new ResultAttachmentError("The owner did not explicitly request this exact result file in the current message");
    const id = `result-attachment:${source.id}`;
    const existing = this.store.output(id);
    if (existing) return `Result attachment ${id} is ${existing.state}; no new attempt was made.`;
    const agentDb = getAgentDbPath();
    const payload = stageResultAttachment(intent.path, {
      stateDir: this.config.stateDir,
      cwd: lane?.cwd ?? this.config.headCwd,
      privatePaths: [this.config.stateDir, this.config.path, `${this.config.path}.env`, getAgentDir(), sessionFile,
        agentDb, `${agentDb}-wal`, `${agentDb}-shm`, `${agentDb}-journal`].map(path => resolve(path)),
    });
    try {
      this.store.queueOutput({
        id, sourceId: outputSourceId, route, text: "",
        resultAttachment: {
          payload, sourceId: source.id, inputId: input.id, requestId: input.requestId,
          generation: run.generation, sessionId: run.sessionId, sessionFile, toolCallId: intent.toolCallId,
        },
      });
    } catch (error) {
      this.discard(payload);
      throw error;
    }
    this.delivery.wakeOutputs(route);
    return `Result attachment ${id} was durably queued to the original topic, not yet confirmed delivered.`;
  }

  clearStarts(run: AttachmentRun): void { this.starts.delete(run); }

  observe(run: AttachmentRun, frame: Record<string, unknown>, canPublish: () => boolean): void {
    const ownerRequestId = run.input?.requestId;
    if (run.id === "main" || !ownerRequestId || !run.running || run.ownedRuns !== 1 || run.recovery
      || typeof frame.toolCallId !== "string") return;
    if (frame.type === "tool_execution_start") {
      const args = readResultAttachmentStart(frame);
      if (args) {
        let starts = this.starts.get(run);
        if (!starts) this.starts.set(run, starts = new Map());
        starts.set(frame.toolCallId, { ...args, ownerRequestId, toolName: frame.toolName });
      }
      return;
    }
    const starts = this.starts.get(run);
    const start = starts?.get(frame.toolCallId);
    starts?.delete(frame.toolCallId);
    if (!start || start.ownerRequestId !== ownerRequestId || start.toolName !== frame.toolName) return;
    const intent = readResultAttachmentIntent(frame);
    if (!intent || intent.sourceId !== start.sourceId || intent.path !== start.path) return;
    // Only matched live execution events may introduce a file effect. The
    // journal is not permission to reopen a path or replay after disconnect.
    for (const { input } of run.admitted.values()) {
      const native = this.store.input(input.id);
      const topic = native && this.store.topicDelivery(native.id);
      if (!native || topic?.source.id !== intent.sourceId) continue;
      try { this.queue(run, intent, { binding: { ...topic, input: native }, canPublish }); }
      catch (error) { this.delivery.report(error); }
      return;
    }
  }

  discard(payload: ResultAttachmentPayload | undefined): void {
    if (!payload || !("snapshotId" in payload)) return;
    try { discardResultAttachment(this.config.stateDir, payload.snapshotId); }
    catch (error) { this.delivery.report(error); }
  }
}
