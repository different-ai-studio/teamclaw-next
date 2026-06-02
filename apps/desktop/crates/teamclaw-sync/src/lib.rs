//! teamclaw-sync: shared sync types for TeamClaw.
//!
//! The WebDAV sync engine was removed when the daemon (amuxd) took over all
//! team sync. What remains is the version-history type surface shared with the
//! desktop crate's Tauri commands.

pub mod version_types;

pub use version_types::{FileVersion, VersionedFileInfo, MAX_VERSIONS};
