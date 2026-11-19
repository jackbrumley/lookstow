//! `lookstow run`: the service's own process (SPEC-INSTALL-AND-UPDATES).
//! It runs the Node app of the release it belongs to, starts it again if it
//! crashes, and hands the database over by waiting for the old Node to end
//! before starting the next (the app's data lock does the rest). It does
//! not download, stage or switch anything: the root updater does that.

use crate::layout::{node_in, Layout};
use crate::releases::RELEASES;
use crate::updater::files::{self, Switch};
use crate::updates::TARGET;
use anyhow::{Context as _, Result};
use std::ffi::OsString;
use std::fs::File;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

const POLL: Duration = Duration::from_millis(250);
/// Waits after a crash: doubling from 2 s to a minute, back to 2 s after
/// a run of ten minutes.
const FIRST_RESTART: Duration = Duration::from_secs(2);
const MAX_RESTART: Duration = Duration::from_secs(60);
const STABLE_RUN: Duration = Duration::from_secs(600);
/// server.ts closes its connections within 10 s of SIGTERM.
const STOP_GRACE: Duration = Duration::from_secs(15);

pub struct Launcher {
    /// The release folder this launcher came from (or an unpacked bundle).
    pub release: PathBuf,
    /// Where the release's switch record would be, when it is installed.
    pub program: Option<PathBuf>,
    pub data: PathBuf,
}

/// The app entry the service runs: the bundled `server.ts`.
const SERVER_ENTRY: &str = "server.js";

/// The program folder a release folder belongs to: `<program>/releases/<v>`.
fn program_of(release: &Path) -> Option<PathBuf> {
    let releases = release.parent()?;
    (releases.file_name()? == RELEASES).then(|| releases.parent().map(Path::to_path_buf))?
}

impl Launcher {
    pub fn for_this_program(data: PathBuf) -> Result<Self> {
        let release = crate::layout::own_dir()?;
        let program = release
            .canonicalize()
            .ok()
            .and_then(|real| program_of(&real));
        Ok(Self {
            release,
            program,
            data,
        })
    }

    fn version(&self) -> String {
        crate::layout::bundle_version(&self.release)
    }

    /// The nonce the updater expects from this release's app, or a fresh
    /// one when no update is waiting for it.
    fn nonce(&self) -> Result<String> {
        if let Some(program) = &self.program {
            let layout = Layout {
                program: program.clone(),
                data: self.data.clone(),
            };
            if let Ok(Some(switch)) = Switch::load(&layout.switch_record()) {
                if switch.to == self.version() {
                    return Ok(switch.nonce);
                }
            }
        }
        files::new_nonce()
    }

    /// The release's Node on its app, with the installed settings file and
    /// database, and what the app needs to take part in updates.
    pub fn command(&self, nonce: &str) -> Command {
        let mut env_file = OsString::from("--env-file=");
        env_file.push(self.data.join(crate::layout::ENV_FILE));
        let app = self.release.join("app");
        let mut command = Command::new(node_in(&self.release));
        command
            .arg(env_file)
            .arg(app.join(SERVER_ENTRY))
            .current_dir(&app)
            .env("NODE_ENV", "production")
            .env(
                "DATABASE_PATH",
                self.data.join(crate::layout::DATABASE_FILE),
            )
            .env("LOOKSTOW_DEPLOYMENT", "installed")
            .env("LOOKSTOW_UPDATE_DATA", &self.data)
            .env("LOOKSTOW_LAUNCHER_TARGET", TARGET)
            .env("LOOKSTOW_READINESS_NONCE", nonce)
            .stdin(Stdio::null());
        command
    }

    fn spawn(&self, log: Option<&File>) -> Result<Child> {
        let mut command = self.command(&self.nonce()?);
        if let Some(log) = log {
            command.stdout(log.try_clone()?).stderr(log.try_clone()?);
        }
        command
            .spawn()
            .context("could not start the bundled Node application")
    }

    /// Runs the app until `stop` is set; one launcher per data folder.
    pub fn run(&self, stop: &AtomicBool, log: Option<&File>) -> Result<()> {
        let lock = File::options()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(self.data.join("launcher.lock"))?;
        lock.try_lock().map_err(|e| {
            anyhow::anyhow!("another Lookstow launcher is using this data folder: {e}")
        })?;
        let mut wait = FIRST_RESTART;
        loop {
            let started = Instant::now();
            let mut child = self.spawn(log)?;
            let ended = loop {
                if stop.load(Ordering::SeqCst) {
                    stop_child(&mut child);
                    return Ok(());
                }
                if let Some(status) = child.try_wait()? {
                    break status;
                }
                std::thread::sleep(POLL);
            };
            if started.elapsed() >= STABLE_RUN {
                wait = FIRST_RESTART;
            }
            eprintln!(
                "lookstow: the app stopped ({ended}); starting it again in {} s",
                wait.as_secs()
            );
            let until = Instant::now() + wait;
            while Instant::now() < until {
                if stop.load(Ordering::SeqCst) {
                    return Ok(());
                }
                std::thread::sleep(POLL);
            }
            wait = (wait * 2).min(MAX_RESTART);
        }
    }
}

