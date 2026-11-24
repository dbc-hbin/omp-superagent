use std::{
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt, symlink},
    path::{Path, PathBuf},
};

use anyhow::Result;
use uuid::Uuid;

use super::{GatewayClient, SocketDir};

fn directory(parent: &Path, name: &str, mode: u32) -> Result<PathBuf> {
    let path = parent.join(name);
    fs::DirBuilder::new().mode(mode).create(&path)?;
    fs::set_permissions(&path, fs::Permissions::from_mode(mode))?;
    Ok(path)
}

fn private_file(path: &Path, data: &[u8]) -> Result<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    file.set_permissions(fs::Permissions::from_mode(0o600))?;
    file.write_all(data)?;
    Ok(())
}

fn staging_name() -> String {
    format!(".{}.download", Uuid::new_v4())
}

#[tokio::test]
async fn restart_removes_only_owned_unpublished_attachment_staging() -> Result<()> {
    let root = SocketDir::new()?;
    let initial = GatewayClient::connect(&root, String::new()).await?;
    initial.server.close().await?;

    // Recreate the filesystem state that exists after a process exit before
    // publish, without running a destructor or killing a shared process.
    let spool = directory(&root.0, "attachments", 0o700)?;
    let abandoned = directory(&spool, &staging_name(), 0o700)?;
    private_file(&abandoned.join("0"), b"incomplete payload")?;
    let empty = directory(&spool, &staging_name(), 0o700)?;
    let published = directory(&spool, &"ab".repeat(32), 0o700)?.join("0");
    private_file(&published, b"committed receipt bytes")?;
    let unrelated = directory(&spool, ".borrowed.download", 0o700)?.join("0");
    private_file(&unrelated, b"unowned by the spool")?;
    let incorrect_mode = directory(&spool, &staging_name(), 0o750)?.join("0");
    private_file(&incorrect_mode, b"not a private staging batch")?;
    let unexpected_content = directory(&spool, &staging_name(), 0o700)?;
    let legitimate_looking = unexpected_content.join("0");
    private_file(&legitimate_looking, b"keep the entire unrecognized batch")?;
    let child = directory(&unexpected_content, "1", 0o700)?.join("0");
    private_file(&child, b"do not recurse")?;
    let external = SocketDir::new()?;
    let outside = external.0.join("0");
    private_file(&outside, b"do not follow links")?;
    let directory_link = spool.join(staging_name());
    symlink(&external.0, &directory_link)?;
    let file_link = directory(&spool, &staging_name(), 0o700)?.join("0");
    symlink(&outside, &file_link)?;
    let hard_link = directory(&spool, &staging_name(), 0o700)?.join("0");
    fs::hard_link(&outside, &hard_link)?;

    let restarted = GatewayClient::connect(&root, String::new()).await?;
    assert!(!abandoned.exists());
    assert!(!empty.exists());
    assert_eq!(fs::read(published)?, b"committed receipt bytes");
    assert_eq!(fs::read(unrelated)?, b"unowned by the spool");
    assert_eq!(fs::read(incorrect_mode)?, b"not a private staging batch");
    assert_eq!(fs::read(legitimate_looking)?, b"keep the entire unrecognized batch");
    assert_eq!(fs::read(child)?, b"do not recurse");
    assert_eq!(fs::read_link(directory_link)?, external.0);
    assert_eq!(fs::read_link(file_link)?, outside);
    assert_eq!(fs::read(hard_link)?, b"do not follow links");
    assert_eq!(fs::read(outside)?, b"do not follow links");
    restarted.server.close().await
}
