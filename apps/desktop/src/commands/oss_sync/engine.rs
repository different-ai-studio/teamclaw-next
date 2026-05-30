//! SyncEngine — `tick()` entry point implementing full pull → push cycle (spec §4.3).
//!
//! Design note (§4.3 fix #11): after overwriting a local file during PULL,
//! the state entry is updated with dirty=false. The high-water mark
//! `last_server_seq` is only advanced **after** the full cursor drain.

use std::path::Path;
use std::time::UNIX_EPOCH;

use tauri::{Emitter, Manager};

use super::{
    conflict::write_conflict_sidecar,
    crypto::{decrypt_blob, encrypt_blob, sha256_hex},
    error::SyncError,
    fc_client::{FcClient, ManifestItem},
    path_validator::{validate, validate_no_symlink_escape},
    scanner::scan_workspace,
    state::LocalSyncState,
};
use crate::commands::shared_secrets_crypto::derive_key;
use crate::commands::team_secret_store::load_team_secret;

/// The directory the OSS engine scans for this workspace. It is the
/// `teamclaw-team` entry (a symlink to the team's global copy once the daemon
/// has linked it). Returned as an owned String to match existing call sites.
pub(crate) fn team_content_root(workspace_path: &str) -> String {
    Path::new(workspace_path)
        .join(crate::commands::TEAM_REPO_DIR)
        .to_string_lossy()
        .into_owned()
}

/// Summary returned by `tick()`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TickResult {
    pub pulled: u32,
    pub pushed: u32,
    pub conflicts: u32,
}

