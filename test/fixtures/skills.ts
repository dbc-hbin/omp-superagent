import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { toolWireSchema, validateToolArguments } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgSkills } from "@oh-my-pi/pi-coding-agent/extensibility/settings";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { buildHostArgs } from "../../src/host";
import { nativeDisabledProviders } from "./native-extension";
import { decisionId } from "../../src/decisions";
import type { ExtensionAskDialogQuestion, ExtensionAskDialogResult, ExtensionUIDialogOptions } from "@oh-my-pi/pi-coding-agent";

// A fresh process keeps OMP's native discovery caches, active profile, and URL
// snapshot isolated, just as production's independent head/lane hosts are.
const [root, role, kind, selection, ulwPath, extensionOrder] = process.argv.slice(2);
assert(root && (role === "head" || role === "lane") && (kind === "main" || kind === "sub"));
assert(!ulwPath || (path.isAbsolute(ulwPath) && (extensionOrder === "ulw-first" || extensionOrder === "superagent-first")));
const workspace = path.join(root, "foreign-workspace");
const agentDir = process.env.PI_CODING_AGENT_DIR!;
const packageRoot = path.resolve(import.meta.dir, "../..");
const extensionPath = path.join(packageRoot, role === "head" ? "src/extension.ts" : "src/lane-extension.ts");
const customDirectory = path.join(root, "operator-custom-skills");
const shadowHead = role === "head" && kind === "main" && selection === "narrow";
const shadowDirectory = path.join(workspace, ".omp/skills/superagent-head");
const managerNames = ["head_recovery", "head_set_model", "cron_create", "lane_models", "lane_init_presets", "lane_set_model", "lane_start", "lane_inspect", "lane_message", "lane_pause", "lane_resume", "lane_review_decision", "lane_close", "thread_inspect", "lane_thread_update",
  "discord_context", "discord_purpose_list", "discord_purpose_set", "discord_purpose_clear", "pr_watch", "pr_watch_list",
  "decision_list", "decision_inspect", "decision_withdraw"];
const skillSettings = {
  customDirectories: [customDirectory],
  ignoredSkills: ["ignored-*"],
  manualSkills: ["manual-*"],
  enableClaudeProject: false,
};

async function skill(directory: string, name: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: Local native discovery fixture.\n---\n# ${name}\n`);
}

await Promise.all([
  skill(path.join(workspace, ".omp/skills/project-existing"), "project-existing"),
  skill(path.join(agentDir, "skills/user-existing"), "user-existing"),
  skill(path.join(agentDir, "skills/ignored-local"), "ignored-local"),
  skill(path.join(customDirectory, "custom-existing"), "custom-existing"),
]);
if (shadowHead) {
  await skill(shadowDirectory, "superagent-head");
  await fs.mkdir(path.join(shadowDirectory, "references"));
  await fs.writeFile(path.join(shadowDirectory, "references/routing.md"), "# Project-local routing\n");
}
await fs.writeFile(path.join(agentDir, "config.yml"), JSON.stringify({
  disabledProviders: nativeDisabledProviders,
  skills: skillSettings,
  task: { maxConcurrency: 1 },
}));
process.env.OMP_SUPERAGENT_ROLE = role;
process.env.OMP_SUPERAGENT_LANE = "native-proof-lane";
// An SDK inspection session is deliberately not an authorized messenger host.
// Root startup must reject it; inherited task sessions must not even try.
delete process.env.OMP_SUPERAGENT_CONFIG;
delete process.env.OMP_SUPERAGENT_HOST_SOCKET;
let networkAttempts = 0;
const refuseNetwork = () => { networkAttempts++; throw new Error("Native skills fixture forbids network access"); };
globalThis.fetch = Object.assign(async () => refuseNetwork(), { preconnect: refuseNetwork });

