import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Worker } from "node:worker_threads";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { asyncJobSnapshot } from "@oh-my-pi/pi-coding-agent/session/async-job-views";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { validateToolArguments } from "@oh-my-pi/pi-ai";
import { laneWaitKey, parseLaneReportResult, type LaneReportEvent } from "../src/lane-report";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(kind: "main" | "sub" = "main", role = "lane") {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "lane-report-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const auth = await AuthStorage.create(":memory:");
  cleanups.push(() => auth.close());
  const session = SessionManager.inMemory(directory);
  cleanups.push(async () => { await session.close(); });
  const agentDir = join(directory, "agent");
  mkdirSync(agentDir);
  const settings = await Settings.loadIsolated({ cwd: directory, agentDir });
  const jobs = new AsyncJobManager({ onJobComplete: () => {} });
  cleanups.push(async () => { await jobs.dispose(); });
  const previous = process.env.OMP_SUPERAGENT_ROLE;
  let loaded;
  try {
    process.env.OMP_SUPERAGENT_ROLE = role;
    loaded = await loadExtensions([resolve(import.meta.dir, "../src/lane-extension.ts")], directory);
  } finally {
    if (previous === undefined) delete process.env.OMP_SUPERAGENT_ROLE;
    else process.env.OMP_SUPERAGENT_ROLE = previous;
  }
  expect(loaded.errors).toEqual([]);
  const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, directory, session,
    new ModelRegistry(auth, join(directory, "models.yml"), { ignoreLocalModelConfig: true, settings }),
    undefined, settings, undefined, () => asyncJobSnapshot(jobs, undefined),
    { kind, id: kind === "main" ? "Main" : "child", name: kind, depth: 0 });
  cleanups.push(async () => { await runner.emit({ type: "session_shutdown" }); runner.clearManagedTimers(); });
  // Bind the real runner's native tool-selection surface without invoking an agent/provider.
  let active = ["read", "task", "lane_report"];
  loaded.runtime.getActiveTools = () => active.slice();
  loaded.runtime.setActiveTools = async names => { active = names.slice(); };
  loaded.runtime.appendEntry = (customType, data) => { session.appendCustomEntry(customType, data); };
  const definition = runner.getRegisteredTool("lane_report")?.definition;
  const execute = async (input: Record<string, unknown>, id = "native-report") => {
    if (!definition) throw new Error("lane_report is not registered");
    const params = validateToolArguments(definition,
      { type: "toolCall", id, name: "lane_report", arguments: input });
    return definition.execute(id, params, undefined, undefined, runner.createContext());
  };
  const call = (id: string, name = "bash", args: Record<string, unknown> = {}) => session.appendMessage({
    role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }],
    api: "openai-responses", provider: "fixture", model: "offline",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse", timestamp: 1,
  });
  const completed = (id: string, name = "bash", isError = false, details: unknown = { exitCode: 0 }, timestamp = 2) =>
    session.appendMessage({ role: "toolResult", toolCallId: id, toolName: name,
      content: [{ type: "text", text: "Actual fixture tool result" }], details, isError, timestamp });
  return { directory, runner, session, jobs, definition, execute, call, completed,
    active: () => active, select: async (names: string[]) => loaded.runtime.setActiveTools(names) };
}

