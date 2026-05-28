use crate::supabase::SupabaseConfig;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderKind {
    Supabase,
    CloudApi,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CloudApiConfig {
    pub url: String,
    pub supabase_url: String,
    pub supabase_anon_key: String,
    pub refresh_token: String,
    pub team_id: String,
    pub actor_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderConfig {
    Supabase(SupabaseConfig),
    CloudApi(CloudApiConfig),
}

impl ProviderConfig {
    pub fn kind(&self) -> ProviderKind {
        match self {
            ProviderConfig::Supabase(_) => ProviderKind::Supabase,
            ProviderConfig::CloudApi(_) => ProviderKind::CloudApi,
        }
    }

    pub fn default_path() -> Result<PathBuf, ProviderConfigError> {
        let dir = dirs::home_dir()
            .ok_or_else(|| ProviderConfigError::Config("no home dir".to_string()))?
            .join(".amuxd");
        Ok(dir.join("backend.toml"))
    }

    pub fn load_from_paths(
        backend_path: &Path,
        legacy_supabase_path: &Path,
    ) -> Result<Self, ProviderConfigError> {
        if backend_path.exists() {
            return Self::load_backend_toml(backend_path);
        }

        if legacy_supabase_path.exists() {
            return SupabaseConfig::load(legacy_supabase_path)
                .map(ProviderConfig::Supabase)
                .map_err(|e| {
                    ProviderConfigError::Config(format!("read legacy supabase.toml: {e}"))
                });
        }

        Err(ProviderConfigError::Config(format!(
            "backend.toml not found at {} and supabase.toml not found at {}",
            backend_path.display(),
            legacy_supabase_path.display()
        )))
    }

    fn load_backend_toml(path: &Path) -> Result<Self, ProviderConfigError> {
        let text = std::fs::read_to_string(path)?;
        let file: BackendConfigFile = toml::from_str(&text)?;
        match file.kind.as_str() {
            "supabase" => file.supabase.map(ProviderConfig::Supabase).ok_or_else(|| {
                ProviderConfigError::Config(
                    "[supabase] section is required when kind = \"supabase\"".to_string(),
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
    supabase: Option<SupabaseConfig>,
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
    use crate::supabase::SupabaseConfig;

    #[test]
    fn falls_back_to_legacy_supabase_toml_when_backend_toml_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let backend_path = dir.path().join("backend.toml");
        let legacy_supabase_path = dir.path().join("supabase.toml");
        let legacy = SupabaseConfig {
            url: "https://project.supabase.co".to_string(),
            anon_key: "anon".to_string(),
            refresh_token: "refresh".to_string(),
            team_id: "team-1".to_string(),
            actor_id: "agent-1".to_string(),
        };
        legacy.save(&legacy_supabase_path).unwrap();

        let loaded = ProviderConfig::load_from_paths(&backend_path, &legacy_supabase_path).unwrap();

        assert_eq!(loaded.kind(), ProviderKind::Supabase);
        let ProviderConfig::Supabase(config) = loaded else {
            panic!("expected supabase provider config");
        };
        assert_eq!(config, legacy);
    }

    #[test]
    fn loads_cloud_api_backend_toml() {
        let dir = tempfile::tempdir().unwrap();
        let backend_path = dir.path().join("backend.toml");
        let legacy_supabase_path = dir.path().join("supabase.toml");
        std::fs::write(
            &backend_path,
            r#"
kind = "cloud_api"

[cloud_api]
url = "https://fc.example.com"
supabase_url = "https://project.supabase.co"
supabase_anon_key = "anon"
refresh_token = "refresh"
team_id = "team-1"
actor_id = "agent-1"
"#,
        )
        .unwrap();

        let loaded = ProviderConfig::load_from_paths(&backend_path, &legacy_supabase_path).unwrap();

        assert_eq!(loaded.kind(), ProviderKind::CloudApi);
        let ProviderConfig::CloudApi(config) = loaded else {
            panic!("expected cloud api provider config");
        };
        assert_eq!(config.url, "https://fc.example.com");
        assert_eq!(config.supabase_url, "https://project.supabase.co");
        assert_eq!(config.supabase_anon_key, "anon");
        assert_eq!(config.refresh_token, "refresh");
        assert_eq!(config.team_id, "team-1");
        assert_eq!(config.actor_id, "agent-1");
    }
}
