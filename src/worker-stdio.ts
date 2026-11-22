import type { Socket } from "node:net";
import type { Readable, Writable } from "node:stream";
import { WorkerRefusal } from "./worker-request";
import { WORKER_HEADER_BYTES } from "./worker-wire";

export function workerHeader(input: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    const stop = () => {
      clearTimeout(timer);
      input.off("readable", read).off("end", closed).off("close", closed).off("error", fail);
    };
    const fail = (error: Error) => { stop(); reject(error); };
    const closed = () => fail(new WorkerRefusal("Worker request ended before its header"));
    const read = () => {
      let chunk: Buffer | null;
      while ((chunk = input.read()) !== null) {
        const end = chunk.indexOf(10);
        length += end < 0 ? chunk.length : end + 1;
        if (length > WORKER_HEADER_BYTES) { fail(new WorkerRefusal("Worker request exceeds header limit")); return; }
        chunks.push(end < 0 ? chunk : chunk.subarray(0, end));
        if (end < 0) continue;
        stop();
        if (end + 1 < chunk.length) input.unshift(chunk.subarray(end + 1));
        resolve(Buffer.concat(chunks, length - 1));
        return;
      }
    };
    const timer = setTimeout(() => fail(new WorkerRefusal("Worker request header timed out")), 10_000);
    input.once("end", closed).once("close", closed).once("error", fail).on("readable", read);
  });
}

export function workerReply(output: Writable, reply: { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string }): Promise<void> {
  const line = `${JSON.stringify(reply)}\n`;
  const framed = Buffer.byteLength(line) <= WORKER_HEADER_BYTES ? line
    : `${JSON.stringify({ ok: false, error: "Worker response exceeds header limit" })}\n`;
  return new Promise((resolve, reject) => output.write(framed, error => error ? reject(error) : resolve()));
}

/** An EOF on either transport detaches only this client. It is not a native exit receipt. */
export async function bridgeWorker(input: Readable, output: Writable, socket: Socket): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const detach = () => resolve();
  input.once("end", detach).once("close", detach).once("error", detach);
  output.once("close", detach).once("error", detach);
  socket.once("close", detach).once("error", detach);
  try {
    if (input.destroyed || input.readableEnded || output.destroyed || socket.destroyed) return;
    socket.pipe(output, { end: false });
    input.pipe(socket, { end: false });
    await promise;
  } finally {
    input.unpipe(socket).pause();
    socket.unpipe(output).destroy();
    input.off("end", detach).off("close", detach).off("error", detach);
    output.off("close", detach).off("error", detach);
    socket.off("close", detach).off("error", detach);
  }
}
