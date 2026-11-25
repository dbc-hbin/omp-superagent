#!/usr/bin/env bun
/**
 * Reference KakaoTalk bridge for docs/kakao-bridge-protocol.md (version 1).
 *
 * It never connects to Kakao. Messages enter through `inject()` (or the local
 * `POST /demo/owner-message` endpoint in demo mode) and replies are only recorded.
 * Use it to test the Gateway adapter, or as a starting point for a real bridge
 * that you run and are responsible for. Automating a personal KakaoTalk account
 * may violate Kakao's terms of service.
 */
import { timingSafeEqual } from "node:crypto";

export const TOKEN_HEADER = "X-Superagent-Token";
const REFUSED_HEADERS = ["forwarded", "x-forwarded-for", "x-real-ip", "cf-connecting-ip", "origin", "referer", "sec-fetch-site"];
const PUSH_ID = /^sa-[A-Za-z0-9._:-]{1,120}$/;
const KAKAO_ID = /^[1-9]\d{0,19}$/;
const MAX_PUSH = 1_500;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_PAGE = 100;
const STALE_MS = 30 * 60_000;

export interface InboxRow {
  id: number; logId: string; chatId: string; senderId: string; text: string;
  receivedAtMs: number; recordedAtMs: number;
}
export interface Delivery { pushId: string; outputId: string | null; message: string }

export interface BridgeOptions {
  token: string;
  /** The owner's one-to-one chat with the bridge account; the only destination. */
  ownerChatId: string;
  ownerId: string;
  port?: number;
  hostname?: "127.0.0.1" | "::1";
  /** Enables POST /demo/owner-message for local demos. Never expose this. */
  demo?: boolean;
  now?: () => number;
}

export interface ReferenceBridge {
  readonly url: string;
  readonly deliveries: readonly Delivery[];
  generation: string;
  /** Record an owner message as the Kakao side would; returns its row ID. */
  inject(input: { logId: string; text: string; senderId?: string; chatId?: string; receivedAtMs?: number }): number;
  /** Simulate an inbox rebuilt from scratch: new generation, IDs restart. */
  reset(): void;
  quiet: boolean;
  stop(): Promise<void>;
}

