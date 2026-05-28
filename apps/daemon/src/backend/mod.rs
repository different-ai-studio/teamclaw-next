//! Backend abstraction over the daemon's persistent store.
//!
//! The only production implementation is `CloudApiBackend` in
//! `crate::backend::cloud_api`; `MockBackend` (in `mock`) is the test-side
//! impl. Callers bind to `Arc<dyn Backend>` so the daemon's runtime/
//! channel/session machinery can be exercised against an in-memory backend
//! without going through HTTP.
use async_trait::async_trait;
use std::time::Instant;

pub mod error;
pub use error::{BackendError, BackendResult};

pub mod cloud_api;

pub mod records;
pub use records::{
    AgentRuntimeRow, AgentRuntimeUpsert, BackendParticipantRow, BackendSessionAndParticipants,
    BackendSessionRow, ClaimResult, StoredMessage, WorkspaceRow, WorkspaceUpsert,
};

/// MQTT settings delivered by `/v1/config/bootstrap`. The full broker URL
/// (with scheme + port) is the canonical field; credentials are optional and
/// override the values from the local daemon config when present.
#[derive(Debug, Clone)]
pub struct BootstrapMqttOverride {
    pub url: String,
    pub username: Option<String>,
    pub password: Option<String>,
}

#[cfg(test)]
pub mod mock;

#[async_trait]
pub trait Backend: Send + Sync {
    // ── Identity ──────────────────────────────────────────────────────────
    /// The team this backend is authenticated against.
    fn team_id(&self) -> &str;

    /// The actor (member or agent) this backend acts as.
    fn actor_id(&self) -> &str;

    // ── Credentials ───────────────────────────────────────────────────────
    /// Current auth token for downstream services (MQTT, etc.). Implementations
    /// are expected to refresh as needed and return a usable bearer string.
    async fn auth_token(&self) -> BackendResult<String>;

    /// Expiry of the cached credential without forcing a refresh. `None` if
    /// no credential has been fetched yet or the impl doesn't expose one.
    /// Used for diagnostic logging only — callers must not branch behavior
    /// on this value.
    fn cached_credential_expiry(&self) -> Option<Instant> {
        None
    }

    /// Fetch runtime MQTT broker overrides from the cloud backend. Default
    /// implementation is a no-op for backends that have no remote config
    /// surface (e.g. mock, Supabase).
    async fn fetch_bootstrap_mqtt(&self) -> BackendResult<Option<BootstrapMqttOverride>> {
        Ok(None)
    }

    // ── Business operations ───────────────────────────────────────────────
    /// Claim a team invite token. Used both by the human onboarding path
    /// and by the daemon's `claim_daemon_invite` flow.
    async fn claim_team_invite(&self, token: &str) -> BackendResult<ClaimResult>;

    /// Upsert an `agent_runtimes` row keyed on `(agent_id, backend_session_id)`.
    /// Returns the row id when the response carries one.
    async fn upsert_agent_runtime(
        &self,
        row: &AgentRuntimeUpsert<'_>,
    ) -> BackendResult<Option<String>>;

    /// Fetch one `agent_runtimes` row for an exact runtime/backend session.
    async fn fetch_agent_runtime_for_session(
        &self,
        session_id: &str,
        runtime_id: &str,
        backend_session_id: &str,
    ) -> BackendResult<Option<AgentRuntimeRow>>;

    /// Fetch the newest `agent_runtimes` row for `(agent_id, session_id)`.
    async fn fetch_latest_runtime_for_session(
        &self,
        agent_id: &str,
        session_id: &str,
    ) -> BackendResult<Option<AgentRuntimeRow>>;

    /// Advertise daemon-supported agent backend types on its `agents` row.
    async fn ensure_agent_types(
        &self,
        supported_types: &[String],
        default_agent_type: &str,
    ) -> BackendResult<()>;

    /// Record this daemon's MQTT device identifier on its `agents` row.
    async fn set_agent_device_id(&self, device_id: &str) -> BackendResult<()>;

    /// Look up `agent_member_access.permission_level` for a caller.
    /// Returns `Some("admin" | "write" | "view")` or `None`.
    async fn check_agent_permission(
        &self,
        agent_id: &str,
        actor_id: &str,
    ) -> BackendResult<Option<String>>;

