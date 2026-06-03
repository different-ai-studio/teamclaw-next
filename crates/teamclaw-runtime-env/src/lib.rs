pub mod env_catalog;
pub mod mcp_resolve;
pub mod merge;
pub mod opencode_db;
pub mod personal_secrets;
pub mod team_provider;

#[cfg(test)]
pub mod test_util;

use std::collections::HashMap;
use std::path::Path;

pub const APP_SECRETS_DIR: &str = "teamclaw";
pub const DEFAULT_TEAM_REPO_DIR: &str = "teamclaw-team";

#[derive(Debug, Clone, Default)]
pub struct RuntimeEnvBundle {
    pub extra_env: HashMap<String, String>,
    pub opencode_json_original: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SystemEnvContext {
    pub actor_id: String,
    pub display_name: String,
}

pub fn assemble_runtime_env(
    workspace: &Path,
    team_env: HashMap<String, String>,
    system: SystemEnvContext,
) -> anyhow::Result<RuntimeEnvBundle> {
    opencode_db::maybe_migrate_legacy_opencode_db(workspace)?;
    team_provider::ensure_team_provider(workspace)?;

    let personal = personal_secrets::load_personal_env()?;
    let merged = merge::merge_env_maps(personal, team_env, &system);
    let opencode_json_original =
        mcp_resolve::resolve_config_secret_refs(workspace, &merged)?;
    Ok(RuntimeEnvBundle {
        extra_env: merged,
        opencode_json_original,
    })
}
