/** Script only inference; every action is a production native tool call. */
import assert from "node:assert/strict";
import { existsSync, watch } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { nativeRequestEnvelope } from "./native-request-envelope";
import { nativeToolExchanges, nativeToolTurn } from "./native-tool-transport";

const provider = "gateway-native";
const model = "local";
const managers = ["messenger_presence", "lane_watch", "pr_watch", "pr_watch_list"];
const childTask = "Check which observation tools are available to this native child.";
const childAnswer = "Native child has no observation manager authority.";
const laneResult = "The offline lane recorded verified local evidence.";

function toolText(content: readonly { readonly type: string; readonly text?: string }[]): string {
  return content.flatMap(part => part.type === "text" && part.text !== undefined ? [part.text] : []).join("\n");
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Object.entries(value).find(([name]) => name === key)?.[1] : undefined;
}

async function released(path: string, signal: AbortSignal): Promise<void> {
  if (existsSync(path)) return;
  const ready = Promise.withResolvers<void>();
  const watcher = watch(dirname(path), { signal }, () => {
    if (existsSync(path)) ready.resolve();
  });
  const cancel = () => ready.reject(signal.reason);
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (signal.aborted) cancel();
    if (existsSync(path)) ready.resolve();
    await ready.promise;
  } finally {
    signal.removeEventListener("abort", cancel);
    watcher.close();
  }
}

