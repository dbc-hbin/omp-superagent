<p align="center">
  <img src="assets/superagent-mascot.webp" width="320" alt="omp-superagent — a purple pi-shaped superhero agent">
</p>

<h1 align="center">omp-superagent</h1>

<p align="center">
  <strong>One OMP head in your messenger. Independent sessions for work that needs its own context.</strong>
</p>

<p align="center">
  Connect Discord, Telegram, and Slack to <a href="https://github.com/can1357/oh-my-pi">oh-my-pi</a>.
  The head can investigate, write code, and answer directly—or assign work to independent
  OMP sessions called <strong>lanes</strong>, each with its own repository, context, and model.
  Ordinary requests and replies stay in their work topic. Address the global head
  with <code>/head</code> when you want coordination across topics.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/omp-superagent"><img alt="npm version" src="https://img.shields.io/npm/v/omp-superagent?label=npm&labelColor=180724&color=9c4ffb&logo=npm&logoColor=white"></a>
  <a href="https://github.com/dbc-hbin/omp-superagent/actions/workflows/ci.yml?query=branch%3Amain"><img alt="CI on main" src="https://img.shields.io/github/actions/workflow/status/dbc-hbin/omp-superagent/ci.yml?branch=main&label=ci&labelColor=180724"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/github/license/dbc-hbin/omp-superagent?labelColor=180724&color=dc44e7"></a>
  <a href="https://bun.sh"><img alt="Bun 1.4.4 or later" src="https://img.shields.io/badge/bun-%E2%89%A51.4.4-57e6fb?labelColor=180724&logo=bun&logoColor=white"></a>
</p>

<p align="center">
  <a href="#quick-start"><strong>Quick start</strong></a> ·
  <a href="DESIGN.md"><strong>Design</strong></a> ·
  <a href="docs/OPERATIONS.md"><strong>Setup &amp; operations</strong></a> ·
  <a href="config.example.json"><strong>Configuration</strong></a>
</p>

<p align="center">
  <strong>English</strong> · <a href="README.ko.md">한국어</a>
</p>

## Why superagent?

<table>
  <tr>
    <td width="50%" valign="top">
      <h4>A head that works, not just delegates</h4>
      Keep straightforward work in the main session.
      Open lanes when separate context or independent execution helps.
    </td>
    <td width="50%" valign="top">
      <h4>Autonomy inside the entrusted objective</h4>
      Choose and prioritize useful next work, plan, act, test, and repair. Verified
      intermediate results lead to remaining authorized work without per-step permission,
      not to unrelated scope or automatic external effects.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h4>Separate repositories and topics</h4>
      Lanes are real OMP work sessions, not another supervisor layered over a worker.
    </td>
    <td width="50%" valign="top">
      <h4>Models chosen per lane</h4>
      A topic starts with the current head model and retains its own selection.
      For explicit delegation, the head can choose a different native model or preset.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h4>An always-on gateway, not an always-thinking agent</h4>
      The daemon keeps messenger connections and durable intake alive. OMP retains
      conversations separately from process residency.
    </td>
    <td width="50%" valign="top">
      <h4>A shared information board</h4>
      The head and its managed lanes exchange findings and progress. Unconnected OMP
      sessions cannot join; posts are information, not commands.
    </td>
  </tr>
  <tr>
    <td colspan="2" valign="top">
      <h4>Unmodified OMP</h4>
      Reuse native sessions, tools, approvals, and authentication through managed
      extensions and public APIs, without maintaining a core fork.
    </td>
  </tr>
</table>

## Architecture

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/architecture-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="assets/architecture.svg">
  <img src="assets/architecture.svg" width="100%" alt="Messengers connect to the Gateway, which routes all input through the OMP head. The head controls independent lanes and shares an informational board with them.">
</picture>

The **Gateway** owns messenger connections and the head's lifecycle. The **head** owns
lane control, approvals and delivery. A topic's **lane** handles its own follow-ups;
the controller returns its replies without a global model turn.

[Mermaid source](assets/architecture.mmd)

## Safety and permissions

