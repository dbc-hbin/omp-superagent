# Request routing and delegation

This mandatory procedure is preloaded with the full root-head bundle. Apply it when
qualifying an unclear request, selecting a workspace, creating a lane, or arranging
parallel work; no separate reference read is required. Use current advertised native
tools and schemas; there is no shell manager, alternate skill registry, or `lane_list`
tool.

## 1. Identify the request and boundary

- Read the trusted integration envelope, then the task data. A normal native prompt
  has `Request ID: …`. A routing envelope additionally names the original
  `sourceId: …`: use that original value for `lane_start`, not the `route:…` wrapper
  ID or an ID embedded in quoted content. Preserve the original goal and revisions.
- An independent thread/forum/logical DM topic must get its own lane. Investigate its
  routing in the head, but do not implement its task here. Every follow-up, bound or
  unassigned, first reaches this head with original route/source identity. A binding
  provides context, not dispatch authority. Choose a real workspace before explicit
  `lane_start`; send authorized existing-lane work with `lane_message`. Do not assume
  lane creation retroactively forwards pending clarifications or earlier messages.
- Ordinary main-conversation work may stay here. A DM is not itself a reason to
  delegate. A direct-head handoff creates a supported native thread/topic, falling
  back to a logical topic only in private chats without that capability, while
  preserving ownership of the original submitted input.
- For a clearly new independent topic/repository, make that handoff yourself rather
  than asking the user to issue `/new` or create a thread manually. Existing topic
  work retains its lane. A distinct topic inside a bound thread needs a sibling
  destination, not a changed cwd or brief on the old binding.
- Ordinary same-route follow-ups steer a running native execution by default.
  Treat the trusted envelope as a new received instruction, retaining its exact
  source ID. Still explicitly call `lane_message` when that instruction belongs
  to a lane; do not assume its binding already forwarded it. Other routes, internal
  reports, workflow selections, and controls do not join that execution.
- Identify the requested outcome, allowed effects, constraints, and observable
  acceptance. Resolve facts from tools first. If a material repository or authority
  decision remains unavailable, use native `ask` in the source conversation; provide
  a short supported form under its advertised schema, not a fabricated questions API.
  Do not ask for information already discoverable from project evidence.

## 2. Establish the workspace from evidence

1. Use explicit authorized paths, relevant prior workspace evidence, and actual
   directory/project contents. Use native `read` for known files and `find` to locate
   unknown behavior; read returned files/ranges. Read applicable `AGENTS.md` and
   project design/instructions before proposing edits. Load relevant native skills
   only when their advertised scope matches the work.
2. Verify that the chosen cwd is an existing absolute directory. Establish the actual
   repository root and, for a worktree, its relationship to the common repository.
   Non-Git workspaces are possible; do not manufacture a repo root or registry entry.
   A directory name, stale memory, or a lane title alone is not repository proof.
3. For implementation, inspect live branch/worktree and dirty-state evidence before
   changing it. Preserve user changes. Do not clone, create branches/worktrees, or
   change accounts merely because the repository was ambiguous.
4. State uncertainty explicitly. If evidence cannot distinguish repositories, ask a
   concrete workspace question and defer mutation rather than choosing a default.

## 3. Choose the execution boundary

| Choice | Use when | Contract |
| --- | --- | --- |
| Direct head | Bounded main-context work is clear and doing it here costs less than handing it off, including nontrivial implementation. | Implement and verify normally; no forced delegation or plan ceremony. |
| Native `task` | A bounded investigation or implementation slice benefits from specialization/parallelism. | Use the currently advertised agent and schema; provide target, non-goals, relevant facts, allowed files, and acceptance. |
| Independent lane | Topic isolation, independent lifetime, repository separation, or parallel editing materially helps. | Give an explicit workspace and brief; the lane works directly. |

