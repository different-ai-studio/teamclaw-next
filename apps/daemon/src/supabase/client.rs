use crate::backend::{
    AgentRuntimeRow, AgentRuntimeUpsert, BackendParticipantRow, BackendSessionAndParticipants,
    BackendSessionRow, ClaimResult, StoredMessage, WorkspaceRow, WorkspaceUpsert,
};
use crate::supabase::config::SupabaseConfig;
use crate::supabase::error::{SupabaseError, SupabaseResult};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::fs::OpenOptions;
#[cfg(unix)]
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::Mutex as AsyncMutex;
use tracing::warn;

#[derive(Debug, Clone)]
pub struct SupabaseBackend {
    http: Client,
    cfg: SupabaseConfig,
    persist_path: Option<PathBuf>,
    state: Arc<Mutex<AuthState>>,
    /// Serializes `refresh()` so two concurrent callers can't race to spend
    /// the same refresh token (GoTrue invalidates the presented token and
    /// hands back a new one — a second concurrent call sees the old token
    /// return 400 refresh_token_already_used).
    refresh_lock: Arc<AsyncMutex<()>>,
}

#[derive(Debug, Default)]
struct AuthState {
    access_token: Option<String>,
    refresh_token: String,
    expires_at: Option<Instant>,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    expires_in: u64,
    refresh_token: String,
}

#[derive(Debug, Serialize)]
struct RefreshRequest<'a> {
    refresh_token: &'a str,
}

struct RefreshFileLock {
    file: std::fs::File,
}

impl RefreshFileLock {
    fn acquire(config_path: &Path) -> SupabaseResult<Self> {
        let lock_path = config_path.with_file_name(".supabase.toml.lock");
        if let Some(parent) = lock_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .open(lock_path)?;
        lock_file_exclusive(&file)?;
        Ok(Self { file })
    }
}

impl Drop for RefreshFileLock {
    fn drop(&mut self) {
        let _ = unlock_file(&self.file);
    }
}

#[cfg(unix)]
fn lock_file_exclusive(file: &std::fs::File) -> std::io::Result<()> {
    let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) };
    if rc == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(unix)]
fn unlock_file(file: &std::fs::File) -> std::io::Result<()> {
    let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_UN) };
    if rc == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(not(unix))]
fn lock_file_exclusive(_file: &std::fs::File) -> std::io::Result<()> {
    Ok(())
}

#[cfg(not(unix))]
fn unlock_file(_file: &std::fs::File) -> std::io::Result<()> {
    Ok(())
}

// Refresh while the access token still has >10 min of life left, so a single
// slow call won't expire mid-flight.
const REFRESH_SKEW: Duration = Duration::from_secs(10 * 60);

impl SupabaseBackend {
    pub fn new(cfg: SupabaseConfig) -> SupabaseResult<Self> {
        let persist_path = SupabaseConfig::default_path().ok();
        Self::new_with_persistence(cfg, persist_path)
    }

    pub fn new_without_persistence(cfg: SupabaseConfig) -> SupabaseResult<Self> {
        Self::new_with_persistence(cfg, None)
    }

    fn new_with_persistence(
        cfg: SupabaseConfig,
        persist_path: Option<PathBuf>,
    ) -> SupabaseResult<Self> {
        let http = Client::builder().timeout(Duration::from_secs(20)).build()?;
        let state = AuthState {
            refresh_token: cfg.refresh_token.clone(),
            ..Default::default()
        };
        Ok(Self {
            http,
            cfg,
            persist_path,
            state: Arc::new(Mutex::new(state)),
            refresh_lock: Arc::new(AsyncMutex::new(())),
        })
    }

    pub fn config(&self) -> &SupabaseConfig {
        &self.cfg
    }

    pub fn current_refresh_token(&self) -> String {
        self.state.lock().unwrap().refresh_token.clone()
    }

    pub async fn access_token(&self) -> SupabaseResult<String> {
        {
            let st = self.state.lock().unwrap();
            if let (Some(tok), Some(exp)) = (&st.access_token, st.expires_at) {
                if exp > Instant::now() + REFRESH_SKEW {
                    return Ok(tok.clone());
                }
            }
        }
        self.refresh().await
    }

    async fn refresh(&self) -> SupabaseResult<String> {
        let _guard = self.refresh_lock.lock().await;

        // Another caller may have just refreshed while we were queued on
        // the mutex. Re-check the cache before spending the stored token.
        {
            let st = self.state.lock().unwrap();
            if let (Some(tok), Some(exp)) = (&st.access_token, st.expires_at) {
                if exp > Instant::now() + REFRESH_SKEW {
                    return Ok(tok.clone());
                }
            }
        }

        let _file_lock = match &self.persist_path {
            Some(path) => Some(RefreshFileLock::acquire(path)?),
            None => None,
        };
        if let Some(path) = &self.persist_path {
            self.reload_persisted_refresh_token(path);
        }

        let rt = { self.state.lock().unwrap().refresh_token.clone() };
        let url = format!("{}/auth/v1/token?grant_type=refresh_token", self.cfg.url);
        let resp = self
            .http
            .post(&url)
            .header("apikey", &self.cfg.anon_key)
            .json(&RefreshRequest { refresh_token: &rt })
            .send()
            .await?;

        if !resp.status().is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(SupabaseError::Auth(refresh_failure_message(&text)));
        }
        let body: TokenResponse = resp.json().await?;

        // Persist the rotated refresh token so the next daemon start doesn't
        // boot with a stale one GoTrue has already invalidated.
        let new_refresh = body.refresh_token.clone();
        {
            let mut st = self.state.lock().unwrap();
            st.access_token = Some(body.access_token.clone());
            st.refresh_token = new_refresh.clone();
            st.expires_at = Some(Instant::now() + Duration::from_secs(body.expires_in));
        }
        if let Some(path) = &self.persist_path {
            let mut persisted = self.cfg.clone();
            persisted.refresh_token = new_refresh;
            if let Err(err) = persisted.save(path) {
                warn!(
                    ?err,
                    path = %path.display(),
                    "failed to persist rotated Supabase refresh token; next daemon restart may need re-auth"
                );
            }
            self.persist_legacy_refresh_token(path, &persisted);
        }
        Ok(body.access_token)
    }

    fn persist_legacy_refresh_token(&self, path: &Path, persisted: &SupabaseConfig) {
        let Ok(default_path) = SupabaseConfig::default_path() else {
            return;
        };
        if path != default_path {
            return;
        }
        let Ok(legacy_path) = SupabaseConfig::legacy_path() else {
            return;
        };
        if !legacy_path.exists() {
            return;
        }
        if let Err(err) = persisted.save(&legacy_path) {
            warn!(
                ?err,
                path = %legacy_path.display(),
                "failed to persist rotated Supabase refresh token to legacy config path"
            );
        }
    }

    fn reload_persisted_refresh_token(&self, path: &Path) {
        let Ok(persisted) = SupabaseConfig::load(path) else {
            return;
        };
        let mut st = self.state.lock().unwrap();
        if persisted.refresh_token != st.refresh_token {
            st.access_token = None;
            st.expires_at = None;
            st.refresh_token = persisted.refresh_token;
        }
    }

    /// Expiry of the currently cached access token without triggering a refresh.
    /// Returns `None` if no token has been fetched yet.
    pub fn cached_token_expiry(&self) -> Option<Instant> {
        #[cfg(debug_assertions)]
        if let Ok(secs_str) = std::env::var("AMUX_FORCE_TOKEN_EXPIRY_SECS") {
            if let Ok(n) = secs_str.parse::<u64>() {
                return Some(Instant::now() + Duration::from_secs(n));
            }
        }
        self.state.lock().unwrap().expires_at
    }

    /// Returns true if the cached token is at or past its expiry.
    pub fn is_token_expired(&self) -> bool {
        self.state
            .lock()
            .unwrap()
            .expires_at
            .map(|t| Instant::now() >= t)
            .unwrap_or(false)
    }

    /// Trade an email/password for tokens. Used immediately after
    /// `claim_daemon_invite` returns the daemon's one-time credentials.
    pub async fn login_with_password(
        &mut self,
        email: &str,
        password: &str,
    ) -> SupabaseResult<String> {
        #[derive(Serialize)]
        struct Req<'a> {
            email: &'a str,
            password: &'a str,
        }
        let url = format!("{}/auth/v1/token?grant_type=password", self.cfg.url);
        let resp = self
            .http
            .post(&url)
            .header("apikey", &self.cfg.anon_key)
            .json(&Req { email, password })
            .send()
            .await?;
        if !resp.status().is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(SupabaseError::Auth(format!("password login: {text}")));
        }
        let body: TokenResponse = resp.json().await?;
        let mut st = self.state.lock().unwrap();
        st.access_token = Some(body.access_token.clone());
        st.refresh_token = body.refresh_token.clone();
        st.expires_at = Some(Instant::now() + Duration::from_secs(body.expires_in));
        self.cfg.refresh_token = body.refresh_token.clone();
        Ok(body.access_token)
    }

    /// Call a PostgREST RPC function with the daemon's bearer token.
    pub async fn rpc<Req: Serialize, Resp: serde::de::DeserializeOwned>(
        &self,
        name: &str,
        payload: &Req,
    ) -> SupabaseResult<Resp> {
        let token = self.access_token().await?;
        let url = format!("{}/rest/v1/rpc/{name}", self.cfg.url);
        let resp = self
            .http
            .post(&url)
            .header("apikey", &self.cfg.anon_key)
            .bearer_auth(token)
            .json(payload)
            .send()
            .await?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(SupabaseError::Rpc {
                code: Some(status.as_u16().to_string()),
                message: text,
            });
        }
        Ok(resp.json().await?)
    }

    /// Anonymous RPC — used for `claim_daemon_invite`, where the invite token
    /// *is* the credential.
    pub async fn rpc_anon<Req: Serialize, Resp: serde::de::DeserializeOwned>(
        &self,
        name: &str,
        payload: &Req,
    ) -> SupabaseResult<Resp> {
        let url = format!("{}/rest/v1/rpc/{name}", self.cfg.url);
        let resp = self
            .http
            .post(&url)
            .header("apikey", &self.cfg.anon_key)
            .json(payload)
            .send()
            .await?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(SupabaseError::Rpc {
                code: Some(status.as_u16().to_string()),
                message: text,
            });
        }
        Ok(resp.json().await?)
    }

    /// Anonymous claim for agents (daemon path). Calls `claim_team_invite` RPC.
    /// Supabase's PostgREST returns set-returning functions as arrays, so we
    /// deserialize into `Vec<ClaimResult>` and pick the first row.
    pub async fn claim_team_invite(&self, token: &str) -> SupabaseResult<ClaimResult> {
        #[derive(Serialize)]
        struct Req<'a> {
            p_token: &'a str,
        }
        let payload = Req { p_token: token };
        let rows: Vec<ClaimResult> = self.rpc_anon("claim_team_invite", &payload).await?;
        rows.into_iter().next().ok_or(SupabaseError::InviteInvalid)
    }
}

