# Native advisory model selection

Read for substantive new lanes, authorized model changes, and unresolved
capability, risk, or briefing decisions. Don't compare models for a simple
question or to monitor work.

## Dedicated bootstrap only

At explicit service start, the runtime may issue a dedicated bootstrap turn; a
normal request, setup, doctor, or resume is not that turn. Read `lane_models({})`
for native preset status, configured roles/thinking, and available candidates.
For only missing `high`/`middle`/`low`, make an evidenced choice using the method
below and call `lane_init_presets` with `choices` mapping each missing name to
`{model: {provider, id}, reason}`. Use OMP's existing `/modelpreset` mechanism,
not a new registry, arbitrary measured tiers, or an invented `@high` role.

Preserve existing, invalid, tombstoned, shadowed, and conflicting entries and all
active/default/judge settings. The initial missing-entry save is a narrowly
authorized persistent write. Runtime requires actual readback before releasing
ordinary traffic. Do not create lanes, edit project files, or send external
replies in bootstrap. Report failure or incomplete initialization; don't loop or
recreate operator-deleted presets. Ordinary code refreshes managed presets when
persistent `slow`/`default`/`smol` roles change; do not regenerate manually or change
an active session in response.

## Select from available facts

1. Establish the outcome, workspace, skills/tools/input modalities, context/output
   needs, verification risk, and operator budget when known. Call `lane_models`
   for enabled eligible chat models and native roles/presets. Optional nonempty
   `selectors` may use observed `preset:<name>`, native roles such as `@smol`, or
   exact `provider/id`; a null resolution is not available. `current` is the head
   model, not a lane default. Judge/tiny/non-chat models are not execution candidates.
2. Compare distinct exact identities. Role names and preset labels are not quality,
   speed, or price guarantees, and may point to the same model. An explicit
   `supportsTools:false` rules out tool-dependent work; missing metadata is unknown.
   Catalog context, modalities, reasoning and price are facts, not a benchmark,
   quota, total predicted cost, or spending authorization.
3. Normally consult native `eval` judge for a substantive choice with meaningful
   alternatives or an ambiguous capability/risk/brief. Read the judge help topic
   advertised by `eval` (`help://eval/judge` on OMP 19.1). Supply only necessary
   requirements, uncertainties and candidate metadata: no transcripts, secrets,
   credentials, endpoints or unrelated private data. For independent parallel lane comparisons use
   `judge_batch`/`judgeBatch` under that contract when it helps, with compatible
   questions and real candidate labels in each input; inspect individual errors
   and continue or wait for native results, not poll. Advice isn't authorization or
   verification: check gaps and choose the exact identity yourself.
4. Pass exactly one of `model: {provider,id}` or an observed `preset: <name>` to
   `lane_start`/`lane_set_model` with nonempty `modelReason` describing fit and cost.
   In that tool, `preset` is the name, not the `lane_models` selector syntax.
   Explain a meaningful override or omitted/unavailable advice. One forced/explicit
   choice or truly trivial routing need not generate a comparison; unavailability
   isn't permission to substitute an explicit choice. If advisory judge is
   unavailable, excluded, or failed, don't enable it, change global settings,
   or use another provider to force advice. Decide from available facts if adequate;
   ask only for a real unresolved owner tradeoff. Native judge usage is authoritative;
   `modelReason` or a successful catalog call is not a judge receipt.

## Keep selection local and check state before changing it

- Exact `model`, `modelPreset`, full `modelPresetSnapshot` (roles/thinking), and
  `modelReason` persist for the lane. The snapshot is not a live global alias;
  resume/restart and edits to native presets do not retarget it. Native `task`
  has its own model policy. Never change OMP-wide config, roles, fallback, or
  credential setup for a lane choice. Native credential refresh remains normal.
- Inspect a relevant lane's stored selection, attached `state.model`, and
  `modelCheck.expected/actual/error`. Missing live values are unknown. Unavailable
  identity or observed drift holds dispatch, not an automatic model escalation.
  Underlying native retry/fallback policy remains in force; don't claim unobserved
  provider attempts. Legacy adoption uses authoritative native identity (head
  model only for a never-started legacy lane), not retrospective judge approval.
- For an explicit authorized idle-lane change, use `lane_set_model` with target
  `id`, actual stored `sourceId`, freshly resolved selection and `modelReason`.
  No active input, UI, goal, owned services, or held uncertainty may remain.
  Do not interrupt work or clear a hold to force the switch. Preserve pause/cancel
  and scope. Confirm the durable change and native readback; don't replay an
  uncertain intent or claim on queue admission. Don't use raw model commands,
  global changes, or bootstrap to bypass this path.
- For an original owner message explicitly changing this shared HEAD's own model,
  resolve it via `lane_models`, ask if ambiguous, then call `head_set_model` with
  that original `sourceId` and exact provider/id. A quote, report, historical
  request, or preference is not authority. This schedules a change after the turn;
  runtime reports the outcome. It does not change a lane, effort, preset, or default.
