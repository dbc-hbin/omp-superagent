import { randomBytes } from "node:crypto";
import { USER_SSHD_BINARY, USER_SSHD_DIRECTORY } from "./worker-user-sshd";

/**
 * Bounded POSIX shell scripts that `omp-sa worker add` runs on the worker over
 * an ordinary, tty-less SSH login. Every script prints facts as
 * `@@<nonce> <key> <value>` lines (anything else the account's shell prints is
 * ignored), checks the current state on the worker itself before writing, and
 * copies any file it replaces to `<file>.bak-<timestamp>` first.
 */

export const REMOTE_RELEASES = ".local/share/omp-superagent-worker/releases";
export const REMOTE_WRAPPER = ".local/bin/omp-sa-worker";
export const REMOTE_WORKER_JSON = ".config/omp-superagent/worker.json";
export const REMOTE_STATE_DIR = ".local/state/omp-superagent-worker";
export const PATH_MARKER = "omp-superagent worker PATH";
/** The startup file a non-interactive SSH command of each login shell reads, where the guarded PATH block goes. */
export const PATH_FILES: Readonly<Record<string, string>> = { bash: ".bashrc", zsh: ".zshenv" };

export const sq = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

export const newNonce = (): string => randomBytes(12).toString("hex");

export function parseFacts(stdout: string, nonce: string): Record<string, string> {
  const facts: Record<string, string> = {};
  const prefix = `@@${nonce} `;
  for (const line of stdout.split("\n")) {
    if (!line.startsWith(prefix)) continue;
    const rest = line.slice(prefix.length).replace(/\r$/, "");
    const space = rest.indexOf(" ");
    const key = space === -1 ? rest : rest.slice(0, space);
    const value = space === -1 ? "" : rest.slice(space + 1);
    // Repeated logs accumulate; everything else keeps its last value.
    facts[key] = key === "log" && facts[key] !== undefined ? `${facts[key]}\n${value}` : value;
  }
  return facts;
}

const prelude = (nonce: string) => `
umask 077
NONCE=${nonce}
emit() { printf '@@%s %s %s\\n' "$NONCE" "$1" "$2"; }
TS="$(date -u +%Y%m%dT%H%M%SZ).$$"
HOME_REAL="$(cd "$HOME" 2>/dev/null && pwd -P)"
DIRECT=0; [ "\${OMP_SUPERAGENT_TEST_WORKER_CONTEXT:-}" = direct ] && DIRECT=1
b64() { base64 < "$1" | tr -d '\\n'; }
backup() { [ -e "$1" ] && cp -p "$1" "$1.bak-$TS"; }
# Replace through a rename; write through a symlinked dotfile instead of replacing the link.
replace_file() { if [ -L "$2" ]; then cat "$1" > "$2" && rm -f "$1"; else mv -f "$1" "$2"; fi; }
# Atomically point symlink $2 at $1 (GNU mv -T, BSD mv -h).
swap_link() { l="$2.tmp.$$"; rm -f "$l"; ln -s "$1" "$l" && { mv -T "$l" "$2" 2>/dev/null || mv -fh "$l" "$2"; }; }
`;

/** Run $2 (a script file) with the account's login-shell environment; ambient environment in test fixtures. */
const loginRunner = `
run_login() {
  if [ "$DIRECT" = 1 ]; then sh "$1" </dev/null; return; fi
  T=""; command -v timeout >/dev/null 2>&1 && T="timeout $2"
  $T "\${SHELL:-/bin/sh}" -l -i -c "exec sh $1" </dev/null 2>/dev/null
}
`;

/** Directory safety the worker applies to its provisioning/state ancestry (see loadWorkerProvision). */
const dirChecks = `
unsafe_dir() {
  d="$1"
  [ -d "$d" ] && [ ! -L "$d" ] || { echo "$d is not a directory (or is a symlink)"; return 0; }
  [ -O "$d" ] || [ -n "$(find "$d" -maxdepth 0 -user root 2>/dev/null)" ] || { echo "$d is owned by another account"; return 0; }
  if [ -n "$(find "$d" -maxdepth 0 \\( -perm -020 -o -perm -002 \\) 2>/dev/null)" ] && [ -z "$(find "$d" -maxdepth 0 -perm -1000 2>/dev/null)" ]; then
    echo "$d is group- or other-writable"; return 0
  fi
  return 1
}
ancestry_problem() {
  d="$1"
  while :; do
    p="$(unsafe_dir "$d")" && { printf '%s' "$p"; return 0; }
    [ "$d" = / ] && return 1
    d="$(dirname "$d")"
  done
}
`;

