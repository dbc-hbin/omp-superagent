# Messaging and authority

[Architecture](../../DESIGN.md) · [Execution and coordination](execution.md) · [Operations](../OPERATIONS.md)

## Transport and identity

The [native Gateway](../../gateway/src/main.rs) owns credentials, the
[adapter hub](../../gateway/src/adapter.rs), remote connections and authenticated
messenger effects. At least one adapter is required; all configured adapters run
together. The [head runtime](../../src/runtime.ts) owns conversation routing and
approval handling. It uses the Gateway's typed local Messenger interface, not
platform SDKs, arbitrary URLs or a generic RPC tunnel.

The operator is shared; routes are not. Bind each source and effect to platform,
authenticated account, owner authority, conversation and physical thread, plus a
logical topic where applicable. Preserve signed Telegram chat IDs and Slack
timestamp strings. Do not infer identity from display names or content. A logical
topic is a binding key, not a fabricated conversation or thread ID.

| Adapter | Authentication and recovery boundary |
| --- | --- |
| [Discord](../../gateway/src/discord.rs) | Discord Gateway and REST verify the bot/owner and configured guild and parent-channel allowlists; owner one-to-one DMs are separately allowed. History recovery is for known routes after their saved cursors, not unseen chats or all edits/deletions. |
| [Telegram](../../gateway/src/telegram.rs) | Bot API `getMe` identifies the bot. Use the configured real owner and allowed chats; anonymous, forwarded, bot-mediated and business identities do not confer authority. Long poll only after startup approval reconciliation; refuse an active webhook without removing it. |
| [Slack](../../gateway/src/slack.rs) | Socket Mode and the Web API, with bot/workspace and active human owner checks and actual channel membership. No group DMs or public HTTP endpoint. Known-route history is limited by cursors, scopes, membership, retention and rate limits. |

## Durable admission and recovery

```mermaid
sequenceDiagram
    participant M as Original messenger
    participant G as Gateway and ingress ledger
    participant H as Head and coordination store
    participant L as Managed lane
    M->>G: Owner input or approval callback
    G->>G: Persist original ID, route and authority
    par Platform acknowledgement
        G-->>M: ACK or cursor advancement
    and Head intake when ready
        G->>H: Deliver in order
        H-->>G: Durable admission receipt
    end
    opt Head explicitly delegates
        H->>L: Source-bound native dispatch
        L-->>H: Durable progress or outcome report
    end
    H->>G: Output bound to the selected original route
    G->>M: Scoped delivery
    G-->>H: Delivery receipt, definite failure or uncertainty
```

Gateway admission, platform ACK, head receipt, native prompt admission, native
settlement, task acceptance, and external delivery are separate facts. The
[Gateway ledger](../../gateway/src/store.rs) persists before ACK or cursor
advancement and before handing the event to the head; these two paths do not
wait for each other. The Gateway replays by stable identity. The head durably
deduplicates the original event and any distinct edit revision. A permanent denial
may be recorded as rejected; handler, store or transport failures do not turn an
unresolved event into a denial. Preserve pending order and recover connectivity
with bounded backoff. A held event does not block the initial approval recovery
barrier or selected priority owner controls (`/restart`, `/stop`, `/stop head`);
ordinary intake keeps its order. After the first approval barrier, a head outage
does not close Gateway admission. Reconnecting does not replay already submitted work.

Telegram persists its per-bot offset after admission and acknowledges it with the
next `getUpdates`. There is no Bot API history fetch; recovery cannot exceed its
24-hour update retention. Omit the previous offset after 24 hours of inactivity,
missing/invalid observation time or clock rollback. Stable message and
callback-query identities, not a presumed globally monotonic update ID, deduplicate
redeliveries and approval progress.

### Uncertain submissions

Do not replay an ambiguous native prompt, approval response or external mutation.
[HEAD recovery](../../src/head-recovery.ts) can run a separate, evidence-bound
reconciliation turn in the existing head under a native tool gate. The model may
propose `release` or `hold` through `head_recovery`; code rechecks the exact
request/session/file/generation, native `rpc_prompt_result` and run boundaries,
and actual quiescence before applying an outcome. Native completion is not task
acceptance. Missing or contradictory evidence and uncertain remote effects
remain held. Recovery cannot dispatch, answer approvals, run tools outside its
gate or repeat the original request. A later stop or manual resolution invalidates
older recovery work.

