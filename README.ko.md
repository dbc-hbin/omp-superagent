<p align="center">
  <img src="assets/superagent-mascot.webp" width="320" alt="omp-superagent — 보라색 π 모양의 슈퍼히어로 에이전트">
</p>

<h1 align="center">omp-superagent</h1>

<p align="center">
  <strong>메신저에서 하나의 OMP 헤드와 대화하고, 필요한 작업만 독립적인 저장소·주제 레인으로 나눕니다.</strong>
</p>

<p align="center">
  Discord·Telegram·Slack을 <a href="https://github.com/can1357/oh-my-pi">oh-my-pi</a>의 세션·인증·도구·native <code>task</code>에 연결합니다.
  헤드는 직접 작업하거나 독립 레인에 위임하고 결과를 종합합니다. 기존 레인에 연결된 대화에서도 모든 후속 입력은 먼저 헤드로 갑니다.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/omp-superagent"><img alt="npm 버전" src="https://img.shields.io/npm/v/omp-superagent?label=npm&labelColor=180724&color=9c4ffb&logo=npm&logoColor=white"></a>
  <a href="https://github.com/dbc-hbin/omp-superagent/actions/workflows/ci.yml?query=branch%3Amain"><img alt="main 브랜치 CI" src="https://img.shields.io/github/actions/workflow/status/dbc-hbin/omp-superagent/ci.yml?branch=main&label=ci&labelColor=180724"></a>
  <a href="LICENSE"><img alt="MIT 라이선스" src="https://img.shields.io/github/license/dbc-hbin/omp-superagent?labelColor=180724&color=dc44e7"></a>
  <a href="https://bun.sh"><img alt="Bun 1.4.4 이상" src="https://img.shields.io/badge/bun-%E2%89%A51.4.4-57e6fb?labelColor=180724&logo=bun&logoColor=white"></a>
</p>

<p align="center">
  <a href="#빠른-시작"><strong>빠른 시작</strong></a> ·
  <a href="DESIGN.md"><strong>설계</strong></a> ·
  <a href="docs/OPERATIONS.md"><strong>운영</strong></a> ·
  <a href="config.example.json"><strong>설정 예제</strong></a>
</p>

<p align="center">
  <a href="README.md">English</a> · <strong>한국어</strong>
</p>

## 차별점

<table>
  <tr>
    <td width="50%" valign="top">
      <h4>직접 실행하는 헤드</h4>
      조사·구현을 직접 처리하거나, 분리할 작업의 범위와 인계를 정해 위임합니다.
    </td>
    <td width="50%" valign="top">
      <h4>맡긴 목표 안의 자율 실행</h4>
      다음 유용한 일을 선택·우선순위화하고 계획·실행·검증·수정합니다.
      검증한 중간 결과 뒤에도 남은 허가 작업을 단계별 허락 없이 이어가되 새 범위·외부 효과를 임의로 추가하지 않습니다.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h4>저장소·주제별 독립 레인</h4>
      별도 OMP Host와 세션으로 작업 디렉터리와 맥락을 나눕니다.
    </td>
    <td width="50%" valign="top">
      <h4>레인별 native 모델·프리셋</h4>
      헤드가 native judge의 자문을 받아 선택하며, 다른 레인이나 전역 설정을 바꾸지 않습니다.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h4>연결과 세션 수명의 분리</h4>
      지속 실행되는 Gateway가 메신저 연결과 수신·조율 장부를 맡고, OMP 세션이 대화 맥락을 맡습니다.
    </td>
    <td width="50%" valign="top">
      <h4>관리 세션만 쓰는 공유 게시판</h4>
      같은 인스턴스에 등록된 헤드·레인이 정보를 공유하며, 명령이나 승인 경로로 쓰지 않습니다.
    </td>
  </tr>
  <tr>
    <td colspan="2" valign="top">
      <h4>순정 OMP 사용</h4>
      관리형 익스텐션과 공개 API로 기존 세션·도구·승인·인증을 재사용하며 코어 fork를 유지하지 않습니다.
    </td>
  </tr>
