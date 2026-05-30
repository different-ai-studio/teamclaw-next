mod client;
mod gateway;
mod messages;

use super::{
    AgentRuntimeRow, AgentRuntimeUpsert, Backend, BackendError, BackendResult,
    BackendSessionAndParticipants, BootstrapMqttOverride, ClaimResult, StoredMessage, WorkspaceRow,
    WorkspaceUpsert,
};
use crate::provider_config::CloudApiConfig;
use async_trait::async_trait;
use client::{
    cloud_url, decode_response, network_error, refresh_failure_message, request_id,
    RefreshRequest, TokenResponse,
};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[derive(Debug, Deserialize)]
struct BootstrapResponse {
    #[serde(default)]
    mqtt: Option<BootstrapMqttPayload>,
}

#[derive(Debug, Deserialize)]
struct BootstrapMqttPayload {
    url: String,
    #[serde(default)]
    username: Option<String>,
    #[serde(default)]
    password: Option<String>,
}

/// Access token must be refreshed this long before its `expires_at` so an
/// in-flight request never races the expiry boundary.
const ACCESS_TOKEN_LEEWAY: Duration = Duration::from_secs(60);

/// Mutable token state shared across all clones of a `CloudApiBackend`.
///
/// Held only for brief, synchronous critical sections — never across an
/// `.await`. The network refresh itself is serialized by `refresh_lock`.
struct TokenState {
    /// The live refresh token. Seeded from `backend.toml`, then updated in place
    /// every time Supabase rotates it.
    refresh_token: String,
    /// The most recently fetched access token, if any.
    access_token: Option<String>,
    /// When `access_token` expires, as a monotonic `Instant`.
    expires_at: Option<Instant>,
}

#[derive(Clone)]
pub struct CloudApiBackend {
    pub(super) cfg: CloudApiConfig,
    pub(super) http: reqwest::Client,
    /// Cached token + live refresh token. Shared across clones via `Arc`.
    token: Arc<Mutex<TokenState>>,
    /// Single-flight gate: ensures only one refresh hits the network at a time
    /// so concurrent requests can't submit the same (rotating) refresh token in
    /// parallel and trip Supabase's reuse detection.
    refresh_lock: Arc<tokio::sync::Mutex<()>>,
    /// Where to persist a rotated refresh token (`~/.amuxd/backend.toml`).
    /// `None` in tests that don't exercise persistence.
    persist_path: Option<PathBuf>,
}

impl CloudApiBackend {
    pub fn new(cfg: CloudApiConfig) -> Self {
        Self::with_optional_persist(cfg, None)
    }

    /// Construct a backend that persists rotated refresh tokens back to
    /// `persist_path` (the `backend.toml` it was loaded from).
    pub fn with_persist_path(cfg: CloudApiConfig, persist_path: PathBuf) -> Self {
        Self::with_optional_persist(cfg, Some(persist_path))
    }

    fn with_optional_persist(cfg: CloudApiConfig, persist_path: Option<PathBuf>) -> Self {
        let refresh_token = cfg.refresh_token.clone();
        Self {
            cfg,
            http: reqwest::Client::new(),
            token: Arc::new(Mutex::new(TokenState {
                refresh_token,
                access_token: None,
                expires_at: None,
            })),
            refresh_lock: Arc::new(tokio::sync::Mutex::new(())),
            persist_path,
        }
    }

    /// Return a valid access token, refreshing only when the cached one is
    /// missing or within `ACCESS_TOKEN_LEEWAY` of expiry.
    pub(super) async fn access_token(&self) -> BackendResult<String> {
        // Fast path: a cached token with comfortable headroom.
        if let Some(token) = self.cached_access_token() {
            return Ok(token);
        }

        // Slow path: serialize refreshes so concurrent callers don't each submit
        // the (about-to-rotate) refresh token in parallel.
        let _guard = self.refresh_lock.lock().await;

        // Re-check: another task may have refreshed while we waited on the gate.
        if let Some(token) = self.cached_access_token() {
            return Ok(token);
        }

        let refresh_token = {
            let state = self.token.lock().expect("token state poisoned");
            state.refresh_token.clone()
        };

        let url = format!("{}/v1/auth/refresh", self.cfg.url.trim_end_matches('/'));
        let resp = self
            .http
            .post(url)
            .json(&RefreshRequest {
                refresh_token: &refresh_token,
            })
            .send()
            .await
            .map_err(network_error)?;

        if !resp.status().is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(BackendError::Auth(refresh_failure_message(&text)));
        }

        let body: TokenResponse = resp.json().await.map_err(network_error)?;

        // Capture the rotated refresh token. Supabase revokes the prior token
        // after the reuse interval, so we must keep (and persist) the new one.
        let rotated = match body.refresh_token {
            Some(ref new_rt) if !new_rt.is_empty() && *new_rt != refresh_token => {
                Some(new_rt.clone())
            }
            _ => None,
        };

        {
            let mut state = self.token.lock().expect("token state poisoned");
            state.access_token = Some(body.access_token.clone());
            state.expires_at = body.expires_at.and_then(instant_from_epoch_secs);
            if let Some(ref new_rt) = rotated {
                state.refresh_token = new_rt.clone();
            }
        }

        if let Some(new_rt) = rotated {
            self.persist_refresh_token(&new_rt);
        }

