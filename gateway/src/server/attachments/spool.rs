use std::{
    ffi::OsStr,
    fs::{File, Metadata},
    io,
    os::fd::{AsFd, OwnedFd},
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
};

use nix::{
    fcntl::{AtFlags, OFlag, openat, renameat},
    sys::stat::{Mode, fstat, fstatat, mkdirat},
    unistd::{UnlinkatFlags, fsync, geteuid, unlinkat},
};
use sha2::{Digest, Sha256};
use tokio::{fs, io::AsyncReadExt};
use uuid::Uuid;

use super::Download;
use crate::server::transport::private_paths::{
    PRIVATE_DIRECTORY_MODE, ensure_private_directory, open_child, open_directory, private_child,
};

mod recovery;
pub(in crate::server) use recovery::recover;

const PRIVATE_FILE_MODE: Mode = Mode::S_IRUSR.union(Mode::S_IWUSR);
const SAFE_FILE: OFlag = OFlag::O_NOFOLLOW.union(OFlag::O_CLOEXEC);

/// A private, exclusively created batch. Closing the HTTP connection drops
/// this guard (the transfer is not detached from its request).
pub(super) struct Spool {
    path: PathBuf,
    root: OwnedFd,
    staging: Batch,
    outstanding: Option<String>,
}

pub(super) struct Batch {
    directory: OwnedFd,
    files: Vec<File>,
}

impl Spool {
    pub(super) fn new(state_dir: &Path) -> io::Result<Self> {
        let state = open_directory(state_dir)?;
        ensure_private_directory(&state)?;
        let root = private_child(&state, "attachments")?;
        let name = format!(".{}.download", Uuid::new_v4());
        mkdirat(&root, name.as_str(), PRIVATE_DIRECTORY_MODE)?;
        let staging = open_child(&root, OsStr::new(&name)).inspect_err(|_| {
            if unlinkat(&root, name.as_str(), UnlinkatFlags::RemoveDir).is_err() {
                eprintln!("Could not clean up an unopened attachment batch");
            }
        })?;
        let spool = Self {
            path: state_dir.join("attachments"),
            root,
            staging: Batch {
                directory: staging,
                files: Vec::new(),
            },
            outstanding: Some(name),
        };
        ensure_private_directory(&spool.staging.directory)?;
        Ok(spool)
    }

    pub(super) fn path(&self) -> &Path {
        &self.path
    }

    pub(super) fn create_file(&mut self) -> io::Result<fs::File> {
        let name = self.staging.files.len().to_string();
        let fd = openat(
            &self.staging.directory,
            name.as_str(),
            SAFE_FILE | OFlag::O_WRONLY | OFlag::O_CREAT | OFlag::O_EXCL,
            PRIVATE_FILE_MODE,
        )?;
        let writer = File::from(fd);
        let pinned = writer.try_clone().inspect_err(|_| {
            if unlinkat(
                &self.staging.directory,
                name.as_str(),
                UnlinkatFlags::NoRemoveDir,
            )
            .is_err()
            {
                eprintln!("Could not clean up an unpinned attachment file");
            }
        })?;
        self.staging.files.push(pinned);
        // Set exact private permissions by FD, independently of process umask.
        nix::sys::stat::fchmod(&writer, PRIVATE_FILE_MODE)?;
        Ok(fs::File::from_std(writer))
    }

