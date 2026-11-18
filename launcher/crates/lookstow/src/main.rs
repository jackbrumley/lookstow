//! `lookstow`: runs the bundled Node app, installs it as a service, and
//! updates the whole install as root. See
//! `docs/specs/SPEC-INSTALL-AND-UPDATES.md`.

mod bundle;
mod config;
mod data_privacy;
mod install;
mod launcher;
mod layout;
mod releases;
#[cfg(target_os = "linux")]
mod service_linux;
#[cfg(windows)]
mod service_windows;
mod updater;
mod updates;

use anyhow::{bail, Result};
use clap::{Args, Parser, Subcommand};
use layout::Layout;
use std::path::PathBuf;
use std::process::ExitCode;

#[derive(Parser)]
#[command(
    name = "lookstow",
    version,
    about = "Lookstow launcher, installer and updater"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Args)]
struct Folders {
    /// Program folder (default: /opt/lookstow or C:\Program Files\Lookstow)
    #[arg(long, value_name = "DIR")]
    prefix: Option<PathBuf>,
    /// Data folder (default: /var/lib/lookstow or C:\ProgramData\Lookstow)
    #[arg(long, value_name = "DIR")]
    data_dir: Option<PathBuf>,
}

#[derive(Subcommand)]
enum Command {
    /// Run the app in the foreground (and as the service)
    Run {
        /// Data folder (default: /var/lib/lookstow or C:\ProgramData\Lookstow)
        #[arg(long, value_name = "DIR")]
        data_dir: Option<PathBuf>,
        /// Started by the Windows service manager
        #[cfg(windows)]
        #[arg(long, hide = true)]
        service: bool,
    },
    /// Copy this bundle into place, write the settings once, and start the
    /// service (needs root or Administrator unless --no-service)
    Install {
        #[command(flatten)]
        folders: Folders,
        /// Port for a new settings file (an existing one keeps its port)
        #[arg(long, value_name = "PORT")]
        port: Option<u16>,
        /// Install the files and settings only: no service, no system user, no root
        #[arg(long)]
        no_service: bool,
        /// Only rewrite the service definitions for this release (the updater
        /// runs this from the new release)
        #[arg(long)]
        refresh_units: bool,
    },
    /// Install the newest signed release if the console asked for one (run
    /// as root by the update service, or by the scheduled task on Windows)
    Update {
        #[command(flatten)]
        folders: Folders,
        /// Only finish or undo an interrupted update (at boot)
        #[arg(long)]
        recover: bool,
    },
    /// Stop and remove the service and the program folder (data is kept)
    Uninstall {
        #[command(flatten)]
        folders: Folders,
        /// Also delete the data folder (database, settings and secrets key)
        #[arg(long)]
        purge: bool,
    },
    /// Show the version, folders, service state, address and log
    Status {
        #[command(flatten)]
        folders: Folders,
    },
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    #[cfg(windows)]
    if let Command::Run {
        service: true,
        data_dir,
    } = &cli.command
    {
        return report(
            data_dir_or_default(data_dir.clone())
                .and_then(service_windows::run_as_service)
                .map(|()| ExitCode::SUCCESS),
        );
    }
    report(dispatch(cli.command))
}

fn report(result: Result<ExitCode>) -> ExitCode {
    match result {
        Ok(code) => code,
        Err(e) => {
            eprintln!("lookstow: {e:#}");
            ExitCode::FAILURE
        }
    }
}

fn data_dir_or_default(given: Option<PathBuf>) -> Result<PathBuf> {
    match given {
        Some(dir) => Ok(dir),
        None => layout::default_data_dir(),
    }
}

fn dispatch(command: Command) -> Result<ExitCode> {
    match command {
        Command::Run { data_dir, .. } => {
            run(data_dir_or_default(data_dir)?)?;
            Ok(ExitCode::SUCCESS)
        }
        Command::Install {
            folders,
            port,
            no_service,
            refresh_units,
        } => {
            let target = layout::resolve(folders.prefix, folders.data_dir)?;
            if refresh_units {
                install::refresh_units(&target, no_service)?;
            } else {
                install::install(&target, port, no_service)?;
            }
            Ok(ExitCode::SUCCESS)
        }
        Command::Update { folders, recover } => {
            update(&layout::resolve(folders.prefix, folders.data_dir)?, recover)
        }
        Command::Uninstall { folders, purge } => {
            install::uninstall(&layout::resolve(folders.prefix, folders.data_dir)?, purge)?;
            Ok(ExitCode::SUCCESS)
        }
        Command::Status { folders } => {
            install::status(&layout::resolve(folders.prefix, folders.data_dir)?);
            Ok(ExitCode::SUCCESS)
        }
    }
}