        Ok(body.access_token)
    }

    /// The cached access token if it is still comfortably valid, else `None`.
    fn cached_access_token(&self) -> Option<String> {
        let state = self.token.lock().expect("token state poisoned");
        match (&state.access_token, state.expires_at) {
            (Some(token), Some(expires_at))
                if Instant::now() + ACCESS_TOKEN_LEEWAY < expires_at =>
            {
                Some(token.clone())
            }
            _ => None,
        }
    }

    /// Best-effort write of a rotated refresh token back to `backend.toml`.
    /// Failure is logged but non-fatal — the in-memory token is still updated,
    /// so the running daemon keeps working; only a restart would lose it.
    fn persist_refresh_token(&self, refresh_token: &str) {
        let Some(path) = self.persist_path.as_ref() else {
            return;
        };
        let cfg = CloudApiConfig {
            url: self.cfg.url.clone(),
            refresh_token: refresh_token.to_string(),
            team_id: self.cfg.team_id.clone(),
            actor_id: self.cfg.actor_id.clone(),
        };
        if let Err(e) = crate::provider_config::ProviderConfig::save_cloud_api(path, &cfg) {
            tracing::warn!(
                error = %e,
                path = %path.display(),
                "failed to persist rotated refresh_token; auth may break after restart"
            );
        }
    }

    pub(super) async fn get<T>(&self, path: &str) -> BackendResult<T>
    where
        T: for<'de> Deserialize<'de>,
    {
        let token = self.access_token().await?;
        let resp = self
            .http
            .get(self.cloud_url(path))
            .bearer_auth(token)
            .header("x-request-id", request_id())
            .send()
            .await
            .map_err(network_error)?;
        decode_response(resp).await
    }

    pub(super) async fn post<Req, Resp>(
        &self,
        path: &str,
        body: &Req,
        idempotency_key: Option<&str>,
    ) -> BackendResult<Resp>
    where
        Req: Serialize + ?Sized,
        Resp: for<'de> Deserialize<'de>,
    {
        let token = self.access_token().await?;
        let mut req = self
            .http
            .post(self.cloud_url(path))
            .bearer_auth(token)
            .header("x-request-id", request_id())
            .json(body);
        if let Some(key) = idempotency_key {
            req = req.header("idempotency-key", key);
        }
        let resp = req.send().await.map_err(network_error)?;
        decode_response(resp).await
    }

    pub(super) async fn patch_no_content<Req>(
        &self,
        path: &str,
        body: &Req,
    ) -> BackendResult<()>
    where
        Req: Serialize + ?Sized,
    {
        let token = self.access_token().await?;
        let resp = self
            .http
            .patch(self.cloud_url(path))
            .bearer_auth(token)
            .header("x-request-id", request_id())
            .json(body)
            .send()
            .await
            .map_err(network_error)?;
        if resp.status().is_success() {
            Ok(())
        } else {
            let status = resp.status();
            let bytes = resp.bytes().await.map_err(network_error)?;
            let envelope = serde_json::from_slice::<client::CloudErrorEnvelope>(&bytes).ok();
            Err(client::decode_error(status, envelope))
        }
    }

    pub(super) async fn put_no_content<Req>(
        &self,
        path: &str,
        body: &Req,
    ) -> BackendResult<()>
    where
        Req: Serialize + ?Sized,
    {
        let token = self.access_token().await?;
        let resp = self
            .http
            .put(self.cloud_url(path))
            .bearer_auth(token)
            .header("x-request-id", request_id())
            .json(body)
            .send()
            .await
            .map_err(network_error)?;
        if resp.status().is_success() {
            Ok(())
        } else {
            let status = resp.status();
            let bytes = resp.bytes().await.map_err(network_error)?;
            let envelope = serde_json::from_slice::<client::CloudErrorEnvelope>(&bytes).ok();
            Err(client::decode_error(status, envelope))
        }
    }

    pub(super) fn cloud_url(&self, path: &str) -> String {
        cloud_url(&self.cfg, path)
    }


}

/// Convert an epoch-seconds expiry into a monotonic `Instant`, clamping to "now"
/// if it is already in the past. Returns `None` for absurd / un-representable
/// values so a malformed response degrades to "refresh on next request".
fn instant_from_epoch_secs(secs: i64) -> Option<Instant> {
    let secs = u64::try_from(secs).ok()?;
    let expires_sys = UNIX_EPOCH.checked_add(Duration::from_secs(secs))?;
    let remaining = expires_sys
        .duration_since(SystemTime::now())
        .unwrap_or(Duration::ZERO);
    Instant::now().checked_add(remaining)
}

#[async_trait]
impl Backend for CloudApiBackend {
    fn team_id(&self) -> &str {
        &self.cfg.team_id
    }

    fn actor_id(&self) -> &str {
        &self.cfg.actor_id
    }

    async fn auth_token(&self) -> BackendResult<String> {
        self.access_token().await
    }

    async fn fetch_bootstrap_mqtt(&self) -> BackendResult<Option<BootstrapMqttOverride>> {
        let payload: BootstrapResponse = self.get("/v1/config/bootstrap").await?;
        Ok(payload.mqtt.map(|m| BootstrapMqttOverride {
            url: m.url,
            username: m.username,
            password: m.password,
        }))
    }

    fn cached_credential_expiry(&self) -> Option<Instant> {
        self.token
            .lock()
            .expect("token state poisoned")
            .expires_at
    }

