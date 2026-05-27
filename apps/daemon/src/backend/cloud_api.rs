use super::{
    AgentRuntimeRow, AgentRuntimeUpsert, Backend, BackendError, BackendResult,
    BackendSessionAndParticipants, ClaimResult, StoredMessage, WorkspaceRow, WorkspaceUpsert,
};
use crate::provider_config::CloudApiConfig;
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Instant;

#[derive(Clone)]
pub struct CloudApiBackend {
    cfg: CloudApiConfig,
    http: reqwest::Client,
}

impl CloudApiBackend {
    pub fn new(cfg: CloudApiConfig) -> Self {
        Self {
            cfg,
            http: reqwest::Client::new(),
        }
    }

    async fn access_token(&self) -> BackendResult<String> {
        let url = format!(
            "{}/auth/v1/token?grant_type=refresh_token",
            self.cfg.supabase_url.trim_end_matches('/')
        );
        let resp = self
            .http
            .post(url)
            .header("apikey", &self.cfg.supabase_anon_key)
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

    async fn get<T>(&self, path: &str) -> BackendResult<T>
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

    async fn post<Req, Resp>(
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

    fn cloud_url(&self, path: &str) -> String {
        format!(
            "{}{}",
            self.cfg.url.trim_end_matches('/'),
            if path.starts_with('/') {
                path.to_string()
            } else {
                format!("/{path}")
            }
        )
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
        self.unsupported("heartbeat")
    }

    async fn upsert_workspace(&self, _row: &WorkspaceUpsert<'_>) -> BackendResult<WorkspaceRow> {
        self.unsupported("upsert_workspace")
    }

    async fn fetch_session_with_participants(
        &self,
        _session_id: &str,
    ) -> BackendResult<BackendSessionAndParticipants> {
        self.unsupported("fetch_session_with_participants")
    }

    async fn messages_after_cursor(
        &self,
        session_id: &str,
        after_id: Option<&str>,
    ) -> BackendResult<Vec<StoredMessage>> {
        let page: CloudPage<CloudMessage> = self
            .get(&format!("/v1/sessions/{session_id}/messages"))
            .await?;
        let mut seen_cursor = after_id.is_none();
        let mut out = Vec::new();
        for row in page.items {
            if !seen_cursor {
                seen_cursor = Some(row.id.as_str()) == after_id;
                continue;
            }
            out.push(row.into_stored_message()?);
        }
        Ok(out)
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
        let id = external_message_id
            .map(str::to_string)
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let message: CloudMessage = self
            .post(
                &format!("/v1/sessions/{session_id}/messages"),
                &InsertMessageRequest {
                    id: &id,
                    team_id: &self.cfg.team_id,
                    sender_actor_id,
                    content,
                    kind: "text",
                    metadata: None,
                    turn_id: None,
                    reply_to_message_id: None,
                    model: None,
                    created_at: None,
                },
                Some(&id),
            )
            .await?;
        Ok(message.id)
    }

    async fn insert_gateway_message_with_attachments(
        &self,
        session_id: &str,
        sender_actor_id: &str,
        content: &str,
        external_message_id: Option<&str>,
        attachments: Value,
    ) -> BackendResult<String> {
        let id = external_message_id
            .map(str::to_string)
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let metadata = serde_json::json!({ "attachments": attachments });
        let message: CloudMessage = self
            .post(
                &format!("/v1/sessions/{session_id}/messages"),
                &InsertMessageRequest {
                    id: &id,
                    team_id: &self.cfg.team_id,
                    sender_actor_id,
                    content,
                    kind: "text",
                    metadata: Some(metadata),
                    turn_id: None,
                    reply_to_message_id: None,
                    model: None,
                    created_at: None,
                },
                Some(&id),
            )
            .await?;
        Ok(message.id)
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
        let metadata = serde_json::from_str(metadata_json).unwrap_or(Value::Null);
        let metadata = match metadata {
            Value::Object(mut object) => {
                object.insert("sequence".to_string(), Value::from(sequence));
                Some(Value::Object(object))
            }
            Value::Null => Some(serde_json::json!({ "sequence": sequence })),
            other => Some(serde_json::json!({ "value": other, "sequence": sequence })),
        };
        let _: CloudMessage = self
            .post(
                &format!("/v1/sessions/{session_id}/messages"),
                &InsertMessageRequest {
                    id,
                    team_id,
                    sender_actor_id,
                    content,
                    kind,
                    metadata,
                    turn_id: empty_to_none(turn_id),
                    reply_to_message_id: None,
                    model: empty_to_none(model),
                    created_at: None,
                },
                Some(id),
            )
            .await?;
        Ok(())
    }
}

#[derive(Serialize)]
struct RefreshRequest<'a> {
    refresh_token: &'a str,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
}

#[derive(Serialize)]
struct ClaimInviteRequest<'a> {
    token: &'a str,
}

