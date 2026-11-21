import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseSessionEntries, SessionManager } from "@oh-my-pi/pi-coding-agent";
import { startHost, HostConnection, type HostFrame, type HostOptions } from "../src/host";
import { nativeDisabledProviders } from "./fixtures/native-extension";
import { serviceCompletionRecorded } from "../src/host-protocol";
import { decisionId } from "../src/decisions";
import { assertResidentFixtureOwner, stopHostFixtures, waitForFixtureProcessExit } from "./fixtures/host-fixture-processes";
import { nativeTestCommand } from "./fixtures/native-command";
import { offlineMnemopi } from "./fixtures/native-memory";

const nativeTest = process.env.OMP_SUPERAGENT_NATIVE_TEST === "1" ? test : test.skip;
const RECORD_TYPE = "omp-superagent-native-test";
const fixturePath = path.resolve(import.meta.dir, "fixtures/native-extension.ts");

interface FixtureRecord {
  fixture?: string;
  phase: string;
  token: string;
  sessionId: string;
  pid: number;
  confirmed?: boolean;
  agentStarts: number;
  networkAttempts: number;
  answers?: FixtureRecord[];
}

function observe(connection: HostConnection, matches: (frame: HostFrame) => boolean) {
  const { promise, resolve, reject } = Promise.withResolvers<HostFrame>();
  void promise.catch(() => {});
  const unsubscribe = connection.onFrame(frame => {
    if (!matches(frame)) return;
    cancel();
    resolve(frame);
  });
  const timer = setTimeout(() => {
    cancel();
    reject(new Error("Native host did not emit the expected RPC frame"));
  }, 10_000);
  const cancel = () => { clearTimeout(timer); unsubscribe(); };
  return { promise, cancel };
}

function notification(frame: HostFrame): FixtureRecord | undefined {
  if (frame.type !== "extension_ui_request" || frame.method !== "notify" || typeof frame.message !== "string") return;
  let data: unknown;
  try { data = JSON.parse(frame.message); } catch { return; }
  if (typeof data === "object" && data !== null && "fixture" in data && data.fixture === RECORD_TYPE) {
    return data as FixtureRecord;
  }
}

async function checkpoint(connection: HostConnection, token: string, id: string): Promise<FixtureRecord> {
  const event = observe(connection, frame => notification(frame)?.token === token);
  const completion = observe(connection, frame => frame.type === "prompt_result" && frame.id === id);
  try {
    const response = await connection.request({ type: "prompt", message: `/fixture-state ${token}` }, id);
    expect(response).toMatchObject({ id, command: "prompt", success: true });
    expect(await completion.promise).toMatchObject({ id, status: "completed", agentInvoked: false, sessionSettled: true });
    return notification(await event.promise)!;
  } finally { event.cancel(); completion.cancel(); }
}

async function proveForeignServiceSurvives(options: HostOptions, connection: HostConnection): Promise<void> {
  const root = path.dirname(options.socketPath);
  const owner = { ...options, socketPath: path.join(root, "foreign.sock"), sessionFile: path.join(root, "foreign.jsonl") };
  const host = await startHost(owner);
  const foreign = await HostConnection.connect(owner.socketPath);
  const release = path.join(options.cwd, ".sa-release-foreign");
  const started = observe(foreign, frame => frame.type === "prompt_result" && frame.id === "foreign-start");
  const completed = observe(foreign, frame => frame.type === "message_end"
    && (frame.message as { customType?: string } | undefined)?.customType === "launch-completion");
  const refused = observe(connection, frame => frame.type === "message_end"
    && (frame.message as { toolCallId?: string } | undefined)?.toolCallId === "native-foreign-service");
  const settled = observe(connection, frame => frame.type === "prompt_result" && frame.id === "native-foreign-service-proof");
  try {
    const identity = await foreign.client.getState();
    expect(await foreign.request({ type: "prompt", message: "[native-foreign-service-owner] Start the original service." },
      "foreign-start")).toMatchObject({ success: true });
    expect(await started.promise).toMatchObject({ status: "completed", agentInvoked: true });
    expect((await foreign.client.getState()).hasOwnedRunningWork).toBe(true);
    expect(await connection.request({ type: "prompt", message: "[native-foreign-service-proof] Try the named-service collision fixture." },
      "native-foreign-service-proof")).toMatchObject({ success: true });
    const message = (await refused.promise).message as { isError: boolean; content: unknown };
    expect(message.isError).toBe(true);
    expect(JSON.stringify(message.content)).toContain("belongs to another session");
    expect(await settled.promise).toMatchObject({ status: "completed", agentInvoked: true });
    expect((await connection.client.getState()).hasOwnedRunningWork).toBe(false);
    expect((await foreign.client.getState()).hasOwnedRunningWork).toBe(true);
    await fs.writeFile(release, "");
    expect((await completed.promise).message).toMatchObject({
      details: { daemons: [expect.objectContaining({ owner: identity.sessionId, state: "exited", exitCode: 0 })] },
    });
    expect(await fs.readFile(path.join(options.cwd, ".sa-foreign-receipt"), "utf8")).toBe("original process exited\n");
    await foreign.client.waitForSettled(30_000);
    expect(await foreign.request({ type: "shutdown_host" })).toMatchObject({ success: true });
    await foreign.exited;
    await waitForFixtureProcessExit([host.pid, identity.adapterOwnerPid]);
  } finally {
    started.cancel(); completed.cancel(); refused.cancel(); settled.cancel();
    await fs.writeFile(release, "");
    await foreign.close();
  }
}

