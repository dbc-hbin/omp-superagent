// Short-lived SDK operations. The Rust owner, not this process, owns native stdin and the reconnectable socket.
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { chmod, rename, writeFile } from "node:fs/promises";
import type { RpcAbortAndRestoreQueueResult } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import type { HostOptions } from "./host";
import type { Frame } from "./host-protocol";
import type { RotationSelection } from "./head-rotation";

type Manifest = {
  readonly options: Omit<HostOptions, "env">;
  readonly args: string[];
  readonly configPath: string;
  readonly processBackend: "broker" | "daemon";
  readonly headRotationSelection?: RotationSelection;
};
type Exit = {
  readonly pid: number; readonly ownerPid: number; readonly code: number | null; readonly signal: string | null;
  readonly sessionId: string; readonly instanceKey?: string | null; readonly runOrdinal: number;
  readonly workerAttempt?: string | null;
  readonly observationFailure: boolean; readonly expectedObservations: readonly [string, Frame][];
};

async function verifyExit({ options }: Manifest, exit: Exit) {
  const { visitEntriesFromFileStream } = await import("@oh-my-pi/pi-coding-agent/session/session-loader");
  const expected = new Map(exit.expectedObservations);
  const starts = new Set<number>();
  let duplicate = false;
  let malformed = false;
  let header = false;
  await visitEntriesFromFileStream(options.sessionFile, entry => {
    if (entry.type === "session") { header ||= entry.id === exit.sessionId; return; }
    if (entry.type !== "custom" || !entry.data || typeof entry.data !== "object") return;
    const data = entry.data as Frame;
    if (data.instanceKey !== (exit.instanceKey ?? undefined)) return;
    if (entry.customType === "rpc_prompt_result" && expected.has(entry.id) &&
        isDeepStrictEqual(data.frame, expected.get(entry.id))) expected.delete(entry.id);
    if (entry.customType === "rpc_agent_start" && data.hostPid === exit.pid && typeof data.runOrdinal === "number" &&
        Number.isSafeInteger(data.runOrdinal) && data.runOrdinal >= 1 && data.runOrdinal <= exit.runOrdinal) {
      duplicate ||= starts.has(data.runOrdinal);
      starts.add(data.runOrdinal);
    }
  }, { throwIfMissing: true, onMalformedRecord: () => { malformed = true; } });
  const journal = Bun.file(options.sessionFile);
  const size = journal.size;
  const persisted = header && !malformed && size > 0 && (await journal.slice(size - 1, size).text()) === "\n";
  const observationsFlushed = !exit.observationFailure && !expected.size && !duplicate && starts.size === exit.runOrdinal;
  const { pid, ownerPid, sessionId, code, signal } = exit;
  const receipt = `${options.socketPath}.exit.json`;
  const temporary = `${receipt}.${crypto.randomUUID()}`;
  await writeFile(temporary, JSON.stringify({ pid, ownerPid, sessionId, sessionFile: options.sessionFile, code,
    ...(exit.workerAttempt ? { workerAttempt: exit.workerAttempt } : {}),
    signal, persisted, observationsFlushed }), { mode: 0o600, flag: "wx" });
  await rename(temporary, receipt);
  if (!persisted || !observationsFlushed) throw new Error("Native exit persistence is unconfirmed");
  return { persisted, observationsFlushed };
}

