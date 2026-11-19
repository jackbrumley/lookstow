//! The Windows service manager: creating, stopping, deleting and reporting
//! on one service, the folder rules for its data, and the status values a
//! running service reports.

use anyhow::{bail, Context as _, Result};
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use windows_service::service::{
    Service, ServiceAccess, ServiceAction, ServiceActionType, ServiceControlAccept,
    ServiceErrorControl, ServiceExitCode, ServiceFailureActions, ServiceFailureResetPeriod,
    ServiceInfo, ServiceStartType, ServiceState, ServiceStatus, ServiceType,
};
use windows_service::service_manager::{ServiceManager, ServiceManagerAccess};

/// SID of `LocalSystem` (`NT AUTHORITY\SYSTEM`).
pub const SYSTEM_SID: &str = "S-1-5-18";
/// SID of `NT AUTHORITY\LocalService`.
pub const LOCAL_SERVICE_SID: &str = "S-1-5-19";
/// SID of the local Administrators group.
pub const ADMINISTRATORS_SID: &str = "S-1-5-32-544";

/// A Windows known folder from its environment variable; never guessed.
///
/// # Errors
///
/// Fails when the variable is unset or empty.
pub fn known_folder(variable: &str) -> Result<PathBuf> {
    match std::env::var_os(variable) {
        Some(value) if !value.is_empty() => Ok(PathBuf::from(value)),
        _ => bail!("the {variable} environment variable is not set"),
    }
}

/// Opens the local service manager.
///
/// # Errors
///
/// Fails when the caller may not open the service manager with that access.
pub fn manager(access: ServiceManagerAccess) -> Result<ServiceManager> {
    ServiceManager::local_computer(None::<&str>, access).context(
        "could not open the Windows service manager; run this from an Administrator prompt",
    )
}

/// Succeeds only for an Administrator (who may create services).
///
/// # Errors
///
/// Fails for anyone who is not an Administrator.
pub fn require_admin() -> Result<()> {
    manager(ServiceManagerAccess::CONNECT | ServiceManagerAccess::CREATE_SERVICE).map(|_| ())
}

/// The account a service runs as.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Account {
    /// Full control of the machine.
    LocalSystem,
    /// Few rights and no network identity (Lookstow, which needs neither).
    LocalService,
}

/// What `create_and_start` registers.
pub struct ServiceSpec {
    /// Key name, no spaces, so `sc.exe` commands stay simple.
    pub name: &'static str,
    pub display_name: &'static str,
    pub description: &'static str,
    pub executable: PathBuf,
    pub arguments: Vec<OsString>,
    pub account: Account,
}

/// The service manager's view of `spec`: starts with Windows, own process.
#[must_use]
pub fn service_info(spec: &ServiceSpec) -> ServiceInfo {
    ServiceInfo {
        name: OsString::from(spec.name),
        display_name: OsString::from(spec.display_name),
        service_type: ServiceType::OWN_PROCESS,
        start_type: ServiceStartType::AutoStart,
        error_control: ServiceErrorControl::Normal,
        executable_path: spec.executable.clone(),
        launch_arguments: spec.arguments.clone(),
        dependencies: vec![],
        account_name: match spec.account {
            Account::LocalSystem => None,
            Account::LocalService => Some(OsString::from(r"NT AUTHORITY\LocalService")),
        },
        account_password: None,
    }
}

/// Restart 10 s after each failure (forgotten after a day). A clean stop,
/// even with an exit code, is not a failure.
#[must_use]
pub fn failure_actions() -> ServiceFailureActions {
    ServiceFailureActions {
        reset_period: ServiceFailureResetPeriod::After(Duration::from_secs(86_400)),
        reboot_msg: None,
        command: None,
        actions: Some(vec![
            ServiceAction {
                action_type: ServiceActionType::Restart,
                delay: Duration::from_secs(10),
            };
            3
        ]),
    }
}

