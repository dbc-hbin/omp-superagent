use std::{
    fs::{self, File, Metadata},
    io,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
};

use nix::{fcntl::{AtFlags, OFlag, openat}, sys::stat::{Mode, SFlag, fstatat}};

use crate::{
    result_attachment::{READ_ENTRY, entry_type, same_entry, same_file},
    server::transport::private_paths::open_directory,
};

pub(super) const UNREADABLE: &str = "The requested result attachment could not be read safely";
const ROOT_CHANGED: &str = "The canonical workspace root has changed";
const LINKS: &str = "Result attachment paths cannot follow links";
const PRIVATE: &str = "Private state cannot be sent as a result attachment";
const REGULAR: &str = "A result attachment must be a regular file without hard links";

pub(super) struct Source<'a> {
    pub(super) cwd: &'a Path,
    pub(super) directories: &'a [&'a str],
    pub(super) name: &'a str,
    pub(super) private_paths: &'a [PathBuf],
}

pub(super) struct OpenSource {
    pub(super) observed: SourceEntry,
    pub(super) file: File,
}

pub(super) struct SourceEntry {
    directory: File,
    pub(super) ancestors: Vec<(u64, u64)>,
    pub(super) stat: Metadata,
}

impl Source<'_> {
    pub(super) fn open(&self) -> Result<OpenSource, &'static str> {
        let observed = self.inspect()?;
        let file = File::from(openat(&observed.directory, self.name, READ_ENTRY, Mode::empty())
            .map_err(|_| UNREADABLE)?);
        if !same_file(&observed.stat, &file.metadata().map_err(|_| UNREADABLE)?) {
            return Err("The attachment changed before staging");
        }
        Ok(OpenSource { observed, file })
    }

    pub(super) fn inspect(&self) -> Result<SourceEntry, &'static str> {
        if fs::canonicalize(self.cwd).map_err(|_| ROOT_CHANGED)? != self.cwd {
            return Err(ROOT_CHANGED);
        }
        let mut directory = File::from(open_directory(self.cwd).map_err(|_| ROOT_CHANGED)?);
        let mut path = self.cwd.to_path_buf();
        let leaf = self.directories.iter().fold(path.clone(), |path, name| path.join(name)).join(self.name);
        let mut private = Vec::with_capacity(self.private_paths.len());
        for excluded in self.private_paths {
            let canonical = match fs::canonicalize(excluded) {
                Ok(path) => path,
                Err(error) if error.kind() == io::ErrorKind::NotFound => excluded.clone(),
                Err(_) => return Err(UNREADABLE),
            };
            if leaf.starts_with(&canonical) {
                return Err(PRIVATE);
            }
            match fs::symlink_metadata(canonical) {
                Ok(stat) => private.push(stat),
                Err(error) if error.kind() == io::ErrorKind::NotFound => (),
                Err(_) => return Err(UNREADABLE),
            }
        }
        let mut ancestors = Vec::with_capacity(self.directories.len() + 1);
        for part in self.directories.iter().copied().map(Some).chain(std::iter::once(None)) {
            let parent = directory.metadata().map_err(|_| UNREADABLE)?;
            if private.iter().any(|excluded| same_entry(excluded, &parent)) {
                return Err(PRIVATE);
            }
            ancestors.push((parent.dev(), parent.ino()));
            let Some(part) = part else { break };
            if entry_type(&directory, part).map_err(|_| UNREADABLE)? == SFlag::S_IFLNK {
                return Err(LINKS);
            }
            directory = File::from(openat(&directory, part, READ_ENTRY | OFlag::O_DIRECTORY, Mode::empty())
                .map_err(|_| UNREADABLE)?);
            path.push(part);
        }
        path.push(self.name);
        let initial = fs::symlink_metadata(&path).map_err(|_| UNREADABLE)?;
        let named = fstatat(&directory, self.name, AtFlags::AT_SYMLINK_NOFOLLOW).map_err(|_| UNREADABLE)?;
        let file_type = SFlag::from_bits_truncate(named.st_mode) & SFlag::S_IFMT;
        if file_type == SFlag::S_IFLNK || initial.is_symlink() {
            return Err(LINKS);
        }
        if private.iter().any(|excluded| same_entry(excluded, &initial)) {
            return Err(PRIVATE);
        }
        if file_type != SFlag::S_IFREG || !initial.is_file() || initial.nlink() != 1 {
            return Err(REGULAR);
        }
        if i128::from(named.st_dev) != i128::from(initial.dev())
            || i128::from(named.st_ino) != i128::from(initial.ino()) {
            return Err("The attachment changed during staging");
        }
        if fs::canonicalize(path).map_err(|_| UNREADABLE)? != leaf {
            return Err(LINKS);
        }
        Ok(SourceEntry { directory, ancestors, stat: initial })
    }
}
