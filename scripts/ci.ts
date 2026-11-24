#!/usr/bin/env bun
import { mkdtempDisposable } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { activeManagedUlw } from "../src/managed-ulw";
import { nativeTestCommand } from "../test/fixtures/native-command";

const root = resolve(import.meta.dir, "..");
const explicitCache = process.env.OMP_TEST_NATIVES_DIR;
await using temporaryCache = explicitCache ? undefined : await mkdtempDisposable(join(tmpdir(), "omp-sa-natives-"));
const nativesDir = explicitCache || temporaryCache!.path;
const command = await nativeTestCommand({ ...process.env, OMP_TEST_NATIVES_DIR: nativesDir });
const ulw = activeManagedUlw();
const manifest = await Bun.file(join(ulw, "package.json")).json() as { omp: { extensions: string[] } };
if (manifest.omp.extensions.length !== 1) throw new Error("Native composition tests require one managed ULW entrypoint");
const env = {
  ...process.env,
  CI: "true",
  PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter),
  OMP_SUPERAGENT_NATIVE_TEST: "1",
  OMP_SUPERAGENT_SETUP_PTY_TEST: "1",
  OMP_SUPERAGENT_GATEWAY_DIFFERENTIAL: "1",
  OMP_TEST_COMMAND: JSON.stringify(command),
  OMP_TEST_NATIVES_DIR: nativesDir,
  OMP_TEST_ULW_EXTENSION: resolve(ulw, manifest.omp.extensions[0]!),
};
console.log(`CI: Bun ${Bun.version}; ULW ${ulw}`);
const bun = [process.execPath, "--no-env-file"];
const commands = [
  [...bun, "run", "check"],
  ["cargo", "test", "--locked", "--manifest-path", "host-owner/Cargo.toml"],
  // Cargo's default test targets build the Gateway examples used by the Bun fixtures.
  ["cargo", "test", "--locked", "--manifest-path", "gateway/Cargo.toml"],
  [...bun, "test", "--parallel=2", "test"],
];
for (const command of commands) {
  const child = Bun.spawn(command, {
    cwd: root,
    env,
    stdin: "ignore", stdout: "inherit", stderr: "inherit",
  });
  const code = await child.exited;
  if (code !== 0) { process.exitCode = code; break; }
}