All configured messenger owners are the same trusted operator. This is not a multitenant
service or an OS sandbox; see [Design](DESIGN.md).

| Step | What it changes |
| --- | --- |
| [Install](#1-install) | Prepares dependencies and the managed ULW integration. Does not start a bot or replace OMP. |
| [`setup`](#2-configure) | Writes `config.local.json` and the owner-only, plaintext `config.local.json.env` (`0600`). The final save discloses any needed OMP global memory change and bot avatar updates. Starts no bot or model session. |
| [`doctor`](#3-start) | Checks local configuration and whether the effective OMP memory backend is enabled, without writing settings or logging into the messengers. |
| [`start`](#3-start) | Applies the native memory fallback if needed, then starts the detached Gateway and head and connects all configured messengers. |
| [Discord voice](docs/discord-voice.md) | Off by default. A rejected subscription call never switches to API billing. |
| [`/stop`](#working-from-chat) | Pauses the bound lane. Approvals, cancellations, tool exclusions, and uncertain-effect holds remain binding. |

## Distribution

Install from [npm](https://www.npmjs.com/package/omp-superagent) or use the source
and npm tarballs from the
[GitHub Release](https://github.com/dbc-hbin/omp-superagent/releases/tag/v0.1.6).
Install with Bun or npm below. Bun is still required at runtime; this is not a
standalone binary. Installation prepares the managed dependencies. Running a Host
requires a separately installed OMP; this project neither patches nor builds it.

## Quick start

This checkout requires Git, **Bun >= 1.4.4**, and local Unix sockets. Installing the
package does not require OMP. To run a Host, install stock OMP separately; the
CLI checks capabilities, not a version range. The tested releases are
**OMP 18.20.3, 18.22.2, and 19.0.0**.
Windows is unsupported.
Configure `command` with the installed OMP executable followed by native CLI flags;
runtime/script wrappers are unsupported.

<details>
<summary><strong>SDK pin and CI reproduction</strong></summary>

The SDK stays pinned to **19.0.0**, from upstream `v19.0.0` commit
[`57771ae562b9345e0579bceb2d68d585e3e6927e`](https://github.com/can1357/oh-my-pi/commit/57771ae562b9345e0579bceb2d68d585e3e6927e).
`bun run test:ci` tests the installed OMP. To reproduce CI, use
`bun run test:baseline` for the SDK-matched CLI or `bash scripts/test-omp.sh v18.22.2`
(or `v18.20.3`) for OMP 18. Each verifies the release binary and runs the same suite.
The separate weekly/manual **OMP upstream compatibility** workflow tests the latest
published CLI without falling back to the baseline or blocking releases.

</details>

### 1. Install

<table width="100%"><tr><td>

**Important**

Before switching a Host from OMP 18 to 19, check its background services; the
OMP 19 daemon does not take over the old broker's services.

</td></tr></table>

To install OMP separately, see the
[upstream instructions](https://github.com/can1357/oh-my-pi#install).

```sh
bun add --global --trust omp-superagent@0.1.6
omp-sa --help
```

`--trust` allows package lifecycle scripts, including preparation of the managed ULW integration.
Ensure `bun pm bin --global` is on `PATH`.

<details>
<summary><strong>Install with npm</strong></summary>

Alternatively, with Bun on `PATH`:

```sh
npm install --global omp-superagent@0.1.6
```

Keep lifecycle scripts enabled for the managed ULW integration.

</details>

Published SDK packages and platform-native dependencies come from the package registry;
no Rust toolchain, OMP source checkout, core patch, or native build is required.
Dependency installation needs network access. It does not start a bot or replace OMP.

The CLI command is **`omp-sa`**; the package name is `omp-superagent`.

<details>
<summary><strong>Run from a source checkout</strong></summary>

For a source checkout or source tarball, install stable Rust/Cargo, CMake and a C compiler first. Cargo builds the Gateway and Host relay, not OMP. Run `bun run build:native` after changing their Rust code. From the project root:

```sh
bun install --frozen-lockfile
bun link
```

Both `omp-sa` and the source invocation `bun --no-env-file src/cli.ts` run the same
CLI with automatic `.env` loading disabled.

</details>

### 2. Configure

Prepare your platform apps using the [operations guide](docs/OPERATIONS.md#2-플랫폼별-앱과-접근-범위),
then run:

```sh
omp-sa setup --config ./config.local.json
```

<table width="100%"><tr><td>

**Important**

Setup creates `config.local.json` and stores hidden-input tokens in owner-only
`config.local.json.env` (`0600`). That file is plaintext, not a vault; nonempty shell
credentials take precedence. Configure model authentication through OMP.

</td></tr></table>

Setup does not start a bot or model session. Its final save confirmation includes
replacing configured Discord/Telegram bot avatars with the mascot and discloses a
native memory change when needed. Managed head and lane workspaces accept any
supported effective OMP memory backend other than `off`. If the selected profile
is unconfigured or memory is off at the global layer, setup sets only that
profile's global `memory.backend` to `mnemopi` after the confirmed save. There is no
separate memory prompt. Project and launch overrides are not rewritten. If memory
is still disabled or cannot be verified, setup keeps the saved files and reports
incomplete. Setup recommends configuring a missing native judge role but does not
choose or call a model.

See [configuration and setup effects](docs/OPERATIONS.md#3-설정) for permissions,
memory behavior, alternative config paths, and manual configuration.

### 3. Start

Check local configuration without logging into the messengers:

```sh
omp-sa doctor --config ./config.local.json
```

`doctor` reports a disabled or unverifiable backend without changing it. Gateway
start/restart and each managed Host launch apply the same default/global fallback
as setup, including for existing configurations. Each Host checks its own
workspace. Explicit disabled project or launch overrides still block startup.
Start the detached Gateway and head, connecting **all configured messengers**:

```sh
omp-sa start --config ./config.local.json
```

The same head initializes missing native `high`/`middle`/`low` presets before ordinary
work. Managed presets then follow OMP's `slow`/`default`/`smol` roles without changing
active sessions or overwriting custom presets. `status` distinguishes initialization from
transport readiness. Setup and doctor do not start bot/model sessions.

<table width="100%"><tr><td>

**Note**

Native TUI/herdr attachment to managed RPC Hosts is not available in this patch-free
release. Use messenger commands and `omp-sa status` for managed sessions.
Lane journals also appear in ordinary OMP's native session discovery. Use `/resume`
(Tab for all projects) or native history tools; an intentional resume is normal OMP work,
not managed-Host attachment or a manager/board permission grant. See
[native session access](docs/OPERATIONS.md#일반-omp에서-세션-기록-찾기).

</td></tr></table>

For status, shutdown, macOS login startup, and recovery, use the
[operations guide](docs/OPERATIONS.md). Login startup is a one-shot launch, not a
crash supervisor; Linux service installation is not provided.

## Working from chat

- Send follow-ups in the existing work thread or topic to continue its task. No repository
  name or command is needed.
- Elsewhere, send the request itself, even if it names a repository. HEAD answers questions
  that need no workspace directly. For “check login in client-ui,” it uses your request and
  its conversation context to find and verify the workspace before assigning work. It asks a
  focused question only if a material ambiguity remains; it does not use a default repository
  or the last active chat. If you asked from an unbound Discord thread, HEAD keeps any
  resulting work there unless you explicitly ask for a split.
- Use `cwd: /absolute/workspace` on the first line to specify a workspace, `/new <request>`
  to start a separate topic, or reply directly to a placed task or its delivered message to reuse
  its known workspace without copying its history.
- With active, searchable Mnemopi on the head, describe earlier work from any allowed
  owner channel, e.g. “continue the login bug investigation from last week.” The
  controller uses Mnemopi recall and verifies candidates against this instance's
  eligible session journals. Other enabled memory backends can run managed sessions
  but do not support this historical topic search.
  A cross-channel continuation uses the matched workspace and relevant task evidence, not
  the original channel binding, transcript or approvals. Choose by number if multiple tasks match.
- Use `/head <request>` for coordination or direct global work. Repositories and
  topics keep independent lane context; voice metadata does not imply transcription.
- Use `/help` and `/status` for controls and state. `/model` and `/effort` manage the
  idle head session, not existing lanes or global defaults. You can also ask the head
  with `/head` to switch its own model after that turn. Global preset changes
  require explicit `--global`. Slack's message commands use `!`.
- `/usage` shows provider account quotas and reset times reported by stock OMP, without a model turn.
- To receive a generated file, start an owner request with `attach: path/to/result.pdf` (relative to the work directory).
- For a shared server or room, [configure restricted group access](docs/OPERATIONS.md#단체방서버-권한-분리) for request intake, tool-free chat or scoped worktree edits. These rooms cannot operate the owner session.
- Ask `/head` to summarize CI every two hours, or use `/cron add "every 2h" Summarize CI`, and
  manage it from the same chat with [`/cron`](docs/OPERATIONS.md#예약-작업-cron).
- `/stop` pauses the bound lane; `/resume` authorizes continuation. Approvals,
  cancellations, tool exclusions, and uncertain-effect holds remain binding.
  Neither progress reports nor recovery prove task completion or undo external effects.
  Saved goals do not guarantee crash replay or execution while unloaded.

<table width="100%"><tr><td>

**Voice**

Discord can optionally join a private voice conversation with the owner. A separate
OpenAI Live session answers speech; work goes to HEAD only after written confirmation.
Select Codex subscription voice or the separately billed API in the
[voice configuration guide](docs/discord-voice.md). Voice is off by default;
a rejected subscription call never switches to API billing.

</td></tr></table>

See [commands, approvals, and everyday use](docs/OPERATIONS.md#4-명령과-일상-사용)
for command registration, restart and recovery semantics, and platform differences.
Repository changes alone do not update a running service.

## ULW included

[omp-superkit](https://github.com/dbc-hbin/omp-superkit) is installed and loaded as a managed integration.
Use a workflow explicitly, or let the head select one when the authorized task genuinely
benefits from it. Ordinary work can stay in a direct session, native task, or regular lane.

Updates apply to new Hosts, not running heads or lanes. See
[managed integration operations](docs/OPERATIONS.md#필수-관리형-omp-superkit-설치와-갱신)
for update and activation behavior.

## Development

Local checks after installation:

```sh
bun run check
bun test test
bun run test:ci
```

See [developer verification and source release steps](docs/OPERATIONS.md#6-개발자-검증)
for offline native/PTY coverage, prerequisites, and local packaging/publication boundaries.
The [current CI matrix](https://github.com/dbc-hbin/omp-superagent/blob/main/.github/workflows/ci.yml)
includes stock OMP 19.0.0.
[Historical results](docs/releases/0.1.0.md#verification-records) apply only to the
recorded versions and scenarios. Offline CI does not verify live accounts or production readiness.

## Documentation & credits

| Document | What it covers |
| --- | --- |
| [Design](DESIGN.md) | architecture, messaging authority and execution contracts. |
| [Messaging and authority](docs/design/messaging.md) | ingress, routing, controls, approvals, recovery, delivery, and Discord voice. |
| [Execution and coordination](docs/design/execution.md) | lanes, native Host lifecycle, models, workflows, managed integration, monitoring, and the board. |
| [Operations guide](docs/OPERATIONS.md) | platform setup, commands, and recovery. |
| [Voice configuration guide](docs/discord-voice.md) | Codex subscription voice or the separately billed API. |
| Releases | [Release notes](docs/releases/0.1.6.md) and [historical verification records](docs/releases/0.1.0.md#verification-records). |

Built on [oh-my-pi](https://github.com/can1357/oh-my-pi), with
[omp-superkit](https://github.com/dbc-hbin/omp-superkit) workflow integration.
The mascot reimagines OMP's pi mark as a little superhero.

## License

Project code is licensed under [MIT](LICENSE). Third-party components retain their
separate terms; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

<p align="center">
  <a href="https://github.com/dbc-hbin/omp-superagent/issues">Issues</a> ·
  <a href="https://github.com/dbc-hbin/omp-superagent/releases">Releases</a> ·
  <a href="https://www.npmjs.com/package/omp-superagent">npm</a>
</p>
