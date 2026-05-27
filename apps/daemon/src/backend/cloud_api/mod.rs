mod auth;
mod client;
mod gateway;
mod messages;

use super::{
    AgentRuntimeRow, AgentRuntimeUpsert, Backend, BackendError, BackendResult,
    BackendSessionAndParticipants, ClaimResult, StoredMessage, WorkspaceRow, WorkspaceUpsert,
};
use crate::provider_config::CloudApiConfig;
use async_trait::async_trait;
use client::{
    cloud_url, decode_response, network_error, refresh_failure_message, request_id,
    RefreshRequest, TokenResponse,
};
use serde::{Deserialize, Serialize};
use std::time::Instant;

#[derive(Clone)]
pub struct CloudApiBackend {
    pub(super) cfg: CloudApiConfig,
    pub(super) http: reqwest::Client,
}

impl CloudApiBackend {
    pub fn new(cfg: CloudApiConfig) -> Self {
        Self {
            cfg,
            http: reqwest::Client::new(),
        }
    }

    /// Obtain a fresh access token via `/v1/auth/refresh`.
    pub(super) async fn access_token(&self) -> BackendResult<String> {
        let url = format!(
            "{}/v1/auth/refresh",
            self.cfg.url.trim_end_matches('/')
        );
        let resp = self
            .http
            .post(url)
            .json(&RefreshRequest {
                refresh_token: &self.cfg.refresh_token,
            })
            .send()
            .await
            .map_err(network_error)?;

        if !resp.status().is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(BackendError::Auth(refresh_failure_message(&text)));
        }

        let body: TokenResponse = resp.json().await.map_err(network_error)?;
        Ok(body.access_token)
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

    fn unsupported<T>(&self, operation: &str) -> BackendResult<T> {
        Err(BackendError::Provider {
            provider: "cloud_api",
            code: Some("not_implemented".to_string()),
            message: format!("{operation} is not covered by the Phase 1 Cloud API contract"),
        })
    }
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

    fn cached_credential_expiry(&self) -> Option<Instant> {
        None
    }

    async fn claim_team_invite(&self, token: &str) -> BackendResult<ClaimResult> {
        self.claim_invite_impl(token).await
    }

    async fn upsert_agent_runtime(
        &self,
        _row: &AgentRuntimeUpsert<'_>,
    ) -> BackendResult<Option<String>> {
        self.unsupported("upsert_agent_runtime")
    }

    async fn fetch_agent_runtime_for_session(
        &self,
        _session_id: &str,
        _runtime_id: &str,
        _backend_session_id: &str,
    ) -> BackendResult<Option<AgentRuntimeRow>> {
        self.unsupported("fetch_agent_runtime_for_session")
    }

    async fn fetch_latest_runtime_for_session(
        &self,
        _agent_id: &str,
        _session_id: &str,
    ) -> BackendResult<Option<AgentRuntimeRow>> {
        self.unsupported("fetch_latest_runtime_for_session")
    }

    async fn ensure_agent_types(
        &self,
        _supported_types: &[String],
        _default_agent_type: &str,
    ) -> BackendResult<()> {
        self.unsupported("ensure_agent_types")
    }

    async fn set_agent_device_id(&self, _device_id: &str) -> BackendResult<()> {
        self.unsupported("set_agent_device_id")
    }

    async fn check_agent_permission(
        &self,
        _agent_id: &str,
        _actor_id: &str,
    ) -> BackendResult<Option<String>> {
        self.unsupported("check_agent_permission")
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
        _runtime_row_id: &str,
        _last_processed_message_id: &str,
    ) -> BackendResult<()> {
        self.unsupported("update_runtime_cursor")
    }

    async fn rpc_upsert_external_actor(
        &self,
        _team_id: &str,
        _source: &str,
        _source_id: &str,
        _display_name: &str,
    ) -> BackendResult<String> {
        self.unsupported("rpc_upsert_external_actor")
    }

    async fn get_gateway_session_by_acp_id(
        &self,
        _acp_session_id: &str,
    ) -> BackendResult<Option<(String, Option<String>)>> {
        self.unsupported("get_gateway_session_by_acp_id")
    }

    async fn rpc_ensure_gateway_session(
        &self,
        _team_id: &str,
        _binding: &str,
        _title: &str,
        _primary_agent_actor_id: &str,
        _owner_member_actor_ids: &[String],
        _participant_actor_ids: &[String],
    ) -> BackendResult<(String, String, bool)> {
        self.unsupported("rpc_ensure_gateway_session")
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
        _path: &str,
        _bytes: Vec<u8>,
        _mime: &str,
    ) -> BackendResult<String> {
        self.unsupported("upload_attachment_bytes")
    }

    async fn list_agent_admin_member_actor_ids(
        &self,
        _agent_actor_id: &str,
    ) -> BackendResult<Vec<String>> {
        self.unsupported("list_agent_admin_member_actor_ids")
    }

    async fn upsert_session_participant(
        &self,
        _session_id: &str,
        _actor_id: &str,
    ) -> BackendResult<()> {
        self.unsupported("upsert_session_participant")
    }

    async fn create_cron_session(
        &self,
        _team_id: &str,
        _primary_agent_actor_id: &str,
        _title: &str,
    ) -> BackendResult<String> {
        self.unsupported("create_cron_session")
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

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn config(server: &MockServer) -> CloudApiConfig {
        CloudApiConfig {
            url: server.uri(),
            supabase_url: server.uri(),
            supabase_anon_key: "anon".to_string(),
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
