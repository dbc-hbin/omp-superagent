/** Only the model transport is scripted; every tool runs in production OMP. */
import { watch } from "node:fs";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { createMockModel, type MockResponse } from "../../.upstream/omp/packages/ai/src/providers/mock";
import { nativeRequestEnvelope } from "./native-request-envelope";

const provider = "gateway-native";
const model = "local";
const managers = ["lane_models", "lane_init_presets", "lane_set_model", "lane_start", "lane_inspect", "lane_message", "lane_pause", "lane_resume", "lane_close"];

export default function gatewayProvider(pi: ExtensionAPI): void {
  const root = process.env.OMP_NATIVE_GATEWAY_ROOT;
  if (!root) throw new Error("Native Gateway provider requires a private test root");
  const role = process.env.OMP_SUPERAGENT_ROLE;
  const local = createMockModel({ provider, id: model, handler: async context => {
    const userIndex = context.messages.findLastIndex(message => message.role === "user" && JSON.stringify(message.content).includes("Request ID: "));
    const user = context.messages[userIndex];
    const text = user?.role === "user" ? typeof user.content === "string" ? user.content
      : user.content.filter(part => part.type === "text").map(part => part.text).join("\n") : "";
    // Native OMP prepends its date/cwd reminder to the first model-visible
    // request. The durable runtime envelope remains an exact line, not byte 0.
    const requestId = nativeRequestEnvelope(text)?.requestId;
    if (!requestId) throw new Error(`Unexpected native Gateway model input: ${text}`);
    const tools = new Set(context.tools?.map(tool => tool.name));
    if (!tools.has("read") || !tools.has("write")) throw new Error("Native tool discovery/device transports are missing");
    if (role === "lane" && managers.some(name => tools.has(name))) throw new Error("Lane loaded head management authority");
    const calls = new Map(context.messages.slice(userIndex + 1).flatMap(message => message.role === "assistant"
      ? message.content.flatMap(part => part.type === "toolCall" ? [[part.id, part] as const] : []) : []));
    const results = context.messages.slice(userIndex + 1).filter(message => message.role === "toolResult");
    const denied = role === "lane" ? results.find(message => message.toolName === "write" &&
      calls.get(message.toolCallId)?.arguments.path === "xd://lane_message") : undefined;
    if (denied && (!denied.isError || !JSON.stringify(denied.content).includes("No such tool: xd://lane_message"))) {
      throw new Error(`Separate lane unexpectedly acquired head manager authority: ${JSON.stringify(denied)}`);
    }
    const failures = results.filter(message => message.isError && message !== denied);
    if (failures.length) throw new Error(`Production tool failed: ${JSON.stringify(failures)}`);
    const called = (name: string) => results.some(message => message.toolName === name ||
      (message.toolName === "write" && calls.get(message.toolCallId)?.arguments.path === `xd://${name}`));
    const invoke = (name: string, args: Record<string, unknown>): MockResponse => {
      if (tools.has(name)) return { content: [{ type: "toolCall", name, arguments: args }] };
      const documented = results.some(message => message.toolName === "read" &&
        calls.get(message.toolCallId)?.arguments.path === `xd://${name}`);
      if (!documented) return { content: [{ type: "toolCall", name: "read", arguments: { path: `xd://${name}` } }] };
      return { content: [{ type: "toolCall", name: "write", arguments: { path: `xd://${name}`, content: JSON.stringify(args) } }] };
    };

    if (role === "head") {
      if (requestId === "202") {
        if (!called("board_post")) return invoke("board_post", {
          channel: "general", text: "native-gateway:head-brief", mentions: [],
        });
        if (!called("lane_start")) return invoke("lane_start", {
          sourceId: requestId, title: "Native Gateway independent topic", cwd: join(root, "topic"),
          model: { provider, id: model }, modelReason: "Use the isolated deterministic available text model for actual Gateway native integration.",
          acceptance: ["Return findings to the head; never send directly to Messenger"],
        });
        return { content: [] };
      }
      if (["203", "204", "205", "206"].includes(requestId)) {
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
        return { content: [`HEAD:${sourceId}`] };
      }
      if (requestId === "207") {
        // Hold only the deterministic model boundary so stop() sees real native
        // streaming work. The release file is an event, not a guessed delay.
        const released = Promise.withResolvers<void>();
        const watcher = watch(root, (_event, name) => { if (String(name) === "release-207") released.resolve(); });
        try {
          await writeFile(join(root, "entered-207"), "ready", { mode: 0o600 });
          try { await access(join(root, "release-207")); }
          catch { await released.promise; }
        } finally { watcher.close(); }
      }
      return { content: [`HEAD:${requestId}`] };
    }

    if (role !== "lane") throw new Error(`Unexpected Gateway native role: ${role}`);
    if (!denied) return { content: [{ type: "toolCall", name: "write", arguments: {
      path: "xd://lane_message", content: JSON.stringify({ id: process.env.OMP_SUPERAGENT_LANE,
        sourceId: requestId, text: "An unauthorized native lane manager call must be denied." }),
    } }] };
    if (!called("board_read")) return invoke("board_read", { channel: "general", unreadOnly: false });
    if (!JSON.stringify(results).includes("native-gateway:head-brief")) throw new Error("Lane did not read the actual head board post");
    if (!called("board_post")) return invoke("board_post", {
      channel: "general", text: `native-gateway:lane-finding:${requestId}`, mentions: ["head"],
    });
    return { content: [`LANE:${requestId}`] };
  } });
  pi.registerProvider(provider, {
    baseUrl: `mock://${provider}`, api: provider, apiKey: "local-test-only",
    streamSimple: (identity, context, options) => local.stream(identity, context, options),
    models: [{ id: model, name: "Native Gateway deterministic local model", kind: "chat", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_768, maxTokens: 4096 }],
  });
}