    pub(super) async fn check_replay(
        &self,
        receipt: &str,
        files: &[Download],
    ) -> io::Result<Option<Batch>> {
        let existing = match open_child(&self.root, OsStr::new(receipt)) {
            Ok(existing) => existing,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        ensure_private_directory(&existing)?;
        let mut pinned = Vec::with_capacity(files.len());
        let mut buffer = vec![0; 64 * 1024];
        for (index, download) in files.iter().enumerate() {
            let fd = openat(
                &existing,
                index.to_string().as_str(),
                SAFE_FILE | OFlag::O_RDONLY | OFlag::O_NONBLOCK,
                Mode::empty(),
            )?;
            let file = File::from(fd);
            if private_file_metadata(&file)?.len() != download.size {
                return Err(io::Error::other("Published attachment size changed"));
            }
            pinned.push(file.try_clone()?);
            let mut file = fs::File::from_std(file).take(download.size + 1);
            let mut digest = Sha256::new();
            loop {
                let count = file.read(&mut buffer).await?;
                if count == 0 {
                    break;
                }
                digest.update(&buffer[..count]);
            }
            if <[u8; 32]>::from(digest.finalize()) != download.digest {
                return Err(io::Error::other("Published attachment contents changed"));
            }
        }
        Ok(Some(Batch {
            directory: existing,
            files: pinned,
        }))
    }

    pub(super) fn verify_replay(&self, receipt: &str, existing: &Batch) -> io::Result<()> {
        self.verify_root()?;
        ensure_private_directory(&existing.directory)?;
        if !same_entry(&self.root, receipt, &existing.directory)? {
            return Err(io::Error::other("Published attachment directory changed"));
        }
        for (index, file) in existing.files.iter().enumerate() {
            private_file_metadata(file)?;
            if !same_entry(&existing.directory, &index.to_string(), file)? {
                return Err(io::Error::other("Published attachment file changed"));
            }
        }
        Ok(())
    }

    pub(super) fn publish(&mut self, receipt: &str) -> io::Result<()> {
        let name = self.outstanding.as_deref().ok_or_else(|| {
            io::Error::other("Attachment spool already published")
        })?;
        self.verify_replay(name, &self.staging)?;
        fsync(&self.staging.directory)?;
        // Both names are descriptor-relative; rename does not follow either
        // leaf and cannot replace an existing non-empty published batch.
        renameat(&self.root, name, &self.root, receipt)?;
        self.outstanding = Some(receipt.to_owned());
        self.verify_replay(receipt, &self.staging)?;
        fsync(&self.root)?;
        self.outstanding = None;
        Ok(())
    }

    fn verify_root(&self) -> io::Result<()> {
        let current = open_directory(&self.path)?;
        ensure_private_directory(&current)?;
        let current = fstat(current)?;
        let pinned = fstat(&self.root)?;
        if (current.st_dev, current.st_ino) != (pinned.st_dev, pinned.st_ino) {
            return Err(io::Error::other("Attachment spool directory changed"));
        }
        Ok(())
    }
}

impl Drop for Spool {
    fn drop(&mut self) {
        if let Some(name) = &self.outstanding {
            for (index, file) in self.staging.files.iter().enumerate() {
                let index = index.to_string();
                if same_entry(&self.staging.directory, &index, file).unwrap_or(false)
                    && unlinkat(&self.staging.directory, index.as_str(), UnlinkatFlags::NoRemoveDir).is_err()
                {
                    eprintln!("Could not clean up an incomplete attachment file");
                }
            }
            if same_entry(&self.root, name, &self.staging.directory).unwrap_or(false)
                && unlinkat(&self.root, name.as_str(), UnlinkatFlags::RemoveDir).is_err()
            {
                eprintln!("Could not clean up an incomplete attachment batch");
            }
        }
    }
}

fn private_file_metadata(file: &File) -> io::Result<Metadata> {
    let metadata = file.metadata()?;
    if !metadata.is_file()
        || metadata.uid() != geteuid().as_raw()
        || metadata.mode() & 0o777 != 0o600
        || metadata.nlink() != 1
    {
        return Err(io::Error::other("Attachment file is not private and owned"));
    }
    Ok(metadata)
}

fn same_entry(parent: &OwnedFd, name: &str, entry: impl AsFd) -> io::Result<bool> {
    let pinned = fstat(entry)?;
    let current = fstatat(parent, name, AtFlags::AT_SYMLINK_NOFOLLOW)?;
    Ok((pinned.st_dev, pinned.st_ino) == (current.st_dev, current.st_ino))
}