/// Run a full sync tick: PULL then PUSH (spec §4.3).
pub async fn tick(
    workspace_path: &str,
    team_id: &str,
    fc: &FcClient,
    app: &tauri::AppHandle,
) -> Result<TickResult, SyncError> {
    let team_secret = load_team_secret(workspace_path, team_id)
        .map_err(|e| SyncError::State(format!("load team_secret: {e}")))?;
    let key = derive_key(&team_secret).map_err(SyncError::Crypto)?;

    // Synced content lives in the team shared dir (<workspace>/teamclaw-team),
    // not the workspace root. Scan / upload / download all operate under this
    // content root; team secret, JWT and local sync state stay at the workspace
    // root (.teamclaw/...).
    let content_root = team_content_root(workspace_path);

    let mut state =
        LocalSyncState::load(workspace_path, team_id).map_err(|e| SyncError::State(e))?;

    // ── PULL ─────────────────────────────────────────────────────────────────
    // Paginate /sync/manifest fully before advancing last_server_seq.
    let mut cursor: Option<String> = None;
    let mut snapshot_seq: Option<i64> = None;
    let mut all_items: Vec<ManifestItem> = Vec::new();

    loop {
        let page = fc
            .manifest(team_id, state.last_server_seq, cursor.clone(), snapshot_seq)
            .await?;
        snapshot_seq.get_or_insert(page.snapshot_seq);
        all_items.extend(page.items);
        match page.next_cursor {
            Some(c) => cursor = Some(c),
            None => break,
        }
    }

    let mut pulled = 0u32;
    let mut pull_conflicts = 0u32;

    for item in &all_items {
        // Spec §4.3: path-validate all manifest items (defense vs. malicious remote).
        validate(&item.path).map_err(SyncError::from)?;

        let abs_path = Path::new(&content_root).join(&item.path);

        if let Some(parent) = abs_path.parent() {
            validate_no_symlink_escape(Path::new(&content_root), &abs_path)
                .map_err(SyncError::from)?;
            let _ = parent; // ensure compiler doesn't strip the validation
        }

        let local = state.files.get(&item.path).cloned();

        if item.deleted {
            // Server says file is deleted.
            if let Some(ref ls) = local {
                if !ls.dirty {
                    // Local is clean — remove it.
                    let _ = tokio::fs::remove_file(&abs_path).await;
                    state.mark_deleted(&item.path);
                }
                // If dirty: leave local file, do NOT delete. User-local edits survive.
            }
            // Not in local state → nothing to do.
            continue;
        }

        let remote_cipher_hash = match &item.content_hash {
            Some(h) => h.clone(),
            None => continue, // shouldn't happen for non-deleted
        };

        let needs_download = match &local {
            None => true,
            Some(ls) => item.version > ls.synced_version,
        };

        if !needs_download {
            continue;
        }

        // If local file is dirty and remote has a newer version → conflict.
        if let Some(ref ls) = local {
            if ls.dirty && item.version > ls.synced_version {
                // Write local content as a conflict sidecar before overwriting.
                if let Ok(local_bytes) = std::fs::read(&abs_path) {
                    let _ = write_conflict_sidecar(&abs_path, &local_bytes, &ls.synced_cipher_hash)
                        .await;
                    pull_conflicts += 1;
                }
            }
        }

        // Download and overwrite.
        match download_and_write(
            &content_root,
            &item.path,
            &remote_cipher_hash,
            item.version,
            &key,
            fc,
            &mut state,
        )
        .await
        {
            Ok(_) => pulled += 1,
            Err(e) => log::warn!("[oss_sync] pull {}: {e}", item.path),
        }
    }

    // Only advance high-water mark after fully draining cursor (spec §4.3).
    if let Some(seq) = snapshot_seq {
        state.last_server_seq = seq;
    }

    // ── PUSH ─────────────────────────────────────────────────────────────────
    // Re-scan to pick up current mtime/size/dirty flags.
    let scan = scan_workspace(&content_root, &state);

    // Apply scan results back into state.
    for scanned in &scan {
        if let Some(fs) = state.files.get_mut(&scanned.rel_path) {
            fs.mtime = scanned.mtime;
            fs.size = scanned.size;
            fs.local_plain_hash = scanned.local_plain_hash.clone();
            fs.dirty = scanned.dirty;
        }
    }

    let dirty_paths: Vec<String> = state
        .files
        .iter()
        .filter(|(_, f)| f.dirty && !f.deleted_local)
        .map(|(p, _)| p.clone())
        .collect();

    // Also include new files from scan (not yet in state).
    let mut extra_dirty: Vec<String> = scan
        .iter()
        .filter(|s| s.dirty && !state.files.contains_key(&s.rel_path))
        .map(|s| s.rel_path.clone())
        .collect();

    let all_dirty: Vec<String> = {
        let mut v = dirty_paths;
        v.append(&mut extra_dirty);
        v.sort();
        v.dedup();
        v
    };

    let mut pushed = 0u32;
    let mut push_conflicts = 0u32;

    for path in all_dirty {
        match upload_one(&content_root, &path, team_id, &key, fc, &mut state).await {
            Ok(_) => pushed += 1,
            Err(SyncError::Conflict {
                remote_version,
                remote_cipher_hash,
            }) => {
                push_conflicts += 1;
                log::warn!(
                    "[oss_sync] push conflict {}: remote_version={:?}",
                    path,
                    remote_version
                );
                // Write local content as conflict sidecar.
                let abs_path = Path::new(&content_root).join(&path);
                if let Ok(local_bytes) = std::fs::read(&abs_path) {
                    let local_cipher_hash = state
                        .files
                        .get(&path)
                        .map(|f| f.synced_cipher_hash.as_str())
                        .unwrap_or("unknown");
                    let _ =
                        write_conflict_sidecar(&abs_path, &local_bytes, local_cipher_hash).await;
                }
                // Download the remote version that beat us.
                if let Some(hash) = remote_cipher_hash {
                    let version = remote_version.unwrap_or(0);
                    let _ = download_and_write(
                        &content_root,
                        &path,
                        &hash,
                        version,
                        &key,
                        fc,
                        &mut state,
                    )
                    .await;
                }
            }
            Err(e) => log::warn!("[oss_sync] push {}: {e}", path),
        }
    }

    state.touch_sync_at();
    state
        .save(workspace_path)
        .map_err(|e| SyncError::State(e))?;

    let dirty_count = state.files.values().filter(|f| f.dirty).count();
    let conflict_count = pull_conflicts + push_conflicts;

    let _ = app.emit(
        "oss-sync-status",
        serde_json::json!({
            "teamId": team_id,
            "lastSyncAt": chrono::Utc::now().to_rfc3339(),
            "syncing": false,
            "dirtyCount": dirty_count,
            "conflicts": conflict_count,
        }),
    );

    Ok(TickResult {
        pulled,
        pushed,
        conflicts: conflict_count,
    })
}

