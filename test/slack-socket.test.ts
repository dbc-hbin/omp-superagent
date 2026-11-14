import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { Server, ServerWebSocket } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { LogLevel } from "@slack/web-api";
import { SocketModeClient } from "@slack/socket-mode";
import type { Inbound } from "../src/contracts.ts";
import { SlackMessenger } from "../src/slack.ts";
import { Store } from "../src/store.ts";

type SocketData = { fixture: true };

// Deadlines bound actual local HTTP/WebSocket I/O, not simulated SDK events.
async function bounded<T>(stage: string, promise: Promise<T>, diagnose: () => unknown): Promise<T> {
  const deadline = Promise.withResolvers<never>();
  const timer = setTimeout(() => deadline.reject(new Error(`Local Slack SDK socket fixture timed out at ${stage}: ${JSON.stringify(diagnose())}`)), 4000);
  try { return await Promise.race([promise, deadline.promise]); }
  finally { clearTimeout(timer); }
}

test("official SocketModeClient sustains heartbeat and sends real wire ACK only after durable SQLite admission", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-slack-socket-"));
  const ledgerPath = join(root, "coordination.sqlite");
  const store = new Store(ledgerPath);
  const team = "TLOCAL";
  const botToken = "xoxb-local-fixture-only";
  const appToken = "xapp-local-fixture-only";
  const sourceTimestamp = "1000.000001";
  const sourceId = `slack:${team}:UBOT:CALLOWED:${sourceTimestamp}:original`;
  const trigger = "opaque-real-sdk-trigger-capability";
  const invocationId = createHash("sha256").update(JSON.stringify(["ALOCAL", team, "UOWNER", "CALLOWED", trigger])).digest("hex");
  const commandId = `slack:${team}:UBOT:CALLOWED:invocation:${invocationId}`;
  const peerReady = Promise.withResolvers<ServerWebSocket<SocketData>>();
  const entered = Promise.withResolvers<Inbound>();
  const permitAdmission = Promise.withResolvers<void>();
  const wireAck = Promise.withResolvers<void>();
  const retryAck = Promise.withResolvers<void>();
  const commandEntered = Promise.withResolvers<Inbound>();
  const permitCommand = Promise.withResolvers<void>();
  const commandAck = Promise.withResolvers<void>();
  const commandRetryAck = Promise.withResolvers<void>();
  const clientHeartbeat = Promise.withResolvers<void>();
  const serverHeartbeat = Promise.withResolvers<void>();
  const sdkServerHeartbeat = Promise.withResolvers<void>();
  const errors: string[] = [];
  const requests: { method: string; authorization: string | null; hostname: string }[] = [];
  const acknowledgments: { envelopeId: string; durableRows: number }[] = [];
  const admissions: boolean[] = [];
  const transport: string[] = [];
  let server: Server<SocketData> | undefined;
  let messenger: SlackMessenger | undefined;
  let socket: SocketModeClient | undefined;
  let peer: ServerWebSocket<SocketData> | undefined;
  let serverOpen = false;
  let clientPings = 0;
  let clientPongs = 0;
  let serverPongs = 0;
  let primaryFailure = false;
  const diagnose = () => ({
    requests: requests.map(request => request.method), transport, errors, serverOpen,
    sdkWebsocketExists: !!socket?.websocket, sdkWebsocketActive: socket?.websocket?.isActive(),
    acknowledgments, admissions, clientPings, clientPongs, serverPongs,
  });
  const sdkLog = (level: string, values: unknown[]) => {
    const message = values.map(String).join(" ").replaceAll(botToken, "[redacted]").replaceAll(appToken, "[redacted]");
    transport.push(`${level}: ${message}`);
    if (message.startsWith("WebSocket received pong from Slack server")) {
      clientPongs++;
      if (clientPongs >= 2) clientHeartbeat.resolve();
    }
    if (message.startsWith("WebSocket received ping from Slack server")) sdkServerHeartbeat.resolve();
  };
  try {
    server = Bun.serve<SocketData>({
      hostname: "127.0.0.1", port: 0,
      fetch(request, local) {
        const url = new URL(request.url);
        if (url.pathname === "/socket") {
          transport.push(`server: upgrade ${request.headers.get("upgrade")}`);
          if (local.upgrade(request, { data: { fixture: true } })) return;
          return new Response("WebSocket upgrade required", { status: 400 });
        }
        const method = url.pathname.replace(/^\/api\//, "");
        requests.push({ method, authorization: request.headers.get("authorization"), hostname: url.hostname });
        if (method === "apps.connections.open") return Response.json({ ok: true, url: `ws://127.0.0.1:${local.port}/socket`, app_id: "ALOCAL" });
        if (method === "auth.test") return Response.json({ ok: true, team_id: team, user_id: "UBOT", bot_id: "BBOT" });
        if (method === "bots.info") return Response.json({ ok: true, bot: { id: "BBOT", user_id: "UBOT", app_id: "ALOCAL", team_id: team } });
        if (method === "users.info") return Response.json({ ok: true, user: { id: "UOWNER", team_id: team, is_bot: false, deleted: false } });
        if (method === "conversations.info") return Response.json({ ok: true, channel: { id: "CALLOWED", is_im: false, is_mpim: false, is_member: true, context_team_id: team } });
        return Response.json({ ok: false, error: "method_not_supported_for_channel_type" });
      },
      websocket: {
        open(socket) {
          serverOpen = true;
          transport.push("server: open; sending hello");
          peerReady.resolve(socket);
          socket.send(JSON.stringify({ type: "hello", connection_info: { app_id: "ALOCAL" }, num_connections: 1 }));
        },
        message(_socket, payload) {
          transport.push("server: received websocket frame");
          const frame: unknown = JSON.parse(String(payload));
          if (!frame || typeof frame !== "object" || !("envelope_id" in frame) || typeof frame.envelope_id !== "string") return;
          const reader = new Database(ledgerPath, { readonly: true });
          try {
            const row = reader.query("SELECT COUNT(*) AS count FROM inputs WHERE id = ? AND state = 'pending'").get(frame.envelope_id.startsWith("fixture-slash") ? commandId : sourceId) as { count: number };
            acknowledgments.push({ envelopeId: frame.envelope_id, durableRows: row.count });
          } finally { reader.close(); }
          if (frame.envelope_id === "fixture-original") wireAck.resolve();
          if (frame.envelope_id === "fixture-retry") retryAck.resolve();
          if (frame.envelope_id === "fixture-slash") commandAck.resolve();
          if (frame.envelope_id === "fixture-slash-new-envelope") commandRetryAck.resolve();
        },
        ping(socket, _data) {
          clientPings++;
          transport.push(`server: received client ping ${clientPings}; automatic pong`);
          if (clientPings === 1) socket.ping("server-heartbeat");
        },
        pong(_socket, data) {
          if (data.toString() !== "server-heartbeat") return;
          serverPongs++;
          transport.push("server: received matching pong");
          serverHeartbeat.resolve();
        },
        close(_socket, code, reason) { transport.push(`server: close ${code} ${reason}`); },
      },
    });
    const apiUrl = `http://127.0.0.1:${server.port}/api/`;
    // Supported SDK options point only bootstrap HTTP at our loopback server;
    // the returned ws:// URL is consumed by the real SDK/undici WebSocket.
    // No production protocol engine or test-only production option is added.
    socket = new SocketModeClient({
      appToken, autoReconnectEnabled: false,
      // Exercise the SDK's real periodic control frames, not a guessed sleep or
      // fake clock: completion requires two observed matching client pong events.
      clientPingTimeout: 1500, serverPingTimeout: 3000, pingPongLoggingEnabled: true,
      clientOptions: { slackApiUrl: apiUrl, retryConfig: { retries: 0 }, rejectRateLimitedCalls: true },
      logger: {
        debug(...values: unknown[]) { sdkLog("debug", values); }, info(...values: unknown[]) { sdkLog("info", values); },
        warn(...values: unknown[]) { sdkLog("warn", values); }, error(...values: unknown[]) { sdkLog("error", values); errors.push("SDK transport error"); },
        setLevel(_level: LogLevel) {}, getLevel: () => LogLevel.DEBUG, setName(_name: string) {},
      },
    });
    for (const event of ["connecting", "authenticated", "connected", "disconnected", "close", "error"]) socket.on(event, () => { transport.push(`sdk: ${event}`); });
    socket.on("ws_message", () => { transport.push("sdk: received websocket frame"); });
    messenger = new SlackMessenger({
      botToken, appToken, ownerId: "UOWNER", teamId: team, allowedChannelIds: ["CALLOWED"], socket,
      webClientOptions: { slackApiUrl: apiUrl }, onError: error => errors.push(String(error)),
    });
    await bounded("auth/connect/hello", messenger.start({
      message: async input => {
        if (input.messageId === null) { commandEntered.resolve(input); await permitCommand.promise; }
        else { entered.resolve(input); await permitAdmission.promise; }
        admissions.push(store.receive(input, "main"));
      },
      answer: async () => { throw new Error("Unexpected approval in local Slack intake fixture"); },
    }), diagnose);
    peer = await bounded("server peer readiness", peerReady.promise, diagnose);
    const payload = {
      type: "events_api", envelope_id: "fixture-original", accepts_response_payload: false,
      payload: {
        type: "event_callback", team_id: team, event_id: "independent-event-id",
        event: { type: "message", user: "UOWNER", team, channel: "CALLOWED", channel_type: "channel", text: "Local real SDK intake", ts: sourceTimestamp },
      },
    };
    peer.send(JSON.stringify(payload));
    const input = await bounded("event admission entry", entered.promise, diagnose);
    expect(input.id).toBe(sourceId);
    expect(input.route.accountId).toBe(`${team}:UBOT`);
    expect(store.input(sourceId)).toBeNull();
    expect(acknowledgments).toEqual([]);
    permitAdmission.resolve();
    await bounded("durable original wire ACK", wireAck.promise, diagnose);
    expect(acknowledgments).toEqual([{ envelopeId: "fixture-original", durableRows: 1 }]);
    expect(store.input(sourceId)?.text).toBe("Local real SDK intake");

    await bounded("two client ping/pong cycles and server ping/pong", Promise.all([clientHeartbeat.promise, serverHeartbeat.promise, sdkServerHeartbeat.promise]), diagnose);
    expect(clientPings).toBeGreaterThanOrEqual(2);
    expect(clientPongs).toBeGreaterThanOrEqual(2);
    expect(serverPongs).toBe(1);
    expect(socket.websocket?.isActive()).toBe(true);
    expect(transport).not.toContain("sdk: disconnected");

    peer.send(JSON.stringify({ ...payload, envelope_id: "fixture-retry", retry_attempt: 1 }));
    await bounded("duplicate wire ACK", retryAck.promise, diagnose);
    expect(admissions).toEqual([true, false]);
    expect(store.inputs("main")).toHaveLength(1);
    expect(acknowledgments).toEqual([{ envelopeId: "fixture-original", durableRows: 1 }, { envelopeId: "fixture-retry", durableRows: 1 }]);
    const slashPayload = {
      type: "slash_commands", envelope_id: "fixture-slash", accepts_response_payload: true,
      payload: { team_id: team, api_app_id: "ALOCAL", user_id: "UOWNER", channel_id: "CALLOWED", command: "/superagent-status", text: "",
        trigger_id: trigger, response_url: "https://hooks.slack.com/commands/never-persist-response-capability", token: "never-persist-token" },
    };
    peer.send(JSON.stringify(slashPayload));
    const commandInput = await bounded("real slash admission entry", commandEntered.promise, diagnose);
    expect(commandInput).toMatchObject({ id: commandId, messageId: null, invocationId, text: "/status" });
    expect(store.input(commandId)).toBeNull();
    expect(acknowledgments).toHaveLength(2);
    permitCommand.resolve();
    await bounded("durable slash wire ACK", commandAck.promise, diagnose);
    peer.send(JSON.stringify({ ...slashPayload, envelope_id: "fixture-slash-new-envelope", retry_attempt: 1, retry_reason: "timeout" }));
    await bounded("changed envelope slash retry ACK", commandRetryAck.promise, diagnose);
    expect(admissions).toEqual([true, false, true, false]);
    expect(store.inputs("main")).toHaveLength(2);
    expect(acknowledgments.slice(2)).toEqual([{ envelopeId: "fixture-slash", durableRows: 1 }, { envelopeId: "fixture-slash-new-envelope", durableRows: 1 }]);
    const storedCommand = JSON.stringify(store.input(commandId));
    for (const secret of [trigger, "trigger_id", "response_url", "never-persist-response-capability", "never-persist-token"]) expect(storedCommand).not.toContain(secret);
    expect(requests.filter(request => request.method === "apps.connections.open")).toEqual([{ method: "apps.connections.open", authorization: `Bearer ${appToken}`, hostname: "127.0.0.1" }]);
    expect(requests.filter(request => request.method !== "apps.connections.open").every(request => request.hostname === "127.0.0.1" && request.authorization === `Bearer ${botToken}`)).toBe(true);
    expect(errors).toEqual([]);
  } catch (error) { primaryFailure = true; throw error; }
  finally {
    permitAdmission.resolve();
    permitCommand.resolve();
    try { if (messenger) await bounded("shutdown", messenger.stop(), diagnose); }
    catch (error) { if (!primaryFailure) throw error; }
    finally {
      peer?.close();
      await server?.stop(true);
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  }
}, 15_000);
