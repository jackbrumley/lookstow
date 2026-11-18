//! `lookstow install`, `uninstall` and `status` (SPEC-INSTALL-AND-UPDATES):
//! the installer makes the same layout the updater keeps,
//! `releases/<version>` and `current`, from an unpacked bundle.

use crate::bundle;
use crate::layout::{self, bundle_version, check_bundle, Layout};
use crate::releases::{self, current_version, point_current, releases_dir, CURRENT};
use crate::updater::files;
use crate::{config, data_privacy, platform};
use anyhow::{bail, Context as _, Result};
use std::fs;
use std::path::Path;

/// What is in the program folder before an install.
#[derive(Debug, PartialEq, Eq)]
enum Program {
    /// Nothing, or an empty folder.
    Missing,
    /// `releases/` and `current`.
    Releases,
}

fn program_kind(prefix: &Path) -> Result<Program> {
    if !prefix.exists() || fs::read_dir(prefix)?.next().is_none() {
        return Ok(Program::Missing);
    }
    if fs::symlink_metadata(prefix.join(CURRENT)).is_ok() && releases_dir(prefix).is_dir() {
        return Ok(Program::Releases);
    }
    bail!(
        "{} is not a Lookstow program folder, so it was left alone; choose another --prefix",
        prefix.display()
    )
}

/// Puts the bundle in `source` into `prefix` as `releases/<version>` and
/// points `current` at it, keeping the release that ran before and no
/// other.
pub fn place_program(source: &Path, prefix: &Path) -> Result<String> {
    check_bundle(source)?;
    let version = bundle_version(source);
    releases::checked_version(&version)
        .with_context(|| format!("{} has no usable VERSION", source.display()))?;
    match program_kind(prefix)? {
        Program::Releases => {
            let before = current_version(prefix)?;
            releases::place(source, prefix, &version)?;
            point_current(prefix, &version)?;
            let mut keep = vec![version.as_str()];
            keep.extend(before.as_deref());
            releases::prune(prefix, &keep)?;
        }
        Program::Missing => {
            let staged = bundle::sibling(prefix, ".new")?;
            if staged.exists() {
                fs::remove_dir_all(&staged)
                    .with_context(|| format!("could not remove {}", staged.display()))?;
            }
            fs::create_dir_all(&staged)?;
            releases::place(source, &staged, &version)?;
            point_current(&staged, &version)?;
            if prefix.exists() && fs::read_dir(prefix)?.next().is_none() {
                fs::remove_dir(prefix)?;
            }
            bundle::swap_in(&staged, prefix)?;
        }
    }
    Ok(version)
}

/// Fails unless `prefix` holds an installed Lookstow.
pub fn check_program(prefix: &Path) -> Result<()> {
    match program_kind(prefix)? {
        Program::Releases => check_bundle(&prefix.join(CURRENT)),
        Program::Missing => bail!("{} is empty", prefix.display()),
    }
}

