use std::path::PathBuf;

use serde::{Deserialize, Serialize};

const APP_CONFIG_DIR: &str = "teamclaw";
const LEGACY_CONFIG_DIR: &str = "amux";
const SERVER_CONFIG_FILE: &str = "teamclaw.json";
const LEGACY_SERVER_CONFIG_FILE: &str = "server-config.json";
const DEFAULT_SUPABASE_URL: &str = "https://srhaytajyfrniuvnkfpd.supabase.co";
const DEFAULT_SUPABASE_ANON_KEY: &str = "sb_publishable_CJavqYCusEBD7cIebhH5tQ_K_I9AXpE";
const DEFAULT_MQTT_HOST: &str = "ai.ucar.cc";
const DEFAULT_MQTT_PORT: u16 = 8883;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerConfig {
    #[serde(default)]
    pub supabase_url: Option<String>,
    #[serde(default)]
    pub supabase_anon_key: Option<String>,
    #[serde(default)]
    pub mqtt_host: Option<String>,
    #[serde(default)]
    pub mqtt_port: Option<u16>,
}

fn config_base_dir() -> PathBuf {
    dirs::config_dir().unwrap_or_else(|| PathBuf::from("/tmp"))
}

fn config_path_for(base_dir: PathBuf, app_dir: &str) -> PathBuf {
    base_dir.join(app_dir).join(SERVER_CONFIG_FILE)
}

fn legacy_config_path_for(base_dir: PathBuf, app_dir: &str) -> PathBuf {
    base_dir.join(app_dir).join(LEGACY_SERVER_CONFIG_FILE)
}

fn config_path() -> PathBuf {
    config_path_for(config_base_dir(), APP_CONFIG_DIR)
}

fn legacy_config_path() -> PathBuf {
    legacy_config_path_for(config_base_dir(), LEGACY_CONFIG_DIR)
}

fn legacy_teamclaw_config_path() -> PathBuf {
    legacy_config_path_for(config_base_dir(), APP_CONFIG_DIR)
}

fn default_server_config() -> ServerConfig {
    ServerConfig {
        supabase_url: Some(DEFAULT_SUPABASE_URL.to_string()),
        supabase_anon_key: Some(DEFAULT_SUPABASE_ANON_KEY.to_string()),
        mqtt_host: Some(DEFAULT_MQTT_HOST.to_string()),
        mqtt_port: Some(DEFAULT_MQTT_PORT),
    }
}

fn merge_with_defaults(mut config: ServerConfig) -> ServerConfig {
    let defaults = default_server_config();

    if config
        .supabase_url
        .as_deref()
        .unwrap_or("")
        .trim()
        .is_empty()
    {
        config.supabase_url = defaults.supabase_url;
    }
    if config
        .supabase_anon_key
        .as_deref()
        .unwrap_or("")
        .trim()
        .is_empty()
    {
        config.supabase_anon_key = defaults.supabase_anon_key;
    }
    if config.mqtt_host.as_deref().unwrap_or("").trim().is_empty() {
        config.mqtt_host = defaults.mqtt_host;
    }
    if config.mqtt_port.is_none() {
        config.mqtt_port = defaults.mqtt_port;
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
        vec![legacy_teamclaw_config_path(), legacy_config_path()],
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
        vec![legacy_teamclaw_config_path(), legacy_config_path()],
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
            supabase_url: Some("https://project.supabase.co".to_string()),
            supabase_anon_key: Some("anon-key".to_string()),
            mqtt_host: Some("mqtt.example.com".to_string()),
            mqtt_port: Some(1883),
        }
    }

    #[test]
    fn uses_teamclaw_config_directory() {
        let path = config_path_for(PathBuf::from("/tmp/config"), APP_CONFIG_DIR);
        assert_eq!(
            path,
            PathBuf::from("/tmp/config")
                .join("teamclaw")
                .join("teamclaw.json")
        );
    }

    #[test]
    fn migrates_legacy_amux_config_when_teamclaw_config_is_missing() {
        let temp = tempfile::tempdir().unwrap();
        let current = temp.path().join("teamclaw").join(SERVER_CONFIG_FILE);
        let legacy = temp.path().join("amux").join(LEGACY_SERVER_CONFIG_FILE);
        let legacy_config = sample_config();
        write_config_file(&legacy, &legacy_config).unwrap();

        let loaded = load_config_from_paths(current.clone(), vec![legacy])
            .unwrap()
            .unwrap();

        assert_eq!(loaded.supabase_url, legacy_config.supabase_url);
        assert!(current.exists());
        let migrated = read_config_file(&current).unwrap();
        assert_eq!(migrated.mqtt_host, legacy_config.mqtt_host);
    }

    #[test]
    fn writes_default_config_when_no_user_config_exists() {
        let temp = tempfile::tempdir().unwrap();
        let current = temp.path().join("teamclaw").join(SERVER_CONFIG_FILE);

        let loaded = load_config_from_paths(current.clone(), vec![])
            .unwrap()
            .unwrap();

        assert_eq!(loaded.supabase_url.as_deref(), Some(DEFAULT_SUPABASE_URL));
        assert_eq!(loaded.mqtt_host.as_deref(), Some(DEFAULT_MQTT_HOST));
        assert_eq!(loaded.mqtt_port, Some(DEFAULT_MQTT_PORT));
        assert!(current.exists());
    }

    #[test]
    fn fills_missing_fields_without_overwriting_custom_values() {
        let temp = tempfile::tempdir().unwrap();
        let current = temp.path().join("teamclaw").join(SERVER_CONFIG_FILE);
        write_config_file(
            &current,
            &ServerConfig {
                supabase_url: Some("https://custom.supabase.co".to_string()),
                supabase_anon_key: None,
                mqtt_host: None,
                mqtt_port: Some(1883),
            },
        )
        .unwrap();

        let loaded = load_config_from_paths(current.clone(), vec![])
            .unwrap()
            .unwrap();

        assert_eq!(
            loaded.supabase_url.as_deref(),
            Some("https://custom.supabase.co")
        );
        assert_eq!(
            loaded.supabase_anon_key.as_deref(),
            Some(DEFAULT_SUPABASE_ANON_KEY)
        );
        assert_eq!(loaded.mqtt_host.as_deref(), Some(DEFAULT_MQTT_HOST));
        assert_eq!(loaded.mqtt_port, Some(1883));
    }
}
