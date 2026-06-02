//! Shared team-directory path helpers.
//!
//! Plan B Task 8: the team shared-Git SYNC ENGINE has been deleted — the daemon
//! owns all team-repo clone/sync/status now. What remains here are the
//! workspace-relative shared-directory path/name helpers that survive because
//! they are still used by:
//!   - `crate::commands::shared_secrets` (locating the team `_secrets` dir), and
//!   - `crate::commands::team::team_disconnect_repo` (resolving the dir to remove).
//!
//! The deleted engine included: `setup_shared_git_repo`, `sync_shared_git_repo`,
//! `status_for_shared_dir`, the `team_shared_git_*` Tauri commands (moved to
//! `crate::commands::team_sync_proxy`), and all the git/clone plumbing.

use std::path::{Component, Path, PathBuf};

const DEFAULT_SHARED_DIR_NAME: &str = "teamclaw";

pub fn shared_dir_name_or_default(name: Option<&str>) -> Result<String, String> {
    let trimmed = name
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_SHARED_DIR_NAME);
    validate_shared_dir_name(trimmed)?;
    Ok(trimmed.to_string())
}

pub fn validate_shared_dir_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > 64 {
        return Err("Shared directory name must be 1-64 characters".to_string());
    }
    if name == "." || name == ".." {
        return Err("Shared directory name cannot be . or ..".to_string());
    }
    if name.starts_with('.') {
        return Err("Shared directory name cannot start with .".to_string());
    }
    if name.contains('/') || name.contains('\\') {
        return Err("Shared directory name cannot contain path separators".to_string());
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
    {
        return Err(
            "Shared directory name may contain only letters, numbers, '.', '_' and '-'".to_string(),
        );
    }
    if !name
        .chars()
        .next()
        .map(|c| c.is_ascii_alphanumeric())
        .unwrap_or(false)
    {
        return Err("Shared directory name must start with a letter or number".to_string());
    }
    Ok(())
}

pub fn shared_dir_path(
    workspace_path: &str,
    shared_dir_name: Option<&str>,
) -> Result<PathBuf, String> {
    let workspace = Path::new(workspace_path);
    if workspace_path.trim().is_empty() {
        return Err("No workspace path set. Please select a workspace first.".to_string());
    }
    if !workspace.is_absolute() {
        return Err("Workspace path must be absolute".to_string());
    }
    let name = shared_dir_name_or_default(shared_dir_name)?;
    let path = workspace.join(name);
    for component in path.components() {
        if matches!(component, Component::ParentDir) {
            return Err("Shared directory path cannot contain ..".to_string());
        }
    }
    if !path.starts_with(workspace) {
        return Err("Shared directory must stay inside the workspace".to_string());
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_dir_name_validation_rejects_paths() {
        for invalid in [
            "",
            ".",
            "..",
            "../bad",
            "/tmp/teamclaw",
            "bad/name",
            ".hidden",
        ] {
            assert!(validate_shared_dir_name(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn shared_dir_name_validation_accepts_safe_names() {
        for valid in ["teamclaw", "teamclaw_2", "team.shared-2"] {
            assert!(validate_shared_dir_name(valid).is_ok(), "{valid}");
        }
    }

    #[test]
    fn shared_dir_path_stays_under_workspace() {
        let path = shared_dir_path("/tmp/workspace", Some("teamclaw")).unwrap();
        assert_eq!(path, PathBuf::from("/tmp/workspace/teamclaw"));
        assert!(shared_dir_path("/tmp/workspace", Some("../bad")).is_err());
    }
}