</table>

## 구조

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/architecture.ko-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="assets/architecture.ko.svg">
  <img src="assets/architecture.ko.svg" width="100%" alt="메신저 연결을 유지하는 Gateway, 직접 작업하거나 독립 레인에 인계하는 OMP 헤드, 같은 인스턴스의 정보 게시판">
</picture>

Gateway는 메신저 연결·수신 장부·헤드 수명을 관리하는 데몬입니다. 작업을 판단하고 레인을 지시하는 주체는 헤드입니다.
레인은 결과를 헤드에 보고하고, 헤드는 원래 대화에 맞춰 답합니다.

[구조도 Mermaid 원본](assets/architecture.mmd)

## 안전과 권한

설정한 모든 메신저 소유자는 같은 신뢰된 운영자 한 명으로 취급합니다. 멀티테넌트 서비스나
OS 샌드박스가 아닙니다. 자세한 내용은 [설계(영문)](DESIGN.md)를 참고하세요.

| 단계 | 바뀌는 것 |
| --- | --- |
| [설치](#1-설치) | 관리형 의존성과 ULW 통합을 준비합니다. 봇을 시작하거나 설치된 OMP를 교체하지 않습니다. |
| [`setup`](#2-설정과-자격-증명) | `config.local.json`과 소유자 전용 평문 파일 `config.local.json.env`(`0600`)를 만듭니다. 봇 프로필 사진은 최종 저장 확인 뒤에만 바뀝니다. Mnemopi 활성화는 별도의 `yes`가 필요하며 OMP 전역 기억 backend를 변경합니다. 봇·모델 세션은 시작하지 않습니다. |
| [`doctor`](#3-진단-후-명시적으로-시작) | 메신저에 로그인하지 않고 로컬 설정을 진단합니다. |
| [`start`](#3-진단-후-명시적으로-시작) | 설정에 남긴 모든 플랫폼을 활성화하고 detached Gateway와 헤드를 시작합니다. |
| [Discord 음성채팅](docs/discord-voice.md) | 기본값은 꺼짐입니다. 구독 권한이 없으면 유료 API로 전환하지 않습니다. |
| [`/stop`](#사용-방법) | 연결 레인을 일시정지합니다. 승인·취소·도구 제외와 불확실한 효과에 대한 보류는 유지합니다. |

## 배포 형태

[npm 패키지](https://www.npmjs.com/package/omp-superagent)를 Bun 또는 npm으로 설치하거나
[GitHub Release](https://github.com/dbc-hbin/omp-superagent/releases/tag/v0.1.3)의 소스·npm tarball을 받으세요.
실행에는 Bun이 필요하며 독립 실행 바이너리는 아닙니다. 설치 시 관리형 의존성을 준비합니다.
Host를 실행하려면 별도로 설치한 OMP가 필요하며, 이 프로젝트가 패치하거나 빌드하지 않습니다.

## 빠른 시작

현재 소스는 Git, **Bun >= 1.4.4**, 로컬 Unix socket을 사용합니다. 패키지 설치에는 OMP가
필요 없습니다. Host를 실행할 때는 별도로 설치한 OMP의 기능을 검사하며, 버전 범위로 제한하지
않습니다. 검증한 공식 버전은 **OMP 18.20.3, 18.22.2, 19.0.0**입니다.
Windows는 지원하지 않습니다.

<details>
<summary><strong>SDK 고정 버전과 CI 재현</strong></summary>

SDK는 **19.0.0**으로 유지하며 upstream 커밋은
[`57771ae562b9345e0579bceb2d68d585e3e6927e`](https://github.com/can1357/oh-my-pi/commit/57771ae562b9345e0579bceb2d68d585e3e6927e)입니다.
`bun run test:ci`는 현재 설치된 OMP를 검사합니다. CI를 재현하려면 SDK 기준판은
`bun run test:baseline`, OMP 18은 `bash scripts/test-omp.sh v18.22.2` 또는 `v18.20.3`을 사용하세요.
두 명령 모두 공식 바이너리를 검증한 뒤 같은 회귀를 실행합니다.
별도의 주간·수동 **OMP upstream compatibility** 검사는 최신판이 깨지면 그대로 실패하며 릴리스를 막지 않습니다.

</details>

### 1. 설치

<table width="100%"><tr><td>

**중요**

Host를 OMP 18에서 19로 바꾸기 전에 기존 백그라운드 서비스를 확인하세요.
OMP 19 데몬은 이전 브로커의 서비스를 인수하지 않습니다.

</td></tr></table>

OMP 자체를 설치하려면 [공식 설치 안내](https://github.com/can1357/oh-my-pi#install)를 참고하세요.

```sh
bun add --global --trust omp-superagent@0.1.3
omp-sa --help
```

`--trust`는 관리형 ULW 통합 준비 등 패키지 설치 스크립트 실행을 허용합니다.
`bun pm bin --global`의 출력 경로를 `PATH`에 포함하세요.

<details>
<summary><strong>npm으로 설치</strong></summary>

Bun이 `PATH`에 있다면 npm으로도 설치할 수 있습니다.

```sh
npm install --global omp-superagent@0.1.3
```

postinstall이 필수 관리형 ULW 통합을 준비하므로 설치 스크립트를 생략하지 마세요.

</details>

공개 SDK 패키지와 플랫폼 네이티브 의존성은 패키지 레지스트리에서 받으며, Rust 도구·OMP 소스
checkout·코어 패치·네이티브 빌드가 필요하지 않습니다. 의존성 설치에는 네트워크가 필요하지만,
봇을 시작하거나 설치된 OMP를 교체하지는 않습니다.
`command`에는 설치된 OMP 실행 파일과 그 뒤에 네이티브 CLI 옵션을 지정합니다.
Bun 등 런타임으로 OMP 소스를 실행하는 래퍼는 지원하지 않습니다.

CLI 명령어는 <strong><code>omp-sa</code></strong>이며 프로젝트·패키지 이름은 `omp-superagent`로 유지합니다.

<details>
<summary><strong>소스 checkout에서 실행</strong></summary>

소스 checkout이나 소스 tarball을 사용하는 경우에는 그 루트에서 대신 실행합니다.

```sh
bun install --frozen-lockfile
bun link
```

`omp-sa`와 소스 호출 `bun --no-env-file src/cli.ts`는 같은 CLI이며 둘 다 `.env` 자동 로딩을 끕니다.

</details>

### 2. 설정과 자격 증명

[플랫폼 앱·권한](docs/OPERATIONS.md#2-플랫폼별-앱과-접근-범위)을 준비한 뒤 터미널에서 실행합니다.

```sh
omp-sa setup --config ./config.local.json
```

<table width="100%"><tr><td>

**중요**

셋업은 `config.local.json`을 만들고 숨김 입력으로 받은 토큰을 소유자 전용
`config.local.json.env`(`0600`)에 저장합니다. 파일은 암호화 저장소가 아닌 평문이며,
비어 있지 않은 셸 자격 증명이 우선합니다. 모델 제공자 인증은 기존 OMP 방식으로 설정합니다.

</td></tr></table>

봇·모델 세션은 시작하지 않습니다. 최종 저장 확인에는 Discord/Telegram 봇 프로필 사진을
마스코트로 바꾸는 작업도 포함됩니다. 권장하는 Mnemopi 기억 backend 활성화는 별도의 명시적
`yes`와 최종 저장 확인이 있어야 하며 OMP 전역 기억 backend를 변경합니다.
누락된 native judge 역할은 설정을 권장하지만 모델을 자동 선택하거나 호출하지 않습니다.

메모리 동작, 다른 설정 경로, 수동 설정과 저장 효과는
[설정 가이드](docs/OPERATIONS.md#3-설정)를 참고하세요.

### 3. 진단 후 명시적으로 시작

```sh
omp-sa doctor --config ./config.local.json
```

소스 준비와 `doctor`는 메신저에 로그인하지 않습니다. `doctor`로 로컬 설정과 CLI·자격 증명 환경을 진단한 뒤 시작합니다.
`start`는 설정에 남긴 **모든 플랫폼**을 활성화하고, detached Gateway와 헤드를 시작합니다.

```sh
omp-sa start --config ./config.local.json
```

같은 헤드가 누락된 native `high`/`middle`/`low` 프리셋만 초기화한 뒤 일반 작업을 시작합니다.
관리 프리셋은 이후 OMP의 `slow`·`default`·`smol` 역할을 따라가며, 활성 세션과 수동 프리셋은
보존합니다. `status`는 초기화와 transport 준비를 구분합니다.
setup과 doctor는 봇·모델 세션을 시작하지 않습니다.

<table width="100%"><tr><td>

**참고**

이 패치 없는 배포판은 관리형 RPC Host에 native TUI/herdr로 접속하는 기능을 제공하지 않습니다.
관리 세션은 메신저 명령과 `omp-sa status`로 확인하고 제어합니다.
레인 기록은 일반 OMP의 기본 세션 검색에서도 찾습니다. `/resume`(Tab으로 모든 프로젝트)
또는 native 기록 도구를 사용하세요. 의도적인 재개는 일반 OMP 작업이며 관리 Host 접속이나
관리·게시판 권한 부여가 아닙니다.
[native 세션 접근](docs/OPERATIONS.md#일반-omp에서-세션-기록-찾기)에서 범위와 사용법을 확인하세요.

</td></tr></table>

상태 조회·종료·macOS 로그인 후 자동 시작·복구는 [운영 가이드](docs/OPERATIONS.md)를
참고하세요. 로그인 자동 시작은 한 번 실행하는 방식이며 crash 자동 재시작은 아닙니다.
Linux 서비스 설치는 제공하지 않습니다.

## 사용 방법

- 일반 메시지로 요청하세요. 질문은 바로 답하고, 작업 지시는 별도 주제에서 짧은 착수 보고와
  의미 있는 진척·결과를 전달합니다.
- 같은 주제의 후속 입력은 헤드를 통해 실행 중인 작업을 조정합니다. 저장소·주제별 레인 맥락은
  독립적입니다. 음성 첨부 메타데이터 보존이 자동 전사를 뜻하지는 않습니다.
- `/help`와 `/status`로 명령·상태를 확인합니다. `/model`·`/effort`는 유휴 헤드 세션만
  바꾸며 기존 레인·전역 기본값은 유지합니다. 일반 메시지로 헤드 모델 변경을 요청하면
  해당 턴이 끝난 뒤 적용합니다. 전역 프리셋 저장은 명시적 `--global`이 필요합니다.
  Slack 일반 메시지 명령은 `!`를 씁니다.
- `/usage`는 순정 OMP가 보고한 제공자별 계정 한도와 리셋 시각을 모델 호출 없이 보여줍니다.
- “2시간마다 CI 상태를 요약해서 여기로 보내줘”라고 요청하거나
  `/cron add "every 2h" CI 상태를 요약해줘`로 직접 등록하고,
  `/cron list`로 확인합니다. [예약 작업 명령](docs/OPERATIONS.md#예약-작업-cron)으로 수정·중지·재개·즉시 실행·삭제할 수 있습니다.
- `/stop`은 연결 레인을 일시정지하고 `/resume`은 재개를 허가합니다. 승인·취소·도구 제외와
  불확실한 효과에 대한 보류는 유지합니다. 진척 보고·복구가 작업 완료의 검증이나 외부 효과의
  취소를 뜻하지 않으며, 저장된 goal은 crash replay나 로드되지 않은 상태의 실행을 보장하지 않습니다.

<table width="100%"><tr><td>

**음성**

Discord에서는 [소유자 전용 음성채팅](docs/discord-voice.md)을 선택적으로 켤 수 있습니다.
Codex 구독 음성 또는 별도 과금되는 API 음성 중 하나를 선택합니다. 구독 모드는 API 키 없이
동작하며, 구독 권한이 없으면 유료 API로 전환하지 않습니다. 작업은 텍스트로 확인한 뒤 기존 HEAD가 맡습니다.
기본값은 꺼짐이며 봇 시작만으로 음성 채널에 들어가거나 음성 요금이 발생하지 않습니다.

</td></tr></table>

명령 등록, 재시작·복구 의미와 플랫폼 차이는
[명령과 일상 사용](docs/OPERATIONS.md#4-명령과-일상-사용)을 참고하세요.
저장소를 편집했다고 현재 운영 서비스에 반영되는 것은 아닙니다.

## ULW

공식 [omp-superkit](https://github.com/dbc-hbin/omp-superkit)은 필수 관리형 통합입니다.
사용자의 명시적 요청이나 허가된 작업에 구체적으로 도움이 된다는 헤드의 판단으로 workflow를
선택합니다. 일반 작업은 직접 세션·native task·일반 레인으로 처리할 수 있습니다.

업데이트는 새 Host에 적용하며 실행 중인 헤드·레인의 버전은 유지합니다.
[관리형 통합 운영](docs/OPERATIONS.md#필수-관리형-omp-superkit-설치와-갱신)에서 갱신·활성화 동작을 확인하세요.

## 개발

설치 후 로컬 검사를 실행합니다.

```sh
bun run check
bun test test
bun run test:ci
```

오프라인 native/PTY 범위·필요 도구·로컬 패키징과 게시 경계는
[개발자 검증·소스 릴리즈 절차](docs/OPERATIONS.md#6-개발자-검증)를 참고하세요.
[현재 CI](https://github.com/dbc-hbin/omp-superagent/blob/main/.github/workflows/ci.yml)는
순정 OMP 19.0.0을 검사 대상에 포함합니다.
[과거 실행 기록](docs/releases/0.1.0.md#verification-records)은 기록된 버전과 시나리오에만 적용됩니다.
오프라인 CI는 실계정 접속이나 운영 준비 완료를 보증하지 않습니다.

## 문서와 출처

| 문서 | 내용 |
| --- | --- |
| [설계(영문)](DESIGN.md) | 아키텍처와 메신저 권한·실행 계약. |
| [메시징과 권한(영문)](docs/design/messaging.md) | 수신·라우팅·제어·승인·복구·전달과 Discord 음성채팅. |
| [실행과 조율(영문)](docs/design/execution.md) | 레인·native Host 수명·모델·workflow·관리형 통합·모니터링·게시판. |
| [운영 가이드](docs/OPERATIONS.md) | 설치·설정·명령·복구 절차. |
| [Discord 음성채팅](docs/discord-voice.md) | Codex 구독 음성 또는 별도 과금되는 API 음성 선택. |
| 릴리즈 | [릴리즈 노트](docs/releases/0.1.3.md) 및 [과거 검증 기록](docs/releases/0.1.0.md#verification-records). |

[oh-my-pi](https://github.com/can1357/oh-my-pi)를 기반으로 하며, workflow에는 [omp-superkit](https://github.com/dbc-hbin/omp-superkit)을 사용합니다.

## License

프로젝트 코드는 [MIT 라이선스](LICENSE)를 따릅니다. 서드파티 구성 요소에는 별도 조건이
적용됩니다. [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)를 참고하세요.

<p align="center">
  <a href="https://github.com/dbc-hbin/omp-superagent/issues">이슈</a> ·
  <a href="https://github.com/dbc-hbin/omp-superagent/releases">릴리즈</a> ·
  <a href="https://www.npmjs.com/package/omp-superagent">npm</a>
</p>
