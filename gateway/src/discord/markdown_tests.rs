use super::*;

fn split(text: &str, limit: usize, parts: usize) -> Option<Vec<String>> {
    super::split(&Rendered::plain(text), limit, parts)
}

fn units(chunks: &[String]) -> Vec<usize> {
    chunks.iter().map(|chunk| utf16(chunk)).collect()
}

#[test]
fn split_prefers_paragraph_then_line_then_space_boundaries() {
    let paragraph = format!(
        "{}\n\n{}\nline\n{}",
        "a".repeat(30),
        "b".repeat(20),
        "c".repeat(10)
    );
    assert_eq!(
        split(&paragraph, 40, 5).unwrap(),
        [
            "a".repeat(30),
            format!("{}\nline\n{}", "b".repeat(20), "c".repeat(10))
        ]
    );
    let lines = format!("{}\n{}\n{}", "a".repeat(15), "b".repeat(15), "c".repeat(15));
    assert_eq!(
        split(&lines, 40, 5).unwrap(),
        [
            format!("{}\n{}", "a".repeat(15), "b".repeat(15)),
            "c".repeat(15)
        ]
    );
    let words = format!("{} {} {}", "a".repeat(15), "b".repeat(15), "c".repeat(15));
    assert_eq!(
        split(&words, 40, 5).unwrap(),
        [
            format!("{} {}", "a".repeat(15), "b".repeat(15)),
            "c".repeat(15)
        ]
    );
    // Without any boundary the text is cut at the limit, never past it.
    let solid = "x".repeat(90);
    assert_eq!(units(&split(&solid, 40, 5).unwrap()), [40, 40, 10]);
    assert_eq!(split(&solid, 40, 5).unwrap().concat(), solid);
}

#[test]
fn split_measures_utf16_units_and_never_cuts_a_surrogate_pair() {
    // Each emoji is two UTF-16 units; 21 of them cannot fit in 41 units.
    let text = "\u{1F600}".repeat(21);
    let chunks = split(&text, 41, 5).unwrap();
    assert_eq!(units(&chunks), [40, 2]);
    assert_eq!(chunks.concat(), text);
}

#[test]
fn split_closes_and_reopens_a_code_fence_with_its_language() {
    let code = (0..12)
        .map(|line| format!("let value_{line} = {line};"))
        .collect::<Vec<_>>();
    let text = format!(
        "Intro paragraph.\n\n```rust\n{}\n```\nAfter.",
        code.join("\n")
    );
    let chunks = split(&text, 120, 5).unwrap();
    assert!(chunks.len() > 2, "fixture must cross several boundaries");
    assert!(units(&chunks).iter().all(|units| *units <= 120));
    for (index, chunk) in chunks.iter().enumerate() {
        // Every part is balanced Markdown on its own.
        assert_eq!(
            chunk.matches("```").count() % 2,
            0,
            "part {index}: {chunk:?}"
        );
        if index > 0 && chunk.contains("let value_") {
            assert!(chunk.starts_with("```rust\n"), "part {index}: {chunk:?}");
        }
    }
    assert_eq!(chunks[0], "Intro paragraph.");
    assert!(chunks[1].starts_with("```rust\nlet value_0 = 0;\n"));
    assert!(chunks[2].starts_with("```rust\nlet value_"), "{chunks:#?}");
    assert_eq!(chunks.last().unwrap(), "After.");
    // No code line is lost, duplicated or reordered across the parts.
    let lines = chunks
        .iter()
        .flat_map(|chunk| chunk.lines())
        .filter(|line| line.starts_with("let value_"))
        .collect::<Vec<_>>();
    assert_eq!(lines, code);
}

#[test]
fn split_does_not_reopen_inline_backticks_as_a_code_fence() {
    let inline = "```example```";
    let prose = "a".repeat(2_050);
    let input = format!("{inline}\n\n{prose}");
    let chunks = split(&input, 2_000, 5).unwrap();
    assert_eq!(chunks[0], inline);
    assert_eq!(chunks[1..].concat(), prose);

    // A space split before the closing run would make the first fragment
    // look like a real opener. Keep the original text in the attachment.
    let overlong = format!("```example {prose}```");
    assert!(split(&overlong, 2_000, 5).is_none());
}

#[test]
fn split_keeps_blank_lines_inside_a_reopened_fence() {
    let code = format!("{}\n\n{}", "a".repeat(40), "b".repeat(40));
    let text = format!("```py\n{code}\n```");
    let chunks = split(&text, 60, 5).unwrap();
    assert_eq!(
        chunks,
        [
            format!("```py\n{}\n```", "a".repeat(40)),
            format!("```py\n\n{}\n```", "b".repeat(40)),
        ]
    );
}

#[test]
fn split_preserves_a_shorter_marker_inside_a_longer_fence() {
    let literal = format!("```{}", "x".repeat(2_100));
    let input = format!("````text\n{literal}\n````");
    let chunks = split(&input, 2_000, 5).unwrap();
    assert!(chunks.len() > 1);
    let content = chunks
        .iter()
        .map(|part| {
            let body = part
                .strip_prefix("````text")
                .unwrap()
                .strip_suffix("\n````")
                .unwrap();
            body.strip_prefix('\n').unwrap_or(body)
        })
        .collect::<String>();
    assert_eq!(content, literal);
}

