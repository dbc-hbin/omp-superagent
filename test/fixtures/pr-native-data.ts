import assert from "node:assert/strict";
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { Store } from "../../src/store";
import { PrWatcher } from "../../src/pr-watch";
import { loginSchema, parseWire } from "../../src/pr-github-schema";
import { changeDiscordPurpose } from "../../src/discord-context";
import type { Config } from "../../src/config";
import type { Route } from "../../src/contracts";

/** Run data validation through OMP's actual extension import graph, not Bun imports alone. */
export default async function nativeDataValidation(_pi: ExtensionAPI): Promise<void> {
  const directory = process.env.PI_CODING_AGENT_DIR;
  assert(directory);
  const config: Config = {
    path: join(directory, "unused.json"), stateDir: directory, headCwd: directory,
    command: [process.execPath], maxHosts: 2, maxSubagents: 4, idleMs: 0,
    discord: { tokenEnv: "UNUSED", ownerId: "1", allowedGuildIds: ["3"], allowedChannelIds: ["4"] },
  };
  const store = new Store(join(directory, "native-data.sqlite"));
  const route: Route = { platform: "discord", accountId: "2", authorityId: "1", guildId: "3", channelId: "4", threadId: null };
  try {
    assert.deepEqual(parseWire(loginSchema, '{"login":"owner"}'), { login: "owner" });
    assert.throws(() => parseWire(loginSchema, '{"login":4}'), /invalid or incomplete/);
    store.receive({ id: "native-source", route, messageId: "10", receivedAt: 1, attachments: [], text: "Track PR" },
      "main", { "user-source:native-source": "true" });
    store.settle("native-source", "done");
    const watcher = new PrWatcher(store, config, async () => ({
      head: "a".repeat(40), state: "open", self: "owner", mergedSha: null,
      feedback: [], failures: [], headChange: "unknown", ci: { outcome: "passed", key: "fixture-ci-pass", skipped: 0 },
    }));
    watcher.change({ action: "track", sourceId: "native-source", ref: "example/repo#1", intervalSeconds: 300 });
    await watcher.poll(0, new AbortController().signal);
    assert.equal(watcher.list({ sourceId: "native-source" })[0]?.baseline?.state, "open");
    assert.equal(watcher.list({ sourceId: "native-source" })[0]?.baseline?.ci, "passed");
    assert.equal(store.inputs("main").length, 0);
    changeDiscordPurpose(store, { action: "set", sourceId: "native-source", route, purpose: "Project context" });
    assert.deepEqual(changeDiscordPurpose(store, { action: "list", sourceId: "native-source", route }),
      [{ route, purpose: "Project context" }]);
  } finally { store.close(); }
}
