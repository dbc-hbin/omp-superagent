// Rust replay (after staging the production owner): rust-anything app replay test/rust-anything
// Original replay: rust-anything app replay test/rust-anything --build
//   'bun --no-env-file --no-install ./owner-probe.ts original /absolute/path/to/original-checkout'
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { existsSync, watch } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { requireHostOwner } from "../../src/host-owner-path";
import { HostChannel, type Response } from "../../src/host-protocol";

const bun = process.execPath;
const [, , target, ...args] = process.argv;
let ownerCommand: string[];
let mode: string | undefined;
if (target === "original") {
  const [checkout, variant] = args;
  assert.ok(checkout && isAbsolute(checkout), "use an absolute path to the original checkout");
  ownerCommand = [bun, "--no-env-file", "--no-install", join(checkout, "src", "host-owner.ts")];
  mode = variant;
} else {
  assert.equal(target, "rust", "select rust or original");
  ownerCommand = [await requireHostOwner()];
  [mode] = args;
}
assert.ok(mode === "clean" || mode === "child-nonzero", "unknown fixture mode");
const root = await mkdtemp(join(await realpath(tmpdir()), "ora-"));
const helperPath = join(import.meta.dir, "../../src/host-sdk-helper.ts");
const home = join(root, "home");
const agent = join(root, "agent");
const socketPath = join(root, "h.sock");
const sessionFile = join(root, "session.jsonl");
const manifest = join(root, "owner.json");
const stock = join(root, "stock");
const configPath = join(root, "config.json");
const activation = join(root, "activation");
const sessionId = "4c73d767-0a25-4c61-9341-f89bb272e76e";
const header = { type: "session", version: 3, id: sessionId, timestamp: "2024-01-01T00:00:00.000Z", cwd: root };
const env = {
  PATH: "/usr/bin:/bin", HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agent, TMPDIR: root,
  FIXTURE_ROOT: root, FIXTURE_SESSION: sessionFile, FIXTURE_MODE: mode,
  OMP_SUPERAGENT_MANAGED_ULW_PATH: join(import.meta.dir, "../fixtures/managed-ulw"),
  OMP_SUPERAGENT_BUN: bun, FIXTURE_STOCK_PEER: join(import.meta.dir, "stock-peer.ts"),
};
const privateFile = { mode: 0o600, flag: "wx" };
const peers = new Set<HostChannel>();
let owner: Bun.Subprocess<"ignore", "inherit", "inherit"> | undefined;

// Use the real SDK HostChannel for the original client's framing and correlation.
async function attach(label: string) {
  const socket = createConnection(socketPath);
  const peer = new HostChannel(socket, socket, true);
  peers.add(peer);
  let ready: unknown;
  peer.on("frame", frame => { if (frame.type === "ready") ready = frame; });
  await peer.ready.promise;
  const call = (type: string, fields: Record<string, unknown> = {}) => peer.request(
    { type, ...fields }, `${label}:${type}:${++sequence}`, 5_000);
  let sequence = 0;
  return { peer, ready, call };
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), "not a protocol record");
  return Object.fromEntries(Object.entries(value));
}

// Member ordering in JSON objects is not a wire contract. Arrays and every value stay intact.
function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, field]) => [key, ordered(field)]));
  return value;
}

