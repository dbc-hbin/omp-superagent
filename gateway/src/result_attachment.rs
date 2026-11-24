//! Native result-attachment staging and verification. No workspace path reaches an upload.
use std::{
    fs::{File, Metadata},
    io::Read,
    os::{fd::{AsFd, OwnedFd}, unix::fs::{MetadataExt, PermissionsExt}},
    path::Path,
    sync::LazyLock,
};

use anyhow::{Result, ensure};
use base64::{Engine, prelude::BASE64_STANDARD};
use nix::{fcntl::{AtFlags, OFlag, openat}, sys::stat::{Mode, SFlag, fstatat}};
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    adapter::EffectError,
    server::transport::private_paths::{ensure_private_directory, open_directory, private_child},
    store::js_trim,
};

mod stage;
pub use stage::run_stage;
#[cfg(test)]
pub(crate) use stage::stage;

const FILE_LIMIT: u64 = 8 * 1024 * 1024;
const SPOOL: &str = "result-attachments";
const READ_ENTRY: OFlag = OFlag::O_RDONLY.union(OFlag::O_CLOEXEC)
    .union(OFlag::O_NOFOLLOW).union(OFlag::O_NONBLOCK);

static NAME_CHARS: LazyLock<Result<Regex, regex::Error>> =
    LazyLock::new(|| Regex::new(r"\A[\p{L}\p{N}\p{M}_. -]+\z"));

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Snapshot {
    name: String,
    size: u64,
    sha256: String,
    snapshot_id: String,
    file_identity: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct LegacyPayload {
    pub(crate) name: String,
    data: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct LegacyReference {
    pub(crate) name: String,
    pub(crate) legacy: bool,
}

#[derive(Deserialize)]
#[serde(untagged)]
pub(crate) enum Reference {
    Snapshot(Snapshot),
    Legacy(LegacyReference),
}

/// Bytes already verified by the Gateway, never a workspace or spool path.
pub struct VerifiedResultAttachment {
    pub(crate) name: String,
    pub(crate) bytes: Vec<u8>,
}

impl Snapshot {
    pub(crate) fn load(self, state_dir: &Path) -> Result<VerifiedResultAttachment, EffectError> {
        let bytes = self.read(state_dir).map_err(|_| EffectError::rejected(
            "Result attachment snapshot is missing or does not match its receipt",
        ))?;
        Ok(VerifiedResultAttachment { name: self.name, bytes })
    }

    fn read(&self, state_dir: &Path) -> Result<Vec<u8>> {
        ensure!(valid_name(&self.name) && valid_id(&self.snapshot_id)
            && (1..=FILE_LIMIT).contains(&self.size), "Invalid snapshot receipt");
        let directory = spool(state_dir, false)?.ok_or_else(|| anyhow::anyhow!("Missing snapshot directory"))?;
        let initial = entry(&directory, &self.snapshot_id)?;
        ensure!(initial.is_file() && initial.nlink() == 1
            && initial.permissions().mode() & 0o777 == 0o400
            && initial.uid() == nix::unistd::geteuid().as_raw()
            && initial.len() == self.size && file_identity(&initial) == self.file_identity,
            "Snapshot identity changed");
        let mut file = File::from(openat(&directory, self.snapshot_id.as_str(), READ_ENTRY, Mode::empty())?);
        ensure!(same_file(&initial, &file.metadata()?), "Snapshot changed before verification");
        let mut bytes = vec![0; usize::try_from(self.size)?];
        file.read_exact(&mut bytes)?;
        ensure!(file.read(&mut [0])? == 0
            && hex::encode(Sha256::digest(&bytes)) == self.sha256
            && same_file(&initial, &file.metadata()?)
            && same_file(&initial, &entry(&directory, &self.snapshot_id)?),
            "Snapshot content changed");
        Ok(bytes)
    }
}

impl LegacyPayload {
    pub(crate) fn verify(self) -> Result<VerifiedResultAttachment, EffectError> {
        let bound = FILE_LIMIT.div_ceil(3) * 4;
        let invalid = || EffectError::rejected("Invalid persisted legacy result attachment");
        if !valid_name(&self.name) || self.data.is_empty()
            || !u64::try_from(self.data.len()).is_ok_and(|size| size <= bound) {
            return Err(invalid());
        }
        let bytes = BASE64_STANDARD.decode(self.data).map_err(|_| invalid())?;
        if !u64::try_from(bytes.len()).is_ok_and(|size| (1..=FILE_LIMIT).contains(&size)) {
            return Err(invalid());
        }
        Ok(VerifiedResultAttachment { name: self.name, bytes })
    }
}

fn valid_name(name: &str) -> bool {
    !name.starts_with('.') && js_trim(name) == name && name.len() <= 180
        && NAME_CHARS.as_ref().is_ok_and(|regex| regex.is_match(name))
}

fn valid_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| b.is_ascii_digit() || matches!(b, b'a'..=b'f'))
}

fn spool(state_dir: &Path, create: bool) -> Result<Option<OwnedFd>> {
    let parent = open_directory(state_dir)?;
    ensure_private_directory(&parent)?;
    if create {
        return Ok(Some(private_child(&parent, SPOOL)?));
    }
    match openat(&parent, SPOOL, READ_ENTRY | OFlag::O_DIRECTORY, Mode::empty()) {
        Ok(dir) => {
            ensure_private_directory(&dir)?;
            Ok(Some(dir))
        }
        Err(nix::errno::Errno::ENOENT) => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn entry(parent: &OwnedFd, name: &str) -> Result<Metadata> {
    ensure!(entry_type(parent, name)? == SFlag::S_IFREG, "Not a regular file");
    let file = File::from(openat(parent, name, READ_ENTRY, Mode::empty())?);
    Ok(file.metadata()?)
}

fn entry_type(parent: impl AsFd, name: &str) -> Result<SFlag> {
    let stat = fstatat(parent, name, AtFlags::AT_SYMLINK_NOFOLLOW)?;
    Ok(SFlag::from_bits_truncate(stat.st_mode) & SFlag::S_IFMT)
}

fn file_identity(stat: &Metadata) -> String {
    format!("{}:{}", stat.dev(), stat.ino())
}

fn same_entry(a: &Metadata, b: &Metadata) -> bool {
    a.dev() == b.dev() && a.ino() == b.ino()
}

fn same_file(a: &Metadata, b: &Metadata) -> bool {
    same_entry(a, b) && b.is_file() && b.nlink() == 1 && a.mode() == b.mode()
        && a.len() == b.len() && a.mtime() == b.mtime() && a.mtime_nsec() == b.mtime_nsec()
        && a.ctime() == b.ctime() && a.ctime_nsec() == b.ctime_nsec()
}
