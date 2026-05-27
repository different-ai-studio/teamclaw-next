use crate::backend::{
    AgentRuntimeRow, AgentRuntimeUpsert, Backend, BackendError, BackendParticipantRow,
    BackendResult, BackendSessionAndParticipants, BackendSessionRow, ClaimResult, StoredMessage,
    WorkspaceRow, WorkspaceUpsert,
};
use crate::pocketbase::config::PocketBaseConfig;
use crate::pocketbase::error::{PocketBaseError, PocketBaseResult};
use crate::pocketbase::records::AuthRefreshResponse;
use async_trait::async_trait;
use reqwest::Client;
use serde::de::DeserializeOwned;
use serde::Deserialize;
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
            return Err(PocketBaseError::Config(
                "PocketBase URL is required".to_string(),
            ));
        }
        if cfg.refresh_token.is_empty() {
            return Err(PocketBaseError::Config(
                "PocketBase refresh token is required".to_string(),
            ));
        }
        if cfg.team_id.is_empty() {
            return Err(PocketBaseError::Config(
                "PocketBase team_id is required".to_string(),
            ));
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

    async fn decode_response<T: DeserializeOwned>(
        response: reqwest::Response,
        operation: &str,
    ) -> PocketBaseResult<T> {
        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            return Err(PocketBaseError::Provider {
                code: Some(status.as_u16().to_string()),
                message: format!("{operation}: {text}"),
            });
        }
        response.json::<T>().await.map_err(PocketBaseError::from)
    }

    async fn list_records<T: DeserializeOwned>(
        &self,
        collection: &str,
        filter: Option<String>,
        sort: Option<&str>,
        per_page: usize,
        operation: &str,
    ) -> BackendResult<Vec<T>> {
        let token = self.refresh().await?;
        let url = format!("{}/api/collections/{collection}/records", self.cfg.url);
        let mut query = vec![("page", "1".to_string()), ("perPage", per_page.to_string())];
        if let Some(filter) = filter {
            query.push(("filter", filter));
        }
        if let Some(sort) = sort {
            query.push(("sort", sort.to_string()));
        }
        let response = self
            .http
            .get(url)
            .bearer_auth(token)
            .query(&query)
            .send()
            .await
            .map_err(PocketBaseError::from)?;
        let body: PbList<T> = Self::decode_response(response, operation).await?;
        Ok(body.items)
    }

    async fn create_record<T: DeserializeOwned>(
        &self,
        collection: &str,
        body: serde_json::Value,
        operation: &str,
    ) -> BackendResult<T> {
        let token = self.refresh().await?;
        let url = format!("{}/api/collections/{collection}/records", self.cfg.url);
        let response = self
            .http
            .post(url)
            .bearer_auth(token)
            .json(&body)
            .send()
            .await
            .map_err(PocketBaseError::from)?;
        Ok(Self::decode_response(response, operation).await?)
    }

    async fn update_record<T: DeserializeOwned>(
        &self,
        collection: &str,
        id: &str,
        body: serde_json::Value,
        operation: &str,
    ) -> BackendResult<T> {
        let token = self.refresh().await?;
        let url = format!("{}/api/collections/{collection}/records/{id}", self.cfg.url);
        let response = self
            .http
            .patch(url)
            .bearer_auth(token)
            .json(&body)
            .send()
            .await
            .map_err(PocketBaseError::from)?;
        Ok(Self::decode_response(response, operation).await?)
    }
}

fn unsupported<T>(operation: &str) -> BackendResult<T> {
    Err(BackendError::Provider {
        provider: "pocketbase",
        code: Some("unsupported".to_string()),
        message: format!("PocketBase {operation} is not implemented in phase 1"),
    })
}

#[derive(Debug, Deserialize)]
struct PbList<T> {
    items: Vec<T>,
}

#[derive(Debug, Deserialize)]
struct PbIdRow {
    id: String,
}

