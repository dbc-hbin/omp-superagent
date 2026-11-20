import { expect, test } from "bun:test";
import { mkdtempDisposableSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../src/config";
import type { Route } from "../src/contracts";
import { CronJobs } from "../src/cron-jobs";
import { Store } from "../src/store";

test("an overdue weekday job admits one durable run, skips overlap, and holds an uncertain run", () => {
  using directory = mkdtempDisposableSync(join(realpathSync("/tmp"), "sa-cron-"));
  const file = join(directory.path, "coordination.sqlite");
  const config: Config = {
    path: join(directory.path, "config.json"), stateDir: directory.path, headCwd: directory.path,
    command: [process.execPath], maxHosts: 1, maxSubagents: 1, idleMs: 1000,
    discord: { tokenEnv: "TEST_TOKEN", ownerId: "1", allowedGuildIds: [], allowedChannelIds: [] },
  };
  const route: Route = { platform: "discord", accountId: "2", authorityId: "1", guildId: null, channelId: "1", threadId: null };
  const friday = Date.parse("2027-01-08T00:00:00Z"); // Friday 09:00 in Seoul
  const tuesday = Date.parse("2027-01-12T00:00:01Z");
  let store = new Store(file);
  try {
    const cron = new CronJobs(store, config);
    store.receive({ id: "100", route, messageId: "100", receivedAt: friday - 1000, text: "/cron add", attachments: [] },
      "main", { "user-source:100": "true" });
    const source = store.input("100");
    if (!source) throw new Error("Missing authorized registration input");
    const update = cron.control(source, 'add "TZ=Asia/Seoul 0 9 * * 1-5" Check CI', friday - 1000);
    store.settleCronControl(source.id, update);
    expect(store.output("100:head-control")?.text).toContain("2027-01-08T00:00:00.000Z");
    cron.poll(friday - 1);
    expect(store.inputs("main")).toEqual([]);
    store.close();

    store = new Store(file);
    const recovered = new CronJobs(store, config);
    recovered.poll(tuesday); // Friday, Monday and Tuesday passed while stopped.
    const [first, ...duplicates] = store.inputs("main");
    if (!first) throw new Error("No overdue run was admitted");
    expect(duplicates).toEqual([]);
    expect(first).toMatchObject({ route, text: expect.stringContaining("Check CI"), state: "pending", workflow: null });
    recovered.poll(Date.parse("2027-01-13T00:00:01Z")); // Still pending at the next due time.
    expect(store.inputs("main").map(input => input.id)).toEqual([first.id]);
    store.submit(first.id, "native-first", 0);
    store.settle(first.id, "uncertain");
    recovered.poll(Date.parse("2027-01-14T00:00:01Z"));
    expect(store.inputs("main").map(input => [input.id, input.state])).toEqual([[first.id, "uncertain"]]);
    store.settle(first.id, "cancelled"); // Operator resolves the original uncertainty.
    recovered.poll(Date.parse("2027-01-15T00:00:01Z"));
    const [later, ...extra] = store.inputs("main");
    expect(extra).toEqual([]);
    expect(later?.id).not.toBe(first.id);
    expect(later?.route).toEqual(route);
  } finally { store.close(); }
});
