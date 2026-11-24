import { AbortController as ApiAbortController, type AbortSignal as ApiAbortSignal } from "abort-controller";

/** The legacy oracle's grammY Node entrypoint requires its SDK signal. */
export async function withTelegramSignal<T>(
  signal: AbortSignal | undefined, call: (signal: ApiAbortSignal | undefined) => Promise<T>,
): Promise<T> {
  if (!signal) return call(undefined);
  const controller = new ApiAbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try { return await call(controller.signal); }
  finally { signal.removeEventListener("abort", abort); }
}
