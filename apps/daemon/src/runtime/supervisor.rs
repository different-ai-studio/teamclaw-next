//! Workspace runtime supervisor - bootstrap + RuntimeManager lifecycle.
//!
//! Replaces the desktop `start_opencode` sidecar path: workspace prep runs
//! here before agent spawn, and `/v1/workspaces/:id/runtime/*` handlers
//! delegate reload/status to the shared `RuntimeManager`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tokio::sync::Mutex as AsyncMutex;
use tracing::{info, warn};

/// Matches `apps/desktop/src/commands/introspect_api.rs` — desktop Tauri hosts the API.
const INTROSPECT_API_PORT: u16 = 13144;
const TEAM_SKILLS_PATH: &str = "teamclaw-team/skills";

use crate::config::workspace_control::{ApplyOutcome, RuntimeStatus, WorkspaceControlError};
use crate::proto::amux;
use crate::runtime::{
    acp_catalog_probe, refresh::RuntimeRefreshCoordinator, AgentLaunchConfig, RuntimeManager,
};

struct InherentSkill {
    dirname: &'static str,
    content: &'static str,
}

fn inherent_desktop_control_skill() -> Option<InherentSkill> {
    #[cfg(target_os = "macos")]
    return Some(InherentSkill {
        dirname: "macos-control",
        content: include_str!("../../../../packages/app/src/lib/skills/macos-control/SKILL.md"),
    });

    #[cfg(target_os = "windows")]
    return Some(InherentSkill {
        dirname: "windows-control",
        content: include_str!("../../../../packages/app/src/lib/skills/windows-control/SKILL.md"),
    });

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    None
}

fn inherent_skills() -> Vec<InherentSkill> {
    let mut out = vec![InherentSkill {
        dirname: "create-role",
        content: include_str!("../../../../packages/app/src/lib/skills/create-role/SKILL.md"),
    }];
    if let Some(skill) = inherent_desktop_control_skill() {
        out.push(skill);
    }
    out
}

fn opencode_json_path(workspace_path: &Path) -> PathBuf {
    workspace_path.join("opencode.json")
}

fn read_json_object(path: &Path) -> Result<serde_json::Value, WorkspaceControlError> {
    if !path.exists() {
        return Ok(serde_json::json!({}));
    }
    let content =
        std::fs::read_to_string(path).map_err(|e| WorkspaceControlError::Io(e.to_string()))?;
    serde_json::from_str(&content).map_err(|e| WorkspaceControlError::Parse(e.to_string()))
}

fn write_json_pretty(path: &Path, value: &serde_json::Value) -> Result<(), WorkspaceControlError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| WorkspaceControlError::Io(e.to_string()))?;
    }
    let content = serde_json::to_string_pretty(value)
        .map_err(|e| WorkspaceControlError::Parse(e.to_string()))?;
    std::fs::write(path, content).map_err(|e| WorkspaceControlError::Io(e.to_string()))
}

/// Ensure tool-level permission defaults exist in `opencode.json`.
fn ensure_default_permissions(workspace_path: &Path) -> Result<(), WorkspaceControlError> {
    let config_path = opencode_json_path(workspace_path);
    let mut config = read_json_object(&config_path)?;
    let obj = config.as_object_mut().ok_or_else(|| {
        WorkspaceControlError::Parse("opencode.json root is not an object".into())
    })?;

    if obj.contains_key("permission") {
        return Ok(());
    }

    obj.insert(
        "permission".to_string(),
        serde_json::json!({
            "bash": "ask",
            "edit": "ask",
            "write": "ask",
            "external_directory": "ask",
            "doom_loop": "ask"
        }),
    );

    write_json_pretty(&config_path, &config)
}

/// Seed inherent MCP entries that TeamClaw expects (non-destructive).
pub fn ensure_inherent_mcp(workspace_path: &Path) -> Result<(), WorkspaceControlError> {
    let config_path = opencode_json_path(workspace_path);
    let mut config = if config_path.exists() {
        read_json_object(&config_path)?
    } else {
        serde_json::json!({ "$schema": "https://opencode.ai/config.json" })
    };

    let obj = config.as_object_mut().ok_or_else(|| {
        WorkspaceControlError::Parse("opencode.json root is not an object".into())
    })?;

    let mcp = obj.entry("mcp").or_insert_with(|| serde_json::json!({}));
    let mcp_obj = mcp
        .as_object_mut()
        .ok_or_else(|| WorkspaceControlError::Parse("mcp is not an object".into()))?;

    let mut changed = false;

    if !mcp_obj.contains_key("playwright") {
        mcp_obj.insert(
            "playwright".to_string(),
            serde_json::json!({
                "type": "local",
                "enabled": false,
                "command": ["npx", "-y", "@playwright/mcp@latest"]
            }),
        );
        changed = true;
    }

    if !mcp_obj.contains_key("chrome-control") {
        mcp_obj.insert(
            "chrome-control".to_string(),
            serde_json::json!({
                "type": "local",
                "enabled": true,
                "command": ["npx", "-y", "chrome-devtools-mcp@latest", "--autoConnect"]
            }),
        );
        changed = true;
    }

    ensure_extended_inherent_config(workspace_path, &mut config, &mut changed)?;

    if changed {
        write_json_pretty(&config_path, &config)?;
    }
    Ok(())
}

