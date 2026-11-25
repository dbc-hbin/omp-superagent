/** Deterministic model and lost transport responses; the actual HEAD owns recovery. */
import assert from "node:assert/strict";
import { appendFileSync, existsSync, watch } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { HostConnection } from "../../src/host";
import superagentExtension from "../../src/extension";
import { nativeRequestEnvelope } from "./native-request-envelope";

// This entrypoint imports the real manager so both share HostConnection's module identity.
const manager = fileURLToPath(new URL("../../src/extension.ts", import.meta.url));

export default function recoveryProvider(pi: ExtensionAPI): void {
  const root = process.env.OMP_NATIVE_GATEWAY_ROOT;
  assert(root && process.env.HOME === join(root, "home"));
  assert.equal(process.env.OMP_SUPERAGENT_ROLE, "head");
  assert(!process.argv.includes(manager));
  const record = (kind: string, data: Record<string, unknown> = {}) =>
    appendFileSync(join(root, "recovery-events.jsonl"), `${JSON.stringify({ kind, pid: process.pid, ...data })}\n`, { mode: 0o600 });
  const suppressed = new Set<string>();
  const request = HostConnection.prototype.request;
  const onFrame = HostConnection.prototype.onFrame;
  HostConnection.prototype.onFrame = function (listener) {
    return onFrame.call(this, frame => {
      if (frame.type === "prompt_result" && typeof frame.id === "string" && suppressed.has(frame.id)) return;
      listener(frame);
    });
  };
  HostConnection.prototype.request = async function (command, id) {
    const input = command.type === "prompt" && typeof command.message === "string"
      ? nativeRequestEnvelope(command.message)?.requestId : undefined;
    if (input === "803") {
      record("unadmitted-prompt", { inputId: input, requestId: id });
      throw new Error("Isolated native admission transport was lost before receipt");
    }
    if (!input || !["801", "805"].includes(input)) return request.call(this, command, id);
    assert(id);
    suppressed.add(id);
    const terminal = Promise.withResolvers<void>();
    const unsubscribe = onFrame.call(this, frame => {
      if (frame.type === "prompt_result" && frame.id === id) {
        record("dropped-terminal", { inputId: input, frame });
        terminal.resolve();
      }
    });
    try {
      await request.call(this, command, id);
      await terminal.promise;
      throw new Error("Isolated native prompt response and terminal delivery lost");
    } finally { unsubscribe(); }
  };
  pi.on("session_shutdown", () => {
    HostConnection.prototype.request = request;
    HostConnection.prototype.onFrame = onFrame;
  });
  superagentExtension(pi);
  const local = createMockModel({
    provider: "gateway-native", id: "local", contextWindow: 65_536, maxTokens: 4096,
    handler: async context => {
      const users = context.messages.flatMap((message, index) => {
        if (message.role !== "user") return [];
        const text = typeof message.content === "string" ? message.content
          : message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
        return [{ index, text }];
      });
      const selected = users.at(-1);
      assert(selected, "The actual HEAD must supply a native request or recovery turn");
      const recoveryJson = /^HEAD recovery snapshot: (\{[^\n]+\})$/m.exec(selected.text)?.[1];
      if (recoveryJson) {
        assert(!context.systemPrompt?.some(part => part.includes("<superagent-reply-voice>")), "Structured HEAD recovery inherited owner-facing reply voice");
        const snapshot = JSON.parse(recoveryJson) as { attemptId: string; inputId: string; evidenceEntryIds: string[] };
        assert.equal(typeof snapshot.attemptId, "string");
        assert(Array.isArray(snapshot.evidenceEntryIds));
        assert(["801", "805"].includes(snapshot.inputId), "A missing original receipt cannot authorize a speculative recovery model turn");
        record("recovery-model", { snapshot, tools: context.tools?.map(tool => tool.name) });
        if (snapshot.inputId === "801") {
          const released = Promise.withResolvers<void>();
          const watcher = watch(root, () => { if (existsSync(join(root, "release-recovery"))) released.resolve(); });
          try {
            if (!existsSync(join(root, "release-recovery"))) await released.promise;
          } finally { watcher.close(); }
        }
        if (snapshot.inputId === "805") return { content: [{
          type: "toolCall", id: `recovery-escape:${snapshot.attemptId}`, name: "write",
          arguments: { path: join(root, "unauthorized-recovery-write"), content: "must not execute" },
        }] };
        return { content: [{
          type: "toolCall", id: `recovery-decision:${snapshot.attemptId}`, name: "head_recovery",
          arguments: { attemptId: snapshot.attemptId,
            decision: "release",
            evidenceEntryIds: snapshot.evidenceEntryIds,
            reason: "The exact original native receipt and final owned run establish native processing completion, not task acceptance." },
        }] };
      }
      const inputId = nativeRequestEnvelope(selected.text)?.requestId;
      assert(inputId, "Unexpected native input; recovery must provide its evidence envelope");
      record("ordinary-model", { inputId });
      const results = context.messages.slice(selected.index + 1).filter(message => message.role === "toolResult");
      if (["801", "805"].includes(inputId) && !results.length) return { content: [{
        type: "toolCall", id: `original-effect:${inputId}`, name: "write",
        arguments: { path: join(root, `original-effect-${inputId}`), content: `Original native effect ${inputId}\n` },
      }] };
      assert(results.every(message => !message.isError), JSON.stringify(results));
      return { content: [`HEAD:${inputId}`] };
    },
  });
  pi.registerProvider("gateway-native", {
    baseUrl: "mock://gateway-native", api: "gateway-native", apiKey: "local-test-only",
    streamSimple: (model, context, options) => local.stream(model, context, options),
    models: [{ id: "local", name: "Native HEAD recovery deterministic model", kind: "chat", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: local.contextWindow, maxTokens: local.maxTokens }],
  });
}
