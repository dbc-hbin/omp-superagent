/** Only the model transport is scripted; every tool runs in production OMP. */
import { watch } from "node:fs";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { nativeRequestEnvelope } from "./native-request-envelope";
import { nativeToolExchanges, nativeToolTurn } from "./native-tool-transport";

const provider = "gateway-native";
const model = "local";
const managers = [
  "head_recovery", "head_set_model", "cron_create", "lane_models", "lane_init_presets", "lane_set_model", "lane_start",
  "lane_inspect", "lane_message", "lane_pause", "lane_resume", "lane_review_decision", "lane_close", "thread_inspect",
  "lane_thread_update", "discord_context", "discord_purpose_list", "discord_purpose_set", "discord_purpose_clear",
  "pr_watch", "pr_watch_list", "decision_list", "decision_inspect", "decision_withdraw",
];
const evidenceTool = "fixture_gateway_artifact";
const findingPrefix = "native-gateway:lane-finding:";

export default function gatewayProvider(pi: ExtensionAPI): void {
  const root = process.env.OMP_NATIVE_GATEWAY_ROOT;
  if (!root) throw new Error("Native Gateway provider requires a private test root");
  const role = process.env.OMP_SUPERAGENT_ROLE;
  const startup = "Native preset startup initialization (internal control turn, not a messenger user request).";
  const artifact = join(root, "topic", "native-observation-evidence.txt");
  const recordedAuthority = new Set<string>();
  if (role === "lane" && process.env.OMP_NATIVE_GATEWAY_PRESETS === "create") {
    pi.registerTool({
      name: evidenceTool, label: "Write isolated Gateway evidence",
      description: "Write the fixed evidence file in the private Gateway topic fixture.",
      approval: "write", loadMode: "discoverable",
      parameters: Type.Object({ text: Type.String() }),
      async execute(_id, { text }, _signal, _update, ctx) {
        if (ctx.cwd !== join(root, "topic")) throw new Error("Native artifact must stay in the isolated topic workspace");
        await writeFile(artifact, text, { mode: 0o600, flag: "wx" });
        return { content: [{ type: "text", text: artifact }], details: { path: artifact } };
      },
    });
  }
  pi.on("input", event => {
    if (process.env.OMP_NATIVE_GATEWAY_PRESETS === "skipped" && event.text.includes(startup)) return { handled: true };
  });
  // The mandatory head policy alone exceeds a 32k model's native maintenance
  // threshold. Match the existing native ULW fixture's capacity; keep normal
  // compaction enabled without making this lifecycle proof a summary script.
  const local = createMockModel({ provider, id: model, contextWindow: 65_536, maxTokens: 4096, handler: async context => {
    const users = context.messages.flatMap((message, index) => {
      if (message.role !== "user") return [];
      const text = typeof message.content === "string" ? message.content
        : message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
      // Native OMP may prepend its date/cwd reminder before the durable header.
      const envelope = nativeRequestEnvelope(text);
      const requestId = envelope?.requestId;
      const bootstrap = text.includes(startup);
      const steering = envelope?.envelope.includes("This is an authorized same-conversation followup to the active request.") ?? false;
      return requestId || bootstrap ? [{ index, text, requestId, bootstrap, steering }] : [];
    });
    const exchanges = nativeToolExchanges(context.messages);
    const all = nativeToolTurn(pi, context, exchanges);
    const delegated = new Set<string>();
    const findings = new Set<string>();
    for (const { name, args } of all.executions) {
      if (name === "lane_message" && typeof args?.sourceId === "string") delegated.add(args.sourceId);
      if (name === "board_post" && typeof args?.text === "string" && args.text.startsWith(findingPrefix))
        findings.add(args.text.slice(findingPrefix.length));
    }
    // Steering can arrive between discovering a manager device and invoking it.
    // Finish every explicit source decision in order; newest-user-only selection
    // can abandon 205 when 206 arrives after discovery but before execution.
    const activeUsers = users.slice(Math.max(0, users.findLastIndex(user => !user.steering)));
    const selected = activeUsers.find(user => user.requestId && (role === "head"
      ? ["203", "204", "205", "206", "209"].includes(user.requestId) && !delegated.has(user.requestId)
      : role === "lane" && !findings.has(user.requestId))) ?? activeUsers.at(-1);
    if (!selected) throw new Error("Unexpected native Gateway model input: no runtime request or startup turn");
    const { index: userIndex, text, requestId, bootstrap } = selected;
    const callPrefix = `gateway-native:${requestId ?? "bootstrap"}:`;
    const messages = context.messages.slice(userIndex + 1);
    const turn = nativeToolTurn(pi, context, nativeToolExchanges(messages)
      .filter(({ result }) => role !== "lane" || result.toolCallId.startsWith(callPrefix)));
    if (role === "lane") {
      const registered = new Set(pi.getAllTools().map(tool => tool.name));
      const authority = {
        registered: managers.filter(name => registered.has(name)),
        enabled: managers.filter(name => turn.enabled.has(name)),
        advertised: managers.filter(name => turn.advertised.has(name)),
      };
      if (Object.values(authority).some(names => names.length)) throw new Error(`Lane loaded head management authority: ${JSON.stringify(authority)}`);
      if (requestId && !recordedAuthority.has(requestId)) {
        recordedAuthority.add(requestId);
        pi.appendEntry("native-gateway:lane-authority", { requestId, ...authority });
      }
    }
    const failures = messages.filter(message => message.role === "toolResult" && message.isError &&
      (role !== "lane" || message.toolCallId.startsWith(callPrefix)));
    if (failures.length) throw new Error(`Production tool failed: ${JSON.stringify(failures)}`);
    if (turn.failed.length) throw new Error(`Native tool dispatch failed: ${JSON.stringify(turn.failed)}`);
    const results = turn.executions.map(dispatch => dispatch.result);
    const called = (name: string) => name === "lane_message" ? delegated.has(requestId ?? "") : turn.succeeded(name);
    const invoke = (name: string, args: Record<string, unknown>): MockResponse =>
      turn.invoke(name, args, `${callPrefix}${name}:${context.messages.length}`);

    if (bootstrap) {
      if (role !== "head") throw new Error("Startup initialization must stay in the original head");
      if (!context.systemPrompt?.some(part => part.includes("lane_init_presets"))) throw new Error("Bootstrap lost the original head role instructions");
      if (!called("lane_models")) return invoke("lane_models", {});
      if (process.env.OMP_NATIVE_GATEWAY_PRESETS === "failed") return { content: ["No presets created; initialization is not complete."] };
      if (!called("lane_init_presets")) {
        const released = Promise.withResolvers<void>();
        const watcher = watch(root, (_event, name) => { if (String(name) === "release-bootstrap") released.resolve(); });
        try {
          await writeFile(join(root, "entered-bootstrap"), String(process.pid), { mode: 0o600 });
          try { await access(join(root, "release-bootstrap")); }
          catch { await released.promise; }
        } finally { watcher.close(); }
        return invoke("lane_init_presets", { choices: Object.fromEntries(["high", "middle", "low"].map(name => [name, {
          model: { provider, id: model },
          reason: "Only one authenticated native text-chat candidate is available in this isolated provider; comparative judge work is immaterial. Preserve existing roles and do not infer a performance rank from this preset name.",
        }])) });
      }
      const lastInit = turn.executions.findLastIndex(dispatch => dispatch.name === "lane_init_presets");
      const readback = turn.executions.slice(lastInit + 1).some(dispatch => dispatch.name === "lane_models");
      if (!readback) return invoke("lane_models", {});
      return { content: ["INTERNAL PRESET INITIALIZATION RESULT: must never reach Messenger."] };
    }
    if (!requestId) throw new Error("Ordinary native input requires its durable request identity");
    if (role === "head") {
      if (requestId === "240") {
        if (!called("cron_create")) return invoke("cron_create", {
          sourceId: requestId, schedule: "in 1s", prompt: "Return the native scheduled check result in this conversation.",
        });
        const receipt = results.flatMap(result => result.content).filter(part => part.type === "text").map(part => part.text).join("\n");
        const id = /"id":\s*"([0-9a-f-]{36})"/.exec(receipt)?.[1];
        if (!id) throw new Error("Native cron_create returned no job identity");
        return { content: [`Cron registered ${id}`] };
      }
      if (requestId.startsWith("lane-decision-review:")) {
        const id = /Internal review for lane [^,]+, decision (d-[a-f0-9]{24})\./.exec(text)?.[1];
        if (!id) throw new Error("Native HEAD review lost its exact decision identity");
        if (!called("lane_review_decision")) return invoke("lane_review_decision", {
          id, reason: "A flat layout is simpler and reversible within this local assignment.",
          answers: [{ id: `${id}:0`, selectedOptions: ["Flat"] }],
        });
        return { content: [] };
      }
      if (requestId.startsWith("progress:")) {
        const snapshot = /Structured lane observation: (\{[^\n]+\})/.exec(text)?.[1];
        if (!snapshot) throw new Error("Structured native progress lost its observation");
        const observation = JSON.parse(snapshot);
        return { content: [`OBSERVATION:202:${observation.waiting ? "waiting" : "resolved"}`] };
      }
      if (requestId === "202") {
        if (!called("board_post")) return invoke("board_post", {
          channel: "general", text: "native-gateway:head-brief", mentions: [],
        });
        if (!called("lane_start")) return invoke("lane_start", {
          sourceId: requestId, title: "Native Gateway independent topic", kickoff: "I will inspect the requested workspace, perform the authorized work, and verify the result in this topic.", cwd: join(root, "topic"),
          model: { provider, id: model }, modelReason: "Use the isolated deterministic available text model for actual Gateway native integration.",
          acceptance: ["Return findings to the head; never send directly to Messenger"],
        });
        return { content: [] };
      }
      if (["203", "204", "205", "206", "209"].includes(requestId)) {
        if (!called("lane_message")) {
          const binding = /Bound lane reference \(coordination state, not a transcript\): (\{[^\n]+\})/.exec(text)?.[1];
          const id: unknown = binding ? JSON.parse(binding).id : undefined;
          if (typeof id !== "string") throw new Error("Follow-up did not enter head with its original lane binding context");
          return invoke("lane_message", {
            id, sourceId: requestId, text: `Head explicitly delegates follow-up ${requestId} after receiving the original user input.`,
          });
        }
        return { content: [] };
      }
      if (requestId.startsWith("report:")) {
        if (!called("board_read")) return invoke("board_read", { channel: "general", unreadOnly: false });
        if (!JSON.stringify(results).includes("native-gateway:lane-finding")) throw new Error("Head did not read the actual lane board post");
        const sourceId = /Internal lane report: [^;]+; sourceId: ([^;]+);/.exec(text)?.[1];
        if (!sourceId || !text.includes("LANE:")) throw new Error("Head report lost the original source or native lane result");
        const sources = [...text.matchAll(/^LANE:handoff:([^:\r\n]+):[^\r\n]+$/gm)].map(match => match[1]!);
        if (!sources.includes(sourceId) || new Set(sources).size !== sources.length) throw new Error("Consolidated lane report lost or duplicated its original sources");
        return { content: [sources.map(id => `HEAD:${id}`).join("\n")] };
      }
      if (requestId === "208" && !called("head_set_model")) {
        return invoke("head_set_model", { sourceId: requestId, model: { provider, id: "alternate" } });
      }
      if (requestId === "207" || requestId === "208") {
        // Hold only the deterministic model boundary so stop() sees real native
        // streaming work. The release file is an event, not a guessed delay.
        const released = Promise.withResolvers<void>();
        const watcher = watch(root, (_event, name) => { if (String(name) === `release-${requestId}`) released.resolve(); });
        try {
          await writeFile(join(root, `entered-${requestId}`), "ready", { mode: 0o600 });
          try { await access(join(root, `release-${requestId}`)); }
          catch { await released.promise; }
        } finally { watcher.close(); }
      }
      return { content: [`HEAD:${requestId}`] };
    }

    if (role !== "lane") throw new Error(`Unexpected Gateway native role: ${role}`);
    if (requestId === `handoff:209:${process.env.OMP_SUPERAGENT_LANE}`) {
      if (!called("decision_ask")) return invoke("decision_ask", {
        questions: [{ question: "Which reversible local cache layout?", options: [{ label: "Flat" }, { label: "Nested" }] }],
      });
      if (!JSON.stringify(results).includes("Flat")) throw new Error("Lane did not receive the selected native option");
      return { content: [`LANE:${requestId}`] };
    }
    if (!called("board_read")) return invoke("board_read", { channel: "general", unreadOnly: false });
    if (!JSON.stringify(results).includes("native-gateway:head-brief")) throw new Error("Lane did not read the actual head board post");
    if (requestId === "handoff:202:lane" && process.env.OMP_NATIVE_GATEWAY_PRESETS === "create") {
      const waiting = { kind: "dependency", target: "Native observation smoke release" };
      if (!turn.executions.some(call => call.name === "lane_report" && call.args?.status === "waiting")) {
        return invoke("lane_report", { status: "waiting", summary: "Waiting for the isolated verification release", waiting });
      }
      const released = async (name: string) => {
        const ready = Promise.withResolvers<void>();
        const watcher = watch(root, (_event, file) => { if (String(file) === name) ready.resolve(); });
        try {
          try { await access(join(root, name)); }
          catch { await ready.promise; }
        } finally { watcher.close(); }
      };
      if (turn.presentation(evidenceTool) === "direct")
        throw new Error("The discoverable native artifact tool must exercise the enabled mounted presentation");
      if (!called(evidenceTool)) {
        await released("release-observation");
        return invoke(evidenceTool, { text: "Native Gateway's observation evidence\n" });
      }
      if (!turn.executions.some(call => call.name === "eval" && call.args?.title === "Native lane resolved report")) {
        return invoke("eval", { language: "js", title: "Native lane resolved report",
          code: `await tool.lane_report(${JSON.stringify({ status: "resolved", summary: "The isolated release produced the selected evidence file",
            waiting, evidence: [{ kind: "file", path: artifact }] })});` });
      }
      await released("release-observation-final");
    }
    if (!called("board_post")) return invoke("board_post", {
      channel: "general", text: `${findingPrefix}${requestId}`, mentions: ["head"],
    });
    return { content: [activeUsers.map(user => `LANE:${user.requestId}`).join("\n")] };
  } });
  pi.registerProvider(provider, {
    baseUrl: `mock://${provider}`, api: provider, apiKey: "local-test-only",
    streamSimple: (identity, context, options) => local.stream(identity, context, options),
    models: (["valid", "create"].includes(process.env.OMP_NATIVE_GATEWAY_PRESETS ?? "") ? [model, "alternate"] : [model]).map(id => ({
      id, name: `Native Gateway deterministic ${id} model`, kind: "chat", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: local.contextWindow, maxTokens: local.maxTokens,
    })),
  });
}
