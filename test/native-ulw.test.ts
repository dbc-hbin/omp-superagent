import { expect, test } from "bun:test";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { runNativeGatewayProof } from "./fixtures/native-gateway-subprocess";

// Both native execution and this exact external package are explicit opt-ins.
// Never silently substitute a mock Superkit extension or a developer checkout path.
const nativeUlwTest = process.env.OMP_SUPERAGENT_NATIVE_TEST === "1" && process.env.OMP_TEST_ULW_EXTENSION ? test : test.skip;

nativeUlwTest("actual Superkit activates SUPER in the native Gateway head and explicitly selected lanes without granting data authority",
  () => runNativeGatewayProof({
    name: "ULW",
    script: "native-gateway.ts",
    scenarioEnv: async () => {
      const entrypoint = process.env.OMP_TEST_ULW_EXTENSION;
      if (entrypoint === undefined) throw new Error("Native ULW proof requires OMP_TEST_ULW_EXTENSION");
      return { OMP_TEST_ULW_EXTENSION: await realpath(resolve(entrypoint)) };
    },
    assertStdout: stdout => expect(stdout).toContain("NATIVE_ULW_GATEWAY_PROOF "),
    assertHostCount: (count, root) => {
      if (count !== 2) throw new Error(`Expected head and lane Host identities; retained ${root}`);
    },
  }), 270_000);
