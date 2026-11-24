use std::{
    fs,
    io,
    os::unix::fs::{PermissionsExt, symlink},
    path::{Path, PathBuf},
    time::Duration,
};

use anyhow::{Context as _, Result, ensure};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::oneshot,
    task::JoinHandle,
    time::timeout,
};

use super::{GatewayClient, SocketDir};
use crate::server::attachments::ATTACHMENT_TIMEOUT;

const DEADLINE: Duration = Duration::from_secs(3);
const UPSTREAM_HEADERS: &[u8] =
    b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n";

fn batch(sizes: &[Option<u64>]) -> Value {
    json!({
        "inputId":"original-input",
        "route":{"platform":"telegram","accountId":"bot","authorityId":"owner","guildId":null,"channelId":"chat","threadId":null},
        "attachments": sizes.iter().enumerate().map(|(index, size)| json!({
            "id":format!("path-like/../../{index}"),"url":"fixture","name":"../private-name.txt","size":size
        })).collect::<Vec<_>>()
    })
}

#[tokio::test]
async fn attachment_ipc_streams_only_to_staging_until_eof_and_receipts_a_private_batch() -> Result<()> {
    let (local_url, release, served) = gated_download().await?;
    let root = SocketDir::new()?;
    let spool = root.0.join("attachments");
    let fixture = GatewayClient::connect(&root, local_url).await?;
    let request = batch(&[Some(5)]);
    let mut pending = Box::pin(fixture.call("/attachment", &request));
    tokio::select! {
        _ = wait_for_staged_bytes(&spool) => {}
        response = &mut pending => anyhow::bail!("Receipt arrived before EOF: {:?}", response?),
    }
    assert!(entries(&spool)?.iter().all(|path| path.file_name().is_some_and(|name| name.to_string_lossy().starts_with('.'))));
    release.send(b"2\r\nde\r\n0\r\n\r\n").map_err(|_| anyhow::anyhow!("Upstream closed before EOF"))?;
    let response = pending.await?;
    let receipt = response["value"]["receipt"].as_str().context("Missing completion receipt")?;
    let directory = fs::canonicalize(&spool)?.join(receipt);
    let file = directory.join("0");
    assert_eq!(
        response,
        json!({"ok":true,"value":{"receipt":receipt,"files":[
            {"path":file,"size":5,"mimeType":"application/octet-stream",
             "sha256":"36bbe50ed96841d10443bcb670d6554f0a34b761be67ec9c4a8ad2c0c44ca42c"}
        ]}})
    );
    assert_eq!(fs::read(&file)?, b"abcde");
    assert_eq!(fs::metadata(&file)?.permissions().mode() & 0o777, 0o600);
    assert_eq!(fs::metadata(&directory)?.permissions().mode() & 0o777, 0o700);
    assert_eq!(fs::metadata(&spool)?.permissions().mode() & 0o777, 0o700);
    assert_eq!(entries(&fs::canonicalize(&spool)?)?, [directory]);
    assert!(timeout(DEADLINE, served).await???);
    fixture.server.close().await
}

#[tokio::test]
async fn attachment_ipc_never_publishes_a_truncated_declared_size() -> Result<()> {
    let (local_url, release, served) = gated_download().await?;
    let root = SocketDir::new()?;
    let spool = root.0.join("attachments");
    let fixture = GatewayClient::connect(&root, local_url).await?;
    let request = batch(&[Some(5)]);
    let mut pending = Box::pin(fixture.call("/attachment", &request));
    tokio::select! {
        _ = wait_for_staged_bytes(&spool) => {}
        response = &mut pending => anyhow::bail!("Receipt arrived before EOF: {:?}", response?),
    }
    release.send(b"0\r\n\r\n").map_err(|_| anyhow::anyhow!("Upstream closed before EOF"))?;
    let response = pending.await?;
    assert_eq!(response["certainty"], "rejected");
    assert_eq!(response["error"], "Attachment stream differs from declared size");
    assert!(entries(&spool)?.is_empty());
    assert!(timeout(DEADLINE, served).await???);
    fixture.server.close().await
}

