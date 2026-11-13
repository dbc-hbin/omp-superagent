import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { Board, BoardMembershipError, boardRepositoryChannel } from "../../src/board";
import { loadConfig } from "../../src/config";
import nativeFixture from "./native-extension";

/** Command-only proof against the real native session, not a mocked extension API. */
export default function boardNativeFixture(pi: ExtensionAPI): void {
  nativeFixture(pi);
  let agentStarts = 0;
  pi.on("agent_start", () => { agentStarts++; });
  pi.registerCommand("board-membership-proof", {
    description: "Record native identity and authoritative board denial without invoking a model",
    handler: async (_args, ctx) => {
      const config = await loadConfig(process.env.OMP_SUPERAGENT_CONFIG!);
      const role = process.env.OMP_SUPERAGENT_ROLE === "head" ? "head" : "lane";
      let denied = false;
      let instance: Board | undefined;
      try {
        instance = new Board(join(config.stateDir, "coordination.sqlite"), {
          role, actor: role === "head" ? "head" : process.env.OMP_SUPERAGENT_LANE!,
          sessionId: ctx.sessionManager.getSessionId(),
        }, boardRepositoryChannel(ctx.cwd), ctx.sessionManager.getSessionFile()!);
        instance.read();
      } catch (error) {
        if (!(error instanceof BoardMembershipError)) throw error;
        denied = true;
      } finally { instance?.close(); }
      const proof = {
        fixture: "superagent-board-membership", denied, role, agentStarts, pid: process.pid,
        sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile(),
        boardTools: pi.getActiveTools().filter(name => ["board_post", "board_read", "board_subscribe"].includes(name)),
      };
      pi.appendEntry("superagent-board-membership", proof);
      ctx.ui.notify(JSON.stringify(proof), "info");
    },
  });
}
