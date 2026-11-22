# Execution and coordination

[Architecture](../../DESIGN.md) · [Messaging and authority](messaging.md) · [Operations](../OPERATIONS.md)

## Lane control

Use the current conversation for direct work, native `task` for bounded subtasks,
and a lane when context, repository isolation or independent lifecycle warrants
one. A lane is the implementer, not a second supervisor. The head resolves a real
absolute cwd from evidence; never retarget an existing lane to an unrelated topic
or repository. Prefer separate authorized checkouts for independent editing
lanes in one repository. Follow native checkout policy: use `ovnfs` where the
host requires it, unless the operator explicitly requests Git worktrees. No
checkout is needed just for a read-only lane or separate reporting; checkouts
do not isolate shared refs, services or integration effects.

### Explicit remote workers

`lane_start.worker` is an operator-configured name, not a hostname supplied to
a shell. Without it the lane is local. With it, the worker resolves the cwd and
Git root inside its own approved directories. HEAD pins the worker name, SSH
alias and worker UUID in the lane row. Rebinding a topic to different placement,
including a same-named local directory, is refused.

OpenSSH carries one fixed `omp-sa-worker` command. The short-lived endpoint
authenticates the worker and HEAD instance, and binds operations to a lane and
generation. A transaction in the worker's private SQLite database reserves a
launch before the detached launcher calls the existing stock OMP Host adapter.
The remote native journal and per-generation private socket stay on the worker.
On attach the worker checks the recorded socket inode, owner PID, OMP PID,
session file/ID and generation; HEAD checks the native identity across the
stream. Disconnect closes the transport, not OMP. A lost launch response allows
inspection, not another launch. An unfinished reservation with no verified
owner is held. Native prompt acceptance, terminal journal evidence, the report
to HEAD, and the messenger send receipt are separate. An unproven prompt or
external effect is not replayed. The worker does not run a Gateway, direct
messenger sender, HEAD, or a replica of HEAD's board.

**Design note.** Worker ownership and lookup-before-retry follow a common
pattern for multi-machine agent runners, but identity is a transactional
reservation plus verified native identity, never a session-name match, and no
candidate ranking or automatic placement exists. No external host client,
report parser, shared ledger or execution layer participates at runtime.

#### One-command worker onboarding

`omp-sa worker add NAME --ssh SETUP_DESTINATION --root PATH…` turns an account the
operator can already SSH into into a registered worker; `worker doctor` verifies
it and `worker list` shows what was last measured. The logic lives in
`src/worker-setup.ts` (planning, parsing, orchestration) and
`src/worker-setup-remote.ts` (bounded POSIX scripts), wired from `src/cli.ts`.

- Decisions are pure functions of facts: a read-only preflight script reports
  platform, account, user manager, linger, the login-shell `omp`/`bun`/`git`,
  roots and existing install state as nonce-framed `key value` lines; the
  planner turns them into refusals, warnings and per-step decisions, so
  `--dry-run` and a real run share the same path and differ only in whether the
  apply scripts run. Platform requirements live in one table (`PLATFORMS`), so a
  second platform adds an entry and its Host launch path instead of branching
  through the steps.
- Every apply script re-checks the worker's state itself, copies a file it
  replaces to `<file>.bak-<time>`, and writes through a rename, so a lost
  connection or a second run leaves nothing half-done. Nothing runs as root;
  administrator commands (`enable-linger`, an OpenSSH listener beside Tailscale
  SSH) are printed, never executed.
- Identity is never invented twice: HEAD's `worker:instance` comes from the same
  `workerInstance()` code a first launch uses; an existing `worker.json` keeps
  its `workerId` for the same instance, HEAD's registered id wins for a name,
  and another instance or another registered name is refused without `--replace`.
- Native memory parity reuses `managed-memory.ts`: the worker's own copy of the
  helper inspects the account's OMP profile, and only the "no enabled backend,
  default or global source" case is repaired with the same `mnemopi` default HEAD
  applies to its own profile. Any other state is reported, not changed.
