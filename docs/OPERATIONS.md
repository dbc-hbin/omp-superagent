# 운영·설치 가이드

[프로젝트 소개로 돌아가기](../README.md) · [설계](../DESIGN.md) ·
[설정 예제](../config.example.json) · [출처·라이선스 고지](../THIRD_PARTY_NOTICES.md)

이 문서는 기존 README의 설치·운영 계약, 복구 제약과 검증 이력을 보존한다.
아래 파일·코드 경로와 셸 명령은 별도 설명이 없으면 **저장소 루트 기준**이다.
명령은 `docs/`가 아니라 저장소 루트에서 실행한다. 검증의 ‘현재’·‘이번’ 표기는
각 기록 당시의 범위를 뜻하며 새 환경의 운영 성공이나 이후 변경의 검증으로 확대하지 않는다.

일반 코드 **Gateway**가 Discord·Telegram·Slack 연결과 단일 OMP 헤드의 수명을 유지하고,
모든 소유자 요청·후속 입력은 헤드가 판단해 직접 처리하거나 독립 OMP 레인에 명시적으로
전달하는 연동이다. 헤드/레인은 공유 정보 게시판을 사용한다. 일반 OMP의 세션·인증·도구·task를
재사용하며 herdr는 필수가 아니다. Gateway는 레인 RPC나 별도 AI 감독자가 아니다.
구조와 안전 계약은 [DESIGN.md](../DESIGN.md), 코드 출처는
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)를 참고한다.

**현재 상태:** Discord·Telegram·Slack 연동 확장, SQLite 조율 장부, 독립 레인 실행과 OMP 로컬
Host 패치가 구현되어 있다. 기존 native RPC/TUI·실제 runtime 코드의 로컬 E2E 통과 근거는
아래 표의 범위로 유지한다. Telegram·Slack 변경은 SDK 경계 테스트와 실제 로컬 Slack
WebSocket·heartbeat로 검증했다. 실제 운영 봇 로그인과 herdr 제어는 수행하지 않았다.
잘못된 generator 호출로 보조 OMP가 실행되어 파일 설명 응답을 받은 일이 있다. 실행 파일·PID·
세션·제공자 사용량을 확보하지 못해 실제 제공자 호출·비용 등 부작용은 미확인이다. 이는 결정적인
로컬 테스트 증거와 별개이며, 테스트는 실제 메신저 운영의 증거가 아니다.
아래 start 명령은 운영자가 명시적으로 실행할 절차이며 메신저 봇 자동 활성화는 없다.
**기존 runtime 통합의 검증 상태:** Gateway → head 기동·복구, 모든 후속의 head 경유, head-only manager /
lane-only 역할 확장 / 공통 board 확장과 게시판 알림은 아래에 기록한 로컬 회귀와 실제 native
runtime·model-selection·board·Gateway E2E 검증을 수행했다. 이는 기존 통합의 기록이다.
현재 변경은 최종 담당자가 root 타입 검사·전체 root 회귀·native discovery 회귀와 공식 ULW
설치 CLI를 확인했다. 실제 managed ULW 활성화·Gateway/runtime/model·Host/TUI/board·프롬프트
조합도 아래 새 검증 행의 범위에서 확인했다. 전체 root 회귀 뒤의 마지막 Host 수정은 별도
targeted 회귀와 실제 native 경로로 검증했으며 전체 root 재실행으로 확대하지 않는다.
이전 통과 수치는 당시 경로의 기록이며 이번 변경의 증거로 재사용하지 않는다.
기존 native 프리셋 최초 초기화·모델 동일성·세션 설정 격리·judge 자문 정책은 변경하지 않는다.

플랫폼 블록은 각각 선택 항목이며 **최소 하나**가 필요하다. 여러 블록을 설정하면 모두 동시에
연결되지만 헤드는 하나다. 각 플랫폼의 `ownerId`는 **동일한 신뢰된 운영자**를 뜻하며 모든
소유자의 메인 대화는 같은 OMP 맥락을 공유한다. 서로 다른 사람을 격리하는 멀티테넌트 구성이
아니다. 스레드·주제의 레인은 독립적으로 연결하며 표시 이름으로 플랫폼 간 신원을 합치지 않는다.

### 소스와 실행 경계

| 위치 | 실제 책임 |
| --- | --- |
| `src/cli.ts`, `src/config.ts` | 명시적 시작·진단·조회·접속·종료, 필수 설정과 전용 상태 경로 검증 |
| `src/gateway*.ts` | detached Gateway의 실제 어댑터·durable ingress·head receipt·지정 head 1개의 수명. lane dispatch/RPC 없음 |
| `src/gateway-client.ts` | head 안의 Messenger-compatible 로컬 client. 기존 send/승인/첨부 효과만 Gateway에 위임하며 client 종료는 transport 종료가 아님 |
| `src/extension.ts` | 부모 없는 `role=head`에서만 기존 runtime과 9개 lane 관리 도구 등록. 일반 OMP·lane에서는 manager 시작 안 함 |
| `src/lane-extension.ts`, `skills/{head,lane}` | 별도 lane 역할 지침과 native 스킬. lane은 독립 OMP Host이며 manager·실제 메신저 API 없음 |
| `src/board.ts`, `src/board-extension.ts` | head/lane 공통 SQLite 정보 게시판·세션별 구독/안전한 경계 알림. native 자식에는 권한 없음 |
| `src/messengers.ts` | Gateway에서 모든 설정 플랫폼의 실제 자격 증명과 어댑터 소유. head가 결정한 발송·승인은 원래 플랫폼으로만 전달 |
| `src/runtime.ts`, `src/contracts.ts` | 요청 라우팅, 주제↔레인 연결, 예산·대기열·안전한 회수, 승인·재연결·발송 조율 |
| `src/lane-models.ts` | native chat 모델의 안전한 카탈로그 메타데이터와 정확한 provider/id 동일성 처리 |
| `src/store.ts` | 요청·연결·상태·승인·발송의 SQLite 영속 장부. OMP transcript의 대체 저장소가 아님 |
| `src/discord.ts` | discord.js Gateway/REST, 소유자·목적지 권한, 메시지·첨부·대화형 응답 |
| `src/telegram.ts` | grammY Bot API long polling, 영속 update offset, 소유자·그룹/topic 권한, 첨부·inline 승인 |
| `src/slack.ts` | 공식 Socket Mode/Web SDK, workspace·소유자·채널 권한, 스레드·외부 파일 업로드·Block Kit 승인 |
| `src/host.ts` | 패치된 OMP 프로세스 시작과 로컬 소켓 RpcClient 연결. 연결 해제와 프로세스 종료를 구분 |
| `patches/omp`, `upstream/omp.json` | `rpc-ui` 로컬 소켓 Host·동일 Host TUI attach·명시적 종료를 위한 코어 변경과 고정 revision |

### 레인 관리 도구와 운영 스킬

헤드는 9개 관리 도구인 `lane_models`, `lane_init_presets`, `lane_start`, `lane_set_model`,
`lane_inspect`, `lane_message`, `lane_pause`, `lane_resume`, `lane_close`를 사용한다. `lane_inspect`의 ID 없는 호출이 목록 조회이므로 별도
`lane_list` 도구는 없다. 일반 코딩 도구는 유지하고, 레인과 native 서브에이전트에는
헤드 관리 권한을 주지 않는다. 서브에이전트에서 관리 도구를 직접 호출해도 거부한다.

| native 스킬 | 역할 계약과 상세 절차 |
| --- | --- |
| `skill://superagent-head` | 필수 헤드 계약. `references/routing.md`는 저장소 결정·직접 처리/위임·병렬 충돌·인계, `references/model-selection.md`는 native 카탈로그·judge 자문·헤드의 최종 모델 선택, `references/supervision.md`는 보고·수정 지시·복구·검증된 종료 |
| `skill://superagent-lane` | 필수 레인 계약. `references/workflow.md`는 범위 확인·직접 작업·native 부분 위임·검증·결과 보고 |

시작기는 head에 manager 확장과 공통 board 확장, lane에 lane 확장과 공통 board 확장을 명시적으로
전달하고 관리형 ULW package도 각 Host의 정확한 revision 경로로 로드한다. 프로젝트 루트는 추가
`-e` 리소스 경로로 전달한다. manager는 head에서만, lane 역할은 lane에서만
활성화되며 native 자식에 manager/board 도구를 상속하지 않는다. 일반 OMP 전역 설치는 없다.
OMP의 기존 `omp-plugins` discovery가 `skills/`를 발견하므로 현재 cwd와 무관하게
위 URI를 읽을 수 있다. 사용자·프로젝트 스킬 경로 배열을 덮어쓰거나 전역 스킬을 설치하지 않는다.
고정 버전에서 아직 호출되지 않는 `resources_discover` 훅에 의존하지 않는다.
현재 프로젝트 루트는 코드 진입점 없는 리소스 패키지이므로 봇 확장을 중복 실행하지 않는다.

역할 진입점은 `hide: true`다. 일반 스킬 목록에 역할을 광고하지 않지만 native URI는
계속 사용할 수 있다. root head의 manager 확장은 Host 시작 시 `skills/head/SKILL.md`와
`skills/head/references/` 아래의 모든 Markdown 파일을 재귀적으로 한 번 읽고, 매
`before_agent_start`에서 기존 system prompt에 전체 번들을 덧붙인다. 첫 추론부터 후속 턴까지
모든 헤드 운영 절차가 필수로 제공되며 첫 메시지에만 transcript로 삽입하지 않는다.
적용 전에 별도 `read`나 스킬 조회가 필요하지 않다. 파일 수정은 Host 재시작 후 반영된다.
이는 번들된 헤드 절차에만 적용하며 관련 없는 사용자·프로젝트 스킬을 모두 로드하지 않는다.
레인과 native 자식에는 헤드 번들을 주입하지 않으며 기존 위임·manager/board 권한 경계를
유지한다. 레인은 별도 필수 역할 계약과 필요할 때 `read`로 로드하는 workflow를 그대로 쓴다.
`--no-skills`로 native 스킬을 비활성화하면 상세 URI를 사용할 수 없으므로 이 운영 흐름에서는
사용하지 않는다. 운영자가 제외한 일반 도구를 스킬이 임의로 다시 활성화하지 않는다.

