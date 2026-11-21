import { chmod, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { HostChannel, type Frame } from "../../src/host-protocol";
import { readSessionHeaderId } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { dependencies } from "../../package.json";

/** Materialize a directly executable CLI with the same metadata and native argv boundary. */
export async function writeStockHostExecutable(file: string, source: string): Promise<void> {
  // Metadata probes must not load the fake RPC peer, its SDK, or the Gateway.
  const peer = `${file}.peer.ts`;
  await writeFile(peer, source);
  await writeFile(file, `#!${await realpath(process.execPath)} --no-env-file
if (process.argv[2] === "--version") console.log(${JSON.stringify(`omp/${dependencies["@oh-my-pi/pi-coding-agent"]}`)});
else if (process.argv[2] === "ps" && process.argv[3] === "--help") console.log("--signal SIGNAL");
else if (process.argv[2] === "--help") console.log("--mode rpc rpc-ui --resume FILE --extension PATH --model MODEL");
else await import(${JSON.stringify(peer)});
`, { mode: 0o700 });
}

/** Explicit fake native process boundary for transport tests, never a production fallback. */
export async function stockHostFixture(options: {
  sessionId?: string;
  sessionFile: string;
  state?: () => Frame;
  handle?: (command: Frame, channel: HostChannel) => Promise<Frame | undefined> | Frame | undefined;
  shutdown?: (channel: HostChannel) => Promise<Frame | undefined> | Frame | undefined;
  exit?: () => Promise<void>;
  beforeReady?: () => Promise<void>;
  activated?: () => Promise<void>;
  connected?: () => void;
}): Promise<void> {
  const sessionId = options.sessionId ?? await readSessionHeaderId(options.sessionFile);
  const state = () => ({
    sessionId, sessionFile: options.sessionFile, isSettled: true,
    isStreaming: false, isCompacting: false, hasPendingAsyncWork: false, queuedMessageCount: 0,
    goal: null, ...options.state?.(),
  });
  const native = new HostChannel(process.stdin, process.stdout);
  const respond = (channel: HostChannel, command: Frame, data: Frame) => channel.send({
    type: "response", id: command.id, command: command.type, success: true, ...data,
  });
  native.on("frame", (command: Frame) => {
    void (async () => {
      const handled = await options.handle?.(command, native);
      respond(native, command, handled ?? { data: command.type === "negotiate_protocol" ? { protocolVersion: 2 } : state() });
    })();
  });
  const channels = new Set<HostChannel>();
  const server = createServer(socket => {
    options.connected?.();
    const channel = new HostChannel(socket, socket);
    channels.add(channel);
    void channel.exited.then(() => channels.delete(channel));
    channel.on("frame", (command: Frame) => {
      void (async () => {
        if (command.type === "shutdown_host") {
          const result = await options.shutdown?.(channel);
          if (result === undefined && options.shutdown) return;
          respond(channel, command, result ?? { data: { shutdown: true } });
        } else if (command.type === "snapshot") {
          respond(channel, command, { data: { ...state(), hostPid: process.pid, generation: 1,
            loadedSuperkitPath: process.env.OMP_SUPERAGENT_MANAGED_ULW_PATH,
            settingsScope: "session", modelSettings: { modelRoles: {}, defaultThinkingLevel: "high" },
            hasOwnedRunningWork: false, mutationHeld: false, admitted: false, postPromptWork: false } });
        } else if (command.type === "activate") {
          await options.activated?.();
          respond(channel, command, { data: {} });
        } else if (command.type === "observe") respond(channel, command, { data: {} });
        else if (command.type === "set_model_preset")
          respond(channel, command, { data: { name: command.name, preset: command.preset, settingsScope: "session" } });
        else respond(channel, command, { success: false, error: "Unsupported fixture control" });
      })();
    });
    channel.send({ type: "ready" });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(process.env.OMP_SUPERAGENT_NATIVE_SOCKET!, () => {
      void chmod(process.env.OMP_SUPERAGENT_NATIVE_SOCKET!, 0o600).then(resolve, reject);
    });
  });
  await options.beforeReady?.();
  native.send({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] });
  process.stdin.on("end", () => {
    void (async () => {
      await options.exit?.();
      for (const channel of channels) channel.destroy();
      server.close();
      process.exit(0);
    })();
  });
}
