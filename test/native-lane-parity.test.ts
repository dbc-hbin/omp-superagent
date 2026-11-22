import { expect, test } from "bun:test";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { Database } from "bun:sqlite";
import { strict as assert } from "node:assert";
import { EventEmitter, once } from "node:events";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Board, boardRepositoryChannel, workerRepositoryChannel } from "../src/board";
import { hostPaths, parseConfig } from "../src/config";
import type { Approval, DialogResponse, Inbound, Lane, LanePresetSnapshot, Messenger, OutputRecord, Route } from "../src/contracts";
import { HostConnection, startHost } from "../src/host";
import type { HostResponse, HostState } from "../src/host-protocol";
import { activeManagedUlwRevision } from "../src/managed-ulw";
import { remoteConnect } from "../src/remote-worker";
import { Superagent, type RuntimeHost } from "../src/runtime";
import { Store } from "../src/store";
import { stopHostFixtures } from "./fixtures/host-fixture-processes";
import { nativeLaneParityFixture, sshLaneParityFixture, type ParityFixture } from "./fixtures/native-parity-lanes";
import { launchdAvailable } from "./fixtures/worker-launchd";
import { parityLaneReport, parityModel, type ParityLaneReport } from "./fixtures/native-parity-provider";

const nativeTest = process.env.OMP_SUPERAGENT_NATIVE_TEST === "1" ? test : test.skip;
// Opt-in proof against an operator-provisioned worker over real OpenSSH; see docs/OPERATIONS.md.
const sshWorker = process.env.OMP_SUPERAGENT_SSH_WORKER;
// The worker's Host starts through the real gui-domain LaunchAgent and its fixed launcher (macOS).
const launchdTest = launchdAvailable ? test : test.skip;
const sshTest = sshWorker && process.env.OMP_SUPERAGENT_NATIVE_TEST === "1" ? test : test.skip;
const parent: Omit<Route, "threadId"> = { platform: "discord", accountId: "2", authorityId: "1", guildId: "3", channelId: "4" };
type Variant = "model" | "preset";
const presetName = "high";
const presetSnapshot: LanePresetSnapshot = { modelRoles: { default: `${parityModel.provider}/${parityModel.id}` }, defaultThinkingLevel: Effort.Low };
const kickoff = "I will run the parity check in this lane and report back here.";

type Handlers = Parameters<Messenger["start"]>[0];
type Delivery =
  | { readonly kind: "send"; readonly threadId: Route["threadId"]; readonly output: OutputRecord }
  | { readonly kind: "approval"; readonly threadId: Route["threadId"]; readonly approval: Approval }
  | { readonly kind: "dismiss"; readonly threadId: Route["threadId"]; readonly approval: Approval };

/** Records every messenger-visible effect in arrival order, per thread. */
class ParityMessenger implements Messenger {
  readonly deliveries: Delivery[] = [];
  private readonly events = new EventEmitter();
  private readonly sent = new Map<string, OutputRecord>();
  private readonly cards: Approval[] = [];
  private handlers?: Handlers;