export interface PreflightParams {
  nonce: string;
  roots: readonly string[];
  releaseId: string;
  /** Public-key blob (`ssh-ed25519 AAAA...` without comment) to look for in authorized_keys. */
  authorizedKey: string | null;
}

/** Read-only inspection: platform, account, user manager, login environment tools, roots and existing install state. */
export function preflightScript(params: PreflightParams): string {
  const rootsList = params.roots.map(sq).join(" ");
  const state = `$HOME_REAL/${REMOTE_RELEASES}`;
  return `${prelude(params.nonce)}${loginRunner}
emit direct "$DIRECT"
emit uname_s "$(uname -s)"
emit uname_m "$(uname -m)"
emit user "$(id -un)"
emit uid "$(id -u)"
emit home "$HOME"
emit home_real "$HOME_REAL"
LOGIN_SHELL="$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f7)"
[ -n "$LOGIN_SHELL" ] || LOGIN_SHELL="\${SHELL:-}"
[ -n "$LOGIN_SHELL" ] || LOGIN_SHELL="$(dscl . -read "/Users/$(id -un)" UserShell 2>/dev/null | awk '{ print $2 }')"
emit login_shell "$LOGIN_SHELL"
if [ "$DIRECT" = 0 ] && [ "$(uname -s)" = Darwin ]; then
  # The GUI login session's launchd domain, and Command Line Tools by their directory (running cc could raise the install dialog).
  emit gui_domain "$(/bin/launchctl print "gui/$(id -u)" >/dev/null 2>&1 && echo yes || echo no)"
  # Command Line Tools keep cc in usr/bin; a selected Xcode keeps it in its default toolchain.
  DEV="$(xcode-select -p 2>/dev/null)"
  if [ -n "$DEV" ] && { [ -x "$DEV/usr/bin/cc" ] || [ -x "$DEV/Toolchains/XcodeDefault.xctoolchain/usr/bin/cc" ]; }; then emit developer_tools yes; fi
elif [ "$DIRECT" = 0 ]; then
  emit user_manager "$(systemctl --user is-system-running 2>/dev/null | head -n1)"
  emit linger "$(loginctl show-user "$(id -u)" -p Linger --value 2>/dev/null | head -n1)"
fi
i=0
for root in ${rootsList}; do
  if [ ! -e "$root" ]; then emit "root.$i" "!missing"
  elif [ ! -d "$root" ]; then emit "root.$i" "!notdir"
  else emit "root.$i" "$(cd "$root" && pwd -P)"; fi
  i=$((i + 1))
done
[ -f "$HOME_REAL/${REMOTE_WORKER_JSON}" ] && emit worker_json "$(b64 "$HOME_REAL/${REMOTE_WORKER_JSON}")"
[ -f "$HOME_REAL/${REMOTE_WRAPPER}" ] && emit wrapper "$(b64 "$HOME_REAL/${REMOTE_WRAPPER}")"
for rc in ${Object.values(PATH_FILES).join(" ")}; do
  [ -f "$HOME_REAL/$rc" ] && grep -q ${sq(PATH_MARKER)} "$HOME_REAL/$rc" && emit "path_marker$rc" yes
done
${params.authorizedKey === null ? "" : `if [ -f "$HOME_REAL/.ssh/authorized_keys" ]; then
  emit authorized_keys "$(grep -F ${sq(params.authorizedKey)} "$HOME_REAL/.ssh/authorized_keys" | head -n1 | tr '\\t' ' ')"
else emit authorized_keys_file none; fi`}
# A user-level worker sshd (macOS without admin rights) has its own host key; prefer it when present.
HOST_KEY=/etc/ssh/ssh_host_ed25519_key.pub; [ -r "$HOME_REAL/.omp-sa-sshd/ssh_host_ed25519_key.pub" ] && HOST_KEY="$HOME_REAL/.omp-sa-sshd/ssh_host_ed25519_key.pub"
[ "$DIRECT" = 1 ] && HOST_KEY="$HOME_REAL/.omp-sa-test-ssh_host_ed25519_key.pub"
[ -r "$HOST_KEY" ] && emit host_key "$(head -n1 "$HOST_KEY" | cut -d' ' -f1,2)"
CUR="$(readlink "${state}/current" 2>/dev/null)"; emit release_current "$(basename "$CUR" 2>/dev/null)"
REL=${sq(params.releaseId)}
[ -d "${state}/$REL" ] && emit release_present yes
TMPD="$(mktemp -d "\${TMPDIR:-/tmp}/omp-sa-setup.XXXXXX")"; trap 'rm -rf "$TMPD"' EXIT
cat > "$TMPD/inner.sh" <<'OMP_SA_INNER'
emit() { printf '@@%s %s %s\\n' "$NONCE" "$1" "$2"; }
emit path "$PATH"
omp_path="$(command -v omp 2>/dev/null)"; emit omp_path "$omp_path"
[ -n "$omp_path" ] && emit omp_version "$(omp --version </dev/null 2>/dev/null | head -n1)"
bun_path="$(command -v bun 2>/dev/null)"; emit bun_path "$bun_path"
[ -n "$bun_path" ] && emit bun_version "$(bun --version </dev/null 2>/dev/null | head -n1)"
emit git_version "$(git --version </dev/null 2>/dev/null | head -n1)"
if [ -n "$omp_path" ] && [ -n "$bun_path" ]; then
  T=""; command -v timeout >/dev/null 2>&1 && T="timeout 60"
  emit models_chat "$($T omp models --json </dev/null 2>/dev/null | bun --no-env-file -e 'const j = JSON.parse(await Bun.stdin.text()); console.log((j.models ?? []).filter(m => m.kind === "chat" && typeof m.selector === "string").length)' 2>/dev/null)"
fi
if [ -n "$bun_path" ] && [ -d "$STATE/$REL" ]; then
  emit release_package "$(cd "$STATE/$REL" && bun --no-env-file -e 'import { workerPackage } from "./src/remote-worker-wire.ts"; console.log(JSON.stringify(workerPackage()))' </dev/null 2>/dev/null | tail -n1)"
fi
OMP_SA_INNER
export NONCE STATE="${state}" REL
run_login "$TMPD/inner.sh" 90
`;
}

