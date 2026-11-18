//! Build-time facts the launcher and updater carry:
//!
//! * `LOOKSTOW_TARGET`: the target triple; the updater installs only releases
//!   for it.
//! * `LOOKSTOW_EXTRA_RELEASE_KEY`: one more trusted release key, only when the
//!   variable of that name is set at build time (development builds and
//!   self-builders). Empty otherwise, so a release build trusts only the
//!   project key in `release-key.pub`.
fn main() {
    println!(
        "cargo:rustc-env=LOOKSTOW_TARGET={}",
        std::env::var("TARGET").expect("Cargo target")
    );
    let extra = std::env::var("LOOKSTOW_EXTRA_RELEASE_KEY").unwrap_or_default();
    println!(
        "cargo:rustc-env=LOOKSTOW_EXTRA_RELEASE_KEY={}",
        extra.trim()
    );
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=release-key.pub");
    println!("cargo:rerun-if-env-changed=LOOKSTOW_EXTRA_RELEASE_KEY");
}