  async start(handlers: Handlers): Promise<void> { this.handlers = handlers; }
  async deliver(message: Inbound): Promise<void> {
    assert.ok(this.handlers, "Messenger must be started before fixture intake");
    await this.handlers.ready;
    await this.handlers.message(message);
  }
  async answer(approval: Approval, response: DialogResponse): Promise<void> {
    assert.ok(this.handlers, "Messenger must be started before an approval answer");
    await this.handlers.answer(approval.id, response, approval.route);
  }
  async send(output: OutputRecord): Promise<string> {
    assert.ok(!this.sent.has(output.id), `Duplicate messenger delivery: ${output.id}`);
    const record = structuredClone(output);
    this.sent.set(output.id, record);
    this.deliveries.push({ kind: "send", threadId: output.route.threadId, output: record });
    this.events.emit(output.id);
    return `thread-receipt:${output.id}`;
  }
  async delivered(id: string): Promise<OutputRecord> {
    if (!this.sent.has(id)) {
      try { await once(this.events, id, { signal: AbortSignal.timeout(60_000) }); }
      catch (cause) { throw new Error(`Thread never received ${id}`, { cause }); }
    }
    const output = this.sent.get(id);
    assert.ok(output);
    return output;
  }
  async showApproval(approval: Approval): Promise<string> {
    const card = structuredClone(approval);
    this.cards.push(card);
    this.deliveries.push({ kind: "approval", threadId: approval.route.threadId, approval: card });
    this.events.emit("approval");
    return `approval-card:${approval.id}`;
  }
  async card(threadId: string): Promise<Approval> {
    const find = () => this.cards.find(card => card.route.threadId === threadId);
    if (!find()) {
      try { await once(this.events, "approval", { signal: AbortSignal.timeout(60_000) }); }
      catch (cause) { throw new Error(`Thread ${threadId} never received an approval card`, { cause }); }
    }
    const card = find();
    assert.ok(card, `Thread ${threadId} never received an approval card`);
    return card;
  }
  async dismissApproval(approval: Approval): Promise<void> {
    this.deliveries.push({ kind: "dismiss", threadId: approval.route.threadId, approval: structuredClone(approval) });
  }
  async createThread(): Promise<Route> { throw new Error("Existing thread must never create a new destination"); }
  async fetchAfter(): Promise<Inbound[]> { return []; }
  async openAttachment(): Promise<Response> { throw new Error("Offline fixture has no attachments"); }
  async stop(): Promise<void> { this.handlers = undefined; }
}

function source(threadId: string, messageId: string, text: string): Inbound {
  const route: Route = { ...parent, threadId };
  return { id: `discord:2:message:${messageId}`, messageId, route, text: `/head ${text}`, attachments: [], receivedAt: Date.now() };
}

/** Everything one lane exposes to the owner and to HEAD, with run-specific identifiers replaced. */
interface LaneObservation {
  readonly advertised: {
    readonly tools: { name: string; description: string; parameters: unknown }[];
    readonly modelTools: string[];
    readonly commands: unknown[];
    readonly systemPrompt: string[];
  };
  readonly model: { readonly model: unknown; readonly thinkingLevel: unknown; readonly modelSettings: unknown; readonly settingsScope: unknown };
  readonly managed: { readonly revision: string | null; readonly extensionRevisions: (string | null)[] };
  readonly report: Omit<ParityLaneReport, "managedRevision" | "managedPackagePath" | "extensionArguments" | "modelTools" | "superagentEnvironment">;
  readonly approval: {
    readonly pendingNativeRequests: number;
    readonly trace: { readonly kind: string }[];
    readonly cardOwnerContext: string | undefined;
    readonly stored: { readonly state: string; readonly response: unknown };
    readonly review: { readonly state: string | undefined };
    readonly decision: { readonly state: string; readonly response: unknown; readonly headSelection: unknown };
  };
  /** HEAD's coordination store and HEAD's own board session, as they hold this lane's board traffic. */
  readonly board: {
    readonly stored: { readonly actor: string; readonly role: string; readonly sessionId: string; readonly channel: string;
      readonly text: string; readonly mentions: string[]; readonly replyTo: number | null }[];
    readonly headNotices: { readonly actor: string; readonly role: string; readonly sessionId: string; readonly channel: string;
      readonly mentions: string[]; readonly replyTo: number | null }[];
    readonly headRead: { readonly actor: string; readonly sessionId: string; readonly channel: string; readonly text: string }[];
  };
  readonly reportPath: {
    readonly handoff: { readonly state: string | undefined; readonly target: string | null | undefined };
    readonly head: { readonly state: string | undefined; readonly target: string | null | undefined; readonly mentionsLaneReport: boolean };
    readonly acknowledgements: { readonly count: number; readonly text: string; readonly replyToOriginalMessage: boolean };
  };
}

