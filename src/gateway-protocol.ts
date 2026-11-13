import { request, type IncomingMessage } from "node:http";
import { lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Config } from "./config";
import { DeliveryError } from "./delivery";

export const MAX_GATEWAY_FRAME = 16 * 1024 * 1024;
export const MAX_GATEWAY_ATTACHMENT = 20 * 1024 * 1024;
export interface GatewayResult { ok: boolean; value?: unknown; error?: string; certainty?: "rejected" | "uncertain"; retryAfterMs?: number }

export function gatewayPaths(config: Pick<Config, "stateDir">) {
  const socketPath = join(config.stateDir, "run", "gateway.sock");
  if (Buffer.byteLength(socketPath) > 100) throw new Error("stateDir is too long for the Gateway socket");
  return { socketPath, logPath: join(config.stateDir, "logs", "gateway.log") };
}

export async function trustedGatewaySocket(socketPath: string): Promise<{ dev: number; ino: number }> {
  const directory = await lstat(dirname(socketPath));
  const stat = await lstat(socketPath);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid?.() ||
      (directory.mode & 0o777) !== 0o700 || !stat.isSocket() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
    throw new DeliveryError("Gateway endpoint is not a private owned Unix socket", "rejected");
  return { dev: stat.dev, ino: stat.ino };
}

export async function readGatewayJson(stream: IncomingMessage): Promise<unknown> {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += data.length;
    if (bytes > MAX_GATEWAY_FRAME) throw new DeliveryError("Gateway frame exceeds size limit", "rejected");
    chunks.push(data);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** One attempt only. A lost response is never converted to a known rejection. */
export async function gatewayRequest(socketPath: string, endpoint: string, body?: unknown, options: {
  token?: string; clientId?: string; signal?: AbortSignal; timeoutMs?: number;
} = {}): Promise<IncomingMessage> {
  const before = await trustedGatewaySocket(socketPath);
  const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  if (data && data.length > MAX_GATEWAY_FRAME) throw new DeliveryError("Gateway frame exceeds size limit", "rejected");
  const { promise, resolve, reject } = Promise.withResolvers<IncomingMessage>();
  let answered = false;
  const req = request({ socketPath, path: endpoint, method: body === undefined ? "GET" : "POST",
    headers: { ...(data ? { "content-type": "application/json", "content-length": data.length } : {}),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.clientId ? { "x-gateway-client": options.clientId } : {}) }, signal: options.signal,
  }, response => {
    answered = true;
    clearTimeout(timer);
    void trustedGatewaySocket(socketPath).then(after => {
      if (before.dev !== after.dev || before.ino !== after.ino) {
        response.destroy();
        reject(new DeliveryError("Gateway socket changed during request", "uncertain"));
      } else resolve(response);
    }, error => { response.destroy(); reject(error); });
  });
  const timer = setTimeout(() => req.destroy(new Error("Gateway request timed out")), options.timeoutMs ?? 30_000);
  timer.unref();
  req.on("error", () => {
    clearTimeout(timer);
    if (!answered) reject(new DeliveryError("Gateway request outcome uncertain", "uncertain"));
  });
  if (data) req.write(data);
  req.end();
  return promise;
}

export async function gatewayCall<T>(socketPath: string, endpoint: string, body?: unknown, options?: Parameters<typeof gatewayRequest>[3]): Promise<T> {
  const response = await gatewayRequest(socketPath, endpoint, body, options);
  const result = await readGatewayJson(response) as GatewayResult;
  if (!result.ok) throw new DeliveryError(result.error ?? "Gateway rejected operation", result.certainty ?? "uncertain", result.retryAfterMs);
  return result.value as T;
}