pub fn install(target: &Layout, port: Option<u16>, no_service: bool) -> Result<()> {
    if !no_service {
        platform::require_admin()?;
    }
    let source = layout::own_dir()?;
    check_bundle(&source)?;
    if !no_service && platform::stop_service()? {
        println!("Stopped the running service for the upgrade.");
    }
    let version = place_program(&source, &target.program)?;
    // The installer is the source of truth: an update it interrupted is over.
    files::remove(&target.switch_record())?;
    println!(
        "Installed Lookstow {version} in {}.",
        target.program.display()
    );

    fs::create_dir_all(&target.data)
        .with_context(|| format!("could not create {}", target.data.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        fs::set_permissions(&target.data, fs::Permissions::from_mode(0o700))?;
    }
    if config::write_if_missing(&target.env_file(), port.unwrap_or(config::DEFAULT_PORT))? {
        println!("Wrote new settings to {}.", target.env_file().display());
    } else {
        println!("Kept the settings and data in {}.", target.data.display());
        let kept = config::read_listen(&target.env_file())?.port;
        if port.is_some_and(|wanted| wanted != kept) {
            println!(
                "Note: Lookstow keeps port {kept}; change PORT in {} to move it.",
                target.env_file().display()
            );
        }
    }
    // Only the service account and administrators may open the settings,
    // database and backups, including any written by an older release
    // (SPEC-INSTALL-AND-UPDATES I16). Windows needs an Administrator for this.
    if cfg!(unix) || !no_service {
        data_privacy::lock(&target.data)?;
    }

    if no_service {
        println!(
            "No service was installed. Start Lookstow with:\n  \"{}\" run --data-dir \"{}\"",
            target.launcher().display(),
            target.data.display()
        );
    } else {
        platform::install_service(target)?;
    }
    println!("Console: {}", address(target));
    Ok(())
}

/// The console's address from `server.env`, or why it is not known.
fn address(target: &Layout) -> String {
    match config::read_listen(&target.env_file()) {
        Ok(listen) => listen.url(),
        Err(e) => format!("unknown ({e:#})"),
    }
}

pub fn refresh_units(target: &Layout, no_service: bool) -> Result<()> {
    if no_service {
        return Ok(());
    }
    platform::require_admin()?;
    platform::refresh_units(target)?;
    // Every upgrade runs this as root or SYSTEM: the data lockdown is
    // repaired whatever happened to it since the install (I16).
    data_privacy::lock(&target.data)
}

pub fn uninstall(target: &Layout, purge: bool) -> Result<()> {
    if platform::service_installed() {
        platform::require_admin()?;
        platform::remove_service()?;
    }
    if target.program.exists() {
        check_program(&target.program)?;
        platform::remove_program(target)?;
        println!("Removed {}.", target.program.display());
    }
    if !target.data.exists() {
        return Ok(());
    }
    if !purge {
        println!(
            "Kept {} (database, settings and secrets key); add --purge to remove it.",
            target.data.display()
        );
        return Ok(());
    }
    if !target.env_file().exists() && !target.database().exists() {
        bail!(
            "{} has no server.env or lookstow.db, so it was left alone",
            target.data.display()
        );
    }
    fs::remove_dir_all(&target.data)
        .with_context(|| format!("could not remove {}", target.data.display()))?;
    println!(
        "Removed {} (database, settings and secrets key).",
        target.data.display()
    );
    platform::remove_user()
}

pub fn status(target: &Layout) {
    let running = current_version(&target.program)
        .ok()
        .flatten()
        .unwrap_or_else(|| "unknown".into());
    println!("Version:        {running}");
    println!("Program folder: {}", target.program.display());
    println!("Data folder:    {}", target.data.display());
    println!("Service:        {}", platform::service_state());
    println!("Console:        {}", address(target));
    match files::read_status(target) {
        Ok(Some(status)) => println!("Last update:    {}", status.message),
        Ok(None) => println!("Last update:    none yet"),
        Err(e) => println!("Last update:    unknown ({e:#})"),
    }
    println!("Log:            {}", platform::log_hint(target));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::tests::{fake_bundle_named, scratch};
    use crate::releases::release_dir;

    #[test]
    fn layout_and_units() {
        let root = scratch("install-layout");
        let prefix = root.join("opt").join("lookstow");

        // A fresh install: releases/<version> and current.
        let first = fake_bundle_named(&root, "first", "1.0.0");
        assert_eq!(place_program(&first, &prefix).unwrap(), "1.0.0");
        assert_eq!(current_version(&prefix).unwrap().as_deref(), Some("1.0.0"));
        check_program(&prefix).unwrap();
        assert!(!root.join("opt").join("lookstow.new").exists());

        // Newer installs keep the release before and prune the rest.
        for version in ["1.1.0", "1.2.0"] {
            let bundle = fake_bundle_named(&root, version, version);
            place_program(&bundle, &prefix).unwrap();
        }
        assert_eq!(current_version(&prefix).unwrap().as_deref(), Some("1.2.0"));
        assert!(release_dir(&prefix, "1.1.0").exists());
        assert!(!release_dir(&prefix, "1.0.0").exists());

        // Re-running the installer from the installed release changes nothing.
        place_program(&release_dir(&prefix, "1.2.0"), &prefix).unwrap();
        assert_eq!(current_version(&prefix).unwrap().as_deref(), Some("1.2.0"));

        // An unpacked bundle copied straight into the folder is not a
        // program folder, so it is never taken over either.
        let loose = root.join("loose-opt");
        bundle::copy_tree(&first, &loose).unwrap();
        assert!(place_program(&first, &loose).is_err());
        assert!(check_program(&loose).is_err());

        // Some other folder is never taken over.
        let other = root.join("other");
        fs::create_dir_all(&other).unwrap();
        fs::write(other.join("notes.txt"), b"mine").unwrap();
        assert!(place_program(&first, &other).is_err());
        assert!(check_program(&other).is_err());
        assert_eq!(fs::read(other.join("notes.txt")).unwrap(), b"mine");
        fs::remove_dir_all(&root).unwrap();
    }
}