/** Raw lane facts that are expected to differ or that need a separate, explained comparison. */
interface LaneRaw {
  readonly lane: Lane;
  readonly systemPrompt: string[];
  readonly report: ParityLaneReport;
  readonly sessionState: HostState;
  readonly normalizedPrompt: string[];
  /** Where a remote lane's Host owner runs, as reported by the worker. */
  readonly workerProcess?: Record<string, unknown>;
}

/** The owned Host adapter's get_state is the stock RPC state plus private identity fields, locally and over the worker stream. */
const nativeState = async (host: RuntimeHost): Promise<HostState> => await host.client.getState() as HostState;
interface Exercised { readonly raw: LaneRaw; readonly observed: LaneObservation }
const lines = (text: string[]): string[] => text.join("\n").split("\n");
type AdvertisedCommand = { readonly name: string; readonly source?: string };
const isSkillCommand = (command: unknown): boolean => (command as AdvertisedCommand).source === "skill";
const commandNames = (observation: LaneObservation): string[] =>
  observation.advertised.commands.filter(isSkillCommand).map(command => (command as AdvertisedCommand).name).sort();
/** Prompt lines that a worker account contributes itself: its OS/arch, installed skills, internal URL schemes and platform notes. */
const accountEnvironmentLine = /^- (?:OS|Arch): |^- [a-z0-9][a-z0-9-]*: |^- [a-z]+:\/\/|^- On (?:Linux|macOS|Windows) /;
const onlyIn = (from: string[], other: string[]): string[] => {
  const remaining = new Map<string, number>();
  for (const line of other) remaining.set(line, (remaining.get(line) ?? 0) + 1);
  return from.filter(line => {
    const count = remaining.get(line) ?? 0;
    if (count) remaining.set(line, count - 1);
    return !count && line.trim() !== "";
  });
};
const brief = (text: string[]): string[] => text.map(line => line.length > 120 ? `${line.slice(0, 120)}...` : line);
/** Every observed local/remote difference of one pair, including those the parity assertions deliberately exclude. */
function differences({ local, remote }: { local: Exercised; remote: Exercised }, f: ParityFixture) {
  const [l, r] = [local.raw, remote.raw];
  const tools = (raw: LaneRaw) => (raw.sessionState.dumpTools ?? []).map(tool => tool.name).sort();
  return {
    placement: { local: l.lane.placement ?? null, remote: r.lane.placement },
    sessionDirectory: { local: dirname(l.lane.sessionFile), remote: dirname(r.lane.sessionFile) },
    cwd: { local: f.localCwd, remote: f.workerCwd },
    toolsOnlyLocal: tools(l).filter(name => !tools(r).includes(name)),
    toolsOnlyRemote: tools(r).filter(name => !tools(l).includes(name)),
    skillCommandsOnlyLocal: commandNames(local.observed).filter(name => !commandNames(remote.observed).includes(name)),
    skillCommandsOnlyRemote: commandNames(remote.observed).filter(name => !commandNames(local.observed).includes(name)),
    systemPromptLinesOnlyLocal: brief(onlyIn(lines(l.normalizedPrompt), lines(r.normalizedPrompt))),
    systemPromptLinesOnlyRemote: brief(onlyIn(lines(r.normalizedPrompt), lines(l.normalizedPrompt))),
    managedPackagePath: { local: l.report.managedPackagePath, remote: r.report.managedPackagePath },
    extensionArguments: { local: l.report.extensionArguments, remote: r.report.extensionArguments },
    superagentEnvironment: {
      onlyLocal: l.report.superagentEnvironment.filter(name => !r.report.superagentEnvironment.includes(name)),
      onlyRemote: r.report.superagentEnvironment.filter(name => !l.report.superagentEnvironment.includes(name)),
    },
    hostPid: { local: l.sessionState.hostPid, remote: r.sessionState.hostPid },
    workerProcess: r.workerProcess,
  };
}
const revisionOf = (path: string): string | null => /\/revisions\/([0-9a-f]{40,64})\//.exec(path)?.[1] ?? null;

