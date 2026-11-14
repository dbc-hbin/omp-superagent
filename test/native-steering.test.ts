import { test } from "bun:test";
import { nativeSteeringRuntime } from "./fixtures/steering-native-runtime";

const nativeTest = process.env.OMP_SUPERAGENT_NATIVE_TEST === "1" ? test : test.skip;

nativeTest("real native tool-boundary steering coalesces same-route input, isolates topics and explicit lanes, survives controller restart and withdraws stopped steers",
  nativeSteeringRuntime, 180_000);
