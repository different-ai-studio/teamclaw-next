//! SyncEngine — `tick()` entry point implementing full pull → push cycle (spec §4.3).
//!
//! Design note (§4.3 fix #11): after overwriting a local file during PULL,
//! the state entry is updated with dirty=false. The high-water mark
//! `last_server_seq` is only advanced **after** the full cursor drain.

use std::path::Path;
use std::time::UNIX_EPOCH;

use super::{
    conflict::write_conflict_sidecar,
    crypto::{decrypt_blob, encrypt_blob, sha256_hex},
    error::SyncError,
    fc_client::{FcClient, ManifestItem},
    path_validator::{validate, validate_no_symlink_escape},
    scanner::{scan_workspace, ScannedFile},
    state::LocalSyncState,
};

/// Summary returned by `tick()`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TickResult {
    pub pulled: u32,
    pub pushed: u32,
    pub conflicts: u32,
}

/// Run a full sync tick: PULL then PUSH (spec §4.3).
pub async fn tick(
    content_root: &str,
    team_id: &str,
    team_secret: &str,
    fc: &FcClient,
) -> Result<TickResult, SyncError> {
    let key = crate::team_shared_env::derive_key(team_secret)
        .map_err(|e| SyncError::Crypto(e.to_string()))?;
    // content_root is now a parameter (the global team dir).
    let mut state = LocalSyncState::load_at(team_id).map_err(SyncError::State)?;

    // Refresh the `dirty` flag from the working tree BEFORE PULL so the pull-phase
    // checks reflect the CURRENT tree, not the last-sync snapshot. Without this an
    // unsynced local edit (state still dirty=false) is silently overwritten by a
    // newer remote version with no conflict sidecar.
    //
    // IMPORTANT: only `dirty` is updated here — NOT mtime/size. Those stay at the
    // last-synced baseline that the PUSH-phase scan's cheap mtime+size check relies
    // on; mutating them here would make that scan treat an edited file as clean and
    // skip the upload.
    refresh_dirty(&mut state, content_root);

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

        let abs_path = Path::new(content_root).join(&item.path);

        if let Some(parent) = abs_path.parent() {
            validate_no_symlink_escape(Path::new(content_root), &abs_path)
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
            content_root,
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
            Err(e) => tracing::warn!("[oss_sync] pull {}: {e}", item.path),
        }
    }

    // Only advance high-water mark after fully draining cursor (spec §4.3).
    if let Some(seq) = snapshot_seq {
        state.last_server_seq = seq;
    }

    // ── PUSH ─────────────────────────────────────────────────────────────────
    // Re-scan (the tree may have changed during PULL) to pick up current
    // mtime/size/dirty flags.
    let scan = apply_scan(&mut state, content_root);

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
    // Transient (rate-limit / 503) failures that survived in-call retries. We leave
    // such files dirty (no upsert) so they retry next tick, and surface the
    // condition via the returned error rather than silently dropping the change.
    let mut deferred = 0u32;
    let mut last_transient: Option<SyncError> = None;

    for path in all_dirty {
        match upload_one_retrying(content_root, &path, team_id, &key, fc, &mut state).await {
            Ok(_) => pushed += 1,
            Err(SyncError::Conflict {
                remote_version,
                remote_cipher_hash,
            }) => {
                push_conflicts += 1;
                tracing::warn!(
                    "[oss_sync] push conflict {}: remote_version={:?}",
                    path,
                    remote_version
                );
                // Write local content as conflict sidecar.
                let abs_path = Path::new(content_root).join(&path);
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
                        content_root,
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
            Err(e) => {
                if is_transient(&e) {
                    deferred += 1;
                    last_transient = Some(e);
                } else {
                    tracing::warn!("[oss_sync] push {}: {e}", path);
                }
            }
        }
    }

    // Propagate local deletions: a previously-synced file that is absent from the
    // current scan was deleted locally → emit a server-side tombstone so other
    // nodes pull the deletion. `fc.delete_file` does a parentVersion CAS.
    for (path, synced_version) in locally_deleted_paths(&state, &scan) {
        match delete_file_retrying(fc, team_id, &path, synced_version).await {
            Ok(()) => {
                state.mark_deleted(&path);
                pushed += 1;
            }
            Err(SyncError::Conflict { .. }) => {
                // Remote advanced since our last sync; leave the entry so the next
                // pull reconciles rather than deleting a file someone else changed.
                push_conflicts += 1;
            }
            Err(e) => {
                if is_transient(&e) {
                    deferred += 1;
                    last_transient = Some(e);
                } else {
                    tracing::warn!("[oss_sync] delete {}: {e}", path);
                }
            }
        }
    }

    state.touch_sync_at();
    state.save_at(team_id).map_err(SyncError::State)?;

    // Surface persistent rate-limiting rather than silently dropping changes: the
    // deferred files stay dirty and will retry on the next tick. The message keeps
    // the underlying "429/Too Many Requests" text so callers can detect+back off.
    if deferred > 0 {
        let detail = last_transient
            .map(|e| e.to_string())
            .unwrap_or_else(|| "rate limited".to_string());
        return Err(SyncError::Network(format!(
            "{deferred} operation(s) deferred (pulled={pulled} pushed={pushed}); {detail}"
        )));
    }

    let conflict_count = pull_conflicts + push_conflicts;

    let result = TickResult {
        pulled,
        pushed,
        conflicts: conflict_count,
    };

    tracing::info!(
        team_id,
        pulled = result.pulled,
        pushed = result.pushed,
        conflicts = result.conflicts,
        "oss sync tick complete"
    );

    Ok(result)
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

/// Treat FC rate-limiting (HTTP 429) and transient unavailability (503 / timeout)
/// as retryable. These surface as SyncError::Internal/Network carrying the HTTP text.
fn is_transient(e: &SyncError) -> bool {
    let m = e.to_string().to_ascii_lowercase();
    m.contains("429")
        || m.contains("too many requests")
        || m.contains("503")
        || m.contains("temporarily")
        || m.contains("timed out")
        || m.contains("timeout")
}

const MAX_TRANSIENT_RETRIES: u32 = 5;

/// Exponential backoff: ~0.8s, 1.6s, 3.2s, 6.4s, 12s.
async fn backoff_sleep(attempt: u32) {
    let ms = (800u64 << attempt.min(4)).min(12_000);
    tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
}

/// `upload_one` with in-call retry on transient (rate-limit) errors, so a 429 does
/// not silently drop the change. Non-transient errors and Conflict return immediately.
async fn upload_one_retrying(
    content_root: &str,
    rel_path: &str,
    team_id: &str,
    key: &[u8; 32],
    fc: &FcClient,
    state: &mut LocalSyncState,
) -> Result<(), SyncError> {
    let mut attempt = 0u32;
    loop {
        match upload_one(content_root, rel_path, team_id, key, fc, state).await {
            Err(e) if is_transient(&e) && attempt < MAX_TRANSIENT_RETRIES => {
                attempt += 1;
                backoff_sleep(attempt).await;
            }
            other => return other,
        }
    }
}

/// `fc.delete_file` with in-call retry on transient (rate-limit) errors.
async fn delete_file_retrying(
    fc: &FcClient,
    team_id: &str,
    path: &str,
    parent_version: i32,
) -> Result<(), SyncError> {
    let mut attempt = 0u32;
    loop {
        match fc.delete_file(team_id, path, parent_version, None).await {
            Err(e) if is_transient(&e) && attempt < MAX_TRANSIENT_RETRIES => {
                attempt += 1;
                backoff_sleep(attempt).await;
            }
            other => return other,
        }
    }
}

/// Refresh ONLY the `dirty` flag of existing state entries from the working tree.
/// Used before PULL so conflict/deletion checks see current dirtiness. Deliberately
/// does NOT touch mtime/size (the last-synced baseline the PUSH scan depends on).
fn refresh_dirty(state: &mut LocalSyncState, content_root: &str) {
    let scan = scan_workspace(content_root, state);
    for scanned in &scan {
        if let Some(fs) = state.files.get_mut(&scanned.rel_path) {
            fs.dirty = scanned.dirty;
        }
    }
}

/// Scan the working tree and apply current mtime/size/hash/dirty back into the
/// state entries that already exist; returns the scan so callers can also use it
/// for new-file and deletion detection. Used by PUSH (runs once per tick).
fn apply_scan(state: &mut LocalSyncState, content_root: &str) -> Vec<ScannedFile> {
    let scan = scan_workspace(content_root, state);
    for scanned in &scan {
        if let Some(fs) = state.files.get_mut(&scanned.rel_path) {
            fs.mtime = scanned.mtime;
            fs.size = scanned.size;
            fs.local_plain_hash = scanned.local_plain_hash.clone();
            fs.dirty = scanned.dirty;
        }
    }
    scan
}

/// Paths previously synced (`synced_version > 0`) but absent from the current
/// scan → deleted locally, needing a server-side tombstone. Sorted for determinism.
fn locally_deleted_paths(state: &LocalSyncState, scan: &[ScannedFile]) -> Vec<(String, i32)> {
    let present: std::collections::HashSet<&str> =
        scan.iter().map(|s| s.rel_path.as_str()).collect();
    let mut out: Vec<(String, i32)> = state
        .files
        .iter()
        .filter(|(p, f)| !f.deleted_local && f.synced_version > 0 && !present.contains(p.as_str()))
        .map(|(p, f)| (p.clone(), f.synced_version))
        .collect();
    out.sort();
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::oss::state::FileState;
    use std::collections::HashMap;

    fn empty_state() -> LocalSyncState {
        LocalSyncState {
            schema_version: 1,
            team_id: "t".into(),
            last_server_seq: 0,
            last_sync_at: String::new(),
            files: HashMap::new(),
        }
    }

    fn synced_file(version: i32) -> FileState {
        FileState {
            synced_version: version,
            synced_cipher_hash: "c".into(),
            synced_plain_hash: "p".into(),
            local_plain_hash: "p".into(),
            mtime: 1,
            size: 1,
            dirty: false,
            deleted_local: false,
        }
    }

    fn scanned(path: &str) -> ScannedFile {
        ScannedFile {
            rel_path: path.into(),
            mtime: 1,
            size: 1,
            local_plain_hash: "p".into(),
            dirty: false,
        }
    }

    #[test]
    fn locally_deleted_detects_synced_file_absent_from_scan() {
        let mut state = empty_state();
        state.files.insert("skills/a.md".into(), synced_file(3));
        state.files.insert("skills/b.md".into(), synced_file(1));
        // Only a.md is still on disk; b.md was deleted locally.
        let scan = vec![scanned("skills/a.md")];
        assert_eq!(
            locally_deleted_paths(&state, &scan),
            vec![("skills/b.md".to_string(), 1)]
        );
    }

    #[test]
    fn locally_deleted_ignores_never_synced_and_already_deleted() {
        let mut state = empty_state();
        // never synced (version 0) — server doesn't have it; nothing to delete.
        state.files.insert("skills/new.md".into(), synced_file(0));
        // already marked deleted_local — don't re-emit.
        let mut d = synced_file(2);
        d.deleted_local = true;
        state.files.insert("skills/gone.md".into(), d);
        assert!(locally_deleted_paths(&state, &[]).is_empty());
    }

    #[test]
    fn locally_deleted_empty_when_all_present() {
        let mut state = empty_state();
        state.files.insert("skills/a.md".into(), synced_file(2));
        let scan = vec![scanned("skills/a.md")];
        assert!(locally_deleted_paths(&state, &scan).is_empty());
    }

    #[test]
    fn is_transient_matches_rate_limit_and_unavailable() {
        assert!(is_transient(&SyncError::Internal(
            "FC returned HTTP 429 Too Many Requests: Too many requests".into()
        )));
        assert!(is_transient(&SyncError::Network(
            "503 Service Unavailable".into()
        )));
        assert!(is_transient(&SyncError::Network(
            "connection timed out".into()
        )));
        // Non-transient errors must NOT be retried.
        assert!(!is_transient(&SyncError::Conflict {
            remote_version: Some(2),
            remote_cipher_hash: None
        }));
        assert!(!is_transient(&SyncError::InvalidPath("bad prefix".into())));
        assert!(!is_transient(&SyncError::Auth("forbidden".into())));
    }

    #[test]
    fn refresh_dirty_marks_edit_without_mutating_mtime_size() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        std::fs::create_dir_all(dir.path().join("skills")).unwrap();
        let f = dir.path().join("skills/x.md");
        std::fs::write(&f, b"base\n").unwrap();

        // State reflects last-synced "base\n" with a baseline mtime/size.
        let mut state = empty_state();
        state.files.insert(
            "skills/x.md".into(),
            FileState {
                synced_version: 1,
                synced_cipher_hash: "c".into(),
                synced_plain_hash: sha256_hex(b"base\n"),
                local_plain_hash: sha256_hex(b"base\n"),
                mtime: 111,
                size: 5,
                dirty: false,
                deleted_local: false,
            },
        );

        // Edit the file (different content + size).
        std::fs::write(&f, b"edited-bigger\n").unwrap();
        refresh_dirty(&mut state, root);

        let fs = &state.files["skills/x.md"];
        assert!(fs.dirty, "edited file must be flagged dirty before pull");
        // Critical: the last-synced baseline must be untouched so the PUSH scan
        // still detects the change and uploads it.
        assert_eq!(fs.mtime, 111, "refresh_dirty must not mutate mtime");
        assert_eq!(fs.size, 5, "refresh_dirty must not mutate size");
    }
}