export interface InstallParams {
  nonce: string;
  releaseId: string;
  version: string;
  digest: string;
  tarSha256: string;
  /** bun.lock shipped: install exactly it; otherwise dependency ranges resolve. */
  frozen: boolean;
}

/** `sh -c` argument: the tar stream arrives on stdin. Extracts, installs, verifies, then atomically switches `current`. */
export function installScript(params: InstallParams): string {
  const releases = `$HOME_REAL/${REMOTE_RELEASES}`;
  return `${prelude(params.nonce)}${loginRunner}
TMPD="$(mktemp -d "\${TMPDIR:-/tmp}/omp-sa-setup.XXXXXX")"; trap 'rm -rf "$TMPD"' EXIT
cat > "$TMPD/release.tar"
SUM="$( (sha256sum "$TMPD/release.tar" 2>/dev/null || shasum -a 256 "$TMPD/release.tar") | cut -d' ' -f1)"
if [ "$SUM" != ${sq(params.tarSha256)} ]; then emit error "release archive was corrupted in transit"; exit 3; fi
cat > "$TMPD/inner.sh" <<'OMP_SA_INNER'
emit() { printf '@@%s %s %s\\n' "$NONCE" "$1" "$2"; }
swap_link() { l="$2.tmp.$$"; rm -f "$l"; ln -s "$1" "$l" && { mv -T "$l" "$2" 2>/dev/null || mv -fh "$l" "$2"; }; }
fail() { emit error "$1"; [ -f "$TMPD/install.log" ] && tail -n 15 "$TMPD/install.log" | while IFS= read -r l; do emit log "$l"; done; exit 3; }
verify() {
  P="$(cd "$1" && bun --no-env-file -e 'import { workerPackage } from "./src/remote-worker-wire.ts"; console.log(JSON.stringify(workerPackage()))' </dev/null 2>/dev/null | tail -n1)"
  [ "$P" = "$EXPECT" ]
}
command -v bun >/dev/null 2>&1 || fail "bun is not available in the account's login environment"
mkdir -p "$RELEASES" || fail "cannot create $RELEASES"
FINAL="$RELEASES/$REL"
if [ -d "$FINAL" ]; then
  if verify "$FINAL"; then emit installed existing
  else mv "$FINAL" "$RELEASES/.stale-$REL-$TS" || fail "cannot move aside the unverified release"; emit moved_aside "$RELEASES/.stale-$REL-$TS"; fi
fi
if [ ! -d "$FINAL" ]; then
  STAGE="$(mktemp -d "$RELEASES/.stage-$REL.XXXXXX")" || fail "cannot create a staging directory"
  tar -xf "$TMPD/release.tar" -C "$STAGE" || { rm -rf "$STAGE"; fail "cannot extract the release archive"; }
  (cd "$STAGE" && bun install $INSTALL_FLAGS --ignore-scripts --production) >"$TMPD/install.log" 2>&1 || { rm -rf "$STAGE"; fail "bun install failed"; }
  mv "$STAGE" "$FINAL" || { rm -rf "$STAGE"; fail "cannot place the release"; }
  if ! verify "$FINAL"; then mv "$FINAL" "$RELEASES/.failed-$REL-$TS"; fail "installed package digest does not match HEAD's"; fi
  emit installed new
fi
swap_link "$REL" "$RELEASES/current" || fail "cannot switch the current release"
emit current "$REL"
OMP_SA_INNER
export NONCE TS RELEASES="${releases}" REL=${sq(params.releaseId)} TMPD
export EXPECT=${sq(JSON.stringify({ version: params.version, digest: params.digest }))}
export INSTALL_FLAGS=${sq(params.frozen ? "--frozen-lockfile" : "")}
run_login "$TMPD/inner.sh" 900
`;
}