const scenario = "a remote lane behaves like a local lane under one HEAD runtime";
nativeTest(`${scenario} (loopback worker)`, () => proveParity(nativeLaneParityFixture), 300_000);
launchdTest(`${scenario} (loopback worker, real launchd)`, () => proveParity(root => nativeLaneParityFixture(root, true)), 300_000);
sshTest(`${scenario} (real SSH worker)`, () => proveParity(root => sshLaneParityFixture(root, sshWorker!)), 600_000);

async function proveParity(provision: (root: string) => Promise<ParityFixture>): Promise<void> {
  const root = await mkdtemp(join(await realpath("/tmp"), "onp-"));
  const previousEnvironment = { ...process.env };
  let runtime: Superagent | undefined;
  let head: HostConnection | undefined;
  const connections: RuntimeHost[] = [];
  let fixture: ParityFixture | undefined;
  let headBoardSession: Board | undefined;
  let ledgerReader: Database | undefined;
  let completed = false;
  const runtimeErrors: unknown[] = [];
  try {
    const f = fixture = await provision(root);
    // A local lane inherits HEAD's process environment (the runtime strips only credentials and its own sockets),
    // so the HEAD process itself runs inside the private HEAD account.
    Object.assign(process.env, f.headEnv, { PATH: f.transportPath });
    const rawConfig = {
      command: f.command, headCwd: f.headCwd, stateDir: f.headState, maxHosts: 4, maxSubagents: 4, idleMs: 3_600_000,
      workers: { builder: { destination: f.destination, workerId: f.workerId } },
      discord: { tokenEnv: "UNUSED_NATIVE_PARITY_TOKEN", ownerId: "1", allowedGuildIds: ["3"], allowedChannelIds: ["4"] },
    };
    // A local lane's board extension loads this configuration (OMP_SUPERAGENT_CONFIG) to find HEAD's coordination store.
    await writeFile(join(f.headState, "superagent.json"), JSON.stringify(rawConfig), { mode: 0o600 });
    const config = parseConfig(rawConfig, join(f.headState, "superagent.json"));
    const paths = hostPaths(config, "main");
    await startHost({ ...paths, cwd: f.headCwd, command: f.command, extensionPath: f.provider,
      managedUlwPath: f.managedPackage, env: f.headEnv, subagentConcurrency: 1 });
    head = await HostConnection.connect(paths.socketPath);
    const store = new Store(join(f.headState, "coordination.sqlite"));
    const messenger = new ParityMessenger();
    runtime = new Superagent(config, store, messenger, f.laneExtension, error => runtimeErrors.push(error),
      { resolvePreset: async name => ({ model: parityModel, preset: name, snapshot: structuredClone(presetSnapshot) }) });
    store.setMeta("worker:instance", f.instance);
    await runtime.start();
    // In production HEAD's Host and this runtime are one process, which the Gateway records as the board's owned head;
    // it serves worker-lane boards and posts as `head`. This fixture has no Gateway, so this process is that owned head.
    const headSession = await nativeState(head);
    assert.ok(headSession.sessionFile, "HEAD's Host must report its session file");
    expect(store.getMeta("main:sessionId")).toBe(headSession.sessionId);
    store.setMeta("gateway:head", JSON.stringify({ pid: process.pid, sessionId: headSession.sessionId, sessionFile: headSession.sessionFile, dev: 0, ino: 0 }));
    const coordination = join(f.headState, "coordination.sqlite");
    const headChannel = boardRepositoryChannel(f.headCwd);
    const headBoard = headBoardSession = new Board(coordination, { role: "head", actor: "head", sessionId: headSession.sessionId }, headChannel, headSession.sessionFile);
    const ledger = ledgerReader = new Database(coordination, { readonly: true });

    // A later lane on the same repository channel is also notified of the earlier lane's post (channel subscription).
    const earlierLane = new Map<string, string>();
    const exercise = async (placement: "local" | "remote", variant: Variant, threadId: string, messageId: string): Promise<Exercised> => {
      const input = source(threadId, messageId, `Run the ${placement} ${variant} parity check.`);
      await messenger.deliver(input);
      const ack = await messenger.delivered(`${input.id}:answer`);
      expect(ack).toMatchObject({ text: `Head acknowledged ${input.id}`, replyTo: { route: input.route, messageId } });
      const lane = await runtime!.startLane({
        sourceId: input.id, title: `Parity ${placement} ${variant}`, cwd: placement === "local" ? f.localCwd : f.workerCwd,
        ...(placement === "remote" ? { worker: "builder" } : {}), kickoff,
        ...(variant === "model" ? { model: parityModel } : { preset: presetName }),
        modelReason: "Use the runner's deterministic offline model.",
      });
      expect(lane.route).toEqual(input.route);
      const handoff = `handoff:${input.id}:lane`;
      expect(await messenger.delivered(`${input.id}:kickoff`)).toMatchObject({ sourceId: handoff, route: input.route, text: kickoff });

      // Approval round trip: lane tool -> native UI request -> HEAD review escalates -> messenger card -> answer -> lane.
      const card = await messenger.card(threadId);
      // The lane host is a native RPC endpoint either way; observe it exactly as HEAD does.
      const resident = store.lane(lane.id);
      assert.ok(resident);
      const host = placement === "local" ? await HostConnection.connect(resident.socketPath)
        : await remoteConnect(resident.placement!, f.instance, resident);
      connections.push(host);
      const pending = await nativeState(host);
      // The lane waits on its decision, after its first provider call: a HEAD note mentioning the lane reaches its next provider context.
      const note = headBoard.post(`parity-head-note:${lane.id}`, { text: `HEAD note for ${lane.id}`, mentions: [lane.id] });
      expect(note).toMatchObject({ actor: "head", role: "head", sessionId: headSession.sessionId, channel: headChannel, mentions: [lane.id] });
      const response: DialogResponse = { answers: [{ id: `${card.decision!.id}:0`, selectedOptions: ["Beta"] }] };
      await messenger.answer(card, response);

      const reportId = `report:${handoff}`;
      const acknowledgement = await messenger.delivered(`${reportId}:answer`);
      const laneReportInput = store.input(reportId);
      const text = laneReportInput?.text ?? "";
      const laneReport = parityLaneReport(text);
      assert.ok(laneReport, `Lane report did not carry the lane's observations: ${text}`);

      const state = await nativeState(host);
      // The lane's board identity and channel come from HEAD's verified lane record: its repository, as that placement spells it.
      const laneChannel = placement === "local" ? boardRepositoryChannel(f.localCwd) : workerRepositoryChannel(f.workerCwd);
      const laneIdentity = { role: "lane", actor: lane.id, sessionId: state.sessionId };
      const stored = ledger.query(`SELECT actor, role, session_id AS sessionId, channel, text, mentions, reply_to AS replyTo
        FROM board_messages WHERE session_id = ? ORDER BY id`).all(state.sessionId) as
        { actor: string; role: string; sessionId: string; channel: string; text: string; mentions: string; replyTo: number | null }[];
      expect(stored.map(row => ({ ...row, mentions: JSON.parse(row.mentions) as string[] }))).toEqual([
        { ...laneIdentity, sessionId: state.sessionId, channel: laneChannel, text: `Parity board post from ${lane.id}`, mentions: ["head"], replyTo: null }]);
      // HEAD sees the post as a notice for every lane post, then reads its body.
      const headNotices = headBoard.notices();
      expect(headNotices).toEqual([expect.objectContaining({ ...laneIdentity, channel: laneChannel, mentions: ["head"], replyTo: null })]);
      const headRead = headBoard.read({ thread: headNotices[0]!.thread, unreadOnly: false });
      expect(headRead).toEqual([expect.objectContaining({ ...laneIdentity, channel: laneChannel, text: `Parity board post from ${lane.id}` })]);
      // Board section of the system prompt: this lane's identity and its own repository channel.
      expect((state.systemPrompt ?? []).join("\n")).toContain(`Shared bulletin board identity: ${JSON.stringify(laneIdentity)}. Default channel: ${laneChannel}. `);
      // What the lane's tools returned and what its provider context carried.
      expect(laneReport.board.sequence).toEqual(["decision_ask", "board_post", "board_read"]);
      expect(laneReport.board.post).toMatchObject({ ...laneIdentity, channel: laneChannel, mentions: ["head"] });
      expect(laneReport.board.read.identity).toEqual(laneIdentity);
      expect(laneReport.board.read.subscriptions).toEqual(["general", laneChannel].sort());
      expect(laneReport.board.read.messages).toEqual([{ actor: "head", role: "head", channel: headChannel, mentions: [lane.id], replyTo: null, text: `HEAD note for ${lane.id}` }]);
      const earlier = earlierLane.get(placement);
      expect(laneReport.board.notices.filter(header => header.actor !== "head"))
        .toEqual(earlier ? [{ actor: earlier, role: "lane", channel: laneChannel, mentions: ["head"], replyTo: null }] : []);
      expect(laneReport.board.notices.filter(header => header.actor === "head")).toEqual([{ actor: "head", role: "head", channel: headChannel, mentions: [lane.id], replyTo: null }]);
      const available = await host.request({ type: "get_available_commands" }) as HostResponse;
      assert.ok(available.success && available.command === "get_available_commands");
      const { systemPrompt = [], dumpTools = [] } = state;
      const reviewId = `lane-decision-review:${card.id}`;
      const decision = runtime!.inspectDecision(card.decision!.id);
      const identifiers: [string, string][] = [
        [input.id, "<source>"], [messageId, "<message>"], [lane.id, "<lane>"], [state.sessionId, "<session>"],
        ...earlierLane.has(placement) ? [[earlierLane.get(placement)!, "<earlier-lane>"] as [string, string]] : [],
        [laneChannel, "<lane-channel>"], [placement === "local" ? f.localCwd : f.workerCwd, "<cwd>"], [card.id, "<approval>"], [card.decision!.id, "<decision>"], [card.requestId, "<native-request>"], [threadId, "<thread>"],
      ];
      const normalize = <T>(value: T): T => JSON.parse(identifiers.reduce(
        (text, [from, to]) => text.replaceAll(from, to), JSON.stringify(value)));
      const trace = messenger.deliveries.filter(delivery => delivery.threadId === threadId).map(delivery => {
        if (delivery.kind === "send") {
          const { id, text: body, sourceId, replyTo } = delivery.output;
          return { kind: delivery.kind, id, sourceId, replyTo: replyTo?.messageId, text: body };
        }
        const { request, state: approvalState, target, generation, decision: approvalDecision, ownerContext } = delivery.approval;
        return { kind: delivery.kind, request, approvalState, target, generation, decision: approvalDecision?.id, ownerContext };
      });
      const observed: LaneObservation = normalize({
        advertised: {
          tools: dumpTools.map(({ name, description, parameters }) => ({ name, description, parameters })),
          modelTools: laneReport.modelTools,
          commands: available.data.commands,
          systemPrompt,
        },
        model: { model: state.model, thinkingLevel: state.thinkingLevel, modelSettings: state.modelSettings, settingsScope: state.settingsScope },
        managed: {
          revision: laneReport.managedRevision,
          extensionRevisions: laneReport.extensionArguments.map(revisionOf),
        },
        report: { probe: laneReport.probe, decision: laneReport.decision, cwdProbeMatchesSession: laneReport.cwdProbeMatchesSession, board: laneReport.board },
        approval: {
          pendingNativeRequests: pending.pendingUiRequests.length,
          trace,
          cardOwnerContext: card.ownerContext,
          stored: { state: store.approval(card.id)!.state, response: store.approval(card.id)!.state === "answered" ? response : undefined },
          review: { state: store.input(reviewId)?.state },
          decision: { state: decision.state, response: decision.response, headSelection: decision.headSelection },
        },
        board: {
          stored: stored.map(row => ({ ...row, mentions: JSON.parse(row.mentions) as string[] })),
          headNotices: headNotices.map(({ actor, role, sessionId, channel, mentions, replyTo }) => ({ actor, role, sessionId, channel, mentions, replyTo })),
          headRead: headRead.map(({ actor, sessionId, channel, text }) => ({ actor, sessionId, channel, text })),
        },
        reportPath: {
          handoff: { state: store.input(handoff)?.state, target: store.input(handoff)?.target },
          head: { state: laneReportInput?.state, target: laneReportInput?.target, mentionsLaneReport: text.includes("Lane finished.") },
          acknowledgements: {
            count: messenger.deliveries.filter(delivery => delivery.kind === "send" && delivery.output.id === `${reportId}:answer`).length,
            text: acknowledgement.text, replyToOriginalMessage: acknowledgement.replyTo?.messageId === input.messageId,
          },
        },
      });
      earlierLane.set(placement, lane.id);
      const workerProcess = placement === "remote" ? await f.workerProcess?.(state.adapterOwnerPid) : undefined;
      return { raw: { lane: resident, systemPrompt, report: laneReport, sessionState: state,
        normalizedPrompt: observed.advertised.systemPrompt, ...(workerProcess ? { workerProcess } : {}) }, observed };
    };

    const expectParity = ({ local, remote }: { local: Exercised; remote: Exercised }) => {
      // Placement is the only thing that differs between the lanes.
      expect(local.raw.lane.placement).toBeUndefined();
      expect(remote.raw.lane.placement).toEqual({ worker: "builder", destination: f.destination, workerId: f.workerId });
      expect(dirname(dirname(local.raw.lane.sessionFile))).toBe(join(f.headState, "sessions"));
      expect(dirname(dirname(remote.raw.lane.sessionFile))).toBe(f.stateDir);

      // 1. Advertised tools, commands and prompt: identical, including the shared board (board_*, its prompt section and notices).
      const names = (observation: LaneObservation) => observation.advertised.tools.map(tool => tool.name).sort();
      expect(names(local.observed).filter(name => name.startsWith("board_"))).toEqual(["board_post", "board_read", "board_subscribe"]);
      expect(names(remote.observed)).toEqual(names(local.observed));
      // A worker account that is its own machine has its own skills, OS and platform notes (reported by differences()).
      // Everything else must match; an isolated worker profile has no such exception.
      const advertised = (observation: LaneObservation) => ({
        tools: observation.advertised.tools,
        modelTools: observation.advertised.modelTools,
        commands: f.accountEnvironment ? observation.advertised.commands.filter(command => !isSkillCommand(command)) : observation.advertised.commands,
        systemPrompt: observation.advertised.systemPrompt,
      });
      const [localAdvertised, remoteAdvertised] = [advertised(local.observed), advertised(remote.observed)];
      if (f.accountEnvironment) {
        const [localPrompt, remotePrompt] = [lines(localAdvertised.systemPrompt), lines(remoteAdvertised.systemPrompt)];
        expect([...onlyIn(localPrompt, remotePrompt), ...onlyIn(remotePrompt, localPrompt)].filter(line => !accountEnvironmentLine.test(line))).toEqual([]);
        expect({ ...remoteAdvertised, systemPrompt: [] }).toEqual({ ...localAdvertised, systemPrompt: [] });
      } else expect(remoteAdvertised).toEqual(localAdvertised);
      const boardSection = (observation: LaneObservation) => lines(observation.advertised.systemPrompt).filter(line => line.includes("Shared bulletin board identity:"));
      expect(boardSection(local.observed)).toHaveLength(1);
      expect(boardSection(remote.observed)).toEqual(boardSection(local.observed));

      // 2. Model and preset readback for the same lane_start model.
        expect(local.observed.model.model).toMatchObject(parityModel);
      expect(remote.observed.model).toEqual(local.observed.model);

      // 3. Managed omp-superkit: one immutable revision, loaded by both Hosts.
      const { revision } = activeManagedUlwRevision();
      expect(local.observed.managed.revision).toBe(revision);
      expect(remote.observed.managed).toEqual(local.observed.managed);
      expect(basename(dirname(local.raw.report.managedPackagePath!))).toBe(revision);
      expect(local.raw.report.managedPackagePath).not.toBe(remote.raw.report.managedPackagePath);

      // 4. Approval round trip and 5. report path: the same observable sequence.
      expect(local.observed.approval.pendingNativeRequests).toBe(1);
      expect(local.observed.approval.cardOwnerContext).toEqual(expect.stringContaining("decision is needed"));
      expect(local.observed.approval.trace.map(entry => entry.kind)).toEqual(["send", "send", "approval", "dismiss", "send"]);
      expect(local.observed.report.decision).toEqual({ status: "submitted", selected: [["Beta"]] });
      expect(remote.observed.approval).toEqual(local.observed.approval);
      expect(remote.observed.report).toEqual(local.observed.report);
      // 6. Board round trip: the same post, notices and reads, stored in HEAD's coordination store under the lane's own identity.
      expect(local.observed.board.stored).toHaveLength(1);
      expect(remote.observed.board).toEqual(local.observed.board);
      expect(local.observed.reportPath.acknowledgements.count).toBe(1);
      expect(remote.observed.reportPath).toEqual(local.observed.reportPath);
    };
    const modelPair = { local: await exercise("local", "model", "8001", "1750000000000000001"),
      remote: await exercise("remote", "model", "8002", "1750000000000000002") };
    const presetPair = { local: await exercise("local", "preset", "8003", "1750000000000000003"),
      remote: await exercise("remote", "preset", "8004", "1750000000000000004") };
    expect(runtimeErrors).toEqual([]);
    console.log(`Lane parity differences (${f.destination}): ${JSON.stringify({
      worker: await f.workerIdentity?.(), model: differences(modelPair, f), preset: differences(presetPair, f) }, null, 2)}`);
    expectParity(modelPair);
    expectParity(presetPair);

    completed = true;
  } finally {
    headBoardSession?.close();
    ledgerReader?.close();
    const stopped = await Promise.allSettled([runtime?.stop(), ...connections.map(connection => connection.close()), head?.close()]);
    for (const name of Object.keys(process.env)) if (!(name in previousEnvironment)) delete process.env[name];
    Object.assign(process.env, previousEnvironment);
    const owners = fixture ? await Promise.allSettled([
      fixture.stopWorkers(), stopHostFixtures(fixture.headState, join(fixture.headState, "run")),
    ]) : [];
    const failures = [...stopped, ...owners].flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (completed && !failures.length) {
      // Lane IDs repeat across runs and a real worker pins HEAD's instance: release this run's reservations.
      await fixture?.cleanup();
      // Provisioned superkit revisions are immutable (read-only directories).
      await Bun.spawn(["chmod", "-R", "u+w", root]).exited;
      await rm(root, { recursive: true, force: true });
    } else console.error(`Native lane parity proof did not complete; private diagnostics retained at ${root}`, runtimeErrors);
    if (failures.length) throw new AggregateError(failures, "Native lane parity fixture teardown failed");
  }
}
