use std::path::Path;

use crate::team_shared_env;

use super::SpawnRuntimeEnv;

/// Assemble personal + team + system env and resolve `${KEY}` placeholders in
/// `opencode.json` before attaching an ACP host.
pub fn assemble_spawn_runtime_env(
    workspace_root: &Path,
    team_id: Option<&str>,
    device_id: &str,
    device_name: &str,
) -> anyhow::Result<SpawnRuntimeEnv> {
    let team_env = team_shared_env::load_team_env_for_workspace(workspace_root, team_id);
    let bundle = teamclaw_runtime_env::assemble_runtime_env(
        workspace_root,
        team_env,
        teamclaw_runtime_env::SystemEnvContext {
            device_id: device_id.to_string(),
            device_name: device_name.to_string(),
        },
    )?;
    Ok(SpawnRuntimeEnv {
        extra_env: bundle.extra_env,
        force_env_override: true,
        opencode_json_original: bundle.opencode_json_original,
    })
}