export interface CommandParams {
  nonce: string;
  wrapper: string;
  /** Add the guarded non-interactive PATH block at the top of this home-relative startup file (see PATH_FILES). */
  pathFile: string | null;
}

/** `~/.local/bin/omp-sa-worker` and, when requested, the guarded PATH block at the top of the login shell's non-interactive startup file. */
export function commandScript(params: CommandParams): string {
  const block = `# >>> ${PATH_MARKER} (managed by omp-sa worker add)
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) PATH="$HOME/.local/bin:$PATH"; export PATH ;; esac
# <<< ${PATH_MARKER}
`;
  return `${prelude(params.nonce)}
BIN="$HOME_REAL/.local/bin"; mkdir -p "$BIN" || { emit error "cannot create $BIN"; exit 3; }
W="$BIN/omp-sa-worker"
printf '%s' ${sq(params.wrapper)} > "$BIN/.omp-sa-worker.$$" && chmod 755 "$BIN/.omp-sa-worker.$$"
if [ -f "$W" ] && cmp -s "$BIN/.omp-sa-worker.$$" "$W"; then rm -f "$BIN/.omp-sa-worker.$$"; emit wrapper unchanged
else backup "$W"; replace_file "$BIN/.omp-sa-worker.$$" "$W" && emit wrapper written; fi
${params.pathFile ? `RC="$HOME_REAL"/${sq(params.pathFile)}
if [ -f "$RC" ] && grep -q ${sq(PATH_MARKER)} "$RC"; then emit path unchanged
else
  printf '%s' ${sq(block)} > "$RC.omp-sa.$$"
  if [ -f "$RC" ]; then backup "$RC"; cat "$RC" >> "$RC.omp-sa.$$"; fi
  replace_file "$RC.omp-sa.$$" "$RC" && emit path written
fi` : ""}
`;
}

export interface WorkerJsonParams {
  nonce: string;
  /** Final file content. */
  content: string;
  stateDir: string;
}

