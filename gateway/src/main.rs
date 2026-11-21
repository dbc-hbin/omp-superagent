use std::{
    env,
    os::unix::process::CommandExt,
    path::{Path, PathBuf},
    process::Stdio,
};

use anyhow::{Context as _, Result, bail, ensure};
use omp_gateway::{
    adapter, daemon,
    lifecycle::{self, LifecycleConfig},
};
use serde_json::Value;
use tokio::process::Command;

const USAGE: &str = "omp-gateway (managed by omp-sa)\n\
    launch --config FILE\n    serve --config FILE [--restart-request ID]\n\
    restart-runner --config FILE --restart-request ID --state-dir PATH";

enum CommandKind {
    Launch,
    Serve,
    RestartRunner,
    ValidatedRunner,
    RejectedRunner,
}

struct Args {
    kind: CommandKind,
    config: PathBuf,
    request: Option<String>,
    state_dir: Option<PathBuf>,
}

fn parse(cmd: &str, mut args: impl Iterator<Item = String>) -> Result<Args> {
    let kind = match cmd {
        "launch" => CommandKind::Launch,
        "serve" => CommandKind::Serve,
        "restart-runner" => CommandKind::RestartRunner,
        "__restart-validated" => CommandKind::ValidatedRunner,
        "__restart-rejected" => CommandKind::RejectedRunner,
        _ => bail!("{USAGE}"),
    };
    let (mut config, mut request, mut state_dir) = (None, None, None);
    while let Some(key) = args.next() {
        let value = args
            .next()
            .filter(|v| !v.is_empty() && !v.starts_with("--"))
            .context(USAGE)?;
        match key.as_str() {
            "--config" if config.is_none() => config = Some(PathBuf::from(value)),
            "--restart-request" if request.is_none() && !matches!(kind, CommandKind::Launch) => {
                uuid::Uuid::parse_str(&value).context("Invalid restart identity")?;
                request = Some(value);
            }
            "--state-dir"
                if state_dir.is_none()
                    && !matches!(kind, CommandKind::Launch | CommandKind::Serve) =>
            {
                state_dir = Some(PathBuf::from(value))
            }
            _ => bail!("{USAGE}"),
        }
    }
    if !matches!(kind, CommandKind::Launch | CommandKind::Serve) {
        ensure!(
            request.is_some() && state_dir.as_ref().is_some_and(|p| p.is_absolute()),
            "{USAGE}"
        );
    }
    Ok(Args {
        kind,
        config: config.context(USAGE)?,
        request,
        state_dir,
    })
}

async fn normalized_config(file: &Path) -> Result<Value> {
    let root = PathBuf::from(env::var_os("OMP_SUPERAGENT_ROOT").context("Missing package root")?);
    let bun = PathBuf::from(env::var_os("OMP_SUPERAGENT_BUN").context("Missing installed Bun")?);
    ensure!(
        root.is_absolute() && bun.is_absolute(),
        "Package root and Bun must be absolute"
    );
    let config = std::path::absolute(file)?;
    let output = Command::new(bun)
        .args(["--no-env-file", "--no-install"])
        .arg(root.join("src/gateway-config.ts"))
        .arg(config)
        .current_dir(root)
        .env_clear()
        .env("PATH", env::var_os("PATH").unwrap_or_default())
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .output()
        .await?;
    ensure!(
        output.status.success(),
        "Gateway configuration could not be loaded"
    );
    Ok(serde_json::from_slice(&output.stdout)?)
}

async fn run(args: Args) -> Result<()> {
    let result = async {
        let config = normalized_config(&args.config).await?;
        if let Some(original) = &args.state_dir {
            ensure!(
                config["stateDir"].as_str().map(Path::new) == Some(original.as_path()),
                "Restart state directory changed"
            );
        }
        let lifecycle = LifecycleConfig::new(&config)?;
        if let Err(error) = lifecycle.require_mnemopi().await {
            eprintln!(
                "Managed sessions require effective native OMP Mnemopi (memory.backend=mnemopi). \
                 Run omp-sa doctor with the same configuration and native profile."
            );
            return Err(error);
        }
        match args.kind {
            CommandKind::Serve => {
                daemon::serve(
                    &config,
                    lifecycle,
                    args.request.as_deref(),
                    adapter::Hub::new,
                )
                .await
            }
            CommandKind::Launch => {
                println!("{}", lifecycle::launch(&lifecycle).await?);
                Ok(())
            }
            CommandKind::ValidatedRunner => {
                lifecycle::restart_runner(&lifecycle, args.request.as_deref().context(USAGE)?).await
            }
            CommandKind::RestartRunner | CommandKind::RejectedRunner => {
                bail!("Invalid async runner state")
            }
        }
    }
    .await;
    if result.is_err()
        && let (Some(dir), Some(id)) = (&args.state_dir, args.request.as_deref())
    {
        lifecycle::record_runner_failure(dir, id)?;
    }
    result
}

fn execute(args: Args) -> Result<()> {
    match args.kind {
        CommandKind::RestartRunner => {
            let bun =
                PathBuf::from(env::var_os("OMP_SUPERAGENT_BUN").context("Missing installed Bun")?);
            let root =
                PathBuf::from(env::var_os("OMP_SUPERAGENT_ROOT").context("Missing package root")?);
            ensure!(
                root.is_absolute() && bun.is_absolute(),
                "Invalid runner paths"
            );
            let id = args.request.as_deref().context(USAGE)?;
            let state = args.state_dir.as_ref().context(USAGE)?;
            let error = std::process::Command::new(bun)
                .args(["--no-env-file", "--no-install"])
                .arg(root.join("src/gateway-restart-env.ts"))
                .arg(args.config)
                .arg(id)
                .arg(state)
                .exec();
            lifecycle::record_runner_failure(state, id)?;
            Err(error.into())
        }
        CommandKind::RejectedRunner => {
            lifecycle::record_runner_failure(
                args.state_dir.as_deref().context(USAGE)?,
                args.request.as_deref().context(USAGE)?,
            )?;
            bail!("Restart preparation refused")
        }
        // No model runs here. One event loop serves all configured accounts.
        _ => tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?
            .block_on(run(args)),
    }
}

fn main() -> std::process::ExitCode {
    let mut args = env::args().skip(1);
    let result = match args.next().as_deref() {
        Some("--help" | "-h") | None => {
            println!("{USAGE}");
            return std::process::ExitCode::SUCCESS;
        }
        Some("--version" | "-V") => {
            println!("omp-gateway {}", env!("CARGO_PKG_VERSION"));
            return std::process::ExitCode::SUCCESS;
        }
        Some("__detach") => lifecycle::exec_detached(args),
        Some(cmd) => parse(cmd, args).and_then(execute),
    };
    if result.is_err() {
        // Foreign transport errors can contain private request URLs or secrets.
        eprintln!("Gateway operation failed; no uncertain operation was retried");
        std::process::ExitCode::FAILURE
    } else {
        std::process::ExitCode::SUCCESS
    }
}
