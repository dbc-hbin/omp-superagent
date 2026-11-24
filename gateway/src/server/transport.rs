use std::{
    fs, io,
    os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll},
};

use anyhow::{Result, ensure};
use axum::{
    Extension, Router,
    body::{Body, Bytes},
    http::{HeaderValue, header},
    response::Response,
};
use futures_util::stream;
use hyper::server::conn::http1;
use hyper_util::{
    rt::{TokioIo, TokioTimer},
    service::TowerToHyperService,
};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    net::{UnixListener, UnixStream},
    sync::oneshot,
    task::JoinSet,
};

use super::{
    Hub,
    protocol::{self, WireResult},
};
use crate::store::Store;

pub(crate) mod private_paths;

pub(super) struct SocketIdentity {
    path: PathBuf,
    dev: u64,
    ino: u64,
}

impl SocketIdentity {
    pub(super) fn capture(path: &Path) -> Result<Self> {
        let stat = fs::symlink_metadata(path)?;
        ensure!(
            stat.file_type().is_socket() && stat.uid() == nix::unistd::geteuid().as_raw(),
            "Gateway endpoint is not an owned Unix socket"
        );
        Ok(Self {
            path: path.to_owned(),
            dev: stat.dev(),
            ino: stat.ino(),
        })
    }

    pub(super) fn secure(&self, store: &Store) -> Result<()> {
        fs::set_permissions(&self.path, fs::Permissions::from_mode(0o600))?;
        store.set_meta(
            "gateway:socket",
            &json!({"pid":std::process::id(), "dev":self.dev, "ino":self.ino}).to_string(),
        )
    }

    pub(super) fn unlink(&self) -> Result<()> {
        match fs::symlink_metadata(&self.path) {
            Ok(stat) if stat.dev() == self.dev && stat.ino() == self.ino => {
                fs::remove_file(&self.path)?
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        Ok(())
    }
}

pub(super) fn private_directory(socket_path: &Path) -> Result<()> {
    let directory = socket_path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("Gateway socket has no parent directory"))?;
    let stat = fs::symlink_metadata(directory)?;
    ensure!(
        stat.is_dir()
            && stat.uid() == nix::unistd::geteuid().as_raw()
            && stat.mode() & 0o777 == 0o700,
        "Gateway socket directory is not private and owned"
    );
    Ok(())
}

pub(super) async fn serve(
    listener: UnixListener,
    hub: Arc<Hub>,
    mut shutdown: oneshot::Receiver<()>,
) -> Result<()> {
    let router = Router::new()
        .fallback(protocol::handle)
        .with_state(hub.clone());
    let mut peers = JoinSet::new();
    let result = loop {
        tokio::select! {
            biased;
            _ = &mut shutdown => break Ok(()),
            _ = hub.adapters.changed.notified() => {
                if hub.deliver().is_err() {
                    eprintln!("Gateway event delivery failed; inspect private service state");
                }
            }
            Some(peer) = peers.join_next(), if !peers.is_empty() => {
                if peer.is_err() { eprintln!("Gateway peer handler failed"); }
            }
            accepted = listener.accept() => {
                let (socket, _) = match accepted {
                    Ok(peer) => peer,
                    Err(error) => break Err(error.into()),
                };
                let finish = OnFinish::default();
                let service = TowerToHyperService::new(router.clone().layer(Extension(finish.clone())));
                peers.spawn(async move {
                    let stream = WireIo { socket, finish };
                    let outcome = http1::Builder::new()
                        .timer(TokioTimer::new())
                        .serve_connection(TokioIo::new(stream), service)
                        .await;
                    // Unavailable/truncated local peers, forced stream closure
                    // and authorized receiver cancellation are normal.
                    if outcome.is_err_and(|error| error.is_parse()) {
                        eprintln!("Gateway received an invalid HTTP request");
                    }
                });
            }
        }
    };
    peers.shutdown().await;
    result
}

type Finish = Box<dyn FnOnce() + Send>;

#[derive(Clone, Default)]
pub(super) struct OnFinish(Arc<Mutex<Vec<Finish>>>);

impl OnFinish {
    pub(super) fn json(
        self,
        value: &Value,
        finish: impl FnOnce() + Send + 'static,
    ) -> WireResult<Response> {
        let bytes = Bytes::from(serde_json::to_vec(value).map_err(anyhow::Error::from)?);
        let length = HeaderValue::from(bytes.len());
        let body = stream::once(async move {
            self.0
                .lock()
                .map_err(|_| io::Error::other("Gateway response finish lock was poisoned"))?
                .push(Box::new(finish));
            Ok::<_, io::Error>(bytes)
        });
        let mut response = Response::new(Body::from_stream(body));
        response.headers_mut().insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );
        response
            .headers_mut()
            .insert(header::CONTENT_LENGTH, length);
        Ok(response)
    }
}

struct WireIo {
    socket: UnixStream,
    finish: OnFinish,
}

impl AsyncRead for WireIo {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.socket).poll_read(cx, buf)
    }
}

impl AsyncWrite for WireIo {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        data: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.socket).poll_write(cx, data)
    }

    fn poll_write_vectored(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        iov: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.socket).poll_write_vectored(cx, iov)
    }

    fn is_write_vectored(&self) -> bool {
        self.socket.is_write_vectored()
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        std::task::ready!(Pin::new(&mut self.socket).poll_flush(cx))?;
        // Hyper's HTTP/1 buffer calls underlying poll_flush only after all
        // queued response bytes were written. Body poll alone isn't a finish
        // receipt: disconnects must not trigger lifecycle execution.
        let finishes = std::mem::take(
            &mut *self
                .finish
                .0
                .lock()
                .map_err(|_| io::Error::other("Gateway response finish lock was poisoned"))?,
        );
        for finish in finishes {
            finish();
        }
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.socket).poll_shutdown(cx)
    }
}
