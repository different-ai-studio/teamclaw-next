use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderKind {
    PocketBase,
    CloudApi,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PocketBaseConfig {
    pub url: String,
    pub refresh_token: String,
    pub team_id: String,
    pub actor_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CloudApiConfig {
    pub url: String,
    pub refresh_token: String,
    pub team_id: String,
    pub actor_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderConfig {
    PocketBase(PocketBaseConfig),
    CloudApi(CloudApiConfig),
}

impl ProviderConfig {
    pub fn kind(&self) -> ProviderKind {
        match self {
            ProviderConfig::PocketBase(_) => ProviderKind::PocketBase,
            ProviderConfig::CloudApi(_) => ProviderKind::CloudApi,
        }
    }

    pub fn default_path() -> Result<PathBuf, ProviderConfigError> {
        let dir = dirs::home_dir()
            .ok_or_else(|| ProviderConfigError::Config("no home dir".to_string()))?
            .join(".amuxd");
        Ok(dir.join("backend.toml"))
    }

    pub fn load_from_paths(backend_path: &Path) -> Result<Self, ProviderConfigError> {
        if backend_path.exists() {
            return Self::load_backend_toml(backend_path);
        }

        Err(ProviderConfigError::Config(format!(
            "backend.toml not found at {}",
            backend_path.display(),
        )))
    }

    fn load_backend_toml(path: &Path) -> Result<Self, ProviderConfigError> {
        let text = std::fs::read_to_string(path)?;
        let file: BackendConfigFile = toml::from_str(&text)?;
        match file.kind.as_str() {
            "supabase" => Err(ProviderConfigError::Config(
                "backend kind 'supabase' has been removed; rerun 'amuxd init <invite-url>' to regenerate backend.toml with kind = \"cloud_api\""
                    .to_string(),
            )),
            "pocketbase" => file
                .pocketbase
                .map(ProviderConfig::PocketBase)
                .ok_or_else(|| {
                    ProviderConfigError::Config(
                        "[pocketbase] section is required when kind = \"pocketbase\"".to_string(),
                    )
                }),
            "cloud_api" => file.cloud_api.map(ProviderConfig::CloudApi).ok_or_else(|| {
                ProviderConfigError::Config(
                    "[cloud_api] section is required when kind = \"cloud_api\"".to_string(),
                )
            }),
            other => Err(ProviderConfigError::Config(format!(
                "unsupported backend kind: {other}"
            ))),
        }
    }
}

#[derive(Debug, Deserialize)]
struct BackendConfigFile {
    kind: String,
    #[serde(default)]
    pocketbase: Option<PocketBaseConfig>,
    #[serde(default)]
    cloud_api: Option<CloudApiConfig>,
}

#[derive(Debug, thiserror::Error)]
pub enum ProviderConfigError {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("parse backend.toml: {0}")]
    Parse(#[from] toml::de::Error),
    #[error("provider config error: {0}")]
    Config(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_pocketbase_backend_toml() {
        let dir = tempfile::tempdir().unwrap();
        let backend_path = dir.path().join("backend.toml");
        std::fs::write(
            &backend_path,
            r#"
kind = "pocketbase"

[pocketbase]
url = "http://127.0.0.1:8090"
refresh_token = "pb-refresh"
team_id = "team-1"
actor_id = "agent-1"
"#,
        )
        .unwrap();

        let loaded = ProviderConfig::load_from_paths(&backend_path).unwrap();

        assert_eq!(loaded.kind(), ProviderKind::PocketBase);
        let ProviderConfig::PocketBase(config) = loaded else {
            panic!("expected pocketbase provider config");
        };
        assert_eq!(config.url, "http://127.0.0.1:8090");
        assert_eq!(config.refresh_token, "pb-refresh");
        assert_eq!(config.team_id, "team-1");
        assert_eq!(config.actor_id, "agent-1");
    }

    #[test]
    fn missing_backend_toml_returns_error() {
        let dir = tempfile::tempdir().unwrap();
        let backend_path = dir.path().join("backend.toml");

        let err = ProviderConfig::load_from_paths(&backend_path).expect_err("missing should fail");

        assert!(err.to_string().contains("backend.toml not found"));
    }

    #[test]
    fn supabase_kind_in_backend_toml_returns_actionable_error() {
        let dir = tempfile::tempdir().unwrap();
        let backend_path = dir.path().join("backend.toml");
        std::fs::write(
            &backend_path,
            r#"
kind = "supabase"

[supabase]
url = "https://project.supabase.co"
anon_key = "anon"
refresh_token = "refresh"
team_id = "team-1"
actor_id = "agent-1"
"#,
        )
        .unwrap();

        let err = ProviderConfig::load_from_paths(&backend_path)
            .expect_err("kind = supabase should fail");

        let msg = err.to_string();
        assert!(msg.contains("supabase"), "got: {msg}");
        assert!(msg.contains("amuxd init"), "got: {msg}");
    }

    #[test]
    fn rejects_pocketbase_kind_without_pocketbase_section() {
        let dir = tempfile::tempdir().unwrap();
        let backend_path = dir.path().join("backend.toml");
        std::fs::write(&backend_path, r#"kind = "pocketbase""#).unwrap();

        let err = ProviderConfig::load_from_paths(&backend_path)
            .expect_err("missing pocketbase section should fail");

        assert!(err.to_string().contains("[pocketbase]"));
    }

    #[test]
    fn loads_cloud_api_backend_toml() {
        let dir = tempfile::tempdir().unwrap();
        let backend_path = dir.path().join("backend.toml");
        std::fs::write(
            &backend_path,
            r#"
kind = "cloud_api"

[cloud_api]
url = "https://fc.example.com"
refresh_token = "refresh"
team_id = "team-1"
actor_id = "agent-1"
"#,
        )
        .unwrap();

        let loaded = ProviderConfig::load_from_paths(&backend_path).unwrap();

        assert_eq!(loaded.kind(), ProviderKind::CloudApi);
        let ProviderConfig::CloudApi(config) = loaded else {
            panic!("expected cloud api provider config");
        };
        assert_eq!(config.url, "https://fc.example.com");
        assert_eq!(config.refresh_token, "refresh");
        assert_eq!(config.team_id, "team-1");
        assert_eq!(config.actor_id, "agent-1");
    }
}
