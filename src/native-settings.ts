import { lstat, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { settingsCapability, type Settings as DiscoveredSettings } from "@oh-my-pi/pi-coding-agent/capability/settings";
import { cfgDisabledProviders } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";
import { writeFileAtomically } from "@oh-my-pi/pi-coding-agent/utils/atomic-file";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { getAgentDbPath, getProjectAgentDir, MAIN_CONFIG_FILENAMES, normalizePathForComparison } from "@oh-my-pi/pi-utils/dirs";
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

/**
 * Before a global fallback, distinguish an absent native project settings.json
 * from one native discovery silently omitted or rejected. Settings already
 * handles strict project YAML read and parse errors.
 */
export async function hasUnresolvedNativeProjectSettings(settings: Settings): Promise<boolean> {
  const provider = "native";
  if (cfgDisabledProviders.get(settings).includes(provider)) return false;
  const cwd = resolve(settings.getCwd());
  // Native discovery treats the home directory as user scope only.
  if (normalizePathForComparison(cwd) === normalizePathForComparison(homedir())) return false;
  const file = join(getProjectAgentDir(cwd), "settings.json");
  try {
    // Inspect the entry itself so a dangling settings symlink is not treated as absent.
    await lstat(file);
  } catch (error) {
    return !isEnoent(error);
  }
  const { items } = await loadCapability<DiscoveredSettings>(settingsCapability.id, {
    cwd, agentDir: settings.getAgentDir(), providers: [provider], includeDisabledProviders: true,
  });
  return !items.some(item => item.level === "project" && item.path === file);
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
 * Application-owned edits only. Recheck the effective scope with native
 * read-only loading and use the lock shared by stock Settings writers.
 * Compare staged keys against the YAML being edited. A writer that ignores
 * the lock can still change the file after that comparison.
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
        let latest = valueAt(global, path);
        if (edit.path === "memory.backend") {
          if (global.memory !== undefined && global.memory !== null && !isRecord(global.memory)) return false;
          // The staged value has already been migrated by native Settings.
          // Apply the same selector rules to the exact YAML we will edit.
          const legacyEnabled = valueAt(global, ["memories", "enabled"]);
          if (typeof latest !== "string" && typeof legacyEnabled === "boolean") {
            latest = legacyEnabled ? "local" : "off";
          } else if (latest === "mnemosyne") {
            latest = "mnemopi";
          }
        }
        if (!Bun.deepEquals(latest, valueAt(baseline, path))) return false;
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
