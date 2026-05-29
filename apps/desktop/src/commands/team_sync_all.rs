use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::commands::team::check_team_status;

#[derive(Debug, Serialize, Deserialize)]
pub struct SyncAllResult {
    pub mode: String,
    pub success: bool,
    pub message: String,
    pub changed_files: u32,
}

pub async fn sync_all(app: &AppHandle, workspace: &str) -> SyncAllResult {
    let status = check_team_status(workspace);
    match status.mode.as_deref() {
        Some("git") => sync_git(app, workspace).await,
        // OSS sync is driven by the dedicated oss_sync_now command (team_id from
        // the current-team store), not from a teamclaw.json oss_team_id field —
        // so there is no "oss" branch here. check_team_status only reports
        // "git" | "webdav" | None.
        _ => SyncAllResult {
            mode: "none".to_string(),
            success: false,
            message: "No team sync configured in this workspace.".to_string(),
            changed_files: 0,
        },
    }
}

async fn sync_git(app: &AppHandle, workspace: &str) -> SyncAllResult {
    use crate::commands::shared_secrets::SharedSecretsState;
    use crate::commands::team::team_sync_repo;

    let secrets = app.state::<SharedSecretsState>();

    match team_sync_repo(Some(workspace.to_string()), secrets, Some(false)).await {
        Ok(result) if result.needs_confirmation => SyncAllResult {
            mode: "git".to_string(),
            success: false,
            message: format!(
                "Sync blocked: {} untracked file(s) exceed size thresholds ({} bytes total).",
                result.new_files.len(),
                result.total_bytes
            ),
            changed_files: result.new_files.len() as u32,
        },
        Ok(result) => SyncAllResult {
            mode: "git".to_string(),
            success: result.success,
            message: result.message,
            changed_files: 0, // git sync detail is in message; TeamGitResult has no per-file count
        },
        Err(e) => SyncAllResult {
            mode: "git".to_string(),
            success: false,
            message: e,
            changed_files: 0,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sync_all_result_serialization() {
        let result = SyncAllResult {
            mode: "git".to_string(),
            success: true,
            message: "Synced with origin/main.".to_string(),
            changed_files: 0,
        };
        let json = serde_json::to_string(&result).unwrap();
        let roundtrip: SyncAllResult = serde_json::from_str(&json).unwrap();
        assert_eq!(roundtrip.mode, "git");
        assert!(roundtrip.success);
    }

    #[test]
    fn test_sync_all_result_none_mode() {
        let result = SyncAllResult {
            mode: "none".to_string(),
            success: false,
            message: "No team sync configured in this workspace.".to_string(),
            changed_files: 0,
        };
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains(r#""mode":"none""#));
        assert!(json.contains(r#""success":false"#));
    }
}