#[tokio::test]
async fn cancelling_the_unix_request_cancels_upstream_and_removes_partial_files() -> Result<()> {
    let (local_url, _release, served) = gated_download().await?;
    let root = SocketDir::new()?;
    let spool = root.0.join("attachments");
    let fixture = GatewayClient::connect(&root, local_url).await?;
    {
        let request = batch(&[Some(5)]);
        let mut pending = Box::pin(fixture.call("/attachment", &request));
        tokio::select! {
            _ = wait_for_staged_bytes(&spool) => {}
            response = &mut pending => anyhow::bail!("Receipt arrived before cancellation: {:?}", response?),
        }
    }
    assert!(!timeout(DEADLINE, served).await???, "Gateway did not cancel the upstream transfer");
    assert!(entries(&spool)?.is_empty());
    fixture.server.close().await
}

#[tokio::test]
async fn attachment_receipts_reuse_an_identical_replay_and_sniff_downloaded_bytes() -> Result<()> {
    let upstream = TcpListener::bind("127.0.0.1:0").await?;
    let local_url = format!("http://{}/", upstream.local_addr()?);
    let served = tokio::spawn(async move {
        for _ in 0..2 {
            let mut peer = accept_download(&upstream).await?;
            peer.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 8\r\nConnection: close\r\n\r\n\x89PNG\r\n\x1a\n").await?;
        }
        Ok::<_, anyhow::Error>(())
    });
    let root = SocketDir::new()?;
    let fixture = GatewayClient::connect(&root, local_url).await?;
    let request = batch(&[None]);
    let first = fixture.call("/attachment", &request).await?;
    let replay = fixture.call("/attachment", &request).await?;
    assert_eq!(first, replay);
    let file = &first["value"]["files"][0];
    let path = file["path"].as_str().context("Missing receipt path")?;
    assert_eq!(file["size"], 8);
    assert_eq!(file["mimeType"], "image/png");
    assert_eq!(fs::read(path)?, b"\x89PNG\r\n\x1a\n");
    let spool = fs::canonicalize(root.0.join("attachments"))?;
    assert_eq!(entries(&spool)?, [Path::new(path).parent().context("Missing spool parent")?.to_path_buf()]);
    timeout(DEADLINE, served).await???;
    fixture.server.close().await
}

#[tokio::test]
async fn attachment_ipc_rejects_path_overrides_and_symlinked_spool_roots() -> Result<()> {
    let root = SocketDir::new()?;
    let target = SocketDir::new()?;
    let fixture = GatewayClient::connect(&root, String::new()).await?;
    let mut request = batch(&[Some(5)]);
    let legacy = json!({"route": request["route"], "attachment": request["attachments"][0]});
    let response = fixture.call("/attachment", &legacy).await?;
    assert_eq!(response["certainty"], "rejected");
    assert_eq!(response["error"], "Invalid attachment request");
    request["path"] = json!(target.0);
    let response = fixture.call("/attachment", &request).await?;
    assert_eq!(response["certainty"], "rejected");
    assert_eq!(response["error"], "Invalid attachment request");
    assert!(!root.0.join("attachments").exists());
    symlink(&target.0, root.0.join("attachments"))?;
    let denied = fixture.call("/attachment", &batch(&[Some(5)])).await?;
    assert_eq!(denied["ok"], false);
    assert_eq!(denied["error"], "Gateway operation failed");
    assert!(entries(&target.0)?.is_empty());
    fixture.server.close().await
}

#[tokio::test]
async fn replacing_a_staged_file_with_a_symlink_cannot_publish_or_modify_its_target() -> Result<()> {
    let (local_url, release, served) = gated_download().await?;
    let root = SocketDir::new()?;
    let target = SocketDir::new()?;
    let outside = target.0.join("outside");
    fs::write(&outside, b"leave this alone")?;
    let spool = root.0.join("attachments");
    let fixture = GatewayClient::connect(&root, local_url).await?;
    let request = batch(&[Some(5)]);
    let mut pending = Box::pin(fixture.call("/attachment", &request));
    let staged = tokio::select! {
        path = wait_for_staged_bytes(&spool) => path,
        response = &mut pending => anyhow::bail!("Receipt arrived before EOF: {:?}", response?),
    };
    let file = staged.join("0");
    fs::remove_file(&file)?;
    symlink(&outside, &file)?;
    release.send(b"2\r\nde\r\n0\r\n\r\n").map_err(|_| anyhow::anyhow!("Upstream closed before EOF"))?;
    assert_eq!(pending.await?["ok"], false);
    assert_eq!(fs::read(&outside)?, b"leave this alone");
    assert_eq!(entries(&spool)?, [staged]);
    assert!(timeout(DEADLINE, served).await???);
    fixture.server.close().await
}