#[derive(Deserialize)]
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

#[derive(Deserialize)]
struct CloudPage<T> {
    items: Vec<T>,
}

#[derive(Debug, Deserialize)]
struct CloudMessage {
    id: String,
    #[serde(rename = "sessionId")]
    session_id: String,
    #[serde(rename = "senderActorId")]
    sender_actor_id: Option<String>,
    kind: String,
    content: String,
    metadata: Option<Value>,
    #[serde(rename = "createdAt")]
    created_at: DateTime<Utc>,
}

impl CloudMessage {
    fn into_stored_message(self) -> BackendResult<StoredMessage> {
        Ok(StoredMessage {
            id: self.id,
            session_id: self.session_id,
            sender_actor_id: self.sender_actor_id.unwrap_or_default(),
            kind: self.kind,
            content: self.content,
            metadata_json: serde_json::to_string(&self.metadata.unwrap_or(Value::Null))?,
            created_at: self.created_at.timestamp(),
        })
    }
}

#[derive(Serialize)]
struct InsertMessageRequest<'a> {
    id: &'a str,
    #[serde(rename = "teamId")]
    team_id: &'a str,
    #[serde(rename = "senderActorId")]
    sender_actor_id: &'a str,
    content: &'a str,
    kind: &'a str,
    metadata: Option<Value>,
    #[serde(rename = "turnId")]
    turn_id: Option<&'a str>,
    #[serde(rename = "replyToMessageId")]
    reply_to_message_id: Option<&'a str>,
    model: Option<&'a str>,
    #[serde(rename = "createdAt")]
    created_at: Option<&'a str>,
}

#[derive(Deserialize)]
struct CloudErrorEnvelope {
    error: CloudErrorBody,
}

#[derive(Deserialize)]
struct CloudErrorBody {
    code: Option<String>,
    message: String,
}

async fn decode_response<T>(resp: reqwest::Response) -> BackendResult<T>
where
    T: for<'de> Deserialize<'de>,
{
    let status = resp.status();
    let bytes = resp.bytes().await.map_err(network_error)?;
    if status.is_success() {
        return serde_json::from_slice(&bytes).map_err(BackendError::from);
    }

    let envelope = serde_json::from_slice::<CloudErrorEnvelope>(&bytes).ok();
    Err(map_cloud_error(status, envelope))
}

fn map_cloud_error(status: StatusCode, envelope: Option<CloudErrorEnvelope>) -> BackendError {
    if status == StatusCode::UNAUTHORIZED {
        return BackendError::Auth(
            envelope
                .map(|e| e.error.message)
                .unwrap_or_else(|| "Cloud API unauthorized".to_string()),
        );
    }

    BackendError::Provider {
        provider: "cloud_api",
        code: envelope.as_ref().and_then(|e| e.error.code.clone()),
        message: envelope
            .map(|e| e.error.message)
            .unwrap_or_else(|| format!("Cloud API request failed with status {status}")),
    }
}

fn network_error(error: reqwest::Error) -> BackendError {
    BackendError::Provider {
        provider: "cloud_api",
        code: None,
        message: error.to_string(),
    }
}

fn refresh_failure_message(body: &str) -> String {
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| {
            value
                .get("error_description")
                .or_else(|| value.get("msg"))
                .or_else(|| value.get("message"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .filter(|message| !message.trim().is_empty())
        .unwrap_or_else(|| "failed to refresh Supabase access token".to_string())
}

fn request_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

fn empty_to_none(value: &str) -> Option<&str> {
    if value.trim().is_empty() {
        None
    } else {
        Some(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn claim_invite_uses_refreshed_bearer_against_cloud_api() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/auth/v1/token"))
            .and(query_param("grant_type", "refresh_token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token": "access-token"
            })))
            .mount(&server)
            .await;
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
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/auth/v1/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token": "access-token"
            })))
            .mount(&server)
            .await;
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
                .parse::<DateTime<Utc>>()
                .unwrap()
                .timestamp()
        );
    }

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
}
