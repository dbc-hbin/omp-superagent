use anyhow::{Context, Result, ensure};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    env,
    ffi::{OsStr, OsString},
    fs,
    os::unix::ffi::OsStrExt,
    path::{Component, Path, PathBuf},
    time::Duration,
};
use tokio::process::Command;

use super::{fs::private_directory, stock_ops::capture};

pub(super) const RESTART_CONFIG_ENV: &str = "OMP_SUPERAGENT_RESTART_CONFIG_SHA256";
pub(super) const RUNNER_CONFIG_ENV: &str = "OMP_SUPERAGENT_RUNNER_CONFIG_SHA256";
pub(super) const GATEWAY_START_CONFIG_ENV: &str = "OMP_SUPERAGENT_GATEWAY_START_CONFIG_SHA256";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    config: Value,
    source_hash: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Normalized {
    path: PathBuf,
    state_dir: PathBuf,
    head_cwd: PathBuf,
    command: Vec<String>,
    max_hosts: u64,
    max_subagents: u64,
    model: Option<String>,
    discord: Option<Discord>,
    telegram: Option<Token>,
    slack: Option<Slack>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Token {
    token_env: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Discord {
    token_env: String,
    voice: Option<Voice>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Voice {
    api_key_env: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Slack {
    bot_token_env: String,
    app_token_env: String,
}

pub struct LifecycleConfig {
    pub path: PathBuf,
    pub state_dir: PathBuf,
    pub(super) cwd: PathBuf,
    pub(super) command: Vec<String>,
    pub(super) model: Option<String>,
    pub(super) concurrency: u64,
    pub(super) bun: PathBuf,
    pub(super) root: PathBuf,
    pub(super) head_socket: PathBuf,
    pub(super) head_session: PathBuf,
    pub(super) head_log: PathBuf,
    pub gateway_socket: PathBuf,
    pub(super) gateway_log: PathBuf,
    messenger_credentials: Vec<String>,
    voice_credential: Option<String>,
    pub(super) source_hash: String,
    pub(super) normalized_hash: String,
    restart_context: Value,
}

impl LifecycleConfig {
    /// Parse and hash the same on-disk bytes using the operator config parser.
    pub async fn load(file: &Path) -> Result<(Value, Self)> {
        let root = launcher_path("OMP_SUPERAGENT_ROOT")?;
        let bun = launcher_path("OMP_SUPERAGENT_BUN")?;
        let mut command = Command::new(bun);
        command
            .args(["--no-env-file", "--no-install"])
            .arg(root.join("src/gateway-config.ts"))
            .arg(std::path::absolute(file)?)
            .current_dir(root)
            .env_clear()
            .env("PATH", env::var_os("PATH").unwrap_or_default());
        let Snapshot { config, source_hash } = serde_json::from_slice(
            &capture(command, None, Duration::from_secs(10)).await?,
        )?;
        let lifecycle = Self::from_normalized(&config, source_hash)?;
        Ok((config, lifecycle))
    }

    /// Construct from an already normalized fixture configuration.
    pub fn new(config: &Value) -> Result<Self> {
        let path = Path::new(config["path"].as_str().context("Missing config path")?);
        Self::from_normalized(config, hash_file(path)?)
    }

    fn from_normalized(config: &Value, source_hash: String) -> Result<Self> {
        let raw =
            Normalized::deserialize(config).context("Invalid normalized Gateway configuration")?;
        let bun = launcher_path("OMP_SUPERAGENT_BUN")?;
        let root = launcher_path("OMP_SUPERAGENT_ROOT")?;
        ensure!(
            raw.path.is_absolute() && raw.state_dir.is_absolute() && raw.head_cwd.is_absolute(),
            "Lifecycle paths must be absolute"
        );
        let head_socket = raw.state_dir.join("run/main.sock");
        let gateway_socket = raw.state_dir.join("run/gateway.sock");
        ensure!(
            gateway_socket.as_os_str().as_bytes().len() <= 100,
            "stateDir is too long for the Gateway socket"
        );
        let concurrency = raw
            .max_subagents
            .checked_div(raw.max_hosts)
            .filter(|value| *value > 0)
            .context("Invalid native subagent concurrency")?;
        let mut credentials = Vec::new();
        let mut voice_credential = None;
        if let Some(discord) = raw.discord {
            credentials.push(discord.token_env);
            voice_credential = discord.voice.and_then(|voice| voice.api_key_env);
        }
        if let Some(telegram) = raw.telegram {
            credentials.push(telegram.token_env);
        }
        if let Some(slack) = raw.slack {
            credentials.extend([slack.bot_token_env, slack.app_token_env]);
        }
        ensure!(
            credentials
                .iter()
                .chain(voice_credential.iter())
                .all(|name| name != GATEWAY_START_CONFIG_ENV),
            "Gateway startup config marker cannot be used as a credential"
        );
        let mut restart_context = config.clone();
        restart_context.sort_all_objects();
        let normalized_hash = hex::encode(Sha256::digest(serde_json::to_vec(&restart_context)?));
        let context = restart_context
            .as_object_mut()
            .context("Invalid normalized Gateway configuration")?;
        // Only these settings can change without changing the identity, native
        // launch profile or authority of a resumed session. The model default
        // is only a bootstrap selector; the resumed session keeps its own model.
        for field in ["maxHosts", "maxSubagents", "idleMs", "model"] {
            context.remove(field);
        }
        Ok(Self {
            path: raw.path,
            cwd: raw.head_cwd,
            command: raw.command,
            model: raw.model,
            concurrency,
            bun,
            root,
            head_socket,
            gateway_socket,
            head_session: raw.state_dir.join("sessions/main/session.jsonl"),
            head_log: raw.state_dir.join("logs/main.log"),
            gateway_log: raw.state_dir.join("logs/gateway.log"),
            state_dir: raw.state_dir,
            messenger_credentials: credentials,
            voice_credential,
            source_hash,
            normalized_hash,
            restart_context,
        })
    }

    pub(super) fn restart_compatible(&self, candidate: &Self) -> bool {
        self.restart_context == candidate.restart_context
    }

    /// Reject a detached child's changed config before running any helper with inherited credentials.
    pub(super) fn validate_spawned_config(&self) -> Result<()> {
        if let Some(expected) = env::var_os(GATEWAY_START_CONFIG_ENV) {
            ensure!(
                expected.as_os_str() == OsStr::new(&self.source_hash)
                    && self.matches_config_hash(&self.source_hash),
                "Gateway configuration changed between launch and serve"
            );
        }
        Ok(())
    }

    pub(super) fn prepare_directories(&self) -> Result<()> {
        private_directory(&self.state_dir)?;
        for directory in ["run", "logs", "sessions"] {
            private_directory(&self.state_dir.join(directory))?;
        }
        Ok(())
    }

    pub(super) fn require_credentials(&self) -> Result<()> {
        for name in &self.messenger_credentials {
            ensure!(
                env::var(name).is_ok_and(|value| !value.is_empty() && !value.contains(['\r', '\n'])),
                "Missing or invalid messenger credential environment variable {name}"
            );
        }
        Ok(())
    }

    pub(super) fn head_environment(&self) -> BTreeMap<OsString, OsString> {
        let mut environment: BTreeMap<_, _> = env::vars_os().collect();
        for name in self
            .messenger_credentials
            .iter()
            .chain(self.voice_credential.iter())
        {
            environment.remove(&OsString::from(name));
        }
        for name in [
            "OMP_RPC_SOCKET",
            "OMP_SUPERAGENT_HOST_SOCKET",
            "OMP_SUPERAGENT_NATIVE_SOCKET",
            "OMP_SUPERAGENT_HOST_CONFIG",
            "OMP_SUPERAGENT_GATEWAY_TOKEN",
            RESTART_CONFIG_ENV,
            RUNNER_CONFIG_ENV,
            GATEWAY_START_CONFIG_ENV,
        ] {
            environment.remove(&OsString::from(name));
        }
        environment
    }

    pub(super) fn config_hash(&self) -> Result<String> {
        hash_file(&self.path)
    }

    pub(super) fn matches_config_hash(&self, expected: &str) -> bool {
        self.config_hash().is_ok_and(|actual| actual == expected)
    }
}

fn hash_file(path: &Path) -> Result<String> {
    Ok(hex::encode(Sha256::digest(fs::read(path)?)))
}

pub(super) fn launcher_path(name: &str) -> Result<PathBuf> {
    let path = env::var_os(name)
        .map(PathBuf::from)
        .with_context(|| format!("Missing launcher path {name}"))?;
    ensure!(path.is_absolute(), "{name} must be an absolute path");
    Ok(path)
}

/// Node path.resolve uses lexical path equality, without following aliases.
pub(super) fn same_path(left: &Path, right: &Path) -> bool {
    fn normalize(path: &Path) -> PathBuf {
        let mut result = PathBuf::from("/");
        for part in path.components() {
            match part {
                Component::Normal(part) => result.push(part),
                Component::ParentDir => {
                    result.pop();
                }
                Component::RootDir | Component::CurDir | Component::Prefix(_) => {}
            }
        }
        result
    }
    left.is_absolute() && right.is_absolute() && normalize(left) == normalize(right)
}