#[derive(Debug, Deserialize)]
struct PbAgentRow {
    #[serde(default)]
    agent_types: Option<Vec<String>>,
    #[serde(default)]
    default_agent_type: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PbAgentRuntimeRow {
    id: String,
    #[serde(default)]
    workspace: Option<String>,
    #[serde(default)]
    backend_type: Option<String>,
    #[serde(default)]
    backend_session_id: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    last_processed_message_key: Option<String>,
    #[serde(default)]
    last_processed_message: Option<String>,
}

impl PbAgentRuntimeRow {
    fn into_backend(self) -> AgentRuntimeRow {
        AgentRuntimeRow {
            id: self.id,
            workspace_id: self.workspace.filter(|s| !s.is_empty()),
            backend_type: self.backend_type.unwrap_or_default(),
            backend_session_id: self.backend_session_id.filter(|s| !s.is_empty()),
            status: self.status.unwrap_or_default(),
            last_processed_message_id: self
                .last_processed_message_key
                .filter(|s| !s.is_empty())
                .or_else(|| self.last_processed_message.filter(|s| !s.is_empty())),
        }
    }
}

#[derive(Debug, Deserialize)]
struct PbMessageRow {
    id: String,
    #[serde(default)]
    client_message_id: Option<String>,
    #[serde(default)]
    session: Option<String>,
    #[serde(default)]
    sender_actor: Option<String>,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    metadata: Option<serde_json::Value>,
    #[serde(default)]
    created: Option<String>,
}

impl PbMessageRow {
    fn into_backend(self) -> StoredMessage {
        StoredMessage {
            id: self
                .client_message_id
                .filter(|s| !s.is_empty())
                .unwrap_or(self.id),
            session_id: self.session.unwrap_or_default(),
            sender_actor_id: self.sender_actor.unwrap_or_default(),
            kind: self.kind.unwrap_or_else(|| "text".to_string()),
            content: self.content.unwrap_or_default(),
            metadata_json: self
                .metadata
                .unwrap_or_else(|| serde_json::json!({}))
                .to_string(),
            created_at: parse_pb_timestamp(self.created.as_deref()),
        }
    }
}

#[derive(Debug, Deserialize)]
struct PbSessionRow {
    id: String,
    team: String,
    #[serde(default)]
    created_by_actor: Option<String>,
    #[serde(default)]
    primary_agent: Option<String>,
    #[serde(default)]
    mode: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    summary: Option<String>,
    #[serde(default)]
    idea_id: Option<String>,
    #[serde(default)]
    created: Option<String>,
}

impl PbSessionRow {
    fn into_backend(self) -> BackendSessionRow {
        BackendSessionRow {
            id: self.id,
            team_id: self.team,
            created_by_actor_id: self.created_by_actor.filter(|s| !s.is_empty()),
            primary_agent_id: self.primary_agent.filter(|s| !s.is_empty()),
            mode: self.mode.unwrap_or_default(),
            title: self.title.unwrap_or_default(),
            summary: self.summary.unwrap_or_default(),
            idea_id: self.idea_id.filter(|s| !s.is_empty()),
            created_at: parse_pb_datetime(self.created.as_deref()),
        }
    }
}

#[derive(Debug, Deserialize)]
struct PbParticipantRow {
    #[serde(default)]
    session: Option<String>,
    actor: String,
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    joined_at: Option<String>,
    #[serde(default)]
    created: Option<String>,
}

impl PbParticipantRow {
    fn into_backend(self, fallback_session_id: &str) -> BackendParticipantRow {
        BackendParticipantRow {
            session_id: self
                .session
                .unwrap_or_else(|| fallback_session_id.to_string()),
            actor_id: self.actor,
            role: self.role.filter(|s| !s.is_empty()),
            joined_at: parse_pb_datetime(self.joined_at.as_deref().or(self.created.as_deref())),
        }
    }
}

#[derive(Debug, Deserialize)]
struct PbAccessRow {
    member_actor: String,
    permission_level: String,
}

fn pb_quote(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

fn parse_pb_datetime(value: Option<&str>) -> chrono::DateTime<chrono::Utc> {
    value
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|dt| dt.with_timezone(&chrono::Utc))
        .unwrap_or_else(|| chrono::DateTime::<chrono::Utc>::from_timestamp(0, 0).unwrap())
}

fn parse_pb_timestamp(value: Option<&str>) -> i64 {
    parse_pb_datetime(value).timestamp()
}

fn put_string(map: &mut serde_json::Map<String, serde_json::Value>, key: &str, value: &str) {
    if !value.is_empty() {
        map.insert(
            key.to_string(),
            serde_json::Value::String(value.to_string()),
        );
    }
}

fn put_opt_string(
    map: &mut serde_json::Map<String, serde_json::Value>,
    key: &str,
    value: Option<&str>,
) {
    if let Some(value) = value.filter(|s| !s.is_empty()) {
        put_string(map, key, value);
    }
}

fn runtime_lookup_filter(row: &AgentRuntimeUpsert<'_>) -> String {
    if let Some(backend_session_id) = row.backend_session_id.filter(|s| !s.is_empty()) {
        format!(
            "agent = {} && backend_session_id = {}",
            pb_quote(row.agent_id),
            pb_quote(backend_session_id)
        )
    } else if let Some(runtime_id) = row.runtime_id.filter(|s| !s.is_empty()) {
        format!(
            "agent = {} && runtime_id = {}",
            pb_quote(row.agent_id),
            pb_quote(runtime_id)
        )
    } else if let Some(session_id) = row.session_id.filter(|s| !s.is_empty()) {
        format!(
            "agent = {} && session = {} && backend_type = {}",
            pb_quote(row.agent_id),
            pb_quote(session_id),
            pb_quote(row.backend_type)
        )
    } else {
        format!(
            "agent = {} && backend_type = {}",
            pb_quote(row.agent_id),
            pb_quote(row.backend_type)
        )
    }
}

fn runtime_body(row: &AgentRuntimeUpsert<'_>) -> serde_json::Value {
    let mut body = serde_json::Map::new();
    put_string(&mut body, "team", row.team_id);
    put_string(&mut body, "agent", row.agent_id);
    put_opt_string(&mut body, "session", row.session_id);
    put_opt_string(&mut body, "workspace", row.workspace_id);
    put_string(&mut body, "backend_type", row.backend_type);
    put_opt_string(&mut body, "backend_session_id", row.backend_session_id);
    put_opt_string(&mut body, "runtime_id", row.runtime_id);
    put_string(&mut body, "status", row.status);
    put_opt_string(&mut body, "current_model", row.current_model);
    body.insert(
        "last_seen_at".to_string(),
        serde_json::Value::String(row.last_seen_at.to_rfc3339()),
    );
    serde_json::Value::Object(body)
}

fn drain_through_cursor(messages: &mut Vec<StoredMessage>, after_id: Option<&str>) {
    if let Some(after_id) = after_id {
        if let Some(pos) = messages.iter().position(|m| m.id == after_id) {
            messages.drain(0..=pos);
        }
    }
}

fn normalize_message_kind(kind: &str) -> &str {
    match kind {
        "text" | "agent_reply" | "tool" | "system" => kind,
        "agent_tool_call" | "agent_tool_result" => "tool",
        "user_message" => "text",
        _ => "system",
    }
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
        row: &AgentRuntimeUpsert<'_>,
    ) -> BackendResult<Option<String>> {
        let existing: Vec<PbIdRow> = self
            .list_records(
                "agent_runtimes",
                Some(runtime_lookup_filter(row)),
                None,
                1,
                "pocketbase.agent_runtimes.lookup",
            )
            .await?;
        let body = runtime_body(row);
        let saved: PbIdRow = if let Some(existing) = existing.first() {
            self.update_record(
                "agent_runtimes",
                &existing.id,
                body,
                "pocketbase.agent_runtimes.update",
            )
            .await?
        } else {
            self.create_record("agent_runtimes", body, "pocketbase.agent_runtimes.create")
                .await?
        };
        Ok(Some(saved.id))
    }

