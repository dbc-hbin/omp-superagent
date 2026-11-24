import { addAbortListener } from "node:events";
import { requireGateway } from "./gateway-native";
import { readCredentialFile, validateCredential } from "./credentials";

type Credentials = { readonly bot: string; readonly manifest?: string };
export type OperatorRun = <T>(operation: string, request: unknown, credentials: Credentials, signal?: AbortSignal) => Promise<T>;

export class OperatorStartError extends Error {
  constructor() { super("Could not start the native operator; no mutation was attempted."); }
}

export function operatorBotToken(platform: "Discord" | "Telegram", configPath: string, tokenEnv: string): string {
  const explicit = process.env[tokenEnv];
  let stored: string | undefined;
  try {
    // Validate the sibling's ownership even when an explicit environment value wins.
    stored = readCredentialFile(configPath)?.values[tokenEnv];
    if (!explicit && stored) validateCredential(stored);
  } catch { throw new Error(`Cannot safely load the configured ${platform} credential; details suppressed`); }
  if (explicit) {
    try { validateCredential(explicit); }
    catch { throw new Error(`Configured ${platform} credential is invalid; value suppressed`); }
    return explicit;
  }
  if (!stored) throw new Error(`Configured ${platform} credential is missing`);
  return stored;
}

/** Run only the selected operation's credentials through the child's private environment. */
export async function invokeOperator<T>(argv: string[], request: unknown, credentials: Credentials, signal?: AbortSignal): Promise<T> {
  let child: Bun.Subprocess<"pipe", "pipe", "ignore">;
  let frame: string;
  try {
    if (signal?.aborted) throw new OperatorStartError();
    frame = `${JSON.stringify(request)}\n`;
    if (signal?.aborted) throw new OperatorStartError();
    child = Bun.spawn(argv, {
      env: { OMP_SA_OPERATOR_PARENT: String(process.pid), OMP_SA_OPERATOR_BOT: credentials.bot,
        ...(credentials.manifest !== undefined && { OMP_SA_OPERATOR_MANIFEST: credentials.manifest }) },
      stdin: "pipe", stdout: "pipe", stderr: "ignore",
    });
  } catch {
    throw new OperatorStartError();
  }
  const uncertain = "No authoritative operator receipt. A requested change may have reached the platform; inspect before retrying.";
  const stop = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  };
  using abortListener = signal && addAbortListener(signal, stop);
  if (signal?.aborted) stop();
  const send = async () => {
    // Keep the writer open after this frame. EOF is a parent-lifetime fence,
    // including when a supervisor kills only the CLI and no JS handlers run.
    await child.stdin.write(frame);
    await child.stdin.flush();
  };
  try {
    const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text(), send()])
      .catch(() => { throw new Error(uncertain); });
    if (signal?.aborted) throw new Error(uncertain);
    let reply: { ok?: boolean; error?: string; value?: T };
    try { reply = JSON.parse(output); }
    catch { throw new Error(uncertain); }
    if (reply?.ok === false && typeof reply.error === "string") throw new Error(reply.error);
    if (code !== 0 || reply?.ok !== true || reply.value === undefined) throw new Error(uncertain);
    return reply.value;
  } finally {
    stop();
    await child.exited.catch(() => undefined);
  }
}

export const runOperator: OperatorRun = async (operation, request, credentials, signal) => {
  if (signal?.aborted) throw new OperatorStartError();
  const gateway = await requireGateway().catch(() => { throw new OperatorStartError(); });
  return invokeOperator([gateway, "operator", operation], request, credentials, signal);
};
