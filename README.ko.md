<p align="center">
  <img src="assets/superagent-mascot.webp" width="320" alt="omp-superagent — 보라색 π 모양의 슈퍼히어로 에이전트">
</p>

<h1 align="center">omp-superagent</h1>

<p align="center">
  <strong>메신저에서 하나의 OMP 헤드와 대화하고, 필요한 작업만 독립적인 저장소·주제 레인으로 나눕니다.</strong>
</p>

<p align="center">
  Discord·Telegram·Slack에서 <a href="https://github.com/can1357/oh-my-pi">oh-my-pi</a>로 코딩과 프로젝트 작업을 합니다.
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

## 주요 기능

- **헤드와 주제별 레인.** 헤드는 직접 답하고 작업할 수 있습니다. 레인마다 저장소·OMP 세션·모델이 독립적이며, 후속 요청과 답변은 연결된 주제에 남습니다.
- **메신저 연결과 모델 실행 분리.** Gateway가 요청을 저장하고 헤드의 수명을 관리합니다. 세션·도구·인증·승인은 순정 OMP가 맡습니다.
- **로컬 또는 [SSH 워커](#원격-워커-추가)에서 레인 실행.** 설정된 모든 소유자는 같은 신뢰된 운영자로 취급합니다. 멀티테넌트 서비스나 OS 샌드박스가 아닙니다.

## 빠른 시작

### 1. 설치

macOS 또는 Linux(arm64·x64), [Bun 1.4.4 이상](https://bun.sh), 별도로 설치한 [순정 OMP](https://github.com/can1357/oh-my-pi#install)가 필요합니다. 모델 제공자 인증은 OMP에서 설정하세요.

```sh
bun add --global --trust omp-superagent
omp-sa --help
```

`bun pm bin --global`의 출력 경로를 `PATH`에 추가하세요. Bun이 `PATH`에 있으면 `npm install --global omp-superagent`도 사용할 수 있습니다. npm 패키지에는 네이티브 실행 파일이 포함됩니다. 소스 빌드는 [운영 가이드](docs/OPERATIONS.md)를 참고하세요.

### 2. 설정과 자격 증명

[Discord·Telegram·Slack 앱](docs/OPERATIONS.md#2-플랫폼별-앱과-접근-범위) 중 사용할 플랫폼을 준비한 뒤 실행하세요.

```sh
omp-sa setup --config ./config.local.json
```

설정 중에는 봇이나 모델이 시작되지 않습니다. `config.local.json.env`에는 토큰이 소유자 전용 권한으로 평문 저장되므로 공유하지 마세요. 최종 저장 전에 봇 프로필 사진과 OMP 메모리 설정의 변경 여부를 확인하세요.

카카오톡은 [직접 운영하는 브리지](docs/kakao-bridge-protocol.md)로만 연결합니다. 비공식 자동화라 카카오 계정이 제한될 수 있습니다. 설정 블록은 설정 파일에 직접 추가하세요.

### 3. 진단 후 명시적으로 시작

```sh
omp-sa doctor --config ./config.local.json
omp-sa start --config ./config.local.json
omp-sa status --config ./config.local.json
```

`doctor`는 메신저에 로그인하지 않고 로컬 설정을 검사합니다. `start`는 설정된 모든 플랫폼에 연결하며, `status`는 Gateway 연결과 HEAD의 작업 준비 상태를 구분합니다.

## 사용 방법

| 할 일 | 채팅에 보낼 내용 |
| --- | --- |
| 작업 시작 또는 이어가기 | 요청을 그대로 보내고 같은 작업 주제에서 후속 메시지를 보냅니다. |
| 전역 헤드에 요청 | `/head <요청>` |
| 작업 경로 지정 | 첫 줄에 `cwd: /절대/경로`를 적습니다. |
| 새 주제로 시작 | `/new <요청>` |
| 레인 상태 확인 또는 일시정지 | 작업 주제에서 `/status` 또는 `/stop`을 보냅니다. 재개는 `/resume`입니다. |

명령 목록은 `/help`에서 확인하세요. 모델 선택, 사용량 리셋, 승인, 예약 작업, 안전한 종료는 [운영 가이드](docs/OPERATIONS.md#4-명령과-일상-사용)에 정리되어 있습니다. Discord [음성채팅](docs/discord-voice.md)은 기본적으로 꺼져 있습니다.

## 원격 워커 추가

[SSH 워커 등록 절차](docs/OPERATIONS.md#원격-워커-추가)를 따르세요. 메신저 자격 증명은 HEAD에만 필요합니다.

## 문서와 출처

- 운영 가이드: [한국어](docs/OPERATIONS.md) · [English](docs/OPERATIONS.en.md)
- [설계와 구조도(영문)](DESIGN.md) · [설정 예제](config.example.json) · [개발자 검증](docs/OPERATIONS.md#6-개발자-검증)
- [릴리스 노트](docs/releases/) · [GitHub 다운로드](https://github.com/dbc-hbin/omp-superagent/releases)
- [oh-my-pi](https://github.com/can1357/oh-my-pi)를 기반으로 [omp-superkit](https://github.com/dbc-hbin/omp-superkit)을 사용합니다. [@Momentum96](https://github.com/Momentum96)의 [Discord 멘션·답글 필터 기여](https://github.com/dbc-hbin/omp-superagent/pull/29)와 [원격 레인](https://github.com/dbc-hbin/omp-superagent/pull/30)·[워커 등록](https://github.com/dbc-hbin/omp-superagent/pull/32)·[GUI 워커](https://github.com/dbc-hbin/omp-superagent/pull/33) 제안에 감사드립니다. 배포판은 GUI 런처가 아닌 SSH 워커를 사용합니다.
- [MIT 라이선스](LICENSE) · [서드파티 고지](THIRD_PARTY_NOTICES.md)
