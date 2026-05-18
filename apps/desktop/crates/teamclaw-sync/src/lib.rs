//! teamclaw-sync: WebDAV sync support for TeamClaw.
//!
//! This crate contains:
//! - WebDAV sync logic (PROPFIND parser, diff, download, crypto)
//! - Version history types
//!
//! Tauri command wrappers remain in the main crate.

pub mod team_webdav;
pub mod version_types;

pub use version_types::{FileVersion, VersionedFileInfo, MAX_VERSIONS};
