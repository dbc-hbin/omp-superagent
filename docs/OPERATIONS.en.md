# Operations and Installation Guide

[Back to the project overview](../README.md) · [Korean guide](OPERATIONS.md) ·
[Design](../DESIGN.md) · [Example configuration](../config.example.json) ·
[Attribution and license notices](../THIRD_PARTY_NOTICES.md)

[Install](#1-local-preparation--does-not-start-the-bot) · [Platform apps](#2-platform-apps-and-access) · [Configuration](#3-configuration) · [Daily use](#4-commands-and-daily-use) · [Recovery](#5-operational-scope-and-recovery-constraints) · [Developer verification](#6-developer-verification)

This guide covers installation, configuration, day-to-day operation, and recovery. Unless
otherwise noted, file and code paths and shell commands are relative to the **repository root**.
For an npm installation, run the same management commands with `omp-sa` instead of
`bun --no-env-file src/cli.ts` and keep the configuration file in your own working directory.
See the [design](../DESIGN.md) for the current architecture and authority contract. Verification
results in the [release records](releases/) apply only to the listed version, baseline, and scope.

The Gateway owns messenger connections and the lifecycle of the designated OMP head. The head
controller accepts and routes operator input. The shared HEAD model handles ordinary requests
that are not bound to a lane. Ordinary work in a bound topic continues in its lane session, and
replies are delivered without another turn of the shared model. Control commands and restricted
groups follow separate routes. All configured platforms connect concurrently, and their owners
must represent the **same trusted operator**. The main context is shared, but platform, account,
conversation, and topic identities stay separate. This is neither a multi-tenant setup nor an OS
security sandbox. Attaching a native TUI or herdr to the same managed RPC Host process is not
supported.

Optional [Discord real-time voice chat](discord-voice.md) (Korean guide) handles ordinary conversation in a
separate OpenAI Live session. If started with `/voice start work`, spoken work requests can be
posted as drafts in the designated text channel. For a draft to be accepted as an ordinary text
request, the owner must reply to it with `/voice confirm`. Results are delivered only as Discord
text.

### Lane Management Tools and Operator Skills

Only the head can use `lane_models`, `lane_init_presets`, `lane_start`, `lane_set_model`,
`lane_inspect`, `lane_message`, `lane_pause`, `lane_resume`, `lane_close`,
`thread_inspect`, `lane_thread_update`, `messenger_presence`, `lane_watch`, `pr_watch`, `pr_watch_list`,
`discord_context`, `discord_purpose_list`, `discord_purpose_set`, `discord_purpose_clear`,
`decision_list`, `decision_inspect`, and `decision_withdraw`.
`decision_ask` is available to HEAD and root lanes, but not to native children.
Use `lane_inspect({})` to list lanes. Lanes do not receive management authority, and
native children receive neither management nor board access. Do not install these extensions
globally in ordinary OMP. See the [management tool contract](design/execution.md#management-tools)
for tool arguments and role boundaries.

- `skill://superagent-head`: Routing, model selection, and supervision. Only the role
  instructions from `SKILL.md` are injected into the root head; read detailed references from
  the package path when needed. Changes to the role file take effect after the Host restarts.
- `skill://superagent-lane`: Direct work within scope, bounded delegation, verification, and
  reporting. Read the detailed workflow as needed.
- Native discovery resolves these URIs regardless of the current working directory. It does
  not overwrite user or project skills. Do not use `--no-skills` in this URI-based workflow.

### Online Presence and Work Watches

| Example operator request | Behavior |
| --- | --- |
| `Keep the Discord bot online` / `Show online status` / `Turn off online presence` | Maintain or query the current Discord bot's online presence, or set it to `invisible`. Does not track other users or accounts. |
| `Watch this lane` / `Show my watches` / `Stop watching this lane` | Observe the selected lane's recorded progress, reasons it stops, and termination from the original conversation. Turning off notifications does not pause the lane or cancel work. |
| `Tell me when CI passes on owner/repo#35` | Register a PR watch as described below. HEAD checks the registration result before replying. |

If the target is unclear, provide a lane name or PR URL. HEAD handles unambiguous watch
requests even in a bound conversation; ordinary work and quoted text are treated as before.
Use `/head` if you need to route the request explicitly. Registrations do not automatically
move to another conversation. The existing Gateway and HEAD must be running; no extra bot or
token is needed. A configured status without an actual connection does not mean the bot
appears online in the messenger.

Discord's online or invisible setting is applied when the same Gateway reconnects. Status
queries distinguish the **configured value, current connection, and last value written to
the current socket**. They do not prove what users see, whether HEAD is ready, or whether a
lane is running. The default behavior before startup is unchanged, and becoming invisible
does not turn off message reception. Manage the online presence of Slack Socket Mode bots
in the [Slack app settings](https://docs.slack.dev/apis/web-api/user-presence-and-status/#events-api-bots).
The Telegram Bot API does not support online presence. Do not use user tokens or cookies
to get around either platform's limits.

### PR Follow-up Tracking

Give the head a PR URL and ask it to track the PR. `pr_watch` takes `action: "track"`,
`ref` (a GitHub PR URL or `owner/repo#number`), the actual original `sourceId`, and an optional
`intervalSeconds` (defaults to five minutes). `laneId` associates the watch with an existing
lane for reference, and `ignoreAuthors` lists GitHub logins to exclude from notifications.
For example, you can request a check for review and CI changes every 300 seconds. Watches
are not registered automatically.

Use `pr_watch_list({sourceId, ref?})` to inspect this conversation's watches, baselines,
latest observations, next check times, errors, and holds. Use
`pr_watch({action: "untrack", ref, sourceId})` to stop tracking. These are native HEAD tools,
not messenger slash commands or shell commands.

- A separately installed `gh` must be on the HEAD environment's PATH and have read
  authentication for `github.com`. The watch uses existing `gh` authentication; it does not
  store its own tokens or perform login. Enterprise hosts are not supported.
- The first successful query only saves a baseline. Subsequent observations deliver new
  reviews and comments, review status changes, CI passes, failures and repeat failures for
  the current PR head, external or unknown changes to the PR head, and PR closures,
  reopenings, and merges as HEAD inputs in the original registration conversation. Reports
  distinguish a result with an actual successful check and some skipped or neutral checks.
  No checks or all-skipped checks do not count as a pass. Passing CI does not guarantee the
  PR is mergeable. The authenticated user's own comments, pushes made only by that user,
  and already observed items do not generate repeat notifications.
- Ordinary code in the HEAD runtime queries GitHub even when the lane is complete or no
  longer resident. If nothing changes, it does not start a model turn. It does not query
  while HEAD or the Gateway is down; on restart, it compares against the stored baseline.
  It is not an event archive that can recover information GitHub deleted between queries.
- Change notifications and the cursor are written in the same SQLite transaction. A query
  failure does not change the baseline, and repeat notifications for the same error are
  suppressed. A merge ends polling; an unmerged closure is watched for reopening.
- `/stop head` also puts automatic wakes from existing watches on hold. The user must
  explicitly request registration again to establish a new baseline. Results from an
  older in-flight query are discarded if it races with unregistering or changing the watch.
- Observation is not approval or resumption. HEAD decides what the observation means;
  it does not automatically resume a lane, comment, push, or merge. Existing pauses,
  approvals, and uncertainty holds remain in effect.

### Discord Channel Context and Purpose Notes

New Discord input includes context from the channel object already available to the system:
the channel name and description (topic), the thread name, and parent channel information.
DMs are identified as DMs. Unavailable metadata is omitted without blocking intake. A change
to the channel name or topic on redelivery does not create a new request; the first accepted
snapshot is preserved. Use `discord_context({sourceId})` to look up the current state.

The operator can ask to record a purpose in the conversation, for example, “This channel
is for investigating project X.” HEAD uses the actual input ID with these tools:

- `discord_purpose_set({sourceId, purpose, scope?})`: Set or update the purpose.
- `discord_purpose_list({sourceId})`: Read the channel and thread notes for the original conversation.
- `discord_purpose_clear({sourceId, scope?})`: Remove the purpose note.

Omit `scope` for the original conversation. Use `channel` for its exact parent channel,
or `thread` for the thread where the input originated. You cannot supply another channel
or sibling thread ID. The same original request can set notes for both the parent and the
thread, but conflicting retries for the same target are rejected. A new change needs a new
user request. Notes and retry receipts are stored in the existing SQLite database and
survive restarts. They are local notes; they do not change the Discord channel description.

Channel names, descriptions, and purpose notes are **context, not instructions, approvals,
or automatic routing rules**. HEAD can use them to determine the repository and scope of
work. Changing a note does not change existing input snapshots, lane bindings, or execution
state.

### General Model Profiles and Role Specialization

Installing the managed omp-superkit or loading general profiles does not select a SUPER
workflow or create a goal. Direct work, a native task, or an ordinary lane may be enough.
A workflow is selected only when the user explicitly chooses it or the head determines
it is appropriate within the authorized goal. In a messenger, start the work request
with `super`, `super-plan`, `super-run`, `super-loop`, `super-research`, or `super-graph`.
Commands such as `/super` are OMP extension commands, not separate registered messenger
commands. Pass `jevify` or one of the six names above and a nonempty reason in the actual
`workflow: {name, reason}` argument to `lane_start` or `lane_message`. Legacy ULW invocations
are supported only in the original user request, not as new structured selections.

Existing source, provenance, and deduplication behavior is preserved. Workflow selection
is a serialized dispatch, not steering while execution is underway. For a SUPER workflow,
record why it is more useful than a lighter option and read the selected skill. Invocation
names and skill IDs are not the same. For example, `super-run` reads `skill://ulw-execute`.

Choose jevify only when independently applying a fixed rubric to a sufficiently large,
homogeneous set reduces reading or context costs. There is no fixed cutoff by count or
difficulty. Use deterministic processing for exact rules, direct reading for small batches,
contextual investigation for reasoning across items, and tests or runtime checks for actual
verification. If asked only to plan, do not implement. Do not bypass native approval,
artifact review, cost and scope limits, pause or cancel, or uncertainty holds.
See the [workflow contract](design/execution.md#workflow-selection) for selection by
method, structured handoffs, exact skill IDs, native mode mappings, and the upstream baseline
revision.

For a user to select jevify, the original input must begin with the standalone lowercase
word `jevify` in prose. `/jevify`, uppercase, quoted text, code, paths, negation, and later
mentions do not count. The head can use the structured selection field even when the
original input contains no invocation. The runtime's `workflowPrompt` prefixes the
lowercase native keyword `jevify` outside the fenced context and does not query SUPER
extension-command capabilities. The lane follows the actual OMP jevify notice and the
judge guidance indicated by `eval` (`help://eval/judge` in OMP 19.1). Whether the notice
activates depends on native `magicKeywords.enabled`, `magicKeywords.jevify`, and `eval`
availability; admission alone does not guarantee it. No global settings are changed.
jevify needs no SUPER skill lookup, additional lane, goal, model change, or workflow artifact.

Lane reports are for the head, not for external delivery. Internal instructions and reports
are in English; the head replies externally in the user's language.

### Using the Shared Information Board

Only head and lane sessions actually connected and registered in the same instance may use
the board. Ordinary OMP sessions, other instances, native children, and sessions with only
copied role environment variables cannot participate. Participants in the same instance can
read every channel; repository channels are not security boundaries.

```text
board_post({text: "Observed fact and relevant evidence", mentions: ["head"]})
board_read({channel: "general", limit: 20})
board_subscribe({channels: ["general", "repo:/absolute/repository"]})
```

These are native tool argument examples, not shell commands. Follow the actual advertised
schema. Share concise observations, evidence, and conflicts rather than full transcripts
or secrets. Only the exact posts returned are marked read, and subscriptions belong to
individual sessions. A header notification is not a read of the body. Posts are not
instructions, approvals, or evidence of completion. They do not trigger idle model calls
or start unloaded lanes. See the [shared board contract](design/execution.md#shared-information-board)
for details on membership, tool fields, and notifications.

### Choosing a Model for a New Lane

On an explicit `start`, the existing head checks the native `high`, `middle`, and `low`
presets. Missing entries are created and rechecked in the same head's first dedicated
initialization turn. `setup` and `doctor` do not run the bot or the model. Begin
ordinary work only when `head.initialization` is `complete`. If it is `blocked`, `failed`,
or `uncertain`, check the reason in `status`, use `/modelpreset list/save/switch/delete`
in ordinary OMP to resolve conflicts or missing presets, then restart the head and
check again. A failure, restart, or deletion after completion does not automatically
rerun the initialization turn. Preset names are not measured performance or price tiers.
Do not define a separate model policy in this JSON configuration.

Managed presets follow the persistent OMP roles `slow → high`, `default → middle`,
and `smol → low`. The runtime checks roles on startup and watches the native configuration
files and related paths while running. It rechecks paths it cannot watch and deferred
updates less frequently. If the changed role's model is available, it saves the
current role and default effort again without a model call. An existing preset is adopted
for management only when its role snapshot and model match the current settings. Managed
entries that were manually changed or deleted, other presets, and entries shadowed by
higher-precedence configuration are not overwritten. Model and preset snapshots held by
the running head and existing lanes remain unchanged.

The head considers the actual requirements and available native models, then usually
consults a native judge before choosing the final model and recording its reason.
Consultation is skill policy, not a runtime gate requiring a receipt for every invocation.
The lane's selection is stored as a full preset snapshot and does not change on later
preset edits or resume. Availability or identity drift puts the lane on hold without
automatic substitution. Request an explicit model change for an idle lane only through
the head's `lane_set_model`; it does not change global settings, the head, other lanes,
or any paused or uncertain state. In `lane_inspect`, distinguish saved
`model/modelPreset/modelPresetSnapshot/modelReason` from actual `state.model` and
`modelCheck`. A null actual state means unobserved, not a match. See the
[model selection contract](design/execution.md#models-and-presets) for first-write
exceptions, judge limits, model adoption, and the private overlay contract.

## 1. Local Preparation — Does Not Start the Bot

The current source uses Git, **Bun >= 1.4.4** (`packageManager: bun@1.4.4`), and a local
Unix socket. You can install the package without OMP. Running the Host requires a separately
installed stock OMP. Rather than gating by version number, the Host checks interfaces for
`rpc-ui`, session resumption, extensions, model selection, and process observation. OMP 18
is subject to manual compatibility checks; the automated CI SDK baseline is
[OMP 19.1.1](https://github.com/can1357/oh-my-pi/commit/31ffee513f27a01bba7d4dfbe12bae239cdc646a).
`doctor` reports the executable path selected by `command`, its version, and the service
backend. It does not guarantee login or runtime compatibility. The Host performs actual RPC
initialization and ownership checks.

Before upgrading from 18 to 19, check the background services owned by the existing Host.
OMP 19's per-user daemon does not take over services from the previous broker. An empty list
in the new daemon is not evidence that you may stop or reclaim work whose completion was
never confirmed in the old session.

The default `command: ["omp"]` looks up OMP on PATH. To use a different installation, put
its OMP path in the first entry of `command`. A relative path is resolved against the
configuration file's directory, and all lanes use the same path. This repository does not
download OMP or build it from source.

```sh
bun add --global --trust omp-superagent@0.1.9
omp-sa --help
```

`--trust` allows package installation scripts, including preparation of the managed
omp-superkit. Add the output of `bun pm bin --global` to PATH. If Bun is on PATH, you can
also use `npm install --global omp-superagent@0.1.9`. Create the configuration in your
own working directory, not the installation directory, with
`omp-sa setup --config ./config.local.json`. Installation alone does not activate the bot.

The published npm package includes the Gateway and Host relay executables for its target
platform. For a source checkout or a GitHub source tarball, have stable Rust and Cargo,
CMake, and a C compiler ready, then run the following from the repository root. Cargo builds
the two executables using their respective `Cargo.lock` files; it does not build OMP.
After editing Rust source, run `bun run build:native` to rebuild them.

```sh
bun install --frozen-lockfile
```

Installation does not run OMP. `setup`, `doctor`, and actual Host startup check the selected
CLI. The root SDK dependencies are the published `@oh-my-pi/pi-coding-agent`,
`@oh-my-pi/pi-ai`, `@oh-my-pi/pi-catalog`, `@oh-my-pi/pi-natives`, `@oh-my-pi/pi-tui`,
and `@oh-my-pi/pi-utils`, all pinned to the same baseline. Installation does not start
the bot or replace an existing OMP executable or global settings.

To avoid changing the system Bun, you can use an isolated local copy. Point the following
`bun` commands and any Bun path in the configuration at that copy.

```sh
npm install --prefix .upstream/toolchain --no-save bun@1.4.4
export PATH="$PWD/.upstream/toolchain/node_modules/.bin:$PATH"
```

This changes PATH only in the current shell. No global installation, replacement of the
existing OMP, or automatic startup registration is required. Configure model provider
authentication separately as you would in OMP. This project does not replace its
authentication engine.

### Required Managed omp-superkit Installation and Updates

Installation always includes the official [dbc-hbin/omp-superkit](https://github.com/dbc-hbin/omp-superkit).
The root `bun install` postinstall prepares the managed package. Activation checks use
actual prompt composition from the published native SDK. For the current layout, the
checks verify the instructions and pointers for `skill://super` and `skill://super-*`
and verify that the older skill IDs resolve as aliases. Valid installations in the
previous layout still work. To prepare only omp-superkit again, run:

```sh
bun run prepare:ulw
```

`upstream/ulw.json` specifies the official remote and `checkIntervalMs: 3600000` (one hour).
Installation checks the remote's **default branch HEAD**. A production Gateway needs a
valid active installation before startup. Once it confirms that, it starts IPC and the
head first, checks the remote in the background, and then checks hourly for new commits
to prepare and activate. A slow or unreachable upstream does not delay startup if the
Gateway already has a valid active installation. Ordinary code checks for updates; this
is not a model watchdog, does not run a work lane, and does not authorize messenger bot
login. Git and dependency downloads need network access. The process does not modify the
user's omp-superkit checkout, global OMP installation or configuration, or shared prompt
sources.

Only an immutable revision that passes preparation and the offline composition probe is
activated, and activation is atomic. Once a revision is active, only fast-forwards from
the same remote are allowed. The same check applies to the official `omp-ulw` →
`omp-superkit` rename. Failures, rewinds, and divergence leave the previous revision active.
See the [design](design/execution.md#managed-omp-superkit-integration) for the lock, staging,
and probe contracts. Do not bypass them by manually editing the managed pointer or lock.
If there is no valid active revision, `start` fails before activating adapters. Recover
first with `bun run prepare:ulw`. `doctor` does not check remote freshness or whether
loading succeeds. Older revisions are not deleted automatically.

To check installation status without network access, run:

```sh
bun run prepare:ulw -- --status
```

The Gateway status response's `ulw` fields distinguish `revision`, `packagePath`,
`upstreamRevision`, `checkedAt`, `error`, and `updating`. `injected` appears only for test
injection. `revision` and `packagePath` identify the **active package the next new Host
will use**, not the version of every running Host. `upstreamRevision` is the last observed
remote result; read it alongside `checkedAt`, `error`, and `updating`. A failed or
unperformed remote check does not show as a confirmed match with the latest version.
In `omp-sa status --config FILE`, `gateway.head.loadedSuperkitPath` is the package path
verified when the connected head's actual OMP session started. If it differs from
`gateway.ulw.packagePath`, the head is still using the older version.

Each new head and lane starts only if the session's active list contains every extension
module in the manifest. Having the files is not enough: an import or initialization
failure, or an inactive module, prevents readiness. Do not reconnect to an existing Host
for work if it cannot verify the modules it loaded. Check any running work, shut down
gracefully, and start again. Installation and checks do not change ordinary OMP's global
settings.

**The revision of a running Host may differ from the revision of the next Host.** Running
head and lane sessions keep the exact package path they loaded. An update does not restart
them or hot-reload the package. Each new Host resolves the active package at the time it
starts. A long-running head that later starts a new lane does not force that lane to inherit
the head's older package path. Reconnecting an existing Host's control connection does not
apply a new revision. Successful installation or updating is separate from verifying native
workflow selection, mode activation, goal creation, and actual model responses.

## 2. Platform Apps and Access

Set up only the platforms you intend to use. Pass tokens to adapters **only through
environment variables**, never in ordinary JSON configuration, command-line arguments, or
Git-tracked files. You can save the settings below in a separate owner-only environment
file. For `tokenEnv`, `botTokenEnv`, and `appTokenEnv`, use the environment variable name,
not the token itself.

### 2.1 Discord

1. Create an application and bot in the [Discord Developer Portal](https://discord.com/developers/applications).
   In the bot settings, enable **Privileged Gateway Intents → Message Content Intent**.
   Reading server message content requires both the intent request in code and the portal setting.
2. Invite the bot to the server with the `bot` and `applications.commands` scopes. Grant
   View Channel, Read Message History, Send Messages, Send Messages in Threads,
   Create Public Threads, Attach Files, and Add Reactions in the required channels.
   Optionally grant Embed Links to display cards. If that permission is missing or cannot
   be verified, cards are sent as code blocks. The bot must actually have access to private
   threads and similar restricted surfaces. Administrator permission is not required.
3. Use Discord Developer Mode to copy the owner's **user ID**, the server ID, and the
   allowed **parent channel IDs**. Configure numeric ID strings, not names or mention strings.
4. Only the `ownerId` can send input and approve on the ordinary operator route. Bot and
   webhook input is rejected. To give other users limited access, use the separate
   [`groupRooms` rules](#group-chat-and-server-access-separation). Server input must pass
   **both** `allowedGuildIds` and `allowedChannelIds`. Threads follow the parent channel
   allowlist. An empty array blocks server input; it does not allow all servers. The owner's
   1:1 DM is separate from the server allowlists. Group DMs are out of scope.
5. If the channel is shared with other bots or you want to exclude the owner's casual
   conversation, set `discord.requireAddressing` to `true` in the configuration file.
   The default is `false`; changes take effect on the next Gateway start. If it is running,
   use `omp-sa stop main --config FILE` and confirm a graceful shutdown before running
   `omp-sa start --config FILE`. In an allowed server's parent channel, an ordinary message
   from the owner is accepted only if it **actually mentions this bot** or **replies to a
   message this bot sent in the same channel**. Typing the bot's name or mentioning a
   different bot does not count. The same criteria apply to edits and messages fetched
   during connection recovery. In an allowed thread created by this bot, conversation can
   continue without mentions or replies. In a thread created by another bot or person,
   mention this bot or reply to one of its messages, just as in the parent channel.
   Owner 1:1 DMs, Discord app commands, approval buttons, and restricted `groupRooms`
   rules are unchanged. Real-time `/voice` controls in the designated text channel follow
   the [voice chat rules](discord-voice.md#사용).

```sh
read -r -s DISCORD_BOT_TOKEN
export DISCORD_BOT_TOKEN
```

This Bash example reads the token without exposing it on screen or in shell history.
Processes run with the current user's permissions and environment. Lanes and worktrees
are not security sandboxes.

Register Discord autocomplete commands explicitly. Before registration, both the Gateway
and HEAD must be running the new version. Replacing only the Gateway may reconnect it to
an old HEAD. Send `/help` in Discord and check that `/usage-reset` is listed. If it is
not, do not register commands; finish updating HEAD first. Do not kill a busy HEAD.

```sh
bun --no-env-file src/cli.ts discord-commands --config config.local.json
bun --no-env-file src/cli.ts discord-commands --config config.local.json --apply
```

The first command previews changes without writing. `--apply` **replaces this bot's entire
global command list**; use it only with a dedicated Superagent app. It removes Hermes-only
commands and registers the [shared commands (including `/head`) and Discord-only `/usage-reset`](../src/messenger-command-catalog.json).
If separate guild commands shadow global commands, registration reports the conflict
rather than silently deleting them. Registration does not start the model or open a
messenger connection, and is not a side effect of `setup`, `doctor`, or `start`.
Commands that take arguments use an optional `text` field. For example, enter `preset high`
in `/model`'s `text` field and `head` in `/stop`'s `text` field. `/status` also works as
an ordinary message. In a parent channel with `discord.requireAddressing` enabled, mention
this bot or reply to one of its messages just as for any ordinary message.

Commands follow the same owner, allowed channel, thread, and 1:1 DM boundaries. After
durably accepting a command, the system sends a private acknowledgement and delivers the
actual result through the existing outbox to the original conversation. An interaction ID
is not a message ID and is not used as a history cursor, reaction target, message fetch
target, or thread source. Interaction tokens are not stored or passed to the head.
Discord requires an initial response within three seconds. If admission or acknowledgement
is uncertain, the command is not replayed automatically. Check state before repeating the
same change. See [Discord's interactions documentation](https://docs.discord.com/developers/interactions/receiving-and-responding)
for the API contract.

### 2.2 Telegram

1. Create a bot with the official [BotFather](https://core.telegram.org/bots/features#botfather)
   and keep the token in an environment variable such as `TELEGRAM_BOT_TOKEN`. The owner
   must first start a private chat with the bot.
2. Set `ownerId` to a **positive numeric user ID string** and `allowedChatIds` to
   **negative chat ID strings** for the allowed groups or supergroups (for example, a
   real `-100…` ID). Names, phone numbers, and usernames are not IDs. The owner's private
   chat is allowed separately, and an empty array blocks group input. In the ordinary
   operator route, even allowed groups accept only messages sent directly by the configured
   owner. Anonymous administrator `sender_chat`, bot messages, forwarded messages, and
   via-bot or business inputs do not carry operator authority. Registered restricted groups
   follow separate `groupRooms` rules.
3. To handle ordinary group messages, the bot must be able to see them. Adjust
   [Privacy Mode](https://core.telegram.org/bots/features#privacy-mode) in BotFather
   or explicitly configure visibility through bot administrator rights. Do not assume
   that all ordinary messages arrive with Privacy Mode on. Follow Telegram's guidance
   on whether the bot must be re-added to the group after a change.
4. Native forum topics are used in supergroups with forums enabled. To create a new topic,
   the bot needs the administrator permission **`can_manage_topics`** and must be allowed
   to send messages and documents. Lanes are separated by the actual `message_thread_id`.
   When the head hands off to a new topic in a private chat, a bot with
   `getMe.has_topics_enabled` tries to create a real topic first. Private chats without
   support use logical topics with `/new` and `/main`. The system does not invent forum or
   thread IDs for ordinary groups or turn on topic mode on its own.
5. Startup verifies the bot with Telegram Bot API `getMe`, checks `getWebhookInfo`, then
   uses `getUpdates` long polling. No public endpoint is needed. **An existing webhook
   blocks startup and is not deleted automatically.** Do not run alongside an existing
   webhook or polling consumer; the operator must switch explicitly. Authentication
   alone does not open polling. Intake starts only after startup approval reconciliation
   in the runtime is complete. If that preparation fails or is stopped while waiting,
   intake stops without advancing the offset or acknowledgement.

```sh
read -r -s TELEGRAM_BOT_TOKEN
export TELEGRAM_BOT_TOKEN
```

The adapter uses the [Telegram Bot API](https://core.telegram.org/bots/api#getupdates).
After durably accepting the source event, the Gateway stores the next offset. Telegram
acknowledges the update when the next poll uses that offset. The Bot API has no chat
history or arbitrary `getMessage` lookup. Recovery is limited to the saved offset and
Telegram's **update retention of at most 24 hours**. It cannot restore arbitrary past
conversations, expired updates, or edits and deletions to old messages. The observation
time of the last accepted update is also stored durably. If at least 24 hours have passed
without an update, the timestamp is missing or invalid, or the clock moves backward,
the next request omits the stale offset. This handles the
[random reset of `update_id` after at least one week of inactivity](https://core.telegram.org/bots/api/types/update.md);
it is not chat history recovery. Do not assume `update_id` keeps increasing across idle
periods. Redeliveries are identified by stable message IDs and callback-query IDs.

Preview and apply the Telegram command menu with the following commands. They do not
start polling or change any webhook.

```sh
bun --no-env-file src/cli.ts telegram-commands --config config.local.json
bun --no-env-file src/cli.ts telegram-commands --config config.local.json --apply
```

Only the owner scopes for the 1:1 DM and verified allowed groups are updated. Other users
and scopes are preserved. A `/status@botusername` command sent from a group menu is
treated as `/status` only after checking the actual command entity and bot username.
Commands targeting other bots are ignored. Message ID, topic, and durable offset boundaries
are unchanged. Select a language-specific list with a flag such as `--language ko`.
The Telegram API cannot enumerate every existing language override, so it cannot
guarantee cleanup for languages you did not select. The official API methods are
[setMyCommands](https://core.telegram.org/bots/api/methods/setmycommands) and
[getMyCommands](https://core.telegram.org/bots/api/methods/getmycommands).

### 2.3 Slack

1. Create a [Slack app](https://api.slack.com/apps) and enable
   [Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode).
   Grant **`connections:write`** to an App-Level Token for that same app to get an
   `xapp-…` token. The Bot Token is a separate **`xoxb-…`** token. Do not substitute a
   user token.
2. In OAuth & Permissions, configure these Bot Token Scopes and install the app in
   the workspace. Reinstall after changing scopes. Grant the read and history scopes
   for the channel types you use.

   | Purpose | Bot scope |
   | --- | --- |
   | Send messages and verify the owner | `chat:write`, `users:read` |
   | Acknowledge receipt and show processing reactions | `reactions:write` |
   | Identify public and private channels and 1:1 DMs | `channels:read`, `groups:read`, `im:read` |
   | Recover known conversations and threads and check approval cards | `channels:history`, `groups:history`, `im:history` |
   | Inspect and download attachments and upload long output | `files:read`, `files:write` |

3. Enable Event Subscriptions and subscribe to the bot events **`message.channels`**,
   **`message.groups`**, and **`message.im`**. Enable Interactivity too. Events, Block Kit
   buttons, modals, and registered commands arrive through Socket Mode; no public
   Request URL or web server is required. Commands also need the bot OAuth `commands` scope.
4. Set `teamId` to the `T…` workspace ID, `ownerId` to an active human `U…` or `W…`
   user ID in that workspace, and `allowedChannelIds` to `C…` or `G…` channel ID strings.
   Invite the app to the allowed channels. At startup the adapter checks the bot and
   workspace via `auth.test` and the owner via `users.info`. The ordinary operator route
   does not accept input from other workspaces, users, bots, or apps; only the owner's
   1:1 DM is allowed separately from the channel allowlist. Registered restricted groups
   follow separate `groupRooms` rules. Group DMs are unsupported. An empty array blocks
   workspace channel input.
5. In ordinary Slack messages, use **`!new [request]`, `!main`, `!stop`, and `!resume`**.
   The adapter normalizes them to the shared runtime controls. Slack's composer can
   intercept commands such as `/new`, so do not give operators the Discord or Telegram
   `/` forms as Slack controls. Commands registered in Slack's picker use
   **`/superagent-<command>`**, for example `/superagent-new`, `/superagent-main`,
   and `/superagent-status`, to avoid conflicts with built-in Slack commands.

Command registration needs an **app configuration token**, separate from the bot token and
the `connections:write` app token. Put it in an environment variable or private credential
file. Pass the variable name, not its value, for `NAME` below. The first call is read-only;
only `--apply` replaces the manifest command list.

```sh
bun --no-env-file src/cli.ts slack-commands --config config.local.json --manifest-token-env NAME
bun --no-env-file src/cli.ts slack-commands --config config.local.json --manifest-token-env NAME --apply
```

Registration looks up the current bot, workspace, app identity, and manifest, applies
changes only to that same app, and preserves other settings. At runtime the Rust Gateway
compares the app ID from `bots.info` with Socket Mode's `hello.connection_info.app_id`.
On reconnect, commands are not accepted until the app identity has been verified and
matches. Check `commandsGrant`, `requiresReinstall`, and `permissionsUpdated`. Saving
the manifest alone does not establish that the current installation's OAuth grant changed.
Complete any required reinstall or approval separately. The implementation uses the
official [manifest API](https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests)
and [Socket Mode commands](https://docs.slack.dev/apis/events-api/using-socket-mode#command).
API failures and uncertain updates are not retried automatically. Tokens and `response_url`
are not written to logs or the coordination database.

Slack slash commands are not messages and have no source `ts` or thread. Invocations are
deduplicated using a token-free fingerprint, and results go to the original allowed
conversation's outbox. The DM topic boundary falls after the last durably accepted actual
owner message. Commands with the same anchor follow admission order. The system does not
represent that as a fabricated Slack timestamp or platform-wide send order. Edits to
existing messages stay in the original topic.

```sh
read -r -s SLACK_BOT_TOKEN
read -r -s SLACK_APP_TOKEN
export SLACK_BOT_TOKEN SLACK_APP_TOKEN
```

The Rust Gateway uses [Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/)
and the [Web API](https://docs.slack.dev/apis/web-api/). Registration uses a one-off Rust
REST command from the same distribution, without starting Socket Mode or the Gateway daemon.
Thread lookup follows the bot history scopes in the current official
[conversations.replies](https://docs.slack.dev/reference/methods/conversations.replies/)
documentation. Do not assume the former restriction that a bot token can never read
channel threads. Actual access permissions, workspace retention, and API rate limits
still apply.

### 2.4 KakaoTalk (local bridge, owner one-to-one only)

> **Terms of service risk.** KakaoTalk has no official bot API. Automating a personal
> Kakao account is not an official integration, can violate Kakao's terms of service,
> and may lead to account restriction or suspension. The operator chooses and runs the
> bridge and is responsible for it. Use a separate account where possible and do not
> automate other people's chats.

This adapter **never signs in to Kakao** or contacts Kakao servers. A **bridge** that
the operator runs on the same machine owns the Kakao session. It records only the
messages the owner sends in the owner's one-to-one chat; the Gateway reads that inbox
and replies through a bridge endpoint that only delivers to the same chat. The
repository ships only a [reference bridge](../scripts/kakao-reference-bridge.ts) that
does not connect to Kakao. The request/response contract and security requirements
for a real bridge are in the [KakaoTalk bridge protocol](kakao-bridge-protocol.md).

- Example:
  `"kakao": {"bridgeUrl":"http://127.0.0.1:PORT","tokenEnv":"KAKAO_SUPERAGENT_TOKEN","botUserId":"…","ownerId":"…","chatId":"…"}`.
  `bridgeUrl` accepts only the literal addresses `127.0.0.1` or `[::1]`; host names such as
  `localhost` are refused. `botUserId` is the bridge account, `ownerId` the owner, and
  `chatId` their one-to-one chat.
- The token named by `tokenEnv` is dedicated to this interface: at least 24 characters
  from `[A-Za-z0-9_-]`. Do not reuse a token that opens other bridge features.
- Supported: text input and replies (Markdown converted to plain text, split into
  1500-character chunks) and DM controls such as `/new`. Unsupported: threads,
  attachments, reactions and approval cards. When an approval is needed the adapter
  sends a notice and **cancels** it; it never accepts on the owner's behalf.
- Delivery requires a verified bridge destination and a Kakao message receipt
  for every chunk. A queue acknowledgement or partial send is not confirmation.
- The adapter never executes messages flagged `stale` and attempts one notice.
  First contact never replays earlier history.
- `groupRooms` cannot use kakao. `omp-sa setup` does not ask about kakao; add the block
  to the configuration file manually.
- Local check: `KAKAO_SUPERAGENT_TOKEN=… KAKAO_BOT_USER_ID=900 KAKAO_OWNER_CHAT_ID=777 KAKAO_OWNER_ID=42 bun scripts/kakao-reference-bridge.ts`
  prints its base URL on the first line. `POST /demo/owner-message` injects an owner
  message, and replies are printed in the terminal.

### Message Receipt and Processing Reactions

For work that needs a new lane, confirm the scope and working directory, then first
send a **short kickoff describing what will be done and how** to the assigned thread or
topic. The required `lane_start` `kickoff` is an external report in the user's language,
separate from the internal English `brief`. Lane execution does not start until the
delivery receipt is confirmed. Failed or uncertain delivery puts execution on hold;
the kickoff is not resent automatically. Answer questions that need no repository in
the original conversation. Ordinary messages in a bound topic continue the existing work.
Private chats without native topic support retain the existing logical topic constraints.

In a Discord forum, you can ask “Create a new work post with the bug tag.” For existing
work, you can ask “Rename this thread,” “Archive this thread,” or “Reopen it.” The head
uses `thread_inspect` to look up actual tag IDs and current state. It sets
`lane_start.appliedTags` for a new post and uses `lane_thread_update` for an existing
managed thread. Specifying tags replaces the complete set; omitting them preserves the
set. A forum with required tags does not accept an empty tag set, and nonexistent tags
cannot be specified. Managing an existing thread or using moderated tags requires the bot
to have **Manage Threads**. The system does not change server permissions automatically
or support thread changes in DMs, on other platforms, or in unregistered threads.
Archiving and reopening are separate from stopping, completing, and resuming a lane.
They can affect delivery of an active lane's reports; do not auto-archive on completion
alone. If a change result is uncertain, look up the current state and make any correction
through a new explicit request. Do not resend the same request automatically.

A Discord work thread shows `⏳` in its title while it has running or queued requests,
unresolved approvals, or results awaiting delivery. After the last run succeeds and
delivery of the final reply is confirmed, the marker automatically changes to `✅`.
This means the request result was delivered; it does not mean the lane was closed or
the work's acceptance criteria were independently verified. Explicitly completed lanes
also show `✅`. A new follow-up changes it back to `⏳`; stopping or cancelling clears
the marker. On startup, the service reconciles existing thread markers from its saved
records. Work and reporting continue if the bot lacks **Manage Threads** or a title
update fails.

For long work, the system sends concise **interim progress reports** to the same work
thread after kickoff. For direct topic work where the lane replies in the user's
language, and for direct HEAD work, the controller delivers interim messages through the
existing send path. With a review-style handoff, HEAD reviews the lane's internal reports
before relaying them. Lane execution does not pause for reporting or wait for a head
reply. Reports occur at meaningful execution boundaries, not on a fixed heartbeat.
There may be no new report if the model or a long-running tool has made no new
progress or HEAD has not finished reviewing. There is no additional watch model,
periodic wake, or full log forwarding. Applying updated role instructions to an existing
Host requires a separately authorized restart. A source change alone does not update the
running service.

In a bound topic, `/status` (Slack `!status`) shows stored evidence and wait observations
along with native state. The head can see the same information with `lane_inspect`.
`lastReportAt` is the structured report time. `lastEvidenceAt` is the last time selected
file contents or a successful native tool result changed. Ordinary activity, repeat
reports, and different call IDs with the same result do not advance the evidence time.
`waiting.target` is the actual tool, approval, or job ID, or the dependency name.
`waiting.since` is the first time that wait was reported. Repeated reports of the same
wait preserve the timestamp, and ordinary `progress` does not clear it. Only completion
of the matching native tool or approval, or a `resolved` report with both the target
and evidence, clears the wait. Jobs and dependencies use an explicit `resolved` with
evidence.

If `observationState.ownerCurrent` is false, the record is historical, not evidence of a
current wait in the connected execution. It also says nothing about Host connectivity.
`lane_inspect` and `/status` separately report `queueHolds`, including whether the
runtime is blocked (`runtimeBlocked`), `uncertainInputIds`, and the delivery ID and
status of any unconfirmed kickoff (`kickoff`). `lane_inspect` returns durable hold
information even if the connected Host's state cannot be confirmed. `/status` in a
bound topic still returns queue information if HEAD's state cannot be confirmed.
`lane_message` returns the durable input ID and state. When it returns `pending`, it
also shows uncertain IDs for earlier inputs or inputs joined to the current execution,
and any runtime or kickoff blocks. `pending` does not guarantee native delivery or
execution.

Elapsed time is calculated at query time and is null if the clock moves backward. Only
the root lane's `lane_report` selects and hashes actual files or tool results and records
them in the native journal. In `eval`, finish the report cell before entering a long
wait so the head can collect it at that boundary. On restart, the system checks the same
original input/request/session/file/generation and the pre-submission cursor before
reading uncollected records and deduplicating them. Native children cannot use the
reporting tool. An observation is not verified acceptance or proof the target is still
alive. It does not create a watch model, timer, automatic reminder, resume, or stop.

The Gateway adds a receipt reaction after durably accepting an allowed source message.
It can acknowledge receipt even without a head. Waiting for a reaction API response
does not delay platform acknowledgements or offsets, model execution, or replies.
Redelivery of the same input does not trigger another receipt reaction attempt.

| Platform | Accepted | Native processing | Finished, stopped, or waiting for approval |
| --- | --- | --- | --- |
| Discord | 👀 | Keep 👀 and add 💭 | Remove only the bot's own 💭 |
| Slack | `eyes` | Keep `eyes` and add `thought_balloon` | Remove only the bot's own `thought_balloon` |
| Telegram | 👀 | Replace with 🤔 | Return to 👀 |

Telegram uses 🤔 because 💭 is not on its
[allowed reaction list](https://core.telegram.org/bots/api/types/reactiontypeemoji.md) and
[bots can set only one reaction per message](https://core.telegram.org/bots/api/methods/setmessagereaction.md).
Chat reaction restrictions or a service message can cause rejection. Discord uses
the [API for its own reactions](https://docs.discord.com/developers/resources/message#create-reaction).
Slack uses [`reactions.add`](https://docs.slack.dev/reference/methods/reactions.add) and
[`reactions.remove`](https://docs.slack.dev/reference/methods/reactions.remove).
Existing Slack apps must be reinstalled in the workspace after adding `reactions:write`.

Reactions apply only to the original account, conversation, and message. The system
does not fabricate a reaction in a new lane thread or on an internal report. When runs
for the same message overlap, whether from edits, head work, or lane work, the processing
indicator clears when the last run ends. It returns after a native approval response.
Permissions, rate limits, and network errors are recorded only as diagnostics without
secrets. They do not turn intake or replies into failures and are not retried automatically.
A reaction does not verify task success or completion and is not a platform read receipt.
Remote reaction cleanup is not guaranteed after a forced stop or API failure.

## 3. Configuration

### Terminal Setup

Run the following wrapper from the prepared checkout. This is an independent implementation
inspired by Hermes's `/dev/tty` setup entry point and its use of hidden input and a separate
environment file. It does not run the Hermes installer or install a Gateway service.

```sh
bash scripts/setup.sh
# Use a different path:
bash scripts/setup.sh --config /absolute/path/to/config.json
# Equivalent direct CLI invocation:
bun --no-env-file src/cli.ts setup --config config.local.json
# Disable automatic loading in the outer Bun process when using the package script too:
bun --no-env-file run setup
```

`bash scripts/setup.sh --help` prints help even without a controlling terminal. Actual setup and
token entry still require a terminal; without one, setup refuses to proceed and saves nothing.

The wrapper defaults to `config.local.json` in the checkout. For a new configuration, select the
platforms to use and enter the owner IDs, Slack workspace ID, optional group or channel allowlists,
actual `headCwd` and `stateDir` paths, and execution budget. An empty group or channel allowlist
does not allow everyone in: group access remains blocked under the existing policy. Setup gets the
OMP path from the separately installed stock CLI and the suggested budget values from the existing
`config.example.json`. It does not set up model providers, presets, or accounts.

Tokens are entered without echo on the controlling terminal and are not committed until the final
save confirmation. Ctrl+C or EOF cancels setup. If no terminal is available, setup does not fall
back to an input method that echoes secrets. An existing valid JSON configuration is not rewritten.
Setup prompts only for the configured credential names. Press Enter to keep an existing value;
changing an existing credential requires a separate confirmation.

Credentials are saved to `<config path>.env` with mode `0600`, for example `config.local.json.env`.
This is a plaintext secrets file for the current OS user, not an encrypted store. Do not put it in
Git, shared folders, or support logs. Unlike a default `.env`, this file is not automatically
loaded by Bun from the working directory. Only `start` and `doctor` read it, using a standard dotenv
parser, and pass only the configured credential names into the environment. They do not use shell
`source` or `eval`. A nonempty value in the existing shell takes precedence over the file; remove the
old value from that shell variable to use a newly saved token. Secrets files that are symbolic
links, belong to another owner, or have public permissions are rejected. Values do not appear in
diagnostics or error messages.
The wrapper, the direct CLI commands below, and newly generated native Bun commands use
`--no-env-file` to disable automatic loading of unrelated `.env` files from the working directory.
If you invoke Bun without that option or retain an older configured Bun command that omits it,
Bun may read environment files before the application starts. The credential loader cannot tell
those values apart from the original shell environment or undo the loading.
An outer invocation such as `bun run setup` without the option can pass down values that were
automatically loaded before the wrapper started, so use the invocations shown above.
The OMP library's own handling of project dotenv files is separate from Bun's automatic loading
option. Setup and diagnostics do not import that runtime module. `start` loads the Gateway module
only after validating the required credentials from the explicit environment or selected secrets
file. This does not change OMP model providers' existing environment resolution policy and is not
a security boundary that protects the secrets file from the same OS user.

Credential updates are serialized with `<config path>.env.lock`. While holding the lock, setup
checks that the original file it read has not changed. It does not take another setup process's
lock or overwrite changes made in the meantime. If a forced termination leaves a lock containing a
PID, remove it explicitly only after confirming that the corresponding setup process is no longer
running. An owner-only staging hard link left behind while publishing the initial file does not
make the existing secrets file unreadable and is not automatically deleted on read.

Setup does not connect a resident bot, send messages, start or restart the Gateway, register a
service, or change shell configuration. After saving, run `doctor` separately, then run `start`
when you are ready. Local preparation alone does not verify actual token validity or all platform
permissions. Running with credentials supplied only through environment variables remains
supported.

Just before the final save prompt, setup explains that it will replace the Discord and Telegram
profile pictures with the repository's signature mascot. Once you confirm and the local files are
saved successfully, setup automatically uploads `assets/superagent-avatar.jpg` for both new
configurations and existing credential updates. This distributed asset was converted from the
original WebP to a JPG with a white background; no separate image conversion tool is needed.
Setup uses only [Discord Modify Current User](https://docs.discord.com/developers/resources/user#modify-current-user)
and [Telegram setMyProfilePhoto](https://core.telegram.org/bots/api#setmyprofilephoto). It does not
start the Gateway, polling, Socket Mode, or an OMP session, and does not send messages. `doctor` does
not call these APIs. Declining before save, cancelling, or a save conflict prevents the profile
calls too.

Setup resolves the configured credential names with the same shell precedence as `start`. If an
old token remains in the shell, the picture changes for that token's bot, not for the token just
saved to the file. Setup checks the actual bot identity before uploading. On Discord, it verifies
that a GET returns the avatar ID from the upload response. On Telegram, it checks for a successful
response and checks the current photo through `getUserProfilePhotos`; it does not verify that the
photo is byte-for-byte identical. If an update fails, the CLI exits unsuccessfully and preserves
the local save. It does not print tokens or raw API errors. The change may already have taken
effect on some platforms, so check the actual pictures before deciding whether to rerun setup.
There are no automatic retries. Cancelling aborts the request in progress and skips the remaining
platforms.

On Slack, [users.setPhoto](https://docs.slack.dev/reference/methods/users.setPhoto/) changes the
photo of the user whose token is used; there is no official app icon upload API for the current bot
or app tokens. If Slack is configured, setup ends by showing where to upload the same JPG
manually: `https://api.slack.com/apps` → select the app → **Basic Information → Display Information → App icon**.
Setup neither presents per-message icons as automatic profile picture setup nor changes a user's
personal picture.

**Managed heads and lanes require a supported OMP memory backend whose effective setting is not
`off`.** If a backend is already enabled, it is left as is. Existing Superagent configurations
follow the same rule. `setup`, `doctor`, and Gateway startup and restart check the head's working
directory and the profile and configuration overlays of the OMP it will run. The Gateway checks
before connecting to messengers. New head and lane Hosts check their own working directories and
actual launch configuration before running stock OMP.

If the effective setting is unset or comes from a global `off`, setup explains before final save
that it will set only the global `memory.backend` for the selected native profile to `mnemopi`.
There is no separate confirmation prompt for memory. The change is applied only after you approve
the final save and the local files are saved successfully. Declining, cancelling before save, or a
save conflict prevents it. Gateway startup and restart and new Host launches use the same rule for
filling in the default. `doctor` is read-only. If memory is still off or the effective setting
cannot be determined, it exits with a nonzero code. It does not write settings even if startup
could fill in the default.

If a `.env` in the working directory points to a different profile directory, setup does not
automatically write the global settings there. It can still use an already enabled backend. If
automatic configuration is needed, specify the profile explicitly in the launch arguments or
environment. The runtime does not write settings if it reuses an existing Gateway or if startup
authorization fails. `/restart` only reads settings until the old Gateway has exited. If settings
cannot be written after process exit and the ownership transfer are confirmed, the restart fails.
It does not automatically start the bot or the old process again.

Before writing global settings, the runtime takes the native lock and checks that the settings it
previously inspected still apply. After saving, it reads the effective setting again. It does not
overwrite intervening changes or bypass `off` or an explicit unset in a project setting or a
higher-priority overlay such as `PI_CONFIG_FILES` or `--config`. The memory database, scope,
embedding, LLM, and auto-save options, and existing memories are preserved. If a usable backend
still cannot be confirmed, startup is blocked. In that case setup exits with a nonzero code while
keeping the saved configuration and credentials. Fix the cause in the applicable native profile
and working directory, then run `doctor` again.

This preflight does not initialize a memory backend, call or download models, or open account
stores. If only unmigrated native settings or account stores remain and the effective backend
cannot be determined, no automatic change is made. Migrate the settings with stock OMP under the
selected profile, then try again. To set the global value manually, use stock OMP's
`config set memory.backend mnemopi` and check higher-priority settings separately. A global change
can also affect ordinary OMP sessions. Subsequent use of memory can store or retrieve long-term
memories or use or download models, as specified by the native settings. A diagnostic saying the
backend is enabled does not establish that retrieval succeeds. Looking up past work from another
operator channel requires Mnemopi to be active and searchable on the head.

After saving a new configuration successfully, setup checks the native settings in the head's
working directory in read-only mode, regardless of the memory setup outcome. If there is no
effective `modelRoles.judge`, it **recommends selecting one in regular OMP under `/models` → Roles
→ Judge**. Existing global, project, and overlay selections and alias or selector chains are
preserved. If a higher-priority layer clears the role, setup respects that effective state.
A settings read failure is reported as "could not determine," not "unset." Setup checks only
whether the role exists, not model or authentication availability or whether a judge call works.
It does not automatically change the model, fallback, or timeout, or open the account database.
A selector chain consisting only of commas and whitespace counts as unset. If there is no current
global settings file and only legacy `settings.json` or `agent.db` remains, setup reports that
the effective role could not be determined. It only checks whether the legacy files exist; it
does not read or migrate them. The precedence of explicit higher-layer role selections or clears
and current global settings is preserved.
The messenger `/model` command controls the model for the selected session; it is not recommended
as a substitute for setting a persistent judge role. Neither this check nor the recommendation
runs when updating tokens in an existing configuration, cancelling, or failing to save.

### Manual Configuration and Fields

For manual setup, copy `config.example.json` to `config.local.json` and replace **all paths and
`REPLACE` values**. The example has one block per platform. **Remove the blocks you will not use**
and leave at least one. The ID placeholders in each retained block are intentionally invalid
platform IDs; startup will fail until you replace them. An existing Discord-only configuration
remains valid. There is no field for the token itself.
During the dedicated initialization turn on explicit `start`, the existing head uses the native
mechanism to initialize only missing high/middle/low presets and reads back whether initialization
completed. Do not add a separate preset block to this configuration file.

| Field | Meaning |
| --- | --- |
| `command` | Argument vector for the separately installed, unmodified OMP executable. This is not a shell command string; shell variables and `~` are not expanded. Setup finds the installed CLI on `PATH` and recommends an absolute path that works regardless of the launch working directory. |
| `stateDir` | Short, dedicated path owned by the current user. Stores sockets, the SQLite ledger, sessions, logs, and attachments. Do not use a shared or symlinked directory. A socket path longer than 100 bytes is rejected. |
| `headCwd` | Existing directory where the head runs. It is not the default repository for requests; each lane's working directory is selected separately based on verified work scope. |
| `maxHosts` | Budget for resident Hosts, including one head. Required integer, minimum 2. Work above that limit waits. |
| `maxSubagents` | Native task concurrency budget distributed across all Hosts. Required integer, at least `maxHosts`. The per-Host limit is `floor(maxSubagents / maxHosts)`. |
| `idleMs` | Time in milliseconds before safely settled idle lanes are reclaimed. Required nonnegative integer. Does not apply to the head and does not remove session history. |
| `model` | Optional OMP model identifier for starting the head. If omitted, existing OMP settings apply. This is not the default for all new lanes: select each new lane's model or preset through `lane_start`. Resuming a lane keeps its saved selection. |
| `discord` | Optional block. If present, `tokenEnv`, `ownerId`, `allowedGuildIds`, and `allowedChannelIds` are all required. |
| `discord.requireAddressing` | Optional boolean, default `false`. With `true`, in parent channels of allowed servers and threads not created by this bot, only ordinary messages from the owner with an actual mention of this bot or a reply to a message it sent are accepted. |
| `discord.editProgressInPlace` | Optional boolean, default `false`. With `true`, intermediate progress updates for a Discord request edit one `⏳` status message in place instead of posting new messages. |
| `telegram` | Optional block. If present, `tokenEnv`, `ownerId`, and `allowedChatIds` are all required. Keep the minus sign on group chat IDs. |
| `slack` | Optional block. If present, `botTokenEnv`, `appTokenEnv`, `ownerId`, `teamId`, and `allowedChannelIds` are all required. |
| `groupRooms` | Optional list. Enables the group modes below only for the specified rooms and users. Even the operator has only ordinary group permissions in those rooms. Defaults to an empty list. |

Relative paths for state and working directories, and relative executable paths containing a slash
in `command[0]`, are resolved relative to the configuration file. The rest of the `command`
arguments are not rewritten this way. An absolute executable path is recommended.
Do not point to an OMP CLI in a source checkout or a locally patched binary. Use a supported,
separately installed stock CLI.

The example values `maxHosts: 4`, `maxSubagents: 8`, and `idleMs: 300000` are adjustable examples,
not hard-coded defaults. This example budgets up to three lanes in addition to the head, with task
concurrency of two per Host. These are not hard limits on CPU, memory, token costs, or disk
allocation. The operator manages retention of saved records and downloaded files and their disk
usage.

### Group Chat and Server Access Separation

For a room added to the existing platform allowlist, also specify its exact platform, server, and
channel IDs in `groupRooms`. Existing operator routes not on this list behave as before. Other
channels in the same server are not opened automatically. The same rules apply to threads and forum
topics under a registered parent channel. Use your own DM or a separate operator channel for
administrative commands, approvals, and sending result files.

```json
{
  "groupRooms": [
    {
      "platform": "discord",
      "guildId": "1234567890",
      "channelId": "1234567891",
      "userIds": ["1234567892"],
      "mode": "request",
      "dailyLimit": 10
    }
  ]
}
```

- `platform` is `discord`, `telegram`, or `slack`. For Telegram, put the same negative group ID in
  `guildId` and `channelId`. For Slack, use the configured `teamId` as `guildId`. Use actual user
  IDs, not display names, in `userIds`. Include the operator's ID too if they need to use restricted
  mode. A server admin role does not grant access.
- Calls from unauthorized IDs are neither accepted nor run, including slash commands. On Discord
  and Slack, registered slash commands may be visible in the app menu, but nobody can run them in a
  restricted group. Authorized IDs can only use the one command configured for that room:
  `!request`, `!ask`, or `!work`.
- `request`: `!request <request text>` only acknowledges receipt; it does not run a model or tools.
  The operator can inspect the original locally with `omp-sa group --config FILE` or
  `omp-sa group REQUEST_ID --config FILE`. To run a reviewed request, the operator starts it as a
  new request in their own allowed conversation.
- `chat`: `!ask <question>` sends only the current question to a separate OMP run and returns a
  short text answer. It does not use a working directory, tools, past conversations, or operator
  memory. Set `model` to an exact `provider/model`.
- `work`: `!work <task>` uses `model` and the repository the operator specified in `repository`.
  Only after the acknowledgment has actually reached the same room does it read and edit allowed
  files in a separate Git worktree created from a commit in that repository. It does not run shell
  or test commands, or commit, push, or merge in Git. The group sees only predefined status updates.
  The operator checks the actual diff and worktree location locally with
  `omp-sa group REQUEST_ID --config FILE`. A terminal status does not mean the changes have been
  verified or approved for deployment.
- With Telegram privacy mode enabled, use `/request@BotUsername`, `/ask@BotUsername`, or
  `/work@BotUsername` with the bot's actual username. Editing an input does not create a new job.
- `dailyLimit` is the daily admission limit per room in UTC. Only one `chat` or `work` execution
  runs at a time, using a spare slot in the Host budget. Put separate OMP model credentials for
  groups in `stateDir/groups/models.yml`. The operator profile is not inherited. Specify only
  repositories and data that may be sent to this model. A worktree is not an OS sandbox. Do not
  apply unreviewed files to the original checkout or run them.
- Configuration changes take effect the next time the Gateway starts. Interrupted runs and
  responses whose delivery is uncertain are not automatically rerun or resent. Messages already
  made public before switching to group mode are not deleted.

Rooms in `request` mode do not need a model file. To use `chat` or `work`, make
`stateDir/groups` accessible only to the account running the service (`0700`) and save `models.yml`
inside it with mode `0600`. For example, for an OpenAI-compatible API, use the following
configuration and set the room's `model` to `group-provider/EXACT_MODEL_ID`. Replace the URL,
key, limits, and prices with your provider's actual values. A dedicated group API key and
provider-side usage limits are recommended in place of operator credentials.

```yaml
providers:
  group-provider:
    api: openai-completions
    baseUrl: https://provider.example/v1
    apiKey: REPLACE_WITH_GROUP_ONLY_API_KEY
    models:
      - id: EXACT_MODEL_ID
        name: Group model
        contextWindow: 32768
        maxTokens: 4096
        cost: {input: 1, output: 4, cacheRead: 0, cacheWrite: 0}
```

Group questions and tasks make real model calls and may incur provider charges. Local time and
cost limits constrain execution but cannot cancel charges for a request already submitted or
guarantee the amount the provider bills.

## 4. Commands and Daily Use

The CLI executable is `omp-sa`. Install the global package as described above, or register the
prepared checkout with `bun link`. Put the corresponding global bin directory on `PATH` to run
commands such as `omp-sa --help` and `omp-sa status --config config.local.json`. The project and
package name remains `omp-superagent`. The direct invocation from source shown below runs the same
CLI. Both invocation methods disable automatic `.env` loading.

For the management commands below, pass `--config FILE`. Start with diagnostics that do not start the
bot:

```sh
bun --no-env-file src/cli.ts doctor --config config.local.json
bun --no-env-file src/cli.ts status --config config.local.json
```

`doctor` checks the configuration, the installed OMP version, required CLI capabilities, effective
memory settings, and execute permission for the Host relay. It is read-only. It prints the relay
path this package will use in `hostOwnerExecutable`, the configured platforms in `platforms`,
**a boolean indicating presence** for each environment variable name in `credentials`, and
`messengersActivated: false`. It prints neither token values nor the old Discord-only
`discordTokenPresent` and `discordActivated` fields. It does not verify bot login, model
authentication, or actual task success.
`status` lists the lanes and socket paths in the ledger and reports Gateway and head readiness
separately. A record by itself does not prove that a process is live, that ownership is exact, or
that work is complete.

| Status field | Meaning |
| --- | --- |
| `gateway.ready` | Actual Gateway transport authentication and readiness. |
| `gateway.admissionReady` | Whether the Gateway has passed the first head's native approval recovery barrier and opened durable admission. |
| `gateway.unresolvedEvents` | Count of unresolved ingress events awaiting safe recovery of admission or reply. Ambiguous inputs are not discarded as rejected or completed. |
| `head.pid` | Native head process ID. Does not indicate controller or adapter readiness or work completion. |
| `head.ready` | Whether the head controller gate has been passed and preset initialization is complete. Remains `false` if initialization is incomplete or admission is unresolved. |
| `head.connected` | Connection between the Gateway and the head client. |
| `head.initialization` | Native preset initialization state and details. This is separate from transport login and input admission; only `complete` means initialization has finished. |

Once the Gateway passes the initial admission barrier, it maintains durable admission even if the
head later goes away. `head.ready` or `head.connected` becoming `false` neither closes admission
that is already open nor causes the Gateway to poll the model.

**The following `start` command requests activation of all configured adapters.** `prepare` and
`doctor` do not substitute for `start`. The separate macOS `install` authorizes this `start` to run
at the next login. With actual credentials, `start` connects to all configured Discord, Telegram,
and Slack platforms.

```sh
bun --no-env-file src/cli.ts start --config config.local.json
```

`start` **starts a detached Gateway first**. The Gateway starts the one designated head or
connects to an existing head whose ownership is verified. The sockets, logs, and readiness output
do not constitute receipts for platform login or actual model calls. Check the Gateway and Host logs
listed by the CLI to distinguish the actual errors and states for each stage. The Gateway's local
endpoint is `<stateDir>/run/gateway.sock`; the actual adapter and supervisor logs are in
`<stateDir>/logs/gateway.log`. Do not confuse the native head log with the transport log.
A ready Gateway persists incoming events before ACK even when the head is absent. Unresolved
admissions or replies keep their pending order and appear in `gateway.unresolvedEvents` and as
`head.ready: false`.
Reconnection or redelivery of an admission event does not authorize rerunning the original work or
external effects. Compare the logs and original receipt with the recorded native PID, session ID
and file, and socket inode. Do not start a duplicate managed Host if the existing one is still
alive or its identity is uncertain. Do not work around an unknown or replaced socket by deleting
it. If the runtime crashes immediately after launch but before recording ownership, it may
remain blocked pending manual reconciliation. Not every crash can be recovered automatically, and
restarting does not overwrite the existing head's model with `config.model`.
For the exact contracts, see [admission](design/messaging.md#durable-admission-and-recovery) and
[ownership recovery](../DESIGN.md#startup-readiness-and-shutdown).

When the head runtime accepts authenticated input, it records the original request and
conversation address together. In bound work threads or topics, ordinary messages continue work
in the existing session without going through the shared head model. Input to a topic still
being opened also stays with its existing assignment.

Other ordinary requests go to the shared HEAD unchanged, even if they name a repository. HEAD
answers questions that do not require a repository directly. For repository work, it uses clues
in the request and the conversation context to find and verify the actual directory before
assigning the work. It does not select a default repository or the last active chat or lane. If
the target or scope is still materially ambiguous after checking, it asks a specific question in
the original conversation. A request in an unbound Discord thread is handled in that thread
unless the operator asks to split it out; no sibling thread is created.

A first line of `cwd: /actual/work/path`, `/new` with a task, an exact reply to an assignment
message with a verified path, or an explicit past-work lookup stays on the runtime's assignment
path. An invalid explicit path is not executed. Reusing just the path from an earlier task does
not import the previous conversation. If the assignment flow needs to confirm the working
directory, reply to the original question with the repository name or absolute path to continue
the **original request**. Lanes do not have messenger credentials. To compare multiple topics or
explicitly address the shared HEAD, use `/head <request>` (Slack: `!head <request>`).

**Change the shared reply voice (SOUL)** by telling HEAD in a fresh message:
“From now on, answer like an editor, formally and briefly, with the answer first.”
There is no required SOUL keyword. In a bound work thread only, address HEAD
with the existing `/head` prefix (Slack: `!head`); ordinary messages there
still go to the lane. “Reset your reply style” restores the default. Check the tool's saved
revision in HEAD's confirmation. The setting survives restart and applies to
new HEAD and direct lane replies, not messages already being written, internal
reports, or code-generated status/approval messages. One-off requests are not stored.
The supported concepts are editorial, mentoring, and plain. They do not change
models, identity, tools, approvals, or workflows.

If Mnemopi is active and searchable on the head, you can describe when the work happened and what
it was in another operator channel or DM, for example: `Continue where we left off with the login
bug last week`. You do not need a repository name, the original message link, or `/new`. The head
first uses **OMP Mnemopi `recall`** from its profile to find leads, then checks them against original
work sessions that this instance is allowed to access. If retrieval succeeds but returns no
memories, the head can still search the original sessions. If another backend is in use or the
lookup fails, the runtime does not guess an assignment through this path. If there are several
candidates, answer the question with a number.
Input that needs a past-work lookup is durably accepted by the head before the separate search
runs. Later ordinary input in the same physical channel or DM stays in order while the lookup is
pending, but other conversations are not blocked.
`recall` uses the memory bank scope configured for the head; it does not open private banks
belonging to other projects. Raw memories are not sent to chats or new sessions. When continuing
from another channel, only the previous repository and evidence relevant to the task are passed to
an independent session in the current conversation. In an already bound Discord work thread, no
new session is opened; only verified evidence goes to the current lane, and the question, work,
and answer stay in that thread.
For a past-work selection question in that thread only, if no answer arrives within five minutes
after confirmed delivery, the runtime prefers the current session among verified candidates, then
the most recent candidate in the same working directory. If none is valid, it uses only the
current lane's context. An on-time selection takes precedence. This timeout does not move the
work to another directory or substitute for approval. Ongoing work and approvals are not
transferred from the original session, and the full previous conversation is not posted to the
messenger. `last week` means the seven days immediately before Monday at 00:00 UTC of the week
containing the request.
The operator does not need to create a thread in advance. In channels that support work threads,
the bot sends the result there; in ordinary Discord or Telegram channels that cannot create
threads, it replies in the same channel. A generic `Continue` is still a follow-up to the current
topic.

**Ordinary follow-up input defaults to steering.** Conversations served by HEAD, such as the main
channel, go to HEAD; a bound work thread goes to its lane. `/head <request>` explicitly targets
HEAD even in a thread. If work is running in the same conversation, the input is applied at the
next OMP steering boundary without `/steer`. If idle, it starts a new run. The first reply just
after opening a thread can also join the original run if that thread is confirmed as the run's
reply route. Admission of a message or acceptance of an RPC call does not prove the model read
the input. Other conversations, internal reports, workflow selections, and control commands are
not mixed into the current run. Steering does not bypass pauses, approvals, compaction, or holds
for uncertainty. The original Discord addressing policy still applies, and final replies or reports
for the same run are not sent twice.

**You can request a new topic without a command, too.** When a new lane is needed, an independent
OMP session in the verified working directory is bound to a supported thread or topic. In a
bound Discord server work thread, typing a different `cwd:` alone does not change the path or
thread. To split work into a new thread under the same parent, use `/new <request>` or state both
the split and the task on one plain-text line, such as `Split this into a new thread: Check login`
or `Do the login check in a new thread` (also `이건 따로 빼줘: 로그인 점검` or
`로그인 점검은 새 스레드에서 해줘` in Korean). For work in a different directory, put
`/new cwd: /actual/work/path` on the first line and the task on the next line.
If you leave the task unspecified, as in `Split this into a new thread` (`이건 따로 빼줘`), the bot
asks you to specify the task with `/new` in the same thread and does not create a new thread.
Edited messages, quotes, and attachments do not count as instructions to create a thread.
The plain-text split instruction does not apply in Discord DMs or on other platforms. The Gateway
does not use an LLM for classification or execute lanes.

| Platform | Automatic topic creation |
| --- | --- |
| Discord | Public threads in allowed text and announcement channels; posts with a starter message in forum and media channels. DMs use logical topics. If a forum or media channel requires tags, creation is rejected rather than guessing tags. |
| Telegram | Forum supergroups where the bot is an admin with `can_manage_topics`, or private topics for a bot with `has_topics_enabled`. Unsupported private chats use logical topics; ordinary groups cannot create native topics. |
| Slack | Threads use a real root message's `ts` in allowed channels and owner DMs. Splitting a new topic from an existing thread creates a separate root message. |

Official APIs: [Discord threads](https://docs.discord.com/developers/topics/threads),
[Telegram createForumTopic](https://core.telegram.org/bots/api/methods/createforumtopic.md),
[Telegram bot capability](https://core.telegram.org/bots/api/types/user.md), and
[Slack thread_ts](https://docs.slack.dev/messaging/sending-and-scheduling-messages/#threading).
The runtime does not create channels or servers on its own or change permissions or BotFather
settings. Permission and network failures are not hidden as missing support. If creation or
delivery is uncertain, redelivery does not automatically repeat it.

Send the following as **plain-text commands** on Discord and Telegram. Discord treats registered
slash commands the same way. On Slack, use `!new` and `!main`, or the registered
`/superagent-new` and `/superagent-main`, in the corresponding situations.

| DM input | Behavior |
| --- | --- |
| `/new <request text>` | Accepts a separate topic boundary. Once the working directory is confirmed, prefers creating and binding a native topic. Only unsupported DMs use a logical topic. |
| `/new` | Activates only an empty topic and sends one fixed prompt asking for the request. By itself, it does not call a model or start a lane. |
| Ordinary message | Continues in the selected topic's session, restoring it if necessary and steering active work when applicable. While a topic is being opened, the existing assignment applies. The shared HEAD decides how to handle other ordinary requests. |
| `/main` | Routes future DM input back to the main conversation address. Preserves earlier topics and lanes. Use `/head <request>` to explicitly target the shared HEAD. |

The head can use `lane_start` to hand off even an ordinary DM task it has already accepted to an
independent topic. It keeps ownership of the original head request and creates a separate
handoff. If it creates a native thread, continue the conversation in the indicated thread. With
the logical-topic fallback, subsequent DM input follows that topic. No server needs to be created.
A handoff can also target a server thread that has been explicitly allowed.
In group and workspace channel conversations, `/new` without arguments (Slack: `!new`) sends
instructions for using a new thread or topic. It is not forwarded as OMP's own `/new`.
In a conversation bound to a lane, `/stop` and `/resume` (Slack: `!stop` and `!resume`) pause and
explicitly resume it, respectively. Previously, resuming only reopened the runtime queue. Now an
existing paused native lane goal resumes only when resumption is explicitly authorized. Automatic
reports, reconnection, and new queued input do not authorize resumption. Resuming does not create
a missing goal, clear uncertainty, or automatically replay an interrupted prompt.
Editing an accepted `/new` or `/main` control message does not change the existing boundary, work,
or current topic. The runtime only records the edit and sends a fixed notice asking you to send a
new control message. The same policy applies to Slack's `!` controls. Editing an ordinary work
message creates a new input revision and does not undo external effects that have already occurred.

### Model Selection and Head Effort

In a Discord lane thread, run **`/model` by itself**. In the first dropdown, select **HEAD** or
**the current lane**. Select a provider in the second dropdown; that dropdown then shows the
provider's models. The change only happens when you select a model. If the conversation is not
bound to a lane you can change, you can select only HEAD.
When sending a model ID directly as text, omitting `--lane` changes **HEAD** even in a lane thread.
Discord and Telegram support plain-text `/` commands; Discord also supports registered slash
commands. Slack supports plain-text `!model` and `!effort` and the registered `/superagent-model`
and `/superagent-effort`. There is no separate HTTP endpoint.

| Command | Behavior |
| --- | --- |
| `/model` | Opens the model picker. On Discord, choose HEAD or the current lane; on Telegram and Slack, the picker changes HEAD. |
| `/model list` | Lists chat models selectable with the current native authentication and enabled settings. |
| `/model <provider/model>` | Changes the head model to the exact `provider/model` from the list. |
| `/model --lane <provider/id>` | Directly changes only the model of the idle lane bound to the current conversation. Does not call the HEAD model or rerun a failed request. |
| `/effort` | Shows the current effort and opens the picker for levels supported by the current model. |
| `/effort <level>` | Changes head effort to a level shown by the query. |
| `/model preset` or `/model preset list` | Lists existing native presets, their validity, and their available default models. |
| `/model preset <name>` | Applies all roles and default effort from the named native preset to the idle head session. |
| `/model preset <name> --global` | Also saves the identical snapshot applied and verified on the current head as the native global default roles and effort. |

If a lane model's quota is confirmed exhausted, the runtime notifies the original conversation
once. Follow-up requests in that lane wait for the operator to pick a model. If it is unclear
whether a request ran, verify the original effect, then close the request with the
`/resolve --lane <input-id>` command in the notice. HEAD handles other execution errors, such as
transient 429s, within the original scope of work. Quota exhaustion alone does not change the
HEAD model or global settings.
If the model change response is lost, **open a new `/model` picker in the original Discord lane
conversation, select the current lane, and reselect the same provider and model**. To do this by
text, send a new `/model --lane <provider/id>` in the same conversation. If the change already
took effect, the runtime confirms it rather than applying it again. If the actual model or
ownership cannot be verified, it holds the change. A later report about the previous error does
not overwrite a model you subsequently selected.
If a manually run `/cron pr-review` exhausts its quota, you can change the model in that PR thread. In
that case, selecting the current lane shows only models capable of static review without tools.
Selecting HEAD in the same card shows the regular model list. This does not apply to unattended
PR review.

Discord and Slack use dropdowns, and Telegram uses inline buttons. Opening or paging through a
menu does not change any settings. Menus expire after five minutes or on Gateway restart. If the
head model changes while an effort menu is open, open the menu again. Accepting a click and
completing the change are separate; the result is reported separately in the original
conversation. Text commands still work.

Queries are handled during execution without calling the model. HEAD changes are processed only
when the head is idle and has no pending approvals, goals, background work, owned services,
compaction, or uncertain submissions. Changes are rejected while it is busy; send a new command
after the work settles. The runtime does not automatically interrupt active work to make a change.
After changing the model, effort may be adjusted to the model's native supported range. The
response shows the actual value read back. An unavailable model or effort is not silently
substituted. If native state has no explicit effort, the response shows the model default; this
is not `off`. If the current model advertises `auto`, select it in the menu or enter
`/effort auto`. In automatic mode, the setting `auto` may differ from the effort OMP actually
applies. The option is not shown on older Hosts that do not advertise `auto`, and no fixed
effort is applied in its place.

You can also ask explicitly, for example `/head Change the head model to 6.2 Astra`. The head
checks the available models and applies the change only to the shared head after the current
turn finishes successfully. A response that schedules the change is not confirmation that it
has been applied. The runtime replies to the original message with the actual result. It does
not automatically retry if the original turn is interrupted or if the head is still busy after
the turn ends.

Changes without options preserve global OMP defaults and existing lane selections. All messengers
use the same head, so its future work uses the same changed settings. Restarting the same native
session restores its recorded selection. `--global` is not supported for ordinary `/model` or
`/effort`, and `--once` is not supported at all. Duplicate deliveries do not reapply changes. If a
change response is lost or the actual state cannot be confirmed, the runtime does not show success
or automatically repeat the change. Use `/model` or `/effort` to query the actual state, but a
query does not clear existing uncertainty.

Presets are read from OMP's existing `modelPresets`. The messenger cannot create, edit, or
delete named preset definitions. Any configured name can be used, not just high/middle/low.
After applying a preset, the runtime verifies all roles and default effort against native state.
It keeps only the confirmed per-session settings and removed roles as restart metadata and
restores them through a private settings overlay for the new Host. Active values separately
selected later with `/model` or `/effort` are restored from the native transcript and are not
overwritten with the earlier preset's defaults.
If a preset omits its default effort, the current head session's policy remains in force. The
persistent default is not loaded again. The precedence between an explicit preset effort and a
model selector's effort is unchanged.

**By default, a preset applies only to the current head session.** Only a preset selection with
an explicit `--global` saves the same roles and default effort to native global settings after
the change on the current head is confirmed. It does not change running lanes or explicit
selections in other sessions, or remove configuration overrides for other projects. The change
notice reports the preset name, the actual model and effort before and after, and either
`session-only` or whether the global save succeeded. If the preset was applied to the head but
saving or verifying the global settings failed, the runtime reports those as separate outcomes;
it does not retry automatically or claim success. A change to global defaults can affect new
sessions and paths that inherit those defaults.

### Scheduled Jobs (`/cron`)

Use `/cron` on Discord and Telegram, and `!cron` in ordinary Slack messages. You can
also make a natural-language request, such as “Summarize the CI status at 9 a.m. Seoul
time on weekdays and send it to this conversation.” HEAD registers the job with
`cron_create` and verifies its actual ID and next run time. If the time zone or the task
is unclear, HEAD asks for clarification. Each request registers one job. Manage jobs
created in natural language with `/cron` in the same conversation.
To use registered app commands, put the subcommand in the `text` option of Discord’s
`/cron` or pass it to Slack’s `/superagent-cron`. Rerun command registration separately
to refresh existing app command menus; ordinary message commands do not need this step.

```text
/cron add "in 30m" Remind me to check the build
/cron add "every 2h" Read and summarize the CI status
/cron add "TZ=Asia/Seoul 0 9 * * 1-5" Summarize today's schedule on weekday mornings
/cron add "at 2027-01-09T09:00:00+09:00" Tell me what I need to do today
/cron list
/cron show ID
/cron edit ID "every 4h" Summarize the CI status and why any checks failed
/cron edit ID prompt Summarize the results in three lines
/cron pause ID
/cron resume ID
/cron run ID
/cron remove ID
```

- Schedules use `in` (one time), `every` (at least one minute, using `s/m/h/d`),
  `at` with an explicit UTC offset (one time), or a five-field cron expression.
  Without an explicit time zone such as `TZ=Asia/Seoul`, a cron expression uses the
  host time zone at registration. The list displays the next run time in UTC.
- Manage a job only from the platform, bot account, conversation, and thread or
  logical topic where it was registered. The owner must send a new message. Editing
  an existing message or producing a model reply cannot change the schedule.
- Runs use the same queue as HEAD requests on **shared HEAD**, with its current
  model. Results and approval requests go back only to the original conversation.
  Scheduling does not create a separate session or lane, reuse attachments, or grant
  standing approval. It does not by itself authorize tool use that requires approval
  or any new external effect.
- Direct shell scheduling (`/cron add shell`) is not supported. Scheduling an
  ordinary HEAD task still uses the existing approval flow. Shell jobs registered by
  older builds can be inspected or removed, but cannot be resumed or run. Runs that
  have not started are canceled, and unsent shell output is not posted. If a job had
  already started in an older build, check whether it exited on the original host
  and clear the hold with `/resolve`.
- `run` queues a one-off run without changing the schedule. `pause` and `remove`
  cancel runs that are queued but have not been submitted. To stop a run that has
  been submitted, use `/stop head`. After canceling a queued one-time run, use `run`
  or `edit` to schedule it again. `edit` affects runs queued from then on; already
  admitted runs keep the previous prompt.
- Jobs do not run while the service is down. On restart, at most one missed
  occurrence is admitted per job. Recurring jobs skip overlapping occurrences while
  a previous run is pending or in progress. `/stop head` also holds existing
  schedules; resume the jobs you want individually with `/cron resume ID`. If the
  outcome of a previous run is uncertain, check the original session and clear the
  hold with `/resolve <run-id>` first. Registration, queue admission, and completion
  are distinct states.

#### Reviewing New External PRs (`/cron pr-add`)

**New registrations default to unattended review and a GitHub comment.** The owner
can select a level in the same parent channel without sending a separate start
command for every PR. Each level includes the actions allowed by the previous one.

| Recognized Korean text to send in the parent channel | Equivalent command | Unattended behavior |
| --- | --- | --- |
| `무인으로 리뷰만` (“Unattended review only”) | `/cron pr-mode JOB review` | Review in a per-PR Discord thread and a tool-free OMP lane, then leave only a GitHub review comment tied to that SHA. Do not submit an approving review. |
| `무인으로 리뷰 후 수정커밋까지` (“Unattended review and fix commits”) | `/cron pr-mode JOB fix` | In addition to reviewing and commenting, create a regular commit only if a fix can be applied safely, then review the new SHA. Do not merge. |
| `무인으로 수정커밋후 머지까지` (“Unattended fix commits and merge”) | `/cron pr-mode JOB merge` | If needed, fix and review again. Perform a regular merge only if the final SHA passes review and independent approval, required CI, and branch protection rules are all satisfied. |

If the channel has multiple registered repositories, specify the target with
`/cron pr-mode OWNER/REPO review|fix|merge`. In the actual command, choose one of
the three values. Check the resulting setting with `/cron show JOB`. You can also
select a level by number, for example `PR 자동화 2단계로 바꿔줘` (“Set PR automation
to level 2”).
If `discord.requireAddressing` is enabled, start the message by mentioning the
actual bot or reply to one of its messages in the parent channel. Increasing the
level does not retroactively grant authority to earlier proposals or results.
Discovery-only registrations created by older versions remain manual until you
explicitly select a mode. An older command recovered late by Discord does not
overwrite a newer mode. If a command that omitted the repository has an ambiguous
target, send a new command specifying the repository. Quoted owner messages,
edited messages, PR descriptions, and model output are not configuration commands.
For example, to register `dbc-hbin/omp-superagent`, authenticate `gh` on HEAD as
`dbc-hbin` on `github.com` and send the commands below as the configured owner in
**a parent channel of an allowed Discord server**. GitHub organizations, repositories
owned by someone else, DMs, and existing threads are not eligible. Putting the same
instructions in an ordinary `/cron add` prompt will not enable this feature.

```text
/cron pr-add "every 5m" dbc-hbin/omp-superagent
/cron show JOB
/cron run JOB
```

`JOB` is the ID shown in the registration reply. The first poll verifies the GitHub
repository and user ID and excludes PRs from the authenticated account. Only PRs
created strictly after registration or resumption and still open when polled are
eligible. PRs that open and close between polls may be missed, as may PRs opened
within the same second when their ordering cannot be proven. `/cron run` just polls
once immediately; it does not authorize execution. All PRs found in a poll are
recorded, but at most one notification goes out per poll, for the open PR that has
been waiting longest. The same PR is not announced again after a restart or
re-registration. If delivery is uncertain, check the original proposal and delivery
status with `/cron show JOB PR_NUMBER` in the parent channel.

1. **Parent channel:** In automatic mode, Superagent opens one Discord thread using
   a bot notification with confirmed delivery as the starter message. The bot needs
   permissions to read messages and message history, create public threads, and send
   messages in threads. Forum and media channels that cannot start a thread from an
   existing message are not supported by this automatic flow. The registration message
   is not copied as if it were owner input for each PR. The lane runs only after the
   actual thread and delivery of the starter message are verified. If you need to
   proceed manually, use `/cron pr-review JOB NUMBER SHA` from the notification. If a
   thread is already open for the PR, use that thread.
2. **Created thread:** The lane performs a static review only of the changes fetched
   from GitHub for that SHA. It does not check out the PR branch on the host or install,
   build, or test it. The configured model provider processes the changes sent to the
   model. Replies and fix proposals may contain excerpts of the code and can be seen
   by anyone who can read that Discord thread. Check both disclosure boundaries before
   registering a private repository. Keep `stateDir` outside the Git checkout.
   Restricted mode uses an empty local directory and a stock OMP session with no tools.
   If isolation cannot be verified, for example because of custom launch arguments or
   a model provider with its own execution tools, the job is held rather than moved
   to an ordinary coding lane. Supported native APIs are `openai-completions`,
   `openai-responses`, `openai-codex-responses`, `azure-openai-responses`, and
   `anthropic-messages`. External agent CLIs are not supported.
   Limits are 32 changed files, 16 KiB of patch per file, and 64 KiB of total review
   material. A partial review does not count as approval if a patch is missing or binary
   or cannot be checked against the Git blob and file mode. The default mode publishes
   the final review summary as a GitHub comment tied to the reviewed SHA. Results and
   CI are checked again on the existing cron cadence. Use `/cron pr-status JOB NUMBER`
   to see the result and the available next commands.
3. **If a fix is needed:** Levels 2 and 3 automatically apply allowed proposals. To
   approve one manually, check the proposed file and replacement, then send
   `/cron pr-fix JOB NUMBER SHA DIGEST` in the same thread. The digest identifies the
   change and the full target SHA. A regular commit replaces only a uniquely matching
   string in one allowed ordinary source file under `src/`, `lib/`, `test/`, or `tests/`.
   This does not apply to forks, default or protected branches, or changes whose safety
   cannot be verified. In those cases, the contributor must make the fix in a safe
   environment. Automatic processing reviews the new SHA in the same lane. Automatic
   fixes are limited to one per PR. Up to three distinct SHAs can be reviewed under the
   same policy. If the PR keeps changing or another fix is needed after re-review,
   hand it back to the owner. To continue manually, send
   `/cron pr-review JOB NUMBER NEW_SHA` in the same thread.
4. **To merge:** At level 3, once the final review result has actually been delivered to
   the thread, the system checks the SHA, the current PR and change material,
   independent GitHub approval, CI, and server-side protection rules. `pending` is not
   success; it is checked again on a later poll. To approve an individual merge in
   level 1 or 2, send `/cron pr-merge JOB NUMBER SHA`. This is not standing approval:
   if the conditions are met later, check the status and send a new command. The system
   does not use `--admin`, force-push, or unconditionally queue GitHub auto-merge.

**Supported merge policy:** The PR must be open, non-draft, and target the default
branch. Repository-owned rulesets must cover all branches and have no bypass actors.
The only permitted exclusion is **this PR’s source branch in the same repository,
specified by its exact name**. Only this allows a fix commit on that unprotected
branch followed by a merge into the same repository’s protected default branch.
Wildcards and exclusions for other branches are not allowed, and the bot does not
change rules. The rules must dismiss stale approvals, require approval of the most
recent push, enforce strict required CI, and pin required checks to a GitHub App.
The system checks every required check from the rulesets that actually apply to the
target branch. It does not merge if an observed check has any status other than
`success`, including `skipped` or `neutral`, or if independent GitHub approval is
missing. This flow may be refused for unprotected repositories, configurations with
only classic protection, or configurations that allow only a merge queue or squash
merges. Where direct writes to all branches are prohibited, the contributor must also
apply any proposed fix through an allowed procedure, such as a separate fork. Use
GitHub’s normal procedure rather than weakening protection rules.
Merge requests use the immutable PR node ID and expected head SHA. Fix requests use
the branch node ID and expected head SHA. The head SHA is what GitHub compares
atomically, and the server enforces the rules at write time. The client’s CI lookup
and write are not a single transaction. They do not lock out concurrent changes to
protection settings or the default or target branch, or reruns of checks on the same
head. A merge is not marked successful unless the target and both parent commits
can be verified from the response.

Use `/cron pause JOB`, `/cron resume JOB`, and `/cron remove JOB` in the original
parent channel. `/stop head` also holds discovery and new writes. Resuming a
registration does not restore earlier write approvals or reviews. If the action cannot
be ordered relative to Discord messages, as with `/stop head` from another messenger,
send `/cron show JOB` in the original parent channel, then send `/cron resume JOB`
**as a reply to that bot response**. Use `/stop` separately in the PR thread if you
need to stop an already-running lane. Do not assume a request already submitted to
GitHub has been canceled. If the outcome is ambiguous, use `/cron pr-status JOB NUMBER`
in the original PR thread of the active registration for read-only reconciliation.
If evidence is insufficient, inspect the actual merge or commit history on GitHub and
the original Discord thread directly. `/resolve` and re-registration do not retry
GitHub writes.
If you sent a review command directly in the parent channel and only the thread
creation response was lost, you can send a new message with the **same** `pr-review`
command in the actual thread attached to that message. The thread ID must match the
original message ID, the thread must be active in Discord, and it must not already be
assigned. Even without a physical starter message, as with an app command, this
recovery works if the exact Discord thread ID was already confirmed and saved.
Without either kind of evidence, the system does not adopt a different thread.

### Status, Context, Usage, and Stopping Work

These commands are also ordinary text messages on Discord and Telegram. On Slack,
use `!` instead of `/`.

| Command | What it does |
| --- | --- |
| `/help` | Lists the supported commands and their targets. |
| `/head <request>` | Sends a request explicitly to shared HEAD, regardless of the current topic’s binding. |
| `/status` | Shows shared HEAD’s execution status, the current topic and connected lane, and pending or unresolved inputs and approvals. |
| `/restart` | Checkpoints a busy HEAD, then replaces the Gateway and HEAD. Confirms acknowledgement in the original conversation and an actual safe shutdown, restores the same session and model, and resumes eligible goals safely. Keeps lanes running and holds uncertain effects. |
| `/context` | Shows HEAD’s native context usage and limit. Estimates and unknown values are labeled as such. |
| `/usage` | Shows per-provider account limits, usage, and reset times from stock `omp usage` in the configured profile. This is not session token or cost accounting. |
| `/usage-reset` (Discord), `/usage reset` (Telegram), `!usage reset` (Slack) | Shows the number of reset credits available now by account and in total. Choose an account and press Confirm to use one of that account’s credits. |
| `/compact [content to preserve]` | Compacts the native context of an idle HEAD. Accepts multiline preservation instructions. |
| `/stop` | Pauses the connected lane. In an unassigned conversation, reply to the routing question or the original message of a running request to identify the target. If assignment is pending alongside HEAD execution, or edits point to different lanes, the system gives guidance in the same conversation instead of stopping a target arbitrarily. |
| `/stop head` | Stops shared HEAD work regardless of the current topic. |
| `/stop <lane-id>` | Pauses only the specified lane if it is registered with this instance and authorized. |
| `/resolve [input-id]` | Explicitly cancels **one** HEAD input already marked `uncertain` so later HEAD work can proceed. It does not rerun the original task or claim that it ran or completed. |
| `/resolve --lane <input-id>` | Explicitly cancels **one** exact `uncertain` input for the lane connected to the current conversation. It does not rerun the input, unpause the lane, or restart the Host. |

If the topic **assignment** itself is uncertain, the original conversation shows
the assignment ID. Check the actual thread and delivery result, then clear the hold
with `/resolve <assignment-id>` in that conversation. It does not repeat the
assignment, execution, or delivery.

The Gateway attempts to rotate to a new HEAD session only after it confirms HEAD has
been idle for **at least 30 consecutive minutes** and its native context usage is
**at least 50%**. It does not rotate with outstanding approvals, execution, delivery,
or other unresolved work, or if usage is unknown. This is separate from the lane
`idleMs` setting. See `head.rotation` in `status` for the old and new session IDs
and the rotation stage. Unlike automatic rotation, `/restart` restores the same
HEAD session.

`/usage` with no arguments does not call a model. It sends only the numbers the
installed OMP reports to the original conversation. Remaining limits and reset
times for each provider use the Superagent host’s local time zone automatically.
Results include both built-in and extension-registered providers queried by OMP.
Any `--no-extensions`, `--extension`, `--hook`, or `--config` flags the operator
specified in the launch command also apply when checking or using reset credits.
Accounts show the account or organization name as masked by OMP, or an account
number if no name is available. Unverified limits and inactive accounts are marked
separately. Replies omit full email addresses and IDs, raw JSON, and CLI diagnostics.
CLI lookup failures are distinguished from lookups with no verifiable limits.
On Slack, use `!usage` or the registered `/superagent-usage` command.

The reset-credit menu works when the installed OMP CLI supports using a credit for
a specific account. In the Discord command picker and allowed ordinary chat, use
only `/usage-reset` with no arguments. On Discord, `/usage` with no arguments is
only for checking limits. The old chat command `/usage reset` and the old registered
form `/usage text:reset` are rejected; they do not open the reset menu or start any
model or lane work. After updating the Gateway and HEAD, verify that Discord `/help`
lists `/usage-reset`. Then verify that the read-only `discord-commands` output
includes `/usage-reset` and follow the global registration procedure above. Once
you have checked `/help`, you can send `/usage-reset` in Discord as an **ordinary
chat message** even before registration. Mention the bot or reply to it in channels
that require addressing. On Telegram use `/usage reset`, and on Slack use
`!usage reset` or `/superagent-usage reset`.
Entries such as `Codex · 계정 #7 · al…` (`계정` means “account”) show the account
selection number for the local `omp usage reset` command and a short masked account
or organization name when available. Full email addresses and provider account IDs
are not sent to chat.
Opening the menu, selecting an account, and pressing Cancel cost nothing. The
confirmation card expires after five minutes, and only the operator in the original
conversation can use it once by pressing Confirm. An uncertain result is not retried
automatically. The lookup also shows credits you hold but cannot use right now. To
use a credit for the same account again, check the remaining credits, clear the
original hold with the indicated `/resolve` command (`!resolve` on Slack), and
confirm on a new card.

`/restart` takes no arguments. On Slack, use `/superagent-restart` in the command
picker or `!restart` in an ordinary message. Once the acceptance reply has actually
been delivered, the Gateway handles graceful shutdown and launches a one-shot
successor. The new HEAD verifies that it is ready in the same session and reports
the result to the original conversation. Do not treat the acceptance notification
alone as proof that the restart completed. You do not need to send `/stop head`
first. The restart cancels the busy HEAD’s original approval cards, withdraws queued
inputs, and stops any in-progress turn and goal. It also cancels native background
work owned by HEAD and waits for actual exit. The new HEAD reuses the same session,
working directory, and existing native profile, and checks memory configuration
as on startup. It verifies the same model and effort and continues only the goal
that was active immediately before restart, in its original conversation.
Work already paused or canceled, submissions without receipts, and uncertain
external effects are not replayed. An active goal made idle by no-progress handling
retains the source and route it was created with. If ownership cannot be verified,
the service is replaced but automatic goal resumption is held; the goal is not
rerouted to the restart conversation. Independent lanes keep their original Hosts
and approval identities. Owned work or services that have not exited, or uncertain
ownership, leave a specific hold directing you to check the original HEAD’s native
state rather than forcing it to exit. If the checkpoint was saved but shutdown was
not requested yet, resolve the remaining work and try again with a new `/restart`.
Duplicate deliveries of the earlier command and requests with uncertain shutdown
outcomes are not retried.
If you changed an operational setting such as `idleMs` after startup, use `/restart`
to apply it. Replacement is held if the state directory, HEAD working directory or
OMP launch profile, or messenger access permissions changed, or if the file was
edited again after the request was accepted. Check the Gateway’s refusal reason in
chat.
Before handoff, `/stop head` and an explicit CLI `stop main` take precedence over a
restart and prevent the successor from reviving the service. Even if native OMP is
too busy and refuses the CLI stop, a restart requested before the stop is not
reauthorized. Restart and stop controls and the initial approval recovery barrier
can proceed even with an uncertain approval response waiting at the Gateway.
Ordinary inputs keep their order, and the original answer and its effects remain
isolated. If a question generation still pending in native OMP was canceled, late
answers are rejected. This does not roll back consumed approvals or external
effects. Uncertain delivery, shutdown, and startup are not automatically repeated
for the same request; check the state and the original receipt.

An `uncertain` input continues to block later inputs to the same target without an
automatic retry. HEAD may first attempt the evidence-based automatic recovery
described below. If the result still cannot be determined, only the operator’s
explicit `/resolve [input-id]` can discard the request. `/status` shows the exact
held input ID. If there is more than one hold, `/resolve` without an ID is rejected
rather than arbitrarily picking the latest one.
`/resolve` does not resubmit the original work or claim a result. It tells the
conversation only that the input was closed, then immediately drains the queue
again. If you still need the same work, send a new request. Resolution does not
change the native session, so it works even if HEAD is busy or native state cannot
be verified. The cancellation target is durably pinned before applying the effect,
so a restart mid-operation does not select a different request. Clearing a stored
hold and stopping native execution are separate. Once native OMP is confirmed idle,
the system also clears the in-memory state for the canceled admission and runs
subsequent work while continuing to check the results of other admitted inputs.
In ordinary Slack messages, use `!resolve [input-id]`.

For a lane, find the uncertain input ID via `/status` in the connected conversation.
Check the original session and external effects first. If you choose to close the
input while its outcome remains unknown, send `/resolve --lane <input-id>` in the
same conversation (`!resolve --lane <input-id>` in ordinary Slack messages). Only
the exact matching uncertain input is canceled. The command does not assert the
outcome of the original task or rerun it. Other uncertain inputs or blockers such as
pauses, approvals, connectivity, or ownership problems remain in place. Subsequent
inputs take the normal route only when the lane is open and its native state can be
verified.

#### Evidence-Based Automatic HEAD Recovery

When the exact HEAD request record confirms a Codex `usage_limit_reached` failure
with no tool execution or partial response, HEAD checks OMP’s usage data for that
model about every five minutes. Once a fresh report after the failure shows that
an account usable in the same session has recovered, HEAD cancels only the failed
input and processes subsequent queued inputs in order. The expected reset time
having passed is not enough, nor is unclear cache or account evidence. Recovery does
not spend a reset credit, make a test model call, or resubmit the failed task. Other
failures and uncertain external effects stay on hold.

A HEAD request that ends before any tool starts, such as a model refusal
(`provider_refusal`) or a provider error, is closed as failed without a hold if
confirmed by the same execution record: one request, a failure response without a
tool call, and usage records only. The next request is handled without retrying
the failed one. Quota and usage-limit refusals stay on hold until recovery is
confirmed, even if there is a `session_exit` after restart, a model change, or no
adapter available. Recovery checks after restart also close previously held inputs
of the same kind: after the receipt, only usage records and custom records such
as `session_exit` are allowed. A later message, new execution, or tool start keeps
the hold in place. If any tool started or the records cannot be read, the input
remains held and the failure notice includes the exact `/resolve <input-id>`
command. If a new HEAD message arrives during the hold, the blocking input ID and
`/resolve` instructions are saved with a marker in one transaction and sent once.

When a request outcome becomes uncertain, code first checks native evidence
against the execution identity. If sufficient evidence exists to make a judgment,
the same HEAD runs a separate recovery decision turn in the existing native session.
It does not create another AI supervisor or a new session, or resubmit the original
request. The recovery turn does not start if execution, a goal, asynchronous work,
an owned service, or approval remains outstanding, or if native state cannot be
verified. It responds to actual events, such as reconnection or native exit, and
does not make repeated model calls on the same evidence. The automatic decision
turn is submitted at most once per original input. An input that has not yet been
submitted for recovery because evidence was insufficient may be reconsidered when
a new native receipt arrives, but a submitted recovery turn is not blindly resent.

HEAD uses `head_recovery` to decide whether to clear or keep the hold by reviewing
the original request ID, the receipt tied to the session and execution generation,
that execution’s final result, and the state of related effects. Code checks the
evidence IDs and current state again, so a model’s explanation alone cannot clear a
hold. Confirmed native completion or a recorded native interruption may be
reflected in coordination state, but this is not a claim that the task’s acceptance
criteria were verified. A missing receipt, uncertain failure, or uncertain external
effect keeps the hold in place. Without an original receipt or evidence of execution
ownership, no model call is made just to guess. The recovery decision is reported
to the original conversation.

The recovery turn blocks every tool except `head_recovery`. It does not allow file
edits, shell or eval, lane execution, approval bypass, or replay of the original
request. This restriction does not permanently remove tools from normal HEAD work.
The ordinary queue stays blocked until the recovery turn itself has ended in native
OMP. The original identity is preserved so an intervening restart, duplicated event,
or late result does not create a new decision or cancel a different request. An
operator’s stop or manual resolution takes precedence over a stale recovery
decision. For cases that cannot be resolved automatically, use the ID from `/status`
with `/resolve`.
The model’s decision is saved as a proposal first. Only after confirming the
recovery turn’s exact receipt and native idle state does the system finalize the
original input’s state and its notification together. If the process exits in
between, the original input stays `uncertain` and can still be closed manually
with `/resolve`. Even without a recovery receipt, the system can clear that
recovery attempt without rerunning it if it confirms the operator’s stop intent
and that native OMP is actually idle. Approval notifications and goal identity are
preserved for an original request that is still running.

Status queries and stops do not wait for an ordinary model response. Compaction
may call the native summarization model; it is neither an ordinary conversation
turn nor a session reset. Compaction is refused when there is execution, an
approval, a goal, an owned service, or an unresolved submission. Status queries
and `/stop head` still work during compaction. The system does not announce a
successful compaction or run later work until native completion is confirmed.

Stopping HEAD cancels the current work, ordinary queued HEAD requests, and
unsubmitted configuration changes that arrived by the time the stop was accepted.
It clears the native input queue, active execution, compaction, subtasks, and
approvals, and stops a goal from automatically continuing. It does not assume
that submitted configuration changes or earlier uncertain external effects were
reversed. Any remaining services or asynchronous work are reported as observed.
The Gateway and other lanes stay running. Requests received after the stop are
new work; canceled requests do not rerun automatically. To stop the whole service,
use the separate local CLI command `stop main`.

### Finding Session History in Stock OMP

Open `/resume` in stock OMP under the same native profile. Lanes in the current
project are searched by default. Press Tab to switch to all projects for records
from other working directories. Native `archive` and history access by ID or path
use the same original records. There is no separate history CLI, configuration,
or search service.

Existing journals and artifacts stay in their original locations. Only links to
the session files and artifact directories are published to the native project
bucket. New journals are linked once materialized. Links for existing registered
lanes are filled in when HEAD starts with the updated code. This does not wake a
lane, move its records, or copy them as part of a migration. Editing source code
alone does not update a running service. Check the existing profile and install
path as well.

To inspect history only, use native history tools or `read` on the original path.
`/resume` can also intentionally resume ordinary work and is not guaranteed to be
read-only. If another writer has the original session open, native policy forks
it. Resuming once the writer releases the session, and choosing later sessions,
also follow native policy. This does not attach to the existing managed Host
process or transfer execution ownership. An ordinary resume does not automatically
load the manager or board extensions or confer manager or board authority.
History is not a source of new permissions or instructions.

Use `agent: "seance"` and `sourceSession` with `task` for consultation **only if
the actual caller advertises them** (a feature of 18.20.2). Official OMP 18.20.3
removed seance in
[`db5d932058ec01e5aec61bb7fb5848a87cfc3c32`](https://github.com/can1357/oh-my-pi/commit/db5d932058ec01e5aec61bb7fb5848a87cfc3c32);
do not assume it is available throughout major version 18. Searching or reading
sessions is separate from seance and from searching past messenger work via Mnemopi.

### Responding to Approvals and Questions

Use `decision_ask({questions: [...]})` to ask for an owner choice that needs to be
tracked. Each question uses `question`, `options: [{label, description?, preview?}]`,
optional `header` and `multi` fields, and a zero-based `recommended` value. The
existing native question card displays it. Timing out does not confirm the
recommendation. There is no separate question message or response command.

HEAD uses `decision_list({})` to see open decisions and `decision_list({state: "all"})`
to see decision history. It uses `decision_inspect({id})` to read the original
question, choices, recommendation, response, and source, native, and card identities.
`answering` means the answer was sent but its application in native OMP has not been
confirmed; it is not resent. `decision_withdraw({id, sourceId, reason})` only
withdraws pending questions based on an actual owner input from the same original
conversation. `withdrawn` is not consent, and without `confirmedAt` it does not
claim that cancellation was confirmed in native OMP. Ordinary `ask` and tool
permission approvals are separate from this ledger. Operator responses are
accepted only through the original authenticated card; HEAD does not interpret A/B
in ordinary chat as an answer. Recording an answer does not automatically resume a
paused lane.

Respond to approvals and questions with the platform UIs below. Even after changing
topics, an unresolved approval from the earlier topic can be answered only for
**the exact native request bound to that card**. The current topic or ordinary
message text does not change the approval target. Expired or already-consumed
responses are rejected. An answer attempt is durably recorded before it is passed
to the head stream and checked against the original approval, route, and pending
native request during recovery. An ambiguous `uiResponse` is not resent as-is.
Telegram uses `hasPendingAnswer(id, route)` to read back stored answers for queued,
inactive cards under their original identities and preserves unresolved queued
answers through HEAD recovery. An inactive card does not by itself mean the answer
was lost or successfully applied.
The head runtime interprets topic commands, pause/resume, and approval responses and
determines their native targets. The Gateway neither chooses a lane nor dispatches
work automatically without an LLM decision. At startup, the system authenticates
the messengers and restores HEAD’s native approval cards before processing inputs
and callbacks. Answers that arrive before recovery are not treated as stale and
consumed or acknowledged. Slack processes distinct concurrent selections and modal
submissions in order for each card and deduplicates only actual redeliveries.

HEAD first reviews questions sent by lanes via `decision_ask`. For a routine
choice within the delegated scope, HEAD selects one of the original choices and
returns it to the lane. It records the reason internally without sending a separate
messenger notification. If the decision materially affects scope, cost, permissions,
or external commitments, or otherwise requires user judgment, it shows the reason
for escalation on the original question card. HEAD does not answer execution
approvals or ordinary native dialogs on the operator’s behalf. The `ask` cards below
refer to the structured `askDialog` used by `decision_ask`. The Host does not send
the OMP 19.1 built-in `ask` HTML `form` to a messenger. It cancels it immediately
without submitting even the selected default.

| Platform | Approval and question UI and limits |
| --- | --- |
| Discord | Buttons, selects, and modals. Native `select` paginates 25 options at a time on the same card. Long options or descriptions are shortened in the menu, with full text in the card body or a text attachment. Original option values are returned unchanged. `ask` supports up to 25 options per question and 100 UTF-16 code units per label or description. Free-text drafts are not displayed in the channel card. Only responses bound to the original request, message, and session are accepted, with ACK after durable admission. |
| Telegram | Inline buttons and **replies to the exact active bot card** for input/editor or free-text `ask` responses. Cards are limited to 4,096 UTF-16 code units and 100 lines, button labels to 64 UTF-16 code units, and `callback_data` to 64 bytes. `ask` progress and answers are persisted, and the final button callback is acknowledged after durable admission. On restart, the system edits the same card and verifies the identity in the API response; it does not treat the cache alone as readback or recreate an uncertain card. |
| Slack | Block Kit buttons, selects with up to 100 options, and modals for input/editor or free-text `ask` responses. Labels and option descriptions are limited to 75 characters, inputs to 3,000 characters, and placeholders to 150 characters. Cards are limited to 50 blocks, 39,000 characters, and 100 KiB of semantic content. The original workspace, user, card, and modal ID and metadata are verified. The channel card shows only whether text has been entered, not the draft itself. Check the same question card for the submission or cancellation result. |

If a native dialog asks for a secret or cannot be represented in full on the
platform, the system cancels the native request and directs you to the local OMP
UI. It does not truncate the dialog or supply an arbitrary answer. Messenger
replies are not a channel for secret input.
Telegram persists the authenticated approval card’s account, actual chat or
thread, and message ID marker. Closed or canceled cards leave a content-free
tombstone so late replies after button removal, restart, or topic changes are not
accepted as new work. Separate progress metadata for a closed dialog is cleared of
partial `ask` selections and free-text answers. This does not delete the original
native session or the full record of previously admitted responses.

Ordinary Discord output replies to the original user message when both are in the
same physical conversation. Results sent to a new thread or in response to a
slash interaction with no physical message omit the reply reference. A deleted
original message is tolerated in a single Discord send request, without retrying
the send on failure. Author mentions are disabled. Long output is split first
according to the [delivery limits below](#5-operational-scope-and-recovery-constraints),
with a text attachment when it exceeds those limits. In-place status messages
are not split.

```sh
bun --no-env-file src/cli.ts stop LANE_ID --config config.local.json
bun --no-env-file src/cli.ts stop main --config config.local.json
```

Replace `LANE_ID` with the actual value shown in `status`. If you omit the target,
it defaults to `main`. Same-process native TUI or herdr attach to a managed RPC Host
is not supported, and there is no attach CLI. Historical native TUI PTY records
are preserved only as [evidence from the earlier source baseline](releases/0.1.0.md#legacy-patched-baseline).
A log tail or a separate resumed session is not presented as an observation or
control connection to the same Host.
`stop LANE_ID` requests a safe shutdown of that Host, and a busy Host refuses it.
`stop main` explicitly stops the supervised HEAD and the Gateway; the Gateway does
not immediately restart HEAD. These commands do not force a shutdown or delete
history, and existing busy-Host protection still applies. This is not a bulk stop
for all lanes; check them individually. If native OMP refuses a Gateway shutdown
request because it is busy, the service remains up. On a successful explicit stop,
the supervisor’s restart behavior is suppressed before native shutdown so the
intentional exit is not mistaken for a crash.
A shutdown ACK is not process exit or slot release. Ownership and Host budget are
released only after confirming that the native process really exited. The system
checks for RPC disconnect, exit of the original PID, and socket absence. If any
cannot be observed, release stays on hold.
Disconnecting HEAD’s Gateway client does not stop the transport.

### Registering macOS Login Autostart

The Hermes `gateway install` and `uninstall` interface is adapted to this project’s
single-Gateway design. This project’s CLI does not have a `gateway` subcommand:

```sh
bun --no-env-file src/cli.ts install --config config.local.json
bun --no-env-file src/cli.ts status --config config.local.json
bun --no-env-file src/cli.ts uninstall --config config.local.json
```

- `install` prepares a per-instance registration in the current account’s
  LaunchAgents and enables startup at the next login. It does not bootstrap the
  registration immediately or start the Gateway, models, or messengers.
- At login, the launcher invokes the existing CLI `start` once using absolute
  paths. This runs **after login** on macOS; it is not a boot daemon. It does not
  use `KeepAlive` supervision or retries, so an explicit stop and the one-shot
  successor from a messenger `/restart` do not compete with OS restarts.
- Check `autostart` in `status` for registration and launchd run state. An
  installed plist or an exited launcher does not mean the Gateway or HEAD is
  ready or that an actual message was answered successfully.
- `uninstall` removes only the exact autostart registration the instance owns.
  It does not forcibly interrupt a running launcher. It leaves the existing
  Gateway, HEAD, lanes, sessions, and secret files intact. Use `stop main`
  separately to stop the service. Running only `stop main` leaves registration in
  place, so the service starts again at the next login.
- For autostart, provide the configured credential names for every messenger in
  the owner-only `FILE.env`. Credentials available only in the current shell
  do not qualify for successful installation. Tokens and arbitrary environment
  variables are not copied into the plist. Native model authentication uses the
  account’s existing OMP settings.
- If you move Bun, the repository, or the config file, reinstall. Service manager
  errors and registrations owned by someone else or tampered with are not
  reported as successes, and `--force` cannot take them over.
- The native `command[0]` must also be an executable absolute path. The login
  environment does not read interactive shell startup files or copy shell-only
  environment variables for model authentication or configuration.
- After a crash or power loss, stale sockets, reused PIDs, or an unresolved
  restart record can cause existing Gateway ownership checks to hold startup.
  The login launcher does not clear or bypass them, or retry a failed startup
  automatically. Successful registration does not guarantee recovery from every
  crash.
- Linux/systemd or Windows service installation and automatic Gateway crash
  restarts are outside the scope of these commands.

### Add a remote worker

Use this when the head should open an ordinary lane on another machine, for example
when you say **“test this repository on Linux.”** Only the head needs messenger
credentials. Use a build with `omp-sa worker` on **both** machines (for an unreleased
checkout, use the source checkout instructions in [Local preparation](#1-local-preparation--does-not-start-the-bot), not an older npm release).

1. **On the worker:** install Git, Bun, stock OMP and `omp-superagent` as described in [Local preparation](#1-local-preparation--does-not-start-the-bot).
   Install the executables and `omp-superagent` outside the checkout you want to
   enroll, in paths that other users cannot replace.
   Configure the worker account's own OMP provider access (not a shell-command
   API key or remote auth broker) and enable its native
   memory backend (for example `omp config set memory.backend mnemopi` if none
   is enabled). Prepare a dedicated clean clone of the same Git repository
   **at the requested commit**. Enable **OpenSSH
   server** for this account over your private network (e.g. a tailnet). The
   endpoint must enforce OpenSSH `authorized_keys` forced commands; Tailscale
   SSH's own login policy is not a substitute. No public port, second head,
   `omp-sa setup` or `omp-sa start` is needed on the worker.
2. **On the head:** verify the worker's SSH host-key fingerprint with its operator
   and trust it in the head account's `known_hosts`. Use a directly resolvable DNS
   name/IP, not a nickname from `~/.ssh/config`. If Tailscale SSH handles port 22,
   use a separate OpenSSH listener on the private network, pin its host key as
   `[host]:port` in `known_hosts`, and use `dev@linux-box:port` in both `worker add`
   calls. For the default SSH port:
   ```sh
   omp-sa worker add dev@linux-box --config ./config.local.json
   ```
3. **On the worker, as `dev`:** run the `worker init` command printed in step 2.
   Keep its generated **public** head key and replace the example repository path:
   ```sh
   omp-sa worker init --head-key 'ssh-ed25519 …' --repo "$HOME/src/my-app"
   ```
   This authorizes a dedicated forced-command key in that account's
   `~/.ssh/authorized_keys`. Do not copy the head's private key, bot tokens or
   configuration. Use a dedicated OS account if the worker should not have access
   to your other files: an OMP lane runs tools as the worker user, not in a sandbox.
4. **Back on the head:** repeat the same `worker add` command. Enrollment is complete
   when the head reports **`verified`**, not when it prints the initial pairing
   instructions. To prefer this worker for one **specific head checkout**,
   repeat `worker add` with `--default --local-repo /path/on/head/my-app`.
   Omitting `--local-repo` uses the configured `headCwd`. Other checkouts with
   the same Git origin do not inherit permission to send ordinary tasks there.

Use `omp-sa worker list --config ./config.local.json` to see verified enrollments
without contacting the workers. To check one now, run
`omp-sa worker doctor dev@linux-box --config ./config.local.json` using the exact
enrolled destination, including its port if specified. It checks the worker identity
and available slots. For a default worker it also verifies the current revision of
the approved head checkout. A blocked check exits nonzero; neither command starts a lane.

Now ask for a remote lane or name the required platform in chat. Superagent matches
the repository by Git origin, not folder name; local edits and ignored files are
not synchronized. Start with a clean, committed source tree. The worker reserves
its checkout for one resident lane; it does not fetch, switch branches, or discard
edits. Follow-ups stay on the same worker and native session; disconnecting SSH
does not stop that Host. A cold reopen is held if the checkout has changed.
Chat replies and approval cards use the original route; messenger file transfer
and access to the head's local SQLite board are not provided across SSH.
Remote lanes require the normal stock OMP command without extra head-side flags:
custom tool/profile/approval flags are never silently removed to run remotely.
Use a dedicated worker OMP profile without ambient plugins. Worker startup
rejects project execution configuration (such as `.omp/`, `.env` or Git filter
drivers), linked worktrees and submodules rather than loading or rewriting
them. An operator who needs a custom model extension can list its trusted,
absolute module path in a private `worker-extensions.json` array in the worker's
OMP agent directory (`0600`, outside enrolled checkouts).
Check `omp-sa status --config ./config.local.json` for the saved placement.
To revoke new SSH connections, remove **only this enrollment's key** on the
worker. That is not a stop command for an already running lane.

## 5. Operational scope and recovery constraints

- Autonomous work uses the existing native task/job, goal, and workflow owners. It preserves
  the original authorized objective, source and route, approvals, tool exclusions, pause and
  cancel state, and holds for uncertain outcomes. After a durable lane report, the head directs
  only the remaining authorized work; it does not poll with the model while waiting or create
  a separate scheduler. A saved goal does not guarantee that prompts will replay after a crash,
  that work will run while unloaded, or that the task will finish.
- Changes to launch settings and role files take effect on a new Host launch or after an
  authorized restart. Installing or editing source code does not prove that the changes are
  live. Even a paused goal can retain its Host and slot under the shutdown guard if the goal
  is still enabled.
- The per-session Rust Host owner maintains native OMP stdio and the reconnection socket.
  The session file, lease, connection, execution, and actual process exit are distinct.
  Do not assume the Host is safely idle or forcibly reclaim it without confirming the state
  of the native UI, asynchronous work, goals, and owned services, and checking that persistence
  has finished. A shutdown ACK alone does not release the budget or ownership. See
  [Execution budget and Host lifecycle](design/execution.md#execution-budget-and-host-lifecycle).
- Input attachments on all platforms are limited to 10 per request, 20 MiB per file, and
  40 MiB total. Declared sizes are checked against actual stream sizes, and redirects are not
  followed. If Telegram omits `file_size`, the size is stored as unknown (`null`), distinct
  from a known size of zero bytes. The actual bytes downloaded still count against the
  per-file, per-request, and image limits. The Gateway saves files in a dedicated directory
  and returns each file's path and SHA-256 once the entire request completes. The head verifies
  the receipts using the request ID and file order. PNG, JPEG, GIF, and WebP content signatures
  are checked, and the request is canceled if the SHA-256 of the bytes to be passed to the
  model does not match the receipt. RPC base64 inputs have a separate aggregate limit of 8 MiB
  of decoded image data. Other files are provided as local paths. Arbitrary URL downloads and
  automatic document conversion are not supported. On restart, the Gateway cleans up only
  incomplete downloads whose ownership and format it can verify. Completed attachments are
  kept. Credentials and signed download URLs are not put in model prompts. If an attachment
  cannot be downloaded safely, the model does not start for that request.
- Discord and Telegram reply reference IDs, authors, and message bodies, plus selected quotes
  in Telegram, are passed to the head and included in explicit lane handoffs. Quotes are data,
  not new commands, authority, or destinations. The initial intake snapshot is unchanged by
  edits, deletions, or redelivery of the original. Deleted or inaccessible references are
  represented by their known IDs and `null` fields. Discord looks up references only in the
  same authorized physical channel. Telegram replies to approval cards keep their existing
  procedure. Voice-message status and duration are passed through, but this is not automatic
  transcription. Inputs or edits without meaningful text or supported attachments, such as
  sticker-only Discord messages, are not accepted as new work.
- Lane repository and board repository channel discovery use a Git process with `GIT_DIR`,
  `GIT_WORK_TREE`, and other `GIT_*` variables stripped from the launching shell's environment.
  This is not isolation of the entire general tool environment.
- Allowed input resources differ by platform:
  - Discord: Only original HTTPS URLs on `cdn.discordapp.com` or `media.discordapp.net` with
    the path `/attachments/<numeric ID>/<numeric ID>/…` are allowed.
  - Telegram: The ledger stores only the token-free `telegram-file:<file_id>`. The original
    route recorded at intake is checked against the file metadata, then `getFile` is used to
    check the 20 MiB limit. The `api.telegram.org/file/botTOKEN/…` URL is used only for an
    immediate HTTPS download and is not kept in the ledger or in errors. File path traversal
    is also rejected.
  - Slack: Starting from the token-free `slack-file:<file_id>`, `files.info` is used to verify
    that the file is a hosted file owned by the operator, and to check its workspace and share
    in the original conversation or thread. The bot Authorization header is used only on
    the HTTPS `files.slack.com/files-pri/TEAM-FILE/…` path for that team and file. Files that
    are external links are not accepted.
- To receive a file you created as a deliverable, give its exact path relative to the working
  directory on the first line of a new ordinary message, for example `attach: reports/result.pdf`.
  If you specify `cwd:` on the first line, put the attachment directive on the next line.
  Attachments are limited to one file per request and 8 MiB. Hidden paths, links, and runtime
  or credential paths are rejected. The file is sent only to the original Discord, Telegram,
  or Slack work conversation. If there is no work thread, it goes to the conversation where
  the request originated. Edited messages, app slash interactions, and model replies cannot
  authorize attachments. Attachments are also unavailable in restricted groups.
- Long output has different limits from input attachments. An ordinary Discord reply longer
  than 2,000 UTF-16 units is split at paragraph, line, or whitespace boundaries into up to
  five messages and sent in order. If a code block crosses a boundary, it is closed in the
  preceding message and reopened with the same language in the next. Only the first message
  carries the reply reference to the original message, and the delivery receipt uses that
  first message's ID. If all parts are sent, the later message IDs are also recorded so a
  reply to any part can find the original task. If delivery fails after sending only some
  parts, nothing is resent and the outcome stays `uncertain`. Separate physical conversations
  can receive messages in parallel, but ledger order is preserved within each physical
  conversation. Telegram and Slack mutation and send APIs are not retried automatically.
  Reconnecting a read or poll is not the same as repeating an uncertain external effect.

  | Platform | Ordinary text | Long output |
  | --- | --- | --- |
  | Discord | Up to 2,000 UTF-16 units | Split into up to five messages; longer replies are sent as a text attachment (up to 8 MiB). |
  | Telegram | Up to 4,096 UTF-16 units | Text file sent with `sendDocument`, up to 50 MiB. Sent without `parse_mode`, with previews and paid broadcasts disabled. |
  | Slack | Up to 3,000 characters of plain text | Text file, up to 8 MiB. Posted to the original channel/thread via `files.getUploadURLExternal` → HTTPS upload → `files.completeUploadExternal`. The retired `files.upload` is not used. |

- After reconnect or restart, Discord and Slack catch up **only in conversations already
  recorded and only after the last message ID**. They do not recover the full history on a
  fresh installation, previously unseen threads that received messages while offline, or edits
  and deletions before the cursor. The bot needs the necessary history scopes or permissions
  and actual access to the messages and attachments. Slack retention limits, rate limits, and
  incomplete history are not reported as successful recovery. Telegram does not fetch history;
  it uses only the durable update offset and the retention window of up to 24 hours described
  above. The DM lookup cursor is per physical channel. Logical topic boundaries follow the
  persisted control-message ID order, so a late message is not arbitrarily moved to the
  currently selected topic. A redelivered command also stays in the original topic in which
  it was accepted and does not roll back the current selection.
- Inbound and outbound ledgers distinguish redeliveries but do not guarantee exactly-once
  external effects. An uncertain execution or delivery is not treated as successful or
  blindly retried. If a lane has an input whose submission is unresolved, later queued inputs
  are not dispatched either. Neither a new follow-up nor resume bypasses that fence or clears
  the original uncertainty. Idle reclamation and the end of a model turn do not mean the
  user's work is complete or has passed verification.

## 6. Developer verification

Set up remote registration and lane control as described in [Add a remote worker](#add-a-remote-worker).
With the OpenSSH client and server and stock OMP installed, the command below tests
registration → remote start → disconnect/reconnect → follow-up message and reply → shutdown
without a separate machine. It uses a temporary HOME, a dedicated key, loopback `sshd`, and an
offline model. It does not test a real tailnet connection or messenger account.

```sh
OMP_SUPERAGENT_WORKER_SSH_TEST=1 bun test test/native-worker-ssh.test.ts
```

Run the general regression checks with `bun run check` and `bun run test`. The test script
builds the native binaries, then runs the test files with two isolated workers. To check for
order dependencies, run the same set serially with `bun test test`. The default tests exclude
opt-in native/PTY scenarios. Do not substitute a bare `bun test`, which also discovers tests
in `.upstream`. In a checkout with OMP and managed omp-superkit ready, `bun run test:ci`
runs type checks, Rust Host owner and Gateway tests, and local project/native/PTY and
omp-superkit integration regressions. `scripts/ci.ts` uses the active package's entry point.
CI and targeted native/PTY runs use the same selector to find the currently installed
standalone CLI on `PATH`. It skips `node_modules/.bin`, which Bun puts at the front, and does
not fall back to the SDK CLI or an older binary. It prints the selected OMP version and
executable path and checks metadata for the public RPC and process observation capabilities.
`test:ci` itself does not download, build, or update OMP. Python 3 is required, and launchd
checks run only on macOS. `test:ci` shares only the native binaries extracted by the
installed CLI in a temporary per-run cache. Each fixture's HOME, settings, and authentication
remain isolated. Setting `OMP_TEST_NATIVES_DIR` to a trusted absolute path uses that path
instead of the temporary cache; it is not deleted after the run.

GitHub Actions runs for PRs, `main`, manual dispatches, and `v*` release tags on Ubuntu 24.04
and macOS 15 ARM64. Both runners test only the SDK baseline; replay of the original oracle
runs on macOS. Publishing a release requires tests to pass on both runners and package
installation to pass on all four platforms, including macOS Intel. Each runner uses
`bun run test:baseline` to download the official CLI matching the SDK to a temporary directory
and verify its SHA-256 and `omp --version`. It reuses the native executables prepared by
`bun install --frozen-lockfile` and puts that CLI at the front of `PATH` only while running the
shared test runner. The same command run locally does not replace the existing OMP on `PATH`.
The download requires internet access, curl, and shasum. CI does not run OMP 18. When needed,
run the same checks manually with `bash scripts/test-omp.sh v18.22.2`, or specify `v18.20.3`
to test the older asynchronous task API.

**OMP upstream compatibility** runs every Monday at 04:17 UTC or on manual dispatch in
Actions. It looks up the latest official upstream release tag once, then runs the same
checks against that tag on Ubuntu and macOS ARM64. Reproduce a failing tag locally with
`bash scripts/test-omp.sh vX.Y.Z`. Missing required capabilities or regressions fail this
workflow without affecting the baseline checks for PRs and releases. A compatibility check
alone does not change product support or the SDK lockfile. This check does not verify live
accounts, paid providers, herdr, or real login/reboot, and does not establish support for the
historical same-process TUI attach behavior. See the corresponding Actions run for the
actual result of the latest upstream check. Do not reuse the
[previous release's verification records for stock 18.20.2 and patched 18.20.0](releases/0.1.0.md#verification-records)
as evidence for the current SDK baseline or later changes.

### Targeted native and omp-superkit regression tests

Native scenarios explicitly enable the existing opt-in. If `OMP_TEST_COMMAND` is unset, they
automatically select the currently installed stock CLI from `PATH`. They use the actual CLI
and socket, a deterministic local provider, and a Messenger that records messages. User
settings and authentication are isolated. These commands do not verify live messenger
login or same-process TUI/herdr attach. Automatic CLI selection does not enable native/PTY
or external-package opt-ins.

```sh
OMP_SUPERAGENT_NATIVE_TEST=1 bun test test/native-host.test.ts test/native-runtime.test.ts test/native-model-selection.test.ts test/native-board.test.ts test/native-gateway.test.ts
OMP_SUPERAGENT_NATIVE_TEST=1 bun test test/native-autonomy.test.ts
```

Only when verifying a deliberately isolated installation, set `OMP_TEST_COMMAND` to a
nonempty JSON array of strings containing the standalone CLI argv. Direct invocations,
fixture subprocesses, PTY runs, and `test:ci` all respect the same override. Invalid argv,
unsupported versions, and execution failures cause the test to fail rather than falling
back to automatic selection. Even if the first override argument is `omp`, it is resolved
to the installed CLI, not a dependency shim. The PTY test for fresh setup links the selected
executable into the isolated `PATH` so the actual setup can find it. As required by the
product contract, fresh setup saves only one executable and does not inject extra CLI
options from the test override. Explicit options in existing settings are preserved.

The omp-superkit composition regression reads and runs the specified entry point without
modifying or installing the external checkout. If the environment variable is omitted,
composition with the external package is skipped.

```sh
OMP_TEST_ULW_EXTENSION=/absolute/path/to/omp-superkit/index.ts bun test test/skills.test.ts
```

New revisions and reactivation of existing revisions must also pass an isolated offline
composition probe that uses the shipped OMP SDK's actual prompt renderer and ExtensionRunner.
See the [managed integration contract](design/execution.md#managed-omp-superkit-integration)
for the checks. Successful import or composition does not prove that the model was called,
an agent ran, a goal was created, or a workflow finished.

### Source and npm releases

GitHub source archives contain only committed source and build the Rust Gateway and Host
owner for the current platform at installation time. The npm `.tgz` includes executables
and license notices for all four platforms, so the installation machine does not need to
build Rust code. Both distributions require Bun and a separately installed OMP at runtime.
Managed omp-superkit is prepared during installation and is not bundled in the archives.
CI, baseline tests, and release scripts are only available in the source checkout, not in
the npm package.

Set the version in `package.json`, prepare `docs/releases/<version>.md`, and commit the
intended changes. The [CI native build matrix](../.github/workflows/ci.yml) runs
`bun run build:native --package` on each target (`darwin-arm64`, `darwin-x64`, `linux-arm64`,
and `linux-x64`) to produce the two executables and notices. In addition to the usual source
build tools, this requires Rust `rust-docs`. Static Linux release binaries require the musl
Rust target for the corresponding architecture and `musl-gcc`. The packaging job collects
the outputs in `gateway/bin/` and `host-owner/bin/` and then runs `bun run release`. To package
locally with the same command, you need a clean Git checkout and executable binaries and
notices for all four targets, all built from the same commit. Running only
`bun install --frozen-lockfile` in a source checkout prepares the current platform, so it
does not meet this requirement.

[`scripts/release.ts`](../scripts/release.ts) exports HEAD with `git archive` and creates the
prepared npm package with `bun pm pack --ignore-scripts`. It checks for native files and
notices and verifies executable permissions. It produces `dist/omp-superagent-<version>.tar.gz`
and `dist/omp-superagent-<version>.tgz`, plus a `.sha256` for each. The command without arguments
does not publish anything.

After an approved new version tag is pushed to the remote, CI must pass the Linux and macOS
baseline tests and npm package installation checks on all four platforms. It then runs
`bun run release --publish` to publish **the verified artifacts without rebuilding them**
to GitHub Releases. A separate npm job downloads the same `.tgz` from that release, verifies
its SHA-256, and publishes it to npm using GitHub Actions OIDC. The version, tag, and commit
must agree, and an ordinary tag push does not overwrite an existing release. Only with
explicit approval to replace an existing release, move its tag to a commit that has already
been verified and merged, then manually run `ci.yml` on that tag with `replace_release=true`.
The force-push of the tag itself runs verification only and does not publish. The manual
run must also pass verification before replacing the attachments and notes and publishing
the same tarball to npm. An already published npm version cannot be overwritten with the
same version number.

As a one-time setup, go to the npm settings for the `omp-superagent` package and add GitHub
Actions under **Trusted publishing**. Set the user or organization to `dbc-hbin`, the
repository to `omp-superagent`, and the workflow filename to `ci.yml`. Leave the environment
name blank and allow `npm publish`. No local `npm login` or stored npm token is needed
afterward. If the npm publish result is uncertain, check the registry first for the exact
version and tarball hash. Rerun the failed npm job only if the version is absent and the
cause has been addressed. There is no need to rerun the GitHub Release job or verification
jobs that passed. External publishing, pushing tags, and restarting the production Gateway
are explicit actions separate from passing local tests.
