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
  const startup = "Native preset startup initialization (internal control turn, not a messenger user request).";
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
    const scriptedCalls = new Map<string, { kind: "delegation" | "finding"; sourceId: string }>();
    const delegated = new Set<string>();
    const findings = new Set<string>();
    for (const message of context.messages) {
      if (message.role === "assistant") {
        for (const part of message.content) {
          if (part.type !== "toolCall") continue;
          // A replacement native provider can reuse a prior process's call IDs.
          scriptedCalls.delete(part.id);
          const name = part.name === "write" ? String(part.arguments.path).replace(/^xd:\/\//, "") : part.name;
          const args = ["lane_message", "board_post"].includes(part.name) ? part.arguments
            : part.name === "write" && ["xd://lane_message", "xd://board_post"].includes(String(part.arguments.path))
              ? JSON.parse(String(part.arguments.content)) as Record<string, unknown> : undefined;
          if (name === "lane_message" && typeof args?.sourceId === "string") {
            scriptedCalls.set(part.id, { kind: "delegation", sourceId: args.sourceId });
          } else if (name === "board_post" && typeof args?.text === "string" && args.text.startsWith("native-gateway:lane-finding:")) {
            scriptedCalls.set(part.id, { kind: "finding", sourceId: args.text.slice("native-gateway:lane-finding:".length) });
          }
        }
      } else if (message.role === "toolResult") {
        const call = scriptedCalls.get(message.toolCallId);
        scriptedCalls.delete(message.toolCallId);
        if (call && !message.isError) (call.kind === "delegation" ? delegated : findings).add(call.sourceId);
      }
    }
    // Steering can arrive between discovering a manager device and invoking it.
    // Finish every explicit source decision in order; newest-user-only selection
    // silently abandoned 205 when 206 arrived after 205's read(xd://lane_message).
    const activeUsers = users.slice(Math.max(0, users.findLastIndex(user => !user.steering)));
    const selected = activeUsers.find(user => user.requestId && (role === "head"
      ? ["203", "204", "205", "206"].includes(user.requestId) && !delegated.has(user.requestId)
      : role === "lane" && !findings.has(user.requestId))) ?? activeUsers.at(-1);
    if (!selected) throw new Error("Unexpected native Gateway model input: no runtime request or startup turn");
    const { index: userIndex, text, requestId, bootstrap } = selected;
    const callPrefix = `gateway-native:${requestId ?? "bootstrap"}:`;
    const tools = new Set(context.tools?.map(tool => tool.name));
    if (!tools.has("read") || !tools.has("write")) throw new Error("Native tool discovery/device transports are missing");
    if (role === "lane" && managers.some(name => tools.has(name))) throw new Error("Lane loaded head management authority");
    const calls = new Map(context.messages.slice(userIndex + 1).flatMap(message => message.role === "assistant"
      ? message.content.flatMap(part => part.type === "toolCall" ? [[part.id, part] as const] : []) : []));
    const results = context.messages.slice(userIndex + 1).filter(message => message.role === "toolResult")
      .filter(message => role !== "lane" || message.toolCallId.startsWith(callPrefix));
    const denied = role === "lane" ? results.find(message => message.toolName === "write" &&
      calls.get(message.toolCallId)?.arguments.path === "xd://lane_message") : undefined;
    if (denied && (!denied.isError || !JSON.stringify(denied.content).includes("No such tool: xd://lane_message"))) {
      throw new Error(`Separate lane unexpectedly acquired head manager authority: ${JSON.stringify(denied)}`);
    }
    const failures = results.filter(message => message.isError && message !== denied);
    if (failures.length) throw new Error(`Production tool failed: ${JSON.stringify(failures)}`);
    const called = (name: string) => name === "lane_message" ? delegated.has(requestId ?? "")
      : results.some(message => message.toolName === name ||
        (message.toolName === "write" && calls.get(message.toolCallId)?.arguments.path === `xd://${name}`));
    const invoke = (name: string, args: Record<string, unknown>): MockResponse => {
      if (tools.has(name)) return { content: [{ type: "toolCall", id: `${callPrefix}${name}:${context.messages.length}`, name, arguments: args }] };
      const documented = results.some(message => message.toolName === "read" &&
        calls.get(message.toolCallId)?.arguments.path === `xd://${name}`);
      if (!documented) return { content: [{ type: "toolCall", id: `${callPrefix}read:${name}:${context.messages.length}`, name: "read", arguments: { path: `xd://${name}` } }] };
      return { content: [{ type: "toolCall", id: `${callPrefix}write:${name}:${context.messages.length}`, name: "write", arguments: { path: `xd://${name}`, content: JSON.stringify(args) } }] };
    };

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
      const lastInit = results.findLastIndex(message => message.toolName === "lane_init_presets" ||
        message.toolName === "write" && calls.get(message.toolCallId)?.arguments.path === "xd://lane_init_presets");
      const readback = results.slice(lastInit + 1).some(message => message.toolName === "lane_models" ||
        message.toolName === "write" && calls.get(message.toolCallId)?.arguments.path === "xd://lane_models");
      if (!readback) return invoke("lane_models", {});
      return { content: ["INTERNAL PRESET INITIALIZATION RESULT: must never reach Messenger."] };
    }
    if (!requestId) throw new Error("Ordinary native input requires its durable request identity");
    if (role === "head") {
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
        const sources = [...text.matchAll(/^LANE:handoff:([^:\r\n]+):[^\r\n]+$/gm)].map(match => match[1]!);
        if (!sources.includes(sourceId) || new Set(sources).size !== sources.length) throw new Error("Consolidated lane report lost or duplicated its original sources");
        return { content: [sources.map(id => `HEAD:${id}`).join("\n")] };
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
    if (!denied) return { content: [{ type: "toolCall", id: `${callPrefix}denied-manager`, name: "write", arguments: {
      path: "xd://lane_message", content: JSON.stringify({ id: process.env.OMP_SUPERAGENT_LANE,
        sourceId: requestId, text: "An unauthorized native lane manager call must be denied." }),
    } }] };
    if (!called("board_read")) return invoke("board_read", { channel: "general", unreadOnly: false });
    if (!JSON.stringify(results).includes("native-gateway:head-brief")) throw new Error("Lane did not read the actual head board post");
    if (!called("board_post")) return invoke("board_post", {
      channel: "general", text: `native-gateway:lane-finding:${requestId}`, mentions: ["head"],
    });
    return { content: [activeUsers.map(user => `LANE:${user.requestId}`).join("\n")] };
  } });
  pi.registerProvider(provider, {
    baseUrl: `mock://${provider}`, api: provider, apiKey: "local-test-only",
    streamSimple: (identity, context, options) => local.stream(identity, context, options),
    models: [{ id: model, name: "Native Gateway deterministic local model", kind: "chat", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: local.contextWindow, maxTokens: local.maxTokens }],
  });
}
