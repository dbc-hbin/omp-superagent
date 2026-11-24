use std::{ffi::OsStr, fs::File, io, os::fd::OwnedFd, path::Path};

use nix::{
    dir::Dir,
    errno::Errno,
    fcntl::{AtFlags, OFlag, openat},
    sys::stat::{Mode, SFlag, fstat, fstatat},
    unistd::{UnlinkatFlags, fsync, geteuid, unlinkat},
};
use uuid::{Uuid, Version};

use super::{
    SAFE_FILE, ensure_private_directory, open_child, open_directory, private_file_metadata,
    same_entry,
};
use crate::server::attachments::MAX_ATTACHMENTS;

pub(in crate::server) fn recover(state_dir: &Path) -> io::Result<()> {
    let state = open_directory(state_dir)?;
    let root = match open_child(&state, OsStr::new("attachments")) {
        Ok(root) => root,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    ensure_private_directory(&state)?;
    ensure_private_directory(&root)?;

    let mut directory = Dir::from_fd(root.try_clone()?)?;
    let mut candidates = Vec::new();
    for entry in directory.iter() {
        let entry = entry?;
        if let Ok(name) = entry.file_name().to_str()
            && staging_name(name)
        {
            candidates.push(name.to_owned());
        }
    }
    let mut removed = false;
    for name in candidates {
        removed |= recover_batch(&root, &name)?;
    }
    if removed {
        fsync(&root)?;
    }
    Ok(())
}

fn staging_name(name: &str) -> bool {
    name.strip_prefix('.')
        .and_then(|name| name.strip_suffix(".download"))
        .is_some_and(|name| {
            Uuid::try_parse(name).is_ok_and(|uuid| {
                uuid.get_version() == Some(Version::Random) && uuid.hyphenated().to_string() == name
            })
        })
}

fn recover_batch(root: &OwnedFd, name: &str) -> io::Result<bool> {
    let Some(metadata) = entry_metadata(root, name)? else {
        return Ok(false);
    };
    if SFlag::from_bits_truncate(metadata.st_mode) & SFlag::S_IFMT != SFlag::S_IFDIR
        || metadata.st_mode & 0o7777 != 0o700
        || metadata.st_uid != geteuid().as_raw()
    {
        return Ok(false);
    }
    let stage = open_child(root, OsStr::new(name))?;
    ensure_private_directory(&stage)?;
    let opened = fstat(&stage)?;
    if (metadata.st_dev, metadata.st_ino) != (opened.st_dev, opened.st_ino)
        || !same_entry(root, name, &stage)?
    {
        return Ok(false);
    }

    // Crash leftovers contain only numeric regular files. Identify the whole
    // batch before removing anything; malformed, linked and nested data stays
    // untouched, even under a plausible staging directory name.
    let mut directory = Dir::from_fd(stage.try_clone()?)?;
    let mut files = Vec::new();
    for entry in directory.iter() {
        let entry = entry?;
        let Ok(file_name) = entry.file_name().to_str() else {
            return Ok(false);
        };
        if matches!(file_name, "." | "..") {
            continue;
        }
        if !matches!(file_name.as_bytes(), [b'0'..=b'9']) || files.len() == MAX_ATTACHMENTS {
            return Ok(false);
        }
        let Some(metadata) = entry_metadata(&stage, file_name)? else {
            return Ok(false);
        };
        // Refuse special files before open as well as after it.
        if SFlag::from_bits_truncate(metadata.st_mode) & SFlag::S_IFMT != SFlag::S_IFREG
            || metadata.st_mode & 0o7777 != 0o600
            || metadata.st_uid != geteuid().as_raw()
            || metadata.st_nlink != 1
        {
            return Ok(false);
        }
        let file = File::from(openat(
            &stage,
            file_name,
            SAFE_FILE | OFlag::O_RDONLY | OFlag::O_NONBLOCK,
            Mode::empty(),
        )?);
        private_file_metadata(&file)?;
        let opened = fstat(&file)?;
        if (metadata.st_dev, metadata.st_ino) != (opened.st_dev, opened.st_ino)
            || !same_entry(&stage, file_name, &file)?
        {
            return Ok(false);
        }
        files.push((file_name.to_owned(), file));
    }
    if !same_entry(root, name, &stage)? {
        return Ok(false);
    }
    for (file_name, file) in files {
        if !same_entry(&stage, &file_name, &file)? {
            return Ok(false);
        }
        unlinkat(&stage, file_name.as_str(), UnlinkatFlags::NoRemoveDir)?;
    }
    if !same_entry(root, name, &stage)? {
        return Ok(false);
    }
    unlinkat(root, name, UnlinkatFlags::RemoveDir)?;
    Ok(true)
}

fn entry_metadata(
    directory: &OwnedFd,
    name: &str,
) -> io::Result<Option<nix::sys::stat::FileStat>> {
    match fstatat(directory, name, AtFlags::AT_SYMLINK_NOFOLLOW) {
        Ok(metadata) => Ok(Some(metadata)),
        Err(Errno::ENOENT) => Ok(None),
        Err(error) => Err(error.into()),
    }
}
