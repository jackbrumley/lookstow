//! Service plumbing for the `lookstow` launcher: systemd units on Linux,
//! the service manager and data folder rules on Windows, and a size-capped
//! log file for the Windows service, which has no console.
//!
//! The launcher keeps its own names, paths and unit text; only the
//! mechanics live here.

pub mod log_file;
#[cfg(target_os = "linux")]
pub mod systemd;
#[cfg(windows)]
pub mod windows;
