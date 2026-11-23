import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { join, resolve } from "node:path";
import { HostConnection, PR_REVIEW_INPUT_PREFIX, startHost, type HostFrame, type HostOptions } from "../src/host";
import { stopHostFixtures, waitForFixtureProcessExit } from "./fixtures/host-fixture-processes";
import { nativeTestCommand } from "./fixtures/native-command";
import { nativeDisabledProviders } from "./fixtures/native-extension";

const nativeTest = process.env.OMP_SUPERAGENT_NATIVE_TEST === "1" ? test : test.skip;
const verdict = JSON.stringify({ verdict: "blocked", summary: "Loopback review response" });

function completion(delta: object, reason: string): Response {
  const row = { id: "pr-review-fixture", model: "local", object: "chat.completion.chunk", created: 1 };
  const chunk = (value: object, finish_reason: string | null) => `data: ${JSON.stringify({
    ...row, choices: [{ index: 0, delta: value, finish_reason }],
  })}\n\n`;
  return new Response(chunk({ role: "assistant", ...delta }, null) + chunk({}, reason) + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } });
}

async function review(connection: HostConnection, id: string, message: string): Promise<HostFrame> {
  const { resolve, reject, promise } = Promise.withResolvers<HostFrame>();
  void promise.catch(() => {});
  const stop = connection.onFrame(frame => {
    if (frame.type === "prompt_result" && frame.id === id) resolve(frame);
  });
  const timer = setTimeout(() => reject(new Error("Static review did not emit its prompt result")), 20_000);
  try {
    expect(await connection.request({ type: "prompt", message }, id)).toMatchObject({ success: true, id });
    return await promise;
  } finally { stop(); clearTimeout(timer); }
}

