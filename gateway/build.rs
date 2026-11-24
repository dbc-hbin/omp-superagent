use serde_json::Value;
use std::{collections::BTreeMap, env, error::Error, fmt::Write as _, fs, path::PathBuf};

fn main() -> Result<(), Box<dyn Error>> {
    const CATALOG: &str = "../src/messenger-command-catalog.json";
    const PACKAGE: &str = "../package.json";
    println!("cargo:rerun-if-changed={CATALOG}");
    println!("cargo:rerun-if-changed={PACKAGE}");
    let package: serde_json::Value = serde_json::from_slice(&fs::read(PACKAGE)?)?;
    let version = package["version"].as_str().ok_or("Package version is missing")?;
    let homepage = package["homepage"].as_str().ok_or("Package homepage is missing")?;
    println!("cargo:rustc-env=OMP_SUPERAGENT_VERSION={version}");
    println!("cargo:rustc-env=OMP_SUPERAGENT_HOMEPAGE={homepage}");

    let catalog: Vec<BTreeMap<String, Value>> = serde_json::from_slice(&fs::read(CATALOG)?)?;
    let out = PathBuf::from(env::var("OUT_DIR")?);
    for (file, discord) in [("messenger_commands.rs", false), ("discord_commands.rs", true)] {
        let mut generated = String::from("&[\n");
        for command in &catalog {
            if !discord && command.get("discordOnly") == Some(&Value::Bool(true)) {
                continue;
            }
            let name = command.get("name").and_then(Value::as_str)
                .ok_or("Messenger command is missing a name")?;
            let overrides = command.get("discord").filter(|_| discord);
            let description = overrides.and_then(|v| v.get("description")).or(command.get("description"))
                .and_then(Value::as_str).ok_or("Messenger command is missing a description")?;
            let text = command.get("text").and_then(Value::as_str)
                .filter(|_| overrides.and_then(|v| v["text"].as_bool()) != Some(false));
            writeln!(generated, "    Command {{ name: {name:?}, description: {description:?}, text: {text:?} }},")?;
        }
        generated.push_str("]\n");
        fs::write(out.join(file), generated)?;
    }
    Ok(())
}
