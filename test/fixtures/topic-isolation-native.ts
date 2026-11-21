/** Inspect actual OMP journals and the fixture's isolated Mnemopi bank. */
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { parseSessionEntries } from "@oh-my-pi/pi-coding-agent";
import { HostConnection } from "../../src/host";
import type { Head } from "./native-rust-gateway";
import { nativeRequestEnvelope } from "./native-request-envelope";

export type TopicJournal = {
  readonly sessionId: string;
  readonly cwd: string;
  readonly prompts: readonly {
    readonly entryId: string; readonly requestId: string | null;
    readonly sourceId: string | null; readonly route: string | null;
    readonly previous?: { readonly sessionId: string; readonly evidence: string };
  }[];
  readonly replies: readonly string[];
  readonly results: readonly {
    readonly id: string; readonly status: string; readonly sessionId: string; readonly sessionFile: string;
  }[];
};

export type TopicCheckpoint = {
  readonly identity: Head;
  readonly isSettled: boolean;
  readonly contextPercent: number | null;
};

export type TopicMemorySeed = {
  readonly pid: number; readonly sessionId: string; readonly database: string; readonly id: string;
};

export type TopicRecallWitness = {
  readonly content: string; readonly recallCount: number; readonly lastRecalled: string | null;
};

if (import.meta.main) {
  const [mode, file] = process.argv.slice(2);
  const root = process.env.OMP_TEST_HOST_FIXTURE_ROOT;
  assert(root && root === process.cwd() && process.env.HOME === join(root, "home")
    && process.env.PI_CODING_AGENT_DIR === join(root, "agent") && file?.startsWith(`${root}/`),
    "The topic proof uses only its private profile");
  switch (mode) {
    case "checkpoint": {
      const { connection, identity } = await HostConnection.open(file);
      try {
        const state = await connection.client.getState();
        console.log(JSON.stringify({ identity, isSettled: state.isSettled,
          contextPercent: state.contextUsage?.percent ?? null } satisfies TopicCheckpoint));
      } finally { await connection.close(); }
      break;
    }
    case "seed-memory": {
      assert.equal(file, join(root, "run", "main.sock"));
      const { connection, identity } = await HostConnection.open(file);
      const commandId = "native-topic-isolation-seed";
      const completed = Promise.withResolvers<void>();
      const stop = connection.onFrame(frame => {
        if (frame.type !== "prompt_result" || frame.id !== commandId) return;
        if (frame.status === "completed" && frame.agentInvoked === false && frame.sessionSettled === true) {
          completed.resolve();
        } else {
          completed.reject(new Error(`Native memory seed was not a settled local command: ${JSON.stringify(frame)}`));
        }
      });
      const timer = setTimeout(() => completed.reject(new Error("Native memory seed did not settle")), 20_000);
      try {
        // Attach the rejection handler before the stock command can emit its result.
        await Promise.all([
          connection.request({ type: "prompt", message: "/fixture-seed-topic-memory" }, commandId).then(reply => {
            assert(reply.success && reply.command === "prompt", JSON.stringify(reply));
            assert.notEqual(reply.data?.agentInvoked, true);
            if (reply.data?.agentInvoked === false) completed.resolve();
          }),
          completed.promise,
        ]);
        const seed: TopicMemorySeed = JSON.parse(await readFile(join(root, "topic-memory-seed.json"), "utf8"));
        assert.equal(seed.pid, identity.pid);
        assert.equal(seed.sessionId, identity.sessionId);
        assert((await connection.client.getState()).isSettled);
        console.log(JSON.stringify(seed));
      } finally {
        clearTimeout(timer);
        stop();
        await connection.close();
      }
      break;
    }
    case "recall-witness": {
      assert.equal(file, join(root, "topic-memory-seed.json"));
      const { database, id }: TopicMemorySeed = JSON.parse(await readFile(file, "utf8"));
      assert(database.startsWith(`${join(root, "agent", "topic-memory", "banks")}/`)
        && await realpath(database) === database && id);
      // Reading the exact saved row has no recall side effect. Stock Mnemopi
      // increments recall_count only when the row is among the recalled hits.
      using db = new Database(database, { readonly: true, strict: true });
      const witness = db.query<TopicRecallWitness, [string]>(`SELECT content,
        recall_count AS recallCount, last_recalled AS lastRecalled FROM working_memory WHERE id=?`).get(id);
      assert(witness, "The acknowledged stock Mnemopi save has no native row");
      console.log(JSON.stringify(witness));
      break;
    }
    case "journal": {
      const entries = parseSessionEntries(await readFile(file, "utf8"));
      const header = entries.find(entry => entry.type === "session");
      assert(header, `Missing stock OMP session header: ${file}`);
      const prompts: Array<TopicJournal["prompts"][number]> = [];
      const replies: string[] = [];
      const results: Array<TopicJournal["results"][number]> = [];
      for (const entry of entries) {
        if (entry.type === "message") {
          const message = entry.message;
          if (message.role !== "user" && message.role !== "assistant") continue;
          const text = typeof message.content === "string" ? message.content
            : message.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
          if (message.role === "assistant") {
            replies.push(text);
          } else {
            const request = nativeRequestEnvelope(text);
            const historical = request && /^Previous task evidence .+\n(\{.+\})$/m.exec(request.envelope);
            prompts.push({ entryId: entry.id, requestId: request?.requestId ?? null, sourceId: request?.sourceId ?? null,
              route: request ? /^Original authorized conversation: (.+)$/m.exec(request.envelope)?.[1] ?? null : null,
              ...(historical ? { previous: JSON.parse(historical[1]!) } : {}) });
          }
        } else if (entry.type === "custom" && entry.customType === "rpc_prompt_result") {
          const data: unknown = entry.data;
          assert(data && typeof data === "object" && "frame" in data && "sessionId" in data
            && typeof data.sessionId === "string" && "sessionFile" in data && typeof data.sessionFile === "string");
          const frame = data.frame;
          assert(frame && typeof frame === "object" && "id" in frame && typeof frame.id === "string"
            && "status" in frame && typeof frame.status === "string");
          results.push({ id: frame.id, status: frame.status, sessionId: data.sessionId, sessionFile: data.sessionFile });
        }
      }
      console.log(JSON.stringify({ sessionId: header.id, cwd: header.cwd, prompts, replies, results } satisfies TopicJournal));
      break;
    }
    default: assert.fail(`Unknown topic proof SDK operation: ${mode}`);
  }
}
