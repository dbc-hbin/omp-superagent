import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { findSessionFiles } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { publishNativeSession } from "../../src/native-sessions";

const root = process.argv[2]!;
const cwd = path.join(root, "workspace");
const original = path.join(root, "existing-lane", "session.jsonl");
await fs.mkdir(cwd, { recursive: true });
const session = SessionManager.create(cwd, path.dirname(original));
await session.setSessionFile(original);
session.appendMessage({ role: "user", content: "Existing lane evidence", timestamp: Date.now() });
await session.ensureOnDisk();
const artifact = await session.saveArtifact("Original nested evidence");
assert(artifact);
const id = session.getSessionId();
await session.close();
const before = await fs.readFile(original);

await assert.rejects(() => publishNativeSession(original, cwd, "another-lane"), /different managed session identity/);
const entry = await publishNativeSession(original, cwd);
assert(entry);
assert.equal(path.dirname(entry), SessionManager.getDefaultSessionDir(cwd));
assert.equal(await fs.realpath(entry), original);
assert.equal(await publishNativeSession(original, cwd), entry);
assert.deepEqual(await fs.readFile(original), before);
assert((await fs.lstat(entry)).isSymbolicLink());
assert.equal(await fs.realpath(entry.slice(0, -".jsonl".length)), original.slice(0, -".jsonl".length));

const local = await SessionManager.listForPicker(cwd);
assert((await local.complete).some(row => row.id === id && row.path === entry));
const all = await SessionManager.listAllForPicker();
assert((await all.complete).some(row => row.id === id && row.path === entry));
assert.deepEqual(await findSessionFiles(id), [entry]);

// Ordinary native resume may read artifacts and rewrite the same journal.
const resumed = await SessionManager.open(entry);
assert.equal(resumed.getSessionId(), id);
assert.equal(await fs.readFile((await resumed.getArtifactPath(artifact))!, "utf8"), "Original nested evidence");
resumed.appendMessage({ role: "user", content: "Intentional operator continuation", timestamp: Date.now() });
await resumed.setSessionName("Operator resumed this lane");
await resumed.ensureOnDisk();
await resumed.close();
assert((await fs.lstat(entry)).isSymbolicLink(), "Native rewrites must preserve the original journal link");
assert.match(await fs.readFile(original, "utf8"), /Intentional operator continuation/);
assert.match(await fs.readFile(original, "utf8"), /Operator resumed this lane/);

assert.equal(await publishNativeSession(path.join(root, "uncreated", "session.jsonl"), cwd), undefined);
await fs.unlink(entry);
await fs.writeFile(entry, "Unrelated operator file");
await assert.rejects(() => publishNativeSession(original, cwd), /already belongs to another file/);
assert.equal(await fs.readFile(entry, "utf8"), "Unrelated operator file");
console.log("NATIVE_SESSION_DISCOVERY_PROOF");
