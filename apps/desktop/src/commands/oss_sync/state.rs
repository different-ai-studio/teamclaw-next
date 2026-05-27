//! Local sync state — `.teamclaw/sync/state.json` schema (spec §4.2).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

const SCHEMA_VERSION: u32 = 1;

/// Per-file state entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileState {
    /// Version number at which we last synced this file from the server.
    pub synced_version: i32,
    /// sha256(blob bytes) as of last completed sync — matches `content_hash` on wire.
    pub synced_cipher_hash: String,
    /// sha256(plaintext) as of last completed sync — local only, never sent.
    pub synced_plain_hash: String,
    /// sha256(current local plaintext) — updated on every scan.
    pub local_plain_hash: String,
    /// Last modified time (unix seconds) at last scan.
    pub mtime: u64,
    /// File size in bytes at last scan.
    pub size: u64,
    /// True if local file differs from `synced_plain_hash`.
    pub dirty: bool,
    /// True if the file was locally deleted but the deletion not yet pushed.
    #[serde(default)]
    pub deleted_local: bool,
}

/// Full local sync state file (schema v1).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSyncState {
    pub schema_version: u32,
    pub team_id: String,
    /// The highest `change_seq` whose full page has been processed.
    pub last_server_seq: i64,
    pub last_sync_at: String,
    /// Map from relative path (e.g. "skills/foo.md") to per-file state.
    pub files: HashMap<String, FileState>,
}

impl LocalSyncState {
    /// Load from `.teamclaw/sync/state.json` inside `workspace_path`.
    /// Returns a default empty state if the file doesn't exist.
    pub fn load(workspace_path: &str, team_id: &str) -> Result<Self, String> {
        let path = state_path(workspace_path);
        if !path.exists() {
            return Ok(Self::new(team_id));
        }
        let raw = std::fs::read_to_string(&path)
            .map_err(|e| format!("state: read {}: {e}", path.display()))?;
        let state: Self = serde_json::from_str(&raw)
            .map_err(|e| format!("state: parse {}: {e}", path.display()))?;
        if state.schema_version != SCHEMA_VERSION {
            return Err(format!(
                "state: unsupported schemaVersion {} (expected {})",
                state.schema_version, SCHEMA_VERSION
            ));
        }
        Ok(state)
    }

    /// Persist state to `.teamclaw/sync/state.json`.
    pub fn save(&self, workspace_path: &str) -> Result<(), String> {
        let path = state_path(workspace_path);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("state: create dir {}: {e}", parent.display()))?;
        }
        let json = serde_json::to_string_pretty(self)
            .map_err(|e| format!("state: serialize: {e}"))?;
        std::fs::write(&path, json)
            .map_err(|e| format!("state: write {}: {e}", path.display()))?;
        Ok(())
    }

    fn new(team_id: &str) -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            team_id: team_id.to_string(),
            last_server_seq: 0,
            last_sync_at: "".to_string(),
            files: HashMap::new(),
        }
    }

    /// Insert or update a file entry after a successful download/upload.
    pub fn upsert(
        &mut self,
        path: &str,
        synced_version: i32,
        synced_cipher_hash: String,
        synced_plain_hash: String,
        local_plain_hash: String,
        mtime: u64,
        size: u64,
    ) {
        self.files.insert(
            path.to_string(),
            FileState {
                synced_version,
                synced_cipher_hash,
                synced_plain_hash,
                local_plain_hash: local_plain_hash.clone(),
                mtime,
                size,
                dirty: false,
                deleted_local: false,
            },
        );
    }

    /// Mark a file as deleted server-side (remove from map, or mark deleted).
    pub fn mark_deleted(&mut self, path: &str) {
        self.files.remove(path);
    }

    /// Update the timestamp of last successful sync (RFC 3339).
    pub fn touch_sync_at(&mut self) {
        self.last_sync_at = chrono_now_utc();
    }
}

fn state_path(workspace_path: &str) -> PathBuf {
    Path::new(workspace_path)
        .join(".teamclaw")
        .join("sync")
        .join("state.json")
}

fn chrono_now_utc() -> String {
    chrono::Utc::now().to_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_load_save_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_str().unwrap();
        let mut state = LocalSyncState::load(ws, "team-abc").unwrap();
        assert_eq!(state.schema_version, 1);
        assert_eq!(state.team_id, "team-abc");
        assert_eq!(state.last_server_seq, 0);

        state.upsert(
            "skills/foo.md",
            3,
            "cipherhash".into(),
            "plainhash".into(),
            "plainhash".into(),
            1748332800,
            1024,
        );
        state.last_server_seq = 42;
        state.save(ws).unwrap();

        let loaded = LocalSyncState::load(ws, "team-abc").unwrap();
        assert_eq!(loaded.last_server_seq, 42);
        let f = loaded.files.get("skills/foo.md").unwrap();
        assert_eq!(f.synced_version, 3);
        assert_eq!(f.synced_cipher_hash, "cipherhash");
        assert!(!f.dirty);
    }

    #[test]
    fn test_schema_version_mismatch() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".teamclaw").join("sync").join("state.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            r#"{"schemaVersion":99,"teamId":"t","lastServerSeq":0,"lastSyncAt":"","files":{}}"#,
        )
        .unwrap();
        let result = LocalSyncState::load(dir.path().to_str().unwrap(), "t");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("schemaVersion"));
    }
}
