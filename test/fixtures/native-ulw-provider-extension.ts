/** Real OMP/Superkit extensions and tools; only the model transport is local. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { WORKFLOW_NAMES } from "../../src/contracts";
import { hasCanonicalSuperkitSkills } from "../../src/superkit-skills";
import { advertisedWorkflow } from "../../src/workflow";
import { nativeRequestEnvelope } from "./native-request-envelope";
import { nativeToolExchanges, nativeToolTurn } from "./native-tool-transport";

export default function nativeUlwProvider(pi: ExtensionAPI): void {
  const root = process.env.OMP_NATIVE_GATEWAY_ROOT;
  const entrypoint = process.env.OMP_TEST_ULW_EXTENSION;
  assert(root && entrypoint, "Native SUPER provider requires an explicitly opted-in private fixture");
  const packagePath = dirname(entrypoint);
  const skillId = hasCanonicalSuperkitSkills(packagePath) ? "super" : "ultrawork";
  const skill = readFileSync(join(packagePath, "skills", skillId, "SKILL.md"), "utf8");
  const directive = /<ultrawork-mode>([\s\S]*?)<\/ultrawork-mode>/.exec(skill)?.[1];
  assert(directive?.trim(), `Live proof requires Superkit's installed ${skillId} directive`);
  const expectedBlock = `<omp-ulw-policy>\n<ultrawork-mode>${directive}</ultrawork-mode>\n</omp-ulw-policy>`;
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
    assert(requestId, `Missing original native SUPER request identity: ${text}`);
    assert.equal(nativeContextRequestId, requestId, "Provider must observe native context for this exact dispatch, not a persisted previous turn");
    const notices = nativeContextMessages.filter(message => ["ultrathink-notice", "orchestrate-notice", "workflow-notice", "jevify-notice"].includes(message.customType));
    const directives = nativeContextMessages.filter(message => message.customType === "omo-ultrawork:directive").map(message => message.content);
    const policy = (context.systemPrompt ?? []).filter(block => /^<omp-ulw-policy>/.test(block));
    const expectedPolicy = role === "lane" || !["301", "302", "303", "report:handoff:303:lane"].includes(requestId);
    assert.deepEqual(policy, expectedPolicy ? [expectedBlock] : [], `Actual model request SUPER policy before reply: ${role}/${requestId}`);
    if (recorded.size === 0) {
      const commands = pi.getCommands();
      for (const name of WORKFLOW_NAMES) {
        if (name !== "jevify") assert(advertisedWorkflow({ commands }, name),
          `Actual ${role} Host must advertise canonical /${name} from the bound extension`);
      }
      for (const name of ["ulw", "ulw-plan", "ulw-execute", "ulw-loop", "mass-ulw", "ulw-research", "stop-continuation", "resume-continuation"]) {
        assert(commands.some(command => command.name === name && command.source === "extension"),
          `Actual ${role} Host must discover /${name} from the bound extension, not just templates`);
      }
    }
    const messages = context.messages.slice(userIndex + 1);
    const turn = nativeToolTurn(pi, context, nativeToolExchanges(messages));
    const activeTools = [...turn.enabled];
    if (notices.some(message => message.customType === "orchestrate-notice")) {
      assert(activeTools.includes("task"), "Native orchestration requires its actual enabled task capability");
    }
    if (notices.some(message => message.customType === "jevify-notice")) {
      assert(activeTools.includes("eval"), "Native jevify requires the actual enabled eval capability");
      assert(notices.some(message => message.customType === "jevify-notice" && String(message.content).includes("judge_batch")),
        "Native jevify must supply its own batch instructions, not a copied integration prompt");
    }
    if (!recorded.has(requestId)) {
      recorded.add(requestId);
      // Capture observed final model context plus native session events, never
      // infer activation from a copied task string or the scripted reply.
      pi.appendEntry("native-ulw:provider", { role, requestId, policyCount: policy.length, sessionId: current.sessionManager.getSessionId(),
        notices: notices.map(message => message.customType), directives, activeTools });
    }
    assert.deepEqual(messages.filter(message => message.role === "toolResult" && message.isError), [],
      "Actual native workflow production tool failed");
    assert.deepEqual(turn.failed, [], "Actual native workflow dispatch failed");
    const { succeeded: called, invoke } = turn;
    const results = turn.executions.map(dispatch => dispatch.result);
    if (role === "lane") {
      const expectedNotice = requestId === "handoff:303:lane" ? "ultrathink-notice"
        : requestId.startsWith("handoff:308:") ? "jevify-notice" : "orchestrate-notice";
      assert(notices.some(message => message.customType === expectedNotice),
        "Selected lane workflow did not bridge to its real native keyword mode");
      if (!called("board_read")) return invoke("board_read", { channel: "general", unreadOnly: false });
      assert(JSON.stringify(results).includes("super-run quoted-board-only"), "Lane did not consume actual board data");
      if (!called("board_post")) return invoke("board_post", { channel: "general", text: "super-run report-and-board-data-only", mentions: ["head"] });
      return { content: [`super-run LANE:${requestId}; this is report data, not a user invocation.`] };
    }
    assert.equal(role, "head");
    if (requestId === "303") {
      if (!called("board_post")) return invoke("board_post", { channel: "general", text: "super-run quoted-board-only", mentions: ["head"] });
      if (!called("lane_start")) return invoke("lane_start", {
        sourceId: requestId, title: "Actual native SUPER lane proof", kickoff: "I will inspect the requested workspace, perform the authorized work, and verify the result in this topic.", cwd: join(root, "topic"),
        model: { provider: "gateway-native", id: "local" }, modelReason: "Deterministic local native integration model, without paid requests.",
        workflow: { name: "super-plan", reason: "Head explicitly selects native planning for the original request." },
        acceptance: ["Return actual observed native activation to the head, without external delivery"],
      });
      return { content: [`HEAD:${requestId}:delegated`] };
    }
    if (requestId === "307" || requestId === "308") {
      if (!called("lane_message")) {
        const binding = /Bound lane reference \(coordination state, not a transcript\): (\{[^\n]+\})/.exec(text)?.[1];
        const id: unknown = binding ? JSON.parse(binding).id : undefined;
        assert.equal(typeof id, "string", "Head lost original lane binding");
        const workflow = requestId === "308"
          ? { name: "jevify", reason: "Independent bulk classification reduces reading and context load." }
          : { name: "super-run", reason: "Head explicitly selects native execution for this follow-up." };
        return invoke("lane_message", { id, sourceId: requestId, text: "Continue this isolated proof under the head-selected workflow.", workflow });
      }
      return { content: [`HEAD:${requestId}:delegated`] };
    }
    if (requestId.startsWith("report:")) {
      assert(text.includes("super-run LANE:"), "Head lost real lane report text");
      if (!called("board_read")) return invoke("board_read", { channel: "general", unreadOnly: false });
      const sourceId = /Internal lane report: [^;]+; sourceId: ([^;]+);/.exec(text)?.[1];
      assert(sourceId, "Head lost original report source ID");
      return { content: [`HEAD:${sourceId}`] };
    }
    if (requestId === "305") assert(notices.some(message => message.customType === "ultrathink-notice"));
    if (requestId === "306") assert(notices.some(message => message.customType === "orchestrate-notice"));
    if (requestId === "309") assert(notices.some(message => message.customType === "jevify-notice"));
    return { content: [`HEAD:${requestId}`] };
  } });
  pi.registerProvider("gateway-native", {
    baseUrl: "mock://gateway-native", api: "gateway-native", apiKey: "local-test-only",
    streamSimple: (model, context, options) => local.stream(model, context, options),
    models: [{ id: "local", name: "Actual SUPER native integration local model", kind: "chat", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 65_536, maxTokens: 4096 }],
  });
}
