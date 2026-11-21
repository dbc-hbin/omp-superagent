import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { runRestrictedGroup } from "../src/group-runner";
import { nativeTestArgv } from "./fixtures/native-command";

const wireSchema = Type.Object({
  model: Type.String(),
  tools: Type.Optional(Type.Array(Type.Object({ function: Type.Object({ name: Type.String() }) }))),
  messages: Type.Array(Type.Object({ role: Type.String(), content: Type.Unknown(), tool_call_id: Type.Optional(Type.String()) })),
});
type Wire = Static<typeof wireSchema>;
type ToolCall = readonly [id: string, name: string, args: Record<string, string>];
const nativeEnabled = process.env.OMP_SUPERAGENT_NATIVE_TEST === "1";
const executable = nativeEnabled ? nativeTestArgv()[0] : "";
const help = nativeEnabled ? spawnSync(executable, ["--help"], { encoding: "utf8", timeout: 30_000 }) : undefined;
if (help && help.status !== 0) throw new Error("Cannot read stock OMP capability help");
const capable = help?.stdout.includes("--no-context-files") === true && help.stdout.includes("--max-cost") &&
  help.stdout.includes("--no-prewalk");
const model = "restricted-test/local-fixture";

function response(delta: { readonly content: string } | { readonly tool_calls: readonly object[] }, status: string) {
  const row = { id: "chatcmpl-local", model: "local-fixture", object: "chat.completion.chunk", created: 1 };
  const chunk = (value: object, reason: string | null) => `data: ${JSON.stringify({ ...row,
    choices: [{ index: 0, delta: value, finish_reason: reason }],
  })}\n\n`;
  return new Response(chunk({ role: "assistant", ...delta }, null) + chunk({}, status) + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } });
}

function toolResponse(calls: readonly ToolCall[]) {
  return response({ tool_calls: calls.map(([id, name, args], index) => ({
    index, id, type: "function", function: { name, arguments: JSON.stringify(args) },
  })) }, "tool_calls");
}

async function fixture(handler: (wire: Wire, state: string, count: number) => Response | Promise<Response>) {
  const root = await mkdtemp(join(tmpdir(), "omp-sa-group-test-"));
  const stateDir = join(root, "group-state");
  const requests: Wire[] = [];
  const paths: string[] = [];
  await mkdir(stateDir, { mode: 0o700 });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    paths.push(new URL(request.url).pathname);
    if (request.method !== "POST") return new Response("", { status: 404 });
    const wire: unknown = await request.json();
    if (!Value.Check(wireSchema, wire)) return new Response("Invalid fixture request", { status: 400 });
    requests.push(wire);
    return handler(wire, stateDir, requests.length);
  } });
  await writeFile(join(stateDir, "models.yml"), JSON.stringify({ providers: { "restricted-test": {
    api: "openai-completions", apiKey: "local-only-group-fixture", baseUrl: `${server.url.origin}/v1`,
    models: [{ id: "local-fixture", name: "Restricted fixture", contextWindow: 32768, maxTokens: 4096,
      cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }],
  } } }), { mode: 0o600 });
  return { root, stateDir, requests, paths, async cleanup() {
    await server.stop(true);
    await rm(root, { recursive: true, force: true });
  } };
}

