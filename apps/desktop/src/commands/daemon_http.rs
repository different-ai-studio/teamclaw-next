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
                .map(|id| {
                    id == workspace.workspace_id || id == workspace.remote_workspace_id
                })
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
