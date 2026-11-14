OMP process-owned local host prerequisite

Base: https://github.com/can1357/oh-my-pi.git
Tag: v18.20.0
Revision: c308970263ae13744ea15ab67302e3dac840e266
Patches, in order:
  0001-process-owned-local-rpc-and-native-attach.patch
  0002-config-only-settings.patch
upstream/omp.json patchSha256 hashes their concatenated contents in this order.

Apply from a clean checkout of the exact base revision:
  git apply /absolute/omp-superagent/patches/omp/0001-process-owned-local-rpc-and-native-attach.patch
  git apply /absolute/omp-superagent/patches/omp/0002-config-only-settings.patch
  bun install --frozen-lockfile

Use Bun 1.4.4 or a compatible newer version. The outer project links the local
coding-agent package (link:.upstream/omp/packages/coding-agent), so its workspace
dependencies resolve through the upstream checkout. No publishing, installed
OMP replacement, or production bot activation is required.

Managed Hosts set the process-local OMP_SUPERAGENT_MANAGED_ULW_PATH marker to
their canonical immutable package root and explicitly select the same root
with -e. Core reads that root's actual package.json name and excludes other
revisions of that package from module and sibling-resource discovery, including
configured files and symlinks. The selected package's modules bypass inherited
extension-module name disables; unrelated modules and exclusions stay intact.
Its sibling resources precede other explicit/configured/installed package roots.
Invalid or unselected roots, missing package identity, and roots with no modules
fail instead of silently falling back. Without the marker OMP is unchanged.
This never edits global settings/packages or uses --no-extensions.

Launch one OS process for each authoritative session:
  mkdir -m 700 /private/tmp/omp-host-$UID
  bun packages/coding-agent/src/cli.ts --mode rpc-ui \
    --rpc-socket /private/tmp/omp-host-$UID/host.sock \
    --session /absolute/state/session.jsonl --cwd /absolute/project \
    --session-settings \
    -e /absolute/omp-superagent/src/extension.ts

--session-settings installs a native Settings.overlay() before auth discovery,
model-registry construction, and the session. User/project/config-overlay reads,
native modelRoles.judge and its fallbacks, credentials, and runtime storage are
preserved. Settings edits, including /model role assignments and /modelpreset
switch, stay process-local. Native session model_change entries still persist;
resume without --model to restore the transcript's latest selected model. This
does not use --no-session or a copied auth/config directory. Without the flag,
ordinary native settings persistence is unchanged. Deliberate first-run preset
creation must use a separate explicitly authorized native Settings instance;
routine model/preset choices must use the managed session's overlay.
Offline setup preferences use Settings.loadConfigOnly(), which strictly reads
native config sources then enables the existing locked, per-key persistence.
It never opens/migrates account storage, runs legacy migrations, binds runtime
effects, or replaces the Settings singleton. With no modern config and legacy
settings/account storage present, it refuses to create a file that could shadow
unmigrated preferences; use normal OMP configuration to migrate/repair first.
Fresh read-only native readback must distinguish saved global preference from
an effective value shadowed by project/overlay settings.
Use native createModelPresetIfMissing(settings, name, preset) for authorized
bootstrap only. It checks raw own-key presence under the existing native YAML
write lock and returns created/preserved/conflict after native readback. Even
hidden/null/invalid or concurrently inserted same-name entries are not replaced.
No role-mutation lock is acquired inside this helper; the initializer may hold
that native lock across its batch. Ordinary setEntry is not conditional create.
Native attach replicas always use the same process-local settings boundary,
including keyboard-opened model menus; they cannot persist local role edits.
get_state.settingsScope reports the actual session/persistent write boundary.
get_state.modelSettings contains actual effective native modelRoles and
defaultThinkingLevel, separate from the active model/effort. Compare the full
snapshot after lost acknowledgements or restart; identity alone is insufficient.
For frozen native presets, add --model-preset <name> and supply the complete
modelPresets.<name> snapshot through a private --config overlay. It applies once
after session construction and before first prompt/listen/ready; ACP is not a
single-session startup host. Live idle changes use set_model_preset with name
and the complete native preset snapshot; effective roles/thinking/model are
read back through the native preset application path. Persistent/busy hosts
refuse, and missing settingsScope on an older host is never proof of isolation.

The session file may be absent on first launch; native SessionManager creates it
at that exact path. Existing sessions must have matching cwd. The socket must be
absolute, at most 100 UTF-8 bytes, within an existing owner-only 0700 directory.
The host creates a 0600 socket and never overwrites an existing path. It exports
OMP_RPC_SOCKET before extension loading. A self-connecting extension must return
from session_start before awaiting ordinary RPC requests to its own host.

Native TUI attachment (same worker, existing Collab guest renderer/protocol):
  bun packages/coding-agent/src/cli.ts attach /private/tmp/omp-host-$UID/host.sock
  bun packages/coding-agent/src/cli.ts attach /private/tmp/omp-host-$UID/host.sock --read-only

