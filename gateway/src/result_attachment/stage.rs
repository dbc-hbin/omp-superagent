use std::{
    fs::{self, File, Permissions},
    io::{self, Read, Write},
    os::{fd::OwnedFd, unix::fs::PermissionsExt},
    path::{Path, PathBuf},
    sync::LazyLock,
    time::Duration,
};

use anyhow::{Result, ensure};
use nix::{
    errno::Errno,
    fcntl::{OFlag, openat},
    sys::stat::Mode,
    unistd::{LinkatFlags, UnlinkatFlags, linkat, unlinkat},
};
use regex::Regex;
use rusqlite::{Connection, OpenFlags};
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::{FILE_LIMIT, SPOOL, Snapshot, file_identity, same_file, spool, valid_id, valid_name};
use crate::store::js_trim;

mod source;
use source::{Source, UNREADABLE};

const WIRE_LIMIT: u64 = 64 * 1024;
const CHANGED: &str = "The attachment changed during staging";
const SPOOL_ERROR: &str = "The private result attachment snapshot could not be persisted";

static PATH_CONTROLS: LazyLock<Result<Regex, regex::Error>> =
    LazyLock::new(|| Regex::new(r"[\p{Cc}\p{Cf}\\]"));

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", rename_all_fields = "camelCase", deny_unknown_fields)]
enum Command {
    Stage { state_dir: PathBuf, cwd: PathBuf, path: String, private_paths: Vec<PathBuf> },
    Discard { state_dir: PathBuf, snapshot_id: String },
    Prune { state_dir: PathBuf },
}

/// Private, bounded stdin protocol used only by the authorized native head.
pub fn run_stage() -> Result<()> {
    let mut input = Vec::new();
    io::stdin().lock().take(WIRE_LIMIT + 1).read_to_end(&mut input)?;
    let command = if u64::try_from(input.len())? > WIRE_LIMIT {
        Err("Invalid native result attachment request")
    } else {
        serde_json::from_slice::<Command>(&input).map_err(|_| "Invalid native result attachment request")
    };
    let result = command.and_then(|command| match command {
        Command::Stage { state_dir, cwd, path, mut private_paths } => {
            private_paths.push(state_dir.clone());
            stage(&state_dir, &cwd, &path, &private_paths).map(|receipt| Some((state_dir, receipt)))
        }
        Command::Discard { state_dir, snapshot_id } => {
            discard(&state_dir, &snapshot_id).map(|()| None).map_err(|_| SPOOL_ERROR)
        }
        Command::Prune { state_dir } => {
            prune(&state_dir).map(|()| None).map_err(|_| SPOOL_ERROR)
        }
    });
    match result {
        Ok(Some((state_dir, receipt))) => {
            if let Err(error) = reply(&json!({"ok":true,"value":receipt})) {
                // A crashed HEAD cannot consume the receipt. Leave any blob
                // that cannot be removed here to the startup orphan sweep.
                if let Err(cleanup) = discard(&state_dir, &receipt.snapshot_id) {
                    eprintln!("Could not discard undeliverable result snapshot: {cleanup}");
                }
                return Err(error);
            }
        }
        Ok(None) => reply(&json!({"ok":true,"value":null}))?,
        Err(error) => reply(&json!({"ok":false,"error":error}))?,
    }
    Ok(())
}

fn reply(value: &serde_json::Value) -> Result<()> {
    let mut stdout = io::stdout().lock();
    serde_json::to_writer(&mut stdout, value)?;
    stdout.flush()?;
    Ok(())
}

pub(crate) fn stage(state_dir: &Path, cwd: &Path, path: &str, private_paths: &[PathBuf]) -> Result<Snapshot, &'static str> {
    let parts: Vec<_> = path.split('/').collect();
    let Some((name, directories)) = parts.split_last() else { return Err(UNREADABLE) };
    if path.encode_utf16().count() > 1024 || !PATH_CONTROLS.as_ref().is_ok_and(|regex| !regex.is_match(path))
        || parts.iter().any(|part| part.is_empty() || part.starts_with('.') || js_trim(part) != *part)
        || !cwd.is_absolute() || private_paths.iter().any(|p| !p.is_absolute()) {
        return Err("Use a literal, non-hidden workspace-relative file path");
    }
    if !valid_name(name) {
        return Err("The result attachment has an unsupported filename");
    }
    let workspace = Source { cwd, directories, name, private_paths };
    let mut source = workspace.open()?;
    let size = source.observed.stat.len();
    if !(1..=FILE_LIMIT).contains(&size) {
        return Err("Result attachments must be nonempty and at most 8 MiB");
    }
    let state_dir = fs::canonicalize(state_dir).map_err(|_| SPOOL_ERROR)?;
    let directory = spool(&state_dir, true).map_err(|_| SPOOL_ERROR)?.ok_or(SPOOL_ERROR)?;
    let mut pending = Pending::create(directory).map_err(|_| SPOOL_ERROR)?;
    let mut digest = Sha256::new();
    let mut consumed = 0;
    let mut buffer = [0_u8; 32 * 1024];
    let mut input = (&mut source.file).take(size + 1);
    loop {
        let got = input.read(&mut buffer).map_err(|_| UNREADABLE)?;
        if got == 0 {
            break;
        }
        consumed += u64::try_from(got).map_err(|_| CHANGED)?;
        if consumed > size {
            return Err(CHANGED);
        }
        pending.file.write_all(&buffer[..got]).map_err(|_| SPOOL_ERROR)?;
        digest.update(&buffer[..got]);
    }
    let after = workspace.inspect()?;
    if consumed != size || after.ancestors != source.observed.ancestors
        || !same_file(&source.observed.stat, &after.stat)
        || !same_file(&source.observed.stat, &source.file.metadata().map_err(|_| UNREADABLE)?) {
        return Err(CHANGED);
    }
    let (snapshot_id, file_identity) = pending.publish().map_err(|_| SPOOL_ERROR)?;
    Ok(Snapshot { name: (*name).to_owned(), size, sha256: hex::encode(digest.finalize()), snapshot_id, file_identity })
}