describe("native lane reporting", () => {
  test("root lane receipts bind native session/call identity and never create coordination authority", async () => {
    const f = await fixture();
    await f.runner.emit({ type: "session_start" });
    expect(f.active()).toEqual(["read", "task", "lane_report"]);
    expect(f.definition).toMatchObject({ name: "lane_report", approval: "read", loadMode: "essential" });
    expect(f.runner.getAllRegisteredTools().map(tool => tool.definition.name)).toEqual(["decision_ask", "lane_report"]);
    const branch = structuredClone(f.session.getBranch());
    const output = await f.execute({ status: "waiting", summary: "Needs owner review",
      waiting: { kind: "dependency", target: "owner's review" } }, "actual-execute-id");
    expect(parseLaneReportResult(output)).toEqual({
      type: "superagent-lane-report", sessionId: f.session.getSessionId(), reportId: "actual-execute-id",
      report: { status: "waiting", summary: "Needs owner review", evidence: [],
        waiting: { kind: "dependency", target: "owner's review" } },
    });
    expect(output.content).toEqual([{ type: "text", text: "Recorded lane waiting observation in the native tool result." }]);
    const journal = f.session.getBranch();
    expect(journal.slice(0, -1)).toEqual(branch);
    const entry = journal.at(-1)!;
    expect(entry).toMatchObject({ type: "custom", customType: "superagent-lane-report", data: output.details });
    expect(typeof entry.timestamp).toBe("string");
    expect(Number.isFinite(Date.parse(entry.timestamp))).toBe(true);
    expect(output.details).not.toHaveProperty("timestamp");
    await f.select(["read"]);
    await f.runner.emit({ type: "session_start" });
    expect(f.active()).toEqual(["read"]);
  });

  test("children are excluded, blocked at tool_call, and refused even after manual reactivation", async () => {
    const f = await fixture("sub");
    await f.runner.emit({ type: "session_start" });
    expect(f.active()).toEqual(["read", "task"]);
    const input = { status: "waiting", summary: "Not root", waiting: { kind: "dependency", target: "review" } };
    expect(await f.runner.emitToolCall({ type: "tool_call", toolName: "lane_report", toolCallId: "child-call", input }))
      .toMatchObject({ block: true });
    await f.select(["read", "lane_report"]);
    await expect(f.execute(input)).rejects.toThrow("restricted to the root lane session");
    await f.runner.emit({ type: "session_start" });
    expect(f.active()).toEqual(["read"]);
  });

  test.each(["head", ""])("does not register lane reports outside lane role: %s", async role => {
    const f = await fixture("main", role);
    expect(f.definition).toBeUndefined();
  });

  test("native argument validation rejects forged identity/hashes and incomplete status variants", async () => {
    const f = await fixture();
    const valid = { status: "waiting", summary: "Awaiting data", waiting: { kind: "dependency", target: "dataset" } };
    for (const input of [
      {}, { ...valid, summary: " " }, { ...valid, status: "progress" }, { ...valid, status: "resolved" },
      { ...valid, waiting: { kind: "tool", target: "compiler" } },
      { status: "progress", summary: "No evidence", evidence: [] },
    ]) {
      await expect(f.execute(input)).rejects.toThrow(/Validation failed for tool|Invalid lane report parameters/);
      await expect(f.definition!.execute("direct", input, undefined, undefined, f.runner.createContext()))
        .rejects.toThrow("Invalid lane report parameters");
    }
    for (const input of [
      { ...valid, sessionId: "claimed" }, { ...valid, reportId: "claimed" },
      { ...valid, waiting: { kind: "dependency", target: "dataset", id: "fabricated" } },
      { ...valid, evidence: [{ kind: "file", path: "file", fingerprint: "a".repeat(64) }] },
      { status: "progress", summary: "Chatter", evidence: [{ kind: "tool", toolCallId: "id", ref: "claimed" }] },
    ]) {
      // OMP may normalize away unknown fields before execution. A direct call
      // must refuse them, and no surviving caller field can supply a fingerprint.
      await expect(f.definition!.execute("direct", input, undefined, undefined, f.runner.createContext()))
        .rejects.toThrow("Invalid lane report parameters");
    }
  });

  test("file evidence hashes canonical regular bytes and only explicitly selected evidence", async () => {
    const f = await fixture();
    const path = join(f.directory, "artifact.bin");
    const bytes = Buffer.alloc(1024 * 1024 + 5, Buffer.from([0, 255, 1, 128, 10]));
    writeFileSync(path, bytes);
    symlinkSync("artifact.bin", join(f.directory, "artifact-link"));
    writeFileSync(join(f.directory, "not-selected"), "Must not leak");
    const input = { status: "progress", summary: "Wrote artifact", evidence: [{ kind: "file", path: "artifact-link" }] };
    const first = parseLaneReportResult(await f.execute(input))!;
    expect(first.report.evidence).toEqual([{ kind: "file", ref: path,
      fingerprint: createHash("sha256").update(bytes).digest("hex") }]);
    expect(parseLaneReportResult(await f.execute(input, "different-report-id"))!.report.evidence).toEqual(first.report.evidence);
    writeFileSync(path, Buffer.from([0, 255, 1, 128, 11]));
    const changed = parseLaneReportResult(await f.execute(input))!;
    expect(changed.report.evidence[0]!.fingerprint).not.toBe(first.report.evidence[0]!.fingerprint);
    for (const path of ["missing", "."]) {
      await expect(f.execute({ ...input, evidence: [{ kind: "file", path }] })).rejects.toThrow();
    }
  });

  test("rejects a file being changed during the read without retrying", async () => {
    const f = await fixture();
    const path = join(f.directory, "unstable.bin");
    writeFileSync(path, Buffer.alloc(32 * 1024 * 1024));
    const state = new Int32Array(new SharedArrayBuffer(4));
    const writer = new Worker(`
      const { workerData, parentPort } = require("node:worker_threads");
      const { openSync, writeSync, closeSync } = require("node:fs");
      const state = new Int32Array(workerData.state);
      const fd = openSync(workerData.path, "r+");
      const bytes = Buffer.alloc(4096);
      writeSync(fd, bytes, 0, bytes.length, 0);
      parentPort.postMessage("ready");
      while (Atomics.load(state, 0) !== -1) {
        bytes[0] = (bytes[0] + 1) & 255;
        writeSync(fd, bytes, 0, bytes.length, 0);
        Atomics.add(state, 0, 1);
        Atomics.notify(state, 0);
      }
      closeSync(fd);
    `, { eval: true, workerData: { state: state.buffer, path } });
    try {
      await once(writer, "message");
      await expect(f.execute({ status: "progress", summary: "Unstable file",
        evidence: [{ kind: "file", path }] })).rejects.toThrow("changed while being read");
    } finally {
      Atomics.store(state, 0, -1);
      await writer.terminate();
    }
  });

  test("tool evidence requires an actual successful completed call in the current branch", async () => {
    const f = await fixture();
    f.call("success");
    f.completed("success");
    f.call("same-output");
    f.completed("same-output", "bash", false, { exitCode: 0 }, 999);
    f.call("changed");
    f.completed("changed", "bash", false, { exitCode: 1 });
    f.call("pending");
    f.call("failed");
    f.completed("failed");
    f.completed("failed", "bash", true);
    f.completed("orphan");
    f.call("wrong-name");
    f.completed("wrong-name", "read");
    const input = (toolCallId: string) => ({ status: "progress", summary: "Observed command result",
      evidence: [{ kind: "tool", toolCallId }] });
    const first = parseLaneReportResult(await f.execute(input("success")))!;
    expect(first.report.evidence).toHaveLength(1);
    expect(first.report.evidence[0]).toEqual({ kind: "tool", ref: "success",
      fingerprint: createHash("sha256").update(JSON.stringify({ toolName: "bash",
        content: [{ type: "text", text: "Actual fixture tool result" }], details: { exitCode: 0 }, isError: false })).digest("hex") });
    const second = parseLaneReportResult(await f.execute(input("same-output")))!;
    expect(second.report.evidence[0]!.fingerprint).toBe(first.report.evidence[0]!.fingerprint);
    expect(parseLaneReportResult(await f.execute(input("changed")))!.report.evidence[0]!.fingerprint)
      .not.toBe(first.report.evidence[0]!.fingerprint);
    for (const id of ["pending", "failed", "missing", "orphan", "wrong-name"]) {
      await expect(f.execute(input(id))).rejects.toThrow("completed successful native tool call");
    }
    f.session.resetLeaf();
    expect(f.session.getEntries().length).toBeGreaterThan(0);
    await expect(f.execute(input("success"))).rejects.toThrow("completed successful native tool call");
  });

  test("a tool wait keeps evidence order and duplicates while using the first call and latest result", async () => {
    const f = await fixture();
    f.call("repeated", "bash");
    f.completed("repeated", "bash", true);
    f.call("repeated", "read");
    f.completed("repeated", "bash", false, { exitCode: 1 });
    f.call("other", "read");
    f.completed("other", "read");
    f.call("pending");
    const waiting = { kind: "tool", id: "pending", target: "compiler" };
    const output = await f.execute({ status: "waiting", summary: "Waiting for a second compile", waiting,
      evidence: ["other", "repeated", "other"].map(toolCallId => ({ kind: "tool", toolCallId })) });
    expect(parseLaneReportResult(output)?.report).toMatchObject({ waiting, evidence: [
      { kind: "tool", ref: "other" }, { kind: "tool", ref: "repeated" }, { kind: "tool", ref: "other" },
    ] });
  });

  test("report and board results cannot manufacture tool evidence", async () => {
    const f = await fixture();
    for (const name of ["lane_report", "board_post", "board_read", "board_subscribe"]) {
      f.call(name, name);
      f.completed(name, name);
      await expect(f.execute({ status: "progress", summary: "Chatter",
        evidence: [{ kind: "tool", toolCallId: name }] })).rejects.toThrow("not report/board chatter");
    }
    const wrapped = await f.execute({ status: "waiting", summary: "Review", waiting: { kind: "dependency", target: "review" } });
    f.call("wrapped-report", "write");
    f.completed("wrapped-report", "write", false, wrapped.details);
    await expect(f.execute({ status: "progress", summary: "Wrapped receipt",
      evidence: [{ kind: "tool", toolCallId: "wrapped-report" }] })).rejects.toThrow("not report/board chatter");
    f.call("board-device", "write", { path: "xd://board_read", content: "{}" });
    f.completed("board-device", "write");
    await expect(f.execute({ status: "progress", summary: "Forwarded board chatter",
      evidence: [{ kind: "tool", toolCallId: "board-device" }] })).rejects.toThrow("not report/board chatter");
  });

  test("tool and approval waits require current native identities; resolved is only an evidence-backed observation", async () => {
    const f = await fixture();
    const input = (kind: string, id: string) => ({ status: "waiting", summary: "Awaiting compiler",
      waiting: { kind, id, target: "compiler" } });
    f.call("pending");
    expect(parseLaneReportResult(await f.execute(input("tool", "pending")))!.report.waiting)
      .toEqual({ kind: "tool", id: "pending", target: "compiler" });
    await expect(f.execute(input("tool", "invented"))).rejects.toThrow("actual pending native tool call");
    f.completed("pending");
    await expect(f.execute(input("tool", "pending"))).rejects.toThrow("actual pending native tool call");
    await expect(f.execute(input("approval", "approval"))).rejects.toThrow("observed pending native tool approval");
    const approval = { type: "tool_approval_requested" as const, sessionId: f.session.getSessionId(),
      toolCallId: "approval", toolName: "bash", approvalMode: "always-ask" as const };
    await f.runner.emit({ ...approval, sessionId: "other-session" });
    await expect(f.execute(input("approval", "approval"))).rejects.toThrow("observed pending native tool approval");
    await f.runner.emit(approval);
    expect(parseLaneReportResult(await f.execute(input("approval", "approval")))!.report.status).toBe("waiting");
    await f.runner.emit({ type: "tool_approval_resolved", sessionId: f.session.getSessionId(),
      toolCallId: "approval", toolName: "bash", approved: false });
    await expect(f.execute(input("approval", "approval"))).rejects.toThrow("observed pending native tool approval");
    await f.runner.emit(approval);
    await f.session.newSession();
    await expect(f.execute(input("approval", "approval"))).rejects.toThrow("observed pending native tool approval");
    f.call("new-session-evidence");
    f.completed("new-session-evidence");
    const waiting = { kind: "dependency", target: "upstream dataset" };
    const output = await f.execute({ status: "resolved", summary: "Dataset arrived", waiting,
      evidence: [{ kind: "tool", toolCallId: "new-session-evidence" }] });
    expect(parseLaneReportResult(output)!.report).toMatchObject({ status: "resolved", waiting });
    expect(output.content).toEqual([{ type: "text", text: "Recorded lane resolved observation in the native tool result." }]);
  });

  test("job waits name real running native jobs without claiming resolution authority", async () => {
    const f = await fixture();
    const work = Promise.withResolvers<string>();
    const id = f.jobs.register("eval", "bounded fixture job", () => work.promise);
    const input = { status: "waiting", summary: "Waiting for fixture job", waiting: { kind: "job" as const, id, target: "fixture job" } };
    try {
      expect(parseLaneReportResult(await f.execute(input))!.report.waiting).toEqual(input.waiting);
      await expect(f.execute({ ...input, waiting: { ...input.waiting, id: "made-up-job" } }))
        .rejects.toThrow("running native session job");
    } finally {
      work.resolve("done");
      await f.jobs.waitForAll();
    }
    await expect(f.execute(input)).rejects.toThrow("running native session job");
  });
});