nativeTest("static PR Host keeps stock inference tool-free after detach and journal restore", async () => {
  const command = await nativeTestCommand();
  const root = await fs.mkdtemp(join(await fs.realpath("/tmp"), "prh-"));
  const home = join(root, "home");
  const agent = join(root, "agent");
  const cwd = join(root, "empty");
  const builtinCanary = join(root, "bash-executed");
  const writeCanary = join(root, "write-executed");
  const ambientCanary = join(root, "ambient-loaded");
  const resource = join(root, "secret.txt");
  const resourceContents = "FILE_CONTENT_MUST_NOT_ENTER_PR_REVIEW_PROMPT";
  const wire: Record<string, unknown>[] = [];
  let solicit: "bash" | "write" | null = null;
  const unsolicited: string[] = [];
  const shell = `printf canary > ${builtinCanary}`;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/chat/completions")
      return new Response("Unexpected route", { status: 404 });
    const input: unknown = await request.json();
    if (!input || typeof input !== "object" || Array.isArray(input)) return new Response("Bad payload", { status: 400 });
    wire.push(input as Record<string, unknown>);
    if (solicit !== null) {
      const name = solicit;
      solicit = null;
      unsolicited.push(name);
      return completion({ tool_calls: [{ index: 0, id: `pr-${name}`, type: "function", function: {
        name, arguments: JSON.stringify(name === "bash" ? { command: shell } : { path: writeCanary, content: "canary" }),
      } }] }, "tool_calls");
    }
    return completion({ content: verdict }, "stop");
  } });
  const options: HostOptions = {
    command, prReviewOnly: true, model: "pr-review-fixture/local", subagentConcurrency: 1,
    cwd, sessionFile: join(root, "native.jsonl"), socketPath: join(root, "host.sock"), logPath: join(root, "native.log"),
    extensionPath: resolve(import.meta.dir, "fixtures/native-extension.ts"),
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, USERPROFILE: home,
      PI_CODING_AGENT_DIR: agent, OMP_SUPERAGENT_ROLE: "lane", CI: "true", NO_COLOR: "1",
      GH_TOKEN: "controller-fixture", GITHUB_TOKEN: "controller-fixture",
      GH_ENTERPRISE_TOKEN: "controller-fixture", GITHUB_ENTERPRISE_TOKEN: "controller-fixture",
      ...(process.env.OMP_TEST_NATIVES_DIR ? { PI_NATIVES_DIR: process.env.OMP_TEST_NATIVES_DIR } : {}),
      OMP_DAEMON_DIR: join(root, "daemon"), XDG_CONFIG_HOME: join(root, "config"),
      XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"), XDG_DATA_HOME: join(root, "data"),
      TMPDIR: root },
  };
  let connection: HostConnection | undefined;
  let passed = false;
  try {
    await Promise.all([home, agent, cwd].map(dir => fs.mkdir(dir, { mode: 0o700 })));
    await fs.mkdir(join(agent, "extensions"), { mode: 0o700 });
    await fs.writeFile(join(agent, "extensions", "ambient.ts"),
      `import { writeFileSync } from "node:fs"; export default function () { writeFileSync(${JSON.stringify(ambientCanary)}, "loaded"); }`,
      { mode: 0o600 });
    await fs.writeFile(resource, resourceContents, { mode: 0o600 });
    const config = JSON.stringify({ disabledProviders: nativeDisabledProviders, goal: { enabled: true } });
    await fs.writeFile(join(agent, "config.yml"), config, { mode: 0o600 });
    await fs.writeFile(join(agent, "models.yml"), JSON.stringify({ providers: { "pr-review-fixture": {
      api: "openai-completions", apiKey: "loopback-fixture", baseUrl: `${server.url.origin}/v1`,
      models: [{ id: "local", name: "Local review", contextWindow: 32768, maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } } }), { mode: 0o600 });
    await startHost(options);
    connection = await HostConnection.connectForActivity(options.socketPath);
    const initial = await connection.client.getState();
    await connection.assertPrReviewOnly(cwd);
    await expect(connection.assertPrReviewOnly(home)).rejects.toThrow("did not confirm");
    expect(await connection.request({ type: "bash", command: shell })).toMatchObject({ success: false, code: "pr_review_rpc_forbidden" });
    expect(await connection.request({ type: "prompt", message: "/reload" })).toMatchObject({ success: false, code: "pr_review_rpc_forbidden" });
    expect(await connection.request({ type: "prompt", message: `${PR_REVIEW_INPUT_PREFIX}${JSON.stringify({ patch: `@${resource}` })}` }))
      .toMatchObject({ success: false, code: "pr_review_rpc_forbidden" });
    expect(wire).toHaveLength(0);
    await connection.close();
    connection = await HostConnection.connectForActivity(options.socketPath);
    const data = (patch: string) => `${PR_REVIEW_INPUT_PREFIX}${JSON.stringify({ patch }).replace(/[@^]/g,
      character => character === "@" ? "\\u0040" : "\\u005e")}`;
    expect(await review(connection, "pr-round-one", data(`@${resource}\n^model /skill:ambient /reload`)))
      .toMatchObject({ status: "completed" });
    expect(await connection.request({ type: "get_journal_cursor" }))
      .toMatchObject({ success: true, data: { leafId: expect.any(String) } });
    expect(await connection.request({ type: "shutdown_host" })).toMatchObject({ success: true });
    await connection.exited;
    await waitForFixtureProcessExit([initial.hostPid, initial.adapterOwnerPid]);

    const { model: _initialModel, ...restore } = options;
    await startHost(restore);
    connection = await HostConnection.connectForActivity(options.socketPath);
    const restored = await connection.client.getState();
    expect(restored.sessionId).toBe(initial.sessionId);
    await connection.assertPrReviewOnly(cwd);
    solicit = "bash";
    await review(connection, "pr-round-two", data("Second static review round."));
    solicit = "write";
    await review(connection, "pr-round-three", data("Third static review round."));
    expect(unsolicited).toEqual(["bash", "write"]);
    expect(wire[0]?.model).toBe("local");
    expect(wire.some(input => JSON.stringify(input.messages).includes("Second static review round."))).toBe(true);
    for (const request of wire) {
      expect(request.tools ?? []).toEqual([]);
      expect(JSON.stringify(request.messages)).not.toContain(resourceContents);
    }
    await expect(fs.lstat(builtinCanary)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.lstat(writeCanary)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.lstat(ambientCanary)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(join(agent, "config.yml"), "utf8")).toBe(config);
    expect(await connection.request({ type: "shutdown_host" })).toMatchObject({ success: true });
    await connection.exited;
    await waitForFixtureProcessExit([restored.hostPid, restored.adapterOwnerPid]);
    passed = true;
  } finally {
    try { await connection?.close(); await server.stop(true); }
    finally {
      await stopHostFixtures(root);
      if (passed) await fs.rm(root, { recursive: true, force: true });
    }
  }
}, 120_000);