function sameToken(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  // Compare equal-length buffers so timing does not reveal the expected length.
  return a.length === b.length ? timingSafeEqual(a, b) : (timingSafeEqual(b, b), false);
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

export function startReferenceBridge(options: BridgeOptions): ReferenceBridge {
  if (!/^[A-Za-z0-9_-]{24,}$/.test(options.token)) throw new Error("Bridge token needs at least 24 characters from [A-Za-z0-9_-]");
  if (!KAKAO_ID.test(options.ownerChatId) || !KAKAO_ID.test(options.ownerId)) throw new Error("Owner chat and user IDs must be numeric");
  const now = options.now ?? Date.now;
  const rows: InboxRow[] = [];
  const deliveries: Delivery[] = [];
  const delivered = new Set<string>();
  let nextId = 1;
  const state = { generation: crypto.randomUUID().replaceAll("-", ""), quiet: false };

  function inject(input: { logId: string; text: string; senderId?: string; chatId?: string; receivedAtMs?: number }): number {
    const chatId = input.chatId ?? options.ownerChatId;
    const senderId = input.senderId ?? options.ownerId;
    // Only the owner's one-to-one chat belongs in the Superagent inbox.
    if (chatId !== options.ownerChatId || senderId !== options.ownerId) return 0;
    const existing = rows.find(row => row.chatId === chatId && row.logId === input.logId);
    if (existing) return existing.id;
    const row = { id: nextId++, logId: input.logId, chatId, senderId, text: input.text,
      receivedAtMs: input.receivedAtMs ?? now(), recordedAtMs: now() };
    rows.push(row);
    return row.id;
  }

  function authorized(request: Request, peer: string | undefined): boolean {
    if (peer !== "127.0.0.1" && peer !== "::1" && peer !== "::ffff:127.0.0.1") return false;
    if (REFUSED_HEADERS.some(name => request.headers.has(name))) return false;
    const values = request.headers.get(TOKEN_HEADER);
    // Fetch joins repeated headers with ", "; a comma is not a valid token character.
    if (values === null || values.includes(",")) return false;
    return sameToken(values, options.token);
  }

  function inbox(url: URL): Response {
    const after = Number(url.searchParams.get("after") ?? "0");
    const generation = url.searchParams.get("generation") ?? "";
    const limit = Number(url.searchParams.get("limit") ?? "50");
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1)
      return json(400, { error: "bad request" });
    const latest = rows.at(-1)?.id ?? 0;
    if (generation === state.generation && after > latest) {
      // IDs went backwards under the same generation: force a new baseline.
      state.generation = crypto.randomUUID().replaceAll("-", "");
    }
    if (generation !== state.generation) return json(200, { generation: state.generation, latest, messages: [] });
    const messages = rows.filter(row => row.id > after).slice(0, Math.min(limit, MAX_PAGE)).map(row => ({
      id: row.id, logId: row.logId, chatId: row.chatId, senderId: row.senderId, text: row.text,
      receivedAtMs: row.receivedAtMs, stale: now() - row.recordedAtMs > STALE_MS,
    }));
    return json(200, { generation: state.generation, latest, messages });
  }

  async function send(request: Request): Promise<Response> {
    const length = Number(request.headers.get("content-length") ?? "0");
    if (!request.headers.get("content-type")?.startsWith("application/json") || length > MAX_REQUEST_BYTES)
      return json(400, { error: "bad request" });
    const raw = await request.text();
    if (raw.length > MAX_REQUEST_BYTES) return json(400, { error: "bad request" });
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { return json(400, { error: "bad request" }); }
    const { pushId, message, outputId } = body ?? {};
    if (typeof pushId !== "string" || !PUSH_ID.test(pushId) || typeof message !== "string"
      || !message.trim() || [...message].length > MAX_PUSH)
      return json(400, { error: "bad request" });
    if (delivered.has(pushId)) return json(200, { ok: true, state: "delivered" });
    if (state.quiet) return json(409, { ok: false });
    delivered.add(pushId);
    // A real bridge sends `message` to options.ownerChatId only. Any destination
    // field in the request body is ignored by construction.
    deliveries.push({ pushId, outputId: typeof outputId === "string" ? outputId : null, message });
    return json(200, { ok: true, state: "queued" });
  }

  const server = Bun.serve({
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port ?? 0,
    async fetch(request, srv) {
      const url = new URL(request.url);
      const peer = srv.requestIP(request)?.address;
      if (options.demo && request.method === "POST" && url.pathname === "/demo/owner-message") {
        if (!authorized(request, peer)) return json(403, { error: "forbidden" });
        const { logId, text } = await request.json() as { logId: string; text: string };
        return json(200, { id: inject({ logId, text }) });
      }
      if (url.pathname !== "/superagent/inbox" && url.pathname !== "/superagent/send") return json(404, { error: "not found" });
      if (!authorized(request, peer)) return json(403, { error: "forbidden" });
      if (url.pathname === "/superagent/inbox" && request.method === "GET") return inbox(url);
      if (url.pathname === "/superagent/send" && request.method === "POST") return send(request);
      return json(405, { error: "method not allowed" });
    },
  });
  const host = server.hostname === "::1" ? "[::1]" : server.hostname;
  return {
    url: `http://${host}:${server.port}`,
    deliveries,
    get generation() { return state.generation; },
    set generation(value: string) { state.generation = value; },
    get quiet() { return state.quiet; },
    set quiet(value: boolean) { state.quiet = value; },
    inject,
    reset() { rows.length = 0; nextId = 1; state.generation = crypto.randomUUID().replaceAll("-", ""); },
    stop: () => server.stop(true),
  };
}

if (import.meta.main) {
  const token = process.env.KAKAO_SUPERAGENT_TOKEN;
  const ownerChatId = process.env.KAKAO_OWNER_CHAT_ID;
  const ownerId = process.env.KAKAO_OWNER_ID;
  if (!token || !ownerChatId || !ownerId) {
    console.error("Set KAKAO_SUPERAGENT_TOKEN, KAKAO_OWNER_CHAT_ID and KAKAO_OWNER_ID. Optional: KAKAO_BRIDGE_PORT.");
    process.exit(2);
  }
  const bridge = startReferenceBridge({ token, ownerChatId, ownerId, port: Number(process.env.KAKAO_BRIDGE_PORT ?? 0), demo: true });
  // First stdout line is the machine-readable base URL.
  console.log(bridge.url);
  console.error("Reference Kakao bridge (no Kakao connection). Replies are printed below.");
  console.error("Inject an owner message: POST /demo/owner-message {\"logId\":\"1\",\"text\":\"hello\"} with the token header.");
  let printed = 0;
  setInterval(() => {
    for (const delivery of bridge.deliveries.slice(printed)) console.log(`[reply ${delivery.pushId}] ${delivery.message}`);
    printed = bridge.deliveries.length;
  }, 500);
}
