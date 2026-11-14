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
```

prepare는 고정 OMP checkout·패치·의존성과 필수 관리형 `omp-ulw`를 준비합니다.
소스 pin과 로컬 빌드 세부 사항은 [운영 가이드](docs/OPERATIONS.md#1-로컬-준비--봇은-시작하지-않음)에 있습니다.

### 2. 설정과 자격 증명

플랫폼 앱을 준비한 뒤 터미널에서 실행합니다.

```sh
bash scripts/setup.sh
```

플랫폼·소유자·허용 채널·경로를 입력받아 `config.local.json`을 만들고 토큰은 숨김 입력으로 받습니다.
토큰은 JSON·argv가 아니라 소유자 전용 `config.local.json.env`(`0600`)에 저장합니다.
기존 유효한 JSON은 보존하며 자격 증명 변경은 확인 후 저장합니다. 봇은 시작하지 않습니다.

최초 셋업은 Mnemopi 장기 기억을 권장합니다. 명시적인 `yes`와 최종 저장 확인이 있어야만
native OMP 전역 `memory.backend`를 `mnemopi`로 바꿉니다. 거절·취소·기존 자격 증명 갱신은
메모리 설정을 건드리지 않습니다. 다른 메모리 옵션은 유지하며 이후 OMP 사용 시 해당 옵션에
따라 모델 처리·다운로드가 발생할 수 있습니다. 셋업 자체는 메모리 backend를 시작하지 않습니다.

새 구성 저장 후 네이티브 `judge` 역할이 미설정이면 일반 OMP의 `/models` → Roles → Judge에서 지정하도록
권장합니다. 기존 선택은 보존하며, 셋업이 judge 모델을 자동 선택·변경하거나 호출하지는 않습니다.
legacy 설정 때문에 실효 상태를 판정할 수 없거나 읽기에 실패하면 미설정으로 단정하지 않습니다.

`doctor`와 명시적 `start`만 해당 파일의 구성된 자격 증명 이름을 환경에 읽습니다.
이미 셸에 설정된 비어 있지 않은 환경변수가 우선합니다. 파일은 암호화 저장소가 아닌 평문입니다.
래퍼와 아래 명령은 Bun의 작업 디렉터리 `.env` 자동 로딩을 끕니다.
모델 제공자 인증은 기존 OMP 방식으로 유지합니다.

다른 경로는 `bash scripts/setup.sh --config /절대/경로/config.json`으로 지정합니다.
예제 JSON의 수동 설정과 환경변수만 사용하는 방식도 유지합니다.

[플랫폼별 앱·권한 준비](docs/OPERATIONS.md#2-플랫폼별-앱과-접근-범위)와 [설정 필드](docs/OPERATIONS.md#3-설정)를 참고하세요.

### 3. 진단 후 명시적으로 시작

```sh
bun --no-env-file src/cli.ts doctor --config config.local.json
```

소스 준비와 `doctor`는 메신저에 로그인하지 않습니다. `doctor`로 로컬 설정과 CLI·자격 증명 환경을 진단한 뒤 시작합니다.

```sh
bun --no-env-file src/cli.ts start --config config.local.json
```

최초 시작 때 누락된 native `high`/`middle`/`low` 프리셋은 같은 헤드의 전용 초기 설정 턴에서
생성·재조회하고, 그 뒤 일반 작업을 실행합니다. 기존 프리셋은 보존합니다. `status`는 프리셋
초기화와 transport 준비를 구분하며 실패·미완료를 준비 완료로 표시하지 않습니다.
`setup`과 `doctor`는 계속 봇·모델을 실행하지 않습니다.

`start`는 설정에 남긴 **모든 플랫폼**을 활성화하고, detached Gateway와 헤드를 시작합니다.
같은 Host를 native TUI로 읽기 전용 관찰하려면 다음을 실행합니다.

```sh
bun --no-env-file src/cli.ts attach main --config config.local.json --read-only
```

## 사용 방법

- **상태 반응:** 접수하면 👀, native 처리 중이면 Discord·Slack에 💭를 표시합니다.
  Telegram은 🤔로 교체했다가 종료 시 👀로 복귀합니다. Discord에는 Add Reactions,
  Slack에는 `reactions:write` 권한이 필요합니다.
- **착수 보고:** 작업 지시는 먼저 별도 스레드·topic을 열고 무엇을 어떻게 할지 짧게 보고한 뒤 실행합니다.
  같은 작업의 후속 지시는 기존 주제를 유지합니다. 질문·상태 조회·계산·연결 테스트는 기존 대화에서 바로 답합니다.
- **독립 주제:** 일반 메시지로 새 작업을 요청하면 헤드가 범위를 판단해 지원되는 실제 스레드·topic을 만들고 독립 세션을 연결합니다. native topic이 없는 DM은 논리 주제로 분리합니다. `/new`(Slack `!new`)도 명시적 DM 주제 제어로 유지합니다.
- **후속 요청:** 같은 주제의 일반 후속 입력은 실행 중인 작업에 기본 steer로 전달합니다. `/steer`는 필요 없습니다. 헤드가 먼저 받고 필요한 레인 지시를 명시적으로 전달하며, 다른 대화·제어 명령·workflow 선택은 섞지 않습니다.
- **헤드 모델·effort:** `/model`·`/effort`로 조회하고, `/model list`의 정확한 모델을
  `/model <provider/model>`로 선택하거나 `/effort <level>`로 변경합니다. Slack은 `!model`·`!effort`입니다.
  유휴 헤드 세션에만 적용하며 전역 기본값과 기존 레인은 유지합니다.
- **운영 제어:** `/help`·`/status`·`/context`·`/usage`로 상태를 확인하고,
  `/compact [보존할 내용]`으로 유휴 헤드 맥락을 압축합니다. `/model preset`으로 목록을 보고
  `/model preset <name>`으로 native 프리셋을 적용합니다. `/stop head`는 Gateway 종료 없이 헤드 작업을 중단합니다.
  Slack에서는 같은 명령에 `!`를 씁니다.
- **명시적 전역 저장:** `/model preset <name> --global`만 native 기본 역할·effort도 저장합니다.
  옵션이 없으면 이번 헤드 세션 전용이며, 변경 알림에 실제 모델·effort와 적용 범위를 표시합니다.

## ULW

공식 [omp-ulw](https://github.com/dbc-hbin/omp-ulw)는 필수 관리형 설치 대상이며, workflow는 사용자의 명시적 요청이나
헤드가 구체적으로 필요성을 판단한 경우에 선택합니다. Gateway는 시작 시와 이후 매시간 업데이트를 확인해 새 Host에만 적용합니다.
실행 중인 헤드·레인의 버전은 고정되며, 업데이트 실패 시 기존 버전을 유지합니다.

## 문서와 출처

- [운영 가이드](docs/OPERATIONS.md): 설치·설정·복구 절차와 검증 근거.
- [설계](DESIGN.md): Gateway·헤드·레인과 공유 게시판의 계약.
- [서드파티 고지](THIRD_PARTY_NOTICES.md): 출처와 라이선스 고지.

[oh-my-pi](https://github.com/can1357/oh-my-pi)를 기반으로 하며, workflow에는 [omp-ulw](https://github.com/dbc-hbin/omp-ulw)를 사용합니다.
