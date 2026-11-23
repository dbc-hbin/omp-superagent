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

### Management tools

**Remote placement.** The head may bind a new lane to a verified SSH worker.
The durable binding includes the target enrollment, repository identity, revision
and subdirectory. Admission, approvals and messenger delivery remain head-owned;
the worker launches the stock Host and owns its Unix socket, processes and native
journal. An SSH disconnect is client detach, not cancellation, an exit receipt,
or authority to reassign work. Open and attachment are separate from sending
the first input. A pending or ambiguous launch must be reconciled on that
worker, never retried on another machine. Remote PIDs and session paths are not
local filesystem or board identities. See [worker enrollment](../../README.md#add-a-remote-worker).

When several workers qualify, placement accounts for both reported free slots
and head assignments waiting to start. Concurrent admissions reserve their
selection before the next admission decides, without serializing SSH probes.
On the target, a failure before native session preparation releases the slot;
after preparation begins, an uncertain attempt keeps its reservation.
An absent socket alone cannot resolve a pending open: an SSH request may
still arrive. Explicit close or resume can seal that generation on the worker
before proceeding. A later open for the sealed generation is refused.

Only an operator-approved head checkout may use a default worker implicitly;
Git origin and commit identify compatible contents, not permission to send a
task. Worker verification must not execute checkout-configured Git filters.
The remote native owner accepts only session-bound control, inspection and
ordinary prompts, not the full stock RPC surface. In particular, callers
cannot use attach to choose a different session or invoke native shell commands.
The target account and its explicitly approved extensions remain trusted;
OpenSSH command restrictions are not an OS sandbox for native agent tools.

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
An intact queue must not be reported as truncated. No second Bun runtime stays resident per Host.
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
entries still under management; do not switch existing sessions. Preset role
synchronization watches the configured native preset/role files, parent
directories (so replaced directories with new inodes rebind cleanly), and
every symlink hop (`fs.watch`, debounced), watches surviving ancestors for
uncreated directories, and reconciles once after installing watchers. Errors
and explicit `"deferred"` outcomes get bounded backoff retries. Deferred work
continues at a slow interval after those retries so late model availability
can apply without another config edit. Slow periodic polling also stays
active whenever any source is uncovered or a watcher errors. These labels
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
homogeneous items under a fixed rubric; it is not a SUPER workflow or a verification
substitute. Select SUPER only when its specific durable plan, evidence gates,
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
capability does not silently downgrade a selected SUPER request to ordinary work.

SUPER's command, skill and native-keyword contracts are based on
[omp-superkit `c11a6e4e185f9c31f484a05a13528ef724337bc1`](https://github.com/dbc-hbin/omp-superkit/tree/c11a6e4e185f9c31f484a05a13528ef724337bc1).
Use a leading invocation; the `/` is optional in request text. These are OMP
extension commands, not registered messenger controls.

| OMP command | `workflow.name` | Discoverable OMP skill | Default native keyword |
| --- | --- | --- | --- |
| `/super` | `super` | `skill://ultrawork` | None |
| `/super-plan` | `super-plan` | `skill://ulw-plan` | `ultrathink` |
| `/super-run` | `super-run` | `skill://ulw-execute` | `orchestrate` |
| `/super-loop` | `super-loop` | `skill://ulw-loop` | `orchestrate` |
| `/super-research` | `super-research` | `skill://ulw-research` | `workflowz` |
| `/super-graph` | `super-graph` | `skill://mass-ulw` | `workflowz` |

Plain SUPER arms the session without selecting a specialty workflow or implicitly
creating a goal in RPC. SUPER Graph selects the graph workflow, not plain SUPER
activation. Defaults apply only when the original request has no native keyword;
leave quoted and negated keywords to native OMP interpretation. `jevify` uses
the native notice, subject to native settings and Eval availability, with no
extension-command preflight. Installation, profile load, skill application,
actual native activation, goal creation, and work completion are separate facts.

On upgrade, old ULW invocations remain valid in original user text and are
preserved there. New structured choices use only the canonical values above
(or `jevify`), not legacy aliases or a `skill://` ID. Existing durable workflow
records, skill IDs, flags and native journal types are not renamed. A resident
pre-upgrade Host can still receive the mapped old command if it advertises
that original extension registration; a compatibility alias on a current Host
does not stand in for its missing canonical command.

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
This is not a continuous check of workflow mode or prompt execution. Managed discovery preserves
unrelated native resources and avoids loading a duplicate omp-superkit instance. Refuse
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
- [Repository PR intake](../../src/cron-pr-intake.ts) is a typed cron job, not
  an executable prompt. Only original configured-owner Discord guild parent
  controls enroll a repository. Discovery pins the authenticated GitHub owner
  and repository, filters old/self-authored PRs, and records each offer before
  delivery. The separately authenticated registration/mode action sets a bounded
  unattended ceiling: review/comment, safe fix, or protected merge. The confirmed
  bot offer's Discord snowflake identifies the one thread for that PR. A
  noninteractive controller receipt admits an exact SHA to a tool-less native
  lane; it is not owner input and cannot serve as a source for manager tools.
  No ordinary scheduled prompt, observed PR text or model answer grants authority.
  Older discovery-only registrations remain manual until the owner opts in.
  [Review control](../../src/pr-intake-review.ts) binds subsequent actions to
  that lane, route, enrollment epoch, review input, delivered answer and SHA.
  Static review uses a trusted workspace without a contributor checkout. Unlike
  ordinary coding lanes, this restricted local Host must attest a tool-less
  session on a supported native provider before the controller submits patch
  data. It does not need manager, coordination, shell or editing tools. Fix
  proposals and merge verdicts are data, not standing write authority. Each
  effect checks the enrolled repository, original route and policy revision;
  higher stages require an explicit policy or a fresh SHA-bound owner command.
  An uncertain write permits read-only reconciliation, not resubmission. See [operator commands
  and supported GitHub protections](../OPERATIONS.md#새-외부-pr-검토-cron-pr-add).
- [PR watch](../../src/pr-watch.ts) reads only explicitly registered GitHub PRs
  through existing `gh` authentication and GETs. Establish a quiet baseline,
  then record changed observations and their cursor together. Work only while
  the head runtime is available; a watch cannot recover every remote event
  between reads. A head stop holds old watches; a merged PR ends observation,
  while a non-merged closure can later reopen. GitHub content is untrusted, not
  a new owner source or authority to dispatch, resume, or perform effects.
  The same PR may be watched by different conversations without transferring
  registration or notifications. The original operator can inspect and remove
  their conversation's watch. A pass means the observed checks on the current
  head succeeded, not that branch policy permits merging.
- Lane watches observe the controller's existing records, not a second Host
  session. Status, stop, and notifications are scoped to the registration's
  original route; stopping observation does not pause or cancel the lane.
  An unloaded Host, an empty socket, and an `agent_end` event are not proof
  that the work stalled or finished. Clear observation requests may route to
  HEAD from a bound thread. Routing text alone changes no subscription.

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