#[tokio::test]
async fn attachment_ipc_bounds_unknown_sizes_per_file_and_per_batch() -> Result<()> {
    for (count, mebibytes) in [(1, 21), (3, 15)] {
        let upstream = TcpListener::bind("127.0.0.1:0").await?;
        let local_url = format!("http://{}/", upstream.local_addr()?);
        let served = tokio::spawn(async move {
            let bytes = vec![0x42; 1024 * 1024];
            for index in 0..count {
                let mut peer = accept_download(&upstream).await?;
                let result = async {
                    peer.write_all(UPSTREAM_HEADERS).await?;
                    for _ in 0..mebibytes {
                        peer.write_all(b"100000\r\n").await?;
                        peer.write_all(&bytes).await?;
                        peer.write_all(b"\r\n").await?;
                    }
                    peer.write_all(b"0\r\n\r\n").await
                }.await;
                if let Err(error) = result {
                    ensure!(index == count - 1 && matches!(error.kind(), io::ErrorKind::BrokenPipe | io::ErrorKind::ConnectionReset), "{error}");
                }
            }
            Ok::<_, anyhow::Error>(())
        });
        let root = SocketDir::new()?;
        let fixture = GatewayClient::connect(&root, local_url).await?;
        // This one reply follows up to three sequential streamed downloads and fsyncs.
        // Don't let the fixture's default IPC timeout preempt the Gateway's per-file deadline.
        let response: Value = fixture
            .request("/attachment", &batch(&vec![None; count]))
            .timeout(ATTACHMENT_TIMEOUT * u32::try_from(count)? + DEADLINE)
            .send()
            .await?
            .json()
            .await?;
        assert_eq!(response["certainty"], "rejected");
        assert_eq!(response["error"], "Attachment stream exceeds the size limit");
        assert!(entries(&root.0.join("attachments"))?.is_empty());
        timeout(DEADLINE, served).await???;
        fixture.server.close().await?;
    }
    Ok(())
}

type GatedUpstream = (String, oneshot::Sender<&'static [u8]>, JoinHandle<Result<bool>>);

async fn gated_download() -> Result<GatedUpstream> {
    let upstream = TcpListener::bind("127.0.0.1:0").await?;
    let local_url = format!("http://{}/", upstream.local_addr()?);
    let (release, gated) = oneshot::channel::<&'static [u8]>();
    let served = tokio::spawn(async move {
        let mut peer = accept_download(&upstream).await?;
        peer.write_all(UPSTREAM_HEADERS).await?;
        peer.write_all(b"3\r\nabc\r\n").await?;
        let mut extra = [0; 1];
        tokio::select! {
            tail = gated => {
                peer.write_all(tail?).await?;
                Ok(true)
            }
            received = peer.read(&mut extra) => {
                ensure!(received? == 0, "Unexpected data from attachment requester");
                Ok(false)
            }
        }
    });
    Ok((local_url, release, served))
}

async fn accept_download(upstream: &TcpListener) -> Result<TcpStream> {
    let (mut peer, _) = upstream.accept().await?;
    let mut request = Vec::new();
    let mut buffer = [0; 1024];
    while !request.ends_with(b"\r\n\r\n") {
        let read = peer.read(&mut buffer).await?;
        ensure!(read != 0, "Local attachment requester disconnected");
        request.extend_from_slice(&buffer[..read]);
    }
    Ok(peer)
}

fn entries(path: &Path) -> io::Result<Vec<PathBuf>> {
    fs::read_dir(path)?.map(|entry| entry.map(|entry| entry.path())).collect()
}

async fn wait_for_staged_bytes(spool: &Path) -> PathBuf {
    timeout(DEADLINE, async {
        loop {
            if let Ok(entries) = entries(spool)
                && let Some(staged) = entries.into_iter().find(|path| {
                    fs::read(path.join("0")).is_ok_and(|bytes| bytes == b"abc")
                })
            {
                break staged;
            }
            tokio::task::yield_now().await;
        }
    }).await.expect("Gateway buffered upstream bytes instead of streaming to disk")
}