Private socket RPC uses the existing ready, negotiation, JSONL and chunk framing.
RpcClient custom transport kill() must disconnect only the socket, never signal
the host. Client/controller/TUI disconnect does not stop or abort the worker.
Request correlation, filters/delta projection, negotiation and subagent
subscriptions are per connection. Host capabilities route only to their explicit
owner. Pending approvals retain original request IDs and replay on reconnect;
get_state.pendingUiRequests is authoritative. First valid RPC/TUI answer wins.
get_state.hostPid identifies the authoritative process.

Stop explicitly with shutdown_host (or RpcClient.shutdownHost()). session_busy
refuses running/queued/background work, owned services (even delivery-suppressed),
pending dialogs/capability calls, and other outstanding commands. isSettled keeps
native conversation semantics; hasOwnedRunningWork independently prevents idle
slot/process release. A successful response acknowledges shutdown: wait for host
exit 0 to confirm persisted disposal. No implicit retry or prompt/result journal
is added: a disconnected unconfirmed submission is uncertain, not replayable.

Manual compact remains on the native serial command tail, so later prompts,
model/settings changes and session mutations cannot overtake its admission or
cleanup. abort and abort_and_restore_queue bypass that tail and cancel manual
compaction through the native session abort barrier, including a compact still
queued before admission. Read-only get_state (including contextUsage),
get_session_stats, get_available_models and get_available_thinking_levels also
bypass it; a pending discovery or read does not block another query or stop.
Snapshots reflect the authoritative process-owned session, not a serial fence
for earlier unacknowledged mutations. RpcClient.request timeoutMs: 0 explicitly
disables the response deadline for long compact work; disconnection still
rejects outstanding requests and never retries them. Existing wire shapes and
request correlation are unchanged; there is no abort_compaction wire command.

Run targeted tests once after integration, from the upstream root:
  bun test packages/coding-agent/test/rpc-input-frame.test.ts \
    packages/coding-agent/test/rpc-user-input-order.test.ts \
    packages/coding-agent/test/rpc-client.start.test.ts
  bun test packages/coding-agent/test/managed-extension-precedence.test.ts \
    packages/coding-agent/test/extensions-discovery.test.ts \
    packages/coding-agent/test/plugin-extensions-discovery.test.ts \
    packages/coding-agent/test/discovery/disabled-extensions.test.ts \
    packages/coding-agent/test/task/discovery.test.ts
  bun test packages/coding-agent/test/cli-session-settings.test.ts
  bun test packages/coding-agent/test/model-presets.test.ts
  bun test packages/coding-agent/test/settings-manager.test.ts
  bun test packages/coding-agent/test/rpc-socket-host.test.ts \
    packages/coding-agent/test/collab/chunked-welcome.test.ts \
    packages/coding-agent/test/collab/replication-shrink.test.ts \
    packages/coding-agent/test/rpc-client.start.test.ts \
    packages/coding-agent/test/rpc-client.restart.test.ts \
    packages/coding-agent/test/rpc-session-events.test.ts \
    packages/coding-agent/test/rpc-extension-ui.test.ts \
    packages/coding-agent/test/rpc-wire/generated.test.ts

Actual CLI/PTY smoke, with no production model calls:
  export PI_CODING_AGENT_DIR=/absolute/isolated/config
  bun packages/coding-agent/src/cli.ts --mode rpc-ui \
    --rpc-socket /private/tmp/omp-host-$UID/host.sock \
    --session /absolute/isolated/session.jsonl --cwd /absolute/isolated \
    --model socket-host-smoke/local \
    -e /absolute/upstream/packages/coding-agent/test/fixtures/socket-host-smoke-extension.ts

Attach under a real PTY using the native attach command above. Ordinary prompts
stream a deterministic local reply. A prompt containing "approval" raises the
real extension confirm UI; "slow" holds a cancellable turn for disconnect tests.
"NATIVE_TUI_EDITABLE_LOCAL_PROMPT" returns "Socket host editable response" so an
editable native-TUI submission cannot pass by merely replaying seeded history.
Test read-only attach cannot answer/abort/prompt, writable attach can answer,
RPC and native displays cancel together, reconnect snapshots preserve transcript,
and every viewer/controller can exit while the original process remains alive.
Also isolate HOME/XDG directories when exercising the real CLI.

Use the provider-qualified --model selector above, not --provider: upstream
validates explicit --provider before loading extension-defined providers, while
provider-qualified --model resolution is deferred until those extensions load.

Wire artifacts were regenerated with bun run gen:rpc. The integrating parent
verified targeted RPC/Collab regressions, the actual CLI host lifecycle, and
read-only/editable native TUI attachment. See upstream/omp.json and the root
docs/OPERATIONS.md for exact results and unverified production boundaries.
