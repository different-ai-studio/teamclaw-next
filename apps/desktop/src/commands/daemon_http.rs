//! Tauri commands that let the frontend discover the daemon's local HTTP server.
//!
//! The daemon writes two runtime files when it starts its HTTP listener:
//! - `~/.amuxd/amuxd.http.port`  — the bound TCP port (decimal)
//! - `~/.amuxd/amuxd.http.token` — the root bearer token
//!
//! The desktop reads both and returns them to the frontend webview so it can
//! build authenticated requests against `http://127.0.0.1:{port}/v1/*`.

use serde::{Deserialize, Serialize};

/// Connection information for the daemon's local HTTP server.
#[derive(Debug, Serialize)]
pub struct DaemonHttpInfo {
    /// e.g. `"http://127.0.0.1:52341"`
    pub base_url: String,
    /// Root bearer token. The frontend should exchange this immediately via
    /// `POST /v1/auth/exchange` to obtain a scoped session token.
    pub root_token: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalDaemonWorkspace {
    pub workspace_id: String,
    pub remote_workspace_id: String,
    pub path: String,
    pub display_name: String,
    pub team_id: Option<String>,
    pub is_default: bool,
}

#[derive(Debug, Deserialize)]
struct LocalDaemonWorkspaceStore {
    #[serde(default)]
    default_workspace_id: Option<String>,
    #[serde(default)]
    workspaces: Vec<LocalDaemonWorkspaceRecord>,
}

#[derive(Debug, Deserialize)]
struct LocalDaemonWorkspaceRecord {
    workspace_id: String,
    #[serde(default)]
    remote_workspace_id: String,
    path: String,
    display_name: String,
    #[serde(default)]
    team_id: Option<String>,
}

/// Return the daemon HTTP base URL and root token, or `None` if the daemon is
/// not running or has not started its HTTP listener yet.
#[tauri::command]
pub async fn get_daemon_http_info() -> Result<Option<DaemonHttpInfo>, String> {
    let amuxd_dir = dirs::home_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("/tmp"))
        .join(".amuxd");

    let port_path = amuxd_dir.join("amuxd.http.port");
    let token_path = amuxd_dir.join("amuxd.http.token");

    let port_str = match std::fs::read_to_string(&port_path) {
        Ok(s) => s.trim().to_owned(),
        Err(_) => return Ok(None),
    };
    let port: u16 = match port_str.parse() {
        Ok(p) => p,
        Err(_) => return Ok(None),
    };

    let root_token = match std::fs::read_to_string(&token_path) {
        Ok(s) => s.trim().to_owned(),
        Err(_) => return Ok(None),
    };

    Ok(Some(DaemonHttpInfo {
        base_url: format!("http://127.0.0.1:{port}"),
        root_token,
    }))
}

/// Minimal view of `~/.amuxd/daemon.toml` — just the field we surface.
#[derive(Debug, serde::Deserialize)]
struct DaemonConfigTeam {
    #[serde(default)]
    team_id: Option<String>,
}

/// The team this machine's daemon is onboarded to, read from
/// `~/.amuxd/daemon.toml`. `None` when the daemon hasn't been onboarded (no
/// config / no team_id) or the file can't be read.
///
/// The daemon is single-team: its `team_id` is set once at `amuxd init` and is
/// independent of whichever team the app currently has selected. The settings
/// UI compares the two and warns the user when they diverge, since team-share
/// content is synced/linked under the daemon's team, not the app's.
#[tauri::command]
pub async fn get_daemon_team_id() -> Result<Option<String>, String> {
    let config_path = dirs::home_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("/tmp"))
        .join(".amuxd")
        .join("daemon.toml");

    let body = match std::fs::read_to_string(&config_path) {
        Ok(s) => s,
        Err(_) => return Ok(None),
    };
    let parsed: DaemonConfigTeam = toml::from_str(&body).map_err(|e| e.to_string())?;
    Ok(parsed
        .team_id
        .map(|t| t.trim().to_owned())
        .filter(|t| !t.is_empty()))
}

/// Minimal view of `~/.amuxd/backend.toml` — just the actor_id field.
#[derive(Debug, serde::Deserialize)]
struct BackendCloudApi {
    #[serde(default)]
    actor_id: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
struct BackendConfig {
    #[serde(default)]
    cloud_api: Option<BackendCloudApi>,
}

/// The daemon's actor_id, read from `~/.amuxd/backend.toml` (`[cloud_api]
/// actor_id`). This is the single routing identity persisted by `amuxd init`.
/// Returns an empty string when the daemon hasn't been onboarded (no config /
/// no actor_id) or the file can't be read — callers treat empty as "not ready".
pub(crate) fn read_daemon_actor_id() -> String {
    let config_path = dirs::home_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("/tmp"))
        .join(".amuxd")
        .join("backend.toml");

    let body = match std::fs::read_to_string(&config_path) {
        Ok(s) => s,
        Err(_) => return String::new(),
    };
    let parsed: BackendConfig = match toml::from_str(&body) {
        Ok(c) => c,
        Err(_) => return String::new(),
    };
    parsed
        .cloud_api
        .and_then(|c| c.actor_id)
        .map(|a| a.trim().to_owned())
        .unwrap_or_default()
}

