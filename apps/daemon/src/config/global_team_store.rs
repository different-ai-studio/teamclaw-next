//! Single authority for where a team's synced content lives on disk.
//!
//! One global copy per team, keyed by `team_id`, under the daemon home
//! (`~/.amuxd`). Every workspace of that team exposes this directory via a
//! `teamclaw-team` symlink (see `workspace_link`).

use std::path::PathBuf;

use super::DaemonConfig;

/// The link/dir name surfaced inside each workspace. Mirrors the desktop
/// `teamclaw-introspect` `TEAM_REPO_DIR` const; kept in sync by value.
pub const TEAM_LINK_NAME: &str = "teamclaw-team";

/// Fixed top-level subdirectories the sync engine watches inside the team dir.
/// Mirrors `oss_sync::path_validator::ALLOWED_PREFIXES` (without trailing `/`).
pub const SHARED_PREFIXES: &[&str] = &[
    "skills",
    "knowledge",
    ".mcp",
    "_meta",
    "_secrets",
    "_feedback",
];

/// `~/.amuxd/teams/<team_id>/teamclaw-team` — the one synced copy.
pub fn global_team_dir(team_id: &str) -> PathBuf {
    DaemonConfig::config_dir()
        .join("teams")
        .join(team_id)
        .join(TEAM_LINK_NAME)
}

/// `~/.amuxd/teams/<team_id>/sync/state.json` — OSS sync state, one per team.
pub fn global_sync_state_path(team_id: &str) -> PathBuf {
    DaemonConfig::config_dir()
        .join("teams")
        .join(team_id)
        .join("sync")
        .join("state.json")
}

/// Create the team dir and the fixed shared-prefix subdirectories if missing.
/// Returns the team dir path.
pub fn ensure_initialized(team_id: &str) -> std::io::Result<PathBuf> {
    let dir = global_team_dir(team_id);
    std::fs::create_dir_all(&dir)?;
    for prefix in SHARED_PREFIXES {
        std::fs::create_dir_all(dir.join(prefix))?;
    }
    Ok(dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn global_dir_is_keyed_by_team_id() {
        let a = global_team_dir("team-a");
        let b = global_team_dir("team-b");
        assert_ne!(a, b);
        assert!(a.ends_with("teams/team-a/teamclaw-team"));
        assert!(global_sync_state_path("team-a").ends_with("teams/team-a/sync/state.json"));
    }

    #[test]
    fn ensure_initialized_creates_all_prefixes() {
        // Redirect HOME so config_dir() points at a temp dir.
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("HOME", tmp.path());
        let dir = ensure_initialized("team-x").unwrap();
        assert!(dir.is_dir());
        for prefix in SHARED_PREFIXES {
            assert!(dir.join(prefix).is_dir(), "{prefix} should exist");
        }
    }
}
