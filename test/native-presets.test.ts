import { afterAll, afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Effort } from "../.upstream/omp/packages/catalog/src/effort";
import type { Settings as NativeSettings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { LanePresetSnapshot } from "../src/contracts";
import type { NativeModel, NativePresetChoices } from "../src/native-presets";

// Settings capability discovery has process-wide native directory caches. Run
// the real suite in a fresh process whose HOME is private before native imports,
// not against the invoking user's settings, credential files, or project roots.
const workerRoot = process.env.OMP_NATIVE_PRESET_TEST_ROOT;
if (!workerRoot) {
  test("native preset manager uses isolated persisted native settings", async () => {
    const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "native-presets-"));
    try {
      const home = path.join(root, "home");
      await fs.mkdir(home, { recursive: true });
      const child = Bun.spawn({
        cmd: [process.execPath, "test", import.meta.path], cwd: root,
        env: { ...process.env, HOME: home, USERPROFILE: home,
          XDG_CONFIG_HOME: path.join(home, "config"), XDG_DATA_HOME: path.join(home, "data"),
          XDG_STATE_HOME: path.join(home, "state"), XDG_CACHE_HOME: path.join(home, "cache"),
          PI_CODING_AGENT_DIR: path.join(home, "agent"), PI_CONFIG_FILES: "", PI_PROFILE: "",
          CODEX_HOME: path.join(home, "codex"), CLAUDE_CONFIG_DIR: path.join(home, "claude"),
          COPILOT_HOME: path.join(home, "copilot"), OMP_NATIVE_PRESET_TEST_ROOT: root },
        stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      expect({ code, output: code === 0 ? "" : stdout + stderr }).toEqual({ code: 0, output: "" });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  }, 60_000);
} else {
  // Intentional module-loading boundary: static native imports would initialize
  // directory caches in the parent before the subprocess's private HOME exists.
  const { NativePresetManager } = await import("../src/native-presets");
  const { Settings } = await import("@oh-my-pi/pi-coding-agent/config/settings");
  const { cfgModelPresets } = await import("@oh-my-pi/pi-coding-agent/config/model-settings");
  const { getModelPreset, acquireModelRoleMutation } = await import("@oh-my-pi/pi-coding-agent/config/model-presets");
  const { resolveModelRoleValue, pickDefaultAvailableModel } = await import("@oh-my-pi/pi-coding-agent/config/model-resolver");
  const { cfgDefaultThinkingLevel } = await import("@oh-my-pi/pi-coding-agent/session/settings");
  const { AgentStorage } = await import("@oh-my-pi/pi-coding-agent/session/agent-storage");
  const { getBundledModel, getBundledModels, getBundledProviders } = await import("../.upstream/omp/packages/catalog/src/models");
  const sonnet = getBundledModel("anthropic", "claude-sonnet-4-5");
  const opus = getBundledModel("anthropic", "claude-opus-4-5");
  if (!sonnet || !opus) throw new Error("Required bundled native fixture models are absent");
  const models: NativeModel[] = [sonnet, opus];
  const selector = (model: NativeModel) => `${model.provider}/${model.id}`;
  const id = (model: NativeModel) => ({ provider: model.provider, id: model.id });
  const choice = (model = opus) => ({ model: id(model), reason: "Head selected this available native coding model after advisory review." });
  const configured = {
    modelRoles: { default: selector(sonnet), judge: `${selector(sonnet)}:low`, task: "@smol", smol: selector(sonnet) },
    defaultThinkingLevel: Effort.Medium,
    modelRoleStorage: "project",
    customFixture: { keep: "untouched" },
  };
  const fixtures: { root: string; settings: NativeSettings }[] = [];
  afterAll(() => AgentStorage.close());

  async function fixture(options: {
    global?: Record<string, unknown>; project?: Record<string, unknown>; overlay?: Record<string, unknown>;
    overrides?: Record<string, unknown>; pool?: NativeModel[];
  } = {}) {
    const root = await fs.mkdtemp(path.join(workerRoot!, "case-"));
    const agent = path.join(root, "agent");
    const cwd = path.join(root, "project");
    await fs.mkdir(agent, { recursive: true });
    await fs.mkdir(path.join(cwd, ".omp"), { recursive: true });
    const configPath = path.join(agent, "config.yml");
    const modelsPath = path.join(agent, "models.yml");
    const projectPath = path.join(cwd, ".omp", "config.yml");
    await fs.writeFile(configPath, JSON.stringify({ ...configured, ...options.global }, null, 2) + "\n");
    await fs.writeFile(modelsPath, "# Native model definitions must never be touched\nproviders: {}\n");
    await fs.writeFile(projectPath, JSON.stringify(options.project ?? {}) + "\n");
    const configFiles: string[] = [];
    if (options.overlay) {
      const overlay = path.join(root, "overlay.yml");
      await fs.writeFile(overlay, JSON.stringify(options.overlay));
      configFiles.push(overlay);
    }
    const settings = await Settings.loadIsolated({ cwd, agentDir: agent, configFiles, overrides: options.overrides });
    fixtures.push({ root, settings });
    const manager = new NativePresetManager(settings, async () => options.pool ?? models, () => true);
    const bytes = () => Promise.all([configPath, modelsPath, projectPath].map(file => fs.readFile(file, "utf8")));
    const persisted = async () => Bun.YAML.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>;
    return { root, agent, cwd, configPath, settings, manager, bytes, persisted };
  }

  afterEach(async () => {
    for (const { root, settings } of fixtures.splice(0)) {
      settings.cancelPendingSaves();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("initialization writes only missing named native entries and is byte-idempotent", async () => {
    const high: LanePresetSnapshot = { modelRoles: { default: selector(sonnet), judge: "@smol" }, defaultThinkingLevel: Effort.Minimal };
    const other: LanePresetSnapshot = { modelRoles: { default: selector(opus) } };
    const f = await fixture({ global: { modelPresets: { high, other } } });
    const before = await f.persisted();
    const beforeBytes = await f.bytes();
    const activeRoles = (await f.manager.inspect()).settings.modelRoles;
    const first = await f.manager.initialize({ high: choice(), middle: choice(), low: choice(sonnet) });
    expect(first.created).toEqual(["middle", "low"]);
    expect(first.preserved).toEqual(["high"]);
    expect(first.conflicts).toEqual([]);
    const after = await f.persisted();
    const { modelPresets: _beforePresets, ...beforeRest } = before;
    const { modelPresets: _afterPresets, ...afterRest } = after;
    expect(afterRest).toEqual(beforeRest);
    expect(after.modelPresets).toEqual({ high, other,
      middle: { modelRoles: { ...activeRoles, default: selector(opus) }, defaultThinkingLevel: Effort.Medium },
      low: { modelRoles: { ...activeRoles, default: selector(sonnet) }, defaultThinkingLevel: Effort.Medium },
    });
    expect(f.settings.getModelRoles()).toEqual(activeRoles);
    expect(cfgDefaultThinkingLevel.get(f.settings)).toBe(Effort.Medium);
    expect((await f.bytes()).slice(1)).toEqual(beforeBytes.slice(1));
    const authoritative = await Settings.loadIsolated({ cwd: f.cwd, agentDir: f.agent });
    fixtures.push({ root: path.join(f.root, "unused"), settings: authoritative });
    expect(getModelPreset(authoritative, "middle")).toEqual({ kind: "found",
      preset: { modelRoles: { ...activeRoles, default: selector(opus) }, defaultThinkingLevel: Effort.Medium } });
    const stable = await f.bytes();
    const second = await f.manager.initialize({ high: choice(), middle: choice(sonnet), low: choice() });
    expect(second.created).toEqual([]);
    expect(second.preserved).toEqual(["high", "middle", "low"]);
    expect(await f.bytes()).toEqual(stable);
    expect(JSON.stringify(after)).not.toContain(choice().reason);
  });

  test("all supplied candidates validate before any writes", async () => {
    const runner = getBundledProviders().flatMap(provider => getBundledModels(provider))
      .find(model => model.kind !== undefined && model.kind !== "chat");
    if (!runner) throw new Error("Required native non-chat fixture is absent");
    const f = await fixture({ pool: [...models, runner] });
    const before = await f.bytes();
    const invalids: unknown[] = [null, [], {}, { surprise: choice() }, { high: { ...choice(), reason: " " } },
      { high: { ...choice(), model: { provider: "anthropic" } } },
      { high: { ...choice(), model: { provider: "", id: opus.id } } },
      { high: choice(), middle: { ...choice(), model: { provider: "missing", id: "not-authorized" } } },
      { high: choice(), low: choice(runner) }];
    for (const input of invalids) {
      await expect(f.manager.initialize(input as NativePresetChoices)).rejects.toThrow();
      expect(await f.bytes()).toEqual(before);
    }
  });

  test("invalid, disabled, and globally hidden names are preserved rather than repaired", async () => {
    const hidden = { modelRoles: { default: selector(sonnet) } };
    const f = await fixture({
      global: { modelPresets: { high: hidden, middle: { modelRoles: [] }, low: hidden, other: hidden } },
      overlay: { modelPresets: { high: null, low: { modelRoles: { default: 42 } } } },
    });
    const before = await f.bytes();
    const inspected = await f.manager.inspect();
    expect(inspected.bootstrap).toEqual({ missing: [], blocked: ["high", "middle", "low"] });
    expect(inspected.presets.find(p => p.name === "high")).toMatchObject({ status: "disabled", source: "overlay", globalEntry: true });
    expect(inspected.presets.find(p => p.name === "middle")).toMatchObject({ status: "invalid", source: "global" });
    expect(inspected.presets.find(p => p.name === "low")).toMatchObject({ status: "invalid", source: "overlay" });
    const result = await f.manager.initialize({ high: choice(), middle: choice(), low: choice() });
    expect(result.created).toEqual([]);
    expect(result.preserved).toEqual(["high", "middle", "low"]);
    expect(result.conflicts).toEqual(["high", "middle", "low"]);
    await expect(f.manager.resolve("high")).rejects.toThrow("missing");
    await expect(f.manager.resolve("middle")).rejects.toThrow("invalid");
    expect(await f.bytes()).toEqual(before);
  });

  test("project and runtime whole presets do not inherit same-name global roles or thinking", async () => {
    const f = await fixture({
      global: { modelPresets: { high: { modelRoles: { default: selector(opus), judge: "@smol" }, defaultThinkingLevel: Effort.High } } },
      project: { modelRoles: { judge: `${selector(opus)}:low` },
        modelPresets: { high: { modelRoles: { default: selector(sonnet) } } } },
      overrides: { modelPresets: { middle: null, low: { modelRoles: { default: selector(opus) }, defaultThinkingLevel: Effort.Minimal } } },
    });
    const before = await f.bytes();
    const inspect = await f.manager.inspect();
    expect(inspect.presets.find(p => p.name === "high")).toMatchObject({ source: "project", modelRoles: { default: selector(sonnet) } });
    expect(inspect.presets.find(p => p.name === "high")?.defaultThinkingLevel).toBeUndefined();
    expect(inspect.presets.find(p => p.name === "middle")).toMatchObject({ status: "disabled", source: "runtime", globalEntry: false });
    const frozen = await f.manager.resolve("high");
    expect(frozen.snapshot.modelRoles).toEqual({ default: selector(sonnet) });
    expect(frozen.snapshot.defaultThinkingLevel).toBe(Effort.Medium);
    expect((await f.manager.resolve("low")).snapshot.defaultThinkingLevel).toBe(Effort.Minimal);
    expect(await f.bytes()).toEqual(before);
    cfgDefaultThinkingLevel.set(f.settings, Effort.Minimal);
    await f.settings.flush();
    expect(frozen.snapshot.defaultThinkingLevel).toBe(Effort.Medium);
    expect((await f.manager.resolve("high")).snapshot.defaultThinkingLevel).toBe(Effort.Minimal);
  });

  test("bootstrap snapshots effective native policy without activating it", async () => {
    const f = await fixture({
      project: { modelRoles: { judge: `${selector(opus)}:low`, plan: "@slow" } },
      overlay: { defaultThinkingLevel: Effort.Minimal, modelRoles: { slow: selector(opus) } },
      overrides: { modelRoles: { smol: `${selector(sonnet)}:minimal` } },
    });
    const roles = (await f.manager.inspect()).settings.modelRoles;
    const before = await f.bytes();
    const initialized = await f.manager.initialize({ low: choice(opus) });
    expect(initialized.created).toEqual(["low"]);
    expect(getModelPreset(f.settings, "low")).toEqual({ kind: "found", preset: {
      modelRoles: { ...roles, default: selector(opus) }, defaultThinkingLevel: Effort.Minimal } });
    expect(f.settings.getModelRoles()).toEqual(roles);
    expect(f.settings.getModelRole("default")).toBe(selector(sonnet));
    expect(cfgDefaultThinkingLevel.get(f.settings)).toBe(Effort.Minimal);
    expect((await f.bytes()).slice(1)).toEqual(before.slice(1));
    const persisted = await f.persisted();
    expect(persisted.modelRoles).toEqual(configured.modelRoles);
    expect(persisted.defaultThinkingLevel).toBe(configured.defaultThinkingLevel);
  });

  test("role selectors and thinking suffixes resolve natively and freeze the chosen default", async () => {
    const presets: Record<string, LanePresetSnapshot> = {
      high: { modelRoles: { default: `@slow:${Effort.Medium}`, slow: selector(opus), judge: "@smol", task: "@slow" }, defaultThinkingLevel: Effort.Low },
      automatic: { modelRoles: { judge: selector(sonnet) }, defaultThinkingLevel: Effort.Minimal },
      autoThinking: { modelRoles: { default: `${selector(opus)}:auto` }, defaultThinkingLevel: Effort.Low },
      maximum: { modelRoles: { default: `${selector(opus)}:${Effort.Max}` }, defaultThinkingLevel: Effort.Low },
    };
    const f = await fixture({ global: { modelPresets: presets } });
    const before = await f.bytes();
    for (const name of ["high", "autoThinking", "maximum"] as const) {
      const original = presets[name]!;
      const expected = resolveModelRoleValue(original.modelRoles.default, models, {
        settings: f.settings, roleLookup: { getModelRole: role => original.modelRoles[role] ?? f.settings.getModelRole(role) },
      });
      expect(expected.model).toBeDefined();
      const resolved = await f.manager.resolve(name);
      const frozen = resolveModelRoleValue(resolved.snapshot.modelRoles.default, models, { settings: f.settings });
      expect(resolved.model).toEqual(id(expected.model!));
      expect(frozen.model?.id).toBe(expected.model?.id);
      expect(frozen.thinkingLevel).toBe(expected.thinkingLevel);
      expect(resolved.snapshot.defaultThinkingLevel).toBe(Effort.Low);
      expect(resolved.snapshot.modelRoles).toEqual({ ...original.modelRoles, default: resolved.snapshot.modelRoles.default });
    }
    const automatic = await f.manager.resolve("automatic");
    expect(automatic.model).toEqual(id(pickDefaultAvailableModel(models, () => true)!));
    expect(automatic.snapshot.modelRoles.default).toBe(`${automatic.model.provider}/${automatic.model.id}`);
    expect(await f.bytes()).toEqual(before);
    const frozen = await f.manager.resolve("high");
    cfgModelPresets.setEntry(f.settings, "high", { modelRoles: { default: selector(sonnet), slow: selector(sonnet) }, defaultThinkingLevel: Effort.Minimal });
    await f.settings.flush();
    expect((await f.manager.resolve("high")).model).toEqual(id(sonnet));
    expect(frozen.model).toEqual(id(opus));
    expect(frozen.snapshot.modelRoles.default).toBe(`${selector(opus)}:${Effort.Medium}`);
    expect(frozen.snapshot.modelRoles.slow).toBe(selector(opus));
    expect(frozen.snapshot.defaultThinkingLevel).toBe(Effort.Low);
  });

  test("inspection follows shared chat eligibility without leaking connection data", async () => {
    const unavailable = { modelRoles: { default: "missing/model" } };
    const f = await fixture({ global: { modelPresets: { high: unavailable, middle: { modelRoles: { default: selector(opus) } } } },
      pool: [sonnet, { ...opus, supportsTools: false, input: [] }] });
    const before = await f.bytes();
    const result = await f.manager.inspect();
    expect(result.availableModels).toEqual([id(sonnet), id(opus)]);
    expect(result.presets.find(p => p.name === "high")).toMatchObject({ status: "valid", available: false });
    await expect(f.manager.resolve("high")).rejects.toThrow("authorized coding-model pool");
    expect((await f.manager.resolve("middle")).model).toEqual(id(opus));
    await expect(f.manager.resolve("../invalid")).rejects.toThrow("Invalid native preset name");
    const serialized = JSON.stringify(result);
    for (const key of ["baseUrl", "headers", "apiKey", "Authorization"]) expect(serialized).not.toContain(key);
    expect(await f.bytes()).toEqual(before);
  });

  test("automatic native fallback honors concrete-provider preference and refuses an empty coding pool", async () => {
    const openai = getBundledModels("openai").find(model =>
      model.kind === undefined || model.kind === "chat");
    if (!openai) throw new Error("Required native second-provider fixture is absent");
    const f = await fixture({ global: { modelPresets: { high: { modelRoles: {} } } } });
    const pool = [sonnet, openai];
    const concrete = (provider: string) => provider === openai.provider;
    const manager = new NativePresetManager(f.settings, async () => pool, concrete);
    expect((await manager.resolve("high")).model).toEqual(id(pickDefaultAvailableModel(pool, concrete)!));
    const empty = new NativePresetManager(f.settings, async () => [], () => false);
    const before = await f.bytes();
    expect((await empty.inspect()).presets.find(p => p.name === "high")).toMatchObject({ available: false });
    await expect(empty.resolve("high")).rejects.toThrow("No authorized coding model");
    await expect(empty.initialize({ low: choice() })).rejects.toThrow("authorized coding model");
    expect(await f.bytes()).toEqual(before);
    await expect(manager.initialize({})).rejects.toThrow("nonempty mapping");
    expect(await f.bytes()).toEqual(before);
  });

  test("serialized initializers preserve a native concurrent preset and unrelated field changes", async () => {
    const f = await fixture();
    const native = await Settings.loadIsolated({ cwd: f.cwd, agentDir: f.agent });
    fixtures.push({ root: path.join(f.root, "unused"), settings: native });
    const release = await acquireModelRoleMutation();
    const initializing = f.manager.initialize({ high: choice(), middle: choice() });
    try {
      cfgModelPresets.setEntry(native, "high", { modelRoles: { default: selector(sonnet) }, defaultThinkingLevel: Effort.Minimal });
      cfgModelPresets.setEntry(native, "operator", { modelRoles: { default: selector(sonnet) } });
      await native.flush();
    } finally { release(); }
    const result = await initializing;
    expect(result.created).toEqual(["middle"]);
    expect(result.preserved).toEqual(["high"]);
    expect(getModelPreset(f.settings, "high")).toEqual({ kind: "found", preset: {
      modelRoles: { default: selector(sonnet) }, defaultThinkingLevel: Effort.Minimal } });
    expect(getModelPreset(f.settings, "operator").kind).toBe("found");
    const [first, second] = await Promise.all([
      f.manager.initialize({ low: choice() }), f.manager.initialize({ low: choice(sonnet) }),
    ]);
    expect(first.created).toEqual(["low"]);
    expect(second.created).toEqual([]);
    expect(second.preserved).toEqual(["low"]);
    expect((await f.manager.resolve("low")).model).toEqual(id(opus));
  });

  test("native conditional creation preserves an operator insertion after manager reload", async () => {
    const f = await fixture();
    const operator = await Settings.loadIsolated({ cwd: f.cwd, agentDir: f.agent });
    fixtures.push({ root: path.join(f.root, "unused"), settings: operator });
    const inserted: LanePresetSnapshot = { modelRoles: { default: selector(sonnet) }, defaultThinkingLevel: Effort.Minimal };
    let insert = true;
    const racing = new NativePresetManager(f.settings, async () => {
      if (insert) {
        insert = false;
        // A separate persisted native instance changes the file after the
        // manager's reload, before bootstrap stages any named mutation.
        cfgModelPresets.setEntry(operator, "high", inserted);
        cfgModelPresets.setEntry(operator, "operator", inserted);
        await operator.flush();
      }
      return models;
    }, () => true);
    const result = await racing.initialize({ high: choice(opus), middle: choice(opus) });
    expect(result.created).toEqual(["middle"]);
    expect(result.conflicts).toEqual(["high"]);
    expect(result.inspection.presets.find(p => p.name === "high")).toMatchObject({
      status: "valid", source: "global", modelRoles: inserted.modelRoles, defaultThinkingLevel: Effort.Minimal,
    });
    expect(getModelPreset(f.settings, "high")).toEqual({ kind: "found", preset: inserted });
    expect(getModelPreset(f.settings, "operator")).toEqual({ kind: "found", preset: inserted });
    expect((await racing.resolve("middle")).model).toEqual(id(opus));
  });
}
