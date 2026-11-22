mod commands;
mod inventory;
mod owner;
mod projection;
mod transport;
mod wire;
mod worker_rpc;

use std::{env, path::PathBuf, process::ExitCode};

#[tokio::main(flavor = "current_thread")]
async fn main() -> ExitCode {
    let mut args = env::args_os().skip(1);
    let Some(path) = args.next().map(PathBuf::from) else {
        eprintln!("Usage: omp-host-owner <absolute owner.json>");
        return ExitCode::FAILURE;
    };
    if !path.is_absolute() || args.next().is_some() {
        eprintln!("Usage: omp-host-owner <absolute owner.json>");
        return ExitCode::FAILURE;
    }

    match owner::run(path).await {
        Ok(code) => code,
        Err(error) => {
            // The top-level context is fixed; inputs, paths and helper errors are private.
            eprintln!("Host owner: {error}");
            ExitCode::FAILURE
        }
    }
}
