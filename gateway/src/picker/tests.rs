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