/// Download a remote blob, verify cipher_hash, decrypt, write to disk,
/// and update state to non-dirty.
pub async fn download_and_write(
    content_root: &str,
    rel_path: &str,
    remote_cipher_hash: &str,
    version: i32,
    key: &[u8; 32],
    fc: &FcClient,
    state: &mut LocalSyncState,
) -> Result<(), SyncError> {
    let team_id = state.team_id.clone();
    let dl = fc.download(&team_id, remote_cipher_hash).await?;
    let blob = fc.get_blob(&dl.download_url, remote_cipher_hash).await?;

    let plaintext = decrypt_blob(&blob, key).map_err(SyncError::Crypto)?;
    let plain_hash = sha256_hex(&plaintext);

    let abs_path = Path::new(content_root).join(rel_path);
    if let Some(parent) = abs_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| SyncError::Io(e.to_string()))?;
    }
    tokio::fs::write(&abs_path, &plaintext)
        .await
        .map_err(|e| SyncError::Io(e.to_string()))?;

    let meta = std::fs::metadata(&abs_path).map_err(SyncError::from)?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let size = meta.len();

    // Spec §4.3 fix #11: update state to non-dirty after overwrite.
    state.upsert(
        rel_path,
        version,
        remote_cipher_hash.to_string(),
        plain_hash.clone(),
        plain_hash,
        mtime,
        size,
    );

    Ok(())
}

/// Encrypt and upload one dirty local file.
async fn upload_one(
    content_root: &str,
    rel_path: &str,
    team_id: &str,
    key: &[u8; 32],
    fc: &FcClient,
    state: &mut LocalSyncState,
) -> Result<(), SyncError> {
    let abs_path = Path::new(content_root).join(rel_path);
    let plaintext = tokio::fs::read(&abs_path)
        .await
        .map_err(|e| SyncError::Io(e.to_string()))?;
    let plain_hash = sha256_hex(&plaintext);

    let blob = encrypt_blob(&plaintext, key).map_err(SyncError::Crypto)?;
    let remote_cipher_hash = sha256_hex(&blob);

    let parent_version = state
        .files
        .get(rel_path)
        .map(|f| f.synced_version)
        .unwrap_or(0);

    let prepare = fc
        .upload_prepare(
            team_id,
            rel_path,
            parent_version,
            &remote_cipher_hash,
            blob.len() as u64,
            None,
        )
        .await?;

    if prepare.requires_upload {
        if let Some(url) = &prepare.presigned_put {
            fc.put_blob(url, blob).await?;
        }
    }

    let complete = fc
        .upload_complete(team_id, &prepare.upload_session_id)
        .await?;

    let meta = std::fs::metadata(&abs_path).map_err(SyncError::from)?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let size = meta.len();

    state.upsert(
        rel_path,
        complete.version,
        complete.content_hash,
        plain_hash.clone(),
        plain_hash,
        mtime,
        size,
    );

    Ok(())
}

#[cfg(test)]
mod content_root_tests {
    use super::*;

    #[test]
    fn content_root_is_team_repo_dir_under_workspace() {
        let root = team_content_root("/tmp/ws");
        assert_eq!(
            root,
            Path::new("/tmp/ws")
                .join(crate::commands::TEAM_REPO_DIR)
                .to_string_lossy()
        );
    }
}
