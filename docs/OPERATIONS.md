# 운영·설치 가이드

[프로젝트 소개로 돌아가기](../README.md) · [설계](../DESIGN.md) ·
[설정 예제](../config.example.json) · [출처·라이선스 고지](../THIRD_PARTY_NOTICES.md)

이 문서는 설치·설정·일상 제어와 복구 절차를 다룬다. 파일·코드 경로와 셸 명령은 별도
설명이 없으면 **저장소 루트 기준**이다. npm 설치에서는 같은 관리 명령을
`bun --no-env-file src/cli.ts` 대신 `omp-sa`로 실행하며 설정 파일은 사용자 작업 디렉터리에 둔다.
현재 구조·권한 계약은 [설계](../DESIGN.md)를 따른다. [버전별 릴리즈 기록](releases/)의
검증 결과는 해당 버전·기준선·실행 범위에만 해당한다.

Gateway가 메신저 연결과 지정 헤드의 수명을 맡는다. 헤드 컨트롤러는 운영자 입력을 접수하고
라우팅한다. 연결되지 않은 일반 요청은 공유 HEAD 모델이 판단한다. 연결된 작업 주제의 일반
작업은 해당 레인 세션에서 이어지며, 그 답변도 공유 모델의 추가 턴 없이 전달된다. 제어 명령과
제한 그룹은 각각 별도 경로를 따른다. 설정한 플랫폼은 동시에 연결되며 각 플랫폼의 소유자는
**같은 신뢰된 운영자**여야 한다. 메인 맥락은 공유하지만 플랫폼·계정·대화·주제 신원은
분리한다. 멀티테넌트 구성이나 OS 보안 샌드박스가 아니다.
관리 RPC Host의 동일 프로세스 native TUI/herdr attach는 지원하지 않는다.

선택 기능인 [Discord 실시간 음성채팅](discord-voice.md)은 일반 대화를 별도 OpenAI Live 세션에서
처리한다. `/voice start work`로 시작하면 말로 요청한 작업을 지정 텍스트 채널에 초안으로 게시할 수 있다.
소유자가 해당 초안에 `/voice confirm`으로 답장해야 일반 텍스트 작업으로 접수되며, 결과는
Discord 텍스트로만 받는다.

### 레인 관리 도구와 운영 스킬

