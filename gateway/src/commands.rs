pub(crate) struct Command {
    pub name: &'static str,
    pub description: &'static str,
    pub text: Option<&'static str>,
}

pub(crate) fn catalog() -> &'static [Command] {
    include!(concat!(env!("OUT_DIR"), "/messenger_commands.rs"))
}

pub(crate) fn discord_catalog() -> &'static [Command] {
    include!(concat!(env!("OUT_DIR"), "/discord_commands.rs"))
}

/// Returns the optional-text flag, or `None` for an unsupported name.
pub(crate) fn accepts_text(name: &str) -> Option<bool> {
    catalog().iter().find(|command| command.name == name).map(|command| command.text.is_some())
}

pub(crate) fn discord_accepts_text(name: &str) -> Option<bool> {
    discord_catalog().iter().find(|command| command.name == name).map(|command| command.text.is_some())
}
