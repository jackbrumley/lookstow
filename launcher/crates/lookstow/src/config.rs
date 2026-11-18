//! `server.env`: the app's settings, written once by `install` and kept on
//! upgrades. Node reads it (`--env-file`); the launcher reads only HOST and
//! PORT, to print the address.

use anyhow::{bail, Context as _, Result};
use base64::Engine as _;
use std::io::Write as _;
use std::path::Path;

/// Port of a fresh install (SPEC-INSTALL-AND-UPDATES, Decisions).
pub const DEFAULT_PORT: u16 = 8030;

/// The settings of a fresh install: a new secrets key, and the console on
/// this machine only (plain HTTP on the loopback address).
pub fn new_config(secrets_key: &str, port: u16) -> String {
    format!(
        "\
# Lookstow settings. Written once by `lookstow install` and kept on
# upgrades. Edit, then restart the service. DATABASE_PATH is set by the
# launcher (the data folder), so leave it out.

# Encrypts secrets at rest. Back it up with lookstow.db; never share it.
SECRETS_KEY={secrets_key}

# Where the console listens. 127.0.0.1 keeps it on this machine only: open
# http://127.0.0.1:{port} here.
HOST=127.0.0.1
PORT={port}
"
    )
}

/// 32 random bytes in base64, like `openssl rand -base64 32`.
pub fn new_secrets_key() -> Result<String> {
    let mut key = [0u8; 32];
    getrandom::getrandom(&mut key).context("could not make a secrets key")?;
    Ok(base64::engine::general_purpose::STANDARD.encode(key))
}

/// Writes a fresh `server.env` (private to its owner) unless one exists;
/// returns whether it wrote one.
pub fn write_if_missing(path: &Path, port: u16) -> Result<bool> {
    if path.exists() {
        return Ok(false);
    }
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .with_context(|| format!("could not create {}", path.display()))?;
    file.write_all(new_config(&new_secrets_key()?, port).as_bytes())
        .with_context(|| format!("could not write {}", path.display()))?;
    Ok(true)
}

/// The last `KEY=value` for `key`, without surrounding quotes; comments and
/// other lines are skipped, as Node's `--env-file` does.
pub fn value(text: &str, key: &str) -> Option<String> {
    text.lines()
        .rev()
        .filter_map(|line| line.trim().split_once('='))
        .filter(|(name, _)| name.trim() == key)
        .map(|(_, value)| {
            let value = value.trim();
            let quoted = value.len() >= 2
                && (value.starts_with('"') && value.ends_with('"')
                    || value.starts_with('\'') && value.ends_with('\''));
            if quoted {
                value[1..value.len() - 1].to_string()
            } else {
                value.to_string()
            }
        })
        .next()
}

/// Where the console listens, as `server.env` says.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Listen {
    pub host: String,
    pub port: u16,
}

impl Listen {
    /// The address to open in a browser. A wildcard host listens on every
    /// address, so the loopback one works on this machine.
    pub fn url(&self) -> String {
        let host = match self.host.as_str() {
            "0.0.0.0" => "127.0.0.1",
            "::" | "[::]" => "[::1]",
            host if host.contains(':') && !host.starts_with('[') => {
                return format!("http://[{host}]:{}", self.port)
            }
            host => host,
        };
        format!("http://{host}:{}", self.port)
    }
}

/// HOST and PORT from `server.env`; both are written by `install`, so a
/// missing one is an error rather than a guess at the app's default.
pub fn listen(text: &str) -> Result<Listen> {
    let file = super::layout::ENV_FILE;
    let Some(port) = value(text, "PORT") else {
        bail!("PORT is not set in {file}");
    };
    let Ok(port) = port.parse() else {
        bail!("PORT={port} in {file} is not a port number");
    };
    let Some(host) = value(text, "HOST").filter(|host| !host.is_empty()) else {
        bail!("HOST is not set in {file}");
    };
    Ok(Listen { host, port })
}

/// `listen` for the file at `path`.
pub fn read_listen(path: &Path) -> Result<Listen> {
    let text = std::fs::read_to_string(path)
        .with_context(|| format!("could not read {}", path.display()))?;
    listen(&text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fresh_config_has_a_key_and_listens_on_this_machine_only() {
        let key = new_secrets_key().unwrap();
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&key)
            .unwrap();
        assert_eq!(decoded.len(), 32);
        assert_ne!(key, new_secrets_key().unwrap());

        let text = new_config(&key, DEFAULT_PORT);
        assert_eq!(value(&text, "SECRETS_KEY"), Some(key));
        let listen = listen(&text).unwrap();
        assert_eq!(
            listen,
            Listen {
                host: "127.0.0.1".into(),
                port: 8030
            }
        );
        assert_eq!(listen.url(), "http://127.0.0.1:8030");
        assert_eq!(value(&text, "DATABASE_PATH"), None);
    }

    #[test]
    fn values_are_read_like_node_reads_them() {
        let text = "# PORT=1\nPORT = 9000\nORIGIN=\"https://a.example\"\nX='y'\nPORT=9001\n";
        assert_eq!(value(text, "PORT").as_deref(), Some("9001"));
        assert_eq!(value(text, "ORIGIN").as_deref(), Some("https://a.example"));
        assert_eq!(value(text, "X").as_deref(), Some("y"));
        assert_eq!(value(text, "MISSING"), None);
        assert!(listen("HOST=127.0.0.1\nPORT=eighty").is_err());
        assert!(listen("HOST=127.0.0.1").is_err());
        assert!(listen("PORT=8030").is_err());
    }

    #[test]
    fn the_address_names_a_host_a_browser_can_open() {
        let url = |host: &str| {
            Listen {
                host: host.into(),
                port: 8030,
            }
            .url()
        };
        assert_eq!(url("0.0.0.0"), "http://127.0.0.1:8030");
        assert_eq!(url("::"), "http://[::1]:8030");
        assert_eq!(url("fd00::5"), "http://[fd00::5]:8030");
        assert_eq!(url("backup.example"), "http://backup.example:8030");
    }

    #[test]
    fn an_existing_config_is_kept() {
        let dir = crate::layout::tests::scratch("config-keep");
        let path = dir.join("server.env");
        assert!(write_if_missing(&path, 47620).unwrap());
        let first = std::fs::read_to_string(&path).unwrap();
        assert!(!write_if_missing(&path, DEFAULT_PORT).unwrap());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), first);
        assert_eq!(read_listen(&path).unwrap().port, 47620);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