const hostArgs = buildHostArgs({
  command: [process.execPath], socketPath: path.join(root, "proof.sock"),
  sessionFile: path.join(root, "session.jsonl"), cwd: workspace, extensionPath,
  env: {}, logPath: path.join(root, "host.log"), subagentConcurrency: 1,
  managedUlwPath: ulwPath ? path.dirname(ulwPath) : path.join(import.meta.dir, "managed-ulw"),
});
const extensionPaths = hostArgs.flatMap((arg, index) => arg === "-e" ? [hostArgs[index + 1]!] : []);
if (ulwPath) {
  const managedIndex = extensionPaths.indexOf(path.dirname(ulwPath));
  assert(managedIndex >= 0, "Managed ULW package must be explicitly loaded");
  const [managedPackage] = extensionPaths.splice(managedIndex, 1);
  if (extensionOrder === "ulw-first") extensionPaths.unshift(managedPackage!);
  else extensionPaths.push(managedPackage!);
}
// A supported, conflict-bearing profile over the actual native prompt. Nothing
// streams this model: the fixture only inspects native extension hook results.
const compositionModel = buildModel({
  provider: "xai", id: "grok-4.5", name: "Grok 4.5", api: "openai-responses",
  baseUrl: "https://native-composition.invalid/v1", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131_072, maxTokens: 8192,
});
type CompositionPayload = {
  model: string;
  stream: boolean;
  instructions: string;
  input: Array<{ role: "user"; content: string }>;
};
const childRole = "You are a read-only repository investigator. Do not edit files or acquire manager, board, or messenger authority.";
const childAssignment = "Assignment: inspect the requested implementation, do not run builds or tests, and return findings plus unrun checks to the parent only.";
const authStorage = await AuthStorage.create(":memory:");
const settings = await Settings.loadIsolated({ cwd: workspace, agentDir });
const sessionManager = SessionManager.inMemory(workspace);
const { session, extensionsResult } = await createAgentSession({
  cwd: workspace, agentDir, authStorage,
  modelRegistry: new ModelRegistry(authStorage, path.join(root, "models.yml"), { settings }),
  settings, sessionManager,
  ...(ulwPath ? { model: compositionModel } : {}),
  additionalExtensionPaths: [...extensionPaths,
    ...(role === "head" && kind === "main" && selection === "default"
      ? [path.join(packageRoot, "test/fixtures/pr-native-data.ts")] : [])],
  disableExtensionDiscovery: true,
  contextFiles: [], rules: [], promptTemplates: [], slashCommands: [],
  preloadedCustomToolPaths: [],
  enableMCP: false, enableLsp: false, skipPythonPreflight: true,
  toolNames: ["read", "bash", "task"],
  ...(kind === "sub" ? {
    // No parentId: kind, not the optional parent metadata, is authoritative.
    parentTaskPrefix: "NativeProofChild", agentId: "NativeProofChild", taskDepth: 0,
    // The public callback retains the fully rendered native base, then adds the
    // host-owned specialist/assignment blocks used by a delegated session.
    systemPrompt: (native: string[]) => [...native, childRole, childAssignment],
  } : {}),
});

