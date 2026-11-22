import { strict as assert } from "node:assert";
import { existsSync, readFileSync, watch } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { nativeRequestEnvelope } from "./native-request-envelope";

export const remoteWorkerModel = { provider: "remote-worker-proof", id: "local" } as const;
export const workspaceProbe = "worker-workspace-proof";
export const recoveryGateMarker = "[native-worker-detached-completion]";

export function recoveryGate(stateDir: string) {
  return { entered: join(stateDir, "gate-entered"), release: join(stateDir, "gate-release") };
}

export async function waitForProofFile(path: string): Promise<void> {
  const ready = Promise.withResolvers<void>();
  const watcher = watch(dirname(path), () => { if (existsSync(path)) ready.resolve(); });
  watcher.on("error", ready.reject);
  const timer = setTimeout(() => ready.reject(new Error(`Native worker gate did not reach ${path}`)), 20_000);
  try {
    if (existsSync(path)) ready.resolve();
    await ready.promise;
  } finally {
    clearTimeout(timer);
    watcher.close();
  }
}

/** Stock OMP discovers this provider in its isolated user config. No model request leaves the process. */
export default async function nativeRemoteWorkerProvider(pi: ExtensionAPI): Promise<void> {
  const { HOME, PI_CODING_AGENT_DIR, SA_PROOF_HOME, SA_PROOF_CUSTODY, SA_PROOF_ROOT,
    OMP_SUPERAGENT_ROLE, OMP_SUPERAGENT_CONFIG } = process.env;
  // `omp models --json` (the worker's model preflight) lists providers without a session or role.
  const listing = process.argv.includes("models");
  assert.ok(SA_PROOF_HOME && SA_PROOF_CUSTODY && SA_PROOF_ROOT);
  assert.equal(HOME, SA_PROOF_HOME);
  assert.equal(PI_CODING_AGENT_DIR, join(SA_PROOF_HOME, "agent"));
  assert.equal(OMP_SUPERAGENT_CONFIG, undefined);
  assert.ok(listing || OMP_SUPERAGENT_ROLE === "head" || OMP_SUPERAGENT_ROLE === "lane");
  const worker = OMP_SUPERAGENT_ROLE === "lane";
  const { recordHostFixture }: typeof import("./host-fixture-processes") = await import(SA_PROOF_CUSTODY);
  const sessionFlag = process.argv.indexOf("--session");
  const session = process.argv[sessionFlag + 1];
  assert.ok(listing || sessionFlag >= 0 && session, "The fixture requires an owned native session");
  if (!listing) {
    const registeredRoot = worker ? dirname(session!) : SA_PROOF_ROOT;
    if (worker) assert.equal(dirname(registeredRoot), SA_PROOF_ROOT);
    recordHostFixture(registeredRoot);
  }

  const refuseNetwork = () => { throw new Error("Remote worker proof forbids provider network access"); };
  globalThis.fetch = Object.assign(async () => refuseNetwork(), { preconnect: refuseNetwork });
  let evidence: string | undefined;
  pi.on("session_start", (_event, ctx) => {
    if (worker) evidence = readFileSync(join(ctx.cwd, workspaceProbe), "utf8");
  });

  const mock = createMockModel({
    ...remoteWorkerModel,
    handler: async context => {
      const user = context.messages.findLast(message => message.role === "user");
      const text = typeof user?.content === "string" ? user.content
        : user?.content.filter(part => part.type === "text").map(part => part.text).join("\n");
      const request = text && nativeRequestEnvelope(text);
      assert.ok(request, "Expected a source-bound native request");
      if (!worker) return { content: [`Head acknowledged ${request.requestId}`] };
      assert.ok(evidence, "The worker must read its workspace from the native session cwd");
      if (request.envelope.includes(recoveryGateMarker)) {
        const gate = recoveryGate(SA_PROOF_ROOT);
        await writeFile(gate.entered, "", { mode: 0o600, flag: "wx" });
        await waitForProofFile(gate.release);
      }
      return { content: [`Worker finished ${request.sourceId}: ${evidence}`] };
    },
  });
  pi.registerProvider(remoteWorkerModel.provider, {
    baseUrl: "mock://remote-worker-proof", api: "remote-worker-proof", apiKey: "offline-fixture-only",
    streamSimple: (model, context, options) => mock.stream(model, context, options),
    models: [{ id: mock.id, name: mock.name, kind: "chat", reasoning: mock.reasoning, input: mock.input,
      cost: mock.cost, contextWindow: mock.contextWindow, maxTokens: mock.maxTokens }],
  });
}