/// SIGTERM (Unix) so the app closes its connections, then a kill after the
/// grace period; Windows has no signal for a console-less child, and
/// `SQLite`'s write-ahead log keeps the database whole.
fn stop_child(child: &mut Child) {
    #[cfg(unix)]
    if let Ok(pid) = i32::try_from(child.id()) {
        // SAFETY: kill has no memory effects; the pid is our own child.
        unsafe {
            libc::kill(pid, libc::SIGTERM);
        }
    }
    #[cfg(windows)]
    let _ = child.kill();
    let deadline = Instant::now() + STOP_GRACE;
    while Instant::now() < deadline {
        if child.try_wait().ok().flatten().is_some() {
            return;
        }
        std::thread::sleep(POLL);
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(unix)]
static STOP: AtomicBool = AtomicBool::new(false);

#[cfg(unix)]
extern "C" fn stop_signal(_: i32) {
    STOP.store(true, Ordering::SeqCst);
}

/// The foreground and Linux service entry point: SIGTERM or SIGINT stop it.
#[cfg(unix)]
pub fn run_in_foreground(data: PathBuf) -> Result<()> {
    // SAFETY: the handler only stores to an atomic.
    unsafe {
        libc::signal(
            libc::SIGTERM,
            stop_signal as *const () as libc::sighandler_t,
        );
        libc::signal(libc::SIGINT, stop_signal as *const () as libc::sighandler_t);
    }
    Launcher::for_this_program(data)?.run(&STOP, None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    #[test]
    fn runs_the_release_node_on_its_app_with_the_folders_set() {
        // Joined, not written out, so the separators are this platform's.
        let release = Path::new("/opt/lookstow").join("releases").join("0.4.0");
        let data = Path::new("/var/lib/lookstow");
        let launcher = Launcher {
            release: release.clone(),
            program: Some(PathBuf::from("/opt/lookstow")),
            data: data.to_path_buf(),
        };
        let command = launcher.command(&"c".repeat(64));
        assert_eq!(command.get_program(), node_in(&release).as_os_str());
        let arguments: Vec<&OsStr> = command.get_args().collect();
        let mut env_file = OsString::from("--env-file=");
        env_file.push(data.join("server.env"));
        let app = release.join("app");
        let entry = app.join("server.js");
        assert_eq!(arguments, [env_file.as_os_str(), entry.as_os_str()]);
        assert_eq!(command.get_current_dir(), Some(app.as_path()));
        let envs: Vec<(&OsStr, Option<&OsStr>)> = command.get_envs().collect();
        let database = data.join("lookstow.db");
        for (name, expected) in [
            ("DATABASE_PATH", database.as_os_str()),
            ("LOOKSTOW_DEPLOYMENT", OsStr::new("installed")),
            ("LOOKSTOW_UPDATE_DATA", data.as_os_str()),
            ("NODE_ENV", OsStr::new("production")),
        ] {
            assert!(envs.contains(&(OsStr::new(name), Some(expected))), "{name}");
        }
        assert!(envs.contains(&(
            OsStr::new("LOOKSTOW_READINESS_NONCE"),
            Some(OsStr::new(&"c".repeat(64)))
        )));
        assert!(envs.contains(&(
            OsStr::new("LOOKSTOW_LAUNCHER_TARGET"),
            Some(OsStr::new(TARGET))
        )));
    }

    #[test]
    fn the_program_folder_is_found_only_from_a_release_folder() {
        assert_eq!(
            program_of(Path::new("/opt/lookstow/releases/0.4.0")),
            Some(PathBuf::from("/opt/lookstow"))
        );
        assert_eq!(program_of(Path::new("/tmp/x/lookstow")), None);
    }

    #[test]
    fn the_new_release_echoes_the_updaters_nonce() {
        let root = crate::layout::tests::scratch("launcher-nonce");
        let program = root.join("opt");
        let release = crate::layout::tests::fake_bundle_named(&root, "release", "1.1.0");
        std::fs::create_dir_all(&program).unwrap();
        let launcher = Launcher {
            release,
            program: Some(program.clone()),
            data: root.join("data"),
        };
        let fresh = launcher.nonce().unwrap();
        files::validate_nonce(&fresh).unwrap();
        Switch {
            from: "1.0.0".into(),
            to: "1.1.0".into(),
            step: files::Step::Starting,
            nonce: "d".repeat(64),
            rollback_compatible: true,
        }
        .save(&program.join("update-switch.json"))
        .unwrap();
        assert_eq!(launcher.nonce().unwrap(), "d".repeat(64));
        std::fs::remove_dir_all(&root).unwrap();
    }
}
