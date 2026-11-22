import { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog/effort";
import { AUTO_THINKING } from "@oh-my-pi/pi-tui/thinking";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { WorkerPolicy } from "./worker-wire";

export class WorkerRefusal extends Error {}

const strict = { additionalProperties: false } as const;
const end = "(?![\\s\\S])";
const text = Type.String({ minLength: 1, maxLength: 4096, pattern: `^[^\\u0000-\\u001f\\u007f]+${end}` });
const absolute = Type.String({ maxLength: 4096, pattern: `^/[^\\u0000-\\u001f\\u007f]*${end}` });
const id = Type.String({ minLength: 1, maxLength: 128, pattern: `^[a-zA-Z0-9][a-zA-Z0-9_-]*${end}` });
const repoId = Type.String({ pattern: `^[0-9a-f]{64}${end}` });
const generation = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const workspaceFields = {
  repoId,
  revision: Type.String({ pattern: `^(?:[0-9a-f]{40}|[0-9a-f]{64})${end}` }),
  subdir: Type.String({ maxLength: 2048, pattern: `^[^\\\\\\u0000-\\u001f\\u007f]*${end}` }),
};
const workspace = Type.Object(workspaceFields, strict);
const laneRefSchema = Type.Object({
  ...workspaceFields, generation,
  laneId: Type.String({ pattern: `^lane-[A-Za-z0-9_-]{1,48}${end}` }),
}, strict);
const role = Type.String({ pattern: `^[a-zA-Z][a-zA-Z0-9_-]{0,127}${end}` });
const launch = Type.Object({
  model: Type.Optional(Type.String({ maxLength: 1024, pattern: `^[a-zA-Z0-9][a-zA-Z0-9_.-]*/[^\\s\\u0000-\\u001f\\u007f]+${end}` })),
  modelPreset: Type.Optional(Type.Object({
    name: role,
    preset: Type.Object({
      modelRoles: Type.Record(role, text, { ...strict, maxProperties: 128 }),
      defaultThinkingLevel: Type.Optional(Type.Union(
        [AUTO_THINKING, ...THINKING_EFFORTS].map(level => Type.Literal(level)),
      )),
    }, strict),
  }, strict)),
  subagentConcurrency: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
}, strict);
const envelope = { version: Type.Literal(1) };
const bound = { ...envelope, workerId: id, ref: laneRefSchema };
const request = Type.Union([
  Type.Object({ ...envelope, op: Type.Literal("describe"), workspace: Type.Optional(workspace) }, strict),
  Type.Object({ ...bound, op: Type.Literal("probe"), reconcile: Type.Optional(Type.Literal(true)) }, strict),
  Type.Object({ ...bound, op: Type.Literal("open"), launch }, strict),
  Type.Object({ ...bound, op: Type.Literal("attach") }, strict),
]);
const policySchema = Type.Object({
  workerId: id, stateDir: absolute,
  repos: Type.Array(Type.Object({ id: repoId, cwd: absolute }, strict), { minItems: 1, maxItems: 128 }),
  capacity: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  command: Type.Array(text, { minItems: 1, maxItems: 64 }),
}, strict);

export function parseWorkerRequest(line: Buffer): Static<typeof request> {
  let payload: unknown;
  try { payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)); }
  catch { throw new WorkerRefusal("Invalid worker request JSON"); }
  if (!Value.Check(request, payload)) throw new WorkerRefusal("Invalid worker request");
  if ((payload.op === "open" || payload.op === "attach" || payload.op === "probe" && payload.reconcile) && payload.ref.generation === 0)
    throw new WorkerRefusal("Invalid worker generation");
  const subdir = payload.op === "describe" ? payload.workspace?.subdir : payload.ref.subdir;
  if (subdir && subdir.split("/").some(part => part === "" || part === "." || part === ".." || part.toLowerCase() === ".git"))
    throw new WorkerRefusal("Invalid worker subdirectory");
  return payload;
}

export function parseWorkerPolicy(value: unknown): WorkerPolicy {
  if (!Value.Check(policySchema, value) || !value.command[0]?.startsWith("/"))
    throw new WorkerRefusal("Invalid worker policy");
  if (new Set(value.repos.map(repo => repo.id)).size !== value.repos.length)
    throw new WorkerRefusal("Worker policy has duplicate repository identities");
  return value;
}
