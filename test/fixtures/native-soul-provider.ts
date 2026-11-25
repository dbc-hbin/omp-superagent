/** Deterministic local inference; the stock Host constructs every observed provider request. */
import assert from "node:assert/strict";
import { existsSync, watch } from "node:fs";
import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { nativeRequestEnvelope } from "./native-request-envelope";
import {
  soulCases, soulChildAnswer, soulChildRelease, soulChildTask, soulDigest, soulKickoff, soulLaneResult, soulSteeredResult,
  soulSteerEntered, soulSteerRelease, soulText, soulVoiceClose, soulVoiceOpen, soulWitnessFile, type SoulProviderWitness,
} from "./native-soul-cases";
import { nativeToolExchanges, nativeToolTurn } from "./native-tool-transport";

const model = { provider: "gateway-native", id: "local" } as const;
const managerTools = ["soul_update", "lane_start", "lane_message"] as const;
const barrierTool = "fixture_soul_steer_barrier";

export default function nativeSoulProvider(pi: ExtensionAPI): void {
  const root = process.env.OMP_NATIVE_GATEWAY_ROOT;
  const role = process.env.OMP_SUPERAGENT_ROLE;
  assert(root && process.env.OMP_NATIVE_GATEWAY_PRESETS === "soul" && (role === "head" || role === "lane"),
    "SOUL provider requires an isolated managed fixture");

  if (role === "lane") {
    pi.registerTool({
      name: barrierTool, label: "Wait for the isolated native steer", approval: "read", loadMode: "essential",
      description: "Hold this local native tool open until the fixture observes the queued bound owner follow-up.",
      parameters: Type.Object({}),
      async execute(_id, _input, signal) {
        assert(signal, "The native steer gate requires the tool's cancellation signal");
        const release = join(root, soulSteerRelease);
        const gate = Promise.withResolvers<void>();
        const check = () => { if (existsSync(release)) gate.resolve(); };
        const abort = () => gate.reject(signal.reason);
        const watcher = watch(root, check);
        signal.addEventListener("abort", abort, { once: true });
        try {
          await writeFile(join(root, soulSteerEntered), String(process.pid), { mode: 0o600, flag: "wx" });
          check();
          if (signal.aborted) abort();
          await gate.promise;
          return { content: [{ type: "text", text: "The local native steer gate was released." }], details: {} };
        } finally {
          signal.removeEventListener("abort", abort);
          watcher.close();
        }
      },
    });
  }

  let isChild = false;
  pi.on("context", (_event, ctx) => { isChild = ctx.agent.kind === "sub"; });

  const local = createMockModel({ ...model, contextWindow: 65_536, maxTokens: 4096, handler: async context => {
    const index = context.messages.findLastIndex(message => message.role === "user");
    const user = context.messages[index];
    assert(user?.role === "user", "The local provider needs a native user turn");
    const text = soulText(user.content);
    if (context.messages.length === 1 && text.startsWith("Compress into one routing hint of at most 12 words:")) {
      const description = /\nSkill: [^\n]+\nDescription: ([\s\S]+)$/.exec(text)?.[1];
      assert(description, "Expected only the native auxiliary skill-description request");
      return { content: [description.trim().split(/\s+/).slice(0, 12).join(" ").slice(0, 160)] };
    }
    const envelope = nativeRequestEnvelope(text);
    const child = isChild && text.includes(soulChildTask);
    assert(child || envelope, "Unexpected model turn without an original request identity");
    const requestId = child ? `child:${soulCases.child.id}` : envelope?.requestId;
    assert(requestId);

    const system = (context.systemPrompt ?? []).join("\n");
    const voice = [...system.matchAll(/<superagent-reply-voice>([\s\S]*?)<\/superagent-reply-voice>/g)];
    const mode = /^Delivery mode: (topic reply|manager handoff)\.$/m.exec(envelope?.envelope ?? "")?.[1];
    const turn = nativeToolTurn(pi, context, nativeToolExchanges(context.messages.slice(index + 1)));
    const ownerChange = [soulCases.editorUpdate, soulCases.mentorUpdate, soulCases.oneOff, soulCases.negated]
      .find(source => source.id === requestId);
    if (ownerChange) {
      assert(role === "head" && envelope?.sourceId === ownerChange.id && text.split("\n").includes(ownerChange.text),
        "The stock provider must see the unchanged ordinary author text on its original HEAD request");
      assert(turn.advertised.has("soul_update"), "The stock provider must receive the structured update tool");
    }
    const witness: SoulProviderWitness = {
      role: child ? "child" : role, requestId, pid: process.pid,
      voice: voice.map(match => soulDigest(match[0])),
      voiceLines: voice.flatMap(match => (match[1] ?? "").split("\n").map(line => line.trim()).filter(Boolean).map(soulDigest)),
      voiceTags: [system.split(soulVoiceOpen).length - 1, system.split(soulVoiceClose).length - 1],
      headContract: /^name:\s*superagent-head\s*$/m.test(system),
      managerTools: managerTools.filter(name => turn.advertised.has(name) || !child && turn.enabled.has(name)),
      policyCount: system.split("<omp-ulw-policy>").length - 1,
      mode: mode === "topic reply" || mode === "manager handoff" ? mode : null,
      steering: envelope?.envelope.includes("authorized same-conversation followup to the active request") ?? false,
    };
    // Record only structural observations and digests, not whole model payloads.
    await appendFile(join(root, soulWitnessFile), `${JSON.stringify(witness)}\n`, { mode: 0o600 });
    if (child) {
      const released = Promise.withResolvers<void>();
      const path = join(root, soulChildRelease);
      const watcher = watch(root, () => { if (existsSync(path)) released.resolve(); });
      try {
        if (!existsSync(path)) await released.promise;
      } finally { watcher.close(); }
      return { content: [soulChildAnswer] };
    }
    const invoke = (name: string, args: Record<string, unknown>) =>
      turn.invoke(name, args, `soul-proof:${requestId}:${name}:${context.messages.length}`);
    if (role === "head" && (requestId === soulCases.oneOff.id || requestId === soulCases.negated.id)) {
      const attempted = turn.dispatches.find(call => call.name === "soul_update" && call.mode === "execute");
      if (attempted) {
        assert.deepEqual(turn.failed, [attempted], "The actual ineligible soul_update execution must be refused");
        return { content: [`HEAD:${requestId}:refused`] };
      }
    }
    assert.deepEqual(turn.failed.map(call => ({ name: call.name, text: soulText(call.result.content) })), [],
      `Actual native tool call failed in ${role}/${requestId}`);

    if (role === "lane") {
      const sourceId = envelope?.sourceId;
      if (sourceId === soulCases.manager.id) {
        assert(!turn.succeeded(barrierTool), "The manager run continued without receiving its queued bound steer");
        return invoke(barrierTool, {});
      }
      if (sourceId === soulCases.steer.id) return { content: [soulSteeredResult] };
      if (sourceId === soulCases.opening.id) return { content: [soulLaneResult] };
      assert(sourceId === soulCases.oldLane.id || sourceId === soulCases.editorLane.id || sourceId === soulCases.mentorLane.id,
        `Unexpected lane request ${requestId}`);
      return { content: [`LANE:${sourceId}`] };
    }

    switch (requestId) {
      case soulCases.opening.id:
        if (!turn.succeeded("lane_start")) return invoke("lane_start", {
          sourceId: requestId, title: "Native SOUL fixture", kickoff: soulKickoff, cwd: join(root, "topic"),
          model, modelReason: "Use the only available offline integration model.",
        });
        return { content: [`HEAD:${requestId}:delegated`] };
      case soulCases.oneOff.id:
      case soulCases.negated.id:
      case soulCases.editorUpdate.id:
      case soulCases.mentorUpdate.id:
        if (!turn.succeeded("soul_update")) return invoke("soul_update", { sourceId: requestId });
        return { content: [`HEAD:${requestId}`] };
      case soulCases.manager.id:
        if (!turn.succeeded("lane_message")) {
          const binding = /Bound lane reference \(coordination state, not a transcript\): (\{[^\n]+\})/.exec(text)?.[1];
          assert(binding, "The manager model must see the original bound lane");
          const lane: unknown = JSON.parse(binding);
          assert(lane && typeof lane === "object" && "id" in lane && typeof lane.id === "string");
          return invoke("lane_message", { id: lane.id, sourceId: requestId, text: "Check the local topic in the existing manager run." });
        }
        return { content: [`HEAD:${requestId}:delegated`] };
      case soulCases.child.id: {
        const task = turn.executions.find(call => call.name === "task");
        if (!task) return invoke("task", { agent: "task", task: soulChildTask, solutionSpace: "A read-only inspection." });
        if (!JSON.stringify(context.messages.slice(index + 1)).includes(soulChildAnswer))
          return { content: ["Waiting for the native child."] };
        return { content: [`HEAD:${requestId}`] };
      }
    }
    if (requestId.startsWith("report:")) {
      if (requestId === `report:handoff:${soulCases.opening.id}:lane`) {
        assert(text.includes(soulLaneResult));
        return { content: [`HEAD:${soulCases.opening.id}:report`] };
      }
      assert(requestId.startsWith(`report:handoff:${soulCases.manager.id}:`) && text.includes(soulSteeredResult),
        "The single HEAD report must actually consume the steered native lane result");
      return { content: [`HEAD:${soulCases.manager.id}:report`] };
    }
    assert(requestId === soulCases.oldHead.id || requestId === soulCases.editorHead.id || requestId === soulCases.mentorHead.id
      || requestId === soulCases.super.id, `Unexpected HEAD request ${requestId}`);
    return { content: [`HEAD:${requestId}`] };
  } });

  pi.registerProvider(model.provider, {
    baseUrl: "mock://native-soul", api: model.provider, apiKey: "offline-soul-fixture",
    streamSimple: (identity, context, options) => local.stream(identity, context, options),
    models: [{ id: model.id, name: local.name, kind: "chat", reasoning: local.reasoning, input: local.input,
      cost: local.cost, contextWindow: local.contextWindow, maxTokens: local.maxTokens }],
  });
}