fn resolve_executable(path: PathBuf) -> Option<PathBuf> {
    if path.is_file() {
        return Some(path);
    }
    #[cfg(windows)]
    {
        let with_exe = path.with_extension("exe");
        if with_exe.is_file() {
            return Some(with_exe);
        }
    }
    None
}

fn runtime_target_triple() -> &'static str {
    #[cfg(all(target_arch = "aarch64", target_os = "macos"))]
    {
        return "aarch64-apple-darwin";
    }
    #[cfg(all(target_arch = "x86_64", target_os = "macos"))]
    {
        return "x86_64-apple-darwin";
    }
    #[cfg(all(target_arch = "aarch64", target_os = "linux"))]
    {
        return "aarch64-unknown-linux-gnu";
    }
    #[cfg(all(target_arch = "x86_64", target_os = "linux"))]
    {
        return "x86_64-unknown-linux-gnu";
    }
    #[cfg(all(target_arch = "x86_64", target_os = "windows"))]
    {
        return "x86_64-pc-windows-msvc";
    }
    #[allow(unreachable_code)]
    "unknown-unknown-unknown"
}

fn resolve_introspect_binary() -> Option<String> {
    if std::process::Command::new("sh")
        .arg("-lc")
        .arg("command -v teamclaw-introspect")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
    {
        return Some("teamclaw-introspect".to_string());
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for candidate in [
                dir.join(format!("teamclaw-introspect-{}", runtime_target_triple())),
                dir.join("teamclaw-introspect"),
            ] {
                if let Some(resolved) = resolve_executable(candidate) {
                    return Some(resolved.to_string_lossy().into_owned());
                }
            }
        }
    }

    if let Ok(cwd) = std::env::current_dir() {
        for root in [cwd.clone(), cwd.join(".."), cwd.join("../.."), cwd.join("../../..")] {
            let candidate = root
                .join("apps/desktop/binaries")
                .join(format!("teamclaw-introspect-{}", runtime_target_triple()));
            if let Some(resolved) = resolve_executable(candidate) {
                return Some(resolved.to_string_lossy().into_owned());
            }
        }
    }

    None
}

fn introspect_command_stale(existing: &serde_json::Value) -> bool {
    existing
        .get("command")
        .and_then(|c| c.as_array())
        .and_then(|a| a.first())
        .and_then(|v| v.as_str())
        .map(|p| !Path::new(p).exists())
        .unwrap_or(true)
}

/// Port of desktop `ensure_inherent_config` (teamclaw-introspect, autoui, skills.paths).
fn ensure_extended_inherent_config(
    workspace_path: &Path,
    config: &mut serde_json::Value,
    changed: &mut bool,
) -> Result<(), WorkspaceControlError> {
    let obj = config.as_object_mut().ok_or_else(|| {
        WorkspaceControlError::Parse("opencode.json root is not an object".into())
    })?;

    let workspace_path_str = workspace_path.to_string_lossy();

    {
        let mcp = obj.entry("mcp").or_insert_with(|| serde_json::json!({}));
        let mcp_obj = mcp
            .as_object_mut()
            .ok_or_else(|| WorkspaceControlError::Parse("mcp is not an object".into()))?;

        let needs_introspect = match mcp_obj.get("teamclaw-introspect") {
            Some(existing) => introspect_command_stale(existing),
            None => true,
        };
        if needs_introspect {
            if let Some(introspect_bin) = resolve_introspect_binary() {
                mcp_obj.insert(
                    "teamclaw-introspect".to_string(),
                    serde_json::json!({
                        "type": "local",
                        "enabled": true,
                        "command": [
                            introspect_bin,
                            "--workspace", workspace_path_str.as_ref(),
                            "--api-port", INTROSPECT_API_PORT.to_string()
                        ]
                    }),
                );
                *changed = true;
            } else {
                warn!(
                    workspace = %workspace_path.display(),
                    "teamclaw-introspect binary not found; skipping MCP registration"
                );
            }
        }

        if !mcp_obj.contains_key("autoui") {
            mcp_obj.insert(
                "autoui".to_string(),
                serde_json::json!({
                    "type": "local",
                    "enabled": true,
                    "command": ["npx", "-y", "autoui-mcp@latest"],
                    "environment": {
                        "QWEN_API_KEY": "${QWEN_API_KEY}",
                        "QWEN_BASE_URL": "https://dashscope.aliyuncs.com/compatible-mode/v1",
                        "QWEN_MODEL": "qwen3-vl-flash"
                    }
                }),
            );
            *changed = true;
        } else if let Some(autoui) = mcp_obj.get_mut("autoui").and_then(|v| v.as_object_mut()) {
            let needs_restore = autoui
                .get("environment")
                .and_then(|v| v.as_object())
                .map(|env| env.is_empty())
                .unwrap_or(true);
            if needs_restore {
                autoui.insert(
                    "environment".to_string(),
                    serde_json::json!({
                        "QWEN_API_KEY": "${QWEN_API_KEY}",
                        "QWEN_BASE_URL": "https://dashscope.aliyuncs.com/compatible-mode/v1",
                        "QWEN_MODEL": "qwen3-vl-flash"
                    }),
                );
                *changed = true;
            }
        }
    }

    {
        let skills = obj.entry("skills").or_insert_with(|| serde_json::json!({}));
        let skills_obj = skills
            .as_object_mut()
            .ok_or_else(|| WorkspaceControlError::Parse("skills is not an object".into()))?;
        let paths_val = skills_obj
            .entry("paths")
            .or_insert_with(|| serde_json::json!([]));
        let paths = paths_val
            .as_array_mut()
            .ok_or_else(|| WorkspaceControlError::Parse("skills.paths is not an array".into()))?;
        if !paths
            .iter()
            .any(|v| v.as_str() == Some(TEAM_SKILLS_PATH))
        {
            paths.push(serde_json::json!(TEAM_SKILLS_PATH));
            *changed = true;
        }
    }

    Ok(())
}