- A forced command is the only thing keeping a leaked HEAD key from being a shell,
  so `add --dedicated-key` and `doctor` prove it: `ssh <alias> whoami` must answer
  with a worker protocol frame. An address served by Tailscale SSH ignores
  `authorized_keys` options and answers with `whoami`; that is refused with the
  OpenSSH-on-another-port fix. `doctor` probes every registered worker's runtime
  destination this way: a `whoami` answer from an ordinary alias is a warning (the
  destination runs arbitrary commands), from an omp-sa dedicated alias a failure. The worker host key is pinned from the setup
  connection (already verified) and a different recorded key is never replaced.

#### Local/remote parity matrix

Goal: a remote lane behaves like stock OMP run by the worker account on that
machine, plus the same superagent lane policy a local lane gets. Each row names
the decision, its test and its status at this revision. **P0** rows block the
first PR; **P1** rows fail closed or are documented limits. "Local" means a lane
Host started by HEAD's own `startHost` (HEAD process environment; an autostarted
HEAD has only `HOME`, `PATH` and credentials).

| # | Surface | Decision | Test | Pri | Status |
|---|---|---|---|---|---|
| 1 | Worker platform | Linux with a systemd user manager only. macOS (needs a `gui/<uid>` LaunchAgent for login-keychain access) and Windows are refused with a clear error; no automatic placement. | `requireUserManager`; real Linux worker E2E | P0 | done |
| 2 | Process context | The SSH endpoint never parents a Host. Each generation's launcher is the main process of a transient `systemd-run --user` unit (`Type=oneshot`, `KillMode=process`; the unit's exit status is the launcher's). Linger is required. Host env = the account's login-shell environment (`$SHELL -l -i -c`, NUL-framed after a nonce, stdin `/dev/null`, 20 s bound, refuse on failure) minus transport/service-manager variables, plus lane role/ID. | real Linux worker: owner cgroup under `user@<uid>.service/app.slice/omp-sa-…service`; PATH resolves like a fresh login shell; `SSH_CONNECTION` absent; Host survives every SSH exit in the scenario | P0 | done |
| 3 | Native home | Worker account's own OMP home, auth, settings, skills, AGENTS.md and memory, unchanged; memory is per machine. | real Linux worker smoke: account's own Anthropic auth answered through a worker Host | P0 | done |
| 4 | Launch options | Same option object as a local lane (model/preset snapshot, `subagentConcurrency`, lane extension set); worker adds only its paths, login env and pinned superkit. | parity test (model/preset readback, tools) | P0 | done |
| 5 | omp-superkit | A launcher that exits before claiming its reservation restores the record it replaced (no Host can exist). Per-worker `superkit`: `managed` (default) pins HEAD's active immutable revision; HEAD ships its validated package (digest-checked archive) over the worker channel; the worker probes and atomically activates it; `start` carries the revision and the Host loads exactly that package (`managedUlwRevision`), never the moving pointer. Mismatch/failed probe refuses. Worker installs use `--ignore-scripts` and never fetch from GitHub. `none` is an explicit non-parity mode: no superkit, workflow-selecting requests refused. | `remote-lanes.test.ts`, `remote-worker.test.ts` (match, mismatch, missing, idempotent provisioning, bad digest), runtime none-mode refusal, native loopback and real Linux worker provisioning | P0 | done |
| 6 | Capability handshake | Protocol `omp-sa-worker-2`. Before every launch `capability` reports platform, package version and source digest, OMP version, superkit revision, boot ID, clock, approved roots and models (the worker itself refuses a non-Linux platform); HEAD refuses a package mismatch, OMP below the SDK-matched minimum and clock skew over 2 min. `start` and `attach` return the launch facts pinned in the worker reservation (package, OMP, superkit, boot ID), recorded on the lane (`workerLaunch`) and shown in `status`/`lane_inspect`. | `remote-lanes.test.ts`; native assertion on `workerLaunch` | P0 | done |
| 7 | Worker code provisioning | `omp-sa worker add` installs HEAD's own release on the worker over the operator's ordinary SSH login: a deterministic archive of exactly the files `workerPackage()` digests plus `bun.lock`, `skills/`, `upstream/ulw.json` and the one native Host owner for the worker's architecture, `bun install --frozen-lockfile --ignore-scripts --production`, installed digest verified against HEAD's, atomic `releases/current` switch; old releases stay. The handshake still refuses any mismatch before a launch. | `worker-setup.test.ts` (archive, planning, idempotence decisions); `worker-onboarding.test.ts` (dry run, add, re-add, doctor over a loopback ssh); mismatch refusal | P1 | done |
| 8 | Model availability | Lane start/resume/model change check the worker's catalog (capability); a live worker lane is checked against its own Host's `get_available_models`; the worker's start preflight requires the exact lane model (HEAD's exact selection, also for presets) in `omp models --json` under the login env. Other preset roles can be aliases, patterns or fallback lists and are left to OMP's own resolution on the worker. A restore launch sends no model: the restored session keeps its own, which is then checked against the Host's catalog. | unit refusals; real Linux worker real-home model listing | P0 | done |
| 9 | Attachments | Every attachment is stored once, SHA-256 verified, under the lane's private worker directory via the `input` op; the prompt names the worker path. Images are no longer sent only as RPC images. | runtime test; worker test | P0 | done |
| 10 | Verifying lane evidence | Head tool `lane_evidence` reads bounded, read-only evidence from a lane's own workspace, identically for local lanes (here) and worker lanes (the worker's `evidence` op): a file inside the lane cwd after resolving symlinks (64 KiB per read, offset/limit), `git status`/`log`/`diff --stat` with no optional locks, hooks, pager, fsmonitor or external diff, and the lane Host's current log tail. The head reference forbids reading worker paths with local tools. | `lane-evidence.test.ts` (bounds, escapes, git, log), worker endpoint test, runtime routing test, native loopback and real Linux worker scenario | P0 | done |
| 11 | Lane tools to HEAD | `lane_report`, approvals, `decision_ask` and goals use the same native frames over the bridged stream. The board extension loads unchanged on the worker (same tools, approvals, prompt section and context notices); only its backend differs: each operation is a stock extension UI `editor` request (`superagent-board-rpc-v1`) on the lane's own stream, answered by HEAD from its coordination store under the identity HEAD verified for that stream (`Board` worker mode: placed lane, exact worker session, Gateway-owned head process). While HEAD is disconnected the board reads as unavailable (15 s bound) and returns on reattach. Default channel is `repo:<worker path>`. | `board.test.ts` worker membership and serving; parity test (identical tools, board round trip, notices, approval, report) | P0 | done |
| 12 | Worker unreachable | Transport loss, an unreachable inspect, or a sent start whose reply was lost keeps submissions `submitted` with no notice; `workerReachability` records since/attempts/error; inspection-and-attach retries back off (15 s doubling to 5 min) from the maintenance tick, and a pause recorded meanwhile is delivered on reattach; no local fallback, second launch or replay. Unproven submissions are reported uncertain only once the worker answers (after reattach, or when it proves the Host gone). The lane keeps its `maxHosts` slot while held. | runtime unreachable and lost-start tests; native detached-completion recovery | P0 | done |
| 13 | Workspace and choice | Worker maps a missing cwd to "Workspace does not exist on the worker"; capability lists approved roots; head reference forbids automatic placement. | worker tests | P0 | done |
| 14 | Capacity | Remote Hosts count toward `maxHosts`; a held or exiting remote lane keeps its slot until verified, while a launch refused before any Host existed, or a closed lane the worker proved hostless, frees it. Only one remote release is verified at a time for eviction, with backed-off exit checks. Per-worker limits are a follow-up. | runtime refusal test; existing capacity tests | P1 | done (global) |
| 15 | SSH hardening | Dedicated key with `from=<tailnet ranges>,restrict,command=…omp-sa-worker` (`worker add --dedicated-key` writes it and verifies enforcement; `doctor` re-checks and refuses a Tailscale-SSH-served alias with the fix); client options fixed in code. Only OpenSSH honors `authorized_keys` options: Tailscale SSH on a tailnet address's port 22 bypasses the forced command, so tailnet workers keep Tailscale SSH and add OpenSSH on the tailnet address at another port; the key line also carries `from=` tailnet ranges. | real-SSH proofs run over the tailnet through a dedicated forced-command key (`whoami` returns a worker frame; port forwarding refused; key refused from outside the tailnet) | P0 | done |
| 16 | Parallel editing on a worker | Same routing policy as local; the owner (or a lane on the worker) prepares worker checkouts inside approved roots. | — | P1 | documented |
| 17 | Stop, close, status | Native shutdown and exit verification over SSH; CLI refuses remote control; status shows placement, `workerLaunch`, reachability. | existing tests | P0 | done |
| 18 | Clocks and PIDs | Skew bounded by #6. PIDs are pinned with the boot ID; after a reboot recorded PIDs are treated as dead, never as reused live owners. A Host lost in a reboot without an exit receipt needs operator reconciliation. | worker evaluate path | P0 (skew, boot ID) / P1 (reboot reconciliation) | done / documented |
| 19 | Observations after reattach | Remote recovery does not restore the observation cursor; progress observations resume only after the current run. | — | P1 | documented |
| 20 | Goal continuation across HEAD restart | Multi-run goal continuation spanning a restart/reconnect ends unconfirmed for remote lanes (no checkpointed `ownedRuns`). | — | P1 | documented |
| 21 | Owner result uploads | The same owner directive and live tool-execution match as a local lane. For a worker lane HEAD never opens a same-named local path: the worker's `result` op stages the file with the local staging rules (literal non-hidden relative path, no links or hard links, 8 MiB, unchanged during read) against its own private paths (worker state, worker provisioning, OMP home, SSH directory, lane journal), streams the bytes with a SHA-256, and HEAD queues them only while that owner input is still the submitted run. | worker endpoint test (stage, hidden refusal, missing file) | P0 | done |
| 22 | Dispatch authority | Remote dispatch requires the original authorized user source (stricter than local, deliberate). | runtime test | — | deliberate difference |
| 23 | No difference | Cron delegation refusal, PR watch (HEAD only), native session publication on the worker, workflow advertisement via the lane Host, idle eviction, worker logs (`r<gen>.log`, `launcher.log`). | existing tests | — | same |

