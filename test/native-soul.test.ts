import { expect, test } from "bun:test";
import { realpath } from "node:fs/promises";
import { runNativeGatewayProof } from "./fixtures/native-gateway-subprocess";

const nativeSoulTest = process.env.OMP_SUPERAGENT_NATIVE_TEST === "1" && process.env.OMP_TEST_ULW_EXTENSION ? test : test.skip;

nativeSoulTest("stock OMP SOUL: owner updates change only the shared HEAD and direct topic reply voice",
  () => runNativeGatewayProof({
    name: "ULW",
    script: "native-gateway.ts",
    scenarioEnv: async () => {
      const entrypoint = process.env.OMP_TEST_ULW_EXTENSION;
      if (!entrypoint) throw new Error("Native SOUL proof requires the actual Superkit entrypoint");
      return { OMP_NATIVE_GATEWAY_PRESETS: "soul", OMP_TEST_ULW_EXTENSION: await realpath(entrypoint) };
    },
    assertStdout: stdout => expect(stdout).toContain("NATIVE_SOUL_GATEWAY_PROOF "),
    assertHostCount: (count, root) => {
      if (count !== 3) throw new Error(`Expected two sequential HEAD Hosts and one resident lane Host; retained ${root}`);
    },
  }), 270_000);
