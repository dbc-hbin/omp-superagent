import { test } from "bun:test";
import { nativeRuntime } from "./fixtures/model-native-runtime";

const nativeTest = process.env.OMP_SUPERAGENT_NATIVE_TEST === "1" ? test : test.skip;

nativeTest("production runtime settles actual OMP replies once and keeps independent thread sessions isolated",
  () => nativeRuntime(), 180_000);