    async fn claim_team_invite(&self, token: &str) -> BackendResult<ClaimResult> {
        #[derive(serde::Serialize)]
        struct ClaimInviteRequest<'a> {
            token: &'a str,
        }
        #[derive(serde::Deserialize)]
        struct CloudClaimResult {
            #[serde(rename = "actorId")]
            actor_id: String,
            #[serde(rename = "teamId")]
            team_id: String,
            #[serde(rename = "actorType")]
            actor_type: String,
            #[serde(rename = "displayName")]
            display_name: String,
            #[serde(rename = "refreshToken")]
            refresh_token: Option<String>,
        }
        let row: CloudClaimResult = self
            .post("/v1/invites/claim", &ClaimInviteRequest { token }, None)
            .await?;
        Ok(ClaimResult {
            actor_id: row.actor_id,
            team_id: row.team_id,
            actor_type: row.actor_type,
            display_name: row.display_name,
            refresh_token: row.refresh_token,
        })
    }

    async fn upsert_agent_runtime(
        &self,
        row: &AgentRuntimeUpsert<'_>,
    ) -> BackendResult<Option<String>> {
        #[derive(serde::Serialize)]
        struct Body<'a> {
            #[serde(rename = "agentActorId")]
            agent_actor_id: &'a str,
            #[serde(rename = "sessionId", skip_serializing_if = "Option::is_none")]
            session_id: Option<&'a str>,
            #[serde(rename = "runtimeId", skip_serializing_if = "Option::is_none")]
            runtime_id: Option<&'a str>,
            #[serde(rename = "backendSessionId", skip_serializing_if = "Option::is_none")]
            backend_session_id: Option<&'a str>,
            #[serde(rename = "backendType")]
            backend_type: &'a str,
            status: &'a str,
        }
        #[derive(serde::Deserialize)]
        struct Resp {
            id: Option<String>,
        }
        let r: Resp = self
            .post(
                "/v1/agents/runtimes",
                &Body {
                    agent_actor_id: row.agent_id,
                    session_id: row.session_id,
                    runtime_id: row.runtime_id,
                    backend_session_id: row.backend_session_id,
                    backend_type: row.backend_type,
                    status: row.status,
                },
                None,
            )
            .await?;
        Ok(r.id)
    }

    async fn fetch_agent_runtime_for_session(
        &self,
        session_id: &str,
        runtime_id: &str,
        backend_session_id: &str,
    ) -> BackendResult<Option<AgentRuntimeRow>> {
        let path = format!(
            "/v1/agents/runtimes?sessionId={session_id}&runtimeId={runtime_id}&backendSessionId={backend_session_id}"
        );
        match self.get::<CloudAgentRuntime>(&path).await {
            Ok(r) => Ok(Some(r.into_row())),
            Err(BackendError::NotFound(_)) => Ok(None),
            Err(e) => Err(e),
        }
    }

    async fn fetch_latest_runtime_for_session(
        &self,
        agent_id: &str,
        session_id: &str,
    ) -> BackendResult<Option<AgentRuntimeRow>> {
        let path = format!("/v1/agents/runtimes/latest?agentId={agent_id}&sessionId={session_id}");
        match self.get::<CloudAgentRuntime>(&path).await {
            Ok(r) => Ok(Some(r.into_row())),
            Err(BackendError::NotFound(_)) => Ok(None),
            Err(e) => Err(e),
        }
    }

    async fn ensure_agent_types(
        &self,
        supported_types: &[String],
        default_agent_type: &str,
    ) -> BackendResult<()> {
        #[derive(serde::Serialize)]
        struct Body<'a> {
            #[serde(rename = "supportedTypes")]
            supported_types: &'a [String],
            #[serde(rename = "defaultAgentType")]
            default_agent_type: &'a str,
        }
        let token = self.access_token().await?;
        let resp = self
            .http
            .post(self.cloud_url("/v1/agents/types/ensure"))
            .bearer_auth(token)
            .header("x-request-id", request_id())
            .json(&Body { supported_types, default_agent_type })
            .send()
            .await
            .map_err(network_error)?;
        if resp.status().is_success() {
            Ok(())
        } else {
            let status = resp.status();
            let bytes = resp.bytes().await.map_err(network_error)?;
            let envelope = serde_json::from_slice::<client::CloudErrorEnvelope>(&bytes).ok();
            Err(client::decode_error(status, envelope))
        }
    }

    async fn set_agent_device_id(&self, device_id: &str) -> BackendResult<()> {
        #[derive(serde::Serialize)]
        struct Body<'a> {
            #[serde(rename = "deviceId")]
            device_id: &'a str,
        }
        self.put_no_content(
            &format!("/v1/agents/{}/device", self.cfg.actor_id),
            &Body { device_id },
        )
        .await
    }

    async fn check_agent_permission(
        &self,
        agent_id: &str,
        actor_id: &str,
    ) -> BackendResult<Option<String>> {
        #[derive(serde::Deserialize)]
        struct Resp {
            allowed: bool,
            role: Option<String>,
        }
        let r: Resp = self
            .get(&format!(
                "/v1/agents/{agent_id}/permission?actorId={actor_id}"
            ))
            .await?;
        Ok(if r.allowed { r.role } else { None })
    }

    async fn heartbeat(&self) -> BackendResult<()> {
        let token = self.access_token().await?;
        let resp = self
            .http
            .post(self.cloud_url("/v1/heartbeat"))
            .bearer_auth(token)
            .header("x-request-id", request_id())
            .send()
            .await
            .map_err(network_error)?;
        if resp.status().is_success() {
            Ok(())
        } else {
            let status = resp.status();
            let bytes = resp.bytes().await.map_err(network_error)?;
            let envelope = serde_json::from_slice::<client::CloudErrorEnvelope>(&bytes).ok();
            Err(client::decode_error(status, envelope))
        }
    }

    async fn set_agent_default_workspace(&self, workspace_id: &str) -> BackendResult<()> {
        #[derive(serde::Serialize)]
        struct Body<'a> {
            #[serde(rename = "defaultWorkspaceId")]
            default_workspace_id: &'a str,
        }
        self.patch_no_content(
            &format!("/v1/agents/{}/defaults", self.cfg.actor_id),
            &Body {
                default_workspace_id: workspace_id,
            },
        )
        .await
    }

    async fn upsert_workspace(&self, row: &WorkspaceUpsert<'_>) -> BackendResult<WorkspaceRow> {
        #[derive(serde::Serialize)]
        struct Body<'a> {
            #[serde(rename = "teamId")]
            team_id: &'a str,
            name: &'a str,
            #[serde(skip_serializing_if = "Option::is_none")]
            slug: Option<&'a str>,
            archived: bool,
        }
        #[derive(serde::Deserialize)]
        struct Resp {
            id: String,
        }
        let body = Body {
            team_id: row.team_id,
            name: row.name,
            slug: row.path, // path used as slug identifier
            archived: row.archived,
        };
        let r: Resp = self.post("/v1/workspaces", &body, None).await?;
        Ok(WorkspaceRow { id: r.id })
    }

    async fn fetch_session_with_participants(
        &self,
        session_id: &str,
    ) -> BackendResult<BackendSessionAndParticipants> {
        use super::records::{BackendParticipantRow, BackendSessionRow};
        use chrono::{DateTime, Utc};
        #[derive(serde::Deserialize)]
        struct CloudParticipant {
            #[serde(rename = "actorId")]
            actor_id: String,
            #[serde(default)]
            role: Option<String>,
            #[serde(rename = "joinedAt")]
            joined_at: Option<DateTime<Utc>>,
        }
        #[derive(serde::Deserialize)]
        struct CloudSession {
            id: String,
            #[serde(rename = "teamId")]
            team_id: String,
            #[serde(default)]
            title: String,
            #[serde(default)]
            mode: String,
            #[serde(rename = "ideaId", default)]
            idea_id: Option<String>,
            #[serde(rename = "createdAt")]
            created_at: Option<DateTime<Utc>>,
            #[serde(default)]
            participants: Vec<CloudParticipant>,
        }
        let s: CloudSession = self.get(&format!("/v1/sessions/{session_id}")).await?;
        let session_id_str = s.id.clone();
        let session = BackendSessionRow {
            id: s.id,
            team_id: s.team_id,
            created_by_actor_id: None,
            primary_agent_id: None,
            mode: s.mode,
            title: s.title,
            summary: String::new(),
            idea_id: s.idea_id,
            created_at: s.created_at.unwrap_or_else(Utc::now),
        };
        let participants = s
            .participants
            .into_iter()
            .map(|p| BackendParticipantRow {
                session_id: session_id_str.clone(),
                actor_id: p.actor_id,
                role: p.role,
                joined_at: p.joined_at.unwrap_or_else(Utc::now),
            })
            .collect();
        Ok(BackendSessionAndParticipants { session, participants })
    }

    async fn messages_after_cursor(
        &self,
        session_id: &str,
        after_id: Option<&str>,
    ) -> BackendResult<Vec<StoredMessage>> {
        self.messages_after_cursor_impl(session_id, after_id).await
    }

    async fn update_runtime_cursor(
        &self,
        runtime_row_id: &str,
        last_processed_message_id: &str,
    ) -> BackendResult<()> {
        #[derive(serde::Serialize)]
        struct Body<'a> {
            #[serde(rename = "lastProcessedMessageId")]
            last_processed_message_id: &'a str,
        }
        self.patch_no_content(
            &format!("/v1/agents/runtimes/{runtime_row_id}/cursor"),
            &Body { last_processed_message_id },
        )
        .await
    }

    async fn rpc_upsert_external_actor(
        &self,
        team_id: &str,
        source: &str,
        source_id: &str,
        display_name: &str,
    ) -> BackendResult<String> {
        #[derive(serde::Serialize)]
        struct Body<'a> {
            #[serde(rename = "teamId")]
            team_id: &'a str,
            source: &'a str,
            #[serde(rename = "sourceId")]
            source_id: &'a str,
            #[serde(rename = "displayName")]
            display_name: &'a str,
        }
        #[derive(serde::Deserialize)]
        struct Resp {
            #[serde(rename = "actorId")]
            actor_id: String,
        }
        let r: Resp = self
            .post(
                "/v1/actors/external",
                &Body { team_id, source, source_id, display_name },
                None,
            )
            .await?;
        Ok(r.actor_id)
    }

    async fn get_gateway_session_by_acp_id(
        &self,
        acp_session_id: &str,
    ) -> BackendResult<Option<(String, Option<String>)>> {
        #[derive(serde::Deserialize)]
        struct Resp {
            #[serde(rename = "sessionId")]
            session_id: String,
            #[serde(rename = "gatewaySessionId")]
            gateway_session_id: Option<String>,
        }
        match self
            .get::<Resp>(&format!("/v1/sessions/by-acp/{acp_session_id}"))
            .await
        {
            Ok(r) => Ok(Some((r.session_id, r.gateway_session_id))),
            Err(BackendError::NotFound(_)) => Ok(None),
            Err(e) => Err(e),
        }
    }

    async fn rpc_ensure_gateway_session(
        &self,
        team_id: &str,
        binding: &str,
        title: &str,
        primary_agent_actor_id: &str,
        owner_member_actor_ids: &[String],
        participant_actor_ids: &[String],
    ) -> BackendResult<(String, String, bool)> {
        #[derive(serde::Serialize)]
        struct Body<'a> {
            #[serde(rename = "teamId")]
            team_id: &'a str,
            binding: &'a str,
            title: &'a str,
            #[serde(rename = "primaryAgentActorId")]
            primary_agent_actor_id: &'a str,
            #[serde(rename = "ownerMemberActorIds")]
            owner_member_actor_ids: &'a [String],
            #[serde(rename = "participantActorIds")]
            participant_actor_ids: &'a [String],
        }
        #[derive(serde::Deserialize)]
        struct Resp {
            #[serde(rename = "sessionId")]
            session_id: String,
            #[serde(rename = "gatewaySessionId")]
            gateway_session_id: String,
            created: bool,
        }
        let r: Resp = self
            .post(
                "/v1/sessions/gateway/ensure",
                &Body {
                    team_id,
                    binding,
                    title,
                    primary_agent_actor_id,
                    owner_member_actor_ids,
                    participant_actor_ids,
                },
                None,
            )
            .await?;
        Ok((r.session_id, r.gateway_session_id, r.created))
    }

    async fn insert_gateway_message(
        &self,
        session_id: &str,
        sender_actor_id: &str,
        content: &str,
        external_message_id: Option<&str>,
    ) -> BackendResult<String> {
        self.insert_gateway_message_impl(session_id, sender_actor_id, content, external_message_id)
            .await
    }

    async fn insert_gateway_message_with_attachments(
        &self,
        session_id: &str,
        sender_actor_id: &str,
        content: &str,
        external_message_id: Option<&str>,
        attachments: serde_json::Value,
    ) -> BackendResult<String> {
        self.insert_gateway_message_with_attachments_impl(
            session_id,
            sender_actor_id,
            content,
            external_message_id,
            attachments,
        )
        .await
    }

    async fn upload_attachment_bytes(
        &self,
        path: &str,
        bytes: Vec<u8>,
        mime: &str,
    ) -> BackendResult<String> {
        let token = self.access_token().await?;
        let encoded_path: String = url::form_urlencoded::byte_serialize(path.as_bytes()).collect();
        let url = format!(
            "{}/v1/attachments?path={}",
            self.cfg.url.trim_end_matches('/'),
            encoded_path
        );
        let resp = self
            .http
            .post(url)
            .bearer_auth(token)
            .header("content-type", mime)
            .header("x-request-id", request_id())
            .body(bytes)
            .send()
            .await
            .map_err(network_error)?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body_bytes = resp.bytes().await.map_err(network_error)?;
            let envelope =
                serde_json::from_slice::<client::CloudErrorEnvelope>(&body_bytes).ok();
            return Err(client::decode_error(status, envelope));
        }
        #[derive(serde::Deserialize)]
        struct Resp {
            url: String,
        }
        let r: Resp = resp.json().await.map_err(network_error)?;
        Ok(r.url)
    }

    async fn list_agent_admin_member_actor_ids(
        &self,
        agent_actor_id: &str,
    ) -> BackendResult<Vec<String>> {
        #[derive(serde::Deserialize)]
        struct Resp {
            items: Vec<String>,
        }
        let r: Resp = self
            .get(&format!("/v1/agents/{agent_actor_id}/admin-members"))
            .await?;
        Ok(r.items)
    }

    async fn upsert_session_participant(
        &self,
        session_id: &str,
        actor_id: &str,
    ) -> BackendResult<()> {
        #[derive(serde::Serialize)]
        struct Body<'a> {
            #[serde(rename = "actorId")]
            actor_id: &'a str,
            role: &'a str,
        }
        let _: serde_json::Value = self
            .post(
                &format!("/v1/sessions/{session_id}/participants"),
                &Body { actor_id, role: "member" },
                None,
            )
            .await?;
        Ok(())
    }

    async fn create_cron_session(
        &self,
        team_id: &str,
        primary_agent_actor_id: &str,
        title: &str,
    ) -> BackendResult<String> {
        #[derive(serde::Serialize)]
        struct Body<'a> {
            #[serde(rename = "teamId")]
            team_id: &'a str,
            #[serde(rename = "primaryAgentActorId")]
            primary_agent_actor_id: &'a str,
            title: &'a str,
        }
        #[derive(serde::Deserialize)]
        struct Resp {
            #[serde(rename = "sessionId")]
            session_id: String,
        }
        let r: Resp = self
            .post(
                "/v1/sessions/cron",
                &Body { team_id, primary_agent_actor_id, title },
                None,
            )
            .await?;
        Ok(r.session_id)
    }

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
    ) -> BackendResult<()> {
        self.insert_message_impl(
            id,
            team_id,
            session_id,
            sender_actor_id,
            kind,
            content,
            metadata_json,
            model,
            turn_id,
            sequence,
        )
        .await
    }
}