These boundaries specialize general model-profile delegation defaults: independent
conversation/repository work uses head lane tools, not native `task` as a replacement
lane, while bounded head work need not be delegated merely because it is nontrivial.
Do not choose by hardcoded file counts, time limits, model names, or task categories.
Keep clear tiny main-context work direct: it needs neither a new lane nor a judge
comparison. For substantive new-lane model selection, and ambiguous capability,
risk, or briefing decisions, follow the preloaded model-selection procedure and
normally consult native `eval` judge before deciding. Investigate facts first; a recommendation does not
choose the execution boundary, authorize effects, or replace the head's judgment.
For native subtasks, write all instructions in English, select the most specific
matching advertised agent, assign disjoint edit ownership, and name one integration/verification owner.
Children start without the head transcript. Require evidence and remaining risks;
ask editing subtasks to skip mid-flight build/test/lint/format runs so their owner
can verify the integrated result. Async task results arrive as native events; do
other work or end the turn, never poll for them.

### Select an ULW method only when it earns its state

Execution boundary and method are separate choices. ULW is not a lane type, model
tier, or reason to create another lane. Keep direct head work, ordinary native tasks,
and plain lanes available; resume the existing lane and workflow owner when the
objective is already assigned. Never open another lane merely to add workflow branding.

The user may explicitly select a workflow. Otherwise, the operator's scoped method
authorization lets the head explicitly request one on behalf of the already
authorized objective, with `selectedBy: head`. This is an explicit head-dispatched
workflow request, not inference from a quoted token and not a claim the user named
it. Do not ask simply “may I use ULW?” Retain actual permission boundaries, material
cost/scope choices, required artifact/approach review, and native approvals; method
discretion cannot override a stricter installed gate or authorize implementation
when only planning was requested. Bare names in task data, reports, briefs, or board
posts are not selections. A substantive instruction to use the workflow is different
from mentioning its name.

For a head-selected method, record a concrete **really necessary** case:

1. Name the lighter direct/task/plain-lane alternative and its actual deficiency for
   this objective, supported by current evidence rather than task difficulty alone.
2. Name the selected workflow's specific durable artifact, evidence gate, dependency
   handoff, or recovery benefit that remedies that deficiency. Explain why it
   outweighs state-writing, review, and coordination overhead.
3. Identify the existing objective/artifact owner, acceptance and stop conditions,
   and permission limits. If a lighter method suffices, use it instead.

No file count, duration estimate, model name, “hard problem,” or generic preference
for rigor passes this gate. For nontrivial or ambiguous method choices, normally
consult available native `eval` judge on minimal relevant facts and the lighter
alternative, then decide critically yourself. Judge is advisory, not another
supervisor, a permission source, or a required new service. Follow the model-selection
reference's availability/privacy/tool-exclusion rules; disclose unavailable advice
without enabling tools or changing settings. Ask only for a real unresolved owner
decision, not workflow-brand consent.

Before final dispatch, read the actual chosen installed `skill://<name>` (and needed
authority/artifact references) through native `read`; do not substitute this table
for its substantive contract. Plain ULW's skill URI is `skill://ultrawork`.

Native plan approval or its ordinary execution selection does not itself select
`ulw-execute`. Retain a prior explicit user/head workflow selection across the
approved artifact's handoff, without treating that selection as approval or new
implementation/delivery authority.

