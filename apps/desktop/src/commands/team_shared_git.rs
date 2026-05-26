use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use tauri::State;

use crate::commands::shared_secrets::SharedSecretsState;
use crate::commands::team::{SyncPrecheckFile, TeamGitResult, GITIGNORE_CONTENT};
use crate::process_util::CommandNoWindow;

const DEFAULT_SHARED_DIR_NAME: &str = "teamclaw";
const SYNC_PRECHECK_MAX_FILE_COUNT: usize = 50;
const SYNC_PRECHECK_MAX_SINGLE_FILE_BYTES: u64 = 10 * 1024 * 1024;
const SYNC_PRECHECK_MAX_TOTAL_BYTES: u64 = 100 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamSharedGitConfig {
    pub workspace_path: String,
    pub git_url: String,
    pub git_branch: Option<String>,
    pub git_token: Option<String>,
    pub shared_dir_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TeamSharedGitStatus {
    pub shared_dir_path: String,
    pub exists: bool,
    pub is_git_repo: bool,
    pub remote_url: Option<String>,
    pub branch: Option<String>,
    pub dirty: bool,
    pub ahead: i32,
    pub behind: i32,
}

fn run_git(args: &[&str], cwd: &Path) -> Result<(bool, String, String), String> {
    let output = Command::new("git")
        .no_window()
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| format!("Failed to execute git: {e}"))?;

    Ok((
        output.status.success(),
        String::from_utf8_lossy(&output.stdout).to_string(),
        String::from_utf8_lossy(&output.stderr).to_string(),
    ))
}

fn run_git_owned(args: &[String], cwd: &Path) -> Result<(bool, String, String), String> {
    let output = Command::new("git")
        .no_window()
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| format!("Failed to execute git: {e}"))?;

    Ok((
        output.status.success(),
        String::from_utf8_lossy(&output.stdout).to_string(),
        String::from_utf8_lossy(&output.stderr).to_string(),
    ))
}

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

fn embed_token_in_url(url: &str, token: Option<&str>) -> String {
    let Some(token) = token.map(str::trim).filter(|t| !t.is_empty()) else {
        return url.to_string();
    };
    if let Some(rest) = url.strip_prefix("https://") {
        if let Some((user_part, host_part)) = rest.split_once('@') {
            let user = user_part.split(':').next().unwrap_or("oauth2");
            format!("https://{}:{}@{}", user, token, host_part)
        } else {
            format!("https://oauth2:{}@{}", token, rest)
        }
    } else if let Some(rest) = url.strip_prefix("http://") {
        if let Some((user_part, host_part)) = rest.split_once('@') {
            let user = user_part.split(':').next().unwrap_or("oauth2");
            format!("http://{}:{}@{}", user, token, host_part)
        } else {
            format!("http://oauth2:{}@{}", token, rest)
        }
    } else {
        url.to_string()
    }
}

fn redact_remote_url(url: &str) -> String {
    if let Some((scheme, rest)) = url.split_once("://") {
        if let Some((_auth, host)) = rest.split_once('@') {
            return format!("{scheme}://{host}");
        }
    }
    url.to_string()
}

fn ensure_shared_dir_scaffold(team_dir: &Path) -> Result<(), String> {
    for d in ["skills", ".mcp", "knowledge", "_feedback", "_secrets"] {
        std::fs::create_dir_all(team_dir.join(d))
            .map_err(|e| format!("Failed to create {}: {e}", team_dir.join(d).display()))?;
    }
    let readme_path = team_dir.join("README.md");
    if !readme_path.exists() {
        let readme = "# TeamClaw Shared Directory\n\nShared team resources.\n\n## Structure\n\n- `skills/` - Shared agent skills\n- `.mcp/` - MCP server configurations\n- `knowledge/` - Shared knowledge base\n- `_feedback/` - Member feedback summaries\n- `_secrets/` - Encrypted team environment variables\n";
        std::fs::write(&readme_path, readme)
            .map_err(|e| format!("Failed to write {}: {e}", readme_path.display()))?;
    }
    Ok(())
}

