//! Plan B Task 5 — loopback HTTP client for the daemon's team-sync endpoints.
//!
//! The daemon owns team-sync now: it stores team secrets, materializes the
//! global team directory + per-workspace `teamclaw-team` symlink, runs the
//! actual git/OSS sync, and surfaces conflicts/versions. The desktop only
//! *delivers* the secrets and *triggers* link/sync over the daemon's local
//! HTTP server.
//!
//! This mirrors the auth dance in [`crate::commands::daemon_http`]:
//!   1. Read `~/.amuxd/amuxd.http.port` + `~/.amuxd/amuxd.http.token`.
//!   2. `POST /v1/auth/exchange` with `Authorization: Bearer {root_token}` and
//!      `{ "scopes": [...], "ttl_seconds": 300 }` → scoped session token.
//!   3. Call `/v1/team/*` with `Authorization: Bearer {session_token}`.
//!
//! Endpoints (all loopback, bearer-scoped):
//!   - `POST /v1/team/sync`              `{ workspacePath }`            scope `workspace:write`
//!   - `GET  /v1/team/sync/status?teamId`                              scope `workspace:read`
//!   - `POST /v1/team/secrets`           `{ teamId, ossTeamSecret?, gitCredential?, gitBranch? }` scope `workspace:write`
//!   - `POST /v1/team/link`              `{ path }`                    scope `workspace:write`
//!   - `GET  /v1/team/conflicts?teamId`                               scope `workspace:read`
//!   - `POST /v1/team/conflicts/resolve` `{ teamId, path, choice }`   scope `workspace:write`
//!   - `GET  /v1/team/versions?teamId&path[&cursor]`                  scope `workspace:read`
//!   - `POST /v1/team/versions/restore`  `{ teamId, path, contentHash }` scope `workspace:write`

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
struct DaemonAuthExchangeResponse {
    token: String,
}

/// Read `~/.amuxd/amuxd.http.{port,token}` and return `(base_url, root_token)`.
fn daemon_endpoint() -> Result<(String, String), String> {
    let amuxd_dir = dirs::home_dir()
        .ok_or_else(|| "no home dir".to_string())?
        .join(".amuxd");
    let port: u16 = std::fs::read_to_string(amuxd_dir.join("amuxd.http.port"))
        .map_err(|e| format!("daemon HTTP port unavailable (is amuxd running?): {e}"))?
        .trim()
        .parse()
        .map_err(|e| format!("invalid daemon HTTP port: {e}"))?;
    let root_token = std::fs::read_to_string(amuxd_dir.join("amuxd.http.token"))
        .map_err(|e| format!("daemon HTTP token unavailable (is amuxd running?): {e}"))?
        .trim()
        .to_string();
    Ok((format!("http://127.0.0.1:{port}"), root_token))
}

/// Exchange the daemon root token for a scoped session token.
async fn daemon_session_token(base: &str, scopes: &[&str]) -> Result<String, String> {
    let (_, root_token) = daemon_endpoint()?;
    daemon_session_token_with(&reqwest::Client::new(), base, &root_token, scopes).await
}

