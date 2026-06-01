//! Shared application state for the HTTP layer.
//!
//! `HttpState` is the single `Arc`-wrapped bundle the axum router hangs
//! every handler off. Keep it small and trait-object-friendly: handlers
//! that need fine-grained pieces extract from this struct rather than
//! introducing parallel statics.

use std::sync::Arc;

use crate::config::HttpConfig;
use crate::config::workspace_control::WorkspaceControlStore;

use super::limit::RateLimiter;
use super::runtime_adapter::RuntimeAdapter;
use super::sessions::{IdempotencyCache, SessionOwnerIndex};
use super::tokens::TokenStore;

/// Process metadata surfaced via `/v1/info`. Filled in at startup and
/// treated as immutable thereafter.
#[derive(Debug, Clone)]
pub struct DaemonMetadata {
    pub version: &'static str,
    pub started_at: chrono::DateTime<chrono::Utc>,
    pub actor_id: String,
    pub backend_kind: String,
    /// Agent backends this daemon has configured (subset of
    /// `["claude", "opencode", "codex"]`), as reported by
    /// `supported_agent_type_names`. Drives the per-backend model catalog
    /// (`GET /v1/workspaces/:id/model-catalog`). Empty in focused tests that
    /// build metadata via `metadata()` without daemon config.
    pub configured_agent_types: Vec<String>,
}

#[derive(Clone)]
pub struct HttpState {
    pub config: Arc<HttpConfig>,
    pub tokens: TokenStore,
    pub meta: Arc<DaemonMetadata>,
    pub runtime: Arc<dyn RuntimeAdapter>,
    pub session_index: Arc<SessionOwnerIndex>,
    pub idempotency: Arc<IdempotencyCache>,
    pub limiter: Arc<RateLimiter>,
    /// Workspace configuration control (providers, permissions, allowlist).
    /// `None` when the HTTP server is started without a workspace control
    /// store (e.g. in focused unit tests). Workspace routes return 404 in
    /// that case.
    pub workspace_control: Option<Arc<dyn WorkspaceControlStore>>,
    pub runtime_supervisor: Option<Arc<crate::runtime::RuntimeSupervisor>>,
    /// Loopback `opencode serve` pool for provider OAuth (settings only).
    pub opencode_settings: Option<Arc<crate::opencode_settings::OpenCodeSettingsService>>,
}

impl HttpState {
    pub fn new(
        config: HttpConfig,
        tokens: TokenStore,
        meta: DaemonMetadata,
        runtime: Arc<dyn RuntimeAdapter>,
        workspace_control: Option<Arc<dyn WorkspaceControlStore>>,
        runtime_supervisor: Option<Arc<crate::runtime::RuntimeSupervisor>>,
        opencode_settings: Option<Arc<crate::opencode_settings::OpenCodeSettingsService>>,
    ) -> Self {
        Self {
            config: Arc::new(config),
            tokens,
            meta: Arc::new(meta),
            runtime,
            session_index: SessionOwnerIndex::new(),
            idempotency: IdempotencyCache::new(),
            limiter: RateLimiter::new(),
            workspace_control,
            runtime_supervisor,
            opencode_settings,
        }
    }
}
