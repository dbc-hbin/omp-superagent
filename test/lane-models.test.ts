import { expect, test } from "bun:test";
import { codingModels, isLaneModel, laneModelArgument, sameLaneModel } from "../src/lane-models";

test("coding candidates exclude specialized runners and never expose credentials or endpoints", () => {
  const identities = [
    { provider: "operator", id: "ordinary" },
    { provider: "operator", id: "explicit-chat", kind: "chat", name: "Configured model",
      input: ["text", "image"], contextWindow: 100_000, maxTokens: 10_000, reasoning: true, supportsTools: false,
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0.5, private: "do-not-expose" },
      baseUrl: "https://secret.invalid/token", headers: { Authorization: "secret" }, apiKey: "secret" },
    ...["judge", "tiny", "image", "tts", "stt", "search", "embedding", "rerank", "video"]
      .map(kind => ({ provider: "operator", id: kind, kind })),
  ];
  expect(codingModels(identities)).toEqual([
    { provider: "operator", id: "ordinary" },
    { provider: "operator", id: "explicit-chat", name: "Configured model",
      input: ["text", "image"], contextWindow: 100_000, maxTokens: 10_000, reasoning: true, supportsTools: false,
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0.5 } },
  ]);
});

test("unknown capability or cost stays unknown rather than inventing a free fast tier", () => {
  expect(codingModels([
    null, { provider: "", id: "bad" },
    { provider: "operator", id: "limited", contextWindow: 0, maxTokens: Number.NaN,
      reasoning: "fast", input: ["text", 1], cost: { input: -1, output: "free" } },
  ])).toEqual([{ provider: "operator", id: "limited" }]);
  expect(() => codingModels(undefined)).toThrow("model list");
});

test("model identity is the exact provider and id, including model ids containing slashes", () => {
  const chosen = { provider: "router", id: "vendor/model" };
  expect(laneModelArgument(chosen)).toBe("router/vendor/model");
  expect(sameLaneModel(chosen, { ...chosen })).toBe(true);
  expect(sameLaneModel(chosen, { provider: "vendor", id: "model" })).toBe(false);
  expect(sameLaneModel(chosen, null)).toBe(false);
  expect(isLaneModel({ provider: "router", id: "\0" })).toBe(false);
  expect(codingModels([chosen, chosen])).toEqual([chosen]);
});
