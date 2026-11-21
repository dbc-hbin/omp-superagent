import assert from "node:assert/strict";
import type { Context, ToolCall, ToolResultMessage } from "@oh-my-pi/pi-ai";
import type { MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import type { ExtensionAPI, FileEntry } from "@oh-my-pi/pi-coding-agent";

type NativeMessage = Context["messages"][number] | Extract<FileEntry, { type: "message" }>["message"];
type Presentation = "direct" | "command" | "device";
type Exchange = { readonly call: ToolCall; readonly result: ToolResultMessage };
type Dispatch = {
  readonly name: string;
  readonly presentation: Presentation;
  readonly mode: "help" | "execute";
  readonly ok: boolean;
  readonly args?: Record<string, unknown>;
  readonly details: unknown;
  readonly result: ToolResultMessage;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined;
}

export function nativeToolExchanges(messages: readonly NativeMessage[]): Exchange[] {
  const calls = new Map<string, ToolCall>();
  return messages.flatMap(message => {
    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "toolCall") calls.set(part.id, part);
      }
    } else if (message.role === "toolResult") {
      const call = calls.get(message.toolCallId);
      // Call IDs can be reused after native provider replacement. Pair each result
      // with its preceding call rather than retaining a session-wide ID match.
      calls.delete(message.toolCallId);
      if (call?.name === message.toolName) return [{ call, result: message }];
    }
    return [];
  });
}

function nativeDispatch({ call, result }: Exchange): Dispatch {
  const ok = !result.isError;
  const path = call.arguments.path;
  if ((call.name === "read" || call.name === "write") && typeof path === "string" && path.startsWith("xd://")) {
    const name = path.slice("xd://".length);
    if (call.name === "read") return { name, presentation: "device", mode: "help", ok, details: result.details, result };
    const receipt = record(record(result.details)?.xdev);
    if (ok) assert(receipt?.tool === name && receipt.mode === "execute", `No native device execution receipt for ${name}`);
    return { name, presentation: "device", mode: "execute", ok, args: record(receipt?.args), details: receipt?.inner, result };
  }
  const command = call.arguments.command;
  // Recognize only the single-command shape emitted by this fixture, never an
  // arbitrary shell result. The native dispatch record proves the mounted tool ran.
  const mounted = call.name === "bash" && typeof command === "string"
    ? /^([a-z][a-z0-9_]*) (--help$|--json )/.exec(command) : null;
  if (mounted) {
    const name = mounted[1];
    const details = record(result.details);
    const admission = record(details?.async);
    assert(admission?.state !== "running", `Native command ${name} admitted background job ${admission?.jobId}; no terminal receipt`);
    const records = details?.toolCommands;
    const receipt = Array.isArray(records) && records.length === 1 ? record(records[0]) : undefined;
    const mode = mounted[2] === "--help" ? "help" : "execute";
    if (ok) assert(receipt?.tool === name && receipt.mode === mode && typeof receipt.exitCode === "number",
      `No native command ${mode} receipt for ${name}`);
    return { name, presentation: "command", mode, ok: ok && receipt?.exitCode === 0,
      args: record(receipt?.args), details: receipt?.inner, result };
  }
  return { name: call.name, presentation: "direct", mode: "execute", ok, args: call.arguments, details: result.details, result };
}

export function nativeJournalDispatches(entries: readonly FileEntry[]): Dispatch[] {
  return nativeToolExchanges(entries.flatMap(entry => entry.type === "message" ? [entry.message] : [])).map(nativeDispatch);
}

export function nativeToolTurn(pi: ExtensionAPI, context: Context, exchanges: readonly Exchange[]) {
  const advertised = new Set(context.tools?.map(tool => tool.name));
  const enabled = new Set(pi.getActiveTools());
  const dispatches = exchanges.map(nativeDispatch);
  // pi.pi is injected by the running CLI, not the SDK pinned in this checkout.
  const mounted = "isMountableAsToolCommand" in pi.pi ? "command"
    : "isMountableUnderXdev" in pi.pi ? "device" : undefined;
  const presentation = (name: string): Presentation => {
    assert(enabled.has(name), `Native fixture tool is not enabled: ${name}`);
    if (advertised.has(name)) return "direct";
    if (mounted === "command" && advertised.has("bash")) return mounted;
    if (mounted === "device" && advertised.has("read") && advertised.has("write")) return mounted;
    throw new Error(`Native provider has no advertised transport for enabled tool ${name}`);
  };
  const invoke = (name: string, args: Record<string, unknown>, id?: string): MockResponse => {
    const route = presentation(name);
    if (route === "direct") return { content: [{ type: "toolCall", id, name, arguments: args }] };
    const documented = dispatches.some(result => result.name === name && result.mode === "help" && result.ok);
    if (route === "command") {
      assert(/^[a-z][a-z0-9_]*$/.test(name), `Invalid fixture command name: ${name}`);
      const command = documented ? `${name} --json '${JSON.stringify(args).replaceAll("'", "'\\''")}'` : `${name} --help`;
      return { content: [{ type: "toolCall", id, name: "bash", arguments: { command } }] };
    }
    const path = `xd://${name}`;
    return { content: [documented
      ? { type: "toolCall", id, name: "write", arguments: { path, content: JSON.stringify(args) } }
      : { type: "toolCall", id, name: "read", arguments: { path } }] };
  };
  const executions = dispatches.filter(result => result.mode === "execute" && result.ok);
  return { advertised, enabled, dispatches, executions, invoke, presentation,
    failed: dispatches.filter(result => !result.ok),
    succeeded: (name: string, op?: string) => executions.some(result =>
      result.name === name && (op === undefined || result.args?.op === op)),
  };
}
