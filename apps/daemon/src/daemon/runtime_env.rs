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
            &self.config.actor.id,
            &self.config.actor.name,
        )
        .map_err(|e| e.to_string())
    }
}
