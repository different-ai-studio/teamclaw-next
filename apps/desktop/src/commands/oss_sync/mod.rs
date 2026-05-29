//! OSS Sync v3 — Rust implementation (spec §4).
//!
//! Module layout:
//!   mod.rs          — re-exports + Tauri commands
//!   engine.rs       — SyncEngine::tick() + sync_now() entry points
//!   state.rs        — LocalSyncState serde (.teamclaw/sync/state.json)
//!   scanner.rs      — workspace walker, mtime/size dirty detection
//!   manifest.rs     — manifest pagination helpers + tests
//!   conflict.rs     — conflict sidecar file writes
//!   fc_client.rs    — reqwest FC client with JWT injection and error mapping
//!   crypto.rs       — AMXC blob envelope (AES-256-GCM)
//!   path_validator.rs — client-side mirror of FC validateSyncPath + symlink check
//!   error.rs        — SyncError unified error type

pub mod conflict;
pub mod crypto;
pub mod engine;
pub mod error;
pub mod fc_client;
pub mod manifest;
pub mod path_validator;
pub mod scanner;
pub mod state;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::commands::{shared_secrets_crypto::derive_key, team_secret_store};
use engine::TickResult;
use fc_client::{FcClient, VersionInfo};
use state::LocalSyncState;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

pub(crate) fn get_fc_endpoint_and_jwt(workspace_path: &str) -> Result<(String, String), String> {
    // Read teamclaw.json to get fc_endpoint (falls back to default production URL).
    let config_path = std::path::Path::new(workspace_path)
        .join(crate::commands::TEAMCLAW_DIR)
        .join(crate::commands::CONFIG_FILE_NAME);

    let json: serde_json::Value = std::fs::read_to_string(&config_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();

    let base_url = json
        .get("fc_endpoint")
        .and_then(|v| v.as_str())
        .unwrap_or("https://cloud.ucar.cc")
        .trim_end_matches('/')
        .to_string();

    // JWT is the Supabase session token stored in env_blob.
    let jwt = json
        .get("supabase_jwt")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(|| std::env::var("SUPABASE_JWT").ok())
        .ok_or_else(|| "supabase_jwt not found — user not logged in".to_string())?;

    Ok((base_url, jwt))
}


/// Write (or refresh) the Supabase JWT into teamclaw.json so that the OSS sync
/// commands (`oss_sync_now`, `oss_sync_create_team`, etc.) can authenticate
/// against FC. Call this from the frontend whenever the Supabase session
/// changes (`onAuthStateChange` / hydrate).
#[tauri::command]
pub async fn oss_sync_set_jwt(workspace_path: String, jwt: String) -> Result<(), String> {
    let config_path = std::path::Path::new(&workspace_path)
        .join(crate::commands::TEAMCLAW_DIR)
        .join(crate::commands::CONFIG_FILE_NAME);

    let mut json: serde_json::Value = std::fs::read_to_string(&config_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}));

    json["supabase_jwt"] = serde_json::Value::String(jwt);

    if let Some(parent) = config_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create config dir: {e}"))?;
    }
    std::fs::write(
        &config_path,
        serde_json::to_string_pretty(&json).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("write teamclaw.json: {e}"))
}

// ---------------------------------------------------------------------------
// Result types for Tauri commands
// ---------------------------------------------------------------------------

/// Per-file sync status, for coloring the file tree (mirrors git-mode coloring).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSyncStatus {
    /// Relative path from the team content root (forward slashes).
    pub path: String,
    /// One of: `synced` | `modified` | `new` | `conflict`.
    pub status: String,
}

/// One synced file, surfaced for the team-share OSS status panel.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncedFile {
    pub path: String,
    pub synced_version: i32,
    pub dirty: bool,
    /// Local mtime (unix seconds) — used to order "recently synced" files.
    pub mtime: u64,
}