Dori의 운영 개념을 현재 도구 계약에 맞게 독립 작성했으며 SUL 스킬 문구·스크립트는 복사하지
않았다. 강제 위임, herdr 실행 의존, 별도 duty 모델·상태 레지스트리, 시간 경과 자동 종료,
자동 push·배포·worktree 삭제는 포함하지 않는다. `lane_resume`는 불확실한 제출 기록을
해제하지 않으며, 현재 도구에 없는 복구 동작을 스킬이 있다고 가정하지 않는다.

### 일반 모델 프로필과 역할 특화

관리형 `omp-ulw` 모델 프로필의 조사·구현·계획·검증 방법은 유지한다.
superagent의 필수 역할 계약은 그 프로필의 **일반적인 페르소나·위임/라우팅·출력 기본값만**
현재 head/lane 역할에 맞춘다. 운영자 권한·도구 제외, native 도구 계약·승인 요구보다 우선하지 않는다.
헤드는 범위가 명확한 메인 작업을 비단순 구현까지 직접 처리할 수 있고, 독립 대화·저장소 작업은
헤드 lane 도구로 분리한다. 레인은 실제 구현자이며 비단순 작업을 다시 의무 위임하지 않는다.
두 역할 모두 유용한 bounded native `task`를 쓸 수 있고 레인이 부분 작업마다 헤드 허가를
추가로 받을 필요는 없다. 원래 배정의 제한과 native 승인은 그대로 적용된다. 레인의 `final`·
`delivered`는 헤드에 대한 durable report이지 외부 메신저 발송이 아니다.
head→lane 지시와 lane→head 보고는 영어로 작성하며 필요한 원문·인용은 그대로 보존한다.
헤드의 실제 외부 답변은 사용자 언어를 따른다.

workflow/continuation은 기존 허가 목표·원래 source 경계 안에서만 적용하며 pause/cancel·불확실성
보류를 유지한다. 사용자가 명시적으로 선택하거나, 운영자가 위임한 방법 선택 권한으로 헤드가
**정말 필요한** workflow를 명시적으로 요청할 수 있다. 후자는 `selectedBy: head`이며 사용자가
브랜드를 요청했다고 쓰지 않는다. 브랜드 동의만 다시 묻지 않되 실제 비용·범위 선택, 권한,
설치 스킬의 엄격한 gate, artifact review·native plan 승인은 보존한다. 단순 인용·보고/brief/
board 언급은 선택이 아니며 레인은 명시적 허가 head dispatch만 따른다.

