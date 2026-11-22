import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type * as HostFixtures from "./host-fixture-processes";
import { nativeRequestEnvelope } from "./native-request-envelope";

export const parityModel = { provider: "lane-parity-proof", id: "local" } as const;
export const parityProbe = "lane-parity-workspace-proof";
export const parityReportMarker = "PARITY-LANE-REPORT ";
export const parityQuestion = {
  question: "Which parity route?", header: "Parity",
  options: [{ label: "Alpha", description: "First route" }, { label: "Beta", description: "Second route" }], recommended: 0,
} as const;

/** A shared-board message as a lane sees it; run-specific ids and times are dropped, identity and channel are kept. */
export interface ParityBoardMessage {
  readonly actor: string;
  readonly role: string;
  readonly channel: string;
  readonly mentions: string[];
  readonly replyTo: number | null;
  readonly text?: string;
}

/** What the lane observed through its board tools and context notices; identical for both placements. */
export interface ParityBoardReport {
  /** Tool calls of the lane's turn, in order. */
  readonly sequence: string[];
  /** Headers delivered to the lane's provider context (superagent-board-notice), oldest first. */
  readonly notices: ParityBoardMessage[];
  readonly post: ParityBoardMessage & { readonly sessionId: string };
  readonly read: { readonly messages: ParityBoardMessage[]; readonly identity: unknown; readonly subscriptions: string[] };
}

/** What a lane Host reports about itself in its final answer; both placements run the same script. */
export interface ParityLaneReport {
  readonly probe: string;
  readonly decision: { readonly status: string; readonly selected: string[][] };
  readonly modelTools: string[];
  readonly managedRevision: string | null;
  readonly managedPackagePath: string | null;
  readonly extensionArguments: string[];
  readonly superagentEnvironment: string[];
  readonly cwdProbeMatchesSession: boolean;
  readonly board: ParityBoardReport;
}

export function parityLaneReport(text: string): ParityLaneReport | undefined {
  const start = text.indexOf(parityReportMarker);
  if (start < 0) return undefined;
  return JSON.parse(text.slice(start + parityReportMarker.length).split("\n")[0]!) as ParityLaneReport;
}

/**
 * Stock OMP discovers this provider in each private profile (HEAD, local lane
 * and remote worker). No model request leaves the process. It must also load
 * for `omp models --json`, which the worker runs without a session or role.
 */