/// Shared response type for agent_runtimes rows returned by the Cloud API.
#[derive(serde::Deserialize)]
struct CloudAgentRuntime {
    id: String,
    #[serde(rename = "backendSessionId", default)]
    backend_session_id: Option<String>,
    #[serde(rename = "lastProcessedMessageId", default)]
    last_processed_message_id: Option<String>,
}

impl CloudAgentRuntime {
    fn into_row(self) -> AgentRuntimeRow {
        AgentRuntimeRow {
            id: self.id,
            workspace_id: None,
            backend_type: String::new(),
            backend_session_id: self.backend_session_id,
            status: String::new(),
            last_processed_message_id: self.last_processed_message_id,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn config(server: &MockServer) -> CloudApiConfig {
        CloudApiConfig {
            url: server.uri(),
            refresh_token: "refresh".to_string(),
            team_id: "team-1".to_string(),
            actor_id: "agent-1".to_string(),
        }
    }

    fn refresh_ok() -> serde_json::Value {
        serde_json::json!({ "accessToken": "access-token", "refreshToken": "rt-2", "expiresAt": 9999999999_i64 })
    }

    async fn mount_refresh(server: &MockServer) {
        Mock::given(method("POST"))
            .and(path("/v1/auth/refresh"))
            .respond_with(ResponseTemplate::new(200).set_body_json(refresh_ok()))
            .mount(server)
            .await;
    }

    #[tokio::test]
    async fn access_token_calls_cloud_api_refresh() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/auth/refresh"))
            .and(wiremock::matchers::body_json(serde_json::json!({ "refreshToken": "refresh" })))
            .respond_with(ResponseTemplate::new(200).set_body_json(refresh_ok()))
            .mount(&server)
            .await;

        let backend = CloudApiBackend::new(config(&server));
        let tok = backend.access_token().await.unwrap();
        assert_eq!(tok, "access-token");
    }

    #[tokio::test]
    async fn access_token_is_cached_until_near_expiry() {
        let server = MockServer::start().await;
        // Far-future expiry → the first refresh should satisfy later calls.
        mount_refresh(&server).await;
        let backend = CloudApiBackend::new(config(&server));

        assert_eq!(backend.access_token().await.unwrap(), "access-token");
        assert_eq!(backend.access_token().await.unwrap(), "access-token");
        assert_eq!(backend.access_token().await.unwrap(), "access-token");

        let refreshes = server
            .received_requests()
            .await
            .unwrap()
            .into_iter()
            .filter(|r| r.url.path() == "/v1/auth/refresh")
            .count();
        assert_eq!(refreshes, 1, "access token should be cached, not re-fetched");
    }

    #[tokio::test]
    async fn access_token_refreshes_again_once_expired() {
        let server = MockServer::start().await;
        // expiresAt in the past → never cacheable, so each call refreshes.
        Mock::given(method("POST"))
            .and(path("/v1/auth/refresh"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "accessToken": "access-token",
                "refreshToken": "refresh",
                "expiresAt": 1_i64
            })))
            .mount(&server)
            .await;
        let backend = CloudApiBackend::new(config(&server));

