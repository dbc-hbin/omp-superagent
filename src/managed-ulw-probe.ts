// Finite native prompt-composition gate, not a model turn or workflow execution.
import assert from "node:assert/strict";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { getBundledModel, getBundledProviders } from "@oh-my-pi/pi-catalog";
import { ModelRegistry, Settings, AuthStorage, SessionManager, createAgentSession } from "@oh-my-pi/pi-coding-agent";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { listPackageExtensionModules, loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { buildAvailableSlashCommands } from "@oh-my-pi/pi-coding-agent/slash-commands/available-commands";
import { buildSystemPrompt } from "@oh-my-pi/pi-coding-agent/system-prompt";
import { WORKFLOW_NAMES } from "./contracts";
import { readManagedUlwPackage } from "./managed-ulw";
import { canonicalSuperkitSkills, hasCanonicalSuperkitSkills, legacySuperkitSkills, superkitWorkflows as workflows } from "./superkit-skills";
import { advertisedWorkflow } from "./workflow";

const packageArg = process.argv[2];
if (!packageArg) throw new Error("Managed Superkit probe requires a package path");
const { packagePath, extensionFiles } = readManagedUlwPackage(packageArg);
const home = process.env.HOME;
const agentDir = process.env.PI_CODING_AGENT_DIR;
assert(home && agentDir && resolve(dirname(agentDir)) === resolve(home) && resolve(process.cwd()) === resolve(home),
  "Managed Superkit probe requires the updater's isolated HOME, agent directory and working directory");
let networkAttempts = 0;
const refuseNetwork = () => { networkAttempts++; throw new Error("Managed Superkit probe forbids network and provider calls"); };
globalThis.fetch = Object.assign(async () => refuseNetwork(), { preconnect: refuseNetwork });

const skillPath = (id: string) => join(packagePath, "skills", id, "SKILL.md");
const canonicalLayout = hasCanonicalSuperkitSkills(packagePath);
const directiveId = (canonicalLayout ? canonicalSuperkitSkills : legacySuperkitSkills)[0];
const directivePath = await realpath(skillPath(directiveId));
assert(directivePath.startsWith(packagePath + sep), `Managed Superkit skill leaves its package: ${directiveId}`);
const directive = /<ultrawork-mode>([\s\S]*?)<\/ultrawork-mode>/.exec(await readFile(directivePath, "utf8"))?.[1];
assert(directive?.trim(), `Managed Superkit must ship a directive in its installed ${directiveId} skill`);

const modules = await listPackageExtensionModules([packagePath], process.cwd(), { plugins: false });
assert.deepEqual(await Promise.all(modules.map(module => realpath(module.path))), extensionFiles,
  "Native OMP discovery must resolve exactly the advertised managed Superkit modules");
// Use the same supported identity as the native composition fixture, but take
// every model field from the declared published catalog rather than inventing a provider.
const model = getBundledModel("xai", "grok-4.5");
assert(model, "Pinned OMP catalog is missing the native composition model xai/grok-4.5");
await mkdir(agentDir, { recursive: true, mode: 0o700 });
const settings = await Settings.loadIsolated({
  cwd: home, agentDir, inMemory: true,
  overrides: {
    disabledProviders: [...new Set([...getBundledProviders(), "ollama", "lm-studio", "llama.cpp", "apple"])],
    "memory.backend": "off", "autolearn.enabled": false,
  },
});
const authStorage = await AuthStorage.create(":memory:");
try {
  const sessionManager = SessionManager.inMemory(home);
  const loaded = await loadExtensions(modules.map(module => module.path), home);
  assert.deepEqual(loaded.errors, [], "Native OMP rejected managed Superkit");
  assert.deepEqual(await Promise.all(loaded.extensions.map(extension => realpath(extension.resolvedPath))), extensionFiles,
    "Native OMP must load every advertised managed Superkit extension");
  // Render the published SDK's bundled template in the isolated HOME without
  // tools, memory backend, SDK Agent, services, or provider/model execution.
  const { systemPrompt: nativeBase } = await buildSystemPrompt({
    cwd: home, model: `${model.provider}/${model.id}`,
    contextFiles: [], noContextFiles: true, rules: [], skills: [],
    toolNames: [], activeRepoContext: null, personality: "none",
  });
  const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, home, sessionManager,
    new ModelRegistry(authStorage, join(home, "models.yml"), { settings }), undefined, settings);
  const errors: unknown[] = [];
  const refuseEffect = (): never => {
    const error = new Error("Managed Superkit prompt probe forbids agent, tool, service and session-control effects");
    errors.push(error);
    throw error;
  };
  let currentSystemPrompt = nativeBase;
  // This is a prompt-only host, not a fake agent: only in-memory journal writes
  // and read-only context exist. Unsupported effects fail the activation gate.
  runner.initialize({
    sendMessage: refuseEffect, sendUserMessage: refuseEffect,
    appendEntry: (customType, data) => { sessionManager.appendCustomEntry(customType, data); },
    setLabel: (targetId, label) => { sessionManager.appendLabelChange(targetId, label); },
    getActiveTools: () => [], getAllTools: () => [], setActiveTools: refuseEffect,
    getCommands: refuseEffect, setModel: refuseEffect,
    getThinkingLevel: () => undefined, setThinkingLevel: refuseEffect,
    getServiceTiers: () => ({}), setServiceTier: refuseEffect,
    getSessionName: () => sessionManager.getSessionName(), setSessionName: refuseEffect,
  }, {
    getModel: () => model, isIdle: () => true, hasPendingMessages: () => false,
    abort: refuseEffect, shutdown: refuseEffect, compact: refuseEffect,
    getContextUsage: () => undefined, getSystemPrompt: () => currentSystemPrompt,
    runEphemeralTurn: refuseEffect, startLive: refuseEffect,
  });
  runner.onError(error => { errors.push(error); });
  try {
    await runner.emit({ type: "session_start" });
    assert(nativeBase[0] && nativeBase[0].length > 500, "Probe must use OMP's actual rendered native prompt");
    const nativeRole = /(?:^|\n[§⁂] Role\n)([\s\S]*?)\n[§⁂] Runtime\n/.exec(nativeBase[0])?.[1];
    assert(nativeRole && nativeRole.trim(), "Native prompt has no recognizable role to replace");
    const initialBranch = structuredClone(sessionManager.getBranch());
    const occurrences = (text: string, needle: string) => text.split(needle).length - 1;
    const check = (blocks: string[], workflow: boolean) => {
      const text = blocks.join("\n\n");
      assert.equal(occurrences(text, "<omp-model-preset>"), 1, "Expected exactly one applied model preset");
      assert.equal(occurrences(text, "</omp-model-preset>"), 1, "Expected one complete model preset");
      const preset = /<omp-model-preset>([\s\S]*?)<\/omp-model-preset>/.exec(text)?.[1];
      assert(preset && preset.trim().length > 200, "Model preset must contain working instructions, not an empty marker");
      assert.match(preset, /Grok 4\.5/, "Supported model-specific instructions must actually be selected");
      assert(!text.includes(nativeRole), "Model preset did not replace the native role");
      assert.equal(occurrences(text, "<omp-ulw-policy>"), workflow ? 1 : 0,
        workflow ? "Expected exactly one explicitly activated SUPER policy" : "Ordinary or quoted text must not activate SUPER policy");
      assert.equal(occurrences(text, "</omp-ulw-policy>"), workflow ? 1 : 0);
      if (workflow) {
        const policy = /<omp-ulw-policy>\s*<ultrawork-mode>([\s\S]*?)<\/ultrawork-mode>\s*<\/omp-ulw-policy>/.exec(text)?.[1];
        assert(policy && policy.trim().length > 200, "Activated SUPER policy must contain the workflow directive");
        assert.equal(policy, directive, `Activated SUPER policy must use the installed ${directiveId} directive`);
        assert(!nativeBase.join("\n\n").includes(policy), "Workflow policy must come from the candidate hook");
      }
      assert.deepEqual(errors, [], "Managed Superkit native hooks failed");
      assert.equal(networkAttempts, 0);
    };
    const compose = async (prompt: string, base: string[], workflow: boolean, selected?: typeof workflows[number]) => {
      currentSystemPrompt = [...base];
      const result = await runner.emitBeforeAgentStart(prompt, undefined, [...base]);
      const blocks = result?.systemPrompt ?? base;
      currentSystemPrompt = blocks;
      check(blocks, workflow);
      const pointers = (result?.messages ?? []).flatMap(message =>
        typeof message === "object" && "customType" in message && message.customType === "omo-ultrawork:directive" ? [message] : []);
      assert.equal(pointers.length, selected ? 1 : 0, "Only an explicitly selected specialized SUPER invocation may add a workflow directive");
      if (selected) {
        const [command, legacyId] = selected;
        const skill = canonicalLayout ? command : legacyId;
        const path = skillPath(skill);
        const content = pointers[0]?.content;
        // In the canonical layout the path already contains the command name.
        // Check the invocation separately without prescribing pointer formatting.
        assert(typeof content === "string" && content.startsWith(`<omp-${legacyId}-pointer>`) && content.endsWith(`</omp-${legacyId}-pointer>`)
          && content.includes(path) && content.split(path).some(part => part.includes(command)),
          `SUPER directive must name /${command} and point to its installed ${skill} skill`);
      }
      return blocks;
    };
    // Fresh turns and recomposition must both retain exactly one preset. No
    // input event, command handler, session.prompt(), provider, or goal executes.
    const ordinary = "Inspect the requested implementation and report evidence.";
    for (let turn = 0; turn < 2; turn++) {
      await compose(ordinary, await compose(ordinary, nativeBase, false), false);
    }
    await compose(`> /super-plan Do not run the quoted task.\n${ordinary}`, nativeBase, false);
    assert.deepEqual(sessionManager.getBranch(), initialBranch, "Ordinary or quoted input must not arm workflow state");
    // Graph selects its specialized workflow without arming plain SUPER.
    await compose(`/super-graph ${ordinary}`, nativeBase, false, ["super-graph", "mass-ulw"]);
    assert.deepEqual(sessionManager.getBranch(), initialBranch, "SUPER graph selection must not arm plain SUPER state");
    for (let turn = 0; turn < 2; turn++) {
      const activated = `${turn === 0 ? "super" : "/super"} ${ordinary}`;
      await compose(activated, await compose(activated, nativeBase, true), true);
    }
    assert.deepEqual(sessionManager.getBranch().slice(initialBranch.length).flatMap(entry =>
      entry.type === "custom" && entry.customType === "omo-ultrawork:state" ? [entry.data] : []), [true],
      "Plain SUPER must arm exactly once under the existing native journal type");
    for (const selection of workflows) {
      await compose(`${selection[0]} ${ordinary}`, nativeBase, true, selection);
    }
    assert(sessionManager.getBranch().every(entry => entry.type !== "message"),
      "Workflow activation inspection must not create user/model messages");
    // An independent, unstarted SDK session proves native tools and skill://
    // resources without input, MCP/LSP, Python preflight, or a provider turn.
    const { session: resources, extensionsResult } = await createAgentSession({
      cwd: home, agentDir, settings, authStorage,
      modelRegistry: new ModelRegistry(authStorage, join(home, "models.yml"), { settings }),
      model, sessionManager: SessionManager.inMemory(home),
      additionalExtensionPaths: [packagePath], disableExtensionDiscovery: true,
      contextFiles: [], rules: [], promptTemplates: [], slashCommands: [],
      preloadedCustomToolPaths: [], toolNames: ["read", "task"],
      enableMCP: false, enableLsp: false, skipPythonPreflight: true,
    });
    const resourceReads: string[] = [];
    try {
      assert.deepEqual(extensionsResult.errors, [], "Published SDK rejected managed Superkit resources");
      assert.deepEqual(extensionsResult.extensions.filter(extension => !extension.path.startsWith("<inline-"))
        .map(extension => extension.resolvedPath), loaded.extensions.map(extension => extension.resolvedPath),
      "Resource inspection must load exactly the candidate modules, apart from SDK-owned inline factories");
      // Use the same native catalog as get_available_commands. A matching file
      // template or an extension with a mismatched descriptor is not routable.
      const commands = await buildAvailableSlashCommands(resources);
      for (const name of WORKFLOW_NAMES) {
        if (name !== "jevify") assert(advertisedWorkflow({ commands }, name),
          `Managed Superkit extension command /${name} is not advertised with its canonical descriptor`);
      }
      for (const name of ["ulw", ...workflows.map(([, skill]) => skill)]) {
        assert(commands.some(command => command.name === name && command.source === "extension"),
          `Managed Superkit legacy extension alias /${name} was not registered`);
      }
      assert(resources.getEnabledToolNames().includes("read"), "Native read must remain available");
      assert(resources.getEnabledToolNames().includes("task"), "Native task must remain available");
      const skills = resources.skills.filter(skill => skill.filePath.startsWith(packagePath + sep));
      for (const id of canonicalLayout ? [...canonicalSuperkitSkills, ...legacySuperkitSkills] : legacySuperkitSkills) {
        assert.equal(skills.find(skill => skill.name === id)?.filePath, skillPath(id),
          `Native Superkit skill discovery must retain skill://${id} and its installed path`);
      }
      const read = resources.getToolByName("read");
      assert(read, "Native read tool must be resolvable");
      for (const skill of skills) {
        const target = await realpath(skill.filePath);
        assert(target.startsWith(packagePath + sep), `Managed Superkit skill leaves its package: ${skill.name}`);
        const uri = `skill://${skill.name}:raw`;
        const output = await read.execute(`managed-ulw-resource-${resourceReads.length}`, { path: uri });
        const text = output.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n");
        assert.equal(text, await readFile(target, "utf8"), `Native resource differs from ${skill.filePath}`);
        resourceReads.push(uri);
      }
      assert.equal(resources.isStreaming, false);
      assert(!resources.sessionManager.getBranch().some(entry => entry.type === "message"),
        "Resource inspection must not activate a model turn");
      assert.equal(networkAttempts, 0);
    } finally { await resources.dispose(); }
    console.log(JSON.stringify({ extensions: loaded.extensions.length,
      compatibility: "published-sdk-prompt-composition", model: `${model.provider}/${model.id}`,
      ordinaryTurns: 2, activatedTurns: 2, tools: ["read", "task"], resourceReads,
      sessionPersistence: "memory", networkAttempts }));
  } finally {
    try {
      await runner.emit({ type: "session_shutdown" });
      assert.deepEqual(errors, [], "Managed Superkit native hooks failed");
      assert.equal(networkAttempts, 0);
    } finally {
      runner.clearManagedTimers();
      runner.disposeFileFallbacks();
    }
  }
} finally { authStorage.close(); }
process.exit(0);
