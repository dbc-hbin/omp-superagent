## Problem

A HEAD request whose model turn is refused by the provider, or fails with a
provider error before any tool runs, was settled as `uncertain`. In
`finishOnce` every HEAD outcome other than `completed`/`aborted` became
`uncertain`, so the durable HEAD queue held every later HEAD input until the
operator ran `/resolve`. Same-HEAD recovery could not release it either:
`headRecoveryEvidence` only yields an `outcome` for `completed`/`aborted`
receipts, and the only tool-free release rule was the Codex quota rule.

Observed in a running instance (identifiers redacted):

- The native journal for the failed run contained only `rpc_agent_start`, the
  user prompt, a `provider_refusal` custom entry (Anthropic `stopType: refusal`)
  and an `rpc_prompt_result` with `status: "error"`, `sessionSettled: true`,
  `agentInvoked: true`. No `tool_execution_start`, no tool result, no assistant
  tool call, and no external effect.
- The input was settled `uncertain` with the notice "the run failed; not
  treated as completed". The notice did not say that later HEAD work was now
  blocked or how to release it.
- Five later owner messages stayed `pending` for about seven hours. A gateway
  restart did not help: the input's generation matched the HEAD generation
  (both `0`), so it was a reconciliation candidate, but no evidence rule
  applied to a non-quota `error` receipt.

## Changes

- `src/head-recovery.ts`: the tool-free part of the Codex quota proof is now a
  general `toolFreeFailure` flag on the evidence. It requires a settled
  `error` receipt for the exact request, run ordinal, host PID, instance key,
  session and file. The slice may contain only that single prompt, assistant
  `error` messages without `toolCall` parts, native `provider_refusal` entries,
  matching `rpc_agent_start` entries and `model_usage` records, and nothing
  after the receipt except usage. `quotaFailure` is that proof plus the
  existing Codex-specific conditions (exact code, empty same-model replies, no
  refusal entry), so quota behaviour is unchanged.
- `src/runtime.ts`:
  - `finishOnce`: on a settled HEAD `error` outcome with a single admission, it
    reads the native journal while the settled state is current and before it
    changes anything. If the run is proven tool-free, the input is not a provable
    Codex quota hold, and all of its outputs have terminal delivery states, the
    input closes as `cancelled`. Its failure notice says the request was not
    completed or replayed and that later work continues. If the lifecycle
    version, admissions or input state change during the read, the drain
    restarts. An unreadable journal is reported and keeps the hold.
  - The remaining HEAD failures stay `uncertain`. Their notice now says that
    later HEAD requests are blocked and names the exact `/resolve <input-id>`.
  - `reconcileHeadRecoveryOnce`: an already held candidate with the same
    tool-free proof closes during reconciliation (after a restart, or when the
    settlement could not read the journal). After the settled receipt the proof
    tolerates only `model_usage` and `custom`/`custom_message` records other
    than run, receipt or tool starts (a restart appends `session_exit` and
    extension state there). Any later message, run or tool start keeps the
    hold. The Codex quota rule still requires nothing but usage after its
    receipt. It uses the existing owner binding,
    route authorization and effect checks, sends one notice and releases the
    admission. It runs after the quota branch, so quota holds keep waiting for
    quota recovery.
  - While an uncertain HEAD input blocks the queue, the first new owner message
    (`user-source`) held behind it gets one informational notice. The notice
    names the blocking input and `/resolve <id>`. A metadata key per blocking
    input prevents repeats. The notice does not settle or reorder anything.
  - The `/status` hint mentions the new release path.
- `docs/design/messaging.md` and `docs/OPERATIONS.md` describe the contract.

No input is replayed, and a failure is never treated as a completion. Any
started tool, steered follow-up, unknown journal entry or ambiguous delivery
keeps the existing `uncertain` hold.

### Restart and empty generation

In the observed case the input generation was `0`, equal to the HEAD
generation, so the existing candidate filter already selected it. The gap was
the missing evidence rule. Restart reconciliation now covers a clean restart.
The observed journal, however, also gained an unattributed `aborted` assistant
message after the restart. That message keeps such an input held until
`/resolve`, which the new notices now name. In that incident the live
settlement path would have closed the input before any restart. Inputs
without a generation were never submitted to the native host and have no owner
record or run to prove. Inputs from an older generation after a session
rotation stay with the operator: the owner binding names the previous session
file, and the current HEAD journal cannot prove what that run did.

## Tests

New cases in `test/runtime.test.ts` (`same-HEAD evidence recovery`):

- A settled tool-free provider refusal closes as `cancelled` with a
  "continues" notice and no `/resolve`, and the next HEAD input is prompted
  and completes.
- A provider failure after a started tool (assistant tool call,
  `tool_execution_start`, tool result) stays `uncertain`. Its notice contains
  `/resolve <input-id>`. The first held message receives exactly one hold
  notice naming the blocker, the second receives none, and neither is prompted.
- A held tool-free failure that is already `uncertain` at start-up, with
  `session_exit` and an extension `custom_message` after its receipt, closes
  from the exact native journal during reconciliation, and the queued input is
  prompted.
- The same restart journal stays `uncertain`, and later work stays queued, when
  an unattributed assistant message or a `tool_execution_start` follows the
  receipt.

The existing quota-recovery cases still pass, including those for a prior
tool, a foreign PID, instance or run, and an unbroadcast receipt.

## CI: Superkit SUPER layout

CI failed in `postinstall` because the managed Superkit (`upstream/ulw.json`,
`ref: HEAD`) moved its workflow directive from `skills/ultrawork` to the
canonical `skills/super` and now points workflows at `skills/super-*`, with the
legacy IDs kept as alias skills. `src/managed-ulw-probe.ts` reads the directive
and expects pointers from the canonical layout when `skills/super` exists, and
uses the legacy layout otherwise. The pointer tag keeps its legacy name. A new
`test/managed-ulw.test.ts` case prepares a SUPER-layout package with alias
skills. `bun scripts/prepare-ulw.ts` now activates the current Superkit
revision locally.
