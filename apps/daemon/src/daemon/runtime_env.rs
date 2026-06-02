use std::path::Path;

use crate::runtime::SpawnRuntimeEnv;

use super::DaemonServer;

impl DaemonServer {
    pub(super) fn resolve_workspace_team_id(
        &self,
        worktree: &str,
        workspace_id: &str,
    ) -> Option<String> {
        self.workspaces
            .find_by_id(workspace_id)
            .or_else(|| {
                self.workspaces
                    .workspaces
                    .iter()
                    .find(|w| w.path == worktree)
            })
            .and_then(|w| w.team_id.clone())
            .filter(|team_id| !team_id.trim().is_empty())
            .or_else(|| {
                self.config
                    .team_id
                    .as_ref()
                    .map(|id| id.trim().to_string())
                    .filter(|id| !id.is_empty())
            })
    }

    pub(super) fn assemble_spawn_runtime_env_for_worktree(
        &self,
        worktree: &str,
        workspace_id: &str,
    ) -> Result<SpawnRuntimeEnv, String> {
        let team_id = self.resolve_workspace_team_id(worktree, workspace_id);
        crate::runtime::env_assembly::assemble_spawn_runtime_env(
            Path::new(worktree),
            team_id.as_deref(),
            &self.config.device.id,
            &self.config.device.name,
        )
        .map_err(|e| e.to_string())
    }

    /// Re-bind a live runtime so env vars and resolved `opencode.json` match disk.
    pub(super) async fn refresh_live_runtime_env(
        &self,
        runtime_id: &str,
        worktree: &str,
        workspace_id: &str,
    ) {
        let is_live = self
            .agents
            .lock()
            .await
            .get_handle(runtime_id)
            .is_some();
        if !is_live {
            return;
        }
        match self.assemble_spawn_runtime_env_for_worktree(worktree, workspace_id) {
            Ok(runtime_env) => {
                if let Err(e) = self
                    .agents
                    .lock()
                    .await
                    .refresh_agent_runtime_env(runtime_id, runtime_env)
                    .await
                {
                    tracing::warn!(
                        runtime_id,
                        worktree,
                        error = %e,
                        "refresh_live_runtime_env failed"
                    );
                }
            }
            Err(e) => {
                tracing::warn!(
                    runtime_id,
                    worktree,
                    error = %e,
                    "refresh_live_runtime_env: assemble runtime env failed"
                );
            }
        }
    }
}
