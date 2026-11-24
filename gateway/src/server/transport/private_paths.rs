use std::{
    ffi::OsStr,
    io,
    os::fd::OwnedFd,
    path::{Component, Path},
};

use nix::{
    errno::Errno,
    fcntl::{OFlag, open, openat},
    sys::stat::{Mode, fstat, mkdirat},
    unistd::{fsync, geteuid},
};

const DIRECTORY: OFlag = OFlag::O_RDONLY
    .union(OFlag::O_DIRECTORY)
    .union(OFlag::O_NOFOLLOW)
    .union(OFlag::O_CLOEXEC);
pub(crate) const PRIVATE_DIRECTORY_MODE: Mode = Mode::S_IRWXU;

/// Descend an absolute path without following any symlink. Each parent is
/// pinned by its descriptor while resolving the next component.
pub(crate) fn open_directory(path: &Path) -> io::Result<OwnedFd> {
    let mut parts = path.components();
    if parts.next() != Some(Component::RootDir) {
        return Err(io::Error::other("Expected an absolute directory path"));
    }
    let mut directory = open("/", DIRECTORY, Mode::empty())?;
    for part in parts {
        let Component::Normal(name) = part else {
            return Err(io::Error::other("Invalid directory path component"));
        };
        directory = open_child(&directory, name)?;
    }
    Ok(directory)
}

pub(in crate::server) fn open_child(parent: &OwnedFd, name: &OsStr) -> io::Result<OwnedFd> {
    Ok(openat(parent, name, DIRECTORY, Mode::empty())?)
}

pub(crate) fn ensure_private_directory(directory: &OwnedFd) -> io::Result<()> {
    let stat = fstat(directory)?;
    if stat.st_uid != geteuid().as_raw() || stat.st_mode & 0o777 != 0o700 {
        return Err(io::Error::other("Spool directory is not private and owned"));
    }
    Ok(())
}

pub(crate) fn private_child(parent: &OwnedFd, name: &str) -> io::Result<OwnedFd> {
    if !matches!(Path::new(name).components().next(), Some(Component::Normal(part)) if part == OsStr::new(name))
    {
        return Err(io::Error::other("Invalid spool directory name"));
    }
    match mkdirat(parent, name, PRIVATE_DIRECTORY_MODE) {
        Ok(()) => fsync(parent)?,
        Err(Errno::EEXIST) => {}
        Err(error) => return Err(error.into()),
    }
    let directory = open_child(parent, OsStr::new(name))?;
    ensure_private_directory(&directory)?;
    Ok(directory)
}
