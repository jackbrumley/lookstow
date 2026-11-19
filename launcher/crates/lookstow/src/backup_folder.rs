//! `lookstow backup-folder prepare <DIR>`: makes a folder ready to hold the
//! backup (SPEC-BACKUP-FOLDER-MOVE B2). The service runs unprivileged and,
//! on Linux, may write only the folders its unit names, so an administrator
//! prepares a folder outside the data folder before the console moves the
//! backup there:
//!
//! - The folder is created, or must be empty: its permissions are reset, so
//!   a folder already holding other files is refused rather than changed.
//! - Windows: the data folder's protected DACL (SYSTEM and Administrators
//!   full control, `LocalService` modify, nothing inherited).
//! - Linux: owned by the service user, `0700`, and named in a drop-in
//!   (`lookstow.service.d/backup-folder.conf`) that adds it to the unit's
//!   `ReadWritePaths`, then the service restarts so the change applies. The
//!   drop-in keeps every folder prepared before, so the move can read the old
//!   folder while it writes the new one; `install --refresh-units` rewrites
//!   only the main unit and leaves it alone.
//!
//! It never follows a link, and never touches a folder inside the program or
//! data folder's system locations.

use crate::layout::Layout;
use anyhow::{bail, Context as _, Result};
use std::fs;
use std::path::{Component, Path, PathBuf};

/// The marker the app writes at the top of a backup folder (storage/backup-marker.ts).
const MARKER: &str = ".lookstow-backup";

/// Why `dir` cannot be prepared, or `Ok` with the folder to use.
pub fn check_target(dir: &Path, layout: &Layout) -> Result<PathBuf> {
    if !dir.is_absolute() {
        bail!("give the folder as a full path, for example D:\\Lookstow backup or /srv/lookstow-backup");
    }
    if dir
        .components()
        .any(|part| matches!(part, Component::ParentDir))
    {
        bail!("the folder may not contain \"..\"");
    }
    if dir.parent().is_none() {
        bail!("choose a folder, not the top of a drive");
    }
    if dir.starts_with(&layout.program) {
        bail!(
            "{} is inside the program folder, which updates replace",
            dir.display()
        );
    }
    if layout.data.starts_with(dir) {
        bail!(
            "{} holds the data folder; choose a folder of its own",
            dir.display()
        );
    }
    match fs::symlink_metadata(dir) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            bail!("{} is a link; give the real folder", dir.display())
        }
        Ok(metadata) if !metadata.is_dir() => bail!("{} is a file, not a folder", dir.display()),
        Ok(_) => {
            let mut entries = fs::read_dir(dir)
                .with_context(|| format!("could not read {}", dir.display()))?
                .filter_map(std::result::Result::ok)
                .map(|entry| entry.file_name());
            if let Some(name) = entries.find(|name| name != MARKER) {
                bail!(
                    "{} is not empty (it holds {}); choose an empty folder, or a new one",
                    dir.display(),
                    name.to_string_lossy()
                );
            }
        }
        Err(_) => {}
    }
    Ok(dir.to_path_buf())
}

/// Prepares `dir` for the backup, as root or Administrator.
pub fn prepare(dir: &Path, layout: &Layout) -> Result<()> {
    crate::platform::require_admin()?;
    #[cfg(target_os = "linux")]
    visible_to_service(dir)?;
    let dir = check_target(dir, layout)?;
    fs::create_dir_all(&dir).with_context(|| format!("could not create {}", dir.display()))?;
    grant(&dir)?;
    println!("{} is ready for the backup.", dir.display());
    println!(
        "Next: in the console, Settings > Backup folder > Move, enter {}.",
        dir.display()
    );
    Ok(())
}

#[cfg(windows)]
fn grant(dir: &Path) -> Result<()> {
    lookstow_service::windows::restrict_dir(dir, &crate::service_windows::data_grants())
}

#[cfg(target_os = "linux")]
fn grant(dir: &Path) -> Result<()> {
    crate::service_linux::allow_backup_folder(dir)
}

