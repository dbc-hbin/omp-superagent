/** Local model transport and one explicit private-socket fault; native goals and UI remain authoritative. */
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { appendFileSync, existsSync, readFileSync, watch } from "node:fs";
import { Socket } from "node:net";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { HostConnection } from "../../src/host";
import superagentExtension from "../../src/extension";
import { nativeRequestEnvelope } from "./native-request-envelope";
import { nativeToolExchanges, nativeToolTurn } from "./native-tool-transport";

export default function restartNativeProvider(pi: ExtensionAPI): void {
  const root = process.env.OMP_RESTART_NATIVE_ROOT;
  assert(root && process.env.HOME === join(root, "home"), "Native restart requires an isolated HOME");
  const role = process.env.OMP_SUPERAGENT_ROLE;
  assert(role === "head" || role === "lane");
  assert.equal(process.env.OMP_RESTART_NATIVE_DUMMY_TOKEN, undefined, "Gateway credentials must not reach native HEAD");
  const scenario = process.env.OMP_RESTART_NATIVE_SCENARIO;
  const recoveryWindow = scenario === "lane-failure-recovery-window" || scenario === "lane-abort-recovery-window";
  let current: ExtensionContext | undefined;
  let recordedResume = false;
  const record = (kind: string, fields: Record<string, unknown> = {}) => {
    appendFileSync(join(root, "native-events.jsonl"), `${JSON.stringify({ kind, at: Date.now(), pid: process.pid, ...fields })}\n`, { mode: 0o600 });
  };
  if (role === "head" && process.env.OMP_RESTART_NATIVE_SCENARIO === "quarantine") {
    // Lose one actual UI response at the local socket boundary, not its native
    // pending-request state or the controller's pre-effect answered marker.
    const write = Socket.prototype.write;
    let dropped = false;
    Socket.prototype.write = function (this: Socket, chunk: string | Uint8Array,
      encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void): boolean {
      const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      if (text.includes('"extension_ui_response"')) {
        const frame: { type?: string; id?: string; confirmed?: boolean; cancelled?: boolean } = JSON.parse(text);
        record("native-ui-wire-attempt", { frame, bytes: text });
        if (!dropped && frame.type === "extension_ui_response" && typeof frame.id === "string" && frame.confirmed === true && !frame.cancelled) {
          const db = new Database(join(root, "coordination.sqlite"), { readonly: true, strict: true });
          try {
            const row = db.query<{ data: string }, [string]>(
              "SELECT data FROM approvals WHERE request_id=? AND target='main' AND state='answered'",
            ).get(frame.id);
            assert(row, "Only the real controller's pre-effect answered attempt can lose its wire response");
            const approval: { request: { title?: string }; route: { channelId: string; threadId?: string } } = JSON.parse(row.data);
            assert.equal(approval.request.title, "Isolated native restart question");
            assert.equal(approval.route.channelId, "4");
            assert.equal(approval.route.threadId, "10");
            dropped = true;
            record("native-ui-wire-drop", { frame, bytes: text, approval });
          } finally { db.close(); }
          const finished = typeof encoding === "function" ? encoding : callback;
          queueMicrotask(() => finished?.());
          return true;
        }
      }
      const forward = write.bind(this);
      return typeof encoding === "string" ? forward(chunk, encoding, callback) : forward(chunk, encoding);
    };
  }
  const waitForFile = async (name: string, signal: AbortSignal): Promise<void> => {
    const gate = join(root, name);
    const cleanup = join(root, "cleanup");
    // Cross-process file gates must not depend on delivery of a watch event.
    for (;;) {
      signal.throwIfAborted();
      if (existsSync(gate) || existsSync(cleanup)) return;
      await Bun.sleep(25);
    }
  };
  if (role === "head" && recoveryWindow) {
    // Correlate actual controller reads and delivered native events. Observer
    // readback runs in the orchestrator, outside this private module instance.
    const request = HostConnection.prototype.request;
    let sequence = 0;
    let held = false;
    HostConnection.prototype.request = async function (command, id) {
      if (command.type !== "get_entries") return request.call(this, command, id);
      const requestId = id ?? `restart-recovery-head:${process.pid}:${++sequence}`;
      record("head-recovery-entries-request", { requestId });
      const unsubscribe = this.onFrame(frame => {
        if (frame.type === "message_end" || frame.type === "agent_end" || frame.type === "session_settled")
          record("head-recovery-native-event", { requestId, nativeFrame: frame });
      });
      try {
        const response = await request.call(this, command, requestId);
        if (!held && response.success && response.command === "get_entries" && existsSync(join(root, "arm-lane-recovery-entries"))) {
          const producer = await this.client.getState();
          if (producer.sessionFile !== join(root, "sessions/main/session.jsonl")) {
            held = true;
            record("head-recovery-snapshot-held", { requestId, producerPid: producer.hostPid,
              response: structuredClone(response), bytes: `${JSON.stringify(response)}\n` });
            await waitForFile("release-lane-recovery-entries", new AbortController().signal);
            const currentProducer = await this.client.getState();
            record("head-recovery-snapshot-released", { requestId, producerPid: producer.hostPid,
              connected: currentProducer.hostPid === producer.hostPid && currentProducer.sessionId === producer.sessionId,
              bytes: `${JSON.stringify(response)}\n` });
          }
        }
        record("head-recovery-entries-received", { requestId, response });
        return response;
      } finally { unsubscribe(); }
    };
    pi.on("session_shutdown", () => { HostConnection.prototype.request = request; });
    superagentExtension(pi);
  }
  pi.on("session_start", (_event, ctx) => {
    current = ctx;
    record("native-start", { sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile() });
  });
  pi.on("before_agent_start", (_event, ctx) => { current = ctx; });
  pi.on("agent_end", event => { record("native-turn-ended", { messages: event.messages }); });
  pi.on("input", event => {
    const envelope = nativeRequestEnvelope(event.text);
    record("native-input", { requestId: envelope?.requestId, sourceId: envelope?.sourceId, text: event.text });
  });
  pi.on("session_shutdown", () => { record("native-shutdown"); });
  pi.registerTool({
    name: "fixture_restart_hold", label: "Hold isolated restart work",
    description: "Keep this native execution active until the owner's restart interrupts it.",
    approval: "read", loadMode: "essential", parameters: Type.Object({}),
    async execute(_id, _params, signal, _update, ctx) {
      assert(signal, "The real native executor must provide an AbortSignal");
      const stopped = Promise.withResolvers<void>();
      const abort = () => {
        const db = new Database(join(root, "coordination.sqlite"), { readonly: true, strict: true });
        try {
          const ack = db.query<{ state: string; remote_id: string | null }, []>(
            "SELECT state,remote_id FROM outputs WHERE id='902:restart-ack'",
          ).get();
          record("native-aborted", { ack });
        } finally { db.close(); }
        stopped.resolve();
      };
      signal.addEventListener("abort", abort, { once: true });
      const watcher = watch(root, () => { if (existsSync(join(root, "cleanup"))) stopped.resolve(); });
      try {
        record("held", { sessionId: ctx.sessionManager.getSessionId() });
        if (signal.aborted) abort();
        if (process.env.OMP_RESTART_NATIVE_SCENARIO === "approval" || process.env.OMP_RESTART_NATIVE_SCENARIO === "quarantine") {
          const confirmed = await ctx.ui.confirm("Isolated native restart question", "This original-route card must be cancelled, never approved.", { signal });
          record("question-result", { confirmed });
        }
        if (existsSync(join(root, "cleanup"))) stopped.resolve();
        await stopped.promise;
        return { content: [{ type: "text", text: "Owned native restart gate interrupted" }], details: {} };
      } finally { watcher.close(); signal.removeEventListener("abort", abort); }
    },
  });
  pi.registerTool({
    name: "fixture_restart_confirm", label: "Confirm resumed native goal",
    description: "Ask the owner on the restored goal's original route before completing it.",
    approval: "read", loadMode: "essential", parameters: Type.Object({}),
    async execute(_id, _params, signal, _update, ctx) {
      assert(signal);
      const confirmed = await ctx.ui.confirm("Resumed native goal", "Confirm completion on the goal's original route.", { signal });
      record("resumed-question-result", { confirmed, sessionId: ctx.sessionManager.getSessionId() });
      assert.equal(confirmed, true, "The replacement goal requires the actual original-route owner answer");
      return { content: [{ type: "text", text: "Original-route owner confirmed the resumed goal" }], details: {} };
    },
  });
  const local = createMockModel({ provider: "restart-native", id: "local", contextWindow: 131_072, maxTokens: 4096,
    handler: async (context, options) => {
      assert(current, "The actual native extension context must precede model dispatch");
      const users = context.messages.flatMap((message, index) => {
        if (message.role !== "user") return [];
        const text = typeof message.content === "string" ? message.content
          : message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
        const envelope = nativeRequestEnvelope(text);
        return envelope ? [{ ...envelope, index }] : [];
      });
      const user = users.at(-1);
      assert(user, "No startup or fabricated model turn is permitted");
      assert(!users.some(entry => entry.sourceId === "902"), "/restart must never become a model prompt");
      if (role === "lane") {
        const detached = scenario === "lane-failure" || scenario === "lane-abort" || recoveryWindow;
        if (detached) {
          const turn = nativeToolTurn(pi, context, nativeToolExchanges(context.messages));
          assert.deepEqual(turn.failed, [], "A production native lane tool failed");
          if (!turn.succeeded("goal", "create")) {
            return turn.invoke("goal", { op: "create",
              objective: "Yield the first lane turn successfully, then retain the actual detached continuation outcome." }, "restart-native:lane-goal");
          }
          // Native hidden goal continuation reaches the provider as a developer message.
          const continuing = context.messages.at(-1)?.role === "developer";
          if (continuing) {
            record("lane-detached-continuation", { sessionId: current.sessionManager.getSessionId(),
              sessionFile: current.sessionManager.getSessionFile(), lastMessage: context.messages.at(-1) });
            assert(options?.signal);
            if (scenario === "lane-abort" || scenario === "lane-abort-recovery-window") {
              const signal = options.signal;
              const interrupted = Promise.withResolvers<void>();
              const abort = () => { record("lane-native-aborted", { reason: String(signal.reason) }); interrupted.resolve(); };
              signal.addEventListener("abort", abort, { once: true });
              try {
                if (signal.aborted) abort();
                await interrupted.promise;
                assert.equal(signal.aborted, true);
                return { stopReason: "aborted", errorMessage: "Native lane continuation received its actual host AbortSignal" };
              } finally { signal.removeEventListener("abort", abort); }
            }
            await waitForFile("release-lane-outcome", options.signal);
            return { stopReason: "error", errorMessage: "Isolated native lane continuation failed after its first successful yield" };
          }
        }
        record("lane-held", { sessionId: current.sessionManager.getSessionId(), sessionFile: current.sessionManager.getSessionFile() });
        assert(options?.signal);
        await waitForFile("release-lane", options.signal);
        return { content: ["LANE_COMPLETED_WITHOUT_REPLAY"] };
      }
      if (user.sourceId.startsWith("report:")) return { content: ["LANE_REPORT_DELIVERED"] };
      if (user.sourceId === "903") return { content: ["QUEUED_DELIVERED_ONCE"] };
      assert(user.sourceId === "901" || user.sourceId === "904");
      const messages = context.messages.slice(user.index + 1);
      const exchanges = nativeToolExchanges(messages);
      const turn = nativeToolTurn(pi, context, exchanges);
      // Native abort may leave the intentional hold's error in the restored
      // conversation; no other failed or unpaired result is an expected effect.
      const heldErrors = new Set(turn.failed.filter(result => result.name === "fixture_restart_hold").map(result => result.result));
      assert.deepEqual(messages.filter(message => message.role === "toolResult" && message.isError && !heldErrors.has(message)),
        [], "A production native tool failed");
      assert.deepEqual(turn.failed.filter(result => result.name !== "fixture_restart_hold"), [], "A production native dispatch failed");
      const { succeeded } = turn;
      const invoke = (name: string, args: Record<string, unknown>): MockResponse =>
        turn.invoke(name, args, `restart-native:${process.pid}:${name}:${context.messages.length}`);
      if (user.sourceId === "904") {
        if (!succeeded("lane_start")) return invoke("lane_start", {
          sourceId: "904", title: "Surviving isolated work", cwd: join(root, "lane"),
          kickoff: "Run the independent local fixture while the head restarts.", model: { provider: "restart-native", id: "local" },
          modelReason: "The deterministic local provider is the only isolated fixture candidate.",
          destination: { platform: "discord", accountId: "2", authorityId: "1", guildId: "3", channelId: "5", threadId: "30" },
        });
        return { content: ["LANE_STARTED"] };
      }
      if (!succeeded("goal", "create")) {
        return invoke("goal", { op: "create", objective: "Preserve one completed file effect across owner restart, then finish the entrusted objective." });
      }
      if (!succeeded("bash")) return invoke("bash", { command: "printf 'completed-once\\n' >> completed-effect.log", timeout: 10 });
      const text = readFileSync(join(root, "native-events.jsonl"), "utf8");
      const history: { kind: string; pid: number }[] = text.slice(0, text.lastIndexOf("\n") + 1)
        .split("\n").filter(Boolean).map(line => JSON.parse(line));
      if (process.env.OMP_RESTART_NATIVE_SCENARIO === "settled-goal") {
        const initial = history.find(event => event.kind === "native-start");
        assert(initial);
        if (initial.pid === process.pid) {
          // The initial turn and its first native continuation return no tool
          // activity. RpcGoalController itself suppresses the next continuation.
          record("no-progress-response", { lastMessage: context.messages.at(-1), sessionId: current.sessionManager.getSessionId() });
          return { content: ["GOAL_YIELDED_WITHOUT_PROGRESS"] };
        }
      }
      const held = history.find(event => event.kind === "held");
      if (process.env.OMP_RESTART_NATIVE_SCENARIO !== "settled-goal") {
        if (!held) return invoke("fixture_restart_hold", {});
        assert.notEqual(process.pid, held.pid, "The original active turn may only continue in the replacement HEAD");
      }
      if (succeeded("goal", "complete")) return { content: ["GOAL_COMPLETED_AFTER_NATIVE_RESTART"] };
      if (!recordedResume) {
        recordedResume = true;
        const mode = current.sessionManager.getBranch().findLast(entry => entry.type === "mode_change");
        assert(mode?.type === "mode_change" && mode.mode === "goal", "Only actual RPC goal resume may reactivate the paused goal");
        record("resumed", { sessionId: current.sessionManager.getSessionId(), mode: mode.mode, goal: mode.data?.goal });
      }
      assert(options?.signal, "The local provider continuation gate must remain abortable");
      await waitForFile("release-resume", options.signal);
      if (process.env.OMP_RESTART_NATIVE_SCENARIO === "settled-goal" && !succeeded("fixture_restart_confirm"))
        return invoke("fixture_restart_confirm", {});
      return invoke("goal", { op: "complete" });
    },
  });
  pi.registerProvider("restart-native", {
    baseUrl: "mock://restart-native", api: "restart-native", apiKey: "isolated-local-only",
    streamSimple: (model, context, options) => local.stream(model, context, options),
    models: [{ id: "local", name: "Isolated deterministic native restart model", kind: "chat", reasoning: true, input: ["text"],
      contextWindow: local.contextWindow, maxTokens: local.maxTokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  });
}