fn ensure_gitignore_rules(team_dir: &Path) {
    let gitignore_path = team_dir.join(".gitignore");
    if !gitignore_path.exists() {
        let _ = std::fs::write(&gitignore_path, GITIGNORE_CONTENT);
        return;
    }
    let existing = match std::fs::read_to_string(&gitignore_path) {
        Ok(c) => c,
        Err(_) => return,
    };
    let mut missing = Vec::new();
    for line in GITIGNORE_CONTENT.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        if !existing.lines().any(|l| l.trim() == t) {
            missing.push(t.to_string());
        }
    }
    if missing.is_empty() {
        return;
    }
    let mut content = existing;
    if !content.ends_with('\n') {
        content.push('\n');
    }
    content.push_str("\n# Auto-added by TeamClaw\n");
    for line in &missing {
        content.push_str(line);
        content.push('\n');
    }
    let _ = std::fs::write(&gitignore_path, content);
}

fn parse_untracked_paths(porcelain_bytes: &[u8]) -> Vec<String> {
    porcelain_bytes
        .split(|&b| b == 0)
        .filter_map(|record| {
            if record.len() > 3 && record.starts_with(b"?? ") {
                Some(String::from_utf8_lossy(&record[3..]).to_string())
            } else {
                None
            }
        })
        .collect()
}

fn detect_precheck_breach(team_dir: &Path) -> Option<(Vec<SyncPrecheckFile>, u64)> {
    let output = Command::new("git")
        .no_window()
        .args(["status", "--porcelain", "-z", "-uall"])
        .current_dir(team_dir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }

    let paths = parse_untracked_paths(&output.stdout);
    let mut new_files = Vec::with_capacity(paths.len());
    let mut total_bytes = 0_u64;
    for rel_path in paths {
        let abs = team_dir.join(&rel_path);
        let size_bytes = std::fs::metadata(&abs).map(|m| m.len()).unwrap_or(0);
        total_bytes = total_bytes.saturating_add(size_bytes);
        new_files.push(SyncPrecheckFile {
            path: rel_path,
            size_bytes,
        });
    }

    let count_breach = new_files.len() > SYNC_PRECHECK_MAX_FILE_COUNT;
    let single_breach = new_files
        .iter()
        .any(|f| f.size_bytes > SYNC_PRECHECK_MAX_SINGLE_FILE_BYTES);
    let total_breach = total_bytes > SYNC_PRECHECK_MAX_TOTAL_BYTES;
    if count_breach || single_breach || total_breach {
        Some((new_files, total_bytes))
    } else {
        None
    }
}

fn current_branch(team_dir: &Path) -> String {
    let (ok, stdout, _) = run_git(&["rev-parse", "--abbrev-ref", "HEAD"], team_dir).unwrap_or((
        false,
        String::new(),
        String::new(),
    ));
    if ok && !stdout.trim().is_empty() && stdout.trim() != "HEAD" {
        return stdout.trim().to_string();
    }
    let (ok, stdout, _) = run_git(
        &["symbolic-ref", "refs/remotes/origin/HEAD", "--short"],
        team_dir,
    )
    .unwrap_or((false, String::new(), String::new()));
    if ok && !stdout.trim().is_empty() {
        return stdout
            .trim()
            .strip_prefix("origin/")
            .unwrap_or(stdout.trim())
            .to_string();
    }
    "main".to_string()
}

pub fn status_for_shared_dir(config: &TeamSharedGitConfig) -> Result<TeamSharedGitStatus, String> {
    let team_dir = shared_dir_path(&config.workspace_path, config.shared_dir_name.as_deref())?;
    let exists = team_dir.exists();
    let is_git_repo = team_dir.join(".git").exists();
    let mut status = TeamSharedGitStatus {
        shared_dir_path: team_dir.to_string_lossy().to_string(),
        exists,
        is_git_repo,
        ..Default::default()
    };
    if !is_git_repo {
        return Ok(status);
    }

    let (ok, stdout, _) = run_git(&["config", "--get", "remote.origin.url"], &team_dir)?;
    if ok {
        status.remote_url = Some(redact_remote_url(stdout.trim()));
    }
    let (ok, stdout, _) = run_git(&["rev-parse", "--abbrev-ref", "HEAD"], &team_dir)?;
    if ok {
        status.branch = Some(stdout.trim().to_string());
    }
    let (_, porcelain, _) = run_git(&["status", "--porcelain"], &team_dir)?;
    status.dirty = !porcelain.trim().is_empty();

    let (ok, stdout, _) = run_git(
        &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
        &team_dir,
    )
    .unwrap_or((false, String::new(), String::new()));
    if ok {
        let mut parts = stdout.split_whitespace();
        status.ahead = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        status.behind = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    }
    Ok(status)
}

