// Short-lived SDK operations. The Rust owner, not this process, owns native stdin and the reconnectable socket.
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { rename, writeFile } from "node:fs/promises";
import type { RpcAbortAndRestoreQueueResult } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import type { HostOptions } from "./host";
import type { Frame } from "./host-protocol";
import type { RotationSelection } from "./head-rotation";

type Manifest = {
  readonly options: Omit<HostOptions, "env">;
  readonly args: string[];
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
      const { lstat, stat } = await import("node:fs/promises");
      const expectedWorkerSession = process.env.OMP_SUPERAGENT_WORKER_EXPECTED_SESSION;
      const missing = await (expectedWorkerSession === undefined ? stat : lstat)(options.sessionFile).then(async info => {
        if (expectedWorkerSession !== undefined) {
          const { readSessionHeaderId } = await import("@oh-my-pi/pi-coding-agent/session/session-loader");
          if (!info.isFile() || !expectedWorkerSession || await readSessionHeaderId(options.sessionFile) !== expectedWorkerSession)
            throw new Error("Worker journal no longer matches the reserved session");
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
          const selection = manifest.headRotationSelection;
          if (selection) {
            session.appendModelChange(`${selection.provider}/${selection.modelId}`);
            session.appendThinkingLevelChange(selection.thinkingLevel ?? undefined, selection.configuredThinkingLevel ?? undefined);
          }
          await session.ensureOnDisk();
          session.flushSync();
        } finally { await session.close(); }
      }
      const { publishNativeSession } = await import("./native-sessions");
      await publishNativeSession(options.sessionFile, options.cwd);
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

const [, , operation, path] = process.argv;
try {
  const input = await Bun.stdin.json();
  const manifest: Manifest = operation === "prepare" ? input : await Bun.file(path!).json();
  process.stdout.write(JSON.stringify(await run(operation, manifest, input)));
} catch {
  // SDK errors may contain native frames, authorization data or prompt content.
  console.error("Host SDK operation failed");
  process.exitCode = 1;
}