/// Node in the foreground, restarted if it crashes; SIGTERM stops it.
fn run(data: PathBuf) -> Result<()> {
    let env_file = data.join(layout::ENV_FILE);
    if !env_file.exists() {
        bail!(
            "there are no settings at {}; run `lookstow install` first",
            env_file.display()
        );
    }
    #[cfg(unix)]
    {
        // Only the owner may open the data (SPEC-INSTALL-AND-UPDATES I16).
        data_privacy::repair(&data)?;
        launcher::run_in_foreground(data)
    }
    #[cfg(not(unix))]
    {
        let stop = std::sync::atomic::AtomicBool::new(false);
        launcher::Launcher::for_this_program(data)?.run(&stop, None)
    }
}

fn update(target: &Layout, recover: bool) -> Result<ExitCode> {
    let keys = updates::trusted_keys()?;
    let service = updater::system::service(target)?;
    let source = updater::system::source();
    let updater = updater::Updater {
        layout: target,
        keys: &keys,
        target: updates::TARGET,
        service: service.as_ref(),
        source: source.as_ref(),
        health_window: updater::system::health_window(),
    };
    let outcome = if recover {
        updater.recover_at_boot()?
    } else {
        updater.update()?
    };
    println!("lookstow update: {outcome:?}");
    Ok(match outcome {
        updater::Outcome::Failed => ExitCode::FAILURE,
        _ => ExitCode::SUCCESS,
    })
}

#[cfg(target_os = "linux")]
mod platform {
    pub use crate::service_linux::{
        install_service, log_hint, refresh_units, remove_program, remove_service, remove_user,
        require_admin, service_installed, service_state, start_service, stop_service,
    };
}

#[cfg(windows)]
mod platform {
    pub use crate::service_windows::{
        install_service, log_hint, refresh_units, remove_program, remove_service, remove_user,
        require_admin, service_installed, service_state, start_service, stop_service,
    };
}

#[cfg(not(any(target_os = "linux", windows)))]
mod platform {
    use crate::layout::Layout;
    use anyhow::{bail, Context as _, Result};

    pub fn require_admin() -> Result<()> {
        bail!("installing a service is supported on Linux and Windows only; use --no-service")
    }

    pub fn install_service(_layout: &Layout) -> Result<()> {
        require_admin()
    }

    pub fn refresh_units(_layout: &Layout) -> Result<()> {
        require_admin()
    }

    pub fn stop_service() -> Result<bool> {
        Ok(false)
    }

    pub fn start_service() -> Result<()> {
        require_admin()
    }

    pub fn service_installed() -> bool {
        false
    }

    pub fn remove_service() -> Result<()> {
        Ok(())
    }

    pub fn remove_user() -> Result<()> {
        Ok(())
    }

    pub fn remove_program(layout: &Layout) -> Result<()> {
        std::fs::remove_dir_all(&layout.program)
            .with_context(|| format!("could not remove {}", layout.program.display()))
    }

    pub fn service_state() -> String {
        "not supported on this system".into()
    }

    pub fn log_hint(_layout: &Layout) -> String {
        "the terminal it runs in".into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(arguments: &[&str]) -> Result<Command, clap::Error> {
        Cli::try_parse_from([&["lookstow"], arguments].concat()).map(|cli| cli.command)
    }

    #[test]
    fn every_command_takes_the_folders_and_its_own_options() {
        let Ok(Command::Install {
            folders,
            port,
            no_service,
            refresh_units,
        }) = parse(&[
            "install",
            "--prefix",
            "/srv/lookstow",
            "--data-dir",
            "/srv/lookstow-data",
            "--port",
            "8031",
            "--no-service",
        ])
        else {
            panic!("install did not parse");
        };
        assert_eq!(folders.prefix, Some(PathBuf::from("/srv/lookstow")));
        assert_eq!(folders.data_dir, Some(PathBuf::from("/srv/lookstow-data")));
        assert_eq!(port, Some(8031));
        assert!(no_service && !refresh_units);

        let Ok(Command::Install { refresh_units, .. }) = parse(&["install", "--refresh-units"])
        else {
            panic!("install --refresh-units did not parse");
        };
        assert!(refresh_units);

        let Ok(Command::Update { recover, folders }) = parse(&["update", "--recover"]) else {
            panic!("update --recover did not parse");
        };
        assert!(recover);
        assert_eq!(folders.prefix, None);

        let Ok(Command::Uninstall { purge, .. }) = parse(&["uninstall", "--purge"]) else {
            panic!("uninstall --purge did not parse");
        };
        assert!(purge);

        assert!(matches!(parse(&["status"]), Ok(Command::Status { .. })));
        let Ok(Command::Run { data_dir, .. }) = parse(&["run", "--data-dir", "/d"]) else {
            panic!("run did not parse");
        };
        assert_eq!(data_dir, Some(PathBuf::from("/d")));
    }

    #[test]
    fn stray_words_and_removed_commands_are_refused() {
        for arguments in [
            &["install", "extra"][..],
            &["run", "--prefix", "/opt"],
            &["install", "--port", "eighty"],
            &["reset-password", "--email", "a@example.com"],
            &["update", "--purge"],
        ] {
            assert!(parse(arguments).is_err(), "{arguments:?}");
        }
    }
}
