import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

// The updater tests materialize this independent, minimally compatible native
// extension into a local git remote. Defects exercise executable hook results.
const defect: string = "none";
const preset = `<omp-model-preset>
You are a coding agent on Grok 4.5. Inspect the available evidence before deciding
what to change. Delegate independent work only when the active tools permit it.
Keep host permissions and the assigned scope authoritative. Report observed
results precisely, and distinguish unrun checks from verified behavior.
</omp-model-preset>`;
const workflows = [
  ["super-plan", "ulw-plan"], ["super-run", "ulw-execute"], ["super-loop", "ulw-loop"],
  ["super-graph", "mass-ulw"], ["super-research", "ulw-research"],
] as const;
// SUPER-era packages ship the directive and workflow bodies under canonical skills.
const canonical = existsSync(new URL("./skills/super/SKILL.md", import.meta.url));
const installed = readFileSync(new URL(`./skills/${canonical ? "super" : "ultrawork"}/SKILL.md`, import.meta.url), "utf8");
const directive = /<ultrawork-mode>([\s\S]*?)<\/ultrawork-mode>/.exec(installed)?.[0];
const policy = `<omp-ulw-policy>\n${defect === "mismatched-policy"
  ? directive?.replace("Carry the explicitly requested objective", "Replace the explicitly requested objective") : directive}\n</omp-ulw-policy>`;

export default function compatiblePromptFixture(pi: ExtensionAPI): void {
  let active = false;
  for (const name of ["super", "ulw", ...workflows.flat()]) {
    if (defect === "missing-command" && name === "super-run") continue;
    const canonical = name === "super" || name.startsWith("super-");
    const primary = name === "ulw" ? "super" : workflows.find(([, legacy]) => legacy === name)?.[0];
    const description = !canonical ? `Legacy alias for /${primary}` : name === "super" ? "Enable SUPER mode" : `Run the ${name} workflow`;
    pi.registerCommand(name, {
      ...(defect === "missing-descriptor" && name === "super-run" ? {} : { description }),
      handler: async args => { pi.sendUserMessage(`${name} ${args}`); },
    });
  }
  pi.on("before_agent_start", event => {
    if (defect === "no-effect") return;
    const [native, ...tail] = event.systemPrompt;
    if (!native) return;
    const replacement = defect === "empty-preset" ? "<omp-model-preset></omp-model-preset>" : preset;
    const base = native.includes("<omp-model-preset>") ? native : native.replace(
      /(^|\n[§⁂] Role\n)[\s\S]*?(?=\n[§⁂] Runtime\n)/,
      (_role, heading: string) => `${heading}${replacement}\n`,
    );
    const invocation = /^\/?(super(?:-[a-z]+)?)\s/.exec(event.prompt)?.[1];
    const selected = workflows.find(([command]) => command === invocation)
      ?? (defect === "plain-pointer" && invocation === "super" ? workflows[0] : undefined);
    if (!active && ((invocation && invocation !== "super-graph") || (defect === "quoted-workflow" && event.prompt.startsWith(">")))) {
      active = true;
      pi.appendEntry("omo-ultrawork:state", true);
    }
    const blocks = [base, ...tail.filter(block => !block.startsWith("<omp-ulw-policy>")
      && !(defect === "duplicate-preset" && block === preset))];
    if (defect === "duplicate-preset") blocks.push(preset);
    if (active && defect !== "missing-workflow") {
      blocks.push(policy);
      if (defect === "duplicate-workflow") blocks.push(policy);
    }
    if (!selected) return { systemPrompt: blocks };
    const [command, id] = selected;
    const path = fileURLToPath(new URL(`./skills/${canonical ? command : id}/SKILL.md`, import.meta.url));
    return { systemPrompt: blocks, message: { customType: "omo-ultrawork:directive", display: false,
      content: `<omp-${id}-pointer>Read ${path} for ${command}.</omp-${id}-pointer>` } };
  });
}