/// Registers the service with its description and restart rules, and starts it.
///
/// # Errors
///
/// Fails when the service cannot be created, configured or started.
pub fn create_and_start(spec: &ServiceSpec) -> Result<()> {
    let manager = manager(ServiceManagerAccess::CONNECT | ServiceManagerAccess::CREATE_SERVICE)?;
    let service = manager
        .create_service(
            &service_info(spec),
            ServiceAccess::CHANGE_CONFIG | ServiceAccess::START | ServiceAccess::QUERY_STATUS,
        )
        .context("could not create the service")?;
    service
        .set_description(spec.description)
        .context("could not describe the service")?;
    service
        .update_failure_actions(failure_actions())
        .context("could not set the service's restart rules")?;
    service
        .start::<&OsStr>(&[])
        .context("could not start the service")
}

#[must_use]
pub fn exists(name: &str) -> bool {
    manager(ServiceManagerAccess::CONNECT)
        .and_then(|manager| {
            manager
                .open_service(name, ServiceAccess::QUERY_STATUS)
                .map_err(anyhow::Error::from)
        })
        .is_ok()
}

fn wait_for(service: &Service, state: ServiceState) -> Result<()> {
    let deadline = Instant::now() + Duration::from_secs(30);
    while service.query_status()?.current_state != state {
        if Instant::now() > deadline {
            bail!("the service did not reach {state:?} within 30 s");
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    Ok(())
}

fn stop_and_wait(service: &Service) -> Result<bool> {
    if service.query_status()?.current_state == ServiceState::Stopped {
        return Ok(false);
    }
    service.stop().context("could not stop the service")?;
    wait_for(service, ServiceState::Stopped)?;
    Ok(true)
}

/// Stops the service if it runs; returns whether it was running.
///
/// # Errors
///
/// Fails when the service manager cannot be opened or the service does not stop.
pub fn stop(name: &str) -> Result<bool> {
    let manager = manager(ServiceManagerAccess::CONNECT)?;
    let Ok(service) = manager.open_service(name, ServiceAccess::QUERY_STATUS | ServiceAccess::STOP)
    else {
        return Ok(false);
    };
    stop_and_wait(&service)
}

/// Starts the service.
///
/// # Errors
///
/// Fails when the service cannot be opened or started.
pub fn start(name: &str) -> Result<()> {
    let manager = manager(ServiceManagerAccess::CONNECT)?;
    let service = manager
        .open_service(name, ServiceAccess::QUERY_STATUS | ServiceAccess::START)
        .context("could not open the service")?;
    service
        .start::<&OsStr>(&[])
        .context("could not start the service")
}

/// Stops and deletes the service; false when there was none.
///
/// # Errors
///
/// Fails when the service does not stop or cannot be deleted.
pub fn stop_and_delete(name: &str) -> Result<bool> {
    let manager = manager(ServiceManagerAccess::CONNECT)?;
    let Ok(service) = manager.open_service(
        name,
        ServiceAccess::QUERY_STATUS | ServiceAccess::STOP | ServiceAccess::DELETE,
    ) else {
        return Ok(false);
    };
    stop_and_wait(&service)?;
    service.delete().context("could not delete the service")?;
    Ok(true)
}

/// One word for `status`: running, stopped, … or "not installed".
#[must_use]
pub fn state(name: &str) -> String {
    let Ok(manager) = manager(ServiceManagerAccess::CONNECT) else {
        return "unknown (could not open the service manager)".into();
    };
    match manager.open_service(name, ServiceAccess::QUERY_STATUS) {
        Err(_) => "not installed".into(),
        Ok(service) => match service.query_status() {
            Ok(status) => format!("{:?}", status.current_state).to_lowercase(),
            Err(e) => format!("unknown ({e})"),
        },
    }
}

/// What an extra rule on a restricted folder allows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Rights {
    /// Read, write and delete, but never change the rules or the owner
    /// (icacls `M`).
    Modify,
    /// Read and list only (icacls `RX`).
    ReadExecute,
}

/// One extra allow rule on a restricted folder, for a SID such as
/// [`LOCAL_SERVICE_SID`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Grant {
    pub sid: &'static str,
    pub rights: Rights,
}