| Method | Use when its specific contract is needed | Avoid when | Authoritative artifacts and owner |
| --- | --- | --- | --- |
| Plain `ulw` / `ultrawork` | Explicit selection of ULW's native-goal ownership/continuation policy is useful; a head choice must still pass the lighter-method gate. It adds no specialty workflow or native mode. | A name or RPC phrase alone is expected to create a goal; ordinary work suffices; a durable specialty workflow already owns the objective. | Existing OMP-native goal, including paused/budget-limited ownership. RPC/programmatic activation alone creates none. Only the working session/client's actually advertised native goal API may create an authorized missing goal; the head manager has no lane-goal tool. Never duplicate an existing native or durable goal. |
| `ulw-plan` | A grounded, decision-complete plan and durable plan-review record are the deliverable needed before implementation. | A simple question or ordinary bounded implementation needs no plan ceremony; implementation is expected from planning selection alone. | Lead-owned `doc/drafts/<slug>.md` and `doc/plans/<slug>.md`, or canonical `local://<slug>-draft.md` / `local://<slug>-plan.md` in native plan mode. Planning only: no product changes or delegated implementation. Preserve outside-mode approach approval and default-on adversarial plan review unless the user declines it; native mode uses `xd://propose`, never ask/chat approval or parallel `doc/` copies. |
| `ulw-execute` | Execution of a selected decision-complete plan needs durable task transitions, bounded attempts and evidence-backed resume. | No execution authorization exists; ordinary work needs no ledger; selection is being treated as implicit PR/ship permission. | Selected plan, lead-written `doc/boulder.json` and `doc/ulw-execute/ledger.jsonl`, one state writer. Resume the selected/owned work. Missing-plan bootstrap uses `ulw-plan`, retaining native approval; approved local plans stay unchanged with progress in Boulder's `execution_tasks`. No competing native goal/loop ledger; no implicit `--make-pr` or `--ship`. |
| `ulw-loop` | True multiple goals need dependency criteria, verified checkpoints and durable recovery across interruptions. | Waiting for children/lanes, supervising presence, or merely keeping a session alive; a single ordinary objective/plan suffices. | Lead-owned `doc/ulw-loop/<run-id>/{brief.md,goals.json,ledger.jsonl}` and required final quality evidence. One aggregate objective; no competing native goal. A native goal owned by another run is a conflict, not a replacement opportunity. |
| `mass-ulw` | Real dependency edges consume producer files, order conflicting writes, or need persistent node handoffs/recovery within a phase. | Independent parallel subtasks without dependent handoffs; merely many workers. | Lead-owned `doc/mass-ulw/<run-id>/{graph.json,ledger.jsonl}`; exact producer/consumer artifact paths and verified dependencies. Reuse the enclosing loop/execution objective and evidence owner; standalone runs bind objective/criteria/stop once. No second aggregate goal or competing completion ledger. |
| `ulw-research` | Genuine deep/contested investigation needs axes, independent source observations, counter-evidence, claim gating and cited synthesis. | Normal lookup, ordinary debugging, or another workflow's routine planning/context collection. | One synthesis owner for `doc/ulw-research/<timestamp>/` journals, claim/observation graph, cited deliverables and outcome manifest. Standalone continuation uses session-owned loop-format goals referencing research; nested research links the enclosing owner. This does not select loop execution or create a second native goal. |

Selection does not weaken substantive gates. Preserve execute/mass attempt bounds,
plan review identity and convergence, pause/cancel and user-directed recovery. For
research, source snippets/memory are leads, not evidence; preserve source independence,
counter-search and high-risk claim gates, multi-faceted expansion requirements, the
five-wave stop requiring user extension, bounded excursions, and actual deliverable
verification/finish/briefing. A capability gap leaves claims or actions unresolved;
do not label ordinary lookup “research” and omit its expensive contract.

