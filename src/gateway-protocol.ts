import { createHash } from "node:crypto";
import { request, type IncomingMessage } from "node:http";
import { existsSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Config } from "./config";
import type { InboundAttachmentBatch, InboundAttachmentReceipt } from "./contracts";
import { DeliveryError } from "./delivery";
import type { GatewayStatus } from "./gateway-wire";

export const MAX_GATEWAY_FRAME = 16 * 1024 * 1024;
export const MAX_GATEWAY_ATTACHMENT = 20 * 1024 * 1024;
export const MAX_GATEWAY_ATTACHMENT_BATCH = 40 * 1024 * 1024;
export interface GatewayResult { ok: boolean; value?: unknown; error?: string; certainty?: "rejected" | "uncertain"; retryAfterMs?: number }

export function gatewayPaths(config: Pick<Config, "stateDir">) {
  const socketPath = join(config.stateDir, "run", "gateway.sock");
  if (Buffer.byteLength(socketPath) > 100) throw new Error("stateDir is too long for the Gateway socket");
  return { socketPath, logPath: join(config.stateDir, "logs", "gateway.log") };
}

export async function gatewayStatus(config: Config): Promise<GatewayStatus | null> {
  const path = gatewayPaths(config).socketPath;
  if (!existsSync(path)) return null;
  return gatewayCall<GatewayStatus>(path, "/status");
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

/** A spool reply carries only correctly indexed local references, never attachment bytes. */
export async function parseInboundAttachmentReceipt(
  socketPath: string, batch: InboundAttachmentBatch, value: unknown,
): Promise<InboundAttachmentReceipt> {
  const invalid = () => new DeliveryError("Invalid attachment spool receipt", "uncertain");
  if (!value || typeof value !== "object" || !("receipt" in value) || !("files" in value)
    || typeof value.receipt !== "string" || !/^[a-f0-9]{64}$/.test(value.receipt)
    || !Array.isArray(value.files) || value.files.length !== batch.attachments.length) throw invalid();
  const directory = join(await realpath(dirname(dirname(socketPath))), "attachments", value.receipt);
  const digest = createHash("sha256").update(createHash("sha256").update(batch.inputId).digest());
  let total = 0;
  const files: InboundAttachmentReceipt["files"][number][] = [];
  for (const [index, attachment] of batch.attachments.entries()) {
    const file: unknown = value.files[index];
    if (!file || typeof file !== "object" || !("path" in file) || !("size" in file) || !("mimeType" in file)
      || file.path !== join(directory, String(index)) || typeof file.size !== "number"
      || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_GATEWAY_ATTACHMENT
      || (attachment.size !== null && file.size !== attachment.size)
      || !("sha256" in file) || typeof file.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(file.sha256)
      || typeof file.mimeType !== "string"
      || !["application/octet-stream", "image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.mimeType))
      throw invalid();
    total += file.size;
    if (total > MAX_GATEWAY_ATTACHMENT_BATCH) throw invalid();
    digest.update(Buffer.from(file.sha256, "hex"));
    files.push({ path: file.path, size: file.size, mimeType: file.mimeType, sha256: file.sha256 });
  }
  if (digest.digest("hex") !== value.receipt) throw invalid();
  return { receipt: value.receipt, files };
}
