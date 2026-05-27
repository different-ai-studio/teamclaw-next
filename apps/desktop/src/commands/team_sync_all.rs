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
        Some("oss") => sync_oss(app, workspace).await,
        _ => SyncAllResult {
            mode: "none".to_string(),
            success: false,
            message: "No team sync configured in this workspace.".to_string(),
            changed_files: 0,
        },
    }
}

async fn sync_oss(app: &AppHandle, workspace: &str) -> SyncAllResult {
    use crate::commands::oss_sync::{engine, fc_client::FcClient};
    use crate::commands::team_secret_store;

    // Resolve team_id from local config.
    let team_id = {
        let config_path = std::path::Path::new(workspace)
            .join(crate::commands::TEAMCLAW_DIR)
            .join(crate::commands::CONFIG_FILE_NAME);
        let json: serde_json::Value = std::fs::read_to_string(&config_path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        match json.get("oss_team_id").and_then(|v| v.as_str()).map(|s| s.to_string()) {
            Some(id) => id,
            None => return SyncAllResult {
                mode: "oss".to_string(),
                success: false,
                message: "OSS team not configured (oss_team_id missing).".to_string(),
                changed_files: 0,
            },
        }
    };

    // Resolve JWT and FC endpoint.
    let (base_url, jwt) = {
        let config_path = std::path::Path::new(workspace)
            .join(crate::commands::TEAMCLAW_DIR)
            .join(crate::commands::CONFIG_FILE_NAME);
        let json: serde_json::Value = std::fs::read_to_string(&config_path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let url = json
            .get("fc_endpoint")
            .and_then(|v| v.as_str())
            .unwrap_or("https://cloud.ucar.cc")
            .trim_end_matches('/')
            .to_string();
        let jwt = json
            .get("supabase_jwt")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .or_else(|| std::env::var("SUPABASE_JWT").ok());
        match jwt {
            Some(j) => (url, j),
            None => return SyncAllResult {
                mode: "oss".to_string(),
                success: false,
                message: "Not logged in (supabase_jwt missing).".to_string(),
                changed_files: 0,
            },
        }
    };

    let fc = FcClient::new(base_url, jwt);
    match engine::tick(workspace, &team_id, &fc, app).await {
        Ok(r) => SyncAllResult {
            mode: "oss".to_string(),
            success: true,
            message: format!(
                "OSS sync: pulled {} pushed {} conflicts {}",
                r.pulled, r.pushed, r.conflicts
            ),
            changed_files: r.pulled + r.pushed,
        },
        Err(e) => SyncAllResult {
            mode: "oss".to_string(),
            success: false,
            message: e.to_string(),
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