async function run(operation: string | undefined, manifest: Manifest, input: unknown) {
  const { options } = manifest;
  const { extractProfileFlags } = await import("@oh-my-pi/pi-coding-agent/cli/profile-bootstrap");
  const { setProfile, resolveProfileEnv } = await import("@oh-my-pi/pi-utils/dirs");
  const bootstrap = extractProfileFlags([...options.command.slice(1), ...manifest.args]);
  setProfile(bootstrap.profile ?? resolveProfileEnv(process.env.OMP_PROFILE, process.env.PI_PROFILE));
  switch (operation) {
    case "prepare": {
      const { resolveCliArgv } = await import("@oh-my-pi/pi-coding-agent/cli-commands");
      const { parseArgs } = await import("@oh-my-pi/pi-coding-agent/cli/args");
      const argv = resolveCliArgv(bootstrap.argv);
      if ("error" in argv) throw new Error(argv.error);
      const parsed = parseArgs(argv.argv.slice(1));
      if (options.prReviewOnly) {
        if (parsed.noTools !== true || parsed.tools !== undefined || !parsed.noExtensions ||
            !parsed.noSkills || !parsed.noRules || !parsed.noContextFiles || !parsed.noLsp ||
            !parsed.noTitle || !parsed.noPrewalk || !parsed.offline ||
            parsed.trustedExtensions?.length !== 1 || parsed.config?.length !== 1 || parsed.config[0] !== manifest.configPath)
          throw new Error("Stock CLI arguments do not enforce the static PR review launch policy");
        const { getAgentDir } = await import("@oh-my-pi/pi-utils/dirs");
        const { Settings } = await import("@oh-my-pi/pi-coding-agent/config/settings");
        const { cfgDisabledProviders } = await import("@oh-my-pi/pi-coding-agent/config/model-settings");
        const { getAllCapabilitiesInfo } = await import("@oh-my-pi/pi-coding-agent/discovery");
        const { getAllPluginToolPaths } = await import("@oh-my-pi/pi-coding-agent/extensibility/plugins/loader");
        const { PR_REVIEW_GITHUB_ENV } = await import("./host-protocol");
        if (PR_REVIEW_GITHUB_ENV.some(name => process.env[name]))
          throw new Error("Static PR review cannot load GitHub credentials from the native profile");
        const native = await Settings.loadReadOnly({ cwd: options.cwd, agentDir: getAgentDir() });
        // Stock custom tool loading also has an independent legacy plugin scan,
        // outside the capability-provider switch. Refuse such a profile without
        // importing any of those modules in the SDK preparation process.
        if ((await getAllPluginToolPaths(options.cwd)).length)
          throw new Error("Static PR review cannot isolate this profile's legacy plugin tools");
        const disabled = new Set(cfgDisabledProviders.get(native));
        for (const capability of getAllCapabilitiesInfo()) {
          if (["mcps", "tools", "prompts", "slash-commands", "system-prompt"].includes(capability.id))
            for (const provider of capability.providers) disabled.add(provider.id);
        }
        const overlay = JSON.parse(await Bun.file(manifest.configPath).text());
        const staging = `${manifest.configPath}.${crypto.randomUUID()}`;
        await writeFile(staging, JSON.stringify({ ...overlay, disabledProviders: [...disabled] }), { mode: 0o600, flag: "wx" });
        await rename(staging, manifest.configPath);
      }
      const { lstat, stat } = await import("node:fs/promises");
      const expectedWorkerSession = process.env.OMP_SUPERAGENT_WORKER_EXPECTED_SESSION;
      const missing = await (expectedWorkerSession === undefined && !options.prReviewOnly ? stat : lstat)(options.sessionFile).then(async info => {
        if (expectedWorkerSession !== undefined) {
          const { readSessionHeaderId } = await import("@oh-my-pi/pi-coding-agent/session/session-loader");
          if (!info.isFile() || !expectedWorkerSession || await readSessionHeaderId(options.sessionFile) !== expectedWorkerSession)
            throw new Error("Worker journal no longer matches the reserved session");
        }
        if (options.prReviewOnly) {
          if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
            throw new Error("Static PR review journal is not a private owned regular file");
          const { visitEntriesFromFileStream } = await import("@oh-my-pi/pi-coding-agent/session/session-loader");
          let verified = false;
          await visitEntriesFromFileStream(options.sessionFile, entry => {
            if (entry.type === "custom" && entry.customType === "superagent_pr_review_policy" &&
                isDeepStrictEqual(entry.data, { version: 1, cwd: options.cwd })) verified = true;
          }, { throwIfMissing: true, onMalformedRecord: () => { throw new Error("Static PR review journal is malformed"); } });
          if (!verified) throw new Error("Refusing to restore a journal not created for static PR review");
        }
        return false;
      }, error => {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        if (expectedWorkerSession) throw new Error("Worker cannot recreate a missing reserved session");
        return true;
      });
      if (missing) {
        const { SessionManager } = await import("@oh-my-pi/pi-coding-agent/session/session-manager");
        const session = SessionManager.create(options.cwd, dirname(options.sessionFile));
        try {
          await session.setSessionFile(options.sessionFile);
          if (options.prReviewOnly)
            session.appendCustomEntry("superagent_pr_review_policy", { version: 1, cwd: options.cwd });
          const selection = manifest.headRotationSelection;
          if (selection) {
            session.appendModelChange(`${selection.provider}/${selection.modelId}`);
            session.appendThinkingLevelChange(selection.thinkingLevel ?? undefined, selection.configuredThinkingLevel ?? undefined);
          }
          await session.ensureOnDisk();
          session.flushSync();
        } finally { await session.close(); }
        if (options.prReviewOnly) await chmod(options.sessionFile, 0o600);
      }
      if (!options.prReviewOnly) {
        const { publishNativeSession } = await import("./native-sessions");
        await publishNativeSession(options.sessionFile, options.cwd);
      }
      const { hostInventoryManifest } = await import("./host-inventory-manifest");
      return { toolsExplicitlySelected: parsed.tools !== undefined, noTools: parsed.noTools === true,
        inventory: await hostInventoryManifest(manifest.processBackend, options.cwd) };
    }
    case "inventory": {
      const { projectDir, serviceName } = input as { projectDir?: string; serviceName?: string };
      const list = manifest.processBackend === "broker"
        ? (await import("./host-broker-services")).brokerServiceInventory(options.cwd)
        : (await import("./host-services")).listServiceUnits;
      return { units: await list(projectDir ?? undefined, serviceName ?? undefined) };
    }
    case "fit": {
      const { id, restored, remaining, maxResponseBytes } = input as { id: string; restored: RpcAbortAndRestoreQueueResult;
        remaining: RpcAbortAndRestoreQueueResult; maxResponseBytes: number };
      const { fitAbortAndRestoreQueueResponse } = await import("@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode");
      const flags = { ...(restored.imagesDropped || remaining.imagesDropped ? { imagesDropped: true } : {}),
        ...(restored.truncated || remaining.truncated ? { truncated: true } : {}) };
      const result = fitAbortAndRestoreQueueResponse(id, { ...restored, ...remaining,
        steering: [...restored.steering, ...remaining.steering], followUp: [...restored.followUp, ...remaining.followUp] },
        maxResponseBytes - (Object.keys(flags).length ? Buffer.byteLength(JSON.stringify(flags)) : 0));
      if (!result.success || result.command !== "abort_and_restore_queue") throw new Error("Cannot fit restored queue");
      return { ...result, data: { ...result.data, ...flags } };
    }
    case "exit": return verifyExit(manifest, input as Exit);
    default: throw new Error("Unknown Host SDK operation");
  }
}

