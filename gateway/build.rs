use serde_json::Value;
use std::{collections::BTreeMap, env, error::Error, fmt::Write as _, fs, path::PathBuf};

fn main() -> Result<(), Box<dyn Error>> {
    const CATALOG: &str = "../src/messenger-command-catalog.json";
    println!("cargo:rerun-if-changed={CATALOG}");

    let catalog: Vec<BTreeMap<String, Value>> = serde_json::from_slice(&fs::read(CATALOG)?)?;
    let mut generated = String::from("&[\n");
    for command in catalog {
        let name = command
            .get("name")
            .and_then(Value::as_str)
            .ok_or("Messenger command is missing a name")?;
        let text = command.contains_key("text");
        let shared = (command.get("discordOnly") != Some(&Value::Bool(true))).then_some(text);
        let discord = command.get("discord").and_then(|entry| entry["text"].as_bool()).unwrap_or(text);
        writeln!(generated, "    ({name:?}, {shared:?}, {discord}),")?;
    }
    generated.push_str("]\n");
    fs::write(
        PathBuf::from(env::var("OUT_DIR")?).join("messenger_commands.rs"),
        generated,
    )?;
    Ok(())
}
