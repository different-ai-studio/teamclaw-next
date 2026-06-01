use std::path::PathBuf;

use serde::{Deserialize, Serialize};

const APP_CONFIG_DIR: &str = ".teamclaw";
const LEGACY_CONFIG_DIR: &str = "amux";
const SERVER_CONFIG_FILE: &str = "config.json";
const LEGACY_TEAMCLAW_CONFIG_FILE: &str = "teamclaw.json";
const LEGACY_SERVER_CONFIG_FILE: &str = "server-config.json";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerConfig {
    #[serde(default)]
    pub backend_kind: Option<String>,
    #[serde(default)]
    pub cloud_api_url: Option<String>,
    #[serde(default)]
    pub mqtt_host: Option<String>,
    #[serde(default)]
    pub mqtt_port: Option<u16>,
    #[serde(default)]
    pub mqtt_use_tls: Option<bool>,
    #[serde(default)]
    pub mqtt_username: Option<String>,
    #[serde(default)]
    pub mqtt_password: Option<String>,
}

fn config_base_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/tmp"))
}

fn legacy_config_base_dir() -> PathBuf {
    dirs::config_dir().unwrap_or_else(|| PathBuf::from("/tmp"))
}

fn config_path_for(base_dir: PathBuf, app_dir: &str) -> PathBuf {
    base_dir.join(app_dir).join(SERVER_CONFIG_FILE)
}

fn legacy_config_path_for(base_dir: PathBuf, app_dir: &str) -> PathBuf {
    base_dir.join(app_dir).join(LEGACY_SERVER_CONFIG_FILE)
}

fn legacy_named_config_path_for(base_dir: PathBuf, app_dir: &str, file_name: &str) -> PathBuf {
    base_dir.join(app_dir).join(file_name)
}

fn config_path() -> PathBuf {
    config_path_for(config_base_dir(), APP_CONFIG_DIR)
}

fn legacy_config_path() -> PathBuf {
    legacy_config_path_for(legacy_config_base_dir(), LEGACY_CONFIG_DIR)
}

fn legacy_teamclaw_config_path() -> PathBuf {
    legacy_config_path_for(legacy_config_base_dir(), "teamclaw")
}

fn legacy_teamclaw_json_path() -> PathBuf {
    legacy_named_config_path_for(
        legacy_config_base_dir(),
        "teamclaw",
        LEGACY_TEAMCLAW_CONFIG_FILE,
    )
}

const DEFAULT_CLOUD_API_URL: &str = "https://cloud.ucar.cc";

fn default_server_config() -> ServerConfig {
    // MQTT is delivered by the Cloud API (`/v1/config/bootstrap`, applied after
    // sign-in), never hardcoded. Only the fields needed to *reach* the Cloud API
    // have defaults here. `cloud_api_url` is the bootstrap of the bootstrap.
    ServerConfig {
        backend_kind: Some("cloud_api".to_string()),
        cloud_api_url: Some(DEFAULT_CLOUD_API_URL.to_string()),
        mqtt_host: None,
        mqtt_port: None,
        mqtt_use_tls: None,
        mqtt_username: None,
        mqtt_password: None,
    }
}

fn merge_with_defaults(mut config: ServerConfig) -> ServerConfig {
    let defaults = default_server_config();

    if config
        .backend_kind
        .as_deref()
        .unwrap_or("")
        .trim()
        .is_empty()
    {
        config.backend_kind = defaults.backend_kind;
    }
    if config
        .cloud_api_url
        .as_deref()
        .unwrap_or("")
        .trim()
        .is_empty()
    {
        // Fill the canonical production URL when no override is set.
        config.cloud_api_url = defaults.cloud_api_url;
    }
    // MQTT host/port/tls are intentionally NOT defaulted here: they are
    // delivered by the Cloud API bootstrap after sign-in. A blank value stays
    // blank so the client surfaces "MQTT 未配置" rather than a stale default.
    if config
        .mqtt_username
        .as_deref()
        .unwrap_or("")
        .trim()
        .is_empty()
    {
        config.mqtt_username = None;
    }
    if config
        .mqtt_password
        .as_deref()
        .unwrap_or("")
        .trim()
        .is_empty()
    {
        config.mqtt_password = None;
    }

    config
}

fn read_config_file(path: &PathBuf) -> Result<ServerConfig, String> {
    let content =
        std::fs::read_to_string(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    serde_json::from_str(&content).map_err(|e| format!("parse {}: {e}", path.display()))
}

fn write_config_file(path: &PathBuf, config: &ServerConfig) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }

    let content = serde_json::to_string_pretty(config)
        .map_err(|e| format!("serialize server config: {e}"))?;
    std::fs::write(path, content).map_err(|e| format!("write {}: {e}", path.display()))
}

