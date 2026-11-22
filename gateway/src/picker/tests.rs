use serde_json::json;

use super::{Change, Picker, Pickers, Selection, ledger_error, time};
use crate::adapter::EffectError;

#[test]
fn navigation_rejection_preserves_the_visible_controls() -> Result<(), EffectError> {
    let pickers = Pickers::default();
    let spec: Picker = serde_json::from_value(json!({
        "kind":"model", "expiresAt":time()? + 60_000,
        "groups":[{"label":"local","options":["local/model"]}]
    })).map_err(|_| ledger_error())?;
    let opening = pickers.open("output", json!("fixture-route"), "Status", &spec)?
        .ok_or_else(ledger_error)?;
    let provider = opening.menu.options[0].control.clone();
    pickers.posted(opening, "card".to_owned())?;
    let linked = |route: &serde_json::Value, id: &str| route == "fixture-route" && id == "card";
    let Some(Change::Show(first)) = pickers.choose(&provider, None, linked)? else {
        panic!("provider should offer a model page");
    };
    pickers.navigated(&first, &Err(EffectError::rejected("platform refused the edit")))?;
    let Some(Change::Show(second)) = pickers.choose(&provider, None, linked)? else {
        panic!("the old provider control is still visible");
    };
    pickers.navigated(&second, &Ok(()))?;
    assert!(pickers.choose(&provider, None, linked)?.is_none());
    assert!(matches!(pickers.choose(&second.menu.options[0].control, None, linked)?, Some(Change::Select(_))));
    Ok(())
}

#[test]
fn unconfirmed_admission_reconciles_only_the_original_selection() -> Result<(), EffectError> {
    let pickers = Pickers::default();
    let spec: Picker = serde_json::from_value(json!({
        "kind":"effort", "expiresAt":time()? + 60_000,
        "groups":[{"label":"Effort","options":["low","high"]}]
    })).map_err(|_| ledger_error())?;
    let opening = pickers.open("output", json!("fixture-route"), "Status", &spec)?
        .ok_or_else(ledger_error)?;
    let low = opening.menu.options[0].control.clone();
    let high = opening.menu.options[1].control.clone();
    pickers.posted(opening, "card".to_owned())?;
    let select = |control: &str| -> Result<Option<Selection>, EffectError> {
        Ok(match pickers.choose(control, None, |route, id| route == "fixture-route" && id == "card")? {
            Some(Change::Select(selection)) => Some(selection),
            _ => None,
        })
    };
    let original = select(&high)?.ok_or_else(ledger_error)?;
    assert!(select(&low)?.is_none());
    // Move the original deadline behind the clock without waiting in the test.
    pickers.cards.lock().unwrap().get_mut(&original.token).unwrap().entry.picker.expires_at = time()? - 1;
    let replay = select(&high)?.ok_or_else(ledger_error)?;
    assert_eq!(original.event, replay.event);
    let replacement = pickers.open("replacement", json!("fixture-route"), "Status", &spec)?
        .ok_or_else(ledger_error)?;
    pickers.posted(replacement, "new-card".to_owned())?;
    assert_eq!(select(&high)?.ok_or_else(ledger_error)?.event, original.event);
    pickers.admitted(&replay)?;
    assert!(select(&high)?.is_none());
    Ok(())
}

fn reset_fixture() -> Result<(Pickers, super::Opening), EffectError> {
    let pickers = Pickers::default();
    let spec: Picker = serde_json::from_value(json!({
        "kind": "usage-reset",
        "expiresAt": time()? + 60_000,
        "groups": [{
            "label": "Accounts",
            "options": (0..9)
                .map(|index| format!("Account {index}: {} saved requests", index + 10))
                .collect::<Vec<_>>(),
        }]
    }))
    .map_err(|_| ledger_error())?;
    let opening = pickers
        .open("reset-output", json!("fixture-route"), "Saved usage", &spec)?
        .ok_or_else(ledger_error)?;
    Ok((pickers, opening))
}

fn button<'a>(menu: &'a super::Menu, label: &str) -> &'a str {
    &menu
        .buttons
        .iter()
        .find(|item| item.label == label)
        .unwrap_or_else(|| panic!("missing {label} button"))
        .control
}

#[test]
fn usage_reset_back_invalidates_confirmation_and_cancel_admits_nothing() -> Result<(), EffectError> {
    let (pickers, opening) = reset_fixture()?;
    let next = button(&opening.menu, "Next").to_owned();
    pickers.posted(opening, "reset-card".to_owned())?;
    let choose = |control: &str| {
        pickers.choose(control, None, |route, id| route == "fixture-route" && id == "reset-card")
    };
    let Some(Change::Show(page)) = choose(&next)? else {
        panic!("expected the second account page");
    };
    pickers.navigated(&page, &Ok(()))?;
    let Some(Change::Show(review)) = choose(&page.menu.options[0].control)? else {
        panic!("choosing an account must only start a card edit");
    };
    let confirm = button(&review.menu, "Confirm");
    assert!(
        choose(confirm)?.is_none(),
        "unacknowledged page must not admit a reset"
    );
    pickers.navigated(&review, &Ok(()))?;

    let Some(Change::Show(back)) = choose(button(&review.menu, "Back"))? else {
        panic!("expected to return to the account picker");
    };
    pickers.navigated(&back, &Ok(()))?;
    assert_eq!(back.menu.options[0].label, "Account 8: 18 saved requests");
    let Some(Change::Show(new_review)) = choose(&back.menu.options[0].control)? else {
        panic!("expected a new confirmation screen");
    };
    pickers.navigated(&new_review, &Ok(()))?;
    assert!(choose(confirm)?.is_none(), "the first confirmation is stale");
    assert!(matches!(
        choose(button(&new_review.menu, "Cancel"))?,
        Some(Change::Cancel)
    ));
    assert!(choose(button(&new_review.menu, "Confirm"))?.is_none());
    Ok(())
}

#[test]
fn usage_reset_retries_only_the_frozen_confirmation_after_expiry() -> Result<(), EffectError> {
    let (pickers, opening) = reset_fixture()?;
    let account = opening.menu.options[1].control.clone();
    pickers.posted(opening, "reset-card".to_owned())?;
    let choose = |control: &str| {
        pickers.choose(control, None, |route, id| route == "fixture-route" && id == "reset-card")
    };
    let Some(Change::Show(review)) = choose(&account)? else {
        panic!("choosing an account must only start a card edit");
    };
    pickers.navigated(&review, &Ok(()))?;
    let confirm = button(&review.menu, "Confirm");
    let Some(Change::Select(frozen)) = choose(confirm)? else {
        panic!("a confirmed reset must be ready for durable admission");
    };
    pickers.cards.lock().unwrap().get_mut(&frozen.token).unwrap().entry.picker.expires_at = time()? - 1;
    assert!(choose(button(&review.menu, "Cancel"))?.is_none());
    assert!(choose(button(&review.menu, "Back"))?.is_none());
    let Some(Change::Select(replay)) = choose(confirm)? else {
        panic!("only the exact frozen confirmation can reconcile on retry");
    };
    assert_eq!(replay.event, frozen.event);
    pickers.admitted(&replay)?;
    assert!(choose(confirm)?.is_none());
    Ok(())
}