`/resolve [input-id]` (`!resolve` in Slack) manually closes an uncertain head
input as cancelled. A stalled lane exposes its exact input ID and queue blocker
through `/status` or `lane_inspect`. Only the operator in the bound topic can use
`/resolve --lane <input-id>` to cancel that uncertain input. This is not a native
interrupt, replay or implicit resume, and it preserves other fences and pauses.
See the [operations guide](../OPERATIONS.md#4-명령과-일상-사용) for command usage.

## Topic routing and controls

- An ordinary question or coordination request can be answered directly. For
  independent work, the head selects the actual repository, scope and model
  and calls `lane_start`; for a later instruction it calls `lane_message` with
  the original durable source. A binding is context, never authority. Inbound
  follow-ups still go to the head, and creation does not move pending work.
- Thread-first work sends a short kickoff to the selected topic. The durable
  `sent` receipt gates new lane dispatch and steering for that input. A missing
  or uncertain delivery is not a successful kickoff.
- `/new` selects a fresh logical topic in an eligible private conversation.
  With no request it does not start a lane or model turn. `/main` changes future
  input context without altering previous bindings, approvals or work. Topic
  boundaries are durable; redelivery uses the original binding and editing an
  admitted control cannot move its boundary. Ordinary edits are new revisions,
  not rollback of effects.
- For an active native run, eligible ordinary same-route follow-ups use native
  `steer`. Match the full route including account, authority, thread and topic;
  controls, internal reports and workflow selection do not join the run. Keep
  each source, receipt and outcome binding; jointly handled inputs produce one
  result for the cohort. A lane still needs explicit `lane_message`; pause,
  approval, compaction and uncertainty gates still apply.

| Platform | Command and topic representation |
| --- | --- |
| Discord | Ordinary `/...` messages and explicitly registered application commands share authorized ingress. Interactions have an `interactionId` and no message ID; do not use them for history, reactions, fetch, thread sources or replies, or persist response tokens. Server text/announcement channels support threads; forum/media posts can require exact tag IDs. DMs use logical topics. |
| Telegram | Ordinary slash messages and owner-scoped menus keep real message IDs. Normalize only actual bot-command entities addressed to this bot; ignore commands addressed to other bots. Native topics require eligible forum supergroups or topic-enabled private chat; group topic creation needs the granted capability. |
| Slack | Ordinary `!...` messages and registered `/superagent-*` commands use Socket Mode. Slash commands have no message `ts`: deduplicate with a token-free scoped invocation fingerprint; anchor topic boundaries to the last durably admitted real owner message and use admission order on the same anchor. Do not persist trigger/response tokens or invent a timestamp. Use real root messages for threads, never nested threads. |

[Command definitions](../../src/messenger-commands.ts) are shared. Menu registration
is a separate explicit apply, not a side effect of setup, doctor or start. Command
intake must not wait for a model; Discord's ephemeral admission reply and Slack's
Socket Mode acknowledgement are not the actual command result.

The head sends model and effort menus through its normal outbox. The Gateway
renders native components and binds each click to the owner, exact sent card,
physical conversation, and displayed page. Navigation and cancellation only
edit the card. One final click admits an ordinary durable control receipt on
the original logical topic without inventing a message ID; accepting the click
is not a native mutation receipt. The head requires the recorded sent receipt
for the exact card before changing settings. Unselected cards expire after five
minutes, on Gateway restart, or when a new menu of the same kind replaces them
on the same route.
The interaction pattern was compared with [Hermes Agent at 242315ce](https://github.com/NousResearch/hermes-agent/blob/242315ce571cde721e717a544cf8ae6c343315cf/gateway/slash_commands_model.py#L516-L567);
the catalogue and mutation remain native OMP, and no upstream picker code is used.

Thread capability comes from the authenticated adapter. Permission or network
failure is not permission to fall back to another destination. Preserve the
original binding when creating a sibling topic and journal creation intent before
the remote effect. Discord `thread_inspect` reads actual thread and parent policy;
`lane_thread_update` uses the original user source, checks the route and
permissions, then reads back title, tags or archived state. Exact tag IDs and
required/moderated tag policy apply. Archiving a thread does not pause its lane,
and reopening it does not resume it.

For a bound Discord work thread, an owned native run adds `⏳` to the title;
verified `lane_close` completion replaces it with `✅`. Native settlement alone
does not mark work complete. Pausing clears the working marker and cancelling
clears either marker. Resumed work gets the working marker again when it runs.
The head reads the current title and updates its prefix through the same
authorized thread API. These edits need Manage Threads, are best effort, and
skip archived threads. They do not change tags, archive state, or lane execution.

`/help`, `/status`, `/context` and `/usage` are code-handled reads with no model
turn. [`/usage`](../../src/omp-usage.ts) invokes the configured executable and
profile with `usage --json --redact --no-extensions` and projects provider quota
and reset data, without sending account identifiers or raw responses. Unknown
quota is not zero or an estimate of this session's usage. `/compact` uses native
compaction and requires an idle eligible head; status and priority stop remain
available while it runs. `/stop` pauses the bound lane, or stops head work when
unbound; use `/stop head` or a lane ID to name a target. Once admitted to the
head, priority controls and approval answers do not wait for an ordinary model
turn to finish. [Restart](../../DESIGN.md#explicit-restart)
is distinct from stopping a task or resuming a topic. `/cron` controls
[head-owned schedules](execution.md#scheduled-work-and-pr-observation).

## Approvals and owner decisions

Persist an answer attempt before streaming it to the head. Match the original
physical route, authenticated owner, remote card and native request plus session
and generation before applying it. A topic switch cannot retarget a card.
Reconcile ambiguous attempts against the original pending request; do not
resubmit them. The initial admission gate depends on approval reconciliation,
not merely a live adapter connection.

Telegram free-form input is an exact reply to the active original bot card;
partial responses are tracked and recover on that same card. A pending answer
can be looked up even for a queued, inactive card. Keep content-free identities
of closed cards so stale replies cannot become tasks, and drop closed-dialog
partial answer progress. Final Telegram button callbacks and Slack responses
are acknowledged only after durable admission. Slack buttons and modals validate
card/view identity and metadata, and the same Slack question card shows whether
an answer was submitted or the question was cancelled. Discord and Slack accept
free-form drafts in native modals without echoing their contents on the channel
card. Unsupported or secret input is not approximated or auto-approved: cancel
the native request and direct the operator to the appropriate local UI.

[`decision_ask`](../../src/decision-tool.ts) uses native `askDialog`; it is not a
parallel approval engine. [Decision records](../../src/decisions.ts) link the
native tool call, original source and original question/card. `answering` is an
attempt, not the `answered` state confirmed by native settlement. A lane's
source-bound question goes to head review first. For a routine reversible
choice within the assignment, the head returns an original option to the lane
and records the reason internally, without a separate messenger message. When
the owner must decide, the original card shows why their decision is needed
alongside the unchanged questions and choices. Recommendations are not
preselected. This is not authority to grant tool permission or manufacture user
consent. Recommendation, silence, normal text, quotes and reports are not
approval.

## Content and delivery

- The head, not a lane, chooses delivery. Preserve the originating route,
  immutable output ID and remote receipt. Never look for the last active chat.
  Discord replies use a real original message only in the same physical
  conversation; slash interactions and newly created threads are not that
  message. Do not retry an ambiguous send or attachment upload.
- Quoted/replied content and Discord channel context are observations, not
  commands. Snapshot a reference at first admission; a later edit or deletion
  does not change that snapshot. [Discord purpose notes](../../src/discord-context.ts)
  are local scoped context tied to a real owner input, not channel mutations
  or authority to choose a repository or dispatch work.
- Resolve Telegram and Slack file references through original authorized
  API routes and metadata. Do not persist or surface credential URLs or
  follow redirects on private file downloads. Enforce byte limits end to end;
  an unknown size is not zero and a known size must match the bytes received.
  The adapters preserve audio metadata; they do not transcribe attachments.
- Long outputs use a single bounded text attachment where supported. Discord
  first splits an over-limit reply at paragraph, line, then space boundaries
  into at most five ordered messages, closing and reopening a code fence that
  crosses a boundary; only the first replies to the original message, each part
  has its own nonce, and the first message ID is the receipt. The Gateway has
  25 seconds for the whole Discord output, including destination lookup,
  leaving time to return the result before the head's 30-second IPC timeout.
  No new parts are posted after that deadline. An in-flight POST at expiry or
  a failure after a visible part is uncertain; nothing is resent. Slack
  uses upload URL → bytes → `files.completeUploadExternal`, not `files.upload`.
  Telegram and Slack do not automatically retry remote mutations. Discord formats
  pipe tables as fixed-width code blocks at delivery, preserving the stored
  original. [Delivery classification](../../src/delivery.ts) distinguishes
  definite rejection from uncertainty across the IPC boundary.
- Receipt/working reactions are best-effort decorations bound to the real
  source message. They neither delay nor prove admission, execution or delivery.
  Progress reports are coalesced before submission where safe; a final result
  takes precedence over undelivered progress. Already started external sends
  cannot be recalled.

## Discord voice

[Discord voice](../../gateway/src/discord_voice.rs) is optional Gateway functionality,
separate from voice attachments or the head model. A fresh original owner
`/voice start` in the configured text channel can open one bounded OpenAI Live
conversation in the configured voice channel. Use channel permissions to
exclude other participants. Edits, catch-up and restart cannot open or resume it.

In subscription mode the [Rust Gateway](../../gateway/src/discord_voice/subscription.rs)
uses the installed Codex CLI to verify the active subscriber, then sends audio via
WebRTC and receives draft requests over the same call's sideband connection.
No Python worker or provider API key is required. API mode uses the separately billed OpenAI Live API.
Subscription rejection or connection loss never falls back to API billing or
retries automatically. Live answers ordinary conversation. For explicit work
requests it produces a text draft of the owner's speech, not a second task
answer. Draft posting is off by default in both modes. `/voice start work`
opens a new call with permission to post drafts to the bound text channel.
Subscription mode also supports `/voice start share` for one draft within a
minute after startup. Permission is fixed before audio reaches that provider
session and cannot be added to an existing call. `/voice work off` revokes it,
cancels still-queued posts and invalidates unconfirmed drafts without waiting for
ordinary intake; requests already transmitted cannot be recalled. Neither start
command submits or approves work. Only the owner's written
`/voice confirm` as a reply to the active draft enters normal durable head
intake; normal approval rules still apply. Head replies stay in normal Discord
text delivery, with no return path to Live. The Gateway stores no recordings
or full voice transcript; drafts are visible in Discord and confirmed tasks and
replies use existing records.
See the [voice operations guide](../discord-voice.md) for setup, costs, and limits.