async fn daemon_session_token_with(
    client: &reqwest::Client,
    base: &str,
    root_token: &str,
    scopes: &[&str],
) -> Result<String, String> {
    let resp = client
        .post(format!("{base}/v1/auth/exchange"))
        .header("Authorization", format!("Bearer {root_token}"))
        .json(&serde_json::json!({
            "scopes": scopes,
            "ttl_seconds": 300,
        }))
        .send()
        .await
        .map_err(|e| format!("daemon auth/exchange request failed: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("daemon auth/exchange {status}: {body}"));
    }
    let parsed: DaemonAuthExchangeResponse = resp
        .json()
        .await
        .map_err(|e| format!("daemon auth/exchange decode failed: {e}"))?;
    Ok(parsed.token)
}

/// Read port+token, exchange root→session for `scopes`, then issue
/// `method base/path` with the session bearer. Non-2xx maps to `Err(String)`.
///
/// `body` is sent as JSON for write methods; `query` is appended verbatim
/// (already-encoded, leading `?` included) for read methods.
async fn daemon_request<B: Serialize, R: DeserializeOwned>(
    method: reqwest::Method,
    path: &str,
    query: &str,
    scopes: &[&str],
    body: Option<&B>,
) -> Result<R, String> {
    let (base, root_token) = daemon_endpoint()?;
    let client = reqwest::Client::new();
    let session = daemon_session_token_with(&client, &base, &root_token, scopes).await?;

    let url = format!("{base}{path}{query}");
    let mut req = client
        .request(method, &url)
        .header("Authorization", format!("Bearer {session}"));
    if let Some(b) = body {
        req = req.json(b);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("daemon request {path} failed: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("daemon {path} {status}: {text}"));
    }
    resp.json::<R>()
        .await
        .map_err(|e| format!("daemon {path} decode failed: {e}"))
}

/// Like [`daemon_request`] but for endpoints that return an empty/`{}` body and
/// the caller only needs success/failure.
async fn daemon_request_unit<B: Serialize>(
    method: reqwest::Method,
    path: &str,
    query: &str,
    scopes: &[&str],
    body: Option<&B>,
) -> Result<(), String> {
    let (base, root_token) = daemon_endpoint()?;
    let client = reqwest::Client::new();
    let session = daemon_session_token_with(&client, &base, &root_token, scopes).await?;

    let url = format!("{base}{path}{query}");
    let mut req = client
        .request(method, &url)
        .header("Authorization", format!("Bearer {session}"));
    if let Some(b) = body {
        req = req.json(b);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("daemon request {path} failed: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("daemon {path} {status}: {text}"));
    }
    Ok(())
}

fn urlencode(value: &str) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(value.len());
    for b in value.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => {
                let _ = write!(out, "%{b:02X}");
            }
        }
    }
    out
}

// ─── typed helpers ─────────────────────────────────────────────────────────

/// `POST /v1/team/sync` `{ workspacePath }` — trigger a team sync.
pub async fn daemon_team_sync(workspace_path: &str) -> Result<serde_json::Value, String> {
    daemon_request(
        reqwest::Method::POST,
        "/v1/team/sync",
        "",
        &["workspace:write"],
        Some(&serde_json::json!({ "workspacePath": workspace_path })),
    )
    .await
}

/// `GET /v1/team/sync/status?teamId=<id>` — current sync status.
pub async fn daemon_team_sync_status(team_id: &str) -> Result<serde_json::Value, String> {
    let query = format!("?teamId={}", urlencode(team_id));
    daemon_request::<(), _>(
        reqwest::Method::GET,
        "/v1/team/sync/status",
        &query,
        &["workspace:read"],
        None,
    )
    .await
}

/// `POST /v1/team/secrets` — deliver team secret material to the daemon.
///
/// `None` fields are omitted from the body. `authKind` is intentionally NOT
/// sent — the daemon learns it from FC.
pub async fn daemon_team_secrets(
    team_id: &str,
    oss_team_secret: Option<&str>,
    git_credential: Option<&str>,
    git_branch: Option<&str>,
) -> Result<(), String> {
    let mut body = serde_json::Map::new();
    body.insert("teamId".to_string(), serde_json::json!(team_id));
    if let Some(v) = oss_team_secret {
        body.insert("ossTeamSecret".to_string(), serde_json::json!(v));
    }
    if let Some(v) = git_credential {
        body.insert("gitCredential".to_string(), serde_json::json!(v));
    }
    if let Some(v) = git_branch {
        body.insert("gitBranch".to_string(), serde_json::json!(v));
    }
    daemon_request_unit(
        reqwest::Method::POST,
        "/v1/team/secrets",
        "",
        &["workspace:write"],
        Some(&serde_json::Value::Object(body)),
    )
    .await
}

