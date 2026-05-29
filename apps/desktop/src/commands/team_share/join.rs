//! Task 12 — `team_share_join_existing` command.
//!
//! Called by the frontend `JoinTeamFlow` immediately after a user claims an
//! invite. Fetches the team's current workspace config from FC
//! (`GET /v1/teams/{team_id}/workspace-config`) and, if the owner has already
//! enabled a share mode, populates the local workspace `teamclaw.json` and
//! ensures `teamclaw-team/` exists.
//!
//! Per spec: the joiner enters their own team secret manually afterwards via
//! `team_share_set_team_secret`. For git modes we do NOT clone here — the
//! joiner needs credentials separately (managed_git tokens are re-shared
//! out-of-band, custom_git creds are user-supplied later).
//!
//! Note: FC `getWorkspaceConfig` does not currently return `aiGatewayEndpoint`
//! / `litellmKey`; only `litellmTeamId`. That's intentional — gateway endpoint
//! comes from app config, and a fresh joiner does not need the LiteLLM key
//! until they call `team_litellm.setup`. We mirror `litellm_team_id` into
//! `teamclaw.json` so the LLM settings UI knows which team the gateway maps
//! to.

use serde::{Deserialize, Serialize};

use crate::commands::oss_sync::fc_client::FcClient;
use crate::commands::oss_sync::get_fc_endpoint_and_jwt;
use crate::commands::TEAM_REPO_DIR;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinExistingResult {
    pub initialized: bool,
    pub share_mode: Option<String>,
}

pub async fn team_share_join_existing_impl(
    team_id: String,
    workspace_path: String,
) -> Result<JoinExistingResult, String> {
    let (base_url, jwt) = get_fc_endpoint_and_jwt(&workspace_path)?;
    let fc = FcClient::new(base_url, jwt);
    let cfg: serde_json::Value = fc
        .get_json(&format!("/v1/teams/{}/workspace-config", team_id))
        .await
        .map_err(|e| e.to_string())?;

    let share_mode = cfg
        .get("shareMode")
        .and_then(|v| v.as_str())
        .map(String::from);

    if share_mode.is_none() {
        // Owner hasn't opened share yet — nothing to wire locally.
        return Ok(JoinExistingResult {
            initialized: false,
            share_mode: None,
        });
    }

    // Ensure teamclaw-team/ dir exists. For git modes we deliberately do NOT
    // clone — credentials are provisioned out-of-band by Task 7 paths.
    let team_repo = std::path::Path::new(&workspace_path).join(TEAM_REPO_DIR);
    std::fs::create_dir_all(&team_repo)
        .map_err(|e| format!("create_dir_all({}) failed: {e}", team_repo.display()))?;

    // NOTE: team_id / share_mode / git_remote_url / litellm_team_id are NOT
    // written to teamclaw.json anymore. They duplicated the Cloud API (teams /
    // workspace-config) and drifted from the active team; the single source of
    // truth is the current-team store (OSS sync takes team_id from there).

    Ok(JoinExistingResult {
        initialized: true,
        share_mode,
    })
}

#[tauri::command]
pub async fn team_share_join_existing(
    team_id: String,
    workspace_path: String,
) -> Result<JoinExistingResult, String> {
    team_share_join_existing_impl(team_id, workspace_path).await
}
