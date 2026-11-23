// Run by native-usage-reset.test.ts with a private HOME and a loopback-only Seatbelt policy.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../../src/config";
import { listOmpUsageResets, redeemOmpUsageReset } from "../../src/omp-usage";

const [executable, profile] = process.argv.slice(2);
const root = process.cwd();
assert(executable && profile && process.env.HOME === join(root, "home") &&
  process.env.PI_CODING_AGENT_DIR === join(root, "default-agent"), "Expected the isolated native reset fixture");
const profileFlag = `--profile=${profile}`;
const config: Config = {
  path: join(root, "config.json"), stateDir: join(root, "state"), headCwd: root,
  command: [executable, profileFlag], maxHosts: 1, maxSubagents: 1, idleMs: 0,
};
const importer = Bun.spawn([executable, profileFlag, "auth", "import", join(root, "credentials.json")], {
  cwd: root, env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  timeout: 15_000, killSignal: "SIGKILL",
});
const [importCode, importOut, importErr] = await Promise.all([
  importer.exited, new Response(importer.stdout).text(), new Response(importer.stderr).text(),
]);
assert.equal(importCode, 0, `${importOut}${importErr}`);

const phaseFile = join(root, "phase");
const identityKey = crypto.randomUUID();
await writeFile(phaseFile, "list");
const before = await listOmpUsageResets(config, identityKey);
assert.equal(before.length, 2);
const selected = before.find(row => row.availableCount === 2);
const unselected = before.find(row => row.availableCount === 3);
assert(selected && unselected, `Both fixture balances must come from the initial provider read: ${
  JSON.stringify(before.map(({ label, availableCount, redeemableCount, unavailable }) => ({ label, availableCount, redeemableCount, unavailable })))
}`);
assert.notEqual(unselected.target, selected.target);
for (const row of before) {
  const match = /^anthropic\/([1-9]\d*)$/.exec(row.target);
  assert(match, "Expected an exact Claude credential selector from stock OMP");
  assert.equal(row.label, `Claude · 계정 #${match[1]} · ${row.target === selected.target ? "se" : "un"}…`);
  assert.equal(row.redeemableCount, row.availableCount);
  assert.equal(row.unavailable, false);
}

await writeFile(phaseFile, "redeem");
assert.equal(await redeemOmpUsageReset(config, selected, process.env), "reset");

await writeFile(phaseFile, "readback");
const after = await listOmpUsageResets(config, identityKey);
assert.equal(after.length, 2);
assert.deepEqual(after.find(row => row.target === unselected.target), unselected);
const updated = after.find(row => row.target === selected.target);
assert(updated, "The redeemed account must remain listed");
assert.equal(updated.availableCount, 1);
assert.equal(updated.redeemableCount, 0);
assert.equal(updated.unavailable, false);
