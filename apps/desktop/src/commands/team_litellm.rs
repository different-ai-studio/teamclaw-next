//! Task 8 — `team_litellm.setup` command.
//!
//! Provisions LiteLLM for an already-created team by hitting
//! `POST /v1/teams/{team_id}/litellm/setup` on FC, then mirrors the returned
//! `aiGatewayEndpoint` / `litellmKey` into the workspace `teamclaw.json` so
//! the rest of the desktop app can read them via the usual env_vars helpers.

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::commands::env_vars;
use crate::commands::oss_sync::fc_client::FcClient;
use crate::commands::oss_sync::get_fc_endpoint;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiteLlmSetupResult {
    pub ai_gateway_endpoint: String,
    pub litellm_key: String,
}

/// Library entry point (also called from integration tests).
pub async fn setup_impl(
    team_id: String,
    workspace_path: String,
    access_token: String,
) -> Result<LiteLlmSetupResult, String> {
    let fc = FcClient::new(get_fc_endpoint(&workspace_path), access_token);
    let path = format!("/v1/teams/{}/litellm/setup", team_id);
    let resp = fc
        .post_json(&path, &json!({}))
        .await
        .map_err(|e| e.to_string())?;

    let ai_gateway_endpoint = resp
        .get("aiGatewayEndpoint")
        .or_else(|| resp.get("ai_gateway_endpoint"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| "litellm/setup: missing aiGatewayEndpoint".to_string())?
        .to_string();
    let litellm_key = resp
        .get("litellmKey")
        .or_else(|| resp.get("litellm_key"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| "litellm/setup: missing litellmKey".to_string())?
        .to_string();

    let mut cfg = env_vars::read_teamclaw_json(&workspace_path)?;
    if let Some(obj) = cfg.as_object_mut() {
        obj.insert(
            "ai_gateway_endpoint".to_string(),
            serde_json::Value::String(ai_gateway_endpoint.clone()),
        );
        obj.insert(
            "litellm_key".to_string(),
            serde_json::Value::String(litellm_key.clone()),
        );
    }
    env_vars::write_teamclaw_json(&workspace_path, &cfg)?;

    Ok(LiteLlmSetupResult {
        ai_gateway_endpoint,
        litellm_key,
    })
}

#[tauri::command]
pub async fn team_litellm_setup(
    team_id: String,
    workspace_path: String,
    access_token: String,
) -> Result<LiteLlmSetupResult, String> {
    setup_impl(team_id, workspace_path, access_token).await
}