### Management tools

The [head extension](../../src/extension.ts) restricts manager tools to
the managed root. Use live tool schemas for arguments and [head role
references](../../skills/head/SKILL.md) for operating policy.

| Tools | Authority and outcome |
| --- | --- |
| `lane_start` | Requires a durable user source, title, existing absolute cwd, exact model or native preset, model reason and kickoff. Accepts a bounded brief, acceptance criteria, and an authorized destination or workflow. At most one new lane per source. Returns the durable ID and admission state, not an execution or completion receipt. |
| `lane_message` | Explicit follow-up with a real authorized `sourceId` and the target lane. Deduplicate by source and lane; check destination, attachment/quote scope and identity compatibility. The same source may reach existing lanes only where those routes and reporting are authorized. |
| `lane_inspect` | Lists records without a live probe; inspecting a specific lane adds live status where observable, model readback, queue blockers and observed progress. Null actual state is unknown, not a match. |
| `lane_pause` | Takes a managed lane ID. Persists pause intent and requests an interrupt without claiming owned services or earlier effects are gone. |
| `lane_resume` | Takes a managed lane ID and an authorized original `sourceId`. May reopen a paused native goal after checking native state; never releases an uncertain submission or revives cancelled work. |
| `lane_close` | Records verified completion or cancellation. Not permission to merge, publish, deploy, spend, or delete a checkout. |
| `lane_models`, `lane_init_presets`, `lane_set_model` | Inspect native candidates, initialize missing presets, or explicitly change one idle lane; see [Models and presets](#models-and-presets). |
| `thread_inspect`, `lane_thread_update` and the `decision_*` tools | Use the [messaging and authority contract](messaging.md) for scope, original thread/approval identities and readback. |

Send only the original task, relevant evidence, constraints and acceptance
criteria to a lane; never copy the full head transcript. A new topic starts
with the exact observed head model, not its conversation; subsequent work uses
the topic's own saved model and session. A topic lane replies in the operator's
language through the controller outbox. Explicit manager handoffs and their
internal reports use English. No lane gains messenger credentials. Distinguish dispatch acceptance, actual
execution, native settlement, verified acceptance criteria, and user delivery.

The [`lane_report` tool](../../src/lane-extension.ts) records evidence in the
native journal. It hashes selected files in bounded chunks, verifying their identity
and metadata before accepting the digest, or hashes successful tool results. Duplicate
content and repeated waits do not refresh evidence timestamps; ordinary
commentary is not verification. Resolve only the exact tool/approval/job or
dependency wait. Lane observation reads request only the entries appended
after the source-bound journal cursor (`get_entries` with `since`). A missing
cursor fails the observation rather than replaying another request's history.
When only a starting position is needed, the managed owner waits for its queued
observations to be journaled and returns the native leaf ID, not the transcript.
Already-running owners without that capability keep using their stock response.
Ownership and outcome checks that need the full journal still read it. The
runtime exposes observation timestamps and `ownerCurrent`, not a guarantee
that a reported dependency is still live. Native children cannot use the
manager, report as the lane, or access the board.

## Execution budget and Host lifecycle

[`maxHosts`, `maxSubagents`, and `idleMs`](../../src/config.ts) are explicit
operator inputs. `maxHosts` includes the head; the per-Host native child
concurrency budget is `floor(maxSubagents / maxHosts)`. This bounds configured
execution concurrency, not machine memory, CPU or provider spend. Lanes wait
durably when slots are full. Prioritize authorized follow-ups; approval and
stop controls remain reachable. A queued lane, a resident Host, an active turn
and an accepted work result are different states.

Each resident lane is an independent OMP process. Detaching the head's control
connection or replacing the head does not end that process. Reconnect only to
the matching owned socket, PID, native session ID/file and execution generation.
Hold unrecognized or unobservable owners against capacity rather than deleting
sockets or opening a duplicate writer. After idle timeout, eligibility to
unload requires actual native quiescence, no queued/admitted work, pending UI,
children, async wakes, unresolved submissions or owned services, and confirmed
journal persistence. An enabled native goal, including a paused one, can prevent
shutdown. Do not infer eligibility from `agent_end`, an RPC disconnect, a saved
file, or a lease alone. Release ownership and the slot only after actual native
exit; a shutdown ACK is not exit. Reload the same native session when authorized.

The resident Rust owner speaks the stock JSONL/v2 protocol. Bun and the published SDK still
prepare and publish the native session under its exact profile. The owner invokes short-lived
SDK helpers for operations that depend on stock semantics, including fitting a withdrawn
queue and verifying journal persistence after exit. On the private v2 interrupt channel,
queue restoration uses the SDK's reassembled-frame byte limit: this is the value of
[`maxResponseBytes` in OMP 19.0](https://github.com/can1357/oh-my-pi/blob/v19.0.0/packages/coding-agent/src/modes/rpc/rpc-frame.ts#L341-L347)
and [`maxIntactFrameBytes` in 19.1](https://github.com/can1357/oh-my-pi/blob/v19.1.0/packages/coding-agent/src/modes/rpc/rpc-frame.ts#L341-L347).
An intact queue must not be reported as truncated. Local Hosts need no second resident Bun
runtime. A remote attachment keeps a Bun stdio bridge for the life of that SSH connection;
the bridge is not the session owner and need not survive detach.
Gateway supervision reads the exact session, process and socket identity from a fresh handshake
instead of fetching the same full state again on the new connection.

The stock CLI emits its ordinary full stream by default. The public `set_event_filter` still has
the scope of the installed CLI. Superagent does not change it implicitly. On its own connection the
managed controller negotiates `activity-v1`: each incremental text, thinking or tool-call update becomes
one ordered activity frame instead of repeating the accumulated payload. The reduction is on that socket,
not the native pipe or the owner's observation queue. Terminal messages, prompt results, approvals and
lifecycle events retain their contents. The
[recorded RPC oracle](../../test/rust-anything/) covers two synthetic native exits, including
readiness, busy refusal, detach/reconnect and a chunked Unicode event. From a source checkout,
build the owner and run `rust-anything app replay test/rust-anything` with
[rust-anything 2.1.0](https://github.com/erkamyaman/rust-anything/tree/71c78e10c5beb39acecd52c2eb3f675a199f3cea).
This compares against the Bun owner's recorded behavior; it does not replace the stock CLI lifecycle tests.

The [Host extension](../../src/host-extension.ts) uses the exact registered
`AgentSession` and native persistence/lifecycle guards. Use native `wakeSources`
where available, or the older public `hasPendingAsyncWork()` where appropriate;
owned services, child work and unconfirmed completions still need separate
checks. The configured CLI's advertised process interface selects the read-only
[OMP 18 broker](../../src/host-broker-services.ts) or [OMP 19 daemon](../../src/host-services.ts)
observation path. Do not start or take over their services, treat probe failure
as an empty result, or invent native service generations for old broker records.
A terminal service row is not confirmation that its native completion was
delivered. Reconcile exact ownership and matching completion journal evidence
with the yield queue. Name collision checks do not make service launch atomic
against another process using the same name.

### Native memory preflight

Resolve the effective OMP memory backend for the selected native profile,
workspace, and launch settings. Any supported backend other than `off`
satisfies the managed configuration requirement; retain it unchanged. If the
effective setting is unconfigured or globally `off`, the fallback persists
only the selected profile's global `memory.backend: mnemopi`. Setup discloses
this before final save and applies it only after successful publication.
Gateway start/restart check the head profile before activating adapters; a
new head or lane Host checks its own workspace before launching stock OMP.
`doctor` only inspects the effective configuration. A workspace dotenv file can
select a different profile for native reads, but cannot authorize a global
write there. Lanes also honor the profile bound in the head's private launch
manifest, rather than treating its post-dotenv environment as operator input.

A restart runner checks eligibility without writing while the predecessor can
still accept a stop. If the fallback is needed, the runner applies it after
the predecessor exits and the runner obtains the lifetime lock, before spawning
the validated successor. A failure to write at that point fails the restart;
it does not restart the predecessor or activate adapters. Head and lane extension
composition must be valid before either launch can persist a fallback.

The [guarded native writer](../../src/native-settings.ts) rechecks the expected
configuration under the native lock, preserves unrelated settings, and reads
back the effective value. It does not overwrite stale values, higher-priority
disables or unsets, or unverified legacy/unknown settings. If enabled memory
cannot be verified, launch stays blocked. This preflight does not initialize
memory or verify live search. [Historical topic search](messaging.md#topic-routing-and-controls)
still specifically requires an active, searchable Mnemopi backend on the head.

### Native discovery and resume

[Native discovery](../../src/native-sessions.ts) publishes symlinks to the
original journal and artifact directory in the active profile's native project
bucket. It does not copy transcripts, transfer a writer lease or wake unloaded
lanes. Use normal OMP discovery and `/resume`; native rules govern concurrent
writers and forks. An ordinary resume gets no manager or board authority and
is not attachment to the running managed Host.

### Goal continuity

Within the entrusted objective, continue from verified intermediate results
without asking for per-step permission. Reuse one native goal or durable
workflow owner rather than creating competing aggregate goals. Goal controls
use native RPC continuation where enabled, preserving explicit tool exclusions,
`goal.enabled`, and operator approvals. The head waiting for a lane ends its
turn and wakes on actual events; it does not run a watchdog model. An idle
unloaded session does not execute a saved goal.

Explicit source-bound resume uses its own receipt, distinct from the ordinary
handoff for that source. Check outcome after native acknowledgement; an aborted,
failed, or zero-run resume is not successful continuation. A newer pause/cancel
invalidates older queued or in-flight resume claims. Head replacement only
resumes an eligible head goal as described in the [restart contract](../../DESIGN.md#explicit-restart).

## Models and presets

[`lane_models`](../../src/lane-models.ts) derives the shortlist from native
availability and exact provider/model IDs. Model capabilities and prices are
catalogue fields, not measured quality, total cost or permission to spend.
The [model-selection skill](../../skills/head/references/model-selection.md)
normally consults native judge for a meaningful choice, with minimal safe task
and candidate facts; the head makes and records the decision. Report judge
unavailability or failure without inventing a receipt or switching providers.
Judge usage is native. Runtime enforces exact selection, availability and reason,
not a mandatory judge call.

At startup, [preset initialization](../../src/native-presets.ts) inspects native
`high`, `middle`, `low` presets. If needed the existing head gets one tracked
bootstrap turn; do not repeat an uncertain turn after reconnect or restart.
Create only missing presets and verify native readback before ordinary work
starts. Invalid, tombstoned, shadowed or operator-edited entries are not
overwritten. Managed presets follow the native `slow`, `default`, and `smol`
roles respectively when their available selections change. Refresh only the
entries still under management; do not switch existing sessions. These labels
are preset names, not custom roles or tested performance/cost tiers.

Each lane records a resolved model, selection reason, and the complete native
role/thinking preset snapshot if a preset was selected. A later preset/global
change does not change that snapshot. Resume and reconnect check native
readback; unavailability or drift holds dispatch without silently selecting a
different model. An authorized `lane_set_model` can change one eligible idle
lane, with durable intent and readback. `config.model` is a head launch default,
not the lane default or a reason to overwrite a saved head's model on restart.
Managed Hosts use private settings overlays, with native session-scope
readback. Legacy lanes without a recorded selection adopt their authoritative
native model rather than assuming the current head default; only an unstarted
lane with no journal can adopt that default. Do not recreate a missing journal
to recover a recorded session.
This preserves existing native provider fallback and retry policy; it is not a
guarantee about every lower-level provider request.

`/model` and `/effort` target the shared head even when issued in a lane topic.
Read-only queries can run while busy; mutations require native idle and session
scope, record intent and report the actual applied model/effort. A current
owner's explicit natural-language request can use `head_set_model` after its
successful turn settles. An ambiguous mutation is not retried. Only explicit
`/model preset <name> --global` saves the verified settings snapshot as global
default roles/thinking; ordinary head and lane changes leave global configuration
and other lanes alone. Native preset bootstrap/refresh and native auth updates
have separate scopes.

Argumentless `/model` and `/effort` use the same read-only native catalogue and
effort capabilities to construct menus. A selection is a new owner control on
the original topic, not a model turn or native approval. The head validates
the menu's session and generation before applying it, and an effort selection
also requires the model for which the options were shown.

## Workflow selection

The root role extensions add only their own role instructions to native context.
Use the [routing skill](../../skills/head/references/routing.md) and
[supervision skill](../../skills/head/references/supervision.md) for detailed
procedures. Native children do not inherit manager authority. General model
profiles can guide methods, not redefine the topology, routing or approvals.

Use direct work, native `task` or an ordinary lane unless a workflow has a
concrete advantage. `jevify` uses native Eval to classify independent
homogeneous items under a fixed rubric; it is not ULW or a verification
substitute. Select ULW only when its specific durable plan, evidence gates,
dependency handoff, or recovery artifacts justify the extra work. The head
may select a method inside an already authorized objective without claiming the
operator selected it. Read the installed skill and preserve its approval and
artifact ownership requirements.

[Workflow dispatch](../../src/workflow.ts) binds each choice to the original
source and an explicit `workflow: {name, reason}` on every workflow-selecting
`lane_start` or `lane_message`, even when forwarding a user selection. A brief
or report is not the selection field. Preserve the original text and native
keyword interpretation; keep generated metadata fenced. Selection is
serialized, not injected as steering. A conflict or missing advertised
capability does not silently downgrade a selected ULW request to ordinary work.

`jevify` uses the native notice (subject to native settings and Eval availability);
plain `ulw` arms ULW without choosing a specialized mode or implicitly creating
a goal. `ulw-plan` maps to `ultrathink`; `ulw-execute` and `ulw-loop` map to
`orchestrate`; `ulw-research` and `mass-ulw` map to `workflowz`, subject to
the original source's native keywords. Installation, profile load, selected
skill application, actual native activation, goal creation, and work completion
are separate facts.

## Managed omp-superkit integration

[Preparation](../../scripts/prepare-ulw.ts) runs during `postinstall` or
`bun run prepare:ulw`, even if OMP is not installed. The
[declared remote](../../upstream/ulw.json) is the official `omp-superkit`
repository. [Managed installation](../../src/managed-ulw.ts) and duplicate
detection recognize both `omp-superkit` and the legacy `omp-ulw` package ID.

Stage the observed revision and its dependencies in a project-owned immutable
package. Ignore arbitrary dependency lifecycle scripts; run defined
materialization and an [offline native prompt-composition probe](../../src/managed-ulw-probe.ts)
for ordinary and explicitly activated operation. Serialize preparation via
the update lock and atomically publish `active.json` only after validation.
Once installed, activate only fast-forward revisions from the same source;
retain the last valid active revision and report failures. Do not delete older
packages or rewrite a user's checkout or global settings.

A production Gateway requires a valid active installation before adapter
activation. With that installation in place, startup does not wait for the remote.
Startup and periodic update checks run in ordinary code, not a model turn.
Every **new Host** resolves the active revision; a running Host or reconnect
keeps its existing immutable package. Before the owner exposes its socket, the
root session checks every manifest entry against the active extensions in its own
OMP `extensionRunner`, after deferred binding if necessary. The owner requires
the resulting canonical package path to match its immutable launch selection.
An import or factory failure, a disabled module, or an unavailable runner cannot
produce a ready Host. Reattaching a managed session requires its startup receipt,
not a match against a newer active pointer; an unverified older Host can still
be inspected and stopped. Gateway status distinguishes `head.loadedSuperkitPath`
(the attached head's startup receipt) from `ulw.packagePath` (next launch).
This is not a continuous check of workflow mode or prompt execution. A managed remote worker never
prepares from the remote: HEAD packs its active immutable revision, the worker
verifies the archive digest, runs the same probe and activates it under the same
update lock, and a remote launch names that exact revision (parity row 5).
Managed discovery preserves
unrelated native resources and avoids loading a duplicate ULW instance. Refuse
configurations the stock CLI cannot express without silently changing scope,
discarding custom commands or enabling disabled extensions.

## Scheduled work and PR observation

- [Cron jobs](../../src/cron-jobs.ts) run through the head's existing maintenance
  loop, not a Gateway scheduler or a second agent. `/cron` is a code-handled
  control scoped to the original owner's full route. `cron_create` requires
  an explicit request in the current admitted owner turn and the native tool
  policy. Edits, lane reports, native children and scheduled runs cannot
  register schedules. For tool registration, one source gets one durable
  receipt, which survives removal; command admission uses the normal input
  identity. During restart holds, list/show remain readable but changes are
  fenced.
- Persist the due-run ID and schedule advancement together. Check the original
  route and pending Gateway ingress before native submission; drain recovered
  stop/management controls first. Each job has at most one outstanding run;
  coalesce missed recurrences rather than replaying them. Scheduled work is not
  an interactive user source and adds no steering, workflow, delegation or
  approval authority. An unresolved run is not repeated; a head stop fence
  requires explicit per-job resume. Pause and removal can cancel a queued
  run, not interrupt submitted or uncertain work. Delivery uses the normal
  head outbox. See the [operator reference](../OPERATIONS.md#예약-작업-cron)
  for schedule syntax and controls.
- [PR watch](../../src/pr-watch.ts) reads only explicitly registered GitHub PRs
  through existing `gh` authentication and GETs. Establish a quiet baseline,
  then record changed observations and their cursor together. Work only while
  the head runtime is available; a watch cannot recover every remote event
  between reads. A head stop holds old watches; a merged PR ends observation,
  while a non-merged closure can later reopen. GitHub content is untrusted, not
  a new owner source or authority to dispatch, resume, or perform effects.

## Shared information board

The [board extension](../../src/board-extension.ts) checks the canonical
instance and current native session ID, file, PID and applicable lane generation
against managed registration for every access or notice. Role environment
alone is insufficient. Standalone resumes, other instances, stale/unloaded
Hosts and native children are excluded. A connected paused lane remains a
participant. The runtime assigns the actor and deduplicates posts by native
session and tool-call ID.

`board_post`, `board_read`, and `board_subscribe` operate on `general` and
`repo:<canonical absolute path>` channels. Subscribers are per native session;
all registered participants can read all channels in the instance, so channels
are not ACLs. Mark only the exact IDs returned by `board_read`; a reply does
not mark its parent read. Keep notice cursors separate from read receipts.

Registered head and lane roots receive header-only notices at native context
boundaries. Lane posts are eligible for head notices; lanes receive notices
for subscriptions and explicit mentions. An idle head can display an event-driven
native notice with `triggerTurn: false`; idle lanes wait until their next
authorized turn. A notice is not a model wake,
read confirmation, actor impersonation, command, approval or evidence of
completion. No self-wake, read-ACK loop or unloaded lane activation. Use
durable lane reports for actual outcomes; the board cannot supply an external
messenger route.
