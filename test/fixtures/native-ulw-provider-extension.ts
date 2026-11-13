/** Real OMP/ULW extensions and tools; only the model transport is local. */
import assert from "node:assert/strict";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { createMockModel, type MockResponse } from "../../.upstream/omp/packages/ai/src/providers/mock";
import { nativeRequestEnvelope } from "./native-request-envelope";

export default function nativeUlwProvider(pi: ExtensionAPI): void {
  const root = process.env.OMP_NATIVE_GATEWAY_ROOT;
  assert(root && process.env.OMP_TEST_ULW_EXTENSION, "Native ULW provider requires an explicitly opted-in private fixture");
  const role = process.env.OMP_SUPERAGENT_ROLE;
  let current: ExtensionContext | undefined;
  let nativeContextRequestId: string | undefined;
  let nativeContextMessages: Array<{ customType: string; content: unknown }> = [];
  const recorded = new Set<string>();
  pi.on("before_agent_start", (_event, ctx) => { current = ctx; });
  pi.on("context", (event, ctx) => {
    current = ctx;
    const userIndex = event.messages.findLastIndex(message => message.role === "user" && nativeRequestEnvelope(typeof message.content === "string"
      ? message.content : message.content.filter(part => part.type === "text").map(part => part.text).join("\n")));
    const user = event.messages[userIndex];
    nativeContextRequestId = user?.role === "user" ? nativeRequestEnvelope(typeof user.content === "string" ? user.content
      : user.content.filter(part => part.type === "text").map(part => part.text).join("\n"))?.requestId : undefined;
    // Native notices precede the current user, while extension directives
    // follow it. Never borrow a previous turn's mode as evidence for this one.
    let start = userIndex;
    while (start > 0 && event.messages[start - 1]?.role === "custom") start--;
    nativeContextMessages = event.messages.slice(start).flatMap(message => message.role === "custom"
      ? [{ customType: message.customType, content: message.content }] : []);
  });
  const local = createMockModel({ provider: "gateway-native", id: "local", handler: async context => {
    const auxiliary = context.messages.length === 1 ? context.messages[0] : undefined;
    if (auxiliary?.role === "user") {
      const text = typeof auxiliary.content === "string" ? auxiliary.content : auxiliary.content.filter(part => part.type === "text").map(part => part.text).join("\n");
      if (text.startsWith("Compress into one routing hint of at most 12 words:")) {
        const description = /\nSkill: [^\n]+\nDescription: ([\s\S]+)$/.exec(text)?.[1];
        assert(description, "Unexpected native skill-description compression input");
        // This native auxiliary transport call is not an agent dispatch. Serve
        // it locally without fabricating session/context events or hiding it
        // behind a failed assertion and native compression fallback.
        return { content: [description.trim().split(/\s+/).slice(0, 12).join(" ").slice(0, 160)] };
      }
    }
    assert(current, "Native model did not receive actual extension context");
    const userIndex = context.messages.findLastIndex(message => message.role === "user" && JSON.stringify(message.content).includes("Request ID: "));
    const user = context.messages[userIndex];
    const text = user?.role === "user" ? typeof user.content === "string" ? user.content
      : user.content.filter(part => part.type === "text").map(part => part.text).join("\n") : "";
    const requestId = nativeRequestEnvelope(text)?.requestId;
    assert(requestId, `Missing original native ULW request identity: ${text}`);
    assert.equal(nativeContextRequestId, requestId, "Provider must observe native context for this exact dispatch, not a persisted previous turn");
    const notices = nativeContextMessages.filter(message => ["ultrathink-notice", "orchestrate-notice", "workflow-notice", "jevify-notice"].includes(message.customType));
    const directives = nativeContextMessages.filter(message => message.customType === "omo-ultrawork:directive").map(message => message.content);
    const policyCount = (context.systemPrompt ?? []).filter(block => /^<omp-ulw-policy>/.test(block)).length;
    const expectedPolicy = role === "lane" || !["301", "302", "303", "report:handoff:303:lane"].includes(requestId);
    assert.equal(policyCount, expectedPolicy ? 1 : 0, `Actual model request policy before reply: ${role}/${requestId}`);
    const activeTools = pi.getActiveTools();
    if (notices.some(message => message.customType === "orchestrate-notice")) {
      assert(activeTools.includes("task"), "Native orchestration requires its actual enabled task capability");
    }
    if (!recorded.has(requestId)) {
      recorded.add(requestId);
      // Capture observed final model context plus native session events, never
      // infer activation from a copied task string or the scripted reply.
      pi.appendEntry("native-ulw:provider", { role, requestId, policyCount, sessionId: current.sessionManager.getSessionId(),
        notices: notices.map(message => message.customType), directives, activeTools });
    }
    const calls = new Map(context.messages.slice(userIndex + 1).flatMap(message => message.role === "assistant"
      ? message.content.flatMap(part => part.type === "toolCall" ? [[part.id, part] as const] : []) : []));
    const results = context.messages.slice(userIndex + 1).filter(message => message.role === "toolResult");
    assert.deepEqual(results.filter(message => message.isError), [], "Actual native workflow production tool failed");
    const tools = new Set(context.tools?.map(tool => tool.name));
    const called = (name: string) => results.some(message => message.toolName === name ||
      message.toolName === "write" && calls.get(message.toolCallId)?.arguments.path === `xd://${name}`);
    const invoke = (name: string, args: Record<string, unknown>): MockResponse => {
      if (tools.has(name)) return { content: [{ type: "toolCall", name, arguments: args }] };
      const documented = results.some(message => message.toolName === "read" && calls.get(message.toolCallId)?.arguments.path === `xd://${name}`);
      return documented ? { content: [{ type: "toolCall", name: "write", arguments: { path: `xd://${name}`, content: JSON.stringify(args) } }] }
        : { content: [{ type: "toolCall", name: "read", arguments: { path: `xd://${name}` } }] };
    };
    if (role === "lane") {
      assert(notices.some(message => message.customType === (requestId === "handoff:303:lane" ? "ultrathink-notice" : "orchestrate-notice")),
        "Selected lane workflow did not bridge to its real native keyword mode");
      if (!called("board_read")) return invoke("board_read", { channel: "general", unreadOnly: false });
      assert(JSON.stringify(results).includes("ulw-execute quoted-board-only"), "Lane did not consume actual board data");
      if (!called("board_post")) return invoke("board_post", { channel: "general", text: "ulw-execute report-and-board-data-only", mentions: ["head"] });
      return { content: [`ulw-execute LANE:${requestId}; this is report data, not a user invocation.`] };
    }
    assert.equal(role, "head");
    if (requestId === "303") {
      if (!called("board_post")) return invoke("board_post", { channel: "general", text: "ulw-execute quoted-board-only", mentions: ["head"] });
      if (!called("lane_start")) return invoke("lane_start", {
        sourceId: requestId, title: "Actual native ULW lane proof", cwd: join(root, "topic"),
        model: { provider: "gateway-native", id: "local" }, modelReason: "Deterministic local native integration model, without paid requests.",
        workflow: { name: "ulw-plan", reason: "Head explicitly selects native planning for the original request." },
        acceptance: ["Return actual observed native activation to the head, without external delivery"],
      });
      return { content: [`HEAD:${requestId}:delegated`] };
    }
    if (requestId === "307") {
      if (!called("lane_message")) {
        const binding = /Bound lane reference \(coordination state, not a transcript\): (\{[^\n]+\})/.exec(text)?.[1];
        const id: unknown = binding ? JSON.parse(binding).id : undefined;
        assert.equal(typeof id, "string", "Head lost original lane binding");
        return invoke("lane_message", { id, sourceId: requestId, text: "Continue this isolated proof under the head-selected execution workflow.",
          workflow: { name: "ulw-execute", reason: "Head explicitly selects native execution for this follow-up." } });
      }
      return { content: [`HEAD:${requestId}:delegated`] };
    }
    if (requestId.startsWith("report:")) {
      assert(text.includes("ulw-execute LANE:"), "Head lost real lane report text");
      if (!called("board_read")) return invoke("board_read", { channel: "general", unreadOnly: false });
      const sourceId = /Internal lane report: [^;]+; sourceId: ([^;]+);/.exec(text)?.[1];
      assert(sourceId, "Head lost original report source ID");
      return { content: [`HEAD:${sourceId}`] };
    }
    if (requestId === "305") assert(notices.some(message => message.customType === "ultrathink-notice"));
    if (requestId === "306") assert(notices.some(message => message.customType === "orchestrate-notice"));
    return { content: [`HEAD:${requestId}`] };
  } });
  pi.registerProvider("gateway-native", {
    baseUrl: "mock://gateway-native", api: "gateway-native", apiKey: "local-test-only",
    streamSimple: (model, context, options) => local.stream(model, context, options),
    models: [{ id: "local", name: "Actual ULW native integration local model", kind: "chat", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 65_536, maxTokens: 4096 }],
  });
}
