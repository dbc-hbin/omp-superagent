#!/usr/bin/env bun
import { resolve } from "node:path";
import { managedUlwStatus, updateManagedUlw, type ManagedUlwOptions } from "../src/managed-ulw";

const options: ManagedUlwOptions = {};
let statusOnly = false;
for (let index = 2; index < process.argv.length; index++) {
  const arg = process.argv[index];
  if (arg === "--status") statusOnly = true;
  else if (arg === "--manifest" || arg === "--root") {
    const value = process.argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a path`);
    if (arg === "--manifest") options.manifestPath = resolve(value);
    else options.root = resolve(value);
  } else throw new Error(`Unknown argument: ${arg}`);
}
const status = statusOnly ? managedUlwStatus(options) : await updateManagedUlw(options);
console.log(JSON.stringify(status, null, 2));
