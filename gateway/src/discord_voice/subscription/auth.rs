//! The local Codex broker owns login; voice only reads the managed account.

use anyhow::{Context as _, Result, anyhow, bail, ensure};
use nix::{
    errno::Errno,
    sys::signal::{Signal, killpg},
    unistd::{AccessFlags, Pid, access},
};
use std::{
    env,
    ffi::OsString,
    fs::Permissions,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Stdio,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    process::{Child, Command},
    time::timeout,
};
use zeroize::Zeroizing;

#[path = "auth/account.rs"]
mod account;
#[path = "auth/rpc.rs"]
mod rpc;
#[cfg(test)]
#[path = "auth/tests.rs"]
mod tests;

use account::{Account, AuthStatus};
use rpc::{Request, Rpc};

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(8);
const SHUTDOWN_GRACE: Duration = Duration::from_millis(500);
const REAP_TIMEOUT: Duration = Duration::from_millis(500);
const AUTH_ENV: [&str; 7] = [
    "CODEX_HOME",
    "SYSTEMROOT",
    "USERPROFILE",
    "LOCALAPPDATA",
    "TMPDIR",
    "TEMP",
    "TMP",
];

/// Subscription identity obtained from the local managed broker.
pub(super) struct Login {
    token: Zeroizing<String>,
    account_id: Zeroizing<String>,
}

impl Login {
    pub(super) fn token(&self) -> &str {
        self.token.as_str()
    }

    pub(super) fn account_id(&self) -> &str {
        self.account_id.as_str()
    }

    #[cfg(test)]
    pub(super) fn fixture(token: &str, account_id: &str) -> Self {
        Self {
            token: Zeroizing::new(token.to_owned()),
            account_id: Zeroizing::new(account_id.to_owned()),
        }
    }
}

/// Read the current subscription identity without refreshing or starting a turn.
///
/// # Errors
/// Returns a sanitized error if the broker is unavailable or gives inconsistent
/// account data. Dropping the future stops the owned broker and closes its pipes.
pub(super) async fn read_login() -> Result<Login> {
    run_broker(broker_command(|key| env::var_os(key))?).await
}

fn broker_command(mut lookup: impl FnMut(&str) -> Option<OsString>) -> Result<Command> {
    let mut absolute_env = |key| match lookup(key) {
        Some(value) if Path::new(&value).is_absolute() => Ok(Some(value)),
        Some(_) => bail!("Codex managed-login paths must be absolute"),
        None => Ok(None),
    };
    let home =
        PathBuf::from(absolute_env("HOME")?.context("Codex voice requires an absolute HOME")?);
    // Match the managed broker's UNIX search path, never the invoking project's PATH.
    let paths = [
        home.join(".local/bin"),
        "/opt/homebrew/bin".into(),
        "/usr/local/bin".into(),
        "/bin".into(),
        "/usr/bin".into(),
    ];
    let executable = paths
        .iter()
        .map(|path| path.join("codex"))
        .find(|path| path.is_file() && access(path, AccessFlags::X_OK).is_ok())
        .context("Codex CLI is not installed")?;
    let path = env::join_paths(paths).map_err(|_| anyhow!("Invalid Codex managed-login PATH"))?;
    let mut command = Command::new(executable);
    command
        .args([
            "app-server",
            "--listen",
            "stdio://",
            "-c",
            "analytics.enabled=false",
        ])
        .env_clear()
        .env("HOME", home)
        .env("PATH", path)
        .env("RUST_LOG", "off")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .process_group(0)
        .kill_on_drop(true);
    for key in AUTH_ENV {
        if let Some(value) = absolute_env(key)? {
            command.env(key, value);
        }
    }
    Ok(command)
}

struct BrokerChild(Child);

impl BrokerChild {
    fn stop(&mut self) -> Result<()> {
        let Some(pid) = self.0.id() else {
            return Ok(());
        };
        let group = Pid::from_raw(i32::try_from(pid).context("Invalid Codex broker process ID")?);
        // Signal before reaping the group leader, so its PID cannot be reused.
        // This also stops a CLI wrapper's descendants in the same process group.
        match killpg(group, Signal::SIGKILL) {
            Ok(()) | Err(Errno::ESRCH) => Ok(()),
            Err(_) => {
                self.0
                    .start_kill()
                    .map_err(|_| anyhow!("Could not stop Codex managed-login broker"))?;
                bail!("Could not stop Codex managed-login process group");
            }
        }
    }

    async fn shutdown(&mut self) -> Result<()> {
        let result = match timeout(SHUTDOWN_GRACE, self.0.wait()).await {
            Ok(result) => result,
            Err(_) => {
                self.stop()?;
                timeout(REAP_TIMEOUT, self.0.wait())
                    .await
                    .map_err(|_| anyhow!("Codex managed-login shutdown timed out"))?
            }
        };
        result
            .map(|_| ())
            .map_err(|_| anyhow!("Could not reap Codex managed-login broker"))
    }
}

