// Name, shared optional-text policy (None excludes Slack/Telegram), and Discord optional-text policy.
const COMMANDS: &[(&str, Option<bool>, bool)] = include!(concat!(env!("OUT_DIR"), "/messenger_commands.rs"));

/// Returns the optional-text flag, or `None` for an unsupported name.
pub(crate) fn accepts_text(name: &str) -> Option<bool> {
    COMMANDS
        .iter()
        .find_map(|&(command, shared, _)| if command == name { shared } else { None })
}

pub(crate) fn discord_accepts_text(name: &str) -> Option<bool> {
    COMMANDS
        .iter()
        .find_map(|&(command, _, discord)| (command == name).then_some(discord))
}
