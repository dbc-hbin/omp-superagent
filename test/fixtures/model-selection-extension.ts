/** Local transport only. Native eval/judge/session accounting remain production code. */
import { createMockModel, type MockModel } from "../../.upstream/omp/packages/ai/src/providers/mock";
import { Effort } from "../../.upstream/omp/packages/catalog/src/effort";
import type { ThinkingConfig } from "../../.upstream/omp/packages/catalog/src/types";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export const modelFixtureProvider = "model-selection-native";
export const modelJudgeMarker = "omp-superagent-native-judge";
export const modelRolesMarker = "omp-superagent-native-model-roles";
export const modelFixtureModels = {
  head: { provider: modelFixtureProvider, id: "head" },
  lane: { provider: modelFixtureProvider, id: "lane" },
  judge: { provider: modelFixtureProvider, id: "judge" },
  changedDefault: { provider: modelFixtureProvider, id: "changed-default" },
  changedLane: { provider: modelFixtureProvider, id: "changed-lane" },
} as const;

export default function modelSelectionFixture(pi: ExtensionAPI): void {
  const changedThinking: ThinkingConfig = { mode: "effort", efforts: [Effort.Minimal, Effort.Low], defaultLevel: Effort.Minimal };
  const smoke = { provider: "socket-host-smoke", id: "local" };
  const identities = [...Object.values(modelFixtureModels), smoke];
  const mocks = new Map<string, MockModel>(identities.map(identity => [`${identity.provider}/${identity.id}`, createMockModel({
    ...identity,
    reasoning: identity.id === modelFixtureModels.changedLane.id,
    handler: context => {
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
      return { content: ["Socket host smoke response"] };
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
      id: model.id, name: `Local native ${model.id}`, kind: "chat", reasoning: model.id === modelFixtureModels.changedLane.id, input: ["text"],
      ...(model.id === modelFixtureModels.changedLane.id ? { thinking: changedThinking } : {}),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_768, maxTokens: 4096,
    })),
  });
  pi.registerCommand("fixture-model-roles", {
    description: "Read the native session's actual current model and role resolution without a model call",
    handler: async (args, ctx) => {
      const identity = (model: { provider: string; id: string } | undefined) => model ? { provider: model.provider, id: model.id } : null;
      const data = { fixture: modelRolesMarker, token: args.trim(), model: identity(ctx.models.current()),
        smol: identity(ctx.models.resolve("@smol")), judge: identity(ctx.models.resolve("@judge")) };
      pi.appendEntry(modelRolesMarker, data);
      ctx.ui.notify(JSON.stringify(data), "info");
    },
  });
}
