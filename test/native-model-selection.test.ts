import { test } from "bun:test";
import { nativeRuntime } from "./fixtures/model-native-runtime";

const nativeTest = process.env.OMP_SUPERAGENT_NATIVE_TEST === "1" ? test : test.skip;

nativeTest("native judge, lane presets, messenger controls, explicit global defaults, real compaction and abort preserve session scope and settings across resume",
  () => nativeRuntime(true), 180_000);
