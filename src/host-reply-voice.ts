import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { AgentSession, ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { isUserAuthoredMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import type { Frame } from "./host-protocol";
import { renderReplyVoice } from "./soul";

type Message = AgentSession["messages"][number];
type StagedVoice = { readonly token: string; readonly digest: string; readonly voice: string };
type Binding = StagedVoice & { readonly phase: "staged" | "input" | "submitted" };
type Submission = {
  readonly token: string;
  kind: "prompt" | "local-command" | "command-prompt";
  admitted: boolean; prepared?: string;
};
const wirePrefix = "\0omp-superagent-reply-voice:";

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const messageText = (message: Extract<Message, { role: "user" }>) =>
  typeof message.content === "string" ? message.content
    : message.content.flatMap(part => part.type === "text" ? [part.text] : []).join("");

/** Project into the root's provider call, not its stored or effective session prompt. */
export function installReplyVoice(pi: ExtensionAPI, session: AgentSession, claim: (token: string) => Promise<boolean>,
  retire: (token: string) => void) {
  const { agent, sessionId, sessionFile, extensionRunner: runner } = session;
  if (typeof agent.addBeforeModelCallHook !== "function" || typeof agent.streamFn !== "function"
      || typeof session.prompt !== "function" || typeof session.addDisposer !== "function"
      || typeof session.subscribeRunState !== "function" || !runner || typeof runner.emitInput !== "function") return;
  const sameSession = () => session.sessionId === sessionId && session.sessionFile === sessionFile && !session.isDisposed;
  const idle = () => sameSession() && !session.isRunActive && !session.isBusyForSnapshot
    && !session.hasAdmittedSubmission && !session.hasPostPromptWork && session.queuedMessageCount === 0;
  const scope = new AsyncLocalStorage<Submission>();
  let binding: Binding | undefined;
  let runVoice: StagedVoice | undefined;
  let approvedSignal: AbortSignal | undefined;
  const clear = (token?: string) => {
    if (token !== undefined && token !== binding?.token) return;
    binding = undefined;
    runVoice = undefined;
    approvedSignal = undefined;
  };

  // Keep stock RPC's input path active even when no other extension handles it.
  pi.on("input", () => {});
  const emitInput = runner.emitInput;
  const receive: typeof emitInput = async (text, images, source) => {
    if (source !== "rpc" || !text.startsWith(wirePrefix)) return emitInput.call(runner, text, images, source);
    const separator = text.indexOf("\n", wirePrefix.length);
    if (separator === -1) throw new Error("Invalid owned reply voice input");
    const original = text.slice(separator + 1);
    const candidate = binding;
    if (candidate?.phase !== "staged" || candidate.token !== text.slice(wirePrefix.length, separator)
        || digest(original) !== candidate.digest) throw new Error("Owned reply voice input did not match its staging");
    // Strip the stock-only marker before other extensions see input; only a
    // pass-through from the complete input hook may bind the RPC prompt.
    const result = await emitInput.call(runner, original, images, source);
    if (binding === candidate && !result.handled && (result.text ?? original) === original && idle()) {
      const claimed = await claim(candidate.token).catch((error: unknown) => {
        if (error instanceof Error) return false;
        throw error;
      });
      if (binding === candidate) {
        if (claimed) binding = { ...candidate, phase: "input" };
        else clear();
      }
    }
    return { ...result, text: result.text ?? original };
  };
  pi.on("before_agent_start", (event, ctx) => {
    const submission = scope.getStore();
    if (ctx.agent.kind === "main" && ctx.sessionManager === session.sessionManager && event.reason === "prompt"
        && submission?.admitted && submission.token === binding?.token && !runVoice) {
      submission.prepared ??= digest(event.prompt);
    }
  });

  const prompt = session.prompt;
  // The private marker was consumed by the stock input carrier, not shown
  // to a model. Observe its matching admission and actual new root input.
  const boundPrompt: typeof prompt = (text, options) => {
    const inherited = scope.getStore();
    if (inherited?.kind === "local-command" && inherited.token === binding?.token && sameSession()
        && !session.isStreaming && !session.isRunActive
        && options?.expandPromptTemplates === false && options.throwOnDrop === true && options.streamingBehavior === "steer"
        && (options.attribution === undefined || options.attribution === "user")) {
      // An extension command (such as a workflow alias) can handle the slash
      // locally and submit its real user turn through pi.sendUserMessage.
      // Use that SDK call's scoped admission, not the slash or rewritten text.
      inherited.kind = "command-prompt";
      return prompt.call(session, text, {
        ...options,
        onPromptAdmitted: () => { inherited.admitted = session.isStreaming && !agent.state.isStreaming; },
      }).finally(() => { if (runVoice?.token !== inherited.token) clear(inherited.token); });
    }
    const notify = options?.onPromptAdmitted;
    if (binding?.phase !== "input" || !idle() || !options || typeof notify !== "function"
        || options.streamingBehavior !== undefined
        || !Object.hasOwn(options, "images") || !Object.hasOwn(options, "streamingBehavior") || Object.keys(options).length !== 3
        || digest(text) !== binding.digest) {
      return scope.exit(() => prompt.call(session, text, options));
    }
    const { token } = binding;
    binding = { ...binding, phase: "submitted" };
    const submission: Submission = { token, kind: "prompt", admitted: false };
    return scope.run(submission, () => prompt.call(session, text, {
      ...options,
      onPromptAdmitted: () => {
        // An idle SDK prompt routed to a local command fires the same
        // callback before its handler, but has not claimed prompt setup.
        submission.admitted = session.isStreaming && !agent.state.isStreaming;
        if (!submission.admitted && !session.isStreaming) submission.kind = "local-command";
        notify();
      },
    })).finally(() => {
      if (submission.kind !== "command-prompt" && runVoice?.token !== token) clear(token);
    });
  };

  const dispatch = agent.streamFn;
  const project: typeof dispatch = (model, input, options) => {
    const voice = approvedSignal && !approvedSignal.aborted && session.isRunActive && sameSession()
      && !options?.signal?.aborted ? runVoice?.voice : undefined;
    return dispatch(model, voice ? { ...input, systemPrompt: [...(input.systemPrompt ?? []), voice] } : input, options);
  };
  const unhook = agent.addBeforeModelCallHook((signal, context) => {
    approvedSignal = undefined;
    if (!sameSession() || !session.isRunActive || !signal || signal.aborted) return;
    // A paused root run may resume in a fresh loop (and signal) to consume
    // background work. The public run boundary, not the loop, owns the voice.
    if (runVoice) { approvedSignal = signal; return; }
    const submission = scope.getStore();
    if (!submission?.admitted || !binding || submission.token !== binding.token) return;
    // The first call's new input is in the loop context but has not yet
    // emitted message_end. Use the current history after any pre-send rewrite.
    const previousUser = agent.state.messages.findLast(isUserAuthoredMessage);
    const previousIndex = previousUser ? context.messages.lastIndexOf(previousUser) : -1;
    const firstUser = context.messages.find((message, index) => index > previousIndex && isUserAuthoredMessage(message));
    if (firstUser?.role !== "user" || digest(messageText(firstUser)) !== submission.prepared) {
      clear(submission.token);
      return;
    }
    submission.prepared = undefined;
    runVoice = binding;
    approvedSignal = signal;
  });
  const unwatch = session.subscribeRunState(state => {
    if (state === "idle" && runVoice) {
      const { token } = runVoice;
      clear(token);
      retire(token);
    }
  });
  runner.emitInput = receive;
  session.prompt = boundPrompt;
  agent.streamFn = project;
  session.addDisposer(() => {
    clear();
    unwatch();
    unhook();
    if (runner.emitInput === receive) runner.emitInput = emitInput;
    if (session.prompt === boundPrompt) session.prompt = prompt;
    if (agent.streamFn === project) agent.streamFn = dispatch;
  });

  const available = () => sameSession() && session.extensionRunner === runner && runner.emitInput === receive
    && session.prompt === boundPrompt && agent.streamFn === project;
  return {
    available, clear,
    stage(command: Frame): boolean {
      const { token, message } = command;
      if (!available() || binding || typeof token !== "string" || !token || typeof message !== "string") {
        throw new Error("Native reply voice cannot be staged");
      }
      const voice = renderReplyVoice(command.voice);
      if (!idle()) return false;
      binding = { token, digest: digest(message), voice, phase: "staged" };
      return true;
    },
  };
}
