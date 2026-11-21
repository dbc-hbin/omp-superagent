# Discord 음성채팅

별도 OpenAI Live 모델이 소유자의 말을 듣고 음성으로 바로 답합니다. OMP의 HEAD 모델을 교체하지 않습니다.
일반 메시지·음성 첨부와 별개이며, 음성 모델은 셸을 쓰거나 레인을 시작하거나 승인을 대신할 수 없습니다.

## 준비

1. Discord 서버에 **봇과 소유자만 들어갈 수 있는 일반 음성 채널**과 작업 초안·답변용 텍스트 채널을 준비하세요.
   서버는 `discord.allowedGuildIds`, 텍스트 채널은 `discord.allowedChannelIds`에 있어야 합니다.
   봇에는 음성 채널 보기·연결·발언, 텍스트 채널 보기·보내기·기록 읽기 권한이 필요합니다.
   권한으로 제삼자의 입장을 제한하세요. 참여자 변경 통지는 실시간 접근 제어를 대신할 수 없습니다.
2. 기존 설정의 `discord` 안에 `voice` 객체를 추가하세요. **Codex 구독**을 쓰려면 아래처럼 설정합니다.
   ID는 본인의 채널 ID로 바꾸세요. `model`, `backendModel`, `apiKeyEnv`는 구독 설정에 넣지 않습니다.

   ```json
   "voice": {
     "auth": "subscription",
     "channelId": "111111111111111111",
     "textChannelId": "222222222222222222",
     "voice": "cove",
     "maxSessionSeconds": 300
   }
   ```

   **API 과금**을 선택하려면 대신 다음 예시를 사용하세요. 기존 `auth` 없는 설정도 이 모드입니다. 계정에서 사용 가능한
   [Live 모델](https://developers.openai.com/api/docs/models/gpt-live-1),
   [Responses 위임 모델](https://developers.openai.com/api/docs/guides/live-delegation),
   [목소리](https://developers.openai.com/api/docs/guides/live-conversations#voice-options)를 선택하세요. 아래는 기본값이 아닌 예시입니다.

   ```json
   "voice": {
     "auth": "api",
     "channelId": "111111111111111111",
     "textChannelId": "222222222222222222",
     "apiKeyEnv": "SUPERAGENT_VOICE_OPENAI_KEY",
     "model": "gpt-live-1",
     "backendModel": "gpt-6-luna",
     "voice": "marin",
     "maxSessionSeconds": 300
   }
   ```

3. **구독 모드:** Gateway를 실행하는 OS 사용자로 Codex CLI에 ChatGPT 계정 로그인이 되어 있어야 합니다
   (`codex login`, API 키 방식 아님). Discord나 이 프로젝트의 설정 파일에 Codex 토큰을 붙여 넣지 마세요.
   로그인 성공이 음성 사용 권한을 보장하지는 않습니다. 구독 음성 연결은 공개 Live API와 다른
   WebRTC 프로토콜을 쓰므로 Codex나 서비스 변경으로 호환성이 깨질 수 있습니다.
   **API 모드:** `apiKeyEnv`가 가리키는 변수에 OpenAI 키를 설정하세요. Gateway의 환경 또는 기존 비공개 `FILE.env`를 사용하고,
   JSON에 키를 넣지 마세요. Discord 토큰과는 다른 변수여야 합니다. Gateway는 해당 변수를 HEAD·레인 환경에서 제외합니다.
4. 프로젝트의 잠금 파일로 의존성을 설치하세요(`bun install --frozen-lockfile`).
   Rust Gateway에 DAVE 및 Opus가 포함됩니다. 음성 연결은 소유자가 명시적으로 시작할 때만 열며 설치·진단 중에는 봇을 접속시키지 않습니다.
   설정 변경은 다음 Gateway 시작에 반영됩니다.

### 구독 모드의 Codex 로그인

WebRTC는 Rust Gateway에 포함되어 있어 Python이나 가상환경을 설치할 필요가 없습니다.
Codex CLI는 별도로 설치하고 Gateway를 실행하는 OS 사용자로 `codex login`을 실행하세요.
Gateway는 `~/.local/bin/codex`와 표준 설치 위치에서만 CLI를 찾으며 프로젝트의 `PATH`는 쓰지 않습니다.

`/voice start` 때만 Gateway가 Codex의 로컬 `app-server`에 현재 로그인 정보를 요청합니다. Codex 작업 스레드는
시작하지 않습니다. 오디오는 WebRTC로 OpenAI에 보내고 작업 초안과 상태 이벤트는 같은 통화의 별도 연결로 받습니다.
Codex 로그인이나 음성 권한이 거절되면 먼저 같은 OS 사용자와 `CODEX_HOME`으로 로그인했는지 확인하세요.
API 키로 로그인한 Codex, 만료된 자격증명, 별도의 지역·전용 서버 경로가 필요한 워크스페이스는
지원하지 않습니다. Gateway는 조직의 경로 제한을 무시하거나 다른 계정·API 키로 재시도하지 않습니다.

## 사용

- 소유자가 지정 음성 채널에 들어간 뒤 **지정 텍스트 채널**에 일반 메시지 `/voice start`를 보냅니다.
  등록형 슬래시 명령이나 DM이 아닙니다. 준비됐다는 알림 후 말하세요.
- 일반 대화는 Live가 음성으로 답합니다. 작업을 맡기려면 구독·API 모드 모두 **`/voice start` 대신
  `/voice start work`로 새 통화를 시작**한 뒤 “헤드에게 작업을 맡겨줘”처럼 명확하게 말하세요.
  이 시작 명령은 해당 통화에서 작업 초안을 **지정 텍스트 채널의 독자에게 공개**하는 허용이지 실행 승인이 아닙니다.
  구독 모드에서 초안 하나만 허용하려면 `/voice start share`로 시작하세요(준비 완료 후 1분간 유효).
  이 명령은 통화 중에 보내던 이전 `/voice share`를 대체합니다.
- 음성 모델은 초안 게시 여부만 알려주며 작업 결과를 대신 말하지 않습니다. 말한 내용이 정확히 옮겨졌는지 확인한 뒤
  **그 초안에 Discord 답장으로** `/voice confirm`을 보내야 기존 HEAD에 접수됩니다. 초안은 한 번에 하나만 유효하며,
  게시 후 5분 또는 통화 종료 시 만료됩니다. 채널에 따로 쓰거나 음성으로 “승인”하는 것은 접수가 아니며,
  위험한 작업은 기존 승인 절차를 거칩니다. 접수가 불확실하면 텍스트 요청 기록을 확인하고 자동으로 반복하지 마세요.
- HEAD 결과는 **Discord 텍스트로만** 받습니다. 결과나 작업 상태는 음성 모델에 전달하지 않습니다.
- `/voice work off`로 통화를 유지한 채 게시 허용을 철회하고 미확인 초안을 무효화할 수 있습니다.
  이미 전송된 메시지는 회수할 수 없으며, 확인한 작업을 취소하지도 않습니다. 통화 도중 게시 허용을 켜거나
  되돌릴 수 없습니다. 다시 작업을 맡기려면 통화를 종료하고 새 `/voice start work`로 시작하세요.
- `/voice stop`, 소유자 퇴장, 다른 참여자 입장, 연결 종료, 설정 시간 만료 또는 Gateway 종료로 음성 세션을 닫습니다.
  자동 재접속·유료 재시도·묵시적 재개가 없습니다. 다시 시작하려면 원하는 모드의 시작 명령을 새로 보내세요.

## 개인정보·비용

음성은 OpenAI로 전송됩니다. 로컬에 녹음 파일이나 대화 전체 전사본을 남기지 않습니다.
작업 초안은 Discord에, 확인한 요청과 답변은 기존 Gateway/OMP 기록에 남습니다.
구독 모드는 해당 계정의 음성 권한과 사용량 제한을 따릅니다. 무료 계정 지원이나 공급자의 무보관 정책을 보장하지 않습니다.
구독 거절·사용량 초과·연결 실패 시 통화를 닫습니다. 유료 API 키가 있어도 대신 사용하지 않습니다.
API 모드에서는 Live 세션과 Responses 위임에 비용이 발생할 수 있습니다. `maxSessionSeconds`는 명시적 시작 1회의 시간 제한이지
금액·일일 예산 제한이 아닙니다. 실제 요금은 [OpenAI 가격표](https://developers.openai.com/api/docs/pricing)에서 확인하고 공급자 쪽 지출 한도를 설정하세요.
실계정 통화 품질이나 지연 시간은 오프라인 테스트로 검증되지 않습니다.