describe("lane report parsing and identity", () => {
  const event: LaneReportEvent = { type: "superagent-lane-report", sessionId: "session", reportId: "call",
    report: { status: "progress", summary: "Changed real file",
      evidence: [{ kind: "file", ref: "/workspace/file", fingerprint: "a".repeat(64) }] } };

  test("wait keys retain native target identity across label changes and preserve exact dependency labels", () => {
    for (const kind of ["tool", "approval", "job"] as const) {
      expect(laneWaitKey({ kind, id: "native-id", target: "old label" }))
        .toBe(laneWaitKey({ kind, id: "native-id", target: "new label" }));
      expect(laneWaitKey({ kind, id: "native-id", target: "same" }))
        .not.toBe(laneWaitKey({ kind, id: "other-id", target: "same" }));
    }
    expect(laneWaitKey({ kind: "tool", id: "same", target: "label" }))
      .not.toBe(laneWaitKey({ kind: "approval", id: "same", target: "label" }));
    expect(laneWaitKey({ kind: "dependency", target: "review" }))
      .not.toBe(laneWaitKey({ kind: "dependency", target: "review " }));
  });

  test("parses structured receipts only and rejects malformed/forged schemas without throwing", () => {
    expect(parseLaneReportResult({ details: event })).toEqual(event);
    expect(parseLaneReportResult({ role: "toolResult", toolName: "lane_report", toolCallId: "call",
      timestamp: 123, content: [{ type: "text", text: "Native journal receipt" }], isError: false, details: event }))
      .toEqual(event);
    const changed = (report: unknown) => ({ details: { ...event, report } });
    for (const input of [
      null, {}, event, { content: [{ type: "text", text: JSON.stringify(event) }] },
      { details: event, isError: true }, { details: { ...event, sessionId: "" } },
      { details: { ...event, reportId: "" } }, { details: { ...event, sourceId: "forged" } },
      changed({ ...event.report, status: "done" }), changed({ ...event.report, summary: " " }),
      changed({ ...event.report, evidence: [] }), changed({ ...event.report, waiting: { kind: "dependency", target: "review" } }),
      changed({ status: "waiting", summary: "Waiting", evidence: [] }),
      changed({ status: "resolved", summary: "Resolved", waiting: { kind: "dependency", target: "review" }, evidence: [] }),
      changed({ status: "waiting", summary: "Waiting", waiting: { kind: "dependency", target: "review", id: "fake" }, evidence: [] }),
      changed({ status: "waiting", summary: "Waiting", waiting: { kind: "approval", target: "review" }, evidence: [] }),
      ...["", "sha256:" + "a".repeat(64), "z".repeat(64), "A".repeat(64)].map(fingerprint =>
        changed({ ...event.report, evidence: [{ ...event.report.evidence[0], fingerprint }] })),
      changed({ ...event.report, evidence: [{ ...event.report.evidence[0], ref: "relative/file" }] }),
      changed({ ...event.report, evidence: [{ ...event.report.evidence[0], ref: "/workspace/../file" }] }),
      changed({ ...event.report, evidence: [{ ...event.report.evidence[0], hash: "caller-supplied" }] }),
      Object.defineProperty({}, "details", { get() { throw new Error("Malformed accessor"); } }),
    ]) {
      expect(() => parseLaneReportResult(input)).not.toThrow();
      expect(parseLaneReportResult(input)).toBeNull();
    }
  });
});
