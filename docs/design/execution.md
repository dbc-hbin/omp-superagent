# Execution and coordination

[Architecture](../../DESIGN.md) · [Messaging and authority](messaging.md) · [Operations](../OPERATIONS.en.md)

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

### Remote placement

The head may bind a new lane to a verified SSH worker.
The durable binding includes the target enrollment, repository identity, revision
and subdirectory. Admission, approvals and messenger delivery remain head-owned;
the worker launches the stock Host and owns its Unix socket, processes and native
journal. An SSH disconnect is client detach, not cancellation, an exit receipt,
or authority to reassign work. Open and attachment are separate from sending
the first input. A pending or ambiguous launch must be reconciled on that
worker, never retried on another machine. Remote PIDs and session paths do not
identify local processes or files. See [worker enrollment](../OPERATIONS.en.md#add-a-remote-worker).

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

### Idle remote memory pull

`remoteMemorySync` is an opt-in HEAD config setting, not a lane tool. The privacy
boundary is a newly negotiated, paired worker lane in the **same canonical
workspace as HEAD**. Both ends must use Mnemopi's `per-project` mode, not
`per-project-tagged` or `global`. A participating worker lane starts with a private native
bank and no previously shared project memories. Older sessions keep their
original native store; neither it nor its contents are moved or removed.
The controller never searches the worker's normal profile for historical records.

| Native backend | As worker source | As HEAD destination |
| --- | --- | --- |
| Mnemopi | Explicit project `retain`/`learn` facts in the isolated lane's native project bank. Exclude global writes, automatic transcripts, synthesized episodes, scratchpads, context/metadata and skills. | The live HEAD's matching project write bank only. Import text, not vectors, using the local bank's indexing policy. |
| Local | No session-bound record iterator for the shared rollout summary / `learned.md`. | No independent non-overwriting, searchable record import; the summary is developer-instruction input. |
| Hindsight | Remote bank listing and project tags are not a lane-owned export. | A queued remote retain is neither a local import nor a confirmed index. |
| Sharpshooter | Shared project files, not a lane-owned native record stream. | No supported isolated record import with replay confirmation. |
| Off, unavailable, unknown or older peer | No pull. | No import. |

Both ends must qualify; a mixed pair is not converted in either direction.
An unsupported pair keeps its ordinary lane lifecycle, including the existing
managed-memory launch preflight. Sync does not enable memory, change auth,
silently create a vector provider or upgrade the peer.

**Why not an OMP export or an SSH file copy?** In
[OMP 19.2.1 at `b55cd1b`](https://github.com/can1357/oh-my-pi/blob/b55cd1bb664d8ab46ddc77f2a34eb47555dbf1ac/packages/coding-agent/src/memory-backend/types.ts),
the generic extension API exposes `status`, `search` and `save`. Search is ranked,
clipped and scoped for recall; it is not iteration. Mnemopi opens its project
store [with the bank as the BEAM session ID](https://github.com/can1357/oh-my-pi/blob/b55cd1bb664d8ab46ddc77f2a34eb47555dbf1ac/packages/coding-agent/src/mnemopi/state.ts);
that ID alone does not identify the OMP lane. Its
[snapshot and import](https://github.com/can1357/oh-my-pi/blob/b55cd1bb664d8ab46ddc77f2a34eb47555dbf1ac/packages/mnemopi/src/core/beam/store.ts)
operate on a bank, not an authenticated lane; a snapshot includes scratchpad
and consolidation data. Superagent neither calls a full export nor accepts a
database, filesystem path, table selector, provider option or command over SSH.

Children can share the parent's native bank and edit a row without replacing its
creation metadata. The worker therefore also requires a content digest witnessed
at a successful **root, built-in** `retain` or `learn` call. It correlates
the root execution start, effective tool result and terminal execution event.
If stock presents `retain` or `learn` as a Bash command, only a single literal
foreground invocation with a successful typed native dispatch receipt counts;
command output, file- or stdin-backed arguments, help, compound commands and
background jobs do not.
Only matching project text is sealed in the form of a digest, never a second
copy of the text. Indirect calls without that proof, partial successes, oversized
batches, skill writes, replaced text and facts predating enrollment remain local.
The worker caps the witness at 65,536 entries per private bank; after that it
still retains ordinary native memories but does not attest additional facts.

After an admitted run has settled, the existing controller pump can pull one
bounded page per minute while the native lane remains resident. It gives
queued work priority, uses a single in-flight pull, rechecks enrollment and
native identity, and discards a page if its authority or destination changed
before import. The live Git root, repository-relative path and revision must
still match after native idle confirmation. Preparing a private bank makes
that worker eligible for a later readiness check, not for a read: its native
backend may initialize after attachment. Idle eviction permits one bounded final attempt; release does
not wait indefinitely for indexing, retry a missing acknowledgement or wake a
Host just to copy memory. Capacity eviction bypasses maintenance for a queued
lane. Stop or expiry cancels the pull's SSH probe without disconnecting the
lane's normal control channel. A short residency can leave records on the worker
until a later eligible run. Memory is never removed on either side by sync.

The durable cursor is bound to the native session, worker enrollment and
placement, and the HEAD destination. A bounded, cyclic scan can rediscover an
edited row or a reused SQLite row ID. Each page examines at most 64 working
rows plus one lookahead and returns at most 16 facts, 2 KiB each, in a 24 KiB
page. After a complete scan with one stable bank-change stamp the worker can
answer without reading or transmitting the same facts. A new Host attempt
invalidates that stamp, not the destination's record IDs. Native import IDs bind the
logical destination, origin and fact text, not the source row number or ID: two
rows with the same witnessed text in the same lane represent one imported fact.
Replay cannot overwrite existing records
or schedule another embedding for unchanged text. HEAD keeps a destination-scoped
digest receipt, not the fact text: forgetting an imported fact locally does not
make replay recreate it. A crash after reserving the digest but before native
commit leaves that uncertain fact on the worker rather than replaying it.
This is an append-only
transfer of observed facts, **not** a replica of updates or deletions. Neither
the cursor nor an SSH acknowledgement proves a vector exists. `lane_inspect`
reports page-level counts; only readback of a matching local model/vector
counts as indexed. `pending` counts a running native embedding task; `deferred`
means the text is present but no current task or vector was confirmed;
`disabled` means the configured policy is text-only. Imported records
are marked `IMPORTED` and receive lexical indexing. The HEAD adapter calls the
live BEAM `importFromDict({ working_memory: … }, false)`, never the worker's
export or a vector insert. Only new records are submitted for native
[embedding](https://github.com/can1357/oh-my-pi/blob/b55cd1bb664d8ab46ddc77f2a34eb47555dbf1ac/packages/mnemopi/src/core/beam/store.ts).
An active-model vector is checked locally
after the native task settles; a missing vector is not proof of provider
failure or an instruction to send the text again. The adapter uses the
pinned SDK's document embedding and conditional live-vector insert for just
the new rows. It never rewrites fact text or starts a whole-bank reindex.
The package's normal postinstall prepares `.upstream/worker-memory-sdk.mjs`
from the locked dependencies for stock CLIs that cannot import those helpers
directly. This does not build or replace OMP; a missing supported capability
does not switch the lane to a shared memory store.
Coordination receipts, text inserts and delayed vector writes all defer on
lock contention rather than blocking HEAD's event loop.
HEAD must have a persistent profile that remains safe on a normal bank reopen:
`mnemopi.noEmbeddings: true` for lexical-only use, or `models.offline: true`.
Immediate vector indexing requires an embedding provider already scoped and
authorized on the live HEAD bank. A local model name or cached weights alone
are not such a handle: text is searchable and the vector is reported as
deferred. The importer does not initialize an unscoped model, download one or
launch another CLI. A temporary offline or text-only override alone is not sufficient.

An online HEAD with embeddings enabled is **not** a destination, even if its
model name is local. The pinned stock [reopen repair](https://github.com/can1357/oh-my-pi/blob/b55cd1bb664d8ab46ddc77f2a34eb47555dbf1ac/packages/mnemopi/src/core/beam/store.ts)
embeds missing vectors and, on any stale model stamp, the whole bank. Other
native sessions can write stamps into the same project bank. The [embedding
resolver](https://github.com/can1357/oh-my-pi/blob/b55cd1bb664d8ab46ddc77f2a34eb47555dbf1ac/packages/mnemopi/src/core/embeddings.ts)
can use a process-wide provider before the named local model. Sync cannot bind
a future stock reopen to a provider per imported row. An enabled HTTP profile
is also ineligible; stock does not authorize redirect targets individually.
Changing the operator's durable policy later can change how native OMP uses
facts already stored.

No transferred text is submitted as a prompt, published to a messenger or
included in a sync diagnostic. Once stored, the destination's normal OMP
recall and compaction policies still apply to it as memory data. Anyone with
access to that native repository/profile can potentially recall those facts.
Only enable transfer for a trusted workspace. Secret-pattern checks reject
recognizable credentials; they cannot determine whether an arbitrary
natural-language fact is confidential.

### Management tools

The [head extension](../../src/extension.ts) restricts manager tools to
the managed root. Use live tool schemas for arguments and [head role
references](../../skills/head/SKILL.md) for operating policy.

| Tools | Authority and outcome |
| --- | --- |
| `lane_start` | Requires a durable user source, title, existing absolute cwd, exact model or native preset, model reason and kickoff. Accepts a bounded brief, acceptance criteria, and an authorized destination or workflow. At most one new lane per source. Returns the durable ID and admission state, not an execution or completion receipt. |
| `lane_message` | Explicit follow-up with a real authorized `sourceId` and the target lane. Deduplicate by source and lane; check destination, attachment/quote scope and identity compatibility. For a physical Discord work thread and a source from its exact guild parent, pin the HEAD-reviewed report route to that thread per handoff. This does not rebind the source or resume a paused lane. The same source may reach existing lanes only where those routes and reporting are authorized. |
| `lane_inspect` | Lists records without a live probe; inspecting a specific lane adds live status where observable, model readback, queue blockers and observed progress. Null actual state is unknown, not a match. |
| `lane_pause` | Takes a managed lane ID. Persists pause intent and requests an interrupt without claiming owned services or earlier effects are gone. |
| `lane_resume` | Takes a managed lane ID and an authorized original `sourceId`. May reopen a paused native goal after checking native state; never releases an uncertain submission or revives cancelled work. |
| `lane_close` | Records verified completion or cancellation. Not permission to merge, publish, deploy, spend, or delete a checkout. |
| `lane_models`, `lane_init_presets`, `lane_set_model` | Inspect native candidates, initialize missing presets, or explicitly change one idle lane; see [Models and presets](#models-and-presets). |
| `thread_inspect`, `lane_thread_update` and the `decision_*` tools | Use the [messaging and authority contract](messaging.md) for scope, original thread/approval identities and readback. |

Send only the original task, relevant evidence, constraints and acceptance
criteria to a lane; never copy the full head transcript. Controller-created
topics start with the exact observed head model, while explicit manager
handoffs use the model or preset selected at `lane_start`. Subsequent work
uses the topic's own saved model and session. Ordinary bound-topic work replies
in the operator's language through the controller outbox. Explicit manager
handoffs and their internal reports use English. No lane gains messenger
credentials. Distinguish dispatch acceptance, actual execution, native
settlement, verified acceptance criteria, and user delivery.

### Direct lane coordination

The [`lane_report` tool](../../src/lane-extension.ts) records observations in the
native journal. It hashes selected files in bounded chunks, verifying their identity
and metadata before accepting the digest, or hashes successful work tool results.
Tracked decisions and other coordination receipts are not work evidence. Duplicate
content and repeated waits do not refresh evidence timestamps; ordinary
commentary is not verification. Resolve only the exact tool/approval/job or
dependency wait. Direct-topic observations are inspectable and do not notify HEAD.
Changed manager-handoff evidence or wait transitions are queued for HEAD as
nonterminal observations. Queueing does not guarantee a new model turn or a
messenger message.
Lane observation reads request only the entries appended
after the source-bound journal cursor (`get_entries` with `since`). A missing
cursor fails the observation rather than replaying another request's history.
When only a starting position is needed, the managed owner waits for its queued
observations to be journaled and returns the native leaf ID, not the transcript.
Already-running owners without that capability keep using their stock response.
Ownership and outcome checks that need the full journal still read it. The
runtime exposes observation timestamps and `ownerCurrent`, not a guarantee
that a reported dependency is still live. Native children cannot use the
manager, report as the lane, or request tracked decisions.

A manager handoff returns its final result to HEAD for review. State a blocking
conflict in that result if no authorized work remains. If HEAD needs to choose
between in-scope options (for example, which lane owns a shared edit),
use [`decision_ask({to:"head", questions:[…]})`](messaging.md#approvals-and-owner-decisions)
even from a bound topic. It immediately queues one durable review of the same
pending native dialog. Omitting `to` keeps the default: a topic-owned question
goes directly to its authorized topic; a manager-handoff question goes to HEAD.
HEAD answers with an original option or escalates the same card on its original
route via `lane_review_decision`. Do not use a decision to change scope or
grant native approvals. A direct bound-topic owner instruction can revise
the assignment without a HEAD decision.
HEAD uses `lane_message` for a specific authorized follow-up; neither an
observation nor a decision supplies fresh dispatch authority. Do not poll or
schedule a model just to check for updates.

### Direct owner changes to bound-topic work

An authenticated owner's direct, explicit work instruction in a lane's own
bound topic supersedes conflicting task scope or acceptance in an earlier
HEAD brief. The lane applies the change inside its selected workspace when the
native session consumes the input, whether as a new ordinary prompt or as an
eligible steer. Apply only what the owner changed. A binding by itself does not
authorize work; quoted or forwarded content, attachments, historical excerpts,
child reports and sibling assignments do not acquire the owner's authority.
The original brief and acceptance remain available as prior context even if the
opening prompt never ran. They are not a veto over the owner's later instruction.

The [ordinary topic routing rules](messaging.md#topic-routing-and-controls)
still apply. Keep the original source, session and delivery identity; steering
does not change an existing manager handoff's reporting mode. There is no
separate HEAD approval, scope-review turn or replayed handoff. HEAD can still
coordinate shared edit ownership, dependencies and integration, and answer or
escalate a genuine tracked decision on its original route.
If a direct instruction joined a manager run, its decision keeps the opener's
card and destination. HEAD receives the question, not private steer text or a
claim that the original brief still represents current permission.

The instruction does not move the lane to another workspace or checkout,
take over sibling work, change operator settings, bypass tool restrictions or
native approvals, resume paused work, or clear an uncertain effect. It does
not undo completed work or authorize repeating a denied or uncertain action.
Old pending records from the retired review path are not a source of work or
permission and must not dispatch or replay on upgrade. This does not discard a
verified completed result still waiting for its first delivery on the original
route. An interrupted send is uncertain, not a reason to send again.

### Failed lane requests

Confirmed provider quota exhaustion is an operator decision, not a recovery
prompt. The controller sends one notice on the authorized reply route and holds
new prompts on that lane until the operator selects a model in its bound topic
with `/model --lane <provider/id>` or the current-lane option on Discord's
`/model` card. If the model-change acknowledgement is lost, selecting the same
provider and model on a fresh card in the original conversation can reconcile
the pending change against the original session. A cold lane's subsequent
native application does not replace the receipt for the operator's original
choice. This does not change HEAD or replay the failed request. A transient
HTTP 429 or model-capacity error alone is not evidence of
exhausted account quota.

Other native execution errors, including in topic-owned work, go to HEAD for
recovery. Before forwarding a lost-response report, the controller checks the
original attached session for an exact settled receipt. If HEAD was busy, it
checks again before forwarding; if a settlement state read fails, the next
wake retries the read, not the prompt. A verified result supersedes the obsolete
report, including an informational report from an older session without a
verified owner. Such a report cannot authorize corrective work. Neither a
missing ACK nor a detached client authorizes resubmission.
A failed run proven to have started no local or provider-executed tools can close
as failed and permit HEAD to select an eligible fallback and send a fresh,
scoped correction. Recovery authority comes from HEAD's active report, not a
source ID supplied in a tool call. Cancellation of the original request or a
newer operator model selection invalidates the report, even if the model was
changed back. A correction keeps the original approval route. If a dialog is
first seen after reconnect and cannot be tied to that request, it stays on the
native Host rather than appearing in the lane thread. Uncertain effects stay
fenced; the report does not authorize a replay or a move to another lane.

## Execution budget and Host lifecycle

[`maxHosts`, `maxSubagents`, and `idleMs`](../../src/config/config.ts) are explicit
operator inputs. `maxHosts` includes the head; the per-Host native child
concurrency budget is `floor(maxSubagents / maxHosts)`. This bounds configured
execution concurrency, not machine memory, CPU or provider spend. Lanes wait
durably when slots are full. Prioritize authorized follow-ups; approval and
stop controls remain reachable. A queued lane, a resident Host, an active turn
and an accepted work result are different states.

The separate [`headIdleMs` policy](../../DESIGN.md#idle-head-hibernation) can
unload HEAD when there are no resident lanes or controller obligations. It
does not reassign the HEAD slot to a lane. The Gateway retains admission,
not model or lane authority; waking resumes the same journal.

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
A read-only ownership snapshot may resample the full evidence for the same
root after native child registration and attachment invalidate successive
reads. After at most two resamples, another change leaves ownership
unverified. Root mismatches, other failures and maintenance drains do not retry.

The resident Rust owner speaks the stock JSONL/v2 protocol. Bun and the published SDK still
prepare and publish the native session under its exact profile. One short-lived
[SDK helper](../../src/host-sdk-helper.ts) per launch first reports the managed launch
composition from native discovery without creating or publishing a session; only after the launcher answers with
the manifest built from that composition does the same process prepare the session. A worker
persists its launch fence immediately before the manifest is sent, so a refusal or timeout
before then still releases the slot. Discovery and preparation have separate deadlines.
A descendant holding output open cannot extend those deadlines. The owner invokes short-lived
SDK helpers for operations that depend on stock semantics, including fitting a withdrawn
queue. The Gateway reads the [session header](../../native-journal/header.rs) itself.
After its child exits, the [Rust owner](../../host-owner/src/exit_receipt.rs) verifies
the journal and publishes the exit receipt without starting Bun or loading an SDK.
The [resident worker](../../src/omp/native-journal.ts) still reads a header in process.
Only the first physical line, with
surrounding whitespace trimmed, may be a title slot. Before the session header
only JSON whitespace is skipped, not a UTF-8 BOM. Identity lookup stops at the
header; it does not attest to the body. Exit verification checks the entire
journal and the owner's expected observations. A BOM before a JSON record is
invalid regardless of read boundaries; a U+FEFF inside a JSON string is data.
An incomplete or malformed journal is not proof of a settled exit.
On the private v2 interrupt channel,
queue restoration uses the SDK's reassembled-frame byte limit: this is the value of
[`maxResponseBytes` in OMP 19.0](https://github.com/can1357/oh-my-pi/blob/v19.0.0/packages/coding-agent/src/modes/rpc/rpc-frame.ts#L341-L347)
and [`maxIntactFrameBytes` in 19.1](https://github.com/can1357/oh-my-pi/blob/v19.1.0/packages/coding-agent/src/modes/rpc/rpc-frame.ts#L341-L347).
An intact queue must not be reported as truncated. No second Bun runtime stays resident per Host.
For SSH workers the enrolled forced command hands its stdio to the Rust relay.
Admission and Host attestation can use a short-lived helper; no Bun process
stays just to forward bytes. SSH EOF detaches only that connection.
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
[OMP 18 broker](../../src/omp/host-broker-services.ts) or [OMP 19 daemon](../../src/omp/host-services.ts)
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

The [guarded native writer](../../src/omp/native-settings.ts) rechecks the expected
configuration under the native lock, preserves unrelated settings, and reads
back the effective value. It does not overwrite stale values, higher-priority
disables or unsets, or unverified legacy/unknown settings. If enabled memory
cannot be verified, launch stays blocked. This preflight does not initialize
memory or verify live search. [Historical topic search](messaging.md#topic-routing-and-controls)
still specifically requires an active, searchable Mnemopi backend on the head.

### Native discovery and resume

[Native discovery](../../src/omp/native-sessions.ts) publishes symlinks to the
original journal and artifact directory in the active profile's native project
bucket. It does not copy transcripts, transfer a writer lease or wake unloaded
lanes. Use normal OMP discovery and `/resume`; native rules govern concurrent
writers and forks. An ordinary resume does not load managed role extensions or
attach to the running managed Host.

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

[`lane_models`](../../src/lane/lane-models.ts) derives the shortlist from native
availability and exact provider/model IDs. Model capabilities and prices are
catalogue fields, not measured quality, total cost or permission to spend.
The [model-selection skill](../../skills/head/references/model-selection.md)
normally consults native judge for a meaningful choice, with minimal safe task
and candidate facts; the head makes and records the decision. Report judge
unavailability or failure without inventing a receipt or switching providers.
Judge usage is native. Runtime enforces exact selection, availability and reason,
not a mandatory judge call.

At startup, [preset initialization](../../src/omp/native-presets.ts) inspects native
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
uncreated directories, and reconciles once after installing watchers. On macOS
the maintenance tick also checks file metadata to recover changes missed during
FSEvents registration. Unchanged files do not trigger a preset reload. Errors
and explicit `"deferred"` outcomes get bounded backoff retries. Deferred work
continues at a slow interval after those retries so late model availability
can apply without another config edit. Slow periodic polling also stays
active whenever any source is uncovered or a watcher errors. These labels
are preset names, not custom roles or tested performance/cost tiers.

Each lane records a resolved model, selection reason, and the complete native
role/thinking preset snapshot if a preset was selected. A later preset/global
change does not change that snapshot. Resume and reconnect check native
readback; unavailability or drift holds dispatch without silently selecting a
different model. A running lane may accept OMP's selected retry fallback
without changing its durable configured model. The current model must match
the newest flagged `model_change` on the active native journal branch, and the
uninterrupted flagged chain must start at the configured model. The controller
queries the attached native owner for the leaf and entries, including for
remote workers; it does not open worker paths. Exact catalog IDs take precedence
over native selector suffixes. An unflagged ephemeral switch, including context
promotion, does not authorize another model.

Warm recovery and cold resume may both return the Host to the original model.
Normal readback recognizes that model directly without relying on a reverse
journal entry. A newly restored Host must confirm the configured model and
record its active journal cursor before using retry evidence. Only a flagged
row after that cursor on the active branch can authorize a fallback, even
across reconnects. A current owner/generation receipt and a notice, written
together, prevent the same row from re-authorizing drift after recovery or
owner replacement. The notice reports which model is selected, not which model
generated an answer. Frozen preset lanes remain excluded. An authorized
`lane_set_model` can change one eligible idle lane with durable intent and
returns that change's own readback. The managed Host fences ordinary lane
model switches as maintenance and rechecks native activity before invoking
the setter; a menu click cannot use an earlier idle observation to switch a
lane that has since started work. If the selected model is already running as a
temporary fallback, its presence in `get_state` is not proof that it will be
restored as the lane's selected model. `config.model` is a head launch default,
not the lane default or a reason to overwrite a saved head's model on restart.
Managed Hosts use private settings overlays, with native session-scope
readback. Legacy lanes without a recorded selection adopt their authoritative
native model rather than assuming the current head default; only an unstarted
lane with no journal can adopt that default. Do not recreate a missing journal
to recover a recorded session.
This preserves existing native provider fallback and retry policy; it is not a
guarantee about every lower-level provider request.

Direct `/model <provider/id>` and `/effort` target the shared head even in a
lane topic. Discord's `/model` card and the explicit `/model --lane` command
can instead target the lane bound to that conversation.
Read-only queries can run while busy; mutations require native idle and session
scope, record intent and report the actual applied model/effort. A current
owner's explicit natural-language request can use `head_set_model` after its
successful turn settles. An ambiguous mutation is not retried. Only explicit
`/model preset <name> --global` saves the verified settings snapshot as global
default roles/thinking; ordinary head and lane changes leave global configuration
and other lanes alone. Native preset bootstrap/refresh and native auth updates
have separate scopes.

`/fast` displays the current mode and opens a menu on shared HEAD, even while
busy. A change requires Confirm on the original sent card and the same HEAD
session, generation, model and selected mode shown as current when it opened.
HEAD must be idle to change the active model family's tier; the owner serializes it as
maintenance, and the extension uses native `AgentSession` fast/ultrafast
controls and flushes the native journal. These APIs were checked in the
[pinned OMP SDK](../../DESIGN.md#stock-omp-and-verification-scope). No lane, global default
or provider request is involved. Readback distinguishes the selected mode
from whether OMP can use a fast tier for the current model, not whether a
provider accepted it. Uncertain mutations are held, not replayed.

Argumentless `/model` and `/effort` use the same read-only native catalogue and
effort capabilities to construct menus. A selection is a new owner control on
the original topic, not a model turn or native approval. The head validates
the menu's session and generation before applying it, and an effort selection
also requires the model for which the options were shown.

## Owner-facing reply voice

[SOUL](../../src/omp/soul.ts) is an instance-wide presentation preference, not a
role, workflow, or OMP profile. The default and the one saved override use
bounded choices for presentational concept (plain, editorial, or mentoring),
tone, register, detail, answer order, and emoji. The HEAD
contract still defines its identity. The `soul_update` native tool checks the
current root HEAD session and a fresh, explicit original owner request. The
controller derives the supported combination from that exact message, not from
model-supplied fields. A plain request already addressed to HEAD does not need
a command or a SOUL keyword. Questions, one-off requests, quotes, edits,
derived input, and restricted-group messages cannot authorize a change. The
instance ledger owns the revision and readback. Choosing a concept does not
change any other setting by implication or establish a new role.

The controller supplies the current voice on new, eligible owner-facing
HEAD turns (including synthesis from a normal lane report) and on direct
topic-reply lane turns. It uses the admitted run's delivery scope, not message
content or the current channel. A steer inherits the opening run's scope:
joining an active manager handoff does not give the lane the reply voice.
The private owned Host takes only the closed voice profile and renders a
root-only, temporary system block. An opaque admission token is removed at
the stock input boundary; neither token nor style enters the user history,
lane brief, or global `PERSONALITY.md`. Native task children, internal control prompts,
structured replies, and code-generated notices do not use it. Settings apply
to the next eligible run on a capable resident Host, without reloading its
session or changing SUPER activation. Hosts advertising reply voice v2 also
receive the concept; v1 Hosts continue receiving the original style fields
without the concept. Hosts with no capability continue unstyled.

The prompt boundary was compared with [Cataly `d2cb7078`](https://github.com/vntrevx/Cataly/blob/d2cb7078033ccab27895515d4c566fe7ed4078de/extension/index.ts#L1274-L1295),
[OpenClaw `6978b40e`](https://github.com/openclaw/openclaw/blob/6978b40e9d3812083064c97e24de00454d6bf868/docs/concepts/system-prompt.md#L166-L185),
[Hermes `242315ce`](https://github.com/NousResearch/hermes-agent/blob/242315ce571cde721e717a544cf8ae6c343315cf/agent/system_prompt.py#L547-L553),
and [Dori `3b5487df`](https://github.com/vntrevx/omp-dori/blob/3b5487df12540cdd428ebcf7455375d72921e2dc/skills/dori-mode/SKILL.md#L65-L74).
These are design references, not prompt or code reuse. The stock OMP extension
and RPC contract was inspected at [v19.1.1](https://github.com/can1357/oh-my-pi/commit/31ffee513f27a01bba7d4dfbe12bae239cdc646a);
the installed Host advertises the optional bridge rather than inferring it
from a CLI version.

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

[Workflow dispatch](../../src/lane/workflow.ts) binds each choice to the original
source and an explicit `workflow: {name, reason}` on every workflow-selecting
`lane_start` or `lane_message`, even when forwarding a user selection. A brief
or report is not the selection field. Preserve the original text and native
keyword interpretation; keep generated metadata fenced. Selection is
serialized, not injected as steering. A conflict or missing advertised
capability does not silently downgrade a selected SUPER request to ordinary work.

HEAD supports native Superstack as a separate branch-local mode, based on
[omp-superkit `12d19ec96eb44e87acec9492269cbe638392cbef`](https://github.com/dbc-hbin/omp-superkit/tree/12d19ec96eb44e87acec9492269cbe638392cbef).
For an original owner request routed to HEAD, a leading `/superstack` or
`superstack` is pinned at admission before checking the native Host's command
advertisement at dispatch. Discord's physically written text must corroborate
the selector. Telegram must corroborate it independently of the arguments,
which may contain protected formatting. Redaction cannot turn a task into a
toggle. Existing receipts without a selection stay ordinary across replay.
It is not a messenger control, a lane `workflow` value, or a native goal.
The native task prefix is followed immediately by the original route envelope,
so later task prose cannot establish background job ownership. A pending
selection fences later HEAD prompts and steers. Bare enable and exact `off`
wait for full native idle and carry no task or envelope. A matching native
no-model receipt and current-branch journal state confirm the toggle; verified
non-application cancels, and unavailable evidence holds later work without
replay. Native flags still govern whether the policy is applied; edits, quoted
text and reports do not select it. An older Host without the command holds the
explicit request instead of running it as ordinary work.

SUPER's commands and defaults are based on
[omp-superkit `c11a6e4e185f9c31f484a05a13528ef724337bc1`](https://github.com/dbc-hbin/omp-superkit/tree/c11a6e4e185f9c31f484a05a13528ef724337bc1).
[Revision `e8825367bed06985ccb1ee1e635dce850e22bbb9`](https://github.com/dbc-hbin/omp-superkit/tree/e8825367bed06985ccb1ee1e635dce850e22bbb9)
moved the workflow instructions into canonical skills and retained the original IDs as aliases.
Use a leading invocation; the `/` is optional in request text. These are OMP
extension commands, not registered messenger controls.

| OMP command | `workflow.name` | Canonical OMP skill | Legacy skill | Default native keyword |
| --- | --- | --- | --- | --- |
| `/super` | `super` | `skill://super` | `skill://ultrawork` | None |
| `/super-plan` | `super-plan` | `skill://super-plan` | `skill://ulw-plan` | `ultrathink` |
| `/super-run` | `super-run` | `skill://super-run` | `skill://ulw-execute` | `orchestrate` |
| `/super-loop` | `super-loop` | `skill://super-loop` | `skill://ulw-loop` | `orchestrate` |
| `/super-research` | `super-research` | `skill://super-research` | `skill://ulw-research` | `workflowz` |
| `/super-graph` | `super-graph` | `skill://super-graph` | `skill://mass-ulw` | `workflowz` |

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

[Preparation](../../scripts/prepare-super.ts) runs during `postinstall` or
`bun run prepare:ulw`, even if OMP is not installed. The
[declared remote](../../upstream/super.json) is the official `omp-superkit`
repository. [Managed installation](../../src/omp/managed-super.ts) and duplicate
detection recognize both `omp-superkit` and the legacy `omp-ulw` package ID.

Stage the observed revision and its dependencies in a project-owned immutable
package. Ignore arbitrary dependency lifecycle scripts; run defined
materialization and an [offline native prompt-composition probe](../../src/managed-super-probe.ts)
for ordinary and explicitly activated operation. For the canonical layout the probe
checks that the hook uses the canonical directive and pointer paths and that native
discovery resolves both canonical skills and legacy aliases. An older revision
uses the full legacy skills instead. Serialize preparation via
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

- [Cron jobs](../../src/cron/cron-jobs.ts) run through the head's existing maintenance
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
  head outbox. Direct shell schedules are disabled: an authenticated route and
  scrubbed credentials are not a runtime capability boundary. Legacy shell
  jobs remain inspectable and removable; pending runs are cancelled rather
  than forwarded to a model, and queued shell output is not sent. Verify any
  previously started legacy run on its original host before resolving it.
  See the [operator reference](../OPERATIONS.en.md#scheduled-jobs-cron) for syntax and controls.
- [Repository PR intake](../../src/cron/cron-pr-intake.ts) is a typed cron job, not
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
  [Review control](../../src/pr/pr-intake-review.ts) binds subsequent actions to
  that lane, route, enrollment epoch, review input, delivered answer and SHA.
  Static review uses a trusted workspace without a contributor checkout. Unlike
  ordinary coding lanes, this restricted local Host must attest a tool-less
  session on a supported native provider before the controller submits patch
  data. The stock launch explicitly selects an empty built-in tool list
  (`--tools=`) and loads only the trusted lifecycle extension. Activation then
  checks the native tool sets before admission. No manager, coordination,
  shell or editing tools are available. Fix
  proposals and merge verdicts are data, not standing write authority. Each
  effect checks the enrolled repository, original route and policy revision;
  higher stages require an explicit policy or a fresh SHA-bound owner command.
  An uncertain write permits read-only reconciliation, not resubmission. See [operator commands
  and supported GitHub protections](../OPERATIONS.en.md#reviewing-new-external-prs-cron-pr-add).
- [PR watch](../../src/pr/pr-watch.ts) reads only explicitly registered GitHub PRs
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
