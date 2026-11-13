import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { getBundledProviders } from "../../.upstream/omp/packages/catalog/src/models";

const RECORD_TYPE = "omp-superagent-native-test";

/** Private test configuration only: prevent normal catalog/local-server discovery. */
export const nativeDisabledProviders = [...new Set([
  ...getBundledProviders(), "ollama", "lm-studio", "llama.cpp", "apple",
])];

/** Command-only native RPC fixture. Any accidental network/model activity is observable. */
export default function nativeFixture(pi: ExtensionAPI): void {
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

  pi.on("session_shutdown", (_event, ctx) => {
    record(ctx, "shutdown", "native-graceful-shutdown");
  });
}
