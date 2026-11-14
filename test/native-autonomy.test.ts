import { test } from "bun:test";
import { nativeAutonomyRuntime } from "./fixtures/autonomy-native-runtime";

const nativeTest = process.env.OMP_SUPERAGENT_NATIVE_TEST === "1" ? test : test.skip;

nativeTest("managed native goals continue real work across turns, stop while paused, and resume on the original topic without idle model calls",
  nativeAutonomyRuntime, 120_000);
