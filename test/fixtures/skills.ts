import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { buildModel } from "../../.upstream/omp/packages/catalog/src/build";
import { toolWireSchema } from "../../.upstream/omp/packages/ai/src/utils/schema/wire";
import { validateToolArguments } from "../../.upstream/omp/packages/ai/src/utils/validation";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgSkills } from "@oh-my-pi/pi-coding-agent/extensibility/settings";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { buildHostArgs } from "../../src/host";
import { nativeDisabledProviders } from "./native-extension";

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
const managerNames = ["lane_models", "lane_init_presets", "lane_set_model", "lane_start", "lane_inspect", "lane_message", "lane_pause", "lane_resume", "lane_close"];
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
delete process.env.OMP_RPC_SOCKET;
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
  additionalExtensionPaths: extensionPaths,
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
    await session.setActiveToolsByName(session.getEnabledToolNames().filter(name => name !== "bash" && name !== "lane_message"));
  }
  const before = session.getEnabledToolNames();
  const errors: Array<{ event: string; error: string }> = [];
  await initializeExtensions(session, {
    reportRuntimeError: error => { errors.push(error); },
    reportSendError: (_action, error) => { throw error; },
  });
  if (role === "head" && kind === "main") {
    assert.equal(errors.length, 1);
    assert.match(errors[0]!.error, /Start this extension with omp-superagent start/);
  } else {
    assert.deepEqual(errors, [], "Task/lane sessions must never attempt head startup");
  }
  const expectedActive = role === "head" && kind === "sub"
    ? before.filter(name => !managerNames.includes(name)) : before;
  assert.deepEqual(session.getEnabledToolNames(), expectedActive);
  if (selection === "narrow") assert(!session.getEnabledToolNames().includes("bash"));

  const roleBody = await fs.readFile(path.join(packageRoot, `skills/${role}/SKILL.md`), "utf8");
  const headReferenceDirectory = path.join(packageRoot, "skills/head/references");
  const headReferences = await Promise.all(
    (await fs.readdir(headReferenceDirectory, { recursive: true })).filter(name => name.endsWith(".md"))
      .map(name => fs.readFile(path.join(headReferenceDirectory, name), "utf8")),
  );
  const nativeBase = session.baseSystemPrompt;
  assert(nativeBase[0] && nativeBase[0].length > 500, "Use the real rendered native system prompt, not a sentinel");
  const branchBefore = structuredClone(sessionManager.getBranch());
  const occurrences = (text: string, needle: string) => text.split(needle).length - 1;
  const assertRolePolicy = (blocks: string[]) => {
    const combined = blocks.join("\n\n");
    assert.equal(occurrences(combined, roleBody), kind === "main" ? 1 : 0);
    for (const reference of headReferences) {
      assert.equal(occurrences(combined, reference), role === "head" && kind === "main" ? 1 : 0,
        "The complete head bundle belongs exactly once to root heads only");
    }
    if (kind === "sub") {
      assert.equal(occurrences(combined, childRole), 1);
      assert.equal(occurrences(combined, childAssignment), 1);
      assert(!combined.includes("# Main head operating contract"));
      assert(!combined.includes("# Lane operating contract"));
    }
    if (ulwPath) {
      assert.equal(occurrences(combined, "<omp-model-preset>"), 1, "A real supported ULW preset must be active");
      assert.match(combined, /on Grok 4\.5, acting as CEO and orchestrator/);
      assert.match(combined, /Delegate implementation via `task` when the host permits it/);
      assert.match(combined, /Never present unread code or unrun commands as verified fact/);
      assert.match(combined, /Refusals are final/);
      if (kind === "sub") assert.match(combined, /host-provided specialist role and assigned task/);
      assert(!combined.includes("<omp-ulw-policy>"), "Loading a model profile is not workflow activation");
    }
  };
  for (let turn = 0; turn < 2; turn++) {
    const instruction = await runner.emitBeforeAgentStart("Inspect the requested implementation and report evidence.", undefined, [...nativeBase]);
    const blocks = instruction?.systemPrompt ?? nativeBase;
    assertRolePolicy(blocks);
    if (kind === "sub" && !ulwPath) assert.equal(instruction, undefined);
    else if (kind === "sub") assert.equal(blocks.length, nativeBase.length);
    else {
      assert.equal(instruction?.systemPrompt?.filter(part => part === roleBody).length, 1);
      if (!ulwPath) assert.equal(instruction?.systemPrompt?.[0], nativeBase[0]);
      assert.equal(blocks.length, nativeBase.length + (role === "lane" ? 2 : 1 + headReferences.length));
      for (const reference of headReferences) {
        assert.equal(instruction?.systemPrompt?.filter(part => part === reference).length, role === "head" ? 1 : 0,
          "Every head procedure must be present before inference, only in the root head, without a read tool call");
      }
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
      assertRolePolicy([system]);
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
    const entry = discovered.find(skill => skill.name === name)!;
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
  const reads: string[] = [];
  for (const [name, directory, relative] of resources) {
    const uri = relative === "SKILL.md" ? `skill://${name}:raw` : `skill://${name}/${relative}:raw`;
    const output = await read.execute(`native-read-${reads.length}`, { path: uri });
    const text = output.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n");
    assert.equal(text, await fs.readFile(path.join(packageRoot, "skills", directory, relative), "utf8"));
    reads.push(uri);
  }

  const schemas = Object.fromEntries(managerNames.flatMap(name => {
    const info = session.getAllToolInfos().find(tool => tool.name === name);
    return info ? [[name, toolWireSchema(info)]] : [];
  }));
  if (role === "head") {
    // The native extension loader adapts legacy TypeBox to callable omptype
    // schemas. Exercise the same argument validator and wire-schema lowering
    // that OMP uses, rather than applying TypeBox to its native representation.
    const check = (name: string, input: Record<string, unknown>, valid: boolean) => {
      const tool = runner.getRegisteredTool(name)!.definition;
      const validate = () => validateToolArguments(tool, { type: "toolCall", id: "schema-check", name, arguments: input });
      if (valid) assert.doesNotThrow(validate, `${name} schema validation`);
      else assert.throws(validate, /Validation failed for tool/, `${name} schema validation`);
    };
    const destination = { platform: "slack", accountId: "T:B", authorityId: "U", guildId: "T", channelId: "C", threadId: "1.2" };
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
    for (const name of ["ulw", "ulw-plan", "ulw-execute", "ulw-loop", "mass-ulw", "ulw-research"]) {
      const workflow = { name, reason: "Existing objective requires durable dependency handoffs" };
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
  } else assert.deepEqual(schemas, {});

  assert.equal(networkAttempts, 0);
  console.log(`NATIVE_SKILLS_PROOF ${JSON.stringify({ role, kind, selection, extensionOrder, composition: Boolean(ulwPath), turns: 2,
    reads, schemas, active: session.getEnabledToolNames(), discovered: discovered.map(skill => skill.name), networkAttempts })}`);
} finally {
  await session.extensionRunner?.emit({ type: "session_shutdown" });
  await session.dispose();
  authStorage.close();
}