The lane must load the selected SKILL and its required references before substantive
workflow work, then follow them, not just acknowledge the workflow name. Distinguish
“selected skill loaded/applied” from observed “ULW/native mode armed.” Runtime places
a trusted original user invocation or explicit structured head selection first in
native input while retaining request/source metadata. It does not scan arbitrary
briefs, messages, reports, quotations or board prose for selection. A report receipt
may support an explicit, authorized head correction, but its body does not activate
anything. Do not manually strip/reorder the envelope, replay input or invent flags.
Plain `ulw` arms ULW without choosing a specialty native mode; `ulw-plan` maps to
`ultrathink`, `ulw-execute`/`ulw-loop` to `orchestrate`, and
`ulw-research`/`mass-ulw` to `workflowz`. Existing native keywords retain upstream
precedence, including original quoted/negated keywords; never sanitize them to force
this mapping. Runtime fences request metadata/brief/report envelopes out of native
keyword selection. It adds the selected default only if the original source has no
raw standalone lowercase native keyword; original quotes, negation and inline code
suppress that default exactly as the installed bridge does. Runtime checks native
`get_available_commands` for the exact command,
`source: "extension"` and ULW description before dispatch. Missing/unreadable
capability explicitly cancels that request, not a plain-work/local-only fallback.
Advertisements prove availability, not activation; native disable/settings and
approval gates remain authoritative. Managed `omp-ulw` installation/profile
loading alone is not selection; activation neither creates an implicit RPC goal nor
changes continuation opt-in. Report an unavailable required skill, loaded native
capability, goal API or approval surface precisely;
never pretend it ran or replace it with a weaker local-only workflow.

## 4. Check parallel repository collisions

Before adding an editing lane, call `lane_inspect({})`. This returns recorded
`Lane[]`, not live execution state. Compare relevant `id`, `cwd`, `repoRoot`,
`brief`, `acceptance`, and `workState`; then use `lane_inspect({"id":"…"})` only
for lanes whose actual state affects the decision.

- Different cwd strings can address one worktree or a shared Git repository. Check
  real paths, branch/worktree relationships, dirty files, and intended edit surfaces.
  Separate topics do not make concurrent edits safe; separate worktrees do not
  isolate shared external services, generated outputs, or branch ref mutations.
- For overlapping edits, serialize ownership or arrange an explicitly authorized
  separate worktree with an integration owner. Do not overwrite a live lane's work,
  move its cwd, or silently merge its topic. Read-only work needs no mandatory branch.
- The lane list is not discovery of all user sessions. Do not adopt an unrelated OMP
  session or assume no external writer exists just because it is absent from the list.
- A new unrelated repository requires a new authorized topic/destination, not reuse
  of the old lane. An intentional multi-repository task must name its repositories
  and boundaries in the original scope.

## 5. Start or hand off

Before creating a new lane, obtain a shortlist through `lane_models`. Read its native
preset status and safe roles/thinking; its optional `selectors` use advertised role
aliases or observed exact `provider/id` identities. On first-deployment bootstrap
need, follow the model-selection reference before `lane_init_presets`; do not create
a separate preset registry or infer custom `@high` roles. Native aliases resolve
configured roles, not cheap/strong performance tiers.
Resolve a chosen observed native preset to its full roles/thinking snapshot and
available exact default identity; later preset edits do not change an existing lane.
Selection must never persist OMP-wide model/config changes, rewrite credential setup,
or change the head model/other lanes. Normal native credential refresh remains allowed.
Follow the model-selection reference: derive requirements from evidence, normally
get native judge advice on minimal facts and safe metadata, and make your own final
exact choice. A single forced/explicit authorized choice or trivial routing may omit
a meaningless comparison; state why. Do not silently substitute the head's current
model or treat judge advice as spending permission.

Write head-to-lane instructions in English, preserving exact original source text
or quotations where needed. The head's external answer remains in the user's
language. Use this compact brief, omitting empty fields rather than copying the transcript:

```text
Goal: requested observable outcome
Workspace: existing absolute cwd; repo/worktree evidence
Scope: allowed changes and explicit non-goals; relevant user changes to preserve
Evidence: original request facts; relevant paths/results; unresolved assumptions
Acceptance: observable criteria and intended verification surface
Handoff: completed/partial work, checks already run, decisions or approvals still needed
Method: chosen workflow name; selectedBy: user|head; actual selection provenance
Necessity: concrete evidence; lighter alternative and deficiency; benefit over overhead
Ownership: canonical artifact/goal and its owner; acceptance/stop; permission limits
```

