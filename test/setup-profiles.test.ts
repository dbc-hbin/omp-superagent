import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Config } from "../src/config";
import { setupBotProfiles } from "../src/setup-profiles";
import { loopbackOperator } from "./fixtures/operator";

const image = readFileSync(new URL("../assets/superagent-avatar.jpg", import.meta.url));
const credentials = { DISCORD_PROFILE: "private-discord-profile-token", TELEGRAM_PROFILE: "900:private-telegram-profile-token" };
const config: Config = {
  path: "/unused/config.json", stateDir: "/unused/state", headCwd: "/unused",
  command: ["must-not-start"], maxHosts: 4, maxSubagents: 8, idleMs: 300000,
  discord: { tokenEnv: "DISCORD_PROFILE", ownerId: "42", allowedGuildIds: [], allowedChannelIds: [] },
  telegram: { tokenEnv: "TELEGRAM_PROFILE", ownerId: "42", allowedChatIds: [] },
};

type Failure = "identity" | "write" | "receipt" | "readback";

function profiles(options: {
  readonly discord?: Failure;
  readonly telegram?: Failure;
  readonly onDiscordPatch?: () => void;
} = {}) {
  const discord: { method: string; credential: string | undefined; body?: unknown }[] = [];
  const telegram: { method: string; credential: string; body: unknown; contentType: string | null }[] = [];
  const run = loopbackOperator(async request => {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/api/v10/users/%40me") {
      const method = request.method;
      const authorization = request.headers.get("authorization");
      expect(authorization).toStartWith("Bot ");
      const credential = authorization?.slice("Bot ".length);
      if (method === "GET") {
        discord.push({ method, credential });
        return Response.json({ id: "900", bot: options.discord !== "identity", avatar: discord.length > 1
          ? options.discord === "readback" ? "wrong-avatar" : "new-avatar" : null });
      }
      if (method === "PATCH") {
        discord.push({ method, credential, body: await request.json() });
        options.onDiscordPatch?.();
        if (options.discord === "write")
          return Response.json({ message: credentials.DISCORD_PROFILE }, { status: 429, headers: { "retry-after": "1" } });
        return Response.json({ id: "900", bot: true, avatar: "new-avatar" });
      }
      throw new Error("Forbidden Discord profile method");
    }
    const match = /^\/bot([^/]+)\/([^/]+)$/.exec(pathname);
    if (!match?.[1] || !match[2] || request.method !== "POST") throw new Error("Forbidden Telegram profile route");
    const credential = decodeURIComponent(match[1]);
    const method = match[2];
    // Consume the multipart at the HTTP boundary; keep the parsed payload for assertions.
    const body: unknown = method === "setMyProfilePhoto" ? await request.formData() : await request.json();
    telegram.push({ method, credential, body, contentType: request.headers.get("content-type") });
    let result: unknown;
    if (method === "getMe") result = { id: 900, is_bot: options.telegram !== "identity", first_name: "Bot" };
    else if (method === "setMyProfilePhoto") {
      if (options.telegram === "write")
        return Response.json({ description: `https://api.telegram.org/bot${credential}/setMyProfilePhoto` }, { status: 500 });
      result = options.telegram !== "receipt";
    } else if (method === "getUserProfilePhotos") result = options.telegram === "readback"
      ? { total_count: 0, photos: [] }
      : { total_count: 1, photos: [[{ file_id: "new-file", file_unique_id: "new-unique", width: 1254, height: 1254 }]] };
    else throw new Error(`Forbidden Telegram API: ${method}`);
    return Response.json({ ok: true, result });
  });
  return { discord, telegram, run };
}