function git(root: string, ...args: string[]): string {
  const result = spawnSync("/usr/bin/git", args, { cwd: root, encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  if (result.status !== 0) throw new Error(`Fixture Git ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
}

test.skipIf(!capable)("restricted chat makes stateless requests without tools or filesystem expansion", async () => {
  const fx = await fixture((_wire, _state, count) => response({ content: `local answer ${count}` }, "stop"));
  try {
    const canary = "RESTRICTED_CHAT_NEVER_READ_OWNER_CONFIG";
    const ownerAgent = join(fx.root, "owner-agent");
    await mkdir(ownerAgent);
    await writeFile(join(ownerAgent, "AGENTS.md"), canary);
    const selectionBefore = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = ownerAgent;
    try {
      const run = { mode: "chat", id: "group:one", stateDir: fx.stateDir, executable, model } as const;
      expect(await runRestrictedGroup({ ...run, text: `@${join(ownerAgent, "AGENTS.md")}` }))
        .toEqual({ ok: true, text: "local answer 1" });
      expect(await runRestrictedGroup({ ...run, id: "group:two", text: "second chat message" }))
        .toEqual({ ok: true, text: "local answer 2" });
    } finally {
      if (selectionBefore === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = selectionBefore;
    }
    expect(fx.paths).toEqual(["/v1/chat/completions", "/v1/chat/completions"]);
    expect(fx.requests.map(request => [request.model, request.tools ?? []])).toEqual([
      ["local-fixture", []], ["local-fixture", []],
    ]);
    const userMessages = fx.requests.map(request => request.messages.filter(message => message.role === "user"));
    expect(userMessages.map(messages => messages.length)).toEqual([1, 1]);
    for (const [index, input] of [`@${join(ownerAgent, "AGENTS.md")}`, "second chat message"].entries()) {
      const blocks: unknown = userMessages[index]?.[0]?.content;
      expect(blocks).toEqual(expect.arrayContaining([{
        type: "text", text: JSON.stringify(input).replaceAll("@", "\\u0040"),
      }]));
    }
    expect(JSON.stringify(fx.requests)).not.toContain(canary);
  } finally { await fx.cleanup(); }
}, 120_000);

test.skipIf(!capable)("restricted work edits only its detached checkout, without Git hooks, filters or messenger output", async () => {
  const original = "committed content\n";
  const localResult = "WORK_RESULT_MUST_NOT_BE_SENT";
  const scopeSecret = "WORK_PATH_MUST_NOT_READ_OUTSIDE";
  const fx = await fixture(async (_wire, stateDir, count) => {
    if (count !== 1) return response({ content: localResult }, "stop");
    const checkout = join(stateDir, (await readdir(stateDir)).find(name => name.startsWith("work-")) ?? "", "checkout");
    await link(join(stateDir, "external.txt"), join(checkout, "hardlink.txt"));
    return toolResponse([
      ["list", "group_list", { path: "." }],
      ["read", "group_read", { path: "file.txt" }],
      ["dot", "group_read", { path: ".env" }],
      ["git", "group_read", { path: ".git" }],
      ["escape", "group_read", { path: "../../../external.txt" }],
      ["absolute", "group_read", { path: join(stateDir, "external.txt") }],
      ["symlink", "group_read", { path: "link.txt" }],
      ["hardlink", "group_read", { path: "hardlink.txt" }],
      ["hardedit", "group_edit", { path: "hardlink.txt", text: "do not write" }],
      ["large", "group_read", { path: "large.txt" }],
      ["edit", "group_edit", { path: "file.txt", text: "group edit\n" }],
    ]);
  });
  try {
    const repo = join(fx.root, "repo");
    const marker = join(fx.root, "git-executed");
    await mkdir(repo);
    await writeFile(join(fx.stateDir, "external.txt"), scopeSecret);
    git(repo, "init");
    await writeFile(join(repo, "file.txt"), original);
    await writeFile(join(repo, ".env"), scopeSecret);
    await writeFile(join(repo, "large.txt"), "x".repeat(32 * 1024 + 1));
    await writeFile(join(repo, "AGENTS.md"), scopeSecret);
    await symlink(join(fx.stateDir, "external.txt"), join(repo, "link.txt"));
    await writeFile(join(repo, ".gitattributes"), "file.txt filter=scope-fixture\n");
    git(repo, "add", ".");
    git(repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "setup");
    git(repo, "config", "filter.scope-fixture.smudge", `touch '${marker}'; cat`);
    await writeFile(join(repo, ".git/hooks/post-checkout"), `#!/bin/sh\ntouch '${marker}'\n`);
    await chmod(join(repo, ".git/hooks/post-checkout"), 0o700);
    await writeFile(join(repo, "file.txt"), "owner uncommitted content\n");

    const result = await runRestrictedGroup({ mode: "work", text: `Make a bounded group edit @${join(fx.stateDir, "external.txt")}`, id: "job:edit",
      repository: repo, executable, model, stateDir: fx.stateDir });
    expect(result.ok).toBe(true);
    expect(result.text).toBeUndefined();
    if (!result.worktree) throw new Error("Restricted work did not return its local checkout");
    expect(git(result.worktree, "rev-parse", "HEAD")).toBe(git(repo, "rev-parse", "HEAD"));
    expect(git(result.worktree, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
    expect(await readFile(join(result.worktree, "file.txt"), "utf8")).toBe("group edit\n");
    expect(await readFile(join(repo, "file.txt"), "utf8")).toBe("owner uncommitted content\n");
    expect(await readFile(join(fx.stateDir, "external.txt"), "utf8")).toBe(scopeSecret);
    expect(await Bun.file(marker).exists()).toBe(false);
    expect(fx.paths).toEqual(["/v1/chat/completions", "/v1/chat/completions"]);
    expect(fx.requests.map(request => request.tools?.map(tool => tool.function.name).sort())).toEqual([
      ["group_edit", "group_list", "group_read"], ["group_edit", "group_list", "group_read"],
    ]);
    const toolData = fx.requests[1]?.messages?.filter(message => message.role === "tool");
    const byId = Object.fromEntries((toolData ?? []).map(entry => [entry.tool_call_id, entry.content]));
    expect(Object.keys(byId).sort()).toEqual(["absolute", "dot", "edit", "escape", "git", "hardedit", "hardlink", "large", "list", "read", "symlink"]);
    expect(JSON.stringify(byId.list)).toContain("file.txt");
    expect(JSON.stringify(byId.list)).not.toMatch(/\.env|\.git|large\.txt|link\.txt/);
    expect(JSON.stringify(byId.read)).toContain(original.trim());
    expect(JSON.stringify(fx.requests)).not.toContain(scopeSecret);
  } finally { await fx.cleanup(); }
}, 240_000);

test.skipIf(!capable)("cancelling a live restricted request does not deliver model text", async () => {
  const stop = new AbortController();
  const fx = await fixture(() => {
    stop.abort();
    return response({ content: "do not deliver an aborted answer" }, "stop");
  });
  try {
    expect(await runRestrictedGroup({ mode: "chat", text: "test cancellation", id: "job:cancel",
      executable, model, stateDir: fx.stateDir, signal: stop.signal })).toEqual({ ok: false });
    expect(fx.paths).toEqual(["/v1/chat/completions"]);
  } finally { await fx.cleanup(); }
}, 60_000);

test.skipIf(!nativeEnabled)("restricted chat refuses a symlink to a different provider state directory", async () => {
  const fx = await fixture(() => response({ content: "not a restricted profile" }, "stop"));
  try {
    const stateLink = join(fx.root, "borrowed-provider-state");
    await symlink(fx.stateDir, stateLink);
    expect(await runRestrictedGroup({ mode: "chat", text: "not admitted", id: "job:symlink",
      executable, model, stateDir: `${stateLink}/` })).toEqual({ ok: false });
    expect(fx.paths).toEqual([]);
  } finally { await fx.cleanup(); }
});

test.skipIf(!nativeEnabled || capable)("stock OMP without restricted launch capabilities cannot request the provider", async () => {
  const fx = await fixture(() => response({ content: "unsafe CLI admitted a provider request" }, "stop"));
  try {
    expect(await runRestrictedGroup({ mode: "chat", text: "not admitted", id: "job:incompatible",
      executable, model, stateDir: fx.stateDir })).toEqual({ ok: false });
    expect(fx.paths).toEqual([]);
  } finally { await fx.cleanup(); }
});
