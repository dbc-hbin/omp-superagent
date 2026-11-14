# 제3자 코드·의존성 및 출처

이 문서는 선택적으로 재사용한 코드와 의존성의 고지다. **이 저장소 전체의 배포 라이선스는
아직 정하지 않았으며**, 아래 MIT/Apache 고지가 프로젝트 전체를 해당 라이선스로 바꾸지 않는다.
의존 패키지를 재배포할 때는 각 패키지와 전이 의존성에 포함된 LICENSE/NOTICE도 보존해야 한다.

## README 로고 — oh-my-pi 시각 자산의 변형

- 참조 원본: [oh-my-pi README hero](https://github.com/can1357/oh-my-pi/blob/c308970263ae13744ea15ab67302e3dac840e266/assets/hero.png).
- 적용 파일: `assets/superagent-mascot.webp`. 원본 hero를 이미지 생성 모델
  `gpt-image-2`의 참조 이미지로 사용해 π 실루엣·핑크/보라 색상을 살린 마스코트를 생성했다.
  바이저·눈·짧은 망토를 추가하고,
  [원본 icon.svg](https://github.com/can1357/oh-my-pi/blob/c308970263ae13744ea15ab67302e3dac840e266/assets/icon.svg)의
  플러그 모티프를 작은 주황색 장식으로 반영했다. 기존 연결 노드형 SVG 로고를 대체한다.
- 독립 프로젝트의 변형 로고이며 원 프로젝트의 공식 제품·보증을 의미하지 않는다.
- 원본 [LICENSE](https://github.com/can1357/oh-my-pi/blob/c308970263ae13744ea15ab67302e3dac840e266/LICENSE):

```text
MIT License

Copyright (c) 2025 Mario Zechner
Copyright (c) 2025-2026 Can Bölük
Copyright (c) 2026 Stencil Labs, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## ompbot — SQLite 장부 패턴의 수정·재사용

- 원본: [gimso2x/ompbot](https://github.com/gimso2x/ompbot/tree/ddd0f854e8e8d395b7ed43104ec541f909a52ad4)
- revision: `ddd0f854e8e8d395b7ed43104ec541f909a52ad4`
- 원본 파일: `src/store/db.ts`, `src/lanes/manager.ts`
- 적용 파일: `src/store.ts`의 SQLite 장부 패턴. 해당 파일 헤더에도 전체 MIT 고지를 보존한다.
- 원본 [LICENSE](https://github.com/gimso2x/ompbot/blob/ddd0f854e8e8d395b7ed43104ec541f909a52ad4/LICENSE):

```text
MIT License

Copyright (c) 2026 ompbot contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Discord transport

- Gateway/REST·컴포넌트는 직접 복사한 클라이언트 대신
  [discord.js](https://github.com/discordjs/discord.js)를 의존 패키지로 사용한다.
  직접 선언 범위는 `^14.25.1`이며 실제 고정 버전은 `bun.lock`을 따른다.
  설치 시 확인한 패키지 `14.28.1`은 **Apache-2.0**이다(MIT로 간주하지 않는다).
  전체 라이선스는 `node_modules/discord.js/LICENSE`와
  [해당 버전 LICENSE](https://github.com/discordjs/discord.js/blob/14.28.1/packages/discord.js/LICENSE)에 있다.
  저작권 고지는 `Copyright 2021 Noel Buechler`, `Copyright 2015 Amish Shah`다.
  배포에 패키지를 포함하면 Apache-2.0 전문과 해당 고지를 함께 제공한다.
- `src/discord.ts`는
  [ompbot `4d2eb28d0bf66644892dc0fc333580d0eb7e7780`](https://github.com/gimso2x/ompbot/tree/4d2eb28d0bf66644892dc0fc333580d0eb7e7780)의
  `src/discord/{adapter,attachments,channel,transport}.ts` 동작 의미를 참고했다.
  이 revision의 ompbot은 MIT이며 해당 파일들을 복사한 것은 아니다.
- 라이선스 없는 poke 코드는 복사하지 않았다. Dori의 SUL 적용 코드도 가져오지 않았다.
  운영 개념을 참고한 사실은 코드의 재라이선스나 복사 허가를 뜻하지 않는다.

## 운영 스킬 — 개념 참고, 독립 작성

`skills/head/`, `skills/lane/`의 역할 계약과 상세 절차는 현재 OMP 도구·세션 계약과
이 저장소 설계에 맞춰 독립 작성했다. Dori의 스킬 문구나 실행 스크립트를 복사한 이식이 아니다.

- 참고: [vntrevx/omp-dori `3b5487df12540cdd428ebcf7455375d72921e2dc`](https://github.com/vntrevx/omp-dori/tree/3b5487df12540cdd428ebcf7455375d72921e2dc), 2026-11-13 확인.
- 검토 대상: `skills/dori-mode/SKILL.md`, `prompts/lead.md`, `prompts/lane-footer.md`,
  `skills/dori-mode/references/sessions.md`, `skills/dori-mode/references/done-protocol.md`.
- 참고한 개념: 명확한 인계·완료 조건, 보고 후 사실 확인, 중단된 외부 효과의 증거 확인,
  작업자의 완료 주장과 관리자의 검증된 종료 구분.
- 채택하지 않은 구현: `dori`/`herdr`/`hc` 실행 명령, 별도 상태·감독 레지스트리,
  상주 duty LLM, 모든 요청의 강제 위임, 시간 경과에 따른 자동 승인·종료·worktree 제거.
- 해당 upstream 유래 자료는 [SUL 및 NOTICE](https://github.com/vntrevx/omp-dori/blob/3b5487df12540cdd428ebcf7455375d72921e2dc/NOTICE)의 적용을 받는다.
  `LICENSE.omp-dori`를 전체 저장소에 대한 MIT 허가로 해석하지 않는다.

## Telegram transport — grammY

- 재사용 API client: [`grammy` 1.46.0](https://github.com/grammyjs/grammY/tree/055a5a440f04d0b9fd5fd75a6d14dac4c2b83553)
- 패키지 출처 git revision: `055a5a440f04d0b9fd5fd75a6d14dac4c2b83553`.
  실제 설치 버전은 `node_modules/grammy/package.json`, 고정 의존성은 `bun.lock`을 따른다.
- `src/telegram.ts`에서 `Api`·`InputFile`을 사용한다. 별도 Telegram 봇/SUL 구현을 복사하지 않았다.
- 공식 문서: [grammY API](https://grammy.dev/guide/api),
  [Telegram Bot API](https://core.telegram.org/bots/api).
- 설치 패키지의 `node_modules/grammy/LICENSE`는 다음 MIT 전문이다. 패키지를 포함해 배포할 때
  해당 저작권·허가 고지를 보존한다.

```text
MIT License

Copyright (c) 2021-2024 KnorpelSenf

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Slack transport — 공식 Node Slack SDK

| 패키지 | 설치 버전 | 출처 git revision | 라이선스 |
| --- | --- | --- | --- |
| `@slack/web-api` | `8.3.0` | [`d8df118652c5749e56e00bb4f614b344993a24e4`](https://github.com/slackapi/node-slack-sdk/tree/d8df118652c5749e56e00bb4f614b344993a24e4) | MIT |
| `@slack/socket-mode` | `3.2.0` | [`5e8d3f08c16144a2d700c38389bf94cbcc4d5f0f`](https://github.com/slackapi/node-slack-sdk/tree/5e8d3f08c16144a2d700c38389bf94cbcc4d5f0f) | MIT |

- `src/slack.ts`에서 공식 `WebClient`·`SocketModeClient`를 재사용한다. 별도 Slack 봇이나
  SUL 적용 봇 구현을 복사하지 않았다. 전송·라우팅·승인 조율은 이 저장소의 어댑터가 담당한다.
- 공식 문서: [Web API SDK](https://docs.slack.dev/tools/node-slack-sdk/web-api/),
  [Socket Mode SDK](https://docs.slack.dev/tools/node-slack-sdk/socket-mode/),
  [Socket Mode 설정](https://docs.slack.dev/apis/events-api/using-socket-mode),
  [외부 업로드 시작](https://docs.slack.dev/reference/methods/files.getUploadURLExternal/),
  [업로드 게시 완료](https://docs.slack.dev/reference/methods/files.completeUploadExternal/).
- 설치된 두 패키지의 `node_modules/@slack/{web-api,socket-mode}/LICENSE`를 확인했으며
  모두 아래 동일한 MIT 전문과 저작권 고지를 포함한다. 각 패키지를 재배포할 때 보존한다.

```text
MIT License

Copyright (c) 2014- Slack Technologies, LLC

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## Hermes 셋업 — UX 참고, 독립 구현

- 참고 revision: [`NousResearch/hermes-agent` `4b40ffb0ad6d7da5d3260f5e499e1691508dd4d5`](https://github.com/NousResearch/hermes-agent/tree/4b40ffb0ad6d7da5d3260f5e499e1691508dd4d5).
- 확인한 구현: [`scripts/install.sh`](https://github.com/NousResearch/hermes-agent/blob/4b40ffb0ad6d7da5d3260f5e499e1691508dd4d5/scripts/install.sh)의
  `/dev/tty` 셋업 인계·`0600` 환경 파일,
  [`hermes_cli/secret_prompt.py`](https://github.com/NousResearch/hermes-agent/blob/4b40ffb0ad6d7da5d3260f5e499e1691508dd4d5/hermes_cli/secret_prompt.py)의
  비밀 입력·터미널 복원,
  [`hermes_cli/setup_platforms.py`](https://github.com/NousResearch/hermes-agent/blob/4b40ffb0ad6d7da5d3260f5e499e1691508dd4d5/hermes_cli/setup_platforms.py)의
  플랫폼별 자격 증명 질문·기존 구성 유지 흐름.
- 적용: `scripts/setup.sh`와 CLI setup/credential 로딩의 UX를 이 저장소의 OMP·Gateway 계약에
  맞춰 독립 작성했다. 해당 Python·설치기 코드는 복사하지 않았다.
- Bash builtin·Node 표준 `readline`/dotenv parser와 기존 config 검증을 사용한다.
  Hermes의 자동 봇 생성·로그인·Gateway 서비스 설치/재시작·allow-all 정책은 가져오지 않는다.
  정확한 호환 범위는 Unix terminal과 이 저장소가 준비한 Bun/패치 OMP이며 Hermes 실행 의존성은 없다.

## OMP — 상위 소스와 코어 패치

- 원본: [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi/tree/c308970263ae13744ea15ab67302e3dac840e266)
- 기준: `v18.20.0`, revision `c308970263ae13744ea15ab67302e3dac840e266`
- 로컬 소스: `.upstream/omp`; 재현 패치: `patches/omp`; pin 기록: `upstream/omp.json`.
- 의존 패키지: 로컬 `@oh-my-pi/pi-coding-agent` 및 상위 workspace 패키지.
  로컬 RPC Host·동일 Host attach·수명 관리 변경은 실제 상위 소스의 패치이며
  미수정 OMP가 제공하는 기능으로 표시하지 않는다.
- 상위 소스와 그 수정 패치는 다음 MIT 고지를 보존한다.
  원본 [LICENSE](https://github.com/can1357/oh-my-pi/blob/c308970263ae13744ea15ab67302e3dac840e266/LICENSE):

```text
MIT License

Copyright (c) 2025 Mario Zechner
Copyright (c) 2025-2026 Can Bölük
Copyright (c) 2026 Stencil Labs, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