/// The rules of a restricted folder in SDDL: a protected DACL (`P`, so no
/// rule is inherited from the folder above) giving SYSTEM and Administrators
/// full control, plus `extra`, every rule inherited by files (`OI`) and
/// folders (`CI`) inside.
#[must_use]
pub fn restricted_dir_sddl(extra: &[Grant]) -> String {
    let mut sddl = format!("D:P(A;OICI;FA;;;{SYSTEM_SID})(A;OICI;FA;;;{ADMINISTRATORS_SID})");
    for grant in extra {
        let rights = match grant.rights {
            Rights::Modify => "0x1301bf",
            Rights::ReadExecute => "0x1200a9",
        };
        for part in ["(A;OICI;", rights, ";;;", grant.sid, ")"] {
            sddl.push_str(part);
        }
    }
    sddl
}

/// Sets `dir` to [`restricted_dir_sddl`] and resets everything already
/// inside it to inherit those rules alone: any rule set on a file or folder
/// inside (and any protection from inheritance there) is removed, so an
/// existing settings file or database ends up exactly as private as a new
/// one. Needs an Administrator or SYSTEM (`WRITE_DAC` on every object).
///
/// # Errors
///
/// Fails when the rules cannot be built or applied to the folder or anything inside it.
pub fn restrict_dir(dir: &Path, extra: &[Grant]) -> Result<()> {
    use ::windows::core::{BOOL, PCWSTR};
    use ::windows::Win32::Foundation::{LocalFree, ERROR_SUCCESS, HLOCAL};
    use ::windows::Win32::Security::Authorization::{
        ConvertStringSecurityDescriptorToSecurityDescriptorW, ProgressInvokeNever,
        TreeResetNamedSecurityInfoW, SDDL_REVISION_1, SE_FILE_OBJECT,
    };
    use ::windows::Win32::Security::{
        GetSecurityDescriptorDacl, ACL, DACL_SECURITY_INFORMATION,
        PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR,
    };
    use std::os::windows::ffi::OsStrExt as _;

    let sddl: Vec<u16> = restricted_dir_sddl(extra)
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let path: Vec<u16> = dir.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut descriptor = PSECURITY_DESCRIPTOR::default();
    // SAFETY: both strings are NUL-terminated and outlive the calls; the
    // descriptor is allocated by Windows, the DACL points into it, and it is
    // freed only after TreeResetNamedSecurityInfoW has copied the rules.
    unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            PCWSTR(sddl.as_ptr()),
            SDDL_REVISION_1,
            &raw mut descriptor,
            None,
        )
        .context("could not build the folder's rules")?;
        let mut present = BOOL::default();
        let mut defaulted = BOOL::default();
        let mut dacl: *mut ACL = std::ptr::null_mut();
        let reset = GetSecurityDescriptorDacl(
            descriptor,
            &raw mut present,
            &raw mut dacl,
            &raw mut defaulted,
        )
        .map(|()| {
            TreeResetNamedSecurityInfoW(
                PCWSTR(path.as_ptr()),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                None,
                None,
                Some(dacl.cast_const()),
                None,
                false,
                None,
                ProgressInvokeNever,
                None,
            )
        });
        let _ = LocalFree(Some(HLOCAL(descriptor.0)));
        let error = reset.context("could not read the folder's rules")?;
        if error != ERROR_SUCCESS {
            bail!(
                "could not restrict {}: {}",
                dir.display(),
                std::io::Error::from_raw_os_error(error.0.cast_signed())
            );
        }
    }
    Ok(())
}

/// [`restrict_dir`], but only when `dir`'s own rules differ from
/// [`restricted_dir_sddl`]. Resetting a tree rewrites the rules of every
/// file in it, which for a backup of tens of thousands of messages takes
/// minutes; every upgrade calls this, so an unchanged folder is left alone.
/// Returns whether it reset the tree.
///
/// # Errors
///
/// Fails when the wanted rules cannot be built, or the reset fails.
pub fn restrict_dir_if_changed(dir: &Path, extra: &[Grant]) -> Result<bool> {
    let wanted = canonical_dacl(&restricted_dir_sddl(extra))?;
    match dir_dacl(dir) {
        Ok(current) if same_rules(&current, &wanted) => Ok(false),
        _ => restrict_dir(dir, extra).map(|()| true),
    }
}

