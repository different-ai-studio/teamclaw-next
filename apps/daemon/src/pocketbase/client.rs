use crate::backend::{
    AgentRuntimeRow, AgentRuntimeUpsert, Backend, BackendError, BackendResult,
    BackendSessionAndParticipants, ClaimResult, StoredMessage, WorkspaceRow, WorkspaceUpsert,
};
use crate::pocketbase::config::PocketBaseConfig;
use crate::pocketbase::error::{PocketBaseError, PocketBaseResult};
use crate::pocketbase::records::AuthRefreshResponse;
use async_trait::async_trait;
use reqwest::Client;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::Mutex as AsyncMutex;

const AUTH_COLLECTION: &str = "accounts";

#[derive(Debug, Default)]
struct AuthState {
    access_token: Option<String>,
    refresh_token: String,
}

#[derive(Debug, Clone)]
pub struct PocketBaseBackend {
    http: Client,
    cfg: PocketBaseConfig,
    state: Arc<Mutex<AuthState>>,
    refresh_lock: Arc<AsyncMutex<()>>,
}

impl PocketBaseBackend {
    pub fn new(mut cfg: PocketBaseConfig) -> PocketBaseResult<Self> {
        cfg.url = cfg.url.trim().trim_end_matches('/').to_string();
        cfg.refresh_token = cfg.refresh_token.trim().to_string();
        cfg.team_id = cfg.team_id.trim().to_string();
        cfg.actor_id = cfg.actor_id.trim().to_string();

        if cfg.url.is_empty() {
            return Err(PocketBaseError::Config("PocketBase URL is required".to_string()));
        }
        if cfg.refresh_token.is_empty() {
            return Err(PocketBaseError::Config(
                "PocketBase refresh token is required".to_string(),
            ));
        }
        if cfg.team_id.is_empty() {
            return Err(PocketBaseError::Config("PocketBase team_id is required".to_string()));
        }
        if cfg.actor_id.is_empty() {
            return Err(PocketBaseError::Config(
                "PocketBase actor_id is required".to_string(),
            ));
        }

        let http = Client::builder().timeout(Duration::from_secs(20)).build()?;
        let state = AuthState {
            refresh_token: cfg.refresh_token.clone(),
            ..Default::default()
        };

        Ok(Self {
            http,
            cfg,
            state: Arc::new(Mutex::new(state)),
            refresh_lock: Arc::new(AsyncMutex::new(())),
        })
    }

    fn auth_refresh_url(&self) -> String {
        format!(
            "{}/api/collections/{}/auth-refresh",
            self.cfg.url, AUTH_COLLECTION
        )
    }

    async fn refresh(&self) -> PocketBaseResult<String> {
        let _guard = self.refresh_lock.lock().await;

        {
            let state = self.state.lock().unwrap();
            if let Some(token) = &state.access_token {
                return Ok(token.clone());
            }
        }

        let refresh_token = { self.state.lock().unwrap().refresh_token.clone() };
        let response = self
            .http
            .post(self.auth_refresh_url())
            .bearer_auth(&refresh_token)
            .send()
            .await?;

        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            return Err(PocketBaseError::Provider {
                code: Some(status.as_u16().to_string()),
                message: format!("auth-refresh failed: {text}"),
            });
        }

        let body: AuthRefreshResponse = response.json().await?;
        if body.token.is_empty() {
            return Err(PocketBaseError::Auth(
                "auth-refresh returned an empty token".to_string(),
            ));
        }

        {
            let mut state = self.state.lock().unwrap();
            state.access_token = Some(body.token.clone());
            state.refresh_token = body.token.clone();
        }

        Ok(body.token)
    }
}

fn unsupported<T>(operation: &str) -> BackendResult<T> {
    Err(BackendError::Provider {
        provider: "pocketbase",
        code: Some("unsupported".to_string()),
        message: format!("PocketBase {operation} is not implemented in phase 1"),
    })
}

#[async_trait]
impl Backend for PocketBaseBackend {
    fn team_id(&self) -> &str {
        &self.cfg.team_id
    }

    fn actor_id(&self) -> &str {
        &self.cfg.actor_id
    }

    async fn auth_token(&self) -> BackendResult<String> {
        self.refresh().await.map_err(BackendError::from)
    }

    async fn claim_team_invite(&self, _token: &str) -> BackendResult<ClaimResult> {
        unsupported("claim_team_invite")
    }

    async fn upsert_agent_runtime(
        &self,
        _row: &AgentRuntimeUpsert<'_>,
    ) -> BackendResult<Option<String>> {
        unsupported("upsert_agent_runtime")
    }

    async fn fetch_agent_runtime_for_session(
        &self,
        _session_id: &str,
        _runtime_id: &str,
        _backend_session_id: &str,
    ) -> BackendResult<Option<AgentRuntimeRow>> {
        unsupported("fetch_agent_runtime_for_session")
    }

    async fn fetch_latest_runtime_for_session(
        &self,
        _agent_id: &str,
        _session_id: &str,
    ) -> BackendResult<Option<AgentRuntimeRow>> {
        unsupported("fetch_latest_runtime_for_session")
    }

