//! Windows: the service "Lookstow" runs `<prefix>\current\lookstow.exe
//! run --service` as LocalService, which may change only the data folder;
//! Node's output goes to `server.log` there (SPEC-INSTALL-AND-UPDATES I6). The
//! root updater is a scheduled task that runs as SYSTEM every two minutes
//! and exits at once when the console has not asked for an update
//! (SPEC-INSTALL-AND-UPDATES); it also finishes an interrupted update.

use crate::launcher::Launcher;
use crate::layout::{Layout, LOG_FILE};
use anyhow::{bail, Context as _, Result};
use lookstow_service::windows::{
    self as service, status, Account, Grant, Rights, ServiceSpec, LOCAL_SERVICE_SID,
};
use std::ffi::OsString;
use std::fs::File;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use windows_service::service::{ServiceControl, ServiceState};
use windows_service::service_control_handler::{self, ServiceControlHandlerResult};
use windows_service::{define_windows_service, service_dispatcher};

pub const SERVICE_NAME: &str = "Lookstow";
const DISPLAY_NAME: &str = "Lookstow (Microsoft 365 mailbox backup)";
const DESCRIPTION: &str =
    "Backs up Microsoft 365 mailboxes to this computer, with a web console on this machine.";
const UPDATE_TASK: &str = "Lookstow Update";

pub fn service_spec(layout: &Layout) -> ServiceSpec {
    ServiceSpec {
        name: SERVICE_NAME,
        display_name: DISPLAY_NAME,
        description: DESCRIPTION,
        executable: layout.launcher(),
        arguments: vec![
            OsString::from("run"),
            OsString::from("--service"),
            OsString::from("--data-dir"),
            layout.data.clone().into_os_string(),
        ],
        account: Account::LocalService,
    }
}

/// LocalService may change the data folder; nobody else but SYSTEM and Administrators may read it.
pub fn data_grants() -> Vec<Grant> {
    vec![Grant {
        sid: LOCAL_SERVICE_SID,
        rights: Rights::Modify,
    }]
}

/// `schtasks /Create` for the updater: SYSTEM, every two minutes.
pub fn update_task_arguments(layout: &Layout) -> Vec<String> {
    let command = format!(
        "\"{}\" update --prefix \"{}\" --data-dir \"{}\"",
        layout.launcher().display(),
        layout.program.display(),
        layout.data.display()
    );
    vec![
        "/Create".into(),
        "/F".into(),
        "/TN".into(),
        UPDATE_TASK.into(),
        "/SC".into(),
        "MINUTE".into(),
        "/MO".into(),
        "2".into(),
        "/RU".into(),
        "SYSTEM".into(),
        "/RL".into(),
        "HIGHEST".into(),
        "/TR".into(),
        command,
    ]
}

fn schtasks(arguments: &[String]) -> Result<()> {
    let status = Command::new("schtasks.exe")
        .args(arguments)
        .stdout(Stdio::null())
        .status()
        .context("could not run schtasks")?;
    if !status.success() {
        bail!("schtasks {} failed ({status})", arguments.join(" "));
    }
    Ok(())
}

fn remove_update_task() {
    let _ = Command::new("schtasks.exe")
        .args(["/Delete", "/F", "/TN", UPDATE_TASK])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

pub fn require_admin() -> Result<()> {
    service::require_admin()
}

/// The updater task, written by each release (the executable path goes
/// through `current`, so the service itself needs no change).
pub fn refresh_units(layout: &Layout) -> Result<()> {
    schtasks(&update_task_arguments(layout))
}

pub fn start_service() -> Result<()> {
    service::start(SERVICE_NAME)
}

/// The console listens on 127.0.0.1 by default, so unlike BMuster no
/// firewall rule is added; an admin who changes HOST opens the port.
pub fn install_service(layout: &Layout) -> Result<()> {
    if service::exists(SERVICE_NAME) {
        service::stop_and_delete(SERVICE_NAME)?;
    }
    refresh_units(layout)?;
    service::create_and_start(&service_spec(layout))?;
    println!("Installed and started the \"{DISPLAY_NAME}\" service, with automatic updates.");
    Ok(())
}

pub fn stop_service() -> Result<bool> {
    service::stop(SERVICE_NAME)
}

pub fn service_installed() -> bool {
    service::exists(SERVICE_NAME)
}

pub fn remove_service() -> Result<()> {
    remove_update_task();
    if service::stop_and_delete(SERVICE_NAME)? {
        println!("Removed the \"{DISPLAY_NAME}\" service.");
    }
    Ok(())
}

pub fn remove_user() -> Result<()> {
    Ok(())
}

/// Deletes the program folder. A running program cannot delete its own
/// file, so when this launcher lives there a detached `cmd` removes the
/// folder (its releases and the `current` link, never what a link points
/// at) a few seconds after it exits.
pub fn remove_program(layout: &Layout) -> Result<()> {
    let current = std::env::current_exe()?;
    let inside = current
        .canonicalize()
        .ok()
        .zip(layout.program.canonicalize().ok())
        .is_some_and(|(exe, program)| exe.starts_with(program));
    if !inside {
        return std::fs::remove_dir_all(&layout.program)
            .with_context(|| format!("could not remove {}", layout.program.display()));
    }
    use std::os::windows::process::CommandExt as _;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    Command::new("cmd.exe")
        .raw_arg(format!(
            "/d /c \"ping -n 4 127.0.0.1 >nul & rmdir /s /q \"{}\"\"",
            layout.program.display()
        ))
        .creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS)
        .spawn()
        .context("could not schedule removing the program folder")?;
    Ok(())
}