    /// Touch `actor_last_active` for the current daemon actor.
    async fn heartbeat(&self) -> BackendResult<()>;

    /// Upsert a `workspaces` row, returning the canonical id.
    async fn upsert_workspace(&self, row: &WorkspaceUpsert<'_>) -> BackendResult<WorkspaceRow>;

    /// Fetch a `sessions` row alongside its `session_participants`.
    async fn fetch_session_with_participants(
        &self,
        session_id: &str,
    ) -> BackendResult<BackendSessionAndParticipants>;

    /// Messages for `session_id` ordered ascending, with optional exclusive
    /// cursor — messages at or before `after_id` are dropped.
    async fn messages_after_cursor(
        &self,
        session_id: &str,
        after_id: Option<&str>,
    ) -> BackendResult<Vec<StoredMessage>>;

    /// Persist the per-runtime read cursor by PATCHing `agent_runtimes`.
    async fn update_runtime_cursor(
        &self,
        runtime_row_id: &str,
        last_processed_message_id: &str,
    ) -> BackendResult<()>;

    /// Upsert an `actors` row of type `external` keyed on
    /// `(team_id, source, source_id)`. Returns the actor's UUID.
    async fn rpc_upsert_external_actor(
        &self,
        team_id: &str,
        source: &str,
        source_id: &str,
        display_name: &str,
    ) -> BackendResult<String>;

    /// Look up `(sessions.id, binding)` for a gateway session by its
    /// SQL-minted `acp_session_id`. Returns `None` when no row matches.
    async fn get_gateway_session_by_acp_id(
        &self,
        acp_session_id: &str,
    ) -> BackendResult<Option<(String, Option<String>)>>;

    /// Resolve (or create) the `sessions` row for a gateway binding.
    /// Returns `(session_id, acp_session_id, created)`.
    #[allow(clippy::too_many_arguments)]
    async fn rpc_ensure_gateway_session(
        &self,
        team_id: &str,
        binding: &str,
        title: &str,
        primary_agent_actor_id: &str,
        owner_member_actor_ids: &[String],
        participant_actor_ids: &[String],
    ) -> BackendResult<(String, String, bool)>;

    /// Insert one row into `public.messages` from a gateway message.
    /// Idempotent on `(session_id, external_id)`.
    async fn insert_gateway_message(
        &self,
        session_id: &str,
        sender_actor_id: &str,
        content: &str,
        external_message_id: Option<&str>,
    ) -> BackendResult<String>;

    /// Same as `insert_gateway_message`, with an `attachments` JSON array.
    async fn insert_gateway_message_with_attachments(
        &self,
        session_id: &str,
        sender_actor_id: &str,
        content: &str,
        external_message_id: Option<&str>,
        attachments: serde_json::Value,
    ) -> BackendResult<String>;

    /// Upload bytes to the attachments bucket.
    async fn upload_attachment_bytes(
        &self,
        path: &str,
        bytes: Vec<u8>,
        mime: &str,
    ) -> BackendResult<String>;

    /// Return admin member actor ids granted access to `agent_actor_id`.
    async fn list_agent_admin_member_actor_ids(
        &self,
        agent_actor_id: &str,
    ) -> BackendResult<Vec<String>>;

    /// Add (or ignore-if-present) a participant on `session_participants`.
    async fn upsert_session_participant(
        &self,
        session_id: &str,
        actor_id: &str,
    ) -> BackendResult<()>;

    /// Create a `sessions` row for a cron-triggered turn and seed
    /// participants (primary agent + that agent's admin members).
    async fn create_cron_session(
        &self,
        team_id: &str,
        primary_agent_actor_id: &str,
        title: &str,
    ) -> BackendResult<String>;

    /// Insert one row into `public.messages` from the daemon's runtime.
    #[allow(clippy::too_many_arguments)]
    async fn insert_message(
        &self,
        id: &str,
        team_id: &str,
        session_id: &str,
        sender_actor_id: &str,
        kind: &str,
        content: &str,
        metadata_json: &str,
        model: &str,
        turn_id: &str,
        sequence: u64,
    ) -> BackendResult<()>;
}