pub fn setup_shared_git_repo(config: &TeamSharedGitConfig) -> Result<TeamSharedGitStatus, String> {
    let team_dir = shared_dir_path(&config.workspace_path, config.shared_dir_name.as_deref())?;
    let workspace = Path::new(&config.workspace_path);
    let remote_url = embed_token_in_url(&config.git_url, config.git_token.as_deref());

    if !team_dir.exists() {
        std::fs::create_dir_all(workspace)
            .map_err(|e| format!("Failed to create workspace {}: {e}", workspace.display()))?;
        let target = team_dir.to_string_lossy().to_string();
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
        args.push(target);
        let (ok, _, stderr) = run_git_owned(&args, workspace)?;
        if !ok {
            return Err(format!("git clone failed: {}", stderr.trim()));
        }
    } else if !team_dir.join(".git").exists() {
        let is_empty = team_dir
            .read_dir()
            .map(|mut entries| entries.next().is_none())
            .unwrap_or(false);
        if !is_empty {
            return Err(format!(
                "Shared directory '{}' exists but is not a git repository",
                team_dir.display()
            ));
        }
        let (ok, _, stderr) = run_git(&["init"], &team_dir)?;
        if !ok {
            return Err(format!("git init failed: {}", stderr.trim()));
        }
        let _ = run_git(&["remote", "remove", "origin"], &team_dir);
        let (ok, _, stderr) = run_git(&["remote", "add", "origin", &remote_url], &team_dir)?;
        if !ok {
            return Err(format!("git remote add failed: {}", stderr.trim()));
        }
    } else if !config.git_url.trim().is_empty() {
        let _ = run_git(&["remote", "set-url", "origin", &remote_url], &team_dir);
    }

    ensure_shared_dir_scaffold(&team_dir)?;
    ensure_gitignore_rules(&team_dir);
    status_for_shared_dir(config)
}