/**
 * Launch discovery, then session preparation, in this one process. Reads the
 * discovery input line, reports the composition, and prepares only after the
 * launcher answers with its manifest; EOF instead means discovery only.
 */
async function launch() {
  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  while (!buffered.includes("\n")) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error("Missing launch discovery input");
    buffered += decoder.decode(chunk.value, { stream: true });
  }
  const newline = buffered.indexOf("\n");
  const input = JSON.parse(buffered.slice(0, newline));
  let rest = buffered.slice(newline + 1);
  let composition;
  if (input === null) {
    composition = { extensionPaths: [], noExtensions: true, memoryWriteDir: null };
  } else {
    const { managedUlwLaunchComposition } = await import("./managed-ulw");
    try { composition = await managedUlwLaunchComposition(input); }
    catch (error) {
      // Discovery refusals name the launch argument or package the operator must change.
      process.stdout.write(`\nMANAGED_ULW_LAUNCH_ERROR ${JSON.stringify(error instanceof Error ? error.message : String(error))}\n`);
      process.exitCode = 1;
      return;
    }
  }
  process.stdout.write(`\nMANAGED_ULW_LAUNCH ${JSON.stringify(composition)}\n`);
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) rest += decoder.decode(chunk.value, { stream: true });
  rest += decoder.decode();
  if (!rest) return;
  const manifest: Manifest = JSON.parse(rest);
  process.stdout.write(JSON.stringify(await run("prepare", manifest, manifest)));
}

const [, , operation, path] = process.argv;
try {
  if (operation === "launch") await launch();
  else if (operation === "prepare") throw new Error("Session preparation follows launch discovery");
  else {
    const input = await Bun.stdin.json();
    const manifest: Manifest = await Bun.file(path!).json();
    process.stdout.write(JSON.stringify(await run(operation, manifest, input)));
  }
} catch {
  // SDK errors may contain native frames, authorization data or prompt content.
  console.error("Host SDK operation failed");
  process.exitCode = 1;
}