fn load_config_from_paths(
    current_path: PathBuf,
    legacy_paths: Vec<PathBuf>,
) -> Result<Option<ServerConfig>, String> {
    if current_path.exists() {
        let config = merge_with_defaults(read_config_file(&current_path)?);
        write_config_file(&current_path, &config)?;
        return Ok(Some(config));
    }

    for legacy_path in legacy_paths {
        if !legacy_path.exists() {
            continue;
        }
        let config = merge_with_defaults(read_config_file(&legacy_path)?);
        write_config_file(&current_path, &config)?;
        return Ok(Some(config));
    }

    let config = default_server_config();
    write_config_file(&current_path, &config)?;
    Ok(Some(config))
}

pub fn server_config_initialization_script() -> String {
    let Some(config) = load_config_from_paths(
        config_path(),
        vec![
            legacy_teamclaw_json_path(),
            legacy_teamclaw_config_path(),
            legacy_config_path(),
        ],
    )
    .map_err(|e| eprintln!("[ServerConfig] Failed to load startup config: {e}"))
    .ok()
    .flatten() else {
        return String::new();
    };

    let Ok(json) = serde_json::to_string(&config) else {
        return String::new();
    };

    format!(
        r#"
;(function () {{
  var config = {json};
  window.__TEAMCLAW_SERVER_CONFIG__ = config;
  try {{
    window.localStorage.setItem("teamclaw.serverConfig", JSON.stringify(config));
  }} catch (_) {{}}
}})();
"#
    )
}

#[tauri::command]
pub fn get_server_config() -> Result<ServerConfig, String> {
    load_config_from_paths(
        config_path(),
        vec![
            legacy_teamclaw_json_path(),
            legacy_teamclaw_config_path(),
            legacy_config_path(),
        ],
    )
    .map(|config| config.unwrap_or_default())
}

#[tauri::command]
pub fn save_server_config(config: ServerConfig) -> Result<ServerConfig, String> {
    let path = config_path();
    let config = merge_with_defaults(config);
    write_config_file(&path, &config)?;
    Ok(config)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_config() -> ServerConfig {
        ServerConfig {
            backend_kind: Some("cloud_api".to_string()),
            cloud_api_url: Some("https://fc.example.com".to_string()),
            mqtt_host: Some("mqtt.example.com".to_string()),
            mqtt_port: Some(1883),
            mqtt_use_tls: Some(false),
            mqtt_username: Some("mqtt-user".to_string()),
            mqtt_password: Some("mqtt-password".to_string()),
        }
    }

    #[test]
    fn uses_teamclaw_config_directory() {
        let path = config_path_for(PathBuf::from("/tmp/config"), APP_CONFIG_DIR);
        assert_eq!(
            path,
            PathBuf::from("/tmp/config")
                .join(".teamclaw")
                .join("config.json")
        );
    }

    #[test]
    fn migrates_legacy_amux_config_when_teamclaw_config_is_missing() {
        let temp = tempfile::tempdir().unwrap();
        let current = temp.path().join(".teamclaw").join(SERVER_CONFIG_FILE);
        let legacy = temp.path().join("amux").join(LEGACY_SERVER_CONFIG_FILE);
        let legacy_config = sample_config();
        write_config_file(&legacy, &legacy_config).unwrap();

        let loaded = load_config_from_paths(current.clone(), vec![legacy])
            .unwrap()
            .unwrap();

        assert_eq!(loaded.cloud_api_url, legacy_config.cloud_api_url);
        assert!(current.exists());
        let migrated = read_config_file(&current).unwrap();
        assert_eq!(migrated.mqtt_host, legacy_config.mqtt_host);
    }

    #[test]
    fn writes_default_config_when_no_user_config_exists() {
        let temp = tempfile::tempdir().unwrap();
        let current = temp.path().join(".teamclaw").join(SERVER_CONFIG_FILE);

        let loaded = load_config_from_paths(current.clone(), vec![])
            .unwrap()
            .unwrap();

        // Only Cloud-API-reachability fields are defaulted. MQTT is delivered by
        // the Cloud API bootstrap after sign-in, never hardcoded here.
        assert_eq!(loaded.backend_kind.as_deref(), Some("cloud_api"));
        assert_eq!(loaded.cloud_api_url.as_deref(), Some(DEFAULT_CLOUD_API_URL));
        assert_eq!(loaded.mqtt_host, None);
        assert_eq!(loaded.mqtt_port, None);
        assert_eq!(loaded.mqtt_use_tls, None);
        assert!(current.exists());
    }

    #[test]
    fn preserves_cloud_api_provider_fields() {
        let config = merge_with_defaults(ServerConfig {
            backend_kind: Some("cloud_api".to_string()),
            cloud_api_url: Some("https://fc.example.com".to_string()),
            mqtt_host: Some("mqtt.example.com".to_string()),
            mqtt_port: Some(1883),
            mqtt_use_tls: Some(false),
            mqtt_username: None,
            mqtt_password: None,
        });

        assert_eq!(config.backend_kind.as_deref(), Some("cloud_api"));
        assert_eq!(
            config.cloud_api_url.as_deref(),
            Some("https://fc.example.com")
        );
    }
}
