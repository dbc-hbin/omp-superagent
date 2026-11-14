import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { IsStandardObject as isRecord } from "@sinclair/typebox/value";
import { acquireModelRoleMutation, captureModelPreset, createModelPresetIfMissing, getModelPreset, getModelPresetNames, isValidModelPresetName } from "@oh-my-pi/pi-coding-agent/config/model-presets";
import { pickDefaultAvailableModel, resolveModelRoleValue } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { cfgModelRoles } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import type { Settings, SettingsMirrorState } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgDefaultThinkingLevel } from "@oh-my-pi/pi-coding-agent/session/settings";
import { MODEL_PRESET_NAMES, type LaneModel, type LanePresetSnapshot, type ResolvedLanePreset } from "./contracts";
import { isLaneModel } from "./lane-models";

export type NativeModel = Awaited<ReturnType<ExtensionContext["models"]["list"]>>[number];
export type BootstrapName = (typeof MODEL_PRESET_NAMES)[number];
type PresetSource = "runtime" | "overlay" | "project" | "global";
export type NativePresetChoices = Partial<Record<BootstrapName, { model: LaneModel; reason: string }>>;

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
  constructor(
    private readonly settings: Settings,
    private readonly availableModels: () => Promise<NativeModel[]>,
    private readonly hasConcreteAuth: (provider: string) => boolean,
  ) {
    if (settings.settingsScope !== "persistent" || settings.overlayParent()) {
      throw new Error("Native presets require the persistent native base settings");
    }
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
    const settings = captureModelPreset(this.settings);
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
    await this.settings.reloadFromDisk();
    return this.inspectLoaded((await this.availableModels()).filter(isCodingModel));
  }

  async resolve(name: string, thinkingContext?: Pick<LanePresetSnapshot, "defaultThinkingLevel">): Promise<ResolvedLanePreset> {
    if (typeof name !== "string" || !isValidModelPresetName(name)) throw new Error("Invalid native preset name");
    await this.settings.reloadFromDisk();
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
      await this.settings.reloadFromDisk();
      // Whole-record native writes clear omitted global roles without touching
      // project roles or synchronizing the base's runtime role overrides.
      cfgModelRoles.set(this.settings, expected.modelRoles);
      if (expected.defaultThinkingLevel !== undefined) {
        cfgDefaultThinkingLevel.set(this.settings, expected.defaultThinkingLevel);
      } else cfgDefaultThinkingLevel.unset(this.settings);
      await this.settings.flush();
      await this.settings.reloadFromDisk();
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
   * Native conditional creation checks absence under the existing persistence
   * lock, so an operator insertion after preview is preserved. This is not a
   * multi-entry transaction: partial creation and conflicts are read back, never
   * repaired by overwriting or rolling back the operator's entry.
   */
  async initialize(choices: NativePresetChoices): Promise<{
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
      await this.settings.reloadFromDisk();
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
        const result = await createModelPresetIfMissing(this.settings, name, snapshot);
        if (result.kind === "created") staged.add(name);
        else conflicts.push(name);
      }
      if (expected.size > 0) {
        await this.settings.flush();
        await this.settings.reloadFromDisk();
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
      return { created, preserved, conflicts, inspection: this.inspectLoaded(models) };
    } finally { release(); }
  }
}