/** worker.json (0600) in a private directory with a trusted ancestry, plus the private state directory. */
export function workerJsonScript(params: WorkerJsonParams): string {
  return `${prelude(params.nonce)}${dirChecks}
CFG_DIR="$HOME_REAL/.config/omp-superagent"
if [ -d "$HOME_REAL/.config" ] && [ ! -L "$HOME_REAL/.config" ] && [ -n "$(find "$HOME_REAL/.config" -maxdepth 0 \\( -perm -020 -o -perm -002 \\) 2>/dev/null)" ]; then
  chmod g-w,o-w "$HOME_REAL/.config" && emit fixed_config_permissions yes
fi
mkdir -p "$CFG_DIR" && chmod 700 "$CFG_DIR" || { emit error "cannot create $CFG_DIR"; exit 3; }
P="$(ancestry_problem "$CFG_DIR")" && { emit error "unsafe provisioning directory: $P"; exit 3; }
STATE=${sq(params.stateDir)}
mkdir -p "$STATE" && chmod 700 "$STATE" || { emit error "cannot create the worker state directory $STATE"; exit 3; }
P="$(ancestry_problem "$(cd "$STATE" && pwd -P)")" && { emit error "unsafe worker state directory: $P"; exit 3; }
F="$CFG_DIR/worker.json"
printf '%s' ${sq(params.content)} > "$CFG_DIR/.worker.json.$$" && chmod 600 "$CFG_DIR/.worker.json.$$"
if [ -f "$F" ] && cmp -s "$CFG_DIR/.worker.json.$$" "$F"; then rm -f "$CFG_DIR/.worker.json.$$"; emit worker_json unchanged
else backup "$F"; mv -f "$CFG_DIR/.worker.json.$$" "$F" && chmod 600 "$F" && emit worker_json written; fi
`;
}

export interface MemoryParams {
  nonce: string;
  /** Release directory name under the worker's releases directory (an id or "current"). */
  release: string;
  cwd: string;
  /** JSON consent (the exact `missing` profile reported by inspect) to apply, or null to only inspect. */
  consent: string | null;
  /** Native settings files to copy before an edit. */
  agentDir: string | null;
}

/** Runs HEAD's own managed-memory helper from the installed release in the account's login environment. */
export function memoryScript(params: MemoryParams): string {
  const backups = params.agentDir === null ? "" : `AD=${sq(params.agentDir)}
for f in config.yml config.yaml; do [ -f "$AD/$f" ] && backup "$AD/$f"; done`;
  return `${prelude(params.nonce)}${loginRunner}
TMPD="$(mktemp -d "\${TMPDIR:-/tmp}/omp-sa-setup.XXXXXX")"; trap 'rm -rf "$TMPD"' EXIT
${params.consent === null ? "" : `${backups}
printf '%s' ${sq(params.consent)} > "$TMPD/consent.json"`}
cat > "$TMPD/inner.sh" <<'OMP_SA_INNER'
emit() { printf '@@%s %s %s\\n' "$NONCE" "$1" "$2"; }
T=""; command -v timeout >/dev/null 2>&1 && T="timeout 60"
cd "$CWD" 2>/dev/null || { emit error "cannot enter $CWD"; exit 3; }
OUT="$($T bun --no-env-file --no-install "$HELPER" "$OPERATION" ${params.consent === null ? "</dev/null" : '< "$TMPD/consent.json"'} 2>/dev/null | grep '^MANAGED_MEMORY ' | tail -n1)"
emit memory "$OUT"
OMP_SA_INNER
export NONCE TMPD CWD=${sq(params.cwd)} HELPER="$HOME_REAL/${REMOTE_RELEASES}/${params.release}/src/managed-memory-helper.ts" OPERATION=${params.consent === null ? "inspect" : "apply-consented"}
run_login "$TMPD/inner.sh" 90
`;
}

export interface MacosPrepareParams {
  nonce: string;
  /** The worker's own bun (an absolute path), the executable the launcher's payload pointer names. */
  bun: string;
  /** Release directory name under the worker's releases directory. */
  release: string;
  /** JSON `{ stateDir, workspaceRoots }`: the scope whose protected paths need the owner's grants. */
  scope: string;
}

/**
 * The launcher setup that needs no GUI session and raises no privacy prompt (see prepareMacosWorker), run by the
 * installed release itself. Plain `sh` is enough: it only compiles, signs and writes files in the account's home.
 */
