use super::*;

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
fn ragged_table_budgets_match_rendered_size_without_expanding_missing_cells() {
    let source = [
        "| 이름 | 값 | 비고 |",
        "| --- | --- | --- |",
        "| 가 |",
        "| 긴항목이름 | 22 | 메모 | 끝 |",
    ]
    .join("\n");
    let rendered = render(&source, usize::MAX);
    assert_ne!(rendered.as_ref(), source);
    let exact_bytes = rendered.len();
    assert_eq!(render(&source, exact_bytes).as_ref(), rendered.as_ref());
    assert!(matches!(render(&source, exact_bytes - 1), Cow::Borrowed(original) if original == source));

    let rows = vec![
        vec!["이름".to_owned(), "값".to_owned(), "비고".to_owned()],
        vec!["가".to_owned()],
        vec!["긴항목이름".to_owned(), "22".to_owned(), "메모".to_owned(), "끝".to_owned()],
    ];
    let aligns = vec![Align::Left; 3];
    let utf16_rendered = table_utf16(&rows, &aligns, usize::MAX).unwrap();
    let exact_utf16 = utf16(&utf16_rendered);
    assert_eq!(table_utf16(&rows, &aligns, exact_utf16).as_deref(), Some(utf16_rendered.as_str()));
    assert!(table_utf16(&rows, &aligns, exact_utf16 - 1).is_none());

    let wide_row = format!("| {} |", (0..4_000).map(|i| format!("c{i}")).collect::<Vec<_>>().join(" | "));
    let ragged = [
        "| a | b |".to_owned(),
        "|---|---|".to_owned(),
        wide_row,
    ]
    .into_iter()
    .chain(std::iter::repeat_n("| 1 |".to_owned(), 4_000))
    .collect::<Vec<_>>()
    .join("\n");
    assert!(matches!(render(&ragged, ragged.len()), Cow::Borrowed(original) if original == ragged));
}
