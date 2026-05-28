//! Task 6 — `enable_oss` / `enable_managed_git` / `enable_custom_git`
//! / `set_team_secret` / `get_share_status` commands.
//!
//! These commands wire a team (already created via `team_share::create_team`)
//! into one of the three share modes. They:
//!   1. Generate (or accept) a 64-char hex team secret and persist it via
//!      `team_secret_store`.
//!   2. POST `/v1/teams/{teamId}/share-mode` on FC with the chosen mode +
//!      (for git modes) the `gitConfig` payload.
//!   3. Ensure the workspace `teamclaw-team/` repo dir exists.
//!   4. Update `.teamclaw/teamclaw.json` with `oss_team_id`, `share_mode`,
//!      and (for git modes) `git_remote_url`.
//!
//! Actual `git clone` for managed_git / custom_git is intentionally deferred
//! to Task 7, along with the proper credential-storage helper. For now,
//! credentials are stashed directly into the env blob under
//! `_git_credential.{mode}:{team_id}` with a TODO marker.

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::commands::oss_sync::fc_client::FcClient;
use crate::commands::oss_sync::get_fc_endpoint_and_jwt;
use crate::commands::{env_vars, team_secret_store, TEAM_REPO_DIR};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnableShareResult {
    pub team_id: String,
    pub share_mode: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitEnableInput {
    pub remote_url: String,
    /// "ssh_key" | "https_token"
    pub auth_kind: String,
    /// Raw credential material — SSH private key PEM or HTTPS token.
    pub credential: String,
    pub branch: Option<String>,
}

// ─── Helpers ─────────────────────────────────────────────────────────────

fn generate_team_secret_hex() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|e| format!("getrandom failed: {e}"))?;
    Ok(hex::encode(bytes))
}

fn ensure_team_repo_dir(workspace_path: &str) -> Result<(), String> {
    let dir = std::path::Path::new(workspace_path).join(TEAM_REPO_DIR);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("create_dir_all({}) failed: {e}", dir.display()))
}

fn set_teamclaw_fields(
    workspace_path: &str,
    team_id: &str,
    share_mode: &str,
    git_remote_url: Option<&str>,
) -> Result<(), String> {
    let mut json = env_vars::read_teamclaw_json(workspace_path)?;
    if let Some(obj) = json.as_object_mut() {
        obj.insert(
            "oss_team_id".to_string(),
            serde_json::Value::String(team_id.to_string()),
        );
        obj.insert(
            "share_mode".to_string(),
            serde_json::Value::String(share_mode.to_string()),
        );
        if let Some(url) = git_remote_url {
            obj.insert(
                "git_remote_url".to_string(),
                serde_json::Value::String(url.to_string()),
            );
        }
    }
    env_vars::write_teamclaw_json(workspace_path, &json)
}

/// TODO(Task 7): replace with a clean `team_share::custom_git::store_credential`
/// helper. For Task 6, just stash into env blob under a well-known key.
fn stash_git_credential_into_env_blob(
    workspace_path: &str,
    cred_ref: &str,
    auth_kind: &str,
    credential: &str,
) -> Result<(), String> {
    let mut blob = env_vars::read_env_blob(workspace_path)?;
    let key = format!("_git_credential.{}", cred_ref);
    blob.insert(
        key,
        json!({
            "authKind": auth_kind,
            "credential": credential,
        }),
    );
    env_vars::write_env_blob(&blob)
}