    async fn ensure_agent_types(
        &self,
        _supported_types: &[String],
        _default_agent_type: &str,
    ) -> BackendResult<()> {
        Ok(())
    }

    async fn set_agent_device_id(&self, _device_id: &str) -> BackendResult<()> {
        Ok(())
    }

    async fn check_agent_permission(
        &self,
        _agent_id: &str,
        _actor_id: &str,
    ) -> BackendResult<Option<String>> {
        unsupported("check_agent_permission")
    }

    async fn heartbeat(&self) -> BackendResult<()> {
        Ok(())
    }

    async fn upsert_workspace(&self, _row: &WorkspaceUpsert<'_>) -> BackendResult<WorkspaceRow> {
        unsupported("upsert_workspace")
    }

    async fn fetch_session_with_participants(
        &self,
        _session_id: &str,
    ) -> BackendResult<BackendSessionAndParticipants> {
        unsupported("fetch_session_with_participants")
    }

    async fn messages_after_cursor(
        &self,
        _session_id: &str,
        _after_id: Option<&str>,
    ) -> BackendResult<Vec<StoredMessage>> {
        unsupported("messages_after_cursor")
    }

    async fn update_runtime_cursor(
        &self,
        _runtime_row_id: &str,
        _last_processed_message_id: &str,
    ) -> BackendResult<()> {
        unsupported("update_runtime_cursor")
    }

    async fn rpc_upsert_external_actor(
        &self,
        _team_id: &str,
        _source: &str,
        _source_id: &str,
        _display_name: &str,
    ) -> BackendResult<String> {
        unsupported("rpc_upsert_external_actor")
    }

    async fn get_gateway_session_by_acp_id(
        &self,
        _acp_session_id: &str,
    ) -> BackendResult<Option<(String, Option<String>)>> {
        unsupported("get_gateway_session_by_acp_id")
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
        unsupported("rpc_ensure_gateway_session")
    }

    async fn insert_gateway_message(
        &self,
        _session_id: &str,
        _sender_actor_id: &str,
        _content: &str,
        _external_message_id: Option<&str>,
    ) -> BackendResult<String> {
        unsupported("insert_gateway_message")
    }

    async fn insert_gateway_message_with_attachments(
        &self,
        _session_id: &str,
        _sender_actor_id: &str,
        _content: &str,
        _external_message_id: Option<&str>,
        _attachments: serde_json::Value,
    ) -> BackendResult<String> {
        unsupported("insert_gateway_message_with_attachments")
    }

    async fn upload_attachment_bytes(
        &self,
        _path: &str,
        _bytes: Vec<u8>,
        _mime: &str,
    ) -> BackendResult<String> {
        unsupported("upload_attachment_bytes")
    }

    async fn list_agent_admin_member_actor_ids(
        &self,
        _agent_actor_id: &str,
    ) -> BackendResult<Vec<String>> {
        unsupported("list_agent_admin_member_actor_ids")
    }

    async fn upsert_session_participant(
        &self,
        _session_id: &str,
        _actor_id: &str,
    ) -> BackendResult<()> {
        unsupported("upsert_session_participant")
    }

    async fn create_cron_session(
        &self,
        _team_id: &str,
        _primary_agent_actor_id: &str,
        _title: &str,
    ) -> BackendResult<String> {
        unsupported("create_cron_session")
    }

    async fn insert_message(
        &self,
        _id: &str,
        _team_id: &str,
        _session_id: &str,
        _sender_actor_id: &str,
        _kind: &str,
        _content: &str,
        _metadata_json: &str,
        _model: &str,
        _turn_id: &str,
        _sequence: u64,
    ) -> BackendResult<()> {
        unsupported("insert_message")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn test_config(url: String) -> PocketBaseConfig {
        PocketBaseConfig {
            url,
            refresh_token: "seed-token".to_string(),
            team_id: "team-test".to_string(),
            actor_id: "agent-actor".to_string(),
        }
    }

    #[tokio::test]
    async fn auth_token_refreshes_accounts_token_once() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/collections/accounts/auth-refresh"))
            .and(header("authorization", "Bearer seed-token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "token": "fresh-token",
                "record": { "id": "account-1" }
            })))
            .expect(1)
            .mount(&server)
            .await;
        let backend = PocketBaseBackend::new(test_config(server.uri())).unwrap();

        assert_eq!(backend.auth_token().await.unwrap(), "fresh-token");
        assert_eq!(backend.auth_token().await.unwrap(), "fresh-token");
    }

    #[tokio::test]
    async fn unsupported_business_methods_return_pocketbase_provider_error() {
        let backend = PocketBaseBackend::new(test_config("http://127.0.0.1:8090".to_string()))
            .unwrap();

        let err = backend
            .messages_after_cursor("session-1", None)
            .await
            .expect_err("messages are not implemented in the shell");

        match err {
            BackendError::Provider {
                provider,
                code,
                message,
            } => {
                assert_eq!(provider, "pocketbase");
                assert_eq!(code.as_deref(), Some("unsupported"));
                assert!(message.contains("messages_after_cursor"));
            }
            other => panic!("expected provider error, got {other:?}"),
        }
    }
}
