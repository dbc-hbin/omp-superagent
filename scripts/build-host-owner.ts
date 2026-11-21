#!/usr/bin/env bun
import { constants } from "node:fs";
import { access, chmod, copyFile, cp, mkdir, mkdtempDisposable, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const nativePackages = [
  { directory: "host-owner", binary: "omp-host-owner" },
  { directory: "gateway", binary: "omp-gateway" },
] as const;
const platform = `${process.platform}-${process.arch}`;

class NativeBuildError extends Error {
  override readonly name = "NativeBuildError";
}

async function capture(command: string[]): Promise<string> {
  const child = Bun.spawn(command, { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "inherit" });
  const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (code !== 0) throw new NativeBuildError(`Command failed (${code}): ${command.join(" ")}`);
  return output;
}

interface PackageToolchain {
  readonly cargo: string;
  readonly target: string;
  readonly sysroot: string;
}

const noticeName = /^(licen[cs]e|copyright|copying|notice|unlicense)([._-]|$)/i;

const upstreamNoticeFiles: ReadonlyMap<string, readonly string[]> = new Map([
  ["Snazzah/davey", ["LICENSE"]],
  ["openmls/openmls", ["LICENSE"]],
  ["cryspen/libcrux", ["LICENSE", "LICENSE-MIT"]],
  ["hacspec/hax", ["LICENSE"]],
  ["rusticata/asn1-rs", ["LICENSE-APACHE", "LICENSE-MIT"]],
  ["sancane/precis", ["LICENSE"]],
  ["webrtc-rs/webrtc", ["LICENSE-APACHE", "LICENSE-MIT"]],
  ["qnighy/yasna.rs", ["LICENSE-APACHE", "LICENSE-MIT"]],
]);
// These published PRECIS revisions also generate tables from bundled UCD data.
const precisUnicodeVersions: ReadonlyMap<string, string> = new Map([
  ["precis-core-0.1.11", "6.3.0"],
  ["precis-profiles-0.1.13", "17.0.0"],
]);
// Their recorded revisions are unavailable upstream. Both archives offer MIT;
// the released sibling precis-tools preserves the workspace's MIT text.
const precisNoticeRevision = "5e9fb2b1a33246bceb3edb1018fb20fcd46dc316";
const unicodeTextUrl = "https://raw.githubusercontent.com/unicode-org/unicodetools/ecd26be2e82be37609090942c14e518e57e905d8/LICENSE";
const mplTextUrl = "https://www.mozilla.org/media/MPL/2.0/index.48a3fe23ed13.txt";

function licenseRevision(metadata: unknown): string {
  if (typeof metadata === "object" && metadata !== null && "git" in metadata &&
      typeof metadata.git === "object" && metadata.git !== null &&
      "sha1" in metadata.git && typeof metadata.git.sha1 === "string" && /^[0-9a-f]{40}$/.test(metadata.git.sha1)) {
    return metadata.git.sha1;
  }
  throw new NativeBuildError("Cargo VCS metadata did not record a full Git revision");
}

async function stageNotices(directory: string, manifest: string, { cargo, target, sysroot }: PackageToolchain): Promise<void> {
  // Use the exact locked, target-filtered dependency graph, including proc macros.
  const metadata: unknown = JSON.parse(await capture([
    cargo, "metadata", "--locked", "--manifest-path", manifest, "--format-version", "1", "--filter-platform", target,
  ]));
  if (typeof metadata !== "object" || metadata === null || !("packages" in metadata) ||
      !Array.isArray(metadata.packages)) {
    throw new NativeBuildError("Cargo metadata did not include packages");
  }
  const index: string[] = [];
  const sources: string[] = [];
  const upstreamTexts = new Map<string, string>();
  for (const entry of metadata.packages) {
    const crate: unknown = entry;
    if (typeof crate !== "object" || crate === null ||
        !("name" in crate) || typeof crate.name !== "string" ||
        !("version" in crate) || typeof crate.version !== "string" ||
        !("manifest_path" in crate) || typeof crate.manifest_path !== "string") {
      throw new NativeBuildError("Cargo metadata returned a package without a name, version or manifest path");
    }
    if (crate.manifest_path === manifest) continue;
    const identifier = `${crate.name}-${crate.version}`;
    const crateDir = dirname(crate.manifest_path);
    const destination = join(directory, "crates", identifier);
    const entries = await readdir(crateDir, { recursive: true, withFileTypes: true });
    const files = new Set(entries
      .filter(file => file.isFile() && (noticeName.test(file.name) || basename(file.parentPath) === "LICENSES"))
      .map(file => join(file.parentPath, file.name)));
    if ("license_file" in crate && typeof crate.license_file === "string") {
      files.add(resolve(crateDir, crate.license_file));
    }
    await mkdir(destination, { recursive: true });
    for (const file of files) {
      const path = join(destination, relative(crateDir, file));
      await mkdir(dirname(path), { recursive: true });
      await copyFile(file, path);
    }
    if (crate.name === "libsqlite3-sys" && target.includes("-linux-")) {
      const amalgamation = await Bun.file(join(crateDir, "sqlite3", "sqlite3.c")).slice(0, 4096).text();
      const dedication = /^\*\* The author disclaims copyright[\s\S]*?(?=\n\*{6,})/m.exec(amalgamation)?.[0];
      if (!dedication) throw new NativeBuildError(`Missing SQLite public-domain notice in ${identifier}`);
      await Bun.write(join(destination, "SQLITE-PUBLIC-DOMAIN.txt"), `${dedication.trimEnd()}\n`);
    }
    const license = "license" in crate && typeof crate.license === "string" ? crate.license : null;
    if (!files.size) {
      // Some workspace packages omit their repository-level license from the
      // published crate. Pin the license source to a commit, never a branch.
      const repository = "repository" in crate && typeof crate.repository === "string"
        ? /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)(?:\/|$)/.exec(crate.repository)?.[1]?.replace(/\.git$/, "")
        : undefined;
      const upstreamFiles = repository ? upstreamNoticeFiles.get(repository) : undefined;
      const notices: { readonly file: string; readonly url: string }[] = [];
      if (repository && upstreamFiles) {
        const unicodeVersion = repository === "sancane/precis" ? precisUnicodeVersions.get(identifier) : undefined;
        const revision = unicodeVersion
          ? precisNoticeRevision
          : licenseRevision(await Bun.file(join(crateDir, ".cargo_vcs_info.json")).json());
        for (const file of upstreamFiles) {
          notices.push({ file, url: `https://raw.githubusercontent.com/${repository}/${revision}/${file}` });
        }
        if (unicodeVersion) {
          notices.push(
            { file: "LICENSE-UNICODE", url: unicodeTextUrl },
            { file: "NOTICE-UNICODE.txt", url: `https://www.unicode.org/Public/${unicodeVersion}/ucd/ReadMe.txt` },
          );
        }
      } else if (repository === "cryspen/hpke-rs" && license === "MPL-2.0") {
        // hpke-rs declares MPL-2.0 but its repository has no license file.
        notices.push({ file: "LICENSE-MPL-2.0", url: mplTextUrl });
      } else {
        throw new NativeBuildError(`No license or notice file found for ${identifier}`);
      }
      for (const { file, url } of notices) {
        let text = upstreamTexts.get(url);
        if (text === undefined) {
          text = await capture(["curl", "--fail", "--silent", "--show-error", "--location", "--max-time", "60", url]);
          if (!text.trim()) throw new NativeBuildError(`Empty upstream license: ${url}`);
          upstreamTexts.set(url, text);
        }
        await Bun.write(join(destination, file), text);
        sources.push(`${identifier} (${file}): ${url}`);
      }
    }
    if ("source" in crate && crate.source === "registry+https://github.com/rust-lang/crates.io-index") {
      sources.push(`${identifier}: https://static.crates.io/crates/${crate.name}/${identifier}.crate`);
    }
    index.push(`${identifier}: ${license ?? "see license files"}`);
  }

  const rustDocs = join(sysroot, "share", "doc", "rust");
  const rustNotices = join(directory, "rust");
  await mkdir(rustNotices, { recursive: true });
  // The rustup rust-docs component includes the std, compiler runtime and
  // bundled musl notices, including the license texts linked from this report.
  await copyFile(join(rustDocs, "COPYRIGHT-library.html"), join(rustNotices, "COPYRIGHT-library.html"));
  await cp(join(rustDocs, "licenses"), join(rustNotices, "licenses"), { recursive: true });
  await Bun.write(join(directory, "Cargo-LICENSES.txt"), `${index.sort().join("\n")}\n`);
  await Bun.write(join(directory, "Cargo-SOURCES.txt"), `${sources.sort().join("\n")}\n`);
}