    async fn fetch_agent_runtime_for_session(
        &self,
        session_id: &str,
        runtime_id: &str,
        backend_session_id: &str,
    ) -> BackendResult<Option<AgentRuntimeRow>> {
        let mut filter = format!(
            "agent = {} && session = {}",
            pb_quote(&self.cfg.actor_id),
            pb_quote(session_id)
        );
        if !backend_session_id.is_empty() {
            filter.push_str(" && backend_session_id = ");
            filter.push_str(&pb_quote(backend_session_id));
        } else if !runtime_id.is_empty() {
            filter.push_str(" && runtime_id = ");
            filter.push_str(&pb_quote(runtime_id));
        }
        let rows: Vec<PbAgentRuntimeRow> = self
            .list_records(
                "agent_runtimes",
                Some(filter),
                None,
                1,
                "pocketbase.agent_runtimes.fetch",
            )
            .await?;
        Ok(rows.into_iter().next().map(PbAgentRuntimeRow::into_backend))
    }

    async fn fetch_latest_runtime_for_session(
        &self,
        agent_id: &str,
        session_id: &str,
    ) -> BackendResult<Option<AgentRuntimeRow>> {
        let rows: Vec<PbAgentRuntimeRow> = self
            .list_records(
                "agent_runtimes",
                Some(format!(
                    "agent = {} && session = {}",
                    pb_quote(agent_id),
                    pb_quote(session_id)
                )),
                Some("-last_seen_at"),
                1,
                "pocketbase.agent_runtimes.latest",
            )
            .await?;
        Ok(rows.into_iter().next().map(PbAgentRuntimeRow::into_backend))
    }

