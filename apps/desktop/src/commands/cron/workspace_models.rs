//! Resolve cron job model overrides against the workspace's current LLM config
//! via the daemon workspace-control API (`GET /v1/workspaces/:id/providers`).

use std::collections::HashSet;

use teamclaw_gateway::parse_model_preference;

/// Daemon default workspace path from `~/.amuxd/workspaces.toml` (global cron runs here).
pub fn default_daemon_workspace_path() -> Option<String> {
    let path = dirs::home_dir()?.join(".amuxd").join("workspaces.toml");
    let content = std::fs::read_to_string(&path).ok()?;
    let table: toml::Table = toml::from_str(&content).ok()?;
    let default_id = table.get("default_workspace_id")?.as_str()?;
    let workspaces = table.get("workspaces")?.as_array()?;
    for entry in workspaces {
        let row = entry.as_table()?;
        if row.get("workspace_id")?.as_str()? == default_id {
            return row.get("path")?.as_str().map(str::to_string);
        }
    }
    None
}

/// Load valid model refs across every configured backend from the daemon's
/// model-catalog API. Covers OpenCode, Claude Code, and Codex, so a cron job
/// pinning a Claude/Codex model validates correctly (the OpenCode-only provider
/// list used previously rejected those as "stale").
pub async fn list_workspace_model_keys(workspace_path: &str) -> HashSet<String> {
    crate::commands::daemon_http::fetch_workspace_model_catalog_keys(workspace_path)
        .await
        .unwrap_or_default()
}

/// Resolve a cron job's stored model preference for a workspace run.
///
/// Returns `None` when the job uses the workspace default (empty preference) or
/// when the stored pair is no longer advertised by the daemon for that workspace.
pub fn resolve_cron_model_override(
    available: &HashSet<String>,
    workspace_path: Option<&str>,
    job_model: Option<&str>,
) -> Option<(String, String)> {
    let pref = job_model.map(str::trim).filter(|s| !s.is_empty())?;
    let (provider, model) = parse_model_preference(pref)?;

    if available.is_empty() {
        // Daemon unreachable or no providers — pass through; runtime may still apply default.
        return Some((provider, model));
    }

    let key = format!("{}/{}", provider.to_lowercase(), model.to_lowercase());
    if available.contains(&key) {
        Some((provider, model))
    } else {
        if let Some(path) = workspace_path.filter(|p| !p.is_empty()) {
            println!(
                "[Cron] Model '{pref}' is not in daemon providers for {path}; using workspace default"
            );
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_rejects_stale_model() {
        let mut available = HashSet::new();
        available.insert("anthropic/claude-sonnet-4-6".into());
        let out = resolve_cron_model_override(&available, Some("/ws"), Some("scnet/MiniMax-M2.5"));
        assert!(out.is_none());
    }

    #[test]
    fn resolve_accepts_configured_model() {
        let mut available = HashSet::new();
        available.insert("scnet/minimax-m2.5".into());
        let out = resolve_cron_model_override(&available, Some("/ws"), Some("scnet/MiniMax-M2.5"));
        assert_eq!(out, Some(("scnet".into(), "MiniMax-M2.5".into())));
    }

    #[test]
    fn empty_job_model_uses_default() {
        let available = HashSet::from(["openai/gpt-4".into()]);
        assert!(resolve_cron_model_override(&available, Some("/ws"), None).is_none());
        assert!(resolve_cron_model_override(&available, Some("/ws"), Some("")).is_none());
    }
}
