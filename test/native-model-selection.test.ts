import { test } from "bun:test";
import { nativeRuntime } from "./fixtures/model-native-runtime";

const nativeTest = process.env.OMP_SUPERAGENT_NATIVE_TEST === "1" ? test : test.skip;

nativeTest("native judge advice stays advisory while native preset snapshots, resume, and explicit lane changes preserve OMP settings",
  () => nativeRuntime(true), 180_000);