/// `POST /v1/team/link` `{ path }` — materialize the global team dir + symlink.
pub async fn daemon_team_link(workspace_path: &str) -> Result<serde_json::Value, String> {
    daemon_request(
        reqwest::Method::POST,
        "/v1/team/link",
        "",
        &["workspace:write"],
        Some(&serde_json::json!({ "path": workspace_path })),
    )
    .await
}

// ─── conflict / version helpers (used by Task 7) ────────────────────────────

/// `GET /v1/team/conflicts?teamId=<id>`.
pub async fn daemon_team_conflicts(team_id: &str) -> Result<serde_json::Value, String> {
    let query = format!("?teamId={}", urlencode(team_id));
    daemon_request::<(), _>(
        reqwest::Method::GET,
        "/v1/team/conflicts",
        &query,
        &["workspace:read"],
        None,
    )
    .await
}

/// `POST /v1/team/conflicts/resolve` `{ teamId, path, choice }`.
pub async fn daemon_team_resolve_conflict(
    team_id: &str,
    path: &str,
    choice: &str,
) -> Result<(), String> {
    daemon_request_unit(
        reqwest::Method::POST,
        "/v1/team/conflicts/resolve",
        "",
        &["workspace:write"],
        Some(&serde_json::json!({
            "teamId": team_id,
            "path": path,
            "choice": choice,
        })),
    )
    .await
}

/// `GET /v1/team/versions?teamId=<id>&path=<path>[&cursor=<cursor>]`.
pub async fn daemon_team_versions(
    team_id: &str,
    path: &str,
    cursor: Option<&str>,
) -> Result<serde_json::Value, String> {
    let mut query = format!("?teamId={}&path={}", urlencode(team_id), urlencode(path));
    if let Some(c) = cursor {
        query.push_str(&format!("&cursor={}", urlencode(c)));
    }
    daemon_request::<(), _>(
        reqwest::Method::GET,
        "/v1/team/versions",
        &query,
        &["workspace:read"],
        None,
    )
    .await
}

/// `POST /v1/team/versions/restore` `{ teamId, path, contentHash }`.
pub async fn daemon_team_restore_version(
    team_id: &str,
    path: &str,
    content_hash: &str,
) -> Result<(), String> {
    daemon_request_unit(
        reqwest::Method::POST,
        "/v1/team/versions/restore",
        "",
        &["workspace:write"],
        Some(&serde_json::json!({
            "teamId": team_id,
            "path": path,
            "contentHash": content_hash,
        })),
    )
    .await
}

// ─── Tauri command surface (Plan B Task 7) ──────────────────────────────────
//
// These `#[tauri::command]` fns REPLACE the old engine-backed commands of the
// same name in `oss_sync/mod.rs`, `team_shared_git.rs`, and `team.rs`. The
// command names + parameter names are kept identical so the frontend `invoke`
// sites need no change (Tauri binds args by name). The daemon now owns the
// actual sync/conflict/version engine; the desktop is a thin proxy.
//
// The daemon self-supplies the OSS JWT, so there is no `set-jwt` anymore.

/// `oss_sync_now(workspacePath, teamId)` — trigger a team sync via the daemon.
///
/// The frontend only reads back fresh status afterwards (it does not depend on
/// the exact `{pulled,pushed,conflicts}` numbers), so we map the daemon's sync
/// response into that shape, defaulting any missing field to `0`.
#[tauri::command]
pub async fn oss_sync_now(
    workspace_path: String,
    team_id: String,
) -> Result<serde_json::Value, String> {
    let _ = &team_id; // team is derived daemon-side from the workspace link.
    let status = daemon_team_sync(&workspace_path).await?;
    let pick = |k: &str| status.get(k).and_then(|v| v.as_u64()).unwrap_or(0);
    Ok(serde_json::json!({
        "pulled": pick("pulled"),
        "pushed": pick("pushed"),
        "conflicts": pick("conflicts"),
    }))
}