export function macosPrepareScript(params: MacosPrepareParams): string {
  return `${prelude(params.nonce)}
TMPD="$(mktemp -d "\${TMPDIR:-/tmp}/omp-sa-setup.XXXXXX")"; trap 'rm -rf "$TMPD"' EXIT
cd "$HOME_REAL" || { emit error "cannot enter $HOME_REAL"; exit 3; }
SETUP="$HOME_REAL/${REMOTE_RELEASES}/"${sq(params.release)}/src/worker-macos-setup.ts
[ -f "$SETUP" ] || { emit error "release is not installed: $SETUP"; exit 3; }
if OUT="$(${sq(params.bun)} --no-env-file "$SETUP" --prepare ${sq(params.scope)} </dev/null 2>"$TMPD/err")"; then emit prepare "$(printf '%s' "$OUT" | tail -n1)"
else emit error "macOS launcher setup failed: $(tail -n 3 "$TMPD/err" | tr '\n' ' ')"; exit 3; fi
`;
}

export interface AuthorizedKeyParams {
  nonce: string;
  line: string;
  /** `ssh-ed25519 AAAA...` identifying the key regardless of options or comment. */
  key: string;
}

/** Append exactly one line to authorized_keys (backup first); never edit another line. */
export function authorizedKeysScript(params: AuthorizedKeyParams): string {
  return `${prelude(params.nonce)}
SSH="$HOME_REAL/.ssh"; F="$SSH/authorized_keys"
mkdir -p "$SSH" && chmod 700 "$SSH" || { emit error "cannot create $SSH"; exit 3; }
if [ -f "$F" ] && EXISTING="$(grep -F ${sq(params.key)} "$F" | head -n1)" && [ -n "$EXISTING" ]; then
  if grep -qxF ${sq(params.line)} "$F"; then emit authorized_keys unchanged
  else emit authorized_keys different; fi
  exit 0
fi
cp -p "$F" "$F.new.$$" 2>/dev/null || { : > "$F.new.$$"; chmod 600 "$F.new.$$"; }
[ -s "$F.new.$$" ] && [ -n "$(tail -c1 "$F.new.$$")" ] && echo >> "$F.new.$$"
printf '%s\\n' ${sq(params.line)} >> "$F.new.$$"
backup "$F"
replace_file "$F.new.$$" "$F" && chmod 600 "$F" && emit authorized_keys appended
`;
}

/** Paths and the agent's launchd state, shared by the user-sshd inspection and apply scripts. */
const userSshdPaths = (label: string) => `LABEL=${sq(label)}
D="$HOME_REAL/${USER_SSHD_DIRECTORY}"; K="$D/ssh_host_ed25519_key"
PLIST="$HOME_REAL/Library/LaunchAgents/$LABEL.plist"; DOMAIN="gui/$(id -u)"
launchd_state() {
  /bin/launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || { echo absent; return; }
  S="$(/bin/launchctl print "$DOMAIN/$LABEL" 2>/dev/null | awk '$1 == "state" && $2 == "=" { print $3; exit }')"
  echo "\${S:-loaded}"
}
`;

export interface UserSshdInspectParams { nonce: string; label: string }

/** Read-only: what the worker's own sshd (see worker-user-sshd) currently consists of. */
export function userSshdInspectScript(params: UserSshdInspectParams): string {
  return `${prelude(params.nonce)}
${userSshdPaths(params.label)}
[ -x ${USER_SSHD_BINARY} ] && emit sshd_binary yes
[ -f "$D/sshd_config" ] && emit sshd_config "$(b64 "$D/sshd_config")"
[ -f "$PLIST" ] && emit sshd_plist "$(b64 "$PLIST")"
[ -f "$K" ] && [ -r "$K.pub" ] && emit host_key "$(head -n1 "$K.pub" | cut -d' ' -f1,2)"
emit launchd "$(launchd_state)"
exit 0
`;
}

export interface UserSshdApplyParams {
  nonce: string;
  label: string;
  /** Final sshd_config and LaunchAgent plist contents. */
  config: string;
  plist: string;
  port: number;
  /** The launchd action the plan chose (see planUserSshd). */
  action: "none" | "bootstrap" | "kickstart" | "reload";
}

/**
 * Creates the private directory, the host key (kept if present), the checked config and the plist (each replaced only when
 * different, previous copy kept as `.bak-*`), then loads or restarts the agent and waits for it to run and log that it listens.
 */
