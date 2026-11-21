import { expect, test } from "bun:test";
import { discordThreadSplit } from "../src/topic-request";

test.each([
  ["이건 따로 빼줘", ""],
  ["이건 따로 빼 줘!", ""],
  ["이건 따로 빼줘:   로그인 점검  ", "로그인 점검"],
  ["로그인 점검은 새 스레드에서 해줘", "로그인 점검"],
  ["로그인 점검을 새 스레드에서 해 줘.", "로그인 점검"],
  ["Split this into a new thread.", ""],
  ["Please split this into a new thread:   Check login  ", "Check login"],
  ["Do the login check in a new thread!", "the login check"],
  ["Please do the end-to-end login check in a new thread.", "the end-to-end login check"],
  ["Split this into a new thread: Explain why we use X rather than Y.", "Explain why we use X rather than Y."],
  ["Do this in a new thread", ""],
] as const)("recognizes an explicit Discord split: %s", (input, expected) => {
  expect(discordThreadSplit(input)).toBe(expected);
});

test.each([
  "로그인 점검은 여기서 이어서 해줘",
  "/new 로그인 점검",
  "cwd: /other/repo",
  "이건 따로 빼지 말고 여기서 해줘",
  "로그인 점검은 새 스레드에서 하지 마",
  "Don't split this into a new thread",
  "Do not check login in a new thread",
  "Do no review in a new thread",
  "Do the review here instead of in a new thread",
  "Do the review here rather   than in a new thread",
  "Do the review here, rather than in a new thread",
  "Do the review here or in a new thread",
  "Do the review here vs in a new thread",
  "Do the review here but leave follow-up notes in a new thread",
  "Do the review here -- in a new thread",
  "Do - in a new thread",
  "Do __ in a new thread",
  "리뷰는 여기서 하고 대신 로그인 점검을 새 스레드에서 해줘",
  "Do we need to check login in a new thread",
  "이건 따로 빼줘 말고 같은 스레드에서 해줘",
  "예를 들어 로그인 점검은 새 스레드에서 해줘",
  "For example, split this into a new thread",
  "Can you explain how to split this into a new thread?",
  "“이건 따로 빼줘: 로그인 점검”",
  "“로그인 점검”은 새 스레드에서 해줘",
  "> split this into a new thread",
  "`Do the login check in a new thread`",
  "```text\n이건 따로 빼줘: 로그인 점검\n```",
  "notes.txt: 로그인 점검은 새 스레드에서 해줘",
  "Here are the file contents:\nDo the login check in a new thread",
])("does not treat ordinary or quoted Discord text as a split: %s", (input) => {
  expect(discordThreadSplit(input)).toBeNull();
});
