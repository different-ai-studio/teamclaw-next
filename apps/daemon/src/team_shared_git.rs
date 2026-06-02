use serde::Deserialize;
use std::path::{Component, Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamSharedGitConfig {
    #[serde(default)]
    pub git_url: Option<String>,
    #[serde(default)]
    pub git_branch: Option<String>,
    #[serde(default)]
    pub git_token: Option<String>,
    #[serde(default = "default_shared_dir_name")]
    pub shared_dir_name: String,
    #[serde(default)]
    pub env_secret: Option<String>,
    #[serde(default)]
    pub enabled: bool,
}

fn default_shared_dir_name() -> String {
    crate::config::global_team_store::TEAM_LINK_NAME.to_string()
}

/// Read the enabled `team` section from `{workspace}/.teamclaw/teamclaw.json`.
pub fn read_team_config(workspace_root: &Path) -> Option<TeamSharedGitConfig> {
    let path = workspace_root.join(".teamclaw").join("teamclaw.json");
    let body = std::fs::read_to_string(&path).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&body).ok()?;
    parsed
        .get("team")
        .and_then(|team| serde_json::from_value::<TeamSharedGitConfig>(team.clone()).ok())
        .filter(|team| team.enabled)
}

/// Enabled git-backed team config (`gitUrl` required).
pub fn read_git_team_config(workspace_root: &Path) -> Option<TeamSharedGitConfig> {
    read_team_config(workspace_root).filter(|team| {
        team.git_url
            .as_deref()
            .map(|url| !url.trim().is_empty())
            .unwrap_or(false)
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TeamSharedGitStatus {
    pub shared_dir_path: PathBuf,
    pub configured: bool,
    pub synced: bool,
}

pub fn validate_shared_dir_name(name: &str) -> anyhow::Result<()> {
    if name.is_empty() || name.len() > 64 {
        anyhow::bail!("shared_dir_name must be 1-64 characters");
    }
    if name == "." || name == ".." || name.starts_with('.') {
        anyhow::bail!("shared_dir_name cannot be hidden, . or ..");
    }
    if name.contains('/') || name.contains('\\') {
        anyhow::bail!("shared_dir_name cannot contain path separators");
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
    {
        anyhow::bail!("shared_dir_name contains unsupported characters");
    }
    Ok(())
}

pub fn shared_dir_path(workspace_root: &Path, shared_dir_name: &str) -> anyhow::Result<PathBuf> {
    validate_shared_dir_name(shared_dir_name)?;
    let path = workspace_root.join(shared_dir_name);
    for component in path.components() {
        if matches!(component, Component::ParentDir) {
            anyhow::bail!("shared directory path cannot contain ..");
        }
    }
    if !path.starts_with(workspace_root) {
        anyhow::bail!("shared directory must stay inside workspace");
    }
    Ok(path)
}

fn git(args: &[&str], cwd: &Path) -> anyhow::Result<(bool, String, String)> {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()?;
    Ok((
        output.status.success(),
        String::from_utf8_lossy(&output.stdout).to_string(),
        String::from_utf8_lossy(&output.stderr).to_string(),
    ))
}

fn git_owned(args: &[String], cwd: &Path) -> anyhow::Result<(bool, String, String)> {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()?;
    Ok((
        output.status.success(),
        String::from_utf8_lossy(&output.stdout).to_string(),
        String::from_utf8_lossy(&output.stderr).to_string(),
    ))
}

fn embed_token_in_url(url: &str, token: Option<&str>) -> String {
    let Some(token) = token.map(str::trim).filter(|t| !t.is_empty()) else {
        return url.to_string();
    };
    if let Some(rest) = url.strip_prefix("https://") {
        format!("https://oauth2:{token}@{rest}")
    } else if let Some(rest) = url.strip_prefix("http://") {
        format!("http://oauth2:{token}@{rest}")
    } else {
        url.to_string()
    }
}

fn current_branch(team_dir: &Path, fallback: Option<&str>) -> String {
    if let Some(branch) = fallback.filter(|b| !b.trim().is_empty()) {
        return branch.to_string();
    }
    let (ok, stdout, _) = git(&["rev-parse", "--abbrev-ref", "HEAD"], team_dir).unwrap_or((
        false,
        String::new(),
        String::new(),
    ));
    if ok && !stdout.trim().is_empty() && stdout.trim() != "HEAD" {
        stdout.trim().to_string()
    } else {
        "main".to_string()
    }
}

fn ensure_scaffold(team_dir: &Path) -> anyhow::Result<()> {
    std::fs::create_dir_all(team_dir.join("_secrets"))?;
    Ok(())
}

/// Sync a git-backed team dir at an explicit path (used for the global,
/// per-team copy). The dir is created/cloned if missing.
pub fn sync_git_dir(
    team_dir: &Path,
    config: &TeamSharedGitConfig,
) -> anyhow::Result<TeamSharedGitStatus> {
    let Some(git_url) = config.git_url.as_deref().filter(|u| !u.trim().is_empty()) else {
        return Ok(TeamSharedGitStatus {
            shared_dir_path: team_dir.to_path_buf(),
            configured: false,
            synced: false,
        });
    };

    let remote_url = embed_token_in_url(git_url, config.git_token.as_deref());
    let clone_parent = team_dir.parent().unwrap_or(Path::new("."));
    if !team_dir.exists() {
        std::fs::create_dir_all(clone_parent)?;
        let mut args = vec!["clone".to_string()];
        if let Some(branch) = config
            .git_branch
            .as_deref()
            .filter(|b| !b.trim().is_empty())
        {
            args.push("-b".to_string());
            args.push(branch.to_string());
        }
        args.push(remote_url);
        args.push(team_dir.to_string_lossy().to_string());
        let (ok, _, stderr) = git_owned(&args, clone_parent)?;
        if !ok {
            anyhow::bail!("git clone failed: {}", stderr.trim());
        }
    } else if team_dir.join(".git").exists() {
        let _ = git(&["remote", "set-url", "origin", &remote_url], team_dir);
    } else {
        anyhow::bail!(
            "shared directory {} exists but is not a git repository",
            team_dir.display()
        );
    }

    ensure_scaffold(team_dir)?;

    let (_, status, _) = git(&["status", "--porcelain"], team_dir)?;
    let had_local_changes = !status.trim().is_empty();
    if had_local_changes {
        let _ = git(&["add", "-A"], team_dir);
        let _ = git(&["commit", "-m", "chore: daemon sync"], team_dir);
    }

    let branch = current_branch(team_dir, config.git_branch.as_deref());
    let (ok, _, stderr) = git(&["fetch", "origin"], team_dir)?;
    if !ok {
        anyhow::bail!("git fetch failed: {}", stderr.trim());
    }
    let (ok, _, stderr) = git(&["pull", "--rebase", "origin", &branch], team_dir)?;
    if !ok {
        let _ = git(&["rebase", "--abort"], team_dir);
        anyhow::bail!("git pull --rebase failed: {}", stderr.trim());
    }
    if had_local_changes {
        let (ok, _, stderr) = git(&["push", "origin", &branch], team_dir)?;
        if !ok {
            anyhow::bail!("git push failed: {}", stderr.trim());
        }
    }

    Ok(TeamSharedGitStatus {
        shared_dir_path: team_dir.to_path_buf(),
        configured: true,
        synced: true,
    })
}

/// Backwards-compatible wrapper: sync the team dir located inside a workspace.
pub fn setup_or_sync_shared_dir(
    workspace_root: &Path,
    config: &TeamSharedGitConfig,
) -> anyhow::Result<TeamSharedGitStatus> {
    let team_dir = shared_dir_path(workspace_root, &config.shared_dir_name)?;
    sync_git_dir(&team_dir, config)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sync_git_dir_returns_not_configured_without_url() {
        let tmp = tempfile::tempdir().unwrap();
        let team_dir = tmp.path().join("teamclaw-team");
        std::fs::create_dir_all(&team_dir).unwrap();
        let config: TeamSharedGitConfig = serde_json::from_value(serde_json::json!({
            "enabled": true
        }))
        .unwrap();
        let status = sync_git_dir(&team_dir, &config).unwrap();
        assert_eq!(status.shared_dir_path, team_dir);
        assert!(!status.configured);
        assert!(!status.synced);
    }

    #[test]
    fn rejects_unsafe_shared_dir_names() {
        for value in ["", ".", "..", ".hidden", "../bad", "bad/name"] {
            assert!(validate_shared_dir_name(value).is_err(), "{value}");
        }
    }

    #[test]
    fn resolves_shared_dir_under_workspace() {
        let path = shared_dir_path(Path::new("/tmp/workspace"), "teamclaw").unwrap();
        assert_eq!(path, PathBuf::from("/tmp/workspace/teamclaw"));
    }

    #[test]
    fn deserializes_workspace_team_config_shape() {
        let config: TeamSharedGitConfig = serde_json::from_value(serde_json::json!({
            "gitUrl": "https://example.com/repo.git",
            "gitBranch": "main",
            "gitToken": "token",
            "sharedDirName": "teamclaw",
            "envSecret": "00",
            "enabled": true
        }))
        .unwrap();

        assert_eq!(
            config.git_url.as_deref(),
            Some("https://example.com/repo.git")
        );
        assert_eq!(config.git_branch.as_deref(), Some("main"));
        assert_eq!(config.git_token.as_deref(), Some("token"));
        assert_eq!(config.shared_dir_name, "teamclaw");
        assert_eq!(config.env_secret.as_deref(), Some("00"));
        assert!(config.enabled);
    }
}