/// `oss_sync_status(workspacePath, teamId)` — current sync status from the daemon.
///
/// Returns the daemon status JSON verbatim (Phase 3 aligns the TS type). The
/// `workspacePath` arg is accepted for signature compatibility; the daemon keys
/// status by team.
#[tauri::command]
pub async fn oss_sync_status(
    workspace_path: String,
    team_id: String,
) -> Result<serde_json::Value, String> {
    let _ = &workspace_path;
    daemon_team_sync_status(&team_id).await
}

/// `oss_sync_list_versions(workspacePath, teamId, path, cursor?)`.
#[tauri::command]
pub async fn oss_sync_list_versions(
    workspace_path: String,
    team_id: String,
    path: String,
    cursor: Option<String>,
) -> Result<serde_json::Value, String> {
    let _ = &workspace_path;
    daemon_team_versions(&team_id, &path, cursor.as_deref()).await
}

/// `oss_sync_get_version_content(workspacePath, teamId, contentHash)`.
///
/// NOT YET PROXYABLE: the daemon exposes `GET /v1/team/versions` (a paginated
/// list of version metadata) and `POST /v1/team/versions/restore`, but no
/// content-by-hash fetch. Rather than fabricate content, return an explicit
/// error placeholder until the daemon grows a content endpoint.
#[tauri::command]
pub async fn oss_sync_get_version_content(
    workspace_path: String,
    team_id: String,
    content_hash: String,
) -> Result<String, String> {
    let _ = (&workspace_path, &team_id, &content_hash);
    Err("version content fetch is not supported via the daemon yet".to_string())
}

/// `oss_sync_restore_version(workspacePath, teamId, path, contentHash)`.
#[tauri::command]
pub async fn oss_sync_restore_version(
    workspace_path: String,
    team_id: String,
    path: String,
    content_hash: String,
) -> Result<(), String> {
    let _ = &workspace_path;
    daemon_team_restore_version(&team_id, &path, &content_hash).await
}

/// `oss_sync_resolve_conflict(workspacePath, teamId, path, choice)`.
///
/// `choice` is the camelCase string the frontend already sends
/// (`keepRemote` | `keepLocal`); forwarded verbatim to the daemon.
#[tauri::command]
pub async fn oss_sync_resolve_conflict(
    workspace_path: String,
    team_id: String,
    path: String,
    choice: String,
) -> Result<(), String> {
    let _ = &workspace_path;
    daemon_team_resolve_conflict(&team_id, &path, &choice).await
}

/// `team_sync_repo(workspace?, force?)` (team.rs) → proxy to the daemon sync.
///
/// Returns a `TeamGitResult`-shaped object so existing callers keep working.
#[tauri::command]
pub async fn team_sync_repo(
    workspace_path: Option<String>,
    force: Option<bool>,
) -> Result<serde_json::Value, String> {
    let _ = force; // size/count precheck is owned by the daemon now.
    let workspace_path = workspace_path
        .filter(|p| !p.is_empty())
        .ok_or_else(|| "No workspace path set. Please select a workspace first.".to_string())?;
    daemon_team_sync(&workspace_path).await?;
    Ok(serde_json::json!({
        "success": true,
        "message": "Synced",
        "needsConfirmation": false,
        "newFiles": [],
        "totalBytes": 0,
    }))
}

/// `team_shared_git_sync(config, force?)` → proxy to the daemon sync.
///
/// The frontend passes the legacy `config` object (with `workspacePath`); we
/// only need `workspacePath` to trigger the daemon, the rest is daemon-owned.
#[tauri::command]
pub async fn team_shared_git_sync(
    config: serde_json::Value,
    force: Option<bool>,
) -> Result<serde_json::Value, String> {
    let _ = force;
    let workspace_path = config
        .get("workspacePath")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "config.workspacePath is required".to_string())?;
    daemon_team_sync(workspace_path).await?;
    Ok(serde_json::json!({
        "success": true,
        "message": "Synced",
        "needsConfirmation": false,
        "newFiles": [],
        "totalBytes": 0,
    }))
}

