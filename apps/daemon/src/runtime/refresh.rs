use std::collections::{BTreeSet, HashMap};
use std::path::Path;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

use crate::config::workspace_control::{RuntimeRefreshDto, WorkspaceControlError};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, Hash)]
#[serde(rename_all = "snake_case")]
pub enum RefreshChangeKind {
    Skills,
    Mcp,
    EnvVars,
    ProviderAuth,
    ProviderCatalog,
    Permissions,
    OpencodeJson,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, Hash)]
#[serde(rename_all = "snake_case")]
pub enum RefreshSource {
    UiMutation,
    FilesystemWatch,
    StartupRescan,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, Hash)]
#[serde(rename_all = "snake_case")]
pub enum RefreshImpact {
    AppliedLive,
    IdleReload,
    IdleRestart,
    UserApplyRequired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, Hash)]
#[serde(rename_all = "snake_case")]
pub enum RefreshRecommendedAction {
    None,
    ApplyChanges,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, Hash)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceRefreshStatus {
    Clean,
    Pending,
    Applying,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceRefreshState {
    pub workspace_id: String,
    pub workspace_path: String,
    pub status: WorkspaceRefreshStatus,
    pub strongest_impact: RefreshImpact,
    pub recommended_action: RefreshRecommendedAction,
    pub change_kinds: BTreeSet<RefreshChangeKind>,
    pub sources: BTreeSet<RefreshSource>,
    pub auto_apply_blocked_by_active_runtime: bool,
    pub first_detected_at: DateTime<Utc>,
    pub last_detected_at: DateTime<Utc>,
    pub last_error: Option<String>,
}

impl WorkspaceRefreshState {
    pub fn to_dto(&self) -> RuntimeRefreshDto {
        RuntimeRefreshDto {
            status: self.status.as_str().to_owned(),
            change_kinds: self
                .change_kinds
                .iter()
                .map(|kind| kind.as_str().to_owned())
                .collect(),
            recommended_action: self.recommended_action.as_str().to_owned(),
            auto_apply_blocked_by_active_runtime: self.auto_apply_blocked_by_active_runtime,
            last_detected_at: Some(self.last_detected_at.to_rfc3339()),
            last_error: self.last_error.clone(),
        }
    }
}

#[derive(Debug)]
pub struct RuntimeRefreshCoordinator {
    inner: RwLock<HashMap<String, WorkspaceRefreshState>>,
}

impl RuntimeRefreshCoordinator {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            inner: RwLock::new(HashMap::new()),
        })
    }

    pub async fn record_change(
        &self,
        workspace_id: &str,
        workspace_path: &Path,
        kind: RefreshChangeKind,
        source: RefreshSource,
    ) -> Result<(), WorkspaceControlError> {
        let now = Utc::now();
        let mut guard = self.inner.write().await;
        let entry = guard
            .entry(workspace_id.to_owned())
            .or_insert_with(|| WorkspaceRefreshState {
                workspace_id: workspace_id.to_owned(),
                workspace_path: workspace_path.display().to_string(),
                status: WorkspaceRefreshStatus::Pending,
                strongest_impact: impact_for_kind(kind),
                recommended_action: RefreshRecommendedAction::ApplyChanges,
                change_kinds: BTreeSet::new(),
                sources: BTreeSet::new(),
                auto_apply_blocked_by_active_runtime: false,
                first_detected_at: now,
                last_detected_at: now,
                last_error: None,
            });

        entry.workspace_path = workspace_path.display().to_string();
        entry.status = WorkspaceRefreshStatus::Pending;
        entry.change_kinds.insert(kind);
        entry.sources.insert(source);
        entry.strongest_impact = strongest_impact(entry.change_kinds.iter().copied());
        entry.recommended_action = recommended_action_for(entry.strongest_impact);
        entry.last_detected_at = now;
        entry.last_error = None;
        Ok(())
    }

    pub async fn workspace_state(&self, workspace_id: &str) -> Option<WorkspaceRefreshState> {
        self.inner.read().await.get(workspace_id).cloned()
    }

    pub async fn runtime_refresh_dto(&self, workspace_id: &str) -> Option<RuntimeRefreshDto> {
        self.workspace_state(workspace_id).await.map(|state| state.to_dto())
    }

    pub async fn mark_apply_failed(&self, workspace_id: &str, error: impl Into<String>) {
        let mut guard = self.inner.write().await;
        if let Some(state) = guard.get_mut(workspace_id) {
            state.status = WorkspaceRefreshStatus::Pending;
            state.recommended_action = RefreshRecommendedAction::ApplyChanges;
            state.last_error = Some(error.into());
            state.last_detected_at = Utc::now();
        }
    }
}

