//! Materialize team global dir + workspace `teamclaw-team` link.
//!
//! Shared by the daemon core and the HTTP `/v1/team/link` handler so HTTP
//! integration tests do not need to pull in `daemon::server`.

use std::path::Path;

use tracing::{info, warn};

use crate::config::workspace_link::LinkStatus;
use crate::team_shared_git;

/// Idempotently materialize a team's global shared dir and a workspace's
/// `teamclaw-team` symlink into it.
pub fn ensure_team_link(team_id: &str, ws_path: &str) -> LinkStatus {
    if team_id.trim().is_empty() || ws_path.trim().is_empty() {
        return LinkStatus::Fallback;
    }
    let global_dir = crate::config::global_team_store::global_team_dir(team_id);
    if let Some(config) = team_shared_git::read_git_team_config(Path::new(ws_path)) {
        if let Err(e) = team_shared_git::sync_git_dir(&global_dir, &config) {
            warn!(team_id, "global git sync failed: {e}");
        }
    }
    if let Err(e) = crate::config::global_team_store::ensure_initialized(team_id) {
        warn!(team_id, "global team dir init failed: {e}");
        return LinkStatus::Fallback;
    }
    let ws_root = Path::new(ws_path);
    let status = crate::config::workspace_link::ensure_workspace_link(ws_root, team_id);
    let effective = crate::config::global_team_store::resolve_team_dir(ws_root, team_id);
    info!(
        team_id,
        workspace = %ws_path,
        effective = %effective.display(),
        "team link: {status:?}"
    );
    status
}