export default function chatObservationModel(pi: ExtensionAPI): void {
  const root = process.env.OMP_NATIVE_GATEWAY_ROOT;
  assert(root && existsSync(join(root, ".native-chat-observation")), "Chat observation provider requires its isolated scenario");
  const role = process.env.OMP_SUPERAGENT_ROLE;
  const childScopeReceipt = join(root, "checked-native-child-scope");
  pi.on("before_agent_start", async (event, ctx) => {
    if (!event.prompt.includes(childTask) || ctx.agent.kind !== "sub") return;
    const active = pi.getActiveTools();
    assert.deepEqual(managers.filter(name => active.includes(name)), [], "Managed observation tools entered the native child active set");
    await writeFile(childScopeReceipt, ctx.sessionManager.getSessionId(), { mode: 0o600, flag: "wx" });
  });
  const offline = createMockModel({ provider, id: model, contextWindow: 65_536, maxTokens: 4096, handler: async (context, options) => {
    const index = context.messages.findLastIndex(message => message.role === "user");
    const user = context.messages[index];
    assert(user?.role === "user", "Offline model requires native user input");
    const text = typeof user.content === "string" ? user.content : toolText(user.content);
    const envelope = nativeRequestEnvelope(text);
    const turn = nativeToolTurn(pi, context, nativeToolExchanges(context.messages.slice(index + 1)));
    if (!envelope?.requestId.startsWith("pr-observation:"))
      assert.deepEqual(turn.failed, [], "An actual native tool invocation failed");
    const answer = (value: string) => ({ content: [value] });
    if (!envelope && text.includes(childTask)) {
      assert(existsSync(childScopeReceipt), "Expected a real native child before_agent_start event");
      assert.deepEqual(managers.filter(name => turn.advertised.has(name)), [], "Native child model received observation manager tools");
      return answer(childAnswer);
    }
    assert(envelope, "Expected the production source-bound native envelope");
    const { requestId, sourceId } = envelope;
    const invoke = (name: string, args: Record<string, unknown>) =>
      turn.invoke(name, args, `observation-proof:${requestId}:${name}:${context.messages.length}`);
    const result = (name: string) => turn.executions.find(call => call.name === name)?.result;
    const read = (name: string): unknown => {
      const receipt = result(name);
      assert(receipt, `Missing production ${name} result`);
      return JSON.parse(toolText(receipt.content));
    };

    if (role === "lane") {
      assert.match(requestId, /^handoff:/);
      const active = pi.getActiveTools();
      assert.deepEqual(managers.filter(name => active.includes(name) || turn.advertised.has(name)), []);
      const evidence = join(root, "topic", "lane-progress");
      if (!result("lane_report")) {
        await writeFile(join(root, "entered-chat-lane"), "", { mode: 0o600 });
        await released(evidence, options?.signal ?? AbortSignal.timeout(60_000));
        return invoke("lane_report", { status: "progress", summary: "The native lane recorded local evidence.",
          evidence: [{ kind: "file", path: evidence }] });
      }
      await released(join(root, "finish-chat-lane"), options?.signal ?? AbortSignal.timeout(60_000));
      return answer(laneResult);
    }
    assert.equal(role, "head");

    if (requestId.startsWith("report:")) {
      assert(text.includes(laneResult), "The native lane report lacks its actual result");
      return answer(laneResult);
    }
    if (requestId.startsWith("progress:")) return { content: [] }; // Separate, pre-existing lane progress channel.
    if (requestId.startsWith("pr-observation:")) {
      const failure = /^PR_CI_FAIL (.+)$/m.exec(text)?.[1];
      assert(failure, "Expected a real GitHub CI observation, not a baseline reply");
      const check: unknown = JSON.parse(failure);
      assert.equal(field(check, "conclusion"), "failure");
      if (!turn.dispatches.length) {
        const priorSourceId = /registered sourceId: ([^;\n]+);/.exec(text)?.[1];
        assert(priorSourceId && priorSourceId !== requestId, "Expected a reusable-looking historical owner ID");
        const args = { sourceId: priorSourceId, title: "Untrusted PR observation work",
          cwd: join(root, "topic"), kickoff: "Do not execute this proof attempt.",
          model: { provider, id: model }, modelReason: "Offline fixture model." };
        const id = `observation-authority-proof:${requestId}`;
        // Attempt the actual execution path, even on a mounted tool transport.
        switch (turn.presentation("lane_start")) {
          case "direct": return invoke("lane_start", args);
          case "command": return { content: [{ type: "toolCall", id, name: "bash",
            arguments: { command: `lane_start --json '${JSON.stringify(args).replaceAll("'", "'\\''")}'` } }] };
          case "device": return { content: [{ type: "toolCall", id, name: "write",
            arguments: { path: "xd://lane_start", content: JSON.stringify(args) } }] };
        }
      }
      assert.equal(turn.executions.length, 0, "The PR notice must not be allowed to start work");
      assert.equal(turn.failed.length, 1);
      const [blocked] = turn.failed;
      assert(blocked);
      assert.match(toolText(blocked.result.content), /PR observation turns cannot use tools/);
      return answer(`PR CI failed: ${field(check, "name")}.`);
    }

    assert.equal(requestId, sourceId, "Manager actions must use the original owner source");
    if (text.includes("디스코드 봇")) {
      const action = text.includes("온라인으로") ? "start" : text.includes("오프라인으로") ? "stop" : "status";
      if (!result("messenger_presence")) return invoke("messenger_presence", { sourceId, action, ...(action === "start" ? { platform: "discord" } : {}) });
      const state = read("messenger_presence");
      assert.equal(field(state, "platform"), "discord");
      assert.equal(field(state, "lastSent"), null, "The offline adapter has no Discord connection");
      return answer(`디스코드 봇의 설정: ${field(state, "desired")} (${field(state, "connection")}).`);
    }
    const ref = /\bfixture-owner\/fixture-repo#7\b/.exec(text)?.[0];
    if (ref) {
      const action = text.includes("Stop watching") ? "untrack" : text.includes("Watch") ? "track" : "status";
      if (action === "status") {
        if (!result("pr_watch_list")) return invoke("pr_watch_list", { sourceId, ref });
        const listed = read("pr_watch_list");
        assert(Array.isArray(listed));
        if (!listed.length) return answer(`No active PR watch for ${ref}.`);
        const [watch] = listed;
        assert.equal(listed.length, 1);
        return answer(`${field(watch, "ref")} baseline CI: ${field(field(watch, "baseline"), "ci")}; latest CI: ${field(field(watch, "latest"), "ci")}.`);
      }
      if (!result("pr_watch")) return invoke("pr_watch", { sourceId, action, ref, ...(action === "track" ? { intervalSeconds: 1 } : {}) });
      const state = read("pr_watch");
      if (action === "untrack") {
        assert.equal(state, null);
        return answer(`Stopped PR observation for ${ref}.`);
      }
      assert.equal(field(state, "sourceId"), sourceId);
      assert.equal(field(state, "baseline"), null);
      return answer(`Watching ${ref} every ${field(state, "intervalSeconds")}s; the baseline is pending.`);
    }
    if (text.includes("Start a separate lane")) {
      if (!result("lane_start")) return invoke("lane_start", { sourceId, title: "Observation proof",
        cwd: join(root, "topic"), kickoff: "I will record local evidence in this work thread.",
        model: { provider, id: model }, modelReason: "Single available offline model." });
      const lane = read("lane_start");
      return answer(`Opened independent work ${field(lane, "id")}.`);
    }
    const laneId = /\blane-[a-zA-Z0-9_-]+\b/.exec(text)?.[0];
    if (laneId) {
      if (text.includes("Mark") && text.includes("complete")) {
        if (!result("lane_close")) return invoke("lane_close", { id: laneId, outcome: "completed", evidence: laneResult });
        return answer(`Lane ${laneId} recorded as ${field(read("lane_close"), "workState")}.`);
      }
      const action = text.includes("Stop notifying") ? "untrack" : text.includes("Notify me") ? "track" : "status";
      if (!result("lane_watch")) return invoke("lane_watch", { sourceId, action, laneId });
      const state = read("lane_watch");
      return answer(`Lane ${field(state, "laneId")}: tracking=${field(state, "tracking")}, work=${field(state, "workState")}.`);
    }
    if (text.includes("Use a native child to check")) {
      const task = result("task");
      if (!task) return invoke("task", { agent: "task", task: childTask,
        solutionSpace: "A single read-only capability inspection." });
      assert(toolText(task.content).includes(childAnswer), "Native child did not complete the authority probe");
      return answer(childAnswer);
    }
    throw new Error(`Unexpected input to observation script (${requestId})`);
  } });
  pi.registerProvider(provider, {
    baseUrl: `mock://${provider}`, api: provider, apiKey: "offline-chat-observation",
    streamSimple: (identity, context, options) => offline.stream(identity, context, options),
    models: [{ id: offline.id, name: offline.name, reasoning: offline.reasoning, input: offline.input,
      cost: offline.cost, contextWindow: offline.contextWindow, maxTokens: offline.maxTokens }],
  });
}
