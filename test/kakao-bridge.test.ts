import { afterEach, expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOKEN_HEADER, startReferenceBridge, type ReferenceBridge } from "../scripts/kakao-reference-bridge";

const token = "reference-bridge-token-0123456789";
const bridges: ReferenceBridge[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const bridge of bridges.splice(0)) await bridge.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function bridge(): ReferenceBridge {
  const started = startReferenceBridge({ token, ownerChatId: "777", ownerId: "42" });
  bridges.push(started);
  return started;
}

const auth = { [TOKEN_HEADER]: token };
type Page = { generation: string; latest: number; messages: Record<string, unknown>[] };
const inbox = (b: ReferenceBridge, query: string, headers: Record<string, string> = auth) =>
  fetch(`${b.url}/superagent/inbox?${query}`, { headers });
const page = async (b: ReferenceBridge, query: string) => await (await inbox(b, query)).json() as Page;
const send = (b: ReferenceBridge, body: unknown, headers: Record<string, string> = auth) =>
  fetch(`${b.url}/superagent/send`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });

test("inbox baselines a new generation without replaying history", async () => {
  const b = bridge();
  b.inject({ logId: "10", text: "old command" });
  const first = await page(b, "after=0&generation=&limit=50");
  expect(first).toEqual({ generation: b.generation, latest: 1, messages: [] });
  b.inject({ logId: "11", text: "new" });
  const next = await page(b, `after=1&generation=${b.generation}&limit=50`);
  expect(next.messages).toEqual([{ id: 2, logId: "11", chatId: "777", senderId: "42", text: "new", receivedAtMs: expect.any(Number), stale: false }]);
  // A cursor ahead of the inbox under the same generation forces a new baseline.
  const before = b.generation;
  const rolled = await page(b, `after=99&generation=${before}&limit=50`);
  expect(rolled.generation).not.toBe(before);
  expect(rolled.messages).toEqual([]);
});

test("inbox holds only the owner's one-to-one messages and honours the page limit", async () => {
  const b = bridge();
  expect(b.inject({ logId: "1", text: "other sender", senderId: "5" })).toBe(0);
  expect(b.inject({ logId: "2", text: "other chat", chatId: "778" })).toBe(0);
  for (let i = 3; i < 10; i++) b.inject({ logId: String(i), text: "owner" });
  const limited = await page(b, `after=0&generation=${b.generation}&limit=3`);
  expect(limited.messages.map(row => row.logId)).toEqual(["3", "4", "5"]);
});

test("requests need exactly the token and no forwarding or browser headers", async () => {
  const b = bridge();
  expect((await inbox(b, "after=0", {})).status).toBe(403);
  expect((await inbox(b, "after=0", { [TOKEN_HEADER]: `${token}x` })).status).toBe(403);
  expect((await inbox(b, "after=0", { [TOKEN_HEADER]: "short" })).status).toBe(403);
  for (const header of ["X-Forwarded-For", "Forwarded", "X-Real-IP", "CF-Connecting-IP", "Origin", "Referer", "Sec-Fetch-Site"])
    expect((await inbox(b, "after=0", { ...auth, [header]: "x" })).status).toBe(403);
  const repeated = new Headers();
  repeated.append(TOKEN_HEADER, token);
  repeated.append(TOKEN_HEADER, token);
  expect((await fetch(`${b.url}/superagent/inbox?after=0`, { headers: repeated })).status).toBe(403);
  expect((await inbox(b, "after=0")).status).toBe(200);
});

test("send delivers each pushId once, only to the owner chat, and validates input", async () => {
  const b = bridge();
  const message = { pushId: "sa-abc-0-1", outputId: "out-1", message: "hi", chatId: "999" };
  expect(await (await send(b, message)).json()).toEqual({ ok: true, state: "queued" });
  expect(await (await send(b, message)).json()).toEqual({ ok: true, state: "delivered" });
  expect(b.deliveries).toEqual([{ pushId: "sa-abc-0-1", outputId: "out-1", message: "hi" }]);
  expect((await send(b, { pushId: "bad id", message: "hi" })).status).toBe(400);
  expect((await send(b, { pushId: "sa-x", message: "   " })).status).toBe(400);
  expect((await send(b, { pushId: "sa-x", message: "가".repeat(1501) })).status).toBe(400);
  b.quiet = true;
  expect((await send(b, { pushId: "sa-y", message: "hi" })).status).toBe(409);
  expect((await send(b, { pushId: "sa-y", message: "hi" }, {})).status).toBe(403);
});

test("configuration accepts only a literal loopback bridge and distinct identities", async () => {
  const load = async (kakao: Record<string, unknown>) => {
    const dir = mkdtempSync(join(tmpdir(), "superagent-kakao-"));
    dirs.push(dir);
    const path = join(dir, "config.json");
    await Bun.write(path, JSON.stringify({ stateDir: "state", headCwd: dir, command: ["omp"], maxHosts: 2, maxSubagents: 2, idleMs: 1000,
      kakao: { bridgeUrl: "http://127.0.0.1:8080", tokenEnv: "KAKAO_SUPERAGENT_TOKEN", botUserId: "900", ownerId: "42", chatId: "777", ...kakao } }));
    return loadConfig(path);
  };
  expect((await load({})).kakao?.chatId).toBe("777");
  expect((await load({ bridgeUrl: "http://[::1]:8080/kakao/" })).kakao?.bridgeUrl).toBe("http://[::1]:8080/kakao/");
  for (const bridgeUrl of ["http://localhost:8080", "http://0.0.0.0:8080", "https://127.0.0.1:8080", "http://127.0.0.1:8080/?t=1", "http://u:p@127.0.0.1:8080", "not a url"])
    await expect(load({ bridgeUrl })).rejects.toThrow("kakao.bridgeUrl");
  await expect(load({ ownerId: "900" })).rejects.toThrow("must differ");
  await expect(load({ chatId: "0777" })).rejects.toThrow("kakao.chatId");
  await expect(load({ tokenEnv: "abc-def" })).rejects.toThrow("environment variable");
});
