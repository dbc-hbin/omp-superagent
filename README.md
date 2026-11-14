<p align="center">
  <img src="assets/superagent-mascot.webp" width="320" alt="omp-superagent — a purple pi-shaped superhero agent">
</p>

# omp-superagent

**English** · [한국어](README.ko.md)

**One OMP head in your messenger. Independent sessions for work that needs its own context.**

Connect Discord, Telegram, and Slack to [oh-my-pi](https://github.com/can1357/oh-my-pi).
The head can investigate, write code, and answer directly—or assign work to independent
OMP sessions called **lanes**, each with its own repository, context, and model.
Every request and follow-up goes through the head, which coordinates the work and brings
the results back to your conversation.

[Design](DESIGN.md) · [Setup & operations](docs/OPERATIONS.md) · [Configuration](config.example.json)

## Why superagent?

- **A head that works, not just delegates.** Keep straightforward work in the main session.
  Open lanes when separate context or independent execution helps.
- **Separate repositories and topics.** Lanes are real OMP work sessions, not another
  supervisor layered over a worker.
- **Models chosen per lane.** The head consults OMP's judge and chooses a native model or
  preset. Lane model changes stay local to that session, without rewriting global settings.
- **An always-on gateway, not an always-thinking agent.** The daemon keeps messenger
  connections and durable intake alive. OMP retains conversations separately from process residency.
- **A shared information board.** The head and its managed lanes exchange findings and
  progress. Unconnected OMP sessions cannot join; posts are information, not commands.
- **The OMP interface you already use.** Attach the native TUI to the same running Host.
  Use herdr as an optional terminal view, not a separate execution backend or required service.

## Architecture

![Messengers connect to the Gateway, which routes all input through the OMP head. The head controls independent lanes and shares an informational board with them.](assets/architecture.svg)

[Mermaid source](assets/architecture.mmd)

The **Gateway** owns messenger connections and the head's lifecycle. The **head** owns
lane control and decides whether to work directly or delegate. **Lanes** report to the
head; the head replies to the original conversation.

## Quick start

Requires Git, **Bun >= 1.4.4**, local Unix sockets, and Rust/Cargo with your platform's
native build tools. Use this repository's pinned, patched OMP source.

### 1. Prepare

From the repository root:

```sh
bun scripts/prepare-omp.ts
bun install --frozen-lockfile
bun --cwd=.upstream/omp run build:native
```

Preparation installs the pinned OMP source, its patches, and the managed `omp-ulw` integration.
It does not start a bot or replace your global OMP installation.

### 2. Configure

Run the terminal setup wrapper after preparing the platform apps:

```sh
bash scripts/setup.sh
```

It creates `config.local.json`, asks for platform/owner/channel settings, and accepts
tokens without echoing them. Tokens go into owner-only `config.local.json.env` (`0600`),
not JSON or command arguments. Existing valid JSON is preserved; credential changes
require confirmation. No bot is started.

First-time setup recommends Mnemopi persistent memory. Only explicit `yes` plus
final save confirmation sets native OMP's global `memory.backend` to `mnemopi`;
declining or refreshing credentials leaves it untouched. Existing memory options
remain unchanged and may involve model processing/downloads when OMP uses memory.
Setup itself does not start the memory backend.

`doctor` and explicit `start` load only the configured credential names from that file.
Nonempty shell environment values take precedence. The file is plaintext—not a vault.
The wrapper and commands below disable Bun's automatic working-directory `.env` loading.
Configure model authentication through OMP as before.

Use `bash scripts/setup.sh --config /absolute/path/to/config.json` for another location.
Manual configuration from `config.example.json` and environment-only credentials remain supported.

See the [platform setup guide](docs/OPERATIONS.md#2-플랫폼별-앱과-접근-범위) and
[configuration guide](docs/OPERATIONS.md#3-설정) for permissions and field details.

### 3. Start

Check local configuration without logging into the messengers:

```sh
bun --no-env-file src/cli.ts doctor --config config.local.json
```

Start the detached Gateway and head, connecting **all configured messengers**:

```sh
bun --no-env-file src/cli.ts start --config config.local.json
```

On first startup, missing native `high`/`middle`/`low` presets are initialized in a
dedicated turn of the same head, before ordinary work. Existing presets are preserved.
`status` distinguishes preset initialization from transport readiness; incomplete or
failed initialization is not reported as ready. `setup` and `doctor` remain offline.

Attach a read-only native TUI to the same head:

```sh
bun --no-env-file src/cli.ts attach main --config config.local.json --read-only
```

## Working from chat

- Ask “Explain the authentication flow in this repository.” The head can handle it directly.
- Ask for a new independent topic normally. The head creates a supported native
  thread/topic and binds its work session; private chats without native topics use
  logical topics. `/new` (Slack `!new`) remains an explicit DM topic control.
- Follow up in the same conversation. The head receives the message, coordinates any
  lane work, and returns the result. Separate repository work keeps its own lane context.
  Ordinary same-topic follow-ups steer active work by default; no `/steer` is needed.
  Different conversations, controls, and workflow selections remain separate.
- Inspect the shared head with `/model` or `/effort`; use `/model list`, then
  `/model <provider/model>` or `/effort <level>` to change its idle session.
  Slack uses `!model` and `!effort`. Global defaults and existing lanes stay unchanged.
- Use `/help`, `/status`, `/context`, and `/usage` for native state; `/compact [instructions]`
  compacts the idle head. `/model preset` lists native presets and `/model preset <name>`
  applies one to the head session. `/stop head` interrupts head work without stopping the Gateway.
  Slack uses the same commands with `!`.
- Add `--global` only to `/model preset <name>` when you explicitly want to save native
  default roles and effort too. The change reply reports the actual model/effort and scope.

[Commands, approvals, and everyday use](docs/OPERATIONS.md#4-명령과-일상-사용)

## ULW included

[omp-ulw](https://github.com/dbc-hbin/omp-ulw) is installed and loaded as a managed integration.
Use a workflow explicitly, or let the head select one when the authorized task genuinely
benefits from it. Ordinary work can stay in a direct session, native task, or regular lane.

The Gateway checks upstream commits at startup and hourly. New Hosts use the prepared
revision; running heads and lanes keep theirs. Failed updates leave the previous active
revision in place.

## Documentation & credits

- [Design](DESIGN.md): routing, roles, sessions, and lifecycle.
- [Operations guide](docs/OPERATIONS.md): platform setup, recovery, and verification records.
- [Third-party notices](THIRD_PARTY_NOTICES.md): source attribution and licensing.

Built on [oh-my-pi](https://github.com/can1357/oh-my-pi), with
[omp-ulw](https://github.com/dbc-hbin/omp-ulw) workflow integration.
The mascot reimagines OMP's pi mark as a little superhero.
