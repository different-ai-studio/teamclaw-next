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

use crate::commands::oss_sync::error::SyncError;
use crate::commands::oss_sync::fc_client::FcClient;
use crate::commands::oss_sync::get_fc_endpoint_and_jwt;
use crate::commands::team_share::custom_git;
use crate::commands::{team_secret_store, TEAM_REPO_DIR};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnableShareResult {
    pub team_id: String,
    pub share_mode: String,
    /// Non-fatal warning surfaced when the share-mode POST succeeded but
    /// the subsequent `git clone` did not. The team is enabled server-side;
    /// the local checkout may be empty or absent. Frontend should surface
    /// this so the user can retry the clone.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clone_warning: Option<String>,
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

/// The team shared directory is now created and linked by the daemon
/// (one global copy per team under `~/.amuxd/teams/<team_id>/teamclaw-team`,
/// exposed via a `teamclaw-team` symlink in each workspace). Desktop no longer
/// eagerly creates a per-workspace real directory here; if a real dir is
/// created later (git clone / OSS engine first write), the daemon consolidates
/// it into the global copy and replaces it with a symlink. Kept as a no-op so
/// the enable_* call sites are unchanged and to document the ownership move.
fn ensure_team_repo_dir(_workspace_path: &str) -> Result<(), String> {
    Ok(())
}

fn team_repo_path(workspace_path: &str) -> std::path::PathBuf {
    std::path::Path::new(workspace_path).join(TEAM_REPO_DIR)
}

/// Run `clone_or_init` against the team repo dir. Clone failures are
/// non-fatal: the share-mode POST has already committed server-side, so
/// returning an error here would leave the team in a half-enabled state.
/// Instead, surface the failure as `clone_warning`.
fn try_clone_team_repo(
    workspace_path: &str,
    remote_url: &str,
    credential_ref: &str,
    auth_kind: &str,
) -> Option<String> {
    let dir = team_repo_path(workspace_path);
    // If a clone target already has .git we don't re-clone.
    if dir.join(".git").exists() {
        return None;
    }
    // The cloned target must be empty for `git clone` to succeed.
    // Use a subdirectory that may or may not exist; create the parent.
    if let Some(parent) = dir.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    match custom_git::clone_or_init(
        &dir,
        remote_url,
        workspace_path,
        credential_ref,
        auth_kind,
        None,
    ) {
        Ok(custom_git::CloneOutcome::Cloned) => None,
        Ok(custom_git::CloneOutcome::InitFallback { reason }) => {
            Some(format!("git clone failed, used local init: {reason}"))
        }
        Err(e) => Some(format!("git clone deferred: {e}")),
    }
}

async fn post_share_mode(
    workspace_path: &str,
    team_id: &str,
    body: &serde_json::Value,
) -> Result<(), String> {
    let (base_url, jwt) = get_fc_endpoint_and_jwt(workspace_path)?;
    let fc = FcClient::new(base_url, jwt);
    let path = format!("/v1/teams/{}/share-mode", team_id);
    // The /v1 share-mode endpoint returns 409 once a team's mode is locked.
    // FcClient::map_fc_response maps any 409 to SyncError::Conflict (its CAS
    // semantics for /sync/*), which would surface to the UI as the meaningless
    // "conflict: remote_version=None, remote_cipher_hash=None". Translate it to
    // a clear, user-facing message instead.
    fc.post_json(&path, body).await.map_err(|e| match e {
        SyncError::Conflict { .. } => {
            "团队共享已开通,无法重复开通或切换共享模式 (share mode already locked)".to_string()
        }
        other => other.to_string(),
    })?;
    Ok(())
}

// ─── enable_oss ──────────────────────────────────────────────────────────

pub async fn enable_oss_impl(
    team_id: String,
    workspace_path: String,
) -> Result<EnableShareResult, String> {
    // Lock the share mode on the server FIRST. If it is already locked (409),
    // post_share_mode returns a clear error and we bail out BEFORE mutating any
    // local state — otherwise we would overwrite the existing team secret and
    // break decryption of data already synced under the original secret.
    post_share_mode(&workspace_path, &team_id, &json!({ "mode": "oss" })).await?;

    let secret = generate_team_secret_hex()?;
    team_secret_store::save_team_secret(&workspace_path, &team_id, &secret)?;

    ensure_team_repo_dir(&workspace_path)?;

    Ok(EnableShareResult {
        team_id,
        share_mode: "oss".to_string(),
        clone_warning: None,
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
    custom_git::store_credential(&workspace_path, &cred_ref, "https_token", &push_token)?;

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
    let clone_warning = try_clone_team_repo(&workspace_path, &repo_url, &cred_ref, "https_token");

    Ok(EnableShareResult {
        team_id,
        share_mode: "managed_git".to_string(),
        clone_warning,
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
    custom_git::store_credential(
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
    let clone_warning = try_clone_team_repo(
        &workspace_path,
        &input.remote_url,
        &cred_ref,
        &input.auth_kind,
    );

    Ok(EnableShareResult {
        team_id,
        share_mode: "custom_git".to_string(),
        clone_warning,
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

/// What the workspace `teamclaw-team` entry currently is:
/// `"symlink"` (linked to the daemon's global copy — a Windows junction also
/// reports as a symlink to symlink_metadata), `"real_dir"` (legacy local dir,
/// awaiting daemon consolidation), or `"missing"` (not linked yet).
pub(crate) fn detect_link_status(workspace_path: &str) -> &'static str {
    let link = std::path::Path::new(workspace_path).join(TEAM_REPO_DIR);
    match std::fs::symlink_metadata(&link) {
        Ok(m) if m.file_type().is_symlink() => "symlink",
        Ok(m) if m.is_dir() => "real_dir",
        _ => "missing",
    }
}

/// `~/.amuxd/teams/<team_id>/teamclaw-team` — the daemon's global copy path,
/// shown in the UI so users can see where synced content actually lives.
pub(crate) fn global_team_dir_display(team_id: &str) -> Option<String> {
    dirs::home_dir().map(|h| {
        h.join(".amuxd")
            .join("teams")
            .join(team_id)
            .join(TEAM_REPO_DIR)
            .to_string_lossy()
            .into_owned()
    })
}

pub async fn get_share_status_impl(
    team_id: String,
    workspace_path: String,
) -> Result<serde_json::Value, String> {
    let (base_url, jwt) = get_fc_endpoint_and_jwt(&workspace_path)?;
    let fc = FcClient::new(base_url, jwt);
    let path = format!("/v1/teams/{}/share-mode", team_id);
    let mut value = fc.get_json(&path).await.map_err(|e| e.to_string())?;
    // Augment the server share-mode payload with local link + global-path info
    // so the settings UI can show where synced content lives and whether this
    // workspace is linked. camelCase to match the existing payload shape.
    if let Some(obj) = value.as_object_mut() {
        obj.insert(
            "linkStatus".to_string(),
            json!(detect_link_status(&workspace_path)),
        );
        if let Some(p) = global_team_dir_display(&team_id) {
            obj.insert("globalPath".to_string(), json!(p));
        }
    }
    Ok(value)
}

#[tauri::command]
pub async fn team_share_get_status(
    team_id: String,
    workspace_path: String,
) -> Result<serde_json::Value, String> {
    get_share_status_impl(team_id, workspace_path).await
}

#[cfg(test)]
mod link_status_tests {
    use super::*;

    #[test]
    fn reports_missing_when_absent() {
        let ws = tempfile::tempdir().unwrap();
        assert_eq!(detect_link_status(ws.path().to_str().unwrap()), "missing");
    }

    #[test]
    fn reports_real_dir_for_plain_directory() {
        let ws = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(ws.path().join(TEAM_REPO_DIR)).unwrap();
        assert_eq!(detect_link_status(ws.path().to_str().unwrap()), "real_dir");
    }

    #[cfg(unix)]
    #[test]
    fn reports_symlink_when_present() {
        let ws = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(target.path(), ws.path().join(TEAM_REPO_DIR)).unwrap();
        assert_eq!(detect_link_status(ws.path().to_str().unwrap()), "symlink");
    }

    #[test]
    fn global_path_contains_team_and_amuxd() {
        if let Some(p) = global_team_dir_display("team-xyz") {
            assert!(p.contains("team-xyz"));
            assert!(p.contains(".amuxd"));
            assert!(p.ends_with(TEAM_REPO_DIR));
        }
    }
}