pub fn service_state() -> String {
    service::state(SERVICE_NAME)
}

/// Node's output, appended by the service (moved aside above 10 MB).
pub fn log_hint(layout: &Layout) -> String {
    layout.log_file().display().to_string()
}

// ---------------------------------------------------------------------------
// Running under the service manager
// ---------------------------------------------------------------------------

static SERVICE_DATA: OnceLock<PathBuf> = OnceLock::new();

define_windows_service!(ffi_service_main, service_main);

/// Hands this thread to the service manager; returns when the service stops.
pub fn run_as_service(data: PathBuf) -> Result<()> {
    let _ = SERVICE_DATA.set(data);
    service_dispatcher::start(SERVICE_NAME, ffi_service_main)
        .context("could not start as a Windows service (start it with the service manager)")
}

fn note(log: &mut File, line: &str) {
    let _ = writeln!(log, "lookstow: {line}");
}

fn service_main(_arguments: Vec<OsString>) {
    let Some(data) = SERVICE_DATA.get() else {
        return;
    };
    let Ok(mut log) = lookstow_service::log_file::open_rotated(&data.join(LOG_FILE)) else {
        return;
    };
    if let Err(e) = service_body(data, &mut log) {
        note(&mut log, &format!("the service failed: {e:#}"));
    }
}

fn service_body(data: &Path, log: &mut File) -> Result<()> {
    let stop = Arc::new(AtomicBool::new(false));
    let stop_flag = Arc::clone(&stop);
    let handle = service_control_handler::register(SERVICE_NAME, move |control| match control {
        ServiceControl::Stop | ServiceControl::Shutdown => {
            stop_flag.store(true, Ordering::SeqCst);
            ServiceControlHandlerResult::NoError
        }
        ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
        _ => ServiceControlHandlerResult::NotImplemented,
    })
    .context("could not register with the service manager")?;

    handle.set_service_status(status(ServiceState::Running, 0))?;
    let ran = Launcher::for_this_program(data.to_path_buf())
        .and_then(|launcher| launcher.run(&stop, Some(log)));
    if let Err(e) = &ran {
        note(log, &format!("the launcher failed: {e:#}"));
    }
    note(log, "stopped");
    handle.set_service_status(status(ServiceState::Stopped, u32::from(ran.is_err())))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn the_service_runs_the_launcher_as_local_service_with_the_data_folder() {
        let layout = Layout {
            program: PathBuf::from(r"C:\Program Files\Lookstow"),
            data: PathBuf::from(r"C:\ProgramData\Lookstow"),
        };
        let spec = service_spec(&layout);
        let task = update_task_arguments(&layout).join(" ");
        assert!(task.contains("/SC MINUTE /MO 2 /RU SYSTEM"), "{task}");
        assert!(task.ends_with(
            r#"/TR "C:\Program Files\Lookstow\current\lookstow.exe" update --prefix "C:\Program Files\Lookstow" --data-dir "C:\ProgramData\Lookstow""#
        ), "{task}");
        assert_eq!(spec.name, "Lookstow");
        assert_eq!(spec.display_name, "Lookstow (Microsoft 365 mailbox backup)");
        assert_eq!(spec.account, Account::LocalService);
        assert_eq!(
            spec.executable,
            PathBuf::from(r"C:\Program Files\Lookstow\current\lookstow.exe")
        );
        assert_eq!(
            spec.arguments,
            vec![
                OsString::from("run"),
                OsString::from("--service"),
                OsString::from("--data-dir"),
                OsString::from(r"C:\ProgramData\Lookstow"),
            ]
        );
    }

    #[test]
    fn local_service_may_change_the_data() {
        // I16: SYSTEM and Administrators full control, LocalService modify,
        // nothing inherited from C:\ProgramData.
        assert_eq!(
            service::restricted_dir_sddl(&data_grants()),
            "D:P(A;OICI;FA;;;S-1-5-18)(A;OICI;FA;;;S-1-5-32-544)(A;OICI;0x1301bf;;;S-1-5-19)"
        );
    }
}
