/** Local transport only. Native eval/judge/session accounting remain production code. */
import { createMockModel, type MockModel } from "../../.upstream/omp/packages/ai/src/providers/mock";
import { Effort } from "../../.upstream/omp/packages/catalog/src/effort";
import type { ThinkingConfig } from "../../.upstream/omp/packages/catalog/src/types";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export const modelFixtureProvider = "model-selection-native";
export const modelJudgeMarker = "omp-superagent-native-judge";
export const modelRolesMarker = "omp-superagent-native-model-roles";
export const modelAbortMarker = "omp-superagent-native-abort";
export const modelCompactMarker = "omp-superagent-native-compact";
export const modelCompactInstructions = "Preserve native messenger command decisions.\nKeep the independent lane identity and frozen role settings.";
export const modelCompactAbortInstructions = "Wait for the native compaction AbortSignal before producing the summary.";
export const modelCompactSummary = "## Goal\nVerify native messenger commands.\n## Decisions\nPreserve the independent lane identity and frozen role settings.\n## Next Steps\nContinue the existing head session.";
export const modelFixtureModels = {
  head: { provider: modelFixtureProvider, id: "head" },
  lane: { provider: modelFixtureProvider, id: "lane" },
  judge: { provider: modelFixtureProvider, id: "judge" },
  changedDefault: { provider: modelFixtureProvider, id: "changed-default" },
  changedLane: { provider: modelFixtureProvider, id: "changed-lane" },
} as const;

export default function modelSelectionFixture(pi: ExtensionAPI): void {
  let notify: ((message: string) => void) | undefined;
  pi.on("session_start", (_event, ctx) => { notify = message => ctx.ui.notify(message, "info"); });
  pi.on("session_before_compact", event => {
    // Observe the real native preparation, never provide a replacement result.
    pi.appendEntry(modelCompactMarker, { phase: "prepared", instructions: event.customInstructions,
      firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore });
  });
  const changedThinking: ThinkingConfig = { mode: "effort", efforts: [Effort.Minimal, Effort.Low], defaultLevel: Effort.Minimal };
  const reasoning = (id: string) => id === modelFixtureModels.changedLane.id || id === modelFixtureModels.changedDefault.id;
  const smoke = { provider: "socket-host-smoke", id: "local" };
  const identities = [...Object.values(modelFixtureModels), smoke];
  const mocks = new Map<string, MockModel>(identities.map(identity => [`${identity.provider}/${identity.id}`, createMockModel({
    ...identity,
    reasoning: reasoning(identity.id),
    handler: async (context, options) => {
      if (identity.id === modelFixtureModels.judge.id) {
        // A deterministic provider response, parsed and journaled by the real native judge.
        return { content: [`${modelFixtureProvider}/${modelFixtureModels.head.id}`],
          usage: { input: 3, output: 1, totalTokens: 4 } };
      }
      const userIndex = context.messages.findLastIndex(message => message.role === "user");
      const user = context.messages[userIndex];
      const answered = context.messages.slice(userIndex + 1).some(message => message.role === "assistant");
      const text = user?.role === "user" ? typeof user.content === "string" ? user.content
        : user.content.filter(part => part.type === "text").map(part => part.text).join("\n") : "";
      const requestId = /^Request ID: ([^\n]+)\n/m.exec(text)?.[1];
      if (text.includes(`Additional focus: ${modelCompactInstructions}`)) {
        pi.appendEntry(modelCompactMarker, { phase: "provider-summary", instructions: modelCompactInstructions,
          prompt: text, model: identity });
        return { content: [modelCompactSummary], usage: { input: 211, output: 37, totalTokens: 248 } };
      }
      const abortRequestId = text.includes(`Additional focus: ${modelCompactAbortInstructions}`) ? "305" : requestId === "301" ? requestId : undefined;
      if (abortRequestId) {
        const signal = options?.signal;
        if (!signal || !notify) throw new Error("Native abort fixture requires an active session and native AbortSignal");
        const gate = Promise.withResolvers<void>();
        const aborted = () => {
          pi.appendEntry(modelAbortMarker, { phase: "aborted", requestId: abortRequestId });
          signal.removeEventListener("abort", aborted);
          gate.resolve();
        };
        signal.addEventListener("abort", aborted, { once: true });
        if (signal.aborted) aborted();
        else {
          pi.appendEntry(modelAbortMarker, { phase: "ready", requestId: abortRequestId });
          notify(JSON.stringify({ fixture: modelAbortMarker, phase: "ready", requestId: abortRequestId }));
        }
        await gate.promise;
        return { content: [], stopReason: "aborted" };
      }
      if (identity.id === modelFixtureModels.head.id && !answered && requestId === "102") {
        const candidates = [modelFixtureModels.head, modelFixtureModels.lane];
        const criteria = Object.fromEntries(candidates.map(model => [`${model.provider}/${model.id}`, "Available text chat candidate"]));
        return { content: [{ type: "toolCall", name: "eval", arguments: {
          language: "js", timeout: 30,
          code: `const decision = await judge(${JSON.stringify({ request: "Choose an available model for an independent lane", candidates })}, ${JSON.stringify({ selection: { type: "choice", instructions: "Advise one available chat candidate; the head makes the final choice independently.", criteria } })}); print(JSON.stringify({fixture:${JSON.stringify(modelJudgeMarker)},...decision}));`,
        } }] };
      }
      // These head turns authorize explicit fixture-driven handoffs. They are
      // not external answers; only the subsequent head report turn replies.
      if (["102", "103", "105"].includes(requestId ?? "") && text.includes(`sourceId: ${requestId}\n`)) return { content: [] };
      return { content: ["Socket host smoke response"], usage: { input: 137, output: 11, totalTokens: 148 } };
    },
  })]));
  for (const provider of [modelFixtureProvider, smoke.provider]) pi.registerProvider(provider, {
    baseUrl: `mock://${provider}`, api: provider, apiKey: "local-test-only",
    streamSimple: (model, context, options) => {
      const mock = mocks.get(`${model.provider}/${model.id}`);
      if (!mock) throw new Error(`Unexpected local native model: ${model.provider}/${model.id}`);
      return mock.stream(model, context, options);
    },
    models: identities.filter(model => model.provider === provider).map(model => ({
      id: model.id, name: `Local native ${model.id}`, kind: "chat", reasoning: reasoning(model.id), input: ["text"],
      ...(reasoning(model.id) ? { thinking: changedThinking } : {}),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_768, maxTokens: 4096,
    })),
  });
  pi.registerCommand("fixture-model-roles", {
    description: "Read the native session's actual current model and role resolution without a model call",
    handler: async (args, ctx) => {
      const identity = (model: { provider: string; id: string } | undefined) => model ? { provider: model.provider, id: model.id } : null;
      const data = { fixture: modelRolesMarker, token: args.trim(), model: identity(ctx.models.current()),
        smol: identity(ctx.models.resolve("@smol")), judge: identity(ctx.models.resolve("@judge")),
        calls: Object.fromEntries([...mocks].map(([name, mock]) => [name, mock.calls.length])) };
      pi.appendEntry(modelRolesMarker, data);
      ctx.ui.notify(JSON.stringify(data), "info");
    },
  });
}
