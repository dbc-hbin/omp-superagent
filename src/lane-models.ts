import type { LaneModel, LaneModelChoice, ModelPreset, LanePresetSnapshot, ResolvedLanePreset } from "./contracts";

export interface LaneModelCandidate extends LaneModel {
  name?: string;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  supportsTools?: boolean;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
}

export function sameLaneModel(left: LaneModel | null | undefined, right: LaneModel | null | undefined): boolean {
  return !!left && !!right && left.provider === right.provider && left.id === right.id;
}

export function isLaneModel(value: unknown): value is LaneModel {
  if (!value || typeof value !== "object") return false;
  const model = value as Record<string, unknown>;
  return typeof model.provider === "string" && !!model.provider.trim() && !model.provider.includes("\0") &&
    typeof model.id === "string" && !!model.id.trim() && !model.id.includes("\0");
}

/** Project native catalog facts only: endpoints, headers, credentials and opaque internals never leave here. */
export function codingModels(value: unknown): LaneModelCandidate[] {
  if (!Array.isArray(value)) throw new Error("Native available-model response is missing its model list");
  const candidates = new Map<string, LaneModelCandidate>();
  for (const entry of value) {
    if (!isLaneModel(entry)) continue;
    const native = entry as LaneModel & Record<string, unknown>;
    // Native Model.kind is optional; omission means ordinary chat. Judge/tiny and
    // other specialized runners are not coding-session model choices.
    if (native.kind !== undefined && native.kind !== "chat") continue;
    const model: LaneModelCandidate = { provider: entry.provider, id: entry.id };
    if (typeof native.name === "string") model.name = native.name;
    if (Array.isArray(native.input) && native.input.every(item => typeof item === "string")) model.input = [...native.input];
    if (typeof native.contextWindow === "number" && Number.isFinite(native.contextWindow) && native.contextWindow > 0) model.contextWindow = native.contextWindow;
    if (typeof native.maxTokens === "number" && Number.isFinite(native.maxTokens) && native.maxTokens > 0) model.maxTokens = native.maxTokens;
    if (typeof native.reasoning === "boolean") model.reasoning = native.reasoning;
    if (typeof native.supportsTools === "boolean") model.supportsTools = native.supportsTools;
    if (native.cost && typeof native.cost === "object") {
      const costs = native.cost as Record<string, unknown>;
      const cost: NonNullable<LaneModelCandidate["cost"]> = {};
      for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
        const amount = costs[key];
        if (typeof amount === "number" && Number.isFinite(amount) && amount >= 0) cost[key] = amount;
      }
      if (Object.keys(cost).length) model.cost = cost;
    }
    candidates.set(JSON.stringify([model.provider, model.id]), model);
  }
  return [...candidates.values()];
}

export function laneModelArgument(model: LaneModel): string {
  if (!isLaneModel(model)) throw new Error("Lane model requires an exact provider and model ID");
  return `${model.provider}/${model.id}`;
}

export async function resolveLaneModelChoice(
  choice: LaneModelChoice,
  resolvePreset?: (name: ModelPreset) => Promise<ResolvedLanePreset>,
): Promise<{ model: LaneModel; preset: ModelPreset | null; snapshot: LanePresetSnapshot | null }> {
  if ((choice.model !== undefined) === (choice.preset !== undefined))
    throw new Error("Choose exactly one lane model or native OMP preset");
  if (choice.preset !== undefined) {
    if (!resolvePreset) throw new Error("Native OMP preset resolution is unavailable");
    const resolved = await resolvePreset(choice.preset);
    if (resolved.preset !== choice.preset || !isLaneModel(resolved.model))
      throw new Error("Native OMP preset resolution returned a mismatched identity");
    return { model: { ...resolved.model }, preset: resolved.preset, snapshot: structuredClone(resolved.snapshot) };
  }
  if (!isLaneModel(choice.model)) throw new Error("Lane model requires an exact provider and model ID");
  return { model: { provider: choice.model.provider, id: choice.model.id }, preset: null, snapshot: null };
}
