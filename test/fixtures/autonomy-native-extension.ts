import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { readFileSync } from "node:fs";
import { createMockModel } from "../../.upstream/omp/packages/ai/src/providers/mock";
import { nativeRequestEnvelope } from "./native-request-envelope";

export const autonomyModel = { provider: "autonomy-native", id: "local" } as const;

/** Only the provider is scripted; native goals, tools, abort and RPC execution are real. */
export default function autonomyFixture(pi: ExtensionAPI): void {
  let run = 0;
  let created = false;
  let completed = false;
  let held = false;
  let headTodoStep = 0;
  pi.on("agent_start", () => { run++; });
  pi.on("session_before_compact", async (_event, ctx) => {
    await ctx.ui.confirm("Autonomy serial barrier", "Release the isolated native compaction command.");
    return { cancel: true };
  });
  pi.registerTool({
    name: "fixture_autonomy_hold", label: "Hold owned native work",
    description: "Hold this native tool until the owner interrupts it.",
    approval: "read", loadMode: "essential", parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      if (!signal) throw new Error("Native hold requires the actual execution AbortSignal");
      held = true;
      const stopped = Promise.withResolvers<void>();
      const abort = () => stopped.resolve();
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      try {
        await stopped.promise;
        return { content: [{ type: "text", text: "Native owned work interrupted" }], details: {} };
      } finally { signal.removeEventListener("abort", abort); }
    },
  });
  const mock = createMockModel({
    ...autonomyModel,
    handler: context => {
      const envelope = context.messages.flatMap(message => {
        if (message.role !== "user") return [];
        const text = typeof message.content === "string" ? message.content
          : message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
        const parsed = nativeRequestEnvelope(text);
        return parsed ? [{ ...parsed, text }] : [];
      }).at(-1);
      if (!envelope) throw new Error("Native autonomy model requires the production source envelope");
      if (process.env.OMP_SUPERAGENT_ROLE !== "lane") {
        if (envelope.text.includes("[head-todo-empty-tail]")) {
          const task = `Verify retained head reply ${envelope.sourceId}`;
          if (headTodoStep === 0) {
            if (!context.tools?.some(tool => tool.name === "todo")) throw new Error("Head did not expose the native todo tool");
            headTodoStep = 1;
            return { content: [{ type: "toolCall", name: "todo", arguments: {
              op: "init", list: [{ phase: "Head reply retention", items: [task] }],
            } }] };
          }
          if (headTodoStep === 1) {
            const result = context.messages.at(-1);
            if (result?.role !== "toolResult" || result.toolName !== "todo" || result.isError)
              throw new Error("The actual native todo creation did not succeed");
            headTodoStep = 2;
            return { content: [`HEAD_TODO_REPLY ${envelope.sourceId}`] };
          }
          if (!context.messages.some(message => {
            if (message.role !== "developer") return false;
            const text = typeof message.content === "string" ? message.content
              : message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
            return text.includes("You stopped with 1 incomplete todo item(s):") && text.includes(task);
          }))
            throw new Error("Empty head reply requires the actual native incomplete-todo reminder");
          headTodoStep = 3;
          return { content: [], stopReason: "stop" };
        }
        // The next ordinary head request removes this scenario's native todo
        // through the actual tool before returning its own, unrelated answer.
        if (headTodoStep === 3) {
          headTodoStep = 4;
          return { content: [{ type: "toolCall", name: "todo", arguments: { op: "rm" } }] };
        }
        if (headTodoStep === 4) {
          const result = context.messages.at(-1);
          if (result?.role !== "toolResult" || result.toolName !== "todo" || result.isError)
            throw new Error("The actual native todo cleanup did not succeed");
          headTodoStep = 5;
        }
        return { content: [`HEAD ${envelope.requestId}`] };
      }
      if (envelope.text.includes("[resume-correction]")) {
        const attachment = /local file ([^;\n]+);/.exec(envelope.text)?.[1];
        if (!attachment || readFileSync(attachment, "utf8") !== "Apply the exact owner correction.\n")
          throw new Error("The original correction attachment was not delivered");
        return { content: [`CORRECTION_APPLIED ${envelope.sourceId}`] };
      }
      if (envelope.text.includes("[goal-disabled]")) {
        if (context.tools?.some(tool => tool.name === "goal")) throw new Error("Managed role bypassed goal.enabled=false");
        return { content: ["NATIVE_GOAL_DISABLED"] };
      }
      if (!created) {
        if (!context.tools?.some(tool => tool.name === "goal")) throw new Error("Managed role did not expose the native goal tool");
        created = true;
        return { content: [{ type: "toolCall", name: "goal", arguments: {
          op: "create", objective: `Verify entrusted objective ${envelope.sourceId} through two native turns`,
        } }] };
      }
      if (context.messages.some(message => message.role === "toolResult" && message.toolName === "goal" && message.isError))
        throw new Error("A real native goal operation failed");
      if (run === 1) return { content: ["Milestone reached; useful objective work remains."] };
      if (envelope.text.includes("[pause-goal]") && !held)
        return { content: [{ type: "toolCall", name: "fixture_autonomy_hold", arguments: {} }] };
      if (!completed) {
        completed = true;
        return { content: [{ type: "toolCall", name: "goal", arguments: { op: "complete" } }] };
      }
      return { content: [`AUTONOMY_COMPLETE ${envelope.sourceId}; runs=${run}`] };
    },
  });
  pi.registerProvider(autonomyModel.provider, {
    baseUrl: "mock://autonomy-native", api: autonomyModel.provider, apiKey: "local-test-only",
    streamSimple: (model, context, options) => mock.stream(model, context, options),
    models: [{ id: autonomyModel.id, name: "Local native autonomy proof", kind: "chat", reasoning: false,
      input: ["text"], contextWindow: 200_000, maxTokens: 32_768,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  });
}
