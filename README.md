<p align="center">
  <img src="assets/superagent-mascot.webp" width="320" alt="omp-superagent — a purple pi-shaped superhero agent">
</p>

<h1 align="center">omp-superagent</h1>

<p align="center">
  <strong>One OMP head in your messenger. Independent sessions for work that needs its own context.</strong>
</p>

<p align="center">
  Connect Discord, Telegram, and Slack to <a href="https://github.com/can1357/oh-my-pi">oh-my-pi</a>
  for coding and project work from chat.
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
  <a href="docs/OPERATIONS.en.md"><strong>Setup &amp; operations</strong></a> ·
  <a href="config.example.json"><strong>Configuration</strong></a>
</p>

<p align="center">
  <strong>English</strong> · <a href="README.ko.md">한국어</a>
</p>

## What it does

- **Work directly or split by topic.** HEAD can answer and work in place. A lane keeps its own repository, OMP session, and model; ordinary replies stay in the bound topic.
- **Keep chat connected without keeping a model busy.** The Gateway persists intake and manages HEAD's lifecycle. OMP still owns sessions, tools, authentication, and approvals; no core fork is required.
- **Run lanes locally or on an [enrolled SSH worker](#add-a-remote-worker).** All configured owners are treated as one trusted operator. This is not a multitenant service or an OS sandbox.

## Quick start

### 1. Install

Use macOS or Linux (arm64 or x64), [Bun 1.4.4+](https://bun.sh), and a separately installed [stock OMP](https://github.com/can1357/oh-my-pi#install). Authenticate your model provider in OMP.

```sh
bun add --global --trust omp-superagent
omp-sa --help
```

Put the output of `bun pm bin --global` on `PATH`. You can also use `npm install --global omp-superagent` with Bun on `PATH`. The npm package includes the native binaries; for source builds see the [operations guide](docs/OPERATIONS.en.md).

### 2. Configure

Prepare a [Discord, Telegram, or Slack app](docs/OPERATIONS.en.md#2-platform-apps-and-access), then run:

```sh
omp-sa setup --config ./config.local.json
```

Setup does not start bots or models. Keep `config.local.json.env` private: it stores tokens in plaintext with owner-only permissions. Review the final confirmation for avatar changes and any OMP memory setting change.

KakaoTalk works only through a [bridge you run yourself](docs/kakao-bridge-protocol.md); it is unofficial automation and can put the Kakao account at risk. Add its block to the configuration manually.

### 3. Start

```sh
omp-sa doctor --config ./config.local.json
omp-sa start --config ./config.local.json
omp-sa status --config ./config.local.json
```

`doctor` runs local checks without signing in to messengers. `start` connects all configured platforms; `status` distinguishes a connected Gateway from a ready HEAD.

## Working from chat

| What you want | What to send |
| --- | --- |
| Start or continue work | Send a request in chat; follow up in the same work topic. |
| Ask the global HEAD | `/head <request>` |
| Choose an exact workspace | Put `cwd: /absolute/path` on the first line. |
| Start a separate topic | `/new <request>` |
| Inspect or pause a lane | `/status` or `/stop` in its topic. Use `/resume` to continue. |

Use `/help` for commands. See the [operations guide](docs/OPERATIONS.en.md#4-commands-and-daily-use) for model selection, usage resets, approvals, scheduling, and safe shutdown. [Discord voice](docs/discord-voice.md) (Korean guide) is optional and off by default.

## Add a remote worker

Follow the [SSH worker enrollment guide](docs/OPERATIONS.en.md#add-a-remote-worker). Only HEAD needs messenger credentials.

## Documentation & credits

- Operations: [English](docs/OPERATIONS.en.md) · [한국어](docs/OPERATIONS.md)
- [Design and architecture](DESIGN.md) · [Configuration example](config.example.json) · [Developer verification](docs/OPERATIONS.en.md#6-developer-verification)
- [Release notes](docs/releases/) · [GitHub downloads](https://github.com/dbc-hbin/omp-superagent/releases)
- Built on [oh-my-pi](https://github.com/can1357/oh-my-pi) with [omp-superkit](https://github.com/dbc-hbin/omp-superkit). Thanks to [@Momentum96](https://github.com/Momentum96) for the [Discord addressing contribution](https://github.com/dbc-hbin/omp-superagent/pull/29) and proposals on [remote lane parity](https://github.com/dbc-hbin/omp-superagent/pull/30), [worker enrollment](https://github.com/dbc-hbin/omp-superagent/pull/32), and [GUI workers](https://github.com/dbc-hbin/omp-superagent/pull/33). The shipped worker uses SSH, not a GUI launcher.
- [MIT license](LICENSE) · [Third-party notices](THIRD_PARTY_NOTICES.md)
