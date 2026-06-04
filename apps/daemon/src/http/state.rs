//! Shared application state for the HTTP layer.
//!
//! `HttpState` is the single `Arc`-wrapped bundle the axum router hangs
//! every handler off. Keep it small and trait-object-friendly: handlers
//! that need fine-grained pieces extract from this struct rather than
//! introducing parallel statics.

use std::sync::Arc;

use tokio::sync::{mpsc, oneshot};

use crate::config::workspace_control::WorkspaceControlStore;
use crate::config::HttpConfig;

use super::limit::RateLimiter;
use super::runtime_adapter::RuntimeAdapter;
use super::sessions::{IdempotencyCache, SessionOwnerIndex};
use super::tokens::TokenStore;

/// Request to register a workspace into the daemon's local registry (`~/.amuxd/
/// workspaces.toml`) **and** the cloud `public.workspaces` table, idempotently.
///
/// The HTTP `POST /v1/workspaces` handler cannot mutate the registry directly —
/// the daemon actor owns the in-memory `WorkspaceStore` and persists it, so a
/// concurrent file write from the HTTP task would race the actor. Instead the
/// handler sends this request to the actor loop (via the same command channel
/// that backs the Unix control socket) and waits on `reply_tx` for a single
/// JSON line: `{"ok":true,"result":{workspace}}` or `{"ok":false,"error":...}`.
pub struct RegisterWorkspaceRequest {
    /// Absolute workspace path to register (e.g. `~/.amuxd/teams/<teamId>`
    /// already expanded by the caller).
    pub path: String,
    pub reply_tx: oneshot::Sender<String>,
}

/// Producer side of the register-workspace bridge handed to `HttpState`.
pub type RegisterWorkspaceTx = mpsc::Sender<RegisterWorkspaceRequest>;

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
    /// Workspace refresh state shared with `/v1/workspaces/:id/runtime*`.
    pub runtime_refresh: Option<Arc<crate::runtime::refresh::RuntimeRefreshCoordinator>>,
    /// Loopback `opencode serve` pool for provider OAuth (settings only).
    pub opencode_settings: Option<Arc<crate::opencode_settings::OpenCodeSettingsService>>,
    /// Daemon-owned team sync dispatcher (drives `/v1/team/sync*`).
    pub sync_dispatcher: crate::sync::dispatch::SyncDispatcher,
    /// Bridge to the daemon actor loop for `POST /v1/workspaces`. `None` when
    /// the HTTP server runs without a daemon actor behind it (focused tests) —
    /// the route then returns 503.
    pub register_workspace_tx: Option<RegisterWorkspaceTx>,
}

impl HttpState {
    // sync_dispatcher was added in the daemon-owns-team-sync pass; constructor
    // is intentionally wide to avoid a builder while the field set is stable.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        config: HttpConfig,
        tokens: TokenStore,
        meta: DaemonMetadata,
        runtime: Arc<dyn RuntimeAdapter>,
        workspace_control: Option<Arc<dyn WorkspaceControlStore>>,
        runtime_supervisor: Option<Arc<crate::runtime::RuntimeSupervisor>>,
        opencode_settings: Option<Arc<crate::opencode_settings::OpenCodeSettingsService>>,
        sync_dispatcher: crate::sync::dispatch::SyncDispatcher,
        register_workspace_tx: Option<RegisterWorkspaceTx>,
    ) -> Self {
        let runtime_refresh = runtime_supervisor
            .as_ref()
            .map(|supervisor| supervisor.refresh_coordinator());
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
            runtime_refresh,
            opencode_settings,
            sync_dispatcher,
            register_workspace_tx,
        }
    }
}