/// Current sync status for the workspace.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub team_id: Option<String>,
    pub last_server_seq: i64,
    pub last_sync_at: String,
    pub dirty_count: usize,
    pub total_files: usize,
    /// Per-file status for tree coloring. Only non-trivial in OSS (webdav) mode.
    pub file_states: Vec<FileSyncStatus>,
    /// Most-recently-touched synced files (newest first), capped for display.
    pub recent_files: Vec<SyncedFile>,
}

/// Conflict resolution choices.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConflictChoice {
    /// Keep the remote version (discard local edits).
    KeepRemote,
    /// Keep the local version (will be uploaded on next push).
    KeepLocal,
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Run a full OSS sync tick (pull + push).
#[tauri::command]
pub async fn oss_sync_now(
    workspace_path: String,
    team_id: String,
    _app: AppHandle,
) -> Result<TickResult, String> {
    // team_id comes from the single source of truth (current-team store), not
    // a local teamclaw.json field, so it can't drift from the active team.
    let (base_url, jwt) = get_fc_endpoint_and_jwt(&workspace_path)?;
    let fc = FcClient::new(base_url, jwt);
    engine::tick(&workspace_path, &team_id, &fc, &_app)
        .await
        .map_err(|e| e.to_string())
}

/// Return current sync status (dirty count, last sync time, etc.).
#[tauri::command]
pub async fn oss_sync_status(
    workspace_path: String,
    team_id: String,
) -> Result<SyncStatus, String> {
    let state = LocalSyncState::load(&workspace_path, &team_id)?;

    // Synced content lives under the team shared dir, not the workspace root —
    // scan there so coloring / counts match what oss_sync_now actually syncs.
    let content_root = std::path::Path::new(&workspace_path)
        .join(crate::commands::TEAM_REPO_DIR)
        .to_string_lossy()
        .into_owned();

    // Fresh scan so coloring reflects edits made since the last sync tick,
    // mirroring how git_status re-runs on each file-tree poll.
    let scanned = scanner::scan_workspace(&content_root, &state);
    let mut statuses: std::collections::HashMap<String, &'static str> =
        std::collections::HashMap::with_capacity(scanned.len());
    for f in &scanned {
        let status = if !f.dirty {
            "synced"
        } else if state.files.contains_key(&f.rel_path) {
            // Tracked before → locally edited.
            "modified"
        } else {
            // Never synced → brand-new local file.
            "new"
        };
        statuses.insert(f.rel_path.clone(), status);
    }

    // Conflict sidecars on disk → mark their originals as conflicted (highest
    // precedence; overrides modified/new/synced).
    for conflict_rel in scanner::scan_conflict_files(&content_root) {
        if let Some(orig) = conflict::original_from_conflict(&conflict_rel) {
            statuses.insert(orig, "conflict");
        }
    }

    let dirty_count = statuses.values().filter(|s| **s != "synced").count();
    let total_files = statuses.len();
    let file_states = statuses
        .into_iter()
        .map(|(path, status)| FileSyncStatus {
            path,
            status: status.to_string(),
        })
        .collect();

    // Most-recently-touched synced files for the status panel.
    let mut recent_files: Vec<SyncedFile> = state
        .files
        .iter()
        .map(|(path, f)| SyncedFile {
            path: path.clone(),
            synced_version: f.synced_version,
            dirty: f.dirty,
            mtime: f.mtime,
        })
        .collect();
    recent_files.sort_by(|a, b| b.mtime.cmp(&a.mtime));
    recent_files.truncate(20);

    Ok(SyncStatus {
        team_id: Some(team_id),
        last_server_seq: state.last_server_seq,
        last_sync_at: state.last_sync_at.clone(),
        dirty_count,
        total_files,
        file_states,
        recent_files,
    })
}