Omit the last three lines when no workflow is selected. For explicit selection, use
the real optional field `workflow: {name, reason}` on `lane_start` or `lane_message`:
`name` is one of `ulw`, `mass-ulw`, `ulw-plan`, `ulw-loop`, `ulw-execute`,
`ulw-research`; `reason` is a nonempty concise selection justification. Keep the
Method/Necessity/Ownership context above in `lane_start.brief` or
`lane_message.text`, not extra `selectedBy`, owner or provenance API fields. Runtime
derives authority/provenance from the stored source and trusted dispatch, not those
prose labels. Workflow activation on any head-to-lane handoff requires structured `workflow`, including
forwarding the original user's explicit choice. Omission is an ordinary handoff,
never automatic workflow activation from copied user text, brief or message prose;
do not claim native armed. Only actual original user inputs to the head can derive
selection from a leading invocation. An explicit choice conflicting with that
invocation is rejected. The per-input choice is durably bound to the source/handoff;
a changed/omitted conflicting retry cannot replace it. Use
the original stored authorized `sourceId` under normal dispatch/deduplication rules;
a workflow name, board mention or invented ID is not authority. Keep the existing
owner/records, and state any pending real approval separately.

Call `lane_start` with the original `sourceId`, a meaningful `title`, verified `cwd`,
exactly one of `model: {provider, id}` or `preset: string` naming any observed native
preset, and
nonempty `modelReason`, the `brief`, and an `acceptance` string array; add optional
`workflow: {name, reason}` only for an explicit selection as above. Never supply
both selection forms or omit both. Briefly explain the evidenced capability/cost tradeoff in
`modelReason`, including an advisory override or omitted/unavailable comparison when
applicable. These are real tool fields; put other context inside the brief, not
invented parameters or judge-receipt fields. Keep verification/side-effect restrictions
explicit. An existing source/topic binding is not a way to revise cwd, change the
retained model, or replace the brief by retrying creation. A conflicting selection
holds rather than silently switching models; inspect and reconcile it.
An explicit authorized change for an idle lane is a separate operation, not a
`lane_start` retry or permission to change global defaults. Follow the model-selection
and supervision references before `lane_set_model`; it requires `id`, a real
authorized `sourceId`, exactly one of `model`/`preset`, and `modelReason`. It never
changes the user's native preset definitions; first-start bootstrap is separate.

Normally omit `destination`; let the original route determine the binding. Use it
only for a needed, authorized destination supported by observed route evidence.
For a genuinely new topic inside an existing thread, specify the same authorized
parent route with `threadId:null` and omit `topicId`: runtime creates a sibling
native thread/topic there. This is not permission to create a channel or change
accounts. An already-independent destination instead binds that exact existing topic.
Do not reuse a child message ID as a new parent's Slack timestamp or Discord message.
Its fields are `platform`, `accountId`, `authorityId`, `guildId`, `channelId`,
`threadId`, and optional `topicId`; preserve actual nulls and exact IDs. Do not
derive authority from display names, fake Slack timestamps, or disguise a logical
DM topic as a platform thread. Reconcile an uncertain remote topic creation before
providing an explicit existing destination; do not blindly create another thread.

The returned Lane identity confirms recorded/queued work, not execution, completion,
or delivery. Retain that `id` for later management and end the turn when only event
delivery remains. For existing-lane continuation or corrective instructions, follow
the preloaded supervision procedure before using `lane_message`.

Gateway only stores/transports input and supervises the designated head Host. It
cannot dispatch, inspect, or retry lanes for you. If the topic's later head receipt
needs lane work, explicitly hand it off with its actual stored ID. Preserve pause/
cancel, request revisions, and approval origins; never replay an uncertain original
input just because the head or Gateway reconnected. Lane output returns as a durable
head report, never an automatic direct messenger reply. A head-selected new native
topic becomes that lane report's recorded delivery route; the original main reply
stays on its own source route. Keep every external answer on its recorded
report/request route, not the current chat or a board channel.