/// Return the daemon's local workspace registry from `~/.amuxd/workspaces.toml`.
///
/// This is intentionally local state, not cloud `public.workspaces`: cron runs
/// on the local daemon and must use the same workspace paths the daemon will use.
#[tauri::command]
pub async fn list_local_daemon_workspaces() -> Result<Vec<LocalDaemonWorkspace>, String> {
    let path = dirs::home_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("/tmp"))
        .join(".amuxd")
        .join("workspaces.toml");

    let body = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return Ok(vec![]),
    };
    let parsed: LocalDaemonWorkspaceStore = toml::from_str(&body).map_err(|e| e.to_string())?;
    let default_id = parsed.default_workspace_id.as_deref();

    Ok(parsed
        .workspaces
        .into_iter()
        .map(|workspace| {
            let is_default = default_id
                .map(|id| id == workspace.workspace_id || id == workspace.remote_workspace_id)
                .unwrap_or(false);
            LocalDaemonWorkspace {
                workspace_id: workspace.workspace_id,
                remote_workspace_id: workspace.remote_workspace_id,
                path: workspace.path,
                display_name: workspace.display_name,
                team_id: workspace.team_id,
                is_default,
            }
        })
        .collect())
}

fn encode_workspace_id(workspace_path: &str) -> String {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    URL_SAFE_NO_PAD.encode(workspace_path.as_bytes())
}

#[derive(Debug, Deserialize)]
struct DaemonAuthExchangeResponse {
    token: String,
}

#[derive(Debug, Deserialize)]
struct DaemonProviderInfo {
    id: String,
    #[serde(default)]
    models: Vec<String>,
}

/// `GET /v1/workspaces/:id/providers` — canonical LLM provider list for a workspace.
pub async fn fetch_workspace_provider_model_keys(
    workspace_path: &str,
) -> Option<std::collections::HashSet<String>> {
    let amuxd_dir = dirs::home_dir()?.join(".amuxd");
    let port: u16 = std::fs::read_to_string(amuxd_dir.join("amuxd.http.port"))
        .ok()?
        .trim()
        .parse()
        .ok()?;
    let root_token = std::fs::read_to_string(amuxd_dir.join("amuxd.http.token"))
        .ok()?
        .trim()
        .to_string();
    let base = format!("http://127.0.0.1:{port}");
    let client = reqwest::Client::new();

    let exchange: DaemonAuthExchangeResponse = client
        .post(format!("{base}/v1/auth/exchange"))
        .header("Authorization", format!("Bearer {root_token}"))
        .json(&serde_json::json!({
            "scopes": ["workspace:read"],
            "ttl_seconds": 300,
        }))
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .json()
        .await
        .ok()?;

    let ws_id = encode_workspace_id(workspace_path);
    let providers: Vec<DaemonProviderInfo> = client
        .get(format!("{base}/v1/workspaces/{ws_id}/providers"))
        .header("Authorization", format!("Bearer {}", exchange.token))
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .json()
        .await
        .ok()?;

    let mut keys = std::collections::HashSet::new();
    for provider in providers {
        for model_id in provider.models {
            keys.insert(format!(
                "{}/{}",
                provider.id.to_lowercase(),
                model_id.to_lowercase()
            ));
        }
    }
    Some(keys)
}

#[derive(Debug, Deserialize)]
struct DaemonCatalogModel {
    #[serde(rename = "ref")]
    model_ref: String,
}

#[derive(Debug, Deserialize)]
struct DaemonBackendCatalog {
    #[serde(default)]
    models: Vec<DaemonCatalogModel>,
}

#[derive(Debug, Deserialize)]
struct DaemonModelCatalog {
    #[serde(default)]
    backends: Vec<DaemonBackendCatalog>,
}

/// `GET /v1/workspaces/:id/model-catalog` — model refs across every configured
/// backend (OpenCode, Claude Code, Codex), lowercased for case-insensitive
/// validation. Unlike `fetch_workspace_provider_model_keys` (OpenCode only)
/// this is the source of truth for cron model validation, since a cron job may
/// pin a Claude or Codex model that the OpenCode provider list never reports.
pub async fn fetch_workspace_model_catalog_keys(
    workspace_path: &str,
) -> Option<std::collections::HashSet<String>> {
    let amuxd_dir = dirs::home_dir()?.join(".amuxd");
    let port: u16 = std::fs::read_to_string(amuxd_dir.join("amuxd.http.port"))
        .ok()?
        .trim()
        .parse()
        .ok()?;
    let root_token = std::fs::read_to_string(amuxd_dir.join("amuxd.http.token"))
        .ok()?
        .trim()
        .to_string();
    let base = format!("http://127.0.0.1:{port}");
    let client = reqwest::Client::new();

    let exchange: DaemonAuthExchangeResponse = client
        .post(format!("{base}/v1/auth/exchange"))
        .header("Authorization", format!("Bearer {root_token}"))
        .json(&serde_json::json!({
            "scopes": ["workspace:read"],
            "ttl_seconds": 300,
        }))
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .json()
        .await
        .ok()?;

    let ws_id = encode_workspace_id(workspace_path);
    let catalog: DaemonModelCatalog = client
        .get(format!("{base}/v1/workspaces/{ws_id}/model-catalog"))
        .header("Authorization", format!("Bearer {}", exchange.token))
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .json()
        .await
        .ok()?;

    let mut keys = std::collections::HashSet::new();
    for backend in catalog.backends {
        for model in backend.models {
            keys.insert(model.model_ref.to_lowercase());
        }
    }
    Some(keys)
}
