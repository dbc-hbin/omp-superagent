import { createHash } from "node:crypto";
import { mkdtemp, open, realpath, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { privateDirectory } from "../../src/config";
import type { Attachment, InboundAttachmentBatch, InboundAttachmentReceipt, Messenger, Route } from "../../src/contracts";
import { DeliveryError } from "../../src/delivery";
import { MAX_GATEWAY_ATTACHMENT, MAX_GATEWAY_ATTACHMENT_BATCH } from "../../src/gateway-protocol";

export type AttachmentDownload = (route: Route, attachment: Attachment, signal: AbortSignal) => Promise<Response>;
export type DownloadMessenger = Omit<Messenger, "openAttachment"> & { openAttachment: AttachmentDownload };

/** Fixture-only materialization for HEAD tests without a native Gateway. */
export async function fixtureAttachmentSpool(
  stateDir: string, batch: InboundAttachmentBatch, signal: AbortSignal, download: AttachmentDownload,
): Promise<InboundAttachmentReceipt> {
  const root = join(await realpath(stateDir), "attachments");
  privateDirectory(root);
  const staging = await mkdtemp(join(root, ".download-"));
  const digest = createHash("sha256").update(createHash("sha256").update(batch.inputId).digest());
  const files: Array<{ size: number; mimeType: string; sha256: string }> = [];
  let total = 0;
  try {
    for (const [index, attachment] of batch.attachments.entries()) {
      const response = await download(batch.route, attachment, signal);
      if (!response.ok || !response.body) throw new DeliveryError("Attachment download was rejected", "rejected");
      const length = response.headers.get("content-length");
      const limit = Math.min(attachment.size ?? MAX_GATEWAY_ATTACHMENT, MAX_GATEWAY_ATTACHMENT_BATCH - total);
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit))
        throw new DeliveryError("Attachment response exceeds the size limit", "rejected");
      const expected = attachment.size ?? (length === null ? null : Number(length));
      const file = await open(join(staging, String(index)), "wx", 0o600);
      const reader = response.body.getReader();
      const cancel = () => { void reader.cancel().catch(() => {}); };
      signal.addEventListener("abort", cancel, { once: true });
      let size = 0;
      let prefix = Buffer.alloc(0);
      const hash = createHash("sha256");
      try {
        for (;;) {
          signal.throwIfAborted();
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > limit) throw new DeliveryError("Attachment stream exceeds the size limit", "rejected");
          prefix = Buffer.concat([prefix, chunk.value.subarray(0, 12 - prefix.length)]);
          hash.update(chunk.value);
          for (let offset = 0; offset < chunk.value.length;) {
            const { bytesWritten } = await file.write(chunk.value, offset, chunk.value.length - offset);
            if (!bytesWritten) throw new Error("Fixture spool could not write a chunk");
            offset += bytesWritten;
          }
        }
        signal.throwIfAborted();
        if (expected !== null && size !== expected)
          throw new DeliveryError("Attachment stream differs from declared size", "rejected");
        await file.sync();
      } finally {
        signal.removeEventListener("abort", cancel);
        await reader.cancel().catch(() => {});
        await file.close();
      }
      const mimeType = prefix.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "image/png"
        : prefix.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ? "image/jpeg"
        : ["GIF87a", "GIF89a"].includes(prefix.subarray(0, 6).toString()) ? "image/gif"
        : prefix.subarray(0, 4).toString() === "RIFF" && prefix.subarray(8, 12).toString() === "WEBP" ? "image/webp"
        : "application/octet-stream";
      total += size;
      const contentHash = hash.digest();
      digest.update(contentHash);
      files.push({ size, mimeType, sha256: contentHash.toString("hex") });
    }
    signal.throwIfAborted();
    const receipt = digest.digest("hex");
    const destination = join(root, receipt);
    try { await rename(staging, destination); }
    catch (error) {
      if (!(error instanceof Error) || !("code" in error) || !["EEXIST", "ENOTEMPTY"].some(code => code === error.code)) throw error;
    }
    return { receipt, files: files.map((file, index) => ({ ...file, path: join(destination, String(index)) })) };
  } finally { await rm(staging, { recursive: true, force: true }); }
}