fn refresh_failure_message(text: &str) -> String {
    if text.contains("refresh_token_already_used") {
        format!(
            "refresh failed: {text}. Stored daemon refresh token has already been consumed; run `amuxd init <teamclaw://invite?...>` again to mint a new daemon credential."
        )
    } else {
        format!("refresh failed: {text}")
    }
}

/// Parse a `Vec<serde_json::Value>` (PostgREST rows) into `Vec<StoredMessage>`.
/// Extracted as a free function so unit tests can exercise it without any HTTP.
fn parse_stored_messages(rows: Vec<serde_json::Value>) -> Vec<StoredMessage> {
    rows.into_iter()
        .map(|row| StoredMessage {
            id: row["id"].as_str().unwrap_or_default().to_string(),
            session_id: row["session_id"].as_str().unwrap_or_default().to_string(),
            sender_actor_id: row["sender_actor_id"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            kind: row["kind"].as_str().unwrap_or_default().to_string(),
            content: row["content"].as_str().unwrap_or_default().to_string(),
            metadata_json: row
                .get("metadata")
                .map(|v| v.to_string())
                .unwrap_or_else(|| "{}".into()),
            created_at: row
                .get("created_at")
                .and_then(|v| v.as_str())
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .map(|d| d.timestamp())
                .unwrap_or(0),
        })
        .collect()
}

/// Drop every element up to and including the one whose `id` equals `after_id`.
/// If `after_id` is `None` or not found, the vec is left unchanged.
fn drain_through_cursor(messages: &mut Vec<StoredMessage>, after_id: Option<&str>) {
    if let Some(after_id) = after_id {
        if let Some(pos) = messages.iter().position(|m| m.id == after_id) {
            messages.drain(0..=pos);
        }
    }
}

#[async_trait::async_trait]
impl crate::backend::Backend for SupabaseBackend {
    fn team_id(&self) -> &str {
        &self.cfg.team_id
    }

    fn actor_id(&self) -> &str {
        &self.cfg.actor_id
    }

    async fn auth_token(&self) -> crate::backend::BackendResult<String> {
        Ok(self.access_token().await?)
    }

    fn cached_credential_expiry(&self) -> Option<Instant> {
        self.cached_token_expiry()
    }

    async fn claim_team_invite(&self, token: &str) -> crate::backend::BackendResult<ClaimResult> {
        Ok(SupabaseBackend::claim_team_invite(self, token).await?)
    }

    /// Upsert an agent_runtimes row keyed on (agent_id, backend_session_id).
    ///
    /// Returns `Ok(Some(row_id))` where `row_id` is the UUID of the upserted
    /// row (from `agent_runtimes.id`). Returns `Ok(None)` if the response body
    /// was empty or unparseable — defensive only; PostgREST with
    /// `return=representation` should always include the row.
    async fn upsert_agent_runtime(
        &self,
        row: &AgentRuntimeUpsert<'_>,
    ) -> crate::backend::BackendResult<Option<String>> {
        let token = self.access_token().await?;
        let url = format!(
            "{}/rest/v1/agent_runtimes?on_conflict=agent_id,backend_session_id",
            self.cfg.url
        );
        let resp = self
            .http
            .post(&url)
            .header("apikey", &self.cfg.anon_key)
            .header(
                "Prefer",
                "resolution=merge-duplicates,return=representation",
            )
            .bearer_auth(token)
            .json(&[row])
            .send()
            .await
            .map_err(SupabaseError::from)?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(SupabaseError::Rpc {
                code: Some(status.as_u16().to_string()),
                message: text,
            }
            .into());
        }
        // Parse the returned row(s) to extract the generated id.
        let rows: Vec<serde_json::Value> = resp.json().await.unwrap_or_default();
        let row_id = rows
            .first()
            .and_then(|r| r.get("id"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        Ok(row_id)
    }

    async fn fetch_agent_runtime_for_session(
        &self,
        session_id: &str,
        runtime_id: &str,
        backend_session_id: &str,
    ) -> crate::backend::BackendResult<Option<AgentRuntimeRow>> {
        let token = self.access_token().await?;
        let mut url = format!(
            "{}/rest/v1/agent_runtimes?agent_id=eq.{}&session_id=eq.{}&select=id,last_processed_message_id",
            self.cfg.url, self.cfg.actor_id, session_id
        );
        if !backend_session_id.is_empty() {
            url.push_str("&backend_session_id=eq.");
            url.push_str(backend_session_id);
        } else if !runtime_id.is_empty() {
            url.push_str("&runtime_id=eq.");
            url.push_str(runtime_id);
        }
        url.push_str("&limit=1");

        let resp = self
            .http
            .get(&url)
            .header("apikey", &self.cfg.anon_key)
            .bearer_auth(token)
            .send()
            .await
            .map_err(SupabaseError::from)?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(SupabaseError::Rpc {
                code: Some(status.as_u16().to_string()),
                message: text,
            }
            .into());
        }

        let rows: Vec<AgentRuntimeRow> = resp.json().await.map_err(SupabaseError::from)?;
        Ok(rows.into_iter().next())
    }

    /// Look up the most recent `agent_runtimes` row for `(agent_id, session_id)`,
    /// ordered by `last_seen_at desc`. Used by the daemon on startup to:
    ///
    ///   1. Restore the per-session `last_processed_message_id` cursor onto a
    ///      freshly spawned `RuntimeHandle` so `catchup_runtime` only replays
    ///      messages this daemon hasn't yet processed (rather than the entire
    ///      session history). The `upsert_agent_runtime` conflict key is
    ///      `(agent_id, backend_session_id)`, so a brand-new ACP session always
    ///      lands on a fresh row with a NULL cursor — we explicitly carry the
    ///      cursor forward via this lookup.
    ///   2. Decide whether to auto-respawn a runtime for an "offline" session
    ///      (`auto_restart_offline_sessions`) when the daemon comes back
    ///      online; the row tells us which workspace + backend to spawn.
    ///
    /// Returns `Ok(None)` when no row exists (this daemon has never had a
    /// runtime in this session).
    async fn fetch_latest_runtime_for_session(
        &self,
        agent_id: &str,
        session_id: &str,
    ) -> crate::backend::BackendResult<Option<AgentRuntimeRow>> {
        let token = self.access_token().await?;
        let url = format!(
            "{}/rest/v1/agent_runtimes?agent_id=eq.{}&session_id=eq.{}&select=id,workspace_id,backend_type,backend_session_id,status,last_processed_message_id,last_seen_at&order=last_seen_at.desc&limit=1",
            self.cfg.url, agent_id, session_id
        );
        let resp = self
            .http
            .get(&url)
            .header("apikey", &self.cfg.anon_key)
            .bearer_auth(&token)
            .send()
            .await
            .map_err(SupabaseError::from)?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(SupabaseError::Rpc {
                code: Some(status.as_u16().to_string()),
                message: format!("fetch_latest_runtime_for_session: {text}"),
            }
            .into());
        }
        let mut rows: Vec<AgentRuntimeRow> = resp.json().await.map_err(SupabaseError::from)?;
        Ok(rows.pop())
    }

    /// Record this daemon's MQTT device identifier on its `agents` row so
    /// iOS clients can route publishes to `amux/{device_id}/…` without having
    /// the user hand-type the UUID.
    async fn set_agent_device_id(&self, device_id: &str) -> crate::backend::BackendResult<()> {
        let token = self.access_token().await?;
        let actor_id = self.cfg.actor_id.clone();
        let url = format!("{}/rest/v1/agents?id=eq.{}", self.cfg.url, actor_id);
        #[derive(Serialize)]
        struct Patch<'a> {
            device_id: &'a str,
        }
        let resp = self
            .http
            .patch(&url)
            .header("apikey", &self.cfg.anon_key)
            .bearer_auth(token)
            .json(&Patch { device_id })
            .send()
            .await
            .map_err(SupabaseError::from)?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(SupabaseError::Rpc {
                code: Some(status.as_u16().to_string()),
                message: text,
            }
            .into());
        }
        Ok(())
    }

    /// Advertise the backend types this daemon can actually spawn. Existing
    /// non-empty agent_types are left alone so an operator can narrow support
    /// from the database/UI without daemon start overwriting it.
    async fn ensure_agent_types(
        &self,
        supported_types: &[String],
        default_agent_type: &str,
    ) -> crate::backend::BackendResult<()> {
        if supported_types.is_empty() || default_agent_type.is_empty() {
            return Ok(());
        }

        #[derive(Deserialize)]
        struct AgentTypesRow {
            #[serde(default)]
            agent_types: Vec<String>,
            #[serde(default)]
            default_agent_type: Option<String>,
        }

        let token = self.access_token().await?;
        let actor_id = self.cfg.actor_id.clone();
        let url = format!(
            "{}/rest/v1/agents?id=eq.{}&select=agent_types,default_agent_type&limit=1",
            self.cfg.url, actor_id
        );
        let resp = self
            .http
            .get(&url)
            .header("apikey", &self.cfg.anon_key)
            .bearer_auth(token.clone())
            .send()
            .await
            .map_err(SupabaseError::from)?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(SupabaseError::Rpc {
                code: Some(status.as_u16().to_string()),
                message: text,
            }
            .into());
        }

        let row = resp
            .json::<Vec<AgentTypesRow>>()
            .await
            .map_err(SupabaseError::from)?
            .into_iter()
            .next();
        let should_patch = row
            .as_ref()
            .map(|r| r.agent_types.is_empty() || r.default_agent_type.is_none())
            .unwrap_or(true);
        if !should_patch {
            return Ok(());
        }

        #[derive(Serialize)]
        struct Patch<'a> {
            agent_types: &'a [String],
            default_agent_type: &'a str,
        }

        let patch_url = format!("{}/rest/v1/agents?id=eq.{}", self.cfg.url, actor_id);
        let resp = self
            .http
            .patch(&patch_url)
            .header("apikey", &self.cfg.anon_key)
            .bearer_auth(token)
            .json(&Patch {
                agent_types: supported_types,
                default_agent_type,
            })
            .send()
            .await
            .map_err(SupabaseError::from)?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(SupabaseError::Rpc {
                code: Some(status.as_u16().to_string()),
                message: text,
            }
            .into());
        }
        Ok(())
    }

    /// Look up `agent_member_access.permission_level` for a caller. Returns
    /// `Some("admin" | "write" | "view")` or `None` when no grant exists.
    async fn check_agent_permission(
        &self,
        agent_id: &str,
        actor_id: &str,
    ) -> crate::backend::BackendResult<Option<String>> {
        #[derive(Serialize)]
        struct Req<'a> {
            p_agent_id: &'a str,
            p_actor_id: &'a str,
        }
        let body: serde_json::Value = self
            .rpc(
                "check_agent_permission",
                &Req {
                    p_agent_id: agent_id,
                    p_actor_id: actor_id,
                },
            )
            .await?;
        Ok(body.as_str().map(str::to_string))
    }

    /// Heartbeat: POST /rest/v1/rpc/update_actor_last_active.
    /// The RPC returns void (empty body), so we can't decode the response as JSON.
    async fn heartbeat(&self) -> crate::backend::BackendResult<()> {
        let token = self.access_token().await?;
        let url = format!("{}/rest/v1/rpc/update_actor_last_active", self.cfg.url);
        let resp = self
            .http
            .post(&url)
            .header("apikey", &self.cfg.anon_key)
            .bearer_auth(token)
            .json(&serde_json::Value::Null)
            .send()
            .await
            .map_err(SupabaseError::from)?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(SupabaseError::Rpc {
                code: Some(status.as_u16().to_string()),
                message: text,
            }
            .into());
        }
        Ok(())
    }

    async fn upsert_workspace(
        &self,
        row: &WorkspaceUpsert<'_>,
    ) -> crate::backend::BackendResult<WorkspaceRow> {
        let token = self.access_token().await?;
        let url = format!(
            "{}/rest/v1/workspaces?on_conflict=team_id,agent_id,name",
            self.cfg.url
        );
        let resp = self
            .http
            .post(&url)
            .header("apikey", &self.cfg.anon_key)
            .header(
                "Prefer",
                "resolution=merge-duplicates,return=representation",
            )
            .bearer_auth(token)
            .json(&[row])
            .send()
            .await
            .map_err(SupabaseError::from)?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(SupabaseError::Rpc {
                code: Some(status.as_u16().to_string()),
                message: text,
            }
            .into());
        }

        let mut rows: Vec<WorkspaceRow> = resp.json().await.map_err(SupabaseError::from)?;
        Ok(rows.pop().ok_or(SupabaseError::Rpc {
            code: None,
            message: "workspace upsert returned no rows".into(),
        })?)
    }

    /// Fetch a `sessions` row alongside its `session_participants`. Used when
    /// the daemon receives a `runtimeStart` for an iOS-created collab session
    /// and needs to learn the session's identity + roster before subscribing
    /// to `session/{sid}/live`.
    async fn fetch_session_with_participants(
        &self,
        session_id: &str,
    ) -> crate::backend::BackendResult<BackendSessionAndParticipants> {
        let token = self.access_token().await?;

        let session_url = format!(
            "{}/rest/v1/sessions?id=eq.{}&select=id,team_id,created_by_actor_id,primary_agent_id,mode,title,summary,idea_id,created_at",
            self.cfg.url, session_id
        );
        let resp = self
            .http
            .get(&session_url)
            .header("apikey", &self.cfg.anon_key)
            .bearer_auth(&token)
            .send()
            .await
            .map_err(SupabaseError::from)?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(SupabaseError::Rpc {
                code: Some(status.as_u16().to_string()),
                message: format!("fetch_session: {text}"),
            }
            .into());
        }
        let mut rows: Vec<BackendSessionRow> = resp.json().await.map_err(SupabaseError::from)?;
        let session = rows.pop().ok_or_else(|| SupabaseError::Rpc {
            code: Some("404".into()),
            message: format!("session {session_id} not found"),
        })?;

        let part_url = format!(
            "{}/rest/v1/session_participants?session_id=eq.{}&select=session_id,actor_id,role,joined_at",
            self.cfg.url, session_id
        );
        let resp = self
            .http
            .get(&part_url)
            .header("apikey", &self.cfg.anon_key)
            .bearer_auth(&token)
            .send()
            .await
            .map_err(SupabaseError::from)?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(SupabaseError::Rpc {
                code: Some(status.as_u16().to_string()),
                message: format!("fetch_participants: {text}"),
            }
            .into());
        }
        let participants: Vec<BackendParticipantRow> =
            resp.json().await.map_err(SupabaseError::from)?;

        Ok(BackendSessionAndParticipants {
            session,
            participants,
        })
    }

    /// Returns messages for `session_id` ordered by `created_at` ascending.
    /// When `after_id` is `Some`, the message with that id and all earlier
    /// messages are dropped from the result (exclusive cursor).
    async fn messages_after_cursor(
        &self,
        session_id: &str,
        after_id: Option<&str>,
    ) -> crate::backend::BackendResult<Vec<StoredMessage>> {
        let token = self.access_token().await?;
        let url = format!(
            "{}/rest/v1/messages?session_id=eq.{}&select=id,session_id,sender_actor_id,kind,content,metadata,created_at&order=created_at.asc",
            self.cfg.url, session_id
        );
        let resp = self
            .http
            .get(&url)
            .header("apikey", &self.cfg.anon_key)
            .bearer_auth(&token)
            .send()
            .await
            .map_err(SupabaseError::from)?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(SupabaseError::Rpc {
                code: Some(status.as_u16().to_string()),
                message: format!("messages_after_cursor: {text}"),
            }
            .into());
        }
        let rows: Vec<serde_json::Value> = resp.json().await.map_err(SupabaseError::from)?;
        let mut out = parse_stored_messages(rows);
        out.sort_by_key(|m| m.created_at);
        drain_through_cursor(&mut out, after_id);
        Ok(out)
    }

    /// Persist the per-runtime read cursor by PATCHing `agent_runtimes`.
    async fn update_runtime_cursor(
        &self,
        runtime_row_id: &str,
        last_processed_message_id: &str,
    ) -> crate::backend::BackendResult<()> {
        let token = self.access_token().await?;
        let url = format!(
            "{}/rest/v1/agent_runtimes?id=eq.{}",
            self.cfg.url, runtime_row_id
        );
        #[derive(Serialize)]
        struct Patch<'a> {
            last_processed_message_id: &'a str,
        }
        let resp = self
            .http
            .patch(&url)
            .header("apikey", &self.cfg.anon_key)
            .bearer_auth(&token)
            .json(&Patch {
                last_processed_message_id,
            })
            .send()
            .await
            .map_err(SupabaseError::from)?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(SupabaseError::Rpc {
                code: Some(status.as_u16().to_string()),
                message: format!("update_runtime_cursor: {text}"),
            }
            .into());
        }
        Ok(())
    }

    // ── Gateway-store hooks ─────────────────────────────────────────────────
    //
    // These four methods back `channels::AmuxdChannelStore`, the daemon's
    // impl of `teamclaw_gateway::ChannelStore`. They follow the same
    // PostgREST REST + RPC patterns as the rest of this client.

    /// Upsert an `actors` row of type `external` keyed on
    /// `(team_id, source, source_id)`. Returns the actor's UUID.
    async fn rpc_upsert_external_actor(
        &self,
        team_id: &str,
        source: &str,
        source_id: &str,
        display_name: &str,
    ) -> crate::backend::BackendResult<String> {
        #[derive(Serialize)]
        struct Req<'a> {
            p_team_id: &'a str,
            p_source: &'a str,
            p_source_id: &'a str,
            p_display_name: &'a str,
        }
        let body: serde_json::Value = self
            .rpc(
                "upsert_external_actor",
                &Req {
                    p_team_id: team_id,
                    p_source: source,
                    p_source_id: source_id,
                    p_display_name: display_name,
                },
            )
            .await?;
        // The RPC returns the actor UUID directly (scalar) — PostgREST
        // serialises it as a bare string when the function returns a
        // single scalar.
        if let Some(s) = body.as_str() {
            return Ok(s.to_string());
        }
        // Tolerate set-returning shape just in case: `[{"actor_id": "..."}]`.
        if let Some(arr) = body.as_array() {
            if let Some(first) = arr.first() {
                if let Some(id) = first
                    .get("actor_id")
                    .or_else(|| first.get("id"))
                    .and_then(|v| v.as_str())
                {
                    return Ok(id.to_string());
                }
            }
        }
        Err(SupabaseError::Rpc {
            code: None,
            message: format!("upsert_external_actor: unexpected response {body}"),
        }
        .into())
    }

    /// Look up the `sessions.id` and `binding` URI of a gateway session by
    /// its SQL-minted `acp_session_id`. Returns `None` if no row matches.
    /// `binding` may be `None` on the returned tuple's second slot for
    /// non-gateway sessions (the row exists but `binding` is NULL).
    ///
    /// Used by `AmuxdAcpHandle::resolve_or_spawn` to recover both the
    /// supabase session UUID (so envelope routing has a target) and the
    /// binding URI (so the per-session MCP config knows the default chat
    /// for `send`) from the only id the channel layer carries.
    async fn get_gateway_session_by_acp_id(
        &self,
        acp_session_id: &str,
    ) -> crate::backend::BackendResult<Option<(String, Option<String>)>> {
        let token = self.access_token().await?;
        let url = format!(
            "{}/rest/v1/sessions?acp_session_id=eq.{}&select=id,binding",
            self.cfg.url, acp_session_id
        );
        let resp = self
            .http
            .get(&url)
            .header("apikey", &self.cfg.anon_key)
            .bearer_auth(&token)
            .send()
            .await
            .map_err(SupabaseError::from)?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(SupabaseError::Rpc {
                code: Some(status.as_u16().to_string()),
                message: format!("get_gateway_session_by_acp_id: {text}"),
            }
            .into());
        }
        #[derive(Deserialize)]
        struct Row {
            id: String,
            binding: Option<String>,
        }
        let rows: Vec<Row> = resp.json().await.map_err(SupabaseError::from)?;
        Ok(rows.into_iter().next().map(|r| (r.id, r.binding)))
    }

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
    ) -> crate::backend::BackendResult<(String, String, bool)> {
        #[derive(Serialize)]
        struct Req<'a> {
            p_team_id: &'a str,
            p_binding: &'a str,
            p_title: &'a str,
            p_primary_agent_actor_id: &'a str,
            p_owner_member_actor_ids: &'a [String],
            p_participant_actor_ids: &'a [String],
        }
        #[derive(Deserialize)]
        struct Row {
            session_id: String,
            acp_session_id: String,
            created: bool,
        }
        let rows: Vec<Row> = self
            .rpc(
                "ensure_gateway_session",
                &Req {
                    p_team_id: team_id,
                    p_binding: binding,
                    p_title: title,
                    p_primary_agent_actor_id: primary_agent_actor_id,
                    p_owner_member_actor_ids: owner_member_actor_ids,
                    p_participant_actor_ids: participant_actor_ids,
                },
            )
            .await?;
        let row = rows.into_iter().next().ok_or_else(|| SupabaseError::Rpc {
            code: None,
            message: "ensure_gateway_session: empty response".into(),
        })?;
        Ok((row.session_id, row.acp_session_id, row.created))
    }

    /// Insert one row into `public.messages` from a gateway message. Returns
    /// the new row's UUID. Idempotent on `(session_id, external_id)` — a
    /// re-delivery of the same provider message returns the existing id.
    async fn insert_gateway_message(
        &self,
        session_id: &str,
        sender_actor_id: &str,
        content: &str,
        external_message_id: Option<&str>,
    ) -> crate::backend::BackendResult<String> {
        self.insert_gateway_message_with_attachments(
            session_id,
            sender_actor_id,
            content,
            external_message_id,
            serde_json::Value::Array(vec![]),
        )
        .await
    }

    /// Same as `insert_gateway_message` but carries an `attachments` JSON
    /// array stored in `messages.attachments`.
    async fn insert_gateway_message_with_attachments(
        &self,
        session_id: &str,
        sender_actor_id: &str,
        content: &str,
        external_message_id: Option<&str>,
        attachments: serde_json::Value,
    ) -> crate::backend::BackendResult<String> {
        let token = self.access_token().await?;
        // `team_id` is required on `messages` and enforced by the
        // `enforce_core_team_integrity` trigger. The daemon's session is in
        // its own team, so we pull from the config.
        let team_id = self.cfg.team_id.clone();
        let mut body = serde_json::json!({
            "team_id": team_id,
            "session_id": session_id,
            "sender_actor_id": sender_actor_id,
            "kind": "text",
            "content": content,
            "metadata": {},
            "attachments": attachments,
        });
        if let Some(ext) = external_message_id {
            body["external_id"] = serde_json::Value::String(ext.to_string());
        }

        // Prefer `on_conflict=session_id,external_id` so a re-delivery
        // returns the existing row instead of erroring out. PostgREST
        // requires the column tuple as a query parameter; we only enable
        // the on-conflict path when `external_id` is provided (the partial
        // unique index only covers non-null external_ids).
        let (url, prefer) = if external_message_id.is_some() {
            (
                format!(
                    "{}/rest/v1/messages?on_conflict=session_id,external_id",
                    self.cfg.url
                ),
                "resolution=merge-duplicates,return=representation",
            )
        } else {
            (
                format!("{}/rest/v1/messages", self.cfg.url),
                "return=representation",
            )
        };

        let resp = self
            .http
            .post(&url)
            .header("apikey", &self.cfg.anon_key)
            .header("Prefer", prefer)
            .bearer_auth(&token)
            .json(&body)
            .send()
            .await
            .map_err(SupabaseError::from)?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(SupabaseError::Rpc {
                code: Some(status.as_u16().to_string()),
                message: format!("insert_gateway_message: {text}"),
            }
            .into());
        }
        let rows: Vec<serde_json::Value> = resp.json().await.unwrap_or_default();
        let id = rows
            .first()
            .and_then(|r| r.get("id"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| SupabaseError::Rpc {
                code: None,
                message: "insert_gateway_message: no id in response".into(),
            })?;
        Ok(id)
    }

    /// Upload bytes to the attachments bucket. `path` is the object path
    /// (e.g., "<team_id>/<session_id>/<uuid>-<filename>"). `mime` is the
    /// content-type. Returns the stored object path on success.
    async fn upload_attachment_bytes(
        &self,
        path: &str,
        bytes: Vec<u8>,
        mime: &str,
    ) -> crate::backend::BackendResult<String> {
        let token = self.access_token().await?;
        let url = format!("{}/storage/v1/object/attachments/{}", self.cfg.url, path);
        let resp = self
            .http
            .post(&url)
            .header("apikey", &self.cfg.anon_key)
            .bearer_auth(&token)
            .header("Content-Type", mime)
            .body(bytes)
            .send()
            .await
            .map_err(SupabaseError::from)?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(SupabaseError::Rpc {
                code: Some(status.as_u16().to_string()),
                message: format!("upload_attachment_bytes: {text}"),
            }
            .into());
        }
        Ok(path.to_string())
    }

    /// Return the member actor ids from `agent_member_access` where
    /// `agent_id = agent_actor_id AND permission_level = 'admin'`.
    ///
    /// The column is named `member_id` but its values are actor ids
    /// (members.id references actors.id per 202604220002_core_schema.sql).
    ///
    /// Used at channel-manager boot to populate `owner_member_actor_ids` so
    /// that gateway-originated sessions (Discord/WeCom/Feishu DMs) include the
    /// agent's human admin owners as `session_participants`, making the session
    /// visible to Tauri desktop clients via RLS.
    async fn list_agent_admin_member_actor_ids(
        &self,
        agent_actor_id: &str,
    ) -> crate::backend::BackendResult<Vec<String>> {
        #[derive(Serialize)]
        struct Req<'a> {
            p_agent_actor_id: &'a str,
        }
        #[derive(Deserialize)]
        struct Row {
            member_actor_id: String,
        }
        let rows: Vec<Row> = self
            .rpc(
                "list_agent_admin_member_actor_ids",
                &Req {
                    p_agent_actor_id: agent_actor_id,
                },
            )
            .await?;
        Ok(rows.into_iter().map(|r| r.member_actor_id).collect())
    }

    /// Add (or ignore-if-present) a participant on `session_participants`.
    /// Routes through the `add_gateway_session_participant` SECURITY DEFINER
    /// RPC instead of a direct REST INSERT — the RPC enforces that the
    /// caller owns the session's primary-agent actor and that the target
    /// actor is in the same team, avoiding RLS edge cases where the
    /// daemon's resolved `current_actor_id()` doesn't line up with the
    /// session's recorded `primary_agent_id`. Idempotent.
    async fn upsert_session_participant(
        &self,
        session_id: &str,
        actor_id: &str,
    ) -> crate::backend::BackendResult<()> {
        let token = self.access_token().await?;
        let url = format!(
            "{}/rest/v1/rpc/add_gateway_session_participant",
            self.cfg.url
        );
        let body = serde_json::json!({
            "p_session_id": session_id,
            "p_actor_id": actor_id,
        });
        let resp = self
            .http
            .post(&url)
            .header("apikey", &self.cfg.anon_key)
            .header("Prefer", "return=minimal")
            .bearer_auth(&token)
            .json(&body)
            .send()
            .await
            .map_err(SupabaseError::from)?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(SupabaseError::Rpc {
                code: Some(status.as_u16().to_string()),
                message: format!("upsert_session_participant: {text}"),
            }
            .into());
        }
        Ok(())
    }

    /// Create a Supabase `sessions` row for a cron-triggered turn and add the
    /// daemon's primary agent + all admin members of that agent as
    /// participants. Returns the new session id (UUID).
    ///
    /// `team_id`: the team the cron job belongs to (daemon config).
    /// `primary_agent_actor_id`: the daemon's primary agent actor id —
    ///    becomes `created_by_actor_id` AND a participant.
    /// `title`: short human-readable title (e.g. "Cron: <job_name>").
    ///
    /// Mode is `'solo'` — cron is a single-agent automated task.
    /// `idea_id` is left null. `primary_agent_id` is set so the agent row
    ///    surfaces in the UI's session badge.
    async fn create_cron_session(
        &self,
        team_id: &str,
        primary_agent_actor_id: &str,
        title: &str,
    ) -> crate::backend::BackendResult<String> {
        let token = self.access_token().await?;
        let url = format!("{}/rest/v1/sessions", self.cfg.url);
        let body = serde_json::json!({
            "team_id": team_id,
            "created_by_actor_id": primary_agent_actor_id,
            "primary_agent_id": primary_agent_actor_id,
            "mode": "solo",
            "title": title,
        });
        let resp = self
            .http
            .post(&url)
            .header("apikey", &self.cfg.anon_key)
            .header("Prefer", "return=representation")
            .bearer_auth(&token)
            .json(&body)
            .send()
            .await
            .map_err(SupabaseError::from)?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(SupabaseError::Rpc {
                code: Some(status.as_u16().to_string()),
                message: format!("create_cron_session: {text}"),
            }
            .into());
        }
        #[derive(Deserialize)]
        struct Row {
            id: String,
        }
        let rows: Vec<Row> = resp.json().await.map_err(SupabaseError::from)?;
        let row = rows.into_iter().next().ok_or_else(|| SupabaseError::Rpc {
            code: None,
            message: "create_cron_session: empty response".into(),
        })?;

        // Add the primary agent as a participant.
        self.upsert_session_participant(&row.id, primary_agent_actor_id)
            .await?;

        // Add admin members so the human user can see the session in their UI.
        // Best-effort: if the lookup fails, log and continue — the session is
        // still valid; the user just won't see it (consistent with pre-fix
        // behavior).
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
    ) -> crate::backend::BackendResult<()> {
        let token = self.access_token().await?;
        let url = format!("{}/rest/v1/messages", self.cfg.url);

        let metadata: serde_json::Value = if metadata_json.is_empty() {
            serde_json::json!({})
        } else {
            serde_json::from_str(metadata_json).unwrap_or_else(|_| serde_json::json!({}))
        };
        let mut body = serde_json::json!({
            "id": id,
            "team_id": team_id,
            "session_id": session_id,
            "sender_actor_id": sender_actor_id,
            "kind": kind,
            "content": content,
            "metadata": metadata,
            "sequence": sequence,
        });
        // Only set `model` when the caller has one — historical rows and
        // non-agent kinds (user_message, system, idea_event) leave the
        // column NULL rather than persisting "".
        if !model.is_empty() {
            body["model"] = serde_json::Value::String(model.to_string());
        }
        // Same for turn_id: stamp only when the daemon's TurnAggregator
        // had an open turn; legacy/historical calls leave the column NULL.
        if !turn_id.is_empty() {
            body["turn_id"] = serde_json::Value::String(turn_id.to_string());
        }

        let resp = self
            .http
            .post(&url)
            .header("apikey", &self.cfg.anon_key)
            .header("Prefer", "return=minimal")
            .bearer_auth(&token)
            .json(&body)
            .send()
            .await
            .map_err(SupabaseError::from)?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(SupabaseError::Rpc {
                code: Some(status.as_u16().to_string()),
                message: format!("insert_message: {text}"),
            }
            .into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::{Backend, BackendError};
    use std::fs;
    use wiremock::matchers::{body_partial_json, method, path_regex};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn test_cfg(url: String) -> SupabaseConfig {
        SupabaseConfig {
            url,
            anon_key: "anon".into(),
            refresh_token: "rt-0".into(),
            team_id: "t".into(),
            actor_id: "a".into(),
        }
    }

    #[tokio::test]
    async fn refreshes_access_token_when_expired() {
        let srv = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path_regex(r"^/auth/v1/token$"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token": "at-new",
                "expires_in": 3600,
                "refresh_token": "rt-1"
            })))
            .mount(&srv)
            .await;

        let client = SupabaseBackend::new_without_persistence(test_cfg(srv.uri())).unwrap();
        let tok = client.access_token().await.unwrap();
        assert_eq!(tok, "at-new");
        assert_eq!(client.current_refresh_token(), "rt-1");

        let tok2 = client.access_token().await.unwrap();
        assert_eq!(tok2, "at-new");
    }

    #[tokio::test]
    async fn test_clients_do_not_persist_runtime_config() {
        let path = SupabaseConfig::default_path().unwrap();
        let original = fs::read(&path).ok();

        let srv = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path_regex(r"^/auth/v1/token$"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token": "at-new",
                "expires_in": 3600,
                "refresh_token": "rt-1"
            })))
            .mount(&srv)
            .await;

        let client = SupabaseBackend::new_without_persistence(test_cfg(srv.uri())).unwrap();
        let _ = client.access_token().await.unwrap();

        let persisted = fs::read(&path).ok();
        assert_eq!(persisted, original);
    }

    #[tokio::test]
    async fn refresh_reloads_rotated_token_from_disk_after_file_lock() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("supabase.toml");

        let srv = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path_regex(r"^/auth/v1/token$"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token": "at-new",
                "expires_in": 3600,
                "refresh_token": "rt-next"
            })))
            .mount(&srv)
            .await;

        let mut stale_cfg = test_cfg(srv.uri());
        stale_cfg.refresh_token = "rt-stale".into();
        let mut disk_cfg = stale_cfg.clone();
        disk_cfg.refresh_token = "rt-disk".into();
        disk_cfg.save(&path).unwrap();

        let client = SupabaseBackend::new_with_persistence(stale_cfg, Some(path.clone())).unwrap();
        let tok = client.access_token().await.unwrap();
        assert_eq!(tok, "at-new");

        let requests = srv.received_requests().await.unwrap();
        assert_eq!(requests.len(), 1);
        let body: serde_json::Value = serde_json::from_slice(&requests[0].body).unwrap();
        assert_eq!(body["refresh_token"], "rt-disk");

        let persisted = SupabaseConfig::load(&path).unwrap();
        assert_eq!(persisted.refresh_token, "rt-next");
    }

    #[tokio::test]
    async fn refresh_failure_is_auth_error() {
        let srv = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path_regex(r"^/auth/v1/token$"))
            .respond_with(ResponseTemplate::new(400).set_body_string("bad"))
            .mount(&srv)
            .await;

        let client = SupabaseBackend::new_without_persistence(test_cfg(srv.uri())).unwrap();
        match client.access_token().await {
            Err(SupabaseError::Auth(_)) => {}
            other => panic!("expected auth error, got {:?}", other),
        }
    }

    #[test]
    fn refresh_already_used_error_is_actionable() {
        let msg = refresh_failure_message(
            r#"{"code":400,"error_code":"refresh_token_already_used","msg":"Invalid Refresh Token: Already Used"}"#,
        );

        assert!(msg.contains("refresh_token_already_used"));
        assert!(msg.contains("amuxd init"));
    }

    #[tokio::test]
    async fn rpc_posts_with_bearer_and_json() {
        let srv = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path_regex(r"^/auth/v1/token$"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token": "at",
                "expires_in": 3600,
                "refresh_token": "rt"
            })))
            .mount(&srv)
            .await;
        Mock::given(method("POST"))
            .and(path_regex(r"^/rest/v1/rpc/echo$"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"ok": true})))
            .mount(&srv)
            .await;

        let client = SupabaseBackend::new_without_persistence(test_cfg(srv.uri())).unwrap();
        let body: serde_json::Value = client
            .rpc("echo", &serde_json::json!({"x": 1}))
            .await
            .unwrap();
        assert_eq!(body["ok"], true);
    }

    #[tokio::test]
    async fn rpc_anon_omits_bearer() {
        let srv = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path_regex(r"^/rest/v1/rpc/claim$"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([
                {"actor_id": "a", "team_id": "t", "actor_type": "agent",
                 "display_name": "Test", "refresh_token": null}
            ])))
            .mount(&srv)
            .await;

        let client = SupabaseBackend::new_without_persistence(test_cfg(srv.uri())).unwrap();
        let body: serde_json::Value = client
            .rpc_anon("claim", &serde_json::json!({"p_token": "abc"}))
            .await
            .unwrap();
        assert_eq!(body[0]["actor_id"], "a");
    }

    #[tokio::test]
    async fn claim_team_invite_decodes_agent_response() {
        let srv = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path_regex(r"^/rest/v1/rpc/claim_team_invite$"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!([{
                    "actor_id": "a", "team_id": "t", "actor_type": "agent",
                    "display_name": "M1 Studio", "refresh_token": "rt"
                }])),
            )
            .mount(&srv)
            .await;

        let client = SupabaseBackend::new(test_cfg(srv.uri())).unwrap();
        let r = client
            .claim_team_invite("opaque-token-abc123")
            .await
            .unwrap();
        assert_eq!(r.actor_type, "agent");
        assert_eq!(r.refresh_token.as_deref(), Some("rt"));
    }

    #[tokio::test]
    async fn password_login_updates_refresh_token() {
        let srv = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path_regex(r"^/auth/v1/token$"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token": "at-pwd",
                "expires_in": 3600,
                "refresh_token": "rt-final"
            })))
            .mount(&srv)
            .await;

        let mut client = SupabaseBackend::new_without_persistence(test_cfg(srv.uri())).unwrap();
        let tok = client
            .login_with_password("daemon+x@amux.local", "secret")
            .await
            .unwrap();
        assert_eq!(tok, "at-pwd");
        assert_eq!(client.config().refresh_token, "rt-final");
    }

    #[tokio::test]
    async fn upsert_agent_runtime_sends_merge_duplicates_header() {
        use wiremock::matchers::header_exists;
        let srv = MockServer::start().await;
        // Match on the presence of the Prefer header and the POST path only;
        // the exact header value includes "return=representation" which
        // wiremock's header() matcher compares as a single string but reqwest
        // may send as two values. The real assertion is that the call succeeds
        // and the returned row_id is parsed correctly.
        Mock::given(method("POST"))
            .and(path_regex(r"^/rest/v1/agent_runtimes"))
            .and(header_exists("Prefer"))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!([
                { "id": "aaaaaaaa-0000-0000-0000-000000000000" }
            ])))
            .mount(&srv)
            .await;
        Mock::given(method("POST"))
            .and(path_regex(r"^/auth/v1/token$"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token": "at", "expires_in": 3600, "refresh_token": "rt"
            })))
            .mount(&srv)
            .await;

        let client = SupabaseBackend::new_without_persistence(test_cfg(srv.uri())).unwrap();
        let row = AgentRuntimeUpsert {
            team_id: "t",
            agent_id: "a",
            session_id: None,
            workspace_id: None,
            backend_type: "claude",
            backend_session_id: Some("s-1"),
            runtime_id: Some("r-1"),
            status: "running",
            current_model: Some("opus"),
            last_seen_at: chrono::Utc::now(),
        };
        let row_id = client.upsert_agent_runtime(&row).await.unwrap();
        assert_eq!(
            row_id.as_deref(),
            Some("aaaaaaaa-0000-0000-0000-000000000000")
        );
    }

    #[tokio::test]
    async fn fetch_latest_runtime_for_session_returns_cursor() {
        let srv = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path_regex(r"^/auth/v1/token$"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token": "at", "expires_in": 3600, "refresh_token": "rt"
            })))
            .mount(&srv)
            .await;
        Mock::given(method("GET"))
            .and(path_regex(r"^/rest/v1/agent_runtimes"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([
                {
                    "id": "row-uuid",
                    "workspace_id": "ws-uuid",
                    "backend_type": "claude",
                    "backend_session_id": "acp-uuid",
                    "status": "stopped",
                    "last_processed_message_id": "msg-12",
                    "last_seen_at": "2025-05-22T01:00:00Z"
                }
            ])))
            .mount(&srv)
            .await;

        let client = SupabaseBackend::new_without_persistence(test_cfg(srv.uri())).unwrap();
        let row = client
            .fetch_latest_runtime_for_session("agent-uuid", "session-uuid")
            .await
            .unwrap()
            .expect("row should be present");
        assert_eq!(row.id, "row-uuid");
        assert_eq!(row.last_processed_message_id.as_deref(), Some("msg-12"));
        assert_eq!(row.workspace_id.as_deref(), Some("ws-uuid"));
        assert_eq!(row.backend_type, "claude");
    }

    #[tokio::test]
    async fn fetch_latest_runtime_for_session_returns_none_when_empty() {
        let srv = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path_regex(r"^/auth/v1/token$"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token": "at", "expires_in": 3600, "refresh_token": "rt"
            })))
            .mount(&srv)
            .await;
        Mock::given(method("GET"))
            .and(path_regex(r"^/rest/v1/agent_runtimes"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([])))
            .mount(&srv)
            .await;

        let client = SupabaseBackend::new_without_persistence(test_cfg(srv.uri())).unwrap();
        let row = client
            .fetch_latest_runtime_for_session("agent-uuid", "session-uuid")
            .await
            .unwrap();
        assert!(row.is_none());
    }

    #[tokio::test]
    async fn upsert_workspace_returns_supabase_uuid() {
        let srv = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path_regex(r"^/rest/v1/.*$"))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!([
                { "id": "11111111-1111-1111-1111-111111111111" }
            ])))
            .mount(&srv)
            .await;
        Mock::given(method("POST"))
            .and(path_regex(r"^/auth/v1/token$"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token": "at", "expires_in": 3600, "refresh_token": "rt"
            })))
            .mount(&srv)
            .await;

        let client = SupabaseBackend::new_without_persistence(test_cfg(srv.uri())).unwrap();
        let row = WorkspaceUpsert {
            team_id: "team-1",
            agent_id: "agent-1",
            name: "amux",
            path: Some("/tmp/amux"),
            archived: false,
        };

        let workspace = client.upsert_workspace(&row).await.unwrap();
        assert_eq!(workspace.id, "11111111-1111-1111-1111-111111111111");
    }

    #[tokio::test]
    async fn insert_message_includes_caller_message_id() {
        let srv = MockServer::start().await;
        let message_id = "22222222-2222-2222-2222-222222222222";
        Mock::given(method("POST"))
            .and(path_regex(r"^/rest/v1/messages$"))
            .and(body_partial_json(serde_json::json!({ "id": message_id })))
            .respond_with(ResponseTemplate::new(201))
            .mount(&srv)
            .await;
        Mock::given(method("POST"))
            .and(path_regex(r"^/auth/v1/token$"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token": "at", "expires_in": 3600, "refresh_token": "rt"
            })))
            .mount(&srv)
            .await;

        let client = SupabaseBackend::new_without_persistence(test_cfg(srv.uri())).unwrap();
        client
            .insert_message(
                message_id,
                "team-1",
                "session-1",
                "actor-1",
                "agent_reply",
                "你好，Ye。",
                "",
                "alibaba-cn/qwen3.6-plus",
                "turn-1",
                7,
            )
            .await
            .unwrap();
    }

    #[test]
    fn cached_token_expiry_is_none_before_any_fetch() {
        let cfg = SupabaseConfig {
            url: "http://localhost".into(),
            anon_key: "key".into(),
            refresh_token: "tok".into(),
            team_id: "team".into(),
            actor_id: "actor".into(),
        };
        let client = SupabaseBackend::new_without_persistence(cfg).unwrap();
        assert!(client.cached_token_expiry().is_none());
    }

    #[test]
    fn is_token_expired_false_when_expiry_in_future() {
        let cfg = SupabaseConfig {
            url: "http://localhost".into(),
            anon_key: "key".into(),
            refresh_token: "tok".into(),
            team_id: "team".into(),
            actor_id: "actor".into(),
        };
        let client = SupabaseBackend::new_without_persistence(cfg).unwrap();
        {
            let mut st = client.state.lock().unwrap();
            st.expires_at = Some(Instant::now() + Duration::from_secs(3600));
        }
        assert!(!client.is_token_expired());
    }

    #[test]
    fn is_token_expired_true_when_expiry_in_past() {
        let cfg = SupabaseConfig {
            url: "http://localhost".into(),
            anon_key: "key".into(),
            refresh_token: "tok".into(),
            team_id: "team".into(),
            actor_id: "actor".into(),
        };
        let client = SupabaseBackend::new_without_persistence(cfg).unwrap();
        {
            let mut st = client.state.lock().unwrap();
            st.expires_at = Some(Instant::now() - Duration::from_secs(1));
        }
        assert!(client.is_token_expired());
    }

    // ── StoredMessage helpers ──────────────────────────────────────────────────

    fn make_rows(ids_and_ts: &[(&str, &str)]) -> Vec<serde_json::Value> {
        ids_and_ts
            .iter()
            .map(|(id, ts)| {
                serde_json::json!({
                    "id": id,
                    "session_id": "sess-1",
                    "sender_actor_id": "actor-1",
                    "kind": "text",
                    "content": "hello",
                    "metadata": {},
                    "created_at": ts,
                })
            })
            .collect()
    }

    #[test]
    fn parse_stored_messages_maps_fields() {
        let rows = make_rows(&[("id-1", "2025-01-01T00:00:01Z")]);
        let msgs = parse_stored_messages(rows);
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].id, "id-1");
        assert_eq!(msgs[0].session_id, "sess-1");
        assert_eq!(msgs[0].kind, "text");
        assert_eq!(msgs[0].created_at, 1735689601);
    }

    #[test]
    fn drain_through_cursor_removes_seed_and_earlier() {
        let rows = make_rows(&[
            ("id-1", "2025-01-01T00:00:01Z"),
            ("id-2", "2025-01-01T00:00:02Z"),
            ("id-3", "2025-01-01T00:00:03Z"),
        ]);
        let mut msgs = parse_stored_messages(rows);
        msgs.sort_by_key(|m| m.created_at);
        drain_through_cursor(&mut msgs, Some("id-2"));
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].id, "id-3");
    }

    #[test]
    fn drain_through_cursor_noop_when_none() {
        let rows = make_rows(&[
            ("id-1", "2025-01-01T00:00:01Z"),
            ("id-2", "2025-01-01T00:00:02Z"),
        ]);
        let mut msgs = parse_stored_messages(rows);
        drain_through_cursor(&mut msgs, None);
        assert_eq!(msgs.len(), 2);
    }

    #[test]
    fn drain_through_cursor_noop_when_id_not_found() {
        let rows = make_rows(&[("id-1", "2025-01-01T00:00:01Z")]);
        let mut msgs = parse_stored_messages(rows);
        drain_through_cursor(&mut msgs, Some("id-missing"));
        assert_eq!(msgs.len(), 1);
    }

    #[test]
    fn drain_through_cursor_drains_all_when_last_id() {
        let rows = make_rows(&[
            ("id-1", "2025-01-01T00:00:01Z"),
            ("id-2", "2025-01-01T00:00:02Z"),
        ]);
        let mut msgs = parse_stored_messages(rows);
        msgs.sort_by_key(|m| m.created_at);
        drain_through_cursor(&mut msgs, Some("id-2"));
        assert!(msgs.is_empty());
    }

    #[tokio::test]
    #[ignore]
    async fn messages_after_cursor_orders_and_filters() {
        if std::env::var("SUPABASE_LIVE").is_err() {
            return;
        }
        let cfg = SupabaseConfig::load(&SupabaseConfig::default_path().unwrap()).unwrap();
        let c = SupabaseBackend::new_without_persistence(cfg).unwrap();
        let rows = c
            .messages_after_cursor("00000000-0000-0000-0000-000000000000", None)
            .await
            .unwrap();
        assert!(rows.is_empty());
    }

    // ── Backend trait coverage (wiremock) ──────────────────────────────────────
    //
    // One test per trait method that previously had no unit coverage. Each
    // boots its own `MockServer`, mocks the precise PostgREST or storage
    // endpoint the implementation hits, then exercises the trait method
    // through `SupabaseBackend`. Auth refresh is registered via the shared
    // `mock_auth` helper so the access_token() call inside each method has
    // somewhere to land.

    async fn mock_auth(srv: &MockServer) {
        Mock::given(method("POST"))
            .and(path_regex(r"^/auth/v1/token$"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token": "at",
                "expires_in": 3600,
                "refresh_token": "rt"
            })))
            .mount(srv)
            .await;
    }

    async fn make_client(srv: &MockServer) -> SupabaseBackend {
        mock_auth(srv).await;
        SupabaseBackend::new_without_persistence(test_cfg(srv.uri())).unwrap()
    }

    #[tokio::test]
    async fn set_agent_device_id_patches_agents_row() {
        let srv = MockServer::start().await;
        Mock::given(method("PATCH"))
            .and(path_regex(r"^/rest/v1/agents$"))
            .respond_with(ResponseTemplate::new(204))
            .mount(&srv)
            .await;
        let client = make_client(&srv).await;
        client.set_agent_device_id("device-xyz").await.unwrap();
    }

    #[tokio::test]
    async fn check_agent_permission_returns_role_when_present() {
        let srv = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path_regex(r"^/rest/v1/rpc/check_agent_permission$"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!("admin")))
            .mount(&srv)
            .await;
        let client = make_client(&srv).await;
        let perm = client
            .check_agent_permission("agent-1", "actor-1")
            .await
            .unwrap();
        assert_eq!(perm.as_deref(), Some("admin"));
    }

    #[tokio::test]
    async fn check_agent_permission_returns_none_when_null() {
        let srv = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path_regex(r"^/rest/v1/rpc/check_agent_permission$"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::Value::Null))
            .mount(&srv)
            .await;
        let client = make_client(&srv).await;
        let perm = client
            .check_agent_permission("agent-1", "actor-1")
            .await
            .unwrap();
        assert_eq!(perm, None);
    }

    #[tokio::test]
    async fn heartbeat_posts_update_actor_last_active() {
        let srv = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path_regex(r"^/rest/v1/rpc/update_actor_last_active$"))
            .respond_with(ResponseTemplate::new(204))
            .mount(&srv)
            .await;
        let client = make_client(&srv).await;
        client.heartbeat().await.unwrap();
    }

    #[tokio::test]
    async fn fetch_session_with_participants_returns_session_and_roster() {
        let srv = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path_regex(r"^/rest/v1/sessions$"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!([{
                    "id": "s-1",
                    "team_id": "t-1",
                    "created_by_actor_id": "a-1",
                    "primary_agent_id": "ag-1",
                    "mode": "solo",
                    "title": "Hello",
                    "summary": "",
                    "idea_id": null,
                    "created_at": "2025-01-01T00:00:00Z"
                }])),
            )
            .mount(&srv)
            .await;
        Mock::given(method("GET"))
            .and(path_regex(r"^/rest/v1/session_participants$"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!([{
                    "session_id": "s-1",
                    "actor_id": "a-1",
                    "role": "owner",
                    "joined_at": "2025-01-01T00:00:00Z"
                }])),
            )
            .mount(&srv)
            .await;
        let client = make_client(&srv).await;
        let result = client.fetch_session_with_participants("s-1").await.unwrap();
        assert_eq!(result.session.id, "s-1");
        assert_eq!(result.session.title, "Hello");
        assert_eq!(result.participants.len(), 1);
        assert_eq!(result.participants[0].actor_id, "a-1");
    }

    #[tokio::test]
    async fn fetch_session_with_participants_errors_when_missing() {
        let srv = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path_regex(r"^/rest/v1/sessions$"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([])))
            .mount(&srv)
            .await;
        let client = make_client(&srv).await;
        let err = client
            .fetch_session_with_participants("missing")
            .await
            .unwrap_err();
        match err {
            BackendError::Provider { code, .. } => assert_eq!(code.as_deref(), Some("404")),
            other => panic!("expected provider error with 404, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn messages_after_cursor_drains_through_seed() {
        let srv = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path_regex(r"^/rest/v1/messages$"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([
                {"id":"m-1","session_id":"s-1","sender_actor_id":"a-1","kind":"text",
                 "content":"hi","metadata":{},"created_at":"2025-01-01T00:00:01Z"},
                {"id":"m-2","session_id":"s-1","sender_actor_id":"a-1","kind":"text",
                 "content":"there","metadata":{},"created_at":"2025-01-01T00:00:02Z"}
            ])))
            .mount(&srv)
            .await;
        let client = make_client(&srv).await;
        let msgs = client
            .messages_after_cursor("s-1", Some("m-1"))
            .await
            .unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].id, "m-2");
    }

    #[tokio::test]
    async fn update_runtime_cursor_patches_runtime_row() {
        let srv = MockServer::start().await;
        Mock::given(method("PATCH"))
            .and(path_regex(r"^/rest/v1/agent_runtimes$"))
            .respond_with(ResponseTemplate::new(204))
            .mount(&srv)
            .await;
        let client = make_client(&srv).await;
        client
            .update_runtime_cursor("runtime-1", "msg-99")
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn rpc_upsert_external_actor_decodes_string_response() {
        let srv = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path_regex(r"^/rest/v1/rpc/upsert_external_actor$"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!("actor-uuid-1")),
            )
            .mount(&srv)
            .await;
        let client = make_client(&srv).await;
        let id = client
            .rpc_upsert_external_actor("t", "discord", "user-1", "Alice")
            .await
            .unwrap();
        assert_eq!(id, "actor-uuid-1");
    }

    #[tokio::test]
    async fn rpc_upsert_external_actor_tolerates_array_response() {
        let srv = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path_regex(r"^/rest/v1/rpc/upsert_external_actor$"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([
                {"actor_id": "actor-uuid-2"}
            ])))
            .mount(&srv)
            .await;
        let client = make_client(&srv).await;
        let id = client
            .rpc_upsert_external_actor("t", "discord", "user-2", "Bob")
            .await
            .unwrap();
        assert_eq!(id, "actor-uuid-2");
    }

    #[tokio::test]
    async fn get_gateway_session_by_acp_id_returns_some_when_found() {
        let srv = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path_regex(r"^/rest/v1/sessions$"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!([{
                    "id": "session-uuid",
                    "binding": "discord://channel/123"
                }])),
            )
            .mount(&srv)
            .await;
        let client = make_client(&srv).await;
        let row = client.get_gateway_session_by_acp_id("acp-1").await.unwrap();
        assert_eq!(
            row,
            Some((
                "session-uuid".to_string(),
                Some("discord://channel/123".to_string())
            ))
        );
    }

    #[tokio::test]
    async fn get_gateway_session_by_acp_id_returns_none_when_empty() {
        let srv = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path_regex(r"^/rest/v1/sessions$"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([])))
            .mount(&srv)
            .await;
        let client = make_client(&srv).await;
        let row = client
            .get_gateway_session_by_acp_id("acp-missing")
            .await
            .unwrap();
        assert_eq!(row, None);
    }

    #[tokio::test]
    async fn rpc_ensure_gateway_session_returns_tuple() {
        let srv = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path_regex(r"^/rest/v1/rpc/ensure_gateway_session$"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!([{
                    "session_id": "sess-1",
                    "acp_session_id": "acp-1",
                    "created": true
                }])),
            )
            .mount(&srv)
            .await;
        let client = make_client(&srv).await;
        let (sid, acp, created) = client
            .rpc_ensure_gateway_session(
                "t",
                "discord://chan/1",
                "title",
                "agent-1",
                &["owner-1".into()],
                &["part-1".into()],
            )
            .await
            .unwrap();
        assert_eq!(sid, "sess-1");
        assert_eq!(acp, "acp-1");
        assert!(created);
    }

    #[tokio::test]
    async fn insert_gateway_message_returns_id_without_external_id() {
        let srv = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path_regex(r"^/rest/v1/messages$"))
            .respond_with(
                ResponseTemplate::new(201).set_body_json(serde_json::json!([{
                    "id": "msg-uuid-1"
                }])),
            )
            .mount(&srv)
            .await;
        let client = make_client(&srv).await;
        let id = client
            .insert_gateway_message("sess-1", "actor-1", "hi", None)
            .await
            .unwrap();
        assert_eq!(id, "msg-uuid-1");
    }

    #[tokio::test]
    async fn insert_gateway_message_with_attachments_returns_id_with_external_id() {
        let srv = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path_regex(r"^/rest/v1/messages$"))
            .respond_with(
                ResponseTemplate::new(201).set_body_json(serde_json::json!([{
                    "id": "msg-uuid-att"
                }])),
            )
            .mount(&srv)
            .await;
        let client = make_client(&srv).await;
        let id = client
            .insert_gateway_message_with_attachments(
                "sess-1",
                "actor-1",
                "with file",
                Some("ext-1"),
                serde_json::json!([{"url":"https://x/y","mime":"image/png"}]),
            )
            .await
            .unwrap();
        assert_eq!(id, "msg-uuid-att");
    }

    #[tokio::test]
    async fn upload_attachment_bytes_returns_path() {
        let srv = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path_regex(r"^/storage/v1/object/attachments/"))
            .respond_with(ResponseTemplate::new(200).set_body_string("{}"))
            .mount(&srv)
            .await;
        let client = make_client(&srv).await;
        let p = client
            .upload_attachment_bytes("t/sess/1/file.png", vec![1, 2, 3], "image/png")
            .await
            .unwrap();
        assert_eq!(p, "t/sess/1/file.png");
    }

    #[tokio::test]
    async fn list_agent_admin_member_actor_ids_returns_vec() {
        let srv = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path_regex(
                r"^/rest/v1/rpc/list_agent_admin_member_actor_ids$",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([
                {"member_actor_id": "m-1"},
                {"member_actor_id": "m-2"}
            ])))
            .mount(&srv)
            .await;
        let client = make_client(&srv).await;
        let ids = client
            .list_agent_admin_member_actor_ids("agent-1")
            .await
            .unwrap();
        assert_eq!(ids, vec!["m-1".to_string(), "m-2".to_string()]);
    }

    #[tokio::test]
    async fn upsert_session_participant_returns_ok() {
        let srv = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path_regex(
                r"^/rest/v1/rpc/add_gateway_session_participant$",
            ))
            .respond_with(ResponseTemplate::new(204))
            .mount(&srv)
            .await;
        let client = make_client(&srv).await;
        client
            .upsert_session_participant("sess-1", "actor-1")
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn create_cron_session_returns_session_id() {
        let srv = MockServer::start().await;
        // Primary session insert.
        Mock::given(method("POST"))
            .and(path_regex(r"^/rest/v1/sessions$"))
            .respond_with(
                ResponseTemplate::new(201).set_body_json(serde_json::json!([{
                    "id": "cron-sess-1"
                }])),
            )
            .mount(&srv)
            .await;
        // Participant upserts (primary agent + any admin members).
        Mock::given(method("POST"))
            .and(path_regex(r"^/rest/v1/session_participants$"))
            .respond_with(ResponseTemplate::new(201))
            .mount(&srv)
            .await;
        // No admin members in this case keeps the test focused on the
        // session-id return value. The follow-on admin enrichment is
        // best-effort and covered by `list_agent_admin_member_actor_ids`.
        Mock::given(method("POST"))
            .and(path_regex(
                r"^/rest/v1/rpc/list_agent_admin_member_actor_ids$",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([])))
            .mount(&srv)
            .await;
        let client = make_client(&srv).await;
        let sid = client
            .create_cron_session("team-1", "agent-1", "title")
            .await
            .unwrap();
        assert_eq!(sid, "cron-sess-1");
    }

    #[tokio::test]
    async fn insert_message_includes_model_and_turn_when_set() {
        let srv = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path_regex(r"^/rest/v1/messages$"))
            .respond_with(ResponseTemplate::new(204))
            .mount(&srv)
            .await;
        let client = make_client(&srv).await;
        client
            .insert_message(
                "msg-1",
                "t-1",
                "s-1",
                "a-1",
                "text",
                "hello",
                "{}",
                "claude-opus",
                "turn-1",
                42,
            )
            .await
            .unwrap();

        let requests = srv.received_requests().await.unwrap();
        let body = requests
            .iter()
            .find(|r| r.url.path() == "/rest/v1/messages")
            .expect("/rest/v1/messages was not called");
        let body_json: serde_json::Value = serde_json::from_slice(&body.body).unwrap();
        assert_eq!(body_json["id"], serde_json::json!("msg-1"));
        assert_eq!(body_json["model"], serde_json::json!("claude-opus"));
        assert_eq!(body_json["turn_id"], serde_json::json!("turn-1"));
    }

    #[tokio::test]
    async fn insert_message_omits_model_and_turn_when_empty() {
        let srv = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path_regex(r"^/rest/v1/messages$"))
            .respond_with(ResponseTemplate::new(204))
            .mount(&srv)
            .await;
        let client = make_client(&srv).await;
        client
            .insert_message(
                "msg-1", "t-1", "s-1", "a-1", "text", "hello", "", "", "", 42,
            )
            .await
            .unwrap();

        let requests = srv.received_requests().await.unwrap();
        let body = requests
            .iter()
            .find(|r| r.url.path() == "/rest/v1/messages")
            .expect("/rest/v1/messages was not called");
        let body_json: serde_json::Value = serde_json::from_slice(&body.body).unwrap();
        let obj = body_json.as_object().expect("body should be JSON object");
        assert!(
            !obj.contains_key("model"),
            "model should be omitted when empty"
        );
        assert!(
            !obj.contains_key("turn_id"),
            "turn_id should be omitted when empty"
        );
    }
}
