//! Per-workspace OpenCode XDG isolation (matches desktop `opencode serve` / ACP layout).
//!
//! OAuth and API credentials written by `opencode serve` live under
//! `<workspace>/.opencode/data`. ACP `opencode acp` processes must use the same
//! XDG_* paths or they will not see OAuth logins from the settings UI.

use std::collections::HashMap;
use std::path::Path;

const XDG_KEYS: [&str; 4] = [
    "XDG_DATA_HOME",
    "XDG_CONFIG_HOME",
    "XDG_STATE_HOME",
    "XDG_CACHE_HOME",
];

/// Ensure `<workspace>/.opencode/{data,config,state,cache}` exist.
pub fn ensure_opencode_xdg_dirs(workspace_path: &Path) -> std::io::Result<()> {
    let base = workspace_path.join(".opencode");
    for sub in ["data", "config", "state", "cache"] {
        std::fs::create_dir_all(base.join(sub))?;
    }
    Ok(())
}

/// Environment variables for an isolated OpenCode data plane in this workspace.
pub fn opencode_workspace_xdg_env(workspace_path: &Path) -> HashMap<String, String> {
    let base = workspace_path.join(".opencode");
    HashMap::from([
        (
            "XDG_DATA_HOME".to_string(),
            base.join("data").to_string_lossy().into_owned(),
        ),
        (
            "XDG_CONFIG_HOME".to_string(),
            base.join("config").to_string_lossy().into_owned(),
        ),
        (
            "XDG_STATE_HOME".to_string(),
            base.join("state").to_string_lossy().into_owned(),
        ),
        (
            "XDG_CACHE_HOME".to_string(),
            base.join("cache").to_string_lossy().into_owned(),
        ),
    ])
}

/// True when `key` is a workspace-scoped XDG override (must win over process env).
pub fn is_forced_workspace_xdg_key(key: &str) -> bool {
    XDG_KEYS.contains(&key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xdg_env_points_under_workspace_dot_opencode() {
        let dir = tempfile::tempdir().unwrap();
        let env = opencode_workspace_xdg_env(dir.path());
        assert!(env["XDG_DATA_HOME"].ends_with("/.opencode/data"));
        assert!(env["XDG_CONFIG_HOME"].ends_with("/.opencode/config"));
    }

    #[test]
    fn ensure_creates_all_four_subdirs() {
        let dir = tempfile::tempdir().unwrap();
        ensure_opencode_xdg_dirs(dir.path()).unwrap();
        let base = dir.path().join(".opencode");
        assert!(base.join("data").is_dir());
        assert!(base.join("config").is_dir());
        assert!(base.join("state").is_dir());
        assert!(base.join("cache").is_dir());
    }
}