impl Drop for BrokerChild {
    fn drop(&mut self) {
        // A cancelled future cannot report a cleanup error. Tokio's kill-on-drop
        // still covers the direct child and transfers any outstanding reap to its runtime.
        drop(self.stop());
    }
}

async fn run_broker(mut command: Command) -> Result<Login> {
    // Do not use project cwd or inherit an arbitrary TMPDIR as the parent of our private cwd.
    let cwd = tempfile::Builder::new()
        .prefix("omp-codex-voice-")
        .permissions(Permissions::from_mode(0o700))
        .tempdir_in("/tmp")
        .map_err(|_| anyhow!("Could not create private Codex managed-login directory"))?;
    let child = command
        .current_dir(cwd.path())
        .spawn()
        .map_err(|_| anyhow!("Could not start Codex managed-login broker"))?;
    let mut child = BrokerChild(child);
    let mut rpc = Rpc::new(&mut child.0)?;
    let result = timeout(HANDSHAKE_TIMEOUT, read_account(&mut rpc))
        .await
        .unwrap_or_else(|_| Err(anyhow!("Codex managed login timed out")));
    // Give the broker EOF and leave stdout open until the graceful window ends.
    let output = rpc.close_input();
    child.shutdown().await?;
    drop(output);
    result
}

async fn read_account(rpc: &mut Rpc) -> Result<Login> {
    #[derive(serde::Deserialize)]
    struct Initialized {}

    rpc.request::<Initialized>(Request::Initialize).await?;
    rpc.send(b"{\"method\":\"initialized\"}\n").await?;
    let account: Account = rpc.request(Request::Account).await?;
    account.check()?;
    let status: AuthStatus = rpc.request(Request::Status).await?;
    let confirmed: Account = rpc.request(Request::ConfirmAccount).await?;
    ensure!(
        confirmed == account,
        "The active Codex account changed during voice startup"
    );
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| anyhow!("Invalid Codex managed login"))?;
    account.login(status, now.as_secs())
}

#[cfg(test)]
mod cancellation_tests {
    use super::{run_broker, tests::Fixture};
    use nix::{
        errno::Errno,
        sys::{signal::kill, stat::Mode},
        unistd::{Pid, mkfifo},
    };
    use std::{
        fs::{self, File, OpenOptions},
        io::{ErrorKind, Read},
        os::unix::fs::{OpenOptionsExt as _, PermissionsExt as _},
        path::PathBuf,
        time::Duration,
    };
    use tokio::{task::yield_now, time::timeout};

    #[tokio::test]
    async fn cancellation_removes_the_private_cwd_and_stops_the_owned_process_group() {
        let fixture = Fixture::new();
        let path = fixture.home().join("writer");
        mkfifo(&path, Mode::S_IRUSR | Mode::S_IWUSR).unwrap();
        let fifo = OpenOptions::new()
            .read(true)
            .custom_flags(nix::libc::O_NONBLOCK)
            .open(path)
            .unwrap();
        let command = fixture.command(
            &[],
            r#"
exec 3>"$HOME/writer"
/bin/sleep 10 &
exec 3>&-
printf '%s\n' "$$" > "$HOME/running"
exec /bin/sleep 10
"#,
        );
        let cwd = fixture.home().join("cwd");
        let running = fixture.home().join("running");
        let (pid, cwd) = timeout(Duration::from_secs(3), async {
            tokio::select! {
                result = run_broker(command) => panic!("fake broker did not block: {:?}", result.err()),
                ready = wait_for(|| {
                    let pid: i32 = fs::read_to_string(&running).ok()?.trim_end().parse().ok()?;
                    let cwd = PathBuf::from(fs::read_to_string(&cwd).unwrap().trim_end());
                    let mode = fs::metadata(&cwd).unwrap().permissions().mode() & 0o777;
                    assert_eq!(mode & 0o077, 0);
                    assert!(cwd.canonicalize().unwrap().starts_with(fs::canonicalize("/tmp").unwrap()));
                    assert!(!fifo_closed(&fifo));
                    Some((Pid::from_raw(pid), cwd))
                }) => ready,
            }
        })
        .await
        .expect("fake broker did not report ready");
        assert!(!cwd.exists());
        timeout(
            Duration::from_secs(3),
            wait_for(|| (kill(pid, None) == Err(Errno::ESRCH) && fifo_closed(&fifo)).then_some(())),
        )
        .await
        .expect("cancelled broker or its descendant was left running");
    }

    fn fifo_closed(mut fifo: &File) -> bool {
        match fifo.read(&mut [0]) {
            Ok(0) => true,
            Err(error) if error.kind() == ErrorKind::WouldBlock => false,
            result => panic!("unexpected fake child pipe result: {result:?}"),
        }
    }

    async fn wait_for<T>(mut check: impl FnMut() -> Option<T>) -> T {
        loop {
            if let Some(value) = check() {
                return value;
            }
            yield_now().await;
        }
    }
}
