//! One-shot operator REST calls. No daemon, adapter session or listener is started.
mod discord;
mod slack;
mod telegram;

use std::{
    env, fs::File, io,
    os::{fd::{AsFd, OwnedFd}, unix::{fs::FileTypeExt, net::UnixStream as StdUnixStream}},
    time::Duration,
};

use anyhow::{Context, Result, bail, ensure};
use nix::unistd::{Pid, getppid};
use reqwest::{Client, RequestBuilder, Response, redirect::Policy};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, BufReader},
    net::{UnixStream, unix::pipe},
};

use crate::commands::catalog;

struct Api {
    client: Client,
    parent: Pid,
    discord: String,
    telegram: String,
    slack: String,
    bot: String,
    manifest: Option<String>,
}

impl Api {
    async fn send(&self, request: RequestBuilder) -> Option<Response> {
        // The outer lease interrupts requests while pending. Recheck here
        // too: a fresh request must not start as a prior response completes.
        if getppid() != self.parent {
            return None;
        }
        request.send().await.ok()
    }
}

fn redact(text: &str, secrets: &[&str], websocket: bool) -> String {
    let mut text = text.to_owned();
    for &secret in secrets {
        if !secret.is_empty() {
            text = text.replace(secret, "[redacted]");
        }
    }
    // Match the CLI's JS whitespace boundaries, including BOM but not NEL.
    let space = |c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}';
    let mut result = String::with_capacity(text.len());
    for part in text.split_inclusive(space) {
        let word = part.trim_end_matches(space);
        let lower = word.to_ascii_lowercase();
        let start = ["http://", "https://", "ws://", "wss://"].into_iter()
            .filter(|scheme| websocket || scheme.starts_with('h'))
            .filter_map(|scheme| lower.find(scheme).filter(|&i| i + scheme.len() < word.len()))
            .min();
        if let Some(i) = start {
            result.push_str(&word[..i]);
            result.push_str("[redacted-url]");
            result.push_str(&part[word.len()..]);
        } else {
            result.push_str(part);
        }
    }
    result
}

async fn run(op: &str, loopback_port: Option<u16>, request: Value, parent: Pid) -> Result<Value, &'static str> {
    let bot = env::var("OMP_SA_OPERATOR_BOT")
        .ok()
        .filter(|s| !s.is_empty() && !s.contains(['\r', '\n']))
        .ok_or("Invalid operator bot credential")?;
    let client = Client::builder()
        .redirect(Policy::none())
        .retry(reqwest::retry::never())
        .no_proxy()
        .timeout(Duration::from_secs(45))
        .build()
        .map_err(|_| "Cannot initialize operator HTTP client")?;
    let mut api = Api {
        client,
        parent,
        discord: "https://discord.com/api/v10".into(),
        telegram: "https://api.telegram.org".into(),
        slack: "https://slack.com/api".into(),
        bot,
        manifest: env::var("OMP_SA_OPERATOR_MANIFEST").ok(),
    };
    // Only the test executable passes a port; the installed CLI accepts no endpoint override.
    if let Some(port) = loopback_port {
        api.telegram = format!("http://127.0.0.1:{port}");
        api.discord = format!("{}/api/v10", api.telegram);
        api.slack = format!("{}/api", api.telegram);
    }
    match op {
        "discord-commands" | "discord-avatar" => discord::run(op, &request, &api).await,
        "telegram-commands" | "telegram-avatar" => telegram::run(op, &request, &api).await,
        "slack-commands" => slack::run(op, &request, &api).await,
        _ => Err("Unknown operator action"),
    }
}

async fn serve(input: impl AsyncRead + Unpin, operation: &str, loopback_port: Option<u16>) -> Result<()> {
    let parent = env::var("OMP_SA_OPERATOR_PARENT").ok()
        .and_then(|pid| pid.parse::<i32>().ok())
        .filter(|&pid| pid > 1)
        .map(Pid::from_raw)
        .context("Native operator requires a live CLI parent")?;
    ensure!(getppid() == parent, "Native operator lost its CLI parent");
    let mut input = BufReader::new(input);
    let mut frame = Vec::new();
    input.read_until(b'\n', &mut frame).await?;
    ensure!(frame.last() == Some(&b'\n'), "Incomplete operator request; no mutation was attempted");
    let request = match serde_json::from_slice(&frame) {
        Ok(request) => request,
        Err(_) => {
            println!("{}", json!({"ok": false, "error": "Invalid operator request; no mutation was attempted"}));
            bail!("Invalid operator request");
        }
    };
    drop(frame);
    let mut extra = [0_u8; 1];
    let result = tokio::select! {
        biased;
        // The protocol has one input frame. EOF, malformed trailing input,
        // or a pipe error all revoke the lease without a misleading receipt.
        _ = input.read(&mut extra) => bail!("Native operator lost its CLI lease"),
        result = run(operation, loopback_port, request, parent) => result,
    };
    ensure!(getppid() == parent, "Native operator lost its CLI parent");
    match result {
        Ok(value) => println!("{}", json!({"ok":true, "value":value})),
        Err(error) => {
            println!("{}", json!({"ok":false, "error":error}));
            bail!("Operator action failed");
        }
    }
    Ok(())
}

pub fn stdio(operation: &str, loopback_port: Option<u16>) -> Result<()> {
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build()?;
    runtime.block_on(async {
        let input = File::from(io::stdin().as_fd().try_clone_to_owned()?);
        let kind = input.metadata()?.file_type();
        if kind.is_fifo() {
            serve(pipe::Receiver::from_owned_fd(input.into())?, operation, loopback_port).await
        } else if kind.is_socket() {
            let stream = StdUnixStream::from(OwnedFd::from(input));
            stream.set_nonblocking(true)?;
            serve(UnixStream::from_std(stream)?, operation, loopback_port).await
        } else {
            bail!("Native operator requires a private CLI pipe");
        }
    })
}
