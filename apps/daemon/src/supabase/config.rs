use crate::supabase::error::{SupabaseError, SupabaseResult};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SupabaseConfig {
    pub url: String,
    pub anon_key: String,
    pub refresh_token: String,
    pub team_id: String,
    pub actor_id: String,
}

impl SupabaseConfig {
    pub fn load(path: &Path) -> SupabaseResult<Self> {
        let text = fs::read_to_string(path)?;
        let cfg: SupabaseConfig =
            toml::from_str(&text).map_err(|e| SupabaseError::Config(format!("parse: {e}")))?;
        Ok(cfg)
    }

    pub fn save(&self, path: &Path) -> SupabaseResult<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let text =
            toml::to_string(self).map_err(|e| SupabaseError::Config(format!("serialize: {e}")))?;
        fs::write(path, text)?;
        Ok(())
    }

    pub fn default_path() -> SupabaseResult<PathBuf> {
        let dir = dirs::home_dir()
            .ok_or_else(|| SupabaseError::Config("no home dir".into()))?
            .join(".amuxd");
        let path = dir.join("supabase.toml");
        let legacy_path = Self::legacy_path()?;

        sync_legacy_if_newer(&path, &legacy_path)?;

        Ok(path)
    }

    pub fn legacy_path() -> SupabaseResult<PathBuf> {
        let dir = dirs::home_dir()
            .ok_or_else(|| SupabaseError::Config("no home dir".into()))?
            .join(".amuxd");
        Ok(dirs::config_dir()
            .unwrap_or_else(|| dir.clone())
            .join("amux")
            .join("supabase.toml"))
    }
}

fn modified_at(path: &Path) -> Option<SystemTime> {
    fs::metadata(path).and_then(|m| m.modified()).ok()
}

fn should_sync_legacy(path_mtime: Option<SystemTime>, legacy_mtime: Option<SystemTime>) -> bool {
    match (path_mtime, legacy_mtime) {
        (_, None) => false,
        (None, Some(_)) => true,
        (Some(current), Some(legacy)) => legacy > current,
    }
}

fn sync_legacy_if_newer(path: &Path, legacy_path: &Path) -> SupabaseResult<()> {
    if should_sync_legacy(modified_at(path), modified_at(legacy_path)) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        if legacy_path.exists() {
            fs::copy(&legacy_path, &path)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn round_trip_config() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("supabase.toml");

        let cfg = SupabaseConfig {
            url: "https://example.supabase.co".into(),
            anon_key: "anon".into(),
            refresh_token: "refresh".into(),
            team_id: "team".into(),
            actor_id: "actor".into(),
        };
        cfg.save(&path).unwrap();

        let loaded = SupabaseConfig::load(&path).unwrap();
        assert_eq!(cfg, loaded);
    }

    #[test]
    fn load_missing_file_returns_io_error() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("nope.toml");
        assert!(matches!(
            SupabaseConfig::load(&path),
            Err(SupabaseError::Io(_))
        ));
    }

    #[test]
    fn save_creates_parent_directory() {
        let dir = tempdir().unwrap();
        let path = dir
            .path()
            .join("nested")
            .join("deeper")
            .join("supabase.toml");

        let cfg = SupabaseConfig {
            url: "u".into(),
            anon_key: "a".into(),
            refresh_token: "r".into(),
            team_id: "t".into(),
            actor_id: "x".into(),
        };
        cfg.save(&path).unwrap();
        assert!(path.exists());
    }

    #[test]
    fn should_sync_legacy_when_current_missing_or_older() {
        let old = SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1);
        let new = SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(2);

        assert!(should_sync_legacy(None, Some(new)));
        assert!(should_sync_legacy(Some(old), Some(new)));
        assert!(!should_sync_legacy(Some(new), Some(old)));
        assert!(!should_sync_legacy(Some(new), None));
    }

    #[test]
    fn sync_legacy_if_newer_copies_when_current_missing() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("new").join("supabase.toml");
        let legacy_path = dir.path().join("legacy").join("supabase.toml");
        fs::create_dir_all(legacy_path.parent().unwrap()).unwrap();
        fs::write(&legacy_path, "legacy").unwrap();

        sync_legacy_if_newer(&path, &legacy_path).unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "legacy");
    }
}
