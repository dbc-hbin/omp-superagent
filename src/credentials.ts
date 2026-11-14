import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync,
  renameSync, unlinkSync, writeFileSync, type Stats,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { parseEnv } from "node:util";
import { credentialEnvNames, type Config } from "./config";

export interface CredentialFile {
  path: string;
  values: Record<string, string>;
  /** Kept private in memory, never included in diagnostics. */
  bytes: Buffer;
  stat: Stats;
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function privateFile(stat: Stats): void {
  if (!stat.isFile() || (stat.mode & 0o177) !== 0 ||
      (process.getuid && stat.uid !== process.getuid()))
    throw new Error("Credential file must be an owned, non-symlink private file (mode 0600)");
}

function decode(bytes: Buffer): string {
  const value = bytes.toString("utf8");
  if (!Buffer.from(value, "utf8").equals(bytes) || value.includes("\0"))
    throw new Error("Credential file must contain valid UTF-8 without NUL bytes");
  return value;
}

function parseCredentialValues(text: string): Record<string, string> {
  const values: Record<string, string> = Object.create(null);
  for (const [name, value] of Object.entries(parseEnv(text))) {
    if (typeof value !== "string") throw new Error("Credential file is not valid dotenv");
    values[name] = value;
  }
  return values;
}

/** This is deliberately not dotenv autoloading: callers opt in for start/doctor only. */
export function readCredentialFile(configPath: string): CredentialFile | undefined {
  const path = `${configPath}.env`;
  let fd: number;
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error("Credential file must not be a symlink");
    privateFile(stat);
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (missing(error)) return undefined;
    if (error instanceof Error && error.message.startsWith("Credential file")) throw error;
    throw new Error("Cannot safely open credential file");
  }
  try {
    const stat = fstatSync(fd);
    privateFile(stat);
    const bytes = readFileSync(fd);
    const text = decode(bytes);
    let values: Record<string, string>;
    try { values = parseCredentialValues(text); }
    catch { throw new Error("Credential file is not valid dotenv"); }
    return { path, values, bytes, stat };
  } finally { closeSync(fd); }
}

export function validateCredential(value: string): void {
  if (!value || /[\r\n\0]/.test(value) || Buffer.from(value, "utf8").toString("utf8") !== value)
    throw new Error("Credential must be a nonempty, single-line UTF-8 value without NUL bytes");
  encodeValue(value);
}

function encodeValue(value: string): string {
  // parseEnv, not shell syntax, is the authority. In particular, dollar signs and
  // backslashes remain literal. Test the complete parse so quotes/comments cannot
  // inject another assignment. No interpolation or shell evaluation is used.
  const candidates = [value, `'${value}'`, `"${value}"`, `\`${value}\``];
  for (const candidate of candidates) {
    try {
      const parsed = parseEnv(`VALUE=${candidate}\n`);
      if (Object.keys(parsed).length === 1 && parsed.VALUE === value) return candidate;
    } catch { /* Try another literal delimiter, never include the value in an error. */ }
  }
  throw new Error("Credential value cannot be stored losslessly in dotenv");
}

export function serializeCredentials(values: Record<string, string>): string {
  const entries = Object.entries(values);
  const text = entries.map(([name, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error("Credential file has an invalid variable name");
    return `${name}=${encodeValue(value)}\n`;
  }).join("");
  let parsed: Record<string, string>;
  try { parsed = parseCredentialValues(text); }
  catch { throw new Error("Credential file cannot be stored losslessly in dotenv"); }
  if (Object.keys(parsed).length !== entries.length || entries.some(([name, value]) => parsed[name] !== value))
    throw new Error("Credential file cannot be stored losslessly in dotenv");
  return text;
}

export function assertCredentialsUnchanged(configPath: string, previous: CredentialFile | undefined): void {
  const current = readCredentialFile(configPath);
  if (!!current !== !!previous || (current && previous &&
      (current.stat.dev !== previous.stat.dev || current.stat.ino !== previous.stat.ino ||
       current.stat.mtimeMs !== previous.stat.mtimeMs || current.stat.ctimeMs !== previous.stat.ctimeMs ||
       !current.bytes.equals(previous.bytes))))
    throw new Error("Credential file changed during setup; nothing was overwritten");
}

/** Stage privately beside the target. Caller must recheck snapshots before commit. */
export function stagePrivateFile(path: string, contents: string): string {
  const temporary = join(dirname(path), `.setup-${randomUUID()}.tmp`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeFileSync(fd, contents, "utf8");
    fsyncSync(fd);
  } catch {
    unlinkSync(temporary);
    throw new Error("Could not stage private setup file");
  } finally { closeSync(fd); }
  return temporary;
}

export function writeCredentials(configPath: string, values: Record<string, string>, previous: CredentialFile | undefined): void {
  const path = `${configPath}.env`;
  // Serialize cooperating publishers, then recheck the caller's original snapshot.
  // Never steal an existing lock: after an interrupted writer the operator must
  // first ensure it is no longer running before explicitly removing this file.
  const lockPath = `${path}.lock`;
  let lock: number;
  try { lock = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch { throw new Error(`Credential write lock unavailable: ${lockPath}; no files were overwritten`); }
  const lockStat = fstatSync(lock);
  let temporary: string | undefined;
  try {
    fchmodSync(lock, 0o600);
    writeFileSync(lock, `${process.pid}\n`, "utf8");
    temporary = stagePrivateFile(path, serializeCredentials(values));
    assertCredentialsUnchanged(configPath, previous);
    if (previous) renameSync(temporary, path);
    // The link is a complete private publication. A crash before stage cleanup may
    // leave an extra private link, which is harmless and does not prevent reads.
    else linkSync(temporary, path);
  } finally {
    try {
      if (temporary) {
        try { unlinkSync(temporary); } catch (error) { if (!missing(error)) throw error; }
      }
    } finally {
      closeSync(lock);
      try {
        const current = lstatSync(lockPath);
        if (current.dev === lockStat.dev && current.ino === lockStat.ino) unlinkSync(lockPath);
      } catch (error) { if (!missing(error)) throw error; }
    }
  }
}

/** Nonempty explicit environment wins; unrelated dotenv keys never enter a process. */
export function loadCredentials(config: Config): void {
  const file = readCredentialFile(config.path);
  if (!file) return;
  for (const name of credentialEnvNames(config)) {
    if (process.env[name]) continue;
    const value = Object.hasOwn(file.values, name) ? file.values[name] : undefined;
    if (value) { validateCredential(value); process.env[name] = value; }
  }
}
