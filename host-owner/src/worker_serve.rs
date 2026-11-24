use std::{
    env,
    ffi::OsString,
    fs::File,
    io,
    os::{fd::{AsFd, OwnedFd}, unix::{fs::FileTypeExt, net::UnixStream as StdUnixStream}},
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use anyhow::{Context, Result, ensure};
use rustix::io::fcntl_dupfd_cloexec;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::{UnixStream, unix::pipe},
    process::Command,
    time::timeout,
};

use crate::worker_attach::{AttachPermit, Attached};

const COMMAND: &str = "omp-sa-worker-v1";
const HEADER_BYTES: usize = 64 * 1024;
const CHUNK_BYTES: usize = 16 * 1024;

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum Preparation {
    Reply { reply: Value },
    Attach(AttachPermit),
}

pub(crate) async fn run(args: impl Iterator<Item = OsString>) -> Result<()> {
    let argv = args.map(PathBuf::from).collect::<Vec<_>>();
    let [bun, helper, policy] = argv.as_slice() else {
        anyhow::bail!("Invalid worker transport invocation");
    };
    ensure!(
        argv.iter().all(|path| path.is_absolute()) && env::var("SSH_ORIGINAL_COMMAND").as_deref() == Ok(COMMAND),
        "Worker serve requires the enrolled SSH forced command"
    );

    let mut input: Box<dyn AsyncRead + Unpin> = match descriptor(io::stdin()).context("Opening worker input")? {
        Descriptor::Pipe(fd) => Box::new(pipe::Receiver::from_owned_fd(fd).context("Opening worker input pipe")?),
        Descriptor::Socket(stream) => Box::new(stream),
        Descriptor::File(file) => Box::new(file),
    };
    let mut output: Box<dyn AsyncWrite + Unpin> = match descriptor(io::stdout()).context("Opening worker output")? {
        Descriptor::Pipe(fd) => Box::new(pipe::Sender::from_owned_fd(fd).context("Opening worker output pipe")?),
        Descriptor::Socket(stream) => Box::new(stream),
        Descriptor::File(file) => Box::new(file),
    };
    let (header, buffered) = match timeout(Duration::from_secs(10), read_header(&mut input)).await {
        Err(_) => return write_reply(&mut output, refusal("Worker request header timed out")).await,
        Ok(Err(error)) => return write_reply(&mut output, refusal(&error.to_string())).await,
        Ok(Ok(request)) => request,
    };
    match prepare(bun, helper, policy, &header).await? {
        Preparation::Reply { reply } => write_reply(&mut output, reply).await,
        Preparation::Attach(permit) => match permit.connect(policy, &header).await {
            Ok(attached) => relay(input, output, attached, &buffered).await,
            Err(error) => {
                let message = if error.is::<tokio::time::error::Elapsed>() {
                    "Worker socket attach timed out"
                } else {
                    "Worker lane changed before attach"
                };
                write_reply(&mut output, refusal(message)).await
            }
        },
    }
}

fn refusal(message: &str) -> Value {
    json!({"ok": false, "error": message})
}

async fn read_header(input: &mut (impl AsyncRead + Unpin)) -> Result<(Vec<u8>, Vec<u8>)> {
    let mut header = Vec::new();
    let mut chunk = [0_u8; CHUNK_BYTES];
    loop {
        let count = input.read(&mut chunk).await.context("Worker could not verify the operation")?;
        ensure!(count != 0, "Worker request ended before its header");
        let bytes = &chunk[..count];
        if let Some(end) = bytes.iter().position(|&byte| byte == b'\n') {
            ensure!(header.len() + end < HEADER_BYTES, "Worker request exceeds header limit");
            header.extend_from_slice(&bytes[..end]);
            return Ok((header, bytes[end + 1..].to_vec()));
        }
        ensure!(header.len() + count < HEADER_BYTES, "Worker request exceeds header limit");
        header.extend_from_slice(bytes);
    }
}

async fn prepare(bun: &Path, helper: &Path, policy: &Path, header: &[u8]) -> Result<Preparation> {
    let mut child = Command::new(bun)
        .arg("--no-env-file")
        .arg(helper)
        .arg(policy)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .context("Could not start worker admission helper")?;
    let mut stdin = child.stdin.take().context("Missing worker admission input")?;
    let stdout = child.stdout.take().context("Missing worker admission output")?;
    timeout(Duration::from_secs(60), async {
        let mut bounded = stdout.take(u64::try_from(2 * HEADER_BYTES + 1)?);
        let mut reply = Vec::new();
        let exchange = async {
            stdin.write_all(header).await?;
            stdin.write_all(b"\n").await?;
            drop(stdin);
            child.wait().await
        };
        let (_, status) = tokio::try_join!(bounded.read_to_end(&mut reply), exchange)
            .context("Worker admission helper disconnected")?;
        ensure!(status.success() && reply.len() <= 2 * HEADER_BYTES, "Worker admission helper did not return a bounded receipt");
        serde_json::from_slice(&reply).context("Invalid worker admission receipt")
    })
    .await
    .context("Worker admission helper timed out")?
}

async fn relay(
    mut input: impl AsyncRead + Unpin,
    mut output: impl AsyncWrite + Unpin,
    attached: Attached,
    buffered: &[u8],
) -> Result<()> {
    let Attached { mut peer, prelude, reply } = attached;
    write_reply(&mut output, reply).await?;
    let (mut from_peer, mut to_peer) = tokio::io::split(&mut peer);
    let upstream = async {
        // These bytes were read with the SSH header, not by the admission helper.
        to_peer.write_all(buffered).await?;
        tokio::io::copy(&mut input, &mut to_peer).await
    };
    let downstream = async {
        output.write_all(&prelude).await?;
        tokio::io::copy(&mut from_peer, &mut output).await
    };
    // Losing either transport detaches just this peer. Dropping both halves
    // cancels pending writes and never sends a Host lifecycle command.
    match tokio::select! { result = upstream => result, result = downstream => result } {
        Ok(_) => Ok(()),
        Err(error) if matches!(error.kind(), io::ErrorKind::BrokenPipe | io::ErrorKind::ConnectionReset) => Ok(()),
        Err(error) => Err(error).context("Worker attachment disconnected"),
    }
}

enum Descriptor {
    Pipe(OwnedFd),
    Socket(UnixStream),
    File(tokio::fs::File),
}

fn descriptor(fd: impl AsFd) -> io::Result<Descriptor> {
    let file = File::from(fcntl_dupfd_cloexec(fd, 3)?);
    let kind = file.metadata()?.file_type();
    if kind.is_fifo() {
        return Ok(Descriptor::Pipe(file.into()));
    }
    if kind.is_socket() {
        let stream = StdUnixStream::from(OwnedFd::from(file));
        stream.set_nonblocking(true)?;
        return UnixStream::from_std(stream).map(Descriptor::Socket);
    }
    // Files and /dev/null are direct redirects, not pollable SSH pipes or socketpairs.
    Ok(Descriptor::File(tokio::fs::File::from_std(file)))
}

async fn write_reply(output: &mut (impl AsyncWrite + Unpin), reply: Value) -> Result<()> {
    let mut bytes = serde_json::to_vec(&reply)?;
    if bytes.len() >= HEADER_BYTES {
        bytes = serde_json::to_vec(&refusal("Worker response exceeds header limit"))?;
    }
    bytes.push(b'\n');
    output.write_all(&bytes).await.context("Writing worker response")?;
    output.flush().await.context("Flushing worker response")
}
