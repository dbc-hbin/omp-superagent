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
  "lane_inspect", "lane_message", "lane_scope_accept", "lane_pause", "lane_resume", "lane_review_decision", "lane_close", "thread_inspect",
  "lane_thread_update", "discord_context", "discord_purpose_list", "discord_purpose_set", "discord_purpose_clear",
  "pr_watch", "pr_watch_list", "decision_list", "decision_inspect", "decision_withdraw",
];
const evidenceTool = "fixture_gateway_artifact";
const followupSources = ["203", "204", "205", "206"];
const delegatedSources = new Set([...followupSources, "209"]);

export default function gatewayProvider(pi: ExtensionAPI): void {
  const root = process.env.OMP_NATIVE_GATEWAY_ROOT;
  if (!root) throw new Error("Native Gateway provider requires a private test root");
  const role = process.env.OMP_SUPERAGENT_ROLE;
  const startup = "Native preset startup initialization (internal control turn, not a messenger user request).";
  const artifact = join(root, "topic", "native-observation-evidence.txt");
  const laneEvidence = new Map<string, string>(followupSources.map(id =>
    [`handoff:${id}:${process.env.OMP_SUPERAGENT_LANE}`, join(root, "topic", `evidence-${id}.txt`)]));
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
    for (const { name, args } of all.executions) {
      if (name === "lane_message" && typeof args?.sourceId === "string") delegated.add(args.sourceId);
    }
    // Steering can arrive between discovering a manager device and invoking it.
    // Finish every explicit source decision in order; newest-user-only selection
    // can abandon 205 when 206 arrives after discovery but before execution.
    const activeUsers = users.slice(Math.max(0, users.findLastIndex(user => !user.steering)));
    const selected = activeUsers.find(({ requestId }) => {
      if (!requestId) return false;
      if (role === "head") return delegatedSources.has(requestId) && !delegated.has(requestId);
      return role === "lane" && laneEvidence.has(requestId) && !all.executions.some(dispatch =>
        dispatch.name === "read" && dispatch.args?.path === laneEvidence.get(requestId)
        && dispatch.result.toolCallId.startsWith(`gateway-native:${requestId}:read:`));
    }) ?? activeUsers.at(-1);
    if (!selected) throw new Error("Unexpected native Gateway model input: no runtime request or startup turn");
    const { index: userIndex, text, requestId, bootstrap } = selected;
    const callPrefix = `gateway-native:${requestId ?? "bootstrap"}:`;
    const messages = context.messages.slice(userIndex + 1);
    const explicitHeadReview = role === "head" && requestId?.startsWith("lane-decision-review:")
      && text.includes("Which reversible local index format?");
    const reviewWriteId = explicitHeadReview ? `${callPrefix}forbidden-write` : undefined;
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
      message.toolCallId !== reviewWriteId &&
      (role !== "lane" || message.toolCallId.startsWith(callPrefix)));
    if (failures.length) throw new Error(`Production tool failed: ${JSON.stringify(failures)}`);
    const dispatchFailures = turn.failed.filter(dispatch => dispatch.result.toolCallId !== reviewWriteId);
    if (dispatchFailures.length) throw new Error(`Native tool dispatch failed: ${JSON.stringify(dispatchFailures)}`);
    const results = turn.executions.map(dispatch => dispatch.result);
    const called = (name: string) => name === "lane_message" ? delegated.has(requestId ?? "") : turn.succeeded(name);
    const invoke = (name: string, args: Record<string, unknown>): MockResponse =>
      turn.invoke(name, args, `${callPrefix}${name}:${context.messages.length}`);

    if (bootstrap) {
      if (role !== "head") throw new Error("Startup initialization must stay in the original head");
      if (!context.systemPrompt?.some(part => part.includes("lane_init_presets"))) throw new Error("Bootstrap lost the original head role instructions");
      if (context.systemPrompt?.some(part => part.includes("<superagent-reply-voice>"))) throw new Error("Bootstrap inherited owner-facing reply voice");
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
      if (requestId.startsWith("scope-review:")) {
        const lane = /Assignment scope review for lane ("[^"]+")/.exec(text)?.[1];
        const original = /Authenticated original owner message \(only source of a scope change\): ([^\n]+)/.exec(text)?.[1];
        if (!lane || !original || !text.includes("Read-only parser inspection.")) throw new Error("Missing original scope review evidence");
        const schema = context.tools?.find(tool => tool.name === "lane_scope_accept")?.parameters;
        const properties = schema && "properties" in schema ? schema.properties : undefined;
        if (!properties || typeof properties !== "object" || Object.keys(properties).join() !== "reviewId")
          throw new Error("Scope review must advertise a direct tool with only the review ID, not a workflow or dispatch override");
        if (!called("lane_scope_accept")) return invoke("lane_scope_accept", { reviewId: requestId });
        return { content: ["Correction requested."] };
      }
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
        const rawQuestions = /^Original native questions: (.+)$/m.exec(text)?.[1];
        if (!rawQuestions) throw new Error("Native HEAD review did not receive the original questions");
        const questions: Array<{ id: string; question: string; options: { label: string }[] }> = JSON.parse(rawQuestions);
        const expectedQuestion = explicitHeadReview ? `${id}:head:0` : `${id}:0`;
        if (questions.length !== 1 || questions[0]?.id !== expectedQuestion)
          throw new Error("Native HEAD review lost the exact original question identity");
        if (reviewWriteId) {
          if (text.includes("HEAD-only reference fixture") || rawQuestions.includes("@") || rawQuestions.includes("^")
            || !questions[0]!.question.includes("@README.md")
            || questions[0]!.options[0]?.label !== "Flat ^index")
            throw new Error("Native HEAD review must receive the exact question and labels without expanding references");
          const attempt = turn.dispatches.find(dispatch => dispatch.result.toolCallId === reviewWriteId);
          if (!attempt) return { content: [{ type: "toolCall", id: reviewWriteId, name: "write",
            arguments: { path: join(root, "forbidden-decision-review-write"), content: "An internal review must not write files." } }] };
          if (attempt.ok) throw new Error("Internal HEAD review was allowed to execute an unrelated write");
        }
        if (turn.presentation("lane_review_decision") !== "direct") throw new Error("HEAD must use the direct decision review tool");
        if (!called("lane_review_decision")) return invoke("lane_review_decision", {
          id, reason: "The flat option is simpler and reversible within this local assignment.",
          answers: [{ id: questions[0].id, selectedOptions: [questions[0].options[0]!.label] }],
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
        if (!called("lane_start")) return invoke("lane_start", {
          sourceId: requestId, title: "Native Gateway independent topic", kickoff: "I will inspect the requested workspace, perform the authorized work, and verify the result in this topic.", cwd: join(root, "topic"),
          ...(process.env.OMP_NATIVE_GATEWAY_PRESETS === "create" ? { brief: "Read-only parser inspection." } : {}),
          model: { provider, id: model }, modelReason: "Use the isolated deterministic available text model for actual Gateway native integration.",
          acceptance: ["Return findings to the head; never send directly to Messenger"],
        });
        return { content: [] };
      }
      if (delegatedSources.has(requestId)) {
        if (!called("lane_message")) {
          const binding = /Bound lane reference \(coordination state, not a transcript\): (\{[^\n]+\})/.exec(text)?.[1];
          const id: unknown = binding ? JSON.parse(binding).id : undefined;
          if (typeof id !== "string") throw new Error("Follow-up did not enter head with its original lane binding context");
          if (requestId === "203") {
            const schema = context.tools?.find(tool => tool.name === "lane_message")?.parameters;
            const properties = schema && "properties" in schema ? schema.properties : undefined;
            const workflow = properties && typeof properties === "object" && "workflow" in properties ? properties.workflow : undefined;
            if (!workflow || typeof workflow !== "object" || !("anyOf" in workflow) || !Array.isArray(workflow.anyOf)
              || !workflow.anyOf.some(branch => branch?.type === "null"))
              throw new Error("The provider-visible workflow schema must explicitly permit null for ordinary dispatch");
          }
          return invoke("lane_message", {
            id, sourceId: requestId, text: `Head explicitly delegates follow-up ${requestId} after receiving the original user input.`,
            ...(requestId === "203" ? { workflow: null } : {}),
          });
        }
        return { content: [] };
      }
      if (requestId.startsWith("report:")) {
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
    if (requestId.startsWith("handoff:scope-review:")) return { content: ["Reviewed correction received on the original lane."] };
    if (requestId.startsWith("handoff:discord:2:241:original:")) {
      if (!called("lane_report")) {
        const signal = invoke("lane_report", { status: "scope_review", sourceId: "discord:2:241:original" });
        return { content: ["Holding the edit for scope review.", ...signal.content ?? []] };
      }
      return { content: ["The disputed work has not started."] };
    }
    if (requestId === `handoff:209:${process.env.OMP_SUPERAGENT_LANE}`) {
      if (!called("decision_ask")) return invoke("decision_ask", {
        questions: [{ question: "Which reversible local cache layout?", options: [{ label: "Flat" }, { label: "Nested" }] }],
      });
      if (!JSON.stringify(results).includes("Flat")) throw new Error("Lane did not receive the selected native option");
      return { content: [`LANE:${requestId}`] };
    }
    if (requestId === `handoff:discord:2:242:original:${process.env.OMP_SUPERAGENT_LANE}`) {
      if (!called("decision_ask")) return invoke("decision_ask", { to: "head",
        questions: [{ question: "Which reversible local index format? See @README.md for context.", options: [{ label: "Flat ^index" }, { label: "Nested" }] }],
      });
      const received = turn.executions.find(dispatch => dispatch.name === "decision_ask")?.details as {
        id: string; status: string; answers?: Array<{ id: string; selectedOptions: string[] }>;
      } | undefined;
      const [answer] = received?.answers ?? [];
      if (received?.status !== "submitted" || received.answers?.length !== 1 || answer?.id !== `${received.id}:head:0`
        || answer.selectedOptions.length !== 1 || answer.selectedOptions[0] !== "Flat ^index")
        throw new Error("The original lane did not receive HEAD's exact native answer");
      return { content: ["HEAD selected Flat; the answer stayed in the original topic."] };
    }
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
    const evidencePath = laneEvidence.get(requestId);
    if (evidencePath && !called("read")) return invoke("read", { path: evidencePath });
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
