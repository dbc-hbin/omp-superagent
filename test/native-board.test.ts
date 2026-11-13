import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { HostConnection, startHost, type HostFrame } from "../src/host";
import { BoardFixture } from "./fixtures/board";
import { nativeDisabledProviders } from "./fixtures/native-extension";

const nativeTest = process.env.OMP_SUPERAGENT_NATIVE_TEST === "1" ? test : test.skip;

nativeTest("actual unrelated OMP sessions with copied head/lane environment cannot access the board or receive notices", async () => {
  const parsed: unknown = JSON.parse(process.env.OMP_TEST_COMMAND ?? "null");
  if (!Array.isArray(parsed) || !parsed.length || parsed.some(arg => typeof arg !== "string" || !arg)) {
    throw new Error("Native board proof requires OMP_TEST_COMMAND as explicit patched CLI argv JSON");
  }
  const f = new BoardFixture();
  const connections: HostConnection[] = [];
  const pids: number[] = [];
  const home = join(f.directory, "home");
  const agent = join(f.directory, "agent");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(agent, { mode: 0o700 });
  writeFileSync(join(agent, "config.yml"), JSON.stringify({ disabledProviders: nativeDisabledProviders }), { mode: 0o600 });
  writeFileSync(join(agent, "models.yml"), "providers: {}\n", { mode: 0o600 });
  const command = [...parsed, "-e", resolve(import.meta.dir, "../.upstream/omp/packages/coding-agent/test/fixtures/socket-host-smoke-extension.ts")];
  const config = {
    stateDir: f.directory, headCwd: f.directory, command, maxHosts: 2, maxSubagents: 2, idleMs: 0,
    discord: { tokenEnv: "UNUSED_BOARD_FIXTURE_TOKEN", ownerId: "1", allowedGuildIds: [], allowedChannelIds: [] },
  };
  const configPath = join(f.directory, "superagent.json");
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  f.bind("head", "authoritative-head-session");
  f.bind("lane-one", "authoritative-lane-session");
  const writer = f.open("lane-writer");
  writer.post("initial", { text: "Private instance bulletin", channel: "general", mentions: ["head", "lane-one"] });
  try {
    for (const role of ["head", "lane"] as const) {
      const options = {
        command, socketPath: join(f.directory, `${role}.sock`), sessionFile: join(f.directory, `unrelated-${role}.jsonl`),
        cwd: f.directory, extensionPath: resolve(import.meta.dir, "fixtures/board-native-extension.ts"),
        logPath: join(f.directory, `${role}.log`), model: "socket-host-smoke/local", subagentConcurrency: 1,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, USERPROFILE: home,
          PI_CODING_AGENT_DIR: agent, PI_NO_TITLE: "1", CI: "true", NO_COLOR: "1",
          ...(process.env.OMP_TEST_NATIVES_DIR ? { PI_NATIVES_DIR: process.env.OMP_TEST_NATIVES_DIR } : {}),
          XDG_CONFIG_HOME: join(f.directory, "config"), XDG_DATA_HOME: join(f.directory, "data"),
          XDG_CACHE_HOME: join(f.directory, "cache"), XDG_STATE_HOME: join(f.directory, "state"),
          TMPDIR: f.directory, TMP: f.directory, TEMP: f.directory,
          OMP_SUPERAGENT_CONFIG: configPath, OMP_SUPERAGENT_ROLE: role, OMP_SUPERAGENT_LANE: "lane-one",
        },
      };
      const { pid } = await startHost(options);
      pids.push(pid);
      const connection = await HostConnection.connect(options.socketPath);
      connections.push(connection);
      const state = await connection.client.getState();
      expect(state.sessionId).not.toBe(role === "head" ? "authoritative-head-session" : "authoritative-lane-session");
      const proof = Promise.withResolvers<Record<string, unknown>>();
      const completion = Promise.withResolvers<void>();
      void proof.promise.catch(() => {});
      void completion.promise.catch(() => {});
      const unsubscribe = connection.onFrame((frame: HostFrame) => {
        if (frame.type === "prompt_result" && frame.id === `board-proof-${role}`) {
          if (frame.status === "completed" && frame.agentInvoked === false) completion.resolve();
          else completion.reject(new Error("Native board proof unexpectedly invoked an agent or failed"));
        }
        if (frame.type !== "extension_ui_request" || frame.method !== "notify" || typeof frame.message !== "string") return;
        try {
          const data = JSON.parse(frame.message) as Record<string, unknown>;
          if (data.fixture === "superagent-board-membership") proof.resolve(data);
        } catch { /* Other native lifecycle notifications are not this proof. */ }
      });
      // This deadline bounds real child/socket I/O; fake time cannot advance a native host.
      const deadline = setTimeout(() => {
        proof.reject(new Error("Native board membership command did not produce proof"));
        completion.reject(new Error("Native board membership command did not complete"));
      }, 10_000);
      try {
        const response = await connection.request({ type: "prompt", message: "/board-membership-proof" }, `board-proof-${role}`);
        expect(response.success).toBe(true);
        expect(await proof.promise).toMatchObject({ denied: true, role, agentStarts: 0, pid, boardTools: [],
          sessionId: state.sessionId, sessionFile: options.sessionFile });
        await completion.promise;
        const messages = await connection.client.getMessages();
        expect(JSON.stringify(messages)).not.toContain("superagent-board-notice");
        expect(JSON.stringify(messages)).not.toContain("Private instance bulletin");
      } finally { clearTimeout(deadline); unsubscribe(); }
      await connection.client.shutdownHost();
      await connection.exited;
      pids.splice(pids.indexOf(pid), 1);
    }
  } finally {
    for (const connection of connections) await connection.close();
    for (const pid of pids) {
      try { process.kill(pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    f.close();
  }
}, 90_000);
