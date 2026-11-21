import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { authorizeRoute, parseConfig } from "../src/config";
import { DeliveryError } from "../src/delivery";
import { GroupAccess, groupRequests } from "../src/group-access";
import type { GroupReply, GroupRequest } from "../src/group-policy";

const dirs: string[] = [];
afterEach(() => {
  for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

function config() {
  const dir = mkdtempSync(join(tmpdir(), "omp-sa-group-"));
  dirs.push(dir);
  const raw = {
    stateDir: dir, headCwd: dir, command: ["omp"], maxHosts: 2, maxSubagents: 2, idleMs: 1000,
    discord: { ownerId: "1", tokenEnv: "GROUP_DISCORD_TOKEN", allowedGuildIds: ["2"], allowedChannelIds: ["3", "4"] },
    groupRooms: [{ platform: "discord", guildId: "2", channelId: "3", mode: "request", userIds: ["5"], dailyLimit: 1 }],
  };
  const parse = (candidate: unknown) => parseConfig(candidate, join(dir, "config.json"));
  const loaded = parse(raw);
  writeFileSync(loaded.path, JSON.stringify(raw));
  const room = loaded.groupRooms?.at(0);
  if (!room) throw new Error("Missing configured test room");
  const request: GroupRequest = {
    id: "group-discord-original", userId: "5", messageId: "10", mode: room.mode, revision: room.revision,
    route: { platform: "discord", guildId: "2", channelId: "3", threadId: "8", accountId: "9", authorityId: "1" },
    text: "Please review the reference documentation.",
  };
  return { loaded, raw, parse, request };
}

test("attaching a group policy removes owner authority in inherited threads and refuses open grants", () => {
  const { loaded, parse, raw, request } = config();
  expect(authorizeRoute(loaded, request.route)).toBe(false);
  expect(authorizeRoute(loaded, { ...request.route, channelId: "4", threadId: null })).toBe(true);
  const room = raw.groupRooms[0];
  expect(() => parse({ ...raw, groupRooms: [{ ...room, userIds: ["*"] }] })).toThrow("allowlist");
  expect(() => parse({ ...raw, groupRooms: [{ ...room, channelId: "6" }] })).toThrow("parent channel");
  expect(() => parse({ ...raw, groupRooms: [room, room] })).toThrow("duplicates");
});

test("only the exact authorized fresh request reaches the private inbox and sends a content-free receipt", async () => {
  const { loaded, request } = config();
  const sent: GroupReply[] = [];
  const group = new GroupAccess(loaded, { sendGroup: async reply => { sent.push(reply); return "12"; } });
  try {
    expect(() => group.accept({ ...request, userId: "1" })).toThrow("not authorized");
    expect(() => group.accept({ ...request, mode: "work" })).toThrow("not authorized");
    group.accept(request);
    group.accept(request);
    expect(() => group.accept({ ...request, text: "Replace the original" })).toThrow("identity conflict");
    expect(() => group.accept({ ...request, id: "over-budget", messageId: "11" })).toThrow("budget exceeded");
    group.tick(true, error => { throw error; });
  } finally { await group.stop(); }
  expect(sent).toEqual([{ sourceId: request.id, outcome: "received" }]);
  const cli = Bun.spawn([process.execPath, "--no-env-file", "src/cli.ts", "group", request.id, "--config", loaded.path],
    { stdout: "pipe", stderr: "inherit" });
  const [result, code] = await Promise.all([new Response(cli.stdout).json(), cli.exited]);
  expect(code).toBe(0);
  expect(result).toEqual([{
    ...request, state: "received", worktree: null, delivery: [{ outcome: "received", state: "sent", remoteId: "12" }],
  }]);
});

test("ambiguous group receipts are not resent and old-policy inputs cannot be readmitted", async () => {
  const { loaded, parse, raw, request } = config();
  const sent: string[] = [];
  const messenger = { sendGroup: async (reply: GroupReply) => {
    sent.push(reply.sourceId);
    throw new DeliveryError("Platform settlement unavailable", "uncertain");
  } };
  const group = new GroupAccess(loaded, messenger);
  group.accept(request);
  group.tick(true, error => { throw error; });
  await group.stop();
  const changed = parse({ ...raw, groupRooms: [{ ...raw.groupRooms[0], dailyLimit: 2 }] });
  const restarted = new GroupAccess(changed, messenger);
  expect(() => restarted.accept(request)).toThrow("not authorized");
  restarted.tick(true, error => { throw error; });
  await restarted.stop();
  expect(sent).toEqual([request.id]);
  expect(groupRequests(loaded.stateDir, request.id)[0]?.delivery).toEqual([{ outcome: "received", state: "uncertain", remoteId: null }]);
});

test("a work request cannot occupy a runner slot without a confirmed kickoff", async () => {
  const { loaded, parse, raw, request } = config();
  const work = parse({ ...raw, groupRooms: [{
    ...raw.groupRooms[0], mode: "work", repository: loaded.headCwd, model: "test/group-model",
  }] });
  const room = work.groupRooms?.at(0);
  if (room?.mode !== "work") throw new Error("Missing work mode test policy");
  const pending = Promise.withResolvers<string>();
  const group = new GroupAccess(work, { sendGroup: () => pending.promise });
  group.accept({ ...request, mode: room.mode, revision: room.revision });
  group.tick(true, error => { throw error; });
  expect(group.running).toBe(false);
  expect(groupRequests(work.stateDir, request.id)[0]?.state).toBe("pending");
  pending.reject(new DeliveryError("Kickoff confirmation lost", "uncertain"));
  await group.stop();
  expect(groupRequests(work.stateDir, request.id)[0]?.state).toBe("receipt_blocked");
});

test("a missing OMP executable settles restricted chat without retrying or exposing its name", async () => {
  const { parse, raw, request } = config();
  const chat = parse({ ...raw, command: ["omp-sa-missing-group-test-executable"], groupRooms: [{
    ...raw.groupRooms[0], mode: "chat", model: "test/group-model",
  }] });
  const room = chat.groupRooms?.at(0);
  if (room?.mode !== "chat") throw new Error("Missing chat mode test policy");
  const sent: GroupReply[] = [];
  const group = new GroupAccess(chat, { sendGroup: async reply => { sent.push(reply); return "13"; } });
  try {
    group.accept({ ...request, mode: room.mode, revision: room.revision });
    group.tick(true, error => { throw error; });
    expect(groupRequests(chat.stateDir, request.id)[0]?.state).toBe("failed");
  } finally { await group.stop(); }
  expect(sent).toEqual([{ sourceId: request.id, outcome: "failed" }]);
  expect(groupRequests(chat.stateDir, request.id)[0]?.delivery).toEqual([{ outcome: "failed", state: "sent", remoteId: "13" }]);
});