pub fn sync_shared_git_repo(
    config: &TeamSharedGitConfig,
    secrets_state: Option<&SharedSecretsState>,
    force: Option<bool>,
) -> Result<TeamGitResult, String> {
    if config.git_url.trim().is_empty() {
        return Err("Team shared Git URL is not configured".to_string());
    }
    let team_dir = shared_dir_path(&config.workspace_path, config.shared_dir_name.as_deref())?;
    if !team_dir.join(".git").exists() {
        setup_shared_git_repo(config)?;
    }
    if !team_dir.join(".git").exists() {
        return Err(format!(
            "Shared directory '{}' is not a usable git repository",
            team_dir.display()
        ));
    }

    let remote_url = embed_token_in_url(&config.git_url, config.git_token.as_deref());
    let _ = run_git(&["remote", "set-url", "origin", &remote_url], &team_dir);

    if !force.unwrap_or(false) {
        if let Some((new_files, total_bytes)) = detect_precheck_breach(&team_dir) {
            return Ok(TeamGitResult {
                success: false,
                message: String::new(),
                needs_confirmation: true,
                new_files,
                total_bytes,
            });
        }
    }

    let (_, status_out, _) = run_git(&["status", "--porcelain"], &team_dir)?;
    let had_local_changes = !status_out.trim().is_empty();
    if had_local_changes {
        let _ = run_git(&["add", "-A"], &team_dir);
        let changed_files: Vec<&str> = status_out
            .lines()
            .filter_map(|line| {
                let file = line.get(3..)?.split(" -> ").last()?.trim();
                if file.is_empty() || file.starts_with(".trash") {
                    None
                } else {
                    Some(file)
                }
            })
            .collect();
        let msg = if changed_files.len() <= 5 {
            format!("chore: sync ({})", changed_files.join(", "))
        } else {
            format!(
                "chore: sync ({}, ... +{} more)",
                changed_files[..3].join(", "),
                changed_files.len() - 3
            )
        };
        let _ = run_git(&["commit", "-m", &msg], &team_dir);
    }

    let branch = config
        .git_branch
        .as_deref()
        .filter(|b| !b.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| current_branch(&team_dir));
    let remote_ref = format!("origin/{branch}");

    let (ok, _, stderr) = run_git(&["fetch", "origin"], &team_dir)?;
    if !ok {
        return Err(format!("git fetch failed: {}", stderr.trim()));
    }
    let (ref_exists, _, _) = run_git(&["rev-parse", "--verify", &remote_ref], &team_dir)?;
    if !ref_exists {
        return Err(format!("Remote branch '{}' not found", remote_ref));
    }

    let (rebase_ok, _, _) = run_git(&["pull", "--rebase", "origin", &branch], &team_dir)?;
    let mut conflict_resolved = false;
    if !rebase_ok {
        let _ = run_git(&["rebase", "--abort"], &team_dir);
        let (_, diff_out, _) = run_git(&["diff", "--name-only", &remote_ref], &team_dir)?;
        if !diff_out.trim().is_empty() {
            let ts = chrono::Local::now().format("%Y%m%d_%H%M%S").to_string();
            let trash_dir = team_dir.join(".trash").join(&ts);
            let _ = std::fs::create_dir_all(&trash_dir);
            for file in diff_out.lines() {
                let file = file.trim();
                if file.is_empty() || file.starts_with(".trash") {
                    continue;
                }
                let src = team_dir.join(file);
                if src.is_file() {
                    let dest = trash_dir.join(file);
                    if let Some(parent) = dest.parent() {
                        let _ = std::fs::create_dir_all(parent);
                    }
                    let _ = std::fs::copy(&src, &dest);
                }
            }
        }
        let (ok, _, stderr) = run_git(&["reset", "--hard", &remote_ref], &team_dir)?;
        if !ok {
            return Err(format!("git reset failed: {}", stderr.trim()));
        }
        conflict_resolved = true;
    } else if had_local_changes {
        let (ok, _, stderr) = run_git(&["push", "origin", &branch], &team_dir)?;
        if !ok {
            log::warn!(
                "team_shared_git: push failed (non-fatal): {}",
                stderr.trim()
            );
        }
    }

    ensure_shared_dir_scaffold(&team_dir)?;
    ensure_gitignore_rules(&team_dir);

    if let Some(secrets_state) = secrets_state {
        if let Err(e) = crate::commands::shared_secrets::load_all_secrets(secrets_state) {
            log::warn!("team_shared_git: failed to reload shared secrets: {e}");
        }
    }

    let message = if conflict_resolved {
        format!("Synced with origin/{branch} (conflict resolved, local backup in .trash/)")
    } else if had_local_changes {
        format!("Synced with origin/{branch} (local changes pushed)")
    } else {
        format!("Synced with origin/{branch}")
    };
    Ok(TeamGitResult {
        success: true,
        message,
        ..Default::default()
    })
}

#[tauri::command]
pub async fn team_shared_git_validate(
    config: TeamSharedGitConfig,
) -> Result<TeamSharedGitStatus, String> {
    status_for_shared_dir(&config)
}

#[tauri::command]
pub async fn team_shared_git_setup(
    config: TeamSharedGitConfig,
) -> Result<TeamSharedGitStatus, String> {
    setup_shared_git_repo(&config)
}

#[tauri::command]
pub async fn team_shared_git_sync(
    config: TeamSharedGitConfig,
    secrets_state: State<'_, SharedSecretsState>,
    force: Option<bool>,
) -> Result<TeamGitResult, String> {
    sync_shared_git_repo(&config, Some(&secrets_state), force)
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

    #[test]
    fn redacts_tokenized_remote_url() {
        assert_eq!(
            redact_remote_url("https://oauth2:secret@example.com/repo.git"),
            "https://example.com/repo.git"
        );
    }
}