export default async function nativeParityProvider(pi: ExtensionAPI): Promise<void> {
  const { HOME, PI_CODING_AGENT_DIR, SA_PROOF_HOME, SA_PROOF_CUSTODY, SA_PROOF_ROOT, OMP_SUPERAGENT_ROLE,
    OMP_SUPERAGENT_HOST_CONFIG, OMP_SUPERAGENT_MANAGED_ULW_PATH } = process.env;
  const listing = process.argv.includes("models");
  assert.ok(SA_PROOF_HOME && SA_PROOF_CUSTODY && SA_PROOF_ROOT);
  assert.equal(HOME, SA_PROOF_HOME);
  assert.equal(PI_CODING_AGENT_DIR, join(SA_PROOF_HOME, "agent"));
  assert.ok(listing || OMP_SUPERAGENT_ROLE === "head" || OMP_SUPERAGENT_ROLE === "lane");
  const lane = OMP_SUPERAGENT_ROLE === "lane";
  assert.ok(listing || process.argv.includes("--session"), "The fixture requires an owned native session");
  if (!listing) {
    assert.ok(OMP_SUPERAGENT_HOST_CONFIG);
    // Head and local lanes launch from <state>/run; a worker lane from its own private directory.
    const parent = dirname(dirname(OMP_SUPERAGENT_HOST_CONFIG));
    const root = parent.endsWith(`${sep}run`) ? dirname(parent) : parent;
    // The custody module is the installation's own copy (a worker has its own), so the specifier is runtime-selected.
    const { recordHostFixture }: typeof HostFixtures = await import(SA_PROOF_CUSTODY);
    recordHostFixture(root);
  }

  const refuseNetwork = () => { throw new Error("Lane parity proof forbids provider network access"); };
  globalThis.fetch = Object.assign(async () => refuseNetwork(), { preconnect: refuseNetwork });
  let evidence: { probe: string; sessionCwd: string } | undefined;
  pi.on("session_start", (_event, ctx) => {
    if (lane) evidence = { probe: readFileSync(join(ctx.cwd, parityProbe), "utf8"), sessionCwd: ctx.cwd };
  });

  /** Board notices reach a lane only as transient provider context: remember every header the script was shown. */
  const boardNotices = new Map<number, ParityBoardMessage & { id: number; thread: number }>();
  const boardNoticePrefix = "Untrusted shared-board headers";
  const shape = ({ actor, role, channel, mentions, replyTo, text }: ParityBoardMessage): ParityBoardMessage =>
    ({ actor, role, channel, mentions, replyTo, ...(text === undefined ? {} : { text }) });
  const textOf = (content: unknown): string => typeof content === "string" ? content
    : Array.isArray(content) ? content.flatMap(part => part?.type === "text" ? [String(part.text)] : []).join("\n") : "";
  const mock = createMockModel({
    ...parityModel,
    handler: context => {
      const notice = (message: (typeof context.messages)[number]): boolean => textOf(message.content).startsWith(boardNoticePrefix);
      for (const message of context.messages.filter(notice)) {
        const headers = JSON.parse(textOf(message.content).slice(textOf(message.content).indexOf("\n") + 1)) as
          (ParityBoardMessage & { id: number; thread: number })[];
        for (const header of headers) boardNotices.set(header.id, header);
      }
      const userIndex = context.messages.findLastIndex(message => message.role === "user" && !notice(message));
      const user = context.messages[userIndex];
      const text = textOf(user?.content);
      const request = nativeRequestEnvelope(text);
      assert.ok(request, "Expected a source-bound native request");
      const turn = context.messages.slice(userIndex + 1);
      const result = (name: string) => turn.find(message => message.role === "toolResult" && message.toolName === name);
      if (!lane) {
        if (request.requestId.startsWith("lane-decision-review:")) {
          const id = /Internal review for lane [^,]+, decision (d-[a-f0-9]{24})\./.exec(text)?.[1];
          assert.ok(id, "HEAD review lost its exact decision identity");
          // The review turn ends without a choice, so the runtime escalates the lane's question to the owner card.
          return { content: ["No routine option applies to this route; the owner decides."] };
        }
        return { content: [`Head acknowledged ${request.requestId}`] };
      }
      assert.ok(evidence, "The lane must read its workspace from the native session cwd");
      const asked = result("decision_ask");
      if (!asked) return { content: [{ type: "toolCall", id: `parity-ask-${request.requestId}`, name: "decision_ask",
        arguments: { questions: [parityQuestion] } }] };
      assert.ok(asked.role === "toolResult" && !asked.isError, `decision_ask failed: ${JSON.stringify(asked)}`);
      const answered = JSON.parse(textOf(asked.content)) as { status: string; answers?: { selectedOptions: string[] }[] };
      // Board round trip: the lane posts (mentioning HEAD) and reads the body of the note HEAD addressed to it.
      const boardCall = (name: string, args: Record<string, unknown>) =>
        ({ content: [{ type: "toolCall" as const, id: `parity-${name}-${request.requestId}`, name, arguments: args }] });
      if (!result("board_post")) return boardCall("board_post", { text: `Parity board post from ${process.env.OMP_SUPERAGENT_LANE}`, mentions: ["head"] });
      const headNote = [...boardNotices.values()].find(header => header.actor === "head");
      assert.ok(headNote, `The lane's context never carried HEAD's board notice: ${JSON.stringify([...boardNotices.values()])}`);
      if (!result("board_read")) return boardCall("board_read", { thread: headNote.thread });
      const boardResult = (name: string) => {
        const found = result(name);
        assert.ok(found && found.role === "toolResult" && !found.isError, `${name} failed: ${JSON.stringify(found)}`);
        return JSON.parse(textOf(found.content)) as Record<string, any>;
      };
      const posted = boardResult("board_post") as ParityBoardMessage & { sessionId: string };
      const read = boardResult("board_read") as { messages: ParityBoardMessage[]; identity: unknown; subscriptions: string[] };
      const board: ParityBoardReport = {
        sequence: turn.flatMap(message => message.role === "assistant" ? message.content.flatMap(part => part.type === "toolCall" ? [part.name] : []) : []),
        notices: [...boardNotices.values()].sort((a, b) => a.id - b.id).map(shape),
        post: { ...shape(posted), sessionId: posted.sessionId },
        read: { messages: read.messages.map(shape), identity: read.identity, subscriptions: read.subscriptions },
      };
      const managed = OMP_SUPERAGENT_MANAGED_ULW_PATH ?? null;
      const report: ParityLaneReport = {
        probe: evidence.probe,
        decision: { status: answered.status, selected: (answered.answers ?? []).map(answer => answer.selectedOptions) },
        modelTools: (context.tools ?? []).map(tool => tool.name).sort(),
        managedRevision: managed && basename(dirname(managed)),
        managedPackagePath: managed,
        extensionArguments: process.argv.flatMap((argument, index) => process.argv[index - 1] === "-e" ? [argument] : []),
        superagentEnvironment: Object.keys(process.env).filter(name => name.startsWith("OMP_SUPERAGENT_")).sort(),
        cwdProbeMatchesSession: evidence.sessionCwd === process.cwd(),
        board,
      };
      return { content: [`Lane finished. ${parityReportMarker}${JSON.stringify(report)}`] };
    },
  });
  pi.registerProvider(parityModel.provider, {
    baseUrl: "mock://lane-parity-proof", api: "lane-parity-proof", apiKey: "offline-fixture-only",
    streamSimple: (model, context, options) => mock.stream(model, context, options),
    models: [{ id: mock.id, name: mock.name, kind: "chat", reasoning: mock.reasoning, input: mock.input,
      cost: mock.cost, contextWindow: mock.contextWindow, maxTokens: mock.maxTokens }],
  });
}
