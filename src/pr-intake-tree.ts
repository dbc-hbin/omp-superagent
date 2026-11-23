import { createHash } from "node:crypto";
import { Type, type Static } from "@sinclair/typebox/type";
import { PrReadError } from "./pr-github-schema";
import type { openIntakeGitHubSession } from "./pr-intake-github";

type Session = Awaited<ReturnType<typeof openIntakeGitHubSession>>;
const sha = Type.String({ pattern: "^[0-9a-f]{40}$" });
const entry = Type.Object({ mode: Type.String(), type: Type.String(), sha, path: Type.String() });
const commit = Type.Object({ sha, tree: Type.Object({ sha }) });
const tree = Type.Object({ sha, truncated: Type.Literal(false), tree: Type.Array(entry) });
const blob = Type.Object({
  sha, size: Type.Integer({ minimum: 0 }), encoding: Type.Literal("base64"), content: Type.String(),
});
type Entry = Static<typeof entry>;
export type RegularBlob = { readonly sha: string; readonly mode: "100644" | "100755" };

/** Only commit/tree IDs (never contributor paths) are passed to GitHub Git Data API endpoints. */
export async function openIntakeTree(session: Session, head: string) {
  const [root] = await session.get(`${session.root}/git/commits/${head}`, Type.Tuple([commit]));
  if (root.sha !== head) throw new PrReadError("response");
  const cache = new Map<string, Promise<ReadonlyMap<string, Entry>>>();
  const readTree = async (oid: string): Promise<ReadonlyMap<string, Entry>> => {
    const [result] = await session.get(`${session.root}/git/trees/${oid}`, Type.Tuple([tree]));
    const entries = new Map(result.tree.map(item => [item.path, item]));
    if (result.sha !== oid || entries.size !== result.tree.length) throw new PrReadError("response");
    return entries;
  };
  return async (path: string): Promise<RegularBlob | null> => {
    const parts = path.split("/");
    if (parts.length > 12 || parts.some(part => !part || part === "." || part === ".." || /[\x00-\x1f\x7f]/.test(part)))
      throw new PrReadError("response");
    let oid = root.tree.sha;
    for (const [index, part] of parts.entries()) {
      let contents = cache.get(oid);
      if (!contents) {
        contents = readTree(oid);
        cache.set(oid, contents);
      }
      const item = (await contents).get(part);
      if (!item) return null;
      if (index === parts.length - 1) {
        if (item.type !== "blob" || (item.mode !== "100644" && item.mode !== "100755"))
          throw new PrReadError("response");
        return { sha: item.sha, mode: item.mode };
      }
      if (item.type !== "tree" || item.mode !== "040000") throw new PrReadError("response");
      oid = item.sha;
    }
    throw new PrReadError("response");
  };
}

export async function readIntakeBlob(session: Session, oid: string, maxBytes: number): Promise<string> {
  const [result] = await session.get(`${session.root}/git/blobs/${oid}`, Type.Tuple([blob]));
  if (result.sha !== oid || result.size > maxBytes) throw new PrReadError("response");
  const encoded = result.content.replace(/\n/g, "");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length !== result.size || bytes.toString("base64") !== encoded
    || createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== oid)
    throw new PrReadError("response");
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (text.includes("\0")) throw new PrReadError("response");
    return text;
  } catch (error) {
    if (error instanceof TypeError) throw new PrReadError("response");
    throw error;
  }
}