헤드만 `lane_models`, `lane_init_presets`, `lane_start`, `lane_set_model`,
`lane_inspect`, `lane_message`, `lane_pause`, `lane_resume`, `lane_close`,
`thread_inspect`, `lane_thread_update`, `messenger_presence`, `lane_watch`, `pr_watch`, `pr_watch_list`,
`discord_context`, `discord_purpose_list`, `discord_purpose_set`, `discord_purpose_clear`,
`decision_list`, `decision_inspect`, `decision_withdraw`를 사용한다.
`decision_ask`는 HEAD와 레인 root에서 사용하며 native 자식에는 제공하지 않는다.
`lane_inspect({})`가 목록 조회다. 레인에는 관리 권한을, native 자식에는 관리·게시판 권한을 주지 않는다.
일반 OMP에 이 확장들을 전역 설치하지 않는다. 도구 인자·역할 경계는
[설계의 관리 도구 계약](design/execution.md#management-tools)을 따른다.

- `skill://superagent-head`: 라우팅·모델 선택·감독 절차. root head에는 `SKILL.md`의 역할
  지침만 주입하고 상세 참조는 필요할 때 패키지 경로에서 읽는다. 역할 파일 수정은 Host 재시작 뒤 반영된다.
- `skill://superagent-lane`: 범위 내 직접 작업·부분 위임·검증·보고. 상세 workflow는 필요할 때 읽는다.
- native discovery를 사용하므로 현재 cwd와 무관하게 위 URI를 읽을 수 있다. 사용자·프로젝트
  스킬을 덮어쓰지 않는다. `--no-skills`는 이 URI 기반 운영 흐름에서 사용하지 않는다.

### 온라인 표시와 작업 감시

| 운영자가 보내는 요청 예시 | 동작 |
| --- | --- |
| `디스코드 봇 온라인 상태 유지해 줘` / `온라인 상태 알려줘` / `온라인 표시 꺼 줘` | 현재 Discord 봇의 온라인 표시를 유지·조회하거나 `invisible`로 바꾼다. 다른 사용자나 계정을 추적하지 않는다. |
| `이 레인 감시해 줘` / `감시 목록 보여줘` / `이 레인 감시 중지해 줘` | 원래 대화에서 선택한 레인의 기록된 진행·중단 사유·종료를 관찰한다. 알림 중지는 레인 일시정지나 작업 취소가 아니다. |
| `owner/repo#35 CI가 통과하면 알려줘` | 아래 PR 관찰을 등록한다. HEAD는 등록 결과를 확인한 뒤 답한다. |

대상이 불분명하면 레인 이름이나 PR URL을 알려준다. 바인딩된 대화에서도 명확한 감시 요청은
HEAD가 처리하며, 일반 작업과 인용문은 기존처럼 취급한다. 필요하면 `/head`로 명시한다.
다른 대화로 등록이 자동 이전되지 않는다. 기존 Gateway와 HEAD가 실행 중이어야 하며
봇을 하나 더 띄우거나 추가 토큰을 발급할 필요는 없다.
실제 연결이 없는 상태를 “메신저에서 온라인으로 보인다”로 해석하면 안 된다.

Discord의 온라인·숨김 설정은 같은 Gateway가 재접속할 때 적용한다. 상태 조회는 **설정값,
현재 연결, 현재 소켓에 마지막으로 쓴 값**을 구분한다. 사용자의 화면 표시, HEAD 준비 여부,
레인 실행 상태를 증명하지 않는다. 시작 전 기본 동작은 그대로이고 숨김도 메시지 수신을 끄지 않는다.
Slack Socket Mode 앱의 봇 온라인 표시는 [Slack 앱 설정](https://docs.slack.dev/apis/web-api/user-presence-and-status/#events-api-bots)에서
관리한다. Telegram Bot API는 온라인 표시를 지원하지 않는다. 둘 다 사용자 토큰이나 쿠키로 우회하지 않는다.

### PR 후속 추적

헤드에 PR URL을 알려 추적을 요청한다. `pr_watch`는 `action: "track"`,
`ref`(GitHub PR URL 또는 `owner/repo#번호`), 실제 원본 `sourceId`,
선택적인 `intervalSeconds`를 받는다(생략하면 5분). `laneId`는 기존 레인과의 정보상 연결이며,
`ignoreAuthors`는 알림에서 제외할 GitHub login 목록이다. 예를 들어 300초마다
리뷰·CI 변경을 확인하도록 요청할 수 있다. 자동 등록은 하지 않는다.

`pr_watch_list({sourceId, ref?})`로 이 대화의 등록·기준점·최근 관찰·다음 확인 시각·오류·보류를 조회하고,
`pr_watch({action: "untrack", ref, sourceId})`로 추적을 끝낸다. 이들은 HEAD의 native
도구이지 메신저 slash command나 셸 명령이 아니다.

- 별도 설치된 `gh`가 HEAD 환경의 PATH에 있어야 하고 `github.com` 읽기 인증이 필요하다.
  기존 `gh` 인증을 쓰며 자체 토큰 저장이나 로그인은 하지 않는다. Enterprise 호스트는 지원하지 않는다.
- 첫 성공 조회는 기준점만 저장한다. 이후 새 리뷰·댓글, 리뷰 상태 변경, 현재 head의 CI 통과·실패·재실패,
  외부/불명 head 변경, PR 종료·재개·병합을 원래 등록 대화의 HEAD 입력으로 전달한다.
  실제 성공한 검사가 있고 나머지 일부가 skip/neutral이면 이를 구분해서 보고한다.
  전부 skip이거나 검사가 없으면 통과가 아니다. CI 통과가 병합 가능 여부의 보증은 아니다.
  본인 댓글·본인만의 push와 이미 관측한 항목은 반복 알리지 않는다.
- 레인이 완료·비상주가 되어도 HEAD runtime의 일반 코드가 조회한다. 변화가 없으면 모델 턴을
  만들지 않는다. HEAD/Gateway가 꺼져 있는 동안에는 조회하지 않으며 다시 시작하면 저장한
  기준점과 비교한다. GitHub가 조회 사이 삭제한 정보까지 복원하는 이벤트 보관 서비스는 아니다.
- 변경 알림과 cursor는 같은 SQLite 트랜잭션으로 기록한다. 조회 실패는 기준점을 바꾸지 않고
  동일 오류의 반복 알림을 억제한다. 병합된 PR은 조회를 끝내며, 미병합 종료는 재개를 관찰한다.
- `/stop head`는 기존 추적의 자동 깨우기도 보류한다. 이후 별도 사용자 요청으로 다시 등록해야
  기준점을 새로 잡는다. 추적 해제·등록 변경과 경합한 이전 조회는 결과를 반영하지 않는다.
- 관측은 승인이나 작업 재개가 아니다. HEAD가 의미를 판단하며 레인 자동 재개, 댓글, push,
  merge는 하지 않는다. 기존 pause·승인·불확실성 보류를 유지한다.

### Discord 채널 문맥과 용도 메모

새 Discord 입력에는 이미 확보된 채널 객체에서 읽은 이름·설명(topic), 스레드 이름과 부모
채널 정보가 문맥으로 붙는다. DM은 DM으로 표시한다. 메타데이터를 얻지 못한 필드는 생략하고
메시지 접수는 계속한다. 입력 재전달 때 채널 이름이나 설명이 달라져도 중복 요청으로 만들지
않으며 처음 접수한 스냅샷을 보존한다. 현재 상태가 필요하면 `discord_context({sourceId})`로 조회한다.

운영자는 해당 대화에서 “이 채널은 프로젝트 X 조사용”처럼 용도를 기록하도록 요청할 수 있다.
HEAD는 실제 입력 ID로 다음 도구를 사용한다.

- `discord_purpose_set({sourceId, purpose, scope?})`: 용도 기록·변경.
- `discord_purpose_list({sourceId})`: 원래 대화의 채널·스레드 메모 조회.
- `discord_purpose_clear({sourceId, scope?})`: 용도 메모 제거.

scope 생략은 원래 대화, `channel`은 정확한 부모 채널, `thread`는 입력이 발생한 스레드다.
다른 채널이나 형제 스레드 ID를 임의 지정할 수 없다. 같은 원본 요청으로 부모와 스레드에
각각 기록할 수 있지만 같은 대상에 대한 상충한 재시도는 거절한다. 새 변경에는 새 사용자
요청이 필요하다. 메모·재시도 영수증은 기존 SQLite에 저장되며 재시작 후에도 유지된다.
설정은 Discord 채널 설명 자체를 수정하지 않는 로컬 메모다.

채널 이름·설명과 용도 메모는 모두 **문맥이지 명령·승인·자동 라우팅 규칙이 아니다**.
HEAD가 저장소와 작업 범위를 판단하는 데 참고하며, 메모를 바꿔도 기존 입력 스냅샷·레인
연결·실행 상태는 바뀌지 않는다.

### 일반 모델 프로필과 역할 특화

관리형 omp-superkit 설치·일반 프로필 로드만으로 SUPER 워크플로를 선택하거나 goal을 만들지 않는다.
일반 작업은 직접 처리·native task·일반 레인으로 충분할 수 있다. 사용자의 명시적 선택 또는
허가 목표 안에서의 헤드 판단으로만 workflow를 선택한다. 메신저에서는 작업 요청을 `super`,
`super-plan`, `super-run`, `super-loop`, `super-research`, `super-graph` 중 하나로 시작한다.
`/super` 등은 OMP 확장 명령이며 메신저에 등록하는 별도 명령이 아니다.
`lane_start`/`lane_message`의 실제 `workflow: {name, reason}`에는 `jevify` 또는 위 여섯 이름
중 하나와 비어 있지 않은 이유를 전달한다. 기존 ULW 호출은 원본 사용자 요청에서만 호환되며,
새 구조화 선택에는 쓰지 않는다.
기존 source/provenance·dedupe를 유지하며 workflow 선택은 실행 중 steering이 아닌 직렬
dispatch다. SUPER 워크플로는 더 가벼운 대안보다 유용한 이유를 남기고 선택한 스킬을 읽는다.
호출 이름과 스킬 ID는 다르다. 예를 들어 `super-run`은 `skill://ulw-execute`를 읽는다.
jevify는 충분히 큰 동질적 자료에 고정 rubric을 독립 적용하여 읽기/context 비용을 줄일 때만
선택하며 개수·난이도로 고정하지 않는다. 정확한 규칙·작은 묶음·항목 간 추론·실제 검증은
각각 deterministic 처리·직접 읽기·contextual 조사·테스트/runtime 검증을 쓴다.
계획만 요청받았으면 구현하지 않으며 native 승인·artifact
review·비용·범위·pause/cancel·불확실성 보류를 우회하지 않는다.
방법별 선택·구조화된 인계·정확한 스킬 ID와 native mode 매핑 및 기준 upstream 리비전은
[설계의 workflow 계약](design/execution.md#workflow-selection)에 모은다.
사용자 jevify 선택은 원래 입력 선두의 소문자 독립 prose `jevify`만 인정하며 `/jevify`·대문자·
인용/code/path·부정·뒤쪽 언급은 아니다. 호출 없는 일반 원문에도 헤드 선택 필드는 사용 가능하다.
runtime의 `workflowPrompt`는 fenced context 밖에 소문자 native `jevify`를 prefix하며 SUPER
extension-command capability 조회를 하지 않는다. 레인은 실제 OMP jevify notice와 `eval`이 안내하는
judge 도움말(OMP 19.1에서는 `help://eval/judge`)을 따른다. notice 활성화는 native `magicKeywords.enabled`·`magicKeywords.jevify`와
eval 가용성에 달리므로 admission만으로 보장하지 않는다. 전역 설정을 바꾸지 않으며 jevify에는
SUPER 스킬 조회·추가 레인·goal·모델 변경·workflow artifact가 필요하지 않다.
레인의 보고는 헤드용이며 외부 발송이 아니다. 내부 지시·보고는 영어, 헤드의 외부 답변은
사용자 언어를 사용한다.

### 공유 정보 게시판 사용

같은 instance에 실제 연결·등록된 head/lane만 게시판을 쓴다. 일반 OMP·다른 instance·native
자식·복사한 role 환경변수만 가진 세션은 참여할 수 없다. 같은 instance의 참여자는 모든
채널을 읽을 수 있으므로 repo 채널을 보안 격리로 여기지 않는다.

```text
board_post({text: "Observed fact and relevant evidence", mentions: ["head"]})
board_read({channel: "general", limit: 20})
board_subscribe({channels: ["general", "repo:/absolute/repository"]})
```

이는 셸 명령이 아닌 native 도구 인자 예다. 실제 광고된 스키마를 따른다. 전체 transcript나
비밀 대신 간결한 관측·근거·충돌을 공유한다. 반환된 정확한 게시물만 읽음 처리하며 구독은
실제 세션별이다. header 알림과 본문 읽음은 다르다. 게시물은 명령·승인·완료 근거가 아니며
유휴 모델 호출·unloaded 레인 기동을 만들지 않는다. membership·도구 필드·알림의 정확한
계약은 [설계의 게시판 절](design/execution.md#shared-information-board)을 따른다.

### 새 레인의 모델 선택

명시적 `start` 때 기존 헤드가 native `high/middle/low` 프리셋을 조사한다. 누락 항목은
같은 헤드의 최초 전용 초기화 턴에서 생성·재조회한다.
`setup`·`doctor`는 봇·모델을 실행하지 않는다. `head.initialization`이 `complete`여야 일반
작업을 시작한다. `blocked/failed/uncertain`이면 `status`의 사유를 확인하고 일반 OMP의
`/modelpreset list/save/switch/delete`로 충돌·누락을 복구한 뒤 헤드를 재시작해 재조회한다.
실패·재시작·완료 뒤 삭제를 이유로 초기화 턴을 자동 반복하지 않는다. 프리셋 이름은 실측
성능·가격 등급이 아니며 모델 정책은 이 JSON 설정에 별도 작성하지 않는다.

관리 프리셋은 영속 OMP 역할 `slow → high`, `default → middle`, `smol → low`를
따른다. 시작 시 역할을 확인하고 실행 중에는 native 설정 파일과 관련 경로의 변경을 감시한다.
감시할 수 없는 경로나 보류된 갱신은 느린 주기로 다시 확인한다. 변경된 역할의 모델이
가용하면 모델 호출 없이 현재 역할·기본 effort를 다시 저장한다. 기존 프리셋은 역할 스냅샷과 모델이
현재 설정에 일치할 때만 관리 대상으로 인수한다. 수동으로 수정·삭제한 관리 항목과
다른 프리셋, 상위 설정이 가린 항목은 덮어쓰지 않는다. 이미 실행 중인 헤드와 기존
레인이 보유한 모델·프리셋 스냅샷은 바뀌지 않는다.

헤드는 실제 요구·native 가용 후보를 조사하고 통상 native judge 자문 뒤 최종 모델과 이유를
정한다. 자문은 스킬 정책이지 모든 호출에 영수증을 요구하는 runtime gate가 아니다.
레인 선택은 전체 preset snapshot으로 유지하며 이후 프리셋 편집·재개로 바뀌지 않는다.
가용성·identity drift는 자동 대체 없이 보류한다. 명시적 유휴 레인 변경은 헤드의
`lane_set_model`로만 요청하며 전역 설정·헤드·다른 레인·pause/uncertain 상태를 바꾸지 않는다.
`lane_inspect`에서 저장된 `model/modelPreset/modelPresetSnapshot/modelReason`과 실제
`state.model`·`modelCheck`를 구분한다. 실제 상태가 null이면 일치가 아니라 미관측이다.
최초 쓰기 예외·judge 제한·모델 채택·private overlay 계약은
[설계의 모델 선택 절](design/execution.md#models-and-presets)을 따른다.

## 1. 로컬 준비 — 봇은 시작하지 않음

현재 소스는 Git, **Bun >= 1.4.4**(`packageManager: bun@1.4.4`)와 로컬 Unix socket을
사용한다. OMP 없이 패키지를 설치할 수 있다. Host 실행에는 별도로 설치한 stock OMP가
필요하며, 버전 번호로 차단하지 않고 `rpc-ui`, 세션 재개, 확장, 모델 선택과 프로세스 관측
인터페이스를 확인한다. OMP 18은 수동 호환성 검사 대상이며 자동 CI의 SDK 기준선은
[OMP 19.1.1](https://github.com/can1357/oh-my-pi/commit/31ffee513f27a01bba7d4dfbe12bae239cdc646a)이다.
`doctor`는 `command`가 고른 실행 파일 경로, 버전, 서비스 백엔드를 보여주며 로그인이나
런타임 호환성을 보증하지 않는다. Host는 실제 RPC 초기화와 소유권 검사를 거친다.
18에서 19로 올리기 전에 기존 Host가 맡은 백그라운드 서비스를 확인한다. OMP 19의 사용자별
데몬은 이전 브로커의 서비스를 인수하지 않는다. 새 데몬의 목록이 비어 있어도 이전 세션에서
완료를 확인하지 못한 작업의 종료·회수를 승인하는 증거는 아니다.
기본 `command: ["omp"]`는 PATH에서 찾는다. 다른 설치를 쓰려면 `command`의 첫 항목에
그 OMP 경로를 넣는다. 상대 경로는 설정 파일의 디렉터리 기준이며 모든 레인이 같은 경로를
사용한다. 이 저장소는 OMP를 다운로드하거나 소스에서 빌드하지 않는다.

```sh
bun add --global --trust omp-superagent@0.1.8
omp-sa --help
```

`--trust`는 관리형 omp-superkit 준비 등 패키지 설치 스크립트를 허용한다.
`bun pm bin --global`의 출력 경로를 PATH에 포함한다. Bun이 PATH에 있으면
`npm install --global omp-superagent@0.1.8`도 사용할 수 있다.
설정은 설치 디렉터리가 아닌 사용자 작업 디렉터리에
`omp-sa setup --config ./config.local.json`으로 만든다. 설치만으로 봇을 활성화하지 않는다.

배포용 npm 패키지는 플랫폼에 맞는 Gateway와 Host 중계기 실행 파일을 포함한다. 소스 checkout이나 GitHub 소스
tarball에서는 stable Rust/Cargo, CMake와 C 컴파일러를 준비하고 저장소 루트에서 실행한다. Cargo는 각 `Cargo.lock`에
맞춰 이 두 실행 파일을 빌드하며 OMP는 빌드하지 않는다. Rust 소스 수정 후에는 `bun run build:native`로 다시 준비한다.

```sh
bun install --frozen-lockfile
```

설치 단계에서는 OMP를 실행하지 않는다. `setup`·`doctor`와 실제 Host 시작에서 선택된 CLI를 확인한다.
루트 SDK 의존성은 배포된 `@oh-my-pi/pi-coding-agent`, `@oh-my-pi/pi-ai`,
`@oh-my-pi/pi-catalog`, `@oh-my-pi/pi-natives`, `@oh-my-pi/pi-tui`, `@oh-my-pi/pi-utils`이며 모두 같은 기준판으로 고정한다. 설치는 봇을 시작하지 않으며
기존 OMP 실행 파일·전역 설정을 교체하지 않는다.

시스템 Bun을 바꾸지 않으려면 선택적으로 격리된 로컬 도구를 사용한다.
이하 `bun` 명령과 설정의 Bun 경로는 이 도구를 가리키게 한다.

```sh
npm install --prefix .upstream/toolchain --no-save bun@1.4.4
export PATH="$PWD/.upstream/toolchain/node_modules/.bin:$PATH"
```

이는 현재 셸의 PATH만 바꾼다. 전역 설치·기존 OMP 교체·자동 시작 등록은 필요 없다.
모델 제공자 인증은 기존 OMP 방식으로 별도 준비한다. 이 프로젝트가 인증 엔진을 대체하지 않는다.

### 필수 관리형 omp-superkit 설치와 갱신

설치에는 공식 [dbc-hbin/omp-superkit](https://github.com/dbc-hbin/omp-superkit)이 항상 포함된다.
루트 `bun install`의 postinstall이 관리형 패키지를 준비한다. 활성화 검사는 배포된 native SDK의
실제 prompt composition을 사용한다. 최신 레이아웃에서는 `skill://super`와 `skill://super-*`의
지침과 포인터를 검사하고, 기존 스킬 ID도 별칭으로 해석되는지 확인한다. 이전 레이아웃의 유효한
설치는 그대로 사용할 수 있다. omp-superkit만 다시 준비할 때는 다음을 사용한다.

```sh
bun run prepare:ulw
```

설정은 `upstream/ulw.json`의 공식 원격과 `checkIntervalMs: 3600000`(1시간)이다. 설치 때 원격의
**기본 브랜치 HEAD**를 확인한다. production Gateway 시작에는 이미 유효한 active 설치가
필요하다. 이를 확인하면 IPC/head를 먼저 시작하고 startup 원격 확인은 백그라운드로 수행하며,
이후 매시간 새 커밋을 확인해 준비·활성화한다. 느리거나 접근 불가능한 upstream 때문에 정상
active가 있는 Gateway 시작을 기다리게 하지 않는다. 이는 일반 코드의 업데이트 확인이지 모델 watchdog·작업 레인 실행이나
메신저 봇 로그인 허가가 아니다. Git·의존성 다운로드에 네트워크가 필요하며 사용자 omp-superkit
checkout, 전역 OMP 설치·설정, 공유 프롬프트 원본은 수정하지 않는다.

준비·offline composition probe가 성공한 immutable revision만 원자적으로 활성화한다.
기존 active 이후에는 같은 원격의 fast-forward만 허용하며, 공식 `omp-ulw` → `omp-superkit`
이름 변경에도 같은 검사를 적용한다. 실패·rewind·divergence는 이전 active를 보존한다.
상세 lock·staging·probe 계약은 [설계](design/execution.md#managed-omp-superkit-integration)를 따른다.
관리 pointer/lock을 수동 편집해 우회하지 않는다. active가 없거나 무효면 start는 어댑터
활성화 전에 실패하므로 `bun run prepare:ulw`로 먼저 복구한다. doctor는 원격 최신성이나
loader 성공을 검사하지 않는다. 이전 revision은 자동 삭제하지 않는다.

설치 상태만 네트워크 없이 읽으려면 다음을 사용한다.

```sh
bun run prepare:ulw -- --status
```

Gateway 상태 응답의 `ulw`는 `revision`, `packagePath`, `upstreamRevision`, `checkedAt`,
`error`, `updating`을 구분한다(`injected`는 테스트용 주입인 경우에만 표시). `revision`과
`packagePath`는 **다음 새 Host가 사용할 active package**이며 실행 중 모든 Host의 버전이 아니다.
`upstreamRevision`은 마지막 확인한 원격 결과이고 `checkedAt`·`error`·`updating`과 함께 읽는다.
원격 조회 실패·미확인을 최신 일치로 표시하지 않는다. `omp-sa status --config FILE`의
`gateway.head.loadedSuperkitPath`는 연결된 head의 실제 OMP 세션이 시작할 때 확인한 패키지 경로다.
이 경로와 `gateway.ulw.packagePath`가 다르면 head는 아직 이전 버전을 쓰고 있다.
각 새 head·lane은 manifest의 모든 확장 모듈이 그 세션의 활성 목록에 있어야 시작한다.
파일이 있어도 import·초기화가 실패하거나 모듈이 비활성이면 준비 완료가 되지 않는다.
로드 확인을 지원하지 않는 기존 Host는 작업용으로 재연결하지 않는다. 진행 중인 작업을
확인하고 정상 종료한 뒤 다시 시작한다. 설치·검사는 일반 OMP의 전역 설정을 변경하지 않는다.

**실행 중 Host의 revision과 다음 Host의 revision은 다를 수 있다.** 이미 실행 중인 head/lane은
자신이 로드한 정확한 package 경로를 유지하며 업데이트 때문에 재시작·hot reload하지 않는다.
각 새 Host 시작은 그 시점의 active package를 해석한다. 따라서 오래 실행된 head가 나중에 새
lane을 시작해도 head의 과거 패키지 경로를 새 lane에 강제로 상속하지 않는다. 기존 Host의 제어
연결 재접속은 새 revision 적용이 아니다. 설치·업데이트 성공은 native workflow 선택,
mode 활성화·goal 생성·실제 모델 응답의 검증과 별개다.

## 2. 플랫폼별 앱과 접근 범위

사용할 플랫폼만 준비한다. 토큰은 어댑터에 **환경변수로만** 전달하며 일반 설정 JSON, argv,
Git 추적 파일에 쓰지 않는다. 아래 셋업은 별도 소유자 전용 환경 파일에 저장할 수 있다.
`tokenEnv`·`botTokenEnv`·`appTokenEnv`에는 토큰 자체가 아니라 환경변수 이름을 넣는다.

### 2.1 Discord

1. [Discord Developer Portal](https://discord.com/developers/applications)에서 앱과 Bot을 만든다.
   Bot 설정의 **Privileged Gateway Intents → Message Content Intent**를 켠다.
   서버 메시지 본문을 수신하려면 코드의 intent 요청과 포털 설정이 모두 필요하다.
2. 운영할 서버에 `bot`과 `applications.commands` 범위로 초대한다. 필요한 채널에 View Channel, Read Message History,
   Send Messages, Send Messages in Threads, Create Public Threads, Attach Files, Add Reactions 권한을 부여한다. 카드 표시에는 선택적으로 Embed Links 권한도 부여한다. 이 권한이 없거나 확인되지 않으면 카드가 코드 블록으로 전송된다.
   비공개 스레드 등은 봇이 실제로 접근할 수 있어야 한다. 관리자 권한은 요구하지 않는다.
3. Discord 개발자 모드로 소유자 **사용자 ID**, 서버 ID, 허용할 **부모 채널 ID**를 복사한다.
   이름·멘션 문자열이 아니라 숫자로 된 ID 문자열을 설정한다.
4. 일반 운영자 라우트의 입력·승인 권한은 `ownerId` 한 명에게만 있다. 봇과 webhook 입력은
   받지 않는다. 다른 사람에게 제한된 기능만 열려면 별도의 [`groupRooms` 규칙](#단체방서버-권한-분리)을 사용한다.
   서버 입력은 `allowedGuildIds`와 `allowedChannelIds`를 **모두** 통과해야 한다.
   스레드는 부모 채널 allowlist를 따른다. 빈 배열은 모든 서버 허용이 아니라 서버 입력 차단이다.
   소유자의 1:1 DM은 서버 allowlist와 별개이며 그룹 DM은 대상이 아니다.
5. 채널을 다른 봇과 같이 쓰거나 소유자의 일상 대화를 제외하려면 설정 파일에서
   `discord.requireAddressing`을 `true`로 바꾼다. 기본값은 `false`이며 변경은 다음 Gateway
   시작부터 적용된다. 실행 중이면 `omp-sa stop main --config FILE`로 정상 종료가 확인된
   뒤 `omp-sa start --config FILE`을 실행한다. 허용된 서버의 부모 채널에서는 소유자가
   **이 봇을 실제로 멘션**하거나 **같은 채널에서 이 봇이 보낸 메시지에 답장**해야 일반 메시지가
   접수된다. 봇 이름만 쓰거나 다른 봇을 멘션하는 것은 해당하지 않는다. 메시지 수정과 연결
   복구 때 가져오는 메시지에도 같은 기준을 적용한다. 이 봇이 만든 허용 스레드에서는 멘션이나
   답장 없이 계속 대화할 수 있다. 다른 봇이나 사람이 만든 스레드는 부모 채널과 같이 멘션이나
   이 봇 메시지에 대한 답장이 필요하다.
   소유자 1:1 DM, Discord 앱 명령, 승인 버튼, 제한된 `groupRooms`의 규칙은 그대로다.
   지정 텍스트 채널에서의 실시간 `/voice` 제어는 [음성채팅 규칙](discord-voice.md#사용)을 따른다.

```sh
read -r -s DISCORD_BOT_TOKEN
export DISCORD_BOT_TOKEN
```

위 입력은 Bash에서 토큰이 화면과 명령 이력에 노출되지 않게 받는 예다.
프로세스는 현재 사용자 권한과 환경을 사용한다. 레인과 worktree는 보안 샌드박스가 아니다.

Discord 자동완성 목록은 명시적으로 등록한다. 명령을 등록하기 전에 Gateway와 HEAD 모두
새 버전으로 실행 중이어야 한다. Gateway만 교체하면 기존 HEAD에 재연결될 수 있다.
Discord에서 `/help`를 보내 `/usage-reset`이 표시되는지 확인한다. 표시되지 않으면
등록하지 말고 HEAD 업데이트를 먼저 마친다. 작업 중인 HEAD를 강제 종료하지 않는다.

```sh
bun --no-env-file src/cli.ts discord-commands --config config.local.json
bun --no-env-file src/cli.ts discord-commands --config config.local.json --apply
```

첫 명령은 읽기 전용 변경 확인이다. `--apply`는 **이 봇의 전역 명령 목록 전체를 교체**하므로
전용 Superagent 앱에서만 사용한다. Hermes 전용 명령은 제거하고 `/head`를 포함한
[공통 명령 목록과 Discord 전용 `/usage-reset`](../src/messenger-command-catalog.json)을 등록한다.
별도 guild 명령이 전역 명령을 가리는 경우 몰래 삭제하지 않고 충돌을 알린다.
등록은 모델·메신저 연결을 시작하지 않으며 setup·doctor·start의 부수 효과로 실행되지 않는다.
인수가 있는 명령은 선택적인 `text` 필드를 사용한다. 예를 들어 `/model`의 `text`에
`preset high`, `/stop`의 `text`에 `head`를 넣는다. 일반 메시지로 쓰는 `/status`도 지원하며,
`discord.requireAddressing`을 켠 부모 채널에서는 다른 일반 메시지와 마찬가지로 이 봇을
멘션하거나 이 봇의 메시지에 답장해야 한다.

명령은 기존 소유자와 허용 채널·스레드·1:1 DM 경계를 그대로 따른다. 영속 접수 뒤 비공개
접수 확인을 보내고 실제 결과는 기존 outbox로 원래 대화에 보낸다. interaction ID는 실제
메시지 ID가 아니므로 history cursor·반응·메시지 fetch·스레드 원본으로 사용하지 않는다.
interaction token은 저장하거나 헤드에 넘기지 않는다. Discord는 최초 응답을 3초 안에
요구한다. 접수/ACK가 불확실하면 자동 재실행하지 않으며 상태를 확인하기 전 같은 변경 명령을
반복하지 않는다. API 계약은 [Discord interactions 문서](https://docs.discord.com/developers/interactions/receiving-and-responding)를 따른다.

### 2.2 Telegram

1. 공식 [BotFather](https://core.telegram.org/bots/features#botfather)에서 봇을 만들고 받은 토큰을
   `TELEGRAM_BOT_TOKEN` 같은 환경변수에 보관한다. 소유자가 먼저 봇의 private chat을 시작한다.
2. `ownerId`에는 **양수 숫자 사용자 ID 문자열**, `allowedChatIds`에는 허용 그룹/supergroup의
   **음수 chat ID 문자열**(예: 실제 `-100…` ID)을 넣는다. 이름·전화번호·username은 ID가 아니다.
   소유자의 private chat은 별도로 허용되며 빈 배열은 그룹 입력 차단이다.
   일반 운영자 라우트에서는 허용된 그룹에서도 설정 소유자의 직접 메시지만 받는다.
   익명 관리자 `sender_chat`, 봇, 전달 메시지, via-bot·business 입력을 운영자 권한으로 인정하지 않는다.
   등록된 제한 그룹은 별도의 `groupRooms` 규칙을 따른다.
3. 그룹의 일반 메시지까지 처리하려면 봇이 그 내용을 볼 수 있어야 한다.
   [Privacy Mode](https://core.telegram.org/bots/features#privacy-mode)를 BotFather에서 조정하거나
   봇의 관리자 가시성을 명시적으로 구성한다. Privacy Mode가 켜져 있으면 일반 메시지 전체가
   전달된다고 가정하지 않는다. 설정 변경 후 그룹 재추가가 필요한지는 Telegram 안내를 따른다.
4. native forum topic은 forum을 켠 supergroup에서 사용한다. 새 topic 생성에는 봇의 관리자
   **`can_manage_topics`** 권한이 필요하고 메시지·문서 전송도 허용되어야 한다.
   실제 `message_thread_id`로 레인을 분리한다. `getMe.has_topics_enabled`인 봇은 private
   chat에서도 헤드의 새 주제 인계 시 실제 topic을 우선 생성한다. 미지원 private chat은
   `/new`·`/main`의 논리 주제를 사용한다. 일반 그룹에 가짜 forum/thread ID를 만들거나
   topic 모드를 임의로 활성화하지 않는다.
5. 시작 시 Telegram Bot API `getMe`로 봇을 확인하고 `getWebhookInfo`를 확인한 뒤 `getUpdates` long polling을
   사용한다. public endpoint는 필요 없다. **기존 webhook이 있으면 시작을 거부하며 자동 삭제하지
   않는다.** 기존 webhook/polling 소비자와 함께 실행하지 말고 운영자가 명시적으로 전환한다.
   인증 완료만으로 polling을 시작하지 않으며 runtime의 시작 시 승인 조정이 완료된 뒤 수신을
   연다. 이 준비가 실패하거나 기다리는 중 stop되면 offset/ACK를 진행하지 않고 수신을 멈춘다.

```sh
read -r -s TELEGRAM_BOT_TOKEN
export TELEGRAM_BOT_TOKEN
```

[Telegram Bot API](https://core.telegram.org/bots/api#getupdates)를 사용한다.
업데이트는 Gateway가 원본 이벤트를 durable admission한 뒤 다음 offset을 저장하며,
그 offset을 사용한 다음 polling에서 Telegram 측 확인이 진행된다. Bot API에는 대화 history나
임의 `getMessage` 조회가 없다. 복구는 저장한 offset과 Telegram의 **최대 24시간 업데이트 보존**에
한정되고, 임의의 과거 대화·기한이 지난 업데이트·옛 메시지 수정/삭제를 복원할 수 없다.
마지막으로 접수한 업데이트의 관측 시각도 영속화한다. 업데이트 없이 24시간 이상 지났거나
관측 시각이 없거나 잘못되었거나 시계가 뒤로 이동하면 오래된 offset을 다음 요청에서 생략한다.
이는 [일주일 이상 유휴 시 update_id가 임의 재설정되는 동작](https://core.telegram.org/bots/api/types/update.md)에
대비한 처리이지 history 복원이 아니다. 유휴 구간을 넘어 update_id가 계속 증가한다고 가정하지
않으며, 재전달은 안정적인 메시지 ID와 callback-query ID로 구분한다.

Telegram 명령 메뉴는 다음 명령으로 확인·적용한다. 실제 polling이나 webhook 변경은 하지 않는다.

```sh
bun --no-env-file src/cli.ts telegram-commands --config config.local.json
bun --no-env-file src/cli.ts telegram-commands --config config.local.json --apply
```

소유자 1:1 DM과 검증된 허용 그룹의 소유자 전용 범위만 갱신한다. 다른 사용자·scope는 보존한다.
그룹 메뉴가 보내는 `/status@봇이름`은 실제 command entity와 봇 username을 확인한 뒤
`/status`로 처리하고, 다른 봇 대상 명령은 무시한다. 메시지 ID·topic·영속 offset 경계는 그대로다.
언어별 목록은 `--language ko`처럼 선택할 수 있다. Telegram API는 모든 기존 언어 override를
열거할 수 없으므로 선택하지 않은 언어별 목록까지 정리됐다고 보장하지 않는다.
공식 API는 [setMyCommands](https://core.telegram.org/bots/api/methods/setmycommands)와
[getMyCommands](https://core.telegram.org/bots/api/methods/getmycommands)를 사용한다.

### 2.3 Slack

1. [Slack 앱](https://api.slack.com/apps)을 만들고
   [Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode)를 켠다.
   같은 앱의 App-Level Token에 **`connections:write`**를 부여해 `xapp-…` 토큰을 받는다.
   Bot Token은 별도의 **`xoxb-…`** 토큰이다. user token을 대체재로 쓰지 않는다.
2. OAuth & Permissions의 Bot Token Scopes에 아래 권한을 구성하고 workspace에 앱을 설치한다.
   scope 변경 후에는 재설치가 필요하다. 사용하는 채널 유형에 맞는 읽기/history scope가 필요하다.

   | 용도 | Bot scope |
   | --- | --- |
   | 메시지 발송, 소유자 확인 | `chat:write`, `users:read` |
   | 수신 확인·처리 중 반응 | `reactions:write` |
   | 공개/비공개 채널·1:1 DM 확인 | `channels:read`, `groups:read`, `im:read` |
   | 알려진 대화·스레드 복구와 승인 카드 확인 | `channels:history`, `groups:history`, `im:history` |
   | 첨부 확인·다운로드, 긴 출력 업로드 | `files:read`, `files:write` |

3. Event Subscriptions를 켜고 bot events **`message.channels`**, **`message.groups`**, **`message.im`**을
   구독한다. Interactivity도 켠다. 이벤트·Block Kit 버튼·모달과 등록된 명령은 Socket Mode로 받아
   public Request URL/웹 서버가 필요 없다. 명령에는 bot OAuth `commands` 권한도 필요하다.
4. `teamId`는 `T…` workspace ID, `ownerId`는 그 workspace의 활성 인간 사용자 `U…`/`W…` ID,
   `allowedChannelIds`는 `C…`/`G…` 채널 ID 문자열이다. 앱을 허용 채널에 초대한다.
   시작 시 `auth.test`의 bot/workspace와 `users.info`의 소유자를 확인한다.
   일반 운영자 라우트에서는 다른 workspace·사용자·봇·앱 입력을 받지 않고, 소유자의 1:1 DM만
   채널 allowlist와 별도로 허용한다. 등록된 제한 그룹은 별도의 `groupRooms` 규칙을 따른다.
   그룹 DM은 지원하지 않는다. 빈 배열은 workspace 채널 입력 차단이다.
5. Slack 일반 메시지에서는 **`!new [요청]`, `!main`, `!stop`, `!resume`**을 사용한다.
   어댑터가 공통 runtime 제어로 정규화한다. Slack composer가 `/new` 등을 가로챌 수 있으므로
   Discord·Telegram의 `/` 표기를 Slack 명령으로 안내하지 않는다.
   등록된 선택기는 `/superagent-new`, `/superagent-main`, `/superagent-status`처럼
   **`/superagent-<명령>`**을 사용해 Slack 기본 명령과 충돌하지 않는다.

명령 등록에는 bot token이나 `connections:write` app token과 별도로 **앱 구성 token**이 필요하다.
해당 token은 환경변수 또는 private 자격 증명 파일에 넣고, 아래 `NAME`에는 값이 아닌 변수 이름을
전달한다. 첫 호출은 읽기 전용이고 `--apply`만 manifest의 명령 목록을 교체한다.

```sh
bun --no-env-file src/cli.ts slack-commands --config config.local.json --manifest-token-env NAME
bun --no-env-file src/cli.ts slack-commands --config config.local.json --manifest-token-env NAME --apply
```

현재 bot·workspace·app 신원과 manifest를 조회해 같은 앱에만 적용하며 다른 설정은 보존한다.
실행 시에는 Rust Gateway가 `bots.info`의 app ID와 Socket Mode의 `hello.connection_info.app_id`를
대조한다. 재연결의 app 신원이 아직 확인되지 않았거나 다르면 명령을 접수하지 않는다.
`commandsGrant`·`requiresReinstall`·`permissionsUpdated`를 확인한다. manifest 저장만으로
현재 설치의 OAuth grant가 바뀌었다고 가정하지 않으며, 필요한 재설치/승인은 별도로 완료한다.
공식 [manifest API](https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests)와
[Socket Mode 명령](https://docs.slack.dev/apis/events-api/using-socket-mode#command)을 사용한다.
API 실패·불확실한 갱신은 자동 재시도하지 않으며 token·`response_url`은 로그나 조율 DB에 남기지 않는다.

Slack 슬래시 명령은 메시지가 아니며 원본 `ts`·스레드가 없다. 명령 호출의 token-free fingerprint로
중복을 제거하고, 결과는 원래 허용 대화의 outbox로 보낸다. DM 주제 경계는 마지막으로 영속
접수한 실제 소유자 메시지 뒤에 두며 같은 anchor의 명령은 접수 순서를 따른다. 이를 가짜 Slack
timestamp나 플랫폼 전체 송신 순서로 표현하지 않는다. 기존 메시지 수정은 원래 주제에 남는다.

```sh
read -r -s SLACK_BOT_TOKEN
read -r -s SLACK_APP_TOKEN
export SLACK_BOT_TOKEN SLACK_APP_TOKEN
```

Rust Gateway가 [Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/)와
[Web API](https://docs.slack.dev/apis/web-api/)를 사용한다. 명령 등록은 같은 배포 파일의 일회성 Rust
REST 명령을 사용하며 Socket Mode나 Gateway 데몬을 시작하지 않는다.
스레드 조회는 현재 공식 [conversations.replies](https://docs.slack.dev/reference/methods/conversations.replies/)
문서의 bot history scopes를 따른다. bot token이면 채널 스레드를 무조건 조회할 수 없다는
과거 제한을 전제로 하지 않는다. 실제 접근 권한·workspace 보존 정책·API rate limit은 여전히 적용된다.

### 메시지 수신·처리 중 반응

새 레인이 필요한 작업은 범위와 작업 디렉터리를 확인한 뒤 배정된 스레드·topic에
**무엇을 어떻게 진행할지 짧은 착수 보고를 먼저** 보낸다. `lane_start`의 필수 `kickoff`는
사용자 언어의 외부 보고이며, 영어 내부 `brief`와 별개다. 발송 영수증이 확인되기 전에는
레인 실행을 시작하지 않는다. 보고 발송 실패·불확실성은 실행 보류이며 자동 재발송하지 않는다.
저장소가 필요 없는 질문은 원래 대화에서 바로 답하고, 연결된 작업 주제의 일반 메시지는 기존 작업을 이어간다.
native topic을 지원하지 않는 private chat은 기존의 논리 주제 제한을 유지한다.

Discord 포럼에서는 “버그 태그로 새 작업 글을 만들어”, 기존 작업에서는 “제목을 바꿔”,
“이 스레드를 보관해/다시 열어”처럼 요청할 수 있다. 헤드는 `thread_inspect`로 실제 태그 ID와
현재 상태를 조회하고 새 글은 `lane_start.appliedTags`, 기존 관리 스레드는
`lane_thread_update`로 처리한다. 태그는 전체 교체이며 생략하면 보존한다.
필수 태그가 있는 포럼에서 빈 태그를 선택하거나 존재하지 않는 태그를 지정할 수 없다.
기존 스레드 관리와 moderated 태그 선택에는 봇의 **Manage Threads** 권한이 필요하다.
서버 권한을 자동 변경하지 않으며 DM·다른 플랫폼·등록되지 않은 스레드의 변경은 지원하지 않는다.
보관/다시 열기는 레인 중지·완료·재개와 별개다. 진행 중인 레인의 보고 발송에 영향을 줄 수
있으므로 완료 여부만 보고 자동 보관하지 않는다. 변경 결과가 불확실하면 현재 상태를 조회한 뒤
새 명시적 요청으로 조정하며, 동일 요청을 자동 재전송하지 않는다.

Discord 작업 스레드에 실행·대기 중인 요청, 미결 승인, 또는 발송을 기다리는 결과가 있으면 제목에
`⏳`가 붙는다. 마지막 실행이 성공하고 최종 답변이 발송된 것이 확인되면 `✅`로 자동 변경된다.
이는 요청 결과를 전달했다는 뜻이며, 레인을 닫거나 작업의 합격 기준을 별도로 검증했다는 뜻은 아니다.
명시적으로 완료 처리한 레인도 `✅`를 표시한다. 새 후속 요청은 다시 `⏳`로 바뀌고, 중지·취소는
표시를 지운다. 서비스가 시작되면 기존 스레드의 표시도 저장된 기록을 바탕으로 자동으로 맞춘다.
봇에 **Manage Threads** 권한이 없거나 제목 변경이 실패해도 작업과 보고는 계속된다.

오래 걸리는 작업에는 착수 뒤에도 같은 작업 스레드로 간결한 **중간 진척 보고**를 보낸다.
해당 레인이 사용자 언어로 답하는 직접 주제 작업과 직접 HEAD 작업의 중간 문장은 컨트롤러가
기존 발송 경로로 전달한다. 검토형 인계의 내부 레인 보고는 HEAD가 검토하여 전달한다.
레인 실행은 보고 때문에 멈추거나 헤드 답변을 기다리지 않는다. 의미 있는 실행 경계에서
발생하는 보고이지 고정 간격 heartbeat는 아니다. 모델이나 장시간 도구가 새 진척을 내지
못하거나 HEAD 검토가 아직 끝나지 않았으면 새 보고가 없을 수 있다.
별도 감시 모델·주기적 깨우기·로그 전체 전송은 추가하지 않는다.
기존 Host에 역할 지침을 적용하려면 별도로 허가된 재시작이 필요하다. 소스 수정만으로
운영 서비스가 갱신되었다고 간주하지 않는다.

연결 주제에서 `/status`(Slack `!status`)를 쓰면 native 상태와 함께 저장된 근거·대기 관측을
볼 수 있다. 헤드는 `lane_inspect`로 같은 기록을 본다. `lastReportAt`은 구조화 보고 시각이고
`lastEvidenceAt`은 선택한 파일 내용·성공한 native 도구 결과가 마지막으로 바뀐 시각이다.
일반 활동·반복 보고·동일 결과의 다른 호출 ID는 근거 시각을 갱신하지 않는다.
`waiting.target`은 실제 tool/approval/job ID 또는 dependency 이름, `waiting.since`는 해당
대기의 최초 시각이다. 같은 대기를 반복해도 시각이 유지되고, 일반 `progress`는 대기를 지우지 않는다.
일치하는 native tool/approval 종료나 대상·근거를 함께 담은 `resolved`만 그 대기를 해소한다.
job/dependency는 명시적인 근거 포함 `resolved`를 사용한다.

`observationState.ownerCurrent`가 false면 저장된 이력이지 현재 연결된 실행의 대기 증거가
아니다. Host 연결 여부를 뜻하지도 않는다. `lane_inspect`와 `/status`는 별도로 `queueHolds`에
런타임 차단 여부(`runtimeBlocked`), `uncertainInputIds`, 미확인 착수 메시지의 발송 ID와
상태(`kickoff`)를 표시한다. `lane_inspect`는 연결된 Host의 상태를 확인하지 못해도 영속
차단 정보를 반환한다. 연결 주제의 `/status`도 HEAD 상태를 확인하지 못해도 큐 정보를
반환한다. `lane_message`는 영속 입력 ID와 상태를 반환하며, `pending`이면
앞선 입력 또는 현재 실행에 합류한 입력의 불확실한 ID와 런타임/착수 메시지 차단도
표시한다. `pending`은 native 전달이나 실행을 보장하지 않는다.
경과 시간은 조회 시 계산하며 시계 역행이면 null이다. root lane의 `lane_report`만
실제 파일/도구 결과를 선택·해시하고 native journal에 기록한다. eval에서는 보고 cell을
완료한 뒤 긴 대기에 들어가야 해당 경계에서 헤드가 회수할 수 있다. 재시작 시 같은 원본
input/request/session/file/generation과 제출 전 cursor를 확인해 미회수 기록을 읽고 중복을
제거한다. native children은 보고 도구를 쓸 수 없다. 관측은 검증된 acceptance나 현재
대상의 생존 보장이 아니며, 감시 모델·타이머·자동 독촉/재개/종료를 만들지 않는다.

Gateway가 허용된 원본 메시지를 영속 접수한 뒤 수신 확인 반응을 남긴다. 헤드가 없어도
접수 표시는 가능하며, 반응 API 응답을 기다리느라 플랫폼 ACK·offset이나 모델 실행·답변을
지연하지 않는다. 같은 입력의 재전달에는 수신 반응을 다시 시도하지 않는다.

| 플랫폼 | 접수 | native 처리 중 | 처리 종료·중단·승인 대기 |
| --- | --- | --- | --- |
| Discord | 👀 | 👀 유지 + 💭 | 봇 자신의 💭만 제거 |
| Slack | `eyes` | `eyes` 유지 + `thought_balloon` | 봇 자신의 `thought_balloon`만 제거 |
| Telegram | 👀 | 🤔로 교체 | 👀로 복귀 |

Telegram은 [허용 반응 목록](https://core.telegram.org/bots/api/types/reactiontypeemoji.md)에
💭가 없고 [봇은 메시지당 반응 하나만 설정](https://core.telegram.org/bots/api/methods/setmessagereaction.md)할
수 있어 🤔를 사용한다. 채팅의 반응 제한이나 service message 등으로 거부될 수 있다.
Discord는 [자신의 반응 API](https://docs.discord.com/developers/resources/message#create-reaction)를,
Slack은 [`reactions.add`](https://docs.slack.dev/reference/methods/reactions.add)와
[`reactions.remove`](https://docs.slack.dev/reference/methods/reactions.remove)를 사용한다.
기존 Slack 앱은 `reactions:write` 추가 후 workspace 재설치가 필요하다.

반응은 원래 계정·대화·메시지에만 적용한다. 레인용 새 스레드나 내부 report에 가짜 메시지
반응을 만들지 않는다. 동일 메시지 수정본·헤드·레인이 겹쳐 처리되면 마지막 실행이 끝날 때
처리 중 표시를 해제하며, native 승인 응답 뒤에는 다시 표시한다.
권한·rate limit·네트워크 오류는 비밀 값 없는 진단으로만 남기고 메시지 접수·답변을 실패로
바꾸거나 자동 재시도하지 않는다. 이 표시는 작업 성공·완료 검증이나 플랫폼 read receipt가
아니다. 강제 종료·API 실패 시 원격 반응 정리는 보장하지 않는다.

## 3. 설정

### 터미널 셋업

준비된 저장소에서 다음 래퍼를 실행한다. Hermes의 `/dev/tty` 셋업 진입과 비밀 입력·별도
환경 파일 패턴을 참고한 독립 구현이며, Hermes 설치기나 Gateway 서비스 설치는 실행하지 않는다.

```sh
bash scripts/setup.sh
# 다른 경로:
bash scripts/setup.sh --config /absolute/path/to/config.json
# 같은 동작의 직접 CLI:
bun --no-env-file src/cli.ts setup --config config.local.json
# package script를 사용할 때도 바깥 Bun의 자동 로딩을 끈다:
bun --no-env-file run setup
```

`bash scripts/setup.sh --help`는 controlling terminal 없이도 도움말만 출력한다.
실제 설정·토큰 입력은 여전히 terminal이 없으면 저장 없이 거부한다.

래퍼의 기본 경로는 저장소의 `config.local.json`이다. 새 설정은 사용할 플랫폼을 선택하고
소유자 ID, Slack workspace ID, 선택적 허용 그룹/채널, 실제 headCwd/stateDir와 실행 예산을
입력받는다. 빈 그룹/채널 allowlist는 전체 허용이 아니라 기존 정책대로 그룹 접근 차단이다.
OMP 경로는 별도 설치한 stock CLI에서, 예산 제안값은 기존 `config.example.json`에서 가져온다.
모델 제공자·프리셋·계정을 새로 설정하지 않는다.

토큰은 controlling terminal에서 숨김 입력하고 마지막 저장 확인 전에는 확정하지 않는다.
Ctrl-C/EOF로 취소할 수 있으며 터미널이 없으면 비밀을 echo하는 입력 방식으로 우회하지 않는다.
기존 유효한 JSON은 다시 쓰지 않는다. 구성된 credential 이름만 묻고 Enter로 기존 값을
유지할 수 있으며 기존 자격 증명 변경에는 별도 확인이 필요하다.

파일은 `<config 경로>.env`에 mode `0600`으로 저장한다. 예를 들어 `config.local.json.env`다.
이는 암호화 저장소가 아니라 현재 OS 사용자의 평문 비밀 파일이므로 Git·공유 폴더·지원 로그에
올리지 않는다. 기본 `.env`와 달리 Bun의 작업 디렉터리 자동 로딩 대상으로 만들지 않는다.
`start`/`doctor`만 표준 dotenv parser로 읽고 구성된 credential 이름만 환경에 전달한다.
셸 `source`/`eval`은 하지 않는다. 기존 셸의 비어 있지 않은 값이 파일보다 우선하므로 저장한
새 토큰을 사용하려면 해당 셸 변수의 이전 값을 제거해야 한다. 심볼릭 링크·다른 소유자·공개
권한의 비밀 파일은 거부한다. 값은 진단 출력이나 오류 메시지에 표시하지 않는다.
래퍼·아래 직접 CLI 명령·새로 생성한 native Bun command는 `--no-env-file`로 작업 디렉터리의
무관한 `.env` 자동 로딩도 끈다. 수동으로 이 옵션 없이 Bun을 실행하거나 기존 설정의 Bun
command를 유지하면 애플리케이션 진입 전에 Bun이 환경 파일을 읽을 수 있으며, 나중의
credential loader가 이를 원래 셸 환경과 구별해 되돌릴 수는 없다.
바깥 명령을 `bun run setup`처럼 옵션 없이 실행하면 wrapper가 시작하기 전에 이미 자동
로딩된 값이 상속될 수 있으므로 위 표기를 사용한다.
OMP 라이브러리 자체의 프로젝트 dotenv 해석은 Bun의 자동 로딩 옵션과 별개다.
셋업·진단은 해당 runtime 모듈을 import하지 않으며, `start`는 명시적 환경/선택한 비밀 파일의
필수 자격 증명 검사를 통과한 뒤에만 Gateway 모듈을 로드한다. OMP 모델 제공자의 기존 환경
해석 정책을 바꾸거나 같은 OS 사용자로부터 비밀 파일을 격리하는 보안 경계는 아니다.

자격 증명 갱신은 `<config 경로>.env.lock`으로 직렬화하고 잠금 안에서 읽었던 원본이
그대로인지 다시 확인한다. 다른 셋업의 잠금을 빼앗거나 변경된 내용을 덮어쓰지 않는다.
강제 종료로 PID가 기록된 lock이 남으면 해당 셋업이 더는 실행 중이 아님을 확인한 뒤에만
명시적으로 정리한다. 초기 파일 공개 도중 남은 owner-only staging hard link는 기존 비밀
파일을 읽지 못하게 만들지 않으며, 읽기 과정에서 임의로 삭제하지 않는다.

셋업은 상주 봇 연결·메시지 전송·Gateway 시작/재시작·서비스 등록·셸 설정 변경을 하지 않는다.
저장 뒤 별도로 `doctor`, 이후 원하는 시점에 `start`를 실행한다. 실제 토큰 유효성·플랫폼
권한 전체는 로컬 준비만으로 검증된 것이 아니다. 기존 환경변수 전용 실행도 계속 지원한다.

최종 저장 질문 바로 앞에서 Discord/Telegram 프로필 사진을 저장소 시그니처 마스코트로
교체함을 알린다. 저장 확인 뒤 로컬 파일 저장이 성공하면, 새 구성·기존 자격 증명 갱신 모두
`assets/superagent-avatar.jpg`를 자동 업로드한다. 원본 WebP에서 흰 배경 JPG로 변환한
배포 자산이므로 별도 이미지 변환 도구를 설치할 필요는 없다.
[Discord Modify Current User](https://docs.discord.com/developers/resources/user#modify-current-user)와
[Telegram setMyProfilePhoto](https://core.telegram.org/bots/api#setmyprofilephoto)만 사용하며
Gateway·polling·Socket Mode·OMP 세션을 시작하거나 메시지를 보내지 않는다. `doctor`는
이 API를 호출하지 않는다. 저장 전 거절·취소·저장 충돌이면 프로필 호출도 없다.

대상은 입력된 credential 이름에 대해 start와 동일한 셸 우선순위로 결정된다. 셸에 기존
토큰이 남아 있으면 새 파일 값 대신 그 토큰의 봇 사진이 바뀐다는 뜻이다. 실제 bot 신원을
확인한 뒤 업로드하고 Discord는 반환 avatar ID를 GET과 대조하며 Telegram은 성공 응답과
`getUserProfilePhotos`의 현재 사진을 확인한다. Telegram 사진의 바이트 동일성은 확인하지
않는다. 실패하면 CLI가 비정상 종료하고 로컬 저장은 보존하며, 토큰·원시 API 오류는 출력하지
않는다. 일부 플랫폼에는 이미 적용되었을 수 있으므로 실제 사진을 확인한 뒤 셋업 재실행을
결정한다. 자동 재시도는 없으며 취소 시 진행 중인 요청을 중단하고 다음 플랫폼을 호출하지 않는다.

Slack은 [users.setPhoto](https://docs.slack.dev/reference/methods/users.setPhoto/)가 사용자 토큰의
사진을 변경하는 API이고 현재 bot/app 토큰으로 앱 아이콘을 업로드하는 공식 API는 없다.
Slack을 설정했다면 셋업 마지막에 `https://api.slack.com/apps` → 해당 앱 → **Basic Information →
Display Information → App icon**에서 같은 JPG를 수동 업로드하도록 경로를 출력한다.
메시지별 아이콘을 프로필 사진 자동 설정이라고 가장하거나 사용자의 개인 사진을 변경하지 않는다.

**관리형 헤드와 레인은 실효 설정이 `off`가 아닌 지원 OMP 메모리 백엔드가 필요하다.**
이미 켜진 백엔드는 그대로 사용한다. 기존 Superagent 구성도 같은 규칙을 따른다. `setup`,
`doctor`와 Gateway 시작·재시작은 헤드 작업 디렉터리와 실행할 OMP의 프로필·설정 오버레이를
기준으로 확인한다. Gateway는 메신저에 연결하기 전에 확인하고, 새 헤드와 레인 Host는
stock OMP를 실행하기 전에 자기 작업 디렉터리와 실제 실행 설정을 확인한다.

실효 설정이 미설정이거나 전역에서 `off`이면, 셋업은 최종 저장 전에 선택된 native 프로필의
전역 `memory.backend`만 `mnemopi`로 설정한다고 알린다. 메모리만 따로 확인하지 않는다.
최종 저장을 승인하고 로컬 파일을 성공적으로 저장한 뒤에만 적용하며, 거절·저장 전 취소·저장
충돌이면 적용하지 않는다. Gateway 시작·재시작과 새 Host 실행에도 같은 기본값 보완 규칙을
적용한다. `doctor`는 읽기 전용이다. 아직 꺼져 있거나 실효 설정을 확인할 수 없으면 0이 아닌
코드로 종료하며, 시작할 때 보완할 수 있는 경우에도 직접 설정을 쓰지 않는다.

작업 디렉터리의 `.env`가 다른 프로필 디렉터리를 가리켜도 그곳의 전역 설정을 자동으로 쓰지는
않는다. 이미 켜진 백엔드는 그대로 사용할 수 있다. 자동 설정이 필요하면 프로필을 실행 인자나
실행 환경에서 명시한다. 기존 Gateway를 재사용하거나 시작 권한 검사가 실패한 경우에도 쓰지 않는다.
`/restart`는 기존 Gateway가 종료되기 전까지 설정을 읽기만 한다. 기존 프로세스의 종료와
소유권 인계가 확인된 뒤 설정을 쓸 수 없으면 재시작은 실패하며, 봇이나 이전 프로세스를
자동으로 다시 시작하지 않는다.

전역 설정을 쓸 때는 native 잠금 안에서 이전에 확인한 설정이 여전히 유효한지 확인하고,
저장 후 실효 설정을 다시 읽는다. 도중에 바뀐 값을 덮어쓰거나 프로젝트 및
`PI_CONFIG_FILES`/`--config` 같은 상위 오버레이의 `off`·명시적 해제를 우회하지 않는다.
메모리 DB·스코프·임베딩·LLM·자동 저장 옵션과 기존 기억은 보존한다. 그래도 사용 가능한
백엔드를 확인할 수 없으면 시작을 막는다. 셋업은 이 경우 0이 아닌 코드로 종료하되 저장된
구성과 자격 증명을 유지한다. 해당 native 프로필과 작업 디렉터리에서 차단 원인을 수정한 뒤
`doctor`를 다시 실행한다.

이 사전 확인은 메모리 백엔드를 초기화하거나 모델을 호출하지 않으며, 모델을 다운로드하거나
계정 저장소를 열지 않는다. 이전되지 않은 native 설정·계정 저장소만 남아 실효 백엔드를
판정할 수 없으면 자동 변경하지 않는다. 선택된 프로필에서 stock OMP로 설정을 이전한 뒤 다시
시도한다. 전역 값을 수동으로 바꾸려면 stock OMP의 `config set memory.backend mnemopi`를
사용하고, 더 높은 우선순위의 설정은 따로 확인한다. 전역 변경은 일반 OMP 세션에도 영향을
줄 수 있다. 이후 메모리 기능을 사용하면 native 설정에 따라 기억을 장기 저장·회수하거나
모델을 사용·다운로드할 수 있다. 백엔드가 켜졌다는 진단은 실제 검색 성공을 뜻하지 않는다.
다른 운영자 채널의 과거 작업 검색은 헤드에서 활성 상태이고 검색 가능한 Mnemopi만 지원한다.

새 구성 저장에 성공하면 메모리 설정 결과와 별개로 head 작업 디렉터리의 native 설정을
읽기 전용으로 확인한다. 실효 `modelRoles.judge`가 없으면 **일반 OMP의 `/models` → Roles →
Judge에서 지정하도록 권장**한다. 기존 전역·프로젝트·overlay 선택과 별칭/선택자 체인은 그대로
보존하며, 상위 layer가 역할을 지운 경우도 그 실효 상태를 따른다. 설정 판독 실패는 미설정이
아니라 확인 불가로 안내한다. 역할 존재만 확인하며 모델·인증 가용성이나 실제 judge 호출을
검증하지 않는다. 모델·fallback·timeout을 자동 변경하거나 계정 DB를 열지 않는다.
쉼표·공백뿐인 선택자 체인은 미설정으로 분류한다. 현행 전역 설정 파일 없이 legacy
`settings.json`/`agent.db`만 남아 실효 역할을 판정할 수 없으면 확인 불가로 안내한다.
legacy 파일은 존재 여부만 확인하고 읽거나 이관하지 않는다. 명시적인 상위 layer의
역할 선택·해제와 현행 전역 설정의 우선순위는 보존한다.
메신저 `/model`은 현재 헤드 모델 제어이고 관리 세션의 설정은 세션 전용이므로, 영속적인
judge 역할 설정을 대신하는 경로로 안내하지 않는다. 기존 구성의 토큰 갱신·취소·저장 실패에는
이 검사와 권장을 실행하지 않는다.

### 수동 설정과 필드

수동으로는 `config.example.json`을 `config.local.json`으로 복사하고 **모든 경로와 REPLACE 값**을 바꾼다.
예시에는 플랫폼별 블록이 하나씩 있다. **사용하지 않을 블록은 삭제**하고 최소 하나를 남긴다.
남긴 모든 블록의 ID 자리표시자는 의도적으로 유효한 플랫폼 ID가 아니므로 치환 전에는 시작할 수
없다. Discord만 있던 기존 설정도 그대로 유효하다. 토큰 자체를 넣는 필드는 없다.
high/middle/low는 명시적 `start`의 전용 초기 설정 턴에서 기존 헤드가 native 메커니즘으로
누락 항목만 초기화하고 완료를 재조회한다. 이 설정 파일에 별도의 프리셋 블록을 추가하지 않는다.

| 필드 | 의미 |
| --- | --- |
| `command` | 별도 설치한 수정 없는 OMP 실행 argv 배열. 셸 문자열이 아니며 셸 변수·`~`를 확장하지 않는다. setup은 PATH에서 설치 CLI를 찾으며 실행 cwd와 무관한 절대 경로를 권장한다. |
| `stateDir` | 현재 사용자 소유의 짧은 전용 경로. 소켓·SQLite 장부·세션·로그·첨부를 보관한다. 공유/심볼릭 링크 디렉터리는 쓰지 않는다. socket 경로가 100바이트를 넘으면 거부한다. |
| `headCwd` | 실제 존재하는 헤드 실행 디렉터리. 요청의 기본 작업 저장소가 아니며, 레인의 cwd는 검증된 작업 범위에 따라 별도로 정한다. |
| `maxHosts` | 헤드 1개를 포함한 상주 Host 예산. 필수 정수, 최소 2. 초과 작업은 대기한다. |
| `maxSubagents` | 전체 Host에 분배할 네이티브 task 동시성 예산. 필수 정수, `maxHosts` 이상. Host별 한도는 `floor(maxSubagents / maxHosts)`다. |
| `idleMs` | 안전하게 정착한 유휴 레인을 회수하기까지의 시간(밀리초). 필수 0 이상 정수. 헤드는 대상이 아니며 세션 기록은 삭제하지 않는다. |
| `model` | 선택 항목. 헤드 시작에 사용할 OMP 모델 식별자. 생략 시 기존 OMP 설정을 따른다. 모든 새 레인의 기본값이 아니며 새 레인은 `lane_start`의 model 또는 preset으로 각각 선택한다. 재개는 저장된 레인 선택을 유지한다. |
| `discord` | 선택 블록. 존재하면 `tokenEnv`, `ownerId`, `allowedGuildIds`, `allowedChannelIds` 모두 필수. |
| `discord.requireAddressing` | 선택 불리언, 기본값 `false`. `true`이면 허용된 서버의 부모 채널과 이 봇이 만들지 않은 스레드에서 이 봇의 실제 멘션 또는 이 봇이 보낸 메시지에 대한 답장이 포함된 소유자의 일반 메시지만 접수한다. |
| `discord.editProgressInPlace` | 선택 불리언, 기본값 `false`. `true`이면 Discord에서 한 요청의 중간 진행 보고를 새 메시지로 쌓지 않고 하나의 `⏳` 상태 메시지로 제자리 수정한다. |
| `telegram` | 선택 블록. 존재하면 `tokenEnv`, `ownerId`, `allowedChatIds` 모두 필수. 그룹 chat ID의 음수 부호를 보존한다. |
| `slack` | 선택 블록. 존재하면 `botTokenEnv`, `appTokenEnv`, `ownerId`, `teamId`, `allowedChannelIds` 모두 필수. |
| `groupRooms` | 선택 목록. 등록한 방과 사용자에게만 아래 그룹 모드를 열며, 해당 방에서는 운영자도 일반 그룹 권한만 갖는다. 기본값은 빈 목록이다. |

상태·cwd의 상대 경로와 `command[0]`의 슬래시가 들어간 상대 실행 경로는 설정 파일 기준이다.
그 뒤의 `command` 인수는 그렇게 변환되지 않는다. 실행 경로는 절대 경로를 권장한다.
OMP 소스 CLI나 프로젝트 패치 바이너리를 지정하지 않는다. 지원 범위의 별도 설치 stock CLI를 사용한다.

예제의 `maxHosts: 4`, `maxSubagents: 8`, `idleMs: 300000`은 운영자가 조정하는 예시이며
하드코딩된 기본값이 아니다. 이 예에서는 헤드 외 최대 3개 레인과 Host별 task 동시성 2를
예산으로 잡는다. 이는 CPU·메모리·토큰 비용·디스크 할당량의 강제 제한이 아니다.
저장 기록과 다운로드 파일의 보존·디스크 사용량은 운영자가 관리한다.

### 단체방·서버 권한 분리

기존 플랫폼 허용 목록에 추가한 방을 `groupRooms`에서도 정확한 플랫폼·서버·채널 ID로
지정한다. 목록에 넣지 않은 기존 운영자 라우트의 동작은 바뀌지 않는다. 같은 서버의 다른
채널은 자동으로 열리지 않는다. 등록한 부모 채널의 스레드·포럼 토픽에는 같은 규칙이 적용된다.
운영자는 관리 명령·승인·결과 파일 발송을 위해 본인의 DM이나 별도 운영 채널을 사용한다.

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

- `platform`: `discord`, `telegram`, `slack`. Telegram은 `guildId`와 `channelId`에 같은 음수
  그룹 ID를 넣는다. Slack `guildId`는 설정한 `teamId`다. `userIds`는 표시 이름이 아닌 실제
  사용자 ID이며, 운영자도 제한 모드를 쓰려면 목록에 넣는다. 서버 관리자 역할은 권한이 아니다.
- 미허가 ID의 호출은 슬래시 명령을 포함해 접수·실행되지 않는다. Discord·Slack에서는
  등록된 슬래시 명령이 앱 메뉴에 보일 수 있어도 제한 그룹 안에서는 누구에게도 실행되지 않는다.
  허가된 ID는 해당 방에 설정된 `!request`, `!ask`, `!work` 중 하나만 사용할 수 있다.
- `request`: `!request 요청 내용`은 접수 확인만 답하고 모델이나 도구를 실행하지 않는다.
  `omp-sa group --config FILE` 또는 `omp-sa group REQUEST_ID --config FILE`로 운영자가 로컬에서
  원문을 확인한다. 검토한 요청을 실행하려면 운영자가 자신의 허용된 대화에서 새 요청으로 시작한다.
- `chat`: `!ask 질문`은 별도 OMP 실행에 현재 질문만 보내고 짧은 텍스트 답을 받는다. 작업
  디렉터리·도구·이전 대화·운영자 메모리는 사용하지 않는다. `model`에 정확한 `provider/model`을 넣는다.
- `work`: `!work 작업 내용`은 `model`과 운영자가 `repository`에 지정한 저장소를 사용한다.
  같은 방에 접수 확인이 실제로 도착한 뒤, 지정 저장소의 커밋으로 만든 별도 Git worktree 안에서
  허용된 파일만 읽고 편집한다.
  셸, 테스트 명령, Git 커밋·푸시·병합은 실행하지 않는다. 단체방에는 고정된 상태만 표시하고,
  실제 diff와 worktree 위치는 운영자가 로컬에서 `omp-sa group REQUEST_ID --config FILE`로
  확인한다. 종료 상태는 변경 내용 검증이나 배포 승인이 아니다.
- Telegram 개인정보 보호 모드에서는 봇의 실제 사용자명을 붙인 `/request@BotUsername`,
  `/ask@BotUsername`, `/work@BotUsername`을 사용한다. 수정한 입력은 새 작업을 만들지 않는다.
- `dailyLimit`은 UTC 기준 방별 일일 접수 한도다. `chat`과 `work`는 동시에 하나만 실행하며
  Host 예산에 남는 슬롯을 사용한다. `stateDir/groups/models.yml`에 별도 그룹용 OMP 모델 인증을
  배치한다. 운영자 프로필은 상속하지 않는다. 이 모델에 전송해도 되는 저장소와 데이터만 지정한다.
  worktree는 OS 샌드박스가 아니며, 미검토 파일을 원본에 적용하거나 실행하지 않는다.
- 설정 변경은 다음 Gateway 시작에서 적용된다. 중단된 실행·발송 결과가 불확실한 응답을
  자동 재실행하거나 재발송하지 않는다. 그룹 모드로 전환하기 전 이미 공개된 메시지는 지워지지 않는다.

`request` 방에는 모델 파일이 필요 없다. `chat`·`work`를 쓰려면 `stateDir/groups`를
실행 계정만 접근할 수 있게 만들고(`0700`), 그 안에 `models.yml`을 `0600`으로 저장한다.
예를 들어 OpenAI 호환 API를 쓴다면 아래와 같이 등록하고 방의 `model`을
`group-provider/EXACT_MODEL_ID`로 지정한다. URL·키·한도·가격을 실제 제공자 값으로
교체한다. 운영자 자격 증명 대신 그룹 전용 키와 제공자 측 사용량 한도를 사용하는 것을 권장한다.

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

그룹의 질문·작업은 실제 모델 호출이므로 제공자 비용이 발생할 수 있다. 로컬 시간/비용 제한은
실행을 제한하지만, 이미 전송한 요청의 과금을 취소하거나 제공자 청구액을 보장하지는 않는다.

## 4. 명령과 일상 사용

CLI 실행 이름은 `omp-sa`다. 위의 전역 패키지 설치 또는 준비한 저장소의 `bun link`로
등록하고 해당 전역 bin 디렉터리를 `PATH`에 포함하면 `omp-sa --help`나
`omp-sa status --config config.local.json`처럼 실행할 수 있다. 프로젝트·패키지 이름은
`omp-superagent`로 유지한다. 아래 소스 호출 방식도 같은 CLI이며, 두 방식 모두 `.env`
자동 로딩을 끈다.

모든 관리 명령에 `--config FILE`이 필요하다. 먼저 봇을 시작하지 않는 진단을 실행한다.

```sh
bun --no-env-file src/cli.ts doctor --config config.local.json
bun --no-env-file src/cli.ts status --config config.local.json
```

`doctor`는 설정, 설치 OMP의 버전·필요 CLI 기능·실효 메모리 설정과 Host 중계기의 실행
권한을 읽기 전용으로 확인한다.
`hostOwnerExecutable`에 이 패키지에서 사용할 중계기 경로, `platforms`에 설정된 플랫폼,
`credentials`에 환경변수 이름별 **존재 여부 boolean**, `messengersActivated: false`를 출력한다.
토큰 값이나 과거 Discord 전용 `discordTokenPresent`/`discordActivated` 필드를 출력하지 않는다.
봇 로그인·모델 인증·실제 작업 성공을 검증하지 않는다.
`status`는 장부의 레인·소켓 경로와 Gateway/head 준비 단계를 구분해 출력한다. 기록만으로
실제 생존·정확한 소유권·작업 완료를 보장하지 않는다.

| 상태 필드 | 의미 |
| --- | --- |
| `gateway.ready` | Gateway 실제 transport 인증·준비 상태 |
| `gateway.admissionReady` | 최초 head의 native 승인 복구 barrier를 통과해 durable 수신을 열었는지 |
| `gateway.unresolvedEvents` | 안전한 접수/답변 복구를 기다리는 미해결 ingress 수. 모호한 입력을 거부/완료로 버리지 않음 |
| `head.pid` | native head 프로세스 식별자. controller/adapter 준비나 작업 완료와 다름 |
| `head.ready` | head controller gate와 프리셋 초기화 완료 상태. 초기화 미완료·미해결 admission이면 false 유지 |
| `head.connected` | Gateway와 head client의 연결 상태 |
| `head.initialization` | native 프리셋 초기화 상태·세부 사유. transport 로그인·입력 접수와 별개이며 `complete`만 완료 |

최초 admission barrier를 통과한 Gateway는 이후 head 부재에도 durable admission을 유지한다.
`head.ready`/`head.connected`가 내려갔다고 이미 열린 수신을 잃거나 모델을 폴링하지 않는다.

**다음 start가 설정한 모든 어댑터의 활성화를 요청한다.** prepare·doctor는 start를
대신하지 않는다. 별도 macOS `install`은 다음 로그인에 이 start를 실행하도록 허가한다.
실제 자격 증명으로 실행하면 설정된 Discord·Telegram·Slack 모두에 연결한다.

```sh
bun --no-env-file src/cli.ts start --config config.local.json
```

start는 **detached Gateway를 먼저 실행**하고 Gateway가 지정 head 하나를 시작하거나 소유권이
확인된 기존 head에 연결한다. 소켓·로그와 준비 상태 출력은 운영 플랫폼 로그인·실제 모델 호출의
영수증이 아니다. CLI가 출력한 Gateway/Host 로그에서 해당 단계의 실제 오류·상태를 구분한다.
Gateway 로컬 endpoint는 `<stateDir>/run/gateway.sock`, 실제 어댑터·감독 로그는
`<stateDir>/logs/gateway.log`다. native head 로그와 transport 로그를 혼동하지 않는다.
헤드 부재 중에도 준비된 Gateway는 ACK 전에 수신을 저장한다. 미해결 접수/답변은
pending 순서를 유지하고 `gateway.unresolvedEvents`와 `head.ready: false`로 표시한다.
재연결·접수 재전달은 원래 작업·외부 효과의 재실행 허가가 아니다. 운영자는 로그·원래 receipt와
저장 native PID·session ID/file·socket inode를 대조해야 한다. 살아 있거나 신원이 불명인
관리 Host를 중복 기동하지 말고, 알 수 없거나 교체된 socket을 지워 우회하지 않는다.
launch 직후 소유권 기록 전 crash 등은 수동 조정까지 보류할 수 있다. 모든 crash의 자동
복구를 보장하지 않으며 재시작 시 `config.model`로 기존 head 모델을 덮지 않는다.
정확한 [접수](design/messaging.md#durable-admission-and-recovery)와
[소유권 복구](../DESIGN.md#startup-readiness-and-shutdown) 계약은 설계를 따른다.

헤드 런타임은 인증된 입력을 접수할 때 원본 요청과 대화 주소를 함께 기록한다. 연결된
작업 스레드·주제에서는 일반 메시지가 전역 헤드 모델을 거치지 않고 기존 세션의 작업을 이어간다.
개설 중인 주제의 입력도 기존 배정에 남는다.

그 밖의 일반 요청은 저장소 이름을 명시했더라도 원본 그대로 공유 HEAD에 전달된다. HEAD는
저장소가 필요 없는 질문에 직접 답한다. 저장소 작업에는 요청의 단서와 해당 대화의 문맥을
바탕으로 실제 디렉터리를 찾아 확인하고 배정한다. 기본 저장소나 마지막으로 활동한 채팅·레인을
선택하지 않으며, 확인 후에도 작업 대상이나 범위에 중요한 모호함이 남을 때만 원래 대화에서
구체적으로 묻는다. 연결되지 않은 Discord 스레드에서 받은 요청은 별도로 나눠 달라는 지시가
없는 한 그 스레드에서 처리하고 형제 스레드를 만들지 않는다.

첫 줄의 `cwd: /실제/작업/경로`, 작업을 포함한 `/new`, 확인된 경로가 있는 배정 메시지에 대한
정확한 답장, 명시적인 과거 작업 검색은 런타임의 배정 경로를 유지한다. 유효하지 않은 명시 경로는
실행하지 않는다. 이전 작업의 경로만 재사용할 때는 이전 대화 내용을 가져오지 않는다. 배정 경로에서
작업 디렉터리를 추가로 확인해야 한다면 원래 질문에 저장소 이름이나 절대 경로로 답해 **원래 요청**을
계속한다. 레인은 메신저 자격 증명을 갖지 않는다. 여러 주제를 비교하거나 공유 HEAD에 명시적으로
요청하려면 `/head 요청`(Slack `!head 요청`)을 사용한다.

헤드에서 Mnemopi가 활성화되어 검색할 수 있으면, 다른 운영자 채널·DM에서도
`지난주 로그인 버그 보던 데서 계속해줘`처럼 시점과 작업을 설명할 수 있다. 저장소 이름, 원래
메시지 링크, `/new`는 필요 없다. 먼저 헤드 프로필의 **OMP Mnemopi `recall`**로 단서를 찾고,
이 인스턴스에서 접근이 허용된 원본 작업 세션과 대조한다. 조회에는 성공했지만 기억이 비어 있으면
원본에서 찾을 수 있다. 다른 백엔드를 쓰거나 조회가 실패하면 이 방식으로 임의 배정하지 않는다.
후보가 여럿이면 질문에 번호로 답한다.
과거 검색이 필요한 입력은 헤드가 먼저 영속 접수한 뒤 별도로 검색한다. 검색을 기다리는 동안
같은 물리 채널·DM의 뒤따르는 일반 입력은 순서를 유지하지만 다른 대화는 차단하지 않는다.
`recall`은 헤드에 설정된 메모리 뱅크 범위를 그대로 사용하며, 다른 프로젝트의 비공개 뱅크를 열지 않는다.
메모리 원문은 채팅이나 새 세션에 전달하지 않는다. 다른 채널에서 이어갈 때는 이전 저장소와 해당 작업의
근거만 현재 대화의 독립 세션에 전달한다. 이미 연결된 Discord 작업 스레드에서는 새 세션을
열지 않고 현재 레인에 검증한 근거만 전달하며, 질문·작업·답변은 같은 스레드에 남는다.
이 스레드의 과거 작업 선택 질문에 한해 발송이 확인된 뒤 5분 내 답이 없으면 런타임이
검증된 후보 중 현재 세션을 우선하고, 그다음 같은 작업 디렉터리에서 가장 최근 후보를 선택한다.
유효한 후보가 없으면 현재 레인의 맥락만 사용한다. 기한 내 선택이 우선이며, 이 타임아웃은
다른 작업 디렉터리로 이동하거나 승인을 대신하지 않는다. 원래 세션의 진행 중 작업·승인을
넘기거나 메신저에 과거 대화 전문을 게시하지 않는다. `지난주`는 요청이 속한 주의 월요일
00:00 UTC 직전 7일이다.
사용자가 먼저 스레드를 만들 필요는 없다. 작업 스레드를 지원하는 채널에서는 봇이 그곳에 결과를 보내고,
스레드를 만들 수 없는 Discord·Telegram 일반 채널에서는 같은 채널에서 답한다.
일반적인 `계속해줘`는 여전히 현재 주제의 후속 입력이다.

**일반 후속 입력의 기본값은 steer다.** 메인 채널 등 HEAD가 처리하는 대화는 HEAD로, 연결된
작업 스레드는 해당 레인으로 전달한다. `/head 요청`은 스레드에서도 HEAD를 지정한다.
같은 대화에 실행 중인 작업이 있으면 `/steer` 없이 다음 OMP steering 경계에서 반영하고,
유휴 상태면 새 실행을 시작한다. 스레드 개설 직후의 첫 답장도 원래 실행의 답변 경로가
그 스레드로 확인되면 합류할 수 있다. 메시지 접수나 RPC 수락만으로 모델이 입력을 읽었다고
볼 수는 없다. 다른 대화, 내부 보고, workflow 선택과 제어 명령은 현재 실행에 섞지 않으며
일시정지·승인·압축·불확실성 보류를 우회하지 않는다. 원래 Discord 주소 지정 정책은 그대로
적용하며, 같은 실행의 최종 답변/보고는 중복 발송하지 않는다.

**새 주제도 명령 없이 요청할 수 있다.** 새 레인이 필요한 경우 확인된 작업 디렉터리에서
지원되는 thread/topic에 독립 OMP 세션을 연결한다. 이미 연결된 Discord
서버 작업 스레드에서는 다른 `cwd:`만 적어도 경로나 스레드가 바뀌지 않는다. 같은 부모에
새 스레드로 분리하려면 `/new 요청`이나 `이건 따로 빼줘: 로그인 점검`,
`로그인 점검은 새 스레드에서 해줘`, `Split this into a new thread: Check login`처럼
분리 의도와 작업을 한 줄 평문으로 명시한다. 다른 디렉터리에서 할 작업이라면
`/new cwd: /실제/작업/경로`를 첫 줄에, 작업을 다음 줄에 적는다.
`이건 따로 빼줘`처럼 작업을 특정하지 않으면 같은 스레드에서 `/new`로 작업을 명시해 달라고
안내하고 새 스레드를 만들지 않는다. 수정 메시지·인용·첨부는 새 스레드 지시가 아니다.
이 평문 분리 지시는 Discord DM이나 다른 플랫폼에는 적용되지 않는다. Gateway는 LLM 분류나 lane 실행을 하지 않는다.

| 플랫폼 | 자동 주제 생성 |
| --- | --- |
| Discord | 허용된 text/announcement 채널의 public thread와 forum/media의 starter-message post. DM은 논리 주제. 필수 태그가 있는 forum/media는 태그를 추측하지 않고 거부 |
| Telegram | 관리자·`can_manage_topics` 권한을 가진 forum supergroup, 또는 `has_topics_enabled` 봇의 private topic. 미지원 private chat은 논리 주제; 일반 그룹은 native topic 생성 불가 |
| Slack | 허용 채널과 owner-DM의 실제 root 메시지 `ts`에 thread. 기존 thread에서 새 주제로 분리하면 별도 root 생성 |

공식 API: [Discord threads](https://docs.discord.com/developers/topics/threads),
[Telegram createForumTopic](https://core.telegram.org/bots/api/methods/createforumtopic.md),
[Telegram bot capability](https://core.telegram.org/bots/api/types/user.md),
[Slack thread_ts](https://docs.slack.dev/messaging/sending-and-scheduling-messages/#threading).
새 채널·서버를 임의로 만들거나 권한·BotFather 설정을 바꾸지 않는다. 권한/네트워크 실패는
미지원으로 숨기지 않으며 불확실한 생성·발송은 재전달 때 자동 반복하지 않는다.

다음은 Discord·Telegram에 보내는 **일반 텍스트 명령**이며 Discord는 등록된 슬래시 명령도
같은 의미로 처리한다. Slack에서는 같은 위치에 `!new`·`!main` 또는 등록된
`/superagent-new`·`/superagent-main`을 사용한다.

| DM 입력 | 동작 |
| --- | --- |
| `/new 요청 내용` | 독립 주제 경계를 접수. 작업 디렉터리가 확인되면 native topic을 우선 생성·연결하며 미지원 DM만 논리 주제를 유지 |
| `/new` | 빈 주제만 활성화하고 요청 내용을 묻는 고정 안내를 한 번 회신. 이 명령만으로 모델 호출·레인 시작은 하지 않음 |
| 일반 메시지 | 선택된 주제의 세션을 이어 쓰며 필요하면 복원하고 활성 실행은 조건에 따라 steer. 개설 중이면 기존 배정을 따르고, 그 밖의 일반 요청은 공유 HEAD에서 판단 |
| `/main` | 앞으로의 DM 입력을 메인 대화 주소로 돌림. 이전 주제·레인은 보존. 공유 HEAD를 명시적으로 지정하려면 `/head 요청` 사용 |

헤드는 이미 제출받은 일반 DM 작업도 `lane_start`로 독립 주제에 인계할 수 있다.
원래 헤드 요청의 소유권은 유지하고 별도 handoff를 만든다. native thread를 만든 경우
안내된 thread에서 후속 대화를 이어간다. 논리 주제 fallback에서는 이후 DM 입력이 그 주제를 따른다.
서버를 만들 필요는 없고, 명시적으로 허용된 서버 스레드 목적지를 지정하는 인계도 가능하다.
그룹·workspace 채널 대화에서 인자 없는 `/new`(Slack `!new`)는 새 스레드/topic 사용 안내를 보내며
OMP 자체 `/new`로 전달하지 않는다. 연결된 레인 대화의 `/stop`, `/resume`
(Slack `!stop`, `!resume`)은 각각 일시정지·명시적 재개 제어다.
종전 재개는 runtime queue를 다시 여는 동작이었으며 이제는 명시적으로 허가된 재개에서만 기존
paused native lane goal도 재개한다. 자동 report·재연결·새 queued 입력은 재개 권한이 아니며,
재개는 없는 goal 생성·불확실성 해제·중단 prompt 자동 replay를 뜻하지 않는다.
이미 접수된 `/new`·`/main` 제어 메시지를 수정해도 기존 경계·작업·현재 주제는 바뀌지 않으며,
기록과 고정 안내만 남기고 새 메시지로 제어하도록 요청한다. Slack의 `!` 제어도 같은 정책이다.
일반 작업 메시지 수정은 새 입력 revision이며 이미 실행된 외부 효과를 취소하지 않는다.

### 헤드의 모델·effort

다음 명령은 DM·허용 채널·스레드에서 **현재 메인 헤드 세션**에 적용된다. 레인에 연결된
스레드에서도 그 레인이 아니라 헤드를 제어한다. Discord·Telegram은 일반 `/` 텍스트를,
Discord는 등록된 슬래시 명령을 함께 지원한다. Slack은 일반 `!model`·`!effort` 텍스트와
등록된 `/superagent-model`·`/superagent-effort`를 지원하며 별도 HTTP endpoint는 없다.

| 명령 | 동작 |
| --- | --- |
| `/model` | 현재 provider/model·effort 표시 및 공급자 → 모델 선택 메뉴 열기 |
| `/model list` | 현재 native 인증·활성화 상태에서 선택 가능한 chat 모델 목록 |
| `/model <provider/model>` | 목록의 정확한 provider/model로 헤드 모델 변경 |
| `/effort` | 현재 effort 표시 및 현재 모델이 지원하는 강도 선택 메뉴 열기 |
| `/effort <level>` | 조회에 표시된 값으로 헤드 effort 변경 |
| `/model preset` 또는 `/model preset list` | 기존 native 프리셋의 이름·유효성·가용 기본 모델 조회 |
| `/model preset <name>` | 해당 native 프리셋의 전체 역할·기본 effort를 유휴 헤드 세션에 적용 |
| `/model preset <name> --global` | 현재 헤드에 적용·확인한 동일 snapshot을 native 전역 기본 역할·effort에도 저장 |

Discord와 Slack은 드롭다운, Telegram은 인라인 버튼으로 표시한다. 메뉴를 열거나 페이지를
넘기는 것만으로는 아무 설정도 바뀌지 않는다. 메뉴는 5분 후 또는 Gateway가 재시작되면
만료된다. 강도 메뉴를 연 뒤 헤드 모델이 달라졌다면 다시 열어야 한다. 클릭 접수와 실제 변경
완료는 별개이며, 결과는 원래 대화에 별도로 표시된다. 텍스트 명령도 계속 사용할 수 있다.

조회는 실행 중에도 모델 호출 없이 처리한다. 변경은 헤드가 유휴이고 승인·goal·백그라운드
작업·소유 서비스·compaction·불확실한 제출이 없을 때만 처리한다. 바쁘면 거부하므로 작업이
정리된 뒤 새 명령을 보내야 한다. 변경을 위해 실행 중 작업을 자동 중단하지 않는다.
모델 변경 후 effort가 native 지원 범위에 맞춰 조정될 수 있으며 응답은 실제 readback 값을
표시한다. 사용 불가능한 모델이나 effort를 임의의 대체값으로 바꾸지 않는다.
native 상태에 명시적 effort가 없으면 모델 기본값으로 표시하며 `off`와 혼동하지 않는다.
현재 모델이 `auto`를 광고하면 메뉴에서 선택하거나 `/effort auto`를 입력할 수 있다.
자동 모드에서는 설정값 `auto`와 OMP가 실제 적용하는 강도가 다를 수 있다. `auto`를
광고하지 않는 구형 Host에는 선택지가 나타나지 않으며 고정 강도로 대신 적용하지 않는다.

`/head 헤드 모델을 6.2 Astra로 바꿔`처럼 명시적으로 요청해도 된다. 헤드가
가용 모델을 확인하고, 현재 턴이 성공적으로 끝난 뒤 공유 헤드에만 적용한다. 예약 응답은
적용 완료가 아니며, 런타임이 원래 메시지에 실제 결과를 회신한다. 원래 턴이 중단되거나
종료 뒤에도 헤드가 유휴 상태가 아니면 자동으로 재시도하지 않는다.

옵션 없는 변경은 전역 OMP 기본값과 기존 레인의 선택을 유지한다. 모든 메신저가 같은 헤드를 사용하므로
헤드의 이후 작업에는 동일하게 적용되고, 동일 native 세션을 재시작해도 기록된 선택을
복원한다. 일반 `/model`·`/effort`의 `--global`과 모든 `--once`는 지원하지 않는다. 수신 중복은 재적용하지 않으며 변경
응답이 유실되거나 실제 상태를 확인하지 못하면 성공으로 표시하거나 자동 재실행하지 않는다.
이때 `/model`·`/effort`로 실제 상태를 조회할 수 있지만 조회가 기존 불확실성을 해제하지는 않는다.

프리셋은 OMP의 기존 `modelPresets`에서 읽는다. 메신저에서 이름 있는 프리셋 원본을 만들거나
수정·삭제하지 않으며 high/middle/low 외에 실제 설정된 이름도 사용할 수 있다. 적용 후 전체 역할과 기본 effort를
native 상태로 확인한다. 확인된 세션별 설정과 제거된 역할만 재기동용 metadata로 보관하고,
새 Host의 private 설정 overlay로 복원한다. 이후 `/model`·`/effort`로 별도 선택한 활성 값은
native transcript에서 복원하므로 과거 프리셋의 기본값으로 덮어쓰지 않는다.
프리셋의 기본 effort가 생략되어 있으면 현재 헤드 세션의 정책을 유지한다. 영속 기본값을
다시 가져오지 않는다. 명시적인 프리셋 effort와 모델 selector의 effort 우선순위는 그대로다.

**기본 적용 범위는 이번 헤드 세션뿐이다.** `--global`을 명시한 프리셋 선택만 현재 헤드의
적용 확인 뒤 같은 역할·기본 effort를 native 전역 설정에 저장한다. 기존 실행 중인 레인과
명시적인 다른 세션 선택은 바꾸지 않으며 다른 프로젝트의 설정 override를 지우지 않는다.
변경 알림은 프리셋 이름, 변경 전후의 실제 모델·effort, `session-only` 또는 전역 저장
여부를 표시한다. 헤드 적용은 성공했지만 전역 저장/확인이 실패했다면 그 두 결과를 분리해서
알리고, 자동 재시도나 성공으로 가장하지 않는다. 전역 기본값 변경은 새 세션·기본값을
상속하는 경로에 영향을 줄 수 있다.

### 예약 작업 (`/cron`)

Discord·Telegram에서 `/cron`, Slack의 일반 메시지에서는 `!cron`을 사용한다.
명령어 대신 “서울 시간으로 평일 오전 9시에 CI 상태를 요약해서 이 대화에 보내줘”라고
요청해도 된다. HEAD가 `cron_create`로 등록하고 실제 ID와 다음 실행 시각을 확인한다.
시간대나 작업 내용이 모호하면 확인 질문을 한다. 등록은 요청당 한 건이며,
자연어로 만든 작업도 같은 대화에서 `/cron`으로 관리한다.
등록한 앱 명령을 쓰려면 Discord는 `/cron`의 `text` 옵션, Slack은
`/superagent-cron`에 하위 명령을 넣는다. 기존 앱 명령 메뉴는 별도의 명령 등록을 다시
적용해야 갱신되며, 일반 메시지 명령에는 그 작업이 필요 없다.

```text
/cron add "in 30m" 빌드 확인하라고 알려줘
/cron add "every 2h" CI 상태를 읽고 요약해줘
/cron add "TZ=Asia/Seoul 0 9 * * 1-5" 평일 아침에 오늘 일정 요약해줘
/cron add "at 2027-01-09T09:00:00+09:00" 오늘 할 일 알려줘
/cron list
/cron show ID
/cron edit ID "every 4h" CI 상태와 실패 원인을 요약해줘
/cron edit ID prompt 결과는 세 줄로 요약해줘
/cron pause ID
/cron resume ID
/cron run ID
/cron remove ID
```

- 예약은 `in`(1회), `every`(최소 1분, `s/m/h/d`), 시차를 명시한 `at`(1회),
  또는 5필드 cron이다. cron 표현식은 `TZ=Asia/Seoul`을 붙이지 않으면 등록 당시
  호스트 시간대를 사용한다. 목록의 다음 실행 시각은 UTC로 표시한다.
- 등록한 플랫폼·봇 계정·대화·스레드/논리 주제에서만 관리할 수 있다. 새 소유자 메시지로
  명령을 보내야 하며, 기존 메시지 편집이나 모델 응답은 예약을 변경할 수 없다.
- 실행은 현재 모델이 설정된 **공유 HEAD**에서 HEAD 요청과 같은 큐를 타며, 결과와 승인
  요청은 원래 대화로만 돌아간다. 별도 세션·레인, 첨부 파일 재사용, 상시 승인 권한은
  만들지 않는다. 예약만으로 도구 승인이나 새로운 외부 효과가 허가되지는 않는다.
- 직접 셸 예약(`/cron add shell`)은 지원하지 않는다. 일반 HEAD 작업을 예약하면 기존 승인
  절차가 적용된다. 이전 빌드에서 등록한 셸 작업은 조회하거나 삭제할 수 있지만 재개하거나
  실행할 수 없다. 아직 실행하지 않은 작업은 취소되며 미전송 셸 출력은 게시되지 않는다.
  이전 빌드에서 이미 시작된 작업이 있다면 원래 호스트에서 종료 여부를 확인하고 `/resolve`로 해소한다.
- `run`은 예약을 건드리지 않고 한 번만 큐에 넣는다. `pause`와 `remove`는 이미 큐에
  들어갔지만 제출되지 않은 실행을 취소한다. 제출된 실행을 중단하려면 `/stop head`를
  사용한다. 이미 큐에 들어갔던 1회 예약을 취소한 뒤에는 `run` 또는 `edit`로 다시 지정한다.
  `edit`는 이후 큐에 들어가는 실행에 적용되며, 이미 접수된 실행은 이전 프롬프트를 유지한다.
- 서비스가 꺼져 있으면 실행하지 않는다. 재시작 때 지난 예약은 작업별 최대 한 번만
  접수하며, 이전 실행이 대기·진행 중이면 반복 예약의 겹친 회차는 건너뛴다.
  `/stop head`는 기존 예약도 보류하며, 원하는 작업을 `/cron resume ID`로 개별 재개한다.
  이전 실행이 불확실하면 원래 세션을 확인하고 `/resolve <실행 ID>`로 먼저 해소한다.
  예약 등록·큐 접수·실행 완료는 서로 다른 상태다.

#### 새 외부 PR 검토 (`/cron pr-add`)

**신규 등록의 기본값은 무인 리뷰와 GitHub 코멘트다.** 소유자가 같은 부모 채널에서
단계를 선택하면 PR별 시작 명령 없이 작동한다. 세 단계는 누적 상한이다.

| 부모 채널에 보낼 자연어 | 같은 명령 | 무인 동작 |
| --- | --- | --- |
| `무인으로 리뷰만` | `/cron pr-mode JOB review` | PR별 Discord 스레드와 도구 없는 OMP 레인에서 검토한 뒤, 그 SHA에 GitHub 리뷰 코멘트만 남긴다. 승인 리뷰를 제출하지 않는다. |
| `무인으로 리뷰 후 수정커밋까지` | `/cron pr-mode JOB fix` | 리뷰·코멘트에 더해 안전하게 적용 가능한 수정이 있을 때만 일반 커밋을 넣고 새 SHA를 재검토한다. 병합하지 않는다. |
| `무인으로 수정커밋후 머지까지` | `/cron pr-mode JOB merge` | 수정이 필요하면 수정·재검토한다. 최종 SHA가 검토를 통과하고 독립 승인·필수 CI·보호 규칙이 모두 충족돼야 일반 병합한다. |

여러 저장소를 등록한 채널은 `/cron pr-mode OWNER/REPO review|fix|merge`로 대상을
명시한다. 실제 명령에서는 세 값 중 하나를 고른다. `/cron show JOB`에서 설정 결과를
확인한다. `PR 자동화 2단계로 바꿔줘`처럼 숫자로도 선택할 수 있다.
`discord.requireAddressing`을 켰다면 메시지 맨 앞에 실제 봇을 멘션하거나 부모 채널의
봇 메시지에 답장한다. 모드 변경 전의 제안·결과에 상향 권한이 소급되지 않는다. 기존 버전에서 만든
발견 전용 등록도 명시적으로 모드를 선택하기 전까지 수동이다. Discord가 뒤늦게 복구한
이전 명령은 더 최근의 모드를 덮지 않는다. 저장소를 생략한 명령의 대상이 불확실하면
저장소를 명시해 새로 보낸다. 소유자 메시지의 인용, 수정본, PR 본문이나 모델 출력은 설정 명령이 아니다.
예를 들어 `dbc-hbin/omp-superagent`에 적용하려면, `gh`가 `github.com`의 `dbc-hbin`으로
인증된 HEAD에서 **허용된 Discord 서버의 부모 채널**에 설정된 소유자 계정으로 아래 명령을 보낸다.
GitHub 조직·다른 사람의 저장소·DM·기존 스레드는 등록 대상이 아니다.
일반 `/cron add`에 같은 내용을 프롬프트로 넣어도 이 기능이 활성화되지 않는다.

```text
/cron pr-add "every 5m" dbc-hbin/omp-superagent
/cron show JOB
/cron run JOB
```

`JOB`은 등록 응답에 표시되는 ID다. 최초 조회에서 GitHub 저장소와 사용자 ID를 확인하며,
인증 계정의 PR은 제외한다. 등록·재개 경계보다 나중에 만들어져 조회 시 열려 있는 PR만
대상이다. 조회 사이에 열렸다 닫힌 PR, 같은 초에 열려 선후 관계를 입증할 수 없는 PR은
놓칠 수 있다. `/cron run`은 기다리지 않고 한 번 조회할 뿐, 실행 권한을 주지 않는다.
한꺼번에 발견한 PR도 모두 기록하되, 알림은 조회당 가장 오래 기다린 열린 PR 한 건만 보낸다.
같은 PR은 재시작·재등록 후에도 다시 알리지 않는다. 전송이 불확실하면 부모 채널에서
`/cron show JOB PR_NUMBER`로 원래 제안과 전송 상태를 확인한다.

1. **부모 채널:** 자동 모드에서는 전송이 확인된 봇 알림을 시작 메시지로 써서
   Discord 스레드 하나를 연다. 봇에 메시지·기록 읽기·공개 스레드 생성·스레드 전송
   권한이 필요하다. 기존 메시지에서 스레드를 만들 수 없는 포럼/미디어 채널은 이
   자동 경로에서 지원하지 않는다. 등록 메시지를 PR별 소유자 입력처럼 복제하지 않는다.
   실제 스레드와 시작 메시지 전송을 확인해야 해당 레인이 실행된다. 수동 진행이 필요한
   경우 알림의 `/cron pr-review JOB NUMBER SHA`를 사용한다. 이미 열린 PR은 그 스레드를 쓴다.
2. **생성된 스레드:** 레인은 GitHub에서 읽은 해당 SHA의 변경만 정적으로 검토한다.
   PR 브랜치를 호스트에 체크아웃하거나 설치·빌드·테스트하지 않는다. 모델에게 전달되는
   변경 내용은 설정된 모델 제공자가 처리한다. 답변과 수정 제안에는 코드 일부가 포함될 수 있고
   해당 Discord 스레드의 열람자가 볼 수 있다. 비공개 저장소는 등록 전에 두 경계를 확인한다.
   `stateDir`은 Git 체크아웃 밖에 두어야 한다. 제한 모드는 비어 있는 로컬 폴더와 도구 없는
   stock OMP 세션을 사용한다. 커스텀 실행 인자나 독립 실행 도구가 있는 모델 제공자 등
   이 격리를 검증할 수 없는 환경은 일반 코딩 레인으로 대체하지 않고 보류한다.
   지원하는 native API는 `openai-completions`, `openai-responses`, `openai-codex-responses`,
   `azure-openai-responses`, `anthropic-messages`다. 외부 에이전트 CLI는 지원하지 않는다.
   변경 파일 32개, 파일당 패치 16 KiB, 전체 검토 자료 64 KiB가 상한이다.
   패치가 없거나 바이너리이거나 Git blob·파일 모드와 대조할 수 없으면 일부만 보고 승인하지 않는다.
   기본 모드는 최종 검토의 요약을 검토 SHA에 묶인 GitHub 코멘트로 공개한다.
   결과 확인·CI 재조회는 기존 크론 주기로 진행한다. `/cron pr-status JOB NUMBER`로
   결과와 가능한 다음 명령을 본다.
3. **수정이 필요하면:** 2·3단계에서는 허용된 제안을 자동 적용한다. 수동으로
   승인하려면 제안된 파일과 치환 내용을 확인한 후
   `/cron pr-fix JOB NUMBER SHA DIGEST`를 같은 스레드에서 보낸다. 해시는 해당 변경과
   대상 전체 SHA를 식별한다. `src/`, `lib/`, `test/`, `tests/` 아래 허용된 일반 소스 파일
   하나에서 유일하게 일치하는 문자열만 일반 커밋으로 치환한다. 포크·기본/보호
   브랜치 또는 안전성을 확인할 수 없는 변경에는 쓰지 않는다. 그 경우 기여자가 안전한
   환경에서 직접 수정해야 한다. 자동 처리에서는 새 SHA를 같은 레인에서 재검토한다.
   같은 PR의 자동 수정은 한 번으로 제한한다. 같은 정책에서 서로 다른 SHA를 세 번까지
   검토하며, 계속 바뀌거나 재검토에서 또 다른 수정이 필요하면 소유자에게 넘긴다.
   수동 진행은 같은 스레드에서 `/cron pr-review JOB NUMBER NEW_SHA`를 보낸다.
4. **병합하려면:** 3단계에서는 마지막 검토 결과가 실제 스레드에 전송된 후 해당 SHA,
   현재 PR·수정 자료·독립적인 GitHub 승인·CI·서버 보호 규칙을 확인한다. `pending`은
   성공이 아니며 이후 조회에서 다시 확인한다. 1·2단계에서 한 건만 승인하려면
   `/cron pr-merge JOB NUMBER SHA`를 보낸다. 이 명령은 상시 승인이 아니므로 이후
   조건이 충족되면 상태를 확인하고 새 명령을 보내야 한다. `--admin`, 강제 푸시,
   무조건적인 GitHub 자동 병합 예약은 쓰지 않는다.

**지원하는 병합 정책:** 기본 브랜치를 대상으로 하는 열린 non-draft PR이어야 한다.
저장소 소유 ruleset이 모든 브랜치에 적용되고 우회 주체가 없어야 한다. 유일하게 허용하는
제외는 **같은 저장소에 있는 이 PR의 소스 브랜치 하나를 정확한 이름으로** 지정한 경우다.
이때만 그 비보호 브랜치에 수정 커밋을 쓰고 같은 저장소의 보호된 기본 브랜치로 병합하는 흐름이 가능하다.
와일드카드나 다른 브랜치 제외는 허용하지 않으며 봇이 규칙을 바꾸지 않는다. stale review 해제,
마지막 push의 승인, 엄격한 필수 CI와 GitHub App에 고정된 필수 check가 필요하다.
대상 브랜치에 실제 적용되는 ruleset들의 필수 check를 모두 확인한다. 관찰한 check가
`skipped`·`neutral`을 포함해 `success` 이외의 상태이거나 독립적인 GitHub 승인이 없으면 병합하지 않는다.
보호되지 않은 저장소, classic 보호만 있거나 merge queue·squash만 허용하는 구성 등에서
이 경로가 거절될 수 있다. 모든 브랜치에 직접 쓰기를 금지한 저장소에서는 수정 제안도
기여자가 별도 포크 등 허용된 절차로 반영해야 한다. 보호 규칙을 완화하지 말고 GitHub의 원래 절차를 사용한다.
병합 요청은 변경 불가능한 PR 노드 ID와 예상 head SHA, 수정 요청은 브랜치 노드 ID와 예상
head SHA를 사용한다. GitHub가 원자적으로 비교하는 값은 head SHA이며 서버가 쓰기 시점의
규칙을 적용한다. 클라이언트의 CI 조회와 쓰기는 한 트랜잭션이 아니다. 관리자가 동시에
보호 설정·기본/대상 브랜치를 수정하거나 같은 head의 check를 재실행하는 것까지 잠그지는
않는다. 병합 응답의 대상과 두 부모 커밋을 확인할 수 없으면 성공으로 표시하지 않는다.

`/cron pause JOB`, `/cron resume JOB`, `/cron remove JOB`은 원래 부모 채널에서 사용한다.
`/stop head`도 발견과 새 쓰기를 보류한다. 등록 재개는 과거 쓰기 승인이나 검토를 되살리지 않는다.
다른 메신저의 `/stop head`처럼 Discord 메시지와 선후를 비교할 수 없다면 원래 부모 채널에서
`/cron show JOB`을 보낸 뒤, **그 봇 응답에 답장**으로 `/cron resume JOB`을 보낸다.
이미 실행 중인 레인은 필요하면 해당 스레드에서 `/stop`으로 따로 중단한다. 이미 GitHub에
제출된 요청은 취소됐다고 간주하지 않는다. 결과가 모호하면 활성 등록의 원래 PR 스레드에서 `/cron pr-status JOB NUMBER`로
읽기 전용 대조를 하고, 증거가 부족하면 GitHub의 실제 병합·커밋 이력과 원래 Discord 스레드를
직접 확인한다. `/resolve`나 재등록은 GitHub 쓰기를 재시도하는 수단이 아니다.
부모 채널에 직접 보낸 검토 메시지에서 스레드 생성 응답만 유실되었다면, 그 메시지에
연결된 실제 스레드 안에서 **같은** `pr-review` 명령을 새 메시지로 보낼 수 있다.
스레드 ID가 원래 메시지 ID와 같고, Discord에서 활성 상태이며 기존 배정이 없어야 한다.
앱 명령처럼 실제 시작 메시지가 없더라도 이미 확인·저장된 정확한 Discord 스레드 ID가
있으면 같은 방식으로 복구할 수 있다. 어느 증거도 없으면 다른 스레드를 채택하지 않는다.

### 상태·맥락·사용량·중단

아래 명령도 Discord·Telegram의 일반 텍스트이며 Slack에서는 `/` 대신 `!`를 쓴다.

| 명령 | 동작 |
| --- | --- |
| `/help` | 실제 지원 명령과 적용 대상 안내 |
| `/head 요청` | 현재 주제의 연결 여부와 관계없이 공유 헤드에 명시적으로 요청 |
| `/status` | 공유 헤드의 실행 상태, 현재 주제·연결 레인, 대기·미해결 입력과 승인 확인 |
| `/restart` | 바쁜 헤드를 체크포인트한 뒤 Gateway와 헤드 교체. 원래 대화 ACK·실제 안전한 종료 확인, 같은 세션/모델 복원, 안전한 goal 재개. 레인은 유지하며 불확실한 효과는 보류 |
| `/context` | 헤드 native 컨텍스트 사용량·한도 조회. 추정치·미상은 그대로 표시 |
| `/usage` | 설정한 프로필의 순정 `omp usage`에서 제공자별 계정 한도·사용량·리셋 시각 조회. 세션 토큰·비용 통계가 아님 |
| `/usage-reset` (Discord), `/usage reset` (Telegram), `!usage reset` (Slack) | 지금 쓸 수 있는 리셋권의 계정별·전체 개수 조회. 계정을 고른 뒤 Confirm을 눌러야 그 계정의 리셋권 1개 사용 |
| `/compact [보존할 내용]` | 유휴 헤드의 native 컨텍스트 압축. 여러 줄 보존 지시 전달 가능 |
| `/stop` | 연결된 레인은 일시정지. 미배정 대화에서는 경로 질문이나 실행 중인 요청의 원문에 답장해 대상을 지정. 배정 대기와 HEAD 실행이 함께 있거나 수정본이 서로 다른 레인을 가리키면 임의로 중지하지 않고 같은 대화에서 안내 |
| `/stop head` | 현재 주제와 무관하게 공유 헤드 작업 중단 |
| `/stop <lane-id>` | 해당 instance에 등록되고 허가된 레인만 일시정지 |
| `/resolve [input-id]` | 이미 `uncertain`이 된 헤드 입력 **하나**를 운영자가 취소로 확정해 뒤의 헤드 작업 차단을 해제. 원래 작업을 재실행하지 않으며 실제 수행·완료를 주장하지 않음 |
| `/resolve --lane <input-id>` | 현재 대화에 연결된 레인의 정확한 `uncertain` 입력 **하나**를 운영자가 취소 처리. 재실행·일시정지 해제·Host 재기동은 하지 않음 |

주제 **배정** 자체가 불확실하면 원래 대화에 배정 ID가 표시된다. 실제 스레드와 전송 결과를
확인한 뒤 그 대화에서 `/resolve <배정 ID>`로 보류를 종료할 수 있다. 배정·실행·전송은 반복하지 않는다.

Gateway는 헤드가 연속 **30분 이상 유휴**이고 native 컨텍스트 사용률이 **50% 이상**이라고 확인된 경우에만
새 헤드 세션으로 교체를 시도한다. 승인·실행·전송 등 미해결 작업이 있거나 사용률이 불명이면
교체하지 않는다. 레인 `idleMs`와는 별개다. `status`의 `head.rotation`에서 이전·새 세션 ID와
교체 단계를 확인할 수 있다. `/restart`는 이 자동 교체와 달리 같은 헤드 세션을 복원한다.

인수 없는 `/usage`는 모델을 호출하지 않고, 설치된 OMP가 보고한 수치만 원래 대화에
보낸다. 제공자별 남은 한도와 초기화 시각은 Superagent 호스트의 로컬 시간대를 자동으로 따른다.
기본 제공자와 확장에서 등록한 제공자 모두 OMP가 조회한 결과를 표시한다. 운영자가 실행 명령에
지정한 `--no-extensions`, `--extension`, `--hook`, `--config`는 리셋 조회·사용에도 적용한다. 계정에는 OMP가 마스킹한
계정·조직 이름을 표시하고, 이름이 없으면 계정 번호로 구분한다. 한도 미확인과 비활성 계정도
따로 표시한다. 전체 이메일 주소·ID, 원본 JSON과 CLI 진단은 회신에 넣지 않는다.
CLI 조회 실패와 확인 가능한 한도가 없는 경우는 구분한다. Slack에서는 `!usage`
또는 등록된 `/superagent-usage`를 사용한다.

리셋권 메뉴는 설치된 OMP CLI가 계정 지정 리셋권 사용을 지원할 때 동작한다.
Discord 명령 목록과 허용된 일반 채팅에서는 인수 없는 `/usage-reset`만 사용한다.
`/usage`는 인수 없는 한도 조회 전용이다. 예전 채팅의 `/usage reset`과 오래된 등록의
`/usage text:reset`은 거부되며, 리셋권 메뉴를 열거나 모델·레인 작업을 시작하지 않는다.
Gateway와 HEAD 업데이트 후 Discord `/help`에 `/usage-reset`이 표시되는지 확인한다.
그런 다음 `discord-commands` 읽기 전용 결과에서 `/usage-reset` 추가를 확인하고 위의 전역
등록 절차를 따른다. `/help` 확인 후에는 등록 전이라도 Discord에서 **일반 채팅 메시지**로
`/usage-reset`을 보낼 수 있다(`requireAddressing`이 필요한 채널에서는 봇 멘션 또는 답장).
Telegram에서는 `/usage reset`, Slack에서는 `!usage reset` 또는 `/superagent-usage reset`을 사용한다.
`Codex · 계정 #7 · al…`처럼
로컬 `omp usage reset`의 계정 지정 번호와 가능한 경우 짧게 마스킹한 계정·조직 이름을 표시한다.
전체 이메일·제공자 계정 ID는 채팅에 넣지 않는다. 메뉴 열기·계정 선택·Cancel은 비용이 없다.
확인 카드는 5분 뒤 만료되며 원래 대화의 운영자만 Confirm으로 한 번 사용할 수 있다. 사용 결과가 불확실하면
자동으로 다시 실행하지 않는다. 지금 쓸 수 없는 보유 리셋권도 조회 결과에 표시된다.
같은 계정을 다시 사용하려면 남은 리셋권을 확인하고, 안내된 `/resolve`(Slack: `!resolve`)로
원래 요청의 보류를 종료한 뒤 새 카드에서 확인한다.

`/restart`는 인수가 없다. Slack의 선택기는 `/superagent-restart`, 일반 메시지는 `!restart`다.
접수 응답이 실제 전송된 뒤 Gateway가 정상 종료와 일회성 successor 기동을 맡고,
새 헤드가 동일 세션·실제 준비 상태를 확인한 결과를 원래 대화에 알린다. 접수 알림만 보고
재시작 완료로 간주하지 않는다. `/stop head`를 먼저 보낼 필요는 없다. 바쁜 헤드의 원래 승인 카드를
취소하고, 대기 입력을 회수하고, 진행 중인 턴과 goal을 중단한다. 헤드 소유의 네이티브 백그라운드
작업도 취소하고 실제 종료를 기다린다. 새 헤드는 같은 세션과 작업 디렉터리, 기존 native 프로필을
다시 사용하고 시작과 동일한 메모리 설정 확인을 거친다. 같은 모델·effort를 대조하며 재시작 직전
활성 goal만 원래 대화에서 이어간다.
이미 paused/cancelled인 작업, receipt 없는 제출과 불확실한 외부 효과는 재실행하지 않는다.
no-progress로 유휴 상태가 된 활성 goal도 생성 당시의 원래 source/route를 유지한다. 그 소유권을
확인할 수 없으면 서비스 교체는 진행하되 goal 자동 재개만 보류하며 restart 대화로 넘기지 않는다.
독립 레인은 원래 Host와 승인 신원을 유지한다. 종료되지 않은 소유 작업/서비스나 소유권 불명은
원래 HEAD의 native 상태를 확인하라는 구체적 보류로 남으며 강제 종료하지 않는다. 체크포인트까지
저장됐고 아직 종료를 요청하지 않았다면, 남은 작업을 정리한 뒤 새 `/restart`로 다시 시도할 수 있다.
이전 명령의 중복 수신이나 종료 결과가 불분명한 요청은 재시도하지 않는다.
실행 후 `idleMs` 같은 운영 설정을 바꿨어도 `/restart`로 적용할 수 있다. 상태 디렉터리,
헤드의 작업 디렉터리·OMP 실행 프로필, 메신저 접근 권한이 바뀌었거나 접수 후 파일을 다시
수정했다면 교체를 보류한다. 채팅에 표시되는 Gateway의 거부 사유를 확인한다.
handoff 전 `/stop head`와 명시적 CLI `stop main`은 재시작보다 우선하며 successor 부활을 금지한다.
바쁜 native가 CLI 중지를 거부했어도 중지 요청 이전 restart의 권한은 되살아나지 않는다.
Gateway 앞에 불확실한 승인 답변이 남아 있어도 재시작·중지 제어와 초기 승인 복원 barrier는
통과할 수 있다. 일반 입력 순서는 바꾸지 않으며 원래 답변/효과는 격리한다. 아직 native에 남은
질문 세대를 취소한 경우 늦은 답변은 거절한다. 이미 소비된 승인이나 외부 효과의 rollback은 아니다.
불확실한 발송·종료·기동은 같은 요청으로 자동 반복하지 않고 상태와 원래 receipt를 확인한다.

`uncertain` 입력은 같은 target의 뒤 입력을 계속 막는다(자동 재시도 금지). 헤드는 아래의
근거 기반 자동 복구를 먼저 수행할 수 있고, 여전히 결과를 확인할 수 없는 요청을 버리는 결정은
운영자의 명시적 `/resolve [input-id]`로만 한다. `/status`가 보류 중인 정확한 입력 ID를 보여주며,
보류가 둘 이상이면 ID를 생략한 `/resolve`는 거부한다(최근 항목을 임의로 고르지 않는다).
`/resolve`는 원래 작업을 다시 보내거나 수행 결과를 주장하지 않고, 해당 대화에 종료 처리
사실만 알린 뒤 즉시 큐를 다시 비운다. 같은 작업이 여전히 필요하면 새 요청으로 보낸다.
native 세션을 변경하지 않으므로 바쁜 헤드나 native 상태 미확인 시에도 처리된다.
취소 대상은 효과를 적용하기 전에 영속 고정하므로 처리 도중 재시작되어도 다른 요청을
선택하지 않는다. 저장된 보류 해제와 native 실행 종료는 별개다. 실제 native 유휴가 확인된
뒤 취소된 접수의 메모리 상태도 정리하고 후속 작업을 실행하며, 다른 접수의 결과는 계속 확인한다.
Slack 일반 메시지는 `!resolve [input-id]`를 사용한다.

레인의 경우 연결된 대화의 `/status`에서 불확실한 입력 ID를 확인한다. 원래 세션과 외부
효과를 확인한 뒤 결과를 모르는 상태로 종료하려면 같은 대화에서 `/resolve --lane <input-id>`를
보낸다(Slack 일반 메시지는 `!resolve --lane <input-id>`). 정확히 일치하는 불확실한 입력만
취소하며, 원래 작업의 실제 결과를 단정하거나 다시 실행하지 않는다. 다른 불확실한 입력,
일시정지, 승인 또는 연결/소유권 문제는 그대로 보류된다. 레인이 열려 있고 native 상태를
확인할 수 있을 때만 후속 입력이 정상 경로로 전달된다.

#### 헤드의 근거 기반 자동 복구

도구 실행이나 부분 응답 없이 종료된 Codex `usage_limit_reached`가 정확한 헤드 요청
기록으로 확인되면, 헤드는 약 5분 간격으로 OMP의 해당 모델 사용량을 읽는다. 같은 세션에서
사용할 수 있는 계정의 회복을 실패 이후 새 보고로 확인하면, 실패한 입력만 취소로 닫고
뒤의 대기 입력을 순서대로 진행한다. 초기화 예정 시각이 지났거나 캐시·계정 근거가
불명확한 것만으로는 풀지 않는다. 리셋권을 쓰거나, 테스트 모델 호출을 하거나,
실패한 원래 작업을 다시 보내지 않는다. 다른 실패와 불확실한 외부 효과는 계속 보류한다.

모델 거절(`provider_refusal`)이나 제공자 오류처럼 도구를 하나도 시작하기 전에 끝난 헤드
요청은 같은 실행 기록(요청 하나, 도구 호출 없는 실패 응답, 사용량 기록뿐)으로 확인되면
보류하지 않고 실패로 닫으며, 다시 실행하지 않고 다음 요청을 처리한다(쿼터·사용량 한도 거절은
복구가 확인되기 전에는 재시작 뒤 `session_exit`나 모델 변경·어댑터 부재가 있어도 계속 보류한다). 재시작 뒤 이미
보류된 같은 종류의 입력도 복구 점검에서 닫는다(receipt 뒤에는 사용량 기록과 `session_exit` 같은
custom 기록만 허용하고, 뒤에 메시지·새 실행·도구 시작이 있으면 계속 보류한다). 도구가 하나라도 시작됐거나 기록을 읽을 수
없으면 계속 보류하고, 실패 안내에 정확한 `/resolve <input-id>`를 적는다. 보류 중 새 헤드
메시지가 오면 막은 입력 ID와 `/resolve` 안내를 마커와 함께 한 트랜잭션에 저장해 한 번만 보낸다.

요청 결과가 불확실해지면 코드가 먼저 native 근거와 실행 신원을 대조하고, 판단 가능한 근거가
있을 때 같은 헤드가 기존 native 세션에서 별도의 복구 판단 턴을 수행한다.
다른 AI 감독자나 새 세션을 만들지 않으며 원래 요청도 다시 제출하지 않는다. 실행·goal·비동기
작업·소유 서비스·승인 등이 남아 있거나 native 상태를 확인할 수 없으면 복구 턴도 시작하지 않는다.
재연결·native 종료 등 실제 사건에 반응하며, 같은 근거로 반복 모델 호출을 하지 않는다.
자동 판단 턴은 원본 입력당 한 번만 제출한다. 근거 부족으로 아직 제출하지 않은 입력은
새 native receipt가 도착하면 판단 대상이 될 수 있지만, 제출한 복구 턴을 맹목 재전송하지 않는다.

헤드는 원래 요청 ID와 세션·실행 세대에 연결된 receipt, 해당 실행의 마지막 결과, 관련 효과의
상태를 보고 `head_recovery`로 해제 또는 보류를 판단한다. 코드가 근거 ID와 최신 상태를 다시
대조하므로 모델의 설명만으로 해제되지 않는다. 실제 native 처리 완료 또는 기록된 native 중단은
조율 상태에 반영할 수 있지만, 작업 수용 기준을 검증했다고 주장하지 않는다. receipt가 없거나
실패·외부 효과가 불확실한 경우에는 보류를 유지한다. 원본 receipt나 실행 소유권 근거가
없으면 추측을 위한 모델 호출도 하지 않는다. 복구 판단 결과는 원래 대화에 알린다.

복구 턴에서는 `head_recovery` 이외의 도구 실행을 차단한다. 파일 수정, shell/eval, 레인 실행,
승인 우회, 원본 재실행은 허용하지 않는다. 일반 헤드의 작업 도구를 영구 제거하는 것은 아니다.
복구 판단 자체의 native 종료까지 일반 큐는 막혀 있으며, 중간 재시작·중복 이벤트·늦은 결과가
새 판단이나 다른 요청의 취소로 바뀌지 않도록 원래 신원을 보존한다. 운영자 중단·수동 해제는
오래된 복구 판단보다 우선한다. 해결할 수 없는 건은 `/status`의 ID와 `/resolve`로 처리한다.
모델의 결정은 먼저 제안으로 저장하고, 복구 턴 자신의 정확한 receipt와 유휴 상태를 확인한 뒤
원본 상태와 통지를 함께 확정한다. 그 사이 종료되면 원본은 계속 `uncertain`이므로 수동
`/resolve`가 가능하며, 복구 receipt가 없어도 운영자 종료 의도와 실제 native 유휴를 확인하면
해당 복구 시도를 재실행 없이 정리한다. 아직 실행 중인 원본의 승인 알림·goal 신원은 보존한다.

조회와 중단은 일반 모델 답변을 기다리지 않는다. 압축은 native 요약 모델을 호출할 수 있으며,
일반 대화 실행·세션 초기화가 아니다. 실행·승인·goal·소유 서비스·미해결 제출이 있으면
압축을 거부한다. 압축 중에도 상태 조회와 `/stop head`를 처리하고, native 완료를 확인하기 전에는
압축 성공이나 뒤의 작업 실행을 선언하지 않는다.

헤드 중단은 현재 작업과 중단 접수 시점까지 이미 들어온 일반 헤드 대기·미제출 설정 변경을 취소하고,
native 입력 큐·활성 실행·압축·하위 작업·승인을 정리하며 goal의 자동 계속 실행을 멈춘다.
이미 제출한 설정 변경이나 이전 불확실한 외부 효과를 되돌렸다고 간주하지 않으며, 남은 서비스나 비동기 작업은
관측 결과대로 알린다. Gateway·다른 레인을 종료하지 않는다. 중단 이후 새 요청은 새 업무이며,
취소된 요청을 자동 재실행하지 않는다. 서비스 전체 종료는 로컬 CLI `stop main`으로 구분한다.

### 일반 OMP에서 세션 기록 찾기

같은 native profile의 일반 OMP에서 `/resume`을 연다. 현재 프로젝트의 레인이 기본 검색
대상이며 다른 cwd의 기록은 Tab으로 all-projects 범위로 전환한다. native `archive` 또는
ID/path 기반 기록 접근도 같은 원본을 사용한다. 별도 history CLI·설정·검색 서비스는 없다.

기존 journal·artifact는 원래 위치에 두고 native 프로젝트 bucket에 세션 파일·artifact
디렉터리 링크만 게시한다. 새 journal은 materialization 뒤, 기존 등록 레인은 새 코드를
로드한 헤드의 시작 시 보충한다. 레인을 깨우거나 기록을 옮기고 복제하는 migration이 아니다.
소스 편집만으로 실행 중인 서비스가 갱신되지는 않는다. 기존 프로필·설치 경로도 확인한다.

기록만 확인하려면 native 기록 도구나 원본 경로의 `read`를 사용한다. `/resume`으로 의도적인
일반 작업 재개도 가능하며 읽기 전용 보장 경로가 아니다. 원본이 다른 writer에 열려 있으면
native 정책에 따라 fork하며 writer 해제 뒤 재개·후속 세션 선택도 native 정책을 따른다. 이는 기존
관리 Host의 동일 프로세스 attach나 실행 소유권 인계가 아니다. 일반 재개는 manager/board
확장을 자동 로드하거나 관리·게시판 권한을 얻지 않는다. 기록 내용은 새로운 권한·지시가 아니다.

상담용 `task`의 `agent: "seance"`·`sourceSession`은 **실제 호출자가 광고할 때만** 사용한다
(18.20.2의 기능). 공식 OMP 18.20.3은
[`db5d932058ec01e5aec61bb7fb5848a87cfc3c32`](https://github.com/can1357/oh-my-pi/commit/db5d932058ec01e5aec61bb7fb5848a87cfc3c32)에서
seance를 제거했으므로 major 18 전체에 제공된다고 가정하지 않는다. 세션 검색·읽기는 seance 및
Mnemopi를 사용하는 메신저의 과거 작업 검색과 별개다.

### 승인·질문 응답

추적할 owner 선택은 `decision_ask({questions: [...]})`로 묻는다. 각 질문은
`question`, `options: [{label, description?, preview?}]`, 선택적 `header`, `multi`,
0부터 시작하는 `recommended`를 사용한다. 기존 native 질문 카드로 표시하며 시간 초과로
추천을 확정하지 않는다. 별도 질문 메시지나 응답 명령은 없다.

HEAD는 `decision_list({})`로 미결 결정을, `decision_list({state: "all"})`로 이력을 확인하고
`decision_inspect({id})`로 원래 질문·선택지·추천·답변과 source/native/card 신원을 읽는다.
`answering`은 전송한 답변의 native 반영이 아직 확인되지 않았다는 뜻이며 재전송하지 않는다.
`decision_withdraw({id, sourceId, reason})`는 같은 원래 대화의 실제 owner 입력을 근거로
미결 질문만 철회한다. `withdrawn`은 동의가 아니며 `confirmedAt`이 없으면 native 취소
확인까지 주장하지 않는다. 일반 `ask`·tool permission 승인은 이 장부와 별개다.
운영자 답변은 원래 인증 카드로만 받으며 HEAD는 일반 채팅의 A/B를 답변으로 추정하지 않는다.
장부에 답변이 생겨도 일시정지된 레인이 자동 재개되지는 않는다.

승인·질문은 각 플랫폼의 아래 UI로 응답한다. 주제를 바꾼 뒤에도 이전 주제의
미해결 승인은 **그 카드에 연결된 정확한 native 요청**으로만 응답할 수 있다.
현재 주제나 일반 메시지 텍스트가 승인 목적지를 바꾸지 않으며 만료·소비된 응답은 거부한다.
답변 attempt는 head stream 전달 전에 영속 기록하고 복구 때 원래 approval·route·native
pending request와 대조한다. 모호한 `uiResponse`를 그대로 재전송하지 않는다. Telegram은
`hasPendingAnswer(id, route)`로 queued 비활성 카드의 저장된 답변도 원래 identity로 readback하며,
head 복구 뒤에도 미해결 queued 답변을 보존한다. active 카드가 아니라는 이유만으로 답변을
유실 처리하거나 적용 성공을 추정하지 않는다.
주제 명령·pause/resume·승인 응답의 의미와 native 대상은 head runtime이 처리하며 Gateway가
lane을 고르거나 LLM 판단 없이 업무를 자동 dispatch하지 않는다. 시작 시에는 메신저 인증과
head의 native 승인 카드 복구를 먼저 마친 뒤 입력·콜백 처리를 연다.
복구 전에 들어온 답변을 오래된 것으로 소비하거나 ACK하지 않는다. Slack의 서로 다른
동시 선택·모달 제출은 카드별로 순서대로 처리하고 실제 재전달만 중복 제거한다.

레인이 `decision_ask`로 올린 질문은 먼저 헤드가 검토한다. 위임 범위 안의 일상적 선택이면
헤드가 대신 고른 원래 선택지를 레인으로 돌려보낸다. 선택 이유는 내부 이력에 남기고 별도
메신저 알림은 보내지 않는다. 중요한 범위·비용·권한·외부 약속이 걸리거나 사용자 판단이
필요하면 이관 이유를 원래 질문 카드에 함께 표시한다. 실제 실행 승인과 일반 native dialog는
헤드가 대신 답하지 않는다. 아래의 `ask` 카드는 `decision_ask`가 쓰는 구조화된
`askDialog`다. OMP 19.1 내장 `ask`의 HTML `form`은 Host가 메신저로 보내지 않고
즉시 취소한다. 선택한 기본값도 제출하지 않는다.

| 플랫폼 | 승인·질문 UI와 실제 한계 |
| --- | --- |
| Discord | 버튼·선택·모달. native `select`는 한 카드에서 25개씩 페이지로 표시하고, 긴 선택지·설명은 메뉴에서 줄여 표시하되 전문은 카드 본문이나 텍스트 첨부에 싣는다. 원래 선택값은 그대로 돌려준다. `ask`는 질문당 25개 및 label·설명당 100 UTF-16 단위 이하이며 자유 입력 초안은 채널 카드에 표시하지 않는다. 원래 요청·메시지·세션에 묶인 응답만 수락하고 durable 접수 뒤 ACK |
| Telegram | inline 버튼과 **정확한 활성 봇 카드에 대한 답장**으로 input/editor·ask 자유 입력. 카드 4,096 UTF-16 단위, 100행 이하, 버튼 label 64 UTF-16 단위 이하, callback_data 64바이트 이하. ask의 진행·답안을 영속화하고 최종 버튼 콜백은 durable 접수 뒤 ACK. 재시작 시 같은 카드를 편집해 API 응답 신원을 확인하며, 단순 캐시를 readback으로 간주하거나 불확실한 카드를 새로 만들지 않음 |
| Slack | Block Kit 버튼·최대 100개 옵션 select·input/editor/ask 자유 입력 모달. label·옵션 설명 75자, 입력 3,000자, placeholder 150자 이하. 카드 50 blocks·39,000자·semantic content 100 KiB 이하. 원래 workspace·사용자·카드 및 모달 ID/metadata를 확인. 채널 카드에는 초안 본문 대신 입력 여부만 표시하며, 제출 또는 취소 결과는 같은 질문 카드에서 확인 |

비밀 입력 또는 해당 플랫폼이 온전히 표현할 수 없는 native dialog는 잘라내거나 임의 답변하지
않고 native 요청을 취소한 뒤 로컬 OMP UI 사용을 안내한다. 메신저 응답은 비밀 입력 경로가 아니다.
Telegram은 인증한 승인 카드의 account·실제 chat/thread·메시지 ID 표식을 영속화한다.
닫거나 취소한 카드도 내용 없는 tombstone을 남겨 버튼 제거·재시작·주제 전환 뒤의 늦은 답장이
새 작업으로 접수되지 않게 한다. 닫힌 dialog의 별도 진행 메타데이터에서는 부분 ask 선택·자유
입력 답안을 제거한다. 이는 원래 native 세션이나 이미 접수된 기록 전체를 삭제한다는 뜻은 아니다.

Discord의 일반 출력은 원래 사용자 메시지와 같은 물리 대화일 때 그 메시지에 답장한다.
새 스레드로 보낸 결과나 실제 메시지가 없는 slash interaction에는 reply reference를 넣지 않는다.
삭제된 원문은 Discord의 단일 전송 요청에서 허용하며 실패 뒤 중복 전송하지 않는다.
작성자 mention은 끈다. 긴 출력은 [아래 발송 한도](#5-운영-범위와-복구-제약)에 따라 먼저 분할하고,
한도를 넘으면 텍스트 첨부를 사용한다. 제자리 수정용 상태 메시지는 분할하지 않는다.

```sh
bun --no-env-file src/cli.ts stop LANE_ID --config config.local.json
bun --no-env-file src/cli.ts stop main --config config.local.json
```

`LANE_ID`는 status에서 확인한 실제 값으로 바꾼다. target 생략 시 main이다.
관리 RPC Host의 동일 프로세스 native TUI/herdr attach와 attach CLI는 지원하지 않는다.
과거 native TUI PTY 기록은 [이전 소스 기준선 증거](releases/0.1.0.md#legacy-patched-baseline)로만 보존한다.
로그 tail·별도 resume 세션을 동일 Host의 관측·제어 접속으로 표시하지 않는다.
`stop LANE_ID`는 해당 Host의 안전한 종료 요청이며 바쁜 Host는 거부한다. `stop main`은 감독 대상
head와 Gateway의 명시적 종료이며 Gateway가 head를 즉시 재기동하지 않는다. 강제 종료나 기록
삭제가 아니고 기존 busy-host 보호를 유지한다. 전체 레인 일괄 중지는 아니므로 레인은 각각 확인한다.
Gateway가 native 종료 요청을 바쁨으로 거부받으면 서비스를 유지한다. 성공적인 명시적 중지에서는
native shutdown 전에 supervisor의 재기동을 억제해 의도한 종료를 crash로 오인하지 않는다.
shutdown ACK는 프로세스 종료나 슬롯 반환이 아니다. native 프로세스의 실제 종료를 확인한 뒤에만
소유권·Host 예산을 해제한다. RPC disconnect·기존 PID 종료·socket 부재를 대조하며 하나라도
관측 불가면 보류한다.
head의 Gateway client 연결 해제는 transport stop이 아니다.

### macOS 로그인 자동 시작 등록

Hermes의 `gateway install`·`uninstall` UX를 기존 단일 Gateway 구조에 맞게 적용했다.
이 프로젝트의 CLI는 `gateway` 하위 명령 없이 다음처럼 사용한다.

```sh
bun --no-env-file src/cli.ts install --config config.local.json
bun --no-env-file src/cli.ts status --config config.local.json
bun --no-env-file src/cli.ts uninstall --config config.local.json
```

- `install`: 현재 계정의 LaunchAgents에 인스턴스별 등록을 준비하고 다음 로그인의 실행을
  허가한다. 즉시 bootstrap하거나 Gateway·모델·메신저를 시작하지 않는다.
- 로그인 시 절대 경로로 기존 CLI `start`를 한 번 호출한다. macOS의 **로그인 후** 동작이며
  로그인 전 부팅 데몬은 아니다. `KeepAlive`로 별도 감독·재시도하지 않으므로 명시적 중지와
  메신저 `/restart`의 일회성 successor가 OS 재기동과 경쟁하지 않는다.
- `status`의 `autostart`에서 등록·launchd 실행 상태를 확인한다. 설치된 plist나 launcher의
  종료는 Gateway/head ready 또는 실제 메시지 응답 성공을 뜻하지 않는다.
- `uninstall`은 정확히 소유한 자동 시작 등록만 제거한다. 시작 launcher가 실행 중이면 강제로
  끊지 않는다. 기존 Gateway·HEAD·레인·세션·비밀 파일은 유지하며 중지는 `stop main`으로
  별도 요청한다. `stop main`만 실행하면 등록은 남아 다음 로그인에 다시 시작한다.
- 자동 시작에는 구성한 모든 메신저 credential 이름을 owner-only `FILE.env`에 준비해야 한다.
  현재 셸의 credential만으로 설치 성공을 주장하지 않는다. plist에는 토큰이나 임의 환경변수를
  복사하지 않으며 native 모델 인증은 해당 계정의 기존 OMP 설정을 사용한다.
- Bun·저장소·설정 경로를 옮겼다면 다시 설치한다. 서비스 관리자 오류·타인 소유/변조 등록은
  성공으로 숨기거나 `--force`로 인계받지 않는다.
- native `command[0]`도 실행 가능한 절대 경로여야 한다. 로그인 환경은 대화형 셸 초기화 파일을
  읽지 않으며 셸 전용 모델 인증·설정 환경변수를 복사하지 않는다.
- 비정상 종료·전원 손실 뒤의 stale socket, 재사용된 PID, 미확정 재시작 기록은 기존 Gateway
  소유권 검사에서 시작을 보류할 수 있다. 로그인 launcher는 이를 지우거나 우회하지 않으며
  실패한 시작을 자동 반복하지 않는다. 등록 성공은 모든 crash 복구의 보장이 아니다.
- Linux/systemd·Windows 서비스 설치와 Gateway crash 자동 재시작은 이 명령의 범위가 아니다.

## 5. 운영 범위와 복구 제약

- 자율 작업은 기존 native task/job·goal·workflow owner를 사용하며 원래 허가 목표·source/route·
  승인·도구 제외·pause/cancel·불확실성 보류를 유지한다. 헤드는 durable lane report 뒤 남은
  허가 작업만 지시하며 대기용 모델 polling·별도 scheduler를 만들지 않는다. 저장 goal이
  crash prompt replay·unloaded 실행·작업 완료를 보장하지 않는다.
- launch 설정과 역할 파일 수정은 새 Host 기동/허가된 재시작 뒤 적용된다. 설치·소스 편집은
  운영 반영의 증거가 아니다. paused goal도 enabled이면 종료 guard에 따라 Host·슬롯을 유지할 수 있다.
- 세션별 Rust Host owner는 native OMP stdio와 재연결 socket을 유지한다. 세션 파일·lease·연결·실행·
  실제 종료는 별개다. native UI·비동기 실행·goal·소유 서비스·저장 완료가 확인되지 않으면
  안전한 유휴로 추측하거나 강제 회수하지 않는다. shutdown ACK만으로 예산·소유권을 해제하지 않는다.
  상세 구현은 [실행 자원과 Host 수명](design/execution.md#execution-budget-and-host-lifecycle)을 따른다.
- 모든 플랫폼의 입력 첨부는 요청당 최대 10개, 개별 20 MiB, 합계 40 MiB다.
  선언 크기·실제 스트림 크기를 대조하며 redirect는 따르지 않는다.
  Telegram에서 `file_size`가 없으면 크기 미상(`null`)으로 저장한다. 알려진 0바이트와 구분하며,
  미상 크기도 실제 다운로드 바이트의 파일·요청·이미지 한도를 적용한다. Gateway가 전용 디렉터리에
  파일을 저장하고 요청 전체가 완료되면 파일별 경로·SHA-256을 반환한다. HEAD는 요청 ID와
  파일 순서로 영수증을 검증한다. PNG/JPEG/GIF/WebP는 내용 시그니처를 확인하며,
  모델에 넘길 바이트의 SHA-256이 영수증과 다르면 요청을 취소한다.
  RPC base64 입력의 디코딩 후 이미지 데이터 합계는 별도로 8 MiB로 제한한다.
  그 밖의 파일은 로컬 경로를 제공한다. 임의 URL 다운로드·문서 자동 변환은 제공하지 않는다.
  Gateway 재시작 시에는 소유권과 형식이 확인된 미완료 다운로드만 정리한다. 완료된 첨부는 남는다.
  자격 증명·서명된 다운로드 URL은 모델 프롬프트에 넣지 않는다.
  안전한 다운로드에 실패하면 그 요청의 모델 실행을 시작하지 않는다.
- Discord·Telegram 답장의 참조 ID·작성자·본문과 Telegram 선택 인용문을 head와 명시적 레인
  인계에 전달한다. 인용은 새로운 명령·권한·목적지가 아닌 데이터다. 첫 접수 스냅샷은 원문의
  수정·삭제·재전달로 바뀌지 않으며, 삭제/조회 불가한 참조는 알려진 ID와 `null` 필드로 표시한다.
  Discord는 같은 허가된 물리 채널의 참조만 조회하고, Telegram 승인 카드 답장은 기존 절차를
  유지한다. 음성 여부·길이는 전달하지만 자동 전사 기능은 아니다. Discord 스티커 전용 등
  의미 있는 텍스트·지원 첨부가 없는 입력/수정은 새 작업으로 접수하지 않는다.
- 레인 저장소·게시판 저장소 채널 탐색은 시작 셸의 `GIT_DIR`, `GIT_WORK_TREE` 및 다른
  `GIT_*` 환경을 제거한 Git 프로세스를 사용한다. 일반 도구 환경 전체의 격리와는 다르다.
- 입력 리소스의 허용 범위는 플랫폼마다 다르다.
  - Discord: `cdn.discordapp.com`·`media.discordapp.net`의 HTTPS
    `/attachments/<숫자>/<숫자>/…` 원본 URL만 허용한다.
  - Telegram: 장부에는 토큰 없는 `telegram-file:<file_id>`만 보관한다. 접수된 원래 route와
    file 메타데이터를 대조한 뒤 `getFile`로 최대 20 MiB를 확인한다.
    `api.telegram.org/file/botTOKEN/…` URL은 즉시 HTTPS 다운로드에만 사용하고 장부·오류에
    보관하지 않는다. 파일 경로 traversal도 거부한다.
  - Slack: 토큰 없는 `slack-file:<file_id>`에서 `files.info`로 소유자의 hosted 파일·workspace·
    원래 대화/thread share를 확인한다. 해당 team/file의 `files.slack.com/files-pri/TEAM-FILE/…`
    HTTPS 경로에만 bot Authorization 헤더로 접근한다. 외부 링크 파일은 받지 않는다.
- 운영자가 만든 파일을 결과물로 받고 싶으면 새 일반 메시지의 요청 첫 줄에
  `attach: 보고서/결과.pdf`처럼
  정확한 작업 디렉터리 상대 경로를 적는다. 첫 줄에 `cwd:`를 지정한다면 그 다음 줄에 적는다.
  첨부는 한 요청당 파일 하나, 최대 8 MiB다. 숨김 경로·링크·런타임 및 자격 증명 경로는 거부한다.
  Discord·Telegram·Slack의 원래 작업 대화에만 발송되며, 작업 스레드가 없는 경우 원래 요청 대화가
  대상이다. 수정 메시지·앱 슬래시 상호작용·모델 답변으로는 첨부를 허가할 수 없다.
  제한 그룹에서도 사용할 수 없다.
- 긴 출력의 한도는 입력 첨부 한도와 다르다. Discord 일반 답변은 2,000 UTF-16 단위를
  넘으면 문단·줄·공백 경계에서 최대 5개 메시지로 나눠 순서대로 보낸다. 코드 블록이 경계에
  걸리면 앞 메시지에서 닫고 다음 메시지에서 같은 언어로 다시 연다. 원래 메시지에 대한 답장 표시는 첫
  메시지에만 붙고, 전송 영수증도 첫 메시지 ID를 쓴다. 모두 전송된 경우 이후 조각의 ID도 기록해
  어느 조각에 답장해도 원래 작업을 찾을 수 있다. 일부만 보낸 뒤 실패하면 다시 보내지 않고
  불확실(uncertain)로 남긴다. 다른 물리 대화는 병렬로 발송할 수 있지만 같은 물리 대화 안의
  장부 순서는 유지한다. Telegram·Slack의 변경·발송 API는 자동 재시도하지 않는다.
  읽기/poll 재연결과 불확실한 외부 효과를 재실행하는 것은 다르다.

  | 플랫폼 | 일반 텍스트 | 긴 출력 |
  | --- | --- | --- |
  | Discord | 2,000 UTF-16 단위 이하 | 최대 5개 메시지로 분할, 그보다 길면 텍스트 첨부(최대 8 MiB) |
  | Telegram | 4,096 UTF-16 단위 이하 | `sendDocument` 텍스트 파일, 최대 50 MiB. parse_mode 없이 전송하고 preview·paid broadcast 비활성화 |
  | Slack | 3,000자 이하 plain text | 텍스트 파일, 최대 8 MiB. `files.getUploadURLExternal` → HTTPS 업로드 → `files.completeUploadExternal`로 원래 channel/thread에 게시. 폐기된 `files.upload` 미사용 |

- Discord·Slack의 재연결/재시작 catchup은 **이미 기록된 대화와 마지막 메시지 ID 이후**만 조회한다.
  새 설치의 과거 전체 기록, 처음 보는 오프라인 스레드, cursor 이전 메시지 수정·삭제는 복원하지
  않는다. 봇의 history scope/권한과 메시지·첨부의 실제 접근 가능성이 필요하다.
  Slack의 retention/rate-limit·불완전 history는 성공으로 가장하지 않는다.
  Telegram은 history 조회 대신 위의 영속 update offset·최대 24시간 보존 경계만 사용한다.
  DM 조회 cursor는 실제 채널 기준이다. 논리 주제 경계는 영속화한 제어 메시지 ID 순서로
  적용하므로 늦게 받은 메시지를 현재 선택 주제로 임의 이동하지 않는다. 재전달된 명령도
  이미 접수한 원래 주제를 유지하며 현재 선택을 과거로 되돌리지 않는다.
- 수신·발송 장부는 재전달을 구분하지만 외부 효과의 exactly-once를 보장하지 않는다.
  불확실한 실행·전송은 성공으로 간주하거나 자동으로 맹목 재실행하지 않는다.
  레인에 미해결 제출 입력이 있으면 뒤의 queued 입력도 dispatch하지 않는다. 새 후속 입력이나
  resume으로 fence를 우회하거나 원래 불확실성을 해제하지 않는다.
  유휴 회수·모델 턴 종료는 사용자 작업의 완료·검증 통과를 뜻하지 않는다.

## 6. 개발자 검증

원격 등록·레인 제어는 [워커 추가 절차](../README.ko.md#원격-워커-추가)로 설정한다.
OpenSSH 클라이언트·서버와 stock OMP가 설치되어 있으면 아래 명령으로 별도 머신 없이
등록 → 원격 시작 → 연결 해제/재접속 → 후속 메시지와 답변 → 종료를 시험할 수 있다.
임시 HOME과 전용 키, 루프백 `sshd`, 오프라인 모델을 사용한다. 실제 테일넷 연결이나
메신저 계정은 검사하지 않는다.

```sh
OMP_SUPERAGENT_WORKER_SSH_TEST=1 bun test test/native-worker-ssh.test.ts
```

일반 회귀는 `bun run check`와 `bun run test`로 실행한다. 테스트 스크립트는 네이티브 바이너리를
빌드한 뒤 격리된 워커 두 개로 테스트 파일을 실행한다. 순서 의존성을 확인할 때는 같은 범위를 `bun test test`로 직렬 실행할 수 있다.
기본 테스트는 opt-in native/PTY 시나리오를 제외한다. `.upstream`까지 탐색하는 인수 없는
`bun test`로 대체하지 않는다. OMP와 관리형 omp-superkit이 준비된 checkout의 `bun run test:ci`는
타입 검사, Rust Host owner·Gateway 테스트, 로컬 project/native/PTY·omp-superkit 통합 회귀를 실행한다. `scripts/ci.ts`는 활성
패키지의 entrypoint를 사용한다. CI와 대상별 native/PTY 실행은 공통 선택기로 PATH의 현재 설치
standalone CLI를 찾는다. Bun이 앞에 넣은 `node_modules/.bin`은 건너뛰며 SDK CLI나 과거 binary로 대체하지 않는다.
선택한 OMP 버전·실행 경로를 출력하고 공개 RPC·프로세스 관측 기능을 메타데이터로 확인한다.
`test:ci` 자체는 OMP를 다운로드·빌드·업데이트하지 않는다. Python 3이 필요하며 launchd 검증은 macOS에서만 실행한다.
`test:ci`는 설치된 CLI가 추출한 네이티브 바이너리만 실행별 임시 캐시에 공유한다. 각 fixture의 HOME·설정·인증은 계속 격리한다.
`OMP_TEST_NATIVES_DIR`에 신뢰하는 절대 경로를 직접 지정하면 임시 캐시 대신 사용하며, 이 경로는 실행 후 삭제하지 않는다.

PR, `main`, 수동 실행과 `v*` 릴리즈 태그의 GitHub Actions는 Ubuntu 24.04와 macOS 15 ARM64에서
실행한다. 두 러너는 SDK 기준판만 검사하며, 원본 oracle 재생은 macOS에서 실행한다.
릴리즈 게시는 양쪽의 테스트와 macOS Intel을 포함한 네 플랫폼의 패키지 설치 검증이 모두 통과해야 진행된다.
각 러너는 `bun run test:baseline`으로 SDK와 같은 공식 CLI를 임시 디렉터리에 받아
SHA-256과 `omp --version`을 확인한다.
`bun install --frozen-lockfile`이 준비한 네이티브 실행 파일을 재사용하며, 공통 테스트 러너를 실행할 때만
그 CLI를 `PATH` 앞에 넣는다. 같은 명령을 로컬에서
실행해도 PATH의 기존 OMP를 교체하지 않는다. 다운로드에는 인터넷·curl·shasum이 필요하다.
OMP 18은 CI에서 실행하지 않는다. 필요할 때만 `bash scripts/test-omp.sh v18.22.2` 또는 이전
비동기 작업 API를 쓰는 `v18.20.3`을 지정해 같은 검사를 수동으로 실행한다.

**OMP upstream compatibility**는 매주 월요일 04:17 UTC 또는 Actions에서 수동으로 실행한다.
upstream의 최신 정식 릴리스 태그를 한 번 조회한 뒤 Ubuntu·macOS ARM64에서 그 태그로 같은 검사를 수행한다.
실패한 태그는 로컬에서 `bash scripts/test-omp.sh vX.Y.Z`로 재현한다. 필요한 기능이 없거나 회귀가
있으면 이 워크플로는 실패하고 PR·릴리스의 기준판 검사는 영향을 받지 않는다. 호환성 확인만으로
제품의 지원 범위나 SDK lockfile이 바뀌지는 않는다. 이 검사는 실제 계정·유료
제공자·herdr·실제 로그인/재부팅을 검증하지 않으며 과거의 동일 프로세스 TUI attach 지원도
뜻하지 않는다. 최신 upstream 검사의 실제 결과는 해당 Actions 실행에서 확인한다.
[이전 릴리즈의 stock 18.20.2와 패치된 18.20.0 검증 기록](releases/0.1.0.md#verification-records)은
현재 SDK 기준판이나 이후 변경의 증거로 재사용하지 않는다.

### 대상별 native·omp-superkit 회귀

native 시나리오는 기존 opt-in을 명시적으로 켜며 `OMP_TEST_COMMAND`가 없으면 PATH에서 현재
설치 stock CLI를 자동 선택한다. 실제 CLI/소켓·결정적인 로컬 provider·기록용 Messenger를
사용한다. 사용자 설정·인증은 분리하며 실제 메신저 로그인이나 동일 프로세스 TUI/herdr attach의
검증 명령이 아니다. CLI 자동 선택은 native/PTY·외부 패키지 opt-in을 대신 켜지 않는다.

```sh
OMP_SUPERAGENT_NATIVE_TEST=1 bun test test/native-host.test.ts test/native-runtime.test.ts test/native-model-selection.test.ts test/native-board.test.ts test/native-gateway.test.ts
OMP_SUPERAGENT_NATIVE_TEST=1 bun test test/native-autonomy.test.ts
```

의도적으로 격리한 설치를 검증할 때만 `OMP_TEST_COMMAND`에 standalone CLI argv의 비어 있지
않은 JSON 문자열 배열을 지정한다. 직접 실행·fixture 하위 프로세스·PTY·`test:ci` 모두 같은
override를 존중한다. 잘못된 argv·미지원 버전·실행 실패는 자동 선택으로 숨기지 않고 실패한다.
override 첫 인수가 `omp`여도 dependency shim이 아닌 설치 CLI로 해석한다.
PTY 새 설정 테스트는 선택된 실행 파일을 격리된 PATH에 연결해 실제 setup이 그 파일을
발견하게 한다. 새 설정은 제품 계약대로 실행 파일 하나만 저장하며 테스트 override의 추가
CLI 옵션을 자동 주입하지 않는다. 기존 설정의 명시된 옵션은 그대로 보존한다.

omp-superkit 합성 회귀는 외부 checkout을 수정하거나 설치하지 않고 명시한 entrypoint를 읽어 실행한다.
환경변수를 생략하면 외부 패키지 조합은 건너뛴다.

```sh
OMP_TEST_ULW_EXTENSION=/absolute/path/to/omp-superkit/index.ts bun test test/skills.test.ts
```

새 revision과 기존 revision 재활성화는 배포된 OMP SDK의 실제 prompt renderer·ExtensionRunner를
사용하는 격리된 offline composition probe도 통과해야 한다. 상세 검사는
[관리형 통합 계약](design/execution.md#managed-omp-superkit-integration)을 따르며 import·합성 성공을
모델 호출·Agent 실행·goal 생성·workflow 완료의 증거로 확대하지 않는다.

### 소스·npm 릴리즈

GitHub 소스 아카이브는 커밋된 소스만 담으며 설치할 때 현재 플랫폼용 Rust Gateway와 Host
owner를 빌드한다. npm `.tgz`는 네 플랫폼용 실행 파일과 라이선스 고지를 함께 담아 설치
머신에서 Rust 빌드를 요구하지 않는다. 실제 실행에는 두 배포 모두 Bun과 별도 설치한 OMP가
필요하다. 관리형 omp-superkit은 설치 단계에서 준비하며 아카이브에 내장하지 않는다.
CI·기준판 테스트·릴리즈 스크립트는 소스 checkout 전용이며 npm 패키지에는 포함하지 않는다.

`package.json`의 버전과 `docs/releases/<version>.md`를 준비하고 의도한 변경을 커밋한다.
[CI의 네이티브 빌드 매트릭스](../.github/workflows/ci.yml)는 각 대상(`darwin-arm64`, `darwin-x64`,
`linux-arm64`, `linux-x64`)에서 `bun run build:native --package`로 두 실행 파일과 고지를
생성한다. 일반 소스 빌드 도구 외에도 Rust `rust-docs`가 필요하며, Linux의 정적 릴리즈
바이너리에는 해당 아키텍처의 musl Rust target과 `musl-gcc`가 필요하다.
패키징 job이 그 출력을 `gateway/bin/`과 `host-owner/bin/`에 모은 뒤
`bun run release`를 실행한다. 로컬에서 같은 명령으로 패키징하려면 깨끗한 Git checkout과
동일 커밋에서 빌드한 네 대상의 실행 가능한 바이너리·고지가 모두 필요하다. 소스 checkout에
`bun install --frozen-lockfile`만 한 상태는 현재 플랫폼만 준비하므로 이 요건을 충족하지 않는다.

[`scripts/release.ts`](../scripts/release.ts)는 HEAD를 `git archive`로 내보내고
`bun pm pack --ignore-scripts`로 준비된 npm 패키지를 만든다. 네이티브 파일·고지와 실행
권한을 확인하며 `dist/omp-superagent-<version>.tar.gz`, `.tgz`와 각각의 `.sha256`을
만든다. 인자 없는 명령은 게시하지 않는다.
승인받은 새 버전 태그를 원격에 푸시하면 CI가 Linux/macOS 기준판 테스트와 네 플랫폼의
npm 패키지 설치 검증을 모두 통과한 뒤 `bun run release --publish`로 **검증한 배포 파일을
다시 빌드하지 않고** GitHub Release에 게시한다. 이어 별도 npm job이 그 릴리즈의 동일한
`.tgz`를 내려받아 SHA-256을 확인하고 GitHub Actions OIDC로 npm에 게시한다.
버전과 태그·commit이 일치해야 하며 일반 태그 푸시는 기존 릴리즈를 덮어쓰지 않는다.
기존 릴리즈의 교체를 명시적으로 승인받은 경우에만, 이미 검증하고 병합한 커밋으로
해당 태그를 옮긴 뒤 그 태그에서 `ci.yml`을 `replace_release=true`로 수동 실행한다.
강제 태그 푸시 자체는 검증만 하며 게시하지 않는다. 수동 실행도 검증을 다시 통과해야
첨부 파일과 노트를 교체하고, 같은 tarball을 npm에 게시한다. 이미 게시된 npm 버전은
같은 번호로 덮어쓸 수 없다.

최초 한 번, npm의 `omp-superagent` 패키지 설정 → **Trusted publishing**에서 GitHub Actions를
추가한다. 사용자/조직은 `dbc-hbin`, 저장소는 `omp-superagent`, 워크플로우 파일은 `ci.yml`,
환경 이름은 비워두고 `npm publish`를 허용한다. 이후 로컬 `npm login`이나 저장된 npm 토큰은
필요 없다. npm 게시 결과가 불확실하면 먼저 레지스트리에서 정확한 버전과 tarball 해시를
확인한다. 버전이 없고 원인을 해소한 경우에만 실패한 npm job을 다시 실행한다. GitHub Release
또는 성공한 검증 job을 다시 실행할 필요는 없다.
외부 게시, 태그 푸시, 운영 Gateway 재시작은 로컬 테스트 성공과 별개의 명시적 작업이다.
