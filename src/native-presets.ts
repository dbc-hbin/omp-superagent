import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { getProjectAgentDir, MAIN_CONFIG_FILENAMES, normalizePathForComparison } from "@oh-my-pi/pi-utils/dirs";
import { IsStandardObject as isRecord } from "@sinclair/typebox/value";
import { acquireModelRoleMutation, getModelPreset, getModelPresetNames, isValidModelPresetName } from "@oh-my-pi/pi-coding-agent/config/model-presets";
import { pickDefaultAvailableModel, resolveModelRoleValue } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import type { Settings, SettingsMirrorState } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgDefaultThinkingLevel } from "@oh-my-pi/pi-coding-agent/session/settings";
import { MODEL_PRESET_NAMES, type LaneModel, type LanePresetSnapshot, type ResolvedLanePreset, type StorePort } from "./contracts";
import { isLaneModel, sameLaneModel } from "./lane-models";
import { editNativeGlobalConfig, hasUnresolvedNativeLegacy, readNativeSettings } from "./native-settings";

export type NativeModel = Awaited<ReturnType<ExtensionContext["models"]["list"]>>[number];
export type BootstrapName = (typeof MODEL_PRESET_NAMES)[number];
export type PresetSyncOutcome = "applied" | "deferred";
type PresetSource = "runtime" | "overlay" | "project" | "global";
export type NativePresetChoices = Partial<Record<BootstrapName, { model: LaneModel; reason: string }>>;
const followingRoles = { high: "slow", middle: "default", low: "smol" } as const;
const followedPresets = "head:role-following-presets";
type FollowedPreset = { readonly preset: LanePresetSnapshot; readonly roles?: string };
type PresetOwnership = Partial<Record<BootstrapName, FollowedPreset | null>>;

export interface NativePresetStatus {
  name: string;
  status: "valid" | "invalid" | "missing" | "disabled";
  source?: PresetSource;
  reason?: string;
  /** A hidden global entry also prevents initialization from replacing it. */
  globalEntry: boolean;
  available: boolean;
  resolvedDefault?: LaneModel;
  modelRoles?: Record<string, string>;
  defaultThinkingLevel?: LanePresetSnapshot["defaultThinkingLevel"];
}

export interface NativePresetInspection {
  settings: LanePresetSnapshot;
  configuredDefault: { available: boolean; resolvedDefault?: LaneModel; reason?: string };
  availableModels: LaneModel[];
  presets: NativePresetStatus[];
  bootstrap: { missing: BootstrapName[]; blocked: BootstrapName[] };
}

function isCodingModel(model: NativeModel): boolean {
  return isLaneModel(model) && (model.kind === undefined || model.kind === "chat");
}

/** Native getOwnedModelPreset hides tombstones, so inspect just their ownership, not their payload. */
function disabledSource(state: SettingsMirrorState, name: string): PresetSource | undefined {
  for (const [source, layer] of [["runtime", state.overrides], ["overlay", state.configOverlay]] as const) {
    if (!Object.hasOwn(layer, "modelPresets")) continue;
    const presets = layer.modelPresets;
    if (isRecord(presets) && Object.hasOwn(presets, name)) {
      return presets[name] === null || presets[name] === undefined ? source : undefined;
    }
  }
  return undefined;
}

/** Native settings are the sole registry. No active role is changed to inspect or resolve a preset. */
export class NativePresetManager {
  private readonly source: Settings;

  constructor(
    private settings: Settings,
    private readonly availableModels: () => Promise<NativeModel[]>,
    private readonly hasConcreteAuth: (provider: string) => boolean,
  ) {
    if (settings.overlayParent() || settings.mirrorState().derived) {
      throw new Error("Native presets require the persistent native base settings");
    }
    this.source = settings;
  }

