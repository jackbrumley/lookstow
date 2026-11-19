//! Windows: the service "Lookstow" runs `<prefix>\current\lookstow.exe
//! run --service` as `LocalService`, which may change only the data folder;
//! Node's output goes to `server.log` there (SPEC-INSTALL-AND-UPDATES I6). The
//! root updater is a scheduled task that runs as SYSTEM every minute, and at
//! once when the service starts it; it exits at once when the console has not
//! asked for an update
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

/// `LocalService` may change the data folder; nobody else but SYSTEM and Administrators may read it.
pub fn data_grants() -> Vec<Grant> {
    vec![Grant {
        sid: LOCAL_SERVICE_SID,
        rights: Rights::Modify,
    }]
}

/// Who may do what to the updater task: SYSTEM and Administrators everything; `LocalService` (the
/// service's account) may read and run it, so the console starts an update at once with
/// `schtasks /Run` instead of waiting for the next minute. Running it only makes the updater
/// look for the console's request and install the latest signed release; it takes no input.
const UPDATE_TASK_SDDL: &str = "D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;GRGX;;;LS)";

fn xml_escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// The updater task: SYSTEM, every minute as a fallback, startable by the service at once, and
/// (unlike `schtasks /Create`'s defaults) also on battery, never two at a time.
pub fn update_task_xml(layout: &Layout) -> String {
    let arguments = format!(
        "update --prefix \"{}\" --data-dir \"{}\"",
        layout.program.display(),
        layout.data.display()
    );
    format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Installs Lookstow updates the console asks for, and finishes an interrupted update.</Description>
    <SecurityDescriptor>{sddl}</SecurityDescriptor>
  </RegistrationInfo>
  <Triggers>
    <TimeTrigger>
      <Repetition>
        <Interval>PT1M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <StartBoundary>2026-01-01T00:00:00</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="System">
      <UserId>S-1-5-18</UserId>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT1H</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="System">
    <Exec>
      <Command>{command}</Command>
      <Arguments>{arguments}</Arguments>
    </Exec>
  </Actions>
</Task>
"#,
        sddl = UPDATE_TASK_SDDL,
        command = xml_escape(&layout.launcher().display().to_string()),
        arguments = xml_escape(&arguments),
    )
}

/// Task Scheduler reads task XML as UTF-16 (little-endian, with a byte order mark).
fn utf16_file(text: &str) -> Vec<u8> {
    let mut bytes = vec![0xFF, 0xFE];
    for unit in text.encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    bytes
}

/// Registers (or replaces) the updater task from its XML, through a file in the data folder.
fn register_update_task(layout: &Layout) -> Result<()> {
    let path = layout.data.join("update-task.xml");
    std::fs::write(&path, utf16_file(&update_task_xml(layout)))
        .with_context(|| format!("could not write {}", path.display()))?;
    let result = schtasks(&[
        "/Create".into(),
        "/F".into(),
        "/TN".into(),
        UPDATE_TASK.into(),
        "/XML".into(),
        path.display().to_string(),
    ]);
    let _ = std::fs::remove_file(&path);
    result
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
    register_update_task(layout)
}

pub fn start_service() -> Result<()> {
    service::start(SERVICE_NAME)
}

/// The console listens on 127.0.0.1 by default, so unlike `BMuster` no
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

/// Deletes the program folder. A running program cannot delete its own
/// file, so when this launcher lives there a detached `cmd` removes the
/// folder (its releases and the `current` link, never what a link points
/// at) a few seconds after it exits.
pub fn remove_program(layout: &Layout) -> Result<()> {
    use std::os::windows::process::CommandExt as _;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const DETACHED_PROCESS: u32 = 0x0000_0008;

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
        let task = update_task_xml(&layout);
        assert!(task.contains("<UserId>S-1-5-18</UserId>"), "{task}");
        assert!(task.contains("<Interval>PT1M</Interval>"), "{task}");
        assert!(
            task.contains("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>"),
            "{task}"
        );
        assert!(
            task.contains(
                "<SecurityDescriptor>D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;GRGX;;;LS)</SecurityDescriptor>"
            ),
            "{task}"
        );
        assert!(
            task.contains(r"<Command>C:\Program Files\Lookstow\current\lookstow.exe</Command>"),
            "{task}"
        );
        assert!(task.contains(
            r"<Arguments>update --prefix &quot;C:\Program Files\Lookstow&quot; --data-dir &quot;C:\ProgramData\Lookstow&quot;</Arguments>"
        ), "{task}");
        assert_eq!(&utf16_file("<")[..], &[0xFF, 0xFE, b'<', 0][..]);
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
