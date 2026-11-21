import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { getBundledProviders } from "@oh-my-pi/pi-catalog/models";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { registerDecisionAsk } from "../../src/decision-tool";
import { recordHostFixture } from "./host-fixture-processes";

const RECORD_TYPE = "omp-superagent-native-test";

/** Private test configuration only: prevent normal catalog/local-server discovery. */
export const nativeDisabledProviders = [...new Set([
  ...getBundledProviders(), "ollama", "lm-studio", "llama.cpp", "apple",
])];

/** Offline native RPC fixture; all provider responses and network attempts are observable. */
export default function nativeFixture(pi: ExtensionAPI): void {
  const fixtureRoot = process.env.OMP_TEST_HOST_FIXTURE_ROOT;
  if (fixtureRoot) recordHostFixture(fixtureRoot);
  registerDecisionAsk(pi);
  let serviceRequested = false;
  const mock = createMockModel({ provider: "socket-host-smoke", id: "local",
    handler: context => {
      const lastUser = context.messages.findLast(message => message.role === "user");
      const input = JSON.stringify(lastUser?.content);
      const decision = input?.includes("[native-decision-submit]") ? "submit"
        : input?.includes("[native-decision-cancel]") ? "cancel" : undefined;
      if (decision) {
        const id = `native-decision-${decision}`;
        if (!context.messages.some(message => message.role === "toolResult" && message.toolCallId === id)) {
          return { content: [{ type: "toolCall", id, name: "decision_ask", arguments: { questions: [
            { question: "Which release route?", header: "Release",
              options: [{ label: "Local", description: "Keep changes local", preview: "No deployment" },
                { label: "Review", description: "Prepare review" }], recommended: 1 },
            { question: "Which checks?", options: [{ label: "Types" }, { label: "Tests" }], multi: true },
          ] } }] };
        }
        return { content: ["Native decision tool finished"] };
      }
      if (input?.includes("[native-foreign-service-proof]")
        && !context.messages.some(message => message.role === "toolResult" && message.toolCallId === "native-foreign-service")) {
        return { content: [{ type: "toolCall", id: "native-foreign-service", name: "bash", arguments: {
          command: "printf 'must not replace the other session\\n'", name: "sa-host-foreign", pty: false,
        } }] };
      }
      if (input?.includes("[native-foreign-service-owner]")
        && !context.messages.some(message => message.role === "toolResult" && message.toolCallId === "native-foreign-owner")) {
        return { content: [{ type: "toolCall", id: "native-foreign-owner", name: "bash", arguments: {
          command: "while [ ! -f .sa-release-foreign ]; do sleep 0.05; done; printf 'original process exited\\n' > .sa-foreign-receipt",
          name: "sa-host-foreign", pty: false,
        } }] };
      }
      if (input?.includes("[native-service-denial-proof]")
        && !context.messages.some(message => message.role === "toolResult" && message.toolCallId === "native-service-denied")) {
        return { content: [{ type: "toolCall", id: "native-service-denied", name: "bash", arguments: {
          command: "printf 'superagent-service-completed\\n'", name: "sa-host-proof", pty: false,
        } }] };
      }
      const service = context.messages.some(message => message.role === "user" && JSON.stringify(message.content).includes("[native-service-proof]"));
      if (service && !serviceRequested) {
        serviceRequested = true;
        return { content: [
          { type: "toolCall", id: "native-service-first", name: "bash", arguments: {
            command: "printf 'superagent-service-completed\\n'", name: "sa-host-proof", pty: false,
          } },
          { type: "toolCall", id: "native-service-overlap", name: "bash", arguments: {
            command: "printf 'must not replace the first launch\\n'", name: "sa-host-proof", pty: false,
          } },
          { type: "toolCall", id: "native-service-blank", name: "bash", arguments: {
            command: "printf 'ordinary finite Bash\\n'", name: " \t ", pty: false,
          } },
        ] };
      }
      return { content: ["Socket host smoke response"] };
    } });
  pi.registerProvider("socket-host-smoke", {
    baseUrl: "mock://socket-host-smoke", apiKey: "offline-native-fixture", api: "socket-host-smoke",
    models: [{ id: mock.id, name: mock.name, reasoning: mock.reasoning, input: mock.input,
      cost: mock.cost, contextWindow: mock.contextWindow, maxTokens: mock.maxTokens }],
    streamSimple: (model, context, options) => mock.stream(model, context, options),
  });
  let agentStarts = 0;
  let networkAttempts = 0;
  const refuseNetwork = () => {
    networkAttempts++;
    throw new Error("Native host lifecycle fixture forbids network access");
  };
  globalThis.fetch = Object.assign(async () => refuseNetwork(), { preconnect: refuseNetwork });
  pi.on("agent_start", () => { agentStarts++; });

  const record = (ctx: ExtensionContext, phase: string, token: string, confirmed?: boolean) => {
    const data = {
      phase, token, confirmed, agentStarts, networkAttempts,
      sessionId: ctx.sessionManager.getSessionId(), pid: process.pid,
    };
    pi.appendEntry(RECORD_TYPE, data);
    return data;
  };

  pi.registerCommand("fixture-state", {
    description: "Persist a local lifecycle checkpoint without invoking a model",
    handler: async (args, ctx) => {
      const checkpoint = record(ctx, "checkpoint", args.trim());
      const answers = ctx.sessionManager.getBranch().filter(entry =>
        entry.type === "custom" && entry.customType === RECORD_TYPE &&
        (entry.data as { phase?: string } | undefined)?.phase === "answer",
      ).map(entry => entry.type === "custom" ? entry.data : undefined);
      ctx.ui.notify(JSON.stringify({ fixture: RECORD_TYPE, ...checkpoint, answers }), "info");
    },
  });

  pi.registerCommand("fixture-ask", {
    description: "Await a native RPC confirmation and persist its one winning answer",
    handler: async (args, ctx) => {
      const token = args.trim();
      const confirmed = await ctx.ui.confirm("Native lifecycle approval", token, { timeout: 30_000 });
      const answer = record(ctx, "answer", token, confirmed);
      ctx.ui.notify(JSON.stringify({ fixture: RECORD_TYPE, ...answer }), "info");
    },
  });

  pi.registerCommand("fixture-form", {
    description: "Await an untimed native HTML form when available",
    handler: async (args, ctx) => {
      let phase = "form-unavailable";
      if (ctx.ui.formDialog) {
        const answer = await ctx.ui.formDialog('<form><label>Route <input name="route" value="local"></label></form>');
        phase = answer === undefined ? "form-cancelled" : "form-submitted";
      }
      const result = record(ctx, phase, args.trim());
      ctx.ui.notify(JSON.stringify({ fixture: RECORD_TYPE, ...result }), "info");
    },
  });

  pi.on("session_shutdown", (_event, ctx) => {
    record(ctx, "shutdown", "native-graceful-shutdown");
  });
}
