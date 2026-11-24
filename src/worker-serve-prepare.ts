// Private one-shot input from the Rust forced-command transport, not SSH stdio.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { readWorkerPolicy } from "./worker-enrollment";
import { WorkerRefusal } from "./worker-request";
import { prepareWorker } from "./worker-service";
import { WORKER_HEADER_BYTES } from "./worker-wire";

const [path, ...extra] = process.argv.slice(2);
if (!path || extra.length || process.env.SSH_ORIGINAL_COMMAND !== "omp-sa-worker-v1")
  throw new WorkerRefusal("Worker serve requires the enrolled SSH forced command");
const policy = readWorkerPolicy(homedir(), path);
const input = readFileSync(0); // The Rust parent writes one bounded header and closes this private pipe.
if (!input.length || input.length > WORKER_HEADER_BYTES || input.indexOf(10) !== input.length - 1)
  throw new WorkerRefusal("Invalid private worker admission input");
const preparation = await prepareWorker(policy, input.subarray(0, -1));
await new Promise<void>((resolve, reject) => {
  process.stdout.write(JSON.stringify(preparation), error => error ? reject(error) : resolve());
});
