import { describe, expect, test } from "bun:test";
import { isObservationRequest } from "../src/observation-request";

describe("bound-topic observation routing", () => {
  test.each(["온라인 표시 꺼 줘", "이 레인 감시를 중지해 줘", "감시 목록 보여줘", "이번 작업이 끝나면 여기로 알려 주세요.",
    "Please keep the Discord bot online", "Set the Discord bot invisible", "Can you monitor owner/repo#35?", "Show my watches",
    "Keep an eye on it", "Let me know when it finishes"])(
    "recognizes an operator coordination request: %s", text => expect(isObservationRequest(text)).toBe(true));
  test.each(["> 이 PR 감시해 줘", "```sh\nwatch this PR\n```", "`watch this lane`", "문서에 “봇 온라인 상태 유지해 줘” 예시를 추가해",
    "Implement PR monitoring", "Track down the CI failure", "Track the new CI config in Git", "Track CI config in Git",
    "Check online documentation for this API",
    "Write a Discord bot presence test", "설정 파일 변경을 감시해 줘", "/new Watch this PR"])(
    "leaves unrelated work and quoted material alone: %s", text => expect(isObservationRequest(text)).toBe(false));
});
