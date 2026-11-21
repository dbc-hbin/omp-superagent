import { lstat, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { writeFileAtomically } from "@oh-my-pi/pi-coding-agent/utils/atomic-file";
import { getAgentDbPath, MAIN_CONFIG_FILENAMES } from "@oh-my-pi/pi-utils/dirs";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import { expandTilde } from "@oh-my-pi/pi-utils/path";
import { stringifyYamlConfig } from "@oh-my-pi/pi-utils/yaml-config";
import { IsStandardObject as isRecord } from "@sinclair/typebox/value";

async function isPresent(path: string): Promise<boolean> {
  try { await stat(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** A read-only native load deliberately cannot settle unmigrated global storage. */
export async function hasUnresolvedNativeLegacy(agentDir: string): Promise<boolean> {
  for (const filename of MAIN_CONFIG_FILENAMES) {
    if (await isPresent(join(agentDir, filename))) return false;
  }
  return (await Promise.all([
    isPresent(join(agentDir, "settings.json")), isPresent(getAgentDbPath(agentDir)),
  ])).some(Boolean);
}

export function readNativeSettings(settings: Settings): Promise<Settings> {
  const cwd = settings.getCwd();
  const configFiles = settings.getConfigFiles();
  // Stock loading prepends PI_CONFIG_FILES itself. Do not replay that prefix
  // twice, which would merge array-valued overlays twice as well.
  const environmentFiles = (process.env.PI_CONFIG_FILES?.split(delimiter).filter(Boolean) ?? [])
    .map(file => resolve(cwd, expandTilde(file)));
  if (environmentFiles.some((file, index) => configFiles[index] !== file)) {
    throw new Error("Native config overlay environment changed after the scope was loaded");
  }
  return Settings.loadReadOnly({
    cwd, agentDir: settings.getAgentDir(),
    configFiles: configFiles.slice(environmentFiles.length), overrides: settings.mirrorState().overrides,
  });
}

type GlobalEdit = {
  path: "memory.backend" | "modelRoles" | "defaultThinkingLevel" | `modelPresets.${string}`;
  value: unknown;
  /** Preset creation never replaces a global entry or a higher-layer owner. */
  ifMissing?: boolean;
};

function valueAt(record: unknown, path: readonly string[]): unknown {
  for (const segment of path) {
    record = isRecord(record) && Object.hasOwn(record, segment) ? record[segment] : undefined;
  }
  return record;
}

/**
 * Application-owned edits only. Native read-only loading validates all inputs;
 * the native lock and atomic publisher serialize with stock Settings writers.
 * A stale key is preserved while disjoint keys are merged from the locked file.
 */
export async function editNativeGlobalConfig(settings: Settings, edits: readonly GlobalEdit[],
  accept?: (actual: Settings) => boolean | Promise<boolean>): Promise<boolean[]> {
  const agentDir = settings.getAgentDir();
  if (await hasUnresolvedNativeLegacy(agentDir)) throw new Error("Native global settings require legacy migration");
  let configPath = join(agentDir, MAIN_CONFIG_FILENAMES[0]);
  for (const filename of MAIN_CONFIG_FILENAMES) {
    const candidate = join(agentDir, filename);
    if (await isPresent(candidate)) { configPath = candidate; break; }
  }
  await mkdir(agentDir, { recursive: true });
  let writePath: string;
  try { writePath = await realpath(configPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // Never replace a dangling user-managed symlink with a regular config file.
    try {
      if ((await lstat(configPath)).isSymbolicLink()) throw new Error("Native global config symlink has no target");
    } catch (metadataError) {
      if ((metadataError as NodeJS.ErrnoException).code !== "ENOENT") throw metadataError;
    }
    writePath = join(await realpath(dirname(configPath)), basename(configPath));
  }
  const baseline = settings.getGlobalSettings();
  return withFileLock(writePath, async () => {
    const actual = await readNativeSettings(settings);
    if (await hasUnresolvedNativeLegacy(agentDir)) throw new Error("Native global settings require legacy migration");
    if (accept && !await accept(actual)) return edits.map(() => false);
    for (const filename of MAIN_CONFIG_FILENAMES) {
      const candidate = join(agentDir, filename);
      if (await isPresent(candidate)) {
        if (candidate !== configPath || await realpath(candidate) !== writePath) {
          throw new Error("Native global config destination changed during the edit");
        }
        break;
      }
    }
    let raw: unknown;
    try { raw = Bun.YAML.parse(await readFile(writePath, "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (raw === null || raw === undefined) raw = {};
    if (!isRecord(raw)) throw new Error("Native global config must be a mapping");
    const global = raw;
    const actualGlobal = actual.getGlobalSettings();
    const updated = structuredClone(global);
    const applied = edits.map(edit => {
      const path = edit.path.split(".");
      if (edit.ifMissing) {
        const name = path[1]!;
        if (Object.hasOwn(isRecord(global.modelPresets) ? global.modelPresets : {}, name) ||
            actual.getOwnedModelPreset(name) ||
            [actual.mirrorState().overrides, actual.mirrorState().configOverlay].some(layer =>
              isRecord(layer.modelPresets) && Object.hasOwn(layer.modelPresets, name))) return false;
      } else {
        // Native Settings interprets legacy `memories.enabled` in modern YAML
        // as a backend. Compare that effective global value while editing raw YAML.
        const latest = edit.path === "memory.backend" ? actualGlobal : global;
        if (!Bun.deepEquals(valueAt(latest, path), valueAt(baseline, path))) return false;
      }
      let target = updated;
      for (const segment of path.slice(0, -1)) {
        if (!isRecord(target[segment])) target[segment] = {};
        target = target[segment] as Record<string, unknown>;
      }
      const key = path.at(-1)!;
      if (edit.value === undefined) delete target[key];
      else target[key] = structuredClone(edit.value);
      return true;
    });
    if (!Bun.deepEquals(updated, global)) await writeFileAtomically(writePath, stringifyYamlConfig(updated));
    return applied;
  });
}
