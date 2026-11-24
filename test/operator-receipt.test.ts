import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { invokeOperator, OperatorStartError, runOperator } from "../src/operator";
import { waitForFixtureProcessExit } from "./fixtures/host-fixture-processes";
import { operatorExample } from "./fixtures/operator";

const credentials = { bot: "not-a-real-operator-credential" };

test("distinguishes operator launch refusal from a lost receipt without exposing native diagnostics", async () => {
  const refused = invokeOperator(["/nonexistent/omp-superagent-test/operator"], {}, credentials);
  await expect(refused).rejects.toThrow("no mutation was attempted");

  const error = await invokeOperator([process.execPath, "--no-env-file", "-e", `
    console.error(process.env.OMP_SA_OPERATOR_BOT);
    console.log("invalid receipt " + process.env.OMP_SA_OPERATOR_BOT);
    process.exit(1);
  `], {}, credentials).then(() => "", (err: Error) => err.message);
  expect(error).toContain("may have reached the platform");
  expect(error).not.toContain(credentials.bot);
});

test("an abort during native binary lookup is a pre-spawn refusal", async () => {
  const abort = new AbortController();
  const operation = runOperator("unused-no-network-operation", {}, credentials, abort.signal);
  abort.abort(new Error("custom abort reason"));
  await expect(operation).rejects.toBeInstanceOf(OperatorStartError);
});

async function within<T>(pending: Promise<T>, label: string): Promise<T> {
  const { promise, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 4_000);
  try { return await Promise.race([pending, promise]); }
  finally { clearTimeout(timer); }
}

test.each(["SIGTERM", "SIGKILL"] as const)(
  "killing only the CLI with %s closes the native write without attempting later scopes", async signal => {
    const example = await operatorExample();
    const firstWrite = Promise.withResolvers<void>();
    const writeClosed = Promise.withResolvers<void>();
    const calls: string[] = [];
    const server = createServer((request, response) => {
      const method = request.url?.split("/").at(-1) ?? "";
      calls.push(method);
      let body = "";
      request.setEncoding("utf8").on("data", chunk => { body += chunk; });
      request.on("end", () => {
        let result: unknown;
        switch (method) {
          case "getMe": result = { id: 76, is_bot: true }; break;
          case "getChat": result = body.includes('"-100"') ? { id: -100, type: "supergroup" } : { id: 42, type: "private" }; break;
          case "getChatMember": result = { user: { id: 42, is_bot: false }, status: "member" }; break;
          case "getMyCommands": result = []; break;
          case "setMyCommands":
            response.once("close", () => writeClosed.resolve());
            firstWrite.resolve();
            return; // Do not acknowledge the first write, so its outcome remains uncertain.
          default: response.writeHead(404).end(); return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, result }));
      });
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject).listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No operator fixture address");
    const child = Bun.spawn([process.execPath, "--no-env-file", "-e", `
      import { invokeOperator } from ${JSON.stringify(fileURLToPath(new URL("../src/operator.ts", import.meta.url)))};
      await invokeOperator(${JSON.stringify([example, String(address.port), "telegram-commands"])},
        { apply: true, ownerId: "42", allowedChatIds: ["-100"] }, ${JSON.stringify(credentials)});
    `], { stdin: "ignore", stdout: "ignore", stderr: "inherit" });
    try {
      await within(firstWrite.promise, "first native write");
      const operator = `${example} ${address.port} telegram-commands`;
      const processes = execFileSync("/bin/ps", ["-ww", "-ax", "-o", "pid=", "-o", "ppid=", "-o", "args="],
        { encoding: "utf8" });
      const native = processes.split("\n").map(line => /^(\d+)\s+(\d+)\s+(.+)$/.exec(line.trim()))
        .find(fields => Number(fields?.[2]) === child.pid && fields?.[3] === operator);
      if (!native) throw new Error("The pending loopback request did not come from the CLI's native operator");
      child.kill(signal); // Only the Bun process, not the Rust PID or its process group.
      await within(child.exited, "CLI termination");
      await within(writeClosed.promise, "orphaned native HTTP connection to close");
      await waitForFixtureProcessExit([Number(native[1])]);
      expect(calls).toEqual(["getMe", "getChat", "getChat", "getChatMember", "getMyCommands", "getMyCommands", "setMyCommands"]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await child.exited;
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  },
  30_000,
);
