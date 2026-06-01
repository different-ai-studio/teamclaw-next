use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::proto::amux;

#[derive(Debug, Serialize, Deserialize)]
pub struct WorkspaceStore {
    #[serde(default)]
    pub workspaces: Vec<StoredWorkspace>,
    /// Local workspace id for cron/desktop implicit cwd and cloud API agent default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_workspace_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredWorkspace {
    pub workspace_id: String,
    #[serde(default)]
    pub remote_workspace_id: String,
    pub path: String,
    pub display_name: String,
    /// Team this workspace belongs to, when it has joined team-share. Drives
    /// global-sync + symlink creation. `None` = not joined.
    #[serde(default)]
    pub team_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct AddWorkspaceOutcome {
    pub workspace: StoredWorkspace,
    pub inserted: bool,
}

impl WorkspaceStore {
    #[allow(dead_code)]
    pub fn default_path() -> PathBuf {
        super::DaemonConfig::migrate_legacy_file("workspaces.toml")
    }

    pub fn load(path: &Path) -> crate::error::Result<Self> {
        if !path.exists() {
            return Ok(Self {
                workspaces: vec![],
                default_workspace_id: None,
            });
        }
        let content = std::fs::read_to_string(path).map_err(|e| {
            crate::error::AmuxError::Config(format!("read {}: {}", path.display(), e))
        })?;
        toml::from_str(&content).map_err(|e| {
            crate::error::AmuxError::Config(format!("parse {}: {}", path.display(), e))
        })
    }

    pub fn save(&self, path: &Path) -> crate::error::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let content = toml::to_string_pretty(self)
            .map_err(|e| crate::error::AmuxError::Config(e.to_string()))?;
        std::fs::write(path, content)?;
        Ok(())
    }

    pub fn add(&mut self, dir_path: &str) -> crate::error::Result<AddWorkspaceOutcome> {
        let p = Path::new(dir_path);
        if !p.is_dir() {
            return Err(crate::error::AmuxError::Config(format!(
                "path is not a directory: {}",
                dir_path
            )));
        }

        // Deduplicate by canonical path
        let canonical = p.canonicalize().map_err(|e| {
            crate::error::AmuxError::Config(format!("canonicalize {}: {}", dir_path, e))
        })?;
        let canonical_str = canonical.to_string_lossy().to_string();

        if let Some(existing) = self.workspaces.iter().find(|w| w.path == canonical_str) {
            return Ok(AddWorkspaceOutcome {
                workspace: existing.clone(),
                inserted: false,
            });
        }

        let display_name = canonical
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| canonical_str.clone());

        let workspace_id = uuid::Uuid::new_v4()
            .to_string()
            .chars()
            .take(8)
            .collect::<String>();

