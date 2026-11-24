import { resolve } from "node:path";
import { invokeOperator, type OperatorRun } from "../../src/operator";

let executable: Promise<string> | undefined;
export function operatorExample(): Promise<string> {
  return executable ??= (async () => {
    const build = await Bun.$`cargo build --locked --manifest-path gateway/Cargo.toml --example operator-loopback --message-format=json-render-diagnostics`
      .cwd(resolve(import.meta.dir, "../..")).quiet();
    for (const line of build.text().trim().split("\n")) {
      const artifact = JSON.parse(line);
      if (artifact.reason === "compiler-artifact" && artifact.target.name === "operator-loopback"
        && artifact.target.kind.includes("example") && typeof artifact.executable === "string") return artifact.executable;
    }
    throw new Error("Cargo did not report the operator-loopback example executable");
  })();
}

export function loopbackOperator(fetch: (request: Request) => Response | Promise<Response>): OperatorRun {
  return async (operation, request, credentials, signal) => {
    let failure: Error | undefined;
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(request) {
        try { return await fetch(request); }
        catch (error) {
          failure = error instanceof Error ? error : new Error("Operator fixture assertion failed");
          return new Response(null, { status: 500 });
        }
      },
    });
    try {
      return await invokeOperator([await operatorExample(), String(server.port), operation],
        request, credentials, signal);
    } finally {
      await server.stop(true);
      if (failure) throw failure;
    }
  };
}
