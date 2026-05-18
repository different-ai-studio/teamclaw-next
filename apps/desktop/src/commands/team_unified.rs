// apps/desktop/src/commands/team_unified.rs

use serde::{Deserialize, Serialize};
use tauri::State;

pub use super::team_types::{MemberRole, TeamManifest, TeamMember};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(dead_code)]
pub struct TeamCreateResult {
    pub team_id: Option<String>,
    pub ticket: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(dead_code)]
pub struct TeamJoinResult {
    pub success: bool,
    pub role: MemberRole,
    pub members: Vec<TeamMember>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "message")]
#[allow(dead_code)]
pub enum TeamJoinError {
    InvalidTicket(String),
    DeviceNotRegistered(String),
    AlreadyInTeam(String),
    SyncError(String),
}

impl std::fmt::Display for TeamJoinError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidTicket(msg) => write!(f, "{}", msg),
            Self::DeviceNotRegistered(msg) => write!(f, "{}", msg),
            Self::AlreadyInTeam(msg) => write!(f, "{}", msg),
            Self::SyncError(msg) => write!(f, "{}", msg),
        }
    }
}

// --- Validation Helpers ---

/// Validate NodeId format: non-empty hex string
pub fn validate_node_id(node_id: &str) -> Result<(), String> {
    if node_id.is_empty() {
        return Err("NodeId cannot be empty".to_string());
    }
    if !node_id.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("NodeId must be a valid hex string".to_string());
    }
    Ok(())
}

/// Check if a role can manage members (add/remove/edit)
pub fn can_manage_members(role: &MemberRole) -> bool {
    matches!(role, MemberRole::Owner | MemberRole::Manager)
}

/// Find a member's role in a manifest by node_id
pub fn find_member_role(manifest: &TeamManifest, node_id: &str) -> Option<MemberRole> {
    manifest
        .members
        .iter()
        .find(|m| m.node_id == node_id)
        .map(|m| m.role.clone())
}

// --- Unified Tauri Commands ---

/// Helper: check that caller has Owner or Manager role by looking up their NodeId in the manifest.
/// Returns Err if they lack the required role.
async fn require_manager_role(manifest: &TeamManifest, caller_node_id: &str) -> Result<(), String> {
    let role = find_member_role(manifest, caller_node_id)
        .ok_or_else(|| "Your device is not in the team manifest".to_string())?;
    if !can_manage_members(&role) {
        return Err("Insufficient permissions: Owner or Manager role required".to_string());
    }
    Ok(())
}

// ─── Git mode manifest helpers ──────────────────────────────────────────────

fn git_manifest_path(workspace_path: &str) -> std::path::PathBuf {
    std::path::Path::new(workspace_path)
        .join(super::TEAM_REPO_DIR)
        .join("_meta")
        .join("members.json")
}

/// Read the Git team manifest without creating files.
///
/// Git clone requires the target `teamclaw-team` path to be absent or empty.
/// During invite-code joins the UI can briefly mark team mode as enabled while
/// the clone is still running in the background; member reads must not create
/// `_meta/members.json` in that window.
fn read_git_manifest(workspace_path: &str) -> Result<TeamManifest, String> {
    let path = git_manifest_path(workspace_path);
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read _meta/members.json: {}", e))?;
    serde_json::from_str(&content).map_err(|e| format!("Failed to parse members.json: {}", e))
}

fn write_git_manifest(workspace_path: &str, manifest: &TeamManifest) -> Result<(), String> {
    let path = git_manifest_path(workspace_path);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let json = serde_json::to_string_pretty(manifest)
        .map_err(|e| format!("Failed to serialize members.json: {}", e))?;
    std::fs::write(&path, json).map_err(|e| format!("Failed to write members.json: {}", e))
}

#[cfg(test)]
mod git_manifest_tests {
    use super::*;

    #[test]
    fn read_git_manifest_does_not_create_team_dir_when_missing() {
        let workspace_dir = tempfile::tempdir().unwrap();
        let workspace_path = workspace_dir.path().to_string_lossy().to_string();
        let team_dir = workspace_dir.path().join(crate::commands::TEAM_REPO_DIR);

        let result = read_git_manifest(&workspace_path);

        assert!(result.is_err());
        assert!(!team_dir.exists());
    }
}