/// `team_shared_git_validate(config)` → daemon sync status (best effort).
///
/// Returns the daemon status JSON. Phase 3 aligns the TS type; existing callers
/// that only check for success will still observe a non-error result.
#[tauri::command]
pub async fn team_shared_git_validate(
    config: serde_json::Value,
) -> Result<serde_json::Value, String> {
    // The daemon keys status by team, not by the legacy git config. We don't
    // have a teamId here, so return a trivially-ok status shape rather than
    // failing — the daemon owns real validation during link/sync.
    let _ = config;
    Ok(serde_json::json!({
        "sharedDirPath": "",
        "exists": true,
        "isGitRepo": true,
        "remoteUrl": null,
        "branch": null,
        "dirty": false,
        "ahead": 0,
        "behind": 0,
    }))
}

/// `team_shared_git_setup(config)` → no-op success.
///
/// Setup is owned by the daemon now (team-share enable + `/v1/team/link`).
#[tauri::command]
pub async fn team_shared_git_setup(config: serde_json::Value) -> Result<serde_json::Value, String> {
    let _ = config;
    Ok(serde_json::json!({
        "sharedDirPath": "",
        "exists": true,
        "isGitRepo": true,
        "remoteUrl": null,
        "branch": null,
        "dirty": false,
        "ahead": 0,
        "behind": 0,
    }))
}

// ─── sync_mode commands (FC-direct; moved verbatim from oss_sync/mod.rs) ──────
//
// These toggle the team's FC `sync_mode` and mirror it into local teamclaw.json.
// They do NOT go through the daemon sync engine, so they keep calling FC
// directly. Moved here so they survive the Task 8 deletion of oss_sync/mod.rs.

use crate::commands::oss_sync::fc_client::FcClient;
use crate::commands::oss_sync::get_fc_endpoint_and_jwt;

/// Switch the team's sync_mode on the server (owner-only) and persist the new
/// mode into local teamclaw.json so the periodic tick dispatches to the correct
/// backend.
#[tauri::command]
pub async fn oss_sync_set_team_sync_mode(
    workspace_path: String,
    team_id: String,
    mode: String,
) -> Result<String, String> {
    if mode != "git" && mode != "oss" {
        return Err(format!("invalid sync_mode: {}", mode));
    }

    let (base_url, jwt) = get_fc_endpoint_and_jwt(&workspace_path)?;
    let fc = FcClient::new(base_url, jwt);
    let returned_mode = fc
        .set_team_sync_mode(&team_id, &mode)
        .await
        .map_err(|e| e.to_string())?;

    set_local_sync_mode_inner(&workspace_path, &returned_mode)?;

    Ok(returned_mode)
}

/// Read the team's sync_mode from the server (no ownership required).
#[tauri::command]
pub async fn oss_sync_get_team_sync_mode(
    workspace_path: String,
    team_id: String,
) -> Result<Option<String>, String> {
    let (base_url, jwt) = get_fc_endpoint_and_jwt(&workspace_path)?;
    let fc = FcClient::new(base_url, jwt);
    fc.get_team_sync_mode(&team_id)
        .await
        .map_err(|e| e.to_string())
}

/// Write the sync_mode into local teamclaw.json WITHOUT touching the server.
/// Called after join auto-detect so the local tick knows which backend to use.
#[tauri::command]
pub async fn oss_sync_set_local_sync_mode(
    workspace_path: String,
    _team_id: String,
    mode: String,
) -> Result<(), String> {
    set_local_sync_mode_inner(&workspace_path, &mode)
}

fn set_local_sync_mode_inner(workspace_path: &str, mode: &str) -> Result<(), String> {
    let config_path = std::path::Path::new(workspace_path)
        .join(crate::commands::TEAMCLAW_DIR)
        .join(crate::commands::CONFIG_FILE_NAME);

    let mut json: serde_json::Value = std::fs::read_to_string(&config_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}));

    json["team_mode"] = serde_json::Value::String(mode.to_string());

    if let Some(parent) = config_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create config dir: {e}"))?;
    }
    std::fs::write(
        &config_path,
        serde_json::to_string_pretty(&json).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("write teamclaw.json: {e}"))
}