/// List version history for a file.
#[tauri::command]
pub async fn oss_sync_list_versions(
    workspace_path: String,
    team_id: String,
    path: String,
) -> Result<Vec<VersionInfo>, String> {
    let (base_url, jwt) = get_fc_endpoint_and_jwt(&workspace_path)?;
    let fc = FcClient::new(base_url, jwt);
    fc.list_versions(&team_id, &path, None)
        .await
        .map_err(|e| e.to_string())
}

/// Restore a file to a specific version by downloading its blob.
#[tauri::command]
pub async fn oss_sync_restore_version(
    workspace_path: String,
    team_id: String,
    path: String,
    content_hash: String,
    _app: AppHandle,
) -> Result<(), String> {
    let team_secret = team_secret_store::load_team_secret(&workspace_path, &team_id)?;
    let key = derive_key(&team_secret)?;
    let (base_url, jwt) = get_fc_endpoint_and_jwt(&workspace_path)?;
    let fc = FcClient::new(base_url, jwt);

    let mut state = LocalSyncState::load(&workspace_path, &team_id)?;

    // Download and overwrite local file.
    // version=0 placeholder; we don't know the exact version just from hash,
    // but we still write the blob and mark it synced.
    let dl = fc
        .download(&team_id, &content_hash)
        .await
        .map_err(|e| e.to_string())?;
    let blob = fc
        .get_blob(&dl.download_url, &content_hash)
        .await
        .map_err(|e| e.to_string())?;
    let plaintext =
        crate::commands::oss_sync::crypto::decrypt_blob(&blob, &key).map_err(|e| e.to_string())?;
    let plain_hash = crate::commands::oss_sync::crypto::sha256_hex(&plaintext);

    // Synced content lives under the team shared dir, not the workspace root.
    let abs_path = std::path::Path::new(&workspace_path)
        .join(crate::commands::TEAM_REPO_DIR)
        .join(&path);
    if let Some(parent) = abs_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    tokio::fs::write(&abs_path, &plaintext)
        .await
        .map_err(|e| e.to_string())?;

    let meta = std::fs::metadata(&abs_path).map_err(|e| e.to_string())?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let size = meta.len();

    // Find version number in state, or use existing.
    let synced_version = state
        .files
        .get(&path)
        .map(|f| f.synced_version)
        .unwrap_or(0);

    state.upsert(
        &path,
        synced_version,
        content_hash,
        plain_hash.clone(),
        plain_hash,
        mtime,
        size,
    );
    state.save(&workspace_path)?;
    Ok(())
}

/// Resolve a conflict for a file.
#[tauri::command]
pub async fn oss_sync_resolve_conflict(
    workspace_path: String,
    team_id: String,
    path: String,
    choice: ConflictChoice,
    _app: AppHandle,
) -> Result<(), String> {
    let mut state = LocalSyncState::load(&workspace_path, &team_id)?;

    match choice {
        ConflictChoice::KeepRemote => {
            // Mark local as matching synced (non-dirty); next tick will not re-upload.
            if let Some(fs) = state.files.get_mut(&path) {
                fs.local_plain_hash = fs.synced_plain_hash.clone();
                fs.dirty = false;
            }
        }
        ConflictChoice::KeepLocal => {
            // Mark dirty=true so next push uploads local version.
            if let Some(fs) = state.files.get_mut(&path) {
                fs.dirty = true;
            }
        }
    }
    state.save(&workspace_path)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tranche 5: sync_mode switch / get / local-only mirror
// ---------------------------------------------------------------------------

/// Switch the team's sync_mode on the server (owner-only) and persist
/// the new mode into local teamclaw.json so the 5-min tick dispatches
/// to the correct backend.
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

    // Mirror into local config so the periodic tick uses the right backend.
    oss_sync_set_local_sync_mode_inner(&workspace_path, &returned_mode)?;

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
    oss_sync_set_local_sync_mode_inner(&workspace_path, &mode)
}

fn oss_sync_set_local_sync_mode_inner(workspace_path: &str, mode: &str) -> Result<(), String> {
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
