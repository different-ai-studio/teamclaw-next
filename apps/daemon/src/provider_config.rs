use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderKind {
    CloudApi,
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
    CloudApi(CloudApiConfig),
}

impl ProviderConfig {
    pub fn kind(&self) -> ProviderKind {
        match self {
            ProviderConfig::CloudApi(_) => ProviderKind::CloudApi,
        }
    }

    pub fn default_path() -> Result<PathBuf, ProviderConfigError> {
        let dir = dirs::home_dir()
            .ok_or_else(|| ProviderConfigError::Config("no home dir".to_string()))?
            .join(".amuxd");
        Ok(dir.join("backend.toml"))
    }

    pub fn load_from_path(backend_path: &Path) -> Result<Self, ProviderConfigError> {
        if !backend_path.exists() {
            return Err(ProviderConfigError::Config(format!(
                "backend.toml not found at {}",
                backend_path.display()
            )));
        }
        Self::load_backend_toml(backend_path)
    }

    fn load_backend_toml(path: &Path) -> Result<Self, ProviderConfigError> {
        let text = std::fs::read_to_string(path)?;
        let file: BackendConfigFile = toml::from_str(&text)?;
        match file.kind.as_str() {
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

        let loaded = ProviderConfig::load_from_path(&backend_path).unwrap();

        assert_eq!(loaded.kind(), ProviderKind::CloudApi);
        let ProviderConfig::CloudApi(config) = loaded;
        assert_eq!(config.url, "https://fc.example.com");
        assert_eq!(config.refresh_token, "refresh");
        assert_eq!(config.team_id, "team-1");
        assert_eq!(config.actor_id, "agent-1");
    }

    #[test]
    fn rejects_missing_backend_toml() {
        let dir = tempfile::tempdir().unwrap();
        let backend_path = dir.path().join("backend.toml");
        let err = ProviderConfig::load_from_path(&backend_path).expect_err("missing should fail");
        assert!(err.to_string().contains("backend.toml not found"));
    }

    #[test]
    fn rejects_unknown_kind() {
        let dir = tempfile::tempdir().unwrap();
        let backend_path = dir.path().join("backend.toml");
        std::fs::write(&backend_path, r#"kind = "supabase""#).unwrap();
        let err = ProviderConfig::load_from_path(&backend_path)
            .expect_err("unknown kind should fail");
        assert!(err.to_string().contains("unsupported backend kind"));
    }
}
