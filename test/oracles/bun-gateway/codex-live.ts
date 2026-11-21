import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { openLive } from "./openai-live";

const BRIDGE = fileURLToPath(new URL("./codex-live-bridge.py", import.meta.url));
const START_TIMEOUT_MS = 45_000;
const FORWARD_TIMEOUT_MS = 10_000;
const MAX_INPUT_BYTES = 24_000; // Half a second of 24 kHz mono PCM16.
const MAX_LINE_CHARS = 64 * 1024;
const MAX_PIPE_BYTES = 64 * 1024;
const MAX_DRAFTS = 32;
const MAX_DRAFT_CHARS = 1_000;
const RECENT_SPEECH_MS = 20_000;
const SPEECH_GAP_MS = 200;
const VOICES = new Set(["arbor", "breeze", "cove", "ember", "juniper", "maple", "sol", "spruce", "vale"]);

type LiveHandlers = Parameters<typeof openLive>[1];
type LiveSession = Awaited<ReturnType<typeof openLive>>;
type BridgeCommand =
  | { readonly type: "input"; readonly audio: string }
  | { readonly type: "draft_result"; readonly id: string; readonly posted: boolean }
  | { readonly type: "stop" };

class CodexLiveError extends Error {
  override readonly name = "CodexLiveError";
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function openCodexLive(
  options: { readonly voice: string }, handlers: LiveHandlers, signal: AbortSignal,
): Promise<LiveSession> {
  if (signal.aborted) throw new CodexLiveError("Codex voice startup was cancelled.");
  if (!VOICES.has(options.voice)) throw new CodexLiveError("Unsupported Codex subscription voice.");
  const home = homedir();
  const python = process.env.OMP_SA_CODEX_VOICE_PYTHON ??
    join(home, ".local", "share", "omp-superagent", "codex-voice",
      ...(process.platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"]));
  if (!isAbsolute(python)) throw new CodexLiveError("Codex voice needs an absolute Python interpreter path.");

  // Do not inherit Discord, Responses, FYI, Python injection, or proxy variables.
  const env: NodeJS.ProcessEnv = { HOME: home };
  const codexHome = process.env.CODEX_HOME;
  if (codexHome !== undefined) {
    if (!isAbsolute(codexHome)) throw new CodexLiveError("CODEX_HOME must be absolute when selecting a subscription profile.");
    env.CODEX_HOME = codexHome;
  }
  for (const key of ["SYSTEMROOT", "USERPROFILE", "LOCALAPPDATA", "TMPDIR", "TEMP", "TMP"]) {
    const value = process.env[key];
    if (value && isAbsolute(value)) env[key] = value;
  }
  const processGroup = process.platform !== "win32";
  const child = spawn(python, ["-E", "-s", "-B", "-u", BRIDGE, options.voice], {
    cwd: home, env, stdio: ["pipe", "pipe", "ignore"], detached: processGroup, windowsHide: true,
  });
  const ready = Promise.withResolvers<LiveSession>();
  let phase: "starting" | "active" | "closing" | "closed" = "starting";
  let closeDeadline: ReturnType<typeof setTimeout> | undefined;
  let draftDeadline: ReturnType<typeof setTimeout> | undefined;
  let lastSpeech = -Infinity;
  let utterance = 0;
  let draftedUtterance = 0;
  let pendingDraft: string | undefined;
  const seen = new Set<string>();
  let line = "";
  const decoder = new TextDecoder("utf-8", { fatal: true });

  function finish(reason: string): void {
    if (phase === "closed") return;
    const wasStarting = phase === "starting";
    phase = "closed";
    clearTimeout(startDeadline);
    clearTimeout(draftDeadline);
    signal.removeEventListener("abort", abort);
    pendingDraft = undefined;
    seen.clear();
    line = "";
    child.stdout.destroy();
    child.stdin.end();
    // EOF cancels the bridge task group, including a pending Codex auth probe.
    closeDeadline = setTimeout(() => {
      if (processGroup && child.pid && child.exitCode === null && child.signalCode === null) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      } else child.kill("SIGKILL");
    }, 3_000);
    if (wasStarting) ready.reject(new CodexLiveError(reason));
    else handlers.ended();
  }

  function send(command: BridgeCommand): boolean {
    const payload = `${JSON.stringify(command)}\n`;
    if (child.stdin.destroyed || child.stdin.writableLength + Buffer.byteLength(payload) > MAX_PIPE_BYTES) {
      finish("Codex voice bridge input is unavailable or congested.");
      return false;
    }
    child.stdin.write(payload);
    return true;
  }

  function abort(): void {
    if (phase === "starting") {
      finish("Codex voice startup was cancelled.");
    } else if (phase === "active") {
      phase = "closing";
      send({ type: "stop" });
      finish("Codex voice stopped.");
    }
  }

  const session: LiveSession = {
    input(pcm) {
      if (phase !== "active" || !pcm.length) return;
      if (pcm.length > MAX_INPUT_BYTES || pcm.length % 2) {
        finish("Invalid Codex voice PCM input.");
        return;
      }
      let squares = 0;
      for (let index = 0; index < pcm.length; index += 2) squares += pcm.readInt16LE(index) ** 2;
      if (squares >= (pcm.length / 2) * 256 ** 2) {
        const now = performance.now();
        if (now - lastSpeech >= SPEECH_GAP_MS) {
          utterance++;
          try {
            handlers.interrupt();
          } catch {
            finish("Codex voice interruption callback failed.");
            return;
          }
        }
        lastSpeech = now;
      }
      if (phase === "active") send({ type: "input", audio: pcm.toString("base64") });
    },
    close: abort,
  };

  async function postDraft(id: string, text: string): Promise<void> {
    pendingDraft = id;
    draftedUtterance = utterance;
    draftDeadline = setTimeout(() => finish("Codex voice draft forwarding timed out."), FORWARD_TIMEOUT_MS);
    let posted = false;
    try {
      await handlers.forward(text);
      posted = true;
    } catch {
      // A failed delivery may be ambiguous. Do not disclose details or retry it.
      posted = false;
    } finally {
      clearTimeout(draftDeadline);
    }
    if (phase !== "active" || pendingDraft !== id) return;
    pendingDraft = undefined;
    send({ type: "draft_result", id, posted });
  }

  function handleEvent(frame: string): void {
    const event: unknown = JSON.parse(frame);
    if (!record(event)) throw new CodexLiveError("Invalid Codex voice bridge event.");
    if (event.type === "ended") {
      finish("Codex subscription voice is unavailable or ended.");
      return;
    }
    if (event.type === "ready" && phase === "starting") {
      clearTimeout(startDeadline);
      phase = "active";
      ready.resolve(session);
      return;
    }
    if (phase !== "active") throw new CodexLiveError("Unexpected Codex voice bridge event before readiness.");
    switch (event.type) {
      case "audio": {
        if (typeof event.audio !== "string") break;
        const pcm = Buffer.from(event.audio, "base64");
        if (pcm.length && pcm.length <= MAX_INPUT_BYTES && pcm.length % 2 === 0 &&
          pcm.toString("base64") === event.audio) {
          handlers.audio(pcm);
          return;
        }
        break;
      }
      case "draft": {
        const { id, text } = event;
        if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id) || typeof text !== "string" ||
          text !== text.trim() || !text || text.length > MAX_DRAFT_CHARS) break;
        if (seen.has(id)) return;
        if (seen.size >= MAX_DRAFTS) throw new CodexLiveError("Codex voice draft limit exceeded.");
        seen.add(id);
        if (pendingDraft || draftedUtterance === utterance || performance.now() - lastSpeech > RECENT_SPEECH_MS) {
          send({ type: "draft_result", id, posted: false });
          return;
        }
        void postDraft(id, text);
        return;
      }
    }
    throw new CodexLiveError("Invalid Codex voice bridge event.");
  }

  const startDeadline = setTimeout(() => finish("Codex voice startup timed out."), START_TIMEOUT_MS);
  child.stdout.on("data", (chunk: Buffer) => {
    if (child.stdout.destroyed || phase === "closed") return;
    try {
      line += decoder.decode(chunk, { stream: true });
      let index: number;
      while ((index = line.indexOf("\n")) >= 0) {
        if (index > MAX_LINE_CHARS) throw new CodexLiveError("Codex voice bridge frame exceeded its limit.");
        const frame = line.slice(0, index);
        line = line.slice(index + 1);
        handleEvent(frame);
        if (child.stdout.destroyed) return;
      }
      if (line.length > MAX_LINE_CHARS) throw new CodexLiveError("Codex voice bridge frame exceeded its limit.");
    } catch {
      finish("Invalid Codex voice bridge event or callback failure.");
    }
  });
  child.once("error", () => finish("Could not start the Codex voice bridge; install the optional runtime."));
  child.stdin.on("error", () => finish("Codex voice bridge input closed."));
  child.stdout.on("error", () => finish("Codex voice bridge output closed."));
  child.once("close", () => {
    finish("Codex voice bridge disconnected.");
    clearTimeout(closeDeadline);
  });
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  return ready.promise;
}