#[cfg(not(any(windows, target_os = "linux")))]
fn grant(_dir: &Path) -> Result<()> {
    bail!("preparing a backup folder is supported on Linux and Windows only")
}

/// The unit hides these from the service (`ProtectHome`, `PrivateTmp`, `PrivateDevices`), so a
/// backup folder there would never be written.
#[cfg(any(target_os = "linux", test))]
fn visible_to_service(dir: &Path) -> Result<()> {
    for hidden in [
        "/home",
        "/root",
        "/run/user",
        "/tmp",
        "/var/tmp",
        "/proc",
        "/sys",
        "/dev",
    ] {
        if dir.starts_with(hidden) {
            bail!(
                "the service cannot see {hidden} (its unit hides it); choose a folder elsewhere, for example /srv/lookstow-backup"
            );
        }
    }
    Ok(())
}

/// The drop-in naming every prepared backup folder as writable (Linux).
#[cfg(any(target_os = "linux", test))]
pub fn drop_in(existing: &str, add: &Path) -> String {
    let mut paths: Vec<String> = existing
        .lines()
        .filter_map(|line| line.strip_prefix("ReadWritePaths="))
        .map(str::to_owned)
        .collect();
    let added = add.display().to_string();
    if !paths.contains(&added) {
        paths.push(added);
    }
    let mut text = String::from(
        "# Written by `lookstow backup-folder prepare`: backup folders the service may write.\n[Service]\n",
    );
    for path in paths {
        text.push_str("ReadWritePaths=");
        text.push_str(&path);
        text.push('\n');
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layout(root: &Path) -> Layout {
        Layout {
            program: root.join("program"),
            data: root.join("data"),
        }
    }

    #[test]
    fn only_a_full_path_outside_the_program_and_data_folders_is_taken() {
        let root = crate::layout::tests::scratch("backup-folder-check");
        let layout = layout(&root);
        assert!(check_target(Path::new("relative/folder"), &layout).is_err());
        assert!(check_target(&root.join("a").join("..").join("b"), &layout).is_err());
        assert!(check_target(&layout.program.join("backup"), &layout).is_err());
        assert!(check_target(&root, &layout).is_err());
        let fresh = root.join("backup");
        assert_eq!(check_target(&fresh, &layout).unwrap(), fresh);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_folder_holding_other_files_is_refused_but_an_earlier_marker_is_not() {
        let root = crate::layout::tests::scratch("backup-folder-empty");
        let layout = layout(&root);
        let target = root.join("backup");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join(MARKER), "{}").unwrap();
        assert!(check_target(&target, &layout).is_ok());
        fs::write(target.join("holiday.jpg"), "x").unwrap();
        let refused = check_target(&target, &layout).unwrap_err().to_string();
        assert!(refused.contains("not empty"), "{refused}");
        let file = root.join("a-file");
        fs::write(&file, "x").unwrap();
        assert!(check_target(&file, &layout).is_err());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn folders_the_unit_hides_from_the_service_are_refused() {
        assert!(visible_to_service(Path::new("/home/ann/backup")).is_err());
        assert!(visible_to_service(Path::new("/tmp/backup")).is_err());
        assert!(visible_to_service(Path::new("/srv/lookstow-backup")).is_ok());
        assert!(visible_to_service(Path::new("/mnt/backup-drive/lookstow")).is_ok());
    }

    #[test]
    fn the_drop_in_keeps_every_prepared_folder_once() {
        let first = drop_in("", Path::new("/srv/backup-a"));
        assert!(first.contains("[Service]\nReadWritePaths=/srv/backup-a\n"));
        let second = drop_in(&first, Path::new("/srv/backup-b"));
        assert!(second.ends_with("ReadWritePaths=/srv/backup-a\nReadWritePaths=/srv/backup-b\n"));
        assert_eq!(drop_in(&second, Path::new("/srv/backup-b")), second);
    }
}
