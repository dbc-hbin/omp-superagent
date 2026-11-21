import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { watch } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { nativeRequestEnvelope } from "./native-request-envelope";

export default function topicIsolationProvider(pi: ExtensionAPI): void {
  const root = process.env.OMP_TEST_HOST_FIXTURE_ROOT;
  const role = process.env.OMP_SUPERAGENT_ROLE;
  if (!root || (role !== "head" && role !== "lane")) throw new Error("Expected an isolated topic proof host");

  if (role === "head") {
    // Seed the actual head's per-project bank, without a user or model turn.
    // Passing only the command name over RPC keeps the memory text out of the journal.
    pi.registerCommand("fixture-seed-topic-memory", {
      description: "Seed the private native topic proof bank",
      handler: async (args, ctx) => {
        assert(!args.trim() && ctx.agent.kind === "main" && ctx.cwd === join(root, "head")
          && process.env.HOME === join(root, "home") && process.env.PI_CODING_AGENT_DIR === join(root, "agent"));
        assert(ctx.memory, "Stock OMP does not expose its structured memory runtime");
        const status = await ctx.memory.status();
        assert(status.backend === "mnemopi" && status.active && status.writable && status.searchable
          && status.scope === "per-project" && status.retainBank && status.recallBanks?.length === 1
          && status.recallBanks[0] === status.retainBank
          && status.database?.startsWith(`${join(root, "agent", "topic-memory", "banks")}/`),
        `Expected one private Mnemopi head bank: ${JSON.stringify(status)}`);
        const content = await readFile(join(root, "topic-memory-seed.txt"), "utf8");
        const saved = await ctx.memory.save({ content, source: "native-topic-isolation-proof" });
        assert(saved.backend === "mnemopi" && saved.stored === 1 && saved.ids?.length === 1 && saved.ids[0],
          `Native Mnemopi seed failed: ${JSON.stringify(saved)}`);
        await writeFile(join(root, "topic-memory-seed.json"), JSON.stringify({
          pid: process.pid, sessionId: ctx.sessionManager.getSessionId(), database: status.database, id: saved.ids[0],
        }), { flag: "wx", mode: 0o600 });
      },
    });

    // Advance the monotonic clock of exactly the predecessor OMP process.
    // Production still measures idle time, attests, and authorizes shutdown.
    const clockMarker = `advance-head-clock.${process.pid}`;
    const now = performance.now.bind(performance);
    let offset = 0;
    Object.defineProperty(performance, "now", { configurable: true, value: () => now() + offset });
    const watcher = watch(root, { persistent: false }, (_event, name) => {
      if (String(name) !== clockMarker) return;
      offset = 31 * 60 * 1000;
      watcher.close();
    });
  }

  const contextWindow = 65_536;
  const model = createMockModel({
    provider: "gateway-native", id: "local", contextWindow, maxTokens: 4_096,
    handler: async context => {
      const history = context.messages.flatMap(message => {
        if (message.role !== "user") return [];
        const text = typeof message.content === "string" ? message.content
          : message.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
        const request = nativeRequestEnvelope(text);
        if (!request) return [];
        if (request.sourceId === "312" || request.sourceId === "313") return ["auth-continuation"];
        // A lane's brief repeats its opening task inside the envelope, but
        // only the user text outside it identifies this particular turn.
        const task = text.replace(request.envelope, "");
        const marker = /^\[topic-isolation:([a-z0-9-]+)\]$/m.exec(task)?.[1];
        return marker ? [marker] : [];
      });
      if (!history.length) throw new Error("Topic proof did not receive an authorized model input");
      if (role === "lane" && history.at(-1) === "b3") {
        const released = Promise.withResolvers<void>();
        const watcher = watch(root, (_event, name) => {
          if (String(name) === "release-topic-b") released.resolve();
        });
        try {
          await writeFile(join(root, "topic-b-in-flight"), String(process.pid), { flag: "wx", mode: 0o600 });
          await released.promise;
        } finally { watcher.close(); }
      }
      // This is the stock provider usage path, not a patched native context
      // response. Only the predecessor's coordination turn reaches 50%.
      const input = history.at(-1) === "head-before" ? 36_000 : 128;
      const answer = `topic-proof:${role}:${process.cwd()}:${history.join(",")}`;
      if (history.at(-1) === "auth-continuation") {
        const modelInput = JSON.stringify({ system: context.systemPrompt, messages: context.messages });
        const trace = /\[auth-trace:[0-9a-f-]{36}\]/.exec(modelInput)?.[0];
        const digest = trace ? createHash("sha256").update(trace).digest("hex") : "missing";
        const scope = /\[(?:unrelated-topic-canary|memory-only):/.test(modelInput) ? "leaked" : "bounded";
        return { content: [`${answer}\nauth-trace:${digest}:${scope}`] };
      }
      return { content: [answer],
        usage: { input, output: 16, totalTokens: input + 16 } };
    },
  });
  pi.registerProvider(model.provider, {
    baseUrl: "mock://topic-isolation", apiKey: "offline-native-fixture", api: model.provider,
    models: [{ id: model.id, name: model.name, kind: "chat", reasoning: false, input: ["text"],
      cost: model.cost, contextWindow: model.contextWindow, maxTokens: model.maxTokens }],
    streamSimple: (identity, context, options) => model.stream(identity, context, options),
  });
}