nativeTest("actual OMP preserves approvals and structured owner decisions across one persistent host", async () => {
  const command = await nativeTestCommand();
  const nativesDirectory = process.env.OMP_TEST_NATIVES_DIR;
  if (nativesDirectory && !path.isAbsolute(nativesDirectory)) {
    throw new Error("OMP_TEST_NATIVES_DIR must be an explicit absolute native-cache path");
  }
  const root = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "osn-"));
  await fs.chmod(root, 0o700);
  const home = path.join(root, "home");
  const agentDirectory = path.join(root, "agent");
  const cwd = path.join(root, "workspace");
  for (const directory of [home, agentDirectory, cwd]) await fs.mkdir(directory, { mode: 0o700 });
  const configPath = path.join(agentDirectory, "config.yml");
  await fs.writeFile(configPath, JSON.stringify({ ...offlineMnemopi, task: { maxConcurrency: 1 }, disabledProviders: nativeDisabledProviders,
    bash: { patterns: [{ match: "printf 'superagent-service-completed\\n'", approval: "prompt" }] },
    eval: { js: false, py: false } }), { mode: 0o600 });
  const options: HostOptions = {
    command,
    socketPath: path.join(root, "host.sock"), sessionFile: path.join(root, "main.jsonl"),
    cwd, extensionPath: fixturePath, logPath: path.join(root, "native.log"),
    env: {
      OMP_TEST_HOST_FIXTURE_ROOT: root,
      PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, USERPROFILE: home,
      PI_CODING_AGENT_DIR: agentDirectory, PI_NO_TITLE: "1", CI: "true", NO_COLOR: "1",
      OMP_SUPERAGENT_ROLE: "lane",
      ...(nativesDirectory ? { PI_NATIVES_DIR: nativesDirectory } : {}),
      XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"),
      XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state"),
      OMP_DAEMON_DIR: path.join(root, "daemon"),
      TMPDIR: root, TMP: root, TEMP: root,
    },
    managedUlwPath: path.resolve(import.meta.dir, "fixtures/managed-ulw"),
    model: "socket-host-smoke/local", subagentConcurrency: 1,
  };
  let succeeded = false;
  const connections = new Set<HostConnection>();
  try {
    const child = await startHost(options);
    const first = await HostConnection.connect(options.socketPath);
    connections.add(first);
    const initial = await first.client.getState();
    expect(initial.hostPid).toBe(child.pid);
    expect(initial.sessionFile).toBe(options.sessionFile);
    expect(initial.model).toMatchObject({ provider: "socket-host-smoke", id: "local" });
    const before = await checkpoint(first, "before-detach", "native-checkpoint-before");
    expect(before).toMatchObject({ sessionId: initial.sessionId, pid: child.pid, agentStarts: 0, networkAttempts: 0, answers: [] });

    const approval = observe(first, frame => frame.type === "extension_ui_request" && frame.method === "confirm" && frame.message === "original-approval-token");
    let dialog: HostFrame;
    try {
      const accepted = await first.request({ type: "prompt", message: "/fixture-ask original-approval-token" }, "native-persisted-approval");
      expect(accepted).toMatchObject({ id: "native-persisted-approval", success: true });
      dialog = await approval.promise;
    } finally { approval.cancel(); }
    expect(typeof dialog.id).toBe("string");
    const deniedShutdown = await first.request({ type: "shutdown_host" }, "native-refused-shutdown");
    expect(deniedShutdown).toMatchObject({ command: "shutdown_host", success: false, code: "session_busy" });
    expect((await first.client.getState()).pendingUiRequests).toContainEqual(expect.objectContaining({ id: dialog.id, method: "confirm" }));

    await first.close();
    await first.exited;
    process.kill(child.pid!, 0);
    const second = await HostConnection.connect(options.socketPath);
    connections.add(second);
    const reattached = await second.client.getState();
    expect(reattached).toMatchObject({ sessionId: initial.sessionId, sessionFile: options.sessionFile, hostPid: child.pid,
      adapterOwnerPid: initial.adapterOwnerPid, journalCursorVersion: 1 });
    await assertResidentFixtureOwner(root, { nativePid: child.pid, ownerPid: reattached.adapterOwnerPid });
    expect(reattached.pendingUiRequests).toContainEqual(expect.objectContaining({ id: dialog.id, message: "original-approval-token" }));
    expect(await second.request({ type: "shutdown_host" }, "native-still-refused-shutdown")).toMatchObject({ success: false, code: "session_busy" });

    const answer = observe(second, frame => notification(frame)?.phase === "answer");
    try {
      second.uiResponse(dialog.id as string, { confirmed: true });
      expect(notification(await answer.promise)).toMatchObject({ phase: "answer", token: "original-approval-token", confirmed: true, sessionId: initial.sessionId, pid: child.pid });
    } finally { answer.cancel(); }
    // Late answers from another surface must not run the handler a second time.
    second.uiResponse(dialog.id as string, { confirmed: false });
    const after = await checkpoint(second, "after-answer", "native-checkpoint-after");
    expect(after.answers).toHaveLength(1);
    expect(after.answers?.[0]).toMatchObject({ token: "original-approval-token", confirmed: true });
    expect(after).toMatchObject({ agentStarts: 0, networkAttempts: 0 });
    const cursor = await second.request({ type: "get_journal_cursor" }, "native-cursor-after-reattach");
    const journal = await second.request({ type: "get_entries" });
    if (!journal.success || journal.command !== "get_entries") throw new Error("Stock journal query failed");
    const leaf = parseSessionEntries(await fs.readFile(options.sessionFile, "utf8"))
      .find(entry => entry.type !== "session" && entry.id === journal.data.leafId);
    expect(leaf).toMatchObject({ type: "custom", customType: "rpc_prompt_result", data: {
      sessionId: initial.sessionId, frame: { id: "native-checkpoint-after", status: "completed" },
    } });
    expect(cursor).toEqual({ type: "response", command: "get_journal_cursor", id: "native-cursor-after-reattach",
      success: true, data: { leafId: journal.data.leafId } });

    const formId = "native-untimed-form";
    const formOutcome = observe(second, frame => notification(frame)?.token === formId);
    const formSettled = observe(second, frame => frame.type === "prompt_result" && frame.id === formId);
    const publishedForms: HostFrame[] = [];
    const unsubscribeForm = second.onFrame(frame => {
      if (frame.type === "extension_ui_request" && frame.method === "form") publishedForms.push(frame);
    });
    let formPhase: string;
    try {
      const [accepted, outcome, settled] = await Promise.all([
        second.request({ type: "prompt", message: `/fixture-form ${formId}` }, formId),
        formOutcome.promise, formSettled.promise,
      ]);
      expect(accepted).toMatchObject({ id: formId, success: true });
      const result = notification(outcome);
      if (!result) throw new Error("Missing native form outcome");
      expect(result).toMatchObject({ sessionId: initial.sessionId, pid: child.pid, agentStarts: 0, networkAttempts: 0 });
      formPhase = result.phase;
      if (formPhase === "form-unavailable") {
        // Earlier stock RPCs don't expose ui.formDialog.
        const version = Bun.spawnSync([...command, "--version"], { timeout: 10_000, stdout: "pipe" });
        expect(version.exitCode).toBe(0);
        expect(version.stdout.toString().trim()).toMatch(/^omp\/(?:18\.\d+|19\.0)\./);
      } else {
        expect(formPhase).toBe("form-cancelled");
      }
      expect(settled).toMatchObject({ id: formId, status: "completed", agentInvoked: false, sessionSettled: true });
      expect(publishedForms).toEqual([]);
      expect((await second.client.getState()).pendingUiRequests).toEqual([]);
    } finally { unsubscribeForm(); formOutcome.cancel(); formSettled.cancel(); }

    const decisionProof: { request: HostFrame; result: unknown }[] = [];
    for (const action of ["submit", "cancel"] as const) {
      const id = decisionId(initial.sessionId, `native-decision-${action}`);
      const ui = observe(second, frame => frame.type === "extension_ui_request" && frame.method === "ask");
      const result = observe(second, frame => frame.type === "message_end"
        && (frame.message as { role?: string; toolCallId?: string } | undefined)?.role === "toolResult"
        && (frame.message as { toolCallId?: string }).toolCallId === `native-decision-${action}`);
      const settled = observe(second, frame => frame.type === "prompt_result" && frame.id === `native-owner-${action}`);
      try {
        expect(await second.request({ type: "prompt", message: `[native-decision-${action}] Ask a structured owner question.` },
          `native-owner-${action}`)).toMatchObject({ success: true });
        const request = await ui.promise;
        expect(request.questions).toEqual([
          { id: `${id}:0`, question: "Which release route?", header: "Release",
            options: [{ label: "Local", description: "Keep changes local", preview: "No deployment" },
              { label: "Review", description: "Prepare review" }], recommended: 1 },
          { id: `${id}:1`, question: "Which checks?", options: [{ label: "Types" }, { label: "Tests" }], multi: true },
        ]);
        expect(request.timeout).toBeUndefined();
        expect(typeof request.id).toBe("string");
        const answers = [
          { id: `${id}:0`, selectedOptions: ["Local"] },
          { id: `${id}:1`, selectedOptions: ["Types", "Tests"], customInput: "Also inspect native RPC" },
        ];
        second.uiResponse(request.id as string, action === "submit" ? { answers } : { cancelled: true });
        const message = (await result.promise).message as { content: unknown; details: unknown; isError?: boolean };
        const expected = action === "submit" ? {
          id, status: "submitted", answers: [
            { id: `${id}:0`, question: "Which release route?", options: ["Local", "Review"], multi: false, selectedOptions: ["Local"] },
            { id: `${id}:1`, question: "Which checks?", options: ["Types", "Tests"], multi: true,
              selectedOptions: ["Types", "Tests"], customInput: "Also inspect native RPC" },
          ],
        } : { id, status: "cancelled" };
        expect(message.isError).not.toBe(true);
        expect(message.details).toEqual(expected);
        expect(message.content).toEqual([{ type: "text", text: JSON.stringify(expected, null, 2) }]);
        decisionProof.push({ request, result: message });
        expect(await settled.promise).toMatchObject({ status: "completed", agentInvoked: true });
        await second.client.waitForSettled(30_000);
      } finally { ui.cancel(); result.cancel(); settled.cancel(); }
    }
    expect(decisionProof).toHaveLength(2);
    await fs.writeFile(path.join(root, "native-decision-proof.json"), JSON.stringify(decisionProof, null, 2));
    const isServiceApproval = (frame: HostFrame) => frame.type === "extension_ui_request" && frame.method === "select"
      && Array.isArray(frame.options) && frame.options.includes("Deny") && String(frame.title).includes("superagent-service-completed");
    const deniedDialog = observe(second, isServiceApproval);
    const denial = observe(second, frame => frame.type === "message_end"
      && (frame.message as { toolCallId?: string } | undefined)?.toolCallId === "native-service-denied");
    const denialResult = observe(second, frame => frame.type === "prompt_result" && frame.id === "native-service-denial-proof");
    try {
      expect(await second.request({ type: "prompt", message: "[native-service-denial-proof] Request the named service once." },
        "native-service-denial-proof")).toMatchObject({ success: true });
      const dialog = await deniedDialog.promise;
      expect(typeof dialog.id).toBe("string");
      second.uiResponse(dialog.id as string, { value: "Deny" });
      expect((await denial.promise).message).toMatchObject({ isError: true,
        content: [{ type: "text", text: "Tool call denied by user: bash" }] });
      expect(await denialResult.promise).toMatchObject({ status: "completed", agentInvoked: true });
      await second.client.waitForSettled(30_000);
      expect((await second.client.getState()).hasOwnedRunningWork).toBe(false);
    } finally { deniedDialog.cancel(); denial.cancel(); denialResult.cancel(); }
    const approvedDialog = observe(second, isServiceApproval);
    const service = observe(second, frame => frame.type === "message_end"
      && (frame.message as { customType?: string } | undefined)?.customType === "launch-completion");
    const overlap = observe(second, frame => frame.type === "message_end"
      && (frame.message as { toolCallId?: string } | undefined)?.toolCallId === "native-service-overlap");
    const blank = observe(second, frame => frame.type === "message_end"
      && (frame.message as { toolCallId?: string } | undefined)?.toolCallId === "native-service-blank");
    const serviceResult = observe(second, frame => frame.type === "prompt_result" && frame.id === "native-service-proof");
    try {
      expect(await second.request({ type: "prompt", message: "[native-service-proof] Run the local finite named-service fixture." },
        "native-service-proof")).toMatchObject({ success: true });
      const dialog = await approvedDialog.promise;
      expect(typeof dialog.id).toBe("string");
      expect(dialog.options).toContain("Approve");
      second.uiResponse(dialog.id as string, { value: "Approve" });
      const completion = (await service.promise).message as { details: { daemons: Record<string, unknown>[] } };
      expect(completion.details.daemons).toEqual([expect.objectContaining({
        id: expect.any(String), owner: initial.sessionId, state: "exited", exitCode: 0,
      })]);
      const [reported] = completion.details.daemons;
      if (reported && "generation" in reported) {
        expect(reported).toMatchObject({ kind: "proc", key: "sa-host-proof", pids: [],
          generation: expect.any(String), scope: { kind: "project", dir: await fs.realpath(cwd) } });
      } else {
        expect(reported).toMatchObject({ name: "sa-host-proof", restartCount: 0 });
      }
      const refused = (await overlap.promise).message as { isError: boolean; content: unknown };
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused.content)).toContain("already in progress");
      const finite = (await blank.promise).message as { isError?: boolean; content: unknown };
      expect(finite.isError).not.toBe(true);
      expect(JSON.stringify(finite.content)).toContain("ordinary finite Bash");
      expect(await serviceResult.promise).toMatchObject({ status: "completed", agentInvoked: true });
      await second.client.waitForSettled(30_000);
      expect((await second.client.getState()).hasOwnedRunningWork).toBe(false);
    } finally { approvedDialog.cancel(); service.cancel(); overlap.cancel(); blank.cancel(); serviceResult.cancel(); }
    await proveForeignServiceSurvives(options, second);
    const finalState = await second.client.getState();
    expect(finalState).toMatchObject({ sessionId: initial.sessionId, hostPid: child.pid, pendingUiRequests: [], isSettled: true, hasPendingAsyncWork: false, queuedMessageCount: 0 });

    expect(await second.request({ type: "shutdown_host" })).toMatchObject({ success: true });
    await second.exited;
    expect(JSON.parse(await fs.readFile(`${options.socketPath}.exit.json`, "utf8"))).toMatchObject({
      pid: child.pid, ownerPid: initial.adapterOwnerPid, sessionId: initial.sessionId,
      code: 0, signal: null, persisted: true, observationsFlushed: true,
    });
    await waitForFixtureProcessExit([child.pid, initial.adapterOwnerPid]);
    expect((await fs.stat(options.sessionFile)).size).toBeGreaterThan(0);
    const entries = parseSessionEntries(await fs.readFile(options.sessionFile, "utf8"));
    expect(entries[0]).toMatchObject({ type: "session", id: initial.sessionId });
    const header = entries.find(entry => entry.type === "session");
    expect(await fs.realpath(header!.cwd)).toBe(await fs.realpath(cwd));
    const records = entries.filter(entry => entry.type === "custom" && entry.customType === RECORD_TYPE)
      .map(entry => (entry as { data: FixtureRecord }).data);
    expect(records.map(record => record.phase)).toEqual(["checkpoint", "answer", "checkpoint", formPhase, "shutdown"]);
    expect(records.filter(record => record.phase === "answer")).toEqual([expect.objectContaining({ confirmed: true, token: "original-approval-token" })]);
    expect(records.every(record => record.sessionId === initial.sessionId && record.pid === child.pid && record.networkAttempts === 0)).toBe(true);
    expect(records.filter(record => record.phase !== "shutdown").every(record => record.agentStarts === 0)).toBe(true);
    expect(records.find(record => record.phase === "shutdown")!.agentStarts).toBeGreaterThan(0);
    const decisionResults = entries.filter(entry => entry.type === "message" && entry.message.role === "toolResult"
      && entry.message.toolName === "decision_ask").map(entry => entry.type === "message" ? entry.message : undefined);
    expect(decisionResults).toHaveLength(2);
    expect(decisionResults.map(message => message?.role === "toolResult" ? message.details : undefined))
      .toEqual(decisionProof.map(proof => (proof.result as { details: unknown }).details));
    const completion = entries.find(entry => entry.type === "custom_message" && entry.customType === "launch-completion");
    expect(completion?.type).toBe("custom_message");
    const daemon = completion?.type === "custom_message"
      ? (completion.details as { daemons: Record<string, unknown>[] }).daemons[0]! : {};
    expect(serviceCompletionRecorded(daemon, entries)).toBe(true);
    expect(serviceCompletionRecorded({ ...daemon, generation: crypto.randomUUID() }, entries)).toBe(false);
    const serviceRecords = entries.flatMap(entry => entry.type === "custom"
      && entry.customType === "superagent_service_generation" ? [entry.data as HostFrame] : []);
    expect(serviceRecords.filter(record => record.toolCallId === "native-service-denied")).toEqual([
      expect.objectContaining({ phase: "attempt", owner: initial.sessionId, name: "sa-host-proof" }),
      expect.objectContaining({ phase: "result", owner: initial.sessionId, name: "sa-host-proof", notLaunched: "approval_denied" }),
    ]);
    expect(serviceRecords.some(record => record.toolCallId === "native-service-blank" || record.name === "sa-host-foreign")).toBe(false);
    await expect(fs.lstat(options.socketPath)).rejects.toMatchObject({ code: "ENOENT" });

    const legacyFile = path.join(root, "legacy.jsonl");
    const legacy = SessionManager.create(cwd, root);
    try {
      await legacy.setSessionFile(legacyFile);
      await legacy.ensureOnDisk();
      legacy.appendCustomEntry("superagent_service_tracking", { rootSessionId: legacy.getSessionId(), known: false });
      legacy.flushSync();
    } finally { await legacy.close(); }
    await expect(startHost({ ...options, sessionFile: legacyFile, socketPath: path.join(root, "legacy.sock"),
      env: { ...options.env, OMP_DAEMON_DIR: path.join(root, "empty-daemon") } }))
      .rejects.toThrow("Native owned work or durable observations cannot be authoritatively established; residency remains held");
    succeeded = true;
  } catch (cause) {
    const tail = await fs.readFile(options.logPath, "utf8").then(text => text.slice(-16_384), () => "<native log unavailable>");
    throw new Error(`${cause instanceof Error ? cause.message : String(cause)}\nNative artifacts retained: ${root}\nNative log tail:\n${tail}`, { cause });
  } finally {
    try { for (const connection of connections) await connection.close(); }
    finally {
      if (await stopHostFixtures(root) !== 3 && succeeded)
        throw new Error(`Expected main, foreign and rejected legacy Host identities; retained ${root}`);
    }
    if (succeeded) await fs.rm(root, { recursive: true, force: true });
  }
}, 90_000);
