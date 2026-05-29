//! Tauri commands that let the frontend discover the daemon's local HTTP server.
//!
//! The daemon writes two runtime files when it starts its HTTP listener:
//! - `~/.amuxd/amuxd.http.port`  — the bound TCP port (decimal)
//! - `~/.amuxd/amuxd.http.token` — the root bearer token
//!
//! The desktop reads both and returns them to the frontend webview so it can
//! build authenticated requests against `http://127.0.0.1:{port}/v1/*`.

use serde::Serialize;

/// Connection information for the daemon's local HTTP server.
#[derive(Debug, Serialize)]
pub struct DaemonHttpInfo {
    /// e.g. `"http://127.0.0.1:52341"`
    pub base_url: String,
    /// Root bearer token. The frontend should exchange this immediately via
    /// `POST /v1/auth/exchange` to obtain a scoped session token.
    pub root_token: String,
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