export function userSshdApplyScript(params: UserSshdApplyParams): string {
  return `${prelude(params.nonce)}
${userSshdPaths(params.label)}
PORT=${params.port}; ACTION=${params.action}
fail() {
  emit error "$1"
  [ -f "$D/sshd.log" ] && tail -n 6 "$D/sshd.log" | while IFS= read -r l; do emit log "$l"; done
  exit 3
}
[ -x ${USER_SSHD_BINARY} ] || fail "${USER_SSHD_BINARY} is not available"
mkdir -p "$D" "$HOME_REAL/Library/LaunchAgents" && chmod 700 "$D" || fail "cannot create $D"
if [ ! -f "$K" ]; then
  rm -f "$K.pub"
  ERR="$(ssh-keygen -q -t ed25519 -N "" -C "omp-sa worker sshd" -f "$K" 2>&1)" || fail "ssh-keygen failed: $ERR"
  emit host_key_state created
elif [ ! -r "$K.pub" ]; then
  ssh-keygen -y -f "$K" > "$K.pub.$$" && mv -f "$K.pub.$$" "$K.pub" || fail "cannot derive the public host key"
  emit host_key_state restored
else emit host_key_state kept; fi
emit host_key "$(head -n1 "$K.pub" | cut -d' ' -f1,2)"
# The new config must pass sshd's own check before it replaces the working one.
printf '%s' ${sq(params.config)} > "$D/.sshd_config.$$" && chmod 600 "$D/.sshd_config.$$"
ERR="$(${USER_SSHD_BINARY} -t -f "$D/.sshd_config.$$" 2>&1)" || { rm -f "$D/.sshd_config.$$"; fail "sshd rejected the configuration: $(printf '%s' "$ERR" | tr '\\n' ' ')"; }
if [ -f "$D/sshd_config" ] && cmp -s "$D/.sshd_config.$$" "$D/sshd_config"; then rm -f "$D/.sshd_config.$$"; emit sshd_config unchanged
else backup "$D/sshd_config"; mv -f "$D/.sshd_config.$$" "$D/sshd_config" && chmod 600 "$D/sshd_config" && emit sshd_config written; fi
printf '%s' ${sq(params.plist)} > "$PLIST.new.$$" && chmod 600 "$PLIST.new.$$"
ERR="$(plutil -lint "$PLIST.new.$$" 2>&1)" || { rm -f "$PLIST.new.$$"; fail "the LaunchAgent plist is invalid: $ERR"; }
if [ -f "$PLIST" ] && cmp -s "$PLIST.new.$$" "$PLIST"; then rm -f "$PLIST.new.$$"; emit sshd_plist unchanged
else backup "$PLIST"; mv -f "$PLIST.new.$$" "$PLIST" && emit sshd_plist written; fi
OFFSET=0; [ "$ACTION" != none ] && OFFSET="$(wc -c < "$D/sshd.log" 2>/dev/null | tr -d ' ')"
bootstrap() {
  n=0
  until ERR="$(/bin/launchctl bootstrap "$DOMAIN" "$PLIST" 2>&1)"; do
    n=$((n + 1)); [ $n -ge 5 ] && fail "launchctl bootstrap failed: $ERR"; sleep 1
  done
}
case "$ACTION" in
  bootstrap) bootstrap ;;
  kickstart) ERR="$(/bin/launchctl kickstart -k "$DOMAIN/$LABEL" 2>&1)" || fail "launchctl kickstart failed: $ERR" ;;
  reload) /bin/launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1; bootstrap ;;
esac
emit launchd_action "$ACTION"
# The agent must be running and sshd must have logged that it listens on the port (since the restart above).
i=0; LISTENING=""
while [ $i -lt 40 ]; do
  if [ "$(launchd_state)" = running ]; then
    LISTENING="$(tail -c +$(( \${OFFSET:-0} + 1 )) "$D/sshd.log" 2>/dev/null | grep -E "Server listening on .* port $PORT(\\.|$)" | sed 's/^.*Server listening on //' | tr '\\n' ' ')"
    [ -n "$LISTENING" ] && break
  fi
  i=$((i + 1)); sleep 1
done
[ -n "$LISTENING" ] || fail "the agent $LABEL is $(launchd_state) and its sshd has not logged that it listens on port $PORT"
emit launchd running
emit listening "$LISTENING"
exit 0
`;
}