fn remove_non_native_desktop_control_skills(skills_dir: &Path) {
    let remove_if_dir = |name: &str| {
        let path = skills_dir.join(name);
        if path.is_dir() {
            let _ = std::fs::remove_dir_all(&path);
        }
    };

    #[cfg(target_os = "macos")]
    remove_if_dir("windows-control");
    #[cfg(target_os = "windows")]
    remove_if_dir("macos-control");
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        remove_if_dir("macos-control");
        remove_if_dir("windows-control");
    }
}

fn ensure_inherent_skills_in_dir(skills_dir: &Path) -> Result<(), WorkspaceControlError> {
    std::fs::create_dir_all(skills_dir).map_err(|e| WorkspaceControlError::Io(e.to_string()))?;
    remove_non_native_desktop_control_skills(skills_dir);

    for skill in inherent_skills() {
        let skill_dir = skills_dir.join(skill.dirname);
        let skill_md = skill_dir.join("SKILL.md");
        if skill_md.exists() {
            continue;
        }
        std::fs::create_dir_all(&skill_dir)
            .map_err(|e| WorkspaceControlError::Io(e.to_string()))?;
        std::fs::write(&skill_md, skill.content)
            .map_err(|e| WorkspaceControlError::Io(e.to_string()))?;
    }
    Ok(())
}

/// Prepare a workspace directory for OpenCode/ACP agent use.
pub fn prepare_workspace(workspace_path: &Path) -> Result<(), WorkspaceControlError> {
    if !workspace_path.is_dir() {
        return Err(WorkspaceControlError::WorkspaceNotFound(
            workspace_path.display().to_string(),
        ));
    }

    ensure_default_permissions(workspace_path)?;
    ensure_inherent_mcp(workspace_path)?;
    ensure_inherent_skills_in_dir(&workspace_path.join(".teamclaw/skills"))?;
    ensure_inherent_skills_in_dir(&workspace_path.join(".opencode/skills"))?;

    if let Err(e) = teamclaw_runtime_env::team_provider::ensure_team_provider(workspace_path) {
        tracing::warn!(workspace = %workspace_path.display(), error = %e, "failed to ensure team provider");
    }
    if let Ok(Some(result)) =
        teamclaw_runtime_env::opencode_db::maybe_migrate_legacy_opencode_db(workspace_path)
    {
        if result.migrated {
            tracing::info!(workspace = %workspace_path.display(), "migrated legacy isolated OpenCode DB to global");
        }
    }

    info!(workspace = %workspace_path.display(), "workspace runtime prepared");
    Ok(())
}

fn binary_available(cfg: &AgentLaunchConfig) -> bool {
    let path = Path::new(&cfg.binary);
    if path.is_absolute() && path.exists() {
        return true;
    }
    std::process::Command::new("sh")
        .arg("-lc")
        .arg(format!("command -v {}", shell_escape(&cfg.binary)))
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn shell_escape(value: &str) -> String {
    if value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || "/._-:".contains(c))
    {
        value.to_string()
    } else {
        format!("'{}'", value.replace('\'', "'\\''"))
    }
}