    async fn ensure_agent_types(
        &self,
        supported_types: &[String],
        default_agent_type: &str,
    ) -> BackendResult<()> {
        if supported_types.is_empty() || default_agent_type.is_empty() {
            return Ok(());
        }
        let rows: Vec<PbAgentRow> = self
            .list_records(
                "actors",
                Some(format!("id = {}", pb_quote(&self.cfg.actor_id))),
                None,
                1,
                "pocketbase.actors.agent_types.lookup",
            )
            .await?;
        let should_patch = rows
            .first()
            .map(|row| {
                row.agent_types
                    .as_ref()
                    .map(|types| types.is_empty())
                    .unwrap_or(true)
                    || row.default_agent_type.is_none()
            })
            .unwrap_or(true);
        if should_patch {
            self.update_record::<PbIdRow>(
                "actors",
                &self.cfg.actor_id,
                serde_json::json!({
                    "agent_types": supported_types,
                    "default_agent_type": default_agent_type,
                }),
                "pocketbase.actors.agent_types.update",
            )
            .await?;
        }
        Ok(())
    }

    async fn set_agent_device_id(&self, device_id: &str) -> BackendResult<()> {
        self.update_record::<PbIdRow>(
            "actors",
            &self.cfg.actor_id,
            serde_json::json!({ "device_id": device_id }),
            "pocketbase.actors.device_id.update",
        )
        .await?;
        Ok(())
    }

    async fn check_agent_permission(
        &self,
        agent_id: &str,
        actor_id: &str,
    ) -> BackendResult<Option<String>> {
        let rows: Vec<PbAccessRow> = self
            .list_records(
                "agent_member_access",
                Some(format!(
                    "agent_actor = {} && member_actor = {}",
                    pb_quote(agent_id),
                    pb_quote(actor_id)
                )),
                None,
                1,
                "pocketbase.agent_member_access.check",
            )
            .await?;
        Ok(rows.into_iter().next().map(|row| row.permission_level))
    }