/// Whether two DACLs in SDDL are protected alike and hold the same rules.
/// Windows adds `AI` (auto-inherited) to a folder it has reset, so only the
/// protection flag and the rules themselves are compared.
#[must_use]
pub fn same_rules(current: &str, wanted: &str) -> bool {
    fn split(sddl: &str) -> (bool, &str) {
        let body = sddl.strip_prefix("D:").unwrap_or(sddl);
        match body.find('(') {
            Some(at) => (body[..at].contains('P'), &body[at..]),
            None => (body.contains('P'), ""),
        }
    }
    split(current) == split(wanted)
}

/// `sddl` as Windows itself writes it back, so two DACLs compare alike.
fn canonical_dacl(sddl: &str) -> Result<String> {
    use ::windows::core::PCWSTR;
    use ::windows::Win32::Foundation::{LocalFree, HLOCAL};
    use ::windows::Win32::Security::Authorization::{
        ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
    };
    use ::windows::Win32::Security::PSECURITY_DESCRIPTOR;

    let wide: Vec<u16> = sddl.encode_utf16().chain(Some(0)).collect();
    let mut descriptor = PSECURITY_DESCRIPTOR::default();
    // SAFETY: the string is NUL-terminated; Windows allocates the descriptor,
    // which is freed after it has been written back as text.
    unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            PCWSTR(wide.as_ptr()),
            SDDL_REVISION_1,
            &raw mut descriptor,
            None,
        )
        .context("could not build the folder's rules")?;
        let text = descriptor_dacl_text(descriptor);
        let _ = LocalFree(Some(HLOCAL(descriptor.0)));
        text
    }
}

/// `dir`'s own DACL, in SDDL.
fn dir_dacl(dir: &Path) -> Result<String> {
    use ::windows::core::PCWSTR;
    use ::windows::Win32::Foundation::{LocalFree, ERROR_SUCCESS, HLOCAL};
    use ::windows::Win32::Security::Authorization::{GetNamedSecurityInfoW, SE_FILE_OBJECT};
    use ::windows::Win32::Security::{DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR};
    use std::os::windows::ffi::OsStrExt as _;

    let path: Vec<u16> = dir.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut descriptor = PSECURITY_DESCRIPTOR::default();
    // SAFETY: the path is NUL-terminated; Windows allocates the descriptor,
    // which is freed after it has been written back as text.
    unsafe {
        let error = GetNamedSecurityInfoW(
            PCWSTR(path.as_ptr()),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            None,
            None,
            None,
            None,
            &raw mut descriptor,
        );
        if error != ERROR_SUCCESS {
            bail!(
                "could not read the rules of {}: {}",
                dir.display(),
                std::io::Error::from_raw_os_error(error.0.cast_signed())
            );
        }
        let text = descriptor_dacl_text(descriptor);
        let _ = LocalFree(Some(HLOCAL(descriptor.0)));
        text
    }
}

/// The DACL part of a security descriptor, as SDDL text.
///
/// # Safety
/// `descriptor` must be a valid security descriptor.
unsafe fn descriptor_dacl_text(
    descriptor: ::windows::Win32::Security::PSECURITY_DESCRIPTOR,
) -> Result<String> {
    use ::windows::core::PWSTR;
    use ::windows::Win32::Foundation::{LocalFree, HLOCAL};
    use ::windows::Win32::Security::Authorization::{
        ConvertSecurityDescriptorToStringSecurityDescriptorW, SDDL_REVISION_1,
    };
    use ::windows::Win32::Security::DACL_SECURITY_INFORMATION;

    let mut text = PWSTR::null();
    // SAFETY: the caller vouches for the descriptor; Windows allocates the
    // string, which is copied and then freed.
    unsafe {
        ConvertSecurityDescriptorToStringSecurityDescriptorW(
            descriptor,
            SDDL_REVISION_1,
            DACL_SECURITY_INFORMATION,
            &raw mut text,
            None,
        )
        .context("could not write the folder's rules as text")?;
        let result = text.to_string().context("the folder's rules are not text");
        let _ = LocalFree(Some(HLOCAL(text.0.cast())));
        result
    }
}