fn backend_label(agent_type: amux::AgentType) -> &'static str {
    match agent_type {
        amux::AgentType::Opencode => "opencode",
        amux::AgentType::ClaudeCode => "claude-code",
        amux::AgentType::Codex => "codex",
        _ => "unknown",
    }
}

pub struct RuntimeSupervisor {
    agents: Arc<AsyncMutex<RuntimeManager>>,
    refresh: Arc<RuntimeRefreshCoordinator>,
}

impl RuntimeSupervisor {
    pub fn new(agents: Arc<AsyncMutex<RuntimeManager>>) -> Arc<Self> {
        Arc::new(Self {
            agents,
            refresh: RuntimeRefreshCoordinator::new(),
        })
    }

    pub fn refresh_coordinator(&self) -> Arc<RuntimeRefreshCoordinator> {
        Arc::clone(&self.refresh)
    }

    /// Models OpenCode advertises via ACP for this workspace cwd (cron catalog).
    pub async fn probe_opencode_catalog_models(
        &self,
        workspace_path: &Path,
    ) -> Result<Vec<amux::ModelInfo>, String> {
        let launch = {
            let manager = self.agents.lock().await;
            manager.launch_config_for(amux::AgentType::Opencode)
        };
        if !binary_available(&launch) {
            return Err("opencode binary not available".into());
        }
        acp_catalog_probe::probe_opencode_models_at_cwd(
            &launch.binary,
            &launch.args,
            workspace_path.to_path_buf(),
            HashMap::new(),
        )
        .await
        .map_err(|e| e.to_string())
    }

    pub async fn runtime_status(
        &self,
        workspace_id: &str,
        workspace_path: &Path,
    ) -> Result<RuntimeStatus, WorkspaceControlError> {
        // NOTE: status reads must be side-effect free. Workspace bootstrap
        // (writing opencode.json defaults, syncing skill dirs) happens at
        // runtime start (`runtime_adapter` spawn) and on explicit
        // `reload_workspace`, not here - otherwise polling this GET endpoint
        // would silently rewrite config and delete/recreate skill dirs.
        let manager = self.agents.lock().await;
        let agent_type = manager.default_agent_type();
        let backend = backend_label(agent_type).to_owned();
        let launch = manager.launch_config_for(agent_type);
        let backend_ready = binary_available(&launch);

        let workspace_path_str = workspace_path.to_string_lossy();
        let active: Vec<_> = manager
            .active_handles_for_workspace(&workspace_path_str, workspace_id)
            .collect();

        let current_model = active
            .iter()
            .find_map(|(agent_id, _)| manager.current_model(agent_id).cloned());

        Ok(RuntimeStatus {
            workspace_id: workspace_id.to_owned(),
            ready: backend_ready,
            backend,
            current_model,
            refresh: self.refresh.runtime_refresh_dto(workspace_id).await,
        })
    }

    pub async fn reload_workspace(
        &self,
        workspace_id: &str,
        workspace_path: &Path,
    ) -> Result<ApplyOutcome, WorkspaceControlError> {
        prepare_workspace(workspace_path)?;

        let workspace_path_str = workspace_path.to_string_lossy();
        let stopped = {
            let mut manager = self.agents.lock().await;
            let stopped = manager
                .stop_runtimes_for_workspace(&workspace_path_str, workspace_id)
                .await;
            manager.evict_acp_hosts_after_provider_auth_change();
            stopped
        };

        if stopped > 0 {
            info!(
                workspace = %workspace_path.display(),
                stopped,
                "stopped workspace runtimes for reload"
            );
            Ok(ApplyOutcome::RestartRequired)
        } else {
            Ok(ApplyOutcome::ReloadRequired)
        }
    }

    pub async fn apply_refresh(
        &self,
        workspace_id: &str,
        workspace_path: &Path,
    ) -> Result<ApplyOutcome, WorkspaceControlError> {
        let attempt = self
            .refresh
            .mark_applying(workspace_id, workspace_path)
            .await;
        match self.reload_workspace(workspace_id, workspace_path).await {
            Ok(outcome) => {
                self.refresh.clear_applied(workspace_id, attempt).await;
                Ok(outcome)
            }
            Err(err) => {
                self.refresh
                    .mark_apply_failed(workspace_id, workspace_path, attempt, err.to_string())
                    .await;
                Err(err)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prepare_workspace_creates_defaults() {
        let dir = tempfile::tempdir().unwrap();
        prepare_workspace(dir.path()).unwrap();

        let cfg: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(dir.path().join("opencode.json")).unwrap(),
        )
        .unwrap();
        assert!(cfg.get("permission").is_some());

        assert!(dir
            .path()
            .join(".teamclaw/skills/create-role/SKILL.md")
            .is_file());
        assert!(!dir.path().join(".opencode/data").exists());
    }
}