const flags = process.argv.slice(2);
const isPackage = flags.includes("--package");
const isInstall = flags.includes("--install");
if (flags.some(flag => flag !== "--owner" && flag !== "--package" && flag !== "--install") ||
    new Set(flags).size !== flags.length || (isPackage && isInstall)) {
  throw new NativeBuildError("Usage: bun run build:native [--package|--install] (or build:owner for just the Host owner)");
}
if ((process.platform !== "darwin" && process.platform !== "linux") ||
    (process.arch !== "x64" && process.arch !== "arm64")) {
  throw new NativeBuildError(`Superagent native executables are not supported on ${platform}`);
}

const packages = (flags.includes("--owner") ? nativePackages.slice(0, 1) : nativePackages).map(pkg => {
  const dir = join(root, pkg.directory);
  return {
    ...pkg,
    manifest: join(dir, "Cargo.toml"),
    // Build scripts may cache link-search paths between invocations. Release
    // builds must not reuse artifacts from the developer's normal environment.
    targetDir: isPackage ? join(dir, "target", "package") : join(dir, "target"),
    binDir: join(dir, "bin"),
    executable: `${pkg.binary}-${platform}`,
  };
});
const manifests = await Promise.all(packages.map(pkg => Bun.file(pkg.manifest).exists()));
if (isInstall && manifests.every(exists => !exists)) {
  // Official npm tarballs omit Rust sources. Do not require Cargo there.
  for (const pkg of packages) {
    try {
      await access(join(pkg.binDir, pkg.executable), constants.X_OK);
    } catch (cause) {
      throw new NativeBuildError(`This package lacks runnable ${pkg.executable}; install an official package or build from source`, { cause });
    }
  }
} else {
  if (!manifests.every(Boolean)) throw new NativeBuildError("This checkout lacks the required native Cargo manifest(s)");
  const cargo = Bun.which("cargo");
  const rustc = Bun.which("rustc");
  if (!cargo || !rustc) {
    throw new NativeBuildError("Building Superagent from source requires Rust and Cargo on PATH; official npm packages are prebuilt");
  }
  const host = /^host: (\S+)$/m.exec(await capture([rustc, "-vV"]))?.[1];
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  const hostPrefix = process.platform === "darwin" ? `${arch}-apple-darwin` : `${arch}-unknown-linux-`;
  if (!host?.startsWith(hostPrefix)) {
    throw new NativeBuildError(`Rust host target ${host ?? "(unknown)"} does not match Bun platform ${platform}`);
  }
  const staticLinux = isPackage && process.platform === "linux";
  const target = staticLinux ? `${arch}-unknown-linux-musl` : host;
  const sysroot = isPackage ? (await capture([rustc, "--print", "sysroot"])).trim() : undefined;
  // Use the musl driver for both C and final linking: bundled Opus needs musl's libm.
  const musl = staticLinux ? Bun.which("musl-gcc") : undefined;
  if (staticLinux && !musl) throw new NativeBuildError("Packaging on Linux requires musl-gcc (Ubuntu: musl-tools)");
  const cargoTarget = target.replaceAll("-", "_");
  for (const pkg of packages) {
    const isGateway = pkg.directory === "gateway";
    const gatewayMac = isGateway && process.platform === "darwin";
    const cmake = isGateway ? Bun.which("cmake") : undefined;
    if (isGateway && !cmake) throw new NativeBuildError("Building omp-gateway requires CMake for bundled Opus");
    // macOS uses Apple's SQLite, not a Homebrew or pkg-config installation.
    const sqliteSdkLibDir = gatewayMac
      ? join((await capture(["/usr/bin/xcrun", "--sdk", "macosx", "--show-sdk-path"])).trim(), "usr", "lib")
      : undefined;
    if (sqliteSdkLibDir) await access(join(sqliteSdkLibDir, "libsqlite3.tbd"));
    const child = Bun.spawn([
      cargo, "build", "--release", "--locked", "--manifest-path", pkg.manifest, "--bin", pkg.binary,
      "--target-dir", pkg.targetDir, "--target", target,
    ], {
      cwd: root,
      env: {
        ...process.env,
        // The checkout's Cargo config disables pkg-config and forces dylib on macOS.
        ...(sqliteSdkLibDir && { SQLITE3_LIB_DIR: sqliteSdkLibDir }),
        // libopus_sys adds Homebrew's lib directory even in bundled mode.
        // Use the selected Rust/CMake binaries but keep brew out of this build.
        ...(gatewayMac && isPackage && cmake && { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", RUSTC: rustc, CMAKE: cmake }),
        ...(musl && { [`CC_${cargoTarget}`]: musl, [`CARGO_TARGET_${cargoTarget.toUpperCase()}_LINKER`]: musl }),
      },
      stdin: "ignore", stdout: "inherit", stderr: "inherit",
    });
    const code = await child.exited;
    if (code !== 0) throw new NativeBuildError(`Locked ${pkg.binary} build for ${target} failed (${code})`);

    // Do not overwrite a mapped executable in place (ETXTBSY on Linux).
    await using stage = await mkdtempDisposable(join(pkg.targetDir, ".install-"));
    const staged = join(stage.path, pkg.executable);
    await copyFile(join(pkg.targetDir, target, "release", pkg.binary), staged);
    await chmod(staged, 0o755);
    const noticesDir = join(pkg.binDir, "notices");
    const notices = join(noticesDir, platform);
    if (sysroot !== undefined) {
      const stagedNotices = join(stage.path, "notices");
      await stageNotices(stagedNotices, pkg.manifest, { cargo, target, sysroot });
      await mkdir(noticesDir, { recursive: true });
      await rm(notices, { recursive: true, force: true });
      await rename(stagedNotices, notices);
    } else {
      // A developer build must not retain notices from an earlier release build.
      await rm(notices, { recursive: true, force: true });
    }
    await mkdir(pkg.binDir, { recursive: true });
    await rename(staged, join(pkg.binDir, pkg.executable));
    console.log(`Staged ${pkg.directory}/bin/${pkg.executable}`);
  }
}