try {
  await mkdir(home, { mode: 0o700 });
  await mkdir(agent, { mode: 0o700 });
  await Promise.all([
    writeFile(stock, "#!/bin/sh\nexec \"$OMP_SUPERAGENT_BUN\" --no-env-file --no-install \"$FIXTURE_STOCK_PEER\" \"$@\"\n", { ...privateFile, mode: 0o700 }),
    writeFile(configPath, "{}\n", privateFile),
    writeFile(sessionFile, `${JSON.stringify(header)}\n`, privateFile),
    writeFile(manifest, JSON.stringify({
      options: { cwd: root, sessionFile, socketPath, command: [stock], logPath: join(root, "owner.log"), subagentConcurrency: 1,
        managedUlwPath: env.OMP_SUPERAGENT_MANAGED_ULW_PATH },
      args: ["--mode", "rpc-ui", "--session", sessionFile, "--cwd", root, "--config", configPath, "--no-tools"],
      nativeSocket: join(root, "n.sock"), configPath, processBackend: "broker",
      helperPath, toolsExplicitlySelected: false, noTools: true,
    }), privateFile),
  ]);
  const appeared = Promise.withResolvers<void>();
  const watcher = watch(root, () => { if (existsSync(activation)) appeared.resolve(); });
  const startupLimit = setTimeout(() => appeared.reject(new Error("fixture activation timed out")), 12_000);
  try {
    if (existsSync(activation)) appeared.resolve();
    owner = Bun.spawn([...ownerCommand, manifest],
      { cwd: root, env, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
    await Promise.race([appeared.promise, owner.exited.then(code => assert.fail(`owner exited before activation: ${code}`))]);
  } finally {
    watcher.close();
    clearTimeout(startupLimit);
  }
  const activated = record(JSON.parse(await readFile(activation, "utf8")));
  const { nativePid, instanceKey } = activated;
  const ownerPid = owner.pid;
  assert.ok(typeof nativePid === "number" && Number.isSafeInteger(nativePid) && nativePid > 1 && nativePid !== ownerPid,
    "invalid native PID");
  assert.match(typeof instanceKey === "string" ? instanceKey : "", /^[0-9a-f-]{36}$/, "invalid native instance key");

  // Only substitute random values after comparison with the actual spawned
  // owner and the independently reported peer. A wrong/missing identity fails.
  function state(frame: Response) {
    const data = record(frame.data);
    assert.equal(data.hostPid, nativePid, "state must reference the actual native process");
    assert.equal(data.adapterOwnerPid, ownerPid, "state must reference the actual owner process");
    assert.equal(data.sessionFile, sessionFile, "state must reference the supplied journal");
    assert.equal(data.instanceKey, instanceKey, "state must reference the actual native instance");
    const { loadedSuperkitPath, ...originalFields } = data;
    // Check the additive receipt independently of the historical protocol transcript.
    assert.equal(loadedSuperkitPath, env.OMP_SUPERAGENT_MANAGED_ULW_PATH);
    return { ...frame, data: { ...originalFields, hostPid: "$native", adapterOwnerPid: "$owner",
      sessionFile: "$session-file", instanceKey: "$instance" } };
  }

  const first = await attach("first");
  const unsupported = await first.call("negotiate_protocol", { protocolVersion: 91 });
  const negotiated = await first.call("negotiate_protocol", { protocolVersion: 2 });
  if (negotiated.success) first.peer.encoder.setProtocolVersion(2);
  const initial = state(await first.call("get_state"));
  const socketBefore = await lstat(socketPath);
  const setBusy = await first.call("fixture_set_busy", { busy: true });
  const busy = state(await first.call("get_state"));
  const refused = await first.call("shutdown_host");
  first.peer.destroy();
  await first.peer.exited;
  peers.delete(first.peer);

  const second = await attach("second");
  const renegotiated = await second.call("negotiate_protocol", { protocolVersion: 2 });
  if (renegotiated.success) second.peer.encoder.setProtocolVersion(2);
  const reattached = state(await second.call("get_state"));
  const socketAfter = await lstat(socketPath);
  assert.equal(socketBefore.ino, socketAfter.ino, "reattached endpoint must be the same inode");
  const setIdle = await second.call("fixture_set_busy", { busy: false });
  const idle = state(await second.call("get_state"));
  const admission = await second.call("get_host_admission");
  const arrived = Promise.withResolvers<Record<string, unknown>>();
  second.peer.on("frame", frame => { if (frame.type === "fixture_large") arrived.resolve(frame); });
  const expiry = setTimeout(() => arrived.reject(new Error("v2 event did not arrive")), 5_000);
  const [big, contents] = await Promise.all([second.call("get_fixture_large"), arrived.promise])
    .finally(() => clearTimeout(expiry));
  assert.equal(typeof contents.unicode, "string", "expected the negotiated v2 payload");
  if (typeof contents.unicode !== "string") assert.fail("missing v2 payload");
  const large = { ...contents, unicode: {
    bytes: Buffer.byteLength(contents.unicode),
    sha256: createHash("sha256").update(contents.unicode).digest("hex"),
  } };
  const shutdown = await second.call("shutdown_host");
  const exitCode = await owner.exited;
  await second.peer.exited;
  const receipt = record(JSON.parse(await readFile(`${socketPath}.exit.json`, "utf8")));
  assert.equal(receipt.pid, nativePid, "receipt must reference the child that supplied native state");
  assert.equal(receipt.ownerPid, ownerPid, "receipt must reference the owner that served both attachments");
  assert.equal(receipt.sessionFile, sessionFile, "receipt must reference the supplied journal");
  assert.equal(await readFile(sessionFile, "utf8"), `${JSON.stringify(header)}\n`, "fixture journal was modified");
  const transcript = {
    first: { ready: first.ready, unsupported, negotiated, initial, setBusy, busy, refused },
    second: { ready: second.ready, renegotiated, reattached, setIdle, idle, admission, big, large, shutdown },
    socket: { mode: socketBefore.mode & 0o777, reattachedMode: socketAfter.mode & 0o777 },
    terminal: { exitCode, signal: owner.signalCode,
      receipt: { ...receipt, pid: "$native", ownerPid: "$owner", sessionFile: "$session-file" } },
  };
  console.log(JSON.stringify(ordered(transcript), null, 2));
  process.exitCode = exitCode;
} finally {
  for (const peer of peers) peer.destroy();
  if (owner) {
    if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL");
    await owner.exited;
  }
  await rm(root, { recursive: true, force: true });
}
