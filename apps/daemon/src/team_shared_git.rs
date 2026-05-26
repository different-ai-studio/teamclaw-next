use crate::supabase::TeamWorkspaceConfigRow;
use std::path::{Component, Path, PathBuf};
use std::process::Command;

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

pub fn setup_or_sync_shared_dir(
    workspace_root: &Path,
    config: &TeamWorkspaceConfigRow,
) -> anyhow::Result<TeamSharedGitStatus> {
    let team_dir = shared_dir_path(workspace_root, &config.shared_dir_name)?;
    let Some(git_url) = config.git_url.as_deref().filter(|u| !u.trim().is_empty()) else {
        return Ok(TeamSharedGitStatus {
            shared_dir_path: team_dir,
            configured: false,
            synced: false,
        });
    };

    let remote_url = embed_token_in_url(git_url, config.git_token.as_deref());
    if !team_dir.exists() {
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
        let (ok, _, stderr) = git_owned(&args, workspace_root)?;
        if !ok {
            anyhow::bail!("git clone failed: {}", stderr.trim());
        }
    } else if team_dir.join(".git").exists() {
        let _ = git(&["remote", "set-url", "origin", &remote_url], &team_dir);
    } else {
        anyhow::bail!(
            "shared directory {} exists but is not a git repository",
            team_dir.display()
        );
    }

    ensure_scaffold(&team_dir)?;

    let (_, status, _) = git(&["status", "--porcelain"], &team_dir)?;
    let had_local_changes = !status.trim().is_empty();
    if had_local_changes {
        let _ = git(&["add", "-A"], &team_dir);
        let _ = git(&["commit", "-m", "chore: daemon sync"], &team_dir);
    }

    let branch = current_branch(&team_dir, config.git_branch.as_deref());
    let (ok, _, stderr) = git(&["fetch", "origin"], &team_dir)?;
    if !ok {
        anyhow::bail!("git fetch failed: {}", stderr.trim());
    }
    let (ok, _, stderr) = git(&["pull", "--rebase", "origin", &branch], &team_dir)?;
    if !ok {
        let _ = git(&["rebase", "--abort"], &team_dir);
        anyhow::bail!("git pull --rebase failed: {}", stderr.trim());
    }
    if had_local_changes {
        let (ok, _, stderr) = git(&["push", "origin", &branch], &team_dir)?;
        if !ok {
            anyhow::bail!("git push failed: {}", stderr.trim());
        }
    }

    Ok(TeamSharedGitStatus {
        shared_dir_path: team_dir,
        configured: true,
        synced: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