        backend.access_token().await.unwrap();
        backend.access_token().await.unwrap();

        let refreshes = server
            .received_requests()
            .await
            .unwrap()
            .into_iter()
            .filter(|r| r.url.path() == "/v1/auth/refresh")
            .count();
        assert_eq!(refreshes, 2, "expired token must trigger a fresh refresh");
    }

    #[tokio::test]
    async fn rotated_refresh_token_is_persisted_and_reused() {
        let server = MockServer::start().await;
        // First refresh uses the seed token "refresh", rotates to "rt-rotated",
        // and is immediately expired so the next call must refresh again.
        Mock::given(method("POST"))
            .and(path("/v1/auth/refresh"))
            .and(wiremock::matchers::body_json(
                serde_json::json!({ "refreshToken": "refresh" }),
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "accessToken": "at-1",
                "refreshToken": "rt-rotated",
                "expiresAt": 1_i64
            })))
            .expect(1)
            .mount(&server)
            .await;
        // Second refresh must present the rotated token "rt-rotated".
        Mock::given(method("POST"))
            .and(path("/v1/auth/refresh"))
            .and(wiremock::matchers::body_json(
                serde_json::json!({ "refreshToken": "rt-rotated" }),
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "accessToken": "at-2",
                "refreshToken": "rt-rotated",
                "expiresAt": 9999999999_i64
            })))
            .expect(1)
            .mount(&server)
            .await;

        let dir = tempfile::tempdir().unwrap();
        let backend_path = dir.path().join("backend.toml");
        let backend =
            CloudApiBackend::with_persist_path(config(&server), backend_path.clone());

        assert_eq!(backend.access_token().await.unwrap(), "at-1");

        // Rotated token must have been written back to backend.toml.
        let persisted = std::fs::read_to_string(&backend_path).unwrap();
        assert!(
            persisted.contains(r#"refresh_token = "rt-rotated""#),
            "rotated refresh token should be persisted, got:\n{persisted}"
        );

        // Next call (cache expired) must refresh using the rotated token.
        assert_eq!(backend.access_token().await.unwrap(), "at-2");
        // wiremock `.expect(1)` on both mocks is verified on server drop.
    }

    #[tokio::test]
    async fn concurrent_access_token_calls_refresh_only_once() {
        let server = MockServer::start().await;
        mount_refresh(&server).await;
        let backend = CloudApiBackend::new(config(&server));

        let calls = (0..8).map(|_| {
            let b = backend.clone();
            async move { b.access_token().await.unwrap() }
        });
        let tokens = futures::future::join_all(calls).await;
        assert!(tokens.iter().all(|t| t == "access-token"));

        let refreshes = server
            .received_requests()
            .await
            .unwrap()
            .into_iter()
            .filter(|r| r.url.path() == "/v1/auth/refresh")
            .count();
        assert_eq!(
            refreshes, 1,
            "single-flight should collapse concurrent refreshes into one"
        );
    }

    #[tokio::test]
    async fn claim_invite_uses_refreshed_bearer_against_cloud_api() {
        let server = MockServer::start().await;
        mount_refresh(&server).await;
        Mock::given(method("POST"))
            .and(path("/v1/invites/claim"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "actorId": "agent-1",
                "teamId": "team-1",
                "actorType": "agent",
                "displayName": "Agent",
                "refreshToken": "next-refresh"
            })))
            .mount(&server)
            .await;
        let backend = CloudApiBackend::new(config(&server));

        let result = backend.claim_team_invite("invite-token").await.unwrap();

        assert_eq!(result.actor_id, "agent-1");
        assert_eq!(result.team_id, "team-1");
        let requests = server.received_requests().await.unwrap();
        let claim = requests
            .iter()
            .find(|request| request.url.path() == "/v1/invites/claim")
            .expect("claim request");
        assert_eq!(
            claim
                .headers
                .get("authorization")
                .unwrap()
                .to_str()
                .unwrap(),
            "Bearer access-token"
        );
    }

    #[tokio::test]
    async fn messages_after_cursor_maps_cloud_messages() {
        use chrono::DateTime;
        let server = MockServer::start().await;
        mount_refresh(&server).await;
        Mock::given(method("GET"))
            .and(path("/v1/sessions/session-1/messages"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "items": [
                    {
                        "id": "old-message",
                        "teamId": "team-1",
                        "sessionId": "session-1",
                        "senderActorId": "actor-1",
                        "kind": "text",
                        "content": "old",
                        "metadata": null,
                        "createdAt": "2026-05-27T10:00:00Z"
                    },
                    {
                        "id": "new-message",
                        "teamId": "team-1",
                        "sessionId": "session-1",
                        "senderActorId": "actor-1",
                        "kind": "text",
                        "content": "new",
                        "metadata": { "k": "v" },
                        "createdAt": "2026-05-27T10:01:00Z"
                    }
                ],
                "nextCursor": null
            })))
            .mount(&server)
            .await;
        let backend = CloudApiBackend::new(config(&server));

        let messages = backend
            .messages_after_cursor("session-1", Some("old-message"))
            .await
            .unwrap();

        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].id, "new-message");
        assert_eq!(messages[0].metadata_json, r#"{"k":"v"}"#);
        assert_eq!(
            messages[0].created_at,
            "2026-05-27T10:01:00Z"
                .parse::<DateTime<chrono::Utc>>()
                .unwrap()
                .timestamp()
        );
    }

    #[tokio::test]
    async fn upload_attachment_bytes_returns_url() {
        let server = MockServer::start().await;
        mount_refresh(&server).await;
        Mock::given(method("POST"))
            .and(path("/v1/attachments"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "path": "uploads/file.txt",
                "url": "https://example.com/uploads/file.txt"
            })))
            .mount(&server)
            .await;
        let backend = CloudApiBackend::new(config(&server));
        let url = backend
            .upload_attachment_bytes("uploads/file.txt", b"hello".to_vec(), "text/plain")
            .await
            .unwrap();
        assert_eq!(url, "https://example.com/uploads/file.txt");
    }

    #[tokio::test]
    async fn set_agent_device_id_puts_to_cloud_api() {
        let server = MockServer::start().await;
        mount_refresh(&server).await;
        Mock::given(method("PUT"))
            .and(path("/v1/agents/agent-1/device"))
            .respond_with(ResponseTemplate::new(204))
            .mount(&server)
            .await;
        let backend = CloudApiBackend::new(config(&server));
        backend.set_agent_device_id("device-abc").await.unwrap();
    }

    #[tokio::test]
    async fn set_agent_default_workspace_patches_cloud_api() {
        let server = MockServer::start().await;
        mount_refresh(&server).await;
        Mock::given(method("PATCH"))
            .and(path("/v1/agents/agent-1/defaults"))
            .and(wiremock::matchers::body_json(
                serde_json::json!({ "defaultWorkspaceId": "workspace-remote-1" }),
            ))
            .respond_with(ResponseTemplate::new(204))
            .mount(&server)
            .await;
        let backend = CloudApiBackend::new(config(&server));
        backend
            .set_agent_default_workspace("workspace-remote-1")
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn ensure_agent_types_posts_to_cloud_api() {
        let server = MockServer::start().await;
        mount_refresh(&server).await;
        Mock::given(method("POST"))
            .and(path("/v1/agents/types/ensure"))
            .respond_with(ResponseTemplate::new(204))
            .mount(&server)
            .await;
        let backend = CloudApiBackend::new(config(&server));
        backend
            .ensure_agent_types(
                &["claude_code".to_string(), "shell".to_string()],
                "claude_code",
            )
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn update_runtime_cursor_patches_cloud_api() {
        let server = MockServer::start().await;
        mount_refresh(&server).await;
        Mock::given(method("PATCH"))
            .and(path("/v1/agents/runtimes/runtime-row-1/cursor"))
            .respond_with(ResponseTemplate::new(204))
            .mount(&server)
            .await;
        let backend = CloudApiBackend::new(config(&server));
        backend
            .update_runtime_cursor("runtime-row-1", "msg-10")
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn fetch_latest_runtime_for_session_returns_none_on_404() {
        let server = MockServer::start().await;
        mount_refresh(&server).await;
        Mock::given(method("GET"))
            .and(path("/v1/agents/runtimes/latest"))
            .respond_with(ResponseTemplate::new(404).set_body_json(serde_json::json!({
                "error": { "code": "not_found", "message": "not found" }
            })))
            .mount(&server)
            .await;
        let backend = CloudApiBackend::new(config(&server));
        let row = backend
            .fetch_latest_runtime_for_session("agent-1", "session-1")
            .await
            .unwrap();
        assert!(row.is_none());
    }

    #[tokio::test]
    async fn fetch_agent_runtime_for_session_returns_row() {
        let server = MockServer::start().await;
        mount_refresh(&server).await;
        Mock::given(method("GET"))
            .and(path("/v1/agents/runtimes"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": "runtime-row-1",
                "agentActorId": "agent-1",
                "sessionId": "session-1",
                "runtimeId": "rt-1",
                "backendSessionId": "bs-1",
                "lastProcessedMessageId": "msg-5"
            })))
            .mount(&server)
            .await;
        let backend = CloudApiBackend::new(config(&server));
        let row = backend
            .fetch_agent_runtime_for_session("session-1", "rt-1", "bs-1")
            .await
            .unwrap();
        assert!(row.is_some());
        let row = row.unwrap();
        assert_eq!(row.id, "runtime-row-1");
        assert_eq!(row.last_processed_message_id, Some("msg-5".to_string()));
    }

    #[tokio::test]
    async fn fetch_agent_runtime_for_session_returns_none_on_404() {
        let server = MockServer::start().await;
        mount_refresh(&server).await;
        Mock::given(method("GET"))
            .and(path("/v1/agents/runtimes"))
            .respond_with(ResponseTemplate::new(404).set_body_json(serde_json::json!({
                "error": { "code": "not_found", "message": "not found" }
            })))
            .mount(&server)
            .await;
        let backend = CloudApiBackend::new(config(&server));
        let row = backend
            .fetch_agent_runtime_for_session("session-x", "rt-x", "bs-x")
            .await
            .unwrap();
        assert!(row.is_none());
    }

    #[tokio::test]
    async fn upsert_agent_runtime_returns_id() {
        let server = MockServer::start().await;
        mount_refresh(&server).await;
        Mock::given(method("POST"))
            .and(path("/v1/agents/runtimes"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": "runtime-row-1"
            })))
            .mount(&server)
            .await;
        let backend = CloudApiBackend::new(config(&server));
        let id = backend
            .upsert_agent_runtime(&AgentRuntimeUpsert {
                team_id: "team-1",
                agent_id: "agent-1",
                session_id: Some("session-1"),
                workspace_id: None,
                backend_type: "claude_code",
                backend_session_id: Some("bs-1"),
                runtime_id: Some("rt-1"),
                status: "active",
                current_model: None,
                last_seen_at: chrono::Utc::now(),
            })
            .await
            .unwrap();
        assert_eq!(id, Some("runtime-row-1".to_string()));
    }

    #[tokio::test]
    async fn list_agent_admin_member_actor_ids_returns_items() {
        let server = MockServer::start().await;
        mount_refresh(&server).await;
        Mock::given(method("GET"))
            .and(path("/v1/agents/agent-1/admin-members"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "items": ["actor-admin-1", "actor-admin-2"]
            })))
            .mount(&server)
            .await;
        let backend = CloudApiBackend::new(config(&server));
        let ids = backend
            .list_agent_admin_member_actor_ids("agent-1")
            .await
            .unwrap();
        assert_eq!(ids, vec!["actor-admin-1", "actor-admin-2"]);
    }

    #[tokio::test]
    async fn check_agent_permission_returns_role_when_allowed() {
        let server = MockServer::start().await;
        mount_refresh(&server).await;
        Mock::given(method("GET"))
            .and(path("/v1/agents/agent-1/permission"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "allowed": true,
                "role": "admin"
            })))
            .mount(&server)
            .await;
        let backend = CloudApiBackend::new(config(&server));
        let role = backend
            .check_agent_permission("agent-1", "actor-1")
            .await
            .unwrap();
        assert_eq!(role, Some("admin".to_string()));
    }

    #[tokio::test]
    async fn check_agent_permission_returns_none_when_denied() {
        let server = MockServer::start().await;
        mount_refresh(&server).await;
        Mock::given(method("GET"))
            .and(path("/v1/agents/agent-1/permission"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "allowed": false,
                "role": null
            })))
            .mount(&server)
            .await;
        let backend = CloudApiBackend::new(config(&server));
        let role = backend
            .check_agent_permission("agent-1", "actor-no-access")
            .await
            .unwrap();
        assert!(role.is_none());
    }

    #[tokio::test]
    async fn rpc_upsert_external_actor_returns_actor_id() {
        let server = MockServer::start().await;
        mount_refresh(&server).await;
        Mock::given(method("POST"))
            .and(path("/v1/actors/external"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "actorId": "actor-ext-1"
            })))
            .mount(&server)
            .await;
        let backend = CloudApiBackend::new(config(&server));
        let actor_id = backend
            .rpc_upsert_external_actor("team-1", "wecom", "wecom-user-1", "Alice")
            .await
            .unwrap();
        assert_eq!(actor_id, "actor-ext-1");
    }

    #[tokio::test]
    async fn create_cron_session_returns_session_id() {
        let server = MockServer::start().await;
        mount_refresh(&server).await;
        Mock::given(method("POST"))
            .and(path("/v1/sessions/cron"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "sessionId": "session-cron-1"
            })))
            .mount(&server)
            .await;
        let backend = CloudApiBackend::new(config(&server));
        let session_id = backend
            .create_cron_session("team-1", "agent-1", "Daily summary")
            .await
            .unwrap();
        assert_eq!(session_id, "session-cron-1");
    }

    #[tokio::test]
    async fn rpc_ensure_gateway_session_posts_to_cloud_api() {
        let server = MockServer::start().await;
        mount_refresh(&server).await;
        Mock::given(method("POST"))
            .and(path("/v1/sessions/gateway/ensure"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "sessionId": "session-1",
                "gatewaySessionId": "gw-1",
                "created": true
            })))
            .mount(&server)
            .await;
        let backend = CloudApiBackend::new(config(&server));
        let (session_id, gw_id, created) = backend
            .rpc_ensure_gateway_session("team-1", "wecom:room#1", "Stand-up", "agent-1", &[], &[])
            .await
            .unwrap();
        assert_eq!(session_id, "session-1");
        assert_eq!(gw_id, "gw-1");
        assert!(created);
    }

    #[tokio::test]
    async fn get_gateway_session_by_acp_id_returns_none_on_404() {
        let server = MockServer::start().await;
        mount_refresh(&server).await;
        Mock::given(method("GET"))
            .and(path("/v1/sessions/by-acp/acp-missing"))
            .respond_with(ResponseTemplate::new(404).set_body_json(serde_json::json!({
                "error": { "code": "not_found", "message": "not found" }
            })))
            .mount(&server)
            .await;
        let backend = CloudApiBackend::new(config(&server));
        let result = backend
            .get_gateway_session_by_acp_id("acp-missing")
            .await
            .unwrap();
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn get_gateway_session_by_acp_id_returns_ids() {
        let server = MockServer::start().await;
        mount_refresh(&server).await;
        Mock::given(method("GET"))
            .and(path("/v1/sessions/by-acp/acp-1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "sessionId": "session-1",
                "gatewaySessionId": "gw-1"
            })))
            .mount(&server)
            .await;
        let backend = CloudApiBackend::new(config(&server));
        let result = backend
            .get_gateway_session_by_acp_id("acp-1")
            .await
            .unwrap();
        assert_eq!(result, Some(("session-1".to_string(), Some("gw-1".to_string()))));
    }

    #[tokio::test]
    async fn upsert_session_participant_posts_to_cloud_api() {
        let server = MockServer::start().await;
        mount_refresh(&server).await;
        Mock::given(method("POST"))
            .and(path("/v1/sessions/session-1/participants"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "actorId": "actor-2", "role": "member"
            })))
            .mount(&server)
            .await;
        let backend = CloudApiBackend::new(config(&server));
        backend
            .upsert_session_participant("session-1", "actor-2")
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn fetch_session_with_participants_maps_response() {
        let server = MockServer::start().await;
        mount_refresh(&server).await;
        Mock::given(method("GET"))
            .and(path("/v1/sessions/session-1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": "session-1",
                "teamId": "team-1",
                "title": "Daily",
                "mode": "solo",
                "ideaId": null,
                "createdAt": "2026-01-01T00:00:00Z",
                "participants": [
                    { "actorId": "actor-1", "role": "admin", "joinedAt": "2026-01-01T00:00:00Z" }
                ]
            })))
            .mount(&server)
            .await;
        let backend = CloudApiBackend::new(config(&server));
        let result = backend
            .fetch_session_with_participants("session-1")
            .await
            .unwrap();
        assert_eq!(result.session.id, "session-1");
        assert_eq!(result.participants.len(), 1);
        assert_eq!(result.participants[0].actor_id, "actor-1");
    }

    #[tokio::test]
    async fn upsert_workspace_posts_to_cloud_api() {
        let server = MockServer::start().await;
        mount_refresh(&server).await;
        Mock::given(method("POST"))
            .and(path("/v1/workspaces"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": "ws-1",
                "teamId": "team-1",
                "name": "My Workspace",
                "slug": null,
                "archived": false,
                "createdAt": "2026-01-01T00:00:00Z",
                "updatedAt": "2026-01-01T00:00:00Z"
            })))
            .mount(&server)
            .await;
        let backend = CloudApiBackend::new(config(&server));
        let row = backend
            .upsert_workspace(&WorkspaceUpsert {
                team_id: "team-1",
                agent_id: "agent-1",
                name: "My Workspace",
                path: None,
                archived: false,
            })
            .await
            .unwrap();
        assert_eq!(row.id, "ws-1");
    }

    #[tokio::test]
    async fn heartbeat_posts_to_cloud_api() {
        let server = MockServer::start().await;
        mount_refresh(&server).await;
        Mock::given(method("POST"))
            .and(path("/v1/heartbeat"))
            .respond_with(ResponseTemplate::new(204))
            .mount(&server)
            .await;
        let backend = CloudApiBackend::new(config(&server));
        backend.heartbeat().await.unwrap();
    }
}