  watchedPaths(): string[] {
    const agentDir = this.settings.getAgentDir();
    const paths = [
      ...MAIN_CONFIG_FILENAMES.map(filename => join(agentDir, filename)),
      join(agentDir, "settings.json"),
    ];
    const cwd = resolve(this.settings.getCwd());
    if (normalizePathForComparison(cwd) !== normalizePathForComparison(homedir())) {
      const projectDir = getProjectAgentDir(cwd);
      paths.push(
        ...MAIN_CONFIG_FILENAMES.map(filename => join(projectDir, filename)),
        join(projectDir, "settings.json"),
      );
    }
    paths.push(...this.settings.getConfigFiles());
    return [...new Set(paths)];
  }

  private async reload(): Promise<void> {
    await this.source.reloadFromDisk();
    this.settings = await readNativeSettings(this.source);
    if (await hasUnresolvedNativeLegacy(this.settings.getAgentDir())) {
      throw new Error("Native global settings require legacy migration");
    }
  }

  private capture(): LanePresetSnapshot {
    return {
      modelRoles: Object.fromEntries(Object.entries(this.settings.getModelRoles())
        .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0)),
      defaultThinkingLevel: cfgDefaultThinkingLevel.get(this.settings),
    };
  }

  private freeze(
    name: string, preset: LanePresetSnapshot, models: NativeModel[],
    thinkingContext?: Pick<LanePresetSnapshot, "defaultThinkingLevel">,
  ): ResolvedLanePreset {
    const selector = preset.modelRoles.default;
    const resolved = selector ? resolveModelRoleValue(selector, models, {
      settings: this.settings,
      // Native preset application resolves aliases against the whole preset first,
      // falling through to configured roles only when that role is absent.
      roleLookup: {
        getModelRole: role => Object.hasOwn(preset.modelRoles, role)
          ? preset.modelRoles[role] : this.settings.getModelRole(role),
      },
    }) : undefined;
    const model = selector ? resolved?.model : pickDefaultAvailableModel(models, this.hasConcreteAuth);
    if (!model) throw new Error(selector
      ? `Default model selector for native preset "${name}" is not available in the authorized coding-model pool`
      : `No authorized coding model is available for native preset "${name}"`);
    // Keep the preset's thinking policy intact. An explicit selector effort wins
    // over that policy in native OMP, so retain its resolved equivalent as a suffix.
    const suffix = resolved?.explicitThinkingLevel && resolved.thinkingLevel !== undefined
      ? `:${resolved.thinkingLevel}` : "";
    const snapshot: LanePresetSnapshot = {
      ...preset,
      modelRoles: { ...preset.modelRoles, default: `${model.provider}/${model.id}${suffix}` },
      // Native omission keeps the current level. A supplied HEAD context owns
      // that policy even when undefined; lanes freeze the persistent base now
      // rather than reading a changed level when the lane is reopened.
      defaultThinkingLevel: preset.defaultThinkingLevel ?? (thinkingContext !== undefined
        ? thinkingContext.defaultThinkingLevel : cfgDefaultThinkingLevel.get(this.settings)),
    };
    return { preset: name, model: { provider: model.provider, id: model.id }, snapshot };
  }

  private inspectLoaded(models: NativeModel[]): NativePresetInspection {
    const state = this.settings.mirrorState();
    const names = new Set<string>([...MODEL_PRESET_NAMES, ...getModelPresetNames(this.settings)]);
    for (const layer of [state.global, state.project, state.configOverlay, state.overrides]) {
      if (isRecord(layer.modelPresets)) for (const name of Object.keys(layer.modelPresets)) names.add(name);
    }
    const presets: NativePresetStatus[] = [...names].sort().map(name => {
      const globalEntry = isRecord(state.global.modelPresets) && Object.hasOwn(state.global.modelPresets, name);
      const disabled = disabledSource(state, name);
      if (disabled) return { name, status: "disabled", source: disabled, globalEntry, available: false };
      const lookup = getModelPreset(this.settings, name);
      const source = this.settings.getOwnedModelPreset(name)?.source;
      if (lookup.kind === "missing") {
        return { name, status: "missing", globalEntry, available: false,
          ...(globalEntry ? { reason: "A global entry already owns this name" } : {}) };
      }
      if (lookup.kind === "invalid") {
        return { name, status: "invalid", source, globalEntry, available: false, reason: lookup.reason };
      }
      const status: NativePresetStatus = { name, status: "valid", source, globalEntry,
        modelRoles: { ...lookup.preset.modelRoles }, available: false,
        ...(lookup.preset.defaultThinkingLevel !== undefined
          ? { defaultThinkingLevel: lookup.preset.defaultThinkingLevel } : {}) };
      try { status.resolvedDefault = this.freeze(name, lookup.preset, models).model; status.available = true; }
      catch (error) { status.reason = (error as Error).message; }
      return status;
    });
    const settings = this.capture();
    let configuredDefault: NativePresetInspection["configuredDefault"];
    try { configuredDefault = { available: true, resolvedDefault: this.freeze("configured default", settings, models).model }; }
    catch (error) { configuredDefault = { available: false, reason: (error as Error).message }; }
    return {
      settings, configuredDefault, availableModels: models.map(model => ({ provider: model.provider, id: model.id })), presets,
      bootstrap: {
        missing: MODEL_PRESET_NAMES.filter(name => presets.some(p => p.name === name && p.status === "missing" && !p.globalEntry)),
        blocked: MODEL_PRESET_NAMES.filter(name => presets.some(p => p.name === name &&
          (p.status === "disabled" || p.status === "invalid" || (p.status === "missing" && p.globalEntry)))),
      },
    };
  }

  async inspect(): Promise<NativePresetInspection> {
    await this.reload();
    return this.inspectLoaded((await this.availableModels()).filter(isCodingModel));
  }

  /** Follow persistent native roles without changing the active native session. */
  async syncRoles(store: Pick<StorePort, "getMeta" | "setMeta">, canWrite: () => boolean,
    reloadCatalog?: () => Promise<void>): Promise<PresetSyncOutcome> {
    const release = await acquireModelRoleMutation();
    try {
      await this.reload();
      if (!canWrite()) return "deferred";
      const settings = this.settings;
      const base = this.capture();
      const before = store.getMeta(followedPresets);
      const ownership: PresetOwnership = before === null ? {} : JSON.parse(before);
      const resolveRoles = (models: NativeModel[]) => MODEL_PRESET_NAMES.map(name => {
        const selector = base.modelRoles[followingRoles[name]];
        const resolution = selector ? resolveModelRoleValue(selector, models, { settings }) : undefined;
        const model = resolution?.model;
        const defaultSelector = model ? `${model.provider}/${model.id}${
          resolution?.explicitThinkingLevel && resolution.thinkingLevel !== undefined ? `:${resolution.thinkingLevel}` : ""}` : null;
        return { name, selector, model, defaultSelector };
      });
      let models = (await this.availableModels()).filter(isCodingModel);
      let resolved = resolveRoles(models);
      if (reloadCatalog && canWrite() && resolved.some(({ selector, model }) => selector && !model)) {
        // Another OMP process may have discovered the new model after this
        // head loaded its registry. Read through the native cache, not the network.
        await reloadCatalog();
        models = (await this.availableModels()).filter(isCodingModel);
        resolved = resolveRoles(models);
      }
      const roles = JSON.stringify(resolved.map(({ selector, defaultSelector }) => [selector ?? null, defaultSelector]));
      // A temporarily unavailable configured role is not a new policy.
      if (resolved.some(({ selector, defaultSelector }) => selector && !defaultSelector)) return "deferred";
      const edits: { name: BootstrapName; snapshot: LanePresetSnapshot }[] = [];
      for (const { name, model, defaultSelector } of resolved) {
        if (!canWrite()) return "deferred";
        const tracked = ownership[name];
        if (tracked === null) continue; // A manual edit/deletion releases management.
        const owned = settings.getOwnedModelPreset(name);
        const current = getModelPreset(settings, name);
        if (!owned || owned.source !== "global" || current.kind !== "found") {
          if (tracked && !owned && !disabledSource(settings.mirrorState(), name)) ownership[name] = null;
          continue;
        }
        const preset = current.preset;
        if (tracked && !Bun.deepEquals(preset, tracked.preset)) {
          ownership[name] = null;
          continue;
        }
        if (!model || !defaultSelector) continue;
        if (!tracked) {
          // Adopt only an earlier full role snapshot that already selects this
          // role's model. An unrelated/manual preset is not ours to replace.
          const { default: _old, ...oldRoles } = preset.modelRoles;
          const { default: _base, ...baseRoles } = base.modelRoles;
          const old = resolveModelRoleValue(preset.modelRoles.default, models, { settings });
          if (!Bun.deepEquals(oldRoles, baseRoles) || !sameLaneModel(old?.model, model)) continue;
          ownership[name] = { preset, roles };
          continue;
        }
        if (tracked.roles === roles) continue;
        const next = { ...base, modelRoles: { ...base.modelRoles, default: defaultSelector } };
        if (Bun.deepEquals(preset, next)) ownership[name] = { preset, roles };
        else edits.push({ name, snapshot: next });
      }
      let deferred = false;
      if (edits.length) {
        const applied = await editNativeGlobalConfig(settings, edits.map(({ name, snapshot }) => ({
          path: `modelPresets.${name}`, value: snapshot,
        })), actual => canWrite() && edits.every(({ name }) => actual.getOwnedModelPreset(name)?.source === "global")
          && Bun.deepEquals(actual.getModelRoles(), base.modelRoles)
          && cfgDefaultThinkingLevel.get(actual) === base.defaultThinkingLevel);
        for (const [index, { name, snapshot }] of edits.entries()) {
          if (applied[index]) ownership[name] = { preset: snapshot, roles };
          else deferred = true;
        }
      }
      const saved = JSON.stringify(ownership);
      if (saved !== (before ?? "{}")) store.setMeta(followedPresets, saved);
      return deferred ? "deferred" : "applied";
    } finally { release(); }
  }

  async resolve(name: string, thinkingContext?: Pick<LanePresetSnapshot, "defaultThinkingLevel">): Promise<ResolvedLanePreset> {
    if (typeof name !== "string" || !isValidModelPresetName(name)) throw new Error("Invalid native preset name");
    await this.reload();
    const lookup = getModelPreset(this.settings, name);
    if (lookup.kind !== "found") throw new Error(`Native preset "${name}" is ${lookup.kind}`);
    return this.freeze(name, lookup.preset, (await this.availableModels()).filter(isCodingModel), thinkingContext);
  }

  /**
   * Persist the frozen snapshot only after the head has successfully applied it.
   * Global defaults are replaced in full, independent of modelRoleStorage; named
   * presets and higher-priority project/overlay/runtime settings stay untouched.
   * Those layers can still shadow these defaults in other sessions. A failed
   * save/readback is reported without rolling back the successful head selection.
   */
  async persistSelection(selection: ResolvedLanePreset): Promise<LanePresetSnapshot> {
    const expected: LanePresetSnapshot = {
      modelRoles: { ...selection.snapshot.modelRoles },
      ...(selection.snapshot.defaultThinkingLevel !== undefined
        ? { defaultThinkingLevel: selection.snapshot.defaultThinkingLevel } : {}),
    };
    const release = await acquireModelRoleMutation();
    try {
      await this.reload();
      const validation = getModelPreset(this.settings.overlay({ modelPresets: { selection: expected } }), "selection");
      if (validation.kind !== "found") throw new Error("Invalid native model selection snapshot");
      // Explicit global authorization replaces this record, not the host's
      // active model scope or any project/overlay/runtime assignment.
      await editNativeGlobalConfig(this.settings, [
        { path: "modelRoles", value: expected.modelRoles },
        { path: "defaultThinkingLevel", value: expected.defaultThinkingLevel },
      ]);
      await this.reload();
      const global = this.settings.getGlobalSettings();
      const persisted = {
        modelRoles: global.modelRoles,
        ...(global.defaultThinkingLevel !== undefined
          ? { defaultThinkingLevel: global.defaultThinkingLevel } : {}),
      };
      if (!Bun.deepEquals(persisted, expected)) {
        throw new Error("Global model defaults do not match the applied preset after native readback");
      }
      return persisted as LanePresetSnapshot;
    } finally { release(); }
  }

  /**
   * Application conditional creation checks absence under the native persistence
   * lock, so an operator insertion after preview is preserved. This is not a
   * multi-entry transaction: partial creation and conflicts are read back, never
   * repaired by overwriting or rolling back the operator's entry.
   */
  async initialize(choices: NativePresetChoices, store?: Pick<StorePort, "getMeta" | "setMeta">): Promise<{
    created: BootstrapName[]; preserved: BootstrapName[]; conflicts: BootstrapName[]; inspection: NativePresetInspection;
  }> {
    if (!isRecord(choices) || Object.keys(choices).length === 0) {
      throw new Error("Native preset choices must be a nonempty mapping");
    }
    for (const [name, choice] of Object.entries(choices)) {
      if (!(MODEL_PRESET_NAMES as readonly string[]).includes(name) || !isRecord(choice) ||
          !isRecord(choice.model) || typeof choice.model.provider !== "string" || !choice.model.provider.trim() ||
          typeof choice.model.id !== "string" || !choice.model.id.trim() ||
          typeof choice.reason !== "string" || !choice.reason.trim()) {
        throw new Error("Each native bootstrap choice requires high/middle/low, an exact model identity, and a reason");
      }
    }
    const release = await acquireModelRoleMutation();
    try {
      await this.reload();
      // Validate every supplied candidate before any writes, including choices
      // whose existing preset will be preserved rather than replaced.
      const models = (await this.availableModels()).filter(isCodingModel);
      for (const name of MODEL_PRESET_NAMES) {
        const choice = choices[name];
        if (!choice) continue;
        if (!models.some(model => model.provider === choice.model.provider && model.id === choice.model.id)) {
          throw new Error("Native bootstrap choice is not an available authorized coding model");
        }
      }
      const before = this.inspectLoaded(models);
      const expected = new Map<BootstrapName, LanePresetSnapshot>();
      const preserved: BootstrapName[] = [];
      const conflicts: BootstrapName[] = [];
      const configured = before.settings;
      for (const name of MODEL_PRESET_NAMES) {
        const choice = choices[name];
        if (!choice) continue;
        if (!before.bootstrap.missing.includes(name)) {
          preserved.push(name);
          if (before.bootstrap.blocked.includes(name)) conflicts.push(name);
          continue;
        }
        expected.set(name, { ...configured, modelRoles: { ...configured.modelRoles,
          default: `${choice.model.provider}/${choice.model.id}` } });
      }
      const staged = new Set<BootstrapName>();
      for (const [name, snapshot] of expected) {
        const [created] = await editNativeGlobalConfig(this.settings, [
          { path: `modelPresets.${name}`, value: snapshot, ifMissing: true },
        ]);
        if (created) staged.add(name);
        else conflicts.push(name);
      }
      if (expected.size > 0) {
        await this.reload();
      }
      const created: BootstrapName[] = [];
      for (const [name, snapshot] of expected) {
        if (!staged.has(name)) continue;
        const lookup = getModelPreset(this.settings, name);
        const global = this.settings.getGlobalSettings().modelPresets;
        if (lookup.kind === "found" && this.settings.getOwnedModelPreset(name)?.source === "global" &&
            isRecord(global) && Bun.deepEquals(global[name], snapshot)) created.push(name);
        else conflicts.push(name);
      }
      if (store && created.length) {
        const ownership: PresetOwnership = JSON.parse(store.getMeta(followedPresets) ?? "{}");
        for (const name of created) {
          const preset = expected.get(name);
          if (preset) ownership[name] = { preset };
        }
        store.setMeta(followedPresets, JSON.stringify(ownership));
      }
      return { created, preserved, conflicts, inspection: this.inspectLoaded(models) };
    } finally { release(); }
  }
}
