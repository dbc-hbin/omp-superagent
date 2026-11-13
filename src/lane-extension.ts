import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const instructions = readFileSync(new URL("../skills/lane/SKILL.md", import.meta.url), "utf8");

/** A worker role entrypoint, never the head's manager or messenger client. */
export default function laneExtension(pi: ExtensionAPI): void {
  if (process.env.OMP_SUPERAGENT_ROLE !== "lane") return;
  pi.on("before_agent_start", async (event, ctx) => {
    if (ctx.agent.kind !== "main") return;
    return { systemPrompt: [
      ...event.systemPrompt,
      instructions,
      `Lane identity: ${process.env.OMP_SUPERAGENT_LANE}. Workspace: ${ctx.cwd}.`,
    ] };
  });
}
