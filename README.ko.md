<p align="center">
  <img src="assets/superagent-mascot.webp" width="320" alt="omp-superagent — 보라색 π 모양의 슈퍼히어로 에이전트">
</p>

[English](README.md) · **한국어**

# omp-superagent

**메신저에서 하나의 OMP 헤드와 대화하고, 필요한 작업만 독립적인 저장소·주제 레인으로 나눕니다.**

Discord·Telegram·Slack을 [oh-my-pi](https://github.com/can1357/oh-my-pi)의 세션·인증·도구·native `task`에 연결합니다.
헤드는 직접 작업하거나 독립 레인에 위임하고 결과를 종합합니다. 기존 레인에 연결된 대화에서도 모든 후속 입력은 먼저 헤드로 갑니다.

[설계](DESIGN.md) · [운영](docs/OPERATIONS.md) · [설정 예제](config.example.json)

## 차별점

- **직접 실행하는 헤드:** 조사·구현을 직접 처리하거나, 분리할 작업의 범위와 인계를 정해 위임합니다.
- **저장소·주제별 독립 레인:** 별도 OMP Host와 세션으로 작업 디렉터리와 맥락을 나눕니다.
- **레인별 native 모델·프리셋:** 헤드가 native judge의 자문을 받아 선택하며, 다른 레인이나 전역 설정을 바꾸지 않습니다.
- **연결과 세션 수명의 분리:** 지속 실행되는 Gateway가 메신저 연결과 수신·조율 장부를 맡고, OMP 세션이 대화 맥락을 맡습니다.
- **관리 세션만 쓰는 공유 게시판:** 같은 인스턴스에 등록된 헤드·레인이 정보를 공유하며, 명령이나 승인 경로로 쓰지 않습니다.
- **기존 native TUI:** 같은 Host에 붙어 진행을 봅니다. herdr는 선택 사항이며 별도 대시보드를 요구하지 않습니다.

## 구조

![메신저 연결을 유지하는 Gateway, 직접 작업하거나 독립 레인에 인계하는 OMP 헤드, 같은 인스턴스의 정보 게시판](assets/architecture.svg)

[구조도 Mermaid 원본](assets/architecture.mmd)

Gateway는 메신저 연결·수신 장부·헤드 수명을 관리하는 데몬입니다. 작업을 판단하고 레인을 지시하는 주체는 헤드입니다.
레인은 결과를 헤드에 보고하고, 헤드는 원래 대화에 맞춰 답합니다.

## 빠른 시작

Git, **Bun >= 1.4.4**, 로컬 Unix socket 지원 환경, Rust/Cargo와 플랫폼 네이티브 빌드 도구가 필요합니다.
이 프로젝트는 **고정된 OMP 소스에 패치를 적용해 빌드**합니다. npm 전역 설치 OMP를 사용하는 절차가 아닙니다.

### 1. 소스 준비

저장소 루트에서 순서대로 실행합니다.

```sh
bun scripts/prepare-omp.ts
bun install --frozen-lockfile
bun --cwd=.upstream/omp run build:native
cp config.example.json config.local.json
```

prepare는 고정 OMP checkout·패치·의존성과 필수 관리형 `omp-ulw`를 준비합니다.
소스 pin과 로컬 빌드 세부 사항은 [운영 가이드](docs/OPERATIONS.md#1-로컬-준비--봇은-시작하지-않음)에 있습니다.

### 2. 설정과 자격 증명

- `config.local.json`의 모든 placeholder와 경로를 바꿉니다. `command`에는 **Bun 실행 파일과 패치된
  `.upstream/omp/packages/coding-agent/src/cli.ts`의 절대 경로**를 넣습니다.
- 사용할 플랫폼을 최소 하나 남기고 사용하지 않을 플랫폼 블록은 삭제합니다. 소유자 ID와 허용 채널을 설정합니다.
- `stateDir`와 `headCwd`를 정하고, 모델 제공자 인증은 기존 OMP 방식으로 준비합니다.
- 비밀 토큰은 환경변수로만 전달합니다. `tokenEnv` 등에는 환경변수 **이름**만 넣고, 토큰 값은 JSON·argv·저장소에 기록하지 않습니다.

[플랫폼별 앱·권한 준비](docs/OPERATIONS.md#2-플랫폼별-앱과-접근-범위)와 [설정 필드](docs/OPERATIONS.md#3-설정)를 참고하세요.

### 3. 진단 후 명시적으로 시작

```sh
bun src/cli.ts doctor --config config.local.json
```

소스 준비와 `doctor`는 메신저에 로그인하지 않습니다. `doctor`로 로컬 설정과 CLI·자격 증명 환경을 진단한 뒤 시작합니다.

```sh
bun src/cli.ts start --config config.local.json
```

`start`는 설정에 남긴 **모든 플랫폼**을 활성화하고, detached Gateway와 헤드를 시작합니다.
같은 Host를 native TUI로 읽기 전용 관찰하려면 다음을 실행합니다.

```sh
bun src/cli.ts attach main --config config.local.json --read-only
```

## 사용 방법

- **직접 처리:** 메인 대화에서 작은 조사나 수정을 요청합니다. 헤드가 직접 처리할 수 있으며 레인은 필수가 아닙니다.
- **독립 주제:** Discord·Telegram에서 `/new 저장소 A의 로그인 오류를 고쳐줘`로 저장소·이슈 레인을 엽니다. Slack에서는 `!new`를 씁니다.
- **후속 요청:** “수정은 어디까지 됐어?”도 헤드가 먼저 받아 레인에 필요한 지시를 전달하고 결과를 종합합니다.

## ULW

공식 [omp-ulw](https://github.com/dbc-hbin/omp-ulw)는 필수 관리형 설치 대상이며, workflow는 사용자의 명시적 요청이나
헤드가 구체적으로 필요성을 판단한 경우에 선택합니다. Gateway는 시작 시와 이후 매시간 업데이트를 확인해 새 Host에만 적용합니다.
실행 중인 헤드·레인의 버전은 고정되며, 업데이트 실패 시 기존 버전을 유지합니다.

## 문서와 출처

- [운영 가이드](docs/OPERATIONS.md): 설치·설정·복구 절차와 검증 근거.
- [설계](DESIGN.md): Gateway·헤드·레인과 공유 게시판의 계약.
- [서드파티 고지](THIRD_PARTY_NOTICES.md): 출처와 라이선스 고지.

[oh-my-pi](https://github.com/can1357/oh-my-pi)를 기반으로 하며, workflow에는 [omp-ulw](https://github.com/dbc-hbin/omp-ulw)를 사용합니다.