describe("setup mascot profiles", () => {
  test("sets both configured bot profiles with the repository JPEG and reads them back", async () => {
    const http = profiles();
    const result = await setupBotProfiles(config, credentials, http);
    expect(result.map(row => [row.platform, row.status])).toEqual([["discord", "applied"], ["telegram", "applied"]]);
    expect(http.discord.every(call => call.credential === credentials.DISCORD_PROFILE)).toBe(true);
    expect(http.telegram.every(call => call.credential === credentials.TELEGRAM_PROFILE)).toBe(true);
    expect(http.discord.map(call => call.method)).toEqual(["GET", "PATCH", "GET"]);
    expect(http.discord[1]?.body).toEqual({ avatar: `data:image/jpeg;base64,${image.toString("base64")}` });
    expect(http.telegram.map(call => call.method)).toEqual(["getMe", "setMyProfilePhoto", "getUserProfilePhotos"]);
    const upload = http.telegram[1];
    if (!(upload?.body instanceof FormData)) throw new Error("No upload was received");
    expect(upload.contentType).toContain("multipart/form-data");
    const form = upload.body;
    const descriptor = form.get("photo");
    if (typeof descriptor !== "string") throw new Error("Missing Telegram static-photo descriptor");
    const spec: { type: unknown; photo?: string } = JSON.parse(descriptor);
    expect(spec).toEqual({ type: "static", photo: expect.stringMatching(/^attach:\/\//) });
    const part = spec.photo && form.get(spec.photo.slice("attach://".length));
    if (!(part instanceof File)) throw new Error("Missing Telegram attachment");
    expect(part.name).toBe("superagent-avatar.jpg");
    expect(part.type).toBe("image/jpeg");
    expect(Buffer.from(await part.arrayBuffer()).equals(image)).toBe(true);
    expect(http.telegram[2]?.body).toEqual({ user_id: 900, limit: 1 });
    expect(JSON.stringify(result)).not.toContain(credentials.DISCORD_PROFILE);
    expect(JSON.stringify(result)).not.toContain(credentials.TELEGRAM_PROFILE);
  });

  test.each(["identity", "write", "readback"] as const)("Discord %s failure is sanitized without retries and does not block Telegram", async failure => {
    const http = profiles({ discord: failure });
    const result = await setupBotProfiles(config, credentials, http);
    expect(result.map(row => row.status)).toEqual(["failed", "applied"]);
    expect(http.discord.map(call => call.method)).toEqual(
      failure === "identity" ? ["GET"] : failure === "write" ? ["GET", "PATCH"] : ["GET", "PATCH", "GET"],
    );
    expect(result[0]?.message).toContain(failure === "identity" ? "no Discord profile update was attempted" : "unresolved");
    expect(JSON.stringify(result)).not.toContain(credentials.DISCORD_PROFILE);
  });

  test.each(["identity", "write", "receipt", "readback"] as const)("Telegram %s failure is sanitized without retries", async failure => {
    const http = profiles({ telegram: failure });
    const result = await setupBotProfiles({ ...config, discord: undefined }, credentials, http);
    expect(result[0]?.status).toBe("failed");
    expect(http.telegram.map(call => call.method)).toEqual(failure === "identity" ? ["getMe"] : failure === "readback"
      ? ["getMe", "setMyProfilePhoto", "getUserProfilePhotos"] : ["getMe", "setMyProfilePhoto"]);
    expect(result[0]?.message).toContain(failure === "identity" ? "no Telegram profile update was attempted" : "unresolved");
    expect(JSON.stringify(result)).not.toContain(credentials.TELEGRAM_PROFILE);
    expect(JSON.stringify(result)).not.toContain("https://");
  });

  test("does not touch unconfigured platforms or accept missing credentials", async () => {
    const http = profiles();
    const result = await setupBotProfiles({ ...config, discord: undefined }, credentials, http);
    expect(result.map(row => row.platform)).toEqual(["telegram"]);
    expect(http.discord).toHaveLength(0);
    const missing = profiles();
    const failures = await setupBotProfiles(config, {}, missing);
    expect(failures.map(row => row.status)).toEqual(["failed", "failed"]);
    expect(missing.discord).toHaveLength(0);
    expect(missing.telegram).toHaveLength(0);
  });

  test("cancellation during Discord prevents readback and any Telegram request", async () => {
    const abort = new AbortController();
    const http = profiles({ onDiscordPatch: () => abort.abort() });
    const result = await setupBotProfiles(config, credentials, { signal: abort.signal, run: http.run });
    expect(result.map(row => [row.platform, row.status])).toEqual([["discord", "failed"]]);
    expect(result[0]?.message).toContain("unresolved");
    expect(http.discord.map(call => call.method)).toEqual(["GET", "PATCH"]);
    expect(http.telegram).toHaveLength(0);
  });
});
