use crate::commands::version_store::VersionStore;
use crate::commands::version_types::{FileVersion, VersionedFileInfo};

use std::sync::Arc;
use tauri::State;
use tokio::sync::Mutex;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

pub struct VersionStoreState(pub Arc<Mutex<Option<VersionStore>>>);

impl Default for VersionStoreState {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(None)))
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Ensure the VersionStore is initialized for the given workspace.
/// Returns an error string if initialization fails.
async fn ensure_version_store(
    state: &VersionStoreState,
    workspace_path: &str,
) -> Result<(), String> {
    let mut guard = state.0.lock().await;
    if guard.is_none() {
        let store = VersionStore::new(workspace_path)
            .await
            .map_err(|e| format!("Failed to open VersionStore: {e}"))?;
        *guard = Some(store);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn team_list_file_versions(
    _workspace_path: String,
    _doc_type: String,
    _file_path: String,
    _version_state: State<'_, VersionStoreState>,
) -> Result<Vec<FileVersion>, String> {
    Ok(Vec::new())
}

#[tauri::command]
pub async fn team_list_all_versioned_files(
    _workspace_path: String,
    _doc_type: Option<String>,
    _version_state: State<'_, VersionStoreState>,
) -> Result<Vec<VersionedFileInfo>, String> {
    Ok(Vec::new())
}

// NOTE: `#[tauri::command]` intentionally removed here. The unified daemon
// proxy `team_sync_proxy::team_restore_file_version` now owns this command name;
// keeping the macro on this (now-unregistered) shim would collide at crate root
// (`__cmd__team_restore_file_version` defined twice). This whole module is
// removed in Task 4.
#[allow(dead_code)]
pub async fn team_restore_file_version(
    _workspace_path: String,
    _doc_type: String,
    _file_path: String,
    _version_index: u32,
    _version_state: State<'_, VersionStoreState>,
) -> Result<(), String> {
    Err("Team file version restore is not available".to_string())
}