struct Pending {
    directory: OwnedFd,
    id: String,
    temporary: String,
    file: File,
    linked: bool,
    committed: bool,
}

impl Pending {
    fn create(directory: OwnedFd) -> Result<Self> {
        let id = Uuid::new_v4().simple().to_string();
        let temporary = format!("{id}.part");
        let file = File::from(openat(&directory, temporary.as_str(),
            OFlag::O_WRONLY | OFlag::O_CLOEXEC | OFlag::O_CREAT | OFlag::O_EXCL | OFlag::O_NOFOLLOW,
            Mode::S_IRUSR | Mode::S_IWUSR)?);
        Ok(Self { directory, id, temporary, file, linked: false, committed: false })
    }

    fn publish(&mut self) -> Result<(String, String)> {
        self.file.set_permissions(Permissions::from_mode(0o400))?;
        self.file.sync_all()?;
        linkat(&self.directory, self.temporary.as_str(), &self.directory, self.id.as_str(), LinkatFlags::empty())?;
        self.linked = true;
        unlinkat(&self.directory, self.temporary.as_str(), UnlinkatFlags::NoRemoveDir)?;
        // Persist the final entry before returning a receipt.
        nix::unistd::fsync(&self.directory)?;
        let identity = file_identity(&self.file.metadata()?);
        self.committed = true;
        Ok((self.id.clone(), identity))
    }
}

impl Drop for Pending {
    fn drop(&mut self) {
        if !self.committed {
            if self.linked && let Err(error) = unlink_if_present(&self.directory, &self.id) {
                eprintln!("Could not discard failed result snapshot: {error}");
            }
            if let Err(error) = unlink_if_present(&self.directory, &self.temporary) {
                eprintln!("Could not discard incomplete result snapshot: {error}");
            }
        }
    }
}

fn unlink_if_present(directory: &OwnedFd, name: &str) -> Result<()> {
    match unlinkat(directory, name, UnlinkatFlags::NoRemoveDir) {
        Ok(()) | Err(Errno::ENOENT) => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn discard(state_dir: &Path, id: &str) -> Result<()> {
    ensure!(valid_id(id), "Invalid result snapshot identity");
    let state_dir = fs::canonicalize(state_dir)?;
    if let Some(directory) = spool(&state_dir, false)?
        && !coordination(&state_dir)?.query_row(REFERENCED, [id], |row| row.get::<_, bool>(0))? {
        unlink_if_present(&directory, id)?;
    }
    Ok(())
}

const REFERENCED: &str =
    "SELECT EXISTS(SELECT 1 FROM outputs WHERE result_attachment IS NOT NULL
      AND state IN ('pending','sending','uncertain')
      AND json_extract(result_attachment, '$.payload.snapshotId') = ?)";

fn coordination(state_dir: &Path) -> Result<Connection> {
    let db = Connection::open_with_flags(state_dir.join("coordination.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NOFOLLOW)?;
    db.busy_timeout(Duration::from_secs(2))?;
    Ok(db)
}

/// Only called before the sole HEAD outbox writer starts processing inputs.
fn prune(state_dir: &Path) -> Result<()> {
    let state_dir = fs::canonicalize(state_dir)?;
    let Some(directory) = spool(&state_dir, false)? else { return Ok(()) };
    let db = coordination(&state_dir)?;
    let mut referenced = db.prepare(REFERENCED)?;
    for entry in fs::read_dir(state_dir.join(SPOOL))? {
        let name = entry?.file_name();
        let Some(name) = name.to_str() else { continue };
        if name.strip_suffix(".part").is_some_and(valid_id)
            || valid_id(name) && !referenced.query_row([name], |row| row.get::<_, bool>(0))? {
            unlink_if_present(&directory, name)?;
        }
    }
    Ok(())
}
