import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config";
import type { Inbound, Messenger, Route } from "../src/contracts";
import { startGateway, type GatewayService } from "../src/gateway";
import { main } from "../src/cli";
import { Store } from "../src/store";
import type { ManagedUlwStatus } from "../src/managed-ulw";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 12_000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error("Gateway lifecycle fixture timed out");
    await Bun.sleep(10);
  }
}
const route: Route = { platform: "discord", accountId: "1", authorityId: "2", guildId: null, channelId: "3", threadId: null };
async function fixture(updateManagedUlw?: () => Promise<ManagedUlwStatus>) {
  const root = await mkdtemp(join(await realpath("/tmp"), "ogl-"));
  await chmod(root, 0o700);
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "config.json");
  await writeFile(path, JSON.stringify({ stateDir: root, headCwd: root, maxHosts: 2, maxSubagents: 4, idleMs: 1000,
    command: [process.execPath, fileURLToPath(new URL("./fixtures/gateway-host.ts", import.meta.url))],
    model: "provider/initial-model", discord: { tokenEnv: "GATEWAY_TEST_BOT_TOKEN", ownerId: "2", allowedGuildIds: [], allowedChannelIds: [] } }));
  const config = await loadConfig(path);
  let handlers: Parameters<Messenger["start"]>[0] | undefined;
  let stopped = false;
  const messenger: Messenger = {
    async start(value) { handlers = value; }, async stop() { stopped = true; },
    async send() { return "remote"; }, async showApproval() { return "approval"; }, async dismissApproval() {},
    async createThread(destination) { return destination; }, async fetchAfter() { return null; },
    async openAttachment() { return new Response("fixture"); },
  };
  const saved = process.env.GATEWAY_TEST_BOT_TOKEN;
  process.env.GATEWAY_TEST_BOT_TOKEN = "isolated-test-secret";
  let service: GatewayService;
  try { service = await startGateway(config, { messenger, onError: () => {},
    managedUlwPath: fileURLToPath(new URL("./fixtures/managed-ulw", import.meta.url)), updateManagedUlw }); }
  finally {
    if (saved === undefined) delete process.env.GATEWAY_TEST_BOT_TOKEN;
    else process.env.GATEWAY_TEST_BOT_TOKEN = saved;
  }
  cleanups.push(async () => {
    await rm(join(root, "busy"), { force: true });
    try { await service.stop(); }
    catch {
      const pid = service.status().head.pid;
      if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} }
      await service.close();
    }
  });
  await until(() => service.status().head.ready);
  expect(service.status().head.initialization).toMatchObject({ sessionId: "gateway-fixture-session", state: "complete" });
  return { root, config, service, get stopped() { return stopped; },
    async emit(id: string) {
      const input: Inbound = { id, route, messageId: id, text: id, receivedAt: Date.now(), attachments: [] };
      await handlers!.ready;
      await handlers!.message(input);
    } };
}

test("prepared Gateway starts its head while a source check is pending; failed check does not restart that host", async () => {
  const pending = Promise.withResolvers<ManagedUlwStatus>();
  const f = await fixture(() => pending.promise);
  const pid = f.service.status().head.pid;
  try {
    expect(f.service.status().gateway.ready).toBe(true);
    expect(f.service.status().head.ready).toBe(true);
    expect(f.service.status().ulw?.updating).toBe(true);
    pending.reject(new Error("isolated slow upstream failed"));
    await until(() => f.service.status().ulw?.updating === false);
    expect(f.service.status().ulw?.error).toBe("isolated slow upstream failed");
    expect(f.service.status().head.pid).toBe(pid);
    expect(f.service.status().head.ready).toBe(true);
  } finally {
    pending.resolve({ revision: null, packagePath: null, upstreamRevision: null, checkedAt: null, error: null, updating: false });
  }
});

test("Gateway owns one credential-free native head; busy CLI stop refuses, explicit stop cannot resurrect", async () => {
  const f = await fixture();
  const headStore = new Store(join(f.root, "coordination.sqlite"));
  headStore.close();
  const launches = (await readFile(join(f.root, "launches.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(launches).toHaveLength(1);
  expect(launches[0].credentialPresent).toBe(false);
  expect(launches[0].args).toContain("--session-settings");
  expect(launches[0].args).toContain("provider/initial-model");
  const pid = f.service.status().head.pid;
  await writeFile(join(f.root, "busy"), "busy");
  await expect(main(["stop", "main", "--config", f.config.path])).rejects.toThrow("Host is busy");
  expect(f.service.status().gateway.stopping).toBe(false);
  expect(f.service.status().head.pid).toBe(pid);
  expect(f.stopped).toBe(false);
  await rm(join(f.root, "busy"));
  await main(["stop", "main", "--config", f.config.path]);
  await until(() => f.stopped);
  await Bun.sleep(1100);
  expect((await readFile(join(f.root, "launches.jsonl"), "utf8")).trim().split("\n")).toHaveLength(1);
  expect(existsSync(join(f.root, "run", "gateway.sock"))).toBe(false);
});

test("confirmed-dead owned head restarts, offline input stays durable, and existing native model is not reset", async () => {
  const f = await fixture();
  const coordination = new Store(join(f.root, "coordination.sqlite"));
  const snapshot = { modelRoles: { default: "provider/preset-model", smol: "provider/small-model" }, defaultThinkingLevel: "low" };
  try {
    coordination.setMeta("main:sessionId", "gateway-fixture-session");
    coordination.setMeta("head:model-settings:gateway-fixture-session", JSON.stringify({ settings: snapshot, clearedRoles: ["slow"] }));
    coordination.setMeta("head:model-settings:unrelated-session", JSON.stringify({
      settings: { modelRoles: { default: "provider/wrong-session" } }, clearedRoles: [],
    }));
  } finally { coordination.close(); }
  const old = f.service.status().head.pid!;
  process.kill(old, "SIGKILL");
  await f.emit("offline-original-source");
  expect(f.service.status().gateway.pendingEvents).toBeGreaterThan(0);
  await until(() => f.service.status().head.pid !== old && f.service.status().head.ready);
  await until(async () => existsSync(join(f.root, "received.jsonl")) &&
    (await readFile(join(f.root, "received.jsonl"), "utf8")).includes("offline-original-source"));
  const launches = (await readFile(join(f.root, "launches.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(launches).toHaveLength(2);
  expect(launches[1].args).not.toContain("--model");
  expect(launches[1].args).not.toContain("--model-preset");
  expect(launches[1].config).toMatchObject({
    ...snapshot, modelRoles: { ...snapshot.modelRoles, slow: null },
  });
  const messages = (await readFile(join(f.root, "received.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(messages.map(message => message.id)).toEqual(["offline-original-source"]);
});