    async fn heartbeat(&self) -> BackendResult<()> {
        self.update_record::<PbIdRow>(
            "actors",
            &self.cfg.actor_id,
            serde_json::json!({ "last_active_at": chrono::Utc::now().to_rfc3339() }),
            "pocketbase.actors.heartbeat",
        )
        .await?;
        Ok(())
    }

    async fn upsert_workspace(&self, row: &WorkspaceUpsert<'_>) -> BackendResult<WorkspaceRow> {
        let existing: Vec<PbIdRow> = self
            .list_records(
                "workspaces",
                Some(format!(
                    "team = {} && agent = {} && name = {}",
                    pb_quote(row.team_id),
                    pb_quote(row.agent_id),
                    pb_quote(row.name)
                )),
                None,
                1,
                "pocketbase.workspaces.lookup",
            )
            .await?;
        let mut body = serde_json::Map::new();
        put_string(&mut body, "team", row.team_id);
        put_string(&mut body, "agent", row.agent_id);
        put_string(&mut body, "name", row.name);
        put_opt_string(&mut body, "path", row.path);
        if row.archived {
            body.insert(
                "archived_at".to_string(),
                serde_json::Value::String(chrono::Utc::now().to_rfc3339()),
            );
        }
        let body = serde_json::Value::Object(body);
        let saved: PbIdRow = if let Some(existing) = existing.first() {
            self.update_record(
                "workspaces",
                &existing.id,
                body,
                "pocketbase.workspaces.update",
            )
            .await?
        } else {
            self.create_record("workspaces", body, "pocketbase.workspaces.create")
                .await?
        };
        Ok(WorkspaceRow { id: saved.id })
    }

    async fn fetch_session_with_participants(
        &self,
        session_id: &str,
    ) -> BackendResult<BackendSessionAndParticipants> {
        let session_rows: Vec<PbSessionRow> = self
            .list_records(
                "sessions",
                Some(format!("id = {}", pb_quote(session_id))),
                None,
                1,
                "pocketbase.sessions.fetch",
            )
            .await?;
        let session = session_rows
            .into_iter()
            .next()
            .map(PbSessionRow::into_backend)
            .ok_or_else(|| PocketBaseError::Provider {
                code: Some("404".to_string()),
                message: format!("session {session_id} not found"),
            })?;

        let participants: Vec<PbParticipantRow> = self
            .list_records(
                "session_participants",
                Some(format!("session = {}", pb_quote(session_id))),
                Some("created"),
                100,
                "pocketbase.session_participants.fetch",
            )
            .await?;
        Ok(BackendSessionAndParticipants {
            session,
            participants: participants
                .into_iter()
                .map(|row| row.into_backend(session_id))
                .collect(),
        })
    }

    async fn messages_after_cursor(
        &self,
        session_id: &str,
        after_id: Option<&str>,
    ) -> BackendResult<Vec<StoredMessage>> {
        let mut messages: Vec<StoredMessage> = self
            .list_records::<PbMessageRow>(
                "messages",
                Some(format!("session = {}", pb_quote(session_id))),
                Some("created"),
                100,
                "pocketbase.messages.fetch",
            )
            .await?
            .into_iter()
            .map(PbMessageRow::into_backend)
            .collect();
        messages.sort_by_key(|m| m.created_at);
        drain_through_cursor(&mut messages, after_id);
        Ok(messages)
    }