        let workspace = StoredWorkspace {
            workspace_id,
            remote_workspace_id: String::new(),
            path: canonical_str,
            display_name,
            team_id: None,
        };
        self.workspaces.push(workspace.clone());
        Ok(AddWorkspaceOutcome {
            workspace,
            inserted: true,
        })
    }

    pub fn remove(&mut self, workspace_id: &str) -> bool {
        let len = self.workspaces.len();
        self.workspaces.retain(|w| w.workspace_id != workspace_id);
        self.workspaces.len() < len
    }

    pub fn find_by_id(&self, workspace_id: &str) -> Option<&StoredWorkspace> {
        // Match either the local 8-char id OR the remote UUID — iOS/Tauri
        // clients send the remote id (since that's what they read from
        // the workspaces row), while CLI-spawned flows still pass the
        // local id. Looking up both keeps the caller dumb.
        self.workspaces
            .iter()
            .find(|w| w.workspace_id == workspace_id || w.remote_workspace_id == workspace_id)
    }

    pub fn set_default_workspace_id(&mut self, workspace_id: &str) {
        if self.find_by_id(workspace_id).is_some() {
            self.default_workspace_id = Some(workspace_id.to_string());
        }
    }

    /// Resolved path for cron / implicit cwd: explicit default, else sole workspace.
    pub fn default_workspace_path(&self) -> Option<&str> {
        if let Some(id) = self.default_workspace_id.as_deref() {
            if let Some(ws) = self.find_by_id(id) {
                return Some(ws.path.as_str());
            }
        }
        if self.workspaces.len() == 1 {
            return Some(self.workspaces[0].path.as_str());
        }
        None
    }

    pub fn to_proto_list(&self) -> amux::WorkspaceList {
        amux::WorkspaceList {
            workspaces: self
                .workspaces
                .iter()
                .map(|w| amux::WorkspaceInfo {
                    workspace_id: w.workspace_id.clone(),
                    path: w.path.clone(),
                    display_name: w.display_name.clone(),
                })
                .collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{StoredWorkspace, WorkspaceStore};

    #[test]
    fn team_id_defaults_to_none_and_roundtrips() {
        let dir = tempfile::tempdir().unwrap();
        let toml_path = dir.path().join("workspaces.toml");

        // Old file with no team_id field still parses (serde default).
        std::fs::write(
            &toml_path,
            "[[workspaces]]\nworkspace_id = \"abc\"\npath = \"/tmp\"\ndisplay_name = \"tmp\"\n",
        )
        .unwrap();
        let mut store = WorkspaceStore::load(&toml_path).unwrap();
        assert_eq!(store.workspaces[0].team_id, None);

        // Set + save + reload preserves it.
        store.workspaces[0].team_id = Some("team-7".into());
        store.save(&toml_path).unwrap();
        let reloaded = WorkspaceStore::load(&toml_path).unwrap();
        assert_eq!(reloaded.workspaces[0].team_id.as_deref(), Some("team-7"));
    }

    #[test]
    fn set_default_workspace_id_roundtrips_in_toml() {
        let dir = tempfile::tempdir().unwrap();
        let toml_path = dir.path().join("workspaces.toml");
        let mut store = WorkspaceStore {
            workspaces: vec![StoredWorkspace {
                workspace_id: "abc12345".into(),
                remote_workspace_id: String::new(),
                path: dir.path().to_string_lossy().into(),
                display_name: "test".into(),
                team_id: None,
            }],
            default_workspace_id: None,
        };
        store.set_default_workspace_id("abc12345");
        store.save(&toml_path).unwrap();

        let reloaded = WorkspaceStore::load(&toml_path).unwrap();
        assert_eq!(reloaded.default_workspace_id.as_deref(), Some("abc12345"));
    }

    #[test]
    fn add_reports_when_workspace_was_inserted() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = WorkspaceStore {
            workspaces: vec![],
            default_workspace_id: None,
        };

        let first = store.add(dir.path().to_str().unwrap()).unwrap();
        let second = store.add(dir.path().to_str().unwrap()).unwrap();

        assert!(first.inserted);
        assert!(!second.inserted);
        assert_eq!(first.workspace.path, second.workspace.path);
        assert_eq!(store.workspaces.len(), 1);
    }

    #[test]
    fn default_workspace_path_prefers_explicit_default() {
        let mut store = WorkspaceStore {
            workspaces: vec![
                StoredWorkspace {
                    workspace_id: "a".into(),
                    remote_workspace_id: String::new(),
                    path: "/tmp/a".into(),
                    display_name: "a".into(),
                    team_id: None,
                },
                StoredWorkspace {
                    workspace_id: "b".into(),
                    remote_workspace_id: String::new(),
                    path: "/tmp/b".into(),
                    display_name: "b".into(),
                    team_id: None,
                },
            ],
            default_workspace_id: Some("b".into()),
        };
        assert_eq!(store.default_workspace_path(), Some("/tmp/b"));
    }

    #[test]
    fn default_workspace_path_falls_back_to_single_workspace() {
        let store = WorkspaceStore {
            workspaces: vec![StoredWorkspace {
                workspace_id: "only".into(),
                remote_workspace_id: String::new(),
                path: "/tmp/only".into(),
                display_name: "only".into(),
                team_id: None,
            }],
            default_workspace_id: None,
        };
        assert_eq!(store.default_workspace_path(), Some("/tmp/only"));
    }
}