try {
  assert.deepEqual(extensionsResult.errors, []);
  assert.equal(extensionsResult.extensions.filter(extension => extension.resolvedPath === extensionPath).length, 1);
  if (ulwPath) {
    const executableOrder = extensionsResult.extensions
      .filter(extension => extension.resolvedPath === ulwPath || extension.resolvedPath === extensionPath)
      .map(extension => extension.resolvedPath);
    assert.deepEqual(executableOrder, extensionOrder === "ulw-first" ? [ulwPath, extensionPath] : [extensionPath, ulwPath],
      "The actual native loader must preserve the requested ULW/role hook order");
  }
  const runner = session.extensionRunner!;
  assert.equal(runner.createContext().agent.kind, kind);
  assert.equal(runner.createContext().agent.parentId, undefined);

  if (selection === "narrow") {
    await session.setActiveToolsByName(session.getEnabledToolNames().filter(name =>
      name !== "bash" && name !== "lane_message" && name !== "lane_report" && name !== "decision_ask"));
  }
  const before = session.getEnabledToolNames();
  const errors: Array<{ event: string; error: string }> = [];
  await initializeExtensions(session, {
    reportRuntimeError: error => { errors.push(error); },
    reportSendError: (_action, error) => { throw error; },
  });
  if (role === "head" && kind === "main") {
    assert.equal(errors.length, 1);
    assert.match(errors[0]!.error, /Start this extension with omp-sa start/);
  } else {
    assert.deepEqual(errors, [], "Task/lane sessions must never attempt head startup");
  }
  const expectedActive = kind === "sub"
    ? before.filter(name => name !== "decision_ask" && (role === "head" ? !managerNames.includes(name) : name !== "lane_report")) : before;
  assert.deepEqual(session.getEnabledToolNames(), expectedActive);
  if (selection === "narrow") assert(!session.getEnabledToolNames().includes("bash"));

  const roleBody = await fs.readFile(path.join(packageRoot, `skills/${role}/SKILL.md`), "utf8");
  const headReferenceDirectory = path.join(packageRoot, "skills/head/references");
  const headReferences = await Promise.all(
    (await fs.readdir(headReferenceDirectory, { recursive: true })).filter(name => name.endsWith(".md"))
      .map(name => fs.readFile(path.join(headReferenceDirectory, name), "utf8")),
  );
  const laneReference = await fs.readFile(path.join(packageRoot, "skills/lane/references/workflow.md"), "utf8");
  const nativeBase = session.baseSystemPrompt;
  assert(nativeBase[0] && nativeBase[0].length > 500, "Use the real rendered native system prompt, not a sentinel");
  const branchBefore = structuredClone(sessionManager.getBranch());
  const occurrences = (text: string, needle: string) => text.split(needle).length - 1;
  const assertRolePolicy = (blocks: string[]): string | undefined => {
    const combined = blocks.join("\n\n");
    assert.equal(occurrences(combined, roleBody), kind === "main" ? 1 : 0);
    for (const reference of [...headReferences, laneReference]) {
      assert(!combined.includes(reference), "Packaged references must not be added to automatic system prompts");
    }
    if (kind === "sub") {
      assert.equal(occurrences(combined, childRole), 1);
      assert.equal(occurrences(combined, childAssignment), 1);
      assert(!combined.includes("# Main head operating contract"));
      assert(!combined.includes("# Lane operating contract"));
    }
    if (ulwPath) {
      assert.equal(occurrences(combined, "<omp-model-preset>"), 1, "A real supported ULW preset must be active");
      const preset = /<omp-model-preset>([\s\S]*?)<\/omp-model-preset>/.exec(combined)?.[1];
      assert(preset?.includes(compositionModel.name), "Composed preset must contain instructions for the selected model");
      assert(!combined.includes("<omp-ulw-policy>"), "Loading a model profile is not workflow activation");
    }
    const referenceLocations = [...combined.matchAll(/^Packaged HEAD reference directory: (.+)$/gm)];
    assert.equal(referenceLocations.length, role === "head" && kind === "main" ? 1 : 0);
    const [referenceLocation] = referenceLocations;
    if (!referenceLocation) return undefined;
    const directory: unknown = JSON.parse(referenceLocation[1] ?? "");
    assert(typeof directory === "string" && path.isAbsolute(directory));
    return directory;
  };
  let emittedHeadReferences: string | undefined;
  for (let turn = 0; turn < 2; turn++) {
    const instruction = await runner.emitBeforeAgentStart("Inspect the requested implementation and report evidence.", undefined, [...nativeBase]);
    const blocks = instruction?.systemPrompt ?? nativeBase;
    emittedHeadReferences = assertRolePolicy(blocks);
    if (kind === "sub" && !ulwPath) assert.equal(instruction, undefined);
    else if (kind === "sub") assert.equal(blocks.length, nativeBase.length);
    else {
      assert.equal(instruction?.systemPrompt?.filter(part => part === roleBody).length, 1);
      if (!ulwPath) assert.equal(instruction?.systemPrompt?.[0], nativeBase[0]);
      assert.equal(blocks.length, nativeBase.length + 2);
      if (role === "lane") {
        const actualCwd = runner.createContext().cwd;
        assert.equal(await fs.realpath(actualCwd), await fs.realpath(workspace));
        assert(instruction?.systemPrompt?.some(part => part.includes(`Workspace: ${actualCwd}`)));
      }
    }
    if (ulwPath) {
      // Native OpenAI Responses payload shape. Refresh a genuinely stale
      // marked preset while retaining the surrounding local role/assignment.
      const current: string = blocks.join("\n\n");
      const preset: string = /<omp-model-preset>[\s\S]*?<\/omp-model-preset>/.exec(current)![0];
      const userMessage: CompositionPayload["input"][number] = {
        role: "user", content: "Literal task data: <omp-model-preset>do not rewrite me</omp-model-preset>",
      };
      const payload: CompositionPayload = { model: compositionModel.id, stream: true,
        instructions: current.replace(preset, "<omp-model-preset>stale request profile</omp-model-preset>"),
        input: [userMessage],
      };
      const rewritten: CompositionPayload = await runner.emitBeforeProviderRequest(payload, compositionModel) as CompositionPayload;
      assert.equal(rewritten.model, compositionModel.id);
      assert.equal(rewritten.stream, true);
      assert.deepEqual(rewritten.input, [userMessage], "Task data is never rewritten as system policy");
      const system = rewritten.instructions;
      assert(!system.includes("stale request profile"));
      assert(system.includes(preset), "Provider refresh preserves the supported base model working methods");
      assert.equal(assertRolePolicy([system]), emittedHeadReferences);
      assert.deepEqual(await runner.emitBeforeProviderRequest(rewritten, compositionModel), rewritten,
        "Repeated native payload projection must not duplicate local policy");
    }
  }
  assert.deepEqual(sessionManager.getBranch(), branchBefore, "Prompt inspection must not arm workflows or enqueue work");
  assert(!session.getAllToolInfos().some(tool => tool.name.startsWith("board_")), "An unmanaged fixture cannot acquire board authority");
  assert(!session.isStreaming, "No model/provider execution is allowed");
  assert(!(await fs.readdir(root, { recursive: true })).some(name => /(?:^|\/)coordination\.sqlite(?:-|$)/.test(name)),
    "Hook composition must not activate a board instance");

  const discovered = session.skills;
  for (const name of ["superagent-head", "superagent-lane", "project-existing", "user-existing", "custom-existing"]) {
    assert(discovered.some(skill => skill.name === name), `Native discovery omitted ${name}`);
  }
  assert(!discovered.some(skill => skill.name === "ignored-local"));
  const currentSettings = cfgSkills.get(settings);
  for (const key of ["customDirectories", "ignoredSkills", "manualSkills", "enableClaudeProject"] as const) {
    assert.deepEqual(currentSettings[key], skillSettings[key]);
  }
  for (const name of ["superagent-head", "superagent-lane"]) {
    const entry = discovered.find(skill => skill.name === name);
    assert(entry);
    if (shadowHead && name === "superagent-head") {
      assert.notEqual(entry._source?.provider, "omp-plugins");
      continue;
    }
    assert.equal(entry._source?.provider, "omp-plugins");
    assert.equal(entry.hide, true);
  }

  const resources = [
    ["superagent-head", "head", "SKILL.md"],
    ["superagent-head", "head", "references/routing.md"],
    ["superagent-head", "head", "references/model-selection.md"],
    ["superagent-head", "head", "references/supervision.md"],
    ["superagent-lane", "lane", "SKILL.md"],
    ["superagent-lane", "lane", "references/workflow.md"],
  ] as const;
  const read = session.getToolByName("read")!;
  if (shadowHead) {
    const shadow = await read.execute("native-read-shadow", { path: "skill://superagent-head/references/routing.md:raw" });
    const text = shadow.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n");
    assert.equal(text, await fs.readFile(path.join(shadowDirectory, "references/routing.md"), "utf8"));
  }
  const reads: string[] = [];
  for (const [name, directory, relative] of resources) {
    let uri = relative === "SKILL.md" ? `skill://${name}:raw` : `skill://${name}/${relative}:raw`;
    if (directory === "head" && emittedHeadReferences) {
      if (relative !== "SKILL.md") uri = `${path.join(emittedHeadReferences, path.basename(relative))}:raw`;
      else if (shadowHead) uri = `${path.join(path.dirname(emittedHeadReferences), relative)}:raw`;
    }
    const output = await read.execute(`native-read-${reads.length}`, { path: uri });
    const text = output.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n");
    assert.equal(text, await fs.readFile(path.join(packageRoot, "skills", directory, relative), "utf8"));
    reads.push(uri);
  }

  const schemas = Object.fromEntries([...managerNames, "lane_report", "decision_ask"].flatMap(name => {
    const info = session.getAllToolInfos().find(tool => tool.name === name);
    return info ? [[name, toolWireSchema(info)]] : [];
  }));
  const check = (name: string, input: Record<string, unknown>, valid: boolean) => {
    const tool = runner.getRegisteredTool(name)!.definition;
    const validate = () => validateToolArguments(tool, { type: "toolCall", id: "schema-check", name, arguments: input });
    if (valid) assert.doesNotThrow(validate, `${name} schema validation`);
    else assert.throws(validate, /Validation failed for tool/, `${name} schema validation: ${JSON.stringify(input)}`);
  };
  const question = { question: "Select a release route", header: "Release", options: [
    { label: "Local", description: "Keep the work local", preview: "No deployment" },
    { label: "Review", description: "Prepare a review" },
  ], recommended: 1 };
  check("decision_ask", { questions: [question] }, true);
  for (const input of [{}, { questions: [] }, { questions: [{ question: "Missing options" }] },
    { questions: [{ ...question, multi: "invalid" }] }, { questions: [{ ...question, recommended: -1 }] }]) {
    check("decision_ask", input, false);
  }
  const ask = runner.getRegisteredTool("decision_ask")!.definition;
  assert.equal(ask.approval, "read");
  assert.equal(ask.loadMode, "essential");
  const askChild = { ...runner.createContext(), agent: { kind: "sub" as const, id: "advisor", name: "advisor", depth: 0 } };
  assert.deepEqual(await runner.emitToolCall({ type: "tool_call", toolName: "decision_ask", toolCallId: "child-ask",
    input: { questions: [question] } }, undefined, askChild.agent),
  { block: true, reason: "Owner decisions are restricted to the root managed HEAD or lane session" });
  await assert.rejects(() => ask.execute("child-ask", { questions: [question] }, undefined, undefined, askChild),
    /restricted to the root managed HEAD or lane session/);
  if (kind === "sub") {
    assert(!session.getEnabledToolNames().includes("decision_ask"));
    await session.setActiveToolsByName([...expectedActive, "decision_ask"]);
    await assert.rejects(() => session.getToolByName("decision_ask")!.execute("reactivated-child-ask", { questions: [question] }),
      /restricted to the root managed HEAD or lane session/);
    await runner.emit({ type: "session_start" });
    assert.deepEqual(session.getEnabledToolNames(), expectedActive);
  } else if (selection === "narrow") assert(!session.getEnabledToolNames().includes("decision_ask"));
  else assert(session.getEnabledToolNames().includes("decision_ask"));
  if (role === "lane" && kind === "main" && selection === "default") {
    const context = runner.createContext();
    const id = decisionId(sessionManager.getSessionId(), "native-owner-question");
    assert.match(id, /^d-[0-9a-f]{24}$/);
    const questions = [{ ...question, id: `${id}:0` }];
    const answers = [{ id: `${id}:0`, question: question.question, options: ["Local", "Review"],
      multi: false, selectedOptions: ["Local"] }];
    const controller = new AbortController();
    const requests: { questions: ExtensionAskDialogQuestion[]; options: ExtensionUIDialogOptions | undefined }[] = [];
    const execute = async (answer: ExtensionAskDialogResult | undefined) => {
      const output = await ask.execute("native-owner-question", { questions: [question] }, controller.signal, undefined, {
        ...context, ui: { ...context.ui, askDialog: async (questions, options) => {
          requests.push({ questions, options });
          return answer;
        } },
      });
      assert.deepEqual(requests.at(-1), { questions: [{ ...questions[0], multi: undefined,
        options: question.options.map(option => ({ ...option, preview: "preview" in option ? option.preview : undefined })) }],
      options: { signal: controller.signal } });
      const text = output.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n");
      assert.deepEqual(JSON.parse(text), output.details);
      return output.details;
    };
    assert.deepEqual(await execute({ kind: "submit", results: answers }), { id, status: "submitted", answers });
    assert.deepEqual(await execute(undefined), { id, status: "cancelled" });
    assert.deepEqual(await execute({ kind: "chat" }), { id, status: "chat" });
    const timedOut = answers.map(answer => ({ ...answer, selectedOptions: ["Review"], timedOut: true }));
    assert.deepEqual(await execute({ kind: "submit", results: timedOut }), { id, status: "timed_out", answers: timedOut });
    const unavailable = { ...context, ui: { ...context.ui, askDialog: undefined } };
    await assert.rejects(() => ask.execute("no-ui", { questions: [question] }, undefined, undefined, unavailable),
      /Native structured decision UI is unavailable/);
    for (const invalid of [
      { ...question, options: [{ label: "Same" }, { label: "Same" }] },
      { ...question, recommended: 2 },
    ]) {
      await assert.rejects(() => ask.execute("invalid-question", { questions: [invalid] }, undefined, undefined, unavailable),
        /Ask option labels are not unique|Malformed recommended option/);
    }
    assert.equal(requests.length, 4, "Invalid/unavailable calls must never open native UI");
    for (const outcome of ["cancel", "error"] as const) {
      const pending = Promise.withResolvers<ExtensionAskDialogResult | undefined>();
      let dialogs = 0;
      const concurrentContext = { ...context, ui: { ...context.ui, askDialog: () => {
        dialogs++;
        return dialogs === 1 ? pending.promise : Promise.resolve(undefined);
      } } };
      const first = ask.execute(`pending-${outcome}`, { questions: [question] }, undefined, undefined, concurrentContext);
      const completion = outcome === "error" ? assert.rejects(() => first, /Native decision aborted/) : first;
      await assert.rejects(() => ask.execute("overlapping-question", { questions: [question] },
        undefined, undefined, concurrentContext), /owner decision dialog is already pending/);
      assert.equal(dialogs, 1, "Overlapping calls must not replace the active native dialog");
      if (outcome === "error") pending.reject(new Error("Native decision aborted"));
      else pending.resolve(undefined);
      await completion;
      assert.deepEqual(await execute(undefined), { id, status: "cancelled" },
        "Native completion and rejection both release the active-dialog guard");
    }
  }
  if (role === "head") {
    // The native extension loader adapts legacy TypeBox to callable omptype
    // schemas. Exercise the same argument validator and wire-schema lowering
    // that OMP uses, rather than applying TypeBox to its native representation.
    const destination = { platform: "slack", accountId: "T:B", authorityId: "U", guildId: "T", channelId: "C", threadId: "1.2" };
    check("cron_create", { sourceId: "owner-source", schedule: "in 30m", prompt: "Summarize CI" }, true);
    check("cron_create", { sourceId: "owner-source", schedule: "in 30m" }, false);
    assert.equal(runner.getRegisteredTool("cron_create")?.definition.approval, "exec");
    assert.equal((await runner.emitToolCall({ type: "tool_call", toolName: "cron_create", toolCallId: "child-cron", input: {} },
      undefined, askChild.agent))?.block, true);
    check("decision_list", {}, true);
    check("decision_list", { state: "all", laneId: "lane" }, true);
    check("decision_list", { state: "closed" }, false);
    check("decision_inspect", { id: "d-123" }, true);
    check("decision_inspect", {}, false);
    check("decision_withdraw", { id: "d-123", sourceId: "source", reason: "Owner cancelled the question" }, true);
    for (const input of [{ id: "d-123", reason: "Missing source" }, { id: "d-123", sourceId: "source", reason: " " }])
      check("decision_withdraw", input, false);
    assert.deepEqual(validateToolArguments(runner.getRegisteredTool("decision_withdraw")!.definition, {
      type: "toolCall", id: "foreign-decision-route", name: "decision_withdraw",
      arguments: { id: "d-123", sourceId: "source", reason: "Owner withdrew", route: destination },
    }), { id: "d-123", sourceId: "source", reason: "Owner withdrew" });
    for (const name of ["decision_list", "decision_inspect", "decision_withdraw"]) {
      assert.equal(runner.getRegisteredTool(name)!.definition.approval, name === "decision_withdraw" ? "exec" : "read");
      const blocked = await runner.emitToolCall({ type: "tool_call", toolName: name, toolCallId: `child-${name}`, input: {} },
        undefined, askChild.agent);
      assert.equal(blocked?.block, true);
      assert.match(blocked?.reason ?? "", /restricted to the main superagent head/);
    }
    const modelChoice = { model: { provider: "fixture", id: "chat" }, modelReason: "Known task requirements" };
    const kickoff = "I will inspect the workspace and verify the requested changes in this topic.";
    for (const platform of ["discord", "telegram", "slack"]) {
      check("lane_start", { sourceId: "source", title: "title", cwd: workspace, kickoff, ...modelChoice, destination: { ...destination, platform } }, true);
    }
    check("lane_start", { sourceId: "source", title: "title" }, false);
    check("lane_start", { sourceId: "source", title: "title", cwd: workspace }, false);
    check("lane_start", { sourceId: "source", title: "title", cwd: workspace, ...modelChoice }, false);
    check("lane_start", { sourceId: "source", title: "title", cwd: workspace, kickoff, ...modelChoice, modelReason: "" }, false);
    check("lane_start", { sourceId: "source", title: "title", cwd: workspace, kickoff, preset: "middle", modelReason: "Native preset selected" }, true);
    check("lane_start", { sourceId: "source", title: "title", cwd: workspace, kickoff, ...modelChoice, destination: { ...destination, platform: "unknown" } }, false);
    check("lane_start", { sourceId: "source", title: "title", cwd: workspace, kickoff, ...modelChoice, appliedTags: ["101"] }, true);
    check("lane_start", { sourceId: "source", title: "title", cwd: workspace, kickoff, ...modelChoice, appliedTags: ["101", "101"] }, false);
    check("thread_inspect", { sourceId: "source" }, true);
    check("thread_inspect", { sourceId: "source", laneId: "lane" }, true);
    check("thread_inspect", { laneId: "lane" }, false);
    check("pr_watch_list", {}, true);
    check("pr_watch", { action: "track", ref: "owner/repo#1", sourceId: "source", intervalSeconds: 300 }, true);
    check("pr_watch", { action: "track", ref: "owner/repo#1", sourceId: "source", intervalSeconds: 300, laneId: "lane", ignoreAuthors: ["ci[bot]"] }, true);
    check("pr_watch", { action: "untrack", ref: "owner/repo#1", sourceId: "source" }, true);
    for (const input of [
      { action: "track", ref: "owner/repo#1", sourceId: "source" },
      { action: "track", ref: "owner/repo#1", sourceId: "source", intervalSeconds: 0 },
      { action: "track", ref: "owner/repo#1", intervalSeconds: 300 },
      { action: "untrack", ref: "owner/repo#1", sourceId: "source", intervalSeconds: 300 },
    ]) check("pr_watch", input, false);
    for (const name of ["discord_context", "discord_purpose_list", "discord_purpose_clear"]) {
      check(name, { sourceId: "source" }, true);
      check(name, {}, false);
      // Native OMP repairs unknown root keys. A caller-supplied route must
      // disappear, leaving only the original authorized source selector.
      assert.deepEqual(validateToolArguments(runner.getRegisteredTool(name)!.definition, {
        type: "toolCall", id: "foreign-route", name, arguments: { sourceId: "source", route: destination },
      }), { sourceId: "source" });
    }
    check("discord_purpose_clear", { sourceId: "source", scope: "channel" }, true);
    check("discord_purpose_clear", { sourceId: "source", scope: "thread" }, true);
    check("discord_purpose_set", { sourceId: "source", purpose: "Owner note" }, true);
    check("discord_purpose_set", { sourceId: "source", purpose: "Owner note", scope: "channel" }, true);
    check("discord_purpose_set", { sourceId: "source", purpose: "Owner note", scope: "thread" }, true);
    for (const invalid of [
      { purpose: "Missing source" }, { sourceId: "source" }, { sourceId: "source", purpose: " " },
      { sourceId: "source", purpose: "x".repeat(4001) }, { sourceId: "source", purpose: "note", scope: "sibling" },
    ]) check("discord_purpose_set", invalid, false);
    assert.deepEqual(validateToolArguments(runner.getRegisteredTool("discord_purpose_set")!.definition, {
      type: "toolCall", id: "foreign-purpose-route", name: "discord_purpose_set",
      arguments: { sourceId: "source", purpose: "note", route: destination },
    }), { sourceId: "source", purpose: "note" });
    for (const name of ["discord_context", "discord_purpose_list", "discord_purpose_set", "discord_purpose_clear"]) {
      const tool = runner.getRegisteredTool(name);
      assert(tool);
      assert.equal(tool.definition.approval, name === "discord_context" || name === "discord_purpose_list" ? "read" : "exec");
    }
    for (const changes of [{ title: "Renamed" }, { appliedTags: [] }, { appliedTags: ["101"], archived: true }, { archived: false }])
      check("lane_thread_update", { id: "lane", sourceId: "source", changes }, true);
    const threadUpdate = runner.getRegisteredTool("lane_thread_update")!.definition;
    assert.deepEqual(validateToolArguments(threadUpdate, { type: "toolCall", id: "normalized-boolean", name: "lane_thread_update",
      arguments: { id: "lane", sourceId: "source", changes: { archived: "true" } } }),
      { id: "lane", sourceId: "source", changes: { archived: true } });
    for (const changes of [{}, { title: " " }, { archived: "not-a-boolean" }, { appliedTags: ["name"] }, { locked: true }])
      check("lane_thread_update", { id: "lane", sourceId: "source", changes }, false);
    check("lane_models", {}, true);
    check("lane_models", { selectors: ["@smol", "@slow"] }, true);
    check("lane_models", { selectors: [] }, false);
    check("lane_init_presets", { choices: { high: { model: modelChoice.model, reason: "Initial native preset" } } }, true);
    check("lane_set_model", { id: "lane", sourceId: "source", preset: "low", modelReason: "Authorized idle change" }, true);
    check("lane_set_model", { id: "lane", sourceId: "source", ...modelChoice }, true);
    check("lane_set_model", { id: "lane", preset: "low", modelReason: "Missing event" }, false);
    check("lane_inspect", {}, true);
    check("lane_message", { id: "lane", text: "instruction", sourceId: "source" }, true);
    check("lane_message", { id: "lane", text: "instruction" }, false);
    for (const name of ["ulw", "ulw-plan", "ulw-execute", "ulw-loop", "mass-ulw", "ulw-research", "jevify"]) {
      const workflow = { name, reason: "Selected method serves the authorized objective" };
      check("lane_start", { sourceId: "source", title: "title", cwd: workspace, kickoff, ...modelChoice, workflow }, true);
      check("lane_message", { id: "lane", text: "instruction", sourceId: "source", workflow }, true);
    }
    for (const workflow of [{ name: "arbitrary", reason: "unknown" }, { name: "ulw-plan" }, { name: "ulw", reason: "" }]) {
      check("lane_start", { sourceId: "source", title: "title", cwd: workspace, kickoff, ...modelChoice, workflow }, false);
      check("lane_message", { id: "lane", text: "instruction", sourceId: "source", workflow }, false);
    }
    check("lane_pause", { id: "lane" }, true);
    check("lane_resume", { id: "lane", sourceId: "source" }, true);
    check("lane_resume", { id: "lane" }, false);
    check("lane_close", { id: "lane", outcome: "completed", evidence: "checked" }, true);
    check("lane_close", { id: "lane", outcome: "cancelled", evidence: "authorized" }, true);
    check("lane_close", { id: "lane", outcome: "completed" }, false);
    const childContext = { ...runner.createContext(), agent: { kind: "sub" as const, id: "advisor", name: "advisor", depth: 0 } };
    for (const name of managerNames) {
      // Even direct/inherited access cannot acquire authority by reactivation.
      const definition = runner.getRegisteredTool(name)!.definition;
      await assert.rejects(() => definition.execute("denied-child", {}, undefined, undefined, childContext), /restricted to the main superagent head/);
    }
    if (kind === "sub") {
      for (const name of managerNames) assert(!session.getEnabledToolNames().includes(name));
      await session.setActiveToolsByName([...expectedActive, "lane_inspect"]);
      await assert.rejects(() => session.getToolByName("lane_inspect")!.execute("reactivated-child", {}), /restricted to the main superagent head/);
      await runner.emit({ type: "session_start" });
      assert.deepEqual(session.getEnabledToolNames(), expectedActive);
    } else if (selection === "narrow") {
      assert(!session.getEnabledToolNames().includes("lane_message"));
    }
  } else {
    assert.deepEqual(Object.keys(schemas), ["lane_report", "decision_ask"]);
    const definition = runner.getRegisteredTool("lane_report")!.definition;
    assert.equal(definition.loadMode, "essential");
    assert.equal(definition.approval, "read");
    const childContext = { ...runner.createContext(), agent: { kind: "sub" as const, id: "advisor", name: "advisor", depth: 0 } };
    await assert.rejects(() => definition.execute("denied-child",
      { status: "waiting", summary: "Dependency observation", waiting: { kind: "dependency", target: "parent review" } },
      undefined, undefined, childContext), /restricted to the root lane session/);
    if (kind === "sub") {
      assert(!session.getEnabledToolNames().includes("lane_report"));
      await session.setActiveToolsByName([...expectedActive, "lane_report"]);
      await assert.rejects(() => session.getToolByName("lane_report")!.execute("reactivated-child",
        { status: "waiting", summary: "Dependency observation", waiting: { kind: "dependency", target: "parent review" } }),
      /restricted to the root lane session/);
      await runner.emit({ type: "session_start" });
      assert.deepEqual(session.getEnabledToolNames(), expectedActive);
    } else if (selection === "narrow") {
      assert(!session.getEnabledToolNames().includes("lane_report"));
    } else assert(session.getEnabledToolNames().includes("lane_report"));
  }

  assert.equal(networkAttempts, 0);
  console.log(`NATIVE_SKILLS_PROOF ${JSON.stringify({ role, kind, selection, extensionOrder, composition: Boolean(ulwPath), turns: 2,
    reads, schemas, active: session.getEnabledToolNames(), discovered: discovered.map(skill => skill.name), networkAttempts })}`);
} finally {
  await session.extensionRunner?.emit({ type: "session_shutdown" });
  await session.dispose();
  authStorage.close();
}