fn impact_for_kind(kind: RefreshChangeKind) -> RefreshImpact {
    match kind {
        RefreshChangeKind::Mcp => RefreshImpact::IdleRestart,
        RefreshChangeKind::Skills
        | RefreshChangeKind::EnvVars
        | RefreshChangeKind::ProviderAuth
        | RefreshChangeKind::ProviderCatalog
        | RefreshChangeKind::Permissions
        | RefreshChangeKind::OpencodeJson => RefreshImpact::IdleReload,
    }
}

fn strongest_impact(kinds: impl Iterator<Item = RefreshChangeKind>) -> RefreshImpact {
    kinds
        .map(impact_for_kind)
        .max_by_key(|impact| match impact {
            RefreshImpact::AppliedLive => 0,
            RefreshImpact::IdleReload => 1,
            RefreshImpact::IdleRestart => 2,
            RefreshImpact::UserApplyRequired => 3,
        })
        .unwrap_or(RefreshImpact::AppliedLive)
}

fn recommended_action_for(impact: RefreshImpact) -> RefreshRecommendedAction {
    match impact {
        RefreshImpact::AppliedLive => RefreshRecommendedAction::None,
        RefreshImpact::IdleReload
        | RefreshImpact::IdleRestart
        | RefreshImpact::UserApplyRequired => RefreshRecommendedAction::ApplyChanges,
    }
}

impl RefreshChangeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Skills => "skills",
            Self::Mcp => "mcp",
            Self::EnvVars => "env_vars",
            Self::ProviderAuth => "provider_auth",
            Self::ProviderCatalog => "provider_catalog",
            Self::Permissions => "permissions",
            Self::OpencodeJson => "opencode_json",
        }
    }
}

impl RefreshRecommendedAction {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::ApplyChanges => "apply_changes",
        }
    }
}

impl WorkspaceRefreshStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Clean => "clean",
            Self::Pending => "pending",
            Self::Applying => "applying",
            Self::Failed => "failed",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn strongest_pending_impact_wins() {
        let coordinator = RuntimeRefreshCoordinator::new();
        coordinator
            .record_change(
                "ws-1",
                Path::new("/tmp/ws-1"),
                RefreshChangeKind::Skills,
                RefreshSource::UiMutation,
            )
            .await
            .unwrap();
        coordinator
            .record_change(
                "ws-1",
                Path::new("/tmp/ws-1"),
                RefreshChangeKind::Mcp,
                RefreshSource::FilesystemWatch,
            )
            .await
            .unwrap();

        let state = coordinator.workspace_state("ws-1").await.unwrap();
        assert_eq!(state.status, WorkspaceRefreshStatus::Pending);
        assert_eq!(
            state.recommended_action,
            RefreshRecommendedAction::ApplyChanges
        );
        assert_eq!(state.strongest_impact, RefreshImpact::IdleRestart);
        assert!(state.change_kinds.contains(&RefreshChangeKind::Skills));
        assert!(state.change_kinds.contains(&RefreshChangeKind::Mcp));
    }

    #[tokio::test]
    async fn failed_apply_keeps_pending_state() {
        let coordinator = RuntimeRefreshCoordinator::new();
        coordinator
            .record_change(
                "ws-2",
                Path::new("/tmp/ws-2"),
                RefreshChangeKind::EnvVars,
                RefreshSource::UiMutation,
            )
            .await
            .unwrap();

        coordinator.mark_apply_failed("ws-2", "reload failed").await;

        let state = coordinator.workspace_state("ws-2").await.unwrap();
        assert_eq!(state.status, WorkspaceRefreshStatus::Pending);
        assert_eq!(
            state.recommended_action,
            RefreshRecommendedAction::ApplyChanges
        );
        assert!(state.last_error.as_deref().unwrap().contains("reload failed"));
        assert!(state.change_kinds.contains(&RefreshChangeKind::EnvVars));
    }

    #[tokio::test]
    async fn runtime_refresh_dto_reports_pending_state() {
        let coordinator = RuntimeRefreshCoordinator::new();
        coordinator
            .record_change(
                "ws-3",
                Path::new("/tmp/ws-3"),
                RefreshChangeKind::Skills,
                RefreshSource::UiMutation,
            )
            .await
            .unwrap();

        let dto = coordinator.runtime_refresh_dto("ws-3").await.unwrap();
        assert_eq!(dto.status, "pending");
        assert_eq!(dto.recommended_action, "apply_changes");
        assert_eq!(dto.change_kinds, vec!["skills".to_string()]);
        assert_eq!(dto.last_error, None);
    }
}
