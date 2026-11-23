import { expect, test } from "bun:test";
import { mkdtempDisposableSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../src/config";
import type { InputRecord, Route } from "../src/contracts";
import { CRON_RUN_PREFIX, CronJobs } from "../src/cron-jobs";
import { CronPrIntake, isPrIntakeOffer, type ReadIntakePulls } from "../src/cron-pr-intake";
import { prModeArgument } from "../src/pr-intake-mode";
import { Store } from "../src/store";

const parent: Route = { platform: "discord", accountId: "2", authorityId: "1", guildId: "3", channelId: "4", threadId: null };
const alternate: Route = { ...parent, channelId: "6" };
const thread: Route = { ...parent, threadId: "5" };
const repository = "owner/repo";
const add = 'pr-add "every 5m" OWNER/Repo';
const time = Date.parse("2027-01-08T00:00:00Z");
const head = "a".repeat(40);
const laterHead = "b".repeat(40);
const identity = { repositoryId: 100, ownerId: 200 } as const;
let fixtureOffset = 0n;

function snowflake(): string {
  return ((BigInt(time - 1_420_070_400_000) + fixtureOffset++) << 22n).toString();
}

function config(stateDir: string): Config {
  return { path: join(stateDir, "config.json"), stateDir, headCwd: stateDir, command: [process.execPath],
    maxHosts: 1, maxSubagents: 1, idleMs: 1000,
    discord: { tokenEnv: "UNUSED", ownerId: "1", allowedGuildIds: ["3"], allowedChannelIds: ["4", "6"] } };
}

function owner(store: Store, id: string, argument: string, options: {
  readonly route?: Route; readonly messageId?: string; readonly authenticated?: boolean; readonly interactionId?: string;
  readonly text?: string; readonly discordOriginalText?: string; readonly reply?: InputRecord["reply"];
} = {}): InputRecord {
  const prior = store.input(id);
  const { route = parent, messageId = prior?.messageId ?? snowflake(), authenticated = true,
    interactionId = prior?.interactionId, text = `/cron ${argument}`, discordOriginalText, reply } = options;
  store.receive({ id, route, messageId: interactionId === undefined ? messageId : null, receivedAt: time,
    text, attachments: [], ...(interactionId === undefined ? {} : { interactionId }),
    ...(discordOriginalText === undefined ? {} : { discordOriginalText }), ...(reply ? { reply } : {}) }, "main",
  authenticated ? { [`user-source:${id}`]: "true" } : {});
  const input = store.input(id);
  if (!input) throw new Error("Missing fixture owner input");
  return input;
}

function control(store: Store, jobs: CronJobs, id: string, argument: string, now = time, route = parent) {
  const input = owner(store, id, argument, { route });
  return { input, update: settleControl(store, jobs, input, argument, now) };
}

function settleControl(store: Store, jobs: CronJobs, input: InputRecord, argument: string, now = time) {
  const update = jobs.control(input, argument, now);
  expect(store.settleCronControl(input.id, update)).toBe(true);
  return update;
}

function stopHead(store: Store, jobs: CronJobs, id: string, options: { route?: Route; messageId?: string } = {}) {
  const stop = owner(store, id, "", { ...options, text: "/stop main" });
  const prDiscordOrder = jobs.prStopOrder(store.getMeta("head:stop-boundary"), stop);
  store.settle(stop.id, "done");
  store.setMeta("head:stop-boundary", JSON.stringify({ inputId: stop.id, cancelledInputIds: [], prDiscordOrder }));
}

function enroll(store: Store, jobs: CronJobs) {
  const { input, update } = control(store, jobs, "enroll", add);
  const [jobId] = /^Enrolled PR intake\. ([a-f0-9-]{36})/.exec(update.text)?.slice(1) ?? [];
  if (!jobId) throw new Error(`PR enrollment did not return a job ID: ${update.text}`);
  return jobs.requireActivePrJob(input, jobId);
}

function nextRun(store: Store, jobs: CronJobs): InputRecord {
  const runs = store.inputs("main", "pending").filter(input => jobs.isPrIntakeRun(input));
  expect(runs).toHaveLength(1);
  const [run] = runs;
  if (!run) throw new Error("Missing typed PR intake run");
  return run;
}

function offers(store: Store) {
  return store.outputs().filter(output => isPrIntakeOffer(output.id));
}

function actions(store: Store): string[] {
  return offers(store).flatMap(output => output.text.split("\n").filter(line => line.startsWith("/cron pr-review ")));
}

function pull(number: number, createdAt: number, author = "contributor", sha = head) {
  return { number, createdAt, author, head: sha };
}

function snapshot(...pulls: readonly ReturnType<typeof pull>[]) {
  return { ...identity, self: "owner", pulls };
}

test("PR enrollment rejects unauthorized, non-parent and edited sources and keeps one canonical parent reservation", () => {
  using directory = mkdtempDisposableSync(join(realpathSync("/tmp"), "sa-cron-pr-"));
  const store = new Store(join(directory.path, "coordination.sqlite"));
  try {
    const jobs = new CronJobs(store, config(directory.path));
    const original = owner(store, "prior", "help");
    const editOf = snowflake();
    const rejected = [
      original,
      owner(store, "unsigned", add, { authenticated: false }),
      owner(store, "other-owner", add, { route: { ...parent, authorityId: "9" } }),
      owner(store, "thread", add, { route: thread }),
      owner(store, "logical", add, { route: { ...parent, topicId: "topic" } }),
      owner(store, "dm", add, { route: { ...parent, guildId: null, channelId: "1" } }),
      owner(store, `discord:2:${editOf}:edit:1000:rev`, add, { messageId: editOf }),
      owner(store, "later-revision", add, { messageId: original.messageId ?? undefined }),
      owner(store, "noncanonical-interaction", add, { interactionId: snowflake() }),
      owner(store, "non-snowflake-message", add, { messageId: "invalid" }),
    ];
    for (const input of rejected) {
      expect(jobs.control(input, add, time)).toMatchObject({ state: "cancelled" });
    }
    const interactionId = snowflake();
    const source = owner(store, `discord:2:interaction:${interactionId}`, add, { interactionId });
    const admitted = jobs.control(source, add, time);
    expect(store.settleCronControl(source.id, admitted)).toBe(true);
    const duplicate = control(store, jobs, "duplicate", 'pr-add "every 5m" owner/REPO', time, alternate);
    expect(duplicate.update.state).toBe("cancelled");
    jobs.poll(time + 300_000);
    const run = nextRun(store, jobs);
    expect(run).toMatchObject({ route: parent, messageId: null, interactionId });
    expect(store.ownerSource(run.id)).toBeNull();
    expect(control(store, jobs, "other-list", "list", time, alternate).update.text).not.toContain(repository);
  } finally { store.close(); }
});

test.each([
  ["/cron pr-mode OWNER/Repo fix", "pr-mode owner/repo fix"],
  ["/cron pr-mode 26be0f92-4320-4c22-9680-5729a9982927 merge", "pr-mode 26be0f92-4320-4c22-9680-5729a9982927 merge"],
  ["무인으로 리뷰만", "pr-mode review"],
  ["무인으로 리뷰 후 수정커밋까지", "pr-mode fix"],
  ["무인으로 수정커밋후 머지까지", "pr-mode merge"],
  ["PR 자동화 2단계로 바꿔줘", "pr-mode fix"],
  ["앞으로는 자동으로 리뷰만 해", "pr-mode review"],
  ["앞으로 OWNER/Repo는 무인으로 리뷰만 해 줘.", "pr-mode owner/repo review"],
  ["OWNER/Repo 저장소에서 앞으로는 무인으로 리뷰 후 수정 커밋 까지 진행해 주세요.", "pr-mode owner/repo fix"],
  ["무인으로 수정 커밋 후 병합까지 설정해줘 (OWNER/Repo)", "pr-mode owner/repo merge"],
] as const)("accepts the direct PR mode command %s", (text, argument) => {
  expect(prModeArgument(text)).toBe(argument);
});

test.each([
  "/cron pr-mode review",
  "/cron pr-mode OWNER/Repo manual",
  "/cron pr-mode https://github.com/OWNER/Repo merge",
  "/cron pr-mode OWNER/Repo merge\n/cron list",
  "앞으로 무인으로 리뷰만 해 주면 어떻게 돼?",
  "무인으로 리뷰만 해 줄 수 있어?",
  "무인으로 리뷰만 하지 마.",
  "무인으로 수정 커밋 후 머지까지 하면 안 돼.",
  "무인으로 리뷰만 할지는 나중에 얘기하자.",
  "PR 리뷰만 해 줘.",
  '“무인으로 수정커밋후 머지까지”',
  "`/cron pr-mode OWNER/Repo merge`",
  "> 무인으로 수정커밋후 머지까지",
  "이런 말이 왔어:\n무인으로 수정커밋후 머지까지",
  "OWNER/Repo는 무인으로 리뷰만 해 줘 (other/repo)",
])("does not grant PR mode authority from %s", text => {
  expect(prModeArgument(text)).toBeNull();
});

test("legacy PR intake remains manual across resume until the owner selects an unattended mode", () => {
  using directory = mkdtempDisposableSync(join(realpathSync("/tmp"), "sa-cron-pr-"));
  const store = new Store(join(directory.path, "coordination.sqlite"));
  try {
    const jobId = "26be0f92-4320-4c22-9680-5729a9982927";
    const source = owner(store, "legacy", add);
    store.settle(source.id, "done");
    store.setMeta("cron:jobs", JSON.stringify({ registrations: {}, jobs: [{
      kind: "pr-intake", id: jobId, sourceId: source.id, repository, schedule: { kind: "interval", milliseconds: 300_000 },
      eligibleAfter: time, epoch: source.id, removed: false, paused: false, stopBoundary: null, lastRunId: null,
      nextAt: time + 300_000,
    }] }));
    const jobs = new CronJobs(store, config(directory.path));
    expect(jobs.requireActivePrJob(source, jobId).id).toBe(jobId);
    expect(jobs.prPolicy(jobId)).toBeNull();

    control(store, jobs, "pause-legacy", `pause ${jobId}`);
    control(store, jobs, "resume-legacy", `resume ${jobId}`);
    expect(jobs.prPolicy(jobId)).toBeNull();
    expect(control(store, jobs, "show-legacy", `show ${jobId}`).update.text).toContain("PR intake mode: manual");

    control(store, jobs, "select-legacy", `pr-mode ${jobId} fix`);
    expect(jobs.prPolicy(jobId)).toMatchObject({ mode: "fix", sourceId: "select-legacy" });
  } finally { store.close(); }
});

test("a legacy tombstone with unknown removal order forces explicit selection until membership is known", () => {
  using directory = mkdtempDisposableSync(join(realpathSync("/tmp"), "sa-cron-pr-"));
  const store = new Store(join(directory.path, "coordination.sqlite"));
  try {
    const removedId = "26be0f92-4320-4c22-9680-5729a9982927";
    const removedAdd = 'pr-add "every 5m" owner/archived';
    const previous = owner(store, "legacy-removed", removedAdd);
    store.settle(previous.id, "done");
    store.setMeta("cron:jobs", JSON.stringify({ registrations: {}, jobs: [{
      kind: "pr-intake", id: removedId, sourceId: previous.id, repository: "owner/archived",
      schedule: { kind: "interval", milliseconds: 300_000 }, eligibleAfter: time, epoch: previous.id,
      removed: true, paused: true, stopBoundary: null, lastRunId: null, nextAt: time + 300_000,
    }] }));
    const jobs = new CronJobs(store, config(directory.path));
    const { id } = enroll(store, jobs);
    const argument = "pr-mode merge";
    const text = "무인으로 수정커밋후 머지까지";
    const unknown = owner(store, "unknown-membership", argument, { text });
    expect(settleControl(store, jobs, unknown, argument).state).toBe("cancelled");
    control(store, jobs, "explicit-selection", `pr-mode ${id} fix`);
    expect(jobs.prPolicy(id)).toMatchObject({ mode: "fix", sourceId: "explicit-selection" });

    expect(control(store, jobs, "unverified-legacy-add", removedAdd).update.state).toBe("cancelled");
    const status = control(store, jobs, "legacy-status", `show ${removedId}`);
    const output = `${status.input.id}:head-control`;
    const messageId = snowflake();
    expect(store.claimOutput(output)).toBe(true);
    store.finishOutput(output, "sent", messageId);
    const reAdd = owner(store, "confirmed-legacy-add", removedAdd, { reply: { messageId, authorId: parent.accountId, text: null } });
    settleControl(store, jobs, reAdd, removedAdd);
    expect(jobs.activePrEnrollment(removedId)?.job.epoch).toBe(reAdd.id);
    control(store, jobs, "known-remove", `remove ${removedId}`);

    const fresh = owner(store, "known-membership", argument, { text });
    settleControl(store, jobs, fresh, argument);
    expect(jobs.prPolicy(id)).toMatchObject({ mode: "merge", sourceId: fresh.id });
  } finally { store.close(); }
});

test("mode grants persist across restart but old revisions stay revoked after downgrade, pause, stop and re-enrollment", () => {
  using directory = mkdtempDisposableSync(join(realpathSync("/tmp"), "sa-cron-pr-"));
  const file = join(directory.path, "coordination.sqlite");
  let store = new Store(file);
  try {
    let jobs = new CronJobs(store, config(directory.path));
    const { id } = enroll(store, jobs);
    const original = jobs.prPolicy(id);
    expect(original).toMatchObject({ mode: "review", sourceId: "enroll" });
    control(store, jobs, "upgrade", `pr-mode ${id} merge`);
    const upgraded = jobs.prPolicy(id);
    expect(upgraded).toMatchObject({ mode: "merge", sourceId: "upgrade" });
    expect(upgraded?.revision).not.toBe(original?.revision);

    store.close();
    store = new Store(file);
    jobs = new CronJobs(store, config(directory.path));
    expect(jobs.prPolicy(id)).toEqual(upgraded);

    control(store, jobs, "downgrade", `pr-mode ${id} review`);
    const downgraded = jobs.prPolicy(id);
    expect(downgraded).toMatchObject({ mode: "review", sourceId: "downgrade" });
    expect(downgraded?.revision).not.toBe(original?.revision);
    expect(downgraded?.revision).not.toBe(upgraded?.revision);

    control(store, jobs, "pause-policy", `pause ${id}`);
    expect(jobs.prPolicy(id)).toBeNull();
    control(store, jobs, "resume-policy", `resume ${id}`);
    const resumed = jobs.prPolicy(id);
    expect(resumed).toMatchObject({ mode: "review", sourceId: "downgrade" });
    expect(resumed?.revision).not.toBe(downgraded?.revision);

    stopHead(store, jobs, "stop-after-resume");
    expect(jobs.prPolicy(id)).toBeNull();
    control(store, jobs, "resume-after-stop", `resume ${id}`);
    const restarted = jobs.prPolicy(id);
    expect(restarted).toMatchObject({ mode: "review", sourceId: "downgrade" });
    expect(restarted?.revision).not.toBe(resumed?.revision);

    control(store, jobs, "upgrade-again", `pr-mode ${id} merge`);
    control(store, jobs, "remove-policy", `remove ${id}`);
    expect(jobs.prPolicy(id)).toBeNull();
    control(store, jobs, "rollover", add);
    expect(jobs.prPolicy(id)).toMatchObject({ mode: "review", sourceId: "rollover" });
  } finally { store.close(); }
});

test("PR mode changes require an authenticated original action matching the same physical parent and exact mode", () => {
  using directory = mkdtempDisposableSync(join(realpathSync("/tmp"), "sa-cron-pr-"));
  const store = new Store(join(directory.path, "coordination.sqlite"));
  try {
    const jobs = new CronJobs(store, config(directory.path));
    const { id } = enroll(store, jobs);
    const initial = jobs.prPolicy(id);
    const command = `pr-mode ${id} merge`;
    const previous = owner(store, "first-message", "list");
    const rejected = [
      owner(store, "unverified", command, { authenticated: false }),
      owner(store, "wrong-owner", command, { route: { ...parent, authorityId: "9" } }),
      owner(store, "another-parent", command, { route: alternate }),
      owner(store, "thread-mode", command, { route: thread }),
      owner(store, "logical-mode", command, { route: { ...parent, topicId: "logical" } }),
      owner(store, "mode-edit", command, { messageId: previous.messageId ?? undefined }),
      owner(store, "voice-mode", command, { discordOriginalText: "/voice confirm" }),
      owner(store, "forged-mode", `pr-mode ${id} review`),
      owner(store, "prompt-mode", "list", { text: "프롬프트에 무인으로 수정커밋후 머지까지 라고 적어줘." }),
    ];
    for (const source of rejected) {
      expect(jobs.control(source, command, time)).toMatchObject({ state: "cancelled" });
    }
    expect(jobs.prPolicy(id)).toEqual(initial);

    const accepted = control(store, jobs, "mode-action", command);
    expect(jobs.prPolicy(id)).toMatchObject({ mode: "merge", sourceId: accepted.input.id });
    store.setMeta(`user-source:${accepted.input.id}`, "false");
    expect(jobs.prPolicy(id)).toBeNull();
  } finally { store.close(); }
});

test("a targetless Korean command selects only a unique same-parent job; an explicit repository disambiguates", () => {
  using directory = mkdtempDisposableSync(join(realpathSync("/tmp"), "sa-cron-pr-"));
  const store = new Store(join(directory.path, "coordination.sqlite"));
  try {
    const jobs = new CronJobs(store, config(directory.path));
    const { id } = enroll(store, jobs);
    control(store, jobs, "another-parent-job", 'pr-add "every 5m" owner/remote', time, alternate);
    function apply(sourceId: string, text: string) {
      const argument = prModeArgument(text);
      if (!argument) throw new Error("Fixture was not recognized as a mode command");
      const source = owner(store, sourceId, argument, { text });
      const update = jobs.control(source, argument, time);
      expect(store.settleCronControl(source.id, update)).toBe(true);
      return update;
    }

    apply("unique-mode", "무인으로 리뷰 후 수정커밋까지 해줘.");
    expect(jobs.prPolicy(id)).toMatchObject({ mode: "fix", sourceId: "unique-mode" });

    control(store, jobs, "another-same-parent-job", 'pr-add "every 5m" owner/local');
    const ambiguous = apply("ambiguous-mode", "무인으로 수정커밋후 머지까지");
    expect(ambiguous.state).toBe("cancelled");
    expect(jobs.prPolicy(id)).toMatchObject({ mode: "fix", sourceId: "unique-mode" });

    apply("explicit-mode", "OWNER/Repo는 무인으로 수정 커밋 후 머지까지 진행해 줘.");
    expect(jobs.prPolicy(id)).toMatchObject({ mode: "merge", sourceId: "explicit-mode" });
  } finally { store.close(); }
});

test("a late physical merge cannot replace newer interaction review, even across restart or replay", () => {
  using directory = mkdtempDisposableSync(join(realpathSync("/tmp"), "sa-cron-pr-"));
  const file = join(directory.path, "coordination.sqlite");
  let store = new Store(file);
  try {
    let jobs = new CronJobs(store, config(directory.path));
    const { id } = enroll(store, jobs);
    const earlierMessage = snowflake();
    const interactionId = snowflake();
    const review = `pr-mode ${id} review`;
    const source = owner(store, `discord:2:interaction:${interactionId}`, review, { interactionId });
    settleControl(store, jobs, source, review);
    const policy = jobs.prPolicy(id);
    expect(policy).toMatchObject({ mode: "review", sourceId: source.id });

    store.close();
    store = new Store(file);
    jobs = new CronJobs(store, config(directory.path));
    const merge = `pr-mode ${id} merge`;
    const delayed = owner(store, "delayed-merge", merge, { messageId: earlierMessage });
    expect(settleControl(store, jobs, delayed, merge).state).toBe("cancelled");
    expect(jobs.prPolicy(id)).toEqual(policy);

    control(store, jobs, "fresh-merge", merge);
    const replay = owner(store, source.id, review);
    expect(replay.interactionId).toBe(interactionId);
    expect(store.settleCronControl(replay.id, jobs.control(replay, review, time))).toBe(false);
    expect(jobs.prPolicy(id)).toMatchObject({ mode: "merge", sourceId: "fresh-merge" });
  } finally { store.close(); }
});

test("a targetless selection cannot borrow uniqueness from later removal or re-enrollment", () => {
  using directory = mkdtempDisposableSync(join(realpathSync("/tmp"), "sa-cron-pr-"));
  const store = new Store(join(directory.path, "coordination.sqlite"));
  try {
    const jobs = new CronJobs(store, config(directory.path));
    const first = enroll(store, jobs);
    const otherRepository = "owner/local";
    const second = /^Enrolled PR intake\. ([a-f0-9-]{36})/.exec(
      control(store, jobs, "second", `pr-add "every 5m" ${otherRepository}`).update.text,
    )?.[1];
    if (!second) throw new Error("Missing second enrollment");
    const text = "무인으로 수정커밋후 머지까지";
    const argument = "pr-mode merge";
    const ambiguousSend = snowflake(); // A + B existed then.
    const explicitSend = snowflake();
    control(store, jobs, "remove-first", `remove ${first.id}`);
    const ambiguous = owner(store, "late-ambiguous", argument, { text, messageId: ambiguousSend });
    expect(settleControl(store, jobs, ambiguous, argument)).toMatchObject({
      state: "cancelled", text: expect.stringContaining("enrollment changes"),
    });
    expect(jobs.prPolicy(second)).toMatchObject({ mode: "review", sourceId: "second" });

    const explicitArgument = `pr-mode ${otherRepository} fix`;
    const explicit = owner(store, "explicit-second", explicitArgument, { messageId: explicitSend });
    settleControl(store, jobs, explicit, explicitArgument);
    expect(jobs.prPolicy(second)).toMatchObject({ mode: "fix", sourceId: "explicit-second" });
    const fresh = owner(store, "fresh-unique", argument, { text });
    settleControl(store, jobs, fresh, argument);
    expect(jobs.prPolicy(second)).toMatchObject({ mode: "merge", sourceId: "fresh-unique" });

    const beforeReplacement = snowflake(); // B was the only enrollment then.
    control(store, jobs, "remove-second", `remove ${second}`);
    control(store, jobs, "re-enroll-first", add);
    const replaced = owner(store, "late-replaced", argument, { text, messageId: beforeReplacement });
    expect(settleControl(store, jobs, replaced, argument)).toMatchObject({
      state: "cancelled", text: expect.stringContaining("enrollment changes"),
    });
    expect(jobs.prPolicy(first.id)).toMatchObject({ mode: "review", sourceId: "re-enroll-first" });
    expect(jobs.prPolicy(second)).toBeNull();
  } finally { store.close(); }
});

test("late resume and re-enroll cannot reopen a newer pause or remove", () => {
  using directory = mkdtempDisposableSync(join(realpathSync("/tmp"), "sa-cron-pr-"));
  const store = new Store(join(directory.path, "coordination.sqlite"));
  try {
    const jobs = new CronJobs(store, config(directory.path));
    const { id } = enroll(store, jobs);
    const resume = `resume ${id}`;
    const pausedResume = snowflake();
    control(store, jobs, "newer-pause", `pause ${id}`);
    const delayed = owner(store, "late-resume", resume, { messageId: pausedResume });
    expect(settleControl(store, jobs, delayed, resume).state).toBe("cancelled");
    expect(jobs.activePrEnrollment(id)).toBeNull();
    control(store, jobs, "newer-resume", resume);
    expect(jobs.activePrEnrollment(id)?.job.epoch).toBe("newer-resume");

    const oldAdd = snowflake();
    control(store, jobs, "newer-remove", `remove ${id}`);
    const delayedAdd = owner(store, "late-add", add, { messageId: oldAdd });
    expect(settleControl(store, jobs, delayedAdd, add).state).toBe("cancelled");
    expect(jobs.activePrEnrollment(id)).toBeNull();
    control(store, jobs, "newer-add", add);
    expect(jobs.activePrEnrollment(id)?.job.epoch).toBe("newer-add");
  } finally { store.close(); }
});

test("an unorderable HEAD stop requires a reply to the current confirmed Discord job status", () => {
  using directory = mkdtempDisposableSync(join(realpathSync("/tmp"), "sa-cron-pr-"));
  const store = new Store(join(directory.path, "coordination.sqlite"));
  try {
    const telegram: Route = { platform: "telegram", accountId: "31", authorityId: "32", guildId: null, channelId: "32", threadId: null };
    const jobs = new CronJobs(store, { ...config(directory.path), telegram: { tokenEnv: "UNUSED", ownerId: "32", allowedChatIds: ["32"] } });
    const { id } = enroll(store, jobs);
    const resume = `resume ${id}`;
    stopHead(store, jobs, "other-platform-stop", { route: telegram });
    expect(control(store, jobs, "bare-resume", resume).update.state).toBe("cancelled");
    const staleStatus = control(store, jobs, "old-status", `show ${id}`);
    const oldOutput = `${staleStatus.input.id}:head-control`;
    const oldRemote = snowflake();
    expect(store.claimOutput(oldOutput)).toBe(true);
    store.finishOutput(oldOutput, "sent", oldRemote);

    // A subsequent Discord stop cannot erase the incomparable older stop.
    stopHead(store, jobs, "another-stop");
    const latestStatus = control(store, jobs, "current-status", `show ${id}`);
    expect(latestStatus.update.text).toContain("reply directly to this status");
    const output = `${latestStatus.input.id}:head-control`;
    const remote = snowflake();
    const replyResume = (sourceId: string, messageId: string) =>
      settleControl(store, jobs, owner(store, sourceId, resume, { reply: { messageId, authorId: parent.accountId, text: null } }), resume);
    expect(replyResume("stale-status-reply", oldRemote).state).toBe("cancelled");
    expect(replyResume("unconfirmed-status-reply", remote).state).toBe("cancelled");
    expect(jobs.activePrEnrollment(id)).toBeNull();
    expect(store.claimOutput(output)).toBe(true);
    store.finishOutput(output, "sent", remote);
    expect(replyResume("confirmed-status-reply", remote).state).toBeUndefined();
    expect(jobs.activePrEnrollment(id)?.job.epoch).toBe("confirmed-status-reply");
  } finally { store.close(); }
});

test("poll dispatches a controller-only receipt and offers only new external PRs with their exact parent action", async () => {
  using directory = mkdtempDisposableSync(join(realpathSync("/tmp"), "sa-cron-pr-"));
  const file = join(directory.path, "coordination.sqlite");
  let store = new Store(file);
  try {
    let jobs = new CronJobs(store, config(directory.path));
    const job = enroll(store, jobs);
    jobs.poll(time + 299_999);
    expect(store.inputs("main", "pending")).toEqual([]);
    jobs.poll(time + 300_000);
    const queued = nextRun(store, jobs);
    store.close();

    store = new Store(file);
    jobs = new CronJobs(store, config(directory.path));
    jobs.poll(time + 600_000); // An overlapping tick must not revive it as a different run.
    const run = nextRun(store, jobs);
    expect(run.id).toBe(queued.id);
    expect(run.id.startsWith(`${CRON_RUN_PREFIX}${job.id}:`)).toBe(true);
    expect(run).toMatchObject({ route: parent, target: "main", workflow: null, attachments: [] });
    expect(store.ownerSource(run.id)).toBeNull();
    const service = new CronPrIntake(store, jobs, async repo => {
      if (repo !== repository) throw new Error("Wrong normalized repository");
      return { ...identity, self: "OWNER", pulls: [
        pull(1, time - 1), pull(2, time), pull(3, time + 1, "Owner"), pull(4, time + 1), pull(4, time + 2, "contributor", laterHead),
      ] };
    });
    await service.consume(run, new AbortController().signal);

    const [offer, ...extra] = offers(store);
    expect(extra).toEqual([]);
    if (!offer) throw new Error("PR #4 was not offered");
    expect(offer.route).toEqual(parent);
    expect(offer.sourceId).toBe(job.sourceId);
    expect(offer.text).toContain(`${repository}#4`);
    expect(actions(store)).toEqual([`/cron pr-review ${job.id} 4 ${head}`]);
    expect(service.canDeliver(offer)).toBe(true);
    expect(service.canDeliver({ ...offer, route: alternate })).toBe(false);
    expect(service.candidate(job, 4)).toMatchObject({ number: 4, head, createdAt: time + 1, ...identity });
    expect(store.inputs("main", "pending")).toEqual([]);
    expect(store.input(run.id)?.state).toBe("done");
  } finally { store.close(); }
});

test("an overdue burst releases one oldest eligible offer per scan across restart, without reviving older epochs", async () => {
  using directory = mkdtempDisposableSync(join(realpathSync("/tmp"), "sa-cron-pr-"));
  const file = join(directory.path, "coordination.sqlite");
  let store = new Store(file);
  try {
    let jobs = new CronJobs(store, config(directory.path));
    const job = enroll(store, jobs);
    const old = snapshot(pull(33, time + 3), pull(31, time + 2), pull(32, time + 1));
    let service = new CronPrIntake(store, jobs, async () => old);
    const action = (number: number, sha = head) => `/cron pr-review ${job.id} ${number} ${sha}`;
    const scan = async (now: number) => {
      jobs.poll(now);
      await service.consume(nextRun(store, jobs), new AbortController().signal);
    };
    await scan(time + 600_000);
    expect(actions(store)).toEqual([action(32)]);
    expect(service.candidate(job, 31)?.number).toBe(31);
    expect(service.candidate(job, 33)?.number).toBe(33);
    expect(control(store, jobs, "show-deferred", `show ${job.id} 33`).update.text)
      .toContain(`${action(33)} (deferred; up to one offer per scan)`);
    store.close();

    store = new Store(file);
    jobs = new CronJobs(store, config(directory.path));
    service = new CronPrIntake(store, jobs, async () => snapshot(...old.pulls.map(p => p.number === 31 ? { ...p, head: laterHead } : p)));
    await scan(time + 900_000);
    expect(actions(store)).toEqual([action(32), action(31, laterHead)]);
    expect(offers(store).map(output => output.route)).toEqual([parent, parent]);

    // A wall-clock rollback leaves #33 above the new date cutoff. The
    // enrollment epoch still prevents automatic revival of its offer.
    control(store, jobs, "pause-burst", `pause ${job.id}`, time);
    const resume = control(store, jobs, "resume-burst", `resume ${job.id}`, time);
    service = new CronPrIntake(store, jobs, async () => snapshot(...old.pulls, pull(34, time + 4)));
    await scan(time + 1_200_000);
    expect(actions(store)).toEqual([action(32), action(31, laterHead), action(34)]);
    expect(service.candidate(jobs.requireActivePrJob(resume.input, job.id), 33)?.number).toBe(33);
    expect(control(store, jobs, "show-suppressed", `show ${job.id} 33`).update.text)
      .toContain(`${action(33)} (deferred offer suppressed; manual review only)`);
  } finally { store.close(); }
});

test("an uncertain send suppresses redispatch through outage, identity change, removal and restart", async () => {
  using directory = mkdtempDisposableSync(join(realpathSync("/tmp"), "sa-cron-pr-"));
  const file = join(directory.path, "coordination.sqlite");
  let store = new Store(file);
  try {
    let jobs = new CronJobs(store, config(directory.path));
    const job = enroll(store, jobs);
    let read: ReadIntakePulls = async () => snapshot(pull(7, time + 1));
    let service = new CronPrIntake(store, jobs, (repo, signal) => read(repo, signal));
    control(store, jobs, "manual", `run ${job.id}`, time + 1);
    await service.consume(nextRun(store, jobs), new AbortController().signal);
    const [offer] = offers(store);
    if (!offer) throw new Error("Missing original PR offer");
    expect(store.claimOutput(offer.id)).toBe(true);
    store.close();

    store = new Store(file);
    store.recoverDeliveries();
    jobs = new CronJobs(store, config(directory.path));
    service = new CronPrIntake(store, jobs, (repo, signal) => read(repo, signal));
    const repeat = async (id: string, now: number) => {
      control(store, jobs, id, `run ${job.id}`, now);
      await service.consume(nextRun(store, jobs), new AbortController().signal);
    };
    read = async () => { throw new Error("fixture GitHub outage"); };
    await repeat("outage", time + 2);
    expect(control(store, jobs, "show-outage", `show ${job.id}`, time + 2).update.text).toContain("GitHub lookup failed");
    read = async () => ({ ...snapshot(pull(8, time + 3)), self: "previously-other-owner" });
    await repeat("changed-identity", time + 3);
    expect(service.candidate(job, 8)).toBeNull();
    expect(control(store, jobs, "show-identity", `show ${job.id}`, time + 3).update.text).toContain("does not match the repository owner");

    const remove = control(store, jobs, "remove", `remove ${job.id}`, time + 4);
    expect(() => jobs.requireActivePrJob(remove.input, job.id)).toThrow();
    const whileRemoved = control(store, jobs, "show-removed", `show ${job.id} 7`, time + 4);
    expect(whileRemoved.update.text).toContain(`/cron pr-review ${job.id} 7 ${head} (uncertain)`);
    expect(control(store, jobs, "alternate", add, time + 5, alternate).update.state).toBe("cancelled");
    const revised = control(store, jobs, "re-enroll", add, time + 5);
    const reEnrolled = jobs.requireActivePrJob(revised.input, job.id);
    expect(reEnrolled).toMatchObject({ id: job.id, sourceId: job.sourceId, eligibleAfter: time + 5 });
    expect(reEnrolled.epoch).not.toBe(job.epoch);
    expect(service.canDeliver(offer)).toBe(false);
    read = async () => snapshot(pull(7, time + 6, "contributor", laterHead), pull(8, time + 4), pull(9, time + 6));
    await repeat("repeat", time + 6);
    expect(actions(store)).toEqual([`/cron pr-review ${job.id} 9 ${head}`]);
    expect(service.candidate(reEnrolled, 7)).toMatchObject({ head, outputId: offer.id });
    expect(store.output(offer.id)?.state).toBe("uncertain");
  } finally { store.close(); }
});

test.each(["repositoryId", "ownerId"] as const)("an empty first scan still pins %s across restart", async field => {
  using directory = mkdtempDisposableSync(join(realpathSync("/tmp"), "sa-cron-pr-"));
  const file = join(directory.path, "coordination.sqlite");
  let store = new Store(file);
  try {
    let jobs = new CronJobs(store, config(directory.path));
    const job = enroll(store, jobs);
    const empty = new CronPrIntake(store, jobs, async () => snapshot());
    control(store, jobs, "first", `run ${job.id}`, time + 1);
    await empty.consume(nextRun(store, jobs), new AbortController().signal);
    store.close();

    store = new Store(file);
    jobs = new CronJobs(store, config(directory.path));
    const replaced = new CronPrIntake(store, jobs, async () => ({
      ...snapshot(pull(8, time + 2)), [field]: identity[field] + 1,
    }));
    control(store, jobs, "second", `run ${job.id}`, time + 2);
    await replaced.consume(nextRun(store, jobs), new AbortController().signal);

    expect(replaced.candidate(job, 8)).toBeNull();
    expect(offers(store)).toEqual([]);
    expect(control(store, jobs, "show-replaced", `show ${job.id}`, time + 2).update.text).toContain("repository or owner identity changed");
  } finally { store.close(); }
});

test("an interrupted outbox write consumes the run's slot and is never retried after recovery", async () => {
  using directory = mkdtempDisposableSync(join(realpathSync("/tmp"), "sa-cron-pr-"));
  const file = join(directory.path, "coordination.sqlite");
  class InterruptedOutbox extends Store {
    override queueOutput(output: Parameters<Store["queueOutput"]>[0]): boolean {
      if (isPrIntakeOffer(output.id)) throw new Error("fixture outbox interruption");
      return super.queueOutput(output);
    }
    override settle(...args: Parameters<Store["settle"]>): boolean {
      if (args[0].startsWith(CRON_RUN_PREFIX)) throw new Error("fixture process lost before run settlement");
      return super.settle(...args);
    }
  }
  let store: Store = new InterruptedOutbox(file);
  try {
    let jobs = new CronJobs(store, config(directory.path));
    const job = enroll(store, jobs);
    const reader: ReadIntakePulls = async () => snapshot(pull(10, time + 2), pull(9, time + 1));
    let service = new CronPrIntake(store, jobs, reader);
    control(store, jobs, "first", `run ${job.id}`, time + 1);
    const interrupted = nextRun(store, jobs);
    await expect(service.consume(interrupted, new AbortController().signal))
      .rejects.toThrow("fixture process lost before run settlement");
    store.close();

    store = new Store(file);
    jobs = new CronJobs(store, config(directory.path));
    service = new CronPrIntake(store, jobs, reader);
    const recovered = nextRun(store, jobs);
    expect(recovered.id).toBe(interrupted.id);
    await service.consume(recovered, new AbortController().signal);
    expect(offers(store)).toEqual([]);

    control(store, jobs, "second", `run ${job.id}`, time + 2);
    await service.consume(nextRun(store, jobs), new AbortController().signal);

    expect(actions(store)).toEqual([`/cron pr-review ${job.id} 10 ${head}`]);
    expect(service.candidate(job, 9)).toMatchObject({ number: 9, head });
    expect(control(store, jobs, "show-interrupted", `show ${job.id} 9`, time + 2).update.text)
      .toContain(`/cron pr-review ${job.id} 9 ${head} (not queued; no automatic replay)`);
  } finally { store.close(); }
});

test("pause aborts an active read and resume fences its late result even when control times tie", async () => {
  using directory = mkdtempDisposableSync(join(realpathSync("/tmp"), "sa-cron-pr-"));
  const store = new Store(join(directory.path, "coordination.sqlite"));
  try {
    const jobs = new CronJobs(store, config(directory.path));
    const job = enroll(store, jobs);
    const entered = Promise.withResolvers<AbortSignal>();
    const reply = Promise.withResolvers<Awaited<ReturnType<ReadIntakePulls>>>();
    let read: ReadIntakePulls = async (_repo, signal) => {
      entered.resolve(signal);
      return reply.promise;
    };
    const service = new CronPrIntake(store, jobs, (repo, signal) => read(repo, signal));
    const commandTime = time + 300_000;
    jobs.poll(commandTime);
    const run = nextRun(store, jobs);
    const running = service.consume(run, new AbortController().signal);
    const signal = await entered.promise;
    const aborted = signal.aborted;
    control(store, jobs, "pause", `pause ${job.id}`, commandTime);
    service.cancelInactive();
    const pausedAbort = signal.aborted;
    const resume = control(store, jobs, "resume", `resume ${job.id}`, commandTime);
    reply.resolve(snapshot(pull(10, commandTime + 1)));
    await running;

    expect(aborted).toBe(false);
    expect(pausedAbort).toBe(true);
    expect(store.input(run.id)?.state).toBe("cancelled");
    expect(offers(store)).toEqual([]);
    const resumed = jobs.requireActivePrJob(resume.input, job.id);
    expect(resumed.epoch).not.toBe(job.epoch);
    read = async () => snapshot(pull(11, commandTime - 1), pull(12, commandTime + 1));
    control(store, jobs, "after-resume", `run ${job.id}`, commandTime);
    await service.consume(nextRun(store, jobs), new AbortController().signal);
    expect(actions(store)).toEqual([`/cron pr-review ${job.id} 12 ${head}`]);
  } finally { store.close(); }
});

test("restart holds pending scan recovery and HEAD stop requires a new per-job epoch before scanning", async () => {
  using directory = mkdtempDisposableSync(join(realpathSync("/tmp"), "sa-cron-pr-"));
  const store = new Store(join(directory.path, "coordination.sqlite"));
  try {
    const jobs = new CronJobs(store, config(directory.path));
    const job = enroll(store, jobs);
    let reads = 0;
    const service = new CronPrIntake(store, jobs, async () => {
      reads++;
      return snapshot(pull(13, time + 1));
    });
    jobs.poll(time + 300_000);
    const run = nextRun(store, jobs);
    store.setMeta("head:restart-fence", "restart");
    await service.consume(run, new AbortController().signal);
    expect(store.input(run.id)?.state).toBe("pending");
    store.setMeta("head:restart-fence", "");
    const oldStop = snowflake();
    const oldResume = snowflake();
    stopHead(store, jobs, "newer-physical-stop");
    stopHead(store, jobs, "late-older-stop", { messageId: oldStop });
    const stale = owner(store, "late-pre-stop-resume", `resume ${job.id}`, { messageId: oldResume });
    expect(settleControl(store, jobs, stale, `resume ${job.id}`).state).toBe("cancelled");
    expect(jobs.activePrEnrollment(job.id)).toBeNull();
    const resume = control(store, jobs, "resume-stopped", `resume ${job.id}`);
    expect(jobs.requireActivePrJob(resume.input, job.id).epoch).not.toBe(job.epoch);
    await service.consume(run, new AbortController().signal);
    expect(reads).toBe(0);
    expect(store.input(run.id)?.state).toBe("cancelled");
    expect(offers(store)).toEqual([]);
  } finally { store.close(); }
});

test("require-active scopes settled owner controls to the exact parent and rejects edit-to-prompt", () => {
  using directory = mkdtempDisposableSync(join(realpathSync("/tmp"), "sa-cron-pr-"));
  const store = new Store(join(directory.path, "coordination.sqlite"));
  try {
    const jobs = new CronJobs(store, config(directory.path));
    const job = enroll(store, jobs);
    const edit = control(store, jobs, "edit", `edit ${job.id} prompt Execute arbitrary text`);
    expect(edit.update.state).toBe("cancelled");
    const review = owner(store, "thread-review", "pr-review", { route: thread });
    store.settle(review.id, "done");
    expect(jobs.requireActivePrJob(review, job.id, parent)).toMatchObject({ id: job.id, kind: "pr-intake" });
    expect(() => jobs.requireActivePrJob(review, job.id)).toThrow();
    expect(() => jobs.requireActivePrJob(review, job.id, alternate)).toThrow();
    const forged = { ...review, route: parent };
    expect(() => jobs.requireActivePrJob(forged, job.id)).toThrow();
    const pendingReview = owner(store, "uncertain-owner", "pr-review");
    store.settle(pendingReview.id, "uncertain");
    expect(() => jobs.requireActivePrJob(pendingReview, job.id)).toThrow();
  } finally { store.close(); }
});
