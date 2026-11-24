import { lstatSync } from "node:fs";
import { join } from "node:path";

// Canonical skill IDs match the commands. Legacy IDs remain wire tags and
// aliases (the plain SUPER command's legacy command name is "ulw").
export const superkitWorkflows = [
  ["super-plan", "ulw-plan"],
  ["super-run", "ulw-execute"],
  ["super-loop", "ulw-loop"],
  ["super-graph", "mass-ulw"],
  ["super-research", "ulw-research"],
] as const;

export const canonicalSuperkitSkills = ["super", ...superkitWorkflows.map(([command]) => command)] as const;
export const legacySuperkitSkills = ["ultrawork", ...superkitWorkflows.map(([, id]) => id)] as const;

// Select the layout for the whole revision: the probe rejects incomplete
// canonical packages rather than falling back to individual legacy aliases.
export function hasCanonicalSuperkitSkills(packagePath: string): boolean {
  return canonicalSuperkitSkills.some(id =>
    lstatSync(join(packagePath, "skills", id, "SKILL.md"), { throwIfNoEntry: false }) !== undefined);
}
