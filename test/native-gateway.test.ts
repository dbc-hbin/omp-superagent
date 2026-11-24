import { test } from "bun:test";
import { runNativeGatewayProof } from "./fixtures/native-gateway-subprocess";

const nativeTest = process.env.OMP_SUPERAGENT_NATIVE_TEST === "1" ? test : test.skip;

const scenarios = ["create", "valid", "failed", "skipped", "interrupted", "recovery", "chat-observations"] as const;
for (const scenario of scenarios) {
  const chatObservations = scenario === "chat-observations";
  const testName = chatObservations
    ? "ordinary owner chat runs native presence, PR/CI and lane observation tools on the original routes"
    : `production Gateway native preset startup (${scenario}) preserves setup state, queued input and actual head ownership`;
  nativeTest(testName, () => runNativeGatewayProof({
    name: "Gateway",
    script: chatObservations ? "native-chat-observation.ts" : "native-gateway.ts",
    scenarioEnv: () => chatObservations ? {
      ...(process.env.OMP_TEST_NATIVES_DIR ? { OMP_TEST_NATIVES_DIR: process.env.OMP_TEST_NATIVES_DIR } : {}),
      ...(process.env.CARGO_TARGET_DIR ? { CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR } : {}),
    } : { OMP_NATIVE_GATEWAY_PRESETS: scenario },
    assertHostCount: (count, root) => {
      if (count === 0) throw new Error(`Missing native Gateway Host identity; retained ${root}`);
    },
  }), 270_000);
}