헤드 선택은 가벼운 직접 처리/task/일반 레인의 **구체적 부족**과 workflow 고유의 **durable
artifact·증거·의존 handoff·복구 이점이 상태/review 비용보다 큰 이유**를 근거로 남겨야 한다.
어려운 문제 자체나 파일 수·시간·모델명 기준으로 ULW를 기본값으로 쓰지 않는다. 비단순·모호한
방법 선택은 통상 native judge에 자문하지만 최종 결정은 헤드이며 추가 감독자·허가가 아니다.
[DESIGN.md의 방법별 use/avoid/ownership 표](../DESIGN.md#ulw-방법-선택과-명시적-레인-인계)와
`skill://superagent-head/references/routing.md`의 필수 절차를 따른다. 계획만이면 구현하지 않고,
execute는 선택 계획·Boulder·ledger를 유지한다. loop는 진짜 다중 목표 checkpoint 복구,
mass는 실제 의존 handoff, research는 깊은/논쟁적 증거·인용 synthesis가 필요할 때만 사용한다.
단순 대기 watchdog·독립 병렬 작업·보통 lookup/debug/context 수집에는 각각 쓰지 않는다.

헤드는 최종 dispatch 전 실제 선택 native SKILL을 읽고 레인도 선택 SKILL·필수 참조를 읽어
substantive 계약을 따른다. `lane_start`와 `lane_message`는 선택적인 실제 필드
`workflow: {name, reason}`을 받는다. `name`은 `ulw`, `mass-ulw`, `ulw-plan`, `ulw-loop`,
`ulw-execute`, `ulw-research` 중 하나이고 `reason`은 비어 있지 않은 선택 근거다.
`selectedBy: user|head`, 필요성/근거·가벼운 대안, 권위 artifact/owner, acceptance/stop,
권한 한계는 간결한 `brief`/`text` 문맥으로 남기며 추가 provenance API 필드로 만들지 않는다.
원래 저장된 허가 `sourceId`를 사용하고 기존 레인·workflow owner를 재개한다. branding만을
위해 새 레인·중복 native/durable 목표를 만들지 않는다. **모든 head→lane 인계의 workflow
선택에는 구조화된 `workflow`가 필요하다.** 사용자 원문에서 명시 선택한 방법도 헤드가 dispatch 때 이 필드로
전달해야 한다. 생략하면 일반 인계이며 복사된 사용자 호출·brief/text·보고·board 문구에서 자동
선택하지 않고 native armed라고 주장하지 않는다. 실제 원래 사용자→head 입력만 선두 호출로
선택을 유도할 수 있다. 명시 선택이 사용자 호출과 충돌하면 거부하며 입력별 선택·출처는
source/handoff에 영속 결합되어 변경·생략하는 충돌 재시도로 바꿀 수 없다.
plain ULW는 ULW를 arm하지만 전문 native mode를 선택하거나 암묵적 RPC goal을 만들지 않는다. 필요한
native goal은 레인/클라이언트의 실제 광고된 API와 기존 허가 안에서만 생성한다. head manager에
lane goal 생성 도구가 있다고 가정하지 않으며 unattended RPC continuation의 기존 opt-in도 유지한다.

공식 `omp-ulw`는 관리형 설치/업데이트 대상으로 포함하지만 설치·프로필 로드만으로 workflow가
선택되지는 않는다. 별도 공용 프롬프트 레지스트리 없이 기존 필수 head 번들·lane SKILL 경로를
유지한다. **스킬 loaded/applied, 실제 ULW/native mode armed, goal 생성은 별도 사실**이다.
runtime은 신뢰된 원래 사용자 호출 또는 구조화된 head 선택을 native 입력의 선두에 두고
`Request ID`·source metadata와 원래 작업을 보존한다. 수동 envelope 편집·삭제·재전송은 하지 않는다.
plain `ulw`는 전문 mode 없이 ULW만 arm하고, plan→`ultrathink`, execute/loop→`orchestrate`,
research/mass→`workflowz`로 연결한다. 기존 native 키워드 해석·설정은 여전히 우선하므로 이
매핑을 강제로 적용하려고 원문을 정제하지 않는다. passive 보고·board 본문은 활성화하지 않으며
request metadata·brief·report envelope는 동적으로 fence하여 native mode 선택에 끼어들지 않게
한다. 원래 source에 raw standalone lowercase native 키워드가 없을 때만 선택의 기본 native
키워드를 삽입한다. 인용·부정·inline code의 원래 키워드도 기존 bridge와 동일하게 기본값 삽입을
막으며 사용자 선택을 덮어쓰지 않는다.
보고 receipt를 근거로 한 별도 허가된 head 선택은 명시적인 `workflow` 필드를 사용한다.
dispatch 전 native `get_available_commands`의 `source: "extension"`, 정확한 명령 이름·ULW
설명으로 실제 로드된 capability를 확인한다. 조회 불가·누락은 해당 요청을 명시적으로 취소하며
일반 작업으로 조용히 fallback하지 않는다. 명령 광고는 가용성 근거일 뿐 활성화 증거는 아니고
native disable 설정·도구 gate·승인은 그대로다. local 스킬 적용만으로 실제 활성화를 주장하지
않는다. 공용 ULW 코드·`session_stop` 훅과 전역
설정은 변경하지 않는다. 새 root/설치/discovery와 실제 native activation 결과는 아래에 별도로
기록한다. 실제 plain ULW arm·goal 미생성, head 선택 plan/execute의 native mode 활성화는
관측했지만 모든 workflow·상태 조합의 무결함을 주장하지 않는다. 기존 runtime 통과 기록은
이 변경이나 실제 ULW 동작의 증거로 재사용하지 않는다.

### 공유 정보 게시판 사용

**이 superagent instance에 실제 연결·등록된 head/lane 세션만** `board_post`, `board_read`,
`board_subscribe`를 사용한다. 같은 canonical `stateDir`의 관리 기록에 대해 실제 native session
ID와 session file을 모두 검증한다. role 환경변수만으로 참여할 수 없으며 일반 OMP·다른 instance·
복사/상속 role의 별도 standalone session·native subagent는 read/post/알림 모두 불가하다. `general`과
`repo:<정규화된 절대 경로>` 채널에 관측·근거·작업 충돌만 간결하게 공유하며 전체 transcript나
비밀을 게시하지 않는다. **같은 instance의 검증된 등록 참여자**는 모든 채널을 읽을 수 있지만
다른 OMP까지 공개하는 게시판이 아니며 repo 채널 자체는 참여자 간 보안 격리가 아니다.
read/post/구독/알림마다 membership을 다시 검증한다. head는 실제 session metadata·설정된 file에
더해 Gateway 소유 `gateway:head`의 PID·session ID/file이 현재 프로세스와 일치해야 한다.
과거 session ID/file만 맞는 standalone resume 복사본은 권한이 없다. 실제 관리 head는 소유
identity가 등록된 동안 일시적 Gateway client disconnect에도 참여를 유지하고 native 프로세스의
실제 종료 확인 뒤 owner가 제거된다. 종료 요청 ACK만으로 제거하지 않는다. lane도 session ID/file·현재 generation·live state·자기 PID를
대조하므로 역할 문자열만 복사해 사용할 수
없다. 실제 연결된 paused lane은 읽을 수 있지만 closed/unloaded/stale Host는 접근할 수 없다.
시작 중 관리 binding이 아직 없으면 활성화를 안전하게 미루며 임의의 참여 기록을 생성하지 않는다.

```text
board_post({text: "Observed fact and relevant evidence", mentions: ["head"]})
board_read({channel: "general", limit: 20})
board_subscribe({channels: ["general", "repo:/absolute/repository"]})
```

위 표기는 native 도구 인자 예이며 셸 명령이 아니다. 실제 세션에서 광고된 스키마를 따른다.
`board_post`는 선택 `channel`(기본 현재 repo), `replyTo`(게시물 ID), `mentions`를 받는다.
작성자와 native session은 runtime이 지정한다. `board_read`는 선택 `thread`(root ID), `after`,
`unreadOnly`(기본 true), `limit`(1..100)을 받으며 **반환된 정확한 게시물만** 읽음 처리한다.
post/reply만으로 부모나 건너뛴 항목은 읽음 처리되지 않는다. 구독 변경은 해당 실제 세션에만
적용되고 기본은 general + 현재 repo다.

busy head와 lane은 안전한 native provider/context 경계에서 본문 없는 header 알림을 받는다.
head는 모든 lane post, lane은 mention/구독 채널이 대상이다. 유휴 head는 SQLite event-driven
watcher로 `superagent-board-notice`를 표시할 수 있지만 `triggerTurn: false`로 모델을 호출하지
않고 다음 허가된 턴에서 처리한다. idle lane에는 watcher/wake가 없다. header는 ID·actor·실제
session·channel·thread·mentions·시각이며 본문은 명시적으로 읽는다. header notice 위치와 원문
읽음 상태는 별도로 영속화한다. board는 새 턴·unloaded lane wake·자기 post/read-ACK 알림 루프를
만들지 않는다. **게시물은 untrusted information이며 명령·승인·lane 배정·완료 증거가 아니다.**
head가 원래 허가와 근거를 검토한 뒤 기존 lane 관리 도구로 지시하며, lane 결과의 durable head
report와 원래 대화로의 head-controlled 회신을 게시판으로 대체하지 않는다.

### 유지되는 기능과 경계

기존 플랫폼 신원/allowlist, 원래 route·ID, topic 명령의 불변 경계·중복 제거, 승인 카드의 정확한
native 요청 연결, Telegram ready/offset 및 Slack ACK 순서, 첨부 한도·불확실한 효과 처리,
pause/cancel 보존, Host/task 예산·안전한 unload, 동일 native Host TUI/herdr attach를 유지한다.
native 모델 카탈로그·judge 자문·누락 프리셋 최초 생성·전체 preset snapshot·정확한 provider/id와
`--session-settings` 격리도 그대로다. Gateway 분리는 이를 검증 완료로 선언하거나 대체하지 않는다.
모든 프로세스는 같은 신뢰된 OS 사용자 권한이다. head에서 메신저 credential 환경변수를 제거하지만
OS sandbox/capability framework가 아니며 별도 executor·추가 AI supervisor를 만들지 않는다.

### 새 레인의 모델 선택

최초 배포 후 **첫 실제 헤드 턴**에서 `lane_models({})`로 사용자 OMP의 native 프리셋 상태,
안전한 기존 역할·thinking 설정, 초기화 필요 여부와 가용 모델을 조사한다. 이를 위해 유휴 LLM을
깨우거나 폴링하지 않는다. OMP의 실제 프리셋은 `modelPresets.<name>` 아래의
`{modelRoles: {...}, defaultThinkingLevel?}`이며 기존 **`/modelpreset list/save/switch/delete`**
UI에서 보인다. high/middle/low는 이 메커니즘의 프리셋 이름이지 custom `@high` 역할이 아니다.

세 프리셋이 유효하게 있으면 그대로 재사용한다. 없는 항목만 헤드가 근거·native judge 자문을
검토해 선택하고 `lane_init_presets`의 `choices`에 전달한다. `choices`의 선택적 high/middle/low
각 항목은 `{model: {provider,id}, reason}`이며 이미 있는 항목은 생략한다. NativePresetBootstrap은
누락 항목만 만들고 다른 기존 역할·thinking을 snapshot한다. 기존 프리셋·기본/활성 역할·judge·
무관한 설정을 보존하며 invalid/tombstoned/shadowed 충돌을 덮어쓰지 않는다. 실제 운영자 결정이
필요한 충돌만 질문한다. 성공은 native 상태 재조회로 확인한다. 이 최초 생성만 영속 프리셋 쓰기의
예외이며 레인 생성·재개·변경 때 반복하지 않는다. 이름은 실측 성능·비용 등급 보장이 아니다.

레인에는 프리셋 전체 역할·thinking을 `Lane.modelPresetSnapshot`, 해석된 정확한 기본 모델을
`Lane.model`, 프리셋 이름(직접 모델 선택은 null)을 `modelPreset`에 저장한다. 나중에 native
프리셋을 편집해도 기존 레인을 retarget하지 않는다. **일상적인 레인 선택·변경은 OMP 전역
모델/설정 파일, 헤드 모델, 다른 레인을 바꾸거나 인증 구성을 다시 쓰면 안 된다.** 기존 native
auth DB의 정상 자격 증명 갱신은 유지하므로 OMP 아래 모든 파일의 바이트 불변을 주장하지 않는다.

작고 명확한 메인 대화 작업은 헤드가 직접 처리한다. 레인을 만들거나 비교를 위한 judge 호출을
강제하지 않는다. 실질적인 새 레인 모델 선택과 역량·위험·브리핑의 모호한 판단에는 헤드가
근거를 먼저 조사하고 **기존 native `eval`의 `judge`/`judge_batch` 자문을 통상 사용한 뒤 최종
모델을 직접 선택**한다. 별도 평가 엔진·슈퍼바이저·모니터링 LLM을 추가하지 않는다.

1. `lane_models`의 native 프리셋 상태·안전한 역할/thinking과 현재 광고된 역할 selector 또는
   관측한 정확한 `provider/id`로 후보를 조회한다. 관측된 native 프리셋의 실제 해석을 사용하며 조회 과정에서
   프리셋을 다시 쓰지 않는다. native `@default`·`@smol`·`@slow` 같은 별칭은 운영자가 설정한
   역할이며 저가·고성능 등급이 아니다. 같은 모델로
   해석될 수 있고 사용 불가 해석은 `resolutions[].model:null`이다. 후보는 authoritative RPC의
   enabled-model 범위와 교차하며 judge/tiny 등 특수 실행 모델은 레인 후보에서 제외한다.
2. 실제 작업의 입력 형식·필요 맥락·추론/도구 요구·검증 부담·실패 영향·운영자 예산을 근거에서
   추린다. 후보의 안전한 `provider`, `id`, `name`, `input`, `contextWindow`, `maxTokens`,
   `reasoning`, `supportsTools`, `cost`만 필요한 만큼 judge에 전달한다. 도구가 필요한 과제에서
   명시적인 `supportsTools:false`는 역량 불일치이고 필드 누락은 미상이다. chat 후보라는 이유만으로
   tool 지원을 추정하지 않는다. 전체 대화·비밀·헤더·endpoint·토큰은
   전달하지 않는다. 카탈로그 가격·속성은 실측 속도·품질·쿼터·성공 보장이 아니며 누락은 미상이다.
3. 한 작업의 독립 질문은 `judge(state, questions)`, 여러 독립 작업 비교는 native 계약에 맞는
   `judge_batch`로 묶고 이벤트로 결과를 받는다. 폴링하지 않는다. 정확한 choice/bool/score 형식과
   동적 후보 예제는 `skill://superagent-head/references/model-selection.md`를 따른다.
4. 헤드가 권고를 비판적으로 검토해 `lane_start`에 정확한 `model: {provider,id}` 또는
   `preset: string`(관측한 native 프리셋 이름) 중 **정확히 하나**와 필수 `modelReason`을 전달한다.
   high/middle/low 외의 기존 native 프리셋 이름도 가능하다.
   둘 다/둘 다 없음은 허용하지 않는다. 이유에는 근거 있는 역량/비용 절충과 필요시 자문과 다른 선택,
   비교 생략·실패 사유를 간결한 결정 근거로 남기며 내부 사고 과정을 요구하지 않는다.
   단일 강제/명시적 허가 모델이나 사소한 라우팅이면 무의미한
   비교는 생략하고 이유를 밝힌다. 권고는 최종 결정·지출 허가·새 작업 권한·검증 증거가 아니다.

judge가 없거나 실패하면 이를 밝히고 native fallback만 따른다. 헤드는 기존 권한 내에서 근거를
밝혀 사용 가능한 모델을 선택하며, 실제 예산/역량 절충을 운영자가 결정해야 할 때만 native
`ask`를 사용한다. 자문을 위해 `modelRoles`·fallback·timeout·전역 설정을 변경하거나 제외된
도구를 켜거나 custom provider 엔진·추가 제공자 결제를 사용하지 않는다. 성공하지 않은 호출을
성공했다고 쓰지 않는다. judge 사용량의 원본은 native purpose `judge` 사용량이지 자체 영수증이 아니다.

**스킬 정책과 runtime 강제를 구분한다.** 자문 사용은 헤드 지침이며 코드가 모든 `lane_start`에
judge 호출·영수증을 강제하거나 생성하지 않는다. 코드는 사용 가능한 정확한 모델과 비어 있지 않은
`modelReason`, 저장된 모델 동일성을 검사한다. 선택은 unload·재개·헤드 재시작에도 유지하며,
다른 모델로 재사용하거나 사용 불가·native 모델 drift가 생기면 자동 대체하지 않고 보류한다.
이는 암묵적 재사용·기본값·프리셋 수정으로 선택을 바꾸지 않는다는 계약이지 영구 변경 금지가 아니다.
운영자가 명시적으로 허가한 유휴 레인 변경은 `lane_set_model`로 수행한다. 필드는 `id`, 실제 저장된
허가 입력의 `sourceId`, 정확히 하나의 `model`/`preset`, 필수 `modelReason`이다. 실행 중 입력·native
UI·goal·소유 서비스·보류된 입력 불확실성이 없어야 하며, 자동 interrupt나 승격을 하지 않는다.
헤드는 실제 상태와 역량/예산 영향을 확인하고 대상 레인만 새 정확한 모델·이유 snapshot으로
바꾼다. durable intent/receipt와 native readback으로 결과를 확인하며 접수만으로 성공을 선언하지
않고 불확실한 결과를 맹목 재시도하지 않는다. 전역 OMP 모델/설정·`modelRoles`·인증 구성을 다시 쓰거나
다른 레인을 바꾸는 방법을 사용하지 않는다.
모델 변경은 일시정지·불확실한 입력을 해제하거나 새 작업·재실행을 허가하지 않는다.
이는 이 연동이 자동 모델 승격을 추가하지 않는다는 뜻이다. 기존 OMP의 native fallback·재시도·
사용량 정책은 그대로 적용되며 하위 재시도가 다른 설정 모델을 절대 쓰지 않는다는 보장은 아니다.
runtime은 관측한 identity drift를 다음 dispatch 전에 보류하고 저장된 선택을 몰래 다시 쓰지 않는다.
`lane_inspect({"id":"…"})`의 저장 `model`/`modelPreset`/`modelPresetSnapshot`/`modelReason`, 실제 연결된 `state.model`,
`modelCheck.expected`/`actual`/`error`를 구분한다. 실제 상태가 null이면 일치가 아니라 관측 불가다.
선택 기록 이전의 레인은 기존 native 세션 모델을 채택하고, 세션 기록 없이 한 번도 시작하지 않은
기존 레인만 현재 헤드 모델을 한 번 채택한다. 이는 judge 선택으로 소급하지 않으며 이유에 구분한다.
레인은 스스로 모델 정책을 바꾸지 않고 역량 불일치 근거를 기존 보고 흐름으로 헤드에 돌려준다.
자동 이벤트는 고비용 승격이나 새 작업을 허가하지 않는다. native `task`의 광고된 모델 정책은
별개이며 레인의 선택을 바꾸지 않는다. 운영자의 도구 제외와 자식 관리 도구 거부는 그대로다.

모든 관리 Host와 TUI attach replica(헤드 포함)는 native `--session-settings`/`Settings.overlay`로
일상적인 startup·RPC·TUI의 모델/default/fallback 변경을 private in-memory 설정에만 적용한다.
`--model-preset` 시작과 RPC `set_model_preset`은 별도 엔진이 아니라 실제 native 프리셋 helper를
overlay에 적용한다. 세션 모델 변경 transcript는 정상적으로 남는다. 최초 누락 프리셋 생성 도구만
위의 영속 쓰기 예외다. 기존 인증·judge 설정과 auth DB의 정상 갱신은 그대로 사용하고 shadow
credential을 만들지 않는다. 특정 레인에서 high를 선택하는 일은 전역 프리셋이나 `modelRoles`를
다시 쓰는 동작이 아니다. 이 경계의 새 native runtime·model-selection 관측 결과는 아래 표를 따른다.

## 1. 로컬 준비 — 봇은 시작하지 않음

필요 조건은 Git, **Bun >= 1.4.4**, 로컬 Unix socket을 지원하는 환경이다.
소스 OMP는 네이티브 addon도 필요하다. 소스에서 addon을 빌드하려면 Rust/Cargo와
플랫폼 네이티브 빌드 도구가 필요하다. OMP는 `v18.20.0`,
`c308970263ae13744ea15ab67302e3dac840e266`에 고정한다.

저장소 루트에서 실행한다. 루트 의존성은 `link:.upstream/omp/packages/coding-agent`이므로
**prepare를 루트 install보다 먼저** 실행해야 한다. 시스템 Bun이 조건 미달이면 아래의
선택적 로컬 도구 준비부터 실행한다.

```sh
bun scripts/prepare-omp.ts
bun install --frozen-lockfile
bun --cwd=.upstream/omp run build:native
```

prepare는 고정 OMP를 `.upstream/omp`에 준비하고 `patches/omp` 패치를 적용한 뒤
상위 workspace 의존성을 설치한다. 이미 다른 revision인 checkout은 덮어쓰지 않고 거부한다.
패키지 설치만으로 소스 CLI에 필요한 native addon이 준비되었다고 가정하지 않는다.
`build:native`는 해당 workspace에 addon을 빌드하는 명령이며 봇을 시작하지 않는다.
상위의 `bun setup`은 전역 `omp` 링크까지 변경하므로 여기서는 사용하지 않는다.

시스템 Bun을 바꾸지 않으려면 선택적으로 격리된 로컬 도구를 사용한다.
이하 `bun` 명령과 설정의 Bun 경로는 이 도구를 가리키게 한다.

```sh
npm install --prefix .upstream/toolchain --no-save bun@1.4.4
export PATH="$PWD/.upstream/toolchain/node_modules/.bin:$PATH"
```

이는 현재 셸의 PATH만 바꾼다. 전역 설치·기존 OMP 교체·자동 시작 등록은 필요 없다.
모델 제공자 인증은 기존 OMP 방식으로 별도 준비한다. 이 프로젝트가 인증 엔진을 대체하지 않는다.
현재 통합 검증에는 프로젝트 로컬 Bun 1.4.4와 버전이 일치하는 캐시 native addon을 별도 준비해
사용했다. 위 native 빌드 명령을 실제 실행했다는 뜻은 아니다. 기존 전역 Bun과 설치 OMP 18.20.0은
교체하지 않았다. 새 개발 환경에서는 전역 캐시에 의존하지 말고 addon을 별도로 준비한다.

### 필수 관리형 omp-ulw 설치와 갱신

설치에는 공식 [dbc-hbin/omp-ulw](https://github.com/dbc-hbin/omp-ulw)가 항상 포함된다.
`bun scripts/prepare-omp.ts`는 OMP와 함께 ULW를 준비하고, 루트 `bun install`의 postinstall도
ULW 준비를 수행한다. ULW만 명시적으로 준비하거나 다시 확인할 때는 다음을 사용한다.

```sh
bun run prepare:ulw
```

설정은 `upstream/ulw.json`의 공식 원격과 `checkIntervalMs: 3600000`(1시간)이다. 설치 때 원격의
**기본 브랜치 HEAD**를 확인한다. production Gateway 시작에는 이미 유효한 active 설치가
필요하다. 이를 확인하면 IPC/head를 먼저 시작하고 startup 원격 확인은 백그라운드로 수행하며,
이후 매시간 새 커밋을 확인해 준비·활성화한다. 느리거나 접근 불가능한 upstream 때문에 정상
active가 있는 Gateway 시작을 기다리게 하지 않는다. 이는 일반 코드의 업데이트 확인이지 모델 watchdog·작업 레인 실행이나
메신저 봇 로그인 허가가 아니다. Git·의존성 다운로드에 네트워크가 필요하며 사용자 ULW checkout,
전역 OMP 설치·설정, 공유 ULW 프롬프트 원본은 수정하지 않는다.

각 commit은 이 프로젝트 소유 `.upstream/ulw/revisions/<commit>/package`에 따로 준비한다.
필요한 소스·submodule을 materialize하고 의존성 설치의 임의 lifecycle script는 실행하지 않는다.
정해진 준비 절차와 유한한 offline native loader probe가 성공한 뒤에만 `active.json`을 원자적으로
전환한다. SQLite update lock으로 동시 준비를 직렬화하고 `status.json`에 확인/오류 상태를 남긴다.
stage·의존성·probe 실패는 이전 active revision을 보존하며 업데이트 성공으로 표시하지 않는다.
기존 active가 있으면 같은 공식 원격에서 **fast-forward인 commit만** 자동 활성화한다. 기본
브랜치 force-push에 따른 rewind·divergence나 source repository 불일치는 이전 active를 유지하고
오류로 보고한다. 최초 설치는 그때 공식 원격이 광고한 HEAD를 사용하며 가짜 고정 hash를 만들지
않는다. source/이력 충돌은 운영자 조정 대상이지 자동 pointer 재작성·강제 덮어쓰기 사유가 아니다.
이전 revision은 자동 삭제하지 않는다. 관리 파일/lock을 수동 편집해 실패를 우회하지 않는다.
처음 준비에 실패했거나 active 설치가 누락/무효라면 `start`가 어댑터를 활성화하기 전에 실패하고
`bun run prepare:ulw` 선행을 요구한다. `start` 안에서 긴 네트워크 설치를 시도하거나 ULW 없는
실행으로 fallback하지 않는다. `doctor`는 기존 로컬 진단이며 ULW 원격 최신성이나 native loader
성공을 확인하지 않는다.

설치 상태만 네트워크 없이 읽으려면 다음을 사용한다.

```sh
bun run prepare:ulw -- --status
```

Gateway 상태 응답의 `ulw`는 `revision`, `packagePath`, `upstreamRevision`, `checkedAt`,
`error`, `updating`을 구분한다(`injected`는 테스트용 주입인 경우에만 표시). `revision`과
`packagePath`는 **다음 새 Host가 사용할 active package**이며 실행 중 모든 Host의 버전이 아니다.
`upstreamRevision`은 마지막 확인한 원격 결과이고 `checkedAt`·`error`·`updating`과 함께 읽는다.
원격 조회 실패·미확인을 최신 일치로 표시하지 않는다. 현재 각 Host의 정확한 경로는 그 Host의
`OMP_SUPERAGENT_MANAGED_ULW_PATH` 환경에 고정되며 별도 공개 current-Host revision 필드는 없다.

**실행 중 Host의 revision과 다음 Host의 revision은 다를 수 있다.** 이미 실행 중인 head/lane은
자신이 로드한 정확한 package 경로를 유지하며 업데이트 때문에 재시작·hot reload하지 않는다.
각 새 Host 시작은 그 시점의 active package를 해석한다. 따라서 오래 실행된 head가 나중에 새
lane을 시작해도 head의 과거 ULW 경로를 새 lane에 강제로 상속하지 않는다. 기존 Host attach는
같은 실행을 보는 것이지 새 revision 적용이 아니다. 설치·업데이트 성공은 native workflow 선택,
mode 활성화·goal 생성·실제 모델 응답의 검증과 별개다.

## 2. 플랫폼별 앱과 접근 범위

사용할 플랫폼만 준비한다. 토큰은 **환경변수로만** 전달하며 JSON, argv, 저장소에 쓰지 않는다.
`tokenEnv`·`botTokenEnv`·`appTokenEnv`에는 토큰 자체가 아니라 환경변수 이름을 넣는다.

### 2.1 Discord

1. [Discord Developer Portal](https://discord.com/developers/applications)에서 앱과 Bot을 만든다.
   Bot 설정의 **Privileged Gateway Intents → Message Content Intent**를 켠다.
   서버 메시지 본문을 수신하려면 코드의 intent 요청과 포털 설정이 모두 필요하다.
2. 운영할 서버에 bot을 초대한다. 필요한 채널에 View Channel, Read Message History,
   Send Messages, Send Messages in Threads, Create Public Threads, Attach Files 권한을 부여한다.
   비공개 스레드 등은 봇이 실제로 접근할 수 있어야 한다. 관리자 권한은 요구하지 않는다.
3. Discord 개발자 모드로 소유자 **사용자 ID**, 서버 ID, 허용할 **부모 채널 ID**를 복사한다.
   이름·멘션 문자열이 아니라 숫자로 된 ID 문자열을 설정한다.
4. `ownerId` 한 명만 입력·승인 권한을 가진다. 다른 사용자, 봇, webhook 입력은 받지 않는다.
   서버 입력은 `allowedGuildIds`와 `allowedChannelIds`를 **모두** 통과해야 한다.
   스레드는 부모 채널 allowlist를 따른다. 빈 배열은 모든 서버 허용이 아니라 서버 입력 차단이다.
   소유자의 1:1 DM은 서버 allowlist와 별개이며 그룹 DM은 대상이 아니다.

```sh
read -r -s DISCORD_BOT_TOKEN
export DISCORD_BOT_TOKEN
```

위 입력은 Bash에서 토큰이 화면과 명령 이력에 노출되지 않게 받는 예다.
프로세스는 현재 사용자 권한과 환경을 사용한다. 레인과 worktree는 보안 샌드박스가 아니다.

### 2.2 Telegram

1. 공식 [BotFather](https://core.telegram.org/bots/features#botfather)에서 봇을 만들고 받은 토큰을
   `TELEGRAM_BOT_TOKEN` 같은 환경변수에 보관한다. 소유자가 먼저 봇의 private chat을 시작한다.
2. `ownerId`에는 **양수 숫자 사용자 ID 문자열**, `allowedChatIds`에는 허용 그룹/supergroup의
   **음수 chat ID 문자열**(예: 실제 `-100…` ID)을 넣는다. 이름·전화번호·username은 ID가 아니다.
   소유자의 private chat은 별도로 허용되며 빈 배열은 그룹 입력 차단이다.
   허용된 그룹에서도 설정 소유자의 직접 메시지만 받으며 익명 관리자 `sender_chat`, 봇,
   전달 메시지, via-bot·business 입력을 운영자 권한으로 인정하지 않는다.
3. 그룹의 일반 메시지까지 처리하려면 봇이 그 내용을 볼 수 있어야 한다.
   [Privacy Mode](https://core.telegram.org/bots/features#privacy-mode)를 BotFather에서 조정하거나
   봇의 관리자 가시성을 명시적으로 구성한다. Privacy Mode가 켜져 있으면 일반 메시지 전체가
   전달된다고 가정하지 않는다. 설정 변경 후 그룹 재추가가 필요한지는 Telegram 안내를 따른다.
4. native forum topic은 forum을 켠 supergroup에서 사용한다. 새 topic 생성에는 봇의 관리자
   **`can_manage_topics`** 권한이 필요하고 메시지·문서 전송도 허용되어야 한다.
   실제 `message_thread_id`로 레인을 분리한다. private chat은 기본적으로 `/new`·`/main`의
   논리 주제를 사용하며, Telegram이 `getMe.has_topics_enabled`를 제공하는 봇은 실제 private
   topic도 지원한다. 일반 그룹에 가짜 forum/thread ID를 만들지 않는다.
5. 시작 시 grammY `getMe`로 봇을 확인하고 `getWebhookInfo`를 확인한 뒤 `getUpdates` long polling을
   사용한다. public endpoint는 필요 없다. **기존 webhook이 있으면 시작을 거부하며 자동 삭제하지
   않는다.** 기존 webhook/polling 소비자와 함께 실행하지 말고 운영자가 명시적으로 전환한다.
   인증 완료만으로 polling을 시작하지 않으며 runtime의 시작 시 승인 조정이 완료된 뒤 수신을
   연다. 이 준비가 실패하거나 기다리는 중 stop되면 offset/ACK를 진행하지 않고 수신을 멈춘다.

```sh
read -r -s TELEGRAM_BOT_TOKEN
export TELEGRAM_BOT_TOKEN
```

[Bot API](https://core.telegram.org/bots/api#getupdates)·[grammY API](https://grammy.dev/guide/api)를
사용한다. 업데이트는 Gateway가 원본 이벤트를 durable admission한 뒤 다음 offset을 저장하며,
그 offset을 사용한 다음 polling에서 Telegram 측 확인이 진행된다. Bot API에는 대화 history나
임의 `getMessage` 조회가 없다. 복구는 저장한 offset과 Telegram의 **최대 24시간 업데이트 보존**에
한정되고, 임의의 과거 대화·기한이 지난 업데이트·옛 메시지 수정/삭제를 복원할 수 없다.
마지막으로 접수한 업데이트의 관측 시각도 영속화한다. 업데이트 없이 24시간 이상 지났거나
관측 시각이 없거나 잘못되었거나 시계가 뒤로 이동하면 오래된 offset을 다음 요청에서 생략한다.
이는 [일주일 이상 유휴 시 update_id가 임의 재설정되는 동작](https://core.telegram.org/bots/api/types/update.md)에
대비한 처리이지 history 복원이 아니다. 유휴 구간을 넘어 update_id가 계속 증가한다고 가정하지
않으며, 재전달은 안정적인 메시지 ID와 callback-query ID로 구분한다.

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
   | 공개/비공개 채널·1:1 DM 확인 | `channels:read`, `groups:read`, `im:read` |
   | 알려진 대화·스레드 복구와 승인 카드 확인 | `channels:history`, `groups:history`, `im:history` |
   | 첨부 확인·다운로드, 긴 출력 업로드 | `files:read`, `files:write` |

3. Event Subscriptions를 켜고 bot events **`message.channels`**, **`message.groups`**, **`message.im`**을
   구독한다. Interactivity도 켠다. 이벤트와 Block Kit 버튼·모달은 Socket Mode로 받아
   public Request URL/웹 서버가 필요 없다. **Slack Slash Commands는 등록하지 않는다.**
4. `teamId`는 `T…` workspace ID, `ownerId`는 그 workspace의 활성 인간 사용자 `U…`/`W…` ID,
   `allowedChannelIds`는 `C…`/`G…` 채널 ID 문자열이다. 앱을 허용 채널에 초대한다.
   시작 시 `auth.test`의 bot/workspace와 `users.info`의 소유자를 확인한다.
   다른 workspace·사용자·봇·앱 입력은 받지 않고, 소유자의 1:1 DM만 채널 allowlist와 별도로
   허용한다. 그룹 DM은 지원하지 않는다. 빈 배열은 workspace 채널 입력 차단이다.
5. Slack 일반 메시지에서는 **`!new [요청]`, `!main`, `!stop`, `!resume`**을 사용한다.
   어댑터가 공통 runtime 제어로 정규화한다. Slack composer가 `/new` 등을 가로챌 수 있으므로
   Discord·Telegram의 `/` 표기를 Slack 명령으로 안내하지 않는다.

```sh
read -r -s SLACK_BOT_TOKEN
read -r -s SLACK_APP_TOKEN
export SLACK_BOT_TOKEN SLACK_APP_TOKEN
```

공식 [Socket Mode SDK](https://docs.slack.dev/tools/node-slack-sdk/socket-mode/)와
[Web API SDK](https://docs.slack.dev/tools/node-slack-sdk/web-api/)를 사용한다.
스레드 조회는 현재 공식 [conversations.replies](https://docs.slack.dev/reference/methods/conversations.replies/)
문서의 bot history scopes를 따른다. bot token이면 채널 스레드를 무조건 조회할 수 없다는
과거 제한을 전제로 하지 않는다. 실제 접근 권한·workspace 보존 정책·API rate limit은 여전히 적용된다.

## 3. 설정

`config.example.json`을 `config.local.json`으로 복사하고 **모든 경로와 REPLACE 값**을 바꾼다.
예시에는 플랫폼별 블록이 하나씩 있다. **사용하지 않을 블록은 삭제**하고 최소 하나를 남긴다.
남긴 모든 블록의 ID 자리표시자는 의도적으로 유효한 플랫폼 ID가 아니므로 치환 전에는 시작할 수
없다. Discord만 있던 기존 설정도 그대로 유효하다. 토큰 자체를 넣는 필드는 없다.
high/middle/low는 최초 배포 후 첫 실제 헤드 턴에서 기존 OMP 설정을 조사해 native 메커니즘으로
누락 항목만 초기화한다. 이 설정 파일에 별도의 프리셋 블록을 추가하지 않는다.

| 필드 | 의미 |
| --- | --- |
| `command` | 패치된 OMP 실행 argv 배열. 셸 문자열이 아니며 셸 변수·`~`를 확장하지 않는다. 소스 CLI는 Bun 실행 파일과 `.upstream/omp/packages/coding-agent/src/cli.ts`의 절대 경로를 사용한다. |
| `stateDir` | 현재 사용자 소유의 짧은 전용 경로. 소켓·SQLite 장부·세션·로그·첨부를 보관한다. 공유/심볼릭 링크 디렉터리는 쓰지 않는다. socket 경로가 100바이트를 넘으면 거부한다. |
| `headCwd` | 실제 존재하는 헤드 작업 디렉터리. 레인의 cwd는 검증된 작업 범위에 따라 별도로 정한다. |
| `maxHosts` | 헤드 1개를 포함한 상주 Host 예산. 필수 정수, 최소 2. 초과 작업은 대기한다. |
| `maxSubagents` | 전체 Host에 분배할 네이티브 task 동시성 예산. 필수 정수, `maxHosts` 이상. Host별 한도는 `floor(maxSubagents / maxHosts)`다. |
| `idleMs` | 안전하게 정착한 유휴 레인을 회수하기까지의 시간(밀리초). 필수 0 이상 정수. 헤드는 대상이 아니며 세션 기록은 삭제하지 않는다. |
| `model` | 선택 항목. 헤드 시작에 사용할 OMP 모델 식별자. 생략 시 기존 OMP 설정을 따른다. 모든 새 레인의 기본값이 아니며 새 레인은 `lane_start`의 model 또는 preset으로 각각 선택한다. 재개는 저장된 레인 선택을 유지한다. |
| `discord` | 선택 블록. 존재하면 `tokenEnv`, `ownerId`, `allowedGuildIds`, `allowedChannelIds` 모두 필수. |
| `telegram` | 선택 블록. 존재하면 `tokenEnv`, `ownerId`, `allowedChatIds` 모두 필수. 그룹 chat ID의 음수 부호를 보존한다. |
| `slack` | 선택 블록. 존재하면 `botTokenEnv`, `appTokenEnv`, `ownerId`, `teamId`, `allowedChannelIds` 모두 필수. |

상태·cwd 상대 경로는 설정 파일 기준이지만 `command` 인수의 상대 경로는 그렇게 변환되지 않는다.
실행 cwd가 달라도 동작하도록 command에는 절대 경로를 권장한다.
직접 재빌드한 패치 바이너리를 쓸 때는 `command`를
`["/absolute/path/to/patched-omp"]`로 바꿀 수 있다. **일반 설치 OMP는 대체재가 아니다.**

예제의 `maxHosts: 4`, `maxSubagents: 8`, `idleMs: 300000`은 운영자가 조정하는 예시이며
하드코딩된 기본값이 아니다. 이 예에서는 헤드 외 최대 3개 레인과 Host별 task 동시성 2를
예산으로 잡는다. 이는 CPU·메모리·토큰 비용·디스크 할당량의 강제 제한이 아니다.
저장 기록과 다운로드 파일의 보존·디스크 사용량은 운영자가 관리한다.

## 4. 명령과 일상 사용

모든 관리 명령에 `--config FILE`이 필요하다. 먼저 봇을 시작하지 않는 진단을 실행한다.

```sh
bun src/cli.ts doctor --config config.local.json
bun src/cli.ts status --config config.local.json
```

`doctor`는 설정과 OMP `--help`의 `--rpc-socket` 지원을 확인한다. `platforms`에 설정된 플랫폼,
`credentials`에 환경변수 이름별 **존재 여부 boolean**, `messengersActivated: false`를 출력한다.
토큰 값이나 과거 Discord 전용 `discordTokenPresent`/`discordActivated` 필드를 출력하지 않는다.
봇 로그인·모델 인증·attach UI 성공을 검증하지 않는다.
`status`는 장부의 레인·소켓 경로와 Gateway/head 준비 단계를 구분해 출력한다. 기록만으로
실제 생존·정확한 소유권·작업 완료를 보장하지 않는다.

| 상태 필드 | 의미 |
| --- | --- |
| `gateway.ready` | Gateway 실제 transport 인증·준비 상태 |
| `gateway.admissionReady` | 최초 head의 native 승인 복구 barrier를 통과해 durable 수신을 열었는지 |
| `gateway.unresolvedEvents` | 안전한 접수/답변 복구를 기다리는 미해결 ingress 수. 모호한 입력을 거부/완료로 버리지 않음 |
| `head.pid` | native head 프로세스 식별자. controller/adapter 준비나 작업 완료와 다름 |
| `head.ready` | head controller gate 준비 상태. 미해결 admission이 안전한 복구를 기다리는 동안 false 유지 |
| `head.connected` | Gateway와 head client의 연결 상태 |

최초 admission barrier를 통과한 Gateway는 이후 head 부재에도 durable admission을 유지한다.
`head.ready`/`head.connected`가 내려갔다고 이미 열린 수신을 잃거나 모델을 폴링하지 않는다.

**다음 start만 설정한 모든 어댑터의 활성화를 명시적으로 요청한다.** 설치·prepare·doctor는
start를 대신하지 않는다. 실제 자격 증명으로 실행하면 설정된 Discord·Telegram·Slack 모두에 연결한다.

```sh
bun src/cli.ts start --config config.local.json
```

start는 **detached Gateway를 먼저 실행**하고 Gateway가 지정 head 하나를 시작하거나 소유권이
확인된 기존 head에 연결한다. 소켓·로그와 준비 상태 출력은 운영 플랫폼 로그인·실제 모델 호출의
영수증이 아니다. CLI가 출력한 Gateway/Host 로그에서 해당 단계의 실제 오류·상태를 구분한다.
Gateway 로컬 endpoint는 `<stateDir>/run/gateway.sock`, 실제 어댑터·감독 로그는
`<stateDir>/logs/gateway.log`다. native head 로그와 transport 로그를 혼동하지 않는다.
이 작업에서는 어떤 실제 메신저 계정도 활성화하지 않았다.
Gateway는 실제 어댑터와 메신저 credential을 소유한다. head가 없을 때도 준비된 Gateway는 원본
수신을 ACK 전에 저장하고 소유권/종료를 확인한 후 head를 복구해 순서대로 재전달한다.
수신 receipt의 `accepted`는 head의 durable admission 완료이고 `rejected`는 명시적 확정
거부다. 임의의 handler/store/종료 오류는 거부로 확정하지 않고 미해결 pending으로 유지하며
최대 30초의 capped reconnect backoff로 복구를 시도한다. 지속적으로 모호한 native 답변은
pending 순서를 유지하며 `gateway.unresolvedEvents`에 남고 `head.ready`는 false다. 모든
문제 입력이 자동 복구된다는 보장이 아니며 맹목 replay나 유실 처리로 준비 상태를 만들지 않는다.
플랫폼 ACK·Gateway 보존·head 접수·실제 실행·완료는
별개다. 접수 재전달은 불확실한 작업이나 외부 효과의 맹목 재실행이 아니다. 임의의
오래된 socket을 삭제하거나 생존 불명 Host의 두 번째 writer를 만들지 않는다.
복구에는 저장 native PID·session ID·session file·socket inode의 정확한 대조가 필요하다.
저장 PID의 실제 종료가 확인된 뒤에만 다시 시작하며 stale socket도 저장한 owned inode와
일치할 때만 제거한다. 알 수 없거나 교체된 socket, 살아 있는 PID의 잘못된/관측 불가 identity,
launch 이후 durable ownership 기록 전 crash는 운영자 조정 전까지 보류한다. 보편적인 자동
crash 복구를 보장하지 않는다. 기존 head transcript 재시작에는 `config.model`을 다시 적용하지
않는다. status의 `head.ready`는 controller 준비만 뜻하며 native PID/identity나 Gateway 어댑터
준비·실제 플랫폼 로그인 성공과 구분한다.
**일반 DM·허용 채널·새 스레드·forum topic·기존 레인의 모든 후속 입력이 먼저 헤드로 간다.**
헤드는 주제 바인딩을 맥락으로 보고 새 작업은 `lane_start`, 기존 작업 지시는 `lane_message`로
명시적으로 보낸다. 레인 생성만으로 이미 접수된 후속 입력을 자동으로 옮기지 않는다.
lane 결과는 durable report로 head에 들어오며 메신저에 직접 발송하지 않는다. 외부 회신은 head의
답변 또는 명시적으로 head가 통제하는 delivery만 사용하고 원래 route를 보존한다.
별도 슬래시 명령 등록은 하지 않는다. 다음은 Discord·Telegram에 보내는 **일반 텍스트 명령**이며
Slack에서는 같은 위치에 `!new`·`!main`을 사용한다.

| DM 입력 | 동작 |
| --- | --- |
| `/new 요청 내용` | 실제 DM 채널을 바꾸지 않고 독립 논리 주제를 열어 활성화. 헤드가 저장소를 선택한 뒤 그 주제의 레인을 연결 |
| `/new` | 빈 주제만 활성화하고 요청 내용을 묻는 고정 안내를 한 번 회신. 이 명령만으로 모델 호출·레인 시작은 하지 않음 |
| 일반 후속 메시지 | 선택된 주제·기존 lane 정보를 담아 head로 전달. head가 필요한 업무만 명시적으로 lane에 전달 |
| `/main` | 앞으로의 입력 맥락을 메인 대화로 돌림. 모든 입력은 원래도 head 경유이며 이전 주제·레인은 보존 |

헤드는 이미 제출받은 일반 DM 작업도 `lane_start`로 독립 주제에 인계할 수 있다.
원래 헤드 요청의 소유권은 유지하고 별도 handoff를 만들며 이후 DM 입력은 새 주제를 따른다.
서버를 만들 필요는 없고, 명시적으로 허용된 서버 스레드 목적지를 지정하는 인계도 가능하다.
그룹·workspace 채널 대화에서 `/new`(Slack `!new`)는 새 스레드/topic 사용 안내를 보내며
OMP 자체 `/new`로 전달하지 않는다. 연결된 레인 대화의 `/stop`, `/resume`
(Slack `!stop`, `!resume`)은 각각 일시정지·명시적 재개 제어다.
이미 접수된 `/new`·`/main` 제어 메시지를 수정해도 기존 경계·작업·현재 주제는 바뀌지 않으며,
기록과 고정 안내만 남기고 새 메시지로 제어하도록 요청한다. Slack의 `!` 제어도 같은 정책이다.
일반 작업 메시지 수정은 새 입력 revision이며 이미 실행된 외부 효과를 취소하지 않는다.
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

| 플랫폼 | 승인·질문 UI와 실제 한계 |
| --- | --- |
| Discord | 버튼·선택·모달. 원래 요청·메시지·세션에 묶인 응답만 수락. 실제 승인 답변은 durable 접수 뒤 ACK하며 단순 handler 진입을 접수 성공으로 보지 않음 |
| Telegram | inline 버튼과 **정확한 활성 봇 카드에 대한 답장**으로 input/editor·ask 자유 입력. 카드 4,096 UTF-16 단위, 100행 이하, 버튼 label 64 UTF-16 단위 이하, callback_data 64바이트 이하. ask의 진행·답안을 영속화하며 재시작 시 같은 카드를 편집해 API 응답 신원을 확인. 단순 캐시를 readback으로 간주하거나 불확실한 카드를 새로 만들지 않음 |
| Slack | Block Kit 버튼·최대 100개 옵션 select·input/editor/ask 자유 입력 모달. label·옵션 설명 75자, 입력 3,000자, placeholder 150자 이하. 카드 50 blocks·39,000자·semantic content 100 KiB 이하. 원래 workspace·사용자·카드 및 모달 ID/metadata를 확인 |

비밀 입력 또는 해당 플랫폼이 온전히 표현할 수 없는 native dialog는 잘라내거나 임의 답변하지
않고 native 요청을 취소한 뒤 로컬 OMP UI 사용을 안내한다. 메신저 응답은 비밀 입력 경로가 아니다.
Telegram은 인증한 승인 카드의 account·실제 chat/thread·메시지 ID 표식을 영속화한다.
닫거나 취소한 카드도 내용 없는 tombstone을 남겨 버튼 제거·재시작·주제 전환 뒤의 늦은 답장이
새 작업으로 접수되지 않게 한다. 닫힌 dialog의 별도 진행 메타데이터에서는 부분 ask 선택·자유
입력 답안을 제거한다. 이는 원래 native 세션이나 이미 접수된 기록 전체를 삭제한다는 뜻은 아니다.

```sh
bun src/cli.ts attach main --config config.local.json --read-only
bun src/cli.ts attach LANE_ID --config config.local.json
bun src/cli.ts stop LANE_ID --config config.local.json
bun src/cli.ts stop main --config config.local.json
```

`LANE_ID`는 status에서 확인한 실제 값으로 바꾼다. target 생략 시 main이다.
attach는 같은 Host의 클라이언트이며 두 번째 `--resume` 기록 프로세스가 아니다.
네이티브 TUI attach의 로컬 PTY 통과 근거는 아래 표를 따른다. herdr pane에서도 동일한 attach
명령을 사용할 수 있지만 **herdr 사용자 흐름은 아직 미검증**이다. pane을 닫는 것과 Host를
중지하는 것은 다르다.
`stop LANE_ID`는 해당 Host의 안전한 종료 요청이며 바쁜 Host는 거부한다. `stop main`은 감독 대상
head와 Gateway의 명시적 종료이며 Gateway가 head를 즉시 재기동하지 않는다. 강제 종료나 기록
삭제가 아니고 기존 busy-host 보호를 유지한다. 전체 레인 일괄 중지는 아니므로 레인은 각각 확인한다.
Gateway가 native 종료 요청을 바쁨으로 거부받으면 서비스를 유지한다. 성공적인 명시적 중지에서는
native shutdown 전에 supervisor의 재기동을 억제해 의도한 종료를 crash로 오인하지 않는다.
shutdown ACK는 프로세스 종료나 슬롯 반환이 아니다. native 프로세스의 실제 종료를 확인한 뒤에만
소유권·Host 예산을 해제한다. RPC disconnect·기존 PID 종료·socket 부재를 대조하며 하나라도
관측 불가면 보류한다.
head의 Gateway client detach나 TUI 종료는 transport stop이 아니다. launchd/systemd 서비스
설치·자동 시작 등록·배포는 이 절차에 포함하지 않는다.

## 5. 운영 범위와 복구 제약

- 자율 작업은 기존 OMP의 task·goal을 재사용한다. RPC에서 goal을 자동으로 이어가려면
  운영자의 기존 `goal.continuationModes` 설정에 `rpc`가 포함되어 있어야 한다.
  이 확장이 설정을 몰래 활성화하거나 별도 LLM 감독 루프를 만들지는 않는다.
  저장된 goal의 존재와 실제 연속 실행·완료는 구분한다.

- 코어 패치의 `--rpc-socket`, 동일 Host attach, 제어 연결 해제 후 Host 수명 유지가 필요하다.
  stock `--mode rpc`와 `omp join`의 조합이나 로그 tail로 대체하지 않는다.
  세션 파일·기록된 상태만으로 살아 있는 Host를 중복 실행하지 않는다.
  `pendingUiRequests`·`hasOwnedRunningWork` 같은 필수 실행 상태를 확인할 수 없으면
  안전한 유휴 상태로 추측하지 않는다. 소유권 불명·오래된 socket도 자동 삭제하거나
  중복 Host로 대체하지 않으며, 소유권이 대조될 때까지 상주 예산에서 제외하지 않는다.
- 모든 플랫폼의 입력 첨부는 요청당 최대 10개, 개별 20 MiB, 합계 40 MiB다.
  선언 크기·실제 스트림 크기를 대조하며 redirect는 따르지 않는다.
  PNG/JPEG/GIF/WebP는 내용 시그니처를 확인해 모델 이미지 입력으로 전달하고,
  RPC base64 입력의 디코딩 후 이미지 데이터 합계는 별도로 8 MiB로 제한한다.
  그 밖의 파일은 로컬 경로를 제공한다. 임의 URL 다운로드·문서 자동 변환은 제공하지 않는다.
  자격 증명·서명된 다운로드 URL은 모델 프롬프트에 넣지 않는다.
  안전한 다운로드에 실패하면 그 요청의 모델 실행을 시작하지 않는다.
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
- 긴 출력은 아래 단일 텍스트 첨부로 보낸다. 입력 한도와 다르며 여러 조각의 부분 발송으로
  우회하지 않는다. Telegram·Slack 변경·발송 API의 SDK 자동 재시도는 끈다. 읽기/poll 재연결과 불확실한 외부
  효과를 재실행하는 것은 다르다.

  | 플랫폼 | 일반 텍스트 | 긴 출력 |
  | --- | --- | --- |
  | Discord | 2,000자 이하 | 텍스트 첨부, 최대 8 MiB |
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

ULW 병합 회귀는 외부 checkout을 수정하거나 설치하지 않고 명시한 entrypoint를 읽어 실행한다.

```sh
OMP_TEST_ULW_EXTENSION=/absolute/path/to/omp-ulw/index.ts bun test test/skills.test.ts
```

이전 역할 특화 변경의 기록은 타입 검사와 위 스킬 회귀 14개·218 assertion 통과다.
기존 6개 시나리오에 더해 실제 OMP SDK에서 ULW/역할 확장의 양쪽 로드 순서,
head/lane·root/child 조합, 첫 턴·후속 턴과 OpenAI Responses 요청 훅의 프롬프트
보존을 확인했다. 이는 프롬프트 전달·권한 격리 검증이며 모델의 지침 준수나 실제
제공자 호출 검증은 아니며 현재 workflow/native activation·관리형 설치/업데이트 변경의 검증으로
재사용하지 않는다. 이 변경의 새 root/설치/discovery와 실제 native·프롬프트 조합 결과는 아래에
구분해 기록한다.
환경변수를 생략하면 외부 ULW 조합은 건너뛴다.

기본 명령은 `bun run check`, `bun run test`다. 후자는 `test/`로 범위를 제한하므로
`.upstream`까지 탐색하는 인수 없는 `bun test`로 대체하지 않는다.
네이티브 검증은 기본 실행에서 건너뛰며, 패치된 CLI argv를 JSON으로 지정해 명시적으로 켠다.
다음은 치환을 마친 설정을 재사용한다. TUI PTY 테스트에는 `python3`도 필요하다.

```sh
export OMP_TEST_COMMAND="$(bun -e 'const c = await Bun.file("config.local.json").json(); console.log(JSON.stringify(c.command));')"
OMP_SUPERAGENT_NATIVE_TEST=1 bun test test/native-host.test.ts test/native-tui.test.ts test/native-runtime.test.ts test/native-model-selection.test.ts test/native-board.test.ts test/native-gateway.test.ts
```

필요하면 `OMP_TEST_NATIVES_DIR`에 준비된 native addon 디렉터리의 절대 경로를 지정한다.
이 테스트들은 실제 CLI/소켓과 결정적인 로컬 테스트 제공자를 사용하고 사용자 설정·인증과
분리한다. runtime 테스트는 실제 조율 코드에 기록용 Messenger를 연결하므로 메신저 로그인은
하지 않는다. 운영 봇이나 실제 모델 제공자의 성공을 입증하지 않으며 로컬 TUI PTY도 herdr와 구분한다.

이번 코드·프롬프트 검토에서 확인된 Gateway 미해결 접수·답변 reconciliation, Telegram queued
답변 복구, Discord ACK 순서, uncertain dispatch fence와 실제 종료까지의 소유권 보존을 수정했다.
헤드의 최종 모델 선택/judge 자문 문구·영어 내부 보고, metadata의 native 키워드 격리,
managed extension 중복/disabled 처리, 비차단 updater startup과 native bind→chmod readiness
경합도 수정했다. 아래는 이 수정들의 관측 검증과 기존 native-core·플랫폼·모델 선택 기준선이다.
확인된 검토 결과를 반영했다는 뜻이지 코드·프롬프트 전체의 절대 무결함을 보증하지 않는다.
실제 SDK의 HTTP 경계 모의 응답·로컬 WebSocket fixture를 운영 메신저·모델 제공자·herdr
활성화 검증과 구분한다.
서로 겹치는 상위 테스트 묶음의 수를 합산하지 않는다.
기존 숫자는 당시 검증한 범위의 기록이다. 아래 기존 **이번** 표기는 앞선 runtime 통합 당시의
최종 담당자가 실제 실행한 결과이며 현재 ULW activation·관리형 설치/업데이트 검증이 아니다.
기존 기준선 행과 합산하거나 기존 수치를 새 결과로 재사용하지 않는다.
첫 runtime/store 묶음의 실패와 그 뒤의 좁은 수정 검증도 따로 기록한다. 당시 실행 경로 검증은
결정적 로컬 제공자·기록용 Messenger 범위이며 실제 메신저 로그인이나 제공자 과금 검증이 아니다.

| 검증 항목 | 현재 결과 |
| --- | --- |
| 현재 root 타입 검사 | 최종 통과 — 마지막 수정 뒤 최종 담당자의 실제 tsc 실행 |
| 현재 전체 root 회귀 | Bun 1.4.4에서 345개 통과·7개 skip·0개 실패·2,542 assertion. local-Git 설치 CLI·반복/동시 준비·업데이트/rewind/실패·old-live/new-host·delayed Gateway 회귀 포함. 마지막 native bind→chmod readiness 수정 전 결과이며 그 뒤 전체 재실행으로 확대하지 않음 |
| 현재 마지막 Host readiness 수정 회귀 | 15개·58 assertion 통과 — 실제 bind 뒤 chmod하도록 수정한 뒤의 targeted Host 결과 |
| 현재 native core managed-extension/discovery 회귀 | 80개·235 assertion 통과 — managed-extension precedence, extensions-discovery, plugin-discovery, disabled-extensions, task-discovery |
| 현재 공식 managed ULW 설치 CLI | 실제 `prepare-ulw` CLI 성공 — 프로젝트 소유 `.upstream/ulw`에 공식 revision `1f5ef903a2f4234ffdfe4a5295f4d8c994036c64`를 immutable `revisions/<sha>/package`로 활성화. 공용 사용자 ULW checkout은 변경하지 않음 |
| 현재 실제 native managed ULW 활성화 | 1 테스트 통과·3.50초 — wrapper expect 2개이며 내부 assert 수를 부풀려 합산하지 않음. 공식 managed revision `1f5ef903…`에서 plain ULW arm·자동 goal 미생성, head 선택 lane `ulw-plan`→`ultrathink`·`ulw-execute`→`orchestrate`의 실제 model-context notice와 영속 custom_message/directive 확인. passive 인용/report/board 비활성화, source/route/dedup 확인. 결정적 로컬 제공자·기록용 Messenger 범위 |
| 현재 실제 native Gateway/runtime/model 기준선 | 수정된 기준선 3개·217 assertion 통과 — 결정적 로컬 제공자·기록용 Messenger 범위 |
| 현재 native 프롬프트 조합·Host/TUI/board | 앞선 실행 묶음 17개 통과 — 14개 프롬프트 composition과 실제 Host/TUI/board 포함. 다른 행과 중복 가능하므로 합산하지 않음 |
| 이번 root 타입 검사 | 당시 통과 — 최종 담당자의 실제 tsc 실행. 당시 마지막 fixture-only receipt correlation 변경 전 결과이며 현재 ULW 변경 전의 기록 |
| 이번 Gateway IPC·수명 회귀 | 9개·49 assertion 통과 — detached CLI 수명, busy stop, head downtime durable 수신·승인 준비, framed attachment EOF/abort 포함 |
| 이번 공유 board 회귀 | 13개·104 assertion 통과 — membership·read/post/알림·세션별 unread 등. 이전 host+skills+board 묶음은 32개·215 assertion 통과였고 board 1개 추가 전 결과이므로 합산하지 않음 |
| 이번 Host·역할 스킬 회귀 | host 14개·skills 6개 통과 — 앞의 combined 묶음과 중복 가능. head/lane/common board 분리·자식 권한 경계 |
| 이번 runtime/store 회귀와 좁은 수정 검증 | 최초 묶음 131개 통과·1개 실패. 비동기 report 기대 수정 뒤 해당 1개·8 assertion 통과. 이후 cross-conversation runtime 1개·10 assertion, store 29개·268 assertion 통과. 수정 뒤 전체 묶음을 다시 통과했다고 확대하지 않음 |
| 이번 reconnect targeted 회귀 | 1개·9 assertion 통과 |
| 이번 실제 native runtime + model-selection | 2개·215 assertion 통과 — 실제 patched OMP Host에서 모든 입력의 head 경유와 기존 모델/judge readback 유지. 결정적 로컬 제공자·기록용 Messenger 범위 |
| 이번 실제 native board | 격리 wrapper에서 통과 — assertion 수 미보고. 실제 native 경로의 instance/역할/membership·게시판 계약 근거이며 운영 계정 검증 아님 |
| 이번 실제 native Gateway E2E | wrapper 1개 통과·4.85초 — wrapper expect 1개와 fixture 내부 node assert; 내부 assertion 수 미집계. 실제 production Gateway·native head manager/lane 확장·board direct/xd 도구, head SIGSTOP/SIGKILL 중 ingress·복구, 동일 native 세션/모델·replay dedupe·정확한 원래 route의 head-only 회신, lane manager 거부·board actor/session, busy-stop 거부·Gateway client detach 시 Host 유지 확인. 결정적 로컬 모델·기록용 Messenger 범위이며 운영 로그인/실제 제공자 과금 근거 아님 |
| 레인 모델 선택·최초 native 프리셋 초기화·명시적 유휴 변경·격리·재개·역할 스킬 회귀 | 통과 — runtime 99개·608 assertion, 모델 목록 3개, 스킬 6시나리오, 별도 프로세스의 실제 native Settings 프리셋 회귀. 기존 항목 보존·동시 생성 충돌·전체 역할/thinking snapshot·지연 전환·재개 검증 |
| 모델 선택 native E2E·실제 judge 자문/사용량 | 1 테스트·121 assertion 통과 — 실제 patched OMP CLI와 native eval judge, purpose `judge` 사용량 기록, 자문과 최종 선택 분리, native 프리셋 변경·재개·설정 바이트 보존. 결정적인 로컬 제공자 범위이며 실제 모델 품질 평가는 아님 |
| native 프리셋 생성·세션 설정 격리 | 32 테스트·151 assertion 통과 — 동시 생성·손상 설정 보존, 세션 전용 프리셋 적용, 실제 TUI 모델 허브의 역할 선택·설정 바이트 보존 |
| 루트 타입 검사 | 통과 — 상위와 정렬한 TypeScript 7.0.2 사용 |
| native 스킬·역할 격리 | Bun 1.4.4에서 6 시나리오·76 assertion 통과 — 다른 cwd의 실제 OMP SDK discovery/URI 읽기, 기존 사용자·프로젝트·custom 스킬 보존, 헤드/레인/자식 도구 권한·스키마·명시적 제외 유지. 변경한 Host 테스트 14개도 통과 |
| Host·설정·플랫폼 분배·영속 장부 회귀 | 통과 — 다중 플랫폼 권한·분배, 실제 자식 프로세스의 메신저 자격 증명 제거, 첨부 재전달 포함 |
| Discord·Telegram·Slack·runtime 회귀 | 155개 통과 — 승인 복구 장벽, 늦은 답장, 동시 입력, 유휴 Telegram offset, 주제 격리·자율 goal 결과 포함 |
| 상위 native RPC 회귀·생성 wire | RPC 57 통과, 생성 wire 별도 1 통과 |
| 상위 Collab/소켓 회귀 | 29 통과 — 다른 상위 묶음과 중복 가능 |
| 실제 네이티브 Host | 1 테스트·28 assertion 통과 |
| CLI 진단 | 기존 `--help`·빈 `status`·Telegram+Slack 진단 통과. 격리된 실제 `doctor`에서 `--rpc-socket`·`--session-settings`·`--model-preset` 지원 재검증 통과 — 토큰 없음, `messengersActivated: false` |
| 네이티브 TUI PTY·동일 Host attach | 1 테스트·19 assertion 통과 — 대화 렌더링, 읽기 전용 입력 차단, 제어 TUI 입력, 연결 해제 후 동일 Host 유지 |
| 실제 Host를 통한 runtime 코드 E2E | 1 테스트·45 assertion 통과 — 실제 헤드·레인, 원래 대화로 회신, 중복 수신 방지, 스레드 세션 격리·후속 대화 유지; 로컬 모델/기록용 Messenger 범위 |
| 실제 Slack SocketModeClient·로컬 HTTP/WebSocket | 1 테스트·17 assertion 통과 — SQLite 영속화 이후 wire ACK, 재전달 중복 제거, 양방향 ping/pong 및 연결 유지. Bun 1.4.4·Socket Mode 3.2.0 |
| 운영 Discord 로그인·수신·발송·승인·재연결 | 미수행 — 실제 Discord 자격 증명으로 활성화하지 않음 |
| 운영 Telegram·Slack 로그인·수신·발송·승인·복구 | 미수행 — 실제 계정·토큰으로 활성화하지 않음 |
| 실제 모델 제공자 호출 | 미확인 — 잘못된 generator 호출의 보조 OMP가 파일 설명 응답을 반환했으나 실행 파일/PID/세션/제공자 사용량 미확보. 실제 제공자·비용 부작용은 검증하지 못했으며 결정적 로컬 테스트 증거와 별개 |
| herdr pane 연결·해제 후 실행 유지 | 미수행 — herdr는 설치되어 있으나 `HERDR_ENV`가 없고 제어를 시도하지 않음 |

운영 전에는 미검증 항목을 별도로 확인해야 한다. 테스트·PTY 결과를 실제 메신저나
herdr 사용자 흐름의 검증 결과로 대신 표시하지 않는다.