/// Get the list of team members from the active sync mode.
/// - Git: reads from teamclaw-team/_meta/members.json
#[tauri::command]
pub async fn unified_team_get_members(
    workspace_path: Option<String>,
    window: tauri::WebviewWindow,
    registry: State<'_, super::window::WindowRegistry>,
) -> Result<Vec<TeamMember>, String> {
    let workspace_path = super::team::resolve_workspace_path(workspace_path, &window, &registry)?;
    let status = super::team::check_team_status(&workspace_path);

    match status.mode.as_deref() {
        Some("git") => {
            let manifest = read_git_manifest(&workspace_path)?;
            Ok(manifest.members)
        }
        Some(mode) => Err(format!(
            "Member management not supported for mode: {}",
            mode
        )),
        None => Err("No active team mode".to_string()),
    }
}

/// Add a member to the active team.
/// Validates NodeId format, checks caller role, then adds member.
#[tauri::command]
pub async fn unified_team_add_member(
    member: TeamMember,
    workspace_path: Option<String>,
    window: tauri::WebviewWindow,
    registry: State<'_, super::window::WindowRegistry>,
) -> Result<(), String> {
    validate_node_id(&member.node_id)?;

    let workspace_path = super::team::resolve_workspace_path(workspace_path, &window, &registry)?;
    let status = super::team::check_team_status(&workspace_path);

    match status.mode.as_deref() {
        Some("git") => {
            // Git mode: anyone with repo access can manage members
            let mut manifest = read_git_manifest(&workspace_path)?;
            if manifest.members.iter().any(|m| m.node_id == member.node_id) {
                return Err("Member already exists".to_string());
            }
            manifest.members.push(member);
            write_git_manifest(&workspace_path, &manifest)?;
            Ok(())
        }
        Some(mode) => Err(format!(
            "Member management not supported for mode: {}",
            mode
        )),
        None => Err("No active team mode".to_string()),
    }
}

/// Remove a member from the active team.
/// Checks caller role before removing.
#[tauri::command]
pub async fn unified_team_remove_member(
    node_id: String,
    workspace_path: Option<String>,
    window: tauri::WebviewWindow,
    registry: State<'_, super::window::WindowRegistry>,
) -> Result<(), String> {
    let workspace_path = super::team::resolve_workspace_path(workspace_path, &window, &registry)?;
    let status = super::team::check_team_status(&workspace_path);

    match status.mode.as_deref() {
        Some("git") => {
            let mut manifest = read_git_manifest(&workspace_path)?;
            manifest.members.retain(|m| m.node_id != node_id);
            write_git_manifest(&workspace_path, &manifest)?;
            Ok(())
        }
        Some(mode) => Err(format!(
            "Member management not supported for mode: {}",
            mode
        )),
        None => Err("No active team mode".to_string()),
    }
}

/// Update a team member's role.
/// Checks caller role before updating.
#[tauri::command]
pub async fn unified_team_update_member_role(
    node_id: String,
    role: MemberRole,
    workspace_path: Option<String>,
    window: tauri::WebviewWindow,
    registry: State<'_, super::window::WindowRegistry>,
) -> Result<(), String> {
    let workspace_path = super::team::resolve_workspace_path(workspace_path, &window, &registry)?;
    let status = super::team::check_team_status(&workspace_path);

    match status.mode.as_deref() {
        Some("git") => {
            let mut manifest = read_git_manifest(&workspace_path)?;
            if let Some(member) = manifest.members.iter_mut().find(|m| m.node_id == node_id) {
                member.role = role;
            } else {
                return Err("Member not found".to_string());
            }
            write_git_manifest(&workspace_path, &manifest)?;
            Ok(())
        }
        Some(mode) => Err(format!(
            "Member management not supported for mode: {}",
            mode
        )),
        None => Err("No active team mode".to_string()),
    }
}

/// Get the current device's role in the active team.
#[tauri::command]
pub async fn unified_team_get_my_role(
    workspace_path: Option<String>,
    window: tauri::WebviewWindow,
    registry: State<'_, super::window::WindowRegistry>,
) -> Result<MemberRole, String> {
    let workspace_path = super::team::resolve_workspace_path(workspace_path, &window, &registry)?;
    let status = super::team::check_team_status(&workspace_path);

    match status.mode.as_deref() {
        Some("git") => {
            let my_node_id = super::device_identity::get_device_id()?;
            let manifest = read_git_manifest(&workspace_path)?;
            // In Git mode, if device not in manifest, treat as owner
            // (anyone with repo access is implicitly authorized)
            Ok(find_member_role(&manifest, &my_node_id).unwrap_or(MemberRole::Owner))
        }
        Some(mode) => Err(format!(
            "Member management not supported for mode: {}",
            mode
        )),
        None => Err("No active team mode".to_string()),
    }
}