async fn post_share_mode(
    workspace_path: &str,
    team_id: &str,
    body: &serde_json::Value,
) -> Result<(), String> {
    let (base_url, jwt) = get_fc_endpoint_and_jwt(workspace_path)?;
    let fc = FcClient::new(base_url, jwt);
    let path = format!("/v1/teams/{}/share-mode", team_id);
    fc.post_json(&path, body)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ─── enable_oss ──────────────────────────────────────────────────────────

pub async fn enable_oss_impl(
    team_id: String,
    workspace_path: String,
) -> Result<EnableShareResult, String> {
    let secret = generate_team_secret_hex()?;
    team_secret_store::save_team_secret(&workspace_path, &team_id, &secret)?;

    post_share_mode(&workspace_path, &team_id, &json!({ "mode": "oss" })).await?;

    ensure_team_repo_dir(&workspace_path)?;
    set_teamclaw_fields(&workspace_path, &team_id, "oss", None)?;

    Ok(EnableShareResult {
        team_id,
        share_mode: "oss".to_string(),
    })
}

#[tauri::command]
pub async fn team_share_enable_oss(
    team_id: String,
    workspace_path: String,
) -> Result<EnableShareResult, String> {
    enable_oss_impl(team_id, workspace_path).await
}

// ─── enable_managed_git ──────────────────────────────────────────────────

pub async fn enable_managed_git_impl(
    team_id: String,
    workspace_path: String,
) -> Result<EnableShareResult, String> {
    let secret = generate_team_secret_hex()?;
    team_secret_store::save_team_secret(&workspace_path, &team_id, &secret)?;

    let (base_url, jwt) = get_fc_endpoint_and_jwt(&workspace_path)?;
    let fc = FcClient::new(base_url, jwt);

    // Provision the managed git repo via FC.
    let create_resp = fc
        .post_json("/managed-git/create-repo", &json!({ "teamId": team_id }))
        .await
        .map_err(|e| format!("/managed-git/create-repo failed: {e}"))?;
    let repo_url = create_resp
        .get("repo_url")
        .or_else(|| create_resp.get("repoUrl"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| "managed-git/create-repo: missing repo_url".to_string())?
        .to_string();
    let push_token = create_resp
        .get("push_token")
        .or_else(|| create_resp.get("pushToken"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| "managed-git/create-repo: missing push_token".to_string())?
        .to_string();

    let cred_ref = format!("managed_git:{}", team_id);
    stash_git_credential_into_env_blob(
        &workspace_path,
        &cred_ref,
        "https_token",
        &push_token,
    )?;

    let body = json!({
        "mode": "managed_git",
        "gitConfig": {
            "remoteUrl": repo_url,
            "authKind": "https_token",
            "credentialRef": cred_ref,
        }
    });
    post_share_mode(&workspace_path, &team_id, &body).await?;

    ensure_team_repo_dir(&workspace_path)?;
    // TODO(Task 7): `git clone` repo_url into TEAM_REPO_DIR using the push_token.
    set_teamclaw_fields(&workspace_path, &team_id, "managed_git", Some(&repo_url))?;

    Ok(EnableShareResult {
        team_id,
        share_mode: "managed_git".to_string(),
    })
}

#[tauri::command]
pub async fn team_share_enable_managed_git(
    team_id: String,
    workspace_path: String,
) -> Result<EnableShareResult, String> {
    enable_managed_git_impl(team_id, workspace_path).await
}

// ─── enable_custom_git ──────────────────────────────────────────────────

pub async fn enable_custom_git_impl(
    team_id: String,
    workspace_path: String,
    input: GitEnableInput,
) -> Result<EnableShareResult, String> {
    if input.auth_kind != "ssh_key" && input.auth_kind != "https_token" {
        return Err(format!(
            "invalid auth_kind `{}`; expected `ssh_key` or `https_token`",
            input.auth_kind
        ));
    }

    let secret = generate_team_secret_hex()?;
    team_secret_store::save_team_secret(&workspace_path, &team_id, &secret)?;

    let cred_ref = format!("custom_git:{}", team_id);
    stash_git_credential_into_env_blob(
        &workspace_path,
        &cred_ref,
        &input.auth_kind,
        &input.credential,
    )?;

    let mut git_config = json!({
        "remoteUrl": input.remote_url,
        "authKind": input.auth_kind,
        "credentialRef": cred_ref,
    });
    if let Some(branch) = input.branch.as_deref() {
        if let Some(obj) = git_config.as_object_mut() {
            obj.insert(
                "branch".to_string(),
                serde_json::Value::String(branch.to_string()),
            );
        }
    }

    let body = json!({
        "mode": "custom_git",
        "gitConfig": git_config,
    });
    post_share_mode(&workspace_path, &team_id, &body).await?;

    ensure_team_repo_dir(&workspace_path)?;
    // TODO(Task 7): `git clone` input.remote_url into TEAM_REPO_DIR with provided credential.
    set_teamclaw_fields(
        &workspace_path,
        &team_id,
        "custom_git",
        Some(&input.remote_url),
    )?;

    Ok(EnableShareResult {
        team_id,
        share_mode: "custom_git".to_string(),
    })
}

#[tauri::command]
pub async fn team_share_enable_custom_git(
    team_id: String,
    workspace_path: String,
    input: GitEnableInput,
) -> Result<EnableShareResult, String> {
    enable_custom_git_impl(team_id, workspace_path, input).await
}

// ─── set_team_secret ────────────────────────────────────────────────────

pub fn set_team_secret_impl(
    team_id: String,
    secret_hex: String,
    workspace_path: String,
) -> Result<(), String> {
    let normalized = secret_hex.trim().to_ascii_lowercase();
    if normalized.len() != 64 || !normalized.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("team secret must be exactly 64 hex characters".to_string());
    }
    team_secret_store::save_team_secret(&workspace_path, &team_id, &normalized)
}

#[tauri::command]
pub async fn team_share_set_team_secret(
    team_id: String,
    secret_hex: String,
    workspace_path: String,
) -> Result<(), String> {
    set_team_secret_impl(team_id, secret_hex, workspace_path)
}

// ─── get_share_status ────────────────────────────────────────────────────

pub async fn get_share_status_impl(
    team_id: String,
    workspace_path: String,
) -> Result<serde_json::Value, String> {
    let (base_url, jwt) = get_fc_endpoint_and_jwt(&workspace_path)?;
    let fc = FcClient::new(base_url, jwt);
    let path = format!("/v1/teams/{}/share-mode", team_id);
    fc.get_json(&path).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn team_share_get_status(
    team_id: String,
    workspace_path: String,
) -> Result<serde_json::Value, String> {
    get_share_status_impl(team_id, workspace_path).await
}