    async fn update_runtime_cursor(
        &self,
        runtime_row_id: &str,
        last_processed_message_id: &str,
    ) -> BackendResult<()> {
        self.update_record::<PbIdRow>(
            "agent_runtimes",
            runtime_row_id,
            serde_json::json!({ "last_processed_message_key": last_processed_message_id }),
            "pocketbase.agent_runtimes.cursor.update",
        )
        .await?;
        Ok(())
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
        agent_actor_id: &str,
    ) -> BackendResult<Vec<String>> {
        let rows: Vec<PbAccessRow> = self
            .list_records(
                "agent_member_access",
                Some(format!(
                    "agent_actor = {} && permission_level = {}",
                    pb_quote(agent_actor_id),
                    pb_quote("admin")
                )),
                None,
                100,
                "pocketbase.agent_member_access.admin_members",
            )
            .await?;
        Ok(rows.into_iter().map(|row| row.member_actor).collect())
    }

    async fn upsert_session_participant(
        &self,
        session_id: &str,
        actor_id: &str,
    ) -> BackendResult<()> {
        let existing: Vec<PbIdRow> = self
            .list_records(
                "session_participants",
                Some(format!(
                    "session = {} && actor = {}",
                    pb_quote(session_id),
                    pb_quote(actor_id)
                )),
                None,
                1,
                "pocketbase.session_participants.lookup",
            )
            .await?;
        if !existing.is_empty() {
            return Ok(());
        }
        let role = if actor_id == self.cfg.actor_id {
            "agent"
        } else {
            "member"
        };
        self.create_record::<PbIdRow>(
            "session_participants",
            serde_json::json!({
                "team": self.cfg.team_id,
                "session": session_id,
                "actor": actor_id,
                "role": role,
                "joined_at": chrono::Utc::now().to_rfc3339(),
            }),
            "pocketbase.session_participants.create",
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
        let row: PbIdRow = self
            .create_record(
                "sessions",
                serde_json::json!({
                    "team": team_id,
                    "created_by_actor": primary_agent_actor_id,
                    "primary_agent": primary_agent_actor_id,
                    "mode": "solo",
                    "title": title,
                    "last_message_at": chrono::Utc::now().to_rfc3339(),
                }),
                "pocketbase.sessions.create_cron",
            )
            .await?;

        self.upsert_session_participant(&row.id, primary_agent_actor_id)
            .await?;
        match self
            .list_agent_admin_member_actor_ids(primary_agent_actor_id)
            .await
        {
            Ok(member_actor_ids) => {
                for actor_id in member_actor_ids {
                    if let Err(e) = self.upsert_session_participant(&row.id, &actor_id).await {
                        tracing::warn!(
                            session_id = %row.id,
                            actor_id = %actor_id,
                            "create_cron_session: failed to add member participant: {e}"
                        );
                    }
                }
            }
            Err(e) => {
                tracing::warn!(
                    primary_agent_actor_id = %primary_agent_actor_id,
                    "create_cron_session: list_agent_admin_member_actor_ids failed: {e}; session will be agent-only"
                );
            }
        }

        Ok(row.id)
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
        let metadata: serde_json::Value = if metadata_json.is_empty() {
            serde_json::json!({})
        } else {
            serde_json::from_str(metadata_json).unwrap_or_else(|_| serde_json::json!({}))
        };
        let mut body = serde_json::Map::new();
        put_string(&mut body, "team", team_id);
        put_string(&mut body, "session", session_id);
        put_opt_string(&mut body, "sender_actor", Some(sender_actor_id));
        put_string(&mut body, "kind", normalize_message_kind(kind));
        body.insert(
            "content".to_string(),
            serde_json::Value::String(content.to_string()),
        );
        body.insert("metadata".to_string(), metadata);
        put_string(&mut body, "client_message_id", id);
        put_opt_string(&mut body, "model", Some(model));
        put_opt_string(&mut body, "turn_id", Some(turn_id));
        body.insert(
            "sequence".to_string(),
            serde_json::Value::Number(serde_json::Number::from(sequence)),
        );
        let body = serde_json::Value::Object(body);

        let existing: Vec<PbIdRow> = if id.is_empty() {
            Vec::new()
        } else {
            self.list_records(
                "messages",
                Some(format!(
                    "session = {} && client_message_id = {}",
                    pb_quote(session_id),
                    pb_quote(id)
                )),
                None,
                1,
                "pocketbase.messages.insert.lookup",
            )
            .await?
        };
        if let Some(existing) = existing.first() {
            self.update_record::<PbIdRow>(
                "messages",
                &existing.id,
                body,
                "pocketbase.messages.insert.update",
            )
            .await?;
        } else {
            self.create_record::<PbIdRow>("messages", body, "pocketbase.messages.insert")
                .await?;
        }

        let preview = content.chars().take(500).collect::<String>();
        if let Err(err) = self
            .update_record::<PbIdRow>(
                "sessions",
                session_id,
                serde_json::json!({
                    "last_message_preview": preview,
                    "last_message_at": chrono::Utc::now().to_rfc3339(),
                }),
                "pocketbase.sessions.last_message.update",
            )
            .await
        {
            tracing::warn!(
                session_id = %session_id,
                "insert_message: failed to update PocketBase session preview: {err}"
            );
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::{AgentRuntimeUpsert, WorkspaceUpsert};
    use serde_json::json;
    use wiremock::matchers::{body_partial_json, header, method, path};
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

    async fn mock_auth(server: &MockServer) {
        Mock::given(method("POST"))
            .and(path("/api/collections/accounts/auth-refresh"))
            .and(header("authorization", "Bearer seed-token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "token": "fresh-token",
                "record": { "id": "account-1" }
            })))
            .expect(1)
            .mount(server)
            .await;
    }

    #[tokio::test]
    async fn upsert_agent_runtime_creates_runtime_and_returns_id() {
        let server = MockServer::start().await;
        mock_auth(&server).await;
        Mock::given(method("GET"))
            .and(path("/api/collections/agent_runtimes/records"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "page": 1,
                "perPage": 1,
                "totalItems": 0,
                "items": []
            })))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/api/collections/agent_runtimes/records"))
            .and(body_partial_json(json!({
                "team": "team-test",
                "agent": "agent-actor",
                "session": "session-1",
                "workspace": "workspace-1",
                "backend_type": "codex",
                "backend_session_id": "acp-1",
                "runtime_id": "rt-1",
                "status": "running",
                "current_model": "gpt-5"
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "runtime-1"
            })))
            .expect(1)
            .mount(&server)
            .await;
        let backend = PocketBaseBackend::new(test_config(server.uri())).unwrap();
        let row = AgentRuntimeUpsert {
            team_id: "team-test",
            agent_id: "agent-actor",
            session_id: Some("session-1"),
            workspace_id: Some("workspace-1"),
            backend_type: "codex",
            backend_session_id: Some("acp-1"),
            runtime_id: Some("rt-1"),
            status: "running",
            current_model: Some("gpt-5"),
            last_seen_at: chrono::DateTime::parse_from_rfc3339("2026-05-26T12:00:00Z")
                .unwrap()
                .with_timezone(&chrono::Utc),
        };

