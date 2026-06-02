use std::path::Path;

use tracing::info;

use crate::DEFAULT_TEAM_REPO_DIR;

const TEAMCLAW_DIR: &str = ".teamclaw";
const CONFIG_FILE_NAME: &str = "teamclaw.json";

fn opencode_config_path(workspace: &Path) -> std::path::PathBuf {
    workspace.join("opencode.json")
}

fn teamclaw_config_path(workspace: &Path) -> std::path::PathBuf {
    workspace.join(TEAMCLAW_DIR).join(CONFIG_FILE_NAME)
}

fn provider_meta_path(workspace: &Path, shared_dir_name: &str) -> std::path::PathBuf {
    workspace
        .join(shared_dir_name)
        .join("_meta")
        .join("provider.json")
}

/// Read `{workspace}/.teamclaw/teamclaw.json` → `team.sharedDirName`, or fall back to
/// [`DEFAULT_TEAM_REPO_DIR`].
pub fn resolve_shared_dir_name(workspace: &Path) -> String {
    let config_path = teamclaw_config_path(workspace);
    let content = match std::fs::read_to_string(&config_path) {
        Ok(content) => content,
        Err(_) => return DEFAULT_TEAM_REPO_DIR.to_string(),
    };
    let json: serde_json::Value = match serde_json::from_str(&content) {
        Ok(json) => json,
        Err(_) => return DEFAULT_TEAM_REPO_DIR.to_string(),
    };
    json.get("team")
        .and_then(|team| team.get("sharedDirName"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| DEFAULT_TEAM_REPO_DIR.to_string())
}

/// Reconcile `provider.team` in opencode.json against `{sharedDir}/_meta/provider.json`.
///
/// Sidecar startup is the only point where disk state is trusted enough to remove:
/// no in-flight git sync, no concurrent file readers, no UI race. So this is the only
/// path that DELETES `provider.team`. Runtime sync (frontend file-watcher etc.) only
/// adds; that protects against a transient `_meta/provider.json` miss yanking the
/// provider mid-session.
///
/// Behavior:
/// - `_meta/provider.json` exists, `opencode.json` lacks `provider.team` → ADD
/// - `_meta/provider.json` missing/invalid, `opencode.json` has `provider.team` → REMOVE
/// - Both present → leave existing entry alone (frontend owns field-level updates)
/// - Neither → no-op
pub fn ensure_team_provider(workspace: &Path) -> anyhow::Result<()> {
    let shared_dir_name = resolve_shared_dir_name(workspace);
    let config_path = opencode_config_path(workspace);
    let provider_meta_path = provider_meta_path(workspace, &shared_dir_name);

    let mut config: serde_json::Value = if config_path.exists() {
        let content = std::fs::read_to_string(&config_path)?;
        serde_json::from_str(&content)?
    } else {
        serde_json::json!({ "$schema": "https://opencode.ai/config.json" })
    };
    let obj = config
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("opencode.json root is not an object"))?;

    let provider_meta: Option<serde_json::Value> = if provider_meta_path.exists() {
        std::fs::read_to_string(&provider_meta_path)
            .ok()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
            .filter(|v| v.get("provider").and_then(|p| p.get("baseURL")).is_some())
    } else {
        None
    };

    let has_team_in_opencode = obj
        .get("provider")
        .and_then(|p| p.as_object())
        .map(|p| p.contains_key("team"))
        .unwrap_or(false);

    let mut changed = false;

    match (provider_meta, has_team_in_opencode) {
        // ADD: meta exists, opencode.json lacks the entry
        (Some(meta), false) => {
            let p = meta
                .get("provider")
                .ok_or_else(|| anyhow::anyhow!("provider field missing"))?;
            let name = p.get("name").and_then(|v| v.as_str()).unwrap_or("Team");
            let base_url = p
                .get("baseURL")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("provider.baseURL missing"))?;
            let api_key = p
                .get("apiKey")
                .and_then(|v| v.as_str())
                .unwrap_or("${tc_api_key}");
            let models_in = p
                .get("models")
                .and_then(|v| v.as_array())
                .ok_or_else(|| anyhow::anyhow!("provider.models missing or not an array"))?;

            let mut models_out = serde_json::Map::new();
            for m in models_in {
                let id = match m.get("id").and_then(|v| v.as_str()) {
                    Some(s) => s,
                    None => continue,
                };
                let mname = m.get("name").and_then(|v| v.as_str()).unwrap_or(id);
                models_out.insert(
                    id.to_string(),
                    serde_json::json!({
                        "name": mname,
                        "limit": { "context": 256000, "output": 16000 }
                    }),
                );
            }

            let providers = obj
                .entry("provider")
                .or_insert_with(|| serde_json::json!({}))
                .as_object_mut()
                .ok_or_else(|| anyhow::anyhow!("provider is not an object"))?;
            providers.insert(
                "team".to_string(),
                serde_json::json!({
                    "npm": "@ai-sdk/openai-compatible",
                    "name": name,
                    "options": { "baseURL": base_url, "apiKey": api_key },
                    "models": models_out,
                }),
            );
            changed = true;
            info!(
                path = %provider_meta_path.display(),
                "Added provider.team to opencode.json (synced from provider meta)"
            );
        }
        // REMOVE: meta missing, opencode.json still has stale entry
        (None, true) => {
            if let Some(providers) = obj.get_mut("provider").and_then(|p| p.as_object_mut()) {
                providers.remove("team");
                if providers.is_empty() {
                    obj.remove("provider");
                }
                changed = true;
                info!("Removed stale provider.team from opencode.json");
            }
        }
        // Both present: leave alone. Frontend owns field-level updates.
        // Neither: no-op.
        _ => {}
    }

    if changed {
        let mut new_content = serde_json::to_string_pretty(&config)?;
        if !new_content.ends_with('\n') {
            new_content.push('\n');
        }
        std::fs::write(&config_path, &new_content)?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn write_teamclaw_json(dir: &Path, shared_dir_name: Option<&str>) {
        let config_dir = dir.join(TEAMCLAW_DIR);
        fs::create_dir_all(&config_dir).unwrap();
        let json = match shared_dir_name {
            Some(name) => serde_json::json!({ "team": { "sharedDirName": name } }),
            None => serde_json::json!({ "team": {} }),
        };
        fs::write(
            config_dir.join(CONFIG_FILE_NAME),
            serde_json::to_string_pretty(&json).unwrap(),
        )
        .unwrap();
    }

    fn sample_provider_meta() -> serde_json::Value {
        serde_json::json!({
            "provider": {
                "name": "Team Gateway",
                "baseURL": "https://gateway.example/v1",
                "apiKey": "${tc_api_key}",
                "models": [
                    { "id": "gpt-4o", "name": "GPT-4o" },
                    { "id": "claude-sonnet", "name": "Claude Sonnet" }
                ]
            }
        })
    }

    fn write_provider_meta(workspace: &Path, shared_dir: &str) {
        let meta_dir = workspace.join(shared_dir).join("_meta");
        fs::create_dir_all(&meta_dir).unwrap();
        fs::write(
            meta_dir.join("provider.json"),
            serde_json::to_string_pretty(&sample_provider_meta()).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn resolve_shared_dir_name_reads_json_and_falls_back() {
        let dir = TempDir::new().unwrap();

        assert_eq!(
            resolve_shared_dir_name(dir.path()),
            DEFAULT_TEAM_REPO_DIR.to_string()
        );

        write_teamclaw_json(dir.path(), None);
        assert_eq!(
            resolve_shared_dir_name(dir.path()),
            DEFAULT_TEAM_REPO_DIR.to_string()
        );

        write_teamclaw_json(dir.path(), Some("custom-team-dir"));
        assert_eq!(
            resolve_shared_dir_name(dir.path()),
            "custom-team-dir".to_string()
        );
    }

    #[test]
    fn ensure_team_provider_adds_team_when_meta_exists() {
        let dir = TempDir::new().unwrap();
        write_teamclaw_json(dir.path(), Some("teamclaw-team"));
        write_provider_meta(dir.path(), "teamclaw-team");
        fs::write(
            dir.path().join("opencode.json"),
            r#"{"$schema":"https://opencode.ai/config.json"}"#,
        )
        .unwrap();

        ensure_team_provider(dir.path()).unwrap();

        let config: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.path().join("opencode.json")).unwrap())
                .unwrap();
        let team = config
            .get("provider")
            .and_then(|p| p.get("team"))
            .expect("provider.team should be added");
        assert_eq!(team.get("name").and_then(|v| v.as_str()), Some("Team Gateway"));
        assert_eq!(
            team.get("options")
                .and_then(|o| o.get("baseURL"))
                .and_then(|v| v.as_str()),
            Some("https://gateway.example/v1")
        );
        assert!(team.get("models").and_then(|m| m.get("gpt-4o")).is_some());
    }

    #[test]
    fn ensure_team_provider_removes_stale_team_when_meta_missing() {
        let dir = TempDir::new().unwrap();
        write_teamclaw_json(dir.path(), Some("teamclaw-team"));
        fs::write(
            dir.path().join("opencode.json"),
            r#"{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "team": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Stale Team",
      "options": { "baseURL": "https://old.example/v1", "apiKey": "secret" },
      "models": {}
    }
  }
}"#,
        )
        .unwrap();

        ensure_team_provider(dir.path()).unwrap();

        let config: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.path().join("opencode.json")).unwrap())
                .unwrap();
        assert!(config.get("provider").is_none());
    }
}