/// What a running service reports: stop and shutdown are accepted while it
/// runs; a non-zero exit code is service-specific.
#[must_use]
pub fn status(state: ServiceState, exit_code: u32) -> ServiceStatus {
    ServiceStatus {
        service_type: ServiceType::OWN_PROCESS,
        current_state: state,
        controls_accepted: if state == ServiceState::Running {
            ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN
        } else {
            ServiceControlAccept::empty()
        },
        exit_code: if exit_code == 0 {
            ServiceExitCode::Win32(0)
        } else {
            ServiceExitCode::ServiceSpecific(exit_code)
        },
        checkpoint: 0,
        wait_hint: Duration::from_secs(10),
        process_id: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unchanged_data_folder_is_recognised_and_a_changed_one_is_not() {
        let grants = [Grant {
            sid: LOCAL_SERVICE_SID,
            rights: Rights::Modify,
        }];
        let wanted = canonical_dacl(&restricted_dir_sddl(&grants)).unwrap();
        assert!(wanted.starts_with("D:P("), "{wanted}");
        // Windows marks a reset folder auto-inherited (AI): still the same rules.
        let reset = wanted.replacen("D:P", "D:PAI", 1);
        assert!(same_rules(&reset, &wanted));
        // Inheriting again from the parent (no P), or one rule fewer, is a change.
        assert!(!same_rules(&wanted.replacen("D:P", "D:AI", 1), &wanted));
        let fewer = canonical_dacl(&restricted_dir_sddl(&[])).unwrap();
        assert!(!same_rules(&fewer, &wanted));
        // A folder Lookstow never locked reads back with other rules.
        let plain = std::env::temp_dir().join(format!("lookstow-dacl-{}", std::process::id()));
        std::fs::create_dir_all(&plain).unwrap();
        let current = dir_dacl(&plain).unwrap();
        std::fs::remove_dir_all(&plain).unwrap();
        assert!(current.starts_with("D:"), "{current}");
        assert!(!same_rules(&current, &wanted), "{current}");
    }

    fn spec(account: Account) -> ServiceSpec {
        ServiceSpec {
            name: "LookstowTest",
            display_name: "Lookstow Test",
            description: "A test.",
            executable: PathBuf::from(r"C:\Program Files\Lookstow Test\test.exe"),
            arguments: vec!["run".into(), "--service".into()],
            account,
        }
    }

    #[test]
    fn services_start_with_windows_under_the_chosen_account() {
        let system = service_info(&spec(Account::LocalSystem));
        assert_eq!(system.start_type, ServiceStartType::AutoStart);
        assert_eq!(system.account_name, None);
        assert_eq!(
            system.launch_arguments,
            vec![OsString::from("run"), OsString::from("--service")]
        );
        let local = service_info(&spec(Account::LocalService));
        assert_eq!(
            local.account_name,
            Some(OsString::from(r"NT AUTHORITY\LocalService"))
        );
        assert_eq!(local.account_password, None);
    }

    #[test]
    fn failures_restart_after_ten_seconds() {
        let actions = failure_actions().actions.unwrap();
        assert_eq!(actions.len(), 3);
        assert!(actions.iter().all(|action| {
            action.action_type == ServiceActionType::Restart
                && action.delay == Duration::from_secs(10)
        }));
    }

    #[test]
    fn restricted_folders_keep_only_system_administrators_and_the_extras() {
        assert_eq!(
            restricted_dir_sddl(&[]),
            "D:P(A;OICI;FA;;;S-1-5-18)(A;OICI;FA;;;S-1-5-32-544)"
        );
        assert_eq!(
            restricted_dir_sddl(&[
                Grant {
                    sid: LOCAL_SERVICE_SID,
                    rights: Rights::Modify
                },
                Grant {
                    sid: "S-1-5-32-545",
                    rights: Rights::ReadExecute
                }
            ]),
            "D:P(A;OICI;FA;;;S-1-5-18)(A;OICI;FA;;;S-1-5-32-544)\
             (A;OICI;0x1301bf;;;S-1-5-19)(A;OICI;0x1200a9;;;S-1-5-32-545)"
        );
    }
}