        assert_eq!(
            backend.upsert_agent_runtime(&row).await.unwrap().as_deref(),
            Some("runtime-1")
        );
    }

    #[tokio::test]
    async fn messages_after_cursor_maps_client_message_id_and_drains_cursor() {
        let server = MockServer::start().await;
        mock_auth(&server).await;
        Mock::given(method("GET"))
            .and(path("/api/collections/messages/records"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "page": 1,
                "perPage": 100,
                "totalItems": 3,
                "items": [
                    {
                        "id": "pb-row-1",
                        "client_message_id": "m1",
                        "session": "session-1",
                        "sender_actor": "member-1",
                        "kind": "text",
                        "content": "old",
                        "metadata": {},
                        "created": "2026-05-26T12:00:00Z"
                    },
                    {
                        "id": "pb-row-2",
                        "client_message_id": "m2",
                        "session": "session-1",
                        "sender_actor": "member-1",
                        "kind": "text",
                        "content": "next",
                        "metadata": { "mention_actor_ids": ["agent-actor"] },
                        "created": "2026-05-26T12:00:01Z"
                    }
                ]
            })))
            .expect(1)
            .mount(&server)
            .await;
        let backend = PocketBaseBackend::new(test_config(server.uri())).unwrap();

        let messages = backend
            .messages_after_cursor("session-1", Some("m1"))
            .await
            .unwrap();

        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].id, "m2");
        assert_eq!(
            messages[0].metadata_json,
            r#"{"mention_actor_ids":["agent-actor"]}"#
        );
    }

    #[tokio::test]
    async fn fetch_session_with_participants_maps_pocketbase_relations() {
        let server = MockServer::start().await;
        mock_auth(&server).await;
        Mock::given(method("GET"))
            .and(path("/api/collections/sessions/records"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "page": 1,
                "perPage": 1,
                "totalItems": 1,
                "items": [{
                    "id": "session-1",
                    "team": "team-test",
                    "created_by_actor": "member-1",
                    "primary_agent": "agent-actor",
                    "mode": "collab",
                    "title": "hello",
                    "summary": "summary",
                    "idea_id": "idea-1",
                    "created": "2026-05-26T12:00:00Z"
                }]
            })))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/api/collections/session_participants/records"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "page": 1,
                "perPage": 100,
                "totalItems": 2,
                "items": [
                    { "session": "session-1", "actor": "member-1", "role": "owner", "created": "2026-05-26T12:00:00Z" },
                    { "session": "session-1", "actor": "agent-actor", "role": "agent", "created": "2026-05-26T12:00:00Z" }
                ]
            })))
            .expect(1)
            .mount(&server)
            .await;
        let backend = PocketBaseBackend::new(test_config(server.uri())).unwrap();

        let result = backend
            .fetch_session_with_participants("session-1")
            .await
            .unwrap();

        assert_eq!(result.session.team_id, "team-test");
        assert_eq!(
            result.session.primary_agent_id.as_deref(),
            Some("agent-actor")
        );
        assert_eq!(result.participants.len(), 2);
        assert_eq!(result.participants[0].actor_id, "member-1");
    }

    #[tokio::test]
    async fn check_permission_workspace_and_owner_queries_use_pocketbase_collections() {
        let server = MockServer::start().await;
        mock_auth(&server).await;
        Mock::given(method("GET"))
            .and(path("/api/collections/agent_member_access/records"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "page": 1,
                "perPage": 100,
                "totalItems": 1,
                "items": [{
                    "id": "access-1",
                    "agent_actor": "agent-actor",
                    "member_actor": "member-1",
                    "permission_level": "admin"
                }]
            })))
            .expect(2)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/api/collections/workspaces/records"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "page": 1,
                "perPage": 1,
                "totalItems": 0,
                "items": []
            })))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/api/collections/workspaces/records"))
            .and(body_partial_json(json!({
                "team": "team-test",
                "agent": "agent-actor",
                "name": "repo",
                "path": "/repo"
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "workspace-1"
            })))
            .expect(1)
            .mount(&server)
            .await;
        let backend = PocketBaseBackend::new(test_config(server.uri())).unwrap();

        assert_eq!(
            backend
                .check_agent_permission("agent-actor", "member-1")
                .await
                .unwrap()
                .as_deref(),
            Some("admin")
        );
        assert_eq!(
            backend
                .list_agent_admin_member_actor_ids("agent-actor")
                .await
                .unwrap(),
            vec!["member-1".to_string()]
        );
        let workspace = backend
            .upsert_workspace(&WorkspaceUpsert {
                team_id: "team-test",
                agent_id: "agent-actor",
                name: "repo",
                path: Some("/repo"),
                archived: false,
            })
            .await
            .unwrap();
        assert_eq!(workspace.id, "workspace-1");
    }
}