#[test]
fn split_keeps_longer_and_tilde_fences_intact() {
    let body = (0..10)
        .map(|line| format!("row {line} ```inner```"))
        .collect::<Vec<_>>();
    let text = format!("~~~~text\n{}\n~~~~", body.join("\n"));
    let chunks = split(&text, 80, 5).unwrap();
    assert!(chunks.len() > 1);
    for chunk in &chunks {
        assert!(chunk.starts_with("~~~~text\n"), "{chunk:?}");
        assert!(chunk.ends_with("\n~~~~"), "{chunk:?}");
    }
}

#[test]
fn split_refuses_more_than_the_allowed_parts() {
    let text = "word ".repeat(100);
    assert!(split(&text, 40, 5).is_none());
    assert!(split(&text, 200, 5).is_some_and(|chunks| chunks.len() <= 5));
}

#[test]
fn split_can_break_between_table_fields_but_not_inside_a_markdown_link() {
    let label = "한글 리뷰 링크";
    let url = format!("https://example.invalid/{}", "x".repeat(1_500));
    let note = "다시 확인했습니다. ".repeat(80);
    let source = format!("| PR | 결과 |\n| --- | --- |\n| [{label}]({url}) | {note} |");
    let rendered = render(&source, 8_000);
    assert_eq!(
        super::split(&rendered, 2_000, 5).unwrap(),
        [
            format!("- PR: [{label}]({url})"),
            format!("  - 결과: {}", note.trim_end()),
        ]
    );

    let url = format!("{url}/{}", "y".repeat(500));
    let source = format!("| PR |\n| --- |\n| [{label}]({url}) |");
    let rendered = render(&source, 8_000);
    assert_eq!(rendered.text, format!("- PR: [{label}]({url})"));
    assert!(super::split(&rendered, 2_000, 5).is_none());
}

#[test]
fn render_keeps_indented_examples_and_labels_ragged_rows() {
    let code = "    | Key | Value |\n    | --- | --- |\n\t| 1 | 2 |";
    let source = format!(
        "{code}\n\n| 키 | | 값 |\n| --- | --- | --- |\n\
         | 한글 | `x \\| y` |\n| 둘째 | 값 | 셋째 | 넷째 |"
    );
    assert_eq!(
        render(&source, 8_000).text,
        format!(
            "{code}\n\n- 키: 한글\n  - Column 2: `x | y`\n  - 값:\n\n\
             - 키: 둘째\n  - Column 2: 값\n  - 값: 셋째\n  - Column 4: 넷째"
        )
    );
}

#[test]
fn render_budgets_the_finished_text_across_tables() {
    let first = "| Name | 결과 |\n|---|---|\n| One | 설명 |\n| Two | 완료 |";
    let source = format!("{first}\n\n| Key |\n| {} |\n| value |", "-".repeat(100));
    let expected = "- Name: One\n  - 결과: 설명\n\n- Name: Two\n  - 결과: 완료\n\n- Key: value";
    assert_eq!(render(&source, source.len()).text, expected);
}

#[test]
fn render_keeps_later_columns_after_unmatched_backticks() {
    let source = "| 키 | 상태 |\n| --- | --- |\n| `` 미완료 `ok` 로그 | 정상 |";
    assert_eq!(
        render(source, 8_000).text,
        "- 키: \\`\\` 미완료 `ok` 로그\n  - 상태: 정상"
    );
}

#[test]
fn render_distinguishes_list_tables_from_list_code() {
    let code = "10. ```markdown\n    A | B\n    --- | ---\n    x | y\n    ```";
    let indented = "        A | B\n        --- | ---\n        x | y";
    let source = format!("{code}\n\n11. Results\n\n    Name | Status\n    - | -\n    build | pass\n\n{indented}");
    let expected = format!("{code}\n\n11. Results\n\n    - Name: build\n      - Status: pass\n\n    ---\n\n{indented}");
    assert_eq!(render(&source, 8_000).text, expected);
    assert_eq!(render(&expected, 8_000).text, expected);
}

#[test]
fn render_preserves_the_fence_when_a_tab_reaches_the_list_margin() {
    let source = "- Example\n\n  ~~~md\n\tintro\n  A | B\n  --- | ---\n  x | y\n\t~~~\n\n| A | B |\n|-|-|\n| 1 | 2 |";
    let expected = "- Example\n\n  ~~~md\n\tintro\n  A | B\n  --- | ---\n  x | y\n\t~~~\n\n- A: 1\n  - B: 2";
    assert_eq!(render(source, 8_000).text, expected);
}

#[test]
fn render_does_not_pair_literal_backticks_across_the_label_and_value() {
    let source = "| `Tag |\n| --- |\n| [release](https://example.invalid/)` |";
    assert_eq!(render(source, 8_000).text, "- \\`Tag: [release](https://example.invalid/)\\`");
}

#[test]
fn split_does_not_turn_a_nested_table_into_indented_code() {
    let source = format!("10. Results\n\n    | A | B |\n    | --- | --- |\n    | {} | 2 |", "x".repeat(20));
    let rendered = render(&source, 8_000);
    assert_eq!(rendered.text, format!("10. Results\n\n    - A: {}\n      - B: 2", "x".repeat(20)));
    assert!(super::split(&rendered, 40, 5).is_none());
}
